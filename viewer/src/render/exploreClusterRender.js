"use strict";

import { ellipsis, rgba } from "./shared.js";
import { DETAIL_PAD_X, TIMELINE_X0, TIMELINE_PAD_R } from "../layout/detailLayout.js";

// ── Layout constants ──────────────────────────────────────────────────────────
const EC_PAD_TOP      = 34;
const EC_HEADER_H     = 78;
const EC_EVENT_RISE   = 58;   // height above axis reserved for event circles
const EC_EVENT_MAX_R  = 26;
const EC_EVENT_MIN_R  = 11;
const EC_AXIS_PAD_BOT = 24;   // gap from axis to first band
const EC_TYPE_HDR_H   = 26;
const EC_ENTITY_H     = 22;
const EC_BAND_PAD     = 8;
const EC_TYPE_GAP     = 10;
const EC_PAD_BOTTOM   = 48;

// ── Helpers ───────────────────────────────────────────────────────────────────
function _bandColor(type) {
  let h = 0;
  for (const ch of String(type ?? "")) h = ((h << 5) - h) + ch.charCodeAt(0);
  return `hsl(${Math.abs(h) % 360}, 62%, 40%)`;
}

function _evTip(ev) {
  const ts = ev.date?.toLocaleString("en-GB") ?? "n/a";
  const members = (ev.memberships ?? [])
    .map(m => `<div class="tip-row">${m.entity_type}: <b>${m.entity_label}</b></div>`)
    .join("");
  return `<div class="tip-title">${ev.activity}</div>
<div class="tip-row">Event: <b>${ev.event_id}</b></div>
<div class="tip-row">Time: <b>${ts}</b></div>
<div class="tip-row">Shared entities: <b>${ev.entityCount}</b></div>
<div class="tip-divider"></div>${members}`;
}

// ── Layout ────────────────────────────────────────────────────────────────────
export function computeExploreClusterLayout(graph, width) {
  const totalWidth = Math.max(width - 18, TIMELINE_X0 + 400);
  const timelineW  = Math.max(totalWidth - TIMELINE_X0 - TIMELINE_PAD_R, 320);

  // Sort shared events by timestamp
  const events = [...(graph?.eventAnchors ?? [])].sort(
    (a, b) => (a.date?.getTime?.() ?? 0) - (b.date?.getTime?.() ?? 0)
  );

  // Time scale
  const times = events.map(e => e.date?.getTime?.()).filter(Number.isFinite);
  const tMin = times.length ? Math.min(...times) : 0;
  const tMax = times.length ? Math.max(...times) : 1;
  const tSpan = Math.max(tMax - tMin, 1);
  const xFor = t => TIMELINE_X0 + Math.max(0, Math.min(1, ((t ?? tMin) - tMin) / tSpan)) * timelineW;

  // Event circle sizes proportional to entity count
  const maxCount = Math.max(...events.map(e => e.sharedEntityIds?.length ?? 1), 1);
  const eventNodes = events.map(e => {
    const n = e.sharedEntityIds?.length ?? 1;
    return {
      ...e,
      x: xFor(e.date?.getTime?.()),
      r: EC_EVENT_MIN_R + (EC_EVENT_MAX_R - EC_EVENT_MIN_R) * (n / maxCount),
      entityCount: n,
    };
  });

  // Axis
  const axisY = EC_PAD_TOP + EC_HEADER_H + EC_EVENT_RISE;
  const TICK_N = 5;
  const ticks = Array.from({ length: TICK_N }, (_, i) => {
    const ratio = TICK_N === 1 ? 0 : i / (TICK_N - 1);
    const t = tMin + tSpan * ratio;
    return {
      x: TIMELINE_X0 + timelineW * ratio,
      label: Number.isFinite(t)
        ? new Date(t).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "2-digit" })
        : "n/a",
    };
  });

  // Entity participation matrix below axis
  let curY = axisY + EC_AXIS_PAD_BOT;
  const bands = (graph?.bands ?? []).map(band => {
    const bandTop = curY;
    const headerY = bandTop + EC_TYPE_HDR_H - 5;
    curY += EC_TYPE_HDR_H;

    const lanes = band.lanes.map(lane => {
      const y = curY + EC_ENTITY_H / 2;
      curY += EC_ENTITY_H;
      const pSet = new Set((lane.memberships ?? []).map(m => String(m.event_id)));
      return {
        ...lane,
        y,
        dots: eventNodes.filter(e => pSet.has(String(e.event_id))),
      };
    });

    curY += EC_BAND_PAD + EC_TYPE_GAP;
    return { ...band, bandTop, headerY, height: curY - EC_TYPE_GAP - bandTop, lanes };
  });

  // Per event: lowest participating entity y (for drawing column guide)
  const eventSpans = new Map();
  eventNodes.forEach(ev => eventSpans.set(String(ev.event_id), axisY));
  bands.forEach(band => {
    band.lanes.forEach(lane => {
      lane.dots.forEach(dot => {
        const id = String(dot.event_id);
        if ((eventSpans.get(id) ?? axisY) < lane.y) eventSpans.set(id, lane.y);
      });
    });
  });

  return {
    eventNodes, axisY, ticks, bands, eventSpans,
    totalWidth, totalHeight: curY + EC_PAD_BOTTOM,
    timelineW,
    summary: graph?.summary ?? {},
  };
}

