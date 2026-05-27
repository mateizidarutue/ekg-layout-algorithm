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
| T1 Lifecycle (Population) | `#/summarize` | Canvas 2D + SVG overlay | Complete (activity-row y-encoding, single-click selection) |
| T2 Lifecycle (Detail)     | `#/identify`  | SVG canvas | Complete |
| T3 Variants & Comparison  | `#/compare`   | SVG canvas | Complete |
| T4 Shared Events          | `#/explore`   | HTML dashboard | Complete |

**T1** renders every event of every entity on a single Canvas 2D dotted-chart. Channel assignment: time on x, activity-row within entity-type band on y, entity-type colour. Activities within a band are stacked as horizontal rows ordered by descending event count, so a band shows its dominant activities at the top and the long-tail rare ones at the bottom. A single entity's events form a vertical staircase as its activity changes. Clicking any event selects it and surfaces its EKG neighbourhood: the clicked entity's full event trace as a polyline, plus the traces of every entity co-participating at the selected event (one-hop propagation across correlation edges). When a selection is active the band's activity rows reorder so that the highlighted entities' activities float to the top by first-occurrence time — the primary trace lays out as a clean top-left → bottom-right diagonal. A focus-context brush below the canvas zooms a time window. This is the only Canvas 2D screen in the viewer; everything else is SVG.

**T2** opens one entity and renders its full multi-entity slice on a shared time axis, with DF bottleneck highlighting, vertical shared-event spines, optional correlation and structural-relation overlays, and an interactive cluster-activity filter. The tooltip on any event lists every correlated entity grouped by type, each entity clickable to jump straight to *its* T2 view. Drag horizontally anywhere on the canvas to zoom to a time window; a floating chip in the top-right shows the active window and resets it with one click.

**T3** reconstructs item-level traces, groups them into process variants, and shows a dominant-variant ranking alongside an activity DF graph. Compare mode places multiple entity lifelines on the same canvas with per-entity accent colours. "Compare top N" on any variant card opens the compare view *scoped to that variant* — only items actually belonging to the variant appear, grouped on the y axis by their parent case so each parent's children sit as a contiguous block.

**T4** lists shared-event hotspots (activities that appear in events correlated to three or more entities simultaneously) and drills into an analytics dashboard showing entity-count distribution, type-pair co-participation, and most-active entities for each hotspot.

**Co-temporal event merge.** Some exports (notably BPIC19) emit one event per child entity at the same parent-level timestamp — e.g., 7 separate "Create Purchase Order Item" events for a PurchaseOrder with 7 line items. The store collapses these at build time using `(date, activity, sorted case-type entity set)` as the merge key, so every screen sees one logical event per group whose memberships span the parent and every child involved. See [Layout Algorithms](#layout-algorithms) below.

## Four-Task Screen Architecture

The viewer organises analysis around four task cards derived from Munzner (2014):

| Task | Route | Munzner tuple | Purpose |
|---|---|---|---|
| T1 Lifecycle (Population) | `#/summarize` | ⟨Summarize, Topology⟩ | Read every entity's lifecycle in one population dotted-chart; click any event to surface the local EKG neighbourhood (its entity's full trace plus all co-participating entities at that event). |
| T2 Lifecycle (Detail)     | `#/identify`  | ⟨Identify, Path⟩ | Open one entity and read its full multi-band detail slice including bottleneck waits. |
| T3 Variants & Comparison  | `#/compare`   | ⟨Compare, Paths⟩ | Group entities by behaviour into variants, then place multiple lifelines on the same canvas. |
| T4 Shared Events          | `#/explore`   | ⟨Explore, Features⟩ | Find shared events where three or more entity lifecycles intersect. |

T1 and T2 work at different scales but compose: T1 reads as a ⟨Summarize, Topology⟩ view of the whole dataset (every entity at once, dot-density), and T2 is the ⟨Identify, Path⟩ drill-down for one entity (full detail layout with DF edges, correlation, structural relations). T1 is the analyst's entry point; T2 is invoked from T1's inspector for any selected entity, or directly from a `#/identify?entity=…` URL.

