"use strict";

import { clusterColor, ellipsis, formatPercent, tooltipRows, activitySummary, entitySuffix } from "./shared.js";

export function drawVariantOverview(variantLayout, dfLayout, variantData, lBg, lNodes, lLabels, cb, selectedVariant = null) {
  const rows = variantLayout?.rows ?? [];
  const summaryX = variantLayout?.summaryX ?? ((variantLayout?.rowX ?? 56) + (variantLayout?.rowWidth ?? 320));

  lLabels.append("text")
    .attr("x", variantLayout?.headerX ?? 56).attr("y", (variantLayout?.headerY ?? 40) + 6)
    .attr("font-family", "JetBrains Mono, monospace").attr("font-size", "10px").attr("font-weight", "700")
    .attr("letter-spacing", "0.12em").attr("fill", "var(--text-dim)").text("PROCESS VARIANTS");

  lLabels.append("text")
    .attr("x", variantLayout?.headerX ?? 56).attr("y", (variantLayout?.headerY ?? 40) + 24)
    .attr("font-family", "Syne, sans-serif").attr("font-size", "18px").attr("font-weight", "500")
    .attr("fill", "var(--text)").text("Process Variants");

  lLabels.append("text")
    .attr("x", summaryX).attr("y", (variantLayout?.headerY ?? 40) + 24)
    .attr("text-anchor", "end").attr("font-family", "JetBrains Mono, monospace")
    .attr("font-size", "10px").attr("fill", "var(--text-dim)")
    .text(`${variantData?.totalInstances ?? 0} instances / top ${variantData?.shownVariantCount ?? 0} of ${variantData?.variantCount ?? 0} variants`);

  if (!rows.length) {
    lLabels.append("text")
      .attr("x", variantLayout?.rowX ?? 56).attr("y", (variantLayout?.totalHeight ?? 88) - 8)
      .attr("font-family", "JetBrains Mono, monospace").attr("font-size", "10px").attr("fill", "var(--text-dim)")
      .text("No variants match the current activity filter.");
  } else {
    rows.forEach((row, index) => {
      const bgRect = lBg.append("rect")
        .attr("x", row.x).attr("y", row.y).attr("width", row.w).attr("height", row.h).attr("rx", 12)
        .attr("fill", row.variant?.isSelected
          ? "rgba(79,142,247,0.16)"
          : row.variant?.isdominant
            ? "rgba(79,142,247,0.10)"
            : "rgba(255,255,255,0.02)")
        .attr("stroke", row.variant?.isSelected
          ? "rgba(37,99,235,0.48)"
          : row.variant?.isdominant
            ? "rgba(79,142,247,0.28)"
            : "rgba(79,142,247,0.08)")
        .attr("stroke-width", row.variant?.isSelected ? 1.6 : row.variant?.isdominant ? 1.2 : 1).style("cursor", "pointer");

      const connectorStroke = row.variant?.isdominant ? "rgba(79,142,247,0.30)" : "rgba(79,142,247,0.18)";
      row.chips.slice(0, -1).forEach((chip, ci) => {
        const next = row.chips[ci + 1];
        lBg.append("line")
          .attr("x1", chip.x + chip.w).attr("y1", chip.y + chip.h / 2)
          .attr("x2", next.x).attr("y2", next.y + next.h / 2)
          .attr("stroke", connectorStroke).attr("stroke-width", row.variant?.isdominant ? 1.5 : 1).attr("stroke-linecap", "round");
      });

      const rowG = lNodes.append("g").attr("class", "variant-row").style("cursor", "pointer");
      const setHover = active => {
        bgRect
          .attr("fill", active
            ? (row.variant?.isSelected ? "rgba(79,142,247,0.20)" : row.variant?.isdominant ? "rgba(79,142,247,0.13)" : "rgba(79,142,247,0.06)")
            : (row.variant?.isSelected ? "rgba(79,142,247,0.16)" : row.variant?.isdominant ? "rgba(79,142,247,0.10)" : "rgba(255,255,255,0.02)"))
          .attr("stroke", active
            ? "rgba(79,142,247,0.42)"
            : (row.variant?.isSelected ? "rgba(37,99,235,0.48)" : row.variant?.isdominant ? "rgba(79,142,247,0.28)" : "rgba(79,142,247,0.08)"));
      };
      const clickVariant = () => cb.onVariantSelect?.(row.variant?.key ?? null);
      const moveVariant = ev => cb.onTooltipShow(
        `<div class="tip-title">Variant ${index + 1}</div>
         <div class="tip-row">Instances: <b>${row.variant?.count ?? 0}</b></div>
         <div class="tip-row">Members: <b>${row.variant?.memberCount ?? 0}</b></div>
         <div class="tip-row">Share: <b>${formatPercent(row.variant?.frequency ?? 0)}</b></div>
         <div class="tip-row">Sequence: <b>${(row.variant?.sequence ?? []).join(" -> ") || "n/a"}</b></div>
         <div class="tip-row" style="margin-top:5px;color:var(--accent);font-size:10px">Click to show this variant's details below the graph</div>`,
        ev
      );
      [bgRect, rowG].forEach(t => t.on("mouseenter", () => setHover(true)).on("mouseleave", () => { setHover(false); cb.onTooltipHide(); }).on("mousemove", moveVariant).on("click", clickVariant));

      rowG.append("rect").attr("x", row.badgeRectX).attr("y", row.badgeRectY).attr("width", row.badgeW).attr("height", row.badgeH).attr("rx", row.badgeH / 2)
        .attr("fill", row.variant?.isdominant ? "rgba(79,142,247,0.18)" : "rgba(255,255,255,0.05)")
        .attr("stroke", row.variant?.isdominant ? "rgba(79,142,247,0.34)" : "rgba(79,142,247,0.12)").attr("stroke-width", 1);
      rowG.append("text").attr("x", row.badgeX).attr("y", row.badgeY + 4).attr("text-anchor", "middle")
        .attr("font-family", "JetBrains Mono, monospace").attr("font-size", "11px").attr("font-weight", "700").attr("fill", "var(--text)").text(row.variant?.count ?? 0);
      if (row.variant?.isdominant) rowG.append("text").attr("x", Math.max(row.x + 6, row.badgeRectX - 18)).attr("y", row.badgeY + 4)
        .attr("font-family", "JetBrains Mono, monospace").attr("font-size", "9px").attr("font-weight", "700").attr("fill", "#b45309").text("TOP");

      const chipG = rowG.selectAll(null).data(row.chips).join("g").attr("transform", d => `translate(${d.x},${d.y})`);
      chipG.append("rect").attr("width", d => d.w).attr("height", d => d.h).attr("rx", d => d.h / 2)
        .attr("fill", d => _rgba(d.color, row.variant?.isdominant ? 0.28 : 0.2)).attr("stroke", d => _rgba(d.color, row.variant?.isdominant ? 0.72 : 0.44)).attr("stroke-width", 1.1);
      chipG.append("text").attr("x", d => d.w / 2).attr("y", d => d.h / 2 + 3).attr("text-anchor", "middle")
        .attr("font-family", "JetBrains Mono, monospace").attr("font-size", d => Math.max(8, Math.min(10, d.h * 0.36))).attr("font-weight", "600").attr("fill", "var(--text)")
        .text(d => ellipsis(d.activity, Math.max(10, Math.floor((d.w - 18) / 6.4))));
      rowG.append("text").attr("x", row.percentX).attr("y", row.percentY + 4).attr("text-anchor", "end")
        .attr("font-family", "JetBrains Mono, monospace").attr("font-size", "10px")
        .attr("fill", row.variant?.isdominant ? "var(--accent)" : "var(--text-dim)").text(formatPercent(row.variant?.frequency ?? 0));
    });
  }

  lLabels.append("text")
    .attr("x", dfLayout?.x ?? 56).attr("y", (dfLayout?.y ?? ((variantLayout?.totalHeight ?? 0) + 34)) - 10)
    .attr("font-family", "JetBrains Mono, monospace").attr("font-size", "10px").attr("font-weight", "700")
    .attr("letter-spacing", "0.12em").attr("fill", "var(--text-dim)").text("ACTIVITY FLOW");

  const expandX = (dfLayout?.x ?? 56) + (dfLayout?.width ?? 240) - 78;
  const expandY = (dfLayout?.y ?? ((variantLayout?.totalHeight ?? 0) + 34)) - 27;
  const expandG = lNodes.append("g")
    .attr("class", "df-expand-btn")
    .attr("transform", `translate(${expandX},${expandY})`)
    .style("cursor", "pointer")
    .on("click", () => cb.onDfExpand?.());
  expandG.append("rect")
    .attr("width", 78).attr("height", 22).attr("rx", 7)
    .attr("fill", "rgba(255,255,255,0.9)")
    .attr("stroke", "rgba(37,99,235,0.22)");
  expandG.append("text")
    .attr("x", 39).attr("y", 14).attr("text-anchor", "middle")
    .attr("font-family", "JetBrains Mono, monospace").attr("font-size", "9px").attr("font-weight", "700")
    .attr("fill", "var(--accent)").text("EXPAND");

  lBg.append("rect")
    .attr("x", dfLayout?.x ?? 56).attr("y", dfLayout?.y ?? ((variantLayout?.totalHeight ?? 0) + 34))
    .attr("width", dfLayout?.width ?? 240).attr("height", dfLayout?.height ?? 200).attr("rx", 16)
    .attr("fill", "rgba(14,17,24,0.72)").attr("stroke", "rgba(79,142,247,0.10)").attr("stroke-width", 1);

  const maxEdgeCount = Math.max(...(dfLayout?.edges ?? []).map(e => e.count), 1);
  lBg.selectAll(null).data(dfLayout?.edges ?? []).join("path")
    .attr("class", "variant-dfg-edge").attr("d", d => `M${d.x1},${d.y1} Q${d.cx},${d.cy} ${d.x2},${d.y2}`)
    .attr("fill", "none").attr("stroke", "rgba(79,142,247,0.28)").attr("stroke-width", d => 1 + (d.count / maxEdgeCount) * 4).attr("stroke-linecap", "round")
    .on("mousemove", (ev, d) => cb.onTooltipShow(`<div class="tip-title">Activity Flow</div><div class="tip-row">Transition: <b>${d.source} -> ${d.target}</b></div><div class="tip-row">Count: <b>${d.count}</b></div>`, ev))
    .on("mouseleave", cb.onTooltipHide);

  const maxNodeCount = Math.max(...(dfLayout?.nodes ?? []).map(n => n.count), 1);
  const nodeG = lNodes.selectAll(null).data(dfLayout?.nodes ?? []).join("g")
    .attr("transform", d => `translate(${d.x},${d.y})`).style("cursor", "default")
    .on("mousemove", (ev, d) => cb.onTooltipShow(`<div class="tip-title">${d.label}</div><div class="tip-row">Occurrences: <b>${d.count}</b></div>`, ev))
    .on("mouseleave", cb.onTooltipHide);
  nodeG.append("circle").attr("r", d => 8 + (d.count / maxNodeCount) * 10).attr("fill", "rgba(79,142,247,0.18)").attr("stroke", "rgba(79,142,247,0.48)").attr("stroke-width", 1.4);
  nodeG.append("text").attr("text-anchor", "middle").attr("dy", "0.34em").attr("font-family", "JetBrains Mono, monospace").attr("font-size", "8px").attr("font-weight", "700").attr("fill", "var(--text)").text(d => Math.round(d.count));
  lLabels.selectAll(null).data(dfLayout?.nodes ?? []).join("text")
    .attr("x", d => d.x).attr("y", d => d.y + 24).attr("text-anchor", "middle")
    .attr("font-family", "JetBrains Mono, monospace").attr("font-size", "8px").attr("fill", "var(--text-dim)").text(d => ellipsis(d.label, 16));

  // The selected variant is described in the sidebar so the main canvas can stay focused on the graph.
}

