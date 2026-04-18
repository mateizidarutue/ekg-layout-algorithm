"use strict";

import {
  tooltipRows, drawChipList, buildChips, hasResourceValue,
  syncContextRows, compactGapLabel, formatGapHours, suffix, eventRadius,
} from "./shared.js";
import { PO_COLOR, PO_R, ITEM_R, EVENT_R, PO_X, ITEM_X, TIMELINE_X0, ITEM_COLORS } from "../layout/detailLayout.js";

export function drawBlock(block, lBg, lDfPo, lCorr, lRes, lDfItem, lNodes, lLabels, vis, cb, svgW, labels = {}) {
  const caseType = labels.caseType ?? "Case";
  const caseBadge = labels.caseBadge ?? caseType.slice(0, 2).toUpperCase();
  const itemType = labels.itemType ?? "Item";
  const { po, poMidY, startY, totalHeight, itemRows, dfPoEdges, poAttrs, isOverview, contentMaxX } = block;
  const W = svgW();
  const blockRightX = Math.max(W - 12, (contentMaxX ?? 0) + 24);

  const blockCard = lBg.append("rect")
    .attr("x", 12).attr("y", startY + 4).attr("width", blockRightX - 12).attr("height", totalHeight - 8)
    .attr("fill", "rgba(37,99,235,0.04)").attr("stroke", "rgba(37,99,235,0.14)").attr("stroke-width", 1).attr("rx", 10);

  if (isOverview) {
    blockCard.style("cursor", "pointer").on("click", () => cb.onPoSelect?.(po));
  } else {
    lBg.append("line")
      .attr("x1", ITEM_X).attr("y1", startY + 24).attr("x2", ITEM_X).attr("y2", startY + totalHeight - 16)
      .attr("stroke", "rgba(34,48,71,0.12)").attr("stroke-width", 1);
  }

  const poG = lNodes.append("g").attr("transform", `translate(${PO_X},${poMidY})`).style("cursor", "pointer");
  poG.append("circle").attr("r", PO_R + 5).attr("fill", "rgba(37,99,235,0.08)").attr("stroke", "none");
  poG.append("circle").attr("r", PO_R).attr("fill", "rgba(37,99,235,0.16)").attr("stroke", PO_COLOR).attr("stroke-width", 2);
  poG.append("text").attr("text-anchor", "middle").attr("dy", "-0.15em").attr("font-family", "JetBrains Mono, monospace").attr("font-size", "8px").attr("font-weight", "600").attr("fill", PO_COLOR).attr("pointer-events", "none").text(caseBadge);
  poG.append("text").attr("text-anchor", "middle").attr("dy", "1em").attr("font-family", "JetBrains Mono, monospace").attr("font-size", "7px").attr("fill", PO_COLOR).attr("opacity", 0.6).attr("pointer-events", "none").text(po.slice(-6));
  poG.on("mousemove", ev => cb.onTooltipShow(
    `<div class="tip-title">${caseType} ${po}</div><div class="tip-row">Items: <b>${block.meta?.totalItems ?? block.items.length}</b></div><div class="tip-row">Total events: <b>${block.meta?.totalEvents ?? "—"}</b></div>${isOverview ? `<div class="tip-row" style="margin-top:5px;color:var(--col-po);font-size:10px">Click to focus this ${caseType}</div>` : ""}${tooltipRows(poAttrs, ["Vendor", "Company", "Document_Type", "Source"])}`,
    ev.offsetX, ev.offsetY
  )).on("mouseleave", cb.onTooltipHide).on("click", () => cb.onPoSelect?.(po));

  if (isOverview) { _drawOverviewBlock(block, lBg, lCorr, lNodes, lLabels, cb, svgW); return; }

  lDfPo.selectAll(null).data(dfPoEdges).join("path").attr("class", "edge-dfpo")
    .attr("d", d => `M${d.x1},${d.y1} Q${d.cx},${d.cy} ${d.x2},${d.y2}`)
    .attr("fill", "none").attr("stroke", PO_COLOR).attr("stroke-width", 1.2).attr("stroke-dasharray", "5 3").attr("marker-end", "url(#arr-dfpo)");

  itemRows.forEach(row => drawItemRow(row, lBg, lCorr, lRes, lDfItem, lNodes, lLabels, vis, cb, svgW, labels));
}

