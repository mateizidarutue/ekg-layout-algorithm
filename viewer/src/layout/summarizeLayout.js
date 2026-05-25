"use strict";

// Pure geometry for the T1 Lifecycle (Population) view.
//
// Takes the output of getEkgView() plus a CSS-pixel viewport and a visible
// time window, returns positioned bands, dot positions, shared-event ticks,
// and an axis-tick list. No DOM, no canvas, no D3 selections.

const BAND_GAP = 6;
const BAND_HEADER_W = 134;
const PAD_TOP = 28;
const PAD_BOTTOM = 56;
const PAD_RIGHT = 18;
const MIN_BAND_HEIGHT = 42;

export function computeSummarizeLayout({ data, viewport, timeWindow, visibleTypes }) {
  const width = Math.max(640, Math.round(viewport?.width ?? 640));
  const height = Math.max(360, Math.round(viewport?.height ?? 360));

  const innerLeft = BAND_HEADER_W;
  const innerRight = width - PAD_RIGHT;
  const innerTop = PAD_TOP;
  const innerBottom = height - PAD_BOTTOM;
  const innerWidth = Math.max(1, innerRight - innerLeft);
  const innerHeight = Math.max(1, innerBottom - innerTop);

  const t0 = Number.isFinite(timeWindow?.t0) ? timeWindow.t0 : data.timeRange.min;
  const t1 = Number.isFinite(timeWindow?.t1) ? timeWindow.t1 : data.timeRange.max;
  const span = Math.max(t1 - t0, 1);
  const xScale = t => innerLeft + ((t - t0) / span) * innerWidth;

  const typeNodeById = new Map();
  (data.typeNodes ?? []).forEach(n => typeNodeById.set(n.id, n));

  // Bands: in band order, drop hidden types and types with zero visible entities.
  const orderedTypes = (data.bandOrder ?? []).filter(t => {
    if (visibleTypes && !visibleTypes.has(t)) return false;
    const rows = data.sparklinesByType?.[t] ?? [];
    return rows.length > 0;
  });

  const counts = orderedTypes.map(t => (data.sparklinesByType[t] ?? []).length);
  const totalCount = counts.reduce((sum, c) => sum + c, 0) || 1;
  const gaps = Math.max(0, (orderedTypes.length - 1) * BAND_GAP);
  const floor = MIN_BAND_HEIGHT * orderedTypes.length;
  const available = Math.max(0, innerHeight - gaps);
  const extra = Math.max(0, available - floor);
  const heights = counts.map(c => MIN_BAND_HEIGHT + extra * (c / totalCount));

  const bands = [];
  const entityYByBand = new Map();
  let cursor = innerTop;

  orderedTypes.forEach((type, i) => {
    const node = typeNodeById.get(type) ?? { label: type, color: "#64748b", role: "other" };
    const rows = data.sparklinesByType[type] ?? [];
    const h = heights[i];
    const y0 = cursor;
    const y1 = cursor + h;
    const rowsY0 = y0 + 16;
    const rowsY1 = y1 - 4;
    const innerH = Math.max(1, rowsY1 - rowsY0);
    const yMap = new Map();
    const n = rows.length;
    rows.forEach((r, k) => {
      const frac = n > 1 ? k / (n - 1) : 0.5;
      yMap.set(r.entity_id, rowsY0 + frac * innerH);
    });
    entityYByBand.set(i, yMap);
    bands.push({
      type, label: node.label, color: node.color, role: node.role,
      y0, y1, headerY: y0 + 12, rowsY0, rowsY1,
      entityCount: n, bandIndex: i,
    });
    cursor = y1 + BAND_GAP;
  });

  // Dot positions filtered to the time window. Pre-allocate event-position maps
  // per entity so the overlay can draw pinned df-paths without rescanning.
  const dotPositions = [];
  const eventPosByEntity = new Map();
  const dotRadiusBase = orderedTypes.length > 10 ? 1.7 : 2.0;

  orderedTypes.forEach((type, bandIndex) => {
    const rows = data.sparklinesByType[type] ?? [];
    const band = bands[bandIndex];
    const yMap = entityYByBand.get(bandIndex);
    rows.forEach(row => {
      const y = yMap.get(row.entity_id);
      const evMap = new Map();
      eventPosByEntity.set(row.entity_id, evMap);
      const evs = row.events;
      for (let i = 0; i < evs.length; i++) {
        const ev = evs[i];
        if (ev.t < t0 || ev.t > t1) continue;
        const x = xScale(ev.t);
        const dotColor = ev.activityColor || band.color;
        dotPositions.push({
          x, y, color: dotColor,
          radius: ev.isShared ? dotRadiusBase * 1.4 : dotRadiusBase,
          eventId: ev.event_id, entityId: row.entity_id, entityType: type,
          bandIndex, isShared: ev.isShared, t: ev.t, activity: ev.activity,
        });
        evMap.set(String(ev.event_id), { x, y, t: ev.t });
      }
    });
  });

  // Shared-event ticks: only spines that touch ≥3 types, in window.
  const typeIndex = new Map();
  orderedTypes.forEach((t, i) => typeIndex.set(t, i));
  const sharedTicks = [];
  const spines = data.spines ?? [];
  for (let i = 0; i < spines.length; i++) {
    const s = spines[i];
    if (s.types.length < 3) continue;
    if (s.t < t0 || s.t > t1) continue;
    const x = xScale(s.t);
    const bandRanges = [];
    for (let j = 0; j < s.types.length; j++) {
      const idx = typeIndex.get(s.types[j]);
      if (idx == null) continue;
      const b = bands[idx];
      if (b) bandRanges.push({ type: s.types[j], y0: b.rowsY0, y1: b.rowsY1 });
    }
    if (!bandRanges.length) continue;
    sharedTicks.push({
      x, t: s.t,
      eventId: s.event_id,
      activity: s.activity,
      types: s.types,
      sharedEntityIds: s.sharedEntityIds,
      bandRanges,
    });
  }

  const axisTicks = _buildAxisTicks(t0, t1, xScale);

  return {
    width, height,
    innerLeft, innerRight, innerTop, innerBottom,
    innerWidth, innerHeight,
    bandHeaderW: BAND_HEADER_W,
    xScale,
    timeWindow: { t0, t1 },
    bands,
    dotPositions,
    sharedTicks,
    axisTicks,
    eventPosByEntity,
  };
}

function _buildAxisTicks(t0, t1, xScale) {
  const span = Math.max(1, t1 - t0);
  const desired = 8;
  const rough = span / desired;
  const day = 86400000;
  let step;
  if (rough <= day / 2) step = day / 2;
  else if (rough <= day) step = day;
  else if (rough <= day * 7) step = day * 7;
  else if (rough <= day * 30) step = day * 30;
  else if (rough <= day * 90) step = day * 90;
  else if (rough <= day * 365) step = day * 365;
  else step = day * 365 * 2;
  const start = Math.ceil(t0 / step) * step;
  const ticks = [];
  for (let t = start; t <= t1; t += step) {
    ticks.push({ t, x: xScale(t), label: _fmtTickLabel(t, step) });
  }
  return ticks;
}

function _fmtTickLabel(t, step) {
  const d = new Date(t);
  const day = 86400000;
  if (step <= day) return d.toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
  if (step <= day * 30) return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
  return d.toLocaleDateString("en-GB", { month: "short", year: "numeric" });
}
