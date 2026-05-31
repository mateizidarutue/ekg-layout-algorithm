"use strict";

import { navigate } from "../router.js";
import { binEventsByMonth } from "../data/store.js";

function _esc(str) {
  return String(str ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function _formatDate(date) {
  if (!date || !(date instanceof Date) || isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("en-GB", { month: "short", day: "numeric", year: "numeric" });
}

// ── Chart helpers ─────────────────────────────────────────────────────────────

function _barChart(items, { valueKey, labelKey, colorKey, secondaryKey, secondaryLabel, maxItems = 10, onClickId } = {}) {
  const rows = items.slice(0, maxItems);
  if (!rows.length) return `<div class="t4-empty">No data available.</div>`;
  const maxVal = Math.max(...rows.map(r => r[valueKey]), 1);
  return `<div class="t4-bar-chart">
    ${rows.map((row, i) => {
      const pct = Math.max(4, Math.round((row[valueKey] / maxVal) * 100));
      const id = onClickId ? ` data-id="${_esc(onClickId(row))}" role="button" tabindex="0"` : "";
      const clickable = onClickId ? " t4-bar-row--clickable" : "";
      const secondary = secondaryKey
        ? `<span class="t4-bar-secondary">${row[secondaryKey].toLocaleString()} ${_esc(secondaryLabel ?? "")}</span>`
        : "";
      return `
        <div class="t4-bar-row${clickable}"${id}>
          <span class="t4-bar-rank">${i + 1}</span>
          <span class="t4-bar-swatch" style="background:${_esc(row[colorKey] ?? "#64748b")}"></span>
          <span class="t4-bar-label">${_esc(row[labelKey])}</span>
          <span class="t4-bar-track" aria-hidden="true">
            <span class="t4-bar-fill" style="width:${pct}%;background:${_esc(row[colorKey] ?? "#64748b")}"></span>
          </span>
          <span class="t4-bar-value">${row[valueKey].toLocaleString()}</span>
          ${secondary}
        </div>`;
    }).join("")}
  </div>`;
}

const _MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const _MONTHS_LONG  = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// Temporal context strip from year-month buckets ([{ key:"YYYY-MM", count }], sorted ascending).
// Labels are parsed straight from the key (MMM YY) so they are deterministic, locale-independent,
// and unique per distinct bucket — the year disambiguates repeated month names.
// When `interactive`, each column carries data-month so callers can wire click-to-filter; the
// `activeMonth` column is highlighted and reveals its count value.
function _overTimeStrip(buckets, { title = "Shared events over time", activeMonth = null, interactive = false } = {}) {
  if (!buckets?.length) return "";
  const maxCount = Math.max(...buckets.map(b => b.count), 1);
  return `
    <div class="ec-timeline-wrap">
      <div class="t4-list-header" style="margin-bottom:10px">
        <span class="t4-list-title">${_esc(title)}</span>
      </div>
      <div class="ec-timeline">
        ${buckets.map(({ key, count }) => {
          const [year, month] = key.split("-");
          const mi = Number(month) - 1;
          const label     = `${_MONTHS_SHORT[mi] ?? month} ${year.slice(2)}`;
          const fullLabel = `${_MONTHS_LONG[mi] ?? month} ${year}`;
          const pct = Math.max(2, Math.round((count / maxCount) * 100));
          const isActive = key === activeMonth;
          const attrs = interactive ? ` role="button" tabindex="0" data-month="${_esc(key)}"` : "";
          return `<div class="ec-tl-col${isActive ? " ec-tl-col--active" : ""}"${attrs}>
            <div class="ec-tl-value">${count.toLocaleString()}</div>
            <div class="ec-tl-bar-wrap">
              <div class="ec-tl-bar" style="height:${pct}%" title="${count.toLocaleString()} events — ${_esc(fullLabel)}"></div>
            </div>
            <div class="ec-tl-label" title="${_esc(fullLabel)}">${_esc(label)}</div>
          </div>`;
        }).join("")}
      </div>
    </div>`;
}

// Wires click / keyboard activation on an interactive strip to a month-select callback.
function _attachStripHandlers(host, onMonthSelect) {
  if (!onMonthSelect) return;
  host.querySelectorAll(".ec-tl-col[data-month]").forEach(col => {
    const go = () => onMonthSelect(col.dataset.month);
    col.addEventListener("click", go);
    col.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
  });
}

// ── Main render functions ─────────────────────────────────────────────────────

export function renderExploreList(hotspots, { degreeFloor = 2, onDegreeFloorChange = null, timeBuckets = [], activeMonth = null, onMonthSelect = null, clusterNavParams = null } = {}) {
  const host = document.getElementById("screen-host");
  if (!host) return;

  host.innerHTML = `
    <div class="explore-screen">

      ${_overTimeStrip(timeBuckets, { title: "Shared events over time", activeMonth, interactive: Boolean(onMonthSelect) })}

      <!-- Full hotspot list -->
      <div class="t4-list-section">
        <div class="t4-list-header">
          <span class="t4-list-title">All shared-event clusters</span>
          <div class="t4-list-controls">
            <input type="text" id="explore-search" class="explore-search" placeholder="Search activity…" aria-label="Search activities" />
            <input type="number" id="explore-degree-floor" class="explore-sort" min="2" step="1" value="${_esc(String(degreeFloor))}" title="Minimum sync degree" aria-label="Minimum sync degree" />
            <select id="explore-sort" class="explore-sort" aria-label="Sort">
              <option value="syncStrength">Sort: sync degree</option>
              <option value="frequency">Sort: frequency</option>
              <option value="recency">Sort: recency</option>
            </select>
          </div>
        </div>
        <div id="hotspot-list-container"></div>
      </div>

    </div>
  `;

  function _renderRows(list) {
    const container = host.querySelector("#hotspot-list-container");
    if (!list.length) {
      container.innerHTML = `<div class="t4-empty" style="padding:24px;text-align:center">No shared events match the current filter.</div>`;
      return;
    }
    const maxEvents = Math.max(...list.map(h => h.eventCount), 1);
    container.innerHTML = list.map(h => {
      // Graduated swatch: a higher average sync degree renders a larger dot.
      // Refinement of the binary shared/single channel — base 10px (the CSS
      // default), growing with degree above the floor of 2.
      const swatchSize = (8 + Math.min(Math.max(h.avgSyncDegree - 2, 0), 5) * 1.6).toFixed(1);
      return `
      <div class="hotspot-row" data-id="${_esc(h.id)}" role="button" tabindex="0">
        <div class="hotspot-main">
          <div class="hotspot-activity">
            <span class="hotspot-swatch" style="background:${_esc(h.color)};width:${swatchSize}px;height:${swatchSize}px" title="Sync degree ${h.avgSyncDegree.toFixed(1)}"></span>
            ${_esc(h.activity)}
          </div>
          <div class="hotspot-pairs">
            ${h.typePairs.slice(0, 4).map(pair => `<span>${_esc(pair)}</span>`).join("")}
            ${h.typePairs.length > 4 ? `<span>+${h.typePairs.length - 4} more</span>` : ""}
          </div>
          <div class="hotspot-meta">
            Sync degree ${h.avgSyncDegree.toFixed(1)} · ${h.entityCount.toLocaleString()} entities · ${_formatDate(h.firstDate)} – ${_formatDate(h.lastDate)}
          </div>
          <div class="hotspot-bar" aria-hidden="true"><span style="width:${Math.max(6, Math.round((h.eventCount / maxEvents) * 100))}%"></span></div>
        </div>
        <div class="hotspot-count-wrap">
          <div class="hotspot-count">${h.eventCount.toLocaleString()}</div>
          <div class="hotspot-count-label">shared events</div>
        </div>
      </div>
    `;
    }).join("");

    container.querySelectorAll(".hotspot-row").forEach(row => {
      const go = () => navigate("explore", { cluster: row.dataset.id, ...(clusterNavParams ?? {}) });
      row.addEventListener("click", go);
      row.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
    });
  }

  _renderRows([...hotspots]);
  _attachStripHandlers(host, onMonthSelect);

  const searchInput = host.querySelector("#explore-search");
  const sortSelect  = host.querySelector("#explore-sort");
  const floorInput  = host.querySelector("#explore-degree-floor");

  function _refilter() {
    const q    = searchInput.value.trim().toLowerCase();
    const sort = sortSelect.value;
    let filtered = hotspots.filter(h => !q || h.activity.toLowerCase().includes(q));
    if (sort === "recency") filtered.sort((a, b) => (b.lastDate?.getTime() ?? 0) - (a.lastDate?.getTime() ?? 0));
    else if (sort === "frequency") filtered.sort((a, b) => b.eventCount - a.eventCount || a.activity.localeCompare(b.activity));
    else filtered.sort(_bySyncDegree);
    _renderRows(filtered);
  }

  searchInput.addEventListener("input", _refilter);
  sortSelect.addEventListener("change", _refilter);
  floorInput?.addEventListener("change", () => {
    const next = Math.max(2, Math.floor(Number(floorInput.value) || 2));
    floorInput.value = String(next);
    onDegreeFloorChange?.(next);
  });
}

// Deterministic ranking for the hotspot list: synchronization degree desc,
// then participation frequency desc, then activity identifier asc. Same data
// + same floor always yields the same order.
function _bySyncDegree(a, b) {
  return b.avgSyncDegree - a.avgSyncDegree
    || b.eventCount - a.eventCount
    || a.activity.localeCompare(b.activity);
}

export function renderExploreClusterDetail(graph) {
  const host = document.getElementById("screen-host");
  if (!host) return;

  const events = graph?.eventAnchors ?? [];
  const bands  = graph?.bands ?? [];

  // ── Hero stats ─────────────────────────────────────────────────────────────
  const dates = events.map(e => e.date).filter(d => d instanceof Date && !isNaN(d.getTime()));
  const firstDate     = dates.length ? new Date(Math.min(...dates.map(d => d.getTime()))) : null;
  const lastDate      = dates.length ? new Date(Math.max(...dates.map(d => d.getTime()))) : null;
  const totalEntities = bands.reduce((s, b) => s + b.lanes.length, 0);
  const avgEntities   = events.length
    ? (events.reduce((s, e) => s + (e.sharedEntityIds?.length ?? 0), 0) / events.length).toFixed(1)
    : "—";

  // ── P1: entity-count histogram ─────────────────────────────────────────────
  const countDist = {};
  events.forEach(e => {
    const n = e.sharedEntityIds?.length ?? 0;
    if (n >= 2) countDist[n] = (countDist[n] ?? 0) + 1;
  });
  const distKeys  = Object.keys(countDist).map(Number).sort((a, b) => a - b);
  const maxDistVal = Math.max(...distKeys.map(k => countDist[k]), 1);

  // ── P2: entity type participation ──────────────────────────────────────────
  const typeRows = bands.map(b => ({
    label: b.entityLabel ?? b.entityType,
    count: b.lanes.length,
    color: "#64748b",
  })).sort((a, b) => b.count - a.count);

  // ── P3: type-pair co-participation ─────────────────────────────────────────
  const pairCounts = {};
  events.forEach(e => {
    const types = [...new Set(e.sharedEntityTypes ?? [])];
    for (let i = 0; i < types.length; i++) {
      for (let j = i + 1; j < types.length; j++) {
        const key = [types[i], types[j]].sort().join(" × ");
        pairCounts[key] = (pairCounts[key] ?? 0) + 1;
      }
    }
  });
  const topPairs    = Object.entries(pairCounts).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const maxPairCount = Math.max(...topPairs.map(([, c]) => c), 1);

  // ── P4: top entities by participation count ────────────────────────────────
  const entityCounts = {};
  events.forEach(e => { (e.sharedEntityIds ?? []).forEach(id => { entityCounts[id] = (entityCounts[id] ?? 0) + 1; }); });
  const topEntities = Object.entries(entityCounts)
    .sort((a, b) => b[1] - a[1]).slice(0, 12)
    .map(([id, count]) => {
      let label = id, type = "";
      for (const b of bands) {
        const lane = b.lanes.find(l => l.entity_id === id);
        if (lane) { label = lane.entityLabel ?? id; type = b.entityType; break; }
      }
      return { id, label, type, count };
    });
  const maxEntityCount = Math.max(...topEntities.map(r => r.count), 1);

  // ── Temporal histogram (by year-month) ─────────────────────────────────────
  const monthBuckets = binEventsByMonth(events);

  host.innerHTML = `
    <div class="ec-screen">

      <div class="t4-hero">
        <div class="t4-hero-stat">
          <span class="t4-hero-value">${events.length.toLocaleString()}</span>
          <span class="t4-hero-label">shared events</span>
        </div>
        <div class="t4-hero-sep"></div>
        <div class="t4-hero-stat">
          <span class="t4-hero-value">${totalEntities.toLocaleString()}</span>
          <span class="t4-hero-label">entities</span>
        </div>
        <div class="t4-hero-sep"></div>
        <div class="t4-hero-stat">
          <span class="t4-hero-value">${avgEntities}</span>
          <span class="t4-hero-label">avg entities / event</span>
        </div>
        <div class="t4-hero-sep"></div>
        <div class="t4-hero-stat">
          <span class="t4-hero-value">${bands.length}</span>
          <span class="t4-hero-label">entity types</span>
        </div>
        <div class="t4-hero-sep"></div>
        <div class="t4-hero-stat">
          <span class="t4-hero-value">${firstDate ? _formatDate(firstDate) : "—"} – ${lastDate ? _formatDate(lastDate) : "—"}</span>
          <span class="t4-hero-label">date range</span>
        </div>
      </div>

      <div class="t4-panels ec-panels">

        <section class="t4-panel">
          <div class="t4-panel-header">
            <span class="t4-panel-badge">P1</span>
            <span class="t4-panel-title">Entity-count distribution</span>
          </div>
          <p class="t4-panel-desc">How many shared events had exactly N co-participating entities?</p>
          <div class="ec-hist">
            ${distKeys.length ? distKeys.map(k => {
              const v = countDist[k];
              const pct = Math.max(4, Math.round((v / maxDistVal) * 100));
              return `<div class="ec-hist-col">
                <div class="ec-hist-count">${v >= 1000 ? (v / 1000).toFixed(1) + "k" : v}</div>
                <div class="ec-hist-bar-wrap">
                  <div class="ec-hist-bar" style="height:${pct}%" title="${v.toLocaleString()} shared events with ${k} co-participating entities"></div>
                </div>
                <div class="ec-hist-label">${k}</div>
              </div>`;
            }).join("") : `<div class="t4-empty">No data.</div>`}
          </div>
          ${distKeys.length ? `<div class="ec-hist-axis-note"><span class="ec-hist-key ec-hist-key--events">bar value = shared events</span><span class="ec-hist-key ec-hist-key--entities">x-axis = co-participating entities</span></div>` : ""}
        </section>

        <section class="t4-panel">
          <div class="t4-panel-header">
            <span class="t4-panel-badge">P2</span>
            <span class="t4-panel-title">Entities per type</span>
          </div>
          <p class="t4-panel-desc">Distinct entities of each type involved in this activity's shared events.</p>
          ${_barChart(typeRows, { valueKey: "count", labelKey: "label", colorKey: "color", maxItems: 10 })}
        </section>

        <section class="t4-panel">
          <div class="t4-panel-header">
            <span class="t4-panel-badge">P3</span>
            <span class="t4-panel-title">Type-pair co-participation</span>
          </div>
          <p class="t4-panel-desc">Which pairs of entity types appear together in the same shared event?</p>
          <div class="t4-bar-chart">
            ${topPairs.length ? topPairs.map(([pair, count], i) => {
              const pct = Math.max(4, Math.round((count / maxPairCount) * 100));
              return `<div class="t4-bar-row">
                <span class="t4-bar-rank">${i + 1}</span>
                <span class="t4-bar-swatch" style="background:#2563eb"></span>
                <span class="t4-bar-label">${_esc(pair)}</span>
                <span class="t4-bar-track"><span class="t4-bar-fill" style="width:${pct}%;background:#2563eb"></span></span>
                <span class="t4-bar-value">${count.toLocaleString()}</span>
              </div>`;
            }).join("") : `<div class="t4-empty">No type pairs found.</div>`}
          </div>
        </section>

        <section class="t4-panel">
          <div class="t4-panel-header">
            <span class="t4-panel-badge">P4</span>
            <span class="t4-panel-title">Most active entities</span>
          </div>
          <p class="t4-panel-desc">Entities that participate in the most shared events of this activity.</p>
          <div class="t4-bar-chart">
            ${topEntities.length ? topEntities.map((row, i) => {
              const pct = Math.max(4, Math.round((row.count / maxEntityCount) * 100));
              return `<div class="t4-bar-row t4-bar-row--clickable" data-entity-id="${_esc(row.id)}" role="button" tabindex="0" title="Open ${_esc(row.label)} in the Lifecycle (Detail) view">
                <span class="t4-bar-rank">${i + 1}</span>
                <span class="t4-bar-swatch" style="background:#0891b2"></span>
                <span class="t4-bar-label">${_esc(row.label)}<span class="t4-bar-type-tag">${_esc(row.type)}</span></span>
                <span class="t4-bar-track"><span class="t4-bar-fill" style="width:${pct}%;background:#0891b2"></span></span>
                <span class="t4-bar-value">${row.count}</span>
              </div>`;
            }).join("") : `<div class="t4-empty">No entity data.</div>`}
          </div>
        </section>

      </div>

      ${_overTimeStrip(monthBuckets, { title: "Shared events over time" })}

    </div>
  `;

  // P4 "Most active entities" rows open the entity in the T2 Lifecycle (Detail) view.
  host.querySelectorAll(".t4-bar-row--clickable[data-entity-id]").forEach(row => {
    const go = () => navigate("identify", { entity: row.dataset.entityId });
    row.addEventListener("click", go);
    row.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
  });
}

export function updateHotspotSummary(hotspot) {
  const panel = document.getElementById("hotspot-summary-content");
  if (!panel || !hotspot) return;
  panel.innerHTML = `
    <div class="stat-row"><span class="stat-label">Activity</span><span class="stat-val">${_esc(hotspot.activity)}</span></div>
    <div class="stat-row"><span class="stat-label">Shared events</span><span class="stat-val">${hotspot.eventCount}</span></div>
    <div class="stat-row"><span class="stat-label">Entities</span><span class="stat-val">${hotspot.entityCount}</span></div>
    <div class="stat-row"><span class="stat-label">Sync degree</span><span class="stat-val">${hotspot.avgSyncDegree.toFixed(2)}</span></div>
    <div class="stat-row"><span class="stat-label">Type pairs</span><span class="stat-val stat-val-flow">${hotspot.typePairs.map(_esc).join(", ") || "—"}</span></div>
    <button type="button" class="btn btn-sm" id="btn-back-to-hotspots" style="margin-top:10px;width:100%">All hotspots</button>
  `;
  panel.querySelector("#btn-back-to-hotspots")?.addEventListener("click", () => navigate("explore"));
}
