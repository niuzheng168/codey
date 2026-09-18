import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, readFile, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  PLATFORMS, REGISTRATION_FILE, registrationDocument, validateRegistration, verifyRegistrationFile, writeRegistration,
} from "../skills/config-new-codey-machine/scripts/registration.mjs";
import { parseTunnelJson } from "../skills/config-new-codey-machine/scripts/windows-runtime.mjs";
import { machineRegistration } from "../src/machine-registration.mjs";
import { registrationFixture } from "./helpers/registration-fixture.mjs";

const run = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const document = f => registrationDocument(f.setup, f.identity, f.coordinates, f.token, f.certificate, "fixture-machine");

test("all native platforms generate the same complete Portal-accepted schema, not a placeholder", async t => {
  const f = await registrationFixture(t);
  for (const platform of PLATFORMS) {
    const value = document({ ...f, setup: { ...f.setup, platform } });
    assert.equal(machineRegistration(value, { portalOrigin: f.setup.portalOrigin, platform }).machine.platform, platform);
    assert.equal(value.machine.nodeId, f.identity.nodeId);
    assert.equal(value.package.platform, value.machine.platform);
    assert.doesNotMatch(JSON.stringify(value), /PRIVATE KEY/);
    if (process.platform !== "win32") {
      const output = path.join(f.home, REGISTRATION_FILE);
      await writeRegistration(output, value);
      assert.equal((await stat(output)).mode & 0o777, 0o600);
      const result = await verifyRegistrationFile(output, { platform });
      assert.equal(result.platform, platform);
      assert.equal(result.file, output);
      assert.equal(machineRegistration(JSON.parse(await readFile(output)), value.package).machine.id, f.identity.nodeId);
    }
  }
});

test("export validation rejects missing credentials, fake certificates, stale/other-tunnel tokens and false platforms", async t => {
  const f = await registrationFixture(t);
  const value = document(f);
  for (const mutate of [
    value => { value.credentials = {}; },
    value => { value.credentials.updaterCredential = value.credentials.clientSigningKey; },
    value => { value.credentials.workspaceSsoKey = "not-a-key"; },
    value => { value.machine.tlsCertificate = "PUBLIC CERT PLACEHOLDER"; },
    value => { value.machine.platform = "windows-x64"; },
    value => { value.machine.devTunnel.tunnelId = "other"; },
    value => { value.devTunnelConnectToken = ""; },
    value => { value.package.portalOrigin = "https://codey.example.test/path"; },
    value => { value.machine.nodeId = "n-" + "f".repeat(24); },
    value => { value.tlsPrivateKey = "never-allowed"; },
    value => {
      const claims = JSON.parse(Buffer.from(value.devTunnelConnectToken.split(".")[1], "base64url"));
      claims.exp = Math.floor(Date.now() / 1000) - 1;
      value.devTunnelConnectToken = `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.c2ln`;
    },
  ]) {
    const changed = structuredClone(value);
    mutate(changed);
    assert.throws(() => validateRegistration(changed));
    if (process.platform !== "win32") {
      const output = path.join(f.home, REGISTRATION_FILE);
      await writeRegistration(output, value);
      const before = await readFile(output);
      await assert.rejects(writeRegistration(output, changed));
      assert.deepEqual(await readFile(output), before, "A failed export must not replace the previous real registration");
    }
  }
  assert.throws(() => validateRegistration(value, { platform: "windows-x64" }));
  assert.throws(() => validateRegistration(value, { portalOrigin: "https://different.example.test" }));
});

test("registration export never follows a symlink and verification rejects readable-by-others files", {
  skip: process.platform === "win32",
}, async t => {
  const f = await registrationFixture(t);
  const output = path.join(f.home, REGISTRATION_FILE), sentinel = path.join(f.home, "unrelated");
  await writeFile(sentinel, "do not change");
  await symlink(sentinel, output);
  await assert.rejects(writeRegistration(output, document(f)), /linked/);
  assert.equal(await readFile(sentinel, "utf8"), "do not change");
  const other = path.join(f.home, "other.json");
  await writeRegistration(other, document(f));
  await chmod(other, 0o644);
  await assert.rejects(verifyRegistrationFile(other), /only by the owner/);
});

