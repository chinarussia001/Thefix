(() => {
  if (window.__LOVARPM_BASE44_BRIDGE__) return;
  window.__LOVARPM_BASE44_BRIDGE__ = true;

  const SOURCE = "base44";
  const PROJECT_RE = /\/apps\/([A-Za-z0-9-]+)/i;

  function projectId() {
    return location.pathname.match(PROJECT_RE)?.[1] || "";
  }

  function normalizeRepository(value) {
    const raw = String(value || "").trim();
    const match = raw.match(/(?:https?:\/\/(?:www\.)?github\.com\/|git@github\.com:)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:[/?#].*)?$/i);
    if (!match) return "";
    const blocked = new Set(["settings", "marketplace", "features", "login", "signup", "apps", "app", "base44", "api", "assets", "src", "public", "blob", "tree"]);
    if (blocked.has(match[1].toLowerCase()) || blocked.has(match[2].toLowerCase())) return "";
    return `${match[1]}/${match[2]}`;
  }

  function detectRepository() {
    const root = document.documentElement;
    const probedProject = root?.dataset?.lovarpmBase44RepositoryProject || "";
    const probedRepository = normalizeRepository(root?.dataset?.lovarpmBase44Repository || "");
    if (probedProject === projectId() && probedRepository) return probedRepository;
    const scored = new Map();
    const add = (value, score) => {
      const repo = normalizeRepository(value);
      if (repo) scored.set(repo, Math.max(scored.get(repo) || 0, score));
    };
    const collect = (value, score) => {
      const text = String(value || "").slice(0, 250000);
      for (const match of text.match(/https?:\/\/(?:www\.)?github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?/gi) || []) add(match, score);
      for (const match of text.match(/git@github\.com:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?/gi) || []) add(match, score);
    };
    for (const anchor of document.querySelectorAll('a[href*="github.com/"],a[href^="git@github.com:"]')) add(anchor.href || anchor.getAttribute("href"), 140);
    for (const element of document.querySelectorAll('[data-testid*="github" i],[data-testid*="repo" i],[aria-label*="github" i],[aria-label*="repo" i],[title*="github" i],[title*="repo" i]')) {
      add(element.getAttribute("href"), 125);
      collect(element.textContent, 105);
    }
    try { for (let i = 0; i < localStorage.length; i += 1) { const key = localStorage.key(i) || ""; collect(`${key}:${localStorage.getItem(key) || ""}`, /github|repo|app|project/i.test(key) ? 115 : 70); } } catch {}
    try { for (let i = 0; i < sessionStorage.length; i += 1) { const key = sessionStorage.key(i) || ""; collect(`${key}:${sessionStorage.getItem(key) || ""}`, /github|repo|app|project/i.test(key) ? 110 : 65); } } catch {}
    collect(document.documentElement?.innerHTML, 50);
    return [...scored.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "";
  }

  async function workspace() {
    const lovableProjectId = projectId();
    const domRepository = detectRepository();
    try {
      const response = await chrome.runtime.sendMessage({
        type: "LOVABURST_DETECT_WORKSPACE",
        payload: { lovableProjectId, platform: SOURCE, url: location.href, domRepository },
      });
      return { lovableProjectId, platform: SOURCE, repository: response?.repository || domRepository || "", detectionSource: response?.source || (domRepository ? "base44-dom" : "none") };
    } catch {
      return { lovableProjectId, platform: SOURCE, repository: domRepository, detectionSource: domRepository ? "base44-dom" : "none" };
    }
  }

  async function rememberObjective(current, text) {
    if (!current.lovableProjectId || !text) return;
    const stored = await chrome.storage.local.get("projectChatBindings");
    const bindings = stored.projectChatBindings || {};
    const record = bindings[current.lovableProjectId] || { projectId: current.lovableProjectId, conversations: [], recentObjectives: [], activeConversationId: "" };
    const recent = Array.isArray(record.recentObjectives) ? [...record.recentObjectives] : [];
    if (recent.at(-1)?.text !== text) recent.push({ text: text.slice(0, 700), createdAt: new Date().toISOString() });
    bindings[current.lovableProjectId] = { ...record, platform: SOURCE, repository: current.repository || record.repository || "", sourceTitle: document.title, sourceUrl: location.href, recentObjectives: recent.slice(-50), updatedAt: new Date().toISOString() };
    await chrome.storage.local.set({ projectChatBindings: bindings });
  }

  async function activateChat(current) {
    const stored = await chrome.storage.local.get("projectChatBindings");
    const record = stored.projectChatBindings?.[current.lovableProjectId];
    const conversation = record?.conversations?.find((item) => item.id === record.activeConversationId);
    if (!conversation?.tabId) throw new Error("This project does not yet have an active ChatGPT conversation. Open the LovaRPM panel and connect one.");
    const response = await chrome.runtime.sendMessage({ type: "LOVABURST_LINK_CHATGPT", tabId: conversation.tabId });
    if (!response?.ok) throw new Error(response?.error || "The linked conversation is unavailable.");
  }

  async function submitObjective(objective, skills) {
    const current = await workspace();
    if (!current.lovableProjectId) throw new Error("Could not identify the Base44 app.");
    await rememberObjective(current, objective);
    await activateChat(current);
    const response = await chrome.runtime.sendMessage({
      type: "LOVABURST_PROMPT_CAPTURED",
      source: SOURCE,
      payload: { text: objective, url: location.href, title: document.title, capturedAt: new Date().toISOString(), repository: current.repository, lovableProjectId: current.lovableProjectId, platform: SOURCE, repositoryDetectionSource: current.detectionSource, skills },
    });
    if (!response?.ok) throw new Error(response?.error || "Falha ao enviar o pedido.");
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "LOVABURST_CONTENT_PING") {
      workspace().then((current) => sendResponse({ ok: true, source: SOURCE, ...current, url: location.href, composerDetected: Boolean(globalThis.__LOVABURST_COMPOSER_CORE__?.state?.composer) })).catch((error) => sendResponse({ ok: false, source: SOURCE, error: String(error) }));
      return true;
    }
    if (message?.type === "LOVABURST_FORCE_REPOSITORY_REFRESH") {
      document.documentElement.dispatchEvent(new CustomEvent("lovarpm-base44-force-repository-refresh"));
      setTimeout(() => workspace().then((current) => sendResponse({ ok: true, ...current })).catch((error) => sendResponse({ ok: false, error: String(error) })), 900);
      return true;
    }
    if (message?.type === "LOVABURST_SUBMIT_OBJECTIVE") {
      const objective = String(message.objective || "").trim();
      const skills = Array.isArray(message.skills) ? message.skills.filter((item) => typeof item === "string").slice(0, 42) : [];
      if (!objective) { sendResponse({ ok: false, error: "Enter what you want to change." }); return false; }
      submitObjective(objective, skills).then(() => sendResponse({ ok: true })).catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
      return true;
    }
    return false;
  });

  chrome.runtime.sendMessage({ type: "LOVABURST_PING", source: SOURCE }).catch(() => {});
})();
