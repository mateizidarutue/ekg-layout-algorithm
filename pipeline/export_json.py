"""
Export Neo4j EKG to a typed JSON bundle consumed by the viewer.

Usage:
    python -m pipeline.export_json --dataset library --output output/library.json
    python -m pipeline.export_json --dataset bpic19 --output output/bpic19.json --sample-cases 720 --max-case-events 160
"""

import argparse
import json
import sys
import time
from collections import defaultdict
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


def _qualify_entity_id(raw_id: str | None, node_labels: list[str]) -> str:
    """Prefix sysId with the primary label so entities sharing a sysId stay distinct."""
    if not raw_id or raw_id == "None":
        return raw_id or ""
    primary = _infer_primary_type(node_labels)
    return f"{primary}:{raw_id}" if primary and primary != "Entity" else raw_id


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


def _iter_query(session, query: str, **params):
    result = session.run(query, **params)
    for record in result:
        yield record


def _run_rows(session, cypher_name: str, **params):
    yield from _iter_query(session, _load_cypher(cypher_name), **params)


def _infer_case_item_types(session, hint_case_type: str | None = None) -> tuple[str, str | None]:
    row = session.run("""
        MATCH (src:Entity)-[:HAS_ITEM]->(tgt:Entity)
        RETURN labels(src) AS src_labels, labels(tgt) AS tgt_labels
        LIMIT 1
    """).single()
    if row is not None:
        return _infer_primary_type(row["src_labels"]), _infer_primary_type(row["tgt_labels"])

    if hint_case_type:
        return hint_case_type, None

    # Fall back: entity type with the most correlated events
    row = session.run("""
        MATCH (e:Event)-[]->(en:Entity)
        UNWIND [label IN labels(en) WHERE label <> 'Entity'] AS label
        WITH label, count(DISTINCT e) AS n
        RETURN label ORDER BY n DESC LIMIT 1
    """).single()
    if row is None:
        raise RuntimeError(
            "Could not infer case type. Use --case-type to specify it explicitly."
        )
    print(f"  No HAS_ITEM found — using '{row['label']}' as case type (most event-correlated entity).")
    return row["label"], None


def _fetch_case_sample_metadata(session, case_type: str, item_type: str | None) -> list[dict]:
    if item_type is not None:
        query = """
            MATCH (c:Entity)
            WHERE $case_type IN labels(c)
            OPTIONAL MATCH (c)-[:HAS_ITEM]->(item:Entity)
            WHERE $item_type IN labels(item)
            WITH c, count(DISTINCT item) AS item_count
            OPTIONAL MATCH (e:Event)-[]->(c)
            WITH c, item_count, count(DISTINCT e) AS event_count, min(e.timestamp) AS first_ts, max(e.timestamp) AS last_ts
            RETURN
              COALESCE(toString(c.sysId), toString(c.ID))        AS case_id,
              COALESCE(toString(c.documentType), toString(c.type), 'Unknown') AS document_type,
              event_count                                        AS event_count,
              item_count                                         AS item_count,
              toString(first_ts)                                 AS first_ts,
              toString(last_ts)                                  AS last_ts
        """
        return [record.data() for record in _iter_query(session, query, case_type=case_type, item_type=item_type)]
    else:
        query = """
            MATCH (c:Entity)
            WHERE $case_type IN labels(c)
            OPTIONAL MATCH (e:Event)-[]->(c)
            WITH c, count(DISTINCT e) AS event_count, min(e.timestamp) AS first_ts, max(e.timestamp) AS last_ts
            RETURN
              COALESCE(toString(c.sysId), toString(c.ID))        AS case_id,
              COALESCE(toString(c.documentType), toString(c.type), 'Unknown') AS document_type,
              event_count                                        AS event_count,
              0                                                  AS item_count,
              toString(first_ts)                                 AS first_ts,
              toString(last_ts)                                  AS last_ts
        """
        return [record.data() for record in _iter_query(session, query, case_type=case_type)]


