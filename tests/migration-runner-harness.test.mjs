import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

class FakeElement {
  constructor(tagName = "div", id = "") {
    this.tagName = tagName.toUpperCase();
    this.id = id;
    this.children = [];
    this.attributes = {};
    this.dataset = {};
    this.listeners = {};
    this.textContent = "";
    this.value = "";
    this.hidden = false;
    this.disabled = false;
    this.isConnected = true;
    this.parentElement = null;
    this.queryMap = new Map();
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === "id") this.id = String(value);
  }

  getAttribute(name) {
    return this.attributes[name] || null;
  }

  append(...children) {
    for (const child of children) {
      child.parentElement = this;
      this.children.push(child);
    }
  }

  appendChild(child) {
    this.append(child);
    return child;
  }

  replaceChildren(...children) {
    this.children = [];
    this.append(...children);
  }

  addEventListener(name, listener) {
    (this.listeners[name] ||= []).push(listener);
  }

  async click() {
    if (typeof this.onclick === "function") await this.onclick({ currentTarget: this });
    for (const listener of this.listeners.click || []) {
      await listener({ currentTarget: this });
    }
  }

  querySelector(selector) {
    if (this.queryMap.has(selector)) return this.queryMap.get(selector);
    if (selector.startsWith(".")) {
      const className = selector.slice(1);
      if (String(this.getAttribute("class") || this.className || "").split(/\s+/).includes(className)) return this;
      for (const child of this.children) {
        const match = child.querySelector(selector);
        if (match) return match;
      }
      return null;
    }
    const id = selector.startsWith("#") ? selector.slice(1) : "";
    if (!id) return null;
    if (this.id === id) return this;
    for (const child of this.children) {
      const match = child.querySelector(`#${id}`);
      if (match) return match;
    }
    return null;
  }

  after(element) {
    this.inserted = element;
  }
}

let runId = 0;

async function boot({ storage = {}, tabs = [], fetchImpl } = {}) {
  const values = { ...storage };
  const grid = new FakeElement("div");
  const supabaseCard = new FakeElement("div", "supabaseIntegrationCard");
  const projectValue = new FakeElement("strong", "projectValue");
  projectValue.textContent = "project-123";
  const repositoryValue = new FakeElement("small", "repositoryValue");
  repositoryValue.textContent = "owner/repo";
  const elements = new Map([
    ["supabaseIntegrationCard", supabaseCard],
    ["projectValue", projectValue],
    ["repositoryValue", repositoryValue],
  ]);
  const runtimeMessages = [];
  const tabMessages = [];
  const clipboard = [];
  let fetchCount = 0;
  const listeners = [];

  globalThis.window = {};
  globalThis.document = {
    querySelector(selector) {
      return selector === ".integration-grid" ? grid : null;
    },
    getElementById(id) {
      return elements.get(id) || null;
    },
    createElement(tag) {
      const element = new FakeElement(tag);
      if (!elements.has("__migrationCardCreated")) {
        elements.set("__migrationCardCreated", true);
        for (const id of [
          "migrationRunnerStatus",
          "migrationRunnerDetails",
          "migrationRunnerActions",
          "migrationRunnerHelperActions",
          "migrationRunnerHelperMessage",
        ]) {
          element.queryMap.set(`#${id}`, new FakeElement("div", id));
        }
        element.append(...element.queryMap.values());
      }
      return element;
    },
  };
  globalThis.MutationObserver = class {
    observe() {}
  };
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { clipboard: { writeText: async (text) => clipboard.push(text) } },
  });
  globalThis.fetch = async (...args) => {
    fetchCount += 1;
    if (!fetchImpl) throw new Error("Unexpected fetch.");
    return fetchImpl(...args);
  };
  globalThis.chrome = {
    storage: {
      local: {
        async get(keys) {
          if (keys == null) return { ...values };
          const names = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(names.filter((key) => key in values).map((key) => [key, values[key]]));
        },
        async set(next) {
          Object.assign(values, next);
        },
        async remove(keys) {
          for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key];
        },
      },
      onChanged: { addListener(listener) { listeners.push(listener); } },
    },
    tabs: {
      async query() { return tabs; },
      async update() {},
      sendMessage(_tabId, message, callback) {
        tabMessages.push(message);
        if (callback) callback({ ok: true });
        else return Promise.resolve({ ok: true });
      },
    },
    runtime: {
      lastError: null,
      async sendMessage(message) {
        runtimeMessages.push(message);
        return { ok: true };
      },
    },
  };

  await import(`../src/popup/popup-migration-runner.js?test=${++runId}`);
  await new Promise((resolve) => setImmediate(resolve));

  const card = supabaseCard.inserted;
  const inputById = (id) => {
    for (const child of card.queryMap.get("#migrationRunnerDetails").children) {
      if (child.id === id) return child;
      const nested = child.children.find((item) => item.id === id);
      if (nested) return nested;
    }
    return null;
  };
  const actions = card.queryMap.get("#migrationRunnerActions");
  const helperActions = card.queryMap.get("#migrationRunnerHelperActions");
  const clickAction = async (container, text) => {
    const button = container.children.find((child) => child.textContent === text);
    assert.ok(button, `Expected button "${text}".`);
    await button.click();
    await new Promise((resolve) => setImmediate(resolve));
  };

  return {
    card,
    values,
    runtimeMessages,
    tabMessages,
    clipboard,
    get fetchCount() { return fetchCount; },
    status: card.queryMap.get("#migrationRunnerStatus"),
    helperMessage: card.queryMap.get("#migrationRunnerHelperMessage"),
    actions,
    helperActions,
    inputById,
    clickAction,
    listeners,
  };
}

