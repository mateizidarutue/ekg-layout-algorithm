"use strict";

// Multi-scale EKG view layout.
//
// Design anchors:
//   • Shneiderman's mantra (1996) — overview, zoom & filter, details on demand
//   • Cockburn, Karlson & Bederson (2009) — overview+detail combined with semantic zoom
//   • Performance Spectrum (Denisov, Belkina & Fahland 2018) — time-axis-aligned
//     visualisation that switches encoding with zoom, scaling to ~100M events
//   • Bederson's Pad++ / ZMLT (De Luca et al. 2019) — semantic zoom with the
//     *persistence* property: anything visible at a coarse level stays visible
//     at all finer levels
//
// The spatial frame is fixed across zoom levels:
//   – X = time (always the same scale, always the same window)
//   – Y = entity-type bands (always the same order, always the same labels)
//   – Shared-event spines = vertical lines, drawn on top at every level
//
// Only the per-band *encoding* changes per level:
//   L0 Galaxy        density heat strip
//   L1 District      activity nodes + DF arcs within band
//   L2 Neighbourhood per-entity sparklines (one row per entity)
//   L3 Street        single focused-entity event detail
//
// The function returns a fully positioned layout that the renderer can draw
// without making any further numeric decisions.

export const EKG_LEVELS = Object.freeze({ L0: 0, L1: 1, L2: 2, L3: 3 });

// Geometry constants — grouped to make them easy to tune without hunting
// through the function body. Heights here are *per-band*, not the whole view.
//
// The values are tuned for "calm by default, rich on demand": small enough
// that a 7-band library fits in one viewport at L1, large enough that a
// single focused entity at L3 reads well.
export const EKG_GEOM = Object.freeze({
  pad:        { x: 28, top: 18, bottom: 18, gutterLeft: 124 },
  band:       { gap: 22, headerH: 24, labelPadLeft: 14 },
  L0:         { stripH: 18 },
  L1:         { contentH: 78, nodeMinR: 5.5, nodeMaxR: 14, nodeMinSep: 56, topLabels: 3 },
  L2:         { rowH: 7, minRows: 6, maxRows: 36, eventR: 2.0 },
  L3:         { contentH: 280, eventR: 5.5 },
  spine:      { dotR: 2.4, hitW: 8, clusterMinSep: 5 },
  syncStrip:  { h: 18, padTop: 4 },
  scrubber:   { h: 36, gapBelow: 10 },  // top time scrubber (replaces bottom minimap)
  axis:       { h: 22, tickCount: 6 },
});

