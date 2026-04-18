"use strict";

const ACTIVITY_PALETTE = [
  "#2563eb", "#7c3aed", "#ea580c", "#059669", "#dc2626",
  "#0891b2", "#ca8a04", "#db2777", "#4f46e5", "#0f766e",
  "#9333ea", "#c2410c",
];
const RESOURCE_PALETTE = [
  "#0f766e", "#7c3aed", "#b45309", "#2563eb", "#be123c",
  "#0369a1", "#4d7c0f", "#9333ea", "#b91c1c", "#475569",
];
const PO_ATTR_KEYS = ["Vendor", "Company", "Document_Type", "Source"];
const ITEM_ATTR_KEYS = ["Item_Type", "Item_Category", "Goods_Receipt", "GR_Based_Inv_Verif"];
const OVERVIEW_KNN = 4;
const OVERVIEW_SIM_MIN = 0.34;
const OVERVIEW_LABEL_ACTIVITY_COUNT = 2;
const OVERVIEW_MAX_COMMON_SHARE = 0.8;

let _store = null;
const _overviewCache = new Map();

/**
 * Detect which entity types play the "case" (PO) and "item" (POItem) roles.
 * Prefers explicit PO/POItem names for backward compat; otherwise uses
 * entity count heuristic: fewer entities = case, more = item.
 */
function _detectEntityTypes(bundle) {
  const dfTypes = new Set(bundle.df.map(d => d.entity_type).filter(Boolean));
  if (dfTypes.has("PO") || dfTypes.has("POItem")) return { caseType: "PO", itemType: "POItem" };

  const countByType = {};
  bundle.entities.forEach(e => {
    if (e.entity_type) countByType[e.entity_type] = (countByType[e.entity_type] ?? 0) + 1;
  });

  // Use DF types if available, otherwise all entity types
  const candidates = dfTypes.size > 0 ? [...dfTypes] : Object.keys(countByType);
  const sorted = candidates
    .filter(t => countByType[t])
    .sort((a, b) => (countByType[a] ?? 0) - (countByType[b] ?? 0));

  return { caseType: sorted[0] ?? "case", itemType: sorted[1] ?? sorted[0] ?? "item" };
}

/**
 * Build the in-memory store from a JSON bundle (§3 schema).
 * Output shape is identical to the old CSV-based buildStore so that
 * layout.js and the overview modules work unchanged.
 */
