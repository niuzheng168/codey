/** One-shot node operations. Native service details remain in the installation adapters. */
import { lstat, mkdir, readFile, realpath, rmdir, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { exists, fileHash } from "./package-files.mjs";
import { readPackageInfo, runtimePlatform } from "./package-info.mjs";

export const MACHINE_USAGE = {
  guard: "codey guard [--json] [--timeout SECONDS]",
  start: "codey start [--json] [--timeout SECONDS]",
  stop: "codey stop [--json] [--timeout SECONDS]",
  restart: "codey restart [--json] [--timeout SECONDS]",
  status: "codey status [--json]",
  "devtunnel login": "codey devtunnel login",
  "devtunnel start": "codey devtunnel start [--json] [--timeout SECONDS]",
  "devtunnel stop": "codey devtunnel stop [--json] [--timeout SECONDS]",
  export: "codey export FILE.gz [--json]",
  import: "codey import FILE.gz [--check] [--replace-existing] [--settings-only] [--json]",
  update: "codey update FILE.tgz [--sha256 HASH] [--check] [--offline] [--background] [--json]\n       codey update --status [--json]",
};
const GUARD_HELP = `Usage: ${MACHINE_USAGE.guard}
Enable and start this owner's installed native supervisors:
  CloudCLI and Copilot API process supervision
  DevTunnel host supervision and connect-token renewal
  DevTunnel connection health monitoring (Linux)
Reuses systemd, Task Scheduler or LaunchAgents; the CLI exits after local checks.
The supervised applications also start. Already-running services are not restarted.
Same operation as background codey start; use codey stop to disable the whole node.
Requires a completed installation. Does not install services, log in, change
application/TLS/identity settings, request models, or add another daemon/updater.
Foreign/unknown resources are never adopted.
--json prints credential-free node status; default is a readable service list.
--timeout SECONDS: 1–600, default 60, per service/local verification wait.
--help/-h displays this help. Foreground/port options and subcommands are not supported.
`;
const UPDATE_HELP = `Usage: ${MACHINE_USAGE.update}
Update only this owner's installed Codey package; Node/Codex/DevTunnel tools stay unchanged.
FILE.tgz must be a trusted local package. --sha256 checks its expected archive digest.
--check is read-only. --offline requires the same installed dependency lock;
otherwise npm downloads and native dependency preparation may be needed.
Linux --background submits an independent, single-use systemd user job. This mode
is automatic inside Codex/Workspace; the submitting CLI can exit or disconnect.
The old services keep running during preparation. Switching briefly disconnects clients;
in-flight requests and Workspace terminal tasks may be interrupted, not automatically replayed.
queued is NOT completion. Use --status (optionally --json), match the jobId and
wait for completed, then run codey doctor. Failed/unconfirmed status exits nonzero.
Configuration/service changes during preparation abort before stopping anything.
Failed activation rolls back and checks the old services. Interrupted/failed rollback
keeps install.lock for review: do not delete the lock or automatically retry.
Windows/macOS currently require an external owner terminal and do not support --background.
No resident updater, Portal agent, login, automatic tool upgrade or old-release cleanup.
`;
const fail = message => { throw new Error(message); };
export function machineOptions(command, args) {
  if (!Object.hasOwn(MACHINE_USAGE, command)) fail("Unknown node operation");
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) return { help: true };
  const flags = command === "update" ? ["--check", "--offline", "--background", "--status", "--json"] :
    command === "import" ? ["--check", "--replace-existing", "--settings-only", "--json"] :
      command === "devtunnel login" ? [] : ["--json"];
  const values = command === "update" ? ["--sha256"] :
    /(?:^| )(?:start|stop|restart|guard)$/.test(command) ? ["--timeout"] : [];
  const positional = ["export", "import", "update"].includes(command);
  const result = {}, seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!arg.startsWith("-") && positional && !result.file) {
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(arg)) fail("Use a local file, not a URL");
      result.file = path.resolve(arg); continue;
    }
    if (seen.has(arg)) fail(`Duplicate option: ${arg}`);
    seen.add(arg);
    if (flags.includes(arg)) result[arg.slice(2)] = true;
    else if (values.includes(arg) && args[index + 1]?.trim() && !args[index + 1].startsWith("-")) result[arg.slice(2)] = args[++index];
    else fail(`Invalid option for ${command}; use --help`);
  }
  if (command === "update" && result.status) {
    if (Object.keys(result).some(name => !["status", "json"].includes(name))) fail("--status only accepts --json");
    return result;
  }
  if (positional && !result.file) fail(`Usage: ${MACHINE_USAGE[command]}`);
  if (result.sha256 && !/^[a-f0-9]{64}$/i.test(result.sha256)) fail("--sha256 requires 64 hexadecimal characters");
  if (result.timeout && (!/^\d+$/.test(result.timeout) || +result.timeout < 1 || +result.timeout > 600)) fail("--timeout must be 1–600 seconds");
  if (command === "update" && !result.file.endsWith(".tgz")) fail("Use a local Codey .tgz package, not an npm name or URL");
  if (["export", "import"].includes(command) && !result.file.endsWith(".gz")) fail("Use a Codey compressed backup filename ending in .gz");
  return result;
}

