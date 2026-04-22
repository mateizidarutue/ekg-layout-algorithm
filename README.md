# Event Knowledge Graph Layout Prototype

This repository is the evaluation artifact for a thesis on layout algorithms for Event Knowledge Graphs (EKGs).

It contains:

- a Python pipeline that builds typed EKGs in Neo4j through PromG,
- a JSON export layer that turns the graph into a viewer bundle,
- a browser-based prototype that supports overview, variant, and multi-entity detail analysis.

The repository is organized around one core idea: flat case-centric process views are not enough for object-centric processes such as purchase orders with items, or members borrowing multiple books. The prototype therefore treats an execution as a typed graph of interacting entities and visualizes it with layouts that preserve both time and cross-entity structure.

## Thesis Alignment

The prototype is built to address the thesis problem statement: how to lay out EKGs so that users can understand interacting entities, shared events, and process variants without collapsing the process back into a single-case log.

The current implementation aligns with that goal in three ways:

1. It builds a typed EKG, not a flat log.
   Events, entities, correlations, directly-follows edges, and structural entity-to-entity relations are all preserved.

2. It separates analysis into three coordinated views.
   The overview shows communities of similar cases, the variant view focuses on dominant item-level behavior, and the detail view shows a local multi-entity slice around one selected entity.

3. It emphasizes the layout requirements from the thesis.
   The detail view uses one horizontal time axis, one band per entity type, one lane per entity instance, explicit shared-event guides, clustered shared-event markers at the top, and optional DF and structural relation layers.

In practical terms, the prototype supports:

- locating and opening an arbitrary entity,
- inspecting its local multi-entity context,
- seeing where events are shared across entity timelines,
- grouping similar cases into communities,
- grouping similar item traces into variants,
- drilling from overview or variants into detail.

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

- `http://localhost:8000/viewer/?dataset=library`
- `http://localhost:8000/viewer/?dataset=bpic19`

If you open `http://localhost:8000/viewer/` with no query parameter, the viewer defaults to `library`.

## Fastest Evaluation Path

If the JSON bundles already exist and you only want to inspect the prototype:

```powershell
.\.venv\Scripts\Activate.ps1
python -m http.server 8000
```

Then open the dataset URL directly.

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
5. renders SVG and interactive sidebar panels.

The main analytical frontend files are:

- [viewer/src/data/store.js](viewer/src/data/store.js)
- [viewer/src/layout/detailLayout.js](viewer/src/layout/detailLayout.js)
- [viewer/src/layout/overviewLayout.js](viewer/src/layout/overviewLayout.js)

## Prototype Views

### Overview and community view

The overview is case-oriented.

It:

- summarizes each case,
- computes pairwise case similarity,
- sparsifies the graph with k-nearest-neighbor retention,
- groups cases into communities through weighted label propagation,
- lays communities out deterministically,
- allows drill-down into one community and then into one case.

This view answers:

- which cases behave similarly,
- how the dataset splits into behavioral regions,
- which communities deserve detailed inspection.

### Variants view

The variants view is item-oriented.

It:

- reconstructs item-level traces,
- groups identical sequences into variants,
- ranks them by frequency,
- shows a lower activity transition graph,
- exposes variant-level statistics in the sidebar,
- lists the members and items that belong to a selected variant.

This is where the prototype now places dominant behavior analysis.

### Detail view

The detail view is the main multi-entity inspection surface.

It opens from a selected entity and builds a local typed slice around that entity.

Depending on the anchor type, the scope is specialized:

- case/member anchor -> overlap-only case focus,
- item/book anchor -> overlap-only item focus,
- generic anchor -> local neighborhood.

The sidebar changes dynamically in detail mode and includes:

- shared-only filtering,
- max entities per type,
- visible entity-type toggles,
- edge-layer toggles,
- shared-event hotspot list,
- cluster-specific activity filtering for mixed shared-event clusters.

## Layout Algorithms

This is the core contribution of the prototype.

### Overview layout

The overview combines an analytical graph model with a deterministic spatial layout.

Analytical phase:

- activity cosine similarity: 48%
- resource Jaccard similarity: 18%
- context Jaccard similarity: 18%
- temporal similarity: 10%
- size similarity: 6%

Then:

- only strong enough similarities are kept,
- each case keeps only its local strongest neighbors,
- weighted label propagation produces communities.

Spatial phase:

- communities are placed first,
- community members are arranged inside their shells,
- focused community mode exposes resources and attributes as side satellites.

This avoids using an unconstrained force layout and produces a more stable analytical overview.

### Variant layout

The variant view reconstructs ordered item traces from DF edges, groups identical sequences, and renders:

- a ranked list of variants,
- a lower activity DF graph positioned by average activity position in the trace.

This view supports thesis-level process comparison at the item lifecycle level.

### Detail layout

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

The prototype is designed as a drill-down workflow:

1. start in overview,
2. inspect a community,
3. open a case or item,
4. inspect the multi-entity detail slice,
5. use the back button to return to the originating view.

The sidebar is view-aware:

- overview/community -> summary of communities and cases,
- variants -> variant statistics and member/item membership,
- detail -> detail summary, filters, hotspots, legend, and cluster activity controls.

The canvas is also keyboard navigable:

- arrows or `WASD` to pan,
- `+` and `-` to zoom,
- `F` to fit,
- `0` to reset.

## What To Read In The Code

If you want to understand the repository quickly, read these files in order:

1. [pipeline/build_ekg.py](pipeline/build_ekg.py)
2. [pipeline/export_json.py](pipeline/export_json.py)
3. [viewer/src/data/store.js](viewer/src/data/store.js)
4. [viewer/src/layout/detailLayout.js](viewer/src/layout/detailLayout.js)
5. [viewer/src/layout/overviewLayout.js](viewer/src/layout/overviewLayout.js)
6. [viewer/src/render/detailRender.js](viewer/src/render/detailRender.js)
7. [viewer/src/render/overviewRender.js](viewer/src/render/overviewRender.js)

That sequence matches the actual data flow from raw records to visual layout.

## Current Constraints

- Supported end-to-end datasets in the repository: `library`, `bpic19`
- BPIC19 should be viewed through a sampled export, not the full browser bundle
- `scripts/check_neo4j.py` checks connectivity against the default database, not a dataset database
- The viewer is static and browser-only; it does not query Neo4j directly at runtime

## Summary

This repository is a full prototype pipeline for thesis-driven EKG analysis:

- semantic dataset descriptions define the graph,
- PromG builds the EKG in Neo4j,
- Python exports a typed JSON bundle,
- the browser reconstructs analytical structure and computes the layouts,
- overview, variants, and detail views support different levels of process understanding.

The main technical focus is the layout stack, especially the detail view: typed entity bands, a shared timeline, clustered shared-event rendering, per-entity DF structure, and interactive filtering for mixed shared-event clusters.
