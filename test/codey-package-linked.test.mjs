import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { Runtime } from "../node-updater/windows/runtime.mjs";
import { inspectUpdateArchive } from "../packages/codey/lib/update-archive.mjs";
import { execute, readJson } from "../packages/codey/lib/update-files.mjs";
import { runtimePlatform } from "../packages/codey/lib/package-info.mjs";

async function freePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

test("real app-only staging reuses the original dependency files and starts both servers without npm or model calls", {
  skip: !process.env.CODEY_PACKAGE_TGZ || !process.env.CODEY_PACKAGE_REUSE_FROM,
  timeout: 300000,
}, async t => {
  const home = await realpath(os.homedir());
  const job = await mkdtemp(path.join(home, ".codey-linked-stage-"));
  let stop;
  t.after(async () => {
    if (stop) await stop();
    await rm(job, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
  const donor = await realpath(process.env.CODEY_PACKAGE_REUSE_FROM);
  const modules = await realpath(path.join(donor, "node_modules"));
  const lockBefore = await readFile(path.join(donor, "npm-shrinkwrap.json"));
  const acceptanceStarted = Date.now();
  const artifact = await inspectUpdateArchive(process.env.CODEY_PACKAGE_TGZ);
  const packageBytes = (await stat(artifact.file)).size;
  assert.ok(packageBytes <= 8 * 1024 * 1024, "The shared application-only tarball must stay within 8 MiB");
  const platform = runtimePlatform();
  const runtime = new Runtime({}, { home, command: async (file, args, options) => {
    assert.ok(!args.some(arg => ["install", "rebuild", "ci"].includes(arg)), "No npm dependency operation");
    return execute(file, args, options);
  } });
  const started = Date.now();
  const root = await runtime.stage(artifact.file, { platform, components: { codey: {
    version: artifact.pkg.version, sha256: artifact.sha256, entrySha256: artifact.entrySha256,
    commit: artifact.build.sourceCommit, lockSha256: artifact.build.lockSha256,
  } } }, { root: donor, node: process.execPath }, job);
  const stagingMs = Date.now() - started;
  const mode = await readJson(path.join(job, "dependency-mode.json"));
  assert.equal(mode.mode, "reuse-installed-linked");
  assert.equal(mode.copiedBytes, 0);
  assert.equal(mode.copiedFiles, 0);
  assert.equal((await lstat(path.join(root, "node_modules"))).isSymbolicLink(), true);
  assert.equal(await realpath(path.join(root, "node_modules")), modules);
  const doctor = await readJson(path.join(job, "doctor.private.log"));
  assert.equal(doctor.ok, true);
  assert.deepEqual(doctor.native, { sqlite: true, bcrypt: true, ripgrep: true, pty: true, codexSdk: true });
  const isolated = path.join(job, "test-home"), gatewayHome = path.join(isolated, "gateway");
  await mkdir(gatewayHome, { recursive: true });
  const key = "app-only-native-fixture-key-not-a-real-credential";
  await writeFile(path.join(gatewayHome, "config.json"), JSON.stringify({ auth: { apiKeys: [key] } }));
  const env = { HOME: isolated, USERPROFILE: isolated, APPDATA: path.join(isolated, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(isolated, "AppData", "Local"),
    PATH: [path.dirname(process.execPath), ...(process.platform === "win32"
      ? [path.join(process.env.SystemRoot, "System32"), process.env.SystemRoot] : ["/usr/bin", "/bin"])].join(path.delimiter),
    ...Object.fromEntries(["SystemRoot", "ComSpec", "TEMP", "TMP"].filter(name => process.env[name])
      .map(name => [name, process.env[name]])),
    COPILOT_API_HOME: gatewayHome, CODEX_HOME: path.join(isolated, ".codex"),
    DATABASE_PATH: path.join(isolated, "workspace.db"), CODEY_PORTAL_SSO: "false",
    NODE_ENV: "production", CI: "true",
  };
  const workspacePort = await freePort();
  let gatewayPort = await freePort();
  while (workspacePort === gatewayPort) gatewayPort = await freePort();
  const child = spawn(process.execPath, [path.join(root, "bin/codey.mjs"), "start",
    "--workspace-port", String(workspacePort), "--gateway-port", String(gatewayPort)],
  { env, cwd: isolated, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const exited = once(child, "exit");
  let output = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", bytes => { output = (output + bytes).slice(-65536); });
  stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (process.platform === "win32") {
      await promisify(execFile)(path.join(process.env.SystemRoot, "System32", "taskkill.exe"),
        ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 10000 });
    } else child.kill("SIGTERM");
    let timer;
    try {
      await Promise.race([exited, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Isolated smoke did not stop")), 15000);
        timer.unref();
      })]);
    } finally { clearTimeout(timer); }
  };
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    assert.equal(child.exitCode, null, output);
    try {
      const response = await fetch(`http://127.0.0.1:${workspacePort}/health`);
      const viewer = await fetch(`http://127.0.0.1:${gatewayPort}/usage-viewer`);
      if (response.ok && viewer.ok) {
        assert.equal((await response.json()).version, artifact.pkg.version);
        ready = true;
        break;
      }
    } catch { /* Wait only for these isolated listeners. */ }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.ok(ready, output);
  const usage = `http://127.0.0.1:${gatewayPort}/token-usage`;
  assert.equal((await fetch(usage)).status, 401);
  assert.equal((await fetch(usage, { headers: { Authorization: `Bearer ${key}` } })).status, 200);
  await stop();
  assert.deepEqual(await readFile(path.join(donor, "npm-shrinkwrap.json")), lockBefore);
  assert.equal(await realpath(path.join(donor, "node_modules")), modules);
  t.diagnostic(JSON.stringify({ platform, version: artifact.pkg.version, sha256: artifact.sha256, packageBytes, stagingMs,
    stagingAndSmokeMs: Date.now() - acceptanceStarted,
    dependencyFilesCopied: 0, dependencyBytesCopied: 0, nativeAndHttpPassed: true, modelRequests: 0 }));
});
