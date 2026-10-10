import assert from "node:assert/strict";
import test from "node:test";
import { estimateCostUsd, PRICING_BASIS, ProviderError, SUPPORTED_MODELS, VyceClient } from "../backend/vyce.mjs";

test("Vyce catalogue and completion use the required endpoints and bearer auth", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/models")) {
      return new Response(JSON.stringify({ data: SUPPORTED_MODELS.map(({ id }) => ({ id })) }), { status: 200 });
    }
    return new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", tool_calls: [{ id: "call-1" }] } }],
      usage: { prompt_tokens: 11, completion_tokens: 7 },
    }), { status: 200 });
  };
  const client = new VyceClient({ apiKey: "test-provider-key", fetchImpl });
  const models = await client.models();
  const completion = await client.complete({
    model: "claude-sonnet-4-6",
    messages: [{ role: "user", content: "Inspect files." }],
    tools: [{ type: "function", function: { name: "list_files", parameters: { type: "object" } } }],
  });
  assert.deepEqual(models.map(({ id, available }) => [id, available]), SUPPORTED_MODELS.map(({ id }) => [id, true]));
  assert.equal(completion.message.tool_calls[0].id, "call-1");
  assert.deepEqual(completion.usage, { prompt_tokens: 11, completion_tokens: 7 });
  assert.equal(calls[0].url, "https://vyceai.com/v1/models");
  assert.equal(calls[1].url, "https://vyceai.com/v1/chat/completions");
  assert.equal(calls[0].options.headers.Authorization, "Bearer test-provider-key");
  const body = JSON.parse(calls[1].options.body);
  assert.equal(body.model, "claude-sonnet-4-6");
  assert.equal(body.tools[0].function.name, "list_files");
});

test("provider errors distinguish authentication, quota, and malformed data", async () => {
  for (const [status, code] of [[401, "invalid_credentials"], [402, "insufficient_balance"], [429, "rate_limited"]]) {
    const client = new VyceClient({
      apiKey: "test-provider-key",
      fetchImpl: async () => new Response(JSON.stringify({ error: { message: "rejected" } }), { status }),
    });
    await assert.rejects(client.models(), (error) => error instanceof ProviderError && error.code === code);
  }
  const malformed = new VyceClient({ apiKey: "test-provider-key", fetchImpl: async () => new Response("not-json", { status: 200 }) });
  await assert.rejects(malformed.models(), (error) => error.code === "malformed_response");
  const malformedCatalog = new VyceClient({ apiKey: "test-provider-key", fetchImpl: async () => new Response(JSON.stringify({ models: [] }), { status: 200 }) });
  await assert.rejects(malformedCatalog.models(), (error) => error.code === "malformed_response");
  const missing = new VyceClient({ apiKey: "", fetchImpl: async () => { throw new Error("must not call"); } });
  await assert.rejects(missing.models(), (error) => error.code === "not_configured");
});

test("reference model prices are labeled estimates rather than live-verified prices", () => {
  assert.equal(estimateCostUsd("claude-sonnet-4-6", 1_000_000, 1_000_000), 18);
  assert.equal(estimateCostUsd("deepseek-v4-flash", 1_000_000, 1_000_000), 0.88);
  assert.equal(estimateCostUsd("gpt-6-luna", 1_000_000, 1_000_000), 4);
  assert.match(PRICING_BASIS, /not live-verified/);
});
