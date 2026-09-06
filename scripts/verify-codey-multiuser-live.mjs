import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import https from "node:https";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { issueClientTicket, verifyClientTicket } from "../src/client-ticket.mjs";

const require = createRequire(new URL("../cloudcli/package.json", import.meta.url));
const WebSocket = require("ws");
const origin = "https://codey.ambitiouspond-a4ecfeb2.japaneast.azurecontainerapps.io";
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const adminPassword = Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
assert.ok(adminPassword, "Read the admin password from stdin, never argv");
const suffix = `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
const username = `verify-${suffix}`;
const password = randomBytes(24).toString("base64url");
let adminCookie;
let user;
let userCookie;
let testNode;
let report;

async function request(cookie, pathname, { method = "GET", data, extra = {}, expected = 200 } = {}) {
  const response = await fetch(`${origin}${pathname}`, {
    method, redirect: "manual", signal: AbortSignal.timeout(30000),
    headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}),
      ...(data !== undefined ? { "content-type": "application/json" } : {}), ...extra },
    ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
  });
  assert.ok((Array.isArray(expected) ? expected : [expected]).includes(response.status),
    `${method} ${pathname}: HTTP ${response.status}`);
  return response;
}

async function login(name, secret) {
  const response = await request(null, "/portal-auth/login", {
    method: "POST", data: { username: name, password: secret },
  });
  const cookie = response.headers.get("set-cookie");
  assert.ok(cookie?.includes("HttpOnly; Secure; SameSite=Strict"), "Secure session cookie required");
  return cookie.split(";")[0];
}

function deniedSocket(nodeId, cookie) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${origin.replace("https:", "wss:")}/cloudcli/${nodeId}/shell`, {
      headers: { Origin: origin, Cookie: cookie }, handshakeTimeout: 15000,
    });
    ws.on("error", () => {});
    ws.once("open", () => { ws.terminate(); reject(new Error("Foreign workspace WebSocket was accepted")); });
    ws.once("unexpected-response", (_request, response) => {
      response.resume();
      ws.terminate();
      resolve(response.statusCode);
    });
    ws.once("error", (error) => {
      if (!/closed before|Unexpected server response/.test(error.message)) reject(new Error("WebSocket verification failed"));
    });
  });
}

function publicNodeSettings(nodes) {
  return nodes.map(({ id, name, endpoint, region, accent }) => ({ id, name, endpoint, region, accent }));
}

