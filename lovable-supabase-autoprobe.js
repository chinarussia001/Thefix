(() => {
  if (window.__LOVABURST_SUPABASE_AUTOPROBE__) return;
  window.__LOVABURST_SUPABASE_AUTOPROBE__ = true;

  const downstreamFetch = window.fetch;
  const PROJECT_RE = /\/projects\/([A-Za-z0-9-]+)/i;
  const SUPABASE_URL_RE = /https?:\/\/([a-z0-9-]{8,40})\.supabase\.co\b/i;
  const CONNECTED_RE = /\b(connected|enabled|active|conectado|ativado)\b/i;
  const DISCONNECTED_RE = /\b(disconnected|disabled|inactive|desconectado|desativado)\b/i;

  function currentProjectId() {
    return location.pathname.match(PROJECT_RE)?.[1] || "";
  }

  function parseUrl(value) {
    try { return new URL(String(value || ""), location.href); } catch { return null; }
  }

  function projectIdFromUrl(value) {
    return parseUrl(value)?.pathname.match(PROJECT_RE)?.[1] || "";
  }

  function isProjectBoundLovableApi(value) {
    const url = parseUrl(value);
    if (!url || url.hostname !== "api.lovable.dev") return false;
    const current = currentProjectId();
    return Boolean(current && projectIdFromUrl(url.href) === current);
  }

  function publish(result) {
    const projectId = currentProjectId();
    if (!projectId || !result?.status) return;
    const root = document.documentElement;
    if (!root) return;
    root.dataset.lovaburstSupabaseProject = projectId;
    root.dataset.lovaburstSupabaseStatus = result.status;
    root.dataset.lovaburstSupabaseRef = result.projectRef || "";
    root.dataset.lovaburstSupabaseSource = result.source || "lovable-api";
    root.dataset.lovaburstSupabaseEvidence = result.evidence || "lovable-api";
    document.dispatchEvent(new CustomEvent("lovaburst-supabase-detected"));
  }

  function inspectValue(value, depth = 0, contextKey = "") {
    if (depth > 8 || value == null) return null;

    if (typeof value === "string") {
      const ref = value.match(SUPABASE_URL_RE)?.[1]?.toLowerCase() || "";
      if (ref) return { status: "connected", projectRef: ref, source: "lovable-api", evidence: "project-api-supabase-url" };
      if (/supabase/i.test(`${contextKey} ${value}`)) {
        if (CONNECTED_RE.test(value)) return { status: "connected", projectRef: "", source: "lovable-api", evidence: "project-api-connector-enabled" };
        if (DISCONNECTED_RE.test(value)) return { status: "unused", projectRef: "", source: "lovable-api", evidence: "connector-disabled" };
      }
      return null;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        const found = inspectValue(item, depth + 1, contextKey);
        if (found?.status === "connected" || found?.evidence === "connector-disabled") return found;
      }
      return null;
    }

    if (typeof value !== "object") return null;

    const entries = Object.entries(value);
    const joinedKeys = entries.map(([key]) => key).join(" ");
    const objectLooksSupabase = /supabase/i.test(`${contextKey} ${joinedKeys}`) || entries.some(([, item]) => typeof item === "string" && /supabase/i.test(item));

    if (objectLooksSupabase) {
      for (const [key, item] of entries) {
        if (typeof item !== "string") continue;
        const ref = item.match(SUPABASE_URL_RE)?.[1]?.toLowerCase() || "";
        if (ref) return { status: "connected", projectRef: ref, source: "lovable-api", evidence: "project-api-supabase-url" };
        if (/status|state|enabled|connected|active/i.test(key)) {
          if (CONNECTED_RE.test(item) || item === "true") return { status: "connected", projectRef: "", source: "lovable-api", evidence: "project-api-connector-enabled" };
          if (DISCONNECTED_RE.test(item) || item === "false") return { status: "unused", projectRef: "", source: "lovable-api", evidence: "connector-disabled" };
        }
      }
    }

    for (const [key, item] of entries) {
      const found = inspectValue(item, depth + 1, `${contextKey} ${key}`);
      if (found?.status === "connected" || found?.evidence === "connector-disabled") return found;
    }
    return null;
  }

  async function inspectResponse(response, url) {
    if (!response?.ok || !isProjectBoundLovableApi(url)) return;
    try {
      const contentType = response.headers?.get("content-type") || "";
      if (!/json/i.test(contentType)) return;
      const payload = await response.clone().json();
      const result = inspectValue(payload);
      if (result) publish(result);
    } catch {}
  }

  function inspectRuntimeSignals() {
    const projectId = currentProjectId();
    if (!projectId) return;
    const sources = [];
    try { sources.push(document.documentElement?.innerHTML || ""); } catch {}
    try {
      for (const key of ["__NEXT_DATA__", "__INITIAL_STATE__", "__PRELOADED_STATE__", "__APOLLO_STATE__", "__REACT_QUERY_STATE__", "__remixContext", "__ROUTE_DATA__", "__lovable", "lovable"]) {
        const value = window[key];
        if (value != null) sources.push(typeof value === "string" ? value : JSON.stringify(value));
      }
    } catch {}
    for (const source of sources) {
      const ref = String(source || "").match(SUPABASE_URL_RE)?.[1]?.toLowerCase() || "";
      if (ref) {
        publish({ status: "connected", projectRef: ref, source: "lovable-main-world", evidence: "runtime-supabase-url" });
        return;
      }
    }
  }

  if (typeof downstreamFetch === "function") {
    window.fetch = async function (...args) {
      const response = await downstreamFetch.apply(this, args);
      const input = args[0];
      const url = typeof input === "string" || input instanceof URL ? String(input) : input?.url || response?.url || "";
      void inspectResponse(response, url);
      return response;
    };
  }

  document.addEventListener("lovaburst-force-repository-refresh", inspectRuntimeSignals);
  window.setInterval(inspectRuntimeSignals, 1800);
  inspectRuntimeSignals();
})();
