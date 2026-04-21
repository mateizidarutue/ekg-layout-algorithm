"use strict";

import { loadDataset, datasetUrl, datasetFromQuery } from "./data/loader.js";
import { buildStore, getStore, getOverviewGraph, getVariantOverview, getActivityDfGraph, getDetailGraph } from "./data/store.js";
import { computeDetailLayout } from "./layout/detailLayout.js";
import { computeOverviewNetworkLayout, computeVariantLayout, computeDfGraphLayout } from "./layout/overviewLayout.js";
import { drawDetailView } from "./render/detailRender.js";
import { drawOverviewNetwork, drawVariantOverview } from "./render/overviewRender.js";
import { addMarkers, wheelDelta, computeFitTransform, clusterColor, formatPercent, ZOOM_MIN_SCALE, ZOOM_MAX_SCALE, CAMERA_EASE_MS } from "./render/shared.js";

let svg, gRoot, zoom, currentTransform;
const vis = { df: true, corr: true, relations: true, sync: true, bottleneck: true };
const opa = { df: 0.78, corr: 0.22, relations: 0.4 };
const KEYBOARD_PAN_SPEED = 880;
const KEYBOARD_ZOOM_RATE = 1.75;

let _currentView = "overview";
let _selectedEntityId = null;
let _selectedCommunityId = null;
let _selectedVariantKey = null;
let _detailGraph = null;
let _variantData = null;
let _lastTotalHeight = 0;
let _selection = null;
let _entitySearchQuery = "";
let _lastListKey = null;
let _resizeTimer = null;
let _detailReturnContext = { view: "overview", communityId: null, variantKey: null };
let _keyboardCameraKeys = new Set();
let _keyboardCameraFrame = null;
let _keyboardCameraLastTs = 0;
let _filters = {
  activities: null,
  maxEntitiesPerType: 8,
  visibleEntityTypes: null,
  sharedOnly: false,
};

async function init() {
  const svgEl = document.getElementById("canvas");
  svg = d3.select(svgEl);
  gRoot = svg.append("g").attr("class", "root");
  currentTransform = d3.zoomIdentity;
  addMarkers(svg.append("defs"));

  zoom = d3.zoom()
    .scaleExtent([ZOOM_MIN_SCALE, ZOOM_MAX_SCALE])
    .wheelDelta(wheelDelta)
    .on("zoom", e => {
      currentTransform = e.transform;
      gRoot.attr("transform", currentTransform);
    });

  svg.call(zoom);
  svg.on("dblclick.zoom", null);
  svg.on("click.selection-clear", ev => {
    if (ev.target === svgEl) _clearSelection();
  });

  _setupTooltip();
  _setupPanel();
  _setupControls();
  _setupCanvasKeyboard();
  _setupSidebarResize();
  _renderLegend();
  window.addEventListener("resize", _handleResize);

  const datasetName = datasetFromQuery("library");
  await _loadDataset(datasetName);
}

async function _loadDataset(name) {
  _showLoading(true);
  _hideDropzone();
  try {
    const bundle = await loadDataset(datasetUrl(name));
    const store = buildStore(bundle);
    _afterLoad(store, name);
  } catch (err) {
    console.error("Failed to load dataset:", err);
    _showDropzone();
  } finally {
    _showLoading(false);
  }
}

function _afterLoad(store, name) {
  _filters.activities = null;
  _filters.maxEntitiesPerType = parseInt(document.getElementById("slider-max-entities")?.value ?? "8", 10);
  _filters.visibleEntityTypes = null;
  _filters.sharedOnly = false;
  _currentView = "overview";
  _selectedEntityId = store.caseList[0]?.id ?? store.entityList[0]?.id ?? null;
  _selectedCommunityId = null;
  _selectedVariantKey = null;
  _detailGraph = null;
  _variantData = null;
  _selection = null;
  _entitySearchQuery = "";
  _lastListKey = null;
  _detailReturnContext = { view: "overview", communityId: null, variantKey: null };

  document.getElementById("dataset-label").textContent = name.toUpperCase();
  const search = document.getElementById("entity-search");
  if (search) {
    search.value = "";
    search.placeholder = `Search ${store.caseType ?? "entity"} / ${store.itemType ?? "entity"} / type...`;
  }
  _syncToggleButtons();
  _buildActivityList(store);
  _renderCurrentView();
  _updateStatusBar(store);
}

