"use strict";

import { loadDataset, datasetUrl, datasetFromQuery } from "./data/loader.js";
import { buildStore, getStore, getGraph, getOverviewGraph, getVariantOverview, getActivityDfGraph } from "./data/store.js";
import { computeDetailLayout, ITEM_COLORS, PO_COLOR } from "./layout/detailLayout.js";
import { computeOverviewNetworkLayout, computeVariantLayout, computeDfGraphLayout } from "./layout/overviewLayout.js";
import { drawBlock } from "./render/detailRender.js";
import { drawOverviewNetwork, drawVariantOverview } from "./render/overviewRender.js";
import { addMarkers, wheelDelta, computeFitTransform, clusterColor, ZOOM_MIN_SCALE, ZOOM_MAX_SCALE, CAMERA_EASE_MS } from "./render/shared.js";

// ── State ─────────────────────────────────────────────────────────────────

let svg, gRoot, zoom, currentTransform;
const vis = { dfItem: true, dfPo: false, corr: false, resources: false, attributes: false, sync: true, bottleneck: true };
const opa = { dfItem: 0.7, dfPo: 0.2, corr: 0.2 };

let _currentView = "overview";    // "overview" | "community" | "detail" | "variants"
let _selectedPoId = null;
let _selectedCommunityId = null;
let _expanded = new Set();
let _filters = { activities: null, maxItems: 10 };
let _lastTotalHeight = 0;
let _selection = null;
let _lastListKey = null;

// ── Bootstrap ─────────────────────────────────────────────────────────────

async function init() {
  const svgEl = document.getElementById("canvas");
  svg = d3.select(svgEl);
  gRoot = svg.append("g").attr("class", "root");
  currentTransform = d3.zoomIdentity;
  addMarkers(svg.append("defs"));

  zoom = d3.zoom()
    .scaleExtent([ZOOM_MIN_SCALE, ZOOM_MAX_SCALE])
    .wheelDelta(wheelDelta)
    .on("zoom", e => { currentTransform = e.transform; gRoot.attr("transform", currentTransform); });
  svg.call(zoom);
  svg.on("dblclick.zoom", null);
  svg.on("click.selection-clear", ev => { if (ev.target === svgEl) _clearSelection(); });

  _setupTooltip();
  _setupPanel();
  _setupControls();
  _setupSidebarResize();

  const datasetName = datasetFromQuery("library");
  await _loadDataset(datasetName);
}

// ── Data loading ───────────────────────────────────────────────────────────

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
  _filters.maxItems = parseInt(document.getElementById("slider-max-items")?.value ?? "10", 10);
  _selectedPoId = null;
  _selectedCommunityId = null;
  _expanded = new Set();
  _currentView = "overview";
  _lastListKey = null;

  document.getElementById("dataset-label").textContent = name.toUpperCase();
  const poSearch = document.getElementById("po-search");
  if (poSearch) poSearch.placeholder = `Search ${store.caseType ?? "case"}…`;
  const dfPoLabel = document.getElementById("label-dfpo");
  if (dfPoLabel) dfPoLabel.textContent = `DF ${store.caseType ?? "Case"}`;
  _buildActivityList(store);
  _renderCurrentView();
  _updateStatusBar(store);
}

// ── View rendering ─────────────────────────────────────────────────────────

