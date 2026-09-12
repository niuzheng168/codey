// Invoked only inside the native transaction's original-owner installer mutex.
// Freshly revalidates the Portal lease before either isolated synthetic model call.
import { mkdir, readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import os from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";
import { Client, readJson, requireValue, save, validateConfig } from "./client.mjs";
import { Runtime, controlEnvironment, directory, execute, exists, objectHash, ownedPath, protectedHashes } from "./runtime.mjs";

export async function verifyRequest(request, {
  config, runtimeConfig, client = new Client(config), command = execute, now = Date.now,
  platform = "windows-x64", runtimeFile = path.join(os.homedir(), ".config/codey-machine-windows/runtime.json"),
} = {}) {
  const target = `${process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : process.platform}-${process.arch}`;
  requireValue(["windows-x64", "macos-arm64", "macos-x64"].includes(platform) && platform === target, "unsupported_platform");
  const manifestFile = await exists(path.join(directory, "lib/node-update-manifest.mjs"))
    ? path.join(directory, "lib/node-update-manifest.mjs") : path.resolve(directory, "../../src/node-update-manifest.mjs");
  const { verifyNodeRelease } = await import(pathToFileURL(manifestFile));
  const signed = verifyNodeRelease(request.envelope, config.releasePublicKey, now());
  requireValue(signed.digest === request.digest && signed.release.id === request.release.id &&
    signed.release.platform === platform && objectHash(signed.release) === objectHash(request.release) &&
    request.jobId === path.basename(request.job), "signature_invalid");
  const serviceEnv = platform.startsWith("macos-") ? runtimeConfig.environment : runtimeConfig.services.codey.environment;
  requireValue(runtimeConfig.nodeId === config.nodeId && runtimeConfig.portalOrigin === config.portalOrigin &&
    serviceEnv.CODEY_PORTAL_PRINCIPAL_ID === config.ownerId && serviceEnv.CODEY_PORTAL_USERNAME === config.username);
  const root = await realpath(runtimeConfig.codeyDirectory), candidate = await realpath(request.candidate);
  requireValue(process.platform === "win32" ? root.toLowerCase() === candidate.toLowerCase() : root === candidate);
  const notify = () => client.json("/api/node-updater/report", {
    jobId: request.jobId, leaseToken: request.leaseToken, state: "verifying", code: "ok",
  });
  await notify();
  let pending = Promise.resolve(), leaseError = null;
  const timer = setInterval(() => {
    pending = pending.then(notify).catch(error => { leaseError = error; });
  }, 20000);
  const home = os.homedir();
  const probePath = path.join(home, ".local/share/codey-updater/probe");
  await ownedPath(probePath, home);
  await mkdir(probePath, { recursive: true, mode: 0o700 });
  try {
    const cfgHome = runtimeConfig.codexHome;
    const toml = createRequire(path.join(runtimeConfig.codeyDirectory, "package.json"))("@iarna/toml");
    const codexConfig = toml.parse((await readFile(path.join(cfgHome, "config.toml"), "utf8")).replace(/^\uFEFF/, ""));
    const node = runtimeConfig.nodeExe;
    const input = {
      mode: "verify", nodeId: config.nodeId, ownerId: config.ownerId, username: config.username,
      portalOrigin: config.portalOrigin, runtimeFile,
      cloudcliPath: runtimeConfig.codeyDirectory, probePath,
      model: codexConfig.model, effort: codexConfig.model_reasoning_effort,
    };
    // execFile cannot supply stdin; use the same reviewed child process runner
    // with spawn below for this one exact probe. No caller-controlled command.
    const codey = await runCodeyProbe(node, input, controlEnvironment(home), request.job);
    requireValue(codey.passed && codey.codeyModel && codey.syntheticSessionArchived, "model_failed");
    if (leaseError) throw leaseError;
    const cli = runtimeConfig.codexExe;
    requireValue(serviceEnv.CODEY_CODEX_EXECUTABLE === cli, "model_login_required");
    const env = { ...controlEnvironment(home), CODEX_HOME: cfgHome };
    for (const provider of Object.values(codexConfig.model_providers || {})) {
      if (provider.env_key) {
        const value = serviceEnv[provider.env_key];
        requireValue(typeof value === "string" && value.length > 0, "model_login_required");
        env[provider.env_key] = value;
      }
    }
    const answer = path.join(request.job, "codex-answer.txt");
    const args = ["exec", "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only", "--json",
      "--config", 'approval_policy="never"', "--output-last-message", answer];
    for (const name of Object.keys(codexConfig.mcp_servers || {})) {
      requireValue(/^[A-Za-z0-9_-]+$/.test(name));
      args.push("--config", `mcp_servers.${name}.enabled=false`);
    }
    args.push("Authorized model connectivity check. Reply with exactly CODEX_NODE_UPDATE_OK. Do not use tools, browse, read files, or make changes.");
    await command(cli, args, { env, cwd: probePath, timeout: 90000, log: path.join(request.job, "codex-model.private.log") });
    requireValue((await readFile(answer, "utf8")).trim() === "CODEX_NODE_UPDATE_OK", "model_failed");
    clearInterval(timer);
    await pending;
    if (leaseError) throw leaseError;
    requireValue(objectHash(await protectedHashes(input.runtimeFile, probePath)) === objectHash(request.plan.protected));
    const proof = { passed: true, codeyModel: true, codexModel: true, syntheticSessionArchived: true,
      digest: signed.digest, jobId: request.jobId, checkedAt: now() };
    await save(path.join(request.job, "model-proof.json"), proof);
    return proof;
  } finally {
    clearInterval(timer);
    await pending;
  }
}

async function runCodeyProbe(node, input, env, job) {
  const { spawn } = await import("node:child_process");
  const { writeFile } = await import("node:fs/promises");
  const script = path.join(directory, "../probe.mjs");
  const actual = await exists(path.join(directory, "probe.mjs")) ? path.join(directory, "probe.mjs") : script;
  const result = await new Promise((resolve, reject) => {
    const child = spawn(node, [actual], { env, cwd: input.probePath, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const output = [], errors = [];
    let size = 0;
    const timer = setTimeout(() => { child.kill(); reject(new Error("model_failed")); }, 100000);
    child.stdout.on("data", data => { size += data.length; if (size <= 4 * 1024 * 1024) output.push(data); else child.kill(); });
    child.stderr.on("data", data => { if (errors.reduce((n, v) => n + v.length, 0) < 4 * 1024 * 1024) errors.push(data); });
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => { clearTimeout(timer); resolve({ code, out: Buffer.concat(output), error: Buffer.concat(errors) }); });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(input));
  });
  await writeFile(path.join(job, "probe-verify.private.log"), Buffer.concat([result.out, result.error]), { mode: 0o600 });
  requireValue(result.code === 0, "model_failed");
  return JSON.parse(result.out.toString("utf8"));
}

async function main() {
  requireValue(process.argv.length === 3);
  const request = await readJson(process.argv[2]);
  const home = os.homedir(), expected = path.join(home, ".config/codey-updater/config.json");
  requireValue(request.agentConfig === expected);
  const config = validateConfig(await readJson(expected));
  const runtime = new Runtime(config);
  const runtimeConfig = await readJson(runtime.runtimeFile);
  console.log(JSON.stringify(await verifyRequest(request, { config, runtimeConfig })));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error("model_failed"); process.exitCode = 1; });
}
