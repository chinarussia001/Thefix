import { buildWrapper } from "./prm-wrapper.js";
import { getMigrationKey } from "./migration-key.js";

const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_PREFIX = "context:";

function repositoryParts(value) {
  const match = String(value || "").trim().match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  return match ? { owner: match[1], name: match[2] } : null;
}

function cacheKey(projectId) {
  return `${CACHE_PREFIX}${projectId}`;
}

export async function invalidateProjectContext(projectId) {
  const id = String(projectId || "").trim();
  if (id) await chrome.storage.local.remove(cacheKey(id));
}

export async function invalidateAllProjectContexts() {
  const stored = await chrome.storage.local.get(null);
  const keys = Object.keys(stored).filter((key) => key.startsWith(CACHE_PREFIX));
  if (keys.length) await chrome.storage.local.remove(keys);
}

async function collectProjectContext(projectId) {
  const stored = await chrome.storage.local.get([
    "workspaceBindings",
    "projectChatBindings",
    "projectIntegrations",
    "pendingPrompt",
    "lastPlatformWorkspaces",
    "lastLovableWorkspace",
  ]);
  const binding = stored.workspaceBindings?.[projectId] || {};
  const chat = stored.projectChatBindings?.[projectId] || {};
  const pending = stored.pendingPrompt?.lovableProjectId === projectId ? stored.pendingPrompt : {};
  const remembered = Object.values(stored.lastPlatformWorkspaces || {}).find((item) => item?.lovableProjectId === projectId)
    || (stored.lastLovableWorkspace?.lovableProjectId === projectId ? stored.lastLovableWorkspace : {});
  const repository = repositoryParts(binding.repository || chat.repository || pending.repository || remembered.repository);
  const integration = stored.projectIntegrations?.[projectId] || {};
  const supabaseRef = String(integration.supabase?.projectRef || "").trim();
  const tabs = await chrome.tabs.query({ url: ["https://lovable.dev/projects/*"] });
  const editor = tabs.find((tab) => tab.url?.includes(projectId));
  const editorUrl = String(editor?.url || chat.sourceUrl || pending.url || remembered.sourceUrl || "").trim();
  const previewHost = String(integration.previewHost || `https://${projectId}.lovableproject.com`).trim();
  const key = await getMigrationKey(projectId);
  const runnerUrl = key && previewHost
    ? `${previewHost.replace(/\/$/, "")}/api/public/ops/run-migrations?key=${encodeURIComponent(key)}`
    : null;

  return {
    repo: repository,
    branch: String(binding.branch || chat.branch || "main").trim() || "main",
    projectId,
    editorUrl,
    supabaseRef: supabaseRef || null,
    previewHost: previewHost || null,
    runnerUrl,
  };
}

export async function gatherProjectContext(projectId) {
  const id = String(projectId || "").trim();
  if (!id) throw new Error("Project ID was not provided.");
  const key = cacheKey(id);
  const cached = (await chrome.storage.local.get(key))[key];
  const migrationKey = await getMigrationKey(id);
  if (
    cached?.context &&
    cached.migrationKey === migrationKey &&
    Date.now() - Number(cached.cachedAt || 0) < CACHE_TTL_MS
  ) return cached.context;

  const context = await collectProjectContext(id);
  await chrome.storage.local.set({ [key]: { context, migrationKey, cachedAt: Date.now() } });
  return context;
}

export async function buildDispatchEnvelope(projectId, userPrompt) {
  const context = await gatherProjectContext(projectId);
  return buildWrapper(context, userPrompt);
}
