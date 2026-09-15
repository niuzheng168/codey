import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  boundedCommand, checkTunnelHealth, HEALTH_POLICY, healthDecision, healthOptions,
  hostConnectionCount, HOST_SERVICE,
} from "../skills/config-new-codey-machine/scripts/linux-devtunnel-health.mjs";

const exec = promisify(execFile);
const tunnelId = `codey-n-${"a".repeat(24)}.usw2`;
const bootId = "11111111-2222-3333-4444-555555555555";
const invocationId = "b".repeat(32);
const devtunnel = "/home/fixture/.local/share/codey-tools/devtunnel/devtunnel";
const stateFile = "/home/fixture/.local/state/codey-machine/devtunnel-health.json";
const banner = "\uFEFFWelcome to dev tunnels!\nCLI version: fixture\n\n";
const observation = overrides => ({
  bootId, tunnelId, invocationId, now: 1_000_000, status: "host-offline", hostAgeMs: 600_000, ...overrides,
});
const offline = (previous, overrides) => healthDecision(previous, observation(overrides));

function fixture() {
  const f = {
    now: 1_000_000, state: undefined, connections: 0, calls: [], saves: [], events: [],
    unit: { ActiveState: "active", SubState: "running", MainPID: "123",
      InvocationID: invocationId, ActiveEnterTimestampMonotonic: "1000000", Job: "" },
    options: { devtunnel, tunnelId, stateFile, checkOnly: false },
  };
  f.args = [devtunnel, "host", tunnelId, "--host-header", "unchanged", "--origin-header", "unchanged"];
  f.dependencies = {
    clock: () => f.now,
    async read(file) {
      if (file === "/proc/sys/kernel/random/boot_id") return f.bootId ?? bootId;
      if (file === stateFile) {
        if (f.readError) throw f.readError;
        if (f.state === undefined) throw Object.assign(new Error(), { code: "ENOENT" });
        return typeof f.state === "string" ? f.state : JSON.stringify(f.state);
      }
      if (file === `/proc/${f.unit.MainPID}/cmdline`) return f.args.join("\0") + "\0";
      throw Object.assign(new Error(), { code: "ENOENT" });
    },
    async save(file, value) {
      assert.equal(file, stateFile);
      if (f.saveError) throw f.saveError;
      f.events.push("save");
      f.state = structuredClone(value);
      f.saves.push(f.state);
    },
    async command(file, args, timeout) {
      f.calls.push({ file, args, timeout });
      assert.ok(timeout > 0 && timeout <= 15_000);
      if (args.includes("show") && file === "/usr/bin/systemctl") {
        if (f.serviceError) throw f.serviceError;
        const unit = f.serviceResponses?.shift() ?? f.unit;
        return Object.entries(unit).map(([key, value]) => `${key}=${value}`).join("\n") + "\n";
      }
      if (file === devtunnel) {
        assert.deepEqual(args, ["show", tunnelId, "--json"]);
        if (f.probeError) throw f.probeError;
        return f.output ?? banner + JSON.stringify({ tunnel: { tunnelId, hostConnections: f.connections } });
      }
      assert.equal(file, "/usr/bin/systemctl");
      assert.deepEqual(args, ["--user", "--no-block", "--job-mode=fail", "try-restart", HOST_SERVICE]);
      f.events.push("restart");
      if (f.restartError) throw f.restartError;
      return "";
    },
  };
  f.check = async (advance = 0) => {
    f.now += advance;
    return checkTunnelHealth(f.options, f.dependencies);
  };
  f.restarts = () => f.calls.filter(call => call.args.includes("try-restart"));
  return f;
}

