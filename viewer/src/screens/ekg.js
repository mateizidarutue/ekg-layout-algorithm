"use strict";

// EKG view screen — the user-facing surface for the multi-scale T1 view.
//
// Owns:
//   • Toolbar: level segmented control (L0–L3), search input, focus chips
//   • Main SVG canvas (drawn via ekgViewRender.drawEkgView)
//   • Minimap SVG (drawn via ekgViewRender.drawMinimap)
//   • Right-side Inspector panel (DOM, slide-in from right edge)
//   • Keyboard shortcuts 1/2/3/4
//   • Ctrl/Cmd+wheel time-window zoom (with cursor as anchor)
//   • URL state for level / t0 / t1 / focus / maxEntities
//
// URL state is the single source of truth for "where am I". Search is NOT in
// the URL (live-typed, would pollute history). Inspector payload is derived
// from the focus + click history; not persisted.
//
// Cross-cutting design notes:
//   – Wheel events are throttled to URL writes via requestAnimationFrame so
//     dragging the minimap or scrolling the wheel doesn't flood history.
//   – Level changes push history (real navigation step); window/focus
//     changes use `replace` so back/forward feels like a clean undo of
//     "I switched levels" rather than "I twitched my scroll wheel".
//   – Inspector is an absolutely-positioned overlay anchored to the right
//     edge of #canvas-wrap, sliding in when content exists. It does not
//     restructure the global shell.

import { navigate, getRoute } from "../router.js";
import { computeEkgViewLayout, EKG_LEVELS, EKG_GEOM } from "../layout/ekgViewLayout.js";
import { drawEkgView, applyEkgSearch } from "../render/ekgViewRender.js";
import { listInvalidDateEvents } from "../data/store.js";

// ── Public API ─────────────────────────────────────────────────────────────

let _searchQuery = "";
let _inspectorPayload = null;
let _inspectorOpen = false;
let _hoverCallbacks = { show: null, hide: null };
let _storeRef = null;
let _dataRef = null;
let _layoutRef = null;
let _pendingUrlWrite = null;  // rAF handle for throttled URL writes

export function renderEkgScreen(opts) {
  const { data, store, urlState, hoverCallbacks } = opts;
  _hoverCallbacks = hoverCallbacks ?? {};
  _storeRef = store;
  _dataRef = data;

  const host = document.getElementById("screen-host");
  if (!host) return;

  if (!data || !data.typeNodes?.length) {
    host.innerHTML = `<div class="ekg-screen"><div class="ekg-empty">No EKG data — clear the activity filter or load a dataset.</div></div>`;
    return;
  }

  host.innerHTML = _buildHtml(data, urlState);

  // Render the main SVG canvas. The time scrubber is part of it now (drawn
  // at the top); we keep the resolved `_layoutRef` so wheel/drag handlers can
  // reproject coordinates without recomputing layout.
  _renderCanvas(host, data, urlState);
  _renderInspector(host);

  _wireToolbar(host, urlState);
  _wireSearch(host);
  _wireKeyboard(host, urlState);
  _wireWheelZoom(host, urlState);
  _wireBandClicks(host);

  // Re-apply search highlight after fresh render
  if (_searchQuery) {
    const svgEl = host.querySelector(".ekg-svg");
    if (svgEl) applyEkgSearch(d3.select(svgEl), _searchQuery);
  }
}

// ── URL state ──────────────────────────────────────────────────────────────
//
// Param names (compact but readable):
//   level   0|1|2|3            → l
//   t0,t1   epoch ms           → t0, t1
//   focus   kind:value[:extra] → f
//   max     L2 entity cap      → m
//
// We keep the names spelled out in the URL for readability when users share
// links. Compactness matters less than understandability for a thesis
// prototype.

export function parseEkgUrlState(routeParams = {}) {
  const level = _clampLevel(parseInt(routeParams.level, 10));
  const t0 = _parseMaybeNumber(routeParams.t0);
  const t1 = _parseMaybeNumber(routeParams.t1);
  const focus = _parseFocus(routeParams.focus);
  const maxEntities = _parseMaybeNumber(routeParams.max);
  // types: comma-separated list. Empty/missing means "use the layout's default
  // (case + item + other; resources/attributes hidden)."
  const visibleTypes = routeParams.types
    ? decodeURIComponent(routeParams.types).split(",").filter(Boolean)
    : null;
  return {
    level,
    timeWindow: Number.isFinite(t0) && Number.isFinite(t1) ? { t0, t1 } : null,
    focus,
    visibleTypes,
    maxEntities: Number.isFinite(maxEntities) ? maxEntities : 24,
  };
}

export function buildEkgRouteParams(state) {
  const p = {};
  if (Number.isInteger(state.level) && state.level !== 1) p.level = String(state.level);
  if (state.timeWindow && Number.isFinite(state.timeWindow.t0) && Number.isFinite(state.timeWindow.t1)) {
    p.t0 = String(Math.round(state.timeWindow.t0));
    p.t1 = String(Math.round(state.timeWindow.t1));
  }
  if (state.focus) p.focus = _serializeFocus(state.focus);
  if (state.visibleTypes?.length) p.types = state.visibleTypes.join(",");
  if (Number.isFinite(state.maxEntities) && state.maxEntities !== 24) p.max = String(state.maxEntities);
  return p;
}

function _parseFocus(raw) {
  if (!raw) return null;
  const decoded = decodeURIComponent(String(raw));
  const colon = decoded.indexOf(":");
  if (colon < 0) return null;
  const kind = decoded.slice(0, colon);
  const value = decoded.slice(colon + 1);
  if (!["type", "activity", "entity", "edge", "spine"].includes(kind)) return null;
  if (kind === "entity") {
    // entity:<id>:<type>
    const lastColon = value.lastIndexOf(":");
    if (lastColon < 0) return { kind, value };
    return { kind, value: value.slice(0, lastColon), entityType: value.slice(lastColon + 1) };
  }
  return { kind, value };
}

