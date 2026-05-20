"use strict";

import { navigate } from "../router.js";

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

function _entityBreadthChart(items, { maxItems = 8 } = {}) {
  const rows = items.slice(0, maxItems);
  if (!rows.length) return `<div class="t4-empty">No data available.</div>`;
  const maxCount = Math.max(...rows.map(r => r.entityCount), 1);
  return `<div class="t4-breadth-chart">
    ${rows.map((row, i) => {
      const arcPct = row.entityCount / maxCount;
      const typesLabel = (row.entityTypes ?? []).join(" · ") || "n/a";
      const dateLabel = _formatDate(row.timestamp);
      return `
        <div class="t4-breadth-row">
          <div class="t4-breadth-count-wrap">
            <svg class="t4-breadth-arc" viewBox="0 0 36 36" aria-hidden="true">
              <circle cx="18" cy="18" r="15.9" fill="none" stroke="rgba(37,99,235,0.10)" stroke-width="3.2"/>
              <circle cx="18" cy="18" r="15.9" fill="none" stroke="${_esc(row.color ?? "#2563eb")}"
                stroke-width="3.2" stroke-dasharray="${(arcPct * 100).toFixed(1)} 100"
                stroke-linecap="round" transform="rotate(-90 18 18)"/>
            </svg>
            <span class="t4-breadth-count" style="color:${_esc(row.color ?? "#2563eb")}">${row.entityCount}</span>
          </div>
          <div class="t4-breadth-info">
            <span class="t4-breadth-activity">${_esc(row.activity)}</span>
            <span class="t4-breadth-types">${_esc(typesLabel)}</span>
            <span class="t4-breadth-date">${_esc(dateLabel)}</span>
          </div>
          <span class="t4-breadth-rank">#${i + 1}</span>
        </div>`;
    }).join("")}
  </div>`;
}

function _typePairChart(items, { maxItems = 10 } = {}) {
  const rows = items.slice(0, maxItems);
  if (!rows.length) return `<div class="t4-empty">No data available.</div>`;
  const maxEvents = Math.max(...rows.map(r => r.eventCount), 1);
  const maxEntities = Math.max(...rows.map(r => r.entityCount), 1);
  return `<div class="t4-pair-chart">
    <div class="t4-pair-header">
      <span class="t4-pair-col-label">Type pair</span>
      <span class="t4-pair-col-label t4-pair-col-right">Events</span>
      <span class="t4-pair-col-label t4-pair-col-right">Entities</span>
    </div>
    ${rows.map((row, i) => {
      const eventPct = Math.max(3, Math.round((row.eventCount / maxEvents) * 100));
      const entityPct = Math.max(3, Math.round((row.entityCount / maxEntities) * 100));
      const [typeA, typeB] = row.pair.split(" -> ");
      return `
        <div class="t4-pair-row">
          <span class="t4-pair-rank">${i + 1}</span>
          <span class="t4-pair-label">
            <span class="t4-pair-type">${_esc(typeA ?? row.pair)}</span>
            <span class="t4-pair-arrow">↔</span>
            <span class="t4-pair-type">${_esc(typeB ?? "")}</span>
          </span>
          <span class="t4-pair-bar-wrap">
            <span class="t4-pair-bar t4-pair-bar--events" style="width:${eventPct}%" title="${row.eventCount} events"></span>
            <span class="t4-pair-count">${row.eventCount.toLocaleString()}</span>
          </span>
          <span class="t4-pair-bar-wrap">
            <span class="t4-pair-bar t4-pair-bar--entities" style="width:${entityPct}%" title="${row.entityCount} entities"></span>
            <span class="t4-pair-count">${row.entityCount.toLocaleString()}</span>
          </span>
        </div>`;
    }).join("")}
  </div>`;
}

// ── Main render functions ─────────────────────────────────────────────────────

