import { gatherProjectContext } from "../shared/context-builder.js";
import {
  generateMigrationKey,
  getMigrationKey,
  setMigrationKey,
  getMigrationKeyFingerprint,
} from "../shared/migration-key.js";
import { buildMigrationRunnerSource } from "../shared/migration-runner-template.js";
import { buildSeedRouteSource } from "../shared/seed-route-template.js";

const RUNNER_PATH = "src/routes/api/public/ops/run-migrations.ts";
const SEED_PATH = "src/routes/api/public/ops/seed-migrations.ts";
const POLL_INTERVAL_MS = 15000;
const POLL_TIMEOUT_MS = 180000;
const DISPATCH_TIMEOUT_MS = 300000;
const BOOTSTRAP_TIMEOUT_MS = 180000;

const EXEC_SQL_BOOTSTRAP_SQL = `create or replace function public.exec_sql(sql_text text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  execute sql_text;
  return jsonb_build_object('ok', true);
exception when others then
  return jsonb_build_object('ok', false, 'error', sqlerrm);
end;
$$;

revoke all on function public.exec_sql(text) from public, anon, authenticated;
grant execute on function public.exec_sql(text) to service_role;`;
const RESULT_MARKERS = new Map([
  ["[PRM_DONE]", "DONE"],
  ["[PRM_BLOCKED]", "BLOCKED"],
  ["[PRM_ERROR]", "ERROR"],
  ["[LOVABURST_DONE]", "DONE"],
  ["[LOVABURST_BLOCKED]", "BLOCKED"],
  ["[LOVABURST_ERROR]", "ERROR"],
  ["[LOVARPM_DONE]", "DONE"],
  ["[LOVARPM_BLOCKED]", "BLOCKED"],
  ["[LOVARPM_ERROR]", "ERROR"],
]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function setupProject(projectId, sendProgress = () => {}) {
  const id = String(projectId || "").trim();
  if (!id) throw new Error("Project ID was not provided.");
  const setupStorageKey = `projectSetup:${id}`;
  let key = "";

  try {
    sendProgress({ step: 1, total: 9, message: "Detecting project state..." });
    const context = await gatherProjectContext(id);
    if (!context.repo) throw new Error("Connect GitHub first");

    const previewHost = String(context.previewHost || `https://${id}.lovableproject.com`).replace(/\/$/, "");
    key = await getMigrationKey(id);
    if (!key) key = generateMigrationKey();
    await setMigrationKey(id, key);
    const previousSetup = (await chrome.storage.local.get(setupStorageKey))[setupStorageKey] || {};
    const wasSetupComplete = previousSetup.setupComplete === true;
    await persistSetupState(setupStorageKey, {
      setupComplete: false,
      keyFingerprint: await getMigrationKeyFingerprint(id),
      error: null,
    });

    const runnerUrl = `${previewHost}/api/public/ops/run-migrations?key=${encodeURIComponent(key)}`;
    const runnerExists = await probeRouteExists(runnerUrl);
    if (wasSetupComplete && runnerExists) {
      sendProgress({ step: 8, total: 9, message: "Verifying existing migration runner..." });
      const verify = await fetchJson(runnerUrl);
      if (!verify.ok || verify.status !== 200 || verify.body?.ok !== true) {
        throw new Error(verify.body?.error || verify.error || "runner verification failed");
      }
      sendProgress({ step: 9, total: 9, message: "Setup complete." });
      await persistSetupState(setupStorageKey, {
        setupComplete: true,
        setupAt: previousSetup.setupAt || new Date().toISOString(),
        error: null,
        keyFingerprint: await getMigrationKeyFingerprint(id),
      });
      return { ok: true, key, previewHost };
    }
    if (!runnerExists) {
      sendProgress({ step: 2, total: 9, message: "Dispatching runner route to ChatGPT..." });
      const objective = buildSetupRequest({
        branch: context.branch || "main",
        runnerSource: buildMigrationRunnerSource(key),
        seedSource: buildSeedRouteSource(key),
      });
      const dispatchedAt = Date.now();
      const dispatch = await dispatchSetupRequest(id, objective);
      if (!dispatch?.ok) throw new Error(dispatch?.error || "ChatGPT dispatch failed.");

      sendProgress({ step: 3, total: 9, message: "Waiting for ChatGPT to commit routes..." });
      const reply = await waitForProjectCompletion(id, dispatchedAt, DISPATCH_TIMEOUT_MS);
      if (!reply?.marker) throw new Error("ChatGPT did not report completion for setup commit.");
      if (reply.marker !== "DONE") throw new Error(`ChatGPT reported [PRM_${reply.marker}] during setup.`);
      await persistSetupState(setupStorageKey, { commitSha: reply.commitSha || null });
    } else {
      sendProgress({ step: 2, total: 9, message: "Runner route already present, skipping commit." });
      sendProgress({ step: 3, total: 9, message: "Using existing route." });
    }

    sendProgress({ step: 4, total: 9, message: "Waiting for Lovable to deploy the runner route..." });
    const deployed = await pollForDeploy(runnerUrl, {
      intervalMs: POLL_INTERVAL_MS,
      timeoutMs: POLL_TIMEOUT_MS,
    });
    if (!deployed.ok) throw new Error(deployed.error);

    sendProgress({ step: 5, total: 9, message: "Seeding migration tracking table..." });
    const seedUrl = `${previewHost}/api/public/ops/seed-migrations?key=${encodeURIComponent(key)}`;
    const seedResult = await fetchJson(seedUrl);
    assertHttpSuccess(seedResult, "seed route");

    if (seedResult.body?.ok === true) {
      sendProgress({ step: 6, total: 9, message: "Seed complete. Verifying..." });
    } else if (seedResult.body?.error === "no exec_sql") {
      sendProgress({ step: 6, total: 9, message: "Bootstrapping exec_sql via Lovable AI..." });
      const bootstrap = await bootstrapExecSqlViaLovable(id, EXEC_SQL_BOOTSTRAP_SQL);
      if (!bootstrap.ok) throw new Error(bootstrap.error);

      sendProgress({ step: 7, total: 9, message: "Re-running seed after bootstrap..." });
      const seedAgain = await fetchJson(seedUrl);
      if (!seedAgain.ok || seedAgain.status !== 200 || seedAgain.body?.ok !== true) {
        const error = seedAgain.body?.error === "no exec_sql"
          ? "exec_sql bootstrap failed"
          : seedAgain.body?.error || seedAgain.error || "exec_sql bootstrap failed";
        throw new Error(error);
      }
    } else {
      throw new Error(seedResult.body?.error || "seed route returned an unexpected payload");
    }

    sendProgress({ step: 8, total: 9, message: "Verifying migration runner..." });
    const verify = await fetchJson(runnerUrl);
    if (!verify.ok || verify.status !== 200 || verify.body?.ok !== true) {
      throw new Error(verify.body?.error || verify.error || "runner verification failed");
    }

    sendProgress({ step: 9, total: 9, message: "Setup complete." });
    await persistSetupState(setupStorageKey, {
      setupComplete: true,
      setupAt: new Date().toISOString(),
      error: null,
      keyFingerprint: await getMigrationKeyFingerprint(id),
    });
    return { ok: true, key, previewHost };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await persistSetupState(setupStorageKey, {
      setupComplete: false,
      ...(key ? { keyFingerprint: key.slice(0, 8) } : {}),
      error: detail,
    }).catch(() => {});
    throw error;
  }
}

async function persistSetupState(setupStorageKey, patch) {
  const current = (await chrome.storage.local.get(setupStorageKey))[setupStorageKey] || {};
  await chrome.storage.local.set({
    [setupStorageKey]: { ...current, ...patch, updatedAt: new Date().toISOString() },
  });
}

async function dispatchSetupRequest(projectId, objective) {
  const tabs = await chrome.tabs.query({ url: ["https://lovable.dev/projects/*"] });
  const tab = tabs.find((candidate) => candidate.url?.includes(projectId));
  if (!tab?.id) return { ok: false, error: "Lovable tab not open." };

  try {
    // The existing prompt relay wraps this request with buildWrapper; sending a raw
    // objective here avoids nesting a second V5 envelope.
    const response = await chrome.tabs.sendMessage(tab.id, {
      type: "LOVABURST_SUBMIT_OBJECTIVE",
      objective,
      skills: [],
    });
    return response?.ok ? { ok: true, tabId: tab.id } : { ok: false, error: `ChatGPT dispatch failed. ${response?.error || ""}`.trim() };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `ChatGPT dispatch failed. ${detail}` };
  }
}

