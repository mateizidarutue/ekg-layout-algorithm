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
