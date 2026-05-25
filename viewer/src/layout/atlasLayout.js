"use strict";

// ─── LEGACY (v1) ────────────────────────────────────────────────────────────
// Layout for the legacy three-panel Atlas. The new T1 layout is in
// layout/ekgViewLayout.js. Don't extend this file.
// ────────────────────────────────────────────────────────────────────────────

// EKG Atlas — multi-panel layout for the complete-EKG (T1) view.
//
// The Atlas is composed of three stacked panels sharing the canvas width:
//   1. Type Graph        – force-directed entity-type graph (structural macro)
//   2. Temporal Stream   – streamgraph of event density per entity type
//   3. Activity Flow     – per-type activity-DF bands with cross-type sync arcs
//
// Each panel returns a self-contained layout object that the renderer can draw
// without re-querying the source data. All three panels share an `originY` so
// the renderer can simply stack them vertically.

import { computeTypeEKGLayout } from "./overviewLayout.js";

export const ATLAS = Object.freeze({
  PANEL_GAP: 28,
  PAD_X: 28,
  PAD_TOP: 24,

  TYPE_PANEL_HEIGHT: 260,
  TYPE_HEADER_H: 32,
  TYPE_NODE_MIN_R: 14,
  TYPE_NODE_MAX_R: 44,
  TYPE_FORCE_ITERATIONS: 280,
  TYPE_EDGE_MIN_WIDTH: 0.9,
  TYPE_EDGE_MAX_WIDTH: 7,

  STREAM_PANEL_HEIGHT: 220,
  STREAM_HEADER_H: 32,
  STREAM_AXIS_H: 22,

  ACTIVITY_HEADER_H: 32,

  TYPE_LEGEND_W: 168,
});

export function computeAtlasLayout(atlas, viewportWidth) {
  if (!atlas) {
    return { panels: [], totalHeight: 0, viewportWidth: viewportWidth ?? 0 };
  }

  const innerWidth = Math.max((viewportWidth ?? 1200) - ATLAS.PAD_X * 2, 720);
  let cursorY = ATLAS.PAD_TOP;

  const typePanel = layoutTypePanel(atlas, innerWidth, cursorY);
  cursorY = typePanel.bottomY + ATLAS.PANEL_GAP;

  const streamPanel = layoutStreamPanel(atlas, innerWidth, cursorY);
  cursorY = streamPanel.bottomY + ATLAS.PANEL_GAP;

  const activityPanel = layoutActivityPanel(atlas, viewportWidth, cursorY);
  cursorY = activityPanel.bottomY + ATLAS.PAD_TOP;

  return {
    isAtlasLayout: true,
    panels: { type: typePanel, stream: streamPanel, activity: activityPanel },
    totalHeight: cursorY,
    viewportWidth: viewportWidth ?? innerWidth,
    padX: ATLAS.PAD_X,
  };
}

// ── Panel 1: Type Graph (force-directed) ────────────────────────────────────
//
// Lightweight, deterministic force simulation:
//   - Charge: pairwise repulsion (Coulomb).
//   - Spring: edges pull endpoints together with rest length scaled by weight.
//   - Center: weak pull to panel center keeps the graph in view.
//   - Collision: prevents node overlap based on radius.
// Seeds are placed on a Fibonacci spiral so layout is reproducible run-to-run.

