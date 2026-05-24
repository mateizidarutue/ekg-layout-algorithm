"use strict";

// Render the EKG Atlas (the new primary T1 view).
//
// The atlas is drawn as three stacked SVG panels into the supplied root <g>
// layers, mirroring the conventions used by detailRender / overviewRender:
//   - background, edges, nodes, labels are kept in separate <g> children so
//     the existing visibility toggles and selection styling continue to work
//   - tooltips and hover callbacks flow through the same callback bag used by
//     other screens, so cross-panel highlighting is wired in main.js

import { ellipsis } from "./shared.js";

export function drawAtlasView(layout, lBg, lMeta, lNodes, lLabels, callbacks = {}, focus = null) {
  if (!layout?.panels) return;
  const { type, stream, activity } = layout.panels;
  const ctx = _normaliseFocus(focus);
  drawTypePanel(type, lBg, lMeta, lNodes, lLabels, callbacks, ctx);
  drawStreamPanel(stream, lBg, lMeta, lNodes, lLabels, callbacks, ctx);
  drawActivityPanel(activity, lBg, lMeta, lNodes, lLabels, callbacks, ctx);
}

// Resolve a focus descriptor into helper sets the panels can query cheaply.
// Centralised so each panel does the same dimming/highlighting consistently.
function _normaliseFocus(focus) {
  if (!focus || !focus.kind) {
    return { active: false, types: null, activity: null, edgePair: null };
  }
  if (focus.kind === "type") {
    return { active: true, types: new Set([focus.value]), activity: null, edgePair: null };
  }
  if (focus.kind === "activity") {
    return { active: true, types: null, activity: focus.value, edgePair: null };
  }
  if (focus.kind === "edge") {
    const [a, b] = focus.value.split("__");
    return { active: true, types: new Set([a, b]), activity: null, edgePair: { a, b } };
  }
  return { active: false, types: null, activity: null, edgePair: null };
}

function _isTypeFocused(ctx, type) {
  if (!ctx.active) return true;
  if (ctx.types) return ctx.types.has(type);
  return true; // activity focus doesn't dim types
}

function _isActivityFocused(ctx, activity) {
  if (!ctx.active) return true;
  if (ctx.activity) return ctx.activity === activity;
  return true;
}

function _isEdgeFocused(ctx, source, target) {
  if (!ctx.active) return true;
  if (ctx.edgePair) {
    const { a, b } = ctx.edgePair;
    return (source === a && target === b) || (source === b && target === a);
  }
  if (ctx.types) return ctx.types.has(source) && ctx.types.has(target);
  return true;
}

// ── Type Graph panel ────────────────────────────────────────────────────────