export function buildStore(bundle) {
  const { caseType, itemType } = _detectEntityTypes(bundle);

  const entityTypeById = Object.fromEntries(
    bundle.entities.map(e => [e.entity_id, e.entity_type])
  );
  const entityPropsById = Object.fromEntries(
    bundle.entities.map(e => [e.entity_id, e.properties || {}])
  );

  // Flatten properties onto each event; add .date, .id alias
  const events = bundle.events.map(raw => {
    const e = {
      ...raw.properties,
      event_id: raw.event_id,
      id: raw.event_id,
      activity: raw.activity,
      timestamp: raw.timestamp,
      date: new Date(raw.timestamp),
      po_id: null,
      poitem_id: null,
    };
    return e;
  });

  const eventById = Object.fromEntries(events.map(e => [e.event_id, e]));
  const entityById = Object.fromEntries(
    bundle.entities.map(e => ({
      ...e.properties,
      entity_id: e.entity_id,
      entity_type: e.entity_type,
    })).map(e => [e.entity_id, e])
  );

  // Build event → case/item mappings from corr (generic: caseType plays PO role, itemType plays POItem role)
  const posByEvent = {};
  const itemsByEvent = {};
  bundle.corr.forEach(({ event_id, entity_id }) => {
    const et = entityTypeById[entity_id];
    if (et === caseType) {
      if (!posByEvent[event_id]) posByEvent[event_id] = [];
      posByEvent[event_id].push(entity_id);
    } else if (et === itemType) {
      if (!itemsByEvent[event_id]) itemsByEvent[event_id] = [];
      itemsByEvent[event_id].push(entity_id);
    }
  });

  events.forEach(e => {
    e.po_id = (posByEvent[e.event_id] || [])[0] || null;
    e.poitem_id = (itemsByEvent[e.event_id] || [])[0] || null;
  });

  // Build indexes
  const eventsByPo = {};
  const eventsByItem = {};
  const itemsByPo = {};

  events.forEach(e => {
    if (e.po_id) {
      if (!eventsByPo[e.po_id]) eventsByPo[e.po_id] = [];
      eventsByPo[e.po_id].push(e);
    }
    if (e.poitem_id) {
      if (!eventsByItem[e.poitem_id]) eventsByItem[e.poitem_id] = [];
      eventsByItem[e.poitem_id].push(e);
    }
    if (e.po_id && e.poitem_id) {
      if (!itemsByPo[e.po_id]) itemsByPo[e.po_id] = new Set();
      itemsByPo[e.po_id].add(e.poitem_id);
    }
  });

  // Handle events correlated to multiple items via the corr array
  bundle.corr.forEach(({ event_id, entity_id }) => {
    const et = entityTypeById[entity_id];
    if (et !== itemType) return;
    const e = eventById[event_id];
    if (!e) return;
    // If this entity_id is not the primary poitem_id, add the event to that item too
    if (e.poitem_id !== entity_id) {
      if (!eventsByItem[entity_id]) eventsByItem[entity_id] = [];
      // Store a contextual copy so poitem_id is correct for timeline rendering
      const copy = { ...e, poitem_id: entity_id };
      eventsByItem[entity_id].push(copy);
    }
    // Ensure itemsByPo is populated for this corr pair
    if (e.po_id) {
      if (!itemsByPo[e.po_id]) itemsByPo[e.po_id] = new Set();
      itemsByPo[e.po_id].add(entity_id);
    }
  });

  // DF indexes
  const dfItemByEntity = {};
  const dfPoByPo = {};
  bundle.df.forEach(d => {
    const { source_event_id, target_event_id, entity_id, entity_type } = d;
    const edge = {
      source: source_event_id,
      target: target_event_id,
      entityId: entity_id,
      entityType: entity_type,
    };
    if (entity_type === itemType) {
      if (!dfItemByEntity[entity_id]) dfItemByEntity[entity_id] = [];
      dfItemByEntity[entity_id].push(edge);
    } else if (entity_type === caseType) {
      if (!dfPoByPo[entity_id]) dfPoByPo[entity_id] = [];
      dfPoByPo[entity_id].push(edge);
    }
  });

  const allActivities = [...new Set(events.map(e => e.activity))].sort();
  const allResources = [...new Set(events.map(e => e.org_resource).filter(_isMeaningfulResource))].sort();
  const activityColorByName = _buildColorMap(allActivities, ACTIVITY_PALETTE);
  const resourceColorByName = _buildColorMap(allResources, RESOURCE_PALETTE, "#94a3b8");

  events.forEach(e => {
    e.activityColor = activityColorByName[e.activity] ?? "#64748b";
    e.resourceColor = _isMeaningfulResource(e.org_resource)
      ? (resourceColorByName[e.org_resource] ?? "#94a3b8")
      : "#cbd5e1";
  });

  const poList = Object.entries(eventsByPo)
    .map(([po, evs]) => ({
      id: po,
      eventCount: evs.length,
      itemCount: itemsByPo[po]?.size ?? 0,
    }))
    .sort((a, b) => b.itemCount - a.itemCount || b.eventCount - a.eventCount);

  const poSummaryById = _buildPoSummaries(poList, eventsByPo, itemsByPo);
  _applyOverviewFeatureSelection(poSummaryById);
  const poOverviewEdges = _buildOverviewRelations(poSummaryById);
  const { communities, communityByPoId } = _buildOverviewCommunities(poSummaryById, poOverviewEdges);

  _overviewCache.clear();
  _store = {
    bundle,
    events,
    eventById,
    entityById,
    entityTypeById,
    caseType,
    itemType,
    eventsByPo,
    eventsByItem,
    itemsByPo,
    dfItemByEntity,
    dfPoByPo,
    allActivities,
    allResources,
    activityColorByName,
    resourceColorByName,
    poList,
    poSummaryById,
    poOverviewEdges,
    communities,
    communityByPoId,
  };

  return _store;
}

export function getStore() {
  if (!_store) throw new Error("Store not built — call buildStore() first.");
  return _store;
}

export function getGraph(poId, filters = {}) {
  if (!_store) throw new Error("Store not built.");
  const { maxItems = 0, itemIds = null } = filters;
  const scopedItemSet = itemIds ? new Set(itemIds) : null;

  const allItems = [...(_store.itemsByPo[poId] ?? [])]
    .sort()
    .filter(item => !scopedItemSet || scopedItemSet.has(item));
  let items = [...allItems];
  if (!scopedItemSet && maxItems > 0) items = items.slice(0, maxItems);
  const itemSet = new Set(items);

  const allEvents = _filterEvents(_store.eventsByPo[poId] ?? [], filters)
    .filter(e => allItems.includes(e.poitem_id));
  const events = allEvents.filter(e => itemSet.has(e.poitem_id));

  const allEventIdSet = new Set(allEvents.map(e => e.event_id));
  const eventIdSet = new Set(events.map(e => e.event_id));

  const allDfItem = allItems.flatMap(item =>
    (_store.dfItemByEntity[item] ?? []).filter(
      edge => allEventIdSet.has(edge.source) && allEventIdSet.has(edge.target)
    )
  );
  const dfItem = items.flatMap(item =>
    (_store.dfItemByEntity[item] ?? []).filter(
      edge => eventIdSet.has(edge.source) && eventIdSet.has(edge.target)
    )
  );
  const allDfPo = (_store.dfPoByPo[poId] ?? []).filter(
    edge => allEventIdSet.has(edge.source) && allEventIdSet.has(edge.target)
  );
  const dfPo = (_store.dfPoByPo[poId] ?? []).filter(
    edge => eventIdSet.has(edge.source) && eventIdSet.has(edge.target)
  );

  const meta = {
    totalEvents: (_store.eventsByPo[poId] ?? []).filter(e => allItems.includes(e.poitem_id)).length,
    filteredEvents: events.length,
    filteredEventsAll: allEvents.length,
    totalItems: allItems.length,
    shownItems: items.length,
    dfItemCount: dfItem.length,
    dfItemCountAll: allDfItem.length,
    dfPoCount: dfPo.length,
    dfPoCountAll: allDfPo.length,
  };

  const poAttrs = _store.poSummaryById[poId]?.attrs ?? {};
  const itemAttrsById = Object.fromEntries(
    allItems.map(item => [item, _pickAttrs(_store.eventsByItem[item]?.[0], ITEM_ATTR_KEYS)])
  );

  return { po: poId, items, allItems, events, allEvents, dfItem, allDfItem, dfPo, allDfPo, meta, poAttrs, itemAttrsById };
}

