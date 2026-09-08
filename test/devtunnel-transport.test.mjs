import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, createHmac, randomBytes, X509Certificate } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Duplex } from "node:stream";
import test from "node:test";
import { promisify } from "node:util";
import { CancellationTokenSource } from "@microsoft/dev-tunnels-ssh";
import { CloudCliGateway, resolveCloudCliGatewayConfig } from "../src/cloudcli-gateway.mjs";
import { DevTunnelTransport, normalizeDevTunnel, readDevTunnelConnectToken } from "../src/devtunnel-transport.mjs";
import { nodeTlsOptions } from "../src/machine-identity.mjs";
import { workspaceNodeKey } from "../src/workspace-sso.mjs";

const tunnelConfig = {
  tunnelId: "test-workspace", clusterId: "jpe1", port: 3001,
  connectTokenEnv: "CODEY_TEST_TUNNEL_TOKEN",
};
const fingerprint = "AB:".repeat(32).slice(0, -1);
const originOptions = {
  upstream: new URL("https://localhost:3001"), tlsServerName: "localhost", fingerprint,
};
function token(overrides = {}) {
  return `header.${Buffer.from(JSON.stringify({
    tunnelId: tunnelConfig.tunnelId, clusterId: tunnelConfig.clusterId,
    scp: "connect", exp: Math.floor(Date.now() / 1000) + 86400, ...overrides,
  })).toString("base64url")}.test_signature`;
}

test("tunnel config requires fixed pinned HTTPS and a secret reference, not credentials or arbitrary targets", () => {
  assert.deepEqual(normalizeDevTunnel(tunnelConfig, originOptions), tunnelConfig);
  assert.equal(normalizeDevTunnel(undefined, originOptions), undefined);
  for (const raw of [
    null, [], { ...tunnelConfig, token: "secret" },
    { ...tunnelConfig, managedIdentityClientId: "not-supported" },
    { ...tunnelConfig, tunnelId: "../other" }, { ...tunnelConfig, clusterId: "host.example" },
    { ...tunnelConfig, port: "3001" }, { ...tunnelConfig, port: 0 },
    { ...tunnelConfig, connectTokenEnv: "PATH" },
  ]) assert.throws(() => normalizeDevTunnel(raw, originOptions), /Dev Tunnel Workspace/);
  for (const options of [
    { ...originOptions, upstream: new URL("http://localhost:3001") },
    { ...originOptions, upstream: new URL("https://example.test:3001") },
    { ...originOptions, upstream: new URL("https://localhost:3002") },
    { ...originOptions, fingerprint: "" }, { ...originOptions, tlsServerName: "" },
  ]) assert.throws(() => normalizeDevTunnel(tunnelConfig, options), /Dev Tunnel Workspace/);
  const document = JSON.stringify({
    nodes: [{ id: "local", upstream: originOptions.upstream, tlsServerName: "localhost",
      fingerprint, devTunnel: tunnelConfig }],
  });
  assert.throws(() => resolveCloudCliGatewayConfig(
    { PORTAL_CLOUDCLI_CONFIG: "config.json" }, () => document,
  ), /require node-bound portal SSO/);
});

test("only a live connect-only token for the exact tunnel is accepted, without leaking bad credentials", () => {
  const good = token();
  assert.equal(readDevTunnelConnectToken(tunnelConfig, { CODEY_TEST_TUNNEL_TOKEN: good }), good);
  for (const value of [
    undefined, "", "not-a-token", good + "\n",
    token({ scp: "manage connect" }), token({ scp: "host" }),
    token({ tunnelId: "another-workspace" }), token({ clusterId: "euw1" }),
    token({ exp: 0 }), token({ exp: "9999999999" }),
  ]) {
    assert.throws(() => readDevTunnelConnectToken(tunnelConfig, { CODEY_TEST_TUNNEL_TOKEN: value }),
      error => error.code === "ERR_CODEY_DEV_TUNNEL" && !error.message.includes(value || "DO_NOT_MATCH"));
  }
});