test("native DevTunnel JSON parsing accepts the CLI banner and fails without disclosing tokens", () => {
  const value = { token: "do-not-log" };
  for (const prefix of ["", "\ufeff", "Welcome to dev tunnels!\n\n", "Warning: {not JSON}\n"]) {
    assert.deepEqual(parseTunnelJson(prefix + JSON.stringify(value)), value);
  }
  for (const source of ["", "[]", '{"token":"do-not-log",}', '{"token":"do-not-log"}\n{}']) {
    assert.throws(() => parseTunnelJson(source), error => error.message === "DevTunnel did not return a valid JSON object");
  }
});

test("the shared Linux registration command verifies auth, writes a private JSON, and never auto-registers with Portal", {
  skip: process.platform !== "linux",
}, async t => {
  const f = await registrationFixture(t);
  for (const [name, value] of [["setup.json", f.setup], ["identity.json", f.identity],
    ["tunnel.json", { ...f.coordinates, ports: [3001, 8443].map(portNumber => ({ portNumber, protocol: "https" })) }]]) {
    await writeFile(path.join(f.home, name), JSON.stringify(value), { mode: 0o600 });
  }
  const tunnel = path.join(f.home, "devtunnel");
  await writeFile(tunnel, `#!/bin/sh\nprintf '%s\\n' '{"token":"${f.token}"}'\n`, { mode: 0o700 });
  const config = { schema: 2, kind: "codey-linux-oneclick", layout: "npm-codey-package", platform: "linux-x64",
    ownerHome: f.home, computer: "fixture-machine", identityFile: path.join(f.home, "identity.json"),
    setupFile: path.join(f.home, "setup.json"), tunnelFile: path.join(f.home, "tunnel.json"),
    certificate: path.join(f.home, "cert.pem"), serverName: f.identity.nodeId + ".nodes.codey.internal",
    modelKey: "fixture-model-key", devtunnelExe: tunnel };
  const file = path.join(f.home, "runtime.json"), preload = path.join(f.home, "local-only.cjs");
  await writeFile(file, JSON.stringify(config), { mode: 0o600 });
  await writeFile(preload, `
const {EventEmitter} = require("node:events");
const local = (options, callback) => {
  if (options.hostname !== "127.0.0.1" || options.method === "POST") throw new Error("Unexpected remote registration request");
  const req = new EventEmitter(); req.setTimeout = () => req;
  req.end = () => {
    const response = new EventEmitter();
    const auth = options.headers?.authorization || options.headers?.["x-codey-workspace-assertion"];
    response.statusCode = auth && !process.env.CODEY_TEST_AUTH_FAIL ? 200 : 401;
    callback(response); process.nextTick(() => { response.emit("data", Buffer.from('{"data":[]}')); response.emit("end"); });
  }; return req;
};
require("node:http").request = local; require("node:https").request = local;
`);
  const helper = path.join(root, "skills/config-new-codey-machine/scripts/windows-runtime.mjs");
  const env = { ...process.env, NODE_OPTIONS: `--require=${preload}` };
  await run(process.execPath, [helper, "registration", file], { env });
  const output = path.join(f.home, REGISTRATION_FILE);
  assert.equal((await verifyRegistrationFile(output, f.setup)).nodeId, f.identity.nodeId);
  const original = await readFile(output);
  await assert.rejects(run(process.execPath, [helper, "registration", file], { env: { ...env, CODEY_TEST_AUTH_FAIL: "1" } }));
  assert.deepEqual(await readFile(output), original, "Failed auth must not overwrite the existing registration");
});