export function getOverviewGraph(filters = {}) {
  if (!_store) throw new Error("Store not built.");
  const { communityId = null, minEdgeWeight = OVERVIEW_SIM_MIN, activities = null } = filters;

  // Recompute edges and communities when an activity filter is active (cached per filter key)
  let overviewEdges = _store.poOverviewEdges;
  let communityByPoId = _store.communityByPoId;
  if (activities !== null) {
    const cacheKey = [...activities].sort().join("\0");
    if (_overviewCache.has(cacheKey)) {
      ({ overviewEdges, communityByPoId } = _overviewCache.get(cacheKey));
    } else {
      const filteredSummaries = _buildFilteredSummaries(_store.poSummaryById, _store.eventsByPo, activities);
      overviewEdges = _buildOverviewRelations(filteredSummaries);
      ({ communityByPoId } = _buildOverviewCommunities(filteredSummaries, overviewEdges));
      _overviewCache.set(cacheKey, { overviewEdges, communityByPoId });
    }
  }

  const nodes = [];
  const visibleSet = new Set();

  _store.poList.forEach(po => {
    const summary = _store.poSummaryById[po.id];
    const community = communityByPoId[po.id] ?? { id: po.id, label: "Community", hint: "", weightedDegree: 0 };
    if (communityId && community.id !== communityId) return;
    const filteredEvents = _filterEvents(_store.eventsByPo[po.id] ?? [], filters);
    if (filteredEvents.length === 0) return;
    const filteredItems = new Set(filteredEvents.map(e => e.poitem_id)).size;
    nodes.push({
      id: summary.id, label: summary.id, attrs: summary.attrs,
      displayAttrs: summary.overviewDisplayAttrs, attrKeys: summary.overviewAttrKeys,
      resources: summary.overviewResources,
      clusterKey: community.id, clusterLabel: community.label,
      clusterCode: community.code, clusterHint: community.hint,
      firstDate: summary.firstDate, lastDate: summary.lastDate,
      totalEvents: summary.eventCount, filteredEvents: filteredEvents.length,
      totalItems: summary.itemCount, filteredItems,
      resourceCount: summary.overviewResourceCount,
      topResources: summary.overviewTopResources,
      topActivities: summary.topActivities,
      weightedDegree: community.weightedDegree ?? 0,
    });
    visibleSet.add(summary.id);
  });

  const edges = overviewEdges.filter(e =>
    e.weight >= minEdgeWeight && visibleSet.has(e.source) && visibleSet.has(e.target)
  );

  const degreeById = {};
  const weightedDegreeById = {};
  edges.forEach(edge => {
    degreeById[edge.source] = (degreeById[edge.source] ?? 0) + 1;
    degreeById[edge.target] = (degreeById[edge.target] ?? 0) + 1;
    weightedDegreeById[edge.source] = (weightedDegreeById[edge.source] ?? 0) + edge.weight;
    weightedDegreeById[edge.target] = (weightedDegreeById[edge.target] ?? 0) + edge.weight;
  });
  nodes.forEach(n => {
    n.degree = degreeById[n.id] ?? 0;
    n.weightedDegree = weightedDegreeById[n.id] ?? n.weightedDegree ?? 0;
  });

  const clusters = Object.values(nodes.reduce((acc, node) => {
    if (!acc[node.clusterKey]) {
      acc[node.clusterKey] = { id: node.clusterKey, label: node.clusterLabel, code: node.clusterCode,
        hint: node.clusterHint, nodeIds: [], resources: [], attributes: [] };
    }
    acc[node.clusterKey].nodeIds.push(node.id);
    return acc;
  }, {}));
  clusters.forEach(cluster => {
    const members = nodes.filter(n => n.clusterKey === cluster.id);
    cluster.count = cluster.nodeIds.length;
    cluster.resources = _aggregateCommunityResources(members);
    cluster.attributes = _aggregateCommunityAttrs(members);
  });
  clusters.sort((a, b) => b.nodeIds.length - a.nodeIds.length || a.label.localeCompare(b.label));
  const communityEdges = _buildCommunityEdges(edges, nodes);

  return {
    isOverviewNetwork: true,
    nodes, edges, communityEdges, clusters,
    meta: {
      poCount: nodes.length, totalPoCount: _store.poList.length,
      clusterCount: clusters.length,
      overviewEdgeCount: edges.length, overviewCommunityEdgeCount: communityEdges.length,
      filteredEvents: nodes.reduce((s, n) => s + n.filteredEvents, 0),
      totalEvents: nodes.reduce((s, n) => s + n.totalEvents, 0),
      shownItems: nodes.reduce((s, n) => s + n.filteredItems, 0),
      totalItems: nodes.reduce((s, n) => s + n.totalItems, 0),
      dfItemCount: 0, dfPoCount: 0, focusCommunityId: communityId,
    },
  };
}

