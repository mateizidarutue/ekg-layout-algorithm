"""
Export Neo4j EKG to a typed JSON bundle consumed by the viewer.

Usage:
    python -m pipeline.export_json --dataset library --output output/library.json
"""

import argparse
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from pipeline.config_loader import get_dataset_config, load_config

GENERIC_ENTITY_LABELS = {"Entity", "Resource", "EntityAttribute"}


def _load_cypher(name: str) -> str:
    cypher_dir = Path(__file__).parent / "cypher"
    return (cypher_dir / f"{name}.cypher").read_text()


def _stringify_props(props: dict) -> dict:
    return {
        str(k): ("" if v is None else str(v))
        for k, v in (props or {}).items()
    }


def _infer_primary_type(node_labels: list[str]) -> str:
    labels = [label for label in (node_labels or []) if label]
    specific = sorted(label for label in labels if label not in GENERIC_ENTITY_LABELS)
    if specific:
        return specific[0]
    generic = sorted(label for label in labels if label != "Entity")
    if generic:
        return generic[0]
    return "Entity"


def _to_iso(value) -> str:
    if value is None:
        return ""
    if hasattr(value, "iso_format"):
        return value.iso_format()
    return str(value)


def _resolve_event_id(row: dict, props: dict) -> tuple[str, str]:
    neo_id = str(row["event_id"])
    explicit_id = props.get("event_id") or props.get("ID")
    return neo_id, str(explicit_id) if explicit_id is not None else neo_id


def _validate_unique_ids(values: list[str], label: str, errors: list[str]) -> None:
    if len(set(values)) != len(values):
        errors.append(f"Duplicate {label} values found")


