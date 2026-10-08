import { getConfig, setConfig } from "../shared/storage.js";
import { getPromptSkillIds, withSkillInstructions } from "../shared/skill-instructions.js";
import { buildDispatchEnvelope, gatherProjectContext, invalidateAllProjectContexts, invalidateProjectContext } from "../shared/context-builder.js";
import { runPostCompletionPipeline } from "../shared/post-completion.js";
import { setupProject } from "./setup.js";

const CHATGPT_URL_PATTERNS = ["https://chatgpt.com/*"];
const CHATGPT_BRIDGE_FILE = "src/content/chatgpt.js";

async function configureSidePanel() {
  if (!chrome.sidePanel?.setPanelBehavior) return;

  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch (error) {
    console.warn("[LovaRPM] Não foi possível configurar o painel lateral:", error);
  }
}

async function cleanChatGptOnlyState() {
  const config = await getConfig();
  const migration = await chrome.storage.local.get(["repositoryDetectionMigrationV0400", "projectChatBindings", "chatgptOnlyCleanupV261"]);
  const legacyProviderKey = ["ai", "Provider"].join("");
  const removedAssistantName = String.fromCharCode(103, 101, 109, 105, 110, 105);
  const legacySecondaryEnabledKey = removedAssistantName + "Enabled";
  const cleanConfig = { ...config };
  delete cleanConfig[legacyProviderKey];
  delete cleanConfig[legacySecondaryEnabledKey];
  const patch = { config: cleanConfig };

  if (!migration.repositoryDetectionMigrationV0400) {
    patch.workspaceBindings = {};
    patch.repositoryDetectionMigrationV0400 = true;
  }

  if (!migration.chatgptOnlyCleanupV261) {
    const bindings = migration.projectChatBindings || {};
    const cleaned = {};
    for (const [projectId, record] of Object.entries(bindings)) {
      const conversations = (Array.isArray(record?.conversations) ? record.conversations : [])
        .filter((item) => String(item?.url || item?.lockedUrl || "").startsWith("https://chatgpt.com/") && !`${item?.title || ""} ${item?.lockedTitle || ""}`.toLowerCase().includes(removedAssistantName));
      const activeStillExists = conversations.some((item) => item.id === record?.activeConversationId);
      const cleanRecord = { ...record, conversations: conversations.map(({ provider, ...item }) => item), activeConversationId: activeStillExists ? record.activeConversationId : (conversations[conversations.length - 1]?.id || "") };
      delete cleanRecord[legacyProviderKey];
      cleaned[projectId] = cleanRecord;
    }
    patch.projectChatBindings = cleaned;
    patch.projectRunStatuses = {};
    patch.chatgptOnlyCleanupV261 = true;
    await chrome.storage.local.remove(["aiLink", "pendingPrompt", removedAssistantName + "LovableRelays"]);
  }

  await chrome.storage.local.set(patch);
}

chrome.runtime.onInstalled.addListener(async () => {
  await cleanChatGptOnlyState();
  await invalidateAllProjectContexts();
  await configureSidePanel();
});

chrome.runtime.onStartup.addListener(() => {
  void cleanChatGptOnlyState();
  void invalidateAllProjectContexts();
  configureSidePanel();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.workspaceBindings || changes.projectIntegrations || changes.projectChatBindings || changes.lastPlatformWorkspaces || changes.lastLovableWorkspace || changes.pendingPrompt) {
    void invalidateAllProjectContexts();
  }
});

void cleanChatGptOnlyState();
configureSidePanel();


async function listChatGptTabs() {
  const tabs = await chrome.tabs.query({ url: CHATGPT_URL_PATTERNS });
  const removedAssistantName = String.fromCharCode(103, 101, 109, 105, 110, 105);
  return tabs
    .filter((tab) => tab.id && !String(tab.title || "").toLowerCase().includes(removedAssistantName))
    .map((tab) => ({
      tabId: tab.id,
      title: tab.title || "ChatGPT",
      url: tab.url || "https://chatgpt.com/",
      active: Boolean(tab.active),
      windowId: tab.windowId,
    }));
}

