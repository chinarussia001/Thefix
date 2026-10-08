const STORAGE_KEY = "projectMigrationKeys";

export function generateMigrationKey() {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export async function getMigrationKey(projectId) {
  const id = String(projectId || "").trim();
  if (!id) return "";
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return String(stored[STORAGE_KEY]?.[id] || "");
}

export async function setMigrationKey(projectId, key) {
  const id = String(projectId || "").trim();
  const value = String(key || "").trim().toLowerCase();
  if (!id) throw new Error("Project ID was not provided.");
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("Migration key must be 32-byte lowercase hex.");
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const keys = stored[STORAGE_KEY] || {};
  await chrome.storage.local.set({ [STORAGE_KEY]: { ...keys, [id]: value } });
  return value;
}

export async function getMigrationKeyFingerprint(projectId) {
  return (await getMigrationKey(projectId)).slice(0, 8);
}