function _serializeFocus(focus) {
  if (!focus?.kind) return "";
  if (focus.kind === "entity" && focus.entityType) {
    return `${focus.kind}:${focus.value}:${focus.entityType}`;
  }
  return `${focus.kind}:${focus.value}`;
}

function _clampLevel(n) {
  if (!Number.isInteger(n)) return 1;
  return Math.max(0, Math.min(3, n));
}

function _parseMaybeNumber(raw) {
  if (raw == null || raw === "") return NaN;
  const n = Number(raw);
  return Number.isFinite(n) ? n : NaN;
}

// ── DOM scaffolding ────────────────────────────────────────────────────────

function _buildHtml(data, urlState) {
  const levels = [
    { id: 0, label: "L0", name: "Galaxy",        hint: "Density heat-strip per type" },
    { id: 1, label: "L1", name: "District",      hint: "Activity nodes & DF arcs" },
    { id: 2, label: "L2", name: "Neighbourhood", hint: "Per-entity sparklines" },
    { id: 3, label: "L3", name: "Street",        hint: "Single-entity event detail" },
  ];

  const focusChip = urlState.focus ? _focusChipHtml(urlState.focus) : "";
  const windowChip = urlState.timeWindow ? _windowChipHtml(urlState.timeWindow, data) : "";
  const typeFilterHtml = _typeFilterChipsHtml(data, urlState);

  return `
    <div class="ekg-screen">
      <header class="ekg-toolbar">
        <div class="ekg-toolbar-row">
          <div class="ekg-segmented" role="tablist" aria-label="Zoom level">
            ${levels.map(L => `
              <button type="button"
                class="ekg-level-btn${urlState.level === L.id ? " active" : ""}"
                data-level="${L.id}"
                aria-pressed="${urlState.level === L.id}"
                title="${L.hint} · press ${L.id + 1}">
                <span class="ekg-level-tag">${L.label}</span>
                <span class="ekg-level-name">${L.name}</span>
              </button>
            `).join("")}
          </div>
          <div class="ekg-search-wrap">
            <svg viewBox="0 0 16 16" class="ekg-search-icon" aria-hidden="true">
              <circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" stroke-width="1.5"/>
              <path d="M11 11l3.5 3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            </svg>
            <input id="ekg-search" type="search"
              class="ekg-search-input"
              placeholder="Search entities, activities, events…"
              value="${_esc(_searchQuery)}"
              autocomplete="off" />
            <span id="ekg-search-count" class="ekg-search-count"></span>
            ${_searchQuery ? `<button type="button" class="ekg-search-clear" id="ekg-search-clear" aria-label="Clear">×</button>` : ""}
          </div>
          ${_timePresetsHtml()}
          <button type="button" class="ekg-help-btn" id="ekg-help-btn" aria-label="Help">?</button>
        </div>
        ${typeFilterHtml}
        ${_invalidChipHtml(data)}
        ${(focusChip || windowChip) ? `<div class="ekg-toolbar-chips">${focusChip}${windowChip}<button type="button" class="ekg-reset" id="ekg-reset">Reset view</button></div>` : ""}
      </header>

      <section class="ekg-canvas-section">
        <div class="ekg-canvas-wrap" id="ekg-canvas-wrap">
          <svg class="ekg-svg" id="ekg-svg"></svg>
        </div>
        <aside class="ekg-inspector ${_inspectorOpen ? "open" : ""}" id="ekg-inspector">
          <header class="ekg-inspector-head">
            <span class="ekg-inspector-title" id="ekg-inspector-title">Inspector</span>
            <button type="button" class="ekg-inspector-close" id="ekg-inspector-close" aria-label="Close inspector">×</button>
          </header>
          <div class="ekg-inspector-body" id="ekg-inspector-body"></div>
        </aside>
      </section>

    </div>
  `;
}

// Time-window preset chips that sit next to the level segmented control.
// Each preset computes a `{t0, t1}` from the dataset and pushes it to the URL.
const TIME_PRESETS = [
  { id: "all",      label: "Full",         hint: "Show the entire timeline" },
  { id: "first25",  label: "First 25%",    hint: "First quarter of the timeline" },
  { id: "last25",   label: "Last 25%",     hint: "Last quarter of the timeline" },
  { id: "busy20",   label: "Busiest 20%",  hint: "Densest sliding window by event count" },
];

function _timePresetsHtml() {
  return `
    <div class="ekg-time-presets" role="group" aria-label="Time window">
      ${TIME_PRESETS.map(p => `
        <button type="button" class="ekg-time-preset" data-preset="${p.id}" title="${_esc(p.hint)}">${_esc(p.label)}</button>
      `).join("")}
    </div>
  `;
}

// Build the type-filter chip row. Each entity type is a togglable pill.
// Roles `case`/`item`/`other` are on by default; resources & attributes are
// off. The chip row only renders if there's more than one type total.
function _typeFilterChipsHtml(data, urlState) {
  const all = data.typeNodes ?? [];
  if (all.length < 2) return "";
  const currentSet = urlState.visibleTypes
    ? new Set(urlState.visibleTypes)
    : _defaultVisibleSet(all);
  return `
    <div class="ekg-type-filter">
      <span class="ekg-type-filter-label">Show:</span>
      ${all.map(t => {
        const on = currentSet.has(t.id);
        return `
          <button type="button"
            class="ekg-type-pill${on ? " on" : ""}"
            data-type="${_esc(t.id)}"
            aria-pressed="${on}"
            title="${_esc(t.id)} · ${t.entityCount.toLocaleString()} entities">
            <span class="ekg-type-pill-swatch" style="background:${_esc(t.color)}"></span>
            <span class="ekg-type-pill-label">${_esc(t.label)}</span>
            <span class="ekg-type-pill-count">${t.entityCount.toLocaleString()}</span>
          </button>
        `;
      }).join("")}
    </div>
  `;
}

function _defaultVisibleSet(typeNodes) {
  const set = new Set();
  typeNodes.forEach(t => {
    if (t.role === "resource" || t.role === "attribute") return;
    set.add(t.id);
  });
  if (!set.size) typeNodes.forEach(t => set.add(t.id));
  return set;
}

