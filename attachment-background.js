import { withSkillInstructions } from "../shared/skill-instructions.js";

const SKILL_IDS = new Set([
  "interface-premium",
  "git-safe",
  "tests-regression",
  "responsive",
  "performance",
  "security-review",
  "responsivo-completo",
  "corrigir-projeto",
  "seguranca-e-banco",
  "melhorar-ui-ux",
  "refatorar-projeto",
  "otimizar-projeto",
  "accessibility-wcag",
  "agent-ui-design",
  "ai-design-workflow",
  "audit-code-quality",
  "audit-cost-explosion",
  "audit-legal-risks",
  "audit-monitoring-recovery",
  "audit-secrets-data-leaks",
  "audit-unauthorized-access",
  "branding-identity",
  "cloud-migration",
  "color-theory",
  "component-patterns",
  "customer-journey",
  "design-process",
  "design-system-pro",
  "ux-design",
  "vibe-security-check",
  "visual-direction",
  "web-typography",
  "webdesign-review",
  "website-audit-relaunch",
  "design-trends-2026",
  "images-media",
  "landing-pages",
  "navigation-design",
  "responsive-design",
  "ui-design",
  "ui-patterns",
  "usability",
]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ATTACHMENT_BRIDGE_VERSION = "0.31.7";

async function status(projectId, patch) {
  if (!projectId) return;
  const stored = await chrome.storage.local.get("projectRunStatuses");
  const all = stored.projectRunStatuses || {};
  await chrome.storage.local.set({
    projectRunStatuses: {
      ...all,
      [projectId]: {
        ...(all[projectId] || {}),
        ...patch,
        projectId,
        updatedAt: new Date().toISOString(),
      },
    },
  });
}

async function skills(projectId) {
  const stored = await chrome.storage.local.get("projectSkillSelections");
  const ids = stored.projectSkillSelections?.[projectId] || [];
  return Array.isArray(ids) ? ids.filter((id) => SKILL_IDS.has(id)).slice(0, 42) : [];
}

async function chat(projectId) {
  const stored = await chrome.storage.local.get("projectChatBindings");
  const record = stored.projectChatBindings?.[projectId];
  const conversation = record?.conversations?.find((item) => item.id === record.activeConversationId);
  if (!conversation) throw new Error("Connect a ChatGPT conversation before sending.");

  if (conversation.tabId) {
    try {
      const tab = await chrome.tabs.get(conversation.tabId);
      if (tab?.url?.startsWith("https://chatgpt.com/")) return tab;
    } catch {}
  }

  const tabs = await chrome.tabs.query({ url: ["https://chatgpt.com/*"] });
  const exact = tabs.find((tab) => conversation.url && tab.url === conversation.url);
  if (exact) return exact;
  throw new Error("The linked ChatGPT conversation is unavailable.");
}

async function ensureBridges(tabId) {
  try {
    const ping = await chrome.tabs.sendMessage(tabId, { type: "LOVABURST_CONTENT_PING" });
    if (!ping?.ok) throw new Error("bridge ausente");
  } catch {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["src/content/chatgpt.js"] });
  }

  try {
    const ping = await chrome.tabs.sendMessage(tabId, { type: "LOVABURST_ATTACHMENTS_PING" });
    if (ping?.ok && ping.version === ATTACHMENT_BRIDGE_VERSION) return;
  } catch {}

  await chrome.scripting.executeScript({ target: { tabId }, files: ["src/content/chatgpt-attachments.js"] });
  const ping = await chrome.tabs.sendMessage(tabId, { type: "LOVABURST_ATTACHMENTS_PING" });
  if (!ping?.ok || ping.version !== ATTACHMENT_BRIDGE_VERSION) throw new Error("The current LovaRPM attachment bridge did not respond in ChatGPT.");
}

async function submit(message, sender) {
  const text = String(message.text || "").trim();
  const attachments = Array.isArray(message.attachments) ? message.attachments.slice(0, 5) : [];
  const projectId = String(message.projectId || "").trim();

  if (!text && !attachments.length) throw new Error("Enter a message or add an attachment.");
  if (!projectId) throw new Error("Could not identify the platform project.");

  const stored = await chrome.storage.local.get(["workspaceBindings", "config"]);
  if (stored.config?.enabled === false || stored.config?.chatgptEnabled === false) {
    throw new Error("The ChatGPT integration is disabled.");
  }

  const repository = String(message.repository || stored.workspaceBindings?.[projectId]?.repository || "");
  const payload = {
    text,
    url: String(message.url || sender?.tab?.url || ""),
    title: String(message.title || sender?.tab?.title || ""),
    capturedAt: new Date().toISOString(),
    repository,
    repositoryDetectionSource: String(message.repositoryDetectionSource || "attachment-flow"),
    lovableProjectId: projectId,
    platform: String(message.url || sender?.tab?.url || "").startsWith("https://app.base44.com/") ? "base44" : "lovable",
    skills: await skills(projectId),
  };

  const preparedPrompt = await globalThis.LovaRPMLicense?.preparePrompt?.("main", payload);
  if (!preparedPrompt) throw new Error("The server did not prepare the attachment operation.");
  const prompt = withSkillInstructions(preparedPrompt, payload.skills);
  const tab = await chat(projectId);
  const source = sender?.tab?.id ? await chrome.tabs.get(sender.tab.id).catch(() => null) : null;
  const wasActive = Boolean(tab.active);

  await status(projectId, {
    status: "sending",
    marker: "",
    objective: (text || attachments.map((attachment) => attachment.name).join(", ")).slice(0, 700),
    startedAt: payload.capturedAt,
    error: "",
  });

  try {
    if (!wasActive) {
      await chrome.tabs.update(tab.id, { active: true });
      await sleep(220);
    }

    await ensureBridges(tab.id);

    const prepared = await chrome.tabs.sendMessage(tab.id, {
      type: "LOVABURST_PREPARE_ATTACHMENTS",
      attachments,
    });
    if (!prepared?.ok || Number(prepared.count || 0) !== attachments.length) {
      throw new Error(prepared?.error || `Could not attach ${attachments[0]?.name || "the file"} to ChatGPT. The message was not sent.`);
    }

    const dispatched = await chrome.tabs.sendMessage(tab.id, {
      type: "LOVABURST_SUBMIT_TO_CHATGPT",
      prompt,
      implementationTask: true,
    });
    if (!dispatched?.ok) {
      throw new Error(dispatched?.error || "ChatGPT did not confirm that the message was sent.");
    }

    await status(projectId, {
      status: "working",
      dispatchedAt: new Date().toISOString(),
      chatgptTabId: tab.id,
      error: "",
    });
    return { ok: true };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await status(projectId, {
      status: "error",
      marker: "[LOVABURST_ERROR]",
      error: detail,
      completedAt: new Date().toISOString(),
    });
    throw error;
  } finally {
    if (!wasActive && source?.id && source.id !== tab.id) {
      await chrome.tabs.update(source.id, { active: true }).catch(() => {});
    }
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "LOVABURST_SUBMIT_WITH_ATTACHMENTS") return false;
  submit(message, sender)
    .then(sendResponse)
    .catch((error) =>
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  return true;
});
