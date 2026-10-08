(() => {
  if (window.__LOVARPM_MIGRATION_RUNNER_CARD__) return;
  window.__LOVARPM_MIGRATION_RUNNER_CARD__ = true;

  const grid = document.querySelector(".integration-grid");
  const supabaseCard = document.getElementById("supabaseIntegrationCard");
  if (!grid || !supabaseCard) return;

  const card = document.createElement("div");
  card.className = "integration-card migration-runner-card";
  card.id = "migrationRunnerCard";
  card.dataset.state = "loading";
  card.innerHTML = '<span class="integration-icon" aria-hidden="true">DB</span><div class="integration-copy"><div class="integration-title"><span class="integration-dot"></span><strong>Migration Runner</strong></div><small id="migrationRunnerStatus">Checking…</small><small id="migrationRunnerUrl"></small><small id="migrationRunnerFingerprint">Key: —</small><div class="migration-runner-actions"><button id="migrationRunnerSetup" type="button">Set up</button><button id="migrationRunnerReset" type="button" hidden>Reset</button><button id="migrationRunnerRefresh" type="button" aria-label="Refresh runner status" title="Refresh runner status">↻</button></div><small id="migrationRunnerError" class="migration-runner-error" hidden></small></div>';
  supabaseCard.after(card);

  const statusEl = card.querySelector("#migrationRunnerStatus");
  const urlEl = card.querySelector("#migrationRunnerUrl");
  const fingerprintEl = card.querySelector("#migrationRunnerFingerprint");
  const errorEl = card.querySelector("#migrationRunnerError");
  const setupButton = card.querySelector("#migrationRunnerSetup");
  const resetButton = card.querySelector("#migrationRunnerReset");
  const refreshButton = card.querySelector("#migrationRunnerRefresh");
  const projectValue = document.getElementById("projectValue");
  const repositoryValue = document.getElementById("repositoryValue");
  const sendButton = document.getElementById("sendCommandButton");
  let currentProject = "";
  let inProgress = false;
  let progressStep = 0;
  let progressTotal = 7;
  let lastError = "";
  let refreshInFlight = false;

  function projectId() {
    return String(projectValue?.textContent || "").trim().replace(/^—$/, "");
  }

  function repositoryPresent() {
    return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(repositoryValue?.textContent || "").trim());
  }

  function runnerUrl(id) {
    return `https://${id}.lovableproject.com/api/public/ops/run-migrations`;
  }

  function syncDispatchGate(setupComplete = false) {
    if (!sendButton) return;
    const hasRepo = repositoryPresent();
    const hint = document.getElementById("dispatchPrerequisiteHint") || (() => {
      const node = document.createElement("div");
      node.id = "dispatchPrerequisiteHint";
      node.className = "dispatch-prerequisite-hint";
      node.setAttribute("role", "status");
      sendButton.after(node);
      return node;
    })();
    const config = window.__lovarpmConfig || {};
    sendButton.disabled = !hasRepo || config.enabled === false || config.chatgptEnabled === false || sendButton.dataset.sending === "true";
    if (!hasRepo) hint.textContent = "Connect GitHub to enable dispatch.";
    else if (!setupComplete) hint.textContent = "Migration runner not set up. Click 'Set up' in the Migration Runner card.";
    else hint.textContent = "";
    hint.hidden = !hint.textContent;
  }

  async function refreshStatus() {
    if (refreshInFlight) return;
    const id = projectId();
    if (!id) {
      card.dataset.state = "unused";
      statusEl.textContent = "SETUP REQUIRED";
      urlEl.textContent = "Open a Lovable project";
      fingerprintEl.textContent = "Key: —";
      setupButton.hidden = false;
      resetButton.hidden = true;
      syncDispatchGate(false);
      return;
    }
    currentProject = id;
    const endpoint = runnerUrl(id);
    urlEl.textContent = endpoint;
    urlEl.title = endpoint;
    refreshInFlight = true;
    try {
      const keyStore = await chrome.storage.local.get(["projectMigrationKeys", `projectSetup:${id}`]);
      const key = String(keyStore.projectMigrationKeys?.[id] || "");
      const setup = keyStore[`projectSetup:${id}`] || {};
      fingerprintEl.textContent = `Key: ${key.slice(0, 8) || "—"}`;
      let healthy = false;
      if (setup.setupComplete && key) {
        try {
          const response = await fetch(`${endpoint}?key=${encodeURIComponent(key)}`, { cache: "no-store", credentials: "omit" });
          healthy = response.status === 200;
        } catch (error) {
          lastError = String(error?.message || error);
        }
      }
      const ready = Boolean(setup.setupComplete && healthy);
      card.dataset.state = ready ? "connected" : (setup.setupComplete || setup.error ? "disconnected" : "unused");
      statusEl.textContent = ready ? "READY" : (setup.setupComplete || setup.error ? "FAILED" : "SETUP REQUIRED");
      setupButton.hidden = ready;
      resetButton.hidden = !ready;
      errorEl.textContent = setup.error || lastError;
      errorEl.hidden = !errorEl.textContent;
      syncDispatchGate(Boolean(setup.setupComplete));
    } finally {
      refreshInFlight = false;
    }
  }

  async function startSetup() {
    const id = projectId();
    if (!id) {
      lastError = "Open a Lovable project before setting up the migration runner.";
      await refreshStatus();
      errorEl.textContent = lastError;
      errorEl.hidden = false;
      return;
    }
    inProgress = true;
    progressStep = 1;
    statusEl.textContent = `SETTING UP (step ${progressStep}/${progressTotal})`;
    card.dataset.state = "loading";
    setupButton.disabled = true;
    errorEl.hidden = true;
    try {
      const response = await chrome.runtime.sendMessage({ type: "LOVARPM_SETUP_PROJECT", projectId: id });
      if (!response?.ok) throw new Error(response?.error || "Migration runner setup failed.");
      inProgress = false;
      await refreshStatus();
    } catch (error) {
      inProgress = false;
      lastError = String(error?.message || error);
      card.dataset.state = "disconnected";
      statusEl.textContent = "FAILED";
      errorEl.textContent = lastError;
      errorEl.hidden = false;
      syncDispatchGate(false);
    } finally {
      setupButton.disabled = false;
    }
  }

  setupButton.addEventListener("click", () => void startSetup());
  refreshButton.addEventListener("click", () => { lastError = ""; void refreshStatus(); });
  resetButton.addEventListener("click", async () => {
    const id = projectId();
    if (!id) return;
    const stored = await chrome.storage.local.get(["projectMigrationKeys", `projectSetup:${id}`]);
    const keys = { ...(stored.projectMigrationKeys || {}) };
    delete keys[id];
    await chrome.storage.local.set({ projectMigrationKeys: keys });
    await chrome.storage.local.remove(`projectSetup:${id}`);
    lastError = "";
    await startSetup();
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "SETUP_PROGRESS") {
      progressStep = Number(message.payload?.step) || progressStep;
      progressTotal = Number(message.payload?.total) || progressTotal;
      statusEl.textContent = `SETTING UP (step ${progressStep}/${progressTotal})`;
      card.dataset.state = "loading";
    } else if (message?.type === "SETUP_DONE") {
      inProgress = false;
      lastError = "";
      void refreshStatus();
    } else if (message?.type === "SETUP_FAILED") {
      inProgress = false;
      lastError = String(message.payload?.error || "Migration runner setup failed.");
      statusEl.textContent = "FAILED";
      card.dataset.state = "disconnected";
      errorEl.textContent = lastError;
      errorEl.hidden = false;
      syncDispatchGate(false);
    }
  });

  const observer = new MutationObserver(() => void refreshStatus());
  if (projectValue) observer.observe(projectValue, { childList: true, characterData: true, subtree: true });
  if (repositoryValue) observer.observe(repositoryValue, { childList: true, characterData: true, subtree: true });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.projectIntegrations || changes.workspaceBindings || changes.pendingPrompt || changes.projectMigrationKeys || Object.keys(changes).some((key) => key.startsWith("projectSetup:"))) {
      void refreshStatus();
    }
    if (changes.config) {
      window.__lovarpmConfig = changes.config.newValue || {};
      syncDispatchGate(false);
    }
  });
  void chrome.storage.local.get("config").then((stored) => {
    window.__lovarpmConfig = stored.config || {};
    return refreshStatus();
  });
})();
