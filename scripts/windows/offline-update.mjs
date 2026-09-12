// Offline staging adapter; activation/recovery use the UNMODIFIED published updater.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, cp, lstat, mkdir, readFile, readdir, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const digest = async file => {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest("hex");
};
const readJson = async file => {
  try { return JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, "")); }
  catch { throw new Error("A required local JSON file is missing or invalid; its contents were not printed."); }
};

export function safeName(name) {
  if (typeof name !== "string" || !/^[a-zA-Z0-9_@+./-]+$/.test(name) ||
      name.split("/").some(part => !part || [".", ".."].includes(part) || /[. ]$/.test(part) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new Error("Unsafe offline bundle path.");
  }
  return name;
}

async function filesBelow(root, prefix = "") {
  const files = [];
  for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    const name = prefix + entry.name;
    safeName(name);
    if (entry.isSymbolicLink()) throw new Error("Offline bundle links are not allowed.");
    if (entry.isDirectory()) files.push(...await filesBelow(root, name + "/"));
    else if (entry.isFile()) files.push(name);
    else throw new Error("Offline bundle contains a special file.");
  }
  return files;
}

export async function verifyBundle(root) {
  const manifest = await readJson(path.join(root, "manifest.json"));
  assert.equal(manifest.schema, 1);
  assert.equal(manifest.kind, "codey-offline-windows");
  assert.equal(manifest.platform, "windows-x64");
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.package.file, `codey-${manifest.version}.tgz`);
  assert.match(manifest.package.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(manifest.nodeAbis, [127, 137]);
  assert.ok(manifest.files && Object.keys(manifest.files).length < 20000);
  const actual = await filesBelow(root);
  assert.deepEqual(actual.filter(name => name !== "manifest.json").sort(), Object.keys(manifest.files).sort(),
    "Offline bundle has missing or unexpected files.");
  const folded = new Set();
  for (const [name, expected] of Object.entries(manifest.files)) {
    safeName(name);
    assert.ok(!folded.has(name.toLowerCase()), "Windows path collision.");
    folded.add(name.toLowerCase());
    assert.ok(Number.isSafeInteger(expected.size) && expected.size >= 0);
    assert.match(expected.sha256, /^[a-f0-9]{64}$/);
    const file = path.join(root, name), stat = await lstat(file);
    assert.ok(stat.isFile() && !stat.isSymbolicLink());
    assert.equal(stat.size, expected.size, `Offline bundle size mismatch: ${name}`);
    assert.equal(await digest(file), expected.sha256, `Offline bundle checksum mismatch: ${name}`);
  }
  assert.equal(manifest.files[manifest.package.file].sha256, manifest.package.sha256);
  assert.equal(manifest.files[manifest.package.file].size, manifest.package.size);
  for (const name of Object.keys(manifest.packages)) {
    safeName(name);
    assert.ok(name.startsWith("node_modules/"));
    assert.equal(typeof manifest.packages[name], "string");
  }
  for (const abi of manifest.nodeAbis) {
    const native = manifest.sqlite[String(abi)];
    assert.equal(native.file, `native/${abi}/better_sqlite3.node`);
    assert.equal(native.version, manifest.packages["node_modules/better-sqlite3"]);
    assert.equal(native.sha256, manifest.files[native.file].sha256);
  }
  return manifest;
}

export function peX64(bytes) {
  if (bytes.length < 64 || bytes.toString("ascii", 0, 2) !== "MZ") return false;
  const offset = bytes.readUInt32LE(0x3c);
  return offset + 6 <= bytes.length && bytes.toString("ascii", offset, offset + 4) === "PE\0\0" &&
    bytes.readUInt16LE(offset + 4) === 0x8664;
}

export async function verifyPackages(root, manifest) {
  for (const [name, version] of Object.entries(manifest.packages)) {
    const file = path.join(root, safeName(name), "package.json");
    assert.equal((await readJson(file)).version, version, `Locked offline dependency differs: ${name}`);
  }
}