export function computeEkgViewLayout(data, viewport, state = {}) {
  if (!data) return _emptyLayout(viewport);

  const level = Number.isInteger(state.level) ? state.level : 1;
  const focus = state.focus ?? null;
  const maxEntitiesPerBand = state.maxEntitiesPerBand ?? 24;
  const allBandOrder = state.bandOrder?.length ? state.bandOrder : data.bandOrder ?? [];
  // Visible-type filtering. By default we hide auxiliary roles (resource,
  // attribute) so the first paint is calm — these are easy to add back via a
  // single chip in the toolbar. ZMLT persistence still holds: the time axis
  // and minimap don't change when types are hidden.
  const visibleTypes = state.visibleTypes
    ? new Set(state.visibleTypes)
    : _defaultVisibleTypes(data);
  const bandOrder = allBandOrder.filter(t => visibleTypes.has(t));

  const innerLeft  = EKG_GEOM.pad.x + EKG_GEOM.pad.gutterLeft;
  const innerRight = Math.max((viewport?.width ?? 1200) - EKG_GEOM.pad.x, innerLeft + 320);
  const innerW     = innerRight - innerLeft;

  // ── Time window (current zoom) ──
  // Clamped to the dataset's range. The state.timeWindow is what the user
  // chose via scroll/minimap; if missing or invalid, fall back to the full
  // range so callers can always render something.
  const dataMin = data.timeRange.min;
  const dataMax = data.timeRange.max;
  const dataSpan = Math.max(dataMax - dataMin, 1);
  const requested = state.timeWindow ?? {};
  let t0 = Number.isFinite(requested.t0) ? requested.t0 : dataMin;
  let t1 = Number.isFinite(requested.t1) ? requested.t1 : dataMax;
  // Guard against degenerate / inverted windows
  if (t1 <= t0) { t0 = dataMin; t1 = dataMax; }
  t0 = Math.max(t0, dataMin);
  t1 = Math.min(t1, dataMax);
  const span = Math.max(t1 - t0, 1);

  // Single, canonical time scale. Every band, spine, and the minimap go
  // through this function — they cannot disagree about where t=now lives.
  const timeScale = {
    t0, t1, span,
    x: t => innerLeft + ((t - t0) / span) * innerW,
    invert: x => t0 + ((x - innerLeft) / innerW) * span,
    range: [innerLeft, innerRight],
    domain: [t0, t1],
  };

  // ── Bands ──
  // Only types in bandOrder are rendered. Types with no entities in the
  // current focus would still appear (their L0 strip is just empty), which
  // keeps the global type-axis stable across filter changes — ZMLT persistence.
  const typeNodeById = Object.fromEntries((data.typeNodes ?? []).map(t => [t.id, t]));
  const visibleTypeList = bandOrder.filter(type => typeNodeById[type]);

  // The vertical stack from top to bottom:
  //   pad.top → scrubber → gapBelow → axis → syncStrip → bands
  // The scrubber lives inside the main canvas SVG (no separate bottom block)
  // so it's visible at first paint without scrolling.
  const scrubberY = EKG_GEOM.pad.top;
  const axisY = scrubberY + EKG_GEOM.scrubber.h + EKG_GEOM.scrubber.gapBelow;
  let cursorY = axisY + EKG_GEOM.axis.h + EKG_GEOM.syncStrip.padTop + EKG_GEOM.syncStrip.h + 10;
  const bands = visibleTypeList.map(type => {
    const meta = typeNodeById[type];
    const effectiveLevel = _bandLevel(level, type, focus);
    const headerH = EKG_GEOM.band.headerH;
    const contentH = _contentHeightForLevel(effectiveLevel, type, data, maxEntitiesPerBand);
    const totalH = headerH + contentH;
    const band = {
      type,
      role: meta.role,
      color: meta.color,
      label: meta.label,
      entityCount: meta.entityCount,
      visibleEntityCount: meta.entityCountVisible,
      eventCount: meta.eventCount,
      headerY: cursorY,
      contentY: cursorY + headerH,
      y: cursorY,
      height: totalH,
      contentH,
      render: `L${effectiveLevel}`,
      level: effectiveLevel,
      cells: _layoutBandCells(effectiveLevel, type, data, timeScale, {
        contentY: cursorY + headerH,
        contentH,
        maxEntitiesPerBand,
        focus,
      }),
    };
    cursorY += totalH + EKG_GEOM.band.gap;
    return band;
  });

  const bandsBottom = cursorY - EKG_GEOM.band.gap;
  const bandByType = Object.fromEntries(bands.map(b => [b.type, b]));

  // ── Synchronisation strip + aggregated spine clusters ──
  //
  // Drawing 18 000 vertical "spine" lines floods the canvas and hides the
  // bands underneath. The redesign aggregates spines two ways:
  //
  //  1. A thin density strip just under the axis ("how many shared events
  //     occurred in each time bin?") — the global synchronisation rhythm.
  //  2. Spatial clustering of individual spine dots: any two dots that would
  //     fall within `EKG_GEOM.spine.clusterMinSep` pixels merge into a single
  //     dot whose size grows with the count.
  //
  // Full vertical lines through the bands are reserved for *focused* spines
  // only (when the user clicks/hovers something). The result: the default
  // view shows where synchronisation clusters, not 18k dashed stripes.
  const spinesInWindow = (data.spines ?? [])
    .filter(spine => spine.t >= t0 && spine.t <= t1)
    .map(spine => {
      const touchedBandTypes = spine.types.filter(t => bandByType[t]);
      if (touchedBandTypes.length < 2) return null;
      return {
        event_id: spine.event_id,
        t: spine.t,
        x: timeScale.x(spine.t),
        activity: spine.activity,
        color: spine.activityColor,
        types: spine.types,
        sharedEntityIds: spine.sharedEntityIds,
        sharedEntityCount: spine.sharedEntityCount ?? spine.sharedEntityIds.length,
        bandsCovered: touchedBandTypes,
      };
    })
    .filter(Boolean);

  const spineClusters = _clusterSpines(
    spinesInWindow,
    EKG_GEOM.spine.clusterMinSep,
    bandByType,
    axisY + EKG_GEOM.axis.h + EKG_GEOM.syncStrip.padTop + EKG_GEOM.syncStrip.h / 2,
    innerLeft,
    innerW,
  );

  // Per-bin density of shared events for the strip
  const stripBinCount = Math.min(96, Math.max(24, Math.floor(innerW / 16)));
  const stripBinWidth = (innerW / stripBinCount);
  const stripCounts = new Array(stripBinCount).fill(0);
  spinesInWindow.forEach(spine => {
    const i = Math.min(stripBinCount - 1, Math.max(0, Math.floor((spine.x - innerLeft) / stripBinWidth)));
    stripCounts[i] += 1;
  });
  const stripMax = Math.max(1, ...stripCounts);
  const syncStrip = {
    y: axisY + EKG_GEOM.axis.h + EKG_GEOM.syncStrip.padTop,
    height: EKG_GEOM.syncStrip.h,
    x: innerLeft, w: innerW,
    binCount: stripBinCount,
    binWidth: stripBinWidth,
    bins: stripCounts.map((c, i) => ({
      x: innerLeft + i * stripBinWidth,
      w: stripBinWidth,
      count: c,
      intensity: c / stripMax,
    })),
    totalSpines: spinesInWindow.length,
    maxBinCount: stripMax,
  };

  // Resolve which spine, if any, is in focus — that's the only one drawn as
  // a full vertical line through the bands.
  const focusedSpineId = focus?.kind === "spine" ? focus.value
    : focus?.kind === "event" ? focus.value
    : null;
  const focusedSpine = focusedSpineId
    ? spinesInWindow.find(s => s.event_id === focusedSpineId) ?? null
    : null;
  if (focusedSpine) {
    const touched = focusedSpine.types.map(t => bandByType[t]).filter(Boolean);
    focusedSpine.y0 = Math.min(...touched.map(b => b.contentY));
    focusedSpine.y1 = Math.max(...touched.map(b => b.contentY + b.contentH));
  }

  // We still expose the full spine list so the renderer can render axis-only
  // dots for searches/hover; sharedSpines stays as a name for back-compat.
  const sharedSpines = spinesInWindow;

  // ── Axis ticks ──
  const axis = _layoutAxis(timeScale, axisY, EKG_GEOM.axis.h);

  // ── Time scrubber (top of canvas) ──
  // Replaces the legacy bottom minimap. Shows the full data range's density
  // curve and a draggable rectangle indicating the current zoom window.
  // Sharing the canvas SVG means the scrubber and the bands are guaranteed
  // to use the same horizontal pixel layout — no minimap-vs-canvas drift.
  const scrubber = _layoutScrubber(
    data, dataMin, dataMax, dataSpan, t0, t1, innerLeft, innerW, scrubberY,
  );

  const totalHeight = bandsBottom + EKG_GEOM.pad.bottom;

  return {
    isEkgViewLayout: true,
    level,
    timeScale,
    timeWindow: { t0, t1 },
    dataRange: { t0: dataMin, t1: dataMax },
    innerLeft, innerRight, innerW,
    pad: EKG_GEOM.pad,
    bands,
    sharedSpines,
    spineClusters,
    syncStrip,
    focusedSpine,
    axis,
    scrubber,
    totalHeight,
    focus,
    visibleTypes: [...visibleTypes],
    hiddenTypeCount: Math.max(0, allBandOrder.length - visibleTypes.size),
  };
}