function _drawOverviewBlock(block, lBg, lCorr, lNodes, lLabels, cb, svgW) {
  const { po, poMidY, overview } = block;
  const { corrEdge, summaryNode, timeline, firstDate, lastDate, dateRange, previewItems, hiddenItemCount, shownItems, totalItems, filteredEvents, totalEvents } = overview;

  lCorr.append("line").attr("class", "edge-corr")
    .attr("x1", corrEdge.x1).attr("y1", corrEdge.y1).attr("x2", corrEdge.x2).attr("y2", corrEdge.y2)
    .attr("stroke", PO_COLOR).attr("stroke-width", 1).attr("stroke-dasharray", "3 4").attr("opacity", 0.22);

  lNodes.append("rect")
    .attr("x", ITEM_X - ITEM_R - 8).attr("y", poMidY - 24).attr("width", svgW() - ITEM_X + ITEM_R - 12).attr("height", 48)
    .attr("fill", "rgba(37,99,235,0.03)").attr("stroke", "rgba(37,99,235,0.10)").attr("stroke-width", 0.8).attr("rx", 12)
    .style("cursor", "pointer").on("click", () => cb.onPoSelect?.(po));

  const summaryG = lNodes.append("g").attr("transform", `translate(${summaryNode.x},${summaryNode.y})`).style("cursor", "pointer")
    .on("click", () => cb.onPoSelect?.(po))
    .on("mousemove", ev => cb.onTooltipShow(`<div class="tip-title">Overview cluster</div><div class="tip-row">Visible items: <b>${shownItems}</b></div><div class="tip-row">Total items: <b>${totalItems}</b></div><div class="tip-row">Visible events: <b>${filteredEvents}</b></div><div class="tip-row">Date span: <b>${dateRange}</b></div><div class="tip-row" style="margin-top:5px;color:var(--col-po);font-size:10px">Click to open detailed layout</div>`, ev.offsetX, ev.offsetY))
    .on("mouseleave", cb.onTooltipHide);
  summaryG.append("circle").attr("r", summaryNode.r + 5).attr("fill", "rgba(37,99,235,0.08)").attr("stroke", "none");
  summaryG.append("circle").attr("r", summaryNode.r).attr("fill", "rgba(37,99,235,0.12)").attr("stroke", PO_COLOR).attr("stroke-width", 1.6);
  summaryG.append("text").attr("text-anchor", "middle").attr("dy", "0.35em").attr("font-family", "JetBrains Mono, monospace").attr("font-size", "12px").attr("font-weight", "700").attr("fill", PO_COLOR).text("S");

  lBg.append("rect").attr("x", timeline.x1 - 18).attr("y", timeline.y - 16).attr("width", Math.max(timeline.x2 - timeline.x1 + 36, 56)).attr("height", 32).attr("rx", 16).attr("fill", "rgba(255,255,255,0.50)").attr("stroke", "rgba(37,99,235,0.10)").attr("stroke-width", 0.8);
  lNodes.append("line").attr("x1", summaryNode.x + summaryNode.r + 12).attr("y1", timeline.y).attr("x2", timeline.x2).attr("y2", timeline.y).attr("stroke", PO_COLOR).attr("stroke-width", 1.1).attr("opacity", 0.16);

  lLabels.append("text").attr("x", ITEM_X + ITEM_R + 14).attr("y", poMidY - 7).attr("font-family", "JetBrains Mono, monospace").attr("font-size", "11px").attr("font-weight", "600").attr("fill", PO_COLOR).text(`${shownItems} / ${totalItems} items`);
  lLabels.append("text").attr("x", ITEM_X + ITEM_R + 14).attr("y", poMidY + 10).attr("font-family", "JetBrains Mono, monospace").attr("font-size", "9px").attr("fill", "var(--text-dim)").text(`${filteredEvents} / ${totalEvents} ev · ${dateRange}`);
}

