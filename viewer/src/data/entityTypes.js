"use strict";

const ENTITY_TYPE_PALETTE = [
  "#2563eb", "#ea580c", "#059669", "#9333ea", "#dc2626",
  "#0891b2", "#ca8a04", "#db2777", "#4f46e5", "#0f766e",
  "#16a34a", "#c2410c",
];
const RESOURCE_COLOR  = "#475569";
const ATTRIBUTE_COLOR = "#6d28d9";

const ROLE_ORDER = { case: 0, item: 1, other: 2, resource: 3, attribute: 4 };

function _hashIndex(name, len) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = ((h << 5) - h) + name.charCodeAt(i);
  return Math.abs(h) % len;
}

export function entityTypeColor(name) {
  return ENTITY_TYPE_PALETTE[_hashIndex(String(name ?? ""), ENTITY_TYPE_PALETTE.length)];
}

function _inferRole(name, caseSources, itemTargets, caseType, itemType) {
  if (caseSources.has(name)) return "case";
  if (itemTargets.has(name)) return "item";
  if (/Resource/i.test(name)) return "resource";
  if (/Attribute|EntityAttribute/i.test(name)) return "attribute";
  if (caseType && name === caseType) return "case";
  if (itemType && name === itemType) return "item";
  return "other";
}

export function buildEntityTypeRegistry(store) {
  const caseSources = new Set();
  const itemTargets = new Set();
  (store.relations ?? []).forEach(r => {
    if (r.relation_type === "HAS_ITEM") {
      caseSources.add(r.source_entity_type);
      itemTargets.add(r.target_entity_type);
    }
  });

  const countsByType = {};
  (store.entities ?? []).forEach(e => {
    const t = e.primary_type || e.entity_type;
    if (t) countsByType[t] = (countsByType[t] ?? 0) + 1;
  });

  const types = Object.keys(countsByType).map(name => {
    const role = _inferRole(name, caseSources, itemTargets, store.caseType, store.itemType);
    const color = role === "resource" ? RESOURCE_COLOR
      : role === "attribute" ? ATTRIBUTE_COLOR
      : entityTypeColor(name);
    return { name, role, displayLabel: name, count: countsByType[name], color };
  });

  types.sort((a, b) =>
    (ROLE_ORDER[a.role] ?? 2) - (ROLE_ORDER[b.role] ?? 2) || a.name.localeCompare(b.name)
  );

  const byName = Object.fromEntries(types.map(t => [t.name, t]));
  const orderedNames = types.map(t => t.name);

  return {
    types,
    byName,
    orderedNames,
    roleOf:  name => byName[name]?.role  ?? "other",
    colorOf: name => byName[name]?.color ?? entityTypeColor(name),
  };
}
