"use strict";

// EKG macro view — Option 1 prototype (Object Interaction Map + Timeline).
//
// Replaces the 4-level model with a much simpler "see everything, click to
// drill in" design. The screen has two panels:
//
//   • LEFT  — Type interaction map: force-directed graph of entity types.
//             Nodes sized by entity count. Edges encode two relationships
//             between type pairs:
//                solid grey   = structural relation (HAS_ITEM, etc.)
//                dashed blue  = shared-event co-occurrence (events touching
//                               both types). Width ∝ count.
//
//   • RIGHT — Event volume over time: a stacked area chart, one layer per
//             type, drawn against a zero baseline (volumes, not wiggle).
//             Drag horizontally to set a date *filter* (not a zoom — the
//             chart still shows the whole range; events outside the filter
//             are excluded from the schema panel).
//
//   • BOTTOM — Detail panel. Empty by default. Fills when a type or time bin
//              is clicked, with summary stats and "Open in T2/T3/T4" actions.
//
// Designed to be a sibling of `/ekg`, not a replacement (yet) — switch
// between the two via the home screen to compare side-by-side.
//
// Literature anchors (cited in plan): Object Interaction Graph (van der
// Aalst, OCPM 2019); Coordinated Multiple Views (Roberts 2007); Tufte's
// "small multiples + detail on demand"; Celonis Process Sphere's
// schema-plus-flow pairing.

import { navigate, getRoute } from "../router.js";

// Per-session UI state. Date filter and selection are NOT in the URL for the
// prototype — promote later once the design lands.
let _dateFilter = null;   // { t0, t1 } | null
let _selection = null;    // { kind: "type"|"bin", ... } | null
let _typeVisibility = null; // Set<typeId> | null = use default
let _hoverCallbacks = { show: null, hide: null };
let _dataRef = null;
let _storeRef = null;

const GEOM = Object.freeze({
  schemaMinH: 320,
  timelineMinH: 280,
  detailMinH: 140,
  pad: 18,
});

// ── Public API ──────────────────────────────────────────────────────────────

export function renderEkgV3Screen({ data, store, hoverCallbacks }) {
  _hoverCallbacks = hoverCallbacks ?? {};
  _dataRef = data;
  _storeRef = store;

  const host = document.getElementById("screen-host");
  if (!host) return;

  if (!data || !data.typeNodes?.length) {
    host.innerHTML = `<div class="v3-screen"><div class="v3-empty">No EKG data — clear filters or load a dataset.</div></div>`;
    return;
  }

  // First-time default for type visibility — same convention as the current
  // atlas: hide resource/attribute roles initially, since they crowd the
  // schema with low-signal nodes.
  if (_typeVisibility === null) {
    _typeVisibility = _defaultVisibleTypes(data);
  }

  host.innerHTML = _buildHtml(data);
  _renderSchema(host, data);
  _renderTimeline(host, data);
  _renderDetail(host);
  _wireToolbar(host, data);
  _wireBrush(host, data);
}

// ── Layout shell ────────────────────────────────────────────────────────────

function _buildHtml(data) {
  const stats = _computeFilteredStats(data, _storeRef);
  const totalEvents = data.stats.events;
  const totalEntities = data.stats.entities;
  const totalTypes = data.stats.entityTypes;
  const hasActiveFilter = !!_dateFilter || _selection?.kind === "type"
    || _typeVisibility.size !== _defaultVisibleTypes(data).size
    || [..._typeVisibility].some(t => !_defaultVisibleTypes(data).has(t));

  const focusType = _selection?.kind === "type" ? _selection.value : null;
  const focusNode = focusType ? data.typeNodes.find(t => t.id === focusType) : null;

  const focusChip = focusNode
    ? `<span class="v3-chip v3-chip-focus" style="--chip-accent:${_esc(focusNode.color)}">
         <span class="v3-chip-swatch" style="background:${_esc(focusNode.color)}"></span>
         <span class="v3-chip-kind">Focus:</span>
         <span class="v3-chip-val">${_esc(focusNode.label)}</span>
         <button type="button" class="v3-chip-x" data-chip="focus" aria-label="Clear focus">×</button>
       </span>`
    : "";
  const dateChip = _dateFilter
    ? `<span class="v3-chip v3-chip-date">
         <span class="v3-chip-kind">Date:</span>
         <span class="v3-chip-val">${_fmtDate(_dateFilter.t0)} → ${_fmtDate(_dateFilter.t1)}</span>
         <button type="button" class="v3-chip-x" data-chip="date" aria-label="Clear date filter">×</button>
       </span>`
    : "";
  const invalidChip = data.invalidEventCount > 0
    ? `<span class="v3-chip v3-chip-warn" title="Events with invalid timestamps were filtered out at the data layer">
         ⚠ <b>${data.invalidEventCount.toLocaleString()}</b> skipped · invalid timestamps
       </span>`
    : "";

  return `
    <div class="v3-screen">
      <header class="v3-toolbar">
        <div class="v3-toolbar-title">
          <h1 class="v3-title">EKG · Overview</h1>
          <span class="v3-subtitle">
            <span class="v3-stat"><b>${stats.eventCount.toLocaleString()}</b>${stats.eventCount === totalEvents ? "" : ` <span class="v3-stat-total">/ ${totalEvents.toLocaleString()}</span>`} events</span>
            <span class="v3-stat-sep">·</span>
            <span class="v3-stat"><b>${stats.typeCount}</b>${stats.typeCount === totalTypes ? "" : ` <span class="v3-stat-total">/ ${totalTypes}</span>`} types</span>
            <span class="v3-stat-sep">·</span>
            <span class="v3-stat"><b>${stats.entityCount.toLocaleString()}</b>${stats.entityCount === totalEntities ? "" : ` <span class="v3-stat-total">/ ${totalEntities.toLocaleString()}</span>`} entities</span>
          </span>
        </div>
        <div class="v3-toolbar-right">
          ${_typeChipsHtml(data, stats)}
        </div>
        ${(focusChip || dateChip || invalidChip)
          ? `<div class="v3-toolbar-chips">${focusChip}${dateChip}${invalidChip}${hasActiveFilter ? `<button type="button" class="v3-reset" id="v3-reset">Reset filters</button>` : ""}</div>`
          : ""}
      </header>

      <section class="v3-main">
        <div class="v3-panel v3-panel-schema">
          <header class="v3-panel-head">
            <span class="v3-panel-title">Type interactions</span>
            <span class="v3-panel-sub">Force layout · click a type for details</span>
          </header>
          <div class="v3-svg-host" id="v3-schema-host">
            <svg class="v3-svg" id="v3-schema-svg"></svg>
          </div>
          <footer class="v3-panel-foot">
            <span class="v3-legend-row">
              <span class="v3-legend-line v3-legend-line-structural"></span>
              <span>Structural relation</span>
            </span>
            <span class="v3-legend-row">
              <span class="v3-legend-line v3-legend-line-shared"></span>
              <span>Shared events</span>
            </span>
            <span class="v3-legend-row v3-legend-row-mute">
              <span>● size = entity count</span>
            </span>
          </footer>
        </div>

        <div class="v3-panel v3-panel-timeline">
          <header class="v3-panel-head">
            <span class="v3-panel-title">Events over time</span>
            <span class="v3-panel-sub">Drag horizontally to set a date filter</span>
          </header>
          <div class="v3-svg-host" id="v3-timeline-host">
            <svg class="v3-svg" id="v3-timeline-svg"></svg>
          </div>
          <footer class="v3-panel-foot v3-panel-foot-timeline">
            <span class="v3-legend-row v3-legend-row-mute">
              Stacked by type · zero baseline · 48 time bins
            </span>
          </footer>
        </div>
      </section>

      <section class="v3-detail" id="v3-detail"></section>
    </div>
  `;
}