export function machinePaths(home, platform = process.platform) {
  const suffix = platform === "win32" ? "-windows" : platform === "darwin" ? "-macos" : "";
  return {
    root: path.join(home, ".local/share/codey-machine" + suffix),
    configRoot: path.join(home, ".config/codey-machine" + suffix),
    file: path.join(home, ".config/codey-machine" + suffix, "runtime.json"),
  };
}

export async function openMachine(root, { createInstaller, ...context } = {}) {
  const home = await realpath(context.home ?? os.userInfo().homedir);
  const platform = context.platform ?? process.platform;
  const locations = machinePaths(home, platform);
  if (!await exists(locations.file)) return null;
  const skill = path.join(root, "onboarding");
  const i = createInstaller ? await createInstaller(skill, { ...context, home }) :
    new (await import(pathToFileURL(path.join(skill, "scripts/install-machine.mjs")).href)).Installer(skill, { ...context, home });
  if (platform === "win32") await i.adapter.inspect(); // Obtains/verifies the original non-elevated owner SID.
  if (platform === "darwin") await i.adapter.machineIdentity();
  await i.checked(i.file);
  let config;
  try { config = await i.read(i.file); } catch { fail("Cannot read this owner's private runtime.json"); }
  const target = runtimePlatform(platform, context.arch ?? process.arch);
  if (config.schema !== 2 || config.kind !== `codey-${target.split("-")[0]}-oneclick` ||
      config.layout !== "npm-codey-package" || config.platform !== target || config.ownerHome !== home ||
      (i.ownerSid ? config.ownerSid !== i.ownerSid : config.ownerUid !== process.getuid()) ||
      !i.sameComputer(config) || config.runtimeRoot !== locations.root || config.configRoot !== locations.configRoot ||
      !/^n-[a-f0-9]{24}$/.test(config.nodeId) || config.pythonExe || config.updater) {
    fail("Node configuration belongs to another owner/machine or needs an explicit legacy migration");
  }
  if (config.codeyDirectory !== await realpath(root) || config.codeyBin !== path.join(config.codeyDirectory, "bin/codey.mjs")) {
    fail("Use the installed Codey command for this node, not another package's CLI");
  }
  for (const name of ["codeyDirectory", "codeyBin", "identityFile", "certificate", "tunnelFile", "setupFile", "codexHome", "stateRoot"]) {
    if (typeof config[name] !== "string") fail("Incomplete node paths");
    await i.checked(config[name]);
  }
  const info = await readPackageInfo(root, { platform, arch: context.arch ?? process.arch });
  if (info.entrySha256 !== config.codeyEntrySha256) fail("Installed package fingerprint differs from runtime.json");
  i.setup = await i.read(config.setupFile);
  i.commandRegistered = true;
  return new Machine(i, config, info);
}