export function drawOverviewNetwork(network, lBg, lMeta, lNodes, lLabels, vis, cb, labels = {}) {
  const caseType = labels.caseType ?? "Case";
  const itemType = labels.itemType ?? "Item";
  const focusedCommunityId = network.meta?.focusCommunityId ?? null;
  const isFocused = Boolean(focusedCommunityId);
  const clusterById = Object.fromEntries(network.clusters.map(c => [c.id, c]));

  network.clusters.forEach(cluster => {
    const color = clusterColor(cluster.id);
    const shellRadius = isFocused ? cluster.radius + 18 : cluster.outerRadius + 4;
    const bubble = lBg.append("circle")
      .attr("cx", cluster.x).attr("cy", cluster.y).attr("r", shellRadius)
      .attr("fill", clusterColor(cluster.id, isFocused ? 0.16 : 0.1)).attr("stroke", clusterColor(cluster.id, isFocused ? 0.42 : 0.34)).attr("stroke-width", isFocused ? 1.8 : 1.5)
      .style("cursor", "pointer")
      .on("click", () => cb.onCommunitySelect?.(cluster.id))
      .on("mousemove", ev => cb.onTooltipShow(
        `<div class="tip-title">${cluster.label}</div>${cluster.code ? `<div class="tip-row">Group: <b>${cluster.code}</b></div>` : ""}<div class="tip-row">Cases: <b>${cluster.count}</b></div>${cluster.resources?.length ? `<div class="tip-row">Resources: <b>${cluster.resources.slice(0, 3).map(d => d.label).join(", ")}</b></div>` : ""}<div class="tip-row" style="margin-top:5px;color:var(--accent);font-size:10px">Click to focus this community</div>`,
        ev
      ))
      .on("mouseleave", cb.onTooltipHide);

    lBg.append("circle").attr("cx", cluster.x).attr("cy", cluster.y).attr("r", cluster.radius + 10)
      .attr("fill", clusterColor(cluster.id, 0.07)).attr("stroke", clusterColor(cluster.id, 0.24)).attr("stroke-width", 1.1);

    const labelY = cluster.y - (isFocused ? cluster.radius + 96 : cluster.outerRadius + 18);
    lLabels.append("text").attr("x", cluster.x).attr("y", labelY).attr("text-anchor", "middle")
      .attr("font-family", "JetBrains Mono, monospace").attr("font-size", "11px").attr("font-weight", "700").attr("fill", color).text(ellipsis(cluster.label, 28));
    lLabels.append("text").attr("x", cluster.x).attr("y", labelY + 14).attr("text-anchor", "middle")
      .attr("font-family", "JetBrains Mono, monospace").attr("font-size", "8px").attr("fill", "rgba(12,29,50,0.72)").text(`${cluster.count} cases${cluster.hint ? ` / ${cluster.hint}` : ""}`);

    lNodes.append("circle").attr("cx", cluster.x).attr("cy", cluster.y).attr("r", Math.min(24, 11 + cluster.count * 0.9))
      .attr("fill", clusterColor(cluster.id, 0.18)).attr("stroke", color).attr("stroke-width", isFocused ? 2 : 2.4).style("cursor", "pointer")
      .on("click", () => cb.onCommunitySelect?.(cluster.id));

    if (isFocused) {
      const satellites = cluster.satellites ?? [];
      lMeta.selectAll(null).data(satellites).join("line")
        .attr("x1", cluster.x).attr("y1", cluster.y).attr("x2", d => d.x).attr("y2", d => d.y)
        .attr("stroke", d => d.type === "resource" ? "rgba(15,118,110,0.22)" : "rgba(217,119,6,0.22)")
        .attr("stroke-width", 0.9).attr("stroke-dasharray", "2 4")
        .attr("class", d => d.type === "resource" ? "resource-satellite" : "attribute-satellite");

      const satelliteG = lNodes.selectAll(null).data(satellites).join("g")
        .attr("transform", d => `translate(${d.x},${d.y})`).attr("class", d => d.type === "resource" ? "resource-satellite" : "attribute-satellite")
        .on("mousemove", (ev, d) => cb.onTooltipShow(`<div class="tip-title">${d.type === "resource" ? "Resource" : "Attribute"}</div><div class="tip-row"><b>${d.label}</b></div><div class="tip-row">Appears in <b>${d.count}</b> cases of this community</div>`, ev))
        .on("mouseleave", cb.onTooltipHide);
      satelliteG.filter(d => d.type === "resource").append("ellipse").attr("rx", d => d.w / 2).attr("ry", d => d.h / 2).attr("fill", "rgba(15,118,110,0.12)").attr("stroke", "rgba(15,118,110,0.56)").attr("stroke-width", 1.1);
      satelliteG.filter(d => d.type === "attribute").append("rect").attr("x", d => -d.w / 2).attr("y", d => -d.h / 2).attr("width", d => d.w).attr("height", d => d.h).attr("rx", 7).attr("fill", "rgba(217,119,6,0.12)").attr("stroke", "rgba(217,119,6,0.56)").attr("stroke-width", 1.1);
      satelliteG.append("text").attr("text-anchor", "middle").attr("dy", "0.34em").attr("font-family", "JetBrains Mono, monospace").attr("font-size", "7px").attr("font-weight", "600").attr("fill", d => d.type === "resource" ? "#0f766e" : "#b45309").text(d => d.shortLabel ?? ellipsis(d.label, 16));
    }
  });

  if (!isFocused) {
    lMeta.selectAll(null).data(network.communityEdges ?? []).join("path").attr("class", "edge-overview")
      .attr("d", d => {
        const src = clusterById[d.source], tgt = clusterById[d.target];
        if (!src || !tgt) return "";
        const dx = tgt.x - src.x, dy = tgt.y - src.y;
        const dist = Math.max(Math.hypot(dx, dy), 1);
        const mx = (src.x + tgt.x) / 2, my = (src.y + tgt.y) / 2;
        const curve = Math.min(80, dist * 0.12);
        return `M${src.x},${src.y} Q${mx - dy / dist * curve},${my + dx / dist * curve} ${tgt.x},${tgt.y}`;
      })
      .attr("fill", "none").attr("stroke", d => clusterColor(d.source, Math.min(0.22 + d.weight * 0.08, 0.52))).attr("stroke-width", d => Math.min(1.4 + d.weight * 2.1, 4))
      .on("mousemove", (ev, d) => cb.onTooltipShow(`<div class="tip-title">Community similarity</div><div class="tip-row">Strength: <b>${Math.round(d.weight * 100)}%</b></div><div class="tip-row">Supporting case links: <b>${d.count}</b></div>`, ev))
      .on("mouseleave", cb.onTooltipHide);
    return;
  }

  const memberIds = new Set(
    network.nodes.filter(n => String(n.clusterKey) === String(focusedCommunityId)).map(n => n.id)
  );
  lMeta.selectAll(null).data(network.edges).join("path").attr("class", "edge-overview")
    .attr("d", d => `M${d.x1},${d.y1} Q${d.cx},${d.cy} ${d.x2},${d.y2}`).attr("fill", "none")
    .attr("stroke", d => `rgba(30,64,175,${Math.min(0.26 + d.weight * 0.1, 0.6)})`)
    .attr("stroke-width", d => Math.min(1.4 + d.weight * 3.2, 4.2))
    .style("opacity", d => (memberIds.has(d.source) && memberIds.has(d.target)) ? 1 : 0.12)
    .on("mousemove", (ev, d) => cb.onTooltipShow(`<div class="tip-title">Case similarity</div><div class="tip-row">Strength: <b>${Math.round(d.weight * 100)}%</b></div>${d.reasons?.map(r => `<div class="tip-row">${r}</div>`).join("") ?? ""}`, ev))
    .on("mouseleave", cb.onTooltipHide);

  const poG = lNodes.selectAll(null).data(network.nodes).join("g")
    .attr("transform", d => `translate(${d.x},${d.y})`).style("cursor", "pointer")
    .style("opacity", d => isFocused && String(d.clusterKey) !== String(focusedCommunityId) ? 0.15 : 1)
    .on("click", (_, d) => cb.onPoSelect?.(d.id))
    .on("mousemove", (ev, d) => {
      const dateRange = d.firstDate && d.lastDate ? `${d.firstDate.toLocaleDateString("en-GB")} -> ${d.lastDate.toLocaleDateString("en-GB")}` : "n/a";
      cb.onTooltipShow(
        `<div class="tip-title">${caseType} ${d.id}</div><div class="tip-row">Community: <b>${d.clusterLabel}</b></div>${d.clusterCode ? `<div class="tip-row">Group: <b>${d.clusterCode}</b></div>` : ""}<div class="tip-row">Events: <b>${d.filteredEvents} / ${d.totalEvents}</b></div><div class="tip-row">${itemType}s: <b>${d.filteredItems} / ${d.totalItems}</b></div><div class="tip-row">Linked ${caseType}s: <b>${d.degree}</b></div><div class="tip-row">Range: <b>${dateRange}</b></div>${d.topActivities?.length ? `<div class="tip-row">Top activities: <b>${activitySummary(d.topActivities)}</b></div>` : ""}${tooltipRows(d.displayAttrs, d.attrKeys ?? [])}<div class="tip-row" style="margin-top:5px;color:var(--accent);font-size:10px">Click to open detailed layout</div>`,
        ev
      );
    })
    .on("mouseleave", cb.onTooltipHide);

  poG.append("circle").attr("r", d => d.r + 4).attr("fill", d => clusterColor(d.clusterKey, 0.1)).attr("stroke", "none");
  poG.append("circle").attr("r", d => d.r).attr("fill", d => clusterColor(d.clusterKey, 0.16)).attr("stroke", d => clusterColor(d.clusterKey)).attr("stroke-width", d => d.degree > 0 ? 2.2 : 1.3);
  poG.append("text").attr("text-anchor", "middle").attr("dy", "-0.1em").attr("font-family", "JetBrains Mono, monospace").attr("font-size", "8px").attr("font-weight", "700").attr("fill", d => clusterColor(d.clusterKey)).text(d => entitySuffix(d.id));
  poG.append("text").attr("text-anchor", "middle").attr("dy", "1.0em").attr("font-family", "JetBrains Mono, monospace").attr("font-size", "7px").attr("fill", "var(--text-dim)").text(d => `${d.filteredEvents}e`);
}

