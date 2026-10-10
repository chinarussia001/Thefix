import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const TERMINAL_STATES = new Set(["completed", "failed", "cancelled", "attention"]);

function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export class TaskStore {
  constructor(databasePath) {
    const path = resolve(databasePath);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        prompt TEXT NOT NULL,
        project_id TEXT NOT NULL DEFAULT '',
        repository TEXT NOT NULL,
        branch TEXT NOT NULL,
        selected_model TEXT NOT NULL,
        active_model TEXT NOT NULL,
        state TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        error TEXT NOT NULL DEFAULT '',
        result_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        UNIQUE(owner_id, idempotency_key)
      );
      CREATE TABLE IF NOT EXISTS task_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        message TEXT NOT NULL,
        details_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS task_owner_created ON tasks(owner_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS task_events_task_sequence ON task_events(task_id, sequence);
    `);
    this.markInterruptedTasks();
  }

  markInterruptedTasks() {
    const running = this.database.prepare("SELECT id FROM tasks WHERE state IN ('inspecting','planning','editing','testing','repairing','delivering')").all();
    const update = this.database.prepare("UPDATE tasks SET state='attention', error=?, updated_at=?, completed_at=? WHERE id=?");
    const insertEvent = this.database.prepare("INSERT INTO task_events(task_id,kind,message,created_at) VALUES(?,?,?,?)");
    const now = new Date().toISOString();
    for (const task of running) {
      update.run("Backend restarted while this task was active; review its preserved workspace before retrying.", now, now, task.id);
      insertEvent.run(task.id, "attention", "Execution was interrupted by a backend restart. Existing work was preserved; no tool call was replayed.", now);
    }
  }

  createTask(input) {
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const insert = this.database.prepare(`
      INSERT INTO tasks(id,owner_id,idempotency_key,prompt,project_id,repository,branch,selected_model,active_model,state,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(owner_id,idempotency_key) DO NOTHING
    `);
    const result = insert.run(
      id, input.ownerId, input.idempotencyKey, input.prompt, input.projectId || "", input.repository, input.branch,
      input.model, input.model, "queued", now, now,
    );
    const task = this.database.prepare("SELECT * FROM tasks WHERE owner_id=? AND idempotency_key=?").get(input.ownerId, input.idempotencyKey);
    if (result.changes > 0) {
      this.addEvent(task.id, "queued", "Task accepted and queued.", { selectedModel: input.model });
    }
    return { task: this.getTask(task.id, input.ownerId), created: result.changes > 0 };
  }

  addEvent(taskId, kind, message, details = {}) {
    const now = new Date().toISOString();
    this.database.prepare("INSERT INTO task_events(task_id,kind,message,details_json,created_at) VALUES(?,?,?,?,?)")
      .run(taskId, kind, message, JSON.stringify(details), now);
    this.database.prepare("UPDATE tasks SET updated_at=? WHERE id=?").run(now, taskId);
  }

  updateTask(taskId, patch) {
    const allowed = new Set(["active_model", "state", "summary", "error", "result_json", "completed_at"]);
    const entries = Object.entries(patch).filter(([key]) => allowed.has(key));
    if (!entries.length) return;
    const columns = entries.map(([key]) => `${key}=?`).join(",");
    this.database.prepare(`UPDATE tasks SET ${columns},updated_at=? WHERE id=?`)
      .run(...entries.map(([, value]) => value), new Date().toISOString(), taskId);
  }

  getTask(taskId, ownerId) {
    const task = this.database.prepare("SELECT * FROM tasks WHERE id=? AND owner_id=?").get(taskId, ownerId);
    return task ? this.hydrate(task) : null;
  }

  listTasks(ownerId, limit = 50) {
    return this.database.prepare("SELECT * FROM tasks WHERE owner_id=? ORDER BY created_at DESC LIMIT ?")
      .all(ownerId, limit).map((task) => this.hydrate(task));
  }

  getEvents(taskId) {
    return this.database.prepare("SELECT kind,message,details_json,created_at FROM task_events WHERE task_id=? ORDER BY sequence")
      .all(taskId).map((event) => ({
        kind: event.kind,
        message: event.message,
        details: parseJson(event.details_json, {}),
        createdAt: event.created_at,
      }));
  }

  requestCancellation(taskId, ownerId) {
    const task = this.getTask(taskId, ownerId);
    if (!task) return null;
    if (!TERMINAL_STATES.has(task.state) && task.state !== "cancelling") {
      this.updateTask(taskId, { state: "cancelling" });
      this.addEvent(taskId, "cancelling", "Cancellation requested.");
    }
    return this.getTask(taskId, ownerId);
  }

  hasCancellation(taskId) {
    return this.database.prepare("SELECT 1 FROM tasks WHERE id=? AND state IN ('cancelling','cancelled')").get(taskId) !== undefined;
  }

  hydrate(task) {
    return {
      id: task.id,
      ownerId: task.owner_id,
      prompt: task.prompt,
      projectId: task.project_id,
      repository: task.repository,
      branch: task.branch,
      selectedModel: task.selected_model,
      activeModel: task.active_model,
      state: task.state,
      summary: task.summary,
      error: task.error,
      result: parseJson(task.result_json, {}),
      createdAt: task.created_at,
      updatedAt: task.updated_at,
      completedAt: task.completed_at,
      events: this.getEvents(task.id),
    };
  }

  close() {
    this.database.close();
  }
}
