#!/usr/bin/env python3
"""Synchronization-degree distribution of shared events, per dataset.

For each exported EKG bundle in ``output/`` this computes how many distinct
entities every event is correlated to — its *synchronization degree* — after the
viewer's co-temporal event merge, and renders one log-scale bar chart per dataset
for the thesis evaluation chapter.

The script is a standalone, read-only replication of the relevant logic in
``viewer/src/data/store.js`` so the figure matches exactly what the running
viewer reports (e.g. the home-screen event count). It never runs the pipeline and
never imports or modifies any viewer/ or pipeline code. The only third-party
dependency is matplotlib.

Methodology (mirrors store.js):
  1. Case lens — ``detect_case_lens`` reproduces ``_detectCaseItemLens``: the case
     entity type is the source of a HAS_ITEM relation (BPIC19), else the *target* of
     a reified CASE_* relation (BPIC17, preferring CASE_AW — the case object that
     owns the sub-process), else a PO/POItem or smallest-entity-count fallback.
     ``build_reattribution`` then maps each sub-process (item) entity to its owning
     case via the same relation, so item-only events still belong to a case.
  2. Co-temporal merge — ``analyze`` reproduces ``_computeEventMerge``: events are
     grouped by the key (epoch_ms, activity, sorted set of case-type entity ids,
     with item-only events re-attributed to their case), and each group becomes one
     merged event. This collapses the per-child event explosion of HAS_ITEM
     hierarchies (e.g. a purchase order with N line items emits N events at the same
     instant) and the per-sub-process events that share a case timestamp.
  3. Degree — for each merged event the synchronization degree is the number of
     distinct entities correlated to any member of the group (``_applyEventMerge
     ToCorr`` unions the memberships). Corr edges count only when both their event
     and entity exist in the bundle. A *shared event* has degree >= 2.
  4. Timestamps — ``js_epoch_ms`` matches ``new Date(ts).getTime()``: fractional
     seconds are truncated to milliseconds and the timezone offset is applied, so
     the grouping key is byte-identical to the viewer's.

Usage:
    python analysis/sync_degree_figure.py

Outputs:
  - figures/eval_syncdeg.png — a single figure with two stacked panels (BPIC19
    over BPIC17): x = synchronization degree, y = number of shared events on a
    log axis with each bar's exact count annotated. The panels share x/y limits so
    the datasets are directly comparable, and the figure carries no title (the
    LaTeX caption supplies it).
  - A per-dataset summary on stdout: detected case type, merged event count,
    shared-event count and percentage, and the maximum synchronization degree.
"""

import datetime as dt
import json
import math
import re
import sys
from collections import defaultdict
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

REPO_ROOT = Path(__file__).resolve().parent.parent
OUTPUT_DIR = REPO_ROOT / "output"
FIGURE_DIR = REPO_ROOT / "figures"

DATASETS = ("bpic19", "bpic17")  # render order: top panel, bottom panel
DISPLAY = {"bpic19": "BPIC19 (procurement)", "bpic17": "BPIC17 (loan)"}
BAR_COLOR = "#4c72b0"  # single muted blue, shared across both panels

# store.js GENERIC_LABELS — used by the primary_type fallback only.
GENERIC_LABELS = {"Entity", "Resource", "EntityAttribute"}

_TS_RE = re.compile(
    r"^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})"
    r"(?:\.(\d+))?"
    r"(Z|[+-]\d{2}:?\d{2}|[+-]\d{2})?$"
)


def js_epoch_ms(ts):
    """Replicate `new Date(ts).getTime()`: epoch milliseconds with fractional
    seconds truncated to 3 digits and the timezone offset applied. Returns None
    for an unparseable timestamp (the viewer keeps such events unmerged)."""
    if not ts:
        return None
    m = _TS_RE.match(ts.strip())
    if not m:
        return None
    year, month, day, hour, minute, second = (int(m.group(i)) for i in range(1, 7))
    frac = m.group(7) or ""
    ms = int((frac + "000")[:3]) if frac else 0
    tz = m.group(8)
    # Treat the wall-clock components as UTC, then back out the stated offset so
    # the result is a true epoch (matching JS Date semantics).
    base = dt.datetime(year, month, day, hour, minute, second, tzinfo=dt.timezone.utc)
    epoch = int(base.timestamp()) * 1000 + ms
    if tz and tz != "Z":
        sign = 1 if tz[0] == "+" else -1
        digits = tz[1:].replace(":", "")
        offset_h = int(digits[:2])
        offset_m = int(digits[2:4]) if len(digits) >= 4 else 0
        epoch -= sign * (offset_h * 3600 + offset_m * 60) * 1000
    return epoch


