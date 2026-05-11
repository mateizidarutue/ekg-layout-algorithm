"use strict";

import {
  tooltipRows, formatGapHours, ellipsis, rgba,
} from "./shared.js";
import {
  DETAIL_PAD_X, TIMELINE_X0, LANE_MARKER_R,
} from "../layout/detailLayout.js";

export function drawDetailView(layout, lBg, lMeta, lDfPo, lCorr, lRes, lDfItem, lNodes, lLabels, vis, cb) {
  const anchorEntity = layout.anchorEntity;
  const totalWidth = Math.max(layout.totalWidth ?? (layout.axis.x2 + 56), 1120);
  const totalEntities = layout.bands.reduce((sum, band) => sum + band.lanes.length, 0);

  lBg.append("rect")
    .attr("x", 12).attr("y", 12)
    .attr("width", totalWidth - 24)
    .attr("height", Math.max(layout.totalHeight - 20, 240))
    .attr("rx", 22)
    .attr("fill", "rgba(255,255,255,0.78)")
    .attr("stroke", "rgba(148,163,184,0.26)")
    .attr("stroke-width", 1.1);

  lBg.append("rect")
    .attr("x", 18).attr("y", 18)
    .attr("width", totalWidth - 36)
    .attr("height", 74)
    .attr("rx", 18)
    .attr("fill", "rgba(248,250,252,0.82)")
    .attr("stroke", "rgba(203,213,225,0.7)")
    .attr("stroke-width", 1);

  _drawAxis(layout.axis, layout.totalHeight, lBg, lLabels);

  lMeta.selectAll(null).data(layout.anchorRail.filter(anchor => anchor.y < layout.axis.y - 6)).join("line")
    .attr("class", "event-stem")
    .attr("x1", d => d.x).attr("y1", d => d.y + d.r + 2)
    .attr("x2", d => d.x).attr("y2", layout.axis.y - 4)
    .attr("stroke", "rgba(148,163,184,0.32)")
    .attr("stroke-width", 1.1);

  lMeta.selectAll(null).data(layout.sharedEventClusters).join("line")
    .attr("class", "event-stem event-stem-cluster")
    .attr("x1", d => d.x).attr("y1", d => d.y + d.height / 2 + 2)
    .attr("x2", d => d.x).attr("y2", layout.axis.y - 4)
    .attr("stroke", "rgba(37,99,235,0.22)")
    .attr("stroke-width", 1.25)
    .attr("stroke-dasharray", "4 5");

  lMeta.selectAll(null).data(layout.sharedGuides).join("line")
    .attr("class", "shared-guide")
    .attr("x1", d => d.x).attr("y1", d => d.y1).attr("x2", d => d.x).attr("y2", d => d.y2)
    .attr("stroke", "rgba(37,99,235,0.16)")
    .attr("stroke-width", d => Math.min(1.6 + d.entityCount * 0.55, 4.5))
    .attr("stroke-linecap", "round");

  lMeta.selectAll(null).data(layout.relationLinks).join("path")
    .attr("class", "relation-link")
    .attr("data-relation-id", d => d.id)
    .attr("d", d => `M${d.x1},${d.y1} Q${d.cx},${d.cy} ${d.x2},${d.y2}`)
    .attr("fill", "none")
    .attr("stroke", "rgba(180,83,9,0.26)")
    .attr("stroke-width", 1.15)
    .attr("stroke-dasharray", "5 4")
    .on("mousemove", (ev, d) => cb.onTooltipShow(
      `<div class="tip-title">${d.relation_type}</div><div class="tip-row">From: <b>${d.source_entity_id}</b></div><div class="tip-row">To: <b>${d.target_entity_id}</b></div>`,
      ev.offsetX, ev.offsetY
    ))
    .on("mouseleave", cb.onTooltipHide);

  layout.bands.forEach((band, bandIndex) => _drawBand(band, bandIndex, lBg, lMeta, lDfItem, lNodes, lLabels, cb));

  lCorr.selectAll(null).data(layout.corrLinks).join("line")
    .attr("class", "corr-link")
    .attr("data-event-id", d => d.event_id)
    .attr("data-entity-id", d => d.entity_id)
    .attr("x1", d => d.x1).attr("y1", d => d.y1).attr("x2", d => d.x2).attr("y2", d => d.y2)
    .attr("stroke", "rgba(51,65,85,0.18)")
    .attr("stroke-width", 1)
    .attr("stroke-dasharray", "3 5");

  const anchorNodes = lNodes.selectAll(null).data(layout.anchorRail).join("g")
    .attr("class", "event-anchor")
    .attr("data-event-id", d => d.event_id)
    .attr("transform", d => `translate(${d.x},${d.y})`)
    .style("cursor", "pointer")
    .on("click", (ev, d) => {
      ev.stopPropagation();
      cb.onEventSelect?.({
        id: d.event_id,
        sharedEntityIds: d.sharedEntityIds,
      });
    })
    .on("mousemove", (ev, d) => cb.onTooltipShow(_eventTooltip(d), ev.offsetX, ev.offsetY))
    .on("mouseleave", cb.onTooltipHide);

  anchorNodes.append("circle")
    .attr("r", d => d.r + (d.isSharedEvent ? 5 : 3))
    .attr("fill", "rgba(255,255,255,0.96)")
    .attr("stroke", "rgba(100,116,139,0.18)")
    .attr("stroke-width", 1.2)
    .attr("class", "event-anchor-ring");

  anchorNodes.append("circle")
    .attr("r", d => d.r)
    .attr("fill", d => d.activityColor ?? "#64748b")
    .attr("stroke", "rgba(255,255,255,0.92)")
    .attr("stroke-width", 1.2)
    .attr("class", "event-anchor-core");

  _drawLifecycleGlyphs(layout.anchorRail, lNodes);

  const clusterNodes = lNodes.selectAll(null).data(layout.sharedEventClusters).join("g")
    .attr("class", "event-cluster")
    .attr("data-event-ids", d => d.eventIds.join("|"))
    .attr("transform", d => `translate(${d.x},${d.y})`)
    .style("cursor", "pointer")
    .on("click", (ev, d) => {
      ev.stopPropagation();
      cb.onEventSelect?.(d.eventIds.length > 1
        ? {
          kind: "event-cluster",
          clusterId: d.id,
          ids: d.eventIds,
          sharedEntityIds: d.sharedEntityIds,
          activityCounts: d.activityCounts,
        }
        : {
          id: d.representativeEventId,
          sharedEntityIds: d.sharedEntityIds,
        });
    })
    .on("mousemove", (ev, d) => cb.onTooltipShow(_sharedClusterTooltip(d), ev.offsetX, ev.offsetY))
    .on("mouseleave", cb.onTooltipHide);

  clusterNodes.append("rect")
    .attr("x", d => -d.width / 2)
    .attr("y", d => -d.height / 2)
    .attr("width", d => d.width)
    .attr("height", d => d.height)
    .attr("rx", d => Math.min(d.height / 2, 10))
    .attr("fill", "rgba(255,255,255,0.94)")
    .attr("stroke", "rgba(37,99,235,0.28)")
    .attr("stroke-width", 1.2)
    .attr("class", "event-cluster-shell");

  clusterNodes.append("rect")
    .attr("x", d => -d.width / 2 + 3)
    .attr("y", d => -d.height / 2 + 3)
    .attr("width", d => Math.max(d.width - 6, 18))
    .attr("height", d => Math.max(d.height - 6, 14))
    .attr("rx", d => Math.min((d.height - 6) / 2, 8))
    .attr("fill", "rgba(219,234,254,0.9)")
    .attr("stroke", "rgba(96,165,250,0.42)")
    .attr("stroke-width", 1)
    .attr("class", "event-cluster-core");

  clusterNodes.each(function(d) {
    const swatchStartX = -d.width / 2 + 10;
    const swatchGap = 8;
    const g = d3.select(this);
    g.selectAll(".event-cluster-swatch")
      .data(d.activityPalette.map((color, index) => ({
        color,
        x: swatchStartX + index * swatchGap,
      })))
      .join("circle")
      .attr("class", "event-cluster-swatch")
      .attr("cx", item => item.x)
      .attr("cy", 0)
      .attr("r", 2.9)
      .attr("fill", item => item.color)
      .attr("stroke", "rgba(255,255,255,0.9)")
      .attr("stroke-width", 0.8);
  });

  clusterNodes.append("text")
    .attr("x", d => d.width / 2 - 11)
    .attr("y", 0)
    .attr("text-anchor", "end")
    .attr("dy", "0.34em")
    .attr("font-family", "JetBrains Mono, monospace")
    .attr("font-size", "9px")
    .attr("font-weight", "700")
    .attr("fill", "#0f172a")
    .text(d => d.eventCount);

  lLabels.append("text")
    .attr("x", DETAIL_PAD_X).attr("y", 40)
    .attr("font-family", "JetBrains Mono, monospace").attr("font-size", "10px").attr("font-weight", "700")
    .attr("letter-spacing", "0.14em").attr("fill", "var(--text-dim)")
    .text(_detailModeLabel(layout.scope));

  lLabels.append("text")
    .attr("x", DETAIL_PAD_X).attr("y", 64)
    .attr("font-family", "Syne, sans-serif").attr("font-size", "21px").attr("font-weight", "600")
    .attr("fill", "var(--text)")
    .text(`${anchorEntity?.primary_type ?? "Entity"} ${ellipsis(anchorEntity?.entity_id ?? "", 32)}`);

  lLabels.append("text")
    .attr("x", DETAIL_PAD_X).attr("y", 84)
    .attr("font-family", "JetBrains Mono, monospace").attr("font-size", "10px")
    .attr("fill", "var(--text-dim)")
    .text(`${layout.bands.length} types / ${totalEntities} entities / ${layout.anchors.length} events${layout.timeScale?.isClipped ? " / robust time scale" : ""}`);
}