// Tiny notice that surfaces when the data layer filtered out events whose
// timestamps couldn't be parsed. Clicking opens the inspector with a list,
// so users can audit the bundle without leaving the view.
function _invalidChipHtml(data) {
  const n = data?.invalidEventCount ?? 0;
  if (n <= 0) return "";
  return `
    <div class="ekg-invalid-chip" id="ekg-invalid-chip" title="Click for details">
      <span class="ekg-invalid-icon">⚠</span>
      <span><b>${n.toLocaleString()}</b> ${n === 1 ? "event" : "events"} skipped · invalid timestamps</span>
    </div>
  `;
}

function _focusChipHtml(focus) {
  const kindLabel = {
    type: "Type", activity: "Activity", entity: "Entity", edge: "Edge", spine: "Shared event",
  }[focus.kind] ?? focus.kind;
  return `
    <span class="ekg-chip">
      <span class="ekg-chip-kind">${kindLabel}:</span>
      <span class="ekg-chip-val">${_esc(focus.value)}</span>
      <button type="button" class="ekg-chip-x" data-chip="focus" aria-label="Clear focus">×</button>
    </span>
  `;
}

function _windowChipHtml(window, data) {
  const t0 = new Date(window.t0).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "2-digit" });
  const t1 = new Date(window.t1).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "2-digit" });
  const fullSpan = Math.max(data.timeRange.max - data.timeRange.min, 1);
  const pct = Math.max(1, Math.round(((window.t1 - window.t0) / fullSpan) * 100));
  return `
    <span class="ekg-chip">
      <span class="ekg-chip-kind">Window:</span>
      <span class="ekg-chip-val">${_esc(t0)} → ${_esc(t1)} (${pct}%)</span>
      <button type="button" class="ekg-chip-x" data-chip="window" aria-label="Reset window">×</button>
    </span>
  `;
}

// ── Rendering ──────────────────────────────────────────────────────────────

function _renderCanvas(host, data, urlState) {
  const wrap = host.querySelector("#ekg-canvas-wrap");
  const svgEl = host.querySelector("#ekg-svg");
  if (!wrap || !svgEl) return;
  const width = Math.max(wrap.clientWidth, 720);

  const layout = computeEkgViewLayout(data, { width, heightAvailable: 800 }, {
    level: urlState.level,
    timeWindow: urlState.timeWindow,
    focus: urlState.focus,
    maxEntitiesPerBand: urlState.maxEntities,
    bandOrder: data.bandOrder,
    visibleTypes: urlState.visibleTypes,
  });
  _layoutRef = layout;

  svgEl.setAttribute("width", "100%");
  svgEl.setAttribute("height", String(layout.totalHeight));
  svgEl.setAttribute("viewBox", `0 0 ${width} ${layout.totalHeight}`);
  svgEl.setAttribute("preserveAspectRatio", "xMidYMin meet");

  const svg = d3.select(svgEl);
  drawEkgView(svg, layout, {
    onBandHeaderClick: band => _setFocus({ kind: "type", value: band.type }),
    onBinClick: (bin, band) => _openInspector({ kind: "bin", bin, band }),
    onActivityNodeClick: (node, band) => _setFocus({ kind: "activity", value: node.activity }),
    onSparklineRowClick: (row, band) => _setFocus({ kind: "entity", value: row.entity_id, entityType: band.type }),
    onEventClick: (event, row, band) => _openInspector({ kind: "event", event, row, band }),
    onSpineClick: spine => _openInspector({ kind: "spine", spine }),
    onSpineClusterClick: cluster => _openInspector({ kind: "spine-cluster", cluster }),
    // Scrubber callbacks — same drag-then-commit contract the bottom minimap
    // used to have, so the existing _liveUpdateCanvas path is reused.
    onScrubberRecentre: (px, scr) => _scrubberRecentre(px, scr),
    onScrubberDrag: (mode, dx, startRect, scr) => _scrubberDrag(mode, dx, startRect, scr),
    onScrubberDragEnd: () => _scrubberDragCommit(),
    onTooltipShow: (html, ev) => _hoverCallbacks.show?.(html, ev),
    onTooltipHide: () => _hoverCallbacks.hide?.(),
  });
}

function _renderInspector(host) {
  const panel = host.querySelector("#ekg-inspector");
  const title = host.querySelector("#ekg-inspector-title");
  const body = host.querySelector("#ekg-inspector-body");
  if (!panel || !title || !body) return;
  panel.classList.toggle("open", _inspectorOpen);
  if (!_inspectorPayload) {
    title.textContent = "Inspector";
    body.innerHTML = `<div class="ekg-inspector-empty">
      <p>Click any element on the canvas to see details here.</p>
      <ul class="ekg-inspector-hint-list">
        <li><b>Band header</b> → focus a type, browse its entities</li>
        <li><b>L0 cell</b> → events in that time bin</li>
        <li><b>L1 node</b> → activity stats + drill</li>
        <li><b>L2 sparkline</b> → entity summary + Identify</li>
        <li><b>L3 event</b> → full event details</li>
        <li><b>Shared spine</b> → entities synchronised at that point</li>
      </ul>
    </div>`;
    return;
  }
  const { html, titleText } = _inspectorContent(_inspectorPayload);
  title.textContent = titleText;
  body.innerHTML = html;

  // Wire any action buttons inside the inspector body.
  body.querySelectorAll("[data-nav]").forEach(btn => {
    btn.addEventListener("click", () => {
      const route = btn.dataset.nav;
      const params = btn.dataset.params ? JSON.parse(btn.dataset.params) : {};
      navigate(route, params);
    });
  });
  body.querySelectorAll("[data-focus]").forEach(btn => {
    btn.addEventListener("click", () => {
      const focus = JSON.parse(btn.dataset.focus);
      _setFocus(focus);
    });
  });
}

// ── Inspector content builders ─────────────────────────────────────────────

