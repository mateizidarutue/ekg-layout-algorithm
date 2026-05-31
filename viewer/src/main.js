"use strict";

import { loadDataset, loadManifest, datasetUrl, datasetFromQuery } from "./data/loader.js";
import {
  buildStore, getStore, getVariantOverview, getEkgView,
  getActivityDfGraph, getDetailGraph, getGlobalSharedEventHotspots, getSharedEventTimeBuckets, getEntitiesForHotspot,
  buildEntityTimelineRows,
} from "./data/store.js";
import { computeDetailLayout } from "./layout/detailLayout.js";
import { computeVariantLayout, computeDfGraphLayout } from "./layout/overviewLayout.js";
import { drawDetailView } from "./render/detailRender.js";
import { drawVariantOverview } from "./render/overviewRender.js";
import {
  addMarkers, wheelDelta, formatPercent,
  ZOOM_MIN_SCALE, ZOOM_MAX_SCALE,
} from "./render/shared.js";
import { startRouter, getRoute, navigate, goBack } from "./router.js";
import { renderHome } from "./screens/home.js";
import { renderIdentifyPicker } from "./screens/identify.js";
import { renderExploreList, renderExploreClusterDetail, updateHotspotSummary } from "./screens/explore.js";
import { mountSummarizeScreen, unmountSummarizeScreen, updateSummarizeSidebar } from "./screens/summarize.js";
import { updateSidebarRoute, updateTopbar, renderCompareStrip } from "./screens/sidebar.js";

// ── SVG / camera ──────────────────────────────────────────────────────────────
let svg, gRoot, zoom, currentTransform;
const vis = { df: true, corr: true, relations: true, sync: true, bottleneck: true };
const opa = { df: 1, corr: 0.22, relations: 0.4 };
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
let _minZoomScale = ZOOM_MIN_SCALE;
let _clusterActivityContext = null;
let _isolatedClusterContext = null;
// T4-only display filter: minimum synchronization degree a shared event must
// have to appear in the hotspot list. Does NOT change the shared-event
// definition (>=2) anywhere else in the tool. Minimum allowed value is 2.
let _t4DegreeFloor = 2;
// T4-list-only month filter: when set to a "YYYY-MM" key (by clicking a bar in
// the temporal strip), the hotspot list is narrowed to that month. The strip
// itself always shows the full range so the selection stays visible. Reset on
// fresh entry to the list route.
let _t4SelectedMonth = null;
let _compareEntityIds = [];
let _compareMode = "variants";
let _accentMap = {};
let _selectionRaf = null;
// Entities whose per-event details table is currently expanded under their
// lane. Survives slice/window changes (so the bottleneck column updates
// live as the threshold re-scopes) but is cleared on dataset reload and
// on T2 anchor switch (see _afterLoad and handleRoute).
let _expandedEntityIds = new Set();
// Row cache for the currently-laid-out detail graph, keyed by entity_id.
// Populated just before computeDetailLayout runs so the layout can ask for
// row counts (to size the expansion gap) and the renderer can pull the
// same rows when drawing the table. Rebuilt every re-render.
let _laneRowCache = new Map();
let _lastDetailAnchorId = null;
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
  // Time-window brush listens for mousedown on the whole SVG so a drag can
  // start from anywhere — band headers, lane tracks, dots, axis area. The
  // handler does drag-vs-click disambiguation: if movement < 5 px the
  // click flows through to whatever was clicked; if movement ≥ 5 px the
  // drag becomes a brush and the following click is swallowed.
  svg.on("mousedown.timebrush", _onCanvasTimeBrushDown);
  currentTransform = d3.zoomIdentity;
  addMarkers(svg.append("defs"));

  document.getElementById("time-window-chip-reset")?.addEventListener("click", _resetTimeWindow);

  zoom = d3.zoom()
    .scaleExtent([ZOOM_MIN_SCALE, ZOOM_MAX_SCALE])
    .wheelDelta(wheelDelta)
    .on("zoom", e => {
      currentTransform = e.transform;
      gRoot.style("transform",
        `translate(${e.transform.x}px,${e.transform.y}px) scale(${e.transform.k})`);
    });

  svg.on("click.selection-clear", ev => { if (ev.target === svgEl) _clearSelection(); });

  _setupTooltip();
  _setupPanel();
  _setupEdgeControls();
  _setupCanvasKeyboard();
  _setupSidebarResize();
  _setupSidebarToggle();
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
  _isolatedClusterContext = null;
  _compareEntityIds = [];
  _compareMode = "variants";
  _accentMap = {};
  _detailGraph = null;
  _variantData = null;
  _selection = null;
  _entitySearchQuery = "";
  _lastListKey = null;
  _expandedEntityIds = new Set();
  _laneRowCache = new Map();
  _lastDetailAnchorId = null;

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
  );
  if (!shouldKeepClusterContext) {
    _clusterActivityContext = null;
    _isolatedClusterContext = null;
  }
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
    || route.name === "summarize"
    || route.name === "explore"
    || (route.name === "identify" && !route.params.entity);
  if (screenHost) screenHost.classList.toggle("hidden", !isDomScreen);
  if (canvas) canvas.style.display = isDomScreen ? "none" : "";

  // T1 population view owns its own canvas inside #screen-host; tear it down
  // whenever we navigate away so its rAF loop and listeners are cleaned up.
  if (route.name !== "summarize") unmountSummarizeScreen();

  _renderLayers(route, store);
  _updateSidebarList();
  _updateStatusBar(store);
  _updateHeaderTags(route, store);
  _updateTimeWindowChip(route);
}