export function getVariantOverview(filters = {}, maxVariants = 12) {
  if (!_store) throw new Error("Store not built.");
  const instances = _collectItemSequences(filters);
  const totalInstances = instances.length;
  const variantsByKey = new Map();

  instances.forEach(instance => {
    const key = JSON.stringify(instance.sequence);
    if (!variantsByKey.has(key)) variantsByKey.set(key, { sequence: [...instance.sequence], instanceIds: [] });
    variantsByKey.get(key).instanceIds.push(instance.entityId);
  });

  const variants = [...variantsByKey.entries()]
    .map(([key, v]) => ({ ...v, count: v.instanceIds.length, frequency: totalInstances > 0 ? v.instanceIds.length / totalInstances : 0, _key: key }))
    .sort((a, b) => b.count - a.count || b.sequence.length - a.sequence.length || a._key.localeCompare(b._key));

  const limit = maxVariants > 0 ? maxVariants : variants.length;
  const shownVariants = variants.slice(0, limit).map((v, i) => ({
    sequence: v.sequence, instanceIds: v.instanceIds,
    count: v.count, frequency: v.frequency, isdominant: i === 0,
  }));

  return { isVariantOverview: true, variants: shownVariants, totalInstances, variantCount: variants.length };
}

export function getActivityDfGraph(filters = {}) {
  if (!_store) throw new Error("Store not built.");
  const instances = _collectItemSequences(filters);
  const nodeCountByActivity = {}, nodeIndexSumByActivity = {}, nodePosCountByActivity = {};
  const edgeByKey = new Map();

  instances.forEach(instance => {
    instance.sequence.forEach((activity, index) => {
      nodeCountByActivity[activity] = (nodeCountByActivity[activity] ?? 0) + 1;
      nodeIndexSumByActivity[activity] = (nodeIndexSumByActivity[activity] ?? 0) + index;
      nodePosCountByActivity[activity] = (nodePosCountByActivity[activity] ?? 0) + 1;
    });
    for (let i = 0; i < instance.sequence.length - 1; i++) {
      const key = `${instance.sequence[i]}__${instance.sequence[i + 1]}`;
      if (!edgeByKey.has(key)) edgeByKey.set(key, { source: instance.sequence[i], target: instance.sequence[i + 1], count: 0 });
      edgeByKey.get(key).count += 1;
    }
  });

  const nodes = Object.entries(nodeCountByActivity)
    .map(([id, count]) => ({ id, label: id, count, avgIndex: (nodeIndexSumByActivity[id] ?? 0) / Math.max(nodePosCountByActivity[id] ?? 1, 1) }))
    .sort((a, b) => a.avgIndex - b.avgIndex || b.count - a.count || a.label.localeCompare(b.label));
  const edges = [...edgeByKey.values()].sort((a, b) => b.count - a.count || a.source.localeCompare(b.source));
  return { nodes, edges };
}

export function getResourcesForPo(poId) {
  if (!_store) return [];
  return [...new Set((_store.eventsByPo[poId] ?? []).map(e => e.org_resource).filter(_isMeaningfulResource))].sort();
}

export function getActivityCountsForPo(poId) {
  if (!_store) return {};
  return _countBy(_store.eventsByPo[poId] ?? [], e => e.activity);
}

// ── Internal helpers (same logic as old filters.js) ────────────────────────