function _inspectorContent(payload) {
  if (payload.kind === "type") return _typeInspectorContent(payload);
  if (payload.kind === "bin") return _binInspectorContent(payload);
  if (payload.kind === "activity") return _activityInspectorContent(payload);
  if (payload.kind === "entity") return _entityInspectorContent(payload);
  if (payload.kind === "event") return _eventInspectorContent(payload);
  if (payload.kind === "spine") return _spineInspectorContent(payload);
  if (payload.kind === "spine-cluster") return _spineClusterInspectorContent(payload);
  if (payload.kind === "help") return _helpInspectorContent();
  if (payload.kind === "invalid-dates") return _invalidDatesInspectorContent();
  return { titleText: "Inspector", html: "" };
}

function _invalidDatesInspectorContent() {
  const sample = listInvalidDateEvents({ limit: 25 });
  const total = sample.length === 25 ? "25+" : String(sample.length);
  return {
    titleText: `Invalid timestamps · ${total}`,
    html: `
      <div class="ekg-inspector-block">
        <p class="ekg-help-text">
          These events were excluded because their <code>timestamp</code> couldn't be
          parsed into a finite millisecond value. They still exist in the underlying
          bundle and are accessible from the other screens (Identify, Compare); they
          just can't be placed on a time axis.
        </p>
        <div class="ekg-inspector-subtitle">Sample (up to 25)</div>
        <div class="ekg-inspector-list">
          ${sample.map(e => `
            <div class="ekg-inspector-row" data-nav="identify" data-params='${_esc(JSON.stringify({ entity: e.entity_ids?.[0] ?? "" }))}'>
              <span class="ekg-inspector-row-label">${_esc(e.activity || "(no activity)")}</span>
              <span class="ekg-inspector-row-meta"><code>${_esc(e.event_id)}</code> · ${_esc(e.timestamp || "—")}</span>
            </div>
          `).join("") || `<div class="ekg-inspector-note">No invalid timestamps in this dataset.</div>`}
        </div>
      </div>
    `,
  };
}

// A cluster represents many shared events at nearly the same instant. We show
// the underlying events; clicking one focuses it (drawing the full vertical).
function _spineClusterInspectorContent({ cluster }) {
  const dates = cluster.members.map(m => new Date(m.t));
  const dateMin = dates[0].toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
  const dateMax = dates[dates.length - 1].toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
  // Group by activity for compactness
  const byActivity = {};
  cluster.members.forEach(m => {
    if (!byActivity[m.activity]) byActivity[m.activity] = [];
    byActivity[m.activity].push(m);
  });
  const grouped = Object.entries(byActivity).sort((a, b) => b[1].length - a[1].length);

  return {
    titleText: `${cluster.count} shared events`,
    html: `
      <div class="ekg-inspector-block">
        <div class="ekg-inspector-meta">
          <span>Spanning ${_esc(dateMin)} → ${_esc(dateMax)}</span>
        </div>
        <div class="ekg-inspector-row-meta">Bridges types: ${cluster.types.map(_esc).join(", ")}</div>
        <div class="ekg-inspector-subtitle">Events in this cluster (by activity)</div>
        <div class="ekg-inspector-list">
          ${grouped.slice(0, 8).map(([activity, list]) => `
            <div class="ekg-inspector-row" data-focus='${_esc(JSON.stringify({ kind: "spine", value: list[0].event_id }))}'>
              <span class="ekg-inspector-row-label">${_esc(activity)}</span>
              <span class="ekg-inspector-row-meta">${list.length}× · click to focus first</span>
            </div>
          `).join("")}
        </div>
        ${grouped.length > 8 ? `<div class="ekg-inspector-note">+ ${grouped.length - 8} more activity types</div>` : ""}
      </div>
    `,
  };
}

function _helpInspectorContent() {
  return {
    titleText: "How to read this view",
    html: `
      <div class="ekg-inspector-block">
        <div class="ekg-inspector-subtitle">Zoom levels</div>
        <ul class="ekg-help-list">
          <li><b>L0 · Galaxy</b> — bin-density heat strip per type. "Where in time is activity concentrated?"</li>
          <li><b>L1 · District</b> — activity nodes sized by frequency, DF arcs within a band.</li>
          <li><b>L2 · Neighbourhood</b> — one row per entity, events as marks. Outliers, individual lifecycles.</li>
          <li><b>L3 · Street</b> — full detail for one focused entity (other bands fall back to L1).</li>
        </ul>
        <div class="ekg-inspector-subtitle">Synchronisation strip</div>
        <p class="ekg-help-text">The thin band directly under the time axis aggregates <b>shared events</b> — events touching two or more entity types. Tall bars = many concurrent shared events. The purple dots are clustered spines; click one to see the underlying events.</p>
        <div class="ekg-inspector-subtitle">Shortcuts</div>
        <ul class="ekg-help-list">
          <li><kbd>1</kbd>/<kbd>2</kbd>/<kbd>3</kbd>/<kbd>4</kbd> — switch levels</li>
          <li><kbd>Ctrl</kbd>+wheel — zoom the time window (cursor anchors)</li>
          <li><kbd>Esc</kbd> — close inspector</li>
          <li>Click any element — focus it</li>
          <li>Click an entity row at L2 — open its lifecycle in T2 (Identify)</li>
        </ul>
      </div>
    `,
  };
}

function _typeInspectorContent({ type }) {
  const store = _storeRef;
  if (!store) return { titleText: "Type", html: "" };
  const ids = store.entityIdsByType?.[type] ?? [];
  const top = ids.slice(0, 25).map(id => {
    const ent = store.entityById[id];
    const events = store.eventsByEntityId?.[id] ?? [];
    return { id, label: _entityLabel(ent), count: events.length };
  }).sort((a, b) => b.count - a.count);
  const typeInfo = store.typeRegistry.byName[type];
  return {
    titleText: `Type · ${type}`,
    html: `
      <div class="ekg-inspector-block">
        <div class="ekg-inspector-meta">
          <span class="ekg-inspector-dot" style="background:${_esc(typeInfo?.color ?? "#64748b")}"></span>
          <span><b>${ids.length.toLocaleString()}</b> entities · role <b>${_esc(typeInfo?.role ?? "—")}</b></span>
        </div>
        <div class="ekg-inspector-subtitle">Top entities by activity</div>
        <div class="ekg-inspector-list">
          ${top.map(it => `
            <div class="ekg-inspector-row" data-focus='${_esc(JSON.stringify({ kind: "entity", value: it.id, entityType: type }))}'>
              <span class="ekg-inspector-row-label">${_esc(it.label)}</span>
              <span class="ekg-inspector-row-meta">${it.count} ev</span>
            </div>
          `).join("")}
        </div>
        ${ids.length > top.length ? `<div class="ekg-inspector-note">+ ${(ids.length - top.length).toLocaleString()} more — use search.</div>` : ""}
        <div class="ekg-inspector-actions">
          <button type="button" class="ekg-btn-ghost" data-nav="identify" data-params='${_esc(JSON.stringify({}))}'>Open Identify (T2)</button>
        </div>
      </div>
    `,
  };
}

