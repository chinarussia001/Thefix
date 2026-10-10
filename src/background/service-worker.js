import { getConfig, setConfig } from "../shared/storage.js";

const TASK_STATUS_KEY = "projectRunStatuses";
const WORKSPACE_BINDINGS_KEY = "workspaceBindings";
const TASK_POLL_ALARM = "lovarpm-task-poll";
const REPOSITORY_PATTERN = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/;

async function configurePanel() {
  if (!chrome.sidePanel?.setPanelBehavior) return;
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
}

async function cleanLegacyState() {
  const stored = await chrome.storage.local.get(["config", "projectChatBindings", WORKSPACE_BINDINGS_KEY, "lovarpmChatRemovalV1"]);
  const bindings = { ...(stored[WORKSPACE_BINDINGS_KEY] || {}) };
  for (const [projectId, record] of Object.entries(stored.projectChatBindings || {})) {
    if (record?.repository && REPOSITORY_PATTERN.test(record.repository)) {
      bindings[projectId] = {
        ...bindings[projectId],
        repository: record.repository,
        branch: String(record.branch || bindings[projectId]?.branch || "main"),
        source: "legacy-project-binding",
      };
    }
  }
  const config = { ...(stored.config || {}) };
  delete config.chatgptEnabled;
  delete config.chatgptCheckIntervalSeconds;
  delete config.chatgptAutoCheckPaused;
  await chrome.storage.local.set({ config, [WORKSPACE_BINDINGS_KEY]: bindings });
  if (!stored.lovarpmChatRemovalV1) {
    await chrome.storage.local.remove([
      "chatgptLink",
      "projectChatBindings",
      "pendingPrompt",
      "aiLink",
      "projectMigrationKeys",
      "projectRunStatuses",
    ]);
    await chrome.storage.local.set({ lovarpmChatRemovalV1: true });
  }
}

function parseRepository(value) {
  const match = String(value || "").trim().match(REPOSITORY_PATTERN);
  return match ? `${match[1]}/${match[2]}` : "";
}

function inspectLovablePage() {
  const projectId = location.pathname.match(/\/(?:projects|apps)\/([A-Za-z0-9-]+)/i)?.[1] || "";
  const blocked = new Set(["settings", "marketplace", "features", "topics", "collections", "login", "signup", "projects", "project", "lovable", "api", "assets", "src", "public", "en", "docs"]);
  const repositories = new Map();
  const add = (value, score) => {
    const text = String(value || "").trim();
    const match = text.match(/(?:https?:\/\/(?:www\.)?github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:[/?#]|$)/i)
      || text.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/);
    if (!match || match[1].length < 2 || match[2].length < 2 ||
        blocked.has(match[1].toLowerCase()) || blocked.has(match[2].toLowerCase())) return;
    const repository = `${match[1]}/${match[2]}`;
    repositories.set(repository, Math.max(repositories.get(repository) || 0, score));
  };
  const root = document.documentElement;
  if (root?.dataset?.lovaburstRepositoryProject === projectId) add(root.dataset.lovaburstRepository, 200);
  if (root?.dataset?.lovaburstGitsyncProject === projectId) add(root.dataset.lovaburstGitsyncRepository, 190);
  for (const anchor of document.querySelectorAll('a[href*="github.com"]')) add(anchor.href, 120);
  const inspect = (value, score, depth = 0) => {
    if (depth > 4 || value == null) return;
    if (typeof value === "string") {
      if (value.length < 200_000) {
        for (const match of value.match(/(?:https?:\/\/(?:www\.)?github\.com\/|git@github\.com:)[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?/gi) || []) add(match, score);
        add(value, score - 20);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 500)) inspect(item, score - 1, depth + 1);
      return;
    }
    if (typeof value === "object") {
      for (const [key, item] of Object.entries(value).slice(0, 500)) inspect(item, /repo|github|gitSync|owner/i.test(key) ? score + 15 : score - 2, depth + 1);
    }
  };
  for (const key of ["__NEXT_DATA__", "__INITIAL_STATE__", "__PRELOADED_STATE__", "__APOLLO_STATE__", "__REACT_QUERY_STATE__", "__lovable", "lovable"]) {
    try { inspect(window[key], 100); } catch {}
  }
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index) || "";
      if (/github|repo|project|workspace/i.test(key)) inspect(localStorage.getItem(key), 80);
    }
  } catch {}
  return {
    projectId,
    repository: [...repositories.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] || "",
  };
}