function _filterEvents(events, filters = {}) {
  const { activities = null, resource = null, dateFrom = null, dateTo = null } = filters;
  let out = events;
  if (activities && activities.size > 0) out = out.filter(e => activities.has(e.activity));
  else if (activities && activities.size === 0) out = [];
  if (resource) out = out.filter(e => e.org_resource === resource);
  if (dateFrom) { const from = new Date(dateFrom); out = out.filter(e => e.date >= from); }
  if (dateTo) { const to = new Date(dateTo); out = out.filter(e => e.date <= to); }
  return out;
}

function _buildPoSummaries(poList, eventsByPo, itemsByPo) {
  const summaries = {};
  poList.forEach(po => {
    const events = [...(eventsByPo[po.id] ?? [])].sort((a, b) => a.date - b.date);
    const attrs = _pickAttrs(events[0], PO_ATTR_KEYS);
    const displayAttrs = _pickStableContextAttrs(events);
    const resources = [...new Set(events.map(e => e.org_resource).filter(_isMeaningfulResource))].sort();
    const activityCounts = _countBy(events, e => e.activity);
    const topActivities = Object.entries(activityCounts)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3)
      .map(([activity, count]) => ({ activity, count }));
    summaries[po.id] = {
      id: po.id, attrs, displayAttrs, attrKeys: Object.keys(displayAttrs),
      itemCount: itemsByPo[po.id]?.size ?? 0, eventCount: events.length,
      firstDate: events[0]?.date ?? null, lastDate: events.at(-1)?.date ?? null,
      centerTime: _caseCenterTime(events[0]?.date ?? null, events.at(-1)?.date ?? null),
      resources, resourceCount: resources.length, topResources: resources.slice(0, 3),
      activityCounts, topActivities,
      contextTokens: Object.entries(displayAttrs).map(([k, v]) => `${k}:${v}`),
      overviewDisplayAttrs: displayAttrs, overviewAttrKeys: Object.keys(displayAttrs),
      overviewResources: resources, overviewResourceCount: resources.length,
      overviewTopResources: resources.slice(0, 3),
      overviewContextTokens: Object.entries(displayAttrs).map(([k, v]) => `${k}:${v}`),
    };
  });
  return summaries;
}

function _applyOverviewFeatureSelection(poSummaryById) {
  const summaries = Object.values(poSummaryById ?? {});
  const caseCount = summaries.length;
  if (!caseCount) return;
  const resourceCaseFreq = _countDocumentFrequency(summaries.map(s => s.resources));
  const contextCaseFreq = _countDocumentFrequency(summaries.map(s => s.contextTokens));
  summaries.forEach(summary => {
    const overviewResources = summary.resources.filter(r => _isInformativeOverviewValue(r, resourceCaseFreq[r] ?? 0, caseCount));
    const overviewContextTokens = summary.contextTokens.filter(t => _isInformativeOverviewToken(t, contextCaseFreq[t] ?? 0, caseCount));
    const overviewDisplayAttrs = Object.fromEntries(
      Object.entries(summary.displayAttrs ?? {}).filter(([k, v]) => overviewContextTokens.includes(`${k}:${v}`))
    );
    summary.overviewResources = overviewResources;
    summary.overviewResourceCount = overviewResources.length;
    summary.overviewTopResources = overviewResources.slice(0, 3);
    summary.overviewContextTokens = overviewContextTokens;
    summary.overviewDisplayAttrs = overviewDisplayAttrs;
    summary.overviewAttrKeys = Object.keys(overviewDisplayAttrs);
  });
}

function _buildOverviewRelations(poSummaryById) {
  const summaries = Object.values(poSummaryById).sort((a, b) => a.id.localeCompare(b.id));
  const datasetStart = Math.min(...summaries.map(s => s.firstDate?.getTime() ?? Infinity));
  const datasetEnd = Math.max(...summaries.map(s => s.lastDate?.getTime() ?? -Infinity));
  const timelineSpan = Number.isFinite(datasetStart) && Number.isFinite(datasetEnd) ? Math.max(datasetEnd - datasetStart, 1) : 1;
  const candidates = [];

  for (let i = 0; i < summaries.length; i++) {
    for (let j = i + 1; j < summaries.length; j++) {
      const edge = _scoreOverviewPair(summaries[i], summaries[j], timelineSpan);
      if (edge && edge.weight >= OVERVIEW_SIM_MIN) candidates.push(edge);
    }
  }

  const rankedByNode = {};
  candidates.forEach(edge => {
    if (!rankedByNode[edge.source]) rankedByNode[edge.source] = [];
    if (!rankedByNode[edge.target]) rankedByNode[edge.target] = [];
    rankedByNode[edge.source].push(edge);
    rankedByNode[edge.target].push(edge);
  });
  Object.values(rankedByNode).forEach(edges => {
    edges.sort((a, b) => b.weight - a.weight || a.source.localeCompare(b.source) || a.target.localeCompare(b.target));
  });

  return candidates
    .filter(edge => {
      const topS = (rankedByNode[edge.source] ?? []).slice(0, OVERVIEW_KNN);
      const topT = (rankedByNode[edge.target] ?? []).slice(0, OVERVIEW_KNN);
      return topS.includes(edge) || topT.includes(edge);
    })
    .sort((a, b) => b.weight - a.weight || a.source.localeCompare(b.source) || a.target.localeCompare(b.target));
}

