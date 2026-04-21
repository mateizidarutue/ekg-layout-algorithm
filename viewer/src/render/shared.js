"use strict";

export const CAMERA_EASE_MS = 420;
export const FIT_PAD_X = 52;
export const FIT_PAD_Y = 44;
export const FIT_MAX_SCALE = 1.65;
export const FIT_READABLE_MIN_SCALE = 0.28;
export const ZOOM_MIN_SCALE = 0.05;
export const ZOOM_MAX_SCALE = 6;

export const COMMUNITY_PALETTE = [
  [37, 99, 235], [14, 116, 144], [5, 150, 105], [217, 119, 6],
  [220, 38, 38], [124, 58, 237], [8, 145, 178], [22, 163, 74],
];

export function addMarkers(defs) {
  function mk(id, color, size = 5) {
    defs.append("marker")
      .attr("id", id).attr("viewBox", "0 -3 6 6")
      .attr("refX", size + 1).attr("refY", 0)
      .attr("markerWidth", size).attr("markerHeight", size)
      .attr("orient", "auto")
      .append("path").attr("d", "M0,-3L6,0L0,3").attr("fill", color);
  }
  mk("arr-dfitem", "rgba(34,48,71,0.42)");
  mk("arr-dfitem-bottleneck", "#d97706");
  mk("arr-dfpo", "#2563eb");
  mk("arr-corr", "rgba(34,48,71,0.22)", 4);
}

export function clusterColor(value, alpha = 1) {
  let hash = 0;
  const text = String(value ?? "");
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) - hash) + text.charCodeAt(i);
  const [r, g, b] = COMMUNITY_PALETTE[Math.abs(hash) % COMMUNITY_PALETTE.length];
  return `rgba(${r},${g},${b},${alpha})`;
}

export function ellipsis(value, maxChars) {
  const text = String(value ?? "");
  return text.length > maxChars ? `${text.slice(0, maxChars - 3)}...` : text;
}

export function wheelDelta(event) {
  return -event.deltaY * (event.deltaMode === 1 ? 0.05 : 0.002);
}

export function formatPercent(fraction) {
  const percent = Math.max(0, fraction ?? 0) * 100;
  return `${percent >= 10 ? Math.round(percent) : percent.toFixed(1)}%`;
}

export function formatAttrValue(key, value) {
  if (value === "True") return "Yes";
  if (value === "False") return "No";
  return key === "Document_Type" ? ellipsis(value, 20) : value;
}

export function labelize(key) { return key.replaceAll("_", " "); }

export function rgba(value, alpha = 1) {
  const color = d3.color(value);
  if (!color) return value;
  color.opacity = alpha;
  return color.formatRgb();
}

export function hasResourceValue(value) {
  if (value === undefined || value === null) return false;
  const n = String(value).trim();
  return n !== "" && n.toUpperCase() !== "NONE";
}

export function tooltipRows(obj, keys) {
  return keys
    .filter(k => obj?.[k] !== undefined && obj[k] !== null && obj[k] !== "")
    .map(k => `<div class="tip-row">${labelize(k)}: <b>${formatAttrValue(k, obj[k])}</b></div>`)
    .join("");
}

export function drawChipList(layer, chips, x, y) {
  if (!chips?.length) return;
  const g = layer.append("g").attr("transform", `translate(${x},${y})`);
  let cursor = 0;
  chips.forEach(chip => {
    const text = `${chip.label}: ${ellipsis(chip.value, chip.maxChars ?? 18)}`;
    const chipG = g.append("g").attr("transform", `translate(${cursor},0)`);
    const textEl = chipG.append("text")
      .attr("x", 8).attr("y", 10)
      .attr("font-family", "JetBrains Mono, monospace").attr("font-size", "8px")
      .attr("fill", chip.textColor ?? "#243449").text(text);
    const width = Math.ceil(textEl.node()?.getComputedTextLength?.() ?? (text.length * 5.2)) + 16;
    chipG.insert("rect", "text")
      .attr("width", width).attr("height", 14).attr("rx", 7)
      .attr("fill", chip.fill ?? "rgba(37,99,235,0.08)").attr("stroke", chip.stroke ?? "rgba(37,99,235,0.14)");
    cursor += width + 6;
  });
}

