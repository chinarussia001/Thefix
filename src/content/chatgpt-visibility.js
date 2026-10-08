(() => {
  if (window.__LOVABURST_CHATGPT_VISIBILITY__) return;
  window.__LOVABURST_CHATGPT_VISIBILITY__ = true;

  let lastResultWakeAt = 0;
  let activeLeaseToken = "";

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function countUserMessages() {
    return document.querySelectorAll('[data-message-author-role="user"]').length;
  }

  function composerText() {
    const composer =
      document.querySelector("#prompt-textarea") ||
      document.querySelector('textarea[data-testid="prompt-textarea"]') ||
      document.querySelector('div[contenteditable="true"][id="prompt-textarea"]');
    if (!composer) return "";
    if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) return composer.value || "";
    return String(composer.innerText || composer.textContent || "").trim();
  }

  async function beginWake(durationMs = 7000) {
    if (document.visibilityState === "visible" && document.hasFocus()) return "";
    try {
      const response = await chrome.runtime.sendMessage({
        type: "LOVABURST_WAKE_CHATGPT_BEGIN",
        durationMs,
      });
      if (response?.ok && response.token) {
        activeLeaseToken = String(response.token);
        return activeLeaseToken;
      }
    } catch {}
    return "";
  }

  async function releaseWake(token = activeLeaseToken) {
    const value = String(token || "");
    if (!value) return;
    if (activeLeaseToken === value) activeLeaseToken = "";
    try {
      await chrome.runtime.sendMessage({ type: "LOVABURST_WAKE_CHATGPT_END", token: value });
    } catch {}
  }

  async function watchDispatch(token, baseline) {
    if (!token) return;
    let sawComposerText = false;
    const startedAt = Date.now();

    while (Date.now() - startedAt < 6500) {
      const text = composerText();
      if (text) sawComposerText = true;
      if (countUserMessages() > baseline || (sawComposerText && !text)) break;
      await sleep(70);
    }

    await releaseWake(token);
  }

  function wakeForResult(projectId) {
    const now = Date.now();
    if (document.visibilityState === "visible") return;
    if (now - lastResultWakeAt < 7000) return;
    lastResultWakeAt = now;
    chrome.runtime.sendMessage({
      type: "LOVABURST_WAKE_CHATGPT_FOR_RESULT",
      projectId: String(projectId || ""),
    }).catch(() => {});
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (!message || typeof message !== "object") return false;

    if (message.type === "LOVABURST_SUBMIT_TO_CHATGPT") {
      const baseline = countUserMessages();
      void beginWake(7000).then((token) => {
        if (token) void watchDispatch(token, baseline);
      });
      return false;
    }

    if (message.type === "LOVABURST_SCAN_RESULT_MARKERS" && !message.wakeBypass) {
      wakeForResult(message.projectId);
      return false;
    }

    return false;
  });

  chrome.runtime.sendMessage({ type: "LOVABURST_KEEP_CHATGPT_READY" }).catch(() => {});
})();
