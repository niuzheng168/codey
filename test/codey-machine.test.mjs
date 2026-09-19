import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, lstat, mkdir, readFile, readdir, rmdir, symlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";
import test from "node:test";
import { commandPlan } from "../packages/codey/lib/cli.mjs";
import { machineOptions, openMachine, printMachine, runMachine } from "../packages/codey/lib/machine.mjs";
import { backupDocument, decodeBackup, exportMachine, importMachine } from "../packages/codey/lib/machine-backup.mjs";
import { updateMachine } from "../packages/codey/lib/machine-update.mjs";
import { runDiagnostics } from "../packages/codey/lib/machine-doctor.mjs";
import { fileHash } from "../packages/codey/lib/package-files.mjs";
import { managedFixture } from "./helpers/managed-node-fixture.mjs";
import { treeFiles } from "./codey-update-fixture.mjs";
import { writePrivate } from "../skills/config-new-codey-machine/scripts/machine-common.mjs";
const exec = promisify(execFile);

test("public node operations route without starting applications; malformed options fail", () => {
  assert.deepEqual(commandPlan(["copilot", "login"]).args, ["auth", "login", "--provider", "copilot"]);
  assert.deepEqual(commandPlan(["copilot", "start"]).args, ["start", "--headless", "--host", "127.0.0.1", "--port", "4141"]);
  for (const args of [
    ["devtunnel", "login"], ["devtunnel", "start"], ["devtunnel", "stop"], ["status"], ["start"], ["restart"], ["stop"],
    ["export", "settings.gz"], ["import", "settings.gz"], ["update", "codey.tgz"], ["guard"],
  ]) assert.equal(commandPlan(args).kind, "machine");
  assert.equal(commandPlan(["doctor"]).kind, "doctor");
  assert.equal(commandPlan(["start", "--foreground"]).kind, "start");
  for (const args of [
    ["copilot", "login", "--provider=custom"], ["copilot", "login", "--no-provider"],
    ["copilot", "login", "--alias", "work"], ["devtunnel", "delete"],
    ["start", "--foreground", "--json"], ["start", "--timeout", "0"], ["status", "--json", "--json"],
    ["export"], ["import", "backup.gz", "--force"], ["update", "https://example.test/codey.tgz"],
    ["update", "file.tgz", "--sha256", "bad"], ["update", "--recover"], ["update", "file.tgz", "--offline=true"],
    ["guard", "--timeout", "0"], ["guard", "--timeout", "601"], ["guard", "--timeout", "1.5"],
    ["guard", "--timeout=60"], ["guard", "--timeout"], ["guard", "--json", "--json"],
    ["guard", "--timeout", "60", "--timeout", "120"],
    ["guard", "--foreground"], ["guard", "--host", "127.0.0.1"], ["guard", "--install"], ["guard", "start"],
  ]) assert.throws(() => commandPlan(args), Error, args.join(" "));
  assert.equal(machineOptions("update", ["local.tgz", "--check", "--offline"]).check, true);
  assert.deepEqual(machineOptions("guard", ["--timeout", "600", "--json"]), { timeout: "600", json: true });
});