async function waitForProjectCompletion(projectId, startedAt, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let checking = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.storage.onChanged.removeListener(onChanged);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error("ChatGPT did not report completion for setup commit.")), timeoutMs);
    const check = async () => {
      if (checking || settled) return;
      checking = true;
      try {
        const stored = await chrome.storage.local.get("projectRunStatuses");
        const run = stored.projectRunStatuses?.[projectId];
        const marker = String(run?.marker || "");
        const completedAt = Date.parse(run?.detectedAt || run?.completedAt || run?.updatedAt || "");
        if (completedAt >= startedAt && RESULT_MARKERS.has(marker)) {
          const response = String(run.liveResponse || run.excerpt || "");
          const commitSha = response.match(/^\s*Commit SHA:\s*([a-f0-9]{7,40})\s*$/im)?.[1] || "";
          finish(null, { marker: RESULT_MARKERS.get(marker), commitSha, response });
        }
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      } finally {
        checking = false;
      }
    };
    const onChanged = (changes, area) => {
      if (area === "local" && changes.projectRunStatuses) void check();
    };
    chrome.storage.onChanged.addListener(onChanged);
    void check();
  });
}

function buildSetupRequest({ branch, runnerSource, seedSource }) {
  return [
    `Setup the migration runner in this repository on branch ${branch}.`,
    "Write exactly these two files and commit both in a single commit. Do not modify any other file, run tests, or open a pull request.",
    "",
    `FILE 1 PATH: ${RUNNER_PATH}`,
    "FILE 1 CONTENT:",
    "```ts",
    runnerSource,
    "```",
    "",
    `FILE 2 PATH: ${SEED_PATH}`,
    "FILE 2 CONTENT:",
    "```ts",
    seedSource,
    "```",
    "",
    "Reply with the commit SHA and finish with [PRM_DONE].",
  ].join("\n");
}