function _binInspectorContent({ bin, band }) {
  const acts = Object.entries(bin.byActivity)
    .sort((a, b) => b[1] - a[1])
    .map(([a, c]) => ({ activity: a, count: c }));
  const date0 = new Date(bin.t0).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
  const date1 = new Date(bin.t1).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
  return {
    titleText: `${band.label} · ${date0}`,
    html: `
      <div class="ekg-inspector-block">
        <div class="ekg-inspector-meta">
          <span class="ekg-inspector-dot" style="background:${_esc(band.color)}"></span>
          <span><b>${bin.total}</b> events between ${_esc(date0)} and ${_esc(date1)}</span>
        </div>
        <div class="ekg-inspector-subtitle">Activities in this bin</div>
        <div class="ekg-inspector-list">
          ${acts.map(a => `
            <div class="ekg-inspector-row" data-focus='${_esc(JSON.stringify({ kind: "activity", value: a.activity }))}'>
              <span class="ekg-inspector-row-label">${_esc(a.activity)}</span>
              <span class="ekg-inspector-row-meta">${a.count}</span>
            </div>
          `).join("")}
        </div>
        <div class="ekg-inspector-actions">
          <button type="button" class="ekg-btn-ghost" data-focus='${_esc(JSON.stringify({ kind: "type", value: band.type }))}'>Focus this band</button>
        </div>
      </div>
    `,
  };
}

function _activityInspectorContent({ activity }) {
  const store = _storeRef;
  if (!store) return { titleText: "Activity", html: "" };
  const events = store.events.filter(e => e.activity === activity);
  const types = new Set();
  events.forEach(e => e.memberships.forEach(m => types.add(m.entity_type)));
  const color = store.activityColorByName[activity] ?? "#64748b";
  return {
    titleText: `Activity · ${activity}`,
    html: `
      <div class="ekg-inspector-block">
        <div class="ekg-inspector-meta">
          <span class="ekg-inspector-dot" style="background:${_esc(color)}"></span>
          <span><b>${events.length.toLocaleString()}</b> events · ${types.size} type${types.size === 1 ? "" : "s"}</span>
        </div>
        <div class="ekg-inspector-subtitle">Entity types involved</div>
        <div class="ekg-inspector-chips">
          ${[...types].sort().map(t => `<span class="ekg-mini-chip" data-focus='${_esc(JSON.stringify({ kind: "type", value: t }))}'>${_esc(t)}</span>`).join("")}
        </div>
        <div class="ekg-inspector-actions">
          <button type="button" class="ekg-btn-primary" data-nav="explore" data-params='${_esc(JSON.stringify({ cluster: `act:${activity}` }))}'>Open in Explore (T4)</button>
        </div>
      </div>
    `,
  };
}

function _entityInspectorContent({ entityId, entityType }) {
  const store = _storeRef;
  const entity = store?.entityById?.[entityId];
  if (!entity) return { titleText: "Entity", html: "" };
  const events = store.eventsByEntityId?.[entityId] ?? [];
  const activityCounts = {};
  events.forEach(e => { activityCounts[e.activity] = (activityCounts[e.activity] ?? 0) + 1; });
  const top = Object.entries(activityCounts).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const firstEv = events[0]?.date;
  const lastEv  = events[events.length - 1]?.date;
  return {
    titleText: `Entity · ${_entityLabel(entity)}`,
    html: `
      <div class="ekg-inspector-block">
        <div class="ekg-inspector-meta">
          <span><b>${events.length}</b> events · ${entityType ?? entity.primary_type}</span>
        </div>
        ${firstEv ? `<div class="ekg-inspector-row-meta">First: ${firstEv.toLocaleDateString("en-GB")} · Last: ${lastEv?.toLocaleDateString("en-GB") ?? "—"}</div>` : ""}
        <div class="ekg-inspector-subtitle">Top activities</div>
        <div class="ekg-inspector-list">
          ${top.map(([a, c]) => `
            <div class="ekg-inspector-row" data-focus='${_esc(JSON.stringify({ kind: "activity", value: a }))}'>
              <span class="ekg-inspector-row-label">${_esc(a)}</span>
              <span class="ekg-inspector-row-meta">${c}</span>
            </div>
          `).join("")}
        </div>
        <div class="ekg-inspector-actions">
          <button type="button" class="ekg-btn-primary" data-nav="identify" data-params='${_esc(JSON.stringify({ entity: entityId }))}'>Open in Identify (T2)</button>
          <button type="button" class="ekg-btn-ghost" data-focus='${_esc(JSON.stringify({ kind: "entity", value: entityId, entityType: entityType ?? entity.primary_type }))}'>Zoom to L3</button>
        </div>
      </div>
    `,
  };
}

