# BEP Repository Walkthrough

This document is a code-driven README draft for the repository as it exists today.
It does not replace the existing `README.md`.

The focus here is on what the project actually does end to end, with extra depth on
the layout algorithms in the browser viewer.

## What This Project Is

This repository contains two coupled parts:

1. A Python pipeline that builds an Event Knowledge Graph (EKG) in Neo4j using
   PromG.
2. A browser-based D3 viewer that loads an exported JSON bundle and turns that
   bundle into three visual products:
   - an overview similarity network of cases,
   - a per-case detail timeline layout,
   - a variant summary view with an activity transition graph.

At a high level the flow is:

```text
dataset config + semantic header + raw files
    ->
PromG build in Neo4j
    ->
Cypher export to JSON
    ->
client-side store construction in the browser
    ->
overview / community / detail / variant layouts
    ->
SVG rendering with D3
```

## Repository Structure

```text
bep/
|-- config.yaml
|-- README.md
|-- README_DRAFT.md
|-- requirements.txt
|-- data/
|   |-- raw/
|   |-- semantic_headers/
|-- docs/
|   `-- PIPELINE.md
|-- output/
|-- pipeline/
|   |-- build_ekg.py
|   |-- config_loader.py
|   |-- export_json.py
|   `-- cypher/
|-- scripts/
|   |-- check_neo4j.py
|   `-- explore_xes.py
`-- viewer/
    |-- index.html
    |-- style.css
    `-- src/
        |-- main.js
        |-- data/
        |   |-- loader.js
        |   `-- store.js
        |-- layout/
        |   |-- detailLayout.js
        |   `-- overviewLayout.js
        `-- render/
            |-- detailRender.js
            |-- overviewRender.js
            `-- shared.js
