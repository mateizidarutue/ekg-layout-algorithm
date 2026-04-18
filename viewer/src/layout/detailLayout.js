"use strict";

// Extracted from layout.js: detail block layout (PO-centric swim lanes).

export const ITEM_COLORS = ["#159a67", "#8b5cf6", "#d97706", "#dc2626", "#0284c7"];
export const PO_COLOR = "#2563eb";
export const PO_R = 20;
export const ITEM_R = 14;
export const EVENT_R = 7;
export const PO_X = 80;
export const ITEM_X = 200;
export const TIMELINE_X0 = 272;

const ROW_H_COLLAPSED = 52;
const ROW_H_EXPANDED = 124;
const BLOCK_PAD_TOP = 24;
const BLOCK_PAD_BOT = 16;
const MULTI_PO_GAP = 28;
const TIMELINE_PAD_R = 48;
const MIN_EVENT_SPACING = 22;
const MIN_RESOURCE_SPACING = 46;
const HOUR_MS = 1000 * 60 * 60;

export function computeDetailLayout(graphs, expanded, width, options = {}) {
  const timelineW = Math.max(width - TIMELINE_X0 - TIMELINE_PAD_R, 180);
  let curY = 20;
  const poBlocks = [];
  graphs.forEach(graph => {
    const block = _layoutBlock(graph, expanded, curY, timelineW, options);
    poBlocks.push(block);
    curY += block.totalHeight + MULTI_PO_GAP;
  });
  return {
    overviewNetwork: false, poBlocks, totalHeight: curY,
    patterns: poBlocks[0]?.patterns ?? { dominantPattern: [], entityPatterns: {} },
    summary: _summarizeFocusBlocks(poBlocks),
  };
}

