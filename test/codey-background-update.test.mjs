import assert from "node:assert/strict";
import { cp, lstat, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { Machine, machineOptions, printMachine, runMachine } from "../packages/codey/lib/machine.mjs";
import { updateMachine } from "../packages/codey/lib/machine-update.mjs";
import { readUpdateStatus, runUpdateJob } from "../packages/codey/lib/machine-update-job.mjs";
import { exists, fileHash } from "../packages/codey/lib/package-files.mjs";
import { linuxAdapter, linuxUnitFiles } from "../skills/config-new-codey-machine/scripts/platform-linux.mjs";
import { managedFixture } from "./helpers/managed-node-fixture.mjs";
import { packFixture, treeFiles } from "./codey-update-fixture.mjs";

const internal = () => { throw Object.assign(new Error("external owner terminal"), { code: "CODEY_INTERNAL_TERMINAL" }); };
async function backgroundFixture(t, target) {
  const f = await managedFixture(t, target), next = await f.nextPackage();
  f.jobs = [];
  f.i.adapter.startUpdateJob = async (config, jobId) => f.jobs.push(jobId);
  f.i.adapter.verifyUpdateJob = async (config, jobId) => assert.ok(f.jobs.includes(jobId));
  f.i.adapter.updateJobState = async () => "active";
  f.prepare = async (m, artifact, release) => {
    const app = path.join(release, "app");
    await cp(next.next, app, { recursive: true });
    return app;
  };
  // The actual service creates a NEW Machine; the submitting CLI relinquishes its lease.
  f.worker = () => new Machine(f.i, structuredClone(f.config), f.m.info);
  f.run = async (job, worker = f.worker(), prepare = f.prepare) => runUpdateJob(f.app, job.jobId, {
    open: async () => worker,
    update: (m, options, context) => updateMachine(m, options, { ...context, prepare, activationDelay: 0 }),
  });
  return Object.assign(f, next);
}

test("background/status parser is explicit; status never accepts a package or mutation flags", () => {
  assert.deepEqual(machineOptions("update", ["--status", "--json"]), { status: true, json: true });
  assert.equal(machineOptions("update", ["local.tgz", "--background"]).background, true);
  for (const args of [["--status", "file.tgz"], ["--status", "--check"], ["--status", "--offline"],
    ["--status", "--background"], ["--status", "--sha256", "a".repeat(64)],
    ["--background"], ["file.tgz", "--background=true"], ["file.tgz", "--background", "--background"]]) {
    assert.throws(() => machineOptions("update", args), Error, args.join(" "));
  }
});

test("update help explains acceptance, reconnect limits and platform scope without opening a node", async t => {
  const output = [];
  t.mock.method(console, "log", value => output.push(value));
  await runMachine("/no-installed-package", "update", ["--help"], {
    open: async () => assert.fail("Help must not inspect or mutate a managed node"),
  });
  for (const text of ["--background", "--status", "automatic inside Codex/Workspace",
    "queued is NOT completion", "not automatically replayed", "Windows/macOS", "install.lock"]) {
    assert.ok(output.join("\n").includes(text), text);
  }
});

test("background --check and unchanged packages stay read-only, even inside Codex", async t => {
  const f = await backgroundFixture(t);
  f.i.adapter.external = internal;
  const same = await packFixture(f.app, path.join(f.home, "same.tgz")), before = await treeFiles(f.home);
  assert.equal((await updateMachine(f.m, { file: f.file, background: true, check: true })).check, true);
  assert.equal((await updateMachine(f.m, { file: same, background: true })).changed, false);
  assert.deepEqual(await treeFiles(f.home), before);
  assert.equal(f.jobs.length, 0);
  assert.deepEqual(await readUpdateStatus(f.m), { ok: true, operation: "update", state: "none" });
});

test("Linux update automatically queues in Codex, keeps an exclusive lease and copies a private pinned package", async t => {
  const f = await backgroundFixture(t);
  f.i.adapter.external = internal;
  const job = await updateMachine(f.m, { file: f.file, offline: true });
  assert.equal(job.queued, true);
  assert.equal(job.changed, false, "Acceptance is not completed-update success");
  assert.equal(job.state, "queued");
  assert.equal(f.jobs[0], job.jobId);
  const directory = path.dirname(job.statusFile), archive = path.join(directory, "package.tgz");
  assert.equal(await fileHash(archive), await fileHash(f.file));
  assert.equal((await lstat(directory)).mode & 0o077, 0);
  assert.equal((await lstat(archive)).mode & 0o077, 0);
  assert.equal((await f.m.status()).operationInProgress, true);
  await assert.rejects(updateMachine(f.worker(), { file: f.file, background: true }), /Another node operation/);
  await assert.rejects(f.worker().lifecycle("start"), /Another node operation/);
  assert.ok(!f.calls.some(call => call?.operation === "setStates"));
  const status = await readUpdateStatus(f.m), output = [];
  printMachine(job, false, line => output.push(line));
  assert.match(output.join("\n"), /queued[\s\S]*codey update --status/);
  for (const secret of [f.modelKey, f.identity.workspaceSsoKey, "fixture-github-token"]) {
    assert.ok(!JSON.stringify(status).includes(secret));
    assert.ok(!(await readFile(path.join(directory, "request.json"), "utf8")).includes(secret));
  }
});

test("only a recognized Linux internal-terminal error auto-queues; other errors and platforms fail closed", async t => {
  const f = await backgroundFixture(t);
  f.i.adapter.external = () => { throw new Error("Cannot inspect process ownership"); };
  await assert.rejects(updateMachine(f.m, { file: f.file }), /Cannot inspect/);
  assert.equal(f.jobs.length, 0);
  assert.ok(!await exists(path.join(f.i.configRoot, "install.lock")));
  for (const target of ["windows-x64", "macos-arm64"]) {
    const other = await backgroundFixture(t, target);
    other.i.adapter.external = internal;
    const before = await treeFiles(other.home);
    await assert.rejects(updateMachine(other.m, { file: other.file }), /external owner terminal/);
    await assert.rejects(updateMachine(other.m, { file: other.file, background: true }), /currently require Linux/);
    assert.deepEqual(await treeFiles(other.home), before);
  }
});

test("independent worker completes the normal update, retains settings and reports phases without restarting itself", async t => {
  const f = await backgroundFixture(t), before = structuredClone(f.config);
  const codex = await treeFiles(before.codexHome), gateway = await treeFiles(before.environment.COPILOT_API_HOME);
  f.states[1].running = f.states[1].enabled = false;
  const states = structuredClone(f.states);
  const job = await updateMachine(f.m, { file: f.file, offline: true, background: true });
  const worker = f.worker(), phases = [], write = f.i.write;
  f.i.write = async (file, value) => {
    if (file === job.statusFile) phases.push(value.state);
    await write(file, value);
  };
  assert.equal((await f.run(job, worker)).ok, true);
  assert.deepEqual(phases, ["preparing", "ready", "switching", "verifying", "completed"]);
  assert.ok(f.calls.includes("external"), "The worker still passes the original ancestry guard");
  assert.equal(worker.config.nodeId, before.nodeId);
  assert.equal(worker.config.codexExe, before.codexExe);
  assert.equal(worker.config.modelKey, before.modelKey);
  assert.notEqual(worker.config.codeyDirectory, before.codeyDirectory);
  assert.deepEqual(await treeFiles(before.codexHome), codex);
  assert.deepEqual(await treeFiles(before.environment.COPILOT_API_HOME), gateway);
  assert.deepEqual(f.states.map(s => [s.enabled, s.running]), states.map(s => [s.enabled, s.running]));
  assert.ok(!await exists(path.join(f.i.configRoot, "install.lock")));
  const status = await readUpdateStatus(worker);
  assert.equal(status.state, "completed");
  assert.equal(status.ok, true);
  assert.ok(status.timings.switchMs >= 0);
  assert.ok(status.backup.endsWith(".gz"));
  await assert.rejects(f.run(job, worker), /stale|already used/);
});

test("wrong unit, stale runtime and invalid lease cannot stop services or steal a lock", async t => {
  const f = await backgroundFixture(t);
  const job = await updateMachine(f.m, { file: f.file, background: true });
  f.i.adapter.verifyUpdateJob = async () => { throw new Error("not the main process"); };
  await assert.rejects(f.run(job), /main process/);
  f.i.adapter.verifyUpdateJob = async () => {};
  await writeFile(f.i.file, (await readFile(f.i.file, "utf8")) + "\n");
  assert.equal((await f.run(job)).state, "needs-review");
  assert.match(await readFile(path.join(path.dirname(job.statusFile), "error.log"), "utf8"), /stale/);
  const worker = f.worker();
  await assert.rejects(worker.lock(() => assert.fail("must not run"), { updateJob: "0".repeat(32) }), /another operation/);
  assert.ok(!f.calls.some(call => call?.operation === "setStates"));
  assert.ok(await exists(path.join(f.i.configRoot, "install.lock")));
});

test("a second worker cannot claim or remove a lease already held by the first worker", async t => {
  const f = await backgroundFixture(t);
  const job = await updateMachine(f.m, { file: f.file, background: true });
  let entered, finish;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { finish = resolve; });
  const first = f.worker().lock(async () => { entered(); await gate; }, { updateJob: job.jobId });
  await started;
  try {
    await assert.rejects(f.worker().lock(() => assert.fail("duplicate worker ran"), { updateJob: job.jobId }), { code: "EEXIST" });
    assert.ok(await exists(path.join(f.i.configRoot, "install.lock/claimed")));
    assert.ok(await exists(path.join(f.i.configRoot, "install.lock/update.json")));
  } finally { finish(); await first; }
  assert.ok(!await exists(path.join(f.i.configRoot, "install.lock")));
});

