"use strict";

// Multi-scale EKG view renderer.
//
// All four levels share the same X axis, the same band stack, and the same
// shared-event spines. The only thing that changes per band is what its
// `cells` look like — and the dispatch happens here. The layout module owns
// every numeric decision; the renderer is intentionally "dumb".
//
// Layer organisation (front-to-back, lowest to highest):
//   l-bg      : band backgrounds, axis baseline, grid lines
//   l-meta    : band labels, axis ticks, DF arcs within bands
//   l-bands   : per-band content (L0 strips, L1 nodes, L2 rows, L3 events)
//   l-spines  : shared-event vertical guides + clickable hit areas
//   l-overlay : transient overlays (e.g. the wheel-zoom hint)
//
// Each band is wrapped in its own <g.ekg-band data-type="..."> so screen-side
// code can fade them per band during level transitions without touching the
// rest of the view (ZMLT persistence: bands never disappear when their
// encoding changes, just morph).

import { ellipsis } from "./shared.js";

export function drawEkgView(svg, layout, callbacks = {}) {
  if (!svg || !layout) return;
  // Wipe previous render but keep <defs> if any (we don't use markers here).
  svg.selectAll("*:not(defs)").remove();

  const layers = {
    bg:       svg.append("g").attr("class", "ekg-l-bg"),
    meta:     svg.append("g").attr("class", "ekg-l-meta"),
    bands:    svg.append("g").attr("class", "ekg-l-bands"),
    spines:   svg.append("g").attr("class", "ekg-l-spines"),
    scrubber: svg.append("g").attr("class", "ekg-l-scrubber"),
    overlay:  svg.append("g").attr("class", "ekg-l-overlay"),
  };

  drawScrubber(layout, layers, callbacks);
  drawAxis(layout, layers, callbacks);
  drawSyncStrip(layout, layers, callbacks);
  layout.bands.forEach(band => drawBand(band, layout, layers, callbacks));
  drawSharedSpines(layout, layers, callbacks);
}

// ── Top time scrubber ─────────────────────────────────────────────────────
//
// Drawn as the first thing in the main SVG so it's always above the bands and
// always discoverable. Three visual layers:
//   1. Card background (very subtle gray, helps the scrubber feel "click-able"
//      without competing with the bands below)
//   2. Density area (the full-range event count curve — global context)
//   3. Viewport rectangle with left/right grab handles (the user's "window")
//
// Click on the empty card → recentre the window there. Drag inside the
// rectangle → pan. Drag a handle → resize. Click outside the rectangle on
// the card → recentre.

