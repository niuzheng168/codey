/** Explicit local-package update, never a daemon, remote agent or tool updater. */
import { copyFile, mkdir, readFile, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { inspectPackageArchive, verifyStagedPackage } from "./package-archive.mjs";
import { buildEnvironment, fileHash, findNpm } from "./package-files.mjs";
import { copyDependencies, sameDependencies } from "./package-dependencies.mjs";
import { backupDocument, writeBackup } from "./machine-backup.mjs";

/** Same locked dependency helpers as the runtime installer; no package code runs before validation. */
export async function prepareUpdate(m, artifact, release, { offline = false, reuse = false } = {}) {
  const app = path.join(release, "app"), buildHome = await m.i.directory(path.join(release, "build-home"));
  const archive = path.join(release, "package.tgz");
  await copyFile(artifact.file, archive);
  if (await fileHash(archive) !== artifact.sha256) throw new Error("Package changed while preparing the update");
  const npm = await findNpm(m.config.nodeExe);
  const environment = buildEnvironment(buildHome, m.config.nodeExe);
  const execute = async args => {
    const result = await m.i.run(m.config.nodeExe, args,
      { env: environment, cwd: release, timeout: 1800000, replaceEnvironment: true, check: false });
    if (result.code !== 0) {
      const log = path.join(m.i.configRoot, "last-package-update.log");
      await m.i.write(log, Buffer.from((result.stdout + "\n" + result.stderr).slice(-2 * 1024 * 1024)));
      throw new Error(`Package preparation failed; inspect the private log: ${log}. No Python/toolchain was installed automatically`);
    }
    return result;
  };
  const extract = `process.umask(0o077);
require("node:module").createRequire(process.argv[1])("pacote").extract(process.argv[2],process.argv[3],{
  cache:process.argv[4],integrity:process.argv[5],offline:true,ignoreScripts:true,umask:0o077,fmode:0o600,dmode:0o700
}).catch(()=>{console.error("Package extraction failed");process.exitCode=1});`;
  await execute(["--input-type=commonjs", "-e", extract, npm, archive, app, path.join(buildHome, ".npm"),
    "sha256-" + Buffer.from(artifact.sha256, "hex").toString("base64")]);
  await verifyStagedPackage(app, artifact, { home: m.i.home });
  if (reuse) await copyDependencies(m.config.codeyDirectory, app, artifact.lock);
  else {
    if (offline) throw new Error("Offline update requires an identical installed dependency lock");
    const flags = ["--prefix", app, "--omit=dev", "--no-audit", "--no-fund", "--umask=0077", "--strict-ssl=true",
      "--registry=https://registry.npmjs.org"];
    await execute([npm, "ci", "--ignore-scripts", ...flags]);
    await verifyStagedPackage(app, artifact, { home: m.i.home });
    await execute([npm, "rebuild", ...flags]);
  }
  await verifyStagedPackage(app, artifact, { home: m.i.home });
  const probe = await execute([path.join(app, "bin/codey.mjs"), "doctor", "--runtime-only", "--json"]);
  let report;
  try { report = JSON.parse(probe.stdout); } catch { /* Do not echo child output. */ }
  if (report?.ok !== true || report.version !== artifact.pkg.version) throw new Error("New package runtime/native validation failed");
  return app;
}

export async function updateMachine(m, options, { prepare = prepareUpdate } = {}) {
  const artifact = await inspectPackageArchive(options.file, options.sha256);
  if (!artifact.build.runtimePlatforms.includes(m.i.target)) throw new Error("Package does not support this native platform");
  const required = ["lib/machine.mjs", "lib/machine-update.mjs", "lib/machine-backup.mjs",
    "onboarding/scripts/install-machine.mjs", "onboarding/scripts/platform-linux.mjs",
    "onboarding/scripts/platform-macos.mjs", "onboarding/scripts/platform-windows.mjs", "onboarding/scripts/windows-native.ps1"];
  if (required.some(name => !artifact.files.has(name))) throw new Error("Use a complete Codey package with the node-management CLI");
  const engine = /^>=(\d+)\.(\d+)\.(\d+)$/.exec(artifact.pkg.engines?.node ?? "");
  const current = process.versions.node.split(".").map(Number);
  if (!engine || current[0] < +engine[1] || current[0] === +engine[1] &&
      (current[1] < +engine[2] || current[1] === +engine[2] && current[2] < +engine[3])) {
    throw new Error("Package requires a different Node runtime; tool upgrades are not part of codey update");
  }
  const oldLock = JSON.parse(await readFile(path.join(m.config.codeyDirectory, "npm-shrinkwrap.json"), "utf8"));
  const reuse = sameDependencies(oldLock, artifact.lock);
  if (options.offline && !reuse) throw new Error("Offline update requires an identical installed dependency lock");
  await m.services(); // Full ownership validation before either staging or stopping anything.
  const plan = { ok: true, operation: "update", file: artifact.file, check: Boolean(options.check),
    from: m.info.pkg.version, version: artifact.pkg.version, sha256: artifact.sha256,
    dependencyMode: reuse ? "reuse-installed-offline" : "npm-install", downloads: !reuse };
  if (options.check) return plan;
  if (artifact.entrySha256 === m.config.codeyEntrySha256) {
    await verifyStagedPackage(m.config.codeyDirectory, artifact, { home: m.i.home });
    return { ...plan, changed: false };
  }
  await m.external();
  return m.lock(async () => {
    await m.tools();
    const before = structuredClone(m.config), setupBefore = structuredClone(m.i.setup);
    const states = (await m.services()).map(item => item.auxiliary ? { ...item, running: false, enabled: false } : item);
    const stopped = states.map(item => ({ ...item, enabled: false, running: false }));
    const release = await m.i.checked(path.join(m.i.root, "releases", `package-${artifact.pkg.version}-${randomBytes(8).toString("hex")}`));
    await m.i.directory(path.dirname(release));
    await mkdir(release, { mode: 0o700 });
    await m.i.directory(release);
    let app;
    try { app = await prepare(m, artifact, release, { offline: Boolean(options.offline), reuse }); }
    catch (error) { await rm(release, { recursive: true, force: true }); throw error; }
    const backup = path.join(m.i.configRoot, `before-update-${randomBytes(8).toString("hex")}.gz`);
    await writeBackup(m, backup, await backupDocument(m));
    const next = { ...structuredClone(before), codeyDirectory: app, codeyBin: path.join(app, "bin/codey.mjs"),
      releaseDirectory: release, codeyEntrySha256: artifact.entrySha256, releaseId: `machine-${artifact.entrySha256.slice(0, 16)}` };
    try {
      await m.setStates(stopped);
      await m.waitFor(stopped);
      await m.i.checkPorts(before);
      await m.save(next);
      m.i.setup = { ...setupBefore, releaseId: next.releaseId };
      await m.i.write(next.setupFile, m.i.setup);
      await m.setStates(states);
      await m.waitFor(states);
      await m.verifyRunning(states);
      const { writeResources } = await import(pathToFileURL(path.join(m.i.skill, "scripts/machine-resources.mjs")).href);
      await writeResources(m.i, next);
      return { ...plan, changed: true, backup,
        warning: "Package updated; configuration, credentials, TLS identity and previous release retained. No Portal registration or tool update." };
    } catch {
      try {
        await m.setStates(stopped);
        await m.waitFor(stopped);
        await m.save(before);
        m.i.setup = setupBefore;
        await m.i.write(before.setupFile, setupBefore);
        await m.setStates(states);
        await m.waitFor(states);
      } catch { m.keepLock = true; throw new Error(`Update failed and rollback needs review; services may be stopped. Private backup: ${backup}`); }
      throw new Error("Update failed; previous package and service state were restored");
    }
  });
}
