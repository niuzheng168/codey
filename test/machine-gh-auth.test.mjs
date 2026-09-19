import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { managedFixture } from "./helpers/managed-node-fixture.mjs";
import { machineFixture } from "./helpers/machine-installer-fixture.mjs";
import { readPrivate, writePrivate } from "../skills/config-new-codey-machine/scripts/machine-common.mjs";
import { linuxUnitFiles } from "../skills/config-new-codey-machine/scripts/platform-linux.mjs";
import { agentDefinition } from "../skills/config-new-codey-machine/scripts/macos-service.mjs";
import { windowsAdapter } from "../skills/config-new-codey-machine/scripts/platform-windows.mjs";
import { runDiagnostics } from "../packages/codey/lib/machine-doctor.mjs";
import { backupDocument, importMachine, writeBackup } from "../packages/codey/lib/machine-backup.mjs";
import { GH_BINDING_FILE } from "../packages/codey/lib/copilot-auth.mjs";
import { runTunnelWorker } from "../packages/codey/lib/tunnel.mjs";
import * as tunnelRuntime from "../skills/config-new-codey-machine/scripts/github-tunnel.mjs";
import * as nativeRuntime from "../skills/config-new-codey-machine/scripts/windows-runtime.mjs";

const token = "fixture-github-token-never-persist";
const bindingFor = home => ({ schema: 1, source: "gh", host: "github.com", id: 42, login: "fixture_user",
  executable: path.join(home, "bin/gh"), configDir: path.join(home, ".config/gh") });

async function githubFixture(t, target) {
  const f = await managedFixture(t, target);
  f.binding = bindingFor(f.home);
  f.user = { status: "Not logged in" };
  f.i.auth = {
    github: async options => {
      if (options.binding) assert.deepEqual(options.binding, f.binding);
      return { binding: f.binding, token };
    },
    verify: async () => {},
    getTunnel: async () => readPrivate(f.config.tunnelFile),
  };
  return f;
}

test("DevTunnel gh adoption verifies the actual configured tunnel and refuses to replace running authentication", async t => {
  const f = await githubFixture(t);
  const before = await readFile(f.i.file, "utf8");
  await assert.rejects(f.m.loginTunnel(), /codey devtunnel stop/);
  assert.equal(await readFile(f.i.file, "utf8"), before);
  f.i.auth.getTunnel = async () => { throw new Error("HTTP 404"); };
  await assert.rejects(f.m.loginTunnel(), /404/);
  assert.equal(await readFile(f.i.file, "utf8"), before);
  assert.ok(!f.calls.some(call => call.args?.includes("login")));
});

for (const target of ["linux-x64", "windows-x64", "macos-arm64"]) {
  test(`${target}: stopped-node login pins gh without copying a token, changing node identity or starting services`, async t => {
    const f = await githubFixture(t, target);
    await f.m.lifecycle("stop", { tunnelOnly: true });
    f.calls.length = 0;
    const before = structuredClone(f.m.config);
    const result = await f.m.loginTunnel();
    assert.equal(result.source, "gh");
    assert.equal(result.username, "fixture_user");
    assert.ok(!JSON.stringify(result).includes(token));
    assert.deepEqual(f.m.config.tunnelAuth, f.binding);
    assert.deepEqual({ ...f.m.config, tunnelAuth: undefined }, { ...before, tunnelAuth: undefined });
    assert.ok(!f.calls.some(call => call.args?.includes("login") || call.operation === "setStates"));
    assert.ok(!JSON.stringify(await readPrivate(f.i.file)).includes(token));
    assert.equal(f.m.config.nodeId, before.nodeId);
    assert.equal(f.m.config.modelKey, before.modelKey);
    assert.equal(f.m.config.certificate, before.certificate);
    f.calls.length = 0;
    assert.equal((await f.m.loginTunnel()).source, "gh");
    assert.ok(!f.calls.some(call => call.args?.[0] === "user"), "pinned gh does not follow the native cache");
  });
}

