import { createRequire } from "node:module";
import { mkdir, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readJson, requireValue, save, sha, UpdateError } from "./client.mjs";

export const directory = path.dirname(fileURLToPath(import.meta.url));
// In source trees the libraries are at the application source; the private ZIP
// includes exactly these same files in lib/. No installed application's updater
// is trusted merely because its version string says 0.1.4.
const bundled = new URL("./lib/update-files.mjs", import.meta.url);
export const libraryRoot = await stat(fileURLToPath(bundled)).then(() => path.join(directory, "lib"),
  error => { if (error.code !== "ENOENT") throw error; return path.resolve(directory, "../../packages/codey/lib"); });
const files = await import(pathToFileURL(path.join(libraryRoot, "update-files.mjs")));
const { readPackageInfo } = await import(pathToFileURL(path.join(libraryRoot, "package-info.mjs")));
const { inspectUpdateArchive } = await import(pathToFileURL(path.join(libraryRoot, "update-archive.mjs")));
const { linkDependencies, EXTRACT_PACKAGE, reusableDependencies, verifyDependencyBinding } =
  await import(pathToFileURL(path.join(libraryRoot, "update-dependencies.mjs")));
const manifestPath = await files.exists(path.join(directory, "lib/node-update-manifest.mjs"))
  ? path.join(directory, "lib/node-update-manifest.mjs") : path.resolve(directory, "../../src/node-update-manifest.mjs");
const { verifyNodeRelease } = await import(pathToFileURL(manifestPath));
export const { execute, controlEnvironment, buildEnvironment, ownedPath, exists, fileHash } = files;
const samePath = (left, right) => process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
const sorted = value => value instanceof Date ? { date: value.toISOString() } :
  Array.isArray(value) ? value.map(sorted) : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
export const objectHash = value => sha(JSON.stringify(sorted(value)));

export function checkedReceipt(request, publicKey, { allowExpired = false, now = Date.now(), platform = "windows-x64" } = {}) {
  const verified = verifyNodeRelease(request.envelope, publicKey, now, allowExpired);
  requireValue(verified.release.platform === platform && verified.digest === request.digest &&
    objectHash(verified.release) === objectHash(request.release) &&
    /^[a-f0-9]{32}$/.test(request.jobId) && path.basename(request.job) === request.jobId,
  "signature_invalid");
  return verified;
}

export function checkedAcceptanceProof(request, proof) {
  if (!Object.hasOwn(request, "acceptance")) {
    // Historical completed requests retain their original real-model receipt.
    requireValue(proof.passed === true && proof.codeyModel === true && proof.codexModel === true &&
      proof.syntheticSessionArchived === true && proof.digest === request.digest && proof.jobId === request.jobId,
    "model_failed");
    return proof;
  }
  requireValue(request.acceptance === "authenticated-health-v1", "configuration_changed");
  const component = request.release.components.codey;
  requireValue(Object.keys(request.release.components).length === 1 &&
    request.version === component.version && request.entrySha256 === component.entrySha256, "signature_invalid");
  requireValue(proof.schema === 1 && proof.acceptance === request.acceptance && proof.passed === true &&
    proof.healthy === true && proof.authenticated === true && proof.modelRequests === false &&
    proof.digest === request.digest && proof.jobId === request.jobId &&
    proof.version === component.version && proof.entrySha256 === component.entrySha256 &&
    Number.isSafeInteger(proof.checkedAt) && proof.checkedAt > 0, "health_failed");
  return proof;
}

export async function readAcceptanceProof(request) {
  requireValue(!Object.hasOwn(request, "acceptance") || request.acceptance === "authenticated-health-v1",
    "configuration_changed");
  const healthOnly = request.acceptance === "authenticated-health-v1";
  const proof = await readJson(path.join(request.job, healthOnly ? "health-proof.json" : "model-proof.json"))
    .catch(() => { throw new UpdateError(healthOnly ? "health_failed" : "model_failed"); });
  return checkedAcceptanceProof(request, proof);
}

export function normalizedCodex(value, probePath) {
  const result = structuredClone(value);
  if (typeof result.last_updated === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(result.last_updated)) {
    delete result.last_updated;
  }
  if (result.projects?.[probePath] && objectHash(result.projects[probePath]) === objectHash({ trust_level: "trusted" })) {
    delete result.projects[probePath];
    if (!Object.keys(result.projects).length) delete result.projects;
  }
  return result;
}

