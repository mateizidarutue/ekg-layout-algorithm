"use strict";

import { loadDataset, loadManifest, datasetUrl, datasetFromQuery } from "./data/loader.js";
import {
  buildStore, getStore, getOverviewGraph, getVariantOverview,
  getActivityDfGraph, getDetailGraph, getGlobalSharedEventHotspots, getEntitiesForHotspot,
} from "./data/store.js";
import { computeDetailLayout } from "./layout/detailLayout.js";
import { computeOverviewNetworkLayout, computeVariantLayout, computeDfGraphLayout } from "./layout/overviewLayout.js";
import { drawDetailView } from "./render/detailRender.js";
import { drawOverviewNetwork, drawVariantOverview } from "./render/overviewRender.js";
import {
  addMarkers, wheelDelta, computeFitTransform, clusterColor, formatPercent,
  ZOOM_MIN_SCALE, ZOOM_MAX_SCALE, CAMERA_EASE_MS,
} from "./render/shared.js";
import { startRouter, getRoute, navigate } from "./router.js";
import { renderHome } from "./screens/home.js";
import { renderIdentifyPicker } from "./screens/identify.js";
import { renderExploreList, updateHotspotSummary } from "./screens/explore.js";
import { updateSidebarRoute, updateTopbar, renderCompareStrip } from "./screens/sidebar.js";

// ── SVG / camera ──────────────────────────────────────────────────────────────
let svg, gRoot, zoom, currentTransform;
const vis = { df: true, corr: true, relations: true, sync: true, bottleneck: true };
const opa = { df: 0.78, corr: 0.22, relations: 0.4 };
const KEYBOARD_PAN_SPEED = 880;
const KEYBOARD_ZOOM_RATE = 1.75;
const TRACKPAD_PAN_THRESHOLD = 80;
const EXPLORE_ENTITY_LIMIT = 14;
const EXPLORE_MAX_ENTITIES_PER_TYPE = 18;

// ── App state ─────────────────────────────────────────────────────────────────
let _currentDatasetName = "library";
let _manifest = { datasets: [] };
let _lastTotalHeight = 0;
let _detailGraph = null;
let _variantData = null;
let _selection = null;
let _entitySearchQuery = "";
let _lastListKey = null;
let _resizeTimer = null;
let _keyboardCameraKeys = new Set();
let _keyboardCameraFrame = null;
let _keyboardCameraLastTs = 0;
let _clusterActivityContext = null;
let _compareEntityIds = [];
let _compareMode = "variants";
let _accentMap = {};
const ACCENT_COLORS = ["#7c3aed", "#ea580c", "#059669", "#dc2626", "#0891b2"];
let _filters = {
  activities: null,
  maxEntitiesPerType: 8,
  visibleEntityTypes: null,
  sharedOnly: false,
};

// ── Boot ──────────────────────────────────────────────────────────────────────
async function init() {
  const svgEl = document.getElementById("canvas");
  svg = d3.select(svgEl);
  gRoot = svg.append("g").attr("class", "root")
    .style("transform-origin", "0 0")
    .style("will-change", "transform");
  currentTransform = d3.zoomIdentity;
  addMarkers(svg.append("defs"));

  zoom = d3.zoom()
    .scaleExtent([ZOOM_MIN_SCALE, ZOOM_MAX_SCALE])
    .wheelDelta(wheelDelta)
    .on("zoom", e => {
      currentTransform = e.transform;
      gRoot.style("transform",
        `translate(${e.transform.x}px,${e.transform.y}px) scale(${e.transform.k})`);
    });

  svg.call(zoom);
  svg.on("wheel.zoom", null);
  svg.on("dblclick.zoom", null);
  svg.on("click.selection-clear", ev => { if (ev.target === svgEl) _clearSelection(); });

  _setupTooltip();
  _setupPanel();
  _setupEdgeControls();
  _setupCanvasKeyboard();
  _setupSidebarResize();
  _renderLegend();
  _setupTopbar();
  window.addEventListener("resize", _handleResize);

  _manifest = await loadManifest();

  _currentDatasetName = datasetFromQuery("library");
  await _loadDataset(_currentDatasetName);

  startRouter({ onRoute: handleRoute });
}

