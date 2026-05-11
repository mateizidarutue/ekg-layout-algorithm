"use strict";

import { navigate } from "../router.js";

export function renderIdentifyPicker(store) {
  const host = document.getElementById("screen-host");
  if (!host) return;

  const reg = store.typeRegistry;
  const byType = {};
  (store.entityList ?? []).forEach(e => {
    (byType[e.type] = byType[e.type] ?? []).push(e);
  });
  const orderedTypes = (reg?.types ?? []).filter(t => (byType[t.name] ?? []).length > 0);

  host.innerHTML = `
    <div class="identify-picker">
      <div class="identify-picker-header">
        <div class="identify-picker-heading">
          <span class="task-card-badge task-card-badge-T1" style="position:static">T1</span>
          <h1 class="identify-picker-title">Select an entity</h1>
        </div>
        <p class="identify-picker-subtitle">
          Choose any entity below to open its full lifecycle on a shared time axis, including
          bottleneck waits and shared-event connections. Use the sidebar search to find a specific ID.
        </p>
      </div>

      <div class="identify-picker-grid" id="identify-picker-grid">
        ${orderedTypes.map(t => {
          const rows = (byType[t.name] ?? []);
          const shown = rows.slice(0, 28);
          const overflow = rows.length - shown.length;
          return `
            <div class="identify-picker-section" data-type="${_esc(t.name)}">
              <div class="identify-picker-section-head">
                <span class="identify-picker-type-dot" style="background:${_esc(t.color)}"></span>
                <span class="identify-picker-type-name">${_esc(t.displayLabel)}</span>
                <span class="role-chip role-chip-${_esc(t.role)}">${_esc(t.role)}</span>
                <span class="identify-picker-type-count">${rows.length.toLocaleString()}</span>
              </div>
              ${shown.map(e => `
                <div class="identify-picker-row" data-entity-id="${_esc(e.id)}">
                  <span class="identify-picker-row-id">${_esc(e.label)}</span>
                  <span class="identify-picker-row-meta">${e.eventCount} ev</span>
                </div>`).join("")}
              ${overflow > 0
                ? `<div class="identify-picker-overflow">+${overflow.toLocaleString()} more — use sidebar search</div>`
                : ""}
            </div>`;
        }).join("")}
      </div>
    </div>
  `;

  host.querySelectorAll(".identify-picker-row").forEach(row => {
    row.addEventListener("click", () => navigate("identify", { entity: row.dataset.entityId }));
  });
}

function _esc(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
