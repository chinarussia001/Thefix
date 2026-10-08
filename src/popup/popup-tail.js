"use strict";

function activeBuilderName() { return workspace.platform === "base44" ? "Base44" : "Lovable"; }
function activeBuilderPattern() { return workspace.platform === "base44" ? "https://app.base44.com/apps/*" : "https://lovable.dev/*"; }
function activeBuilderPrefix() { return workspace.platform === "base44" ? "https://app.base44.com/apps/" : "https://lovable.dev/"; }

function displayConversationTitle(conversation, title) {
  return !conversation?.lockedUrl && title === "Nova conversa · ChatGPT" ? "New conversation · ChatGPT" : title;
}

function formatStatusTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
}

async function refreshRunStatus() {
  const projectId = workspace.lovableProjectId;
  if (!projectId) {
    ui.runStatusMain.dataset.status = "idle";
    ui.runStatusIcon.textContent = "◌";
    ui.runStatusTitle.textContent = "No project selected";
    ui.runStatusText.textContent = `Open a ${activeBuilderName()} project to track requests.`;
    ui.runStatusTime.textContent = "";
    ui.runStatusLoader.hidden = true;
    ui.runObjective.hidden = true;
    if (ui.runResponseMirror) ui.runResponseMirror.hidden = true;
    return;
  }

  const stored = await chrome.storage.local.get("projectRunStatuses");
  const status = stored.projectRunStatuses?.[projectId] || null;

  if (!status) {
    ui.runStatusMain.dataset.status = "idle";
    ui.runStatusIcon.textContent = "◌";
    ui.runStatusTitle.textContent = "No requests sent yet";
    ui.runStatusText.textContent = "Progress will appear here after you send a request.";
    ui.runStatusTime.textContent = "";
    ui.runStatusLoader.hidden = true;
    ui.runObjective.hidden = true;
    if (ui.runResponseMirror) ui.runResponseMirror.hidden = true;
    return;
  }

  const states = {
    sending: { icon: "↗", title: "Sending to ChatGPT…", text: "Preparing the project, repository, and request context.", loading: true },
    working: { icon: "✦", title: "ChatGPT is working…", text: "Working...", loading: true },
    done: { icon: "✓", title: "Complete", text: "ChatGPT completed this request successfully.", loading: false },
    blocked: { icon: "!", title: "Action required", text: status.marker?.startsWith("[PRM_") ? `ChatGPT reported ${status.marker}` : "ChatGPT encountered a blocker and needs your attention.", loading: false },
    error: { icon: "×", title: "Execution error", text: status.error || "This request could not be completed.", loading: false },
    migrated: { icon: "↻", title: "Migrations applied", text: `Migrations applied: ${(status.applied || []).join(", ") || "none"}`, loading: true },
    live: { icon: "✓", title: "Endpoint live", text: `Endpoint live: ${status.urls?.find((item) => item.state === "live")?.url || "verified"}`, loading: false },
    "runtime-error": { icon: "×", title: "Endpoint error", text: `Endpoint 500: ${status.urls?.find((item) => item.state === "runtime-error")?.url || "unknown"}`, loading: false },
    "deploy-failed": { icon: "…", title: "Build not deployed", text: `Endpoint 404 after retries: ${status.urls?.find((item) => item.state === "deploy-failed")?.url || "unknown"}`, loading: false },
    "schema-failed": { icon: "×", title: "Migration failed", text: `Migration failed at ${status.failed_at || "unknown file"}: ${status.error || "unknown error"}`, loading: false },
    "schema-timeout": { icon: "…", title: "Migration timeout", text: status.error || "Migration runner did not deploy within 3 minutes.", loading: false },
  };

  const state = states[status.status] || { icon: "◌", title: "Waiting", text: "The request is being prepared.", loading: false };
  ui.runStatusMain.dataset.status = status.status || "idle";
  ui.runStatusIcon.textContent = state.icon;
  ui.runStatusTitle.textContent = state.title;
  const committed = status.status === "working" && /Commit SHA:\s*[a-f0-9]{7,40}/i.test(String(status.liveResponse || ""));
  ui.runStatusText.textContent = committed ? "Committed · awaiting build..." : state.text;
  ui.runStatusLoader.hidden = !state.loading;
  ui.runStatusTime.textContent = formatStatusTime(status.completedAt || status.detectedAt || status.dispatchedAt || status.startedAt || status.updatedAt);
  if (ui.runResponseMirror && ui.runResponseBody && ui.runResponseState) {
    const liveResponse = String(status.liveResponse || "").trim();
    const terminal = ["done", "blocked", "error"].includes(status.status);
    const showMirror = Boolean(liveResponse) && (status.status === "working" || terminal);
    ui.runResponseMirror.hidden = !showMirror;
    ui.runResponseMirror.dataset.state = terminal ? "done" : "live";
    ui.runResponseState.textContent = terminal ? "Response complete" : "Updating in real time";
    if (showMirror && ui.runResponseBody.textContent !== liveResponse) {
      ui.runResponseBody.textContent = liveResponse;
      ui.runResponseBody.scrollTop = ui.runResponseBody.scrollHeight;
    }
  }
  if (ui.runObjective) {
    ui.runObjective.hidden = true;
    ui.runObjective.textContent = "";
  }
}

