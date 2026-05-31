"use strict";

import { navigate } from "../router.js";
import { getVariantOverview } from "../data/store.js";

const PRIMARY_TASK = {
  id: "T1", route: "summarize", label: "Lifecycle (Population)",
  tuple: "⟨Summarize, Topology⟩",
  desc: "Every event of every entity in one Canvas 2D dotted-chart: time on x, activity rows within entity-type bands on y, entity-type colour. Click any dot to highlight that entity's full trace plus every entity co-participating at the selected event (one-hop propagation across correlations); the band's activity rows reorder so the primary trace runs as a top-left → bottom-right diagonal. Brush the mini axis below the canvas to zoom a time window.",
};

const SUPPORTING_TASKS = [
  {
    id: "T2", route: "identify", label: "Lifecycle (Detail)",
    tuple: "⟨Identify, Path⟩",
    desc: "Open one entity and read its full multi-band detail slice — bottleneck waits, vertical shared-event spines, optional correlation and structural-relation overlays. Drag horizontally on the canvas to zoom a time window; hover any event for a tooltip listing every correlated entity, each clickable to jump to its lifecycle.",
  },
  {
    id: "T3", route: "compare", label: "Compare",
    tuple: "⟨Compare, Paths⟩",
    desc: "Group entities into behavioural variants ranked by frequency, then \"Compare top N\" opens a variant-scoped multi-lifeline canvas where children are grouped on the y axis by their parent case.",
  },
  {
    id: "T4", route: "explore", label: "Explore",
    tuple: "⟨Explore, Features⟩",
    desc: "Find shared events where multiple entity lifecycles intersect — the synchronisation points that distinguish object-centric processes from flat event logs. Raise the degree floor to focus on the most heavily-synchronised activities.",
  },
];

function _formatDate(date) {
  if (!date || !(date instanceof Date) || isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("en-GB", { year: "numeric", month: "short", day: "numeric" });
}

export function renderHome(store, manifest, currentDatasetName) {
  const host = document.getElementById("screen-host");
  if (!host) return;

  const variantCount = (() => {
    try { return getVariantOverview({}).variantCount; } catch { return "—"; }
  })();

  const allDates = store.events.map(e => e.date?.getTime()).filter(Number.isFinite);
  const firstDate = allDates.length ? new Date(Math.min(...allDates)) : null;
  const lastDate  = allDates.length ? new Date(Math.max(...allDates)) : null;
  const typeCount = Object.keys(store.entityIdsByType ?? {}).length;

  const reg = store.typeRegistry;

  host.innerHTML = `
    <div class="home-screen">

      <!-- Dataset header -->
      <section>
        <div class="home-dataset-header">
          <div>
            <div class="home-dataset-title">${_esc(currentDatasetName.charAt(0).toUpperCase() + currentDatasetName.slice(1))}</div>
            <div class="home-dataset-subtitle">
              ${store.events.length.toLocaleString()} events ·
              ${store.entities.length.toLocaleString()} entities ·
              ${firstDate ? `${_formatDate(firstDate)} → ${_formatDate(lastDate)}` : "no dates"}
            </div>
          </div>
          <button type="button" class="topbar-btn" id="home-switch-btn">Switch dataset</button>
        </div>
      </section>

      <!-- Stats tiles -->
      <section>
        <div class="home-stat-grid">
          ${_statCard(store.entities.length.toLocaleString(), "Entities")}
          ${_statCard(typeCount.toLocaleString(), "Entity types")}
          ${_statCard(store.events.length.toLocaleString(), "Events")}
          ${_statCard(store.allActivities.length.toLocaleString(), "Activities")}
          ${_statCard(String(variantCount), "Variants")}
        </div>

        <table class="home-type-table" style="margin-top:18px">
          <thead>
            <tr><th>Entity type</th><th>Role</th><th style="text-align:right">Count</th></tr>
          </thead>
          <tbody>
            ${(reg?.types ?? []).map(t => `
              <tr>
                <td><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${_esc(t.color)};margin-right:7px;vertical-align:middle"></span>${_esc(t.displayLabel)}</td>
                <td><span class="role-chip role-chip-${t.role}">${t.role}</span></td>
                <td style="text-align:right;font-family:'JetBrains Mono',monospace;font-size:11px">${t.count.toLocaleString()}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </section>

      <!-- Primary task: Complete EKG Atlas -->
      <section>
        <a href="${_esc("#/" + PRIMARY_TASK.route)}" class="task-card task-card--primary" data-route="${_esc(PRIMARY_TASK.route)}">
          <span class="task-card-badge task-card-badge-${_esc(PRIMARY_TASK.id)}">${_esc(PRIMARY_TASK.id)}</span>
          <span class="task-card-tuple">${_esc(PRIMARY_TASK.tuple)}</span>
          <span class="task-card-title">${_esc(PRIMARY_TASK.label)}</span>
          <span class="task-card-desc">${_esc(PRIMARY_TASK.desc)}</span>
          <span class="task-card-cta">Open population view →</span>
        </a>
      </section>

      <!-- Supporting tasks -->
      <section>
        <div class="home-supporting-label">Supporting tasks · drill-down views</div>
        <div class="home-task-cards">
          ${SUPPORTING_TASKS.map(t => `
            <a href="${_esc("#/" + t.route)}" class="task-card" data-route="${_esc(t.route)}">
              <span class="task-card-badge task-card-badge-${_esc(t.id)}">${_esc(t.id)}</span>
              <span class="task-card-tuple">${_esc(t.tuple)}</span>
              <span class="task-card-title">${_esc(t.label)}</span>
              <span class="task-card-desc">${_esc(t.desc)}</span>
              <span class="task-card-cta">Open →</span>
            </a>
          `).join("")}
        </div>
      </section>

    </div>
  `;

  host.querySelector("#home-switch-btn")?.addEventListener("click", () => {
    document.getElementById("btn-switch-dataset")?.click();
  });

  host.querySelectorAll(".task-card").forEach(card => {
    card.addEventListener("click", e => {
      e.preventDefault();
      navigate(card.dataset.route);
    });
  });
}

function _statCard(value, label) {
  return `<div class="home-stat-card"><div class="home-stat-value">${_esc(value)}</div><div class="home-stat-label">${_esc(label)}</div></div>`;
}

function _esc(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