function layoutTypePanel(atlas, innerWidth, originY) {
  const x0 = ATLAS.PAD_X;
  const y0 = originY;
  const legendW = ATLAS.TYPE_LEGEND_W;
  const graphLeft = x0 + legendW;
  const graphWidth = innerWidth - legendW;
  const graphHeight = ATLAS.TYPE_PANEL_HEIGHT - ATLAS.TYPE_HEADER_H;

  const cx = graphLeft + graphWidth / 2;
  const cy = y0 + ATLAS.TYPE_HEADER_H + graphHeight / 2;

  const nodes = (atlas.typeNodes ?? []).map((n, i) => ({ ...n, _index: i }));
  if (!nodes.length) {
    return {
      kind: "type",
      x: x0, y: y0, width: innerWidth, height: ATLAS.TYPE_PANEL_HEIGHT,
      bottomY: y0 + ATLAS.TYPE_PANEL_HEIGHT,
      headerH: ATLAS.TYPE_HEADER_H,
      graphLeft, graphWidth, graphHeight,
      cx, cy,
      nodes: [], edges: [], legend: [],
    };
  }

  const maxEntities = Math.max(...nodes.map(n => n.entityCount), 1);
  nodes.forEach(node => {
    node.r = ATLAS.TYPE_NODE_MIN_R + Math.sqrt(node.entityCount / maxEntities) * (ATLAS.TYPE_NODE_MAX_R - ATLAS.TYPE_NODE_MIN_R);
  });

  // Fibonacci-spiral seeds for stable initial positions.
  const golden = Math.PI * (3 - Math.sqrt(5));
  const seedRadius = Math.min(graphWidth, graphHeight) * 0.32;
  nodes.forEach((node, i) => {
    const t = i / Math.max(nodes.length - 1, 1);
    const radius = seedRadius * Math.sqrt(t);
    const angle = i * golden;
    node.x = cx + radius * Math.cos(angle);
    node.y = cy + radius * Math.sin(angle);
    node.vx = 0; node.vy = 0;
  });

  const nodeById = Object.fromEntries(nodes.map(n => [n.id, n]));
  const edges = (atlas.typeEdges ?? [])
    .map(edge => {
      const source = nodeById[edge.source];
      const target = nodeById[edge.target];
      if (!source || !target) return null;
      const weight = edge.sharedEventCount + edge.structuralRelationCount * 25;
      return { ...edge, _source: source, _target: target, _weight: weight };
    })
    .filter(Boolean);

  const maxEdgeWeight = Math.max(...edges.map(e => e._weight), 1);

  // ── Simulation ──
  const minX = graphLeft + 18;
  const maxX = graphLeft + graphWidth - 18;
  const minY = y0 + ATLAS.TYPE_HEADER_H + 18;
  const maxY = y0 + ATLAS.TYPE_PANEL_HEIGHT - 18;

  const CHARGE = 540;       // node-node repulsion strength
  const CENTER_PULL = 0.012;
  const ALPHA_DECAY = 0.022;
  const SPRING_K = 0.045;   // edge pull strength
  const FRICTION = 0.84;

  let alpha = 1;
  for (let iter = 0; iter < ATLAS.TYPE_FORCE_ITERATIONS; iter++) {
    // Pairwise repulsion
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d2 = Math.max(dx * dx + dy * dy, 0.01);
        const d = Math.sqrt(d2);
        const force = (CHARGE * (a.r + b.r)) / d2;
        const fx = (dx / d) * force * alpha;
        const fy = (dy / d) * force * alpha;
        a.vx -= fx; a.vy -= fy;
        b.vx += fx; b.vy += fy;
      }
    }

    // Edge springs
    edges.forEach(edge => {
      const a = edge._source;
      const b = edge._target;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.max(Math.sqrt(dx * dx + dy * dy), 0.01);
      const norm = edge._weight / maxEdgeWeight;
      const rest = 80 + (1 - norm) * 110;
      const delta = (d - rest) * SPRING_K * alpha;
      const fx = (dx / d) * delta;
      const fy = (dy / d) * delta;
      a.vx += fx; a.vy += fy;
      b.vx -= fx; b.vy -= fy;
    });

    // Center pull
    nodes.forEach(node => {
      node.vx += (cx - node.x) * CENTER_PULL * alpha;
      node.vy += (cy - node.y) * CENTER_PULL * alpha;
    });

    // Integrate + friction + clamp
    nodes.forEach(node => {
      node.vx *= FRICTION;
      node.vy *= FRICTION;
      node.x += node.vx;
      node.y += node.vy;
      if (node.x < minX) { node.x = minX; node.vx *= -0.5; }
      if (node.x > maxX) { node.x = maxX; node.vx *= -0.5; }
      if (node.y < minY) { node.y = minY; node.vy *= -0.5; }
      if (node.y > maxY) { node.y = maxY; node.vy *= -0.5; }
    });

    // Collision pass
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d = Math.sqrt(dx * dx + dy * dy);
        const minDist = a.r + b.r + 4;
        if (d > 0 && d < minDist) {
          const push = (minDist - d) / 2;
          const ux = dx / d;
          const uy = dy / d;
          a.x -= ux * push; a.y -= uy * push;
          b.x += ux * push; b.y += uy * push;
        }
      }
    }

    alpha = Math.max(alpha - ALPHA_DECAY, 0.02);
  }

  // Edge endpoint offsets (so curves start at node boundary, not center).
  const laidEdges = edges.map(edge => {
    const a = edge._source;
    const b = edge._target;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const d = Math.max(Math.sqrt(dx * dx + dy * dy), 0.01);
    const ux = dx / d;
    const uy = dy / d;
    const norm = edge._weight / maxEdgeWeight;
    const width = ATLAS.TYPE_EDGE_MIN_WIDTH + norm * (ATLAS.TYPE_EDGE_MAX_WIDTH - ATLAS.TYPE_EDGE_MIN_WIDTH);
    return {
      ...edge,
      x1: a.x + ux * a.r,
      y1: a.y + uy * a.r,
      x2: b.x - ux * b.r,
      y2: b.y - uy * b.r,
      width,
    };
  });

  // Strip private fields from nodes
  const laidNodes = nodes.map(node => ({
    id: node.id,
    label: node.label,
    role: node.role,
    color: node.color,
    entityCount: node.entityCount,
    eventCount: node.eventCount,
    r: node.r,
    x: node.x,
    y: node.y,
  }));

  // Legend: list of types with counts (left column of the panel).
  const legend = laidNodes.map(node => ({
    id: node.id,
    label: node.label,
    color: node.color,
    role: node.role,
    entityCount: node.entityCount,
    eventCount: node.eventCount,
  }));

  return {
    kind: "type",
    x: x0, y: y0, width: innerWidth, height: ATLAS.TYPE_PANEL_HEIGHT,
    bottomY: y0 + ATLAS.TYPE_PANEL_HEIGHT,
    headerH: ATLAS.TYPE_HEADER_H,
    graphLeft, graphWidth, graphHeight,
    cx, cy,
    nodes: laidNodes,
    edges: laidEdges,
    legend,
    legendX: x0,
    legendY: y0 + ATLAS.TYPE_HEADER_H,
    legendW,
    legendH: ATLAS.TYPE_PANEL_HEIGHT - ATLAS.TYPE_HEADER_H,
  };
}