function drawScrubber(layout, layers, callbacks) {
  const s = layout.scrubber;
  if (!s || !s.w) return;
  const g = layers.scrubber;

  // Card background
  g.append("rect")
    .attr("class", "ekg-scrubber-card")
    .attr("x", s.x).attr("y", s.y)
    .attr("width", s.w).attr("height", s.height)
    .attr("fill", "rgba(248,250,252,0.85)")
    .attr("stroke", "rgba(148,163,184,0.32)")
    .attr("rx", 6).attr("ry", 6)
    .style("cursor", "pointer")
    .on("click", (event) => {
      // Recentre only when the click missed the viewport rect / handle.
      const cls = event.target.classList ?? { contains: () => false };
      if (cls.contains("ekg-scrubber-viewport") || cls.contains("ekg-scrubber-handle")) return;
      const px = _localX(event, g.node());
      callbacks.onScrubberRecentre?.(px, s);
    });

  // Density curve
  if (s.path) {
    g.append("path")
      .attr("class", "ekg-scrubber-density")
      .attr("d", s.path)
      .attr("fill", "rgba(37,99,235,0.16)")
      .attr("stroke", "rgba(37,99,235,0.55)")
      .attr("stroke-width", 1)
      .attr("pointer-events", "none");
  }

  // Side labels: data range
  g.append("text")
    .attr("class", "ekg-scrubber-side")
    .attr("x", s.x - 6).attr("y", s.y + s.height / 2 + 4)
    .attr("text-anchor", "end")
    .attr("font-family", "JetBrains Mono, monospace")
    .attr("font-size", "9.5px")
    .attr("fill", "#94a3b8")
    .text(_compactDate(s.dataRange.t0));
  g.append("text")
    .attr("class", "ekg-scrubber-side")
    .attr("x", s.x + s.w + 6).attr("y", s.y + s.height / 2 + 4)
    .attr("font-family", "JetBrains Mono, monospace")
    .attr("font-size", "9.5px")
    .attr("fill", "#94a3b8")
    .text(_compactDate(s.dataRange.t1));

  // Viewport rectangle
  const v = s.viewportRect;
  const minW = 6;
  const rectW = Math.max(v.x1 - v.x0, minW);
  g.append("rect")
    .attr("class", "ekg-scrubber-viewport")
    .attr("data-handle", "pan")
    .attr("x", v.x0).attr("y", v.y)
    .attr("width", rectW).attr("height", v.h)
    .attr("fill", "rgba(37,99,235,0.22)")
    .attr("stroke", "rgba(37,99,235,0.9)")
    .attr("stroke-width", 1.6)
    .attr("rx", 4).attr("ry", 4)
    .style("cursor", "grab");

  // Grab handles (left / right edges)
  ["left", "right"].forEach(side => {
    const cx = side === "left" ? v.x0 : v.x1;
    g.append("rect")
      .attr("class", `ekg-scrubber-handle ekg-scrubber-handle-${side}`)
      .attr("data-handle", side)
      .attr("x", cx - 4).attr("y", v.y - 2)
      .attr("width", 8).attr("height", v.h + 4)
      .attr("fill", "rgba(37,99,235,0)")
      .style("cursor", "ew-resize");
  });

  // Single pointer wiring on the layer for pan + resize gestures. Live
  // updates are pushed to the screen via onScrubberDrag — exactly the same
  // contract the bottom minimap used to have, so existing handlers in
  // screens/ekg.js continue to work.
  let dragMode = null;
  let dragStartX = 0;
  let dragStartRect = null;
  g.on("pointerdown", (event) => {
    const handle = event.target?.getAttribute?.("data-handle");
    if (!handle) return;
    dragMode = handle === "pan" ? "pan" : `resize-${handle}`;
    dragStartX = _localX(event, g.node());
    dragStartRect = { ...v };
    event.target.setPointerCapture?.(event.pointerId);
    event.stopPropagation();
  });
  g.on("pointermove", (event) => {
    if (!dragMode) return;
    const x = _localX(event, g.node());
    const dx = x - dragStartX;
    callbacks.onScrubberDrag?.(dragMode, dx, dragStartRect, s);
  });
  g.on("pointerup", (event) => {
    if (!dragMode) return;
    event.target?.releasePointerCapture?.(event.pointerId);
    dragMode = null;
    callbacks.onScrubberDragEnd?.();
  });
}

function _localX(event, node) {
  const rect = node.getBoundingClientRect();
  // Account for SVG viewBox scaling: the layer's bounding rect width may
  // differ from the viewBox width, so we convert client pixels back to
  // layout pixels using the parent SVG's viewBox scale.
  const svg = node.ownerSVGElement;
  const viewBox = svg?.viewBox?.baseVal;
  const scale = viewBox && viewBox.width ? viewBox.width / rect.width : 1;
  return (event.clientX - rect.left) * scale;
}

function _compactDate(t) {
  const d = new Date(t);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-GB", { month: "short", year: "2-digit" });
}

// ── Synchronisation strip (aggregated shared-event density) ────────────────
//
// A single thin row directly under the axis, summarising "how many shared
// events happened in each time bin". This is the cheap, calm replacement for
// the wall of vertical spine lines the old code drew.

function drawSyncStrip(layout, layers, _callbacks) {
  const strip = layout.syncStrip;
  if (!strip || strip.totalSpines === 0) return;

  // Strip background (very faint so it doesn't compete with the axis line)
  layers.bg.append("rect")
    .attr("class", "ekg-sync-strip-bg")
    .attr("x", strip.x).attr("y", strip.y)
    .attr("width", strip.w).attr("height", strip.height)
    .attr("fill", "rgba(124,58,237,0.03)")
    .attr("rx", 4).attr("ry", 4);

  // Density cells
  layers.bg.selectAll(".ekg-sync-cell").data(strip.bins).enter().append("rect")
    .attr("class", "ekg-sync-cell")
    .attr("x", d => d.x + 0.5)
    .attr("y", d => strip.y + strip.height * (1 - d.intensity))
    .attr("width", d => Math.max(d.w - 1, 1))
    .attr("height", d => strip.height * d.intensity)
    .attr("fill", "rgba(124,58,237,0.5)");

  // Right-side label
  layers.meta.append("text")
    .attr("class", "ekg-sync-strip-label")
    .attr("x", strip.x + strip.w + 4)
    .attr("y", strip.y + strip.height / 2 + 3)
    .attr("font-family", "JetBrains Mono, monospace")
    .attr("font-size", "9.5px")
    .attr("fill", "#7c3aed")
    .attr("opacity", 0.7)
    .text(`${strip.totalSpines.toLocaleString()} shared`);
}

