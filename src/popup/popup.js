"use strict";

async function getConfig() {
  const DEFAULT_CONFIG = { enabled: true, lovableEnabled: true, chatgptEnabled: true };
  const stored = await chrome.storage.local.get("config");
  return { ...DEFAULT_CONFIG, ...(stored.config ?? {}) };
}

async function setConfig(nextConfig) {
  const DEFAULT_CONFIG = { enabled: true, lovableEnabled: true, chatgptEnabled: true };
  const config = { ...DEFAULT_CONFIG, ...nextConfig };
  await chrome.storage.local.set({ config });
  return config;
}

const KEY = "projectChatBindings";
const BRIDGE = "src/content/chatgpt.js";
const LAST_WORKSPACE_KEY = "lastLovableWorkspace";
const LAST_WORKSPACES_KEY = "lastPlatformWorkspaces";
const PROJECT_SKILLS_KEY = "projectSkillSelections";
const $ = (selector) => document.querySelector(selector);

const ui = {
  enabled: $("#enabledToggle"),
  repoState: $("#repositoryState"),
  repo: $("#repositoryValue"),
  project: $("#projectValue"),
  refreshRepo: $("#refreshRepositoryButton"),
  setupCard: $("#chatSetupCard"),
  connectedCard: $("#chatConnectedCard"),
  useOpen: $("#useOpenChatButton"),
  create: $("#newChatgptButton"),
  open: $("#openChatgptButton"),
  useAnother: $("#useAnotherChatButton"),
  compactNew: $("#compactNewChatButton"),
  chatState: $("#compactChatState"),
  memoryState: $("#compactMemoryState"),
  help: $("#chatgptHelp"),
  commandInput: $("#commandInput"),
  commandCounter: $("#commandCounter"),
  sendCommand: $("#sendCommandButton"),
  feedback: $("#sendFeedback"),
  version: $("#versionBadge"),
  versionText: $("#versionText"),
  footerVersion: $("#footerVersion"),
  updateBanner: $("#updateBanner"),
  updateTitle: $("#updateTitle"),
  updateText: $("#updateText"),
  runStatusCard: $("#runStatusCard"),
  runStatusMain: $("#runStatusMain"),
  runStatusIcon: $("#runStatusIcon"),
  runStatusTitle: $("#runStatusTitle"),
  runStatusText: $("#runStatusText"),
  runStatusTime: $("#runStatusTime"),
  runStatusLoader: $("#runStatusLoader"),
  runObjective: $("#runObjective"),
  runResponseMirror: $("#runResponseMirror"),
  runResponseState: $("#runResponseState"),
  runResponseBody: $("#runResponseBody"),
  chatPanel: $("#chatPanel"),
  skillsPanel: $("#skillsPanel"),
  historyPanel: $("#historyPanel"),
  historyList: $("#historyList"),
  chatTab: $("#chatTabButton"),
  skillsTab: $("#skillsPreviewButton"),
  historyTab: $("#historyPreviewButton"),
  skillCountBadge: $("#skillCountBadge"),
  activeSkillsStrip: $("#activeSkillsStrip"),
  activeSkillsChips: $("#activeSkillsChips"),
  skillsSummary: $("#skillsSummary"),
  clearSkills: $("#clearSkillsButton"),
  refreshData: $("#refreshDataButton"),
  settings: $("#settingsButton"),
  hideBadge: $("#hideLovableBadgeButton"),
  downloadProject: $("#downloadProjectButton"),
};

let workspace = { repository: "", lovableProjectId: "", sourceTitle: "", sourceUrl: "", platform: "lovable", outsideLovable: true };
let refreshingWorkspace = false;
let refreshingChat = false;