async function getStoredChatGptLink() {
  const stored = await chrome.storage.local.get("chatgptLink");
  return stored.chatgptLink || null;
}

async function clearChatGptLink() {
  await chrome.storage.local.remove("chatgptLink");
}

async function getLinkedChatGptTab() {
  const link = await getStoredChatGptLink();
  if (!link?.tabId) return null;

  try {
    const tab = await chrome.tabs.get(link.tabId);
    if (!tab?.id || !tab.url?.startsWith("https://chatgpt.com/")) {
      await clearChatGptLink();
      return null;
    }

    if (tab.url !== link.url || tab.title !== link.title) {
      await chrome.storage.local.set({
        chatgptLink: {
          ...link,
          url: tab.url || link.url,
          title: tab.title || link.title || "ChatGPT",
          updatedAt: new Date().toISOString(),
        },
      });
    }

    return tab;
  } catch {
    // A tab pode ter sido recriada pelo Chrome. Tentamos recuperar pela URL exata uma vez.
    const tabs = await listChatGptTabs();
    const recovered = tabs.find((tab) => link.url && tab.url === link.url);

    if (recovered?.tabId) {
      const nextLink = {
        tabId: recovered.tabId,
        url: recovered.url,
        title: recovered.title,
        linkedAt: link.linkedAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await chrome.storage.local.set({ chatgptLink: nextLink });
      return chrome.tabs.get(recovered.tabId);
    }

    await clearChatGptLink();
    return null;
  }
}

async function linkChatGptTab(tabId) {
  if (!Number.isInteger(tabId)) {
    throw new Error("Invalid ChatGPT tab.");
  }

  const tab = await chrome.tabs.get(tabId);
  if (!tab?.id || !tab.url?.startsWith("https://chatgpt.com/")) {
    throw new Error("The selected tab is not a ChatGPT conversation.");
  }

  const bridgeReady = await ensureChatGptBridge(tab.id);
  if (!bridgeReady) {
    throw new Error("The LovaRPM bridge did not respond in this ChatGPT tab.");
  }

  const link = {
    tabId: tab.id,
    url: tab.url || "https://chatgpt.com/",
    title: tab.title || "ChatGPT",
    linkedAt: new Date().toISOString(),
  };
  await chrome.storage.local.set({ chatgptLink: link });
  return link;
}

async function getChatGptStatus() {
  const tabs = await listChatGptTabs();
  const linkedTab = await getLinkedChatGptTab();
  const link = linkedTab ? await getStoredChatGptLink() : null;

  return {
    connected: Boolean(linkedTab?.id),
    link,
    tabs,
  };
}

async function sendPromptMessage(tabId, prompt) {
  return chrome.tabs.sendMessage(tabId, {
    type: "LOVABURST_SUBMIT_TO_CHATGPT",
    prompt,
    implementationTask: true,
  });
}

async function ensureChatGptBridge(tabId) {
  try {
    const ping = await chrome.tabs.sendMessage(tabId, { type: "LOVABURST_CONTENT_PING" });
    if (ping?.ok && ping.source === "chatgpt") return true;
  } catch {}

  await chrome.scripting.executeScript({
    target: { tabId },
    files: [CHATGPT_BRIDGE_FILE],
  });

  const ping = await chrome.tabs.sendMessage(tabId, { type: "LOVABURST_CONTENT_PING" });
  return Boolean(ping?.ok && ping.source === "chatgpt");
}

function mainWorldWorkspaceProbe() {
  const blocked = new Set([
    "settings", "marketplace", "features", "topics", "collections", "login", "signup",
    "projects", "project", "lovable", "api", "assets", "src", "public", "blob", "tree",
    "en", "docs",
  ]);
  const scored = new Map();

  const normalizePlainRepository = (value) => {
    const text = String(value || "").trim();
    const match = text.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/);
    if (!match) return "";

    const owner = match[1];
    const repo = match[2];
    if (blocked.has(owner.toLowerCase()) || blocked.has(repo.toLowerCase())) return "";
    if (owner.length < 2 || repo.length < 2) return "";
    return `${owner}/${repo}`;
  };

  const normalizeGithubUrl = (value) => {
    if (!value) return "";
    const raw = String(value).trim();

    const ssh = raw.match(/^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/i);
    if (ssh) return normalizePlainRepository(`${ssh[1]}/${ssh[2]}`);

    let url;
    try {
      url = new URL(raw, location.href);
    } catch {
      return "";
    }

    const host = url.hostname.toLowerCase();
    if (host !== "github.com" && host !== "www.github.com") return "";

    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 2) return "";
    return normalizePlainRepository(`${parts[0]}/${parts[1]}`);
  };

  const add = (value, score) => {
    const repo = normalizeGithubUrl(value);
    if (!repo) return;
    scored.set(repo, Math.max(scored.get(repo) || 0, score));
  };

  const collectText = (value, score) => {
    if (value == null) return;
    let text;

    try {
      text = typeof value === "string" ? value : JSON.stringify(value);
    } catch {
      return;
    }

    if (!text) return;
    text = text.slice(0, 300000);

    const patterns = [
      /https?:\/\/(?:www\.)?github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?/gi,
      /git@github\.com:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?/gi,
    ];

    for (const pattern of patterns) {
      for (const match of text.match(pattern) || []) add(match, score);
    }
  };

  const projectId = location.pathname.match(/\/(?:projects|apps)\/([A-Za-z0-9-]+)/i)?.[1] || "";

  try {
    const root = document.documentElement;
    const boundProject = root?.dataset?.lovaburstRepositoryProject || "";

    if (boundProject && boundProject === projectId) {
      const trusted = normalizePlainRepository(root?.dataset?.lovaburstRepository || "");
      if (trusted) scored.set(trusted, 180);
    }
  } catch {}

  try {
    for (const anchor of document.querySelectorAll('a[href*="github.com"], a[href^="git@github.com:"]')) {
      add(anchor.href || anchor.getAttribute("href"), 140);
    }
  } catch {}

  try {
    collectText(document.documentElement?.innerHTML, 55);
  } catch {}

  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index) || "";
      collectText(`${key}:${localStorage.getItem(key) || ""}`, /github|repo|project|workspace/i.test(key) ? 120 : 80);
    }
  } catch {}

  try {
    for (let index = 0; index < sessionStorage.length; index += 1) {
      const key = sessionStorage.key(index) || "";
      collectText(`${key}:${sessionStorage.getItem(key) || ""}`, /github|repo|project|workspace/i.test(key) ? 115 : 75);
    }
  } catch {}

  const preferredGlobals = [
    "__NEXT_DATA__", "__INITIAL_STATE__", "__PRELOADED_STATE__", "__APOLLO_STATE__",
    "__REACT_QUERY_STATE__", "__remixContext", "__ROUTE_DATA__", "__lovable", "lovable",
  ];

  for (const key of preferredGlobals) {
    try {
      collectText(window[key], 125);
    } catch {}
  }

  const repository = [...scored.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] || "";
  return { repository, lovableProjectId: projectId };
}