function _renderCurrentView() {
  gRoot.selectAll("*").remove();
  const lBg = gRoot.append("g").attr("class", "l-bg");
  const lMeta = gRoot.append("g").attr("class", "l-meta");
  const lDfPo = gRoot.append("g").attr("class", "l-dfpo");
  const lCorr = gRoot.append("g").attr("class", "l-corr");
  const lRes = gRoot.append("g").attr("class", "l-resources");
  const lDfItem = gRoot.append("g").attr("class", "l-dfitem");
  const lNodes = gRoot.append("g").attr("class", "l-nodes");
  const lLabels = gRoot.append("g").attr("class", "l-labels");

  const w = svg.node().clientWidth;
  const cb = _makeCallbacks();
  const svgW = () => svg.node().clientWidth ?? 900;

  const store = getStore();
  const labels = {
    caseType: store?.caseType ?? "Case",
    itemType: store?.itemType ?? "Item",
    caseBadge: (store?.caseType ?? "CA").slice(0, 2).toUpperCase(),
  };

  if (_currentView === "overview" || _currentView === "community") {
    const overviewGraph = getOverviewGraph({ activities: _filters.activities, communityId: _selectedCommunityId ?? null });
    const layout = computeOverviewNetworkLayout(overviewGraph, w);
    drawOverviewNetwork(layout.network, lBg, lMeta, lNodes, lLabels, vis, cb, labels);
    _lastTotalHeight = layout.totalHeight;
    _applyVisibility();
    _fitToView(_lastTotalHeight);
  } else if (_currentView === "variants") {
    const variantData = getVariantOverview({ activities: _filters.activities });
    variantData.dfGraph = getActivityDfGraph({ activities: _filters.activities });
    const viewportH = svg.node().clientHeight;
    const variantLayout = computeVariantLayout(variantData, w, {
      activityColorByName: getStore().activityColorByName, viewportHeight: viewportH,
    });
    const dfInnerW = Math.max(w - 64, 220);
    const dfInnerH = variantLayout.dfgHeight ?? 200;
    const rawDf = computeDfGraphLayout(variantData.dfGraph, dfInnerW, dfInnerH);
    const dfLayout = {
      ...rawDf, x: 32, y: variantLayout.totalHeight + 34, width: dfInnerW, height: dfInnerH,
      nodes: rawDf.nodes.map(n => ({ ...n, x: n.x + 32, y: n.y + variantLayout.totalHeight + 34 })),
      edges: rawDf.edges.map(e => ({ ...e, x1: e.x1 + 32, y1: e.y1 + variantLayout.totalHeight + 34, x2: e.x2 + 32, y2: e.y2 + variantLayout.totalHeight + 34, cx: e.cx + 32, cy: e.cy + variantLayout.totalHeight + 34 })),
    };
    drawVariantOverview(variantLayout, dfLayout, variantData, lBg, lNodes, lLabels, cb);
    _lastTotalHeight = variantLayout.totalHeight + 34 + dfInnerH + 26;
    _fitToView(_lastTotalHeight);
  } else if (_currentView === "detail" && _selectedPoId) {
    const graph = getGraph(_selectedPoId, { maxItems: _filters.maxItems, activities: _filters.activities });
    const layout = computeDetailLayout([graph], _expanded, w, { showDeviantsOnly: _filters.showDeviantsOnly, showSyncOnly: _filters.showSyncOnly });
    layout.poBlocks.forEach(block => drawBlock(block, lBg, lDfPo, lCorr, lRes, lDfItem, lNodes, lLabels, vis, cb, svgW, labels));
    _lastTotalHeight = layout.totalHeight;
    _applyVisibility();
    _applySelectionState();
    _fitToView(_lastTotalHeight);
    _updateDetailStats(layout.summary);
    _updateCaseStats(store, _selectedPoId);
  }

  const store2 = getStore();
  const communityLabel = _selectedCommunityId ? (store2.communities?.find(c => c.id === _selectedCommunityId)?.label ?? "Community") : null;
  document.getElementById("panel-view-tag").textContent =
    _currentView === "overview" ? "OVERVIEW"
    : _currentView === "variants" ? "VARIANTS"
    : _currentView === "community" ? (communityLabel ?? "COMMUNITY")
    : `${labels.caseType.toUpperCase()} ${_selectedPoId ?? ""}`;

  const backBtn = document.getElementById("btn-back");
  if (backBtn) {
    if (_currentView === "community") backBtn.textContent = "← All communities";
    else if (_currentView === "detail" && _selectedCommunityId) {
      const commLabel = store2.communities?.find(c => c.id === _selectedCommunityId)?.label ?? "Community";
      backBtn.textContent = `← ${commLabel}`;
    } else backBtn.textContent = `← All ${labels.caseType}s`;
  }

  document.getElementById("sidebar")?.setAttribute("data-view", _currentView);
  document.getElementById("btn-overview")?.classList.toggle("active", _currentView === "overview" || _currentView === "community");
  document.getElementById("btn-variants")?.classList.toggle("active", _currentView === "variants");
  _updateSidebarList();
}