export function renderExploreList(hotspots, overview = null) {
  const host = document.getElementById("screen-host");
  if (!host) return;

  const totalSharedEvents = overview?.totalSharedEvents ?? hotspots.reduce((s, h) => s + h.eventCount, 0);
  const totalEntities     = overview?.totalSharedEntities ?? hotspots.reduce((s, h) => s + h.entityCount, 0);
  const topSync           = hotspots.reduce((best, h) => Math.max(best, h.avgSyncDegree || 0), 0);

  host.innerHTML = `
    <div class="explore-screen">

      <!-- Hero summary -->
      <div class="t4-hero">
        <div class="t4-hero-stat">
          <span class="t4-hero-value">${hotspots.length.toLocaleString()}</span>
          <span class="t4-hero-label">shared-event activities</span>
        </div>
        <div class="t4-hero-sep"></div>
        <div class="t4-hero-stat">
          <span class="t4-hero-value">${totalSharedEvents.toLocaleString()}</span>
          <span class="t4-hero-label">shared events total</span>
        </div>
        <div class="t4-hero-sep"></div>
        <div class="t4-hero-stat">
          <span class="t4-hero-value">${topSync.toFixed(1)}</span>
          <span class="t4-hero-label">max sync degree</span>
        </div>
      </div>

      <!-- Three analytical panels -->
      <div class="t4-panels">

        <!-- Q1: Most common -->
        <section class="t4-panel">
          <div class="t4-panel-header">
            <span class="t4-panel-badge">Q1</span>
            <span class="t4-panel-title">Most frequent shared activities</span>
          </div>
          <p class="t4-panel-desc">Activities ranked by how many shared events they produced. Click a row to explore.</p>
          ${_barChart(overview?.topActivities ?? hotspots.slice(0, 10), {
            valueKey: "eventCount",
            labelKey: "activity",
            colorKey: "color",
            secondaryKey: "entityCount",
            secondaryLabel: "entities",
            maxItems: 10,
            onClickId: row => row.id,
          })}
        </section>

        <!-- Q2: Most entities per event -->
        <section class="t4-panel">
          <div class="t4-panel-header">
            <span class="t4-panel-badge">Q2</span>
            <span class="t4-panel-title">Highest entity breadth</span>
          </div>
          <p class="t4-panel-desc">Individual events where the most distinct entity types co-participated simultaneously.</p>
          ${_entityBreadthChart(overview?.topEntityEvents ?? [], { maxItems: 8 })}
        </section>

        <!-- Q3: Entity type pairs -->
        <section class="t4-panel">
          <div class="t4-panel-header">
            <span class="t4-panel-badge">Q3</span>
            <span class="t4-panel-title">Entity type co-participation</span>
          </div>
          <p class="t4-panel-desc">Which pairs of entity types appear together in shared events, by event count and entity reach.</p>
          ${_typePairChart(overview?.topTypePairs ?? [], { maxItems: 10 })}
        </section>

      </div>

      <!-- Full hotspot list -->
      <div class="t4-list-section">
        <div class="t4-list-header">
          <span class="t4-list-title">All shared-event clusters</span>
          <div class="t4-list-controls">
            <input type="text" id="explore-search" class="explore-search" placeholder="Search activity…" aria-label="Search activities" />
            <select id="explore-sort" class="explore-sort" aria-label="Sort">
              <option value="frequency">Sort: frequency</option>
              <option value="syncStrength">Sort: sync degree</option>
              <option value="recency">Sort: recency</option>
            </select>
          </div>
        </div>
        <div id="hotspot-list-container"></div>
      </div>

    </div>
  `;

  // Attach Q1 click handlers
  host.querySelectorAll(".t4-bar-row--clickable[data-id]").forEach(row => {
    row.addEventListener("click", () => navigate("explore", { cluster: row.dataset.id }));
    row.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); navigate("explore", { cluster: row.dataset.id }); } });
  });

  function _renderRows(list) {
    const container = host.querySelector("#hotspot-list-container");
    if (!list.length) {
      container.innerHTML = `<div class="t4-empty" style="padding:24px;text-align:center">No shared events match the current filter.</div>`;
      return;
    }
    const maxEvents = Math.max(...list.map(h => h.eventCount), 1);
    container.innerHTML = list.map(h => `
      <div class="hotspot-row" data-id="${_esc(h.id)}" role="button" tabindex="0">
        <div class="hotspot-main">
          <div class="hotspot-activity">
            <span class="hotspot-swatch" style="background:${_esc(h.color)}"></span>
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
    `).join("");

    container.querySelectorAll(".hotspot-row").forEach(row => {
      const go = () => navigate("explore", { cluster: row.dataset.id });
      row.addEventListener("click", go);
      row.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
    });
  }

  _renderRows([...hotspots]);

  const searchInput = host.querySelector("#explore-search");
  const sortSelect  = host.querySelector("#explore-sort");

  function _refilter() {
    const q    = searchInput.value.trim().toLowerCase();
    const sort = sortSelect.value;
    let filtered = hotspots.filter(h => !q || h.activity.toLowerCase().includes(q));
    if (sort === "syncStrength") filtered.sort((a, b) => b.avgSyncDegree - a.avgSyncDegree);
    else if (sort === "recency") filtered.sort((a, b) => (b.lastDate?.getTime() ?? 0) - (a.lastDate?.getTime() ?? 0));
    else filtered.sort((a, b) => b.eventCount - a.eventCount || a.activity.localeCompare(b.activity));
    _renderRows(filtered);
  }

  searchInput.addEventListener("input", _refilter);
  sortSelect.addEventListener("change", _refilter);
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
      return { label, type, count };
    });
  const maxEntityCount = Math.max(...topEntities.map(r => r.count), 1);

  // ── Temporal histogram (by month) ──────────────────────────────────────────
  const monthMap = new Map();
  events.forEach(e => {
    if (!(e.date instanceof Date) || isNaN(e.date.getTime())) return;
    const key = e.date.toISOString().slice(0, 7);
    monthMap.set(key, (monthMap.get(key) ?? 0) + 1);
  });
  const sortedMonths  = [...monthMap.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const maxMonthCount = Math.max(...sortedMonths.map(([, c]) => c), 1);

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
                <div class="ec-hist-bar-wrap">
                  <div class="ec-hist-bar" style="height:${pct}%" title="${v.toLocaleString()} events with ${k} entities"></div>
                </div>
                <div class="ec-hist-label">${k}</div>
                <div class="ec-hist-count">${v >= 1000 ? (v / 1000).toFixed(1) + "k" : v}</div>
              </div>`;
            }).join("") : `<div class="t4-empty">No data.</div>`}
          </div>
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
              return `<div class="t4-bar-row">
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

      ${sortedMonths.length ? `
      <div class="ec-timeline-wrap">
        <div class="t4-list-header" style="margin-bottom:10px">
          <span class="t4-list-title">Shared events over time</span>
        </div>
        <div class="ec-timeline">
          ${sortedMonths.map(([month, count]) => {
            const pct = Math.max(2, Math.round((count / maxMonthCount) * 100));
            const label    = new Date(month + "-01").toLocaleDateString("en-GB", { month: "short" });
            const fullLabel = new Date(month + "-01").toLocaleDateString("en-GB", { month: "long", year: "numeric" });
            return `<div class="ec-tl-col">
              <div class="ec-tl-bar-wrap">
                <div class="ec-tl-bar" style="height:${pct}%" title="${count.toLocaleString()} events — ${_esc(fullLabel)}"></div>
              </div>
              <div class="ec-tl-label" title="${_esc(fullLabel)}">${_esc(label)}</div>
            </div>`;
          }).join("")}
        </div>
      </div>` : ""}

    </div>
  `;
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