// ── Render ────────────────────────────────────────────────────────────────────
export function drawExploreClusterView(layout, lBg, lMeta, lNodes, lLabels, cb) {
  const { eventNodes, axisY, ticks, bands, eventSpans, totalWidth, timelineW, summary } = layout;

  // Canvas + header background
  lBg.append("rect")
    .attr("x", 12).attr("y", 12)
    .attr("width", totalWidth - 24).attr("height", Math.max(layout.totalHeight - 20, 240))
    .attr("rx", 22).attr("fill", "rgba(255,255,255,0.78)")
    .attr("stroke", "rgba(148,163,184,0.26)").attr("stroke-width", 1.1);

  lBg.append("rect")
    .attr("x", 18).attr("y", 18)
    .attr("width", totalWidth - 36).attr("height", 74)
    .attr("rx", 18).attr("fill", "rgba(248,250,252,0.82)")
    .attr("stroke", "rgba(203,213,225,0.7)").attr("stroke-width", 1);

  lLabels.append("text")
    .attr("x", DETAIL_PAD_X).attr("y", 40)
    .attr("font-family", "JetBrains Mono, monospace").attr("font-size", "10px").attr("font-weight", "700")
    .attr("letter-spacing", "0.14em").attr("fill", "var(--text-dim)")
    .text("T4 · SHARED-EVENT CLUSTER");

  lLabels.append("text")
    .attr("x", DETAIL_PAD_X).attr("y", 62)
    .attr("font-family", "Syne, sans-serif").attr("font-size", "19px").attr("font-weight", "600")
    .attr("fill", "var(--text)")
    .text(ellipsis(
      `${eventNodes.length} shared events · ${summary.visibleEntityCount ?? "?"} entities · ${summary.visibleEntityTypeCount ?? "?"} types`,
      64
    ));

  lLabels.append("text")
    .attr("x", DETAIL_PAD_X).attr("y", 80)
    .attr("font-family", "JetBrains Mono, monospace").attr("font-size", "9px")
    .attr("fill", "var(--text-dim)")
    .text("Circle size = entity count  ·  Column = shared participation  ·  Click any element to inspect");

  // ── Timeline axis ─────────────────────────────────────────────────────────
  lBg.append("line")
    .attr("x1", TIMELINE_X0).attr("y1", axisY)
    .attr("x2", TIMELINE_X0 + timelineW).attr("y2", axisY)
    .attr("stroke", "rgba(51,65,85,0.26)").attr("stroke-width", 1.2);

  ticks.forEach(tick => {
    lBg.append("line")
      .attr("x1", tick.x).attr("y1", axisY - 5)
      .attr("x2", tick.x).attr("y2", axisY + 5)
      .attr("stroke", "rgba(71,85,105,0.24)").attr("stroke-width", 1);
    // Faint vertical grid behind the matrix
    lBg.append("line")
      .attr("x1", tick.x).attr("y1", axisY + 8)
      .attr("x2", tick.x).attr("y2", layout.totalHeight - 24)
      .attr("stroke", "rgba(148,163,184,0.08)").attr("stroke-width", 1)
      .attr("stroke-dasharray", "2 8");
    lLabels.append("text")
      .attr("x", tick.x).attr("y", axisY - 11)
      .attr("text-anchor", "middle")
      .attr("font-family", "JetBrains Mono, monospace").attr("font-size", "9px")
      .attr("fill", "var(--text-dim)").text(tick.label);
  });

  lLabels.append("text")
    .attr("x", DETAIL_PAD_X).attr("y", axisY + 4)
    .attr("font-family", "JetBrains Mono, monospace").attr("font-size", "10px").attr("font-weight", "700")
    .attr("fill", "var(--text-dim)").text("TIMELINE");

  // ── Column guides: one soft vertical band per event, spanning axis → lowest dot
  // These are drawn first so they sit behind circles and dots.
  eventNodes.forEach(ev => {
    const yBot = (eventSpans.get(String(ev.event_id)) ?? axisY) + 9;
    const colW = Math.max(ev.r * 1.1, 12);

    // Soft shaded column
    lMeta.append("rect")
      .attr("x", ev.x - colW / 2).attr("y", axisY)
      .attr("width", colW).attr("height", Math.max(yBot - axisY, 0))
      .attr("fill", rgba(ev.activityColor ?? "#64748b", 0.07))
      .attr("pointer-events", "none");

    // Centre dashed guide line
    lMeta.append("line")
      .attr("x1", ev.x).attr("y1", axisY + 1)
      .attr("x2", ev.x).attr("y2", yBot)
      .attr("stroke", ev.activityColor ?? "#64748b")
      .attr("stroke-width", 1.4)
      .attr("stroke-opacity", 0.32)
      .attr("stroke-dasharray", "3 5")
      .attr("pointer-events", "none");
  });

  // ── Entity participation matrix ────────────────────────────────────────────
  bands.forEach(band => {
    const col = _bandColor(band.entityType);

    // Band background
    lBg.append("rect")
      .attr("x", 18).attr("y", band.bandTop)
      .attr("width", totalWidth - 36).attr("height", band.height)
      .attr("rx", 10)
      .attr("fill", "rgba(248,250,252,0.55)")
      .attr("stroke", "rgba(148,163,184,0.10)").attr("stroke-width", 1);

    // Left color bar
    lBg.append("rect")
      .attr("x", 22).attr("y", band.bandTop + 3)
      .attr("width", 4).attr("height", band.height - 6)
      .attr("rx", 2).attr("fill", rgba(col, 0.80));

    // Type header
    lLabels.append("text")
      .attr("x", DETAIL_PAD_X).attr("y", band.headerY)
      .attr("font-family", "JetBrains Mono, monospace").attr("font-size", "10px").attr("font-weight", "800")
      .attr("fill", col)
      .text(band.entityLabel.toUpperCase());

    lLabels.append("text")
      .attr("x", totalWidth - 26).attr("y", band.headerY)
      .attr("text-anchor", "end")
      .attr("font-family", "JetBrains Mono, monospace").attr("font-size", "9px")
      .attr("fill", "var(--text-dim)")
      .text(`${band.lanes.length}`);

    // Separator line under header
    lBg.append("line")
      .attr("x1", DETAIL_PAD_X).attr("y1", band.bandTop + EC_TYPE_HDR_H)
      .attr("x2", totalWidth - 26).attr("y2", band.bandTop + EC_TYPE_HDR_H)
      .attr("stroke", rgba(col, 0.12)).attr("stroke-width", 1);

    // Entity rows
    band.lanes.forEach(lane => {
      // Horizontal guide across the row
      lBg.append("line")
        .attr("x1", TIMELINE_X0 - 8).attr("y1", lane.y)
        .attr("x2", TIMELINE_X0 + timelineW).attr("y2", lane.y)
        .attr("stroke", rgba(col, 0.06)).attr("stroke-width", 1);

      // Entity label
      lLabels.append("text")
        .attr("x", DETAIL_PAD_X + 4).attr("y", lane.y + 3)
        .attr("font-family", "JetBrains Mono, monospace").attr("font-size", "9px")
        .attr("fill", col)
        .text(ellipsis(lane.entityLabel, 26));

      // Participation count badge
      lLabels.append("text")
        .attr("x", TIMELINE_X0 - 10).attr("y", lane.y + 3)
        .attr("text-anchor", "end")
        .attr("font-family", "JetBrains Mono, monospace").attr("font-size", "8px")
        .attr("fill", "var(--text-dim)")
        .text(`${lane.dots.length}`);

      // Participation dots — one per event this entity attended
      lNodes.selectAll(null).data(lane.dots).join("circle")
        .attr("cx", d => d.x).attr("cy", lane.y)
        .attr("r", 5.2)
        .attr("fill", d => d.activityColor ?? col)
        .attr("stroke", "rgba(255,255,255,0.92)").attr("stroke-width", 1.6)
        .style("cursor", "pointer")
        .on("click", (ev, d) => {
          ev.stopPropagation();
          cb.onEventSelect?.({ id: d.event_id, sharedEntityIds: d.sharedEntityIds ?? [] });
        })
        .on("mousemove", (ev, d) => cb.onTooltipShow(
          `<div class="tip-title">${d.activity}</div>
<div class="tip-row">Entity: <b>${lane.entityLabel}</b></div>
<div class="tip-row">Type: <b>${band.entityType}</b></div>
<div class="tip-row">Time: <b>${d.date?.toLocaleString?.("en-GB") ?? "n/a"}</b></div>
<div class="tip-row">Shared with: <b>${d.entityCount} entities</b></div>`,
          ev
        ))
        .on("mouseleave", cb.onTooltipHide);
    });
  });

  // ── Event circles (topmost — drawn last so they sit above guides and dots)
  const evGroups = lNodes.selectAll(null).data(eventNodes).join("g")
    .attr("transform", d => `translate(${d.x},${axisY - d.r - 4})`)
    .style("cursor", "pointer")
    .on("click", (ev, d) => {
      ev.stopPropagation();
      cb.onEventSelect?.({ id: d.event_id, sharedEntityIds: d.sharedEntityIds ?? [] });
    })
    .on("mousemove", (ev, d) => cb.onTooltipShow(_evTip(d), ev))
    .on("mouseleave", cb.onTooltipHide);

  // Outer halo
  evGroups.append("circle")
    .attr("r", d => d.r + 5)
    .attr("fill", d => rgba(d.activityColor ?? "#64748b", 0.09))
    .attr("stroke", d => rgba(d.activityColor ?? "#64748b", 0.18))
    .attr("stroke-width", 1.2);

  // Main body
  evGroups.append("circle")
    .attr("r", d => d.r)
    .attr("fill", d => rgba(d.activityColor ?? "#64748b", 0.16))
    .attr("stroke", d => d.activityColor ?? "#64748b")
    .attr("stroke-width", 2.2);

  // Entity count — the key number inside every circle
  evGroups.append("text")
    .attr("text-anchor", "middle").attr("dy", "0.34em")
    .attr("font-family", "JetBrains Mono, monospace")
    .attr("font-size", d => `${Math.max(9, Math.min(13, d.r * 0.60))}px`)
    .attr("font-weight", "800")
    .attr("fill", d => d.activityColor ?? "#334155")
    .text(d => d.entityCount);

  // Activity label just below the axis tick mark
  lLabels.selectAll(null).data(eventNodes).join("text")
    .attr("x", d => d.x).attr("y", axisY + 15)
    .attr("text-anchor", "middle")
    .attr("font-family", "JetBrains Mono, monospace").attr("font-size", "8px")
    .attr("fill", d => rgba(d.activityColor ?? "#64748b", 0.70))
    .text(d => ellipsis(d.activity ?? "", 10));
}