export function drawTypeEKGView(layout, lBg, lMeta, lNodes, lLabels, cb) {
  const { bands, syncArcs, padLeft, innerW, minTime, maxTime, totalHeight } = layout;
  if (!bands.length) return;

  // Time axis vertical guide lines
  const timeSpan = maxTime - minTime;
  if (timeSpan > 0) {
    const ticks = 7;
    for (let i = 0; i <= ticks; i++) {
      const x = padLeft + (i / ticks) * innerW;
      const date = new Date(minTime + (i / ticks) * timeSpan);
      lMeta.append("line")
        .attr("x1", x).attr("y1", 30).attr("x2", x).attr("y2", totalHeight - 16)
        .attr("stroke", "rgba(37,99,235,0.055)").attr("stroke-width", 1);
      lLabels.append("text")
        .attr("x", x).attr("y", 18).attr("text-anchor", "middle")
        .attr("font-family", "JetBrains Mono, monospace").attr("font-size", "8px")
        .attr("fill", "rgba(30,64,175,0.36)")
        .text(date.toLocaleDateString("en-GB", { month: "short", year: "2-digit" }));
    }
  }

  // Sync arcs (between bands — drawn first so bands overlap them)
  lMeta.selectAll(null).data(syncArcs).join("path")
    .attr("d", d => `M${d.x1},${d.y1} Q${d.cx},${d.cy} ${d.x2},${d.y2}`)
    .attr("fill", "none")
    .attr("stroke", d => clusterColor(d.type1, 0.52))
    .attr("stroke-width", d => d.sw)
    .attr("stroke-dasharray", "5 4")
    .on("mousemove", (ev, d) => cb.onTooltipShow?.(
      `<div class="tip-title">Shared event</div>
       <div class="tip-row">Activity: <b>${d.activity}</b></div>
       <div class="tip-row">Types: <b>${d.type1} × ${d.type2}</b></div>
       <div class="tip-row">Occurrences: <b>${d.count.toLocaleString()}</b></div>`, ev))
    .on("mouseleave", () => cb.onTooltipHide?.());

  // Per-band rendering
  bands.forEach((band, bandIdx) => {
    const color = clusterColor(band.type);

    // Band background
    lBg.append("rect")
      .attr("x", 0).attr("y", band.y)
      .attr("width", padLeft + innerW + 52).attr("height", band.height)
      .attr("fill", clusterColor(band.type, 0.04))
      .attr("stroke", clusterColor(band.type, 0.10)).attr("stroke-width", 1);

    // Band label (left)
    const labelG = lNodes.append("g")
      .attr("transform", `translate(${padLeft - 14},${band.cy})`)
      .style("cursor", "pointer")
      .on("click", () => cb.onEntityTypeSelect?.(band.type));
    labelG.append("text")
      .attr("text-anchor", "end").attr("dy", "0.35em")
      .attr("font-family", "JetBrains Mono, monospace").attr("font-size", "12px")
      .attr("font-weight", "700").attr("fill", color)
      .text(band.type);
    labelG.append("text")
      .attr("text-anchor", "end").attr("dy", "1.6em")
      .attr("font-family", "JetBrains Mono, monospace").attr("font-size", "8px")
      .attr("fill", clusterColor(band.type, 0.55))
      .text(`${band.nodes.reduce((s, n) => s + n.count, 0).toLocaleString()} events`);

    // DF arcs within band
    lMeta.selectAll(null).data(band.edges).join("path")
      .attr("d", d => `M${d.x1},${d.y1} Q${d.cx},${d.cy} ${d.x2},${d.y2}`)
      .attr("fill", "none")
      .attr("stroke", clusterColor(band.type, 0.45))
      .attr("stroke-width", d => d.sw)
      .on("mousemove", (ev, d) => cb.onTooltipShow?.(
        `<div class="tip-title">Directly follows</div>
         <div class="tip-row"><b>${d.source}</b> → <b>${d.target}</b></div>
         <div class="tip-row">Count: <b>${d.count.toLocaleString()}</b></div>`, ev))
      .on("mouseleave", () => cb.onTooltipHide?.());

    // Activity nodes
    const nodeG = lNodes.selectAll(null).data(band.nodes).join("g")
      .attr("transform", d => `translate(${d.x},${d.y})`)
      .style("cursor", "pointer")
      .on("click", (_, d) => cb.onActivitySelect?.(d.activity))
      .on("mousemove", (ev, d) => cb.onTooltipShow?.(
        `<div class="tip-title">${d.activity}</div>
         <div class="tip-row">Entity type: <b>${band.type}</b></div>
         <div class="tip-row">Events: <b>${d.count.toLocaleString()}</b></div>
         <div class="tip-row" style="margin-top:5px;color:var(--accent);font-size:10px">Click to explore shared events for this activity</div>`, ev))
      .on("mouseleave", () => cb.onTooltipHide?.());

    nodeG.append("circle")
      .attr("r", d => d.r + 5).attr("fill", clusterColor(band.type, 0.07));
    nodeG.append("circle")
      .attr("r", d => d.r)
      .attr("fill", clusterColor(band.type, 0.18))
      .attr("stroke", color).attr("stroke-width", 1.8);
    nodeG.append("text")
      .attr("text-anchor", "middle").attr("dy", "-0.15em")
      .attr("font-family", "JetBrains Mono, monospace")
      .attr("font-size", d => `${Math.max(7, Math.min(9, d.r * 0.52))}px`)
      .attr("font-weight", "700").attr("fill", color)
      .text(d => d.count >= 1000 ? `${(d.count / 1000).toFixed(1)}k` : d.count);

    // Activity label below node
    lLabels.selectAll(null).data(band.nodes).join("text")
      .attr("x", d => d.x).attr("y", d => d.y + d.r + 13)
      .attr("text-anchor", "middle")
      .attr("font-family", "JetBrains Mono, monospace").attr("font-size", "8px")
      .attr("fill", clusterColor(band.type, 0.72))
      .text(d => ellipsis(d.activity, 22));
  });
}

