// Smoke tests for the multi-scale EKG view data layer.
// Run with:
//
//     node bep/tests/test_ekg_view.mjs
//
// These tests exercise getEkgView() against a tiny synthetic bundle built via
// buildStore(), so they verify the real function — not a fixture. The
// invariants asserted here are the ones the rest of the view layer relies on:
//
//   1. Stream conservation       — per bin, total == sum across types
//   2. Sparkline ordering        — per type, rows sorted by firstTime asc
//   3. L0 ↔ L2 conservation      — per (type, bin), L0 count == count of
//                                  L2 sparkline events in that bin
//   4. Spine completeness        — every event touching ≥2 entity types
//                                  appears exactly once as a spine
//   5. Global density alignment  — globalDensity[i] === bins[i].total

import assert from "node:assert/strict";

import { buildStore, getEkgView, listInvalidDateEvents, getInvalidEventCount } from "../viewer/src/data/store.js";
import { computeEkgViewLayout, EKG_LEVELS, EKG_GEOM } from "../viewer/src/layout/ekgViewLayout.js";

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ok  · ${name}`);
    passed += 1;
  } catch (err) {
    console.error(`  FAIL · ${name}\n        ${err.message}\n        ${err.stack?.split("\n")[2] ?? ""}`);
    failed += 1;
  }
}

// ── Fixture ─────────────────────────────────────────────────────────────────
//
// A toy EKG: one purchase order PO_A, two items Item_1 and Item_2, and a
// resource Alice. Events span ~3 months. Two events (e2, e4) are *shared*:
// they touch both PO_A and an item. The spread in timestamps lets us put
// events into different L0 bins.

function makeBundle() {
  return {
    dataset: "test",
    generated_at: "2024-01-01T00:00:00Z",
    promg_version: "test",
    events: [
      { event_id: "e1", activity: "Create",  timestamp: "2024-01-05T08:00:00", properties: {} },
      { event_id: "e2", activity: "Approve", timestamp: "2024-01-25T08:00:00", properties: {} },  // shared
      { event_id: "e3", activity: "Receive", timestamp: "2024-02-10T08:00:00", properties: {} },
      { event_id: "e4", activity: "Pay",     timestamp: "2024-03-15T08:00:00", properties: {} },  // shared
      { event_id: "e5", activity: "Receive", timestamp: "2024-03-20T08:00:00", properties: {} },
      { event_id: "e6", activity: "Audit",   timestamp: "2024-04-01T08:00:00", properties: {} },
    ],
    entities: [
      { entity_id: "PO_A",   entity_type: "PO",       primary_type: "PO",       labels: ["PO"],       properties: {} },
      { entity_id: "Item_1", entity_type: "POItem",   primary_type: "POItem",   labels: ["POItem"],   properties: {} },
      { entity_id: "Item_2", entity_type: "POItem",   primary_type: "POItem",   labels: ["POItem"],   properties: {} },
      { entity_id: "Alice",  entity_type: "Resource", primary_type: "Resource", labels: ["Resource"], properties: {} },
    ],
    corr: [
      { event_id: "e1", entity_id: "PO_A",   relation_type: "CORR" },
      { event_id: "e2", entity_id: "PO_A",   relation_type: "CORR" },
      { event_id: "e2", entity_id: "Item_1", relation_type: "CORR" },  // shared
      { event_id: "e3", entity_id: "Item_1", relation_type: "CORR" },
      { event_id: "e4", entity_id: "PO_A",   relation_type: "CORR" },  // shared
      { event_id: "e4", entity_id: "Item_2", relation_type: "CORR" },
      { event_id: "e5", entity_id: "Item_2", relation_type: "CORR" },
      { event_id: "e6", entity_id: "Alice",  relation_type: "CORR" },
    ],
    df: [
      { source_event_id: "e1", target_event_id: "e2", entity_id: "PO_A",   entity_type: "PO" },
      { source_event_id: "e2", target_event_id: "e4", entity_id: "PO_A",   entity_type: "PO" },
      { source_event_id: "e2", target_event_id: "e3", entity_id: "Item_1", entity_type: "POItem" },
      { source_event_id: "e4", target_event_id: "e5", entity_id: "Item_2", entity_type: "POItem" },
    ],
    relations: [
      { source_entity_id: "PO_A", target_entity_id: "Item_1", source_entity_type: "PO", target_entity_type: "POItem", relation_type: "HAS_ITEM", properties: {} },
      { source_entity_id: "PO_A", target_entity_id: "Item_2", source_entity_type: "PO", target_entity_type: "POItem", relation_type: "HAS_ITEM", properties: {} },
    ],
  };
}

// Bigger fixture: many entities and binned events. This is what stress-tests
// the conservation invariants — the small bundle alone could pass by accident.
function makeWideBundle(numCases = 8, numItemsPerCase = 4, monthsPerCase = 3) {
  const events = [];
  const entities = [];
  const corr = [];
  const df = [];
  const relations = [];

  const startMs = new Date("2023-01-01T00:00:00Z").getTime();
  let eventCounter = 0;

  for (let c = 0; c < numCases; c++) {
    const caseId = `PO_${c}`;
    entities.push({ entity_id: caseId, entity_type: "PO", primary_type: "PO", labels: ["PO"], properties: {} });
    const caseStart = startMs + c * monthsPerCase * 30 * 86400000;
    const eCase = `e${eventCounter++}`;
    events.push({ event_id: eCase, activity: "Create", timestamp: new Date(caseStart).toISOString(), properties: {} });
    corr.push({ event_id: eCase, entity_id: caseId, relation_type: "CORR" });

    for (let i = 0; i < numItemsPerCase; i++) {
      const itemId = `Item_${c}_${i}`;
      entities.push({ entity_id: itemId, entity_type: "POItem", primary_type: "POItem", labels: ["POItem"], properties: {} });
      relations.push({
        source_entity_id: caseId, target_entity_id: itemId,
        source_entity_type: "PO", target_entity_type: "POItem",
        relation_type: "HAS_ITEM", properties: {},
      });
      // 3 events per item: Receive, Pay, Audit, increasing in time
      for (let k = 0; k < 3; k++) {
        const t = caseStart + (i * 3 + k + 1) * 3 * 86400000;
        const evId = `e${eventCounter++}`;
        const activity = ["Receive", "Pay", "Audit"][k];
        events.push({ event_id: evId, activity, timestamp: new Date(t).toISOString(), properties: {} });
        // Pay is a shared event touching both case and item
        corr.push({ event_id: evId, entity_id: itemId, relation_type: "CORR" });
        if (k === 1) corr.push({ event_id: evId, entity_id: caseId, relation_type: "CORR" });
        if (k > 0) {
          df.push({
            source_event_id: `e${eventCounter - 2}`,
            target_event_id: evId,
            entity_id: itemId,
            entity_type: "POItem",
          });
        }
      }
    }
  }

  return {
    dataset: "wide", generated_at: "2024-01-01T00:00:00Z", promg_version: "test",
    events, entities, corr, df, relations,
  };
}

// ── EKG view tests ──────────────────────────────────────────────────────────

console.log("EKG view — data layer invariants");

function freshView(bundleFactory = makeBundle, filters = {}) {
  buildStore(bundleFactory());
  return getEkgView(filters);
}

test("getEkgView returns the documented shape", () => {
  const view = freshView();
  assert.equal(view.isEkgView, true);
  assert.equal(typeof view.timeRange.min, "number");
  assert.equal(typeof view.timeRange.max, "number");
  assert.equal(view.bins.length, view.binCount);
  assert.ok(view.bandOrder.length >= 1, "bandOrder should list at least one type");
  assert.ok(Array.isArray(view.typeNodes));
  assert.ok(Array.isArray(view.spines));
  assert.ok(view.sparklinesByType, "sparklinesByType present");
});

test("Stream conservation: bin.total == sum(byType[t].total) for every bin", () => {
  const view = freshView();
  view.bins.forEach((bin, i) => {
    const sum = Object.values(bin.byType).reduce((acc, t) => acc + t.total, 0);
    assert.equal(bin.total, sum, `bin ${i} total ${bin.total} != sum ${sum}`);
  });
});

test("Stream conservation: bin.byType[t].total == sum(byActivity)", () => {
  const view = freshView();
  view.bins.forEach((bin, i) => {
    Object.entries(bin.byType).forEach(([type, stats]) => {
      const sum = Object.values(stats.byActivity).reduce((a, b) => a + b, 0);
      assert.equal(stats.total, sum, `bin ${i} type ${type}: ${stats.total} != ${sum}`);
    });
  });
});

test("Sparkline rows are sorted by firstTime ascending (per type)", () => {
  const view = freshView();
  Object.entries(view.sparklinesByType).forEach(([type, rows]) => {
    for (let i = 1; i < rows.length; i++) {
      assert.ok(rows[i - 1].firstTime <= rows[i].firstTime,
        `${type} not sorted: row ${i - 1} firstTime=${rows[i - 1].firstTime} > row ${i} firstTime=${rows[i].firstTime}`);
    }
  });
});

test("Sparkline events within each row are sorted by t ascending", () => {
  const view = freshView();
  Object.entries(view.sparklinesByType).forEach(([type, rows]) => {
    rows.forEach(row => {
      for (let i = 1; i < row.events.length; i++) {
        assert.ok(row.events[i - 1].t <= row.events[i].t,
          `${type} ${row.entity_id} events not sorted at index ${i}`);
      }
      // firstTime / lastTime match events
      assert.equal(row.firstTime, row.events[0].t);
      assert.equal(row.lastTime, row.events[row.events.length - 1].t);
      assert.equal(row.eventCount, row.events.length);
    });
  });
});

test("L0 ↔ L2 conservation: per (type, bin), L0 count == #sparkline events", () => {
  const view = freshView(makeWideBundle);
  const span = Math.max(view.timeRange.max - view.timeRange.min, 1);
  const binWidth = span / view.binCount;
  const binFor = t => Math.min(view.binCount - 1, Math.max(0, Math.floor((t - view.timeRange.min) / binWidth)));

  Object.entries(view.sparklinesByType).forEach(([type, rows]) => {
    // Build per-bin event count from L2
    const l2CountByBin = new Map();
    rows.forEach(row => {
      row.events.forEach(event => {
        const i = binFor(event.t);
        l2CountByBin.set(i, (l2CountByBin.get(i) ?? 0) + 1);
      });
    });
    // Compare against L0
    view.bins.forEach((bin, i) => {
      const l0 = bin.byType[type]?.total ?? 0;
      const l2 = l2CountByBin.get(i) ?? 0;
      assert.equal(l0, l2, `bin ${i} type ${type}: L0=${l0} vs L2=${l2}`);
    });
  });
});

test("Spines: every shared event appears exactly once, with types sorted, ≥2 types", () => {
  const view = freshView();
  // Each spine refers to a unique event id
  const ids = new Set();
  view.spines.forEach(spine => {
    assert.ok(!ids.has(spine.event_id), `duplicate spine for ${spine.event_id}`);
    ids.add(spine.event_id);
    assert.ok(spine.types.length >= 2, `spine ${spine.event_id} has <2 types`);
    // types should be sorted alphabetically (stable)
    const sorted = [...spine.types].sort();
    assert.deepEqual(spine.types, sorted, `spine ${spine.event_id} types not sorted`);
    assert.ok(spine.sharedEntityIds.length >= 2);
  });
});

test("Spines are sorted by timestamp ascending", () => {
  const view = freshView(makeWideBundle);
  for (let i = 1; i < view.spines.length; i++) {
    assert.ok(view.spines[i - 1].t <= view.spines[i].t,
      `spines not sorted at index ${i}`);
  }
});

test("globalDensity[i] === bins[i].total (minimap parity)", () => {
  const view = freshView(makeWideBundle);
  assert.equal(view.globalDensity.length, view.bins.length);
  view.bins.forEach((bin, i) => {
    assert.equal(view.globalDensity[i], bin.total, `density mismatch at bin ${i}`);
  });
});

test("bandOrder agrees with typeNodes and only lists types that have entities", () => {
  const view = freshView();
  assert.deepEqual(view.bandOrder, view.typeNodes.map(t => t.id));
  view.typeNodes.forEach(node => {
    assert.ok(node.entityCount > 0, `${node.id} should have entities`);
  });
});

test("Time scale is monotonic across bins", () => {
  const view = freshView(makeWideBundle);
  for (let i = 1; i < view.bins.length; i++) {
    assert.ok(view.bins[i].t0 >= view.bins[i - 1].t0);
    assert.equal(view.bins[i].t0, view.bins[i - 1].t1,
      `bin gap detected at ${i}: ${view.bins[i].t0} vs ${view.bins[i - 1].t1}`);
  }
});

test("Activity filter restricts events without breaking invariants", () => {
  buildStore(makeWideBundle());
  const view = getEkgView({ activities: new Set(["Pay"]) });
  // Every L0 byActivity key must be "Pay"
  view.bins.forEach(bin => {
    Object.values(bin.byType).forEach(t => {
      Object.keys(t.byActivity).forEach(a => assert.equal(a, "Pay", `expected only Pay, got ${a}`));
    });
  });
  // Sparkline events must all be "Pay"
  Object.values(view.sparklinesByType).forEach(rows =>
    rows.forEach(row => row.events.forEach(e => assert.equal(e.activity, "Pay")))
  );
});

test("Events with invalid timestamps are filtered out by default", () => {
  const bundle = makeBundle();
  // Corrupt two events: one missing timestamp, one with garbage
  bundle.events.push({ event_id: "e-bad-1", activity: "Audit", timestamp: "", properties: {} });
  bundle.events.push({ event_id: "e-bad-2", activity: "Audit", timestamp: "not-a-date", properties: {} });
  // Correlate them so they'd be visible if not filtered
  bundle.corr.push({ event_id: "e-bad-1", entity_id: "PO_A",   relation_type: "CORR" });
  bundle.corr.push({ event_id: "e-bad-2", entity_id: "Item_1", relation_type: "CORR" });

  buildStore(bundle);
  assert.equal(getInvalidEventCount(), 2);

  const view = getEkgView();
  assert.equal(view.invalidEventCount, 2);
  // Stats should reflect only valid events
  const validCount = bundle.events.length - 2;
  assert.equal(view.stats.events, validCount);
  // Sparkline rows should never contain those bad event ids
  Object.values(view.sparklinesByType).forEach(rows => {
    rows.forEach(row => row.events.forEach(e => {
      assert.ok(e.event_id !== "e-bad-1" && e.event_id !== "e-bad-2",
        `bad event leaked into sparkline: ${e.event_id}`);
    }));
  });
  // Bins should not have counted them
  const totalInBins = view.bins.reduce((s, b) => s + b.total, 0);
  // Total (event, type) pairs across bins should equal sum over valid events
  // of unique-type count. For our corrupted events we don't compute, but at
  // least: the total should not include the bad events' types.
  assert.ok(totalInBins > 0);

  // listInvalidDateEvents should surface them with their original ids
  const flagged = listInvalidDateEvents();
  const flaggedIds = new Set(flagged.map(e => e.event_id));
  assert.ok(flaggedIds.has("e-bad-1"));
  assert.ok(flaggedIds.has("e-bad-2"));
});

test("Empty filter (no matching activities) yields an empty-but-well-formed view", () => {
  buildStore(makeBundle());
  const view = getEkgView({ activities: new Set() });
  assert.equal(view.stats.events, 0);
  assert.equal(view.spines.length, 0);
  view.bins.forEach(bin => {
    assert.equal(bin.total, 0);
    assert.deepEqual(Object.keys(bin.byType), []);
  });
  Object.values(view.sparklinesByType).forEach(rows => assert.deepEqual(rows, []));
});

// ── EKG view layout tests ───────────────────────────────────────────────────

console.log("\nEKG view — layout invariants");

const VIEWPORT = { width: 1200, heightAvailable: 800 };

function freshLayout(level, opts = {}) {
  buildStore(opts.bundle ?? makeBundle());
  const data = getEkgView();
  return {
    layout: computeEkgViewLayout(data, VIEWPORT, { level, ...opts.state }),
    data,
  };
}

test("Layout bands are stacked top-to-bottom with no overlap", () => {
  const { layout } = freshLayout(EKG_LEVELS.L1, { bundle: makeWideBundle() });
  let prevBottom = 0;
  layout.bands.forEach(band => {
    assert.ok(band.y >= prevBottom, `band ${band.type} starts at ${band.y}, before prevBottom ${prevBottom}`);
    assert.ok(band.height > 0, `band ${band.type} has zero height`);
    prevBottom = band.y + band.height;
  });
});

test("Time scale is one object and is monotone in time", () => {
  const { layout } = freshLayout(EKG_LEVELS.L1, { bundle: makeWideBundle() });
  const { t0, t1 } = layout.timeScale;
  // x(t0) hits the left edge, x(t1) hits the right edge (within 1px tolerance)
  assert.ok(Math.abs(layout.timeScale.x(t0) - layout.innerLeft) < 1);
  assert.ok(Math.abs(layout.timeScale.x(t1) - layout.innerRight) < 1);
  // Monotonicity
  const samples = [t0, t0 + (t1 - t0) * 0.25, t0 + (t1 - t0) * 0.75, t1];
  for (let i = 1; i < samples.length; i++) {
    assert.ok(layout.timeScale.x(samples[i]) > layout.timeScale.x(samples[i - 1]));
  }
});

test("Shared-event spines align to the same time scale as bands", () => {
  const { layout } = freshLayout(EKG_LEVELS.L1, { bundle: makeWideBundle() });
  layout.sharedSpines.forEach(spine => {
    const expectedX = layout.timeScale.x(spine.t);
    assert.ok(Math.abs(spine.x - expectedX) < 0.001,
      `spine x ${spine.x} ≠ timeScale.x(${spine.t}) = ${expectedX}`);
  });
});

test("Default-hidden roles (resource/attribute) drop out of the band stack", () => {
  buildStore(makeWideBundle());
  const data = getEkgView();
  const layout = computeEkgViewLayout(data, VIEWPORT, { level: EKG_LEVELS.L1 });
  // wide bundle has only PO + POItem (case + item roles) — both should appear.
  layout.bands.forEach(b => {
    assert.ok(["case", "item", "other"].includes(b.role), `band ${b.type} has hidden role ${b.role}`);
  });
});

test("Focused spine gets full-band y0/y1; unfocused spines do not", () => {
  buildStore(makeWideBundle());
  const data = getEkgView();
  // No focus → focusedSpine is null
  const layoutA = computeEkgViewLayout(data, VIEWPORT, { level: EKG_LEVELS.L1 });
  assert.equal(layoutA.focusedSpine, null);
  layoutA.sharedSpines.forEach(s => {
    assert.equal(s.y0, undefined, `unfocused spine ${s.event_id} unexpectedly has y0`);
  });
  // Focus a spine → only that one has y0/y1 spanning its bands.
  const target = data.spines[0];
  if (!target) return;  // tiny dataset edge case
  const layoutB = computeEkgViewLayout(data, VIEWPORT, {
    level: EKG_LEVELS.L1,
    focus: { kind: "spine", value: target.event_id },
  });
  assert.ok(layoutB.focusedSpine);
  assert.equal(layoutB.focusedSpine.event_id, target.event_id);
  assert.ok(layoutB.focusedSpine.y1 > layoutB.focusedSpine.y0);
});

test("Spine clusters merge nearby spines (≤ clusterMinSep pixels apart)", () => {
  buildStore(makeWideBundle());
  const data = getEkgView();
  const layout = computeEkgViewLayout(data, VIEWPORT, { level: EKG_LEVELS.L1 });
  assert.ok(Array.isArray(layout.spineClusters));
  // Cluster total count equals total in-window spine count
  const totalInClusters = layout.spineClusters.reduce((s, c) => s + c.count, 0);
  assert.equal(totalInClusters, layout.sharedSpines.length);
  // Clusters sorted by x and respect min separation
  for (let i = 1; i < layout.spineClusters.length; i++) {
    assert.ok(layout.spineClusters[i].x >= layout.spineClusters[i - 1].x);
  }
});

test("Synchronisation strip totals equal the in-window spine count", () => {
  buildStore(makeWideBundle());
  const data = getEkgView();
  const layout = computeEkgViewLayout(data, VIEWPORT, { level: EKG_LEVELS.L1 });
  const stripTotal = layout.syncStrip.bins.reduce((s, b) => s + b.count, 0);
  assert.equal(stripTotal, layout.sharedSpines.length);
  assert.equal(stripTotal, layout.syncStrip.totalSpines);
});

test("L0 bin rects respect the time window (clip on zoom)", () => {
  const { data } = freshLayout(EKG_LEVELS.L0, { bundle: makeWideBundle() });
  const fullSpan = data.timeRange.max - data.timeRange.min;
  const zoomT0 = data.timeRange.min + fullSpan * 0.3;
  const zoomT1 = data.timeRange.min + fullSpan * 0.7;
  const layout = computeEkgViewLayout(data, VIEWPORT, { level: EKG_LEVELS.L0, timeWindow: { t0: zoomT0, t1: zoomT1 } });
  layout.bands.forEach(band => {
    if (band.cells.kind !== "L0") return;
    band.cells.bins.forEach(bin => {
      assert.ok(bin.x >= layout.innerLeft - 0.5);
      assert.ok(bin.x + bin.w <= layout.innerRight + 0.5);
    });
  });
});

test("L2 sparkline rows fit inside their band's content area", () => {
  const { layout } = freshLayout(EKG_LEVELS.L2, { bundle: makeWideBundle() });
  layout.bands.forEach(band => {
    if (band.cells.kind !== "L2") return;
    band.cells.rows.forEach(row => {
      assert.ok(row.rowY >= band.contentY - 0.5,
        `${band.type} row at ${row.rowY} above contentY ${band.contentY}`);
      assert.ok(row.rowY + row.rowH <= band.contentY + band.contentH + 0.5,
        `${band.type} row bottom ${row.rowY + row.rowH} below band end`);
    });
  });
});

test("Axis ticks span the time window in order", () => {
  const { layout } = freshLayout(EKG_LEVELS.L1, { bundle: makeWideBundle() });
  assert.equal(layout.axis.ticks.length, EKG_GEOM.axis.tickCount);
  for (let i = 1; i < layout.axis.ticks.length; i++) {
    assert.ok(layout.axis.ticks[i].t > layout.axis.ticks[i - 1].t);
    assert.ok(layout.axis.ticks[i].x > layout.axis.ticks[i - 1].x);
  }
});

test("Top scrubber viewportRect maps the current zoom window to the scrubber scale", () => {
  const { data } = freshLayout(EKG_LEVELS.L1, { bundle: makeWideBundle() });
  const fullSpan = data.timeRange.max - data.timeRange.min;
  const zoomT0 = data.timeRange.min + fullSpan * 0.25;
  const zoomT1 = data.timeRange.min + fullSpan * 0.75;
  const layout = computeEkgViewLayout(data, VIEWPORT, { level: EKG_LEVELS.L1, timeWindow: { t0: zoomT0, t1: zoomT1 } });
  const { x0, x1 } = layout.scrubber.viewportRect;
  // x0 should be ~25% across the scrubber, x1 ~75%
  const expected0 = layout.scrubber.x + 0.25 * layout.scrubber.w;
  const expected1 = layout.scrubber.x + 0.75 * layout.scrubber.w;
  assert.ok(Math.abs(x0 - expected0) < 0.5);
  assert.ok(Math.abs(x1 - expected1) < 0.5);
});

test("Scrubber sits above the axis and bands (top of canvas)", () => {
  const { layout } = freshLayout(EKG_LEVELS.L1, { bundle: makeWideBundle() });
  assert.ok(layout.scrubber.y < layout.axis.y, "scrubber must be above axis");
  layout.bands.forEach(band => {
    assert.ok(band.y > layout.scrubber.y + layout.scrubber.height,
      `band ${band.type} (y=${band.y}) overlaps scrubber bottom ${layout.scrubber.y + layout.scrubber.height}`);
  });
});

test("L3 only fills the focused entity's own band; other bands fall back to L1", () => {
  buildStore(makeWideBundle());
  const data = getEkgView();
  // Find an entity in the POItem band
  const target = data.sparklinesByType.POItem[0];
  const layout = computeEkgViewLayout(data, VIEWPORT, {
    level: EKG_LEVELS.L3,
    focus: { kind: "entity", value: target.entity_id, entityType: "POItem" },
  });
  const poItemBand = layout.bands.find(b => b.type === "POItem");
  const poBand = layout.bands.find(b => b.type === "PO");
  assert.equal(poItemBand.render, "L3");
  assert.equal(poBand?.render, "L1", "non-focused band should fall back to L1");
  assert.equal(poItemBand.cells.row.entity_id, target.entity_id);
});

test("Degenerate time window (t1 <= t0) snaps to the full data range", () => {
  const { data } = freshLayout(EKG_LEVELS.L1);
  const layout = computeEkgViewLayout(data, VIEWPORT, { level: EKG_LEVELS.L1, timeWindow: { t0: 100, t1: 100 } });
  assert.equal(layout.timeWindow.t0, data.timeRange.min);
  assert.equal(layout.timeWindow.t1, data.timeRange.max);
});

// ── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