test("background start discovers gh only when the tunnel is stopped, without interactive login", async t => {
  const f = await githubFixture(t);
  await f.m.lifecycle("stop", { tunnelOnly: true });
  f.calls.length = 0;
  await f.m.lifecycle("start", { tunnelOnly: true });
  assert.deepEqual(f.m.config.tunnelAuth, f.binding);
  assert.ok(f.states.filter(item => item.component === "tunnel").every(item => item.running));
  assert.ok(!f.calls.some(call => call.options?.interactive));
  assert.ok(!f.calls.some(call => call.operation === "setStates" &&
    call.values.some(item => item.component === "codey")));
});

test("background start never opens device authentication if both caches are unavailable", async t => {
  const f = await managedFixture(t);
  await f.m.lifecycle("stop", { tunnelOnly: true });
  f.user = { status: "Not logged in" };
  f.calls.length = 0;
  await assert.rejects(f.m.lifecycle("start", { tunnelOnly: true }), /run codey devtunnel login/);
  assert.ok(!f.calls.some(call => call.options?.interactive || call.operation === "setStates"));
});

test("Linux and macOS native host/renew/health definitions select the credential-safe package worker only for gh", async t => {
  const f = await managedFixture(t);
  const native = linuxUnitFiles(f.config), gh = { ...f.config, tunnelAuth: bindingFor(f.home) };
  const files = linuxUnitFiles(gh), worker = path.join(f.app, "lib/tunnel.mjs");
  assert.ok(native["codey-devtunnel.service"].includes(`ExecStart=${f.config.devtunnelExe} host `));
  assert.ok(files["codey-devtunnel.service"].includes(`ExecStart=${f.config.nodeExe} ${worker} host ${f.i.file}`));
  assert.ok(files["codey-devtunnel-renew.service"].includes(`${worker} renew ${f.i.file}`));
  assert.ok(files["codey-devtunnel-health.service"].includes(`--runtime ${f.i.file}`));
  assert.ok(files["codey-devtunnel-health.service"].includes(path.join(f.app, "onboarding/scripts/linux-devtunnel-health.mjs")));
  for (const component of ["tunnel", "renew"]) {
    const definition = agentDefinition(gh, f.i.file, component);
    assert.deepEqual(definition.ProgramArguments, [gh.nodeExe, worker, component === "tunnel" ? "host" : "renew", f.i.file]);
  }
  assert.deepEqual(agentDefinition(gh, f.i.file, "codey"), agentDefinition(f.config, f.i.file, "codey"));
  assert.ok(!JSON.stringify(files).includes(token));
});

test("Windows tasks use the same package worker, retain private GH helper hashes, and contain no GitHub token", async t => {
  const f = await managedFixture(t, "windows-x64");
  const old = process.env.SystemRoot;
  process.env.SystemRoot = path.join(f.home, "Windows");
  t.after(() => { if (old === undefined) delete process.env.SystemRoot; else process.env.SystemRoot = old; });
  const supervisor = path.join(f.i.root, "supervisor");
  for (const name of ["windows-common.ps1", "windows-process.cs", "windows-service.ps1", "windows-runtime.mjs",
    "registration.mjs", "machine-common.mjs", "github-auth.mjs", "github-tunnel.mjs", "codey-task-host.exe"]) {
    await writeFile(path.join(supervisor, name), "fixture helper", { mode: 0o600 });
  }
  const i = { ...f.i, run: async (_exe, _args, options) => {
    const request = JSON.parse(options.input);
    assert.equal(request.operation, "task-host");
    return { stdout: JSON.stringify(path.join(supervisor, "codey-task-host.exe")) };
  } };
  const adapter = windowsAdapter(i), config = { ...structuredClone(f.config), tunnelAuth: f.binding ?? bindingFor(f.home) };
  await adapter.configure(config);
  assert.equal(config.services.tunnel.executable, config.nodeExe);
  assert.deepEqual(config.services.tunnel.arguments, [path.join(f.app, "lib/tunnel.mjs"), "host", f.i.file]);
  assert.deepEqual(config.services.renew.arguments, [path.join(f.app, "lib/tunnel.mjs"), "renew", f.i.file]);
  assert.match(config.helperHashes["github-auth.mjs"], /^[a-f0-9]{64}$/);
  assert.match(config.helperHashes["github-tunnel.mjs"], /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(config.services).includes(token));
});

