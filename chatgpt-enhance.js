(() => {
  if (window.__LOVABURST_CHATGPT_ENHANCE_BRIDGE_V0311__) return;
  window.__LOVABURST_CHATGPT_ENHANCE_BRIDGE_V0311__ = true;

  const CHECK_INTERVAL_MS = 5000;
  const DEFAULT_TIMEOUT_MS = 95000;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function assistantMessages() {
    return [...document.querySelectorAll('[data-message-author-role="assistant"]')];
  }
  function messageKey(element, index) {
    if (!element) return "";
    return element.getAttribute("data-message-id") || element.closest("[data-message-id]")?.getAttribute("data-message-id") || `assistant-${index}`;
  }
  function messageText(element) {
    return String(element?.innerText || element?.textContent || "").trim();
  }
  function generating() {
    return Boolean(document.querySelector('button[data-testid="stop-button"],button[aria-label*="Stop" i],button[aria-label*="Parar" i]'));
  }
  function snapshot() {
    const messages = assistantMessages();
    const last = messages.at(-1) || null;
    return { count: messages.length, lastKey: messageKey(last, messages.length - 1), lastText: messageText(last), capturedAt: Date.now() };
  }
  function latestAfter(baseline) {
    const messages = assistantMessages();
    const last = messages.at(-1) || null;
    if (!last) return null;
    const key = messageKey(last, messages.length - 1);
    const text = messageText(last);
    const isNew = messages.length > Number(baseline?.count || 0) || key !== String(baseline?.lastKey || "") || (text && text !== String(baseline?.lastText || ""));
    return isNew && text ? { key, text } : null;
  }
  async function waitForEnhancedAnswer(baseline, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const startedAt = Date.now();
    let previous = "", stableChecks = 0;
    while (Date.now() - startedAt < timeoutMs) {
      await sleep(CHECK_INTERVAL_MS);
      const candidate = latestAfter(baseline);
      if (!candidate) continue;
      if (candidate.text === previous) stableChecks += 1;
      else { previous = candidate.text; stableChecks = 1; }
      if (!generating() || stableChecks >= 2) return candidate.text;
    }
    throw new Error("O ChatGPT demorou demais para devolver o prompt aprimorado.");
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "LOVABURST_ENHANCE_PING") {
      sendResponse({ ok: true, version: "0.31.1" });
      return false;
    }
    if (message?.type === "LOVABURST_ENHANCE_SNAPSHOT") {
      sendResponse({ ok: true, baseline: snapshot() });
      return false;
    }
    if (message?.type === "LOVABURST_ENHANCE_WAIT_FOR_RESPONSE") {
      waitForEnhancedAnswer(message.baseline, Number(message.timeoutMs) || DEFAULT_TIMEOUT_MS)
        .then((text) => sendResponse({ ok: true, text }))
        .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
      return true;
    }
    return false;
  });
})();
