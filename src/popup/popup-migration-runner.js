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
  card.dataset.state = "NOT_CONFIGURED";
  card.innerHTML = '<span class="integration-icon" aria-hidden="true">DB</span><div class="integration-copy"><div class="integration-title"><span class="integration-dot"></span><strong>Migration Runner</strong></div><small id="migrationRunnerStatus"></small><div id="migrationRunnerDetails"></div><div class="migration-runner-actions" id="migrationRunnerActions"></div></div>';
  supabaseCard.after(card);

  const statusEl = card.querySelector("#migrationRunnerStatus");
  const details = card.querySelector("#migrationRunnerDetails");
  const actions = card.querySelector("#migrationRunnerActions");
  const projectValue = document.getElementById("projectValue");
  const repositoryValue = document.getElementById("repositoryValue");
  const sendButton = document.getElementById("sendCommandButton");
  const RUNNER_PATH = "/api/public/ops/run-migrations";
  let currentProject = "";
  let latestIntegration = null;
  let savedKey = "";
  let typedKey = "";
  let pendingKey = "";
  let pendingPrompt = "";
  let currentState = "NOT_CONFIGURED";
  let existingKeyMode = false;
  let failureText = "";
  let operation = 0;
  let initialization = 0;

  function stateStorageKey(id = currentProject) {
    return `migrationCardState:${id}`;
  }

  function errorStorageKey(id = currentProject) {
    return `migrationCardError:${id}`;
  }

  function projectId() {
    return String(projectValue?.textContent || "").trim().replace(/^—$/, "");
  }

  function repositoryPresent() {
    return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(repositoryValue?.textContent || "").trim());
  }

  function node(tag, text, attrs = {}) {
    const element = document.createElement(tag);
    if (text != null) element.textContent = text;
    for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, value);
    return element;
  }

  function addAction(label, handler) {
    const button = node("button", label, { type: "button" });
    button.addEventListener("click", async (event) => {
      try {
        await handler(event);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        try {
          await transition("FAILED", message);
        } catch (storageError) {
          currentState = "FAILED";
          failureText = `${message} (Could not save card state: ${storageError instanceof Error ? storageError.message : String(storageError)})`;
          render();
        }
      }
    });
    actions.append(button);
    return button;
  }

  function showInlineError(message) {
    const slot = details.querySelector(".migration-runner-error");
    if (!slot) return;
    slot.textContent = message;
    slot.hidden = false;
  }

  function addInput(id, placeholder, value) {
    const input = node("input", null, {
      id,
      type: "text",
      autocomplete: "off",
      spellcheck: "false",
      placeholder,
      "aria-label": placeholder,
    });
    input.value = value;
    input.addEventListener("input", () => {
      if (id === "migration-runner-key-input") typedKey = input.value;
      if (id === "migration-runner-existing-key-input") typedKey = input.value;
      const slot = details.querySelector(".migration-runner-error");
      if (slot) slot.hidden = true;
    });
    details.append(input);
    return input;
  }

  function addErrorSlot() {
    const slot = node("small");
    slot.className = "migration-runner-error";
    slot.setAttribute("role", "alert");
    slot.hidden = true;
    details.append(slot);
  }

  function previewHostFor() {
    return String(latestIntegration?.previewHost || (currentProject ? `https://${currentProject}.lovableproject.com` : "")).replace(/\/$/, "");
  }

  function renderNotConfigured() {
    statusEl.textContent = "Not configured.";
    details.append(
      node("small", "If this project uses Lovable Cloud + Drizzle, enter a key below to enable auto-apply for schema changes. If it uses anything else, you can skip this card."),
    );
    if (existingKeyMode) {
      addInput("migration-runner-existing-key-input", "Paste your existing migration runner key", typedKey);
      addErrorSlot();
      addAction("Verify & save", onVerifyExisting);
      return;
    }
    addInput("migration-runner-key-input", "Enter your migration runner key", typedKey);
    addErrorSlot();
    addAction("Build Lovable prompt", onBuildPrompt);
    addAction("I already have a key", async () => {
      existingKeyMode = true;
      await transition("NOT_CONFIGURED");
    });
  }

  function renderBuildPromptReady() {
    statusEl.textContent = "Setup prompt ready. Paste it into Lovable AI.";
    const output = node("textarea");
    output.id = "migration-runner-prompt-output";
    output.className = "migration-runner-prompt-output";
    output.readOnly = true;
    output.value = pendingPrompt;
    output.setAttribute("aria-label", "Lovable migration runner setup prompt");
    details.append(output, node("small", "This uses one Lovable credit for initial setup."));
    addErrorSlot();
    const copyButton = addAction("Copy prompt", onCopyPrompt);
    copyButton.id = "migration-runner-copy-button";
    addAction("Open Lovable & paste", onOpenAndPaste);
    addAction("Verify", async () => startVerification("new", pendingKey || savedKey));
    addAction("Back", async () => {
      typedKey = pendingKey || savedKey || typedKey;
      pendingPrompt = "";
      pendingKey = "";
      existingKeyMode = false;
      await transition("NOT_CONFIGURED");
    });
  }

  function renderReady() {
    statusEl.textContent = "READY";
    const runnerUrl = `${previewHostFor()}${RUNNER_PATH}`;
    details.append(
      node("small", runnerUrl),
      node("small", `Key: ${savedKey.slice(0, 8)}…`),
    );
    addAction("Verify", async () => startVerification("new", savedKey));
    addAction("Reset", onReset);
  }

  function renderFailed() {
    statusEl.textContent = failureText || "Migration runner verification failed.";
    statusEl.classList.add("migration-runner-error");
    addAction("Retry", async () => startVerification("new", savedKey));
    addAction("Reset", onReset);
  }

  function render() {
    statusEl.classList.remove("migration-runner-error");
    details.replaceChildren();
    actions.replaceChildren();
    card.dataset.state = currentState;
    if (currentState === "NOT_CONFIGURED") renderNotConfigured();
    else if (currentState === "BUILD_PROMPT_READY") renderBuildPromptReady();
    else if (currentState === "VERIFYING") statusEl.textContent = "Preparing verification...";
    else if (currentState === "READY") renderReady();
    else if (currentState === "FAILED") renderFailed();
    syncDispatchGate();
  }

  async function transition(next, error = "") {
    currentState = next;
    failureText = next === "FAILED" ? String(error || "Migration runner verification failed.") : "";
    render();
    const values = {
      [stateStorageKey()]: next,
      [errorStorageKey()]: failureText,
    };
    await chrome.storage.local.set(values);
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
    const validation = validateKeyInput(typedKey);
    if (!validation.ok) {
      showInlineError(validation.error);
      return;
    }
    try {
      pendingKey = await setMigrationKey(currentProject, validation.value);
      savedKey = pendingKey;
      pendingPrompt = buildBootstrapPrompt({ key: pendingKey, previewHost: previewHostFor() });
      existingKeyMode = false;
      await transition("BUILD_PROMPT_READY");
    } catch (error) {
      await transition("FAILED", error instanceof Error ? error.message : String(error));
    }
  }

  async function onVerifyExisting() {
    const input = details.querySelector("#migration-runner-existing-key-input");
    const validation = validateKeyInput(input?.value ?? typedKey);
    if (!validation.ok) {
      showInlineError(validation.error);
      return;
    }
    try {
      typedKey = validation.value;
      savedKey = await setMigrationKey(currentProject, validation.value);
      await startVerification("existing", savedKey);
    } catch (error) {
      await transition("FAILED", error instanceof Error ? error.message : String(error));
    }
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
      showInlineError(error instanceof Error ? error.message : String(error));
    }
  }

  async function onOpenAndPaste() {
    try {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find((item) => item.url?.includes("lovable.dev"));
      if (!tab?.id) throw new Error("Open the Lovable editor, then try again.");
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
    } catch (error) {
      showInlineError(error instanceof Error ? error.message : String(error));
    }
  }

  async function verifyRunner({ previewHost, key, onProgress }) {
    if (!previewHost) {
      return { ok: false, error: "Preview host unknown. Open the Lovable editor first." };
    }
    const url = `${previewHost.replace(/\/$/, "")}${RUNNER_PATH}?key=${encodeURIComponent(key)}`;
    const started = Date.now();
    while (Date.now() - started < 180000) {
      onProgress(`Waiting for deploy (${Math.floor((Date.now() - started) / 1000)}s)...`);
      const controller = new AbortController();
      const requestTimeout = setTimeout(() => controller.abort(), Math.min(15000, 180000 - (Date.now() - started)));
      try {
        const response = await fetch(url, { method: "GET", cache: "no-store", signal: controller.signal });
        if (response.status === 200) {
          const body = await response.json().catch(() => null);
          if (body && body.ok === true) return { ok: true, url };
          return { ok: false, error: body?.error || "Runner returned ok:false." };
        }
        if (response.status === 401) {
          return { ok: false, error: "Key rejected (401). The committed runner may use a different key. Rebuild the prompt and re-paste into Lovable." };
        }
        if (response.status === 500) {
          const body = await response.json().catch(() => null);
          return { ok: false, error: body?.error || "Runner returned 500." };
        }
        if (response.status === 404) {
          const contentType = response.headers.get("content-type") || "";
          if (contentType.includes("text/html")) {
            return { ok: false, error: "Preview host not responding (HTML 404). Is the project running?" };
          }
        }
      } catch {
        // Network errors are expected while Lovable deploys the route.
      } finally {
        clearTimeout(requestTimeout);
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(15000, Math.max(0, 180000 - (Date.now() - started)))));
    }
    return { ok: false, error: "Route did not deploy within 3 minutes." };
  }

  async function startVerification(mode, key) {
    if (!key) {
      await transition("NOT_CONFIGURED");
      return;
    }
    if (mode !== "existing" && mode !== "new") throw new Error("Unknown migration runner verification mode.");
    const run = ++operation;
    try {
      await transition("VERIFYING");
      const result = await verifyRunner({
        previewHost: previewHostFor(),
        key,
        onProgress: (message) => {
          if (run === operation) statusEl.textContent = message;
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
        await transition("READY");
      } else {
        await transition("FAILED", result.error);
      }
    } catch (error) {
      if (run === operation) {
        await transition("FAILED", error instanceof Error ? error.message : String(error));
      }
    }
  }

  async function onReset() {
    ++operation;
    try {
      await clearMigrationKey(currentProject);
      await chrome.storage.local.remove(`projectSetup:${currentProject}`);
      savedKey = "";
      typedKey = "";
      pendingKey = "";
      pendingPrompt = "";
      existingKeyMode = false;
      await transition("NOT_CONFIGURED");
    } catch (error) {
      await transition("FAILED", error instanceof Error ? error.message : String(error));
    }
  }

  async function initialize() {
    const run = ++initialization;
    try {
      const id = projectId();
      if (!id) {
        currentProject = "";
        await transition("NOT_CONFIGURED");
        return;
      }
      if (id !== currentProject) {
        ++operation;
        typedKey = "";
        pendingKey = "";
        pendingPrompt = "";
        existingKeyMode = false;
      }
      currentProject = id;
      const stored = await chrome.storage.local.get([
        "projectIntegrations",
        `projectSetup:${id}`,
        stateStorageKey(id),
        errorStorageKey(id),
      ]);
      if (run !== initialization || id !== projectId()) return;
      latestIntegration = stored.projectIntegrations?.[id] || {};
      savedKey = await getMigrationKey(id);
      if (run !== initialization || id !== projectId()) return;
      typedKey = savedKey;
      const setupComplete = Boolean(stored[`projectSetup:${id}`]?.setupComplete);
      const savedState = stored[stateStorageKey(id)];
      failureText = String(stored[errorStorageKey(id)] || "");

      if (!savedKey) {
        pendingKey = "";
        pendingPrompt = "";
        await transition("NOT_CONFIGURED");
      } else if (savedState === "NOT_CONFIGURED") {
        await transition("NOT_CONFIGURED");
      } else if (savedState === "BUILD_PROMPT_READY") {
        pendingKey = savedKey;
        pendingPrompt = buildBootstrapPrompt({ key: pendingKey, previewHost: previewHostFor() });
        await transition("BUILD_PROMPT_READY");
      } else if (savedState === "VERIFYING") {
        await startVerification("new", savedKey);
      } else if (savedState === "FAILED") {
        await transition("FAILED", failureText);
      } else if (savedState === "READY" && setupComplete) {
        await transition("READY");
      } else if (setupComplete) {
        await transition("READY");
      } else {
        pendingKey = savedKey;
        pendingPrompt = buildBootstrapPrompt({ key: pendingKey, previewHost: previewHostFor() });
        await transition("BUILD_PROMPT_READY");
      }
    } catch (error) {
      await transition("FAILED", error instanceof Error ? error.message : String(error));
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
  }).catch(async (error) => {
    await transition("FAILED", error instanceof Error ? error.message : String(error));
  });
})();