```

## End-to-End Execution Flow

### 1. Configuration is loaded

`pipeline/config_loader.py` is the shared entry point for configuration.

It does three things:

- loads `config.yaml`,
- validates that `neo4j` and `datasets` exist,
- resolves one dataset entry by name.

Each dataset entry is expected to contain:

- `raw_data`
- `semantic_header`
- `database`

If `dataset_description` is omitted, it defaults to `semantic_header`.

Important detail: in the current implementation, `raw_data` is validated but not
used by the build or export scripts. The actual file locations used by PromG come
from the dataset description JSON, not from `config.yaml`.

### 2. `build_ekg.py` constructs the graph in Neo4j

`pipeline/build_ekg.py` is the build entry point.

Command shape:

```bash
python -m pipeline.build_ekg --dataset <name> [--sample] [--yes]
```

The sequence inside `run()` is:

1. Resolve the dataset from `config.yaml`.
2. Check that the semantic header JSON and dataset description JSON exist.
3. Ask for confirmation unless `--yes` is supplied, because the target Neo4j
   database is cleared before rebuilding.
4. Create a temporary working directory.
5. Create directory junctions or symlinks inside that temp directory so PromG can
   resolve dataset-relative `file_directory` values correctly.
6. Change the current working directory to the temp directory.
7. Instantiate PromG objects:
   - `DatabaseConnection`
   - `SemanticHeader`
   - `ImportedDataStructures`
   - `EventKnowledgeGraph`
8. Run the PromG build stages:
   - `clear_db()`
   - `set_constraints()`
   - `import_data()`
   - `create_nodes()`
   - `create_relations()`
   - `create_df_edges()`
9. Print statistics and close the Neo4j connection.
10. Restore the original working directory and delete the temp directory.

The temporary directory logic matters because PromG resolves the paths from the
dataset description relative to the current working directory. This repository
works around that by creating local links into the real data directories before
calling PromG.

### 3. PromG semantics define what gets built

The actual graph structure is not hardcoded in Python. It is mostly declared in
the semantic header JSON files under `data/semantic_headers/`.

Those files define:

- `records`
  - how rows are classified into typed record views,
- `nodes`
  - how events and entities are materialized,
- `relations`
  - how structural relationships are built.

Examples from the repository:

- `library.json`
  - builds `Event`, `Book`, `Member`, `Library`, and a reified
    `SubscriptionAttribute`,
  - creates `ACTS_ON`, `EXECUTED_BY`, `BORROWED`, `MEMBER_OF`, and related edges.
- `bpic19.json`
  - builds `Event`, `Vendor`, `Company`, `PurchaseOrder`,
    `PurchaseOrderItem`, `Invoice`, `HumanResource`, and `SystemResource`,
  - creates `HAS_ITEM`, `SELLS`, `BUYS`, and `INVOICE_OF`,
  - enables DF inference on `PurchaseOrder`, `PurchaseOrderItem`, and
    `HumanResource`.

This means the EKG is fundamentally dataset-driven. The Python build script is an
orchestrator; the semantic header defines the graph semantics.

### 4. `export_json.py` flattens Neo4j into a viewer bundle

`pipeline/export_json.py` converts the Neo4j graph into a single JSON document.

Command shape:

```bash
python -m pipeline.export_json --dataset <name> --output output/<name>.json
```

Its internal flow is:

1. Load `config.yaml`.
2. Connect to the dataset-specific Neo4j database.
3. Execute four Cypher files:
   - `events.cypher`
   - `entities.cypher`
   - `corr.cypher`
   - `df.cypher`
4. Normalize the results into a JSON bundle.
5. Validate basic referential integrity.
6. Write the file.

The bundle shape is:

```json
{
  "dataset": "library",
  "generated_at": "2026-04-21T00:00:00Z",
  "promg_version": "0.1.25",
  "stats": {
    "events": 0,
    "entities": 0,
    "corr": 0,
    "df": 0
  },
  "events": [],
  "entities": [],
  "corr": [],
  "df": []
}
```

The export rules that matter most for the viewer are:

- events
  - exported from `(:Event)`,
  - keep top-level `event_id`, `activity`, `timestamp`,
  - all other node properties go into `properties`.
- entities
  - exported from `(:Entity)`,
  - `entity_type` is inferred from the first label that is not `Entity`.
- corr
  - exports every event-to-entity relationship, regardless of relationship type.
- df
  - exports every `DF` or `DF_*` relationship between events.

The exporter also prefers explicit IDs when possible:

- events: `event_id` property or `ID`, otherwise Neo4j internal ID,
- entities: `ID` or `entity_id`, otherwise the value returned by the Cypher query.

## What The Viewer Does With The Bundle

The viewer is a no-build static app:

- `viewer/index.html` loads D3 from a CDN.
- `viewer/src/main.js` is the application entry point.
- `viewer/src/data/store.js` turns the flat bundle into in-memory structures used
  by the layouts.

### Viewer startup flow

When the page loads:

1. `main.js` sets up the SVG root, zoom behavior, tooltip, sidebar, and controls.
2. It reads `?dataset=<name>` from the URL.
3. It fetches `output/<name>.json`.
4. It calls `buildStore(bundle)`.
5. It renders one of four view states:
   - `overview`
   - `community`
   - `detail`
   - `variants`

The viewer can also load a JSON file directly through the dropzone if the bundle
cannot be fetched over HTTP.

## Store Construction In `store.js`

`viewer/src/data/store.js` is the real analytical core of the frontend.

It does much more than simple indexing.

### 1. Entity role detection

The code still uses `po` and `poitem` variable names internally, but those are
generic case and item roles, not BPIC19-only semantics.

Role detection works like this:

1. Inspect the DF edges in the bundle.
2. If DF types include `PO` or `POItem`, force those names for backwards
   compatibility.
3. Otherwise count how many entities exist per type.
4. Treat the smaller count as the case type and the next one as the item type.

This is why the same UI can be used for both purchase orders and library cases.

### 2. Event flattening

Each exported event becomes a JS object with:

- the flattened `properties`,
- `event_id`,
- `id` as an alias,
- `activity`,
- `timestamp`,
- `date` as a `Date` object,
- `po_id`
- `poitem_id`

The last two are filled by inspecting `corr` edges and matching correlated entity
types against the detected case type and item type.

### 3. Multi-item event handling

If one event is correlated to multiple item entities, the store keeps the first
item as the event's primary `poitem_id`, but it also creates contextual copies of
that event for the other items so those additional item timelines can still render
the event.

This is important because synchronization analysis in the detail view depends on
events being visible on every involved item lane.

### 4. Indexes built by the store

The store derives:

- `eventsByPo`
- `eventsByItem`
- `itemsByPo`
- `dfItemByEntity`
- `dfPoByPo`
- `eventById`
- `entityById`
- `entityTypeById`
- `poList`

It also builds color maps for:

- activities,
- resources.

### 5. Case summaries

For every case, `_buildPoSummaries()` computes:

- event count,
- item count,
- first and last timestamp,
- center time,
- top activities,
- stable context attributes,
- resource set.

These summaries feed directly into overview similarity scoring.

### 6. Informative feature selection

Before overview similarity is computed, the store drops context and resource values
that are too common across the dataset.

The intent is to suppress features that are not discriminative. The threshold is:

- ignore values that appear in 80 percent or more of cases.

The remaining values become:

- `overviewResources`
- `overviewContextTokens`
- `overviewDisplayAttrs`

Those are the context features used in the overview model.

### 7. Activity filters behave differently across views

The sidebar activity filter is global, but each view consumes it differently.

- overview / community
  - similarity edges and community detection are recomputed from filtered activity
    counts,
  - those recomputations are cached per activity-set key,
  - context and resource summaries are not fully rebuilt from scratch.
- detail
  - visible events are filtered before the detail graph is laid out.
- variants
  - an item sequence is kept only if every activity in that sequence belongs to
    the selected activity set.

That last rule is easy to miss: in the variant view, filtering removes whole item
instances rather than trimming activities out of an existing sequence.

## Overview Model And Community Detection

The overview does not simply connect cases that share an item. It builds a
behavioral similarity graph.

### 1. Pairwise similarity scoring

For every pair of case summaries, `_scoreOverviewPair()` computes:

- activity cosine similarity: 48%
- resource Jaccard similarity: 18%
- context Jaccard similarity: 18%
- temporal similarity: 10%
- size similarity: 6%

More explicitly:

```text
weight =
    0.48 * activity profile similarity
  + 0.18 * shared-resource similarity
  + 0.18 * shared-context similarity
  + 0.10 * temporal proximity
  + 0.06 * size similarity
