import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PasswordAuthenticator, hashPassword } from "../src/password-auth.mjs";
import { createMultiUserPortalServer } from "../src/server.mjs";
import { CloudCliGateway } from "../src/cloudcli-gateway.mjs";
import { CloudCliUi } from "../src/cloudcli-ui.mjs";
import { uiFixture } from "./helpers/cloudcli-ui.mjs";
import { NodeDataGateway } from "../src/node-data-gateway.mjs";
import { validateConfig } from "../src/config.mjs";

const password = "test-only-C0dey!"; // Test fixture, never the deployed credential.
const credential = { username: "zhn", principalId: "test-owner", passwordHash: await hashPassword(password) };
const origin = "https://codey.example.test";
const cookieRequest = (cookie) => ({ headers: { cookie } });
const cookieValue = (login) => login.cookie.split(";")[0];

async function authenticator(t, options = {}) {
  const prefix = path.join(os.tmpdir(), "codey-auth-test-");
  const root = await mkdtemp(prefix);
  t.after(async () => {
    assert.ok(path.resolve(root).startsWith(prefix));
    await rm(root, { recursive: true, force: true });
  });
  return new PasswordAuthenticator({
    credential, root, publicBaseUrl: origin,
    staticRoot: path.resolve("public"), ...options,
  });
}

test("password sessions use salted hashing and secure opaque cookies; forged credentials do not authenticate", async (t) => {
  const auth = await authenticator(t);
  await assert.rejects(auth.login("zhn", "wrong"), { status: 401 });
  await assert.rejects(auth.login("other", password), { status: 401 });
  const signedIn = await auth.login("zhn", password);
  assert.match(signedIn.cookie, /^__Host-codey_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; Secure; SameSite=Strict;/);
  const cookie = cookieValue(signedIn);
  const principal = await auth.principal(cookieRequest(cookie));
  assert.equal(principal.id, "test-owner");
  assert.equal(principal.name, "zhn");
  for (const headers of [
    {},
    { "x-ms-client-principal-id": credential.principalId },
    { cookie: "codey_aad=old-aad-cookie" },
    { authorization: `Basic ${Buffer.from(`zhn:${password}`).toString("base64")}` },
    { cookie: "__Host-codey_session=forged" },
    { cookie: `${cookie}; ${cookie}` },
  ]) assert.equal(await auth.principal({ headers }), null);
  const raw = await readFile(path.join(auth.root, "sessions", `${principal.sessionId}.json`), "utf8");
  assert.ok(!raw.includes(password));
  assert.ok(!raw.includes(cookie.split("=")[1]));
});

test("session records are tamper-evident, persist across replicas, and are revoked on logout", async (t) => {
  const auth = await authenticator(t);
  const login = await auth.login("zhn", password);
  const request = cookieRequest(cookieValue(login));
  const replica = new PasswordAuthenticator({
    credential, root: auth.root, publicBaseUrl: origin, staticRoot: path.resolve("public"),
  });
  assert.equal((await replica.principal(request)).id, "test-owner");
  const file = path.join(auth.root, "sessions", `${login.principal.sessionId}.json`);
  const original = await readFile(file, "utf8");
  const changed = JSON.parse(original);
  changed.expiresAt += 86400000;
  await writeFile(file, JSON.stringify(changed));
  assert.equal(await auth.principal(request), null);
  await writeFile(file, original);
  let disconnected = 0;
  const cleanup = auth.track(login.principal, () => disconnected++);
  await auth.revoke(request);
  assert.equal(disconnected, 1);
  assert.equal(await auth.principal(request), null);
  assert.equal(await replica.principal(request), null);
  cleanup();
});

test("absolute/idle expiration and periodic connection lease checks fail closed", async (t) => {
  let clock = Date.now();
  const auth = await authenticator(t, { clock: () => clock, sessionTtlMs: 20000, idleTtlMs: 10000, leaseIntervalMs: 10 });
  const login = await auth.login("zhn", password);
  const request = cookieRequest(cookieValue(login));
  const disconnected = new Promise((resolve) => auth.track(login.principal, resolve));
  clock += 11000;
  assert.equal(await auth.principal(request), null);
  await Promise.race([disconnected, new Promise((_, reject) => setTimeout(() => reject(new Error("lease not revoked")), 500))]);
  clock += 15000;
  assert.equal(await auth.principal(request), null);
});

