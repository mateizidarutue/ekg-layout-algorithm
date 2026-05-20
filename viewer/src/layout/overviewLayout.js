"use strict";

// Extracted from layout.js: overview network, variant, and DFG layout.

// ── Type-level EKG layout constants ───────────────────────────────────────────
const TEKG_PAD_LEFT   = 152;
const TEKG_PAD_RIGHT  = 52;
const TEKG_PAD_TOP    = 46;
const TEKG_BAND_H     = 138;
const TEKG_BAND_GAP   = 24;
const TEKG_NODE_MIN_R = 7;
const TEKG_NODE_MAX_R = 24;
const TEKG_NODE_MIN_SEP = 56;

export function computeTypeEKGLayout(typeEKG, width) {
  if (!typeEKG || !typeEKG.entityTypes.length) return { bands: [], syncArcs: [], totalHeight: 120 };

  const innerW   = Math.max(width - TEKG_PAD_LEFT - TEKG_PAD_RIGHT, 320);
  const timeSpan = Math.max(typeEKG.maxTime - typeEKG.minTime, 1);
  const xFromTime = t => TEKG_PAD_LEFT + ((t - typeEKG.minTime) / timeSpan) * innerW;

  const allCounts = typeEKG.entityTypes.flatMap(t => typeEKG.bandsByType[t].nodes.map(n => n.count));
  const maxCount  = Math.max(...allCounts, 1);
  const rScale    = count => TEKG_NODE_MIN_R + Math.sqrt(count / maxCount) * (TEKG_NODE_MAX_R - TEKG_NODE_MIN_R);

  let y = TEKG_PAD_TOP;
  const bandLayouts = {};

  typeEKG.entityTypes.forEach(type => {
    const band = typeEKG.bandsByType[type];
    const cy   = y + TEKG_BAND_H / 2;

    const rawNodes = band.nodes.map(node => ({
      ...node,
      x: xFromTime(node.meanTimestamp),
      y: cy,
      r: rScale(node.count),
    }));
    const nodes = _spread1D(rawNodes, TEKG_NODE_MIN_SEP, TEKG_PAD_LEFT, TEKG_PAD_LEFT + innerW);
    const nodeByAct = Object.fromEntries(nodes.map(n => [n.activity, n]));

    const maxDf = Math.max(...band.dfEdges.map(e => e.count), 1);
    const edges = band.dfEdges
      .filter(e => nodeByAct[e.source] && nodeByAct[e.target])
      .map(e => {
        const s = nodeByAct[e.source], t = nodeByAct[e.target];
        const dx    = t.x - s.x;
        const curve = Math.max(18, Math.min(54, Math.abs(dx) * 0.28));
        const sw    = 0.8 + (e.count / maxDf) * 2.8;
        return { ...e, sw,
          x1: s.x + (dx < 0 ? -s.r : s.r), y1: cy,
          x2: t.x + (dx < 0 ? t.r : -t.r),  y2: cy,
          cx: (s.x + t.x) / 2, cy: cy - curve };
      });

    bandLayouts[type] = { type, y, height: TEKG_BAND_H, cy, nodes, edges, nodeByAct };
    y += TEKG_BAND_H + TEKG_BAND_GAP;
  });

  // Sync arcs between bands
  const maxSync = Math.max(...typeEKG.syncArcs.map(a => a.count), 1);
  const syncArcs = typeEKG.syncArcs.map(arc => {
    const b1 = bandLayouts[arc.type1], b2 = bandLayouts[arc.type2];
    if (!b1 || !b2) return null;
    const n1 = b1.nodeByAct[arc.activity], n2 = b2.nodeByAct[arc.activity];
    if (!n1 || !n2) return null;
    const sw = 0.7 + (arc.count / maxSync) * 2.8;
    return { ...arc, sw,
      x1: n1.x, y1: n1.y + n1.r,
      x2: n2.x, y2: n2.y - n2.r,
      cx: (n1.x + n2.x) / 2, cy: (n1.y + n2.y) / 2 };
  }).filter(Boolean);

  const totalHeight = Math.max(y - TEKG_BAND_GAP + TEKG_PAD_TOP, 200);
  return { bands: Object.values(bandLayouts), syncArcs, totalHeight, padLeft: TEKG_PAD_LEFT, innerW, minTime: typeEKG.minTime, maxTime: typeEKG.maxTime };
}

