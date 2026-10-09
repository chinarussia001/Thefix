const STORAGE_KEY = "projectMigrationKeys";

export async function getMigrationKey(projectId) {
  const id = String(projectId || "").trim();
  if (!id) throw new Error("Project ID was not provided.");
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return typeof stored[STORAGE_KEY]?.[id] === "string" ? stored[STORAGE_KEY][id] : "";
}

export async function setMigrationKey(projectId, key) {
  const id = String(projectId || "").trim();
  const validation = validateKeyInput(key);
  if (!id) throw new Error("Project ID was not provided.");
  if (!validation.ok) throw new Error(validation.error);
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const keys = stored[STORAGE_KEY] || {};
  await chrome.storage.local.set({ [STORAGE_KEY]: { ...keys, [id]: validation.value } });
  return validation.value;
}

export async function clearMigrationKey(projectId) {
  const id = String(projectId || "").trim();
  if (!id) throw new Error("Project ID was not provided.");
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const keys = { ...(stored[STORAGE_KEY] || {}) };
  delete keys[id];
  await chrome.storage.local.set({ [STORAGE_KEY]: keys });
}

export function validateKeyInput(raw) {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { ok: false, error: "Key cannot be empty." };
  }
  return { ok: true, value: raw };
}
