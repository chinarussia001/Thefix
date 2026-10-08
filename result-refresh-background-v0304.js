const PROJECT_CHATS_KEY = "projectChatBindings";
const RESULT_BRIDGE = "src/content/chatgpt-result-refresh.js";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function activeProjectConversation(projectId) {
  if (!projectId) return null;
  const stored = await chrome.storage.local.get(PROJECT_CHATS_KEY);
  const record = stored[PROJECT_CHATS_KEY]?.[projectId];
  return record?.conversations?.find((item) => item.id === record.activeConversationId) || null;
}

async function resolveChatTab(conversation) {
  if (!conversation) return null;
  if (conversation.tabId) {
    try {
      const tab = await chrome.tabs.get(conversation.tabId);
      if (tab?.url?.startsWith("https://chatgpt.com/")) return tab;
    } catch {}
  }
  const tabs = await chrome.tabs.query({ url: ["https://chatgpt.com/*"] });
  if (conversation.url && conversation.url !== "https://chatgpt.com/") {
    const exact = tabs.find((tab) => tab.url === conversation.url);
    if (exact?.id) return exact;
  }
  const sameTitle = conversation.title ? tabs.filter((tab) => tab.title === conversation.title) : [];
  return sameTitle.length === 1 ? sameTitle[0] : null;
}

async function focusedTab() {
  try {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return tabs[0] || null;
  } catch {
    return null;
  }
}

async function focusWindow(windowId) {
  if (!Number.isInteger(windowId) || !chrome.windows?.update) return;
  try { await chrome.windows.update(windowId, { focused: true }); } catch {}
}

async function scanResult(tabId, projectId) {
  const message = { type: "LOVABURST_SCAN_RESULT_MARKERS", projectId, wakeBypass: true };
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch {}
  await chrome.scripting.executeScript({ target: { tabId }, files: [RESULT_BRIDGE] });
  return chrome.tabs.sendMessage(tabId, message);
}

async function refreshVisibleChatGptResult(projectId) {
  const id = String(projectId || "").trim();
  if (!id) throw new Error("Project ID was not provided.");
  const conversation = await activeProjectConversation(id);
  const tab = await resolveChatTab(conversation);
  if (!tab?.id) throw new Error("The linked ChatGPT conversation is unavailable.");

  try {
    const response = await scanResult(tab.id, id);
    return response || { ok: true, projectId: id };
  } catch (firstError) {
    const previous = await focusedTab();
    const shouldRestore = Boolean(previous?.id && previous.id !== tab.id);
    const previousWindowId = previous?.windowId || null;
    try {
      await chrome.tabs.update(tab.id, { active: true, autoDiscardable: false }).catch(() => chrome.tabs.update(tab.id, { active: true }));
      if (tab.windowId !== previousWindowId) await focusWindow(tab.windowId);
      await sleep(180);
      return (await scanResult(tab.id, id)) || { ok: true, projectId: id };
    } finally {
      if (shouldRestore) {
        await chrome.tabs.update(previous.id, { active: true }).catch(() => {});
        if (previousWindowId !== tab.windowId) await focusWindow(previousWindowId);
      }
    }
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "LOVABURST_REFRESH_CHATGPT_RESULT_V0304") return false;
  refreshVisibleChatGptResult(message.projectId)
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  return true;
});