function _spread1D(nodes, minSep, minX, maxX) {
  if (nodes.length <= 1) return nodes;
  const sorted = [...nodes].sort((a, b) => a.x - b.x);
  for (let i = 1; i < sorted.length; i++) {
    const needed = sorted[i - 1].x + minSep;
    if (sorted[i].x < needed) sorted[i] = { ...sorted[i], x: needed };
  }
  // Shift left if right edge exceeds maxX
  const overflow = sorted[sorted.length - 1].x - maxX;
  if (overflow > 0) sorted.forEach((n, i) => { sorted[i] = { ...n, x: n.x - overflow }; });
  // Clamp to minX
  sorted.forEach((n, i) => { if (n.x < minX) sorted[i] = { ...n, x: minX }; });
  return sorted;
}

const OVERVIEW_PAD_X = 32;
const OVERVIEW_PAD_Y = 26;
const VARIANT_HEADER_H = 34;
const VARIANT_ROW_GAP = 8;
const VARIANT_DFG_GAP = 34;
const VARIANT_DFG_H = 200;
const COMMUNITY_GAP = 36;
const COMMUNITY_SPIRAL_STEP = 18;
const COMMUNITY_SPIRAL_TURNS = Math.PI * (3 - Math.sqrt(5));
const CLUSTER_INNER_R = 44;
const CLUSTER_RING_GAP = 26;
const SATELLITE_RING_GAP = 28;
const SATELLITES_PER_RING = 5;
const FOCUS_RESOURCE_LIMIT = 8;
const FOCUS_ATTR_LIMIT = 8;
const OVERVIEW_COMMUNITY_MIN_R = 18;
const OVERVIEW_COMMUNITY_MAX_R = 34;
const OVERVIEW_COMMUNITY_MIN_CELL_W = 118;
const OVERVIEW_COMMUNITY_CELL_H = 124;