async function refreshChat() {
  if (refreshingChat) return;
  refreshingChat = true;
  try {
    let rec = await record(workspace.lovableProjectId);
    rec = await restoreActiveConversation(rec);
    const conversation = active(rec);
    const tab = conversation ? await resolveTab(conversation) : null;
    const hasProject = Boolean(workspace.lovableProjectId);
    const connected = Boolean(conversation);
    const available = Boolean(tab);
    ui.setupCard.hidden = !hasProject || connected;
    ui.connectedCard.hidden = !hasProject || !connected;
    if (!hasProject) return;
    if (connected) {
      ui.chatState.textContent = available ? "Conversation locked" : "Conversation locked · open the correct conversation";
      ui.memoryState.textContent = displayConversationTitle(conversation, conversation.lockedTitle || conversation.title || "Conversation exclusive to this project");
    } else {
      const tabs = await chatTabs();
      ui.help.textContent = tabs.length ? "An open conversation was found. You can use it or create a new one." : "Open ChatGPT in a tab or create a new conversation here.";
    }
  } finally { refreshingChat = false; }
}

async function refreshRepository() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !workspace.lovableProjectId || !tab.url?.startsWith(activeBuilderPrefix())) return;
  renderWorkspace({ ...workspace, detecting: true });
  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: "LOVABURST_FORCE_REPOSITORY_REFRESH" });
    renderWorkspace({ repository: response?.repository || "", lovableProjectId: response?.lovableProjectId || workspace.lovableProjectId, sourceTitle: tab.title || "", sourceUrl: tab.url || "", platform: workspace.platform });
  } catch { await refreshWorkspace(); }
}

function waitForTabComplete(tabId, timeoutMs = 12000) {
  return new Promise((resolve) => {
    let settled = false;
    let timeout = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    };
    const onUpdated = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") finish();
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    timeout = setTimeout(finish, timeoutMs);
  });
}

async function reloadLovableAndExtensionUi() {
  if (!ui.refreshRepo || ui.refreshRepo.disabled) return;
  ui.refreshRepo.disabled = true;
  ui.refreshRepo.dataset.loading = "true";
  ui.refreshRepo.title = `Reloading ${activeBuilderName()} and LovaRPM…`;

  try {
    const tabs = await chrome.tabs.query({ url: [activeBuilderPattern()] });
    const tab = tabs.find((item) => workspace.lovableProjectId && item.url?.includes(workspace.lovableProjectId)) || tabs.find((item) => item.active) || tabs[0];
    if (!tab?.id) throw new Error(`Could not find a ${activeBuilderName()} tab to reload.`);

    await chrome.tabs.reload(tab.id);
    await waitForTabComplete(tab.id);
    window.location.reload();
  } catch (error) {
    ui.refreshRepo.disabled = false;
    delete ui.refreshRepo.dataset.loading;
    ui.refreshRepo.title = "Refresh workspace and integrations";
    showFeedback(error?.message || `Could not reload ${activeBuilderName()} and LovaRPM.`);
  }
}

