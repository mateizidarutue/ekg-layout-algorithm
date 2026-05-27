"use strict";

// Pure geometry for the T1 Lifecycle (Population) view.
//
// Channel assignment:
//   x     ← event timestamp (within visible time window)
//   y     ← (entity type band, event activity)
//   color ← entity type (band color)
//   shape ← single circle per event
//
// Within each band, distinct activities are stacked as horizontal rows, ordered
// by descending event-count within the band (ties broken alphabetically). The
// y-position of a dot is determined entirely by (bandIndex, event.activity),
// not by which entity it belongs to. This means a single entity's events
// staircase vertically as it transitions activities — the analytically
// meaningful shape we want.

import { ellipsis } from "../render/shared.js";

const BAND_GAP = 8;
const BAND_HEADER_W = 134;
// Activity-row gutter width is derived inside the function based on the
// longest activity label across visible bands, so labels can render in full.
const ACTIVITY_GUTTER_MIN = 150;
const ACTIVITY_GUTTER_MAX = 340;
const ACTIVITY_LABEL_CHAR_PX = 6.6;   // empirical monospace 10px width
const PAD_TOP = 28;
const PAD_BOTTOM = 56;
const PAD_RIGHT = 18;
const MIN_ROW_HEIGHT = 11;            // px per activity row floor
const MIN_BAND_PAD = 6;               // top/bottom padding inside band