function _renderCurrentView() {
  _clearKeyboardCamera();
  gRoot.selectAll("*").remove();
  const lBg = gRoot.append("g").attr("class", "l-bg");
  const lMeta = gRoot.append("g").attr("class", "l-meta");
  const lRel = gRoot.append("g").attr("class", "l-relations");
  const lCorr = gRoot.append("g").attr("class", "l-corr");
  const lDf = gRoot.append("g").attr("class", "l-df");
  const lNodes = gRoot.append("g").attr("class", "l-nodes");
  const lLabels = gRoot.append("g").attr("class", "l-labels");

  const w = svg.node().clientWidth;
  const store = getStore();
  const cb = _makeCallbacks();
  const labels = {
    caseType: store.caseType ?? "Case",
    itemType: store.itemType ?? "Item",
    caseBadge: (store.caseType ?? "CA").slice(0, 2).toUpperCase(),
  };

  if (_currentView === "overview" || _currentView === "community") {
    const overviewGraph = getOverviewGraph({
      activities: _filters.activities,
      communityId: _selectedCommunityId ?? null,
    });
    _variantData = null;
    const layout = computeOverviewNetworkLayout(overviewGraph, w);
    drawOverviewNetwork(layout.network, lBg, lMeta, lNodes, lLabels, vis, cb, labels);
    _lastTotalHeight = layout.totalHeight;
    _applyVisibility();
    _fitToView(_lastTotalHeight);
    _updateOverviewPanels(overviewGraph);
    _updateVariantPanels(null, null);
    _updateDetailPanels(null);
  } else if (_currentView === "variants") {
    const variantData = getVariantOverview({ activities: _filters.activities });
    variantData.variants.forEach(variant => { variant.isSelected = variant.key === _selectedVariantKey; });
    let selectedVariant = variantData.variants.find(variant => variant.key === _selectedVariantKey) ?? null;
    if (_selectedVariantKey && !selectedVariant) {
      _selectedVariantKey = null;
      selectedVariant = null;
    }
    variantData.dfGraph = getActivityDfGraph({ activities: _filters.activities });
    _variantData = variantData;
    const viewportH = svg.node().clientHeight;
    const variantLayout = computeVariantLayout(variantData, w, {
      activityColorByName: store.activityColorByName,
      viewportHeight: viewportH,
    });
    const dfInnerW = Math.max(w - 64, 220);
    const dfInnerH = variantLayout.dfgHeight ?? 200;
    const rawDf = computeDfGraphLayout(variantData.dfGraph, dfInnerW, dfInnerH);
    const dfLayout = {
      ...rawDf,
      x: 32,
      y: variantLayout.totalHeight + 34,
      width: dfInnerW,
      height: dfInnerH,
      nodes: rawDf.nodes.map(n => ({ ...n, x: n.x + 32, y: n.y + variantLayout.totalHeight + 34 })),
      edges: rawDf.edges.map(e => ({
        ...e,
        x1: e.x1 + 32,
        y1: e.y1 + variantLayout.totalHeight + 34,
        x2: e.x2 + 32,
        y2: e.y2 + variantLayout.totalHeight + 34,
        cx: e.cx + 32,
        cy: e.cy + variantLayout.totalHeight + 34,
      })),
    };
    drawVariantOverview(variantLayout, dfLayout, variantData, lBg, lNodes, lLabels, cb);
    _lastTotalHeight = variantLayout.totalHeight + 34 + dfInnerH + 26;
    _fitToView(_lastTotalHeight);
    _updateOverviewPanels(null);
    _updateVariantPanels(variantData, selectedVariant);
    _updateDetailPanels(null);
  } else if (_currentView === "detail" && _selectedEntityId) {
    _detailGraph = getDetailGraph({
      anchorEntityId: _selectedEntityId,
      visibleEntityTypes: _filters.visibleEntityTypes ?? undefined,
      activities: _filters.activities,
      maxEntitiesPerType: _filters.maxEntitiesPerType,
      sharedOnly: _filters.sharedOnly,
    });
    const layout = computeDetailLayout(_detailGraph, w);
    drawDetailView(layout, lBg, lMeta, lRel, lCorr, lMeta, lDf, lNodes, lLabels, vis, cb);
    _lastTotalHeight = layout.totalHeight;
    _applyVisibility();
    _applySelectionState();
    _fitDetailView();
    _updateOverviewPanels(null);
    _updateVariantPanels(null, null);
    _updateDetailPanels(_detailGraph);
    _renderEntityTypeFilters(_detailGraph);
  }

  _updateHeaderTags();
  _updateSidebarList();
  _updateStatusBar(store);
}

function _makeCallbacks() {
  return {
    onTooltipShow: _showTooltip,
    onTooltipHide: _hideTooltip,
    onPoSelect: entityId => _openEntity(entityId),
    onEntitySelect: entityId => _openEntity(entityId),
    onCommunitySelect: communityId => {
      _selectedCommunityId = communityId;
      _currentView = "community";
      _renderCurrentView();
    },
    onVariantSelect: variantKey => _selectVariant(variantKey),
    onEventSelect: d => _toggleSelection({
      kind: "event",
      eventId: d.id,
      relatedEntityIds: d.sharedEntityIds ?? [],
    }),
    onEdgeSelect: d => _toggleSelection({
      kind: "edge",
      edgeId: d.edgeId,
      entityId: d.entityId,
      sourceId: d.sourceId,
      targetId: d.targetId,
    }),
  };
}

function _openEntity(entityId, context = null) {
  _detailReturnContext = context ?? _currentDetailReturnContext();
  _selectedEntityId = entityId;
  _currentView = "detail";
  _selection = null;
  _renderCurrentView();
  _setActiveEntityInList(entityId);
}

function _selectVariant(variantKey) {
  _selectedVariantKey = _selectedVariantKey === variantKey ? null : variantKey;
  _selection = null;
  _renderCurrentView();
}

function _currentDetailReturnContext() {
  if (_currentView === "detail") return _detailReturnContext;
  if (_currentView === "community") {
    return { view: "community", communityId: _selectedCommunityId, variantKey: null };
  }
  if (_currentView === "variants") {
    return { view: "variants", communityId: null, variantKey: _selectedVariantKey };
  }
  return { view: "overview", communityId: null, variantKey: null };
}

function _setupTooltip() {
  const tooltip = document.getElementById("tooltip");
  if (!tooltip) return;
  document.getElementById("canvas-wrap").addEventListener("mouseleave", () => tooltip.classList.remove("show"));
}

function _showTooltip(html, x, y) {
  const tip = document.getElementById("tooltip");
  if (!tip) return;
  tip.innerHTML = html;
  const wrap = document.getElementById("canvas-wrap");
  const rect = wrap.getBoundingClientRect();
  const tipW = tip.offsetWidth || 240;
  const tipH = tip.offsetHeight || 100;
  const left = x + tipW + 16 > rect.width ? x - tipW - 10 : x + 14;
  const top = y + tipH + 16 > rect.height ? y - tipH - 10 : y + 14;
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
  tip.classList.add("show");
}

function _hideTooltip() {
  document.getElementById("tooltip")?.classList.remove("show");
}

function _setupPanel() {
  document.getElementById("entity-search")?.addEventListener("input", e => {
    _entitySearchQuery = e.target.value.toLowerCase().trim();
    _updateSidebarList(true);
  });
}