test("guessing limit is atomic and survives authenticator restart", async (t) => {
  const auth = await authenticator(t);
  for (let index = 0; index < 5; index++) {
    await assert.rejects(auth.login("zhn", "incorrect"), { status: 401 });
  }
  const replica = new PasswordAuthenticator({
    credential, root: auth.root, publicBaseUrl: origin, staticRoot: path.resolve("public"),
  });
  await assert.rejects(replica.login("zhn", password), { status: 429 });
  assert.equal((await readdir(path.join(auth.root, "login-limits"))).length, 5);
});

async function listen(t, server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections?.(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}

async function upgrade(url, cookie, suppliedOrigin = origin) {
  const target = new URL(url);
  const socket = net.connect(Number(target.port), "127.0.0.1");
  socket.write(
    `GET ${target.pathname} HTTP/1.1\r\nHost: ${target.host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n` +
    `Origin: ${suppliedOrigin}\r\n${cookie ? `Cookie: ${cookie}\r\n` : ""}\r\n`,
  );
  let output = "";
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("upgrade timed out")); }, 3000);
    socket.on("data", (chunk) => {
      output += chunk;
      if (output.includes("\r\n\r\n")) { clearTimeout(timer); resolve(); }
    });
    socket.on("error", reject);
  });
  return { socket, output };
}

