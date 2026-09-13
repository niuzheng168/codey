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

test("authenticated owners download only signed whole-Codey packages without creating update jobs", async t => {
  const f = await fixture(t);
  const release = { ...f.built.release, components: { codey: {
    ...f.built.release.components.cloudcli, version: "0.1.6", file: "codey-0.1.6.tgz",
  } } };
  const bytes = Buffer.from(JSON.stringify(release));
  const envelope = { payload: bytes.toString("base64"), signature: sign(null, bytes, keys.privateKey).toString("base64url") };
  const catalog = path.join(f.catalogRoot, "catalog.json");
  const artifact = path.join(f.catalogRoot, "releases", release.id, release.components.codey.file);
  await writeFile(catalog, JSON.stringify({ schema: 1, releases: [envelope] }));
  await writeFile(artifact, f.built.archive);
  const endpoint = `/api/settings/updates/releases/${release.id}/codey.tgz`;
  const before = (await f.updates.store.read()).data;
  assert.equal((await f.request(endpoint, { cookie: null })).status, 401);
  for (const cookie of [f.cookieA, f.cookieB]) {
    const response = await f.request(endpoint, { cookie });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-disposition"), 'attachment; filename="codey-0.1.6.tgz"');
    assert.equal(response.headers.get("x-codey-sha256"), sha(f.built.archive));
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), f.built.archive);
  }
  assert.deepEqual((await f.updates.store.read()).data, before);
  assert.equal((await f.request(endpoint.replace("codey.tgz", "config.json"))).status, 404);
  await writeFile(artifact, Buffer.alloc(f.built.archive.length));
  assert.equal((await f.request(endpoint)).status, 503, "Even same-size corruption must fail before download");
  await writeFile(catalog, JSON.stringify({ schema: 1, releases: [f.built.envelope] }));
  assert.equal((await f.request(endpoint)).status, 404, "Legacy component releases are not application downloads");
  await writeFile(catalog, JSON.stringify({ schema: 1, releases: [{ ...envelope, signature: "invalid" }] }));
  assert.equal((await f.request(endpoint)).status, 503);
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
  assert.equal((await f.request("/api/admin/nodes")).status, 200, "Inventory access must not broaden update permissions");
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

