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

test("the real Linux installer export block writes and validates the private file before reporting success", {
  skip: process.platform !== "linux",
}, async t => {
  const f = await registrationFixture(t);
  const script = await readFile(path.join(root, "skills/config-new-codey-machine/scripts/install.sh"), "utf8");
  const start = script.indexOf('OUTPUT="$HOME_DIR/codey-machine-registration.json"');
  const end = script.indexOf("\nNODE\n", start) + "\nNODE\n".length;
  assert.ok(start > 0 && end > start);
  for (const [name, value] of [
    ["setup.json", f.setup], ["identity.json", f.identity],
    ["tunnel.json", f.coordinates], ["connect-token.json", { token: f.token }],
  ]) await writeFile(path.join(f.home, name), JSON.stringify(value));
  await run("bash", ["-euc", script.slice(start, end)], { env: {
    ...process.env, NODE: process.execPath, ROOT: path.join(root, "skills/config-new-codey-machine"),
    ASSETS: f.home, HOME_DIR: f.home, IDENTITY: path.join(f.home, "identity.json"), CONFIG_ROOT: f.home,
    TOKEN_FILE: path.join(f.home, "connect-token.json"), CERT: path.join(f.home, "cert.pem"),
  } });
  const output = path.join(f.home, REGISTRATION_FILE);
  assert.equal((await verifyRegistrationFile(output, f.setup)).nodeId, f.identity.nodeId);
});