function _setupControls() {
  document.getElementById("btn-overview")?.addEventListener("click", () => {
    _currentView = "overview";
    _selectedCommunityId = null;
    _selectedVariantKey = null;
    _renderCurrentView();
  });
  document.getElementById("btn-variants")?.addEventListener("click", () => {
    _selectedCommunityId = null;
    _currentView = "variants";
    _renderCurrentView();
  });
  document.getElementById("btn-back")?.addEventListener("click", () => {
    if (_currentView === "community") {
      _currentView = "overview";
      _selectedCommunityId = null;
    } else if (_currentView === "variants" && _selectedVariantKey) {
      _selectedVariantKey = null;
    } else if (_currentView === "variants") {
      _currentView = "overview";
    } else if (_currentView === "detail") {
      const target = _detailReturnContext?.view ?? "overview";
      if (target === "community") {
        _currentView = "community";
        _selectedCommunityId = _detailReturnContext.communityId ?? _selectedCommunityId;
      } else if (target === "variants") {
        _currentView = "variants";
        _selectedVariantKey = _detailReturnContext.variantKey ?? _selectedVariantKey;
      } else {
        _currentView = "overview";
        _selectedCommunityId = null;
      }
      _selectedEntityId = null;
      _detailGraph = null;
    }
    _renderCurrentView();
  });

  document.getElementById("btn-fit")?.addEventListener("click", () => {
    _fitCurrentView();
  });
  document.getElementById("btn-reset-zoom")?.addEventListener("click", () => _resetZoom());

  const slider = document.getElementById("slider-max-entities");
  const sliderVal = document.getElementById("slider-max-entities-val");
  slider?.addEventListener("input", () => {
    _filters.maxEntitiesPerType = parseInt(slider.value, 10);
    if (sliderVal) sliderVal.textContent = slider.value;
    if (_currentView === "detail") _renderCurrentView();
  });
  if (sliderVal && slider) sliderVal.textContent = slider.value;

  document.getElementById("btn-shared-only")?.addEventListener("click", function() {
    _filters.sharedOnly = !_filters.sharedOnly;
    this.classList.toggle("active", _filters.sharedOnly);
    if (_currentView === "detail") _renderCurrentView();
  });

  const toggleMap = {
    "toggle-df": "df",
    "toggle-corr": "corr",
    "toggle-relations": "relations",
    "toggle-sync": "sync",
    "toggle-bottleneck": "bottleneck",
  };
  Object.entries(toggleMap).forEach(([id, key]) => {
    document.getElementById(id)?.addEventListener("change", e => {
      vis[key] = e.target.checked;
      _applyVisibility();
    });
  });

  const opaMap = {
    "opa-df": "df",
    "opa-corr": "corr",
    "opa-relations": "relations",
  };
  Object.entries(opaMap).forEach(([id, key]) => {
    const el = document.getElementById(id);
    const valEl = document.getElementById(`${id}-val`);
    el?.addEventListener("input", () => {
      opa[key] = parseFloat(el.value);
      if (valEl) valEl.textContent = el.value;
      _applyVisibility();
    });
    if (valEl && el) valEl.textContent = el.value;
  });

  document.getElementById("btn-open-file")?.addEventListener("click", () => document.getElementById("file-input")?.click());
  document.getElementById("file-input")?.addEventListener("change", async e => {
    const file = e.target.files[0];
    if (!file) return;
    _showLoading(true);
    _hideDropzone();
    try {
      const text = await file.text();
      const bundle = JSON.parse(text);
      const store = buildStore(bundle);
      _afterLoad(store, file.name.replace(".json", ""));
    } catch (err) {
      alert("Failed to load file: " + err.message);
      _showDropzone();
    } finally {
      _showLoading(false);
    }
  });
}

function _setupCanvasKeyboard() {
  const wrap = document.getElementById("canvas-wrap");
  if (!wrap) return;

  wrap.addEventListener("pointerdown", () => {
    wrap.focus({ preventScroll: true });
  });

  wrap.addEventListener("keydown", event => {
    const action = _keyboardCameraAction(event);
    if (!action) return;
    event.preventDefault();

    if (action === "fit") {
      _fitCurrentView();
      return;
    }
    if (action === "reset") {
      _resetZoom();
      return;
    }

    _keyboardCameraKeys.add(action);
    _startKeyboardCameraLoop();
  });

  wrap.addEventListener("keyup", event => {
    const action = _keyboardCameraAction(event);
    if (!action || action === "fit" || action === "reset") return;
    event.preventDefault();
    _keyboardCameraKeys.delete(action);
    if (!_keyboardCameraKeys.size) _stopKeyboardCameraLoop();
  });

  wrap.addEventListener("blur", _clearKeyboardCamera);
  window.addEventListener("blur", _clearKeyboardCamera);
}

function _syncToggleButtons() {
  document.getElementById("btn-shared-only")?.classList.toggle("active", _filters.sharedOnly);
}

function _buildActivityList(store) {
  const container = document.getElementById("activity-list");
  if (!container) return;
  container.innerHTML = "";
  const actColors = store.activityColorByName;
  store.allActivities.forEach((activity, i) => {
    const id = `act-${i}`;
    const item = document.createElement("div");
    item.className = "act-item";
    item.innerHTML = `<input type="checkbox" id="${id}" checked><span class="act-swatch" style="background:${actColors[activity] ?? "#64748b"}"></span><label for="${id}">${activity}</label><span class="act-count">${store.events.filter(e => e.activity === activity).length}</span>`;
    const cb = item.querySelector("input");
    cb.addEventListener("change", () => _onActivityToggle(activity, cb.checked));
    container.appendChild(item);
  });

  document.getElementById("btn-act-all")?.addEventListener("click", () => {
    container.querySelectorAll("input").forEach(cb => { cb.checked = true; });
    _filters.activities = null;
    if (_currentView === "detail" || _currentView === "overview" || _currentView === "community" || _currentView === "variants") _renderCurrentView();
  });
  document.getElementById("btn-act-none")?.addEventListener("click", () => {
    container.querySelectorAll("input").forEach(cb => { cb.checked = false; });
    _filters.activities = new Set();
    if (_currentView === "detail" || _currentView === "overview" || _currentView === "community" || _currentView === "variants") _renderCurrentView();
  });
}