async function probeRouteExists(url) {
  try {
    const response = await fetch(url, { method: "GET", cache: "no-store", credentials: "omit" });
    return response.status === 200 || response.status === 500;
  } catch {
    return false;
  }
}

async function pollForDeploy(url, { intervalMs, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { method: "GET", cache: "no-store", credentials: "omit" });
      if ([200, 401, 500].includes(response.status)) return { ok: true, status: response.status };
      if (response.status === 404) {
        const contentType = response.headers.get("content-type") || "";
        if (contentType.includes("text/html")) {
          return { ok: false, error: "Preview host not responding (HTML 404). Is the project running?" };
        }
      }
    } catch {}
    await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
  }
  return { ok: false, error: "Route did not deploy within 3 minutes." };
}

async function fetchJson(url) {
  try {
    const response = await fetch(url, { method: "GET", cache: "no-store", credentials: "omit" });
    const text = await response.text();
    let body = null;
    try { body = JSON.parse(text); } catch {}
    return { ok: true, status: response.status, body };
  } catch (error) {
    return { ok: false, status: 0, body: null, error: `network error: ${String(error)}` };
  }
}

function assertHttpSuccess(result, label) {
  if (!result.ok) throw new Error(result.error || `${label} network request failed.`);
  if (result.status !== 200) throw new Error(result.body?.error || `${label} returned HTTP ${result.status}.`);
}

async function bootstrapExecSqlViaLovable(projectId, sql) {
  const tabs = await chrome.tabs.query({ url: ["https://lovable.dev/projects/*"] });
  const tab = tabs.find((candidate) => candidate.url?.includes(projectId));
  if (!tab?.id) return { ok: false, error: "Lovable tab not open." };
  try {
    const response = await chrome.tabs.sendMessage(tab.id, {
      type: "LOVABLE_BOOTSTRAP_EXEC_SQL",
      sql,
      timeoutMs: BOOTSTRAP_TIMEOUT_MS,
    });
    return response?.ok ? { ok: true } : { ok: false, error: response?.error || "Lovable AI did not respond within 3 minutes" };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, error: /timed out|timeout/i.test(detail) ? "Lovable AI did not respond within 3 minutes" : detail };
  }
}