function showFeedback(message, tone = "") {
  const text = String(message || "");
  if (!tone) {
    if (/error|failed|could not|couldn't|invalid|unavailable|permission|connect this project|erro|falha|não foi possível|não encontrei|inválid|indisponível|permissão|conecte este projeto/i.test(text)) tone = "error";
    else if (/sent|started|enhanced|updated|removed|success|complete|enviado|iniciad|aprimorado|atualizados|removida|sucesso|concluíd/i.test(text)) tone = "success";
    else tone = "info";
  }
  ui.feedback.hidden = false; ui.feedback.textContent = text; ui.feedback.dataset.tone = tone;
}
async function chooseChatTab() {
  const tabs = await chatTabs();
  if (!tabs.length) throw new Error("No ChatGPT conversations are open. Open a ChatGPT tab or create a new conversation.");

  const projectId = workspace.lovableProjectId;
  const all = await bindings();
  const ownership = new Map();
  for (const [ownerProjectId, rec] of Object.entries(all)) {
    for (const item of rec?.conversations || []) {
      const lockedUrl = String(item.lockedUrl || item.url || "").trim();
      if (lockedUrl && lockedUrl !== "https://chatgpt.com/") ownership.set(lockedUrl, ownerProjectId);
    }
  }

  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "lb-chat-picker";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.innerHTML = '<section class="lb-chat-picker-panel"><header><div><span>// CHATGPT</span><strong>Switch conversation</strong><p>Choose the conversation to reserve for this project.</p></div><button type="button" data-close aria-label="Close">×</button></header><div class="lb-chat-picker-list"></div><button type="button" class="lb-chat-picker-cancel" data-close>Cancel</button></section>';

    const list = overlay.querySelector(".lb-chat-picker-list");
    for (const tab of tabs) {
      const ownerProjectId = ownership.get(tab.url) || "";
      const unavailable = Boolean(ownerProjectId && ownerProjectId !== projectId);
      const button = document.createElement("button");
      button.type = "button";
      button.className = "lb-chat-picker-option";
      button.disabled = unavailable;

      const title = document.createElement("strong");
      title.textContent = tab.title || "ChatGPT";
      const url = document.createElement("span");
      url.textContent = tab.url === "https://chatgpt.com/" ? "New conversation without its own URL yet" : tab.url;
      const state = document.createElement("small");
      state.textContent = unavailable ? "Reserved for another project" : (tab.active ? "Active tab" : "Available");
      button.append(title, url, state);
      if (!unavailable) button.addEventListener("click", () => { overlay.remove(); resolve(tab); });
      list.append(button);
    }

    let settled = false;
    const cancel = () => {
      if (settled) return;
      settled = true;
      overlay.remove();
      resolve(null);
    };
    overlay.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", cancel));
    overlay.addEventListener("click", (event) => { if (event.target === overlay) cancel(); });
    document.body.append(overlay);
  });
}

async function useOpenConversation() {
  if (!workspace.lovableProjectId) throw new Error(`Open a ${activeBuilderName()} project first.`);
  const selected = await chooseChatTab();
  if (!selected?.tabId) return false;
  await linkTab(selected.tabId);
  return true;
}
async function openActiveConversation() {
  const rec = await record(workspace.lovableProjectId); const conversation = active(rec); if (!conversation) return;
  let tab = await resolveTab(conversation);
  if (!tab && conversation.url?.startsWith("https://chatgpt.com/")) {
    tab = await chrome.tabs.create({ url: conversation.url, active: true });
    await update(workspace.lovableProjectId, (current) => ({ ...current, conversations: current.conversations.map((item) => item.id === conversation.id ? { ...item, tabId: tab.id, url: tab.url || item.url, closedAt: "" } : item) }));
  }
  if (tab?.id) { await activateRelay(tab.id); await chrome.tabs.update(tab.id, { active: true }); }
}

function renderSendButton(sending = false) {
  ui.sendCommand.dataset.sending = String(sending);
  ui.sendCommand.innerHTML = sending
    ? '<span class="send-mark" aria-hidden="true">◌</span><b>Sending…</b><span class="send-arrow" aria-hidden="true">→</span>'
    : '<span class="send-mark" aria-hidden="true">✦</span><b>Send</b><span class="send-arrow" aria-hidden="true">➜</span>';
}