function _eventInspectorContent({ event, row, band }) {
  const store = _storeRef;
  const fullEvent = store?.eventById?.[event.event_id];
  const memberships = fullEvent?.memberships ?? [];
  return {
    titleText: `Event · ${event.activity}`,
    html: `
      <div class="ekg-inspector-block">
        <div class="ekg-inspector-meta">
          <span><b>${_esc(event.activity)}</b> · ${new Date(event.t).toLocaleString("en-GB")}</span>
        </div>
        <div class="ekg-inspector-row-meta">Event id <code>${_esc(event.event_id)}</code></div>
        ${row ? `<div class="ekg-inspector-row-meta">Seen on entity ${_esc(row.label)}</div>` : ""}
        <div class="ekg-inspector-subtitle">Correlated entities (${memberships.length})</div>
        <div class="ekg-inspector-list">
          ${memberships.slice(0, 12).map(m => `
            <div class="ekg-inspector-row" data-nav="identify" data-params='${_esc(JSON.stringify({ entity: m.entity_id }))}'>
              <span class="ekg-inspector-row-label">${_esc(m.entity_label || m.entity_id)}</span>
              <span class="ekg-inspector-row-meta">${_esc(m.entity_type)}</span>
            </div>
          `).join("")}
        </div>
      </div>
    `,
  };
}

function _spineInspectorContent({ spine }) {
  const store = _storeRef;
  const date = new Date(spine.t).toLocaleString("en-GB");
  const ents = spine.sharedEntityIds.map(id => ({
    id, label: _entityLabel(store?.entityById?.[id]), type: store?.entityById?.[id]?.primary_type ?? "—",
  }));
  return {
    titleText: `Shared event · ${spine.activity}`,
    html: `
      <div class="ekg-inspector-block">
        <div class="ekg-inspector-meta">
          <span class="ekg-inspector-dot" style="background:${_esc(spine.color)}"></span>
          <span>${_esc(date)} · bridges <b>${spine.types.length}</b> types</span>
        </div>
        <div class="ekg-inspector-subtitle">Entities at this synchronisation point</div>
        <div class="ekg-inspector-list">
          ${ents.slice(0, 12).map(e => `
            <div class="ekg-inspector-row" data-nav="identify" data-params='${_esc(JSON.stringify({ entity: e.id }))}'>
              <span class="ekg-inspector-row-label">${_esc(e.label)}</span>
              <span class="ekg-inspector-row-meta">${_esc(e.type)}</span>
            </div>
          `).join("")}
        </div>
        ${ents.length >= 2 ? `<div class="ekg-inspector-actions"><button type="button" class="ekg-btn-primary" data-nav="compare" data-params='${_esc(JSON.stringify({ entities: ents.slice(0, 5).map(e => e.id).join(",") }))}'>Compare top ${Math.min(ents.length, 5)} (T3)</button></div>` : ""}
      </div>
    `,
  };
}

function _openInspector(payload) {
  // Coerce a few "click events" into matching payload kinds for the inspector
  _inspectorPayload = payload;
  _inspectorOpen = true;
  const host = document.getElementById("screen-host");
  if (host) _renderInspector(host);
}

function _closeInspector() {
  _inspectorOpen = false;
  const host = document.getElementById("screen-host");
  if (host) {
    const panel = host.querySelector("#ekg-inspector");
    panel?.classList.remove("open");
  }
}

// ── Toolbar wiring ─────────────────────────────────────────────────────────

function _wireToolbar(host, urlState) {
  host.querySelectorAll(".ekg-level-btn").forEach(btn => {
    btn.addEventListener("click", () => _setLevel(parseInt(btn.dataset.level, 10)));
  });
  host.querySelector("#ekg-reset")?.addEventListener("click", () => _resetAll());
  host.querySelectorAll("[data-chip]").forEach(btn => {
    btn.addEventListener("click", () => {
      const kind = btn.dataset.chip;
      if (kind === "focus") _setFocus(null);
      else if (kind === "window") _setTimeWindow(null);
    });
  });
  // Type-filter chips
  host.querySelectorAll(".ekg-type-pill").forEach(btn => {
    btn.addEventListener("click", () => _toggleType(btn.dataset.type));
  });
  // Help opens an empty-inspector style cheatsheet
  host.querySelector("#ekg-help-btn")?.addEventListener("click", () => {
    _inspectorPayload = { kind: "help" };
    _inspectorOpen = true;
    _renderInspector(host);
  });
  // Time presets
  host.querySelectorAll(".ekg-time-preset").forEach(btn => {
    btn.addEventListener("click", () => _applyTimePreset(btn.dataset.preset));
  });
  // Invalid-date chip → inspector list
  host.querySelector("#ekg-invalid-chip")?.addEventListener("click", () => {
    _inspectorPayload = { kind: "invalid-dates" };
    _inspectorOpen = true;
    _renderInspector(host);
  });
  host.querySelector("#ekg-inspector-close")?.addEventListener("click", () => _closeInspector());
}

// Compute a time window from a preset id and push to the URL. Presets push
// real history entries (they're explicit "navigate-to-this-period" actions)
// so back/forward steps through them naturally.
function _applyTimePreset(presetId) {
  if (!_dataRef) return;
  const dataMin = _dataRef.timeRange.min;
  const dataMax = _dataRef.timeRange.max;
  const span = Math.max(dataMax - dataMin, 1);
  let win = null;
  if (presetId === "all") {
    _setTimeWindow(null, { replace: false });
    return;
  }
  if (presetId === "first25") win = { t0: dataMin, t1: dataMin + span * 0.25 };
  else if (presetId === "last25") win = { t0: dataMax - span * 0.25, t1: dataMax };
  else if (presetId === "busy20") win = _busiestWindow(_dataRef, 0.20);
  if (win) _setTimeWindow(win, { replace: false });
}

// Find the densest sliding window of the requested fraction by walking the
// 48 global-density bins. Returns time bounds, or null if data is empty.
// Zoom the time window by `factor` around its current centre. factor < 1
// zooms in, factor > 1 zooms out. Clamped to the data range.
function _zoomAroundCentre(factor) {
  if (!_layoutRef) return;
  const { t0, t1 } = _layoutRef.timeScale;
  const centre = (t0 + t1) / 2;
  const half = ((t1 - t0) / 2) * factor;
  const dataMin = _layoutRef.dataRange.t0;
  const dataMax = _layoutRef.dataRange.t1;
  let newT0 = centre - half;
  let newT1 = centre + half;
  // If we've grown beyond the data range, snap to full.
  if (newT0 <= dataMin && newT1 >= dataMax) {
    _setTimeWindow(null, { replace: true });
    return;
  }
  newT0 = Math.max(dataMin, newT0);
  newT1 = Math.min(dataMax, newT1);
  // Minimum 1 minute window so we don't crash the layout
  if (newT1 - newT0 < 60_000) return;
  _setTimeWindow({ t0: newT0, t1: newT1 }, { replace: true });
}