function _typeChipsHtml(data, stats) {
  return `
    <div class="v3-type-filter">
      ${data.typeNodes.map(t => {
        const on = _typeVisibility.has(t.id);
        // Show filtered entity count when a filter is active and the type is visible.
        const total = t.entityCount;
        const filtered = stats?.entitiesByType?.[t.id] ?? (on ? total : 0);
        const countHtml = (on && filtered !== total)
          ? `${filtered.toLocaleString()}<span class="v3-type-pill-total">/${total.toLocaleString()}</span>`
          : total.toLocaleString();
        return `
          <button type="button" class="v3-type-pill${on ? " on" : ""}" data-type="${_esc(t.id)}"
            aria-pressed="${on}" title="${_esc(t.id)} · ${total.toLocaleString()} entities total">
            <span class="v3-type-pill-swatch" style="background:${_esc(t.color)}"></span>
            <span class="v3-type-pill-label">${_esc(t.label)}</span>
            <span class="v3-type-pill-count">${countHtml}</span>
          </button>
        `;
      }).join("")}
    </div>
  `;
}

// ── Interactions data ──────────────────────────────────────────────────────
//
// Recomputed every render — cheap for ~10 types. We compute two adjacency
// counts between every type pair (a,b) where a<b alphabetically:
//   • sharedEventCount  — number of events touching BOTH types, restricted
//                         to the current date filter
//   • structuralCount   — number of entity-to-entity relations between types
//                         (e.g. HAS_ITEM). Not date-filtered: structural
//                         relations have no timestamp.

function _computeInteractions(data) {
  const visible = _typeVisibility;
  const inWindow = e => !_dateFilter || (e.t >= _dateFilter.t0 && e.t <= _dateFilter.t1);
  const pairMap = new Map();
  const ensure = (key) => {
    let entry = pairMap.get(key);
    if (!entry) {
      const [a, b] = key.split("\x00");
      entry = {
        source: a, target: b,
        sharedEventCount: 0,
        structuralCount: 0,
        // Relation types contributing to the structural count, with their
        // tallies. Surfaced verbatim in the edge tooltip (e.g. HAS_ITEM ×12).
        structuralByType: new Map(),
      };
      pairMap.set(key, entry);
    }
    return entry;
  };

  // Shared events (dashed edges)
  (data.spines ?? []).forEach(spine => {
    if (!inWindow(spine)) return;
    const ts = spine.types.filter(t => visible.has(t));
    for (let i = 0; i < ts.length; i++) {
      for (let j = i + 1; j < ts.length; j++) {
        const key = ts[i] < ts[j] ? `${ts[i]}\x00${ts[j]}` : `${ts[j]}\x00${ts[i]}`;
        ensure(key).sharedEventCount += 1;
      }
    }
  });

  // Structural relations (solid edges) — read from the live store. Keep
  // per-relation-type counts so the tooltip can say "HAS_ITEM ×12" instead
  // of just an aggregate "12 relations".
  (_storeRef?.relations ?? []).forEach(rel => {
    const a = rel.source_entity_type;
    const b = rel.target_entity_type;
    if (!a || !b || a === b) return;
    if (!visible.has(a) || !visible.has(b)) return;
    const key = a < b ? `${a}\x00${b}` : `${b}\x00${a}`;
    const entry = ensure(key);
    entry.structuralCount += 1;
    const relType = rel.relation_type || "RELATED";
    entry.structuralByType.set(relType, (entry.structuralByType.get(relType) ?? 0) + 1);
  });

  return [...pairMap.values()];
}