function _buildOverviewCommunities(poSummaryById, edges) {
  const summaries = Object.values(poSummaryById);
  const adjacency = {};
  const weightedDegreeById = Object.fromEntries(summaries.map(s => [s.id, 0]));
  edges.forEach(edge => {
    if (!adjacency[edge.source]) adjacency[edge.source] = [];
    if (!adjacency[edge.target]) adjacency[edge.target] = [];
    adjacency[edge.source].push({ id: edge.target, weight: edge.weight });
    adjacency[edge.target].push({ id: edge.source, weight: edge.weight });
    weightedDegreeById[edge.source] += edge.weight;
    weightedDegreeById[edge.target] += edge.weight;
  });

  const labels = Object.fromEntries(summaries.map(s => [s.id, s.id]));
  const order = [...summaries].sort((a, b) => (weightedDegreeById[b.id] ?? 0) - (weightedDegreeById[a.id] ?? 0) || a.id.localeCompare(b.id));

  for (let iter = 0; iter < 16; iter++) {
    let changed = false;
    order.forEach(s => {
      const neighbors = adjacency[s.id] ?? [];
      if (!neighbors.length) return;
      const scores = {};
      neighbors.forEach(n => { scores[labels[n.id]] = (scores[labels[n.id]] ?? 0) + n.weight; });
      const best = Object.entries(scores).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
      if (best && best !== labels[s.id]) { labels[s.id] = best; changed = true; }
    });
    if (!changed) break;
  }

  const groups = Object.values(summaries.reduce((acc, s) => {
    const label = labels[s.id];
    if (!acc[label]) acc[label] = { sourceLabel: label, nodeIds: [] };
    acc[label].nodeIds.push(s.id);
    return acc;
  }, {})).sort((a, b) => b.nodeIds.length - a.nodeIds.length || a.sourceLabel.localeCompare(b.sourceLabel));

  const communities = groups.map((group, index) => {
    const members = group.nodeIds.map(id => poSummaryById[id]).filter(Boolean);
    const activityTotals = {};
    members.forEach(m => { Object.entries(m.activityCounts).forEach(([a, c]) => { activityTotals[a] = (activityTotals[a] ?? 0) + c; }); });
    const hint = Object.entries(activityTotals).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, OVERVIEW_LABEL_ACTIVITY_COUNT).map(([a]) => a).join(" / ");
    const code = `Community ${String(index + 1).padStart(2, "0")}`;
    return { id: `community-${String(index + 1).padStart(2, "0")}`, code, label: hint || code, hint: hint ? code : "", nodeIds: group.nodeIds };
  });

  // Disambiguate duplicate labels with letter suffixes (A, B, C…)
  const labelFreq = {};
  communities.forEach(c => { labelFreq[c.label] = (labelFreq[c.label] ?? 0) + 1; });
  const labelSeq = {};
  communities.forEach(c => {
    if ((labelFreq[c.label] ?? 1) > 1) {
      labelSeq[c.label] = (labelSeq[c.label] ?? 0) + 1;
      c.label = `${c.label} ${String.fromCharCode(64 + labelSeq[c.label])}`;
    }
  });

  const communityByPoId = {};
  communities.forEach(community => {
    community.nodeIds.forEach(id => { communityByPoId[id] = { ...community, weightedDegree: weightedDegreeById[id] ?? 0 }; });
  });

  return { communities, communityByPoId };
}

function _buildFilteredSummaries(poSummaryById, eventsByPo, activities) {
  const filtered = {};
  Object.entries(poSummaryById).forEach(([id, summary]) => {
    const evs = (eventsByPo[id] ?? []).filter(e => activities.has(e.activity));
    filtered[id] = { ...summary, activityCounts: _countBy(evs, e => e.activity) };
  });
  return filtered;
}

function _scoreOverviewPair(a, b, timelineSpan) {
  const actSim = _cosineSimilarity(a.activityCounts, b.activityCounts);
  const resSim = _jaccardSimilarity(a.overviewResources, b.overviewResources);
  const ctxSim = _jaccardSimilarity(a.overviewContextTokens, b.overviewContextTokens);
  const timeSim = _temporalSimilarity(a.centerTime, b.centerTime, timelineSpan);
  const sizeSim = _sizeSimilarity(a, b);
  const weight = actSim * 0.48 + resSim * 0.18 + ctxSim * 0.18 + timeSim * 0.10 + sizeSim * 0.06;
  if (weight <= 0) return null;
  const reasons = [];
  if (actSim >= 0.25) reasons.push(`activity profile ${Math.round(actSim * 100)}% aligned`);
  if (resSim >= 0.2) reasons.push(_sharedValueReason("shared resources", a.overviewResources, b.overviewResources));
  if (ctxSim >= 0.2) reasons.push(_sharedValueReason("shared context", a.overviewContextTokens, b.overviewContextTokens, t => t.replace(":", " = ")));
  if (timeSim >= 0.55) reasons.push("close in time");
  if (sizeSim >= 0.75) reasons.push("similar case size");
  return { id: `${a.id}__${b.id}`, source: a.id, target: b.id, weight, reasons: reasons.slice(0, 3), components: { actSim, resSim, ctxSim, timeSim, sizeSim } };
}

