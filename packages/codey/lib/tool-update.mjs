import { randomBytes } from "node:crypto";
import { copyFile, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runtimePlatform } from "./package-info.mjs";
import { atomicWrite, controlEnvironment, execute, exists, fileHash, ownedPath, privateDirectory, readInstalledPackageInfo, readJson } from "./update-files.mjs";
import { serviceCommand, serviceHost } from "./update.mjs";
import { inspectToolPackage, stageToolPackage, TOOL_COMPONENTS } from "./tool-update-package.mjs";

const LIB = path.dirname(fileURLToPath(import.meta.url));
const terminal = new Set(["complete", "rolled_back", "aborted"]);

export function toolUpdateOptions(args) {
  const options = { component: args[0] };
  if (!TOOL_COMPONENTS.includes(options.component)) throw new Error("Select codex or devtunnel, one component per update.");
  for (let index = 1; index < args.length; index++) {
    const arg = args[index];
    if (["--check", "--allow-disconnect"].includes(arg)) {
      const key = arg === "--check" ? "check" : "allowDisconnect";
      if (options[key]) throw new Error(`Duplicate tool update option: ${arg}`);
      options[key] = true;
    } else if (arg === "--sha256") {
      if (options.sha256 || !/^[a-f0-9]{64}$/i.test(args[index + 1] ?? "")) throw new Error("Provide one independent manifest SHA-256.");
      options.sha256 = args[++index].toLowerCase();
    } else if (arg === "--installed-root") {
      if (options.installedRoot || !args[index + 1] || !path.isAbsolute(args[index + 1])) throw new Error("--installed-root requires an absolute package directory.");
      options.installedRoot = args[++index];
    } else if (!arg.startsWith("-") && !options.manifest) {
      if (!arg.endsWith(".json") || /^[a-z]+:/i.test(arg) && !/^[a-z]:[\\/]/i.test(arg)) throw new Error("Use a local tool-update.json, not a URL, registry tag or installer.");
      options.manifest = path.resolve(arg);
    } else throw new Error(`Invalid tool update option: ${arg}`);
  }
  if (!options.manifest || !options.sha256) throw new Error("A reviewed tool-update.json and independent --sha256 are required.");
  if (options.allowDisconnect && options.component !== "devtunnel") throw new Error("--allow-disconnect is only for DevTunnel.");
  if (options.component === "devtunnel" && !options.check && !options.allowDisconnect) {
    throw new Error("DevTunnel update disconnects the tunnel. Use an external terminal independent of this tunnel and explicitly pass --allow-disconnect, or inspect with --check.");
  }
  return options;
}

export function toolBaseline(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version ?? "");
  return Boolean(match && (Number(match[1]) > 0 || Number(match[2]) > 1 || Number(match[2]) === 1 && Number(match[3]) >= 3));
}

export async function discoverTool(root, home, platform, component, command = execute) {
  const marker = path.join(home, platform === "win32" ? ".config/codey-machine-windows/runtime.json" : ".config/codey-updater/config.json");
  await ownedPath(marker, home);
  if (!await exists(marker)) throw new Error("Tool updates require an existing owner-managed node; system/global/Desktop installations are not adopted.");
  const host = await serviceHost(home, platform, command);
  const script = path.join(LIB, platform === "win32" ? "tool-update-windows.ps1" : "tool-update-service.py");
  const plan = await serviceCommand(host, script, "plan", JSON.stringify({ root, component }), command, { env: controlEnvironment(home) });
  const sameRoot = typeof plan.root === "string" &&
    (platform === "win32" ? plan.root.toLowerCase() === root.toLowerCase() : plan.root === root);
  if (plan.kind !== (platform === "win32" ? "windows-tool" : "linux-tool") || plan.component !== component
      || !sameRoot
      || !path.isAbsolute(plan.node) || !Array.isArray(plan.services) || !plan.services.length) {
    throw new Error("Unrecognized native tool installation.");
  }
  await ownedPath(plan.jobsRoot, home);
  return { ...plan, host };
}

