"use strict";

const VALID_ROUTES = new Set(["home", "identify", "compare", "summarize", "explore"]);

let _onRoute = null;

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
    if (_onRoute) _onRoute(getRoute());
  } else {
    window.location.hash = hash;
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
    onRoute(route);
  });

  const initial = getRoute();
  if (!window.location.hash || !VALID_ROUTES.has(initial.name)) {
    navigate("home", {}, { replace: true });
  } else {
    onRoute(initial);
  }
}