export function drawItemRow(row, lBg, lCorr, lRes, lDfItem, lNodes, lLabels, vis, cb, svgW, labels = {}) {
  const itemType = labels.itemType ?? "Item";
  const { item, midY, rowY, h, color, isExp, corrEdge, timelineNodes, dfItemEdges, resourceNodes, resourceLinks, itemAttrs, evCount, dateRange, laneX2, followsDominant, syncEventCount, showSyncOnly } = row;
  const laneFill = followsDominant ? (isExp ? `${color}12` : "transparent") : (isExp ? "rgba(217,119,6,0.10)" : "rgba(217,119,6,0.04)");
  const laneStroke = followsDominant ? (isExp ? `${color}40` : "transparent") : (isExp ? "rgba(217,119,6,0.24)" : "rgba(217,119,6,0.16)");
  const laneHoverFill = followsDominant ? `${color}08` : "rgba(217,119,6,0.08)";
  const laneHoverStroke = followsDominant ? `${color}30` : "rgba(217,119,6,0.22)";
  const laneLabel = `Item ${suffix(item)}${followsDominant ? "" : " ≠ "}`;

  lCorr.append("line").attr("class", "edge-corr")
    .attr("x1", corrEdge.x1).attr("y1", corrEdge.y1).attr("x2", corrEdge.x2).attr("y2", corrEdge.y2)
    .attr("stroke", color).attr("stroke-width", 1).attr("stroke-dasharray", "3 4").attr("opacity", 0.3);

  const laneX1 = ITEM_X - ITEM_R - 8;
  const laneRightX = Math.max(svgW() - 12, (laneX2 ?? ITEM_X + ITEM_R + 180) + 18);
  lNodes.append("rect")
    .attr("x", laneX1).attr("y", rowY + 6).attr("width", laneRightX - laneX1).attr("height", h - 12)
    .attr("fill", laneFill).attr("stroke", laneStroke).attr("stroke-width", 0.8).attr("rx", 8)
    .attr("class", followsDominant ? "item-lane" : "item-lane item-lane-deviant").attr("data-entity-id", item).style("cursor", "pointer")
    .on("click", () => cb.onItemExpand(item))
    .on("mouseover", function() { if (!isExp) d3.select(this).attr("fill", laneHoverFill).attr("stroke", laneHoverStroke); })
    .on("mouseout", function() { if (!isExp) d3.select(this).attr("fill", laneFill).attr("stroke", laneStroke); });

  const itemG = lNodes.append("g").attr("transform", `translate(${ITEM_X},${midY})`).style("cursor", "pointer")
    .on("click", () => cb.onItemExpand(item))
    .on("mousemove", ev => cb.onTooltipShow(
      `<div class="tip-title">${item}</div><div class="tip-row">Type: <b>${itemType}</b></div><div class="tip-row">Events: <b>${evCount}</b></div><div class="tip-row">Sync events: <b>${syncEventCount ?? 0}</b></div><div class="tip-row">Range: <b>${dateRange}</b></div><div class="tip-row">Dominant pattern: <b>${followsDominant ? "Yes" : "No"}</b></div>${tooltipRows(itemAttrs, ["Item_Type", "Item_Category", "Goods_Receipt", "GR_Based_Inv_Verif"])}<div class="tip-row" style="margin-top:5px;color:var(--col-po);font-size:10px">${isExp ? "▲ Click to collapse" : "▼ Click to expand timeline"}</div>`,
      ev.offsetX, ev.offsetY
    ))
    .on("mouseleave", cb.onTooltipHide);

  if (isExp) itemG.append("circle").attr("r", ITEM_R + 6).attr("fill", `${color}0a`).attr("stroke", `${color}25`).attr("stroke-width", 1);
  itemG.append("circle").attr("r", ITEM_R).attr("fill", `${color}1a`).attr("stroke", color).attr("stroke-width", isExp ? 2.5 : 1.5);
  itemG.append("text").attr("text-anchor", "middle").attr("dy", "0.35em").attr("font-family", "JetBrains Mono, monospace").attr("font-size", "10px").attr("fill", color).attr("pointer-events", "none").text(isExp ? "▾" : "+");

  if (!isExp) {
    lLabels.append("text").attr("x", ITEM_X + ITEM_R + 12).attr("y", midY - 6).attr("font-family", "JetBrains Mono, monospace").attr("font-size", "11px").attr("font-weight", "600").attr("fill", color).text(laneLabel);
    lLabels.append("text").attr("x", ITEM_X + ITEM_R + 12).attr("y", midY + 9).attr("font-family", "JetBrains Mono, monospace").attr("font-size", "9px").attr("fill", "var(--text-dim)").text(syncEventCount ? `${evCount} events · ${syncEventCount} sync · ${dateRange}` : `${evCount} events · ${dateRange}`);
  } else {
    lLabels.append("text").attr("x", ITEM_X).attr("y", rowY + 13).attr("text-anchor", "middle").attr("font-family", "JetBrains Mono, monospace").attr("font-size", "8px").attr("fill", color).attr("opacity", 0.65).text(laneLabel);
    lLabels.append("text").attr("x", ITEM_X + ITEM_R + 14).attr("y", rowY + 18).attr("font-family", "JetBrains Mono, monospace").attr("font-size", "9px").attr("fill", "var(--text-dim)")
      .text(showSyncOnly ? `${syncEventCount ?? 0} sync · ${dateRange}` : (syncEventCount ? `${evCount} ev · ${syncEventCount} sync · ${dateRange}` : `${evCount} ev · ${dateRange}`));
    drawChipList(lLabels, buildChips(itemAttrs, [["Item_Type", "Type"], ["Goods_Receipt", "GR"]]), ITEM_X + ITEM_R + 14, rowY + 24);
  }

  if (!isExp || timelineNodes.length === 0) return;

  const firstX = timelineNodes[0].x, lastX = timelineNodes.at(-1).x;
  const bottleneckEdges = dfItemEdges.filter(d => d.isBottleneck);

  lNodes.append("line").attr("x1", firstX - 12).attr("y1", midY).attr("x2", lastX + 12).attr("y2", midY).attr("stroke", color).attr("stroke-width", 0.5).attr("opacity", 0.18);
  lBg.append("rect").attr("x", firstX - 20).attr("y", midY - 18).attr("width", Math.max(lastX - firstX + 40, 56)).attr("height", 36).attr("rx", 18).attr("fill", "rgba(255,255,255,0.52)").attr("stroke", `${color}18`).attr("stroke-width", 0.8);
  lNodes.append("line").attr("x1", ITEM_X + ITEM_R + 4).attr("y1", midY).attr("x2", firstX - EVENT_R - 3).attr("y2", midY).attr("stroke", color).attr("stroke-width", 0.8).attr("stroke-dasharray", "3 3").attr("opacity", 0.4);

  if (bottleneckEdges.length && vis.bottleneck) {
    const ovGroup = lBg.append("g").attr("class", "bottleneck-overlay-group");
    ovGroup.selectAll(null).data(bottleneckEdges).join("rect").attr("class", "bottleneck-overlay")
      .attr("x", d => Math.min(d.x1, d.x2) - 8).attr("y", midY - 13)
      .attr("width", d => Math.max(Math.abs(d.x2 - d.x1) + 16, 32)).attr("height", 26).attr("rx", 13)
      .attr("fill", "rgba(217,119,6,0.10)").attr("stroke", "rgba(217,119,6,0.26)").attr("stroke-width", 1.1).attr("pointer-events", "none");
  }

  lDfItem.selectAll(null).data(dfItemEdges).join("path")
    .attr("class", d => d.isBottleneck ? "edge-dfitem edge-dfitem-bottleneck" : "edge-dfitem")
    .attr("data-edge-id", d => d.id).attr("data-entity-id", d => d.entityId)
    .attr("data-source-id", d => d.sourceId).attr("data-target-id", d => d.targetId)
    .attr("d", d => {
      if (d.type === "arc") { const r = 16; return `M${d.x1},${d.y1} C${d.x1 + r},${d.y1 - r} ${d.x2 + r},${d.y2 - r} ${d.x2},${d.y2}`; }
      return `M${d.x1},${d.y1} L${d.x2},${d.y2}`;
    })
    .attr("fill", "none").attr("stroke", d => d.isBottleneck ? "#d97706" : d.color)
    .attr("stroke-width", d => d.isBottleneck ? 2.6 : 1.5).attr("stroke-dasharray", d => d.isBottleneck ? "6 4" : null)
    .attr("marker-end", d => d.isBottleneck ? "url(#arr-dfitem-bottleneck)" : "url(#arr-dfitem)").style("cursor", "pointer")
    .on("mousemove", (ev, d) => cb.onTooltipShow(`<div class="tip-title">DF edge</div><div class="tip-row">From: <b>${d.sourceActivity}</b></div><div class="tip-row">To: <b>${d.targetActivity}</b></div><div class="tip-row">Gap: <b>${formatGapHours(d.gapHours)}</b></div><div class="tip-row">Bottleneck: <b>${d.isBottleneck ? "Yes" : "No"}</b></div>`, ev.offsetX, ev.offsetY))
    .on("click", (ev, d) => { ev.stopPropagation(); cb.onEdgeSelect?.(d); })
    .on("mouseleave", cb.onTooltipHide);

  if (bottleneckEdges.length && vis.bottleneck) {
    const badgeGroup = lLabels.append("g").attr("class", "bottleneck-badge-group");
    const badgeG = badgeGroup.selectAll(null).data(bottleneckEdges).join("g")
      .attr("class", "bottleneck-badge").attr("transform", d => `translate(${(d.x1 + d.x2) / 2},${midY - 22})`).attr("pointer-events", "none");
    badgeG.append("rect").attr("x", d => { const lbl = compactGapLabel(d.gapHours); return -Math.max(14, 7 + lbl.length * 3.2); }).attr("y", -8)
      .attr("width", d => { const lbl = compactGapLabel(d.gapHours); return Math.max(14, 7 + lbl.length * 3.2) * 2; }).attr("height", 16).attr("rx", 8)
      .attr("fill", "rgba(255,247,237,0.96)").attr("stroke", "rgba(217,119,6,0.55)").attr("stroke-width", 1);
    badgeG.append("text").attr("text-anchor", "middle").attr("dy", "0.34em").attr("font-family", "JetBrains Mono, monospace").attr("font-size", "8px").attr("font-weight", "700").attr("fill", "#b45309").text(d => compactGapLabel(d.gapHours));
  }

  if (vis.resources) _drawResourceOverlay(lRes, row, cb);

  const evG = lNodes.selectAll(null).data(timelineNodes).join("g")
    .attr("class", d => d.isSyncEvent ? "event-node event-sync-group" : "event-node")
    .attr("data-event-id", d => d.id).attr("data-entity-id", d => d.poitem_id)
    .attr("transform", d => `translate(${d.x},${d.y})`).style("cursor", "pointer");

  evG.append("circle").attr("r", EVENT_R + 4).attr("fill", "transparent").attr("stroke", "transparent").attr("class", "ev-hover-ring");
  evG.filter(d => d.isSyncEvent).append("circle").attr("r", d => eventRadius(d, EVENT_R) + 5).attr("fill", "none").attr("stroke", "rgba(255,255,255,0.96)").attr("stroke-width", 2.2).attr("class", "sync-outer-ring");
  evG.filter(d => d.isSyncEvent).append("circle").attr("r", d => eventRadius(d, EVENT_R) + 7).attr("fill", "none").attr("stroke", "rgba(37,99,235,0.30)").attr("stroke-width", 1.6).attr("class", "sync-pulse-ring");
  evG.append("circle").attr("r", d => eventRadius(d, EVENT_R))
    .attr("fill", d => d.activityColor ?? d.color).attr("fill-opacity", 0.9)
    .attr("stroke", d => d.resourceColor ?? "#f8fbff").attr("stroke-width", d => d.isSyncEvent ? 2 : 1.6)
    .attr("class", d => d.isSyncEvent ? "event-circle event-circle-sync" : "event-circle");

  evG.on("mousemove", function(ev, d) {
    d3.select(this).select(".ev-hover-ring").attr("stroke", d.activityColor ?? d.color).attr("stroke-width", 1.5).attr("opacity", 0.45);
    const fmt = d.date?.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) ?? "—";
    cb.onTooltipShow(
      `<div class="tip-title">${d.activity}</div><div class="tip-row">ID: <b>${d.id}</b></div><div class="tip-row">Date: <b>${fmt}</b></div><div class="tip-row">${itemType}: <b>${d.poitem_id}</b></div>${d.isSyncEvent ? `<div class="tip-row">Sync degree: <b>${d.syncDegree}</b></div>` : ""}${d.isSyncEvent && d.sharedEntityIds?.length ? `<div class="tip-row">Shared by: <b>${d.sharedEntityIds.join(", ")}</b></div>` : ""}${hasResourceValue(d.org_resource) ? `<div class="tip-row">Resource: <b>${d.org_resource}</b></div>` : ""}${d.lifecycle_transition ? `<div class="tip-row">Lifecycle: <b>${d.lifecycle_transition}</b></div>` : ""}${tooltipRows(d, ["Document_Type", "Source", "Vendor", "Company"])}${d.isSyncEvent ? syncContextRows(d.syncContexts ?? []) : ""}`,
      ev.offsetX, ev.offsetY
    );
  }).on("click", (ev, d) => { ev.stopPropagation(); cb.onEventSelect?.(d); })
    .on("mouseleave", function() { d3.select(this).select(".ev-hover-ring").attr("stroke", "transparent"); cb.onTooltipHide(); });

  [timelineNodes[0], timelineNodes.at(-1)].forEach((n, i) => {
    if (!n) return;
    lLabels.append("text").attr("x", n.x).attr("y", midY + eventRadius(n, EVENT_R) + 13).attr("text-anchor", i === 0 ? "start" : "end")
      .attr("font-family", "JetBrains Mono, monospace").attr("font-size", "8px").attr("fill", "var(--text-dim)")
      .text(n.date?.toLocaleDateString("en-GB", { day: "numeric", month: "short" }) ?? "");
  });

  lLabels.append("text").attr("x", lastX + eventRadius(timelineNodes.at(-1), EVENT_R) + 10).attr("y", midY + 4)
    .attr("font-family", "JetBrains Mono, monospace").attr("font-size", "9px").attr("fill", color).attr("opacity", 0.5)
    .text(`${timelineNodes.length} ev`);
}

