import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { runDoctor } from "../packages/codey/lib/doctor.mjs";
import { RUNTIME_PLATFORMS } from "../packages/codey/lib/package-info.mjs";

const exec = promisify(execFile);
const doctorUrl = new URL("../packages/codey/lib/doctor.mjs", import.meta.url).href;
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const nativeResult = { sqlite: true, bcrypt: true, ripgrep: true, pty: true, codexSdk: true };
const traceModule = `
const { appendFileSync, readFileSync } = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "../..");
const { mode } = JSON.parse(readFileSync(path.join(root, "probe.json")));
const trace = (event, fields = {}) => appendFileSync(path.join(root, "trace.jsonl"),
  JSON.stringify({ event, pid: process.pid, ...fields }) + "\\n");
`;
const ptyModule = `${traceModule}
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { MessageChannel } = require("node:worker_threads");
module.exports.spawn = (file, args, options) => {
  trace("spawn", { parent: process.ppid });
  assert.equal(file, process.execPath);
  assert.deepEqual(args, ["-e", "process.exit(0)"]);
  assert.equal(options.cwd, root);
  if (mode === "spawn-error") throw new Error("fixture spawn failed");
  if (mode === "early-zero") process.exit(0);
  if (mode === "early-nonzero") process.exit(23);
  if (mode === "blocked-spawn") Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  if (mode === "exit-handler-failure") {
    process.on("exit", () => {
      process.exitCode = 29;
      require("node:fs").writeSync(2, "fixture exit failure");
    });
  }
  const waits = ["timeout", "kill-throws", "kill-races-success", "blocked-kill"].includes(mode);
  const child = spawn(file, waits ? ["-e", "setInterval(() => {}, 1000)"] :
    mode === "nonzero" ? ["-e", "process.exit(17)"] : args, { stdio: "ignore", windowsHide: true });
  trace("terminal", { child: child.pid });
  // Model the Windows leak with real referenced handles, not just a mocked promise.
  setInterval(() => {}, 1000);
  const ports = new MessageChannel();
  ports.port1.on("message", () => {});
  let onExit;
  child.on("close", code => {
    trace("terminal-close", { code });
    if (mode === "missing-callback") return;
    setTimeout(() => {
      trace("exit-callback", { code, resources: process.getActiveResourcesInfo() });
      onExit({ exitCode: code, signal: mode === "signal" ? 9 : 0 });
    }, 50);
  });
  return {
    onData() { return { dispose() { trace("data-disposed"); } }; },
    onExit(callback) {
      onExit = callback;
      return { dispose() { trace("exit-disposed"); } };
    },
    kill(signal) {
      trace("kill", { signal: signal || null });
      child.kill(signal);
      if (mode === "kill-races-success") onExit({ exitCode: 0 });
      if (mode === "kill-throws") throw new Error("fixture kill failed");
      if (mode === "blocked-kill") Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    },
  };
};
`;