test("failed or ambiguous dispatch retains the lease and cannot claim completion", async t => {
  const f = await backgroundFixture(t);
  f.i.adapter.startUpdateJob = async () => { throw new Error("bus disconnected after acceptance"); };
  f.i.adapter.updateJobState = async () => "unknown";
  await assert.rejects(updateMachine(f.m, { file: f.file, background: true }), /Cannot confirm update worker/);
  assert.ok(await exists(path.join(f.i.configRoot, "install.lock/update.json")));
  assert.equal((await readUpdateStatus(f.m)).state, "needs-review");
  assert.ok(!f.calls.some(call => call?.operation === "setStates"));
});

test("tampered queued package is never executed; the interrupted lease requires review", async t => {
  const f = await backgroundFixture(t);
  const job = await updateMachine(f.m, { file: f.file, background: true });
  await writeFile(path.join(path.dirname(job.statusFile), "package.tgz"), "not the reviewed archive");
  assert.equal((await f.run(job)).state, "needs-review");
  assert.ok(!f.calls.some(call => call?.operation === "setStates"));
  const status = await readUpdateStatus(f.m);
  assert.equal(status.ok, false);
  assert.ok(!JSON.stringify(status).includes("Error:"));
});

test("a corrupted queued request is diagnosed privately without claiming or releasing its lease", async t => {
  const f = await backgroundFixture(t);
  const job = await updateMachine(f.m, { file: f.file, background: true });
  await writeFile(path.join(path.dirname(job.statusFile), "request.json"), "{invalid-json");
  assert.equal((await f.run(job)).state, "needs-review");
  assert.ok(await exists(path.join(path.dirname(job.statusFile), "error.log")));
  assert.ok(await exists(path.join(f.i.configRoot, "install.lock/update.json")));
  assert.ok(!await exists(path.join(f.i.configRoot, "install.lock/claimed")));
  assert.ok(!f.calls.some(call => call?.operation === "setStates"));
});