// ── Axis ────────────────────────────────────────────────────────────────────

function drawAxis(layout, layers, _callbacks) {
  const { axis, innerLeft, innerRight } = layout;
  layers.bg.append("line")
    .attr("class", "ekg-axis-baseline")
    .attr("x1", innerLeft).attr("x2", innerRight)
    .attr("y1", axis.lineY).attr("y2", axis.lineY)
    .attr("stroke", "rgba(100,116,139,0.4)")
    .attr("stroke-width", 1);

  axis.ticks.forEach(tick => {
    layers.meta.append("line")
      .attr("class", "ekg-axis-tick")
      .attr("x1", tick.x).attr("x2", tick.x)
      .attr("y1", axis.lineY - 4).attr("y2", axis.lineY)
      .attr("stroke", "rgba(100,116,139,0.65)")
      .attr("stroke-width", 1);
    layers.meta.append("text")
      .attr("class", "ekg-axis-label")
      .attr("x", tick.x).attr("y", axis.labelY)
      .attr("text-anchor", "middle")
      .attr("font-family", "JetBrains Mono, monospace")
      .attr("font-size", "10px")
      .attr("fill", "#475569")
      .text(tick.label);
  });
}

// ── Per-band dispatch ───────────────────────────────────────────────────────

function drawBand(band, layout, layers, callbacks) {
  const g = layers.bands.append("g")
    .attr("class", `ekg-band ekg-band-${band.render}`)
    .attr("data-type", band.type)
    .attr("data-level", band.render);

  // Hairline separator just above the band — anchors the eye to the start of
  // the band's content. No background card; whitespace does the rest.
  layers.bg.append("line")
    .attr("class", "ekg-band-separator")
    .attr("x1", layout.pad.x).attr("x2", layout.innerRight + 12)
    .attr("y1", band.y).attr("y2", band.y)
    .attr("stroke", "rgba(148,163,184,0.20)")
    .attr("stroke-width", 1);

  // Whole-band invisible hit area so clicking blank space in the band still
  // focuses the type — but no visible background, just whitespace.
  layers.bg.append("rect")
    .attr("class", "ekg-band-hit")
    .attr("data-type", band.type)
    .attr("x", layout.pad.x).attr("y", band.y)
    .attr("width", layout.innerRight + 12 - layout.pad.x).attr("height", band.height)
    .attr("fill", "transparent")
    .style("cursor", "pointer")
    .on("click", () => callbacks.onBandHeaderClick?.(band));

  // Band header: type label + entity count, hover for description, click to
  // set type focus (handled by the screen). The label is bigger and uses the
  // role's accent colour as a subtle 3px left-edge bar instead of a dot.
  const headerG = layers.meta.append("g")
    .attr("class", "ekg-band-header")
    .attr("data-type", band.type)
    .style("cursor", "pointer")
    .on("click", () => callbacks.onBandHeaderClick?.(band))
    .on("mouseenter", (event) => callbacks.onTooltipShow?.(_bandTooltip(band), event))
    .on("mouseleave", () => callbacks.onTooltipHide?.());

  headerG.append("rect")
    .attr("x", layout.pad.x).attr("y", band.headerY + 4)
    .attr("width", 3).attr("height", 16)
    .attr("fill", band.color).attr("rx", 1.5);
  headerG.append("text")
    .attr("x", layout.pad.x + 12).attr("y", band.headerY + 14)
    .attr("font-family", "Inter, system-ui, sans-serif")
    .attr("font-size", "13.5px")
    .attr("font-weight", "600")
    .attr("fill", "#0f172a")
    .text(ellipsis(band.label, 16));
  headerG.append("text")
    .attr("x", layout.pad.x + 12).attr("y", band.headerY + 14)
    .attr("dy", "1.35em")
    .attr("font-family", "JetBrains Mono, monospace")
    .attr("font-size", "9.5px")
    .attr("fill", "#94a3b8")
    .text(`${band.entityCount.toLocaleString()} ${band.entityCount === 1 ? "entity" : "entities"}`);

  if (band.render === "L0") drawBandL0(band, layout, g, callbacks);
  else if (band.render === "L1") drawBandL1(band, layout, g, callbacks);
  else if (band.render === "L2") drawBandL2(band, layout, g, callbacks);
  else if (band.render === "L3") drawBandL3(band, layout, g, callbacks);
}

