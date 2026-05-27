"use strict";

// Renderer for T1 Lifecycle (Population). Two passes:
//   • drawCanvasPass()  — every dot, hot path, runs on every cursor move.
//   • drawOverlayPass() — band headers, axis, activity-row labels, selection
//                          polylines, hover halo, selected-event halo, cursor.
//                          Cheap; only called when layout / selection / hover /
//                          cursor-tick changes.

const TAU = Math.PI * 2;

export function drawCanvasPass(canvas, layout, state) {
  if (!canvas || !layout) return;
  const ctx = canvas.__ctx2d || (canvas.__ctx2d = canvas.getContext("2d"));
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cssW = layout.width;
  const cssH = layout.height;
  const wantW = Math.round(cssW * dpr);
  const wantH = Math.round(cssH * dpr);
  if (canvas.width !== wantW || canvas.height !== wantH) {
    canvas.width = wantW;
    canvas.height = wantH;
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const dots = layout.dotPositions;
  const n = dots.length;
  const searchActive = state.searchQuery && state.searchMatchEntityIds && state.searchMatchEntityIds.size > 0;
  const selectionActive = !!(state.selection && state.selection.highlightedEventIds && state.selection.highlightedEventIds.size > 0);
  const highlightedEvents = selectionActive ? state.selection.highlightedEventIds : null;

  // Alpha layering:
  //   1. base              → 0.78 when no selection, else (1.0 highlighted | 0.05 dimmed)
  //   2. search multiplier → ×0.20 if entity not in search matches
  const SEARCH_DIM_FACTOR = 0.20;
  const SELECTION_DIM = 0.05;          // near-invisible; selection takes the stage
  const SELECTION_HIGHLIGHT = 1.0;
  const BASE = 0.78;

  for (let i = 0; i < n; i++) {
    const d = dots[i];
    let alpha;
    if (selectionActive) {
      alpha = highlightedEvents.has(String(d.eventId)) ? SELECTION_HIGHLIGHT : SELECTION_DIM;
    } else {
      alpha = BASE;
    }
    if (searchActive && !state.searchMatchEntityIds.has(d.entityId)) alpha *= SEARCH_DIM_FACTOR;

    ctx.globalAlpha = Math.min(1, alpha);
    ctx.fillStyle = d.color;
    ctx.beginPath();
    ctx.arc(d.x, d.y, d.radius, 0, TAU);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

export function drawOverlayPass(svg, layout, state, store, callbacks) {
  if (!svg || !layout || typeof d3 === "undefined") return;
  const s = d3.select(svg);
  s.attr("width", layout.width)
   .attr("height", layout.height)
   .attr("viewBox", `0 0 ${layout.width} ${layout.height}`);
  s.selectAll("*").remove();

  _drawBands(s, layout);
  _drawActivityLabels(s, layout);
  _drawAxis(s, layout);
  if (state.selection) _drawSelectionPolylines(s, layout, state, store, callbacks);
  if (state.selection) _drawSelectionHalo(s, layout, state);
  if (state.hoveredDotIndex != null) _drawHoverHalo(s, layout, state);
}

function _drawBands(s, layout) {
  const g = s.append("g").attr("class", "t1-band-headers");
  layout.bands.forEach(b => {
    const h = b.y1 - b.y0;
    const row = g.append("g").attr("transform", `translate(0,${b.y0})`);
    row.append("rect")
      .attr("x", 0).attr("y", 0)
      .attr("width", layout.bandHeaderW - 6).attr("height", h)
      .attr("fill", b.color).attr("fill-opacity", 0.07);
    row.append("rect")
      .attr("x", 0).attr("y", 0).attr("width", 3).attr("height", h)
      .attr("fill", b.color);
    row.append("text")
      .attr("class", "t1-band-label")
      .attr("x", 12).attr("y", 14)
      .text(b.label);
    row.append("text")
      .attr("class", "t1-band-count")
      .attr("x", 12).attr("y", 28)
      .text(`${b.entityCount} entities · ${b.activities.length} activities`);

    // Band divider line across the data area.
    s.append("line")
      .attr("class", "t1-band-divider")
      .attr("x1", layout.innerLeft).attr("x2", layout.innerRight)
      .attr("y1", b.y1 + 1).attr("y2", b.y1 + 1)
      .attr("stroke", "#e2e8f0").attr("stroke-width", 1);
  });
}

function _drawActivityLabels(s, layout) {
  const g = s.append("g").attr("class", "t1-activity-labels");
  layout.activityLabels.forEach(a => {
    // Faint row guide so labels line up visually with their dot row.
    s.append("line")
      .attr("class", "t1-activity-guide")
      .attr("x1", layout.innerLeft).attr("x2", layout.innerRight)
      .attr("y1", a.y).attr("y2", a.y)
      .attr("stroke", a.inSelection ? "#e2e8f0" : "#f5f5f7")
      .attr("stroke-width", 1);
    const text = g.append("text")
      .attr("class", "t1-activity-label" + (a.inSelection === false && layout.hasSelection ? " is-dim" : ""))
      .attr("x", a.x).attr("y", a.y + 3)
      .attr("text-anchor", "end")
      .text(a.label);
    text.append("title").text(`${a.full} · ${a.count} events`);
  });
}

function _drawAxis(s, layout) {
  const axisY = layout.innerBottom + 6;
  const g = s.append("g").attr("class", "t1-axis");
  g.append("line")
    .attr("x1", layout.innerLeft).attr("x2", layout.innerRight)
    .attr("y1", axisY).attr("y2", axisY)
    .attr("stroke", "#cbd5e1");
  layout.axisTicks.forEach(t => {
    const tg = g.append("g").attr("transform", `translate(${t.x},${axisY})`);
    tg.append("line").attr("y2", 5).attr("stroke", "#94a3b8");
    tg.append("text")
      .attr("class", "t1-axis-tick")
      .attr("y", 18).attr("text-anchor", "middle")
      .text(t.label);
  });
}

function _drawSelectionPolylines(s, layout, state, store, callbacks) {
  const sel = state.selection;
  if (!sel?.highlightedEntityIds?.size) return;
  const g = s.append("g").attr("class", "t1-selection-paths");
  const primaryId = sel.primaryEntityId;

  sel.highlightedEntityIds.forEach(entityId => {
    const ordered = layout.eventPosByEntity.get(entityId);
    if (!ordered || ordered.length === 0) return;
    const entity = store?.entityById?.[entityId];
    const typeColor = layout.bands.find(b => b.type === entity?.primary_type)?.color ?? "#0f172a";
    const isPrimary = entityId === primaryId;
    const stroke = isPrimary ? 2.2 : 1.4;
    const opacity = isPrimary ? 1.0 : 0.85;

    // Build the polyline points string in time order. Discontinuities are not
    // a concern because eventPosByEntity already filters to in-window events.
    const pts = ordered.map(p => `${p.x},${p.y}`).join(" ");
    if (ordered.length >= 2) {
      g.append("polyline")
        .attr("class", "t1-selection-line" + (isPrimary ? " t1-selection-line-primary" : ""))
        .attr("data-entity-id", entityId)
        .attr("points", pts)
        .attr("fill", "none")
        .attr("stroke", typeColor)
        .attr("stroke-width", stroke)
        .attr("stroke-opacity", opacity)
        .attr("stroke-linecap", "round")
        .attr("stroke-linejoin", "round")
        .style("cursor", "pointer")
        .on("click", () => callbacks?.onSelectionLineClick?.(entityId));
    }
    // Small ring markers at each event of the highlighted entity (subtle).
    ordered.forEach(p => {
      g.append("circle")
        .attr("cx", p.x).attr("cy", p.y)
        .attr("r", isPrimary ? 3.4 : 2.8)
        .attr("fill", "none")
        .attr("stroke", typeColor)
        .attr("stroke-width", isPrimary ? 1.3 : 1.0)
        .attr("opacity", opacity);
    });
  });
}

function _drawSelectionHalo(s, layout, state) {
  const sel = state.selection;
  if (!sel?.eventId) return;
  // Find the dot for the selected event in the primary entity's band.
  // If the dot isn't in the visible time window, skip the halo (the polyline
  // will still convey direction).
  const dots = layout.dotPositions;
  for (let i = 0; i < dots.length; i++) {
    const d = dots[i];
    if (String(d.eventId) === String(sel.eventId) && d.entityId === sel.primaryEntityId) {
      s.append("circle")
        .attr("class", "t1-selection-halo")
        .attr("cx", d.x).attr("cy", d.y).attr("r", d.radius + 3)
        .attr("fill", "none").attr("stroke", "#0f172a").attr("stroke-width", 1.5);
      return;
    }
  }
}

function _drawHoverHalo(s, layout, state) {
  const d = layout.dotPositions[state.hoveredDotIndex];
  if (!d) return;
  s.append("circle")
    .attr("class", "t1-hover-halo")
    .attr("cx", d.x).attr("cy", d.y).attr("r", d.radius + 4)
    .attr("fill", "none").attr("stroke", "#0f172a").attr("stroke-width", 1.5);
}