function drawTypePanel(panel, lBg, lMeta, lNodes, lLabels, cb, ctx = { active: false }) {
  if (!panel) return;
  // Background card
  lBg.append("rect")
    .attr("class", "atlas-panel-bg")
    .attr("x", panel.x).attr("y", panel.y)
    .attr("width", panel.width).attr("height", panel.height)
    .attr("rx", 14).attr("ry", 14)
    .attr("fill", "rgba(255,255,255,0.72)")
    .attr("stroke", "rgba(148,163,184,0.32)");

  // Header
  lMeta.append("text")
    .attr("class", "atlas-panel-title")
    .attr("x", panel.x + 18).attr("y", panel.y + 22)
    .attr("font-family", "Inter, system-ui, sans-serif")
    .attr("font-size", "13px").attr("font-weight", "700")
    .attr("fill", "#0f172a")
    .text("Entity-type graph");
  lMeta.append("text")
    .attr("class", "atlas-panel-sub")
    .attr("x", panel.x + 158).attr("y", panel.y + 22)
    .attr("font-family", "Inter, system-ui, sans-serif")
    .attr("font-size", "11px").attr("font-weight", "500")
    .attr("fill", "#64748b")
    .text("force-directed · width ∝ shared events · dashed = co-occurrence only");

  // Legend (left column inside the panel)
  if (panel.legend?.length) {
    const legendG = lMeta.append("g")
      .attr("class", "atlas-type-legend")
      .attr("transform", `translate(${panel.legendX + 16}, ${panel.legendY + 8})`);
    panel.legend.forEach((entry, i) => {
      const row = legendG.append("g")
        .attr("transform", `translate(0, ${i * 18})`)
        .attr("class", "atlas-type-legend-row")
        .style("cursor", "pointer")
        .on("click", () => cb.onTypeSelect?.(entry.id))
        .on("mouseenter", (event) => cb.onTooltipShow?.(_typeTooltipHtml(entry), event))
        .on("mouseleave", () => cb.onTooltipHide?.());
      row.append("circle")
        .attr("cx", 6).attr("cy", 7).attr("r", 5)
        .attr("fill", entry.color);
      row.append("text")
        .attr("x", 18).attr("y", 10)
        .attr("font-family", "JetBrains Mono, monospace")
        .attr("font-size", "10.5px")
        .attr("fill", "#1f2937")
        .text(ellipsis(entry.label, 16));
      row.append("text")
        .attr("x", panel.legendW - 24).attr("y", 10)
        .attr("text-anchor", "end")
        .attr("font-family", "JetBrains Mono, monospace")
        .attr("font-size", "10px")
        .attr("fill", "#64748b")
        .text(entry.entityCount.toLocaleString());
    });
  }

  // Edges
  const edgeGroup = lMeta.append("g").attr("class", "atlas-type-edges");
  edgeGroup.selectAll("path").data(panel.edges).enter().append("path")
    .attr("class", d => `atlas-type-edge ${_isEdgeFocused(ctx, d.source, d.target) ? "" : "atlas-dim"}`)
    .attr("d", d => {
      const mx = (d.x1 + d.x2) / 2;
      const my = (d.y1 + d.y2) / 2 - Math.min(40, Math.hypot(d.x2 - d.x1, d.y2 - d.y1) * 0.18);
      return `M${d.x1.toFixed(2)},${d.y1.toFixed(2)} Q${mx.toFixed(2)},${my.toFixed(2)} ${d.x2.toFixed(2)},${d.y2.toFixed(2)}`;
    })
    .attr("fill", "none")
    .attr("stroke", d => d.kind === "structural" ? "rgba(15,23,42,0.55)" : "rgba(37,99,235,0.32)")
    .attr("stroke-width", d => d.width)
    .attr("stroke-dasharray", d => d.kind === "shared" ? "5,4" : null)
    .attr("opacity", d => _isEdgeFocused(ctx, d.source, d.target) ? 0.85 : 0.16)
    .style("cursor", "pointer")
    .on("click", (_event, d) => cb.onEdgeSelect?.(d))
    .on("mouseenter", (event, d) => cb.onTooltipShow?.(_edgeTooltipHtml(d), event))
    .on("mouseleave", () => cb.onTooltipHide?.());

  // Nodes
  const nodeGroup = lNodes.append("g").attr("class", "atlas-type-nodes");
  const node = nodeGroup.selectAll("g").data(panel.nodes).enter().append("g")
    .attr("class", d => `atlas-type-node ${_isTypeFocused(ctx, d.id) ? "" : "atlas-dim"}`)
    .attr("data-type", d => d.id)
    .attr("transform", d => `translate(${d.x},${d.y})`)
    .style("cursor", "pointer")
    .style("opacity", d => _isTypeFocused(ctx, d.id) ? 1 : 0.28)
    .on("click", (_event, d) => cb.onTypeSelect?.(d.id))
    .on("mouseenter", (event, d) => cb.onTooltipShow?.(_typeTooltipHtml(d), event))
    .on("mouseleave", () => cb.onTooltipHide?.());

  node.append("circle")
    .attr("r", d => d.r)
    .attr("fill", d => d.color)
    .attr("fill-opacity", 0.82)
    .attr("stroke", "#ffffff")
    .attr("stroke-width", 2);
  node.append("text")
    .attr("text-anchor", "middle")
    .attr("dy", "0.34em")
    .attr("font-family", "Inter, system-ui, sans-serif")
    .attr("font-size", "10.5px")
    .attr("font-weight", "700")
    .attr("fill", "#ffffff")
    .attr("pointer-events", "none")
    .text(d => ellipsis(d.label, Math.max(3, Math.floor(d.r / 4))));
  node.append("text")
    .attr("text-anchor", "middle")
    .attr("dy", d => d.r + 14)
    .attr("font-family", "JetBrains Mono, monospace")
    .attr("font-size", "9.5px")
    .attr("font-weight", "500")
    .attr("fill", "#475569")
    .attr("pointer-events", "none")
    .text(d => `${d.entityCount.toLocaleString()} · ${d.eventCount.toLocaleString()} ev`);
}

function _typeTooltipHtml(node) {
  return `
    <div class="tip-title" style="color:${node.color}">${_esc(node.label)}</div>
    <div class="tip-row">Role: <b>${_esc(node.role)}</b></div>
    <div class="tip-row">Entities: <b>${node.entityCount.toLocaleString()}</b></div>
    <div class="tip-row">Events: <b>${node.eventCount?.toLocaleString?.() ?? 0}</b></div>
    <div class="tip-hint">Click to filter the Atlas to this type</div>
  `;
}

