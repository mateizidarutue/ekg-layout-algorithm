# Event Knowledge Graph Layout Prototype

This repository is the evaluation artifact for a thesis on layout algorithms for Event Knowledge Graphs (EKGs).

It contains:

- a Python pipeline that builds typed EKGs in Neo4j through PromG,
- a JSON export layer that turns the graph into a viewer bundle,
- a browser-based prototype that aligns four analytical tasks from Munzner (2014) with canonical OCPM tasks.

The repository is organized around one core idea: flat case-centric process views are not enough for object-centric processes such as purchase orders with items, or members borrowing multiple books. The prototype therefore treats an execution as a typed graph of interacting entities and visualizes it with layouts that preserve both time and cross-entity structure.

## Current Implementation Status

All four task screens are fully implemented and demo-ready.

| Task | Route | Screen type | Status |
|---|---|---|---|
| T1 Lifecycle | `#/identify` | SVG canvas | Complete |
| T2 Variants & Comparison | `#/compare` | SVG canvas | Complete |
| T3 Process Overview | `#/summarize` | HTML card grid | Complete |
| T4 Shared Events | `#/explore` | HTML dashboard | Complete |

**T1** opens any entity and renders its complete multi-entity lifecycle on a shared time axis, with DF bottleneck highlighting, shared-event guides, and an interactive cluster-activity filter.

**T2** reconstructs item-level traces, groups them into process variants, and shows a dominant-variant ranking alongside an activity DF graph. Compare mode places multiple entity lifelines on the same canvas with per-entity accent colours.

**T3** renders a card grid of process variants derived directly from the item-level trace computation. Each card shows the activity sequence, case count, proportion bar, member and event statistics, and a date range. Clicking a card navigates to T2 with that variant pre-selected. This replaces the earlier label-propagation community clustering approach.

**T4** lists shared-event hotspots (activities that appear in events correlated to 3 or more entities simultaneously) and drills into an analytics dashboard showing entity-count distribution, type-pair co-participation, and most-active entities for each hotspot.

## Four-Task Screen Architecture

The viewer organises analysis around four task cards derived from Munzner (2014):

| Task | Route | Munzner tuple | Purpose |
|---|---|---|---|
| T1 Lifecycle | `#/identify` | ⟨Identify, Path⟩ | Open one entity and read its full lifecycle on the shared time axis, including bottleneck waits. |
| T2 Variants & Comparison | `#/compare` | ⟨Compare, Paths⟩ | Group entities by behaviour into variants, then place multiple lifelines on the same canvas. |
| T3 Process Overview | `#/summarize` | ⟨Summarize, Topology⟩ | See how the dataset partitions into process variants; click any card to inspect that variant in detail. |
| T4 Shared Events | `#/explore` | ⟨Explore, Features⟩ | Find shared events where three or more entity lifecycles intersect. |

### Hash-based navigation

The viewer uses hash-based routing. Every view state is a stable, shareable URL:

```
http://localhost:8000/viewer/#/home
http://localhost:8000/viewer/#/identify?entity=<id>
http://localhost:8000/viewer/#/compare?entities=<id1>,<id2>
http://localhost:8000/viewer/#/compare?variant=<sequence-key>
http://localhost:8000/viewer/#/summarize
http://localhost:8000/viewer/#/explore?cluster=act:<activity>
```

Opening the viewer at `http://localhost:8000/viewer/` redirects to `#/home`, where the four task cards are shown.

### Adding a dataset

Datasets are declared in `output/manifest.json`:

```json
{
  "datasets": [
    { "name": "library", "label": "Library",             "file": "library.json" },
    { "name": "bpic19",  "label": "BPIC 2019 (sampled)", "file": "bpic19.json"  }
  ]
}
```

To add a new dataset, export a JSON bundle with the pipeline and add a new entry to `manifest.json`. The viewer loads the manifest on startup and populates the "Switch dataset" modal automatically. No viewer code needs to change.

## Thesis Alignment

The prototype is built to address the thesis problem statement: how to lay out EKGs so that users can understand interacting entities, shared events, and process variants without collapsing the process back into a single-case log.

The current implementation aligns with that goal in four ways:

1. It builds a typed EKG, not a flat log.
   Events, entities, correlations, directly-follows edges, and structural entity-to-entity relations are all preserved.

2. It separates analysis into four coordinated screens.
   T1 shows a local multi-entity slice around one selected entity. T2 focuses on dominant item-level behaviour and side-by-side comparison. T3 shows the full variant distribution as an interactive card grid. T4 surfaces synchronisation hotspots where three or more entity types intersect.

3. It emphasizes the layout requirements from the thesis.
   The detail view uses one horizontal time axis, one band per entity type, one lane per entity instance, explicit shared-event guides, clustered shared-event markers at the top, and optional DF and structural relation layers.

4. The shared-event threshold is calibrated to the OCPM context.
   T4 requires at least three entities in a shared event (not two), filtering out trivial two-entity co-occurrences that are normal baseline correlations in object-centric processes.

In practical terms, the prototype supports:

- locating and opening an arbitrary entity,
- inspecting its local multi-entity context,
- seeing where events are shared across entity timelines,
- browsing the full process-variant distribution as ranked cards,
- comparing item traces that follow the same or different variants,
- drilling from the variant overview into a detail comparison view,
- exploring shared-event hotspots and their entity-type breakdown.

## Supported Datasets

The repository is currently complete for two datasets:

- `library`
- `bpic19`

`library` is the easiest dataset for testing the full pipeline.

`bpic19` is supported in two forms:

- full EKG build in Neo4j,
- sampled viewer export for browser use.

The browser prototype is intentionally run on a sampled BPIC19 export, because a full BPIC19 JSON bundle is too large for this client-side viewer architecture.

## Repository Walkthrough

```text
bep/
|-- config.yaml
|-- requirements.txt
|-- docs/
|   `-- PIPELINE.md
|-- data/
|   |-- raw/
|   `-- semantic_headers/
|       |-- library.json
|       |-- library_DS.json
|       |-- bpic19.json
|       `-- bpic19_DS.json
|-- output/
|   `-- manifest.json          <- dataset registry (add new datasets here)
|-- pipeline/
|   |-- build_ekg.py
|   |-- export_json.py
|   |-- config_loader.py
|   `-- cypher/
|       |-- events.cypher
|       |-- entities.cypher
|       |-- corr.cypher
|       |-- df.cypher
|       `-- relations.cypher
|-- scripts/
|   `-- check_neo4j.py
`-- viewer/
    |-- index.html
    |-- style.css
    `-- src/
        |-- main.js            <- central route dispatcher
        |-- router.js          <- hash-based SPA router
        |-- data/
        |   |-- entityTypes.js <- dataset-agnostic entity-type registry
        |   |-- loader.js
        |   `-- store.js       <- store build, variant analytics, shared-event hotspot exports
        |-- layout/
        |   |-- detailLayout.js
        |   `-- overviewLayout.js
        |-- render/
        |   |-- detailRender.js
        |   |-- overviewRender.js
        |   `-- shared.js
        `-- screens/
            |-- home.js        <- T0 home screen with task cards
            |-- identify.js    <- T1 entity picker
            |-- explore.js     <- T4 shared-events list and cluster detail dashboard
            |-- summarize.js   <- T3 process variant card grid
            `-- sidebar.js     <- route-aware sidebar / topbar updater
```

Read this structure from top to bottom:

- `pipeline/` creates the graph and exports it.
- `output/` stores the JSON bundles used by the viewer.
- `viewer/` re-derives analytical structure client-side and renders the layouts.

## How To Build And Run The Prototype

All commands below assume you are in:

```powershell
cd C:\Users\matei\Documents\GitHub\complex_bep\bep
```

### 1. Create the Python environment

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

### 2. Check Neo4j configuration

The repository reads Neo4j settings from `config.yaml`.

Current dataset entries:

- `library` -> Neo4j database `library`
- `bpic19` -> Neo4j database `bpic19`

The helper script only verifies connectivity and inspects the default Neo4j database:

```powershell
python scripts\check_neo4j.py
```

That is useful as a connection check, but the actual build and export commands use the dataset-specific database configured under `datasets.<name>.database`.

### 3. Build and export the library dataset

This is the recommended first run.

```powershell
python -m pipeline.build_ekg --dataset library --yes
python -m pipeline.export_json --dataset library --output output/library.json
```

