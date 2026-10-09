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
  card.dataset.state = "loading";
  card.innerHTML = '<span class="integration-icon" aria-hidden="true">DB</span><div class="integration-copy"><div class="integration-title"><span class="integration-dot"></span><strong>Migration Runner</strong></div><small id="migrationRunnerStatus">Checking project backend...</small><div id="migrationRunnerDetails"></div><div class="migration-runner-actions" id="migrationRunnerActions"></div></div>';
  supabaseCard.after(card);

  const statusEl = card.querySelector("#migrationRunnerStatus");
  const details = card.querySelector("#migrationRunnerDetails");
  const actions = card.querySelector("#migrationRunnerActions");
  const projectValue = document.getElementById("projectValue");
  const repositoryValue = document.getElementById("repositoryValue");
  const sendButton = document.getElementById("sendCommandButton");
  const RUNNER_PATH = "/api/public/ops/run-migrations";
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let currentProject = "";
  let typedKey = "";
  let savedKey = "";
  let classification = "";
  let prompt = "";
  let state = "CLASSIFYING";
  let existingKeyMode = false;
  let busy = false;
  let preparingPrompt = false;
  let generation = 0;

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
    button.disabled = busy;
    button.addEventListener("click", handler);
    actions.append(button);
    return button;
  }

  function addInput(labelText, value, onInput) {
    const label = node("label");
    label.className = "migration-runner-field";
    const name = node("span", labelText);
    const input = node("input", null, {
      type: "text",
      autocomplete: "off",
      spellcheck: "false",
      "aria-label": labelText,
    });
    input.value = value;
    input.addEventListener("input", () => onInput(input.value));
    label.append(name, input);
    details.append(label);
    return input;
  }

  function setState(next, text) {
    state = next;
    card.dataset.state = next === "CLASSIFYING" || next === "VERIFYING" ? "loading"
      : next === "READY" ? "connected"
        : next === "FAILED" ? "disconnected"
          : next === "NOT_APPLICABLE" ? "unused" : "disconnected";
    statusEl.textContent = text;
    details.replaceChildren();
    actions.replaceChildren();
    renderActions();
    syncDispatchGate();
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
    if (!hasRepo) hint.textContent = "Connect GitHub to enable dispatch.";
    else if (classification === "CLOUD_DRIZZLE" && !savedKey) {
      hint.textContent = "Migration runner not set up. Schema changes will require manual application until you configure it.";
    } else hint.textContent = "";
    hint.hidden = !hint.textContent;
  }

  function renderActions() {
    actions.replaceChildren();
    if (state === "SETUP_REQUIRED") {
      if (existingKeyMode) {
        addInput("Paste your existing migration runner key.", typedKey, (value) => { typedKey = value; });
        addAction("Verify & save", () => void saveExistingKey());
      } else {
        addInput("Enter your migration runner key.", typedKey, (value) => { typedKey = value; });
        addAction("Build Lovable prompt", buildPrompt);
        addAction("I already have a key", () => {
          existingKeyMode = true;
          setState("SETUP_REQUIRED", "Paste your existing migration runner key.");
        });
      }
    } else if (state === "BUILD_PROMPT_READY") {
      const output = node("pre");
      output.className = "migration-runner-prompt";
      output.textContent = prompt;
      details.append(output, node("small", "This uses one Lovable credit for initial setup."));
      addAction("Copy prompt", copyPrompt);
      addAction("Open Lovable & paste", openAndPaste);
      addAction("Verify", () => void verifySavedKey());
    } else if (state === "READY") {
      const pendingUrl = latestRunStatus?.runnerUrl && latestRunStatus.schemaPending
        ? latestRunStatus.runnerUrl
        : `${previewHostFor(currentProject)}${RUNNER_PATH}?key=${encodeURIComponent(savedKey)}`;
      details.append(
        node("small", `Preview host: ${previewHostFor(currentProject)}`),
        node("small", pendingUrl),
        node("small", `Key fingerprint: ${savedKey.slice(0, 8) || "—"}`),
      );
      const run = latestRunStatus;
      if (run?.runnerUrl && run.schemaPending) {
        addAction("Open migration runner", () => chrome.tabs.create({ url: run.runnerUrl, active: true }));
      }
      addAction("Verify", () => void verifySavedKey());
      addAction("Reset", () => void resetKey());
    } else if (state === "VERIFYING") {
      addAction("Cancel", () => { generation += 1; busy = false; void refresh(); });
    } else if (state === "FAILED") {
      addAction("Retry", () => void verifySavedKey());
      addAction("Reset", () => void resetKey());
    } else if (state === "NOT_APPLICABLE") {
      details.append(node("small", `Schema changes require manual application.`));
    }
  }

  let latestRunStatus = null;

  function previewHostFor(id) {
    return String(latestIntegration?.previewHost || `https://${id}.lovableproject.com`).replace(/\/$/, "");
  }

  let latestIntegration = null;

  function failureMessage(error) {
    const text = String(error || "");
    if (text.includes("Route did not deploy within 3 minutes.")) return text;
    if (text.includes("Preview host not responding (HTML 404).")) return text;
    if (text.includes("Runner accepted a request without a key.")) return text;
    if (text.includes("Key rejected by runner (401).")) return "Key rejected by runner (401). The committed runner may use a different key. Rebuild and re-paste.";
    if (text.includes("Lovable AI did not respond.")) return text;
    if (text.includes("Runner returned an error.")) return text;
    return text || "Migration runner operation failed.";
  }

  function showFailure(error, detailsText = "") {
    busy = false;
    setState("FAILED", failureMessage(error));
    if (detailsText) details.append(node("small", detailsText));
  }

  async function buildPrompt() {
    const validation = validateKeyInput(typedKey);
    if (!validation.ok) {
      setState("SETUP_REQUIRED", "Enter your migration runner key.");
      details.append(node("small", validation.error));
      return;
    }
    try {
      preparingPrompt = true;
      savedKey = await setMigrationKey(currentProject, validation.value);
      prompt = buildBootstrapPrompt({ key: savedKey, previewHost: previewHostFor(currentProject) });
      existingKeyMode = false;
      setState("BUILD_PROMPT_READY", "Bootstrap prompt ready.");
    } catch (error) {
      showFailure(error instanceof Error ? error.message : String(error));
    } finally {
      preparingPrompt = false;
    }
  }

  async function copyPrompt() {
    try {
      await navigator.clipboard.writeText(prompt);
      statusEl.textContent = "Prompt copied.";
    } catch (error) {
      showFailure("Could not copy the bootstrap prompt.", String(error));
    }
  }

  async function openAndPaste() {
    try {
      const tabs = await chrome.tabs.query({ url: ["https://lovable.dev/projects/*"] });
      const tab = tabs.find((item) => item.url?.includes(currentProject));
      if (!tab?.id) throw new Error("Open the Lovable editor for this project, then try again.");
      await chrome.tabs.update(tab.id, { active: true });
      let response;
      try {
        response = await chrome.tabs.sendMessage(tab.id, { type: "LOVABLE_PASTE_BOOTSTRAP", prompt });
      } catch {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ["src/content/lovable-composer-core.js", "src/content/lovable-composer.js"],
        });
        response = await chrome.tabs.sendMessage(tab.id, { type: "LOVABLE_PASTE_BOOTSTRAP", prompt });
      }
      if (!response?.ok) throw new Error(response?.error || "Could not paste the bootstrap prompt.");
      statusEl.textContent = "Pasted. Send it and wait for Lovable to finish.";
    } catch (error) {
      showFailure(error instanceof Error ? error.message : String(error));
    }
  }

  async function pollForDeploy(url, run) {
    const started = Date.now();
    const deadline = started + 180000;
    while (Date.now() < deadline && run === generation) {
      const elapsed = Math.floor((Date.now() - started) / 1000);
      statusEl.textContent = `Waiting for deploy (${elapsed}s)...`;
      try {
        const response = await fetch(url, { method: "GET", cache: "no-store", credentials: "omit" });
        if (response.status === 401) return { ok: true };
        if (response.status === 500) {
          return {
            ok: false,
            error: "Runner returned an error. See details below.",
            detail: (await response.text()).slice(0, 500),
          };
        }
        if (response.status === 200) {
          return { ok: false, error: "Runner accepted a request without a key. Verification stopped to avoid applying migrations." };
        }
        if (response.status === 404 && (response.headers.get("content-type") || "").toLowerCase().includes("text/html")) {
          return { ok: false, error: "Preview host not responding (HTML 404). Is the project running?" };
        }
      } catch {}
      await sleep(Math.min(15000, Math.max(0, deadline - Date.now())));
    }
    if (run !== generation) return { ok: false, error: "Verification cancelled." };
    return { ok: false, error: "Route did not deploy within 3 minutes. Check the preview host is live." };
  }

  async function verifyRunner({ previewHost, key, run }) {
    void key;
    const url = `${previewHost}${RUNNER_PATH}`;
    const deploy = await pollForDeploy(url, run);
    if (!deploy.ok) return deploy;
    if (run !== generation) return { ok: false, error: "Verification cancelled." };
    statusEl.textContent = "Route live. Key will be checked when you open the runner.";
    return { ok: true };
  }

  async function verifyAndSave(key, rejectMessage) {
    if (busy) return;
    busy = true;
    const run = ++generation;
    setState("VERIFYING", "Waiting for deploy (0s)...");
    try {
      const result = await verifyRunner({ previewHost: previewHostFor(currentProject), key, run });
      if (run !== generation) return;
      busy = false;
      if (!result.ok) {
        showFailure(result.error === "Key rejected by runner (401)." && rejectMessage
          ? "Key rejected. Check and retry."
          : result.error, result.detail || "");
        return;
      }
      savedKey = key;
      await setMigrationKey(currentProject, key);
      const storeKey = `projectSetup:${currentProject}`;
      const previous = (await chrome.storage.local.get(storeKey))[storeKey] || {};
      await chrome.storage.local.set({
        [storeKey]: { ...previous, setupComplete: true, setupAt: new Date().toISOString(), error: null },
      });
      setState("READY", "Runner route deployed; key stored for your next click.");
    } catch (error) {
      showFailure(error instanceof Error ? error.message : String(error));
    } finally {
      busy = false;
    }
  }

  async function verifySavedKey() {
    if (!savedKey) return setState("SETUP_REQUIRED", "Enter your migration runner key.");
    return verifyAndSave(savedKey, false);
  }

  async function resetKey() {
    try {
      await clearMigrationKey(currentProject);
      await chrome.storage.local.remove(`projectSetup:${currentProject}`);
      const stored = await chrome.storage.local.get("projectRunStatuses");
      const runs = { ...(stored.projectRunStatuses || {}) };
      const run = { ...(runs[currentProject] || {}) };
      delete run.runnerUrl;
      run.schemaPending = false;
      runs[currentProject] = run;
      await chrome.storage.local.set({ projectRunStatuses: runs });
      savedKey = "";
      typedKey = "";
      prompt = "";
      existingKeyMode = false;
      await refresh();
    } catch (error) {
      showFailure(error instanceof Error ? error.message : String(error));
    }
  }

  async function saveExistingKey() {
    try {
      const input = details.querySelector("input");
      const value = input ? input.value : typedKey;
      const validation = validateKeyInput(value);
      if (!validation.ok) {
        details.append(node("small", validation.error));
        return;
      }
      savedKey = await setMigrationKey(currentProject, validation.value);
      await verifyAndSave(savedKey, true);
    } catch (error) {
      showFailure(error instanceof Error ? error.message : String(error));
    }
  }

  async function refresh() {
    try {
      const id = projectId();
      if (id !== currentProject) {
        typedKey = "";
        existingKeyMode = false;
        prompt = "";
      }
      currentProject = id;
      const token = ++generation;
      if (!id) {
        classification = "";
        savedKey = "";
        setState("CLASSIFYING", "Checking project backend...");
        return;
      }
      setState("CLASSIFYING", "Checking project backend...");
      const stored = await chrome.storage.local.get(["projectRunStatuses", "projectIntegrations"]);
      if (token !== generation || id !== projectId()) return;
      latestRunStatus = stored.projectRunStatuses?.[id] || null;
      latestIntegration = stored.projectIntegrations?.[id] || {};
      classification = String(latestRunStatus?.backendClassification || "").toUpperCase();
      savedKey = await getMigrationKey(id);
      if (token !== generation || id !== projectId()) return;

      if (!classification) {
        setState("CLASSIFYING", "Checking project backend...");
      } else if (classification !== "CLOUD_DRIZZLE") {
        setState("NOT_APPLICABLE", `Migration runner not applicable — this project uses ${classification}.`);
      } else if (savedKey && latestRunStatus?.runnerUrl && latestRunStatus.schemaPending) {
        setState("READY", "Schema changes are waiting for your migration runner click.");
      } else if (savedKey && (await chrome.storage.local.get(`projectSetup:${id}`))[`projectSetup:${id}`]?.setupComplete) {
        setState("READY", "Migration runner ready.");
      } else if (savedKey && existingKeyMode) {
        setState("SETUP_REQUIRED", "Paste your existing migration runner key.");
        addInput("Paste your existing migration runner key.", savedKey, (value) => { typedKey = value; });
        addAction("Verify & save", () => void saveExistingKey());
      } else {
        setState("SETUP_REQUIRED", "Enter your migration runner key.");
      }
    } catch (error) {
      showFailure(error instanceof Error ? error.message : String(error));
    }
  }

  projectValue && new MutationObserver(() => void refresh()).observe(projectValue, { childList: true, characterData: true, subtree: true });
  repositoryValue && new MutationObserver(syncDispatchGate).observe(repositoryValue, { childList: true, characterData: true, subtree: true });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (
      changes.projectRunStatuses ||
      changes.projectIntegrations ||
      (!busy && !preparingPrompt && changes.projectMigrationKeys) ||
      (!busy && changes[`projectSetup:${currentProject}`])
    ) {
      void refresh();
    }
    if (changes.config) {
      window.__lovarpmConfig = changes.config.newValue || {};
      syncDispatchGate();
    }
  });
  void chrome.storage.local.get("config").then((stored) => {
    window.__lovarpmConfig = stored.config || {};
    return refresh();
  });
})();