function _detailModeLabel(scope) {
  if (scope === "item-focus") return "BOOK / ITEM FOCUS";
  if (scope === "case-focus") return "MEMBER / CASE FOCUS";
  return "MULTI-ENTITY DETAIL";
}

function _drawAxis(axis, totalHeight, lBg, lLabels) {
  axis.ticks.forEach(tick => {
    lBg.append("line")
      .attr("x1", tick.x).attr("y1", axis.y + 10).attr("x2", tick.x).attr("y2", totalHeight - 24)
      .attr("stroke", "rgba(148,163,184,0.16)").attr("stroke-width", 1).attr("stroke-dasharray", "2 8");
  });

  lBg.append("line")
    .attr("x1", axis.x1).attr("y1", axis.y).attr("x2", axis.x2).attr("y2", axis.y)
    .attr("stroke", "rgba(51,65,85,0.26)").attr("stroke-width", 1.2);

  axis.ticks.forEach(tick => {
    lBg.append("line")
      .attr("x1", tick.x).attr("y1", axis.y - 6).attr("x2", tick.x).attr("y2", axis.y + 6)
      .attr("stroke", "rgba(71,85,105,0.24)").attr("stroke-width", 1);
    lLabels.append("text")
      .attr("x", tick.x).attr("y", axis.y - 12)
      .attr("text-anchor", "middle")
      .attr("font-family", "JetBrains Mono, monospace").attr("font-size", "9px")
      .attr("fill", "var(--text-dim)")
      .text(tick.label);
  });

  lLabels.append("text")
    .attr("x", DETAIL_PAD_X).attr("y", axis.y + 4)
    .attr("font-family", "JetBrains Mono, monospace").attr("font-size", "10px").attr("font-weight", "700")
    .attr("fill", "var(--text-dim)")
    .text("TIMELINE");
}

