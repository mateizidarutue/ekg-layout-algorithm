"use strict";

import { buildEntityTypeRegistry } from "./entityTypes.js";

const ACTIVITY_PALETTE = [
  "#2563eb", "#7c3aed", "#ea580c", "#059669", "#dc2626",
  "#0891b2", "#ca8a04", "#db2777", "#4f46e5", "#0f766e",
  "#9333ea", "#c2410c",
];
const RESOURCE_PALETTE = [
  "#0f766e", "#7c3aed", "#b45309", "#2563eb", "#be123c",
  "#0369a1", "#4d7c0f", "#9333ea", "#b91c1c", "#475569",
];
const OVERVIEW_KNN = 4;
const OVERVIEW_SIM_MIN = 0.34;
const OVERVIEW_LABEL_ACTIVITY_COUNT = 2;
const OVERVIEW_MAX_COMMON_SHARE = 0.8;
const GENERIC_LABELS = new Set(["Entity", "Resource", "EntityAttribute"]);

let _store = null;
const _overviewCache = new Map();

function _inferPrimaryType(labels, fallback = "Entity") {
  const typed = [...new Set((labels ?? []).filter(Boolean))];
  const specific = typed.filter(label => !GENERIC_LABELS.has(label)).sort((a, b) => a.localeCompare(b));
  if (specific.length) return specific[0];
  const generic = typed.filter(label => label !== "Entity").sort((a, b) => a.localeCompare(b));
  if (generic.length) return generic[0];
  return fallback;
}

function _normalizeEntity(raw) {
  const labels = [...new Set(raw.labels ?? [raw.primary_type ?? raw.entity_type].filter(Boolean))]
    .filter(Boolean);
  const primaryType = raw.primary_type || _inferPrimaryType(labels, raw.entity_type || "Entity");
  return {
    ...raw.properties,
    entity_id: String(raw.entity_id),
    id: String(raw.entity_id),
    entity_type: primaryType,
    primary_type: primaryType,
    labels,
    properties: raw.properties || {},
  };
}

function _normalizeEvent(raw) {
  const props = raw.properties || {};
  return {
    ...props,
    event_id: String(raw.event_id),
    id: String(raw.event_id),
    activity: raw.activity ?? "",
    timestamp: raw.timestamp ?? "",
    date: new Date(raw.timestamp),
    properties: props,
    memberships: [],
    entity_ids: [],
    entity_ids_by_type: {},
    resource_entity_ids: [],
    resource_labels: [],
    primary_resource_label: null,
    case_entity_id: null,
    item_entity_id: null,
  };
}

function _normalizeRelation(raw, entityById) {
  const sourceId = String(raw.source_entity_id);
  const targetId = String(raw.target_entity_id);
  return {
    source_entity_id: sourceId,
    target_entity_id: targetId,
    source_entity_type: raw.source_entity_type || entityById[sourceId]?.primary_type || "Entity",
    target_entity_type: raw.target_entity_type || entityById[targetId]?.primary_type || "Entity",
    relation_type: String(raw.relation_type || ""),
    properties: raw.properties || {},
    id: `${sourceId}__${raw.relation_type || ""}__${targetId}`,
  };
}

function _normalizeCorr(raw, entityById) {
  const entityId = String(raw.entity_id);
  const entity = entityById[entityId];
  return {
    event_id: String(raw.event_id),
    entity_id: entityId,
    relation_type: String(raw.relation_type || "CORR"),
    entity_type: entity?.primary_type ?? entity?.entity_type ?? "",
  };
}

function _resolveDfEntityId(raw, corrByEventId, entityById) {
  const explicit = String(raw.entity_id || "").trim();
  if (explicit) return explicit;
  const sourceIds = new Set((corrByEventId[raw.source_event_id] ?? []).map(edge => edge.entity_id));
  const targetIds = new Set((corrByEventId[raw.target_event_id] ?? []).map(edge => edge.entity_id));
  const candidates = [...sourceIds]
    .filter(id => targetIds.has(id))
    .filter(id => !raw.entity_type || entityById[id]?.primary_type === raw.entity_type);
  return candidates[0] ?? "";
}

function _normalizeDf(raw, corrByEventId, entityById) {
  const entityId = _resolveDfEntityId(raw, corrByEventId, entityById);
  return {
    source_event_id: String(raw.source_event_id),
    target_event_id: String(raw.target_event_id),
    source: String(raw.source_event_id),
    target: String(raw.target_event_id),
    entity_id: entityId,
    entityId: entityId,
    entity_type: raw.entity_type || entityById[entityId]?.primary_type || "",
    entityType: raw.entity_type || entityById[entityId]?.primary_type || "",
  };
}

function _buildContextMaps(events, corr, entities) {
  const eventById = Object.fromEntries(events.map(event => [event.event_id, event]));
  const entityById = Object.fromEntries(entities.map(entity => [entity.entity_id, entity]));
  const corrByEventId = {};
  const corrByEntityId = {};
  const eventsByEntityId = {};

  corr.forEach(edge => {
    const event = eventById[edge.event_id];
    const entity = entityById[edge.entity_id];
    if (!event || !entity) return;

    if (!corrByEventId[event.event_id]) corrByEventId[event.event_id] = [];
    if (!corrByEntityId[entity.entity_id]) corrByEntityId[entity.entity_id] = [];
    if (!eventsByEntityId[entity.entity_id]) eventsByEntityId[entity.entity_id] = [];

    corrByEventId[event.event_id].push(edge);
    corrByEntityId[entity.entity_id].push(edge);
    eventsByEntityId[entity.entity_id].push(event);

    if (!event.entity_ids.includes(entity.entity_id)) event.entity_ids.push(entity.entity_id);
    if (!event.entity_ids_by_type[entity.primary_type]) event.entity_ids_by_type[entity.primary_type] = [];
    if (!event.entity_ids_by_type[entity.primary_type].includes(entity.entity_id)) {
      event.entity_ids_by_type[entity.primary_type].push(entity.entity_id);
    }
    event.memberships.push({
      entity_id: entity.entity_id,
      entity_type: entity.primary_type,
      relation_type: edge.relation_type,
      entity_label: _entityLabel(entity),
    });
  });

  Object.values(eventsByEntityId).forEach(list => list.sort(_compareEvents));
  Object.values(corrByEventId).forEach(list => list.sort((a, b) => a.entity_id.localeCompare(b.entity_id)));
  events.forEach(event => {
    Object.keys(event.entity_ids_by_type).forEach(type => {
      event.entity_ids_by_type[type].sort((a, b) => a.localeCompare(b));
    });
  });

  return { eventById, entityById, corrByEventId, corrByEntityId, eventsByEntityId };
}

function _buildRelationsByEntity(relations) {
  return relations.reduce((acc, relation) => {
    if (!acc[relation.source_entity_id]) acc[relation.source_entity_id] = [];
    if (!acc[relation.target_entity_id]) acc[relation.target_entity_id] = [];
    acc[relation.source_entity_id].push(relation);
    acc[relation.target_entity_id].push(relation);
    return acc;
  }, {});
}

function _buildDfByEntity(df) {
  return df.reduce((acc, edge) => {
    if (!edge.entity_id) return acc;
    if (!acc[edge.entity_id]) acc[edge.entity_id] = [];
    acc[edge.entity_id].push(edge);
    return acc;
  }, {});
}

function _isResourceEntity(entity) {
  if (!entity) return false;
  return entity.labels.includes("Resource") || /resource/i.test(entity.primary_type || "");
}

function _populateEventResourceContext(events, entityById) {
  events.forEach(event => {
    const resourceEntities = event.memberships
      .map(membership => entityById[membership.entity_id])
      .filter(_isResourceEntity);
    const resourceLabels = new Set();
    resourceEntities.forEach(entity => {
      resourceLabels.add(_entityLabel(entity));
    });
    if (_isMeaningfulResource(event.org_resource)) resourceLabels.add(String(event.org_resource));

    event.resource_entity_ids = [...new Set(resourceEntities.map(entity => entity.entity_id))];
    event.resource_labels = [...resourceLabels].sort((a, b) => a.localeCompare(b));
    event.primary_resource_label = event.resource_labels[0] ?? null;
  });
}

function _buildEntityIdsByType(entities) {
  return entities.reduce((acc, entity) => {
    if (!acc[entity.primary_type]) acc[entity.primary_type] = [];
    acc[entity.primary_type].push(entity.entity_id);
    return acc;
  }, {});
}

function _detectCaseItemLens(store) {
  const relationCandidates = (store.relations ?? []).filter(edge => edge.relation_type === "HAS_ITEM");
  if (relationCandidates.length) {
    const pair = relationCandidates[0];
    return {
      caseType: pair.source_entity_type,
      itemType: pair.target_entity_type,
    };
  }

  const dfTypes = [...new Set((store.df ?? []).map(edge => edge.entity_type).filter(Boolean))];
  if (dfTypes.includes("PO") || dfTypes.includes("POItem")) return { caseType: "PO", itemType: "POItem" };

  const counts = Object.fromEntries(
    Object.entries(store.entityIdsByType).map(([type, ids]) => [type, ids.length])
  );
  const candidates = (dfTypes.length ? dfTypes : Object.keys(counts))
    .filter(type => counts[type])
    .sort((a, b) => counts[a] - counts[b] || a.localeCompare(b));

  return {
    caseType: candidates[0] ?? "Case",
    itemType: candidates[1] ?? candidates[0] ?? "Item",
  };
}

function _buildCaseLens(store) {
  const { caseType, itemType } = _detectCaseItemLens(store);
  const caseIdByEventId = {};
  const itemIdByEventId = {};
  const eventsByCaseId = {};
  const eventsByItemId = {};
  const itemIdsByCaseId = {};

  store.events.forEach(event => {
    const caseId = event.entity_ids_by_type[caseType]?.[0] ?? null;
    const itemId = event.entity_ids_by_type[itemType]?.[0] ?? null;
    event.case_entity_id = caseId;
    event.item_entity_id = itemId;
    caseIdByEventId[event.event_id] = caseId;
    itemIdByEventId[event.event_id] = itemId;

    if (caseId) {
      if (!eventsByCaseId[caseId]) eventsByCaseId[caseId] = [];
      eventsByCaseId[caseId].push(event);
    }
    if (itemId) {
      if (!eventsByItemId[itemId]) eventsByItemId[itemId] = [];
      eventsByItemId[itemId].push(event);
    }
    if (caseId && itemId) {
      if (!itemIdsByCaseId[caseId]) itemIdsByCaseId[caseId] = new Set();
      itemIdsByCaseId[caseId].add(itemId);
    }
  });

  store.corr.forEach(edge => {
    if (edge.entity_type !== itemType) return;
    const event = store.eventById[edge.event_id];
    if (!event || !event.case_entity_id) return;
    if (!eventsByItemId[edge.entity_id]) eventsByItemId[edge.entity_id] = [];
    if (!eventsByItemId[edge.entity_id].includes(event)) eventsByItemId[edge.entity_id].push(event);
    if (!itemIdsByCaseId[event.case_entity_id]) itemIdsByCaseId[event.case_entity_id] = new Set();
    itemIdsByCaseId[event.case_entity_id].add(edge.entity_id);
  });

  Object.values(eventsByCaseId).forEach(events => events.sort(_compareEvents));
  Object.values(eventsByItemId).forEach(events => events.sort(_compareEvents));

  return { caseType, itemType, caseIdByEventId, itemIdByEventId, eventsByCaseId, eventsByItemId, itemIdsByCaseId };
}

