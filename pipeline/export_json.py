"""
Export Neo4j EKG to the JSON schema defined in docs/PIPELINE.md.

Usage:
    python -m pipeline.export_json --dataset library --output output/library.json
"""

import argparse
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from pipeline.config_loader import load_config, get_dataset_config

CORE_EVENT_PROPS = {"activity", "timestamp", "event_id"}
CORE_ENTITY_PROPS = {"entity_id", "entity_type"}


def _load_cypher(name: str) -> str:
    cypher_dir = Path(__file__).parent / "cypher"
    return (cypher_dir / f"{name}.cypher").read_text()


def _strip_core(props: dict, core_keys: set) -> dict:
    return {k: v for k, v in (props or {}).items() if k not in core_keys}


def _infer_entity_type(node_labels: list) -> str:
    """Extract entity type from PromG secondary labels (e.g. ['Entity','PO'] -> 'PO')."""
    for label in node_labels:
        if label != "Entity":
            return label
    return "Entity"


def _to_iso(value) -> str:
    if value is None:
        return ""
    if hasattr(value, "iso_format"):
        # neo4j.time.DateTime
        return value.iso_format()
    return str(value)


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
    except Exception as e:
        print(f"ERROR: Cannot connect to Neo4j: {e}", file=sys.stderr)
        sys.exit(1)

    t0 = time.time()

    with driver.session(database=database) as session:

        # ── Events ────────────────────────────────────────────────────────────
        print("Exporting events...")
        event_q = _load_cypher("events")
        events_raw = session.run(event_q).data()
        events = []
        event_id_map = {}  # neo4j internal id -> string event_id

        for row in events_raw:
            neo_id = row["event_id"]
            props = dict(row.get("props") or {})

            # Prefer explicit event_id/ID property; fall back to neo4j internal id
            explicit_id = props.pop("event_id", None) or props.pop("ID", None)
            event_id_str = str(explicit_id) if explicit_id is not None else str(neo_id)
            event_id_map[neo_id] = event_id_str

            activity = row.get("activity") or props.pop("activity", props.pop("Activity", ""))
            timestamp = row.get("timestamp") or _to_iso(props.pop("timestamp", props.pop("start_time", "")))

            # Remove fields already promoted to top level
            for key in ("activity", "Activity", "timestamp", "start_time"):
                props.pop(key, None)

            events.append({
                "event_id": event_id_str,
                "activity": str(activity or ""),
                "timestamp": str(timestamp or ""),
                "properties": {k: str(v) if v is not None else "" for k, v in props.items()},
            })

        # ── Entities ──────────────────────────────────────────────────────────
        print("Exporting entities...")
        entity_q = _load_cypher("entities")
        entities_raw = session.run(entity_q).data()
        entities = []
        entity_id_set = set()

        for row in entities_raw:
            props = dict(row.get("props") or {})
            explicit_id = props.pop("ID", None) or props.pop("entity_id", None)
            entity_id_str = str(explicit_id) if explicit_id is not None else str(row["entity_id"])
            entity_type = _infer_entity_type(row.get("node_labels") or [])

            for key in ("ID", "entity_id", "EntityType"):
                props.pop(key, None)

            if entity_id_str in entity_id_set:
                continue
            entity_id_set.add(entity_id_str)

            entities.append({
                "entity_id": entity_id_str,
                "entity_type": entity_type,
                "properties": {k: str(v) if v is not None else "" for k, v in props.items()},
            })

        # ── CORR ──────────────────────────────────────────────────────────────
        print("Exporting corr edges...")
        corr_q = _load_cypher("corr")
        corr_raw = session.run(corr_q).data()
        corr = []
        for row in corr_raw:
            # event_id in corr query is neo4j id; map to string event_id
            neo_ev_id = row["event_id"]
            ev_id_str = event_id_map.get(neo_ev_id, str(neo_ev_id))
            en_id_str = str(row["entity_id"])
            corr.append({"event_id": ev_id_str, "entity_id": en_id_str})

        # ── DF ────────────────────────────────────────────────────────────────
        print("Exporting df edges...")
        df_q = _load_cypher("df")
        df_raw = session.run(df_q).data()
        df = []
        for row in df_raw:
            src_neo = row["source_event_id"]
            tgt_neo = row["target_event_id"]
            df.append({
                "source_event_id": event_id_map.get(src_neo, str(src_neo)),
                "target_event_id": event_id_map.get(tgt_neo, str(tgt_neo)),
                "entity_id": str(row["entity_id"] or ""),
                "entity_type": str(row["entity_type"] or ""),
            })

    driver.close()

    # ── Validate schema invariants ────────────────────────────────────────────
    print("Validating...")
    event_ids = {e["event_id"] for e in events}
    entity_ids = {e["entity_id"] for e in entities}
    errors = []

    if len(event_ids) != len(events):
        errors.append("Duplicate event_id values found")
    if len(entity_ids) != len(entities):
        errors.append("Duplicate entity_id values found")

    bad_corr = [c for c in corr if c["event_id"] not in event_ids or c["entity_id"] not in entity_ids]
    if bad_corr:
        errors.append(f"{len(bad_corr)} corr edges have unknown event_id or entity_id")

    bad_df = [d for d in df if d["source_event_id"] not in event_ids or d["target_event_id"] not in event_ids]
    if bad_df:
        errors.append(f"{len(bad_df)} df edges have unknown source or target event_id")

    if errors:
        print("VALIDATION ERRORS:", file=sys.stderr)
        for err in errors:
            print(f"  - {err}", file=sys.stderr)
        print("Output written anyway; fix Cypher templates if IDs are wrong.", file=sys.stderr)

    # ── Assemble and write ────────────────────────────────────────────────────
    bundle = {
        "dataset": dataset_name,
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "promg_version": "0.1.25",
        "stats": {
            "events": len(events),
            "entities": len(entities),
            "corr": len(corr),
            "df": len(df),
        },
        "events": events,
        "entities": entities,
        "corr": corr,
        "df": df,
    }

    out_path = Path(output_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(bundle, f, ensure_ascii=False)

    elapsed = time.time() - t0
    print(f"\nExport complete in {elapsed:.1f}s → {out_path}")
    print(f"  events:   {len(events):,}")
    print(f"  entities: {len(entities):,}")
    print(f"  corr:     {len(corr):,}")
    print(f"  df:       {len(df):,}")
    if errors:
        print(f"  WARNINGS: {len(errors)} validation issue(s) — see above")


def main() -> None:
    parser = argparse.ArgumentParser(description="Export Neo4j EKG to JSON")
    parser.add_argument("--dataset", required=True, help="Dataset name from config.yaml")
    parser.add_argument("--output", required=True, help="Output JSON path")
    args = parser.parse_args()
    run(args.dataset, args.output)


if __name__ == "__main__":
    main()
