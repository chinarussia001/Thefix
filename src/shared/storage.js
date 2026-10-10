export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  lovableEnabled: true,
  backendUrl: "http://127.0.0.1:4173",
  apiToken: "",
  selectedModel: "claude-sonnet-4-6",
});

export async function getConfig() {
  const stored = await chrome.storage.local.get("config");
  return { ...DEFAULT_CONFIG, ...(stored.config ?? {}) };
}

export async function setConfig(nextConfig) {
  const allowed = ["enabled", "lovableEnabled", "backendUrl", "apiToken", "selectedModel"];
  const stored = await chrome.storage.local.get("config");
  const config = {
    ...DEFAULT_CONFIG,
    ...(stored.config || {}),
    ...Object.fromEntries(Object.entries(nextConfig || {}).filter(([key]) => allowed.includes(key))),
  };
  await chrome.storage.local.set({ config });
  return config;
}
