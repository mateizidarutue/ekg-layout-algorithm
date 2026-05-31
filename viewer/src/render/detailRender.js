"use strict";

import {
  tooltipRows, formatGapHours, ellipsis, rgba,
} from "./shared.js";
import {
  DETAIL_PAD_X, TIMELINE_X0, LANE_MARKER_R,
} from "../layout/detailLayout.js";

// Lane expansion toggle (the [+]/[−] chip just to the right of the lane's
// colored stripe). Geometry is relative to lane.x so it lands in every
// lane's left margin without colliding with the stripe at lane.x + 8.
const LANE_TOGGLE_CX   = 18; // center, offset from lane.x
const LANE_TOGGLE_SIZE = 12;
const LANE_LABEL_DX    = 32; // label x offset from lane.x (pushed right of the toggle)

// Lane-marker radius. T1/T2/T3 keep the binary channel (shared = enlarged,
// single-type = small). On T4 (explore-cluster) the shared-event size becomes
// a graduated function of synchronization degree so a higher-degree event
// renders larger — a refinement of the binary channel, T4 only.
function _laneMarkerRadius(anchor, scope) {
  if (!anchor?.isSharedEvent) return LANE_MARKER_R;
  if (scope !== "explore-cluster") return LANE_MARKER_R + 1.8;
  const degree = anchor.sharedEntityIds?.length ?? 2;
  return LANE_MARKER_R + 1.0 + Math.min(Math.max(degree - 2, 0), 5) * 0.9;
}

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

  // (removed) Event-stem connectors and stacked anchor dots above the axis:
  // they cluttered the top of the canvas with overlapping circles on dense
  // bundles. Shared events are still indicated by the vertical "spine" lines
  // through the bands plus the small node on the axis line itself.

  // Event spines: one vertical colored line per shared event, axis → lowest correlated lane
  lMeta.selectAll(null).data(layout.sharedGuides).join("line")
    .attr("class", "event-spine")
    .attr("x1", d => d.x).attr("y1", d => d.y1)
    .attr("x2", d => d.x).attr("y2", d => d.y2)
    .attr("stroke", d => d.activityColor)
    .attr("stroke-width", d => Math.min(0.9 + d.entityCount * 0.2, 2.6))
    .attr("stroke-opacity", 0.30)
    .attr("stroke-linecap", "round")
    .style("cursor", "pointer")
    .on("mousemove", (ev, d) => cb.onTooltipShow(_sharedEventTip(d, false), ev))
    .on("mouseleave", cb.onTooltipHide);

  // Small event-node dot on the axis for each spine — clickable to select the shared event
  lMeta.selectAll(null).data(layout.sharedGuides).join("circle")
    .attr("class", "event-spine-node")
    .attr("cx", d => d.x).attr("cy", d => d.y1)
    .attr("r", 4.5)
    .attr("fill", d => d.activityColor)
    .attr("fill-opacity", 0.72)
    .attr("stroke", "rgba(255,255,255,0.88)")
    .attr("stroke-width", 1.2)
    .style("cursor", "pointer")
    .on("click", (ev, d) => {
      ev.stopPropagation();
      cb.onEventSelect?.({ id: d.event_id, sharedEntityIds: d.sharedEntityIds });
    })
    .on("mousemove", (ev, d) => cb.onTooltipShow(_sharedEventTip(d, true), ev))
    .on("mouseleave", cb.onTooltipHide);

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
      ev
    ))
    .on("mouseleave", cb.onTooltipHide);

  layout.bands.forEach((band, bandIndex) => _drawBand(band, bandIndex, lBg, lMeta, lDfItem, lNodes, lLabels, cb, layout.scope));

  // (removed) Anchor rail (stacked event dots above the axis),
  // anchor-to-lane correlation dashed lines, and START/END lifecycle
  // glyphs. The detail view now communicates events solely through the
  // dots on each lane plus the colored vertical spines for shared events.

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
  if (scope === "item-focus")      return "BOOK / ITEM FOCUS";
  if (scope === "case-focus")      return "MEMBER / CASE FOCUS";
  if (scope === "explore-cluster") return "T4 · SHARED-EVENT CLUSTER";
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