// Default-visible types: anything with role case|item|other. Resources and
// attributes are auxiliary context that crowds the first paint, so they're
// hidden behind a chip in the toolbar.
function _defaultVisibleTypes(data) {
  const set = new Set();
  (data.typeNodes ?? []).forEach(node => {
    if (node.role === "resource" || node.role === "attribute") return;
    set.add(node.id);
  });
  // If we'd hide everything (e.g. dataset is all resources), fall back to all.
  if (!set.size) (data.typeNodes ?? []).forEach(node => set.add(node.id));
  return set;
}

// Bin-based aggregation: divide the visible width into fixed-width buckets
// and put one dot per non-empty bucket. This bounds the number of cluster
// dots (so the canvas can't be flooded by 18k spines), and each bucket is a
// meaningful time slice the user can drill into.
//
// Greedy walk-merge was tried first but collapsed everything into a single
// "cluster" when spines were uniformly distributed — useless for the user.
function _clusterSpines(spines, _minSep, bandByType, dotY, innerLeft = 0, innerW = 1000) {
  if (!spines.length) return [];
  // ~50 dots across the full width — enough to show structure, sparse enough
  // to read individual blobs. Cap to avoid degeneracy on tiny viewports.
  const binCount = Math.min(60, Math.max(20, Math.floor(innerW / 22)));
  const binWidth = innerW / binCount;
  const bucketByIndex = new Map();
  spines.forEach(spine => {
    const i = Math.min(binCount - 1, Math.max(0, Math.floor((spine.x - innerLeft) / binWidth)));
    let b = bucketByIndex.get(i);
    if (!b) {
      b = {
        binIndex: i,
        x: 0,
        binLeft: innerLeft + i * binWidth,
        binRight: innerLeft + (i + 1) * binWidth,
        dotY,
        count: 0,
        eventIds: [],
        types: new Set(),
        members: [],
        sumX: 0,
      };
      bucketByIndex.set(i, b);
    }
    b.count += 1;
    b.eventIds.push(spine.event_id);
    spine.types.forEach(t => b.types.add(t));
    b.members.push(spine);
    b.sumX += spine.x;
  });
  const clusters = [...bucketByIndex.values()];
  clusters.forEach(c => {
    c.x = c.sumX / c.count;
    c.types = [...c.types].sort();
    // Keep members chronological for the inspector
    c.members.sort((a, b) => a.t - b.t);
    delete c.sumX;
  });
  clusters.sort((a, b) => a.binIndex - b.binIndex);
  return clusters;
}