// ── L0 Galaxy: density heat strip ───────────────────────────────────────────

function drawBandL0(band, _layout, g, callbacks) {
  const { bins, stripY, stripH, maxBin } = band.cells;
  if (!bins.length) {
    g.append("text")
      .attr("x", _layout.innerLeft + 4).attr("y", stripY + stripH / 2 + 4)
      .attr("font-family", "Inter, system-ui, sans-serif")
      .attr("font-size", "11px").attr("fill", "#94a3b8")
      .text("No events in this window");
    return;
  }

  // Min/max intensity → opacity. We add a small constant so even very low
  // counts are visible at all (cf. Tufte's "small multiples" — every cell
  // should be readable, not vanish).
  const opacity = d => 0.18 + 0.78 * Math.sqrt(d);

  g.selectAll(".ekg-l0-cell").data(bins).enter().append("rect")
    .attr("class", "ekg-l0-cell")
    .attr("data-bin", d => d.binIndex)
    .attr("data-activity", d => d.topActivity ?? "")
    .attr("data-search-key", d => `bin:${band.type}:${d.binIndex}`)
    .attr("x", d => d.x)
    .attr("y", stripY)
    .attr("width", d => Math.max(d.w - 1, 1))
    .attr("height", stripH)
    .attr("fill", band.color)
    .attr("fill-opacity", d => opacity(d.intensity))
    .attr("rx", 2).attr("ry", 2)
    .style("cursor", "pointer")
    .on("click", (_event, d) => callbacks.onBinClick?.(d, band))
    .on("mouseenter", (event, d) => callbacks.onTooltipShow?.(_binTooltip(d, band, maxBin), event))
    .on("mouseleave", () => callbacks.onTooltipHide?.());
}

// ── L1 District: activity nodes + within-band DF arcs ───────────────────────

function drawBandL1(band, _layout, g, callbacks) {
  const { nodes, edges } = band.cells;

  // Arcs first so they sit under the nodes
  g.selectAll(".ekg-l1-edge").data(edges).enter().append("path")
    .attr("class", "ekg-l1-edge")
    .attr("d", d => `M${d.x1},${d.y1} Q${d.cx},${d.cy} ${d.x2},${d.y2}`)
    .attr("fill", "none")
    .attr("stroke", "rgba(37,99,235,0.40)")
    .attr("stroke-width", d => d.sw)
    .attr("stroke-linecap", "round");

  // Determine which activities deserve a permanent label. Top-3 by count
  // keeps the band readable at L1; the rest are accessible via hover.
  const topLabelSet = new Set(
    [...nodes].sort((a, b) => b.count - a.count).slice(0, 3).map(n => n.activity)
  );

  const nodeG = g.selectAll(".ekg-l1-node").data(nodes).enter().append("g")
    .attr("class", "ekg-l1-node")
    .attr("data-activity", d => d.activity)
    .attr("data-search-key", d => `activity:${d.activity}`)
    .attr("transform", d => `translate(${d.x},${d.y})`)
    .style("cursor", "pointer")
    .on("click", (_event, d) => callbacks.onActivityNodeClick?.(d, band))
    .on("mouseenter", (event, d) => callbacks.onTooltipShow?.(_activityNodeTooltip(d, band), event))
    .on("mouseleave", () => callbacks.onTooltipHide?.());

  nodeG.append("circle")
    .attr("r", d => d.r)
    .attr("fill", "rgba(37,99,235,0.08)")
    .attr("stroke", "rgba(37,99,235,0.55)")
    .attr("stroke-width", 1.2);
  // Count text only when the bubble is big enough to fit it cleanly (≥ 9 px),
  // otherwise drop it — the size already encodes frequency.
  nodeG.filter(d => d.r >= 9).append("text")
    .attr("text-anchor", "middle")
    .attr("dy", "0.34em")
    .attr("font-family", "JetBrains Mono, monospace")
    .attr("font-size", "9px")
    .attr("font-weight", "700")
    .attr("fill", "#1e3a8a")
    .text(d => d.count);
  // Top-3 activity labels only — keeps the band readable without overlap.
  nodeG.filter(d => topLabelSet.has(d.activity)).append("text")
    .attr("class", "ekg-l1-label")
    .attr("text-anchor", "middle")
    .attr("dy", d => d.r + 12)
    .attr("font-family", "Inter, system-ui, sans-serif")
    .attr("font-size", "10px")
    .attr("font-weight", "500")
    .attr("fill", "#475569")
    .text(d => ellipsis(d.activity, 16));
}