function _filteredTypeNodes(data) {
  return data.typeNodes.filter(t => _typeVisibility.has(t.id));
}

// Walks all valid-dated events once and computes the numbers the toolbar
// stats + type-pill counts display, honouring the three active filters:
//   • _dateFilter        — only events inside the brushed range
//   • _typeVisibility    — only events touching ≥1 visible type
//   • focusType          — only events touching the focused type (when set)
//
// Per-type entity counts are computed from the visible memberships only, so
// a date-filtered "PurchaseOrder" chip says "how many POs were active in
// this window," not "how many exist in the bundle."
function _computeFilteredStats(data, store) {
  const inWindow = t => !_dateFilter || (t >= _dateFilter.t0 && t <= _dateFilter.t1);
  const focusType = _selection?.kind === "type" ? _selection.value : null;

  let eventCount = 0;
  const typesSeen = new Set();
  const allEntities = new Set();
  const entitiesByType = new Map();

  (store?.events ?? []).forEach(event => {
    const t = event.date?.getTime?.();
    if (!Number.isFinite(t)) return;
    if (!inWindow(t)) return;

    // Touched types restricted to visible ones
    const touched = [];
    const allTouched = new Set();
    event.memberships.forEach(m => {
      allTouched.add(m.entity_type);
      if (_typeVisibility.has(m.entity_type)) touched.push(m);
    });
    if (!touched.length) return;
    if (focusType && !allTouched.has(focusType)) return;

    eventCount += 1;
    touched.forEach(m => {
      typesSeen.add(m.entity_type);
      allEntities.add(m.entity_id);
      let set = entitiesByType.get(m.entity_type);
      if (!set) { set = new Set(); entitiesByType.set(m.entity_type, set); }
      set.add(m.entity_id);
    });
  });

  const entitiesByTypeCount = Object.create(null);
  entitiesByType.forEach((set, type) => { entitiesByTypeCount[type] = set.size; });

  return {
    eventCount,
    typeCount: typesSeen.size,
    entityCount: allEntities.size,
    entitiesByType: entitiesByTypeCount,
  };
}

function _filteredEventCount(data) {
  // Kept for callers that only need the event count — delegate to the full
  // stats helper so the same definition is used everywhere.
  return _computeFilteredStats(data, _storeRef).eventCount;
}

// ── Schema panel ───────────────────────────────────────────────────────────

function _renderSchema(host, data) {
  const wrap = host.querySelector("#v3-schema-host");
  const svgEl = host.querySelector("#v3-schema-svg");
  if (!wrap || !svgEl) return;
  const width = Math.max(wrap.clientWidth, 320);
  const height = Math.max(wrap.clientHeight, GEOM.schemaMinH);

  const nodes = _filteredTypeNodes(data).map((t, i) => ({
    id: t.id, label: t.label, role: t.role, color: t.color,
    entityCount: t.entityCount, eventCount: t.eventCount, _i: i,
  }));
  const interactions = _computeInteractions(data);

  if (!nodes.length) {
    svgEl.innerHTML = "";
    return;
  }

  const positions = _layoutForce(nodes, interactions, width, height);
  const byId = Object.fromEntries(positions.map(n => [n.id, n]));

  // Focus type: dim everything not directly connected to it.
  const focusType = _selection?.kind === "type" ? _selection.value : null;

  // Filtered entity counts for the node labels — reflect the active date
  // filter + type visibility so the label changes as the user brushes time.
  const schemaStats = _computeFilteredStats(data, _storeRef);

  svgEl.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svgEl.setAttribute("preserveAspectRatio", "xMidYMid meet");
  const svg = d3.select(svgEl);
  svg.selectAll("*").remove();

  // Edge weights — separate normalisation for the two kinds so neither
  // dominates the other when both are present.
  const maxShared = Math.max(1, ...interactions.map(e => e.sharedEventCount));
  const maxStructural = Math.max(1, ...interactions.map(e => e.structuralCount));

  // Edges layer
  const edgeG = svg.append("g").attr("class", "v3-schema-edges");
  interactions.forEach(edge => {
    const a = byId[edge.source];
    const b = byId[edge.target];
    if (!a || !b) return;
    const dx = b.x - a.x, dy = b.y - a.y;
    const d = Math.max(1, Math.hypot(dx, dy));
    const ux = dx / d, uy = dy / d;
    const x1 = a.x + ux * a.r;
    const y1 = a.y + uy * a.r;
    const x2 = b.x - ux * b.r;
    const y2 = b.y - uy * b.r;
    // Dim edges that don't touch the focused type.
    const edgeActive = !focusType || edge.source === focusType || edge.target === focusType;
    const edgeOpacity = edgeActive ? 1 : 0.1;
    // Draw both lines with a small perpendicular offset so they don't overlap
    if (edge.structuralCount > 0) {
      const off = edge.sharedEventCount > 0 ? 4 : 0;
      const w = 1 + (edge.structuralCount / maxStructural) * 3.5;
      edgeG.append("line")
        .attr("class", "v3-edge v3-edge-structural")
        .attr("x1", x1 - uy * off).attr("y1", y1 + ux * off)
        .attr("x2", x2 - uy * off).attr("y2", y2 + ux * off)
        .attr("stroke", "rgba(15,23,42,0.55)")
        .attr("stroke-width", w)
        .attr("stroke-linecap", "round")
        .attr("opacity", edgeOpacity)
        .style("cursor", "pointer")
        .on("mouseenter", ev => _hoverCallbacks.show?.(_edgeTooltip(edge), ev))
        .on("mouseleave", () => _hoverCallbacks.hide?.());
    }
    if (edge.sharedEventCount > 0) {
      const off = edge.structuralCount > 0 ? -4 : 0;
      const w = 1 + (edge.sharedEventCount / maxShared) * 4.5;
      edgeG.append("line")
        .attr("class", "v3-edge v3-edge-shared")
        .attr("x1", x1 - uy * off).attr("y1", y1 + ux * off)
        .attr("x2", x2 - uy * off).attr("y2", y2 + ux * off)
        .attr("stroke", "rgba(37,99,235,0.55)")
        .attr("stroke-width", w)
        .attr("stroke-dasharray", "5,3")
        .attr("stroke-linecap", "round")
        .attr("opacity", edgeOpacity)
        .style("cursor", "pointer")
        .on("mouseenter", ev => _hoverCallbacks.show?.(_edgeTooltip(edge), ev))
        .on("mouseleave", () => _hoverCallbacks.hide?.());
    }
  });

  // Nodes layer
  const nodeG = svg.append("g").attr("class", "v3-schema-nodes");
  const isSelectedType = id => _selection?.kind === "type" && _selection.value === id;
  positions.forEach(node => {
    // Dim nodes that are not the focused type (when a focus is active).
    const nodeActive = !focusType || node.id === focusType;
    const g = nodeG.append("g")
      .attr("class", `v3-node${isSelectedType(node.id) ? " selected" : ""}`)
      .attr("transform", `translate(${node.x},${node.y})`)
      .attr("opacity", nodeActive ? 1 : 0.2)
      .style("cursor", "pointer")
      .on("click", () => _selectType(node.id))
      .on("mouseenter", ev => _hoverCallbacks.show?.(_nodeTooltip(node), ev))
      .on("mouseleave", () => _hoverCallbacks.hide?.());
    g.append("circle")
      .attr("r", node.r)
      .attr("fill", node.color)
      .attr("fill-opacity", isSelectedType(node.id) ? 0.95 : 0.78)
      .attr("stroke", "#ffffff")
      .attr("stroke-width", 2);
    g.append("text")
      .attr("text-anchor", "middle")
      .attr("dy", "0.34em")
      .attr("font-family", "Inter, system-ui, sans-serif")
      .attr("font-size", "11px")
      .attr("font-weight", "700")
      .attr("fill", "#ffffff")
      .attr("pointer-events", "none")
      .text(_ellipsis(node.label, Math.max(3, Math.floor(node.r / 4))));
    g.append("text")
      .attr("text-anchor", "middle")
      .attr("dy", node.r + 14)
      .attr("font-family", "JetBrains Mono, monospace")
      .attr("font-size", "10px")
      .attr("fill", "#64748b")
      .attr("pointer-events", "none")
      .text(() => {
        const filtered = schemaStats.entitiesByType[node.id];
        if (filtered !== undefined && filtered !== node.entityCount) {
          return `${filtered.toLocaleString()} / ${node.entityCount.toLocaleString()}`;
        }
        return node.entityCount.toLocaleString();
      });
  });
}

