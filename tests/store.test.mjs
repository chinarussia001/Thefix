import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TaskStore } from "../backend/store.mjs";

test("tasks and activity persist; idempotency prevents duplicate tasks", async () => {
  const root = await mkdtemp(join(tmpdir(), "lovarpm-store-"));
  const path = join(root, "tasks.sqlite");
  try {
    let store = new TaskStore(path);
    const input = {
      ownerId: "test-owner",
      idempotencyKey: "request-123456",
      prompt: "Fix a test",
      projectId: "lovable-project",
      repository: "owner/repo",
      branch: "main",
      model: "claude-sonnet-4-6",
    };
    const first = store.createTask(input);
    const duplicate = store.createTask(input);
    assert.equal(first.created, true);
    assert.equal(duplicate.created, false);
    assert.equal(first.task.id, duplicate.task.id);
    store.addEvent(first.task.id, "testing", "Validation command passed.", { exitCode: 0 });
    store.close();

    store = new TaskStore(path);
    const task = store.getTask(first.task.id, "test-owner");
    assert.equal(task.projectId, "lovable-project");
    assert.equal(task.events.at(-1).details.exitCode, 0);
    assert.equal(store.getTask(first.task.id, "another-owner"), null);
    store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("active tasks are marked for attention rather than replayed after restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "lovarpm-recovery-"));
  const path = join(root, "tasks.sqlite");
  try {
    const store = new TaskStore(path);
    const { task } = store.createTask({
      ownerId: "owner",
      idempotencyKey: "request-123456",
      prompt: "Change a file",
      repository: "owner/repo",
      branch: "main",
      model: "claude-sonnet-4-6",
    });
    store.updateTask(task.id, { state: "editing" });
    store.close();
    const reopened = new TaskStore(path);
    const recovered = reopened.getTask(task.id, "owner");
    assert.equal(recovered.state, "attention");
    assert.match(recovered.events.at(-1).message, /no tool call was replayed/);
    reopened.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
