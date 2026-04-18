"""
Build the EKG for a dataset using PromG v0.1.25.

Usage:
    python -m pipeline.build_ekg --dataset library [--sample] [--yes]
"""

import argparse
import json
import os
import platform
import shutil
import sys
import tempfile
import time
from pathlib import Path

from pipeline.config_loader import load_config, get_dataset_config


def _junction(source: Path, target: Path) -> None:
    """Create a directory junction (Windows) or symlink (Unix) from target → source."""
    if platform.system() == "Windows":
        import subprocess
        result = subprocess.run(
            ["cmd", "/c", "mklink", "/J", str(target), str(source)],
            capture_output=True,
        )
        if result.returncode != 0:
            shutil.copytree(str(source), str(target))
    else:
        try:
            os.symlink(str(source), str(target), target_is_directory=True)
        except OSError:
            shutil.copytree(str(source), str(target))


def _setup_data_in_tmpdir(ds_desc_path: Path, repo_root: Path, tmpdir: str) -> None:
    """
    ImportedDataStructures resolves file_directory relative to os.getcwd().
    Create junctions inside tmpdir so those relative paths resolve correctly.
    """
    try:
        with open(ds_desc_path) as f:
            ds_descs = json.load(f)
    except Exception:
        return

    seen: set[str] = set()
    for entry in ds_descs:
        fname = entry.get("file_name") or (entry.get("file_names") or [None])[0]
        fdir = entry.get("file_directory", "").replace("\\", "/").strip("/")
        if not fname or fdir in seen:
            continue
        seen.add(fdir)

        link = Path(tmpdir) / fdir
        if link.exists():
            continue

        # Find the directory that actually contains fname
        candidates = [
            repo_root / fdir,
            repo_root / "data" / "raw",
            repo_root / "data",
        ]
        source = next((c for c in candidates if (c / fname).exists()), None)
        if source is None:
            print(f"  WARNING: Could not find source directory for '{fdir}/{fname}'",
                  file=sys.stderr)
            continue

        link.parent.mkdir(parents=True, exist_ok=True)
        _junction(source, link)
        print(f"  Data link: {link} → {source}")


def run(dataset_name: str, use_sample: bool = False, yes: bool = False) -> None:
    repo_root = Path(__file__).parent.parent
    config = load_config(repo_root / "config.yaml")
    neo4j = config["neo4j"]
    ds = get_dataset_config(config, dataset_name)

    sem_header_path = repo_root / ds["semantic_header"]
    ds_desc_path = repo_root / ds["dataset_description"]

    if not sem_header_path.exists():
        print(f"ERROR: Semantic header not found: {sem_header_path}", file=sys.stderr)
        sys.exit(1)
    if not ds_desc_path.exists():
        print(f"ERROR: Dataset description not found: {ds_desc_path}", file=sys.stderr)
        sys.exit(1)

    if not yes:
        answer = input(
            f"This will WIPE the Neo4j database '{ds['database']}' and rebuild it. Continue? [y/N] "
        )
        if answer.strip().lower() != "y":
            print("Aborted.")
            sys.exit(0)

    # Create a tmpdir whose CWD will satisfy ImportedDataStructures' relative file_directory lookups
    tmpdir = tempfile.mkdtemp(prefix="promg_")
    _setup_data_in_tmpdir(ds_desc_path, repo_root, tmpdir)

    orig_dir = os.getcwd()
    os.chdir(tmpdir)

    try:
        from promg import DatabaseConnection, SemanticHeader, ImportedDataStructures
        from promg.database_managers.EventKnowledgeGraph import EventKnowledgeGraph

        print(f"Connecting to Neo4j at {neo4j['uri']} (database: {ds['database']})...")
        db_connection = DatabaseConnection(
            uri=neo4j["uri"],
            db_name=ds["database"],
            user=neo4j["user"],
            password=str(neo4j["password"]),
        )

        semantic_header = SemanticHeader.create_semantic_header(sem_header_path)
        dataset_descriptions = ImportedDataStructures(ds_desc_path)

        ekg = EventKnowledgeGraph(
            db_connection=db_connection,
            db_name=ds["database"],
            specification_of_data_structures=dataset_descriptions,
            perf_path=tmpdir,
            semantic_header=semantic_header,
            batch_size=5000,
            use_sample=use_sample,
            use_preprocessed_files=False,
        )

        print("Clearing database...")
        ekg.clear_db()
        ekg.set_constraints()

        print("Importing raw data...")
        t0 = time.time()
        ekg.import_data()

        print("Creating nodes...")
        ekg.create_nodes()

        print("Creating relations...")
        ekg.create_relations()

        print("Creating DF edges...")
        ekg.create_df_edges()

        elapsed = time.time() - t0
        print(f"\nBuild complete in {elapsed:.1f}s")
        ekg.print_statistics()
        db_connection.close_connection()

    finally:
        os.chdir(orig_dir)
        try:
            shutil.rmtree(tmpdir, ignore_errors=True)
        except Exception:
            pass


def main() -> None:
    parser = argparse.ArgumentParser(description="Build EKG via PromG v0.1.25")
    parser.add_argument("--dataset", required=True, help="Dataset name from config.yaml")
    parser.add_argument("--sample", action="store_true", help="Use sample mode")
    parser.add_argument("--yes", action="store_true", help="Skip confirmation prompt")
    args = parser.parse_args()

    run(args.dataset, use_sample=args.sample, yes=args.yes)


if __name__ == "__main__":
    main()
