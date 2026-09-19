import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { machineFixture } from "./helpers/machine-installer-fixture.mjs";
import { installOptions, npmEnvironment } from "../scripts/install-codey-runtime.mjs";

for (const platform of ["linux-x64", "windows-x64", "macos-arm64", "macos-x64"]) {
  test(`${platform}: failed setup resumes verified application and tools in place`, { skip: process.platform === "win32" }, async t => {
    const f = await machineFixture(t, platform);
    f.failVerify = true;
    await assert.rejects(f.installer.apply(f.options), /fixture TLS/);
    const before = JSON.parse(await readFile(f.installer.file));
    const identity = await readFile(before.identityFile);
    const certificate = await readFile(before.certificate);
    f.calls.length = 0;
    f.failVerify = false;
    const after = await f.installer.apply({ ...f.options, "retry-failed": true, "replace-existing": true });
    assert.equal(after.ready, true);
    assert.equal(after.releaseDirectory, before.releaseDirectory);
    assert.deepEqual(await readFile(after.identityFile), identity);
    assert.deepEqual(await readFile(after.certificate), certificate);
    assert.equal((await readdir(path.join(f.installer.root, "releases"))).length, 1);
    assert.ok(!f.calls.some(call => call.file === "/usr/bin/curl" || call.file === "/usr/bin/tar" ||
      call.args[0]?.endsWith("install-runtime.mjs") || call.args.includes("CODEX_RELEASE")));
    assert.ok(!f.calls.some(call => call.file === "/bin/bash" || call.file === "/fixture/powershell.exe"));
    assert.ok(f.calls.some(call => call.args.includes("--runtime-only")));
    assert.ok((JSON.parse(await readFile(path.join(f.installer.configRoot, "install-timings.json")))).stages.length > 0);
  });
}

test("a corrupt prepared runtime is rejected without downloads or a new release", { skip: process.platform === "win32" }, async t => {
  const f = await machineFixture(t, "linux-x64");
  f.failVerify = true;
  await assert.rejects(f.installer.apply(f.options));
  const receipt = JSON.parse(await readFile(path.join(f.installer.configRoot, "prepared.json")));
  await writeFile(receipt.node, "corrupt");
  f.calls.length = 0;
  await assert.rejects(f.installer.apply({ ...f.options, "retry-failed": true, "replace-existing": true }), /Node fingerprint mismatch/);
  assert.ok(!f.calls.some(call => call.file === "/usr/bin/curl"));
  assert.equal((await readdir(path.join(f.installer.root, "releases"))).length, 1);
});

test("invalid GitHub access fails before Codex downloads and service startup", { skip: process.platform === "win32" }, async t => {
  const f = await machineFixture(t, "linux-x64");
  f.failAuthentication = true;
  await assert.rejects(f.installer.apply(f.options), /HTTP 401/);
  assert.ok(!f.native.includes("start"));
  assert.ok(!f.calls.some(call => call.args.includes(f.installer.pins.codex.url)));
});

test("retry verifies saved Copilot credentials before preparing Codex or starting services", { skip: process.platform === "win32" }, async t => {
  const f = await machineFixture(t, "linux-x64");
  f.failVerify = true;
  await assert.rejects(f.installer.apply(f.options), /fixture TLS/);
  const config = JSON.parse(await readFile(f.installer.file));
  await writeFile(path.join(config.environment.COPILOT_API_HOME, "github_token"), "fixture-private-token");
  f.calls.length = 0;
  f.native.length = 0;
  f.failAuthentication = true;
  await assert.rejects(f.installer.apply({ ...f.options, "retry-failed": true, "replace-existing": true }), /HTTP 401/);
  assert.ok(f.calls.some(call => call.args[1] === "copilot" && call.args[2] === "login"));
  assert.ok(!f.native.includes("start"));
  assert.ok(!f.calls.some(call => call.args.includes(f.installer.pins.codex.url)));
});

test("npm registry override isolates user configuration and authentication on every platform", () => {
  const options = installOptions(["--package", "codey-0.1.18.tgz", "--sha256", "a".repeat(64),
    "--registry", "https://mirrors.cloud.tencent.com/npm/"]);
  assert.equal(options.registry, "https://mirrors.cloud.tencent.com/npm");
  for (const registry of ["http://npm.example", "https://user:secret@npm.example", "https://npm.example?q=secret", "https://npm.example/#x"]) {
    assert.throws(() => installOptions(["--package", "codey-0.1.18.tgz", "--sha256", "a".repeat(64), "--registry", registry]));
  }
  const env = npmEnvironment("prefix", process.execPath, options.registry, {
    PATH: "fixture", NPM_CONFIG_USERCONFIG: "private.npmrc", npm_config_registry: "https://private.example",
    npm_config_strict_ssl: "false", NPM_TOKEN: "secret", NODE_AUTH_TOKEN: "secret", HTTPS_PROXY: "https://proxy.example",
  });
  assert.equal(env.NPM_TOKEN, undefined);
  assert.equal(env.NODE_AUTH_TOKEN, undefined);
  assert.equal(env.NPM_CONFIG_USERCONFIG, undefined);
  assert.equal(env.npm_config_strict_ssl, "true");
  assert.equal(env.npm_config_registry, options.registry);
  assert.equal(env.HTTPS_PROXY, "https://proxy.example");
});
