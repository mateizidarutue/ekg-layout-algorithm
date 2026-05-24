# Smoke tests

A small handful of lightweight smoke tests covering the highest-risk areas: the
new EKG Atlas layout, the cleaned-up detail layout config, and the env-var
expansion in `config_loader.py`.

These are intentionally **smoke tests**, not a full suite. Their purpose is to
catch obvious regressions after refactoring, not to specify behaviour.

## Running

JavaScript (Node ≥ 18):

    node bep/tests/test_atlas.mjs

Python (any 3.x):

    python -m unittest bep/tests/test_config_loader.py

Both runners exit with a non-zero status on failure, so they slot into a CI
matrix without any extra wiring.

## What's covered

| File                       | Surface area                                                                 |
| -------------------------- | ---------------------------------------------------------------------------- |
| `test_atlas.mjs`           | `computeAtlasLayout` (panel stacking, node bounds, stream conservation, edge anchoring), `LAYOUT_CONFIG` shape & legacy export parity |
| `test_config_loader.py`    | `${VAR}` and `${VAR:-default}` expansion, recursive dict/list expansion, missing-var error, full `load_config` round trip            |

Add tests by appending `test(...)` calls or `unittest.TestCase` methods —
no test framework is required.
