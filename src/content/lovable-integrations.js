(() => {
  if (window.__LOVABURST_PROJECT_INTEGRATIONS_V0302__) return;
  window.__LOVABURST_PROJECT_INTEGRATIONS_V0302__ = true;
  window.__LOVABURST_PROJECT_INTEGRATIONS__ = true;

  const STORAGE_KEY = "projectIntegrations";
  const PROJECT_RE = /\/projects\/([A-Za-z0-9-]+)/i;
  const SUPABASE_URL_RE = /https?:\/\/([a-z0-9-]{8,40})\.supabase\.co\b/gi;
  const EXPECTED_MARKERS = [
    "@supabase/supabase-js",
    "vite_supabase_url",
    "next_public_supabase_url",
    "supabase_url",
    "supabase/functions",
    "supabase/functions/",
    "supabase.auth",
    "supabase.from(",
    "createclient(",
  ];

  let lastProjectId = "";
  let lastSignature = "";
  let timer = null;
  let observer = null;
  let projectInterval = null;
  let stopped = false;
  let messageListenerRegistered = false;
  let popstateListenerRegistered = false;

  function projectId() {
    return location.pathname.match(PROJECT_RE)?.[1] || "";
  }

  function contextAvailable() {
    if (stopped) return false;
    try {
      return Boolean(globalThis.chrome?.runtime?.id && globalThis.chrome?.storage?.local);
    } catch {
      return false;
    }
  }

  function isContextInvalidation(error) {
    const message = String(error?.message || error || "").toLowerCase();
    return (
      message.includes("extension context invalidated") ||
      message.includes("context invalidated") ||
      message.includes("receiving end does not exist")
    );
  }

  function onPopstate() {
    schedule(80);
  }

  function stopAfterContextInvalidation() {
    if (stopped) return;
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
    if (projectInterval) clearInterval(projectInterval);
    projectInterval = null;
    observer?.disconnect();
    observer = null;
    if (popstateListenerRegistered) {
      removeEventListener("popstate", onPopstate);
      popstateListenerRegistered = false;
    }
    if (messageListenerRegistered) {
      try { globalThis.chrome?.runtime?.onMessage?.removeListener(onMessage); } catch {}
      messageListenerRegistered = false;
    }
  }

  async function storageGet(keys) {
    if (!contextAvailable()) {
      stopAfterContextInvalidation();
      return null;
    }
    try {
      return await globalThis.chrome.storage.local.get(keys);
    } catch (error) {
      if (isContextInvalidation(error) || !contextAvailable()) {
        stopAfterContextInvalidation();
        return null;
      }
      throw error;
    }
  }

  async function storageSet(value) {
    if (!contextAvailable()) {
      stopAfterContextInvalidation();
      return false;
    }
    try {
      await globalThis.chrome.storage.local.set(value);
      return true;
    } catch (error) {
      if (isContextInvalidation(error) || !contextAvailable()) {
        stopAfterContextInvalidation();
        return false;
      }
      throw error;
    }
  }

  function normalize(value) {
    return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  function addText(bucket, value, source) {
    if (value == null) return;
    let text = "";
    try {
      text = typeof value === "string" ? value : JSON.stringify(value);
    } catch {
      return;
    }
    if (!text) return;
    bucket.push({ text: text.slice(0, 350000), source });
  }

  function connectorEvidence() {
    const bodyText = normalize(document.body?.innerText);
    if (!bodyText.includes("supabase")) return null;

    const supabaseNodes = Array.from(document.querySelectorAll("body *"))
      .filter((node) => normalize(node.textContent).includes("supabase"))
      .slice(0, 40);

    const regions = [document.body, ...supabaseNodes.flatMap((node) => {
      const items = [];
      let current = node;
      for (let depth = 0; depth < 7 && current; depth += 1, current = current.parentElement) items.push(current);
      return items;
    })].filter(Boolean);

    const connectedTerms = [
      "disable for workspace", "disable for project", "disconnect", "connected", "enabled",
      "desativar para workspace", "desativar para projeto", "desconectar", "conectado", "ativado",
    ];
    const disconnectedTerms = [
      "enable for workspace", "enable for project", "connect supabase", "disabled",
      "ativar para workspace", "ativar para projeto", "conectar supabase", "desativado",
    ];

    for (const region of regions) {
      const text = normalize(region.innerText || region.textContent);
      if (!text.includes("supabase")) continue;
      const connectorContext =
        text.includes("connector") || text.includes("integration") || text.includes("integra") ||
        /\/connectors?(?:\/|$)/i.test(location.pathname) || /\/integrations?(?:\/|$)/i.test(location.pathname);
      if (!connectorContext) continue;
      if (connectedTerms.some((term) => text.includes(term))) {
        return { status: "connected", source: "lovable-connector-ui", evidence: "connector-enabled" };
      }
      if (disconnectedTerms.some((term) => text.includes(term))) {
        return { status: "unused", source: "lovable-connector-ui", evidence: "connector-disabled" };
      }
    }
    return null;
  }

  function collectSignals() {
    const bucket = [];
    try { addText(bucket, document.documentElement?.innerHTML, "lovable-dom"); } catch {}
    try { addText(bucket, document.body?.innerText, "lovable-text"); } catch {}

    try {
      for (const script of document.querySelectorAll("script")) {
        const type = String(script.type || "").toLowerCase();
        if (!type || type.includes("json") || type.includes("javascript")) {
          addText(bucket, script.textContent, type.includes("json") ? "lovable-json" : "lovable-script");
        }
      }
    } catch {}

    try {
      for (const node of document.querySelectorAll("a[href],link[href],iframe[src],script[src]")) {
        const value = node.getAttribute("href") || node.getAttribute("src") || "";
        if (/supabase/i.test(value)) addText(bucket, value, "lovable-resource-attribute");
      }
    } catch {}

    try {
      for (const entry of performance.getEntriesByType("resource")) {
        if (/supabase/i.test(entry?.name || "")) addText(bucket, entry.name, "lovable-performance-resource");
      }
    } catch {}

    const scanStorage = (storage, source) => {
      try {
        for (let index = 0; index < storage.length; index += 1) {
          const key = storage.key(index) || "";
          const value = storage.getItem(key) || "";
          if (/supabase|project|workspace|integration|backend|connector/i.test(key) || /supabase/i.test(value)) {
            addText(bucket, `${key}:${value}`, source);
          }
        }
      } catch {}
    };
    scanStorage(localStorage, "lovable-local-storage");
    scanStorage(sessionStorage, "lovable-session-storage");
    return bucket;
  }

  function detectSupabase() {
    const connector = connectorEvidence();
    if (connector) return { ...connector, projectRef: "" };

    const signals = collectSignals();
    const refs = new Map();
    let expected = false;
    let expectedSource = "";

    for (const signal of signals) {
      const lower = signal.text.toLowerCase();
      for (const marker of EXPECTED_MARKERS) {
        if (lower.includes(marker)) {
          expected = true;
          if (!expectedSource) expectedSource = signal.source;
          break;
        }
      }
      SUPABASE_URL_RE.lastIndex = 0;
      for (const match of signal.text.matchAll(SUPABASE_URL_RE)) {
        const ref = String(match[1] || "").toLowerCase();
        if (ref && ref !== "api" && ref !== "www") refs.set(ref, signal.source);
      }
    }

    const first = refs.entries().next().value;
    if (first) {
      return { status: "connected", projectRef: first[0], source: first[1], evidence: "public-project-url" };
    }
    if (expected) {
      return { status: "disconnected", projectRef: "", source: expectedSource || "lovable-signals", evidence: "integration-markers-without-project-ref" };
    }
    return { status: "unused", projectRef: "", source: "lovable-signals", evidence: "no-supabase-signals" };
  }

  async function persist(force = false) {
    if (!contextAvailable()) {
      stopAfterContextInvalidation();
      return null;
    }
    const id = projectId();
    if (!id) return null;

    try {
      const stored = await storageGet(STORAGE_KEY);
      if (!stored || stopped) return null;
      const current = stored[STORAGE_KEY] || {};
      const previous = current[id] || {};
      const detected = detectSupabase();
      const previousSupabase = previous.supabase || null;

      const keepConnectedCache =
        detected.status === "unused" &&
        detected.evidence === "no-supabase-signals" &&
        previousSupabase?.status === "connected";

      const supabase = keepConnectedCache
        ? {
            ...previousSupabase,
            source: previousSupabase.source || "project-cache",
            evidence: previousSupabase.evidence || "cached-connected",
          }
        : detected;

      const signature = `${id}|${supabase.status}|${supabase.projectRef || ""}|${supabase.source}|${supabase.evidence}`;
      if (!force && signature === lastSignature) return supabase;
      lastProjectId = id;
      lastSignature = signature;

      const next = {
        ...previous,
        projectId: id,
        supabase: {
          status: supabase.status,
          projectRef: String(supabase.projectRef || ""),
          source: supabase.source,
          evidence: supabase.evidence,
          detectedAt: new Date().toISOString(),
        },
        updatedAt: new Date().toISOString(),
      };

      const saved = await storageSet({ [STORAGE_KEY]: { ...current, [id]: next } });
      return saved ? next.supabase : null;
    } catch (error) {
      if (isContextInvalidation(error) || !contextAvailable()) {
        stopAfterContextInvalidation();
        return null;
      }
      console.warn("[LovaRPM] Falha ao atualizar integrações do projeto:", error);
      return null;
    }
  }

  function schedule(delay = 350) {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void persist();
    }, delay);
  }

  function onMessage(message, _sender, sendResponse) {
    if (message?.type !== "LOVABURST_REFRESH_PROJECT_INTEGRATIONS") return false;
    if (!contextAvailable()) {
      stopAfterContextInvalidation();
      try { sendResponse({ ok: false, error: "The extension context was reloaded. Refresh the Lovable page." }); } catch {}
      return false;
    }
    const requested = String(message.projectId || "");
    const current = projectId();
    if (requested && current && requested !== current) {
      try { sendResponse({ ok: false, error: "The active Lovable project changed before integrations could be refreshed." }); } catch {}
      return false;
    }
    void persist(true)
      .then((supabase) => {
        try { sendResponse({ ok: true, projectId: current, supabase }); } catch {}
      })
      .catch(() => {
        try { sendResponse({ ok: false, error: "Could not refresh the project integrations." }); } catch {}
      });
    return true;
  }

  if (!contextAvailable()) {
    stopAfterContextInvalidation();
    return;
  }
  try {
    globalThis.chrome.runtime.onMessage.addListener(onMessage);
    messageListenerRegistered = true;
  } catch (error) {
    if (isContextInvalidation(error)) {
      stopAfterContextInvalidation();
      return;
    }
  }

  observer = new MutationObserver(() => schedule(500));
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  addEventListener("popstate", onPopstate);
  popstateListenerRegistered = true;

  projectInterval = setInterval(() => {
    if (!contextAvailable()) {
      stopAfterContextInvalidation();
      return;
    }
    const current = projectId();
    if (current && current !== lastProjectId) void persist(true);
  }, 1800);

  void persist(true);
})();