def infer_primary_type(labels, fallback="Entity"):
    """store.js _inferPrimaryType — only used when primary_type is absent."""
    typed = list(dict.fromkeys(label for label in (labels or []) if label))
    specific = sorted(label for label in typed if label not in GENERIC_LABELS)
    if specific:
        return specific[0]
    generic = sorted(label for label in typed if label != "Entity")
    if generic:
        return generic[0]
    return fallback


def detect_case_lens(relations, df, entity_ids_by_type):
    """store.js _detectCaseItemLens — returns (case_type, item_type, lens_source).

    lens_source identifies which rule fired:
      "HAS_ITEM" — explicit parent->child hierarchy (BPIC19): case = HAS_ITEM
                   source, item = target.
      "CASE"     — reified CASE_* relation (BPIC17): the relation links a
                   sub-process (source, Workflow) to the case object that owns it
                   (target, Application). The case object is the primary entity,
                   so case = target, item = source. Item-only events are attributed
                   to the case via build_reattribution / analyze.
      "PO" / "COUNT" — fallbacks.
    """
    has_item = [r for r in relations if r.get("relation_type") == "HAS_ITEM"]
    if has_item:
        return has_item[0]["source_entity_type"], has_item[0]["target_entity_type"], "HAS_ITEM"

    reified = [r for r in relations if str(r.get("relation_type", "")).startswith("CASE_")]
    if reified:
        preferred = next((r for r in reified if r.get("relation_type") == "CASE_AW"), reified[0])
        return preferred["target_entity_type"], preferred["source_entity_type"], "CASE"

    df_types = {e.get("entity_type") for e in df if e.get("entity_type")}
    if "PO" in df_types or "POItem" in df_types:
        return "PO", "POItem", "PO"

    counts = {t: len(ids) for t, ids in entity_ids_by_type.items()}
    pool = list(df_types) if df_types else list(counts.keys())
    candidates = sorted((t for t in pool if counts.get(t)), key=lambda t: (counts[t], t))
    case = candidates[0] if candidates else "Case"
    item = candidates[1] if len(candidates) > 1 else case
    return case, item, "COUNT"


def build_reattribution(relations, case_type, item_type):
    """store.js _buildCaseReattributionMap — maps each item (sub-process) entity id
    to its owning case entity id via the structural CASE_* relation, so events that
    correlate only to the item can still be attributed to the case. Empty unless a
    reified CASE_* lens is in play."""
    mapping = {}
    if case_type == item_type:
        return mapping
    for rel in relations:
        if not str(rel.get("relation_type", "")).startswith("CASE_"):
            continue
        if rel.get("source_entity_type") == item_type and rel.get("target_entity_type") == case_type:
            mapping[str(rel["source_entity_id"])] = str(rel["target_entity_id"])
        elif rel.get("target_entity_type") == item_type and rel.get("source_entity_type") == case_type:
            mapping[str(rel["target_entity_id"])] = str(rel["source_entity_id"])
    return mapping


def analyze(bundle):
    """Replicate the post-merge synchronization degree for every merged event."""
    # ── entities: primary_type lookup + per-type id index ────────────────────
    primary_by_id = {}
    entity_ids_by_type = defaultdict(list)
    for entity in bundle.get("entities", []):
        eid = str(entity["entity_id"])
        primary = entity.get("primary_type") or infer_primary_type(
            entity.get("labels"), entity.get("entity_type") or "Entity"
        )
        primary_by_id[eid] = primary
        entity_ids_by_type[primary].append(eid)

    case_type, item_type, lens_source = detect_case_lens(
        bundle.get("relations", []), bundle.get("df", []), entity_ids_by_type
    )
    # Viewer-faithful: buildStore always runs the co-temporal merge with the
    # detected case lens, so we do the same here. BPIC19's HAS_ITEM hierarchy
    # collapses the line-item explosion (14,010 -> 9,512). BPIC17's case is the
    # Application; its Workflow sub-process events are re-attributed to their
    # Application via CASE_AW (below), and the merge collapses 2,769 co-temporal
    # events (22,716 -> 19,947). Both match the app's home-screen event counts.
    reattribution = build_reattribution(bundle.get("relations", []), case_type, item_type)

    events = bundle.get("events", [])
    event_ids = {str(ev["event_id"]) for ev in events}

    # ── corr: keep only edges whose event AND entity exist (store.js:402) ─────
    corr_entities = defaultdict(set)   # event_id -> {entity_id}            (degree)
    case_entities = defaultdict(set)   # event_id -> {case-type entity_id}  (merge key)
    item_entities = defaultdict(set)   # event_id -> {item-type entity_id}  (re-attribution)
    for edge in bundle.get("corr", []):
        ev = str(edge["event_id"])
        en = str(edge["entity_id"])
        if ev not in event_ids or en not in primary_by_id:
            continue
        corr_entities[ev].add(en)
        if primary_by_id[en] == case_type:
            case_entities[ev].add(en)
        elif primary_by_id[en] == item_type:
            item_entities[ev].add(en)

    # ── co-temporal merge: group events by (date_ms, activity, caseKey) ──────
    groups = defaultdict(list)  # key -> [event_id, ...]
    for ev in events:
        eid = str(ev["event_id"])
        epoch = js_epoch_ms(ev.get("timestamp"))
        if epoch is None:
            groups[f"UNIQ|{eid}"].append(eid)
            continue
        case_ids = sorted(case_entities.get(eid, ()))
        if not case_ids:  # item-only event: attribute to its owning case via CASE_*
            case_ids = sorted({reattribution[i] for i in item_entities.get(eid, ())
                               if i in reattribution})
        case_key = ",".join(case_ids) if case_ids else f"_nocase_{eid}"
        groups[f"{epoch}|{ev.get('activity', '')}|{case_key}"].append(eid)

    # ── degree per merged event = distinct entities unioned over the group ───
    degrees = []
    for members in groups.values():
        union = set()
        for eid in members:
            union |= corr_entities.get(eid, set())
        degrees.append(len(union))

    return {
        "case_type": case_type,
        "lens_source": lens_source,
        "merged": len(degrees),
        "shared": sum(1 for d in degrees if d >= 2),
        "max_degree": max(degrees) if degrees else 0,
        "degrees": degrees,
    }


