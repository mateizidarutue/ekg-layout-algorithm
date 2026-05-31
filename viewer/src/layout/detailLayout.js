"use strict";

// All tunable geometry for the detail (T2 Identify / T3 Compare) layout lives
// in one place to make it discoverable, reviewable, and easy to tweak.
//
// Group meanings:
//   pad      — outer canvas padding
//   timeline — horizontal time axis position & padding
//   band     — vertical band header + lane geometry
//   anchor   — solo-event anchor circles above the timeline
//   shared   — clustered shared-event lanes above the timeline
//   header   — vertical space reserved for the band header chrome
export const LAYOUT_CONFIG = Object.freeze({
  pad:      { x: 34, top: 34, bottom: 34 },
  timeline: { x0: 304, padR: 54, trackY: 84 },
  band:     { headerH: 34, laneH: 36, gap: 24 },
  anchor:   { r: 6.5, laneMarkerR: 5, stackGap: 18, baseOffset: 12, clearance: 15 },
  shared:   { gap: 0, rowGap: 30, baseOffset: 16, h: 22, clearance: 14, laneGap: 38 },
  header:   { reservedH: 86 },
  relation: { portOffset: 26 },
});

// Named exports retained so existing imports throughout the viewer keep
// working without modification. New code should prefer LAYOUT_CONFIG.
export const DETAIL_PAD_X      = LAYOUT_CONFIG.pad.x;
export const DETAIL_PAD_TOP    = LAYOUT_CONFIG.pad.top;
export const DETAIL_PAD_BOTTOM = LAYOUT_CONFIG.pad.bottom;
export const EVENT_TRACK_Y     = LAYOUT_CONFIG.timeline.trackY;
export const TIMELINE_X0       = LAYOUT_CONFIG.timeline.x0;
export const TIMELINE_PAD_R    = LAYOUT_CONFIG.timeline.padR;
export const BAND_HEADER_H     = LAYOUT_CONFIG.band.headerH;
export const LANE_H            = LAYOUT_CONFIG.band.laneH;
export const BAND_GAP          = LAYOUT_CONFIG.band.gap;
export const EVENT_ANCHOR_R    = LAYOUT_CONFIG.anchor.r;
export const LANE_MARKER_R     = LAYOUT_CONFIG.anchor.laneMarkerR;
export const RELATION_PORT_X   = LAYOUT_CONFIG.timeline.x0 - LAYOUT_CONFIG.relation.portOffset;

const EVENT_STACK_GAP          = LAYOUT_CONFIG.anchor.stackGap;
const EVENT_STACK_BASE_OFFSET  = LAYOUT_CONFIG.anchor.baseOffset;
const EVENT_STACK_CLEARANCE    = LAYOUT_CONFIG.anchor.clearance;
const SHARED_CLUSTER_GAP       = LAYOUT_CONFIG.shared.gap;
const SHARED_CLUSTER_ROW_GAP   = LAYOUT_CONFIG.shared.rowGap;
const SHARED_CLUSTER_BASE_OFFSET = LAYOUT_CONFIG.shared.baseOffset;
const SHARED_CLUSTER_H         = LAYOUT_CONFIG.shared.h;
const SHARED_CLUSTER_CLEARANCE = LAYOUT_CONFIG.shared.clearance;
const SHARED_CLUSTER_LANE_GAP  = LAYOUT_CONFIG.shared.laneGap;
const HEADER_RESERVED_H        = LAYOUT_CONFIG.header.reservedH;

// Per-lane expansion table geometry. The table itself is rendered as a
// foreignObject in the detail renderer; the layout's only job is to leave
// room for it so subsequent lanes / bands shift down. Keep these in sync
// with the CSS in style.css (.lane-expanded-table).
export const LANE_TABLE_PAD_TOP    = 6;
export const LANE_TABLE_PAD_BOTTOM = 8;
export const LANE_TABLE_HEADER_H   = 22;
export const LANE_TABLE_ROW_H      = 20;
export const LANE_TABLE_EMPTY_H    = 28; // fallback height when an entity has zero rows
// Cap how many rows of body the reserved layout space shows. Longer event
// sequences scroll inside the table wrapper rather than pushing the rest
// of the canvas further down.
export const LANE_TABLE_MAX_VISIBLE_ROWS = 5;