function _rgba(value, alpha = 1) {
  const color = d3.color(value);
  if (!color) return value;
  color.opacity = alpha;
  return color.formatRgb();
}

function _drawSelectedVariantPanel(variant, variantData, dfLayout, lBg, lNodes, lLabels) {
  const x = dfLayout?.x ?? 56;
  const y = (dfLayout?.y ?? 0) + (dfLayout?.height ?? 200) + 34;
  const w = dfLayout?.width ?? 720;
  const h = 132;
  const colW = Math.max(92, Math.floor((w - 44) / 6));
  const stats = [
    ["Instances", variant.count ?? 0],
    [variantData?.caseType ?? "Members", variant.memberCount ?? 0],
    [variantData?.itemType ?? "Items", variant.itemCount ?? 0],
    ["Share", formatPercent(variant.frequency ?? 0)],
    ["Events", variant.eventTotal ?? 0],
    ["Avg duration", _formatHoursLabel(variant.avgDurationHours)],
  ];
  const sequence = (variant.sequence ?? []).join(" -> ") || "No sequence available";
  const activities = _formatCountList(variant.topActivities, "activity");
  const resources = _formatCountList(variant.topResources, "label");
  const dateRange = _formatDateRange(variant.firstDate, variant.lastDate);

  lBg.append("rect")
    .attr("x", x).attr("y", y).attr("width", w).attr("height", h).attr("rx", 14)
    .attr("fill", "rgba(255,255,255,0.90)")
    .attr("stroke", "rgba(124,58,237,0.22)")
    .attr("stroke-width", 1.2);

  lLabels.append("text")
    .attr("x", x + 18).attr("y", y + 26)
    .attr("font-family", "Syne, sans-serif").attr("font-size", "17px").attr("font-weight", "650")
    .attr("fill", "var(--text)").text(`Variant ${variant.rank}`);
  lLabels.append("text")
    .attr("x", x + w - 18).attr("y", y + 25).attr("text-anchor", "end")
    .attr("font-family", "JetBrains Mono, monospace").attr("font-size", "10px").attr("font-weight", "700")
    .attr("fill", variant.isdominant ? "#b45309" : "var(--text-dim)")
    .text(variant.isdominant ? "DOMINANT VARIANT" : "SELECTED VARIANT");

  const statG = lNodes.selectAll(null).data(stats).join("g")
    .attr("transform", (_, i) => `translate(${x + 18 + i * colW},${y + 44})`);
  statG.append("text")
    .attr("font-family", "JetBrains Mono, monospace").attr("font-size", "9px").attr("font-weight", "700")
    .attr("letter-spacing", "0.06em").attr("fill", "var(--text-dim)")
    .text(d => String(d[0]).toUpperCase());
  statG.append("text")
    .attr("y", 20).attr("font-family", "JetBrains Mono, monospace").attr("font-size", "15px").attr("font-weight", "800")
    .attr("fill", "var(--text)").text(d => d[1]);

  _appendWrappedText(lLabels, sequence, x + 18, y + 91, w - 36, {
    prefix: "Sequence: ",
    fill: "var(--text)",
    weight: "650",
  });
  _appendWrappedText(lLabels, `Top activities: ${activities}. Resources: ${resources}. Range: ${dateRange}.`, x + 18, y + 114, w - 36, {
    fill: "var(--text-dim)",
    size: 10,
  });
}

function _appendWrappedText(layer, text, x, y, maxWidth, options = {}) {
  const words = String(text ?? "").split(/\s+/).filter(Boolean);
  const size = options.size ?? 11;
  const prefix = options.prefix ?? "";
  const lineHeight = size + 4;
  const approxChars = Math.max(24, Math.floor(maxWidth / (size * 0.58)));
  const lines = [];
  let line = prefix;
  words.forEach(word => {
    const next = line ? `${line} ${word}` : word;
    if (next.length > approxChars && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  });
  if (line) lines.push(line);
  lines.slice(0, 2).forEach((item, index) => {
    layer.append("text")
      .attr("x", x).attr("y", y + index * lineHeight)
      .attr("font-family", "Inter, system-ui, sans-serif")
      .attr("font-size", `${size}px`).attr("font-weight", options.weight ?? "500")
      .attr("fill", options.fill ?? "var(--text)")
      .text(index === 1 && lines.length > 2 ? `${ellipsis(item, Math.max(12, approxChars - 3))}...` : item);
  });
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