function _onActivityToggle(activity, checked) {
  const store = getStore();
  if (_filters.activities === null) {
    if (!checked) _filters.activities = new Set(store.allActivities.filter(a => a !== activity));
  } else {
    if (checked) _filters.activities.add(activity);
    else _filters.activities.delete(activity);
    if (_filters.activities.size === store.allActivities.length) _filters.activities = null;
  }
  if (_currentView === "detail" || _currentView === "overview" || _currentView === "community" || _currentView === "variants") _renderCurrentView();
}

function _renderEntityTypeFilters(detailGraph) {
  const container = document.getElementById("entity-type-list");
  if (!container) return;
  container.innerHTML = "";
  const selected = _filters.visibleEntityTypes ? new Set(_filters.visibleEntityTypes) : new Set(detailGraph.visibleEntityTypes);
  detailGraph.visibleEntityTypes.forEach(type => {
    const id = `type-${type}`;
    const row = document.createElement("label");
    row.className = "toggle-row";
    row.innerHTML = `<input type="checkbox" id="${id}" ${selected.has(type) ? "checked" : ""}><span>${type}</span>`;
    row.querySelector("input").addEventListener("change", e => {
      const next = _filters.visibleEntityTypes ? new Set(_filters.visibleEntityTypes) : new Set(detailGraph.visibleEntityTypes);
      if (e.target.checked) next.add(type);
      else next.delete(type);
      _filters.visibleEntityTypes = next.size === detailGraph.visibleEntityTypes.length ? null : [...next];
      _renderCurrentView();
    });
    container.appendChild(row);
  });
}

function _keyboardCameraAction(event) {
  const { key } = event;
  if (key === "ArrowLeft" || key === "a" || key === "A") return "pan-left";
  if (key === "ArrowRight" || key === "d" || key === "D") return "pan-right";
  if (key === "ArrowUp" || key === "w" || key === "W") return "pan-up";
  if (key === "ArrowDown" || key === "s" || key === "S") return "pan-down";
  if (key === "+" || key === "=") return "zoom-in";
  if (key === "-" || key === "_") return "zoom-out";
  if (key === "0") return "reset";
  if (key === "f" || key === "F") return "fit";
  return null;
}

function _startKeyboardCameraLoop() {
  if (_keyboardCameraFrame || !_keyboardCameraKeys.size) return;
  _keyboardCameraLastTs = 0;
  _keyboardCameraFrame = window.requestAnimationFrame(_tickKeyboardCamera);
}

function _stopKeyboardCameraLoop() {
  if (_keyboardCameraFrame) {
    window.cancelAnimationFrame(_keyboardCameraFrame);
    _keyboardCameraFrame = null;
  }
  _keyboardCameraLastTs = 0;
}

function _clearKeyboardCamera() {
  _keyboardCameraKeys.clear();
  _stopKeyboardCameraLoop();
}

function _tickKeyboardCamera(timestamp) {
  _keyboardCameraFrame = null;
  if (!_keyboardCameraKeys.size || !svg) return;

  const dt = Math.min(((timestamp - (_keyboardCameraLastTs || timestamp)) || 16) / 1000, 0.05);
  _keyboardCameraLastTs = timestamp;

  let dx = 0;
  let dy = 0;
  let zoomDirection = 0;
  if (_keyboardCameraKeys.has("pan-left")) dx += KEYBOARD_PAN_SPEED * dt;
  if (_keyboardCameraKeys.has("pan-right")) dx -= KEYBOARD_PAN_SPEED * dt;
  if (_keyboardCameraKeys.has("pan-up")) dy += KEYBOARD_PAN_SPEED * dt;
  if (_keyboardCameraKeys.has("pan-down")) dy -= KEYBOARD_PAN_SPEED * dt;
  if (_keyboardCameraKeys.has("zoom-in")) zoomDirection += 1;
  if (_keyboardCameraKeys.has("zoom-out")) zoomDirection -= 1;

  let nextTransform = currentTransform ?? d3.zoomIdentity;
  if (dx || dy) {
    nextTransform = d3.zoomIdentity
      .translate(nextTransform.x + dx, nextTransform.y + dy)
      .scale(nextTransform.k);
  }

  if (zoomDirection) {
    const wrap = document.getElementById("canvas-wrap");
    const rect = wrap?.getBoundingClientRect?.();
    const centerX = rect ? rect.width / 2 : svg.node().clientWidth / 2;
    const centerY = rect ? rect.height / 2 : svg.node().clientHeight / 2;
    nextTransform = _zoomTransformAroundPoint(nextTransform, Math.exp(zoomDirection * KEYBOARD_ZOOM_RATE * dt), centerX, centerY);
  }

  _applyTransform(nextTransform);
  if (_keyboardCameraKeys.size) {
    _keyboardCameraFrame = window.requestAnimationFrame(_tickKeyboardCamera);
  }
}

function _zoomTransformAroundPoint(transform, scaleFactor, pointX, pointY) {
  const start = transform ?? d3.zoomIdentity;
  const nextScale = Math.max(ZOOM_MIN_SCALE, Math.min(ZOOM_MAX_SCALE, start.k * scaleFactor));
  if (!Number.isFinite(nextScale) || nextScale === start.k) return start;

  const worldX = (pointX - start.x) / start.k;
  const worldY = (pointY - start.y) / start.k;
  return d3.zoomIdentity
    .translate(pointX - worldX * nextScale, pointY - worldY * nextScale)
    .scale(nextScale);
}

function _applyTransform(transform) {
  if (!svg || !zoom || !transform) return;
  svg.interrupt();
  svg.call(zoom.transform, transform);
}

function _buildCommunityList(clusters) {
  const label = document.getElementById("entity-list-label");
  if (label) label.textContent = "Communities";
  const container = document.getElementById("entity-list");
  if (!container) return;
  container.innerHTML = "";
  clusters.forEach(cluster => {
    const item = document.createElement("div");
    item.className = "entity-item community-item";
    item.dataset.id = cluster.id;
    item.innerHTML = `<span class="community-dot" style="background:${clusterColor(cluster.id, 0.85)}"></span><span class="entity-id">${cluster.label}</span><span class="entity-meta">${cluster.count} members</span>`;
    item.addEventListener("click", () => {
      _selectedCommunityId = cluster.id;
      _currentView = "community";
      _renderCurrentView();
    });
    container.appendChild(item);
  });
}

