#!/usr/bin/env node
/** The installation workflow. Adapters contain native OS operations, not another installer. */
import { createPublicKey, randomBytes, X509Certificate } from "node:crypto";
import { realpathSync } from "node:fs";
import { chmod, copyFile, lstat, mkdir, readFile, readdir, rmdir, statfs, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  InstallationError, checkedPath, digest, directory, exists, readPrivate, requireValue, run, writePrivate,
} from "./machine-common.mjs";
import { assertInstalled, modelConfiguration, readPackage, readPins } from "./machine-package.mjs";
import { macosAdapter } from "./platform-macos.mjs";
import { linuxAdapter } from "./platform-linux.mjs";
import { windowsAdapter } from "./platform-windows.mjs";
import { loginTunnel, parseTunnelJson, validateTunnel } from "./windows-runtime.mjs";
import { PLATFORMS, verifyRegistrationFile } from "./registration.mjs";
import { writeResources } from "./machine-resources.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const nonce = () => randomBytes(12).toString("hex");
const secret = () => randomBytes(32).toString("base64url");
export const HELP = `Usage: node scripts/install-machine.mjs [--check]
       node scripts/install-machine.mjs --apply --network-approved --expected-computer NAME
         [--replace-existing] [--retry-failed] [--codex-home DIR]

Checks are read-only: no downloads, file changes, logins, services or model requests.
Apply installs a native Linux, Windows or macOS node. Repeating the same release
verifies the existing installation and exports JSON; it never upgrades or restarts it.
--replace-existing permits backed-up Codex configuration changes, not key rotation.
--retry-failed requires a reviewed failed attempt; never use it to migrate a legacy node.
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
    } else if (["--expected-computer", "--codex-home"].includes(flag) && args[i + 1] && !args[i + 1].startsWith("--")) {
      options[flag.slice(2)] = args[++i];
    } else throw new InstallationError("Invalid installation option; use --help");
  }
  requireValue(!(options.apply && options.check), "--check cannot be combined with --apply");
  return options;
}

export class Installer {
  constructor(skill, { home = os.homedir(), platform = process.platform, arch = process.arch,
    computer = os.hostname(), execute = run, portCheck, diskUsage = statfs, prepared,
    adapter, pause = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
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
    const suffix = platform === "linux" ? "" : platform === "win32" ? "-windows" : "-macos";
    this.root = path.join(this.home, ".local/share/codey-machine" + suffix);
    this.configRoot = path.join(this.home, ".config/codey-machine" + suffix);
    this.state = platform === "linux" ? path.join(this.home, ".local/state/codey-machine") : path.join(this.root, "state");
    this.file = path.join(this.configRoot, "runtime.json");
    this.adapter = typeof adapter === "function" ? adapter(this) : adapter ?? (platform === "darwin" ? macosAdapter(this) :
      platform === "win32" ? windowsAdapter(this) : linuxAdapter(this));
    this.portCheck = portCheck;
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
      ownerHome: this.home, platform: this.target, portalOrigin: this.setup.portalOrigin, workerRuntime: "node" };
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
  async validatePrevious(previous, codexHome) {
    requireValue(previous.schema === 2 && previous.kind === this.attemptIdentity().kind &&
      previous.layout === "npm-codey-package" && (previous.platform ?? this.target) === this.target &&
      (this.ownerSid ? previous.ownerSid === this.ownerSid : previous.ownerUid === process.getuid()) &&
      previous.ownerHome === this.home && previous.computer === this.computer &&
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
    let unfinished = false;
    if (previous) await this.validatePrevious(previous, codexHome);
    else if (await exists(this.configRoot) && (await readdir(this.configRoot)).length) {
      const attempt = path.join(this.configRoot, "attempt.json");
      requireValue(await exists(attempt) && isDeepStrictEqual(await this.read(attempt), this.attemptIdentity()),
        "Nonempty configuration directory is not owned by this installer");
      unfinished = true;
    } else if (!this.prepared) requireValue(!await exists(this.root) || !(await readdir(this.root)).length,
      "Nonempty runtime directory has no recognized installation state");
    const overwrites = [];
    for (const file of [path.join(codexHome, "config.toml"), path.join(codexHome, "models.json"),
      ...(this.target === "linux-x64" ? [path.join(this.home, ".local/share/copilot-api/config.json")] : [])]) {
      await this.checked(file);
      if (await exists(file)) overwrites.push(file);
    }
    if (options.apply) requireValue(options["network-approved"] && options["expected-computer"] === this.computer,
      "Apply requires --network-approved and --expected-computer matching this machine exactly");
    const listeners = await this.checkPorts(previous);
    const plan = { platform: this.target, computer: this.computer, mode: options.apply ? "apply" : "check",
      releaseId: this.manifest.releaseId, replaceConfiguration: previous?.ready ? [] : overwrites,
      existingNode: Boolean(previous), listeners, startup: this.adapter.startup,
      deferred: ["network/login", "native dependencies", "TLS/SSO/model response", "registration export"],
      registrationFile: path.join(this.home, "codey-machine-registration.json"), automaticRegistration: false };
    if (!options.apply || previous?.ready) return { plan, previous, saved, codexHome };
    requireValue(!(previous || unfinished) || options["retry-failed"], "Inspect the failed attempt, then use --retry-failed");
    requireValue(!overwrites.length || options["replace-existing"], "Existing Codex/gateway configuration requires --replace-existing");
    await this.adapter.available();
    const disk = await this.diskUsage(this.home);
    requireValue(disk.bavail * disk.bsize >= 8 * 1024 ** 3, "At least 8 GiB of free space is required");
    return { plan, previous, saved, codexHome };
  }
  async apply(options) {
    const { plan, previous, saved, codexHome } = await this.preflight(options);
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
      console.log(`Codey locally installed and verified. Registration file: ${output}`);
      console.log("Local setup complete; Portal import is manual. No automatic registration or updater.");
      return config;
    } finally { await rmdir(lock); }
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
  async prepareApplication() {
    if (this.prepared) return { release: path.resolve(this.prepared.root, "../../.."), codey: this.prepared.root,
      node: process.execPath };
    const release = await this.directory(path.join(this.root, "releases", this.manifest.releaseId + "-" + nonce()));
    const windows = this.target === "windows-x64", mac = this.target.startsWith("macos-");
    const archive = path.join(release, windows ? "node.zip" : mac ? "node.tar.gz" : "node.tar.xz");
    if (process.env.CODEY_BOOTSTRAP_NODE_ARCHIVE) {
      await copyFile(process.env.CODEY_BOOTSTRAP_NODE_ARCHIVE, archive);
      requireValue(await digest(archive) === this.pins.node.sha256, "Bootstrap Node checksum mismatch");
    } else await this.download(this.pins.node, archive);
    if (windows) await this.adapter.extract(archive, path.join(release, "node"));
    else await this.run("/usr/bin/tar", [mac ? "-xzf" : "-xJf", archive, "-C", release]);
    await unlink(archive);
    const distribution = `node-v${this.pins.node.version}-${mac ? "darwin" : windows ? "win" : "linux"}-${this.target.split("-")[1]}`;
    const node = path.join(release, ...(windows ? ["node", distribution, "node.exe"] : [distribution, "bin/node"]));
    requireValue((await this.run(node, ["--version"])).stdout.trim() === "v" + this.pins.node.version, "Node version mismatch");
    const prefix = path.join(release, "app"), artifact = this.manifest.artifacts[0];
    await this.run(node, [path.join(this.skill, "scripts/install-runtime.mjs"), "--package", path.join(this.skill, "assets", artifact.file),
      "--sha256", artifact.sha256, "--prefix", prefix, "--no-launcher"],
    { env: this.baseEnvironment(node), timeout: 1800000 });
    const codey = path.join(prefix, windows ? "node_modules/codey" : "lib/node_modules/codey");
    await this.packageFiles(codey);
    return { release, codey, node };
  }
  baseEnvironment(node) {
    if (this.adapter.environment) return this.adapter.environment(node);
    return { HOME: this.home, USER: process.env.USER || "owner", LOGNAME: process.env.LOGNAME || "owner",
      PATH: `${path.dirname(node)}:/usr/bin:/bin:/usr/sbin:/sbin`, NODE_ENV: "production",
      NODE_USE_SYSTEM_CA: "1", TMPDIR: process.env.TMPDIR || "/tmp" };
  }
  async tunnel(devtunnel, identity, base) {
    await loginTunnel(devtunnel, base, this.run);
    const tunnelId = "codey-" + identity.nodeId;
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
      await this.run(config.codexExe, ["exec", "--skip-git-repo-check", "--output-last-message", answer,
        "Reply with only CODEY_CODEX_OK. Do not use tools."],
      { env: config.environment, cwd: this.home, timeout: 180000 });
      requireValue((await readFile(answer, "utf8")).trim() === "CODEY_CODEX_OK", "Real Codex response mismatch");
      await this.probe(config, "sdk-probe", { timeout: 180000 });
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
    console.log("[1/4] Prepare the shared Codey package and official tools");
    const { release, codey, node } = await this.prepareApplication();
    await writeResources(this, { nodeId: identity.nodeId, releaseId: this.setup.releaseId,
      releaseDirectory: release, codeyDirectory: codey, codeyEntrySha256: this.manifest.codey.entrySha256, codexHome, state: "preparing" });
    const base = this.baseEnvironment(node), windows = this.target === "windows-x64";
    const devtunnel = this.adapter.devtunnel ?? path.join(release, windows ? "devtunnel.exe" : "devtunnel");
    await this.directory(path.dirname(devtunnel));
    await this.download(this.pins.devTunnel, devtunnel);
    if (this.adapter.verifyTunnelBinary) await this.adapter.verifyTunnelBinary(devtunnel);
    console.log("[2/4] Configure private GitHub DevTunnel and node TLS");
    const { tunnelFile, qualified } = await this.tunnel(devtunnel, identity, base);
    const { cert, key, serverName } = await this.certificate(identity);
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
    const modelKey = provider.auth.apiKeys[0], codexBin = await this.directory(path.join(this.root, "codex-bin"));
    const environment = { ...base, CODEY_MANAGED: "true", CODEY_PORTAL_SSO: "true", CODEX_HOME: codexHome,
      COPILOT_API_HOME: copilot, CODEY_MODEL_API_KEY: modelKey, DATABASE_PATH: path.join(data, "auth.db"),
      CODEY_CODEX_EXECUTABLE: path.join(codexBin, windows ? "codex.exe" : "codex"), COPILOT_API_CODEY_HTTPS_PORT: "8443",
      COPILOT_API_CODEY_HTTPS_HOST: "127.0.0.1", COPILOT_API_CODEY_TLS_CERT: cert, COPILOT_API_CODEY_TLS_KEY: key,
      COPILOT_API_CODEY_NODE_ID: identity.nodeId, COPILOT_API_CODEY_ALLOWED_ORIGIN: this.setup.portalOrigin,
      COPILOT_API_CODEY_SIGNING_KEY_FILE: signing, CODEY_PORTAL_NODE_ID: identity.nodeId,
      CODEY_PORTAL_USERNAME: identity.workspaceUsername, CODEY_PORTAL_PRINCIPAL_ID: identity.workspaceSubject,
      CODEY_PORTAL_SSO_KEY: identity.workspaceSsoKey, CODEY_PORTAL_TLS_CERT: cert, CODEY_PORTAL_TLS_KEY: key };
    const supervisor = await this.directory(path.join(this.root, "supervisor"));
    for (const name of ["windows-runtime.mjs", "registration.mjs", "machine-common.mjs", ...this.adapter.helpers]) {
      await this.write(path.join(supervisor, name), await readFile(path.join(this.skill, "scripts", name)));
    }
    const config = { ...this.attemptIdentity(), schema: 2, layout: "npm-codey-package", computer: this.computer,
      nodeId: identity.nodeId, releaseId: this.setup.releaseId, releaseDirectory: release, runtimeRoot: this.root,
      configRoot: this.configRoot, stateRoot: this.state, nodeExe: node, devtunnelExe: devtunnel,
      helperPath: path.join(supervisor, "windows-runtime.mjs"), registrationHelper: path.join(supervisor, "registration.mjs"),
      commonPath: path.join(supervisor, "machine-common.mjs"),
      codeyDirectory: codey, codeyBin: path.join(codey, "bin/codey.mjs"), codeyEntrySha256: this.manifest.codey.entrySha256,
      codexExe: environment.CODEY_CODEX_EXECUTABLE, codexHome, modelKey, identityFile, tunnelFile, qualifiedTunnel: qualified,
      certificate: cert, serverName, setupFile: path.join(this.configRoot, "setup.json"), environment, baseEnvironment: base,
      state: "installing", ready: false, fileHashes: {} };
    await this.adapter.configure(config);
    for (const name of ["nodeExe", "devtunnelExe", "workerPath", "helperPath", "registrationHelper", "commonPath"]) {
      if (config[name]) config.fileHashes[name] = await digest(config[name]);
    }
    await this.write(config.setupFile, this.setup);
    await this.write(this.file, config);
    await writeResources(this, config);
    const started = [];
    try {
      console.log("[3/4] Authenticate the gateway and configure official Codex");
      const token = path.join(copilot, "github_token");
      if (!await exists(token) || !(await lstat(token)).size) {
        await this.run(node, [config.codeyBin, "copilot", "login"],
          { env: environment, cwd: codey, interactive: true, timeout: 900000 });
      }
      const installer = path.join(release, windows ? "codex-install.ps1" : "codex-install.sh");
      await this.download(this.pins.codex, installer);
      requireValue((await readFile(installer, "utf8")).includes("https://releases.openai.com/codex"), "Unexpected official Codex installer");
      const standaloneHome = await this.directory(path.join(this.root, "codex-install"));
      const codexEnv = { ...environment, CODEX_INSTALL_DIR: codexBin, CODEX_HOME: standaloneHome,
        CODEX_RELEASE: "latest", CODEX_NON_INTERACTIVE: "true", CODEX_INSTALLER_USE_RELEASES_OPENAI_COM: "true" };
      await this.run(windows ? config.powershellExe : "/bin/bash",
        windows ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", installer] : [installer],
        { env: codexEnv, timeout: 900000 });
      // The official installer owns its links/companions; never use a Desktop cache or a global npm shim.
      requireValue((await this.run(config.codexExe, ["--version"], { env: environment })).stdout.startsWith("codex-cli "));
      await this.directory(codexHome);
      for (const [name, content] of [
        ["models.json", await readFile(path.join(this.skill, "templates/a100-models.json"))],
        ["config.toml", Buffer.from(await modelConfiguration(path.join(codexHome, "models.json"),
          path.join(this.skill, "templates/codex-config.toml")))],
      ]) {
        const destination = await this.checked(path.join(codexHome, name));
        if (await exists(destination)) {
          requireValue(options["replace-existing"], "Codex configuration appeared during installation; review --replace-existing");
          await this.write(destination + "." + nonce() + ".bak", await readFile(destination));
        }
        await this.write(destination, content);
      }
      await this.write(path.join(copilot, "portal-build.json"), {
        schema: 1, sourceCommit: this.manifest.copilotApi?.commit, version: this.manifest.copilotApi?.version,
      });
      await this.adapter.available();
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
      await this.verifyModels(config);
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