function _busiestWindow(data, fraction = 0.20) {
  const bins = data.globalDensity ?? [];
  if (!bins.length) return null;
  const winSize = Math.max(1, Math.floor(bins.length * fraction));
  let bestSum = -1;
  let bestStart = 0;
  let sum = 0;
  for (let i = 0; i < winSize && i < bins.length; i++) sum += bins[i];
  bestSum = sum;
  for (let i = winSize; i < bins.length; i++) {
    sum += bins[i] - bins[i - winSize];
    if (sum > bestSum) { bestSum = sum; bestStart = i - winSize + 1; }
  }
  const dataMin = data.timeRange.min;
  const binWidth = (data.timeRange.max - dataMin) / bins.length;
  return {
    t0: dataMin + bestStart * binWidth,
    t1: dataMin + (bestStart + winSize) * binWidth,
  };
}

function _toggleType(typeId) {
  if (!_dataRef) return;
  const route = getRoute();
  const current = parseEkgUrlState(route.params).visibleTypes ?? [..._defaultVisibleSet(_dataRef.typeNodes)];
  const set = new Set(current);
  if (set.has(typeId)) set.delete(typeId);
  else set.add(typeId);
  // Never let the user hide everything — fall back to all types in that case.
  if (set.size === 0) _dataRef.typeNodes.forEach(t => set.add(t.id));
  const params = _currentRouteParams();
  // Compare against the default set so we omit ?types= when it equals defaults.
  const defaults = _defaultVisibleSet(_dataRef.typeNodes);
  const isDefault = set.size === defaults.size && [...set].every(t => defaults.has(t));
  if (isDefault) delete params.types;
  else params.types = [...set].join(",");
  navigate("ekg", params);
}

// ── Search wiring ──────────────────────────────────────────────────────────

function _wireSearch(host) {
  const input = host.querySelector("#ekg-search");
  const countEl = host.querySelector("#ekg-search-count");
  const clearBtn = host.querySelector("#ekg-search-clear");
  let debounce = null;
  const applyLive = () => {
    const svgEl = host.querySelector(".ekg-svg");
    if (!svgEl) return;
    const result = applyEkgSearch(d3.select(svgEl), _searchQuery);
    if (countEl) {
      countEl.textContent = _searchQuery
        ? `${result.matched.toLocaleString()} match${result.matched === 1 ? "" : "es"}`
        : "";
    }
  };
  input?.addEventListener("input", e => {
    _searchQuery = e.target.value;
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(applyLive, 90);
  });
  clearBtn?.addEventListener("click", () => {
    _searchQuery = "";
    if (input) input.value = "";
    applyLive();
  });
  applyLive();
}

// ── Keyboard ───────────────────────────────────────────────────────────────

function _wireKeyboard(_host, urlState) {
  const handler = (event) => {
    // Don't hijack when typing in any field
    const target = event.target;
    const tag = target?.tagName?.toLowerCase?.();
    if (tag === "input" || tag === "textarea" || target?.isContentEditable) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (getRoute().name !== "ekg") return;
    const map = { "1": 0, "2": 1, "3": 2, "4": 3 };
    if (map[event.key] !== undefined) {
      event.preventDefault();
      _setLevel(map[event.key]);
    } else if (event.key === "+" || event.key === "=") {
      // Zoom in: halve the current window around its centre.
      event.preventDefault();
      _zoomAroundCentre(0.5);
    } else if (event.key === "-" || event.key === "_") {
      event.preventDefault();
      _zoomAroundCentre(2.0);
    } else if (event.key === "Escape") {
      _closeInspector();
    }
  };
  window.removeEventListener("keydown", window.__ekgKeydown ?? (() => {}));
  window.__ekgKeydown = handler;
  window.addEventListener("keydown", handler);
}

// ── Wheel zoom ─────────────────────────────────────────────────────────────

function _wireWheelZoom(host, _urlState) {
  const wrap = host.querySelector("#ekg-canvas-wrap");
  if (!wrap) return;
  wrap.addEventListener("wheel", (event) => {
    // Only zoom when Ctrl/Cmd is held — otherwise let the page scroll.
    if (!(event.ctrlKey || event.metaKey)) return;
    event.preventDefault();
    if (!_layoutRef) return;
    const rect = wrap.getBoundingClientRect();
    const offsetX = event.clientX - rect.left;
    const svgWidth = wrap.querySelector(".ekg-svg")?.getBoundingClientRect().width ?? rect.width;
    const xInLayout = (offsetX / rect.width) * (_layoutRef.innerRight) || offsetX;
    const anchorT = _layoutRef.timeScale.invert(xInLayout);
    // Negative deltaY → zoom in (window shrinks); positive → zoom out.
    const factor = Math.exp(event.deltaY * 0.002);
    const t0 = _layoutRef.timeScale.t0;
    const t1 = _layoutRef.timeScale.t1;
    const newSpan = Math.max(60_000, (t1 - t0) * factor);
    let newT0 = anchorT - (anchorT - t0) * factor;
    let newT1 = newT0 + newSpan;
    // Clamp to data range
    const min = _layoutRef.dataRange.t0;
    const max = _layoutRef.dataRange.t1;
    if (newT0 < min) { newT0 = min; newT1 = newT0 + newSpan; }
    if (newT1 > max) { newT1 = max; newT0 = Math.max(min, newT1 - newSpan); }
    _setTimeWindow({ t0: newT0, t1: newT1 }, { replace: true });
  }, { passive: false });
}

// ── Minimap drag ───────────────────────────────────────────────────────────

let _scrubberPendingWindow = null;

