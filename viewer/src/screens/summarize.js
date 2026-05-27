"use strict";

// T1 Lifecycle (Population) screen.
//
// Renders an entire dataset as a Canvas 2D dotted-chart:
//   • x  = event timestamp
//   • y  = (entity-type band, event activity)  ← activity rows within each band
//   • color = entity type (band color)
//
// Interaction is single-click selection with one-hop propagation across
// correlated entities. Click an event dot to highlight that entity's full
// trace plus the traces of all entities co-participating at the clicked event.
// While a selection is active, activity rows in each band are reordered so
// the highlighted entities' activities float to the top by first-occurrence
// time — this makes the primary trace read as a top-left → bottom-right
// diagonal. Click again on the selected dot, on empty canvas, or press
// Escape, to clear. URL serialises the selection as ?selected=<eventId>.
//
// This is the only screen in the codebase using Canvas 2D. All other screens
// stay SVG.

import { computeSummarizeLayout } from "../layout/summarizeLayout.js";
import { drawCanvasPass, drawOverlayPass } from "../render/summarizeRender.js";
import { getRoute } from "../router.js";

const _state = {
  active: false,
  data: null, store: null,
  hoverCallbacks: null,
  navigateToDetail: null,

  layout: null,
  quadtree: null,

  toolbar: null, canvas: null, overlay: null, brushSvg: null, inspector: null,

  timeWindow: null,

  // Single selection model. `null` when nothing is selected.
  //   eventId           — the clicked event
  //   primaryEntityId   — the band-of-click entity (one entity, not a set)
  //   bandIndex         — the band the click happened in
  //   highlightedEventIds — every event of primary + every event of each
  //                         co-participant at the selected event
  //   highlightedEntityIds — primary entity plus co-participants
  selection: null,
  hoveredDotIndex: null,

  searchQuery: "",
  searchMatchEntityIds: new Set(),

  hiddenTypes: new Set(),

  resizeObs: null,
  brush: null,
};

export function mountSummarizeScreen(opts) {
  const host = document.getElementById("screen-host");
  if (!host) return;

  // Tear down any prior instance first.
  unmountSummarizeScreen();

  _state.data = opts.data;
  _state.store = opts.store;
  _state.hoverCallbacks = opts.hoverCallbacks ?? {};
  _state.navigateToDetail = opts.navigateToDetail;

  _hydrateFromParams(opts.params ?? {});

  host.innerHTML = `
    <div class="t1-screen">
      <div class="t1-toolbar" id="t1-toolbar">
        <span class="t1-title">T1 — Lifecycle (Population)</span>
        <input type="search" class="t1-search" id="t1-search" placeholder="Search entity id / label…" value="${_escAttr(_state.searchQuery)}" />
        <button type="button" class="t1-btn" id="t1-btn-reset-window">Reset window</button>
      </div>
      <div class="t1-canvas-wrap" id="t1-canvas-wrap">
        <canvas id="t1-canvas" class="t1-canvas"></canvas>
        <svg id="t1-overlay" class="t1-overlay" xmlns="http://www.w3.org/2000/svg"></svg>
      </div>
      <div class="t1-brush-bar" id="t1-brush-bar">
        <div class="t1-brush-label">
          <span class="t1-brush-label-text">Time window</span>
          <span class="t1-brush-readout" id="t1-brush-readout">—</span>
          <span class="t1-brush-hint">Drag to zoom · double-click to reset</span>
        </div>
        <svg id="t1-brush" class="t1-brush-svg"></svg>
      </div>
      <aside id="t1-inspector" class="t1-inspector hidden">
        <div class="t1-inspector-head">
          <span class="t1-inspector-title" id="t1-inspector-title">Inspector</span>
          <button type="button" class="t1-inspector-close" id="t1-inspector-close" aria-label="Close">×</button>
        </div>
        <div class="t1-inspector-body" id="t1-inspector-body"></div>
      </aside>
    </div>
  `;

  _state.toolbar = host.querySelector("#t1-toolbar");
  _state.canvas = host.querySelector("#t1-canvas");
  _state.overlay = host.querySelector("#t1-overlay");
  _state.brushSvg = host.querySelector("#t1-brush");
  _state.inspector = host.querySelector("#t1-inspector");

  _bindToolbar();
  _bindCanvas();
  _bindKeyboard();
  _renderSidebar();

  _state.active = true;

  const wrap = host.querySelector("#t1-canvas-wrap");
  if (window.ResizeObserver && wrap) {
    _state.resizeObs = new ResizeObserver(_onResize);
    _state.resizeObs.observe(wrap);
  }

  _redraw({ rebuildLayout: true });
  _renderBrush();
  _refreshSelectionPanel();
  if (_state.selection) _openInspector();

  if (_state.data.stats.events > 100000) {
    console.warn(`[T1] dot count exceeds 100k (events=${_state.data.stats.events}); frame budget may not hold.`);
  }
}