function _drawBand(band, bandIndex, lBg, lMeta, lDfItem, lNodes, lLabels, cb, scope) {
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

  // Faint dashed separator between parent-grouped sub-blocks (only set on
  // child bands where lanes have a meaningful parent case id; the parent
  // band itself never has any breaks).
  (band.parentGroupBreaks ?? []).forEach(brk => {
    lBg.append("line")
      .attr("class", "parent-group-break")
      .attr("x1", band.x + 14).attr("x2", band.x + band.width - 14)
      .attr("y1", brk.y).attr("y2", brk.y)
      .attr("stroke", "rgba(100,116,139,0.34)")
      .attr("stroke-width", 1)
      .attr("stroke-dasharray", "4 4");
  });

  band.lanes.forEach(lane => _drawLane(lane, bandColor, lBg, lMeta, lDfItem, lNodes, lLabels, cb, scope));
}

function _drawLane(lane, bandColor, lBg, lMeta, lDfItem, lNodes, lLabels, cb, scope) {
  const laneClass = "entity-lane";
  const rowFill = "rgba(248,250,252,0.84)";
  const rowStroke = "rgba(148,163,184,0.2)";
  const markerFill = "rgba(255,255,255,0.9)";
  const statusText = `${lane.eventCount} events`;
  // Color each lane by its own entity type rather than the band it sits in.
  // In normal bands this equals bandColor, but per-case compare bands mix a
  // case lane with item lanes, so they must be distinguished by type.
  const laneColor = lane.entityType ? _bandColor(lane.entityType) : bandColor;

  lNodes.append("rect")
    .attr("class", laneClass)
    .attr("data-entity-id", lane.entity_id)
    .attr("x", lane.x).attr("y", lane.y - 13).attr("width", lane.width).attr("height", 26)
    .attr("rx", 10).attr("fill", rowFill).attr("stroke", rowStroke).attr("stroke-width", 1)
    .style("cursor", "pointer")
    .on("click", () => cb.onEntitySelect?.(lane.entity_id))
    .on("mousemove", ev => cb.onTooltipShow(_laneTooltip(lane), ev))
    .on("mouseleave", cb.onTooltipHide);

  lNodes.append("rect")
    .attr("x", lane.x + 8).attr("y", lane.y - 9).attr("width", 4).attr("height", 18).attr("rx", 2)
    .attr("fill", rgba(laneColor, 0.88));

  // Expand/collapse toggle for the per-entity details table. Always drawn
  // so analysts can open any lane on demand; the canvas is otherwise
  // unaffected when nothing is expanded.
  const isExpanded = Boolean(lane.expansion?.open);
  const toggleCx = lane.x + LANE_TOGGLE_CX;
  const toggleG = lNodes.append("g")
    .attr("class", "lane-expand-toggle" + (isExpanded ? " lane-expand-toggle-open" : ""))
    .attr("data-entity-id", lane.entity_id)
    .attr("transform", `translate(${toggleCx},${lane.y})`)
    .style("cursor", "pointer")
    .on("click", ev => {
      ev.stopPropagation();
      cb.onLaneExpansionToggle?.(lane.entity_id);
    })
    .on("mousemove", ev => cb.onTooltipShow(
      `<div class="tip-row">${isExpanded ? "Collapse" : "Expand"} event details for <b>${ellipsis(lane.entityLabel, 28)}</b></div>`,
      ev
    ))
    .on("mouseleave", cb.onTooltipHide);
  toggleG.append("rect")
    .attr("x", -LANE_TOGGLE_SIZE / 2).attr("y", -LANE_TOGGLE_SIZE / 2)
    .attr("width", LANE_TOGGLE_SIZE).attr("height", LANE_TOGGLE_SIZE)
    .attr("rx", 3)
    .attr("fill", isExpanded ? rgba(laneColor, 0.18) : "rgba(255,255,255,0.94)")
    .attr("stroke", rgba(laneColor, 0.75))
    .attr("stroke-width", 1.1);
  // Horizontal bar of the +/− glyph.
  toggleG.append("line")
    .attr("x1", -3.2).attr("x2", 3.2).attr("y1", 0).attr("y2", 0)
    .attr("stroke", laneColor).attr("stroke-width", 1.5).attr("stroke-linecap", "round");
  // Vertical bar — drawn only when collapsed, turning the glyph into "+".
  if (!isExpanded) {
    toggleG.append("line")
      .attr("x1", 0).attr("x2", 0).attr("y1", -3.2).attr("y2", 3.2)
      .attr("stroke", laneColor).attr("stroke-width", 1.5).attr("stroke-linecap", "round");
  }

  lLabels.append("text")
    .attr("x", lane.x + LANE_LABEL_DX).attr("y", lane.y + 3)
    .attr("font-family", "JetBrains Mono, monospace").attr("font-size", "10px").attr("font-weight", "600")
    .attr("fill", laneColor)
    .text(ellipsis(lane.entityLabel, 28));

  lLabels.append("text")
    .attr("x", TIMELINE_X0 - 38).attr("y", lane.y + 3)
    .attr("text-anchor", "end")
    .attr("font-family", "JetBrains Mono, monospace").attr("font-size", "9px")
    .attr("fill", "var(--text-dim)")
    .text(statusText);

  lNodes.append("circle")
    .attr("cx", lane.relationPortX).attr("cy", lane.y).attr("r", 4.8)
    .attr("fill", markerFill).attr("stroke", laneColor).attr("stroke-width", 1.3)
    .style("cursor", "pointer")
    .on("click", ev => {
      ev.stopPropagation();
      cb.onEntitySelect?.(lane.entity_id);
    });

  lDfItem.selectAll(null).data(lane.dfEdges.filter(edge => edge.isBottleneck)).join("path")
    .attr("class", "df-link-bottleneck-halo")
    .attr("data-edge-id", d => `${lane.entity_id}__${d.source_event_id}__${d.target_event_id}`)
    .attr("d", d => `M${d.x1},${d.y1} Q${d.cx},${d.cy} ${d.x2},${d.y2}`)
    .attr("fill", "none")
    .attr("stroke", "rgba(217,119,6,0.24)")
    .attr("stroke-width", 8)
    .attr("stroke-linecap", "round")
    .attr("pointer-events", "none");

  lDfItem.selectAll(null).data(lane.dfEdges).join("path")
    .attr("class", d => d.isBottleneck ? "df-link df-link-bottleneck" : "df-link")
    .attr("data-edge-id", d => `${lane.entity_id}__${d.source_event_id}__${d.target_event_id}`)
    .attr("data-entity-id", lane.entity_id)
    .attr("data-source-id", d => d.source_event_id)
    .attr("data-target-id", d => d.target_event_id)
    .attr("d", d => `M${d.x1},${d.y1} Q${d.cx},${d.cy} ${d.x2},${d.y2}`)
    .attr("fill", "none")
    .attr("stroke", d => d.isBottleneck ? "#b45309" : rgba(laneColor, 0.92))
    .attr("stroke-width", d => d.isBottleneck ? 3.6 : 2.2)
    .attr("stroke-dasharray", null)
    .attr("stroke-linecap", "round")
    .attr("stroke-linejoin", "round")
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
      ev
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
    .on("mousemove", (ev, d) => cb.onTooltipShow(_membershipTooltip(lane, d.anchor), ev))
    .on("mouseleave", cb.onTooltipHide);

  markers.append("circle")
    .attr("r", d => _laneMarkerRadius(d.anchor, scope))
    .attr("fill", d => d.anchor?.activityColor ?? laneColor)
    .attr("stroke", "rgba(255,255,255,0.94)")
    .attr("stroke-width", d => d.anchor?.isSharedEvent ? 1.9 : 1.2)
    .attr("class", "lane-marker-circle");

  if (isExpanded) {
    _drawLaneExpansion(lane, laneColor, lNodes, cb);
  }
}