// ── Panel 2: Temporal Streamgraph ────────────────────────────────────────────
//
// "Wiggle"-style streamgraph (Byron & Wattenberg 2008): minimises the sum of
// squared layer slopes by centering the stack around a symmetric baseline.

function layoutStreamPanel(atlas, innerWidth, originY) {
  const x0 = ATLAS.PAD_X;
  const y0 = originY;
  const headerH = ATLAS.STREAM_HEADER_H;
  const axisH = ATLAS.STREAM_AXIS_H;
  const chartTop = y0 + headerH;
  const chartHeight = ATLAS.STREAM_PANEL_HEIGHT - headerH - axisH;
  const chartLeft = x0 + 12;
  const chartRight = x0 + innerWidth - 12;
  const chartWidth = Math.max(chartRight - chartLeft, 200);

  const bins = atlas.streamBins ?? [];
  const types = atlas.streamTypes ?? [];
  if (!bins.length || !types.length) {
    return {
      kind: "stream",
      x: x0, y: y0, width: innerWidth, height: ATLAS.STREAM_PANEL_HEIGHT,
      bottomY: y0 + ATLAS.STREAM_PANEL_HEIGHT,
      headerH, axisH, chartTop, chartLeft, chartRight, chartWidth, chartHeight,
      layers: [], xTicks: [], maxTotal: 0,
    };
  }

  const colorById = Object.fromEntries((atlas.typeNodes ?? []).map(n => [n.id, n.color]));
  const labelById = Object.fromEntries((atlas.typeNodes ?? []).map(n => [n.id, n.label]));

  const totals = bins.map(bin =>
    types.reduce((sum, t) => sum + (bin.countsByType[t] ?? 0), 0)
  );
  const maxTotal = Math.max(...totals, 1);

  // Symmetric (wiggle-zero) baseline
  const baselines = bins.map((_, binIdx) => -totals[binIdx] / 2);

  const xForBin = i => chartLeft + (i / Math.max(bins.length - 1, 1)) * chartWidth;
  const yScale = v => chartTop + chartHeight - ((v + maxTotal / 2) / maxTotal) * chartHeight;

  const offsets = bins.map(() => baselines[0]);
  bins.forEach((_, i) => { offsets[i] = baselines[i]; });

  const layers = types.map(type => {
    const layer = {
      type,
      label: labelById[type] ?? type,
      color: colorById[type] ?? "#64748b",
      pointsTop: [],
      pointsBottom: [],
    };
    bins.forEach((bin, i) => {
      const v = bin.countsByType[type] ?? 0;
      const bottom = offsets[i];
      const top = bottom + v;
      layer.pointsBottom.push({ x: xForBin(i), y: yScale(bottom) });
      layer.pointsTop.push({ x: xForBin(i), y: yScale(top) });
      offsets[i] = top;
    });
    layer.path = _buildAreaPath(layer.pointsTop, layer.pointsBottom);
    layer.peak = layer.pointsTop.reduce((best, p, i) => {
      const v = bins[i].countsByType[type] ?? 0;
      return v > (best?.v ?? -1) ? { x: p.x, y: p.y, v, binIdx: i } : best;
    }, null);
    return layer;
  });

  // X-axis ticks (5 evenly spaced)
  const tickCount = 5;
  const xTicks = Array.from({ length: tickCount }, (_, i) => {
    const t = i / (tickCount - 1);
    const time = atlas.timeRange.min + t * Math.max(atlas.timeRange.max - atlas.timeRange.min, 1);
    return {
      x: chartLeft + t * chartWidth,
      label: _formatTickDate(new Date(time)),
      timestamp: time,
    };
  });

  return {
    kind: "stream",
    x: x0, y: y0, width: innerWidth, height: ATLAS.STREAM_PANEL_HEIGHT,
    bottomY: y0 + ATLAS.STREAM_PANEL_HEIGHT,
    headerH, axisH, chartTop, chartLeft, chartRight, chartWidth, chartHeight,
    layers, xTicks, maxTotal,
    timeRange: atlas.timeRange,
  };
}

