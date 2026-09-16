#!/usr/bin/env node
/** Complete native Mac installation using Node and the OS tools, never Python. */
import { randomBytes, X509Certificate } from "node:crypto";
import { realpathSync } from "node:fs";
import { appendFile, chmod, copyFile, lstat, mkdir, readFile, readdir, realpath, rmdir, statfs, unlink } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import {
  COMPONENTS, InstallationError, agentDefinition, checkedPath, digest, directory, exists,
  label, plist, readPrivate, requireValue, run, runtime, writePrivate,
} from "./macos-service.mjs";
import { parseTunnelJson, validateTunnel } from "./windows-runtime.mjs";
import { PLATFORMS, verifyRegistrationFile } from "./registration.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const nonce = () => randomBytes(12).toString("hex");
const secret = () => randomBytes(32).toString("base64url");
const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const sameFields = (value, fields) => value && typeof value === "object" && !Array.isArray(value) &&
  isDeepStrictEqual(Object.keys(value).sort(), [...fields].sort());
const jsonFile = async file => JSON.parse(await readFile(file, "utf8"));
export const HELP = `Usage: bash scripts/install-macos.sh [--check]
       bash scripts/install-macos.sh --apply --network-approved --expected-computer NAME
                                    [--replace-existing] [--retry-failed] [--codex-home DIR]

Without --apply, inspect only; do not install tools, change files or call a model.
--replace-existing backs up and replaces Codex config/models only, retaining auth/sessions.
--retry-failed is for a reviewed failed attempt, not an upgrade or a legacy migration.
Run in the original owner's external native Mac terminal and GUI login session.
Node/npm are prepared automatically. No Python, Portal agent or local updater is used.
`;
export function installOptions(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (["--help", "-h"].includes(flag) && args.length === 1) return { help: true };
    requireValue(!Object.hasOwn(options, flag.slice(2)), "Duplicate installation option");
    if (["--apply", "--check", "--network-approved", "--replace-existing", "--retry-failed"].includes(flag)) {
      options[flag.slice(2)] = true;
    } else if (["--expected-computer", "--codex-home"].includes(flag) && args[i + 1] && !args[i + 1].startsWith("--")) {
      options[flag.slice(2)] = args[++i];
    } else throw new InstallationError("Invalid installation option; use --help");
  }
  requireValue(!(options.apply && options.check), "--check cannot be combined with --apply");
  return options;
}
export async function readPackage(skill, target) {
  requireValue(["macos-arm64", "macos-x64"].includes(target), "Use a native supported Mac architecture");
  const assets = path.join(skill, "assets");
  const manifest = await jsonFile(path.join(assets, "manifest.json"));
  const setup = await jsonFile(path.join(assets, "setup.json"));
  const pins = await jsonFile(path.join(skill, "dependencies.macos.json"));
  requireValue(manifest.schema === 2 && manifest.name === "codey" &&
    isDeepStrictEqual(manifest.runtimePlatforms, PLATFORMS) && manifest.platform === "linux-x64" &&
    manifest.dependencyMode === "npm-codey-package" &&
    isDeepStrictEqual(manifest.bundledRuntimes, ["cloudcli", "copilot-api"]), "Use a complete updater-free Codey Skill");
  requireValue(sameFields(setup, ["schema", "portalOrigin", "releaseId", "platform", "network", "tunnelAuthProvider"]) &&
    setup.schema === 1 && setup.platform === "linux-x64" && setup.tunnelAuthProvider === "github" &&
    isDeepStrictEqual(setup.network, { mode: "devtunnel" }) &&
    setup.releaseId === manifest.releaseId && /^machine-[a-f0-9]{16}$/.test(setup.releaseId), "Invalid public setup metadata");
  const origin = new URL(setup.portalOrigin);
  requireValue(origin.protocol === "https:" && origin.origin === setup.portalOrigin &&
    !origin.username && !origin.password, "Invalid Portal origin");
  requireValue(Array.isArray(manifest.artifacts) && manifest.artifacts.length === 1);
  const artifact = manifest.artifacts[0];
  requireValue(/^codey-\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?\.tgz$/.test(artifact.file) &&
    artifact.file === `codey-${manifest.codey.version}.tgz`);
  const sums = new Map();
  for (const line of (await readFile(path.join(assets, "SHA256SUMS"), "utf8")).trim().split("\n")) {
    const match = /^([a-f0-9]{64})  ([a-zA-Z0-9.-]+)$/.exec(line);
    requireValue(match && !sums.has(match[2]), "Invalid Skill checksums");
    sums.set(match[2], match[1]);
  }
  requireValue(isDeepStrictEqual([...sums.keys()].sort(), [artifact.file, "manifest.json", "setup.json"].sort()));
  for (const [name, expected] of sums) {
    const file = path.join(assets, name), info = await lstat(file);
    requireValue(info.isFile() && !info.isSymbolicLink() && await digest(file) === expected, "Skill checksum mismatch");
  }
  requireValue(artifact.sha256 === sums.get(artifact.file) &&
    (await lstat(path.join(assets, artifact.file))).size === artifact.size);
  const arch = target.slice(6), selected = pins.platforms?.[target], version = pins.nodeVersion;
  requireValue(pins.schema === 1 && /^\d+\.\d+\.\d+$/.test(version) &&
    selected?.node?.url === `https://nodejs.org/dist/v${version}/node-v${version}-darwin-${arch}.tar.gz` &&
    selected?.devTunnel?.url === `https://tunnelsassetsprod.blob.core.windows.net/cli/osx-${arch}-devtunnel` &&
    ["node", "devTunnel"].every(key => /^[a-f0-9]{64}$/.test(selected[key].sha256)) &&
    isDeepStrictEqual(pins.codex, { url: "https://chatgpt.com/codex/install.sh", release: "latest" }),
  "Invalid official runtime pins");
  return { manifest, setup: { ...setup, platform: target }, pins };
}
export async function modelConfiguration(models, templateFile = path.join(HERE, "../templates/codex-config.toml")) {
  const template = await readFile(templateFile, "utf8");
  return template.replace("__CODEY_MODEL_CATALOG__", () => JSON.stringify(models));
}
async function freePort(port) {
  for (const host of ["0.0.0.0", "::"]) {
    await new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once("error", error => {
        if (host === "::" && ["EAFNOSUPPORT", "EADDRNOTAVAIL"].includes(error.code)) resolve();
        else reject(new InstallationError(`Port ${port} is occupied or cannot be inspected; installation stopped`));
      });
      server.listen({ port, host, ipv6Only: host === "::" }, () => server.close(resolve));
    });
  }
}
export async function macPortPreflight(port, previous, { execute = run, bind = freePort, uid = process.getuid() } = {}) {
  const failure = `Port ${port} is occupied by a foreign or unverified listener; installation stopped. No process was killed.`;
  // lsof's field output is independent of localized headings and includes both
  // address families. If a listener is hidden from this user, bind fails closed.
  const snapshot = await execute("/usr/sbin/lsof",
    ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpun"], { check: false });
  requireValue([0, 1].includes(snapshot.code) && !snapshot.stderr.trim(), `Cannot inspect port ${port}; installation stopped`);
  const listeners = [];
  let pid, owner;
  for (const line of snapshot.stdout.split("\n")) {
    if (line.startsWith("p")) { pid = Number(line.slice(1)); owner = undefined; }
    else if (line.startsWith("u")) owner = Number(line.slice(1));
    else if (line.startsWith("n")) listeners.push({ pid, owner, address: line.slice(1) });
  }
  if (!listeners.length) {
    await bind(port);
    return { port, status: "free" };
  }
  requireValue(previous && previous.ownerUid === uid && previous.codeyBin === path.join(previous.codeyDirectory, "bin/codey.mjs"), failure);
  const command = port === 3001 ? "workspace --host 127.0.0.1 --port 3001" :
    "gateway start --headless --host 127.0.0.1 --port 4141";
  const pids = new Set();
  for (const listener of listeners) {
    requireValue(Number.isSafeInteger(listener.pid) && listener.pid > 0 && listener.owner === uid &&
      [`127.0.0.1:${port}`, `[::1]:${port}`].includes(listener.address), failure);
    if (pids.has(listener.pid)) continue;
    const ps = async field => {
      // macOS ps escapes non-printable characters using the current locale.
      // Keep ordinary Unicode installation paths readable even in a C shell locale.
      const result = await execute("/bin/ps", ["-ww", "-p", String(listener.pid), "-o", field + "="],
        { check: false, env: { ...process.env, LC_ALL: "en_US.UTF-8" } });
      requireValue(result.code === 0, failure);
      return result.stdout.trim();
    };
    requireValue(await ps("uid") === String(uid) && await ps("comm") === previous.nodeExe &&
      await ps("command") === `${previous.nodeExe} ${previous.codeyBin} ${command}`, failure);
    pids.add(listener.pid);
  }
  return { port, status: "owned-codey", pids: [...pids] };
}
export class Installer {
  constructor(skill, { home = os.homedir(), platform = process.platform, arch = process.arch,
    computer = os.hostname(), execute = run, portCheck, diskUsage = statfs,
    pause = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
    requireValue(platform === "darwin" && ["arm64", "x64"].includes(arch) && process.getuid() !== 0,
      "Run as the logged-on owner in a native Mac terminal, not root or Rosetta");
    this.skill = path.resolve(skill);
    this.home = realpathSync(home);
    this.target = "macos-" + arch;
    this.computer = computer;
    this.run = execute;
    this.portCheck = portCheck ?? ((port, previous) => macPortPreflight(port, previous, { execute: this.run }));
    this.diskUsage = diskUsage;
    this.pause = pause;
    this.root = path.join(this.home, ".local/share/codey-machine-macos");
    this.configRoot = path.join(this.home, ".config/codey-machine-macos");
    this.state = path.join(this.root, "state");
    this.file = path.join(this.configRoot, "runtime.json");
    this.agents = path.join(this.home, "Library/LaunchAgents");
    this.domain = `gui/${process.getuid()}`;
  }
  directory(file) { return directory(file, this.home); }
  async checkPorts(previous) {
    const result = [];
    for (const port of [3001, 4141, 8443]) result.push(await this.portCheck(port, previous));
    return result;
  }
  attemptIdentity() {
    return { schema: 1, kind: "codey-macos-oneclick", ownerUid: process.getuid(),
      ownerHome: this.home, platform: this.target, portalOrigin: this.setup.portalOrigin, workerRuntime: "node" };
  }
  async download(item, destination) {
    await this.run("/usr/bin/curl", ["--fail", "--location", "--proto", "=https", "--proto-redir", "=https",
      "--tlsv1.2", "--connect-timeout", "30", "--max-time", "300", "--output", destination, item.url], { timeout: 330000 });
    requireValue(!item.sha256 || await digest(destination) === item.sha256, "Official runtime checksum mismatch");
    await chmod(destination, 0o700);
  }
  probe(config, operation) {
    return this.run(config.nodeExe, [config.helperPath, operation, this.file],
      { env: config.environment, cwd: config.codeyDirectory, timeout: 330000 });
  }
  async verifyAgents(config) {
    const disabled = (await this.run("/bin/launchctl", ["print-disabled", this.domain])).stdout;
    for (const component of COMPONENTS) {
      const id = label(config.nodeId, component), file = path.join(this.agents, id + ".plist");
      requireValue(!disabled.includes(`"${id}" => true`), "LaunchAgent is disabled");
      await checkedPath(file, this.home);
      const saved = JSON.parse((await this.run("/usr/bin/plutil", ["-convert", "json", "-o", "-", file])).stdout);
      requireValue(isDeepStrictEqual(saved, agentDefinition(config, this.file, component)), "LaunchAgent belongs to another installation");
      const status = (await this.run("/bin/launchctl", ["print", this.domain + "/" + id])).stdout;
      requireValue([...status.matchAll(/^\s*path = (.+)$/gm)].map(match => match[1]).join("\n") === file,
        "LaunchAgent path mismatch");
      requireValue(component === "renew" || /^\s*pid = [1-9][0-9]*$/m.test(status), "LaunchAgent is not running");
    }
  }
  async installCommand(config) {
    const bin = await this.directory(path.join(this.home, ".local/bin")), file = path.join(bin, "codey");
    const marker = "# CODEY_MACOS_MANAGED_LAUNCHER";
    if (await exists(file)) {
      const info = await lstat(file);
      requireValue(info.isFile() && !info.isSymbolicLink() && info.uid === process.getuid());
      const text = await readFile(file, "utf8");
      requireValue(text.includes(marker) || text.includes("CODEY_SHARED_NPM_LAUNCHER"), "Refusing to replace an unmanaged codey command");
    }
    const argv = [config.nodeExe, config.workerPath, "cli", this.file].map(shellQuote).join(" ");
    await writePrivate(file, Buffer.from(`#!/bin/sh\n${marker}\nexec ${argv} "$@"\n`));
    await chmod(file, 0o700);
    const block = '\n# >>> Codey PATH >>>\ncase ":${PATH:-}:" in\n  *":$HOME/.local/bin:"*) ;;\n  *) export PATH="$HOME/.local/bin${PATH:+:$PATH}" ;;\nesac\n# <<< Codey PATH <<<\n';
    for (const name of [".profile", ".bashrc", ".bash_profile", ".bash_login", ".zprofile", ".zshrc"]) {
      const profile = path.join(this.home, name), present = await exists(profile);
      if ([".bash_profile", ".bash_login"].includes(name) && !present) continue;
      // Preserve deliberate owner dotfile links, but never write through one outside HOME.
      if (present) {
        const resolved = await realpath(profile);
        await checkedPath(resolved, this.home);
        if ((await readFile(resolved, "utf8")).includes("# >>> Codey PATH >>>")) continue;
      }
      await appendFile(profile, block, { mode: 0o600 });
    }
  }
  async preflight(options) {
    requireValue(await realpath(this.home) === this.home);
    Object.assign(this, await readPackage(this.skill, this.target));
    requireValue((await readFile(path.join(this.skill, "templates/codex-config.toml"), "utf8"))
      .split("__CODEY_MODEL_CATALOG__").length === 2, "The shared model configuration template is missing or invalid");
    for (const file of [this.root, this.configRoot, this.state, this.agents, this.file]) await checkedPath(file, this.home);
    const codexHome = await checkedPath(path.resolve(options["codex-home"] || process.env.CODEX_HOME || path.join(this.home, ".codex")), this.home);
    const previous = await exists(this.file) ? await readPrivate(this.file) : null;
    let unfinished = false;
    if (previous) {
      requireValue(previous.schema === 2 && previous.kind === "codey-macos-oneclick" && previous.workerRuntime === "node" &&
        previous.layout === "npm-codey-package" && previous.platform === this.target &&
        previous.ownerUid === process.getuid() && previous.ownerHome === this.home &&
        previous.computer === this.computer &&
        previous.runtimeRoot === this.root && previous.configRoot === this.configRoot &&
        previous.portalOrigin === this.setup.portalOrigin && !previous.pythonExe && !previous.updater,
      "Existing or Python/updater-managed installation requires an explicit migration; it will not be taken over");
      requireValue(previous.releaseId === this.setup.releaseId && previous.codexHome === codexHome,
        "Existing release or Codex home differs; installation is not an update or configuration migration");
      for (const file of [previous.nodeExe, previous.codeyBin, previous.codeyDirectory]) await checkedPath(file, this.root);
      requireValue(previous.codeyBin === path.join(previous.codeyDirectory, "bin/codey.mjs") &&
        await digest(path.join(previous.codeyDirectory, "codey-build.json")) === this.manifest.codey.entrySha256,
      "Existing Codey package differs from this release");
    } else if (await exists(this.configRoot) && (await readdir(this.configRoot)).length) {
      const attempt = path.join(this.configRoot, "attempt.json");
      requireValue(await exists(attempt) && isDeepStrictEqual(await readPrivate(attempt), this.attemptIdentity()),
        "Nonempty configuration directory is not owned by this installer");
      unfinished = true;
    } else requireValue(!await exists(this.root) || !(await readdir(this.root)).length,
      "Nonempty runtime directory has no recognized installation state");
    const overwrites = [];
    for (const name of ["config.toml", "models.json"]) {
      const file = await checkedPath(path.join(codexHome, name), this.home);
      if (await exists(file)) overwrites.push(file);
    }
    if (options.apply) requireValue(options["network-approved"] && options["expected-computer"] === this.computer,
      "Apply requires --network-approved and --expected-computer matching this Mac exactly");
    const translated = await this.run("/usr/sbin/sysctl", ["-in", "sysctl.proc_translated"], { check: false });
    requireValue(translated.stdout.trim() !== "1", "Use a native terminal/Node, not Rosetta");
    await this.run("/bin/launchctl", ["print", this.domain]);
    if (previous?.ready) await runtime(this.file, { home: this.home, worker: previous.workerPath });
    const listeners = await this.checkPorts(previous);
    const plan = { platform: this.target, ownerUid: process.getuid(), computer: this.computer, mode: options.apply ? "apply" : "check",
      releaseId: this.manifest.releaseId, replaceConfiguration: overwrites, existingNode: Boolean(previous),
      listeners,
      startup: "owner GUI logon LaunchAgents", registrationFile: path.join(this.home, "codey-machine-registration.json") };
    if (!options.apply) return { plan, previous, codexHome };
    if (previous?.ready && previous.state === "ready") return { plan, previous, codexHome };
    requireValue(!(previous || unfinished) || options["retry-failed"], "Inspect the failed attempt, then use --retry-failed");
    requireValue(!overwrites.length || options["replace-existing"], "Existing Codex configuration requires --replace-existing");
    const codex = await this.run("/usr/bin/pgrep", ["-u", String(process.getuid()), "-x", "codex"], { check: false });
    requireValue(codex.code === 1, "Close Codex/Desktop and use an external Mac terminal first");
    await this.run("/usr/bin/openssl", ["version"]);
    const disk = await this.diskUsage(this.home);
    requireValue(disk.bavail * disk.bsize >= 8 * 1024 ** 3, "At least 8 GiB of free space is required");
    return { plan, previous, codexHome };
  }
  async apply(options) {
    const { plan, previous, codexHome } = await this.preflight(options);
    if (!options.apply) { console.log(JSON.stringify(plan, null, 2)); return plan; }
    await this.directory(this.configRoot);
    const lock = await checkedPath(path.join(this.configRoot, "install.lock"), this.home);
    try { await mkdir(lock, { mode: 0o700 }); }
    catch (error) {
      if (error.code === "EEXIST") throw new InstallationError("Another install is running or was interrupted; inspect install.lock before retrying");
      throw error;
    }
    try {
      const current = await exists(this.file) ? await readPrivate(this.file) : null;
      requireValue(isDeepStrictEqual(current, previous), "Installation state changed concurrently; rerun the check");
      await this.checkPorts(previous);
      let config = previous;
      if (!(previous?.ready && previous.state === "ready")) {
        for (const file of [this.root, this.state, this.agents, path.join(this.root, "releases")]) await this.directory(file);
        await writePrivate(path.join(this.configRoot, "attempt.json"), this.attemptIdentity());
        config = await this.deploy(options, codexHome, previous);
      } else await runtime(this.file, { home: this.home, worker: previous.workerPath });
      await this.verifyAgents(config);
      await this.installCommand(config);
      // registration verifies live TLS/SSO/data itself; do not repeat that
      // same probe here after deployment's readiness check.
      await this.probe(config, "registration");
      const output = path.join(this.home, "codey-machine-registration.json");
      await verifyRegistrationFile(output, this.setup);
      console.log(`Codey macOS locally installed and verified. Registration: ${output}`);
      console.log("Import this private file into your Portal, verify access, then delete it. No updater is installed.");
      return config;
    } finally { await rmdir(lock); }
  }
  async deploy(options, codexHome, previous) {
    const identityFile = path.join(this.state, "identity.json");
    const identity = await exists(identityFile) ? await readPrivate(identityFile) : {
      ...this.attemptIdentity(), nodeId: "n-" + nonce(), workspaceSubject: "m-" + nonce(), workspaceUsername: "owner",
      clientSigningKey: secret(), workspaceSsoKey: secret(), tunnelUpdateKey: secret(),
    };
    requireValue(identity.ownerUid === process.getuid() && identity.ownerHome === this.home &&
      /^n-[a-f0-9]{24}$/.test(identity.nodeId) && /^m-[a-f0-9]{24}$/.test(identity.workspaceSubject) &&
      /^[a-z][a-z0-9_-]{0,31}$/.test(identity.workspaceUsername) &&
      ["clientSigningKey", "workspaceSsoKey", "tunnelUpdateKey"].every(key => /^[A-Za-z0-9_-]{43}$/.test(identity[key])) &&
      (!previous || previous.nodeId === identity.nodeId), "Existing identity requires review");
    if (!await exists(identityFile)) await writePrivate(identityFile, identity);
    for (const component of COMPONENTS) {
      const file = path.join(this.agents, label(identity.nodeId, component) + ".plist");
      if (!await exists(file)) continue;
      const saved = JSON.parse((await this.run("/usr/bin/plutil", ["-convert", "json", "-o", "-", file])).stdout);
      requireValue(previous && isDeepStrictEqual(saved, agentDefinition(previous, this.file, component)), "Existing LaunchAgent collision");
    }
    const release = await this.directory(path.join(this.root, "releases", this.manifest.releaseId + "-" + nonce()));
    const selected = this.pins.platforms[this.target], archive = path.join(release, "node.tar.gz");
    console.log("[1/4] Prepare the shared Codey package and official tools");
    if (process.env.CODEY_BOOTSTRAP_NODE_ARCHIVE) {
      await copyFile(process.env.CODEY_BOOTSTRAP_NODE_ARCHIVE, archive);
      requireValue(await digest(archive) === selected.node.sha256, "Bootstrap Node checksum mismatch");
    } else await this.download(selected.node, archive);
    // Only the checksummed official archive is extracted into this new private directory.
    await this.run("/usr/bin/tar", ["-xzf", archive, "-C", release]);
    await unlink(archive);
    const node = path.join(release, `node-v${this.pins.nodeVersion}-darwin-${this.target.slice(6)}`, "bin/node");
    requireValue((await this.run(node, ["--version"])).stdout.trim() === "v" + this.pins.nodeVersion, "Node version mismatch");
    const base = { HOME: this.home, USER: process.env.USER || "owner", LOGNAME: process.env.LOGNAME || "owner",
      PATH: `${path.dirname(node)}:/usr/bin:/bin:/usr/sbin:/sbin`, NODE_ENV: "production", TMPDIR: process.env.TMPDIR || "/tmp" };
    const prefix = path.join(release, "app"), artifact = this.manifest.artifacts[0];
    await this.run(node, [path.join(this.skill, "scripts/install-runtime.mjs"), "--package", path.join(this.skill, "assets", artifact.file),
      "--sha256", artifact.sha256, "--prefix", prefix, "--check"], { env: base, timeout: 1800000 });
    const codey = path.join(prefix, "lib/node_modules/codey");
    requireValue(await digest(path.join(codey, "codey-build.json")) === this.manifest.codey.entrySha256 &&
      await digest(path.join(codey, "npm-shrinkwrap.json")) === this.manifest.codey.lockSha256, "Codey package fingerprint mismatch");
    const devtunnel = path.join(release, "devtunnel");
    await this.download(selected.devTunnel, devtunnel);
    console.log("[2/4] Configure private GitHub DevTunnel and node TLS");
    const shownUser = await this.run(devtunnel, ["user", "show", "--json"], { env: base, check: false });
    let user = shownUser.code === 0 ? parseTunnelJson(shownUser.stdout) : {};
    if (user.status !== "Logged in") {
      await this.run(devtunnel, ["user", "login", "--github", "--use-device-code-auth"], { env: base, interactive: true, timeout: 900000 });
      user = parseTunnelJson((await this.run(devtunnel, ["user", "show", "--json"], { env: base })).stdout);
    }
    requireValue(user.status === "Logged in" && user.provider === "github", "Do not switch an existing DevTunnel account/provider automatically");
    const tunnelId = "codey-" + identity.nodeId;
    let shown = await this.run(devtunnel, ["show", tunnelId, "--json"], { env: base, check: false });
    if (shown.code) shown = await this.run(devtunnel, ["create", tunnelId, "--description", "Codey macOS " + identity.nodeId, "--json"], { env: base });
    const raw = parseTunnelJson(shown.stdout), tunnel = raw.tunnel || raw, parts = (tunnel.tunnelId || "").split(".");
    const cluster = parts.length === 2 ? parts[1] : tunnel.clusterId;
    requireValue(parts.length <= 2 && parts[0] === tunnelId && /^[a-z][a-z0-9]{1,15}$/.test(cluster));
    const qualified = `${tunnelId}.${cluster}`;
    for (const port of [3001, 8443]) {
      if (!(tunnel.ports || []).some(item => item.portNumber === port && item.protocol === "https")) {
        await this.run(devtunnel, ["port", "create", qualified, "--port-number", String(port), "--protocol", "https", "--json"], { env: base });
      }
    }
    const tunnelFile = path.join(this.state, "tunnel.json");
    const actual = parseTunnelJson((await this.run(devtunnel, ["show", qualified, "--json"], { env: base })).stdout);
    validateTunnel(actual, tunnelId, cluster);
    await writePrivate(tunnelFile, actual);
    const supervisor = await this.directory(path.join(this.root, "supervisor"));
    for (const name of ["macos-service.mjs", "windows-runtime.mjs", "registration.mjs"]) {
      await writePrivate(path.join(supervisor, name), await readFile(path.join(this.skill, "scripts", name)));
    }
    const cert = path.join(this.configRoot, "node-cert.pem"), key = path.join(this.configRoot, "node-key.pem");
    const serverName = `${identity.nodeId}.nodes.codey.internal`;
    requireValue(await exists(cert) === await exists(key), "Incomplete TLS identity requires review; it will not be rotated");
    if (!await exists(cert)) {
      const openssl = path.join(this.configRoot, "openssl.cnf");
      await writePrivate(openssl, Buffer.from(`[req]\nprompt = no\ndistinguished_name = dn\nx509_extensions = leaf\n` +
        `[dn]\nCN = ${serverName}\n[leaf]\nsubjectAltName = DNS:${serverName}\n` +
        "basicConstraints = critical,CA:FALSE\nkeyUsage = critical,digitalSignature,keyEncipherment\nextendedKeyUsage = serverAuth\n"));
      await this.run("/usr/bin/openssl", ["req", "-x509", "-newkey", "rsa:3072", "-nodes", "-days", "365",
        "-config", openssl, "-keyout", key, "-out", cert]);
      await chmod(key, 0o600);
      await chmod(cert, 0o600);
    }
    const leaf = new X509Certificate(await readFile(cert));
    requireValue(!leaf.ca && leaf.checkHost(serverName, { wildcards: false }) && Date.parse(leaf.validTo) > Date.now() + 86400000,
      "Existing TLS certificate needs explicit renewal and Portal re-pinning");
    const signing = path.join(this.configRoot, "client-signing.key");
    await writePrivate(signing, Buffer.from(identity.clientSigningKey + "\n"));
    const copilot = await this.directory(path.join(this.root, "copilot-home")), data = await this.directory(path.join(this.root, "data"));
    const providerFile = path.join(copilot, "config.json");
    const provider = await exists(providerFile) ? await readPrivate(providerFile) :
      { auth: { apiKeys: [secret()], adminApiKey: secret(), sessionHistoryApiKey: secret() } };
    requireValue(/^[A-Za-z0-9_-]{43}$/.test(provider.auth?.apiKeys?.[0]), "Existing model key requires review");
    if (!await exists(providerFile)) await writePrivate(providerFile, provider);
    const modelKey = provider.auth.apiKeys[0], codexBin = await this.directory(path.join(this.root, "codex-bin"));
    const environment = { ...base, CODEY_MANAGED: "true", CODEY_PORTAL_SSO: "true", CODEX_HOME: codexHome,
      COPILOT_API_HOME: copilot, CODEY_MODEL_API_KEY: modelKey, DATABASE_PATH: path.join(data, "auth.db"),
      CODEY_CODEX_EXECUTABLE: path.join(codexBin, "codex"), COPILOT_API_CODEY_HTTPS_PORT: "8443",
      COPILOT_API_CODEY_HTTPS_HOST: "127.0.0.1", COPILOT_API_CODEY_TLS_CERT: cert, COPILOT_API_CODEY_TLS_KEY: key,
      COPILOT_API_CODEY_NODE_ID: identity.nodeId, COPILOT_API_CODEY_ALLOWED_ORIGIN: this.setup.portalOrigin,
      COPILOT_API_CODEY_SIGNING_KEY_FILE: signing, CODEY_PORTAL_NODE_ID: identity.nodeId,
      CODEY_PORTAL_USERNAME: identity.workspaceUsername, CODEY_PORTAL_PRINCIPAL_ID: identity.workspaceSubject,
      CODEY_PORTAL_SSO_KEY: identity.workspaceSsoKey, CODEY_PORTAL_TLS_CERT: cert, CODEY_PORTAL_TLS_KEY: key };
    const config = { ...this.attemptIdentity(), schema: 2, layout: "npm-codey-package", computer: this.computer,
      nodeId: identity.nodeId, releaseId: this.setup.releaseId, releaseDirectory: release, runtimeRoot: this.root,
      configRoot: this.configRoot, stateRoot: this.state, nodeExe: node, devtunnelExe: devtunnel,
      workerPath: path.join(supervisor, "macos-service.mjs"), helperPath: path.join(supervisor, "windows-runtime.mjs"),
      registrationHelper: path.join(supervisor, "registration.mjs"), codeyDirectory: codey, codeyBin: path.join(codey, "bin/codey.mjs"),
      codeyEntrySha256: this.manifest.codey.entrySha256, codexExe: path.join(codexBin, "codex"),
      codexHome, modelKey, identityFile, tunnelFile, qualifiedTunnel: qualified, certificate: cert, serverName,
      setupFile: path.join(this.configRoot, "setup.json"), environment, baseEnvironment: base, state: "installing", ready: false,
      fileHashes: {} };
    for (const name of ["nodeExe", "devtunnelExe", "workerPath", "helperPath", "registrationHelper"]) config.fileHashes[name] = await digest(config[name]);
    await writePrivate(config.setupFile, this.setup);
    await writePrivate(this.file, config);
    const started = [];
    try {
      console.log("[3/4] Authenticate the gateway and configure official Codex");
      const token = path.join(copilot, "github_token");
      if (!await exists(token) || !(await lstat(token)).size) {
        await this.run(node, [config.codeyBin, "auth", "login", "--provider", "copilot"],
          { env: environment, cwd: codey, interactive: true, timeout: 900000 });
      }
      const installer = path.join(release, "codex-install.sh");
      await this.download(this.pins.codex, installer);
      requireValue((await readFile(installer, "utf8")).includes("https://releases.openai.com/codex"), "Unexpected official Codex installer");
      const standaloneHome = await this.directory(path.join(this.root, "codex-install"));
      await this.run("/bin/bash", [installer], { env: { ...environment, CODEX_INSTALL_DIR: codexBin, CODEX_HOME: standaloneHome,
        CODEX_RELEASE: "latest", CODEX_NON_INTERACTIVE: "true", CODEX_INSTALLER_USE_RELEASES_OPENAI_COM: "true" }, timeout: 900000 });
      config.codexExe = environment.CODEY_CODEX_EXECUTABLE = await checkedPath(await realpath(path.join(codexBin, "codex")), this.root);
      requireValue((await this.run(config.codexExe, ["--version"], { env: environment })).stdout.startsWith("codex-cli "));
      await this.directory(codexHome);
      for (const [name, content] of [
        ["models.json", await readFile(path.join(this.skill, "templates/a100-models.json"))],
        ["config.toml", Buffer.from(await modelConfiguration(path.join(codexHome, "models.json"),
          path.join(this.skill, "templates/codex-config.toml")))],
      ]) {
        const destination = await checkedPath(path.join(codexHome, name), this.home);
        if (await exists(destination)) await writePrivate(destination + "." + nonce() + ".bak", await readFile(destination));
        await writePrivate(destination, content);
      }
      await writePrivate(this.file, config);
      console.log("[4/4] Start owner LaunchAgents and verify real Workspace/gateway/Codex responses");
      await this.checkPorts(previous);
      for (const component of COMPONENTS) {
        const id = label(identity.nodeId, component), file = path.join(this.agents, id + ".plist");
        await writePrivate(file, plist(agentDefinition(config, this.file, component)));
        started.push(id);
        await this.run("/bin/launchctl", ["enable", this.domain + "/" + id]);
        await this.run("/bin/launchctl", ["bootstrap", this.domain, file]);
      }
      for (let attempt = 0; ; attempt++) {
        try { await this.probe(config, "verify"); break; }
        catch (error) {
          if (attempt === 29) throw error;
          await this.pause(2000);
        }
      }
      const answer = path.join(this.state, "codex-answer-" + nonce() + ".txt");
      await this.run(config.codexExe, ["exec", "--skip-git-repo-check", "--output-last-message", answer,
        "Reply with only CODEY_CODEX_OK. Do not use tools."], { env: environment, cwd: this.home, timeout: 330000 });
      requireValue((await readFile(answer, "utf8")).trim() === "CODEY_CODEX_OK", "Real Codex response mismatch");
      await this.probe(config, "sdk-probe");
      Object.assign(config, { ready: true, state: "ready" });
      await writePrivate(this.file, config);
      return config;
    } catch (error) {
      for (const id of started.reverse()) {
        try {
          await this.run("/bin/launchctl", ["disable", this.domain + "/" + id], { check: false });
          await this.run("/bin/launchctl", ["bootout", this.domain + "/" + id], { check: false });
        } catch { console.error("Could not stop an owned LaunchAgent; inspect the private installation state."); }
      }
      Object.assign(config, { ready: false, state: "failed" });
      await writePrivate(this.file, config);
      throw error;
    }
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  (async () => {
    const options = installOptions(process.argv.slice(2));
    if (options.help) { console.log(HELP); return; }
    process.umask(0o077);
    await new Installer(path.dirname(HERE)).apply(options);
  })().catch(error => {
    console.error(error instanceof InstallationError ? error.message : "macOS installation failed; inspect the private installation state.");
    process.exitCode = 1;
  });
}