// ── L2 Neighbourhood: per-entity sparklines ────────────────────────────────

function drawBandL2(band, layout, g, callbacks) {
  const { rows, truncated, visibleCount, cap } = band.cells;

  if (!rows.length) {
    g.append("text")
      .attr("x", layout.innerLeft + 4).attr("y", band.contentY + band.contentH / 2)
      .attr("font-family", "Inter, system-ui, sans-serif")
      .attr("font-size", "11px").attr("fill", "#94a3b8")
      .text("No entities of this type in the visible window.");
    return;
  }

  // Row background — alternating zebra to help long datasets stay legible.
  const rowsG = g.append("g").attr("class", "ekg-l2-rows");
  rows.forEach((row, i) => {
    if (i % 2 === 1) {
      rowsG.append("rect")
        .attr("class", "ekg-l2-row-stripe")
        .attr("x", layout.innerLeft).attr("y", row.rowY)
        .attr("width", layout.innerRight - layout.innerLeft).attr("height", row.rowH)
        .attr("fill", "rgba(248,250,252,0.7)");
    }
  });

  // Row baselines (faint horizontal track for each entity)
  rows.forEach(row => {
    rowsG.append("line")
      .attr("class", "ekg-l2-row-baseline")
      .attr("x1", row.firstX).attr("x2", row.lastX)
      .attr("y1", row.midY).attr("y2", row.midY)
      .attr("stroke", "rgba(148,163,184,0.32)")
      .attr("stroke-width", 0.8);
  });

  // Event marks
  const eventLayer = g.append("g").attr("class", "ekg-l2-events");
  rows.forEach(row => {
    const rowG = eventLayer.append("g")
      .attr("class", "ekg-l2-row")
      .attr("data-entity-id", row.entity_id)
      .attr("data-search-key", `entity:${row.entity_id}`)
      .style("cursor", "pointer")
      .on("click", (event) => {
        // Bubble the row click only if the user didn't hit an event mark
        if (event.target?.classList?.contains?.("ekg-l2-event")) return;
        callbacks.onSparklineRowClick?.(row, band);
      })
      .on("mouseenter", (event) => callbacks.onTooltipShow?.(_sparklineRowTooltip(row, band), event))
      .on("mouseleave", () => callbacks.onTooltipHide?.());

    rowG.selectAll(".ekg-l2-event").data(row.events).enter().append("circle")
      .attr("class", d => `ekg-l2-event${d.isShared ? " ekg-l2-event-shared" : ""}`)
      .attr("data-event-id", d => d.event_id)
      .attr("data-activity", d => d.activity)
      .attr("data-search-key", d => `event:${d.event_id}|activity:${d.activity}`)
      .attr("cx", d => d.x)
      .attr("cy", row.midY)
      .attr("r", d => d.isShared ? row.eventR + 0.8 : row.eventR)
      .attr("fill", d => d.color)
      .attr("stroke", d => d.isShared ? "#0f172a" : "transparent")
      .attr("stroke-width", d => d.isShared ? 0.8 : 0)
      .on("click", (event, d) => {
        event.stopPropagation();
        callbacks.onEventClick?.(d, row, band);
      })
      .on("mouseenter", (event, d) => callbacks.onTooltipShow?.(_eventTooltip(d, row, band), event))
      .on("mouseleave", () => callbacks.onTooltipHide?.());
  });

  // "+N more" hint when entities were capped
  if (truncated > 0) {
    g.append("text")
      .attr("class", "ekg-l2-truncated")
      .attr("x", layout.innerRight - 6)
      .attr("y", band.contentY + band.contentH - 2)
      .attr("text-anchor", "end")
      .attr("font-family", "JetBrains Mono, monospace")
      .attr("font-size", "9.5px")
      .attr("fill", "#94a3b8")
      .text(`+${truncated.toLocaleString()} more (cap ${cap}) · ${visibleCount} in window`);
  }
}

// ── L3 Street: focused single-entity detail ────────────────────────────────