for (const target of ["linux-x64", "windows-x64", "macos-arm64", "macos-x64"]) {
  test(`${target}: node lifecycle and independent tunnel lifecycle preserve all settings`, async t => {
    const f = await managedFixture(t, target), original = await treeFiles(f.i.configRoot);
    const sensitive = await treeFiles(f.config.codexHome);
    await f.m.lifecycle("stop", { tunnelOnly: true });
    assert.equal(f.states[0].running, true);
    assert.ok(f.states.slice(1).every(item => !item.enabled && !item.running));
    await f.m.lifecycle("start", { tunnelOnly: true });
    assert.ok(f.states.every(item => item.enabled && item.running));
    await f.m.lifecycle("stop");
    assert.ok(f.states.every(item => !item.enabled && !item.running));
    await f.m.lifecycle("start");
    assert.equal((await f.m.lifecycle("restart")).operationInProgress, false);
    assert.ok(f.states.every(item => item.enabled && item.running));
    assert.deepEqual(await treeFiles(f.i.configRoot), original);
    assert.deepEqual(await treeFiles(f.config.codexHome), sensitive);
    const output = [];
    printMachine(await f.m.status(), true, value => output.push(value));
    assert.ok(!output[0].includes(f.modelKey) && !output[0].includes(f.identity.workspaceSsoKey));
    const before = f.calls.length;
    f.foreignService = true;
    await assert.rejects(f.m.lifecycle("stop"), /foreign service/);
    assert.ok(!f.calls.slice(before).some(item => item?.operation === "setStates"));
  });

  test(`${target}: guard starts every installed supervisor through the shared lifecycle, without reinstalling or changing settings`, async t => {
    const f = await managedFixture(t, target), output = [];
    t.mock.method(console, "log", value => output.push(value));
    for (const state of f.states) Object.assign(state, { enabled: false, running: false, state: "stopped" });
    const original = await treeFiles(f.home), operations = [];
    const lifecycle = f.m.lifecycle.bind(f.m);
    f.m.lifecycle = async (...args) => { operations.push(args); return lifecycle(...args); };
    const options = { open: async root => { assert.equal(root, f.app); return f.m; } };
    for (const args of [["--json"], ["--timeout", "120", "--json"]]) {
      const result = await runMachine(f.app, "guard", args, options);
      assert.equal(result.running, true);
      assert.equal(result.operationInProgress, false);
      assert.ok(f.states.every(state => state.enabled && state.running));
      assert.deepEqual(await treeFiles(f.home), original);
    }
    assert.deepEqual(operations, [
      ["start", { tunnelOnly: false, timeout: 60 }],
      ["start", { tunnelOnly: false, timeout: 120 }],
    ]);
    assert.ok(f.calls.includes("probe"), "Guard verifies local services before reporting success");
    assert.ok(!f.calls.includes("model") && !f.calls.includes("switch"));
    assert.ok(!f.calls.some(call => call.args?.includes("login") || call.args?.includes("install")));
    const changes = f.calls.filter(call => call?.operation === "setStates");
    assert.ok(changes.every(call => call.values.every(state => state.enabled && state.running)),
      "Guard never stops/restarts an existing process");
    assert.ok(output.every(value => JSON.parse(value).running));
    assert.ok(!output.join("").includes(f.modelKey) && !output.join("").includes(f.identity.workspaceSsoKey));
  });
}

test("guard refuses an unconfigured node instead of importing an installer or falling back to foreground mode", async () => {
  await assert.rejects(runMachine("/unused-package", "guard", [], { open: async () => null }), /Complete the installation Skill first/);
});

test("guard preserves ownership, integrity and locking gates before enabling any supervisor", async t => {
  const f = await managedFixture(t);
  const guard = () => runMachine(f.app, "guard", [], { open: async () => f.m });
  f.foreignPort = true;
  await assert.rejects(guard(), /foreign/);
  f.foreignPort = false; f.foreignService = true;
  await assert.rejects(guard(), /foreign service/);
  f.foreignService = false;
  await mkdir(path.join(f.i.configRoot, "install.lock"), { mode: 0o700 });
  await assert.rejects(guard(), /interrupted/);
  await rmdir(path.join(f.i.configRoot, "install.lock"));
  await writePrivate(f.config.devtunnelExe, Buffer.from("tampered tool"));
  await assert.rejects(guard(), /fingerprint mismatch/);
  assert.ok(!f.calls.some(call => call?.operation === "setStates"));
});

test("guard reports failed local verification rather than treating running supervisors as a healthy node", async t => {
  const f = await managedFixture(t);
  f.probeError = true;
  await assert.rejects(runMachine(f.app, "guard", ["--timeout", "1"], { open: async () => f.m }),
    error => /local TLS\/SSO\/gateway checks failed/.test(error.message) && !error.message.includes("fixture secret"));
  assert.ok(!f.calls.includes("model"));
});

test("ready node discovery binds owner, platform, package and node descriptor without a preflight mutation", async t => {
  const f = await managedFixture(t);
  const options = { home: f.home, platform: "linux", arch: "x64", createInstaller: async () => f.i };
  assert.equal((await openMachine(f.app, options)).config.nodeId, f.config.nodeId);
  await writePrivate(f.i.file, { ...f.config, ownerUid: process.getuid() + 1 });
  await assert.rejects(openMachine(f.app, options), /another owner/);
  await writePrivate(f.i.file, { ...f.config, codeyDirectory: path.join(f.home, "different") });
  await assert.rejects(openMachine(f.app, options), /installed Codey command/);
});

test("foreign ports and shared operation locks prevent starting, import or update takeover", async t => {
  const f = await managedFixture(t);
  f.foreignPort = true;
  await assert.rejects(f.m.lifecycle("start"), /foreign/);
  assert.ok(!f.calls.some(item => item?.operation === "setStates"));
  await mkdir(path.join(f.i.configRoot, "install.lock"), { mode: 0o700 });
  await assert.rejects(f.m.lifecycle("stop"), /interrupted/);
});

