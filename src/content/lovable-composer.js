(() => {
  if (window.__LOVABURST_NATIVE_COMPOSER__) return;
  window.__LOVABURST_NATIVE_COMPOSER__ = true;
  const core = globalThis.__LOVABURST_COMPOSER_CORE__;
  if (!core) return;

  const UI_ID = "lovaburst-composer-ui";
  const TOAST_LOGO_URL = chrome.runtime.getURL("assets/logo.png");
  const OLD_BUTTON_ID = "lovaburst-capture-button";
  let uiHost = null, shadow = null, controls = null, toast = null, frame = null, observer = null, scanTimer = null;
  let busy = false, lastPointerSubmitAt = 0, lastPath = location.pathname;
  let originalPaddingRight = "", decoratedHost = null, lastStatusSignature = "", toastTimer = null, frameResetTimer = null;

  const css = `:host{all:initial}.lb-controls{position:fixed;z-index:2147483645;display:flex;gap:4px;align-items:center;font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}.lb-btn{height:27px;min-width:27px;border:1px solid rgba(148,163,184,.14);border-radius:8px;background:rgba(7,9,16,.78);color:#94a3b8;box-shadow:0 5px 16px rgba(0,0,0,.16);backdrop-filter:blur(10px);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:5px;padding:0 7px;font:650 10px/1 system-ui;transition:background .2s ease,border-color .2s ease,color .2s ease,box-shadow .2s ease}.lb-btn:hover{background:rgba(15,23,42,.9);color:#e2e8f0}.lb-mode[data-on="true"]{color:#a5f3fc;border-color:rgba(34,211,238,.42);background:linear-gradient(125deg,rgba(6,182,212,.2),rgba(37,99,235,.16) 52%,rgba(79,70,229,.2));box-shadow:0 0 0 1px rgba(34,211,238,.06),0 0 16px rgba(37,99,235,.15)}.lb-dot{width:5px;height:5px;border-radius:50%;background:currentColor;box-shadow:0 0 8px currentColor}.lb-boost{color:#c4b5fd}.lb-controls[data-active="true"] .lb-boost{border-color:rgba(139,92,246,.25);box-shadow:0 0 12px rgba(124,58,237,.08)}.lb-btn:disabled{opacity:.42;cursor:default}.lb-frame{position:fixed;z-index:2147483644;pointer-events:none;box-sizing:border-box;opacity:0;transition:opacity .22s ease,filter .22s ease,box-shadow .22s ease}.lb-frame::before{content:"";position:absolute;inset:0;padding:1.5px;border-radius:inherit;background:linear-gradient(125deg,#22d3ee 0%,#0ea5e9 23%,#2563eb 46%,#4f46e5 70%,#8b5cf6 100%);background-size:220% 220%;-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask-composite:exclude;opacity:.96}.lb-frame::after{content:"";position:absolute;inset:1px;border-radius:inherit;background:radial-gradient(circle at 7% 30%,rgba(34,211,238,.075),transparent 38%),radial-gradient(circle at 93% 70%,rgba(124,58,237,.075),transparent 40%);opacity:.9}.lb-frame[data-active="true"]{opacity:1;box-shadow:-7px 0 24px rgba(34,211,238,.12),7px 0 26px rgba(79,70,229,.13),0 0 0 1px rgba(37,99,235,.04)}.lb-frame[data-state="working"]::before{background-size:260% 260%;animation:lbframeflow 5.5s ease-in-out infinite}.lb-frame[data-state="working"]{box-shadow:-8px 0 28px rgba(34,211,238,.15),8px 0 30px rgba(99,102,241,.16)}.lb-frame[data-state="done"]::before{background:#34d399}.lb-frame[data-state="done"]::after{background:radial-gradient(circle at 50% 50%,rgba(52,211,153,.08),transparent 62%)}.lb-frame[data-state="done"]{box-shadow:0 0 24px rgba(52,211,153,.14)}.lb-frame[data-state="blocked"]::before{background:#f59e0b}.lb-frame[data-state="blocked"]::after{background:radial-gradient(circle at 50% 50%,rgba(245,158,11,.07),transparent 62%)}.lb-frame[data-state="blocked"]{box-shadow:0 0 22px rgba(245,158,11,.12)}.lb-frame[data-state="error"]::before{background:#fb7185}.lb-frame[data-state="error"]::after{background:radial-gradient(circle at 50% 50%,rgba(251,113,133,.07),transparent 62%)}.lb-frame[data-state="error"]{box-shadow:0 0 22px rgba(251,113,133,.12)}.lb-toast{position:fixed;z-index:2147483646;left:50%;top:72px;transform:translate(-50%,-8px);width:min(340px,calc(100vw - 32px));box-sizing:border-box;padding:11px 38px 11px 13px;border:1px solid rgba(34,211,238,.2);border-radius:13px;background:rgba(7,9,16,.9);color:#e2e8f0;box-shadow:0 18px 48px rgba(0,0,0,.32),0 0 30px rgba(79,70,229,.07);backdrop-filter:blur(16px);font-family:Inter,ui-sans-serif,system-ui;opacity:0;pointer-events:none;transition:opacity .18s ease,transform .18s ease}.lb-toast[data-open="true"]{opacity:1;transform:translate(-50%,0);pointer-events:auto}.lb-toast[data-state="done"]{border-color:rgba(52,211,153,.34)}.lb-toast[data-state="blocked"]{border-color:rgba(245,158,11,.36)}.lb-toast[data-state="error"]{border-color:rgba(251,113,133,.38)}.lb-toast-title{display:flex;align-items:center;gap:7px;font:700 11px/1.2 system-ui;color:#f8fafc}.lb-toast-mark{width:18px;height:18px;flex:0 0 18px;display:grid;place-items:center}.lb-toast-mark img{width:18px;height:18px;display:block;object-fit:contain;filter:drop-shadow(0 0 7px rgba(34,211,238,.18))}.lb-toast-text{margin-top:5px;font:500 11px/1.35 system-ui;color:#94a3b8}.lb-close{position:absolute;right:8px;top:8px;width:24px;height:24px;border:0;border-radius:7px;background:transparent;color:#64748b;cursor:pointer}.lb-close:hover{background:rgba(255,255,255,.06);color:#cbd5e1}@keyframes lbframeflow{0%,100%{background-position:0% 50%}50%{background-position:100% 50%}}@media(max-width:520px){.lb-label{display:none}.lb-btn{padding:0;min-width:27px}}@media(prefers-reduced-motion:reduce){.lb-btn,.lb-toast,.lb-frame{transition:none}.lb-spinner,.lb-frame[data-state="working"]::before{animation:none}}`;

  function ensureUI() {
    document.getElementById(OLD_BUTTON_ID)?.remove();
    uiHost = document.getElementById(UI_ID);
    if (!uiHost) {
      uiHost = document.createElement("div"); uiHost.id = UI_ID;
      shadow = uiHost.attachShadow({ mode: "open" });
      shadow.innerHTML = `<style>${css}</style><div class="lb-frame" aria-hidden="true"></div><div class="lb-controls"><button class="lb-btn lb-mode" type="button"><span class="lb-dot"></span><span class="lb-label">LovaRPM</span></button></div><div class="lb-toast" role="status" aria-live="polite"><button class="lb-close" type="button" aria-label="Close">×</button><div class="lb-toast-title"><span class="lb-toast-mark"><img src="${TOAST_LOGO_URL}" alt="" aria-hidden="true"></span><span class="lb-toast-heading">LovaRPM</span></div><div class="lb-toast-text"></div></div>`;
      document.documentElement.appendChild(uiHost);
      controls = shadow.querySelector(".lb-controls"); toast = shadow.querySelector(".lb-toast"); frame = shadow.querySelector(".lb-frame");
      shadow.querySelector(".lb-close").addEventListener("click", hideToast);
      shadow.querySelector(".lb-mode").addEventListener("click", async (event) => {
        event.preventDefault(); event.stopPropagation();
        if (!core.state.projectId) return;
        if (!core.state.globalEnabled) { const stored = await chrome.storage.local.get("config"); await chrome.storage.local.set({ config: { ...(stored.config || {}), enabled: true } }); core.state.globalEnabled = true; }
        await core.setMode(!core.state.projectEnabled); renderControls(); decorate();
      });
    } else { shadow = uiHost.shadowRoot; controls = shadow?.querySelector(".lb-controls"); toast = shadow?.querySelector(".lb-toast"); frame = shadow?.querySelector(".lb-frame"); }
    renderControls(); positionControls(); decorate();
  }

  function showToast(state, heading, text, options = {}) {
    if (!toast) return;
    clearTimeout(toastTimer); toast.dataset.state = state || ""; toast.dataset.open = "true";
    toast.querySelector(".lb-toast-mark").innerHTML = `<img src="${TOAST_LOGO_URL}" alt="" aria-hidden="true">`;
    toast.querySelector(".lb-toast-heading").textContent = heading; toast.querySelector(".lb-toast-text").textContent = text;
    toast.querySelector(".lb-close").style.display = options.closable ? "block" : "none";
    if (options.duration) toastTimer = setTimeout(hideToast, options.duration);
  }
  function hideToast() { if (toast) toast.dataset.open = "false"; clearTimeout(toastTimer); }

  function renderControls() {
    if (!shadow) return;
    const active = core.active(), mode = shadow.querySelector(".lb-mode");
    const platformName = "Lovable";
    mode.dataset.on = String(active); mode.querySelector(".lb-label").textContent = active ? "LovaRPM" : platformName;
    mode.title = active ? "Lovable requests are routed to the LovaRPM coding agent." : `Direct ${platformName} mode — requests are sent directly to ${platformName}.`;
    controls.dataset.active = String(active);
  }

  function positionControls() {
    const input = core.state.composer, host = core.state.host;
    if (!controls || !input?.isConnected || !host?.isConnected || !core.visible(input)) {
      if (controls) controls.style.display = "none";
      if (frame) frame.dataset.active = "false";
      return;
    }
    controls.style.display = "flex";
    const hr = host.getBoundingClientRect(), cr = controls.getBoundingClientRect();
    controls.style.left = `${Math.max(8, hr.right - (cr.width || 64) - 10)}px`;
    controls.style.top = `${Math.max(8, hr.top + 9)}px`;
    if (frame) {
      frame.style.left = `${hr.left}px`; frame.style.top = `${hr.top}px`;
      frame.style.width = `${hr.width}px`; frame.style.height = `${hr.height}px`;
      frame.style.borderRadius = getComputedStyle(host).borderRadius || "16px";
    }
  }

  function decorate() {
    const input = core.state.composer, host = core.state.host;
    decoratedHost = host;
    if (!input || !host) { if (frame) frame.dataset.active = "false"; return; }
    if (!originalPaddingRight) originalPaddingRight = input.style.paddingRight || "";
    input.style.paddingRight = core.active() ? "82px" : originalPaddingRight;
    positionControls();
    if (!frame) return;
    const active = core.active();
    frame.dataset.active = String(active);
    if (!active) { frame.dataset.state = ""; return; }
    frame.dataset.state = busy || enhancing ? "working" : (host.dataset.lovaburstStatus || "active");
  }

  function resetFrameSoon(delay = 2200) {
    clearTimeout(frameResetTimer);
    frameResetTimer = setTimeout(() => {
      if (core.state.host?.isConnected) core.state.host.dataset.lovaburstStatus = "active";
      decorate();
    }, delay);
  }

  async function submit() {
    if (!core.active() || busy || !core.state.composer?.isConnected) return;
    const text = core.read(); if (!text) return;
    busy = true; renderControls(); decorate(); showToast("sending", "LovaRPM", "Sending your request...", { loading: true });
    try {
      const response = await chrome.runtime.sendMessage({ type: "LOVABURST_COMPOSER_SUBMIT", objective: text, projectId: core.state.projectId });
      if (!response?.ok) throw new Error(response?.error || "Could not send through LovaRPM.");
      if (core.state.composer?.isConnected && core.read() === text) core.write("");
      showToast("working", "LovaRPM agent", `Task ${response.task?.id || "queued"} is running in the backend.`, { loading: true });
    } catch (error) { showToast("error", "LovaRPM", error instanceof Error ? error.message : "Could not complete the submission.", { closable: true, duration: 9000 }); if (core.state.host) core.state.host.dataset.lovaburstStatus = "error"; resetFrameSoon(); }
    finally { busy = false; renderControls(); decorate(); }
  }

  function syncRunStatus() {
    void core.runStatus().then((run) => {
      const status = run?.status || "", signature = `${status}|${run?.updatedAt || ""}|${run?.marker || ""}`;
      if (!status || signature === lastStatusSignature) return; lastStatusSignature = signature;
      if (core.state.host) core.state.host.dataset.lovaburstStatus = status;
      if (["queued", "inspecting", "planning", "editing", "testing", "repairing", "delivering", "cancelling"].includes(status)) {
        showToast("working", "LovaRPM agent", run.activityText || `Task ${status}.`, { loading: true });
      } else if (status === "completed") { showToast("done", "LovaRPM agent", "Validated changes were delivered.", { duration: 5000 }); resetFrameSoon(1800); }
      else if (status === "attention") { showToast("blocked", "LovaRPM agent", run.error || "The task needs your attention.", { closable: true, duration: 10000 }); resetFrameSoon(); }
      else if (status === "failed") { showToast("error", "LovaRPM agent", run.error || "The task failed.", { closable: true, duration: 10000 }); resetFrameSoon(); }
      else if (status === "cancelled") { showToast("blocked", "LovaRPM agent", "Task cancelled.", { closable: true, duration: 5000 }); resetFrameSoon(); }
      decorate();
    });
  }

  function nativeSend(target) {
    const button = target?.closest?.("button,[role='button']"), input = core.state.composer, host = core.state.host;
    if (!button || !input || !host || uiHost?.contains(button)) return false;
    const form = input.closest("form"), sameArea = host.contains(button) || (form && form.contains(button)) || button.closest("form") === form;
    if (!sameArea || !core.visible(button)) return false;
    const label = [button.getAttribute("aria-label"), button.getAttribute("title"), button.getAttribute("data-testid"), button.getAttribute("name"), button.textContent].filter(Boolean).join(" ").toLowerCase();
    if (/microphone|\bmic\b|voice|voz|audio|áudio|attach|anex|upload|paperclip|\bplus\b|adicionar|\badd\b|mode|modo|settings|config|image|imagem|camera|câmera/.test(label)) return false;
    if (/send|enviar|submit|arrow.?up|seta.?cima/.test(label) || button.getAttribute("type") === "submit" || /send|submit/.test(button.getAttribute("data-testid") || "")) return true;
    const br = button.getBoundingClientRect(), cr = input.getBoundingClientRect();
    return br.width <= 64 && br.height <= 64 && br.right >= cr.right - 92 && Math.abs(br.bottom - cr.bottom) < 95 && Boolean(button.querySelector("svg")) && !label;
  }
  function block(event) { event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation(); }
  function isComposerTarget(target) { const input = core.state.composer; return Boolean(input && target instanceof Node && (target === input || input.contains(target))); }
  function onKey(event) { if (!core.active() || !isComposerTarget(event.target)) return; if (event.key !== "Enter" || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || event.isComposing || event.keyCode === 229) return; block(event); void submit(); }
  function onPointer(event) { if (!core.active() || !nativeSend(event.target)) return; block(event); lastPointerSubmitAt = Date.now(); void submit(); }
  function onClick(event) { if (!core.active() || !nativeSend(event.target)) return; block(event); if (Date.now() - lastPointerSubmitAt >= 900) void submit(); }
  function schedule(delay = 180) { clearTimeout(scanTimer); scanTimer = setTimeout(() => { core.scan(); ensureUI(); }, delay); }
  async function navigation() { if (location.pathname !== lastPath) { lastPath = location.pathname; await core.loadMode(); schedule(60); } else if (!core.state.composer?.isConnected) schedule(80); else { positionControls(); decorate(); } }

  function visibleBootstrapElement(element) {
    if (!(element instanceof HTMLElement) || !element.isConnected) return false;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) > 0;
  }

  function findBootstrapComposer() {
    const selectors = [
      'textarea[placeholder*="Ask Lovable" i]',
      'textarea[placeholder*="Ask" i]',
      'textarea[role="textbox"]',
      'textarea[data-testid*="prompt" i]',
      '[contenteditable="true"][placeholder*="Ask Lovable" i]',
      '[contenteditable="true"][aria-label*="Ask Lovable" i]',
      '[contenteditable="true"][role="textbox"]',
      '[contenteditable="true"][data-testid*="prompt" i]',
    ];
    const candidates = new Set();
    for (const selector of selectors) {
      for (const element of document.querySelectorAll(selector)) candidates.add(element);
    }
    return [...candidates]
      .filter((element) => visibleBootstrapElement(element) && !element.disabled && element.getAttribute("aria-disabled") !== "true")
      .map((element) => {
        const hints = [element.getAttribute("placeholder"), element.getAttribute("aria-label"), element.getAttribute("data-testid"), element.getAttribute("name"), element.getAttribute("id")].filter(Boolean).join(" ").toLowerCase();
        if (/search|filter|find|buscar|filtro/.test(hints)) return { element, score: -Infinity };
        let score = 0;
        if (/ask lovable/.test(hints)) score += 100;
        if (/chat|prompt|lovable/.test(hints)) score += 45;
        if (element.getAttribute("role") === "textbox") score += 30;
        if (element instanceof HTMLTextAreaElement) score += 25;
        if (element.closest("form")) score += 25;
        if (document.activeElement === element) score += 80;
        if (element.closest('[data-testid*="chat" i],[data-testid*="conversation" i],[role="log"]')) score += 60;
        return { element, score };
      })
      .filter((entry) => Number.isFinite(entry.score))
      .sort((left, right) => right.score - left.score)[0]?.element || null;
  }

  function setBootstrapComposerText(element, text) {
    element.focus();
    if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
      const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      if (setter) setter.call(element, text);
      else element.value = text;
    } else {
      const selection = getSelection();
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
    }
    element.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: text }));
    element.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  }

  async function pasteBootstrapIntoComposer(prompt) {
    if (typeof prompt !== "string") throw new Error("Bootstrap prompt is missing.");
    const composer = findBootstrapComposer();
    if (!composer) throw new Error("Composer element not found in Lovable editor");
    setBootstrapComposerText(composer, prompt);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "LOVABLE_PASTE_BOOTSTRAP") {
      pasteBootstrapIntoComposer(message.prompt)
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
      return true;
    }
    return false;
  });

  function start() {
    document.getElementById(OLD_BUTTON_ID)?.remove();
    document.addEventListener("keydown", onKey, true); document.addEventListener("pointerdown", onPointer, true); document.addEventListener("click", onClick, true);
    addEventListener("resize", positionControls, { passive: true }); addEventListener("scroll", positionControls, { passive: true, capture: true }); addEventListener("popstate", () => void navigation());
    const root = document.body || document.documentElement;
    observer = new MutationObserver(() => { document.getElementById(OLD_BUTTON_ID)?.remove(); if (!core.state.composer?.isConnected || !uiHost?.isConnected) schedule(220); }); observer.observe(root, { childList: true, subtree: true });
    chrome.storage.onChanged.addListener((changes, area) => { if (area !== "local") return; if (changes.config || changes[core.MODE_KEY]) void core.loadMode().then(() => { renderControls(); decorate(); }); if (changes[core.RUN_KEY]) syncRunStatus(); });
    setInterval(() => void navigation(), 900); void core.loadMode().finally(() => { core.scan(); ensureUI(); syncRunStatus(); });
  }
  start();
})();