// Tiny deterministic force simulation. Same approach as legacy atlasLayout
// but tuned for fewer nodes and a fixed viewport — the goal is "stable",
// not "physically accurate".
function _layoutForce(nodes, edges, w, h) {
  if (!nodes.length) return [];
  const cx = w / 2, cy = h / 2;
  const minDim = Math.min(w, h);
  const maxCount = Math.max(1, ...nodes.map(n => n.entityCount));
  nodes.forEach((n, i) => {
    n.r = 14 + Math.sqrt(n.entityCount / maxCount) * 30;
    const golden = Math.PI * (3 - Math.sqrt(5));
    const radius = (minDim * 0.28) * Math.sqrt(i / Math.max(nodes.length - 1, 1));
    const a = i * golden;
    n.x = cx + radius * Math.cos(a);
    n.y = cy + radius * Math.sin(a);
    n.vx = 0; n.vy = 0;
  });

  const byId = Object.fromEntries(nodes.map(n => [n.id, n]));
  const maxW = Math.max(1, ...edges.map(e => e.sharedEventCount + e.structuralCount * 20));
  let alpha = 1;
  const ITERS = 220;
  for (let iter = 0; iter < ITERS; iter++) {
    // Pairwise repulsion
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        const dx = b.x - a.x, dy = b.y - a.y;
        const d2 = Math.max(0.01, dx * dx + dy * dy);
        const d = Math.sqrt(d2);
        const force = 600 * (a.r + b.r) / d2;
        const fx = (dx / d) * force * alpha;
        const fy = (dy / d) * force * alpha;
        a.vx -= fx; a.vy -= fy;
        b.vx += fx; b.vy += fy;
      }
    }
    // Edge springs
    edges.forEach(edge => {
      const a = byId[edge.source];
      const b = byId[edge.target];
      if (!a || !b) return;
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.max(0.01, Math.hypot(dx, dy));
      const weight = edge.sharedEventCount + edge.structuralCount * 20;
      const norm = weight / maxW;
      const rest = 90 + (1 - norm) * 110;
      const delta = (d - rest) * 0.05 * alpha;
      const fx = (dx / d) * delta;
      const fy = (dy / d) * delta;
      a.vx += fx; a.vy += fy;
      b.vx -= fx; b.vy -= fy;
    });
    // Centre pull
    nodes.forEach(n => {
      n.vx += (cx - n.x) * 0.015 * alpha;
      n.vy += (cy - n.y) * 0.015 * alpha;
    });
    // Integrate + clamp + friction
    nodes.forEach(n => {
      n.vx *= 0.82; n.vy *= 0.82;
      n.x += n.vx; n.y += n.vy;
      const m = 12;
      if (n.x < m + n.r) { n.x = m + n.r; n.vx *= -0.4; }
      if (n.x > w - m - n.r) { n.x = w - m - n.r; n.vx *= -0.4; }
      if (n.y < m + n.r) { n.y = m + n.r; n.vy *= -0.4; }
      if (n.y > h - m - n.r) { n.y = h - m - n.r; n.vy *= -0.4; }
    });
    // Collision
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        const dx = b.x - a.x, dy = b.y - a.y;
        const d = Math.hypot(dx, dy);
        const minD = a.r + b.r + 6;
        if (d > 0 && d < minD) {
          const push = (minD - d) / 2;
          const ux = dx / d, uy = dy / d;
          a.x -= ux * push; a.y -= uy * push;
          b.x += ux * push; b.y += uy * push;
        }
      }
    }
    alpha = Math.max(0.02, alpha - 0.018);
  }
  return nodes;
}