// All three scrubber gestures (pan, resize-left, resize-right) funnel through
// here. We compute the new time window in dataset-space, push a live preview
// via _liveUpdateCanvas, and only commit the URL write on pointerup.
function _scrubberDrag(mode, dx, startRect, scr) {
  if (!_layoutRef) return;
  const w = scr.w;
  const dataMin = scr.dataRange.t0;
  const dataMax = scr.dataRange.t1;
  const dataSpan = Math.max(dataMax - dataMin, 1);
  const dT = (dx / w) * dataSpan;

  const oldT0 = dataMin + ((startRect.x0 - scr.x) / w) * dataSpan;
  const oldT1 = dataMin + ((startRect.x1 - scr.x) / w) * dataSpan;

  let nextT0 = oldT0, nextT1 = oldT1;
  if (mode === "pan") {
    nextT0 = oldT0 + dT;
    nextT1 = oldT1 + dT;
    const span = oldT1 - oldT0;
    if (nextT0 < dataMin) { nextT0 = dataMin; nextT1 = nextT0 + span; }
    if (nextT1 > dataMax) { nextT1 = dataMax; nextT0 = Math.max(dataMin, nextT1 - span); }
  } else if (mode === "resize-left") {
    nextT0 = Math.max(dataMin, Math.min(oldT1 - 60_000, oldT0 + dT));
  } else if (mode === "resize-right") {
    nextT1 = Math.min(dataMax, Math.max(oldT0 + 60_000, oldT1 + dT));
  }
  _scrubberPendingWindow = { t0: nextT0, t1: nextT1 };
  _liveUpdateCanvas(_scrubberPendingWindow);
}

function _scrubberDragCommit() {
  if (_scrubberPendingWindow) {
    _setTimeWindow(_scrubberPendingWindow, { replace: true });
    _scrubberPendingWindow = null;
  }
}

function _scrubberRecentre(px, scr) {
  if (!_layoutRef) return;
  const newCenter = scr.xToTime(px);
  const span = _layoutRef.timeScale.t1 - _layoutRef.timeScale.t0;
  let t0 = newCenter - span / 2;
  let t1 = newCenter + span / 2;
  const min = _layoutRef.dataRange.t0;
  const max = _layoutRef.dataRange.t1;
  if (t0 < min) { t0 = min; t1 = t0 + span; }
  if (t1 > max) { t1 = max; t0 = Math.max(min, t1 - span); }
  _setTimeWindow({ t0, t1 }, { replace: true });
}

// Live re-render without URL write — used during minimap drag. Recompute the
// layout for the new window and redraw; skip URL push.
function _liveUpdateCanvas(timeWindow) {
  if (!_dataRef) return;
  const host = document.getElementById("screen-host");
  if (!host) return;
  const wrap = host.querySelector("#ekg-canvas-wrap");
  if (!wrap) return;
  const width = Math.max(wrap.clientWidth, 720);
  const route = getRoute();
  const state = parseEkgUrlState(route.params);
  const layout = computeEkgViewLayout(_dataRef, { width, heightAvailable: 800 }, {
    level: state.level,
    timeWindow,
    focus: state.focus,
    maxEntitiesPerBand: state.maxEntities,
    bandOrder: _dataRef.bandOrder,
    visibleTypes: state.visibleTypes,
  });
  _layoutRef = layout;
  const svgEl = host.querySelector("#ekg-svg");
  if (svgEl) {
    svgEl.setAttribute("height", String(layout.totalHeight));
    svgEl.setAttribute("viewBox", `0 0 ${width} ${layout.totalHeight}`);
    drawEkgView(d3.select(svgEl), layout, {
      // Keep the scrubber interactive during drag; everything else is dead-
      // weight until the user releases the pointer.
      onScrubberRecentre: (px, scr) => _scrubberRecentre(px, scr),
      onScrubberDrag: (mode, dx, startRect, scr) => _scrubberDrag(mode, dx, startRect, scr),
      onScrubberDragEnd: () => _scrubberDragCommit(),
    });
  }
}

// ── Band background clicks ─────────────────────────────────────────────────

function _wireBandClicks(host) {
  host.querySelectorAll(".ekg-band-bg").forEach(rect => {
    rect.addEventListener("click", () => {
      const type = rect.getAttribute("data-type");
      if (type) _openInspector({ kind: "type", type });
    });
  });
}

// ── URL mutators ───────────────────────────────────────────────────────────

function _currentRouteParams() {
  const r = getRoute();
  return r.name === "ekg" ? { ...r.params } : {};
}

function _setLevel(level) {
  const lvl = _clampLevel(level);
  const params = _currentRouteParams();
  if (lvl === 1) delete params.level;
  else params.level = String(lvl);
  navigate("ekg", params);  // push history — explicit level change
}

function _setTimeWindow(timeWindow, opts = {}) {
  const params = _currentRouteParams();
  if (!timeWindow) {
    delete params.t0;
    delete params.t1;
  } else {
    params.t0 = String(Math.round(timeWindow.t0));
    params.t1 = String(Math.round(timeWindow.t1));
  }
  _scheduleNavigate(params, opts.replace !== false);
}

function _setFocus(focus) {
  const params = _currentRouteParams();
  if (!focus) delete params.focus;
  else params.focus = _serializeFocus(focus);
  navigate("ekg", params);
}

function _resetAll() {
  _searchQuery = "";
  _inspectorPayload = null;
  _inspectorOpen = false;
  navigate("ekg", {});
}

// Throttle URL writes to one per animation frame to avoid flooding history
// during scroll-zoom and drag.
function _scheduleNavigate(params, replace) {
  if (_pendingUrlWrite) cancelAnimationFrame(_pendingUrlWrite);
  _pendingUrlWrite = requestAnimationFrame(() => {
    _pendingUrlWrite = null;
    navigate("ekg", params, { replace });
  });
}

// ── Helpers ────────────────────────────────────────────────────────────────

function _entityLabel(entity) {
  if (!entity) return "";
  return entity.properties?.title
    || entity.properties?.vendorName
    || entity.properties?.name
    || entity.properties?.sysId
    || entity.entity_id;
}

function _esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
