(() => {
  if (window.__LOVABURST_CHATGPT_ACTIVITY_V0307__) return;
  window.__LOVABURST_CHATGPT_ACTIVITY_V0307__ = true;
  window.__LOVABURST_CHATGPT_ACTIVITY__ = true;

  const KEY = "projectRunStatuses";
  const PROJECT_RE = /(?:LOVABLE_PROJECT|BASE44_APP):\s*([A-Za-z0-9-]+)/i;
  const REQUEST_MARKERS = ["[LOVABURST_REQUEST_V3]", "[LOVABURST_REQUEST_V2]", "[LOVABURST_REQUEST_V1]", "[LOVARPM_REQUEST_V3]", "[LOVARPM_REQUEST_V2]", "[LOVARPM_REQUEST_V1]"];
  const isLovaRPMRequest = (text) => REQUEST_MARKERS.some((marker) => String(text || "").includes(marker));
  const ACTION_RE = /^(implementando|analisando|validando|verificando|lendo|pesquisando|atualizando|criando|editando|preparando|processando|reviewing|implementing|analyzing|analysing|validating|checking|reading|searching|updating|creating|editing|preparing|processing)\b/i;
  const SECRET_RE = /(service[_ -]?role|database password|access token|refresh token|private key|secret key|bearer\s+[a-z0-9._-]+)/i;

  let timer = null;
  let observer = null;
  let stopped = false;
  let lastSignature = "";

  function contextAvailable() {
    if (stopped) return false;
    try {
      return Boolean(globalThis.chrome?.runtime?.id && globalThis.chrome?.storage?.local);
    } catch {
      return false;
    }
  }

  function stopAfterContextInvalidation() {
    if (stopped) return;
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
    observer?.disconnect();
    observer = null;
  }

  function runtimeFailed() {
    try {
      const message = String(globalThis.chrome?.runtime?.lastError?.message || "").toLowerCase();
      if (message.includes("extension context invalidated") || message.includes("context invalidated")) {
        stopAfterContextInvalidation();
        return true;
      }
      return Boolean(message);
    } catch {
      stopAfterContextInvalidation();
      return true;
    }
  }

  function safeStorageGet(key, callback) {
    if (!contextAvailable()) {
      stopAfterContextInvalidation();
      return;
    }
    try {
      chrome.storage.local.get(key, (stored) => {
        if (runtimeFailed() || !contextAvailable()) return;
        callback(stored || {});
      });
    } catch {
      stopAfterContextInvalidation();
    }
  }

  function safeStorageSet(value) {
    if (!contextAvailable()) {
      stopAfterContextInvalidation();
      return;
    }
    try {
      chrome.storage.local.set(value, () => {
        runtimeFailed();
      });
    } catch {
      stopAfterContextInvalidation();
    }
  }

  function visible(el) {
    if (!(el instanceof HTMLElement) || !el.isConnected) return false;
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 4 && rect.height > 4;
  }

  function latestProjectId() {
    const users = [...document.querySelectorAll('[data-message-author-role="user"]')].reverse();
    for (const el of users) {
      const text = String(el.innerText || el.textContent || "");
      if (!isLovaRPMRequest(text)) continue;
      const match = text.match(PROJECT_RE);
      if (match?.[1]) return match[1];
    }
    return "";
  }

  function hasFinalMarker(projectId) {
    const messages = [...document.querySelectorAll('[data-message-author-role="user"], [data-message-author-role="assistant"]')];
    let requestIndex = -1;
    for (let index = 0; index < messages.length; index += 1) {
      const element = messages[index];
      if (element.getAttribute("data-message-author-role") !== "user") continue;
      const text = String(element.innerText || element.textContent || "");
      if (isLovaRPMRequest(text) && text.match(PROJECT_RE)?.[1] === projectId) requestIndex = index;
    }
    if (requestIndex < 0) return false;
    return messages.slice(requestIndex + 1).some((element) => {
      if (element.getAttribute("data-message-author-role") !== "assistant") return false;
      const text = String(element.innerText || element.textContent || "");
      return /\[LOVABURST_(DONE|BLOCKED|ERROR)\]/.test(text);
    });
  }

  function clean(value) {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    if (text.length < 5 || text.length > 220 || SECRET_RE.test(text) || !ACTION_RE.test(text)) return "";
    return text.slice(0, 180);
  }

  function findActivity() {
    const preferred = [...document.querySelectorAll('[role="status"],[aria-live="polite"],[aria-live="assertive"]')].reverse();
    for (const el of preferred) {
      if (!visible(el) || el.closest('[data-message-author-role]') || el.closest("form")) continue;
      const text = clean(el.innerText || el.textContent);
      if (text) return text;
    }

    const candidates = [...document.querySelectorAll("main span, main p, main div")].reverse();
    let checked = 0;
    for (const el of candidates) {
      if (checked++ > 500) break;
      if (!visible(el) || el.children.length > 2 || el.closest('[data-message-author-role]') || el.closest("form")) continue;
      const text = clean(el.innerText || el.textContent);
      if (text) return text;
    }
    return "";
  }

  function scan() {
    if (!contextAvailable()) {
      stopAfterContextInvalidation();
      return;
    }

    const projectId = latestProjectId();
    if (!projectId) return;
    if (hasFinalMarker(projectId)) return;
    const activityText = findActivity();
    if (!activityText) return;

    safeStorageGet(KEY, (stored) => {
      const statuses = stored[KEY] || {};
      const previous = statuses[projectId] || {};
      if (!["sending", "working"].includes(String(previous.status || ""))) return;

      const signature = `${projectId}|${activityText}|${previous.status}`;
      if (signature === lastSignature || previous.activityText === activityText) return;
      lastSignature = signature;

      safeStorageSet({
        [KEY]: {
          ...statuses,
          [projectId]: {
            ...previous,
            projectId,
            activityText,
            activitySource: "chatgpt-visible-status",
            activityUpdatedAt: new Date().toISOString(),
          },
        },
      });
    });
  }

  function schedule() {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      scan();
    }, 120);
  }

  function start() {
    if (!contextAvailable()) {
      stopAfterContextInvalidation();
      return;
    }
    const root = document.body || document.documentElement;
    if (!root) {
      timer = setTimeout(start, 250);
      return;
    }
    observer = new MutationObserver(schedule);
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    schedule();
  }

  start();
})();