async function sendCommand() {
  if (globalThis.__LOVABURST_POPUP_ATTACHMENTS__?.hasFiles?.()) return;
  const objective = ui.commandInput.value.trim();
  if (!objective) { ui.commandInput.focus(); showFeedback("Enter what you want to change."); return; }
  if (!workspace.lovableProjectId) { showFeedback(`Open the ${activeBuilderName()} project you want to change.`); return; }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(workspace.repository || "").trim())) {
    showFeedback("Connect this project to GitHub to send requests through LovaRPM.", "error");
    return;
  }
  let rec = await record(workspace.lovableProjectId);
  if (!active(rec)) { showFeedback("Connect a ChatGPT conversation before sending."); ui.setupCard.hidden = false; return; }
  ui.sendCommand.disabled = true;
  renderSendButton(true);
  try {
    const tabs = await chrome.tabs.query({ url: [activeBuilderPattern()] });
    const source = tabs.find((tab) => tab.url?.includes(workspace.lovableProjectId)) || tabs[0];
    if (!source?.id) throw new Error(`Could not find this project's ${activeBuilderName()} tab.`);
    const skills = await selectedSkills();
    const response = await chrome.tabs.sendMessage(source.id, { type: "LOVABURST_SUBMIT_OBJECTIVE", objective, skills });
    if (!response?.ok) throw new Error(response?.error || "Could not send the request.");
    await update(workspace.lovableProjectId, (current) => {
      const previous = current.recentObjectives?.[current.recentObjectives.length - 1];
      const repeated = previous && String(previous.text || "") === objective && Date.now() - new Date(previous.createdAt || 0).getTime() < 30000;
      return repeated ? current : { ...current, recentObjectives: [...(current.recentObjectives || []), { text: objective, createdAt: now() }].slice(-50) };
    });
    ui.commandInput.value = ""; updateCounter(); ui.commandInput.dispatchEvent(new Event("input", { bubbles: true })); showFeedback("Sent to ChatGPT."); await refreshRunStatus();
  } catch (error) {
    const message = error?.message || String(error);
    showFeedback(/github|repository|repositório|no github|sem github|not connected|não conectado/i.test(message)
      ? "Connect this project to GitHub to send requests through LovaRPM."
      : message, /github|repository|repositório|no github|sem github|not connected|não conectado/i.test(message) ? "error" : "");
  }
  finally { renderSendButton(false); await renderConfig(await getConfig()); await refreshChat(); }
}

function updateCounter() { ui.commandCounter.textContent = ""; }

async function checkForBrowserManagedUpdate({ announce = false } = {}) {
  const version = chrome.runtime.getManifest().version; ui.version.classList.add("checking");
  try {
    if (typeof chrome.runtime.requestUpdateCheck !== "function") { if (announce) showFeedback(`You are using LovaRPM v${version}. Automatic updates will be available when the extension is on the official channel.`); return; }
    const result = await chrome.runtime.requestUpdateCheck(); const status = typeof result === "string" ? result : result?.status; const versionAvailable = typeof result === "object" ? result?.version : "";
    if (status === "update_available") { ui.version.classList.add("update"); ui.updateBanner.hidden = false; ui.updateTitle.textContent = versionAvailable ? `LovaRPM v${versionAvailable} available` : "New version available"; ui.updateText.textContent = "Chrome found an official update. The browser will install it."; return; }
    ui.version.classList.remove("update"); ui.updateBanner.hidden = true;
    if (announce) showFeedback(status === "throttled" ? `LovaRPM v${version}. Chrome has temporarily limited another check.` : `LovaRPM v${version}. No Chrome-managed update was found.`);
  } catch { if (announce) showFeedback(`LovaRPM v${version}. Updates are manual for this beta folder/ZIP installation.`); }
  finally { ui.version.classList.remove("checking"); }
}

async function findCurrentLovableTab() {
  const tabs = await chrome.tabs.query({ url: [activeBuilderPattern()] });
  return tabs.find((tab) => workspace.lovableProjectId && tab.url?.includes(workspace.lovableProjectId))
    || tabs.find((tab) => tab.active)
    || tabs[0]
    || null;
}

const HIDE_LOVABLE_BADGE_OBJECTIVE = `Add the following rule to src/index.css to hide the Lovable badge throughout the application:

/* Hide Lovable badge */
#lovable-badge {
  display: none !important;
}`;

async function hideLovableBadge() {
  if (workspace.platform === "base44") throw new Error("Removing platform branding is available only for Lovable projects.");
  if (!workspace.lovableProjectId) throw new Error("Open a Lovable project before removing its badge.");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(workspace.repository || "").trim())) {
    throw new Error("Connect this project to GitHub before removing its badge.");
  }
  const rec = await record(workspace.lovableProjectId);
  if (!active(rec)) throw new Error("Connect a ChatGPT conversation before removing the badge.");
  const tab = await findCurrentLovableTab();
  if (!tab?.id) throw new Error("Open a Lovable project before removing its badge.");
  const response = await chrome.tabs.sendMessage(tab.id, {
    type: "LOVABURST_SUBMIT_OBJECTIVE",
    objective: HIDE_LOVABLE_BADGE_OBJECTIVE,
    skills: [],
  });
  if (!response?.ok) throw new Error(response?.error || "Could not send the badge-removal request.");
  showFeedback("Badge-removal request sent to ChatGPT.");
}