function drawBandL3(band, layout, g, callbacks) {
  const { row } = band.cells;
  if (!row) {
    g.append("text")
      .attr("x", layout.innerLeft + 8)
      .attr("y", band.contentY + band.contentH / 2)
      .attr("font-family", "Inter, system-ui, sans-serif")
      .attr("font-size", "12px")
      .attr("fill", "#94a3b8")
      .text("L3 needs a focused entity — pick one at L2 or search by id.");
    return;
  }

  // DF strands first
  g.selectAll(".ekg-l3-strand").data(row.strands).enter().append("line")
    .attr("class", "ekg-l3-strand")
    .attr("x1", d => d.x1).attr("x2", d => d.x2)
    .attr("y1", d => d.y).attr("y2", d => d.y)
    .attr("stroke", "rgba(37,99,235,0.55)")
    .attr("stroke-width", 1.4)
    .attr("stroke-linecap", "round");

  // Entity label on the left
  g.append("text")
    .attr("x", layout.innerLeft - 6)
    .attr("y", row.rowY - 8)
    .attr("text-anchor", "end")
    .attr("font-family", "Inter, system-ui, sans-serif")
    .attr("font-size", "12px")
    .attr("font-weight", "700")
    .attr("fill", "#0f172a")
    .text(ellipsis(row.label, 22));

  // Event marks — bigger, with activity labels underneath
  const evG = g.append("g").attr("class", "ekg-l3-events");
  row.events.forEach(event => {
    const eg = evG.append("g")
      .attr("class", `ekg-l3-event${event.isShared ? " ekg-l3-event-shared" : ""}`)
      .attr("data-event-id", event.event_id)
      .attr("data-search-key", `event:${event.event_id}|activity:${event.activity}`)
      .attr("transform", `translate(${event.x},${row.rowY + row.eventR})`)
      .style("cursor", "pointer")
      .on("click", () => callbacks.onEventClick?.(event, row, band))
      .on("mouseenter", (ev) => callbacks.onTooltipShow?.(_eventTooltip(event, row, band), ev))
      .on("mouseleave", () => callbacks.onTooltipHide?.());
    eg.append("circle")
      .attr("r", row.eventR)
      .attr("fill", event.color)
      .attr("stroke", event.isShared ? "#0f172a" : "#ffffff")
      .attr("stroke-width", event.isShared ? 1.4 : 1);
    eg.append("text")
      .attr("y", row.eventR + 14)
      .attr("text-anchor", "middle")
      .attr("font-family", "Inter, system-ui, sans-serif")
      .attr("font-size", "10px")
      .attr("font-weight", "600")
      .attr("fill", "#334155")
      .text(ellipsis(event.activity, 12));
  });
}

// ── Shared-event spines — aggregated by default, full only when focused ────
//
// Two passes:
//   1. CLUSTER DOTS: one dot per cluster (set of spines within clusterMinSep
//      pixels), sized by member count. The dots sit *inside* the sync strip
//      so users can read density + drill into events from the same place.
//   2. FOCUSED FULL VERTICAL: if a spine is focused, draw the original
//      coloured vertical line through every band it touches — this is the
//      only time the wall-of-stripes appearance shows up, and only for one
//      event the user explicitly asked about.

function drawSharedSpines(layout, layers, callbacks) {
  const clusters = layout.spineClusters ?? [];
  const focused = layout.focusedSpine;

  // Focused full vertical first, so cluster dots draw on top.
  if (focused) {
    layers.spines.append("line")
      .attr("class", "ekg-spine-line ekg-spine-focused")
      .attr("x1", focused.x).attr("x2", focused.x)
      .attr("y1", focused.y0).attr("y2", focused.y1)
      .attr("stroke", focused.color)
      .attr("stroke-opacity", 0.9)
      .attr("stroke-width", 1.6);
  }

  if (!clusters.length) return;

  // One dot per cluster. Multi-event clusters get a stroked ring; singletons
  // get a flat dot, so users can read "lots of stuff happened here" from a
  // glance. Click any dot to drill into a list of underlying events.
  const dotG = layers.spines.selectAll(".ekg-spine-cluster").data(clusters).enter().append("g")
    .attr("class", "ekg-spine-cluster")
    .attr("data-count", d => d.count)
    .attr("data-search-key", d => `spine-cluster:${d.eventIds.join(",")}`)
    .style("cursor", "pointer")
    .on("click", (_event, d) => callbacks.onSpineClusterClick?.(d))
    .on("mouseenter", (event, d) => callbacks.onTooltipShow?.(_spineClusterTooltip(d), event))
    .on("mouseleave", () => callbacks.onTooltipHide?.());

  const maxCount = Math.max(1, ...clusters.map(c => c.count));
  dotG.append("circle")
    .attr("class", "ekg-spine-dot")
    .attr("cx", d => d.x).attr("cy", d => d.dotY)
    .attr("r", d => 2 + Math.sqrt(d.count / maxCount) * 3.6)
    .attr("fill", d => d.count > 1 ? "rgba(124,58,237,0.85)" : "rgba(124,58,237,0.55)")
    .attr("stroke", "#ffffff")
    .attr("stroke-width", 0.8);
}