async function getWorkspace(tabId, supplied = {}) {
  const tab = Number.isInteger(tabId) ? await chrome.tabs.get(tabId).catch(() => null) : null;
  const pageProjectId = String(supplied.projectId || tab?.url?.match(/\/(?:projects|apps)\/([A-Za-z0-9-]+)/i)?.[1] || "").trim();
  if (!pageProjectId) return { projectId: "", repository: parseRepository(supplied.repository), branch: String(supplied.branch || "main"), url: tab?.url || "" };

  const stored = await chrome.storage.local.get(WORKSPACE_BINDINGS_KEY);
  const cached = stored[WORKSPACE_BINDINGS_KEY]?.[pageProjectId] || {};
  let detected = { projectId: pageProjectId, repository: "" };
  if (tab?.id && tab.url?.startsWith("https://lovable.dev/")) {
    const result = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      func: inspectLovablePage,
    }).catch(() => []);
    detected = result?.[0]?.result || detected;
  }
  const repository = parseRepository(supplied.repository || detected.repository || cached.repository);
  const binding = {
    ...cached,
    ...(repository ? { repository } : {}),
    branch: String(supplied.branch || cached.branch || "main"),
    source: supplied.repository ? "lovable-composer" : detected.repository ? "lovable-page-probe" : cached.source || "none",
    detectedAt: new Date().toISOString(),
  };
  await chrome.storage.local.set({
    [WORKSPACE_BINDINGS_KEY]: { ...(stored[WORKSPACE_BINDINGS_KEY] || {}), [pageProjectId]: binding },
  });
  return { projectId: pageProjectId, repository, branch: binding.branch, url: tab?.url || supplied.url || "" };
}