### Hash-based navigation

The viewer uses hash-based routing. Every view state is a stable, shareable URL:

```
http://localhost:8000/viewer/#/home
http://localhost:8000/viewer/#/summarize                                            (T1 population view)
http://localhost:8000/viewer/#/summarize?selected=<eventId>&t0=<ms>&t1=<ms>&q=<query>
http://localhost:8000/viewer/#/identify?entity=<id>                                 (T2 detail view)
http://localhost:8000/viewer/#/identify?entity=<id>&dateFrom=<ms>&dateTo=<ms>       (T2 with time window)
http://localhost:8000/viewer/#/compare                                              (T3 variants overview)
http://localhost:8000/viewer/#/compare?variant=<sequence-key>                       (T3 variant selected)
http://localhost:8000/viewer/#/compare?entities=<id1>,<id2>                         (T3 compare detail)
http://localhost:8000/viewer/#/compare?entities=<id1>,<id2>&variant=<sequence-key>  (T3 compare scoped to variant)
http://localhost:8000/viewer/#/explore?cluster=act:<activity>                       (T4 hotspot drill-in)
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
   T1 shows every event of every entity in one population dotted-chart, with single-click selection surfacing an entity's full trace plus the traces of every co-participating entity at the clicked event (one-hop propagation). T2 drills into one entity's full multi-band detail slice. T3 focuses on dominant item-level behaviour and variant-scoped side-by-side comparison. T4 surfaces synchronisation hotspots where three or more entity types intersect.

3. It emphasizes the layout requirements from the thesis.
   The detail view uses one horizontal time axis, one band per entity type, one lane per entity instance, vertical shared-event spines that cross participating bands, parent-grouped lanes within child-type bands, and optional DF and structural relation layers.

4. The shared-event threshold is calibrated to the OCPM context.
   T4 requires at least three entities in a shared event (not two), filtering out trivial two-entity co-occurrences that are normal baseline correlations in object-centric processes.

5. Co-temporal events are merged at ingest, not double-counted at render.
   The store collapses events that share `(timestamp, activity, case-type entity set)` so a parent-level event isn't multiplied by the number of children it touches. Counts in every screen reflect logical events, not the export's per-child duplicates.

In practical terms, the prototype supports:

- reading the whole dataset at once as a Canvas 2D population view,
- selecting any event to highlight its EKG neighbourhood — the clicked entity's full trace plus every co-participant — with the band's activity rows re-ranked so the primary trace runs as a clean top-left → bottom-right diagonal,
- zooming a time window via a focus-context brush (T1) or by dragging horizontally on the canvas (T2/T3 compare),
- drilling into a single entity's multi-band detail slice, with every correlated entity in any event tooltip clickable to swap focus to its lifecycle,
- comparing item traces scoped to a specific process variant, with the parent cases grouped on the y axis,
- browsing the full process-variant distribution as ranked cards,
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
        |-- main.js                 <- central route dispatcher
        |-- router.js               <- hash-based SPA router
        |-- data/
        |   |-- entityTypes.js      <- dataset-agnostic entity-type registry
        |   |-- loader.js
        |   `-- store.js            <- store build, getEkgView, variant analytics, hotspots
        |-- layout/
        |   |-- detailLayout.js     <- T2 / T3 compare detail geometry
        |   |-- overviewLayout.js   <- T3 variant card grid + activity DF graph
        |   `-- summarizeLayout.js  <- T1 population: bands, dots, shared ticks (pure)
        |-- render/
        |   |-- detailRender.js     <- T2 / T3 compare SVG renderer
        |   |-- overviewRender.js   <- T3 variant SVG renderer
        |   |-- exploreClusterRender.js
        |   |-- summarizeRender.js  <- T1 Canvas 2D dot pass + SVG overlay
        |   `-- shared.js
        `-- screens/
            |-- home.js             <- home screen with task cards
            |-- summarize.js        <- T1 population view (Canvas 2D screen module)
            |-- identify.js         <- T2 entity picker (the detail render flows through main.js)
            |-- explore.js          <- T4 shared-events list and cluster detail dashboard
            `-- sidebar.js          <- route-aware sidebar / topbar updater
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
http://localhost:8000/viewer/#/summarize                       (T1 population)
http://localhost:8000/viewer/#/identify?entity=<id>            (T2 detail)
http://localhost:8000/viewer/#/compare?entities=<id1>,<id2>    (T3 compare)
http://localhost:8000/viewer/#/explore                         (T4 hotspots)
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
2. builds an in-memory store and runs the **co-temporal event merge** (collapses per-child duplicates by `(date, activity, case-type set)` so every downstream consumer sees one logical event per group),
3. derives analytical structures (`getEkgView` for T1, `getDetailGraph` for T2/T3 compare, `getVariantOverview` for T3 variants, `getGlobalSharedEventHotspots` for T4),
4. computes layout geometry,
5. renders Canvas 2D (T1) or SVG (T2, T3) or HTML dashboards (T4) with interactive sidebar panels.