export function unmountSummarizeScreen() {
  if (!_state.active) return;
  _state.resizeObs?.disconnect();
  _state.resizeObs = null;
  document.removeEventListener("keydown", _onKeydown);
  _state.active = false;
  _state.layout = null;
  _state.quadtree = null;
}

export function updateSummarizeSidebar(data) {
  const title = document.getElementById("t1-overview-title");
  const content = document.getElementById("t1-overview-content");
  if (!title || !content) return;
  if (!data) {
    title.textContent = "Population overview";
    content.innerHTML = `<div class="stat-row"><span class="stat-label">Open T1 to see population stats.</span></div>`;
    return;
  }
  const s = data.stats;
  const minD = new Date(data.timeRange.min).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
  const maxD = new Date(data.timeRange.max).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
  const rows = [
    ["Events",       s.events.toLocaleString()],
    ["Entities",     s.entities.toLocaleString()],
    ["Entity types", s.entityTypes.toLocaleString()],
    ["Shared events (≥3 types)", (data.spines ?? []).filter(sp => sp.types.length >= 3).length.toLocaleString()],
    ["Time span",    `${minD} → ${maxD}`],
  ];
  content.innerHTML = rows.map(([k, v]) =>
    `<div class="stat-row"><span class="stat-label">${_escHtml(k)}</span><span class="stat-val">${_escHtml(v)}</span></div>`
  ).join("");
}

// ── Hydration / URL ───────────────────────────────────────────────────────────

function _hydrateFromParams(p) {
  const range = _state.data.timeRange;
  const t0 = Number(p.t0);
  const t1 = Number(p.t1);
  _state.timeWindow = {
    t0: Number.isFinite(t0) ? t0 : range.min,
    t1: Number.isFinite(t1) ? t1 : range.max,
  };
  _state.searchQuery = (p.q ?? "").toString();
  _state.hoveredDotIndex = null;
  _state.selection = null;

  // ── Selection hydration ────────────────────────────────────────────────
  // Preferred form: ?selected=<eventId>
  // Back-compat: ?pinned=<id>,<id>,... or ?entity=<id> from the older URL.
  //   Take the first id, locate its first chronological event, treat as a
  //   synthetic ?selected=<eventId>, and re-write the URL once on next push.
  let selectedEventId = (p.selected ?? "").toString().trim();
  let upgradedFromLegacy = false;
  if (!selectedEventId) {
    const legacy = ((p.pinned ?? "") + "," + (p.entity ?? "")).split(",").map(s => s.trim()).filter(Boolean);
    if (legacy.length) {
      const firstEv = _firstEventOf(legacy[0]);
      if (firstEv) {
        selectedEventId = String(firstEv.event_id);
        upgradedFromLegacy = true;
      }
    }
  }
  if (selectedEventId) {
    _state.selection = _buildSelectionFromEvent(selectedEventId);
  }
  if (upgradedFromLegacy && _state.selection) {
    // Defer the URL rewrite until after mount finishes (history pushes during
    // module init are fine, but the URL must reflect the new ?selected= form).
    queueMicrotask(() => _writeUrl(true));
  }
}

function _firstEventOf(entityId) {
  const list = _state.store?.eventsByEntityId?.[entityId] ?? [];
  if (!list.length) return null;
  // eventsByEntityId is generally time-ordered, but sort defensively.
  return list.slice().sort((a, b) => (a.date?.getTime() ?? 0) - (b.date?.getTime() ?? 0))[0];
}