// Renders the per-entity event details table inside a foreignObject so it
// participates in zoom/pan with the rest of the canvas. The layout has
// already reserved vertical space via lane.expansion.tableHeight, so this
// function only fills it.
function _drawLaneExpansion(lane, laneColor, lNodes, cb) {
  const rows = cb.getEntityRows?.(lane.entity_id) ?? [];
  const exp = lane.expansion;
  const fo = lNodes.append("foreignObject")
    .attr("class", "lane-expanded-fo")
    .attr("data-entity-id", lane.entity_id)
    .attr("x", lane.x + 4)
    .attr("y", exp.tableY)
    .attr("width", Math.max(lane.width - 8, 240))
    .attr("height", exp.tableHeight);

  const wrap = fo.append("xhtml:div")
    .attr("class", "lane-expanded-table")
    .style("border-left", `3px solid ${laneColor}`);

  if (!rows.length) {
    wrap.append("xhtml:div")
      .attr("class", "lane-expanded-empty")
      .text("No events in this slice.");
    return;
  }

  const table = wrap.append("xhtml:table");
  const thead = table.append("xhtml:thead").append("xhtml:tr");
  ["Activity", "Timestamp", "Δ to next", "Bottleneck", "Sync", "Correlated entities"]
    .forEach(label => thead.append("xhtml:th").text(label));
  const tbody = table.append("xhtml:tbody");
  rows.forEach(row => {
    const tr = tbody.append("xhtml:tr");
    tr.append("xhtml:td").attr("class", "let-activity").text(row.activity);
    tr.append("xhtml:td").attr("class", "let-time").text(_formatTimestamp(row.date));
    tr.append("xhtml:td")
      .attr("class", "let-gap")
      .text(Number.isFinite(row.dfGapHours) ? _formatHoursCell(row.dfGapHours) : "");
    tr.append("xhtml:td")
      .attr("class", "let-bottleneck" + (row.isBottleneck ? " let-bottleneck-yes" : ""))
      .text(row.dfGapHours == null ? "—" : (row.isBottleneck ? "Yes" : "No"));
    tr.append("xhtml:td").attr("class", "let-sync").text(String(row.syncDegree ?? 0));
    const corrCell = tr.append("xhtml:td").attr("class", "let-corr");
    if (row.syncDegree > 1) {
      row.correlatedEntities.forEach((ent, idx) => {
        if (idx > 0) corrCell.append("xhtml:span").attr("class", "let-corr-sep").text(", ");
        const isSelf = ent.entity_id === lane.entity_id;
        if (isSelf) {
          corrCell.append("xhtml:span")
            .attr("class", "tip-entity-link tip-entity-current")
            .attr("title", "Current entity")
            .text(ent.entity_label);
        } else {
          corrCell.append("xhtml:a")
            .attr("class", "tip-entity-link")
            .attr("href", `#/identify?entity=${encodeURIComponent(ent.entity_id)}`)
            .attr("title", `Open ${ent.entity_label} (${ent.entity_type})`)
            .text(ent.entity_label)
            .on("click", ev => {
              // Same behaviour as the existing hover-link path: navigate
              // straight to T2 focused on the clicked entity.
              ev.preventDefault();
              ev.stopPropagation();
              cb.onEntitySelect?.(ent.entity_id);
            });
        }
      });
    } else {
      corrCell.text("—");
    }
  });
}