function _clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function computeVariantLayout(variantData, width, options = {}) {
  const variants = variantData?.variants ?? [];
  const viewportHeight = options.viewportHeight ?? 760;
  const leftPad = OVERVIEW_PAD_X;
  const rightPad = OVERVIEW_PAD_X;
  const rowWidth = Math.max(width - leftPad - rightPad, 320);
  const rowX = leftPad;
  const headerY = OVERVIEW_PAD_Y;
  const baseY = headerY + VARIANT_HEADER_H;
  const activityColorByName = options.activityColorByName ?? {};
  const rowCount = Math.max(variants.length, 1);
  const gapTotal = Math.max(variants.length - 1, 0) * VARIANT_ROW_GAP;
  const dfgHeight = options.dfgHeight ?? VARIANT_DFG_H;
  const availableRowsHeight = Math.max(
    viewportHeight - (OVERVIEW_PAD_Y * 2 + VARIANT_HEADER_H + dfgHeight + VARIANT_DFG_GAP + 16),
    rowCount * 32 + gapTotal,
  );
  const rowHeight = options.rowHeight ?? _clampNumber(Math.floor((availableRowsHeight - gapTotal) / rowCount), 32, 64);
  const chipHeight = _clampNumber(rowHeight - 14, 22, 34);
  const badgeAreaWidth = _clampNumber(Math.round(rowHeight * 1.75), 72, 98);
  const badgeWidth = _clampNumber(Math.round(rowHeight * 1.15), 44, 58);
  const badgeHeight = _clampNumber(Math.round(chipHeight + 6), 24, 34);
  const chipGap = _clampNumber(Math.round(rowHeight * 0.22), 6, 14);
  const percentZoneWidth = 54;
  const chipStartX = rowX + badgeAreaWidth;
  const chipRegionWidth = Math.max(rowWidth - badgeAreaWidth - percentZoneWidth - 18, 120);
  let maxChipWidth = 80;

  const rows = variants.map((variant, index) => {
    const y = baseY + index * (rowHeight + VARIANT_ROW_GAP);
    const badgeY = y + rowHeight / 2;
    const sequence = variant.sequence ?? [];
    const slotCount = Math.max(sequence.length, 1);
    const slotWidth = chipRegionWidth / slotCount;
    const fillRatio = slotCount > 7 ? 0.8 : slotCount > 5 ? 0.84 : 0.88;
    const badgeRectX = rowX + 14;
    const badgeRectY = badgeY - badgeHeight / 2;
    const chips = sequence.map((activity, activityIndex) => {
      const naturalWidth = Math.max(chipHeight * 2.25, Math.ceil(chipHeight * 0.9 + String(activity ?? "").length * (chipHeight > 28 ? 6.1 : 5.6)));
      const maxSlotWidth = Math.max(slotWidth - chipGap, 56);
      const fillWidth = slotWidth * fillRatio;
      const chipWidth = Math.max(56, Math.min(maxSlotWidth, Math.max(fillWidth, Math.min(naturalWidth, maxSlotWidth))));
      maxChipWidth = Math.max(maxChipWidth, chipWidth);
      const x = chipStartX + activityIndex * slotWidth + Math.max((slotWidth - chipWidth) / 2, 0);
      return { activity, x, y: y + (rowHeight - chipHeight) / 2, w: chipWidth, h: chipHeight, color: activityColorByName[activity] ?? "#64748b" };
    });
    return {
      variant, x: rowX, y, w: rowWidth, h: rowHeight, chips,
      badgeX: badgeRectX + badgeWidth / 2, badgeY, badgeW: badgeWidth, badgeH: badgeHeight, badgeRectX, badgeRectY,
      chipStartX, chipEndX: chipStartX + chipRegionWidth, percentX: rowX + rowWidth - 10, percentY: badgeY,
    };
  });

  const rowsBottom = rows.at(-1)?.y ?? baseY;
  const totalHeight = rows.length ? rowsBottom + rowHeight + 10 : baseY + 12;
  return { rows, totalHeight, chipWidth: maxChipWidth, headerX: leftPad, headerY, summaryX: rowX + rowWidth, rowHeight, badgeWidth, rowX, rowWidth, dfgHeight };
}

export function computeDfGraphLayout(dfGraph, width, height) {
  const nodes = [...(dfGraph?.nodes ?? [])];
  const edges = [...(dfGraph?.edges ?? [])];
  if (!nodes.length) return { nodes: [], edges: [] };
  const topPad = 26, sidePad = 36;
  const usableWidth = Math.max(width - sidePad * 2, 1);
  const usableHeight = Math.max(height - topPad * 2, 1);
  const laneCount = Math.min(3, Math.max(1, Math.ceil(nodes.length / 3)));
  const laneGap = laneCount > 1 ? usableHeight / (laneCount - 1) : 0;
  const outDegreeById = {}, inDegreeById = {};
  edges.forEach(e => { outDegreeById[e.source] = (outDegreeById[e.source] ?? 0) + 1; inDegreeById[e.target] = (inDegreeById[e.target] ?? 0) + 1; });
  const orderedNodes = [...nodes].sort((a, b) => (a.avgIndex ?? Infinity) - (b.avgIndex ?? Infinity) || (inDegreeById[a.id] ?? 0) - (inDegreeById[b.id] ?? 0) || b.count - a.count || a.label.localeCompare(b.label));
  const xGap = orderedNodes.length > 1 ? usableWidth / (orderedNodes.length - 1) : 0;
  const laidOutNodes = orderedNodes.map((node, index) => {
    const lane = laneCount === 1 ? 0 : index % laneCount;
    const laneOffset = laneCount === 1 ? usableHeight / 2 : lane * laneGap;
    return { ...node, x: sidePad + index * xGap, y: topPad + laneOffset };
  });
  const posById = Object.fromEntries(laidOutNodes.map(n => [n.id, n]));
  const laidOutEdges = edges.filter(e => posById[e.source] && posById[e.target]).map(e => {
    const src = posById[e.source], tgt = posById[e.target];
    const dx = tgt.x - src.x, dy = tgt.y - src.y;
    const direction = dx >= 0 ? 1 : -1;
    const curve = Math.max(18, Math.min(52, Math.abs(dx) * 0.18 + Math.abs(dy) * 0.2));
    return { ...e, x1: src.x, y1: src.y, x2: tgt.x, y2: tgt.y, cx: (src.x + tgt.x) / 2, cy: (src.y + tgt.y) / 2 - curve * direction * 0.12 };
  });
  return { nodes: laidOutNodes, edges: laidOutEdges };
}

