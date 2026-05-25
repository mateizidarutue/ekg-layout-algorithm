"use strict";

// T1 Lifecycle (Population) screen.
//
// Renders an entire dataset as a Canvas 2D dotted-chart: time on x, entity-type
// bands stacked on y, one dot per (entity, event). Click to pin an entity's
// df-path, shift-click to pin more, brush below to zoom a time window, press
// play to advance a fade cursor.
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
  cursorT: 0,
  isPlaying: false,
  speed: 1,
  rafHandle: null,
  lastFrame: 0,

  pinnedEntityIds: new Set(),
  hoveredDotIndex: null,

  searchQuery: "",
  searchMatchEntityIds: new Set(),

  hiddenTypes: new Set(),
  fadeFuture: true,
  cursorDrag: null,

  resizeObs: null,
  brush: null,
};

const PLAYBACK_FULL_RUN_MS = 30000; // full timeline plays in 30s at 1×.

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
        <button type="button" class="t1-btn t1-btn-play" id="t1-btn-play" aria-label="Play">▶</button>
        <div class="t1-speed" role="group" aria-label="Playback speed">
          ${[1,4,16,64].map(sp => `<button type="button" class="t1-speed-btn${sp === _state.speed ? " active" : ""}" data-speed="${sp}">${sp}×</button>`).join("")}
        </div>
        <span class="t1-time-readout" id="t1-time-readout">Day 0</span>
        <button type="button" class="t1-btn" id="t1-btn-reset-window">Reset window</button>
        <button type="button" class="t1-btn" id="t1-btn-reset-cursor">Reset cursor</button>
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
  _refreshPinnedList();

  if (_state.data.stats.events > 100000) {
    console.warn(`[T1] dot count exceeds 100k (events=${_state.data.stats.events}); frame budget may not hold.`);
  }
}

export function unmountSummarizeScreen() {
  if (!_state.active) return;
  if (_state.rafHandle) cancelAnimationFrame(_state.rafHandle);
  _state.rafHandle = null;
  _state.isPlaying = false;
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
  const c = Number(p.cursorT);
  _state.cursorT = Number.isFinite(c) ? c : range.min;
  _state.searchQuery = (p.q ?? "").toString();
  // Back-compat: ?entity= from the old detail URL form folds into pinned.
  const pinned = new Set();
  (p.pinned ?? "").split(",").filter(Boolean).forEach(id => pinned.add(id));
  (p.entity ?? "").split(",").filter(Boolean).forEach(id => pinned.add(id));
  _state.pinnedEntityIds = pinned;
  _state.isPlaying = false;
  _state.speed = 1;
  _state.hoveredDotIndex = null;
}

function _writeUrl(replace) {
  if (!_state.data) return;
  const range = _state.data.timeRange;
  const win = _state.timeWindow;
  const params = new URLSearchParams();
  if (_state.pinnedEntityIds.size) params.set("pinned", [..._state.pinnedEntityIds].join(","));
  if (win.t0 > range.min) params.set("t0", String(Math.round(win.t0)));
  if (win.t1 < range.max) params.set("t1", String(Math.round(win.t1)));
  if (_state.cursorT > range.min) params.set("cursorT", String(Math.round(_state.cursorT)));
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
  const fadeToggle = document.getElementById("t1-toggle-fade-future");
  if (fadeToggle) {
    fadeToggle.checked = _state.fadeFuture;
    fadeToggle.onchange = e => { _state.fadeFuture = e.target.checked; _drawCanvas(); };
  }
}