function _buildCaseList(store, communityId = null) {
  const label = document.getElementById("entity-list-label");
  const container = document.getElementById("entity-list");
  if (!container) return;
  container.innerHTML = "";
  const community = communityId ? store.communities?.find(item => item.id === communityId) : null;
  if (label) label.textContent = community ? community.label : `${store.caseType ?? "Case"}s`;
  let list = store.caseList;
  if (community) {
    const memberSet = new Set(community.nodeIds);
    list = list.filter(item => memberSet.has(item.id));
  }
  list.slice(0, 200).forEach(item => {
    const row = document.createElement("div");
    row.className = "entity-item";
    row.dataset.id = item.id;
    row.innerHTML = `<span class="entity-id">${item.id}</span><span class="entity-meta">${item.itemCount} related - ${item.eventCount} events</span>`;
    row.addEventListener("click", () => _openEntity(item.id));
    container.appendChild(row);
  });
}

function _buildEntityList(store, query = "") {
  const label = document.getElementById("entity-list-label");
  if (label) label.textContent = query ? "Entity search" : "Entities";
  const container = document.getElementById("entity-list");
  if (!container) return;
  container.innerHTML = "";
  const q = query.trim().toLowerCase();
  const list = store.entityList
    .filter(item => !q || item.label.toLowerCase().includes(q) || item.id.toLowerCase().includes(q) || item.type.toLowerCase().includes(q))
    .slice(0, 250);
  list.forEach(item => {
    const row = document.createElement("div");
    row.className = "entity-item";
    row.dataset.id = item.id;
    row.innerHTML = `<span class="entity-id">${item.label}</span><span class="entity-meta">${item.type} - ${item.eventCount} events</span>`;
    row.addEventListener("click", () => _openEntity(item.id));
    container.appendChild(row);
  });
}

function _updateSidebarList(force = false) {
  const actKey = _filters.activities ? [..._filters.activities].sort().join(",") : "*";
  const key = `${_currentView}:${_selectedCommunityId ?? ""}:${_selectedVariantKey ?? ""}:${_entitySearchQuery}:${actKey}`;
  if (!force && key === _lastListKey) return;
  _lastListKey = key;

  const store = getStore();
  if (_currentView === "variants") return;
  if (_entitySearchQuery) {
    _buildEntityList(store, _entitySearchQuery);
    return;
  }
  if (_currentView === "overview") {
    const graph = getOverviewGraph({ activities: _filters.activities });
    _buildCommunityList(graph.clusters);
  } else if (_currentView === "community") {
    _buildCaseList(store, _selectedCommunityId);
  } else {
    _buildEntityList(store);
    _setActiveEntityInList(_selectedEntityId);
  }
}

function _setActiveEntityInList(entityId) {
  document.querySelectorAll(".entity-item").forEach(el => el.classList.toggle("active", el.dataset.id === entityId));
}

function _updateHeaderTags() {
  const store = getStore();
  const selected = _selectedEntityId ? store.entityById[_selectedEntityId] : null;
  const communityLabel = _selectedCommunityId ? (store.communities?.find(c => c.id === _selectedCommunityId)?.label ?? "Community") : null;
  const selectedVariant = _variantData?.variants?.find(variant => variant.key === _selectedVariantKey) ?? null;
  document.getElementById("panel-view-tag").textContent =
    _currentView === "overview" ? "OVERVIEW"
      : _currentView === "variants" ? (selectedVariant ? `VARIANT ${selectedVariant.rank}` : "VARIANTS")
        : _currentView === "community" ? (communityLabel ?? "COMMUNITY")
          : `${selected?.primary_type?.toUpperCase() ?? "DETAIL"} ${selected?.entity_id ?? ""}`;
  const backBtn = document.getElementById("btn-back");
  if (backBtn) {
    const isVisible = _currentView === "community" || _currentView === "variants" || _currentView === "detail";
    backBtn.style.display = isVisible ? "block" : "none";
    if (_currentView === "community") backBtn.textContent = "<- All communities";
    else if (_currentView === "variants" && _selectedVariantKey) backBtn.textContent = "<- All variants";
    else if (_currentView === "variants") backBtn.textContent = "<- Back to overview";
    else if (_currentView === "detail" && _detailReturnContext?.view === "community") backBtn.textContent = `<- ${communityLabel ?? "Community"}`;
    else if (_currentView === "detail" && _detailReturnContext?.view === "variants") backBtn.textContent = "<- Variants";
    else backBtn.textContent = "<- Back to overview";
  }
  document.getElementById("sidebar")?.setAttribute("data-view", _currentView);
  document.getElementById("sidebar")?.setAttribute("data-variant-selected", _selectedVariantKey ? "true" : "false");
  document.getElementById("btn-overview")?.classList.toggle("active", _currentView === "overview" || _currentView === "community");
  document.getElementById("btn-variants")?.classList.toggle("active", _currentView === "variants");
}

function _updateStatusBar(store) {
  document.getElementById("status-events").innerHTML = `Events: <b>${store.events.length.toLocaleString()}</b>`;
  document.getElementById("status-entities").innerHTML = `Entities: <b>${store.entities.length.toLocaleString()}</b>`;
  let tail = `${store.caseType ?? "Cases"}: <b>${store.caseList.length.toLocaleString()}</b>`;
  if (_currentView === "overview") {
    tail = `Communities: <b>${store.communities?.length?.toLocaleString?.() ?? 0}</b>`;
  } else if (_currentView === "community") {
    const community = store.communities?.find(item => item.id === _selectedCommunityId);
    tail = `${store.caseType ?? "Cases"}: <b>${community?.nodeIds?.length?.toLocaleString?.() ?? 0}</b>`;
  } else if (_currentView === "variants") {
    tail = `Variants: <b>${_variantData?.variantCount?.toLocaleString?.() ?? 0}</b>`;
  } else if (_currentView === "detail" && _selectedEntityId) {
    tail = `Focus: <b>${_selectedEntityId}</b>`;
  }
  document.getElementById("status-cases").innerHTML = tail;
}

