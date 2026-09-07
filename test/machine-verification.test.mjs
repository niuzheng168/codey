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
    res.writeHead(allowed || anonymousAllowed ? 200 : 401, { "content-type": "application/json" });
    res.end(JSON.stringify(req.url === "/api/auth/status"
      ? { managedAuthentication: true, needsSetup: false, user: { username: "alice" } } : { ok: true }));
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
    assert.equal(target.hostname, "10.42.0.4");
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
});
