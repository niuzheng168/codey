import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AccountStore } from "../src/account-store.mjs";
import { NodePolicy } from "../src/node-policy.mjs";
import { NodeDataGateway } from "../src/node-data-gateway.mjs";
import { CloudCliGateway } from "../src/cloudcli-gateway.mjs";
import { PasswordAuthenticator, hashPassword } from "../src/password-auth.mjs";
import { SettingsApi } from "../src/settings-api.mjs";
import { UserConfigStore } from "../src/user-config-store.mjs";
import { validateConfig } from "../src/config.mjs";
import { verifyClientTicket, issueClientTicket } from "../src/client-ticket.mjs";
import { workspaceNodeKey } from "../src/workspace-sso.mjs";
import { createMultiUserPortalServer } from "../src/server.mjs";

const origin = "https://codey.example.test";
const password = "Testing-Owner-Password-42!";
const bobPassword = "Testing-Bob-Password-42!";
const credential = { username: "zhn", principalId: "owner-a", passwordHash: await hashPassword(password) };

async function listen(t, server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}

function json(res, status, value) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

async function fakeVm(t, { nodeId, ownerId, master, ticketKey }) {
  const seen = [];
  const sockets = new Set();
  const workspaceAllowed = (req) => {
    try {
      const [payload, mac] = req.headers["x-codey-workspace-assertion"].split(".");
      const expected = createHmac("sha256", Buffer.from(workspaceNodeKey(master, nodeId), "base64url")).update(payload).digest("base64url");
      const claims = JSON.parse(Buffer.from(payload, "base64url"));
      return mac === expected && claims.aud === nodeId && claims.sub === ownerId &&
        claims.method === req.method && claims.path === req.url;
    } catch { return false; }
  };
  const server = http.createServer((req, res) => {
    seen.push(req.url);
    const pathname = new URL(req.url, "http://vm.local").pathname;
    if (pathname.startsWith("/api/") || pathname === "/") {
      if (!workspaceAllowed(req)) return json(res, 401, {});
      return json(res, 200, { privateOwner: ownerId });
    }
    try {
      // Match the real copilot-api behavior: key/audience/scope validation,
      // NOT an extra owner check which could hide a broker authorization bug.
      verifyClientTicket({
        signingKey: ticketKey, nodeId, token: String(req.headers.authorization ?? "").slice(7),
        requiredScope: pathname.startsWith("/session-history") ? "history" : "usage",
      });
    } catch { return json(res, 401, {}); }
    return json(res, 200, {
      privateOwner: ownerId, items: [{ session_name: `private-${nodeId}`, state: "active", title: `private-${ownerId}` }],
      total: 1, session: { session_name: `private-${nodeId}`, title: `private-${ownerId}` },
    });
  });
  server.on("upgrade", (req, socket) => {
    seen.push(req.url);
    if (!workspaceAllowed(req)) { socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n"); return; }
    socket.on("error", () => {});
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
  });
  t.after(() => { for (const socket of sockets) socket.destroy(); });
  return { url: await listen(t, server), seen };
}

async function upgrade(url, cookie) {
  const target = new URL(url);
  const socket = net.connect(Number(target.port), "127.0.0.1");
  socket.on("error", () => {});
  socket.write(`GET ${target.pathname} HTTP/1.1\r\nHost: ${target.host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nOrigin: ${origin}\r\nCookie: ${cookie}\r\n\r\n`);
  let response = "";
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("Upgrade timeout")); }, 3000);
    socket.on("data", (chunk) => {
      response += chunk;
      if (response.includes("\r\n\r\n")) { clearTimeout(timer); resolve(); }
    });
  });
  return { socket, status: Number(response.split(" ")[1]) };
}

