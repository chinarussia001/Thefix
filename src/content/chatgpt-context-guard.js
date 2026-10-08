(() => {
  if (window.__LOVABURST_CHATGPT_CONTEXT_GUARD__) return;
  window.__LOVABURST_CHATGPT_CONTEXT_GUARD__ = true;

  const isContextInvalidation = (value) => {
    const message = String(value?.message || value?.reason?.message || value?.reason || value || "").toLowerCase();
    return message.includes("extension context invalidated") || message.includes("context invalidated");
  };

  window.addEventListener("unhandledrejection", (event) => {
    if (!isContextInvalidation(event.reason)) return;
    event.preventDefault();
  });

  window.addEventListener("error", (event) => {
    if (!isContextInvalidation(event.error || event.message)) return;
    event.preventDefault();
  });
})();
