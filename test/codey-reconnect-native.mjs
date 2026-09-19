/** Opt-in native Linux acceptance. Uses the installed CLI; never patches an installation.
 * node test/codey-reconnect-native.mjs --apply HOST PACKAGE.tgz SHA256 PRIVATE_OUTPUT_DIR
 * The only process explicitly stopped is this test's uniquely named submitter service.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, readFile, readlink, readdir, realpath, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile), pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const home = os.userInfo().homedir, self = fileURLToPath(import.meta.url);
const runtime = path.join(home, ".config/codey-machine/runtime.json");
const read = async file => JSON.parse(await readFile(file, "utf8"));
const write = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
const run = async (exe, args) => (await execute(exe, args, { timeout: 180000, maxBuffer: 2 * 1024 * 1024 })).stdout.trim();
const ctl = args => run("/usr/bin/systemctl", ["--user", ...args]);
const startTicks = value => value.slice(value.lastIndexOf(")") + 2).split(" ")[19];
async function independentCodex() {
  const result = [];
  for (const pid of (await readdir("/proc")).filter(name => /^[1-9]\d*$/.test(name))) {
    try {
      if ((await stat(`/proc/${pid}`)).uid !== process.getuid() ||
          !/\/codex$/.test(await readlink(`/proc/${pid}/exe`))) continue;
      const command = await readFile(`/proc/${pid}/cmdline`, "utf8");
      const group = await readFile(`/proc/${pid}/cgroup`, "utf8");
      if (command.split("\0").includes("app-server") && !/\/codey-(?:cloudcli|copilot-api)\.service(?:\/|$)/m.test(group)) {
        result.push({ pid: Number(pid), startTicks: startTicks(await readFile(`/proc/${pid}/stat`, "utf8")) });
      }
    } catch (error) {
      if (!["ENOENT", "ESRCH", "EACCES", "EPERM"].includes(error.code)) throw error;
    }
  }
  return result;
}
const hash = async file => {
  try { return createHash("sha256").update(await readFile(file)).digest("hex"); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
};

if (process.argv[2] === "--submit") {
  const request = await read(process.argv[3]), config = await read(runtime);
  assert.equal(request.computer, os.hostname());
  // A real ancestor check, with a clearly documented simulated Codex caller.
  // No --background flag: the public CLI must choose its safe automatic mode.
  process.title = "codex (Codey reconnect acceptance fixture)";
  const queued = JSON.parse(await run(config.nodeExe, [config.codeyBin, "update", request.package,
    "--sha256", request.sha256, "--json"]));
  await write(path.join(request.output, "queued.json"), queued);
  setInterval(() => {}, 1000); // The observer explicitly stops this dedicated test service.
} else {
  const [apply, computer, archive, sha256, output] = process.argv.slice(2);
  assert.equal(apply, "--apply", "Native acceptance requires explicit --apply");
  assert.equal(computer, os.hostname(), "Wrong test machine");
  assert.equal(process.platform, "linux");
  assert.match(sha256 ?? "", /^[a-f0-9]{64}$/);
  assert.ok(output?.startsWith(home + path.sep));
  assert.equal(await hash(archive), sha256);
  const config = await read(runtime), identity = await read(config.identityFile);
  assert.equal(config.ownerHome, home);
  assert.equal(config.ownerUid, process.getuid());
  const common = await import(pathToFileURL(path.join(config.codeyDirectory, "onboarding/scripts/machine-common.mjs")));
  await common.checkedPath(output, home);
  await mkdir(output, { mode: 0o700 }); // A fresh report directory; never overwrite a previous run.
  const helper = await import(pathToFileURL(path.join(config.codeyDirectory, "onboarding/scripts/windows-runtime.mjs")));
  const { WebSocket } = createRequire(path.join(config.codeyDirectory, "package.json"))("ws");
  const certificate = await readFile(config.certificate);
  const sensitive = [config.identityFile, config.certificate, config.environment.CODEY_PORTAL_TLS_KEY,
    config.environment.COPILOT_API_CODEY_SIGNING_KEY_FILE, path.join(config.codexHome, "config.toml"),
    path.join(config.codexHome, "models.json"), path.join(config.codexHome, "auth.json"),
    path.join(config.environment.COPILOT_API_HOME, "github_token"),
    path.join(config.environment.COPILOT_API_HOME, "github-cli.json"),
    path.join(config.environment.COPILOT_API_HOME, "config.json"), path.join(home, ".config/gh/hosts.yml")].filter(Boolean);
  const protect = async () => Object.fromEntries(await Promise.all(sensitive.map(async file => [file, await hash(file)])));
  const protectedServices = computer === "zhn-a100" ? ["niuma-workbench.service", "niuma-model-link.service"] :
    ["niuma-workbench.service", "niuma-gateway.service", "niuma-core-demo.service", "niuma-tunnel.service",
      "penpot-mcp-browser.service", "voice-agent-code-mcp.service", "voice-agent-tests-dashboard.service",
      "codey-completion-preview-v3-20260906.service"];
  const otherServices = async () => ctl(["show", ...protectedServices, "--property=Id,MainPID,ActiveState"]);
  const before = { computer, nodeId: config.nodeId, entrySha256: config.codeyEntrySha256,
    protectedHashes: await protect(), otherServices: await otherServices(),
    independentCodex: await independentCodex(),
    tunnelPid: Number(await ctl(["show", "codey-devtunnel.service", "--property=MainPID", "--value"])) };
  await write(path.join(output, "before.json"), before);
  const unit = `codey-reconnect-submitter-${randomBytes(8).toString("hex")}.service`;
  const requestFile = path.join(output, "submit.json");
  await write(requestFile, { computer, package: await realpath(archive), sha256, output });
  const opened = [], closed = [], started = performance.now();
  let socket, retry, finished = false, submitterStarted = false;
  const connect = () => {
    socket = new WebSocket("wss://127.0.0.1:3001/ws", { ca: certificate, servername: config.serverName,
      rejectUnauthorized: true, handshakeTimeout: 5000,
      headers: { "x-codey-workspace-assertion": helper.workspaceAssertion(identity, "/ws") } });
    socket.on("open", () => opened.push(performance.now()));
    socket.on("error", () => {}); // Never print a credential-bearing request.
    socket.on("close", () => {
      closed.push(performance.now());
      if (!finished) retry = setTimeout(connect, 3000); // Same retry interval as the client.
    });
  };
  const until = async condition => {
    while (!await condition()) {
      assert.ok(performance.now() - started < 180000, "Native reconnect acceptance exceeded 180 seconds");
      await pause(100);
    }
  };
  try {
    connect();
    await until(() => opened.length > 0);
    const submittedAt = performance.now();
    await run("/usr/bin/systemd-run", ["--user", "--quiet", "--collect", "--unit=" + unit,
      "--property=Type=exec", "--property=UMask=0077", "--property=Restart=no",
      "--property=RuntimeMaxSec=5min", "--property=StandardOutput=null", "--property=StandardError=null",
      "--", config.nodeExe, self, "--submit", requestFile]);
    submitterStarted = true;
    let queued;
    await until(async () => {
      try { queued = await read(path.join(output, "queued.json")); return true; }
      catch (error) { if (error.code === "ENOENT") return false; throw error; }
    });
    assert.equal(queued.queued, true);
    assert.equal(queued.changed, false);
    const workerUnit = `codey-update-${queued.jobId}.service`;
    const workerPid = Number(await ctl(["show", workerUnit, "--property=MainPID", "--value"]));
    const submitterPid = Number(await ctl(["show", unit, "--property=MainPID", "--value"]));
    assert.ok(workerPid > 0 && submitterPid > 0 && workerPid !== submitterPid);
    const workerGroup = await ctl(["show", workerUnit, "--property=ControlGroup", "--value"]);
    const submitterGroup = await ctl(["show", unit, "--property=ControlGroup", "--value"]);
    assert.notEqual(workerGroup, submitterGroup);
    await ctl(["stop", unit]); // Never stops another Codey/Niuma/Codex service.
    submitterStarted = false;
    let status;
    await until(async () => {
      status = await read(queued.statusFile);
      return ["completed", "failed", "needs-review"].includes(status.state);
    });
    assert.equal(status.state, "completed", "Inspect private updater report on failure; do not retry automatically");
    let disconnectedAt, reconnectedAt;
    await until(() => {
      disconnectedAt = closed.find(at => at >= submittedAt);
      reconnectedAt = opened.find(at => at > disconnectedAt);
      return reconnectedAt !== undefined;
    });
    const after = await read(runtime);
    assert.notEqual(after.codeyEntrySha256, before.entrySha256);
    assert.equal(after.nodeId, before.nodeId);
    assert.deepEqual(await protect(), before.protectedHashes);
    assert.equal(await otherServices(), before.otherServices);
    for (const process of before.independentCodex) {
      assert.equal(startTicks(await readFile(`/proc/${process.pid}/stat`, "utf8")), process.startTicks,
        "An independent Codex app-server exited or was replaced");
    }
    const nativeTunnelPreserved = config.tunnelAuth?.source !== "gh";
    if (nativeTunnelPreserved) assert.equal(
      Number(await ctl(["show", "codey-devtunnel.service", "--property=MainPID", "--value"])), before.tunnelPid);
    const cliStatus = JSON.parse(await run(after.nodeExe, [after.codeyBin, "update", "--status", "--json"]));
    const doctor = JSON.parse(await run(after.nodeExe, [after.codeyBin, "doctor", "--json"]));
    assert.equal(cliStatus.state, "completed");
    assert.equal(doctor.ok, true);
    const report = { ok: true, computer, jobId: queued.jobId, simulatedCodexAncestor: true,
      independentWorker: true, survivedSubmitterTermination: true, websocketConnections: opened.length,
      websocketReconnectMs: Math.round(reconnectedAt - disconnectedAt), totalMs: Math.round(performance.now() - started),
      updateTimings: status.timings, protectedFilesUnchanged: true, otherServicesUnchanged: true,
      protectedServices, independentCodexPidsPreserved: before.independentCodex.map(item => item.pid),
      nativeTunnelPreserved, measurementScope: "local authenticated Workspace WebSocket, not the Portal/tunnel relay",
      fromEntry: before.entrySha256, toEntry: after.codeyEntrySha256, doctorChecks: doctor.checks.length };
    await write(path.join(output, "report.json"), report);
    console.log(JSON.stringify(report));
  } finally {
    finished = true;
    clearTimeout(retry);
    socket?.terminate();
    if (submitterStarted) await ctl(["stop", unit]).catch(() => {});
  }
}