async function fixture(t) {
  const prefix = path.join(os.tmpdir(), "codey-multiuser-test-");
  const root = await mkdtemp(prefix);
  t.after(async () => {
    assert.ok(path.resolve(root).startsWith(path.resolve(prefix)));
    assert.equal(path.dirname(root), path.dirname(prefix));
    await rm(root, { recursive: true, force: true });
  });
  const master = randomBytes(32).toString("base64url");
  const ticketMaster = randomBytes(48).toString("base64url");
  const defaults = validateConfig({
    nodes: [{ id: "alice-node", name: "Alice private", endpoint: "http://10.0.0.7:4141/usage" }],
    clientNodes: [
      { id: "alice-node", name: "Alice private", endpoint: "https://alice.example.test:8443/usage" },
      { id: "local", name: "Alice local", endpoint: "https://127.0.0.1:8443/usage" },
    ],
  });
  const authRoot = path.join(root, "auth");
  // Create an old-format session before initializing the multi-user database.
  const legacyAuth = new PasswordAuthenticator({
    credential, root: authRoot, publicBaseUrl: origin, staticRoot: path.resolve("public"),
  });
  const oldLogin = await legacyAuth.login("zhn", password);
  const cookieA = oldLogin.cookie.split(";")[0];
  const accounts = new AccountStore({ root: authRoot, master, credential });
  await accounts.initialize();
  const bob = await accounts.create({ username: "bob", password: bobPassword });
  const legacyConfigStore = new UserConfigStore(path.join(root, "users"), {
    tenantId: "test", seedPrincipalId: credential.principalId, seedConfig: defaults,
  });
  const policy = new NodePolicy({
    root: authRoot, master, ticketMaster, seedPrincipalId: credential.principalId, legacyConfigStore, defaults,
  });
  await policy.initialize();
  const nodeB = await policy.create(bob.id, { name: "Bob private", endpoint: "https://bob.example.test:8443/usage" });
  const auth = new PasswordAuthenticator({
    credential, accountStore: accounts, root: authRoot, publicBaseUrl: origin,
    staticRoot: path.resolve("public"), leaseIntervalMs: 20,
  });
  const cookieB = (await auth.login("bob", bobPassword)).cookie.split(";")[0];
  const vmA = await fakeVm(t, { nodeId: "alice-node", ownerId: credential.principalId, master, ticketKey: ticketMaster });
  const vmB = await fakeVm(t, { nodeId: nodeB.id, ownerId: bob.id, master, ticketKey: await policy.keyFor(bob.id, nodeB.id) });
  const vmByHost = { "10.0.0.7": vmA, "10.0.0.8": vmB };
  const dataGateway = new NodeDataGateway({
    signingKey: ticketMaster, ca: "test-ca",
    nodes: [
      { id: "alice-node", upstream: new URL("https://10.0.0.7:8443"), tlsServerName: "alice.example.test" },
      { id: nodeB.id, upstream: new URL("https://10.0.0.8:8443"), tlsServerName: "bob.example.test" },
    ],
  }, {
    nodePolicy: policy,
    requestImpl: (target, options, callback) => http.request(
      new URL(`${target.pathname}${target.search}`, vmByHost[target.hostname].url), options, callback,
    ),
  });
  const workspace = new CloudCliGateway({
    ssoMaster: master,
    nodes: [
      { id: "alice-node", name: "Alice private", basePath: "/cloudcli/alice-node", upstream: new URL(vmA.url) },
      { id: nodeB.id, name: "Bob private", basePath: `/cloudcli/${nodeB.id}`, upstream: new URL(vmB.url) },
    ],
  }, { sessionAuthenticator: auth, nodePolicy: policy, accessLeaseMs: 20 });
  const shared = {
    status: async () => ({ configured: true }),
    list: async () => ({
      items: [{ session_name: "public-shared", state: "active", title: "Shared intentionally", uploaded_at: 1 }],
      total: 1, permissions: { can_manage: true },
    }),
    detail: async () => ({ session: { session_name: "public-shared", state: "active", title: "Shared intentionally" } }),
    trash: async () => { throw new Error("Must not execute Shared mutation for a regular user"); },
  };
  const settingsApi = new SettingsApi({ accounts, nodePolicy: policy, authenticator: auth, cloudCliGateway: workspace, nodeDataGateway: dataGateway });
  const server = createMultiUserPortalServer({
    config: defaults, passwordAuthenticator: auth, nodePolicy: policy, settingsApi,
    userConfigStore: policy, cloudCliGateway: workspace, nodeDataGateway: dataGateway,
    sessionHistoryClient: shared, readOnly: true, clientOnly: true, clientRelaySigningKey: ticketMaster,
    // The deployed legacy environment still contains this restriction.
    // Multi-user password authentication must not reject valid non-bootstrap users.
    allowedPrincipalId: credential.principalId,
  });
  const url = await listen(t, server);
  const api = (cookie, pathname, method = "GET", value, extra = {}) => fetch(`${url}${pathname}`, {
    method, redirect: "manual",
    headers: { cookie, origin, ...(value !== undefined ? { "content-type": "application/json" } : {}), ...extra },
    ...(value !== undefined ? { body: JSON.stringify(value) } : {}),
  });
  return { root, authRoot, accounts, policy, auth, cookieA, cookieB, bob, nodeB, vmA, vmB, url, api, ticketMaster, master };
}

