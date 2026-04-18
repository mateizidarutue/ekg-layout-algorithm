"use strict";

/**
 * Load the JSON bundle produced by pipeline/export_json.py.
 * @param {string} url  Path to the .json file.
 * @returns {Promise<object>}  Parsed bundle matching the §3 schema.
 */
export async function loadDataset(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status} loading ${url}`);
  return response.json();
}

/**
 * Build a URL for a named dataset.
 * Works when served from the repo root (http://localhost:8000/viewer/)
 * or directly from the viewer directory (http://localhost:8000/).
 */
export function datasetUrl(name) {
  // If index.html is at /viewer/index.html, output is at /output/<name>.json
  // If index.html is at /index.html (server root = viewer/), try parent
  const path = window.location.pathname;
  if (path.startsWith("/viewer/") || path === "/viewer") {
    return `/output/${name}.json`;
  }
  return `../output/${name}.json`;
}

/**
 * Read ?dataset=<name> from the current URL, or return the fallback.
 */
export function datasetFromQuery(fallback = "library") {
  const params = new URLSearchParams(window.location.search);
  return params.get("dataset") || fallback;
}