export function buildStore(bundle) {
  const entities = (bundle.entities ?? []).map(_normalizeEntity);
  const events = (bundle.events ?? []).map(_normalizeEvent);
  const entityIdsByType = _buildEntityIdsByType(entities);
  const { eventById, entityById } = {
    eventById: Object.fromEntries(events.map(event => [event.event_id, event])),
    entityById: Object.fromEntries(entities.map(entity => [entity.entity_id, entity])),
  };

  const corr = (bundle.corr ?? [])
    .map(raw => _normalizeCorr(raw, entityById))
    .filter(edge => eventById[edge.event_id] && entityById[edge.entity_id]);
  const maps = _buildContextMaps(events, corr, entities);
  const relations = (bundle.relations ?? [])
    .map(raw => _normalizeRelation(raw, maps.entityById))
    .filter(edge => maps.entityById[edge.source_entity_id] && maps.entityById[edge.target_entity_id]);
  const relationsByEntityId = _buildRelationsByEntity(relations);
  const df = (bundle.df ?? [])
    .map(raw => _normalizeDf(raw, maps.corrByEventId, maps.entityById))
    .filter(edge => edge.entity_id && maps.eventById[edge.source] && maps.eventById[edge.target] && maps.entityById[edge.entity_id]);
  const dfByEntityId = _buildDfByEntity(df);

  events.forEach(event => {
    event.memberships = [...event.memberships].sort((a, b) =>
      a.entity_type.localeCompare(b.entity_type) || a.entity_id.localeCompare(b.entity_id)
    );
    event.entity_ids = [...new Set(event.entity_ids)].sort((a, b) => a.localeCompare(b));
  });
  _populateEventResourceContext(events, maps.entityById);

  const caseLens = _buildCaseLens({
    events,
    corr,
    eventById: maps.eventById,
    entityById: maps.entityById,
    relations,
    df,
    entityIdsByType,
  });

  const allActivities = [...new Set(events.map(event => event.activity).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const allResources = [...new Set(events.flatMap(event => event.resource_labels ?? []).filter(_isMeaningfulResource))]
    .sort((a, b) => a.localeCompare(b));
  const activityColorByName = _buildColorMap(allActivities, ACTIVITY_PALETTE);
  const resourceColorByName = _buildColorMap(allResources, RESOURCE_PALETTE, "#94a3b8");
  const activityEventCount = {};
  allActivities.forEach(a => { activityEventCount[a] = 0; });
  events.forEach(event => { if (event.activity in activityEventCount) activityEventCount[event.activity]++; });

  events.forEach(event => {
    event.activityColor = activityColorByName[event.activity] ?? "#64748b";
    event.resourceColor = event.primary_resource_label
      ? (resourceColorByName[event.primary_resource_label] ?? "#94a3b8")
      : "#cbd5e1";
  });

  const caseList = Object.entries(caseLens.eventsByCaseId)
    .map(([caseId, caseEvents]) => ({
      id: caseId,
      eventCount: caseEvents.length,
      itemCount: caseLens.itemIdsByCaseId[caseId]?.size ?? 0,
      entityType: caseLens.caseType,
    }))
    .sort((a, b) => b.itemCount - a.itemCount || b.eventCount - a.eventCount || a.id.localeCompare(b.id));

  const caseSummaryById = _buildCaseSummaries(caseList, caseLens.eventsByCaseId, caseLens.itemIdsByCaseId);
  _applyOverviewFeatureSelection(caseSummaryById);
  const caseOverviewEdges = _buildOverviewRelations(caseSummaryById);
  const { communities, communityByCaseId } = _buildOverviewCommunities(caseSummaryById, caseOverviewEdges);

  const invalidEventCount = events.filter(e => !_hasValidDate(e)).length;

  _overviewCache.clear();
  _store = {
    bundle,
    invalidEventCount,
    entities,
    entityById: maps.entityById,
    entityIdsByType,
    events,
    eventById: maps.eventById,
    corr,
    corrByEventId: maps.corrByEventId,
    corrByEntityId: maps.corrByEntityId,
    eventsByEntityId: maps.eventsByEntityId,
    relations,
    relationsByEntityId,
    df,
    dfByEntityId,
    caseType: caseLens.caseType,
    itemType: caseLens.itemType,
    caseIdByEventId: caseLens.caseIdByEventId,
    itemIdByEventId: caseLens.itemIdByEventId,
    eventsByCaseId: caseLens.eventsByCaseId,
    eventsByItemId: caseLens.eventsByItemId,
    itemIdsByCaseId: caseLens.itemIdsByCaseId,
    allActivities,
    allResources,
    activityColorByName,
    activityEventCount,
    resourceColorByName,
    caseList,
    caseSummaryById,
    caseOverviewEdges,
    communities,
    communityByCaseId,
    entityList: _buildEntityList(entities, maps.eventsByEntityId),
  };

  _store.typeRegistry = buildEntityTypeRegistry(_store);
  return _store;
}

export function getStore() {
  if (!_store) throw new Error("Store not built - call buildStore() first.");
  return _store;
}

export function getDetailGraph(options = {}) {
  if (!_store) throw new Error("Store not built.");
  const anchorEntityId = options.anchorEntityId;
  const anchorEntity = _store.entityById[anchorEntityId];
  if (!anchorEntity) throw new Error(`Unknown entity: ${anchorEntityId}`);

  const maxEntitiesPerType = Number.isFinite(options.maxEntitiesPerType)
    ? Math.max(1, options.maxEntitiesPerType)
    : Number.POSITIVE_INFINITY;
  const compareEntityIds = _resolveCompareEntityIds(anchorEntity, options.compareEntityIds ?? [], options.compareMode, maxEntitiesPerType);
  const anchorSet = new Set([anchorEntityId, ...compareEntityIds]);
  const filteredSeedEvents = [...anchorSet].flatMap(entityId => _filterEvents(_store.eventsByEntityId[entityId] ?? [], options));
  const seedEventIds = new Set(filteredSeedEvents.map(event => event.event_id));
  const focusScope = _resolveDetailFocusScope(anchorEntity, filteredSeedEvents, seedEventIds);
  const contextEntityIds = focusScope?.contextEntityIds
    ? new Set(focusScope.contextEntityIds)
    : new Set(anchorSet);

  if (!focusScope) {
    seedEventIds.forEach(eventId => {
      (_store.corrByEventId[eventId] ?? []).forEach(edge => contextEntityIds.add(edge.entity_id));
    });
    [...contextEntityIds].forEach(entityId => {
      (_store.relationsByEntityId[entityId] ?? []).forEach(relation => {
        contextEntityIds.add(relation.source_entity_id);
        contextEntityIds.add(relation.target_entity_id);
      });
    });
  }

  const detailTypeOrder = _resolveDetailTypeOrder(_store.bundle.dataset, contextEntityIds);
  const enabledTypeSet = options.visibleEntityTypes?.length
    ? new Set(options.visibleEntityTypes)
    : new Set(detailTypeOrder);

  const entityIdsByType = {};
  contextEntityIds.forEach(entityId => {
    const entity = _store.entityById[entityId];
    if (!entity || !enabledTypeSet.has(entity.primary_type)) return;
    if (!entityIdsByType[entity.primary_type]) entityIdsByType[entity.primary_type] = [];
    entityIdsByType[entity.primary_type].push(entityId);
  });
  const availableEntityCountsByType = Object.fromEntries(
    Object.entries(entityIdsByType).map(([type, ids]) => [type, ids.length])
  );

  const keptEntityIds = new Set();
  const bands = detailTypeOrder
    .filter(type => (entityIdsByType[type] ?? []).length > 0)
    .map(type => {
      const sortedIds = _sortDetailEntityIds(type, entityIdsByType[type], anchorEntityId, compareEntityIds);
      const limitedIds = _limitEntityIds(type, sortedIds, maxEntitiesPerType, anchorEntityId, compareEntityIds);
      limitedIds.forEach(entityId => keptEntityIds.add(entityId));
      return {
        entityType: type,
        entityLabel: _labelizeType(type),
        lanes: limitedIds.map(entityId => _buildLane(entityId, options)),
      };
    });

  const visibleEventIds = focusScope?.visibleEventIds
    ? new Set([...focusScope.visibleEventIds].filter(eventId => {
      const event = _store.eventById[eventId];
      return event && event.memberships?.some(membership => keptEntityIds.has(membership.entity_id));
    }))
    : new Set();
  if (!focusScope?.visibleEventIds) {
    keptEntityIds.forEach(entityId => {
      _filterEvents(_store.eventsByEntityId[entityId] ?? [], options).forEach(event => visibleEventIds.add(event.event_id));
    });
  }

  bands.forEach(band => {
    band.lanes = band.lanes.map(lane => {
      const events = lane.events.filter(event => visibleEventIds.has(event.event_id));
      const eventIdSet = new Set(events.map(event => event.event_id));
      const dfEdges = lane.dfEdges.filter(edge => eventIdSet.has(edge.source_event_id) && eventIdSet.has(edge.target_event_id));
      return {
        ...lane,
        events,
        eventIds: events.map(event => event.event_id),
        dfEdges,
        eventCount: events.length,
        sequence: events.map(event => event.activity).filter(Boolean),
      };
    }).filter(lane => lane.eventCount > 0 || lane.entity_id === anchorEntityId);
  });

  let eventAnchors = [...visibleEventIds]
    .map(eventId => _buildEventAnchor(eventId, keptEntityIds))
    .filter(Boolean)
    .sort((a, b) => _compareEvents(a, b));

  if (options.sharedOnly) {
    const minShared = options.minSharedEntities ?? 2;
    const sharedIds = new Set(eventAnchors.filter(anchor => anchor.sharedEntityIds.length >= minShared).map(anchor => anchor.event_id));
    eventAnchors = eventAnchors.filter(anchor => sharedIds.has(anchor.event_id));
    bands.forEach(band => {
      band.lanes.forEach(lane => {
        lane.events = lane.events.filter(event => sharedIds.has(event.event_id));
        lane.eventIds = lane.events.map(event => event.event_id);
        lane.dfEdges = lane.dfEdges.filter(edge => sharedIds.has(edge.source_event_id) && sharedIds.has(edge.target_event_id));
        lane.eventCount = lane.events.length;
        lane.sequence = lane.events.map(event => event.activity).filter(Boolean);
      });
    });
  }

  const normalizedBands = bands
    .map(band => ({
      ...band,
      lanes: band.lanes.filter(lane => lane.eventCount > 0 || lane.entity_id === anchorEntityId),
    }))
    .filter(band => band.lanes.length > 0);
  const visibleEntityIds = new Set(normalizedBands.flatMap(band => band.lanes.map(lane => lane.entity_id)));
  eventAnchors = eventAnchors.map(anchor => {
    const memberships = (anchor.memberships ?? []).filter(membership => visibleEntityIds.has(membership.entity_id));
    return {
      ...anchor,
      memberships,
      sharedEntityIds: memberships.map(membership => membership.entity_id),
      sharedEntityTypes: [...new Set(memberships.map(membership => membership.entity_type))],
      // totalEntityCount / totalEntityTypes come from _buildEventAnchor and reflect
      // the raw data scope; preserve them through this second view-filtering pass.
      totalEntityCount: anchor.totalEntityCount ?? memberships.length,
      totalEntityTypes: anchor.totalEntityTypes ?? [...new Set(memberships.map(m => m.entity_type))],
    };
  }).filter(anchor => anchor.memberships.length > 0);

  const eventAnchorById = Object.fromEntries(eventAnchors.map(anchor => [anchor.event_id, anchor]));
  normalizedBands.forEach(band => {
    const {
      dominantSequence, dominantSupport, comparedSequenceCount, hasDominantPattern, sequenceByEntityId, compareSet,
    } = _analyzeBandPatterns(band, anchorEntity.primary_type, anchorEntityId, compareEntityIds);
    band.dominantSequence = dominantSequence;
    band.dominantSupport = dominantSupport;
    band.comparedSequenceCount = comparedSequenceCount;
    band.hasDominantPattern = hasDominantPattern;
    band.compareEntityIds = [...compareSet];
    band.lanes = band.lanes.map(lane => ({
      ...lane,
      sequence: sequenceByEntityId[lane.entity_id]?.sequence ?? [],
      followsDominant: sequenceByEntityId[lane.entity_id]?.followsDominant ?? false,
      dominanceState: sequenceByEntityId[lane.entity_id]?.dominanceState ?? "neutral",
      hasDominantPattern,
      isCompared: compareSet.has(lane.entity_id),
      memberships: lane.events.map(event => ({
        event_id: event.event_id,
        anchor: eventAnchorById[event.event_id],
      })).filter(membership => membership.anchor),
    }));
  });

  const visibleRelations = _store.relations.filter(edge =>
    visibleEntityIds.has(edge.source_entity_id) && visibleEntityIds.has(edge.target_entity_id)
  );
  const bottleneckThresholdHours = _annotateBottlenecks(normalizedBands, _store.eventById);
  const summary = _summarizeDetailGraph(normalizedBands, eventAnchors, visibleRelations, anchorEntity, compareEntityIds, bottleneckThresholdHours);

  return {
    anchorEntityId,
    anchorEntityType: anchorEntity.primary_type,
    anchorEntity,
    compareEntityIds,
    caseType: _store.caseType,
    itemType: _store.itemType,
    eventAnchors,
    bands: normalizedBands,
    sharedEvents: eventAnchors.filter(anchor => anchor.sharedEntityIds.length >= (options.minSharedEntities ?? 2)),
    crossTypeLinks: _buildCrossTypeLinks(eventAnchors),
    relations: visibleRelations,
    summary,
    scope: focusScope?.scope ?? "neighborhood",
    visibleEntityTypes: normalizedBands.map(band => band.entityType),
    visibleEntityIds: [...visibleEntityIds],
    availableEntityCountsByType,
    maxAvailableEntitiesPerType: Math.max(1, ...Object.values(availableEntityCountsByType)),
  };
}

export function getGraph(anchorEntityId, filters = {}) {
  const anchorEntityType = _store?.entityById?.[anchorEntityId]?.primary_type;
  return getDetailGraph({ anchorEntityId, anchorEntityType, ...filters });
}

export function getOverviewGraph(filters = {}) {
  if (!_store) throw new Error("Store not built.");
  const { communityId = null, minEdgeWeight = OVERVIEW_SIM_MIN, activities = null } = filters;

  let overviewEdges = _store.caseOverviewEdges;
  let communityByCaseId = _store.communityByCaseId;
  if (activities !== null) {
    const cacheKey = [...activities].sort().join("\0");
    if (_overviewCache.has(cacheKey)) {
      ({ overviewEdges, communityByCaseId } = _overviewCache.get(cacheKey));
    } else {
      const filteredSummaries = _buildFilteredSummaries(_store.caseSummaryById, _store.eventsByCaseId, activities);
      overviewEdges = _buildOverviewRelations(filteredSummaries);
      ({ communityByCaseId } = _buildOverviewCommunities(filteredSummaries, overviewEdges));
      _overviewCache.set(cacheKey, { overviewEdges, communityByCaseId });
    }
  }

  const nodes = [];
  const visibleSet = new Set();

  _store.caseList.forEach(item => {
    const summary = _store.caseSummaryById[item.id];
    const community = communityByCaseId[item.id] ?? { id: item.id, label: "Community", hint: "", weightedDegree: 0 };
    if (communityId && community.id !== communityId) return;
    const filteredEvents = _filterEvents(_store.eventsByCaseId[item.id] ?? [], filters);
    if (filteredEvents.length === 0) return;
    const filteredItems = new Set(filteredEvents.map(event => event.item_entity_id)).size;
    nodes.push({
      id: summary.id,
      label: summary.id,
      attrs: summary.attrs,
      displayAttrs: summary.overviewDisplayAttrs,
      attrKeys: summary.overviewAttrKeys,
      resources: summary.overviewResources,
      clusterKey: community.id,
      clusterLabel: community.label,
      clusterCode: community.code,
      clusterHint: community.hint,
      firstDate: summary.firstDate,
      lastDate: summary.lastDate,
      totalEvents: summary.eventCount,
      filteredEvents: filteredEvents.length,
      totalItems: summary.itemCount,
      filteredItems,
      resourceCount: summary.overviewResourceCount,
      topResources: summary.overviewTopResources,
      topActivities: summary.topActivities,
      weightedDegree: community.weightedDegree ?? 0,
    });
    visibleSet.add(summary.id);
  });

  const edges = overviewEdges.filter(edge =>
    edge.weight >= minEdgeWeight && visibleSet.has(edge.source) && visibleSet.has(edge.target)
  );

  const degreeById = {};
  const weightedDegreeById = {};
  edges.forEach(edge => {
    degreeById[edge.source] = (degreeById[edge.source] ?? 0) + 1;
    degreeById[edge.target] = (degreeById[edge.target] ?? 0) + 1;
    weightedDegreeById[edge.source] = (weightedDegreeById[edge.source] ?? 0) + edge.weight;
    weightedDegreeById[edge.target] = (weightedDegreeById[edge.target] ?? 0) + edge.weight;
  });
  nodes.forEach(node => {
    node.degree = degreeById[node.id] ?? 0;
    node.weightedDegree = weightedDegreeById[node.id] ?? node.weightedDegree ?? 0;
  });

  const clusters = Object.values(nodes.reduce((acc, node) => {
    if (!acc[node.clusterKey]) {
      acc[node.clusterKey] = {
        id: node.clusterKey,
        label: node.clusterLabel,
        code: node.clusterCode,
        hint: node.clusterHint,
        nodeIds: [],
        resources: [],
        attributes: [],
      };
    }
    acc[node.clusterKey].nodeIds.push(node.id);
    return acc;
  }, {}));

  clusters.forEach(cluster => {
    const members = nodes.filter(node => node.clusterKey === cluster.id);
    cluster.count = cluster.nodeIds.length;
    cluster.resources = _aggregateCommunityResources(members);
    cluster.attributes = _aggregateCommunityAttrs(members);
  });
  clusters.sort((a, b) => b.nodeIds.length - a.nodeIds.length || a.label.localeCompare(b.label));
  const communityEdges = _buildCommunityEdges(edges, nodes);

  return {
    isOverviewNetwork: true,
    nodes,
    edges,
    communityEdges,
    clusters,
    meta: {
      caseCount: nodes.length,
      totalCaseCount: _store.caseList.length,
      clusterCount: clusters.length,
      overviewEdgeCount: edges.length,
      overviewCommunityEdgeCount: communityEdges.length,
      filteredEvents: nodes.reduce((sum, node) => sum + node.filteredEvents, 0),
      totalEvents: nodes.reduce((sum, node) => sum + node.totalEvents, 0),
      shownItems: nodes.reduce((sum, node) => sum + node.filteredItems, 0),
      totalItems: nodes.reduce((sum, node) => sum + node.totalItems, 0),
      focusCommunityId: communityId,
    },
  };
}

export function getVariantOverview(filters = {}, maxVariants = null) {
  if (!_store) throw new Error("Store not built.");
  const instances = _collectItemSequences(filters);
  const totalInstances = instances.length;
  const variantsByKey = new Map();

  instances.forEach(instance => {
    const key = JSON.stringify(instance.sequence);
    if (!variantsByKey.has(key)) variantsByKey.set(key, { sequence: [...instance.sequence], instances: [] });
    variantsByKey.get(key).instances.push(instance);
  });

  const variants = [...variantsByKey.entries()]
    .map(([key, variant]) => ({
      ...variant,
      ..._summarizeVariantInstances(variant.instances),
      count: variant.instances.length,
      frequency: totalInstances > 0 ? variant.instances.length / totalInstances : 0,
      _key: key,
    }))
    .sort((a, b) => b.count - a.count || b.sequence.length - a.sequence.length || a._key.localeCompare(b._key));

  const topPercentLimit = Math.max(1, Math.ceil(variants.length * 0.2));
  const limit = maxVariants === Number.POSITIVE_INFINITY
    ? variants.length
    : (Number.isFinite(maxVariants) && maxVariants > 0 ? maxVariants : topPercentLimit);
  const shownVariants = variants.slice(0, limit).map((variant, index) => ({
    key: variant._key,
    sequence: variant.sequence,
    instanceIds: variant.instanceIds,
    items: variant.items,
    members: variant.members,
    itemCount: variant.itemCount,
    memberCount: variant.memberCount,
    eventTotal: variant.eventTotal,
    eventAverage: variant.eventAverage,
    avgDurationHours: variant.avgDurationHours,
    minDurationHours: variant.minDurationHours,
    maxDurationHours: variant.maxDurationHours,
    firstDate: variant.firstDate,
    lastDate: variant.lastDate,
    topResources: variant.topResources,
    resourceCount: variant.resourceCount,
    topActivities: variant.topActivities,
    rank: index + 1,
    count: variant.count,
    frequency: variant.frequency,
    isdominant: index === 0,
  }));

  return {
    isVariantOverview: true,
    variants: shownVariants,
    totalInstances,
    variantCount: variants.length,
    shownVariantCount: shownVariants.length,
    shownVariantPercent: variants.length ? shownVariants.length / variants.length : 0,
    caseType: _store.caseType,
    itemType: _store.itemType,
    summary: {
      dominantVariantKey: shownVariants[0]?.key ?? null,
      dominantVariantShare: shownVariants[0]?.frequency ?? 0,
      dominantVariantCount: shownVariants[0]?.count ?? 0,
      averageVariantSize: variants.length
        ? variants.reduce((sum, variant) => sum + variant.count, 0) / variants.length
        : 0,
      averageSequenceLength: variants.length
        ? variants.reduce((sum, variant) => sum + variant.sequence.length, 0) / variants.length
        : 0,
    },
  };
}

export function getAllVariantOverview(filters = {}) {
  return getVariantOverview(filters, Number.POSITIVE_INFINITY);
}

export function getActivityDfGraph(filters = {}) {
  if (!_store) throw new Error("Store not built.");
  const instances = _collectItemSequences(filters);
  const nodeCountByActivity = {};
  const nodeIndexSumByActivity = {};
  const nodePosCountByActivity = {};
  const edgeByKey = new Map();

  instances.forEach(instance => {
    instance.sequence.forEach((activity, index) => {
      nodeCountByActivity[activity] = (nodeCountByActivity[activity] ?? 0) + 1;
      nodeIndexSumByActivity[activity] = (nodeIndexSumByActivity[activity] ?? 0) + index;
      nodePosCountByActivity[activity] = (nodePosCountByActivity[activity] ?? 0) + 1;
    });
    for (let i = 0; i < instance.sequence.length - 1; i++) {
      const key = `${instance.sequence[i]}__${instance.sequence[i + 1]}`;
      if (!edgeByKey.has(key)) {
        edgeByKey.set(key, { source: instance.sequence[i], target: instance.sequence[i + 1], count: 0 });
      }
      edgeByKey.get(key).count += 1;
    }
  });

  const nodes = Object.entries(nodeCountByActivity)
    .map(([id, count]) => ({
      id,
      label: id,
      count,
      avgIndex: (nodeIndexSumByActivity[id] ?? 0) / Math.max(nodePosCountByActivity[id] ?? 1, 1),
    }))
    .sort((a, b) => a.avgIndex - b.avgIndex || b.count - a.count || a.label.localeCompare(b.label));
  const edges = [...edgeByKey.values()].sort((a, b) => b.count - a.count || a.source.localeCompare(b.source));
  return { nodes, edges };
}

function _summarizeVariantInstances(instances) {
  const itemMap = new Map();
  const memberMap = new Map();
  const resourceCounts = {};
  const activityCounts = {};
  let eventTotal = 0;
  let durationTotal = 0;
  let durationCount = 0;
  let minDurationHours = Infinity;
  let maxDurationHours = -Infinity;
  let minTime = Infinity;
  let maxTime = -Infinity;

  (instances ?? []).forEach(instance => {
    const itemId = instance.entityId;
    const itemEntity = _store.entityById[itemId];
    const events = (instance.eventIds ?? [])
      .map(eventId => _store.eventById[eventId])
      .filter(Boolean)
      .sort(_compareEvents);

    if (!itemMap.has(itemId)) {
      itemMap.set(itemId, {
        id: itemId,
        label: _entityLabel(itemEntity),
        eventCount: 0,
      });
    }
    itemMap.get(itemId).eventCount += events.length;
    eventTotal += events.length;

    const memberIdsForItem = new Set(events.map(event => event.case_entity_id).filter(Boolean));
    if (!memberIdsForItem.size && instance.caseId) memberIdsForItem.add(instance.caseId);

    events.forEach(event => {
      const timestamp = event.date?.getTime?.();
      if (Number.isFinite(timestamp)) {
        minTime = Math.min(minTime, timestamp);
        maxTime = Math.max(maxTime, timestamp);
      }
      if (event.activity) activityCounts[event.activity] = (activityCounts[event.activity] ?? 0) + 1;
      (event.resource_labels ?? []).forEach(resource => {
        resourceCounts[resource] = (resourceCounts[resource] ?? 0) + 1;
      });
    });

    const durationHours = events.length > 1 ? _hoursBetween(events[0]?.date, events.at(-1)?.date) : 0;
    if (Number.isFinite(durationHours)) {
      durationTotal += durationHours;
      durationCount += 1;
      minDurationHours = Math.min(minDurationHours, durationHours);
      maxDurationHours = Math.max(maxDurationHours, durationHours);
    }

    memberIdsForItem.forEach(memberId => {
      const memberEntity = _store.entityById[memberId];
      if (!memberMap.has(memberId)) {
        memberMap.set(memberId, {
          id: memberId,
          label: _entityLabel(memberEntity),
          itemCount: 0,
          eventCount: 0,
        });
      }
      const memberEntry = memberMap.get(memberId);
      memberEntry.itemCount += 1;
      memberEntry.eventCount += events.filter(event => !event.case_entity_id || event.case_entity_id === memberId).length || events.length;
    });
  });

  const items = [...itemMap.values()]
    .sort((a, b) => b.eventCount - a.eventCount || a.label.localeCompare(b.label));
  const members = [...memberMap.values()]
    .sort((a, b) => b.itemCount - a.itemCount || b.eventCount - a.eventCount || a.label.localeCompare(b.label));
  const topResources = Object.entries(resourceCounts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([label, count]) => ({ label, count }));
  const topActivities = Object.entries(activityCounts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([activity, count]) => ({ activity, count }));

  return {
    instanceIds: items.map(item => item.id),
    items,
    members,
    itemCount: items.length,
    memberCount: members.length,
    eventTotal,
    eventAverage: items.length ? eventTotal / items.length : 0,
    avgDurationHours: durationCount ? durationTotal / durationCount : NaN,
    minDurationHours: durationCount ? minDurationHours : NaN,
    maxDurationHours: durationCount ? maxDurationHours : NaN,
    firstDate: Number.isFinite(minTime) ? new Date(minTime) : null,
    lastDate: Number.isFinite(maxTime) ? new Date(maxTime) : null,
    topResources,
    resourceCount: Object.keys(resourceCounts).length,
    topActivities,
  };
}

export function getResourcesForEntity(entityId) {
  if (!_store) return [];
  return [...new Set((_store.eventsByEntityId[entityId] ?? []).flatMap(event => event.resource_labels ?? []))].sort((a, b) => a.localeCompare(b));
}

export function getActivityCountsForEntity(entityId) {
  if (!_store) return {};
  return _countBy(_store.eventsByEntityId[entityId] ?? [], event => event.activity);
}

export function getGlobalSharedEventHotspots({ activities = null, entityTypeFilter = null, sortBy = "frequency", minSharedEntities = 2, dateFrom = null, dateTo = null } = {}) {
  if (!_store) return [];
  // Apply date + activity filters up front so every downstream calculation
  // automatically reflects the active time window.
  const events = _filterEvents(_store.events, { activities, dateFrom, dateTo });
  const byActivity = new Map();
  events.forEach(event => {
    if (event.entity_ids.length < minSharedEntities) return;
    const types = [...new Set(event.memberships.map(m => m.entity_type))];
    if (entityTypeFilter && !types.some(t => entityTypeFilter.has(t))) return;
    if (!byActivity.has(event.activity)) {
      byActivity.set(event.activity, { activity: event.activity, eventIds: [], entityIdSet: new Set(), typePairSet: new Set() });
    }
    const entry = byActivity.get(event.activity);
    entry.eventIds.push(event.event_id);
    event.entity_ids.forEach(id => entry.entityIdSet.add(id));
    const sortedTypes = [...new Set(types)].sort();
    for (let i = 0; i < sortedTypes.length; i++) {
      for (let j = i + 1; j < sortedTypes.length; j++) {
        entry.typePairSet.add(`${sortedTypes[i]}→${sortedTypes[j]}`);
      }
    }
  });

  const hotspots = [...byActivity.values()].map(entry => {
    const eventObjects = entry.eventIds.map(id => _store.eventById[id]).filter(Boolean);
    const avgSyncDegree = eventObjects.reduce((sum, e) => sum + e.entity_ids.length, 0) / Math.max(eventObjects.length, 1);
    const dates = eventObjects.map(e => e.date?.getTime()).filter(Number.isFinite);
    const types = [...new Set(eventObjects.flatMap(e => e.memberships.map(m => m.entity_type)))];
    return {
      id: `act:${entry.activity}`,
      activity: entry.activity,
      color: _store.activityColorByName[entry.activity] ?? "#64748b",
      eventIds: entry.eventIds,
      eventCount: entry.eventIds.length,
      entityCount: entry.entityIdSet.size,
      entityTypes: types,
      typePairs: [...entry.typePairSet].sort(),
      avgSyncDegree,
      firstDate: dates.length ? new Date(Math.min(...dates)) : null,
      lastDate:  dates.length ? new Date(Math.max(...dates)) : null,
    };
  });

  if (sortBy === "syncStrength") hotspots.sort((a, b) => b.avgSyncDegree - a.avgSyncDegree || b.eventCount - a.eventCount);
  else if (sortBy === "recency") hotspots.sort((a, b) => (b.lastDate?.getTime() ?? 0) - (a.lastDate?.getTime() ?? 0));
  else hotspots.sort((a, b) => b.eventCount - a.eventCount || a.activity.localeCompare(b.activity));

  return hotspots.filter(h => h.eventCount > 0);
}

// ── EKG Atlas: complete-EKG aggregator for the primary T1 view ──────────────
//
// Produces a single bundle that powers all three coordinated panels of the
// Atlas screen. Computed lazily on demand; safe to call repeatedly because the
// underlying store maps are immutable per dataset load.
//
// Returns:
//   stats         – global counts (events, entities, types, sharedEvents…)
//   timeRange     – {min,max} ms timestamps spanning visible events
//   typeNodes     – nodes for the force-directed type graph
//   typeEdges     – edges (structural + shared-event weights)
//   streamBins    – time-binned event counts per entity type (streamgraph)
//   streamTypes   – stable stack order for streamgraph layers
//   activityBands – reuses getTypeEKGGraph for the per-type activity flow panel
//   topActivities – global top-N activities by frequency
//   topHotspots   – top shared-event hotspots (≥2 entity types)
export function getEkgAtlas(filters = {}) {
  if (!_store) throw new Error("Store not built.");
  const { activities = null, dateFrom = null, dateTo = null } = filters;

  // Apply global filters once; reuse the filtered slice for every panel.
  const filteredEvents = _filterEvents(_store.events, { activities, dateFrom, dateTo });
  const filteredEventIdSet = new Set(filteredEvents.map(event => event.event_id));

  // ── Time range ──
  const times = filteredEvents.map(event => event.date?.getTime()).filter(Number.isFinite);
  const timeRange = times.length
    ? { min: Math.min(...times), max: Math.max(...times) }
    : { min: 0, max: 1 };

  // ── Type nodes ──
  const typeRegistry = _store.typeRegistry;
  const eventsByType = {};
  filteredEvents.forEach(event => {
    const types = new Set(event.memberships.map(m => m.entity_type));
    types.forEach(type => {
      if (!eventsByType[type]) eventsByType[type] = 0;
      eventsByType[type] += 1;
    });
  });

  const typeNodes = (typeRegistry?.types ?? []).map(typeInfo => ({
    id: typeInfo.name,
    label: typeInfo.displayLabel,
    role: typeInfo.role,
    color: typeInfo.color,
    entityCount: typeInfo.count,
    eventCount: eventsByType[typeInfo.name] ?? 0,
  })).filter(node => node.entityCount > 0);

  // ── Type edges: shared-event co-occurrence + structural relations ──
  const sharedPairCounts = new Map();
  filteredEvents.forEach(event => {
    const types = [...new Set(event.memberships.map(m => m.entity_type))].sort();
    if (types.length < 2) return;
    for (let i = 0; i < types.length; i++) {
      for (let j = i + 1; j < types.length; j++) {
        const key = `${types[i]}\x00${types[j]}`;
        sharedPairCounts.set(key, (sharedPairCounts.get(key) ?? 0) + 1);
      }
    }
  });

  const structuralPairCounts = new Map();
  (_store.relations ?? []).forEach(relation => {
    const a = relation.source_entity_type;
    const b = relation.target_entity_type;
    if (!a || !b || a === b) return;
    const key = a < b ? `${a}\x00${b}` : `${b}\x00${a}`;
    structuralPairCounts.set(key, (structuralPairCounts.get(key) ?? 0) + 1);
  });

  const typeNodeSet = new Set(typeNodes.map(n => n.id));
  const typeEdgesMap = new Map();
  sharedPairCounts.forEach((count, key) => {
    const [a, b] = key.split("\x00");
    if (!typeNodeSet.has(a) || !typeNodeSet.has(b)) return;
    typeEdgesMap.set(key, {
      source: a, target: b,
      sharedEventCount: count,
      structuralRelationCount: structuralPairCounts.get(key) ?? 0,
      kind: structuralPairCounts.has(key) ? "both" : "shared",
    });
  });
  structuralPairCounts.forEach((count, key) => {
    if (typeEdgesMap.has(key)) return;
    const [a, b] = key.split("\x00");
    if (!typeNodeSet.has(a) || !typeNodeSet.has(b)) return;
    typeEdgesMap.set(key, {
      source: a, target: b,
      sharedEventCount: 0,
      structuralRelationCount: count,
      kind: "structural",
    });
  });
  const typeEdges = [...typeEdgesMap.values()];

  // ── Streamgraph: time-binned counts per type ──
  const ATLAS_BIN_COUNT = 48;
  const span = Math.max(timeRange.max - timeRange.min, 1);
  const binWidth = span / ATLAS_BIN_COUNT;
  const streamBins = Array.from({ length: ATLAS_BIN_COUNT }, (_, i) => ({
    binIndex: i,
    t0: timeRange.min + i * binWidth,
    t1: timeRange.min + (i + 1) * binWidth,
    countsByType: {},
    total: 0,
  }));
  filteredEvents.forEach(event => {
    const t = event.date?.getTime();
    if (!Number.isFinite(t)) return;
    const i = Math.min(ATLAS_BIN_COUNT - 1, Math.max(0, Math.floor((t - timeRange.min) / binWidth)));
    const bin = streamBins[i];
    const seenTypes = new Set();
    event.memberships.forEach(m => {
      if (seenTypes.has(m.entity_type)) return;
      seenTypes.add(m.entity_type);
      bin.countsByType[m.entity_type] = (bin.countsByType[m.entity_type] ?? 0) + 1;
      bin.total += 1;
    });
  });

  // Stack order: by role (case→item→other→resource→attribute) then total volume desc.
  const streamTypes = [...typeNodes]
    .sort((a, b) => {
      const order = { case: 0, item: 1, other: 2, resource: 3, attribute: 4 };
      const ra = order[a.role] ?? 2;
      const rb = order[b.role] ?? 2;
      if (ra !== rb) return ra - rb;
      return b.eventCount - a.eventCount;
    })
    .map(t => t.id);

  // ── Activity-flow bands (reuse typeEKG aggregates for the third panel) ──
  // We rebuild it locally so the filter (dateFrom/dateTo) is respected;
  // getTypeEKGGraph only honors `activities`. The structure is identical so
  // overviewLayout.computeTypeEKGLayout can be reused as-is.
  const activityBands = _buildAtlasActivityBands(filteredEvents, filteredEventIdSet, timeRange);

  // ── Top activities (overall) ──
  const activityCounts = {};
  filteredEvents.forEach(event => {
    activityCounts[event.activity] = (activityCounts[event.activity] ?? 0) + 1;
  });
  const topActivities = Object.entries(activityCounts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 6)
    .map(([activity, count]) => ({
      activity, count,
      color: _store.activityColorByName[activity] ?? "#64748b",
    }));

  // ── Top shared-event hotspots ──
  const topHotspots = getGlobalSharedEventHotspots({ activities, minSharedEntities: 2 }).slice(0, 5);

  // ── Stats ──
  const stats = {
    events: filteredEvents.length,
    totalEvents: _store.events.length,
    entities: _store.entities.length,
    entityTypes: typeNodes.length,
    sharedEvents: filteredEvents.filter(event => event.entity_ids.length >= 2).length,
    typeEdges: typeEdges.length,
    totalCorr: _store.corr.length,
    totalRelations: _store.relations.length,
  };

  return {
    isEkgAtlas: true,
    stats,
    timeRange,
    typeNodes,
    typeEdges,
    streamBins,
    streamTypes,
    activityBands,
    topActivities,
    topHotspots,
    caseType: _store.caseType,
    itemType: _store.itemType,
    filterContext: { activities, dateFrom, dateTo },
  };
}

// ── EKG View: multi-scale (L0–L3) data aggregator for the new /ekg screen ──
//
// Design follows Shneiderman's "overview, zoom and filter, details on demand"
// mantra (1996) and the Performance Spectrum's time-axis-aligned encoding
// (Denisov, Belkina & Fahland 2018): one time scale shared across all bands
// and zoom levels, with the *encoding* changing per level — not the spatial
// frame. The data layer prepares all four levels' inputs in one pass so the
// view can switch levels without re-querying the store.
//
//   L0 Galaxy        → per-bin × per-type × per-activity counts (heat strips)
//   L1 District      → activity-flow bands (reuses _buildAtlasActivityBands)
//   L2 Neighbourhood → per-entity sparklines, sorted chronologically
//   L3 Street        → caller invokes getDetailGraph lazily on the focus entity
//
// Returns shapes documented inline at the return statement.
const EKG_VIEW_BIN_COUNT = 48;

export function getEkgView(filters = {}) {
  if (!_store) throw new Error("Store not built.");
  const { activities = null, dateFrom = null, dateTo = null } = filters;

  const filteredEvents = _filterEvents(_store.events, { activities, dateFrom, dateTo });
  const filteredEventIdSet = new Set(filteredEvents.map(event => event.event_id));

  // ── Time scale ──
  const times = filteredEvents.map(event => event.date?.getTime()).filter(Number.isFinite);
  const timeRange = times.length
    ? { min: Math.min(...times), max: Math.max(...times) }
    : { min: 0, max: 1 };
  const span = Math.max(timeRange.max - timeRange.min, 1);
  const binWidth = span / EKG_VIEW_BIN_COUNT;
  const binFor = t => Math.min(EKG_VIEW_BIN_COUNT - 1, Math.max(0, Math.floor((t - timeRange.min) / binWidth)));

  // ── L0 bins: per-bin × per-type × per-activity counts ──
  // Each event is counted once *per unique entity type it touches*. That keeps
  // a single event from inflating one type's count while still letting the
  // total reflect (event, type) pairs. This invariant is what the test suite
  // verifies via _Stream conservation_.
  const bins = Array.from({ length: EKG_VIEW_BIN_COUNT }, (_, i) => ({
    binIndex: i,
    t0: timeRange.min + i * binWidth,
    t1: timeRange.min + (i + 1) * binWidth,
    total: 0,
    byType: Object.create(null),
  }));

  filteredEvents.forEach(event => {
    const t = event.date?.getTime();
    if (!Number.isFinite(t)) return;
    const bin = bins[binFor(t)];
    const seenTypes = new Set();
    event.memberships.forEach(m => {
      if (seenTypes.has(m.entity_type)) return;
      seenTypes.add(m.entity_type);
      let typeStats = bin.byType[m.entity_type];
      if (!typeStats) {
        typeStats = { total: 0, byActivity: Object.create(null) };
        bin.byType[m.entity_type] = typeStats;
      }
      typeStats.total += 1;
      typeStats.byActivity[event.activity] = (typeStats.byActivity[event.activity] ?? 0) + 1;
      bin.total += 1;
    });
  });

  const globalDensity = bins.map(bin => bin.total);

  // ── L2 sparklines: one row per entity, sorted by firstTime ──
  const sparklinesByType = Object.create(null);
  const eventsByEntity = _store.eventsByEntityId ?? {};
  Object.keys(_store.entityIdsByType ?? {}).forEach(type => {
    const rows = [];
    (_store.entityIdsByType[type] ?? []).forEach(entityId => {
      const entity = _store.entityById[entityId];
      const events = (eventsByEntity[entityId] ?? [])
        .filter(event => filteredEventIdSet.has(event.event_id))
        .map(event => ({
          event_id: event.event_id,
          t: event.date?.getTime(),
          activity: event.activity,
          activityColor: event.activityColor,
          isShared: event.entity_ids.length >= 2,
        }))
        .filter(event => Number.isFinite(event.t))
        .sort((a, b) => a.t - b.t);
      if (!events.length) return;
      rows.push({
        entity_id: entityId,
        label: _entityLabel(entity),
        primaryType: type,
        firstTime: events[0].t,
        lastTime: events[events.length - 1].t,
        eventCount: events.length,
        events,
      });
    });
    // Stable order: first-event timestamp asc, ties broken by entity_id so
    // every test run produces the same array.
    rows.sort((a, b) => a.firstTime - b.firstTime || a.entity_id.localeCompare(b.entity_id));
    sparklinesByType[type] = rows;
  });

  // ── Shared-event spines: one per event touching ≥2 entity types ──
  const spines = [];
  filteredEvents.forEach(event => {
    if (event.entity_ids.length < 2) return;
    const types = [...new Set(event.memberships.map(m => m.entity_type))].sort();
    if (types.length < 2) return;
    const t = event.date?.getTime();
    if (!Number.isFinite(t)) return;
    spines.push({
      event_id: event.event_id,
      t,
      activity: event.activity,
      activityColor: _store.activityColorByName[event.activity] ?? "#64748b",
      types,
      sharedEntityIds: [...event.entity_ids],
      sharedEntityCount: event.entity_ids.length,
    });
  });
  spines.sort((a, b) => a.t - b.t || a.event_id.localeCompare(b.event_id));

  // ── L1 activity bands: reuse the atlas helper (single source of truth) ──
  const activityBands = _buildAtlasActivityBands(filteredEvents, filteredEventIdSet, timeRange);

  // ── Type metadata, ordered by role (cases → items → other → resource → attribute) ──
  const typeRegistry = _store.typeRegistry;
  const eventCountByType = Object.create(null);
  filteredEvents.forEach(event => {
    const seen = new Set();
    event.memberships.forEach(m => {
      if (seen.has(m.entity_type)) return;
      seen.add(m.entity_type);
      eventCountByType[m.entity_type] = (eventCountByType[m.entity_type] ?? 0) + 1;
    });
  });
  const typeNodes = (typeRegistry?.types ?? [])
    .map(t => ({
      id: t.name,
      label: t.displayLabel,
      role: t.role,
      color: t.color,
      entityCount: t.count,
      eventCount: eventCountByType[t.name] ?? 0,
      entityCountVisible: (sparklinesByType[t.name] ?? []).length,
    }))
    .filter(node => node.entityCount > 0);

  const bandOrder = typeNodes.map(node => node.id);

  // ── Stats ──
  const stats = {
    events: filteredEvents.length,
    totalEvents: _store.events.length,
    entities: _store.entities.length,
    entityTypes: typeNodes.length,
    sharedEvents: spines.length,
    binCount: EKG_VIEW_BIN_COUNT,
    invalidEventCount: _store.invalidEventCount ?? 0,
  };

  return {
    isEkgView: true,
    invalidEventCount: _store.invalidEventCount ?? 0,
    timeRange,
    binCount: EKG_VIEW_BIN_COUNT,
    binWidth,
    bins,
    globalDensity,
    sparklinesByType,
    spines,
    activityBands,
    typeNodes,
    bandOrder,
    stats,
    caseType: _store.caseType,
    itemType: _store.itemType,
    activityColorByName: _store.activityColorByName,
    filterContext: { activities, dateFrom, dateTo },
  };
}

function _buildAtlasActivityBands(filteredEvents, _filteredEventIdSet, timeRange) {
  const eventsByType = {};
  filteredEvents.forEach(event => {
    const types = [...new Set(event.memberships.map(m => m.entity_type))];
    types.forEach(type => {
      if (!eventsByType[type]) eventsByType[type] = [];
      eventsByType[type].push(event);
    });
  });
  const entityTypes = Object.keys(eventsByType).sort((a, b) => eventsByType[b].length - eventsByType[a].length);
  const bandsByType = {};
  entityTypes.forEach(type => {
    const actMap = {};
    eventsByType[type].forEach(event => {
      if (!actMap[event.activity]) actMap[event.activity] = { count: 0, sum: 0, n: 0 };
      actMap[event.activity].count += 1;
      if (event.date) { actMap[event.activity].sum += event.date.getTime(); actMap[event.activity].n += 1; }
    });
    bandsByType[type] = {
      nodes: Object.entries(actMap).map(([activity, d]) => ({
        activity, count: d.count,
        meanTimestamp: d.n > 0 ? d.sum / d.n : 0,
      })).sort((a, b) => a.meanTimestamp - b.meanTimestamp),
      dfEdges: [],
    };
  });

  const dfByType = {};
  _store.df.forEach(edge => {
    const entity = _store.entityById[edge.entity_id];
    if (!entity || !bandsByType[entity.primary_type]) return;
    if (!_filteredEventIdSet.has(edge.source) || !_filteredEventIdSet.has(edge.target)) return;
    const srcAct = _store.eventById[edge.source]?.activity;
    const tgtAct = _store.eventById[edge.target]?.activity;
    if (!srcAct || !tgtAct) return;
    const type = entity.primary_type;
    if (!dfByType[type]) dfByType[type] = {};
    const key = `${srcAct}\x00${tgtAct}`;
    dfByType[type][key] = (dfByType[type][key] ?? 0) + 1;
  });
  entityTypes.forEach(type => {
    bandsByType[type].dfEdges = Object.entries(dfByType[type] ?? {})
      .map(([key, count]) => {
        const [source, target] = key.split("\x00");
        return { source, target, count };
      })
      .sort((a, b) => b.count - a.count)
      .slice(0, 32);
  });

  const syncMap = {};
  filteredEvents.forEach(event => {
    const types = [...new Set(event.memberships.map(m => m.entity_type))].sort();
    if (types.length < 2) return;
    for (let i = 0; i < types.length; i++) {
      for (let j = i + 1; j < types.length; j++) {
        const key = `${event.activity}\x00${types[i]}\x00${types[j]}`;
        if (!syncMap[key]) syncMap[key] = { activity: event.activity, type1: types[i], type2: types[j], count: 0 };
        syncMap[key].count += 1;
      }
    }
  });

  return {
    entityTypes,
    bandsByType,
    syncArcs: Object.values(syncMap).sort((a, b) => b.count - a.count).slice(0, 56),
    minTime: timeRange.min,
    maxTime: timeRange.max,
    totalEvents: filteredEvents.length,
    caseType: _store.caseType,
    itemType: _store.itemType,
  };
}

export function getTypeEKGGraph(filters = {}) {
  if (!_store) return null;
  const activities = filters.activities ?? null;

  const filteredEvents = _store.events.filter(e => !activities || activities.has(e.activity));

  // Group events by entity type (an event appears in all types it's correlated to)
  const eventsByType = {};
  filteredEvents.forEach(event => {
    const types = [...new Set(event.memberships.map(m => m.entity_type))];
    types.forEach(type => {
      if (!eventsByType[type]) eventsByType[type] = [];
      eventsByType[type].push(event);
    });
  });

  const entityTypes = Object.keys(eventsByType).sort((a, b) =>
    eventsByType[b].length - eventsByType[a].length
  );

  // Aggregate activity nodes per type (count + mean timestamp)
  const bandsByType = {};
  entityTypes.forEach(type => {
    const actMap = {};
    eventsByType[type].forEach(event => {
      if (!actMap[event.activity]) actMap[event.activity] = { count: 0, sum: 0, n: 0 };
      actMap[event.activity].count++;
      if (event.date) { actMap[event.activity].sum += event.date.getTime(); actMap[event.activity].n++; }
    });
    bandsByType[type] = {
      nodes: Object.entries(actMap).map(([activity, d]) => ({
        activity,
        count: d.count,
        meanTimestamp: d.n > 0 ? d.sum / d.n : 0,
      })).sort((a, b) => a.meanTimestamp - b.meanTimestamp),
      dfEdges: [],
    };
  });

  // Build DF transition counts per entity type from raw DF edges
  const dfByType = {};
  _store.df.forEach(edge => {
    const entity = _store.entityById[edge.entity_id];
    if (!entity || !bandsByType[entity.primary_type]) return;
    const srcAct = _store.eventById[edge.source]?.activity;
    const tgtAct = _store.eventById[edge.target]?.activity;
    if (!srcAct || !tgtAct) return;
    if (activities && (!activities.has(srcAct) || !activities.has(tgtAct))) return;
    const type = entity.primary_type;
    if (!dfByType[type]) dfByType[type] = {};
    const key = `${srcAct}\x00${tgtAct}`;
    dfByType[type][key] = (dfByType[type][key] ?? 0) + 1;
  });
  entityTypes.forEach(type => {
    bandsByType[type].dfEdges = Object.entries(dfByType[type] ?? {})
      .map(([key, count]) => { const [source, target] = key.split("\x00"); return { source, target, count }; })
      .sort((a, b) => b.count - a.count)
      .slice(0, 28);
  });

  // Cross-type sync arcs: events correlated to 2+ entity types
  const syncMap = {};
  filteredEvents.forEach(event => {
    const types = [...new Set(event.memberships.map(m => m.entity_type))].sort();
    if (types.length < 2) return;
    for (let i = 0; i < types.length; i++) {
      for (let j = i + 1; j < types.length; j++) {
        const key = `${event.activity}\x00${types[i]}\x00${types[j]}`;
        if (!syncMap[key]) syncMap[key] = { activity: event.activity, type1: types[i], type2: types[j], count: 0 };
        syncMap[key].count++;
      }
    }
  });

  const allTimes = filteredEvents.map(e => e.date?.getTime()).filter(Number.isFinite);
  return {
    entityTypes,
    bandsByType,
    syncArcs: Object.values(syncMap).sort((a, b) => b.count - a.count).slice(0, 48),
    minTime: allTimes.length ? Math.min(...allTimes) : 0,
    maxTime: allTimes.length ? Math.max(...allTimes) : 1,
    totalEvents: filteredEvents.length,
    caseType: _store.caseType,
    itemType: _store.itemType,
  };
}

export function getSharedEventOverview({ activities = null, limit = 10, minSharedEntities = 2, dateFrom = null, dateTo = null } = {}) {
  if (!_store) return { totalSharedEvents: 0, topActivities: [], topEntityEvents: [], topTypePairs: [] };
  const allFiltered = _filterEvents(_store.events, { activities, dateFrom, dateTo });
  const sharedEvents = allFiltered.filter(event => event.entity_ids.length >= minSharedEntities);
  const topActivities = getGlobalSharedEventHotspots({ activities, sortBy: "frequency", minSharedEntities, dateFrom, dateTo }).slice(0, limit);
  const typePairCounts = new Map();
  sharedEvents.forEach(event => {
    const types = [...new Set(event.memberships.map(membership => membership.entity_type))].sort();
    for (let i = 0; i < types.length; i++) {
      for (let j = i + 1; j < types.length; j++) {
        const key = `${types[i]} -> ${types[j]}`;
        if (!typePairCounts.has(key)) typePairCounts.set(key, { pair: key, eventIds: new Set(), entityIds: new Set() });
        const entry = typePairCounts.get(key);
        entry.eventIds.add(event.event_id);
        event.memberships
          .filter(membership => membership.entity_type === types[i] || membership.entity_type === types[j])
          .forEach(membership => entry.entityIds.add(membership.entity_id));
      }
    }
  });
  const topTypePairs = [...typePairCounts.values()]
    .map(entry => ({
      pair: entry.pair,
      eventCount: entry.eventIds.size,
      entityCount: entry.entityIds.size,
    }))
    .sort((a, b) => b.eventCount - a.eventCount || b.entityCount - a.entityCount || a.pair.localeCompare(b.pair))
    .slice(0, limit);
  const _seenTypeSets = new Set();
  const topEntityEvents = sharedEvents
    .map(event => ({
      eventId: event.event_id,
      activity: event.activity,
      color: _store.activityColorByName[event.activity] ?? "#64748b",
      entityCount: event.entity_ids.length,
      entityTypes: [...new Set(event.memberships.map(membership => membership.entity_type))].sort(),
      timestamp: event.date,
      entityPreview: event.entity_ids.slice(0, 4),
    }))
    .sort((a, b) => b.entityCount - a.entityCount || (a.timestamp?.getTime?.() ?? 0) - (b.timestamp?.getTime?.() ?? 0) || a.eventId.localeCompare(b.eventId))
    .filter(ev => {
      const key = ev.entityTypes.join("|");
      if (_seenTypeSets.has(key)) return false;
      _seenTypeSets.add(key);
      return true;
    })
    .slice(0, limit);

  return {
    totalSharedEvents: sharedEvents.length,
    totalSharedEntities: new Set(sharedEvents.flatMap(event => event.entity_ids)).size,
    topActivities,
    topEntityEvents,
    topTypePairs,
  };
}

export function getEntitiesForHotspot(hotspotId, { maxEntities = 8, dateFrom = null, dateTo = null, focusType = null } = {}) {
  if (!_store) return [];
  const activity = hotspotId.startsWith("act:") ? hotspotId.slice(4) : hotspotId;
  // Apply date filter so only events in the active time window are used.
  const filteredPool = _filterEvents(_store.events, { activities: new Set([activity]), dateFrom, dateTo });
  const sharedEvents = filteredPool.filter(e => e.entity_ids.length > 2);
  const entityCounts = {};
  sharedEvents.forEach(e => {
    e.entity_ids.forEach(id => { entityCounts[id] = (entityCounts[id] ?? 0) + 1; });
  });
  const sorted = Object.entries(entityCounts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([id]) => id);
  if (!sorted.length) return [];
  // If a focus type is provided, prefer an entity of that type as the anchor
  // so T4 opens centred on the type the user had in focus in T1.
  const focusTypeCandidates = focusType
    ? sorted.filter(id => _store.entityById[id]?.primary_type === focusType)
    : [];
  const anchor = focusTypeCandidates[0] ?? sorted[0];
  const anchorType = _store.entityById[anchor]?.primary_type;
  const rest = sorted.slice(1);
  const byType = {};
  rest.forEach(id => {
    const t = _store.entityById[id]?.primary_type ?? "other";
    if (!byType[t]) byType[t] = [];
    byType[t].push(id);
  });
  const compareIds = [];
  for (const type of Object.keys(byType).filter(t => t !== anchorType)) {
    if (compareIds.length < maxEntities - 1) compareIds.push(byType[type][0]);
  }
  const anchorTypeRest = (byType[anchorType] ?? []).filter(id => id !== anchor);
  for (const id of anchorTypeRest) {
    if (compareIds.length >= maxEntities - 1) break;
    compareIds.push(id);
  }
  for (const type of Object.keys(byType).filter(t => t !== anchorType)) {
    for (const id of byType[type].slice(1)) {
      if (compareIds.length >= maxEntities - 1) break;
      if (!compareIds.includes(id)) compareIds.push(id);
    }
  }
  return [anchor, ...compareIds];
}

function _buildEntityList(entities, eventsByEntityId) {
  return [...entities]
    .map(entity => ({
      id: entity.entity_id,
      label: _entityLabel(entity),
      type: entity.primary_type,
      eventCount: (eventsByEntityId[entity.entity_id] ?? []).length,
    }))
    .sort((a, b) => a.type.localeCompare(b.type) || b.eventCount - a.eventCount || a.label.localeCompare(b.label));
}

function _resolveDetailFocusScope(anchorEntity, filteredSeedEvents, seedEventIds) {
  if (!_store?.itemType || !_store?.caseType) return null;
  const isItemAnchor = anchorEntity.primary_type === _store.itemType;
  const isCaseAnchor = anchorEntity.primary_type === _store.caseType;
  if (!isItemAnchor && !isCaseAnchor) return null;

  const contextEntityIds = new Set([anchorEntity.entity_id]);
  filteredSeedEvents.forEach(event => {
    (event.memberships ?? []).forEach(membership => {
      if (membership.entity_id === anchorEntity.entity_id) {
        contextEntityIds.add(membership.entity_id);
      } else if (isItemAnchor && membership.entity_type === _store.caseType) {
        contextEntityIds.add(membership.entity_id);
      } else if (isCaseAnchor && membership.entity_type === _store.itemType) {
        contextEntityIds.add(membership.entity_id);
      }
    });
  });

  return {
    scope: isItemAnchor ? "item-focus" : "case-focus",
    contextEntityIds,
    visibleEventIds: new Set(seedEventIds),
  };
}

function _resolveCompareEntityIds(anchorEntity, explicitIds, compareMode, limit) {
  const explicit = [...new Set((explicitIds ?? []).filter(id =>
    _store.entityById[id]?.primary_type === anchorEntity.primary_type && id !== anchorEntity.entity_id
  ))];
  if (explicit.length) return explicit;
  if (!compareMode) return [];
  return _pickPeerEntities(anchorEntity.entity_id, anchorEntity.primary_type, limit - 1);
}

function _pickPeerEntities(anchorEntityId, entityType, limit) {
  const anchorEvents = _store.eventsByEntityId[anchorEntityId] ?? [];
  const anchorCounts = _countBy(anchorEvents, event => event.activity);
  const candidates = (_store.entityIdsByType[entityType] ?? [])
    .filter(entityId => entityId !== anchorEntityId)
    .map(entityId => {
      const events = _store.eventsByEntityId[entityId] ?? [];
      return {
        entityId,
        score: _cosineSimilarity(anchorCounts, _countBy(events, event => event.activity)),
        eventCount: events.length,
      };
    })
    .sort((a, b) => b.score - a.score || b.eventCount - a.eventCount || a.entityId.localeCompare(b.entityId));
  return candidates.slice(0, Math.max(limit, 0)).map(candidate => candidate.entityId);
}

function _resolveDetailTypeOrder(_datasetName, contextEntityIds) {
  const preferred = _store.typeRegistry?.orderedNames ?? [];
  const available = new Set([...contextEntityIds].map(id => _store.entityById[id]?.primary_type).filter(Boolean));
  return [...preferred.filter(t => available.has(t)), ...[...available].filter(t => !preferred.includes(t))];
}

function _sortDetailEntityIds(type, entityIds, anchorEntityId, compareEntityIds) {
  const compareSet = new Set(compareEntityIds);
  return [...entityIds].sort((a, b) => {
    const aPriority = a === anchorEntityId ? 0 : compareSet.has(a) ? 1 : 2;
    const bPriority = b === anchorEntityId ? 0 : compareSet.has(b) ? 1 : 2;
    if (aPriority !== bPriority) return aPriority - bPriority;
    const aEvents = (_store.eventsByEntityId[a] ?? []).length;
    const bEvents = (_store.eventsByEntityId[b] ?? []).length;
    return bEvents - aEvents || _entityLabel(_store.entityById[a]).localeCompare(_entityLabel(_store.entityById[b]));
  });
}

function _limitEntityIds(type, sortedIds, limit, anchorEntityId, compareEntityIds) {
  const keep = [];
  const mustKeep = new Set([anchorEntityId, ...compareEntityIds].filter(entityId => _store.entityById[entityId]?.primary_type === type));
  sortedIds.forEach(entityId => {
    if (mustKeep.has(entityId) || keep.length < limit) keep.push(entityId);
  });
  return [...new Set(keep)];
}

function _buildLane(entityId, filters) {
  const entity = _store.entityById[entityId];
  const events = _filterEvents(_store.eventsByEntityId[entityId] ?? [], filters).sort(_compareEvents);
  const dfEdges = (_store.dfByEntityId[entityId] ?? [])
    .filter(edge => events.some(event => event.event_id === edge.source_event_id) && events.some(event => event.event_id === edge.target_event_id))
    .map(edge => ({
      ...edge,
      gapHours: _hoursBetween(_store.eventById[edge.source_event_id]?.date, _store.eventById[edge.target_event_id]?.date),
      isBottleneck: false,
    }));
  const traced = _traceEntityPath(events, dfEdges, _store.eventById);
  const eventById = Object.fromEntries(events.map(event => [event.event_id, event]));
  const sequence = traced.eventIds.map(eventId => eventById[eventId]?.activity).filter(Boolean);
  const relationEdges = (_store.relationsByEntityId[entityId] ?? [])
    .filter(edge => _store.entityById[edge.source_entity_id] && _store.entityById[edge.target_entity_id]);
  return {
    entity_id: entity.entity_id,
    entityType: entity.primary_type,
    entityLabel: _entityLabel(entity),
    entity,
    events,
    eventIds: events.map(event => event.event_id),
    dfEdges,
    relationEdges,
    sequence,
    attrs: entity.properties || {},
    eventCount: events.length,
  };
}

function _buildEventAnchor(eventId, visibleEntityIds) {
  const event = _store.eventById[eventId];
  if (!event) return null;
  const memberships = (event.memberships ?? []).filter(membership => visibleEntityIds.has(membership.entity_id));
  if (!memberships.length) return null;
  const sharedEntityIds = memberships.map(membership => membership.entity_id);
  const sharedEntityTypes = [...new Set(memberships.map(membership => membership.entity_type))];
  // Preserve the raw entity count from the data layer before any view-filtering.
  // The view-filtered sharedEntityIds can be smaller when maxEntitiesPerType clips
  // how many entities are loaded into the current graph, but the event itself
  // participates in more (or different) entities in the full dataset.
  const totalEntityCount = event.entity_ids?.length ?? sharedEntityIds.length;
  const totalEntityTypes = [...new Set((event.memberships ?? []).map(m => m.entity_type))];
  return {
    ...event,
    memberships,
    sharedEntityIds,
    sharedEntityTypes,
    totalEntityCount,
    totalEntityTypes,
    isSharedEvent: sharedEntityIds.length > 1,
  };
}

function _buildCrossTypeLinks(eventAnchors) {
  return eventAnchors
    .filter(anchor => anchor.sharedEntityIds.length > 1)
    .flatMap(anchor => {
      const memberships = anchor.memberships ?? [];
      const links = [];
      for (let i = 0; i < memberships.length; i++) {
        for (let j = i + 1; j < memberships.length; j++) {
          links.push({
            id: `${anchor.event_id}__${memberships[i].entity_id}__${memberships[j].entity_id}`,
            event_id: anchor.event_id,
            source_entity_id: memberships[i].entity_id,
            target_entity_id: memberships[j].entity_id,
            source_entity_type: memberships[i].entity_type,
            target_entity_type: memberships[j].entity_type,
          });
        }
      }
      return links;
    });
}

function _analyzeBandPatterns(band, anchorType, anchorEntityId, compareEntityIds) {
  const compareSet = band.entityType === anchorType
    ? new Set([anchorEntityId, ...compareEntityIds].filter(entityId => band.lanes.some(lane => lane.entity_id === entityId)))
    : new Set(band.lanes.map(lane => lane.entity_id));

  const sequenceCounts = new Map();
  const sequenceByEntityId = {};
  const comparedSequenceCount = band.lanes.filter(lane => compareSet.has(lane.entity_id) && lane.sequence.length).length;
  band.lanes.forEach(lane => {
    const key = JSON.stringify(lane.sequence ?? []);
    if (compareSet.has(lane.entity_id) && lane.sequence.length) {
      sequenceCounts.set(key, (sequenceCounts.get(key) ?? 0) + 1);
    }
    sequenceByEntityId[lane.entity_id] = {
      sequence: lane.sequence,
      followsDominant: false,
      dominanceState: "neutral",
    };
  });

  const dominantKey = [...sequenceCounts.entries()]
    .sort((a, b) => b[1] - a[1] || JSON.parse(b[0]).length - JSON.parse(a[0]).length || a[0].localeCompare(b[0]))[0]?.[0] ?? "[]";
  const dominantSupport = sequenceCounts.get(dominantKey) ?? 0;
  const hasDominantPattern = dominantSupport >= 2;
  const dominantSequence = hasDominantPattern ? JSON.parse(dominantKey) : [];
  Object.keys(sequenceByEntityId).forEach(entityId => {
    const sequence = sequenceByEntityId[entityId].sequence ?? [];
    const isCompared = compareSet.has(entityId);
    const matchesDominant = hasDominantPattern && sequence.length > 0 && _sameSequence(sequence, dominantSequence);
    sequenceByEntityId[entityId].followsDominant = matchesDominant;
    sequenceByEntityId[entityId].dominanceState = !isCompared || !sequence.length
      ? "neutral"
      : matchesDominant
        ? "dominant"
        : hasDominantPattern
          ? "deviant"
          : "neutral";
  });

  return {
    dominantSequence,
    dominantSupport,
    comparedSequenceCount,
    hasDominantPattern,
    sequenceByEntityId,
    compareSet,
  };
}

function _annotateBottlenecks(bands, eventById) {
  const edges = bands.flatMap(band => band.lanes.flatMap(lane => lane.dfEdges)).filter(edge => Number.isFinite(edge.gapHours));
  const threshold = _quantile(edges.map(edge => edge.gapHours), 0.75);
  bands.forEach(band => {
    band.lanes.forEach(lane => {
      lane.dfEdges = lane.dfEdges.map(edge => ({
        ...edge,
        isBottleneck: Number.isFinite(threshold) && edge.gapHours > threshold,
        sourceActivity: eventById[edge.source_event_id]?.activity ?? edge.source_event_id,
        targetActivity: eventById[edge.target_event_id]?.activity ?? edge.target_event_id,
      }));
    });
  });
  return threshold;
}

function _summarizeDetailGraph(bands, eventAnchors, relations, anchorEntity, compareEntityIds, bottleneckThresholdHours) {
  const sharedEvents = eventAnchors.filter(anchor => anchor.sharedEntityIds.length > 1);
  const anchorBand = bands.find(band => band.entityType === anchorEntity.primary_type);
  const topBottlenecks = bands
    .flatMap(band => band.lanes.flatMap(lane => lane.dfEdges.map(edge => ({ ...edge, entityType: band.entityType, entityId: lane.entity_id }))))
    .filter(edge => edge.isBottleneck)
    .sort((a, b) => b.gapHours - a.gapHours)
    .slice(0, 5);

  return {
    anchorEntityId: anchorEntity.entity_id,
    anchorEntityType: anchorEntity.primary_type,
    visibleEntityTypeCount: bands.length,
    visibleEntityCount: bands.reduce((sum, band) => sum + band.lanes.length, 0),
    eventCount: eventAnchors.length,
    relationCount: relations.length,
    sharedEventCount: sharedEvents.length,
    compareEntityCount: compareEntityIds.length,
    dominantFlow: anchorBand?.hasDominantPattern ? (anchorBand?.dominantSequence ?? []) : [],
    hasDominantPattern: anchorBand?.hasDominantPattern ?? false,
    dominantSupport: anchorBand?.dominantSupport ?? 0,
    comparedSequenceCount: anchorBand?.comparedSequenceCount ?? 0,
    deviationCount: anchorBand?.hasDominantPattern
      ? (anchorBand?.lanes.filter(lane => lane.isCompared && lane.dominanceState === "deviant").length ?? 0)
      : 0,
    parallelEntityTypes: bands
      .filter(band => band.entityType !== anchorEntity.primary_type && band.lanes.some(lane => lane.eventCount > 0))
      .map(band => ({ entityType: band.entityType, count: band.lanes.length })),
    topBottlenecks,
    sharedEventHotspots: sharedEvents
      .sort((a, b) => b.sharedEntityIds.length - a.sharedEntityIds.length || _compareEvents(a, b))
      .slice(0, 5)
      .map(anchor => ({
        event_id: anchor.event_id,
        activity: anchor.activity,
        entityCount: anchor.sharedEntityIds.length,
        entityTypes: anchor.sharedEntityTypes,
      })),
    bottleneckThresholdHours,
  };
}

function _collectItemSequences(filters = {}) {
  const itemIds = (_store.entityIdsByType[_store.itemType] ?? []).filter(entityId => !filters.itemIds || filters.itemIds.has(entityId));
  return itemIds.map(entityId => {
    const events = _filterEvents(_store.eventsByItemId[entityId] ?? [], filters).sort(_compareEvents);
    if (!events.length) return null;
    const eventById = Object.fromEntries(events.map(event => [event.event_id, event]));
    const dfEdges = (_store.dfByEntityId[entityId] ?? []).filter(edge => eventById[edge.source_event_id] && eventById[edge.target_event_id]);
    const traced = _traceEntityPath(events, dfEdges, eventById);
    const sequence = traced.eventIds.map(eventId => eventById[eventId]?.activity).filter(Boolean);
    if (!_sequencePassesActivityFilter(sequence, filters.activities)) return null;
    return { entityId, caseId: events[0]?.case_entity_id ?? null, sequence, eventIds: traced.eventIds };
  }).filter(Boolean);
}

// Centralised event filter — single chokepoint for activity, resource, date
// window AND invalid-date exclusion. By default any event whose date is not a
// finite millisecond is dropped, because none of the time-aligned views can
// position it sensibly on the axis. Callers that genuinely want them (e.g.,
// a "data quality" listing in the inspector) can opt back in with
// `{ includeInvalidDates: true }`.
function _filterEvents(events, filters = {}) {
  const {
    activities = null, resource = null, dateFrom = null, dateTo = null,
    includeInvalidDates = false,
  } = filters;
  let out = events;
  if (!includeInvalidDates) out = out.filter(_hasValidDate);
  if (activities && activities.size > 0) out = out.filter(event => activities.has(event.activity));
  else if (activities && activities.size === 0) out = [];
  if (resource) out = out.filter(event => event.resource_labels?.includes(resource) || event.org_resource === resource);
  if (dateFrom) { const from = new Date(dateFrom); out = out.filter(event => event.date >= from); }
  if (dateTo) { const to = new Date(dateTo); out = out.filter(event => event.date <= to); }
  return out;
}

function _hasValidDate(event) {
  return event?.date instanceof Date && Number.isFinite(event.date.getTime());
}

// Public helper so callers (e.g., screens/ekg.js or T2 Identify's status bar)
// can list the events that got excluded. Returns a lightweight summary —
// caller can drill into _store.eventById[event_id] for the full payload.
export function listInvalidDateEvents({ limit = 50 } = {}) {
  if (!_store) return [];
  return _store.events
    .filter(e => !_hasValidDate(e))
    .slice(0, limit)
    .map(e => ({
      event_id: e.event_id,
      activity: e.activity,
      timestamp: e.timestamp,
      entity_ids: e.entity_ids,
    }));
}

export function getInvalidEventCount() {
  if (!_store) return 0;
  return _store.invalidEventCount ?? 0;
}

function _buildCaseSummaries(caseList, eventsByCaseId, itemIdsByCaseId) {
  const summaries = {};
  caseList.forEach(item => {
    const events = [...(eventsByCaseId[item.id] ?? [])].sort(_compareEvents);
    const attrs = _pickStableEntityAttrs(events[0], ["vendorName", "documentType", "Company", "Source"]);
    const displayAttrs = _pickStableContextAttrs(events);
    const resources = [...new Set(events.flatMap(event => event.resource_labels ?? []).filter(_isMeaningfulResource))].sort((a, b) => a.localeCompare(b));
    const activityCounts = _countBy(events, event => event.activity);
    const topActivities = Object.entries(activityCounts)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 3)
      .map(([activity, count]) => ({ activity, count }));
    summaries[item.id] = {
      id: item.id,
      attrs,
      displayAttrs,
      attrKeys: Object.keys(displayAttrs),
      itemCount: itemIdsByCaseId[item.id]?.size ?? 0,
      eventCount: events.length,
      firstDate: events[0]?.date ?? null,
      lastDate: events.at(-1)?.date ?? null,
      centerTime: _caseCenterTime(events[0]?.date ?? null, events.at(-1)?.date ?? null),
      resources,
      resourceCount: resources.length,
      topResources: resources.slice(0, 3),
      activityCounts,
      topActivities,
      contextTokens: Object.entries(displayAttrs).map(([k, v]) => `${k}:${v}`),
      overviewDisplayAttrs: displayAttrs,
      overviewAttrKeys: Object.keys(displayAttrs),
      overviewResources: resources,
      overviewResourceCount: resources.length,
      overviewTopResources: resources.slice(0, 3),
      overviewContextTokens: Object.entries(displayAttrs).map(([k, v]) => `${k}:${v}`),
    };
  });
  return summaries;
}

function _applyOverviewFeatureSelection(caseSummaryById) {
  const summaries = Object.values(caseSummaryById ?? {});
  const caseCount = summaries.length;
  if (!caseCount) return;
  const resourceCaseFreq = _countDocumentFrequency(summaries.map(summary => summary.resources));
  const contextCaseFreq = _countDocumentFrequency(summaries.map(summary => summary.contextTokens));
  summaries.forEach(summary => {
    const overviewResources = summary.resources.filter(resource => _isInformativeOverviewValue(resource, resourceCaseFreq[resource] ?? 0, caseCount));
    const overviewContextTokens = summary.contextTokens.filter(token => _isInformativeOverviewToken(token, contextCaseFreq[token] ?? 0, caseCount));
    const overviewDisplayAttrs = Object.fromEntries(
      Object.entries(summary.displayAttrs ?? {}).filter(([key, value]) => overviewContextTokens.includes(`${key}:${value}`))
    );
    summary.overviewResources = overviewResources;
    summary.overviewResourceCount = overviewResources.length;
    summary.overviewTopResources = overviewResources.slice(0, 3);
    summary.overviewContextTokens = overviewContextTokens;
    summary.overviewDisplayAttrs = overviewDisplayAttrs;
    summary.overviewAttrKeys = Object.keys(overviewDisplayAttrs);
  });
}

function _buildOverviewRelations(caseSummaryById) {
  const summaries = Object.values(caseSummaryById).sort((a, b) => a.id.localeCompare(b.id));
  const datasetStart = Math.min(...summaries.map(summary => summary.firstDate?.getTime() ?? Infinity));
  const datasetEnd = Math.max(...summaries.map(summary => summary.lastDate?.getTime() ?? -Infinity));
  const timelineSpan = Number.isFinite(datasetStart) && Number.isFinite(datasetEnd)
    ? Math.max(datasetEnd - datasetStart, 1)
    : 1;
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
      const topSource = (rankedByNode[edge.source] ?? []).slice(0, OVERVIEW_KNN);
      const topTarget = (rankedByNode[edge.target] ?? []).slice(0, OVERVIEW_KNN);
      return topSource.includes(edge) || topTarget.includes(edge);
    })
    .sort((a, b) => b.weight - a.weight || a.source.localeCompare(b.source) || a.target.localeCompare(b.target));
}