```

Supporting components:

- activity similarity
  - cosine similarity over per-case activity counts.
- resource similarity
  - Jaccard similarity over the filtered overview resource sets.
- context similarity
  - Jaccard similarity over stable attribute tokens.
- temporal similarity
  - `1 - |centerA - centerB| / datasetSpan`.
- size similarity
  - weighted ratio similarity over event count and item count.

Only pairs above `OVERVIEW_SIM_MIN = 0.34` are kept as candidates.

### 2. K-nearest-neighbor sparsification

After pairwise scoring, the graph is still too dense.

The store keeps an edge only if it is among the top `OVERVIEW_KNN = 4` weighted
edges for at least one of its endpoints.

This means the overview network is not the full similarity matrix. It is a
sparsified behavioral neighborhood graph.

### 3. Community detection

Communities are computed by `_buildOverviewCommunities()`.

The algorithm is weighted label propagation:

1. Start with each case labeled by its own ID.
2. Order nodes by descending weighted degree.
3. For at most 16 iterations:
   - inspect neighbor labels,
   - sum neighbor edge weights per label,
   - adopt the highest-scoring label.
4. Stop early if no label changes.

The resulting label groups become communities.

Community labels are then synthesized from the top two aggregated activity names
inside the group. If multiple communities get the same label, they are disambiguated
with suffixes like `A`, `B`, `C`.

### 4. Community aggregation

The overview also aggregates per-community:

- member case IDs,
- recurring resources,
- recurring context attributes,
- inter-community edge weights.

Those aggregates feed the community bubbles and the focused community side
satellites in the overview renderer.

## Variant Extraction And Activity DF Graph

The variant view is built from item-level sequences, not case-level sequences.

### 1. Sequence extraction

`_collectItemSequences()` gathers events for each item entity and reconstructs an
ordered path through that item's DF edges.

The same path tracing strategy is used here and in the detail view:

1. Sort events by timestamp and ID.
2. Build predecessor and successor maps from DF edges.
3. Start from nodes with no predecessor.
4. Walk forward through successors.
5. If there are multiple successors, follow one and queue the others.
6. Append any still-unvisited nodes at the end.

This produces a stable linearization even if the DF structure is not a strict
simple path.

### 2. Variant grouping

Each item sequence is serialized as JSON and used as a grouping key.

Variants are then ranked by:

- descending count,
- descending sequence length,
- lexicographic sequence key.

The most frequent variant is marked as dominant in the variant view.

### 3. Activity transition graph

The lower panel in the variant view is a derived activity DF graph.

It counts:

- how often each activity appears,
- the average position of that activity within item sequences,
- how often each adjacent activity transition occurs.

That graph is laid out separately from the main variant rows.

## Layout Algorithms

This is the most important part of the repository from a visualization standpoint.

There are two main layout engines:

- `overviewLayout.js`
- `detailLayout.js`

There is also a smaller layout routine for the variant view.

---

## Overview Layout Algorithm

File: `viewer/src/layout/overviewLayout.js`

The overview layout is cluster-first. It does not run a generic force-directed
simulation.

### 1. Cluster shells are built first

For each community:

- members are sorted by weighted degree, then degree, then ID,
- a cluster radius is derived from the number of members,
- resource satellites and attribute satellites are arranged around the cluster,
- an `outerRadius` is computed to include those satellites.

This means the cluster's footprint is known before the global placement starts.

### 2. Communities are placed on a spiral

The top-level overview view lays out communities one by one on a golden-angle
spiral:

- the first community is placed at the origin,
- later communities try candidate positions along a spiral,
- a candidate is accepted only if it does not collide with previously placed
  community footprints.

This gives a deterministic, collision-avoiding macro layout without requiring a
physics simulation.

### 3. Community positions are shifted into the viewport

After spiral placement, the entire arrangement is shifted so it:

- respects left and top padding,
- is horizontally centered within the available width.

### 4. Cases inside each community are arranged in concentric rings

Within each community bubble:

- the strongest case is placed at the center,
- remaining cases are placed on rings,
- each ring uses evenly spaced angular slots,
- ring radius grows by a fixed gap.

This creates a stable radial hierarchy:

- the most central case is literally central,
- less central cases move to outer rings.

### 5. Edges are drawn as curved links

Case similarity edges are converted into quadratic curves. The curvature is derived
from the source-target distance and is capped so long edges do not become too wild.

In unfocused overview mode the viewer also renders aggregate edges between
communities.

### 6. Focused community layout

When the user clicks a community, the renderer switches to a focused community
layout:

- only that community is shown,
- cases are placed around a larger central area,
- resources are placed in a left-side vertical column,
- attributes are placed in a right-side vertical column.

This turns the overview from a "graph of communities" into a "graph of cases
inside one community".

---

## Detail Layout Algorithm

File: `viewer/src/layout/detailLayout.js`

The detail layout is a case-centric swim-lane timeline.

Each case is rendered as:

- one case node on the left,
- one row per item,
- a shared time axis across all item rows,
- optional item DF edges,
- optional case DF edges,
- optional resource overlays,
- synchronization and bottleneck annotations.

### 1. Pattern analysis comes before geometry

Before any coordinates are assigned, `_analyzeEntityPatterns()` reconstructs the
activity sequence for every item in the case.

For each item it computes:

- the traced event order,
- the activity sequence,
- predecessor activities per event,
- successor activities per event.

Across all items in the case it then computes:

- the dominant item sequence,
- whether each item follows that dominant sequence,
- which events are shared by multiple items,
- contextual predecessor/successor neighborhoods for shared events.

This analytical pass directly drives three UI features:

- `Deviants only`
- `Sync only`
- sync-event tooltip context

### 2. Dominant-pattern filtering

The dominant pattern is the most frequent item sequence in the case.

Tie-breaking is:

1. higher frequency,
2. longer sequence,
3. lexicographic order.

If `Deviants only` is enabled, the layout keeps only item rows whose sequence does
not match the dominant sequence exactly.

That makes deviation detection purely sequence-based, not timing-based.

### 3. Sync-only filtering

An event becomes a sync event when the same event ID appears in the traced paths of
more than one displayed item.

If `Sync only` is enabled:

- only item rows containing at least one sync event are kept,
- those rows are forced into expanded mode,
- each row is pruned so only sync events remain visible,
- item DF edges are retained only if they touch a sync event.

So `Sync only` is not just a visual highlight. It materially changes which nodes
and edges remain in the layout.

### 4. Shared global time axis

All expanded rows in a case share one global horizontal time scale:

- gather all event timestamps across the case,
- compute global min and max,
- map each item event into that global span.

That design choice is essential:

- it preserves vertical comparability across rows,
- equal x positions mean equal or very similar timestamps,
- waiting times and cross-item coordination become visually legible.

This is the core reason the layout works as a multi-entity timeline rather than a
set of unrelated per-row sequences.

### 5. Event collision resolution

Raw time mapping can place events almost on top of each other. The layout resolves
that with a two-pass local adjustment:

1. forward pass
   - if one event is too close to the previous one, push it right.
2. backward pass
   - walk back from the end,
   - cap each event so it does not violate minimum spacing to the next one,
   - but do not pull it further left than its original ideal position if that can
     be avoided.

This is a pragmatic compromise:

- chronology is preserved,
- overlap is reduced,
- distortion stays local instead of drifting endlessly.

### 6. Item row structure

Each item row has two states:

- collapsed
  - only the item badge and summary text are shown,
  - events conceptually sit on the item node.
- expanded
  - the full timeline is rendered,
  - events are shown as circles,
  - item DF edges are drawn,
  - resources can be overlaid,
  - item attributes can be displayed as chips.

Collapsed and expanded rows coexist in the same block.

### 7. Item DF edge layout

For an expanded row, DF edges are built only when:

- both source and target events are present,
- both events belong to the same item,
- both events have positions.

Each edge gets:

- source and target IDs,
- source and target activity names,
- `gapHours`,
- `isBottleneck`,
- a rendering type:
  - `line` if the horizontal distance is normal,
  - `arc` if the events are almost vertically aligned.

This allows the detail renderer to distinguish same-time or near-same-time
transitions from ordinary horizontal progressions.

### 8. Case DF edge layout

Case-level DF edges are handled separately from item DF edges.

The algorithm:

1. collect all case DF edges for the current case,
2. keep only edges whose source and target belong to different items,
3. project source and target through the current row state:
   - expanded row -> actual event position,
   - collapsed row -> item node position,
4. draw a curved edge above the rows.

This is important because it allows cross-item progression to remain visible even
when some rows are collapsed.

### 9. Resource overlay placement

Resource overlays are optional and are only computed from event fields that contain
a meaningful `org_resource`.

For an expanded row the algorithm:

1. group events by resource,
2. place each resource at the mean x-position of its events,
3. sort resource nodes by x,
4. run a forward and backward spacing pass to keep them apart,
5. clamp them to the timeline bounds,
6. connect them back to events with dashed links.

This is effectively a secondary one-dimensional label placement step sitting above
the event row.

### 10. Sync-event annotation

After row geometry exists, `_annotateSyncEvents()` revisits every timeline node and
adds:

- `isSyncEvent`
- `syncDegree`
- `sharedEntityIds`
- `syncContexts`

`syncDegree` is then used by the renderer to enlarge the event radius and add ring
markers around the node.

The tooltip can also show, for each participating item:

- predecessor activities,
- successor activities.

That turns sync events from a binary flag into a local structural explanation.

### 11. Bottleneck detection

Bottlenecks are defined locally per focused case block.

The algorithm:

1. gather all `gapHours` values from displayed item DF edges,
2. compute the 75th percentile,
3. mark every edge above that threshold as a bottleneck.

This is not a process-mining conformance metric. It is a relative within-case wait
time heuristic.

That choice is simple but effective:

- it adapts to each case's own tempo,
- it avoids needing a fixed global threshold,
- it highlights unusually long waits in the current context.

### 12. Summary of the detail layout pipeline

For one selected case, the actual order is:

1. gather all case and item events,
2. rebuild item paths,
3. compute dominant and deviant item patterns,
4. filter rows if needed,
5. define a shared global time axis,
6. assign row heights,
7. place item events,
8. relax event spacing,
9. place resource overlays,
10. build item DF edges,
11. build case DF edges,
12. annotate sync events,
13. optionally prune to sync-only nodes,
14. detect bottlenecks,
15. return the block to the renderer.

That combination of structural preprocessing plus geometric placement is the real
heart of the viewer.

---

## Variant Layout Algorithm

The variant layout in `overviewLayout.js` is simpler than the other two.

It builds:

- a vertically stacked list of variants,
- a lower activity transition graph.

For each variant row:

- a count badge sits on the left,
- the activity sequence is rendered as colored chips,
- chip width adapts to row height and text length,
- activity chips are centered within equal-width slots across the row,
- the sequence frequency is shown on the right.

Below the rows, `computeDfGraphLayout()` places activity nodes by average sequence
position and spreads them over up to three vertical lanes. Transition edges are
drawn as gentle curves.

## Rendering And Interaction

The geometry produced by the layout modules is rendered by:

- `render/overviewRender.js`
- `render/detailRender.js`

Notable interaction behaviors:

- clicking a community enters focused community mode,
- clicking a case opens the detail view,
- clicking an item expands or collapses its row,
- clicking an event highlights that event, its lane, and incident edges,
- clicking a DF edge highlights that edge and its endpoints,
- the sidebar can filter activities, limit items, and toggle visual layers.

The camera is controlled with D3 zoom and a custom fit-to-view transform from
`render/shared.js`.

## Running The Project

### Python environment

```bash
cd bep
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
```

### Build and export

Library:

```bash
python -m pipeline.build_ekg --dataset library --yes
python -m pipeline.export_json --dataset library --output output/library.json
```

BPIC19:

```bash
python -m pipeline.build_ekg --dataset bpic19 --sample --yes
python -m pipeline.export_json --dataset bpic19 --output output/bpic19.json
```

### Run the viewer

```bash
python -m http.server 8000
```

Then open:

- `http://localhost:8000/viewer/`
- `http://localhost:8000/viewer/?dataset=library`
- `http://localhost:8000/viewer/?dataset=bpic19`