function _renderLayers(route, store) {
  gRoot.selectAll("*").remove();
  _updateClusterIsolationControl(null);
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
      const dateFrom = route.params.dateFrom ? new Date(Number(route.params.dateFrom)) : null;
      const dateTo   = route.params.dateTo   ? new Date(Number(route.params.dateTo))   : null;
      _detailGraph = getDetailGraph({
        anchorEntityId: entityId,
        visibleEntityTypes: _filters.visibleEntityTypes ?? undefined,
        activities: _effectiveDetailActivities(),
        maxEntitiesPerType: _filters.maxEntitiesPerType,
        sharedOnly: _filters.sharedOnly,
        dateFrom,
        dateTo,
      });
      const renderGraph = _resolveDetailRenderGraph(_detailGraph);
      // Anchor change clears expansion state — a different entity's table
      // would never make sense under the previous entity's lanes.
      if (_lastDetailAnchorId !== entityId) {
        _expandedEntityIds = new Set();
        _lastDetailAnchorId = entityId;
      }
      const layoutOpts = _prepareLaneRowCache(renderGraph);
      const layout = computeDetailLayout(renderGraph, w, layoutOpts);
      drawDetailView(layout, lBg, lMeta, lRel, lCorr, lMeta, lDf, lNodes, lLabels, vis, cb);
      _lastTotalHeight = layout.totalHeight;
      _cacheTimeAxis(layout);
      _applyVisibility();
      _applySelectionState();
      _fitDetailView();
      _updateDetailPanels(renderGraph);
      _updateClusterActivityPanel(renderGraph);
      _updateClusterIsolationControl(renderGraph);
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
      const ekgData = getEkgView({ activities: _filters.activities });
      mountSummarizeScreen({
        data: ekgData,
        store,
        params: route.params,
        hoverCallbacks: { show: _showTooltip, hide: _hideTooltip },
        navigateToDetail: entityId => navigate("identify", { entity: entityId }),
      });
      updateSidebarRoute(route, { compareMode: _compareMode, exploreDrilled: false });
      updateSummarizeSidebar(ekgData);
      _updateDetailPanels(null);
      _updateVariantPanels(null, null);
      _updateClusterActivityPanel(null);
      _syncMaxEntitiesSlider(null);
      break;
    }
    case "explore": {
      const clusterId = route.params.cluster;
      // Date filter and focus type can be passed in URL params when navigating
      // from T1 (EKG Overview). Convert epoch-ms strings to Date objects.
      const exploreFrom = route.params.dateFrom ? new Date(Number(route.params.dateFrom)) : null;
      const exploreTo   = route.params.dateTo   ? new Date(Number(route.params.dateTo))   : null;
      if (clusterId) {
        _renderExploreDetail(route, store, w, lBg, lMeta, lRel, lCorr, lDf, lNodes, lLabels, cb, clusterId, exploreFrom, exploreTo);
      } else {
        // Fresh entry to the list clears any prior month selection so the user
        // always lands on the full, unfiltered list.
        _t4SelectedMonth = null;
        // Dataset-level temporal context strip: always degree >= 2, independent of the
        // display floor and the month selection, so it stays fixed (all months visible)
        // as the user steps the floor or picks a month. Computed once.
        const timeBuckets = getSharedEventTimeBuckets({ activities: _filters.activities, dateFrom: exploreFrom, dateTo: exploreTo });
        const renderList = () => {
          const floor = Math.max(2, _t4DegreeFloor);
          // The month selection narrows only the list, intersected with any base
          // window carried in from T1.
          let listFrom = exploreFrom, listTo = exploreTo;
          if (_t4SelectedMonth) {
            const b = _monthBounds(_t4SelectedMonth);
            listFrom = new Date(exploreFrom ? Math.max(exploreFrom.getTime(), b.from) : b.from);
            listTo   = new Date(exploreTo   ? Math.min(exploreTo.getTime(),   b.to)   : b.to);
          }
          const hotspots = getGlobalSharedEventHotspots({ activities: _filters.activities, sortBy: "syncStrength", minSharedEntities: floor, dateFrom: listFrom, dateTo: listTo });
          // Carry the effective list filter into a drilled-in cluster so the
          // detail view stays scoped to the same window/month.
          const clusterNavParams = {};
          if (listFrom) clusterNavParams.dateFrom = String(listFrom.getTime());
          if (listTo)   clusterNavParams.dateTo   = String(listTo.getTime());
          renderExploreList(hotspots, {
            degreeFloor: floor,
            onDegreeFloorChange: next => { _t4DegreeFloor = Math.max(2, next); renderList(); },
            timeBuckets,
            activeMonth: _t4SelectedMonth,
            onMonthSelect: key => { _t4SelectedMonth = _t4SelectedMonth === key ? null : key; renderList(); },
            clusterNavParams,
          });
        };
        renderList();
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
  _lastTotalHeight = variantLayout.totalHeight + 34 + dfInnerH + 28;
  _fitVariantView();
  updateSummarizeSidebar(null);
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
    // Preserve the ?variant= scope when removing an entity from the strip,
    // otherwise the user falls back to "show every item of every parent".
    const nextParams = newEntities ? { entities: newEntities } : {};
    if (newEntities && route.params.variant) nextParams.variant = route.params.variant;
    navigate("compare", nextParams);
  });

  const dateFrom = route.params.dateFrom ? new Date(Number(route.params.dateFrom)) : null;
  const dateTo   = route.params.dateTo   ? new Date(Number(route.params.dateTo))   : null;
  // Variant-driven compare: when the URL carries ?variant=<key>, restrict the
  // item band to only the items that belong to that variant. Otherwise the
  // scope expansion in getDetailGraph pulls in every item correlated with
  // the selected parents — including items from other variants — which
  // defeats the purpose of comparing within a single behavioural variant.
  let restrictedItemIds = null;
  let variantContext = null;
  if (route.params.variant) {
    try {
      const variantData = _variantData ?? getVariantOverview({ activities: _filters.activities });
      const v = variantData.variants.find(x => x.key === route.params.variant);
      if (v) {
        restrictedItemIds = (v.items ?? []).map(item => item.id);
        // Pull caseType from the overview so the scope note reads "3 of 5
        // purchaseorders" instead of "3 of 5 cases".
        variantContext = { ...v, caseType: variantData.caseType };
      }
    } catch (err) {
      console.warn("Failed to resolve variant for compare scope:", err);
    }
  }
  _detailGraph = getDetailGraph({
    anchorEntityId: anchorId,
    compareEntityIds: compareIds,
    visibleEntityTypes: _filters.visibleEntityTypes ?? undefined,
    activities: _effectiveDetailActivities(),
    maxEntitiesPerType: _filters.maxEntitiesPerType,
    sharedOnly: _filters.sharedOnly,
    dateFrom,
    dateTo,
    restrictedItemIds,
  });
  let renderGraph = _resolveDetailRenderGraph(_detailGraph);
  if (variantContext) {
    renderGraph = _regroupBandsByCase(renderGraph, entityIds);
  }
  _renderCompareAddPicker(variantContext, entityIds, store);
  const layoutOpts = _prepareLaneRowCache(renderGraph);
  const layout = computeDetailLayout(renderGraph, w, layoutOpts);
  drawDetailView(layout, lBg, lMeta, lRel, lCorr, lMeta, lDf, lNodes, lLabels, vis, cb);
  _lastTotalHeight = layout.totalHeight;
  _cacheTimeAxis(layout);
  _applyVisibility();
  _applySelectionState();
  _fitDetailView();
  _updateDetailPanels(renderGraph);
  if (variantContext) _injectVariantScopeNote(variantContext, entityIds);
  _updateClusterActivityPanel(renderGraph);
  _updateClusterIsolationControl(renderGraph);
  _syncMaxEntitiesSlider(_detailGraph);
  _renderEntityTypeFilters(_detailGraph);
  _highlightAnchorLane(anchorId);
  _applyAccentLanes(_accentMap);
}

// When the compare view is scoped to a variant, prepend a "Variant N — X
// items" chip plus a one-liner about why this set of parents was picked.
// The user can see at a glance that the chart is *not* the full population
// of items for these parents — only the variant subset.
function _injectVariantScopeNote(variant, compareEntityIds) {
  const content = document.getElementById("detail-summary-content");
  if (!content) return;
  const itemCount = variant.items?.length ?? 0;
  const memberCount = variant.members?.length ?? 0;
  content.insertAdjacentHTML("afterbegin", `
    <div class="variant-scope-chip">
      <span class="variant-scope-chip-tag">VARIANT ${_escHtml(variant.rank)}</span>
      <span class="variant-scope-chip-text">${itemCount} item${itemCount === 1 ? "" : "s"} · top ${compareEntityIds.length} of ${memberCount} ${_escHtml((variant.caseType ?? "case").toLowerCase())}${memberCount === 1 ? "" : "s"}</span>
    </div>
    <div class="stat-row stat-row-flow">
      <span class="stat-label">Variant sequence</span>
      <span class="stat-val">${_escHtml(_formatSequencePreview(variant.sequence ?? []))}</span>
    </div>
    <div class="stat-row stat-row-flow">
      <span class="stat-label">Ranking</span>
      <span class="stat-val">By items in variant (most first)</span>
    </div>
    <div class="stat-divider"></div>
  `);
}

// In variant-driven compare, split the items band into one band per compared
// case so each case (e.g., a PurchaseOrder) renders as its own section with
// its own item lanes underneath, instead of all items being merged into one
// shared items band.
function _regroupBandsByCase(graph, orderedCaseIds) {
  const caseType = graph?.caseType;
  const itemType = graph?.itemType;
  if (!caseType || !itemType) return graph;
  const bands = graph.bands ?? [];
  const caseBand = bands.find(b => b.entityType === caseType);
  const itemBand = bands.find(b => b.entityType === itemType);
  if (!caseBand || !itemBand) return graph;

  const caseLaneById = Object.fromEntries((caseBand.lanes ?? []).map(l => [l.entity_id, l]));
  const itemsByParent = new Map();
  (itemBand.lanes ?? []).forEach(lane => {
    const parent = lane.events?.[0]?.case_entity_id ?? lane.parentCaseId ?? null;
    if (!parent) return;
    if (!itemsByParent.has(parent)) itemsByParent.set(parent, []);
    itemsByParent.get(parent).push(lane);
  });

  const otherBands = bands.filter(b => b !== caseBand && b !== itemBand);
  const perCaseBands = [];
  orderedCaseIds.forEach(caseId => {
    const caseLane = caseLaneById[caseId];
    if (!caseLane) return;
    const itemLanes = itemsByParent.get(caseId) ?? [];
    const label = caseLane.entityLabel || caseId;
    perCaseBands.push({
      ...caseBand,
      entityType: caseType,
      entityLabel: `${caseType} ${label}`,
      lanes: [caseLane, ...itemLanes],
      parentGroupBreaks: [],
      compareEntityIds: [caseId],
      dominantSequence: null,
      dominantSupport: 0,
      comparedSequenceCount: 0,
      hasDominantPattern: false,
    });
  });
  if (!perCaseBands.length) return graph;
  return { ...graph, bands: [...perCaseBands, ...otherBands] };
}

