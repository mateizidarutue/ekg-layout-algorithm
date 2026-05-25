"use strict";

// ─── LEGACY (v1) ────────────────────────────────────────────────────────────
// The new primary T1 view lives in screens/ekg.js (route /ekg). This file is
// kept around for comparison while the new view is being evaluated, and is
// reachable from the home screen's "Open legacy Atlas →" link. Don't extend
// it; new work goes into screens/ekg.js, layout/ekgViewLayout.js, and
// render/ekgViewRender.js.
// ────────────────────────────────────────────────────────────────────────────

// EKG Atlas — interactive exploration screen.
//
// The Atlas is the primary T1 view. It's a DOM-driven screen (rendered into
// `screen-host`) with three sections:
//
//   1. Header  — global search, active filter chips, reset
//   2. Panels  — inline SVG holding the three coordinated views (type graph,
//                temporal streamgraph, activity flow). The renderer treats the
//                whole thing as focus-aware: setting a focus dims unrelated
//                elements in every panel.
//   3. Drawer  — three tabs (Entities, Activities, Shared events) whose
//                contents are filtered by the current focus + search query.
//                Every row drills into one of the supporting tasks
//                (Identify/Compare/Explore), or selects entities for compare.
//
// Focus state is persisted in the URL (?focus=type:X|activity:Y|edge:A__B,
// ?tab=entities|activities|shared) so back/forward and bookmarks work. The
// search query is intentionally NOT in the URL — it changes on every keystroke
// and would pollute history.

import { navigate, getRoute, buildHash } from "../router.js";
import { getEntitiesForHotspot, getGlobalSharedEventHotspots } from "../data/store.js";
import { computeAtlasLayout } from "../layout/atlasLayout.js";
import { drawAtlasView } from "../render/atlasRender.js";

const TABS = ["entities", "activities", "shared"];
const DEFAULT_TAB = "entities";

// Per-session UI state, intentionally module-scoped so it survives re-renders
// triggered by URL changes without ping-ponging through the router.
let _searchQuery = "";
let _compareSelection = new Set();
let _sortKeyByTab = { entities: "events", activities: "frequency", shared: "frequency" };
let _showTopOnly = true;
let _hoverCallbacks = { show: null, hide: null };

// ── Public API ──────────────────────────────────────────────────────────────

export function renderAtlasScreen(opts) {
  const { atlas, store, focus, tab, hoverCallbacks } = opts;
  _hoverCallbacks = hoverCallbacks ?? {};

  const host = document.getElementById("screen-host");
  if (!host) return;

  if (!atlas || !atlas.typeNodes?.length) {
    host.innerHTML = `<div class="atlas-screen"><div class="atlas-empty">No data — try clearing the activity filter or loading a different dataset.</div></div>`;
    return;
  }

  // Reset compare selection if focus moved off entities OR if the focused
  // type no longer covers the selection.
  if (focus && focus.kind !== "type") {
    _compareSelection.clear();
  }

  host.innerHTML = _buildScreenHtml(atlas, focus, tab);

  // 1. Wire the SVG panels.
  _renderAtlasSvg(host, atlas, focus);

  // 2. Wire the search + chips + tabs (header / drawer chrome).
  _wireHeader(host, atlas, focus, tab);

  // 3. Render the drawer rows (depends on search/focus/tab).
  _renderDrawerBody(host, atlas, store, focus, tab);
}

// Sidebar summary — unchanged contract from v1; uses the rich state of the
// drawer when a focus is set so users see "you have 24 PO entities" not just
// global totals.
export function updateAtlasSidebar(atlas, focus = null) {
  const title = document.getElementById("atlas-summary-title");
  const content = document.getElementById("atlas-summary-content");
  if (!title || !content) return;

  if (!atlas) {
    title.textContent = "EKG Atlas";
    content.innerHTML = `<div class="stat-row"><span class="stat-label">Loading…</span></div>`;
    return;
  }

  const stats = atlas.stats ?? {};
  const tRange = atlas.timeRange ?? {};
  const minDate = Number.isFinite(tRange.min) ? new Date(tRange.min) : null;
  const maxDate = Number.isFinite(tRange.max) ? new Date(tRange.max) : null;

  const focusLabel = _describeFocus(focus);
  title.textContent = focusLabel ? `EKG Atlas · ${focusLabel}` : "EKG Atlas";

  const rows = [
    _row("Events", `${stats.events?.toLocaleString?.() ?? 0}${stats.totalEvents && stats.totalEvents !== stats.events ? ` / ${stats.totalEvents.toLocaleString()}` : ""}`),
    _row("Entities", stats.entities?.toLocaleString?.() ?? 0),
    _row("Entity types", stats.entityTypes ?? 0),
    _row("Shared events", stats.sharedEvents?.toLocaleString?.() ?? 0),
    { divider: true },
    _row("Span", _formatDateRange(minDate, maxDate)),
    { divider: true },
    { subtitle: "Quick tour" },
    { hint: "1. Click a type node to browse its entities." },
    { hint: "2. Click an activity to focus the bands." },
    { hint: "3. Use the search box to jump to an entity by id." },
  ];

  content.innerHTML = rows.map(_renderSidebarRow).join("");
}