for (const nativeState of ["inactive", "unknown", "throws"]) {
  test(`status rechecks a completed report when the collected service becomes ${nativeState}`, async t => {
    const f = await backgroundFixture(t);
    const job = await updateMachine(f.m, { file: f.file, background: true });
    f.i.adapter.updateJobState = async () => {
      const status = await f.i.read(job.statusFile);
      await f.i.write(job.statusFile, { ...status, state: "completed" });
      if (nativeState === "throws") throw new Error("private native diagnostic must not leak");
      return nativeState;
    };
    const status = await readUpdateStatus(f.m);
    assert.equal(status.state, "completed");
    assert.equal(status.ok, true);
    assert.ok(!JSON.stringify(status).includes("private native"));
  });
}

test("bus errors leave unfinished jobs explicitly unconfirmed and the CLI reports a failing status", async t => {
  const f = await backgroundFixture(t);
  await updateMachine(f.m, { file: f.file, background: true });
  const previous = process.exitCode, output = [];
  t.after(() => { process.exitCode = previous; });
  t.mock.method(console, "log", line => output.push(line));
  f.i.adapter.updateJobState = async () => { throw new Error(f.modelKey); };
  const status = await runMachine(f.app, "update", ["--status", "--json"], { open: async () => f.m });
  assert.equal(status.state, "needs-review");
  assert.equal(status.ok, false);
  assert.equal(process.exitCode, 1);
  assert.ok(!output.join("").includes(f.modelKey));
  assert.ok(await exists(path.join(f.i.configRoot, "install.lock")));
});