export function computeDetailLayout(graph, width, options = {}) {
  const expandedEntityIds = options.expandedEntityIds instanceof Set
    ? options.expandedEntityIds
    : new Set(options.expandedEntityIds ?? []);
  const getRowCountForEntity = typeof options.getRowCountForEntity === "function"
    ? options.getRowCountForEntity
    : null;
  const totalWidth = Math.max(width - 18, TIMELINE_X0 + 420);
  const bandX = 18;
  const bandWidth = Math.max(totalWidth - bandX - 20, 420);
  const timelineW = Math.max(totalWidth - TIMELINE_X0 - TIMELINE_PAD_R, 360);
  const anchors = [...(graph?.eventAnchors ?? [])].sort(_compareAnchors);
  const bands = [...(graph?.bands ?? [])];
  const allTimes = anchors.map(anchor => anchor.date?.getTime()).filter(Number.isFinite);
  const timeScale = _buildTimeScale(allTimes, timelineW);
  const seeds = anchors.map(anchor => ({
    ...anchor,
    x: timeScale.xForTime(anchor.date?.getTime?.()),
  }));
  const soloAnchorSeeds = seeds.filter(anchor => !anchor.isSharedEvent);
  const soloXs = soloAnchorSeeds.map(anchor => anchor.x);
  const stackRows = _assignAnchorRows(soloAnchorSeeds, soloXs);
  const clusterSeeds = _buildSharedEventClusters(seeds.filter(anchor => anchor.isSharedEvent));
  // The stacked anchor rail above the timeline is no longer rendered, so
  // we don't need vertical space for it. Anchor y positions are still
  // computed (some downstream maps reference them), but at virtual offsets
  // above the visible axis — they just never get drawn.
  const railDepth = 0;
  const axisY = DETAIL_PAD_TOP + HEADER_RESERVED_H + railDepth + 18;
  const sharedEventClusters = clusterSeeds.map(cluster => ({
    ...cluster,
    y: axisY - SHARED_CLUSTER_BASE_OFFSET - cluster.laneIndex * SHARED_CLUSTER_LANE_GAP,
  }));
  const sharedClusterLanes = _buildSharedClusterLanes(sharedEventClusters, axisY, timelineW);
  const clusterByEventId = Object.fromEntries(sharedEventClusters.flatMap(cluster =>
    cluster.eventIds.map(eventId => [eventId, cluster])
  ));
  let soloIndex = 0;
  const laidAnchors = seeds.map(anchor => {
    const cluster = anchor.isSharedEvent ? clusterByEventId[anchor.event_id] : null;
    const stackRow = anchor.isSharedEvent ? cluster?.stackRow ?? 0 : stackRows[soloIndex++];
    return {
      ...anchor,
      y: anchor.isSharedEvent
        ? cluster?.y ?? (axisY - SHARED_CLUSTER_BASE_OFFSET)
        : axisY - EVENT_STACK_BASE_OFFSET - stackRow * EVENT_STACK_GAP,
      stackRow,
      r: anchor.isSharedEvent ? EVENT_ANCHOR_R + Math.min(anchor.sharedEntityIds.length - 1, 4) : EVENT_ANCHOR_R,
    };
  });
  const anchorById = Object.fromEntries(laidAnchors.map(anchor => [anchor.event_id, anchor]));

  // Lanes inside a band are visually grouped by their parent case entity.
  // Each time the parent changes between consecutive lanes we add this many
  // pixels of extra space, so a parent's children render as a contiguous
  // block separated from the next parent's block. The parent-of-this-lane
  // check skips lanes whose own entity_id IS the case id (i.e., the parent
  // band itself), so the parent band stays uniformly spaced.
  const PARENT_GROUP_GAP = 14;

  let currentY = axisY + 36;
  const laidBands = bands.map((band, bandIndex) => {
    const bandTop = currentY;
    let cumulativeOffset = 0;
    let prevParent = null;
    const parentGroupBreaks = [];
    const lanes = band.lanes.map((lane, laneIndex) => {
      const myParent = lane.events?.[0]?.case_entity_id ?? null;
      const isOwnParent = lane.entity_id === myParent;
      if (!isOwnParent && laneIndex > 0 && myParent && prevParent && myParent !== prevParent) {
        // Mid-band parent transition → insert a gap and remember the break
        // line so the renderer can draw a faint divider.
        const breakY = bandTop + BAND_HEADER_H + laneIndex * LANE_H + cumulativeOffset + PARENT_GROUP_GAP / 2 - LANE_H / 2;
        parentGroupBreaks.push({ y: breakY, parentCaseId: myParent });
        cumulativeOffset += PARENT_GROUP_GAP;
      }
      if (!isOwnParent) prevParent = myParent;
      const laneTop = bandTop + BAND_HEADER_H + laneIndex * LANE_H + cumulativeOffset;
      const y = laneTop + LANE_H / 2;
      // If this lane is expanded, reserve vertical space for its details
      // table immediately below it and shift every subsequent lane (and
      // every subsequent band, via bandHeight below) down by that amount.
      let expansion = null;
      if (expandedEntityIds.has(lane.entity_id)) {
        const rowCount = getRowCountForEntity ? Math.max(0, getRowCountForEntity(lane.entity_id) | 0) : 0;
        // Cap the reserved layout space; the inner scrollable wrapper
        // handles overflow so the canvas doesn't grow with sequence length.
        const visibleRows = rowCount > 0
          ? Math.min(rowCount, LANE_TABLE_MAX_VISIBLE_ROWS)
          : 0;
        const bodyH = visibleRows > 0
          ? visibleRows * LANE_TABLE_ROW_H
          : LANE_TABLE_EMPTY_H;
        const tableHeight = LANE_TABLE_PAD_TOP + LANE_TABLE_HEADER_H + bodyH + LANE_TABLE_PAD_BOTTOM;
        expansion = {
          open: true,
          tableY: laneTop + LANE_H + LANE_TABLE_PAD_TOP,
          tableHeight: LANE_TABLE_HEADER_H + bodyH + LANE_TABLE_PAD_BOTTOM,
          rowCount,
          visibleRows,
          scrollable: rowCount > visibleRows,
        };
        cumulativeOffset += tableHeight;
      }
      const memberships = (lane.memberships ?? []).map(membership => ({
        ...membership,
        x: membership.anchor?.x ?? anchorById[membership.event_id]?.x ?? TIMELINE_X0,
        y,
      }));
      const dfEdges = lane.dfEdges.map(edge => {
        const source = anchorById[edge.source_event_id];
        const target = anchorById[edge.target_event_id];
        if (!source || !target) return null;
        const dx = target.x - source.x;
        const direction = dx >= 0 ? 1 : -1;
        const curve = Math.min(8, Math.max(4, Math.abs(dx) * 0.018));
        const endpointPad = Math.min(Math.abs(dx) * 0.22, LANE_MARKER_R + 3);
        return {
          ...edge,
          x1: source.x + endpointPad * direction,
          y1: y - 1,
          x2: target.x - endpointPad * direction,
          y2: y - 1,
          cx: (source.x + target.x) / 2,
          cy: y - curve,
        };
      }).filter(Boolean);
      return {
        ...lane,
        bandIndex,
        laneIndex,
        x: bandX + 10,
        width: bandWidth - 20,
        y,
        parentCaseId: myParent,
        memberships,
        dfEdges,
        relationPortX: RELATION_PORT_X,
        expansion,
      };
    });
    const bandHeight = BAND_HEADER_H + Math.max(lanes.length, 1) * LANE_H + cumulativeOffset;
    currentY += bandHeight + BAND_GAP;
    return {
      ...band,
      x: bandX,
      width: bandWidth,
      y: bandTop,
      height: bandHeight,
      lanes,
      parentGroupBreaks,
      headerY: bandTop + 22,
    };
  });

  const lanePositionById = {};
  laidBands.forEach(band => band.lanes.forEach(lane => { lanePositionById[lane.entity_id] = lane; }));

  const corrLinks = laidAnchors.flatMap(anchor => {
    if (anchor.isSharedEvent) return [];
    return (anchor.memberships ?? [])
      .map(membership => lanePositionById[membership.entity_id])
      .filter(Boolean)
      .map(lane => ({
        id: `corr-${anchor.event_id}-${lane.entity_id}`,
        event_id: anchor.event_id,
        entity_id: lane.entity_id,
        entity_type: lane.entityType,
        x1: anchor.x,
        y1: anchor.y + anchor.r + 2,
        x2: anchor.x,
        y2: lane.y - LANE_MARKER_R - 2,
      }));
  });

  const sharedGuides = laidAnchors
    .filter(anchor => anchor.isSharedEvent)
    .map(anchor => {
      const membershipYs = (anchor.memberships ?? [])
        .map(membership => lanePositionById[membership.entity_id]?.y)
        .filter(Number.isFinite);
      if (!membershipYs.length) return null;
      return {
        event_id: anchor.event_id,
        activity: anchor.activity ?? "",
        x: anchor.x,
        y1: axisY,
        y2: Math.max(...membershipYs) + LANE_MARKER_R + 3,
        // entityCount = entities visible in this view; totalEntityCount = raw data scope.
        entityCount: anchor.sharedEntityIds.length,
        totalEntityCount: anchor.totalEntityCount ?? anchor.sharedEntityIds.length,
        totalEntityTypes: anchor.totalEntityTypes ?? anchor.sharedEntityTypes ?? [],
        sharedEntityIds: anchor.sharedEntityIds,
        sharedEntityTypes: anchor.sharedEntityTypes ?? [],
        activityColor: anchor.activityColor ?? "#64748b",
      };
    })
    .filter(Boolean);

  const sharedEventClustersWithBands = sharedEventClusters.map(cluster => {
    const relatedAnchors = cluster.eventIds.map(eventId => anchorById[eventId]).filter(Boolean);
    const membershipYs = relatedAnchors
      .flatMap(anchor => (anchor.memberships ?? []).map(membership => lanePositionById[membership.entity_id]?.y))
      .filter(Number.isFinite);
    const visibleEntityIds = new Set(relatedAnchors.flatMap(anchor =>
      (anchor.memberships ?? [])
        .filter(membership => lanePositionById[membership.entity_id])
        .map(membership => membership.entity_id)
    ));
    const bandWidth = Math.max(16, cluster.maxX - cluster.minX + 18);
    const minMemberY = membershipYs.length ? Math.min(...membershipYs) : cluster.y + cluster.height / 2;
    const maxMemberY = membershipYs.length ? Math.max(...membershipYs) : cluster.y + cluster.height / 2;
    return {
      ...cluster,
      bandX: cluster.x - bandWidth / 2,
      bandWidth,
      bandY1: Math.min(cluster.y + cluster.height / 2, minMemberY),
      bandY2: Math.max(cluster.y + cluster.height / 2, maxMemberY) + LANE_MARKER_R + 7,
      visibleLaneCount: visibleEntityIds.size,
    };
  });

  const relationLinks = (graph?.relations ?? []).map(relation => {
    const sourceLane = lanePositionById[relation.source_entity_id];
    const targetLane = lanePositionById[relation.target_entity_id];
    if (!sourceLane || !targetLane) return null;
    const y1 = sourceLane.y;
    const y2 = targetLane.y;
    const curveX = RELATION_PORT_X - Math.min(30 + Math.abs(y2 - y1) * 0.18, 70);
    return {
      ...relation,
      x1: RELATION_PORT_X,
      y1,
      x2: RELATION_PORT_X,
      y2,
      cx: curveX,
      cy: (y1 + y2) / 2,
    };
  }).filter(Boolean);

  return {
    anchors: laidAnchors,
    anchorRail: laidAnchors.filter(anchor => !anchor.isSharedEvent),
    sharedEventClusters: sharedEventClustersWithBands,
    sharedClusterLanes,
    bands: laidBands,
    corrLinks,
    sharedGuides,
    relationLinks,
    axis: {
      y: axisY,
      x1: TIMELINE_X0,
      x2: TIMELINE_X0 + timelineW,
      ticks: _buildAxisTicks(timeScale.rangeMin, timeScale.rangeMax, timelineW),
    },
    bandX,
    bandWidth,
    totalWidth,
    totalHeight: currentY + DETAIL_PAD_BOTTOM,
    summary: graph?.summary ?? {},
    anchorEntity: graph?.anchorEntity ?? null,
    anchorEntityType: graph?.anchorEntityType ?? null,
    compareEntityIds: graph?.compareEntityIds ?? [],
    scope: graph?.scope ?? "neighborhood",
    timeScale,
  };
}

