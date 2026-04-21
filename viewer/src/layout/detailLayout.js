"use strict";

export const DETAIL_PAD_X = 34;
export const DETAIL_PAD_TOP = 34;
export const DETAIL_PAD_BOTTOM = 34;
export const EVENT_TRACK_Y = 84;
export const TIMELINE_X0 = 304;
export const TIMELINE_PAD_R = 54;
export const BAND_HEADER_H = 34;
export const LANE_H = 36;
export const BAND_GAP = 24;
export const EVENT_ANCHOR_R = 6.5;
export const LANE_MARKER_R = 5;
export const RELATION_PORT_X = TIMELINE_X0 - 26;

const EVENT_STACK_GAP = 18;
const EVENT_STACK_BASE_OFFSET = 12;
const EVENT_STACK_CLEARANCE = 15;
const HEADER_RESERVED_H = 86;

export function computeDetailLayout(graph, width) {
  const totalWidth = Math.max(width - 18, TIMELINE_X0 + 420);
  const bandX = 18;
  const bandWidth = Math.max(totalWidth - bandX - 20, 420);
  const timelineW = Math.max(totalWidth - TIMELINE_X0 - TIMELINE_PAD_R, 360);
  const anchors = [...(graph?.eventAnchors ?? [])].sort(_compareAnchors);
  const bands = [...(graph?.bands ?? [])];
  const allTimes = anchors.map(anchor => anchor.date?.getTime()).filter(Number.isFinite);
  const minTime = allTimes.length ? Math.min(...allTimes) : 0;
  const maxTime = allTimes.length ? Math.max(...allTimes) : 1;
  const span = Math.max(maxTime - minTime, 1);

  const xs = anchors.map(anchor => TIMELINE_X0 + (((anchor.date?.getTime?.() ?? minTime) - minTime) / span) * timelineW);
  const stackRows = _assignAnchorRows(anchors, xs);
  const stackDepth = Math.max(...stackRows, -1) + 1;
  const axisY = DETAIL_PAD_TOP + HEADER_RESERVED_H + Math.max(stackDepth, 1) * EVENT_STACK_GAP + 18;

  const laidAnchors = anchors.map((anchor, index) => ({
    ...anchor,
    x: xs[index],
    y: axisY - EVENT_STACK_BASE_OFFSET - stackRows[index] * EVENT_STACK_GAP,
    stackRow: stackRows[index],
    r: anchor.isSharedEvent ? EVENT_ANCHOR_R + Math.min(anchor.sharedEntityIds.length - 1, 4) : EVENT_ANCHOR_R,
  }));
  const anchorById = Object.fromEntries(laidAnchors.map(anchor => [anchor.event_id, anchor]));

  let currentY = axisY + 58;
  const laidBands = bands.map((band, bandIndex) => {
    const bandTop = currentY;
    const lanes = band.lanes.map((lane, laneIndex) => {
      const y = bandTop + BAND_HEADER_H + laneIndex * LANE_H + LANE_H / 2;
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
        const curve = Math.min(18, Math.max(10, Math.abs(dx) * 0.1));
        return {
          ...edge,
          x1: source.x,
          y1: y,
          x2: target.x,
          y2: y,
          cx: (source.x + target.x) / 2,
          cy: y - curve - 2,
        };
      }).filter(Boolean);
      return {
        ...lane,
        bandIndex,
        laneIndex,
        x: bandX + 10,
        width: bandWidth - 20,
        y,
        memberships,
        dfEdges,
        relationPortX: RELATION_PORT_X,
      };
    });
    const bandHeight = BAND_HEADER_H + Math.max(lanes.length, 1) * LANE_H;
    currentY += bandHeight + BAND_GAP;
    return {
      ...band,
      x: bandX,
      width: bandWidth,
      y: bandTop,
      height: bandHeight,
      lanes,
      headerY: bandTop + 22,
    };
  });

  const lanePositionById = {};
  laidBands.forEach(band => band.lanes.forEach(lane => { lanePositionById[lane.entity_id] = lane; }));

  const corrLinks = laidAnchors.flatMap(anchor =>
    (anchor.memberships ?? [])
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
      }))
  );

  const sharedGuides = laidAnchors
    .filter(anchor => anchor.isSharedEvent)
    .map(anchor => {
      const membershipYs = (anchor.memberships ?? [])
        .map(membership => lanePositionById[membership.entity_id]?.y)
        .filter(Number.isFinite);
      if (!membershipYs.length) return null;
      return {
        event_id: anchor.event_id,
        x: anchor.x,
        y1: Math.min(anchor.y, ...membershipYs),
        y2: Math.max(anchor.y, ...membershipYs),
        entityCount: anchor.sharedEntityIds.length,
      };
    })
    .filter(Boolean);

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
    bands: laidBands,
    corrLinks,
    sharedGuides,
    relationLinks,
    axis: {
      y: axisY,
      x1: TIMELINE_X0,
      x2: TIMELINE_X0 + timelineW,
      ticks: _buildAxisTicks(minTime, maxTime, timelineW),
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

function _compareAnchors(a, b) {
  return (a?.date?.getTime?.() ?? 0) - (b?.date?.getTime?.() ?? 0)
    || String(a?.event_id ?? "").localeCompare(String(b?.event_id ?? ""));
}