def _select_evenly_spaced(rows: list[dict], n: int) -> list[dict]:
    if n <= 0 or not rows:
        return []
    if n >= len(rows):
        return list(rows)
    chosen = []
    seen = set()
    total = len(rows)
    for index in range(n):
        pos = int((index + 0.5) * total / n)
        pos = max(0, min(total - 1, pos))
        if pos in seen:
            continue
        seen.add(pos)
        chosen.append(rows[pos])
    if len(chosen) == n:
        return chosen
    for pos, row in enumerate(rows):
        if pos in seen:
            continue
        chosen.append(row)
        if len(chosen) == n:
            break
    return chosen


def _distribute_group_quotas(groups: dict[str, list[dict]], total: int) -> dict[str, int]:
    quotas = {name: 0 for name in groups}
    if total <= 0 or not groups:
        return quotas
    active = [name for name, rows in groups.items() if rows]
    if not active:
        return quotas

    base = total // len(active)
    for name in active:
        quotas[name] = min(base, len(groups[name]))
    assigned = sum(quotas.values())

    while assigned < total:
        candidates = [name for name in active if quotas[name] < len(groups[name])]
        if not candidates:
            break
        candidates.sort(key=lambda name: (len(groups[name]) - quotas[name], len(groups[name]), name), reverse=True)
        for name in candidates:
            if assigned >= total:
                break
            if quotas[name] >= len(groups[name]):
                continue
            quotas[name] += 1
            assigned += 1
    return quotas


def _pick_sample_case_ids(metadata_rows: list[dict], sample_cases: int, max_case_events: int | None) -> list[str]:
    if sample_cases <= 0:
        return []
    filtered = [row for row in metadata_rows if row.get("case_id")]
    if max_case_events is not None:
        capped = [row for row in filtered if int(row.get("event_count") or 0) <= max_case_events]
        if capped:
            filtered = capped
    if sample_cases >= len(filtered):
        return [row["case_id"] for row in filtered]

    groups = defaultdict(list)
    for row in filtered:
        groups[row.get("document_type") or "Unknown"].append(row)
    for rows in groups.values():
        rows.sort(key=lambda row: (
            row.get("first_ts") or "",
            int(row.get("event_count") or 0),
            row.get("case_id") or "",
        ))

    quotas = _distribute_group_quotas(groups, sample_cases)
    picked = []
    for name, rows in groups.items():
        picked.extend(_select_evenly_spaced(rows, quotas.get(name, 0)))

    if len(picked) < sample_cases:
        picked_ids = {row["case_id"] for row in picked}
        remaining = [row for row in filtered if row["case_id"] not in picked_ids]
        remaining.sort(key=lambda row: (
            row.get("document_type") or "",
            row.get("first_ts") or "",
            int(row.get("event_count") or 0),
            row.get("case_id") or "",
        ))
        picked.extend(_select_evenly_spaced(remaining, sample_cases - len(picked)))

    return [row["case_id"] for row in picked[:sample_cases]]


def _fetch_item_ids_for_cases(session, case_ids: list[str]) -> list[str]:
    query = """
        MATCH (c:Entity)-[:HAS_ITEM]->(item:Entity)
        WHERE COALESCE(toString(c.sysId), toString(c.ID)) IN $case_ids
        RETURN DISTINCT COALESCE(toString(item.sysId), toString(item.ID)) AS item_id
    """
    return [str(record["item_id"]) for record in _iter_query(session, query, case_ids=case_ids)]