function _drawBand(band, bandIndex, lBg, lMeta, lDfItem, lNodes, lLabels, cb) {
  const bandColor = _bandColor(band.entityType);

  lBg.append("rect")
    .attr("x", band.x).attr("y", band.y).attr("width", band.width).attr("height", band.height)
    .attr("rx", 18)
    .attr("fill", "rgba(255,255,255,0.84)")
    .attr("stroke", "rgba(148,163,184,0.18)")
    .attr("stroke-width", 1.1);

  lBg.append("rect")
    .attr("x", band.x + 10).attr("y", band.y + 10)
    .attr("width", 5).attr("height", Math.max(band.height - 20, 14))
    .attr("rx", 3)
    .attr("fill", rgba(bandColor, 0.82));

  lBg.append("line")
    .attr("x1", TIMELINE_X0).attr("y1", band.y + BAND_HEADER_BASELINE()).attr("x2", band.x + band.width - 14).attr("y2", band.y + BAND_HEADER_BASELINE())
    .attr("stroke", rgba(bandColor, 0.16)).attr("stroke-width", 1);

  lLabels.append("text")
    .attr("x", DETAIL_PAD_X).attr("y", band.headerY)
    .attr("font-family", "JetBrains Mono, monospace").attr("font-size", "11px").attr("font-weight", "700")
    .attr("fill", bandColor)
    .text(band.entityLabel.toUpperCase());

  lLabels.append("text")
    .attr("x", band.x + band.width - 18).attr("y", band.headerY)
    .attr("text-anchor", "end")
    .attr("font-family", "JetBrains Mono, monospace").attr("font-size", "10px")
    .attr("fill", "var(--text-dim)")
    .text(`${band.lanes.length} lanes`);

  band.lanes.forEach(lane => _drawLane(lane, bandColor, lBg, lMeta, lDfItem, lNodes, lLabels, cb));
}