test("connectivity accepts the actual banner-prefixed CLI shape and only the configured tunnel", () => {
  const [id, clusterId] = tunnelId.split(".");
  for (const document of [
    { tunnel: { tunnelId, hostConnections: 0 } },
    { tunnelId, hostConnections: 0 },
    { tunnel: { tunnelId: id, clusterId, hostConnections: 0 } },
    { tunnelId: id, clusterId, status: { hostConnectionCount: 0 } },
    { tunnel: { tunnelId: id, clusterId, status: { hostConnectionCount: { current: 0, limit: 1 } } } },
  ]) {
    for (const prefix of ["", banner, "Warning: {not JSON}\n"]) {
      assert.equal(hostConnectionCount(prefix + JSON.stringify(document), tunnelId), 0);
    }
  }
  assert.equal(hostConnectionCount(JSON.stringify({ tunnelId, hostConnections: 2 }), tunnelId), 2);
  for (const document of [
    null, [], {}, { tunnelId, hostConnections: "0" }, { tunnelId, hostConnections: -1 },
    { tunnelId, hostConnections: 0.5 }, { tunnelId, hostConnections: null },
    { tunnelId, clusterId: "euw", hostConnections: 0 },
    { tunnelId: `wrong.${clusterId}`, hostConnections: 0 }, { tunnelId, clientConnections: 0 },
    { tunnelId, hostConnections: 0, status: { hostConnectionCount: 1 } },
  ]) {
    assert.throws(() => hostConnectionCount(JSON.stringify(document), tunnelId), /configured tunnel/);
  }
  for (const output of [banner, '{"token":"do-not-log",}', '{"token":"do-not-log"}\n{}']) {
    assert.throws(() => hostConnectionCount(output, tunnelId), error => !error.message.includes("do-not-log"));
  }
});

test("only three spaced, consecutive offline samples permit recovery", () => {
  let result = offline();
  assert.equal(result.state.failures, 1);
  assert.equal(result.restart, false);
  result = offline(result.state, { now: 1_060_000 });
  assert.equal(result.state.failures, 2);
  assert.equal(result.restart, false);
  result = offline(result.state, { now: 1_120_000 });
  assert.equal(result.state.failures, 3);
  assert.equal(result.restart, true);
  assert.equal(HEALTH_POLICY.restartCooldownMs, 600_000);
});

test("rapid checks, missing intervals, service restarts, reboot and corrupt state reset or defer evidence", () => {
  const first = offline().state;
  const early = offline(first, { now: 1_001_000 });
  assert.equal(early.reason, "waiting-for-next-sample");
  assert.deepEqual(early.state, first);
  for (const overrides of [
    { now: 1_181_000 }, { invocationId: "c".repeat(32) },
    { bootId: "66666666-2222-3333-4444-555555555555" }, { now: 999_999 },
  ]) {
    const next = offline(first, overrides);
    assert.equal(next.state.failures, 1);
    assert.equal(next.restart, false);
  }
  for (const previous of [[], {}, { ...first, failures: 999 }, { ...first, lastRestartAt: "bad" }]) {
    assert.equal(offline(previous).state.failures, 1);
  }
});

test("positive health, unknown probes, manual stops and startup grace break the failure streak", () => {
  const pending = offline(offline().state, { now: 1_060_000 }).state;
  for (const status of ["host-online", "probe-unavailable", "service-inactive", "unrecognized-host"]) {
    const decision = healthDecision(pending, observation({ status, now: 1_120_000 }));
    assert.equal(decision.restart, false);
    assert.equal(decision.state.failures, 0);
    assert.equal(decision.state.sampleAt, null);
  }
  for (const hostAgeMs of [0, 119_999, NaN]) {
    const decision = offline(pending, { hostAgeMs, now: 1_120_000 });
    assert.equal(decision.reason, "startup-grace");
    assert.equal(decision.state.failures, 0);
  }
});

