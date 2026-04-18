"""Loads and validates config.yaml."""

import yaml
from pathlib import Path


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

    return config


def get_dataset_config(config: dict, dataset_name: str) -> dict:
    datasets = config.get("datasets", {})
    if dataset_name not in datasets:
        available = ", ".join(datasets.keys())
        raise ValueError(
            f"Dataset '{dataset_name}' not found in config.yaml. "
            f"Available: {available}"
        )
    ds = datasets[dataset_name]

    required = ["raw_data", "semantic_header", "database"]
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
