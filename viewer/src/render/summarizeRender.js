"use strict";

// Renderer for T1 Lifecycle (Population). Two passes:
//   • drawCanvasPass()  — every dot, hot path, runs on every cursor move.
//   • drawOverlayPass() — band headers, axis, shared-event ticks, pinned
//                          df-paths, hover halo, playback cursor. Cheap; only
//                          called when layout/pin/hover/cursor changes.

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
  const cursorT = state.cursorT;
  const fade = state.fadeFuture !== false;
  const searchActive = state.searchQuery && state.searchMatchEntityIds && state.searchMatchEntityIds.size > 0;
  const pinned = state.pinnedEntityIds;
  const hasPinned = pinned && pinned.size > 0;

  for (let i = 0; i < n; i++) {
    const d = dots[i];
    let alpha;
    if (fade && d.t > cursorT) alpha = 0.10;
    else alpha = 0.78;
    if (searchActive && !state.searchMatchEntityIds.has(d.entityId)) alpha *= 0.18;
    if (hasPinned && pinned.has(d.entityId)) alpha = Math.min(1, alpha + 0.15);

    ctx.globalAlpha = alpha;
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
  _drawAxis(s, layout);
  // Shared-event ticks deliberately omitted from the overlay: on dense bundles
  // they collapse into vertical bars. Shared-ness is conveyed by the
  // per-dot 1.4× radius bump and the hover tooltip's "Shared event" line.
  if (state.pinnedEntityIds?.size) _drawPinnedPaths(s, layout, state, store, callbacks);
  if (state.hoveredDotIndex != null) _drawHoverHalo(s, layout, state);
  _drawCursor(s, layout, state, callbacks);
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
      .text(`${b.entityCount} entities`);

    // Faint band horizontal guide across the canvas.
    s.append("line")
      .attr("class", "t1-band-divider")
      .attr("x1", layout.innerLeft).attr("x2", layout.innerRight)
      .attr("y1", b.y1 + 1).attr("y2", b.y1 + 1)
      .attr("stroke", "#e2e8f0").attr("stroke-width", 1);
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

function _drawPinnedPaths(s, layout, state, store, callbacks) {
  const g = s.append("g").attr("class", "t1-pinned-paths");
  const cursorT = state.cursorT;
  state.pinnedEntityIds.forEach(entityId => {
    const evMap = layout.eventPosByEntity.get(entityId);
    if (!evMap) return;
    const entity = store?.entityById?.[entityId];
    const typeColor = layout.bands.find(b => b.type === entity?.primary_type)?.color ?? "#0f172a";
    const edges = store?.dfByEntityId?.[entityId] ?? [];
    const pathG = g.append("g")
      .attr("class", "t1-pinned-path")
      .attr("data-entity-id", entityId);
    edges.forEach(edge => {
      const aId = String(edge.source_event_id ?? edge.source);
      const bId = String(edge.target_event_id ?? edge.target);
      const a = evMap.get(aId);
      const b = evMap.get(bId);
      if (!a || !b) return;
      const future = a.t > cursorT || b.t > cursorT;
      pathG.append("line")
        .attr("class", "t1-pinned-edge")
        .attr("x1", a.x).attr("y1", a.y).attr("x2", b.x).attr("y2", b.y)
        .attr("stroke", typeColor).attr("stroke-width", 1.8)
        .attr("stroke-opacity", future ? 0.18 : 0.85)
        .attr("stroke-linecap", "round");
    });
    // Pinned-entity dot ring markers
    evMap.forEach((p) => {
      pathG.append("circle")
        .attr("cx", p.x).attr("cy", p.y).attr("r", 3.6)
        .attr("fill", "none").attr("stroke", typeColor).attr("stroke-width", 1.4)
        .attr("opacity", p.t > cursorT ? 0.3 : 0.95);
    });
    pathG.on("click", () => callbacks?.onPinnedPathClick?.(entityId));
  });
}

function _drawHoverHalo(s, layout, state) {
  const d = layout.dotPositions[state.hoveredDotIndex];
  if (!d) return;
  s.append("circle")
    .attr("class", "t1-hover-halo")
    .attr("cx", d.x).attr("cy", d.y).attr("r", d.radius + 4)
    .attr("fill", "none").attr("stroke", "#0f172a").attr("stroke-width", 1.5);
}

function _drawCursor(s, layout, state, callbacks) {
  const clampedT = Math.max(layout.timeWindow.t0, Math.min(layout.timeWindow.t1, state.cursorT));
  const cx = layout.xScale(clampedT);
  const g = s.append("g").attr("class", "t1-cursor");
  g.append("line")
    .attr("x1", cx).attr("x2", cx)
    .attr("y1", layout.innerTop - 10).attr("y2", layout.innerBottom + 2)
    .attr("stroke", "#dc2626").attr("stroke-width", 1.2).attr("stroke-opacity", 0.85);
  // Wider invisible hit zone so the handle is grabbable.
  g.append("rect")
    .attr("class", "t1-cursor-hit")
    .attr("x", cx - 9).attr("y", layout.innerTop - 16)
    .attr("width", 18).attr("height", 16)
    .attr("fill", "transparent")
    .style("cursor", "ew-resize")
    .on("mousedown", ev => callbacks?.onCursorDragStart?.(ev));
  g.append("polygon")
    .attr("class", "t1-cursor-handle")
    .attr("points", `${cx - 6},${layout.innerTop - 14} ${cx + 6},${layout.innerTop - 14} ${cx},${layout.innerTop - 4}`)
    .attr("fill", "#dc2626")
    .style("cursor", "ew-resize")
    .on("mousedown", ev => callbacks?.onCursorDragStart?.(ev));
}