export function normalizedGateway(value) {
  const document = structuredClone(value);
  const transport = input => {
    requireValue(input && typeof input === "object" && !Array.isArray(input));
    const result = { ...input };
    if (Object.hasOwn(result, "headersTimeoutMsV2")) {
      if (Object.hasOwn(result, "headersTimeoutMs")) requireValue(objectHash(result.headersTimeoutMs) === objectHash(result.headersTimeoutMsV2));
      else result.headersTimeoutMs = result.headersTimeoutMsV2;
      delete result.headersTimeoutMsV2;
    }
    return result;
  };
  if (Object.hasOwn(document, "responsesTransport")) {
    const old = transport(document.responsesTransport);
    if (Object.hasOwn(document, "upstreamTransport")) requireValue(objectHash(old) === objectHash(transport(document.upstreamTransport)));
    document.upstreamTransport = document.upstreamTransport ? transport(document.upstreamTransport) : old;
    delete document.responsesTransport;
  } else if (document.upstreamTransport) document.upstreamTransport = transport(document.upstreamTransport);
  return document;
}

export async function protectedHashes(runtimeFile, probePath) {
  const config = await readJson(runtimeFile);
  const mac = config.kind === "codey-macos-oneclick";
  const env = mac ? config.environment : config.services.codey.environment;
  const names = [config.nodeExe, config.devtunnelExe, config.codexExe, config.identityFile, config.certificate,
    ...(mac ? [config.pythonExe, config.workerPath, config.helperPath, config.setupFile] : [
      config.runnerPath, config.helperPath, config.taskHostExe,
      ...Object.keys(config.helperHashes).map(name => path.join(path.dirname(config.runnerPath), name))]),
    ...["COPILOT_API_CODEY_TLS_KEY", "COPILOT_API_CODEY_SIGNING_KEY_FILE"].map(name => env[name])].filter(Boolean);
  for (const name of ["config.toml", "models.json"]) {
    const file = path.join(config.codexHome, name);
    if (await exists(file)) names.push(file);
  }
  const gateway = path.join(env.COPILOT_API_HOME, "config.json");
  names.push(gateway);
  const result = {};
  for (const name of new Set(names)) {
    const body = await readFile(name);
    if (name === gateway) result[name] = objectHash(normalizedGateway(JSON.parse(body)));
    else if (path.basename(name) === "config.toml") {
      const toml = createRequire(path.join(config.codeyDirectory, "package.json"))("@iarna/toml");
      const value = toml.parse(body.toString("utf8").replace(/^\uFEFF/, ""));
      if (value.model_catalog_json !== undefined) {
        requireValue(typeof value.model_catalog_json === "string" && value.model_catalog_json.length > 0 &&
          !value.model_catalog_json.includes("\0"));
        const reference = value.model_catalog_json;
        const catalog = /^[~][\\/]/.test(reference) ? path.join(config.ownerHome, reference.slice(2))
          : path.resolve(config.codexHome, reference);
        await ownedPath(catalog, config.ownerHome);
        result[catalog] = await fileHash(catalog);
      }
      result[name] = objectHash(normalizedCodex(value, probePath));
    } else result[name] = sha(body);
  }
  return result;
}

