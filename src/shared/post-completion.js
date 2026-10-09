const RUNNER_PATH = "/api/public/ops/run-migrations";
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
  for (const match of response.matchAll(/https?:\/\/[^\s<>"'`]+/g)) {
    urls.add(match[0].replace(/[),.;]+$/, ""));
  }
  const runnerUrlFromReport =
    response.match(/^MIGRATION_RUNNER_URL:\s*(https?:\/\/\S+)$/m)?.[1] || null;
  const reportedUrls = [...urls].filter((url) => {
    try {
      const parsed = new URL(url);
      return parsed.pathname !== RUNNER_PATH;
    } catch {
      return false;
    }
  });
  const commitSha = response.match(/^\s*Commit SHA:\s*([a-f0-9]{7,40})\s*$/im)?.[1] || "";
  const backendClassification =
    response.match(/^\s*(?:Backend classification|Classification):\s*(CLOUD_DRIZZLE|CLOUD_SUPABASE_MIGRATIONS|EXTERNAL_SUPABASE|MOCK|NONE)\s*$/im)?.[1]
    || project.backendClassification
    || "";
  const migrationFiles = [...new Set(
    response.match(/(?:drizzle|supabase)\/migrations\/[^\s<>"'`]+/gi) || [],
  )].map((file) => file.replace(/[),.;]+$/, ""));

  return {
    statusMarker,
    reportedUrls,
    schemaTouched: /(?:schema\s+was\s+touched|whether\s+schema\s+was\s+touched(?:\s*\(yes\/no\))?)\s*:\s*yes/i.test(response),
    commitSha,
    backendClassification: String(backendClassification).toUpperCase(),
    migrationFiles,
    runnerUrlFromReport,
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

async function verifyUrl(url) {
  for (let attempt = 0; attempt < URL_ATTEMPTS; attempt += 1) {
    try {
      let response = await fetch(url, { method: "HEAD", cache: "no-store", credentials: "omit" });
      if ([405, 501].includes(response.status)) {
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

async function hasPreviewPermission(previewHost) {
  if (!globalThis.chrome?.permissions?.contains) return true;
  try {
    const origin = new URL(previewHost).origin;
    return await chrome.permissions.contains({ origins: [`${origin}/*`] });
  } catch {
    return false;
  }
}

export async function runPostCompletionPipeline(projectId, assistantResponse, project = {}, sendStatus) {
  const id = String(projectId || "").trim();
  if (!id || typeof sendStatus !== "function") throw new Error("Project ID and status handler are required.");
  const parsed = parseResponse(assistantResponse, project);
  const common = {
    backendClassification: parsed.backendClassification || null,
    ...(parsed.commitSha ? { commitSha: parsed.commitSha } : {}),
  };

  if (parsed.statusMarker !== "DONE") {
    const status = (parsed.statusMarker || "ERROR").toLowerCase();
    await sendStatus(id, { status, ...common });
    return { status };
  }

  const previewHost = String(project.previewHost || `https://${id}.lovableproject.com`).replace(/\/$/, "");
  const runnerUrl = parsed.schemaTouched ? parsed.runnerUrlFromReport : null;
  let schemaPending = false;
  if (parsed.schemaTouched) {
    if (runnerUrl) {
      schemaPending = true;
      await sendStatus(id, {
        status: "schema-pending",
        migrationFiles: parsed.migrationFiles,
        runnerUrl,
        schemaPending: true,
        applied: null,
        skipped: null,
        ...common,
      });
    } else {
      await sendStatus(id, {
        status: "schema-manual-required",
        note: "Schema changed but no runner URL in the report. Apply migrations manually.",
        migrationFiles: parsed.migrationFiles,
        ...common,
      });
    }
  }

  const urls = [...new Set(parsed.reportedUrls
    .map((value) => absoluteUrl(value, previewHost))
    .filter(Boolean))];
  if (urls.length && !(await hasPreviewPermission(previewHost))) {
    const error = "Preview host access is not granted to this extension; endpoint checks cannot run.";
    const status = schemaPending ? "schema-pending" : parsed.schemaTouched ? "schema-manual-required" : "error";
    await sendStatus(id, {
      status,
      error,
      ...(schemaPending ? { runnerUrl, schemaPending: true, applied: null, skipped: null } : {}),
      ...(!runnerUrl && parsed.schemaTouched ? {
        note: "Schema changed but no runner URL in the report. Apply migrations manually.",
        migrationFiles: parsed.migrationFiles,
      } : {}),
      ...common,
    });
    return { status, error };
  }

  const perUrlStatuses = [];
  for (const url of urls) perUrlStatuses.push(await verifyUrl(url));

  let finalStatus = "done";
  if (perUrlStatuses.length && perUrlStatuses.every((item) => item.state === "live")) finalStatus = "live";
  else if (perUrlStatuses.some((item) => item.state === "runtime-error")) finalStatus = "runtime-error";
  else if (perUrlStatuses.some((item) => item.state === "deploy-failed")) finalStatus = "deploy-failed";
  if (schemaPending) finalStatus = "schema-pending";
  else if (parsed.schemaTouched) finalStatus = "schema-manual-required";

  await sendStatus(id, {
    status: finalStatus,
    urls: perUrlStatuses,
    ...(parsed.schemaTouched && !runnerUrl ? {
      note: "Schema changed but no runner URL in the report. Apply migrations manually.",
      migrationFiles: parsed.migrationFiles,
    } : {}),
    ...(runnerUrl ? { runnerUrl, schemaPending } : {}),
    ...common,
  });
  return { status: finalStatus, urls: perUrlStatuses, ...(runnerUrl ? { runnerUrl } : {}) };
}