export function computeOverviewNetworkLayout(graph, width, options = {}) {
  const clusters = [...graph.clusters].sort((a, b) => b.nodeIds.length - a.nodeIds.length || a.label.localeCompare(b.label));
  if (graph.meta?.focusCommunityId && clusters.length === 1) {
    return _layoutFocusedCommunity(graph, width, clusters[0], options);
  }

  const nodeLayouts = [];
  const nodePos = {};

  const maxCommunitySize = Math.max(...clusters.map(cluster => cluster.nodeIds?.length ?? 0), 1);
  const clusterModels = clusters.map(cluster => {
    const members = graph.nodes.filter(n => cluster.nodeIds.includes(n.id))
      .sort((a, b) => b.weightedDegree - a.weightedDegree || b.degree - a.degree || a.id.localeCompare(b.id));
    const radius = _overviewCommunityRadius(members.length, maxCommunitySize);
    return { ...cluster, members, radius, outerRadius: radius + 22, satellites: [] };
  });

  const placed = _layoutClustersInViewport(clusterModels, width, options.viewportHeight ?? 760);

  const bounds = placed.reduce((acc, c) => {
    acc.minX = Math.min(acc.minX, c.cx - c.outerRadius); acc.maxX = Math.max(acc.maxX, c.cx + c.outerRadius);
    acc.minY = Math.min(acc.minY, c.cy - c.outerRadius); acc.maxY = Math.max(acc.maxY, c.cy + c.outerRadius);
    return acc;
  }, { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity });

  const shiftX = 0;
  const shiftY = 0;

  const clusterLayouts = placed.map(cluster => {
    const cx = cluster.cx + shiftX, cy = cluster.cy + shiftY;
    cluster.members.forEach((node, memberIndex) => {
      let x = cx, y = cy;
      if (memberIndex > 0) {
        const ringIndex = Math.floor((memberIndex - 1) / 6) + 1;
        const slotIndex = (memberIndex - 1) % 6;
        const slotCount = Math.min(6 * ringIndex, cluster.members.length - (ringIndex - 1) * 6 - 1);
        const angle = (-Math.PI / 2) + (slotIndex / Math.max(slotCount, 1)) * Math.PI * 2;
        const ringRadius = CLUSTER_INNER_R + (ringIndex - 1) * CLUSTER_RING_GAP;
        x = cx + Math.cos(angle) * ringRadius; y = cy + Math.sin(angle) * ringRadius;
      }
      const layoutNode = { ...node, x, y, r: 12 + Math.min(node.filteredEvents, 40) * 0.12 };
      nodeLayouts.push(layoutNode); nodePos[node.id] = layoutNode;
    });
    return { ...cluster, x: cx, y: cy, width: cluster.outerRadius * 2, height: cluster.outerRadius * 2, count: cluster.members.length, satellites: cluster.satellites.map(s => ({ ...s, x: cx + s.dx, y: cy + s.dy })) };
  });

  const edgeLayouts = graph.edges.filter(e => nodePos[e.source] && nodePos[e.target]).map(e => {
    const src = nodePos[e.source], tgt = nodePos[e.target];
    const dx = tgt.x - src.x, dy = tgt.y - src.y, dist = Math.hypot(dx, dy) || 1;
    const nx = dx / dist, ny = dy / dist;
    const mx = (src.x + tgt.x) / 2, my = (src.y + tgt.y) / 2;
    const curve = Math.min(42, dist * 0.16);
    return { ...e, x1: src.x + nx * src.r, y1: src.y + ny * src.r, x2: tgt.x - nx * tgt.r, y2: tgt.y - ny * tgt.r, cx: mx - ny * curve, cy: my + nx * curve };
  });

  return {
    overviewNetwork: true,
    totalHeight: Math.max((options.viewportHeight ?? 760) - 20, bounds.maxY + OVERVIEW_PAD_Y + 40),
    network: { nodes: nodeLayouts, edges: edgeLayouts, communityEdges: graph.communityEdges ?? [], clusters: clusterLayouts, meta: graph.meta },
  };
}