function _refreshPinnedList() {
  const list = document.getElementById("t1-pinned-list");
  if (!list) return;
  if (!_state.pinnedEntityIds.size) {
    list.innerHTML = `<div class="empty-note">Click a dot to pin an entity's lifecycle. Shift-click to pin more.</div>`;
    return;
  }
  list.innerHTML = [..._state.pinnedEntityIds].map(id => {
    const entity = _state.store?.entityById?.[id];
    const label = _entityLabel(entity, id);
    const type = entity?.primary_type ?? "?";
    const color = _state.layout?.bands?.find(b => b.type === type)?.color ?? "#64748b";
    return `<div class="t1-pinned-row" data-id="${_escAttr(id)}">
      <span class="t1-pinned-swatch" style="background:${_escAttr(color)}"></span>
      <span class="t1-pinned-label" title="${_escAttr(label)}">${_escHtml(label)}</span>
      <span class="t1-pinned-type">${_escHtml(type)}</span>
      <button type="button" class="t1-pinned-x" aria-label="Unpin">×</button>
    </div>`;
  }).join("");
  list.querySelectorAll(".t1-pinned-row").forEach(row => {
    row.querySelector(".t1-pinned-x").addEventListener("click", e => {
      e.stopPropagation();
      _state.pinnedEntityIds.delete(row.dataset.id);
      _refreshPinnedList();
      _redrawOverlay();
      _writeUrl(false);
    });
    row.addEventListener("click", e => {
      if (e.target.classList.contains("t1-pinned-x")) return;
      _openInspectorEntity(row.dataset.id);
    });
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
  document.getElementById("t1-btn-play")?.addEventListener("click", _togglePlay);
  document.querySelectorAll(".t1-speed-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      _state.speed = Number(btn.dataset.speed) || 1;
      document.querySelectorAll(".t1-speed-btn").forEach(b => b.classList.toggle("active", b === btn));
    });
  });
  document.getElementById("t1-btn-reset-window")?.addEventListener("click", () => {
    _state.timeWindow = { t0: _state.data.timeRange.min, t1: _state.data.timeRange.max };
    _redraw({ rebuildLayout: true });
    _renderBrush();
    _writeUrl(false);
  });
  document.getElementById("t1-btn-reset-cursor")?.addEventListener("click", () => {
    _state.cursorT = _state.data.timeRange.min;
    _drawCanvas(); _redrawOverlay(); _updateTimeReadout();
    _writeUrl(true);
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
  if (!hit) return;
  const d = _state.layout.dotPositions[hit.__idx];
  const entityId = d.entityId;
  if (e.shiftKey) {
    if (_state.pinnedEntityIds.has(entityId)) _state.pinnedEntityIds.delete(entityId);
    else _state.pinnedEntityIds.add(entityId);
  } else {
    if (_state.pinnedEntityIds.has(entityId) && _state.pinnedEntityIds.size === 1) {
      _openInspectorEntity(entityId);
      return;
    }
    _state.pinnedEntityIds = new Set([entityId]);
  }
  _refreshPinnedList();
  _redrawOverlay();
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
  if (e.key === " ") { e.preventDefault(); _togglePlay(); return; }
  if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    e.preventDefault();
    const range = _state.data.timeRange;
    const span = range.max - range.min;
    const frac = e.shiftKey ? 0.1 : 0.01;
    const dir = e.key === "ArrowRight" ? 1 : -1;
    _state.cursorT = Math.max(range.min, Math.min(range.max, _state.cursorT + dir * frac * span));
    _drawCanvas(); _redrawOverlay(); _updateTimeReadout();
    _writeUrl(true);
    return;
  }
  if (e.key === "Escape") {
    if (_state.pinnedEntityIds.size || !_state.inspector?.classList.contains("hidden")) {
      _state.pinnedEntityIds.clear();
      _closeInspector();
      _refreshPinnedList();
      _redrawOverlay();
      _writeUrl(false);
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
    _state.cursorT = range.min;
    _redraw({ rebuildLayout: true });
    _renderBrush();
    _writeUrl(false);
  }
}

function _onResize() {
  _redraw({ rebuildLayout: true });
  _renderBrush();
}

// ── Playback ──────────────────────────────────────────────────────────────────

function _togglePlay() {
  _state.isPlaying = !_state.isPlaying;
  const btn = document.getElementById("t1-btn-play");
  if (btn) btn.textContent = _state.isPlaying ? "❚❚" : "▶";
  if (_state.isPlaying) {
    if (_state.cursorT >= _state.data.timeRange.max) _state.cursorT = _state.data.timeRange.min;
    _state.lastFrame = performance.now();
    _state.rafHandle = requestAnimationFrame(_tick);
  } else if (_state.rafHandle) {
    cancelAnimationFrame(_state.rafHandle);
    _state.rafHandle = null;
  }
}

function _tick(now) {
  if (!_state.isPlaying || !_state.active) { _state.rafHandle = null; return; }
  const dt = now - _state.lastFrame;
  _state.lastFrame = now;
  const range = _state.data.timeRange;
  const span = range.max - range.min;
  const dataMsPerWallMs = (span / PLAYBACK_FULL_RUN_MS) * _state.speed;
  _state.cursorT = Math.min(range.max, _state.cursorT + dt * dataMsPerWallMs);
  _drawCanvas();
  _redrawOverlayCursorOnly();
  _updateTimeReadout();
  if (_state.cursorT >= range.max) {
    _state.isPlaying = false;
    const btn = document.getElementById("t1-btn-play");
    if (btn) btn.textContent = "▶";
    _state.rafHandle = null;
    return;
  }
  _state.rafHandle = requestAnimationFrame(_tick);
}

// During playback we only want to move the cursor line; full overlay re-render
// is too heavy per-frame. Update just the cursor group.
function _redrawOverlayCursorOnly() {
  if (!_state.layout || !_state.overlay || typeof d3 === "undefined") return;
  const layout = _state.layout;
  const clampedT = Math.max(layout.timeWindow.t0, Math.min(layout.timeWindow.t1, _state.cursorT));
  const cx = layout.xScale(clampedT);
  const cursor = d3.select(_state.overlay).select(".t1-cursor");
  if (cursor.empty()) { _redrawOverlay(); return; }
  cursor.select("line").attr("x1", cx).attr("x2", cx);
  cursor.select("polygon")
    .attr("points", `${cx - 6},${layout.innerTop - 14} ${cx + 6},${layout.innerTop - 14} ${cx},${layout.innerTop - 4}`);
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

function _openInspectorEntity(entityId) {
  const entity = _state.store?.entityById?.[entityId];
  if (!entity) return;
  const title = document.getElementById("t1-inspector-title");
  const body = document.getElementById("t1-inspector-body");
  if (title) title.textContent = `${entity.primary_type} · ${_entityLabel(entity, entityId)}`;
  if (!body) return;
  const events = (_state.store.eventsByEntityId?.[entityId] ?? []).slice()
    .sort((a, b) => (a.date?.getTime() ?? 0) - (b.date?.getTime() ?? 0));
  const dfEdges = _state.store.dfByEntityId?.[entityId] ?? [];
  const rows = events.map(ev => {
    const sync = ev.entity_ids?.length ?? 1;
    const types = [...new Set((ev.memberships ?? []).map(m => m.entity_type))].join(", ");
    const t = ev.date instanceof Date
      ? ev.date.toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })
      : "—";
    return `<tr><td>${_escHtml(t)}</td><td>${_escHtml(ev.activity ?? "")}</td><td>${sync}</td><td>${_escHtml(types)}</td></tr>`;
  }).join("");
  body.innerHTML = `
    <div class="t1-inspector-meta">
      <div><b>Entity id:</b> ${_escHtml(entityId)}</div>
      <div><b>Events:</b> ${events.length}</div>
      <div><b>DF edges:</b> ${dfEdges.length}</div>
    </div>
    <table class="t1-inspector-table">
      <thead><tr><th>Time</th><th>Activity</th><th>Sync</th><th>Correlated types</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="4">No events in window.</td></tr>`}</tbody>
    </table>
    <div class="t1-inspector-actions">
      <button type="button" class="t1-btn" id="t1-inspector-open-detail">Open T2 detail →</button>
    </div>
  `;
  body.querySelector("#t1-inspector-open-detail")?.addEventListener("click", () => {
    _state.navigateToDetail?.(entityId);
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
    });
    _state.quadtree = _buildQuadtree(_state.layout.dotPositions);
    _updateSearchMatches();
  }
  _drawCanvas();
  _redrawOverlay();
  _updateTimeReadout();
}

function _drawCanvas() {
  if (!_state.layout) return;
  drawCanvasPass(_state.canvas, _state.layout, {
    cursorT: _state.cursorT,
    fadeFuture: _state.fadeFuture,
    pinnedEntityIds: _state.pinnedEntityIds,
    hoveredDotIndex: _state.hoveredDotIndex,
    searchQuery: _state.searchQuery,
    searchMatchEntityIds: _state.searchMatchEntityIds,
  });
}

function _redrawOverlay() {
  if (!_state.layout) return;
  drawOverlayPass(_state.overlay, _state.layout, {
    cursorT: _state.cursorT,
    pinnedEntityIds: _state.pinnedEntityIds,
    hoveredDotIndex: _state.hoveredDotIndex,
  }, _state.store, {
    onPinnedPathClick: entityId => _openInspectorEntity(entityId),
    onCursorDragStart: ev => _beginCursorDrag(ev),
  });
}

// ── Cursor drag ───────────────────────────────────────────────────────────────

function _beginCursorDrag(ev) {
  if (!_state.layout) return;
  ev.preventDefault();
  if (_state.isPlaying) _togglePlay();
  const onMove = e => {
    const rect = _state.overlay.getBoundingClientRect();
    const x = Math.max(_state.layout.innerLeft, Math.min(_state.layout.innerRight, e.clientX - rect.left));
    const win = _state.layout.timeWindow;
    const frac = (x - _state.layout.innerLeft) / Math.max(1, _state.layout.innerRight - _state.layout.innerLeft);
    _state.cursorT = win.t0 + frac * (win.t1 - win.t0);
    _drawCanvas();
    _redrawOverlay();
    _updateTimeReadout();
  };
  const onUp = () => {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    _writeUrl(false);
  };
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
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

function _updateTimeReadout() {
  const el = document.getElementById("t1-time-readout");
  if (!el || !_state.data) return;
  const minT = _state.data.timeRange.min;
  const days = (_state.cursorT - minT) / 86400000;
  const dayPart = Math.floor(Math.max(0, days));
  const d = new Date(_state.cursorT);
  const hm = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  el.textContent = `Day ${dayPart}, ${hm}`;
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