test("doctor recognizes gh account bindings and verifies tunnel connectivity without device login or token files", async t => {
  const f = await githubFixture(t);
  await f.m.lifecycle("stop", { tunnelOnly: true });
  await f.m.loginTunnel();
  await f.m.lifecycle("start", { tunnelOnly: true });
  await rm(path.join(f.config.environment.COPILOT_API_HOME, "github_token"));
  await writePrivate(path.join(f.config.environment.COPILOT_API_HOME, GH_BINDING_FILE), f.binding);
  const output = [];
  const report = await runDiagnostics(f.app, ["--json"], {
    open: async () => f.m,
    packageCheck: async () => ({ version: "fixture", native: {} }), log: value => output.push(value),
  });
  assert.equal(report.ok, true);
  assert.equal(report.checks.find(check => check.name === "Copilot saved login").detail.source, "gh");
  assert.equal(report.checks.find(check => check.name === "DevTunnel GitHub login").detail.source, "gh");
  assert.equal(report.checks.find(check => check.name === "private tunnel/host connection").ok, true);
  assert.ok(!output.join("").includes(token));
  assert.ok(!f.calls.some(call => call.options?.interactive));
});

test("backup records only the Copilot gh binding, and settings-only import preserves this machine's selected gh account", async t => {
  const f = await managedFixture(t);
  const marker = path.join(f.config.environment.COPILOT_API_HOME, GH_BINDING_FILE);
  const original = bindingFor(f.home);
  await writePrivate(marker, original);
  const document = await backupDocument(f.m);
  assert.ok(document.files.some(item => item.name === `gateway/${GH_BINDING_FILE}`));
  assert.ok(document.excluded.some(item => item.includes("GitHub CLI")));
  const file = path.join(f.home, "gh-backup.gz");
  await writeBackup(f.m, file, document);
  const changed = { ...original, id: 99, login: "another_account" };
  await writePrivate(marker, changed);
  const plan = await importMachine(f.m, { file, check: true, "settings-only": true });
  assert.ok(!plan.entries.includes(`gateway/${GH_BINDING_FILE}`));
  await importMachine(f.m, { file, "replace-existing": true, "settings-only": true });
  assert.deepEqual(await readPrivate(marker), changed);
  await importMachine(f.m, { file, "replace-existing": true });
  assert.deepEqual(await readPrivate(marker), original);
});

for (const target of ["linux-x64", "windows-x64", "macos-arm64", "macos-x64"]) {
  test(`${target}: the shared installer adopts gh during apply but never during preflight`, async t => {
    const f = await machineFixture(t, target);
    const binding = bindingFor(f.home), calls = [];
    const execute = f.installer.run;
    f.installer.run = async (exe, args, options) => {
      if (path.basename(exe).startsWith("devtunnel") && args[0] === "user") {
        assert.deepEqual(args, ["user", "show", "--json"]);
        return { code: 0, stdout: '{"status":"Not logged in"}' };
      }
      return execute(exe, args, options);
    };
    f.installer.auth = {
      github: async () => { calls.push("gh"); return { token, binding }; },
      verify: async () => { calls.push("list"); },
      ensureTunnel: async (_credential, tunnelId) => {
        calls.push("ensure");
        return { tunnelId, clusterId: "jpe1", ports: [3001, 8443].map(portNumber => ({ portNumber, protocol: "https" })) };
      },
    };
    await f.installer.apply({ ...f.options, apply: false, check: true });
    assert.deepEqual(calls, []);
    await f.installer.apply(f.options);
    const config = await readPrivate(f.installer.file);
    assert.deepEqual(config.tunnelAuth, binding);
    assert.deepEqual(calls, ["gh", "list", "ensure"]);
    assert.ok(!JSON.stringify(config).includes(token));
    assert.ok(!f.calls.some(call => call.args[0] === "user" && call.args[1] === "login"));
    const login = f.calls.find(call => call.args[1] === "copilot" && call.args[2] === "login");
    assert.ok(login, "Copilot still runs its shared ensure-auth command, not a separate OAuth implementation");
    for (const name of ["authHelperPath", "tunnelAuthHelperPath"]) assert.match(config.fileHashes[name], /^[a-f0-9]{64}$/);
  });
}