## Observed Implementation Notes And Caveats

This section documents the repository as observed, not the intended design.

### 1. `config.yaml` contains entries that are not fully backed by tracked files

`config.yaml` defines datasets for:

- `library`
- `bpic19`
- `bpic17`
- `bpic14`

But only `library` and `bpic19` semantic header files are tracked in
`data/semantic_headers/`.

So the repository is currently complete for those two datasets, not for all four
configured names.

### 2. The tracked `bpic19` output appears sample-sized

The checked-in `output/bpic19.json` is much smaller than a full BPIC19 export.

Based on its scale, it appears to come from a sample run rather than from the full
challenge dataset. That matches the existence of the `--sample` flag and the
sample IDs in `bpic19_DS.json`.

This is an inference from the tracked output size and counts.

### 3. Event properties in the tracked bundles are effectively empty

The current export query for events returns only `activity`, `timestamp`, and the
remaining event node properties. In the tracked `library.json` and `bpic19.json`
output bundles, those remaining event properties are empty.

That has downstream consequences:

- resource extraction from `org_resource` does not activate,
- context-token similarity in the overview has little or no signal,
- PO/item attribute chips derived from event fields remain empty.

So, in the repository's current exported bundles, the overview similarity graph is
driven mostly by activity profiles, timing, and case size, even though the code is
written to support richer resource and context features.