export class Machine {
  constructor(installer, config, info) { this.i = installer; this.config = config; this.info = info; }
  async privateFile(file) {
    await this.i.checked(file);
    if (this.i.adapter.private) await this.i.adapter.private(file);
    else {
      const stat = await lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.mode & 0o077) fail("A credential file is not owner-private");
    }
    return file;
  }
  async tools() {
    for (const [name, expected] of Object.entries(this.config.fileHashes ?? {})) {
      if (name === "nodeExe" && this.i.adapter.nodePath) await this.i.adapter.nodePath(this.config[name]);
      else await this.i.checked(this.config[name]);
      if (!/^[a-f0-9]{64}$/.test(expected) || await fileHash(this.config[name]) !== expected) fail("Installed tool/worker fingerprint mismatch");
    }
    // Linux ready() depends on installer preflight state; its files are checked above.
    if (this.i.target !== "linux-x64") await this.i.adapter.ready?.(this.config);
  }
  async external() {
    if (this.i.adapter.external) return this.i.adapter.external();
    let pid = process.ppid;
    for (let count = 0; count < 64 && pid > 1; count++) {
      let command;
      if (this.i.target === "linux-x64") {
        let stat;
        try {
          command = (await readFile(`/proc/${pid}/cmdline`, "utf8")).replaceAll("\0", " ");
          stat = await readFile(`/proc/${pid}/stat`, "utf8");
        } catch (error) { if (error.code === "ENOENT") break; throw error; }
        pid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      } else {
        const shown = await this.i.run("/bin/ps", ["-ww", "-p", String(pid), "-o", "ppid=", "-o", "command="]);
        const match = /^\s*(\d+)\s+([\s\S]+)$/.exec(shown.stdout);
        if (!match) fail("Cannot verify the terminal's process ancestry");
        pid = Number(match[1]); command = match[2];
      }
      if (/(?:^|\/)codex(?:\.js|\.exe)?(?:\s|$)|bin\/codey\.mjs\s+(?:workspace|gateway|start|copilot\s+start)(?:\s|$)|lib\/workspace\.mjs(?:\s|$)|dist-server\/server\/index\.js/.test(command)) {
        throw Object.assign(new Error("Use an external owner terminal, not a Codey Workspace or Codex process tree"),
          { code: "CODEY_INTERNAL_TERMINAL" });
      }
    }
  }
  async lock(action, { updateJob } = {}) {
    if (!this.config.ready || this.config.state !== "ready") fail("Finish or inspect the incomplete installation first");
    const lock = await this.i.checked(path.join(this.i.configRoot, "install.lock"));
    const lease = path.join(lock, "update.json"), claim = path.join(lock, "claimed");
    if (updateJob) {
      if (!/^[a-f0-9]{32}$/.test(updateJob)) fail("Invalid update job");
      const owner = await this.i.read(await this.privateFile(lease));
      if (!isDeepStrictEqual(owner, { schema: 1, jobId: updateJob, nodeId: this.config.nodeId,
        entrySha256: this.config.codeyEntrySha256 })) fail("Update lock belongs to another operation");
      // Atomic, once-only handoff. Never delete/recreate a live or interrupted lock.
      await mkdir(claim, { mode: 0o700 });
    } else {
      try { await mkdir(lock, { mode: 0o700 }); }
      catch (error) {
        if (error.code === "EEXIST") fail("Another node operation is running, or was interrupted; inspect install.lock before retrying");
        throw error;
      }
    }
    try {
      if (!isDeepStrictEqual(await this.i.read(this.i.file), this.config)) fail("Node configuration changed concurrently; retry");
      return await action();
    } finally {
      if (!this.keepLock) {
        if (updateJob) { await rmdir(claim); await unlink(lease); }
        await rmdir(lock);
      }
    }
  }
  services() { return this.i.adapter.status(this.config); }
  async status() {
    const services = await this.services();
    return { ok: true, installed: true, version: this.info.pkg.version, platform: this.i.target,
      nodeId: this.config.nodeId, computer: this.config.computer, services,
      operationInProgress: await exists(path.join(this.i.configRoot, "install.lock")),
      running: services.filter(item => !item.auxiliary).every(item => item.running),
      ports: { workspace: 3001, gateway: 4141, data: 8443 } };
  }
  async setStates(states) { await this.i.adapter.setStates(this.config, states); }
  async waitFor(states, timeout = 60) {
    const deadline = Date.now() + timeout * 1000;
    for (;;) {
      const actual = await this.services();
      if (states.every(want => {
        const got = actual.find(item => item.name === want.name);
        return got && got.running === want.running && (got.auxiliary || got.enabled === want.enabled);
      })) return actual;
      if (Date.now() >= deadline) fail("Timed out waiting for node services; run codey status and codey doctor");
      await this.i.pause(250);
    }
  }
  async verifyRunning(states, timeout = 60) {
    const apps = states.filter(item => item.component === "codey" && !item.auxiliary);
    if (!apps.length || !apps.every(item => item.running)) return;
    const deadline = Date.now() + timeout * 1000;
    for (;;) {
      try { await this.i.probe(this.config, "verify", { timeout: Math.max(1000, deadline - Date.now()) }); return; }
      catch {
        if (Date.now() >= deadline) fail("Services started but local TLS/SSO/gateway checks failed; run codey doctor");
        await this.i.pause(500);
      }
    }
  }
  async lifecycle(operation, { tunnelOnly = false, timeout = 60 } = {}) {
    if (operation !== "start") await this.external();
    await this.lock(async () => {
      if (operation !== "stop") { await this.tools(); await this.i.checkPorts(this.config); }
      const before = (await this.services()).filter(item => !tunnelOnly || item.component === "tunnel");
      const stopped = before.map(item => ({ ...item, enabled: false, running: false }));
      if (operation !== "start") { await this.setStates(stopped); await this.waitFor(stopped, timeout); }
      if (operation !== "stop") {
        if (!this.config.tunnelAuth && !(await this.services()).some(item =>
          item.component === "tunnel" && !item.auxiliary && item.running)) {
          await this.ensureTunnelAuth(false);
        }
        await this.i.checkPorts(this.config);
        const started = before.filter(item => !item.auxiliary).map(item => ({ ...item, enabled: true, running: true }));
        await this.setStates(started);
        await this.waitFor(started, timeout);
        if (!tunnelOnly) await this.verifyRunning(started, timeout);
      }
    });
    return this.status();
  }
  async loginTunnel() {
    return this.lock(async () => {
      await this.tools();
      return this.ensureTunnelAuth(true);
    });
  }
  async ensureTunnelAuth(interactive) {
    const helpers = await import(pathToFileURL(path.join(this.i.skill, "scripts/windows-runtime.mjs")).href);
    const result = await helpers.loginTunnel(this.config.devtunnelExe, this.config.baseEnvironment, this.i.run, {
      ...this.i.auth, binding: this.config.tunnelAuth,
      githubEnvironment: this.i.githubEnvironment?.(this.config.baseEnvironment) ?? this.config.baseEnvironment, interactive,
    });
    if (result.source === "gh" && !this.config.tunnelAuth) {
      const { getGhTunnel, tunnelCoordinates } = await import(pathToFileURL(path.join(this.i.skill, "scripts/github-tunnel.mjs")).href);
      const expected = tunnelCoordinates(this.config.qualifiedTunnel);
      const shown = await (this.i.auth?.getTunnel ?? getGhTunnel)(result.credential, expected);
      helpers.validateTunnel(shown, `codey-${this.config.nodeId}`, expected.clusterId);
      if ((await this.services()).some(item => item.component === "tunnel" && item.running)) {
        fail("Stop the tunnel with codey devtunnel stop before changing its authentication; no settings were changed");
      }
      await this.save({ ...structuredClone(this.config), tunnelAuth: result.binding });
    }
    const { binding, ...status } = result; // The non-enumerable credential is never returned to the CLI.
    return { ...status, ...(binding ? { username: binding.login } : {}) };
  }
  async save(next) {
    const before = this.config;
    if (next.services) {
      next.services.codey = { ...next.services.codey, executable: next.nodeExe,
        arguments: [next.codeyBin, "start", "--foreground", "--host", "127.0.0.1", "--workspace-port", "3001", "--gateway-port", "4141"],
        workingDirectory: next.codeyDirectory, environment: next.environment };
      if (next.tunnelAuth?.source === "gh") {
        for (const [component, operation] of [["tunnel", "host"], ["renew", "renew"]]) {
          next.services[component] = { ...next.services[component], executable: next.nodeExe,
            arguments: [path.join(next.codeyDirectory, "lib/tunnel.mjs"), operation, this.i.file],
            workingDirectory: next.releaseDirectory, environment: next.baseEnvironment };
        }
      }
    }
    await this.i.adapter.switchPackage(before, next);
    try {
      if (this.i.target === "linux-x64") await this.i.adapter.configure(next);
      await this.i.write(this.i.file, next);
      if (next.modelKey !== before.modelKey) await this.i.adapter.modelKey?.(next.modelKey);
    } catch (error) {
      try {
        await this.i.adapter.switchPackage(next, before);
        if (this.i.target === "linux-x64") await this.i.adapter.configure(before);
        await this.i.write(this.i.file, before);
        if (next.modelKey !== before.modelKey) await this.i.adapter.modelKey?.(before.modelKey);
      } catch { this.keepLock = true; }
      throw error;
    }
    this.config = next;
  }
}