### 4. Build and export the BPIC19 prototype bundle

Build the full BPIC19 EKG in Neo4j:

```powershell
python -m pipeline.build_ekg --dataset bpic19 --yes
```

Then export a viewer-sized sampled bundle:

```powershell
python -m pipeline.export_json --dataset bpic19 --output output/bpic19.json --sample-cases 720 --max-case-events 160
```

This is the intended BPIC19 prototype workflow. It keeps the graph construction faithful in Neo4j while producing a browser-manageable JSON bundle.

If you need a full JSON export for offline processing, you can export to another filename, but that full bundle is not intended for direct use in the browser prototype.

### 5. Start the viewer

Serve from the repository root so the viewer can load `output/*.json`:

```powershell
python -m http.server 8000
```

Then open:

```
http://localhost:8000/viewer/
```

The viewer loads `output/manifest.json`, shows the home screen with dataset statistics and the four task cards, and lets you switch datasets at any time via the "Switch dataset" button.

You can also deep-link into a specific dataset and route:

```
http://localhost:8000/viewer/#/home
http://localhost:8000/viewer/#/identify?entity=<id>
http://localhost:8000/viewer/#/compare?entities=<id1>,<id2>
http://localhost:8000/viewer/#/summarize
http://localhost:8000/viewer/#/explore
```

## Fastest Evaluation Path

If the JSON bundles already exist and you only want to inspect the prototype:

```powershell
.\.venv\Scripts\Activate.ps1
python -m http.server 8000
```

Then open `http://localhost:8000/viewer/`. The home screen will show dataset statistics and the four task cards. Click a card to enter that screen.

## End-to-End Project Flow

The project has four stages.

### Stage 1. Dataset description and semantic modeling

The actual EKG semantics are declared in `data/semantic_headers/`.

Each supported dataset has two files:

- `<dataset>.json`
  Semantic header that defines records, entity construction, inferred correlations, DF inference, and structural relations.
- `<dataset>_DS.json`
  Dataset description used by PromG to locate files, parse timestamps, and map raw columns into record attributes.

This keeps the graph model dataset-driven rather than hardcoding entity logic in Python.

### Stage 2. EKG build in Neo4j

`pipeline/build_ekg.py` orchestrates PromG:

1. load `config.yaml`,
2. resolve dataset paths,
3. create a temporary working directory,
4. mirror the expected data paths for PromG,
5. connect to the dataset-specific Neo4j database,
6. clear the database,
7. import raw records,
8. create event and entity nodes,
9. create structural entity relations,
10. infer DF edges where the semantic header requests them.

Important command:

```powershell
python -m pipeline.build_ekg --dataset <name> [--sample] [--yes]
```

Notes:

- `--sample` is PromG sample mode, driven by the dataset description.
- `--yes` skips the destructive rebuild confirmation.

### Stage 3. Typed JSON export

`pipeline/export_json.py` exports the graph to the stable viewer bundle.

The bundle contains:

- `events`
- `entities`
- `corr`
- `df`
- `relations`

The export preserves:

- stable entity IDs,
- `primary_type` and `labels` for entities,
- relation types on `corr`,
- entity ownership on `df`,
- non-event structural entity relations.

Important command:

```powershell
python -m pipeline.export_json --dataset <name> --output output/<name>.json
```

For large datasets:

```powershell
python -m pipeline.export_json --dataset bpic19 --output output/bpic19.json --sample-cases 720 --max-case-events 160
```

The full bundle schema is documented in [docs/PIPELINE.md](docs/PIPELINE.md).

### Stage 4. Browser-side analysis and rendering

The viewer is a static D3 application with no Node build step.

At load time it:

1. fetches the JSON bundle,
2. builds an in-memory store,
3. derives analytical structures,
4. computes layout geometry,
5. renders SVG (T1, T2) or HTML dashboards (T3, T4) with interactive sidebar panels.

The main analytical frontend files are:

- [viewer/src/data/store.js](viewer/src/data/store.js)
- [viewer/src/layout/detailLayout.js](viewer/src/layout/detailLayout.js)
- [viewer/src/layout/overviewLayout.js](viewer/src/layout/overviewLayout.js)

## Prototype Views

