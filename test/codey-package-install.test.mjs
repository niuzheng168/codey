import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { installedSetup } from "../packages/codey/lib/setup.mjs";

const exec = promisify(execFile);
const artifact = process.env.CODEY_PACKAGE_TGZ;

async function unusedPort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

test("built npm package installs as Codey and starts both real servers without user credentials", {
  skip: !artifact || process.platform !== "linux", timeout: 300000,
}, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codey-real-install-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const prefix = path.join(home, ".local");
  const apiHome = path.join(home, "gateway-data");
  await mkdir(apiHome, { recursive: true });
  const apiKey = "local-codey-package-smoke-key-not-a-real-credential";
  await writeFile(path.join(apiHome, "config.json"), JSON.stringify({ auth: { apiKeys: [apiKey] } }));
  const env = {
    PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: home, CODEX_HOME: path.join(home, ".codex"), COPILOT_API_HOME: apiHome,
    DATABASE_PATH: path.join(home, "workspace.db"), CODEY_PORTAL_SSO: "false",
    npm_config_cache: path.join(os.homedir(), ".npm"), CI: "true", NODE_ENV: "production",
    ELECTRON_SKIP_BINARY_DOWNLOAD: "1",
  };
  const npm = path.join(path.dirname(process.execPath), "npm");
  const publicConfig = path.join(home, "setup-public.json");
  await writeFile(publicConfig, JSON.stringify({
    schema: 1, portalOrigin: "https://codey.example.test", platform: "linux-x64",
    network: { mode: "devtunnel" }, tunnelAuthProvider: "github",
    updater: { protocol: 1, releasePublicKey: generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }) },
  }));
  await exec("bash", [fileURLToPath(new URL("../scripts/linux/install-codey.sh", import.meta.url)),
    "--package", path.resolve(artifact), "--node-dir", path.dirname(path.dirname(process.execPath)),
    "--prefix", prefix, "--config", publicConfig, "--check"],
  { env, maxBuffer: 8 * 1024 * 1024, timeout: 240000 });
  const installed = path.join(prefix, "lib/node_modules/codey");
  assert.deepEqual((await readdir(path.join(prefix, "lib/node_modules"))).filter(name => !name.startsWith(".")), ["codey"]);
  assert.deepEqual(await readdir(path.join(prefix, "bin")), ["codey"]);
  const pkg = JSON.parse(await readFile(path.join(installed, "package.json"), "utf8"));
  const build = JSON.parse(await readFile(path.join(installed, "codey-build.json"), "utf8"));
  assert.equal(createHash("sha256").update(await readFile(path.join(installed, "npm-shrinkwrap.json"))).digest("hex"),
    build.lockSha256, "npm must preserve the signed dependency lock after installation");
  const bin = path.join(prefix, "bin/codey");
  assert.equal((await exec(bin, ["--version"], { env })).stdout.trim(), `codey ${pkg.version}`);
  const listing = JSON.parse((await exec(npm, ["ls", "--global", "--prefix", prefix, "--depth=0", "--json"], { env })).stdout);
  assert.deepEqual(Object.keys(listing.dependencies), ["codey"]);
  const setupCheck = JSON.parse((await exec(bin, ["setup", "--config", publicConfig, "--check"], { env })).stdout);
  assert.equal(setupCheck.serviceChanges, false);
  assert.equal(setupCheck.version, pkg.version);

  // Exercise the actual npm-mode Bash preflight only. All service/process/network
  // commands are blocked, and the script is cut before the first service action.
  const preflightRoot = path.join(root, "preflight");
  const preflightAssets = path.join(preflightRoot, "assets");
  const stubs = path.join(preflightRoot, "stubs");
  await mkdir(preflightAssets, { recursive: true });
  await mkdir(stubs);
  await mkdir(path.join(preflightRoot, "scripts"));
  await mkdir(path.join(preflightRoot, "templates"));
  const prepared = await installedSetup(installed, publicConfig);
  const sums = [];
  for (const [name, document] of [["manifest.json", prepared.manifest], ["setup.json", prepared.setup]]) {
    const bytes = JSON.stringify(document) + "\n";
    await writeFile(path.join(preflightAssets, name), bytes);
    sums.push(`${createHash("sha256").update(bytes).digest("hex")}  ${name}`);
  }
  await writeFile(path.join(preflightAssets, "SHA256SUMS"), sums.join("\n") + "\n");
  await writeFile(path.join(preflightRoot, "templates/a100-models.json"), "{}");
  for (const name of ["systemctl", "loginctl", "pkill", "pgrep", "fuser", "curl", "sudo", "npm"]) {
    const body = name === "sudo"
      ? '#!/bin/sh\n[ "$*" = "-n true" ] || exit 88\n'
      : '#!/bin/sh\necho "Unexpected external operation during preflight" >&2\nexit 88\n';
    await writeFile(path.join(stubs, name), body);
    await chmod(path.join(stubs, name), 0o700);
  }
  const setupScript = await readFile(path.join(installed, "onboarding/scripts/install.sh"), "utf8");
  const stop = setupScript.indexOf('log 1 "Install and configure private GitHub DevTunnel"');
  assert.ok(stop > 0);
  const preflightFile = path.join(preflightRoot, "scripts/preflight.sh");
  await writeFile(preflightFile, setupScript.slice(0, stop));
  const entryBefore = await readFile(path.join(installed, "bin/codey.mjs"));
  await exec("bash", [preflightFile], { env: {
    ...env, PATH: `${stubs}:${env.PATH}`, CODEY_INSTALLED_PACKAGE: installed,
    CODEY_SETUP_ASSETS: preflightAssets, CODEY_SETUP_NODE: process.execPath,
  }, timeout: 20000 });
  assert.deepEqual(await readFile(path.join(installed, "bin/codey.mjs")), entryBefore);
  assert.equal(JSON.parse(await readFile(path.join(installed, "package.json"), "utf8")).name, "codey");

  // Exercise only the packaged CLI/PATH helpers in the temporary HOME, not deployment.
  const helpersEnd = setupScript.indexOf('[[ "$(uname -s)"');
  assert.ok(helpersEnd > 0);
  await exec("bash", ["--noprofile", "--norc", "-c",
    setupScript.slice(0, helpersEnd) + '\nwrite_codey_cli "$HOME" "$1" "$2"\n',
    "fixture", process.execPath, installed], { env });
  const newShell = await exec("bash", ["--noprofile", "-ic", "codey --version"], {
    env: { HOME: home, PATH: "/usr/bin:/bin" },
  });
  assert.equal(newShell.stdout.trimEnd().split("\n").at(-1), `codey ${pkg.version}`);
  assert.deepEqual(await readFile(path.join(installed, "bin/codey.mjs")), entryBefore);

  // Defaults belong to Codey itself, not to the one-click installer's config writer.
  const freshApiHome = path.join(home, "fresh-gateway");
  await mkdir(freshApiHome);
  const freshEnv = { ...env, COPILOT_API_HOME: freshApiHome, CODEY_MANAGED: "false" };
  const configPath = path.join(freshApiHome, "config.json");
  await exec(bin, ["gateway", "debug", "--json"], { env: freshEnv });
  const defaults = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(defaults.useResponsesApiWebSocket, false);
  const custom = { ...defaults, useResponsesApiWebSocket: true };
  await writeFile(configPath, JSON.stringify(custom));
  await exec(bin, ["gateway", "debug", "--json"], { env: freshEnv });
  assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), custom);

  // Exercise the actual inlined SDK using a local fake executable, never a paid model call.
  const fakeCodex = path.join(home, "codex-fixture");
  await writeFile(fakeCodex, `#!/bin/sh
cat >/dev/null
printf '%s\\n' '{"type":"thread.started","thread_id":"fixture"}' '{"type":"item.completed","item":{"id":"answer","type":"agent_message","text":"CODEY_SDK_OK"}}' '{"type":"turn.completed","usage":{"input_tokens":0,"cached_input_tokens":0,"output_tokens":0}}'
`);
  await chmod(fakeCodex, 0o700);
  const sdk = await exec(process.execPath, ["--input-type=module", "-e", `
import { Codex } from "#codey/codex-sdk";
const result = await new Codex({codexPathOverride: process.env.CODEY_CODEX_EXECUTABLE})
  .startThread({skipGitRepoCheck: true}).run("fixture");
console.log(result.finalResponse);
`], { cwd: installed, env: { ...env, CODEY_CODEX_EXECUTABLE: fakeCodex } });
  assert.equal(sdk.stdout.trim(), "CODEY_SDK_OK");

  const workspacePort = await unusedPort();
  let gatewayPort = await unusedPort();
  while (gatewayPort === workspacePort) gatewayPort = await unusedPort();
  const child = spawn(bin, ["start", "--workspace-port", String(workspacePort), "--gateway-port", String(gatewayPort)], {
    env, cwd: home, stdio: ["ignore", "pipe", "pipe"], detached: true,
  });
  let output = "";
  child.stdout.on("data", value => { output = (output + value).slice(-65536); });
  child.stderr.on("data", value => { output = (output + value).slice(-65536); });
  const stopped = once(child, "exit");
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      const timer = setTimeout(() => {
        try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already exited. */ }
      }, 12000);
      try { await stopped; } finally { clearTimeout(timer); }
    }
  });
  const workspace = `http://127.0.0.1:${workspacePort}`;
  const gateway = `http://127.0.0.1:${gatewayPort}`;
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    assert.equal(child.exitCode, null, output);
    try {
      const health = await fetch(workspace + "/health");
      const viewer = await fetch(gateway + "/usage-viewer");
      if (health.ok && viewer.ok) {
        assert.equal((await health.json()).version, pkg.version);
        assert.match(await viewer.text(), /<html/i);
        ready = true;
        break;
      }
    } catch { /* Wait for the two real entrypoints. */ }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.ok(ready, output);
  assert.equal((await fetch(workspace + "/")).status, 200);
  assert.equal((await fetch(gateway + "/token-usage")).status, 401);
  assert.equal((await fetch(gateway + "/token-usage", { headers: { Authorization: `Bearer ${apiKey}` } })).status, 200);
  const pids = (await readFile(`/proc/${child.pid}/task/${child.pid}/children`, "utf8")).trim().split(/\s+/);
  assert.equal(pids.length, 2);
  const commands = [];
  for (const pid of pids) {
    const argv = (await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0");
    assert.equal(argv[1], path.join(installed, "bin/codey.mjs"));
    assert.equal(await realpath(`/proc/${pid}/cwd`), installed);
    commands.push(argv[2]);
  }
  assert.deepEqual(commands.sort(), ["gateway", "workspace"]);
  child.kill("SIGTERM");
  const [code] = await stopped;
  assert.equal(code, 143, output);
});
