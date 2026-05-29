"use strict";

// Layout geometry for T3's variant overview (ranked rows) + the activity DF
// graph that sits beneath it. The community-network and type-EKG layouts
// that used to live here have been removed; they were artifacts of the
// deleted Atlas screen.


const OVERVIEW_PAD_X = 32;
const OVERVIEW_PAD_Y = 26;
const VARIANT_HEADER_H = 34;
const VARIANT_ROW_GAP = 8;
const VARIANT_DFG_GAP = 34;
const VARIANT_DFG_H = 200;

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