// ── Timeline panel ─────────────────────────────────────────────────────────

function _renderTimeline(host, data) {
  const wrap = host.querySelector("#v3-timeline-host");
  const svgEl = host.querySelector("#v3-timeline-svg");
  if (!wrap || !svgEl) return;
  const width = Math.max(wrap.clientWidth, 480);
  const height = Math.max(wrap.clientHeight, GEOM.timelineMinH);
  const padL = 44, padR = 18, padT = 14, padB = 28;
  const innerW = width - padL - padR;
  const innerH = height - padT - padB;
  const x0 = padL, y0 = padT;

  svgEl.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svgEl.setAttribute("preserveAspectRatio", "xMidYMin meet");
  const svg = d3.select(svgEl);
  svg.selectAll("*").remove();

  const bins = data.bins;
  if (!bins.length) return;
  const span = Math.max(1, data.timeRange.max - data.timeRange.min);
  const xT = t => x0 + ((t - data.timeRange.min) / span) * innerW;

  const visibleTypes = data.bandOrder.filter(t => _typeVisibility.has(t));
  const colorByType = Object.fromEntries(data.typeNodes.map(t => [t.id, t.color]));

  // Focus type — if set, the focused layer gets full alpha, others fade to 0.06.
  const focusType = _selection?.kind === "type" ? _selection.value : null;

  // Stacked totals per bin
  const stackTotals = bins.map(bin => {
    let total = 0;
    visibleTypes.forEach(t => { total += bin.byType[t]?.total ?? 0; });
    return total;
  });
  const maxStack = Math.max(1, ...stackTotals);
  const yV = v => y0 + innerH - (v / maxStack) * innerH;

  // Y-grid (3 ticks)
  const yLayer = svg.append("g").attr("class", "v3-tl-grid");
  [0, 0.5, 1.0].forEach(frac => {
    const yy = y0 + innerH - frac * innerH;
    yLayer.append("line")
      .attr("x1", x0).attr("x2", x0 + innerW)
      .attr("y1", yy).attr("y2", yy)
      .attr("stroke", "rgba(148,163,184,0.18)")
      .attr("stroke-width", 1);
    yLayer.append("text")
      .attr("x", x0 - 6).attr("y", yy + 3)
      .attr("text-anchor", "end")
      .attr("font-family", "JetBrains Mono, monospace")
      .attr("font-size", "9.5px")
      .attr("fill", "#94a3b8")
      .text(Math.round(frac * maxStack).toLocaleString());
  });

  // Stacked areas (one path per type)
  const stackG = svg.append("g").attr("class", "v3-tl-stack");
  const offsets = bins.map(() => 0);
  // Base fill-opacity for each layer. When a focus type is active, focused
  // layer is emphasised (0.82) and all others are faded (0.06) so the
  // selected type's volume profile stands out clearly.
  const baseAlpha = typeId => (focusType && typeId !== focusType) ? 0.06 : 0.62;
  const baseStroke = typeId => (focusType && typeId !== focusType) ? 0.08 : 0.85;
  visibleTypes.forEach(typeId => {
    const top = [];
    const bot = [];
    bins.forEach((bin, i) => {
      const v = bin.byType[typeId]?.total ?? 0;
      const bottom = offsets[i];
      const tval = bottom + v;
      bot.push({ x: xT(bin.t0 + (bin.t1 - bin.t0) / 2), y: yV(bottom) });
      top.push({ x: xT(bin.t0 + (bin.t1 - bin.t0) / 2), y: yV(tval) });
      offsets[i] = tval;
    });
    const path = `M ${top.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" L ")} `
      + `L ${[...bot].reverse().map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" L ")} Z`;
    const fa = baseAlpha(typeId);
    const sa = baseStroke(typeId);
    stackG.append("path")
      .attr("class", "v3-tl-area")
      .attr("data-type", typeId)
      .attr("d", path)
      .attr("fill", colorByType[typeId])
      .attr("fill-opacity", fa)
      .attr("stroke", colorByType[typeId])
      .attr("stroke-opacity", sa)
      .attr("stroke-width", focusType === typeId ? 1.2 : 0.6)
      .style("cursor", "pointer")
      .on("mouseenter", (ev) => {
        // Only apply hover-dim when no persistent focus is set.
        if (!focusType) stackG.selectAll(".v3-tl-area").attr("fill-opacity", 0.12);
        d3.select(ev.currentTarget).attr("fill-opacity", 0.95);
        _hoverCallbacks.show?.(_layerTooltip(typeId, bins, colorByType[typeId]), ev);
      })
      .on("mouseleave", () => {
        stackG.selectAll(".v3-tl-area").each(function() {
          const tid = d3.select(this).attr("data-type");
          d3.select(this).attr("fill-opacity", baseAlpha(tid));
        });
        _hoverCallbacks.hide?.();
      })
      .on("click", () => _selectType(typeId));
  });

  // X-axis ticks (6 evenly spaced)
  const axisG = svg.append("g").attr("class", "v3-tl-axis");
  axisG.append("line")
    .attr("x1", x0).attr("x2", x0 + innerW)
    .attr("y1", y0 + innerH).attr("y2", y0 + innerH)
    .attr("stroke", "rgba(100,116,139,0.4)").attr("stroke-width", 1);
  for (let i = 0; i < 6; i++) {
    const t = data.timeRange.min + (span * i) / 5;
    const xx = xT(t);
    axisG.append("line")
      .attr("x1", xx).attr("x2", xx)
      .attr("y1", y0 + innerH).attr("y2", y0 + innerH + 4)
      .attr("stroke", "rgba(100,116,139,0.55)").attr("stroke-width", 1);
    axisG.append("text")
      .attr("x", xx).attr("y", y0 + innerH + 16)
      .attr("text-anchor", "middle")
      .attr("font-family", "JetBrains Mono, monospace")
      .attr("font-size", "9.5px")
      .attr("fill", "#64748b")
      .text(_fmtAxisDate(t, span));
  }

  // Date-filter selection rectangle (drawn last, sits above areas).
  // Brushable region is the chart body — see _wireBrush for handlers.
  const filterG = svg.append("g").attr("class", "v3-tl-filter");
  if (_dateFilter) {
    const fx0 = xT(_dateFilter.t0);
    const fx1 = xT(_dateFilter.t1);
    // Dim regions outside the filter
    filterG.append("rect")
      .attr("x", x0).attr("y", y0)
      .attr("width", Math.max(0, fx0 - x0)).attr("height", innerH)
      .attr("fill", "rgba(241,245,249,0.7)").attr("pointer-events", "none");
    filterG.append("rect")
      .attr("x", fx1).attr("y", y0)
      .attr("width", Math.max(0, x0 + innerW - fx1)).attr("height", innerH)
      .attr("fill", "rgba(241,245,249,0.7)").attr("pointer-events", "none");
    // Filter range outline
    filterG.append("rect")
      .attr("x", fx0).attr("y", y0)
      .attr("width", Math.max(2, fx1 - fx0)).attr("height", innerH)
      .attr("fill", "none")
      .attr("stroke", "rgba(37,99,235,0.85)")
      .attr("stroke-width", 1.4)
      .attr("stroke-dasharray", "4,3")
      .attr("pointer-events", "none");
  }

  // Stash chart geometry on the SVG element for the brush handler to read
  svgEl.__chart = { x0, y0, innerW, innerH, xT, invertX: x => data.timeRange.min + ((x - x0) / innerW) * span };
}

