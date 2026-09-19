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
import { installedSetup } from "../packages/codey/lib/install.mjs";
import { checkCopilot } from "../packages/codey/scripts/check-copilot.mjs";

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
  const stubs = path.join(root, "preflight-stubs");
  await mkdir(stubs);
  for (const [name, body] of Object.entries({
    ss: "exit 0", getent: 'printf "fixture:x:%s:1000::%s:/bin/bash\\n" "$(id -u)" "$HOME"', pgrep: "exit 1",
  })) await writeFile(path.join(stubs, name), `#!/bin/sh\n${body}\n`, { mode: 0o700 });
  const apiKey = "local-codey-package-smoke-key-not-a-real-credential";
  await writeFile(path.join(apiHome, "config.json"), JSON.stringify({ auth: { apiKeys: [apiKey] } }));
  const env = {
    PATH: `${stubs}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
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
  const runtimeInstaller = fileURLToPath(new URL("../scripts/install-codey-runtime.mjs", import.meta.url));
  const sha = createHash("sha256").update(await readFile(artifact)).digest("hex");
  const args = [runtimeInstaller, "--package", path.resolve(artifact), "--sha256", sha, "--prefix", prefix];
  const beforeCheck = await readdir(home);
  const plan = JSON.parse((await exec(process.execPath, [...args, "--check"], { env })).stdout);
  assert.equal(plan.fileChanges, false);
  assert.deepEqual(await readdir(home), beforeCheck);
  await exec(process.execPath, args, { env, maxBuffer: 8 * 1024 * 1024, timeout: 240000 });
  const installed = path.join(prefix, "lib/node_modules/codey");
  assert.deepEqual((await readdir(path.join(prefix, "lib/node_modules"))).filter(name => !name.startsWith(".")), ["codey"]);
  const pkg = JSON.parse(await readFile(path.join(installed, "package.json"), "utf8"));
  const build = JSON.parse(await readFile(path.join(installed, "codey-build.json"), "utf8"));
  for (const name of ["react", "react-dom", "mermaid", "lucide-react", "@codemirror/lang-javascript",
    "@nut-tree-fork/nut-js", "screenshot-desktop"]) {
    await assert.rejects(readFile(path.join(installed, "node_modules", name, "package.json")), { code: "ENOENT" });
  }
  assert.equal(createHash("sha256").update(await readFile(path.join(installed, "npm-shrinkwrap.json"))).digest("hex"),
    build.lockSha256, "npm must preserve the signed dependency lock after installation");
  const bin = path.join(home, ".local/bin/codey");
  assert.equal((await exec(bin, ["--version"], { env })).stdout.trim(), `codey ${pkg.version}`);
  const prepared = await installedSetup(installed, publicConfig);
  assert.equal(prepared.manifest.codey.version, pkg.version);
  // The common workflow's native check is exercised with an isolated HOME in
  // machine-install-flow.test.mjs; this smoke test never creates real services.
  const newShell = await exec("bash", ["--noprofile", "-ic", "codey --version"], { env: { HOME: home, PATH: "/usr/bin:/bin" } });
  assert.equal(newShell.stdout.trimEnd().split("\n").at(-1), `codey ${pkg.version}`);

  // Verify both API families and default preservation through the public Copilot entry.
  assert.equal((await checkCopilot(installed, process.execPath,
    { startupTimeout: 60000, requestTimeout: 10000 })).modelRequests, false);

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
  const child = spawn(bin, ["start", "--foreground", "--workspace-port", String(workspacePort), "--gateway-port", String(gatewayPort)], {
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
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    assert.equal(child.exitCode, null, output);
    try {
      const health = await fetch(workspace + "/health", { signal: AbortSignal.timeout(5000) });
      const viewer = await fetch(gateway + "/usage-viewer", { signal: AbortSignal.timeout(5000) });
      if (health.ok && viewer.ok) {
        const healthBody = await health.json();
        assert.equal(healthBody.version, pkg.version);
        if (build.sourceDirty === false) {
          assert.deepEqual(healthBody.codey, {
            name: "codey", version: pkg.version, commit: build.sourceCommit,
            releaseId: "machine-" + createHash("sha256").update(await readFile(path.join(installed, "codey-build.json"))).digest("hex").slice(0, 16),
            nodeMajor: Number(process.versions.node.split(".")[0]),
          }, "The Portal must be able to observe the committed Codey release without an updater");
        } else {
          assert.equal(healthBody.codey, undefined, "A development build must not claim a committed release identity");
        }
        assert.equal(health.headers.get("cache-control"), "no-store");
        assert.match(await viewer.text(), /<html/i);
        ready = true;
        break;
      }
    } catch (error) {
      if (error.code === "ERR_ASSERTION") throw error;
      // Retry connection/startup errors, never hide a failed health contract.
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.ok(ready, output);
  const index = await fetch(workspace + "/");
  assert.equal(index.status, 200);
  const html = await index.text();
  const assets = [...new Set([...html.matchAll(/(?:src|href)="(\/assets\/[^"]+\.(?:js|css))"/g)].map(match => match[1]))];
  assert.ok(assets.some(asset => asset.endsWith(".js")), "Browser entry is still bundled");
  for (const asset of assets) {
    const response = await fetch(workspace + asset);
    assert.equal(response.status, 200, asset);
    assert.match(response.headers.get("content-type"), /javascript|text\/css/, asset);
    assert.ok((await response.arrayBuffer()).byteLength > 0, asset);
  }
  assert.equal((await fetch(gateway + "/token-usage")).status, 401);
  assert.equal((await fetch(gateway + "/token-usage", { headers: { Authorization: `Bearer ${apiKey}` } })).status, 200);
  const pids = (await readFile(`/proc/${child.pid}/task/${child.pid}/children`, "utf8")).trim().split(/\s+/);
  assert.equal(pids.length, 2);
  const entries = [];
  for (const pid of pids) {
    const argv = (await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0");
    assert.equal(await realpath(`/proc/${pid}/cwd`), installed);
    entries.push(path.relative(installed, argv[1]));
    if (argv[1] === path.join(installed, "bin/codey.mjs")) assert.equal(argv[2], "copilot");
    else assert.equal(argv[2], "", "The private CloudCLI worker has no public subcommand or arguments");
  }
  assert.deepEqual(entries.sort(), ["bin/codey.mjs", "lib/workspace.mjs"]);
  child.kill("SIGTERM");
  const [code] = await stopped;
  assert.equal(code, 143, output);
});
