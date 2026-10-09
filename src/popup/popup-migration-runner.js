import { EXEC_SQL_PROMPT, RUNNER_SETUP_PROMPT_TEMPLATE } from "../shared/constants.js";
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
  card.innerHTML = `
    <span class="integration-icon" aria-hidden="true">DB</span>
    <div class="integration-copy">
      <div class="integration-title"><span class="integration-dot"></span><strong>Migration Runner</strong></div>
      <small class="migration-runner-status" id="migrationRunnerStatus"></small>
      <small class="migration-runner-hint">Optional — only needed for Lovable Cloud + Drizzle projects.</small>
      <section class="migration-runner-panel" id="migrationRunnerDetails"></section>
      <div class="migration-runner-actions" id="migrationRunnerActions"></div>
      <section class="migration-runner-helper">
        <strong>First-time helper</strong>
        <small>Install the exec_sql function once per project. Paste this prompt into Lovable AI's chat.</small>
        <div class="migration-runner-actions" id="migrationRunnerHelperActions"></div>
        <small id="migrationRunnerHelperMessage" role="status" aria-live="polite"></small>
      </section>
    </div>`;
  supabaseCard.after(card);

  const statusEl = card.querySelector("#migrationRunnerStatus");
  const details = card.querySelector("#migrationRunnerDetails");
  const actions = card.querySelector("#migrationRunnerActions");
  const helperActions = card.querySelector("#migrationRunnerHelperActions");
  const helperMessage = card.querySelector("#migrationRunnerHelperMessage");
  const projectValue = document.getElementById("projectValue");
  const RUNNER_PATH = "/api/public/ops/run-migrations";

  const node = (tag, text, attrs = {}) => {
    const element = document.createElement(tag);
    if (text != null) element.textContent = text;
    for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, value);
    return element;
  };
  const makeInput = (id, placeholder) => node("input", null, {
    id,
    class: "lova-input migration-runner-key",
    type: "text",
    autocomplete: "off",
    autocorrect: "off",
    autocapitalize: "off",
    spellcheck: "false",
    inputmode: "text",
    placeholder,
    "aria-label": placeholder,
  });
  const errorSlot = () => {
    const element = node("small");
    element.className = "migration-runner-error";
    element.setAttribute("role", "alert");
    element.hidden = true;
    return element;
  };

  const mainInput = makeInput("migration-runner-key-input", "Enter your migration runner key");
  const mainError = errorSlot();
  const existingInput = makeInput("migration-runner-existing-key-input", "Paste your existing migration runner key");
  const existingError = errorSlot();
  const keyField = node("label");
  keyField.className = "migration-runner-field";
  keyField.append(mainInput, mainError);
  const existingField = node("label");
  existingField.className = "migration-runner-field";
  existingField.hidden = true;
  existingField.append(existingInput, existingError);
  const stateMessage = node("small");
  stateMessage.className = "migration-runner-message";
  const readonlyKey = makeInput("migration-runner-dispatched-key", "Migration runner key");
  readonlyKey.readOnly = true;
  readonlyKey.setAttribute("aria-label", "Migration runner key fingerprint");
  const readonlyField = node("label");
  readonlyField.className = "migration-runner-field";
  readonlyField.hidden = true;
  readonlyField.append(readonlyKey);
  const runnerUrl = node("small");
  runnerUrl.className = "migration-runner-url";
  const fingerprint = node("small");
  const failure = node("small");
  failure.className = "migration-runner-error";
  details.append(keyField, existingField, readonlyField, runnerUrl, fingerprint, failure, stateMessage);

  const copyButton = node("button", "Copy exec_sql prompt", { type: "button" });
  copyButton.className = "migration-runner-secondary";
  copyButton.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(EXEC_SQL_PROMPT);
      copyButton.textContent = "Copied";
      setTimeout(() => {
        if (copyButton.isConnected) copyButton.textContent = "Copy exec_sql prompt";
      }, 2000);
    } catch (error) {
      showHelperMessage(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  const injectButton = node("button", "Inject into Lovable AI", { type: "button" });
  injectButton.className = "migration-runner-secondary";
  injectButton.addEventListener("click", () => void injectExecSqlPrompt());
  helperActions.append(copyButton, injectButton);

  let currentProject = "";
  let latestIntegration = {};
  let savedKey = "";
  let currentState = "NOT_CONFIGURED";
  let existingKeyMode = false;
  let failureText = "";
  let busySetup = false;
  let justDispatched = false;
  let operation = 0;
  let initialization = 0;

  function projectId() {
    return String(projectValue?.textContent || "").trim().replace(/^—$/, "");
  }

  function previewHostFor() {
    return String(latestIntegration.previewHost || (currentProject ? `https://${currentProject}.lovableproject.com` : "")).replace(/\/$/, "");
  }

  function showHelperMessage(text) {
    helperMessage.textContent = text;
  }

  function showInlineError(slot, message) {
    slot.textContent = message;
    slot.hidden = false;
  }

  function transition(next, error = "") {
    currentState = next;
    failureText = next === "FAILED" ? String(error || "Migration runner verification failed.") : "";
    render();
  }

  function addAction(label, handler, treatment = "secondary", disabled = false) {
    const button = node("button", label, { type: "button" });
    button.className = `migration-runner-${treatment}`;
    button.disabled = disabled;
    button.addEventListener("click", async (event) => {
      const actionProject = currentProject;
      try {
        await handler(event);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (currentProject === actionProject) transition("FAILED", message);
        else showHelperMessage(`Migration Runner action for ${actionProject} failed: ${message}`);
      }
    });
    actions.append(button);
    return button;
  }

  function showPanels({ input = false, readonly = false, url = false, error = false, message = false } = {}) {
    keyField.hidden = !input || existingKeyMode;
    existingField.hidden = !input || !existingKeyMode;
    readonlyField.hidden = !readonly;
    runnerUrl.hidden = !url;
    fingerprint.hidden = !url;
    failure.hidden = !error;
    stateMessage.hidden = !message;
  }

  function renderNotConfigured() {
    showPanels({ input: true });
    statusEl.textContent = "NOT CONFIGURED";
    stateMessage.textContent = "";
    actions.replaceChildren();
    if (existingKeyMode) {
      addAction("Save & enable Test", onSaveExistingKey, "primary");
      addAction("Back", () => {
        existingKeyMode = false;
        render();
      });
      return;
    }
    addAction("Set up migration runner", onSetup, "primary", busySetup);
    addAction("I already have a key", () => {
      existingKeyMode = true;
      mainError.hidden = true;
      render();
    });
  }

  function renderDispatched() {
    showPanels({ readonly: true, message: true });
    statusEl.textContent = "SETUP DISPATCHED";
    readonlyKey.value = "••••••••";
    stateMessage.textContent = justDispatched
      ? "Setup task dispatched. Wait for ChatGPT to commit and Lovable to deploy (~1-2 minutes), then click Test runner."
      : "Setup task dispatched. If you haven't seen ChatGPT commit yet, wait a bit and click Test runner.";
    justDispatched = false;
    actions.replaceChildren();
    addAction("Test runner", onTest, "primary");
    addAction("I already have a key", () => {
      existingKeyMode = true;
      renderDispatchedWithExistingInput();
    });
  }

  function renderDispatchedWithExistingInput() {
    showPanels({ readonly: true, input: true, message: true });
    statusEl.textContent = "SETUP DISPATCHED";
    readonlyKey.value = "••••••••";
    stateMessage.textContent = "Setup task dispatched. If you haven't seen ChatGPT commit yet, wait a bit and click Test runner.";
    actions.replaceChildren();
    addAction("Save & enable Test", onSaveExistingKey, "primary");
    addAction("Test runner", onTest);
  }

  function renderReadyUntested() {
    showPanels();
    statusEl.textContent = "READY — UNTESTED";
    stateMessage.textContent = "";
    actions.replaceChildren();
    addAction("Test runner", onTest, "primary");
    addAction("Reset", onReset);
  }

  function renderTesting() {
    showPanels({ message: true });
    statusEl.textContent = "TESTING";
    stateMessage.textContent = "Testing runner...";
    actions.replaceChildren();
    addAction("Test runner", onTest, "primary", true);
  }

  function renderReady() {
    showPanels({ url: true, message: true });
    statusEl.textContent = "READY";
    const previewHost = previewHostFor();
    const keyFingerprint = savedKey.slice(0, 8);
    runnerUrl.textContent = `${previewHost}${RUNNER_PATH}?key=${keyFingerprint}…`;
    fingerprint.textContent = `Key fingerprint: ${keyFingerprint}…`;
    stateMessage.textContent = "";
    actions.replaceChildren();
    addAction("Test runner", onTest, "primary");
    addAction("Reset", onReset);
  }

  function renderFailed() {
    showPanels({ error: true });
    statusEl.textContent = "FAILED";
    failure.textContent = failureText || "Migration runner verification failed.";
    stateMessage.textContent = "";
    actions.replaceChildren();
    addAction("Test runner", onTest, "primary");
    addAction("Reset", onReset);
  }

  function render() {
    card.dataset.state = currentState;
    if (currentState === "NOT_CONFIGURED") renderNotConfigured();
    else if (currentState === "DISPATCHED") renderDispatched();
    else if (currentState === "READY-UNTESTED") renderReadyUntested();
    else if (currentState === "TESTING") renderTesting();
    else if (currentState === "READY") renderReady();
    else if (currentState === "FAILED") renderFailed();
  }

  async function saveSetupRecord(id, patch) {
    const stored = await chrome.storage.local.get("projectSetup");
    const all = stored.projectSetup || {};
    await chrome.storage.local.set({
      projectSetup: { ...all, [id]: { ...(all[id] || {}), ...patch } },
    });
  }

  function errorForResult(result) {
    if (result === "unauthorized") return "Key rejected (401). The committed runner uses a different key.";
    if (result === "missing-exec-sql") return "Runner deployed, but exec_sql is not installed. Use the exec_sql helper below, then click Test runner again.";
    if (result === "not-deployed") return "Runner not deployed yet. Wait ~1 minute and try again.";
    if (result === "host-unreachable") return "Preview host not responding. Is the project running?";
    return "Runner verification failed.";
  }

  async function dispatchSetupPrompt(prompt, id) {
    const tabs = await chrome.tabs.query({ url: ["https://lovable.dev/projects/*"] });
    const editor = tabs.find((tab) => tab.url?.includes(id));
    if (!editor?.id) throw new Error("Open this Lovable project before setting up the migration runner.");
    const response = await chrome.tabs.sendMessage(editor.id, {
      type: "LOVABURST_SUBMIT_OBJECTIVE",
      objective: prompt,
      skills: [],
    });
    if (!response?.ok) throw new Error(response?.error || "ChatGPT did not confirm the setup task dispatch.");
  }

  function promptWithKey(key) {
    const sampleKey = "xk92fQ3nzL7mVp8sWjT4hD6yR1eB5cN2";
    let prompt = RUNNER_SETUP_PROMPT_TEMPLATE.replace(sampleKey, () => key);
    if (/["\\`]|[\u0000-\u001f\u007f]/.test(key)) {
      const constantLine = `const RUNNER_KEY = "${key}";`;
      const note = [
        "// NOTE: the key above contains characters that must be escaped",
        "// in a TS string literal. Use JSON.stringify semantics when",
        '// writing this constant: RUNNER_KEY = "..." must be a valid',
        "// JavaScript string literal that evaluates to the exact key",
        "// above. Escape backslashes, double quotes, and control",
        "// characters accordingly.",
      ].join("\n");
      prompt = prompt.replace(constantLine, () => `${constantLine}\n\n${note}`);
    }
    return prompt;
  }

  async function onSetup() {
    const validation = validateKeyInput(mainInput.value);
    if (!validation.ok) {
      showInlineError(mainError, validation.error);
      return;
    }
    mainError.hidden = true;
    const id = currentProject;
    busySetup = true;
    render();
    try {
      const key = await setMigrationKey(id, validation.value);
      await saveSetupRecord(id, {
        setupDispatchedAt: null,
        lastVerifiedAt: null,
        lastVerifyResult: null,
        lastVerifyError: null,
      });
      await dispatchSetupPrompt(promptWithKey(validation.value), id);
      await saveSetupRecord(id, { setupDispatchedAt: new Date().toISOString() });
      if (currentProject === id) {
        savedKey = key;
        justDispatched = true;
        transition("DISPATCHED");
      }
    } finally {
      busySetup = false;
      if (currentState === "NOT_CONFIGURED") render();
    }
  }

  async function onSaveExistingKey() {
    const validation = validateKeyInput(existingInput.value);
    if (!validation.ok) {
      showInlineError(existingError, validation.error);
      return;
    }
    existingError.hidden = true;
    const id = currentProject;
    const key = await setMigrationKey(id, validation.value);
    await saveSetupRecord(id, {
      setupDispatchedAt: null,
      lastVerifiedAt: null,
      lastVerifyResult: null,
      lastVerifyError: null,
    });
    existingInput.value = "";
    existingKeyMode = false;
    if (currentProject === id) {
      savedKey = key;
      transition("READY-UNTESTED");
    }
  }

  async function verifyRunner({ previewHost, key }) {
    if (!previewHost) {
      return {
        ok: false,
        result: "host-unreachable",
        error: "Preview host unknown. Open the Lovable editor first.",
      };
    }
    const url = `${previewHost.replace(/\/$/, "")}${RUNNER_PATH}?key=${encodeURIComponent(key)}`;
    let response;
    try {
      response = await fetch(url, { method: "GET", cache: "no-store" });
    } catch (error) {
      return { ok: false, result: "not-deployed", error: `Network error: ${String(error)}` };
    }

    const contentType = response.headers.get("content-type") || "";
    const body = contentType.includes("application/json")
      ? await response.json().catch(() => null)
      : null;
    if (response.status === 200 && body?.ok === true) {
      return { ok: true, result: "ready", url, applied: body.applied, skipped: body.skipped };
    }
    if (response.status === 401) {
      return {
        ok: false,
        result: "unauthorized",
        error: "Key rejected (401). The committed runner uses a different key.",
      };
    }
    if (response.status === 500) {
      const error = body?.error || "";
      if (error.includes("exec_sql") || error.startsWith("init:")) {
        return {
          ok: false,
          result: "missing-exec-sql",
          error: "Runner deployed, but exec_sql is not installed. Use the exec_sql helper below, then click Test runner again.",
        };
      }
      return { ok: false, result: "failed", error: error || "Runner returned 500." };
    }
    if (response.status === 404) {
      if (contentType.includes("text/html")) {
        return {
          ok: false,
          result: "host-unreachable",
          error: "Preview host not responding. Is the project running?",
        };
      }
      return {
        ok: false,
        result: "not-deployed",
        error: "Runner not deployed yet. Wait ~1 minute and try again.",
      };
    }
    return { ok: false, result: "failed", error: body?.error || `Runner returned ${response.status}.` };
  }

  async function onTest() {
    if (!savedKey || !currentProject) throw new Error("Set a migration runner key before testing.");
    const id = currentProject;
    const key = savedKey;
    const previewHost = previewHostFor();
    const run = ++operation;
    transition("TESTING");
    const result = await verifyRunner({ previewHost, key });
    if (run !== operation || id !== currentProject) return;
    const lastVerifiedAt = new Date().toISOString();
    await saveSetupRecord(id, {
      lastVerifiedAt,
      lastVerifyResult: result.result,
      lastVerifyError: result.ok ? null : result.error,
    });
    if (result.ok) {
      transition("READY");
      return;
    }
    transition("FAILED", result.error);
  }

  async function onReset() {
    ++operation;
    const id = currentProject;
    await clearMigrationKey(id);
    const stored = await chrome.storage.local.get("projectSetup");
    const setup = { ...(stored.projectSetup || {}) };
    delete setup[id];
    if (Object.keys(setup).length) await chrome.storage.local.set({ projectSetup: setup });
    else await chrome.storage.local.remove("projectSetup");
    await chrome.storage.local.remove(`projectSetup:${id}`);
    if (currentProject === id) {
      savedKey = "";
      existingKeyMode = false;
      mainInput.value = "";
      existingInput.value = "";
      mainError.hidden = true;
      existingError.hidden = true;
      transition("NOT_CONFIGURED");
    }
  }

  async function injectExecSqlPrompt() {
    showHelperMessage("");
    const tabs = await chrome.tabs.query({});
    const lovableTab = tabs.find((tab) => tab.url && tab.url.includes("lovable.dev"));
    if (!lovableTab?.id) {
      await navigator.clipboard.writeText(EXEC_SQL_PROMPT);
      showHelperMessage("Lovable tab not open. Prompt copied — open Lovable and paste.");
      return;
    }
    await chrome.tabs.update(lovableTab.id, { active: true });
    const result = await new Promise((resolve) => {
      chrome.tabs.sendMessage(
        lovableTab.id,
        { type: "LOVABLE_PASTE_BOOTSTRAP", prompt: EXEC_SQL_PROMPT },
        (response) => {
          const error = chrome.runtime.lastError;
          resolve(error
            ? { ok: false, error: error.message }
            : response || { ok: false, error: "unknown" });
        },
      );
    });
    if (!result.ok) {
      showHelperMessage(`Error: ${result.error || "unknown"}`);
      return;
    }
    showHelperMessage("Prompt injected. Review in Lovable and click Send.");
  }

  async function initialize() {
    const run = ++initialization;
    try {
      const id = projectId();
      if (!id) {
        currentProject = "";
        savedKey = "";
        transition("NOT_CONFIGURED");
        return;
      }
      const changedProject = id !== currentProject;
      if (busySetup && !changedProject) return;
      if (changedProject) {
        ++operation;
        currentProject = id;
        existingKeyMode = false;
      }
      const stored = await chrome.storage.local.get(["projectIntegrations", "projectSetup", `projectSetup:${id}`]);
      if (run !== initialization || id !== projectId()) return;
      latestIntegration = stored.projectIntegrations?.[id] || {};
      savedKey = await getMigrationKey(id);
      if (run !== initialization || id !== projectId()) return;
      if (!savedKey) {
        transition("NOT_CONFIGURED");
        return;
      }

      let setup = stored.projectSetup?.[id] || {};
      const legacySetup = stored[`projectSetup:${id}`];
      if (!Object.keys(setup).length && legacySetup?.setupComplete) {
        setup = {
          setupDispatchedAt: legacySetup.setupAt || null,
          lastVerifiedAt: legacySetup.setupAt || null,
          lastVerifyResult: "ready",
        };
        await saveSetupRecord(id, setup);
      }
      if (setup.lastVerifyResult === "ready") {
        transition("READY");
      } else if (setup.lastVerifyResult) {
        transition("FAILED", setup.lastVerifyError || errorForResult(setup.lastVerifyResult));
      } else if (setup.setupDispatchedAt) {
        transition("DISPATCHED");
      } else {
        transition("READY-UNTESTED");
      }
    } catch (error) {
      transition("FAILED", error instanceof Error ? error.message : String(error));
    }
  }

  mainInput.addEventListener("input", () => { mainError.hidden = true; });
  existingInput.addEventListener("input", () => { existingError.hidden = true; });
  projectValue && new MutationObserver(() => void initialize()).observe(projectValue, {
    childList: true,
    characterData: true,
    subtree: true,
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.projectIntegrations || changes.projectMigrationKeys || changes.projectSetup) void initialize();
  });
  void initialize();
})();
