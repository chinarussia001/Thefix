(() => {
  if (window.__LOVABURST_SUPABASE_STATE_BRIDGE__) return;
  window.__LOVABURST_SUPABASE_STATE_BRIDGE__ = true;

  const STORAGE_KEY = "projectIntegrations";
  const PROJECT_RE = /\/projects\/([A-Za-z0-9-]+)/i;
  let restoring = false;

  function projectId() {
    return location.pathname.match(PROJECT_RE)?.[1] || "";
  }

  function datasetDetection() {
    const root = document.documentElement;
    const current = projectId();
    if (!root || !current || root.dataset.lovaburstSupabaseProject !== current) return null;
    const status = String(root.dataset.lovaburstSupabaseStatus || "");
    if (!status) return null;
    return {
      status,
      projectRef: String(root.dataset.lovaburstSupabaseRef || ""),
      source: String(root.dataset.lovaburstSupabaseSource || "lovable-main-world"),
      evidence: String(root.dataset.lovaburstSupabaseEvidence || "main-world-detection"),
    };
  }

  async function persistDetection() {
    const id = projectId();
    const detected = datasetDetection();
    if (!id || !detected) return;
    try {
      const stored = await chrome.storage.local.get(STORAGE_KEY);
      const all = stored[STORAGE_KEY] || {};
      const previous = all[id] || {};
      const previousSupabase = previous.supabase || null;

      if (
        detected.status !== "connected" &&
        detected.evidence !== "connector-disabled" &&
        previousSupabase?.status === "connected"
      ) return;

      const now = new Date().toISOString();
      await chrome.storage.local.set({
        [STORAGE_KEY]: {
          ...all,
          [id]: {
            ...previous,
            projectId: id,
            supabase: {
              status: detected.status,
              projectRef: detected.projectRef,
              source: detected.source,
              evidence: detected.evidence,
              detectedAt: now,
            },
            updatedAt: now,
          },
        },
      });
    } catch {}
  }

  async function protectConnectedCache(change) {
    if (restoring) return;
    const id = projectId();
    if (!id) return;
    const oldSupabase = change.oldValue?.[id]?.supabase;
    const newSupabase = change.newValue?.[id]?.supabase;
    if (oldSupabase?.status !== "connected" || newSupabase?.status === "connected") return;
    if (newSupabase?.evidence === "connector-disabled") return;

    try {
      restoring = true;
      const stored = await chrome.storage.local.get(STORAGE_KEY);
      const all = stored[STORAGE_KEY] || {};
      const current = all[id] || {};
      await chrome.storage.local.set({
        [STORAGE_KEY]: {
          ...all,
          [id]: {
            ...current,
            projectId: id,
            supabase: {
              ...oldSupabase,
              source: oldSupabase.source || "project-cache",
              evidence: oldSupabase.evidence || "cached-connected",
              detectedAt: oldSupabase.detectedAt || new Date().toISOString(),
            },
            updatedAt: new Date().toISOString(),
          },
        },
      });
    } catch {} finally {
      restoring = false;
    }
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[STORAGE_KEY]) return;
    void protectConnectedCache(changes[STORAGE_KEY]);
  });

  const observer = new MutationObserver((records) => {
    if (records.some((record) => record.type === "attributes" && record.attributeName?.startsWith("data-lovaburst-supabase-"))) {
      void persistDetection();
    }
  });
  observer.observe(document.documentElement, { attributes: true });

  document.addEventListener("lovaburst-supabase-detected", () => void persistDetection());
  window.setInterval(() => void persistDetection(), 1800);
  void persistDetection();
})();
