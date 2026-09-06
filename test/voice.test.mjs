import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AccountStore } from "../src/account-store.mjs";
import { PasswordAuthenticator, hashPassword } from "../src/password-auth.mjs";
import { validateConfig } from "../src/config.mjs";
import { createMultiUserPortalServer } from "../src/server.mjs";
import { VoiceGateway } from "../src/voice-gateway.mjs";
import { MAX_VOICE_BYTES, VoiceError, VoiceService, resolveVoiceServiceConfig, validateVoiceWave } from "../src/voice-service.mjs";

const azureKey = "test-only-azure-key-".repeat(3);
const maiKey = "test-only-mai-key-".repeat(3);
const environment = {
  FOUNDRY_ENDPOINT: "https://voice-test.services.ai.azure.com/api/projects/test-project",
  FOUNDRY_API_KEY: azureKey,
  MAI_TRANSCRIBE_SPEECH_ENDPOINT: "https://mai-test.cognitiveservices.azure.com/",
  MAI_TRANSCRIBE_KEY: maiKey,
};
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

function wave(seconds = 1) {
  const result = Buffer.alloc(44 + seconds * 32000);
  result.write("RIFF", 0);
  result.writeUInt32LE(result.length - 8, 4);
  result.write("WAVEfmt ", 8);
  result.writeUInt32LE(16, 16);
  result.writeUInt16LE(1, 20);
  result.writeUInt16LE(1, 22);
  result.writeUInt32LE(16000, 24);
  result.writeUInt32LE(32000, 28);
  result.writeUInt16LE(2, 32);
  result.writeUInt16LE(16, 34);
  result.write("data", 36);
  result.writeUInt32LE(result.length - 44, 40);
  return result;
}

test("voice configuration exposes no keys/hosts and refuses the unsupported OpenAI-style MAI endpoint", () => {
  const config = resolveVoiceServiceConfig(environment);
  const service = new VoiceService(config);
  const visible = service.publicConfig("owner-a");
  assert.deepEqual(visible.providers.map(({ configured }) => configured), [true, true]);
  for (const secret of [azureKey, maiKey, "voice-test", "mai-test", "endpoint", "api-key"]) {
    assert.ok(!JSON.stringify(visible).includes(secret));
  }
  assert.equal(config.providers[0].endpoint, "https://voice-test.cognitiveservices.azure.com/speechtotext/transcriptions:transcribe?api-version=2025-10-15");
  const old = new VoiceService(resolveVoiceServiceConfig({
    FOUNDRY_ENDPOINT: environment.FOUNDRY_ENDPOINT, FOUNDRY_API_KEY: azureKey,
    MAI_TRANSCRIBE_ENDPOINT: "https://voice-test.openai.azure.com/openai/deployments/mai-transcribe-1/audio/transcriptions?api-version=2025-03-01-preview",
  }));
  assert.equal(old.configured("azure-speech"), true);
  assert.equal(old.configured("mai-transcribe"), false);
  for (const endpoint of ["http://voice-test.cognitiveservices.azure.com/", "https://127.0.0.1/", "https://169.254.169.254/", "https://user:pass@voice-test.cognitiveservices.azure.com/", "https://voice-test.cognitiveservices.azure.com/?url=https://evil.test"]) {
    assert.equal(new VoiceService(resolveVoiceServiceConfig({ ...environment, AZURE_SPEECH_ENDPOINT: endpoint })).configured("azure-speech"), false);
  }
});

test("PCM validation bounds duration, encoding and RIFF structure before any transcription is billed", () => {
  assert.equal(validateVoiceWave(wave()).durationMs, 1000);
  assert.equal(validateVoiceWave(wave(120)).durationMs, 120000);
  for (const invalid of [Buffer.from("not audio"), wave(0), wave(121), Buffer.concat([wave(), Buffer.from("extra")])]) {
    assert.throws(() => validateVoiceWave(invalid), VoiceError);
  }
  for (const [offset, value] of [[20, 3], [22, 2], [24, 48000], [28, 123], [32, 4], [34, 32]]) {
    const invalid = wave();
    invalid.writeUInt16LE(value, offset);
    assert.throws(() => validateVoiceWave(invalid), VoiceError);
  }
});