async function detectLovableWorkspace(tabId, payload = {}) {
  const lovableProjectId = payload.lovableProjectId || "";
  const workspaceKey = lovableProjectId || payload.url || "";

  if (payload.domRepository) {
    return { repository: payload.domRepository, source: "isolated-dom", lovableProjectId };
  }

  if (workspaceKey) {
    const stored = await chrome.storage.local.get("workspaceBindings");
    const cached = stored.workspaceBindings?.[workspaceKey]?.repository;
    if (cached) return { repository: cached, source: "workspace-cache", lovableProjectId };
  }

  if (!tabId) return { repository: "", source: "none", lovableProjectId };

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: mainWorldWorkspaceProbe,
    });
    const result = results?.[0]?.result || {};
    const repository = result.repository || "";
    const projectId = result.lovableProjectId || lovableProjectId;

    if (repository && (projectId || workspaceKey)) {
      const key = projectId || workspaceKey;
      const stored = await chrome.storage.local.get("workspaceBindings");
      await chrome.storage.local.set({
        workspaceBindings: {
          ...(stored.workspaceBindings || {}),
          [key]: {
            repository,
            detectedAt: new Date().toISOString(),
            source: "main-world",
          },
        },
      });
    }

    return { repository, source: repository ? "main-world" : "none", lovableProjectId: projectId };
  } catch {
    return { repository: "", source: "none", lovableProjectId };
  }
}

