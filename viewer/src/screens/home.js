"use strict";

import { navigate } from "../router.js";
import { getVariantOverview } from "../data/store.js";

const PRIMARY_TASK = {
  id: "T1", route: "summarize", label: "Lifecycle (Population)",
  tuple: "⟨Identify, Path⟩",
  desc: "Every event of every entity in one Canvas 2D dotted-chart: time on x, entity-type bands on y, vertical ticks where three or more entity types share an event. Click a dot to pin its full directly-follows path; shift-click to pin more. Brush the mini axis to zoom a time window, press play to advance the cursor.",
};

const SUPPORTING_TASKS = [
  {
    id: "T2", route: "identify", label: "Identify (Detail)",
    tuple: "⟨Identify, Path⟩",
    desc: "Open one entity and read its full multi-band detail slice — bottleneck waits, shared-event guides, optional correlation and structural-relation overlays.",
  },
  {
    id: "T3", route: "compare", label: "Compare (Variants)",
    tuple: "⟨Compare, Paths⟩",
    desc: "Group entities into behavioural variants, then place multiple lifelines on the same canvas to compare dominant and deviant flows.",
  },
  {
    id: "T4", route: "explore", label: "Explore (Shared Events)",
    tuple: "⟨Explore, Features⟩",
    desc: "Find shared events where multiple entity lifecycles intersect — the synchronisation points that distinguish object-centric processes from flat event logs.",
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
          ${_statCard((store.communities?.length ?? 0).toLocaleString(), "Communities")}
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