test("Azure and MAI use the verified Speech multipart protocol with distinct keys and no model fallback", async () => {
  const seen = [];
  const service = new VoiceService(resolveVoiceServiceConfig(environment), {
    async fetchImpl(url, request) {
      seen.push({ url, request, definition: JSON.parse(request.body.get("definition")) });
      assert.equal(request.method, "POST");
      assert.equal(request.redirect, "manual");
      assert.deepEqual([...request.body.keys()], ["audio", "definition"]);
      assert.equal(request.body.get("audio").type, "audio/wav");
      assert.deepEqual(Buffer.from(await request.body.get("audio").arrayBuffer()), wave());
      assert.deepEqual(Object.keys(request.headers), ["Ocp-Apim-Subscription-Key"]);
      return json({ combinedPhrases: [{ text: "请检查项目测试。" }] });
    },
  });
  assert.equal((await service.transcribe({ provider: "azure-speech", language: "zh-CN", audio: wave() })).text, "请检查项目测试。");
  assert.deepEqual(seen[0].definition, { locales: ["zh-CN"], profanityFilterMode: "None" });
  assert.equal(seen[0].request.headers["Ocp-Apim-Subscription-Key"], azureKey);
  await service.transcribe({ provider: "mai-transcribe", language: "zh-CN", audio: wave() });
  assert.equal(seen[1].request.headers["Ocp-Apim-Subscription-Key"], maiKey);
  assert.deepEqual(seen[1].definition, {
    locales: ["zh"],
    enhancedMode: { enabled: true, model: "MAI-Transcribe-2", modelOptions: { transcribeStyle: "verbatim" } },
  });
  await service.transcribe({ provider: "mai-transcribe", language: "auto", audio: wave() });
  assert.ok(!("locales" in seen[2].definition));
});

test("MAI 1.5 uses its exact model with a same-resource Foundry key and never sends MAI 2-only options", async () => {
  const definitions = [];
  const service = new VoiceService(resolveVoiceServiceConfig({
    FOUNDRY_ENDPOINT: environment.FOUNDRY_ENDPOINT,
    FOUNDRY_API_KEY: azureKey,
    AZURE_SPEECH_ENDPOINT: "https://voice-test.cognitiveservices.azure.com/",
    MAI_TRANSCRIBE_SPEECH_ENDPOINT: "https://voice-test.cognitiveservices.azure.com/",
    MAI_TRANSCRIBE_MODEL: "MAI-Transcribe-1.5",
  }), {
    async fetchImpl(url, request) {
      assert.equal(new URL(url).hostname, "voice-test.cognitiveservices.azure.com");
      assert.equal(request.headers["Ocp-Apim-Subscription-Key"], azureKey);
      definitions.push(JSON.parse(request.body.get("definition")));
      return json({ combinedPhrases: [{ text: "MAI 1.5 transcript" }] });
    },
  });
  assert.equal(service.configured("mai-transcribe"), true);
  for (const language of ["auto", "en-US", "zh-CN"]) {
    assert.equal((await service.transcribe({ provider: "mai-transcribe", language, audio: wave() })).text, "MAI 1.5 transcript");
  }
  assert.deepEqual(definitions, [
    { enhancedMode: { enabled: true, model: "MAI-Transcribe-1.5" } },
    { locales: ["en"], enhancedMode: { enabled: true, model: "MAI-Transcribe-1.5" } },
    { locales: ["zh"], enhancedMode: { enabled: true, model: "MAI-Transcribe-1.5" } },
  ]);
});

