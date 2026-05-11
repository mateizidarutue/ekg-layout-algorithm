"use strict";

import { navigate } from "../router.js";

function _esc(str) {
  return String(str ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function _formatDate(date) {
  if (!date || !(date instanceof Date) || isNaN(date.getTime())) return "-";
  return date.toLocaleDateString("en-GB", { month: "short", day: "numeric", year: "numeric" });
}

export function renderExploreList(hotspots) {
  const host = document.getElementById("screen-host");
  if (!host) return;

  const totalEvents = hotspots.reduce((sum, h) => sum + h.eventCount, 0);
  const totalEntities = hotspots.reduce((sum, h) => sum + h.entityCount, 0);
  const topSync = hotspots.reduce((best, h) => Math.max(best, h.avgSyncDegree || 0), 0);

  host.innerHTML = `
    <div class="explore-screen">
      <div class="explore-summary-grid">
        <div class="explore-summary-card"><span>${hotspots.length.toLocaleString()}</span><b>activity clusters</b></div>
        <div class="explore-summary-card"><span>${totalEvents.toLocaleString()}</span><b>shared events</b></div>
        <div class="explore-summary-card"><span>${totalEntities.toLocaleString()}</span><b>entity touches</b></div>
        <div class="explore-summary-card"><span>${topSync.toFixed(1)}</span><b>max sync degree</b></div>
      </div>
      <div class="explore-toolbar">
        <input type="text" id="explore-search" class="explore-search" placeholder="Search by activity..." aria-label="Search activities" />
        <select id="explore-sort" class="explore-sort" aria-label="Sort hotspots">
          <option value="frequency">Sort: frequency</option>
          <option value="syncStrength">Sort: sync strength</option>
          <option value="recency">Sort: recency</option>
        </select>
      </div>
      <div id="hotspot-list-container"></div>
    </div>
  `;

  function _renderRows(list) {
    const container = host.querySelector("#hotspot-list-container");
    if (!list.length) {
      container.innerHTML = `<div style="color:var(--text-muted);padding:24px;text-align:center">No shared events found.</div>`;
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
            ${h.typePairs.length > 4 ? `<span>+${h.typePairs.length - 4}</span>` : ""}
          </div>
          <div class="hotspot-meta">
            Sync degree ${h.avgSyncDegree.toFixed(1)} - ${h.entityCount.toLocaleString()} entities - ${_formatDate(h.firstDate)} to ${_formatDate(h.lastDate)}
          </div>
          <div class="hotspot-bar" aria-hidden="true"><span style="width:${Math.max(6, Math.round((h.eventCount / maxEvents) * 100))}%"></span></div>
        </div>
        <div class="hotspot-count-wrap">
          <div class="hotspot-count">${h.eventCount}</div>
          <div class="hotspot-count-label">shared events</div>
        </div>
      </div>
    `).join("");

    container.querySelectorAll(".hotspot-row").forEach(row => {
      const handler = () => navigate("explore", { cluster: row.dataset.id });
      row.addEventListener("click", handler);
      row.addEventListener("keydown", e => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          handler();
        }
      });
    });
  }

  _renderRows([...hotspots]);

  const searchInput = host.querySelector("#explore-search");
  const sortSelect  = host.querySelector("#explore-sort");

  function _refilter() {
    const q = searchInput.value.trim().toLowerCase();
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

export function updateHotspotSummary(hotspot) {
  const panel = document.getElementById("hotspot-summary-content");
  if (!panel || !hotspot) return;
  panel.innerHTML = `
    <div class="stat-row"><span class="stat-label">Activity</span><span class="stat-val">${_esc(hotspot.activity)}</span></div>
    <div class="stat-row"><span class="stat-label">Shared events</span><span class="stat-val">${hotspot.eventCount}</span></div>
    <div class="stat-row"><span class="stat-label">Entities</span><span class="stat-val">${hotspot.entityCount}</span></div>
    <div class="stat-row"><span class="stat-label">Sync strength</span><span class="stat-val">${hotspot.avgSyncDegree.toFixed(2)}</span></div>
    <div class="stat-row"><span class="stat-label">Type pairs</span><span class="stat-val stat-val-flow">${hotspot.typePairs.map(_esc).join(", ") || "-"}</span></div>
    <button type="button" class="btn btn-sm" id="btn-back-to-hotspots" style="margin-top:10px;width:100%">All hotspots</button>
  `;
  panel.querySelector("#btn-back-to-hotspots")?.addEventListener("click", () => navigate("explore"));
}
