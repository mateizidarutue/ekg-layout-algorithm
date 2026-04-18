"""Diagnostic: verify Neo4j connection and print server version."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from pipeline.config_loader import load_config

def main():
    config = load_config(Path(__file__).parent.parent / "config.yaml")
    neo4j = config["neo4j"]

    try:
        from neo4j import GraphDatabase
    except ImportError:
        print("ERROR: neo4j driver not installed. Run: pip install neo4j", file=sys.stderr)
        sys.exit(1)

    uri = neo4j["uri"]
    auth = (neo4j["user"], str(neo4j["password"]))

    print(f"Connecting to {uri}...")
    driver = GraphDatabase.driver(uri, auth=auth)

    try:
        driver.verify_connectivity()
    except Exception as e:
        print(f"ERROR: Connection failed: {e}", file=sys.stderr)
        sys.exit(1)

    with driver.session() as session:
        version = session.run("CALL dbms.components() YIELD versions RETURN versions[0] AS v").single()["v"]
        counts = session.run(
            "MATCH (n) RETURN DISTINCT labels(n) AS labels, count(*) AS cnt ORDER BY cnt DESC LIMIT 10"
        ).data()

    driver.close()

    print(f"Neo4j {version} — connection OK")
    if counts:
        print("\nNode counts in default database:")
        for row in counts:
            print(f"  {row['labels']}: {row['cnt']:,}")
    else:
        print("(No nodes in default database)")


if __name__ == "__main__":
    main()
