# Pipeline Reference

This document is the authoritative reference for the `bep` data pipeline: from raw event logs to the JSON bundle consumed by the viewer.

---

## JSON bundle schema (§3)

The JSON bundle is the stable contract between the pipeline and the viewer. Every field listed below is required unless marked optional.

```jsonc
{
  "dataset":        "library",           // dataset key from config.yaml
  "generated_at":   "2024-01-15T12:00:00Z", // ISO-8601 UTC
  "promg_version":  "0.1.25",
  "stats": {
    "n_events":    1234,
    "n_entities":  456,
    "n_corr":      789,
    "n_df":        1011
  },
  "events": [
    {
      "event_id":   "e1",               // string, unique
      "activity":   "Create Purchase Order",
      "timestamp":  "2019-01-04T08:00:00",
      "properties": {                   // bag of remaining node properties
        "resource": "Alice",
        "Document_Type": "Invoice",
        "price": 120.50
      }
    }
  ],
  "entities": [
    {
      "entity_id":   "PO-100",          // string, unique (en.ID property)
      "entity_type": "PO",              // non-"Entity" secondary Neo4j label
      "properties":  { "vendor": "Acme" }
    }
  ],
  "corr": [
    {
      "event_id":  "e1",
      "entity_id": "PO-100"
    }
  ],
  "df": [
    {
      "source_event_id": "e1",
      "target_event_id": "e2",
      "entity_id":       "ITEM-200",   // df.EntityId property on the DF edge
      "entity_type":     "POItem"      // df.EntityType property on the DF edge
    }
  ]
}
```

### ID uniqueness rules

- `events[*].event_id` must be globally unique within a bundle.
- `entities[*].entity_id` must be globally unique within a bundle.
- `corr[*].event_id` and `corr[*].entity_id` must each reference a valid ID from the `events` / `entities` arrays.
- `df[*].source_event_id` and `df[*].target_event_id` must reference valid `event_id` values.

---

## Pipeline stages

### Stage 1+2 — Ingest & EKG construction

**Script:** `pipeline/build_ekg.py`

```bash
python -m pipeline.build_ekg --dataset <name> [--sample N] [--yes]
```

| Flag | Description |
|------|-------------|
| `--dataset` | Dataset key from `config.yaml` (required) |
| `--sample N` | Limit to first N traces (optional, for testing) |
| `--yes` | Skip confirmation prompt |

**What it does:**

1. Reads `config.yaml` to locate the raw event log and semantic header files.
2. Writes a PromG-format `config.yaml` to a temporary directory (PromG requires this file in the current working directory).
3. Changes the working directory to the temp dir and calls `Configuration.init_conf_with_config_file()`.
4. Runs the full PromG construction flow (event log ingestion, entity extraction, EKG construction).
5. Restores the working directory and cleans up the temp dir.

**Result:** Neo4j database populated with `:Event` and `:Entity` nodes, `:CORR` edges, and `:DF` edges.

---

### Stage 3 — Export to JSON

**Script:** `pipeline/export_json.py`

```bash
python -m pipeline.export_json --dataset <name> --output output/<name>.json
```

| Flag | Description |
|------|-------------|
| `--dataset` | Dataset key from `config.yaml` (required) |
| `--output` | Output path for the JSON bundle (required) |

**What it does:**

1. Connects to the Neo4j database specified for the dataset.
2. Runs four Cypher queries (see `pipeline/cypher/`).
3. Maps results to the §3 schema.
4. Validates ID uniqueness and referential integrity.
5. Writes the JSON bundle.

**Cypher queries:**

| File | Query |
|------|-------|
| `events.cypher` | All `:Event` nodes with their properties |
| `entities.cypher` | All `:Entity` nodes with labels and properties |
| `corr.cypher` | All `:CORR` edges (Event → Entity) |
| `df.cypher` | All `:DF` edges with `EntityId` and `EntityType` |

---

### Stage 4 — Viewer

No build step required. Serve `viewer/` with any static HTTP server:

```bash
cd viewer
python -m http.server 8000
# then open http://localhost:8000
```

URL parameters:

| Parameter | Default | Description |
|-----------|---------|-------------|
| `?dataset=<name>` | `library` | Load `../output/<name>.json` |

To load a JSON bundle directly (when no server is available), use the **Open file…** button in the dropzone overlay.

---

## Worked example — library dataset

```bash
# 0. Verify Neo4j is running
python scripts/check_neo4j.py

# 1. Build EKG (full run, ~2 minutes for library)
python -m pipeline.build_ekg --dataset library --yes

# 2. Export
python -m pipeline.export_json --dataset library --output output/library.json

# 3. Verify the JSON is well-formed and non-empty
python -c "
import json
with open('output/library.json') as f: d = json.load(f)
print(d['stats'])
"

# 4. Serve and open
cd viewer && python -m http.server 8000
```

Expected `stats` output (approximate):
```
{'n_events': 2000, 'n_entities': 300, 'n_corr': 4500, 'n_df': 1900}
```

---

## Verification gates

| Gate | Command | Pass condition |
|------|---------|----------------|
| A — Neo4j | `python scripts/check_neo4j.py` | Prints version + label counts |
| B — Pipeline | `python -m pipeline.build_ekg --dataset library --yes` then `export_json` | `output/library.json` exists, `stats.n_events > 0` |
| C — Viewer | Open `http://localhost:8000` | Overview renders without JS errors |
| D — BPIC19 | Same pipeline for `bpic19` | Stats match expected counts |
| E — All datasets | Run B+C for `bpic17`, `bpic14` | All four datasets load cleanly |
| F — Docs | Read README + this file | No broken links, CLI commands work verbatim |

---

## Troubleshooting

### `promg.Configuration` raises FileNotFoundError

PromG reads `config.yaml` from the **current working directory**. The pipeline writes a temporary config and `chdir`s there automatically. If you see this error outside the pipeline, ensure you are calling `build_ekg.py` through `python -m pipeline.build_ekg`, not by running the script directly.

### Neo4j connection refused

- Check Neo4j is running: `neo4j status` or check Neo4j Desktop.
- Confirm the bolt port: default is `7687`. Update `config.yaml` if different.
- Docker users: ensure the container is started and ports are mapped.

### `export_json` reports missing entity types

Entity type is inferred from the secondary Neo4j label (the label other than `:Entity`). If your PromG semantic header does not assign secondary labels, `entity_type` will be `null` in the JSON. The viewer handles `null` gracefully but the PO/item swim-lane layout requires entity types `PO` and `POItem` specifically.

### Viewer shows dropzone instead of graph

The viewer failed to fetch `../output/<dataset>.json`. Possible causes:
- The file hasn't been exported yet (run Stage 3).
- You opened `index.html` directly via `file://` — serve it over HTTP instead.
- The dataset key in the URL does not match the filename.

### Browser console: `SyntaxError: Cannot use import statement`

The viewer uses ES modules (`type="module"`), which require HTTP. Do not open `index.html` directly from the filesystem.
