/** Owner-triggered, single-use update jobs. No polling daemon, boot job or remote API. */
import { chmod, copyFile, mkdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { exists, fileHash } from "./package-files.mjs";
import { openMachine } from "./machine.mjs";
import { updateMachine } from "./machine-update.mjs";

const jobPattern = /^[a-f0-9]{32}$/;
const terminal = new Set(["completed", "failed", "needs-review"]);
const states = new Set(["queued", "preparing", "ready", "switching", "verifying", ...terminal]);
const warning = "The updater survives disconnection. Services briefly restart; clients can reconnect. " +
  "In-flight requests and Workspace terminal tasks may be interrupted and are never automatically replayed.";
const paths = (m, jobId) => {
  if (!jobPattern.test(jobId)) throw new Error("Invalid update job identifier");
  const directory = path.join(m.i.configRoot, "updates", jobId);
  return { directory, request: path.join(directory, "request.json"),
    status: path.join(directory, "status.json"), archive: path.join(directory, "package.tgz"),
    error: path.join(directory, "error.log") };
};

async function readReport(m, files, jobId) {
  const status = await m.i.read(await m.privateFile(files.status));
  if (status.schema !== 1 || status.jobId !== jobId || !states.has(status.state)) throw new Error("Invalid update status");
  return status;
}

export async function queueUpdate(m, options, artifact, plan) {
  if (m.i.target !== "linux-x64" || !m.i.adapter.startUpdateJob ||
      !artifact.files.has("lib/machine-update-job.mjs")) {
    throw new Error("Both the installed CLI and target package must support Linux background updates");
  }
  return m.lock(async () => {
    await m.tools();
    const jobId = randomBytes(16).toString("hex"), files = paths(m, jobId);
    await m.i.directory(path.dirname(files.directory));
    await mkdir(await m.i.checked(files.directory), { mode: 0o700 });
    await copyFile(artifact.file, files.archive);
    await chmod(files.archive, 0o600);
    if (await fileHash(files.archive) !== artifact.sha256) throw new Error("Package changed while queuing the update");
    const request = { schema: 1, jobId, nodeId: m.config.nodeId, ownerUid: process.getuid(),
      entrySha256: m.config.codeyEntrySha256, runtimeSha256: await fileHash(m.i.file),
      sha256: artifact.sha256, offline: Boolean(options.offline) };
    const status = { schema: 1, jobId, state: "queued", from: plan.from, version: plan.version,
      sha256: artifact.sha256, dependencyMode: plan.dependencyMode, downloads: plan.downloads,
      createdAt: new Date().toISOString(), warning };
    await m.i.write(files.request, request);
    await m.i.write(files.status, status);
    await m.i.write(path.join(m.i.configRoot, "last-update.json"), { schema: 1, jobId });
    await m.i.write(path.join(m.i.configRoot, "install.lock/update.json"),
      { schema: 1, jobId, nodeId: request.nodeId, entrySha256: request.entrySha256 });
    // Transfer the existing operation lock, rather than leave a race between two locks.
    // Once dispatch is attempted its outcome can be ambiguous: keep the lease on error.
    m.keepLock = true;
    try { await m.i.adapter.startUpdateJob(m.config, jobId); }
    catch {
      throw new Error("Cannot confirm update worker startup; run codey update --status and inspect install.lock before retrying. No forced retry.");
    }
    return { ...plan, queued: true, changed: false, jobId, state: "queued", statusFile: files.status, warning };
  });
}

/** Only whitelisted result fields leave private state; request/config/log contents never do. */
export async function readUpdateStatus(m) {
  const pointer = path.join(m.i.configRoot, "last-update.json");
  if (!await exists(pointer)) return { ok: true, operation: "update", state: "none" };
  const last = await m.i.read(await m.privateFile(pointer));
  if (last.schema !== 1) throw new Error("Invalid update status pointer");
  const files = paths(m, last.jobId);
  let status = await readReport(m, files, last.jobId), nativeState;
  if (!terminal.has(status.state) && m.i.adapter.updateJobState) {
    try { nativeState = await m.i.adapter.updateJobState(m.config, last.jobId); }
    catch { nativeState = "unknown"; } // Never echo arbitrary bus/child errors in public status.
    // --collect can remove the unit between reading the report and querying systemd.
    // A completed report is authoritative; unit disappearance alone is not failure.
    status = await readReport(m, files, last.jobId);
  }
  const result = { ok: !["failed", "needs-review"].includes(status.state), operation: "update",
    jobId: last.jobId, state: status.state, statusFile: files.status };
  for (const name of ["from", "version", "sha256", "dependencyMode", "downloads", "createdAt", "updatedAt",
    "finishedAt", "warning", "backup", "timings"]) if (status[name] !== undefined) result[name] = status[name];
  if (!terminal.has(status.state) && nativeState !== undefined) {
    if (!["active", "activating", "reloading"].includes(nativeState)) {
      result.ok = false; result.state = "needs-review";
      result.warning = "Update worker is not confirmed running. Inspect its private report and install.lock; do not delete the lock or automatically retry.";
    }
  }
  return result;
}

export async function runUpdateJob(root, jobId, { open = openMachine, update = updateMachine } = {}) {
  const m = await open(root);
  if (!m || m.i.target !== "linux-x64") throw new Error("Update worker requires an installed Linux node");
  const files = paths(m, jobId);
  // Verifies this PID is the main process of the exact transient systemd user unit.
  // Detaching/forking a Workspace child alone is NOT sufficient isolation.
  await m.i.adapter.verifyUpdateJob(m.config, jobId);
  let status = await readReport(m, files, jobId);
  if (status.state !== "queued") throw new Error("Update job was already used; nothing was changed");
  const progress = async patch => {
    status = { ...status, ...patch, updatedAt: new Date().toISOString() };
    await m.i.write(files.status, status);
  };
  try {
    const request = await m.i.read(await m.privateFile(files.request));
    if (request.schema !== 1 || request.jobId !== jobId || request.nodeId !== m.config.nodeId ||
        request.ownerUid !== process.getuid() || request.entrySha256 !== m.config.codeyEntrySha256 ||
        request.runtimeSha256 !== await fileHash(m.i.file) ||
        !/^[a-f0-9]{64}$/.test(request.sha256 ?? "") || typeof request.offline !== "boolean") {
      throw new Error("Update job is stale or belongs to another node; nothing was changed");
    }
    await m.privateFile(files.archive);
    const result = await update(m, { file: files.archive, sha256: request.sha256, offline: request.offline },
      { updateJob: jobId, progress });
    await progress({ state: "completed", finishedAt: new Date().toISOString(),
      backup: result.backup, timings: result.timings, warning: result.warning });
    return { ok: true, jobId, state: "completed" };
  } catch (error) {
    await m.i.write(files.error, Buffer.from(String(error?.stack ?? error)));
    const held = await exists(path.join(m.i.configRoot, "install.lock"));
    await progress({ state: held ? "needs-review" : "failed", finishedAt: new Date().toISOString(),
      warning: held ? "Update was interrupted or rollback needs review. Inspect the private error.log and install.lock; no automatic retry." :
        "Update failed. Inspect the private error.log and run codey doctor before retrying." });
    return { ok: false, jobId, state: status.state };
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4 || process.argv[2] !== "--run") {
    console.error("Internal one-shot worker; use codey update.");
    process.exitCode = 1;
  } else {
    try {
      const result = await runUpdateJob(fileURLToPath(new URL("../", import.meta.url)), process.argv[3]);
      if (!result.ok) process.exitCode = 1;
    } catch {
      // Do not log private config or arbitrary child errors to the system journal.
      console.error("Update worker refused or could not finish; inspect codey update --status.");
      process.exitCode = 1;
    }
  }
}