function sdkFixture(port, { metadataError, neverConnect = false, deferRemoteEof = false } = {}) {
  const observed = { clients: [], metadata: [], forwarded: [], connections: 0, sockets: new Set() };
  class Management {
    async getTunnel(reference, options) {
      observed.metadata.push({ reference, options });
      if (metadataError) throw new Error(metadataError);
      return {
        ...reference, endpoints: [{ connectionMode: "TunnelRelay" }],
        ports: [{ portNumber: 3001, protocol: "https" }, { portNumber: 4141, protocol: "https" }],
      };
    }
    async dispose() { observed.managementDisposed = true; }
  }
  class Client {
    constructor() { observed.clients.push(this); this.connectionStatus = "none"; }
    portForwarding(handler) { this.forwarding = handler; }
    refreshingTunnelAccessToken(handler) { this.refreshToken = handler; }
    refreshingTunnel(handler) { this.refreshMetadata = handler; }
    async connect(tunnel, options, cancellation) {
      this.tunnel = tunnel;
      this.options = options;
      if (neverConnect) return new Promise((_, reject) =>
        cancellation.onCancellationRequested(() => reject(new Error("cancelled"))));
      for (const portNumber of [3001, 4141]) {
        const event = { portNumber };
        this.forwarding(event);
        observed.forwarded.push(event);
      }
      this.connectionStatus = "connected";
    }
    async waitForForwardedPort(portNumber) { assert.equal(portNumber, 3001); }
    async connectToForwardedPort(portNumber) {
      assert.equal(portNumber, 3001);
      observed.connections++;
      const socket = net.connect(port, "127.0.0.1");
      observed.sockets.add(socket);
      socket.once("close", () => observed.sockets.delete(socket));
      await once(socket, "connect");
      if (deferRemoteEof) {
        // A relay stream can report the host's idle close only on the next write.
        // Keep it apparently readable to reproduce the stale HTTPS-agent socket.
        const stream = new Duplex({
          read() {},
          write(chunk, encoding, callback) {
            if (socket.destroyed || socket.writableEnded) {
              callback(Object.assign(new Error("Simulated idle relay close"), { code: "ECONNRESET" }));
            } else {
              socket.write(chunk, encoding, callback);
            }
          },
          destroy(error, callback) { socket.destroy(); callback(error); },
        });
        socket.on("data", chunk => stream.push(chunk));
        socket.on("error", error => stream.destroy(error));
        observed.sockets.add(stream);
        stream.once("close", () => observed.sockets.delete(stream));
        return stream;
      }
      return socket;
    }
    async dispose() {
      this.connectionStatus = "disconnected";
      this.disposed = true;
      for (const socket of observed.sockets) socket.destroy();
    }
  }
  return {
    observed,
    sdkFactory: async () => ({
      TunnelManagementHttpClient: Management, TunnelRelayTunnelClient: Client,
      ManagementApiVersions: { Version20230927preview: "test" }, CancellationTokenSource,
    }),
  };
}

async function tlsFixture(t) {
  const prefix = path.join(os.tmpdir(), "codey-devtunnel-test-");
  const root = await mkdtemp(prefix);
  t.after(async () => {
    assert.ok(path.resolve(root).startsWith(path.resolve(prefix)) && path.dirname(root) === os.tmpdir());
    await rm(root, { recursive: true, force: true });
  });
  await promisify(execFile)("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-noenc", "-days", "1",
    "-keyout", path.join(root, "key.pem"), "-out", path.join(root, "cert.pem"),
    "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost",
    "-addext", "basicConstraints=critical,CA:FALSE",
  ]);
  const cert = await readFile(path.join(root, "cert.pem"), "utf8");
  const key = await readFile(path.join(root, "key.pem"), "utf8");
  return { cert, key, fingerprint: new X509Certificate(cert).fingerprint256 };
}

