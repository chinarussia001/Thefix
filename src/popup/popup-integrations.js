(() => {
  if (window.__LOVABURST_POPUP_INTEGRATIONS_V0302__) return;
  window.__LOVABURST_POPUP_INTEGRATIONS_V0302__ = true;
  window.__LOVABURST_POPUP_INTEGRATIONS__ = true;

  const STORAGE_KEY = "projectIntegrations";
  const githubCard = document.getElementById("githubIntegrationCard");
  const githubValue = document.getElementById("repositoryValue");
  const githubState = document.getElementById("repositoryState");
  const supabaseCard = document.getElementById("supabaseIntegrationCard");
  const supabaseValue = document.getElementById("supabaseValue");
  const supabaseState = document.getElementById("supabaseState");
  const refreshButton = document.getElementById("refreshRepositoryButton");
  const refreshDataButton = document.getElementById("refreshDataButton");
  let refreshTimer = null;
  let lastRefreshProjectId = "";
  let refreshing = false;

  function loadV026Ui() {
    if (!document.getElementById("lovaburst-layout-v026")) {
      const link = document.createElement("link");
      link.id = "lovaburst-layout-v026";
      link.rel = "stylesheet";
      link.href = chrome.runtime.getURL("src/popup/popup-layout-v026.css");
      document.head.appendChild(link);
    }
    if (!document.getElementById("lovaburst-progress-v026")) {
      const script = document.createElement("script");
      script.id = "lovaburst-progress-v026";
      script.src = chrome.runtime.getURL("src/popup/popup-progress.js");
      document.documentElement.appendChild(script);
    }
  }
  loadV026Ui();

  function projectId() {
    return String(document.getElementById("projectValue")?.textContent || "").trim().replace(/^—$/, "");
  }

  function setTextIfChanged(element, value) {
    if (element && element.textContent !== value) element.textContent = value;
  }

  function setCard(card, state, valueEl, stateEl, value, label, title) {
    if (!card) return;
    if (card.dataset.state !== state) card.dataset.state = state;
    setTextIfChanged(valueEl, value);
    setTextIfChanged(stateEl, label);
    if (card.title !== (title || label)) card.title = title || label;
  }

  function syncGithub() {
    const value = String(githubValue?.textContent || "").trim();
    const rawState = String(githubState?.textContent || "").trim().toLowerCase();
    if (/detect|verific|atualiz/.test(value.toLowerCase()) || /verific|atualiz/.test(rawState)) {
      if (githubCard?.dataset.state !== "loading") githubCard.dataset.state = "loading";
      return;
    }
    if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) {
      setCard(githubCard, "connected", githubValue, githubState, value, "Repository detected", "Repository detected");
      return;
    }
    setCard(githubCard, "disconnected", githubValue, githubState, value || "Not connected", "Not connected", "Repository not detected");
  }

  async function getSupabaseRecord(id) {
    if (!id) return null;
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    return stored[STORAGE_KEY]?.[id]?.supabase || null;
  }

  async function saveSupabaseRecord(id, supabase) {
    if (!id || !supabase) return null;
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    const all = stored[STORAGE_KEY] || {};
    const previous = all[id] || {};
    const previousSupabase = previous.supabase || null;

    if (
      supabase.status !== "connected" &&
      supabase.evidence !== "connector-disabled" &&
      previousSupabase?.status === "connected"
    ) {
      return previousSupabase;
    }

    const now = new Date().toISOString();
    const next = {
      ...previous,
      projectId: id,
      supabase: {
        status: String(supabase.status || "unused"),
        projectRef: String(supabase.projectRef || ""),
        source: String(supabase.source || "main-world-probe"),
        evidence: String(supabase.evidence || "main-world-probe"),
        detectedAt: now,
      },
      updatedAt: now,
    };
    await chrome.storage.local.set({ [STORAGE_KEY]: { ...all, [id]: next } });
    return next.supabase;
  }

  async function renderSupabase({ allowLoading = true } = {}) {
    const id = projectId();
    if (!id) {
      setCard(
        supabaseCard,
        allowLoading ? "loading" : "unused",
        supabaseValue,
        supabaseState,
        allowLoading ? "Waiting for project" : "Not checked",
        allowLoading ? "Checking..." : "Optional",
        allowLoading ? "Waiting for Lovable project" : "Supabase could not be checked yet",
      );
      return null;
    }

    const supabase = await getSupabaseRecord(id);
    if (!supabase) {
      setCard(
        supabaseCard,
        allowLoading ? "loading" : "unused",
        supabaseValue,
        supabaseState,
        allowLoading ? "Checking..." : "Not checked",
        allowLoading ? "Checking..." : "Optional",
        allowLoading ? "Detecting Supabase integration" : "Supabase could not be checked yet",
      );
      return null;
    }

    if (supabase.status === "connected") {
      const ref = String(supabase.projectRef || "").trim();
      const compact = ref ? `${ref.slice(0, 8)}${ref.length > 8 ? "…" : ""}` : "Connector active";
      setCard(supabaseCard, "connected", supabaseValue, supabaseState, compact, "Connected", ref ? `Supabase connected · ${ref}` : "Supabase connected");
      return supabase;
    }

    if (supabase.status === "disconnected") {
      setCard(supabaseCard, "disconnected", supabaseValue, supabaseState, "Not connected", "Integration issue", "Supabase signals were found, but the project connection could not be resolved");
      return supabase;
    }

    setCard(supabaseCard, "unused", supabaseValue, supabaseState, "Not in use", "Optional", "No Supabase integration signals were found for this project");
    return supabase;
  }

  async function requestSupabaseRefresh(tabId, id) {
    const message = { type: "LOVABURST_REFRESH_PROJECT_INTEGRATIONS", projectId: id };
    try {
      const response = await chrome.tabs.sendMessage(tabId, message);
      if (response?.ok) return response;
    } catch {}

    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["src/content/lovable-integrations.js"] });
      return await chrome.tabs.sendMessage(tabId, message);
    } catch {
      return null;
    }
  }

  async function probeMainWorld(tabId) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: () => {
          const SUPABASE_URL_RE = /https?:\/\/([a-z0-9-]{8,40})\.supabase\.co\b/gi;
          const refs = new Map();
          const texts = [];
          const add = (value, source) => {
            if (value == null) return;
            let text = "";
            try { text = typeof value === "string" ? value : JSON.stringify(value); } catch { return; }
            if (!text) return;
            text = text.slice(0, 350000);
            texts.push({ text, source });
            SUPABASE_URL_RE.lastIndex = 0;
            for (const match of text.matchAll(SUPABASE_URL_RE)) {
              const ref = String(match[1] || "").toLowerCase();
              if (ref && ref !== "api" && ref !== "www") refs.set(ref, source);
            }
          };

          try { add(document.documentElement?.innerHTML, "main-dom"); } catch {}
          try { add(document.body?.innerText, "main-text"); } catch {}
          try {
            for (const entry of performance.getEntriesByType("resource")) {
              if (/supabase/i.test(entry?.name || "")) add(entry.name, "main-performance");
            }
          } catch {}
          const scanStorage = (storage, source) => {
            try {
              for (let index = 0; index < storage.length; index += 1) {
                const key = storage.key(index) || "";
                const value = storage.getItem(key) || "";
                if (/supabase|project|workspace|integration|backend|connector/i.test(key) || /supabase/i.test(value)) {
                  add(`${key}:${value}`, source);
                }
              }
            } catch {}
          };
          scanStorage(localStorage, "main-local-storage");
          scanStorage(sessionStorage, "main-session-storage");
          for (const key of ["__NEXT_DATA__", "__INITIAL_STATE__", "__PRELOADED_STATE__", "__APOLLO_STATE__", "__REACT_QUERY_STATE__", "__remixContext", "__ROUTE_DATA__", "__lovable", "lovable"]) {
            try { add(window[key], `main-global:${key}`); } catch {}
          }

          const first = refs.entries().next().value;
          if (first) {
            return { status: "connected", projectRef: first[0], source: first[1], evidence: "main-world-public-project-url" };
          }

          const body = String(document.body?.innerText || "").replace(/\s+/g, " ").trim().toLowerCase();
          if (body.includes("supabase")) {
            const connected = ["disable for workspace", "disable for project", "disconnect", "connected", "enabled", "desconectar", "conectado", "ativado"];
            const disconnected = ["enable for workspace", "enable for project", "connect supabase", "disabled", "conectar supabase", "desativado"];
            if (connected.some((term) => body.includes(term))) {
              return { status: "connected", projectRef: "", source: "main-connector-ui", evidence: "connector-enabled" };
            }
            if (disconnected.some((term) => body.includes(term))) {
              return { status: "unused", projectRef: "", source: "main-connector-ui", evidence: "connector-disabled" };
            }
          }

          const expected = texts.some(({ text }) => /@supabase\/supabase-js|vite_supabase_url|next_public_supabase_url|supabase_url|supabase\.auth|supabase\.from\(|createclient\(/i.test(text));
          return expected
            ? { status: "disconnected", projectRef: "", source: "main-world-signals", evidence: "integration-markers-without-project-ref" }
            : null;
        },
      });
      return results?.[0]?.result || null;
    } catch {
      return null;
    }
  }

  function scheduleRefresh(delay = 180) {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      void refreshIntegrations();
    }, delay);
  }

  async function refreshIntegrations() {
    if (refreshing) return;
    const id = projectId();
    syncGithub();
    if (!id) {
      await renderSupabase({ allowLoading: true });
      return;
    }

    refreshing = true;
    lastRefreshProjectId = id;
    setCard(supabaseCard, "loading", supabaseValue, supabaseState, "Checking...", "Checking...", "Refreshing Supabase integration");
    try {
      const tabs = await chrome.tabs.query({ url: ["https://lovable.dev/*"] });
      const tab = tabs.find((item) => item.url?.includes(id));
      if (!tab?.id) {
        await renderSupabase({ allowLoading: false });
        return;
      }

      const [bridgeResponse, mainProbe] = await Promise.all([
        requestSupabaseRefresh(tab.id, id),
        probeMainWorld(tab.id),
      ]);

      if (mainProbe?.status === "connected" || mainProbe?.evidence === "connector-disabled") {
        await saveSupabaseRecord(id, mainProbe);
      } else if (bridgeResponse?.ok && bridgeResponse.supabase) {
        await saveSupabaseRecord(id, bridgeResponse.supabase);
      }

      await renderSupabase({ allowLoading: false });
    } finally {
      refreshing = false;
      syncGithub();
    }
  }

  const githubObserver = new MutationObserver(() => syncGithub());
  if (githubValue) githubObserver.observe(githubValue, { childList: true, characterData: true, subtree: true });
  if (githubState) githubObserver.observe(githubState, { childList: true, characterData: true, subtree: true });

  const projectValue = document.getElementById("projectValue");
  const projectObserver = new MutationObserver(() => {
    const id = projectId();
    void renderSupabase();
    if (id && id !== lastRefreshProjectId) scheduleRefresh(80);
  });
  if (projectValue) projectObserver.observe(projectValue, { childList: true, characterData: true, subtree: true });

  for (const button of [refreshButton, refreshDataButton]) {
    button?.addEventListener("click", () => scheduleRefresh(120));
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[STORAGE_KEY]) void renderSupabase({ allowLoading: false });
  });

  window.setInterval(syncGithub, 1200);
  window.setTimeout(() => scheduleRefresh(0), 250);
  window.setTimeout(() => scheduleRefresh(0), 900);
  window.setTimeout(() => scheduleRefresh(0), 2200);
})();
