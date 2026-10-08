(() => {
  if (window.__LOVABURST_PREVIEW_REFRESH__) return;
  window.__LOVABURST_PREVIEW_REFRESH__ = true;

  const RUN_KEY = "projectRunStatuses";
  const PROJECT_RE = /\/projects\/([A-Za-z0-9-]+)/i;
  let stopped = false;
  let retryTimer = null;
  let lastHandledRun = "";

  function projectId() {
    return location.pathname.match(PROJECT_RE)?.[1] || "";
  }

  function contextAvailable() {
    if (stopped) return false;
    try {
      return Boolean(chrome?.runtime?.id && chrome?.storage?.local);
    } catch {
      return false;
    }
  }

  function isContextInvalidation(error) {
    const message = String(error?.message || error || "").toLowerCase();
    return message.includes("extension context invalidated") || message.includes("context invalidated");
  }

  function stopAfterContextInvalidation() {
    if (stopped) return;
    stopped = true;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    try { chrome.storage.onChanged.removeListener(onStorageChanged); } catch {}
  }

  function normalize(value) {
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function isVisible(element) {
    if (!(element instanceof HTMLElement)) return false;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
  }

  function matchesPreviewCard(button) {
    const label = normalize(button.textContent || button.getAttribute("aria-label") || button.getAttribute("title"));
    if (label !== "atualizar previa" && label !== "update preview") return false;

    let current = button;
    for (let depth = 0; depth < 6 && current; depth += 1, current = current.parentElement) {
      const text = normalize(current.innerText || current.textContent);
      if (
        text.includes("a previa esta desatualizada") ||
        text.includes("previa esta desatualizada") ||
        text.includes("preview is out of date") ||
        text.includes("preview is outdated")
      ) {
        return true;
      }
    }

    return false;
  }

  function findRefreshButton() {
    const candidates = Array.from(document.querySelectorAll('button,[role="button"]'));
    return candidates.find((element) => isVisible(element) && matchesPreviewCard(element)) || null;
  }

  function scheduleRefresh(runSignature, attempt = 0) {
    if (stopped || runSignature !== lastHandledRun) return;
    if (retryTimer) clearTimeout(retryTimer);

    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (stopped || runSignature !== lastHandledRun) return;

      const button = findRefreshButton();
      if (button) {
        button.click();
        return;
      }

      if (attempt < 20) scheduleRefresh(runSignature, attempt + 1);
    }, attempt === 0 ? 350 : 500);
  }

  function handleRun(run) {
    const status = String(run?.status || "").toLowerCase();
    if (status !== "done") return;

    const signature = `${projectId()}|${run?.updatedAt || ""}|${run?.marker || "done"}`;
    if (!projectId() || signature === lastHandledRun) return;

    lastHandledRun = signature;
    scheduleRefresh(signature);
  }

  async function sync() {
    if (!contextAvailable()) {
      stopAfterContextInvalidation();
      return;
    }

    const id = projectId();
    if (!id) return;

    try {
      const stored = await chrome.storage.local.get(RUN_KEY);
      if (!stopped) handleRun(stored[RUN_KEY]?.[id] || null);
    } catch (error) {
      if (isContextInvalidation(error) || !contextAvailable()) {
        stopAfterContextInvalidation();
      }
    }
  }

  function onStorageChanged(changes, area) {
    if (area === "local" && changes[RUN_KEY]) void sync();
  }

  if (!contextAvailable()) {
    stopAfterContextInvalidation();
    return;
  }

  try {
    chrome.storage.onChanged.addListener(onStorageChanged);
  } catch (error) {
    if (isContextInvalidation(error)) {
      stopAfterContextInvalidation();
      return;
    }
  }

  void sync();
})();
