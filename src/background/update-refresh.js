const INTEGRATION_URL_PATTERNS = ["https://lovable.dev/*", "https://chatgpt.com/*"];
const REFRESH_REASONS = new Set(["install", "update"]);

async function refreshIntegrationTabs(reason) {
  if (!REFRESH_REASONS.has(reason)) return;

  try {
    const tabs = await chrome.tabs.query({ url: INTEGRATION_URL_PATTERNS });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await Promise.allSettled(
      tabs
        .filter((tab) => Number.isInteger(tab.id) && !tab.discarded)
        .map((tab) => chrome.tabs.reload(tab.id)),
    );
  } catch (error) {
    console.warn("[LovaRPM] Não foi possível recarregar as abas após instalação/atualização:", error);
  }
}

chrome.runtime.onInstalled.addListener((details) => {
  void refreshIntegrationTabs(details?.reason);
});
