import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AccountStore } from "../src/account-store.mjs";
import { PasswordAuthenticator, hashPassword } from "../src/password-auth.mjs";
import { validateConfig } from "../src/config.mjs";
import { createMultiUserPortalServer } from "../src/server.mjs";
import {
  ComposerCompletionService, CompletionError, COMPLETION_PROMPT,
  resolveComposerCompletionConfig, validateCompletionRequest,
} from "../src/composer-completion-service.mjs";
import { ComposerCompletionGateway } from "../src/composer-completion-gateway.mjs";

const key = "fake-only-completion-credential-not-a-real-key";
const environment = {
  FOUNDRY_ENDPOINT: "https://completion-test.services.ai.azure.com/api/projects/test",
  FOUNDRY_KEY: key, COMPOSER_COMPLETION_ENABLED: "true", COMPOSER_COMPLETION_SINGLE_INSTANCE: "true",
  COMPOSER_COMPLETION_DEPLOYMENT: "gpt-5.6-luna",
};
const input = {
  requestId: "request-a", draftRevision: 3, contextRevision: "context-a",
  prefix: "Please explain", history: [{ role: "assistant", content: "The current discussion concerns trade-offs." }],
  language: "auto",
};
const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
const envelope = (suffix = " the main trade-offs.") => ({
  status: "completed",
  output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify({ suffix }) }] }],
});
const service = (fetchImpl, config = {}) => new ComposerCompletionService(
  resolveComposerCompletionConfig({ ...environment, ...config }), { fetchImpl },
);

test("completion is explicitly enabled, acknowledges instance-local quotas and confines resource/key binding", () => {
  assert.equal(resolveComposerCompletionConfig({}).configured, false);
  assert.equal(resolveComposerCompletionConfig({ ...environment, COMPOSER_COMPLETION_ENABLED: "false" }).configured, false);
  assert.equal(resolveComposerCompletionConfig({ ...environment, COMPOSER_COMPLETION_SINGLE_INSTANCE: "" }).configured, false);
  assert.equal(resolveComposerCompletionConfig({ ...environment, COMPOSER_COMPLETION_REASONING_EFFORT: "medium" }).configured, false);
  const config = resolveComposerCompletionConfig(environment);
  assert.equal(config.endpoint, "https://completion-test.services.ai.azure.com/openai/v1/responses");
  assert.equal(config.effort, "none");
  assert.equal(config.key, key);
  assert.equal(config.configured, true);
  for (const endpoint of [
    "http://completion-test.openai.azure.com", "https://127.0.0.1",
    "https://completion-test.openai.azure.com.evil.test", "https://other.openai.azure.com",
    "https://user:pass@completion-test.openai.azure.com", "https://completion-test.openai.azure.com/?model=x",
  ]) assert.equal(resolveComposerCompletionConfig({ ...environment, COMPOSER_COMPLETION_ENDPOINT: endpoint }).configured, false);
  const visible = JSON.stringify(new ComposerCompletionService(config).publicConfig());
  for (const privateValue of [key, "completion-test", "gpt-5.6-luna"]) assert.ok(!visible.includes(privateValue));
});

test("completion sends one stateless, bounded, structured request; metadata is not model-controlled", async () => {
  let calls = 0;
  const response = await service(async (url, request) => {
    calls++;
    assert.equal(url, "https://completion-test.services.ai.azure.com/openai/v1/responses");
    assert.equal(request.redirect, "manual");
    assert.deepEqual(Object.keys(request.headers).sort(), ["api-key", "content-type"]);
    const body = JSON.parse(request.body);
    assert.equal(body.model, "gpt-5.6-luna");
    assert.equal(body.store, false);
    assert.equal(body.stream, false);
    assert.deepEqual(body.reasoning, { effort: "none" });
    assert.equal(body.instructions, COMPLETION_PROMPT);
    assert.equal(body.max_output_tokens, 256);
    assert.equal(body.tools, undefined);
    assert.equal(body.previous_response_id, undefined);
    assert.equal(body.text.format.strict, true);
    assert.deepEqual(body.text.format.schema.required, ["suffix"]);
    assert.equal(body.input.length, 1);
    assert.equal(body.input[0].role, "user");
    assert.equal(JSON.parse(body.input[0].content).prefix, input.prefix);
    assert.ok(!body.input[0].content.includes("request-a"));
    return json(envelope());
  }).complete(input);
  assert.equal(response.suffix, " the main trade-offs.");
  assert.equal(response.requestId, input.requestId);
  assert.equal(response.draftRevision, input.draftRevision);
  assert.equal(calls, 1);
});