function _layoutClustersInViewport(clusterModels, width, viewportHeight) {
  if (!clusterModels.length) return [];
  const availableW = Math.max(width - OVERVIEW_PAD_X * 2, 360);
  const count = clusterModels.length;
  const columns = Math.max(1, Math.min(count, Math.floor(availableW / OVERVIEW_COMMUNITY_MIN_CELL_W)));
  const rows = Math.ceil(count / columns);
  const cellW = availableW / columns;
  const cellH = OVERVIEW_COMMUNITY_CELL_H;
  const totalW = availableW;
  const originX = OVERVIEW_PAD_X + Math.max(0, (availableW - totalW) / 2);
  const originY = OVERVIEW_PAD_Y + 42;

  return clusterModels.map((cluster, index) => {
    const row = Math.floor(index / columns);
    const col = index % columns;
    const rowCount = row === rows - 1 ? count - row * columns : columns;
    const rowOffset = (columns - rowCount) * cellW * 0.5;
    return {
      ...cluster,
      cx: originX + rowOffset + col * cellW + cellW / 2,
      cy: originY + row * cellH + cellH / 2,
    };
  });
}

function _overviewCommunityRadius(size, maxSize) {
  const ratio = Math.sqrt(Math.max(size, 1) / Math.max(maxSize, 1));
  return OVERVIEW_COMMUNITY_MIN_R + ratio * (OVERVIEW_COMMUNITY_MAX_R - OVERVIEW_COMMUNITY_MIN_R);
}

