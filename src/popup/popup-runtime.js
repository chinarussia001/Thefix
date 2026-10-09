"use strict";

async function resolveTab(conversation) {
  if (!conversation) return null;
  const lockedUrl = String(conversation.lockedUrl || conversation.url || "").trim();

  if (conversation.tabId) {
    try {
      const tab = await chrome.tabs.get(conversation.tabId);
      if (tab?.url?.startsWith("https://chatgpt.com/") && (!lockedUrl || tab.url === lockedUrl)) return tab;
    } catch {}
  }

  const tabs = await chatTabs();
  if (lockedUrl && lockedUrl !== "https://chatgpt.com/") {
    const byUrl = tabs.find((tab) => tab.url === lockedUrl);
    if (byUrl?.tabId) return chrome.tabs.get(byUrl.tabId);
  }

  return null;
}

async function collectHandoffFromActiveConversation() {
  const projectId = workspace.lovableProjectId;
  const rec = await record(projectId);
  const conversation = active(rec);
  if (!projectId || !conversation) return "";

  const tab = await resolveTab(conversation);
  if (!tab?.id) return "";

  try {
    if (!(await ensureBridge(tab.id))) return "";
    const response = await chrome.tabs.sendMessage(tab.id, {
      type: "LOVABURST_EXPORT_PROJECT_CONTEXT",
      projectId,
    });
    const excerpt = String(response?.excerpt || "").trim();

    if (excerpt) {
      await update(projectId, (next) => ({
        ...next,
        handoffExcerpt: excerpt.slice(-14000),
        handoffCapturedAt: now(),
      }));
    }
    return excerpt;
  } catch {
    return "";
  }
}

async function sendContext() {
  const projectId = workspace.lovableProjectId;
  const rec = await record(projectId);
  const conversation = active(rec);
  if (!rec || !conversation) throw new Error("No active conversation is linked to this project.");
  const tab = await resolveTab(conversation);
  if (!tab?.id) throw new Error("The active conversation is not open.");

  await activateRelay(tab.id);
  await sendDirect(tab.id, await contextPrompt(rec));
  await update(projectId, (next) => ({
    ...next,
    conversations: next.conversations.map((item) =>
      item.id === conversation.id
        ? {
            ...item,
            tabId: tab.id,
            url: tab.url || item.url,
            title: tab.title || item.title,
            lockedUrl: tab.url || item.lockedUrl || item.url,
            lockedTitle: tab.title || item.lockedTitle || item.title,
            contextSentAt: now(),
          }
        : item
    ),
  }));
}

async function waitChat(tabId, timeout = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab?.url?.startsWith("https://chatgpt.com/") && tab.status === "complete") return tab;
    } catch {
      return null;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return chrome.tabs.get(tabId).catch(() => null);
}

async function newConversation(options = {}) {
  const projectId = workspace.lovableProjectId;
  if (!projectId) throw new Error("Open a Lovable project first.");
  const initialPrompt = String(options.initialPrompt || "").trim();

  if (!initialPrompt) await collectHandoffFromActiveConversation();

  await update(projectId, (rec) => ({
    ...rec,
    platform: workspace.platform,
    repository: workspace.repository || rec.repository || "",
    sourceTitle: workspace.sourceTitle || rec.sourceTitle || "",
    sourceUrl: workspace.sourceUrl || rec.sourceUrl || "",
  }));

  const tab = await chrome.tabs.create({ url: "https://chatgpt.com/", active: false });
  const conversation = {
    id: makeId(),
    tabId: tab.id,
    url: tab.url || "https://chatgpt.com/",
    title: "Nova conversa · ChatGPT",
    createdAt: now(),
    linkedAt: now(),
    contextSentAt: "",
    lockedUrl: "",
    lockedTitle: "Nova conversa · ChatGPT",
  };

  await update(projectId, (rec) => ({
    ...rec,
    activeConversationId: conversation.id,
    conversations: [...rec.conversations, conversation].slice(-12),
  }));

  const loaded = await waitChat(tab.id);
  if (!loaded?.id) throw new Error("The new ChatGPT conversation did not load.");

  await update(projectId, (rec) => ({
    ...rec,
    conversations: rec.conversations.map((item) =>
      item.id === conversation.id
        ? {
            ...item,
            tabId: loaded.id,
            url: loaded.url || item.url,
            title: loaded.title || item.title,
            lockedUrl: loaded.url && loaded.url !== "https://chatgpt.com/" ? loaded.url : item.lockedUrl,
            lockedTitle: loaded.title || item.lockedTitle || item.title,
          }
        : item
    ),
  }));

  await activateRelay(loaded.id);
  if (initialPrompt) await sendDirect(loaded.id, initialPrompt);
  else await sendContext();
}