export function makeOfflineStage(bundle, manifest, core, { abi = Number(process.versions.modules) } = {}) {
  return async (artifact, plan, job, { command, npm }) => {
    assert.equal(artifact.sha256, manifest.package.sha256);
    assert.ok(manifest.nodeAbis.includes(abi), "This kit supports existing Node 22/24 x64 only; no Node is installed.");
    const home = path.join(job, "build-home");
    await mkdir(home, { mode: 0o700 });
    const env = core.buildEnvironment(home, plan.node);
    // Never inherit caller npm configuration, provider credentials or a writable shared cache.
    for (const key of Object.keys(env)) {
      if (/proxy/i.test(key)) delete env[key];
    }
    Object.assign(env, { npm_config_offline: "true", npm_config_ignore_scripts: "true",
      npm_config_audit: "false", npm_config_fund: "false", npm_config_update_notifier: "false" });
    await cp(path.join(bundle, "cache"), env.npm_config_cache,
      { recursive: true, errorOnExist: true, force: false });
    const archive = path.join(job, "package.tgz");
    await copyFile(artifact.file, archive);
    assert.equal(await digest(archive), artifact.sha256, "Package changed after preflight.");
    const prefix = path.join(job, "app");
    const candidate = path.join(prefix, "node_modules", "codey");
    // npm's global-install mode can resolve dependency ranges again even while
    // retaining the original shrinkwrap file. Use npm's own tarball extractor,
    // then npm ci against that EXACT shrinkwrap, not a second application build.
    const extract = `const {createRequire}=require('node:module');
      const pacote=createRequire(process.argv[1])('pacote');
      pacote.extract(process.argv[2],process.argv[3],{
        cache:process.argv[4],integrity:process.argv[5],offline:true,
        ignoreScripts:true,umask:0o077,fmode:0o600,dmode:0o700
      }).catch(error=>{console.error(error.message);process.exitCode=1});`;
    await command(plan.node, ["--input-type=commonjs", "-e", extract, npm, archive, candidate,
      env.npm_config_cache, "sha256-" + Buffer.from(artifact.sha256, "hex").toString("base64")],
    { env, cwd: job, log: path.join(job, "npm-extract.private.log"), timeout: 120000 });
    await core.verifyStagedPackage(candidate, artifact);
    const flags = ["--offline", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund",
      "--engine-strict", "--umask=0077", "--strict-ssl=true", "--os=win32", "--cpu=x64",
      "--registry=https://registry.npmjs.org", "--cache", env.npm_config_cache];
    await command(plan.node, [npm, "ci", "--prefix", candidate, ...flags],
      { env, cwd: candidate, log: path.join(job, "npm-offline.private.log"), timeout: 1200000 });
    // This adapter is reachable from the CLI only on native Windows.
    await core.verifyStagedPackage(candidate, artifact);
    await verifyPackages(candidate, manifest);

    const native = manifest.sqlite[String(abi)];
    const payload = await readFile(path.join(bundle, native.file));
    assert.equal(createHash("sha256").update(payload).digest("hex"), native.sha256);
    assert.ok(peX64(payload), "The SQLite prebuild is not a Windows x64 binary.");
    const destination = path.join(candidate, "node_modules/better-sqlite3/build/Release");
    await mkdir(destination, { recursive: true, mode: 0o700 });
    await copyFile(path.join(bundle, native.file), path.join(destination, "better_sqlite3.node"));
    assert.equal(await digest(path.join(destination, "better_sqlite3.node")), native.sha256);
    // bcrypt, node-pty (including ConPTY companions), ripgrep, etc. already carry
    // Windows prebuilds in their integrity-locked npm tarballs. NO install hook,
    // compiler, prebuild-install, npm rebuild, network bootstrap or setup is run.
    await core.verifyStagedPackage(candidate, artifact);
    await command(plan.node, [path.join(candidate, "bin/codey.mjs"), "doctor", "--json"],
      { env, cwd: home, log: path.join(job, "doctor-offline.private.log"), timeout: 60000 });
    return candidate;
  };
}

export function argumentsFor(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    assert.ok(["--bundle-root", "--mode", "--expected-computer"].includes(name) && args[index + 1],
      "Invalid offline updater arguments.");
    assert.ok(!Object.hasOwn(result, name), "Duplicate offline updater argument.");
    result[name] = args[index + 1];
  }
  assert.ok(["check", "apply", "recover"].includes(result["--mode"]));
  assert.ok(path.isAbsolute(result["--bundle-root"]));
  assert.match(result["--expected-computer"], /^[a-zA-Z0-9-]{1,63}$/);
  return result;
}