function _formatTimestamp(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "n/a";
  return date.toLocaleString("en-GB", {
    day: "2-digit", month: "short", year: "2-digit",
    hour: "2-digit", minute: "2-digit",
  });
}

function _formatHoursCell(hours) {
  if (!Number.isFinite(hours)) return "";
  if (hours < 1)   return `${(hours * 60).toFixed(0)} min`;
  if (hours < 48)  return `${hours.toFixed(1)} h`;
  return `${(hours / 24).toFixed(1)} d`;
}

function _eventTooltip(anchor) {
  const timestamp = anchor.date?.toLocaleDateString("en-GB", {
    day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
  }) ?? "n/a";
  const resourceRows = anchor.resource_labels?.length
    ? `<div class="tip-row">Resources: <b>${anchor.resource_labels.join(", ")}</b></div>`
    : "";
  const memberSection = _renderCorrelatedEntities(anchor, null);
  return `<div class="tip-title">${anchor.activity}</div>
    <div class="tip-row">Event: <b>${anchor.event_id}</b></div>
    <div class="tip-row">Time: <b>${timestamp}</b></div>
    ${resourceRows}
    ${memberSection}`;
}

function _laneTooltip(lane) {
  const attrs = Object.entries(lane.attrs ?? {})
    .slice(0, 4)
    .map(([key, value]) => [key, value]);
  return `<div class="tip-title">${lane.entityLabel}</div><div class="tip-row">Type: <b>${lane.entityType}</b></div><div class="tip-row">Events: <b>${lane.eventCount}</b></div>${tooltipRows(Object.fromEntries(attrs), attrs.map(([key]) => key))}<div class="tip-row" style="margin-top:5px;color:var(--accent);font-size:10px">Click to focus this entity</div>`;
}

function _membershipTooltip(lane, anchor) {
  if (!anchor) return "";
  const timestamp = anchor.date?.toLocaleString() ?? "n/a";
  const memberSection = _renderCorrelatedEntities(anchor, lane.entity_id);
  return `<div class="tip-title">${anchor.activity}</div>
    <div class="tip-row">Entity: <b>${lane.entityLabel}</b></div>
    <div class="tip-row">Type: <b>${lane.entityType}</b></div>
    <div class="tip-row">Time: <b>${timestamp}</b></div>
    ${memberSection}`;
}