This also exposes a model mismatch in the current frontend:

- BPIC19 resources exist as correlated entity nodes,
- but the resource overlay and resource color logic currently read `org_resource`
  from event fields,
- so entity-based resources do not automatically become visual resource overlays.

### 4. DF edges in the tracked bundles have empty `entity_id`

The tracked output bundles contain DF edges with a meaningful `entity_type`, but
their `entity_id` field is empty.

That matters because the frontend indexes DF edges by `entity_id`:

- `dfItemByEntity[entity_id]`
- `dfPoByPo[entity_id]`

If `entity_id` is empty, per-entity DF lookup is weakened or lost in the viewer.
This is one of the first places to inspect if item or case DF edges appear to be
missing in the detail view.

### 5. Entity type export can collapse multi-label entities

`export_json.py` infers `entity_type` from the first label that is not `Entity`.

For entities with more than one non-Entity label, such as a resource that is both
`Resource` and `HumanResource`, the exported type may become the generic label
instead of the more specific one.

This explains why entity exports and DF exports may not use exactly the same type
names.

### 6. `check_neo4j.py` checks the default database, not a dataset database

The helper script verifies connectivity and prints counts from a generic session.
That is useful for availability checks, but it is not a precise validation of the
dataset-specific databases used by the pipeline.

### 7. Internal naming still reflects an older purchase-order model

