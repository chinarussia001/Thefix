"use strict";

(() => {
  const $ = (selector) => document.querySelector(selector);
  const ui = {
    enabled: $("#enabled"),
    licenseKey: $("#licenseKey"),
    activateLicense: $("#activateLicense"),
    deactivateLicense: $("#deactivateLicense"),
    licenseBadge: $("#licenseBadge"),
    licenseStatus: $("#licenseStatus"),
    backendUrl: $("#backendUrl"),
    apiToken: $("#apiToken"),
    tokenState: $("#tokenState"),
    connect: $("#connect"),
    connectionState: $("#connectionState"),
    projectName: $("#projectName"),
    repository: $("#repository"),
    branch: $("#branch"),
    supabaseState: $("#supabaseState"),
    downloadProject: $("#downloadProject"),
    refreshWorkspace: $("#refreshWorkspace"),
    model: $("#model"),
    modelState: $("#modelState"),
    prompt: $("#prompt"),
    submit: $("#submit"),
    feedback: $("#feedback"),
    taskState: $("#taskState"),
    taskDescription: $("#taskDescription"),
    taskLinks: $("#taskLinks"),
    timeline: $("#timeline"),
    cancelTask: $("#cancelTask"),
    refreshTasks: $("#refreshTasks"),
    historyList: $("#historyList"),
  };
  const labels = {
    queued: "Queued", inspecting: "Inspecting", planning: "Planning", editing: "Editing",
    testing: "Testing", repairing: "Repairing", delivering: "Delivering", completed: "Completed",
    failed: "Failed", cancelled: "Cancelled", cancelling: "Cancelling", attention: "Needs attention",
  };
  const terminal = new Set(["completed", "failed", "cancelled", "attention"]);
  let config = {};
  let workspace = { projectId: "", repository: "", branch: "main" };
  let models = [];
  let tasks = [];
  let licenseStatus = null;
  let selectedTaskId = "";
  let refreshing = false;

  function showFeedback(message, state = "") {
    ui.feedback.textContent = message;
    ui.feedback.dataset.state = state;
  }

  function setConnection(text, state = "") {
    ui.connectionState.textContent = text;
    ui.connectionState.dataset.state = state;
  }

  function setLicenseStatus(status) {
    licenseStatus = status || { valid: false, message: "Could not verify the license." };
    const valid = licenseStatus.valid === true && licenseStatus.code === "active";
    ui.licenseBadge.textContent = valid ? "Active" : "Inactive";
    ui.licenseBadge.dataset.state = valid ? "active" : "inactive";
    const expiry = valid && licenseStatus.expiresAt ? new Date(licenseStatus.expiresAt) : null;
    const expiryText = expiry && !Number.isNaN(expiry.valueOf()) ? ` Expires ${expiry.toLocaleDateString()}.` : "";
    ui.licenseStatus.textContent = `${licenseStatus.message || (valid ? "License active." : "A valid license is required to submit coding tasks.")}${expiryText}`;
    ui.activateLicense.disabled = valid;
    ui.deactivateLicense.hidden = !valid;
    updateSubmitGate();
  }

  async function refreshLicense() {
    try {
      const response = await chrome.runtime.sendMessage({ type: "LOVARPM_LICENSE_STATUS" });
      setLicenseStatus(response?.status);
    } catch (error) {
      setLicenseStatus({ valid: false, message: error instanceof Error ? error.message : "Could not verify the LovaRPM license." });
    }
  }

  async function activateLicense() {
    const key = ui.licenseKey.value.trim();
    if (key.length < 16 || key.length > 100) {
      setLicenseStatus({ valid: false, message: "Enter a valid LovaRPM license key." });
      return;
    }
    ui.activateLicense.disabled = true;
    ui.licenseStatus.textContent = "Activating license…";
    try {
      const response = await chrome.runtime.sendMessage({ type: "LOVARPM_LICENSE_ACTIVATE", key });
      if (response?.status?.valid) ui.licenseKey.value = "";
      setLicenseStatus(response?.status);
    } catch (error) {
      setLicenseStatus({ valid: false, message: error instanceof Error ? error.message : "Could not activate the LovaRPM license." });
    }
  }

  async function deactivateLicense() {
    if (!licenseStatus?.valid || !window.confirm("Deactivate this device? Coding tasks will be locked on this device.")) return;
    ui.deactivateLicense.disabled = true;
    try {
      const response = await chrome.runtime.sendMessage({ type: "LOVARPM_LICENSE_DEACTIVATE" });
      setLicenseStatus(response?.status);
    } catch (error) {
      setLicenseStatus({ valid: true, code: "active", message: error instanceof Error ? error.message : "Could not deactivate the license." });
    } finally {
      ui.deactivateLicense.disabled = false;
    }
  }

  function validateBackendUrl(value) {
    const parsed = new URL(value);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
    if (parsed.protocol !== "https:" && !(local && parsed.protocol === "http:")) {
      throw new Error("Use HTTPS for remote backends. HTTP is permitted only for localhost.");
    }
    return parsed;
  }

  async function apiRequest(path, options = {}) {
    const base = String(config.backendUrl || "").replace(/\/+$/, "");
    if (!base || !config.apiToken) throw new Error("Save the backend URL and API token first.");
    const response = await fetch(`${base}${path}`, {
      ...options,
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${config.apiToken}`,
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
      signal: AbortSignal.timeout(20_000),
    });
    const result = await response.json().catch(() => null);
    if (!response.ok) throw new Error(result?.error || `Backend request failed (HTTP ${response.status}).`);
    if (!result) throw new Error("Backend returned malformed JSON.");
    return result;
  }

  async function saveConfig(patch) {
    const response = await chrome.runtime.sendMessage({ type: "LOVABURST_SET_CONFIG", config: patch });
    if (!response?.ok) throw new Error(response?.error || "Could not save extension configuration.");
    config = response.config;
  }

  async function loadConfig() {
    const response = await chrome.runtime.sendMessage({ type: "LOVABURST_GET_CONFIG" });
    if (!response?.ok) throw new Error(response?.error || "Could not load extension configuration.");
    config = response.config || {};
    ui.backendUrl.value = config.backendUrl || "http://127.0.0.1:4173";
    ui.tokenState.textContent = config.apiToken ? "A backend token is stored in extension-only storage. Enter a new token to replace it." : "Stored only in Chrome extension storage.";
    ui.enabled.checked = config.enabled !== false;
    if (config.selectedModel) ui.model.value = config.selectedModel;
  }

  async function selectedLovableTab() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true, url: ["https://lovable.dev/*"] });
    return tabs.find((tab) => tab.id) || null;
  }

  async function loadWorkspace() {
    const tab = await selectedLovableTab();
    if (!tab?.id) {
      workspace = { projectId: "", repository: "", branch: "main" };
      ui.projectName.textContent = "No Lovable project tab";
      return;
    }
    const response = await chrome.runtime.sendMessage({
      type: "LOVABURST_GET_WORKSPACE",
      tabId: tab.id,
      workspace: { url: tab.url || "" },
    });
    if (!response?.ok) throw new Error(response?.error || "Could not inspect the Lovable project.");
    workspace = response.workspace;
    ui.projectName.textContent = workspace.projectId || tab.title || "Lovable project";
    ui.repository.value = workspace.repository || "";
    ui.branch.value = workspace.branch || "main";
    await loadSupabaseStatus();
  }

  async function loadSupabaseStatus() {
    if (!workspace.projectId) {
      ui.supabaseState.textContent = "Supabase: no Lovable project is active.";
      return;
    }
    const stored = await chrome.storage.local.get("projectIntegrations");
    const record = stored.projectIntegrations?.[workspace.projectId]?.supabase;
    if (record?.status === "connected") {
      ui.supabaseState.textContent = `Supabase connected${record.projectRef ? ` · ${record.projectRef}` : ""}.`;
    } else if (record?.status === "disconnected") {
      ui.supabaseState.textContent = "Supabase configuration signals were detected, but no active project connection was confirmed.";
    } else {
      ui.supabaseState.textContent = "Supabase is optional; no active connection is recorded.";
    }
  }

  function renderModelAvailability() {
    const available = new Set(models.filter((model) => model.available).map((model) => model.id));
    for (const option of ui.model.options) option.disabled = !available.has(option.value);
    if (!available.has(ui.model.value)) {
      const first = [...ui.model.options].find((option) => available.has(option.value));
      if (first) ui.model.value = first.value;
    }
    const selected = models.find((model) => model.id === ui.model.value);
    ui.modelState.textContent = selected?.available
      ? `${selected.name} is listed by Vyce AI. Fallback uses only catalogued models.`
      : "No supported model has been confirmed available. Configure Vyce AI and refresh model availability.";
    updateSubmitGate();
  }

  async function checkModels() {
    try {
      const result = await apiRequest("/api/models");
      models = Array.isArray(result.models) ? result.models : [];
      renderModelAvailability();
      if (models.some((model) => model.id === ui.model.value && model.available) && config.selectedModel !== ui.model.value) {
        await saveConfig({ selectedModel: ui.model.value });
      }
    } catch (error) {
      models = [];
      renderModelAvailability();
      ui.modelState.textContent = error.message;
    }
  }

  async function connectBackend() {
    ui.connect.disabled = true;
    try {
      const parsed = validateBackendUrl(ui.backendUrl.value.trim());
      const origin = `${parsed.origin}/*`;
      if (!["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)) {
        const granted = await chrome.permissions.request({ origins: [origin] });
        if (!granted) throw new Error("Backend host permission was not granted.");
      }
      const token = ui.apiToken.value.trim();
      await saveConfig({
        backendUrl: parsed.origin,
        ...(token ? { apiToken: token } : {}),
      });
      ui.apiToken.value = "";
      ui.tokenState.textContent = config.apiToken ? "Backend token stored in extension-only storage." : "No backend token is stored.";
      const response = await fetch(`${config.backendUrl}/health`, { cache: "no-store", signal: AbortSignal.timeout(8000) });
      const health = await response.json().catch(() => null);
      if (!response.ok || !health?.ok) throw new Error(`Backend health check failed (HTTP ${response.status}).`);
      if (!config.apiToken) throw new Error("Backend is reachable. Add its API token to enable authenticated tasks.");
      const tasks = await apiRequest("/api/tasks");
      await checkModels();
      setConnection(health.providerConfigured ? "Connected" : "Vyce key missing", health.providerConfigured ? "connected" : "error");
      showFeedback(`Connected · ${tasks.tasks.length} saved task${tasks.tasks.length === 1 ? "" : "s"}.`);
      await refreshTasks();
    } catch (error) {
      setConnection("Connection error", "error");
      showFeedback(error instanceof Error ? error.message : String(error), "error");
    } finally {
      ui.connect.disabled = false;
      updateSubmitGate();
    }
  }

  async function refreshRepositoryMetadata() {
    const repository = ui.repository.value.trim();
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) return;
    try {
      const result = await apiRequest(`/api/repositories/${repository.split("/").map(encodeURIComponent).join("/")}`);
      if (result.repository?.defaultBranch && (!ui.branch.value || ui.branch.value === "main")) {
        ui.branch.value = result.repository.defaultBranch;
      }
      ui.repository.title = `Repository${result.repository.private ? " (private)" : " (public)"}`;
    } catch (error) {
      showFeedback(error.message, "error");
    }
  }

  function activeTasks() {
    return tasks.filter((task) => !terminal.has(task.state));
  }

  function updateSubmitGate() {
    const repository = ui.repository.value.trim();
    const modelAvailable = models.some((item) => item.id === ui.model.value && item.available);
    const backendConfigured = Boolean(config.apiToken && config.backendUrl);
    ui.submit.disabled = !workspace.projectId && !repository
      || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)
      || !ui.prompt.value.trim()
      || !modelAvailable
      || !backendConfigured
      || licenseStatus?.valid !== true
      || config.enabled === false
      || activeTasks().length > 0;
  }

  function addLink(container, label, url) {
    if (!url) return;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" || !["github.com"].includes(parsed.hostname)) return;
      const anchor = document.createElement("a");
      anchor.href = parsed.href;
      anchor.target = "_blank";
      anchor.rel = "noreferrer";
      anchor.textContent = label;
      container.append(anchor);
    } catch {}
  }

  function renderTask(task) {
    selectedTaskId = task?.id || "";
    ui.timeline.replaceChildren();
    ui.taskLinks.replaceChildren();
    if (!task) {
      ui.taskState.textContent = "No active task";
      ui.taskDescription.textContent = "Tasks continue on the backend after this panel closes.";
      ui.cancelTask.hidden = true;
      updateSubmitGate();
      return;
    }
    ui.taskState.textContent = labels[task.state] || task.state;
    ui.taskDescription.textContent = `${task.repository} · ${task.branch} · selected ${task.selectedModel} · active ${task.activeModel}`;
    const summary = task.summary || task.error || "";
    if (summary) ui.taskDescription.textContent += `\n${summary}`;
    const estimate = Number(task.result?.usage?.estimatedCostUsd);
    if (Number.isFinite(estimate)) {
      ui.taskDescription.textContent += `\nEstimated model cost: $${estimate.toFixed(4)}. ${task.result.usage.pricingBasis || "Pricing is not live-verified."}`;
    }
    addLink(ui.taskLinks, `Branch ${task.result?.branch || ""} ↗`, task.result?.branch ? `https://github.com/${task.repository}/tree/${encodeURIComponent(task.result.branch)}` : "");
    addLink(ui.taskLinks, "Commit ↗", task.result?.commitUrl);
    addLink(ui.taskLinks, `Pull request #${task.result?.pullRequest?.number || ""} ↗`, task.result?.pullRequest?.url);
    for (const event of task.events || []) {
      const row = document.createElement("div");
      row.className = "timeline-item";
      row.dataset.kind = event.kind || "";
      const dot = document.createElement("i");
      const message = document.createElement("span");
      message.textContent = event.message || event.kind || "";
      const time = document.createElement("time");
      const date = event.createdAt ? new Date(event.createdAt) : null;
      time.textContent = date && !Number.isNaN(date.valueOf()) ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
      row.append(dot, message, time);
      ui.timeline.append(row);
    }
    ui.cancelTask.hidden = terminal.has(task.state);
    updateSubmitGate();
  }

  function renderHistory() {
    ui.historyList.replaceChildren();
    if (!tasks.length) {
      const empty = document.createElement("p");
      empty.className = "hint";
      empty.textContent = "No saved tasks yet.";
      ui.historyList.append(empty);
      return;
    }
    for (const task of tasks.slice(0, 25)) {
      const row = document.createElement("div");
      row.className = "task-row";
      const select = document.createElement("button");
      select.type = "button";
      select.textContent = `${task.prompt.slice(0, 72)}${task.prompt.length > 72 ? "…" : ""}`;
      select.addEventListener("click", () => renderTask(task));
      const state = document.createElement("span");
      state.textContent = labels[task.state] || task.state;
      row.append(select, state);
      ui.historyList.append(row);
    }
  }

  async function refreshTasks() {
    if (refreshing || !config.apiToken) return;
    refreshing = true;
    try {
      const result = await apiRequest("/api/tasks");
      tasks = Array.isArray(result.tasks) ? result.tasks : [];
      renderHistory();
      const selected = tasks.find((task) => task.id === selectedTaskId)
        || tasks.find((task) => !terminal.has(task.state))
        || tasks[0]
        || null;
      renderTask(selected);
    } catch (error) {
      if (error.message) setConnection("Backend unavailable", "error");
    } finally {
      refreshing = false;
    }
  }

  async function submitTask() {
    const prompt = ui.prompt.value.trim();
    const repository = ui.repository.value.trim();
    const branch = ui.branch.value.trim() || "main";
    if (!prompt || !repository) return;
    ui.submit.disabled = true;
    showFeedback("Creating persistent task…");
    try {
      const requestId = crypto.randomUUID();
      const response = await chrome.runtime.sendMessage({
        type: "LOVABURST_CREATE_TASK",
        payload: {
          prompt,
          repository,
          branch,
          model: ui.model.value,
          projectId: workspace.projectId,
          requestId,
        },
      });
      if (!response?.ok) throw new Error(response?.error || "Task was not accepted.");
      ui.prompt.value = "";
      selectedTaskId = response.task.id;
      showFeedback(`Task ${response.task.id} queued on the backend.`);
      await refreshTasks();
    } catch (error) {
      showFeedback(error instanceof Error ? error.message : String(error), "error");
    } finally {
      updateSubmitGate();
    }
  }

  async function cancelTask() {
    if (!selectedTaskId) return;
    ui.cancelTask.disabled = true;
    try {
      const result = await chrome.runtime.sendMessage({ type: "LOVABURST_CANCEL_TASK", taskId: selectedTaskId });
      if (!result?.ok) throw new Error(result?.error || "Cancellation failed.");
      showFeedback("Cancellation requested. The backend will stop active execution.");
      await refreshTasks();
    } catch (error) {
      showFeedback(error.message, "error");
    } finally {
      ui.cancelTask.disabled = false;
    }
  }

  async function downloadProject() {
    const repository = ui.repository.value.trim();
    const branch = ui.branch.value.trim() || "main";
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
      showFeedback("Enter a GitHub repository before downloading.", "error");
      return;
    }
    const [owner, name] = repository.split("/");
    const filename = `${name}-${branch.replace(/[^A-Za-z0-9_.-]+/g, "-")}.zip`;
    try {
      await chrome.downloads.download({
        url: `https://github.com/${owner}/${name}/archive/refs/heads/${encodeURIComponent(branch)}.zip`,
        filename,
        saveAs: true,
        conflictAction: "uniquify",
      });
      showFeedback("Branch archive download started.");
    } catch (error) {
      showFeedback(`Download could not start: ${error.message}`, "error");
    }
  }

  ui.connect.addEventListener("click", () => void connectBackend());
  ui.activateLicense.addEventListener("click", () => void activateLicense());
  ui.licenseKey.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void activateLicense();
    }
  });
  ui.deactivateLicense.addEventListener("click", () => void deactivateLicense());
  ui.refreshWorkspace.addEventListener("click", () => void loadWorkspace().catch((error) => showFeedback(error.message, "error")));
  ui.repository.addEventListener("change", () => void refreshRepositoryMetadata());
  ui.submit.addEventListener("click", () => void submitTask());
  ui.prompt.addEventListener("input", updateSubmitGate);
  ui.repository.addEventListener("input", updateSubmitGate);
  ui.model.addEventListener("change", async () => {
    config.selectedModel = ui.model.value;
    await saveConfig({ selectedModel: ui.model.value });
    renderModelAvailability();
  });
  ui.enabled.addEventListener("change", async () => {
    await saveConfig({ enabled: ui.enabled.checked });
    updateSubmitGate();
  });
  ui.refreshTasks.addEventListener("click", () => void refreshTasks());
  ui.cancelTask.addEventListener("click", () => void cancelTask());
  ui.downloadProject.addEventListener("click", () => void downloadProject());
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.projectIntegrations) void loadSupabaseStatus();
  });

  void (async () => {
    try {
      await refreshLicense();
      await loadConfig();
      await loadWorkspace();
      if (config.apiToken) {
        const healthResponse = await fetch(`${config.backendUrl}/health`, { cache: "no-store", signal: AbortSignal.timeout(6000) });
        const health = await healthResponse.json().catch(() => null);
        if (healthResponse.ok && health?.ok) {
          setConnection(health.providerConfigured ? "Connected" : "Vyce key missing", health.providerConfigured ? "connected" : "error");
          await Promise.all([checkModels(), refreshTasks()]);
          if (!health.providerConfigured) showFeedback("Backend is reachable, but its VYCE_API_KEY is not configured.", "error");
        } else {
          setConnection("Backend unavailable", "error");
        }
      }
      updateSubmitGate();
    } catch (error) {
      showFeedback(error instanceof Error ? error.message : String(error), "error");
    }
  })();
  setInterval(() => void refreshTasks(), 5000);
})();