// ── Sub-layouts ─────────────────────────────────────────────────────────────

function _layoutBandCells(level, type, data, timeScale, ctx) {
  if (level === EKG_LEVELS.L0) return _layoutBandL0(type, data, timeScale, ctx);
  if (level === EKG_LEVELS.L1) return _layoutBandL1(type, data, timeScale, ctx);
  if (level === EKG_LEVELS.L2) return _layoutBandL2(type, data, timeScale, ctx);
  if (level === EKG_LEVELS.L3) return _layoutBandL3(type, data, timeScale, ctx);
  return null;
}

// L0: each visible bin becomes a rectangle whose fill density encodes the
// per-type event count. We clip to the time window: a bin entirely outside
// it is dropped; a bin straddling the edge is shrunk to the visible portion.
function _layoutBandL0(type, data, timeScale, ctx) {
  const bins = (data.bins ?? []).map(bin => {
    const stats = bin.byType[type];
    if (!stats || stats.total === 0) return null;
    if (bin.t1 < timeScale.t0 || bin.t0 > timeScale.t1) return null;
    const cx0 = Math.max(bin.t0, timeScale.t0);
    const cx1 = Math.min(bin.t1, timeScale.t1);
    const x0 = timeScale.x(cx0);
    const x1 = timeScale.x(cx1);
    if (x1 - x0 < 0.5) return null;
    return {
      binIndex: bin.binIndex,
      t0: bin.t0,
      t1: bin.t1,
      x: x0,
      w: Math.max(x1 - x0, 1),
      total: stats.total,
      byActivity: stats.byActivity,
      topActivity: _argmax(stats.byActivity),
    };
  }).filter(Boolean);

  const maxBin = Math.max(1, ...bins.map(b => b.total));
  bins.forEach(b => { b.intensity = b.total / maxBin; });

  return {
    kind: "L0",
    bins,
    stripY: ctx.contentY + (ctx.contentH - EKG_GEOM.L0.stripH) / 2,
    stripH: EKG_GEOM.L0.stripH,
    maxBin,
  };
}