test("node stop/restart still refuse a terminal descended from the private CloudCLI worker", async t => {
  const f = await managedFixture(t, "macos-arm64");
  delete f.i.adapter.external;
  f.i.run = async (file, args) => {
    assert.equal(file, "/bin/ps");
    assert.deepEqual(args.slice(-4), ["-o", "ppid=", "-o", "command="]);
    return { code: 0, stdout: `1 ${f.config.nodeExe} ${path.join(f.app, "lib/workspace.mjs")}\n`, stderr: "" };
  };
  for (const action of ["stop", "restart"]) await assert.rejects(f.m.lifecycle(action), /external owner terminal/);
  assert.ok(!f.calls.some(item => item?.operation === "setStates"));
  assert.ok(f.states.every(item => item.enabled && item.running));
});

test("DevTunnel login reuses GitHub, performs device login when absent and refuses another provider", async t => {
  const f = await managedFixture(t);
  assert.equal((await f.m.loginTunnel()).existing, true);
  assert.ok(!f.calls.some(item => item.args?.includes("login")));
  f.user = { status: "Logged out" };
  assert.equal((await f.m.loginTunnel()).existing, false);
  assert.ok(f.calls.some(item => item.args?.join(" ") === "user login --github --use-device-code-auth" && item.options.interactive));
  f.user = { status: "Logged in", provider: "microsoft", secret: "never print" };
  await assert.rejects(f.m.loginTunnel(), error => /another provider/.test(error.message) && !error.message.includes("never print"));
});

test("export is a private compressed key/token/settings archive, not registration JSON or an application copy", async t => {
  const f = await managedFixture(t), file = path.join(f.home, "backup.gz");
  const result = await exportMachine(f.m, { file });
  const document = decodeBackup(await readFile(file));
  assert.equal(result.operation, "export");
  assert.equal((await lstat(file)).mode & 0o077, 0);
  assert.ok(document.files.some(item => item.name === "node/node-key.pem"));
  assert.ok(document.files.some(item => item.name === "gateway/github_token"));
  assert.ok(document.files.some(item => item.name === "codex/auth.json"));
  assert.ok(!document.files.some(item => /node_modules|sessions|\.mjs/.test(item.name)));
  assert.ok(!JSON.stringify(result).includes(f.modelKey));
  await assert.rejects(exportMachine(f.m, { file }), /already exists/);
});

test("import --check is read-only; actual restore backs up previous settings and preserves service state", async t => {
  const f = await managedFixture(t), file = path.join(f.home, "backup.gz");
  await exportMachine(f.m, { file });
  await writePrivate(path.join(f.config.codexHome, "config.toml"), Buffer.from('model = "changed"\n'));
  await writePrivate(path.join(f.config.environment.COPILOT_API_HOME, "github_token"), Buffer.from("changed token"));
  f.states[1].enabled = f.states[1].running = false;
  const before = await treeFiles(f.home), states = structuredClone(f.states), calls = f.calls.length;
  assert.equal((await importMachine(f.m, { file, check: true })).check, true);
  assert.deepEqual(await treeFiles(f.home), before);
  assert.equal(f.calls.length, calls);
  await assert.rejects(importMachine(f.m, { file }), /replace-existing/);
  const result = await importMachine(f.m, { file, "replace-existing": true });
  assert.ok(result.backup);
  assert.equal((await readFile(path.join(f.config.environment.COPILOT_API_HOME, "github_token"), "utf8")), "fixture-github-token");
  assert.match(await readFile(path.join(f.config.codexHome, "config.toml"), "utf8"), /model = "fixture"/);
  assert.deepEqual(f.states.map(s => [s.enabled, s.running]), states.map(s => [s.enabled, s.running]));
});

test("settings-only import is portable but never clones another node's identity or TLS key", async t => {
  const f = await managedFixture(t), file = path.join(f.home, "portable.gz");
  const document = await backupDocument(f.m);
  document.node.nodeId = "n-" + "f".repeat(24); document.node.platform = "windows-x64"; document.node.ownerHome = "another owner";
  await writePrivate(file, gzipSync(Buffer.from(JSON.stringify(document))));
  await assert.rejects(importMachine(f.m, { file, "replace-existing": true }), /same node/);
  const certHash = await fileHash(f.config.certificate), identityHash = await fileHash(f.config.identityFile);
  await importMachine(f.m, { file, "replace-existing": true, "settings-only": true });
  assert.equal(await fileHash(f.config.certificate), certHash);
  assert.equal(await fileHash(f.config.identityFile), identityHash);
});