// ── URL focus param parsing ─────────────────────────────────────────────────
//
// Encoded as a single string `kind:value` so it stays human-readable. The
// edge encoding uses `__` between the two endpoints so the value contains no
// reserved URL characters.

export function parseAtlasFocus(raw) {
  if (!raw) return null;
  const decoded = decodeURIComponent(String(raw));
  const colon = decoded.indexOf(":");
  if (colon < 0) return null;
  const kind = decoded.slice(0, colon);
  const value = decoded.slice(colon + 1);
  if (!["type", "activity", "edge", "hotspot"].includes(kind)) return null;
  if (kind === "edge" && !value.includes("__")) return null;
  return { kind, value };
}

export function serializeAtlasFocus(focus) {
  if (!focus || !focus.kind || focus.value == null) return "";
  return `${focus.kind}:${focus.value}`;
}

export function normalizeAtlasTab(raw) {
  return TABS.includes(raw) ? raw : DEFAULT_TAB;
}

// ── Internals ───────────────────────────────────────────────────────────────

function _buildScreenHtml(atlas, focus, tab) {
  const stats = atlas.stats ?? {};
  const counts = _counts(atlas, focus, _searchQuery);
  const chips = _buildChipsHtml(focus);

  return `
    <div class="atlas-screen">
      <div class="atlas-header">
        <div class="atlas-header-row">
          <div class="atlas-search-wrap">
            <svg viewBox="0 0 16 16" class="atlas-search-icon" aria-hidden="true">
              <circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" stroke-width="1.5"/>
              <path d="M11 11l3.5 3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            </svg>
            <input id="atlas-search-input" type="search"
              class="atlas-search-input"
              placeholder="Search entities, activities, types…"
              value="${_esc(_searchQuery)}"
              autocomplete="off" />
            ${_searchQuery ? `<button type="button" class="atlas-search-clear" id="atlas-search-clear" aria-label="Clear search">×</button>` : ""}
          </div>
          <div class="atlas-header-stats">
            <span><b>${stats.entities?.toLocaleString?.() ?? 0}</b> entities</span>
            <span><b>${stats.events?.toLocaleString?.() ?? 0}</b> events</span>
            <span><b>${stats.entityTypes ?? 0}</b> types</span>
            <span><b>${stats.sharedEvents?.toLocaleString?.() ?? 0}</b> shared</span>
          </div>
        </div>
        ${chips ? `<div class="atlas-chips">${chips}</div>` : ""}
      </div>

      <section class="atlas-panels-section">
        <div class="atlas-svg-wrap" id="atlas-svg-wrap"></div>
      </section>

      <section class="atlas-drawer">
        <div class="atlas-tabs" role="tablist">
          ${TABS.map(t => _tabButtonHtml(t, tab, counts[t])).join("")}
          <div class="atlas-tab-spacer"></div>
          <label class="atlas-toggle">
            <input type="checkbox" id="atlas-show-top" ${_showTopOnly ? "checked" : ""} />
            <span>Show top results only</span>
          </label>
        </div>
        ${_renderCompareTrayHtml()}
        <div class="atlas-tab-body" id="atlas-tab-body"></div>
      </section>
    </div>
  `;
}

function _tabButtonHtml(tabName, currentTab, count) {
  const labels = { entities: "Entities", activities: "Activities", shared: "Shared events" };
  const isActive = tabName === currentTab;
  return `<button type="button" class="atlas-tab${isActive ? " active" : ""}" role="tab" data-tab="${tabName}" aria-selected="${isActive}">${labels[tabName]} <span class="atlas-tab-count">${count?.toLocaleString?.() ?? 0}</span></button>`;
}