// L1: activity nodes positioned by mean timestamp, sized by frequency, with
// 1-D collision resolution. DF arcs are drawn within the band. We restrict
// to activities whose mean falls inside the visible window.
function _layoutBandL1(type, data, timeScale, ctx) {
  const band = data.activityBands?.bandsByType?.[type];
  if (!band) return { kind: "L1", nodes: [], edges: [] };
  const cy = ctx.contentY + ctx.contentH / 2;

  const counts = band.nodes.map(n => n.count);
  const maxCount = Math.max(1, ...counts);
  const rScale = c => EKG_GEOM.L1.nodeMinR + Math.sqrt(c / maxCount) * (EKG_GEOM.L1.nodeMaxR - EKG_GEOM.L1.nodeMinR);

  const rawNodes = band.nodes
    .filter(n => n.meanTimestamp >= timeScale.t0 - timeScale.span * 0.02 && n.meanTimestamp <= timeScale.t1 + timeScale.span * 0.02)
    .map(n => ({
      activity: n.activity,
      count: n.count,
      meanTimestamp: n.meanTimestamp,
      x: timeScale.x(n.meanTimestamp),
      y: cy,
      r: rScale(n.count),
    }));
  const nodes = _spread1D(rawNodes, EKG_GEOM.L1.nodeMinSep, timeScale.range[0] + 4, timeScale.range[1] - 4);
  const nodeByAct = Object.fromEntries(nodes.map(n => [n.activity, n]));

  const maxDf = Math.max(1, ...(band.dfEdges ?? []).map(e => e.count));
  const edges = (band.dfEdges ?? [])
    .filter(e => nodeByAct[e.source] && nodeByAct[e.target])
    .map(e => {
      const s = nodeByAct[e.source];
      const t = nodeByAct[e.target];
      const dx = t.x - s.x;
      const curve = Math.max(14, Math.min(46, Math.abs(dx) * 0.26));
      return {
        ...e,
        sw: 0.8 + (e.count / maxDf) * 2.6,
        x1: s.x + (dx < 0 ? -s.r : s.r),
        y1: cy,
        x2: t.x + (dx < 0 ?  t.r : -t.r),
        y2: cy,
        cx: (s.x + t.x) / 2,
        cy: cy - curve,
      };
    });

  return { kind: "L1", nodes, edges, nodeByAct, cy };
}

// L2: per-entity sparklines. Each entity gets a thin row; events are drawn
// as small marks at their time position. Rows are sorted by first event
// timestamp (chronological start). We cap to maxEntitiesPerBand and report
// how many were elided so the toolbar can surface a "+N more" hint.
function _layoutBandL2(type, data, timeScale, ctx) {
  const allRows = data.sparklinesByType?.[type] ?? [];
  const visible = allRows.filter(row => row.lastTime >= timeScale.t0 && row.firstTime <= timeScale.t1);
  const cap = Math.max(1, ctx.maxEntitiesPerBand);
  const rows = visible.slice(0, cap);
  const truncated = Math.max(0, visible.length - rows.length);
  const rowH = EKG_GEOM.L2.rowH;
  const usableH = Math.max(0, ctx.contentH - 4);
  // Distribute rows; if rows exceed contentH/rowH, shrink rowH proportionally
  // so every row stays visible (semantic-zoom invariant: no row hides).
  const effectiveRowH = rows.length * rowH > usableH
    ? Math.max(2, usableH / Math.max(rows.length, 1))
    : rowH;

  const layoutRows = rows.map((row, i) => {
    const rowY = ctx.contentY + 2 + i * effectiveRowH;
    const eventR = Math.min(EKG_GEOM.L2.eventR, Math.max(1.5, effectiveRowH / 3));
    const events = row.events
      .filter(e => e.t >= timeScale.t0 && e.t <= timeScale.t1)
      .map(e => ({
        event_id: e.event_id,
        x: timeScale.x(e.t),
        t: e.t,
        activity: e.activity,
        color: e.activityColor ?? "#64748b",
        isShared: e.isShared,
      }));
    return {
      entity_id: row.entity_id,
      label: row.label,
      rowY,
      rowH: effectiveRowH,
      midY: rowY + effectiveRowH / 2,
      eventR,
      events,
      firstX: events.length ? events[0].x : timeScale.range[0],
      lastX:  events.length ? events[events.length - 1].x : timeScale.range[1],
    };
  });

  return {
    kind: "L2",
    rows: layoutRows,
    truncated,
    visibleCount: visible.length,
    cap,
  };
}