test("installer gh discovery forwards the live keyring session without persisting it in service configuration", async t => {
  const f = await machineFixture(t, "linux-x64");
  const names = ["DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR"];
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  t.after(() => { for (const name of names) {
    if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name];
  } });
  process.env.DBUS_SESSION_BUS_ADDRESS = "unix:path=/run/user/1000/bus";
  process.env.XDG_RUNTIME_DIR = "/run/user/1000";
  const base = f.installer.baseEnvironment("/official/bin/node");
  const discovery = f.installer.githubEnvironment(base);
  for (const name of names) {
    assert.equal(discovery[name], process.env[name]);
    assert.equal(base[name], undefined);
  }
});

test("internal tunnel worker rejects public misuse, a foreign runtime file and unconfigured nodes", async () => {
  await assert.rejects(runTunnelWorker("/package", ["login", "/runtime"]), /Invalid internal/);
  await assert.rejects(runTunnelWorker("/package", ["host", "/runtime"], { open: async () => null }), /not configured/);
  await assert.rejects(runTunnelWorker("/package", ["host", "/other"], {
    open: async () => ({ i: { file: "/runtime" }, config: { tunnelAuth: bindingFor("/owner") } }),
  }), /not configured/);
});

test("the package worker validates this node and routes host, show and connect-only renewal independently", async t => {
  const f = await githubFixture(t);
  f.m.config.tunnelAuth = f.binding;
  await writePrivate(f.i.file, f.m.config);
  const operations = [], output = [];
  const load = async file => {
    if (file.endsWith("/github-auth.mjs")) return { readGhCredential: f.i.auth.github };
    if (file.endsWith("/github-tunnel.mjs")) return { ...tunnelRuntime,
      getGhTunnel: f.i.auth.getTunnel, hostGhTunnel: async config => { operations.push("host"); assert.equal(config, f.m.config); return 0; } };
    if (file.endsWith("/windows-runtime.mjs")) return { ...nativeRuntime,
      tokenFor: async (_config, expected) => { operations.push("connect-token"); assert.equal(expected.tunnelId, `codey-${f.config.nodeId}`); return "fixture-connect"; },
      renew: async (_config, identity, expected, value) => {
        operations.push("renew"); assert.equal(value, "fixture-connect");
        assert.equal(identity.nodeId, f.config.nodeId); assert.equal(expected.clusterId, "jpe1");
      } };
    assert.fail("unexpected worker dependency");
  };
  for (const command of ["show", "host", "renew"]) {
    assert.equal(await runTunnelWorker(f.app, [command, f.i.file], {
      open: async () => f.m, log: value => output.push(value), load,
    }), 0);
  }
  assert.deepEqual(operations, ["host", "connect-token", "renew"]);
  assert.equal(JSON.parse(output[0]).tunnelId, `codey-${f.config.nodeId}`);
  assert.ok(!output.join("\n").includes(token));
  f.m.config.qualifiedTunnel = `codey-n-${"0".repeat(24)}.jpe1`;
  await assert.rejects(runTunnelWorker(f.app, ["host", f.i.file], {
    open: async () => f.m, load,
  }), /identity does not match/);
  assert.deepEqual(operations, ["host", "connect-token", "renew"], "never host another tunnel, even within the same gh account");
});