function _updateDetailPanels(detailGraph) {
  const summaryTitle = document.getElementById("detail-summary-title");
  const summaryContent = document.getElementById("detail-summary-content");
  const sharedList = document.getElementById("shared-event-list");
  if (!summaryContent || !sharedList) return;

  if (!detailGraph) {
    if (summaryTitle) summaryTitle.textContent = "Analysis Summary";
    summaryContent.innerHTML = `<div class="stat-row"><span class="stat-label">Open any entity to inspect a typed EKG slice.</span></div>`;
    sharedList.innerHTML = `<div class="empty-note">Shared events will appear here in detail view.</div>`;
    document.getElementById("entity-type-list").innerHTML = "";
    return;
  }

  const summary = detailGraph.summary;
  if (summaryTitle) summaryTitle.textContent = `${detailGraph.anchorEntityType} ${detailGraph.anchorEntityId}`;
  const rows = [
    { label: "Scope", value: detailGraph.scope === "item-focus" ? "Selected book/item overlap only" : "Local neighborhood" },
    { label: "Entity types", value: summary.visibleEntityTypeCount },
    { label: "Entities", value: summary.visibleEntityCount },
    { label: "Events", value: summary.eventCount },
    { label: "Relations", value: summary.relationCount },
    { label: "Shared events", value: summary.sharedEventCount },
    { divider: true },
    { label: "Parallel bands", value: _formatParallelBandPreview(summary.parallelEntityTypes), className: "flow" },
    { label: "Bottleneck p75", value: Number.isFinite(summary.bottleneckThresholdHours) ? `${summary.bottleneckThresholdHours.toFixed(1)}h` : "n/a" },
  ];
  summaryContent.innerHTML = rows.map(row =>
    row.divider
      ? `<div class="stat-divider"></div>`
      : `<div class="stat-row ${row.className ? `stat-row-${row.className}` : ""}"><span class="stat-label">${row.label}</span><span class="stat-val ${row.className ? `stat-val-${row.className}` : ""}">${row.value}</span></div>`
  ).join("");

  const hotspots = detailGraph.summary.sharedEventHotspots ?? [];
  if (!hotspots.length) {
    sharedList.innerHTML = `<div class="empty-note">No shared events in the current focus.</div>`;
  } else {
    sharedList.innerHTML = hotspots.map(item =>
      `<div class="shared-item" data-event-id="${item.event_id}">
        <span class="shared-activity">${item.activity}</span>
        <span class="shared-meta">${item.entityCount} entities - ${item.entityTypes.join(", ")}</span>
      </div>`
    ).join("");
    sharedList.querySelectorAll(".shared-item").forEach(el => {
      el.addEventListener("click", () => {
        _toggleSelection({
          kind: "event",
          eventId: el.dataset.eventId,
          relatedEntityIds: detailGraph.sharedEvents.find(item => item.event_id === el.dataset.eventId)?.sharedEntityIds ?? [],
        });
      });
    });
  }
}

function _updateOverviewPanels(overviewGraph) {
  const title = document.getElementById("overview-summary-title");
  const content = document.getElementById("overview-summary-content");
  if (!title || !content) return;

  if (!overviewGraph) {
    title.textContent = "Overview Summary";
    content.innerHTML = `<div class="stat-row"><span class="stat-label">Open overview or a community to see summary statistics.</span></div>`;
    return;
  }

  if (_currentView === "community") {
    const community = overviewGraph.clusters?.[0];
    title.textContent = community?.label ?? "Community Summary";
    content.innerHTML = _rowsToHtml([
      { label: "Members", value: overviewGraph.meta.caseCount },
      { label: "Events shown", value: overviewGraph.meta.filteredEvents },
      { label: "Books shown", value: overviewGraph.meta.shownItems },
      { label: "Case links", value: overviewGraph.meta.overviewEdgeCount },
      { label: "Resources", value: community?.resources?.length ?? 0 },
      { label: "Attributes", value: community?.attributes?.length ?? 0 },
    ]);
    return;
  }

  title.textContent = "Overview Summary";
  content.innerHTML = _rowsToHtml([
    { label: "Communities", value: overviewGraph.meta.clusterCount },
    { label: "Cases shown", value: overviewGraph.meta.caseCount },
    { label: "Events shown", value: overviewGraph.meta.filteredEvents },
    { label: "Books shown", value: overviewGraph.meta.shownItems },
    { label: "Case links", value: overviewGraph.meta.overviewEdgeCount },
    { label: "Community links", value: overviewGraph.meta.overviewCommunityEdgeCount },
  ]);
}

