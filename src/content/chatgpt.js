(() => {
  if (window.__LOVABURST_CHATGPT_BRIDGE_V0313__) return;
  window.__LOVABURST_CHATGPT_BRIDGE_V0313__ = true;
  window.__LOVABURST_CHATGPT_BRIDGE__ = true;

  const SOURCE = "chatgpt";
  const PRM_WRAPPER = `[PRM_WRAPPER]\n\nExecute the user's request accurately and completely.\nInspect before changing. Preserve existing functionality and explicit requirements.\nMake the smallest safe changes necessary.\nVerify and repair task-caused errors before finishing.\nThe user's request is the source of truth; do not override it.\n\nFINAL RESPONSE:\nBriefly report what changed, key files, and validations actually performed.\n\nFinish with exactly one status:\n[PRM_DONE]\n[PRM_BLOCKED]\n[PRM_ERROR]`;
  const COMPOSER_SELECTORS = [
    "#prompt-textarea",
    'textarea[data-testid="prompt-textarea"]',
    'textarea[placeholder*="Message" i]',
    'textarea[placeholder*="mensagem" i]',
    'div[contenteditable="true"][id="prompt-textarea"]',
    'div[contenteditable="true"][data-virtualkeyboard="true"]',
    'div.ProseMirror[contenteditable="true"]',
    'form [contenteditable="true"]',
  ];
  const SEND_BUTTON_SELECTORS = [
    'button[data-testid="send-button"]',
    'button[aria-label*="Send" i]',
    'button[aria-label*="Enviar" i]',
    'button[title*="Send" i]',
    'button[type="submit"]',
  ];

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
  const REQUEST_MARKERS = ["[PRM_BUILD_REQUEST_V5]", "[LOVABURST_REQUEST_V3]", "[LOVABURST_REQUEST_V2]", "[LOVABURST_REQUEST_V1]", "[LOVARPM_REQUEST_V3]", "[LOVARPM_REQUEST_V2]", "[LOVARPM_REQUEST_V1]"];
  const isLovaRPMRequest = (text) => REQUEST_MARKERS.some((marker) => String(text || "").includes(marker));
  const PROJECT_ID_PATTERN = /(?:LOVABLE_PROJECT|BASE44_APP|lovable_project_id):\s*([A-Za-z0-9-]+)/i;
  const RUN_STATUS_STORAGE_KEY = "projectRunStatuses";
  const LARGE_PROMPT_THRESHOLD = 12000;
  const REQUEST_HEADER_SCAN_LIMIT = 4096;
  const RESULT_EXCERPT_LIMIT = 4000;

  let busy = false;
  let resultScanTimer = null;
  let lastResultSignature = "";
  let lastLiveResponseSignature = "";
  let lastLiveResponseWriteAt = 0;


  const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

  function announceReady() {
    chrome.runtime.sendMessage({ type: "LOVABURST_PING", source: SOURCE }).catch(() => {});
  }

  function isVisible(element) {
    if (!(element instanceof HTMLElement) || !element.isConnected) return false;
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 40 && rect.height > 18 && style.display !== "none" && style.visibility !== "hidden";
  }

  function readComposer(element) {
    if (!element) return "";
    if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
      return element.value || "";
    }
    return (element.innerText || element.textContent || "").trim();
  }

  function findComposer() {
    const candidates = [];
    const seen = new Set();

    for (const selector of COMPOSER_SELECTORS) {
      for (const element of document.querySelectorAll(selector)) {
        if (!seen.has(element) && isVisible(element)) {
          seen.add(element);
          candidates.push(element);
        }
      }
    }

    candidates.sort((left, right) => {
      const leftRect = left.getBoundingClientRect();
      const rightRect = right.getBoundingClientRect();
      const leftInForm = left.closest("form") ? 1 : 0;
      const rightInForm = right.closest("form") ? 1 : 0;
      return rightInForm - leftInForm || rightRect.bottom - leftRect.bottom;
    });

    return candidates[0] || null;
  }

  async function waitForComposer(timeoutMs = 12000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const composer = findComposer();
      if (composer) return composer;
      await sleep(120);
    }
    return null;
  }

  function dispatchComposerInput(element, text, large) {
    if (large) {
      element.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        composed: true,
        inputType: "insertFromPaste",
        data: null,
      }));
    } else {
      element.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        composed: true,
        inputType: "insertText",
        data: text,
      }));
    }
    element.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  }

  function setComposerText(element, text) {
    element.focus();
    const large = text.length >= LARGE_PROMPT_THRESHOLD;

    if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
      const prototype = element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      if (setter) setter.call(element, text);
      else element.value = text;
      dispatchComposerInput(element, text, large);
      return;
    }

    if (large) {
      // execCommand + InputEvent.data duplicava o prompt inteiro e bloqueava a main thread
      // em prompts grandes. Um único text node + um evento sem payload preserva o conteúdo
      // sem criar cópias gigantes durante a atualização do composer do ChatGPT.
      element.replaceChildren(document.createTextNode(text));
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(element);
      range.collapse(false);
      selection?.removeAllRanges();
      selection?.addRange(range);
      dispatchComposerInput(element, text, true);
      return;
    }

    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    selection?.removeAllRanges();
    selection?.addRange(range);

    try {
      document.execCommand("delete", false);
      if (!document.execCommand("insertText", false, text)) element.textContent = text;
    } catch {
      element.textContent = text;
    }

    dispatchComposerInput(element, text, false);
  }

  function composerHasContent(element) {
    if (!element) return false;
    if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
      return Boolean(element.value?.length);
    }
    return Boolean(element.firstChild);
  }

  function findSendButton(composer) {
    const roots = [composer?.closest("form"), composer?.parentElement, document].filter(Boolean);

    for (const root of roots) {
      for (const selector of SEND_BUTTON_SELECTORS) {
        const buttons = Array.from(root.querySelectorAll(selector)).filter(
          (button) => isVisible(button) && !button.disabled && button.getAttribute("aria-disabled") !== "true",
        );
        if (buttons.length) return buttons[buttons.length - 1];
      }
    }

    return null;
  }

  function countUserMessages() {
    return document.querySelectorAll('[data-message-author-role="user"]').length;
  }

  function generationActive() {
    return Boolean(document.querySelector(
      'button[data-testid="stop-button"],button[aria-label*="Stop" i],button[aria-label*="Parar" i]',
    ));
  }

  function responseIsComplete(element) {
    const container = element?.closest?.('[data-message-id]') || element?.parentElement;
    if (!container || generationActive()) return false;
    return Boolean(container.querySelector('button[data-testid*="copy"],button[aria-label*="Copy" i],button[aria-label*="Copiar" i]'));
  }

  function composerCleared(element) {
    if (!element?.isConnected) return true;
    if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
      return !element.value?.trim();
    }
    return !String(element.textContent || "").trim();
  }

  async function waitForDispatch(baseline, composer, clickedButton, timeoutMs) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (countUserMessages() > baseline) return { confirmed: true, signal: "user-message" };
      if (generationActive()) return { confirmed: true, signal: "generation" };
      if (clickedButton && (!clickedButton.isConnected || clickedButton.disabled || clickedButton.getAttribute("aria-disabled") === "true")) {
        return { confirmed: true, signal: "send-state" };
      }
      // Ler o conteúdo do composer só após o clique e em uma cadência baixa evita
      // o falso negativo sem reintroduzir o custo de reler prompts grandes a cada tick.
      if (Date.now() - startedAt >= 600 && composerCleared(composer)) {
        return { confirmed: true, signal: "composer-cleared" };
      }
      await sleep(120);
    }
    return { confirmed: false, signal: "timeout" };
  }

  async function submitPrompt(prompt, options = {}) {
    if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
      return { ok: false, error: "Prompt is empty or invalid." };
    }

    const composer = await waitForComposer();
    if (!composer) return { ok: false, error: "ChatGPT message field not found." };

    let authorization;
    try {
      authorization = await chrome.runtime.sendMessage({ type: "LOVARPM_LICENSE_AUTHORIZE" });
    } catch {
      return { ok: false, error: "Could not verify the LovaRPM license. Protected features remain locked." };
    }
    const remainingMs = Number(authorization?.remainingMs);
    if (!authorization?.ok || !authorization.status?.valid || !Number.isFinite(remainingMs) || remainingMs <= 0) {
      return { ok: false, error: authorization?.status?.message || "A valid LovaRPM license is required." };
    }
    const authorizationDeadline = performance.now() + remainingMs;

    const originalPrompt = prompt.trim();
    const normalizedPrompt = options.implementationTask === true && !originalPrompt.startsWith(PRM_WRAPPER) && !originalPrompt.startsWith("[PRM_BUILD_REQUEST_V5]")
      ? `${PRM_WRAPPER}\n\n${originalPrompt}`
      : originalPrompt;
    const baseline = countUserMessages();
    setComposerText(composer, normalizedPrompt);
    await sleep(normalizedPrompt.length >= LARGE_PROMPT_THRESHOLD ? 180 : 120);

    if (!composerHasContent(composer)) {
      return { ok: false, error: "LovaRPM could not insert the prompt into ChatGPT." };
    }

    let button = null;
    const waitForSendReady = Boolean(options.waitForSendReady);
    const maxAttempts = waitForSendReady ? 120 : 20;
    const attemptDelay = waitForSendReady ? 250 : 100;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      button = findSendButton(composer);
      if (button) break;
      await sleep(attemptDelay);
    }

    if (performance.now() + 250 >= authorizationDeadline) {
      if (readComposer(composer).trim() === normalizedPrompt) setComposerText(composer, "");
      return { ok: false, error: "The license expired before the request could be sent." };
    }

    if (button) {
      button.click();
      const dispatch = await waitForDispatch(baseline, composer, button, 12000);
      if (dispatch.confirmed) return { ok: true, confirmation: dispatch.signal };
      // O clique já foi entregue ao botão de envio. Em algumas versões do ChatGPT,
      // a mensagem só entra no DOM depois de vários segundos. Não transforme essa
      // confirmação tardia em erro e nunca clique novamente, evitando duplicidade.
      return { ok: true, confirmation: "pending" };
    } else {
      if (waitForSendReady) {
        return { ok: false, error: "The attachment is not ready to send in ChatGPT yet." };
      }
      composer.focus();
      composer.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        bubbles: true,
        composed: true,
        cancelable: true,
      }));
      composer.dispatchEvent(new KeyboardEvent("keyup", {
        key: "Enter",
        code: "Enter",
        bubbles: true,
        composed: true,
        cancelable: true,
      }));
      const dispatch = await waitForDispatch(baseline, composer, null, 12000);
      if (dispatch.confirmed) return { ok: true, confirmation: dispatch.signal };
      // O evento de Enter já foi emitido; manter a solicitação como em processamento
      // é mais correto do que exibir um erro falso enquanto o ChatGPT materializa o envio.
      return { ok: true, confirmation: "pending" };
    }
  }

  function compactResultExcerpt(text) {
    return String(text || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(-1200);
  }

  function markerFromText(text) {
    const value = String(text || "");
    for (const [marker, status] of Object.entries(RESULT_MARKERS)) {
      if (value.includes(marker)) return { marker, status };
    }
    return null;
  }

  async function persistProjectRunStatus(result) {
    if (!result?.projectId || !result?.marker) return;

    const stored = await chrome.storage.local.get(RUN_STATUS_STORAGE_KEY);
    const current = stored[RUN_STATUS_STORAGE_KEY] || {};
    const previous = current[result.projectId];

    if (
      previous?.marker === result.marker &&
      previous?.assistantMessageKey === result.assistantMessageKey
    ) {
      return;
    }

    await chrome.storage.local.set({
      [RUN_STATUS_STORAGE_KEY]: {
        ...current,
        [result.projectId]: {
          ...previous,
          projectId: result.projectId,
          status: result.status,
          marker: result.marker,
          detectedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          chatUrl: window.location.href,
          chatTitle: document.title || "ChatGPT",
          assistantMessageKey: result.assistantMessageKey,
          excerpt: compactResultExcerpt(result.text),
          liveResponse: compactVisibleResponse(result.text),
          liveResponseAt: new Date().toISOString(),
          liveResponseMessageKey: result.assistantMessageKey,
          error: result.status === "error" ? compactResultExcerpt(result.text) : "",
        },
      },
    });

    chrome.runtime.sendMessage({
      type: "LOVABURST_RESULT_MARKER_DETECTED",
      source: SOURCE,
      projectId: result.projectId,
      status: result.status,
      marker: result.marker,
      detectedAt: new Date().toISOString(),
      chatUrl: window.location.href,
    }).catch(() => {});
  }

  function readTextPrefix(element, limit = REQUEST_HEADER_SCAN_LIMIT) {
    if (!element || limit <= 0) return "";
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let text = "";
    while (text.length < limit) {
      const node = walker.nextNode();
      if (!node) break;
      const chunk = String(node.nodeValue || "");
      if (!chunk) continue;
      text += chunk.slice(0, limit - text.length);
    }
    return text.trim();
  }

  function scanAssistantMarker(element) {
    if (!element) return null;
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let tail = "";
    let totalLength = 0;
    let carry = "";

    while (true) {
      const node = walker.nextNode();
      if (!node) break;
      const chunk = String(node.nodeValue || "");
      if (!chunk) continue;
      totalLength += chunk.length;
      tail = (tail + chunk).slice(-RESULT_EXCERPT_LIMIT);
      const probe = carry + chunk;
      const marker = markerFromText(probe);
      if (marker) return { ...marker, text: tail.trim(), totalLength };
      carry = probe.slice(-64);
    }

    return null;
  }

  async function scanConversationForResultMarkers() {
    const messages = Array.from(
      document.querySelectorAll('[data-message-author-role="user"], [data-message-author-role="assistant"]'),
    );

    // First pass: locate the most recent LovaRPM request for each project.
    // This prevents an old [LOVABURST_DONE] from overwriting a new "working" state
    // while the newest request is still being processed.
    const latestRequestIndexByProject = new Map();

    for (let index = 0; index < messages.length; index += 1) {
      const element = messages[index];
      if (element.getAttribute("data-message-author-role") !== "user") continue;
      const text = readTextPrefix(element);
      if (!text || !isLovaRPMRequest(text)) continue;
      const projectMatch = text.match(PROJECT_ID_PATTERN);
      if (projectMatch?.[1]) latestRequestIndexByProject.set(projectMatch[1], index);
    }

    let latest = null;

    for (const [projectId, requestIndex] of latestRequestIndexByProject.entries()) {
      for (let index = requestIndex + 1; index < messages.length; index += 1) {
        const element = messages[index];
        const role = element.getAttribute("data-message-author-role") || "";

        // Stop when a newer LovaRPM request starts. Only the bounded header is
        // needed here; never materialize a potentially huge user prompt.
        if (role === "user") {
          const header = readTextPrefix(element);
          if (isLovaRPMRequest(header)) break;
          continue;
        }
        if (role !== "assistant") continue;

        const result = scanAssistantMarker(element);
        if (!result) continue;
        const marker = { marker: result.marker, status: result.status };
        const text = result.text;

        const messageId =
          element.getAttribute("data-message-id") ||
          element.closest("[data-message-id]")?.getAttribute("data-message-id") ||
          "";
        const assistantMessageKey = messageId || `${index}:${marker.marker}:${result.totalLength}`;

        const candidate = {
          projectId,
          marker: marker.marker,
          status: marker.status,
          assistantMessageKey,
          text,
          index,
        };

        if (!latest || candidate.index >= latest.index) latest = candidate;
      }
    }

    if (!latest) return;

    const signature = `${latest.projectId}|${latest.assistantMessageKey}|${latest.marker}`;
    if (signature === lastResultSignature) return;
    lastResultSignature = signature;

    await persistProjectRunStatus(latest);
  }

  function compactVisibleResponse(text) {
    return String(text || "")
      .replace(/\[(?:PRM|LOVABURST|LOVARPM)_(?:DONE|BLOCKED|ERROR)\]/g, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
      .slice(-2200);
  }

  async function persistVisibleAssistantResponse() {
    const messages = Array.from(
      document.querySelectorAll('[data-message-author-role="user"], [data-message-author-role="assistant"]'),
    );

    let projectId = "";
    let requestIndex = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const element = messages[index];
      if (element.getAttribute("data-message-author-role") !== "user") continue;
      const header = readTextPrefix(element);
      if (!isLovaRPMRequest(header)) continue;
      const match = header.match(PROJECT_ID_PATTERN);
      if (match?.[1]) {
        projectId = match[1];
        requestIndex = index;
        break;
      }
    }
    if (!projectId || requestIndex < 0) return;

    let assistant = null;
    let assistantIndex = -1;
    for (let index = messages.length - 1; index > requestIndex; index -= 1) {
      if (messages[index].getAttribute("data-message-author-role") === "assistant") {
        assistant = messages[index];
        assistantIndex = index;
        break;
      }
    }
    if (!assistant) return;

    const visibleText = String(assistant.innerText || assistant.textContent || "").trim();
    const liveResponse = compactVisibleResponse(visibleText);
    if (!liveResponse) return;

    const marker = markerFromText(visibleText);
    const messageId =
      assistant.getAttribute("data-message-id") ||
      assistant.closest("[data-message-id]")?.getAttribute("data-message-id") ||
      `assistant-${assistantIndex}`;
    if (!marker && responseIsComplete(assistant)) {
      await persistProjectRunStatus({
        projectId,
        marker: "[LOVABURST_DONE]",
        status: "done",
        assistantMessageKey: `${messageId}:complete:${visibleText.length}`,
        text: visibleText,
      });
      return;
    }
    const signature = `${projectId}|${messageId}|${liveResponse}`;
    const timestamp = Date.now();
    if (signature === lastLiveResponseSignature || timestamp - lastLiveResponseWriteAt < 200) return;
    lastLiveResponseSignature = signature;
    lastLiveResponseWriteAt = timestamp;

    const stored = await chrome.storage.local.get(RUN_STATUS_STORAGE_KEY);
    const current = stored[RUN_STATUS_STORAGE_KEY] || {};
    const previous = current[projectId] || {};
    if (["done", "blocked", "error"].includes(previous.status) && !marker) return;

    await chrome.storage.local.set({
      [RUN_STATUS_STORAGE_KEY]: {
        ...current,
        [projectId]: {
          ...previous,
          projectId,
          status: marker?.status || previous.status || "working",
          liveResponse,
          liveResponseAt: new Date().toISOString(),
          liveResponseMessageKey: messageId,
          chatUrl: window.location.href,
          chatTitle: document.title || "ChatGPT",
        },
      },
    });
  }

  function scheduleResultScan(delayMs = 80) {
    if (resultScanTimer) window.clearTimeout(resultScanTimer);
    resultScanTimer = window.setTimeout(() => {
      resultScanTimer = null;
      scanConversationForResultMarkers().catch(() => {});
      persistVisibleAssistantResponse().catch(() => {});
    }, delayMs);
  }

  function startResultMarkerObserver() {
    const root = document.body || document.documentElement;
    if (!root) {
      window.setTimeout(startResultMarkerObserver, 250);
      return;
    }

    const observer = new MutationObserver(() => scheduleResultScan());
    observer.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    scheduleResultScan(50);
  }

  function exportProjectConversationContext(projectId) {
    const id = String(projectId || "").trim();
    if (!id) return "";

    const elements = Array.from(document.querySelectorAll("[data-message-author-role]"));
    const collected = [];
    let belongsToProject = false;

    for (const element of elements) {
      const role = element.getAttribute("data-message-author-role") || "";
      const text = readTextPrefix(element, 1800);
      if (!text) continue;

      if (
        role === "user" &&
        isLovaRPMRequest(text) &&
        PROJECT_ID_PATTERN.test(text) && text.match(PROJECT_ID_PATTERN)?.[1] === id
      ) {
        belongsToProject = true;
      }

      if (!belongsToProject) continue;
      if (role !== "user" && role !== "assistant") continue;

      const compact = text.replace(/\n{3,}/g, "\n\n").slice(0, 1800);
      collected.push(`${role === "user" ? "USER" : "ASSISTANT"}:\n${compact}`);
    }

    return collected.slice(-12).join("\n\n---\n\n").slice(-14000);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message?.type) return false;

    if (message.type === "LOVABURST_EXPORT_PROJECT_CONTEXT") {
      sendResponse({
        ok: true,
        source: SOURCE,
        projectId: String(message.projectId || ""),
        excerpt: exportProjectConversationContext(message.projectId),
      });
      return false;
    }

    if (message.type === "LOVABURST_CONTENT_PING") {
      chrome.storage.local.get(RUN_STATUS_STORAGE_KEY)
        .then((stored) => {
          const statuses = stored[RUN_STATUS_STORAGE_KEY] || {};
          const latestStatus = Object.values(statuses)
            .filter((item) => item?.chatUrl === window.location.href)
            .sort((left, right) => String(right?.detectedAt || "").localeCompare(String(left?.detectedAt || "")))[0] || null;

          sendResponse({
            ok: true,
            source: SOURCE,
            url: window.location.href,
            composerDetected: Boolean(findComposer()),
            busy,
            resultMarker: latestStatus?.marker || "",
            resultStatus: latestStatus?.status || "",
            resultProjectId: latestStatus?.projectId || "",
          });
        })
        .catch(() => {
          sendResponse({
            ok: true,
            source: SOURCE,
            url: window.location.href,
            composerDetected: Boolean(findComposer()),
            busy,
          });
        });
      return true;
    }

    if (message.type === "LOVABURST_SUBMIT_TO_CHATGPT") {
      if (busy) {
        sendResponse({ ok: false, error: "ChatGPT is already processing a LovaRPM submission." });
        return false;
      }

      busy = true;
      submitPrompt(message.prompt, { implementationTask: message.implementationTask === true })
        .then(sendResponse)
        .catch((error) => sendResponse({ ok: false, error: String(error) }))
        .finally(() => {
          busy = false;
        });
      return true;
    }

    return false;
  });

  startResultMarkerObserver();
  announceReady();
})();