function _edgeTooltipHtml(edge) {
  const lines = [];
  if (edge.sharedEventCount > 0) lines.push(`Shared events: <b>${edge.sharedEventCount.toLocaleString()}</b>`);
  if (edge.structuralRelationCount > 0) lines.push(`Structural links: <b>${edge.structuralRelationCount.toLocaleString()}</b>`);
  return `
    <div class="tip-title">${_esc(edge.source)} ↔ ${_esc(edge.target)}</div>
    ${lines.map(l => `<div class="tip-row">${l}</div>`).join("")}
    <div class="tip-row" style="margin-top:4px;color:#64748b">${edge.kind === "structural" ? "Structural relation (e.g., HAS_ITEM)" : edge.kind === "both" ? "Structural + shared events" : "Co-occurrence on shared events"}</div>
  `;
}

// ── Stream panel ────────────────────────────────────────────────────────────

function drawStreamPanel(panel, lBg, lMeta, lNodes, lLabels, cb, ctx = { active: false }) {
  if (!panel) return;
  // Card
  lBg.append("rect")
    .attr("class", "atlas-panel-bg")
    .attr("x", panel.x).attr("y", panel.y)
    .attr("width", panel.width).attr("height", panel.height)
    .attr("rx", 14).attr("ry", 14)
    .attr("fill", "rgba(255,255,255,0.72)")
    .attr("stroke", "rgba(148,163,184,0.32)");

  // Header
  lMeta.append("text")
    .attr("class", "atlas-panel-title")
    .attr("x", panel.x + 18).attr("y", panel.y + 22)
    .attr("font-family", "Inter, system-ui, sans-serif")
    .attr("font-size", "13px").attr("font-weight", "700")
    .attr("fill", "#0f172a")
    .text("Temporal density");
  lMeta.append("text")
    .attr("x", panel.x + 158).attr("y", panel.y + 22)
    .attr("font-family", "Inter, system-ui, sans-serif")
    .attr("font-size", "11px").attr("font-weight", "500")
    .attr("fill", "#64748b")
    .text("streamgraph · stack height ∝ events per type · brush to filter");

  if (!panel.layers?.length) {
    lMeta.append("text")
      .attr("x", panel.x + panel.width / 2)
      .attr("y", panel.y + panel.height / 2)
      .attr("text-anchor", "middle")
      .attr("font-family", "Inter, system-ui, sans-serif")
      .attr("font-size", "12px")
      .attr("fill", "#94a3b8")
      .text("No events in current filter");
    return;
  }

  // Axis baseline (midline)
  const midY = panel.chartTop + panel.chartHeight / 2;
  lBg.append("line")
    .attr("class", "atlas-stream-midline")
    .attr("x1", panel.chartLeft).attr("x2", panel.chartRight)
    .attr("y1", midY).attr("y2", midY)
    .attr("stroke", "rgba(148,163,184,0.45)")
    .attr("stroke-dasharray", "2,3")
    .attr("stroke-width", 1);

  // Layers
  const layerGroup = lNodes.append("g").attr("class", "atlas-stream-layers");
  const defaultOpacity = layer => _isTypeFocused(ctx, layer.type) ? (ctx.active ? 0.85 : 0.62) : 0.12;
  layerGroup.selectAll("path").data(panel.layers).enter().append("path")
    .attr("class", d => `atlas-stream-layer ${_isTypeFocused(ctx, d.type) ? "" : "atlas-dim"}`)
    .attr("data-type", d => d.type)
    .attr("d", d => d.path)
    .attr("fill", d => d.color)
    .attr("fill-opacity", d => defaultOpacity(d))
    .attr("stroke", d => d.color)
    .attr("stroke-opacity", d => _isTypeFocused(ctx, d.type) ? 0.85 : 0.2)
    .attr("stroke-width", 0.6)
    .style("cursor", "pointer")
    .on("mouseenter", (event, d) => {
      cb.onTooltipShow?.(_layerTooltipHtml(d), event);
      layerGroup.selectAll(".atlas-stream-layer")
        .attr("fill-opacity", l => l.type === d.type ? 0.88 : 0.18);
    })
    .on("mouseleave", () => {
      cb.onTooltipHide?.();
      layerGroup.selectAll(".atlas-stream-layer").attr("fill-opacity", l => defaultOpacity(l));
    })
    .on("click", (_event, d) => cb.onTypeSelect?.(d.type));

  // Peak labels — only for top 3 layers by overall event count
  const topLayers = [...panel.layers]
    .sort((a, b) => (b.peak?.v ?? 0) - (a.peak?.v ?? 0))
    .slice(0, 3);
  topLayers.forEach(layer => {
    if (!layer.peak) return;
    const text = lLabels.append("text")
      .attr("class", "atlas-stream-peak-label")
      .attr("x", layer.peak.x)
      .attr("y", layer.peak.y - 4)
      .attr("text-anchor", "middle")
      .attr("font-family", "JetBrains Mono, monospace")
      .attr("font-size", "9.5px")
      .attr("font-weight", "700")
      .attr("fill", layer.color)
      .attr("pointer-events", "none")
      .text(ellipsis(layer.label, 14));
    text.clone(true).lower()
      .attr("stroke", "#ffffff")
      .attr("stroke-width", 3)
      .attr("stroke-linejoin", "round")
      .attr("fill", "none");
  });

  // X axis ticks
  const axisG = lMeta.append("g").attr("class", "atlas-stream-axis");
  panel.xTicks.forEach(tick => {
    axisG.append("line")
      .attr("x1", tick.x).attr("x2", tick.x)
      .attr("y1", panel.chartTop + panel.chartHeight)
      .attr("y2", panel.chartTop + panel.chartHeight + 4)
      .attr("stroke", "rgba(100,116,139,0.7)").attr("stroke-width", 1);
    axisG.append("text")
      .attr("x", tick.x)
      .attr("y", panel.chartTop + panel.chartHeight + 16)
      .attr("text-anchor", "middle")
      .attr("font-family", "JetBrains Mono, monospace")
      .attr("font-size", "10px")
      .attr("fill", "#64748b")
      .text(tick.label);
  });
}

