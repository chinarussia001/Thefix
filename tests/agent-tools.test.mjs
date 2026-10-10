import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DockerWorkspace } from "../backend/execution.mjs";
import { TOOL_DEFINITIONS, validateArguments } from "../backend/agent.mjs";

const execFileAsync = promisify(execFile);

test("only the supported structured tools and declared arguments are accepted", () => {
  const names = TOOL_DEFINITIONS.map((tool) => tool.function.name);
  assert.ok(names.includes("read_file"));
  assert.ok(names.includes("write_file"));
  assert.ok(names.includes("run_command"));
  assert.throws(() => validateArguments("run_command", { command: "npm test", extra: true }), /Unexpected arguments/);
  assert.throws(() => validateArguments("read_file", {}), /Missing required arguments/);
  assert.throws(() => validateArguments("run_command", { command: "npm test", timeoutSeconds: 121 }), /timeoutSeconds/);
  assert.throws(() => validateArguments("search_files", { query: "" }), /query/);
  assert.throws(() => validateArguments("read_file", { path: "a".repeat(241) }), /path/);
  assert.throws(() => validateArguments("run_command", { command: "npm test", timeoutSeconds: 1.5 }), /timeoutSeconds/);
  assert.deepEqual(validateArguments("write_file", { path: "src/app.js", content: "export {};" }), {
    path: "src/app.js",
    content: "export {};",
  });
  assert.throws(() => validateArguments("execute_sql", {}), /not available/);
});

test("Docker workspace performs real isolated file edits and commands", {
  skip: process.env.RUN_DOCKER_TESTS !== "1",
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "lovarpm-docker-test-"));
  const source = join(root, "source");
  const workspace = new DockerWorkspace({
    root: join(root, "workspaces"),
    secretRoot: join(root, "quarantine"),
    taskId: "f2e6cc98-f40b-477a-b73c-206f12d9160f",
    repository: "test/local",
    branch: "main",
    sourceRepositoryPath: source,
    githubToken: "",
  });
  try {
    await mkdir(source);
    await execFileAsync("git", ["init", "-b", "main", source]);
    await execFileAsync("git", ["-C", source, "config", "user.name", "Test"]);
    await execFileAsync("git", ["-C", source, "config", "user.email", "test@example.invalid"]);
    await mkdir(join(source, "src"));
    await writeFile(join(source, "src", "index.js"), "export const value = 1;\n");
    await writeFile(join(source, ".env"), "PRIVATE_VALUE=do-not-mount\n");
    await writeFile(join(source, ".env.example"), "PUBLIC_VALUE=example\n");
    await execFileAsync("git", ["-C", source, "add", "."]);
    await execFileAsync("git", ["-C", source, "commit", "-m", "initial"]);

    await workspace.prepare();
    await assert.rejects(workspace.readFile(".env"), /credentials and Git internals/);
    const hidden = await workspace.runCommand("test ! -e .env && test -f .env.example && test -d /workspace");
    assert.equal(hidden.exitCode, 0);
    await workspace.writeFile("src/generated.js", "export const generated = true;\n");
    const checked = await workspace.runCommand("node --check src/generated.js");
    assert.equal(checked.exitCode, 0, checked.stderr);
    assert.equal(await workspace.readFile("src/generated.js"), "export const generated = true;\n");
    assert.ok((await workspace.changedPaths()).includes("src/generated.js"));
    await workspace.close();
    await workspace.restoreSecrets();
    assert.equal(await readFile(join(workspace.directory, ".env"), "utf8"), "PRIVATE_VALUE=do-not-mount\n");
  } finally {
    await workspace.close();
    await workspace.restoreSecrets();
    await rm(root, { recursive: true, force: true });
  }
});