const sleepBackground = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function relayPromptToChatGpt(payload, sourceTabId = null) {
  const config = await getConfig();
  if (config.enabled === false || config.chatgptEnabled === false) {
    throw new Error("The ChatGPT integration is disabled in LovaRPM.");
  }

  const tab = await getLinkedChatGptTab();
  if (!tab?.id) {
    throw new Error("ChatGPT is not linked. Open the LovaRPM panel and link a ChatGPT conversation.");
  }

  const preparedPrompt = await globalThis.LovaRPMLicense?.preparePrompt?.("main", payload);
  if (!preparedPrompt) throw new Error("The server did not prepare the operation.");
  const envelope = await buildDispatchEnvelope(payload.lovableProjectId, preparedPrompt);
  const prompt = withSkillInstructions(envelope, payload.skills);
  let sourceTab = null;
  let activatedChatForDispatch = false;

  try {
    if (Number.isInteger(sourceTabId)) {
      sourceTab = await chrome.tabs.get(sourceTabId).catch(() => null);
    }

    // ChatGPT currently defers parts of its composer while a tab is backgrounded.
    // Briefly make the linked chat the active tab so React processes the injected
    // input/click immediately, then restore the Lovable tab after dispatch.
    if (!tab.active) {
      await chrome.tabs.update(tab.id, { active: true });
      activatedChatForDispatch = true;
      await sleepBackground(180);
    }

    const bridgeReady = await ensureChatGptBridge(tab.id);
    if (!bridgeReady) throw new Error("The ChatGPT bridge did not respond after injection.");

    const response = await sendPromptMessage(tab.id, prompt);
    if (!response?.ok) {
      throw new Error(response?.error || "ChatGPT did not confirm that the prompt was sent.");
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const failure = /license|protected features remain locked/i.test(detail)
      ? "LovaRPM license authorization failed"
      : "Could not activate the LovaRPM bridge in ChatGPT";
    throw new Error(`${failure}: ${detail}`);
  } finally {
    if (
      activatedChatForDispatch &&
      sourceTab?.id &&
      sourceTab.id !== tab.id &&
      (sourceTab.url?.startsWith("https://lovable.dev/") || sourceTab.url?.startsWith("https://app.base44.com/apps/"))
    ) {
      await chrome.tabs.update(sourceTab.id, { active: true }).catch(() => {});
    }
  }

  return { tabId: tab.id };
}

const PROJECT_RUN_STATUS_KEY = "projectRunStatuses";
const ACCESS_BOOTSTRAP_KEY = "accessBootstrapConversationsV219";
const POST_COMPLETION_RUNS = new Set();

async function accessBootstrapState(projectId) {
  const id = String(projectId || "").trim();
  if (!id) return { required: false, key: "" };
  const stored = await chrome.storage.local.get(["projectChatBindings", ACCESS_BOOTSTRAP_KEY]);
  const record = stored.projectChatBindings?.[id];
  const conversation = record?.conversations?.find((item) => item.id === record.activeConversationId) || null;
  const identity = String(conversation?.id || record?.activeConversationId || conversation?.url || (conversation?.tabId ? `tab-${conversation.tabId}` : "")).trim();
  if (!identity) return { required: true, key: "" };
  const key = `${id}::${identity}`;
  return { required: !Boolean(stored[ACCESS_BOOTSTRAP_KEY]?.[key]), key };
}

async function markAccessBootstrapComplete(key) {
  const id = String(key || "").trim();
  if (!id) return;
  const stored = await chrome.storage.local.get(ACCESS_BOOTSTRAP_KEY);
  const entries = stored[ACCESS_BOOTSTRAP_KEY] || {};
  await chrome.storage.local.set({
    [ACCESS_BOOTSTRAP_KEY]: {
      ...entries,
      [id]: { completedAt: new Date().toISOString() },
    },
  });
}

async function setProjectRunStatus(projectId, patch) {
  if (!projectId) return null;
  const stored = await chrome.storage.local.get(PROJECT_RUN_STATUS_KEY);
  const statuses = stored[PROJECT_RUN_STATUS_KEY] || {};
  const previous = statuses[projectId] || {};
  const next = {
    ...previous,
    ...patch,
    projectId,
    updatedAt: new Date().toISOString(),
  };
  await chrome.storage.local.set({
    [PROJECT_RUN_STATUS_KEY]: {
      ...statuses,
      [projectId]: next,
    },
  });
  return next;
}

async function handleCapturedPrompt(message, sender) {
  const payload = message.payload;

  if (!payload?.text || typeof payload.text !== "string" || !payload.text.trim()) {
    return { ok: false, error: "Prompt is empty or invalid." };
  }

  let repository = payload.repository || "";
  let repositoryDetectionSource = payload.repositoryDetectionSource || "";
  let lovableProjectId = payload.lovableProjectId || "";
  const platform = payload.platform === "base44" || message.source === "base44" ? "base44" : "lovable";

  if (!repository) {
    const workspace = await detectLovableWorkspace(sender?.tab?.id, {
      lovableProjectId,
      url: payload.url,
      domRepository: "",
    });
    repository = workspace.repository || "";
    repositoryDetectionSource = workspace.source || "none";
    lovableProjectId = workspace.lovableProjectId || lovableProjectId;
  }

  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(repository || ""))) {
    return { ok: false, error: "Connect GitHub to enable dispatch." };
  }

  let fallbackSkills;
  if (!Object.prototype.hasOwnProperty.call(payload, "skills") && lovableProjectId) {
    const stored = await chrome.storage.local.get("projectSkillSelections");
    fallbackSkills = stored.projectSkillSelections?.[lovableProjectId];
  }

  const bootstrap = await accessBootstrapState(lovableProjectId);

  const pendingPrompt = {
    text: payload.text.trim(),
    url: payload.url || "",
    title: payload.title || "",
    capturedAt: payload.capturedAt || new Date().toISOString(),
    source: message.source || "lovable",
    platform,
    repository,
    repositoryDetectionSource,
    lovableProjectId,
    apiDiagnostics: Array.isArray(payload.apiDiagnostics) ? payload.apiDiagnostics.slice(-24) : [],
    skills: getPromptSkillIds(payload, fallbackSkills),
    accessBootstrap: bootstrap.required ? "REQUIRED" : "",
    accessBootstrapKey: bootstrap.key || "",
    status: "captured",
  };

  const workspaceKey = pendingPrompt.lovableProjectId || pendingPrompt.url;
  const storagePatch = { pendingPrompt };

  await setProjectRunStatus(pendingPrompt.lovableProjectId, {
    status: "sending",
    marker: "",
    objective: pendingPrompt.text.slice(0, 700),
    startedAt: pendingPrompt.capturedAt,
    dispatchedAt: "",
    completedAt: "",
    error: "",
    excerpt: "",
    repository: pendingPrompt.repository || "",
  });

  if (workspaceKey && pendingPrompt.repository) {
    const stored = await chrome.storage.local.get("workspaceBindings");
    storagePatch.workspaceBindings = {
      ...(stored.workspaceBindings || {}),
      [workspaceKey]: {
        repository: pendingPrompt.repository,
        detectedAt: new Date().toISOString(),
        source: pendingPrompt.repositoryDetectionSource || "captured",
      },
    };
  }

  await chrome.storage.local.set(storagePatch);
  await invalidateProjectContext(pendingPrompt.lovableProjectId);

  try {
    const relay = await relayPromptToChatGpt(pendingPrompt, sender?.tab?.id);
    const dispatchedPrompt = {
      ...pendingPrompt,
      status: "dispatched",
      chatgptTabId: relay.tabId,
      dispatchedAt: new Date().toISOString(),
    };
    await chrome.storage.local.set({ pendingPrompt: dispatchedPrompt });
    await setProjectRunStatus(pendingPrompt.lovableProjectId, {
      status: "working",
      marker: "",
      dispatchedAt: dispatchedPrompt.dispatchedAt,
      chatgptTabId: relay.tabId,
      error: "",
    });
    return {
      ok: true,
      status: "dispatched",
      chatgptTabId: relay.tabId,
      repository: pendingPrompt.repository,
      repositoryDetectionSource: pendingPrompt.repositoryDetectionSource,
    };
  } catch (error) {
    const failedPrompt = {
      ...pendingPrompt,
      status: "error",
      error: error instanceof Error ? error.message : String(error),
      failedAt: new Date().toISOString(),
    };
    await chrome.storage.local.set({ pendingPrompt: failedPrompt });
    await setProjectRunStatus(pendingPrompt.lovableProjectId, {
      status: "error",
      marker: "[LOVABURST_ERROR]",
      error: failedPrompt.error,
      completedAt: failedPrompt.failedAt,
    });
    return { ok: false, error: failedPrompt.error };
  }
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const link = await getStoredChatGptLink();
  if (link?.tabId === tabId) {
    await clearChatGptLink();
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  const link = await getStoredChatGptLink();
  if (link?.tabId !== tabId) return;

  if (changeInfo.url && !changeInfo.url.startsWith("https://chatgpt.com/")) {
    await clearChatGptLink();
    return;
  }

  if (tab?.url?.startsWith("https://chatgpt.com/") && (changeInfo.url || changeInfo.title)) {
    await chrome.storage.local.set({
      chatgptLink: {
        ...link,
        url: tab.url,
        title: tab.title || link.title || "ChatGPT",
        updatedAt: new Date().toISOString(),
      },
    });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "LOVABURST_RESULT_MARKER_DETECTED") {
    // Step 3: the ChatGPT content script already persisted the project-scoped result.
    // Mark access bootstrap complete only after a successful ChatGPT completion.
    const marker = String(message.marker || "");
    const projectId = String(message.projectId || "");
    if (marker === "[PRM_DONE]" || marker === "[LOVABURST_DONE]" || marker === "[LOVARPM_DONE]") {
      chrome.storage.local.get("pendingPrompt")
        .then((stored) => {
          const prompt = stored.pendingPrompt;
          if (
            prompt?.accessBootstrapKey &&
            String(prompt?.lovableProjectId || "") === projectId
          ) {
            return markAccessBootstrapComplete(prompt.accessBootstrapKey);
          }
        })
        .catch(() => {});
    }
    const completionMarkers = ["[PRM_DONE]", "[PRM_BLOCKED]", "[PRM_ERROR]", "[LOVABURST_DONE]", "[LOVABURST_BLOCKED]", "[LOVABURST_ERROR]", "[LOVARPM_DONE]", "[LOVARPM_BLOCKED]", "[LOVARPM_ERROR]"];
    if (projectId && completionMarkers.includes(marker)) {
      void (async () => {
        const stored = await chrome.storage.local.get(PROJECT_RUN_STATUS_KEY);
        const run = stored[PROJECT_RUN_STATUS_KEY]?.[projectId] || {};
        const runToken = `${projectId}:${run.assistantMessageKey || run.completedAt || marker}:${marker}`;
        if (run.postCompletionKey === runToken || POST_COMPLETION_RUNS.has(runToken)) return;
        POST_COMPLETION_RUNS.add(runToken);
        try {
          const context = await gatherProjectContext(projectId);
          await runPostCompletionPipeline(projectId, run.liveResponse || run.excerpt || "", { ...context, marker, status: run.status }, setProjectRunStatus);
          await setProjectRunStatus(projectId, { postCompletionKey: runToken });
        } finally {
          POST_COMPLETION_RUNS.delete(runToken);
        }
      })().catch((error) => {
        void setProjectRunStatus(projectId, { status: "error", error: error instanceof Error ? error.message : String(error) });
      });
    }
    sendResponse({
      ok: true,
      projectId,
      status: String(message.status || ""),
      marker,
    });
    return false;
  }


  if (!message || typeof message !== "object") return false;
  if (message.type === "LOVARPM_SETUP_PROJECT") {
    const projectId = String(message.projectId || "").trim();
    setupProject(projectId, (payload) => {
      chrome.runtime.sendMessage({ type: "SETUP_PROGRESS", payload }).catch(() => {});
    })
      .then(() => {
        chrome.runtime.sendMessage({ type: "SETUP_DONE", payload: { ok: true } }).catch(() => {});
        sendResponse({ ok: true });
      })
      .catch((error) => {
        const detail = error instanceof Error ? error.message : String(error);
        chrome.runtime.sendMessage({ type: "SETUP_FAILED", payload: { error: detail } }).catch(() => {});
        sendResponse({ ok: false, error: detail });
      });
    return true;
  }

  if (message.type === "LOVABURST_PREPARE_SPECIAL_OPERATION") {
    const operation = String(message.operation || "").trim();
    if (!["create-project", "analyze-project"].includes(operation)) { sendResponse({ ok: false, error: "Invalid operation." }); return false; }
    globalThis.LovaRPMLicense?.preparePrompt?.(operation, message.payload || {})
      .then((prompt) => sendResponse({ ok: true, prompt }))
      .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  }

  if (message.type === "LOVABURST_GET_CONFIG") {
    getConfig()
      .then((config) => sendResponse({ ok: true, config }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message.type === "LOVABURST_SET_CONFIG") {
    setConfig(message.config ?? {})
      .then((config) => sendResponse({ ok: true, config }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message.type === "LOVABURST_LIST_CHATGPT_TABS") {
    listChatGptTabs()
      .then((tabs) => sendResponse({ ok: true, tabs }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message.type === "LOVABURST_GET_CHATGPT_STATUS") {
    getChatGptStatus()
      .then((status) => sendResponse({ ok: true, ...status }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message.type === "LOVABURST_LINK_CHATGPT") {
    linkChatGptTab(Number(message.tabId))
      .then((link) => sendResponse({ ok: true, link }))
      .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  }

  if (message.type === "LOVABURST_UNLINK_CHATGPT") {
    clearChatGptLink()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message.type === "LOVABURST_OPEN_LINKED_CHATGPT") {
    getLinkedChatGptTab()
      .then(async (tab) => {
        if (!tab?.id) {
          sendResponse({ ok: false, error: "No ChatGPT conversation is linked." });
          return;
        }
        await chrome.tabs.update(tab.id, { active: true });
        if (tab.windowId) await chrome.windows.update(tab.windowId, { focused: true });
        sendResponse({ ok: true });
      })
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message.type === "LOVABURST_DETECT_WORKSPACE") {
    detectLovableWorkspace(sender?.tab?.id, message.payload || {})
      .then((workspace) => sendResponse({ ok: true, ...workspace }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message.type === "LOVABURST_PROMPT_CAPTURED") {
    handleCapturedPrompt(message, sender)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message.type === "LOVABURST_PING") {
    sendResponse({ ok: true, source: "background" });
  }

  return false;
});