test("all portal data/static/mutation/WS routes require login; SSO has no browser JWT and logout closes sockets", async (t) => {
  const auth = await authenticator(t);
  const ui = new CloudCliUi((await uiFixture(t)).store);
  const seen = [];
  const upstream = http.createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true }));
  });
  upstream.on("upgrade", (req, socket) => {
    seen.push({ url: req.url, headers: req.headers });
    socket.on("error", () => {});
    socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
  });
  const nodeUrl = await listen(t, upstream);
  const gateway = new CloudCliGateway({
    ssoMaster: randomBytes(32).toString("base64url"),
    nodes: [{ id: "node-a", name: "Node A", basePath: "/cloudcli/node-a", region: "test", upstream: new URL(nodeUrl) }],
  }, { sessionAuthenticator: auth, ui });
  const config = validateConfig({
    nodes: [{ id: "node-a", name: "Node A", endpoint: "http://127.0.0.1:4141/usage" }],
    clientNodes: [{ id: "node-a", name: "Node A", endpoint: "https://node-a.example.test:8443/usage" }],
  });
  const server = createMultiUserPortalServer({
    passwordAuthenticator: auth,
    allowedPrincipalId: credential.principalId,
    cloudCliGateway: gateway,
    cloudCliUi: ui,
    nodeDataGateway: new NodeDataGateway({
      signingKey: "test-data-key".repeat(4),
      nodes: [{ id: "node-a", upstream: new URL(nodeUrl), tlsServerName: "node-a.example.test" }],
    }, { requestImpl: (target, options, callback) => http.request(target, options, callback) }),
    userConfigStore: { load: async () => ({ config }) },
    config,
  });
  const url = await listen(t, server);
  for (const pathname of ["/api/nodes", "/api/client-nodes", "/api/cloudcli/nodes", "/api/node-data/node-a/usage", "/api/node-data/node-a/session-history", "/node-transport.js", "/app.js", "/styles.css", "/cloudcli/node-a/", "/cloudcli/node-a/api/projects", "/cloudcli/node-a/api/auth/register", "/cloudcli/node-a/_ui/runtime.js", "/cloudcli/node-a/sw.js", "/cloudcli-ui/ui-one/assets/app.js"]) {
    for (const method of ["GET", "POST"]) {
      const result = await fetch(`${url}${pathname}`, {
        method, redirect: "manual",
        headers: { "x-ms-client-principal-id": credential.principalId, "x-codey-workspace-assertion": "forged", origin },
      });
      assert.equal(result.status, 401, `${method} ${pathname}`);
    }
  }
  assert.equal(seen.length, 0);
  assert.equal((await fetch(`${url}/portal-auth/login`)).status, 200);
  assert.equal((await fetch(`${url}/portal-auth/callback`)).status, 404);
  const crossLogin = await fetch(`${url}/portal-auth/login`, {
    method: "POST", headers: { origin: "https://evil.example", "content-type": "application/json" },
    body: JSON.stringify({ username: "zhn", password }),
  });
  assert.equal(crossLogin.status, 403);
  const loginResponse = await fetch(`${url}/portal-auth/login`, {
    method: "POST", headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ username: "zhn", password }),
  });
  assert.equal(loginResponse.status, 200);
  const cookie = loginResponse.headers.get("set-cookie").split(";")[0];
  assert.equal((await fetch(`${url}/api/cloudcli/nodes`, { headers: { cookie } })).status, 200);
  assert.match(await (await fetch(`${url}/cloudcli/node-a/`, { headers: { cookie } })).text(), /cloudcli-ui\/ui-one/);
  assert.equal((await fetch(`${url}/cloudcli-ui/ui-one/assets/app.js`, { headers: { cookie } })).status, 200);
  const protectedRequest = await fetch(`${url}/cloudcli/node-a/api/projects`, {
    headers: { cookie, authorization: "Bearer attacker-jwt", "x-codey-workspace-assertion": "forged" },
  });
  assert.equal(protectedRequest.status, 200);
  assert.equal(seen.at(-1).headers.cookie, undefined);
  assert.equal(seen.at(-1).headers.authorization, undefined);
  assert.notEqual(seen.at(-1).headers["x-codey-workspace-assertion"], "forged");
  const assertion = JSON.parse(Buffer.from(seen.at(-1).headers["x-codey-workspace-assertion"].split(".")[0], "base64url"));
  assert.equal(assertion.sub, credential.principalId);
  assert.equal(assertion.aud, "node-a");
  assert.equal(assertion.path, "/api/projects");
  assert.equal(assertion.exp - assertion.iat, 20);
  assert.equal(protectedRequest.headers.get("cache-control"), "private, no-store");
  assert.equal((await fetch(`${url}/api/node-data/node-a/usage`, { headers: { cookie } })).status, 200);
  assert.equal((await fetch(`${url}/api/node-data/node-a/usage`, { method: "POST", headers: { cookie, origin } })).status, 405);
  assert.equal((await fetch(`${url}/api/node-data/node-a/usage`, {
    method: "POST", headers: { cookie, origin: "https://evil.example" },
  })).status, 403);
  for (const extra of [{ origin: "https://evil.example" }, {}]) {
    assert.equal((await fetch(`${url}/cloudcli/node-a/api/projects`, { method: "POST", headers: { cookie, ...extra } })).status, 403);
  }
  const denied = await upgrade(`${url}/cloudcli/node-a/ws`, null);
  assert.match(denied.output, /401 Unauthorized/);
  denied.socket.destroy();
  const crossSocket = await upgrade(`${url}/cloudcli/node-a/ws`, cookie, "https://evil.example");
  assert.match(crossSocket.output, /403 Forbidden/);
  crossSocket.socket.destroy();
  const connected = await upgrade(`${url}/cloudcli/node-a/ws`, cookie);
  assert.match(connected.output, /101 Switching Protocols/);
  const disconnected = once(connected.socket, "close");
  const logout = await fetch(`${url}/portal-auth/logout`, { method: "POST", headers: { cookie, origin } });
  assert.equal(logout.status, 200);
  await disconnected;
  assert.equal((await fetch(`${url}/cloudcli/node-a/api/projects`, { headers: { cookie } })).status, 401);
  assert.equal((await fetch(`${url}/cloudcli-ui/ui-one/assets/app.js`, { headers: { cookie } })).status, 401);
  assert.equal((await fetch(`${url}/api/node-data/node-a/usage`, { headers: { cookie } })).status, 401);
  const expired = await upgrade(`${url}/cloudcli/node-a/shell`, cookie);
  assert.match(expired.output, /401 Unauthorized/);
  expired.socket.destroy();
});
