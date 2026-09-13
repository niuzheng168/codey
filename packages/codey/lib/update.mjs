import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readPackageInfo, runtimePlatform } from "./package-info.mjs";
import { inspectUpdateArchive } from "./update-archive.mjs";
import { EXTRACT_PACKAGE, linkDependencies, relocateDependencyLink, reusableDependencies, verifyDependencyBinding, verifyDependencyTree } from "./update-dependencies.mjs";
import {
  atomicWrite, buildEnvironment, controlEnvironment, execute, exists, fileHash, findNpm, inside, ownedPath, privateDirectory, readInstalledPackageInfo, readJson,
} from "./update-files.mjs";

const LIB = path.dirname(fileURLToPath(import.meta.url));
const terminalStates = new Set(["complete", "rolled_back", "aborted"]);
export const UPDATE_HELP = `Usage: codey update PACKAGE.tgz [--check] [--offline] [--sha256 HASH]
       codey update codey PACKAGE.tgz [--check] [--sha256 HASH]
       codey update codex TOOL-UPDATE.json --sha256 HASH [--check]
       codey update devtunnel TOOL-UPDATE.json --sha256 HASH [--check | --allow-disconnect]
       codey update --recover

Select exactly one component. The original PACKAGE.tgz syntax updates only Codey.
Uses the existing Node/npm and locked dependencies. Never calls setup, installs
Node/Python, changes model configuration, or contacts a model.
Identical dependency locks directly reuse the installed dependencies, without
copying their files, registry access or install hooks. --offline requires this reuse path;
otherwise changed dependency locks use the normal npm installation path.
Named tool updates require Codey >=0.1.3, an existing owner-managed installation,
and a reviewed native distribution wrapped in a checksummed tool-update.json.
Codex CLI and its app-server are one distribution; the Desktop app is untouched.
DevTunnel activation requires --allow-disconnect in an external local terminal.
--check inspects the artifact, installation and compatibility without installing
dependencies, changing services or writing an update job.
--sha256 additionally checks an independently obtained artifact checksum.
--recover finishes/rolls back an interrupted local transaction; no new package.
--installed-root DIR is a one-time bootstrap option: use this new CLI to update
an older existing package that has no update command. Native service paths must
still match DIR, and the same owner/runtime/idle safeguards apply.

For Codey package updates, managed Linux and Windows restart only the Codey
application. Linux briefly pauses its existing pull updater and retains its
signed-release high-water mark. Unknown layouts and busy nodes are refused.
For an unmanaged npm installation, stop codey start yourself before updating;
the same package/CLI path is retained and no services are installed or started.
Use an external terminal as the original OS owner, never root/Administrator.
Old packages, dependency installations and private recovery journals are retained.
`;

export function updateOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (["--help", "-h"].includes(arg)) {
      if (args.length !== 1) throw new Error("Use codey update --help by itself.");
      return { help: true };
    }
    if (["--check", "--recover", "--offline"].includes(arg)) {
      const key = arg.slice(2);
      if (options[key]) throw new Error(`Duplicate update option: ${arg}`);
      options[key] = true;
    } else if (arg === "--sha256") {
      if (options.sha256 || !/^[a-f0-9]{64}$/i.test(args[index + 1] ?? "")) throw new Error("Provide one SHA-256 hash.");
      options.sha256 = args[++index].toLowerCase();
    } else if (arg === "--installed-root") {
      if (options.installedRoot || !args[index + 1] || !path.isAbsolute(args[index + 1])) {
        throw new Error("--installed-root requires one absolute path to the existing Codey package.");
      }
      options.installedRoot = args[++index];
    } else if (!arg.startsWith("-") && !options.package) {
      if (!arg.endsWith(".tgz") || /^[a-z]+:/i.test(arg) && !/^[a-z]:[\\/]/i.test(arg)) {
        throw new Error("Use a local Codey .tgz path, not an npm name, registry tag or URL.");
      }
      options.package = path.resolve(arg);
    } else throw new Error(`Invalid update option: ${arg}`);
  }
  if (options.recover) {
    if (options.package || options.check || options.offline || options.sha256 || options.installedRoot) throw new Error("--recover cannot be combined with a package or other options.");
  } else if (!options.package) throw new Error("Usage: codey update PACKAGE.tgz [--check] [--sha256 HASH]");
  return options;
}

