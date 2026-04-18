# Semantic Headers

Place PromG v0.1.25 semantic header JSON files here.

Each dataset needs two files:
- `<dataset>.json` — the semantic header (defines entity types, mappings)
- `<dataset>_DS.json` — the dataset description (defines raw data file locations and format)

| Dataset | Semantic header | Dataset description |
|---------|----------------|---------------------|
| library | library.json | library_DS.json |
| bpic19 | bpic19.json | bpic19_DS.json |
| bpic17 | bpic17.json | bpic17_DS.json |
| bpic14 | bpic14.json | bpic14_DS.json |

These files ship with the PromG Zenodo bundle (DOI 10.5281/zenodo.8296559).
The raw log files go in `data/raw/` (gitignored).