The main analytical frontend files are:

- [viewer/src/data/store.js](viewer/src/data/store.js) — store build, co-temporal event merge, `getDetailGraph`, `getEkgView`, variant analytics, hotspots
- [viewer/src/layout/summarizeLayout.js](viewer/src/layout/summarizeLayout.js) — T1 population dotted-chart
- [viewer/src/layout/detailLayout.js](viewer/src/layout/detailLayout.js) — typed-band detail (T2 + T3 compare)
- [viewer/src/layout/overviewLayout.js](viewer/src/layout/overviewLayout.js) — T3 variant overview

## Prototype Views

### T1 – Lifecycle (Population) (`#/summarize`)

The analyst's entry point. Renders the entire dataset as a single Canvas 2D dotted-chart.

**Channel assignment.**

- `x` = event timestamp (within the visible time window).
- `y` = `(entity-type band, event activity)`. Each band stacks its activities as horizontal rows, ordered top-to-bottom by descending event count (ties broken alphabetically). Activity labels sit in a gutter between the band header and the data area.
- `color` = entity-type band colour.
- `shape` = one filled circle per event; shared events (≥2 entity types) are drawn 40 % larger.

Because y encodes activity, a single entity's events form a vertical staircase as it transitions between activities, and dominant flows read as dense horizontal rows. This is genuinely population-level structure, not an entity-by-rank ordering.

**Selection (single-click, one-hop propagation).**

Click any event dot. The screen builds a selection record:

- `primaryEntityId` = the band-of-click entity (the entity whose lane the dot was drawn in).
- `highlightedEventIds` = every event of the primary entity ∪ every event of every entity correlated to the *selected event* (one hop, not transitive).
- `highlightedEntityIds` = the primary plus the co-participating entities.

Visual response: highlighted dots stay at full opacity, all other dots fade to ~0.25 alpha. The primary entity's trace draws as a polyline (band-coloured, stroke width 2). Each co-participating entity's trace draws as a thinner polyline (stroke width 1.4, opacity 0.85). The selected event itself gets a black halo. The right-edge inspector opens with an **Event** panel (correlated entities grouped by type, each clickable to switch primary), a **Primary entity** panel (full event sequence, each event clickable to re-anchor the selection inside the same entity), and a collapsible **Correlated entities** panel.

There is no multi-pin: clicking a different dot replaces the selection, clicking the selected dot or empty space or pressing `Esc` clears it. Selection is serialised as `?selected=<eventId>`; on hydration the primary entity is recovered from the event's `entity_ids_by_type` in band order.

**Other controls.**

