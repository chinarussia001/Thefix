"use strict";

(() => {
  const input = document.getElementById("commandInput");
  const oldButton = document.getElementById("lbEnhancePromptButton");
  if (!input || !oldButton) return;

  const button = oldButton.cloneNode(true);
  oldButton.replaceWith(button);

  function feedback(message) {
    if (typeof showFeedback === "function") showFeedback(message);
  }

  async function currentProjectId() {
    const fromWorkspace = String(
      globalThis.workspace?.lovableProjectId ||
      (typeof workspace !== "undefined" ? workspace?.lovableProjectId : "") ||
      "",
    ).trim();
    if (fromWorkspace) return fromWorkspace;
    const value = String(document.getElementById("projectValue")?.textContent || "").trim();
    return value === "—" ? "" : value;
  }

  async function findLovableTab(projectId) {
    const base44 = globalThis.workspace?.platform === "base44" || (typeof workspace !== "undefined" && workspace?.platform === "base44");
    const tabs = await chrome.tabs.query({ url: [base44 ? "https://app.base44.com/apps/*" : "https://lovable.dev/*"] });
    return tabs.find((tab) => tab.url?.includes(projectId)) || null;
  }

  button.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();

    const text = String(input.value || "").trim();
    if (!text) {
      input.focus();
      feedback("Enter a request before enhancing it.");
      return;
    }

    const projectId = await currentProjectId();
    if (!projectId) {
      feedback(`Open a ${globalThis.workspace?.platform === "base44" ? "Base44" : "Lovable"} project before enhancing the prompt.`);
      return;
    }

    const idleMarkup = button.innerHTML;
    const iconMarkup = button.querySelector("svg")?.outerHTML || "✦";
    button.disabled = true;
    button.dataset.loading = "true";
    button.dataset.enhancing = "true";
    button.title = "Enhancing prompt…";
    button.innerHTML = `${iconMarkup}<span class="lb-tool-label">Enhancing...</span>`;
    const pulseAnimation = button.animate(
      [
        { opacity: .72, transform: "scale(1)" },
        { opacity: 1, transform: "scale(1.04)" },
        { opacity: .72, transform: "scale(1)" },
      ],
      { duration: 1200, iterations: Infinity, easing: "ease-in-out" },
    );

    let timeoutId = null;
    try {
      const source = await findLovableTab(projectId);
      if (!source?.id) throw new Error(`Could not find this project's ${globalThis.workspace?.platform === "base44" ? "Base44" : "Lovable"} tab.`);

      const timeout = new Promise((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error("ChatGPT took too long to return the enhanced prompt.")),
          110000,
        );
      });

      const response = await Promise.race([
        chrome.tabs.sendMessage(source.id, {
          type: "LOVABURST_ENHANCE_FROM_POPUP",
          text,
          projectId,
        }),
        timeout,
      ]);

      const enhanced = String(response?.text || "").trim();
      if (!response?.ok || !enhanced) {
        throw new Error(response?.error || "ChatGPT did not return an enhanced prompt.");
      }

      input.value = enhanced;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.focus();
      input.setSelectionRange?.(input.value.length, input.value.length);
      button.dataset.success = "true";
      feedback("Prompt enhanced.");
      setTimeout(() => { delete button.dataset.success; }, 900);
    } catch (error) {
      feedback(error instanceof Error ? error.message : String(error));
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      pulseAnimation.cancel();
      button.innerHTML = idleMarkup;
      button.disabled = false;
      button.dataset.loading = "false";
      button.dataset.enhancing = "false";
      button.title = "Enhance prompt";
    }
  });
})();