const now = () => new Date().toISOString();
const makeId = () => crypto.randomUUID?.() || `chat-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

const SKILLS = {
  "interface-premium": { name: "Premium Interface" },
  "git-safe": { name: "Safe Git" },
  "tests-regression": { name: "Testing & Regression" },
  "responsive": { name: "Responsiveness" },
  "performance": { name: "Performance" },
  "security-review": { name: "Security Review" },
  "responsivo-completo": { name: "Complete Responsiveness" },
  "corrigir-projeto": { name: "Fix Project" },
  "seguranca-e-banco": { name: "Security & Database" },
  "melhorar-ui-ux": { name: "Improve UI/UX" },
  "refatorar-projeto": { name: "Refactor Project" },
  "otimizar-projeto": { name: "Optimize Project" },
  "accessibility-wcag": { name: "Accessibility (WCAG)" },
  "agent-ui-design": { name: "Agent UI Design" },
  "ai-design-workflow": { name: "AI Design Workflow" },
  "audit-code-quality": { name: "Audit Code Quality" },
  "audit-cost-explosion": { name: "Audit Cost Explosion" },
  "audit-legal-risks": { name: "Audit Legal Risks" },
  "audit-monitoring-recovery": { name: "Audit Monitoring & Recovery" },
  "audit-secrets-data-leaks": { name: "Audit Secrets & Data Leaks" },
  "audit-unauthorized-access": { name: "Audit Unauthorized Access" },
  "branding-identity": { name: "Branding & Identity" },
  "cloud-migration": { name: "Cloud Migration" },
  "color-theory": { name: "Color Theory" },
  "component-patterns": { name: "Component Patterns" },
  "customer-journey": { name: "Customer Journey" },
  "design-process": { name: "Design Process" },
  "design-system-pro": { name: "Design System Pro" },
  "ux-design": { name: "UX Design" },
  "vibe-security-check": { name: "Vibe Security Check" },
  "visual-direction": { name: "Visual Direction" },
  "web-typography": { name: "Web Typography" },
  "webdesign-review": { name: "Webdesign Review" },
  "website-audit-relaunch": { name: "Website Audit & Relaunch" },
  "design-trends-2026": { name: "Design Trends 2026" },
  "images-media": { name: "Images & Media" },
  "landing-pages": { name: "Landing Pages" },
  "navigation-design": { name: "Navigation Design" },
  "responsive-design": { name: "Responsive Design" },
  "ui-design": { name: "UI Design" },
  "ui-patterns": { name: "UI Patterns" },
  "usability": { name: "Usability" },
};

async function selectedSkills(projectId = workspace.lovableProjectId) {
  if (!projectId) return [];
  const stored = await chrome.storage.local.get(PROJECT_SKILLS_KEY);
  return Array.isArray(stored[PROJECT_SKILLS_KEY]?.[projectId]) ? stored[PROJECT_SKILLS_KEY][projectId] : [];
}

async function saveSelectedSkills(ids, projectId = workspace.lovableProjectId) {
  if (!projectId) return;
  const stored = await chrome.storage.local.get(PROJECT_SKILLS_KEY);
  await chrome.storage.local.set({
    [PROJECT_SKILLS_KEY]: {
      ...(stored[PROJECT_SKILLS_KEY] || {}),
      [projectId]: ids.filter((id) => SKILLS[id]),
    },
  });
}

async function renderSkills() {
  const ids = await selectedSkills();
  document.querySelectorAll("[data-skill]").forEach((card) => card.classList.toggle("active", ids.includes(card.dataset.skill)));
  ui.skillCountBadge.textContent = String(ids.length);
  ui.skillsSummary.textContent = ids.length ? `${ids.length} skill${ids.length === 1 ? "" : "s"} active for this project` : "No skills selected";
  ui.activeSkillsStrip.hidden = !ids.length;
  ui.activeSkillsChips.innerHTML = ids.map((id) => `<b>${SKILLS[id].name}</b>`).join("");
}

function setTab(name) {
  const map = { chat: ui.chatPanel, commands: $("#commandsPanel"), skills: ui.skillsPanel, history: ui.historyPanel };
  for (const [key, panel] of Object.entries(map)) panel.classList.toggle("active", key === name);
  [ui.chatTab, $("#commandsTabButton"), ui.skillsTab, ui.historyTab].forEach((button) => button.classList.toggle("active", button.dataset.tab === name));
  if (name === "history") void renderHistory();
}

async function bindings() {
  return (await chrome.storage.local.get(KEY))[KEY] || {};
}

async function save(all) {
  await chrome.storage.local.set({ [KEY]: all });
}

async function record(projectId) {
  return projectId ? (await bindings())[projectId] || null : null;
}

async function update(projectId, updater) {
  const all = await bindings();
  const current = all[projectId] || {
    projectId, repository: "", sourceTitle: "", sourceUrl: "",
    activeConversationId: "", conversations: [], recentObjectives: [],
  };
  const next = await updater({
    ...current,
    conversations: Array.isArray(current.conversations) ? [...current.conversations] : [],
    recentObjectives: Array.isArray(current.recentObjectives) ? [...current.recentObjectives] : [],
  });
  all[projectId] = { ...next, projectId, updatedAt: now() };
  await save(all);
  return all[projectId];
}

async function renderHistory() {
  if (!ui.historyPanel) return;
  let list = ui.historyList;
  if (!list) {
    ui.historyPanel.innerHTML = '<section class="history-card"><div class="history-head"><div><span>// HISTORY</span><strong>Requests sent</strong></div></div><div id="historyList" class="history-list"></div></section>';
    list = ui.historyList = $("#historyList");
  }
  const rec = await record(workspace.lovableProjectId);
  const rawItems = Array.isArray(rec?.recentObjectives) ? rec.recentObjectives.slice().reverse() : [];
  const items = rawItems.filter((item, index) => index === 0 || String(item?.text || "") !== String(rawItems[index - 1]?.text || "")).slice(0, 50);
  list.replaceChildren();
  if (!items.length) { const empty = document.createElement("p"); empty.className = "history-empty"; empty.textContent = "Requests sent for this project will appear here."; list.append(empty); return; }
  for (const item of items) { const row = document.createElement("article"); row.className = "history-item"; const text = document.createElement("p"); text.textContent = String(item?.text || ""); const time = document.createElement("time"); const date = item?.createdAt ? new Date(item.createdAt) : null; time.textContent = date && !Number.isNaN(date.valueOf()) ? date.toLocaleString("en-US", { dateStyle: "short", timeStyle: "short" }) : ""; row.append(text, time); list.append(row); }
}

function active(rec) {
  return rec?.conversations?.find((item) => item.id === rec.activeConversationId) || null;
}

async function chatTabs() {
  const tabs = await chrome.tabs.query({ url: ["https://chatgpt.com/*"] });
  const removedAssistantName = String.fromCharCode(103, 101, 109, 105, 110, 105);
  return tabs
    .filter((tab) => tab.id && !String(tab.title || "").toLowerCase().includes(removedAssistantName))
    .map((tab) => ({
      tabId: tab.id,
      title: tab.title || "ChatGPT",
      url: tab.url || "https://chatgpt.com/",
      active: Boolean(tab.active),
      windowId: tab.windowId,
      lastAccessed: tab.lastAccessed || 0,
    }))
    .sort((a, b) => Number(b.active) - Number(a.active) || b.lastAccessed - a.lastAccessed);
}

async function ensureBridge(tabId) {
  try {
    const ping = await chrome.tabs.sendMessage(tabId, { type: "LOVABURST_CONTENT_PING" });
    if (ping?.ok && ping.source === "chatgpt") return true;
  } catch {}
  await chrome.scripting.executeScript({ target: { tabId }, files: [BRIDGE] });
  const ping = await chrome.tabs.sendMessage(tabId, { type: "LOVABURST_CONTENT_PING" });
  return Boolean(ping?.ok && ping.source === "chatgpt");
}

async function activateRelay(tabId) {
  const response = await chrome.runtime.sendMessage({ type: "LOVABURST_LINK_CHATGPT", tabId });
  if (!response?.ok) throw new Error(response?.error || "Could not activate this conversation.");
}

async function sendDirect(tabId, prompt) {
  if (!(await ensureBridge(tabId))) throw new Error("The ChatGPT bridge did not respond.");
  const response = await chrome.tabs.sendMessage(tabId, { type: "LOVABURST_SUBMIT_TO_CHATGPT", prompt });
  if (!response?.ok) throw new Error(response?.error || "ChatGPT did not confirm the submission.");
}

async function ownerOf(tab) {
  const all = await bindings();
  for (const [projectId, rec] of Object.entries(all)) {
    for (const conversation of rec?.conversations || []) {
      const lockedUrl = conversation.lockedUrl || conversation.url || "";
      if (tab.url && lockedUrl && tab.url === lockedUrl) return projectId;
    }
  }
  return "";
}

async function linkTab(tabId) {
  const projectId = workspace.lovableProjectId;
  if (!projectId) throw new Error("Open a Lovable project first.");

  const tab = await chrome.tabs.get(tabId);
  if (!tab?.id || !tab.url?.startsWith("https://chatgpt.com/")) {
    throw new Error("The selected conversation is not a ChatGPT conversation.");
  }

  const owner = await ownerOf({ tabId: tab.id, url: tab.url });
  if (owner && owner !== projectId) {
    throw new Error("This conversation is already linked to another LovaRPM project.");
  }
  if (!(await ensureBridge(tab.id))) throw new Error("The LovaRPM bridge did not respond.");

  await update(projectId, (rec) => {
    const conversations = [...rec.conversations];
    let linked =
      conversations.find((item) => {
        const lockedUrl = item.lockedUrl || item.url || "";
        return tab.url !== "https://chatgpt.com/" && lockedUrl === tab.url;
      });

    if (!linked) {
      linked = {
        id: makeId(),
        tabId: tab.id,
        url: tab.url,
        title: tab.title || "ChatGPT",
        createdAt: now(),
        linkedAt: now(),
        contextSentAt: "",
        lockedUrl: tab.url,
        lockedTitle: tab.title || "ChatGPT",
      };
      conversations.push(linked);
    } else {
      linked = {
        ...linked,
        tabId: tab.id,
        url: tab.url,
        title: tab.title || linked.title || "ChatGPT",
        lockedUrl: tab.url,
        lockedTitle: tab.title || linked.lockedTitle || linked.title || "ChatGPT",
        linkedAt: now(),
        closedAt: "",
      };
      conversations[conversations.findIndex((item) => item.id === linked.id)] = linked;
    }

    return {
      ...rec,
      platform: workspace.platform,
      repository: workspace.repository || rec.repository || "",
      sourceTitle: workspace.sourceTitle || rec.sourceTitle || "",
      sourceUrl: workspace.sourceUrl || rec.sourceUrl || "",
      activeConversationId: linked.id,
      conversations: conversations.slice(-12),
    };
  });

  await activateRelay(tab.id);
}

async function contextPrompt(rec) {
  const objectives = (rec?.recentObjectives || []).slice(-12);
  const integrations = (await chrome.storage.local.get("projectIntegrations")).projectIntegrations?.[rec?.projectId] || {};
  const supabase = integrations.supabase || {};
  const lines = objectives.length
    ? objectives.map((item, index) => `${index + 1}. ${item.text}`).join("\n")
    : "No previous requests have been recorded locally by LovaRPM.";

  const platform = "lovable";
  const platformName = "Lovable";
  const platformKey = "LOVABLE_PROJECT";
  return [
    "[LOVABURST_PROJECT_CONTEXT_V2]",
    "MODE: PROJECT_CONTINUATION",
    `PLATFORM: ${platform.toUpperCase()}`,
    `${platformKey}: ${rec?.projectId || ""}`,
    `REPOSITORY: ${rec?.repository || "AUTO_NOT_DETECTED"}`,
    "REPOSITORY_SOURCE: GITHUB_PRIMARY",
    `SOURCE_TITLE: ${rec?.sourceTitle || ""}`,
    `SUPABASE_STATUS: ${supabase.status || "unknown"}`,
    `SUPABASE_PROJECT_REF: ${supabase.projectRef || ""}`,
    "CONNECTORS_TO_VERIFY_WHEN_NEEDED: GitHub, Supabase",
    `CONTEXT_GENERATED_AT: ${now()}`,
    "",
    "PURPOSE:",
    "This conversation is dedicated exclusively to the specified GitHub repository. Do not mix in context, decisions, or code from other projects.",
    "",
    "RECENT_USER_OBJECTIVES:",
    lines,
    "",
    "PREVIOUS_CONVERSATION_HANDOFF:",
    rec?.handoffExcerpt || "No excerpt from the previous conversation could be captured.",
    "",
    "CONTINUITY_RULES:",
    "- Use recent objectives only as continuity context; they do not prove the current state of the code.",
    "- Before any future changes, inspect the actual state of the GitHub repository specified in the new request.",
    "- When REPOSITORY is concrete, treat GitHub as the primary and authoritative source of code; if it is AUTO_NOT_DETECTED, do not guess.",
    `- ${platformKey} is only a linking identifier; do not open or attempt to access ${platformName} to read or edit code.`,
    "- Preserve existing work and decisions already embodied in the repository.",
    "- If the project uses Supabase, confirm the correct Supabase project before backend or database changes.",
    "- Discover and use the available GitHub and Supabase connectors when needed.",
    "- Do not carry assumptions over from other conversations or projects.",
    "- Future [LOVABURST_REQUEST_V3] blocks sent in this conversation belong to this project and must respect each block's metadata. Earlier V1/V2 blocks remain valid only as compatibility history.",
    "",
    "Reply only with a brief confirmation that this project's context has been loaded.",
  ].join("\n");
}