function _assignAnchorRows(anchors, xs) {
  const rowEnds = [];
  return xs.map((x, index) => {
    const clearance = EVENT_STACK_CLEARANCE + Math.min(Math.max((anchors[index]?.sharedEntityIds?.length ?? 1) - 1, 0), 4) * 2;
    let rowIndex = rowEnds.findIndex(lastX => x - lastX >= clearance);
    if (rowIndex === -1) {
      rowIndex = rowEnds.length;
      rowEnds.push(x);
    } else {
      rowEnds[rowIndex] = x;
    }
    return rowIndex;
  });
}

function _buildSharedEventClusters(sharedAnchors) {
  if (!sharedAnchors.length) return [];
  const sorted = [...sharedAnchors].sort((a, b) =>
    _sharedLaneKey(a).localeCompare(_sharedLaneKey(b))
    || a.x - b.x
    || _compareAnchors(a, b)
  );
  const clusters = [];
  let current = null;

  sorted.forEach(anchor => {
    const laneKey = _sharedLaneKey(anchor);
    if (!current || current.laneKey !== laneKey || anchor.x - current.maxX > SHARED_CLUSTER_GAP) {
      current = {
        id: `shared-cluster-${clusters.length + 1}`,
        laneKey,
        laneLabel: _sharedLaneLabel(anchor),
        anchors: [anchor],
        minX: anchor.x,
        maxX: anchor.x,
      };
      clusters.push(current);
    } else {
      current.anchors.push(anchor);
      current.maxX = anchor.x;
    }
  });

  const prepared = clusters.map((cluster, index) => {
    const eventIds = cluster.anchors.map(anchor => anchor.event_id);
    const activityCounts = [];
    const activityCountByName = new Map();
    cluster.anchors.forEach(anchor => {
      const key = anchor.activity ?? "Unknown";
      const nextCount = (activityCountByName.get(key)?.count ?? 0) + 1;
      const next = {
        activity: key,
        color: anchor.activityColor ?? "#64748b",
        count: nextCount,
      };
      activityCountByName.set(key, next);
    });
    activityCounts.push(...[...activityCountByName.values()].sort((a, b) => b.count - a.count || a.activity.localeCompare(b.activity)));
    const activityPalette = [...new Set(cluster.anchors.map(anchor => anchor.activityColor ?? "#64748b"))].slice(0, 4);
    const sharedEntityIds = [...new Set(cluster.anchors.flatMap(anchor => anchor.sharedEntityIds ?? []))];
    // Total entity count across all anchors in the cluster, using raw (unfiltered) counts.
    const totalEntityCount = cluster.anchors.reduce((sum, anchor) => sum + (anchor.totalEntityCount ?? anchor.sharedEntityIds?.length ?? 0), 0);
    const entityTypes = [...new Set(cluster.anchors.flatMap(anchor => anchor.totalEntityTypes ?? (anchor.memberships ?? []).map(membership => membership.entity_type)))];
    const spanWidth = Math.max(0, cluster.maxX - cluster.minX);
    const width = Math.max(40, Math.min(170, spanWidth + 24 + activityPalette.length * 8 + String(eventIds.length).length * 8));
    return {
      id: `shared-cluster-${index + 1}`,
      laneKey: cluster.laneKey,
      laneLabel: cluster.laneLabel,
      anchorIds: eventIds,
      eventIds,
      eventCount: eventIds.length,
      x: cluster.anchors.reduce((sum, anchor) => sum + anchor.x, 0) / Math.max(cluster.anchors.length, 1),
      minX: cluster.minX,
      maxX: cluster.maxX,
      minTime: cluster.anchors[0]?.date?.getTime?.() ?? null,
      maxTime: cluster.anchors.at(-1)?.date?.getTime?.() ?? null,
      sharedEntityIds,
      sharedEntityCount: sharedEntityIds.length,
      totalEntityCount,
      entityTypes,
      width,
      height: SHARED_CLUSTER_H,
      activityPalette,
      activityCounts,
      representativeEventId: eventIds[0] ?? null,
    };
  });

  const laneByKey = new Map();
  prepared.forEach(cluster => {
    if (!laneByKey.has(cluster.laneKey)) {
      laneByKey.set(cluster.laneKey, {
        key: cluster.laneKey,
        label: cluster.laneLabel,
        count: 0,
        minX: Infinity,
        maxX: -Infinity,
      });
    }
    const lane = laneByKey.get(cluster.laneKey);
    lane.count += cluster.eventCount;
    lane.minX = Math.min(lane.minX, cluster.minX);
    lane.maxX = Math.max(lane.maxX, cluster.maxX);
  });
  const orderedLanes = [...laneByKey.values()]
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .map((lane, index) => ({ ...lane, index }));
  const laneIndexByKey = Object.fromEntries(orderedLanes.map(lane => [lane.key, lane.index]));
  const rows = _assignClusterRows(prepared);
  return prepared.map((cluster, index) => ({
    ...cluster,
    stackRow: rows[index],
    laneIndex: laneIndexByKey[cluster.laneKey] ?? rows[index],
    y: null,
  }));
}

