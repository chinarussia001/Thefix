(() => {
  if (window.__LOVABURST_CONTEXT_GUARD__) return;
  window.__LOVABURST_CONTEXT_GUARD__ = true;

  function isExtensionContextInvalidation(reason) {
    const message = String(reason?.message || reason || "").toLowerCase();
    return (
      message.includes("extension context invalidated") ||
      message.includes("context invalidated")
    );
  }

  addEventListener("unhandledrejection", (event) => {
    if (!isExtensionContextInvalidation(event.reason)) return;
    event.preventDefault();
  });
})();