test("MAI cannot reuse another resource's Foundry key or accept an unknown model", () => {
  const service = new VoiceService(resolveVoiceServiceConfig({
    FOUNDRY_ENDPOINT: environment.FOUNDRY_ENDPOINT,
    FOUNDRY_API_KEY: azureKey,
    MAI_TRANSCRIBE_SPEECH_ENDPOINT: environment.MAI_TRANSCRIBE_SPEECH_ENDPOINT,
    MAI_TRANSCRIBE_MODEL: "MAI-Transcribe-1.5",
  }));
  assert.equal(service.configured("azure-speech"), true);
  assert.equal(service.configured("mai-transcribe"), false);
  assert.equal(new VoiceService(resolveVoiceServiceConfig({
    ...environment, MAI_TRANSCRIBE_MODEL: "unexpected",
  })).configured("mai-transcribe"), false);
});

test("provider errors, redirects and invalid results are sanitized without leaking credentials or trying another service", async () => {
  for (const makeResponse of [
    () => json({ error: { message: `secret ${azureKey} ${maiKey}` } }, 401),
    () => new Response(null, { status: 302, headers: { location: "https://attacker.example/steal" } }),
    () => json({ text: "wrong schema" }),
    () => new Response("x".repeat(512 * 1024 + 1)),
  ]) {
    let calls = 0;
    const service = new VoiceService(resolveVoiceServiceConfig(environment), { fetchImpl: async () => { calls++; return makeResponse(); } });
    await assert.rejects(service.transcribe({ provider: "mai-transcribe", language: "auto", audio: wave() }), (error) => {
      assert.equal(error.status, 502);
      assert.ok(!error.message.includes(maiKey));
      assert.ok(!error.message.includes(azureKey));
      assert.ok(!error.message.includes("attacker"));
      return true;
    });
    assert.equal(calls, 1);
  }
});

test("voice provider timeout and caller cancellation abort the upstream request", async () => {
  const fetchImpl = (_url, { signal }) => new Promise((_resolve, reject) => {
    const keepAlive = setTimeout(() => reject(new Error("test timeout")), 1000);
    const abort = () => { clearTimeout(keepAlive); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  const service = new VoiceService(resolveVoiceServiceConfig(environment), { fetchImpl, timeoutMs: 20 });
  await assert.rejects(service.transcribe({ provider: "azure-speech", language: "auto", audio: wave() }), { status: 504, code: "VOICE_TIMEOUT" });
  const controller = new AbortController();
  const pending = service.transcribe({ provider: "azure-speech", language: "auto", audio: wave(), signal: controller.signal });
  const revoked = new VoiceError(401, "VOICE_LOGIN_REQUIRED", "revoked");
  controller.abort(revoked);
  await assert.rejects(pending, (error) => error === revoked);
});

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "codey-voice-test-"));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("codey-voice-test-"));
    await rm(root, { recursive: true, force: true });
  });
  const password = "Test-only-voice-account-42!";
  const credential = { username: "alice", principalId: "voice-owner-a", passwordHash: await hashPassword(password) };
  const accounts = new AccountStore({ root, master: randomBytes(32).toString("base64url"), credential });
  await accounts.initialize();
  const bob = await accounts.create({ username: "bob", password });
  const origin = "https://codey.example.test";
  const auth = new PasswordAuthenticator({ credential, accountStore: accounts, root, publicBaseUrl: origin, staticRoot: path.resolve("public"), leaseIntervalMs: 20 });
  const cookieA = (await auth.login("alice", password)).cookie.split(";")[0];
  const cookieB = (await auth.login("bob", password)).cookie.split(";")[0];
  const owned = new Map([[credential.principalId, ["node-a"]], [bob.id, ["node-b"]]]);
  const policy = {
    async load(id) {
      return { config: validateConfig({ nodes: [], clientNodes: (owned.get(id) || []).map((nodeId) => ({ id: nodeId, name: nodeId, endpoint: `https://${nodeId}.example.test:8443/usage` })) }) };
    },
    async canAccess(id, nodeId) { return owned.get(id)?.includes(nodeId) || false; },
  };
  const seen = [];
  const behavior = { fetch: async () => json({ combinedPhrases: [{ text: "Hello from voice" }] }) };
  const service = new VoiceService(resolveVoiceServiceConfig(environment), { fetchImpl: async (...args) => { seen.push(args); return behavior.fetch(...args); } });
  let clock = Date.now();
  const gateway = new VoiceGateway(service, { authenticator: auth, nodePolicy: policy, clock: () => clock, leaseMs: 15, uploadTimeoutMs: 200 });
  let vmRequests = 0;
  const server = createMultiUserPortalServer({
    passwordAuthenticator: auth, nodePolicy: policy, voiceGateway: gateway,
    cloudCliGateway: {
      publicNodes: (ids) => ids.map((id) => ({ id, basePath: `/cloudcli/${id}`, name: id })),
      handles: () => true, attach() {},
      async proxyHttp(_req, res) { vmRequests++; res.writeHead(500); res.end("must not proxy voice"); return true; },
    },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (node, cookie, { path: suffix = "transcribe?provider=azure-speech&language=auto", method = "POST", body = wave(), extra = {} } = {}) => fetch(`${base}/cloudcli/${node}/api/voice/codey/${suffix}`, {
    method, redirect: "manual",
    headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), "Content-Type": "audio/wav", ...extra },
    ...(!["GET", "HEAD"].includes(method) ? { body } : {}),
  });
  return { request, cookieA, cookieB, auth, owned, seen, gateway, behavior, base,
    nextMinute() { clock += 61000; }, vmRequests: () => vmRequests };
}

