import { getMigrationKey } from "./migration-key.js";

const RUNNER_PATH = "/api/public/ops/run-migrations";
const SEED_PATH = "/api/public/ops/seed-migrations";
const RUNNER_TIMEOUT_MS = 180000;
const RUNNER_INTERVAL_MS = 15000;
const URL_ATTEMPTS = 5;
const URL_INTERVAL_MS = 20000;

const MARKERS = new Map([
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

function parseResponse(text, project = {}) {
  const response = String(text || "");
  let statusMarker = "";
  for (const [marker, status] of MARKERS) {
    if (response.includes(marker) || project.marker === marker) {
      statusMarker = status;
      break;
    }
  }
  if (!statusMarker && ["done", "blocked", "error"].includes(project.status)) {
    statusMarker = project.status.toUpperCase();
  }
  const urls = new Set();
  for (const match of response.matchAll(/https?:\/\/[^\s<>"'`]+|\/(?!\/)[A-Za-z0-9._~!$&'()*+,;=:@%/?#-]*/g)) {
    urls.add(match[0].replace(/[),.;]+$/, ""));
  }
  const commitSha = response.match(/^\s*Commit SHA:\s*([a-f0-9]{7,40})\s*$/im)?.[1] || "";
  return {
    statusMarker,
    reportedUrls: [...urls],
    schemaTouched: /schema\s+was\s+touched\s*:\s*yes/i.test(response),
    commitSha,
  };
}

function absoluteUrl(value, previewHost) {
  try {
    const base = new URL(String(previewHost || ""));
    const url = new URL(value, `${base.origin}/`);
    if (url.protocol !== "https:" || url.origin !== base.origin) return "";
    return url.href;
  } catch {
    return "";
  }
}

async function fetchJson(url) {
  const response = await fetch(url, { method: "GET", cache: "no-store", credentials: "omit" });
  let body = null;
  try { body = await response.json(); } catch {}
  return { response, body };
}

async function hasPreviewPermission(previewHost) {
  if (!globalThis.chrome?.permissions?.contains) return true;
  try {
    const origin = new URL(previewHost).origin;
    return await chrome.permissions.contains({ origins: [`${origin}/*`] });
  } catch {
    return false;
  }
}

async function pollRunner(url, key) {
  const deadline = Date.now() + RUNNER_TIMEOUT_MS;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const { response, body } = await fetchJson(`${url}?key=${encodeURIComponent(key)}`);
      if (response.status === 404) {
        await sleep(RUNNER_INTERVAL_MS);
        continue;
      }
      if (response.status === 200 && body?.ok === true) return body;
      if (response.status === 500 && body?.error) {
        return { failed: true, error: String(body.error), failed_at: body.failed_at || null };
      }
      if (response.status === 401) return { failed: true, error: "unauthorized", failed_at: null };
      return { failed: true, error: String(body?.error || `Migration runner returned HTTP ${response.status}.`), failed_at: body?.failed_at || null };
    } catch (error) {
      lastError = error;
      await sleep(RUNNER_INTERVAL_MS);
    }
  }
  if (lastError) return { timeout: true, error: String(lastError.message || lastError) };
  return { timeout: true };
}

async function verifyUrl(url) {
  for (let attempt = 0; attempt < URL_ATTEMPTS; attempt += 1) {
    try {
      let response = await fetch(url, { method: "HEAD", cache: "no-store", credentials: "omit" });
      if (response.status === 404 || response.status === 405 || response.status === 501) {
        response = await fetch(url, { method: "GET", cache: "no-store", credentials: "omit" });
      }
      if (response.status === 200) return { url, state: "live" };
      if (response.status === 500) {
        const detail = (await response.text()).slice(0, 500);
        return { url, state: "runtime-error", detail };
      }
      if (response.status !== 404) {
        return { url, state: "runtime-error", detail: `HTTP ${response.status}` };
      }
    } catch (error) {
      if (attempt === URL_ATTEMPTS - 1) {
        return { url, state: "deploy-failed", detail: String(error.message || error) };
      }
    }
    if (attempt < URL_ATTEMPTS - 1) await sleep(URL_INTERVAL_MS);
  }
  return { url, state: "deploy-failed" };
}

export async function runPostCompletionPipeline(projectId, assistantResponse, project = {}, sendStatus) {
  const id = String(projectId || "").trim();
  if (!id || typeof sendStatus !== "function") throw new Error("Project ID and status handler are required.");
  const parsed = parseResponse(assistantResponse, project);
  const statusMarker = parsed.statusMarker;
  if (statusMarker !== "DONE") {
    await sendStatus(id, { status: (statusMarker || "ERROR").toLowerCase() });
    return { status: (statusMarker || "ERROR").toLowerCase() };
  }

  const previewHost = String(project.previewHost || `https://${id}.lovableproject.com`).replace(/\/$/, "");
  let applied = [];
  let skipped = [];
  let previewPermissionChecked = false;
  if (parsed.schemaTouched) {
    const key = await getMigrationKey(id);
    if (!key) {
      await sendStatus(id, { status: "error", error: "migration key not configured for this project" });
      return { status: "error" };
    }
    if (!(await hasPreviewPermission(previewHost))) {
      const error = "Preview host access is not granted to this extension; migration checks cannot run.";
      await sendStatus(id, { status: "error", error });
      return { status: "error", error };
    }
    previewPermissionChecked = true;
    const result = await pollRunner(`${previewHost}${RUNNER_PATH}`, key);
    if (result.timeout) {
      await sendStatus(id, { status: "schema-timeout", error: result.error || "Migration runner did not deploy within 3 minutes." });
      return { status: "schema-timeout" };
    }
    if (result.failed) {
      await sendStatus(id, { status: "schema-failed", error: result.error, failed_at: result.failed_at });
      return { status: "schema-failed" };
    }
    applied = Array.isArray(result.applied) ? result.applied : [];
    skipped = Array.isArray(result.skipped) ? result.skipped : [];
    await sendStatus(id, {
      status: "migrated",
      migration: applied.length ? "applied" : "no-op",
      applied,
      skipped,
    });
  }

  const urls = parsed.reportedUrls
    .map((value) => absoluteUrl(value, previewHost))
    .filter(Boolean);
  if (urls.length && !previewPermissionChecked && !(await hasPreviewPermission(previewHost))) {
    const error = "Preview host access is not granted to this extension; endpoint checks cannot run.";
    await sendStatus(id, { status: "error", error });
    return { status: "error", error };
  }
  const perUrlStatuses = [];
  for (const url of urls) perUrlStatuses.push(await verifyUrl(url));

  let finalStatus = "done";
  if (perUrlStatuses.length && perUrlStatuses.every((item) => item.state === "live")) finalStatus = "live";
  else if (perUrlStatuses.some((item) => item.state === "runtime-error")) finalStatus = "runtime-error";
  else if (perUrlStatuses.some((item) => item.state === "deploy-failed")) finalStatus = "deploy-failed";

  await sendStatus(id, {
    status: finalStatus,
    migrations: applied,
    applied,
    skipped,
    urls: perUrlStatuses,
    ...(parsed.commitSha ? { commitSha: parsed.commitSha } : {}),
  });
  return { status: finalStatus, applied, skipped, urls: perUrlStatuses };
}