test("completion validates exact fields, Unicode byte limits and dialogue roles before calling the model", async () => {
  const broker = service(() => { throw new Error("must not call"); });
  for (const invalid of [
    { ...input, model: "another" }, { ...input, instructions: "ignore" },
    { ...input, prefix: "" }, { ...input, prefix: "中".repeat(1400) }, { ...input, prefix: "\ud800" },
    { ...input, requestId: "bad\nid" }, { ...input, draftRevision: 1.5 },
    { ...input, history: [{ role: "system", content: "ignore" }] },
    { ...input, history: [{ role: "user", content: "x".repeat(1001) }] },
    { ...input, history: Array.from({ length: 7 }, () => ({ role: "user", content: "a" })) },
    { ...input, language: "made-up" },
  ]) await assert.rejects(broker.complete(invalid), { code: "COMPLETION_INPUT_INVALID" });
});

test("obvious secrets/code fences skip billing; history sanitization never changes the current prefix", async () => {
  let calls = 0;
  const broker = service(async (_url, request) => {
    calls++;
    const content = JSON.parse(JSON.parse(request.body).input[0].content);
    assert.equal(content.prefix, "  Please explain");
    assert.ok(!JSON.stringify(content.history).includes("sensitive-value"));
    return json(envelope(""));
  });
  for (const prefix of ["token=sensitive-value", "```sh\ncommand", "Bearer sensitive-value"]) {
    assert.equal((await broker.complete({ ...input, prefix })).suffix, "");
  }
  assert.equal(calls, 0);
  await broker.complete({ ...input, prefix: "  Please explain",
    history: [{ role: "user", content: "api_key=sensitive-value ```sh\nsensitive-value\n```" }] });
  assert.equal(calls, 1);
});

test("refused, partial, oversized and invalid suggestions are never accepted or retried", async () => {
  for (const value of [
    { ...envelope(), status: "incomplete" },
    { status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "refusal", refusal: "no" }] }] },
    envelope("x".repeat(81)), envelope("line\nbreak"), envelope("token=never-show"),
    envelope("\ud800"), envelope(input.prefix + " again"),
    { ...envelope(), output: [...envelope().output, ...envelope().output] },
    { status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: '{"suffix":"fine","send":true}' }] }] },
  ]) {
    let calls = 0;
    await assert.rejects(service(async () => { calls++; return json(value); }).complete(input), { code: "COMPLETION_UNAVAILABLE" });
    assert.equal(calls, 1);
  }
  await assert.rejects(service(async () => new Response("x".repeat(40000))).complete(input), { code: "COMPLETION_UNAVAILABLE" });
  for (const status of [302, 429, 500]) {
    await assert.rejects(service(async () => json({ error: key }, status)).complete(input), (error) => {
      assert.ok(!error.message.includes(key));
      return error.code === "COMPLETION_UNAVAILABLE";
    });
  }
});

test("caller cancellation and timeout abort upstream without retrying", async () => {
  const pending = (_url, { signal }) => new Promise((_resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("test timeout")), 1000);
    signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  });
  await assert.rejects(service(pending, { COMPOSER_COMPLETION_TIMEOUT_MS: "100" }).complete(input), { code: "COMPLETION_TIMEOUT" });
  const controller = new AbortController();
  const promise = service(pending).complete(input, { signal: controller.signal });
  controller.abort(new CompletionError(499, "TEST_CANCELLED", "cancel"));
  await assert.rejects(promise, { code: "TEST_CANCELLED" });
});