function _layerTooltipHtml(layer) {
  return `
    <div class="tip-title" style="color:${layer.color}">${_esc(layer.label)}</div>
    <div class="tip-row">Peak bin events: <b>${layer.peak?.v?.toLocaleString?.() ?? 0}</b></div>
    <div class="tip-hint">Click to filter the Atlas to this type</div>
  `;
}

// ── Activity-flow panel ──────────────────────────────────────────────────────

function drawActivityPanel(panel, lBg, lMeta, lNodes, lLabels, cb, ctx = { active: false }) {
  if (!panel) return;

  // Header
  lMeta.append("text")
    .attr("x", (panel.padLeft ?? 16))
    .attr("y", panel.y + 22)
    .attr("font-family", "Inter, system-ui, sans-serif")
    .attr("font-size", "13px").attr("font-weight", "700")
    .attr("fill", "#0f172a")
    .text("Activity flow per type");
  lMeta.append("text")
    .attr("x", (panel.padLeft ?? 16) + 198)
    .attr("y", panel.y + 22)
    .attr("font-family", "Inter, system-ui, sans-serif")
    .attr("font-size", "11px").attr("font-weight", "500")
    .attr("fill", "#64748b")
    .text("DF arcs within each band · vertical arcs = shared events across types");

  if (panel.empty) {
    lMeta.append("text")
      .attr("x", panel.width / 2).attr("y", panel.y + 56)
      .attr("text-anchor", "middle")
      .attr("font-family", "Inter, system-ui, sans-serif")
      .attr("font-size", "12px")
      .attr("fill", "#94a3b8")
      .text("No activity data in current filter.");
    return;
  }

  // Bands
  panel.bands.forEach(band => {
    const bandFocused = _isTypeFocused(ctx, band.type);
    // Band background row — clickable to focus on this type
    lBg.append("rect")
      .attr("x", (panel.padLeft ?? 16) - 130)
      .attr("y", band.y)
      .attr("width", (panel.innerW ?? 600) + 140)
      .attr("height", band.height ?? 138)
      .attr("rx", 8).attr("ry", 8)
      .attr("fill", bandFocused ? "rgba(241,245,249,0.55)" : "rgba(241,245,249,0.25)")
      .attr("stroke", "rgba(148,163,184,0.22)")
      .style("cursor", "pointer")
      .style("opacity", bandFocused ? 1 : 0.55)
      .on("click", () => cb.onTypeSelect?.(band.type))
      .on("mouseenter", (event) => cb.onTooltipShow?.(`
        <div class="tip-title">${_esc(band.type)}</div>
        <div class="tip-hint">Click to browse all ${_esc(band.type)} entities</div>
      `, event))
      .on("mouseleave", () => cb.onTooltipHide?.());

    // Band label
    lMeta.append("text")
      .attr("x", (panel.padLeft ?? 16) - 116)
      .attr("y", band.cy + 4)
      .attr("font-family", "Inter, system-ui, sans-serif")
      .attr("font-size", "12px").attr("font-weight", "700")
      .attr("fill", "#0f172a")
      .attr("opacity", bandFocused ? 1 : 0.5)
      .text(band.type);

    // DF edges (within band)
    band.edges.forEach(edge => {
      lMeta.append("path")
        .attr("class", "atlas-activity-df")
        .attr("d", `M${edge.x1},${edge.y1} Q${edge.cx},${edge.cy} ${edge.x2},${edge.y2}`)
        .attr("fill", "none")
        .attr("stroke", "rgba(37,99,235,0.38)")
        .attr("stroke-width", edge.sw)
        .attr("stroke-linecap", "round")
        .attr("opacity", bandFocused ? 1 : 0.25);
    });

    // Activity nodes
    const nodesG = lNodes.append("g").attr("class", "atlas-activity-nodes");
    band.nodes.forEach(node => {
      const activityFocused = _isActivityFocused(ctx, node.activity);
      const nodeOpacity = !bandFocused ? 0.22 : activityFocused ? 1 : 0.3;
      const g = nodesG.append("g")
        .attr("transform", `translate(${node.x},${node.y})`)
        .attr("data-activity", node.activity)
        .style("cursor", "pointer")
        .style("opacity", nodeOpacity)
        .on("click", () => cb.onActivitySelect?.(node.activity))
        .on("mouseenter", (event) =>
          cb.onTooltipShow?.(`
            <div class="tip-title">${_esc(node.activity)}</div>
            <div class="tip-row">Events on <b>${_esc(band.type)}</b>: <b>${node.count}</b></div>
            <div class="tip-hint">Click to focus the atlas on this activity</div>
          `, event))
        .on("mouseleave", () => cb.onTooltipHide?.());
      g.append("circle")
        .attr("r", node.r)
        .attr("fill", activityFocused && ctx.active ? "rgba(124,58,237,0.30)" : "rgba(37,99,235,0.18)")
        .attr("stroke", activityFocused && ctx.active ? "rgba(124,58,237,0.85)" : "rgba(37,99,235,0.66)")
        .attr("stroke-width", activityFocused && ctx.active ? 2 : 1.4);
      g.append("text")
        .attr("text-anchor", "middle")
        .attr("dy", "0.34em")
        .attr("font-family", "JetBrains Mono, monospace")
        .attr("font-size", "9.5px")
        .attr("font-weight", "700")
        .attr("fill", "#1e3a8a")
        .text(node.count);
      lLabels.append("text")
        .attr("x", node.x).attr("y", node.y + node.r + 12)
        .attr("text-anchor", "middle")
        .attr("font-family", "Inter, system-ui, sans-serif")
        .attr("font-size", "10px")
        .attr("font-weight", "600")
        .attr("fill", "#334155")
        .attr("opacity", nodeOpacity)
        .text(ellipsis(node.activity, 18));
    });
  });

  // Cross-type sync arcs
  const arcGroup = lMeta.append("g").attr("class", "atlas-activity-sync");
  arcGroup.selectAll("path").data(panel.syncArcs).enter().append("path")
    .attr("class", "atlas-activity-sync-arc")
    .attr("d", d => `M${d.x1},${d.y1} Q${d.cx},${d.cy} ${d.x2},${d.y2}`)
    .attr("fill", "none")
    .attr("stroke", "rgba(124,58,237,0.42)")
    .attr("stroke-width", d => d.sw)
    .attr("stroke-dasharray", "4,3")
    .attr("stroke-linecap", "round")
    .attr("opacity", d => _isEdgeFocused(ctx, d.type1, d.type2) && _isActivityFocused(ctx, d.activity) ? 1 : 0.15)
    .style("cursor", "pointer")
    .on("click", (_event, d) => cb.onSyncSelect?.(d))
    .on("mouseenter", (event, d) => cb.onTooltipShow?.(`
      <div class="tip-title">${_esc(d.activity)}</div>
      <div class="tip-row">Bridges <b>${_esc(d.type1)}</b> ↔ <b>${_esc(d.type2)}</b></div>
      <div class="tip-row">Shared events: <b>${d.count}</b></div>
      <div class="tip-hint">Click to see these shared events</div>
    `, event))
    .on("mouseleave", () => cb.onTooltipHide?.());
}

// ── Utils ────────────────────────────────────────────────────────────────────

function _esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