export async function runToolUpdate(root, args, {
  home = os.homedir(), platform = process.platform, arch = process.arch, command = execute,
  discover = discoverTool, stage = stageToolPackage, log = console.log,
} = {}) {
  const options = toolUpdateOptions(args);
  const targetPlatform = runtimePlatform(platform, arch);
  if (!["linux", "win32"].includes(platform) || process.getuid?.() === 0 || os.userInfo().username.toUpperCase() === "SYSTEM") {
    throw new Error("Use an external, non-elevated owner terminal on Linux x64 or Windows x64.");
  }
  home = await realpath(home);
  root = await realpath(options.installedRoot ?? root);
  await ownedPath(root, home);
  const current = await readInstalledPackageInfo(root);
  if (!toolBaseline(current.pkg.version)) throw new Error("Update Codey to at least stable 0.1.3 before managing native tools.");
  const artifact = await inspectToolPackage(options.manifest, options.sha256, { component: options.component, platform: targetPlatform });
  const plan = await discover(root, home, platform, options.component, command);
  const report = { ok: true, mode: options.check ? "check" : "update", component: options.component, platform: targetPlatform,
    codeyVersion: current.pkg.version, fromVersion: plan.version, toVersion: artifact.manifest.version,
    sha256: artifact.sha256, executable: plan.anchor, services: plan.services, modelRequests: false,
    disconnectsTunnel: options.component === "devtunnel" };
  if (options.check) {
    const result = { ...report, serviceChanges: false, candidateExecuted: false };
    log(JSON.stringify(result));
    return result;
  }
  const stateRoot = await privateDirectory(path.join(home, ".local/share/codey-local-update"), home);
  const lock = path.join(stateRoot, "lock"), activeFile = path.join(stateRoot, "active.json");
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (error) {
    if (error.code === "EEXIST") throw new Error("A local update is running or interrupted. Use codey update --recover after it exits.");
    throw error;
  }
  let job, interrupted = false;
  const onSignal = () => { interrupted = true; log("Waiting for the native tool switch/rollback to finish safely."); };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    await writeFile(path.join(lock, "owner.json"), JSON.stringify({ pid: process.pid }) + "\n", { flag: "wx", mode: 0o600 });
    if (await exists(activeFile)) throw new Error("An interrupted update needs codey update --recover.");
    await privateDirectory(plan.jobsRoot, home);
    job = path.join(plan.jobsRoot, randomBytes(16).toString("hex"));
    await privateDirectory(job, home);
    await atomicWrite(activeFile, { schema: 1, pid: process.pid, job });
    for (const name of ["update-service.py", "update-windows.ps1", "update-probe.mjs",
      "tool-update-service.py", "tool-update-windows.ps1", "tool-update-probe.mjs"]) {
      await copyFile(path.join(LIB, name), path.join(job, name));
    }
    if (platform === "linux") {
      for (const name of ["engine.py", "probe.mjs"]) await copyFile(path.join(root, "updater", name), path.join(job, name));
    }
    log(`Staging ${options.component} ${report.fromVersion} -> ${report.toVersion}; no services stopped.`);
    const candidate = await stage(artifact, path.join(job, "payload"));
    await copyFile(artifact.file, path.join(job, "tool-update.json"));
    if (await fileHash(path.join(job, "tool-update.json")) !== artifact.sha256) throw new Error("The reviewed tool manifest changed during staging.");
    const request = { schema: 1, plan, component: options.component, job, candidate, version: artifact.manifest.version,
      sha256: artifact.sha256, manifest: artifact.manifest, entrySha256: artifact.entrySha256,
      allowDisconnect: Boolean(options.allowDisconnect) };
    const requestFile = path.join(job, "request.json");
    await atomicWrite(requestFile, request);
    // Use the node already running this installation. The new tool sees only an isolated HOME.
    await command(plan.node, [path.join(job, "tool-update-probe.mjs"), "probe", requestFile], {
      env: controlEnvironment(home), log: path.join(job, "tool-probe.private.log"), timeout: 60000,
    });
    if (interrupted) throw new Error("Update cancelled before activation; existing tools remain installed.");
    const result = await serviceCommand(plan.host,
      path.join(job, platform === "win32" ? "tool-update-windows.ps1" : "tool-update-service.py"),
      "apply", requestFile, command, { env: controlEnvironment(home), log: path.join(job, "activation.private.log") });
    if (result.ok !== true) throw new Error("Native tool activation did not report success.");
    await rm(activeFile);
    const answer = { ...report, ...result, job, serviceChanges: true };
    log(JSON.stringify(answer));
    return answer;
  } catch (error) {
    if (!job) throw error;
    const journalFile = path.join(job, "local-update.json");
    const journal = await exists(journalFile) ? await readJson(journalFile) : null;
    if (!journal || terminal.has(journal.state)) await rm(activeFile, { force: true });
    throw new Error(`${error.message} Update records: ${job}.${journal && !terminal.has(journal.state)
      ? " Do not retry; use codey update --recover." : ""}`, { cause: error });
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    if (!await exists(activeFile)) await rm(lock, { recursive: true, force: true });
  }
}
