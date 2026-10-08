(() => {
  if (window.__LOVABURST_CHATGPT_ATTACHMENTS_V0317__) return;
  window.__LOVABURST_CHATGPT_ATTACHMENTS_V0317__ = true;
  window.__LOVABURST_CHATGPT_ATTACHMENTS__ = true;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const visible = (element) =>
    element instanceof HTMLElement &&
    element.isConnected &&
    element.getBoundingClientRect().width > 0 &&
    getComputedStyle(element).display !== "none";

  function composer() {
    return [
      "#prompt-textarea",
      'textarea[data-testid="prompt-textarea"]',
      'div.ProseMirror[contenteditable="true"]',
      'form [contenteditable="true"]',
    ]
      .flatMap((selector) => Array.from(document.querySelectorAll(selector)))
      .filter(visible)
      .at(-1) || null;
  }

  function fileInput(element) {
    const roots = [element?.closest("form"), element?.parentElement, document].filter(Boolean);
    for (const root of roots) {
      const inputs = Array.from(root.querySelectorAll('input[type="file"]')).filter((input) => !input.disabled);
      if (inputs.length) return inputs.at(-1);
    }
    return null;
  }

  function decode(attachment) {
    const binary = atob(attachment.base64 || "");
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return new File([bytes], attachment.name, {
      type: attachment.type || "",
      lastModified: Date.now(),
    });
  }

  function attachmentCount(element) {
    const root = element?.closest("form") || document;
    return root.querySelectorAll(
      '[data-testid*="attachment" i],[data-testid*="file" i],button[aria-label*="remove" i],button[aria-label*="remover" i]',
    ).length;
  }

  function attachmentNodes(element) {
    const root = element?.closest("form") || document;
    return Array.from(root.querySelectorAll(
      '[data-testid*="attachment" i],[data-testid*="file" i],[data-testid*="upload" i],button[aria-label*="remove" i],button[aria-label*="remover" i]',
    )).filter(visible);
  }

  function attachmentNamesPresent(element, names) {
    const root = element?.closest("form") || document;
    const text = String(root.innerText || root.textContent || "").toLowerCase();
    return names.every((name) => text.includes(String(name).toLowerCase()));
  }

  function rejectionMessage(element, names) {
    const candidates = Array.from(document.querySelectorAll('[role="alert"],[aria-live="assertive"],[aria-live="polite"],[data-testid*="toast" i]')).filter(visible);
    const text = candidates.map((node) => String(node.innerText || node.textContent || "").trim()).filter(Boolean).join("\n");
    if (!text) return "";
    const lower = text.toLowerCase();
    const mentionsFile = names.some((name) => lower.includes(String(name).toLowerCase()));
    const looksLikeUploadError = /(upload|anex|arquivo|file|unsupported|suportad|failed|falhou|too large|muito grande|limit|tamanho|type|tipo)/i.test(text);
    return mentionsFile || looksLikeUploadError ? text.slice(0, 500) : "";
  }

  async function waitForComposer(timeoutMs = 9000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const element = composer();
      if (element) return element;
      await sleep(150);
    }
    return null;
  }

  async function prepareAttachments(attachments) {
    if (!attachments.length) return { ok: true, count: 0 };
    const element = await waitForComposer();
    if (!element) throw new Error("ChatGPT message field not found.");
    let authorization;
    try {
      authorization = await chrome.runtime.sendMessage({ type: "LOVARPM_LICENSE_AUTHORIZE" });
    } catch {
      throw new Error("Could not verify the LovaRPM license. Protected features remain locked.");
    }
    const remainingMs = Number(authorization?.remainingMs);
    if (!authorization?.ok || !authorization.status?.valid || !Number.isFinite(remainingMs) || remainingMs <= 250) {
      throw new Error(authorization?.status?.message || "A valid LovaRPM license is required.");
    }
    const authorizationDeadline = performance.now() + remainingMs;
    const input = fileInput(element);
    if (!input) throw new Error("The current ChatGPT composer does not provide a file input.");
    if (performance.now() + 250 >= authorizationDeadline) throw new Error("The license expired before the attachments could be added.");
    const files = attachments.map(decode);
    const names = files.map((file) => String(file.name || "")).filter(Boolean);
    const baselineNodes = attachmentNodes(element).length;
    const transfer = new DataTransfer(); files.forEach((file) => transfer.items.add(file));
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "files")?.set; if (setter) setter.call(input, transfer.files); else input.files = transfer.files;
    input.dispatchEvent(new Event("input", { bubbles: true, composed: true })); input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    const startedAt = Date.now();
    while (Date.now() - startedAt < 30000) {
      await sleep(220);
      const rejection = rejectionMessage(element, names);
      if (rejection) throw new Error(`ChatGPT rejected the attachment: ${rejection}`);
      const nodeCount = attachmentNodes(element).length;
      if (attachmentNamesPresent(element, names) || (nodeCount >= baselineNodes + attachments.length && attachments.length > 0)) return { ok: true, count: attachments.length };
    }
    throw new Error(`Could not attach ${names[0] || "the file"} to ChatGPT. The message was not sent.`);
  }
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "LOVABURST_ATTACHMENTS_PING") {
      sendResponse({ ok: true, source: "chatgpt-attachments", version: "0.31.7" });
      return false;
    }

    if (message?.type !== "LOVABURST_PREPARE_ATTACHMENTS") return false;

    prepareAttachments(Array.isArray(message.attachments) ? message.attachments : [])
      .then(sendResponse)
      .catch((error) =>
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    return true;
  });
})();