export function validateRecoveryScope(request, journal, manifest, currentRoot) {
  if (journal) assert.equal(journal.kind, "windows-managed", "An unrelated tool update needs its own recovery.");
  const requests = [request, journal?.request].filter(Boolean);
  assert.ok(!journal || requests.length, "A switching journal lacks its original request.");
  for (const item of requests) {
    assert.equal(item.sha256, manifest.package.sha256, "An unrelated local update needs its own recovery.");
    assert.equal(item.plan.kind, "windows-managed");
    assert.ok([item.plan.root, item.candidate].some(root =>
      typeof root === "string" && root.toLowerCase() === currentRoot.toLowerCase()),
    "The interrupted update does not match the managed installation.");
  }
  // With no journal, activation never began. The ORIGINAL updater still checks
  // that the recorded PID is dead before aborting staging/releasing its lock.
}

export async function main(args) {
  const options = argumentsFor(args);
  assert.ok(process.platform === "win32" && process.arch === "x64", "Use native Windows x64, not WSL.");
  assert.equal(os.hostname().toLowerCase(), options["--expected-computer"].toLowerCase(), "Wrong target computer.");
  const bundle = await realpath(options["--bundle-root"]);
  const manifest = await verifyBundle(bundle);
  assert.equal(manifest.expectedComputer.toLowerCase(), options["--expected-computer"].toLowerCase(),
    "Offline bundle targets another computer.");
  const home = await realpath(os.homedir());
  assert.ok(bundle.toLowerCase().startsWith(home.toLowerCase() + path.sep), "Bootstrap must be under the original owner's HOME.");
  const config = await readJson(path.join(home, ".config/codey-machine-windows/runtime.json"));
  assert.ok(config.schema === 2 && config.kind === "codey-windows-oneclick" && config.layout === "npm-codey-package",
    "This kit requires the existing owner-managed Windows npm installation; it will not reinstall or register a node.");
  assert.equal(config.computer, process.env.COMPUTERNAME, "The installation belongs to another computer.");
  assert.equal(config.ownerHome.toLowerCase(), home.toLowerCase(), "Wrong installation owner.");
  assert.equal((await realpath(config.nodeExe)).toLowerCase(), (await realpath(process.execPath)).toLowerCase(),
    "Use the original managed Node executable.");
  assert.ok(manifest.nodeAbis.includes(Number(process.versions.modules)),
    "This kit requires existing Node 22/24 x64; it will not change Node.");
  const load = name => import(pathToFileURL(path.join(bundle, "bootstrap", name)).href);
  const updater = await load("update.mjs"), files = await load("update-files.mjs");
  const core = { ...files, verifyStagedPackage: updater.verifyStagedPackage };
  const stage = makeOfflineStage(bundle, manifest, core);
  const mode = options["--mode"];
  if (mode === "recover") {
    const activeFile = path.join(home, ".local/share/codey-local-update/active.json");
    if (await files.exists(activeFile)) {
      const active = await readJson(activeFile);
      await files.ownedPath(active.job, home);
      const requestFile = path.join(active.job, "request.json"), journalFile = path.join(active.job, "local-update.json");
      const request = await files.exists(requestFile) ? await readJson(requestFile) : null;
      const journal = await files.exists(journalFile) ? await readJson(journalFile) : null;
      validateRecoveryScope(request, journal, manifest, config.codeyDirectory);
    }
    return updater.runUpdate(config.codeyDirectory, ["--recover"], { stage });
  }
  const updateArgs = [path.join(bundle, manifest.package.file), "--sha256", manifest.package.sha256];
  const preflight = await updater.runUpdate(config.codeyDirectory, [...updateArgs, "--check"], { stage });
  assert.equal(preflight.layout, "windows-managed");
  assert.equal(preflight.toVersion, manifest.version);
  console.log(JSON.stringify({ offlineDependenciesVerified: true, dependencyPackages: Object.keys(manifest.packages).length,
    nativeNodeAbi: Number(process.versions.modules), portalRequests: false, setupRun: false,
    note: "Only dependency installation is offline. Existing model services may contact their providers when restarted." }));
  if (mode === "check") return preflight;
  // No relaxed activity checks: the published Windows adapter rejects Codex,
  // busy Codey sessions, active model sockets and a Codey/Codex parent process.
  const result = await updater.runUpdate(config.codeyDirectory, updateArgs, { stage });
  const after = await readJson(path.join(home, ".config/codey-machine-windows/runtime.json"));
  const metadata = await readJson(path.join(after.codeyDirectory, "package.json"));
  assert.equal(metadata.version, manifest.version);
  console.log(JSON.stringify({ ok: true, version: metadata.version, offlinePackageInstalled: true,
    nodeAndCodexAndDevtunnelUpdated: false, modelRequests: false }));
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
