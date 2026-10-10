import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");

test("Chrome manifest points only at existing Lovable and agent assets", async () => {
  const manifest = JSON.parse(await readFile(resolve(root, "manifest.json"), "utf8"));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.background.service_worker, "src/background/service-worker-v020.js");
  assert.ok(manifest.permissions.includes("alarms"));
  assert.ok(!manifest.host_permissions.some((permission) => permission.includes("chatgpt")));
  assert.ok(!manifest.content_scripts.some((script) => script.matches.some((match) => match.includes("chatgpt"))));
  await access(resolve(root, manifest.background.service_worker));
  await access(resolve(root, manifest.side_panel.default_path));
  for (const script of manifest.content_scripts) {
    for (const file of [...(script.js || []), ...(script.css || [])]) await access(resolve(root, file));
  }
});

test("extension UI exposes exactly the configured Vyce models without obsolete controls", async () => {
  const html = await readFile(resolve(root, "src/popup/popup.html"), "utf8");
  const popup = await readFile(resolve(root, "src/popup/popup-agent.js"), "utf8");
  const worker = await readFile(resolve(root, "src/background/service-worker.js"), "utf8");
  assert.deepEqual([...html.matchAll(/<option value="([^"]+)"/g)].map((match) => match[1]), [
    "claude-sonnet-4-6",
    "deepseek-v4-flash",
    "gpt-6-luna",
  ]);
  assert.match(html, /id="licenseKey"/);
  assert.match(popup, /LOVARPM_LICENSE_ACTIVATE/);
  assert.match(worker, /authorizeOperation/);
  assert.doesNotMatch(`${popup}\n${worker}`, /process\.env\.VYCE_API_KEY|sk-[A-Za-z0-9_-]{24}/);
  assert.doesNotMatch(html, /ChatGPT|Migration Runner|Execute SQL Script/i);
});