function _drawLane(lane, bandColor, lBg, lMeta, lDfItem, lNodes, lLabels, cb) {
  const laneClass = "entity-lane";
  const rowFill = "rgba(248,250,252,0.84)";
  const rowStroke = "rgba(148,163,184,0.2)";
  const markerFill = "rgba(255,255,255,0.9)";
  const statusText = `${lane.eventCount} events`;

  lNodes.append("rect")
    .attr("class", laneClass)
    .attr("data-entity-id", lane.entity_id)
    .attr("x", lane.x).attr("y", lane.y - 13).attr("width", lane.width).attr("height", 26)
    .attr("rx", 10).attr("fill", rowFill).attr("stroke", rowStroke).attr("stroke-width", 1)
    .style("cursor", "pointer")
    .on("click", () => cb.onEntitySelect?.(lane.entity_id))
    .on("mousemove", ev => cb.onTooltipShow(_laneTooltip(lane), ev.offsetX, ev.offsetY))
    .on("mouseleave", cb.onTooltipHide);

  lNodes.append("rect")
    .attr("x", lane.x + 8).attr("y", lane.y - 9).attr("width", 4).attr("height", 18).attr("rx", 2)
    .attr("fill", rgba(bandColor, 0.88));

  lLabels.append("text")
    .attr("x", DETAIL_PAD_X + 6).attr("y", lane.y + 3)
    .attr("font-family", "JetBrains Mono, monospace").attr("font-size", "10px").attr("font-weight", "600")
    .attr("fill", bandColor)
    .text(ellipsis(lane.entityLabel, 30));

  lLabels.append("text")
    .attr("x", TIMELINE_X0 - 38).attr("y", lane.y + 3)
    .attr("text-anchor", "end")
    .attr("font-family", "JetBrains Mono, monospace").attr("font-size", "9px")
    .attr("fill", "var(--text-dim)")
    .text(statusText);

  lNodes.append("circle")
    .attr("cx", lane.relationPortX).attr("cy", lane.y).attr("r", 4.8)
    .attr("fill", markerFill).attr("stroke", bandColor).attr("stroke-width", 1.3)
    .style("cursor", "pointer")
    .on("click", ev => {
      ev.stopPropagation();
      cb.onEntitySelect?.(lane.entity_id);
    });

  lDfItem.selectAll(null).data(lane.dfEdges).join("path")
    .attr("class", d => d.isBottleneck ? "df-link df-link-bottleneck" : "df-link")
    .attr("data-edge-id", d => `${lane.entity_id}__${d.source_event_id}__${d.target_event_id}`)
    .attr("data-entity-id", lane.entity_id)
    .attr("data-source-id", d => d.source_event_id)
    .attr("data-target-id", d => d.target_event_id)
    .attr("d", d => `M${d.x1},${d.y1} Q${d.cx},${d.cy} ${d.x2},${d.y2}`)
    .attr("fill", "none")
    .attr("stroke", d => d.isBottleneck ? "#d97706" : bandColor)
    .attr("stroke-width", d => d.isBottleneck ? 2.2 : 1.3)
    .attr("stroke-dasharray", d => d.isBottleneck ? "6 4" : null)
    .style("cursor", "pointer")
    .on("click", (ev, d) => {
      ev.stopPropagation();
      cb.onEdgeSelect?.({
        edgeId: `${lane.entity_id}__${d.source_event_id}__${d.target_event_id}`,
        entityId: lane.entity_id,
        sourceId: d.source_event_id,
        targetId: d.target_event_id,
      });
    })
    .on("mousemove", (ev, d) => cb.onTooltipShow(
      `<div class="tip-title">DF edge</div><div class="tip-row">Entity: <b>${lane.entityLabel}</b></div><div class="tip-row">From: <b>${d.sourceActivity}</b></div><div class="tip-row">To: <b>${d.targetActivity}</b></div><div class="tip-row">Gap: <b>${formatGapHours(d.gapHours)}</b></div><div class="tip-row">Bottleneck: <b>${d.isBottleneck ? "Yes" : "No"}</b></div>`,
      ev.offsetX, ev.offsetY
    ))
    .on("mouseleave", cb.onTooltipHide);

  const markers = lNodes.selectAll(null).data(lane.memberships).join("g")
    .attr("class", "lane-marker")
    .attr("data-event-id", d => d.event_id)
    .attr("data-entity-id", lane.entity_id)
    .attr("transform", d => `translate(${d.x},${d.y})`)
    .style("cursor", "pointer")
    .on("click", (ev, d) => {
      ev.stopPropagation();
      cb.onEventSelect?.({
        id: d.event_id,
        sharedEntityIds: d.anchor?.sharedEntityIds ?? [lane.entity_id],
      });
    })
    .on("mousemove", (ev, d) => cb.onTooltipShow(_membershipTooltip(lane, d.anchor), ev.offsetX, ev.offsetY))
    .on("mouseleave", cb.onTooltipHide);

  markers.append("circle")
    .attr("r", d => (d.anchor?.isSharedEvent ? LANE_MARKER_R + 1.8 : LANE_MARKER_R))
    .attr("fill", d => d.anchor?.activityColor ?? bandColor)
    .attr("stroke", "rgba(255,255,255,0.94)")
    .attr("stroke-width", d => d.anchor?.isSharedEvent ? 1.9 : 1.2)
    .attr("class", "lane-marker-circle");
}