test("multi-user security: independent accounts, immutable node ownership and object-level enforcement", async (t) => {
  const f = await fixture(t);
  const { api, cookieA, cookieB, bob, nodeB } = f;

  await t.test("migration preserves the existing admin session and each account sees only its own nodes and CSP origins", async () => {
    assert.equal((await f.auth.principal({ headers: { cookie: cookieA } })).id, credential.principalId);
    const a = await (await api(cookieA, "/api/client-nodes")).json();
    const b = await (await api(cookieB, "/api/client-nodes?userId=owner-a")).json();
    assert.deepEqual(a.nodes.map((node) => node.id), ["alice-node", "local"]);
    assert.deepEqual(b.nodes.map((node) => node.id), [nodeB.id]);
    assert.equal(b.userId, bob.id);
    for (const [cookie, allowed, forbidden] of [
      [cookieA, "alice.example.test", "bob.example.test"], [cookieB, "bob.example.test", "alice.example.test"],
    ]) {
      const page = await api(cookie, "/");
      assert.equal(page.status, 200);
      assert.equal(page.headers.get("cache-control"), "private, no-store");
      assert.equal(page.headers.get("vary"), "Cookie");
      assert.ok(page.headers.get("content-security-policy").includes(allowed));
      assert.ok(!page.headers.get("content-security-policy").includes(forbidden));
    }
    const raw = await readFile(f.accounts.store.file, "utf8");
    assert.ok(!raw.includes(password) && !raw.includes(bobPassword));
    const exported = await (await api(cookieB, "/api/settings")).text();
    assert.ok(!exported.includes(credential.passwordHash) && !exported.includes(f.master) && !exported.includes("Alice"));
    const login = await api("", "/portal-auth/login", "POST", {
      username: "bob", password: bobPassword, principalId: credential.principalId, role: "admin",
    });
    assert.equal(login.status, 200);
    const anotherBobCookie = login.headers.get("set-cookie").split(";")[0];
    assert.equal((await (await api(anotherBobCookie, "/portal-auth/session")).json()).userId, bob.id);
    assert.equal((await api(anotherBobCookie, "/api/node-data/alice-node/usage")).status, 404);
  });

  await t.test("Usage, History, Workspace HTTP and WebSocket deny cross-user names before contacting a VM", async () => {
    for (const [cookie, ownId, ownOwner, foreignId, foreignVm] of [
      [cookieA, "alice-node", credential.principalId, nodeB.id, f.vmB],
      [cookieB, nodeB.id, bob.id, "alice-node", f.vmA],
    ]) {
      for (const endpoint of ["/usage", "/session-history", "/session-history/active/known-session"]) {
        const own = await api(cookie, `/api/node-data/${ownId}${endpoint}`);
        assert.equal(own.status, 200);
        assert.equal((await own.json()).privateOwner, ownOwner);
      }
      const ownWorkspace = await api(cookie, `/cloudcli/${ownId}/api/projects`);
      assert.equal((await ownWorkspace.json()).privateOwner, ownOwner);
      const ownSocket = await upgrade(`${f.url}/cloudcli/${ownId}/ws`, cookie);
      assert.equal(ownSocket.status, 101);
      ownSocket.socket.destroy();
      const before = foreignVm.seen.length;
      for (const endpoint of [
        `/api/node-data/${foreignId}/usage`,
        `/api/node-data/${foreignId}/session-history/active/known-session`,
        `/api/session-history?source=${foreignId}`,
        `/api/session-history/${foreignId}/active/known-session`,
        `/api/session-history/${foreignId}/active/known-session/archive`,
        `/cloudcli/${foreignId}/api/projects`,
        `/cloudcli/${foreignId}/api/files?path=/home/zhn`,
        `/api/settings/nodes/${foreignId}`,
      ]) {
        const result = await api(cookie, endpoint, "GET", undefined, {
          "x-ms-client-principal-id": ownOwner === bob.id ? credential.principalId : bob.id,
          authorization: "Bearer forged-owner", "x-codey-workspace-assertion": "forged",
        });
        assert.ok([403, 404].includes(result.status), `${endpoint}: ${result.status}`);
      }
      for (const pathname of ["/ws", "/shell"]) {
        const denied = await upgrade(`${f.url}/cloudcli/${foreignId}${pathname}`, cookie);
        assert.equal(denied.status, 403);
        denied.socket.destroy();
      }
      assert.equal(foreignVm.seen.length, before, "Foreign VM must not receive any of these requests");
      const workspaceList = await (await api(cookie, "/api/cloudcli/nodes")).json();
      assert.deepEqual(workspaceList.nodes.map((node) => node.id), [ownId]);
    }
  });

  await t.test("Shared is visible to both users, but regular users cannot mutate it or administer accounts", async () => {
    for (const cookie of [cookieA, cookieB]) {
      const list = await (await api(cookie, "/api/session-history?source=shared")).json();
      assert.deepEqual(list.items.map((item) => item.session_name), ["public-shared"]);
      assert.equal(list.permissions.can_manage, cookie === cookieA);
      assert.equal((await api(cookie, "/api/session-history/shared/active/public-shared")).status, 200);
    }
    assert.equal((await api(cookieB, "/api/session-history/shared/active/public-shared", "DELETE", undefined, { "x-portal-action": "session-history" })).status, 403);
    assert.equal((await api(cookieB, "/api/admin/users")).status, 403);
    assert.equal((await api(cookieB, "/api/admin/users", "POST", { username: "evil", password: "Long-Enough-Password" })).status, 403);
    assert.equal((await api("", "/api/settings")).status, 401);
    assert.equal((await api("", "/settings.js")).status, 401);
  });

  await t.test("known node IDs cannot be claimed, reassigned, used to mint tickets or retrieve other users' enrollment keys", async () => {
    const settings = { name: "Attempt", endpoint: "https://alice.example.test:8443/usage" };
    assert.equal((await api(cookieB, "/api/nodes/provision", "POST", { ...settings, id: "alice-node" }, { "x-portal-action": "provision" })).status, 403);
    assert.equal((await api(cookieB, "/api/settings/nodes", "POST", { ...settings, id: "alice-node" })).status, 400);
    for (const endpoint of ["https://*.example.test/usage", "https://bad;host.example.test/usage"]) {
      assert.equal((await api(cookieB, "/api/settings/nodes", "POST", { name: "Invalid CSP origin", endpoint })).status, 400);
    }
    assert.equal((await api(cookieB, `/api/settings/nodes/${nodeB.id}`, "PUT", { ownerId: credential.principalId })).status, 400);
    assert.equal((await api(cookieB, "/api/settings/nodes/alice-node", "PUT", settings)).status, 404);
    assert.equal((await api(cookieB, "/api/settings/nodes/alice-node", "DELETE")).status, 404);
    assert.equal((await api(cookieB, "/api/settings/nodes/alice-node/enrollment", "POST")).status, 404);
    assert.equal((await api(cookieA, `/api/settings/nodes/${nodeB.id}/enrollment`, "POST")).status, 404);
    assert.equal((await api(cookieA, "/api/settings/nodes/alice-node/enrollment", "POST")).status, 403, "Legacy master must never be exposed");

    const ownEnrollment = await (await api(cookieB, `/api/settings/nodes/${nodeB.id}/enrollment`, "POST")).json();
    assert.equal(ownEnrollment.principalId, bob.id);
    assert.notEqual(ownEnrollment.clientSigningKey, f.ticketMaster);
    assert.notEqual(ownEnrollment.clientSigningKey,
      createHmac("sha256", f.ticketMaster).update(`codey-client-node-v1:${nodeB.id}`).digest("base64url"));
    const bobConfig = await (await api(cookieB, "/api/client-nodes")).json();
    const ticket = bobConfig.nodes[0].ticket;
    assert.equal(verifyClientTicket({ signingKey: ownEnrollment.clientSigningKey, token: ticket, nodeId: nodeB.id }).principalId, bob.id);
    assert.equal((await fetch(`${f.vmA.url}/usage`, { headers: { authorization: `Bearer ${ticket}` } })).status, 401);
    const forgedWithLegacy = issueClientTicket({
      signingKey: f.ticketMaster, nodeId: nodeB.id, principalId: credential.principalId, ttlSeconds: 60,
    });
    assert.equal((await fetch(`${f.vmB.url}/usage`, { headers: { authorization: `Bearer ${forgedWithLegacy.token}` } })).status, 401);
  });

  await t.test("personal settings persist independently and account creation cannot assign caller-chosen roles or nodes", async () => {
    assert.equal((await api(cookieB, `/api/settings/nodes/${nodeB.id}`, "PUT", { name: "Bob renamed" })).status, 200);
    assert.equal((await f.policy.list(bob.id))[0].name, "Bob renamed");
    assert.equal((await f.policy.list(credential.principalId))[0].name, "Alice private");
    const restarted = new NodePolicy({
      root: f.authRoot, master: f.master, ticketMaster: f.ticketMaster, seedPrincipalId: credential.principalId,
      legacyConfigStore: f.policy.legacyConfigStore, defaults: f.policy.defaults,
    });
    await restarted.initialize();
    assert.equal((await restarted.list(bob.id))[0].name, "Bob renamed");
    assert.equal((await api(cookieA, "/api/admin/users", "POST", { username: "carol", password: "Another-Long-Password!", role: "admin" })).status, 400);
    const created = await api(cookieA, "/api/admin/users", "POST", { username: "carol", password: "Another-Long-Password!" });
    assert.equal(created.status, 201);
    const carol = (await created.json()).user;
    assert.equal(carol.role, "user");
    assert.deepEqual((await f.policy.load(carol.id)).config.clientNodes, []);
    assert.equal((await api(cookieB, "/api/settings/nodes", "POST", { name: "new", endpoint: "https://new.example.test/usage" }, { origin: "https://evil.example" })).status, 403);
  });

  await t.test("removing an owned node invalidates fresh accesses and disconnects its already-open workspace socket", async () => {
    const connection = await upgrade(`${f.url}/cloudcli/${nodeB.id}/ws`, cookieB);
    assert.equal(connection.status, 101);
    const closed = once(connection.socket, "close");
    assert.equal((await api(cookieB, `/api/settings/nodes/${nodeB.id}`, "DELETE")).status, 200);
    assert.equal((await api(cookieB, `/api/node-data/${nodeB.id}/usage`)).status, 404);
    assert.equal((await api(cookieB, `/cloudcli/${nodeB.id}/api/projects`)).status, 403);
    await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error("Removed node socket remained open")), 1500))]);
    assert.deepEqual((await (await api(cookieB, "/api/client-nodes")).json()).nodes, []);
    assert.equal((await api(cookieA, "/api/node-data/alice-node/usage")).status, 200);
  });

  await t.test("disabling an account revokes its cookies without affecting another user's session", async () => {
    assert.equal((await api(cookieA, `/api/admin/users/${bob.id}`, "DELETE")).status, 409);
    const disabled = await api(cookieA, `/api/admin/users/${bob.id}`, "PATCH", { enabled: false });
    assert.equal(disabled.status, 200);
    assert.equal((await api(cookieB, "/api/settings")).status, 401);
    assert.equal((await api(cookieA, "/api/settings")).status, 200);
    await assert.rejects(f.auth.login("bob", bobPassword), { status: 401 });
    assert.equal((await api(cookieA, `/api/admin/users/${credential.principalId}`, "PATCH", { enabled: false })).status, 403);
    assert.equal((await api(cookieA, `/api/admin/users/${bob.id}`, "DELETE")).status, 200);
    assert.equal(await f.accounts.byId(bob.id), null);
    assert.equal((await api(cookieB, "/api/settings")).status, 401);
  });

  await t.test("tampered ownership and credential files fail closed instead of loading an attacker's account or nodes", async () => {
    for (const store of [f.accounts.store, f.policy.store]) {
      const original = await readFile(store.file, "utf8");
      const envelope = JSON.parse(original);
      envelope.payload = envelope.payload.replace("owner-a", bob.id);
      await writeFile(store.file, JSON.stringify(envelope));
      const result = await api(cookieA, "/api/client-nodes");
      assert.equal(result.status, 503);
      await writeFile(store.file, original);
    }
  });
});

