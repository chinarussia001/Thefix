import { createServer } from "node:http";
import { mkdir, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { CodingAgent } from "./agent.mjs";
import { recoverInterruptedWorkspace } from "./execution.mjs";
import { TaskStore } from "./store.mjs";
import { ProviderError, SUPPORTED_MODELS, VyceClient } from "./vyce.mjs";

const host = process.env.LOVARPM_HOST || "127.0.0.1";
const port = Number(process.env.LOVARPM_PORT || 4173);
const dataRoot = resolve(process.env.LOVARPM_DATA_DIR || "./backend/data");
const workspaceRoot = resolve(process.env.LOVARPM_WORKSPACE_DIR || "./backend/workspaces");
const secretRoot = resolve(dataRoot, "quarantine");
const ownerId = process.env.LOVARPM_USER_ID || "local-owner";
const authToken = String(process.env.LOVARPM_API_TOKEN || "").trim();
const maxTaskMs = Math.max(60_000, Number(process.env.LOVARPM_MAX_TASK_MINUTES || 30) * 60_000);
const maxToolCalls = Math.max(1, Math.min(100, Number(process.env.LOVARPM_MAX_TOOL_CALLS || 30)));

if (authToken.length < 32) {
  throw new Error("Set a unique LOVARPM_API_TOKEN of at least 32 characters in the backend environment.");
}

await mkdir(dataRoot, { recursive: true, mode: 0o700 });
await mkdir(workspaceRoot, { recursive: true, mode: 0o700 });
const store = new TaskStore(resolve(dataRoot, "tasks.sqlite"));
const provider = new VyceClient();
const agent = new CodingAgent({
  store,
  provider,
  workspaceRoot,
  secretRoot,
  ownerId,
  maxToolCalls,
  maxTaskMs,
  githubToken: process.env.GITHUB_TOKEN,
});

function sameToken(candidate) {
  const left = Buffer.from(String(candidate || ""));
  const right = Buffer.from(authToken);
  return left.length === right.length && timingSafeEqual(left, right);
}

function responseJson(response, status, payload, origin) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...(origin ? {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type, Idempotency-Key",
      Vary: "Origin",
    } : {}),
  });
  response.end(JSON.stringify(payload));
}

function bearerToken(request) {
  const match = String(request.headers.authorization || "").match(/^Bearer (.+)$/i);
  return match?.[1] || "";
}

async function readBody(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 2_000_000) throw Object.assign(new Error("Request body exceeds the 2 MB limit."), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Request body must be a JSON object.");
    return body;
  } catch (error) {
    throw Object.assign(new Error(`Invalid JSON request body: ${error.message}`), { status: 400 });
  }
}

function validateRepository(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(value)) {
    throw Object.assign(new Error("Repository must use owner/name format."), { status: 400 });
  }
  return value;
}

function validateBranch(value) {
  const branch = String(value || "").trim();
  const components = branch.split("/");
  if (!branch || branch.length > 200 || /[\s~^:?*[\\]|]/.test(branch) || branch.startsWith("-") ||
      branch.includes("..") || branch.endsWith(".") || branch.includes("@{") ||
      components.some((part) => !part || part.startsWith(".") || part.endsWith(".lock"))) {
    throw Object.assign(new Error("Target branch is invalid."), { status: 400 });
  }
  return branch;
}

function sanitizePrompt(value) {
  return String(value || "")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})\b/g, "[redacted credential]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[redacted credential]")
    .replace(/(-----BEGIN [A-Z ]*PRIVATE KEY-----)[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----)/g, "$1[redacted]$2");
}

