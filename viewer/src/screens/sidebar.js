"use strict";

import { navigate } from "../router.js";

export function updateSidebarRoute(route, { compareMode = "variants", exploreDrilled = false } = {}) {
  const sidebar = document.getElementById("sidebar");
  const body = document.body;
  if (!sidebar) return;

  sidebar.setAttribute("data-route", route.name);
  sidebar.setAttribute("data-compare-mode", compareMode);
  sidebar.setAttribute("data-explore-drilled", String(exploreDrilled));
  body.setAttribute("data-route", route.name);
  body.setAttribute("data-explore-drilled", String(exploreDrilled));
}

export function updateTopbar(route, store) {
  const taskChip = document.getElementById("breadcrumb-task");
  const sep      = document.getElementById("breadcrumb-sep");
  const ctx      = document.getElementById("breadcrumb-ctx");
  const nameEl   = document.getElementById("topbar-dataset-name");

  if (nameEl && store) nameEl.textContent = store.bundle?.dataset?.toUpperCase() ?? "";

  if (!taskChip) return;

  const MAP = {
    home:          { task: "",    label: "Home" },
    ekg:           { task: "T1",  label: "EKG Overview" },
    "ekg-v3":      { task: "T1",  label: "EKG Overview" },   // backward-compat alias
    "ekg-legacy":  { task: "T1‑L", label: "EKG Legacy (multi-scale)" },
    atlas:         { task: "",    label: "Legacy Atlas" },
    identify:      { task: "T2",  label: "Identify" },
    compare:       { task: "T3",  label: "Compare" },
    explore:       { task: "T4",  label: "Explore" },
    summarize:     { task: "",    label: "Process variants" },
  };

  const info = MAP[route.name] ?? MAP.home;
  taskChip.textContent = info.task ? `${info.task} · ${info.label}` : "Home";
  taskChip.dataset.task = info.task;
  taskChip.style.display = route.name === "home" ? "none" : "";
  sep.style.display      = route.name === "home" ? "none" : "";

  let ctxText = "";
  if (route.name === "ekg" || route.name === "ekg-v3") {
    ctxText = "Type interaction map";
  } else if (route.name === "ekg-legacy") {
    const levels = { "0": "L0 Galaxy", "1": "L1 District", "2": "L2 Neighbourhood", "3": "L3 Street" };
    ctxText = levels[route.params.level ?? "1"] ?? "Multi-scale view";
  } else if (route.name === "atlas") {
    ctxText = "Legacy · complete view";
  } else if (route.name === "identify" && !route.params.entity) {
    ctxText = "Pick entity";
  } else if (route.name === "identify" && route.params.entity) {
    const entity = store?.entityById?.[route.params.entity];
    ctxText = entity ? `${entity.primary_type} ${route.params.entity}` : route.params.entity;
  } else if (route.name === "compare") {
    if (route.params.entities) {
      const ids = route.params.entities.split(",").filter(Boolean);
      ctxText = `${ids.length} entities`;
    } else if (route.params.variant) {
      ctxText = `Variant selected`;
    } else {
      ctxText = "Variants";
    }
  } else if (route.name === "summarize") {
    ctxText = "Process graph";
  } else if (route.name === "explore") {
    ctxText = route.params.cluster
      ? decodeURIComponent(route.params.cluster).replace("act:", "")
      : "Shared events";
  }

  ctx.textContent = ctxText;
}

export function renderCompareStrip(compareEntityIds, accentMap, store, onRemove) {
  const list = document.getElementById("compare-strip-list");
  if (!list) return;
  if (!compareEntityIds.length) {
    list.innerHTML = `<div class="empty-note">No compared entities.</div>`;
    return;
  }
  list.innerHTML = compareEntityIds.map(id => {
    const label = store?.entityById?.[id]?.properties?.title
      || store?.entityById?.[id]?.properties?.name
      || id;
    const color = accentMap?.[id] ?? "#64748b";
    return `
      <div class="compare-strip-row">
        <span class="compare-strip-swatch" style="background:${_esc(color)}"></span>
        <span class="compare-strip-id">${_esc(label)}</span>
        <button type="button" class="compare-strip-remove" data-id="${_esc(id)}" aria-label="Remove ${_esc(id)}">×</button>
      </div>
    `;
  }).join("");

  list.querySelectorAll(".compare-strip-remove").forEach(btn => {
    btn.addEventListener("click", () => onRemove(btn.dataset.id));
  });
}

function _esc(str) {
  return String(str ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