// Build a full selection record from an event id alone. Used both on click
// and on URL hydration. For URL hydration, the primary entity is the first
// entity (in `bandOrder`) that participates in the event — a defensible
// heuristic since the URL doesn't carry which band the user clicked in.
function _buildSelectionFromEvent(eventId, primaryEntityHint = null) {
  const store = _state.store;
  if (!store) return null;
  const event = store.eventById?.[eventId];
  if (!event) return null;

  let primaryEntityId = primaryEntityHint;
  if (!primaryEntityId) {
    for (const type of _state.data.bandOrder ?? []) {
      const ids = event.entity_ids_by_type?.[type] ?? [];
      if (ids.length) { primaryEntityId = ids[0]; break; }
    }
  }
  if (!primaryEntityId) return null;

  const bandIndex = (_state.data.bandOrder ?? []).indexOf(
    store.entityById?.[primaryEntityId]?.primary_type
  );

  // Highlighted event ids: every event of the primary entity plus, at the
  // selected event only, every event of every co-participant entity.
  const highlightedEventIds = new Set();
  const highlightedEntityIds = new Set();
  highlightedEntityIds.add(primaryEntityId);

  (store.eventsByEntityId?.[primaryEntityId] ?? []).forEach(ev => {
    highlightedEventIds.add(String(ev.event_id));
  });

  const edges = store.corrByEventId?.[eventId] ?? [];
  edges.forEach(edge => {
    if (!edge.entity_id || edge.entity_id === primaryEntityId) return;
    highlightedEntityIds.add(edge.entity_id);
    (store.eventsByEntityId?.[edge.entity_id] ?? []).forEach(ev => {
      highlightedEventIds.add(String(ev.event_id));
    });
  });

  // The selected event itself is always highlighted (it might not be among
  // the primary's events if the URL was hand-rolled, but include it anyway).
  highlightedEventIds.add(String(eventId));

  return {
    eventId: String(eventId),
    primaryEntityId,
    bandIndex,
    highlightedEventIds,
    highlightedEntityIds,
  };
}

function _writeUrl(replace) {
  if (!_state.data) return;
  const range = _state.data.timeRange;
  const win = _state.timeWindow;
  const params = new URLSearchParams();
  if (_state.selection?.eventId) params.set("selected", _state.selection.eventId);
  if (win.t0 > range.min) params.set("t0", String(Math.round(win.t0)));
  if (win.t1 < range.max) params.set("t1", String(Math.round(win.t1)));
  if (_state.searchQuery) params.set("q", _state.searchQuery);
  const q = params.toString();
  const hash = `#/summarize${q ? "?" + q : ""}`;
  const url = window.location.pathname + window.location.search + hash;
  if (window.location.hash === hash) return;
  if (replace) history.replaceState(null, "", url);
  else history.pushState(null, "", url);
}

// ── Sidebar ───────────────────────────────────────────────────────────────────

function _renderSidebar() {
  const bandList = document.getElementById("t1-band-list");
  if (bandList) {
    bandList.innerHTML = "";
    (_state.data.typeNodes ?? []).forEach(node => {
      const checked = !_state.hiddenTypes.has(node.id);
      const row = document.createElement("label");
      row.className = "toggle-row t1-band-toggle";
      row.innerHTML = `<input type="checkbox" ${checked ? "checked" : ""}><span class="t1-band-swatch" style="background:${_escAttr(node.color)}"></span><span class="t1-band-toggle-label">${_escHtml(node.label)}</span><span class="t1-band-count-chip">${node.entityCountVisible}</span>`;
      row.querySelector("input").addEventListener("change", e => {
        if (e.target.checked) _state.hiddenTypes.delete(node.id);
        else _state.hiddenTypes.add(node.id);
        _redraw({ rebuildLayout: true });
      });
      bandList.appendChild(row);
    });
  }
}