function _layoutBlock(graph, expanded, startY, timelineW, options = {}) {
  const { po, poAttrs, itemAttrsById } = graph;
  const allItems = [...(graph.allItems ?? graph.items ?? [])];
  const visibleItems = [...(graph.items ?? allItems)];
  const allEvents = [...(graph.allEvents ?? graph.events ?? [])];
  const allDfItem = [...(graph.allDfItem ?? graph.dfItem ?? [])];
  const allDfPo = [...(graph.allDfPo ?? graph.dfPo ?? [])];
  allEvents.forEach(e => { if (!e.id) e.id = e.event_id; });
  const evById = Object.fromEntries(allEvents.map(e => [e.id, e]));
  const eventsByItem = _groupBy(allEvents, e => e.poitem_id);
  const dfItemByEntity = _groupBy(allDfItem, edge => edge.entityId);
  const patternAnalysis = _analyzeEntityPatterns(allItems, eventsByItem, dfItemByEntity, evById);

  const baseItems = options.showDeviantsOnly
    ? allItems.filter(item => !(patternAnalysis.entityPatterns[item]?.followsDominant ?? true))
    : visibleItems;
  const syncOnlyItems = options.showSyncOnly ? _collectSyncItems(baseItems, patternAnalysis) : new Set();
  const items = options.showSyncOnly ? baseItems.filter(item => syncOnlyItems.has(item)) : baseItems;
  const effectiveExpanded = options.showSyncOnly ? new Set([...expanded, ...items]) : expanded;

  const rowHeights = items.map(item => effectiveExpanded.has(item) ? ROW_H_EXPANDED : ROW_H_COLLAPSED);
  const contentH = rowHeights.reduce((a, b) => a + b, 0);
  const totalHeight = BLOCK_PAD_TOP + contentH + BLOCK_PAD_BOT;
  const poMidY = startY + BLOCK_PAD_TOP + contentH / 2;

  // Global time axis: all items in this block share the same scale so that
  // temporal position is comparable across rows (May on the left, Aug on the right).
  const allValidTimes = allEvents.map(e => e.date?.getTime()).filter(Number.isFinite);
  const globalMinT = allValidTimes.length ? Math.min(...allValidTimes) : 0;
  const globalMaxT = allValidTimes.length ? Math.max(...allValidTimes) : 1;
  const globalSpan = Math.max(globalMaxT - globalMinT, 1);

  const itemRows = [];
  let rowY = startY + BLOCK_PAD_TOP;
  let blockContentMaxX = ITEM_X + ITEM_R + 180;

  items.forEach((item, i) => {
    const h = rowHeights[i];
    const midY = rowY + h / 2;
    const color = ITEM_COLORS[i % ITEM_COLORS.length];
    const isExp = effectiveExpanded.has(item);
    const itemAttrs = itemAttrsById?.[item] ?? {};
    const entityPattern = patternAnalysis.entityPatterns[item] ?? { sequence: [], followsDominant: true, entityType: "POItem" };
    const itemEvs = [...(eventsByItem[item] ?? [])].sort(_compareEvents);
    const evCount = itemEvs.length;
    const firstDate = itemEvs[0]?.date;
    const lastDate = itemEvs.at(-1)?.date;
    const dateRange = firstDate ? `${_fmt(firstDate)} -> ${_fmt(lastDate)}` : "no events";

    let timelineNodes = [], dfItemEdges = [], resourceNodes = [], resourceLinks = [], laneX2 = ITEM_X + ITEM_R + 180;

    if (isExp && itemEvs.length > 0) {
      // Place events on the global time axis
      let xs = itemEvs.map(e => TIMELINE_X0 + ((e.date.getTime() - globalMinT) / globalSpan) * timelineW);
      const xsIdeal = [...xs];
      // Forward pass: push right when too close
      for (let j = 1; j < xs.length; j++) { if (xs[j] - xs[j - 1] < MIN_EVENT_SPACING) xs[j] = xs[j - 1] + MIN_EVENT_SPACING; }
      // Backward pass: pull left toward ideal position when pushed past a later event
      for (let j = xs.length - 2; j >= 0; j--) { const cap = xs[j + 1] - MIN_EVENT_SPACING; if (xs[j] > cap) xs[j] = Math.max(cap, xsIdeal[j]); }
      timelineNodes = itemEvs.map((e, j) => ({ ...e, x: xs[j], y: midY, r: EVENT_R, color }));
      const posMap = Object.fromEntries(timelineNodes.map(n => [n.id, n]));

      dfItemEdges = (dfItemByEntity[item] ?? [])
        .filter(edge => { const se = evById[edge.source], te = evById[edge.target]; return se && te && se.poitem_id === item && te.poitem_id === item && posMap[edge.source] && posMap[edge.target]; })
        .map(edge => {
          const src = posMap[edge.source], tgt = posMap[edge.target];
          const srcEvent = evById[edge.source], tgtEvent = evById[edge.target];
          return {
            id: `df-${edge.entityId}-${edge.source}-${edge.target}`,
            entityId: edge.entityId, sourceId: edge.source, targetId: edge.target,
            sourceActivity: srcEvent?.activity ?? edge.source, targetActivity: tgtEvent?.activity ?? edge.target,
            gapHours: _hoursBetween(srcEvent?.date, tgtEvent?.date), isBottleneck: false,
            type: Math.abs(src.x - tgt.x) < 2 ? "arc" : "line",
            x1: src.x, y1: src.y, x2: tgt.x, y2: tgt.y, color,
          };
        });

      ({ resourceNodes, resourceLinks } = _buildResourceOverlay(timelineNodes, rowY, midY, TIMELINE_X0 + timelineW));
      const lastTimelineX = timelineNodes.at(-1)?.x ?? TIMELINE_X0;
      const lastResourceX = resourceNodes.reduce((max, n) => Math.max(max, n.x + 12), TIMELINE_X0);
      laneX2 = Math.max(lastTimelineX + EVENT_R + 46, lastResourceX + 18);
    }

    itemRows.push({
      item, i, h, midY, rowY, color,
      followsDominant: entityPattern.followsDominant, sequence: entityPattern.sequence, entityType: entityPattern.entityType,
      isExp, timelineNodes, dfItemEdges, resourceNodes, resourceLinks, itemAttrs, evCount, dateRange,
      syncEventCount: 0, showSyncOnly: Boolean(options.showSyncOnly), laneX2,
      corrEdge: { x1: ITEM_X, y1: midY, x2: PO_X, y2: poMidY },
    });
    blockContentMaxX = Math.max(blockContentMaxX, laneX2);
    rowY += h;
  });

  const allPos = {};
  itemRows.forEach(row => {
    if (row.isExp) row.timelineNodes.forEach(n => { allPos[n.id] = { x: n.x, y: n.y }; });
    else allEvents.filter(e => e.poitem_id === row.item).forEach(e => { allPos[e.id] = { x: ITEM_X, y: row.midY }; });
  });

  const displayedItemSet = new Set(itemRows.map(r => r.item));
  const dfPoEdges = (allDfPo ?? [])
    .filter(edge => { const se = evById[edge.source], te = evById[edge.target]; return se && te && se.poitem_id !== te.poitem_id && allPos[edge.source] && allPos[edge.target]; })
    .filter(edge => displayedItemSet.has(evById[edge.source]?.poitem_id) && displayedItemSet.has(evById[edge.target]?.poitem_id))
    .map(edge => {
      const src = allPos[edge.source], tgt = allPos[edge.target];
      const mx = (src.x + tgt.x) / 2, dy = Math.abs(src.y - tgt.y);
      const cy = Math.min(src.y, tgt.y) - Math.max(dy * 0.4, 24);
      return { id: `dfpo-${edge.source}-${edge.target}`, x1: src.x, y1: src.y, x2: tgt.x, y2: tgt.y, cx: mx, cy };
    });

  _annotateSyncEvents(itemRows, patternAnalysis, displayedItemSet);
  itemRows.forEach(row => { row.syncEventCount = row.timelineNodes.filter(n => n.isSyncEvent).length; });
  if (options.showSyncOnly) _pruneRowsToSyncEvents(itemRows);
  const bottleneckThresholdHours = _annotateBottlenecks(itemRows);
  const displayedDfItemCount = itemRows.reduce((sum, row) => sum + row.dfItemEdges.length, 0);

  return {
    po, items, patterns: {
      dominantPattern: patternAnalysis.dominantPattern,
      entityPatterns: Object.fromEntries(Object.entries(patternAnalysis.entityPatterns).map(([id, e]) => [id, { sequence: e.sequence, followsDominant: e.followsDominant }])),
      entityType: patternAnalysis.entityType,
    },
    totalHeight, poMidY, startY, itemRows, contentMaxX: blockContentMaxX, dfPoEdges, displayedDfItemCount,
    poAttrs, meta: graph.meta, bottleneckThresholdHours, isOverview: false,
  };
}