// L3: a single focused entity blown up across the whole band. The focus must
// resolve to an entity whose type matches this band. If it doesn't, the band
// renders an empty stub with an instructional hint (handled by the renderer).
function _layoutBandL3(type, data, timeScale, ctx) {
  const rows = data.sparklinesByType?.[type] ?? [];
  const focus = ctx.focus;
  let target = null;
  if (focus?.kind === "entity") target = rows.find(r => r.entity_id === focus.value) ?? null;
  if (!target) return { kind: "L3", row: null };

  const eventR = EKG_GEOM.L3.eventR;
  const rowY = ctx.contentY + (ctx.contentH - eventR * 2) / 2;
  const events = target.events
    .filter(e => e.t >= timeScale.t0 && e.t <= timeScale.t1)
    .map(e => ({
      event_id: e.event_id,
      x: timeScale.x(e.t),
      t: e.t,
      activity: e.activity,
      color: e.activityColor ?? "#64748b",
      isShared: e.isShared,
    }));

  // DF strands: chain consecutive events in the entity's own sequence.
  // The sparkline data isn't DF-aware, so we approximate by linking
  // each consecutive pair — at L3 detail, this is "the entity's path".
  const strands = [];
  for (let i = 1; i < events.length; i++) {
    strands.push({
      x1: events[i - 1].x, x2: events[i].x,
      y: rowY + eventR,
      sourceId: events[i - 1].event_id,
      targetId: events[i].event_id,
    });
  }

  return {
    kind: "L3",
    row: {
      entity_id: target.entity_id,
      label: target.label,
      rowY,
      eventR,
      events,
      strands,
    },
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function _layoutAxis(timeScale, axisY, axisH) {
  const ticks = [];
  const n = EKG_GEOM.axis.tickCount;
  for (let i = 0; i < n; i++) {
    const t = timeScale.t0 + (timeScale.span * i) / (n - 1);
    ticks.push({
      x: timeScale.x(t),
      t,
      label: _formatTickLabel(t, timeScale.span),
    });
  }
  return {
    y: axisY,
    height: axisH,
    ticks,
    labelY: axisY + 14,
    lineY: axisY + axisH - 2,
  };
}

function _layoutScrubber(data, dataMin, dataMax, dataSpan, t0, t1, innerLeft, innerW, scrubberY) {
  const x = innerLeft;
  const w = innerW;
  const h = EKG_GEOM.scrubber.h;
  const padTop = 4;
  const usableH = h - padTop - 4;
  const density = data.globalDensity ?? [];
  const maxD = Math.max(1, ...density);
  const binW = w / Math.max(density.length, 1);

  // Density curve points — drawn as a calm area chart spanning the full data
  // range. The y axis is implicit (max value at top, zero at the scrubber's
  // bottom edge) and is never labelled — it's an at-a-glance signal, not a
  // measurement device.
  const points = density.map((d, i) => {
    const px = x + i * binW + binW / 2;
    const py = scrubberY + padTop + usableH - (d / maxD) * usableH;
    return { x: px, y: py, value: d };
  });
  let path = "";
  if (points.length) {
    path = `M ${x.toFixed(2)} ${scrubberY + padTop + usableH} `
      + points.map(p => `L ${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(" ")
      + ` L ${(x + w).toFixed(2)} ${scrubberY + padTop + usableH} Z`;
  }

  const viewportRect = {
    x0: x + ((t0 - dataMin) / dataSpan) * w,
    x1: x + ((t1 - dataMin) / dataSpan) * w,
    y: scrubberY + padTop - 2,
    h: usableH + 6,
  };

  return {
    y: scrubberY,
    height: h,
    x, w,
    padTop, usableH,
    density, points, path,
    viewportRect,
    dataRange: { t0: dataMin, t1: dataMax },
    // Helpers used by the renderer's pointer handlers to convert between
    // pixel space and time space. Clamped so callers don't have to.
    xToTime: px => dataMin + Math.max(0, Math.min(1, (px - x) / w)) * dataSpan,
    timeToX: t  => x + Math.max(0, Math.min(1, (t - dataMin) / dataSpan)) * w,
  };
}

// Per-band level: today every band uses the same level, but the spec leaves
// room for per-band override (e.g. L3 only on the focused entity's band, L1
// everywhere else). When focus = entity:X at L3, only X's band renders L3;
// other bands fall back to L1 so context remains readable.
function _bandLevel(level, type, focus) {
  if (level === EKG_LEVELS.L3 && focus?.kind === "entity") {
    return focus.entityType === type ? EKG_LEVELS.L3 : EKG_LEVELS.L1;
  }
  return level;
}

function _contentHeightForLevel(level, type, data, maxEntitiesPerBand) {
  if (level === EKG_LEVELS.L0) return EKG_GEOM.L0.stripH + 6;
  if (level === EKG_LEVELS.L1) return EKG_GEOM.L1.contentH;
  if (level === EKG_LEVELS.L2) {
    const rows = data.sparklinesByType?.[type] ?? [];
    const count = Math.min(rows.length, maxEntitiesPerBand);
    const rowH = EKG_GEOM.L2.rowH;
    const desired = Math.max(EKG_GEOM.L2.minRows, count) * rowH + 6;
    return Math.min(EKG_GEOM.L2.maxRows * rowH + 6, desired);
  }
  if (level === EKG_LEVELS.L3) return EKG_GEOM.L3.contentH;
  return EKG_GEOM.L1.contentH;
}

function _spread1D(nodes, minSep, minX, maxX) {
  if (nodes.length <= 1) return nodes;
  const sorted = [...nodes].sort((a, b) => a.x - b.x);
  for (let i = 1; i < sorted.length; i++) {
    const needed = sorted[i - 1].x + minSep;
    if (sorted[i].x < needed) sorted[i] = { ...sorted[i], x: needed };
  }
  const overflow = sorted[sorted.length - 1].x - maxX;
  if (overflow > 0) sorted.forEach((n, i) => { sorted[i] = { ...n, x: n.x - overflow }; });
  sorted.forEach((n, i) => { if (n.x < minX) sorted[i] = { ...n, x: minX }; });
  return sorted;
}

function _argmax(byActivity) {
  let best = null;
  let bestCount = -1;
  for (const [activity, count] of Object.entries(byActivity)) {
    if (count > bestCount) { bestCount = count; best = activity; }
  }
  return best;
}

function _formatTickLabel(t, span) {
  const d = new Date(t);
  if (isNaN(d.getTime())) return "";
  const DAY = 86400000;
  if (span < 7 * DAY) {
    // Hour-grain when looking at less than a week
    return d.toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
  }
  if (span < 90 * DAY) {
    return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
  }
  if (span < 3 * 365 * DAY) {
    return d.toLocaleDateString("en-GB", { month: "short", year: "2-digit" });
  }
  return d.toLocaleDateString("en-GB", { year: "numeric" });
}

function _emptyLayout(viewport) {
  return {
    isEkgViewLayout: true,
    level: 1,
    timeScale: { t0: 0, t1: 1, span: 1, x: () => 0, invert: () => 0, range: [0, 0], domain: [0, 1] },
    timeWindow: { t0: 0, t1: 1 },
    dataRange: { t0: 0, t1: 1 },
    innerLeft: 0, innerRight: viewport?.width ?? 0, innerW: viewport?.width ?? 0,
    pad: EKG_GEOM.pad,
    bands: [],
    sharedSpines: [],
    axis: { ticks: [], y: 0, height: 0, labelY: 0, lineY: 0 },
    scrubber: { y: 0, height: 0, x: 0, w: 0, density: [], points: [], path: "", viewportRect: { x0: 0, x1: 0, y: 0, h: 0 }, dataRange: { t0: 0, t1: 1 }, xToTime: () => 0, timeToX: () => 0 },
    totalHeight: 200,
    focus: null,
  };
}