function _eventTooltip(anchor) {
  const timestamp = anchor.date?.toLocaleDateString("en-GB", {
    day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
  }) ?? "n/a";
  const resourceRows = anchor.resource_labels?.length
    ? `<div class="tip-row">Resources: <b>${anchor.resource_labels.join(", ")}</b></div>`
    : "";
  const membershipRows = (anchor.memberships ?? [])
    .map(membership => `<div class="tip-row">${membership.entity_type}: <b>${membership.entity_label}</b></div>`)
    .join("");
  return `<div class="tip-title">${anchor.activity}</div><div class="tip-row">Event: <b>${anchor.event_id}</b></div><div class="tip-row">Time: <b>${timestamp}</b></div><div class="tip-row">Shared: <b>${anchor.sharedEntityIds.length > 1 ? `Yes (${anchor.sharedEntityIds.length})` : "No"}</b></div>${resourceRows}<div class="tip-divider"></div>${membershipRows}`;
}

function _sharedClusterTooltip(cluster) {
  const firstTime = Number.isFinite(cluster.minTime) ? new Date(cluster.minTime) : null;
  const lastTime = Number.isFinite(cluster.maxTime) ? new Date(cluster.maxTime) : null;
  const timeLabel = firstTime && lastTime
    ? (cluster.minTime === cluster.maxTime
      ? firstTime.toLocaleString("en-GB")
      : `${firstTime.toLocaleDateString("en-GB")} - ${lastTime.toLocaleDateString("en-GB")}`)
    : "n/a";
  const topActivities = cluster.activityCounts
    .slice(0, 3)
    .map(item => `${item.activity} (${item.count})`)
    .join(", ");
  const eventPreview = cluster.eventIds.slice(0, 5).join(", ");
  const eventTail = cluster.eventIds.length > 5 ? ` (+${cluster.eventIds.length - 5} more)` : "";
  const filterHint = cluster.activityCounts.length > 1
    ? `<div class="tip-row" style="margin-top:5px;color:var(--accent);font-size:10px">Click to open event-type filters for this cluster</div>`
    : "";
  return `<div class="tip-title">Shared-event cluster</div><div class="tip-row">Events: <b>${cluster.eventCount}</b></div><div class="tip-row">Entities: <b>${cluster.sharedEntityCount}</b></div><div class="tip-row">Entity types: <b>${cluster.entityTypes.join(", ") || "n/a"}</b></div><div class="tip-row">Time span: <b>${timeLabel}</b></div><div class="tip-row">Top activities: <b>${topActivities || "n/a"}</b></div>${filterHint}<div class="tip-divider"></div><div class="tip-row">Event ids: <b>${eventPreview}${eventTail}</b></div>`;
}

