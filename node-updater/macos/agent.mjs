import { mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { Agent } from "../windows/agent.mjs";
import { readJson, requireValue } from "../windows/client.mjs";
import { checkedReceipt, exists, libraryRoot, ownedPath, protectedHashes } from "../windows/runtime.mjs";
import { Runtime, checkHost, validateConfig } from "./runtime.mjs";

export { Agent, Runtime, validateConfig };
const codes = new Set(["busy", "configuration_changed", "runtime_incompatible", "signature_invalid", "download_failed",
  "unsupported_platform", "rollback_failed", "health_failed", "model_failed", "lease_lost"]);

export async function checkRequest(file, { candidate = false, allowExpired = false } = {}) {
  const home = os.homedir(), expected = path.join(home, ".config/codey-updater/config.json");
  await ownedPath(file, home);
  const request = await readJson(file);
  requireValue(request.agentConfig === expected);
  const config = validateConfig(await readJson(expected));
  requireValue(config.platform === `macos-${process.arch}` && process.platform === "darwin", "unsupported_platform");
  const signed = checkedReceipt(request, config.releasePublicKey, { platform: config.platform, allowExpired });
  const job = path.join(home, ".local/share/codey-machine-macos/local-updates", request.jobId);
  requireValue(request.job === job && file === path.join(job, "request.json"));
  await ownedPath(job, home);
  if (candidate) {
    requireValue(request.candidate === path.join(job, "app/node_modules/codey"));
    const { inspectUpdateArchive } = await import(pathToFileURL(path.join(libraryRoot, "update-archive.mjs")));
    const component = signed.release.components.codey;
    const artifact = await inspectUpdateArchive(path.join(job, component.file), component.sha256);
    requireValue(artifact.build.runtimePlatforms.includes(config.platform) && artifact.pkg.version === component.version &&
      artifact.entrySha256 === component.entrySha256 && artifact.build.sourceCommit === component.commit &&
      artifact.build.lockSha256 === component.lockSha256, "signature_invalid");
    await new Runtime(config).verifyPackage(request.candidate, artifact);
  }
  return { verified: true, platform: config.platform, digest: signed.digest };
}

async function main() {
  const [mode, ...args] = process.argv.slice(2);
  requireValue(process.platform === "darwin" && ["arm64", "x64"].includes(process.arch) &&
    process.getuid() !== 0, "unsupported_platform");
  if (mode === "hashes") {
    requireValue(args.length === 2);
    console.log(JSON.stringify(await protectedHashes(args[0], args[1])));
    return;
  }
  if (["candidate", "receipt", "receipt-expired"].includes(mode)) {
    requireValue(args.length === 1);
    console.log(JSON.stringify(await checkRequest(args[0], { candidate: mode === "candidate", allowExpired: mode === "receipt-expired" })));
    return;
  }
  requireValue(["run", "status", "validate", "recover"].includes(mode) && args.length === 2 && args[0] === "--config");
  const config = validateConfig(await readJson(args[1]));
  requireValue(config.platform === `macos-${process.arch}`, "unsupported_platform");
  const [major, minor] = process.versions.node.split(".").map(Number);
  requireValue(major > 22 || major === 22 && minor >= 13, "runtime_incompatible");
  if (mode === "validate") {
    console.log(JSON.stringify({ valid: true, platform: config.platform, nodeId: config.nodeId }));
    return;
  }
  const runtime = new Runtime(config);
  if (mode === "status") { console.log(JSON.stringify(await runtime.report())); return; }
  // host.py owns a flock for the complete tree. Recovery in an external terminal
  // uses the same host/lock; it cannot race a loaded updater's queue.
  await checkHost(runtime);
  if (mode === "recover") {
    requireValue(!(await exists(path.join(runtime.private, "pending.json"))), "busy");
    const block = await readJson(path.join(runtime.private, "blocked.json"));
    const result = await runtime.native("recover", path.join(block.directory, "local-update.json"));
    requireValue(["complete", "rolled_back", "aborted"].includes(result.state), "rollback_failed");
    if (result.state === "complete") {
      const request = await readJson(path.join(block.directory, "request.json"));
      await runtime.commit(request.release, request.digest, block.directory);
    }
    await runtime.releaseLocal(block.directory);
    await rm(path.join(runtime.private, "blocked.json"));
    console.log(JSON.stringify({ recovered: result.state, modelRequests: false }));
    return;
  }
  await mkdir(runtime.root, { recursive: true, mode: 0o700 });
  const agent = new Agent(config, { runtime });
  let stopping = false;
  process.on("SIGTERM", () => { stopping = true; });
  process.on("SIGINT", () => { stopping = true; });
  while (!stopping && !(await exists(path.join(runtime.private, "stop.json")))) {
    try {
      const result = await agent.once();
      console.log(JSON.stringify({ nodeId: config.nodeId, state: result.state }));
    } catch (error) {
      console.error(JSON.stringify({ nodeId: config.nodeId, code: codes.has(error?.code) ? error.code : "operation_failed" }));
    }
    for (let index = 0; index < 15 && !stopping; index++) {
      if (await exists(path.join(runtime.private, "stop.json"))) break;
      await sleep(1000);
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(JSON.stringify({ code: codes.has(error?.code) ? error.code : "operation_failed" })); process.exitCode = 1; });
}