function _renderCompareTrayHtml() {
  const ids = [..._compareSelection];
  if (!ids.length) return "";
  return `
    <div class="atlas-compare-tray">
      <span class="atlas-compare-label">Compare bin · ${ids.length} selected</span>
      <span class="atlas-compare-chips">
        ${ids.slice(0, 6).map(id => `<span class="atlas-compare-chip" data-entity-id="${_esc(id)}">${_esc(_shortId(id))}<button type="button" class="atlas-compare-chip-x" data-remove="${_esc(id)}" aria-label="Remove">×</button></span>`).join("")}
        ${ids.length > 6 ? `<span class="atlas-compare-chip-more">+${ids.length - 6}</span>` : ""}
      </span>
      <button type="button" class="atlas-btn-primary" id="atlas-compare-open" ${ids.length < 2 ? "disabled" : ""}>Open in Compare →</button>
      <button type="button" class="atlas-btn-ghost" id="atlas-compare-clear">Clear bin</button>
    </div>
  `;
}

function _buildChipsHtml(focus) {
  if (!focus) return "";
  let label = "";
  let kindLabel = "";
  switch (focus.kind) {
    case "type":      kindLabel = "Type";     label = focus.value; break;
    case "activity":  kindLabel = "Activity"; label = focus.value; break;
    case "edge":      kindLabel = "Edge";     label = focus.value.replaceAll("__", " ↔ "); break;
    case "hotspot":   kindLabel = "Hotspot";  label = focus.value.replace(/^act:/, ""); break;
    default: return "";
  }
  return `
    <span class="atlas-chip">
      <span class="atlas-chip-kind">${kindLabel}:</span>
      <span class="atlas-chip-value">${_esc(label)}</span>
      <button type="button" class="atlas-chip-x" id="atlas-chip-clear" aria-label="Clear focus">×</button>
    </span>
    <button type="button" class="atlas-chip-reset" id="atlas-reset-btn">Reset all</button>
  `;
}

// ── SVG panels ──────────────────────────────────────────────────────────────

function _renderAtlasSvg(host, atlas, focus) {
  const wrap = host.querySelector("#atlas-svg-wrap");
  if (!wrap) return;
  const width = Math.max(wrap.clientWidth || 1100, 720);
  const layout = computeAtlasLayout(atlas, width);
  const height = Math.max(layout.totalHeight, 600);

  wrap.innerHTML = `<svg class="atlas-svg" width="100%" height="${height}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMin meet"></svg>`;
  const svg = d3.select(wrap.querySelector(".atlas-svg"));
  const lBg     = svg.append("g").attr("class", "atlas-l-bg");
  const lMeta   = svg.append("g").attr("class", "atlas-l-meta");
  const lNodes  = svg.append("g").attr("class", "atlas-l-nodes");
  const lLabels = svg.append("g").attr("class", "atlas-l-labels");

  drawAtlasView(layout, lBg, lMeta, lNodes, lLabels, {
    onTypeSelect: type => _setFocus({ kind: "type", value: type }),
    onActivitySelect: activity => _setFocus({ kind: "activity", value: activity }),
    onEdgeSelect: edge => _setFocus({ kind: "edge", value: `${edge.source}__${edge.target}` }, { tab: "shared" }),
    onSyncSelect: arc => _setFocus({ kind: "edge", value: `${arc.type1}__${arc.type2}` }, { tab: "shared" }),
    onTooltipShow: (html, event) => _hoverCallbacks.show?.(html, event),
    onTooltipHide: () => _hoverCallbacks.hide?.(),
  }, focus);
}

// ── Header wiring ───────────────────────────────────────────────────────────