async function repositoryMetadata(repository) {
  const [owner, name] = repository.split("/");
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  let result;
  try {
    result = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, {
      headers,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw Object.assign(new Error(`GitHub could not be reached: ${error.message}`), { status: 502 });
  }
  if (!result.ok) {
    throw Object.assign(new Error(`GitHub repository lookup failed (HTTP ${result.status}). ${result.status === 404 ? "Confirm the repository and configure GITHUB_TOKEN for private repositories." : ""}`), { status: result.status === 404 ? 404 : 502 });
  }
  const metadata = await result.json();
  return {
    repository: metadata.full_name,
    defaultBranch: metadata.default_branch,
    private: Boolean(metadata.private),
    url: metadata.html_url,
    permissions: metadata.permissions || null,
  };
}

async function route(request, response, origin) {
  const url = new URL(request.url || "/", `http://${host}:${port}`);
  if (request.method === "OPTIONS") {
    responseJson(response, 204, {}, origin);
    return;
  }
  if (url.pathname === "/health" && request.method === "GET") {
    responseJson(response, 200, {
      ok: true,
      service: "lovarpm-backend",
      providerConfigured: Boolean(process.env.VYCE_API_KEY),
      githubConfigured: Boolean(process.env.GITHUB_TOKEN),
      queuedTasks: agent.queue.length,
      activeTasks: agent.running,
    }, origin);
    return;
  }
  if (!sameToken(bearerToken(request))) {
    responseJson(response, 401, { error: "Backend authorization failed. Check the configured LovaRPM API token." }, origin);
    return;
  }

  if (url.pathname === "/api/models" && request.method === "GET") {
    try {
      const models = await provider.models();
      responseJson(response, 200, { models }, origin);
    } catch (error) {
      responseJson(response, error instanceof ProviderError && error.code === "not_configured" ? 503 : 502, {
        error: error instanceof Error ? error.message : String(error),
        code: error?.code || "provider_error",
        models: SUPPORTED_MODELS.map((model) => ({ ...model, available: false })),
      }, origin);
    }
    return;
  }

  const repositoryMatch = url.pathname.match(/^\/api\/repositories\/([^/]+)\/([^/]+)$/);
  if (repositoryMatch && request.method === "GET") {
    try {
      const repository = validateRepository(`${decodeURIComponent(repositoryMatch[1])}/${decodeURIComponent(repositoryMatch[2])}`);
      responseJson(response, 200, { repository: await repositoryMetadata(repository) }, origin);
    } catch (error) {
      responseJson(response, error.status || 502, { error: error.message }, origin);
    }
    return;
  }

  if (url.pathname === "/api/tasks" && request.method === "GET") {
    responseJson(response, 200, { tasks: store.listTasks(ownerId) }, origin);
    return;
  }

  if (url.pathname === "/api/tasks" && request.method === "POST") {
    try {
      const body = await readBody(request);
      const prompt = sanitizePrompt(body.prompt).trim();
      const repository = validateRepository(body.repository);
      const branch = validateBranch(body.branch || "main");
      const model = String(body.model || SUPPORTED_MODELS[0].id);
      if (!SUPPORTED_MODELS.some((item) => item.id === model)) {
        throw Object.assign(new Error("Unsupported model. Select one of the three configured Vyce AI models."), { status: 400 });
      }
      if (!prompt || prompt.length > 20_000) {
        throw Object.assign(new Error("Task prompt must contain between 1 and 20000 characters."), { status: 400 });
      }
      const idempotencyKey = String(request.headers["idempotency-key"] || body.requestId || "").trim();
      if (!/^[A-Za-z0-9_-]{8,128}$/.test(idempotencyKey)) {
        throw Object.assign(new Error("A unique Idempotency-Key is required."), { status: 400 });
      }
      if (agent.queue.length + agent.running >= 100) {
        throw Object.assign(new Error("Task queue is full. Wait for queued work to finish."), { status: 429 });
      }
      const { task, created } = store.createTask({
        ownerId,
        idempotencyKey,
        prompt,
        projectId: String(body.projectId || "").slice(0, 128),
        repository,
        branch,
        model,
      });
      if (created) agent.enqueue(task);
      responseJson(response, created ? 202 : 200, { task, created }, origin);
    } catch (error) {
      responseJson(response, error.status || 400, { error: error instanceof Error ? error.message : String(error) }, origin);
    }
    return;
  }

  const taskMatch = url.pathname.match(/^\/api\/tasks\/([0-9a-f-]{36})(\/cancel)?$/i);
  if (taskMatch && request.method === "GET" && !taskMatch[2]) {
    const task = store.getTask(taskMatch[1], ownerId);
    responseJson(response, task ? 200 : 404, task ? { task } : { error: "Task not found." }, origin);
    return;
  }
  if (taskMatch && request.method === "POST" && taskMatch[2] === "/cancel") {
    const task = store.requestCancellation(taskMatch[1], ownerId);
    if (!task) {
      responseJson(response, 404, { error: "Task not found." }, origin);
      return;
    }
    await agent.cancel(task.id);
    const latest = store.getTask(task.id, ownerId);
    responseJson(response, 200, { task: latest }, origin);
    return;
  }

  responseJson(response, 404, { error: "Endpoint not found." }, origin);
}

const server = createServer((request, response) => {
  const origin = String(request.headers.origin || "");
  const permittedOrigin = /^chrome-extension:\/\/[a-p]{32}$/.test(origin) ? origin : "";
  if (origin && !permittedOrigin) {
    responseJson(response, 403, { error: "Requests from this browser origin are not allowed." });
    return;
  }
  route(request, response, permittedOrigin).catch((error) => {
    responseJson(response, error.status || 500, {
      error: error instanceof Error ? error.message : "Unexpected backend error.",
    }, permittedOrigin);
  });
});

for (const task of store.listTasks(ownerId, 100)) {
  const lastEvent = task.events.at(-1);
  if (task.state === "attention" && lastEvent?.message.startsWith("Execution was interrupted by a backend restart")) {
    try {
      await recoverInterruptedWorkspace({ workspaceRoot, secretRoot, taskId: task.id });
      store.addEvent(task.id, "recovered", "Orphaned container was stopped and protected repository files were restored.");
    } catch (error) {
      console.warn(`[LovaRPM] Interrupted workspace recovery failed for task ${task.id}: ${error.message}`);
    }
  }
}

server.listen(port, host, async () => {
  const actualRoot = await realpath(workspaceRoot);
  console.log(`LovaRPM backend listening on http://${host}:${port}; isolated workspaces: ${actualRoot}`);
  for (const task of store.listTasks(ownerId, 100)) {
    if (task.state === "queued") agent.enqueue(task);
  }
});

const shutdown = async () => {
  server.close();
  await Promise.all([...agent.active.keys()].map((taskId) => agent.cancel(taskId)));
  store.close();
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
