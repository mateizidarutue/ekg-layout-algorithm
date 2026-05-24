"use strict";

const VALID_ROUTES = new Set(["home", "atlas", "identify", "compare", "summarize", "explore"]);

let _onRoute = null;
let _routeHistory = [];

function _parseHash(hash) {
  const raw = hash.replace(/^#\//, "");
  const [namePart, queryPart = ""] = raw.split("?");
  const name = namePart || "home";
  const params = Object.fromEntries(new URLSearchParams(queryPart).entries());
  return { name, params };
}

export function getRoute() {
  return _parseHash(window.location.hash);
}

export function buildHash(name, params = {}) {
  const q = new URLSearchParams(params).toString();
  return `#/${name}${q ? "?" + q : ""}`;
}

export function navigate(name, params = {}, { replace = false } = {}) {
  const hash = buildHash(name, params);
  if (replace) {
    history.replaceState(null, "", window.location.pathname + window.location.search + hash);
    if (_onRoute) {
      const route = getRoute();
      _rememberRoute(route);
      _onRoute(route);
    }
  } else {
    window.location.hash = hash;
  }
}

export function goBack(fallback = null) {
  if (_routeHistory.length > 1) {
    _routeHistory.pop();
    const previous = _routeHistory.pop();
    navigate(previous.name, previous.params ?? {}, { replace: true });
    return;
  }
  const route = getRoute();
  if (fallback) {
    navigate(fallback.name, fallback.params ?? {});
  } else if (route.name === "home") {
    navigate("home", {}, { replace: true });
  } else {
    navigate("home");
  }
}

export function startRouter({ onRoute }) {
  _onRoute = onRoute;

  window.addEventListener("hashchange", () => {
    const route = getRoute();
    if (!VALID_ROUTES.has(route.name)) {
      navigate("home", {}, { replace: true });
      return;
    }
    _rememberRoute(route);
    onRoute(route);
  });

  const initial = getRoute();
  if (!window.location.hash || !VALID_ROUTES.has(initial.name)) {
    navigate("home", {}, { replace: true });
  } else {
    _rememberRoute(initial);
    onRoute(initial);
  }
}

function _rememberRoute(route) {
  const key = buildHash(route.name, route.params ?? {});
  const last = _routeHistory.at(-1);
  if (last && buildHash(last.name, last.params ?? {}) === key) return;
  _routeHistory.push({ name: route.name, params: { ...(route.params ?? {}) } });
  if (_routeHistory.length > 40) _routeHistory = _routeHistory.slice(-40);
}