function _wireHeader(host, atlas, focus, tab) {
  // Search input — live filter (no URL pollution).
  const input = host.querySelector("#atlas-search-input");
  let debounce = null;
  input?.addEventListener("input", e => {
    _searchQuery = e.target.value;
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      _updateTabCounts(host, atlas, focus);
      _renderDrawerBody(host, atlas, /*store*/ null, focus, tab);
      const clearBtn = host.querySelector("#atlas-search-clear");
      // Show/hide the clear button without rebuilding the whole screen.
      if (_searchQuery && !clearBtn) {
        const wrap = host.querySelector(".atlas-search-wrap");
        const btn = document.createElement("button");
        btn.id = "atlas-search-clear";
        btn.className = "atlas-search-clear";
        btn.type = "button";
        btn.setAttribute("aria-label", "Clear search");
        btn.textContent = "×";
        btn.addEventListener("click", () => _onSearchClear(host, atlas, focus, tab));
        wrap?.appendChild(btn);
      } else if (!_searchQuery && clearBtn) {
        clearBtn.remove();
      }
    }, 120);
  });
  host.querySelector("#atlas-search-clear")?.addEventListener("click", () => _onSearchClear(host, atlas, focus, tab));

  // Filter chips
  host.querySelector("#atlas-chip-clear")?.addEventListener("click", () => _clearFocus());
  host.querySelector("#atlas-reset-btn")?.addEventListener("click", () => _resetAll());

  // Tabs
  host.querySelectorAll(".atlas-tab[data-tab]").forEach(btn => {
    btn.addEventListener("click", () => _setTab(btn.dataset.tab));
  });

  // Compare tray
  host.querySelector("#atlas-compare-open")?.addEventListener("click", () => {
    const ids = [..._compareSelection];
    if (ids.length < 2) return;
    _compareSelection.clear();
    navigate("compare", { entities: ids.join(",") });
  });
  host.querySelector("#atlas-compare-clear")?.addEventListener("click", () => {
    _compareSelection.clear();
    renderAtlasScreen({ atlas, store: null, focus, tab, hoverCallbacks: _hoverCallbacks });
  });
  host.querySelectorAll(".atlas-compare-chip-x[data-remove]").forEach(btn => {
    btn.addEventListener("click", e => {
      e.stopPropagation();
      _compareSelection.delete(btn.dataset.remove);
      renderAtlasScreen({ atlas, store: null, focus, tab, hoverCallbacks: _hoverCallbacks });
    });
  });

  // Top-only toggle
  host.querySelector("#atlas-show-top")?.addEventListener("change", e => {
    _showTopOnly = e.target.checked;
    _renderDrawerBody(host, atlas, null, focus, tab);
  });
}

function _onSearchClear(host, atlas, focus, tab) {
  _searchQuery = "";
  const input = host.querySelector("#atlas-search-input");
  if (input) input.value = "";
  host.querySelector("#atlas-search-clear")?.remove();
  _updateTabCounts(host, atlas, focus);
  _renderDrawerBody(host, atlas, null, focus, tab);
}

// ── Drawer body ─────────────────────────────────────────────────────────────

function _renderDrawerBody(host, atlas, _store, focus, tab) {
  const body = host.querySelector("#atlas-tab-body");
  if (!body) return;
  const t = TABS.includes(tab) ? tab : DEFAULT_TAB;
  let html;
  if (t === "entities") html = _renderEntityList(atlas, focus, _searchQuery);
  else if (t === "activities") html = _renderActivityList(atlas, focus, _searchQuery);
  else html = _renderSharedList(atlas, focus, _searchQuery);
  body.innerHTML = html;

  // Row wiring
  body.querySelectorAll("[data-entity-id]").forEach(row => {
    row.addEventListener("click", e => {
      const id = row.dataset.entityId;
      if (e.target.closest(".atlas-row-checkbox")) return;
      if (e.target.closest(".atlas-row-action")) return;
      navigate("identify", { entity: id });
    });
  });
  body.querySelectorAll(".atlas-row-checkbox input").forEach(cb => {
    cb.addEventListener("change", () => {
      const id = cb.dataset.entityId;
      if (cb.checked) _compareSelection.add(id);
      else _compareSelection.delete(id);
      renderAtlasScreen({ atlas, store: null, focus, tab, hoverCallbacks: _hoverCallbacks });
    });
  });
  body.querySelectorAll(".atlas-row-action[data-action]").forEach(btn => {
    btn.addEventListener("click", e => {
      e.stopPropagation();
      const action = btn.dataset.action;
      const id = btn.dataset.actionId;
      if (action === "identify") navigate("identify", { entity: id });
      else if (action === "explore") navigate("explore", { cluster: id });
      else if (action === "focus-type") _setFocus({ kind: "type", value: id });
      else if (action === "focus-activity") _setFocus({ kind: "activity", value: id });
    });
  });
  // Sort selector
  body.querySelector(".atlas-sort-select")?.addEventListener("change", e => {
    _sortKeyByTab[t] = e.target.value;
    _renderDrawerBody(host, atlas, _store, focus, tab);
  });
}

// ── Entity tab ──────────────────────────────────────────────────────────────

