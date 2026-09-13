import { mkdir, readFile, rm, copyFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { Client, UpdateError, readJson, requireValue, save, sha, validateConfig } from "./client.mjs";
import { Runtime, directory, libraryRoot, exists, protectedHashes, checkedReceipt, ownedPath } from "./runtime.mjs";

const manifestModule = await exists(path.join(directory, "lib/node-update-manifest.mjs"))
  ? path.join(directory, "lib/node-update-manifest.mjs") : path.resolve(directory, "../../src/node-update-manifest.mjs");
const { verifyNodeRelease } = await import(pathToFileURL(manifestModule));
const allowedCodes = new Set(["busy", "unsupported_platform", "runtime_incompatible", "model_auth_migration_required",
  "migration_unsupported", "model_login_required", "download_failed", "signature_invalid", "stage_failed",
  "configuration_changed", "health_failed", "model_failed", "rollback_failed", "lease_lost"]);
const codeFor = error => allowedCodes.has(error?.code) ? error.code : "operation_failed";

export class Agent {
  constructor(config, { runtime = new Runtime(config), client = new Client(config), clock = Date.now, wait = sleep } = {}) {
    // Only the state machine is shared with macOS; the caller must supply its
    // native runtime. Windows entrypoints still require win32 and the task host.
    requireValue(["windows-x64", "macos-arm64", "macos-x64"].includes(config.platform), "unsupported_platform");
    this.config = config; this.runtime = runtime; this.client = client; this.clock = clock; this.wait = wait;
    this.pendingFile = path.join(runtime.private, "pending.json");
    this.blockedFile = path.join(runtime.private, "blocked.json");
  }
  async notify(job, state, code = "ok") {
    await this.client.json("/api/node-updater/report", {
      jobId: job.id, leaseToken: job.leaseToken, state, code,
    });
    await save(path.join(job.directory, "last-report.json"), { state, code, reportedAt: this.clock() });
  }
  async terminal(job, state, code) {
    // Save the local terminal decision before network acknowledgement. On an
    // ambiguous response, repeat only this acknowledgement, never the update.
    await save(path.join(job.directory, "agent-result.json"), { state, code });
    try { await this.notify(job, state, code); }
    catch (error) {
      if (error.code !== "lease_lost") throw error;
      await save(path.join(job.directory, "acknowledgement.json"), { acknowledged: false, code: "lease_lost" });
      await rm(this.pendingFile);
      return { state: "needs_action", code: "lease_lost" };
    }
    await rm(this.pendingFile);
    return { state, code };
  }
  async reconcile(pending) {
    const job = { ...pending, directory: pending.directory };
    requireValue(/^[a-f0-9]{32}$/.test(job.id) && path.basename(job.directory) === job.id);
    await ownedPath(job.directory, this.runtime.home);
    const resultFile = path.join(job.directory, "agent-result.json");
    if (await exists(resultFile)) {
      const result = await readJson(resultFile);
      return this.terminal(job, result.state, result.code);
    }
    // Local recovery precedes any dependency on the Portal or application network.
    const journal = path.join(job.directory, "local-update.json");
    if (await exists(journal)) {
      try {
        const result = await this.runtime.native("recover", journal);
        if (result.state === "complete") {
          const request = await readJson(path.join(job.directory, "request.json"));
          await this.runtime.commit(request.release, request.digest, job.directory);
          await this.runtime.releaseLocal(job.directory);
          return this.terminal(job, "succeeded", "ok");
        }
        await this.runtime.releaseLocal(job.directory);
        return this.terminal(job, result.state === "rolled_back" ? "rolled_back" : "needs_action",
          result.state === "rolled_back" ? "recovered_rollback" : "configuration_changed");
      } catch {
        await save(this.blockedFile, { jobId: job.id, code: "rollback_failed", directory: job.directory });
        return this.terminal(job, "needs_action", "rollback_failed");
      }
    }
    // A killed downloader/stager never stopped an application. Do not restart it.
    await this.runtime.releaseLocal(job.directory);
    return this.terminal(job, "needs_action", "configuration_changed");
  }
  async once() {
    if (await exists(this.pendingFile)) return this.reconcile(await readJson(this.pendingFile));
    let report = await this.runtime.report();
    if (await exists(this.blockedFile)) report = { ...report, busy: true, blockedReason: "rollback_failed" };
    const response = await this.client.json("/api/node-updater/poll", { protocol: 1, report });
    requireValue(response.protocol === 1, "configuration_changed");
    await save(path.join(this.runtime.private, "heartbeat.json"), {
      nodeId: this.config.nodeId, seenAt: this.clock(), platform: this.config.platform,
      version: report.components?.codey?.version || null,
    });
    const assigned = response.job;
    if (!assigned) return { state: "polling" };
    requireValue(!(await exists(this.blockedFile)), "rollback_failed");
    requireValue(/^[a-f0-9]{32}$/.test(assigned.id) && /^[A-Za-z0-9_-]{43}$/.test(assigned.leaseToken) &&
      assigned.state === "claimed", "configuration_changed");
    let before;
    try { before = await this.runtime.snapshot(); }
    catch {
      await this.client.json("/api/node-updater/report", {
        jobId: assigned.id, leaseToken: assigned.leaseToken, state: "needs_action", code: "configuration_changed",
      });
      return { state: "needs_action", code: "configuration_changed" };
    }
    const job = { ...assigned, directory: path.join(before.jobsRoot, assigned.id) };
    await ownedPath(job.directory, this.runtime.home);
    await mkdir(job.directory, { mode: 0o700 });
    await save(this.pendingFile, { id: job.id, leaseToken: job.leaseToken, releaseId: job.releaseId,
      directory: job.directory });
    let localHeld = false, heartbeat, heartbeats = Promise.resolve(), heartbeatError = null, phase = "claimed";
    const changePhase = async (state, code = "ok") => {
      phase = state;
      heartbeats = heartbeats.then(() => this.notify(job, state, code));
      await heartbeats;
    };
    const stopHeartbeat = async () => {
      clearInterval(heartbeat);
      await heartbeats;
      if (heartbeatError) throw heartbeatError;
    };
    try {
      const verified = verifyNodeRelease(job.envelope, this.config.releasePublicKey, this.clock());
      const release = verified.release, component = release.components.codey;
      requireValue(release.platform === this.config.platform && Object.keys(release.components).length === 1 &&
        release.id === job.releaseId && verified.digest === job.digest, "signature_invalid");
      requireValue(release.sequence >= before.installed.sequence &&
        (release.sequence !== before.installed.sequence || !before.installed.digest || before.installed.digest === verified.digest),
      "signature_invalid");
      requireValue(component.nodeMajors.includes(before.components.codey.nodeMajor), "runtime_incompatible");
      requireValue(release.migrations.every(name => report.readyMigrations.includes(name)), "model_auth_migration_required");
      await this.runtime.acquireLocal(job.directory);
      localHeld = true;
      await save(path.join(job.directory, "before.private.json"), before);
      const changed = ["version", "commit", "entrySha256"].some(key => component[key] !== before.components.codey[key]);
      let candidate = before.root;
      if (changed) {
        // A periodic report keeps the lease/live status fresh during a long npm
        // stage. It is stopped before the single native transaction takes over.
        heartbeat = setInterval(() => {
          heartbeats = heartbeats.then(() => this.notify(job, phase)).catch(error => { heartbeatError = error; });
        }, 20000);
        await changePhase("downloading");
        const artifact = path.join(job.directory, component.file);
        await this.client.download(release.id, component, artifact);
        await changePhase("staging");
        candidate = await this.runtime.stage(artifact, release, before, job.directory);
        await changePhase("waiting_idle", "busy");
        const deadline = this.clock() + 120000;
        while (!(await this.runtime.native("idle")).idle) {
          requireValue(this.clock() < deadline, "busy");
          if (heartbeatError) throw heartbeatError;
          await this.wait(3000);
        }
      }
      await stopHeartbeat();
      await this.runtime.assertUnchanged(before);
      requireValue(this.clock() < release.expiresAt, "signature_invalid");
      const request = {
        schema: 1, acceptance: "authenticated-health-v1",
        job: job.directory, plan: before, candidate, changed, release, envelope: job.envelope,
        digest: verified.digest, jobId: job.id, leaseToken: job.leaseToken,
        agentConfig: path.join(this.runtime.private, "config.json"), version: component.version,
        entrySha256: component.entrySha256, sha256: component.sha256, packageName: component.file,
      };
      const input = path.join(job.directory, "request.json");
      await save(input, request);
      await copyFile(path.join(libraryRoot, "update-probe.mjs"), path.join(job.directory, "update-probe.mjs"));
      await this.notify(job, changed ? "applying" : "verifying");
      const result = await this.runtime.native(changed ? "apply" : "verify", input);
      if (result.state === "rolled_back") {
        await this.runtime.releaseLocal(job.directory); localHeld = false;
        return this.terminal(job, "rolled_back", result.code || "health_failed");
      }
      requireValue(result.state === "complete", "health_failed");
      await this.runtime.commit(release, verified.digest, job.directory);
      await this.runtime.releaseLocal(job.directory); localHeld = false;
      return this.terminal(job, "succeeded", changed ? "ok" : "up_to_date");
    } catch (error) {
      clearInterval(heartbeat);
      await heartbeats.catch(() => {});
      const journalFile = path.join(job.directory, "local-update.json");
      if (await exists(journalFile)) {
        const journal = await readJson(journalFile);
        if (journal.state === "complete") {
          // Verification succeeded locally; an unavailable acknowledgement must
          // not downgrade or repeat acceptance. Reconcile on the next poll.
          throw error;
        }
        if (!["rolled_back", "aborted"].includes(journal.state)) {
          await save(this.blockedFile, { jobId: job.id, code: "rollback_failed", directory: job.directory });
          return this.terminal(job, "needs_action", "rollback_failed");
        }
      }
      if (localHeld) await this.runtime.releaseLocal(job.directory);
      if (error.code === "lease_lost") throw error;
      const code = codeFor(error);
      return this.terminal(job, ["model_auth_migration_required", "migration_unsupported"].includes(code) ? "needs_migration" :
        ["busy", "unsupported_platform", "runtime_incompatible", "configuration_changed", "rollback_failed"].includes(code) ? "needs_action" : "failed", code);
    }
  }
}

async function main() {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === "hashes") {
    requireValue(args.length === 2 && process.platform === "win32", "unsupported_platform");
    console.log(JSON.stringify(await protectedHashes(args[0], args[1])));
    return;
  }
  if (mode === "candidate") {
    requireValue(args.length === 1 && process.platform === "win32", "unsupported_platform");
    const request = await readJson(args[0]);
    const expected = path.join(os.homedir(), ".config/codey-updater/config.json");
    requireValue(request.agentConfig === expected);
    const config = validateConfig(await readJson(expected));
    const signed = checkedReceipt(request, config.releasePublicKey);
    const { inspectUpdateArchive } = await import(pathToFileURL(path.join(libraryRoot, "update-archive.mjs")));
    const component = signed.release.components.codey;
    const artifact = await inspectUpdateArchive(path.join(request.job, component.file), component.sha256);
    requireValue(artifact.entrySha256 === component.entrySha256 && artifact.build.sourceCommit === component.commit &&
      artifact.build.lockSha256 === component.lockSha256, "signature_invalid");
    await new Runtime(config).verifyPackage(request.candidate, artifact);
    console.log(JSON.stringify({ verified: true }));
    return;
  }
  requireValue(["run", "status", "recover", "validate"].includes(mode) && args.length === 2 && args[0] === "--config");
  requireValue(process.platform === "win32" && process.arch === "x64", "unsupported_platform");
  const config = validateConfig(await readJson(args[1]));
  if (mode === "validate") {
    const [major, minor] = process.versions.node.split(".").map(Number);
    requireValue(major > 22 || major === 22 && minor >= 13, "runtime_incompatible");
    console.log(JSON.stringify({ valid: true, platform: config.platform, nodeId: config.nodeId }));
    return;
  }
  const runtime = new Runtime(config);
  if (mode === "status") { console.log(JSON.stringify(await runtime.report())); return; }
  if (mode === "recover") {
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
  // The hidden task host owns an OS file lock + Job Object for this whole tree.
  // Running "node agent.mjs run" directly cannot accidentally create a second agent.
  const host = await readJson(path.join(runtime.private, "agent.lock"));
  requireValue(host.pid === process.ppid && host.nonce === process.env.CODEY_UPDATER_HOST_TOKEN &&
    /^[a-f0-9]{32}$/.test(host.nonce), "configuration_changed");
  const agent = new Agent(config, { runtime });
  let stopping = false;
  process.on("SIGTERM", () => { stopping = true; });
  process.on("SIGINT", () => { stopping = true; });
  while (!stopping) {
    if (await exists(path.join(runtime.private, "stop.json"))) break;
    try {
      const result = await agent.once();
      console.log(JSON.stringify({ nodeId: config.nodeId, state: result.state }));
    } catch (error) { console.error(JSON.stringify({ nodeId: config.nodeId, code: codeFor(error) })); }
    for (let index = 0; index < 15 && !stopping; index++) {
      if (await exists(path.join(runtime.private, "stop.json"))) { stopping = true; break; }
      await sleep(1000);
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(JSON.stringify({ code: codeFor(error) })); process.exitCode = 1; });
}