async function downloadCurrentProject() {
  const repository = String(workspace.repository || "").trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error("Open a project connected to GitHub before downloading.");
  }
  const [owner, name] = repository.split("/");
  await chrome.downloads.download({
    url: `https://github.com/${owner}/${name}/archive/refs/heads/main.zip`,
    filename: `${name}-main.zip`,
    saveAs: true,
    conflictAction: "uniquify",
  });
  showFeedback("Project download started.");
}

async function renderConfig(config) { ui.enabled.checked = Boolean(config.enabled); ui.sendCommand.disabled = !config.enabled || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(workspace.repository || "").trim()) || ui.sendCommand.dataset.sending === "true"; }
ui.enabled.addEventListener("change", async () => { const config = await getConfig(); await renderConfig(await setConfig({ ...config, enabled: ui.enabled.checked })); });
ui.refreshRepo.addEventListener("click", (event) => { event.preventDefault(); event.stopImmediatePropagation(); void reloadLovableAndExtensionUi(); }, true);
ui.useOpen.addEventListener("click", async () => { ui.useOpen.disabled = true; ui.help.textContent = "Choose the conversation to reserve for this project."; try { const changed = await useOpenConversation(); if (changed) await refreshChat(); } catch (error) { ui.help.textContent = error?.message || String(error); } finally { ui.useOpen.disabled = false; } });
ui.create.addEventListener("click", async () => { ui.create.disabled = true; ui.help.textContent = "Creating and preparing the conversation…"; try { await newConversation(); await refreshChat(); } catch (error) { ui.help.textContent = error?.message || String(error); } finally { ui.create.disabled = false; } });
ui.open.addEventListener("click", async () => { try { await openActiveConversation(); } catch (error) { showFeedback(error?.message || String(error)); } });
ui.compactNew.addEventListener("click", async () => { ui.compactNew.disabled = true; try { await newConversation(); await refreshChat(); } catch (error) { showFeedback(error?.message || String(error)); } finally { ui.compactNew.disabled = false; } });
ui.useAnother.addEventListener("click", async () => {
  ui.useAnother.disabled = true;
  try {
    const changed = await useOpenConversation();
    if (changed) {
      await refreshChat();
      showFeedback("Conversation selected and locked exclusively to this project.", "success");
    }
  } catch (error) { showFeedback(error?.message || String(error)); }
  finally { ui.useAnother.disabled = false; }
});
ui.commandInput.addEventListener("input", updateCounter);
ui.commandInput.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
  event.preventDefault();
  ui.sendCommand.click();
});
ui.sendCommand.addEventListener("click", () => void sendCommand());
ui.version.addEventListener("click", () => void checkForBrowserManagedUpdate({ announce: true })); ui.footerVersion.addEventListener("click", () => void checkForBrowserManagedUpdate({ announce: true }));
const commandsTabButton = document.createElement("button");
commandsTabButton.className = "tab";
commandsTabButton.id = "commandsTabButton";
commandsTabButton.dataset.tab = "commands";
commandsTabButton.type = "button";
commandsTabButton.innerHTML = '<span class="tab-icon">⌘</span> Commands';
ui.skillsTab?.before(commandsTabButton);

