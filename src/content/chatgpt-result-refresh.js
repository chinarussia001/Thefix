(() => {
  if (window.__LOVABURST_CHATGPT_RESULT_REFRESH__) return;
  window.__LOVABURST_CHATGPT_RESULT_REFRESH__ = true;

  const KEY = "projectRunStatuses";
  const REQUEST_MARKERS = ["[PRM_BUILD_REQUEST_V5]", "[LOVABURST_REQUEST_V3]", "[LOVABURST_REQUEST_V2]", "[LOVABURST_REQUEST_V1]", "[LOVARPM_REQUEST_V3]", "[LOVARPM_REQUEST_V2]", "[LOVARPM_REQUEST_V1]"];
  const PROJECT_RE = /(?:LOVABLE_PROJECT|lovable_project_id):\s*([A-Za-z0-9-]+)/i;
  const RESULT_MARKERS = Object.freeze({
    "[PRM_DONE]": "done",
    "[PRM_BLOCKED]": "blocked",
    "[PRM_ERROR]": "error",
    "[LOVABURST_DONE]": "done",
    "[LOVABURST_BLOCKED]": "blocked",
    "[LOVABURST_ERROR]": "error",
    "[LOVARPM_DONE]": "done",
    "[LOVARPM_BLOCKED]": "blocked",
    "[LOVARPM_ERROR]": "error",
  });
  const isRequest = (text) => REQUEST_MARKERS.some((marker) => String(text || "").includes(marker));
  const stableResponses = new Map();

  function isGenerating() {
    const selectors = [
      'button[data-testid="stop-button"]',
      'button[aria-label*="Stop"]',
      'button[aria-label*="Parar"]',
      '[data-testid="stop-button"]',
    ];
    return selectors.some((selector) => {
      const element = document.querySelector(selector);
      if (!(element instanceof HTMLElement) || !element.isConnected) return false;
      const style = getComputedStyle(element);
      return style.display !== "none" && style.visibility !== "hidden";
    });
  }

  function hasCompletionControl(element) {
    const container = element.closest('[data-message-id]') || element.parentElement;
    if (!container) return false;
    return Boolean(container.querySelector('button[data-testid*="copy"], button[aria-label*="Copy"], button[aria-label*="Copiar"]'));
  }

  function markerFromText(text) {
    const value = String(text || "");
    for (const [marker, status] of Object.entries(RESULT_MARKERS)) {
      if (value.includes(marker)) return { marker, status };
    }
    return null;
  }

  function compact(text) {
    return String(text || "").replace(/\s+/g, " ").trim().slice(-1200);
  }

  function latestCandidate(projectId) {
    const id = String(projectId || "").trim();
    if (!id) return null;

    const messages = Array.from(
      document.querySelectorAll('[data-message-author-role="user"], [data-message-author-role="assistant"]'),
    );

    let requestIndex = -1;
    for (let index = 0; index < messages.length; index += 1) {
      const element = messages[index];
      if (element.getAttribute("data-message-author-role") !== "user") continue;
      const text = String(element.innerText || element.textContent || "").trim();
      if (!isRequest(text)) continue;
      const match = text.match(PROJECT_RE);
      if (match?.[1] === id) requestIndex = index;
    }
    if (requestIndex < 0) return null;

    let candidate = null;
    let latestAssistant = null;
    for (let index = requestIndex + 1; index < messages.length; index += 1) {
      const element = messages[index];
      const role = element.getAttribute("data-message-author-role") || "";
      const text = String(element.innerText || element.textContent || "").trim();
      if (!text) continue;
      if (role === "user" && isRequest(text)) break;
      if (role !== "assistant") continue;

      const messageId =
        element.getAttribute("data-message-id") ||
        element.closest("[data-message-id]")?.getAttribute("data-message-id") ||
        "";

      latestAssistant = { element, index, messageId, text };

      const marker = markerFromText(text);
      if (!marker) continue;

      candidate = {
        projectId: id,
        marker: marker.marker,
        status: marker.status,
        assistantMessageKey: messageId || `${index}:${marker.marker}:${text.length}`,
        text,
      };
    }
    if (candidate || !latestAssistant || isGenerating()) return candidate;

    const responseKey = latestAssistant.messageId || `${requestIndex}:${latestAssistant.index}`;
    const fingerprint = `${latestAssistant.text.length}:${latestAssistant.text.slice(-180)}`;
    const previous = stableResponses.get(id);
    const visiblyComplete = hasCompletionControl(latestAssistant.element);
    if (!visiblyComplete && previous?.fingerprint !== fingerprint) {
      stableResponses.set(id, { fingerprint, seenAt: Date.now() });
      return null;
    }
    if (!visiblyComplete && Date.now() - Number(previous?.seenAt || 0) < 1200) return null;

    stableResponses.delete(id);
    return {
      projectId: id,
      marker: "[LOVABURST_DONE]",
      status: "done",
      assistantMessageKey: `${responseKey}:complete:${fingerprint}`,
      text: latestAssistant.text,
    };
  }

  async function persist(candidate) {
    if (!candidate) return null;
    const stored = await chrome.storage.local.get(KEY);
    const statuses = stored[KEY] || {};
    const previous = statuses[candidate.projectId] || {};

    if (
      previous.marker === candidate.marker &&
      previous.assistantMessageKey === candidate.assistantMessageKey
    ) {
      return previous;
    }

    const now = new Date().toISOString();
    const next = {
      ...previous,
      projectId: candidate.projectId,
      status: candidate.status,
      marker: candidate.marker,
      detectedAt: now,
      completedAt: now,
      chatUrl: location.href,
      chatTitle: document.title || "ChatGPT",
      assistantMessageKey: candidate.assistantMessageKey,
      excerpt: compact(candidate.text),
      error: candidate.status === "error" ? compact(candidate.text) : "",
      updatedAt: now,
    };

    await chrome.storage.local.set({
      [KEY]: {
        ...statuses,
        [candidate.projectId]: next,
      },
    });
    return next;
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "LOVABURST_SCAN_RESULT_MARKERS") return false;
    const projectId = String(message.projectId || "").trim();

    Promise.resolve()
      .then(() => latestCandidate(projectId))
      .then(persist)
      .then(async (saved) => {
        if (saved) {
          sendResponse({
            ok: true,
            projectId,
            status: String(saved.status || ""),
            marker: String(saved.marker || ""),
          });
          return;
        }

        const stored = await chrome.storage.local.get(KEY);
        const current = stored[KEY]?.[projectId] || null;
        sendResponse({
          ok: true,
          projectId,
          status: String(current?.status || ""),
          marker: String(current?.marker || ""),
        });
      })
      .catch((error) => {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return true;
  });
})();
