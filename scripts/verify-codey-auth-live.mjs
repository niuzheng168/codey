import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { once } from "node:events";

const require = createRequire(new URL("../cloudcli/package.json", import.meta.url));
const WebSocket = require("ws");
const origin = "https://codey.ambitiouspond-a4ecfeb2.japaneast.azurecontainerapps.io";
const nodes = ["zhn-a100", "jpe2", "jpe3", "westus2"];
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const password = Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
assert.ok(password);
const results = [];
const check = async (pathname, expected, options = {}) => {
  const response = await fetch(`${origin}${pathname}`, {
    redirect: "manual", signal: AbortSignal.timeout(30000), ...options,
  });
  assert.equal(response.status, expected, `${options.method || "GET"} ${pathname}`);
  return response;
};
const socketAttempt = (node, cookie, suppliedOrigin = origin) => new Promise((resolve, reject) => {
  const socket = new WebSocket(`${origin.replace("https:", "wss:")}/cloudcli/${node}/ws`, {
    headers: { Origin: suppliedOrigin, ...(cookie ? { Cookie: cookie } : {}) },
    rejectUnauthorized: true,
    handshakeTimeout: 15000,
  });
  socket.on("error", () => {}); // Negative handshakes are intentional test cases.
  socket.once("unexpected-response", (_request, response) => {
    response.resume();
    const status = response.statusCode;
    socket.terminate();
    resolve({ status, socket: null });
  });
  socket.once("open", () => resolve({ status: 101, socket }));
  socket.once("error", (error) => {
    if (!/closed before the connection|Unexpected server response/.test(error.message)) reject(error);
  });
});

const page = await check("/portal-auth/login", 200);
assert.ok((await page.text()).includes("登录你的工作空间"));
for (const pathname of ["/api/nodes", "/api/client-nodes", "/api/cloudcli/nodes", "/api/session-history", "/api/node-data/jpe2/usage", "/api/node-data/jpe2/session-history", "/node-transport.js", "/app.js", "/mcp", "/v1/sessions"]) {
  await check(pathname, 401, { headers: { "x-ms-client-principal-id": "9e7a208d-62e7-459d-a5be-f74e4b726a5a" } });
}
for (const node of nodes) {
  for (const method of ["GET", "POST"]) {
    await check(`/cloudcli/${node}/api/projects`, 401, { method, headers: { Origin: origin } });
  }
  assert.equal((await socketAttempt(node)).status, 401);
}
await check("/portal-auth/login", 403, {
  method: "POST", headers: { Origin: "https://untrusted.example", "Content-Type": "application/json" },
  body: JSON.stringify({ username: "zhn", password: "not-a-password" }),
});
if (process.env.CODEY_VERIFY_SKIP_BAD_PASSWORD !== "true") {
  await check("/portal-auth/login", 401, {
    method: "POST", headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ username: "zhn", password: "incorrect-verification-only" }),
  });
}
const login = await check("/portal-auth/login", 200, {
  method: "POST", headers: { Origin: origin, "Content-Type": "application/json" },
  body: JSON.stringify({ username: "zhn", password }),
});
const cookieHeader = login.headers.get("set-cookie");
assert.match(cookieHeader, /HttpOnly; Secure; SameSite=Strict/);
const cookie = cookieHeader.split(";")[0];
const headers = { Cookie: cookie, Origin: origin };
const account = await (await check("/portal-auth/session", 200, { headers })).json();
assert.equal(account.username, "zhn");
const nodeList = await (await check("/api/cloudcli/nodes", 200, { headers })).json();
assert.deepEqual(nodeList.nodes.map((node) => node.id).sort(), [...nodes].sort());