export class Runtime {
  constructor(config, { home = os.homedir(), command = execute, native } = {}) {
    this.config = config; this.home = home; this.command = command; this.nativeOverride = native;
    this.platform = "windows-x64";
    this.private = path.join(home, ".config/codey-updater");
    this.root = path.join(home, ".local/share/codey-updater");
    this.runtimeFile = path.join(home, ".config/codey-machine-windows/runtime.json");
    this.probePath = path.join(this.root, "probe");
    this.localState = path.join(home, ".local/share/codey-local-update");
  }
  environment(config) { return config.services.codey.environment; }
  async native(action, input = this.runtimeFile) {
    if (this.nativeOverride) return this.nativeOverride(action, input);
    requireValue(process.platform === "win32" && process.arch === "x64", "unsupported_platform");
    const script = path.join(directory, "native.ps1");
    const powershell = path.join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe");
    const output = await this.command(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", script,
      "-Operation", action, "-InputFile", input], { env: controlEnvironment(this.home),
      cwd: this.home, timeout: ["apply", "verify", "recover"].includes(action) ? 900000 : 60000 });
    const result = JSON.parse(output);
    if (!result.ok) throw new UpdateError(result.code || "operation_failed");
    return result;
  }
  async installed() {
    const file = path.join(this.private, "installed.json");
    if (!(await exists(file))) return { sequence: this.config.minimumSequence, releaseId: null, digest: null };
    const value = await readJson(file);
    requireValue(value.nodeId === this.config.nodeId && value.ownerId === this.config.ownerId &&
      value.platform === this.platform && Number.isSafeInteger(value.sequence) &&
      value.sequence >= this.config.minimumSequence);
    return value;
  }
  async snapshot({ requireReady = true } = {}) {
    const native = await this.native(requireReady ? "snapshot" : "recovery-snapshot");
    const config = await readJson(this.runtimeFile);
    requireValue(config.nodeId === this.config.nodeId && config.portalOrigin === this.config.portalOrigin &&
      this.environment(config).CODEY_PORTAL_PRINCIPAL_ID === this.config.ownerId &&
      this.environment(config).CODEY_PORTAL_USERNAME === this.config.username);
    requireValue(samePath(await realpath(config.nodeExe), await realpath(process.execPath)));
    const info = await files.readInstalledPackageInfo(config.codeyDirectory);
    const installed = await this.installed();
    const component = { version: info.pkg.version, commit: info.build.sourceCommit,
      entrySha256: info.entrySha256, nodeMajor: Number(process.versions.node.split(".")[0]) };
    const components = { codey: component };
    for (const [name, key] of [["cloudcli", "workspaceEntrySha256"], ["copilotApi", "gatewayEntrySha256"]]) {
      components[name] = { version: info.build[name].version, commit: info.build[name].commit,
        entrySha256: info.build[key], nodeMajor: component.nodeMajor };
    }
    return { ...native, root: config.codeyDirectory, node: config.nodeExe, nodeId: config.nodeId,
      configHash: await fileHash(this.runtimeFile), protected: await protectedHashes(this.runtimeFile, this.probePath),
      components, installed, identityMatches: true };
  }
  async report({ onSnapshot } = {}) {
    try {
      const before = await this.snapshot();
      const activity = await this.native("idle");
      const config = await readJson(this.runtimeFile);
      const gateway = await readJson(path.join(this.environment(config).COPILOT_API_HOME, "config.json"));
      const keyReady = typeof config.modelKey === "string" && config.modelKey.length >= 32 &&
        this.environment(config).CODEY_MODEL_API_KEY === config.modelKey &&
        Array.isArray(gateway.auth?.apiKeys) && gateway.auth.apiKeys.includes(config.modelKey);
      onSnapshot?.(before);
      return { platform: this.platform, layout: "npm", components: before.components,
        currentRelease: before.installed.releaseId, highestSequence: before.installed.sequence,
        readyMigrations: keyReady ? ["gateway-api-key-v1"] : [], busy: !activity.idle };
    } catch {
      const installed = await this.installed();
      return { platform: this.platform, layout: "unsupported", components: {},
        currentRelease: installed.releaseId, highestSequence: installed.sequence,
        readyMigrations: [], blockedReason: "configuration_changed", busy: true };
    }
  }
  async assertUnchanged(before, { allowPackageChange = false } = {}) {
    const after = await this.snapshot();
    requireValue(objectHash(before.protected) === objectHash(after.protected));
    requireValue(objectHash(before.otherTasks) === objectHash(after.otherTasks));
    if (!allowPackageChange) requireValue(before.configHash === after.configHash && before.root === after.root &&
      before.pid === after.pid);
    return after;
  }
  async acquireLocal(job) {
    await mkdir(this.localState, { recursive: true, mode: 0o700 });
    await ownedPath(this.localState, this.home);
    requireValue(!(await exists(path.join(this.localState, "active.json"))), "busy");
    try { await mkdir(path.join(this.localState, "lock"), { mode: 0o700 }); }
    catch (error) { if (error.code === "EEXIST") throw new UpdateError("busy"); throw error; }
    try {
      await save(path.join(this.localState, "lock/owner.json"), { pid: process.pid });
      await save(path.join(this.localState, "active.json"), { schema: 1, pid: process.pid, job,
        source: this.platform?.startsWith("macos-") ? "macos-pull-agent" : "windows-pull-agent" });
    } catch (error) {
      if (!(await exists(path.join(this.localState, "active.json")))) {
        await rm(path.join(this.localState, "lock"), { recursive: true });
      }
      throw error;
    }
  }
  async releaseLocal(job) {
    const active = path.join(this.localState, "active.json");
    if (await exists(active)) {
      requireValue((await readJson(active)).job === job);
      await rm(active);
      await rm(path.join(this.localState, "lock"), { recursive: true });
    }
  }
  async stage(file, manifest, before, job) {
    const artifact = await inspectUpdateArchive(file, manifest.components.codey.sha256);
    requireValue(artifact.build.runtimePlatforms.includes(manifest.platform), "runtime_incompatible");
    requireValue(artifact.pkg.version === manifest.components.codey.version &&
      artifact.entrySha256 === manifest.components.codey.entrySha256 &&
      artifact.build.sourceCommit === manifest.components.codey.commit &&
      artifact.build.lockSha256 === manifest.components.codey.lockSha256, "signature_invalid");
    const home = path.join(job, "build-home");
    await mkdir(home, { mode: 0o700 });
    const env = buildEnvironment(home, before.node);
    const npm = await files.findNpm(before.node);
    const candidate = path.join(job, "app/node_modules/codey");
    await this.command(before.node, ["--input-type=commonjs", "-e", EXTRACT_PACKAGE, npm, file, candidate,
      env.npm_config_cache, "sha256-" + Buffer.from(artifact.sha256, "hex").toString("base64")],
    { env, cwd: job, timeout: 120000, log: path.join(job, "extract.private.log") });
    await this.verifyPackage(candidate, artifact);
    const reuse = await reusableDependencies(before.root, artifact.lock);
    if (reuse) {
      const reused = await linkDependencies(before.root, candidate, artifact.lock, { home: this.home });
      await save(path.join(job, "dependency-mode.json"), reused);
    } else {
      const flags = ["--prefix", candidate, "--omit=dev", "--no-audit", "--no-fund",
        "--engine-strict", "--umask=0077", "--strict-ssl=true", "--registry=https://registry.npmjs.org"];
      await this.command(before.node, [npm, "ci", "--ignore-scripts", ...flags],
        { env, cwd: candidate, timeout: 1200000, log: path.join(job, "npm-ci.private.log") });
      await this.verifyPackage(candidate, artifact);
      await this.command(before.node, [npm, "rebuild", ...flags],
        { env, cwd: candidate, timeout: 1200000, log: path.join(job, "npm-rebuild.private.log") });
    }
    if (!reuse) await save(path.join(job, "dependency-mode.json"), { mode: "npm-ci" });
    await this.verifyPackage(candidate, artifact);
    await this.command(before.node, [path.join(candidate, "bin/codey.mjs"), "doctor", "--json"],
      { env, cwd: home, timeout: 60000, log: path.join(job, "doctor.private.log") });
    return candidate;
  }
  async verifyPackage(root, artifact) {
    const info = await readPackageInfo(root);
    requireValue(info.entrySha256 === artifact.entrySha256, "signature_invalid");
    const entries = [...artifact.files];
    for (let offset = 0; offset < entries.length; offset += 8) {
      const results = await Promise.allSettled(entries.slice(offset, offset + 8).map(async ([name, expected]) => {
        const file = path.join(root, name);
        requireValue(samePath(await realpath(file), path.join(info.root, name)), "signature_invalid");
        const entry = await stat(file);
        requireValue(entry.isFile() && entry.size === expected.size &&
          await fileHash(file) === expected.sha256, "signature_invalid");
      }));
      for (const result of results) if (result.status === "rejected") throw result.reason;
    }
    await verifyDependencyBinding(root, artifact.lock, { home: this.home });
  }
  async commit(manifest, digest, job) {
    const request = await readJson(path.join(job, "request.json"));
    const signed = checkedReceipt(request, this.config.releasePublicKey, { allowExpired: true, platform: this.platform });
    requireValue(signed.digest === digest && objectHash(manifest) === objectHash(signed.release), "signature_invalid");
    requireValue(path.resolve(request.job) === path.resolve(job), "signature_invalid");
    await readAcceptanceProof(request);
    const installed = await this.installed();
    requireValue(manifest.sequence >= installed.sequence &&
      (manifest.sequence !== installed.sequence || !installed.digest || installed.digest === digest), "signature_invalid");
    const snapshot = await this.snapshot();
    requireValue(["version", "commit", "entrySha256"].every(key =>
      snapshot.components.codey[key] === manifest.components.codey[key]), "health_failed");
    await save(path.join(this.private, "installed.json"), {
      nodeId: this.config.nodeId, ownerId: this.config.ownerId, platform: this.platform,
      releaseId: manifest.id, sequence: manifest.sequence, digest, components: snapshot.components,
      jobId: path.basename(job), updatedAt: Date.now(),
    });
  }
}