test("preparation failure releases its claimed lock without touching services or leaking errors", async t => {
  const f = await backgroundFixture(t);
  const job = await updateMachine(f.m, { file: f.file, background: true });
  const result = await f.run(job, f.worker(), async () => { throw new Error(f.modelKey); });
  assert.equal(result.state, "failed");
  assert.ok(!await exists(path.join(f.i.configRoot, "install.lock")));
  assert.ok(!f.calls.some(call => call?.operation === "setStates"));
  assert.ok(!JSON.stringify(await readUpdateStatus(f.m)).includes(f.modelKey));
  assert.equal((await lstat(path.join(path.dirname(job.statusFile), "error.log"))).mode & 0o077, 0);
});

for (const phase of ["preparing", "ready", "switching"]) {
  test(`a ${phase} progress-write failure before cutover never stops healthy services`, async t => {
    const f = await backgroundFixture(t);
    const job = await updateMachine(f.m, { file: f.file, background: true });
    const original = await readFile(f.i.file), releases = await readdir(path.join(f.i.root, "releases"));
    const write = f.i.write;
    f.i.write = async (file, value) => {
      if (file === job.statusFile && value.state === phase) throw new Error("report disk unavailable");
      await write(file, value);
    };
    assert.equal((await f.run(job)).state, "failed");
    assert.deepEqual(await readFile(f.i.file), original);
    assert.ok(!f.calls.some(call => call?.operation === "setStates"));
    assert.ok(!await exists(path.join(f.i.configRoot, "install.lock")));
    if (phase === "preparing") assert.deepEqual(await readdir(path.join(f.i.root, "releases")), releases);
  });
}

for (const change of ["runtime", "setup", "services", "ports", "tools"]) {
  test(`out-of-band ${change} changes during preparation abort before stopping or overwriting anything`, async t => {
    const f = await backgroundFixture(t);
    const job = await updateMachine(f.m, { file: f.file, background: true });
    let changedFile, changedBytes;
    const prepare = async (...args) => {
      const app = await f.prepare(...args);
      if (change === "runtime" || change === "setup") {
        changedFile = change === "runtime" ? f.i.file : f.config.setupFile;
        await f.i.write(changedFile, { ...await f.i.read(changedFile), ownerEdit: "must remain" });
        changedBytes = await readFile(changedFile);
      } else if (change === "services") {
        f.states[0].running = f.states[0].enabled = false;
      } else if (change === "ports") f.foreignPort = true;
      else await f.i.write(f.config.codexExe, Buffer.from("owner changed the tool"));
      return app;
    };
    assert.equal((await f.run(job, f.worker(), prepare)).state, "failed");
    assert.ok(!f.calls.some(call => call?.operation === "setStates"));
    if (changedFile) assert.deepEqual(await readFile(changedFile), changedBytes);
    if (change === "services") assert.equal(f.states[0].running, false);
    assert.ok(!await exists(path.join(f.i.configRoot, "install.lock")));
  });
}

test("configuration is rechecked after the grace period, not just before preparing the package", async t => {
  const f = await backgroundFixture(t);
  const job = await updateMachine(f.m, { file: f.file, background: true });
  f.i.pause = async () => f.i.write(f.i.file, { ...f.config, ownerEdit: "during activation grace" });
  assert.equal((await f.run(job)).state, "failed");
  assert.equal((await f.i.read(f.i.file)).ownerEdit, "during activation grace");
  assert.ok(!f.calls.some(call => call?.operation === "setStates"));
});

test("foreign ports already present are rejected before preparation or service changes", async t => {
  const f = await backgroundFixture(t);
  const job = await updateMachine(f.m, { file: f.file, background: true });
  f.foreignPort = true;
  let prepared = false;
  assert.equal((await f.run(job, f.worker(), async () => { prepared = true; })).state, "failed");
  assert.equal(prepared, false);
  assert.ok(!f.calls.some(call => call?.operation === "setStates"));
});

test("ordinary one-shot health activity is not mistaken for an operator changing service state", async t => {
  const f = await backgroundFixture(t);
  const maintenance = { name: "health-job", component: "tunnel", auxiliary: true, enabled: false, running: false };
  f.states.push(maintenance);
  const job = await updateMachine(f.m, { file: f.file, background: true });
  const prepare = async (...args) => {
    const app = await f.prepare(...args);
    maintenance.running = true;
    return app;
  };
  assert.equal((await f.run(job, f.worker(), prepare)).state, "completed");
});