// ── Bottom detail panel ────────────────────────────────────────────────────

function _renderDetail(host) {
  const el = host.querySelector("#v3-detail");
  if (!el) return;
  if (!_selection) {
    el.innerHTML = `
      <div class="v3-detail-empty">
        <span class="v3-detail-hint">Click a type on the left to see its summary, drill into entities, or open it in Identify (T2) / Explore (T4).</span>
      </div>
    `;
    return;
  }
  if (_selection.kind === "type") {
    el.innerHTML = _typeDetailHtml(_selection.value);
    _wireDetailActions(el);
  }
}

function _typeDetailHtml(typeId) {
  const store = _storeRef;
  const data = _dataRef;
  if (!store || !data) return "";
  const typeNode = data.typeNodes.find(t => t.id === typeId);
  if (!typeNode) return "";

  // Top activities for this type in the current date filter
  const inWindow = (t) => !_dateFilter || (t >= _dateFilter.t0 && t <= _dateFilter.t1);
  const actCounts = {};
  store.events.forEach(e => {
    const ts = e.date?.getTime?.();
    if (!Number.isFinite(ts) || !inWindow(ts)) return;
    if (!e.memberships.some(m => m.entity_type === typeId)) return;
    actCounts[e.activity] = (actCounts[e.activity] ?? 0) + 1;
  });
  const topActs = Object.entries(actCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([activity, count]) => ({ activity, count, color: store.activityColorByName[activity] ?? "#64748b" }));

  // Top entities by event count for this type
  const ids = store.entityIdsByType[typeId] ?? [];
  const topEnts = ids.map(id => {
    const events = (store.eventsByEntityId[id] ?? []).filter(e => inWindow(e.date?.getTime?.()));
    return { id, label: _entityLabel(store.entityById[id]), eventCount: events.length };
  }).sort((a, b) => b.eventCount - a.eventCount).slice(0, 8);

  // Structural neighbours
  const neighbours = new Map();
  (store.relations ?? []).forEach(rel => {
    if (rel.source_entity_type === typeId && rel.target_entity_type !== typeId) {
      neighbours.set(rel.target_entity_type, (neighbours.get(rel.target_entity_type) ?? 0) + 1);
    } else if (rel.target_entity_type === typeId && rel.source_entity_type !== typeId) {
      neighbours.set(rel.source_entity_type, (neighbours.get(rel.source_entity_type) ?? 0) + 1);
    }
  });
  const neighbourArr = [...neighbours.entries()].sort((a, b) => b[1] - a[1]);

  return `
    <div class="v3-detail-block">
      <div class="v3-detail-head">
        <span class="v3-detail-dot" style="background:${_esc(typeNode.color)}"></span>
        <span class="v3-detail-title">${_esc(typeNode.label)}</span>
        <span class="v3-detail-sub">${typeNode.entityCount.toLocaleString()} entities · ${typeNode.eventCount.toLocaleString()} events · role <b>${_esc(typeNode.role)}</b></span>
        <button type="button" class="v3-detail-close" id="v3-detail-close" aria-label="Close">×</button>
      </div>
      <div class="v3-detail-grid">
        <div class="v3-detail-col">
          <div class="v3-detail-h2">Top activities</div>
          ${topActs.length ? `
            <div class="v3-detail-list">
              ${topActs.map(a => `
                <div class="v3-detail-row" data-nav="explore" data-params='${_esc(JSON.stringify({ cluster: `act:${a.activity}` }))}'>
                  <span class="v3-detail-swatch" style="background:${_esc(a.color)}"></span>
                  <span class="v3-detail-row-label">${_esc(a.activity)}</span>
                  <span class="v3-detail-row-meta">${a.count.toLocaleString()}</span>
                </div>
              `).join("")}
            </div>
          ` : `<div class="v3-detail-empty-note">No activities in the current filter.</div>`}
        </div>
        <div class="v3-detail-col">
          <div class="v3-detail-h2">Top entities</div>
          ${topEnts.length ? `
            <div class="v3-detail-list">
              ${topEnts.map(e => `
                <div class="v3-detail-row" data-nav="identify" data-params='${_esc(JSON.stringify({ entity: e.id }))}'>
                  <span class="v3-detail-row-label">${_esc(e.label)}</span>
                  <span class="v3-detail-row-meta">${e.eventCount.toLocaleString()} ev</span>
                </div>
              `).join("")}
            </div>
          ` : `<div class="v3-detail-empty-note">No entities of this type.</div>`}
        </div>
        <div class="v3-detail-col">
          <div class="v3-detail-h2">Structural neighbours</div>
          ${neighbourArr.length ? `
            <div class="v3-detail-list">
              ${neighbourArr.map(([type, count]) => `
                <div class="v3-detail-row" data-select-type="${_esc(type)}">
                  <span class="v3-detail-row-label">${_esc(type)}</span>
                  <span class="v3-detail-row-meta">${count.toLocaleString()} relations</span>
                </div>
              `).join("")}
            </div>
          ` : `<div class="v3-detail-empty-note">No structural relations from this type.</div>`}
        </div>
      </div>
    </div>
  `;
}

