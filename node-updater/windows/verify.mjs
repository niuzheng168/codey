// Invoked inside the native transaction's original-owner installer mutex.
// Acceptance performs only local read-only checks, never inference or sessions.
import { realpath } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";
import { Client, readJson, requireValue, save, validateConfig } from "./client.mjs";
import { Runtime, checkedReceipt, checkedAcceptanceProof, controlEnvironment, execute, fileHash,
  libraryRoot, objectHash, protectedHashes } from "./runtime.mjs";

const { probeNative } = await import(pathToFileURL(path.join(libraryRoot, "update-probe.mjs")));

export async function verifyRequest(request, {
  config, runtimeConfig, client = new Client(config), command = execute, now = Date.now,
  probe = probeNative, hashes = protectedHashes,
  platform = "windows-x64", runtimeFile = path.join(os.homedir(), ".config/codey-machine-windows/runtime.json"),
} = {}) {
  const target = `${process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : process.platform}-${process.arch}`;
  requireValue(["windows-x64", "macos-arm64", "macos-x64"].includes(platform) && platform === target, "unsupported_platform");
  requireValue(request.acceptance === "authenticated-health-v1", "configuration_changed");
  const signed = checkedReceipt(request, config.releasePublicKey, { now: now(), platform });
  const component = signed.release.components.codey;
  requireValue(Object.keys(signed.release.components).length === 1 &&
    request.version === component.version && request.entrySha256 === component.entrySha256, "signature_invalid");
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
  try {
    const packageInfo = await readJson(path.join(root, "package.json"));
    requireValue(packageInfo.name === "codey" && packageInfo.version === component.version &&
      await fileHash(path.join(root, "codey-build.json")) === component.entrySha256, "health_failed");
    const version = await command(runtimeConfig.nodeExe, [path.join(root, "bin/codey.mjs"), "--version"], {
      env: controlEnvironment(os.homedir()), cwd: root, timeout: 30000,
      log: path.join(request.job, "version.private.log"),
    }).catch(() => { requireValue(false, "health_failed"); });
    requireValue(version.trim() === `codey ${component.version}`, "health_failed");
    const doctor = JSON.parse(await command(runtimeConfig.nodeExe, [path.join(root, "bin/codey.mjs"), "doctor", "--json"], {
      env: controlEnvironment(os.homedir()), cwd: root, timeout: 90000,
      log: path.join(request.job, "doctor-acceptance.private.log"),
    }).catch(() => { requireValue(false, "health_failed"); }));
    requireValue(doctor.ok === true && doctor.name === "codey" && doctor.platform === platform &&
      doctor.modelRequests === false && doctor.serviceChanges === false &&
      doctor.version === component.version && doctor.entrySha256 === component.entrySha256 &&
      doctor.lockSha256 === component.lockSha256 && doctor.sourceCommit === component.commit &&
      doctor.nodeMajor === Number(process.versions.node.split(".")[0]) &&
      ["sqlite", "bcrypt", "ripgrep", "pty", "codexSdk"].every(key => doctor.native?.[key] === true), "health_failed");
    const health = await probe(runtimeConfig, { version: component.version })
      .catch(() => { requireValue(false, "health_failed"); });
    requireValue(health.healthy === true && health.modelRequests === false, "health_failed");
    clearInterval(timer);
    await pending;
    if (leaseError) throw leaseError;
    await notify();
    const probePath = path.join(os.homedir(), ".local/share/codey-updater/probe");
    requireValue(objectHash(await hashes(runtimeFile, probePath)) === objectHash(request.plan.protected),
      "configuration_changed");
    requireValue(await fileHash(path.join(root, "codey-build.json")) === component.entrySha256, "health_failed");
    const proof = checkedAcceptanceProof(request, {
      schema: 1, acceptance: request.acceptance, passed: true, healthy: true, authenticated: true,
      modelRequests: false, version: component.version, entrySha256: component.entrySha256,
      digest: signed.digest, jobId: request.jobId, checkedAt: now(),
    });
    await save(path.join(request.job, "health-proof.json"), proof);
    return proof;
  } finally {
    clearInterval(timer);
    await pending;
  }
}

export function verificationCode(error) {
  return ["signature_invalid", "unsupported_platform", "configuration_changed", "health_failed", "lease_lost"]
    .includes(error?.code) ? error.code : "health_failed";
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
  main().catch(error => {
    const code = verificationCode(error);
    console.log(JSON.stringify({ passed: false, code, modelRequests: false }));
    console.error(code);
    process.exitCode = 1;
  });
}
