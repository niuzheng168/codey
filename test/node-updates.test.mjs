import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { NodeUpdateCatalog, verifyNodeRelease } from "../src/node-update-release.mjs";
import { MachineUpdates } from "../src/machine-updates.mjs";
import { SettingsApi } from "../src/settings-api.mjs";
import { AccountStore } from "../src/account-store.mjs";
import { NodePolicy } from "../src/node-policy.mjs";
import { UserConfigStore } from "../src/user-config-store.mjs";
import { PasswordAuthenticator, hashPassword } from "../src/password-auth.mjs";
import { validateConfig } from "../src/config.mjs";
import { createMultiUserPortalServer } from "../src/server.mjs";

const sha = (body) => createHash("sha256").update(body).digest("hex");
const password = "Test-Node-Updater-Owner-Password-42!";
const credential = { username: "alice", principalId: "owner-a", passwordHash: await hashPassword(password) };
const origin = "https://codey.example.test";
const keys = generateKeyPairSync("ed25519", {
  publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

export function releaseFixture(now = Date.now(), id = "node-release-one", sequence = 1) {
  const archive = Buffer.from("synthetic-archive-" + id);
  const components = Object.fromEntries(["cloudcli", "copilotApi"].map((name) => [name, {
    version: name === "cloudcli" ? "1.37.2" : "2.5.1", commit: "b".repeat(40),
    file: name === "cloudcli" ? "cloudcli.tar.gz" : "gateway.tar.gz",
    sha256: sha(archive), size: archive.length, entrySha256: "b".repeat(64),
    ...(name === "cloudcli" ? { lockSha256: "c".repeat(64) } : {}), nodeMajors: [24],
  }]));
  const release = { schema: 1, kind: "codey-node-release", id, sequence, createdAt: now - 1000,
    expiresAt: now + 86400000, protocol: 1, platform: "linux-x64", configSchema: 1, rollback: "code-only",
    migrations: ["gateway-api-key-v1"], notes: "Reviewed fixture, not a real deployment.", components };
  const bytes = Buffer.from(JSON.stringify(release));
  return { archive, release, envelope: { payload: bytes.toString("base64"), signature: sign(null, bytes, keys.privateKey).toString("base64url") } };
}

function zipEntry(bytes, wanted) {
  let offset = 0;
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    const size = bytes.readUInt32LE(offset + 18);
    const length = bytes.readUInt16LE(offset + 26);
    const extra = bytes.readUInt16LE(offset + 28);
    const name = bytes.subarray(offset + 30, offset + 30 + length).toString();
    const start = offset + 30 + length + extra;
    if (name === wanted) return bytes.subarray(start, start + size);
    offset = start + size;
  }
  throw new Error("ZIP entry missing");
}

function report(overrides = {}) {
  return { platform: "linux-x64", layout: "legacy", highestSequence: 0, currentRelease: null,
    readyMigrations: ["gateway-api-key-v1"], components: Object.fromEntries(["cloudcli", "copilotApi"].map((name) => [
      name, { version: "1.0.0", commit: "a".repeat(40), entrySha256: "a".repeat(64), nodeMajor: 24 },
    ])), ...overrides };
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "codey-node-updates-"));
  t.after(async () => {
    assert.equal(path.dirname(root), os.tmpdir());
    assert.ok(path.basename(root).startsWith("codey-node-updates-"));
    await rm(root, { recursive: true, force: true });
  });
  const master = randomBytes(32).toString("base64url");
  const defaults = validateConfig({
    nodes: [],
    clientNodes: ["alpha", "beta", "local"].map((id) => ({ id, name: id, endpoint: `https://${id}.example.test:8443/usage` })),
  });
  const authRoot = path.join(root, "auth");
  const accounts = new AccountStore({ root: authRoot, master, credential });
  await accounts.initialize();
  const bob = await accounts.create({ username: "bob", password: password + "B" });
  const legacy = new UserConfigStore(path.join(root, "users"), { tenantId: "test", seedPrincipalId: credential.principalId, seedConfig: defaults });
  const policy = new NodePolicy({ root: authRoot, master, ticketMaster: randomBytes(48).toString("base64url"),
    seedPrincipalId: credential.principalId, legacyConfigStore: legacy, defaults });
  await policy.initialize();
  const bobNode = await policy.create(bob.id, { name: "Bob node", endpoint: "https://bob.example.test:8443/usage" });
  const authenticator = new PasswordAuthenticator({ credential, accountStore: accounts, root: authRoot, publicBaseUrl: origin });
  const cookieA = (await authenticator.login("alice", password)).cookie.split(";")[0];
  const cookieB = (await authenticator.login("bob", password + "B")).cookie.split(";")[0];
  const catalogRoot = path.join(root, "releases");
  const built = releaseFixture();
  await mkdir(path.join(catalogRoot, "releases", built.release.id), { recursive: true });
  await writeFile(path.join(catalogRoot, "catalog.json"), JSON.stringify({ schema: 1, releases: [built.envelope] }));
  for (const item of Object.values(built.release.components)) await writeFile(path.join(catalogRoot, "releases", built.release.id, item.file), built.archive);
  const clock = { now: Date.now() };
  const updates = new MachineUpdates({ root: authRoot, master, nodePolicy: policy, accounts, authenticator,
    catalogRoot, publicKey: keys.publicKey, sourceRoot: path.resolve("node-updater"), clock: () => clock.now });
  await updates.initialize();
  const settingsApi = new SettingsApi({ accounts, nodePolicy: policy, authenticator, machineUpdates: updates });
  const server = createMultiUserPortalServer({
    config: defaults, userConfigStore: policy, nodePolicy: policy, accountStore: accounts,
    passwordAuthenticator: authenticator, settingsApi, machineUpdates: updates,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const request = (pathname, { cookie = cookieA, method = "GET", body, headers = {} } = {}) => fetch(url + pathname, {
    method, redirect: "manual",
    headers: { ...(cookie ? { Cookie: cookie } : {}), Origin: origin, "Content-Type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  async function enroll(node = "alpha", cookie = cookieA) {
    const response = await request(`/api/settings/updates/bootstrap/${node}`, {
      cookie, method: "POST", body: { confirmation: "enable-node-updater" },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/zip");
    return JSON.parse(zipEntry(Buffer.from(await response.arrayBuffer()), "codey-updater/config.json"));
  }
  const agent = (config, pathname, body) => request(pathname, {
    cookie: null, method: body === undefined ? "GET" : "POST", body,
    headers: { Authorization: `Bearer ${config.credential}`, "x-codey-node-id": config.nodeId },
  });
  async function heartbeat(config, value = report(), leaseToken) {
    const response = await agent(config, "/api/node-updater/poll", { protocol: 1, report: value, ...(leaseToken ? { leaseToken } : {}) });
    assert.equal(response.status, 200);
    return response.json();
  }
  async function enqueue(nodeIds = ["alpha"]) {
    const preview = await request("/api/settings/updates/plans", { method: "POST", body: { nodeIds, releaseId: built.release.id } });
    assert.equal(preview.status, 200);
    const plan = await preview.json();
    const response = await request("/api/settings/updates/jobs", { method: "POST", body: {
      planId: plan.id, confirmation: "update-reviewed-machines",
    } });
    assert.equal(response.status, 202);
    return { plan, ...(await response.json()) };
  }
  async function advance(config, job, state, code = "ok", expect = 200) {
    const response = await agent(config, "/api/node-updater/report", {
      jobId: job.id, leaseToken: job.leaseToken, state, code,
    });
    assert.equal(response.status, expect);
    return response.json();
  }
  return { root, url, accounts, policy, updates, clock, built, catalogRoot, cookieA, cookieB, bob, bobNode,
    request, enroll, agent, heartbeat, enqueue, advance };
}

test("release signatures bind artifacts, expiration, paths, protocol and versions", () => {
  const built = releaseFixture();
  assert.equal(verifyNodeRelease(built.envelope, keys.publicKey).release.id, built.release.id);
  const tampered = { ...built.envelope, payload: Buffer.from(JSON.stringify({ ...built.release, sequence: 99 })).toString("base64") };
  assert.throws(() => verifyNodeRelease(tampered, keys.publicKey));
  const other = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" });
  assert.throws(() => verifyNodeRelease(built.envelope, other));
  assert.throws(() => verifyNodeRelease(built.envelope, keys.publicKey, built.release.expiresAt));
  for (const patch of [{ protocol: 2 }, { id: "../escape" }, { command: "arbitrary shell" }, { platform: "win32-x64" }]) {
    const bytes = Buffer.from(JSON.stringify({ ...built.release, ...patch }));
    assert.throws(() => verifyNodeRelease({ payload: bytes.toString("base64"), signature: sign(null, bytes, keys.privateKey).toString("base64url") }, keys.publicKey));
  }
});

test("update UI and static module stay authenticated; owner API rejects CSRF, forged identity and arbitrary commands", async (t) => {
  const f = await fixture(t);
  for (const pathname of ["/api/settings/updates", "/machine-updates.js"]) {
    assert.equal((await f.request(pathname, { cookie: null, headers: { "x-ms-client-principal-id": "owner-a" } })).status, 401);
    assert.equal((await f.request(pathname)).status, 200);
  }
  for (const Origin of ["https://evil.example", "null", ""]) {
    assert.equal((await f.request("/api/settings/updates/plans", {
      method: "POST", body: { nodeIds: ["alpha"], releaseId: f.built.release.id }, headers: { Origin },
    })).status, 403);
  }
  assert.equal((await f.request("/api/settings/updates/plans", { method: "POST", body: {
    nodeIds: ["alpha"], releaseId: f.built.release.id, command: "must-not-run",
  } })).status, 400);
  assert.equal((await f.request("/api/settings/updates/jobs", { method: "POST", body: { planId: "invented" } })).status, 400);
});

test("mixed-owner batches fail atomically, administrators cannot update another owner, local is protected", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request("/api/settings/updates/plans", { method: "POST", body: {
    nodeIds: ["alpha", f.bobNode.id], releaseId: f.built.release.id,
  } })).status, 404);
  assert.equal(Object.keys((await f.updates.store.read()).data.plans).length, 0);
  for (const nodeId of [f.bobNode.id, "local"]) {
    assert.equal((await f.request(`/api/settings/updates/bootstrap/${nodeId}`, {
      method: "POST", body: { confirmation: "enable-node-updater" },
    })).status, nodeId === "local" ? 403 : 404);
  }
  const own = await (await f.request("/api/settings/updates", { cookie: f.cookieB })).json();
  assert.deepEqual(own.nodes.map((node) => node.id), [f.bobNode.id]);
});

test("bootstrap credentials are updater-only, absent from status and cannot authorize another node or owner API", async (t) => {
  const f = await fixture(t);
  const config = await f.enroll();
  assert.equal(config.nodeId, "alpha");
  assert.equal(config.ownerId, "owner-a");
  assert.equal(config.releasePublicKey, keys.publicKey);
  const status = await (await f.request("/api/settings/updates")).text();
  assert.ok(!status.includes(config.credential));
  assert.ok(!(await f.updates.store.read()).data.devices.alpha.credential);
  await f.heartbeat(config);
  assert.equal((await f.agent({ ...config, nodeId: "beta" }, "/api/node-updater/poll", { protocol: 1, report: report() })).status, 401);
  assert.equal((await f.agent(config, "/api/settings/updates/plans", { nodeIds: ["alpha"], releaseId: f.built.release.id })).status, 401);
  assert.equal((await f.request("/api/node-updater/poll", { method: "POST", body: { protocol: 1, report: report() } })).status, 401);
  assert.equal((await f.agent(config, "/api/node-updater/poll", { protocol: 1, report: { ...report(), apiKey: "do-not-store" } })).status, 400);
});

test("preview does not update nodes; confirmed jobs persist, are idempotent and require a complete verification transition", async (t) => {
  const f = await fixture(t);
  const config = await f.enroll();
  await f.heartbeat(config);
  const preview = await (await f.request("/api/settings/updates/plans", {
    method: "POST", body: { nodeIds: ["alpha"], releaseId: f.built.release.id },
  })).json();
  assert.equal((await f.updates.store.read()).data.jobs.length, 0);
  const body = { planId: preview.id, confirmation: "update-reviewed-machines" };
  const first = await (await f.request("/api/settings/updates/jobs", { method: "POST", body })).json();
  const repeat = await (await f.request("/api/settings/updates/jobs", { method: "POST", body })).json();
  assert.deepEqual(first.jobs.map((job) => job.id), repeat.jobs.map((job) => job.id));
  const assignment = (await f.heartbeat(config)).job;
  assert.equal(assignment.state, "claimed");
  assert.equal(assignment.envelope.payload, f.built.envelope.payload);
  await f.advance(config, assignment, "succeeded", "ok", 409);
  await f.advance(config, assignment, "succeeded", "up_to_date", 409);
  await f.advance(config, { ...assignment, leaseToken: "x".repeat(43) }, "downloading", "ok", 409);
  for (const state of ["downloading", "staging", "waiting_idle", "applying", "verifying", "succeeded"]) {
    await f.advance(config, assignment, state);
  }
  assert.equal((await f.updates.store.read()).data.jobs[0].state, "succeeded");
  await f.updates.initialize(); // Restarting the broker must not erase durable state.
  assert.equal((await f.updates.store.read()).data.jobs[0].state, "succeeded");
});

test("batch canary gates remaining machines and failed canaries never report batch success", async (t) => {
  const f = await fixture(t);
  const alpha = await f.enroll("alpha"); const beta = await f.enroll("beta");
  await f.heartbeat(alpha); await f.heartbeat(beta);
  await f.enqueue(["alpha", "beta"]);
  const canary = (await f.heartbeat(alpha)).job;
  assert.ok(canary);
  assert.equal((await f.heartbeat(beta)).job, null);
  await f.advance(alpha, canary, "needs_action", "configuration_changed");
  assert.equal((await f.heartbeat(beta)).job, null);
  const jobs = (await f.updates.store.read()).data.jobs;
  assert.equal(jobs.find((job) => job.nodeId === "beta").state, "needs_action");
  assert.equal(jobs.find((job) => job.nodeId === "beta").code, "canary_failed");
});

test("only assigned artifact names are downloadable and per-node leases cannot report another node's job", async (t) => {
  const f = await fixture(t);
  const alpha = await f.enroll("alpha"); const beta = await f.enroll("beta");
  await f.heartbeat(alpha); await f.heartbeat(beta);
  const artifactPath = `/api/node-updater/releases/${f.built.release.id}/gateway.tar.gz`;
  assert.equal((await f.agent(alpha, artifactPath)).status, 403);
  await f.enqueue(["alpha", "beta"]);
  const job = (await f.heartbeat(alpha)).job;
  const download = await f.agent(alpha, artifactPath);
  assert.equal(download.status, 200);
  assert.equal(sha(Buffer.from(await download.arrayBuffer())), sha(f.built.archive));
  assert.equal((await f.agent(alpha, `/api/node-updater/releases/${f.built.release.id}/config.json`)).status, 404);
  await f.advance(beta, job, "downloading", "ok", 409);
});

test("missing migration prerequisites and incompatible runtimes remain explicit non-upgradable targets", async (t) => {
  const f = await fixture(t);
  const alpha = await f.enroll();
  await f.heartbeat(alpha, report({ readyMigrations: [] }));
  let plan = await (await f.request("/api/settings/updates/plans", { method: "POST", body: {
    nodeIds: ["alpha"], releaseId: f.built.release.id,
  } })).json();
  assert.equal(plan.targets[0].eligible, false);
  assert.equal(plan.targets[0].reason, "model_auth_migration_required");
  assert.equal((await f.request("/api/settings/updates/jobs", { method: "POST", body: {
    planId: plan.id, confirmation: "update-reviewed-machines",
  } })).status, 409);
  const wrongRuntime = report();
  wrongRuntime.components.cloudcli.nodeMajor = 26;
  await f.heartbeat(alpha, wrongRuntime);
  plan = await (await f.request("/api/settings/updates/plans", { method: "POST", body: {
    nodeIds: ["alpha"], releaseId: f.built.release.id,
  } })).json();
  assert.equal(plan.targets[0].reason, "runtime_incompatible");
});

test("expired plans, rotated/revoked credentials, account disable and downgrade reports fail closed", async (t) => {
  const f = await fixture(t);
  const alpha = await f.enroll();
  await f.heartbeat(alpha);
  const plan = await f.updates.plan("owner-a", ["alpha"], f.built.release.id);
  f.clock.now += 300001;
  await assert.rejects(f.updates.enqueue("owner-a", plan.id), { status: 409 });
  const rotated = await f.request("/api/settings/updates/bootstrap/alpha", { method: "POST",
    body: { confirmation: "enable-node-updater", replace: true } });
  assert.equal(rotated.status, 200);
  const config = JSON.parse(zipEntry(Buffer.from(await rotated.arrayBuffer()), "codey-updater/config.json"));
  assert.equal((await f.agent(alpha, "/api/node-updater/poll", { protocol: 1, report: report() })).status, 401);
  await f.heartbeat(config, report({ highestSequence: 3 }));
  assert.equal((await f.agent(config, "/api/node-updater/poll", { protocol: 1, report: report() })).status, 409);
  await f.updates.revoke("owner-a", "alpha");
  assert.equal((await f.agent(config, "/api/node-updater/poll", { protocol: 1, report: report({ highestSequence: 3 }) })).status, 401);
  const bobConfig = await f.enroll(f.bobNode.id, f.cookieB);
  await f.accounts.setEnabled(f.bob.id, false, "owner-a");
  assert.equal((await f.agent(bobConfig, "/api/node-updater/poll", { protocol: 1, report: report() })).status, 403);
});

test("failed bootstrap packaging must not create or rotate a usable credential", async (t) => {
  const f = await fixture(t);
  f.updates.sourceRoot = path.join(f.root, "missing-source");
  assert.equal((await f.request("/api/settings/updates/bootstrap/alpha", {
    method: "POST", body: { confirmation: "enable-node-updater" },
  })).status, 503);
  assert.equal((await f.updates.store.read()).data.devices.alpha, undefined);
});

test("busy nodes stay queued without becoming the canary; success releases the remaining nodes", async (t) => {
  const f = await fixture(t);
  const alpha = await f.enroll("alpha"); const beta = await f.enroll("beta");
  await f.heartbeat(alpha); await f.heartbeat(beta);
  await f.enqueue(["alpha", "beta"]);
  assert.equal((await f.heartbeat(alpha, report({ busy: true }))).waitingForIdle, true);
  assert.equal((await f.updates.store.read()).data.jobs[0].state, "queued");
  const canary = (await f.heartbeat(beta)).job;
  assert.equal(canary.nodeId, "beta");
  for (const state of ["downloading", "staging", "waiting_idle", "applying", "verifying", "succeeded"]) {
    await f.advance(beta, canary, state);
  }
  assert.equal((await f.heartbeat(alpha)).job.nodeId, "alpha");
});

test("pending machine credentials are stable, owner-bound and unusable before activation", async (t) => {
  const f = await fixture(t);
  const node = await f.policy.reserveMachine("owner-a");
  const first = await f.updates.newMachineEntries("owner-a", node.id);
  const second = await f.updates.newMachineEntries("owner-a", node.id);
  const config = JSON.parse(first.find((entry) => entry.name.endsWith("/config.json")).data);
  assert.equal(config.credential, JSON.parse(second.find((entry) => entry.name.endsWith("/config.json")).data).credential);
  assert.equal(config.ownerId, "owner-a");
  assert.equal((await f.agent(config, "/api/node-updater/poll", { protocol: 1, report: report() })).status, 404);
  await assert.rejects(f.updates.newMachineEntries(f.bob.id, node.id), { status: 404 });
  await f.policy.cancelMachine("owner-a", node.id);
  await assert.rejects(f.updates.newMachineEntries("owner-a", node.id), { status: 404 });
});

test("credential rotation does not reset the device anti-downgrade high-water mark", async (t) => {
  const f = await fixture(t);
  const config = await f.enroll();
  await f.heartbeat(config, report({ highestSequence: 7 }));
  const zip = await f.updates.bootstrap("owner-a", "alpha", true);
  const chunks = [];
  for await (const chunk of zip) chunks.push(chunk);
  const rotated = JSON.parse(zipEntry(Buffer.concat(chunks), "codey-updater/config.json"));
  assert.equal((await f.agent(rotated, "/api/node-updater/poll", { protocol: 1, report: report() })).status, 409);
});

test("unchanged signed packages can be verified while the user is busy, but cannot skip verification", async (t) => {
  const f = await fixture(t);
  const config = await f.enroll();
  const current = report({ busy: true, components: Object.fromEntries(Object.entries(f.built.release.components).map(([name, value]) =>
    [name, { version: value.version, commit: value.commit, entrySha256: value.entrySha256, nodeMajor: 24 }])) });
  await f.heartbeat(config, current);
  const { plan } = await f.enqueue();
  assert.equal(plan.targets[0].verificationOnly, true);
  const job = (await f.heartbeat(config, current)).job;
  assert.ok(job, "No services are restarted for verification-only jobs");
  await f.advance(config, job, "succeeded", "up_to_date", 409);
  await f.advance(config, job, "verifying");
  await f.advance(config, job, "succeeded", "up_to_date");
});

test("an expired signed catalog entry does not hide newer releases; its tampered signature still fails closed", async (t) => {
  const f = await fixture(t);
  const expired = releaseFixture(f.clock.now - 2 * 86400000, "expired-release", 2);
  const file = path.join(f.catalogRoot, "catalog.json");
  await writeFile(file, JSON.stringify({ schema: 1, releases: [expired.envelope, f.built.envelope] }));
  assert.deepEqual((await f.updates.catalog.list()).map((row) => row.release.id), [f.built.release.id]);
  expired.envelope.signature = "x".repeat(86);
  await writeFile(file, JSON.stringify({ schema: 1, releases: [expired.envelope, f.built.envelope] }));
  await assert.rejects(f.updates.catalog.list());
});

test("an offline queued node returning after release expiry is unblocked for a new reviewed plan, never updated", async (t) => {
  const f = await fixture(t);
  const config = await f.enroll();
  await f.heartbeat(config);
  await f.enqueue();
  f.clock.now = f.built.release.expiresAt + 1;
  assert.equal((await f.heartbeat(config)).job, null);
  const job = (await f.updates.store.read()).data.jobs[0];
  assert.equal(job.state, "needs_action");
  assert.equal(job.code, "release_unavailable");
  assert.equal(job.attempts, 0);
});