function _layoutFocusedCommunity(graph, width, cluster, options = {}) {
  const members = graph.nodes.filter(n => cluster.nodeIds.includes(n.id))
    .sort((a, b) => b.weightedDegree - a.weightedDegree || b.degree - a.degree || a.id.localeCompare(b.id));
  const centerX = Math.max(width * 0.5, OVERVIEW_PAD_X + 360);
  const viewportHeight = options.viewportHeight ?? 760;
  const centerY = Math.max(OVERVIEW_PAD_Y + 250, viewportHeight * 0.48);
  const focusRadius = Math.max(158, Math.min(width * 0.22, viewportHeight * 0.26, 260));
  const nodeLayouts = [], nodePos = {};

  members.forEach((node, index) => {
    let x = centerX, y = centerY;
    if (index > 0) {
      const angle = index * COMMUNITY_SPIRAL_TURNS;
      const distance = Math.min(focusRadius, 26 + Math.sqrt(index) * 26);
      x = centerX + Math.cos(angle) * distance; y = centerY + Math.sin(angle) * distance;
    }
    const layoutNode = { ...node, x, y, r: 13 + Math.min(node.filteredEvents, 36) * 0.18 };
    nodeLayouts.push(layoutNode); nodePos[node.id] = layoutNode;
  });

  const resourceSatellites = _layoutFocusSatelliteColumn((cluster.resources ?? []).slice(0, FOCUS_RESOURCE_LIMIT), centerX - focusRadius - 150, centerY - 120, "resource");
  const attributeSatellites = _layoutFocusSatelliteColumn((cluster.attributes ?? []).slice(0, FOCUS_ATTR_LIMIT), centerX + focusRadius + 150, centerY - 120, "attribute");
  const satellites = [...resourceSatellites, ...attributeSatellites];

  const edgeLayouts = graph.edges.filter(e => nodePos[e.source] && nodePos[e.target]).map(e => {
    const src = nodePos[e.source], tgt = nodePos[e.target];
    const dx = tgt.x - src.x, dy = tgt.y - src.y, dist = Math.hypot(dx, dy) || 1;
    const nx = dx / dist, ny = dy / dist;
    const mx = (src.x + tgt.x) / 2, my = (src.y + tgt.y) / 2;
    const curve = Math.min(54, dist * 0.18);
    return { ...e, x1: src.x + nx * src.r, y1: src.y + ny * src.r, x2: tgt.x - nx * tgt.r, y2: tgt.y - ny * tgt.r, cx: mx - ny * curve, cy: my + nx * curve };
  });

  const minX = Math.min(centerX - focusRadius - 220, ...satellites.map(s => s.x - s.w / 2));
  const maxX = Math.max(centerX + focusRadius + 220, ...satellites.map(s => s.x + s.w / 2));
  const minY = Math.min(centerY - focusRadius - 130, ...satellites.map(s => s.y - s.h / 2));
  const maxY = Math.max(centerY + focusRadius + 130, ...satellites.map(s => s.y + s.h / 2));

  return {
    overviewNetwork: true, totalHeight: maxY + OVERVIEW_PAD_Y,
    network: {
      nodes: nodeLayouts, edges: edgeLayouts, communityEdges: [],
      clusters: [{ ...cluster, x: centerX, y: centerY, radius: focusRadius, outerRadius: Math.max(maxX - centerX, centerX - minX, maxY - centerY, centerY - minY), width: maxX - minX, height: maxY - minY, count: members.length, satellites }],
      meta: graph.meta,
    },
  };
}

function _layoutSatelliteArc(entries, baseRadius, startAngle, endAngle) {
  return (entries ?? []).map((entry, index) => {
    const ringIndex = Math.floor(index / SATELLITES_PER_RING);
    const slotIndex = index % SATELLITES_PER_RING;
    const remaining = Math.max((entries?.length ?? 0) - ringIndex * SATELLITES_PER_RING, 0);
    const slotCount = Math.min(SATELLITES_PER_RING, remaining || SATELLITES_PER_RING);
    const angle = startAngle + ((slotIndex + 0.5) / Math.max(slotCount, 1)) * (endAngle - startAngle);
    const radius = baseRadius + ringIndex * SATELLITE_RING_GAP;
    const label = entry.shortLabel ?? entry.label ?? "";
    return { ...entry, dx: Math.cos(angle) * radius, dy: Math.sin(angle) * radius, w: Math.min(136, Math.max(44, 18 + label.length * (entry.type === "attribute" ? 5.3 : 4.9))), h: entry.type === "attribute" ? 18 : 20, angle };
  });
}

function _layoutFocusSatelliteColumn(entries, x, startY, type) {
  return (entries ?? []).map((entry, index) => {
    const label = entry.shortLabel ?? entry.label ?? "";
    return { ...entry, type, x, y: startY + index * 28, w: Math.min(168, Math.max(72, 20 + label.length * (type === "attribute" ? 5.1 : 4.8))), h: type === "attribute" ? 18 : 20 };
  });
}