function _renderEntityList(atlas, focus, query) {
  const entities = _collectEntitiesForDrawer(atlas, focus);
  const filtered = _searchEntities(entities, query);
  const sortKey = _sortKeyByTab.entities;
  const sorted = _sortEntities(filtered, sortKey);
  const limit = _showTopOnly ? Math.min(60, sorted.length) : sorted.length;
  const rows = sorted.slice(0, limit);

  if (!rows.length) return _emptyHtml("No entities match the current filter.");

  const focusHint = focus?.kind === "type"
    ? `Browsing <b>${_esc(focus.value)}</b> entities. Click any row to open its lifecycle (Identify). Tick checkboxes to build a compare set.`
    : focus
      ? `Entities related to current focus. Click any row to open Identify.`
      : `Top entities across the whole EKG. Click a row to open Identify, or use search to jump to one by id.`;

  const header = `
    <div class="atlas-drawer-meta">
      <span class="atlas-drawer-hint">${focusHint}</span>
      <span class="atlas-drawer-sort">
        Sort:
        <select class="atlas-sort-select" aria-label="Sort entities">
          <option value="events"${sortKey === "events" ? " selected" : ""}>Most active</option>
          <option value="label"${sortKey === "label" ? " selected" : ""}>Label (A→Z)</option>
          <option value="type"${sortKey === "type" ? " selected" : ""}>Type</option>
          <option value="recent"${sortKey === "recent" ? " selected" : ""}>Most recent</option>
        </select>
      </span>
    </div>
  `;

  const body = rows.map(entity => {
    const checked = _compareSelection.has(entity.id);
    const lastDate = entity.lastDate ? new Date(entity.lastDate).toLocaleDateString("en-GB", { month: "short", year: "numeric" }) : "";
    return `
      <div class="atlas-row atlas-row-entity${checked ? " atlas-row-selected" : ""}" data-entity-id="${_esc(entity.id)}">
        <label class="atlas-row-checkbox" title="Add to compare">
          <input type="checkbox" data-entity-id="${_esc(entity.id)}" ${checked ? "checked" : ""}/>
          <span class="atlas-row-checkbox-mark"></span>
        </label>
        <div class="atlas-row-main">
          <div class="atlas-row-title">
            <span class="atlas-row-label">${_esc(entity.label)}</span>
            <span class="atlas-row-id">${_esc(entity.id !== entity.label ? entity.id : "")}</span>
          </div>
          <div class="atlas-row-meta">
            <span class="atlas-row-type" data-action-id="${_esc(entity.type)}" data-action="focus-type" style="color:${_esc(entity.typeColor)}">●</span>
            <span class="atlas-row-type-name">${_esc(entity.type)}</span>
            <span class="atlas-row-divider">·</span>
            <span><b>${entity.eventCount.toLocaleString()}</b> events</span>
            ${lastDate ? `<span class="atlas-row-divider">·</span><span>last: ${_esc(lastDate)}</span>` : ""}
          </div>
        </div>
        <div class="atlas-row-actions">
          <button type="button" class="atlas-row-action atlas-row-action-primary"
            data-action="identify" data-action-id="${_esc(entity.id)}">Open →</button>
        </div>
      </div>
    `;
  }).join("");

  const footer = _showTopOnly && filtered.length > limit
    ? `<div class="atlas-drawer-footer">Showing top ${limit} of ${filtered.length}. Untick “Show top results only” to see all.</div>`
    : "";

  return header + body + footer;
}

// ── Activity tab ────────────────────────────────────────────────────────────