async function records(root) {
  const raw = await readFile(path.join(root, "trace.jsonl"), "utf8").catch(error => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  return raw.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
}

function running(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

async function fixture(t, mode = "success") {
  const home = await mkdtemp(".codey-doctor-test-");
  const root = path.resolve(home, "package with spaces 测试");
  t.after(async () => {
    const pids = new Set((await records(root)).flatMap(row => [row.child, row.pid]).filter(Boolean));
    for (const pid of pids) {
      if (pid !== process.pid && running(pid)) {
        try { process.kill(pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
      }
    }
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  async function put(name, contents) {
    const file = path.join(root, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, contents);
  }
  const pkg = { name: "codey", version: "0.1.5", type: "module", bin: { codey: "bin/codey.mjs" },
    imports: { "#codey/codex-sdk": "./sdk.mjs" } };
  const lock = JSON.stringify({ name: pkg.name, version: pkg.version, lockfileVersion: 3,
    packages: { "": { name: pkg.name, version: pkg.version } } });
  const entry = "// doctor fixture\n";
  await put("package.json", JSON.stringify(pkg));
  await put("npm-shrinkwrap.json", lock);
  await put("codey-build.json", JSON.stringify({
    schema: 1, name: pkg.name, version: pkg.version, sourceCommit: "a".repeat(40),
    runtimePlatforms: RUNTIME_PLATFORMS, lockSha256: digest(lock),
    workspaceEntrySha256: digest(entry), gatewayEntrySha256: digest(entry),
  }));
  await put("gateway/main.js", entry);
  await put("dist-server/server/index.js", entry);
  await put("probe.json", JSON.stringify({ mode }));
  for (const [name, source] of Object.entries({
    "better-sqlite3": `${traceModule}
      module.exports = class {
        constructor(file) { if (file !== ":memory:") throw new Error("Unexpected database"); }
        prepare(sql) {
          if (sql !== "SELECT 1") throw new Error("Unexpected SQL");
          return { get() { trace("sqlite-query"); return { "1": 1 }; } };
        }
        close() { trace("sqlite-close"); }
      };`,
    bcrypt: `${traceModule}
      module.exports = {
        hashSync(value, rounds) { trace("bcrypt-hash"); return rounds === 4 ? value : ""; },
        compareSync(value, hash) { trace("bcrypt-compare"); return value === hash; },
      };`,
    "@vscode/ripgrep": `module.exports.rgPath = process.execPath;`,
    "node-pty": ptyModule,
  })) {
    await put(path.join("node_modules", name, "package.json"),
      JSON.stringify({ name, main: "index.cjs" }));
    await put(path.join("node_modules", name, "index.cjs"), source);
  }
  await put("sdk.mjs", `
    import { appendFileSync } from "node:fs";
    appendFileSync(new URL("trace.jsonl", import.meta.url),
      JSON.stringify({ event: "sdk", pid: process.pid }) + "\\n");
  `);
  return root;
}

async function doctor(root, ptyTimeout = 2000) {
  return exec(process.execPath, ["--input-type=module", "-e", `
    import { appendFileSync } from "node:fs";
    import path from "node:path";
    import { checkNativeModules, runDoctor } from ${JSON.stringify(doctorUrl)};
    const root = process.argv[1];
    appendFileSync(path.join(root, "trace.jsonl"),
      JSON.stringify({ event: "doctor", pid: process.pid }) + "\\n");
    try {
      await runDoctor(root, ["--json"], {
        nativeCheck: root => checkNativeModules(root, { ptyTimeout: ${ptyTimeout} }),
      });
      console.log("doctor-still-running");
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  `, root], { timeout: 8000, killSignal: "SIGKILL", windowsHide: true, maxBuffer: 65536 });
}

async function assertProbesStopped(root) {
  const rows = await records(root);
  const pids = [...new Set(rows.flatMap(row => [row.pid, row.child]).filter(Boolean))];
  for (let attempt = 0; attempt < 100 && pids.some(running); attempt++) await delay(20);
  for (const pid of pids) assert.equal(running(pid), false, `Owned process ${pid} must exit`);
  return rows;
}

test("doctor completes a real child despite lingering PTY MessagePort and timer handles", { timeout: 12000 }, async t => {
  const root = await fixture(t);
  const { stdout, stderr } = await doctor(root);
  assert.equal(stderr, "");
  const [report, continuation] = stdout.trim().split("\n");
  assert.deepEqual(JSON.parse(report).native, nativeResult);
  assert.equal(JSON.parse(report).ok, true);
  assert.equal(continuation, "doctor-still-running", "Only the probe may explicitly exit");
  const rows = await assertProbesStopped(root);
  const owner = rows.find(row => row.event === "doctor").pid;
  const probe = rows.find(row => row.event === "spawn");
  assert.notEqual(probe.pid, owner, "node-pty must not load in the doctor process");
  assert.equal(probe.parent, owner);
  const exited = rows.find(row => row.event === "exit-callback");
  assert.equal(exited.code, 0);
  assert.ok(exited.resources.includes("MessagePort"));
  assert.ok(exited.resources.includes("Timeout"));
  for (const event of ["sqlite-query", "sqlite-close", "bcrypt-hash", "bcrypt-compare", "sdk"]) {
    assert.equal(rows.find(row => row.event === event).pid, owner);
  }
  for (const event of ["data-disposed", "exit-disposed"]) {
    assert.equal(rows.filter(row => row.event === event).length, 1);
  }
  assert.equal(rows.some(row => row.event === "kill"), false, "Do not kill an already-exited PTY");
});

for (const [mode, message] of [
  ["nonzero", /exit code 17/],
  ["signal", /signal 9/],
  ["spawn-error", /fixture spawn failed/],
  ["early-zero", /missing exit confirmation/],
  ["early-nonzero", /PTY native check failed/],
  ["exit-handler-failure", /fixture exit failure/],
  ["missing-callback", /timed out/],
  ["timeout", /timed out/],
  ["kill-throws", /timed out/],
  ["kill-races-success", /timed out/],
  ["blocked-spawn", /timed out/],
  ["blocked-kill", /timed out/],
]) {
  test(`doctor rejects ${mode} without reporting ok and terminates its owned probe`, { timeout: 12000 }, async t => {
    const root = await fixture(t, mode);
    const timesOut = /timed out/.test(message.source);
    await assert.rejects(doctor(root, timesOut ? 500 : 2000), error => {
      assert.equal(error.code, 1, "Doctor must finish with failure, not hit the test watchdog");
      assert.equal(error.killed, false);
      assert.equal(error.stdout, "", "No success report or continuation on native failure");
      assert.match(error.stderr, message);
      return true;
    });
    const rows = await assertProbesStopped(root);
    if (["timeout", "kill-throws", "kill-races-success", "blocked-kill", "missing-callback"].includes(mode)) {
      assert.equal(rows.filter(row => row.event === "kill").length, 1);
    }
    if (mode === "nonzero") {
      assert.equal(rows.find(row => row.event === "exit-callback").code, 17);
      assert.ok(rows.some(row => row.event === "exit-disposed"));
    }
    if (mode === "exit-handler-failure") {
      assert.equal(rows.find(row => row.event === "exit-callback").code, 0,
        "Even a successful PTY callback must not pass before the probe process completes");
    }
  });
}

test("doctor retains injected native checks, package-only behavior, and failure output ordering", async t => {
  const root = await fixture(t);
  const logs = [];
  let calls = 0;
  const nativeCheck = async checkedRoot => {
    assert.equal(checkedRoot, root);
    calls++;
    throw new Error("injected native failure");
  };
  const options = { nativeCheck, log: value => logs.push(JSON.parse(value)) };
  const result = await runDoctor(root, ["--package-only", "--json"], options);
  assert.equal(result.native, null);
  assert.equal(calls, 0);
  logs.length = 0;
  await assert.rejects(runDoctor(root, ["--json"], options), /injected native failure/);
  assert.equal(calls, 1);
  assert.deepEqual(logs, []);
  await writeFile(path.join(root, "gateway/main.js"), "changed");
  await assert.rejects(runDoctor(root, [], options), /fingerprint mismatch/);
  assert.equal(calls, 1);
  assert.deepEqual(logs, []);
});