function _buildOverviewCommunities(caseSummaryById, edges) {
  const summaries = Object.values(caseSummaryById);
  const adjacency = {};
  const weightedDegreeById = Object.fromEntries(summaries.map(summary => [summary.id, 0]));
  edges.forEach(edge => {
    if (!adjacency[edge.source]) adjacency[edge.source] = [];
    if (!adjacency[edge.target]) adjacency[edge.target] = [];
    adjacency[edge.source].push({ id: edge.target, weight: edge.weight });
    adjacency[edge.target].push({ id: edge.source, weight: edge.weight });
    weightedDegreeById[edge.source] += edge.weight;
    weightedDegreeById[edge.target] += edge.weight;
  });

  const labels = Object.fromEntries(summaries.map(summary => [summary.id, summary.id]));
  const order = [...summaries].sort((a, b) => (weightedDegreeById[b.id] ?? 0) - (weightedDegreeById[a.id] ?? 0) || a.id.localeCompare(b.id));

  for (let iter = 0; iter < 16; iter++) {
    let changed = false;
    order.forEach(summary => {
      const neighbors = adjacency[summary.id] ?? [];
      if (!neighbors.length) return;
      const scores = {};
      neighbors.forEach(neighbor => {
        scores[labels[neighbor.id]] = (scores[labels[neighbor.id]] ?? 0) + neighbor.weight;
      });
      const best = Object.entries(scores).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
      if (best && best !== labels[summary.id]) {
        labels[summary.id] = best;
        changed = true;
      }
    });
    if (!changed) break;
  }

  const groups = Object.values(summaries.reduce((acc, summary) => {
    const label = labels[summary.id];
    if (!acc[label]) acc[label] = { sourceLabel: label, nodeIds: [] };
    acc[label].nodeIds.push(summary.id);
    return acc;
  }, {})).sort((a, b) => b.nodeIds.length - a.nodeIds.length || a.sourceLabel.localeCompare(b.sourceLabel));

  const communities = groups.map((group, index) => {
    const members = group.nodeIds.map(id => caseSummaryById[id]).filter(Boolean);
    const activityTotals = {};
    members.forEach(member => {
      Object.entries(member.activityCounts).forEach(([activity, count]) => {
        activityTotals[activity] = (activityTotals[activity] ?? 0) + count;
      });
    });
    const hint = Object.entries(activityTotals)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, OVERVIEW_LABEL_ACTIVITY_COUNT)
      .map(([activity]) => activity)
      .join(" / ");
    const code = `Community ${String(index + 1).padStart(2, "0")}`;
    return {
      id: `community-${String(index + 1).padStart(2, "0")}`,
      code,
      label: hint || code,
      hint: hint ? code : "",
      nodeIds: group.nodeIds,
    };
  });

  const labelFreq = {};
  communities.forEach(community => { labelFreq[community.label] = (labelFreq[community.label] ?? 0) + 1; });
  const labelSeq = {};
  communities.forEach(community => {
    if ((labelFreq[community.label] ?? 1) > 1) {
      labelSeq[community.label] = (labelSeq[community.label] ?? 0) + 1;
      community.label = `${community.label} ${String.fromCharCode(64 + labelSeq[community.label])}`;
    }
  });

  const communityByCaseId = {};
  communities.forEach(community => {
    community.nodeIds.forEach(id => {
      communityByCaseId[id] = { ...community, weightedDegree: weightedDegreeById[id] ?? 0 };
    });
  });

  return { communities, communityByCaseId };
}