// ── Dataset loading ───────────────────────────────────────────────────────────
async function _loadDataset(name) {
  _showLoading(true);
  _hideDropzone();
  try {
    const bundle = await loadDataset(datasetUrl(name));
    const store = buildStore(bundle);
    _currentDatasetName = name;
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
  _filters.maxEntitiesPerType = null;
  _filters.visibleEntityTypes = null;
  _filters.sharedOnly = false;
  _clusterActivityContext = null;
  _compareEntityIds = [];
  _compareMode = "variants";
  _accentMap = {};
  _detailGraph = null;
  _variantData = null;
  _selection = null;
  _entitySearchQuery = "";
  _lastListKey = null;

  document.getElementById("dataset-label").textContent = name.toUpperCase();
  document.getElementById("topbar-dataset-name").textContent = name.toUpperCase();
  const search = document.getElementById("entity-search");
  if (search) {
    search.value = "";
    search.placeholder = `Search ${store.caseType ?? "entity"} / ${store.itemType ?? "entity"} / type…`;
  }
  _syncToggleButtons();
  _buildActivityList(store);
  _updateStatusBar(store);

  const route = getRoute();
  handleRoute(route);
}

// ── Router dispatch ───────────────────────────────────────────────────────────
function handleRoute(route) {
  const shouldKeepClusterContext = (
    route.name === "identify" && route.params.entity
  ) || (
    route.name === "compare" && _compareMode === "compare" && route.params.entities
  ) || (
    route.name === "explore" && route.params.cluster
  );
  if (!shouldKeepClusterContext) _clusterActivityContext = null;
  _selection = null;

  const store = (() => { try { return getStore(); } catch { return null; } })();
  if (!store) return;

  updateSidebarRoute(route, {
    compareMode: _compareMode,
    exploreDrilled: Boolean(route.name === "explore" && route.params.cluster),
  });
  updateTopbar(route, store);
  _syncToggleButtons();

  const screenHost = document.getElementById("screen-host");
  const canvas = document.getElementById("canvas");

  // Determine if this route uses the DOM screen-host
  const isDomScreen = route.name === "home"
    || (route.name === "explore" && !route.params.cluster)
    || (route.name === "identify" && !route.params.entity);
  if (screenHost) screenHost.classList.toggle("hidden", !isDomScreen);
  if (canvas) canvas.style.display = isDomScreen ? "none" : "";

  _renderLayers(route, store);
  _updateSidebarList();
  _updateStatusBar(store);
  _updateHeaderTags(route, store);
}

function _renderLayers(route, store) {
  gRoot.selectAll("*").remove();
  const lBg    = gRoot.append("g").attr("class", "l-bg");
  const lMeta  = gRoot.append("g").attr("class", "l-meta");
  const lRel   = gRoot.append("g").attr("class", "l-relations");
  const lCorr  = gRoot.append("g").attr("class", "l-corr");
  const lDf    = gRoot.append("g").attr("class", "l-df");
  const lNodes = gRoot.append("g").attr("class", "l-nodes");
  const lLabels= gRoot.append("g").attr("class", "l-labels");
  const w = svg.node().clientWidth;
  const cb = _makeCallbacks(route);
  const labels = { caseType: store.caseType ?? "Case", itemType: store.itemType ?? "Item", caseBadge: (store.caseType ?? "CA").slice(0, 2).toUpperCase() };

  switch (route.name) {
    case "home": {
      renderHome(store, _manifest, _currentDatasetName);
      break;
    }
    case "identify": {
      const entityId = route.params.entity ?? null;
      if (!entityId) {
        renderIdentifyPicker(store);
        break;
      }
      _detailGraph = getDetailGraph({
        anchorEntityId: entityId,
        visibleEntityTypes: _filters.visibleEntityTypes ?? undefined,
        activities: _effectiveDetailActivities(),
        maxEntitiesPerType: _filters.maxEntitiesPerType,
        sharedOnly: _filters.sharedOnly,
      });
      const layout = computeDetailLayout(_detailGraph, w);
      drawDetailView(layout, lBg, lMeta, lRel, lCorr, lMeta, lDf, lNodes, lLabels, vis, cb);
      _lastTotalHeight = layout.totalHeight;
      _applyVisibility();
      _applySelectionState();
      _fitDetailView();
      _updateDetailPanels(_detailGraph);
      _updateClusterActivityPanel(_detailGraph);
      _syncMaxEntitiesSlider(_detailGraph);
      _renderEntityTypeFilters(_detailGraph);
      _highlightAnchorLane(entityId);
      break;
    }
    case "compare": {
      const entitiesParam = route.params.entities;
      if (entitiesParam) {
        _compareMode = "compare";
        _compareEntityIds = entitiesParam.split(",").filter(Boolean);
        updateSidebarRoute(route, { compareMode: "compare", exploreDrilled: false });
        _renderCompareDetail(route, store, w, lBg, lMeta, lRel, lCorr, lDf, lNodes, lLabels, cb);
      } else {
        _compareMode = "variants";
        updateSidebarRoute(route, { compareMode: "variants", exploreDrilled: false });
        _renderVariants(route, store, w, lBg, lNodes, lLabels, cb);
      }
      break;
    }
    case "summarize": {
      const communityId = route.params.community ?? null;
      const overviewGraph = getOverviewGraph({ activities: _filters.activities, communityId });
      const layout = computeOverviewNetworkLayout(overviewGraph, w);
      drawOverviewNetwork(layout.network, lBg, lMeta, lNodes, lLabels, vis, cb, labels);
      _lastTotalHeight = layout.totalHeight;
      _applyVisibility();
      _fitToView(_lastTotalHeight);
      _updateOverviewPanels(overviewGraph);
      _updateDetailPanels(null);
      _updateVariantPanels(null, null);
      _updateClusterActivityPanel(null);
      _syncMaxEntitiesSlider(null);
      if (communityId) _addOutlierBadges(overviewGraph);
      break;
    }
    case "explore": {
      const clusterId = route.params.cluster;
      if (clusterId) {
        _renderExploreDetail(route, store, w, lBg, lMeta, lRel, lCorr, lDf, lNodes, lLabels, cb, clusterId);
      } else {
        const hotspots = getGlobalSharedEventHotspots({ activities: _filters.activities });
        renderExploreList(hotspots);
        updateSidebarRoute(route, { compareMode: _compareMode, exploreDrilled: false });
      }
      break;
    }
    default:
      break;
  }
}

function _renderVariants(route, store, w, lBg, lNodes, lLabels, cb) {
  const selectedVariantKey = route.params.variant ?? null;
  const variantData = getVariantOverview({ activities: _filters.activities });
  variantData.variants.forEach(v => { v.isSelected = v.key === selectedVariantKey; });
  const selectedVariant = variantData.variants.find(v => v.key === selectedVariantKey) ?? null;
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
    x: 32, y: variantLayout.totalHeight + 34, width: dfInnerW, height: dfInnerH,
    nodes: rawDf.nodes.map(n => ({ ...n, x: n.x + 32, y: n.y + variantLayout.totalHeight + 34 })),
    edges: rawDf.edges.map(e => ({
      ...e,
      x1: e.x1 + 32, y1: e.y1 + variantLayout.totalHeight + 34,
      x2: e.x2 + 32, y2: e.y2 + variantLayout.totalHeight + 34,
      cx: e.cx + 32, cy: e.cy + variantLayout.totalHeight + 34,
    })),
  };
  drawVariantOverview(variantLayout, dfLayout, variantData, lBg, lNodes, lLabels, cb, selectedVariant);
  _lastTotalHeight = variantLayout.totalHeight + 34 + dfInnerH + (selectedVariant ? 178 : 26);
  _fitToView(_lastTotalHeight);
  _updateOverviewPanels(null);
  _updateVariantPanels(variantData, selectedVariant);
  _updateDetailPanels(null);
  _syncMaxEntitiesSlider(null);
}

function _renderCompareDetail(route, store, w, lBg, lMeta, lRel, lCorr, lDf, lNodes, lLabels, cb) {
  const entityIds = (route.params.entities ?? "").split(",").filter(Boolean);
  if (!entityIds.length) return;
  const anchorId = entityIds[0];
  const compareIds = entityIds.slice(1);
  _accentMap = {};
  compareIds.forEach((id, i) => { _accentMap[id] = ACCENT_COLORS[i % ACCENT_COLORS.length]; });
  renderCompareStrip(compareIds, _accentMap, store, id => {
    const next = compareIds.filter(x => x !== id);
    const newEntities = [anchorId, ...next].join(",");
    navigate("compare", newEntities ? { entities: newEntities } : {});
  });

  _detailGraph = getDetailGraph({
    anchorEntityId: anchorId,
    compareEntityIds: compareIds,
    visibleEntityTypes: _filters.visibleEntityTypes ?? undefined,
    activities: _effectiveDetailActivities(),
    maxEntitiesPerType: _filters.maxEntitiesPerType,
    sharedOnly: _filters.sharedOnly,
  });
  const layout = computeDetailLayout(_detailGraph, w);
  drawDetailView(layout, lBg, lMeta, lRel, lCorr, lMeta, lDf, lNodes, lLabels, vis, cb);
  _lastTotalHeight = layout.totalHeight;
  _applyVisibility();
  _applySelectionState();
  _fitDetailView();
  _updateDetailPanels(_detailGraph);
  _updateClusterActivityPanel(_detailGraph);
  _syncMaxEntitiesSlider(_detailGraph);
  _renderEntityTypeFilters(_detailGraph);
  _highlightAnchorLane(anchorId);
  _applyAccentLanes(_accentMap);
}

function _renderExploreDetail(route, store, w, lBg, lMeta, lRel, lCorr, lDf, lNodes, lLabels, cb, clusterId) {
  const entityIds = getEntitiesForHotspot(clusterId, { maxEntities: EXPLORE_ENTITY_LIMIT });
  if (!entityIds.length) return;
  const anchorId = entityIds[0];
  const compareIds = entityIds.slice(1);
  const maxEntitiesPerType = Number.isFinite(_filters.maxEntitiesPerType)
    ? _filters.maxEntitiesPerType
    : EXPLORE_MAX_ENTITIES_PER_TYPE;
  _detailGraph = getDetailGraph({
    anchorEntityId: anchorId,
    compareEntityIds: compareIds,
    visibleEntityTypes: _filters.visibleEntityTypes ?? undefined,
    activities: _effectiveDetailActivities(),
    maxEntitiesPerType,
    sharedOnly: true,
  });
  const layout = computeDetailLayout(_detailGraph, w);
  drawDetailView(layout, lBg, lMeta, lRel, lCorr, lMeta, lDf, lNodes, lLabels, vis, cb);
  _lastTotalHeight = layout.totalHeight;
  _applyVisibility();
  _applySelectionState();
  _fitDetailView();
  _updateDetailPanels(_detailGraph);
  _updateClusterActivityPanel(_detailGraph);
  _syncMaxEntitiesSlider(_detailGraph);
  _renderEntityTypeFilters(_detailGraph);
  _highlightAnchorLane(anchorId);
  _highlightFocusedCluster(clusterId);

  const hotspots = getGlobalSharedEventHotspots();
  const hotspot = hotspots.find(h => h.id === clusterId);
  if (hotspot) updateHotspotSummary(hotspot);
}

function _addOutlierBadges(overviewGraph) {
  if (!overviewGraph?.clusters?.length) return;
  const sizes = overviewGraph.clusters.map(c => c.nodeIds.length).sort((a, b) => a - b);
  const p10 = sizes[Math.floor(sizes.length * 0.1)] ?? 0;
  gRoot.selectAll(".cluster-label-group").each(function(d) {
    if (d?.nodeIds?.length <= p10 && d.nodeIds.length > 0) {
      d3.select(this).append("text")
        .attr("y", -12).attr("text-anchor", "middle")
        .attr("font-size", "8px").attr("font-weight", "700")
        .attr("fill", "#b45309")
        .text("outlier");
    }
  });
}

