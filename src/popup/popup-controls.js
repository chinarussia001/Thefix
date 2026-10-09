"use strict";

(() => {
  const DEFAULT_CHECK_SECONDS = 30;
  const CHECK_INTERVALS = [5, 10, 15, 30, 60, 120];
  const countdown = document.getElementById("runCheckCountdown");
  const pauseCheckButton = document.getElementById("runCheckPauseButton");
  const statusMain = document.getElementById("runStatusMain");
  const footer = document.querySelector(".app-footer");
  const settingsButton = document.getElementById("settingsButton");
  const input = document.getElementById("commandInput");
  const sendButton = document.getElementById("sendCommandButton");
  const feedback = document.getElementById("sendFeedback");
  let anchor = Date.now();
  let lastActive = false;
  let checkSeconds = DEFAULT_CHECK_SECONDS;
  let autoCheckPaused = false;
  let recognition = null;
  let listening = false;
  let speechBaseText = "";
  let feedbackTimer = null;

  function isCheckingState() {
    const status = String(statusMain?.dataset?.status || "").toLowerCase();
    return status === "sending" || status === "working";
  }

  function renderCountdown() {
    if (!countdown) return;
    const active = isCheckingState();
    if (active && !lastActive) anchor = Date.now();
    lastActive = active;
    if (!active) {
      countdown.hidden = true;
      if (pauseCheckButton) pauseCheckButton.hidden = true;
      return;
    }
    if (pauseCheckButton) {
      pauseCheckButton.hidden = false;
      pauseCheckButton.dataset.paused = String(autoCheckPaused);
      pauseCheckButton.textContent = autoCheckPaused ? "▶" : "⏸";
      pauseCheckButton.title = autoCheckPaused ? "Resume automatic checks" : "Pause automatic checks";
      pauseCheckButton.setAttribute("aria-label", pauseCheckButton.title);
    }
    if (autoCheckPaused) {
      countdown.hidden = false;
      countdown.textContent = "checks paused";
      countdown.title = "Automatic ChatGPT checks are paused.";
      return;
    }
    const elapsed = Math.floor((Date.now() - anchor) / 1000);
    const remaining = checkSeconds - (elapsed % checkSeconds);
    countdown.hidden = false;
    countdown.textContent = remaining <= 1 ? "checking…" : `checks in ${remaining}s`;
    countdown.title = `Next ChatGPT check · every ${checkSeconds}s`;
  }

  async function getCheckConfig() {
    const stored = await chrome.storage.local.get("config");
    const value = Number(stored.config?.chatgptCheckIntervalSeconds);
    return {
      seconds: CHECK_INTERVALS.includes(value) ? value : DEFAULT_CHECK_SECONDS,
      paused: Boolean(stored.config?.chatgptAutoCheckPaused),
    };
  }

  async function saveCheckSeconds(value) {
    if (!CHECK_INTERVALS.includes(value)) return;
    const stored = await chrome.storage.local.get("config");
    const config = { enabled: true, lovableEnabled: true, chatgptEnabled: true, ...(stored.config || {}), chatgptCheckIntervalSeconds: value };
    await chrome.storage.local.set({ config });
    checkSeconds = value;
    anchor = Date.now();
    renderCountdown();
  }

  function createSettingsPanel() {
    if (!settingsButton || document.getElementById("lbSettingsPanel")) return;
    const panel = document.createElement("section");
    panel.id = "lbSettingsPanel";
    panel.className = "lb-settings-panel";
    panel.hidden = true;
    const options = CHECK_INTERVALS.map((seconds) => {
      const label = seconds < 60 ? `${seconds} seconds` : `${seconds / 60} ${seconds === 60 ? "minute" : "minutes"}`;
      return `<option value="${seconds}">${label}${seconds === DEFAULT_CHECK_SECONDS ? " · Default" : ""}</option>`;
    }).join("");
    panel.innerHTML = `<div class="lb-settings-head"><div><span>// SETTINGS</span><strong>LovaRPM preferences</strong></div><button id="lbSettingsClose" type="button" aria-label="Close settings">×</button></div><label class="lb-settings-field"><span>Check ChatGPT results</span><small>Choose how often LovaRPM checks for a result while a request is active.</small><select id="lbCheckInterval">${options}</select></label>`;
    footer?.before(panel);
    const replacement = settingsButton.cloneNode(true);
    settingsButton.replaceWith(replacement);
    replacement.addEventListener("click", async () => {
      const select = panel.querySelector("#lbCheckInterval");
      const current = await getCheckConfig();
      if (select) select.value = String(current.seconds);
      panel.hidden = !panel.hidden;
      if (!panel.hidden) panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
    panel.querySelector("#lbSettingsClose")?.addEventListener("click", () => { panel.hidden = true; });
    panel.querySelector("#lbCheckInterval")?.addEventListener("change", (event) => void saveCheckSeconds(Number(event.target.value)));
  }

  async function loadCheckConfig() {
    try {
      const current = await getCheckConfig();
      checkSeconds = current.seconds;
      autoCheckPaused = current.paused;
      anchor = Date.now();
      renderCountdown();
    } catch {}
  }

  async function toggleAutoCheck() {
    const stored = await chrome.storage.local.get("config");
    const nextPaused = !Boolean(stored.config?.chatgptAutoCheckPaused);
    const config = { enabled: true, lovableEnabled: true, chatgptEnabled: true, ...(stored.config || {}), chatgptAutoCheckPaused: nextPaused };
    await chrome.storage.local.set({ config });
    autoCheckPaused = nextPaused;
    anchor = Date.now();
    renderCountdown();
  }

  function compactFeedback() {
    if (!feedback) return;
    const text = String(feedback.textContent || "").trim();
    const temporary = /^(Data updated\.|Sent to ChatGPT\.|Dados atualizados\.|Enviado ao ChatGPT\.)$/i.test(text);
    feedback.classList.toggle("lb-feedback-temporary", temporary);
    if (feedbackTimer) clearTimeout(feedbackTimer);
    if (temporary && !feedback.hidden) {
      feedbackTimer = setTimeout(() => {
        feedback.hidden = true;
        feedback.classList.remove("lb-feedback-temporary");
      }, 2200);
    }
  }

  function dispatchInput() {
    input?.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function hasAttachments() {
    return Boolean(document.querySelector(".lb-attachment-list")?.children.length);
  }

  function updateClearState() {
    const clearButton = document.getElementById("lbClearComposerButton");
    if (!clearButton || !input) return;
    clearButton.disabled = !input.value.trim() && !hasAttachments();
  }

  function clearComposer() {
    if (!input) return;
    if (listening && recognition) recognition.stop();
    input.value = "";
    document.querySelectorAll(".lb-attachment-remove").forEach((button) => button.click());
    const picker = document.querySelector(".lb-file-input");
    if (picker) picker.value = "";
    dispatchInput();
    updateClearState();
    input.focus();
  }

  async function enhancePrompt(button) {
    const text = String(input?.value || "").trim();
    if (!text) {
      input?.focus();
      if (typeof showFeedback === "function") showFeedback("Enter a request before enhancing the prompt.");
      return;
    }
    const projectId = String(globalThis.workspace?.lovableProjectId || (typeof workspace !== "undefined" ? workspace?.lovableProjectId : "") || "");
    const repository = String(globalThis.workspace?.repository || (typeof workspace !== "undefined" ? workspace?.repository : "") || "");
    const title = String(globalThis.workspace?.sourceTitle || (typeof workspace !== "undefined" ? workspace?.sourceTitle : "") || "");
    if (!projectId) {
      if (typeof showFeedback === "function") showFeedback("Open a Lovable project before enhancing the prompt.");
      return;
    }

    button.disabled = true;
    button.dataset.loading = "true";
    button.dataset.enhancing = "true";
    button.title = "Enhancing prompt…";
    const idleMarkup = button.innerHTML;
    const iconMarkup = button.querySelector("svg")?.outerHTML || "✦";
    button.innerHTML = `${iconMarkup}<span class="lb-tool-label">Enhancing...</span>`;
    const pulseAnimation = button.animate(
      [{ opacity: 0.72, transform: "scale(1)" }, { opacity: 1, transform: "scale(1.04)" }, { opacity: 0.72, transform: "scale(1)" }],
      { duration: 1200, iterations: Infinity, easing: "ease-in-out" },
    );
    const timeoutMs = 95000;
    let timeoutId = null;
    try {
      const timeout = new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error("ChatGPT took too long to return the enhanced prompt.")), timeoutMs);
      });
      const response = await Promise.race([
        chrome.runtime.sendMessage({ type: "LOVABURST_ENHANCE_PROMPT", text, projectId, repository, title }),
        timeout,
      ]);
      const enhanced = String(response?.text || "").trim();
      if (!response?.ok || !enhanced) throw new Error(response?.error || "ChatGPT did not return an enhanced prompt.");
      input.value = enhanced;
      dispatchInput();
      input.focus();
      input.setSelectionRange?.(input.value.length, input.value.length);
      button.dataset.success = "true";
      if (typeof showFeedback === "function") showFeedback("Prompt enhanced.");
      setTimeout(() => { delete button.dataset.success; }, 900);
    } catch (error) {
      if (typeof showFeedback === "function") showFeedback(error instanceof Error ? error.message : String(error));
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      pulseAnimation.cancel();
      button.innerHTML = idleMarkup;
      button.disabled = false;
      button.dataset.loading = "false";
      button.dataset.enhancing = "false";
      button.title = "Enhance prompt";
    }
  }

  function joinSpeech(base, transcript) {
    const left = String(base || "").trimEnd();
    const right = String(transcript || "").trim();
    if (!left) return right;
    if (!right) return left;
    return `${left}${/[\s\n]$/.test(left) ? "" : " "}${right}`;
  }

  function setupSpeech(button) {
    const Recognition = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;
    if (!Recognition) {
      button.disabled = true;
      button.title = "Dictation is not supported in this browser";
      button.dataset.supported = "false";
      return;
    }

    recognition = new Recognition();
    recognition.lang = "pt-BR";
    recognition.continuous = false;
    recognition.interimResults = true;

    recognition.onstart = () => {
      listening = true;
      button.dataset.listening = "true";
      button.title = "Listening... Click to stop";
      speechBaseText = String(input?.value || "");
    };

    recognition.onresult = (event) => {
      let transcript = "";
      for (let index = 0; index < event.results.length; index += 1) {
        transcript += `${event.results[index][0]?.transcript || ""} `;
      }
      if (input) {
        input.value = joinSpeech(speechBaseText, transcript);
        dispatchInput();
      }
    };

    recognition.onerror = (event) => {
      const code = String(event?.error || "");
      if (typeof showFeedback !== "function") return;
      if (code === "not-allowed" || code === "service-not-allowed") showFeedback("Microphone permission was not granted.");
      else if (code === "audio-capture") showFeedback("Microphone unavailable.");
      else if (code !== "aborted" && code !== "no-speech") showFeedback("Could not use voice dictation.");
    };

    recognition.onend = () => {
      listening = false;
      button.dataset.listening = "false";
      button.title = "Voice dictation";
      updateClearState();
    };

    button.addEventListener("click", () => {
      if (listening) {
        recognition.stop();
        return;
      }
      try {
        recognition.start();
      } catch (error) {
        if (typeof showFeedback === "function") showFeedback(error instanceof Error ? error.message : String(error));
      }
    });
  }

  function syncChatIndicator() {
    const pill = document.getElementById("lbChatIndicator");
    const setupCard = document.getElementById("chatSetupCard");
    const connectedCard = document.getElementById("chatConnectedCard");
    if (!pill || !setupCard || !connectedCard) return;

    if (!connectedCard.hidden) {
      pill.dataset.state = "connected";
      pill.title = "ChatGPT connected";
      pill.setAttribute("aria-label", "ChatGPT connected");
      return;
    }
    if (!setupCard.hidden) {
      pill.dataset.state = "disconnected";
      pill.title = "ChatGPT not connected";
      pill.setAttribute("aria-label", "ChatGPT not connected");
      return;
    }
    pill.dataset.state = "checking";
    pill.title = "Checking connection...";
    pill.setAttribute("aria-label", "Checking connection to ChatGPT");
  }

  function buildComposer() {
    const card = document.querySelector(".command-card");
    const editor = input?.closest(".editor");
    const skills = document.getElementById("activeSkillsStrip");
    const attachmentZone = document.querySelector(".lb-attachment-zone");
    if (!card || !editor || !sendButton || !attachmentZone || document.getElementById("lbComposerShell")) return;

    const list = attachmentZone.querySelector(".lb-attachment-list");
    const attachButton = attachmentZone.querySelector(".lb-attach-button");
    const picker = attachmentZone.querySelector(".lb-file-input");

    const shell = document.createElement("div");
    shell.id = "lbComposerShell";
    shell.className = "lb-composer-shell";
    const previews = document.createElement("div");
    previews.className = "lb-composer-previews";
    const toolbar = document.createElement("div");
    toolbar.className = "lb-composer-toolbar";

    const enhanceButton = document.createElement("button");
    enhanceButton.id = "lbEnhancePromptButton";
    enhanceButton.className = "lb-tool-button lb-enhance-button";
    enhanceButton.type = "button";
    enhanceButton.title = "Enhance prompt";
    enhanceButton.setAttribute("aria-label", "Enhance prompt");
    enhanceButton.textContent = "✦";

    const chatIndicator = document.createElement("button");
    chatIndicator.id = "lbChatIndicator";
    chatIndicator.className = "lb-chat-indicator";
    chatIndicator.type = "button";
    chatIndicator.dataset.state = "checking";
    chatIndicator.innerHTML = '<i></i><span class="lb-chat-full">ChatGPT</span><span class="lb-chat-short">GPT</span>';

    const micButton = document.createElement("button");
    micButton.id = "lbMicButton";
    micButton.className = "lb-tool-button lb-mic-button";
    micButton.type = "button";
    micButton.title = "Voice dictation";
    micButton.setAttribute("aria-label", "Voice dictation");
    micButton.textContent = "🎙";

    const clearButton = document.createElement("button");
    clearButton.id = "lbClearComposerButton";
    clearButton.className = "lb-tool-button lb-clear-button";
    clearButton.type = "button";
    clearButton.title = "Clear request";
    clearButton.setAttribute("aria-label", "Clear request");
    clearButton.textContent = "🗑";

    editor.parentNode.insertBefore(shell, editor);
    shell.appendChild(editor);
    if (list) previews.appendChild(list);
    if (picker) previews.appendChild(picker);
    shell.appendChild(previews);
    if (skills) shell.appendChild(skills);

    if (attachButton) {
      attachButton.classList.add("lb-tool-button");
      attachButton.title = "Attach file";
      attachButton.setAttribute("aria-label", "Attach file");
      toolbar.appendChild(attachButton);
    }
    toolbar.appendChild(enhanceButton);
    toolbar.appendChild(chatIndicator);
    toolbar.appendChild(micButton);
    sendButton.classList.add("lb-toolbar-send");
    sendButton.title = "Send request";
    sendButton.setAttribute("aria-label", "Send request");
    toolbar.appendChild(sendButton);
    toolbar.appendChild(clearButton);
    shell.appendChild(toolbar);
    attachmentZone.remove();

    if (input) {
      input.placeholder = "Enter your request...";
      input.setAttribute("rows", "5");
      input.addEventListener("input", updateClearState);
    }
    enhanceButton.addEventListener("click", () => void enhancePrompt(enhanceButton));
    clearButton.addEventListener("click", clearComposer);
    chatIndicator.addEventListener("click", () => {
      const connectedCard = document.getElementById("chatConnectedCard");
      if (connectedCard && !connectedCard.hidden) {
        const open = document.getElementById("openChatgptButton");
        open?.click();
      } else {
        document.getElementById("chatSetupCard")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
    });
    setupSpeech(micButton);

    const connectedCard = document.getElementById("chatConnectedCard");
    const setupCard = document.getElementById("chatSetupCard");
    if (connectedCard) new MutationObserver(syncChatIndicator).observe(connectedCard, { attributes: true, attributeFilter: ["hidden"] });
    if (setupCard) new MutationObserver(syncChatIndicator).observe(setupCard, { attributes: true, attributeFilter: ["hidden"] });
    if (list) new MutationObserver(updateClearState).observe(list, { childList: true });

    syncChatIndicator();
    updateClearState();
  }

  if (footer) footer.dataset.compact = "true";
  createSettingsPanel();
  void loadCheckConfig();
  buildComposer();
  pauseCheckButton?.addEventListener("click", () => void toggleAutoCheck());
  function setupSpecialProjectActions() {
    const footer = document.querySelector(".app-footer");
    if (!footer || document.getElementById("createProjectButton")) return;
    const create = document.createElement("button"); create.id = "createProjectButton"; create.type = "button"; create.textContent = "＋ Create Project";
    const analyze = document.createElement("button"); analyze.id = "analyzeProjectButton"; analyze.type = "button"; analyze.textContent = "⌁ Analyze Project";
    footer.insertBefore(create, document.getElementById("settingsButton")); footer.insertBefore(analyze, document.getElementById("settingsButton"));
    const modal = document.createElement("section"); modal.className = "lb-special-modal"; modal.id = "specialProjectModal"; modal.hidden = true; modal.setAttribute("role", "dialog"); modal.setAttribute("aria-modal", "true");
    modal.innerHTML = '<div class="lb-special-modal-card"><button class="lb-special-close" type="button" aria-label="Close">×</button><span class="mock-label">// NEW PROJECT</span><h2>Set up your project</h2><p>Briefly describe what you want to create. LovaRPM will prepare a minimal request to start the project.</p><textarea rows="4" maxlength="500" placeholder="A restaurant ordering system"></textarea><div class="lb-special-actions"><button class="button-secondary" type="button">Cancel</button><button class="button-primary" type="button">Generate project</button></div><p class="lb-special-feedback" aria-live="polite"></p></div>';
    document.body.appendChild(modal);
    const input = modal.querySelector("textarea"), submit = modal.querySelector(".button-primary"), feedback = modal.querySelector(".lb-special-feedback");
    let mode = "create-project";
    const openLovableDashboard = async () => {
      const pattern = "https://lovable.dev/*";
      const dashboard = "https://lovable.dev/dashboard";
      const tabs = await chrome.tabs.query({ url: [pattern] });
      const tab = tabs.find((item) => item.active) || tabs[0];
      if (tab?.id) await chrome.tabs.update(tab.id, { url: dashboard, active: true });
      else await chrome.tabs.create({ url: dashboard, active: true });
    };
    const close = () => { modal.hidden = true; if (input) input.value = ""; if (feedback) feedback.textContent = ""; };
    modal.querySelector(".lb-special-close")?.addEventListener("click", close); modal.querySelector(".button-secondary")?.addEventListener("click", close);
    create.addEventListener("click", () => { mode = "create-project"; modal.querySelector(".mock-label").textContent = "// NEW PROJECT"; modal.querySelector("h2").textContent = "Set up your project"; modal.querySelector("p").textContent = "Briefly describe what you want to create. LovaRPM will prepare a minimal request to start the project."; input.hidden = false; input.placeholder = "A restaurant ordering system"; submit.textContent = "Generate project"; modal.hidden = false; input.focus(); });
    input.addEventListener("focus", () => { if (mode === "create-project") void openLovableDashboard(); });
    analyze.addEventListener("click", async () => { mode = "analyze-project"; modal.querySelector(".mock-label").textContent = "// ANALYZE PROJECT"; modal.querySelector("h2").textContent = "Analyze project in a new chat"; modal.querySelector("p").textContent = "LovaRPM will open a new ChatGPT conversation and load the repository's technical context. No files will be changed during the analysis."; input.hidden = true; input.value = ""; submit.textContent = "Analyze project"; modal.hidden = false; submit.focus(); });
    submit.addEventListener("click", async () => {
      submit.disabled = true; if (feedback) feedback.textContent = "Preparing operation…";
      try {
        const currentWorkspace = typeof workspace !== "undefined" ? workspace : {};
        const payload = { lovableProjectId: currentWorkspace.lovableProjectId || "AUTO_NOT_DETECTED", platform: currentWorkspace.platform || "lovable", repository: currentWorkspace.repository || "AUTO_NOT_DETECTED", title: currentWorkspace.sourceTitle || (mode === "create-project" ? "New project" : ""), sourceUrl: currentWorkspace.sourceUrl || "" };
        if (mode === "create-project") payload.text = String(input.value || "").trim();
        if (mode === "create-project" && !payload.text) throw new Error("Describe the project before continuing.");
        if (mode === "analyze-project" && !/^[^/\s]+\/[^/\s]+$/.test(payload.repository)) throw new Error("Connect this project's GitHub repository before starting the in-depth analysis.");
        if (feedback) feedback.textContent = "Preparing the prompt on the server…";
        const prepared = await chrome.runtime.sendMessage({ type: "LOVABURST_PREPARE_SPECIAL_OPERATION", operation: mode, payload });
        if (!prepared?.ok || !prepared.prompt) throw new Error(prepared?.error || "The server did not prepare this operation.");
        if (mode === "analyze-project") {
          if (feedback) feedback.textContent = "Opening a new chat and sending the analysis…";
          await newConversation({ initialPrompt: prepared.prompt });
          if (feedback) feedback.textContent = "Analysis sent to the new ChatGPT chat.";
          setTimeout(close, 900);
          return;
        }
        const platformName = "Lovable";
        const tabs = await chrome.tabs.query({ url: ["https://lovable.dev/*"] });
        const tab = tabs.find((item) => payload.lovableProjectId !== "AUTO_NOT_DETECTED" && item.url?.includes(payload.lovableProjectId)) || tabs.find((item) => item.active) || null;
        if (!tab?.id) throw new Error(`Open the ${platformName} dashboard before sending the prompt.`);
        await chrome.tabs.update(tab.id, { active: true });
        await waitForTabComplete(tab.id);
        const authorization = await chrome.runtime.sendMessage({ type: "LOVARPM_LICENSE_AUTHORIZE" });
        const remainingMs = Number(authorization?.remainingMs);
        if (!authorization?.ok || !authorization.status?.valid || !Number.isFinite(remainingMs) || remainingMs <= 250) {
          throw new Error(authorization?.status?.message || "A valid LovaRPM license is required.");
        }
        const authorizationDeadline = performance.now() + remainingMs;
        if (performance.now() + 250 >= authorizationDeadline) throw new Error("The license expired before the prompt could be prepared.");
        const injected = await chrome.scripting.executeScript({ target: { tabId: tab.id }, args: [prepared.prompt], func: (prompt) => {
          const selectors = ["textarea", "[contenteditable='true']", "[role='textbox']"];
          const input = selectors.map((selector) => [...document.querySelectorAll(selector)]).flat().find((element) => {
            const rect = element.getBoundingClientRect(); const style = getComputedStyle(element);
            return rect.width > 220 && rect.height > 28 && style.display !== "none" && style.visibility !== "hidden";
          });
          if (!input) return { ok: false, error: "Could not find the platform's prompt field." };
          input.focus();
          if (input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement) {
            const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
            if (setter) setter.call(input, prompt); else input.value = prompt;
          } else { input.textContent = prompt; }
          input.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: prompt }));
          input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
          return { ok: true };
        }});
        if (!injected?.[0]?.result?.ok) throw new Error(injected?.[0]?.result?.error || `Could not fill in the prompt on ${platformName}.`);
        await chrome.tabs.create({ url: "https://chatgpt.com/", active: false });
        if (feedback) feedback.textContent = `Prompt prepared in ${platformName}. Review and send it there; a new ChatGPT conversation has been opened for you to connect later.`;
        setTimeout(close, 900);
      } catch (error) { if (feedback) feedback.textContent = error instanceof Error ? error.message : String(error); }
      finally { submit.disabled = false; }
    });
  }
  setupSpecialProjectActions();
  renderCountdown();
  compactFeedback();
  window.setInterval(renderCountdown, 1000);
  if (statusMain) new MutationObserver(renderCountdown).observe(statusMain, { attributes: true, attributeFilter: ["data-status"] });
  if (feedback) new MutationObserver(compactFeedback).observe(feedback, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ["hidden"] });
  chrome.storage.onChanged.addListener((changes, area) => { if (area === "local" && changes.config) void loadCheckConfig(); });
})();