test("Migration Runner renders NOT CONFIGURED, READY, and FAILED from storage", async () => {
  const notConfigured = await boot();
  assert.equal(notConfigured.status.textContent, "NOT CONFIGURED");

  const ready = await boot({
    storage: {
      projectMigrationKeys: { "project-123": "runner-key-1234" },
      projectSetup: { "project-123": { lastVerifyResult: "ready" } },
    },
  });
  assert.equal(ready.status.textContent, "READY");
  const readyUrl = ready.card.querySelector(".migration-runner-url");
  assert.ok(readyUrl);
  assert.match(readyUrl.textContent, /key=runner-k…/);
  assert.doesNotMatch(readyUrl.textContent, /runner-key-1234/);

  const failed = await boot({
    storage: {
      projectMigrationKeys: { "project-123": "runner-key-1234" },
      projectSetup: { "project-123": { lastVerifyResult: "unauthorized" } },
    },
  });
  assert.equal(failed.status.textContent, "FAILED");
  assert.match(failed.card.children.flatMap((child) => child.children).map((child) => child.textContent).join(" "), /Key rejected \(401\)/);
});

test("setup and exec_sql prompt constants contain the required fixed text", async () => {
  const { EXEC_SQL_PROMPT, RUNNER_SETUP_PROMPT_TEMPLATE } = await import("../src/shared/constants.js");
  assert.match(RUNNER_SETUP_PROMPT_TEMPLATE, /xk92fQ3nzL7mVp8sWjT4hD6yR1eB5cN2/);
  assert.match(EXEC_SQL_PROMPT, /create or replace function public\.exec_sql\(sql_text text\)/);
});