const nativeDescriptor = home => path.join(home, ".config", "codey-machine-windows", "runtime.json");

export async function serviceHost(home, platform, command) {
  if (platform === "win32") {
    if (!process.env.SystemRoot) throw new Error("Windows SystemRoot is required.");
    return { file: path.join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"), prefix: ["-NoLogo", "-NoProfile", "-NonInteractive", "-File"] };
  }
  const unit = path.join(home, ".config/systemd/user/codey-node-updater.service");
  const contents = await readFile(unit, "utf8");
  const python = contents.match(/^ExecStart=(\/[^\s"']+)\s+-I\s+-S\s+/m)?.[1];
  if (!python || !path.isAbsolute(python) || !(await exists(python))) {
    throw new Error("The existing managed node must have its original Python interpreter; no tools will be installed.");
  }
  await command(python, ["-I", "-S", "-c", "import sys; raise SystemExit(sys.version_info < (3,12))"], { env: controlEnvironment(home) });
  return { file: python, prefix: ["-I", "-S", "-B"] };
}

export async function serviceCommand(host, script, action, input, command, options = {}) {
  const args = script.endsWith(".ps1")
    ? [...host.prefix, script, "-Action", action, "-InputPath", input]
    : [...host.prefix, script, action, input];
  const output = await command(host.file, args, { ...options, timeout: 1200000 });
  let value;
  try { value = JSON.parse(output); } catch { throw new Error("The native update helper returned an invalid result."); }
  return value;
}

/** A second installation must never silently masquerade as the node's service package. */
export async function discoverInstallation(root, home, platform, command = execute) {
  if (!["linux", "win32"].includes(platform)) throw new Error("Local Codey updates support Linux x64 and Windows x64.");
  const marker = platform === "linux" ? path.join(home, ".config/codey-updater/config.json") : nativeDescriptor(home);
  if (await exists(marker)) {
    await ownedPath(marker, home);
    const host = await serviceHost(home, platform, command);
    const script = path.join(LIB, platform === "win32" ? "update-windows.ps1" : "update-service.py");
    const plan = await serviceCommand(host, script, "plan", root, command, { env: controlEnvironment(home) });
    const sameRoot = typeof plan.root === "string" && (platform === "win32"
      ? plan.root.toLowerCase() === root.toLowerCase() : plan.root === root);
    if (!sameRoot || !["linux-managed", "windows-managed"].includes(plan.kind) ||
        !path.isAbsolute(plan.node) || !Array.isArray(plan.services) || !plan.services.length) {
      throw new Error("Unknown or mismatched managed Codey installation.");
    }
    await ownedPath(plan.jobsRoot, home);
    return { ...plan, host };
  }
  const configRoot = platform === "linux" ? path.join(home, ".config/codey-machine") : path.dirname(marker);
  if (await exists(configRoot)) throw new Error("Incomplete managed installation; refusing an unmanaged fallback.");
  if (path.basename(root) !== "codey" || path.basename(path.dirname(root)) !== "node_modules") {
    throw new Error("Only an existing owner-managed node or user-owned npm installation can be updated.");
  }
  return {
    kind: "npm", root, node: process.execPath, jobsRoot: path.join(path.dirname(root), ".codey-local-updates"),
    services: [],
  };
}

export async function assertStandaloneIdle(root, platform = process.platform, command = execute) {
  if (platform === "linux") {
    for (const name of await readdir("/proc")) {
      if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
      try {
        const directory = "/proc/" + name;
        if ((await stat(directory)).uid !== process.getuid()) continue;
        const args = (await readFile(directory + "/cmdline", "utf8")).split("\0");
        if (!/^(node|nodejs|codey)(?:\.exe)?$/.test(path.basename(args[0] ?? ""))) continue;
        if (args.some(arg => arg === root || arg.startsWith(root + path.sep)) ||
            await realpath(directory + "/cwd") === root) {
          throw new Error("Codey is running from this npm package. Stop it in an external terminal before updating.");
        }
      } catch (error) { if (!["ENOENT", "ESRCH", "EACCES"].includes(error.code)) throw error; }
    }
    return;
  }
  if (platform !== "win32") throw new Error("Unsupported local update platform.");
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Use a non-elevated owner terminal' }
$rows = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(node|nodejs|codey)\.exe$' } | ForEach-Object {
  $owner = Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid -ErrorAction Stop
  if ($owner.Sid -eq $sid) { @{pid = $_.ProcessId; command = $_.CommandLine} }
})
ConvertTo-Json -InputObject $rows -Compress
`;
  const host = await serviceHost(os.homedir(), "win32", command);
  const rows = JSON.parse(await command(host.file, [
    "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64"),
  ]));
  for (const row of rows) {
    if (row.pid !== process.pid && typeof row.command === "string" && row.command.toLowerCase().includes(root.toLowerCase())) {
      throw new Error("This npm package is in use. Stop Codey before updating.");
    }
  }
}

async function compatibility(archive, plan, command, home) {
  const nodeVersion = await command(plan.node, ["-p", "process.versions.node"], { env: controlEnvironment(home) });
  const npm = await findNpm(plan.node);
  // Resolve npm's own installed semver evaluator; do not fetch or add a dependency.
  let semver;
  try { semver = createRequire(npm)("semver"); }
  catch { throw new Error("The existing npm installation is incomplete (missing its semver evaluator)."); }
  if (!semver.satisfies(nodeVersion, ">=22.13.0") ||
      typeof archive.pkg.engines?.node !== "string" || !semver.validRange(archive.pkg.engines.node) ||
      !semver.satisfies(nodeVersion, archive.pkg.engines.node)) {
    throw new Error(`The package is incompatible with existing Node ${nodeVersion}; no runtime will be upgraded.`);
  }
  return { npm, nodeVersion };
}

export async function verifyStagedPackage(root, artifact, { home = os.homedir() } = {}) {
  const info = await readPackageInfo(root);
  if (info.entrySha256 !== artifact.entrySha256 || info.pkg.version !== artifact.pkg.version) throw new Error("Installed package differs from the reviewed archive.");
  for (const [name, expected] of artifact.files) {
    const file = path.join(root, name);
    const entry = await lstat(file);
    const resolved = await realpath(file), wanted = path.join(info.root, name);
    const samePath = process.platform === "win32" ? resolved.toLowerCase() === wanted.toLowerCase() : resolved === wanted;
    if (!samePath || !entry.isFile() || entry.isSymbolicLink() || entry.size !== expected.size || await fileHash(file) !== expected.sha256) {
      throw new Error(`Installed Codey file differs from the archive: ${name}`);
    }
  }
  await verifyDependencyBinding(root, artifact.lock, { home });
  return info;
}

export async function stagePackage(artifact, plan, job, { command = execute, npm, reuseDependencies = false, ownerHome = os.homedir() } = {}) {
  const home = path.join(job, "build-home");
  await mkdir(home, { mode: 0o700 });
  const env = buildEnvironment(home, plan.node);
  const archive = path.join(job, "package.tgz");
  await copyFile(artifact.file, archive);
  if (await fileHash(archive) !== artifact.sha256) throw new Error("The source tarball changed after inspection.");
  const prefix = path.join(job, "app");
  const root = path.join(prefix, ...(process.platform === "win32" ? [] : ["lib"]), "node_modules", "codey");
  await command(plan.node, ["--input-type=commonjs", "-e", EXTRACT_PACKAGE, npm, archive, root,
    env.npm_config_cache, "sha256-" + Buffer.from(artifact.sha256, "hex").toString("base64")], {
    env, cwd: job, log: path.join(job, "npm-extract.private.log"), timeout: 120000,
  });
  await verifyStagedPackage(root, artifact, { home: ownerHome });
  if (reuseDependencies) {
    const reuse = await linkDependencies(plan.root, root, artifact.lock, { home: ownerHome });
    await atomicWrite(path.join(job, "dependency-mode.json"), reuse);
    await verifyStagedPackage(root, artifact, { home: ownerHome });
    await command(plan.node, [path.join(root, "bin/codey.mjs"), "doctor", "--json"], {
      env, cwd: home, log: path.join(job, "doctor.private.log"), timeout: 60000,
    });
    return root;
  }
  // A permissive caller umask must not make the activated package fail the next
  // owner-path check. Keep both the install and native rebuild private.
  const flags = ["--omit=dev", "--no-audit", "--no-fund", "--engine-strict", "--umask=0077", "--strict-ssl=true", "--registry=https://registry.npmjs.org"];
  // npm's option alone does not cover every directory it creates. Set the OS
  // umask in the npm child, without mutating the caller's process-wide mask.
  const npmArgs = process.platform === "win32" ? [npm] : [
    "--input-type=commonjs", "-e", "process.umask(0o077); require(process.argv[1]);", npm,
  ];
  // Global npm install may resolve ranges again despite retaining shrinkwrap.
  // ci inside the extracted application installs the exact reviewed lock.
  await command(plan.node, [...npmArgs, "ci", "--prefix", root, "--ignore-scripts", ...flags], {
    env, cwd: root, log: path.join(job, "npm-install.private.log"), timeout: 1200000,
  });
  await verifyStagedPackage(root, artifact, { home: ownerHome });
  await command(plan.node, [...npmArgs, "rebuild", "--prefix", root, ...flags], {
    env, cwd: root, log: path.join(job, "npm-rebuild.private.log"), timeout: 1200000,
  });
  await verifyStagedPackage(root, artifact, { home: ownerHome });
  await command(plan.node, [path.join(root, "bin/codey.mjs"), "doctor", "--json"], {
    env, cwd: home, log: path.join(job, "doctor.private.log"), timeout: 60000,
  });
  return root;
}

async function recordState(job, journal, state) {
  journal.state = state;
  await atomicWrite(path.join(job, "local-update.json"), journal);
}

export async function activateStandalone(request, { home, idle = assertStandaloneIdle, command = execute } = {}) {
  const { plan, job, candidate } = request;
  const backup = path.join(job, "previous-codey");
  if ((await stat(plan.root)).dev !== (await stat(job)).dev) throw new Error("The package and rollback directory must be on the same filesystem.");
  const before = await readInstalledPackageInfo(plan.root);
  if (before.entrySha256 !== request.previousEntrySha256) throw new Error("Installed Codey changed during staging.");
  await idle(plan.root);
  await ownedPath(plan.root, home);
  const journal = { schema: 1, kind: "npm", state: "prepared", request, backup };
  await atomicWrite(path.join(job, "local-update.json"), journal);
  // A Windows process cannot safely rename the directory used as its own cwd.
  if (process.cwd() === plan.root || inside(plan.root, process.cwd())) process.chdir(home);
  await recordState(job, journal, "applying");
  try {
    await rename(plan.root, backup);
    await relocateDependencyLink(candidate, plan.root, backup, { home });
    await rename(candidate, plan.root);
    const after = await readPackageInfo(plan.root);
    if (after.entrySha256 !== request.entrySha256) throw new Error("Activated package fingerprint mismatch.");
    await command(plan.node, [path.join(plan.root, "bin/codey.mjs"), "doctor", "--json"], {
      cwd: path.join(job, "build-home"), env: buildEnvironment(path.join(job, "build-home"), plan.node),
      log: path.join(job, "doctor-active.private.log"), timeout: 60000,
    });
    await recordState(job, journal, "complete");
    return { ok: true, version: request.version, services: [], modelRequests: false };
  } catch (error) {
    await recoverStandalone(journal, home, idle);
    throw error;
  }
}

export async function recoverStandalone(journal, home, idle = assertStandaloneIdle) {
  const { request, backup } = journal;
  if (terminalStates.has(journal.state)) return { ok: true, recovered: journal.state, modelRequests: false };
  const { root } = request.plan;
  for (const file of [root, backup, request.candidate]) await ownedPath(file, home);
  if (!inside(request.job, backup) || !inside(request.job, request.candidate)) throw new Error("Invalid recovery paths.");
  await idle(root);
  if (await exists(backup)) {
    if ((await readInstalledPackageInfo(backup)).entrySha256 !== request.previousEntrySha256) throw new Error("Original package changed; manual recovery required.");
    if (await exists(root)) {
      if ((await readPackageInfo(root)).entrySha256 !== request.entrySha256 || await exists(request.candidate)) {
        throw new Error("Another installation changed the package; refusing to overwrite it.");
      }
      await rename(root, request.candidate);
    }
    await rename(backup, root);
    await recordState(request.job, journal, "rolled_back");
  } else {
    if (!(await exists(root)) || (await readInstalledPackageInfo(root)).entrySha256 !== request.previousEntrySha256) {
      throw new Error("Original package is missing; manual recovery required.");
    }
    await recordState(request.job, journal, "aborted");
  }
  return { ok: true, recovered: journal.state, modelRequests: false };
}

const processAlive = pid => {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== "ESRCH"; }
};

async function recoverActiveUnlocked(stateRoot, home, command, idle) {
  const activeFile = path.join(stateRoot, "active.json");
  const lock = path.join(stateRoot, "lock");
  await ownedPath(lock, home);
  if (!(await exists(activeFile))) {
    const ownerFile = path.join(lock, "owner.json");
    if (!(await exists(ownerFile))) throw new Error("No recoverable update was recorded. An empty lock needs manual inspection.");
    const owner = await readJson(ownerFile);
    if (!Number.isInteger(owner.pid) || owner.pid < 1 || processAlive(owner.pid)) throw new Error("An update process is still running.");
    await rm(lock, { recursive: true });
    return { ok: true, recovered: "aborted-before-staging", modelRequests: false };
  }
  await ownedPath(activeFile, home);
  const active = await readJson(activeFile);
  if (!Number.isInteger(active.pid) || active.pid < 1 || processAlive(active.pid)) throw new Error("The previous update process is still running; do not interrupt it.");
  await ownedPath(active.job, home);
  const journalFile = path.join(active.job, "local-update.json");
  let result;
  if (await exists(journalFile)) {
    const journal = await readJson(journalFile);
    if (journal.request.job !== active.job || !["npm", "linux-managed", "windows-managed", "linux-tool", "windows-tool"].includes(journal.kind)) {
      throw new Error("Recovery job identity mismatch.");
    }
    if (journal.kind === "npm") result = await recoverStandalone(journal, home, idle);
    else result = await serviceCommand(journal.request.plan.host,
      path.join(active.job, ({
        "windows-managed": "update-windows.ps1", "linux-managed": "update-service.py",
        "windows-tool": "tool-update-windows.ps1", "linux-tool": "tool-update-service.py",
      })[journal.kind]),
      "recover", journalFile, command, { env: controlEnvironment(home), log: path.join(active.job, "recovery.private.log") });
  } else result = { ok: true, recovered: "aborted-before-switch", modelRequests: false };
  if (result.ok !== true) throw new Error("Native recovery did not report success; update records were retained.");
  await rm(activeFile);
  await rm(lock, { recursive: true, force: true });
  return result;
}

async function recoverActive(stateRoot, home, command, idle) {
  if (!(await exists(stateRoot))) throw new Error("No local update was recorded.");
  const guard = path.join(stateRoot, "recovery.lock");
  await ownedPath(guard, home);
  try { await mkdir(guard, { mode: 0o700 }); }
  catch (error) {
    if (error.code === "EEXIST") throw new Error(`Another recovery is running or was itself interrupted. Inspect ${guard}; do not run concurrent recoveries.`);
    throw error;
  }
  try {
    await writeFile(path.join(guard, "owner.json"), JSON.stringify({ pid: process.pid }) + "\n", { flag: "wx", mode: 0o600 });
    return await recoverActiveUnlocked(stateRoot, home, command, idle);
  } finally {
    await rm(guard, { recursive: true, force: true });
  }
}

export async function runUpdate(root, args, {
  home = os.homedir(), platform = process.platform, arch = process.arch, command = execute,
  discover = discoverInstallation, stage = stagePackage, idle = assertStandaloneIdle, log = console.log, toolDependencies = {},
} = {}) {
  if (["codex", "devtunnel"].includes(args[0])) {
    if (args.length === 2 && ["--help", "-h"].includes(args[1])) { log(UPDATE_HELP); return; }
    const { runToolUpdate } = await import("./tool-update.mjs");
    return runToolUpdate(root, args, { home, platform, arch, command, log, ...toolDependencies });
  }
  if (args[0] === "codey") args = args.slice(1);
  const options = updateOptions(args);
  if (options.help) { log(UPDATE_HELP); return; }
  runtimePlatform(platform, arch);
  if (!["linux", "win32"].includes(platform)) throw new Error("Local Codey updates support Linux x64 and Windows x64.");
  if (process.getuid?.() === 0 || os.userInfo().username.toUpperCase() === "SYSTEM") throw new Error("Run codey update as the original OS user, not root or SYSTEM.");
  home = await realpath(home);
  const stateRoot = path.join(home, ".local/share/codey-local-update");
  if (options.recover) {
    await ownedPath(stateRoot, home);
    const onSignal = () => log("Waiting for the recovery step to finish safely.");
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    try {
      const result = await recoverActive(stateRoot, home, command, idle);
      log(JSON.stringify(result));
      return result;
    } finally {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    }
  }
  root = await realpath(options.installedRoot ?? root);
  await ownedPath(root, home, { allowSymlink: true });
  const current = await readInstalledPackageInfo(root);
  const artifact = await inspectUpdateArchive(options.package, options.sha256);
  const plan = await discover(root, home, platform, command);
  const tools = await compatibility(artifact, plan, command, home);
  const reuseDependencies = await reusableDependencies(root, artifact.lock);
  if (options.offline && !reuseDependencies) {
    throw new Error("--offline requires installed dependencies matching the new package lock; nothing was installed or changed.");
  }
  if (reuseDependencies) await verifyDependencyTree(root, artifact.lock, { home, allowInstalledLink: true });
  if (plan.kind === "npm") {
    for (const name of ["CODEX_HOME", "COPILOT_API_HOME", "DATABASE_PATH"]) {
      const value = process.env[name];
      if (!value || value === ":memory:") continue;
      const file = value.startsWith("~/") ? path.join(home, value.slice(2)) : path.resolve(root, value);
      if (file === root || inside(root, file)) throw new Error(`${name} stores user data inside the npm package; move it outside the application before updating.`);
    }
    await idle(root, platform, command);
  }
  const report = {
    ok: true, mode: options.check ? "check" : "update", platform: runtimePlatform(platform, arch),
    layout: plan.kind, fromVersion: current.pkg.version, toVersion: artifact.pkg.version,
    sha256: artifact.sha256, node: plan.node, nodeVersion: tools.nodeVersion, services: plan.services,
    unchanged: artifact.entrySha256 === current.entrySha256, modelRequests: false,
    dependencyMode: reuseDependencies ? "reuse-installed-linked" : "npm-install",
  };
  if (options.check || report.unchanged) {
    log(JSON.stringify({ ...report, serviceChanges: false }));
    return { ...report, serviceChanges: false };
  }
  await privateDirectory(stateRoot, home);
  const lock = path.join(stateRoot, "lock"), activeFile = path.join(stateRoot, "active.json");
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (error) {
    if (error.code === "EEXIST") throw new Error("A local update is running or was interrupted. Use codey update --recover after it exits.");
    throw error;
  }
  let job, interrupted = false;
  const onSignal = () => {
    interrupted = true;
    log("Stopping safely: an active package switch/rollback will finish before exiting.");
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    await writeFile(path.join(lock, "owner.json"), JSON.stringify({ pid: process.pid }) + "\n", { flag: "wx", mode: 0o600 });
    if (await exists(activeFile)) throw new Error("An interrupted update needs codey update --recover.");
    await privateDirectory(plan.jobsRoot, home);
    job = path.join(plan.jobsRoot, randomBytes(16).toString("hex"));
    await privateDirectory(job, home);
    await atomicWrite(activeFile, { schema: 1, pid: process.pid, job });
    log(`Staging Codey ${report.fromVersion} -> ${report.toVersion}; current services remain running.`);
    log(reuseDependencies ? "Reusing the identical installed dependency tree; no registry requests or install hooks."
      : "Dependency reuse is unavailable; installing locked dependencies through npm.");
    for (const name of ["update-service.py", "update-windows.ps1", "update-probe.mjs"]) await copyFile(path.join(LIB, name), path.join(job, name));
    if (plan.kind === "linux-managed") {
      for (const name of ["engine.py", "probe.mjs"]) await copyFile(path.join(root, "updater", name), path.join(job, name));
    }
    const candidate = await stage(artifact, plan, job, { command, npm: tools.npm, reuseDependencies, ownerHome: home });
    await verifyStagedPackage(candidate, artifact, { home });
    if (interrupted) throw new Error("Update cancelled before activation; the old package is still installed.");
    const request = {
      schema: 1, plan, job, candidate, version: artifact.pkg.version, entrySha256: artifact.entrySha256,
      previousEntrySha256: current.entrySha256, sha256: artifact.sha256, packageName: path.basename(artifact.file),
    };
    const requestFile = path.join(job, "request.json");
    await atomicWrite(requestFile, request);
    log("Checking the current installation and activity before switching only Codey.");
    let result;
    if (plan.kind === "npm") result = await activateStandalone(request, {
      home, command, idle: file => idle(file, platform, command),
    });
    else result = await serviceCommand(plan.host,
      path.join(job, platform === "win32" ? "update-windows.ps1" : "update-service.py"),
      "apply", requestFile, command, { env: controlEnvironment(home), log: path.join(job, "activation.private.log") });
    if (result.ok !== true) throw new Error("Native Codey activation did not report success.");
    await rm(activeFile);
    log(JSON.stringify({ ...report, ...result, job, serviceChanges: plan.services.length > 0 }));
    return { ...report, ...result, job, serviceChanges: plan.services.length > 0 };
  } catch (error) {
    if (job) {
      const journalFile = path.join(job, "local-update.json");
      const journal = await exists(journalFile) ? await readJson(journalFile) : null;
      if (!journal || terminalStates.has(journal.state)) await rm(activeFile, { force: true });
      throw new Error(`${error.message} Update records: ${job}.${journal && !terminalStates.has(journal.state)
        ? " Do not retry installation; use codey update --recover." : ""}`, { cause: error });
    }
    throw error;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    if (!(await exists(activeFile))) await rm(lock, { recursive: true, force: true });
  }
}