test("a live but disconnected host is recovered once, with cooldown saved before a bounded tunnel-only job", async () => {
  const f = fixture();
  assert.equal((await f.check()).failures, 1);
  assert.equal((await f.check(60_000)).failures, 2);
  const result = await f.check(60_000);
  assert.equal(result.status, "restart-requested");
  assert.equal(result.restartRequested, true);
  assert.equal(f.restarts().length, 1);
  assert.deepEqual(f.events.slice(-2), ["save", "restart"]);
  assert.equal(f.state.lastRestartAt, f.now);
  assert.equal(f.state.failures, 0);
  // A real restart creates a different invocation. It must NOT erase cooldown.
  f.unit.InvocationID = "d".repeat(32);
  await f.check(60_000);
  await f.check(60_000);
  assert.equal((await f.check(60_000)).status, "restart-cooldown");
  for (let count = 0; count < 6; count++) await f.check(60_000);
  assert.equal(f.restarts().length, 1);
  assert.equal((await f.check(60_000)).restartRequested, true);
  assert.equal(f.restarts().length, 2);
});

test("an online host is left running without generating tokens or requesting application/model endpoints", async () => {
  const f = fixture();
  f.connections = 1;
  for (let count = 0; count < 4; count++) assert.equal((await f.check(60_000)).status, "host-online");
  assert.equal(f.state.failures, 0);
  assert.equal(f.restarts().length, 0);
  assert.ok(f.calls.every(call => call.args.includes("show")));
});

test("network, auth, malformed and wrong-tunnel probes never restart and never disclose CLI output", async () => {
  for (const failure of ["error", "malformed", "wrong-tunnel", "missing-count"]) {
    const f = fixture();
    await f.check();
    await f.check(60_000);
    if (failure === "error") f.probeError = new Error("Unauthorized token=do-not-log-this");
    if (failure === "malformed") f.output = '{"token":"do-not-log-this",}';
    if (failure === "wrong-tunnel") f.output = '{"tunnelId":"wrong.usw2","hostConnections":0}';
    if (failure === "missing-count") f.output = JSON.stringify({ tunnelId });
    const result = await f.check(60_000);
    assert.equal(result.status, "probe-unavailable");
    assert.equal(result.failures, 0);
    assert.ok(!JSON.stringify({ result, state: f.state }).includes("do-not-log-this"));
    assert.equal(f.restarts().length, 0);
    f.probeError = undefined;
    f.output = undefined;
    assert.equal((await f.check(60_000)).failures, 1);
  }
});

test("manual stops, queued service jobs, mismatched host commands and new starts do not even probe the tunnel", async () => {
  for (const scenario of ["stopped", "stopping", "job", "command", "startup"]) {
    const f = fixture();
    if (scenario === "stopped") f.unit.ActiveState = "inactive";
    if (scenario === "stopping") f.unit.SubState = "stop-sigterm";
    if (scenario === "job") f.unit.Job = "12345";
    if (scenario === "command") f.args[2] = "different.usw2";
    if (scenario === "startup") f.unit.ActiveEnterTimestampMonotonic = String((f.now - 10_000) * 1000);
    const result = await f.check();
    assert.equal(result.restartRequested, false);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].file, "/usr/bin/systemctl");
  }
});

test("an operator stop or service change between probe and restart cancels recovery", async () => {
  for (const change of [
    { ActiveState: "inactive" }, { MainPID: "999" }, { InvocationID: "e".repeat(32) }, { Job: "99" },
  ]) {
    const f = fixture();
    await f.check();
    await f.check(60_000);
    f.serviceResponses = [f.unit, { ...f.unit, ...change }];
    const result = await f.check(60_000);
    assert.equal(result.status, "service-changed");
    assert.equal(f.restarts().length, 0);
    assert.equal(result.failures, 0);
  }
});

test("rejected restart jobs are rate limited, and an unwritable state never permits an untracked restart", async () => {
  const f = fixture();
  await f.check();
  await f.check(60_000);
  f.restartError = new Error("Conflicting systemd stop job");
  assert.equal((await f.check(60_000)).status, "restart-failed");
  for (let count = 0; count < 4; count++) await f.check(60_000);
  assert.equal(f.restarts().length, 1);
  assert.equal(f.state.lastRestartAt, 1_120_000);

  const g = fixture();
  await g.check();
  await g.check(60_000);
  g.saveError = new Error("fixture write failure");
  await assert.rejects(g.check(60_000), /fixture write failure/);
  assert.equal(g.restarts().length, 0);
});