function _refreshSelectionPanel() {
  const list = document.getElementById("t1-selection-summary");
  if (!list) return;
  const sel = _state.selection;
  if (!sel) {
    list.innerHTML = `<div class="empty-note">Click any dot to select an event and reveal its EKG neighbourhood.</div>`;
    return;
  }
  const store = _state.store;
  const event = store?.eventById?.[sel.eventId];
  const entity = store?.entityById?.[sel.primaryEntityId];
  const ts = event?.date instanceof Date
    ? event.date.toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })
    : "—";
  const primaryLabel = _entityLabel(entity, sel.primaryEntityId);
  const primaryType = entity?.primary_type ?? "?";
  const primaryColor = _state.layout?.bands?.find(b => b.type === primaryType)?.color ?? "#64748b";
  const corrCount = Math.max(0, sel.highlightedEntityIds.size - 1);
  const evCount = sel.highlightedEventIds.size;
  list.innerHTML = `
    <div class="t1-selection-summary">
      <div class="t1-selection-row t1-selection-event">
        <span class="t1-selection-label">Event</span>
        <span class="t1-selection-value">${_escHtml(event?.activity ?? "—")}</span>
      </div>
      <div class="t1-selection-row">
        <span class="t1-selection-label">When</span>
        <span class="t1-selection-value t1-selection-mono">${_escHtml(ts)}</span>
      </div>
      <div class="t1-selection-row">
        <span class="t1-selection-label">Primary</span>
        <span class="t1-selection-value">
          <span class="t1-pinned-swatch" style="background:${_escAttr(primaryColor)}"></span>
          ${_escHtml(primaryLabel)}
          <span class="t1-selection-sub">${_escHtml(primaryType)}</span>
        </span>
      </div>
      <div class="t1-selection-row">
        <span class="t1-selection-label">Correlated</span>
        <span class="t1-selection-value t1-selection-mono">${corrCount} entit${corrCount === 1 ? "y" : "ies"}</span>
      </div>
      <div class="t1-selection-row">
        <span class="t1-selection-label">Highlighted</span>
        <span class="t1-selection-value t1-selection-mono">${evCount} events</span>
      </div>
      <button type="button" class="t1-btn" id="t1-btn-clear-selection">Clear selection</button>
    </div>
  `;
  list.querySelector("#t1-btn-clear-selection")?.addEventListener("click", () => {
    _clearSelection();
  });
}

// ── Bindings ──────────────────────────────────────────────────────────────────

function _bindToolbar() {
  document.getElementById("t1-search")?.addEventListener("input", e => {
    _state.searchQuery = e.target.value.trim();
    _updateSearchMatches();
    _drawCanvas();
    _writeUrl(true);
  });
  document.getElementById("t1-btn-reset-window")?.addEventListener("click", () => {
    _state.timeWindow = { t0: _state.data.timeRange.min, t1: _state.data.timeRange.max };
    _redraw({ rebuildLayout: true });
    _renderBrush();
    _writeUrl(false);
  });
  document.getElementById("t1-inspector-close")?.addEventListener("click", _closeInspector);
}

function _bindCanvas() {
  const canvas = _state.canvas;
  if (!canvas) return;
  canvas.addEventListener("mousemove", _onCanvasMove);
  canvas.addEventListener("mouseleave", _onCanvasLeave);
  canvas.addEventListener("click", _onCanvasClick);
}

function _onCanvasMove(e) {
  if (!_state.quadtree || !_state.layout) return;
  const rect = _state.canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;
  const hit = _state.quadtree.find(mx, my, 6);
  const idx = hit ? hit.__idx : null;
  if (idx === _state.hoveredDotIndex) return;
  _state.hoveredDotIndex = idx;
  _redrawOverlay();
  if (idx != null) {
    const d = _state.layout.dotPositions[idx];
    const entity = _state.store?.entityById?.[d.entityId];
    const label = _entityLabel(entity, d.entityId);
    const time = new Date(d.t).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
    const html = `
      <div style="font-weight:600">${_escHtml(label)}</div>
      <div>${_escHtml(d.entityType)} · ${_escHtml(d.activity)}</div>
      <div>${_escHtml(time)}</div>
      ${d.isShared ? `<div style="color:#7c3aed">Shared event</div>` : ""}
    `;
    _state.hoverCallbacks?.show?.(html, e);
  } else {
    _state.hoverCallbacks?.hide?.();
  }
}

function _onCanvasLeave() {
  if (_state.hoveredDotIndex == null) return;
  _state.hoveredDotIndex = null;
  _redrawOverlay();
  _state.hoverCallbacks?.hide?.();
}