test("corrupt, duplicate, oversized and traversal backups are rejected before any service/file mutation", async t => {
  const f = await managedFixture(t), file = path.join(f.home, "bad.gz"), doc = await backupDocument(f.m);
  for (const change of [
    d => { d.files[0].name = "gateway/../../escaped"; },
    d => { d.files.push(d.files[0]); },
    d => { d.files[0].sha256 = "0".repeat(64); },
    d => { d.files[0].data = "!malformed"; },
    d => { d.schema = 99; },
  ]) {
    const value = structuredClone(doc); change(value);
    await writePrivate(file, gzipSync(Buffer.from(JSON.stringify(value))));
    const before = await treeFiles(f.i.configRoot);
    await assert.rejects(importMachine(f.m, { file, "replace-existing": true }));
    assert.deepEqual(await treeFiles(f.i.configRoot), before);
  }
  await writePrivate(file, gzipSync(Buffer.alloc(33 * 1024 * 1024)));
  await assert.rejects(importMachine(f.m, { file, check: true }), /bounded/);
  const linked = path.join(f.home, "linked.gz");
  await symlink(file, linked);
  await assert.rejects(importMachine(f.m, { file: linked, check: true }), /linked|private/i);
  assert.ok(!f.calls.some(item => item?.operation === "setStates"));
});

test("doctor reports component failures without credential output and model probing is opt-in", async t => {
  const f = await managedFixture(t), output = [];
  const dependencies = { open: async () => f.m,
    packageCheck: async () => ({ ok: true, version: "1.0.0", native: { fixture: true } }), log: value => output.push(value) };
  const first = await runDiagnostics(f.app, ["--json"], dependencies);
  assert.equal(first.ok, true);
  assert.equal(first.modelRequests, false);
  assert.ok(!f.calls.includes("model"));
  await runDiagnostics(f.app, ["--model"], dependencies);
  assert.ok(f.calls.includes("model"));
  f.probeError = true;
  const failed = await runDiagnostics(f.app, ["--json", "--offline"], dependencies);
  assert.equal(failed.ok, false);
  assert.ok(failed.checks.some(item => item.skipped));
  assert.equal(process.exitCode, 1);
  process.exitCode = 0;
  assert.ok(!output.join("").includes("fixture secret") && !output.join("").includes(f.modelKey));
});

test("doctor never executes a tampered tool/worker, including --model probes", async t => {
  const f = await managedFixture(t);
  await writePrivate(f.config.devtunnelExe, Buffer.from("tampered native executable"));
  const result = await runDiagnostics(f.app, ["--model"], { open: async () => f.m,
    packageCheck: async () => ({ ok: true, version: "1.0.0" }), log() {} });
  assert.equal(result.ok, false);
  assert.equal(result.modelRequests, false);
  assert.ok(!f.calls.includes("model") && !f.calls.includes("probe") && !f.calls.some(item => item.args));
  process.exitCode = 0;
});

test("restore synchronizes model credentials without replacing the target's node security settings", async t => {
  const f = await managedFixture(t, "windows-x64"), file = path.join(f.home, "backup.gz");
  f.config.environment.CODEY_PORTAL_SSO = "true";
  f.config.environment.COPILOT_API_CODEY_HTTPS_HOST = "127.0.0.1";
  f.config.services = { codey: { environment: { ...f.config.environment } } };
  await writePrivate(f.i.file, f.config);
  await exportMachine(f.m, { file });
  const replacement = "x".repeat(43);
  await writePrivate(path.join(f.config.environment.COPILOT_API_HOME, "config.json"), { auth: { apiKeys: [replacement] } });
  const changed = structuredClone(f.config);
  changed.modelKey = replacement;
  changed.environment.CODEY_MODEL_API_KEY = replacement;
  const modelKeys = [];
  f.i.adapter.modelKey = async value => modelKeys.push(value);
  await f.m.save(changed);
  await importMachine(f.m, { file, "replace-existing": true });
  assert.equal(f.m.config.modelKey, f.modelKey);
  assert.equal(f.m.config.services.codey.environment.CODEY_MODEL_API_KEY, f.modelKey);
  assert.equal(modelKeys.at(-1), f.modelKey, "The Windows user environment follows restored credentials");
  assert.equal(f.m.config.environment.CODEY_PORTAL_SSO, "true");
  assert.equal(f.m.config.environment.COPILOT_API_CODEY_HTTPS_HOST, "127.0.0.1");
});

