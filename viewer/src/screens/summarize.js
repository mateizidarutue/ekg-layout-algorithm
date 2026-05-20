"use strict";

import { navigate } from "../router.js";

const _esc = str => String(str ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const _fmt = n => (typeof n === "number" ? n.toLocaleString() : String(n ?? "—"));
const _pct = f => `${Math.round((f ?? 0) * 100)}%`;

function _fmtHours(h) {
  if (!Number.isFinite(h)) return "—";
  if (h >= 24 * 30) return `${(h / (24 * 30)).toFixed(1)} mo`;
  if (h >= 24 * 7)  return `${(h / (24 * 7)).toFixed(1)} w`;
  if (h >= 24)      return `${(h / 24).toFixed(1)} d`;
  return `${h.toFixed(1)} h`;
}

function _fmtDate(d) {
  if (!(d instanceof Date) || isNaN(d)) return null;
  return d.toLocaleDateString("en-GB", { month: "short", year: "numeric" });
}

export function renderSummarizeScreen(variantData) {
  const host = document.getElementById("screen-host");
  if (!host) return;

  const variants      = variantData?.variants ?? [];
  const totalInst     = variantData?.totalInstances ?? 0;
  const variantCount  = variantData?.variantCount ?? 0;
  const shownCount    = variants.length;
  const caseType      = variantData?.caseType ?? "Case";
  const maxFreq       = variants[0]?.frequency ?? 1;

  if (!variants.length) {
    host.innerHTML = `<div class="sc-screen"><div class="sc-empty">No variant data — apply an activity filter or load a dataset first.</div></div>`;
    return;
  }

  const cards = variants.map((v, i) => {
    const pct  = Math.round((v.frequency ?? 0) * 100);
    const barW = maxFreq > 0 ? Math.round((v.frequency / maxFreq) * 100) : 0;
    const seq  = v.sequence ?? [];
    const seqLabel = seq.length ? seq.join(" → ") : "(empty sequence)";
    const seqShort = seqLabel.length > 96 ? seqLabel.slice(0, 93) + "…" : seqLabel;

    const dateStr = (() => {
      const a = _fmtDate(v.firstDate), b = _fmtDate(v.lastDate);
      if (!a && !b) return null;
      if (a === b || !b) return a ?? "";
      if (!a) return b;
      return `${a} – ${b}`;
    })();

    const stats = [
      `${_fmt(v.count)} ${v.count === 1 ? caseType.toLowerCase() : caseType.toLowerCase() + "s"}`,
      v.memberCount != null ? `${_fmt(v.memberCount)} member${v.memberCount === 1 ? "" : "s"}` : null,
      v.eventTotal  != null ? `${_fmt(v.eventTotal)} events` : null,
      Number.isFinite(v.avgDurationHours) ? `avg ${_fmtHours(v.avgDurationHours)}` : null,
    ].filter(Boolean);

    return `
      <div class="sc-card${v.isdominant ? " sc-card--dominant" : ""}" data-variant-key="${_esc(v.key ?? "")}">
        <div class="sc-card-head">
          <span class="sc-rank${v.isdominant ? " sc-rank--top" : ""}">V${i + 1}${v.isdominant ? " ★" : ""}</span>
          <span class="sc-pct">${pct}%</span>
        </div>
        <div class="sc-seq" title="${_esc(seqLabel)}">${_esc(seqShort)}</div>
        <div class="sc-bar-wrap"><div class="sc-bar" style="width:${barW}%"></div></div>
        <div class="sc-stats">
          ${stats.map(s => `<span>${_esc(s)}</span>`).join('<span class="sc-sep">·</span>')}
        </div>
        ${dateStr ? `<div class="sc-date">${_esc(dateStr)}</div>` : ""}
        <button type="button" class="sc-btn" data-variant-key="${_esc(v.key ?? "")}">View variant →</button>
      </div>
    `;
  }).join("");

  const hiddenCount = variantCount - shownCount;
  const footerHtml  = hiddenCount > 0
    ? `<div class="sc-footer-note">Showing top ${shownCount} of ${variantCount} variants · ${hiddenCount} more not shown — use the activity filter to narrow the scope.</div>`
    : `<div class="sc-footer-note">All ${variantCount} variant${variantCount === 1 ? "" : "s"} shown.</div>`;

  host.innerHTML = `
    <div class="sc-screen">
      <div class="sc-header">
        <div class="sc-header-title">Process Variants</div>
        <div class="sc-header-sub">${_fmt(variantCount)} variant${variantCount === 1 ? "" : "s"} · ${_fmt(totalInst)} ${caseType.toLowerCase()}${totalInst === 1 ? "" : "s"} total</div>
      </div>
      <div class="sc-grid">${cards}</div>
      ${footerHtml}
    </div>
  `;

  host.querySelectorAll(".sc-btn[data-variant-key]").forEach(btn => {
    btn.addEventListener("click", e => {
      e.stopPropagation();
      navigate("compare", { variant: btn.dataset.variantKey });
    });
  });

  host.querySelectorAll(".sc-card[data-variant-key]").forEach(card => {
    card.addEventListener("click", () => {
      navigate("compare", { variant: card.dataset.variantKey });
    });
  });
}

export function updateSummarizeSidebar(typeEKG) {
  const title   = document.getElementById("overview-summary-title");
  const content = document.getElementById("overview-summary-content");
  if (!title || !content) return;

  if (!typeEKG) {
    title.textContent = "EKG Overview";
    content.innerHTML = `<div class="stat-row"><span class="stat-label">Navigate to the overview screen to see EKG statistics.</span></div>`;
    return;
  }

  title.textContent = "EKG Overview";
  const minDate = typeEKG.minTime ? new Date(typeEKG.minTime).toLocaleDateString("en-GB", { month: "short", year: "numeric" }) : "—";
  const maxDate = typeEKG.maxTime ? new Date(typeEKG.maxTime).toLocaleDateString("en-GB", { month: "short", year: "numeric" }) : "—";
  const rows = [
    { label: "Entity types",  value: _fmt(typeEKG.entityTypes.length) },
    { label: "Total events",  value: _fmt(typeEKG.totalEvents) },
    { label: "Sync arcs",     value: _fmt(typeEKG.syncArcs.length) },
    { label: "Time span",     value: minDate === maxDate ? minDate : `${minDate} – ${maxDate}` },
  ];
  content.innerHTML = rows.map(r =>
    `<div class="stat-row"><span class="stat-label">${_esc(r.label)}</span><span class="stat-value">${_esc(String(r.value))}</span></div>`
  ).join("");
}
