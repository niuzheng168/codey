import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { machineFixture } from "./helpers/machine-installer-fixture.mjs";
import { treeFiles } from "./codey-update-fixture.mjs";

for (const platform of ["linux-x64", "windows-x64", "macos-arm64", "macos-x64"]) {
  test(`shared ${platform}: read-only preflight, fresh installation and acceptance-only rerun`, { skip: process.platform === "win32" }, async t => {
    const f = await machineFixture(t, platform), before = await treeFiles(f.home);
    const plan = await f.installer.apply({ check: true, "codex-home": f.options["codex-home"] });
    assert.equal(plan.mode, "check");
    assert.equal(plan.automaticRegistration, false);
    assert.ok(plan.deferred.includes("TLS/SSO/model response"));
    assert.deepEqual(await treeFiles(f.home), before);
    assert.ok(!f.calls.some(call => call.file.includes("curl") || call.args.includes("exec")));
    const config = await f.installer.apply(f.options);
    const files = [config.identityFile, config.certificate, path.join(config.codexHome, "config.toml"),
      path.join(config.environment.COPILOT_API_HOME, "config.json")];
    const original = await Promise.all(files.map(file => readFile(file)));
    const registration = JSON.parse(await readFile(path.join(f.home, "codey-machine-registration.json")));
    assert.equal(registration.machine.platform, platform);
    assert.equal(Object.keys(registration.credentials).length, 5);
    assert.equal(registration.credentials.updaterCredential, undefined);
    const resourcesFile = path.join(f.installer.configRoot, "resources.json");
    const resources = JSON.parse(await readFile(resourcesFile));
    assert.equal(resources.schema, 1);
    assert.ok(resources.programs.every(item => item.path !== config.runtimeRoot));
    assert.ok(resources.preserve.some(item => item.path === config.codexHome));
    assert.equal(resources.cloud.deleteTunnel, false);
    assert.equal(resources.cloud.deletePortalRecord, false);
    assert.equal(resources.uninstallImplemented, false);
    assert.equal((await stat(resourcesFile)).mode & 0o777, 0o600);
    const identity = JSON.parse(original[0]);
    for (const value of [config.modelKey, identity.workspaceSsoKey, identity.clientSigningKey, identity.tunnelUpdateKey]) {
      assert.ok(!JSON.stringify(resources).includes(value), "An inventory is not a credential backup");
    }
    f.calls.length = 0; f.native.length = 0;
    await f.installer.apply(f.options);
    assert.deepEqual(await Promise.all(files.map(file => readFile(file))), original);
    assert.ok(!f.calls.some(call => call.file.includes("curl") || call.args[0] === "exec" ||
      call.args[0] === "bootstrap" || call.args[1] === "copilot" && call.args[2] === "login" || call.args[1] === "sdk-probe"));
    assert.ok(!f.native.includes("start") && !f.native.includes("stop"));
    assert.deepEqual(f.calls.filter(call => call.args[0]?.endsWith("windows-runtime.mjs")).map(call => call.args[1]), ["registration"]);
    assert.deepEqual(JSON.parse(await readFile(resourcesFile)), resources);
  });

  test(`shared ${platform}: foreign port race after login stops before starting services or exporting JSON`, { skip: process.platform === "win32" }, async t => {
    const f = await machineFixture(t, platform);
    f.occupyAfterAuth = true;
    await assert.rejects(f.installer.apply(f.options), /foreign or unverified listener/);
    assert.ok(!f.native.includes("start"));
    assert.ok(!f.calls.some(call => call.args[0] === "bootstrap"));
    await assert.rejects(stat(path.join(f.home, "codey-machine-registration.json")), { code: "ENOENT" });
    const inventory = JSON.parse(await readFile(path.join(f.installer.configRoot, "resources.json")));
    assert.equal(inventory.state, "failed");
    assert.ok(inventory.services.every(item => item.ownership !== "verified"));
  });
}