def _export_sampled_subset(session, case_ids: list[str]) -> tuple[list[dict], list[dict], list[dict], list[dict], list[dict]]:
    item_ids = _fetch_item_ids_for_cases(session, case_ids)
    event_anchor_entity_ids = sorted(set(case_ids) | set(item_ids))

    print(f"Sampling {len(case_ids):,} cases and {len(item_ids):,} directly linked items...")

    event_query = """
        MATCH (e:Event)-[]->(en:Entity)
        WHERE COALESCE(toString(en.sysId), toString(en.ID)) IN $entity_ids
        RETURN DISTINCT
          toString(id(e)) AS event_id,
          e.activity      AS activity,
          toString(e.timestamp) AS timestamp,
          properties(e)   AS props
        ORDER BY timestamp
    """
    events = []
    event_id_map = {}
    selected_event_neo_ids = []
    for row in _iter_query(session, event_query, entity_ids=event_anchor_entity_ids):
        props = dict(row.get("props") or {})
        neo_id, event_id = _resolve_event_id(row, props)
        event_id_map[neo_id] = event_id
        selected_event_neo_ids.append(neo_id)
        activity = row.get("activity") or props.get("activity") or props.get("Activity") or ""
        timestamp = row.get("timestamp") or props.get("timestamp") or props.get("start_time") or ""
        events.append({
            "event_id": event_id,
            "activity": str(activity),
            "timestamp": _to_iso(timestamp),
            "properties": _stringify_props(props),
        })

    corr_query = """
        MATCH (e:Event)-[r]->(en:Entity)
        WHERE toString(id(e)) IN $event_ids
        RETURN
          toString(id(e))                               AS event_id,
          COALESCE(toString(en.sysId), toString(en.ID)) AS entity_id,
          labels(en)                                    AS entity_labels,
          type(r)                                       AS relation_type
    """
    corr = []
    selected_entity_ids = set(event_anchor_entity_ids)  # raw sysIds for query filtering
    for row in _iter_query(session, corr_query, event_ids=selected_event_neo_ids):
        event_id = event_id_map.get(str(row["event_id"]), str(row["event_id"]))
        raw_entity_id = str(row["entity_id"])
        entity_id = _qualify_entity_id(raw_entity_id, row.get("entity_labels") or [])
        selected_entity_ids.add(raw_entity_id)
        corr.append({
            "event_id": event_id,
            "entity_id": entity_id,
            "relation_type": str(row.get("relation_type") or "CORR"),
        })

    expand_rel_query = """
        MATCH (src:Entity)-[rel]->(tgt:Entity)
        WHERE type(rel) <> 'CORR'
          AND type(rel) <> 'DF'
          AND NOT type(rel) STARTS WITH 'DF_'
          AND type(rel) <> 'FROM'
          AND type(rel) <> 'TO'
          AND (
            COALESCE(toString(src.sysId), toString(src.ID)) IN $anchor_ids
            OR COALESCE(toString(tgt.sysId), toString(tgt.ID)) IN $anchor_ids
          )
        RETURN
          COALESCE(toString(src.sysId), toString(src.ID), toString(id(src))) AS source_id,
          COALESCE(toString(tgt.sysId), toString(tgt.ID), toString(id(tgt))) AS target_id
    """
    for row in _iter_query(session, expand_rel_query, anchor_ids=event_anchor_entity_ids):
        selected_entity_ids.add(str(row["source_id"]))
        selected_entity_ids.add(str(row["target_id"]))

    entity_query = """
        MATCH (en:Entity)
        WHERE COALESCE(toString(en.sysId), toString(en.ID)) IN $entity_ids
        RETURN
          COALESCE(toString(en.sysId), toString(en.ID)) AS entity_id,
          labels(en)                                    AS node_labels,
          properties(en)                                AS props
        ORDER BY entity_id
    """
    entities = []
    entity_by_id = {}
    for row in _iter_query(session, entity_query, entity_ids=sorted(selected_entity_ids)):
        props = dict(row.get("props") or {})
        entity_id = _qualify_entity_id(str(row["entity_id"]), row.get("node_labels") or [])
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

    corr = [edge for edge in corr if edge["entity_id"] in entity_by_id]

    df_query = """
        MATCH (src:Event)-[df]->(tgt:Event)
        WHERE (type(df) = 'DF' OR type(df) STARTS WITH 'DF_')
          AND toString(id(src)) IN $event_ids
          AND toString(id(tgt)) IN $event_ids
        CALL {
          WITH src, tgt, df
          OPTIONAL MATCH (src)-[]->(en:Entity)<-[]-(tgt)
          WHERE (
            df.entityId IS NOT NULL
            AND trim(toString(df.entityId)) <> ''
            AND COALESCE(toString(en.sysId), toString(en.ID), '') = trim(toString(df.entityId))
          ) OR (
            (df.entityId IS NULL OR trim(toString(df.entityId)) = '')
            AND (
              (df.entityType IS NOT NULL AND df.entityType IN labels(en))
              OR (df.entityType IS NULL AND type(df) STARTS WITH 'DF_' AND substring(type(df), 3) IN labels(en))
            )
          )
          RETURN head(collect(DISTINCT COALESCE(toString(en.sysId), toString(en.ID)))) AS inferred_entity_id
        }
        RETURN
          toString(id(src)) AS source_event_id,
          toString(id(tgt)) AS target_event_id,
          CASE
            WHEN df.entityId IS NULL OR trim(toString(df.entityId)) = '' THEN COALESCE(inferred_entity_id, '')
            ELSE trim(toString(df.entityId))
          END AS entity_id,
          CASE
            WHEN df.entityType IS NULL OR trim(toString(df.entityType)) = '' THEN
              CASE WHEN type(df) STARTS WITH 'DF_' THEN substring(type(df), 3) ELSE '' END
            ELSE trim(toString(df.entityType))
          END AS entity_type
    """
    df = []
    for row in _iter_query(session, df_query, event_ids=selected_event_neo_ids):
        raw_entity_id = str(row.get("entity_id") or "").strip()
        entity_type = str(row.get("entity_type") or "").strip()
        entity_id = _qualify_entity_id(raw_entity_id, [entity_type] if entity_type else []) if raw_entity_id else ""
        if entity_id not in entity_by_id:
            continue
        df.append({
            "source_event_id": event_id_map.get(str(row["source_event_id"]), str(row["source_event_id"])),
            "target_event_id": event_id_map.get(str(row["target_event_id"]), str(row["target_event_id"])),
            "entity_id": entity_id,
            "entity_type": entity_type or entity_by_id[entity_id]["primary_type"],
        })

    relation_query = """
        MATCH (src:Entity)-[rel]->(tgt:Entity)
        WHERE type(rel) <> 'CORR'
          AND type(rel) <> 'DF'
          AND NOT type(rel) STARTS WITH 'DF_'
          AND type(rel) <> 'FROM'
          AND type(rel) <> 'TO'
          AND COALESCE(toString(src.sysId), toString(src.ID), toString(id(src))) IN $entity_ids
          AND COALESCE(toString(tgt.sysId), toString(tgt.ID), toString(id(tgt))) IN $entity_ids
        RETURN
          COALESCE(toString(src.sysId), toString(src.ID), toString(id(src))) AS source_id,
          labels(src)                                                         AS src_labels,
          COALESCE(toString(tgt.sysId), toString(tgt.ID), toString(id(tgt))) AS target_id,
          labels(tgt)                                                         AS tgt_labels,
          type(rel)                                                           AS relation_type,
          properties(rel)                                                     AS props
        UNION
        MATCH (src:Entity)-[:FROM]->(relay:Entity)-[:TO]->(tgt:Entity)
        WHERE NOT src:Event AND NOT tgt:Event AND NOT relay:Activity
          AND COALESCE(toString(src.sysId), toString(src.ID), toString(id(src))) IN $entity_ids
          AND COALESCE(toString(tgt.sysId), toString(tgt.ID), toString(id(tgt))) IN $entity_ids
        RETURN
          COALESCE(toString(src.sysId), toString(src.ID), toString(id(src)))  AS source_id,
          labels(src)                                                          AS src_labels,
          COALESCE(toString(tgt.sysId), toString(tgt.ID), toString(id(tgt)))  AS target_id,
          labels(tgt)                                                          AS tgt_labels,
          head([l IN labels(relay) WHERE l <> 'Entity' | l])                   AS relation_type,
          properties(relay)                                                     AS props
    """
    relations = []
    for row in _iter_query(session, relation_query, entity_ids=sorted(selected_entity_ids)):
        source_id = _qualify_entity_id(str(row["source_id"]), row.get("src_labels") or [])
        target_id = _qualify_entity_id(str(row["target_id"]), row.get("tgt_labels") or [])
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

    return events, entities, corr, df, relations


