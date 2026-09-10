import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, createHmac, randomBytes, X509Certificate } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { verifyMachine } from "../src/machine-verification.mjs";
import { verifyClientTicket } from "../src/client-ticket.mjs";
import { workspaceNodeKey } from "../src/workspace-sso.mjs";
import { machineServerName } from "../src/machine-identity.mjs";

test("actual TLS probes require the pinned node, correct owner/tickets, anonymous denial and a real WebSocket upgrade", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codey-machine-tls-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const id = `n-${randomBytes(12).toString("hex")}`;
  const dns = machineServerName(id);
  await promisify(execFile)("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-noenc", "-days", "1",
    "-keyout", path.join(root, "key.pem"), "-out", path.join(root, "cert.pem"), "-subj", `/CN=${dns}`,
    "-addext", `subjectAltName=DNS:${dns}`, "-addext", "basicConstraints=critical,CA:FALSE",
  ]);
  const cert = await readFile(path.join(root, "cert.pem"), "utf8");
  const key = await readFile(path.join(root, "key.pem"), "utf8");
  const master = randomBytes(32).toString("base64url");
  const clientKey = randomBytes(32).toString("base64url");
  const principal = { id: "test-machine-owner", name: "alice", sessionId: randomBytes(32).toString("hex"), expiresAt: Date.now() + 600000 };
  const nodeKey = Buffer.from(workspaceNodeKey(master, id), "base64url");
  const machine = { id, tlsServerName: dns, ca: cert, fingerprint: new X509Certificate(cert).fingerprint256, privateIp: "10.42.0.4" };
  let anonymousAllowed = false;
  let badWebsocket = false;
  let usageStatus = 200, usageBody = { ok: true }, tokensStatus = 200, tokensBody = { totals: {} };
  let anonymousTokensAllowed = false;
  let relayNodeId = id;
  let dataService = "relay";
  let requests = 0;
  const sso = (req) => {
    try {
      const [payload, signature] = req.headers["x-codey-workspace-assertion"].split(".");
      const expected = createHmac("sha256", nodeKey).update(payload).digest("base64url");
      const claims = JSON.parse(Buffer.from(payload, "base64url"));
      return expected === signature && claims.aud === id && claims.sub === principal.id &&
        claims.path === req.url && claims.method === req.method && claims.username === principal.name;
    } catch { return false; }
  };
  const server = https.createServer({ cert, key }, (req, res) => {
    requests++;
    assert.equal(req.headers.cookie, undefined);
    let allowed = false;
    if (req.url === "/healthz") allowed = true;
    else if (req.url === "/api/auth/status") allowed = sso(req);
    else {
      try {
        allowed = verifyClientTicket({
          signingKey: clientKey, nodeId: id, token: String(req.headers.authorization ?? "").slice(7),
          requiredScope: req.url.startsWith("/session-history") ? "history" : "usage",
        }).principalId === principal.id;
      } catch { /* Expected for the negative control. */ }
    }
    const status = allowed || anonymousAllowed || (req.url === "/token-usage" && anonymousTokensAllowed)
      ? req.url === "/usage" ? usageStatus : req.url === "/token-usage" ? tokensStatus : 200 : 401;
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(req.url === "/api/auth/status"
      ? { managedAuthentication: true, needsSetup: false, user: { username: "alice" } }
      : req.url === "/healthz" ? { ok: true, nodeId: relayNodeId, ...(dataService === "relay"
        ? { relay: "codey-node-relay" } : { service: dataService }) }
      : req.url === "/usage" ? usageBody : req.url === "/token-usage" ? tokensBody : { ok: true }));
  });
  const sockets = new Set();
  server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  server.on("upgrade", (req, socket) => {
    requests++;
    assert.equal(req.headers.cookie, undefined);
    if (!sso(req)) { socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n"); return; }
    const accept = badWebsocket ? "invalid" : createHash("sha1")
      .update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { for (const socket of sockets) socket.destroy(); server.close(); });
  const requestImpl = (target, options, callback) => {
    assert.ok(["8443", "3001"].includes(target.port));
    assert.ok(["10.42.0.4", "127.0.0.1"].includes(target.hostname));
    assert.equal(options.rejectUnauthorized, true);
    return https.request(`https://127.0.0.1:${server.address().port}${target.pathname}${target.search}`, options, callback);
  };
  const options = { master, clientKey, principal, requestImpl, timeoutMs: 2000 };
  const verified = await verifyMachine(machine, options);
  assert.equal(verified.websocket, true);
  assert.equal(verified.anonymousDenied, true);
  assert.equal(requests, 7);
  const before = requests;
  await assert.rejects(verifyMachine({ ...machine, tlsServerName: "wrong.nodes.codey.internal" }, options), { status: 502 });
  assert.equal(requests, before, "Wrong SAN must be rejected during TLS, before any HTTP credentials are sent");
  await assert.rejects(verifyMachine({ ...machine, fingerprint: "00:".repeat(32).slice(0, -1) }, options), { status: 502 });
  assert.equal(requests, before, "A valid CA/SAN is insufficient when the enrolled leaf fingerprint differs");
  await assert.rejects(verifyMachine(machine, { ...options, clientKey: "wrong-key-".repeat(5) }), { status: 502 });
  anonymousAllowed = true;
  await assert.rejects(verifyMachine(machine, options), { status: 502 });
  anonymousAllowed = false;
  badWebsocket = true;
  await assert.rejects(verifyMachine(machine, options), { status: 502 });
  badWebsocket = false;

  // Exercise the DevTunnel path against actual TLS HTTP/WS fixtures, with only
  // the transport adapter substituted; no real tunnel or protected port is used.
  const tunnelMachine = { ...machine, networkMode: "devtunnel", devTunnel: { tunnelId: "fixture", clusterId: "jpe1" } };
  const tunnelOptions = { ...options, getTunnelToken: async () => "fixture-only", tunnelTransportFactory: () => {
    const agent = new https.Agent();
    return { agent, dispose: async () => agent.destroy() };
  } };
  for (const [status, body] of [[500, { error: "Failed to fetch Copilot usage" }], [503, {}],
    [404, {}], [429, {}], [200, null]]) {
    usageStatus = status; usageBody = body;
    const result = await verifyMachine(tunnelMachine, tunnelOptions);
    assert.equal(result.usage, false);
    assert.equal(result.tokenUsage, true);
    assert.equal(result.usageHttpStatus, status);
    assert.equal(result.websocket, true);
    assert.deepEqual(result.warnings, ["copilot_quota_unavailable_model_inference_not_tested"]);
  }
  usageStatus = 200; usageBody = null;
  dataService = "copilot-api-codey-https";
  const linux = { ...tunnelMachine, platform: "linux-x64" };
  const linuxResult = await verifyMachine(linux, tunnelOptions);
  assert.equal(linuxResult.usage, false);
  assert.equal(linuxResult.tokenUsage, true);
  assert.equal(linuxResult.websocket, true);
  await assert.rejects(verifyMachine({ ...linux, platform: "windows-x64" }, tunnelOptions), { status: 502 });
  relayNodeId = "wrong-linux-node";
  await assert.rejects(verifyMachine(linux, tunnelOptions), { status: 502 });
  relayNodeId = id;
  dataService = "unrecognized-gateway";
  await assert.rejects(verifyMachine(linux, tunnelOptions), { status: 502 });
  dataService = "relay";
  assert.equal((await verifyMachine(machine, options)).usage, true, "Preserve headless VNet HTTP 200 behavior");
  usageStatus = 500; usageBody = { error: "quota unavailable" };
  await assert.rejects(verifyMachine(machine, options), { status: 502 }, "VNet behavior is not relaxed");
  await assert.rejects(verifyMachine(tunnelMachine, { ...tunnelOptions, clientKey: "wrong-key-".repeat(5) }), { status: 502 });
  await assert.rejects(verifyMachine({ ...tunnelMachine, tlsServerName: "wrong.nodes.codey.internal" }, tunnelOptions), { status: 502 });
  relayNodeId = "other-node";
  await assert.rejects(verifyMachine(tunnelMachine, tunnelOptions), { status: 502 });
  relayNodeId = id;
  for (const status of [401, 403, 302]) {
    usageStatus = status;
    await assert.rejects(verifyMachine(tunnelMachine, tunnelOptions), { status: 502 });
  }
  usageStatus = 500;
  for (const [status, body] of [[401, {}], [403, {}], [500, {}], [200, null], [200, []], [200, { error: "bad" }]]) {
    tokensStatus = status; tokensBody = body;
    await assert.rejects(verifyMachine(tunnelMachine, tunnelOptions), { status: 502 });
  }
  tokensStatus = 200; tokensBody = { totals: {} }; anonymousTokensAllowed = true;
  await assert.rejects(verifyMachine(tunnelMachine, tunnelOptions), { status: 502 });
  anonymousTokensAllowed = false; badWebsocket = true;
  await assert.rejects(verifyMachine(tunnelMachine, tunnelOptions), { status: 502 });
});