- **Time brush.** A density strip below the canvas exposes a `d3.brushX`. Drag to zoom a window, double-click to clear. The current window is shown above the brush as a date range.
- **Search.** Live search by entity id or label highlights matching entities and dims the rest.
- **Sidebar.** Current-selection summary (event activity, time, primary entity, counts), entity-type band visibility toggles, plus the dataset-wide activity allowlist.
- **Keyboard.** `Esc` clears the selection, `/` focuses search, `0` resets the window.
- **URL state.** `?selected=`, `?t0=`, `?t1=`, `?q=`. Legacy `?pinned=` / `?entity=` URLs from earlier prototype builds are accepted on first load: the first id is resolved to its first event and rewritten as `?selected=`.

This is the only Canvas 2D screen in the viewer. All other screens are SVG. The rationale: at the population scale a typical viewer bundle is on the order of 10⁴–10⁵ dots, and a per-dot SVG node tax (~1 KB live size) makes that intractable.

### T2 – Lifecycle (Detail) (`#/identify`)

Drilled-in detail for one entity. Renders its full multi-entity detail slice on a shared time axis.

- One horizontal time axis at the top, one band per entity type below it, one lane per entity instance inside each band.
- Bottleneck DF edges are highlighted in amber. The threshold is the upper-quartile DF gap in the current slice, so what counts as a bottleneck is local to the view.
- Shared events are drawn as colored vertical spines that cross the bands they touch, with a small dot on the axis line at each event's timestamp. No stacked anchor rail above the timeline — the spines plus per-lane dots carry all the cross-entity signalling.
- **Drag-to-zoom time window.** Drag horizontally anywhere on empty canvas space to set `dateFrom`/`dateTo`. A floating chip in the top-right shows the active window and clears it with one click. Movement under 5 px falls through as a regular click (selection-clear), so dots and band headers keep their own click affordance.
- **Tooltip with clickable correlated entities.** Hovering an event lists every correlated entity grouped by type. Each entity is a link — click to swap focus to that entity's own T2 lifecycle. Entities not currently rendered as a lane (because the maxEntitiesPerType slider clips them) appear in muted style but are still clickable.
- **Sidebar.** Shared-only filter, max-entities slider, entity-type toggles, edge-layer opacity controls (DF, CORR, Relations), shared-event hotspot list, cluster-activity filter, detail summary panel, legend.

Depending on the anchor type, the scope is specialised:

- case/member anchor → overlap-only case focus,
- item/book anchor → overlap-only item focus,
- generic anchor → local neighbourhood.

T1 → T2 handoff: in the T1 inspector, click "Open T2 detail" on the primary entity, or click any correlated entity row to land on its T2 view. The T2 tooltip's entity links navigate the same way.

### T3 – Variants & Comparison (`#/compare`)

Two modes are available in this screen:

**Variants mode** (default, or with `?variant=<key>`):

- Reconstructs item-level traces, groups identical sequences into variants, and ranks them by frequency.
- A lower activity transition graph shows dominant paths.
- Sidebar shows variant statistics, member list, and item list.
- Each variant card has a "Compare top N" button that seeds the compare detail with the top N parent-level entities of *this variant*. "Top N" is ranked by **item count desc → event count desc → label asc** — the N parents that own the most items belonging to the selected variant. The button's tooltip and a sidebar caption surface this ranking so the criterion isn't hidden.

**Compare mode** (entered via "Compare top N", a deep-link with `?entities=…`, or by adding entities from the sidebar):

- Multiple entity lifelines are shown on the same canvas simultaneously, sharing one time axis.
- Each compared entity gets an accent colour in the compare strip; its lane is highlighted on the canvas.
- When the URL carries `?variant=<key>` alongside `?entities=…`, the item band is **scoped to that variant's items only** — items belonging to the selected parents but to *other* variants are filtered out. A purple `VARIANT N` chip plus the variant sequence and ranking note appear at the top of the Detail Summary panel so the analyst knows the scope is restricted.
- **Items are grouped by parent on the y axis.** Within the item band, lanes are sorted by `(parent rank in compare set, entity_id)`, so each parent's children sit as a contiguous block in the order the parents were selected. The visual separation makes it obvious which children belong to which parent.
- Entities can be added (by clicking any entity in the sidebar list) or removed via the strip's × button. Removing an entity preserves the variant scope.
- The same drag-to-zoom time window and clickable-tooltip behaviour from T2 applies here.