### T1 – Lifecycle (`#/identify`)

Opens one entity and renders its full multi-entity detail slice on a shared time axis.

- Anchor entity's first and last events are marked with START / END glyphs.
- Bottleneck DF edges are highlighted in amber.
- Sidebar shows: shared-only filter, max-entities slider, entity-type toggles, edge-layer opacity controls, shared-event hotspot list, cluster activity filter, legend.

Depending on the anchor type, the scope is specialised:

- case/member anchor → overlap-only case focus,
- item/book anchor → overlap-only item focus,
- generic anchor → local neighbourhood.

### T2 – Variants & Comparison (`#/compare`)

Two modes are available in this screen:

**Variants mode** (default):
- Reconstructs item-level traces, groups identical sequences into variants, and ranks them by frequency.
- A lower activity transition graph shows dominant paths.
- Sidebar shows variant statistics, member list, and item list.
- "Compare top N" button seeds the compare strip with the top variant's parent-level entities (Members / PurchaseOrders), not item-level entities.

**Compare mode** (entered via the compare strip, a deep-link with `?entities=...`, or the "View variant" button on T3):
- Multiple entity lifelines are shown on the same canvas simultaneously.
- Each entity gets an accent colour in the compare strip; its lane is highlighted on the canvas.
- Entities can be added (by clicking any entity in the sidebar list) or removed via the strip's × button.

### T3 – Process Overview (`#/summarize`)

Variant-based overview of the whole dataset, rendered as a scrollable HTML card grid.

- Each card represents one unique activity sequence (process variant).
- Cards show: variant rank, activity sequence, case count, proportion bar relative to the dominant variant, member count, event total, average duration, and date range.
- Cards are sorted by frequency; the dominant variant is visually distinguished.
- Clicking any card navigates directly to T2 compare mode with that variant pre-selected.
- The sidebar shows overall process statistics: variant count, total cases, dominant variant share, and average sequence length.
- The activity filter in the sidebar applies to variant computation, narrowing both the card grid and statistics.

This replaces the earlier label-propagation community clustering, which produced 80+ indistinguishable communities for BPIC19. The variant-based grouping uses the same trace reconstruction as T2, making T3 and T2 directly consistent.

### T4 – Shared Events (`#/explore`)

Surfaces synchronisation hotspots across entity types.

- The hotspot list shows activities that appear in shared events involving **three or more entity instances simultaneously** (two-entity events are filtered out as normal baseline correlations in object-centric processes).
- Hotspots are ranked by event count, entity-type diversity, and sync degree.
- Clicking a hotspot opens an analytics dashboard showing: entity-count distribution, entities by type, type-pair co-participation, and most-active entities for that activity.
- Sidebar shows a hotspot summary panel with date range, entity type breakdown, and avg sync degree.

## Layout Algorithms

This is the core contribution of the prototype.

### T3 variant grouping

T3 does not use a separate clustering step. It reuses the same `_collectItemSequences` computation as T2: item-level DF paths are reconstructed, grouped by exact activity sequence, and ranked by frequency. Each unique sequence is one "community". This gives semantically grounded groups with self-describing labels (the activity sequence itself), directly comparable to the T2 variant view, and stable regardless of graph topology changes.

### Variant layout (T2)

The variant view reconstructs ordered item traces from DF edges, groups identical sequences, and renders:

- a ranked list of variants,
- a lower activity DF graph positioned by average activity position in the trace.

This view supports thesis-level process comparison at the item lifecycle level.

### Detail layout (T1 and T2 compare mode)

The detail layout is the most important algorithmic part of the repository.

Its core rules are:

1. One shared horizontal time axis.
   All visible events are positioned on the same temporal scale, which keeps inter-entity coordination readable.

2. One band per entity type.
   The layout groups entities by type before placing individual lanes.

3. One lane per entity instance.
   Each visible entity gets its own DF path inside its type band.

4. Event anchors are positioned once and reused.
   Lanes, correlation links, and shared-event guides all reference the same anchor positions.

5. Shared events are explicit.
   Shared events are shown through vertical guides and a clustered shared-event rail at the top of the timeline instead of a flat pile of stacked nodes.