const commandsPanel = document.createElement("div");
commandsPanel.className = "tab-panel";
commandsPanel.id = "commandsPanel";
commandsPanel.innerHTML = '<section class="commands-hero"><div class="commands-orb">⌘</div><div><span>// READY-MADE COMMANDS</span><h2>Choose what you would like to do.</h2><p>Selecting a command fills the prompt field with its full text so you can review and send it.</p></div></section><section class="commands-grid" id="commandsGrid"><button class="command-preset-card" data-command-file="corrigir" data-command-title="FIX" type="button"><span>FIX</span><div><strong>FIX</strong><small>Complete audit and bug fixes.</small></div><b>→</b></button><button class="command-preset-card" data-command-file="melhorar" data-command-title="IMPROVE" type="button"><span>UX</span><div><strong>IMPROVE</strong><small>In-depth improvement of the interface and experience.</small></div><b>→</b></button><button class="command-preset-card" data-command-file="otimizar" data-command-title="OPTIMIZE" type="button"><span>OPT</span><div><strong>OPTIMIZE</strong><small>Complete project optimization.</small></div><b>→</b></button><button class="command-preset-card" data-command-file="refatorar" data-command-title="REFACTOR" type="button"><span>REF</span><div><strong>REFACTOR</strong><small>Broad code review and refactoring.</small></div><b>→</b></button><button class="command-preset-card" data-command-file="responsivo" data-command-title="RESPONSIVE" type="button"><span>RWD</span><div><strong>RESPONSIVE</strong><small>Complete adaptation for all devices.</small></div><b>→</b></button><button class="command-preset-card" data-command-file="seguranca" data-command-title="SECURITY" type="button"><span>SEC</span><div><strong>SECURITY</strong><small>Security and database audit.</small></div><b>→</b></button></section><div class="commands-feedback" id="commandsFeedback" role="status" aria-live="polite">Select a command to prepare it in the prompt.</div>';
const extraCommands = [
  ["futurista-uma-cor", "FUTURISTIC ONE COLOR", "3D", "FUTURISTIC — ONE COLOR", "Futuristic 3D sidebar with a predominantly single-color identity."],
  ["botoes-coloridos", "COLORFUL BUTTONS", "RGB", "BUTTONS IN DIFFERENT COLORS", "Futuristic sidebar with a distinct vibrant color for each button."],
];
const commandsGrid = commandsPanel.querySelector("#commandsGrid");
for (const [file, title, icon, name, description] of extraCommands) {
  const card = document.createElement("button");
  card.className = "command-preset-card";
  card.dataset.commandFile = file;
  card.dataset.commandTitle = title;
  card.type = "button";
  card.innerHTML = `<span>${icon}</span><div><strong>${name}</strong><small>${description}</small></div><b>→</b>`;
  commandsGrid.append(card);
}
ui.skillsPanel?.before(commandsPanel);