function _collectItemSequences(filters = {}) {
  const scopedItemIds = filters.itemIds ? new Set(filters.itemIds) : null;
  const itemIds = [...new Set([...Object.keys(_store.eventsByItem ?? {}), ...Object.keys(_store.dfItemByEntity ?? {})])]
    .filter(id => !scopedItemIds || scopedItemIds.has(id)).sort();
  return itemIds.map(entityId => {
    const events = [...(_store.eventsByItem[entityId] ?? [])].sort(_compareEvents);
    if (!events.length) return null;
    const evById = Object.fromEntries(events.map(e => [e.event_id, e]));
    const edges = (_store.dfItemByEntity[entityId] ?? []).filter(edge => evById[edge.source] && evById[edge.target]);
    const traced = _traceEntityPath(events, edges, evById);
    const sequence = traced.eventIds.map(id => evById[id]?.activity).filter(Boolean);
    if (!_sequencePassesActivityFilter(sequence, filters.activities)) return null;
    return { entityId, poId: events[0]?.po_id ?? null, sequence, eventIds: traced.eventIds };
  }).filter(entry => entry && entry.sequence.length > 0);
}

function _traceEntityPath(events, edges, evById) {
  const predecessorIds = {}, successorIds = {};
  const nodeIds = new Set(events.map(e => e.event_id ?? e.id));
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
  return { eventIds: orderedEventIds };
}

function _sequencePassesActivityFilter(sequence, activities) {
  if (!activities) return true;
  return (sequence ?? []).every(a => activities.has(a));
}

function _compareEvents(a, b) {
  return (a?.date?.getTime?.() ?? 0) - (b?.date?.getTime?.() ?? 0) || String(a?.event_id ?? a?.id ?? "").localeCompare(String(b?.event_id ?? b?.id ?? ""));
}
function _compareEventIds(evById) { return (a, b) => _compareEvents(evById[a], evById[b]); }

function _pickAttrs(obj, keys) {
  if (!obj) return {};
  return Object.fromEntries(keys.filter(k => obj[k] !== undefined && obj[k] !== null && obj[k] !== "").map(k => [k, obj[k]]));
}

function _pickStableContextAttrs(events) {
  if (!events?.length) return {};
  const keys = Object.keys(events[0]).filter(_isStableContextKey);
  const stable = [];
  keys.forEach(key => {
    const vals = [...new Set(events.map(e => e[key]).filter(v => v !== undefined && v !== null && v !== ""))];
    if (vals.length === 1) stable.push([key, vals[0]]);
  });
  stable.sort((a, b) => String(a[1]).length - String(b[1]).length || a[0].localeCompare(b[0]));
  return Object.fromEntries(stable);
}

function _isStableContextKey(key) {
  if (!key) return false;
  const n = key.toLowerCase();
  return !["activity", "timestamp", "date", "org_resource", "resourcecolor", "activitycolor",
           "lifecycle_transition", "po_id", "poitem_id", "event_id", "id"].includes(n) && !n.endsWith("_id");
}

function _isMeaningfulResource(value) {
  if (value === undefined || value === null) return false;
  const n = String(value).trim();
  return n !== "" && n.toUpperCase() !== "NONE";
}

function _isInformativeOverviewToken(token, freq, caseCount) {
  const [, rawValue = token] = String(token ?? "").split(/:(.+)/, 2);
  return _isInformativeOverviewValue(rawValue, freq, caseCount);
}
function _isInformativeOverviewValue(value, freq, caseCount) {
  if (!_isMeaningfulOverviewValue(value)) return false;
  return caseCount > 0 ? freq / caseCount < OVERVIEW_MAX_COMMON_SHARE : false;
}
function _isMeaningfulOverviewValue(value) {
  if (value === undefined || value === null) return false;
  const n = String(value).trim();
  if (!n) return false;
  const lower = n.toLowerCase();
  if (["none", "unknown", "n/a", "na", "null"].includes(lower)) return false;
  if (/^[a-z][a-z0-9]*_0+$/i.test(n) || /^[a-z][a-z0-9]*id_0+$/i.test(n) || /^0+$/.test(n)) return false;
  return true;
}