function _renderActivityList(atlas, focus, query) {
  const activities = _collectActivitiesForDrawer(atlas, focus);
  const filtered = activities.filter(a => !query || a.activity.toLowerCase().includes(query.toLowerCase()));
  const sortKey = _sortKeyByTab.activities;
  const sorted = [...filtered].sort((a, b) => {
    if (sortKey === "label") return a.activity.localeCompare(b.activity);
    if (sortKey === "types") return b.entityTypes.length - a.entityTypes.length || b.count - a.count;
    return b.count - a.count;
  });
  const limit = _showTopOnly ? Math.min(40, sorted.length) : sorted.length;
  const rows = sorted.slice(0, limit);

  if (!rows.length) return _emptyHtml("No activities match the current filter.");

  const focusHint = focus?.kind === "activity"
    ? `Focused on activity <b>${_esc(focus.value)}</b>.`
    : focus?.kind === "type"
      ? `Activities recorded on <b>${_esc(focus.value)}</b> entities.`
      : "All activities sorted by frequency. Click a row to focus the atlas on that activity, or “Explore →” to drill into shared-event hotspots.";

  const header = `
    <div class="atlas-drawer-meta">
      <span class="atlas-drawer-hint">${focusHint}</span>
      <span class="atlas-drawer-sort">
        Sort:
        <select class="atlas-sort-select" aria-label="Sort activities">
          <option value="frequency"${sortKey === "frequency" ? " selected" : ""}>Frequency</option>
          <option value="types"${sortKey === "types" ? " selected" : ""}>Entity-type breadth</option>
          <option value="label"${sortKey === "label" ? " selected" : ""}>Label (A→Z)</option>
        </select>
      </span>
    </div>
  `;

  const body = rows.map(a => `
    <div class="atlas-row atlas-row-activity">
      <div class="atlas-row-swatch" style="background:${_esc(a.color)}"></div>
      <div class="atlas-row-main">
        <div class="atlas-row-title">
          <span class="atlas-row-label">${_esc(a.activity)}</span>
        </div>
        <div class="atlas-row-meta">
          <span><b>${a.count.toLocaleString()}</b> events</span>
          <span class="atlas-row-divider">·</span>
          <span>${a.entityTypes.length} type${a.entityTypes.length === 1 ? "" : "s"}: ${_esc(a.entityTypes.slice(0, 3).join(", "))}${a.entityTypes.length > 3 ? `, +${a.entityTypes.length - 3}` : ""}</span>
        </div>
      </div>
      <div class="atlas-row-actions">
        <button type="button" class="atlas-row-action" data-action="focus-activity" data-action-id="${_esc(a.activity)}">Focus</button>
        <button type="button" class="atlas-row-action atlas-row-action-primary" data-action="explore" data-action-id="act:${_esc(a.activity)}">Explore →</button>
      </div>
    </div>
  `).join("");

  const footer = _showTopOnly && filtered.length > limit
    ? `<div class="atlas-drawer-footer">Showing top ${limit} of ${filtered.length}.</div>`
    : "";

  return header + body + footer;
}

// ── Shared events tab ───────────────────────────────────────────────────────

function _renderSharedList(atlas, focus, query) {
  const hotspots = _collectHotspotsForDrawer(atlas, focus);
  const filtered = hotspots.filter(h =>
    !query || h.activity.toLowerCase().includes(query.toLowerCase()) || h.entityTypes.some(t => t.toLowerCase().includes(query.toLowerCase()))
  );
  const sortKey = _sortKeyByTab.shared;
  const sorted = [...filtered].sort((a, b) => {
    if (sortKey === "syncStrength") return b.avgSyncDegree - a.avgSyncDegree || b.eventCount - a.eventCount;
    if (sortKey === "recency") return (b.lastDate?.getTime?.() ?? 0) - (a.lastDate?.getTime?.() ?? 0);
    return b.eventCount - a.eventCount;
  });
  const limit = _showTopOnly ? Math.min(30, sorted.length) : sorted.length;
  const rows = sorted.slice(0, limit);

  if (!rows.length) return _emptyHtml("No shared events match the current filter.");

  const focusHint = focus?.kind === "edge"
    ? `Hotspots on the <b>${_esc(focus.value.replaceAll("__", " ↔ "))}</b> bridge.`
    : focus?.kind === "type"
      ? `Hotspots involving <b>${_esc(focus.value)}</b>.`
      : "Hotspots where ≥2 entity types intersect on the same event. Click a row to open Explore (T4).";

  const header = `
    <div class="atlas-drawer-meta">
      <span class="atlas-drawer-hint">${focusHint}</span>
      <span class="atlas-drawer-sort">
        Sort:
        <select class="atlas-sort-select" aria-label="Sort hotspots">
          <option value="frequency"${sortKey === "frequency" ? " selected" : ""}>Event count</option>
          <option value="syncStrength"${sortKey === "syncStrength" ? " selected" : ""}>Sync degree</option>
          <option value="recency"${sortKey === "recency" ? " selected" : ""}>Most recent</option>
        </select>
      </span>
    </div>
  `;

  const body = rows.map(h => `
    <div class="atlas-row atlas-row-shared">
      <div class="atlas-row-swatch" style="background:${_esc(h.color)}"></div>
      <div class="atlas-row-main">
        <div class="atlas-row-title">
          <span class="atlas-row-label">${_esc(h.activity)}</span>
        </div>
        <div class="atlas-row-meta">
          <span><b>${h.eventCount.toLocaleString()}</b> events</span>
          <span class="atlas-row-divider">·</span>
          <span><b>${h.entityCount.toLocaleString()}</b> entities</span>
          <span class="atlas-row-divider">·</span>
          <span>~${h.avgSyncDegree.toFixed(1)} sync</span>
          <span class="atlas-row-divider">·</span>
          <span>${_esc(h.entityTypes.slice(0, 3).join(", "))}${h.entityTypes.length > 3 ? `, +${h.entityTypes.length - 3}` : ""}</span>
        </div>
      </div>
      <div class="atlas-row-actions">
        <button type="button" class="atlas-row-action atlas-row-action-primary"
          data-action="explore" data-action-id="${_esc(h.id)}">Explore →</button>
      </div>
    </div>
  `).join("");

  const footer = _showTopOnly && filtered.length > limit
    ? `<div class="atlas-drawer-footer">Showing top ${limit} of ${filtered.length}.</div>`
    : "";

  return header + body + footer;
}