function _highlightAnchorLane(anchorId) {
  gRoot.selectAll(".entity-lane")
    .classed("anchor-lane", function() {
      return d3.select(this).attr("data-entity-id") === anchorId;
    });
}

function _applyAccentLanes(accentMap) {
  gRoot.selectAll(".entity-lane").each(function() {
    const id = d3.select(this).attr("data-entity-id");
    const color = accentMap[id];
    if (color) {
      d3.select(this).select(".lane-track")
        .style("stroke", color)
        .style("stroke-width", "2px")
        .style("opacity", "0.7");
    }
  });
}

function _highlightFocusedCluster(clusterId) {
  const activity = clusterId.startsWith("act:") ? clusterId.slice(4) : clusterId;
  gRoot.selectAll(".event-cluster").each(function(d) {
    if ((d?.activityCounts ?? []).some(item => item.activity === activity)) {
      d3.select(this).classed("event-cluster-focused", true);
    }
  });
}

// ── Callbacks for renderers ───────────────────────────────────────────────────
function _makeCallbacks(route) {
  return {
    onTooltipShow: _showTooltip,
    onTooltipHide: _hideTooltip,
    onPoSelect: entityId => navigate("identify", { entity: entityId }),
    onEntitySelect: entityId => navigate("identify", { entity: entityId }),
    onCommunitySelect: communityId => navigate("summarize", { community: communityId }),
    onVariantSelect: variantKey => {
      const current = route.params.variant;
      if (current === variantKey) navigate("compare");
      else navigate("compare", { variant: variantKey });
    },
    onEventSelect: d => {
      if (d?.kind === "event-cluster") _setClusterActivityContext(d);
      _toggleSelection(d?.kind === "event-cluster"
        ? { kind: "event-cluster", eventIds: d.ids ?? [], relatedEntityIds: d.sharedEntityIds ?? [] }
        : { kind: "event", eventId: d.id, relatedEntityIds: d.sharedEntityIds ?? [] });
    },
    onEdgeSelect: d => _toggleSelection({
      kind: "edge", edgeId: d.edgeId, entityId: d.entityId,
      sourceId: d.sourceId, targetId: d.targetId,
    }),
  };
}

