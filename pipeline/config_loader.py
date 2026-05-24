"""Loads and validates config.yaml.

Any string value of the form ``${VAR_NAME}`` or ``${VAR_NAME:-default}`` is
expanded against the process environment at load time. This lets secrets such
as the Neo4j password live in environment variables instead of the YAML file.
"""

import os
import re
import yaml
from pathlib import Path

_ENV_REF_RE = re.compile(r"\$\{([A-Z_][A-Z0-9_]*)(?::-(.*?))?\}")


def _expand_env(value):
    """Replace ``${VAR}`` / ``${VAR:-default}`` references with env values."""
    if isinstance(value, str):
        def repl(match):
            name = match.group(1)
            default = match.group(2)
            resolved = os.environ.get(name)
            if resolved is not None:
                return resolved
            if default is not None:
                return default
            raise ValueError(
                f"Environment variable '{name}' referenced in config.yaml is not set "
                f"and has no default. Set it (e.g. `export {name}=...`) or supply "
                f"a default in the form '${{{name}:-fallback}}'."
            )
        return _ENV_REF_RE.sub(repl, value)
    if isinstance(value, dict):
        return {k: _expand_env(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_expand_env(v) for v in value]
    return value


def load_config(config_path: str = "config.yaml") -> dict:
    path = Path(config_path)
    if not path.exists():
        raise FileNotFoundError(f"Config file not found: {path.absolute()}")

    with open(path) as f:
        config = yaml.safe_load(f)

    if "neo4j" not in config:
        raise ValueError("config.yaml missing 'neo4j' section")
    if "datasets" not in config:
        raise ValueError("config.yaml missing 'datasets' section")

    return _expand_env(config)


def get_dataset_config(config: dict, dataset_name: str) -> dict:
    datasets = config.get("datasets", {})
    if dataset_name not in datasets:
        available = ", ".join(datasets.keys())
        raise ValueError(
            f"Dataset '{dataset_name}' not found in config.yaml. "
            f"Available: {available}"
        )
    ds = datasets[dataset_name]

    required = ["semantic_header", "database"]
    for field in required:
        if field not in ds:
            raise ValueError(
                f"Dataset '{dataset_name}' missing required field '{field}' in config.yaml"
            )

    # dataset_description defaults to semantic_header if not specified
    if "dataset_description" not in ds:
        ds = dict(ds)
        ds["dataset_description"] = ds["semantic_header"]

    return ds