function _buildAreaPath(topPoints, bottomPoints) {
  if (!topPoints.length) return "";
  const top = topPoints.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(" ");
  const bot = [...bottomPoints].reverse().map(p => `L${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(" ");
  return `${top} ${bot} Z`;
}

function _formatTickDate(d) {
  if (!(d instanceof Date) || isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-GB", { month: "short", year: "2-digit" });
}

// ── Panel 3: Activity-Flow Bands ─────────────────────────────────────────────
//
// Reuses the existing computeTypeEKGLayout for the bulk of the work, then
// shifts every coordinate vertically by `originY` so the panel slots cleanly
// below the streamgraph.

function layoutActivityPanel(atlas, viewportWidth, originY) {
  const activityData = atlas.activityBands;
  const headerH = ATLAS.ACTIVITY_HEADER_H;
  if (!activityData || !activityData.entityTypes.length) {
    return {
      kind: "activity",
      x: 0, y: originY, width: viewportWidth ?? 0,
      height: 80, bottomY: originY + 80,
      headerH, bands: [], syncArcs: [], padLeft: 0, innerW: 0,
      empty: true,
    };
  }

  const base = computeTypeEKGLayout(activityData, viewportWidth);
  const shift = originY + headerH;
  const bands = base.bands.map(band => ({
    ...band,
    y: band.y + shift,
    cy: band.cy + shift,
    nodes: band.nodes.map(n => ({ ...n, y: n.y + shift })),
    edges: band.edges.map(e => ({ ...e, y1: e.y1 + shift, y2: e.y2 + shift, cy: e.cy + shift })),
    nodeByAct: Object.fromEntries(
      Object.entries(band.nodeByAct ?? {}).map(([k, n]) => [k, { ...n, y: n.y + shift }])
    ),
  }));
  const syncArcs = base.syncArcs.map(arc => ({
    ...arc,
    y1: arc.y1 + shift,
    y2: arc.y2 + shift,
    cy: arc.cy + shift,
  }));

  const totalHeight = base.totalHeight + headerH;
  return {
    kind: "activity",
    x: 0, y: originY, width: viewportWidth ?? 0,
    height: totalHeight,
    bottomY: originY + totalHeight,
    headerH,
    bands, syncArcs,
    padLeft: base.padLeft,
    innerW: base.innerW,
    minTime: base.minTime,
    maxTime: base.maxTime,
  };
}