function _assignClusterRows(clusters) {
  const rowEnds = [];
  return clusters.map(cluster => {
    const left = cluster.x - cluster.width / 2 - SHARED_CLUSTER_CLEARANCE;
    let rowIndex = rowEnds.findIndex(lastRight => left - lastRight >= 0);
    if (rowIndex === -1) {
      rowIndex = rowEnds.length;
      rowEnds.push(cluster.x + cluster.width / 2 + SHARED_CLUSTER_CLEARANCE);
    } else {
      rowEnds[rowIndex] = cluster.x + cluster.width / 2 + SHARED_CLUSTER_CLEARANCE;
    }
    return rowIndex;
  });
}

function _buildSharedClusterLanes(clusters, axisY, timelineW) {
  const byLane = new Map();
  clusters.forEach(cluster => {
    if (!byLane.has(cluster.laneKey)) {
      byLane.set(cluster.laneKey, {
        key: cluster.laneKey,
        label: cluster.laneLabel,
        laneIndex: cluster.laneIndex,
        eventCount: 0,
        clusterCount: 0,
      });
    }
    const lane = byLane.get(cluster.laneKey);
    lane.eventCount += cluster.eventCount;
    lane.clusterCount += 1;
  });
  return [...byLane.values()]
    .sort((a, b) => a.laneIndex - b.laneIndex)
    .map(lane => ({
      ...lane,
      x: TIMELINE_X0,
      y: axisY - SHARED_CLUSTER_BASE_OFFSET - lane.laneIndex * SHARED_CLUSTER_LANE_GAP,
      width: timelineW,
      height: SHARED_CLUSTER_ROW_GAP,
    }));
}