function _countDocumentFrequency(valueLists) {
  const counts = {};
  (valueLists ?? []).forEach(vals => { [...new Set(vals ?? [])].forEach(v => { counts[v] = (counts[v] ?? 0) + 1; }); });
  return counts;
}
function _countBy(items, getKey) {
  return items.reduce((acc, item) => { const k = getKey(item); if (!k) return acc; acc[k] = (acc[k] ?? 0) + 1; return acc; }, {});
}
function _caseCenterTime(first, last) {
  if (!first && !last) return null;
  if (!first) return last.getTime();
  if (!last) return first.getTime();
  return (first.getTime() + last.getTime()) / 2;
}
function _cosineSimilarity(aCounts, bCounts) {
  const keys = new Set([...Object.keys(aCounts ?? {}), ...Object.keys(bCounts ?? {})]);
  if (!keys.size) return 0;
  let dot = 0, magA = 0, magB = 0;
  keys.forEach(k => { const a = aCounts?.[k] ?? 0, b = bCounts?.[k] ?? 0; dot += a * b; magA += a * a; magB += b * b; });
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}
function _jaccardSimilarity(aVals, bVals) {
  const a = new Set(aVals ?? []), b = new Set(bVals ?? []);
  if (!a.size && !b.size) return 0;
  let inter = 0;
  a.forEach(v => { if (b.has(v)) inter++; });
  return inter / new Set([...a, ...b]).size;
}
function _temporalSimilarity(aCenter, bCenter, span) {
  if (!Number.isFinite(aCenter) || !Number.isFinite(bCenter)) return 0;
  return Math.max(0, 1 - (Math.abs(aCenter - bCenter) / Math.max(span, 1)));
}
function _sizeSimilarity(a, b) {
  return _ratioSimilarity(a.eventCount, b.eventCount) * 0.7 + _ratioSimilarity(a.itemCount, b.itemCount) * 0.3;
}
function _ratioSimilarity(a, b) {
  if (!a && !b) return 1;
  return 1 - (Math.abs((a ?? 0) - (b ?? 0)) / Math.max(a ?? 0, b ?? 0, 1));
}
function _sharedValueReason(label, aVals, bVals, fmt = v => v) {
  const bSet = new Set(bVals ?? []);
  const shared = [...new Set(aVals ?? [])].filter(v => bSet.has(v));
  if (!shared.length) return label;
  const preview = shared.slice(0, 2).map(fmt).join(", ");
  return shared.length > 2 ? `${label}: ${preview}, ...` : `${label}: ${preview}`;
}
function _aggregateCommunityResources(nodes) {
  const counts = {};
  nodes.forEach(n => { (n.resources ?? []).forEach(r => { counts[r] = (counts[r] ?? 0) + 1; }); });
  return Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([r, count]) => ({ id: `resource:${r}`, type: "resource", label: r, shortLabel: _shortToken(r, 12), count }));
}
function _aggregateCommunityAttrs(nodes) {
  const counts = {};
  nodes.forEach(n => {
    Object.entries(n.displayAttrs ?? {}).forEach(([k, v]) => {
      const token = `${k}:${v}`;
      if (!counts[token]) counts[token] = { id: `attr:${token}`, type: "attribute", key: k, value: v, label: `${_labelizeKey(k)}=${v}`, shortLabel: `${_labelizeKey(k)}=${_shortToken(v, 14)}`, count: 0 };
      counts[token].count += 1;
    });
  });
  return Object.values(counts).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}
function _buildCommunityEdges(edges, nodes) {
  const communityByNode = Object.fromEntries(nodes.map(n => [n.id, n.clusterKey]));
  const map = new Map();
  edges.forEach(edge => {
    const sc = communityByNode[edge.source], tc = communityByNode[edge.target];
    if (!sc || !tc || sc === tc) return;
    const [src, tgt] = sc < tc ? [sc, tc] : [tc, sc];
    const key = `${src}__${tgt}`;
    if (!map.has(key)) map.set(key, { id: key, source: src, target: tgt, weight: 0, count: 0 });
    const agg = map.get(key); agg.weight += edge.weight; agg.count += 1;
  });
  return [...map.values()].sort((a, b) => b.weight - a.weight || a.source.localeCompare(b.source));
}
function _buildColorMap(values, palette, fallback = null) {
  const map = {};
  values.forEach((v, i) => { map[v] = palette[i] ?? fallback ?? _hashColor(v); });
  return map;
}
function _hashColor(value) {
  let hash = 0;
  const text = String(value ?? "");
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) - hash) + text.charCodeAt(i);
  return `hsl(${Math.abs(hash) % 360} 62% 46%)`;
}
function _labelizeKey(key) { return String(key ?? "").replaceAll("_", " "); }
function _shortToken(value, maxChars = 14) {
  const text = String(value ?? "");
  return text.length > maxChars ? `${text.slice(0, maxChars - 3)}...` : text;
}