test("voice HTTP uses real portal sessions, enforces per-node ownership and never forwards credentials/audio to VMs", async (t) => {
  const f = await fixture(t);
  for (const method of ["GET", "POST", "HEAD"]) {
    assert.equal((await f.request("node-a", "", { method, path: method === "POST" ? "transcribe?provider=azure-speech" : "config" })).status, 401);
  }
  assert.equal((await f.request("node-a", "__Host-codey_session=fake", { extra: { "x-ms-client-principal-id": "voice-owner-a" } })).status, 401);
  assert.equal((await f.request("node-a", f.cookieB)).status, 404);
  assert.equal((await f.request("node-b", f.cookieA)).status, 404);
  assert.equal(f.seen.length, 0);
  for (const [node, cookie] of [["node-a", f.cookieA], ["node-b", f.cookieB]]) {
    const config = await f.request(node, cookie, { method: "GET", path: "config" });
    assert.equal(config.status, 200);
    const text = await config.text();
    for (const secret of [azureKey, maiKey, "cognitiveservices"]) assert.ok(!text.includes(secret));
    const response = await f.request(node, cookie);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(response.headers.get("set-cookie"), null);
    assert.equal((await response.json()).text, "Hello from voice");
  }
  assert.equal(f.vmRequests(), 0);
  assert.equal(f.gateway.active, 0);
});

test("voice HTTP rejects cross-origin, malformed audio, excessive uploads, endpoint overrides and wrong methods", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request("node-a", f.cookieA, { extra: { Origin: "https://evil.example" } })).status, 403);
  assert.equal((await f.request("node-a", f.cookieA, { path: "transcribe?provider=azure-speech&url=https://evil.example" })).status, 400);
  assert.equal((await f.request("node-a", f.cookieA, { path: "transcribe?provider=azure-speech&provider=mai-transcribe" })).status, 400);
  assert.equal((await f.request("node-a", f.cookieA, { path: "transcribe?provider=unknown" })).status, 400);
  assert.equal((await f.request("node-a", f.cookieA, { method: "GET" })).status, 405);
  assert.equal((await f.request("node-a", f.cookieA, { path: "unknown" })).status, 404);
  assert.equal((await f.request("node-a", f.cookieA, { extra: { "Content-Type": "application/json" }, body: "{}" })).status, 415);
  assert.equal((await f.request("node-a", f.cookieA, { body: Buffer.from("not audio") })).status, 400);
  assert.equal((await f.request("node-a", f.cookieA, { body: Buffer.alloc(MAX_VOICE_BYTES + 1) })).status, 413);
  assert.equal(f.seen.length, 0);
  assert.equal(f.vmRequests(), 0);
  assert.equal(f.gateway.active, 0);
});