// `selectionActivityOrder`, when provided, is a Map<typeName, Array<{ activity, firstT }>>.
// For each entity-type band whose entry is present, the band's activity rows are
// sorted so that those activities (in firstT order) come first, top to bottom;
// any remaining activities fall through to the default frequency ordering below.
// This is what produces the top-left → bottom-right diagonal for a selection's
// primary trace.
export function computeSummarizeLayout({ data, viewport, timeWindow, visibleTypes, selectionActivityOrder = null }) {
  const width = Math.max(640, Math.round(viewport?.width ?? 640));

  const typeNodeById = new Map();
  (data.typeNodes ?? []).forEach(n => typeNodeById.set(n.id, n));

  // Visible bands: in band order, drop hidden types and types with no rows.
  const orderedTypes = (data.bandOrder ?? []).filter(t => {
    if (visibleTypes && !visibleTypes.has(t)) return false;
    return (data.sparklinesByType?.[t] ?? []).length > 0;
  });

  // Pre-collect activity names across all visible bands so we can size the
  // gutter to fit the longest label. This is hoisted before the rest of the
  // geometry because innerLeft depends on the gutter width.
  let longestLabelChars = 0;
  orderedTypes.forEach(type => {
    const rows = data.sparklinesByType[type] ?? [];
    const seen = new Set();
    for (let i = 0; i < rows.length; i++) {
      const evs = rows[i].events;
      for (let j = 0; j < evs.length; j++) {
        const act = evs[j].activity;
        if (!seen.has(act)) { seen.add(act); if (act.length > longestLabelChars) longestLabelChars = act.length; }
      }
    }
  });
  const activityGutterW = Math.max(
    ACTIVITY_GUTTER_MIN,
    Math.min(ACTIVITY_GUTTER_MAX, Math.round(longestLabelChars * ACTIVITY_LABEL_CHAR_PX) + 20)
  );
  const labelCharBudget = Math.max(8, Math.floor((activityGutterW - 12) / ACTIVITY_LABEL_CHAR_PX));

  const innerLeft = BAND_HEADER_W + activityGutterW;
  const innerRight = width - PAD_RIGHT;
  const innerWidth = Math.max(1, innerRight - innerLeft);

  const t0 = Number.isFinite(timeWindow?.t0) ? timeWindow.t0 : data.timeRange.min;
  const t1 = Number.isFinite(timeWindow?.t1) ? timeWindow.t1 : data.timeRange.max;
  const span = Math.max(t1 - t0, 1);
  const xScale = t => innerLeft + ((t - t0) / span) * innerWidth;

  // ── Per-band activity rows ──────────────────────────────────────────────
  // For each band, count event occurrences per activity (across all entities
  // of that type), sort by frequency desc → alpha asc.
  const bandActivityRows = orderedTypes.map(type => {
    const counts = new Map();
    const colors = new Map();
    const rows = data.sparklinesByType[type] ?? [];
    for (let i = 0; i < rows.length; i++) {
      const evs = rows[i].events;
      for (let j = 0; j < evs.length; j++) {
        const ev = evs[j];
        counts.set(ev.activity, (counts.get(ev.activity) ?? 0) + 1);
        if (!colors.has(ev.activity)) colors.set(ev.activity, ev.activityColor);
      }
    }

    // Default ordering: frequency desc, tie-break alphabetical.
    const allByDefault = [...counts.entries()]
      .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]));

    // Selection override: activities present in the hint sort to the top in
    // the order their `firstT` dictates; the rest fall back to default order.
    const hint = selectionActivityOrder?.get(type);
    if (hint && hint.length) {
      const hintActs = new Set(hint.map(h => h.activity));
      const preferred = hint
        .filter(h => counts.has(h.activity))
        .map(h => ({
          activity: h.activity,
          count: counts.get(h.activity),
          color: colors.get(h.activity),
          inSelection: true,
        }));
      const rest = allByDefault
        .filter(([a]) => !hintActs.has(a))
        .map(([activity, count]) => ({
          activity, count, color: colors.get(activity), inSelection: false,
        }));
      return [...preferred, ...rest];
    }

    return allByDefault.map(([activity, count]) => ({
      activity, count, color: colors.get(activity), inSelection: false,
    }));
  });

  // ── Allocate band heights ───────────────────────────────────────────────
  // Each band's minimum height accommodates one row per activity. Beyond that
  // floor, additional space is distributed proportionally to entity count
  // (the original behaviour) so heavier bands get more visual weight.
  const counts = orderedTypes.map(t => (data.sparklinesByType[t] ?? []).length);
  const totalCount = counts.reduce((sum, c) => sum + c, 0) || 1;
  const bandFloors = bandActivityRows.map(acts => {
    const numActs = Math.max(1, acts.length);
    return MIN_BAND_PAD * 2 + numActs * MIN_ROW_HEIGHT + 18; // 18 = header strip
  });
  const totalFloor = bandFloors.reduce((s, h) => s + h, 0);
  const gaps = Math.max(0, (orderedTypes.length - 1) * BAND_GAP);

  // Use the viewport as the *minimum* canvas height but allow the chart to
  // grow taller if activity rows demand it (screen-host scrolls vertically).
  const viewportH = Math.max(360, Math.round(viewport?.height ?? 360));
  const desiredInnerH = totalFloor + gaps;
  const innerTop = PAD_TOP;
  const innerHeight = Math.max(desiredInnerH, viewportH - PAD_TOP - PAD_BOTTOM);
  const innerBottom = innerTop + innerHeight;
  const height = innerBottom + PAD_BOTTOM;

  const extra = Math.max(0, innerHeight - totalFloor - gaps);
  const heights = bandFloors.map((floor, i) => floor + extra * (counts[i] / totalCount));

  // ── Place bands and per-activity y rows ─────────────────────────────────
  const bands = [];
  // activityYByBand[bandIndex] = Map<activity, y>
  const activityYByBand = new Map();
  let cursor = innerTop;

  orderedTypes.forEach((type, i) => {
    const node = typeNodeById.get(type) ?? { label: type, color: "#64748b", role: "other" };
    const activities = bandActivityRows[i];
    const h = heights[i];
    const y0 = cursor;
    const y1 = cursor + h;
    const rowsY0 = y0 + 18 + MIN_BAND_PAD;
    const rowsY1 = y1 - MIN_BAND_PAD;
    const innerH = Math.max(1, rowsY1 - rowsY0);
    const slot = innerH / Math.max(1, activities.length);

    const yMap = new Map();
    activities.forEach((a, k) => {
      yMap.set(a.activity, rowsY0 + (k + 0.5) * slot);
    });
    activityYByBand.set(i, yMap);

    bands.push({
      type, label: node.label, color: node.color, role: node.role,
      y0, y1, headerY: y0 + 13, rowsY0, rowsY1, rowHeight: slot,
      entityCount: counts[i], bandIndex: i,
      activities, // [{ activity, count, color }]
    });
    cursor = y1 + BAND_GAP;
  });

  // ── Dot positions filtered to the time window ───────────────────────────
  // Dots are coloured by their band (entity type), not by activity, since y
  // already encodes activity. activityColor is kept on the record for use in
  // tooltips and the inspector.
  const dotPositions = [];
  // Per-entity ordered event positions, used by the polyline overlay.
  // Map<entity_id, Array<{ x, y, t, eventId, activity }>>
  const eventPosByEntity = new Map();
  const dotRadiusBase = 2.0;

  orderedTypes.forEach((type, bandIndex) => {
    const rows = data.sparklinesByType[type] ?? [];
    const band = bands[bandIndex];
    const yMap = activityYByBand.get(bandIndex);
    rows.forEach(row => {
      const ordered = [];
      eventPosByEntity.set(row.entity_id, ordered);
      const evs = row.events;
      for (let i = 0; i < evs.length; i++) {
        const ev = evs[i];
        if (ev.t < t0 || ev.t > t1) continue;
        const y = yMap.get(ev.activity);
        if (y == null) continue;
        const x = xScale(ev.t);
        dotPositions.push({
          x, y,
          color: band.color,
          activityColor: ev.activityColor,
          radius: ev.isShared ? dotRadiusBase * 1.4 : dotRadiusBase,
          eventId: ev.event_id,
          entityId: row.entity_id,
          entityType: type,
          bandIndex,
          isShared: ev.isShared,
          t: ev.t,
          activity: ev.activity,
        });
        ordered.push({ x, y, t: ev.t, eventId: String(ev.event_id), activity: ev.activity });
      }
      // events came in sorted by t already, but be defensive
      ordered.sort((a, b) => a.t - b.t);
    });
  });

  // ── Activity gutter labels (right-aligned to innerLeft - 6) ─────────────
  // One label per (band, activity) row. The renderer draws these as SVG text.
  const activityLabels = [];
  bands.forEach(band => {
    band.activities.forEach(a => {
      const y = activityYByBand.get(band.bandIndex).get(a.activity);
      activityLabels.push({
        x: innerLeft - 6,
        y,
        label: ellipsis(a.activity, labelCharBudget),
        full: a.activity,
        color: a.color,
        bandColor: band.color,
        count: a.count,
        inSelection: a.inSelection === true,
      });
    });
  });

  const axisTicks = _buildAxisTicks(t0, t1, xScale);

  return {
    width, height,
    innerLeft, innerRight, innerTop, innerBottom,
    innerWidth, innerHeight,
    bandHeaderW: BAND_HEADER_W,
    activityGutterW,
    xScale,
    timeWindow: { t0, t1 },
    bands,
    dotPositions,
    activityYByBand,
    activityLabels,
    axisTicks,
    eventPosByEntity,
    hasSelection: !!(selectionActivityOrder && selectionActivityOrder.size),
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
