// Smoke tests for the new EKG Atlas layout and the cleaned-up detail layout
// config. Run with:
//
//     node bep/tests/test_atlas.mjs
//
// No test framework is required — the script uses Node's built-in `assert`
// and exits with a non-zero status if any assertion fails. This is deliberately
// lightweight: these are smoke tests, not a comprehensive suite.
//
// To add a test, append a `test("name", () => {...})` call below.

import assert from "node:assert/strict";

import { computeAtlasLayout, ATLAS } from "../viewer/src/layout/atlasLayout.js";
import { LAYOUT_CONFIG, TIMELINE_X0, RELATION_PORT_X } from "../viewer/src/layout/detailLayout.js";
import { parseAtlasFocus, serializeAtlasFocus, normalizeAtlasTab } from "../viewer/src/screens/atlas.js";

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ok  · ${name}`);
    passed += 1;
  } catch (err) {
    console.error(`  FAIL · ${name}\n        ${err.message}`);
    failed += 1;
  }
}

// ── Fixtures ────────────────────────────────────────────────────────────────

function makeAtlas(overrides = {}) {
  const typeNodes = [
    { id: "PO", label: "PO", role: "case", color: "#2563eb", entityCount: 12, eventCount: 80 },
    { id: "POItem", label: "POItem", role: "item", color: "#ea580c", entityCount: 36, eventCount: 240 },
    { id: "Resource", label: "Resource", role: "resource", color: "#475569", entityCount: 6, eventCount: 80 },
  ];
  const typeEdges = [
    { source: "PO", target: "POItem", sharedEventCount: 40, structuralRelationCount: 36, kind: "both" },
    { source: "POItem", target: "Resource", sharedEventCount: 22, structuralRelationCount: 0, kind: "shared" },
  ];
  const timeRange = { min: 0, max: 100_000 };
  const streamBins = Array.from({ length: 8 }, (_, i) => ({
    binIndex: i,
    t0: i * 12_500,
    t1: (i + 1) * 12_500,
    countsByType: {
      PO: 2 + (i % 3),
      POItem: 6 + ((i * 2) % 5),
      Resource: 1 + (i % 2),
    },
    total: 0,
  }));
  streamBins.forEach(b => { b.total = b.countsByType.PO + b.countsByType.POItem + b.countsByType.Resource; });
  return {
    isEkgAtlas: true,
    stats: { events: 400, totalEvents: 400, entities: 54, entityTypes: 3 },
    timeRange,
    typeNodes,
    typeEdges,
    streamBins,
    streamTypes: ["PO", "POItem", "Resource"],
    activityBands: {
      entityTypes: ["PO", "POItem"],
      bandsByType: {
        PO:     { nodes: [{ activity: "Create",  count: 10, meanTimestamp: 5_000 }, { activity: "Approve", count: 6, meanTimestamp: 60_000 }], dfEdges: [{ source: "Create", target: "Approve", count: 6 }] },
        POItem: { nodes: [{ activity: "Receive", count: 18, meanTimestamp: 20_000 }, { activity: "Invoice", count: 14, meanTimestamp: 80_000 }], dfEdges: [{ source: "Receive", target: "Invoice", count: 12 }] },
      },
      syncArcs: [{ activity: "Approve", type1: "PO", type2: "POItem", count: 4 }],
      minTime: timeRange.min, maxTime: timeRange.max, totalEvents: 400, caseType: "PO", itemType: "POItem",
    },
    topActivities: [{ activity: "Receive", count: 18, color: "#059669" }],
    topHotspots: [],
    ...overrides,
  };
}

// ── Atlas layout ────────────────────────────────────────────────────────────

console.log("EKG Atlas — layout smoke tests");

test("computeAtlasLayout returns 3 panels stacked vertically", () => {
  const layout = computeAtlasLayout(makeAtlas(), 1200);
  assert.equal(layout.isAtlasLayout, true);
  const { type, stream, activity } = layout.panels;
  assert.ok(type && stream && activity, "all three panels present");
  // Vertical ordering: type → stream → activity (with gaps)
  assert.ok(type.bottomY < stream.y,    "type before stream");
  assert.ok(stream.bottomY < activity.y, "stream before activity");
  assert.ok(layout.totalHeight >= activity.bottomY);
});

test("type panel positions every node inside the graph bounds", () => {
  const layout = computeAtlasLayout(makeAtlas(), 1200);
  const t = layout.panels.type;
  assert.equal(t.nodes.length, 3);
  t.nodes.forEach(node => {
    assert.ok(node.x >= t.graphLeft - 1, `node ${node.id} x=${node.x} >= ${t.graphLeft}`);
    assert.ok(node.x <= t.graphLeft + t.graphWidth + 1, `node ${node.id} x within right bound`);
    assert.ok(node.y >= t.y + t.headerH - 1, `node ${node.id} y below header`);
    assert.ok(node.y <= t.bottomY + 1, `node ${node.id} y above bottom`);
    assert.ok(node.r >= ATLAS.TYPE_NODE_MIN_R && node.r <= ATLAS.TYPE_NODE_MAX_R, "radius within bounds");
  });
});

test("type edges are anchored at node radii (not centers)", () => {
  const layout = computeAtlasLayout(makeAtlas(), 1200);
  const t = layout.panels.type;
  const nodeById = Object.fromEntries(t.nodes.map(n => [n.id, n]));
  t.edges.forEach(edge => {
    const a = nodeById[edge.source];
    const b = nodeById[edge.target];
    const dxa = edge.x1 - a.x, dya = edge.y1 - a.y;
    const dxb = edge.x2 - b.x, dyb = edge.y2 - b.y;
    // Endpoints sit on (or close to) each node's circumference
    assert.ok(Math.abs(Math.hypot(dxa, dya) - a.r) < 0.5, "edge starts at source radius");
    assert.ok(Math.abs(Math.hypot(dxb, dyb) - b.r) < 0.5, "edge ends at target radius");
    assert.ok(edge.width >= ATLAS.TYPE_EDGE_MIN_WIDTH, "edge width respects minimum");
  });
});

test("stream layers conserve event counts at every time bin", () => {
  const atlas = makeAtlas();
  const layout = computeAtlasLayout(atlas, 1200);
  const s = layout.panels.stream;
  assert.equal(s.layers.length, atlas.streamTypes.length);
  atlas.streamBins.forEach((bin, i) => {
    // Top of last layer minus bottom of first layer ≈ -total (y axis is inverted)
    const firstBottom = s.layers[0].pointsBottom[i].y;
    const lastTop = s.layers[s.layers.length - 1].pointsTop[i].y;
    const spanPx = firstBottom - lastTop;
    // The chart maps `maxTotal` to chartHeight, so this bin's pixel span
    // should be (total / maxTotal) * chartHeight (within 1px tolerance).
    const expectedPx = (bin.total / s.maxTotal) * s.chartHeight;
    assert.ok(Math.abs(spanPx - expectedPx) < 1.5,
      `bin ${i}: spanPx=${spanPx.toFixed(2)} expected≈${expectedPx.toFixed(2)}`);
  });
});

test("stream baseline is centered (symmetric wiggle)", () => {
  const layout = computeAtlasLayout(makeAtlas(), 1200);
  const s = layout.panels.stream;
  const midY = s.chartTop + s.chartHeight / 2;
  // First layer's bottom + last layer's top should be roughly symmetric about midY
  const first = s.layers[0].pointsBottom[0].y;
  const last  = s.layers[s.layers.length - 1].pointsTop[0].y;
  assert.ok(Math.abs((first + last) / 2 - midY) < 1, "symmetric stack centered on midline");
});

test("activity panel coordinates are shifted by the panel originY", () => {
  const layout = computeAtlasLayout(makeAtlas(), 1200);
  const a = layout.panels.activity;
  assert.ok(!a.empty);
  // Every band band.y must be >= a.y + headerH (panel start + header)
  a.bands.forEach(band => {
    assert.ok(band.y >= a.y + a.headerH - 1, `band ${band.type} y=${band.y} below header`);
    band.nodes.forEach(node => {
      assert.ok(node.y >= a.y + a.headerH - 1, `node ${node.activity} y in panel`);
    });
  });
});

test("empty atlas yields a sensible degenerate layout", () => {
  const empty = {
    isEkgAtlas: true,
    stats: {}, timeRange: { min: 0, max: 1 },
    typeNodes: [], typeEdges: [], streamBins: [], streamTypes: [],
    activityBands: { entityTypes: [], bandsByType: {}, syncArcs: [], minTime: 0, maxTime: 1, totalEvents: 0 },
    topActivities: [], topHotspots: [],
  };
  const layout = computeAtlasLayout(empty, 1200);
  assert.equal(layout.panels.type.nodes.length, 0);
  assert.equal(layout.panels.type.edges.length, 0);
  assert.equal(layout.panels.stream.layers.length, 0);
  assert.equal(layout.panels.activity.empty, true);
  assert.ok(layout.totalHeight > 0);
});

// ── Detail layout config ────────────────────────────────────────────────────

console.log("\nDetail layout config — structure tests");

test("LAYOUT_CONFIG exposes all required geometry groups", () => {
  assert.ok(LAYOUT_CONFIG.pad);
  assert.ok(LAYOUT_CONFIG.timeline);
  assert.ok(LAYOUT_CONFIG.band);
  assert.ok(LAYOUT_CONFIG.anchor);
  assert.ok(LAYOUT_CONFIG.shared);
  assert.ok(LAYOUT_CONFIG.header);
  assert.ok(LAYOUT_CONFIG.relation);
});

test("LAYOUT_CONFIG is deeply frozen at the top level", () => {
  assert.throws(() => { LAYOUT_CONFIG.pad = {}; }, /Cannot|read only/);
});

test("Legacy exports still match LAYOUT_CONFIG values", () => {
  assert.equal(TIMELINE_X0, LAYOUT_CONFIG.timeline.x0);
  assert.equal(RELATION_PORT_X, LAYOUT_CONFIG.timeline.x0 - LAYOUT_CONFIG.relation.portOffset);
});

// ── Atlas focus URL helpers ─────────────────────────────────────────────────

console.log("\nAtlas focus URL helpers");

test("parseAtlasFocus accepts type, activity, edge, hotspot", () => {
  assert.deepEqual(parseAtlasFocus("type:PO"),      { kind: "type", value: "PO" });
  assert.deepEqual(parseAtlasFocus("activity:Pay"), { kind: "activity", value: "Pay" });
  assert.deepEqual(parseAtlasFocus("edge:PO__POItem"), { kind: "edge", value: "PO__POItem" });
  assert.deepEqual(parseAtlasFocus("hotspot:act:Pay"), { kind: "hotspot", value: "act:Pay" });
});

test("parseAtlasFocus rejects malformed input", () => {
  assert.equal(parseAtlasFocus(""), null);
  assert.equal(parseAtlasFocus(undefined), null);
  assert.equal(parseAtlasFocus("nonsense"), null);
  assert.equal(parseAtlasFocus("badkind:value"), null);
  // edge values must contain "__"
  assert.equal(parseAtlasFocus("edge:only-one-type"), null);
});

test("parseAtlasFocus decodes URL-encoded values", () => {
  // Activity names sometimes contain spaces in the wild
  assert.deepEqual(parseAtlasFocus("activity:Create%20PO"), { kind: "activity", value: "Create PO" });
});

test("serializeAtlasFocus round-trips", () => {
  const cases = [
    { kind: "type", value: "PO" },
    { kind: "activity", value: "Pay" },
    { kind: "edge", value: "PO__POItem" },
  ];
  cases.forEach(focus => {
    const round = parseAtlasFocus(serializeAtlasFocus(focus));
    assert.deepEqual(round, focus);
  });
});

test("normalizeAtlasTab clamps to a known tab", () => {
  assert.equal(normalizeAtlasTab("entities"),   "entities");
  assert.equal(normalizeAtlasTab("activities"), "activities");
  assert.equal(normalizeAtlasTab("shared"),     "shared");
  assert.equal(normalizeAtlasTab(""),           "entities");
  assert.equal(normalizeAtlasTab("garbage"),    "entities");
  assert.equal(normalizeAtlasTab(undefined),    "entities");
});

// ── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