function _onCanvasClick(e) {
  if (!_state.quadtree || !_state.layout) return;
  const rect = _state.canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;
  const hit = _state.quadtree.find(mx, my, 6);

  // Empty-space click clears the selection.
  if (!hit) {
    if (_state.selection) _clearSelection();
    return;
  }
  const d = _state.layout.dotPositions[hit.__idx];

  // Click on the currently selected dot toggles off (clear).
  if (_state.selection
      && String(_state.selection.eventId) === String(d.eventId)
      && _state.selection.primaryEntityId === d.entityId) {
    _clearSelection();
    return;
  }

  _state.selection = _buildSelectionFromEvent(String(d.eventId), d.entityId);
  _refreshSelectionPanel();
  _redraw({ rebuildLayout: true }); // activity rows reorder per band
  _openInspector();
  _writeUrl(false);
}

function _clearSelection() {
  _state.selection = null;
  _refreshSelectionPanel();
  _closeInspector();
  _redraw({ rebuildLayout: true }); // restore default activity ordering
  _writeUrl(false);
}

function _bindKeyboard() {
  document.addEventListener("keydown", _onKeydown);
}

function _onKeydown(e) {
  if (!_state.active) return;
  if (getRoute().name !== "summarize") return;
  const tag = e.target?.tagName?.toLowerCase();
  const typing = tag === "input" || tag === "textarea" || tag === "select" || e.target?.isContentEditable;
  if (typing) {
    if (e.key === "Escape") e.target.blur();
    return;
  }
  if (e.key === "Escape") {
    if (_state.selection || !_state.inspector?.classList.contains("hidden")) {
      _clearSelection();
    }
    return;
  }
  if (e.key === "/") {
    e.preventDefault();
    document.getElementById("t1-search")?.focus();
    return;
  }
  if (e.key === "0") {
    const range = _state.data.timeRange;
    _state.timeWindow = { t0: range.min, t1: range.max };
    _redraw({ rebuildLayout: true });
    _renderBrush();
    _writeUrl(false);
  }
}

function _onResize() {
  _redraw({ rebuildLayout: true });
  _renderBrush();
}

// ── Brush ─────────────────────────────────────────────────────────────────────

function _renderBrush() {
  const svgEl = _state.brushSvg;
  if (!svgEl || !_state.layout || typeof d3 === "undefined") return;
  const wrap = document.getElementById("t1-canvas-wrap");
  const width = wrap?.clientWidth ?? _state.layout.width;
  const height = 60;
  const padL = _state.layout.innerLeft;
  const padR = _state.layout.innerRight;
  const inner = Math.max(1, padR - padL);

  const s = d3.select(svgEl);
  s.attr("width", width).attr("height", height).attr("viewBox", `0 0 ${width} ${height}`);
  s.selectAll("*").remove();

  const range = _state.data.timeRange;
  const span = Math.max(range.max - range.min, 1);

  // Density strip from getEkgView.bins
  const bins = _state.data.bins ?? [];
  const maxBin = Math.max(1, ...bins.map(b => b.total));
  const bg = s.append("g").attr("class", "t1-brush-density");
  bins.forEach(bin => {
    const x0 = padL + ((bin.t0 - range.min) / span) * inner;
    const x1 = padL + ((bin.t1 - range.min) / span) * inner;
    const h = (bin.total / maxBin) * 40;
    bg.append("rect")
      .attr("x", x0).attr("y", 48 - h)
      .attr("width", Math.max(1, x1 - x0 - 0.4)).attr("height", h)
      .attr("fill", "#94a3b8").attr("fill-opacity", 0.55);
  });

  // Baseline
  s.append("line")
    .attr("x1", padL).attr("x2", padR)
    .attr("y1", 50).attr("y2", 50)
    .attr("stroke", "#cbd5e1");

  // Date end-tick labels at full extent
  const fmtDate = t => new Date(t).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
  s.append("text")
    .attr("class", "t1-brush-end-label")
    .attr("x", padL).attr("y", 58).attr("text-anchor", "start")
    .text(fmtDate(range.min));
  s.append("text")
    .attr("class", "t1-brush-end-label")
    .attr("x", padR).attr("y", 58).attr("text-anchor", "end")
    .text(fmtDate(range.max));

  const brushG = s.append("g").attr("class", "t1-brush");
  _state.brush = d3.brushX()
    .extent([[padL, 4], [padR, 50]])
    .on("end", ev => {
      if (!ev.sourceEvent) return; // programmatic move, ignore
      if (!ev.selection) {
        _state.timeWindow = { t0: range.min, t1: range.max };
      } else {
        const [x0, x1] = ev.selection;
        // Guard against zero-width selections (single-click)
        if (x1 - x0 < 4) {
          _state.timeWindow = { t0: range.min, t1: range.max };
          brushG.call(_state.brush.move, null);
        } else {
          _state.timeWindow = {
            t0: range.min + ((x0 - padL) / inner) * span,
            t1: range.min + ((x1 - padL) / inner) * span,
          };
        }
      }
      _redraw({ rebuildLayout: true });
      _updateBrushReadout();
      _writeUrl(false);
    });
  brushG.call(_state.brush);

  const win = _state.timeWindow;
  if (win.t0 > range.min || win.t1 < range.max) {
    const bx0 = padL + ((win.t0 - range.min) / span) * inner;
    const bx1 = padL + ((win.t1 - range.min) / span) * inner;
    brushG.call(_state.brush.move, [bx0, bx1]);
  }

  _updateBrushReadout();
}