// ── Pattern analysis (identical to layout.js) ─────────────────────────────

function _analyzeEntityPatterns(entityIds, eventsByEntity, edgesByEntity, evById) {
  const entityEntries = {}, sequenceCounts = new Map();
  let entityType = "POItem";
  entityIds.forEach(entityId => {
    const events = [...(eventsByEntity[entityId] ?? [])].sort(_compareEvents);
    const edges = (edgesByEntity[entityId] ?? []).filter(e => evById[e.source] && evById[e.target]);
    const traced = _traceEntityPath(events, edges, evById);
    const sequence = traced.eventIds.map(id => evById[id]?.activity).filter(Boolean);
    const sequenceKey = JSON.stringify(sequence);
    if (sequence.length > 0) sequenceCounts.set(sequenceKey, (sequenceCounts.get(sequenceKey) ?? 0) + 1);
    entityType = edges[0]?.entityType ?? entityType;
    entityEntries[entityId] = { entityId, entityType: edges[0]?.entityType ?? entityType, sequence, eventIds: traced.eventIds, predecessorActivities: traced.predecessorActivities, successorActivities: traced.successorActivities, followsDominant: true };
  });

  const dominantPatternKey = [...sequenceCounts.entries()].sort((a, b) => b[1] - a[1] || JSON.parse(b[0]).length - JSON.parse(a[0]).length || a[0].localeCompare(b[0]))[0]?.[0] ?? "[]";
  const dominantPattern = JSON.parse(dominantPatternKey);
  Object.values(entityEntries).forEach(e => { e.followsDominant = e.sequence.length === 0 || _sameSequence(e.sequence, dominantPattern); });

  const eventMemberships = new Map(), syncContextsByEvent = new Map();
  Object.values(entityEntries).forEach(entry => {
    [...new Set(entry.eventIds)].forEach(eventId => {
      if (!eventMemberships.has(eventId)) eventMemberships.set(eventId, new Set());
      eventMemberships.get(eventId).add(entry.entityId);
      if (!syncContextsByEvent.has(eventId)) syncContextsByEvent.set(eventId, []);
      syncContextsByEvent.get(eventId).push({ entityId: entry.entityId, predecessorActivities: entry.predecessorActivities[eventId] ?? [], successorActivities: entry.successorActivities[eventId] ?? [] });
    });
  });

  return { entityType, dominantPattern, entityPatterns: entityEntries, eventMemberships, syncContextsByEvent };
}

