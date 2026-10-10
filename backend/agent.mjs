import { DockerWorkspace } from "./execution.mjs";
import { estimateCostUsd, PRICING_BASIS, ProviderError, SUPPORTED_MODELS } from "./vyce.mjs";

const TOOL_DEFINITIONS = [
  {
    type: "function",
    function: {
      name: "get_repository_metadata",
      description: "Return the selected repository, target branch, and current working branch.",
      parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "list_files",
      description: "List files in a repository folder. Credential files and Git internals are excluded.",
      parameters: { type: "object", properties: { directory: { type: "string", maxLength: 240 } }, required: [], additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a source file from the checked-out repository. Credential files are unavailable.",
      parameters: { type: "object", properties: { path: { type: "string", minLength: 1, maxLength: 240 } }, required: ["path"], additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "search_files",
      description: "Search repository text by literal query and optional file extension.",
      parameters: { type: "object", properties: { query: { type: "string", minLength: 1, maxLength: 200 }, extension: { type: "string", maxLength: 24 } }, required: ["query"], additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Create or replace a repository source file. Paths are confined to the workspace.",
      parameters: { type: "object", properties: { path: { type: "string", minLength: 1, maxLength: 240 }, content: { type: "string", maxLength: 80000 } }, required: ["path", "content"], additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description: "Run a shell command in the isolated Docker repository container and return its real output and exit code.",
      parameters: { type: "object", properties: { command: { type: "string", minLength: 1, maxLength: 4000 }, timeoutSeconds: { type: "integer", minimum: 1, maximum: 120 } }, required: ["command"], additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "git_status",
      description: "Inspect the actual working tree status.",
      parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "git_diff",
      description: "Inspect the actual unstaged Git diff.",
      parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    },
  },
];

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

function validateArguments(name, args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Tool arguments must be a JSON object.");
  const definition = TOOL_DEFINITIONS.find((tool) => tool.function.name === name);
  if (!definition) throw new Error(`Tool ${name} is not available.`);
  const schema = definition.function.parameters;
  const properties = schema.properties || {};
  if (Object.keys(args).some((key) => !hasOwn(properties, key))) throw new Error(`Unexpected arguments for ${name}.`);
  if ((schema.required || []).some((key) => !hasOwn(args, key))) throw new Error(`Missing required arguments for ${name}.`);
  for (const [key, value] of Object.entries(args)) {
    const property = properties[key];
    if (property.type === "string") {
      if (typeof value !== "string") throw new Error(`${key} must be a string.`);
      if (property.minLength !== undefined && value.length < property.minLength) throw new Error(`${key} must be at least ${property.minLength} characters.`);
      if (property.maxLength !== undefined && value.length > property.maxLength) throw new Error(`${key} must be at most ${property.maxLength} characters.`);
    } else if (property.type === "integer") {
      if (!Number.isInteger(value)) throw new Error(`${key} must be an integer.`);
      if (property.minimum !== undefined && value < property.minimum) throw new Error(`${key} must be at least ${property.minimum}.`);
      if (property.maximum !== undefined && value > property.maximum) throw new Error(`${key} must be at most ${property.maximum}.`);
    }
  }
  return args;
}

function systemPrompt(task) {
  return [
    "You are LovaRPM, an autonomous coding agent. Work only in the supplied repository using the provided tools.",
    `Task: ${task.prompt}`,
    `Repository: ${task.repository}; target base branch: ${task.branch}.`,
    "Inspect relevant project files before editing. Make focused changes. Read command output and exit codes; if a check fails, diagnose, repair, and rerun it within the tool and time limits.",
    "Use a relevant test, lint, type-check, or build command after editing. Inspect git status and diff before finishing.",
    "Never claim a file changed or a check succeeded unless a tool result verifies it. Do not request, reveal, or copy credentials. Credential files are withheld.",
    "Do not perform destructive operations outside the requested change. The workspace is disposable and isolated in a restricted Docker container.",
    "When work is implemented and validated, provide a concise summary. GitHub delivery is performed by the backend after successful validation.",
  ].join("\n");
}

function isValidationCommand(command) {
  return /(?:^|[;&|]\s*)(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|lint|typecheck|check|build)\b|(?:^|[;&|]\s*)(?:vitest|jest|pytest|ruff|eslint|tsc)\b|(?:^|[;&|]\s*)(?:cargo\s+test|go\s+test|python(?:3)?\s+-m\s+(?:pytest|unittest)|make\s+(?:test|check|build)|dotnet\s+test|mvn\s+test|gradle\s+test)\b/i.test(command);
}

function normalizeToolResult(result) {
  return JSON.stringify(result);
}

export class CodingAgent {
  constructor({ store, provider, workspaceRoot, secretRoot, ownerId, maxToolCalls = 30, maxTaskMs = 30 * 60_000, githubToken, workspaceFactory = (options) => new DockerWorkspace(options) }) {
    this.store = store;
    this.provider = provider;
    this.workspaceRoot = workspaceRoot;
    this.secretRoot = secretRoot;
    this.ownerId = ownerId;
    this.maxToolCalls = maxToolCalls;
    this.maxTaskMs = maxTaskMs;
    this.githubToken = githubToken;
    this.workspaceFactory = workspaceFactory;
    this.active = new Map();
    this.queue = [];
    this.running = 0;
    this.maxConcurrent = Math.max(1, Number(process.env.LOVARPM_MAX_CONCURRENT_TASKS) || 1);
  }

  enqueue(task) {
    if (this.active.has(task.id) || this.queue.some((item) => item.id === task.id)) return;
    this.queue.push(task);
    void this.pump();
  }

  async pump() {
    while (this.running < this.maxConcurrent && this.queue.length) {
      const nextIndex = this.queue.findIndex((candidate) =>
        ![...this.active.values()].some((active) =>
          active.repository === candidate.repository && active.branch === candidate.branch));
      if (nextIndex < 0) return;
      const [task] = this.queue.splice(nextIndex, 1);
      this.running += 1;
      this.active.set(task.id, { repository: task.repository, branch: task.branch, workspace: null, controller: new AbortController() });
      void this.execute(task)
        .catch((error) => this.fail(task, error))
        .finally(() => {
          this.active.delete(task.id);
          this.running -= 1;
          void this.pump();
        });
    }
  }

  async cancel(taskId) {
    const queuedIndex = this.queue.findIndex((task) => task.id === taskId);
    if (queuedIndex >= 0) {
      this.queue.splice(queuedIndex, 1);
      this.store.updateTask(taskId, { state: "cancelled", error: "", completed_at: new Date().toISOString() });
      this.store.addEvent(taskId, "cancelled", "Queued task cancelled before execution.");
    }
    const running = this.active.get(taskId);
    if (running) {
      running.controller.abort();
      if (running.workspace) await running.workspace.cancel();
    }
  }

  async execute(task) {
    const execution = this.active.get(task.id) || { repository: task.repository, branch: task.branch, workspace: null, controller: new AbortController() };
    this.active.set(task.id, execution);
    const deadline = Date.now() + this.maxTaskMs;
    const checkActive = () => {
      if (this.store.hasCancellation(task.id)) throw new Error("Task cancelled by user.");
      if (Date.now() >= deadline) throw new Error("Task exceeded its configured execution time limit.");
    };
    const setState = (state) => {
      if (!this.store.hasCancellation(task.id)) this.store.updateTask(task.id, { state });
    };
    const event = (kind, message, details = {}) => this.store.addEvent(task.id, kind, message, details);
    let workspace;
    let successfulValidation = false;
    let toolCount = 0;
    const usage = { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, byModel: {} };
    try {
      checkActive();
      this.provider.requireKey();
      setState("inspecting");
      event("inspecting", "Preparing a private repository workspace.");
      workspace = this.workspaceFactory({
        root: this.workspaceRoot,
        secretRoot: this.secretRoot,
        taskId: task.id,
        repository: task.repository,
        branch: task.branch,
        githubToken: this.githubToken,
      });
      execution.workspace = workspace;
      if (execution.controller.signal.aborted) await workspace.cancel();
      await workspace.prepare();
      checkActive();

      const gitIdentity = await workspace.git(["config", "--get", "remote.origin.url"]);
      if (gitIdentity.exitCode !== 0 || !gitIdentity.stdout.includes(task.repository)) {
        throw new Error("The isolated workspace remote does not match the selected repository.");
      }
      event("planning", "Repository checkout is ready; the coding agent is inspecting project files.");
      setState("planning");
      const catalog = await this.provider.models().catch((error) => {
        if (error instanceof ProviderError && ["invalid_credentials", "insufficient_balance"].includes(error.code)) throw error;
        event("model_catalog_unavailable", "Provider model catalogue could not be read; automatic model fallback is disabled for this task.");
        return null;
      });
      const availableModels = new Set(catalog?.filter((model) => model.available).map((model) => model.id) || []);
      const fallbackOrder = ["deepseek-v4-flash", "gpt-6-luna", "claude-sonnet-4-6"];
      const modelOrder = [task.selectedModel, ...fallbackOrder.filter((id) => id !== task.selectedModel)];
      let model = task.selectedModel;
      let messages = [{ role: "system", content: systemPrompt(task) }];
      let finished = false;

      for (let turn = 0; turn < 40 && !finished; turn += 1) {
        checkActive();
        let completion;
        try {
          completion = await this.completionWithRetry({
            model,
            messages,
            checkActive,
            signal: execution.controller.signal,
            recordRetry: (attempt, error) => event("provider_retry", `Retrying a transient Vyce AI request failure (attempt ${attempt + 1}).`, {
              attempt: attempt + 1,
              providerCode: error.code,
            }),
          });
        } catch (error) {
          if (error instanceof ProviderError && error.code === "context_window" && turn < 39) {
            messages = [
              messages[0],
              { role: "user", content: "The previous conversation exceeded the model context limit. Continue the same task from the actual repository state. Reinspect changed files and validation results with the tools; do not repeat completed changes without checking first." },
            ];
            event("context_compacted", "Provider context limit reached; task conversation was compacted and work will continue from repository state.");
            continue;
          }
          const canFallback = error instanceof ProviderError &&
            (["model_unavailable", "provider_unavailable"].includes(error.code) ||
              /tool|function[- ]call/i.test(`${error.code} ${error.message}`));
          const fallback = canFallback ? modelOrder.slice(modelOrder.indexOf(model) + 1).find((candidate) => availableModels.has(candidate)) : null;
          if (!fallback) throw error;
          const previousModel = model;
          model = fallback;
          if (!this.store.hasCancellation(task.id)) this.store.updateTask(task.id, { active_model: model });
          event("model_fallback", `Switched to ${model} after a model-specific provider failure.`, { from: previousModel, to: model, providerCode: error.code });
          continue;
        }
        if (completion.usage) {
          const inputTokens = completion.usage.prompt_tokens ?? completion.usage.input_tokens ?? 0;
          const outputTokens = completion.usage.completion_tokens ?? completion.usage.output_tokens ?? 0;
          usage.inputTokens += inputTokens;
          usage.outputTokens += outputTokens;
          const modelUsage = usage.byModel[model] || { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 };
          modelUsage.inputTokens += inputTokens;
          modelUsage.outputTokens += outputTokens;
          modelUsage.estimatedCostUsd += estimateCostUsd(model, inputTokens, outputTokens);
          usage.byModel[model] = modelUsage;
          usage.estimatedCostUsd += estimateCostUsd(model, inputTokens, outputTokens);
          event("usage", "Vyce AI token usage recorded.", {
            model,
            inputTokens,
            outputTokens,
            estimatedCostUsd: estimateCostUsd(model, inputTokens, outputTokens),
            pricingBasis: PRICING_BASIS,
          });
          const tokenLimit = Math.max(1000, Number(process.env.LOVARPM_MAX_TASK_TOKENS) || 500_000);
          if (usage.inputTokens + usage.outputTokens > tokenLimit) throw new Error("Task exceeded its configured model token usage limit.");
        }
        const message = completion.message;
        messages.push({
          role: "assistant",
          ...(typeof message.content === "string" ? { content: message.content } : {}),
          ...(Array.isArray(message.tool_calls) ? { tool_calls: message.tool_calls } : {}),
        });
        const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
        if (!calls.length) {
          const summary = String(message.content || "").trim();
          if (!summary) throw new Error("The model stopped without a final response or tool call.");
          finished = true;
          this.store.updateTask(task.id, { summary: summary.slice(0, 8000) });
          break;
        }

        for (const call of calls) {
          checkActive();
          toolCount += 1;
          if (toolCount > this.maxToolCalls) throw new Error("Task exceeded its configured tool-call limit.");
          const callId = String(call?.id || "");
          const name = String(call?.function?.name || "");
          const definition = TOOL_DEFINITIONS.find((item) => item.function.name === name);
          setState(["write_file", "run_command"].includes(name) ? "editing" : "inspecting");
          let content;
          let toolFailed = false;
          let args = {};
          if (!callId) throw new Error("The model returned a tool call without a protocol call ID.");
          if (call?.type !== "function" || !definition) {
            toolFailed = true;
            content = normalizeToolResult({ error: "Unknown or malformed tool call." });
          } else {
            try {
              args = validateArguments(name, JSON.parse(String(call.function.arguments || "")));
              const result = await this.executeTool(name, args, workspace, task);
              if (name === "run_command") {
                if (result.exitCode === 0 && isValidationCommand(args.command)) {
                  successfulValidation = true;
                }
                if (result.exitCode !== 0) toolFailed = true;
                event("command", `Command completed with exit code ${result.exitCode}.`, {
                  tool: name,
                  exitCode: result.exitCode,
                  truncated: result.truncated,
                });
              } else {
                event("tool", `${name} completed.`, { tool: name, path: args.path || args.directory || "" });
              }
              content = normalizeToolResult(result);
            } catch (error) {
              toolFailed = true;
              content = normalizeToolResult({ error: error instanceof Error ? error.message : String(error) });
              event("tool_error", `${name} failed.`, { tool: name, error: (error instanceof Error ? error.message : String(error)).slice(0, 500) });
            }
          }
          messages.push({ role: "tool", tool_call_id: callId || `invalid-${toolCount}`, content });
          if (toolFailed && name === "run_command") setState("repairing");
          else if (successfulValidation && name === "run_command") setState("testing");
        }
      }
      if (!finished) throw new Error("Task exceeded the maximum model-turn limit.");
      checkActive();

      const status = await workspace.status();
      const changedPaths = await workspace.changedPaths();
      if (status.exitCode !== 0) throw new Error(`Could not inspect final Git status: ${status.stderr}`);
      if (!changedPaths.length) throw new Error("The agent did not make any repository changes.");
      if (!successfulValidation) throw new Error("No successful test, lint, type-check, build, or compile command was observed; changes were not delivered.");
      const diff = await workspace.diff();
      if (diff.exitCode !== 0) throw new Error(`Could not inspect the final diff: ${diff.stderr}`);
      event("testing", "A validation command succeeded; final Git changes were inspected.", { filesChanged: changedPaths.length });

      checkActive();
      setState("delivering");
      event("delivering", "Creating a working branch, commit, and pull request.");
      const delivery = await workspace.deliver({
        taskId: task.id,
        baseBranch: task.branch,
        prompt: task.prompt,
        signal: execution.controller.signal,
        checkActive,
      });
      this.store.updateTask(task.id, {
        state: "completed",
        summary: String(this.store.getTask(task.id, this.ownerId)?.summary || "").slice(0, 8000),
        result_json: JSON.stringify({
          ...delivery,
          filesChanged: changedPaths.length,
          validationSucceeded: true,
          usage: { ...usage, pricingBasis: PRICING_BASIS },
        }),
        error: "",
        completed_at: new Date().toISOString(),
      });
      event("completed", "Validated changes were committed and delivered to GitHub.", {
        branch: delivery.branch,
        commit: delivery.commit,
        pullRequest: delivery.pullRequest?.url || "",
        filesChanged: changedPaths.length,
        usage,
      });
    } catch (error) {
      if (this.store.hasCancellation(task.id)) {
        this.store.updateTask(task.id, { state: "cancelled", error: "", completed_at: new Date().toISOString() });
        event("cancelled", "Task cancelled; completed workspace operations were preserved.");
      } else {
        throw error;
      }
    } finally {
      await workspace?.close();
      await workspace?.restoreSecrets();
    }
  }

  async completionWithRetry({ model, messages, checkActive, signal, recordRetry }) {
    let lastError;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      checkActive();
      try {
        return await this.provider.complete({ model, messages, tools: TOOL_DEFINITIONS, signal });
      } catch (error) {
        lastError = error;
        recordRetry?.(attempt, error);
        if (!(error instanceof ProviderError) || !["timeout", "network_error", "provider_unavailable", "rate_limited"].includes(error.code) || attempt === 1) {
          throw error;
        }
        if (error.code === "rate_limited" && error.retryAfter > 120) throw error;
        const wait = error.code === "rate_limited" && error.retryAfter
          ? error.retryAfter * 1000
          : 1000 * (attempt + 1);
        await sleep(wait);
      }
    }
    throw lastError;
  }

  async executeTool(name, args, workspace, task) {
    switch (name) {
      case "get_repository_metadata":
        return { ...await workspace.repositoryMetadata(), targetBranch: task.branch, workingDirectory: "/workspace" };
      case "list_files":
        return workspace.listFiles(args.directory || ".");
      case "read_file":
        return { path: args.path, content: await workspace.readFile(args.path) };
      case "search_files": {
        const listing = await workspace.listFiles(".", 1000);
        const errors = [];
        const query = args.query.toLocaleLowerCase();
        const extension = args.extension ? (args.extension.startsWith(".") ? args.extension : `.${args.extension}`) : "";
        const matches = [];
        for (const path of listing.files) {
          if (extension && !path.endsWith(extension)) continue;
          let content;
          try {
            content = await workspace.readFile(path);
          } catch (error) {
            errors.push({ path, error: error instanceof Error ? error.message : String(error) });
            continue;
          }
          content.split(/\r?\n/).forEach((line, index) => {
            if (line.toLocaleLowerCase().includes(query) && matches.length < 100) {
              matches.push({ path, line: index + 1, text: line.slice(0, 400) });
            }
          });
          if (matches.length >= 100) break;
        }
        return { matches, unreadableFiles: errors, truncatedFileList: listing.truncated };
      }
      case "write_file":
        return workspace.writeFile(args.path, args.content);
      case "run_command":
        return workspace.runCommand(args.command, (args.timeoutSeconds || 120) * 1000);
      case "git_status":
        return workspace.status();
      case "git_diff":
        return workspace.diff();
      default:
        throw new Error(`Tool ${name} is not available.`);
    }
  }

  async fail(task, error) {
    const latest = this.store.getTask(task.id, this.ownerId);
    if (!latest || latest.state === "cancelled") return;
    if (this.store.hasCancellation(task.id)) {
      this.store.updateTask(task.id, { state: "cancelled", error: "", completed_at: new Date().toISOString() });
      this.store.addEvent(task.id, "cancelled", "Task cancelled; completed workspace operations were preserved.");
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    this.store.updateTask(task.id, { state: "failed", error: message.slice(0, 1200), completed_at: new Date().toISOString() });
    this.store.addEvent(task.id, "failed", message.slice(0, 1000), { code: error?.code || "execution_error" });
  }
}

export { TOOL_DEFINITIONS, validateArguments };
