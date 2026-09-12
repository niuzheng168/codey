import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { npmPackageRoot } from "../scripts/install-codey-runtime.mjs";
import { knownRuntimePlatforms } from "../packages/codey/lib/package-info.mjs";

const exec = promisify(execFile);
const artifact = process.env.CODEY_PACKAGE_TGZ;

async function port() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const result = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return result;
}

test("the identical shared artifact installs, validates native modules and starts both servers on the target OS", {
  skip: !artifact || !["linux", "win32"].includes(process.platform), timeout: 300000,
}, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codey-shared-install-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const home = path.join(directory, "owner home");
  const apiHome = path.join(home, "gateway-data");
  await mkdir(apiHome, { recursive: true });
  const windows = process.platform === "win32";
  if (!windows) {
    const previousMask = process.umask(0o002);
    t.after(() => process.umask(previousMask));
  }
  const env = {
    HOME: home, USERPROFILE: home, APPDATA: path.join(home, "AppData/Roaming"),
    LOCALAPPDATA: path.join(home, "AppData/Local"),
    PATH: [path.dirname(process.execPath), ...(windows
      ? [path.win32.join(process.env.SystemRoot, "System32"), process.env.SystemRoot] : ["/usr/bin", "/bin"])].join(path.delimiter),
    COPILOT_API_HOME: apiHome, CODEX_HOME: path.join(home, ".codex"),
    DATABASE_PATH: path.join(home, "workspace.db"), CODEY_PORTAL_SSO: "false",
    NODE_ENV: "production", CI: "true", ELECTRON_SKIP_BINARY_DOWNLOAD: "1",
    npm_config_cache: path.join(os.homedir(), ".npm"),
    npm_config_userconfig: path.join(home, "npmrc"),
    ...Object.fromEntries(["SystemRoot", "ComSpec", "TEMP", "TMP", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
      "NODE_EXTRA_CA_CERTS", "NODE_USE_SYSTEM_CA"].filter(name => process.env[name]).map(name => [name, process.env[name]])),
  };
  await writeFile(env.npm_config_userconfig, "");
  const key = "shared-runtime-fixture-key-not-a-real-credential";
  await writeFile(path.join(apiHome, "config.json"), JSON.stringify({ auth: { apiKeys: [key] } }));
  const prefix = path.join(home, ".local/share/shared-npm-release");
  const file = path.resolve(artifact);
  const hash = createHash("sha256").update(await readFile(file)).digest("hex");
  const installer = fileURLToPath(new URL("../scripts/install-codey-runtime.mjs", import.meta.url));
  const install = await exec(process.execPath, [installer, "--package", file, "--sha256", hash,
    "--prefix", prefix, "--check"], { env, timeout: 240000, maxBuffer: 8 * 1024 * 1024 });
  assert.match(install.stdout, /"pathChanged":false,"serviceChanges":false/);
  const root = npmPackageRoot(prefix);
  const cli = path.join(root, "bin/codey.mjs");
  const info = JSON.parse((await exec(process.execPath, [cli, "doctor", "--json"], { env, timeout: 20000 })).stdout);
  assert.equal(info.ok, true);
  assert.equal(info.platform, windows ? "windows-x64" : "linux-x64");
  assert.ok(knownRuntimePlatforms(info.runtimePlatforms));
  assert.ok(info.runtimePlatforms.includes(info.platform));
  assert.deepEqual(info.native, { sqlite: true, bcrypt: true, ripgrep: true, pty: true, codexSdk: true });
  assert.equal(info.lockSha256, createHash("sha256").update(await readFile(path.join(root, "npm-shrinkwrap.json"))).digest("hex"));
  if (!windows) assert.equal((await stat(root)).mode & 0o022, 0, "The runtime must stay eligible for owner-only local updates");
  const updateCheck = JSON.parse((await exec(process.execPath, [cli, "update", file, "--check", "--sha256", hash],
    { env, timeout: 20000 })).stdout);
  assert.equal(updateCheck.unchanged, true);
  assert.equal(updateCheck.serviceChanges, false);
  assert.deepEqual((await readdir(path.dirname(root))).filter(name => !name.startsWith(".")), ["codey"]);
  await assert.rejects(stat(path.join(home, ".local/bin")), { code: "ENOENT" });
  await assert.rejects(stat(path.join(home, ".codex")), { code: "ENOENT" });

  const workspacePort = await port();
  let gatewayPort = await port();
  while (gatewayPort === workspacePort) gatewayPort = await port();
  const child = spawn(process.execPath, [cli, "start", "--workspace-port", String(workspacePort),
    "--gateway-port", String(gatewayPort)], { env, cwd: home, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", bytes => { output = (output + bytes).slice(-65536); });
  const exited = once(child, "exit");
  async function stop() {
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (windows) {
      // Only the known test process and its descendants; no service or port takeover.
      await exec(path.win32.join(process.env.SystemRoot, "System32", "taskkill.exe"),
        ["/PID", String(child.pid), "/T", "/F"], { env, windowsHide: true, timeout: 10000 });
    } else {
      child.kill("SIGTERM");
    }
    let timer;
    try {
      await Promise.race([exited, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Shared runtime did not stop")), 15000);
        timer.unref();
      })]);
    } catch (error) {
      if (!windows) child.kill("SIGKILL");
      throw error;
    } finally { clearTimeout(timer); }
  }
  t.after(stop);
  const workspace = `http://127.0.0.1:${workspacePort}`;
  const gateway = `http://127.0.0.1:${gatewayPort}`;
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    assert.equal(child.exitCode, null, output);
    try {
      const health = await fetch(workspace + "/health");
      const viewer = await fetch(gateway + "/usage-viewer");
      if (health.ok && viewer.ok) {
        assert.equal((await health.json()).version, info.version);
        ready = true;
        break;
      }
    } catch { /* Wait only for the two private test listeners. */ }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.ok(ready, output);
  assert.equal((await fetch(gateway + "/token-usage")).status, 401);
  assert.equal((await fetch(gateway + "/token-usage", { headers: { Authorization: `Bearer ${key}` } })).status, 200);
  await stop();
});