function _wireDetailActions(el) {
  el.querySelector("#v3-detail-close")?.addEventListener("click", () => {
    _selection = null;
    const host = document.getElementById("screen-host");
    if (host) {
      _renderSchema(host, _dataRef);
      _renderDetail(host);
    }
  });
  el.querySelectorAll("[data-nav]").forEach(row => {
    row.addEventListener("click", () => {
      const targetRoute = row.dataset.nav;
      const params = row.dataset.params ? JSON.parse(row.dataset.params) : {};
      // Carry active T1 filters into the target view so T4 (Explore) opens
      // with the same date window + focused type already applied.
      if (_dateFilter) {
        params.dateFrom = String(_dateFilter.t0);
        params.dateTo   = String(_dateFilter.t1);
      }
      if (_selection?.kind === "type") {
        params.focusType = _selection.value;
      }
      navigate(targetRoute, params);
    });
  });
  el.querySelectorAll("[data-select-type]").forEach(row => {
    row.addEventListener("click", () => _selectType(row.dataset.selectType));
  });
}

// ── Selection ─────────────────────────────────────────────────────────────

function _selectType(typeId) {
  // Toggle: clicking the already-focused type clears the selection.
  if (_selection?.kind === "type" && _selection.value === typeId) {
    _selection = null;
  } else {
    _selection = { kind: "type", value: typeId };
  }
  // Full rerender so the toolbar stats, focus chip, schema dimming, and
  // timeline emphasis all update in one consistent pass.
  _rerender();
}

// ── Toolbar wiring ─────────────────────────────────────────────────────────

function _wireToolbar(host, data) {
  host.querySelectorAll(".v3-type-pill").forEach(btn => {
    btn.addEventListener("click", () => _toggleType(btn.dataset.type));
  });
  host.querySelectorAll("[data-chip]").forEach(btn => {
    btn.addEventListener("click", () => {
      const kind = btn.dataset.chip;
      if (kind === "date")  { _dateFilter = null; _rerender(); }
      else if (kind === "focus") { _selection = null; _rerender(); }
    });
  });
  host.querySelector("#v3-reset")?.addEventListener("click", () => {
    _dateFilter = null;
    _selection = null;
    _typeVisibility = _defaultVisibleTypes(_dataRef);
    _rerender();
  });
}

function _toggleType(typeId) {
  if (!_dataRef) return;
  const next = new Set(_typeVisibility);
  if (next.has(typeId)) next.delete(typeId);
  else next.add(typeId);
  if (next.size === 0) {
    // Never hide everything — fall back to defaults
    _typeVisibility = _defaultVisibleTypes(_dataRef);
  } else {
    _typeVisibility = next;
  }
  // If selected type was hidden, drop the selection
  if (_selection?.kind === "type" && !_typeVisibility.has(_selection.value)) _selection = null;
  _rerender();
}

function _rerender() {
  const host = document.getElementById("screen-host");
  if (host) renderEkgV3Screen({ data: _dataRef, store: _storeRef, hoverCallbacks: _hoverCallbacks });
}

// ── Brush (date filter on the timeline) ────────────────────────────────────