function _updateVariantPanels(variantData, selectedVariant) {
  const summaryTitle = document.getElementById("variant-summary-title");
  const summaryContent = document.getElementById("variant-summary-content");
  const itemLabel = document.getElementById("variant-item-list-label");
  const itemList = document.getElementById("variant-item-list");
  const memberLabel = document.getElementById("variant-member-list-label");
  const memberList = document.getElementById("variant-member-list");
  if (!summaryTitle || !summaryContent || !itemLabel || !itemList || !memberLabel || !memberList) return;

  if (!variantData) {
    summaryTitle.textContent = "Variant Summary";
    summaryContent.innerHTML = `<div class="stat-row"><span class="stat-label">Open the variants view to inspect process variants.</span></div>`;
    itemLabel.textContent = "Books in variant";
    memberLabel.textContent = "Members in variant";
    itemList.innerHTML = `<div class="empty-note">Select a variant to list its books.</div>`;
    memberList.innerHTML = `<div class="empty-note">Select a variant to list its members.</div>`;
    return;
  }

  itemLabel.textContent = `${variantData.itemType ?? "Items"} in variant`;
  memberLabel.textContent = `${variantData.caseType ?? "Cases"} in variant`;

  if (!selectedVariant) {
    summaryTitle.textContent = "Variant Overview";
    summaryContent.innerHTML = _rowsToHtml([
      { label: "Variants", value: variantData.variantCount },
      { label: "Shown rows", value: variantData.variants.length },
      { label: "Instances", value: variantData.totalInstances },
      { label: "Top share", value: formatPercent(variantData.summary?.dominantVariantShare ?? 0) },
      { label: "Avg variant size", value: (variantData.summary?.averageVariantSize ?? 0).toFixed(1) },
      { label: "Avg sequence length", value: (variantData.summary?.averageSequenceLength ?? 0).toFixed(1) },
      { divider: true },
      { label: "Selection", value: "Click a variant row to inspect it", className: "flow" },
    ]);
    itemList.innerHTML = `<div class="empty-note">Select a variant to list its ${variantData.itemType?.toLowerCase?.() ?? "items"}.</div>`;
    memberList.innerHTML = `<div class="empty-note">Select a variant to list its ${variantData.caseType?.toLowerCase?.() ?? "cases"}.</div>`;
    return;
  }

  summaryTitle.textContent = `Variant ${selectedVariant.rank}`;
  summaryContent.innerHTML = _rowsToHtml([
    { label: "Dominant", value: selectedVariant.isdominant ? "Yes" : "No" },
    { label: "Share", value: formatPercent(selectedVariant.frequency) },
    { label: "Instances", value: selectedVariant.count },
    { label: variantData.caseType ?? "Cases", value: selectedVariant.memberCount },
    { label: variantData.itemType ?? "Items", value: selectedVariant.itemCount },
    { label: "Events", value: selectedVariant.eventTotal },
    { label: "Avg events/item", value: selectedVariant.eventAverage.toFixed(1) },
    { label: "Avg duration", value: _formatHoursLabel(selectedVariant.avgDurationHours) },
    { label: "Resources", value: selectedVariant.resourceCount },
    { divider: true },
    { label: "Sequence", value: _formatSequencePreview(selectedVariant.sequence), className: "flow" },
    { label: "Top resources", value: _formatCountList(selectedVariant.topResources, "label"), className: "flow" },
    { label: "Top activities", value: _formatCountList(selectedVariant.topActivities, "activity"), className: "flow" },
    { label: "Time range", value: _formatDateRange(selectedVariant.firstDate, selectedVariant.lastDate), className: "flow" },
  ]);

  _renderVariantEntityList(itemList, selectedVariant.items, item =>
    `${item.eventCount} events`, item.id
  );
  _renderVariantEntityList(memberList, selectedVariant.members, member =>
    `${member.itemCount} items - ${member.eventCount} events`, member.id
  );
}

function _renderVariantEntityList(container, items, metaBuilder, entityIdKey) {
  container.innerHTML = "";
  const rows = (items ?? []).slice(0, 50);
  if (!rows.length) {
    container.innerHTML = `<div class="empty-note">No entities in this variant.</div>`;
    return;
  }
  rows.forEach(item => {
    const row = document.createElement("div");
    row.className = "entity-item";
    row.dataset.id = item[entityIdKey];
    row.innerHTML = `<span class="entity-id">${item.label}</span><span class="entity-meta">${metaBuilder(item)}</span>`;
    row.addEventListener("click", () => _openEntity(item[entityIdKey], { view: "variants", communityId: null, variantKey: _selectedVariantKey }));
    container.appendChild(row);
  });
}

function _rowsToHtml(rows) {
  return rows.map(row =>
    row.divider
      ? `<div class="stat-divider"></div>`
      : `<div class="stat-row ${row.className ? `stat-row-${row.className}` : ""}"><span class="stat-label">${row.label}</span><span class="stat-val ${row.className ? `stat-val-${row.className}` : ""}">${row.value}</span></div>`
  ).join("");
}

function _renderLegend() {
  const el = document.getElementById("legend-content");
  if (!el) return;
  el.innerHTML = `
    <div class="legend-item"><span class="legend-swatch legend-event"></span><span>Event anchor</span></div>
    <div class="legend-item"><span class="legend-swatch legend-shared"></span><span>Shared event</span></div>
    <div class="legend-item"><span class="legend-swatch legend-df"></span><span>DF edge</span></div>
    <div class="legend-item"><span class="legend-swatch legend-bottleneck"></span><span>Bottleneck DF edge</span></div>
    <div class="legend-item"><span class="legend-swatch legend-corr"></span><span>Correlation link</span></div>
    <div class="legend-item"><span class="legend-swatch legend-relation"></span><span>Entity relation</span></div>
  `;
}

function _formatSequencePreview(sequence = []) {
  if (!sequence.length) return "none";
  const preview = sequence.slice(0, 5).join(" -> ");
  return sequence.length > 5 ? `${preview} (+${sequence.length - 5} more)` : preview;
}

function _formatCountList(items = [], labelKey) {
  if (!items.length) return "none";
  return items.slice(0, 3).map(item => `${item[labelKey]} (${item.count})`).join(", ");
}

function _formatHoursLabel(hours) {
  if (!Number.isFinite(hours)) return "n/a";
  if (hours >= 24) return `${(hours / 24).toFixed(1)}d`;
  return `${hours.toFixed(hours >= 10 ? 0 : 1)}h`;
}

function _formatDateRange(firstDate, lastDate) {
  if (!(firstDate instanceof Date) || Number.isNaN(firstDate.getTime()) || !(lastDate instanceof Date) || Number.isNaN(lastDate.getTime())) {
    return "n/a";
  }
  return `${firstDate.toLocaleDateString("en-GB")} -> ${lastDate.toLocaleDateString("en-GB")}`;
}

function _formatParallelBandPreview(parallelBands = []) {
  if (!parallelBands.length) return "none";
  return parallelBands
    .slice(0, 3)
    .map(item => `${item.entityType} (${item.count})`)
    .join(", ");
}