async function listen(t, server) {
  const sockets = new Set();
  server.on("connection", socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  t.after(() => { for (const socket of sockets) socket.destroy(); server.close(); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

async function upgrade(port, cookie = "owner") {
  const socket = net.connect(port, "127.0.0.1");
  const output = await new Promise((resolve, reject) => {
    let received = "";
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("test upgrade timeout")); }, 4000);
    socket.on("error", error => { clearTimeout(timer); reject(error); });
    socket.on("data", chunk => {
      received += chunk;
      if (received.includes("\r\n\r\n")) { clearTimeout(timer); resolve(received); }
    });
    socket.write(
      "GET /cloudcli/local/ws?token=attacker HTTP/1.1\r\n" +
      `Host: 127.0.0.1:${port}\r\nOrigin: https://portal.example.test\r\nCookie: ${cookie}\r\n` +
      "Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\n" +
      `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}\r\n\r\n`,
    );
  });
  return { socket, output };
}

test("HTTP and WebSocket use raw TLS tunnel streams, preserve SSO/ownership and never forward portal/tunnel credentials", async t => {
  const fixture = await tlsFixture(t);
  const master = randomBytes(32).toString("base64url");
  const principal = {
    id: "owner-id", name: "alice", sessionId: "a".repeat(64), expiresAt: Date.now() + 600000,
  };
  const observed = [];
  function inspect(req) {
    observed.push({ url: req.url, headers: req.headers });
    assert.equal(req.headers.cookie, undefined);
    assert.equal(req.headers.authorization, undefined);
    assert.equal(req.headers["x-tunnel-authorization"], undefined);
    const [payload, signature] = req.headers["x-codey-workspace-assertion"].split(".");
    assert.equal(signature, createHmac("sha256", Buffer.from(workspaceNodeKey(master, "local"), "base64url"))
      .update(payload).digest("base64url"));
    const claims = JSON.parse(Buffer.from(payload, "base64url"));
    assert.equal(claims.aud, "local");
    assert.equal(claims.sub, principal.id);
    assert.equal(claims.path, req.url);
    assert.equal(claims.method, req.method);
    assert.equal(claims.exp - claims.iat, 20);
  }
  const upstream = https.createServer(fixture, (req, res) => {
    inspect(req);
    res.writeHead(200, { "content-type": "application/json", "set-cookie": "node-secret=never" });
    res.end('{"ok":true}');
  });
  upstream.on("upgrade", (req, socket) => {
    inspect(req);
    const accept = createHash("sha1").update(req.headers["sec-websocket-key"] +
      "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
  });
  const sdk = sdkFixture(await listen(t, upstream));
  const config = resolveCloudCliGatewayConfig({
    PORTAL_CLOUDCLI_CONFIG: "test.json", PORTAL_WORKSPACE_SSO_MASTER: master,
  }, file => file.endsWith(".pem") ? fixture.cert : JSON.stringify({ nodes: [{
    id: "local", upstream: "https://localhost:3001", tlsServerName: "localhost",
    fingerprint: fixture.fingerprint, devTunnel: tunnelConfig,
  }] }));
  const leases = new Set();
  const gateway = new CloudCliGateway(config, {
    sessionAuthenticator: {
      principal: async req => req.headers.cookie === "owner" ? principal : null,
      sameOrigin: req => req.headers.origin === "https://portal.example.test",
      track: (_principal, close) => { leases.add(close); return () => leases.delete(close); },
    },
    nodePolicy: { canAccess: async id => id === principal.id },
    tunnelTransportFactory: (node, ca) => new DevTunnelTransport(node.devTunnel, nodeTlsOptions(node, ca), {
      getToken: () => token(), sdkFactory: sdk.sdkFactory, timeoutMs: 2000,
    }),
  });
  t.after(() => gateway.close());
  const portal = http.createServer((req, res) => {
    req.codeyPrincipal = principal;
    gateway.proxyHttp(req, res, req.headers.cookie === "owner" ? ["local"] : [])
      .catch(() => { res.writeHead(500); res.end(); });
  });
  gateway.attach(portal, async (_req, nodeId) => nodeId === "local");
  const port = await listen(t, portal);
  const url = `http://127.0.0.1:${port}/cloudcli/local/api/projects`;
  assert.equal((await fetch(url)).status, 403);
  assert.equal(sdk.observed.clients.length, 0, "Denied requests must not contact the tunnel");
  const response = await fetch(url + "?token=attacker", {
    headers: { cookie: "owner", authorization: "Bearer attacker", "x-codey-workspace-assertion": "forged" },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(observed[0].url, "/api/projects");
  assert.deepEqual(Object.keys(gateway.publicNodes(["local"])[0]).sort(), ["id", "name", "path", "region"]);
  const denied = await upgrade(port, "another-user");
  assert.match(denied.output, /401 Unauthorized/);
  denied.socket.destroy();
  const connected = await upgrade(port);
  assert.match(connected.output, /101 Switching Protocols/);
  assert.equal(observed.at(-1).url, "/ws");
  const disconnected = once(connected.socket, "close");
  for (const close of leases) close();
  await disconnected;
  assert.equal(sdk.observed.clients.length, 1);
  const client = sdk.observed.clients[0];
  assert.equal(client.acceptLocalConnectionsForForwardedPorts, false);
  assert.equal(client.options.enableRetry, false);
  assert.equal(client.options.enableReconnect, false);
  assert.equal(sdk.observed.forwarded.find(e => e.portNumber === 4141).cancel, true);
  assert.equal(sdk.observed.forwarded.find(e => e.portNumber === 3001).cancel, undefined);
  const refresh = { tunnelAccessScope: "connect" };
  client.refreshToken(refresh);
  assert.equal((await refresh.tunnelAccessToken).split(".").length, 3);
  const forbiddenRefresh = { tunnelAccessScope: "manage" };
  client.refreshToken(forbiddenRefresh);
  assert.equal(await forbiddenRefresh.tunnelAccessToken, null);
});

test("a bad node TLS name or pinned certificate rejects the tunnel before any HTTP credentials are sent", async t => {
  const fixture = await tlsFixture(t);
  let requests = 0;
  const upstream = https.createServer(fixture, (_req, res) => { requests++; res.end("bad"); });
  const port = await listen(t, upstream);
  for (const node of [
    { tlsServerName: "other.example.test", fingerprint: fixture.fingerprint },
    { tlsServerName: "localhost", fingerprint },
  ]) {
    const sdk = sdkFixture(port);
    const transport = new DevTunnelTransport(tunnelConfig, nodeTlsOptions(node, fixture.cert), {
      getToken: () => token(), sdkFactory: sdk.sdkFactory, timeoutMs: 2000,
    });
    t.after(() => transport.dispose());
    await assert.rejects(transport.openTlsSocket(), { code: "ERR_CODEY_DEV_TUNNEL" });
  }
  assert.equal(requests, 0);
});

test("HTTP requests do not reuse idle relay-backed TLS sockets while retaining one tunnel client", async t => {
  const fixture = await tlsFixture(t);
  const upstream = https.createServer(fixture, (req, res) => {
    // Keep the real host's advertised timeout; shorten only the test's idle timer.
    res.setHeader("Keep-Alive", "timeout=5");
    const socket = req.socket;
    res.once("finish", () => setTimeout(() => socket.destroy(), 30).unref());
    res.end("ok");
  });
  const sdk = sdkFixture(await listen(t, upstream), { deferRemoteEof: true });
  const options = nodeTlsOptions({ tlsServerName: "localhost", fingerprint: fixture.fingerprint }, fixture.cert);
  const transport = new DevTunnelTransport(tunnelConfig, options, {
    getToken: () => token(), sdkFactory: sdk.sdkFactory, timeoutMs: 1000,
  });
  t.after(() => transport.dispose());
  const responses = [];
  for (const delay of [0, 100, 100]) {
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    responses.push(await new Promise((resolve, reject) => {
      const req = https.get("https://localhost:3001/health", { ...options, agent: transport.agent }, res => {
        res.resume();
        res.once("end", () => resolve({ status: res.statusCode, reusedSocket: req.reusedSocket }));
      });
      req.setTimeout(1000, () => req.destroy(new Error("Test request deadline")));
      req.once("error", reject);
    }));
  }
  assert.deepEqual(responses, Array.from({ length: 3 }, () => ({ status: 200, reusedSocket: false })));
  assert.equal(sdk.observed.connections, 3, "Each HTTP request uses a new pinned TLS stream");
  assert.equal(sdk.observed.clients.length, 1, "HTTP isolation must not reconnect the underlying relay client");
  assert.equal(Object.keys(transport.agent.freeSockets).length, 0);
});

test("SDK failures are credential-safe and failed or hanging connections are bounded and disposed", async t => {
  for (const options of [{ metadataError: "Authorization: tunnel secret-never-return-this" }, { neverConnect: true }]) {
    const sdk = sdkFixture(1, options);
    const transport = new DevTunnelTransport(tunnelConfig, {
      ca: "unused", servername: "localhost", rejectUnauthorized: true,
    }, { getToken: () => token(), sdkFactory: sdk.sdkFactory, timeoutMs: 50 });
    t.after(() => transport.dispose());
    await assert.rejects(transport.openTlsSocket(), error =>
      error.code === "ERR_CODEY_DEV_TUNNEL" && !error.message.includes("secret-never"));
    await transport.dispose();
    assert.equal(sdk.observed.clients[0].disposed, true);
    assert.equal(sdk.observed.managementDisposed, true);
  }
});