// ── Callbacks ──────────────────────────────────────────────────────────────

function _makeCallbacks() {
  return {
    onTooltipShow: _showTooltip,
    onTooltipHide: _hideTooltip,
    onItemExpand: (itemId) => {
      if (_expanded.has(itemId)) _expanded.delete(itemId); else _expanded.add(itemId);
      _renderCurrentView();
    },
    onPoSelect: (poId) => {
      _selectedPoId = poId;
      _currentView = "detail";
      _expanded = new Set();
      _renderCurrentView();
      _setActivePoInList(poId);
    },
    onCommunitySelect: (communityId) => {
      _selectedCommunityId = communityId;
      _currentView = "community";
      _renderCurrentView();
    },
    onVariantSelect: (instanceIds) => {
      // Focus POs that contain these items
      const store = getStore();
      const poIds = [...new Set(instanceIds.map(itemId => {
        const evs = store.eventsByItem[itemId];
        return evs?.[0]?.po_id;
      }).filter(Boolean))];
      if (poIds.length === 1) {
        _selectedPoId = poIds[0];
        _currentView = "detail";
        _expanded = new Set();
        _renderCurrentView();
      }
    },
    onEdgeSelect: (d) => { _toggleSelection({ kind: "edge", edgeId: d.id, entityId: d.entityId, sourceId: d.sourceId, targetId: d.targetId }); },
    onEventSelect: (d) => { _toggleSelection({ kind: "event", eventId: d.id, entityId: d.poitem_id, relatedEntityIds: d.sharedEntityIds ?? [d.poitem_id] }); },
  };
}

// ── UI setup ───────────────────────────────────────────────────────────────

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
  document.getElementById("po-search")?.addEventListener("input", e => {
    const query = e.target.value.toLowerCase();
    document.querySelectorAll(".po-item").forEach(el => {
      el.style.display = el.dataset.id?.toLowerCase().includes(query) ? "" : "none";
    });
  });
}

function _setupControls() {
  // View switcher
  document.getElementById("btn-overview")?.addEventListener("click", () => { _currentView = "overview"; _selectedCommunityId = null; _renderCurrentView(); });
  document.getElementById("btn-variants")?.addEventListener("click", () => { _currentView = "variants"; _renderCurrentView(); });
  document.getElementById("btn-back")?.addEventListener("click", () => {
    if (_currentView === "detail" && _selectedCommunityId) {
      _currentView = "community";
      _selectedPoId = null;
    } else {
      _currentView = "overview";
      _selectedPoId = null;
      _selectedCommunityId = null;
    }
    _renderCurrentView();
  });

  // Fit / reset
  document.getElementById("btn-fit")?.addEventListener("click", () => _fitToView(_lastTotalHeight));
  document.getElementById("btn-reset-zoom")?.addEventListener("click", () => _resetZoom());

  // Max items slider
  const slider = document.getElementById("slider-max-items");
  const sliderVal = document.getElementById("slider-max-items-val");
  slider?.addEventListener("input", () => {
    _filters.maxItems = parseInt(slider.value, 10);
    if (sliderVal) sliderVal.textContent = _filters.maxItems;
    if (_currentView === "detail") _renderCurrentView();
  });
  if (sliderVal && slider) sliderVal.textContent = slider.value;

  // Visibility toggles
  const toggleMap = { "toggle-dfitem": "dfItem", "toggle-dfpo": "dfPo", "toggle-corr": "corr", "toggle-resources": "resources", "toggle-sync": "sync", "toggle-bottleneck": "bottleneck" };
  Object.entries(toggleMap).forEach(([id, key]) => {
    document.getElementById(id)?.addEventListener("change", e => { vis[key] = e.target.checked; _applyVisibility(); });
  });

  // Opacity sliders
  const opaMap = { "opa-dfitem": "dfItem", "opa-dfpo": "dfPo", "opa-corr": "corr" };
  Object.entries(opaMap).forEach(([id, key]) => {
    const el = document.getElementById(id);
    const valEl = document.getElementById(`${id}-val`);
    el?.addEventListener("input", () => { opa[key] = parseFloat(el.value); if (valEl) valEl.textContent = el.value; _applyVisibility(); });
  });

  // Deviant / sync filters
  document.getElementById("btn-deviants-only")?.addEventListener("click", function() {
    _filters.showDeviantsOnly = !_filters.showDeviantsOnly;
    this.classList.toggle("active", _filters.showDeviantsOnly);
    if (_currentView === "detail") _renderCurrentView();
  });
  document.getElementById("btn-sync-only")?.addEventListener("click", function() {
    _filters.showSyncOnly = !_filters.showSyncOnly;
    this.classList.toggle("active", _filters.showSyncOnly);
    if (_currentView === "detail") _renderCurrentView();
  });

  // File picker fallback
  document.getElementById("btn-open-file")?.addEventListener("click", () => document.getElementById("file-input")?.click());
  document.getElementById("file-input")?.addEventListener("change", async e => {
    const file = e.target.files[0];
    if (!file) return;
    _showLoading(true); _hideDropzone();
    try {
      const text = await file.text();
      const bundle = JSON.parse(text);
      const store = buildStore(bundle);
      _afterLoad(store, file.name.replace(".json", ""));
    } catch (err) {
      alert("Failed to load file: " + err.message);
      _showDropzone();
    } finally { _showLoading(false); }
  });
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
    _selectedCommunityId = null;
    if (_currentView === "community") _currentView = "overview";
    _renderCurrentView();
  });
  document.getElementById("btn-act-none")?.addEventListener("click", () => {
    container.querySelectorAll("input").forEach(cb => { cb.checked = false; });
    _filters.activities = new Set();
    _selectedCommunityId = null;
    if (_currentView === "community") _currentView = "overview";
    _renderCurrentView();
  });
}