6. Mixed shared clusters are explorable.
   If a shared cluster contains multiple activities, clicking it opens a sidebar filter that lets the user restrict the current detail slice to one event type from that cluster.

7. Structural relations remain available.
   Entity-to-entity relations can be rendered as a separate layer alongside DF and correlation structure.

8. Bottlenecks are local.
   Visible DF gaps are measured and the upper quartile threshold is used to mark unusually long waits in the current slice.

9. The time scale is robust to outliers.
   Extreme timestamps can trigger a clipped robust range so that one bad outlier does not collapse the entire view into a vertical strip.

In the current implementation, the detail view is therefore not just a per-case list of traces. It is a typed EKG slice with synchronized time, cross-entity shared-event signaling, and dynamic filtering.

## Interaction Model

The prototype is designed around the home screen as a starting point:

1. open `#/home` to see dataset statistics and pick a task card,
2. navigate into any of the four screens,
3. drill down via entity / variant selection,
4. use the home button (top-left) to return to the home screen at any time,
5. use the breadcrumb to track the current task and entity context.

The topbar is always visible and shows:

- a home button,
- a breadcrumb chip with the current task (T1–T4) and context entity or variant,
- the active dataset name and a "Switch dataset" button,
- Fit and Reset-zoom camera controls (active in SVG screens T1/T2).

The sidebar panels are route-aware: each panel is shown only on the routes where it is relevant. The sidebar can be resized by dragging its right edge.

All view state is encoded in the URL hash, so browser back / forward navigation works correctly.

The SVG canvas (T1, T2) is also keyboard navigable:

- arrows or `WASD` to pan,
- `+` and `-` to zoom,
- `F` to fit,
- `0` to reset.

## What To Read In The Code

If you want to understand the repository quickly, read these files in order:

1. [pipeline/build_ekg.py](pipeline/build_ekg.py)
2. [pipeline/export_json.py](pipeline/export_json.py)
3. [viewer/src/data/store.js](viewer/src/data/store.js) — store build, variant/community analytics, shared-event hotspot exports
4. [viewer/src/data/entityTypes.js](viewer/src/data/entityTypes.js) — dataset-agnostic role inference (case / item / resource / attribute)
5. [viewer/src/router.js](viewer/src/router.js) — hash router
6. [viewer/src/main.js](viewer/src/main.js) — central route dispatcher, screen wiring
7. [viewer/src/layout/detailLayout.js](viewer/src/layout/detailLayout.js)
8. [viewer/src/layout/overviewLayout.js](viewer/src/layout/overviewLayout.js)
9. [viewer/src/render/detailRender.js](viewer/src/render/detailRender.js)
10. [viewer/src/render/overviewRender.js](viewer/src/render/overviewRender.js)

That sequence matches the actual data flow from raw records to visual layout.

## Current Constraints

- Supported end-to-end datasets in the repository: `library`, `bpic19`
- BPIC19 should be viewed through a sampled export, not the full browser bundle
- `scripts/check_neo4j.py` checks connectivity against the default database, not a dataset database
- The viewer is static and browser-only; it does not query Neo4j directly at runtime
- T3 shows up to 30 variants by default; the activity filter can narrow the scope further

## Summary

This repository is a full prototype pipeline for thesis-driven EKG analysis:

- semantic dataset descriptions define the graph,
- PromG builds the EKG in Neo4j,
- Python exports a typed JSON bundle,
- `output/manifest.json` declares available datasets without touching viewer code,
- the browser reconstructs analytical structure and computes the layouts,
- four task-aligned screens cover Lifecycle (T1), Variants & Comparison (T2), Process Overview (T3), and Shared Events (T4).

**T1 and T2** render as interactive SVG canvases using the custom typed-band detail layout: entity types as horizontal bands, individual lifecycles as lanes, a shared time axis, bottleneck DF highlighting, shared-event guides, and optional correlation and structural relation layers.

**T3** renders as a scrollable HTML card grid of process variants, each linking back to T2 for detailed comparison. This replaces the earlier label-propagation community clustering, which produced too many indistinguishable groups for large datasets.

**T4** renders as a scrollable HTML analytics dashboard showing shared-event hotspots filtered to events with three or more entity types, surfacing genuine multi-entity synchronisation rather than trivial two-entity correlations.