test("admin inventory joins owner-bound heartbeats and reports installed versions, never target releases or private reports", async (t) => {
  const f = await fixture(t);
  const alpha = await f.enroll();
  const bob = await f.enroll(f.bobNode.id, f.cookieB);
  await f.enroll("beta"); // An issued credential is not evidence that a node is online.
  await f.heartbeat(alpha);
  await f.heartbeat(bob, report({
    currentRelease: "previously-installed-release",
    components: { copilotApi: { version: "2.0.3", commit: "c".repeat(40), entrySha256: "d".repeat(64), nodeMajor: 24 } },
  }));
  await f.updates.store.mutate((data) => {
    data.devices[f.bobNode.id].futurePrivateField = "private-device-detail";
    data.devices[f.bobNode.id].report.futurePrivateField = "private-report-detail";
    data.devices[f.bobNode.id].report.components.copilotApi.futurePrivateField = "private-component-detail";
  });
  // A broken/unavailable release catalog must not hide already reported versions.
  f.updates.catalog.list = f.updates.catalog.get = async () => { throw new Error("Must not read release catalog"); };
  const files = [f.policy.store.file, f.accounts.store.file, f.updates.store.file];
  const before = await Promise.all(files.map((file) => readFile(file, "utf8")));
  const response = await f.request("/api/admin/nodes");
  assert.equal(response.status, 200);
  const text = await response.text();
  const data = JSON.parse(text);
  assert.deepEqual(data.summary, { total: 4, owners: 2, online: 2, stale: 0, unknown: 2 });
  assert.equal(data.generatedAt, f.clock.now);
  assert.equal(data.heartbeatTimeoutMs, 90000);
  assert.equal(data.telemetryAvailable, true);
  const alphaRow = data.nodes.find((node) => node.id === "alpha");
  assert.equal(alphaRow.components.cloudcli.version, "1.0.0");
  assert.notEqual(alphaRow.components.cloudcli.version, f.built.release.components.cloudcli.version);
  assert.equal(alphaRow.releaseId, null, "Do not substitute a desired release for an installed one");
  assert.equal(alphaRow.lastSeen, f.clock.now);
  const bobRow = data.nodes.find((node) => node.id === f.bobNode.id);
  assert.deepEqual(bobRow.owner, { id: f.bob.id, username: "bob", enabled: true });
  assert.equal(bobRow.releaseId, "previously-installed-release");
  assert.equal(bobRow.components.cloudcli, null);
  assert.deepEqual(bobRow.components.copilotApi, { version: "2.0.3", commit: "c".repeat(40), nodeMajor: 24 });
  assert.equal(data.nodes.find((node) => node.id === "beta").status, "unreported");
  assert.equal(data.nodes.find((node) => node.id === "local").status, "not_enrolled");
  for (const node of data.nodes) {
    assert.deepEqual(Object.keys(node).sort(), ["components", "id", "lastSeen", "name", "owner", "region", "releaseId", "status"]);
    assert.deepEqual(Object.keys(node.owner).sort(), ["enabled", "id", "username"]);
    for (const component of Object.values(node.components).filter(Boolean)) {
      assert.deepEqual(Object.keys(component).sort(), ["commit", "nodeMajor", "version"]);
    }
  }
  for (const forbidden of [alpha.credential, bob.credential, "credentialHash", "entrySha256", "readyMigrations",
    "futurePrivateField", "private-device-detail", "private-report-detail", "private-component-detail",
    "example.test", "endpoint", "enrollmentSalt", "plans", "jobs"]) {
    assert.ok(!text.includes(forbidden), forbidden);
  }
  assert.deepEqual(await Promise.all(files.map((file) => readFile(file, "utf8"))), before, "GET must not mutate any store");
  assert.equal((await f.request("/api/admin/nodes", { cookie: f.cookieB })).status, 403);
  assert.equal((await f.request("/api/admin/nodes", { cookie: null })).status, 401);
  assert.equal((await f.agent(bob, "/api/admin/nodes")).status, 401);
  assert.deepEqual((await (await f.request("/api/settings", { cookie: f.cookieB })).json()).nodes.map((node) => node.id), [f.bobNode.id]);
  const lateWired = new SettingsApi({ accounts: f.accounts, nodePolicy: f.policy });
  lateWired.machineUpdates = f.updates;
  assert.deepEqual((await lateWired.adminNodes()).summary, data.summary, "Production attaches the updater after SettingsApi construction");
  lateWired.accounts = { list: async () => (await f.accounts.list()).filter((user) => user.id !== f.bob.id) };
  const orphan = (await lateWired.adminNodes()).nodes.find((node) => node.id === f.bobNode.id);
  assert.deepEqual(orphan.owner, { id: f.bob.id, username: null, enabled: false });
  assert.equal(orphan.status, "unknown", "A missing owner record must not imply either an enabled or a merely disabled account");
});

test("admin inventory exposes the installed Codey package through the same restricted heartbeat metadata", async t => {
  const f = await fixture(t);
  const alpha = await f.enroll();
  const installed = { version: "0.1.0", commit: "d".repeat(40), entrySha256: "e".repeat(64), nodeMajor: 24 };
  await f.heartbeat(alpha, report({ layout: "npm", currentRelease: "installed-codey", components: { codey: installed } }));
  await f.updates.store.mutate(data => {
    data.devices.alpha.report.components.codey.futurePrivateField = "not-for-the-directory";
  });
  f.updates.catalog.list = async () => { throw new Error("An inventory must not substitute a target release"); };
  const response = await f.request("/api/admin/nodes");
  assert.equal(response.status, 200);
  const text = await response.text();
  const row = JSON.parse(text).nodes.find(node => node.id === "alpha");
  assert.deepEqual(row.components.codey, { version: "0.1.0", commit: "d".repeat(40), nodeMajor: 24 });
  assert.equal(row.components.cloudcli, null);
  assert.equal(row.components.copilotApi, null);
  assert.equal(row.releaseId, "installed-codey");
  assert.doesNotMatch(text, /futurePrivateField|not-for-the-directory|entrySha256/);
});