function _updateBrushReadout() {
  const el = document.getElementById("t1-brush-readout");
  if (!el || !_state.data) return;
  const range = _state.data.timeRange;
  const win = _state.timeWindow;
  const fmt = t => new Date(t).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
  const isFull = win.t0 <= range.min && win.t1 >= range.max;
  el.textContent = isFull
    ? `${fmt(range.min)} → ${fmt(range.max)} (full range)`
    : `${fmt(win.t0)} → ${fmt(win.t1)}`;
}

// ── Inspector ────────────────────────────────────────────────────────────────

function _openInspector() {
  const sel = _state.selection;
  if (!sel) { _closeInspector(); return; }
  const store = _state.store;
  if (!store) return;

  const event = store.eventById?.[sel.eventId];
  const primary = store.entityById?.[sel.primaryEntityId];
  if (!event || !primary) { _closeInspector(); return; }

  const title = document.getElementById("t1-inspector-title");
  const body = document.getElementById("t1-inspector-body");
  if (!title || !body) return;

  const eventTs = event.date instanceof Date
    ? event.date.toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })
    : "—";

  title.textContent = `${event.activity ?? "Event"} · ${eventTs}`;

  // ── Event panel: id, activity, timestamp, sync, correlated entities ──
  const correlatedByType = new Map();
  const edges = store.corrByEventId?.[sel.eventId] ?? [];
  edges.forEach(edge => {
    const e = store.entityById?.[edge.entity_id];
    const type = e?.primary_type ?? "?";
    if (!correlatedByType.has(type)) correlatedByType.set(type, []);
    correlatedByType.get(type).push({ id: edge.entity_id, label: _entityLabel(e, edge.entity_id) });
  });
  const corrGroupsHtml = [...correlatedByType.entries()].map(([type, list]) => `
    <div class="t1-inspector-group">
      <div class="t1-inspector-group-head">${_escHtml(type)} · ${list.length}</div>
      <ul>${list.map(it => `
        <li><a href="#" class="t1-inspector-entity-link" data-id="${_escAttr(it.id)}">${_escHtml(it.label)}</a></li>
      `).join("")}</ul>
    </div>`).join("");

  // ── Primary entity panel: full event sequence ──
  const primaryEvents = (store.eventsByEntityId?.[sel.primaryEntityId] ?? []).slice()
    .sort((a, b) => (a.date?.getTime() ?? 0) - (b.date?.getTime() ?? 0));
  const primaryRows = primaryEvents.map(ev => {
    const sync = ev.entity_ids?.length ?? 1;
    const isSelected = String(ev.event_id) === String(sel.eventId);
    const t = ev.date instanceof Date
      ? ev.date.toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })
      : "—";
    return `<tr class="t1-event-row${isSelected ? " is-selected" : ""}" data-event-id="${_escAttr(ev.event_id)}">
      <td>${_escHtml(t)}</td>
      <td>${_escHtml(ev.activity ?? "")}</td>
      <td>${sync}</td>
    </tr>`;
  }).join("");

  // ── Correlated entities panel (collapsed by default) ──
  const otherEntities = [...sel.highlightedEntityIds]
    .filter(id => id !== sel.primaryEntityId)
    .map(id => {
      const e = store.entityById?.[id];
      const count = (store.eventsByEntityId?.[id] ?? []).length;
      return {
        id, label: _entityLabel(e, id),
        type: e?.primary_type ?? "?",
        count,
      };
    })
    .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));

  const corrEntityRowsHtml = otherEntities.map(o => {
    const color = _state.layout?.bands?.find(b => b.type === o.type)?.color ?? "#64748b";
    return `<div class="t1-corr-entity-row" data-id="${_escAttr(o.id)}" data-action="switch-primary">
      <span class="t1-pinned-swatch" style="background:${_escAttr(color)}"></span>
      <span class="t1-corr-entity-label">${_escHtml(o.label)}</span>
      <span class="t1-corr-entity-type">${_escHtml(o.type)}</span>
      <span class="t1-corr-entity-count">${o.count} ev</span>
    </div>`;
  }).join("");

  body.innerHTML = `
    <section class="t1-inspector-section">
      <h3 class="t1-inspector-section-head">Event</h3>
      <div class="t1-inspector-meta">
        <div><b>Activity:</b> ${_escHtml(event.activity ?? "—")}</div>
        <div><b>Time:</b> ${_escHtml(eventTs)}</div>
        <div><b>Event id:</b> <span class="t1-selection-mono">${_escHtml(sel.eventId)}</span></div>
        <div><b>Sync degree:</b> ${event.entity_ids?.length ?? 1} entities across ${correlatedByType.size} types</div>
      </div>
      <div class="t1-inspector-groups">${corrGroupsHtml || `<div class="empty-note">No correlated entities.</div>`}</div>
    </section>

    <section class="t1-inspector-section">
      <h3 class="t1-inspector-section-head">Primary entity · ${_escHtml(primary.primary_type ?? "")}</h3>
      <div class="t1-inspector-meta">
        <div><b>Label:</b> ${_escHtml(_entityLabel(primary, sel.primaryEntityId))}</div>
        <div><b>Entity id:</b> <span class="t1-selection-mono">${_escHtml(sel.primaryEntityId)}</span></div>
        <div><b>Events:</b> ${primaryEvents.length}</div>
      </div>
      <table class="t1-inspector-table">
        <thead><tr><th>Time</th><th>Activity</th><th>Sync</th></tr></thead>
        <tbody>${primaryRows || `<tr><td colspan="3">No events.</td></tr>`}</tbody>
      </table>
      <div class="t1-inspector-actions">
        <button type="button" class="t1-btn" id="t1-inspector-open-detail">Open T2 detail →</button>
      </div>
    </section>

    <section class="t1-inspector-section">
      <details class="t1-inspector-details">
        <summary class="t1-inspector-section-head">
          Correlated entities · ${otherEntities.length}
        </summary>
        <div class="t1-corr-entity-list">${corrEntityRowsHtml || `<div class="empty-note">No correlated entities.</div>`}</div>
      </details>
    </section>
  `;

  // Wire interactions
  body.querySelectorAll(".t1-inspector-entity-link").forEach(a => {
    a.addEventListener("click", e => {
      e.preventDefault();
      _switchPrimaryEntity(a.dataset.id);
    });
  });
  body.querySelectorAll(".t1-event-row").forEach(row => {
    row.addEventListener("click", () => {
      const newEventId = row.dataset.eventId;
      if (!newEventId || newEventId === sel.eventId) return;
      _state.selection = _buildSelectionFromEvent(newEventId, sel.primaryEntityId);
      _refreshSelectionPanel();
      _redraw({ rebuildLayout: true });
      _openInspector();
      _writeUrl(false);
    });
  });
  body.querySelectorAll(".t1-corr-entity-row[data-action='switch-primary']").forEach(row => {
    row.addEventListener("click", () => _switchPrimaryEntity(row.dataset.id));
  });
  body.querySelector("#t1-inspector-open-detail")?.addEventListener("click", () => {
    _state.navigateToDetail?.(sel.primaryEntityId);
  });

  _state.inspector?.classList.remove("hidden");
}