test("per-account throttling, password revocation and cross-replica settings updates remain isolated", async (t) => {
  const f = await fixture(t);
  for (let index = 0; index < 4; index++) {
    await assert.rejects(f.auth.login("bob", "wrong"), { status: 401 });
  }
  await assert.rejects(f.auth.login("bob", bobPassword), { status: 429 });
  const adminLogin = await f.auth.login("zhn", password);
  assert.equal(adminLogin.principal.id, credential.principalId, "Bob's limit must not block zhn");

  const carol = await f.accounts.create({ username: "carol", password: "Carol-Initial-Password!" });
  const carolLogin = await f.auth.login("carol", "Carol-Initial-Password!");
  const carolCookie = carolLogin.cookie.split(";")[0];
  const invalid = await f.api(carolCookie, "/api/settings/password", "POST", {
    currentPassword: "incorrect", newPassword: "Carol-New-Password!",
  });
  assert.equal(invalid.status, 400);
  assert.equal((await f.api(carolCookie, "/portal-auth/session")).status, 200);
  const changed = await f.api(carolCookie, "/api/settings/password", "POST", {
    currentPassword: "Carol-Initial-Password!", newPassword: "Carol-New-Password!",
  });
  assert.equal(changed.status, 200);
  assert.equal((await f.api(carolCookie, "/portal-auth/session")).status, 401);
  assert.equal((await f.auth.login("carol", "Carol-New-Password!")).principal.id, carol.id);
  assert.equal((await f.api(f.cookieA, "/portal-auth/session")).status, 200);

  const replica = new NodePolicy({
    root: f.authRoot, master: f.master, ticketMaster: f.ticketMaster, seedPrincipalId: credential.principalId,
    legacyConfigStore: f.policy.legacyConfigStore, defaults: f.policy.defaults,
  });
  await Promise.all([
    f.policy.update(f.bob.id, f.nodeB.id, { name: "Concurrent name" }),
    replica.update(f.bob.id, f.nodeB.id, { region: "Concurrent region" }),
  ]);
  const node = await replica.owned(f.bob.id, f.nodeB.id);
  assert.equal(node.name, "Concurrent name");
  assert.equal(node.region, "Concurrent region");
});
