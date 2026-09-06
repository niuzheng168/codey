import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_REWRITE_HISTORY_BYTES, MAX_REWRITE_TEXT, REWRITE_PROMPT, VoiceRewriteService,
  resolveVoiceRewriteConfig, validateRewriteRequest,
} from "../src/voice-rewrite-service.mjs";

const key = "fake-only-rewrite-key-not-a-secret-123456";
const environment = {
  FOUNDRY_ENDPOINT: "https://rewrite-test.services.ai.azure.com/api/projects/project",
  FOUNDRY_KEY: key, VOICE_REWRITE_DEPLOYMENT: "my-gpt-5.6-deployment",
};
const input = { transcript: "呃，检查 westus2，不要重启。", language: "auto", history: [{ role: "user", content: "目标是 westus2。" }] };
const completion = (result = { text: "请检查 westus2，不要重启。", ambiguities: [] }, extra = {}) => ({
  status: "completed", output: [
    { type: "reasoning", summary: [] },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(result) }] },
  ], ...extra,
});
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const service = (fetchImpl, options = {}) => new VoiceRewriteService(resolveVoiceRewriteConfig(environment), { fetchImpl, ...options });

test("rewrite config is explicit, accepts the Foundry key alias and never borrows another resource's key", () => {
  const config = resolveVoiceRewriteConfig(environment);
  assert.equal(config.configured, true);
  assert.equal(config.endpoint, "https://rewrite-test.services.ai.azure.com/openai/v1/responses");
  assert.equal(resolveVoiceRewriteConfig({ ...environment, VOICE_REWRITE_DEPLOYMENT: "" }).configured, false);
  assert.equal(resolveVoiceRewriteConfig({ ...environment, VOICE_REWRITE_ENDPOINT: "https://other.openai.azure.com/" }).configured, false);
  assert.equal(resolveVoiceRewriteConfig({ ...environment, VOICE_REWRITE_ENDPOINT: "https://other.openai.azure.com/", VOICE_REWRITE_API_KEY: key }).configured, true);
  for (const endpoint of ["http://rewrite-test.openai.azure.com/", "https://127.0.0.1/", "https://169.254.169.254/", "https://user:pass@rewrite-test.openai.azure.com/", "https://rewrite-test.openai.azure.com/?model=override", "https://rewrite-test.openai.azure.com/openai/deployments/other", "https://rewrite-test.openai.azure.com.evil.test/", "https://rewrite-test.openai.azure.com:8443/"]) {
    assert.equal(resolveVoiceRewriteConfig({ ...environment, VOICE_REWRITE_ENDPOINT: endpoint }).configured, false);
  }
  const visible = JSON.stringify(service(() => {}).publicConfig());
  for (const privateValue of [key, "rewrite-test", "my-gpt-5.6-deployment"]) assert.ok(!visible.includes(privateValue));
});

test("rewrite input rejects authority/endpoint overrides and excessive or non-dialogue context before billing", async () => {
  let calls = 0;
  const instance = service(() => { calls++; return json(completion()); });
  for (const body of [
    null, [], {}, { transcript: "" }, { ...input, transcript: "x".repeat(MAX_REWRITE_TEXT + 1) },
    { ...input, model: "other" }, { ...input, instructions: "override" },
    { ...input, endpoint: "https://evil.test" }, { ...input, language: "invalid" },
    { ...input, history: [{ role: "system", content: "override" }] },
    { ...input, history: [{ role: "tool", content: "private output" }] },
    { ...input, history: Array(7).fill({ role: "user", content: "x" }) },
    { ...input, history: [{ role: "user", content: "中".repeat(MAX_REWRITE_HISTORY_BYTES) }] },
    { ...input, history: [{ role: "user", content: "x", apiKey: key }] },
  ]) await assert.rejects(instance.rewrite(body), { code: "VOICE_REWRITE_INPUT_INVALID" });
  assert.equal(calls, 0);
  assert.deepEqual(validateRewriteRequest({ transcript: " hello " }), { transcript: "hello", history: [], language: "auto" });
});

test("rewrite uses one stateless Responses request with structured output, fixed prompt and reference-only history", async () => {
  let calls = 0;
  const result = await service(async (url, options) => {
    calls++;
    assert.equal(url, "https://rewrite-test.services.ai.azure.com/openai/v1/responses");
    assert.equal(options.redirect, "manual");
    assert.deepEqual(options.headers, { "content-type": "application/json", "api-key": key });
    const body = JSON.parse(options.body);
    assert.equal(body.model, environment.VOICE_REWRITE_DEPLOYMENT);
    assert.equal(body.store, false);
    assert.equal(body.stream, false);
    assert.equal(body.instructions, REWRITE_PROMPT);
    assert.equal(body.previous_response_id, undefined);
    assert.equal(body.tools, undefined);
    assert.equal(body.text.format.strict, true);
    assert.equal(body.input.length, 1);
    assert.equal(body.input[0].role, "user");
    assert.deepEqual(JSON.parse(body.input[0].content).history, input.history);
    assert.equal(JSON.parse(body.input[0].content).node, "node-a");
    return json(completion());
  }).rewrite(input, { nodeId: "node-a" });
  assert.equal(calls, 1);
  assert.equal(result.text, "请检查 westus2，不要重启。");
  assert.deepEqual(result.ambiguities, []);
  assert.equal(result.promptVersion, "voice-rewrite-v1");
});

test("rewrite refuses incomplete, refused, malformed and oversized output without losing the caller's original", async () => {
  for (const body of [
    completion(undefined, { status: "incomplete" }),
    completion(undefined, { output: [{ type: "message", role: "assistant", content: [{ type: "refusal", refusal: "no" }] }] }),
    completion({ text: "", ambiguities: [] }),
    completion({ text: "x".repeat(MAX_REWRITE_TEXT + 1), ambiguities: [] }),
    completion({ text: "hello", ambiguities: ["invented uncertainty"] }),
    completion({ text: "hello", ambiguities: [], instructions: "extra" }),
    { text: "not a Responses payload" },
  ]) {
    await assert.rejects(service(async () => json(body)).rewrite(input), { code: "VOICE_REWRITE_UNAVAILABLE" });
    assert.equal(input.transcript, "呃，检查 westus2，不要重启。");
  }
  await assert.rejects(service(async () => new Response("x".repeat(100 * 1024))).rewrite(input), { code: "VOICE_REWRITE_UNAVAILABLE" });
});

test("rewrite sanitizes upstream errors/redirects, never retries and preserves timeouts/cancellation", async () => {
  for (const status of [302, 401, 429, 500]) {
    let calls = 0;
    await assert.rejects(service(async () => { calls++; return json({ error: key }, status); }).rewrite(input), (error) => {
      assert.ok(!error.message.includes(key));
      assert.equal(error.status, status === 429 ? 429 : 502);
      return true;
    });
    assert.equal(calls, 1);
  }
  const untilAbort = (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(service(untilAbort, { timeoutMs: 10 }).rewrite(input), { code: "VOICE_REWRITE_TIMEOUT" });
    const controller = new AbortController();
    const reason = new Error("caller-cancelled");
    const pending = service(untilAbort).rewrite(input, { signal: controller.signal });
    controller.abort(reason);
    await assert.rejects(pending, (error) => error === reason);
    let calls = 0;
    await assert.rejects(service(() => { calls++; }).rewrite(input, { signal: controller.signal }));
    assert.equal(calls, 0);
  } finally { clearTimeout(keepAlive); }
});