test("voice quotas are per authenticated account and release slots on errors", async (t) => {
  const f = await fixture(t);
  for (let count = 0; count < 8; count++) assert.equal((await f.request("node-a", f.cookieA)).status, 200);
  assert.equal((await f.request("node-a", f.cookieA)).status, 429);
  assert.equal((await f.request("node-b", f.cookieB)).status, 200);
  f.nextMinute();
  f.behavior.fetch = async () => json({ error: maiKey }, 401);
  assert.equal((await f.request("node-a", f.cookieA)).status, 502);
  assert.equal(f.gateway.active, 0);
});

test("logout aborts pending transcription and cannot disclose a late result", async (t) => {
  const f = await fixture(t);
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  let aborted = false;
  f.behavior.fetch = (_url, { signal }) => new Promise((_resolve, reject) => {
    started();
    signal.addEventListener("abort", () => { aborted = true; reject(signal.reason); }, { once: true });
  });
  const pending = f.request("node-a", f.cookieA);
  await ready;
  await f.auth.revoke({ headers: { cookie: f.cookieA } });
  const response = await pending;
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("x-auth-error"), "session-expired");
  assert.equal(aborted, true);
  assert.equal(f.gateway.active, 0);
  assert.ok(!(await response.text()).includes("Hello from voice"));
});

test("revoking a node's ownership cancels an in-flight voice request", async (t) => {
  const f = await fixture(t);
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  f.behavior.fetch = (_url, { signal }) => new Promise((_resolve, reject) => {
    started();
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  const pending = f.request("node-a", f.cookieA);
  await ready;
  f.owned.set("voice-owner-a", []);
  const response = await pending;
  assert.equal(response.status, 403);
  assert.equal(f.gateway.active, 0);
});

test("only one transcription can run per account and a competing account remains independent", async (t) => {
  const f = await fixture(t);
  let started;
  let finish;
  const ready = new Promise((resolve) => { started = resolve; });
  f.behavior.fetch = () => new Promise((resolve) => { finish = resolve; started(); });
  const pending = f.request("node-a", f.cookieA);
  await ready;
  assert.equal((await f.request("node-a", f.cookieA)).status, 429);
  f.behavior.fetch = async () => json({ combinedPhrases: [{ text: "Bob's transcript" }] });
  assert.equal((await f.request("node-b", f.cookieB)).status, 200);
  finish(json({ combinedPhrases: [{ text: "Alice's transcript" }] }));
  assert.equal((await pending).status, 200);
  assert.equal(f.gateway.active, 0);
});

test("disconnecting mid-upload frees its slot and never calls a provider", async (t) => {
  const f = await fixture(t);
  const target = `${f.base}/cloudcli/node-a/api/voice/codey/transcribe?provider=azure-speech`;
  const request = http.request(target, {
    method: "POST", headers: {
      Cookie: f.cookieA, Origin: "https://codey.example.test",
      "Content-Type": "audio/wav", "Content-Length": wave().length,
    },
  });
  request.on("error", () => {});
  t.after(() => request.destroy());
  request.write(wave().subarray(0, 44));
  for (let count = 0; f.gateway.active === 0 && count < 100; count++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(f.gateway.active, 1);
  request.destroy();
  for (let count = 0; f.gateway.active !== 0 && count < 100; count++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(f.gateway.active, 0);
  assert.equal(f.seen.length, 0);
});