test("post-switch failure rolls back and reports failure, not an accepted/successful update", async t => {
  const f = await backgroundFixture(t);
  const job = await updateMachine(f.m, { file: f.file, background: true }), worker = f.worker();
  worker.verifyRunning = async () => {
    if (worker.config.codeyDirectory !== f.app) throw new Error("new runtime unhealthy");
  };
  assert.equal((await f.run(job, worker)).state, "failed");
  assert.equal(worker.config.codeyDirectory, f.app);
  assert.ok(f.states.every(state => state.running && state.enabled));
  assert.ok(!await exists(path.join(f.i.configRoot, "install.lock")));
});

test("rollback failure preserves the lease and reports manual review", async t => {
  const f = await backgroundFixture(t);
  const job = await updateMachine(f.m, { file: f.file, background: true }), worker = f.worker();
  f.i.adapter.switchPackage = async () => { throw new Error("switch and rollback failed"); };
  assert.equal((await f.run(job, worker)).state, "needs-review");
  assert.ok(await exists(path.join(f.i.configRoot, "install.lock")));
  assert.equal((await readUpdateStatus(worker)).ok, false);
});

test("rollback is not reported successful until the old services pass local health checks", async t => {
  const f = await backgroundFixture(t);
  const job = await updateMachine(f.m, { file: f.file, background: true }), worker = f.worker();
  worker.verifyRunning = async () => { throw new Error("both versions unhealthy"); };
  assert.equal((await f.run(job, worker)).state, "needs-review");
  assert.equal(worker.config.codeyDirectory, f.app);
  assert.ok(await exists(path.join(f.i.configRoot, "install.lock")));
});

test("real Linux adapter preserves unchanged native tunnel units, but includes changed gh workers and their timers", async t => {
  const f = await backgroundFixture(t), adapter = linuxAdapter(f.i);
  const states = Object.keys(linuxUnitFiles(f.config)).map(name =>
    ({ name, component: name.startsWith("codey-devtunnel") ? "tunnel" : "codey" }));
  const next = { ...f.config, codeyDirectory: "/home/new/app", codeyBin: "/home/new/app/bin/codey.mjs" };
  assert.deepEqual(adapter.updateServices(f.config, next, states).map(item => item.name),
    ["codey-copilot-api.service", "codey-cloudcli.service"]);
  const auth = { source: "gh" };
  assert.deepEqual(adapter.updateServices({ ...f.config, tunnelAuth: auth }, { ...next, tunnelAuth: auth }, states), states);
});

test("real Linux adapter dispatches a bounded, credential-free transient service, not a detached Workspace child", async t => {
  const f = await backgroundFixture(t), calls = [], jobId = "b".repeat(32);
  const adapter = linuxAdapter(f.i);
  f.i.run = async (file, args) => {
    calls.push({ file, args });
    return { code: 0, stdout: args.includes("--property=LoadState") ? "not-found\n" : "" };
  };
  await adapter.startUpdateJob(f.config, jobId);
  const run = calls.at(-1);
  assert.equal(run.file, "/usr/bin/systemd-run");
  for (const flag of ["--user", "--collect", "--property=Type=exec", "--property=Restart=no",
    "--property=RuntimeMaxSec=1h", "--property=StandardOutput=null", "--property=StandardError=null"]) assert.ok(run.args.includes(flag));
  assert.ok(run.args.includes(`--unit=codey-update-${jobId}.service`));
  assert.deepEqual(run.args.slice(run.args.indexOf("--") + 1, run.args.indexOf("--") + 3), ["/usr/bin/env", "-i"]);
  assert.ok(!run.args.includes("--scope") && !run.args.includes("--wait") && !run.args.includes("--pipe"));
  assert.ok(!JSON.stringify(calls).includes(f.modelKey));
  assert.ok(!JSON.stringify(calls).includes("CODEY_MODEL_API_KEY="));
  f.i.run = async () => ({ code: 0, stdout: "loaded\n" });
  await assert.rejects(adapter.startUpdateJob(f.config, jobId), /already in use/);
  f.i.run = async () => ({ code: 0, stdout: `Transient=yes\nMainPID=${process.pid + 1}\n` });
  await assert.rejects(adapter.verifyUpdateJob(f.config, jobId), /main process/);
  f.i.run = async () => ({ code: 0, stdout: `Transient=yes\nMainPID=${process.pid}\n` });
  await adapter.verifyUpdateJob(f.config, jobId);
  f.i.run = async () => ({ code: 0, stdout: "inactive\n" });
  assert.equal(await adapter.updateJobState(f.config, jobId), "inactive");
});