// ── Top-bar setup ─────────────────────────────────────────────────────────────
function _setupTopbar() {
  document.getElementById("btn-home")?.addEventListener("click", () => navigate("home"));

  const switchBtn = document.getElementById("btn-switch-dataset");
  switchBtn?.addEventListener("click", () => _openDatasetModal());

  document.getElementById("btn-modal-close")?.addEventListener("click", () => _closeDatasetModal());
  document.getElementById("dataset-modal")?.addEventListener("click", e => {
    if (e.target === document.getElementById("dataset-modal")) _closeDatasetModal();
  });

  document.getElementById("btn-modal-open-file")?.addEventListener("click", () => {
    document.getElementById("file-input-modal")?.click();
  });
  document.getElementById("file-input-modal")?.addEventListener("change", async e => {
    const file = e.target.files[0];
    if (!file) return;
    _closeDatasetModal();
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

  document.getElementById("btn-fit")?.addEventListener("click", () => _fitCurrentView());
  document.getElementById("btn-reset-zoom")?.addEventListener("click", () => _resetZoom());

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

function _openDatasetModal() {
  const modal = document.getElementById("dataset-modal");
  const list  = document.getElementById("dataset-modal-list");
  if (!modal || !list) return;
  list.innerHTML = "";
  if (!_manifest.datasets.length) {
    list.innerHTML = `<div style="padding:12px;color:var(--text-muted);font-size:12px">No manifest found — use "Open local JSON file" below.</div>`;
  } else {
    _manifest.datasets.forEach(ds => {
      const row = document.createElement("div");
      row.className = "modal-dataset-row" + (ds.name === _currentDatasetName ? " active" : "");
      row.innerHTML = `<b>${_escHtml(ds.label)}</b><span>${_escHtml(ds.name)}</span>`;
      row.addEventListener("click", () => {
        _closeDatasetModal();
        const params = new URLSearchParams(window.location.search);
        params.set("dataset", ds.name);
        history.replaceState(null, "", `${window.location.pathname}?${params}${window.location.hash}`);
        _loadDataset(ds.name);
      });
      list.appendChild(row);
    });
  }
  modal.classList.remove("hidden");
}

function _closeDatasetModal() {
  document.getElementById("dataset-modal")?.classList.add("hidden");
}

// ── Tooltip ───────────────────────────────────────────────────────────────────
function _setupTooltip() {
  document.getElementById("canvas-wrap")?.addEventListener("mouseleave", () =>
    document.getElementById("tooltip")?.classList.remove("show")
  );
}

function _showTooltip(html, x, y) {
  const tip = document.getElementById("tooltip");
  if (!tip) return;
  tip.innerHTML = html;
  const wrap = document.getElementById("canvas-wrap");
  const rect = wrap.getBoundingClientRect();
  const tipW = tip.offsetWidth || 240;
  const tipH = tip.offsetHeight || 100;
  const left = x + tipW + 16 > rect.width  ? x - tipW - 10 : x + 14;
  const top  = y + tipH + 16 > rect.height ? y - tipH - 10 : y + 14;
  tip.style.left = `${left}px`;
  tip.style.top  = `${top}px`;
  tip.classList.add("show");
}

function _hideTooltip() {
  document.getElementById("tooltip")?.classList.remove("show");
}

// ── Sidebar panels ────────────────────────────────────────────────────────────
function _setupPanel() {
  document.getElementById("entity-search")?.addEventListener("input", e => {
    _entitySearchQuery = e.target.value.toLowerCase().trim();
    _updateSidebarList(true);
  });
}

function _setupEdgeControls() {
  const slider = document.getElementById("slider-max-entities");
  const sliderVal = document.getElementById("slider-max-entities-val");
  slider?.addEventListener("input", () => {
    const next = parseInt(slider.value, 10);
    const max  = parseInt(slider.max || slider.value, 10);
    _filters.maxEntitiesPerType = next >= max ? null : next;
    if (sliderVal) sliderVal.textContent = slider.value;
    const route = getRoute();
    if (route.name === "identify" || (route.name === "compare" && _compareMode === "compare") || (route.name === "explore" && route.params.cluster)) handleRoute(route);
  });
  if (sliderVal && slider) sliderVal.textContent = slider.value;

  document.getElementById("btn-shared-only")?.addEventListener("click", function() {
    _filters.sharedOnly = !_filters.sharedOnly;
    this.classList.toggle("active", _filters.sharedOnly);
    const route = getRoute();
    if (route.name === "identify" || (route.name === "compare" && _compareMode === "compare") || (route.name === "explore" && route.params.cluster)) handleRoute(route);
  });

  const toggleMap = {
    "toggle-df": "df", "toggle-corr": "corr", "toggle-relations": "relations",
    "toggle-sync": "sync", "toggle-bottleneck": "bottleneck",
  };
  Object.entries(toggleMap).forEach(([id, key]) => {
    document.getElementById(id)?.addEventListener("change", e => { vis[key] = e.target.checked; _applyVisibility(); });
  });

  const opaMap = { "opa-df": "df", "opa-corr": "corr", "opa-relations": "relations" };
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

  document.getElementById("btn-add-compare-entity")?.addEventListener("click", () => {
    const id = prompt("Enter entity ID to add to comparison:");
    if (!id) return;
    const route = getRoute();
    const current = (route.params.entities ?? "").split(",").filter(Boolean);
    if (!current.includes(id)) {
      navigate("compare", { entities: [...current, id].join(",") });
    }
  });
}

function _syncToggleButtons() {
  const route = getRoute();
  const forcedShared = route.name === "explore" && route.params.cluster;
  const btn = document.getElementById("btn-shared-only");
  if (!btn) return;
  btn.classList.toggle("active", _filters.sharedOnly || forcedShared);
  btn.textContent = forcedShared ? "Shared events only (T4)" : "Shared events only";
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
    item.querySelector("input").addEventListener("change", () => _onActivityToggle(activity, item.querySelector("input").checked));
    container.appendChild(item);
  });

  document.getElementById("btn-act-all")?.addEventListener("click", () => {
    container.querySelectorAll("input").forEach(cb => { cb.checked = true; });
    _filters.activities = null;
    _reconcileClusterActivityContext();
    handleRoute(getRoute());
  });
  document.getElementById("btn-act-none")?.addEventListener("click", () => {
    container.querySelectorAll("input").forEach(cb => { cb.checked = false; });
    _filters.activities = new Set();
    _reconcileClusterActivityContext();
    handleRoute(getRoute());
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
  _reconcileClusterActivityContext();
  handleRoute(getRoute());
}

function _renderEntityTypeFilters(detailGraph) {
  const container = document.getElementById("entity-type-list");
  if (!container) return;
  container.innerHTML = "";
  const selected = _filters.visibleEntityTypes ? new Set(_filters.visibleEntityTypes) : new Set(detailGraph.visibleEntityTypes);
  detailGraph.visibleEntityTypes.forEach(type => {
    const row = document.createElement("label");
    row.className = "toggle-row";
    row.innerHTML = `<input type="checkbox" ${selected.has(type) ? "checked" : ""}><span>${type}</span>`;
    row.querySelector("input").addEventListener("change", e => {
      const next = _filters.visibleEntityTypes ? new Set(_filters.visibleEntityTypes) : new Set(detailGraph.visibleEntityTypes);
      if (e.target.checked) next.add(type); else next.delete(type);
      _filters.visibleEntityTypes = next.size === detailGraph.visibleEntityTypes.length ? null : [...next];
      handleRoute(getRoute());
    });
    container.appendChild(row);
  });
}

function _syncMaxEntitiesSlider(detailGraph) {
  const slider = document.getElementById("slider-max-entities");
  const sliderVal = document.getElementById("slider-max-entities-val");
  if (!slider || !sliderVal) return;
  if (!detailGraph) { slider.min = "1"; slider.max = "1"; slider.value = "1"; slider.disabled = true; sliderVal.textContent = "-"; return; }
  const maxValue = Math.max(1, detailGraph.maxAvailableEntitiesPerType ?? 1);
  const minValue = maxValue > 1 ? 1 : maxValue;
  let effectiveValue = maxValue;
  if (Number.isFinite(_filters.maxEntitiesPerType)) effectiveValue = Math.max(minValue, Math.min(_filters.maxEntitiesPerType, maxValue));
  slider.min = String(minValue); slider.max = String(maxValue); slider.value = String(effectiveValue);
  slider.disabled = maxValue <= 1; sliderVal.textContent = String(effectiveValue);
  if (Number.isFinite(_filters.maxEntitiesPerType) && _filters.maxEntitiesPerType >= maxValue) _filters.maxEntitiesPerType = null;
}

// ── Keyboard camera ───────────────────────────────────────────────────────────
function _setupCanvasKeyboard() {
  const wrap = document.getElementById("canvas-wrap");
  if (!wrap) return;
  wrap.addEventListener("pointerdown", () => wrap.focus({ preventScroll: true }));
  wrap.addEventListener("wheel", _handleCanvasWheel, { passive: false });
  wrap.addEventListener("keydown", event => {
    const action = _keyboardCameraAction(event);
    if (!action) return;
    event.preventDefault();
    if (action === "fit") { _fitCurrentView(); return; }
    if (action === "reset") { _resetZoom(); return; }
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
  window.addEventListener("keydown", event => {
    if (event.defaultPrevented) return;
    if (!_isCanvasRouteActive() || _isTypingTarget(event.target)) return;
    const action = _keyboardCameraAction(event);
    if (!action) return;
    event.preventDefault();
    wrap.focus({ preventScroll: true });
    if (action === "fit") { _fitCurrentView(); return; }
    if (action === "reset") { _resetZoom(); return; }
    _keyboardCameraKeys.add(action);
    _startKeyboardCameraLoop();
  });
  window.addEventListener("keyup", event => {
    if (event.defaultPrevented) return;
    const action = _keyboardCameraAction(event);
    if (!action || action === "fit" || action === "reset") return;
    _keyboardCameraKeys.delete(action);
    if (!_keyboardCameraKeys.size) _stopKeyboardCameraLoop();
  });
}

function _handleCanvasWheel(event) {
  if (!_isCanvasRouteActive() || !svg) return;
  event.preventDefault();
  const rect = svg.node().getBoundingClientRect();
  const px = event.clientX - rect.left;
  const py = event.clientY - rect.top;
  const absX = Math.abs(event.deltaX);
  const absY = Math.abs(event.deltaY);
  const isTrackpadPan = !event.ctrlKey && !event.metaKey
    && event.deltaMode === 0
    && (absX > 0 || absY < TRACKPAD_PAN_THRESHOLD);
  const t = currentTransform ?? d3.zoomIdentity;
  if (isTrackpadPan) {
    _applyTransform(d3.zoomIdentity.translate(t.x - event.deltaX, t.y - event.deltaY).scale(t.k));
    return;
  }
  const normalized = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
  const scaleFactor = Math.exp(-normalized * 0.0018);
  _applyTransform(_zoomTransformAroundPoint(t, scaleFactor, px, py));
}

function _isCanvasRouteActive() {
  const route = getRoute();
  return !(route.name === "home" || (route.name === "explore" && !route.params.cluster) || (route.name === "identify" && !route.params.entity));
}

function _isTypingTarget(target) {
  const tag = target?.tagName?.toLowerCase?.();
  return tag === "input" || tag === "textarea" || tag === "select" || target?.isContentEditable;
}

function _keyboardCameraAction(event) {
  const { key } = event;
  if (key === "ArrowLeft"  || key === "a" || key === "A") return "pan-left";
  if (key === "ArrowRight" || key === "d" || key === "D") return "pan-right";
  if (key === "ArrowUp"    || key === "w" || key === "W") return "pan-up";
  if (key === "ArrowDown"  || key === "s" || key === "S") return "pan-down";
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
  if (_keyboardCameraFrame) { window.cancelAnimationFrame(_keyboardCameraFrame); _keyboardCameraFrame = null; }
  _keyboardCameraLastTs = 0;
}

function _clearKeyboardCamera() { _keyboardCameraKeys.clear(); _stopKeyboardCameraLoop(); }

function _tickKeyboardCamera(timestamp) {
  _keyboardCameraFrame = null;
  if (!_keyboardCameraKeys.size || !svg) return;
  const dt = Math.min(((timestamp - (_keyboardCameraLastTs || timestamp)) || 16) / 1000, 0.05);
  _keyboardCameraLastTs = timestamp;
  let dx = 0, dy = 0, zDir = 0;
  if (_keyboardCameraKeys.has("pan-left"))  dx += KEYBOARD_PAN_SPEED * dt;
  if (_keyboardCameraKeys.has("pan-right")) dx -= KEYBOARD_PAN_SPEED * dt;
  if (_keyboardCameraKeys.has("pan-up"))    dy += KEYBOARD_PAN_SPEED * dt;
  if (_keyboardCameraKeys.has("pan-down"))  dy -= KEYBOARD_PAN_SPEED * dt;
  if (_keyboardCameraKeys.has("zoom-in"))   zDir += 1;
  if (_keyboardCameraKeys.has("zoom-out"))  zDir -= 1;
  let t = currentTransform ?? d3.zoomIdentity;
  if (dx || dy) t = d3.zoomIdentity.translate(t.x + dx, t.y + dy).scale(t.k);
  if (zDir) {
    const wrap = document.getElementById("canvas-wrap");
    const rect = wrap?.getBoundingClientRect?.();
    const cx = rect ? rect.width / 2 : svg.node().clientWidth / 2;
    const cy = rect ? rect.height / 2 : svg.node().clientHeight / 2;
    t = _zoomTransformAroundPoint(t, Math.exp(zDir * KEYBOARD_ZOOM_RATE * dt), cx, cy);
  }
  _applyTransform(t);
  if (_keyboardCameraKeys.size) _keyboardCameraFrame = window.requestAnimationFrame(_tickKeyboardCamera);
}

function _zoomTransformAroundPoint(transform, scaleFactor, px, py) {
  const s = transform ?? d3.zoomIdentity;
  const nextScale = Math.max(ZOOM_MIN_SCALE, Math.min(ZOOM_MAX_SCALE, s.k * scaleFactor));
  if (!Number.isFinite(nextScale) || nextScale === s.k) return s;
  const wx = (px - s.x) / s.k;
  const wy = (py - s.y) / s.k;
  return d3.zoomIdentity.translate(px - wx * nextScale, py - wy * nextScale).scale(nextScale);
}

function _applyTransform(transform) {
  if (!svg || !zoom || !transform) return;
  svg.interrupt();
  svg.call(zoom.transform, transform);
}

// ── Sidebar entity lists ──────────────────────────────────────────────────────
function _buildCommunityList(clusters) {
  document.getElementById("entity-list-label").textContent = "Communities";
  const container = document.getElementById("entity-list");
  if (!container) return;
  container.innerHTML = "";
  clusters.forEach(cluster => {
    const item = document.createElement("div");
    item.className = "entity-item community-item";
    item.dataset.id = cluster.id;
    item.innerHTML = `<span class="community-dot" style="background:${clusterColor(cluster.id, 0.85)}"></span><span class="entity-id">${cluster.label}</span><span class="entity-meta">${cluster.count} members</span>`;
    item.addEventListener("click", () => navigate("summarize", { community: cluster.id }));
    container.appendChild(item);
  });
}

function _buildCaseList(store, communityId = null) {
  const container = document.getElementById("entity-list");
  if (!container) return;
  container.innerHTML = "";
  const community = communityId ? store.communities?.find(c => c.id === communityId) : null;
  document.getElementById("entity-list-label").textContent = community ? community.label : `${store.caseType ?? "Case"}s`;
  let list = store.caseList;
  if (community) { const memberSet = new Set(community.nodeIds); list = list.filter(c => memberSet.has(c.id)); }
  list.slice(0, 200).forEach(item => {
    const row = document.createElement("div");
    row.className = "entity-item";
    row.dataset.id = item.id;
    row.innerHTML = `<span class="entity-id">${item.id}</span><span class="entity-meta">${item.itemCount} related - ${item.eventCount} events</span>`;
    row.addEventListener("click", () => navigate("identify", { entity: item.id }));
    container.appendChild(row);
  });
}

function _buildEntityList(store, query = "") {
  document.getElementById("entity-list-label").textContent = query ? "Entity search" : "Entities";
  const container = document.getElementById("entity-list");
  if (!container) return;
  container.innerHTML = "";
  const q = query.trim().toLowerCase();
  store.entityList
    .filter(it => !q || it.label.toLowerCase().includes(q) || it.id.toLowerCase().includes(q) || it.type.toLowerCase().includes(q))
    .slice(0, 250).forEach(item => {
      const row = document.createElement("div");
      row.className = "entity-item";
      row.dataset.id = item.id;
      row.innerHTML = `<span class="entity-id">${item.label}</span><span class="entity-meta">${item.type} - ${item.eventCount} events</span>`;
      row.addEventListener("click", () => navigate("identify", { entity: item.id }));
      container.appendChild(row);
    });
}

function _buildGroupedEntityList(store, query = "") {
  const labelEl = document.getElementById("entity-list-label");
  if (labelEl) labelEl.textContent = query ? "Search results" : "Select entity";
  const container = document.getElementById("entity-list");
  if (!container) return;
  container.innerHTML = "";
  const q = query.trim().toLowerCase();
  const filtered = store.entityList
    .filter(it => !q || it.label.toLowerCase().includes(q) || it.id.toLowerCase().includes(q) || it.type.toLowerCase().includes(q));
  const reg = store.typeRegistry;
  const orderedTypes = reg?.orderedNames ?? [...new Set(filtered.map(e => e.type))];
  orderedTypes.forEach(type => {
    const typeItems = filtered.filter(e => e.type === type);
    if (!typeItems.length) return;
    const typeInfo = reg?.byName[type];
    const header = document.createElement("div");
    header.className = "entity-type-header";
    header.innerHTML = `<span class="entity-type-dot" style="background:${typeInfo?.color ?? "#64748b"}"></span><span>${type}</span>`;
    container.appendChild(header);
    typeItems.slice(0, 60).forEach(item => {
      const row = document.createElement("div");
      row.className = "entity-item";
      row.dataset.id = item.id;
      row.innerHTML = `<span class="entity-id">${item.label}</span><span class="entity-meta">${item.eventCount} ev</span>`;
      row.addEventListener("click", () => navigate("identify", { entity: item.id }));
      container.appendChild(row);
    });
    if (typeItems.length > 60) {
      const more = document.createElement("div");
      more.className = "entity-more-note";
      more.textContent = `+${typeItems.length - 60} more — search above`;
      container.appendChild(more);
    }
  });
}

function _updateSidebarList(force = false) {
  const route = getRoute();
  const actKey = _filters.activities ? [..._filters.activities].sort().join(",") : "*";
  const key = `${route.name}:${route.params.community ?? ""}:${route.params.variant ?? ""}:${route.params.entity ?? ""}:${_entitySearchQuery}:${actKey}`;
  if (!force && key === _lastListKey) return;
  _lastListKey = key;
  const store = (() => { try { return getStore(); } catch { return null; } })();
  if (!store) return;
  if (route.name === "compare" && _compareMode === "variants") return;
  const isIdentify = route.name === "identify"
    || (route.name === "compare" && _compareMode === "compare")
    || (route.name === "explore" && route.params.cluster);
  if (_entitySearchQuery) {
    if (isIdentify) _buildGroupedEntityList(store, _entitySearchQuery);
    else _buildEntityList(store, _entitySearchQuery);
    return;
  }
  if (route.name === "summarize" && !route.params.community) {
    const graph = getOverviewGraph({ activities: _filters.activities });
    _buildCommunityList(graph.clusters);
  } else if (route.name === "summarize" && route.params.community) {
    _buildCaseList(store, route.params.community);
  } else if (isIdentify) {
    _buildGroupedEntityList(store);
    if (route.params.entity) _setActiveEntityInList(route.params.entity);
  } else {
    _buildEntityList(store);
    if (route.params.entity) _setActiveEntityInList(route.params.entity);
  }
}

function _setActiveEntityInList(entityId) {
  document.querySelectorAll(".entity-item").forEach(el => el.classList.toggle("active", el.dataset.id === entityId));
}

function _updateHeaderTags(route, store) {
  const tagEl = document.getElementById("panel-view-tag");
  if (!tagEl) return;
  const names = { home: "HOME", identify: "LIFECYCLE", compare: "COMPARE", summarize: "OVERVIEW", explore: "EXPLORE" };
  tagEl.textContent = names[route.name] ?? route.name.toUpperCase();
}

function _updateStatusBar(store) {
  if (!store) return;
  document.getElementById("status-events").innerHTML = `Events: <b>${store.events.length.toLocaleString()}</b>`;
  document.getElementById("status-entities").innerHTML = `Entities: <b>${store.entities.length.toLocaleString()}</b>`;
  const route = getRoute();
  let tail = `${store.caseType ?? "Cases"}: <b>${store.caseList.length.toLocaleString()}</b>`;
  if (route.name === "summarize" && !route.params.community) tail = `Communities: <b>${store.communities?.length?.toLocaleString?.() ?? 0}</b>`;
  else if (route.name === "summarize" && route.params.community) {
    const c = store.communities?.find(x => x.id === route.params.community);
    tail = `${store.caseType ?? "Cases"}: <b>${c?.nodeIds?.length?.toLocaleString?.() ?? 0}</b>`;
  } else if (route.name === "compare" && _compareMode === "variants") {
    tail = `Variants: <b>${_variantData?.variantCount?.toLocaleString?.() ?? 0}</b>`;
  } else if (route.name === "identify" && route.params.entity) {
    tail = `Focus: <b>${route.params.entity}</b>`;
  }
  document.getElementById("status-cases").innerHTML = tail;
}

// ── Detail panels (reused across identify/compare/explore) ────────────────────
function _updateDetailPanels(detailGraph) {
  const summaryContent = document.getElementById("detail-summary-content");
  const sharedList = document.getElementById("shared-event-list");
  if (!summaryContent || !sharedList) return;
  if (!detailGraph) {
    summaryContent.innerHTML = `<div class="stat-row"><span class="stat-label">Open any entity to inspect a typed EKG slice.</span></div>`;
    sharedList.innerHTML = `<div class="empty-note">Shared events will appear here in detail view.</div>`;
    document.getElementById("entity-type-list").innerHTML = "";
    return;
  }
  const s = detailGraph.summary;
  document.getElementById("detail-summary-title").textContent = `${detailGraph.anchorEntityType} ${detailGraph.anchorEntityId}`;
  summaryContent.innerHTML = _rowsToHtml([
    { label: "Scope",         value: _detailScopeLabel(detailGraph.scope) },
    { label: "Entity types",  value: s.visibleEntityTypeCount },
    { label: "Entities",      value: s.visibleEntityCount },
    { label: "Events",        value: s.eventCount },
    { label: "Relations",     value: s.relationCount },
    { label: "Shared events", value: s.sharedEventCount },
    { divider: true },
    { label: "Parallel bands",   value: _formatParallelBandPreview(s.parallelEntityTypes), className: "flow" },
    { label: "Bottleneck p75",   value: Number.isFinite(s.bottleneckThresholdHours) ? `${s.bottleneckThresholdHours.toFixed(1)}h` : "n/a" },
  ]);

  const hotspots = s.sharedEventHotspots ?? [];
  sharedList.innerHTML = !hotspots.length
    ? `<div class="empty-note">No shared events in the current focus.</div>`
    : hotspots.map(item => `
        <div class="shared-item" data-event-id="${item.event_id}">
          <span class="shared-activity">${item.activity}</span>
          <span class="shared-meta">${item.entityCount} entities — ${item.entityTypes.join(", ")}</span>
        </div>`).join("");
  sharedList.querySelectorAll(".shared-item").forEach(el => {
    el.addEventListener("click", () => _toggleSelection({
      kind: "event", eventId: el.dataset.eventId,
      relatedEntityIds: detailGraph.sharedEvents.find(x => x.event_id === el.dataset.eventId)?.sharedEntityIds ?? [],
    }));
  });
}

function _updateClusterActivityPanel(detailGraph) {
  const panel   = document.getElementById("cluster-activity-panel");
  const title   = document.getElementById("cluster-activity-title");
  const content = document.getElementById("cluster-activity-content");
  if (!panel || !title || !content) return;
  const cluster = _clusterActivityContext;
  if (!detailGraph || !cluster || (cluster.activityCounts?.length ?? 0) <= 1) {
    panel.classList.add("hidden"); content.innerHTML = ""; return;
  }
  const sel = cluster.selectedActivity ?? null;
  const visible = cluster.activityCounts.filter(x => !_filters.activities || _filters.activities.has(x.activity));
  const hiddenCount = cluster.activityCounts.length - visible.length;
  panel.classList.remove("hidden");
  content.innerHTML = `
    <div class="cluster-filter-meta">Shared cluster with <b>${cluster.eventIds.length}</b> events across <b>${cluster.activityCounts.length}</b> event types.${sel ? `<br>Detail filter: <b>${sel}</b>` : ""}</div>
    <div class="cluster-filter-buttons">
      ${cluster.activityCounts.map(item => `
        <button type="button" class="cluster-filter-chip${sel === item.activity ? " active" : ""}" data-activity="${_escAttr(item.activity)}" ${_filters.activities && !_filters.activities.has(item.activity) ? "disabled" : ""}>
          <span class="cluster-filter-dot" style="background:${item.color ?? "#64748b"}"></span>
          <span>${item.activity}</span>
          <span class="cluster-filter-count">${item.count}</span>
        </button>`).join("")}
    </div>
    <div class="cluster-filter-actions">
      <button type="button" class="btn btn-xs" id="btn-clear-cluster-filter"${sel ? "" : " disabled"}>Clear filter</button>
      <button type="button" class="btn btn-xs" id="btn-close-cluster-filter">Close</button>
    </div>
    ${hiddenCount > 0 ? `<div class="cluster-filter-note">${hiddenCount} event type${hiddenCount === 1 ? "" : "s"} hidden by the global activity filter.</div>` : `<div class="cluster-filter-note">Click an event type to keep only that activity in the current detail view.</div>`}
  `;
  content.querySelectorAll(".cluster-filter-chip").forEach(btn => btn.addEventListener("click", () => _toggleClusterActivity(btn.dataset.activity)));
  content.querySelector("#btn-clear-cluster-filter")?.addEventListener("click", () => {
    if (!_clusterActivityContext?.selectedActivity) return;
    _clusterActivityContext = { ..._clusterActivityContext, selectedActivity: null };
    handleRoute(getRoute());
  });
  content.querySelector("#btn-close-cluster-filter")?.addEventListener("click", () => _dismissClusterActivityContext());
}

function _updateOverviewPanels(overviewGraph) {
  const title = document.getElementById("overview-summary-title");
  const content = document.getElementById("overview-summary-content");
  if (!title || !content) return;
  if (!overviewGraph) { title.textContent = "Overview Summary"; content.innerHTML = `<div class="stat-row"><span class="stat-label">Open overview or a community to see summary statistics.</span></div>`; return; }
  const route = getRoute();
  if (route.name === "summarize" && route.params.community) {
    const community = overviewGraph.clusters?.[0];
    title.textContent = community?.label ?? "Community Summary";
    content.innerHTML = _rowsToHtml([
      { label: "Members",      value: overviewGraph.meta.caseCount },
      { label: "Events shown", value: overviewGraph.meta.filteredEvents },
      { label: "Books shown",  value: overviewGraph.meta.shownItems },
      { label: "Case links",   value: overviewGraph.meta.overviewEdgeCount },
      { label: "Resources",    value: community?.resources?.length ?? 0 },
      { label: "Attributes",   value: community?.attributes?.length ?? 0 },
    ]);
    return;
  }
  title.textContent = "Overview Summary";
  content.innerHTML = _rowsToHtml([
    { label: "Communities",      value: overviewGraph.meta.clusterCount },
    { label: "Cases shown",      value: overviewGraph.meta.caseCount },
    { label: "Events shown",     value: overviewGraph.meta.filteredEvents },
    { label: "Books shown",      value: overviewGraph.meta.shownItems },
    { label: "Case links",       value: overviewGraph.meta.overviewEdgeCount },
    { label: "Community links",  value: overviewGraph.meta.overviewCommunityEdgeCount },
  ]);
}

function _updateVariantPanels(variantData, selectedVariant) {
  const summaryTitle   = document.getElementById("variant-summary-title");
  const summaryContent = document.getElementById("variant-summary-content");
  const itemLabel      = document.getElementById("variant-item-list-label");
  const itemList       = document.getElementById("variant-item-list");
  const memberLabel    = document.getElementById("variant-member-list-label");
  const memberList     = document.getElementById("variant-member-list");
  if (!summaryTitle || !summaryContent || !itemLabel || !itemList || !memberLabel || !memberList) return;
  if (!variantData) {
    summaryTitle.textContent = "Variant Summary";
    summaryContent.innerHTML = `<div class="stat-row"><span class="stat-label">Open the variants view to inspect process variants.</span></div>`;
    itemLabel.textContent = "Books in variant"; memberLabel.textContent = "Members in variant";
    itemList.innerHTML = `<div class="empty-note">Select a variant to list its books.</div>`;
    memberList.innerHTML = `<div class="empty-note">Select a variant to list its members.</div>`;
    return;
  }
  itemLabel.textContent   = `${variantData.itemType ?? "Items"} in variant`;
  memberLabel.textContent = `${variantData.caseType ?? "Cases"} in variant`;
  if (!selectedVariant) {
    summaryTitle.textContent = "Variant Overview";
    summaryContent.innerHTML = _rowsToHtml([
      { label: "Variants",      value: variantData.variantCount },
      { label: "Shown rows",    value: variantData.variants.length },
      { label: "Instances",     value: variantData.totalInstances },
      { label: "Top share",     value: formatPercent(variantData.summary?.dominantVariantShare ?? 0) },
      { label: "Avg variant size", value: (variantData.summary?.averageVariantSize ?? 0).toFixed(1) },
      { label: "Avg sequence length", value: (variantData.summary?.averageSequenceLength ?? 0).toFixed(1) },
      { divider: true },
      { label: "Selection", value: "Click a variant row to inspect it", className: "flow" },
    ]);
    itemList.innerHTML   = `<div class="empty-note">Select a variant to list its ${variantData.itemType?.toLowerCase?.() ?? "items"}.</div>`;
    memberList.innerHTML = `<div class="empty-note">Select a variant to list its ${variantData.caseType?.toLowerCase?.() ?? "cases"}.</div>`;
    return;
  }
  summaryTitle.textContent = `Variant ${selectedVariant.rank}`;
  summaryContent.innerHTML = _rowsToHtml([
    { label: "Dominant",       value: selectedVariant.isdominant ? "Yes" : "No" },
    { label: "Share",          value: formatPercent(selectedVariant.frequency) },
    { label: "Instances",      value: selectedVariant.count },
    { label: variantData.caseType ?? "Cases", value: selectedVariant.memberCount },
    { label: variantData.itemType ?? "Items", value: selectedVariant.itemCount },
    { label: "Events",         value: selectedVariant.eventTotal },
    { label: "Avg events/item",value: selectedVariant.eventAverage.toFixed(1) },
    { label: "Avg duration",   value: _formatHoursLabel(selectedVariant.avgDurationHours) },
    { label: "Resources",      value: selectedVariant.resourceCount },
    { divider: true },
    { label: "Sequence",        value: _formatSequencePreview(selectedVariant.sequence), className: "flow" },
    { label: "Top resources",   value: _formatCountList(selectedVariant.topResources, "label"), className: "flow" },
    { label: "Top activities",  value: _formatCountList(selectedVariant.topActivities, "activity"), className: "flow" },
    { label: "Time range",      value: _formatDateRange(selectedVariant.firstDate, selectedVariant.lastDate), className: "flow" },
  ]);
  // "Compare top 3" button
  const topItems = (selectedVariant.items ?? []).slice(0, 3).map(x => x.id);
  if (topItems.length > 1) {
    summaryContent.innerHTML += `<div style="margin-top:10px"><button type="button" class="btn btn-sm" id="btn-compare-top3">Compare top ${topItems.length}</button></div>`;
    summaryContent.querySelector("#btn-compare-top3")?.addEventListener("click", () => {
      navigate("compare", { entities: topItems.join(",") });
    });
  }
  _renderVariantEntityList(itemList, selectedVariant.items, item => `${item.eventCount} events`, "id");
  _renderVariantEntityList(memberList, selectedVariant.members, member => `${member.itemCount} items – ${member.eventCount} events`, "id");
}

function _renderVariantEntityList(container, items, metaBuilder, idKey) {
  container.innerHTML = "";
  const rows = (items ?? []).slice(0, 50);
  if (!rows.length) { container.innerHTML = `<div class="empty-note">No entities in this variant.</div>`; return; }
  rows.forEach(item => {
    const row = document.createElement("div");
    row.className = "entity-item";
    row.dataset.id = item[idKey];
    row.innerHTML = `<span class="entity-id">${item.label}</span><span class="entity-meta">${metaBuilder(item)}</span>`;
    row.addEventListener("click", () => navigate("identify", { entity: item[idKey] }));
    container.appendChild(row);
  });
}

// ── Legend ────────────────────────────────────────────────────────────────────
function _renderLegend() {
  const el = document.getElementById("legend-content");
  if (!el) return;
  el.innerHTML = `
    <div class="legend-item"><span class="legend-swatch legend-event"></span><span>Event anchor</span></div>
    <div class="legend-item"><span class="legend-swatch legend-shared"></span><span>Shared-event cluster</span></div>
    <div class="legend-item"><span class="legend-swatch legend-df"></span><span>DF edge</span></div>
    <div class="legend-item"><span class="legend-swatch legend-bottleneck"></span><span>Bottleneck DF edge</span></div>
    <div class="legend-item"><span class="legend-swatch legend-corr"></span><span>Correlation link</span></div>
    <div class="legend-item"><span class="legend-swatch legend-relation"></span><span>Entity relation</span></div>
  `;
}

// ── Cluster activity context ──────────────────────────────────────────────────
function _effectiveDetailActivities() {
  const scoped = _clusterActivityContext?.selectedActivity ?? null;
  if (!scoped) return _filters.activities;
  if (_filters.activities === null) return new Set([scoped]);
  if (_filters.activities.size === 0) return new Set();
  return _filters.activities.has(scoped) ? new Set([scoped]) : new Set();
}

function _setClusterActivityContext(cluster) {
  if (!cluster) { _clusterActivityContext = null; return; }
  const prev = _clusterActivityContext;
  const next = {
    clusterId: String(cluster.clusterId ?? cluster.id ?? ""),
    eventIds: (cluster.ids ?? cluster.eventIds ?? []).map(id => String(id)),
    sharedEntityIds: (cluster.sharedEntityIds ?? []).map(id => String(id)),
    activityCounts: [...(cluster.activityCounts ?? [])].map(x => ({ activity: x.activity, color: x.color, count: x.count ?? 0 })).sort((a, b) => b.count - a.count || a.activity.localeCompare(b.activity)),
    selectedActivity: null,
  };
  if (prev?.clusterId === next.clusterId && prev.selectedActivity && next.activityCounts.some(x => x.activity === prev.selectedActivity)) {
    next.selectedActivity = prev.selectedActivity;
  }
  _clusterActivityContext = next;
  _reconcileClusterActivityContext();
  _updateClusterActivityPanel(_detailGraph);
}

function _reconcileClusterActivityContext() {
  if (!_clusterActivityContext) return;
  const available = new Set((_clusterActivityContext.activityCounts ?? []).map(x => x.activity));
  if (!available.size) { _clusterActivityContext = null; return; }
  if (_clusterActivityContext.selectedActivity && !available.has(_clusterActivityContext.selectedActivity))
    _clusterActivityContext = { ..._clusterActivityContext, selectedActivity: null };
  if (_clusterActivityContext.selectedActivity && _filters.activities && !_filters.activities.has(_clusterActivityContext.selectedActivity))
    _clusterActivityContext = { ..._clusterActivityContext, selectedActivity: null };
}

function _toggleClusterActivity(activity) {
  if (!_clusterActivityContext) return;
  _clusterActivityContext = { ..._clusterActivityContext, selectedActivity: _clusterActivityContext.selectedActivity === activity ? null : activity };
  _reconcileClusterActivityContext();
  handleRoute(getRoute());
}

function _dismissClusterActivityContext() {
  const had = Boolean(_clusterActivityContext?.selectedActivity);
  _clusterActivityContext = null;
  if (had) handleRoute(getRoute());
  else _updateClusterActivityPanel(_detailGraph);
}

// ── Visibility / selection ────────────────────────────────────────────────────
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

function _clearSelection() { _selection = null; _applySelectionState(); }

function _applySelectionState() {
  if (!gRoot) return;
  const anchors  = gRoot.selectAll(".event-anchor-core, .event-cluster-core");
  const markers  = gRoot.selectAll(".lane-marker-circle");
  const dfEdges  = gRoot.selectAll(".df-link");
  const lanes    = gRoot.selectAll(".entity-lane");
  const corrLinks = gRoot.selectAll(".corr-link");
  anchors.classed("highlighted", false).classed("dimmed", false);
  markers.classed("highlighted", false).classed("dimmed", false);
  dfEdges.classed("edge-highlighted", false).classed("edge-dimmed", false);
  lanes.classed("item-highlighted", false).classed("item-dimmed", false);
  corrLinks.classed("edge-highlighted", false).classed("edge-dimmed", false);
  if (!_selection) return;
  if (_selection.kind === "event" || _selection.kind === "event-cluster") {
    const selIds = new Set((_selection.kind === "event" ? [_selection.eventId] : (_selection.eventIds ?? [])).map(id => String(id)));
    const related = new Set(_selection.relatedEntityIds ?? []);
    anchors.classed("highlighted", function() { return _datumIntersectsEvents(d3.select(this.parentNode).datum(), selIds); })
           .classed("dimmed",      function() { return !_datumIntersectsEvents(d3.select(this.parentNode).datum(), selIds); });
    markers.classed("highlighted", function() { return selIds.has(d3.select(this.parentNode).attr("data-event-id")); })
           .classed("dimmed",      function() { return !selIds.has(d3.select(this.parentNode).attr("data-event-id")); });
    lanes.classed("item-highlighted", function() { return related.has(d3.select(this).attr("data-entity-id")); })
         .classed("item-dimmed",      function() { return related.size ? !related.has(d3.select(this).attr("data-entity-id")) : false; });
    corrLinks.classed("edge-highlighted", function() { return selIds.has(d3.select(this).attr("data-event-id")); })
             .classed("edge-dimmed",      function() { return !selIds.has(d3.select(this).attr("data-event-id")); });
  } else if (_selection.kind === "edge") {
    const activeEvts = new Set([_selection.sourceId, _selection.targetId].map(id => String(id)));
    anchors.classed("highlighted", function() { return _datumIntersectsEvents(d3.select(this.parentNode).datum(), activeEvts); })
           .classed("dimmed",      function() { return !_datumIntersectsEvents(d3.select(this.parentNode).datum(), activeEvts); });
    markers.classed("highlighted", function() { return activeEvts.has(d3.select(this.parentNode).attr("data-event-id")); })
           .classed("dimmed",      function() { return !activeEvts.has(d3.select(this.parentNode).attr("data-event-id")); });
    dfEdges.classed("edge-highlighted", function() { return d3.select(this).attr("data-edge-id") === _selection.edgeId; })
           .classed("edge-dimmed",      function() { return d3.select(this).attr("data-edge-id") !== _selection.edgeId; });
    lanes.classed("item-highlighted", function() { return d3.select(this).attr("data-entity-id") === _selection.entityId; })
         .classed("item-dimmed",      function() { return d3.select(this).attr("data-entity-id") !== _selection.entityId; });
  }
}

function _datumIntersectsEvents(datum, eventIds) {
  if (!datum || !eventIds?.size) return false;
  if (datum.event_id) return eventIds.has(String(datum.event_id));
  return (datum.eventIds ?? []).some(id => eventIds.has(String(id)));
}

// ── Camera ────────────────────────────────────────────────────────────────────
function _fitToView(totalHeight, options = {}) {
  if (!svg) return;
  const transform = computeFitTransform(svg, gRoot, totalHeight, options);
  if (!transform) return;
  svg.transition().duration(CAMERA_EASE_MS).ease(d3.easeCubicOut).call(zoom.transform, transform);
}

function _fitCurrentView() {
  const route = getRoute();
  if (route.name === "identify" || (route.name === "compare" && _compareMode === "compare") || (route.name === "explore" && route.params.cluster)) _fitDetailView();
  else _fitToView(_lastTotalHeight);
}

function _fitDetailView() {
  _fitToView(_lastTotalHeight, { alignTop: true, alignLeft: true, minScale: 0.34, padX: 28, padY: 26, preferWidth: true });
}

function _resetZoom() {
  svg?.transition().duration(CAMERA_EASE_MS).ease(d3.easeCubicOut).call(zoom.transform, d3.zoomIdentity);
}

// ── Sidebar resize ────────────────────────────────────────────────────────────
function _setupSidebarResize() {
  const resizer = document.getElementById("sidebar-resizer");
  const sidebar = document.getElementById("sidebar");
  if (!resizer || !sidebar) return;
  let startX, startW;
  resizer.addEventListener("mousedown", e => {
    startX = e.clientX; startW = sidebar.offsetWidth;
    resizer.classList.add("dragging");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const onMove = e2 => {
      const w = Math.max(220, Math.min(560, startW + (e2.clientX - startX)));
      sidebar.style.width = `${w}px`; sidebar.style.minWidth = `${w}px`;
    };
    const onUp = () => {
      resizer.classList.remove("dragging");
      document.body.style.cursor = ""; document.body.style.userSelect = "";
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      handleRoute(getRoute());
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}

function _handleResize() {
  if (_resizeTimer) clearTimeout(_resizeTimer);
  _resizeTimer = setTimeout(() => {
    if (!svg) return;
    try { getStore(); } catch { return; }
    handleRoute(getRoute());
  }, 100);
}

// ── Utils ─────────────────────────────────────────────────────────────────────
function _rowsToHtml(rows) {
  return rows.map(r => r.divider
    ? `<div class="stat-divider"></div>`
    : `<div class="stat-row ${r.className ? `stat-row-${r.className}` : ""}"><span class="stat-label">${r.label}</span><span class="stat-val ${r.className ? `stat-val-${r.className}` : ""}">${r.value}</span></div>`
  ).join("");
}

function _detailScopeLabel(scope) {
  if (scope === "item-focus")  return "Selected book/item overlap only";
  if (scope === "case-focus")  return "Selected member/case overlap only";
  return "Local neighborhood";
}

function _formatSequencePreview(seq = []) {
  if (!seq.length) return "none";
  const p = seq.slice(0, 5).join(" → ");
  return seq.length > 5 ? `${p} (+${seq.length - 5} more)` : p;
}

function _formatCountList(items = [], labelKey) {
  if (!items.length) return "none";
  return items.slice(0, 3).map(x => `${x[labelKey]} (${x.count})`).join(", ");
}

function _formatHoursLabel(hours) {
  if (!Number.isFinite(hours)) return "n/a";
  if (hours >= 24) return `${(hours / 24).toFixed(1)}d`;
  return `${hours.toFixed(hours >= 10 ? 0 : 1)}h`;
}

function _formatDateRange(first, last) {
  if (!(first instanceof Date) || isNaN(first.getTime()) || !(last instanceof Date) || isNaN(last.getTime())) return "n/a";
  return `${first.toLocaleDateString("en-GB")} → ${last.toLocaleDateString("en-GB")}`;
}

function _formatParallelBandPreview(bands = []) {
  if (!bands.length) return "none";
  return bands.slice(0, 3).map(x => `${x.entityType} (${x.count})`).join(", ");
}

function _escAttr(val) {
  return String(val ?? "").replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function _escHtml(val) {
  return String(val ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function _showLoading(v)  { document.getElementById("loading")?.classList.toggle("hidden", !v); }
function _showDropzone()  { document.getElementById("dropzone")?.classList.remove("hidden"); }
function _hideDropzone()  { document.getElementById("dropzone")?.classList.add("hidden"); }

window.addEventListener("DOMContentLoaded", init);
