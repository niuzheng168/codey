/** Explicit local-package update, never a daemon, remote agent or tool updater. */
import { copyFile, mkdir, readFile, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { inspectPackageArchive, verifyStagedPackage } from "./package-archive.mjs";
import { buildEnvironment, fileHash, findNpm } from "./package-files.mjs";
import { copyDependencies, sameDependencies } from "./package-dependencies.mjs";
import { backupDocument, writeBackup } from "./machine-backup.mjs";

async function assertUpdateBaseline(m, config, setup, states) {
  if (!isDeepStrictEqual(await m.i.read(m.i.file), config) ||
      !isDeepStrictEqual(await m.i.read(config.setupFile), setup)) {
    throw new Error("Node configuration changed while preparing the update; no services were stopped");
  }
  await m.tools();
  await m.i.checkPorts(config);
  const stable = values => values.filter(item => !item.auxiliary)
    .map(({ name, enabled, running }) => ({ name, enabled, running })).sort((a, b) => a.name.localeCompare(b.name));
  if (!isDeepStrictEqual(stable(await m.services()), stable(states))) {
    throw new Error("Service state changed while preparing the update; no services were stopped");
  }
}

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

export async function updateMachine(m, options, {
  prepare = prepareUpdate, updateJob, progress = async () => {}, activationDelay = 5000,
} = {}) {
  if (options.status) return (await import("./machine-update-job.mjs")).readUpdateStatus(m);
  if (options.background && m.i.target !== "linux-x64") {
    throw new Error("Background updates currently require Linux systemd user services; use an external owner terminal on this platform");
  }
  const started = performance.now();
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
  let background = Boolean(options.background);
  if (!background) {
    try { await m.external(); }
    catch (error) {
      if (error.code !== "CODEY_INTERNAL_TERMINAL" || m.i.target !== "linux-x64" || updateJob) throw error;
      background = true;
    }
  }
  if (background) {
    if (updateJob) throw new Error("An update worker cannot queue another worker");
    return (await import("./machine-update-job.mjs")).queueUpdate(m, options, artifact, plan);
  }
  return m.lock(async () => {
    await m.tools();
    await m.i.checkPorts(m.config);
    const before = structuredClone(m.config), setupBefore = structuredClone(m.i.setup);
    const allStates = (await m.services()).map(item => item.auxiliary ? { ...item, running: false, enabled: false } : item);
    const release = await m.i.checked(path.join(m.i.root, "releases", `package-${artifact.pkg.version}-${randomBytes(8).toString("hex")}`));
    await m.i.directory(path.dirname(release));
    await mkdir(release, { mode: 0o700 });
    await m.i.directory(release);
    let app;
    try {
      await progress({ state: "preparing" });
      app = await prepare(m, artifact, release, { offline: Boolean(options.offline), reuse });
    }
    catch (error) { await rm(release, { recursive: true, force: true }); throw error; }
    const backup = path.join(m.i.configRoot, `before-update-${randomBytes(8).toString("hex")}.gz`);
    await writeBackup(m, backup, await backupDocument(m));
    const next = { ...structuredClone(before), codeyDirectory: app, codeyBin: path.join(app, "bin/codey.mjs"),
      releaseDirectory: release, codeyEntrySha256: artifact.entrySha256, releaseId: `machine-${artifact.entrySha256.slice(0, 16)}` };
    const states = m.i.adapter.updateServices?.(before, next, allStates) ?? allStates;
    const stopped = states.map(item => ({ ...item, enabled: false, running: false }));
    const prepared = performance.now();
    await progress({ state: "ready", backup, services: states.map(item => item.name) });
    // Let the submitting CLI return before its Workspace/connection is stopped.
    // This is a reconnectable update, not request draining or automatic replay.
    if (updateJob) await m.i.pause(activationDelay);
    // All refusals before the first service action must stay outside rollback:
    // rolling back here would overwrite another actor's edits or stop healthy services.
    await progress({ state: "switching" });
    await assertUpdateBaseline(m, before, setupBefore, allStates);
    const switching = performance.now();
    try {
      await m.setStates(stopped);
      await m.waitFor(stopped);
      await m.i.checkPorts(before);
      await m.save(next);
      m.i.setup = { ...setupBefore, releaseId: next.releaseId };
      await m.i.write(next.setupFile, m.i.setup);
      await m.setStates(states);
      await m.waitFor(states);
      await progress({ state: "verifying" });
      await m.verifyRunning(states);
      const { writeResources } = await import(pathToFileURL(path.join(m.i.skill, "scripts/machine-resources.mjs")).href);
      await writeResources(m.i, next);
      return { ...plan, changed: true, backup,
        timings: { totalMs: Math.round(performance.now() - started),
          preparationMs: Math.round(prepared - started), switchMs: Math.round(performance.now() - switching) },
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
        await m.verifyRunning(states);
      } catch { m.keepLock = true; throw new Error(`Update failed and rollback needs review; services may be stopped. Private backup: ${backup}`); }
      throw new Error("Update failed; previous package and service state were restored");
    }
  }, { updateJob });
}