def shared_degree_counts(degrees):
    """Histogram of synchronization degree restricted to shared events (deg>=2)."""
    counts = defaultdict(int)
    for d in degrees:
        if d >= 2:
            counts[d] += 1
    return counts


def render_figure(results):
    """Single figure, two stacked panels (BPIC19 over BPIC17) sharing x/y axes so
    the distributions are directly comparable.

    The y-axis is logarithmic so that both the bulk (thousands of events at low
    degree) and the long, thin tail (high-degree bars holding only a handful of
    events) are visible at once. A log axis encodes equal ratios as equal pixel
    distances rather than equal counts, so to keep that from misleading the reader
    every bar is also annotated with its exact count.
    """
    FIGURE_DIR.mkdir(parents=True, exist_ok=True)
    counts_by_name = {name: shared_degree_counts(r["degrees"]) for name, r in results.items()}

    max_degree = max(r["max_degree"] for r in results.values())
    max_count = max((max(c.values()) if c else 1) for c in counts_by_name.values())

    fig, axes = plt.subplots(2, 1, figsize=(8, 7), sharex=True, sharey=True)
    for ax, name in zip(axes, DATASETS):
        counts = counts_by_name[name]
        xs = sorted(counts)
        ys = [counts[x] for x in xs]
        bars = ax.bar(xs, ys, width=0.85, color=BAR_COLOR, edgecolor="none")
        ax.set_yscale("log")
        ax.set_ylabel("Number of shared events")
        ax.spines["top"].set_visible(False)
        ax.spines["right"].set_visible(False)
        # Exact count above every bar so the log axis (equal ratios, not equal
        # counts) can't mislead — the tail bars hold only 1-9 events.
        ax.bar_label(bars, labels=[f"{v:,}" for v in ys], padding=2,
                     fontsize=7, rotation=90)
        # Panel identifier (top-right, clear of the bars) instead of a title.
        ax.text(0.99, 0.94, DISPLAY[name], transform=ax.transAxes,
                ha="right", va="top", fontsize=10, fontweight="bold")

    axes[0].set_xlim(1.5, max_degree + 0.5)
    # One decade of headroom above the tallest bar for the rotated count labels.
    axes[0].set_ylim(0.8, 10 ** (math.ceil(math.log10(max_count)) + 1))
    axes[-1].set_xlabel("Synchronization degree")
    fig.tight_layout()
    out_path = FIGURE_DIR / "eval_syncdeg.png"
    fig.savefig(out_path, dpi=150, bbox_inches="tight")
    plt.close(fig)
    return out_path


def main():
    results = {}
    for name in DATASETS:
        path = OUTPUT_DIR / f"{name}.json"
        if not path.exists():
            sys.exit(f"ERROR: missing bundle {path}")
        with open(path, encoding="utf-8") as handle:
            results[name] = analyze(json.load(handle))

    for name in DATASETS:
        r = results[name]
        pct = 100.0 * r["shared"] / r["merged"] if r["merged"] else 0.0
        print(f"[{name}] case_type = {r['case_type']} "
              f"(lens={r['lens_source']}, co-temporal merge applied)")
        print(f"  merged events  : {r['merged']:,}")
        print(f"  shared (deg>=2): {r['shared']:,} ({pct:.2f}%)")
        print(f"  max degree     : {r['max_degree']}")

    out_path = render_figure(results)
    print(f"\nWrote {out_path}")


if __name__ == "__main__":
    main()