Many frontend variables use names like:

- `po`
- `poitem`
- `eventsByPo`

Those are generic case/item roles now, not strict purchase-order semantics.
Anyone extending the code should read them as historical names, not as hard
requirements.

## Recommended Reading Order For Future Contributors

If you want to understand the repository quickly, read the files in this order:

1. `pipeline/build_ekg.py`
2. `pipeline/export_json.py`
3. `viewer/src/data/store.js`
4. `viewer/src/layout/detailLayout.js`
5. `viewer/src/layout/overviewLayout.js`
6. `viewer/src/render/detailRender.js`
7. `viewer/src/render/overviewRender.js`

That sequence follows the actual data flow from raw data to final geometry.

## Bottom Line

This project is best understood as a three-stage system:

1. semantic graph construction in Neo4j,
2. graph flattening into a transport bundle,
3. client-side re-derivation of structure for layout and interaction.

The most distinctive part of the implementation is the viewer's layout logic:

- the overview uses behavioral similarity plus weighted label propagation to turn
  cases into communities,
- the detail view uses a shared time axis, dominant-pattern analysis,
  synchronization detection, and local spacing relaxation to produce a readable
  multi-entity timeline,
- the variant view compresses item behavior into sequence rows and a derived
  activity transition graph.

That layout stack is where most of the analytical value of the repository lives.