// Variant-mode state for the compare picker. When set, the input in the
// "Compared entities" panel filters this list of members instead of searching
// the whole store. The free-text search behaviour in _wireSidebar checks
// _variantPickerMembers === null before falling back to global search.
let _variantPickerMembers = null;

// Variant-mode replacement for the free-text entity search: show a curated
// list of the variant's other members and let the user filter that list
// rather than searching the whole dataset.
function _renderCompareAddPicker(variantContext, entityIds, store) {
  const wrap = document.getElementById("compare-add-wrap");
  const input = document.getElementById("compare-add-input");
  const results = document.getElementById("compare-add-results");
  if (!wrap || !input || !results) return;

  if (!variantContext) {
    _variantPickerMembers = null;
    wrap.classList.remove("variant-picker");
    input.removeAttribute("data-variant-mode");
    input.placeholder = "Type entity ID to add…";
    input.disabled = false;
    results.classList.add("hidden");
    results.innerHTML = "";
    return;
  }

  const existing = new Set(entityIds);
  const remaining = (variantContext.members ?? []).filter(m => !existing.has(m.id));
  _variantPickerMembers = { members: remaining, itemType: store?.itemType ?? "" };
  wrap.classList.add("variant-picker");
  input.setAttribute("data-variant-mode", "1");
  input.value = "";
  input.placeholder = remaining.length
    ? `Filter ${remaining.length} remaining variant member${remaining.length === 1 ? "" : "s"}…`
    : "All variant members already compared";
  input.disabled = !remaining.length;
  _renderVariantPickerResults("");
}

function _renderVariantPickerResults(filterText) {
  const results = document.getElementById("compare-add-results");
  if (!results || !_variantPickerMembers) return;
  const { members, itemType } = _variantPickerMembers;
  const q = (filterText ?? "").trim().toLowerCase();
  const hits = q
    ? members.filter(m => String(m.id).toLowerCase().includes(q) || String(m.label ?? "").toLowerCase().includes(q))
    : members;
  if (!hits.length) {
    results.innerHTML = `<div class="empty-note" style="padding:8px 10px;font-size:11px;color:var(--text-dim)">${members.length ? "No matches." : "No remaining members."}</div>`;
  } else {
    results.innerHTML = hits.map(m => {
      const sub = `${m.itemCount ?? 0} ${itemType.toLowerCase()} - ${m.eventCount ?? 0} events`;
      return `<div class="compare-result-row" data-id="${_escAttr(m.id)}"><span class="compare-result-label">${_escHtml(m.label ?? m.id)}</span><span class="compare-result-type">${_escHtml(sub)}</span></div>`;
    }).join("");
    results.querySelectorAll(".compare-result-row").forEach(row => {
      row.addEventListener("mousedown", ev => ev.preventDefault());
      row.addEventListener("click", () => {
        const r = getRoute();
        const cur = (r.params.entities ?? "").split(",").filter(Boolean);
        if (!cur.includes(row.dataset.id)) {
          const params = { entities: [...cur, row.dataset.id].join(",") };
          if (r.params.variant) params.variant = r.params.variant;
          navigate("compare", params);
        }
      });
    });
  }
  results.classList.remove("hidden");
}

// UTC epoch-ms bounds for a "YYYY-MM" month key. Matches binEventsByMonth's UTC
// bucketing so a month filter selects exactly the events in that strip bar.
function _monthBounds(monthKey) {
  const [y, m] = monthKey.split("-").map(Number);
  return { from: Date.UTC(y, m - 1, 1), to: Date.UTC(y, m, 1) - 1 };
}

function _renderExploreDetail(route, store, w, lBg, lMeta, lRel, lCorr, lDf, lNodes, lLabels, cb, clusterId, dateFrom = null, dateTo = null) {
  _updateDetailPanels(null);
  // focusType is carried from T1 when the user drills in from a focused type.
  // getEntitiesForHotspot uses it to pick an anchor of that type so the T4
  // view opens centred on the same type the analyst had highlighted.
  const focusType = route.params.focusType ?? null;
  const entityIds = getEntitiesForHotspot(clusterId, { maxEntities: EXPLORE_ENTITY_LIMIT, dateFrom, dateTo, focusType });
  if (!entityIds.length) {
    const host = document.getElementById("screen-host");
    if (host) host.innerHTML = `<div style="padding:48px 32px;color:var(--text-muted,#94a3b8);font-size:14px">No entity data found for this cluster${dateFrom ? " in the selected date range" : ""}.</div>`;
    return;
  }
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
    // Shared-event definition: correlated to >=2 entities. The T4 list's
    // degree-floor control does not apply here — the cluster detail always
    // shows every shared event for the activity.
    minSharedEntities: 2,
    // Date filter carried from T1 — filters which events appear in the
    // lifecycle timelines so only in-window events are shown.
    dateFrom,
    dateTo,
  });
  const renderGraph = _resolveDetailRenderGraph(_detailGraph);
  renderExploreClusterDetail(renderGraph);
  _updateClusterActivityPanel(renderGraph);
  _syncMaxEntitiesSlider(_detailGraph);
  _renderEntityTypeFilters(_detailGraph);

  // Use the same date filter when looking up the hotspot summary so
  // the event count shown in the header reflects the filtered window.
  const hotspots = getGlobalSharedEventHotspots({ minSharedEntities: 2, dateFrom, dateTo });
  const hotspot = hotspots.find(h => h.id === clusterId);
  if (hotspot) updateHotspotSummary(hotspot);
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

// Rebuild the per-lane row cache for the currently-rendering detail graph
// and hand back the matching layout options. The cache is keyed by
// entity_id so the layout can ask for row counts (to size the expansion
// gap) and the renderer can pull the exact same rows when drawing the
// table — guaranteeing the bottleneck flag in the table and the bottleneck
// halo on the canvas can't drift apart.
function _prepareLaneRowCache(renderGraph) {
  _laneRowCache = new Map();
  const store = (() => { try { return getStore(); } catch { return null; } })();
  const eventById = store?.eventById ?? {};
  (renderGraph?.bands ?? []).forEach(band => {
    (band.lanes ?? []).forEach(lane => {
      if (!_expandedEntityIds.has(lane.entity_id)) return;
      _laneRowCache.set(lane.entity_id, buildEntityTimelineRows(lane, eventById));
    });
  });
  return {
    expandedEntityIds: _expandedEntityIds,
    getRowCountForEntity: id => _laneRowCache.get(id)?.length ?? 0,
  };
}

