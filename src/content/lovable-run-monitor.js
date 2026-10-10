(() => {
  if (window.__LOVABURST_RUN_MONITOR_V0306__) return;
  window.__LOVABURST_RUN_MONITOR_V0306__ = true;
  window.__LOVABURST_RUN_MONITOR__ = true;
  const KEY = "projectRunStatuses";
  const POSITION_KEY = "lovaburstRunMonitorPosition";
  const PROJECT_RE = /\/(?:projects|apps)\/([A-Za-z0-9-]+)/i;
  const TASK_SYNC_INTERVAL_MS = 15000;
  const VIEWPORT_MARGIN = 12;
  const TOAST_LOGO_URL = chrome.runtime.getURL("assets/logo.png");
  let shadow = null, toast = null, monitor = null;
  let stopped = false;
  let observer = null;
  let initialTimer = null;
  let refreshTimer = null;
  let lastRunStatus = "";
  let dismissed = false;
  let positionLoaded = false;
  let savedPosition = null;
  let dragState = null;

  const styleText = `
    .lb-toast{left:50%!important;right:auto!important;top:50%!important;cursor:grab!important;width:min(460px,calc(100vw - 32px))!important;max-width:calc(100vw - 32px)!important;padding:16px 44px 15px 17px!important;border-radius:15px!important;transform:translate(-50%,-50%) scale(.985)!important}
    .lb-toast[data-open=true]{transform:translate(-50%,-50%) scale(1)!important}
    .lb-toast[data-positioned=true]{transform:scale(.985)!important}.lb-toast[data-positioned=true][data-open=true]{transform:scale(1)!important}.lb-toast[data-dragging=true]{cursor:grabbing!important;transition:none!important}.lb-toast .lb-close{cursor:pointer!important}
    .lb-toast-title{font-size:12px!important;gap:8px!important;user-select:none!important;touch-action:none!important}.lb-toast-title .lb-toast-mark{display:none!important}.lb-toast-logo{width:22px;height:22px;flex:0 0 22px;display:block;filter:drop-shadow(0 0 8px rgba(34,211,238,.14))}.lb-toast-text{font-size:12px!important;line-height:1.45!important;margin-top:6px!important;overflow-wrap:anywhere!important}
    .lb-monitor{margin-top:9px;padding-top:9px;border-top:1px solid rgba(148,163,184,.09);min-width:0}.lb-monitor-activity{display:-webkit-box;color:#cbd5e1;font:600 12px/1.4 system-ui;overflow:hidden;overflow-wrap:anywhere;word-break:break-word;-webkit-box-orient:vertical;-webkit-line-clamp:2}.lb-monitor-activity:empty{display:none}.lb-monitor-progress{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px;margin-top:9px;max-width:280px}.lb-monitor-progress i{height:4px;border-radius:999px;background:rgba(100,116,139,.2)}.lb-monitor-progress i[data-fill=true]{background:linear-gradient(90deg,#22d3ee,#4f46e5);box-shadow:0 0 9px rgba(34,211,238,.12)}.lb-monitor-progress[data-status=done] i{background:#39ff88;box-shadow:0 0 9px rgba(57,255,136,.35)}.lb-monitor-progress[data-status=blocked] i[data-current=true]{background:#f59e0b}.lb-monitor-progress[data-status=error] i[data-current=true]{background:#ff456b;box-shadow:0 0 9px rgba(255,69,107,.32)}.lb-monitor-progress[data-status=working] i[data-current=true]{animation:lbmonpulse 1.35s ease-in-out infinite}.lb-monitor-phase{margin-top:6px;color:#64748b;font:700 9px/1 system-ui;letter-spacing:.1em;text-transform:uppercase}@keyframes lbmonpulse{50%{opacity:.45}}@media(max-width:520px){.lb-toast{width:min(420px,calc(100vw - 24px))!important;max-width:calc(100vw - 24px)!important;padding:15px 42px 14px 15px!important}.lb-monitor-progress{max-width:none}}@media(prefers-reduced-motion:reduce){.lb-monitor-progress[data-status=working] i[data-current=true]{animation:none}}
  `;

  function projectId() { return location.pathname.match(PROJECT_RE)?.[1] || ""; }

  function contextAvailable() {
    if (stopped) return false;
    try {
      return Boolean(chrome?.runtime?.id && chrome?.storage?.local);
    } catch {
      return false;
    }
  }

  function stopAfterContextInvalidation() {
    if (stopped) return;
    stopped = true;
    observer?.disconnect();
    observer = null;
    if (initialTimer) clearTimeout(initialTimer);
    initialTimer = null;
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = null;
    stopDrag();
    try { chrome.storage.onChanged.removeListener(onStorageChanged); } catch {}
  }

  function isContextInvalidation(error) {
    const message = String(error?.message || error || "").toLowerCase();
    return message.includes("extension context invalidated") || message.includes("context invalidated");
  }

  function clampPosition(left, top) {
    if (!toast) return { left, top };
    const rect = toast.getBoundingClientRect();
    const width = rect.width || Math.min(460, Math.max(0, window.innerWidth - 32));
    const height = rect.height || 150;
    const maxLeft = Math.max(VIEWPORT_MARGIN, window.innerWidth - width - VIEWPORT_MARGIN);
    const maxTop = Math.max(VIEWPORT_MARGIN, window.innerHeight - height - VIEWPORT_MARGIN);
    return {
      left: Math.min(Math.max(VIEWPORT_MARGIN, Number(left) || VIEWPORT_MARGIN), maxLeft),
      top: Math.min(Math.max(VIEWPORT_MARGIN, Number(top) || VIEWPORT_MARGIN), maxTop),
    };
  }

  function applyPosition(position) {
    if (!toast || !position || !Number.isFinite(Number(position.left)) || !Number.isFinite(Number(position.top))) return false;
    const next = clampPosition(Number(position.left), Number(position.top));
    toast.style.setProperty("left", `${next.left}px`, "important");
    toast.style.setProperty("top", `${next.top}px`, "important");
    toast.dataset.positioned = "true";
    return true;
  }

  async function loadPosition() {
    if (positionLoaded || !contextAvailable()) return;
    positionLoaded = true;
    try {
      const stored = await chrome.storage.local.get(POSITION_KEY);
      savedPosition = stored[POSITION_KEY] || null;
      applyPosition(savedPosition);
    } catch (error) {
      if (isContextInvalidation(error) || !contextAvailable()) stopAfterContextInvalidation();
    }
  }

  async function savePosition() {
    if (!toast || !contextAvailable()) return;
    const rect = toast.getBoundingClientRect();
    const next = clampPosition(rect.left, rect.top);
    savedPosition = next;
    applyPosition(next);
    try {
      await chrome.storage.local.set({ [POSITION_KEY]: next });
    } catch (error) {
      if (isContextInvalidation(error) || !contextAvailable()) stopAfterContextInvalidation();
    }
  }

  function onDragMove(event) {
    if (!dragState || !toast) return;
    event.preventDefault();
    const next = clampPosition(event.clientX - dragState.offsetX, event.clientY - dragState.offsetY);
    toast.style.setProperty("left", `${next.left}px`, "important");
    toast.style.setProperty("top", `${next.top}px`, "important");
    toast.dataset.positioned = "true";
  }

  function stopDrag() {
    if (!dragState) return;
    dragState = null;
    if (toast) delete toast.dataset.dragging;
    window.removeEventListener("pointermove", onDragMove, true);
    window.removeEventListener("pointerup", onDragEnd, true);
    window.removeEventListener("pointercancel", onDragEnd, true);
  }

  function onDragEnd(event) {
    if (!dragState) return;
    event?.preventDefault?.();
    stopDrag();
    void savePosition();
  }

  function startDrag(event) {
    if (!toast || event.button !== 0) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest(".lb-close,button,a,input,textarea,select,[contenteditable=true]")) return;
    const rect = toast.getBoundingClientRect();
    dragState = { offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top };
    toast.dataset.dragging = "true";
    toast.dataset.positioned = "true";
    toast.style.setProperty("left", `${rect.left}px`, "important");
    toast.style.setProperty("top", `${rect.top}px`, "important");
    event.preventDefault();
    window.addEventListener("pointermove", onDragMove, true);
    window.addEventListener("pointerup", onDragEnd, true);
    window.addEventListener("pointercancel", onDragEnd, true);
  }

  function attach() {
    const host = document.getElementById("lovaburst-composer-ui");
    shadow = host?.shadowRoot || null;
    toast = shadow?.querySelector(".lb-toast") || null;
    if (!shadow || !toast) return false;
    if (!shadow.getElementById("lb-run-monitor-style")) {
      const style = document.createElement("style"); style.id = "lb-run-monitor-style"; style.textContent = styleText; shadow.appendChild(style);
    }
    const close = toast.querySelector(".lb-close");
    if (close && close.dataset.runMonitorBound !== "true") {
      close.dataset.runMonitorBound = "true";
      close.addEventListener("click", () => { dismissed = true; });
    }
    if (toast.dataset.runMonitorDragBound !== "true") {
      toast.dataset.runMonitorDragBound = "true";
      toast.addEventListener("pointerdown", startDrag);
    }
    const title = toast.querySelector(".lb-toast-title");
    if (title && !title.querySelector(".lb-toast-logo")) {
      const logo = document.createElement("img");
      logo.className = "lb-toast-logo";
      logo.setAttribute("aria-hidden", "true");
      logo.alt = "";
      logo.src = TOAST_LOGO_URL;
      title.prepend(logo);
    }
    monitor = shadow.querySelector(".lb-monitor");
    if (!monitor) {
      monitor = document.createElement("div"); monitor.className = "lb-monitor";
      monitor.innerHTML = '<div class="lb-monitor-activity"></div><div class="lb-monitor-progress"><i></i><i></i><i></i><i></i></div><div class="lb-monitor-phase">Working</div>';
      toast.appendChild(monitor);
    }
    if (positionLoaded) applyPosition(savedPosition);
    else void loadPosition();
    return true;
  }

  function render(run) {
    const status = String(run?.status || "idle").toLowerCase();
    const activeStates = ["queued", "inspecting", "planning", "editing", "testing", "repairing", "delivering", "cancelling"];
    const wasActive = activeStates.includes(lastRunStatus);
    const isActive = activeStates.includes(status);
    if (!wasActive && isActive) {
      dismissed = false;
      scheduleRefresh();
    }
    lastRunStatus = status;
    if (!attach()) return;
    const map = {
      queued:[1,"Queued"], inspecting:[1,"Inspecting"], planning:[2,"Planning"], editing:[3,"Editing"],
      testing:[3,"Testing"], repairing:[3,"Repairing"], delivering:[4,"Delivering"],
      completed:[4,"Completed"], failed:[2,"Failed"], cancelled:[0,"Cancelled"],
      cancelling:[3,"Cancelling"], attention:[2,"Needs attention"],
    };
    const [filled,label] = map[status] || [0,"Waiting"];
    const progress = monitor.querySelector(".lb-monitor-progress");
    progress.dataset.status = isActive ? "working" : status;
    [...progress.querySelectorAll("i")].forEach((el,index)=>{el.dataset.fill=String(index<filled);el.dataset.current=String(status!=="completed"&&index===Math.max(0,filled-1));});
    const activity = String(run?.activityText || "").replace(/\s+/g," ").trim().slice(0,220);
    const activityEl = monitor.querySelector(".lb-monitor-activity"); activityEl.textContent = activity; activityEl.title = activity;
    monitor.querySelector(".lb-monitor-phase").textContent = label;
    const visibleStatus = [...activeStates, "completed", "failed", "cancelled", "attention"].includes(status);
    monitor.hidden = !visibleStatus;
    const close = toast.querySelector(".lb-close");
    if (close) close.style.display = visibleStatus ? "block" : "none";
    if (dismissed && visibleStatus) toast.dataset.open = "false";
  }

  async function sync() {
    if (!contextAvailable()) {
      stopAfterContextInvalidation();
      return;
    }
    const id = projectId();
    if (!id) return;
    try {
      const stored = await chrome.storage.local.get(KEY);
      if (!stopped) render(stored[KEY]?.[id] || null);
    } catch (error) {
      if (isContextInvalidation(error) || !contextAvailable()) {
        stopAfterContextInvalidation();
        return;
      }
      console.warn("[LovaRPM] Run monitor sync failed:", error);
    }
  }

  function scheduleRefresh() {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = null;
    if (stopped) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      if (!stopped && ["queued", "inspecting", "planning", "editing", "testing", "repairing", "delivering", "cancelling"].includes(lastRunStatus)) {
        chrome.runtime.sendMessage({ type: "LOVABURST_SYNC_TASKS" }).catch((error) => {
            if (isContextInvalidation(error) || !contextAvailable()) stopAfterContextInvalidation();
        });
      }
      scheduleRefresh();
    }, TASK_SYNC_INTERVAL_MS);
  }

  function onStorageChanged(changes, area) {
    if (area !== "local") return;
    if (changes[KEY]) void sync();
    if (changes[POSITION_KEY] && positionLoaded) {
      savedPosition = changes[POSITION_KEY].newValue || null;
      applyPosition(savedPosition);
    }
  }

  window.addEventListener("resize", () => {
    if (toast?.dataset.positioned === "true") {
      const rect = toast.getBoundingClientRect();
      applyPosition({ left: rect.left, top: rect.top });
    }
  });

  if (!contextAvailable()) {
    stopAfterContextInvalidation();
    return;
  }

  try { chrome.storage.onChanged.addListener(onStorageChanged); } catch (error) {
    if (isContextInvalidation(error)) {
      stopAfterContextInvalidation();
      return;
    }
  }

  observer = new MutationObserver(() => {
    if (!stopped && !monitor?.isConnected) void sync();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  initialTimer = setTimeout(() => void sync(), 500);
  scheduleRefresh();
})();
