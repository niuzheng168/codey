import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { validateConfig } from "../src/config.mjs";
import { verifyClientTicket } from "../src/client-ticket.mjs";
import { NodeDataGateway, resolveNodeDataGatewayConfig } from "../src/node-data-gateway.mjs";
import { createMultiUserPortalServer } from "../src/server.mjs";

const signingKey = "test-node-data-key-".repeat(4);
const node = { id: "node-a", upstream: "https://10.0.0.7:8443", tlsServerName: "node-a.example.test" };

function load(nodes = [node]) {
  return resolveNodeDataGatewayConfig({
    PORTAL_NODE_DATA_CONFIG: "/test/nodes.json",
    PORTAL_CLIENT_RELAY_SIGNING_KEY: signingKey,
  }, (file) => file.endsWith("nodes.json") ? JSON.stringify({ nodes }) : "test-ca");
}

function mockRequest(seen, reply = {}) {
  return (url, options, onResponse) => {
    seen.push({ url: String(url), options });
    const request = new EventEmitter();
    let response;
    let destroyed = false;
    request.destroy = () => { destroyed = true; response?.destroy(); };
    request.end = () => {
      if (reply.hang) return;
      queueMicrotask(() => {
        if (destroyed) return;
        if (reply.error) return request.emit("error", Object.assign(new Error("TLS failed"), { code: reply.error }));
        response = new PassThrough();
        response.statusCode = reply.status ?? 200;
        response.headers = { "content-type": "application/json", "set-cookie": "upstream=must-not-escape", ...reply.headers };
        onResponse(response);
        if (!destroyed) response.end(reply.body ?? '{"ok":true}');
      });
    };
    return request;
  };
}