// ── Callbacks for renderers ───────────────────────────────────────────────────
function _makeCallbacks(route) {
  return {
    onTooltipShow: _showTooltip,
    onTooltipHide: _hideTooltip,
    onPoSelect: entityId => navigate("identify", { entity: entityId }),
    onEntitySelect: entityId => navigate("identify", { entity: entityId }),
    onVariantSelect: variantKey => {
      const current = route.params.variant;
      if (current === variantKey) navigate("compare");
      else navigate("compare", { variant: variantKey });
    },
    onDfExpand: () => _openActivityFlowModal(),
    onActivitySelect: activity => navigate("explore", { cluster: `act:${activity}` }),
    onEntityTypeSelect: type => {
      const s = getStore();
      const rep = s?.entities?.find(e => e.primary_type === type);
      if (rep) navigate("identify", { entity: rep.id });
    },
    onEventSelect: d => {
      if (d?.kind === "event-cluster") {
        _openClusterIsolation(d);
        return;
      }
      _toggleSelection(d?.kind === "event-cluster"
        ? { kind: "event-cluster", eventIds: d.ids ?? [], relatedEntityIds: d.sharedEntityIds ?? [] }
        : { kind: "event", eventId: d.id, relatedEntityIds: d.sharedEntityIds ?? [] });
    },
    onEdgeSelect: d => _toggleSelection({
      kind: "edge", edgeId: d.edgeId, entityId: d.entityId,
      sourceId: d.sourceId, targetId: d.targetId,
    }),
    onLaneExpansionToggle: entityId => {
      if (!entityId) return;
      if (_expandedEntityIds.has(entityId)) _expandedEntityIds.delete(entityId);
      else _expandedEntityIds.add(entityId);
      handleRoute(getRoute());
    },
    // Renderer pulls the rows from the cache that was populated by
    // _prepareLaneRowCache before computeDetailLayout ran, so the table
    // and the layout's reserved gap always agree on row count.
    getEntityRows: entityId => _laneRowCache.get(entityId) ?? [],
    isEntityExpanded: entityId => _expandedEntityIds.has(entityId),
  };
}