function _drawResourceOverlay(layer, row, cb) {
  const { resourceNodes, resourceLinks } = row;
  if (!resourceNodes?.length) return;
  const g = layer.append("g").attr("class", "resource-overlay");
  g.selectAll(null).data(resourceLinks).join("line").attr("class", "resource-link")
    .attr("x1", d => d.x1).attr("y1", d => d.y1).attr("x2", d => d.x2).attr("y2", d => d.y2)
    .attr("stroke", d => d.color).attr("stroke-width", 1).attr("stroke-dasharray", "2 3").attr("opacity", 0.28);
  const nodes = g.selectAll(null).data(resourceNodes).join("g").attr("class", "resource-node")
    .attr("transform", d => `translate(${d.x},${d.y})`).style("cursor", "pointer");
  nodes.append("circle").attr("r", 8).attr("fill", "#ffffff").attr("stroke", d => d.color).attr("stroke-width", 1.5);
  nodes.append("text").attr("text-anchor", "middle").attr("dy", "0.34em").attr("font-family", "JetBrains Mono, monospace").attr("font-size", "7px").attr("font-weight", "700").attr("fill", d => d.color).text(d => d.count);
  nodes.on("mousemove", (ev, d) => cb.onTooltipShow(`<div class="tip-title">${d.label}</div><div class="tip-row">Resource-linked events: <b>${d.count}</b></div>`, ev.offsetX, ev.offsetY)).on("mouseleave", cb.onTooltipHide);
}