function _buildFilteredSummaries(caseSummaryById, eventsByCaseId, activities) {
  const filtered = {};
  Object.entries(caseSummaryById).forEach(([id, summary]) => {
    const events = (eventsByCaseId[id] ?? []).filter(event => activities.has(event.activity));
    filtered[id] = { ...summary, activityCounts: _countBy(events, event => event.activity) };
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
  if (ctxSim >= 0.2) reasons.push(_sharedValueReason("shared context", a.overviewContextTokens, b.overviewContextTokens, token => token.replace(":", " = ")));
  if (timeSim >= 0.55) reasons.push("close in time");
  if (sizeSim >= 0.75) reasons.push("similar case size");
  return {
    id: `${a.id}__${b.id}`,
    source: a.id,
    target: b.id,
    weight,
    reasons: reasons.slice(0, 3),
    components: { actSim, resSim, ctxSim, timeSim, sizeSim },
  };
}

function _traceEntityPath(events, edges, eventById) {
  const predecessorIds = {};
  const successorIds = {};
  const nodeIds = new Set(events.map(event => event.event_id ?? event.id));
  edges.forEach(edge => {
    nodeIds.add(edge.source_event_id ?? edge.source);
    nodeIds.add(edge.target_event_id ?? edge.target);
    const sourceId = edge.source_event_id ?? edge.source;
    const targetId = edge.target_event_id ?? edge.target;
    if (!successorIds[sourceId]) successorIds[sourceId] = [];
    if (!predecessorIds[targetId]) predecessorIds[targetId] = [];
    successorIds[sourceId].push(targetId);
    predecessorIds[targetId].push(sourceId);
  });

  const nodes = [...nodeIds].filter(id => eventById[id]).sort(_compareEventIds(eventById));
  const starts = nodes.filter(id => (predecessorIds[id] ?? []).length === 0);
  const orderedStarts = (starts.length ? starts : nodes).sort(_compareEventIds(eventById));
  const visited = new Set();
  const orderedEventIds = [];
  const queue = [...orderedStarts];

  while (queue.length) {
    let current = queue.shift();
    while (current && !visited.has(current)) {
      orderedEventIds.push(current);
      visited.add(current);
      const nextIds = [...new Set(successorIds[current] ?? [])]
        .filter(id => !visited.has(id))
        .sort(_compareEventIds(eventById));
      if (nextIds.length <= 1) {
        current = nextIds[0] ?? null;
        continue;
      }
      queue.unshift(...nextIds.slice(1));
      current = nextIds[0];
    }
  }

  nodes.forEach(id => {
    if (!visited.has(id)) orderedEventIds.push(id);
  });

  return { eventIds: orderedEventIds };
}

function _sequencePassesActivityFilter(sequence, activities) {
  if (!activities) return true;
  return (sequence ?? []).every(activity => activities.has(activity));
}

function _entityLabel(entity) {
  if (!entity) return "";
  return entity.properties?.title
    || entity.properties?.vendorName
    || entity.properties?.name
    || entity.properties?.sysId
    || entity.entity_id;
}

function _labelizeType(type) {
  return String(type ?? "").replaceAll("_", " ");
}

function _pickStableEntityAttrs(entityLike, keys) {
  if (!entityLike) return {};
  return Object.fromEntries(
    keys
      .filter(key => entityLike[key] !== undefined && entityLike[key] !== null && entityLike[key] !== "")
      .map(key => [key, entityLike[key]])
  );
}

function _pickStableContextAttrs(events) {
  if (!events?.length) return {};
  const keys = Object.keys(events[0]).filter(_isStableContextKey);
  const stable = [];
  keys.forEach(key => {
    const values = [...new Set(events.map(event => event[key]).filter(value => value !== undefined && value !== null && value !== ""))];
    if (values.length === 1) stable.push([key, values[0]]);
  });
  stable.sort((a, b) => String(a[1]).length - String(b[1]).length || a[0].localeCompare(b[0]));
  return Object.fromEntries(stable);
}

function _isStableContextKey(key) {
  if (!key) return false;
  const normalized = key.toLowerCase();
  return ![
    "activity", "timestamp", "date", "memberships", "entity_ids", "entity_ids_by_type",
    "resource_labels", "resource_entity_ids", "primary_resource_label", "case_entity_id",
    "item_entity_id", "event_id", "id", "activitycolor", "resourcecolor",
  ].includes(normalized) && !normalized.endsWith("_id");
}

function _isMeaningfulResource(value) {
  if (value === undefined || value === null) return false;
  const normalized = String(value).trim();
  return normalized !== "" && normalized.toUpperCase() !== "NONE";
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
  const normalized = String(value).trim();
  if (!normalized) return false;
  const lower = normalized.toLowerCase();
  if (["none", "unknown", "n/a", "na", "null"].includes(lower)) return false;
  if (/^[a-z][a-z0-9]*_0+$/i.test(normalized) || /^[a-z][a-z0-9]*id_0+$/i.test(normalized) || /^0+$/.test(normalized)) return false;
  return true;
}

function _countDocumentFrequency(valueLists) {
  const counts = {};
  (valueLists ?? []).forEach(values => {
    [...new Set(values ?? [])].forEach(value => {
      counts[value] = (counts[value] ?? 0) + 1;
    });
  });
  return counts;
}

function _countBy(items, getKey) {
  return items.reduce((acc, item) => {
    const key = getKey(item);
    if (!key) return acc;
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
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
  let dot = 0;
  let magA = 0;
  let magB = 0;
  keys.forEach(key => {
    const a = aCounts?.[key] ?? 0;
    const b = bCounts?.[key] ?? 0;
    dot += a * b;
    magA += a * a;
    magB += b * b;
  });
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

function _jaccardSimilarity(aVals, bVals) {
  const a = new Set(aVals ?? []);
  const b = new Set(bVals ?? []);
  if (!a.size && !b.size) return 0;
  let inter = 0;
  a.forEach(value => { if (b.has(value)) inter++; });
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

function _sharedValueReason(label, aVals, bVals, fmt = value => value) {
  const bSet = new Set(bVals ?? []);
  const shared = [...new Set(aVals ?? [])].filter(value => bSet.has(value));
  if (!shared.length) return label;
  const preview = shared.slice(0, 2).map(fmt).join(", ");
  return shared.length > 2 ? `${label}: ${preview}, ...` : `${label}: ${preview}`;
}

function _aggregateCommunityResources(nodes) {
  const counts = {};
  nodes.forEach(node => {
    (node.resources ?? []).forEach(resource => {
      counts[resource] = (counts[resource] ?? 0) + 1;
    });
  });
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([resource, count]) => ({
      id: `resource:${resource}`,
      type: "resource",
      label: resource,
      shortLabel: _shortToken(resource, 12),
      count,
    }));
}

function _aggregateCommunityAttrs(nodes) {
  const counts = {};
  nodes.forEach(node => {
    Object.entries(node.displayAttrs ?? {}).forEach(([key, value]) => {
      const token = `${key}:${value}`;
      if (!counts[token]) {
        counts[token] = {
          id: `attr:${token}`,
          type: "attribute",
          key,
          value,
          label: `${_labelizeKey(key)}=${value}`,
          shortLabel: `${_labelizeKey(key)}=${_shortToken(value, 14)}`,
          count: 0,
        };
      }
      counts[token].count += 1;
    });
  });
  return Object.values(counts).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

function _buildCommunityEdges(edges, nodes) {
  const communityByNode = Object.fromEntries(nodes.map(node => [node.id, node.clusterKey]));
  const map = new Map();
  edges.forEach(edge => {
    const sourceCommunity = communityByNode[edge.source];
    const targetCommunity = communityByNode[edge.target];
    if (!sourceCommunity || !targetCommunity || sourceCommunity === targetCommunity) return;
    const [source, target] = sourceCommunity < targetCommunity
      ? [sourceCommunity, targetCommunity]
      : [targetCommunity, sourceCommunity];
    const key = `${source}__${target}`;
    if (!map.has(key)) map.set(key, { id: key, source, target, weight: 0, count: 0 });
    const agg = map.get(key);
    agg.weight += edge.weight;
    agg.count += 1;
  });
  return [...map.values()].sort((a, b) => b.weight - a.weight || a.source.localeCompare(b.source));
}

function _buildColorMap(values, palette, fallback = null) {
  const map = {};
  values.forEach((value, index) => {
    map[value] = palette[index] ?? fallback ?? _hashColor(value);
  });
  return map;
}

function _hashColor(value) {
  let hash = 0;
  const text = String(value ?? "");
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) - hash) + text.charCodeAt(i);
  return `hsl(${Math.abs(hash) % 360} 62% 46%)`;
}

function _labelizeKey(key) {
  return String(key ?? "").replaceAll("_", " ");
}

function _shortToken(value, maxChars = 14) {
  const text = String(value ?? "");
  return text.length > maxChars ? `${text.slice(0, maxChars - 3)}...` : text;
}

function _compareEvents(a, b) {
  return (a?.date?.getTime?.() ?? 0) - (b?.date?.getTime?.() ?? 0)
    || String(a?.event_id ?? a?.id ?? "").localeCompare(String(b?.event_id ?? b?.id ?? ""));
}

function _compareEventIds(eventById) {
  return (a, b) => _compareEvents(eventById[a], eventById[b]);
}

function _hoursBetween(a, b) {
  if (!(a instanceof Date) || Number.isNaN(a.getTime()) || !(b instanceof Date) || Number.isNaN(b.getTime())) return 0;
  return Math.max((b.getTime() - a.getTime()) / (1000 * 60 * 60), 0);
}

function _quantile(values, q) {
  const sorted = [...(values ?? [])].filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return NaN;
  if (sorted.length === 1) return sorted[0];
  const idx = (sorted.length - 1) * q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] * (1 - (idx - lo)) + sorted[hi] * (idx - lo);
}

function _sameSequence(a, b) {
  return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
}