test("a failed restore rolls back original file bytes, runtime and service state", async t => {
  const f = await managedFixture(t), file = path.join(f.home, "backup.gz");
  await exportMachine(f.m, { file });
  const token = path.join(f.config.environment.COPILOT_API_HOME, "github_token");
  await writePrivate(token, Buffer.from("newer credential"));
  f.failSwitch = true;
  await assert.rejects(importMachine(f.m, { file, "replace-existing": true }), /previous settings and service state were restored/);
  assert.equal(await readFile(token, "utf8"), "newer credential");
  assert.ok(f.states.every(item => item.enabled && item.running));
  assert.equal((await f.m.status()).operationInProgress, false);
});

test("update --check validates package/ownership with no writes or service changes", async t => {
  const f = await managedFixture(t), { file } = await f.nextPackage();
  const before = await treeFiles(f.i.root);
  const result = await updateMachine(f.m, { file, check: true, offline: true });
  assert.equal(result.version, "2.0.0");
  assert.equal(result.downloads, false);
  assert.deepEqual(await treeFiles(f.i.root), before);
  assert.ok(!f.calls.some(item => item?.operation === "setStates"));
  await assert.rejects(updateMachine(f.m, { file, sha256: "0".repeat(64) }), /SHA-256/);
});

test("real offline package preparation validates and switches the application without tools/config/identity changes", { timeout: 120000 }, async t => {
  const f = await managedFixture(t), { file } = await f.nextPackage();
  const before = structuredClone(f.config), codexFiles = await treeFiles(f.config.codexHome), gatewayFiles = await treeFiles(f.config.environment.COPILOT_API_HOME);
  f.states[1].enabled = f.states[1].running = false;
  const states = structuredClone(f.states);
  // Real local Node/npm extraction and native-fixture doctor; no registry, credentials or native services.
  f.i.run = async (exe, args, options) => {
    assert.equal(options.replaceEnvironment, true);
    assert.equal(options.env.CODEY_MODEL_API_KEY, undefined);
    assert.notEqual(options.env.HOME, f.home);
    const result = await exec(exe, args, { env: options.env, cwd: options.cwd, timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
    return { code: 0, ...result };
  };
  const result = await updateMachine(f.m, { file, offline: true });
  assert.equal(result.changed, true);
  assert.notEqual(f.m.config.codeyDirectory, before.codeyDirectory);
  assert.equal(f.m.config.nodeExe, before.nodeExe);
  assert.equal(f.m.config.nodeId, before.nodeId);
  assert.equal(f.m.config.certificate, before.certificate);
  assert.equal(f.m.config.modelKey, before.modelKey);
  assert.deepEqual(await treeFiles(before.codexHome), codexFiles);
  assert.deepEqual(await treeFiles(before.environment.COPILOT_API_HOME), gatewayFiles);
  assert.deepEqual(f.states.map(s => [s.enabled, s.running]), states.map(s => [s.enabled, s.running]));
  assert.equal(JSON.parse(await readFile(path.join(f.m.config.codeyDirectory, "package.json"))).version, "2.0.0");
  assert.ok((await readdir(path.join(f.i.root, "releases"))).includes("old"));
});

test("failed staging never stops services; failed post-switch validation rolls back package and state", async t => {
  const f = await managedFixture(t), { file, next } = await f.nextPackage(), original = structuredClone(f.config);
  await assert.rejects(updateMachine(f.m, { file }, { prepare: async () => { throw new Error("staging failure"); } }), /staging failure/);
  assert.ok(!f.calls.some(item => item?.operation === "setStates"));
  f.m.verifyRunning = async () => {
    if (f.m.config.codeyDirectory !== original.codeyDirectory) throw new Error("new application health failure");
  };
  await assert.rejects(updateMachine(f.m, { file }, { prepare: async (m, artifact, release) => {
    const app = path.join(release, "app"); await cp(next, app, { recursive: true }); return app;
  } }), /previous package and service state were restored/);
  assert.equal(f.m.config.codeyDirectory, original.codeyDirectory);
  assert.equal(f.m.config.codeyEntrySha256, original.codeyEntrySha256);
  assert.ok(f.states.every(item => item.enabled && item.running));
});