ui.chatTab?.addEventListener("click", () => setTab("chat")); commandsTabButton.addEventListener("click", () => setTab("commands")); ui.skillsTab?.addEventListener("click", () => setTab("skills")); ui.historyTab?.addEventListener("click", () => setTab("history"));
document.querySelectorAll("[data-command-file]").forEach((card) => {
  card.addEventListener("click", async () => {
    const feedback = document.getElementById("commandsFeedback");
    const cards = [...document.querySelectorAll("[data-command-file]")];
    cards.forEach((item) => { item.disabled = true; });
    feedback.textContent = "Loading command…";
    try {
      const response = await chrome.runtime.sendMessage({
        type: "LOVARPM_COMMAND_GET",
        commandId: card.dataset.commandFile,
      });
      if (!response?.ok) throw new Error(response?.error || "Command not authorized.");
      const prompt = String(response.command?.prompt || "").trim();
      if (!prompt) throw new Error("The selected command is empty.");
      ui.commandInput.value = prompt;
      ui.commandInput.dispatchEvent(new Event("input", { bubbles: true }));
      setTab("chat");
      ui.commandInput.focus();
      ui.commandInput.setSelectionRange(0, 0);
      ui.commandInput.scrollTop = 0;
      showFeedback(`${card.dataset.commandTitle} command is ready to review and send.`, "success");
    } catch (error) {
      feedback.textContent = error?.message || "Could not load the command.";
    } finally {
      cards.forEach((item) => { item.disabled = false; });
    }
  });
});
document.getElementById("chatConnectedCard")?.querySelector(".connected-main")?.addEventListener("click", () => { const card = document.getElementById("chatConnectedCard"); if (card) card.dataset.actionsOpen = card.dataset.actionsOpen === "true" ? "false" : "true"; });
const additionalSkills = [
  ["accessibility-wcag", "A11Y", "Accessibility (WCAG)", "WCAG 2.1 AA, semantics, keyboard access, contrast, and ARIA."],
  ["agent-ui-design", "AGENT", "Agent UI Design", "Complete interfaces for agents, chat, and tools."],
  ["ai-design-workflow", "AI", "AI Design Workflow", "AI in the design process with human validation."],
  ["audit-code-quality", "CODE", "Audit Code Quality", "Structural quality, duplication, and code maintainability."],
  ["audit-cost-explosion", "COST", "Audit Cost Explosion", "Cost risks involving APIs, databases, uploads, and functions."],
  ["audit-legal-risks", "LAW", "Audit Legal Risks", "Privacy, terms, LGPD/GDPR, and intellectual property."],
  ["audit-monitoring-recovery", "OPS", "Audit Monitoring & Recovery", "Observability, errors, uptime, backups, and recovery."],
  ["audit-secrets-data-leaks", "LEAK", "Audit Secrets & Data Leaks", "Exposed secrets, RLS, Storage, and sensitive data."],
  ["audit-unauthorized-access", "AUTH", "Audit Unauthorized Access", "Authentication, authorization, IDOR, and access validation."],
  ["branding-identity", "BRAND", "Branding & Identity", "Brand, visual identity, and corporate consistency."],
  ["cloud-migration", "CLOUD", "Cloud Migration", "Full migration of Supabase Cloud and its services."],
  ["color-theory", "COLOR", "Color Theory", "Color, contrast, tokens, harmony, and dark mode."],
  ["component-patterns", "COMP", "Component Patterns", "Modern architecture, composition, tokens, and variants."],
  ["customer-journey", "CX", "Customer Journey", "Journey, touchpoints, emotions, personas, and retention."],
  ["design-process", "FLOW", "Design Process", "The full process from brief to handoff."],
  ["design-system-pro", "DS", "Design System Pro", "A complete, justified design system for the project."],
  ["ux-design", "UX", "UX Design", "Strategy, research, personas, flows, and essential UX principles."],
  ["vibe-security-check", "VSEC", "Vibe Security Check", "OWASP audit, vulnerability fixes, and reporting."],
  ["visual-direction", "ART", "Visual Direction", "Visual direction, palettes, typography, layouts, and imagery."],
  ["web-typography", "TYPE", "Web Typography", "Scale, hierarchy, readability, and font loading."],
  ["webdesign-review", "REVIEW", "Webdesign Review", "A comprehensive, coordinated review of web design areas."],
  ["website-audit-relaunch", "RELAUNCH", "Website Audit & Relaunch", "Technical, UX, content, SEO, and conversion audit."],
  ["design-trends-2026", "2026", "Design Trends 2026", "Motion, expressive typography, dark mode, and storytelling."],
  ["images-media", "MEDIA", "Images & Media", "Media selection, optimization, accessibility, and performance."],
  ["landing-pages", "LAND", "Landing Pages", "Structure, copy, CTAs, and conversion-oriented testing."],
  ["navigation-design", "NAV", "Navigation Design", "Menus, breadcrumbs, search, and mobile and desktop navigation."],
  ["responsive-design", "RWD", "Responsive Design", "Mobile-first layouts, fluid grids, and touch interaction."],
  ["ui-design", "UI", "UI Design", "Grid, spacing, hierarchy, tokens, and visual consistency."],
  ["ui-patterns", "PAT", "UI Patterns", "Ready-made patterns for heroes, cards, forms, pricing, and CTAs."],
  ["usability", "USE", "Usability", "Nielsen heuristics, ISO 9241, and reduced friction."],
];
const skillsGrid = document.getElementById("skillsGrid");
if (skillsGrid) {
  const divider = document.createElement("div");
  divider.className = "skill-library-divider";
  divider.innerHTML = "<span>MORE SKILLS</span><small>Additional specialists for your workflow</small>";
  skillsGrid.append(divider);
  for (const [id, icon, name, description] of additionalSkills) {
    const card = document.createElement("button");
    card.className = "skill-card";
    card.dataset.skill = id;
    card.type = "button";
    card.innerHTML = `<span>${icon}</span><div><strong>${name}</strong><small>${description}</small></div><i></i>`;
    skillsGrid.append(card);
  }
}
document.querySelectorAll("[data-skill]").forEach((card) => { card.addEventListener("click", async () => { if (!workspace.lovableProjectId) { showFeedback(`Open a ${activeBuilderName()} project before selecting Skills.`); return; } const ids = await selectedSkills(); const id = card.dataset.skill; const next = ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id]; await saveSelectedSkills(next); await renderSkills(); }); });
ui.platformButtons.forEach((button) => button.addEventListener("click", async () => {
  await selectPlatform(button.dataset.platform);
  await refreshWorkspace();
  await refreshChat();
  await refreshRunStatus();
}));
ui.clearSkills?.addEventListener("click", async () => { await saveSelectedSkills([]); await renderSkills(); });
ui.refreshData?.addEventListener("click", async () => { await refreshRepository(); await refreshChat(); await refreshRunStatus(); await renderSkills(); showFeedback("Data updated."); });
ui.settings?.addEventListener("click", () => showFeedback("Advanced settings are part of LovaRPM's commercial tier."));
ui.hideBadge?.addEventListener("click", async () => {
  ui.hideBadge.disabled = true;
  try { await hideLovableBadge(); } catch (error) { showFeedback(error?.message || String(error)); }
  finally { ui.hideBadge.disabled = false; }
});
ui.downloadProject?.addEventListener("click", async () => {
  ui.downloadProject.disabled = true;
  try { await downloadCurrentProject(); } catch (error) { showFeedback(error?.message || String(error)); }
  finally { ui.downloadProject.disabled = false; }
});
const footerIcons = { refreshDataButton: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 0 0-14.9-3M4 5v4h4M4 13a8 8 0 0 0 14.9 3M20 19v-4h-4"/></svg>', hideLovableBadgeButton: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 2.6 5.4L20 11l-5.4 2.6L12 19l-2.6-5.4L4 11l5.4-2.6L12 3Z"/></svg>', downloadProjectButton: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m0 0 4-4m-4 4-4-4M5 21h14"/></svg>', settingsButton: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4Z"/><path d="m19.4 15 .1.1-1.7 2.9-.2-.1-2.1-1.2a7.4 7.4 0 0 1-1.6.9L13.6 20H10.4l-.3-2.4a7.4 7.4 0 0 1-1.6-.9l-2.1 1.2-.2.1-1.7-2.9.1-.1 2-1.4a7.2 7.2 0 0 1 0-1.8l-2-1.4-.1-.1 1.7-2.9.2.1 2.1 1.2a7.4 7.4 0 0 1 1.6-.9l.3-2.4h3.2l.3 2.4a7.4 7.4 0 0 1 1.6.9l2.1-1.2.2.1 1.7 2.9-.1.1-2 1.4a7.2 7.2 0 0 1 0 1.8l2 1.4Z"/></svg>' };
for (const [id, icon] of Object.entries(footerIcons)) { const button = document.getElementById(id); if (button) { const label = button.textContent.replace(/^[^\p{L}\p{N}]+/u, "").trim(); button.innerHTML = `${icon}<span>${label}</span>`; button.classList.add("lb-footer-control"); } }
chrome.tabs.onRemoved.addListener(async (tabId) => { const all = await bindings(); let changed = false; for (const rec of Object.values(all)) for (const item of rec?.conversations || []) if (item.tabId === tabId) { item.tabId = null; item.closedAt = now(); changed = true; } if (changed) await save(all); await refreshChat(); });
chrome.tabs.onUpdated.addListener(async (_tabId, changeInfo) => {
  // A conversa vinculada é uma identidade imutável. Navegar para outro chat na
  // mesma aba física nunca pode reescrever URL/título do vínculo salvo.
  if (changeInfo.url || changeInfo.status === "complete" || changeInfo.title) {
    await refreshWorkspace();
    await refreshChat();
  }
});
chrome.tabs.onActivated.addListener(async () => { await refreshWorkspace(); await refreshChat(); });
chrome.storage.onChanged.addListener((changes, area) => { if (area !== "local") return; if (changes.config?.newValue) void renderConfig(changes.config.newValue); if (changes.workspaceBindings || changes.pendingPrompt) void refreshWorkspace(); if (changes.projectChatBindings) void refreshChat(); if (changes.projectRunStatuses) void refreshRunStatus(); if (changes.projectSkillSelections) void renderSkills(); });
window.setInterval(() => void refreshWorkspace(), 900); window.setInterval(() => void refreshChat(), 1800);
(async () => { const version = chrome.runtime.getManifest().version; ui.versionText.textContent = `v${version}`; ui.footerVersion.textContent = `LovaRPM v${version}`; updateCounter(); renderSendButton(false); await selectPlatform(await selectedPlatform()); await renderConfig(await getConfig()); await refreshWorkspace(); await refreshChat(); await refreshRunStatus(); await checkForBrowserManagedUpdate(); })();
