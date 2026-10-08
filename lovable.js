(() => {
  if (window.__LOVABURST_LOVABLE_BRIDGE__) return;
  window.__LOVABURST_LOVABLE_BRIDGE__ = true;

  const SOURCE = "lovable";
  const BUTTON_ID = "lovaburst-capture-button";
  const STYLE_ID = "lovaburst-capture-style";
  const COMPOSER_SELECTORS = [
    "textarea[data-testid*='prompt']",
    "textarea[placeholder*='Ask' i]",
    "textarea[placeholder*='message' i]",
    "textarea[placeholder*='mensagem' i]",
    "textarea",
    "[contenteditable='true'][data-testid*='prompt']",
    "[contenteditable='true'][role='textbox']",
    "[contenteditable='true']",
  ];

  let composer = null;
  let observer = null;
  let scanTimer = null;

  function announceReady() {
    chrome.runtime.sendMessage({ type: "LOVABURST_PING", source: SOURCE }).catch(() => {});
  }

  function isVisible(element) {
    if (!(element instanceof HTMLElement)) return false;
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  }

  function readComposerText(element) {
    if (!element) return "";
    if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
      return element.value.trim();
    }
    return (element.innerText || element.textContent || "").trim();
  }

  function findComposer() {
    for (const selector of COMPOSER_SELECTORS) {
      const candidates = Array.from(document.querySelectorAll(selector));
      const candidate = candidates.find((element) => isVisible(element));
      if (candidate) return candidate;
    }
    return null;
  }

  function extractLovableProjectId() {
    return window.location.pathname.match(/\/projects\/([A-Za-z0-9-]+)/i)?.[1] || "";
  }

  function normalizeRepository(value) {
    const text = String(value || "").trim();
    const match = text.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/);
    if (!match) return "";

    const blocked = new Set([
      "settings", "marketplace", "features", "topics", "collections", "login", "signup",
      "projects", "project", "lovable", "api", "assets", "src", "public", "blob", "tree",
      "en", "docs",
    ]);

    const owner = match[1];
    const repo = match[2];
    if (blocked.has(owner.toLowerCase()) || blocked.has(repo.toLowerCase())) return "";
    if (owner.length < 2 || repo.length < 2) return "";
    return `${owner}/${repo}`;
  }

  function normalizeGithubRepository(value) {
    if (!value) return "";
    const raw = String(value).trim();

    const ssh = raw.match(/^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/i);
    if (ssh) return normalizeRepository(`${ssh[1]}/${ssh[2]}`);

    let url;
    try {
      url = new URL(raw, window.location.href);
    } catch {
      return "";
    }

    const host = url.hostname.toLowerCase();
    if (host !== "github.com" && host !== "www.github.com") return "";

    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 2) return "";
    return normalizeRepository(`${parts[0]}/${parts[1]}`);
  }

  function collectRepositoriesFromText(text, score, scored) {
    if (!text) return;

    const value = String(text).slice(0, 250000);
    const patterns = [
      /https?:\/\/(?:www\.)?github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?/gi,
      /git@github\.com:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?/gi,
    ];

    for (const pattern of patterns) {
      for (const match of value.match(pattern) || []) {
        const repo = normalizeGithubRepository(match);
        if (repo) scored.set(repo, Math.max(scored.get(repo) || 0, score));
      }
    }
  }

  function detectGithubRepository() {
    const projectId = extractLovableProjectId();
    const rootProject = document.documentElement?.dataset?.lovaburstRepositoryProject || "";
    const rootRepository = document.documentElement?.dataset?.lovaburstRepository || "";
    if (rootProject && rootProject === projectId && rootRepository) {
      const normalizedRoot = normalizeRepository(rootRepository);
      if (normalizedRoot) return normalizedRoot;
    }

    const diagnosticsRepo = resolveRepositoryFromDiagnostics();
    if (diagnosticsRepo) return diagnosticsRepo;

    const scored = new Map();
    const add = (value, score) => {
      const repo = normalizeGithubRepository(value);
      if (!repo) return;
      scored.set(repo, Math.max(scored.get(repo) || 0, score));
    };

    for (const anchor of document.querySelectorAll('a[href*="github.com/"], a[href^="git@github.com:"]')) {
      const label = `${anchor.textContent || ""} ${anchor.getAttribute("aria-label") || ""} ${anchor.getAttribute("title") || ""}`.toLowerCase();
      let score = 90;
      if (/repo|repository|repositório|github/.test(label)) score += 20;
      if (isVisible(anchor)) score += 10;
      add(anchor.href || anchor.getAttribute("href"), score);
    }

    for (const element of document.querySelectorAll('[data-testid*="github" i], [data-testid*="repo" i], [aria-label*="github" i], [aria-label*="repo" i], [title*="github" i], [title*="repo" i]')) {
      add(element.getAttribute("href"), 105);
      collectRepositoriesFromText(element.textContent, 85, scored);
      for (const attribute of element.attributes || []) collectRepositoriesFromText(attribute.value, 85, scored);
    }

    for (const meta of document.querySelectorAll("meta[content]")) {
      collectRepositoriesFromText(meta.content, 70, scored);
    }

    for (const script of document.querySelectorAll("script")) {
      const type = (script.type || "").toLowerCase();
      if (!type || type.includes("json") || type.includes("javascript")) {
        collectRepositoriesFromText(script.textContent, type.includes("json") ? 95 : 65, scored);
      }
    }

    try {
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index) || "";
        const value = localStorage.getItem(key) || "";
        const score = /github|repo|project|workspace/i.test(key) ? 110 : 75;
        collectRepositoriesFromText(`${key}:${value}`, score, scored);
      }
    } catch {}

    try {
      for (let index = 0; index < sessionStorage.length; index += 1) {
        const key = sessionStorage.key(index) || "";
        const value = sessionStorage.getItem(key) || "";
        const score = /github|repo|project|workspace/i.test(key) ? 105 : 70;
        collectRepositoriesFromText(`${key}:${value}`, score, scored);
      }
    } catch {}

    collectRepositoriesFromText(document.documentElement?.innerHTML, 55, scored);
    collectRepositoriesFromText(document.body?.innerText, 45, scored);

    return [...scored.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] || "";
  }

  function readApiDiagnostics() {
    try {
      const raw = document.documentElement?.dataset?.lovaburstApiDiagnostics || "[]";
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.slice(-24) : [];
    } catch {
      return [];
    }
  }

  function normalizeIdentity(value) {
    const text = String(value || "").trim();
    return /^[A-Za-z0-9_.-]{2,100}$/.test(text) ? text : "";
  }

  function resolveRepositoryFromDiagnostics(diagnostics = readApiDiagnostics()) {
    if (!Array.isArray(diagnostics)) return "";

    const gitsync = diagnostics
      .slice()
      .reverse()
      .find((entry) =>
        /\/gitsync\/?$/i.test(String(entry?.endpoint || "")) &&
        Array.isArray(entry?.gitsyncFields)
      );

    if (!gitsync) return "";

    const fields = new Map(
      gitsync.gitsyncFields
        .filter((field) =>
          typeof field?.path === "string" &&
          typeof field?.value === "string"
        )
        .map((field) => [field.path, field.value]),
    );

    const repoUrl = fields.get("config.repo_url") || "";
    const fromUrl = normalizeGithubRepository(repoUrl);
    if (fromUrl) return fromUrl;

    const owner = normalizeIdentity(fields.get("config.owner_name"));
    const repoName = normalizeIdentity(fields.get("config.repo_name"));

    return owner && repoName ? `${owner}/${repoName}` : "";
  }

  async function resolveWorkspace() {
    const lovableProjectId = extractLovableProjectId();
    const apiDiagnostics = readApiDiagnostics();
    const diagnosticsRepository = resolveRepositoryFromDiagnostics(apiDiagnostics);
    const domRepository = diagnosticsRepository || detectGithubRepository();
    const localSource = diagnosticsRepository
      ? "lovable-gitsync"
      : document.documentElement?.dataset?.lovaburstRepositorySource || (domRepository ? "isolated-dom" : "none");

    try {
      const response = await chrome.runtime.sendMessage({
        type: "LOVABURST_DETECT_WORKSPACE",
        payload: {
          lovableProjectId,
          url: window.location.href,
          domRepository,
        },
      });

      const repository = response?.repository || domRepository || "";

      return {
        lovableProjectId,
        repository,
        detectionSource:
          repository === diagnosticsRepository && diagnosticsRepository
            ? "lovable-gitsync"
            : response?.source || localSource,
        apiDiagnostics,
      };
    } catch {
      return {
        lovableProjectId,
        repository: domRepository,
        detectionSource: localSource,
        apiDiagnostics,
      };
    }
  }

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${BUTTON_ID} {
        position: fixed;
        z-index: 2147483646;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 7px;
        min-height: 34px;
        padding: 0 12px;
        border: 1px solid rgba(255,255,255,.18);
        border-radius: 10px;
        background: #111318;
        color: #fff;
        box-shadow: 0 8px 28px rgba(0,0,0,.24);
        font: 600 12px/1 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
        cursor: pointer;
        transition: transform .15s ease, opacity .15s ease, border-color .15s ease;
      }
      #${BUTTON_ID}:hover { transform: translateY(-1px); border-color: rgba(255,255,255,.35); }
      #${BUTTON_ID}:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
      #${BUTTON_ID}[disabled] { opacity: .55; cursor: not-allowed; transform: none; }
      #${BUTTON_ID}[data-state="sent"] { border-color: rgba(126,231,135,.6); }
      #${BUTTON_ID}[data-state="error"] { border-color: rgba(255,123,114,.7); }
    `;
    document.documentElement.appendChild(style);
  }

  function positionButton(button) {
    if (!composer || !isVisible(composer)) {
      button.hidden = true;
      return;
    }

    const rect = composer.getBoundingClientRect();
    button.hidden = false;
    button.style.left = `${Math.max(8, Math.min(window.innerWidth - button.offsetWidth - 8, rect.right - button.offsetWidth))}px`;
    button.style.top = `${Math.max(8, rect.top - button.offsetHeight - 8)}px`;
  }

  function resetButton(button) {
    button.dataset.state = "";
    button.textContent = "Send via LovaRPM";
    button.title = "";
    button.disabled = false;
  }

  async function rememberObjectiveForProject(workspace, text) {
    const projectId = workspace?.lovableProjectId || "";
    if (!projectId || !text) return;

    const stored = await chrome.storage.local.get("projectChatBindings");
    const bindings = stored.projectChatBindings || {};
    const current = bindings[projectId] || {
      projectId,
      activeConversationId: "",
      conversations: [],
      recentObjectives: [],
    };
    const recentObjectives = Array.isArray(current.recentObjectives)
      ? [...current.recentObjectives]
      : [];
    const last = recentObjectives[recentObjectives.length - 1];

    if (!last || last.text !== text) {
      recentObjectives.push({ text: text.slice(0, 700), capturedAt: new Date().toISOString() });
    }

    bindings[projectId] = {
      ...current,
      projectId,
      repository: workspace.repository || current.repository || "",
      sourceTitle: document.title || current.sourceTitle || "",
      sourceUrl: window.location.href,
      recentObjectives: recentObjectives.slice(-12),
      updatedAt: new Date().toISOString(),
    };
    await chrome.storage.local.set({ projectChatBindings: bindings });
  }

  async function activateProjectChat(workspace) {
    const projectId = workspace?.lovableProjectId || "";
    if (!projectId) throw new Error("Could not identify the Lovable project.");

    const stored = await chrome.storage.local.get("projectChatBindings");
    const record = stored.projectChatBindings?.[projectId];
    const conversation = record?.conversations?.find(
      (item) => item.id === record.activeConversationId,
    );

    if (!conversation?.tabId) {
      throw new Error(
        "This project does not yet have an active ChatGPT conversation. Open the LovaRPM panel and link or create a conversation.",
      );
    }

    const response = await chrome.runtime.sendMessage({
      type: "LOVABURST_LINK_CHATGPT",
      tabId: conversation.tabId,
    });

    if (!response?.ok) {
      throw new Error(
        response?.error ||
          "This project's conversation is unavailable. Open the LovaRPM panel and select another conversation.",
      );
    }
  }

  async function capturePrompt(button) {
    const text = readComposerText(composer);
    if (!text) {
      button.textContent = "Enter a prompt first";
      button.disabled = true;
      window.setTimeout(() => resetButton(button), 1400);
      return;
    }

    button.disabled = true;
    button.textContent = "Detecting project…";

    try {
      const workspace = await resolveWorkspace();
      button.textContent = workspace.repository ? `Sending · ${workspace.repository}` : "Sending to ChatGPT…";

      await rememberObjectiveForProject(workspace, text);
      await activateProjectChat(workspace);

      const response = await chrome.runtime.sendMessage({
        type: "LOVABURST_PROMPT_CAPTURED",
        source: SOURCE,
        payload: {
          text,
          url: window.location.href,
          title: document.title,
          capturedAt: new Date().toISOString(),
          repository: workspace.repository,
          lovableProjectId: workspace.lovableProjectId,
          repositoryDetectionSource: workspace.detectionSource,
          apiDiagnostics: workspace.apiDiagnostics,
        },
      });

      if (!response?.ok) throw new Error(response?.error || "Failed to send the prompt.");

      button.dataset.state = "sent";
      button.textContent = workspace.repository ? `Sent · ${workspace.repository} ✓` : "Sent to ChatGPT ✓";
      window.setTimeout(() => resetButton(button), 2200);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const needsChat =
        message.includes("This project does not yet have an active ChatGPT conversation") ||
        message.includes("This project's conversation is unavailable") ||
        message.includes("ainda não possui uma conversa ativa do ChatGPT") ||
        message.includes("conversa deste projeto não está disponível");

      if (needsChat) {
        button.dataset.state = "needs-chat";
        button.textContent = "Connect ChatGPT";
        button.title = "Open the LovaRPM panel to create or connect a conversation to this project.";
        window.setTimeout(() => resetButton(button), 4200);
        return;
      }

      button.dataset.state = "error";
      button.textContent = "Send failed";
      button.title = message;
      console.error("[LovaRPM] Falha inesperada ao enviar o prompt:", error);
      window.setTimeout(() => resetButton(button), 2600);
    }
  }

  function ensureCaptureButton() {
    ensureStyles();
    let button = document.getElementById(BUTTON_ID);

    if (!button) {
      button = document.createElement("button");
      button.id = BUTTON_ID;
      button.type = "button";
      button.textContent = "Send via LovaRPM";
      button.setAttribute("aria-label", "Send this prompt to ChatGPT through LovaRPM");
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        capturePrompt(button);
      });
      document.documentElement.appendChild(button);
    }

    positionButton(button);
  }

  function scanForComposer() {
    const nextComposer = findComposer();
    if (nextComposer !== composer) composer = nextComposer;
    ensureCaptureButton();
  }

  function scheduleScan() {
    window.clearTimeout(scanTimer);
    scanTimer = window.setTimeout(scanForComposer, 120);
  }

  function startObserver() {
    observer = new MutationObserver(scheduleScan);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    window.addEventListener("resize", scheduleScan, { passive: true });
    window.addEventListener("scroll", scheduleScan, { passive: true, capture: true });
    scanForComposer();
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "LOVABURST_HIDE_LOVABLE_BADGE") {
      const styleId = "lovaburst-hide-lovable-badge";
      let style = document.getElementById(styleId);
      if (!style) {
        style = document.createElement("style");
        style.id = styleId;
        style.textContent = "#lovable-badge { display: none !important; }";
        (document.head || document.documentElement).appendChild(style);
      }
      sendResponse({ ok: true });
      return false;
    }

    if (message?.type === "LOVABURST_FORCE_REPOSITORY_REFRESH") {
      document.dispatchEvent(new CustomEvent("lovaburst-force-repository-refresh"));
      window.setTimeout(() => {
        resolveWorkspace()
          .then((workspace) => sendResponse({ ok: true, ...workspace }))
          .catch((error) => sendResponse({ ok: false, error: String(error) }));
      }, 850);
      return true;
    }

    if (message?.type === "LOVABURST_CONTENT_PING") {
      resolveWorkspace()
        .then((workspace) => sendResponse({
          ok: true,
          source: SOURCE,
          url: window.location.href,
          composerDetected: Boolean(composer),
          repository: workspace.repository,
          repositoryDetectionSource: workspace.detectionSource,
          lovableProjectId: workspace.lovableProjectId,
        }))
        .catch(() => sendResponse({
          ok: true,
          source: SOURCE,
          url: window.location.href,
          composerDetected: Boolean(composer),
          repository: detectGithubRepository(),
          lovableProjectId: extractLovableProjectId(),
        }));
      return true;
    }

    if (message?.type === "LOVABURST_SUBMIT_OBJECTIVE") {
      const objective = String(message.objective || "").trim();
      const skills = Array.isArray(message.skills)
        ? message.skills.filter((skill) => typeof skill === "string" && /^[a-z0-9-]{2,40}$/i.test(skill)).slice(0, 42)
        : [];

      if (!objective) {
        sendResponse({ ok: false, error: "Enter what you want to change." });
        return false;
      }

      Promise.resolve()
        .then(async () => {
          const workspace = await resolveWorkspace();

          await rememberObjectiveForProject(workspace, objective);
          await activateProjectChat(workspace);

          const response = await chrome.runtime.sendMessage({
            type: "LOVABURST_PROMPT_CAPTURED",
            source: SOURCE,
            payload: {
              text: objective,
              url: window.location.href,
              title: document.title,
              capturedAt: new Date().toISOString(),
              repository: workspace.repository,
              lovableProjectId: workspace.lovableProjectId,
              repositoryDetectionSource: workspace.detectionSource,
              apiDiagnostics: workspace.apiDiagnostics,
              skills,
            },
          });

          if (!response?.ok) {
            throw new Error(response?.error || "Falha ao enviar o prompt.");
          }

          return response;
        })
        .then(() => sendResponse({ ok: true }))
        .catch((error) =>
          sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          })
        );

      return true;
    }

    return false;
  });

  announceReady();
  startObserver();
})();