// ── Data collection (focus-aware) ───────────────────────────────────────────

function _collectEntitiesForDrawer(atlas, focus) {
  // Need the live store for entity event counts and labels. Pull from main
  // store via the existing `getStore()` indirection — but to keep this module
  // decoupled from main.js we import lazily.
  const store = _getStore();
  if (!store) return [];
  const registry = store.typeRegistry;

  const filterType = focus?.kind === "type" ? focus.value
    : focus?.kind === "edge" ? null
    : null;

  let candidates;
  if (focus?.kind === "edge") {
    const [a, b] = focus.value.split("__");
    const setA = new Set(store.entityIdsByType[a] ?? []);
    const setB = new Set(store.entityIdsByType[b] ?? []);
    candidates = [...setA, ...setB];
  } else if (focus?.kind === "activity") {
    const activity = focus.value;
    candidates = store.events
      .filter(event => event.activity === activity)
      .flatMap(event => event.entity_ids);
    candidates = [...new Set(candidates)];
  } else if (focus?.kind === "hotspot") {
    candidates = getEntitiesForHotspot(focus.value, { maxEntities: 200 });
  } else if (filterType) {
    candidates = store.entityIdsByType[filterType] ?? [];
  } else {
    candidates = (store.entityList ?? []).map(e => e.id);
  }

  return candidates
    .map(id => {
      const ent = store.entityById[id];
      if (!ent) return null;
      const events = store.eventsByEntityId?.[id] ?? [];
      const lastDate = events.length ? events[events.length - 1].date : null;
      return {
        id,
        label: _entityLabel(ent),
        type: ent.primary_type,
        typeColor: registry?.colorOf?.(ent.primary_type) ?? "#64748b",
        eventCount: events.length,
        lastDate: lastDate instanceof Date ? lastDate.getTime() : null,
      };
    })
    .filter(Boolean);
}

function _collectActivitiesForDrawer(atlas, focus) {
  const store = _getStore();
  if (!store) return [];

  let relevantEvents = store.events;
  if (focus?.kind === "type") {
    relevantEvents = store.events.filter(e => e.memberships.some(m => m.entity_type === focus.value));
  } else if (focus?.kind === "edge") {
    const [a, b] = focus.value.split("__");
    relevantEvents = store.events.filter(e => {
      const types = new Set(e.memberships.map(m => m.entity_type));
      return types.has(a) && types.has(b);
    });
  } else if (focus?.kind === "activity") {
    relevantEvents = store.events.filter(e => e.activity === focus.value);
  } else if (focus?.kind === "hotspot") {
    const activity = focus.value.replace(/^act:/, "");
    relevantEvents = store.events.filter(e => e.activity === activity);
  }

  const map = new Map();
  relevantEvents.forEach(event => {
    if (!event.activity) return;
    if (!map.has(event.activity)) {
      map.set(event.activity, {
        activity: event.activity,
        color: store.activityColorByName[event.activity] ?? "#64748b",
        count: 0,
        entityTypes: new Set(),
      });
    }
    const entry = map.get(event.activity);
    entry.count += 1;
    event.memberships.forEach(m => entry.entityTypes.add(m.entity_type));
  });

  return [...map.values()].map(entry => ({
    ...entry,
    entityTypes: [...entry.entityTypes].sort(),
  }));
}