async function start(t, reply = {}, gatewayOptions = {}) {
  const seen = [];
  const config = validateConfig({
    nodes: [{ id: "node-a", name: "A", endpoint: "http://10.0.0.7:4141/usage" }],
    clientNodes: [
      { id: "local", name: "Local", endpoint: "https://127.0.0.1:8443/usage" },
      { id: "node-a", name: "A", endpoint: "https://node-a.example.test:8443/usage" },
    ],
  });
  const gateway = new NodeDataGateway(load(), { requestImpl: mockRequest(seen, reply), ...gatewayOptions });
  const server = createMultiUserPortalServer({
    config, clientOnly: true, clientRelaySigningKey: signingKey, nodeDataGateway: gateway,
    aadAuthenticator: { principal: async (req) => req.headers.cookie === "owner-a"
      ? { id: "owner-a" } : req.headers.cookie === "owner-b" ? { id: "owner-b" } : null },
    userConfigStore: { load: async (id) => ({ config: id === "owner-a" ? config : validateConfig({ nodes: [] }) }) },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { url: `http://127.0.0.1:${server.address().port}`, seen, gateway };
}

test("VNet data targets must be explicit private HTTPS origins with TLS names; local and arbitrary targets are rejected", () => {
  assert.equal(resolveNodeDataGatewayConfig({}), null);
  assert.equal(load().nodes[0].upstream.origin, "https://10.0.0.7:8443");
  for (const upstream of [
    "http://10.0.0.7:8443", "https://127.0.0.1:8443", "https://169.254.169.254",
    "https://public.example", "https://8.8.8.8", "https://user:pass@10.0.0.7",
    "https://10.0.0.7/path", "https://10.0.0.7?redirect=1",
  ]) assert.throws(() => load([{ ...node, upstream }]), /private HTTPS origin/);
  assert.throws(() => load([{ ...node, id: "local" }]), /non-local/);
  assert.throws(() => load([node, node]), /unique/);
  assert.throws(() => load([{ ...node, tlsServerName: "" }]), /TLS hostname/);
});

test("VNet metadata is opt-in and reveals no private target or credentials; per-user ACLs apply", async (t) => {
  const { url, seen } = await start(t);
  const response = await fetch(`${url}/api/client-nodes`, { headers: { cookie: "owner-a" } });
  const body = await response.json();
  assert.equal(body.directMode, true);
  assert.deepEqual(body.connectionModes, ["direct", "vnet"]);
  assert.equal(body.nodes[0].proxyEndpoint, null);
  assert.equal(body.nodes[1].proxyEndpoint, "/api/node-data/node-a/usage");
  assert.ok(!JSON.stringify(body).includes("10.0.0.7"));
  assert.ok(!JSON.stringify(body).includes(signingKey));
  const denied = await fetch(`${url}/api/node-data/node-a/usage`, { headers: { cookie: "owner-b" } });
  assert.equal(denied.status, 404);
  assert.equal(seen.length, 0);
});

test("VNet data authenticates with scoped tickets over verified TLS without forwarding portal credentials", async (t) => {
  const { url, seen } = await start(t);
  for (const pathname of ["/usage", "/token-usage?period=day", "/token-usage/daily?period=week", "/token-usage/events?period=month&page=1&page_size=12", "/session-history?state=all&limit=10&q=test", "/session-history/active/session-1"]) {
    const response = await fetch(`${url}/api/node-data/node-a${pathname}`, {
      headers: { cookie: "owner-a", authorization: "Bearer forged", "x-api-key": "forged", "x-codey-workspace-assertion": "forged" },
    });
    assert.equal(response.status, 200, pathname);
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(response.headers.get("set-cookie"), null);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    const request = seen.at(-1);
    assert.equal(request.url, `https://10.0.0.7:8443${pathname}`);
    assert.equal(request.options.rejectUnauthorized, true);
    assert.equal(request.options.servername, "node-a.example.test");
    assert.equal(request.options.ca, "test-ca");
    assert.deepEqual(Object.keys(request.options.headers).sort(), ["accept", "authorization"]);
    const claims = verifyClientTicket({
      signingKey, token: request.options.headers.authorization.slice(7), nodeId: "node-a",
    });
    assert.equal(claims.principalId, "owner-a");
    assert.deepEqual(claims.scopes, [pathname.startsWith("/session-history") ? "history" : "usage"]);
    assert.equal(claims.expiresAt - claims.issuedAt, 60000);
  }
  const head = await fetch(`${url}/api/node-data/node-a/usage`, { method: "HEAD", headers: { cookie: "owner-a" } });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
});

test("VNet data refuses mutations, unknown nodes, path tricks and arbitrary/duplicate query parameters", async (t) => {
  const { url, seen } = await start(t);
  for (const pathname of [
    "/local/usage", "/other/usage", "/node-a/admin/config", "/node-a/responses",
    "/node-a/session-history/active/session-1/archive", "/node-a//evil.example/usage",
    "/node-a/%2e%2e%2fadmin/config", "/node-a/usage?url=https://evil.example",
    "/node-a/token-usage?period=day&period=month",
  ]) {
    const result = await fetch(`${url}/api/node-data${pathname}`, { headers: { cookie: "owner-a" } });
    assert.ok([400, 404].includes(result.status), `${pathname}: ${result.status}`);
  }
  const mutation = await fetch(`${url}/api/node-data/node-a/usage`, {
    method: "POST", headers: { cookie: "owner-a" },
  });
  assert.equal(mutation.status, 405);
  assert.equal(seen.length, 0);
});

test("VNet gateway fails closed on redirects, invalid TLS/JSON, oversized bodies and timeouts", async (t) => {
  for (const [reply, options, expected] of [
    [{ status: 302, headers: { location: "https://evil.example/" } }, {}, 502],
    [{ error: "CERT_HAS_EXPIRED" }, {}, 502],
    [{ status: 401 }, {}, 502],
    [{ status: 404 }, {}, 404],
    [{ headers: { "content-type": "text/html" }, body: "<html/>" }, {}, 502],
    [{ body: "not JSON" }, {}, 502],
    [{ headers: { "content-length": "1000" } }, { maxResponseBytes: 50 }, 502],
    [{ body: JSON.stringify({ large: "x".repeat(500) }) }, { maxResponseBytes: 50 }, 502],
    [{ hang: true }, { timeoutMs: 30 }, 504],
  ]) {
    const { url, seen, gateway } = await start(t, reply, options);
    const response = await fetch(`${url}/api/node-data/node-a/usage`, { headers: { cookie: "owner-a" } });
    assert.equal(response.status, expected);
    assert.equal(seen.length, 1);
    assert.equal(gateway.activeRequests, 0);
    const body = await response.text();
    assert.ok(!body.includes("evil.example") && !body.includes(signingKey));
  }
});