test("admin inventory counts activated nodes across disabled owners, excluding pending, removed and empty-user records", async (t) => {
  const f = await fixture(t);
  const bob = await f.enroll(f.bobNode.id, f.cookieB);
  await f.heartbeat(bob);
  const pending = await f.policy.reserveMachine(f.bob.id);
  await f.policy.remove("owner-a", "beta");
  await f.accounts.create({ username: "carol", password });
  await f.accounts.setEnabled(f.bob.id, false, "owner-a");
  const response = await f.request("/api/admin/nodes");
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.deepEqual(data.summary, { total: 3, owners: 2, online: 0, stale: 0, unknown: 3 });
  assert.ok(!data.nodes.some((node) => ["beta", pending.id].includes(node.id)));
  const row = data.nodes.find((node) => node.id === f.bobNode.id);
  assert.equal(row.owner.username, "bob");
  assert.equal(row.owner.enabled, false);
  assert.equal(row.status, "owner_disabled");
  assert.equal(row.lastSeen, f.clock.now);
  assert.equal(row.components.cloudcli.version, "1.0.0", "Disabled accounts retain clearly historical version metadata");
  assert.equal((await f.agent(bob, "/api/node-updater/poll", { protocol: 1, report: report() })).status, 403);
});

test("inventory distinguishes fresh, expired, revoked, re-enrolled and mismatched-owner reports without fabricating liveness", async (t) => {
  const f = await fixture(t);
  const alpha = await f.enroll();
  await f.heartbeat(alpha);
  const inventory = async () => {
    const response = await f.request("/api/admin/nodes");
    assert.equal(response.status, 200);
    return response.json();
  };
  f.clock.now += 89999;
  assert.equal((await inventory()).nodes[0].status, "online");
  f.clock.now++;
  let data = await inventory();
  assert.equal(data.nodes[0].status, "stale");
  assert.deepEqual(data.summary, { total: 4, owners: 2, online: 0, stale: 1, unknown: 3 });
  assert.equal(data.nodes[0].components.cloudcli.version, "1.0.0");
  await f.updates.revoke("owner-a", "alpha");
  assert.equal((await inventory()).nodes[0].status, "revoked");
  await f.updates.bootstrap("owner-a", "alpha", true);
  data = await inventory();
  assert.equal(data.nodes[0].status, "unreported");
  assert.equal(data.nodes[0].lastSeen, null);
  assert.equal(data.nodes[0].components.cloudcli.version, "1.0.0", "Old report has no fresh timestamp after credential replacement");
  await f.updates.store.mutate((state) => { state.devices.alpha.lastSeen = f.clock.now + 1; });
  assert.equal((await inventory()).nodes[0].status, "unknown", "Future timestamps must not imply a live agent");
  for (const patch of [{ ownerId: f.bob.id }, { nodeId: "beta" }]) {
    await f.updates.store.mutate((state) => {
      Object.assign(state.devices.alpha, { nodeId: "alpha", ownerId: "owner-a" }, patch);
    });
    const row = (await inventory()).nodes[0];
    assert.equal(row.status, "not_enrolled");
    assert.equal(row.lastSeen, null);
    assert.equal(row.releaseId, null);
    assert.deepEqual(row.components, { codey: null, cloudcli: null, copilotApi: null }, "A report is bound to both owner and node");
  }
  await writeFile(f.updates.store.file, "corrupt signed heartbeat state");
  const failure = await f.request("/api/admin/nodes");
  assert.equal(failure.status, 503);
  assert.deepEqual(await failure.json(), { error: "账号或节点设置暂不可用" }, "Corrupt telemetry must not be presented as zero nodes or offline");
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

test("npm nodes accept only whole Codey releases and can download only their assigned npm artifact", async t => {
  const f = await fixture(t);
  const alpha = await f.enroll("alpha");
  const beta = await f.enroll("beta");
  const base = report();
  await f.heartbeat(alpha, {
    ...base, layout: "npm", components: { ...base.components, codey: {
      version: "0.0.1", commit: "a".repeat(40), entrySha256: "a".repeat(64), nodeMajor: 24,
    } },
  });
  await f.heartbeat(beta);
  const split = await f.updates.plan("owner-a", ["alpha"], f.built.release.id);
  assert.equal(split.targets[0].reason, "runtime_incompatible");
  assert.equal(split.targets[0].eligible, false);

  f.built.release.components = { codey: {
    ...f.built.release.components.cloudcli, version: "0.1.0", file: "codey-0.1.0.tgz",
  } };
  const body = Buffer.from(JSON.stringify(f.built.release));
  const envelope = { payload: body.toString("base64"), signature: sign(null, body, keys.privateKey).toString("base64url") };
  await writeFile(path.join(f.catalogRoot, "catalog.json"), JSON.stringify({ schema: 1, releases: [envelope] }));
  await writeFile(path.join(f.catalogRoot, "releases", f.built.release.id, "codey-0.1.0.tgz"), f.built.archive);
  const plan = await f.updates.plan("owner-a", ["alpha", "beta"], f.built.release.id);
  assert.equal(plan.targets.find(node => node.nodeId === "alpha").eligible, true);
  assert.equal(plan.targets.find(node => node.nodeId === "beta").reason, "runtime_incompatible");
  await f.enqueue(["alpha"]);
  await f.heartbeat(alpha, { ...base, layout: "npm", components: { ...base.components, codey: {
    version: "0.0.1", commit: "a".repeat(40), entrySha256: "a".repeat(64), nodeMajor: 24,
  } } });
  const endpoint = `/api/node-updater/releases/${f.built.release.id}/codey-0.1.0.tgz`;
  const downloaded = await f.agent(alpha, endpoint);
  assert.equal(downloaded.status, 200);
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), f.built.archive);
  assert.equal((await f.agent(beta, endpoint)).status, 403);
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

test("rotating an imported updater preserves its client-generated local Workspace binding", async (t) => {
  const f = await fixture(t);
  const id = `n-${"e".repeat(24)}`;
  const coordinates = { tunnelId: "codey-imported-updater", clusterId: "jpe1" };
  const connect = ["e30", Buffer.from(JSON.stringify({
    ...coordinates, scp: "connect", exp: Math.floor(Date.now() / 1000) + 72000,
  })).toString("base64url"), "c2ln"].join(".");
  const credentials = {
    clientSigningKey: randomBytes(32).toString("base64url"),
    workspaceSsoKey: randomBytes(32).toString("base64url"),
    tunnelUpdateKey: randomBytes(32).toString("base64url"),
    updaterCredential: randomBytes(32).toString("base64url"),
    workspaceSubject: `m-${"f".repeat(24)}`,
    workspaceUsername: "localowner",
  };
  await f.policy.importMachine("owner-a", {
    id, name: "Imported", region: "Test", platform: "linux-x64",
    networkMode: "devtunnel", devTunnel: coordinates,
    tlsServerName: `${id}.nodes.codey.internal`, fingerprint: "fixture", ca: "fixture",
  }, credentials, connect);
  await f.updates.registerClientMachine("owner-a", id, credentials.updaterCredential);
  const before = (await f.updates.store.read()).data.devices[id].credentialHash;
  const workspaceBindingFor = f.policy.workspaceBindingFor.bind(f.policy);
  f.policy.workspaceBindingFor = async () => { throw new Error("fixture binding failure"); };
  await assert.rejects(f.updates.bootstrap("owner-a", id, true), /fixture binding failure/);
  assert.equal((await f.updates.store.read()).data.devices[id].credentialHash, before,
    "A failed local-binding read must not rotate the active updater credential");
  f.policy.workspaceBindingFor = workspaceBindingFor;
  const zip = await f.updates.bootstrap("owner-a", id, true);
  const chunks = [];
  for await (const chunk of zip) chunks.push(chunk);
  const config = JSON.parse(zipEntry(Buffer.concat(chunks), "codey-updater/config.json"));
  assert.equal(config.nodeId, id);
  assert.equal(config.ownerId, credentials.workspaceSubject);
  assert.equal(config.username, credentials.workspaceUsername);
  assert.notEqual(config.credential, credentials.updaterCredential);
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

async function importedNative(f, platform = "windows-x64") {
  const id = `n-${randomBytes(12).toString("hex")}`;
  const coordinates = { tunnelId: "codey-" + platform + "-updater", clusterId: "jpe1" };
  const connect = ["e30", Buffer.from(JSON.stringify({
    ...coordinates, scp: "connect", exp: Math.floor(Date.now() / 1000) + 72000,
  })).toString("base64url"), "c2ln"].join(".");
  await f.policy.importMachine("owner-a", {
    id, name: platform.startsWith("macos-") ? "fixture-mac" : "CPC-Windows", region: "Test", platform, networkMode: "devtunnel", devTunnel: coordinates,
    tlsServerName: `${id}.nodes.codey.internal`, fingerprint: "fixture", ca: "fixture",
  }, {
    clientSigningKey: randomBytes(32).toString("base64url"), workspaceSsoKey: randomBytes(32).toString("base64url"),
    tunnelUpdateKey: randomBytes(32).toString("base64url"), updaterCredential: randomBytes(32).toString("base64url"),
    workspaceSubject: "m-" + "c".repeat(24), workspaceUsername: platform.startsWith("macos-") ? "macowner" : "windowsowner",
  }, connect);
  return id;
}

test("Windows explicit bootstrap contains only its native agent and retains owner/platform/sequence binding", async t => {
  const f = await fixture(t), id = await importedNative(f);
  const response = await f.request(`/api/settings/updates/bootstrap/${id}`, {
    method: "POST", body: { confirmation: "enable-node-updater" },
  });
  assert.equal(response.status, 200);
  const zip = Buffer.from(await response.arrayBuffer());
  const config = JSON.parse(zipEntry(zip, "codey-updater/config.json"));
  assert.equal(config.platform, "windows-x64");
  assert.equal(config.minimumSequence, 0);
  assert.equal(config.ownerId, "m-" + "c".repeat(24));
  assert.equal(config.username, "windowsowner");
  assert.match(zipEntry(zip, "codey-updater/install.ps1").toString(), /Register-UpdaterTask/);
  assert.match(zipEntry(zip, "codey-updater/agent.mjs").toString(), /class Agent/);
  assert.throws(() => zipEntry(zip, "codey-updater/install.py"), /missing/);
  const files = JSON.parse(zipEntry(zip, "codey-updater/agent-files.json")).files;
  for (const [name, expected] of Object.entries(files)) assert.equal(sha(zipEntry(zip, "codey-updater/" + name)), expected);
  const windowsReport = report({ platform: "windows-x64", layout: "npm", highestSequence: 7,
    components: { codey: { version: "0.1.4", commit: "a".repeat(40), entrySha256: "a".repeat(64), nodeMajor: 24 } } });
  await f.heartbeat(config, windowsReport);
  assert.equal((await f.agent(config, "/api/node-updater/poll", { protocol: 1, report: report() })).status, 409,
    "A Windows credential cannot masquerade as a Linux agent.");
  const status = (await (await f.request("/api/settings/updates")).json()).nodes.find(node => node.id === id);
  assert.equal(status.updaterSupported, true);
  assert.equal(status.connected, true);
  assert.equal(status.report.components.codey.version, "0.1.4");
  assert.equal(status.reason, "no_release", "Linux-only catalog does not mean Windows agent support is missing.");
  const rotatedStream = await f.updates.bootstrap("owner-a", id, true);
  const bytes = [];
  for await (const chunk of rotatedStream) bytes.push(chunk);
  const rotated = JSON.parse(zipEntry(Buffer.concat(bytes), "codey-updater/config.json"));
  assert.equal(rotated.minimumSequence, 7);
  assert.equal((await f.agent(config, "/api/node-updater/poll", { protocol: 1, report: windowsReport })).status, 401);
});

test("Windows signed jobs use the normal owner plan/confirmation/lease pipeline without replacing Linux's latest release", async t => {
  const f = await fixture(t), id = await importedNative(f);
  const config = await f.enroll(id);
  const windowsReport = report({ platform: "windows-x64", layout: "npm",
    components: { codey: { version: "0.1.4", commit: "a".repeat(40), entrySha256: "a".repeat(64), nodeMajor: 24 } } });
  await f.heartbeat(config, windowsReport);
  const linux = await f.enroll("alpha");
  await f.heartbeat(linux);
  const bytes = Buffer.from("Windows fixture artifact; never executed");
  const release = { ...f.built.release, id: "codey-windows-fixture", sequence: 2, platform: "windows-x64",
    components: { codey: { version: "0.1.5", commit: "b".repeat(40), file: "codey-0.1.5.tgz",
      sha256: sha(bytes), size: bytes.length, entrySha256: "b".repeat(64), lockSha256: "c".repeat(64), nodeMajors: [24] } } };
  const payload = Buffer.from(JSON.stringify(release));
  const envelope = { payload: payload.toString("base64"), signature: sign(null, payload, keys.privateKey).toString("base64url") };
  await mkdir(path.join(f.catalogRoot, "releases", release.id));
  await writeFile(path.join(f.catalogRoot, "releases", release.id, release.components.codey.file), bytes);
  await writeFile(path.join(f.catalogRoot, "catalog.json"), JSON.stringify({ schema: 1, releases: [envelope, f.built.envelope] }));
  const listed = await (await f.request("/api/settings/updates")).json();
  assert.equal(listed.nodes.find(node => node.id === "alpha").eligible, true);
  assert.equal(listed.nodes.find(node => node.id === id).eligible, true);
  const wrong = await f.updates.plan("owner-a", [id], f.built.release.id);
  assert.equal(wrong.targets[0].eligible, false);
  const preview = await f.updates.plan("owner-a", [id], release.id);
  assert.equal(preview.targets[0].eligible, true);
  assert.equal((await f.heartbeat(config, windowsReport)).job, null, "Preview alone must not enqueue.");
  const enqueued = await f.updates.enqueue("owner-a", preview.id);
  assert.equal(enqueued.length, 1);
  const job = (await f.heartbeat(config, windowsReport)).job;
  assert.equal(job.releaseId, release.id);
  await f.advance(config, job, "downloading");
  const download = await f.agent(config, `/api/node-updater/releases/${release.id}/${release.components.codey.file}`);
  assert.equal(download.status, 200);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
  for (const state of ["staging", "waiting_idle", "applying", "verifying"]) await f.advance(config, job, state);
  f.clock.now += 80000;
  await f.advance(config, job, "verifying");
  f.clock.now += 20000;
  const active = (await f.updates.list("owner-a")).nodes.find(node => node.id === id);
  assert.equal(active.connected, true, "Authenticated progress keeps a long verification live.");
  await f.advance(config, job, "succeeded");
});

test("a unified package preview pins platform-specific signatures and enqueues one owner-confirmed cross-platform canary batch", async t => {
  const f = await fixture(t), windowsId = await importedNative(f);
  const windows = await f.enroll(windowsId), linux = await f.enroll("alpha");
  const installed = { version: "0.1.6", commit: "a".repeat(40), entrySha256: "a".repeat(64), nodeMajor: 24 };
  const linuxReport = report({ layout: "npm", components: { codey: installed } });
  const windowsReport = { ...linuxReport, platform: "windows-x64" };
  await f.heartbeat(linux, linuxReport);
  await f.heartbeat(windows, windowsReport);
  const artifact = Buffer.from("one identical shared Codey package");
  const component = { version: "0.1.7", commit: "b".repeat(40), file: "codey-0.1.7.tgz",
    sha256: sha(artifact), size: artifact.length, entrySha256: "b".repeat(64), lockSha256: "c".repeat(64), nodeMajors: [24] };
  const linuxRelease = { ...f.built.release, id: "codey-shared-linux", sequence: 2, components: { codey: component } };
  const windowsRelease = { ...linuxRelease, id: "codey-shared-windows", sequence: 3, platform: "windows-x64",
    notes: "Windows-specific acceptance notes" };
  const envelope = release => {
    const bytes = Buffer.from(JSON.stringify(release));
    return { payload: bytes.toString("base64"), signature: sign(null, bytes, keys.privateKey).toString("base64url") };
  };
  const publish = win => writeFile(path.join(f.catalogRoot, "catalog.json"),
    JSON.stringify({ schema: 1, releases: [envelope(win), envelope(linuxRelease)] }));
  await publish({ ...windowsRelease, components: { codey: { ...component, sha256: "d".repeat(64) } } });
  const mismatch = await f.updates.plan("owner-a", ["alpha", windowsId], linuxRelease.id);
  assert.equal(mismatch.targets[1].eligible, false);
  assert.equal(mismatch.targets[1].reason, "release_platform_unavailable", "Same version is not proof of identical bytes");
  await publish(windowsRelease);
  const plan = await f.updates.plan("owner-a", ["alpha", windowsId], linuxRelease.id);
  assert.deepEqual(plan.targets.map(target => target.releaseId), [linuxRelease.id, windowsRelease.id]);
  assert.ok(plan.targets.every(target => target.eligible && /^[a-f0-9]{64}$/.test(target.digest)));
  assert.equal(plan.targets[1].notes, windowsRelease.notes);
  assert.equal((await f.updates.store.read()).data.jobs.length, 0);
  await assert.rejects(f.updates.plan("owner-a", ["alpha", f.bobNode.id], linuxRelease.id), { status: 404 });
  await publish({ ...windowsRelease, notes: "Changed after preview" });
  await assert.rejects(f.updates.enqueue("owner-a", plan.id), { status: 409 });
  assert.equal((await f.updates.store.read()).data.jobs.length, 0, "A stale platform signature rejects the entire batch");
  await publish(windowsRelease);
  const jobs = await f.updates.enqueue("owner-a", plan.id);
  assert.equal(new Set(jobs.map(job => job.batchId)).size, 1);
  assert.deepEqual(await f.updates.enqueue("owner-a", plan.id), jobs, "Confirmation remains idempotent");
  const winJob = (await f.heartbeat(windows, windowsReport)).job;
  assert.equal(winJob.releaseId, windowsRelease.id);
  assert.equal(verifyNodeRelease(winJob.envelope, keys.publicKey).release.platform, "windows-x64");
  assert.equal((await f.heartbeat(linux, linuxReport)).waitingForCanary, true);
  for (const state of ["downloading", "staging", "waiting_idle", "applying", "verifying", "succeeded"]) {
    await f.advance(windows, winJob, state);
  }
  assert.equal((await f.updates.list("owner-a")).nodes.find(node => node.id === windowsId).report.components.codey.version,
    "0.1.6", "A successful job does not manufacture an installed-version heartbeat");
  await f.heartbeat(windows, { ...windowsReport, components: { codey: {
    version: component.version, commit: component.commit, entrySha256: component.entrySha256, nodeMajor: 24,
  } }, highestSequence: windowsRelease.sequence, currentRelease: windowsRelease.id });
  assert.equal((await f.updates.list("owner-a")).nodes.find(node => node.id === windowsId).report.components.codey.version, "0.1.7");
  const linuxJob = (await f.heartbeat(linux, linuxReport)).job;
  assert.equal(linuxJob.releaseId, linuxRelease.id);
  assert.equal(verifyNodeRelease(linuxJob.envelope, keys.publicKey).release.platform, "linux-x64");
});

test("Mac bootstrap is owner-bound, architecture-specific and complete without Windows/systemd executables", async t => {
  for (const platform of ["macos-arm64", "macos-x64"]) {
    const f = await fixture(t), id = await importedNative(f, platform);
    assert.equal((await f.request(`/api/settings/updates/bootstrap/${id}`, {
      cookie: f.cookieB, method: "POST", body: { confirmation: "enable-node-updater" },
    })).status, 404);
    const response = await f.request(`/api/settings/updates/bootstrap/${id}`, {
      method: "POST", body: { confirmation: "enable-node-updater" },
    });
    assert.equal(response.status, 200);
    const zip = Buffer.from(await response.arrayBuffer());
    const config = JSON.parse(zipEntry(zip, "codey-updater/config.json"));
    assert.equal(config.platform, platform);
    assert.equal(config.ownerId, "m-" + "c".repeat(24));
    assert.equal(config.username, "macowner");
    assert.equal(config.minimumSequence, 0);
    assert.match(zipEntry(zip, "codey-updater/install.py").toString(), /com\.codey\.node-updater\./);
    assert.match(zipEntry(zip, "codey-updater/macos/native.py").toString(), /bootout/);
    for (const forbidden of ["install.ps1", "install.sh", "updater.py", "windows/native.ps1", "windows/host.cs"]) {
      assert.throws(() => zipEntry(zip, "codey-updater/" + forbidden), /missing/);
    }
    const manifest = JSON.parse(zipEntry(zip, "codey-updater/agent-files.json"));
    assert.equal(manifest.platform, platform);
    for (const [name, expected] of Object.entries(manifest.files)) {
      assert.equal(sha(zipEntry(zip, "codey-updater/" + name)), expected);
    }
    const macReport = report({ platform, layout: "npm", highestSequence: 17,
      components: { codey: { version: "0.1.2", commit: "a".repeat(40), entrySha256: "a".repeat(64), nodeMajor: 24 } } });
    await f.heartbeat(config, macReport);
    const wrongPlatform = platform === "macos-arm64" ? "macos-x64" : "macos-arm64";
    assert.equal((await f.agent(config, "/api/node-updater/poll", {
      protocol: 1, report: { ...macReport, platform: wrongPlatform },
    })).status, 409);
    const status = (await f.updates.list("owner-a")).nodes.find(node => node.id === id);
    assert.equal(status.updaterSupported, true);
    assert.equal(status.connected, true);
    assert.equal(status.report.components.codey.version, "0.1.2", "Enrollment must not invent a newly installed version.");
    assert.equal(status.reason, "no_release");
    const rotated = await f.updates.bootstrap("owner-a", id, true);
    const chunks = [];
    for await (const chunk of rotated) chunks.push(chunk);
    assert.equal(JSON.parse(zipEntry(Buffer.concat(chunks), "codey-updater/config.json")).minimumSequence, 17);
    assert.equal((await f.agent(config, "/api/node-updater/poll", { protocol: 1, report: macReport })).status, 401);
  }
});

test("Mac owner-confirmed jobs select the latest release for their architecture, never the globally newest other OS", async t => {
  const f = await fixture(t);
  const linuxConfig = await f.enroll("alpha");
  await f.heartbeat(linuxConfig);
  const machines = [];
  const envelopes = [f.built.envelope];
  for (const [index, platform] of ["macos-arm64", "macos-x64"].entries()) {
    const id = await importedNative(f, platform), config = await f.enroll(id);
    const macReport = report({ platform, layout: "npm",
      components: { codey: { version: "0.1.2", commit: "a".repeat(40), entrySha256: "a".repeat(64), nodeMajor: 24 } } });
    await f.heartbeat(config, macReport);
    const bytes = Buffer.from("Shared Mac test bytes, never executed.");
    const release = { ...f.built.release, id: "codey-" + platform + "-fixture", platform, sequence: index + 2,
      components: { codey: { version: "0.1.5", commit: "b".repeat(40), file: "codey-0.1.5.tgz",
        sha256: sha(bytes), size: bytes.length, entrySha256: "b".repeat(64), lockSha256: "c".repeat(64), nodeMajors: [24] } } };
    const payload = Buffer.from(JSON.stringify(release));
    envelopes.push({ payload: payload.toString("base64"), signature: sign(null, payload, keys.privateKey).toString("base64url") });
    await mkdir(path.join(f.catalogRoot, "releases", release.id));
    await writeFile(path.join(f.catalogRoot, "releases", release.id, release.components.codey.file), bytes);
    machines.push({ id, config, report: macReport, release });
  }
  await writeFile(path.join(f.catalogRoot, "catalog.json"), JSON.stringify({ schema: 1, releases: envelopes }));
  const list = await f.updates.list("owner-a");
  for (const id of ["alpha", ...machines.map(machine => machine.id)]) {
    assert.equal(list.nodes.find(node => node.id === id).eligible, true);
  }
  const arm = machines[0], intel = machines[1];
  const mixed = await f.updates.plan("owner-a", [arm.id, intel.id, "alpha"], arm.release.id);
  assert.deepEqual(mixed.targets.filter(row => row.eligible).map(row => row.nodeId), [arm.id, intel.id]);
  assert.deepEqual(mixed.targets.filter(row => row.eligible).map(row => row.releaseId), [arm.release.id, intel.release.id]);
  const plan = await f.updates.plan("owner-a", [arm.id], arm.release.id);
  assert.equal((await f.heartbeat(arm.config, arm.report)).job, null);
  await f.updates.enqueue("owner-a", plan.id);
  const assigned = (await f.heartbeat(arm.config, arm.report)).job;
  assert.equal(assigned.releaseId, arm.release.id);
  assert.equal((await f.heartbeat(intel.config, intel.report)).job, null);
  await f.advance(arm.config, assigned, "downloading");
  assert.equal((await f.agent(arm.config,
    `/api/node-updater/releases/${arm.release.id}/${arm.release.components.codey.file}`)).status, 200);
  for (const state of ["staging", "waiting_idle", "applying", "verifying", "succeeded"]) {
    await f.advance(arm.config, assigned, state);
  }
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