// ── Legacy bottom minimap (kept exported temporarily; no longer called) ────
//
// The bottom minimap has been replaced by the top scrubber. This function is
// kept for one release so old callers don't break if they're still importing
// it; the new path is `drawScrubber`, invoked automatically by drawEkgView.
export function drawMinimap(svg, layout, callbacks = {}) {
  if (!svg || !layout?.minimap) return;
  svg.selectAll("*").remove();
  const m = layout.minimap;

  // Card background
  svg.append("rect")
    .attr("x", 0).attr("y", 0)
    .attr("width", "100%").attr("height", m.height)
    .attr("fill", "rgba(248,250,252,0.6)")
    .attr("stroke", "rgba(148,163,184,0.22)")
    .attr("rx", 8).attr("ry", 8);

  // Global density curve
  if (m.path) {
    svg.append("path")
      .attr("d", m.path)
      .attr("fill", "rgba(37,99,235,0.18)")
      .attr("stroke", "rgba(37,99,235,0.55)")
      .attr("stroke-width", 1);
  }

  // Viewport rectangle (the user-draggable window)
  const r = svg.append("g").attr("class", "ekg-minimap-viewport");
  r.append("rect")
    .attr("class", "ekg-minimap-viewport-fill")
    .attr("x", m.viewportRect.x0)
    .attr("y", m.viewportRect.y)
    .attr("width", Math.max(m.viewportRect.x1 - m.viewportRect.x0, 4))
    .attr("height", m.viewportRect.h)
    .attr("fill", "rgba(37,99,235,0.18)")
    .attr("stroke", "rgba(37,99,235,0.85)")
    .attr("stroke-width", 1.4)
    .attr("rx", 4).attr("ry", 4);

  // Resize handles on each edge
  ["left", "right"].forEach(side => {
    const x = side === "left" ? m.viewportRect.x0 : m.viewportRect.x1;
    r.append("rect")
      .attr("class", `ekg-minimap-handle ekg-minimap-handle-${side}`)
      .attr("data-handle", side)
      .attr("x", x - 4).attr("y", m.viewportRect.y - 2)
      .attr("width", 8).attr("height", m.viewportRect.h + 4)
      .attr("fill", "rgba(37,99,235,0.0)")
      .style("cursor", "ew-resize");
  });

  // Click anywhere outside the viewport recentres it
  svg.on("click", (event) => {
    // Only handle if we actually clicked on the SVG background, not a child
    if (event.target.classList?.contains?.("ekg-minimap-handle")) return;
    if (event.target.classList?.contains?.("ekg-minimap-viewport-fill")) return;
    const { offsetX } = _eventXY(event, svg.node());
    callbacks.onMinimapClick?.(offsetX);
  });

  // Pan / resize via drag
  let dragMode = null;
  let dragStartX = 0;
  let dragStartRect = null;
  svg.on("pointerdown", (event) => {
    const cls = event.target.classList ?? { contains: () => false };
    if (cls.contains("ekg-minimap-handle-left")) dragMode = "resize-left";
    else if (cls.contains("ekg-minimap-handle-right")) dragMode = "resize-right";
    else if (cls.contains("ekg-minimap-viewport-fill")) dragMode = "pan";
    else return;
    dragStartX = _eventXY(event, svg.node()).offsetX;
    dragStartRect = { ...m.viewportRect };
    event.target.setPointerCapture?.(event.pointerId);
  });
  svg.on("pointermove", (event) => {
    if (!dragMode) return;
    const { offsetX } = _eventXY(event, svg.node());
    const dx = offsetX - dragStartX;
    callbacks.onMinimapDrag?.(dragMode, dx, dragStartRect, m);
  });
  svg.on("pointerup", (event) => {
    if (!dragMode) return;
    event.target.releasePointerCapture?.(event.pointerId);
    dragMode = null;
    callbacks.onMinimapDragEnd?.();
  });
}

function _eventXY(event, node) {
  const rect = node.getBoundingClientRect();
  return { offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top };
}

// ── Search highlight (in-place dim/glow) ────────────────────────────────────