function _wireBrush(host, data) {
  const svgEl = host.querySelector("#v3-timeline-svg");
  if (!svgEl) return;
  let dragging = null;
  svgEl.addEventListener("pointerdown", (event) => {
    const chart = svgEl.__chart;
    if (!chart) return;
    const px = _svgLocalX(event, svgEl);
    if (px < chart.x0 - 4 || px > chart.x0 + chart.innerW + 4) return;
    dragging = { startPx: px, startT: chart.invertX(px), tempEnd: px };
    svgEl.setPointerCapture?.(event.pointerId);
  });
  svgEl.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    const chart = svgEl.__chart;
    const px = Math.max(chart.x0, Math.min(chart.x0 + chart.innerW, _svgLocalX(event, svgEl)));
    dragging.tempEnd = px;
    _drawProvisional(svgEl, chart, dragging);
  });
  svgEl.addEventListener("pointerup", (event) => {
    if (!dragging) return;
    const chart = svgEl.__chart;
    const px = Math.max(chart.x0, Math.min(chart.x0 + chart.innerW, _svgLocalX(event, svgEl)));
    const t1 = chart.invertX(px);
    const t0 = dragging.startT;
    const lo = Math.min(t0, t1), hi = Math.max(t0, t1);
    // If it was effectively a click (no drag), clear the filter.
    if (Math.abs(px - dragging.startPx) < 3) {
      _dateFilter = null;
    } else {
      _dateFilter = { t0: lo, t1: hi };
    }
    dragging = null;
    _rerender();
  });
  svgEl.addEventListener("pointercancel", () => { dragging = null; });
}

function _drawProvisional(svgEl, chart, dragging) {
  const svg = d3.select(svgEl);
  svg.select(".v3-tl-provisional").remove();
  const lo = Math.min(dragging.startPx, dragging.tempEnd);
  const hi = Math.max(dragging.startPx, dragging.tempEnd);
  svg.append("rect")
    .attr("class", "v3-tl-provisional")
    .attr("x", lo).attr("y", chart.y0)
    .attr("width", hi - lo).attr("height", chart.innerH)
    .attr("fill", "rgba(37,99,235,0.16)")
    .attr("stroke", "rgba(37,99,235,0.7)")
    .attr("stroke-width", 1)
    .attr("pointer-events", "none");
}

function _svgLocalX(event, svgEl) {
  const rect = svgEl.getBoundingClientRect();
  const vb = svgEl.viewBox?.baseVal;
  const scale = vb && vb.width ? vb.width / rect.width : 1;
  return (event.clientX - rect.left) * scale;
}

// ── Helpers ───────────────────────────────────────────────────────────────

function _defaultVisibleTypes(data) {
  const set = new Set();
  data.typeNodes.forEach(t => {
    if (t.role === "resource" || t.role === "attribute") return;
    set.add(t.id);
  });
  if (!set.size) data.typeNodes.forEach(t => set.add(t.id));
  return set;
}

function _entityLabel(entity) {
  if (!entity) return "";
  return entity.properties?.title
    || entity.properties?.vendorName
    || entity.properties?.name
    || entity.properties?.sysId
    || entity.entity_id;
}

function _nodeTooltip(node) {
  return `
    <div class="tip-title" style="color:${node.color}">${_esc(node.label)}</div>
    <div class="tip-row">Role: <b>${_esc(node.role)}</b></div>
    <div class="tip-row">Entities: <b>${node.entityCount.toLocaleString()}</b></div>
    <div class="tip-row">Events: <b>${(node.eventCount ?? 0).toLocaleString()}</b></div>
    <div class="tip-hint">Click to see details below</div>
  `;
}

function _edgeTooltip(edge) {
  const rows = [];
  if (edge.structuralCount > 0) {
    // Surface the actual relation type names — analysts need to know whether
    // the solid edge means HAS_ITEM, OPERATES_ON, etc., not just "structural".
    const byType = [...(edge.structuralByType?.entries?.() ?? [])]
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => `<code>${_esc(name)}</code> ×${count.toLocaleString()}`)
      .join(", ");
    rows.push(`Structural: ${byType || `<b>${edge.structuralCount.toLocaleString()}</b> relations`}`);
  }
  if (edge.sharedEventCount > 0) {
    rows.push(`Shared events: <b>${edge.sharedEventCount.toLocaleString()}</b>`);
  }
  return `
    <div class="tip-title">${_esc(edge.source)} ↔ ${_esc(edge.target)}</div>
    ${rows.map(r => `<div class="tip-row">${r}</div>`).join("")}
  `;
}

function _layerTooltip(typeId, bins, color) {
  const total = bins.reduce((s, b) => s + (b.byType[typeId]?.total ?? 0), 0);
  return `
    <div class="tip-title" style="color:${color}">${_esc(typeId)}</div>
    <div class="tip-row"><b>${total.toLocaleString()}</b> events in view</div>
    <div class="tip-hint">Click to focus this type</div>
  `;
}

function _fmtAxisDate(t, span) {
  const d = new Date(t);
  const DAY = 86400000;
  if (span < 90 * DAY) return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
  if (span < 3 * 365 * DAY) return d.toLocaleDateString("en-GB", { month: "short", year: "2-digit" });
  return d.toLocaleDateString("en-GB", { year: "numeric" });
}

function _fmtDate(t) {
  return new Date(t).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

function _fmtCount(visible, total) {
  if (visible === total) return total.toLocaleString();
  return `${visible.toLocaleString()} / ${total.toLocaleString()}`;
}

function _ellipsis(value, maxChars) {
  const s = String(value ?? "");
  return s.length > maxChars ? s.slice(0, maxChars - 1) + "…" : s;
}

function _esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