function _sharedLaneKey(anchor) {
  const activity = anchor?.activity ?? "Unknown";
  const types = [...new Set((anchor?.memberships ?? []).map(membership => membership.entity_type))]
    .sort()
    .join("+") || "entities";
  return `${activity}__${types}`;
}

function _sharedLaneLabel(anchor) {
  const activity = anchor?.activity ?? "Unknown";
  const types = [...new Set((anchor?.memberships ?? []).map(membership => membership.entity_type))]
    .sort()
    .slice(0, 2)
    .join("+");
  return types ? `${activity} / ${types}` : activity;
}

function _buildAxisTicks(minTime, maxTime, timelineW) {
  const tickCount = 6;
  const span = Math.max(maxTime - minTime, 1);
  return Array.from({ length: tickCount }, (_, index) => {
    const ratio = tickCount === 1 ? 0 : index / (tickCount - 1);
    const time = minTime + span * ratio;
    const date = new Date(time);
    return {
      x: TIMELINE_X0 + timelineW * ratio,
      label: Number.isFinite(time)
        ? date.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "2-digit" })
        : "n/a",
    };
  });
}

function _buildTimeScale(allTimes, timelineW) {
  if (!allTimes.length) {
    const rangeMin = 0;
    const rangeMax = 1;
    return {
      rangeMin,
      rangeMax,
      rawMin: rangeMin,
      rawMax: rangeMax,
      mode: "linear",
      isClipped: false,
      xForTime: () => TIMELINE_X0,
    };
  }

  const sorted = [...allTimes].sort((a, b) => a - b);
  const rawMin = sorted[0];
  const rawMax = sorted.at(-1);
  const rawSpan = Math.max(rawMax - rawMin, 1);
  const q01 = _quantileSorted(sorted, 0.01);
  const q99 = _quantileSorted(sorted, 0.99);
  const robustSpan = Math.max(q99 - q01, 1);
  const robustRatio = robustSpan / rawSpan;
  const shouldClip = sorted.length >= 40
    && robustRatio < 0.35
    && (q01 > rawMin || q99 < rawMax);

  const rangeMin = shouldClip ? q01 : rawMin;
  const rangeMax = shouldClip ? q99 : rawMax;
  const span = Math.max(rangeMax - rangeMin, 1);

  return {
    rangeMin,
    rangeMax,
    rawMin,
    rawMax,
    mode: shouldClip ? "robust-clipped" : "linear",
    isClipped: shouldClip,
    xForTime: time => {
      const resolved = Number.isFinite(time) ? time : rangeMin;
      const clamped = Math.max(rangeMin, Math.min(rangeMax, resolved));
      return TIMELINE_X0 + ((clamped - rangeMin) / span) * timelineW;
    },
  };
}

function _quantileSorted(sorted, ratio) {
  if (!sorted.length) return 0;
  const clampedRatio = Math.max(0, Math.min(1, ratio));
  const index = (sorted.length - 1) * clampedRatio;
  const lo = Math.floor(index);
  const hi = Math.ceil(index);
  if (lo === hi) return sorted[lo];
  const mix = index - lo;
  return sorted[lo] * (1 - mix) + sorted[hi] * mix;
}

function _compareAnchors(a, b) {
  return (a?.date?.getTime?.() ?? 0) - (b?.date?.getTime?.() ?? 0)
    || String(a?.event_id ?? "").localeCompare(String(b?.event_id ?? ""));
}