// ── Top-bar setup ─────────────────────────────────────────────────────────────
function _setupTopbar() {
  document.getElementById("btn-home")?.addEventListener("click", () => navigate("home"));
  document.getElementById("btn-back")?.addEventListener("click", () => _goBackFromCurrentRoute());

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

function _goBackFromCurrentRoute() {
  const route = getRoute();
  const fallback = route.name === "identify" && route.params.entity
    ? { name: "identify" }
    : route.name === "compare" && (route.params.variant || route.params.entities)
      ? { name: "compare" }
      : route.name === "explore" && route.params.cluster
        ? { name: "explore" }
        : { name: "home" };
  goBack(fallback);
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

function _openActivityFlowModal() {
  if (!_variantData?.dfGraph) return;
  const wrap = document.getElementById("canvas-wrap");
  if (!wrap) return;
  document.getElementById("activity-flow-modal")?.remove();
  const modal = document.createElement("div");
  modal.id = "activity-flow-modal";
  modal.className = "modal-overlay activity-flow-overlay";
  modal.innerHTML = `
    <div class="modal-card activity-flow-card">
      <div class="modal-header">
        <span class="modal-title">Activity flow detail</span>
        <button type="button" class="modal-close" id="btn-close-activity-flow" aria-label="Close">x</button>
      </div>
      <div class="activity-flow-modal-body">
        <svg id="activity-flow-modal-svg" class="activity-flow-modal-svg" aria-label="Expanded activity flow graph"></svg>
      </div>
    </div>
  `;
  wrap.appendChild(modal);
  const close = () => modal.remove();
  modal.addEventListener("click", event => { if (event.target === modal) close(); });
  modal.querySelector("#btn-close-activity-flow")?.addEventListener("click", close);
  _drawActivityFlowModal(modal.querySelector("#activity-flow-modal-svg"), _variantData.dfGraph);
}

function _drawActivityFlowModal(svgEl, dfGraph) {
  if (!svgEl) return;
  const width = Math.max(880, svgEl.clientWidth || 980);
  const height = Math.max(520, svgEl.clientHeight || 560);
  const layout = computeDfGraphLayout(dfGraph, width - 56, height - 62);
  const root = d3.select(svgEl)
    .attr("viewBox", `0 0 ${width} ${height}`)
    .attr("width", "100%")
    .attr("height", "100%");
  root.selectAll("*").remove();
  const g = root.append("g").attr("transform", "translate(28,34)");
  const maxEdgeCount = Math.max(...layout.edges.map(edge => edge.count), 1);
  const maxNodeCount = Math.max(...layout.nodes.map(node => node.count), 1);
  g.selectAll(".modal-df-edge").data(layout.edges).join("path")
    .attr("class", "modal-df-edge")
    .attr("d", d => `M${d.x1},${d.y1} Q${d.cx},${d.cy} ${d.x2},${d.y2}`)
    .attr("fill", "none")
    .attr("stroke", "rgba(37,99,235,0.32)")
    .attr("stroke-width", d => 1.4 + (d.count / maxEdgeCount) * 6)
    .attr("stroke-linecap", "round");
  const nodes = g.selectAll(".modal-df-node").data(layout.nodes).join("g")
    .attr("class", "modal-df-node")
    .attr("transform", d => `translate(${d.x},${d.y})`);
  nodes.append("circle")
    .attr("r", d => 12 + (d.count / maxNodeCount) * 18)
    .attr("fill", "rgba(37,99,235,0.14)")
    .attr("stroke", "rgba(37,99,235,0.62)")
    .attr("stroke-width", 1.6);
  nodes.append("text")
    .attr("text-anchor", "middle")
    .attr("dy", "0.34em")
    .attr("font-family", "JetBrains Mono, monospace")
    .attr("font-size", "10px")
    .attr("font-weight", "800")
    .attr("fill", "#1e3a8a")
    .text(d => d.count);
  g.selectAll(".modal-df-label").data(layout.nodes).join("text")
    .attr("class", "modal-df-label")
    .attr("x", d => d.x)
    .attr("y", d => d.y + 38)
    .attr("text-anchor", "middle")
    .attr("font-family", "Inter, system-ui, sans-serif")
    .attr("font-size", "11px")
    .attr("font-weight", "650")
    .attr("fill", "#334155")
    .text(d => d.label);
}

// ── Tooltip ───────────────────────────────────────────────────────────────────
//
// The tooltip supports clickable contents (entity links inside the
// correlated-entities section). For that to work the tooltip needs
// `pointer-events: auto`, which means moving the cursor into it triggers a
// mouseleave on the underlying dot. We use a short delayed-hide pattern so
// the cursor can travel from the dot to the tooltip without losing it:
//   • _showTooltip cancels any pending hide.
//   • _hideTooltip schedules a hide after TOOLTIP_HIDE_DELAY_MS.
//   • mouseenter on the tooltip cancels the pending hide.
//   • mouseleave on the tooltip hides immediately.
//   • a click on an entity link inside navigates and dismisses.
const TOOLTIP_HIDE_DELAY_MS = 220;
let _tooltipHideTimer = null;

function _setupTooltip() {
  const tip = document.getElementById("tooltip");
  const wrap = document.getElementById("canvas-wrap");
  if (!tip || !wrap) return;

  wrap.addEventListener("mouseleave", () => _hideTooltipNow());

  tip.addEventListener("mouseenter", () => {
    if (_tooltipHideTimer) { clearTimeout(_tooltipHideTimer); _tooltipHideTimer = null; }
  });
  tip.addEventListener("mouseleave", () => _hideTooltipNow());

  // Click delegation for "open this entity's lifecycle" links rendered
  // inside the correlated-entities section of the tooltip.
  tip.addEventListener("click", e => {
    const link = e.target.closest("[data-tip-entity-id]");
    if (!link) return;
    e.preventDefault();
    const id = link.getAttribute("data-tip-entity-id");
    if (!id) return;
    _hideTooltipNow();
    navigate("identify", { entity: id });
  });
}

function _showTooltip(html, x, y) {
  const tip = document.getElementById("tooltip");
  const wrap = document.getElementById("canvas-wrap");
  if (!tip || !wrap) return;

  if (_tooltipHideTimer) { clearTimeout(_tooltipHideTimer); _tooltipHideTimer = null; }

  const coords = (x && typeof x === "object" && Number.isFinite(x.clientX))
    ? _tooltipCoordsFromEvent(x, wrap)
    : { x: Number(x) || 0, y: Number(y) || 0 };
  const wrapW = wrap.clientWidth;
  const wrapH = wrap.clientHeight;

  if (tip.__lastHtml !== html) {
    tip.innerHTML = html;
    tip.__lastHtml = html;
  }

  const tipW = tip.offsetWidth || 240;
  const tipH = tip.offsetHeight || 100;
  // coords are relative to the visible viewport of canvas-wrap, but the
  // tooltip is an absolutely-positioned child that scrolls with the canvas
  // content. Add the scroll offset so it lands next to the cursor instead of
  // near the top of the (scrolled-away) content origin. The flip-to-other-side
  // decisions stay in visible-viewport space.
  const left = (coords.x + tipW + 16 > wrapW ? coords.x - tipW - 10 : coords.x + 14) + wrap.scrollLeft;
  const top  = (coords.y + tipH + 16 > wrapH ? coords.y - tipH - 10 : coords.y + 14) + wrap.scrollTop;
  tip.style.left = `${left}px`;
  tip.style.top  = `${top}px`;
  tip.classList.add("show");
}

function _tooltipCoordsFromEvent(event, wrap) {
  const rect = wrap.getBoundingClientRect();
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
  };
}

function _hideTooltip() {
  if (_tooltipHideTimer) clearTimeout(_tooltipHideTimer);
  _tooltipHideTimer = setTimeout(_hideTooltipNow, TOOLTIP_HIDE_DELAY_MS);
}

function _hideTooltipNow() {
  if (_tooltipHideTimer) { clearTimeout(_tooltipHideTimer); _tooltipHideTimer = null; }
  const tip = document.getElementById("tooltip");
  if (tip) {
    tip.classList.remove("show");
    tip.__lastHtml = null;
  }
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
    if (sliderVal) sliderVal.textContent = slider.value;
  });
  slider?.addEventListener("change", () => {
    const next = parseInt(slider.value, 10);
    const max  = parseInt(slider.max || slider.value, 10);
    _filters.maxEntitiesPerType = next >= max ? null : next;
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

  const compareInput = document.getElementById("compare-add-input");
  const compareResults = document.getElementById("compare-add-results");
  compareInput?.addEventListener("input", () => {
    // Variant-driven compare: the picker is restricted to the variant's
    // remaining members; filter that curated list instead of searching the
    // whole store. See _renderCompareAddPicker.
    if (_variantPickerMembers) {
      _renderVariantPickerResults(compareInput.value);
      return;
    }
    const q = compareInput.value.trim().toLowerCase();
    if (!q) { compareResults.classList.add("hidden"); return; }
    let store;
    try { store = getStore(); } catch { return; }
    const route = getRoute();
    const existing = new Set((route.params.entities ?? "").split(",").filter(Boolean));
    const hits = store.entityList
      .filter(it => !existing.has(it.id) && (it.label.toLowerCase().includes(q) || it.id.toLowerCase().includes(q) || it.type.toLowerCase().includes(q)))
      .slice(0, 8);
    if (!hits.length) { compareResults.classList.add("hidden"); return; }
    compareResults.innerHTML = hits.map(it =>
      `<div class="compare-result-row" data-id="${_escAttr(it.id)}"><span class="compare-result-label">${_escHtml(it.label)}</span><span class="compare-result-type">${_escHtml(it.type)}</span></div>`
    ).join("");
    compareResults.querySelectorAll(".compare-result-row").forEach(row => {
      row.addEventListener("click", () => {
        const r = getRoute();
        const cur = (r.params.entities ?? "").split(",").filter(Boolean);
        if (!cur.includes(row.dataset.id)) {
          navigate("compare", { entities: [...cur, row.dataset.id].join(",") });
        }
        compareInput.value = "";
        compareResults.classList.add("hidden");
      });
    });
    compareResults.classList.remove("hidden");
  });
  compareInput?.addEventListener("blur", () => {
    // Keep the variant member list visible — it's an always-on picker, not a
    // typeahead dropdown.
    if (_variantPickerMembers) return;
    setTimeout(() => compareResults?.classList.add("hidden"), 160);
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
    item.innerHTML = `<input type="checkbox" id="${id}" checked><span class="act-swatch" style="background:${actColors[activity] ?? "#64748b"}"></span><label for="${id}">${activity}</label><span class="act-count">${store.activityEventCount?.[activity] ?? 0}</span>`;
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
  wrap.addEventListener("keydown", event => {
    const action = _keyboardCameraAction(event);
    if (!action) return;
    if (action === "fit") { _fitCurrentView(); return; }
    if (action === "reset") { _resetZoom(); return; }
    event.preventDefault();
  });
  window.addEventListener("keydown", event => {
    if (event.defaultPrevented) return;
    if (!_isCanvasRouteActive() || _isTypingTarget(event.target)) return;
    const action = _keyboardCameraAction(event);
    if (action !== "fit" && action !== "reset") return;
    event.preventDefault();
    wrap.focus({ preventScroll: true });
    if (action === "fit") { _fitCurrentView(); return; }
    if (action === "reset") { _resetZoom(); return; }
  });
}

function _handleCanvasWheel(event) {
  return;
}

function _isCanvasRouteActive() {
  const route = getRoute();
  return !(route.name === "home" || route.name === "summarize" || route.name === "explore" || (route.name === "identify" && !route.params.entity));
}

function _isTypingTarget(target) {
  const tag = target?.tagName?.toLowerCase?.();
  return tag === "input" || tag === "textarea" || tag === "select" || target?.isContentEditable;
}

function _keyboardCameraAction(event) {
  const { key } = event;
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
  const nextScale = Math.max(_minZoomScale, Math.min(ZOOM_MAX_SCALE, s.k * scaleFactor));
  if (!Number.isFinite(nextScale) || nextScale === s.k) return s;
  const wx = (px - s.x) / s.k;
  const wy = (py - s.y) / s.k;
  return d3.zoomIdentity.translate(px - wx * nextScale, py - wy * nextScale).scale(nextScale);
}

function _applyTransform(transform) {
  if (!transform) return;
  const t = _constrainTransform(transform);
  currentTransform = t;
  gRoot.style("transform",
    `translate(${t.x}px,${t.y}px) scale(${t.k})`);
}

function _constrainTransform(transform) {
  if (!svg || !gRoot || !_isCanvasRouteActive()) return transform;
  const scale = Math.max(_minZoomScale, Math.min(ZOOM_MAX_SCALE, transform.k));
  const viewportW = svg.node().clientWidth || 1;
  const viewportH = svg.node().clientHeight || 1;
  let bounds = null;
  try {
    const bbox = gRoot.node().getBBox();
    bounds = bbox.width > 0 && bbox.height > 0 ? bbox : null;
  } catch {
    bounds = null;
  }
  if (!bounds) return transform;

  const margin = 72;
  const scaledW = bounds.width * scale;
  const scaledH = bounds.height * scale;
  let minX = viewportW - margin - (bounds.x + bounds.width) * scale;
  let maxX = margin - bounds.x * scale;
  let minY = viewportH - margin - (bounds.y + bounds.height) * scale;
  let maxY = margin - bounds.y * scale;

  if (scaledW + margin * 2 <= viewportW) {
    const centeredX = viewportW / 2 - (bounds.x + bounds.width / 2) * scale;
    minX = centeredX;
    maxX = centeredX;
  }
  if (scaledH + margin * 2 <= viewportH) {
    const centeredY = viewportH / 2 - (bounds.y + bounds.height / 2) * scale;
    minY = centeredY;
    maxY = centeredY;
  }

  const x = Math.min(maxX, Math.max(minX, transform.x));
  const y = Math.min(maxY, Math.max(minY, transform.y));
  return d3.zoomIdentity.translate(x, y).scale(scale);
}

// ── Sidebar entity lists ──────────────────────────────────────────────────────
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
  if (route.name === "summarize") {
    _buildEntityList(store, _entitySearchQuery);
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

// ── Drag-to-zoom time window (T2 / T3-compare) ───────────────────────────────
// On the detail SVG, drag horizontally across empty canvas space to pick a
// time range. Writes ?dateFrom & ?dateTo and re-fires the route (replace
// history, not push). A small chip in the top-right of #canvas-wrap shows
// the active window with a reset ×.
//
// Implementation notes:
//   • The background <rect class="canvas-brush-bg"> appended in init() sits
//     below gRoot in document order, so nodes/edges in gRoot still receive
//     their own clicks; the rect only fires when the user drags on a part
//     of the canvas that has no other element under the cursor.
//   • The drag overlay is appended directly to <svg>, NOT to gRoot, so the
//     zoom transform on gRoot does not warp the overlay rectangle.
//   • Conversion from viewport-x to time uses currentTransform to undo the
//     CSS transform applied to gRoot.
//   • _brushAxis caches { TIMELINE_X0, timelineW, rangeMin, rangeMax } from
//     the most recent detail layout; null on other routes.
let _brushAxis = null;
let _activeBrushDrag = null;

function _cacheTimeAxis(layout) {
  if (!layout?.timeScale || !layout?.axis) { _brushAxis = null; return; }
  _brushAxis = {
    TIMELINE_X0: layout.axis.x1,
    timelineW: Math.max(1, layout.axis.x2 - layout.axis.x1),
    rangeMin: layout.timeScale.rangeMin,
    rangeMax: layout.timeScale.rangeMax,
  };
}

// Drag threshold in CSS pixels. Below this, the gesture is a click and is
// allowed to flow through to whatever was clicked (a dot, a band header,
// the SVG background, etc.). Above this, the gesture becomes a brush and
// the following click is swallowed by a capture-phase listener.
const TIME_BRUSH_DRAG_THRESHOLD = 5;

function _onCanvasTimeBrushDown(ev) {
  if (!_brushAxis) return;
  const route = getRoute();
  const isT2 = route.name === "identify" && route.params.entity;
  const isT3Compare = route.name === "compare" && route.params.entities;
  if (!isT2 && !isT3Compare) return;
  if (ev.button !== 0) return;
  if (ev.shiftKey || ev.ctrlKey || ev.metaKey || ev.altKey) return;

  const svgEl = svg.node();
  const svgRect = svgEl.getBoundingClientRect();
  const startVx = ev.clientX - svgRect.left;

  const t = currentTransform ?? d3.zoomIdentity;
  const minX = _brushAxis.TIMELINE_X0;
  const maxX = _brushAxis.TIMELINE_X0 + _brushAxis.timelineW;

  let isBrushing = false;
  let overlay = null;

  const finishDrag = () => {
    document.removeEventListener("mousemove", onMove, true);
    document.removeEventListener("mouseup", onUp, true);
  };

  const onMove = e => {
    const vx = e.clientX - svgRect.left;
    const dx = Math.abs(vx - startVx);
    if (!isBrushing && dx >= TIME_BRUSH_DRAG_THRESHOLD) {
      isBrushing = true;
      overlay = svg.append("rect")
        .attr("class", "canvas-brush-overlay")
        .attr("x", startVx).attr("y", 0)
        .attr("width", 0)
        .attr("height", svgEl.clientHeight);
      _activeBrushDrag = { startVx, overlay };
    }
    if (isBrushing) {
      const x0 = Math.min(startVx, vx);
      const x1 = Math.max(startVx, vx);
      overlay.attr("x", x0).attr("width", x1 - x0);
      e.preventDefault();
    }
  };

  const onUp = e => {
    finishDrag();
    if (!isBrushing) {
      // No drag happened — let the click on the underlying element proceed.
      // (Selection-clear via canvas click is handled separately below.)
      return;
    }
    overlay.remove();
    _activeBrushDrag = null;
    const vx = e.clientX - svgRect.left;
    const a = Math.min(startVx, vx);
    const b = Math.max(startVx, vx);
    const cx0 = Math.max(minX, Math.min(maxX, (a - t.x) / t.k));
    const cx1 = Math.max(minX, Math.min(maxX, (b - t.x) / t.k));
    const span = _brushAxis.rangeMax - _brushAxis.rangeMin;
    const fromMs = Math.round(_brushAxis.rangeMin + ((cx0 - minX) / _brushAxis.timelineW) * span);
    const toMs   = Math.round(_brushAxis.rangeMin + ((cx1 - minX) / _brushAxis.timelineW) * span);
    if (toMs - fromMs < 1) return;

    // Swallow the click that the browser will dispatch after this mouseup;
    // otherwise the underlying element (a dot, a band header) would think
    // it was clicked at the drag endpoint.
    const swallow = ce => {
      ce.stopPropagation();
      ce.preventDefault();
      window.removeEventListener("click", swallow, true);
    };
    window.addEventListener("click", swallow, true);
    // Failsafe: detach after a microtask in case no click ever fires.
    setTimeout(() => window.removeEventListener("click", swallow, true), 0);

    const newParams = { ...route.params, dateFrom: String(fromMs), dateTo: String(toMs) };
    navigate(route.name, newParams, { replace: true });
  };

  document.addEventListener("mousemove", onMove, true);
  document.addEventListener("mouseup", onUp, true);
}

function _resetTimeWindow() {
  const route = getRoute();
  if (!route.params.dateFrom && !route.params.dateTo) return;
  const newParams = { ...route.params };
  delete newParams.dateFrom;
  delete newParams.dateTo;
  navigate(route.name, newParams, { replace: true });
}

function _updateTimeWindowChip(route) {
  const chip = document.getElementById("time-window-chip");
  const range = document.getElementById("time-window-chip-range");
  if (!chip || !range) return;
  const isT2 = route.name === "identify" && route.params.entity;
  const isT3Compare = route.name === "compare" && route.params.entities;
  document.body.classList.toggle("time-brush-active", Boolean(isT2 || isT3Compare));
  const fromMs = Number(route.params.dateFrom) || null;
  const toMs   = Number(route.params.dateTo) || null;
  const show = (isT2 || isT3Compare) && fromMs && toMs;
  chip.classList.toggle("hidden", !show);
  if (!show) return;
  const fmt = t => new Date(t).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
  range.textContent = `${fmt(fromMs)} → ${fmt(toMs)}`;
}

function _updateHeaderTags(route, store) {
  const tagEl = document.getElementById("panel-view-tag");
  if (!tagEl) return;
  const names = { home: "HOME", summarize: "POPULATION", identify: "LIFECYCLE", compare: "COMPARE", explore: "EXPLORE" };
  tagEl.textContent = names[route.name] ?? route.name.toUpperCase();
}

function _updateStatusBar(store) {
  if (!store) return;
  document.getElementById("status-events").innerHTML = `Events: <b>${store.events.length.toLocaleString()}</b>`;
  document.getElementById("status-entities").innerHTML = `Entities: <b>${store.entities.length.toLocaleString()}</b>`;
  const route = getRoute();
  let tail = `${store.caseType ?? "Cases"}: <b>${store.caseList.length.toLocaleString()}</b>`;
  if (route.name === "summarize") {
    tail = `Types: <b>${store?.typeRegistry?.types?.length ?? 0}</b>`;
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
    itemLabel.textContent = "Primary entities";
    memberLabel.textContent = "Parent entities";
    itemList.innerHTML = `<div class="empty-note">Select a variant to list its lowest-level entities.</div>`;
    memberList.innerHTML = `<div class="empty-note">Select a variant to list its parent entities.</div>`;
    return;
  }
  const itemType = variantData.itemType ?? "Items";
  const caseType = variantData.caseType ?? "Cases";
  itemLabel.textContent   = `${itemType} in variant`;
  memberLabel.textContent = `${caseType} in variant`;
  if (!selectedVariant) {
    summaryTitle.textContent = "Variant Overview";
    summaryContent.innerHTML = _rowsToHtml([
      { label: "Variants",      value: variantData.variantCount },
      { label: "Shown rows",    value: `${variantData.variants.length} (top 20%)` },
      { label: "Instances",     value: variantData.totalInstances },
      { label: "Top share",     value: formatPercent(variantData.summary?.dominantVariantShare ?? 0) },
      { label: "Avg variant size", value: (variantData.summary?.averageVariantSize ?? 0).toFixed(1) },
      { label: "Avg sequence length", value: (variantData.summary?.averageSequenceLength ?? 0).toFixed(1) },
      { divider: true },
      { label: "Selection", value: "Click a variant row to inspect it", className: "flow" },
    ]);
    itemLabel.textContent = `${itemType} in selected variant`;
    memberLabel.textContent = `${caseType} in selected variant`;
    itemList.innerHTML   = `<div class="empty-note">Select a variant to list its primary ${itemType.toLowerCase()} entities.</div>`;
    memberList.innerHTML = `<div class="empty-note">Select a variant to list its linked ${caseType.toLowerCase()} entities.</div>`;
    return;
  }
  summaryTitle.textContent = `Variant ${selectedVariant.rank}`;
  summaryContent.innerHTML = _variantSummaryHtml(selectedVariant, itemType, caseType);

  const topMembers = (selectedVariant.members ?? []).slice(0, 3).map(x => x.id);
  if (topMembers.length > 1) {
    // The top-N picker uses the variant's own `members` ranking, which is
    // sorted by item count desc → event count desc → label asc (see
    // getVariantOverview in store.js). So "top 3" means the three parent
    // entities that own the most items belonging to this variant.
    const topTitle = `Top ${topMembers.length} ${_escHtml(caseType.toLowerCase())} ranked by items in this variant`;
    summaryContent.insertAdjacentHTML("beforeend", `<div class="variant-summary-actions">
      <button type="button" class="btn btn-sm" id="btn-compare-top3" title="${topTitle}">Compare top ${topMembers.length} ${_escHtml(caseType.toLowerCase())}</button>
      <div class="variant-summary-hint">Ranked by items in this variant (item count → event count → id)</div>
    </div>`);
    summaryContent.querySelector("#btn-compare-top3")?.addEventListener("click", () => {
      // Pass the variant key so the compare detail view restricts the
      // item-band to this variant's items, not every item of every parent.
      navigate("compare", { entities: topMembers.join(","), variant: selectedVariant.key });
    });
  }
  itemLabel.textContent = `${itemType} in variant (primary)`;
  memberLabel.textContent = `${caseType} linked to variant`;
  _renderVariantEntityList(itemList, selectedVariant.items, item => `${item.eventCount} events`, "id");
  _renderVariantEntityList(memberList, selectedVariant.members, member => `${member.itemCount} ${itemType.toLowerCase()} - ${member.eventCount} events`, "id");
}

function _variantSummaryHtml(variant, itemType, caseType) {
  const sequence = _formatSequencePreview(variant.sequence);
  const resources = _formatCountList(variant.topResources, "label");
  const activities = _formatCountList(variant.topActivities, "activity");
  const range = _formatDateRange(variant.firstDate, variant.lastDate);
  return `
    <div class="variant-summary-hero">
      <div class="variant-summary-rank">Variant ${_escHtml(variant.rank)}</div>
      <div class="variant-summary-share">${_escHtml(formatPercent(variant.frequency))}</div>
      <div class="variant-summary-sub">${_escHtml(variant.count)} instances - ${_escHtml(variant.itemCount)} ${_escHtml(itemType.toLowerCase())} - ${_escHtml(variant.memberCount)} ${_escHtml(caseType.toLowerCase())}</div>
      ${variant.isdominant ? `<div class="variant-summary-badge">Dominant variant</div>` : ""}
    </div>
    <div class="variant-summary-metrics">
      ${_variantMetricHtml("Events", variant.eventTotal)}
      ${_variantMetricHtml("Avg events/item", variant.eventAverage.toFixed(1))}
      ${_variantMetricHtml("Avg duration", _formatHoursLabel(variant.avgDurationHours))}
      ${_variantMetricHtml("Resources", variant.resourceCount)}
    </div>
    <div class="variant-summary-section">
      <b>Sequence</b>
      <span>${_escHtml(sequence)}</span>
    </div>
    <div class="variant-summary-section">
      <b>Top activities</b>
      <span>${_escHtml(activities)}</span>
    </div>
    <div class="variant-summary-section">
      <b>Top resources</b>
      <span>${_escHtml(resources)}</span>
    </div>
    <div class="variant-summary-section">
      <b>Time range</b>
      <span>${_escHtml(range)}</span>
    </div>
    <div class="variant-summary-note">
      Primary entities below are ${_escHtml(itemType)} because variants are built from their lifecycles. Linked ${_escHtml(caseType)} stay available as context.
    </div>
  `;
}

function _variantMetricHtml(label, value) {
  return `<div class="variant-summary-metric"><span>${_escHtml(label)}</span><b>${_escHtml(value)}</b></div>`;
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

// ── Shared-cluster isolation ────────────────────────────────────────────────
function _openClusterIsolation(cluster) {
  const eventIds = (cluster.ids ?? cluster.eventIds ?? []).map(id => String(id));
  if (!eventIds.length) return;
  _clusterActivityContext = null;
  _selection = null;
  _isolatedClusterContext = {
    clusterId: String(cluster.clusterId ?? cluster.id ?? "shared-cluster"),
    eventIds,
    sharedEntityIds: (cluster.sharedEntityIds ?? []).map(id => String(id)),
    activityCounts: [...(cluster.activityCounts ?? [])].map(x => ({
      activity: x.activity,
      color: x.color,
      count: x.count ?? 0,
    })),
  };
  handleRoute(getRoute());
}

function _closeClusterIsolation() {
  if (!_isolatedClusterContext) return;
  _isolatedClusterContext = null;
  handleRoute(getRoute());
}

function _resolveDetailRenderGraph(detailGraph) {
  if (!detailGraph || !_isolatedClusterContext) return detailGraph;
  const eventIds = new Set(_isolatedClusterContext.eventIds ?? []);
  const present = detailGraph.eventAnchors?.some(anchor => eventIds.has(String(anchor.event_id)));
  if (!present) {
    _isolatedClusterContext = null;
    return detailGraph;
  }
  return _buildIsolatedClusterGraph(detailGraph, eventIds);
}

function _buildIsolatedClusterGraph(detailGraph, eventIds) {
  const eventAnchors = (detailGraph.eventAnchors ?? [])
    .filter(anchor => eventIds.has(String(anchor.event_id)))
    .map(anchor => ({ ...anchor }));
  const visibleEventIds = new Set(eventAnchors.map(anchor => String(anchor.event_id)));
  const visibleEntityIds = new Set(eventAnchors.flatMap(anchor =>
    (anchor.memberships ?? []).map(membership => membership.entity_id)
  ));
  const bands = (detailGraph.bands ?? []).map(band => {
    const lanes = (band.lanes ?? []).map(lane => {
      if (!visibleEntityIds.has(lane.entity_id)) return null;
      const events = (lane.events ?? []).filter(event => visibleEventIds.has(String(event.event_id)));
      const memberships = (lane.memberships ?? []).filter(membership => visibleEventIds.has(String(membership.event_id)));
      if (!events.length && !memberships.length) return null;
      return {
        ...lane,
        events,
        eventIds: events.map(event => event.event_id),
        memberships,
        dfEdges: (lane.dfEdges ?? []).filter(edge =>
          visibleEventIds.has(String(edge.source_event_id)) && visibleEventIds.has(String(edge.target_event_id))
        ),
        eventCount: events.length,
        sequence: events.map(event => event.activity).filter(Boolean),
      };
    }).filter(Boolean);
    return lanes.length ? { ...band, lanes } : null;
  }).filter(Boolean);
  const relations = (detailGraph.relations ?? []).filter(relation =>
    visibleEntityIds.has(relation.source_entity_id) && visibleEntityIds.has(relation.target_entity_id)
  );
  const summary = {
    ...(detailGraph.summary ?? {}),
    visibleEntityTypeCount: bands.length,
    visibleEntityCount: visibleEntityIds.size,
    eventCount: eventAnchors.length,
    relationCount: relations.length,
    sharedEventCount: eventAnchors.filter(anchor => anchor.sharedEntityIds.length > 1).length,
    sharedEventHotspots: eventAnchors.map(anchor => ({
      event_id: anchor.event_id,
      activity: anchor.activity,
      entityCount: anchor.sharedEntityIds?.length ?? 0,
      entityTypes: anchor.sharedEntityTypes ?? [],
    })),
    parallelEntityTypes: bands.map(band => ({ entityType: band.entityType, count: band.lanes.length })),
  };
  return {
    ...detailGraph,
    eventAnchors,
    bands,
    relations,
    sharedEvents: eventAnchors.filter(anchor => anchor.sharedEntityIds.length > 1),
    crossTypeLinks: [],
    visibleEntityIds: [...visibleEntityIds],
    visibleEntityTypes: bands.map(band => band.entityType),
    summary,
    isClusterIsolation: true,
    isolatedCluster: _isolatedClusterContext,
  };
}

function _updateClusterIsolationControl(detailGraph) {
  const wrap = document.getElementById("canvas-wrap");
  if (!wrap) return;
  let panel = document.getElementById("cluster-isolation-panel");
  if (!detailGraph?.isClusterIsolation || !_isolatedClusterContext) {
    panel?.remove();
    return;
  }
  if (!panel) {
    panel = document.createElement("div");
    panel.id = "cluster-isolation-panel";
    panel.className = "cluster-isolation-panel";
    wrap.appendChild(panel);
  }
  const activities = (_isolatedClusterContext.activityCounts ?? [])
    .slice(0, 3)
    .map(item => `${_escHtml(item.activity)} (${item.count})`)
    .join(", ");
  panel.innerHTML = `
    <div class="cluster-isolation-copy">
      <b>Shared-event isolated view</b>
      <span>${(_isolatedClusterContext.eventIds ?? []).length} events${activities ? ` - ${activities}` : ""}</span>
    </div>
    <button type="button" class="topbar-btn" id="btn-close-cluster-isolation">Back to complete trace</button>
  `;
  panel.querySelector("#btn-close-cluster-isolation")?.addEventListener("click", _closeClusterIsolation);
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
  gRoot.selectAll(".df-link-bottleneck-halo")
    .attr("display", vis.df && vis.bottleneck ? null : "none")
    .attr("opacity", vis.bottleneck ? opa.df : opa.df * 0.2);
  gRoot.selectAll(".corr-link").attr("display", vis.corr ? null : "none").attr("opacity", opa.corr);
  gRoot.selectAll(".relation-link").attr("display", vis.relations ? null : "none").attr("opacity", opa.relations);
  gRoot.selectAll(".shared-guide").attr("display", vis.sync ? null : "none").attr("opacity", vis.sync ? 1 : 0.12);
  gRoot.selectAll(".df-link-bottleneck").attr("opacity", vis.bottleneck ? opa.df : opa.df * 0.2);
}

function _toggleSelection(sel) {
  _selection = (_selection && JSON.stringify(_selection) === JSON.stringify(sel)) ? null : sel;
  _applySelectionStateDeferred();
}

function _clearSelection() { _selection = null; _applySelectionStateDeferred(); }

function _applySelectionStateDeferred() {
  if (_selectionRaf) cancelAnimationFrame(_selectionRaf);
  _selectionRaf = requestAnimationFrame(() => { _selectionRaf = null; _applySelectionState(); });
}

function _applySelectionState() {
  if (!gRoot) return;
  const anchors  = gRoot.selectAll(".event-anchor-core, .event-cluster-core");
  const markers  = gRoot.selectAll(".lane-marker-circle");
  const dfEdges  = gRoot.selectAll(".df-link");
  const dfHalos  = gRoot.selectAll(".df-link-bottleneck-halo");
  const lanes    = gRoot.selectAll(".entity-lane");
  const corrLinks = gRoot.selectAll(".corr-link");
  anchors.classed("highlighted", false).classed("dimmed", false);
  markers.classed("highlighted", false).classed("dimmed", false);
  dfEdges.classed("edge-highlighted", false).classed("edge-dimmed", false);
  dfHalos.classed("edge-highlighted", false).classed("edge-dimmed", false);
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
    dfHalos.classed("edge-highlighted", function() { return d3.select(this).attr("data-edge-id") === _selection.edgeId; })
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
  _setDocumentCanvas(totalHeight, { scrollTop: options.scrollTop ?? true });
}

function _fitCurrentView() {
  if (!_isCanvasRouteActive()) {
    document.getElementById("screen-host")?.scrollTo({ top: 0, behavior: "auto" });
    return;
  }
  const route = getRoute();
  if (route.name === "identify" || (route.name === "compare" && _compareMode === "compare")) _fitDetailView();
  else if (route.name === "compare" && _compareMode === "variants") _fitVariantView();
  else _fitToView(_lastTotalHeight);
}

function _fitVariantView() {
  _fitToView(_lastTotalHeight, { alignTop: true, alignLeft: true, minScale: 0.32, padX: 28, padY: 24, preferWidth: true, lockZoomFloor: true });
}

function _fitDetailView() {
  _fitToView(_lastTotalHeight, { alignTop: true, alignLeft: true, minScale: 0.34, padX: 28, padY: 26, preferWidth: true, lockZoomFloor: true });
}


function _resetZoom() {
  if (!svg) return;
  _fitCurrentView();
}

function _setZoomFloor(scale) {
  _minZoomScale = Number.isFinite(scale) ? Math.max(ZOOM_MIN_SCALE, scale) : ZOOM_MIN_SCALE;
}

function _setDocumentCanvas(totalHeight, options = {}) {
  const svgNode = svg?.node?.();
  const wrap = document.getElementById("canvas-wrap");
  if (!svgNode || !wrap) return;

  let bounds = null;
  try {
    const bbox = gRoot.node().getBBox();
    bounds = bbox.width > 0 && bbox.height > 0 ? bbox : null;
  } catch {
    bounds = null;
  }

  const viewportW = Math.max(wrap.clientWidth || svgNode.clientWidth || 900, 1);
  const viewportH = Math.max(wrap.clientHeight || svgNode.clientHeight || 600, 1);
  const contentW = bounds ? Math.ceil(bounds.x + bounds.width + 48) : viewportW;
  const contentH = bounds ? Math.ceil(bounds.y + bounds.height + 48) : (totalHeight ?? viewportH);
  const width = Math.max(viewportW, contentW);
  const height = Math.max(viewportH, Math.ceil(totalHeight ?? 0), contentH);

  svg
    .attr("width", width)
    .attr("height", height)
    .style("width", `${width}px`)
    .style("height", `${height}px`);
  currentTransform = d3.zoomIdentity;
  gRoot.style("transform", "translate(0px,0px) scale(1)");

  if (options.scrollTop) {
    wrap.scrollTo({ left: 0, top: 0, behavior: "auto" });
  }
}

// ── Sidebar collapse toggle ───────────────────────────────────────────────────
// The CSS hides #sidebar and #sidebar-resizer when <body> carries the
// .sidebar-collapsed class. The canvas re-fits to its new width on each
// toggle by re-running the current route (same path used by the resize
// drag handler), so layouts that depend on viewport width recompute.
function _setupSidebarToggle() {
  const btn = document.getElementById("btn-sidebar-toggle");
  if (!btn) return;
  const sync = () => {
    const collapsed = document.body.classList.contains("sidebar-collapsed");
    btn.setAttribute("aria-pressed", collapsed ? "true" : "false");
    btn.setAttribute("aria-label", collapsed ? "Show sidebar" : "Hide sidebar");
    btn.setAttribute("title", collapsed ? "Show sidebar" : "Hide sidebar");
  };
  sync();
  btn.addEventListener("click", () => {
    document.body.classList.toggle("sidebar-collapsed");
    sync();
    handleRoute(getRoute());
  });
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
  const p = seq.slice(0, 5).join(" -> ");
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
  return `${first.toLocaleDateString("en-GB")} -> ${last.toLocaleDateString("en-GB")}`;
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