async function rememberLastWorkspace(nextWorkspace) {
  if (!nextWorkspace?.lovableProjectId) return nextWorkspace;
  const snapshot = {
    repository: nextWorkspace.repository || "",
    lovableProjectId: nextWorkspace.lovableProjectId,
    sourceTitle: nextWorkspace.sourceTitle || "",
    sourceUrl: nextWorkspace.sourceUrl || "",
    platform: "lovable",
    rememberedAt: now(),
  };
  const stored = await chrome.storage.local.get(LAST_WORKSPACES_KEY);
  await chrome.storage.local.set({
    [LAST_WORKSPACE_KEY]: snapshot,
    [LAST_WORKSPACES_KEY]: { ...(stored[LAST_WORKSPACES_KEY] || {}), [snapshot.platform]: snapshot },
  });
  return snapshot;
}

async function lastWorkspace() {
  const stored = await chrome.storage.local.get([LAST_WORKSPACES_KEY, LAST_WORKSPACE_KEY]);
  return stored[LAST_WORKSPACES_KEY]?.lovable || stored[LAST_WORKSPACE_KEY] || null;
}

const FIRST_WORKSPACE_RELOAD_KEY = "lovaburstFirstWorkspaceReloadCompleted";

async function reloadFirstDetectedWorkspace(data) {
  if (!data?.lovableProjectId || data.remembered) return false;
  const stored = await chrome.storage.local.get(FIRST_WORKSPACE_RELOAD_KEY);
  if (stored[FIRST_WORKSPACE_RELOAD_KEY]) return false;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const prefix = "https://lovable.dev/";
  if (!tab?.id || !tab.url?.startsWith(prefix) || !tab.url.includes(data.lovableProjectId)) return false;
  await chrome.storage.local.set({
    [FIRST_WORKSPACE_RELOAD_KEY]: {
      projectId: data.lovableProjectId,
      completedAt: new Date().toISOString(),
    },
  });
  await chrome.tabs.reload(tab.id);
  return true;
}

async function currentBuilderWorkspace() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const platform = "lovable";
  const isSelectedPlatform = tab?.url?.startsWith("https://lovable.dev/");

  // Leaving Lovable must not clear the selected project. The last project remains
  // active until the user opens/switches to another concrete Lovable project.
  if (!tab?.id || !isSelectedPlatform) {
    const remembered = await lastWorkspace(platform);
    return remembered
      ? { ...remembered, outsideLovable: false, remembered: true }
      : { outsideLovable: true, platform };
  }

  const lovableProjectId = tab.url.match(/\/projects\/([A-Za-z0-9-]+)/i)?.[1] || "";
  if (!lovableProjectId) {
    const remembered = await lastWorkspace(platform);
    return remembered
      ? { ...remembered, outsideLovable: false, remembered: true }
      : { outsideLovable: true, platform };
  }

  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: "LOVABURST_CONTENT_PING" });
    if (response?.ok && response.source === platform) {
      return rememberLastWorkspace({
        repository: response.repository || "",
        lovableProjectId: response.lovableProjectId || lovableProjectId,
        sourceTitle: tab.title || "",
        sourceUrl: tab.url || "",
        platform,
      });
    }
  } catch {}

  const stored = await chrome.storage.local.get("workspaceBindings");
  return rememberLastWorkspace({
    repository: stored.workspaceBindings?.[lovableProjectId]?.repository || "",
    lovableProjectId,
    sourceTitle: tab.title || "",
    sourceUrl: tab.url || "",
    platform,
  });
}

function renderWorkspace(data = {}) {
  workspace = {
    repository: data.repository || "",
    lovableProjectId: data.lovableProjectId || "",
    sourceTitle: data.sourceTitle || "",
    sourceUrl: data.sourceUrl || "",
    platform: "lovable",
    outsideLovable: Boolean(data.outsideLovable),
  };

  ui.project.textContent = workspace.lovableProjectId || "—";
  ui.refreshRepo.disabled = !workspace.lovableProjectId;

  if (workspace.outsideLovable) {
    ui.repo.textContent = "Open a project in Lovable";
    ui.repoState.textContent = "No project";
    ui.repoState.className = "state-pill is-empty";
  } else if (data.detecting) {
    ui.repo.textContent = "Detecting repository…";
    ui.repoState.textContent = "Updating";
    ui.repoState.className = "state-pill";
  } else if (workspace.repository) {
    ui.repo.textContent = workspace.repository;
    ui.repoState.textContent = data.remembered ? "Active project" : "Connected";
    ui.repoState.className = "state-pill is-connected";
  } else {
    ui.repo.textContent = "Repository not detected";
    ui.repoState.textContent = "No GitHub repository";
    ui.repoState.className = "state-pill is-empty";
  }
}

async function refreshWorkspace() {
  if (refreshingWorkspace) return;
  refreshingWorkspace = true;
  try {
    const detectedWorkspace = await currentBuilderWorkspace();
    renderWorkspace(detectedWorkspace);
    if (await reloadFirstDetectedWorkspace(detectedWorkspace)) return;
    await refreshRunStatus();
    await renderSkills();
  } finally {
    refreshingWorkspace = false;
  }
}

async function restoreActiveConversation(rec) {
  const projectId = workspace.lovableProjectId;
  const conversation = active(rec);
  if (!projectId || !conversation) return rec;

  const tab = await resolveTab(conversation);
  if (!tab?.id) return rec;

  try {
    await activateRelay(tab.id);
  } catch {}
  return rec;
}