try {
  await request(null, "/api/settings", { expected: 401 });
  await request(null, "/api/admin/users", { expected: 401 });
  adminCookie = await login("zhn", adminPassword);
  const admin = await (await request(adminCookie, "/portal-auth/session")).json();
  assert.equal(admin.multiUser, true);
  assert.equal(admin.role, "admin");
  const before = await (await request(adminCookie, "/api/settings")).json();
  const workspaceNodes = (await (await request(adminCookie, "/api/cloudcli/nodes")).json()).nodes;
  user = (await (await request(adminCookie, "/api/admin/users", {
    method: "POST", data: { username, password }, expected: 201,
  })).json()).user;
  userCookie = await login(username, password);
  const empty = await (await request(userCookie, "/api/settings")).json();
  assert.equal(empty.user.id, user.id);
  assert.equal(empty.user.role, "user");
  assert.equal(empty.nodes.length, 0);
  assert.equal((await (await request(userCookie, "/api/cloudcli/nodes")).json()).nodes.length, 0);
  await request(userCookie, "/api/admin/users", { expected: 403 });
  await request(userCookie, "/api/settings/nodes", {
    method: "POST", expected: 400,
    data: { id: before.nodes[0].id, name: "Cannot claim a foreign node", endpoint: before.nodes[0].endpoint },
  });
  await request(userCookie, "/api/nodes/provision", {
    method: "POST", expected: 403, extra: { "x-portal-action": "provision" },
    data: { id: before.nodes[0].id, name: "Cannot claim", endpoint: before.nodes[0].endpoint },
  });
  testNode = (await (await request(userCookie, "/api/settings/nodes", {
    method: "POST", expected: 201,
    data: { name: `Isolation test ${suffix}`, endpoint: `https://${suffix}.invalid:8443/usage`, region: "Temporary verification" },
  })).json()).node;
  const ownNodes = await (await request(userCookie, "/api/client-nodes")).json();
  assert.deepEqual(ownNodes.nodes.map((node) => node.id), [testNode.id]);
  const enrollment = await (await request(userCookie, `/api/settings/nodes/${testNode.id}/enrollment`, { method: "POST" })).json();
  assert.equal(enrollment.principalId, user.id);
  const claims = verifyClientTicket({
    signingKey: enrollment.clientSigningKey, nodeId: testNode.id, token: ownNodes.nodes[0].ticket,
  });
  assert.equal(claims.principalId, user.id);
  await request(adminCookie, `/api/settings/nodes/${testNode.id}/enrollment`, { method: "POST", expected: 404 });
  await request(userCookie, `/api/settings/nodes/${testNode.id}`, {
    method: "PUT", data: { name: `Isolation updated ${suffix}` },
  });
  const ownSettings = await (await request(userCookie, "/api/settings?userId=" + admin.userId)).json();
  assert.equal(ownSettings.user.id, user.id);
  assert.equal(ownSettings.nodes[0].name, `Isolation updated ${suffix}`);
  const page = await request(userCookie, "/");
  const csp = page.headers.get("content-security-policy");
  assert.ok(csp.includes(`${suffix}.invalid`));
  for (const node of before.nodes) assert.ok(!csp.includes(new URL(node.endpoint).origin), "Foreign endpoint appeared in tenant CSP");

  const forbidden = [];
  for (const node of workspaceNodes) {
    const forge = { "x-ms-client-principal-id": admin.userId, "x-codey-workspace-assertion": "forged" };
    for (const pathname of [
      `/api/node-data/${node.id}/usage`,
      `/api/node-data/${node.id}/session-history?limit=1`,
      `/api/session-history?source=${node.id}`,
      `/api/session-history/${node.id}/active/verification_nonexistent/archive`,
      `/cloudcli/${node.id}/api/projects`,
      `/cloudcli/${node.id}/api/files`,
      `/api/settings/nodes/${node.id}/enrollment`,
    ]) {
      await request(userCookie, pathname, {
        expected: [403, 404], extra: forge,
        ...(pathname.endsWith("/enrollment") ? { method: "POST" } : {}),
      });
    }
    assert.equal(await deniedSocket(node.id, userCookie), 403);
    await request(adminCookie, `/api/node-data/${node.id}/usage`);
    await request(adminCookie, `/cloudcli/${node.id}/api/projects`);
    forbidden.push({ node: node.id, foreignHttpDenied: true, foreignShellDenied: true, ownerStillWorks: true });
  }
  const shared = await (await request(userCookie, "/api/session-history?source=shared&limit=1")).json();
  assert.equal(shared.permissions.can_manage, false);
  // Use a guaranteed-unrelated random name: NEVER attempt a destructive negative
  // test against real Shared data, even when it is expected to be denied.
  await request(userCookie, `/api/session-history/shared/active/verify_${suffix}`, {
    method: "DELETE", expected: 403, extra: { "x-portal-action": "session-history" },
  });

  const a100 = before.nodes.find((node) => node.id === "zhn-a100");
  assert.ok(a100);
  const forged = issueClientTicket({
    signingKey: enrollment.clientSigningKey, nodeId: a100.id, principalId: user.id, ttlSeconds: 60,
  });
  const ca = await readFile(new URL("../config/codey-node-ca.pem", import.meta.url));
  const directStatus = await new Promise((resolve, reject) => {
    const req = https.request(a100.endpoint, {
      ca, rejectUnauthorized: true, headers: { authorization: `Bearer ${forged.token}`, origin },
    }, (response) => { response.resume(); response.on("end", () => resolve(response.statusCode)); });
    req.setTimeout(10000, () => req.destroy(new Error("Direct HTTPS verification timed out")));
    req.on("error", reject);
    req.end();
  });
  assert.equal(directStatus, 401, "A different tenant key must fail on the actual VM, even with its known node ID");
  const after = await (await request(adminCookie, "/api/settings")).json();
  assert.deepEqual(publicNodeSettings(after.nodes), publicNodeSettings(before.nodes), "Original node settings changed");
  report = {
    ok: true, existingOwnerUnchanged: true, newUserStartsEmpty: true, userSettingsPersist: true,
    adminCannotReadOtherNodes: true, scopedTicketsVerified: true, directForeignTicketStatus: directStatus,
    sharedReadable: true, sharedReadOnlyForMembers: true, nodes: forbidden,
  };
} finally {
  // Only resources created by this run are touched. No VM, existing account,
  // node setting, Shared session, or original data is deleted.
  if (testNode && userCookie) {
    await request(userCookie, `/api/settings/nodes/${testNode.id}`, { method: "DELETE" });
  }
  if (user && adminCookie) {
    await request(adminCookie, `/api/admin/users/${user.id}`, { method: "PATCH", data: { enabled: false } });
    if (userCookie) await request(userCookie, "/api/settings", { expected: 401 });
    await request(adminCookie, `/api/admin/users/${user.id}`, { method: "DELETE" });
  }
  if (adminCookie) await request(adminCookie, "/portal-auth/logout", { method: "POST" });
}
if (report) console.log(JSON.stringify({ ...report, temporaryAccountRemoved: true }, null, 2));