// Builds the clickable "Correlated entities" section used in both the
// per-lane and per-anchor tooltips. Groups by entity_type; entities that
// are visible in the current view are rendered as primary links, those
// outside it as faint links with an "open in new view" hint. The active
// lane's own entity is rendered in a "current" style with no link.
function _renderCorrelatedEntities(anchor, currentEntityId) {
  const visibleMembers = anchor.memberships ?? [];
  // rawMemberships is the unfiltered list from the underlying event(s).
  // Fall back to visibleMembers if missing (e.g., older code paths).
  const allMembers = anchor.rawMemberships?.length ? anchor.rawMemberships : visibleMembers;
  if (!allMembers.length) return "";
  const visibleIds = new Set(visibleMembers.map(m => m.entity_id));

  // Group by entity_type, preserving insertion order.
  const byType = new Map();
  allMembers.forEach(m => {
    if (!byType.has(m.entity_type)) byType.set(m.entity_type, []);
    byType.get(m.entity_type).push(m);
  });

  const groupRows = [...byType.entries()].map(([type, members]) => {
    const links = members.map(m => {
      const label = m.entity_label ?? m.entity_id;
      const isCurrent = m.entity_id === currentEntityId;
      const inView = visibleIds.has(m.entity_id);
      if (isCurrent) {
        return `<span class="tip-entity-link tip-entity-current" title="Current entity"
          >${_esc(label)}<span class="tip-entity-badge">current</span></span>`;
      }
      const cls = inView ? "tip-entity-link" : "tip-entity-link tip-entity-clipped";
      const title = inView
        ? "Click to open this entity's lifecycle"
        : "Not in current view — click to open its lifecycle";
      return `<a class="${cls}" data-tip-entity-id="${_escAttr(m.entity_id)}"
        title="${_escAttr(title)}" href="#/identify?entity=${encodeURIComponent(m.entity_id)}"
        >${_esc(label)}</a>`;
    }).join("");
    return `<div class="tip-entity-group">
      <div class="tip-entity-group-head">${_esc(type)} · ${members.length}</div>
      <div class="tip-entity-group-list">${links}</div>
    </div>`;
  }).join("");

  const total = allMembers.length;
  const visible = visibleMembers.length;
  const summary = total === 1
    ? `1 correlated entity`
    : `${total} correlated entities${total !== visible ? ` (${visible} visible in this view)` : ""}`;

  return `<div class="tip-divider"></div>
    <div class="tip-subtitle">Correlated entities</div>
    <div class="tip-row tip-row-muted">${summary}</div>
    ${groupRows}
    <div class="tip-row tip-hint">Click any entity to open its lifecycle</div>`;
}

function _esc(v) {
  return String(v ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
function _escAttr(v) {
  return _esc(v).replaceAll('"', "&quot;");
}

// Tooltip for event-spine lines and their axis dots.
// Shows the true entity count from the raw data (totalEntityCount), the entity
// types involved, and — when the view clips some of those entities — a note
// of how many are visible in the current graph.
function _sharedEventTip(d, clickable) {
  const total = d.totalEntityCount ?? d.entityCount;
  const inView = d.entityCount;
  // Entity types participating — use totalEntityTypes (all types in raw data) when
  // available; fall back to sharedEntityTypes (view-filtered) so something always shows.
  const types = (d.totalEntityTypes?.length ? d.totalEntityTypes : d.sharedEntityTypes) ?? [];
  const typesLabel = types.length
    ? `<div class="tip-row" style="margin-top:2px">Types: <b>${types.join(' · ')}</b></div>`
    : "";
  const clippedNote = total > inView
    ? `<div class="tip-row" style="color:#94a3b8;font-size:10px">${inView} of ${total} entities are visible in this view</div>`
    : "";
  const hint = clickable
    ? `<div class="tip-row" style="margin-top:4px;color:var(--accent);font-size:10px">Click to highlight all correlated lanes</div>`
    : `<div class="tip-row" style="margin-top:4px;color:var(--accent);font-size:10px">One event — multiple CORR edges</div>`;
  return `
    <div class="tip-title">${d.activity}</div>
    <div class="tip-row">Shared event — correlated to <b>×${total}</b> entities</div>
    ${typesLabel}${clippedNote}${hint}
  `;
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
