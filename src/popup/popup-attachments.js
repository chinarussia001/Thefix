(() => {
  if (globalThis.__LOVABURST_POPUP_ATTACHMENTS_V2__) return;
  globalThis.__LOVABURST_POPUP_ATTACHMENTS_V2__ = true;

  const attachmentsApi = globalThis.__LOVABURST_ATTACHMENTS__;
  const input = document.getElementById("commandInput");
  const sendButton = document.getElementById("sendCommandButton");
  if (!attachmentsApi || !input || !sendButton) return;

  const selected = [];
  let sending = false;
  const getWorkspace = () => {
    try { return typeof workspace !== "undefined" ? workspace : globalThis.workspace || null; }
    catch { return globalThis.workspace || null; }
  };

  const zone = document.createElement("div");
  zone.className = "lb-attachment-zone";
  zone.innerHTML = '<div class="lb-attachment-list" hidden></div><button class="lb-attach-button" type="button" title="Attach file" aria-label="Attach file">📎 <span>Attach</span></button><input class="lb-file-input" type="file" multiple hidden>';
  input.closest(".editor")?.insertAdjacentElement("afterend", zone);

  const list = zone.querySelector(".lb-attachment-list");
  const picker = zone.querySelector(".lb-file-input");
  const attachButton = zone.querySelector(".lb-attach-button");

  const render = () => {
    list.hidden = selected.length === 0;
    list.replaceChildren(...selected.map((item) => {
      const row = document.createElement("div");
      row.className = "lb-attachment";
      row.innerHTML = item.url
        ? '<img alt=""><span class="lb-attachment-name"></span><button class="lb-attachment-remove" type="button" aria-label="Remove">×</button>'
        : '<span class="lb-file-icon"></span><span class="lb-attachment-name"></span><button class="lb-attachment-remove" type="button" aria-label="Remove">×</button>';
      const icon = row.querySelector(".lb-file-icon");
      if (icon) icon.textContent = (item.name.split(".").pop() || "FILE").toUpperCase().slice(0, 8);
      row.querySelector(".lb-attachment-name").textContent = item.name;
      if (item.url) row.querySelector("img").src = item.url;
      row.querySelector("button").addEventListener("click", () => {
        const index = selected.findIndex((entry) => entry.id === item.id);
        if (index >= 0) attachmentsApi.release(selected.splice(index, 1)[0]);
        render();
      });
      return row;
    }));
  };

  const addFiles = (files) => {
    for (const file of files) {
      const error = attachmentsApi.validate(file, selected);
      if (error) { if (typeof showFeedback === "function") showFeedback(error); continue; }
      selected.push(attachmentsApi.make(file));
    }
    render();
  };

  attachButton.addEventListener("click", () => picker.click());
  picker.addEventListener("change", () => { addFiles(Array.from(picker.files || [])); picker.value = ""; });
  input.addEventListener("paste", (event) => {
    const files = attachmentsApi.clipboardFiles(event);
    if (!files.length) return;
    event.preventDefault();
    addFiles(files);
  });

  const submitWithAttachments = async () => {
    if (sending || !selected.length) return;
    const activeWorkspace = getWorkspace();
    if (!activeWorkspace?.lovableProjectId) {
      if (typeof showFeedback === "function") showFeedback(`Open the ${activeWorkspace?.platform === "base44" ? "Base44" : "Lovable"} project you want to change.`);
      return;
    }
    sending = true;
    sendButton.disabled = true;
    try {
      const files = await attachmentsApi.serialize(selected);
      const response = await chrome.runtime.sendMessage({
        type: "LOVABURST_SUBMIT_WITH_ATTACHMENTS",
        text: input.value.trim(),
        attachments: files,
        projectId: activeWorkspace.lovableProjectId,
        repository: activeWorkspace.repository || "",
        url: activeWorkspace.sourceUrl || "",
        title: activeWorkspace.sourceTitle || ""
      });
      if (!response?.ok) throw new Error(response?.error || "Could not send the attachments.");
      input.value = "";
      while (selected.length) attachmentsApi.release(selected.pop());
      render();
      input.dispatchEvent(new Event("input", { bubbles: true }));
      if (typeof showFeedback === "function") showFeedback("Sent to ChatGPT.");
    } catch (error) {
      if (typeof showFeedback === "function") showFeedback(error instanceof Error ? error.message : String(error));
    } finally {
      sending = false;
      sendButton.disabled = false;
    }
  };

  globalThis.__LOVABURST_POPUP_ATTACHMENTS__ = {
    hasFiles: () => selected.length > 0,
    submit: submitWithAttachments,
  };

  sendButton.addEventListener("click", (event) => {
    if (!selected.length) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    void submitWithAttachments();
  }, true);

  window.addEventListener("pagehide", () => selected.forEach(attachmentsApi.release), { once: true });
  render();
})();
