import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";
import {
  validateTunnel, validateConnectToken, clientTicket, workspaceAssertion, registrationDocument,
} from "../skills/config-new-codey-machine/scripts/windows-runtime.mjs";
import { verifyClientTicket } from "../src/client-ticket.mjs";

const run = promisify(execFile);
const coordinates = { tunnelId: "codey-n-" + "a".repeat(24), clusterId: "jpe1" };
const tunnel = () => ({ ...coordinates, ports: [
  { portNumber: 3001, protocol: "https" }, { portNumber: 8443, protocol: "https" },
] });
const now = 1800000000000;
const token = (changes = {}) => `e30.${Buffer.from(JSON.stringify({
  ...coordinates, scp: "connect", exp: now / 1000 + 72000, ...changes,
})).toString("base64url")}.c2ln`;
const identity = {
  nodeId: "n-" + "a".repeat(24), workspaceSubject: "m-" + "b".repeat(24), workspaceUsername: "owner",
  clientSigningKey: "c".repeat(43), workspaceSsoKey: "d".repeat(43),
  tunnelUpdateKey: "e".repeat(43), updaterCredential: "f".repeat(43),
};

test("Windows one-click installer, command and watchdog native lifecycle regressions", { timeout: 400000 }, async () => {
  const result = await run(process.env.PYTHON || (process.platform === "win32" ? "python" : "python3"), [
    "-X", "utf8", "-I", "-B", "test/test_windows_oneclick.py",
  ], { timeout: 390000, windowsHide: true, maxBuffer: 1024 * 1024 });
  assert.match(result.stderr, /OK/);
});

test("Windows installer accepts only its exact private HTTPS tunnel", () => {
  assert.deepEqual(validateTunnel(tunnel(), coordinates.tunnelId), coordinates);
  assert.deepEqual(validateTunnel({ tunnel: { ...tunnel(), tunnelId: `${coordinates.tunnelId}.jpe1` } },
    coordinates.tunnelId), coordinates);
  const invalid = [
    { ...tunnel(), tunnelId: "other" }, { ...tunnel(), clusterId: "../bad" },
    { ...tunnel(), tunnelId: `${coordinates.tunnelId}.other` },
    { ...tunnel(), ports: [...tunnel().ports, { portNumber: 4141, protocol: "https" }] },
    { ...tunnel(), ports: [{ portNumber: 3001, protocol: "http" }, tunnel().ports[1]] },
    { ...tunnel(), accessControl: { entries: [{ type: "anonymous", isDeny: false }] } },
    { ...tunnel(), accessControl: { unknown: true } },
    { ...tunnel(), ports: [tunnel().ports[0], { ...tunnel().ports[1], accessControl: [{ type: "Anonymous" }] }] },
  ];
  for (const value of invalid) assert.throws(() => validateTunnel(value, coordinates.tunnelId));
});

test("Windows renewal rejects wrong-scope, other-tunnel, expired and oversized-lifetime credentials", () => {
  assert.equal(validateConnectToken({ token: token() }, coordinates, now), token());
  for (const changes of [
    { scp: "host" }, { scp: "connect manage" }, { tunnelId: "other" }, { clusterId: "other" },
    { exp: now / 1000 + 10 }, { exp: now / 1000 + 172800 }, { exp: "future" },
  ]) assert.throws(() => validateConnectToken({ token: token(changes) }, coordinates, now));
  assert.throws(() => validateConnectToken({ token: "not-a-token" }, coordinates, now));
});

test("Windows local data/SSO probes use the existing gateway authentication protocols", () => {
  const ticket = clientTicket(identity, now);
  const principal = verifyClientTicket({
    signingKey: identity.clientSigningKey, token: ticket, nodeId: identity.nodeId, requiredScope: "usage", now,
  });
  assert.equal(principal.principalId, identity.workspaceSubject);
  const assertion = workspaceAssertion(identity, "/api/auth/status", now);
  const [payload, signature] = assertion.split(".");
  assert.equal(signature, createHmac("sha256", Buffer.from(identity.workspaceSsoKey, "base64url"))
    .update(payload).digest("base64url"));
  const claims = JSON.parse(Buffer.from(payload, "base64url"));
  assert.equal(claims.path, "/api/auth/status");
  assert.equal(claims.method, "GET");
  assert.equal(claims.exp - claims.iat, 20);
  assert.match(claims.sid, /^[a-f0-9]{64}$/);
  assert.match(claims.nonce, /^[A-Za-z0-9_-]{22}$/);
});

test("Windows registration is explicitly private schema 2 and never contains the TLS private key", () => {
  const setup = { platform: "windows-x64", portalOrigin: "https://codey.example.test", releaseId: "machine-" + "a".repeat(16) };
  const result = registrationDocument(setup, identity, coordinates, token(), "PUBLIC CERT", "fixture-pc");
  assert.equal(result.schema, 2);
  assert.equal(result.machine.platform, "windows-x64");
  assert.equal(result.machine.tlsCertificate, "PUBLIC CERT");
  assert.equal(result.credentials.clientSigningKey, identity.clientSigningKey);
  assert.equal(result.devTunnelConnectToken, token());
  assert.ok(!("tlsPrivateKey" in result));
  assert.throws(() => registrationDocument({ ...setup, platform: "linux-x64" }, identity, coordinates, token(), "", ""));
});

test("Windows implementation never invokes WSL, systemd or firewall commands", async () => {
  for (const name of ["install.ps1", "windows-common.ps1", "windows-service.ps1", "windows-command.ps1"]) {
    const script = await readFile(new URL(`../skills/config-new-codey-machine/scripts/${name}`, import.meta.url), "utf8");
    assert.doesNotMatch(script, /(?:^|\n)\s*(?:wsl(?:\.exe)?|sudo|systemctl|New-NetFirewallRule|Set-NetFirewallProfile)\b/i);
    assert.doesNotMatch(script, /-ExecutionPolicy\s+Bypass|Set-ExecutionPolicy|Invoke-Expression/);
  }
  const installer = await readFile(
    new URL("../skills/config-new-codey-machine/scripts/install.ps1", import.meta.url), "utf8");
  assert.match(installer, /npm-cli\.js[\s\S]*'install'[\s\S]*--global[\s\S]*--prefix/);
  assert.match(installer, /npm-codey-package/);
  assert.doesNotMatch(installer, /assets[\\/](?:cloudcli|copilot-api)\.zip|Expand-CodeyZip[^]*component\.zip/);
});
