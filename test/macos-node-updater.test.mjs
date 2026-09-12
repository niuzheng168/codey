import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Agent, Runtime, validateConfig } from "../node-updater/macos/agent.mjs";
import { checkedReceipt, exists } from "../node-updater/windows/runtime.mjs";
import { readJson, save, sha, UpdateError, validateConfig as windowsConfig } from "../node-updater/windows/client.mjs";

const keys = generateKeyPairSync("ed25519", {
  publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
function configuration(platform = "macos-arm64") {
  return { schema: 1, protocol: 1, platform, nodeId: "n-" + "a".repeat(24), ownerId: "owner-a", username: "alice",
    credential: "A".repeat(43), portalOrigin: "https://portal.example.test", releasePublicKey: keys.publicKey, minimumSequence: 0 };
}
function signedRelease(platform, patch = {}) {
  const now = Date.now();
  const release = {
    schema: 1, kind: "codey-node-release", id: "codey-" + platform + "-fixture", sequence: 9,
    createdAt: now - 1000, expiresAt: now + 86400000, platform, protocol: 1, configSchema: 1,
    rollback: "code-only", notes: "Synthetic test; never a published release", migrations: ["gateway-api-key-v1"],
    components: { codey: { file: "codey-0.1.5.tgz", version: "0.1.5", commit: "b".repeat(40),
      sha256: "d".repeat(64), size: 100, entrySha256: "b".repeat(64), lockSha256: "c".repeat(64), nodeMajors: [24] } },
    ...patch,
  };
  const payload = Buffer.from(JSON.stringify(release));
  return { release, digest: sha(payload), envelope: {
    payload: payload.toString("base64"), signature: sign(null, payload, keys.privateKey).toString("base64url"),
  } };
}
async function fixture(t, options = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), "codey-mac-agent-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const config = configuration(options.platform);
  const signed = signedRelease(config.platform, options.releasePatch);
  const counts = { download: 0, stage: 0, apply: 0, verify: 0, recover: 0, commit: 0 }, events = [];
  const runtime = new Runtime(config, { home });
  const before = {
    root: path.join(home, "old-codey"), node: process.execPath, nodeId: config.nodeId, pid: 201,
    kind: "macos-managed", configHash: "a".repeat(64), otherTasks: {}, protected: {},
    jobsRoot: path.join(home, ".local/share/codey-machine-macos/local-updates"),
    installed: { sequence: options.sequence || 0, digest: options.installedDigest || null },
    components: { codey: { version: "0.1.2", commit: "a".repeat(40), entrySha256: "a".repeat(64), nodeMajor: 24 } },
  };
  if (options.unchanged) before.components.codey = { ...signed.release.components.codey, nodeMajor: 24 };
  for (const directory of [runtime.private, runtime.root, before.jobsRoot, before.root]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }
  runtime.snapshot = async () => before;
  runtime.report = async () => ({ platform: config.platform, layout: "npm", highestSequence: before.installed.sequence,
    components: before.components, readyMigrations: ["gateway-api-key-v1"], busy: options.busy || false });
  runtime.assertUnchanged = async () => { if (options.drift) throw new UpdateError("configuration_changed"); };
  runtime.stage = async (_file, _release, _plan, job) => {
    counts.stage++; const candidate = path.join(job, "app/node_modules/codey");
    await mkdir(candidate, { recursive: true }); return candidate;
  };
  runtime.commit = async () => { counts.commit++; };
  runtime.native = async (action, file) => {
    events.push(action);
    if (action === "idle") return { ok: true, idle: !options.busy };
    counts[action]++;
    if (action === "recover") {
      if (options.recoveryFailure) throw new UpdateError("rollback_failed");
      return { ok: true, state: options.recoveryState || "rolled_back" };
    }
    const request = await readJson(file);
    assert.equal(checkedReceipt(request, config.releasePublicKey, { platform: config.platform }).digest, signed.digest);
    const state = options.rollback ? "rolled_back" : "complete";
    await save(path.join(request.job, "local-update.json"), { state, request, kind: "macos-managed" });
    return { ok: true, state };
  };
  const assigned = { id: "d".repeat(32), state: "claimed", leaseToken: "L".repeat(43), releaseId: signed.release.id,
    digest: signed.digest, envelope: options.badSignature ? { ...signed.envelope, signature: "A".repeat(86) } : signed.envelope };
  let sent = false, failedAck = false, clock = Date.now();
  const reports = [];
  const client = {
    async json(route, value) {
      if (route.endsWith("/poll")) {
        events.push("poll");
        if (value.report.blockedReason) return { protocol: 1, job: null };
        const job = sent ? null : assigned; sent = true; return { protocol: 1, job };
      }
      reports.push(value);
      if (value.state === "succeeded" && options.ackFailure && !failedAck) {
        failedAck = true; throw new UpdateError("download_failed");
      }
      return { state: value.state };
    },
    async download() { counts.download++; },
  };
  const agent = new Agent(config, { runtime, client, clock: () => clock, wait: async ms => { clock += ms; } });
  return { home, config, signed, runtime, before, assigned, reports, counts, events, agent };
}

test("Mac enrollment config validates both native architectures but cannot weaken the Windows entrypoint", () => {
  for (const platform of ["macos-arm64", "macos-x64"]) {
    const cfg = configuration(platform);
    assert.deepEqual(validateConfig(cfg), cfg);
    assert.throws(() => windowsConfig(cfg));
  }
  for (const patch of [{ platform: "linux-x64" }, { platform: "macos-universal" }, { minimumSequence: -1 },
    { minimumSequence: Number.MAX_SAFE_INTEGER + 1 }, { portalOrigin: "https://portal.example.test/path" },
    { ownerId: "wrong/owner" }]) assert.throws(() => validateConfig({ ...configuration(), ...patch }));
});

test("Mac state machine persists its real platform and waits for native verification before recording a release", async t => {
  for (const platform of ["macos-arm64", "macos-x64"]) {
    const f = await fixture(t, { platform });
    const result = await f.agent.once();
    assert.equal(result.state, "succeeded");
    assert.deepEqual(f.counts, { download: 1, stage: 1, apply: 1, verify: 0, recover: 0, commit: 1 });
    assert.equal((await readJson(path.join(f.runtime.private, "heartbeat.json"))).platform, platform);
    assert.equal((await readJson(path.join(f.runtime.private, "heartbeat.json"))).version, "0.1.2");
    assert.equal(await exists(path.join(f.runtime.private, "pending.json")), false);
    assert.equal(await exists(path.join(f.runtime.localState, "active.json")), false);
  }
});

test("wrong-architecture signatures, invalid signatures and replayed release sequences never stage or stop a Mac", async t => {
  for (const options of [{ releasePatch: { platform: "macos-x64" } }, { releasePatch: { platform: "windows-x64" } },
    { badSignature: true }, { sequence: 10 }, { sequence: 9, installedDigest: "a".repeat(64) }]) {
    const f = await fixture(t, options);
    assert.equal((await f.agent.once()).code, "signature_invalid");
    assert.equal(f.counts.apply, 0);
    assert.equal(f.counts.download, 0);
  }
});

test("busy or changed Mac stops before activation, while health/model failure cannot record installation", async t => {
  for (const options of [{ busy: true }, { drift: true }, { rollback: true }]) {
    const f = await fixture(t, options);
    const result = await f.agent.once();
    assert.equal(result.state, options.rollback ? "rolled_back" : "needs_action");
    assert.equal(f.counts.commit, 0);
    if (!options.rollback) assert.equal(f.counts.apply, 0);
  }
});

test("Mac completion with a lost acknowledgement only repeats the acknowledgement", async t => {
  const f = await fixture(t, { ackFailure: true });
  await assert.rejects(f.agent.once(), { code: "download_failed" });
  const counts = { ...f.counts };
  assert.equal((await f.agent.once()).state, "succeeded");
  assert.deepEqual(f.counts, counts);
});

test("Mac crash recovery precedes polling and failed recovery blocks repeated app restarts", async t => {
  for (const recoveryFailure of [false, true]) {
    const f = await fixture(t, { recoveryFailure });
    const directory = path.join(f.before.jobsRoot, f.assigned.id);
    await mkdir(directory, { mode: 0o700 });
    await f.runtime.acquireLocal(directory);
    await save(path.join(directory, "local-update.json"), { state: "starting" });
    await save(path.join(f.runtime.private, "pending.json"), { ...f.assigned, directory });
    assert.equal((await f.agent.once()).state, recoveryFailure ? "needs_action" : "rolled_back");
    assert.equal(f.events[0], "recover");
    assert.equal(f.counts.apply, 0);
    assert.equal(f.counts.stage, 0);
    if (recoveryFailure) {
      assert.equal((await f.agent.once()).state, "polling");
      assert.equal(f.counts.recover, 1);
      assert.equal(await exists(path.join(f.runtime.private, "blocked.json")), true);
    }
  }
});

test("Mac signed receipts bind the entire object and retain the same architecture when used for recovery", async t => {
  const f = await fixture(t);
  const job = path.join(f.before.jobsRoot, f.assigned.id);
  const request = { job, jobId: f.assigned.id, release: f.signed.release, envelope: f.signed.envelope, digest: f.signed.digest };
  assert.equal(checkedReceipt(request, keys.publicKey, { platform: f.config.platform }).digest, f.signed.digest);
  assert.throws(() => checkedReceipt(request, keys.publicKey)); // Windows default remains Windows-only.
  assert.throws(() => checkedReceipt({ ...request, release: { ...request.release, sequence: 30 } },
    keys.publicKey, { platform: f.config.platform }));
  const later = f.signed.release.expiresAt + 1;
  assert.throws(() => checkedReceipt(request, keys.publicKey, { platform: f.config.platform, now: later }));
  assert.equal(checkedReceipt(request, keys.publicKey,
    { platform: f.config.platform, now: later, allowExpired: true }).digest, f.signed.digest);
});

test("Mac installed sequence is pinned to this owner/node/architecture and never resets when re-paired", async t => {
  const f = await fixture(t);
  const runtime = new Runtime({ ...f.config, minimumSequence: 29 }, { home: f.home });
  assert.equal((await runtime.installed()).sequence, 29);
  const installed = { nodeId: f.config.nodeId, ownerId: f.config.ownerId, platform: f.config.platform, sequence: 31 };
  await save(path.join(runtime.private, "installed.json"), installed);
  assert.equal((await runtime.installed()).sequence, 31);
  for (const patch of [{ platform: "macos-x64" }, { ownerId: "another-owner" }, { sequence: 2 }]) {
    await save(path.join(runtime.private, "installed.json"), { ...installed, ...patch });
    await assert.rejects(runtime.installed());
  }
});

test("Mac native adapter cannot execute from Linux even if a config claims Darwin", { skip: process.platform === "darwin" }, async () => {
  let calls = 0;
  const runtime = new Runtime(configuration(), { command: async () => { calls++; } });
  await assert.rejects(runtime.native("apply", "/arbitrary/request.json"), { code: "unsupported_platform" });
  assert.equal(calls, 0);
});

test("Mac launchd, transaction, collision and recovery fixtures use the production Python implementation", {
  skip: process.platform === "win32", timeout: 90000,
}, async () => {
  const file = fileURLToPath(new URL("./test_macos_node_updater.py", import.meta.url));
  const result = await promisify(execFile)(process.env.CODEY_TEST_PYTHON || "python3", ["-I", "-B", file], {
    timeout: 85000, maxBuffer: 4 * 1024 * 1024,
  });
  assert.match(result.stderr, /Ran \d+ tests/);
  assert.match(result.stderr, /\bOK\b/);
});

test("Mac host has no arbitrary command/force surface and uses only private owner launchd jobs", async () => {
  const native = await readFile(new URL("../node-updater/macos/native.py", import.meta.url), "utf8");
  const host = await readFile(new URL("../node-updater/macos/host.py", import.meta.url), "utf8");
  assert.doesNotMatch(native, /\b(?:killall|pkill|systemctl|taskkill|Remove-Item)\b/);
  assert.match(native, /lock_file\(checked_path\(self\.config_root \/ "install\.lock"/);
  assert.match(native, /request\["candidate"\] == str\(job \/ "app\/node_modules\/codey"\)/);
  assert.match(host, /os\.getppid\(\) == 1 and os\.getpgrp\(\) == os\.getpid\(\)/);
});