export function buildChips(attrs, pairs) {
  return pairs
    .filter(([key]) => attrs?.[key] !== undefined && attrs[key] !== "")
    .map(([key, label]) => {
      const value = formatAttrValue(key, attrs[key]);
      const isBool = value === "Yes" || value === "No";
      return {
        label, value, maxChars: key === "Item_Category" ? 22 : 16,
        fill: isBool ? (value === "Yes" ? "rgba(21,154,103,0.12)" : "rgba(220,38,38,0.10)") : "rgba(37,99,235,0.08)",
        stroke: isBool ? (value === "Yes" ? "rgba(21,154,103,0.24)" : "rgba(220,38,38,0.18)") : "rgba(37,99,235,0.14)",
        textColor: isBool ? (value === "Yes" ? "#0f766e" : "#b91c1c") : "#243449",
      };
    });
}

export function formatGapHours(hours) {
  if (!Number.isFinite(hours)) return "n/a";
  if (hours >= 24) { const d = Math.floor(hours / 24); return `${d}d ${Math.round(hours - d * 24)}h`; }
  return `${hours.toFixed(hours >= 10 ? 0 : 1)}h`;
}

export function compactGapLabel(hours) {
  if (!Number.isFinite(hours)) return "gap";
  if (hours >= 24) return `${Math.max(1, Math.round(hours / 24))}d`;
  return `${Math.max(1, Math.round(hours))}h`;
}

export function activitySummary(entries) {
  return (entries ?? []).map(e => `${ellipsis(e.activity, 16)} (${e.count})`).join(", ");
}

export function entitySuffix(entityId) { return String(entityId ?? "").slice(-4); }

export function suffix(itemId) {
  const m = itemId.match(/_0*(\d+)$/);
  return m ? parseInt(m[1], 10) : itemId;
}

export function eventRadius(d, EVENT_R) {
  return d?.isSyncEvent ? EVENT_R + Math.min(Math.max((d.syncDegree ?? 1) - 1, 1), 5) * 1.7 : EVENT_R;
}

export function syncContextRows(syncContexts) {
  if (!syncContexts?.length) return "";
  return `<div class="tip-divider"></div><div class="tip-subtitle">Shared lifecycle context</div>` +
    syncContexts.map(c => `<div class="tip-row"><b>${c.entityId}</b></div><div class="tip-row">Prev: <b>${c.predecessorActivities?.join(", ") || "n/a"}</b></div><div class="tip-row">Next: <b>${c.successorActivities?.join(", ") || "n/a"}</b></div>`).join("");
}

export function computeFitTransform(svg, gRoot, totalHeight, options = {}) {
  const minScale = options.minScale ?? FIT_READABLE_MIN_SCALE;
  let bounds;
  try {
    const bbox = gRoot.node().getBBox();
    bounds = bbox.width > 0 && bbox.height > 0 ? bbox : null;
  } catch { bounds = null; }
  if (!bounds) {
    const w = svg.node().clientWidth ?? 900;
    const h = totalHeight ?? svg.node().clientHeight ?? 600;
    bounds = { x: 0, y: 0, width: Math.max(w - 24, 1), height: Math.max(h, 1) };
  }
  if (!svg?.node()) return null;
  const viewportW = svg.node().clientWidth;
  const viewportH = svg.node().clientHeight;
  const padX = options.padX ?? FIT_PAD_X;
  const padY = options.padY ?? FIT_PAD_Y;
  const innerW = Math.max(viewportW - padX * 2, 1);
  const innerH = Math.max(viewportH - padY * 2, 1);
  const widthScale = innerW / Math.max(bounds.width, 1);
  const heightScale = innerH / Math.max(bounds.height, 1);
  const fitScale = Math.min(FIT_MAX_SCALE, widthScale, heightScale);
  const scale = options.preferWidth && bounds.height > viewportH
    ? Math.min(FIT_MAX_SCALE, widthScale)
    : (fitScale < minScale && bounds.height > viewportH ? Math.min(minScale, widthScale) : fitScale);
  const tx = options.alignLeft ? padX - bounds.x * scale : viewportW / 2 - (bounds.x + bounds.width / 2) * scale;
  const ty = options.alignTop ? padY - bounds.y * scale : viewportH / 2 - (bounds.y + bounds.height / 2) * scale;
  return d3.zoomIdentity.translate(tx, ty).scale(scale);
}