function _collectHotspotsForDrawer(atlas, focus) {
  const all = getGlobalSharedEventHotspots({ minSharedEntities: 2 });
  if (!focus) return all;
  if (focus.kind === "activity") {
    return all.filter(h => h.activity === focus.value);
  }
  if (focus.kind === "type") {
    return all.filter(h => h.entityTypes.includes(focus.value));
  }
  if (focus.kind === "edge") {
    const [a, b] = focus.value.split("__");
    return all.filter(h => h.entityTypes.includes(a) && h.entityTypes.includes(b));
  }
  if (focus.kind === "hotspot") {
    return all.filter(h => h.id === focus.value);
  }
  return all;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function _searchEntities(entities, query) {
  if (!query) return entities;
  const q = query.toLowerCase().trim();
  if (!q) return entities;
  return entities.filter(e =>
    e.id.toLowerCase().includes(q) ||
    e.label.toLowerCase().includes(q) ||
    e.type.toLowerCase().includes(q)
  );
}

function _sortEntities(entities, key) {
  return [...entities].sort((a, b) => {
    if (key === "label") return a.label.localeCompare(b.label);
    if (key === "type") return a.type.localeCompare(b.type) || b.eventCount - a.eventCount;
    if (key === "recent") return (b.lastDate ?? 0) - (a.lastDate ?? 0);
    return b.eventCount - a.eventCount;
  });
}

function _counts(atlas, focus, query) {
  // Cheap-ish counts for tab badges. We always compute these against the
  // current focus so users see how big each tab is from a glance.
  const entities = _collectEntitiesForDrawer(atlas, focus);
  const activities = _collectActivitiesForDrawer(atlas, focus);
  const shared = _collectHotspotsForDrawer(atlas, focus);

  const matchE = _searchEntities(entities, query);
  const q = (query || "").toLowerCase();
  const matchA = activities.filter(a => !q || a.activity.toLowerCase().includes(q));
  const matchS = shared.filter(h => !q || h.activity.toLowerCase().includes(q));

  return { entities: matchE.length, activities: matchA.length, shared: matchS.length };
}

function _updateTabCounts(host, atlas, focus) {
  const counts = _counts(atlas, focus, _searchQuery);
  TABS.forEach(t => {
    const el = host.querySelector(`.atlas-tab[data-tab="${t}"] .atlas-tab-count`);
    if (el) el.textContent = counts[t].toLocaleString();
  });
}

function _entityLabel(entity) {
  if (!entity) return "";
  return entity.properties?.title
    || entity.properties?.vendorName
    || entity.properties?.name
    || entity.properties?.sysId
    || entity.entity_id;
}

// ── URL focus mutations ─────────────────────────────────────────────────────

function _currentParams() {
  const route = getRoute();
  return route.name === "atlas" ? { ...route.params } : {};
}

function _setFocus(focus, extra = {}) {
  const params = _currentParams();
  params.focus = serializeAtlasFocus(focus);
  if (extra.tab) params.tab = extra.tab;
  navigate("atlas", params);
}

function _clearFocus() {
  const params = _currentParams();
  delete params.focus;
  navigate("atlas", params);
}

function _setTab(tab) {
  const params = _currentParams();
  if (tab === DEFAULT_TAB) delete params.tab;
  else params.tab = tab;
  navigate("atlas", params, { replace: true });
}

function _resetAll() {
  _searchQuery = "";
  _compareSelection.clear();
  navigate("atlas", {});
}

// ── Store accessor (lazy import to avoid circular deps) ─────────────────────

let _storeRef = null;
function _setStoreRef(store) { _storeRef = store; }
function _getStore() { return _storeRef; }
export function _registerAtlasStore(store) { _setStoreRef(store); }

// ── Sidebar helpers ─────────────────────────────────────────────────────────

function _row(label, value) { return { label, value }; }

function _renderSidebarRow(row) {
  if (row.divider) return `<div class="stat-divider"></div>`;
  if (row.subtitle) return `<div class="stat-subtitle">${_esc(row.subtitle)}</div>`;
  if (row.hint) return `<div class="stat-hint">${_esc(row.hint)}</div>`;
  return `<div class="stat-row"><span class="stat-label">${_esc(row.label)}</span><span class="stat-val">${_esc(row.value)}</span></div>`;
}

function _describeFocus(focus) {
  if (!focus) return "";
  if (focus.kind === "type") return focus.value;
  if (focus.kind === "activity") return `act: ${focus.value}`;
  if (focus.kind === "edge") return focus.value.replaceAll("__", " ↔ ");
  if (focus.kind === "hotspot") return focus.value.replace(/^act:/, "");
  return "";
}

function _formatDateRange(first, last) {
  if (!(first instanceof Date) || !(last instanceof Date)) return "—";
  const fmt = d => d.toLocaleDateString("en-GB", { month: "short", year: "numeric" });
  const a = fmt(first), b = fmt(last);
  return a === b ? a : `${a} → ${b}`;
}

// ── Misc ────────────────────────────────────────────────────────────────────

function _shortId(id) {
  const s = String(id ?? "");
  return s.length > 16 ? s.slice(0, 4) + "…" + s.slice(-7) : s;
}

function _emptyHtml(text) {
  return `<div class="atlas-drawer-empty">${_esc(text)}</div>`;
}

function _esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