test("check-only reports health without changing state or requesting a restart", async () => {
  const f = fixture();
  await f.check();
  await f.check(60_000);
  f.options.checkOnly = true;
  const before = JSON.stringify(f.state);
  const result = await f.check(60_000);
  assert.equal(result.wouldRestart, true);
  assert.equal(result.restartRequested, false);
  assert.equal(result.checkOnly, true);
  assert.equal(JSON.stringify(f.state), before);
  assert.equal(f.restarts().length, 0);
});

test("state corruption is conservative, while permission and service-manager failures cannot restart", async () => {
  const f = fixture();
  f.state = '{"broken":';
  assert.equal((await f.check()).failures, 1);
  f.readError = Object.assign(new Error("private-file-details"), { code: "EACCES" });
  await assert.rejects(f.check(), /Cannot read tunnel health state/);
  assert.equal(f.restarts().length, 0);
  const g = fixture();
  g.serviceError = new Error("sensitive-service-details");
  assert.equal((await g.check()).status, "probe-unavailable");
  assert.equal(g.restarts().length, 0);
});

test("real state writes are private and atomic, preserving unrelated files and cooldown across invocations", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codey-tunnel-health-state-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "state.json");
  const unrelated = path.join(root, "unrelated");
  await writeFile(unrelated, "{}");
  await symlink(unrelated, file);
  const f = fixture();
  f.options.stateFile = file;
  const originalRead = f.dependencies.read;
  f.dependencies.read = name => name === file ? readFile(file, "utf8") : originalRead(name);
  delete f.dependencies.save; // Exercise the real atomic filesystem implementation.
  assert.equal((await f.check()).failures, 1);
  assert.equal(await readFile(unrelated, "utf8"), "{}");
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await f.check(60_000)).failures, 2);
  assert.equal((await f.check(60_000)).restartRequested, true);
  const state = JSON.parse(await readFile(file, "utf8"));
  assert.equal(state.lastRestartAt, f.now);
  assert.equal(state.failures, 0);
  assert.deepEqual((await readdir(root)).sort(), ["state.json", "unrelated"]);
});

test("CLI arguments cannot select another unit and hung commands are killed within their budget", async () => {
  assert.deepEqual(healthOptions([devtunnel, tunnelId, stateFile, "--check"]),
    { devtunnel, tunnelId, stateFile, checkOnly: true });
  for (const args of [
    [], ["relative", tunnelId, stateFile], [devtunnel, "bad --token=secret", stateFile],
    [devtunnel, tunnelId, stateFile, "codey-cloudcli.service"],
  ]) assert.throws(() => healthOptions(args), /Usage:/);
  await assert.rejects(boundedCommand(process.execPath, ["-e",
    'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'], 150),
  error => error.killed === true && error.signal === "SIGKILL");
  await assert.rejects(boundedCommand(process.execPath, ["-e",
    `console.log(${JSON.stringify(JSON.stringify({ tunnelId, hostConnections: 0 }))}); process.exit(7);`], 5000),
  error => error.code === 7);
});