export function printMachine(result, json = false, log = console.log) {
  if (json) return log(JSON.stringify(result));
  if (result.jobId) {
    log(`Update ${result.jobId}: ${result.state}`);
    if (result.warning) log(result.warning);
    if (result.backup) log(`Previous settings backup: ${result.backup}`);
    log("Progress: codey update --status");
    if (result.statusFile) log(`Private report: ${result.statusFile}`);
  } else if (result.services) {
    log(`Codey ${result.version} · ${result.platform} · ${result.computer}`);
    for (const service of result.services) log(`${service.name}: ${service.state} (${service.enabled ? "enabled" : "disabled"}${service.pid ? `, pid ${service.pid}` : ""})`);
  } else if (result.file) {
    log(`${result.operation}: ${result.file}`);
    if (result.warning) log(result.warning);
    if (result.backup) log(`Previous settings backup: ${result.backup}`);
  } else log(JSON.stringify(result, null, 2));
}

export async function runMachine(root, command, args, dependencies = {}) {
  const options = machineOptions(command, args);
  if (options.help && command === "guard") return console.log(GUARD_HELP);
  if (options.help && command === "update") return console.log(UPDATE_HELP);
  if (options.help) return console.log(`Usage: ${MACHINE_USAGE[command]}\nOwner-managed node only. Secrets are never included in status output.\nLifecycle timeout: 60 seconds; stop disables watchdogs until start.\nSee onboarding/references/codey-cli.md for complete parameter details.`);
  const machine = await (dependencies.open ?? openMachine)(root, dependencies);
  if (!machine) {
    if (command === "status") return printMachine({ ok: true, installed: false }, options.json);
    fail("No managed node is configured for this owner. Complete the installation Skill first");
  }
  let result;
  if (command === "status") result = await machine.status();
  else if (command === "devtunnel login") result = await machine.loginTunnel();
  else if (["export", "import"].includes(command)) {
    const backup = await import("./machine-backup.mjs");
    result = await (command === "export" ? backup.exportMachine : backup.importMachine)(machine, options);
  } else if (command === "update") result = await (await import("./machine-update.mjs")).updateMachine(machine, options);
  else result = await machine.lifecycle(command === "guard" ? "start" : command.split(" ").at(-1),
    { tunnelOnly: command.startsWith("devtunnel "), timeout: Number(options.timeout ?? 60) });
  printMachine(result, options.json);
  if (command === "update" && options.status && result.ok === false) process.exitCode = 1;
  return result;
}