const sockets = [];
let loggedOut = false;
try {
  const dataConfig = await (await check("/api/client-nodes", 200, { headers })).json();
  assert.deepEqual(dataConfig.connectionModes, ["direct", "vnet"]);
  assert.equal(dataConfig.nodes.find((node) => node.id === "local")?.proxyEndpoint, null);
  assert.deepEqual(
    dataConfig.nodes.filter((node) => node.proxyEndpoint).map((node) => node.id).sort(),
    [...nodes].sort(),
  );
  await check("/api/node-data/local/usage", 404, { headers });
  await check("/api/node-data/not-assigned/usage", 404, { headers });
  await check("/api/node-data/jpe2/responses", 404, { headers });
  await check("/api/node-data/jpe2/usage?url=https://untrusted.example", 400, { headers });
  for (const node of nodes) {
    const dataBase = `/api/node-data/${node}`;
    for (const pathname of ["/usage", "/token-usage?period=day", "/token-usage/daily?period=day", "/token-usage/events?period=day&page=1&page_size=1"]) {
      const response = await check(`${dataBase}${pathname}`, 200, { headers });
      assert.equal(response.headers.get("cache-control"), "private, no-store");
      assert.equal(response.headers.get("set-cookie"), null);
      await response.json();
    }
    const history = await (await check(`${dataBase}/session-history?state=all&limit=1`, 200, { headers })).json();
    let historyDetailApi = null;
    if (history.items?.length) {
      const item = history.items[0];
      await check(`${dataBase}/session-history/${encodeURIComponent(item.state)}/${encodeURIComponent(item.session_name)}`, 200, { headers });
      historyDetailApi = 200;
    }
    await check(`${dataBase}/usage`, 405, { method: "POST", headers });
    await check(`${dataBase}/usage`, 403, {
      method: "POST", headers: { Cookie: cookie, Origin: "https://untrusted.example" },
    });
    const base = `/cloudcli/${node}`;
    const status = await (await check(`${base}/api/auth/status`, 200, { headers })).json();
    assert.equal(status.managedAuthentication, true);
    assert.equal(status.needsSetup, false);
    assert.equal(status.user.username, "zhn");
    await check(`${base}/api/projects`, 200, { headers });
    await check(`${base}/`, 200, { headers });
    await check(`${base}/api/auth/register`, 403, { method: "POST", headers, body: "{}" });
    await check(`${base}/api/auth/login`, 403, { method: "POST", headers, body: "{}" });
    await check(`${base}/api/projects`, 403, { method: "POST", headers: { Cookie: cookie, Origin: "https://untrusted.example" } });
    assert.equal((await socketAttempt(node, cookie, "https://untrusted.example")).status, 403);
    const connection = await socketAttempt(node, cookie);
    assert.equal(connection.status, 101);
    sockets.push(connection.socket);
    results.push({
      node, ssoUser: status.user.username, localLoginDisabled: true, projectsApi: 200, websocket: 101,
      usageApis: [200, 200, 200, 200], historyListApi: 200, historyDetailApi,
    });
  }
  const closed = sockets.map((socket) => once(socket, "close"));
  await check("/portal-auth/logout", 200, { method: "POST", headers });
  loggedOut = true;
  await Promise.race([
    Promise.all(closed),
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error("Logout did not close workspace sockets")), 10000);
      timer.unref();
    }),
  ]);
  for (const node of nodes) {
    await check(`/cloudcli/${node}/api/projects`, 401, { headers });
    await check(`/cloudcli/${node}/api/projects`, 401, { method: "POST", headers });
    await check(`/api/node-data/${node}/usage`, 401, { headers });
    assert.equal((await socketAttempt(node, cookie)).status, 401);
  }
  console.log(JSON.stringify({
    ok: true, username: "zhn", nodes: results,
    anonymousRequestsDenied: true, forgedPrincipalDenied: true,
    csrfDenied: true, logoutRevokesCookie: true, logoutClosesAllSockets: true,
    vnetDataAuthenticated: true, localExcludedFromVnet: true, arbitraryTargetsDenied: true,
  }, null, 2));
} finally {
  for (const socket of sockets) socket.terminate();
  if (!loggedOut) await check("/portal-auth/logout", 200, { method: "POST", headers }).catch(() => {});
}