const installer = fileURLToPath(new URL("../skills/config-new-codey-machine/scripts/install-devtunnel-health.sh", import.meta.url));
async function installFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "codey-tunnel-health-install-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const systemd = path.join(home, ".config/systemd/user");
  const tunnel = path.join(home, ".local/share/codey-tools/devtunnel/devtunnel");
  const stubs = path.join(root, "bin");
  await mkdir(systemd, { recursive: true });
  await mkdir(path.dirname(tunnel), { recursive: true });
  await mkdir(stubs);
  await writeFile(tunnel, "#!/bin/sh\nexit 88\n", { mode: 0o700 });
  const host = `[Service]\nExecStart=${tunnel} host ${tunnelId} --host-header unchanged --origin-header unchanged\n`;
  await writeFile(path.join(systemd, HOST_SERVICE), host);
  const calls = path.join(root, "calls");
  await writeFile(path.join(stubs, "systemctl"), `#!/bin/sh
printf '%s\\n' "$*" >>"$CODEY_TEST_CALLS"
case "$*" in
  "--user show codey-devtunnel.service -p FragmentPath --value") printf '%s\\n' "$HOME/.config/systemd/user/codey-devtunnel.service";;
  "--user show codey-devtunnel.service -p DropInPaths --value") printf '%s' "\${CODEY_TEST_DROPINS:-}";;
  "--user daemon-reload"|"--user enable --now codey-devtunnel-health.timer") ;;
  *) echo 'Unexpected service operation' >&2; exit 88;;
esac
`, { mode: 0o700 });
  const env = { ...process.env, HOME: home, PATH: `${stubs}:${process.env.PATH}`, CODEY_TEST_CALLS: calls };
  const install = (extraEnv = {}) => exec("bash", [installer, process.execPath, tunnel, tunnelId],
    { env: { ...env, ...extraEnv } });
  return { root, home, systemd, tunnel, host, calls, install };
}

test("maintenance installer is idempotent, private, validates units and never restarts a running service", {
  skip: process.platform !== "linux",
}, async t => {
  const f = await installFixture(t);
  await f.install();
  const runtime = path.join(f.home, ".local/share/codey-machine/linux-devtunnel-health.mjs");
  const service = path.join(f.systemd, "codey-devtunnel-health.service");
  const timer = path.join(f.systemd, "codey-devtunnel-health.timer");
  const before = await stat(runtime);
  for (const file of [runtime, service, timer]) assert.equal((await stat(file)).mode & 0o777, 0o600);
  const state = path.join(f.home, ".local/state/codey-machine/devtunnel-health.json");
  await writeFile(state, "preserve cooldown");
  await f.install();
  assert.equal((await stat(runtime)).mtimeMs, before.mtimeMs);
  assert.equal(await readFile(state, "utf8"), "preserve cooldown");
  assert.equal(await readFile(path.join(f.systemd, HOST_SERVICE), "utf8"), f.host);
  assert.ok(!(await readFile(f.calls, "utf8")).includes("restart"));
  const unit = await readFile(service, "utf8");
  assert.match(unit, /TimeoutStartSec=45s/);
  assert.ok(unit.includes(`ExecStart=${process.execPath} ${runtime} ${f.tunnel} ${tunnelId} ${state}`));
  assert.match(await readFile(timer, "utf8"), /OnUnitInactiveSec=1min/);
  const runtimeDirectory = path.join(f.root, "xdg-runtime");
  await mkdir(runtimeDirectory, { mode: 0o700 });
  const env = { ...process.env, HOME: f.home, XDG_RUNTIME_DIR: runtimeDirectory };
  delete env.DBUS_SESSION_BUS_ADDRESS;
  await exec("systemd-analyze", ["--user", "verify", service, timer], { env });
});

test("maintenance installer rejects overridden/mismatched hosts and replaces a runtime symlink without following it", {
  skip: process.platform !== "linux",
}, async t => {
  const f = await installFixture(t);
  await assert.rejects(f.install({ CODEY_TEST_DROPINS: "/tmp/unknown.conf" }), /overridden/);
  const unit = path.join(f.systemd, HOST_SERVICE);
  await writeFile(unit, f.host.replace(tunnelId, "wrong.usw2"));
  await assert.rejects(f.install(), /must match/);
  await writeFile(unit, f.host);
  const runtime = path.join(f.home, ".local/share/codey-machine");
  await mkdir(runtime, { recursive: true });
  const unrelated = path.join(f.root, "unrelated");
  await writeFile(unrelated, "keep me");
  await symlink(unrelated, path.join(runtime, "linux-devtunnel-health.mjs"));
  await f.install();
  assert.equal(await readFile(unrelated, "utf8"), "keep me");
});
