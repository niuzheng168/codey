import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { assertion, dataTicket, probeNative } from "../packages/codey/lib/update-probe.mjs";
import { verifyClientTicket } from "../src/client-ticket.mjs";

const identity = {
  nodeId: "n-" + "a".repeat(24), workspaceSubject: "m-" + "b".repeat(24),
  workspaceUsername: "owner", workspaceSsoKey: randomBytes(32).toString("base64url"),
  clientSigningKey: randomBytes(32).toString("base64url"),
};

test("local maintenance GETs use the existing SSO and data-ticket contracts, not model credentials", () => {
  const target = "/api/providers/sessions/running";
  const [payload, signature] = assertion(identity, target).split(".");
  assert.equal(signature, createHmac("sha256", Buffer.from(identity.workspaceSsoKey, "base64url"))
    .update(payload).digest("base64url"));
  const claims = JSON.parse(Buffer.from(payload, "base64url"));
  assert.equal(claims.path, target);
  assert.equal(claims.method, "GET");
  assert.equal(claims.sub, identity.workspaceSubject);
  const principal = verifyClientTicket({
    signingKey: identity.clientSigningKey, token: dataTicket(identity), nodeId: identity.nodeId, requiredScope: "usage",
  });
  assert.equal(principal.principalId, identity.workspaceSubject);
});

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codey-readonly-probe-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = {
    nodeId: identity.nodeId, identityFile: path.join(directory, "identity.json"),
    certificate: path.join(directory, "certificate.pem"), serverName: "localhost",
    portalOrigin: "https://codey.example.test", modelKey: "fixture-existing-model-key-" + "x".repeat(32),
  };
  await writeFile(config.identityFile, JSON.stringify(identity));
  await promisify(execFile)("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-noenc", "-days", "1", "-subj", "/CN=localhost",
    "-addext", "subjectAltName=DNS:localhost", "-keyout", path.join(directory, "key.pem"), "-out", config.certificate,
  ]);
  const requests = [];
  const get = async options => {
    assert.equal(options.hostname, "127.0.0.1");
    requests.push(options);
    if (options.protocol === "https:") {
      assert.equal(options.rejectUnauthorized, true);
      assert.equal(options.servername, "localhost");
      assert.ok(options.ca.length > 0);
    }
    if (options.path === "/api/providers/sessions/running") {
      assert.ok(options.headers["x-codey-workspace-assertion"]);
      return { status: 200, body: '{"data":{"sessions":[]}}' };
    }
    if (options.path === "/models") return {
      status: options.headers.authorization === "Bearer " + config.modelKey ? 200 : 401, body: '{"data":[]}',
    };
    if (options.path === "/api/auth/status") return { status: 401, body: "{}" };
    if (options.port === 8443) {
      if (!options.headers.authorization) return { status: 401, body: "{}" };
      verifyClientTicket({
        signingKey: identity.clientSigningKey, token: options.headers.authorization.slice(7),
        nodeId: identity.nodeId, requiredScope: "usage",
      });
      return { status: 200, body: '{"events":[]}' };
    }
    assert.equal(options.path, "/health");
    return { status: 200, body: '{"version":"2.0.0"}' };
  };
  return { config, requests, get };
}

test("native readiness covers Workspace, model gateway and TLS data gateway using only local GETs", async t => {
  const f = await fixture(t);
  const result = await probeNative(f.config, { version: "2.0.0", get: f.get });
  assert.equal(result.healthy, true);
  assert.equal(result.modelRequests, false);
  assert.deepEqual([...new Set(f.requests.map(options => options.port))].sort(), [3001, 4141, 8443]);
  assert.ok(f.requests.every(options => !options.method || options.method === "GET"));
  assert.ok(f.requests.every(options => !/responses|chat|completions/.test(options.path)));
  await assert.rejects(probeNative(f.config, { version: "3.0.0", get: f.get }), /version differs/);
});

test("busy/unknown activity and broken data authentication fail closed without any model send", async t => {
  const f = await fixture(t);
  await assert.rejects(probeNative(f.config, { idle: true, get: async () => ({
    status: 200, body: '{"data":{"sessions":[{"id":"active"}]}}',
  }) }), /busy/);
  await assert.rejects(probeNative(f.config, { idle: true, get: async () => ({
    status: 200, body: '{"data":{}}',
  }) }), /Unknown Workspace activity/);
  await assert.rejects(probeNative(f.config, { get: options => options.port === 8443
    ? Promise.resolve({ status: 200, body: "{}" }) : f.get(options) }), /Data gateway authentication/);
  assert.equal(f.requests.some(options => options.method === "POST"), false);
});