// Walks the rendered DOM, splitting elements with `data-search-key` into
// match / non-match sets based on the query. We never remove elements —
// users keep their place — only adjust opacity via CSS classes.
export function applyEkgSearch(svg, query) {
  if (!svg) return { matched: 0, total: 0 };
  const q = (query ?? "").trim().toLowerCase();
  const all = svg.selectAll("[data-search-key]").nodes();
  if (!q) {
    all.forEach(n => { n.classList.remove("ekg-search-match", "ekg-search-dim"); });
    return { matched: 0, total: all.length };
  }
  let matched = 0;
  all.forEach(node => {
    const key = node.getAttribute("data-search-key") ?? "";
    const ok = key.toLowerCase().includes(q);
    node.classList.toggle("ekg-search-match", ok);
    node.classList.toggle("ekg-search-dim",  !ok);
    if (ok) matched += 1;
  });
  return { matched, total: all.length };
}

// ── Tooltip builders ────────────────────────────────────────────────────────

function _bandTooltip(band) {
  return `
    <div class="tip-title" style="color:${band.color}">${_esc(band.label)}</div>
    <div class="tip-row">Role: <b>${_esc(band.role)}</b></div>
    <div class="tip-row">Entities: <b>${band.entityCount.toLocaleString()}</b></div>
    <div class="tip-row">Events: <b>${band.eventCount.toLocaleString()}</b></div>
    <div class="tip-hint">Click to focus the inspector on this type</div>
  `;
}

function _binTooltip(bin, band, maxBin) {
  const top = Object.entries(bin.byActivity)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([a, c]) => `<div class="tip-row">${_esc(a)}: <b>${c}</b></div>`)
    .join("");
  const date = new Date(bin.t0).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
  return `
    <div class="tip-title">${_esc(band.label)} · ${_esc(date)}</div>
    <div class="tip-row"><b>${bin.total.toLocaleString()}</b> events · ${Math.round(bin.intensity * 100)}% of bin peak (${maxBin})</div>
    ${top}
    <div class="tip-hint">Click to inspect this bin</div>
  `;
}

function _activityNodeTooltip(node, band) {
  return `
    <div class="tip-title">${_esc(node.activity)}</div>
    <div class="tip-row">On <b>${_esc(band.label)}</b>: <b>${node.count.toLocaleString()}</b> events</div>
    <div class="tip-hint">Click to focus and explore this activity</div>
  `;
}

function _sparklineRowTooltip(row, band) {
  const dur = row.lastTime - row.firstTime;
  const days = (dur / 86400000).toFixed(1);
  return `
    <div class="tip-title">${_esc(row.label)}</div>
    <div class="tip-row">Type: <b>${_esc(band.label)}</b></div>
    <div class="tip-row"><b>${row.events.length}</b> events visible · spans <b>${days}d</b></div>
    <div class="tip-hint">Click to open in Identify (T2)</div>
  `;
}

function _eventTooltip(event, row, band) {
  return `
    <div class="tip-title">${_esc(event.activity)}</div>
    <div class="tip-row">Entity: <b>${_esc(row.label)}</b> (${_esc(band.label)})</div>
    <div class="tip-row">${new Date(event.t).toLocaleString("en-GB")}</div>
    ${event.isShared ? `<div class="tip-row" style="color:#7c3aed">Shared across entities</div>` : ""}
    <div class="tip-hint">Click for event details</div>
  `;
}

function _spineTooltip(spine) {
  return `
    <div class="tip-title">${_esc(spine.activity)}</div>
    <div class="tip-row">Bridges <b>${spine.types.length}</b> types: ${spine.types.map(_esc).join(", ")}</div>
    <div class="tip-row">${spine.sharedEntityCount} entities · ${new Date(spine.t).toLocaleDateString("en-GB")}</div>
    <div class="tip-hint">Click to inspect this synchronisation point</div>
  `;
}

function _spineClusterTooltip(cluster) {
  if (cluster.count === 1) {
    return _spineTooltip(cluster.members[0]);
  }
  const dateMin = new Date(cluster.members[0].t).toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
  const dateMax = new Date(cluster.members[cluster.members.length - 1].t).toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
  return `
    <div class="tip-title">${cluster.count.toLocaleString()} shared events</div>
    <div class="tip-row">${_esc(dateMin)} → ${_esc(dateMax)}</div>
    <div class="tip-row">Across types: ${cluster.types.map(_esc).join(", ")}</div>
    <div class="tip-hint">Click for a list of events in this cluster</div>
  `;
}

// ── Misc ────────────────────────────────────────────────────────────────────

function _levelTagFor(render) {
  return { L0: "L0 GALAXY", L1: "L1 DISTRICT", L2: "L2 NEIGHBOURHOOD", L3: "L3 STREET" }[render] ?? render;
}

function _esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
