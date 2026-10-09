import { buildBootstrapPrompt } from "../shared/bootstrap-builder.js";
import { clearMigrationKey, getMigrationKey, setMigrationKey, validateKeyInput } from "../shared/migration-key.js";

(() => {
  if (window.__LOVARPM_MIGRATION_RUNNER_CARD__) return;
  window.__LOVARPM_MIGRATION_RUNNER_CARD__ = true;

  const grid = document.querySelector(".integration-grid");
  const supabaseCard = document.getElementById("supabaseIntegrationCard");
  if (!grid || !supabaseCard) return;

  const card = document.createElement("div");
  card.className = "integration-card migration-runner-card";
  card.id = "migrationRunnerCard";
  card.innerHTML = '<span class="integration-icon" aria-hidden="true">DB</span><div class="integration-copy"><div class="integration-title"><span class="integration-dot"></span><strong>Migration Runner</strong></div><small class="migration-runner-status" id="migrationRunnerStatus"></small><div id="migrationRunnerDetails"></div><div class="migration-runner-actions" id="migrationRunnerActions"></div></div>';
  supabaseCard.after(card);

  const statusEl = card.querySelector("#migrationRunnerStatus");
  const details = card.querySelector("#migrationRunnerDetails");
  const actions = card.querySelector("#migrationRunnerActions");
  const projectValue = document.getElementById("projectValue");
  const repositoryValue = document.getElementById("repositoryValue");
  const sendButton = document.getElementById("sendCommandButton");
  const RUNNER_PATH = "/api/public/ops/run-migrations";
  let currentProject = "";
  let latestIntegration = {};
  let savedKey = "";
  let pendingKey = "";
  let pendingPrompt = "";
  let currentState = "NOT_CONFIGURED";
  let existingKeyMode = false;
  let failureText = "";
  let operation = 0;
  let initialization = 0;

  function projectId() {
    return String(projectValue?.textContent || "").trim().replace(/^—$/, "");
  }

  function node(tag, text, attrs = {}) {
    const element = document.createElement(tag);
    if (text != null) element.textContent = text;
    for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, value);
    return element;
  }

  function input(id, placeholder) {
    return node("input", null, {
      id,
      class: "lova-input",
      type: "text",
      autocomplete: "off",
      autocorrect: "off",
      autocapitalize: "off",
      spellcheck: "false",
      inputmode: "text",
      placeholder,
      "aria-label": placeholder,
    });
  }

  function errorSlot() {
    const slot = node("small");
    slot.className = "migration-runner-error";
    slot.setAttribute("role", "alert");
    slot.hidden = true;
    return slot;
  }

  const notConfiguredPanel = node("div");
  notConfiguredPanel.className = "migration-runner-panel";
  const instruction = node(
    "small",
    "If this project uses Lovable Cloud + Drizzle, enter a key below to enable auto-apply for schema changes. If it uses anything else, you can skip this card.",
  );
  const mainField = node("label");
  mainField.className = "migration-runner-field";
  const mainInput = input("migration-runner-key-input", "Enter your migration runner key");
  const mainError = errorSlot();
  mainField.append(mainInput, mainError);
  notConfiguredPanel.append(instruction, mainField);

  const existingField = node("label");
  existingField.className = "migration-runner-field";
  existingField.hidden = true;
  const existingInput = input("migration-runner-existing-key-input", "Paste your existing migration runner key");
  const existingError = errorSlot();
  existingField.append(existingInput, existingError);
  notConfiguredPanel.append(existingField);
  details.append(notConfiguredPanel);
  mainInput.addEventListener("input", () => {
    mainError.hidden = true;
  });
  existingInput.addEventListener("input", () => {
    existingError.hidden = true;
  });

  const promptPanel = node("div");
  promptPanel.className = "migration-runner-panel";
  promptPanel.hidden = true;
  const promptOutput = node("textarea", null, {
    id: "migration-runner-prompt-output",
    class: "lova-textarea migration-runner-prompt-output",
    rows: "14",
    readonly: "",
    "aria-label": "Lovable migration runner setup prompt",
  });
  const promptError = errorSlot();
  promptPanel.append(
    node("small", "This uses one Lovable credit for initial setup."),
    promptOutput,
    promptError,
  );
  details.append(promptPanel);

  const verifyingPanel = node("div");
  verifyingPanel.className = "migration-runner-panel migration-runner-progress";
  verifyingPanel.hidden = true;
  const progressLines = [1, 2, 3].map((phase) => {
    const line = node("small");
    line.dataset.phase = String(phase);
    verifyingPanel.append(line);
    return line;
  });
  details.append(verifyingPanel);

  const readyPanel = node("div");
  readyPanel.className = "migration-runner-panel";
  readyPanel.hidden = true;
  const runnerUrlEl = node("small");
  runnerUrlEl.className = "migration-runner-url";
  const readyKeyEl = node("small");
  readyPanel.append(runnerUrlEl, readyKeyEl);
  details.append(readyPanel);

  const failedPanel = node("div");
  failedPanel.className = "migration-runner-panel";
  failedPanel.hidden = true;
  const failedText = node("small");
  failedText.className = "migration-runner-error";
  failedPanel.append(failedText);
  details.append(failedPanel);

  function previewHostFor() {
    return String(latestIntegration.previewHost || (currentProject ? `https://${currentProject}.lovableproject.com` : "")).replace(/\/$/, "");
  }

  function showInlineError(slot, message) {
    slot.textContent = message;
    slot.hidden = false;
  }

  function addAction(label, handler, treatment = "secondary") {
    const button = node("button", label, { type: "button" });
    button.className = `migration-runner-${treatment}`;
    button.addEventListener("click", async (event) => {
      try {
        await handler(event);
      } catch (error) {
        transition("FAILED", error instanceof Error ? error.message : String(error));
      }
    });
    actions.append(button);
    return button;
  }

  function renderNotConfigured() {
    notConfiguredPanel.hidden = false;
    promptPanel.hidden = true;
    verifyingPanel.hidden = true;
    readyPanel.hidden = true;
    failedPanel.hidden = true;
    statusEl.textContent = "Not configured.";
    mainField.hidden = existingKeyMode;
    existingField.hidden = !existingKeyMode;
    actions.replaceChildren();
    if (existingKeyMode) {
      addAction("Verify & save", onVerifyExisting, "primary");
      return;
    }
    addAction("Build Lovable prompt", onBuildPrompt, "primary");
    addAction("I already have a key", async () => {
      existingKeyMode = true;
      mainError.hidden = true;
      render();
    });
  }

  function renderBuildPromptReady() {
    notConfiguredPanel.hidden = true;
    promptPanel.hidden = false;
    verifyingPanel.hidden = true;
    readyPanel.hidden = true;
    failedPanel.hidden = true;
    statusEl.textContent = "Setup prompt ready. Paste it into Lovable AI.";
    promptOutput.value = pendingPrompt;
    actions.replaceChildren();
    const copyButton = addAction("Copy prompt", onCopyPrompt);
    copyButton.id = "migration-runner-copy-button";
    addAction("Open Lovable & paste", onOpenAndPaste);
    addAction("Verify", () => startVerification("new", pendingKey || savedKey), "primary");
    addAction("Back", () => {
      pendingPrompt = "";
      pendingKey = "";
      promptError.hidden = true;
      existingKeyMode = false;
      transition("NOT_CONFIGURED");
    });
  }

  function renderVerifying() {
    notConfiguredPanel.hidden = true;
    promptPanel.hidden = true;
    verifyingPanel.hidden = false;
    readyPanel.hidden = true;
    failedPanel.hidden = true;
    statusEl.textContent = "Preparing verification...";
    progressLines[0].textContent = "Waiting for deploy...";
    progressLines[1].textContent = "Seeding migration tracking table...";
    progressLines[2].textContent = "Verifying key...";
    for (const line of progressLines) line.classList.remove("active", "complete");
    progressLines[0].classList.add("active");
    actions.replaceChildren();
  }

  function renderReady() {
    notConfiguredPanel.hidden = true;
    promptPanel.hidden = true;
    verifyingPanel.hidden = true;
    readyPanel.hidden = false;
    failedPanel.hidden = true;
    statusEl.textContent = "READY";
    runnerUrlEl.textContent = `${previewHostFor()}${RUNNER_PATH}`;
    readyKeyEl.textContent = `Key: ${savedKey.slice(0, 8)}…`;
    actions.replaceChildren();
    addAction("Verify", () => startVerification("new", savedKey), "primary");
    addAction("Reset", onReset);
  }

  function renderFailed() {
    notConfiguredPanel.hidden = true;
    promptPanel.hidden = true;
    verifyingPanel.hidden = true;
    readyPanel.hidden = true;
    failedPanel.hidden = false;
    statusEl.textContent = "Migration Runner";
    failedText.textContent = failureText || "Migration runner verification failed.";
    actions.replaceChildren();
    addAction("Retry", () => startVerification("new", savedKey), "primary");
    addAction("Reset", onReset);
  }

  function render() {
    card.dataset.state = currentState;
    if (currentState === "NOT_CONFIGURED") renderNotConfigured();
    else if (currentState === "BUILD_PROMPT_READY") renderBuildPromptReady();
    else if (currentState === "VERIFYING") renderVerifying();
    else if (currentState === "READY") renderReady();
    else if (currentState === "FAILED") renderFailed();
    syncDispatchGate();
  }

  function transition(next, error = "") {
    currentState = next;
    failureText = next === "FAILED" ? String(error || "Migration runner verification failed.") : "";
    render();
  }

  function repositoryPresent() {
    return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(repositoryValue?.textContent || "").trim());
  }

  function syncDispatchGate() {
    if (!sendButton) return;
    const config = window.__lovarpmConfig || {};
    const hasRepo = repositoryPresent();
    sendButton.disabled = !hasRepo || config.enabled === false || config.chatgptEnabled === false || sendButton.dataset.sending === "true";
    let hint = document.getElementById("dispatchPrerequisiteHint");
    if (!hint) {
      hint = node("div");
      hint.id = "dispatchPrerequisiteHint";
      hint.className = "dispatch-prerequisite-hint";
      hint.setAttribute("role", "status");
      sendButton.after(hint);
    }
    hint.textContent = hasRepo ? "" : "Connect GitHub to enable dispatch.";
    hint.hidden = !hint.textContent;
  }

  async function onBuildPrompt() {
    const validation = validateKeyInput(mainInput.value);
    if (!validation.ok) {
      showInlineError(mainError, validation.error);
      return;
    }
    mainError.hidden = true;
    pendingKey = await setMigrationKey(currentProject, validation.value);
    savedKey = pendingKey;
    pendingPrompt = buildBootstrapPrompt({ key: pendingKey, previewHost: previewHostFor() });
    existingKeyMode = false;
    transition("BUILD_PROMPT_READY");
  }

  async function onVerifyExisting() {
    const validation = validateKeyInput(existingInput.value);
    if (!validation.ok) {
      showInlineError(existingError, validation.error);
      return;
    }
    existingError.hidden = true;
    savedKey = await setMigrationKey(currentProject, validation.value);
    await startVerification("existing", savedKey);
  }

  async function onCopyPrompt(event) {
    const button = event.currentTarget;
    try {
      await navigator.clipboard.writeText(pendingPrompt);
      button.textContent = "Copied";
      setTimeout(() => {
        if (button.isConnected) button.textContent = "Copy prompt";
      }, 2000);
    } catch (error) {
      showInlineError(promptError, error instanceof Error ? error.message : String(error));
    }
  }

  async function onOpenAndPaste() {
    try {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find((item) => item.url?.includes("lovable.dev"));
      if (!tab || tab.id == null) throw new Error("Open the Lovable editor, then try again.");
      await chrome.tabs.update(tab.id, { active: true });
      let response;
      try {
        response = await chrome.tabs.sendMessage(tab.id, { type: "LOVABLE_PASTE_BOOTSTRAP", prompt: pendingPrompt });
      } catch {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ["src/content/lovable-composer-core.js", "src/content/lovable-composer.js"],
        });
        response = await chrome.tabs.sendMessage(tab.id, { type: "LOVABLE_PASTE_BOOTSTRAP", prompt: pendingPrompt });
      }
      if (!response?.ok) throw new Error(response?.error || "Could not paste the bootstrap prompt.");
      statusEl.textContent = "Pasted. Send it and wait for Lovable to finish.";
      promptError.hidden = true;
    } catch (error) {
      showInlineError(promptError, error instanceof Error ? error.message : String(error));
    }
  }

  async function verifyRunner({ previewHost, key, onProgress }) {
    if (!previewHost) {
      return { ok: false, error: "Preview host unknown. Open the Lovable editor first." };
    }
    const host = previewHost.replace(/\/$/, "");
    const runnerUrl = `${host}${RUNNER_PATH}?key=${encodeURIComponent(key)}`;
    const seedUrl = `${host}/api/public/ops/seed-migrations?key=${encodeURIComponent(key)}`;
    const started = Date.now();
    let deployed = false;

    while (Date.now() - started < 180000) {
      onProgress(`Waiting for deploy (${Math.floor((Date.now() - started) / 1000)}s)...`, 1);
      const controller = new AbortController();
      const requestTimeout = setTimeout(() => controller.abort(), Math.min(15000, 180000 - (Date.now() - started)));
      try {
        const response = await fetch(runnerUrl, { method: "GET", cache: "no-store", signal: controller.signal });
        if ([200, 401, 500].includes(response.status)) {
          deployed = true;
          break;
        }
        if (response.status === 404 && (response.headers.get("content-type") || "").includes("text/html")) {
          return { ok: false, error: "Preview host not responding (HTML 404). Is the project running?" };
        }
      } catch {
        // Network errors are expected while Lovable deploys the route.
      } finally {
        clearTimeout(requestTimeout);
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(15000, Math.max(0, 180000 - (Date.now() - started)))));
    }
    if (!deployed) return { ok: false, error: "Route did not deploy within 3 minutes." };

    onProgress("Seeding migration tracking table...", 2);
    try {
      const seedResponse = await fetch(seedUrl, { method: "GET", cache: "no-store" });
      const seedBody = await seedResponse.json().catch(() => null);
      if (seedResponse.status === 401) {
        return { ok: false, error: "Key rejected (401). The committed runner may use a different key. Rebuild the prompt and re-paste into Lovable." };
      }
      if (seedBody?.error === "no exec_sql") {
        return { ok: false, error: "exec_sql is not installed. Paste the bootstrap SQL into the Lovable SQL console manually, then click Retry." };
      }
      if (seedResponse.status !== 200 || !seedBody || seedBody.ok !== true) {
        return { ok: false, error: seedBody?.error || `Seed route returned ${seedResponse.status}.` };
      }
    } catch (error) {
      return { ok: false, error: `Seed fetch failed: ${String(error)}` };
    }

    onProgress("Verifying key...", 3);
    try {
      const response = await fetch(runnerUrl, { method: "GET", cache: "no-store" });
      const body = await response.json().catch(() => null);
      if (response.status === 200 && body?.ok === true) return { ok: true, url: runnerUrl };
      if (response.status === 401) {
        return { ok: false, error: "Key rejected (401). The committed runner may use a different key. Rebuild the prompt and re-paste into Lovable." };
      }
      if (response.status === 500) return { ok: false, error: body?.error || "Runner returned 500." };
      return { ok: false, error: body?.error || `Runner returned ${response.status}.` };
    } catch (error) {
      return { ok: false, error: `Runner fetch failed: ${String(error)}` };
    }
  }

  async function startVerification(mode, key) {
    if (mode !== "existing" && mode !== "new") throw new Error("Unknown migration runner verification mode.");
    if (!key) {
      transition("NOT_CONFIGURED");
      return;
    }
    const run = ++operation;
    try {
      transition("VERIFYING");
      const result = await verifyRunner({
        previewHost: previewHostFor(),
        key,
        onProgress: (message, phase) => {
          if (run !== operation) return;
          statusEl.textContent = message;
          progressLines.forEach((line, index) => {
            line.classList.toggle("complete", index + 1 < phase);
            line.classList.toggle("active", index + 1 === phase);
            if (index + 1 === phase) line.textContent = message;
          });
        },
      });
      if (run !== operation) return;
      if (result.ok) {
        savedKey = key;
        const setupKey = `projectSetup:${currentProject}`;
        const previous = (await chrome.storage.local.get(setupKey))[setupKey] || {};
        await chrome.storage.local.set({
          [setupKey]: { ...previous, setupComplete: true, setupAt: new Date().toISOString(), error: null },
        });
        transition("READY");
      } else {
        transition("FAILED", result.error);
      }
    } catch (error) {
      if (run === operation) transition("FAILED", error instanceof Error ? error.message : String(error));
    }
  }

  async function onReset() {
    ++operation;
    await clearMigrationKey(currentProject);
    await chrome.storage.local.remove(`projectSetup:${currentProject}`);
    savedKey = "";
    pendingKey = "";
    pendingPrompt = "";
    mainInput.value = "";
    existingInput.value = "";
    existingKeyMode = false;
    mainError.hidden = true;
    existingError.hidden = true;
    promptError.hidden = true;
    transition("NOT_CONFIGURED");
  }

  async function initialize() {
    const run = ++initialization;
    try {
      const id = projectId();
      if (!id) {
        currentProject = "";
        transition("NOT_CONFIGURED");
        return;
      }
      const changedProject = id !== currentProject;
      if (changedProject) {
        ++operation;
        pendingKey = "";
        pendingPrompt = "";
        existingKeyMode = false;
      }
      currentProject = id;
      const stored = await chrome.storage.local.get(["projectIntegrations", `projectSetup:${id}`]);
      if (run !== initialization || id !== projectId()) return;
      latestIntegration = stored.projectIntegrations?.[id] || {};
      if (!changedProject) {
        if (currentState === "READY") renderReady();
        return;
      }
      savedKey = await getMigrationKey(id);
      if (run !== initialization || id !== projectId()) return;
      const setupComplete = Boolean(stored[`projectSetup:${id}`]?.setupComplete);
      if (!savedKey) {
        pendingKey = "";
        pendingPrompt = "";
        transition("NOT_CONFIGURED");
      } else if (setupComplete) {
        transition("READY");
      } else {
        pendingKey = savedKey;
        pendingPrompt = buildBootstrapPrompt({ key: pendingKey, previewHost: previewHostFor() });
        transition("BUILD_PROMPT_READY");
      }
    } catch (error) {
      transition("FAILED", error instanceof Error ? error.message : String(error));
    }
  }

  projectValue && new MutationObserver(() => void initialize()).observe(projectValue, { childList: true, characterData: true, subtree: true });
  repositoryValue && new MutationObserver(syncDispatchGate).observe(repositoryValue, { childList: true, characterData: true, subtree: true });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.projectIntegrations) void initialize();
    if (changes.config) {
      window.__lovarpmConfig = changes.config.newValue || {};
      syncDispatchGate();
    }
  });
  void chrome.storage.local.get("config").then(async (stored) => {
    window.__lovarpmConfig = stored.config || {};
    await initialize();
  }).catch((error) => {
    transition("FAILED", error instanceof Error ? error.message : String(error));
  });
})();