function _traceEntityPath(events, edges, evById) {
  const predecessorIds = {}, successorIds = {};
  const nodeIds = new Set(events.map(e => e.id ?? e.event_id));
  edges.forEach(edge => {
    nodeIds.add(edge.source); nodeIds.add(edge.target);
    if (!successorIds[edge.source]) successorIds[edge.source] = [];
    if (!predecessorIds[edge.target]) predecessorIds[edge.target] = [];
    successorIds[edge.source].push(edge.target);
    predecessorIds[edge.target].push(edge.source);
  });
  const nodes = [...nodeIds].filter(id => evById[id]).sort(_compareEventIds(evById));
  const starts = nodes.filter(id => (predecessorIds[id] ?? []).length === 0);
  const orderedStarts = (starts.length ? starts : nodes).sort(_compareEventIds(evById));
  const visited = new Set(), orderedEventIds = [], queue = [...orderedStarts];
  while (queue.length) {
    let cur = queue.shift();
    while (cur && !visited.has(cur)) {
      orderedEventIds.push(cur); visited.add(cur);
      const nextIds = [...new Set(successorIds[cur] ?? [])].filter(id => !visited.has(id)).sort(_compareEventIds(evById));
      if (nextIds.length <= 1) { cur = nextIds[0] ?? null; continue; }
      queue.unshift(...nextIds.slice(1)); cur = nextIds[0];
    }
  }
  nodes.forEach(id => { if (!visited.has(id)) orderedEventIds.push(id); });

  const predecessorActivities = {}, successorActivities = {};
  nodes.forEach(id => {
    predecessorActivities[id] = [...new Set((predecessorIds[id] ?? []).map(pid => evById[pid]?.activity).filter(Boolean))];
    successorActivities[id] = [...new Set((successorIds[id] ?? []).map(sid => evById[sid]?.activity).filter(Boolean))];
  });
  return { eventIds: orderedEventIds, predecessorActivities, successorActivities };
}

function _annotateSyncEvents(itemRows, patternAnalysis, displayedItemSet) {
  itemRows.forEach(row => {
    row.timelineNodes = row.timelineNodes.map(node => {
      const sharedEntityIds = [...(patternAnalysis.eventMemberships.get(node.id) ?? new Set())].filter(id => displayedItemSet.has(id)).sort((a, b) => a.localeCompare(b));
      const syncDegree = Math.max(sharedEntityIds.length, 1);
      return { ...node, isSyncEvent: sharedEntityIds.length > 1, syncDegree, sharedEntityIds, syncContexts: (patternAnalysis.syncContextsByEvent.get(node.id) ?? []).filter(c => displayedItemSet.has(c.entityId)).sort((a, b) => a.entityId.localeCompare(b.entityId)) };
    });
  });
}

function _collectSyncItems(items, patternAnalysis) {
  const scopedItems = new Set(items ?? []), syncItems = new Set();
  (items ?? []).forEach(item => {
    const entry = patternAnalysis.entityPatterns[item];
    const hasSyncEvent = (entry?.eventIds ?? []).some(eventId => {
      const memberships = [...(patternAnalysis.eventMemberships.get(eventId) ?? new Set())].filter(id => scopedItems.has(id));
      return memberships.length > 1;
    });
    if (hasSyncEvent) syncItems.add(item);
  });
  return syncItems;
}

function _pruneRowsToSyncEvents(itemRows) {
  itemRows.forEach(row => {
    const syncNodes = row.timelineNodes.filter(n => n.isSyncEvent);
    const syncEventIds = new Set(syncNodes.map(n => n.id));
    row.timelineNodes = syncNodes;
    row.dfItemEdges = row.dfItemEdges.filter(e => syncEventIds.has(e.sourceId) || syncEventIds.has(e.targetId));
    const maxTimelineX = syncNodes.reduce((max, n) => Math.max(max, n.x), TIMELINE_X0);
    const overlay = _buildResourceOverlay(syncNodes, row.rowY, row.midY, maxTimelineX);
    row.resourceNodes = overlay.resourceNodes; row.resourceLinks = overlay.resourceLinks;
  });
}