function _closeInspector() {
  _state.inspector?.classList.add("hidden");
}

// ── Layout / draw orchestration ──────────────────────────────────────────────

function _updateSearchMatches() {
  if (!_state.searchQuery) { _state.searchMatchEntityIds = new Set(); return; }
  const q = _state.searchQuery.toLowerCase();
  const matches = new Set();
  const buckets = _state.data.sparklinesByType ?? {};
  for (const type in buckets) {
    const rows = buckets[type];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (r.entity_id.toLowerCase().includes(q) || (r.label ?? "").toLowerCase().includes(q)) {
        matches.add(r.entity_id);
      }
    }
  }
  _state.searchMatchEntityIds = matches;
}

function _redraw({ rebuildLayout = false } = {}) {
  if (!_state.active) return;
  const wrap = document.getElementById("t1-canvas-wrap");
  if (!wrap) return;
  const width = wrap.clientWidth;
  const height = wrap.clientHeight;
  if (rebuildLayout || !_state.layout || _state.layout.width !== width || _state.layout.height !== height) {
    const visibleTypes = new Set((_state.data.bandOrder ?? []).filter(t => !_state.hiddenTypes.has(t)));
    _state.layout = computeSummarizeLayout({
      data: _state.data,
      viewport: { width, height },
      timeWindow: _state.timeWindow,
      visibleTypes,
      selectionActivityOrder: _buildSelectionActivityOrder(_state.selection),
    });
    _state.quadtree = _buildQuadtree(_state.layout.dotPositions);
    _updateSearchMatches();
  }
  _drawCanvas();
  _redrawOverlay();
}

