import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Agent } from "../node-updater/windows/agent.mjs";
import { Client, UpdateError, readJson, requireValue, save, sha, validateConfig } from "../node-updater/windows/client.mjs";
import { Runtime, normalizedGateway, normalizedCodex, checkedReceipt, checkedAcceptanceProof,
  readAcceptanceProof, objectHash, exists } from "../node-updater/windows/runtime.mjs";
import { verifyRequest } from "../node-updater/windows/verify.mjs";
import { verifyNodeRelease } from "../src/node-update-manifest.mjs";

const keys = generateKeyPairSync("ed25519", {
  publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const now = Date.now();
function configuration() {
  return { schema: 1, protocol: 1, platform: "windows-x64", nodeId: "n-" + "a".repeat(24),
    ownerId: "owner-a", username: "alice", credential: "A".repeat(43), minimumSequence: 0,
    portalOrigin: "https://portal.example.test", releasePublicKey: keys.publicKey };
}
function signedRelease(patch = {}) {
  const bytes = Buffer.from("synthetic-application");
  const release = {
    schema: 1, kind: "codey-node-release", id: "codey-windows-fixture", sequence: 9, createdAt: now - 1000,
    expiresAt: now + 86400000, platform: "windows-x64", protocol: 1, configSchema: 1, rollback: "code-only",
    notes: "Fixture, never a production release.", migrations: ["gateway-api-key-v1"],
    components: { codey: { file: "codey-0.1.5.tgz", version: "0.1.5", commit: "b".repeat(40),
      sha256: sha(bytes), size: bytes.length, entrySha256: "b".repeat(64), lockSha256: "c".repeat(64), nodeMajors: [24] } },
    ...patch,
  };
  const payload = Buffer.from(JSON.stringify(release));
  return { release, digest: sha(payload), bytes,
    envelope: { payload: payload.toString("base64"), signature: sign(null, payload, keys.privateKey).toString("base64url") } };
}
async function fixture(t, options = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), "codey-windows-agent-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const config = configuration(), signed = signedRelease(options.releasePatch);
  let clock = now;
  const events = [];
  const counters = { stage: 0, download: 0, apply: 0, verify: 0, recover: 0, commit: 0 };
  const before = {
    kind: "windows-managed", pid: 100, jobsRoot: path.join(home, "runtime/local-updates"),
    root: path.join(home, "runtime/old"), node: process.execPath, nodeId: config.nodeId,
    configHash: "a".repeat(64), protected: {}, otherTasks: {},
    components: { codey: { version: "0.1.4", commit: "a".repeat(40), entrySha256: "a".repeat(64), nodeMajor: 24 } },
    installed: { sequence: options.sequence || 0, digest: options.installedDigest || null, releaseId: null },
  };
  if (options.unchanged) before.components.codey = { ...signed.release.components.codey, nodeMajor: 24 };
  const runtime = {
    home, private: path.join(home, ".config/codey-updater"), root: path.join(home, ".local/share/codey-updater"),
    localState: path.join(home, ".local/share/codey-local-update"),
    async snapshot() { if (options.snapshotFailure) throw new UpdateError("configuration_changed"); return before; },
    async report() { return { platform: "windows-x64", layout: "npm", components: before.components,
      highestSequence: before.installed.sequence, currentRelease: null, readyMigrations: ["gateway-api-key-v1"], busy: options.busy || false }; },
    acquireLocal: Runtime.prototype.acquireLocal,
    releaseLocal: Runtime.prototype.releaseLocal,
    async assertUnchanged() { if (options.drift) throw new UpdateError("configuration_changed"); },
    async stage(file, release, plan, job) {
      events.push("stage"); counters.stage++;
      const candidate = path.join(job, "candidate");
      await mkdir(candidate);
      return candidate;
    },
    async commit() { events.push("commit"); counters.commit++; },
    async native(action, file) {
      if (action === "idle") return { ok: true, idle: !options.busy };
      if (action === "recover") {
        events.push("recover"); counters.recover++;
        if (options.recoveryFailure) throw new UpdateError("rollback_failed");
        return { ok: true, state: options.recoveredState || "rolled_back" };
      }
      assert.ok(["apply", "verify"].includes(action));
      counters[action]++; events.push(action);
      const request = await readJson(file);
      assert.equal(request.acceptance, "authenticated-health-v1");
      assert.equal(verifyNodeRelease(request.envelope, keys.publicKey).digest, signed.digest);
      await client.json("/api/node-updater/report", {
        jobId: request.jobId, leaseToken: request.leaseToken, state: "verifying", code: "ok",
      });
      const state = options.rollback ? "rolled_back" : "complete";
      await save(path.join(request.job, "local-update.json"), { state, request, changed: request.changed, kind: "windows-managed" });
      return { ok: true, state };
    },
  };
  for (const file of [runtime.private, runtime.root, before.jobsRoot, before.root]) await mkdir(file, { recursive: true, mode: 0o700 });
  const job = { id: "d".repeat(32), leaseToken: "L".repeat(43), state: "claimed", releaseId: signed.release.id,
    digest: signed.digest, envelope: options.badSignature ? { ...signed.envelope, signature: "A".repeat(86) } : signed.envelope };
  let sent = false, failedAck = false;
  const reports = [];
  const client = {
    async json(route, value) {
      if (route.endsWith("/poll")) {
        events.push("poll");
        if (value.report.blockedReason) return { protocol: 1, job: null };
        const result = { protocol: 1, job: sent ? null : job }; sent = true; return result;
      }
      assert.ok(route.endsWith("/report"));
      events.push("report:" + value.state); reports.push(value);
      if (value.state === "succeeded" && options.ackFailure && !failedAck) {
        failedAck = true; throw new UpdateError(options.ackFailure);
      }
      return { id: value.jobId, state: value.state };
    },
    async download() { events.push("download"); counters.download++; },
  };
  const agent = new Agent(config, { runtime, client, clock: () => clock,
    wait: async milliseconds => { clock += milliseconds; } });
  return { home, config, signed, agent, runtime, before, events, counters, reports, job };
}

test("Windows config requires native platform, a stable HTTPS origin, Ed25519 and a preserved sequence floor", () => {
  const cfg = configuration();
  assert.deepEqual(validateConfig(cfg), cfg);
  for (const patch of [{ platform: "linux-x64" }, { nodeId: "local" }, { minimumSequence: -1 },
    { minimumSequence: 1.5 }, { portalOrigin: "http://portal.example.test" },
    { portalOrigin: "https://user:secret@portal.example.test" }, { portalOrigin: "https://portal.example.test/command" }]) {
    assert.throws(() => validateConfig({ ...cfg, ...patch }));
  }
});

test("client never follows redirects, sends cookies, or accepts arbitrary URLs", async () => {
  const cfg = configuration(), calls = [];
  const client = new Client(cfg, { fetchImpl: async (url, options) => {
    calls.push({ url, options }); return new Response('{"protocol":1}', { status: 200 });
  } });
  await client.json("/api/node-updater/poll", { protocol: 1 });
  assert.equal(calls[0].options.redirect, "error");
  assert.equal(calls[0].options.headers.Authorization, "Bearer " + cfg.credential);
  assert.equal(calls[0].options.headers.Cookie, undefined);
  await assert.rejects(client.request("//foreign.invalid/path"));
  await assert.rejects(client.request("/api/settings/updates"));
  await assert.rejects(client.request("/api/node-updater/releases/../secret/codey-1.0.0.tgz"));
  const revoked = new Client(cfg, { fetchImpl: async () => new Response("", { status: 403 }) });
  await assert.rejects(revoked.json("/api/node-updater/poll", {}), { code: "lease_lost" });
});

test("client rejects oversized metadata and corrupt or unassigned package contents", async t => {
  const f = await fixture(t);
  const huge = new Client(f.config, { fetchImpl: async () => new Response(Buffer.alloc(1024 * 1024 + 1)) });
  await assert.rejects(huge.json("/api/node-updater/poll", {}), { code: "download_failed" });
  const broken = new Client(f.config, { fetchImpl: async () => new Response("wrong") });
  await assert.rejects(broken.download(f.signed.release.id, f.signed.release.components.codey,
    path.join(f.home, "bad.tgz")), { code: "signature_invalid" });
  assert.equal(await exists(path.join(f.home, "bad.tgz")), false);
});

test("signed Windows update requires all phases and explicit health-only acceptance before success", async t => {
  const f = await fixture(t);
  const result = await f.agent.once();
  assert.equal(result.state, "succeeded");
  assert.deepEqual(f.reports.map(value => value.state), ["downloading", "staging", "waiting_idle", "applying", "verifying", "succeeded"]);
  assert.deepEqual(f.counters, { stage: 1, download: 1, apply: 1, verify: 0, recover: 0, commit: 1 });
  assert.equal(await exists(path.join(f.runtime.private, "pending.json")), false);
  assert.equal(await exists(path.join(f.runtime.localState, "active.json")), false);
});

test("invalid signatures, wrong platform and downgrade never download or stop applications", async t => {
  for (const options of [{ badSignature: true }, { releasePatch: { platform: "linux-x64" } }, { sequence: 10 },
    { sequence: 9, installedDigest: "e".repeat(64) }]) {
    const f = await fixture(t, options);
    const result = await f.agent.once();
    assert.equal(result.state, "failed");
    assert.equal(result.code, "signature_invalid");
    assert.equal(f.counters.apply, 0); assert.equal(f.counters.download, 0);
  }
});

test("busy or concurrently changed nodes never activate their staged candidate", async t => {
  for (const options of [{ busy: true }, { drift: true }]) {
    const f = await fixture(t, options);
    const result = await f.agent.once();
    assert.equal(result.state, "needs_action");
    assert.equal(f.counters.apply, 0);
    assert.equal(await exists(path.join(f.runtime.localState, "lock")), false);
  }
});

test("an unchanged Codey release verifies without download/restart, even while other user work is busy", async t => {
  const f = await fixture(t, { unchanged: true, busy: true });
  const result = await f.agent.once();
  assert.equal(result.state, "succeeded");
  assert.equal(result.code, "up_to_date");
  assert.equal(f.counters.apply, 0); assert.equal(f.counters.download, 0); assert.equal(f.counters.verify, 1);
});

test("health failure reports rollback and never records the desired version installed", async t => {
  const f = await fixture(t, { rollback: true });
  assert.equal((await f.agent.once()).state, "rolled_back");
  assert.equal(f.counters.commit, 0);
  assert.equal(await exists(path.join(f.runtime.localState, "active.json")), false);
});

test("a lost final acknowledgement is reconciled without another stage, restart or model call", async t => {
  const f = await fixture(t, { ackFailure: "download_failed" });
  await assert.rejects(f.agent.once(), { code: "download_failed" });
  const counters = { ...f.counters };
  assert.equal((await f.agent.once()).state, "succeeded");
  assert.deepEqual(f.counters, counters);
});

test("revoked terminal acknowledgement does not leave an unre-pairable pending credential forever", async t => {
  const f = await fixture(t, { ackFailure: "lease_lost" });
  const result = await f.agent.once();
  assert.equal(result.state, "needs_action");
  assert.equal(result.code, "lease_lost");
  assert.equal(await exists(path.join(f.runtime.private, "pending.json")), false);
  assert.equal(f.counters.apply, 1);
});

test("crash recovery runs locally before contacting the Portal, and never repeats staging", async t => {
  const f = await fixture(t);
  const directory = path.join(f.before.jobsRoot, f.job.id);
  await mkdir(directory, { mode: 0o700 });
  await f.runtime.acquireLocal(directory);
  await save(path.join(directory, "local-update.json"), { state: "applying" });
  await save(path.join(f.runtime.private, "pending.json"), { ...f.job, directory });
  assert.equal((await f.agent.once()).state, "rolled_back");
  assert.equal(f.events[0], "recover");
  assert.equal(f.counters.stage, 0);
  assert.equal(f.counters.apply, 0);
});

test("failed recovery is blocked for manual inspection instead of repeatedly stopping applications", async t => {
  const f = await fixture(t, { recoveryFailure: true });
  const directory = path.join(f.before.jobsRoot, f.job.id);
  await mkdir(directory, { mode: 0o700 });
  await f.runtime.acquireLocal(directory);
  await save(path.join(directory, "local-update.json"), { state: "applying" });
  await save(path.join(f.runtime.private, "pending.json"), { ...f.job, directory });
  assert.equal((await f.agent.once()).code, "rollback_failed");
  assert.equal(await exists(path.join(f.runtime.private, "blocked.json")), true);
  assert.equal((await f.agent.once()).state, "polling");
  assert.equal(f.counters.recover, 1);
  assert.equal(await exists(path.join(f.runtime.localState, "active.json")), true);
});

test("snapshot failure after claiming ends the job explicitly, without waiting out its lease", async t => {
  const f = await fixture(t, { snapshotFailure: true });
  assert.equal((await f.agent.once()).state, "needs_action");
  assert.equal(f.reports.at(-1).state, "needs_action");
  assert.equal(f.counters.download, 0);
});

test("local CLI update lock excludes the Portal agent without deleting the other writer's state", async t => {
  const f = await fixture(t);
  const other = path.join(f.before.jobsRoot, "e".repeat(32));
  await mkdir(other);
  await f.runtime.acquireLocal(other);
  assert.equal((await f.agent.once()).code, "busy");
  assert.equal((await readJson(path.join(f.runtime.localState, "active.json"))).job, other);
});

test("configuration hashing allows only equal-valued aliases and the exact synthetic trust record", () => {
  const before = { auth: { apiKeys: ["keep-this-value"] }, responsesTransport: { headersTimeoutMsV2: 123 } };
  const after = { auth: { apiKeys: ["keep-this-value"] }, upstreamTransport: { headersTimeoutMs: 123 } };
  assert.equal(objectHash(normalizedGateway(before)), objectHash(normalizedGateway(after)));
  assert.notEqual(objectHash(normalizedGateway(before)), objectHash(normalizedGateway({ ...after, auth: { apiKeys: ["changed"] } })));
  assert.throws(() => normalizedGateway({ responsesTransport: { headersTimeoutMs: 123 }, upstreamTransport: { headersTimeoutMs: 321 } }));
  const probe = "C:\\Users\\alice\\probe";
  const config = { model: "fixture", projects: { [probe]: { trust_level: "trusted" } }, last_updated: "2026-09-12T00:00:00Z" };
  assert.deepEqual(normalizedCodex(config, probe), { model: "fixture" });
  assert.ok(normalizedCodex(config, "other").projects);
  assert.equal(normalizedCodex({ last_updated: "non-timestamp" }, probe).last_updated, "non-timestamp");
});

test("recovery receipts retain the original signature, platform and immutable sequence", () => {
  const signed = signedRelease();
  const id = "d".repeat(32);
  const request = { release: signed.release, envelope: signed.envelope, digest: signed.digest, jobId: id,
    job: path.join(os.tmpdir(), id) };
  assert.equal(checkedReceipt(request, keys.publicKey).digest, signed.digest);
  assert.throws(() => checkedReceipt({ ...request, release: { ...signed.release, sequence: 999 } }, keys.publicKey));
  assert.throws(() => checkedReceipt({ ...request, jobId: "e".repeat(32) }, keys.publicKey));
  assert.throws(() => checkedReceipt(request, keys.publicKey, { now: signed.release.expiresAt + 1 }));
  assert.equal(checkedReceipt(request, keys.publicKey, { now: signed.release.expiresAt + 1, allowExpired: true }).digest, signed.digest);
});

function healthReceipt(signed, job) {
  const component = signed.release.components.codey;
  const request = { ...signed, acceptance: "authenticated-health-v1", job, jobId: path.basename(job),
    version: component.version, entrySha256: component.entrySha256 };
  const proof = { schema: 1, acceptance: request.acceptance, passed: true, healthy: true, authenticated: true,
    modelRequests: false, version: component.version, entrySha256: component.entrySha256,
    jobId: request.jobId, digest: signed.digest, checkedAt: now };
  return { request, proof };
}

test("health receipts bind signed version, entry, job and digest and never substitute historical model proofs", async t => {
  const f = await fixture(t);
  const { request, proof } = healthReceipt(f.signed, path.join(f.home, f.job.id));
  await mkdir(request.job);
  assert.deepEqual(checkedAcceptanceProof(request, proof), proof);
  for (const patch of [{ passed: false }, { healthy: false }, { authenticated: false }, { modelRequests: true },
    { modelRequests: undefined }, { checkedAt: 0 }, { version: "0.1.4" }, { entrySha256: "0".repeat(64) },
    { digest: "0".repeat(64) }, { jobId: "e".repeat(32) }]) {
    assert.throws(() => checkedAcceptanceProof(request, { ...proof, ...patch }), { code: "health_failed" });
  }
  assert.throws(() => checkedAcceptanceProof({ ...request, version: "0.1.4" }, proof), { code: "signature_invalid" });
  assert.throws(() => checkedAcceptanceProof({ ...request, acceptance: "unknown" }, proof), { code: "configuration_changed" });
  const legacy = { ...request }; delete legacy.acceptance;
  const oldProof = { passed: true, codeyModel: true, codexModel: true, syntheticSessionArchived: true,
    digest: legacy.digest, jobId: legacy.jobId };
  assert.deepEqual(checkedAcceptanceProof(legacy, oldProof), oldProof);
  assert.throws(() => checkedAcceptanceProof(legacy, proof), { code: "model_failed" });
  assert.throws(() => checkedAcceptanceProof(request, oldProof), { code: "health_failed" });
  await save(path.join(request.job, "model-proof.json"), oldProof);
  await assert.rejects(readAcceptanceProof(request), { code: "health_failed" });
  assert.deepEqual(await readAcceptanceProof(legacy), oldProof);
});

test("commit requires a real bound health receipt and matching running version before persisting installation", async t => {
  const f = await fixture(t);
  const { request, proof } = healthReceipt(f.signed, path.join(f.home, f.job.id));
  await mkdir(request.job);
  await save(path.join(request.job, "request.json"), request);
  const runtime = {
    config: f.config, platform: f.config.platform, private: f.runtime.private,
    installed: async () => ({ sequence: 0 }),
    snapshot: async () => ({ components: { codey: { ...f.signed.release.components.codey } } }),
  };
  const commit = () => Runtime.prototype.commit.call(runtime, f.signed.release, f.signed.digest, request.job);
  await assert.rejects(commit(), { code: "health_failed" });
  await save(path.join(request.job, "health-proof.json"), { ...proof, authenticated: false });
  await assert.rejects(commit(), { code: "health_failed" });
  await save(path.join(request.job, "health-proof.json"), proof);
  const snapshot = runtime.snapshot;
  runtime.snapshot = async () => ({ components: { codey: { ...f.signed.release.components.codey, version: "0.1.4" } } });
  await assert.rejects(commit(), { code: "health_failed" });
  assert.equal(await exists(path.join(runtime.private, "installed.json")), false);
  runtime.snapshot = snapshot;
  await commit();
  assert.equal((await readJson(path.join(runtime.private, "installed.json"))).digest, f.signed.digest);
});

test("Windows acceptance runs only version/native/authenticated health checks; failures cannot mint a proof", {
  skip: process.platform !== "win32",
}, async t => {
  const f = await fixture(t);
  const root = path.join(f.home, "package");
  await mkdir(root);
  const build = { name: "codey", version: "0.1.5" };
  await save(path.join(root, "codey-build.json"), build);
  const entrySha256 = sha(await readFile(path.join(root, "codey-build.json")));
  const signed = signedRelease({ components: {
    codey: { ...f.signed.release.components.codey, entrySha256 },
  } });
  const { request } = healthReceipt(signed, path.join(f.home, f.job.id));
  await mkdir(request.job);
  request.candidate = root; request.plan = { protected: {} };
  await save(path.join(root, "package.json"), build);
  const runtimeConfig = { nodeId: f.config.nodeId, portalOrigin: f.config.portalOrigin,
    codeyDirectory: root, nodeExe: process.execPath,
    services: { codey: { environment: { CODEY_PORTAL_PRINCIPAL_ID: f.config.ownerId, CODEY_PORTAL_USERNAME: f.config.username } } } };
  const calls = [], reports = [];
  const options = { config: f.config, runtimeConfig,
    client: { json: async (_route, value) => reports.push(value) },
    command: async (node, args) => {
      assert.equal(node, process.execPath);
      assert.equal(args[0], path.join(root, "bin/codey.mjs"));
      if (args[1] === "--version") {
        assert.equal(args.length, 2);
        calls.push("version"); return "0.1.5";
      }
      assert.deepEqual(args.slice(1), ["doctor", "--json"]);
      calls.push("native");
      return JSON.stringify({ ok: true, name: "codey", platform: "windows-x64", modelRequests: false,
        serviceChanges: false, version: "0.1.5", entrySha256, lockSha256: signed.release.components.codey.lockSha256,
        sourceCommit: signed.release.components.codey.commit, nodeMajor: Number(process.versions.node.split(".")[0]),
        native: { sqlite: true, bcrypt: true, ripgrep: true, pty: true, codexSdk: true } });
    },
    probe: async (_config, value) => {
      assert.deepEqual(value, { version: "0.1.5" });
      calls.push("authenticated-health"); return { healthy: true, modelRequests: false };
    }, hashes: async () => ({}),
  };
  for (const patch of [
    { probe: async () => { throw new Error("fixture TLS/auth failure"); } },
    { command: async () => "wrong-version" },
    { hashes: async () => ({ config: "changed" }) },
    { command: async (_node, args) => args[1] === "--version" ? "0.1.5" : '{"ok":true,"native":null}' },
    { client: { json: async () => { throw new UpdateError("lease_lost"); } } },
  ]) {
    await assert.rejects(verifyRequest(request, { ...options, ...patch }));
    assert.equal(await exists(path.join(request.job, "health-proof.json")), false);
  }
  calls.length = 0;
  const proof = await verifyRequest(request, options);
  assert.deepEqual(calls, ["version", "native", "authenticated-health"]);
  assert.equal(proof.modelRequests, false);
  assert.equal(proof.authenticated, true);
  assert.equal(await exists(path.join(request.job, "model-proof.json")), false);
  assert.ok(reports.every(value => value.state === "verifying" && value.jobId === request.jobId));
});

test("the independent host uses the existing exact process-tree implementation and a kernel-owned lifetime lock", async () => {
  assert.deepEqual(await readFile("node-updater/windows/process-tree.cs"),
    await readFile("skills/config-new-codey-machine/scripts/windows-process.cs"));
  const host = await readFile("node-updater/windows/host.cs", "utf8");
  assert.match(host, /FileAccess.ReadWrite, FileShare.Read/);
  assert.match(host, /CodeyBackgroundProcess/);
  assert.match(host, /EnvironmentVariables.Clear/);
  assert.match(host, /"COMPUTERNAME"/);
  assert.match(host, /CreateStartInfo\(args\[0\], root, expected, home, nonce\)/);
  assert.match(host, /CODEY_UPDATER_HOST_TOKEN/);
});

test("agent installation is serialized and restores only its own stopped-task metadata on failure", async () => {
  const source = await readFile("node-updater/windows/install.ps1", "utf8");
  assert.match(source, /installer\.lock/);
  assert.match(source, /\[IO\.FileShare\]::None/);
  assert.match(source, /oldTaskXml/);
  assert.match(source, /Concurrent updater credential change/);
  assert.match(source, /current\[0\]\.State -ne 4/);
  assert.match(source, /\[IO\.File\]::Replace\(\$temporary, \$restore\.file/);
  assert.doesNotMatch(source, /Set-CodeyTaskState|Install-CodeyTasks|Stop-Process|taskkill|\.Stop\(0\)/);
  assert.ok(source.indexOf("Assert-UpdaterTask $current[0]") < source.indexOf("DeleteTask($taskName"));
});

const powershell = process.env.CODEY_TEST_POWERSHELL;
test("native agent transactions and installer Task Scheduler rules parse and run only isolated mocks", {
  skip: !powershell, timeout: 30000,
}, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "windows-agent-ps-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await promisify(execFile)(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-File",
    fileURLToPath(new URL("./windows-agent-fixture.ps1", import.meta.url)), "-Root", root,
    "-Source", path.resolve("node-updater/windows")], { timeout: 29000, maxBuffer: 1024 * 1024 });
  const proof = JSON.parse(result.stdout);
  assert.equal(proof.passed, true);
  assert.equal(proof.hostEnvironmentVerified, true);
  assert.equal(proof.nativeServices, false);
  assert.equal(proof.modelCalls, 0);
});
