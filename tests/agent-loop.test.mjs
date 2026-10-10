import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CodingAgent } from "../backend/agent.mjs";
import { TaskStore } from "../backend/store.mjs";
import { SUPPORTED_MODELS } from "../backend/vyce.mjs";

const toolCall = (id, name, args) => ({
  id,
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});

test("coding agent executes structured tool calls, validates changes, and records GitHub delivery", async () => {
  const root = await mkdtemp(join(tmpdir(), "lovarpm-agent-loop-"));
  const store = new TaskStore(join(root, "tasks.sqlite"));
  const { task } = store.createTask({
    ownerId: "owner",
    idempotencyKey: "agent-loop-0001",
    prompt: "Update and test the source file.",
    repository: "owner/repo",
    branch: "main",
    model: "claude-sonnet-4-6",
  });
  const requests = [];
  const sequence = [
    { tool_calls: [toolCall("read-1", "read_file", { path: "src/index.js" })] },
    { tool_calls: [toolCall("write-1", "write_file", { path: "src/index.js", content: "export const value = 2;\n" })] },
    { tool_calls: [toolCall("test-1", "run_command", { command: "npm test" })] },
    { tool_calls: [toolCall("status-1", "git_status", {})] },
    { tool_calls: [toolCall("diff-1", "git_diff", {})] },
    { content: "Updated and validated src/index.js." },
  ];
  const provider = {
    requireKey: () => {},
    models: async () => SUPPORTED_MODELS.map((model) => ({ ...model, available: true })),
    complete: async (request) => {
      requests.push({ ...request, messages: structuredClone(request.messages) });
      return {
        message: { role: "assistant", ...sequence[requests.length - 1] },
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      };
    },
  };
  const workspaceState = { file: "export const value = 1;\n", commands: [], delivered: null, closed: 0, restored: 0 };
  const workspaceFactory = () => ({
    prepare: async () => {},
    git: async () => ({ exitCode: 0, stdout: "https://github.com/owner/repo.git\n", stderr: "" }),
    repositoryMetadata: async () => ({ repository: "owner/repo", defaultBranch: "main", private: false }),
    readFile: async () => workspaceState.file,
    writeFile: async (_path, content) => { workspaceState.file = content; return { bytesWritten: Buffer.byteLength(content) }; },
    runCommand: async (command) => {
      workspaceState.commands.push(command);
      return { exitCode: 0, stdout: "1 test passed\n", stderr: "", truncated: false };
    },
    status: async () => ({ exitCode: 0, stdout: " M src/index.js\n", stderr: "" }),
    diff: async () => ({ exitCode: 0, stdout: "diff --git a/src/index.js b/src/index.js\n", stderr: "" }),
    changedPaths: async () => ["src/index.js"],
    deliver: async (details) => {
      workspaceState.delivered = details;
      return {
        branch: "lovarpm/task-12345678",
        commit: "1234567890abcdef",
        commitUrl: "https://github.com/owner/repo/commit/1234567890abcdef",
        pullRequest: { number: 42, url: "https://github.com/owner/repo/pull/42", reused: false },
      };
    },
    close: async () => { workspaceState.closed += 1; },
    restoreSecrets: async () => { workspaceState.restored += 1; },
  });
  const agent = new CodingAgent({
    store,
    provider,
    workspaceRoot: root,
    secretRoot: join(root, "quarantine"),
    ownerId: "owner",
    workspaceFactory,
    githubToken: "test-token",
  });

  try {
    await agent.execute(task);
    const result = store.getTask(task.id, "owner");
    assert.equal(result.state, "completed");
    assert.equal(result.summary, "Updated and validated src/index.js.");
    assert.equal(result.result.validationSucceeded, true);
    assert.equal(result.result.pullRequest.number, 42);
    assert.equal(result.result.usage.inputTokens, 60);
    assert.equal(result.result.usage.outputTokens, 30);
    assert.ok(Math.abs(result.result.usage.estimatedCostUsd - 0.00063) < 1e-12);
    assert.match(result.result.usage.pricingBasis, /not live-verified/);
    assert.equal(result.events.filter((event) => event.kind === "usage").length, 6);
    assert.equal(requests.length, sequence.length);
    assert.ok(requests.every((request) => request.tools.length > 0));
    assert.equal(requests[1].messages.at(-1).role, "tool");
    assert.match(requests[1].messages.at(-1).content, /export const value = 1/);
    assert.equal(workspaceState.file, "export const value = 2;\n");
    assert.deepEqual(workspaceState.commands, ["npm test"]);
    assert.equal(workspaceState.delivered.baseBranch, "main");
    assert.equal(workspaceState.closed, 1);
    assert.equal(workspaceState.restored, 1);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