function _onActivityToggle(activity, checked) {
  const store = getStore();
  if (_filters.activities === null) {
    if (!checked) { _filters.activities = new Set(store.allActivities.filter(a => a !== activity)); }
  } else {
    if (checked) _filters.activities.add(activity); else _filters.activities.delete(activity);
    if (_filters.activities.size === store.allActivities.length) _filters.activities = null;
  }
  _selectedCommunityId = null;
  if (_currentView === "community") _currentView = "overview";
  _renderCurrentView();
}

function _buildCommunityList(clusters) {
  const casesLabel = document.getElementById("cases-label");
  if (casesLabel) casesLabel.textContent = "Communities";
  const container = document.getElementById("po-list");
  if (!container) return;
  container.innerHTML = "";
  clusters.forEach(cluster => {
    const item = document.createElement("div");
    item.className = "po-item community-item";
    item.dataset.id = cluster.id;
    const dot = `<span class="community-dot" style="background:${clusterColor(cluster.id, 0.85)}"></span>`;
    item.innerHTML = `${dot}<span class="po-id">${cluster.label}</span><span class="po-meta">${cluster.count}m</span>`;
    item.addEventListener("click", () => {
      _selectedCommunityId = cluster.id;
      _currentView = "community";
      _renderCurrentView();
    });
    container.appendChild(item);
  });
}

function _buildPoList(store, communityId = null) {
  const casesLabel = document.getElementById("cases-label");
  const community = communityId ? store.communities?.find(c => c.id === communityId) : null;
  if (casesLabel) casesLabel.textContent = community ? community.label : `${store.caseType ?? "Case"}s`;

  const container = document.getElementById("po-list");
  if (!container) return;
  container.innerHTML = "";
  let list = store.poList;
  if (community) {
    const memberSet = new Set(community.nodeIds);
    list = list.filter(po => memberSet.has(po.id));
  }
  list.slice(0, 200).forEach(po => {
    const item = document.createElement("div");
    item.className = "po-item";
    item.dataset.id = po.id;
    item.innerHTML = `<span class="po-id">${po.id}</span><span class="po-meta">${po.itemCount}i · ${po.eventCount}e</span>`;
    item.addEventListener("click", () => {
      _selectedPoId = po.id; _currentView = "detail"; _expanded = new Set();
      _renderCurrentView(); _setActivePoInList(po.id);
    });
    container.appendChild(item);
  });
}

