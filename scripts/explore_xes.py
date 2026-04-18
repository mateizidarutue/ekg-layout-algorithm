"""Inspect attribute names and value distributions in an XES log."""

import sys
import xml.etree.ElementTree as ET
from collections import Counter
from pathlib import Path


def explore(xes_path: str, max_values: int = 10) -> None:
    path = Path(xes_path)
    if not path.exists():
        print(f"File not found: {path}", file=sys.stderr)
        sys.exit(1)

    print(f"Parsing {path}...")
    tree = ET.parse(path)
    root = tree.getroot()

    ns = ""
    if root.tag.startswith("{"):
        ns = root.tag.split("}")[0] + "}"

    traces = root.findall(f"{ns}trace")
    print(f"Traces: {len(traces):,}")

    trace_attrs: dict[str, Counter] = {}
    event_attrs: dict[str, Counter] = {}

    def collect(node, store):
        for child in node:
            key = child.get("key")
            val = child.get("value")
            if key and val is not None:
                if key not in store:
                    store[key] = Counter()
                store[key][val] += 1

    total_events = 0
    for trace in traces:
        collect(trace, trace_attrs)
        for child in trace:
            tag = child.tag.replace(ns, "")
            if tag == "event":
                total_events += 1
                collect(child, event_attrs)

    print(f"Events:  {total_events:,}\n")

    for label, attrs in [("TRACE ATTRIBUTES", trace_attrs), ("EVENT ATTRIBUTES", event_attrs)]:
        print(f"── {label} ──")
        for key in sorted(attrs):
            vals = attrs[key]
            unique = len(vals)
            top = vals.most_common(max_values)
            preview = ", ".join(f"{v!r}({c})" for v, c in top)
            if unique > max_values:
                preview += f", ... ({unique} unique)"
            print(f"  {key:40s}  {preview}")
        print()


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(f"Usage: python {sys.argv[0]} <file.xes> [max_values]")
        sys.exit(1)
    max_v = int(sys.argv[2]) if len(sys.argv) > 2 else 10
    explore(sys.argv[1], max_v)
