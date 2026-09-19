#!/usr/bin/env node
/** The installation workflow. Adapters contain native OS operations, not another installer. */
import { createPublicKey, randomBytes, X509Certificate } from "node:crypto";
import { realpathSync } from "node:fs";
import { chmod, copyFile, lstat, mkdir, readFile, readdir, realpath, rm, rmdir, statfs, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  InstallationError, checkedPath, digest, directory, exists, inside, readPrivate, requireValue, run, writePrivate,
} from "./machine-common.mjs";
import { assertInstalled, modelConfiguration, readPackage, readPins } from "./machine-package.mjs";
import { macosAdapter } from "./platform-macos.mjs";
import { linuxAdapter } from "./platform-linux.mjs";
import { windowsAdapter } from "./platform-windows.mjs";
import { loginTunnel, parseTunnelJson, validateTunnel } from "./windows-runtime.mjs";
import { PLATFORMS, verifyRegistrationFile } from "./registration.mjs";
import { writeResources } from "./machine-resources.mjs";
import { ensureGhTunnel } from "./github-tunnel.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const nonce = () => randomBytes(12).toString("hex");
const secret = () => randomBytes(32).toString("base64url");
export const HELP = `Usage: node scripts/install-machine.mjs [--check]
       node scripts/install-machine.mjs --apply --network-approved --expected-computer NAME
         [--replace-existing] [--retry-failed] [--codex-home DIR] [--registry HTTPS_URL]

Checks are read-only: no downloads, file changes, logins, services or model requests.
Apply installs a native Linux, Windows or macOS node. Repeating the same release
verifies the existing installation and exports JSON; it never upgrades or restarts it.
--replace-existing permits backed-up Codex configuration changes, not key rotation.
--retry-failed requires a reviewed failed attempt; never use it to migrate a legacy node.
Prepared applications and official tools are verified and resumed in place, not copied.
--registry selects an approved HTTPS public npm mirror without changing global settings.
Only a private registration JSON file is exported. No automatic Portal registration.
`;
export function installOptions(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (["--help", "-h"].includes(flag) && args.length === 1) return { help: true };
    requireValue(!Object.hasOwn(options, flag.slice(2)), "Duplicate installation option");
    if (["--apply", "--check", "--network-approved", "--replace-existing", "--retry-failed"].includes(flag)) {
      options[flag.slice(2)] = true;
    } else if (["--expected-computer", "--codex-home", "--registry"].includes(flag) && args[i + 1] && !args[i + 1].startsWith("--")) {
      options[flag.slice(2)] = args[++i];
    } else throw new InstallationError("Invalid installation option; use --help");
  }
  requireValue(!(options.apply && options.check), "--check cannot be combined with --apply");
  if (options.registry) {
    const url = new URL(options.registry);
    requireValue(url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash,
      "Use an HTTPS public npm registry without credentials, query or fragment");
  }
  return options;
}