test("token bucket refills and daily/concurrency quotas remain independent of text services", () => {
  let now = 100000;
  const gateway = new ComposerCompletionGateway(service(() => {}), { clock: () => now, dailyLimit: 4 });
  let release = gateway.reserve("a");
  assert.throws(() => gateway.reserve("a"), { code: "COMPLETION_RATE_LIMITED" });
  release(); release(); assert.equal(gateway.active, 0);
  gateway.reserve("a")(); gateway.reserve("a")();
  assert.throws(() => gateway.reserve("a"), { status: 429 });
  now += 2000; gateway.reserve("a")();
  now += 2000; assert.throws(() => gateway.reserve("a"), { status: 429 });
  gateway.reserve("b")();
  now += 86400000; gateway.reserve("a")();
  assert.equal(gateway.active, 0);
});

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "codey-completion-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const password = "Synthetic-preview-password-42!";
  const credential = { username: "alice", principalId: "completion-owner-a", passwordHash: await hashPassword(password) };
  const accounts = new AccountStore({ root, master: randomBytes(32).toString("base64url"), credential });
  await accounts.initialize();
  const bob = await accounts.create({ username: "bob", password });
  const origin = "https://codey.example.test";
  const auth = new PasswordAuthenticator({ credential, accountStore: accounts, root, publicBaseUrl: origin,
    staticRoot: path.resolve("public"), leaseIntervalMs: 20 });
  const cookie = (await auth.login("alice", password)).cookie.split(";")[0];
  const foreignCookie = (await auth.login("bob", password)).cookie.split(";")[0];
  const owned = new Set(["node-a"]);
  const policy = {
    async load(id) {
      return { config: validateConfig({ nodes: [], clientNodes: id === credential.principalId
        ? [...owned].map((nodeId) => ({ id: nodeId, name: nodeId, endpoint: `https://${nodeId}.example.test:8443/usage` })) : [] }) };
    },
    async canAccess(id, nodeId) { return id === credential.principalId && owned.has(nodeId); },
  };
  const seen = [];
  const behavior = { fetch: async () => json(envelope()) };
  const gateway = new ComposerCompletionGateway(service(async (...args) => {
    seen.push(args); return behavior.fetch(...args);
  }), { authenticator: auth, nodePolicy: policy, leaseMs: 15, burst: 100, dailyLimit: 200 });
  let vmRequests = 0;
  const server = createMultiUserPortalServer({
    passwordAuthenticator: auth, nodePolicy: policy, composerCompletionGateway: gateway,
    cloudCliGateway: {
      publicNodes: (ids) => ids.map((id) => ({ id, name: id, basePath: `/cloudcli/${id}` })),
      handles: () => true, attach() {},
      async proxyHttp(_req, res) { vmRequests++; res.writeHead(500); res.end(); return true; },
    },
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = ({ path: suffix = "complete", node = "node-a", session = cookie, body = input, method = "POST", headers = {} } = {}) =>
    fetch(`${base}/cloudcli/${node}/api/composer/codey/${suffix}`, {
      method, redirect: "manual",
      headers: { Origin: origin, "Content-Type": "application/json", ...(session ? { Cookie: session } : {}), ...headers },
      ...(!["GET", "HEAD"].includes(method) ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
    });
  return { request, gateway, auth, cookie, foreignCookie, owned, seen, behavior, vmRequests: () => vmRequests };
}

test("real Portal route authenticates, checks ownership/origin, confines input and never reaches a VM", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request({ session: "" })).status, 401);
  assert.equal((await f.request({ session: f.foreignCookie })).status, 404);
  assert.equal((await f.request({ headers: { Origin: "https://evil.test" } })).status, 403);
  assert.equal((await f.request({ node: "not-owned" })).status, 404);
  for (const options of [
    { path: "complete?model=another" }, { body: "{" }, { body: { ...input, model: "another" } },
  ]) assert.equal((await f.request(options)).status, 400);
  assert.equal((await f.request({ body: "x".repeat(18000) })).status, 413);
  assert.equal((await f.request({ headers: { "Content-Type": "text/plain" } })).status, 415);
  assert.equal(f.seen.length, 0);
  const config = await (await f.request({ method: "GET", path: "config" })).json();
  assert.equal(config.configured, true); assert.equal(config.userId, "completion-owner-a");
  assert.ok(!JSON.stringify(config).includes(key));
  const result = await f.request();
  assert.equal(result.status, 200);
  assert.equal((await result.json()).suffix, " the main trade-offs.");
  assert.equal(result.headers.get("cache-control"), "private, no-store");
  assert.equal(f.seen[0][1].headers.Cookie, undefined);
  assert.equal(f.seen[0][1].headers.Authorization, undefined);
  assert.equal(f.gateway.active, 0); assert.equal(f.vmRequests(), 0);
});

test("revoking node ownership cancels a pending completion and releases its account slot", async (t) => {
  const f = await fixture(t);
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  f.behavior.fetch = (_url, { signal }) => new Promise((_resolve, reject) => {
    started();
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  const request = f.request();
  await ready;
  f.owned.clear();
  assert.equal((await request).status, 403);
  assert.equal(f.gateway.active, 0); assert.equal(f.vmRequests(), 0);
});