function _updateSidebarList() {
  const actKey = _filters.activities ? [..._filters.activities].sort().join(",") : "*";
  const key = `${_currentView}:${_selectedCommunityId ?? ""}:${actKey}`;
  if (key === _lastListKey) return;
  _lastListKey = key;
  const store = getStore();
  if (_currentView === "overview") {
    const graph = getOverviewGraph({ activities: _filters.activities });
    _buildCommunityList(graph.clusters);
  } else {
    _buildPoList(store, _selectedCommunityId);
  }
}

function _setActivePoInList(poId) {
  document.querySelectorAll(".po-item").forEach(el => el.classList.toggle("active", el.dataset.id === poId));
}

function _updateStatusBar(store) {
  const el = document.getElementById("status-events");
  if (el) el.innerHTML = `Events: <b>${store.events.length.toLocaleString()}</b>`;
  const el2 = document.getElementById("status-po");
  if (el2) el2.innerHTML = `${store.caseType ?? "Cases"}: <b>${store.poList.length.toLocaleString()}</b>`;
}

function _updateDetailStats(summary) {
  const el = document.getElementById("status-items");
  if (el) el.innerHTML = `Items: <b>${summary.shownItems}/${summary.totalItems}</b>`;
  const el2 = document.getElementById("status-df");
  if (el2) el2.innerHTML = `DF: <b>${summary.dfItemCount}</b>`;
}

function _updateCaseStats(store, poId) {
  const title = document.getElementById("case-stats-title");
  const panel = document.getElementById("case-stats-content");
  if (!panel) return;

  if (title) title.textContent = `${store.caseType ?? "Case"} ${poId}`;

  const events = (store.eventsByPo ?? {})[poId] ?? [];
  const po = store.poList.find(p => p.id === poId);

  const activities = new Set(events.map(e => e.activity));
  const resources = new Set(events.map(e => e.resourceId).filter(Boolean));

  const times = events.map(e => e.date?.getTime()).filter(Number.isFinite);
  const minT = times.length ? Math.min(...times) : null;
  const maxT = times.length ? Math.max(...times) : null;

  let duration = "—";
  if (minT !== null && maxT !== null) {
    const days = Math.round((maxT - minT) / 86400000);
    duration = days === 0 ? "<1 day" : `${days}d`;
  }

  const fmt = t => t ? new Date(t).toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" }) : "—";

  const rows = [
    ["Events",     events.length],
    ["Items",      po?.itemCount ?? "—"],
    ["Activities", activities.size],
    ["Resources",  resources.size],
    ["Duration",   duration],
    null,
    ["Start",      fmt(minT)],
    ["End",        fmt(maxT)],
  ];

  panel.innerHTML = rows.map(row =>
    row === null
      ? `<div class="stat-divider"></div>`
      : `<div class="stat-row"><span class="stat-label">${row[0]}</span><span class="stat-val">${row[1]}</span></div>`
  ).join("");
}

// ── Visibility / selection ─────────────────────────────────────────────────

function _applyVisibility() {
  if (!gRoot) return;
  gRoot.selectAll(".edge-dfpo").attr("display", vis.dfPo ? null : "none").attr("opacity", opa.dfPo);
  gRoot.selectAll(".edge-dfitem").attr("display", vis.dfItem ? null : "none").attr("opacity", opa.dfItem);
  gRoot.selectAll(".edge-dfitem-bottleneck").attr("display", vis.dfItem ? null : "none").attr("opacity", vis.dfItem ? opa.dfItem * (vis.bottleneck ? 1 : 0.22) : 0);
  gRoot.selectAll(".bottleneck-overlay, .bottleneck-badge").attr("display", vis.dfItem ? null : "none").attr("opacity", vis.dfItem ? (vis.bottleneck ? 1 : 0.18) : 0);
  gRoot.selectAll(".edge-corr").attr("display", vis.corr ? null : "none").attr("opacity", opa.corr);
  gRoot.selectAll(".event-sync-group").attr("opacity", vis.sync ? 1 : 0.22);
  gRoot.selectAll(".resource-overlay").attr("display", vis.resources ? null : "none");
  gRoot.selectAll(".resource-satellite").attr("display", vis.resources ? null : "none");
  gRoot.selectAll(".attribute-satellite").attr("display", vis.attributes ? null : "none");
}