function _buildResourceOverlay(timelineNodes, rowY, midY, maxX) {
  const resY = rowY + 42;
  const byResource = {};
  timelineNodes.filter(n => _hasResourceValue(n.org_resource)).forEach(n => {
    if (!byResource[n.org_resource]) byResource[n.org_resource] = [];
    byResource[n.org_resource].push(n);
  });

  let resourceNodes = Object.entries(byResource).map(([resource, nodes]) => ({
    id: resource, label: resource, shortLabel: _shortResource(resource), count: nodes.length,
    color: nodes[0].resourceColor, x: nodes.reduce((sum, n) => sum + n.x, 0) / nodes.length, y: resY, nodes,
  })).sort((a, b) => a.x - b.x);

  for (let j = 1; j < resourceNodes.length; j++) { if (resourceNodes[j].x - resourceNodes[j - 1].x < MIN_RESOURCE_SPACING) resourceNodes[j].x = resourceNodes[j - 1].x + MIN_RESOURCE_SPACING; }
  for (let j = resourceNodes.length - 2; j >= 0; j--) { resourceNodes[j].x = Math.min(resourceNodes[j].x, resourceNodes[j + 1].x - MIN_RESOURCE_SPACING); }
  resourceNodes = resourceNodes.map(n => ({ ...n, x: Math.max(TIMELINE_X0 + 10, Math.min(n.x, maxX)) }));

  const resourceLinks = resourceNodes.flatMap(node => node.nodes.map(n => ({ id: `res-${node.id}-${n.id}`, x1: node.x, y1: node.y + 10, x2: n.x, y2: midY - EVENT_R - 2, color: node.color })));
  return { resourceNodes, resourceLinks };
}

function _annotateBottlenecks(itemRows) {
  const edges = itemRows.flatMap(row => row.dfItemEdges).filter(e => Number.isFinite(e.gapHours));
  const threshold = _quantile(edges.map(e => e.gapHours), 0.75);
  itemRows.forEach(row => { row.dfItemEdges = row.dfItemEdges.map(e => ({ ...e, isBottleneck: Number.isFinite(threshold) && e.gapHours > threshold })); });
  return threshold;
}

function _summarizeFocusBlocks(blocks) {
  return blocks.reduce((s, block) => {
    s.totalItems += block.meta?.totalItems ?? 0;
    s.shownItems += block.itemRows.length;
    s.totalEvents += block.meta?.totalEvents ?? 0;
    s.filteredEvents += block.itemRows.reduce((sum, row) => sum + row.evCount, 0);
    s.syncItemCount += block.itemRows.filter(row => (row.syncEventCount ?? 0) > 0).length;
    s.syncEventCount += block.itemRows.reduce((sum, row) => sum + (row.syncEventCount ?? 0), 0);
    s.dfItemCount += block.displayedDfItemCount ?? block.itemRows.reduce((sum, row) => sum + row.dfItemEdges.length, 0);
    s.dfPoCount += block.dfPoEdges.length;
    return s;
  }, { totalItems: 0, shownItems: 0, totalEvents: 0, filteredEvents: 0, syncItemCount: 0, syncEventCount: 0, dfItemCount: 0, dfPoCount: 0 });
}

function _groupBy(items, getKey) {
  return (items ?? []).reduce((acc, item) => {
    const key = getKey(item);
    if (key === undefined || key === null || key === "") return acc;
    if (!acc[key]) acc[key] = [];
    acc[key].push(item);
    return acc;
  }, {});
}

function _compareEvents(a, b) {
  return (a?.date?.getTime?.() ?? 0) - (b?.date?.getTime?.() ?? 0) || String(a?.id ?? "").localeCompare(String(b?.id ?? ""));
}
function _compareEventIds(evById) { return (a, b) => _compareEvents(evById[a], evById[b]); }
function _hoursBetween(a, b) {
  if (!(a instanceof Date) || Number.isNaN(a.getTime()) || !(b instanceof Date) || Number.isNaN(b.getTime())) return 0;
  return Math.max((b.getTime() - a.getTime()) / HOUR_MS, 0);
}
function _quantile(values, q) {
  const sorted = [...(values ?? [])].filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return NaN;
  if (sorted.length === 1) return sorted[0];
  const idx = (sorted.length - 1) * q, lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] * (1 - (idx - lo)) + sorted[hi] * (idx - lo);
}
function _sameSequence(a, b) { return JSON.stringify(a ?? []) === JSON.stringify(b ?? []); }
function _fmt(d) { return d?.toLocaleDateString("en-GB", { day: "numeric", month: "short" }) ?? "?"; }
function _shortResource(r) { return r.length > 12 ? `${r.slice(0, 9)}...` : r; }
function _hasResourceValue(v) { if (!v) return false; const n = String(v).trim(); return n !== "" && n.toUpperCase() !== "NONE"; }