function _applyVisibility() {
  if (!gRoot) return;
  gRoot.selectAll(".df-link").attr("display", vis.df ? null : "none").attr("opacity", opa.df);
  gRoot.selectAll(".corr-link").attr("display", vis.corr ? null : "none").attr("opacity", opa.corr);
  gRoot.selectAll(".relation-link").attr("display", vis.relations ? null : "none").attr("opacity", opa.relations);
  gRoot.selectAll(".shared-guide").attr("display", vis.sync ? null : "none").attr("opacity", vis.sync ? 1 : 0.12);
  gRoot.selectAll(".df-link-bottleneck").attr("opacity", vis.bottleneck ? opa.df : opa.df * 0.2);
}

function _toggleSelection(sel) {
  _selection = (_selection && JSON.stringify(_selection) === JSON.stringify(sel)) ? null : sel;
  _applySelectionState();
}

function _clearSelection() {
  _selection = null;
  _applySelectionState();
}

function _applySelectionState() {
  if (!gRoot) return;
  const anchors = gRoot.selectAll(".event-anchor-core");
  const markers = gRoot.selectAll(".lane-marker-circle");
  const dfEdges = gRoot.selectAll(".df-link");
  const lanes = gRoot.selectAll(".entity-lane");
  const corrLinks = gRoot.selectAll(".corr-link");

  anchors.classed("highlighted", false).classed("dimmed", false);
  markers.classed("highlighted", false).classed("dimmed", false);
  dfEdges.classed("edge-highlighted", false).classed("edge-dimmed", false);
  lanes.classed("item-highlighted", false).classed("item-dimmed", false);
  corrLinks.classed("edge-highlighted", false).classed("edge-dimmed", false);

  if (!_selection) return;

  if (_selection.kind === "event") {
    const related = new Set(_selection.relatedEntityIds ?? []);
    anchors.classed("highlighted", function() { return d3.select(this.parentNode).attr("data-event-id") === _selection.eventId; })
      .classed("dimmed", function() { return d3.select(this.parentNode).attr("data-event-id") !== _selection.eventId; });
    markers.classed("highlighted", function() { return d3.select(this.parentNode).attr("data-event-id") === _selection.eventId; })
      .classed("dimmed", function() { return d3.select(this.parentNode).attr("data-event-id") !== _selection.eventId; });
    lanes.classed("item-highlighted", function() { return related.has(d3.select(this).attr("data-entity-id")); })
      .classed("item-dimmed", function() { return related.size ? !related.has(d3.select(this).attr("data-entity-id")) : false; });
    corrLinks.classed("edge-highlighted", function() { return d3.select(this).attr("data-event-id") === _selection.eventId; })
      .classed("edge-dimmed", function() { return d3.select(this).attr("data-event-id") !== _selection.eventId; });
  } else if (_selection.kind === "edge") {
    const activeEvents = new Set([_selection.sourceId, _selection.targetId]);
    anchors.classed("highlighted", function() { return activeEvents.has(d3.select(this.parentNode).attr("data-event-id")); })
      .classed("dimmed", function() { return !activeEvents.has(d3.select(this.parentNode).attr("data-event-id")); });
    markers.classed("highlighted", function() { return activeEvents.has(d3.select(this.parentNode).attr("data-event-id")); })
      .classed("dimmed", function() { return !activeEvents.has(d3.select(this.parentNode).attr("data-event-id")); });
    dfEdges.classed("edge-highlighted", function() { return d3.select(this).attr("data-edge-id") === _selection.edgeId; })
      .classed("edge-dimmed", function() { return d3.select(this).attr("data-edge-id") !== _selection.edgeId; });
    lanes.classed("item-highlighted", function() { return d3.select(this).attr("data-entity-id") === _selection.entityId; })
      .classed("item-dimmed", function() { return d3.select(this).attr("data-entity-id") !== _selection.entityId; });
  }
}

function _fitToView(totalHeight, options = {}) {
  if (!svg) return;
  const transform = computeFitTransform(svg, gRoot, totalHeight, options);
  if (!transform) return;
  svg.transition().duration(CAMERA_EASE_MS).ease(d3.easeCubicOut).call(zoom.transform, transform);
}

function _fitCurrentView() {
  if (_currentView === "detail") _fitDetailView();
  else _fitToView(_lastTotalHeight);
}

function _fitDetailView() {
  _fitToView(_lastTotalHeight, {
    alignTop: true,
    alignLeft: true,
    minScale: 0.34,
    padX: 28,
    padY: 26,
    preferWidth: true,
  });
}

function _resetZoom() {
  svg?.transition().duration(CAMERA_EASE_MS).ease(d3.easeCubicOut).call(zoom.transform, d3.zoomIdentity);
}

function _setupSidebarResize() {
  const resizer = document.getElementById("sidebar-resizer");
  const sidebar = document.getElementById("sidebar");
  if (!resizer || !sidebar) return;
  let startX, startW;
  resizer.addEventListener("mousedown", e => {
    startX = e.clientX;
    startW = sidebar.offsetWidth;
    resizer.classList.add("dragging");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const onMove = e2 => {
      const w = Math.max(220, Math.min(560, startW + (e2.clientX - startX)));
      sidebar.style.width = `${w}px`;
      sidebar.style.minWidth = `${w}px`;
    };
    const onUp = () => {
      resizer.classList.remove("dragging");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      _renderCurrentView();
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}

function _handleResize() {
  if (_resizeTimer) clearTimeout(_resizeTimer);
  _resizeTimer = setTimeout(() => {
    if (!svg) return;
    try {
      getStore();
    } catch {
      return;
    }
    _renderCurrentView();
  }, 100);
}

function _showLoading(visible) {
  document.getElementById("loading")?.classList.toggle("hidden", !visible);
}

function _showDropzone() {
  document.getElementById("dropzone")?.classList.remove("hidden");
}

function _hideDropzone() {
  document.getElementById("dropzone")?.classList.add("hidden");
}

window.addEventListener("DOMContentLoaded", init);