function _laneTooltip(lane) {
  const attrs = Object.entries(lane.attrs ?? {})
    .slice(0, 4)
    .map(([key, value]) => [key, value]);
  return `<div class="tip-title">${lane.entityLabel}</div><div class="tip-row">Type: <b>${lane.entityType}</b></div><div class="tip-row">Events: <b>${lane.eventCount}</b></div>${tooltipRows(Object.fromEntries(attrs), attrs.map(([key]) => key))}<div class="tip-row" style="margin-top:5px;color:var(--accent);font-size:10px">Click to focus this entity</div>`;
}

function _membershipTooltip(lane, anchor) {
  if (!anchor) return "";
  return `<div class="tip-title">${anchor.activity}</div><div class="tip-row">Entity: <b>${lane.entityLabel}</b></div><div class="tip-row">Type: <b>${lane.entityType}</b></div><div class="tip-row">Time: <b>${anchor.date?.toLocaleString() ?? "n/a"}</b></div><div class="tip-row">Shared entities: <b>${anchor.sharedEntityIds.join(", ")}</b></div>`;
}

function _drawLifecycleGlyphs(anchorRail, lNodes) {
  if (!anchorRail || anchorRail.length === 0) return;
  const sorted = [...anchorRail].sort((a, b) => a.x - b.x);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];

  const startG = lNodes.append("g")
    .attr("class", "lifecycle-glyph lifecycle-glyph-start")
    .attr("transform", `translate(${first.x},${first.y})`);
  startG.append("circle")
    .attr("r", first.r + 8)
    .attr("fill", "none")
    .attr("stroke", "rgba(34,197,94,0.56)")
    .attr("stroke-width", 1.8)
    .attr("stroke-dasharray", "3 2.5");
  startG.append("text")
    .attr("x", 0).attr("y", first.r + 18)
    .attr("text-anchor", "middle")
    .attr("font-family", "JetBrains Mono, monospace")
    .attr("font-size", "8px").attr("font-weight", "700")
    .attr("letter-spacing", "0.08em")
    .attr("fill", "rgba(22,163,74,0.80)")
    .text("START");

  if (first === last) return;

  const endG = lNodes.append("g")
    .attr("class", "lifecycle-glyph lifecycle-glyph-end")
    .attr("transform", `translate(${last.x},${last.y})`);
  endG.append("circle")
    .attr("r", last.r + 8)
    .attr("fill", "none")
    .attr("stroke", "rgba(239,68,68,0.48)")
    .attr("stroke-width", 1.8)
    .attr("stroke-dasharray", "3 2.5");
  endG.append("text")
    .attr("x", 0).attr("y", last.r + 18)
    .attr("text-anchor", "middle")
    .attr("font-family", "JetBrains Mono, monospace")
    .attr("font-size", "8px").attr("font-weight", "700")
    .attr("letter-spacing", "0.08em")
    .attr("fill", "rgba(220,38,38,0.74)")
    .text("END");
}

function _bandColor(type) {
  let hash = 0;
  const text = String(type ?? "");
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) - hash) + text.charCodeAt(i);
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue} 62% 40%)`;
}

function BAND_HEADER_BASELINE() {
  return 28;
}