test("setup dispatches once through the existing content message without polling", async () => {
  const harness = await boot({ tabs: [{ id: 9, url: "https://lovable.dev/projects/project-123" }] });
  harness.inputById("migration-runner-key-input").value = 'my"$&key';
  await harness.clickAction(harness.actions, "Set up migration runner");

  assert.equal(harness.tabMessages.length, 1);
  assert.equal(harness.tabMessages[0].type, "LOVABURST_SUBMIT_OBJECTIVE");
  assert.match(harness.tabMessages[0].objective, /const RUNNER_KEY = "my"\$&key";/);
  assert.doesNotMatch(harness.tabMessages[0].objective, /xk92fQ3nzL7mVp8sWjT4hD6yR1eB5cN2/);
  assert.match(harness.tabMessages[0].objective, /Use JSON\.stringify semantics/);
  assert.equal(harness.fetchCount, 0);
  assert.equal(harness.status.textContent, "SETUP DISPATCHED");
  assert.match(harness.card.querySelector(".migration-runner-message").textContent, /Lovable to deploy \(~1-2 minutes\)/);
});

test("exec_sql helper injects its exact prompt or copies it when Lovable is closed", async () => {
  const opened = await boot({ tabs: [{ id: 5, url: "https://lovable.dev/projects/project-123" }] });
  await opened.clickAction(opened.helperActions, "Inject into Lovable AI");
  assert.deepEqual(opened.tabMessages[0], {
    type: "LOVABLE_PASTE_BOOTSTRAP",
    prompt: (await import("../src/shared/constants.js")).EXEC_SQL_PROMPT,
  });
  assert.match(opened.helperMessage.textContent, /Prompt injected/);

  const closed = await boot();
  await closed.clickAction(closed.helperActions, "Inject into Lovable AI");
  assert.equal(closed.clipboard[0], (await import("../src/shared/constants.js")).EXEC_SQL_PROMPT);
  assert.match(closed.helperMessage.textContent, /Lovable tab not open/);
});

test("runner verification encodes the key and persists the failure result", async () => {
  let requestedUrl = "";
  const harness = await boot({
    storage: {
      projectMigrationKeys: { "project-123": "a b&c" },
      projectSetup: { "project-123": { setupDispatchedAt: new Date().toISOString() } },
    },
    fetchImpl: async (url) => {
      requestedUrl = url;
      return {
        status: 401,
        headers: { get: () => "application/json" },
        json: async () => ({ ok: false, error: "unauthorized" }),
      };
    },
  });
  await harness.clickAction(harness.actions, "Test runner");
  assert.match(requestedUrl, /key=a%20b%26c$/);
  assert.equal(harness.values.projectSetup["project-123"].lastVerifyResult, "unauthorized");
  assert.match(harness.values.projectSetup["project-123"].lastVerifyError, /Key rejected \(401\)/);
  assert.equal(harness.status.textContent, "FAILED");
});

test("Run Status Apply migrations control is inline and fetches only on click", async () => {
  const source = await readFile(new URL("../src/popup/popup-tail.js", import.meta.url), "utf8");
  const start = source.indexOf("function renderMigrationAction(");
  const end = source.indexOf("\nasync function refreshChat()", start);
  assert.ok(start >= 0 && end > start);
  const values = {
    projectRunStatuses: {
      "project-123": { status: "schema-pending", startedAt: "run-1", runnerUrl: "https://runner.test/run" },
    },
  };
  const copy = new FakeElement("div");
  const tabs = { opened: 0, create() { this.opened += 1; } };
  let fetchCount = 0;
  const context = vm.createContext({
    ui: { runStatusText: { parentElement: copy } },
    workspace: { lovableProjectId: "project-123" },
    document: { createElement: (tag) => new FakeElement(tag) },
    chrome: {
      storage: {
        local: {
          async get() { return { projectRunStatuses: values.projectRunStatuses }; },
          async set(update) { values.projectRunStatuses = update.projectRunStatuses; },
        },
      },
      tabs,
    },
    fetch: async (url) => {
      fetchCount += 1;
      assert.equal(url, "https://runner.test/run");
      return {
        status: 200,
        json: async () => ({ ok: true, applied: ["001.sql"], skipped: ["000.sql"] }),
      };
    },
  });
  vm.runInContext(
    `let applyingMigrations = false;\n${source.slice(start, end)}\nglobalThis.testRenderMigrationAction = renderMigrationAction;`,
    context,
  );
  context.testRenderMigrationAction("project-123", null);
  let button = copy.querySelector("#applyMigrationsButton");
  assert.equal(button.hidden, true);
  context.testRenderMigrationAction("project-123", values.projectRunStatuses["project-123"]);
  button = copy.querySelector("#applyMigrationsButton");
  assert.equal(button.hidden, false);
  await button.click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fetchCount, 1);
  assert.equal(tabs.opened, 0);
  assert.deepEqual(values.projectRunStatuses["project-123"].applied, ["001.sql"]);
  assert.deepEqual(values.projectRunStatuses["project-123"].skipped, ["000.sql"]);
  assert.match(values.projectRunStatuses["project-123"].migrationMessage, /Migrations applied: 001\.sql/);
  assert.equal(button.hidden, true);
});

test("post-completion records the reported runner URL without fetching it", async () => {
  const { runPostCompletionPipeline } = await import("../src/shared/post-completion.js");
  let fetchCount = 0;
  globalThis.chrome = {};
  globalThis.fetch = async () => {
    fetchCount += 1;
    throw new Error("Unexpected request.");
  };
  const updates = [];
  const url = "https://project-123.lovableproject.com/api/public/ops/run-migrations?key=redacted";
  await runPostCompletionPipeline(
    "project-123",
    `[PRM_DONE]\nSchema was touched: yes\nMIGRATION_RUNNER_URL: ${url}`,
    { previewHost: "https://project-123.lovableproject.com" },
    async (_id, patch) => updates.push(patch),
  );
  assert.equal(fetchCount, 0);
  const pending = updates.find((item) => item.status === "schema-pending");
  assert.equal(pending.runnerUrl, url);
  assert.equal(pending.applied, null);
  assert.equal(pending.skipped, null);
});