// Build per-band activity ordering for the current selection:
//   typeName → Array<{ activity, firstT }>  (sorted by firstT asc)
// where firstT is the earliest time among highlighted events of that activity
// that touch the given entity type. This is what makes the primary entity's
// trace plot as a clean top-left → bottom-right staircase, with neighbours
// reading as deviations from that staircase.
function _buildSelectionActivityOrder(selection) {
  if (!selection?.highlightedEventIds?.size) return null;
  const store = _state.store;
  if (!store) return null;
  const perTypeFirst = new Map(); // type → Map<activity, firstT>
  selection.highlightedEventIds.forEach(eventId => {
    const ev = store.eventById?.[eventId];
    if (!ev || !(ev.date instanceof Date)) return;
    const t = ev.date.getTime();
    const seen = new Set();
    (ev.memberships ?? []).forEach(m => {
      if (seen.has(m.entity_type)) return;
      seen.add(m.entity_type);
      if (!perTypeFirst.has(m.entity_type)) perTypeFirst.set(m.entity_type, new Map());
      const inner = perTypeFirst.get(m.entity_type);
      const prev = inner.get(ev.activity);
      if (prev == null || t < prev) inner.set(ev.activity, t);
    });
  });
  const out = new Map();
  perTypeFirst.forEach((activityMap, type) => {
    const ordered = [...activityMap.entries()]
      .sort((a, b) => a[1] - b[1])
      .map(([activity, firstT]) => ({ activity, firstT }));
    out.set(type, ordered);
  });
  return out;
}

function _drawCanvas() {
  if (!_state.layout) return;
  drawCanvasPass(_state.canvas, _state.layout, {
    selection: _state.selection,
    hoveredDotIndex: _state.hoveredDotIndex,
    searchQuery: _state.searchQuery,
    searchMatchEntityIds: _state.searchMatchEntityIds,
  });
}

function _redrawOverlay() {
  if (!_state.layout) return;
  drawOverlayPass(_state.overlay, _state.layout, {
    selection: _state.selection,
    hoveredDotIndex: _state.hoveredDotIndex,
  }, _state.store, {
    onSelectionLineClick: entityId => _switchPrimaryEntity(entityId),
  });
}

// Switching the primary entity inside an active selection: pick that entity's
// first chronological event as the new selection anchor, re-derive the hop.
function _switchPrimaryEntity(entityId) {
  const first = _firstEventOf(entityId);
  if (!first) return;
  _state.selection = _buildSelectionFromEvent(String(first.event_id), entityId);
  _refreshSelectionPanel();
  _redraw({ rebuildLayout: true });
  _openInspector();
  _writeUrl(false);
}

function _buildQuadtree(dots) {
  if (typeof d3 === "undefined" || !d3.quadtree) return null;
  const tree = d3.quadtree().x(d => d.x).y(d => d.y);
  for (let i = 0; i < dots.length; i++) {
    dots[i].__idx = i;
    tree.add(dots[i]);
  }
  return tree;
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function _entityLabel(entity, fallback) {
  return entity?.properties?.title
    || entity?.properties?.name
    || entity?.properties?.label
    || entity?.entity_id
    || fallback;
}

function _escAttr(v) {
  return String(v ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function _escHtml(v) {
  return String(v ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