function _toggleSelection(sel) {
  _selection = (_selection && JSON.stringify(_selection) === JSON.stringify(sel)) ? null : sel;
  _applySelectionState();
}

function _clearSelection() { _selection = null; _applySelectionState(); }

function _applySelectionState() {
  if (!gRoot) return;
  const circles = gRoot.selectAll(".event-circle");
  const edges = gRoot.selectAll(".edge-dfitem");
  const lanes = gRoot.selectAll(".item-lane");
  circles.classed("highlighted", false).classed("dimmed", false);
  edges.classed("edge-highlighted", false).classed("edge-dimmed", false);
  lanes.classed("item-highlighted", false).classed("item-dimmed", false);
  if (!_selection) return;

  if (_selection.kind === "event") {
    const entitySet = new Set(_selection.relatedEntityIds?.length ? _selection.relatedEntityIds : [_selection.entityId]);
    circles.classed("highlighted", function() { return d3.select(this.parentNode).attr("data-event-id") === _selection.eventId; })
           .classed("dimmed", function() { return d3.select(this.parentNode).attr("data-event-id") !== _selection.eventId; });
    edges.classed("edge-highlighted", function() { const e = d3.select(this); return e.attr("data-source-id") === _selection.eventId || e.attr("data-target-id") === _selection.eventId; })
         .classed("edge-dimmed", function() { const e = d3.select(this); return e.attr("data-source-id") !== _selection.eventId && e.attr("data-target-id") !== _selection.eventId; });
    lanes.classed("item-highlighted", function() { return entitySet.has(d3.select(this).attr("data-entity-id")); })
         .classed("item-dimmed", function() { return !entitySet.has(d3.select(this).attr("data-entity-id")); });
  } else if (_selection.kind === "edge") {
    const activeEvents = new Set([_selection.sourceId, _selection.targetId]);
    circles.classed("highlighted", function() { return activeEvents.has(d3.select(this.parentNode).attr("data-event-id")); })
           .classed("dimmed", function() { return !activeEvents.has(d3.select(this.parentNode).attr("data-event-id")); });
    edges.classed("edge-highlighted", function() { return d3.select(this).attr("data-edge-id") === _selection.edgeId; })
         .classed("edge-dimmed", function() { return d3.select(this).attr("data-edge-id") !== _selection.edgeId; });
    lanes.classed("item-highlighted", function() { return d3.select(this).attr("data-entity-id") === _selection.entityId; })
         .classed("item-dimmed", function() { return d3.select(this).attr("data-entity-id") !== _selection.entityId; });
  }
}

// ── Camera ─────────────────────────────────────────────────────────────────

function _fitToView(totalHeight, options = {}) {
  if (!svg) return;
  const transform = computeFitTransform(svg, gRoot, totalHeight, options);
  if (!transform) return;
  svg.transition().duration(CAMERA_EASE_MS).ease(d3.easeCubicOut).call(zoom.transform, transform);
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
    const onMove = e => {
      const w = Math.max(180, Math.min(540, startW + (e.clientX - startX)));
      sidebar.style.width = `${w}px`;
      sidebar.style.minWidth = `${w}px`;
    };
    const onUp = () => {
      resizer.classList.remove("dragging");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}

function _showLoading(visible) { document.getElementById("loading")?.classList.toggle("hidden", !visible); }
function _showDropzone() { document.getElementById("dropzone")?.classList.remove("hidden"); }
function _hideDropzone() { document.getElementById("dropzone")?.classList.add("hidden"); }

// ── Entry point ────────────────────────────────────────────────────────────

window.addEventListener("DOMContentLoaded", init);