def run(dataset_name: str, output_path: str, sample_cases: int | None = None, max_case_events: int | None = None, hint_case_type: str | None = None) -> None:
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
        if sample_cases:
            case_type, item_type = _infer_case_item_types(session, hint_case_type=hint_case_type)
            metadata_rows = _fetch_case_sample_metadata(session, case_type, item_type)
            selected_case_ids = _pick_sample_case_ids(metadata_rows, sample_cases, max_case_events)
            print(
                f"Sampling subset export for {dataset_name}: "
                f"{len(selected_case_ids):,} {case_type} entities"
                + (f" (event cap {max_case_events})" if max_case_events is not None else "")
            )
            events, entities, corr, df, relations = _export_sampled_subset(session, selected_case_ids)
        else:
            print("Exporting events...")
            events = []
            event_id_map = {}
            for row in _run_rows(session, "events"):
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
            entities = []
            entity_by_id = {}
            for row in _run_rows(session, "entities"):
                props = dict(row.get("props") or {})
                entity_id = _qualify_entity_id(str(row["entity_id"]), row.get("node_labels") or [])
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
            corr = []
            for row in _run_rows(session, "corr"):
                event_id = event_id_map.get(str(row["event_id"]), str(row["event_id"]))
                entity_id = _qualify_entity_id(str(row["entity_id"]), row.get("entity_labels") or [])
                if entity_id not in entity_by_id:
                    continue
                corr.append({
                    "event_id": event_id,
                    "entity_id": entity_id,
                    "relation_type": str(row.get("relation_type") or "CORR"),
                })

            print("Exporting df edges...")
            df = []
            for row in _run_rows(session, "df"):
                raw_entity_id = str(row.get("entity_id") or "").strip()
                entity_type = str(row.get("entity_type") or "").strip()
                entity_id = _qualify_entity_id(raw_entity_id, [entity_type] if entity_type else "") if raw_entity_id else ""
                if entity_id not in entity_by_id:
                    continue
                df.append({
                    "source_event_id": event_id_map.get(str(row["source_event_id"]), str(row["source_event_id"])),
                    "target_event_id": event_id_map.get(str(row["target_event_id"]), str(row["target_event_id"])),
                    "entity_id": entity_id,
                    "entity_type": entity_type or entity_by_id[entity_id]["primary_type"],
                })

            print("Exporting structural relations...")
            relations = []
            for row in _run_rows(session, "relations"):
                source_id = _qualify_entity_id(str(row["source_id"]), row.get("src_labels") or [])
                target_id = _qualify_entity_id(str(row["target_id"]), row.get("tgt_labels") or [])
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
    parser.add_argument("--sample-cases", type=int, default=None, help="Export a case-sampled subset instead of the full dataset")
    parser.add_argument("--max-case-events", type=int, default=None, help="Exclude cases above this event count when sampling")
    parser.add_argument("--case-type", default=None, help="Entity type to use as 'case' when sampling (auto-detected if omitted)")
    args = parser.parse_args()
    run(args.dataset, args.output, sample_cases=args.sample_cases, max_case_events=args.max_case_events, hint_case_type=args.case_type)


if __name__ == "__main__":
    main()