### T4 – Shared Events (`#/explore`)

Surfaces synchronisation hotspots across entity types.

- The hotspot list shows activities that appear in shared events involving **three or more entity instances simultaneously** (two-entity events are filtered out as normal baseline correlations in object-centric processes).
- Hotspots are ranked by event count, entity-type diversity, and sync degree.
- Clicking a hotspot opens an analytics dashboard showing: entity-count distribution, entities by type, type-pair co-participation, and most-active entities for that activity.
- Sidebar shows a hotspot summary panel with date range, entity type breakdown, and avg sync degree.

## Layout Algorithms

This is the core contribution of the prototype. There are four distinct algorithms doing real work, plus one data-layer transformation that every screen depends on.

### Co-temporal event merge (data layer, `buildStore`)

Object-centric exports often emit one event per child entity at the same parent-level timestamp. BPIC19 is the canonical example: a single "Create Purchase Order Item" event for a PurchaseOrder with N line items appears as N separate events sharing the same `(date, activity)`, each correlated to one item. Without merging, every parent-level view stacks N dots at the same x,y and every count metric is inflated by N.

The store collapses these at build time, before any consumer touches the events:

```
merge key = (date_ms, activity, sorted list of case-type entity ids the event touches)
```

For each group, the lexicographically smallest `event_id` becomes canonical. The canonical event's `entity_ids`, `entity_ids_by_type`, and `memberships` are the union over the whole group. `corr` edges are rewired to point at the canonical id and deduped per `(canonical_event, entity)`. `df` edges are rewired through the merge map; resulting self-loops are dropped, parallel edges deduped. All downstream maps (`eventsByEntityId`, `corrByEventId`, `dfByEntityId`, `eventsByCaseId`, `eventsByItemId`) are then built from the merged event list, so every consumer sees one logical event per group.

The case-type entity set in the key is what disambiguates true duplicates from coincidence: two independent PurchaseOrders firing the same activity at the same instant stay separate, because their case-type sets differ. Variants are computed at the item level, so item-level traces are unchanged by the merge.

### T1 population layout (`summarizeLayout.js`)

Pure-function geometry for the dotted-chart at `#/summarize`. Inputs: the `getEkgView` data + viewport + visible time window + optional `selectionActivityOrder`. Outputs: per-band geometry, per-dot positions, per-entity ordered event arrays (for the polylines), per-band activity-label layout.

Channel assignment:

```
x     ← event timestamp (within visible window)
y     ← (entity-type band, event activity)
color ← entity-type band colour
shape ← single circle per event; ×1.4 radius if `isShared`
```

Within each band, the distinct activities of the events touching that band are ranked by descending event count (ties broken alphabetically) and laid out as evenly-spaced horizontal rows. The activity-label gutter widens adaptively to fit the longest label across all visible bands (capped between 150 and 340 px).

When `selectionActivityOrder` is supplied (because a dot is selected), each band's activity rows are reordered: activities the highlighted entities touch, in first-occurrence-time order, float to the top of the band; the remaining activities fall through to the default frequency order. The result is that the primary entity's trace lays out as a top-left → bottom-right diagonal across whichever bands it touches.

A quadtree is built over `dotPositions` and rebuilt whenever the layout recomputes (resize, brush change, selection change, band visibility change).

### Detail layout (`detailLayout.js`, used by T2 and T3 compare mode)

The detail layout is the typed-band slice used wherever individual entity lifelines need full DF / CORR / Relation rendering.

Its core rules:

1. **One shared horizontal time axis.** All visible events are positioned on the same temporal scale. The scale is robust to outliers: if 1st and 99th percentiles span less than 35 % of the raw range, the axis clips to the robust range so a single bad timestamp can't collapse the view into a vertical strip.

2. **One band per entity type.** Bands are ordered by the type registry (case-type first, item-type next, then others).

3. **One lane per entity instance.** Each visible entity gets its own DF path inside its type band. The anchor entity and any compare entities are pinned to the top of their band; remaining lanes are sorted by event count.

4. **Items grouped by parent.** Inside the item-type band, lanes are sorted by `(parent rank in compare set, entity_id)`. When the compare set is `[PO_A, PO_B, PO_C]`, the band shows `PO_A`'s items first as a contiguous block, then `PO_B`'s, then `PO_C`'s. Within each block items appear in their natural numerical order (00010, 00020, …).

5. **Shared events are vertical spines.** Each event correlated to ≥2 visible entities becomes a colored vertical line crossing the bands it touches, with a small circle on the axis line at the spine's top. The deprecated "stacked anchor rail" above the axis is no longer rendered — the spines plus per-lane dots carry all cross-entity signalling.

6. **Cluster-activity isolation.** Clicking a shared cluster opens a sidebar filter that restricts the current detail slice to one event type from that cluster.

7. **Structural relations remain available.** Non-event entity-to-entity relations can be rendered as a separate dashed-amber layer alongside DF and correlation structure.

8. **Bottlenecks are local.** Visible DF gaps are measured and the upper quartile threshold is used to mark unusually long waits in the current slice.

9. **Variant-scoped item restriction.** When the caller passes `restrictedItemIds`, the item band is limited to those items only — used by T3's variant-driven compare flow to scope the chart to items in the selected behavioural variant.

### T3 variant grouping (`store.js`, `_collectItemSequences` + `getVariantOverview`)

T3 does not use a separate clustering step. Item-level DF paths are reconstructed from `dfByEntityId`, grouped by exact activity sequence, and ranked by frequency. Each unique sequence is one variant. This gives semantically grounded groups with self-describing labels (the activity sequence itself), and stable variants regardless of graph topology changes.

Each variant carries an `items` list (sorted by event count desc) and a `members` list (the parent cases owning those items, sorted by item count desc → event count desc → label asc). The "Compare top N" button on a variant card slices the members list at N.

### T3 variant overview layout (`overviewLayout.js`)

The variants overview view reconstructs ordered item traces from DF edges, groups identical sequences, and renders:

- a ranked list of variants as horizontal rows,
- a lower activity DF graph positioned by average activity position across the variant set.

This view supports thesis-level process comparison at the item lifecycle level.

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
- Top (scroll-to-top) and Reset-view buttons (active in the SVG screens — T2 and T3 compare mode).

The sidebar panels are route-aware: each panel is shown only on the routes where it is relevant. The sidebar can be resized by dragging its right edge.

All view state is encoded in the URL hash, so deep-linking and shareable URLs work across screens.

**Keyboard.**

- T1 (Canvas population view): `Esc` clears selection, `/` focuses search, `0` resets the time window.
- T2 / T3 compare mode (SVG detail view): `F` scrolls to top, `0` resets the view. Pan with the regular scrollbar; horizontal pan with `Shift+wheel` or the bottom scrollbar.

## What To Read In The Code

If you want to understand the repository quickly, read these files in order:

1. [pipeline/build_ekg.py](pipeline/build_ekg.py)
2. [pipeline/export_json.py](pipeline/export_json.py)
3. [viewer/src/data/store.js](viewer/src/data/store.js) — store build, co-temporal event merge, variant analytics, shared-event hotspot exports, `getDetailGraph`, `getEkgView`
4. [viewer/src/data/entityTypes.js](viewer/src/data/entityTypes.js) — dataset-agnostic role inference (case / item / resource / attribute)
5. [viewer/src/router.js](viewer/src/router.js) — hash router
6. [viewer/src/main.js](viewer/src/main.js) — central route dispatcher, screen wiring, T2/T3 drag-to-zoom brush, tooltip behaviour
7. [viewer/src/layout/summarizeLayout.js](viewer/src/layout/summarizeLayout.js) — T1 population dotted-chart geometry
8. [viewer/src/layout/detailLayout.js](viewer/src/layout/detailLayout.js) — typed-band detail geometry (T2 + T3 compare)
9. [viewer/src/layout/overviewLayout.js](viewer/src/layout/overviewLayout.js) — T3 variant overview + activity DF graph
10. [viewer/src/render/summarizeRender.js](viewer/src/render/summarizeRender.js) — T1 Canvas 2D dot pass + SVG overlay
11. [viewer/src/render/detailRender.js](viewer/src/render/detailRender.js) — T2 / T3 compare SVG renderer
12. [viewer/src/render/overviewRender.js](viewer/src/render/overviewRender.js) — T3 variant overview renderer
13. [viewer/src/screens/summarize.js](viewer/src/screens/summarize.js) — T1 screen module (state, brush, selection, sidebar wiring)

That sequence matches the actual data flow from raw records to visual layout.

## Current Constraints

- Supported end-to-end datasets in the repository: `library`, `bpic19`
- BPIC19 should be viewed through a sampled export, not the full browser bundle
- `scripts/check_neo4j.py` checks connectivity against the default database, not a dataset database
- The viewer is static and browser-only; it does not query Neo4j directly at runtime
- T3 shows the top 20 % of variants by frequency (minimum one); the activity filter can narrow the scope further
- T1's selection model is single-event (no multi-pin); the URL serialises one `selected=<eventId>` at a time
- The co-temporal event merge assumes events sharing `(date, activity, case-type entity set)` are duplicates; datasets that genuinely have unrelated events at exactly the same instant with the same activity name should differ in their case-type sets to stay separate

## Summary

This repository is a full prototype pipeline for thesis-driven EKG analysis:

- semantic dataset descriptions define the graph,
- PromG builds the EKG in Neo4j,
- Python exports a typed JSON bundle,
- `output/manifest.json` declares available datasets without touching viewer code,
- the browser merges co-temporal duplicate events, reconstructs analytical structure, and computes the layouts,
- four task-aligned screens cover Lifecycle Population (T1), Lifecycle Detail (T2), Variants & Comparison (T3), and Shared Events (T4).

**T1** renders as a single Canvas 2D dotted-chart with an SVG overlay for band headers, axis, activity-row labels, selection polylines, and the selection halo. One dot per (entity, event); x = time, y = activity-row within an entity-type band, colour = entity type. Single-click selection highlights the clicked entity's trace plus every co-participating entity at the selected event (one-hop propagation), and reorders the band's activity rows so the primary trace runs as a top-left → bottom-right diagonal. The only Canvas 2D screen in the viewer.

**T2 and T3 compare mode** render as interactive SVG using the typed-band detail layout: entity types as horizontal bands, individual lifecycles as lanes (parent-grouped in the item band), one shared time axis, bottleneck DF highlighting, vertical shared-event spines, and optional correlation and structural relation layers. The tooltip on any event lists every correlated entity grouped by type, each one clickable to jump to its lifecycle. Drag horizontally on the canvas to set a time window.

**T3 variants mode** renders as a scrollable SVG ranking of unique activity sequences with a lower activity DF graph. The "Compare top N" affordance opens T3 compare mode scoped to a specific variant, restricting the item band to items belonging to that variant.

**T4** renders as a scrollable HTML analytics dashboard showing shared-event hotspots filtered to events with three or more entity types, surfacing genuine multi-entity synchronisation rather than trivial two-entity correlations.

**Underlying all four screens:** a co-temporal event merge in the data layer collapses per-child event duplicates into one logical event per `(timestamp, activity, case-type set)`, so counts and visualisations everywhere reflect logical events rather than the export's encoding artefacts.