def run(dataset_name: str, output_path: str) -> None:
    repo_root = Path(__file__).parent.parent
    config = load_config(repo_root / "config.yaml")
    neo4j = config["neo4j"]
    ds = get_dataset_config(config, dataset_name)

    try:
        from neo4j import GraphDatabase
    except ImportError:
        print("ERROR: neo4j driver not installed. Run: pip install neo4j", file=sys.stderr)
        sys.exit(1)

    uri = neo4j["uri"]
    auth = (neo4j["user"], str(neo4j["password"]))
    database = ds["database"]

    print(f"Connecting to {uri} / database '{database}'...")
    driver = GraphDatabase.driver(uri, auth=auth)

    try:
        driver.verify_connectivity()
    except Exception as exc:
        print(f"ERROR: Cannot connect to Neo4j: {exc}", file=sys.stderr)
        sys.exit(1)

    t0 = time.time()

    with driver.session(database=database) as session:
        print("Exporting events...")
        event_rows = session.run(_load_cypher("events")).data()
        events = []
        event_id_map = {}
        for row in event_rows:
            props = dict(row.get("props") or {})
            neo_id, event_id = _resolve_event_id(row, props)
            event_id_map[neo_id] = event_id
            activity = row.get("activity") or props.get("activity") or props.get("Activity") or ""
            timestamp = row.get("timestamp") or props.get("timestamp") or props.get("start_time") or ""
            events.append({
                "event_id": event_id,
                "activity": str(activity),
                "timestamp": _to_iso(timestamp),
                "properties": _stringify_props(props),
            })

        print("Exporting entities...")
        entity_rows = session.run(_load_cypher("entities")).data()
        entities = []
        entity_by_id = {}
        for row in entity_rows:
            props = dict(row.get("props") or {})
            entity_id = str(row["entity_id"])
            labels = sorted(label for label in (row.get("node_labels") or []) if label and label != "Entity")
            primary_type = _infer_primary_type(row.get("node_labels") or [])
            entity = {
                "entity_id": entity_id,
                "entity_type": primary_type,
                "primary_type": primary_type,
                "labels": labels,
                "properties": _stringify_props(props),
            }
            if entity_id in entity_by_id:
                continue
            entity_by_id[entity_id] = entity
            entities.append(entity)

        print("Exporting corr edges...")
        corr_rows = session.run(_load_cypher("corr")).data()
        corr = []
        for row in corr_rows:
            event_id = event_id_map.get(str(row["event_id"]), str(row["event_id"]))
            entity_id = str(row["entity_id"])
            if entity_id not in entity_by_id:
                continue
            corr.append({
                "event_id": event_id,
                "entity_id": entity_id,
                "relation_type": str(row.get("relation_type") or "CORR"),
            })

        print("Exporting df edges...")
        df_rows = session.run(_load_cypher("df")).data()
        df = []
        for row in df_rows:
            df.append({
                "source_event_id": event_id_map.get(str(row["source_event_id"]), str(row["source_event_id"])),
                "target_event_id": event_id_map.get(str(row["target_event_id"]), str(row["target_event_id"])),
                "entity_id": str(row.get("entity_id") or "").strip(),
                "entity_type": str(row.get("entity_type") or "").strip(),
            })

        print("Exporting structural relations...")
        relation_rows = session.run(_load_cypher("relations")).data()
        relations = []
        for row in relation_rows:
            source_id = str(row["source_id"])
            target_id = str(row["target_id"])
            if source_id not in entity_by_id or target_id not in entity_by_id:
                continue
            relations.append({
                "source_entity_id": source_id,
                "target_entity_id": target_id,
                "source_entity_type": entity_by_id[source_id]["primary_type"],
                "target_entity_type": entity_by_id[target_id]["primary_type"],
                "relation_type": str(row.get("relation_type") or ""),
                "properties": _stringify_props(row.get("props") or {}),
            })

    driver.close()

    print("Validating...")
    errors = []
    event_ids = [event["event_id"] for event in events]
    entity_ids = [entity["entity_id"] for entity in entities]
    _validate_unique_ids(event_ids, "event_id", errors)
    _validate_unique_ids(entity_ids, "entity_id", errors)

    event_id_set = set(event_ids)
    entity_id_set = set(entity_ids)

    bad_corr = [
        edge for edge in corr
        if edge["event_id"] not in event_id_set or edge["entity_id"] not in entity_id_set
    ]
    if bad_corr:
        errors.append(f"{len(bad_corr)} corr edges have unknown event_id or entity_id")

    bad_df = [
        edge for edge in df
        if edge["source_event_id"] not in event_id_set
        or edge["target_event_id"] not in event_id_set
        or edge["entity_id"] not in entity_id_set
        or edge["entity_id"] == ""
    ]
    if bad_df:
        errors.append(
            f"{len(bad_df)} df edges have missing/unknown source_event_id, target_event_id, or entity_id"
        )

    bad_rel = [
        edge for edge in relations
        if edge["source_entity_id"] not in entity_id_set or edge["target_entity_id"] not in entity_id_set
    ]
    if bad_rel:
        errors.append(f"{len(bad_rel)} relations reference unknown entity_id values")

    if errors:
        print("VALIDATION ERRORS:", file=sys.stderr)
        for err in errors:
            print(f"  - {err}", file=sys.stderr)
        sys.exit(1)

    bundle = {
        "dataset": dataset_name,
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "promg_version": "0.1.25",
        "stats": {
            "events": len(events),
            "entities": len(entities),
            "corr": len(corr),
            "df": len(df),
            "relations": len(relations),
        },
        "events": events,
        "entities": entities,
        "corr": corr,
        "df": df,
        "relations": relations,
    }

    out_path = Path(output_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as handle:
        json.dump(bundle, handle, ensure_ascii=False)

    elapsed = time.time() - t0
    print(f"\nExport complete in {elapsed:.1f}s -> {out_path}")
    print(f"  events:    {len(events):,}")
    print(f"  entities:  {len(entities):,}")
    print(f"  corr:      {len(corr):,}")
    print(f"  df:        {len(df):,}")
    print(f"  relations: {len(relations):,}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Export Neo4j EKG to typed JSON")
    parser.add_argument("--dataset", required=True, help="Dataset name from config.yaml")
    parser.add_argument("--output", required=True, help="Output JSON path")
    args = parser.parse_args()
    run(args.dataset, args.output)


if __name__ == "__main__":
    main()
