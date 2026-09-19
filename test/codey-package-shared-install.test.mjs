import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { installerPlatform, npmPackageRoot } from "../scripts/install-codey-runtime.mjs";
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
  skip: !artifact || !["linux", "win32", "darwin"].includes(process.platform),
  timeout: process.env.CODEY_PACKAGE_REUSE_FROM ? 900000 : 300000,
}, async t => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "codey-shared-install-")));
  let stopServer;
  t.after(async () => {
    if (stopServer) await stopServer();
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
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
    npm_config_cache: process.env.CODEY_COLD_INSTALL ? path.join(directory, "empty-npm-cache") : path.join(os.homedir(), ".npm"),
    npm_config_userconfig: path.join(home, "npmrc"),
    ...(process.env.CODEY_NPM_REGISTRY ? { CODEY_NPM_REGISTRY: process.env.CODEY_NPM_REGISTRY } : {}),
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
  const reuseArgs = [];
  if (process.env.CODEY_PACKAGE_REUSE_FROM) {
    const donor = path.join(home, "reuse-source/node_modules/codey");
    await mkdir(path.dirname(donor), { recursive: true, mode: 0o700 });
    await cp(process.env.CODEY_PACKAGE_REUSE_FROM, donor, { recursive: true, verbatimSymlinks: true });
    reuseArgs.push("--reuse-from", donor);
  }
  const startedAt = performance.now();
  const install = await exec(process.execPath, [installer, "--package", file, "--sha256", hash,
    "--prefix", prefix, "--no-launcher", ...reuseArgs], {
    env, timeout: reuseArgs.length ? 600000 : 240000, maxBuffer: 8 * 1024 * 1024,
  });
  assert.match(install.stdout, /"pathChanged":false,"serviceChanges":false/);
  if (reuseArgs.length) assert.match(install.stdout, /"dependencyMode":"reuse-installed-offline"/);
  const root = npmPackageRoot(prefix);
  const cli = path.join(root, "bin/codey.mjs");
  const info = JSON.parse((await exec(process.execPath, [cli, "doctor", "--runtime-only", "--json"], { env, timeout: 20000 })).stdout);
  const build = JSON.parse(await readFile(path.join(root, "codey-build.json"), "utf8"));
  assert.equal(info.ok, true);
  assert.equal(info.platform, installerPlatform());
  assert.ok(knownRuntimePlatforms(info.runtimePlatforms));
  assert.ok(info.runtimePlatforms.includes(info.platform));
  assert.deepEqual(info.native, { sqlite: true, bcrypt: true, ripgrep: true, pty: true, codexSdk: true });
  assert.equal(info.lockSha256, createHash("sha256").update(await readFile(path.join(root, "npm-shrinkwrap.json"))).digest("hex"));
  if (!windows) assert.equal((await stat(root)).mode & 0o022, 0, "The runtime must stay owner-private");
  await assert.rejects(exec(process.execPath, [cli, "update"], { env, timeout: 20000 }), /Usage: codey update/);
  assert.deepEqual((await readdir(path.dirname(root))).filter(name => !name.startsWith(".")), ["codey"]);
  await assert.rejects(stat(path.join(home, ".local/bin")), { code: "ENOENT" });
  await assert.rejects(stat(path.join(home, ".codex")), { code: "ENOENT" });

  const workspacePort = await port();
  let gatewayPort = await port();
  while (gatewayPort === workspacePort) gatewayPort = await port();
  const child = spawn(process.execPath, [cli, "start", "--foreground", "--workspace-port", String(workspacePort),
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
  stopServer = stop;
  const workspace = `http://127.0.0.1:${workspacePort}`;
  const gateway = `http://127.0.0.1:${gatewayPort}`;
  let ready = false;
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    assert.equal(child.exitCode, null, output);
    try {
      const health = await fetch(workspace + "/health", { signal: AbortSignal.timeout(5000) });
      const viewer = await fetch(gateway + "/usage-viewer", { signal: AbortSignal.timeout(5000) });
      if (health.ok && viewer.ok) {
        const healthBody = await health.json();
        assert.equal(healthBody.version, info.version);
        if (build.sourceDirty === false) {
          assert.deepEqual(healthBody.codey, {
            name: "codey", version: info.version, commit: info.sourceCommit,
            releaseId: "machine-" + info.entrySha256.slice(0, 16), nodeMajor: info.nodeMajor,
          });
        } else {
          assert.equal(healthBody.codey, undefined, "A development build must not claim a committed release identity");
        }
        ready = true;
        break;
      }
    } catch (error) {
      if (error.code === "ERR_ASSERTION") throw error;
      // Wait only for the two private test listeners.
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.ok(ready, output);
  assert.equal((await fetch(gateway + "/token-usage")).status, 401);
  assert.equal((await fetch(gateway + "/token-usage", { headers: { Authorization: `Bearer ${key}` } })).status, 200);
  const elapsed = (performance.now() - startedAt) / 1000;
  t.diagnostic(`Fresh package install, native modules, both servers and data authentication: ${elapsed.toFixed(1)}s (${process.env.CODEY_COLD_INSTALL ? "empty" : "existing"} npm cache)`);
  if (process.env.CODEY_INSTALL_BUDGET_SECONDS) {
    assert.ok(elapsed < Number(process.env.CODEY_INSTALL_BUDGET_SECONDS), "Runtime installation exceeded the requested time budget");
  }
  await stop();
});