export class Installer {
  constructor(skill, { home = os.homedir(), platform = process.platform, arch = process.arch,
    computer = os.hostname(), execute = run, portCheck, diskUsage = statfs, prepared,
    adapter, auth = {}, pause = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
    this.target = `${platform === "darwin" ? "macos" : platform === "win32" ? "windows" : platform}-${arch}`;
    requireValue(PLATFORMS.includes(this.target) && process.getuid?.() !== 0,
      "Run as the original owner on a supported native platform, not root");
    this.skill = path.resolve(skill);
    this.home = realpathSync(home);
    if (execute === run && platform === process.platform) {
      requireValue(this.home === realpathSync(os.userInfo().homedir), "Use the original OS account home, not an overridden HOME");
    }
    this.computer = computer;
    this.run = execute;
    this.pause = pause;
    this.diskUsage = diskUsage;
    this.prepared = prepared;
    this.auth = auth;
    const suffix = platform === "linux" ? "" : platform === "win32" ? "-windows" : "-macos";
    this.root = path.join(this.home, ".local/share/codey-machine" + suffix);
    this.configRoot = path.join(this.home, ".config/codey-machine" + suffix);
    this.state = platform === "linux" ? path.join(this.home, ".local/state/codey-machine") : path.join(this.root, "state");
    this.file = path.join(this.configRoot, "runtime.json");
    this.adapter = typeof adapter === "function" ? adapter(this) : adapter ?? (platform === "darwin" ? macosAdapter(this) :
      platform === "win32" ? windowsAdapter(this) : linuxAdapter(this));
    this.portCheck = portCheck;
    this.timings = [];
  }
  async stage(name, action) {
    const started = Date.now();
    console.log(`[${new Date().toISOString()}] ${name}`);
    const progress = setInterval(() => console.log(`[progress] ${name}: ${((Date.now() - started) / 1000).toFixed(1)}s`), 10000);
    progress.unref();
    let ok = false;
    try { const result = await action(); ok = true; return result; }
    finally {
      clearInterval(progress);
      const seconds = (Date.now() - started) / 1000;
      this.timings.push({ stage: name, seconds, ok });
      console.log(`[${ok ? "done" : "failed"}] ${name}: ${seconds.toFixed(1)}s`);
    }
  }
  checked(file) { return this.adapter.checked ? this.adapter.checked(file) : checkedPath(file, this.home); }
  directory(file) { return this.adapter.directory ? this.adapter.directory(file) : directory(file, this.home); }
  read(file) { return this.adapter.read ? this.adapter.read(file) : readPrivate(file); }
  write(file, value) { return this.adapter.write ? this.adapter.write(file, value) : writePrivate(file, value); }
  async checkPorts(previous) {
    if (!this.portCheck && this.adapter.ports) return this.adapter.ports(previous);
    const result = [];
    for (const port of [3001, 4141, 8443]) result.push(await (this.portCheck ?? this.adapter.port)(port, previous));
    return result;
  }
  attemptIdentity() {
    return { schema: 1, kind: `codey-${this.target.split("-")[0]}-oneclick`,
      ...(this.ownerSid ? { ownerSid: this.ownerSid } : { ownerUid: process.getuid() }),
      ...(this.machineId ? { machineId: this.machineId } : {}),
      ownerHome: this.home, platform: this.target, portalOrigin: this.setup.portalOrigin, workerRuntime: "node" };
  }
  sameComputer(config) {
    return this.target.startsWith("macos-") && config.machineId
      ? Boolean(this.machineId) && config.machineId === this.machineId : config.computer === this.computer;
  }
  async download(item, destination) {
    if (await exists(destination) && item.sha256 && await digest(destination) === item.sha256) return;
    if (this.adapter.download) await this.adapter.download(item, destination);
    else await this.run("/usr/bin/curl", ["--fail", "--location", "--proto", "=https", "--proto-redir", "=https",
      "--tlsv1.2", "--connect-timeout", "30", "--max-time", "300", "--output", destination, item.url], { timeout: 330000 });
    requireValue(!item.sha256 || await digest(destination) === item.sha256, "Official runtime checksum mismatch");
    if (!this.ownerSid) await chmod(destination, 0o700);
  }
  probe(config, operation, { timeout = 330000 } = {}) {
    // Use this reviewed helper, not a stale installer's probe implementation.
    return this.run(config.nodeExe, [path.join(HERE, "windows-runtime.mjs"), operation, this.file],
      { env: config.environment, cwd: config.codeyDirectory, timeout });
  }
  packageFiles(root) {
    return assertInstalled(root, this.manifest, this.prepared ? {} : {
      artifact: path.join(this.skill, "assets", this.manifest.artifacts[0].file), home: this.home,
    });
  }
  async modelFiles(codexHome) {
    return [
      ["models.json", await readFile(path.join(this.skill, "templates/a100-models.json"))],
      ["config.toml", Buffer.from(await modelConfiguration(path.join(codexHome, "models.json"),
        path.join(this.skill, "templates/codex-config.toml")))],
    ];
  }
  async validatePrevious(previous, codexHome) {
    requireValue(previous.schema === 2 && previous.kind === this.attemptIdentity().kind &&
      previous.layout === "npm-codey-package" && (previous.platform ?? this.target) === this.target &&
      (this.ownerSid ? previous.ownerSid === this.ownerSid : previous.ownerUid === process.getuid()) &&
      previous.ownerHome === this.home && this.sameComputer(previous) &&
      previous.runtimeRoot === this.root && previous.configRoot === this.configRoot &&
      previous.portalOrigin === this.setup.portalOrigin && !previous.pythonExe && !previous.updater && !previous.repairPending,
    "Existing or Python/updater-managed installation requires an explicit migration; it will not be taken over");
    requireValue(previous.releaseId === this.setup.releaseId && previous.codexHome === codexHome,
      "Existing release or Codex home differs; installation is not an update or configuration migration");
    if (this.adapter.nodePath) await this.adapter.nodePath(previous.nodeExe);
    else await this.checked(previous.nodeExe);
    for (const file of [previous.codeyBin, previous.codeyDirectory, previous.identityFile,
      previous.certificate, previous.tunnelFile]) await this.checked(file);
    requireValue(previous.codeyBin === path.join(previous.codeyDirectory, "bin/codey.mjs"));
    await this.packageFiles(previous.codeyDirectory);
    if (previous.ready) {
      await this.certificate(await this.read(previous.identityFile), false);
      await this.adapter.ready(previous);
    }
  }
  async preflight(options) {
    requireValue(await this.checked(path.join(this.home, ".config")) !== undefined);
    const metadata = this.prepared ?? await readPackage(this.skill, this.target);
    Object.assign(this, { manifest: metadata.manifest, setup: metadata.setup, pins: metadata.pins });
    this.pins ??= await readPins(this.skill, this.target);
    requireValue((await readFile(path.join(this.skill, "templates/codex-config.toml"), "utf8"))
      .split("__CODEY_MODEL_CATALOG__").length === 2, "The shared model configuration template is missing or invalid");
    await this.adapter.inspect();
    for (const file of [this.root, this.configRoot, this.state, this.file, ...this.adapter.directories]) await this.checked(file);
    const codexHome = await this.checked(path.resolve(options["codex-home"] || process.env.CODEX_HOME || path.join(this.home, ".codex")));
    const saved = await exists(this.file) ? await this.read(this.file) : null;
    const previous = saved ?? await this.adapter.existing?.(codexHome) ?? null;
    await this.adapter.preflight?.(previous);
    await this.adapter.collisions?.(previous);
    let unfinished = false;
    if (previous) await this.validatePrevious(previous, codexHome);
    else if (await exists(this.configRoot) && (await readdir(this.configRoot)).length) {
      const attempt = path.join(this.configRoot, "attempt.json");
      requireValue(await exists(attempt) && isDeepStrictEqual(await this.read(attempt), this.attemptIdentity()),
        "Nonempty configuration directory is not owned by this installer");
      unfinished = true;
    } else if (!this.prepared) requireValue(!await exists(this.root) || !(await readdir(this.root)).length,
      "Nonempty runtime directory has no recognized installation state");
    const overwrites = [], expectedModels = previous ? await this.modelFiles(codexHome) : [];
    for (const file of [path.join(codexHome, "config.toml"), path.join(codexHome, "models.json"),
      ...(this.target === "linux-x64" ? [path.join(this.home, ".local/share/copilot-api/config.json")] : [])]) {
      await this.checked(file);
      if (await exists(file)) {
        const expected = expectedModels.find(([name]) => file === path.join(codexHome, name))?.[1];
        if (!expected || !(await readFile(file)).equals(expected)) overwrites.push(file);
      }
    }
    if (options.apply) requireValue(options["network-approved"] && options["expected-computer"] === this.computer,
      "Apply requires --network-approved and --expected-computer matching this machine exactly");
    const listeners = await this.checkPorts(previous);
    const plan = { platform: this.target, computer: this.computer, mode: options.apply ? "apply" : "check",
      releaseId: this.manifest.releaseId, replaceConfiguration: previous?.ready ? [] : overwrites,
      existingNode: Boolean(previous), listeners, startup: this.adapter.startup,
      codexPolicy: this.target.startsWith("macos-") ? "reuse-verified-standalone-or-download" : "download-official",
      deferred: ["network/login", "native dependencies", "TLS/SSO/model response", "registration export"],
      registrationFile: path.join(this.home, "codey-machine-registration.json"), automaticRegistration: false };
    if (!options.apply || previous?.ready) return { plan, previous, saved, codexHome };
    requireValue(!(previous || unfinished) || options["retry-failed"], "Inspect the failed attempt, then use --retry-failed");
    requireValue(!overwrites.length || options["replace-existing"], "Existing Codex/gateway configuration requires --replace-existing");
    await this.adapter.available(codexHome);
    const disk = await this.diskUsage(this.home);
    requireValue(disk.bavail * disk.bsize >= 8 * 1024 ** 3, "At least 8 GiB of free space is required");
    return { plan, previous, saved, codexHome };
  }
  async apply(options) {
    this.timings = [];
    const started = Date.now();
    const { plan, previous, saved, codexHome } = options.apply
      ? await this.stage("Preflight", () => this.preflight(options)) : await this.preflight(options);
    if (!options.apply) { console.log(JSON.stringify(plan, null, 2)); return plan; }
    await this.directory(this.configRoot);
    const lock = await this.checked(path.join(this.configRoot, "install.lock"));
    try { await mkdir(lock, { mode: 0o700 }); }
    catch (error) {
      if (error.code === "EEXIST") throw new InstallationError("Another install is running or was interrupted; inspect install.lock before retrying");
      throw error;
    }
    try {
      const current = await exists(this.file) ? await this.read(this.file) : null;
      requireValue(isDeepStrictEqual(current, saved), "Installation state changed concurrently; rerun the check");
      await this.checkPorts(previous);
      let config = previous;
      if (!previous?.ready) {
        for (const file of [this.root, this.state, ...this.adapter.directories, path.join(this.root, "releases")]) await this.directory(file);
        await this.write(path.join(this.configRoot, "attempt.json"), this.attemptIdentity());
        config = await this.deploy(options, codexHome, previous);
      }
      await this.adapter.verify(config);
      // Legacy Linux has no runtime.json. A new descriptor contains the same
      // verified identity/paths; it does not modify services or their environment.
      if (!await exists(this.file)) {
        config.setupFile = path.join(this.configRoot, "setup.json");
        await this.write(config.setupFile, this.setup);
        await this.write(this.file, config);
      }
      await this.adapter.command(config, { fresh: !previous?.ready });
      this.commandRegistered = true;
      await this.probe(config, "registration");
      const output = path.join(this.home, "codey-machine-registration.json");
      if (this.adapter.exportRegistration) await this.adapter.exportRegistration(config, output);
      await verifyRegistrationFile(output, this.setup);
      await writeResources(this, config);
      console.log(`Codey locally installed and verified in ${((Date.now() - started) / 1000).toFixed(1)}s. Registration file: ${output}`);
      console.log("Local setup complete; Portal import is manual. No automatic registration or updater.");
      return config;
    } finally {
      try { await this.write(path.join(this.configRoot, "install-timings.json"),
        { schema: 1, totalSeconds: (Date.now() - started) / 1000, stages: this.timings }); }
      finally { await rmdir(lock); }
    }
  }
  async certificate(identity, create = true) {
    const cert = await this.checked(path.join(this.configRoot, "node-cert.pem"));
    const key = await this.checked(path.join(this.configRoot, "node-key.pem"));
    const serverName = `${identity.nodeId}.nodes.codey.internal`;
    requireValue(await exists(cert) === await exists(key), "Incomplete TLS identity requires review; it will not be rotated");
    if (!await exists(cert)) {
      requireValue(create, "Missing existing TLS identity");
      if (this.adapter.certificate) await this.adapter.certificate(serverName, cert, key);
      else {
        const openssl = path.join(this.configRoot, "openssl.cnf");
        await this.write(openssl, Buffer.from(`[req]\nprompt = no\ndistinguished_name = dn\nx509_extensions = leaf\n` +
          `[dn]\nCN = ${serverName}\n[leaf]\nsubjectAltName = DNS:${serverName}\n` +
          "basicConstraints = critical,CA:FALSE\nkeyUsage = critical,digitalSignature,keyEncipherment\nextendedKeyUsage = serverAuth\n"));
        await this.run("/usr/bin/openssl", ["req", "-x509", "-newkey", "rsa:3072", "-nodes", "-days", "365",
          "-config", openssl, "-keyout", key, "-out", cert]);
        await chmod(key, 0o600);
        await chmod(cert, 0o600);
      }
    }
    const leaf = new X509Certificate(await readFile(cert)), der = k => k.export({ type: "spki", format: "der" });
    requireValue(!leaf.ca && leaf.checkHost(serverName, { wildcards: false }) &&
      Date.parse(leaf.validFrom) <= Date.now() && Date.parse(leaf.validTo) > Date.now() + 86400000 &&
      der(leaf.publicKey).equals(der(createPublicKey(await readFile(key)))),
    "Existing TLS certificate/key needs explicit renewal and Portal re-pinning");
    return { cert, key, serverName };
  }
  async verifyPreparedApplication(record) {
    for (const file of [record.releaseDirectory, record.nodeExe, record.codeyDirectory]) await this.checked(file);
    requireValue(path.dirname(record.releaseDirectory) === path.join(this.root, "releases") &&
      inside(record.releaseDirectory, record.nodeExe) &&
      record.codeyDirectory === path.join(record.releaseDirectory,
        this.target === "windows-x64" ? "app/node_modules/codey" : "app/lib/node_modules/codey") &&
      /^[a-f0-9]{64}$/.test(record.fileHashes?.nodeExe) &&
      await digest(record.nodeExe) === record.fileHashes.nodeExe, "Prepared Node fingerprint mismatch");
    requireValue((await this.run(record.nodeExe, ["--version"])).stdout.trim() === "v" + this.pins.node.version,
      "Prepared Node version mismatch");
    await this.packageFiles(record.codeyDirectory);
    const { verifyDependencyTree } = await import(pathToFileURL(path.join(record.codeyDirectory, "lib/package-dependencies.mjs")).href);
    await verifyDependencyTree(record.codeyDirectory,
      JSON.parse(await readFile(path.join(record.codeyDirectory, "npm-shrinkwrap.json"))), { home: this.home });
    await this.run(record.nodeExe, [path.join(record.codeyDirectory, "bin/codey.mjs"), "doctor", "--runtime-only", "--json"],
      { env: this.baseEnvironment(record.nodeExe), timeout: 30000 });
    return { release: record.releaseDirectory, codey: record.codeyDirectory, node: record.nodeExe };
  }
  async prepareApplication(options = {}, previous) {
    if (this.prepared) return { release: path.resolve(this.prepared.root, "../../.."), codey: this.prepared.root,
      node: process.execPath };
    if (previous) return this.verifyPreparedApplication(previous);
    const receiptFile = await this.checked(path.join(this.configRoot, "prepared.json"));
    if (options["retry-failed"] && await exists(receiptFile)) {
      const receipt = await this.read(receiptFile);
      requireValue(receipt.schema === 1 && receipt.platform === this.target && receipt.ownerHome === this.home &&
        receipt.releaseId === this.manifest.releaseId && receipt.artifactSha256 === this.manifest.artifacts[0].sha256 &&
        receipt.nodeArchiveSha256 === this.pins.node.sha256 &&
        inside(path.join(this.root, "releases"), receipt.release) &&
        path.dirname(receipt.release) === path.join(this.root, "releases") &&
        inside(receipt.release, receipt.node) &&
        receipt.codey === path.join(receipt.release, this.target === "windows-x64" ? "app/node_modules/codey" : "app/lib/node_modules/codey"),
      "Prepared application receipt differs from this owner/release; inspect it before retrying");
      return this.verifyPreparedApplication({ releaseDirectory: receipt.release, codeyDirectory: receipt.codey,
        nodeExe: receipt.node, fileHashes: { nodeExe: receipt.nodeSha256 } });
    }
    const windows = this.target === "windows-x64", mac = this.target.startsWith("macos-");
    const distribution = `node-v${this.pins.node.version}-${mac ? "darwin" : windows ? "win" : "linux"}-${this.target.split("-")[1]}`;
    const receipt = await this.checked(path.join(this.configRoot, "application.json"));
    let record;
    if (await exists(receipt)) {
      record = await this.read(receipt);
      requireValue([1, 2].includes(record.schema) && isDeepStrictEqual(record.identity, this.attemptIdentity()) &&
        record.releaseId === this.manifest.releaseId && record.nodeVersion === this.pins.node.version &&
        (record.schema === 1 || record.artifactSha256 === this.manifest.artifacts[0].sha256 &&
          record.nodeArchiveSha256 === this.pins.node.sha256) &&
        path.dirname(record.releaseDirectory) === path.join(this.root, "releases") &&
        path.basename(record.releaseDirectory).startsWith(this.manifest.releaseId + "-"),
      "Prepared application belongs to another installation");
    } else {
      record = { schema: 2, identity: this.attemptIdentity(), releaseId: this.manifest.releaseId, nodeVersion: this.pins.node.version,
        artifactSha256: this.manifest.artifacts[0].sha256, nodeArchiveSha256: this.pins.node.sha256,
        releaseDirectory: await this.directory(path.join(this.root, "releases", this.manifest.releaseId + "-" + nonce())), fileHashes: {} };
    }
    const release = await this.checked(record.releaseDirectory);
    const node = path.join(release, ...(windows ? ["node", distribution, "node.exe"] : [distribution, "bin/node"]));
    const prefix = path.join(release, "app"), artifact = this.manifest.artifacts[0];
    const codey = path.join(prefix, windows ? "node_modules/codey" : "lib/node_modules/codey");
    requireValue(!record.nodeExe || record.nodeExe === node && record.codeyDirectory === codey, "Prepared application paths differ");
    Object.assign(record, { nodeExe: node, codeyDirectory: codey });
    if (record.ready) return this.verifyPreparedApplication(record);
    await this.write(receipt, record);
    const archive = path.join(release, windows ? "node.zip" : mac ? "node.tar.gz" : "node.tar.xz");
    if (record.fileHashes.nodeExe) {
      await this.checked(node);
      requireValue(await digest(node) === record.fileHashes.nodeExe, "Prepared Node fingerprint mismatch");
    } else {
      await this.stage("Prepare pinned Node archive", async () => {
        if (process.env.CODEY_BOOTSTRAP_NODE_ARCHIVE) {
          await copyFile(process.env.CODEY_BOOTSTRAP_NODE_ARCHIVE, archive);
          requireValue(await digest(archive) === this.pins.node.sha256, "Bootstrap Node checksum mismatch");
        } else await this.download(this.pins.node, archive);
      });
      await this.stage("Extract pinned Node", async () => {
        if (windows) await this.adapter.extract(archive, path.join(release, "node"));
        else await this.run("/usr/bin/tar", [mac ? "-xzf" : "-xJf", archive, "-C", release]);
      });
      record.fileHashes.nodeExe = await digest(node);
      await this.write(receipt, record);
      await unlink(archive);
    }
    requireValue((await this.run(node, ["--version"])).stdout.trim() === "v" + this.pins.node.version, "Node version mismatch");
    requireValue(!await exists(prefix), "Incomplete application directory requires review before retrying");
    try {
      await this.stage("Install locked dependencies and verify native modules", () => this.run(node,
        [path.join(this.skill, "scripts/install-runtime.mjs"), "--package", path.join(this.skill, "assets", artifact.file),
        "--sha256", artifact.sha256, "--prefix", prefix, "--no-launcher",
        ...(options.registry ? ["--registry", options.registry] : [])],
        { env: { ...this.baseEnvironment(node), ...(process.env.CODEY_NPM_REGISTRY ? { CODEY_NPM_REGISTRY: process.env.CODEY_NPM_REGISTRY } : {}) },
          timeout: 1800000 }));
    } catch (error) {
      // This invocation alone created this prefix; retain the verified Node and
      // retry npm without accumulating a new release or touching previous apps.
      await this.checked(prefix);
      await rm(prefix, { recursive: true, force: true });
      throw error;
    }
    await this.packageFiles(codey);
    record.ready = true;
    await this.write(receipt, record);
    return { release, codey, node };
  }
  baseEnvironment(node) {
    if (this.adapter.environment) return this.adapter.environment(node);
    return { HOME: this.home, USER: process.env.USER || "owner", LOGNAME: process.env.LOGNAME || "owner",
      PATH: `${path.dirname(node)}:/usr/bin:/bin:/usr/sbin:/sbin`, NODE_ENV: "production",
      NODE_USE_SYSTEM_CA: "1", TMPDIR: process.env.TMPDIR || "/tmp" };
  }
  githubEnvironment(base) {
    // Discovery runs in the owner's terminal; pinned executable/config paths also
    // work later in systemd/launchd's deliberately smaller environment.
    return { ...base, ...Object.fromEntries(Object.entries(process.env)
      .filter(([name]) => /^(?:PATH|GH_CONFIG_DIR|XDG_CONFIG_HOME|DBUS_SESSION_BUS_ADDRESS|XDG_RUNTIME_DIR)$/i.test(name))) };
  }
  async officialTool(item, file, previous) {
    const receiptFile = file + ".verified.json";
    const legacyFile = path.join(this.configRoot, "devtunnel-tool.json");
    if (await exists(receiptFile)) {
      const receipt = await this.read(await this.checked(receiptFile));
      await this.checked(file);
      requireValue(receipt.schema === 1 && receipt.url === item.url &&
        /^[a-f0-9]{64}$/.test(receipt.sha256) && await digest(file) === receipt.sha256,
      "Cached official tool changed; inspect it before retrying");
      if (this.adapter.verifyTunnelBinary) await this.adapter.verifyTunnelBinary(file);
      return;
    }
    const saved = await exists(legacyFile) ? await this.read(await this.checked(legacyFile)) :
      previous ? { file: previous.devtunnelExe, sha256: previous.fileHashes.devtunnelExe } : null;
    if (saved) {
      await this.checked(file);
      requireValue(saved.file === file && /^[a-f0-9]{64}$/.test(saved.sha256) &&
        await digest(file) === saved.sha256, "Prepared DevTunnel fingerprint mismatch");
    } else await this.download(item, file);
    if (this.adapter.verifyTunnelBinary) await this.adapter.verifyTunnelBinary(file);
    await this.write(receiptFile, { schema: 1, url: item.url, sha256: await digest(file) });
  }
  async codexDirectory() {
    const bin = path.join(this.root, "codex-bin");
    if (this.target !== "windows-x64" || !await exists(bin) || !(await lstat(bin)).isSymbolicLink()) {
      return this.directory(bin);
    }
    const releases = path.join(this.root, "codex-install/packages/standalone/releases");
    await this.checked(releases);
    const resolved = await realpath(bin);
    requireValue(inside(releases, resolved) && path.basename(resolved) === "bin" &&
      path.dirname(path.dirname(resolved)) === releases,
    "Codex junction must resolve to this owner's official standalone release");
    await this.checked(resolved);
    await this.checked(path.join(resolved, "codex.exe"));
    return bin;
  }
  async installCodex(config, codexBin) {
    const receiptFile = path.join(this.configRoot, "codex-tool.json");
    if (this.adapter.codex) {
      if (await this.adapter.codex(config)) return;
    } else if (await exists(receiptFile)) {
      const receipt = await this.read(receiptFile);
      const executable = await realpath(config.codexExe);
      await this.checked(executable);
      requireValue(receipt.schema === 1 && receipt.platform === this.target &&
        receipt.executable === executable && receipt.sha256 === await digest(executable),
      "Recorded official Codex changed; inspect it before retrying");
      requireValue((await this.run(config.codexExe, ["--version"], { env: config.environment })).stdout.startsWith("codex-cli "));
      return;
    }
    const windows = this.target === "windows-x64";
    const installer = path.join(config.releaseDirectory, windows ? "codex-install.ps1" : "codex-install.sh");
    await this.download(this.pins.codex, installer);
    requireValue((await readFile(installer, "utf8")).includes("https://releases.openai.com/codex"), "Unexpected official Codex installer");
    const standaloneHome = await this.directory(path.join(this.root, "codex-install"));
    await this.run(windows ? config.powershellExe : "/bin/bash",
      windows ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", installer] : [installer],
      { env: { ...config.environment, CODEX_INSTALL_DIR: codexBin, CODEX_HOME: standaloneHome,
        CODEX_RELEASE: "latest", CODEX_NON_INTERACTIVE: "true", CODEX_INSTALLER_USE_RELEASES_OPENAI_COM: "true" }, timeout: 900000 });
    requireValue((await this.run(config.codexExe, ["--version"], { env: config.environment })).stdout.startsWith("codex-cli "));
    const executable = await realpath(config.codexExe);
    requireValue(inside(this.root, executable), "Official Codex executable escaped this installation");
    await this.checked(executable);
    if (this.adapter.recordCodex) await this.adapter.recordCodex(config);
    else await this.write(receiptFile, { schema: 1, platform: this.target, executable, sha256: await digest(executable) });
  }
  async tunnel(devtunnel, identity, base, previous) {
    const authentication = await loginTunnel(devtunnel, base, this.run,
      { ...this.auth, githubEnvironment: this.githubEnvironment(base), binding: previous?.tunnelAuth,
        preferGh: this.target.startsWith("macos-") && !previous });
    const tunnelId = "codey-" + identity.nodeId;
    if (authentication.source === "gh") {
      const actual = await (this.auth.ensureTunnel ?? ensureGhTunnel)(authentication.credential, tunnelId);
      const { clusterId } = validateTunnel(actual, tunnelId);
      const tunnelFile = path.join(this.configRoot, "tunnel.json");
      await this.write(tunnelFile, actual);
      return { tunnelFile, qualified: `${tunnelId}.${clusterId}`, tunnelAuth: authentication.binding };
    }
    let shown = await this.run(devtunnel, ["show", tunnelId, "--json"], { env: base, check: false });
    if (shown.code) shown = await this.run(devtunnel, ["create", tunnelId, "--description", "Codey " + identity.nodeId, "--json"], { env: base });
    const raw = parseTunnelJson(shown.stdout), tunnel = raw.tunnel || raw, parts = (tunnel.tunnelId || "").split(".");
    const cluster = parts.length === 2 ? parts[1] : tunnel.clusterId;
    requireValue(parts[0] === tunnelId && parts.length <= 2 && /^[a-z][a-z0-9]{1,15}$/.test(cluster));
    const qualified = `${tunnelId}.${cluster}`;
    for (const port of [3001, 8443]) {
      if (!(tunnel.ports || []).some(item => item.portNumber === port && item.protocol === "https")) {
        await this.run(devtunnel, ["port", "create", qualified, "--port-number", String(port), "--protocol", "https", "--json"], { env: base });
      }
    }
    const actual = parseTunnelJson((await this.run(devtunnel, ["show", qualified, "--json"], { env: base })).stdout);
    validateTunnel(actual, tunnelId, cluster);
    const tunnelFile = path.join(this.configRoot, "tunnel.json");
    await this.write(tunnelFile, actual);
    return { tunnelFile, qualified };
  }
  async verifyModels(config) {
    const answer = path.join(this.state, "codex-answer-" + nonce() + ".txt");
    try {
      const results = await Promise.allSettled([
        (async () => {
          await this.run(config.codexExe, ["exec", "--skip-git-repo-check", "-c", 'model_reasoning_effort="low"',
            "--output-last-message", answer, "Reply with only CODEY_CODEX_OK. Do not use tools."],
          { env: config.environment, cwd: this.home, timeout: 60000 });
          requireValue((await readFile(answer, "utf8")).trim() === "CODEY_CODEX_OK", "Real Codex response mismatch");
        })(),
        this.probe(config, "sdk-probe", { timeout: 60000 }),
      ]);
      const failed = results.find(result => result.status === "rejected");
      if (failed) throw failed.reason;
    } finally {
      await unlink(answer).catch(error => { if (error.code !== "ENOENT") throw error; });
    }
  }
  async deploy(options, codexHome, previous) {
    const identityFile = path.join(this.state, "identity.json");
    const identity = await exists(identityFile) ? await this.read(identityFile) : {
      ...this.attemptIdentity(), nodeId: "n-" + nonce(), workspaceSubject: "m-" + nonce(), workspaceUsername: "owner",
      clientSigningKey: secret(), workspaceSsoKey: secret(), tunnelUpdateKey: secret(),
    };
    requireValue((this.ownerSid ? identity.ownerSid === this.ownerSid : identity.ownerUid === process.getuid()) &&
      identity.ownerHome === this.home && /^n-[a-f0-9]{24}$/.test(identity.nodeId) &&
      /^m-[a-f0-9]{24}$/.test(identity.workspaceSubject) && /^[a-z][a-z0-9_-]{0,31}$/.test(identity.workspaceUsername) &&
      ["clientSigningKey", "workspaceSsoKey", "tunnelUpdateKey"].every(key => /^[A-Za-z0-9_-]{43}$/.test(identity[key])) &&
      (!previous || previous.nodeId === identity.nodeId), "Existing identity requires review");
    if (!await exists(identityFile)) await this.write(identityFile, identity);
    const { release, codey, node } = await this.stage("[1/4] Prepare or reuse Node and Codey",
      () => this.prepareApplication(options, previous));
    await writeResources(this, { nodeId: identity.nodeId, releaseId: this.setup.releaseId,
      releaseDirectory: release, codeyDirectory: codey, codeyEntrySha256: this.manifest.codey.entrySha256, codexHome, state: "preparing" });
    const base = this.baseEnvironment(node), windows = this.target === "windows-x64";
    const devtunnel = this.adapter.devtunnel ?? path.join(release, windows ? "devtunnel.exe" : "devtunnel");
    await this.directory(path.dirname(devtunnel));
    await this.stage("Prepare DevTunnel", () => this.officialTool(this.pins.devTunnel, devtunnel, previous));
    console.log("[2/4] Configure private GitHub DevTunnel and node TLS");
    const { tunnelFile, qualified, tunnelAuth } = await this.stage("Configure tunnel", () => this.tunnel(devtunnel, identity, base, previous));
    const { cert, key, serverName } = await this.stage("Prepare TLS", () => this.certificate(identity));
    const signing = path.join(this.configRoot, "client-signing.key");
    await this.write(signing, Buffer.from(identity.clientSigningKey + "\n"));
    const copilot = await this.directory(this.adapter.copilot ?? path.join(this.root, "copilot-home"));
    const data = await this.directory(this.adapter.data ?? path.join(this.root, "data"));
    const providerFile = path.join(copilot, "config.json");
    let provider = await exists(providerFile) ? await this.read(providerFile) : {};
    if (!previous && this.target === "linux-x64" && await exists(providerFile)) {
      requireValue(options["replace-existing"], "Existing gateway configuration requires --replace-existing");
      await this.write(providerFile + "." + nonce() + ".bak", provider);
      provider = { ...provider, auth: { ...provider.auth, apiKeys: [secret()], adminApiKey: secret(), sessionHistoryApiKey: secret() } };
    }
    provider.auth ??= { apiKeys: [secret()], adminApiKey: secret(), sessionHistoryApiKey: secret() };
    requireValue(/^[A-Za-z0-9_-]{43}$/.test(provider.auth.apiKeys?.[0]), "Existing model key requires review");
    await this.write(providerFile, provider);
    const modelKey = provider.auth.apiKeys[0], codexBin = await this.codexDirectory();
    const environment = { ...base, CODEY_MANAGED: "true", CODEY_PORTAL_SSO: "true", CODEX_HOME: codexHome,
      COPILOT_API_HOME: copilot, CODEY_MODEL_API_KEY: modelKey, DATABASE_PATH: path.join(data, "auth.db"),
      CODEY_CODEX_EXECUTABLE: path.join(codexBin, windows ? "codex.exe" : "codex"), COPILOT_API_CODEY_HTTPS_PORT: "8443",
      COPILOT_API_CODEY_HTTPS_HOST: "127.0.0.1", COPILOT_API_CODEY_TLS_CERT: cert, COPILOT_API_CODEY_TLS_KEY: key,
      COPILOT_API_CODEY_NODE_ID: identity.nodeId, COPILOT_API_CODEY_ALLOWED_ORIGIN: this.setup.portalOrigin,
      COPILOT_API_CODEY_SIGNING_KEY_FILE: signing, CODEY_PORTAL_NODE_ID: identity.nodeId,
      CODEY_PORTAL_USERNAME: identity.workspaceUsername, CODEY_PORTAL_PRINCIPAL_ID: identity.workspaceSubject,
      CODEY_PORTAL_SSO_KEY: identity.workspaceSsoKey, CODEY_PORTAL_TLS_CERT: cert, CODEY_PORTAL_TLS_KEY: key };
    const supervisor = await this.directory(path.join(this.root, "supervisor"));
    for (const name of ["windows-runtime.mjs", "registration.mjs", "machine-common.mjs", "github-auth.mjs", "github-tunnel.mjs", ...this.adapter.helpers]) {
      await this.write(path.join(supervisor, name), await readFile(path.join(this.skill, "scripts", name)));
    }
    const config = { ...this.attemptIdentity(), schema: 2, layout: "npm-codey-package", computer: this.computer,
      nodeId: identity.nodeId, releaseId: this.setup.releaseId, releaseDirectory: release, runtimeRoot: this.root,
      configRoot: this.configRoot, stateRoot: this.state, nodeExe: node, devtunnelExe: devtunnel,
      helperPath: path.join(supervisor, "windows-runtime.mjs"), registrationHelper: path.join(supervisor, "registration.mjs"),
      commonPath: path.join(supervisor, "machine-common.mjs"),
      authHelperPath: path.join(supervisor, "github-auth.mjs"), tunnelAuthHelperPath: path.join(supervisor, "github-tunnel.mjs"),
      codeyDirectory: codey, codeyBin: path.join(codey, "bin/codey.mjs"), codeyEntrySha256: this.manifest.codey.entrySha256,
      codexExe: environment.CODEY_CODEX_EXECUTABLE, codexHome, modelKey, identityFile, tunnelFile, qualifiedTunnel: qualified,
      ...(tunnelAuth ? { tunnelAuth } : {}),
      certificate: cert, serverName, setupFile: path.join(this.configRoot, "setup.json"), environment, baseEnvironment: base,
      state: "installing", ready: false, fileHashes: {} };
    await this.adapter.configure(config);
    for (const name of ["nodeExe", "devtunnelExe", "workerPath", "helperPath", "registrationHelper", "commonPath", "authHelperPath", "tunnelAuthHelperPath"]) {
      if (config[name]) config.fileHashes[name] = await digest(config[name]);
    }
    await this.write(config.setupFile, this.setup);
    await this.write(this.file, config);
    await writeResources(this, config);
    const started = [];
    try {
      console.log("[3/4] Authenticate the gateway and configure official Codex");
      for (const name of ["github_token", "github-cli.json"]) await this.checked(path.join(copilot, name));
      // The shared login verifies either saved credentials or a token-free gh binding before Codex/services.
      await this.stage("Verify GitHub and Copilot access", () => this.run(node, [config.codeyBin, "copilot", "login"],
        { env: this.githubEnvironment(environment), cwd: codey, interactive: true, timeout: 900000 }));
      await this.stage("Prepare official Codex", () => this.installCodex(config, codexBin));
      await this.directory(codexHome);
      for (const [name, content] of await this.modelFiles(codexHome)) {
        const destination = await this.checked(path.join(codexHome, name));
        if (await exists(destination)) {
          if ((await readFile(destination)).equals(content)) continue;
          requireValue(options["replace-existing"], "Codex configuration appeared during installation; review --replace-existing");
          await this.write(destination + "." + nonce() + ".bak", await readFile(destination));
        }
        await this.write(destination, content);
      }
      await this.write(path.join(copilot, "portal-build.json"), {
        schema: 1, sourceCommit: this.manifest.copilotApi?.commit, version: this.manifest.copilotApi?.version,
      });
      await this.adapter.available(codexHome);
      await this.checkPorts(previous);
      console.log("[4/4] Start owner services and verify Workspace/gateway/Codex responses");
      await this.adapter.start(config, previous, started);
      const deadline = Date.now() + 120000;
      for (let attempt = 0; ; attempt++) {
        try { await this.probe(config, "verify", { timeout: Math.max(1000, deadline - Date.now()) }); break; }
        catch (error) {
          if (attempt === 29 || Date.now() >= deadline) throw error;
          await this.pause(2000);
        }
      }
      await this.stage("Verify real CLI/SDK model responses", () => this.verifyModels(config));
      Object.assign(config, { ready: true, state: "ready" });
      await this.write(this.file, config);
      return config;
    } catch (error) {
      try { await this.adapter.stop(config, started); }
      catch { console.error("Could not stop owned services; inspect the private installation state."); }
      Object.assign(config, { ready: false, state: "failed" });
      await this.write(this.file, config);
      throw error;
    } finally { await writeResources(this, config); }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  (async () => {
    const options = installOptions(process.argv.slice(2));
    if (options.help) { console.log(HELP); return; }
    process.umask(0o077);
    await new Installer(path.dirname(HERE)).apply(options);
  })().catch(error => {
    console.error(error instanceof InstallationError ? error.message : "Installation failed; inspect the private installation state.");
    process.exitCode = 1;
  });
}