async function backendRequest(path, options = {}) {
  const config = await getConfig();
  const baseUrl = String(config.backendUrl || "").replace(/\/+$/, "");
  if (!baseUrl) throw new Error("Configure the LovaRPM backend URL in the extension.");
  if (!config.apiToken) throw new Error("Configure the backend API token in the extension.");
  let response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      ...options,
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${config.apiToken}`,
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
      signal: options.signal || AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new Error(`Could not reach the LovaRPM backend: ${error instanceof Error ? error.message : String(error)}`);
  }
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error(`The LovaRPM backend returned an invalid response (HTTP ${response.status}).`);
  }
  if (!response.ok) throw new Error(result?.error || `LovaRPM backend request failed (HTTP ${response.status}).`);
  return result;
}

function statusRecord(task, projectId) {
  const lastActivity = task.events?.at(-1);
  return {
    taskId: task.id,
    projectId,
    repository: task.repository,
    branch: task.branch,
    status: task.state,
    objective: task.prompt.slice(0, 700),
    activityText: lastActivity?.message || task.state,
    selectedModel: task.selectedModel,
    activeModel: task.activeModel,
    summary: task.summary,
    error: task.error,
    result: task.result,
    events: task.events || [],
    updatedAt: task.updatedAt,
    completedAt: task.completedAt,
  };
}

async function setTaskStatus(task, projectId) {
  if (!projectId) return;
  const stored = await chrome.storage.local.get(TASK_STATUS_KEY);
  await chrome.storage.local.set({
    [TASK_STATUS_KEY]: {
      ...(stored[TASK_STATUS_KEY] || {}),
      [projectId]: statusRecord(task, projectId),
    },
  });
}

async function submitTask(payload, sender) {
  const config = await getConfig();
  if (config.enabled === false) throw new Error("LovaRPM is disabled.");
  const authorize = globalThis.LovaRPMLicense?.authorizeOperation;
  if (typeof authorize !== "function") throw new Error("The LovaRPM license service is unavailable; coding tasks remain locked.");
  const authorization = await authorize();
  if (!authorization?.ok) {
    throw new Error(authorization?.status?.message || "A valid LovaRPM license is required to submit coding tasks.");
  }
  const workspace = await getWorkspace(sender?.tab?.id, {
    projectId: payload.projectId || payload.lovableProjectId,
    repository: payload.repository,
    branch: payload.branch,
    url: payload.url,
  });
  const repository = parseRepository(workspace.repository);
  if (!repository) throw new Error("Connect or select a GitHub repository for this Lovable project.");
  const requestId = String(payload.requestId || crypto.randomUUID());
  const result = await backendRequest("/api/tasks", {
    method: "POST",
    headers: { "Idempotency-Key": requestId },
    body: JSON.stringify({
      prompt: String(payload.prompt || payload.objective || payload.text || "").trim(),
      repository,
      branch: workspace.branch || "main",
      model: String(payload.model || config.selectedModel || "claude-sonnet-4-6"),
      projectId: workspace.projectId,
      requestId,
    }),
  });
  await setTaskStatus(result.task, workspace.projectId);
  return { task: result.task, created: result.created, workspace };
}

async function syncTasks() {
  try {
    const result = await backendRequest("/api/tasks");
    const statusMap = { ...((await chrome.storage.local.get(TASK_STATUS_KEY))[TASK_STATUS_KEY] || {}) };
    for (const task of result.tasks || []) {
      if (!task.projectId) continue;
      statusMap[task.projectId] = statusRecord(task, task.projectId);
    }
    await chrome.storage.local.set({ [TASK_STATUS_KEY]: statusMap });
  } catch {
    // Polling is best-effort; task state remains authoritative on the backend.
  }
}

chrome.runtime.onInstalled.addListener(() => {
  void cleanLegacyState();
  void configurePanel().catch((error) => console.warn("[LovaRPM] Side panel setup failed:", error));
  chrome.alarms.create(TASK_POLL_ALARM, { periodInMinutes: 0.5 });
});
chrome.runtime.onStartup.addListener(() => {
  void configurePanel().catch((error) => console.warn("[LovaRPM] Side panel setup failed:", error));
  void syncTasks();
  chrome.alarms.create(TASK_POLL_ALARM, { periodInMinutes: 0.5 });
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === TASK_POLL_ALARM) void syncTasks();
});
void cleanLegacyState();
void configurePanel().catch((error) => console.warn("[LovaRPM] Side panel setup failed:", error));

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== "object") return false;
  if (message.type === "LOVABURST_GET_CONFIG") {
    getConfig().then((config) => sendResponse({ ok: true, config })).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === "LOVABURST_SET_CONFIG") {
    setConfig(message.config || {}).then((config) => sendResponse({ ok: true, config })).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === "LOVABURST_GET_WORKSPACE") {
    getWorkspace(Number.isInteger(message.tabId) ? message.tabId : sender?.tab?.id, message.workspace || {})
      .then((workspace) => sendResponse({ ok: true, workspace }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === "LOVABURST_CREATE_TASK" || message.type === "LOVABURST_COMPOSER_SUBMIT") {
    submitTask(message.payload || message, sender)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  }
  if (message.type === "LOVABURST_GET_TASKS") {
    backendRequest("/api/tasks")
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === "LOVABURST_SYNC_TASKS") {
    syncTasks().then(() => sendResponse({ ok: true })).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === "LOVABURST_GET_MODELS") {
    backendRequest("/api/models")
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === "LOVABURST_CANCEL_TASK") {
    backendRequest(`/api/tasks/${encodeURIComponent(message.taskId)}/cancel`, { method: "POST", body: "{}" })
      .then(async ({ task }) => {
        await setTaskStatus(task, task.projectId);
        sendResponse({ ok: true, task });
      })
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === "LOVABURST_PING") {
    sendResponse({ ok: true, source: "background" });
  }
  return false;
});
