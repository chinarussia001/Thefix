import { gatherProjectContext } from "../shared/context-builder.js";
import { generateMigrationKey, getMigrationKey, setMigrationKey } from "../shared/migration-key.js";

export async function setupProject(projectId, sendProgress = () => {}) {
  const id = String(projectId || "").trim();
  if (!id) throw new Error("Project ID was not provided.");
  const setupStorageKey = `projectSetup:${id}`;
  const context = await gatherProjectContext(id);
  if (!context.repo) throw new Error("Connect GitHub first");

  sendProgress({ step: 1, total: 7, message: "Project, repository, and preview detected." });
  let key = await getMigrationKey(id);
  if (!key) key = await setMigrationKey(id, generateMigrationKey());
  else await setMigrationKey(id, key);

  const stored = await chrome.storage.local.get(setupStorageKey);
  const record = stored[setupStorageKey] || {};
  await chrome.storage.local.set({
    [setupStorageKey]: { ...record, setupComplete: false, keyFingerprint: key.slice(0, 8), updatedAt: new Date().toISOString() },
  });

  const error = "GitHub file commit helper is unavailable in this LovaRPM build; migration routes were not written.";
  await chrome.storage.local.set({
    [setupStorageKey]: { ...record, setupComplete: false, keyFingerprint: key.slice(0, 8), error, updatedAt: new Date().toISOString() },
  });
  throw new Error(error);
}
