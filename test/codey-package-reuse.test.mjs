import assert from "node:assert/strict";
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { copyDependencies, linkDependencies, sameDependencies, verifyDependencyBinding, verifyDependencyTree } from "../packages/codey/lib/update-dependencies.mjs";
import { execute, exists, fileHash, readJson } from "../packages/codey/lib/update-files.mjs";
import { recoverStandalone, runUpdate, updateOptions } from "../packages/codey/lib/update.mjs";
import { installOptions } from "../scripts/install-codey-runtime.mjs";
import { Runtime } from "../node-updater/windows/runtime.mjs";
import { inspectUpdateArchive } from "../packages/codey/lib/update-archive.mjs";
import { fingerprint, jsonFile, packFixture, treeFiles, updateFixture } from "./codey-update-fixture.mjs";

async function dependenciesFixture(t) {
  const f = await updateFixture(t);
  for (const root of [f.old, f.next]) {
    const pkg = await readJson(path.join(root, "package.json"));
    pkg.dependencies = { fixture: "^1.0.0" };
    const lock = await readJson(path.join(root, "npm-shrinkwrap.json"));
    lock.packages[""].dependencies = pkg.dependencies;
    lock.packages["node_modules/fixture"] = {
      version: "1.0.0", resolved: "https://registry.npmjs.org/fixture/-/fixture-1.0.0.tgz", integrity: "sha512-YWJjZA==",
    };
    await jsonFile(path.join(root, "package.json"), pkg);
    await jsonFile(path.join(root, "npm-shrinkwrap.json"), lock);
    await fingerprint(root);
  }
  await packFixture(f.next, f.archive);
  await mkdir(path.join(f.old, "node_modules/fixture"), { recursive: true, mode: 0o700 });
  await jsonFile(path.join(f.old, "node_modules/fixture/package.json"), { name: "fixture", version: "1.0.0" });
  await writeFile(path.join(f.old, "node_modules/fixture/index.js"), "module.exports = 'existing';\n");
  return f;
}

test("offline options are explicit and cannot be combined with recovery", () => {
  assert.equal(updateOptions(["new.tgz", "--offline", "--check"]).offline, true);
  assert.throws(() => updateOptions(["new.tgz", "--offline", "--offline"]), /Duplicate/);
  assert.throws(() => updateOptions(["--recover", "--offline"]), /cannot be combined/);
  assert.equal(installOptions(["--package", "new.tgz", "--sha256", "a".repeat(64),
    "--reuse-from", "existing codey", "--check"])["reuse-from"], "existing codey");
});

test("dependency equivalence ignores application version but not package versions, integrity or ranges", async t => {
  const f = await dependenciesFixture(t);
  const before = await readJson(path.join(f.old, "npm-shrinkwrap.json"));
  const after = await readJson(path.join(f.next, "npm-shrinkwrap.json"));
  assert.equal(sameDependencies(before, after), true);
  for (const edit of [
    lock => { lock.packages[""].dependencies.fixture = "^2.0.0"; },
    lock => { lock.packages["node_modules/fixture"].version = "1.0.1"; },
    lock => { lock.packages["node_modules/fixture"].integrity = "sha512-dGVzdA=="; },
  ]) {
    const changed = structuredClone(after);
    edit(changed);
    assert.equal(sameDependencies(before, changed), false);
  }
});

test("real offline update retains the same dependency files across two app-only updates without npm install/rebuild", { timeout: 120000 }, async t => {
  const f = await dependenciesFixture(t);
  const calls = [];
  const options = {
    home: f.home, idle: async () => {}, log() {},
    discover: async () => ({
      kind: "npm", root: f.old, node: process.execPath,
      jobsRoot: path.join(path.dirname(f.old), ".codey-local-updates"), services: [],
    }),
    command: async (file, args, opts) => {
      calls.push(args);
      assert.ok(!args.some(arg => ["install", "rebuild", "ci"].includes(arg)));
      return execute(file, args, opts);
    },
  };
  const before = await treeFiles(f.home);
  const check = await runUpdate(f.old, [f.archive, "--offline", "--check"], options);
  assert.equal(check.dependencyMode, "reuse-installed-linked");
  assert.deepEqual(await treeFiles(f.home), before);
  const installedFile = path.join(f.old, "node_modules/fixture/index.js");
  const original = await stat(installedFile);
  const result = await runUpdate(f.old, [f.archive, "--offline"], options);
  assert.equal(result.ok, true);
  assert.equal(result.fromVersion, "1.0.0");
  assert.equal(result.toVersion, "2.0.0");
  assert.ok(calls.some(args => args.includes("--input-type=commonjs")));
  assert.equal(await exists(path.join(result.job, "npm-install.private.log")), false);
  assert.equal((await lstat(path.join(f.old, "node_modules"))).isSymbolicLink(), true);
  const retained = await realpath(path.join(result.job, "previous-codey/node_modules"));
  assert.equal(await realpath(path.join(f.old, "node_modules")), retained);
  assert.equal((await stat(installedFile)).ino, original.ino);
  assert.equal((await readJson(path.join(result.job, "dependency-mode.json"))).copiedBytes, 0);
  assert.equal(await readFile(installedFile, "utf8"), "module.exports = 'existing';\n");

  const pkg = await readJson(path.join(f.next, "package.json"));
  pkg.version = "3.0.0";
  await jsonFile(path.join(f.next, "package.json"), pkg);
  const lock = await readJson(path.join(f.next, "npm-shrinkwrap.json"));
  lock.version = lock.packages[""].version = pkg.version;
  await jsonFile(path.join(f.next, "npm-shrinkwrap.json"), lock);
  await fingerprint(f.next);
  await packFixture(f.next, f.archive);
  const next = await runUpdate(f.old, [f.archive, "--offline"], options);
  assert.equal(next.toVersion, "3.0.0");
  assert.equal(await realpath(path.join(f.old, "node_modules")), retained, "No chain or second dependency copy");
  assert.equal((await stat(installedFile)).ino, original.ino);
  await verifyDependencyBinding(f.old, lock, { home: f.home });
});

test("the Portal native updater also stages matching locked dependencies offline without npm ci or rebuild", { timeout: 120000 }, async t => {
  const f = await dependenciesFixture(t);
  const artifact = await inspectUpdateArchive(f.archive);
  const job = path.join(f.home, "portal-job");
  await mkdir(job, { mode: 0o700 });
  const calls = [];
  const runtime = new Runtime({}, { home: f.home, command: async (file, args, options) => {
    calls.push(args);
    assert.ok(!args.some(arg => ["ci", "rebuild", "install"].includes(arg)));
    return execute(file, args, options);
  } });
  const candidate = await runtime.stage(f.archive, { platform: "windows-x64", components: { codey: {
    version: artifact.pkg.version, sha256: artifact.sha256, entrySha256: artifact.entrySha256,
    commit: artifact.build.sourceCommit, lockSha256: artifact.build.lockSha256,
  } } }, { root: f.old, node: process.execPath }, job);
  const mode = await readJson(path.join(job, "dependency-mode.json"));
  assert.equal(mode.mode, "reuse-installed-linked");
  assert.equal(mode.copiedFiles, 0);
  assert.equal(mode.copiedBytes, 0);
  assert.ok(calls.some(args => args.includes("doctor")));
  assert.equal((await lstat(path.join(candidate, "node_modules"))).isSymbolicLink(), true);
  assert.equal(await realpath(path.join(candidate, "node_modules")), await realpath(path.join(f.old, "node_modules")));
  assert.equal(await readFile(path.join(candidate, "node_modules/fixture/index.js"), "utf8"), "module.exports = 'existing';\n");
  assert.equal(await readFile(path.join(f.old, "node_modules/fixture/index.js"), "utf8"), "module.exports = 'existing';\n");
  await rm(candidate, { recursive: true });
  assert.equal(await readFile(path.join(f.old, "node_modules/fixture/index.js"), "utf8"), "module.exports = 'existing';\n",
    "Removing a staged application must not follow its dependency link");
});

test("failed activation restores the same dependency tree without copying or rebuilding it", { timeout: 120000 }, async t => {
  const f = await dependenciesFixture(t);
  const original = await stat(path.join(f.old, "node_modules/fixture/index.js"));
  await assert.rejects(runUpdate(f.old, [f.archive, "--offline"], {
    home: f.home, idle: async () => {}, log() {},
    discover: async () => ({ kind: "npm", root: f.old, node: process.execPath, services: [],
      jobsRoot: path.join(path.dirname(f.old), ".codey-local-updates") }),
    command: async (file, args, options) => {
      if (options?.log?.endsWith("doctor-active.private.log")) throw new Error("Synthetic startup failure");
      return execute(file, args, options);
    },
  }), /Synthetic startup failure/);
  assert.equal((await readJson(path.join(f.old, "package.json"))).version, "1.0.0");
  assert.equal((await stat(path.join(f.old, "node_modules/fixture/index.js"))).ino, original.ino);
  assert.equal(await exists(path.join(f.home, ".local/share/codey-local-update/active.json")), false);
});

test("interruption before dependency relinking restores the original standalone installation", async t => {
  const f = await dependenciesFixture(t);
  const job = path.join(f.home, "interrupted-job"), backup = path.join(job, "previous-codey");
  await mkdir(job, { mode: 0o700 });
  const candidate = path.join(job, "candidate");
  await mkdir(candidate, { mode: 0o700 });
  const lock = await readJson(path.join(f.next, "npm-shrinkwrap.json"));
  await linkDependencies(f.old, candidate, lock, { home: f.home });
  const previousEntrySha256 = await fileHash(path.join(f.old, "codey-build.json"));
  await rename(f.old, backup);
  const result = await recoverStandalone({ state: "applying", backup, request: {
    plan: { root: f.old }, candidate, job, previousEntrySha256,
  } }, f.home, async () => {});
  assert.equal(result.recovered, "rolled_back");
  assert.equal(await realpath(path.join(candidate, "node_modules")), await realpath(path.join(f.old, "node_modules")));
});

test("shared dependencies require a matching owner-bound record, runtime ABI and unchanged link target", async t => {
  const f = await dependenciesFixture(t);
  const candidate = path.join(f.home, "candidate");
  await mkdir(candidate, { mode: 0o700 });
  const lock = await readJson(path.join(f.next, "npm-shrinkwrap.json"));
  await linkDependencies(f.old, candidate, lock, { home: f.home });
  const file = path.join(candidate, "codey-dependency-link.json");
  const record = await readJson(file);
  await jsonFile(file, { ...record, abi: "999999" });
  await assert.rejects(verifyDependencyBinding(candidate, lock, { home: f.home }), /binding differs/);
  await jsonFile(file, record);
  await rm(path.join(candidate, "node_modules"));
  const outside = path.join(f.temp, "outside");
  await mkdir(outside, { mode: 0o700 });
  await symlink(outside, path.join(candidate, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(verifyDependencyBinding(candidate, lock, { home: f.home }), /no longer matches/);
  await jsonFile(file, { ...record, modules: outside });
  await assert.rejects(verifyDependencyBinding(candidate, lock, { home: f.home }), /own HOME/);
});

test("an application archive cannot supply its own installed dependency binding", async t => {
  const f = await dependenciesFixture(t);
  await packFixture(f.next, f.archive, [{ name: "package/codey-dependency-link.json", body: "{}\n" }]);
  await assert.rejects(inspectUpdateArchive(f.archive), /unsafe or duplicate archive path/);
});

test("a prior installed dependency link is checked and adopted, never accepted as an unbound candidate", async t => {
  const f = await dependenciesFixture(t);
  const retained = path.join(f.home, "retained-node-modules");
  await rename(path.join(f.old, "node_modules"), retained);
  await symlink(retained, path.join(f.old, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  const lock = await readJson(path.join(f.next, "npm-shrinkwrap.json"));
  await assert.rejects(verifyDependencyBinding(f.old, lock, { home: f.home }), /ENOENT/);
  const candidate = path.join(f.home, "candidate");
  await mkdir(candidate, { mode: 0o700 });
  await linkDependencies(f.old, candidate, lock, { home: f.home });
  assert.equal(await verifyDependencyBinding(candidate, lock, { home: f.home }), await realpath(retained));
});

test("dependency reuse refuses a writable-by-others source tree", { skip: process.platform === "win32" }, async t => {
  const f = await dependenciesFixture(t);
  const candidate = path.join(f.home, "candidate");
  await mkdir(candidate, { mode: 0o700 });
  await chmod(path.join(f.old, "node_modules"), 0o777);
  const lock = await readJson(path.join(f.next, "npm-shrinkwrap.json"));
  await assert.rejects(linkDependencies(f.old, candidate, lock, { home: f.home }), /not writable by other users/);
});

test("changed locks and missing or mismatched dependencies fail before an offline transaction", async t => {
  const f = await dependenciesFixture(t);
  const options = {
    home: f.home, idle: async () => {}, log() {},
    discover: async () => ({ kind: "npm", root: f.old, node: process.execPath, services: [], jobsRoot: path.join(f.home, "jobs") }),
  };
  const manifest = path.join(f.old, "node_modules/fixture/package.json");
  await jsonFile(manifest, { version: "9.0.0" });
  await assert.rejects(runUpdate(f.old, [f.archive, "--offline"], options), /Installed dependency differs/);
  await rm(manifest);
  await assert.rejects(runUpdate(f.old, [f.archive, "--offline"], options), /ENOENT/);
  assert.equal(await exists(path.join(f.home, ".local/share/codey-local-update")), false);
  const lock = await readJson(path.join(f.next, "npm-shrinkwrap.json"));
  lock.packages["node_modules/fixture"].version = "1.0.1";
  await jsonFile(path.join(f.next, "npm-shrinkwrap.json"), lock);
  await fingerprint(f.next);
  await packFixture(f.next, f.archive);
  await assert.rejects(runUpdate(f.old, [f.archive, "--offline"], options), /--offline requires/);
});

test("the standalone installer bootstraps offline without changing PATH, services or the donor", { timeout: 120000 }, async t => {
  const f = await dependenciesFixture(t);
  const prefix = path.join(f.home, "offline bootstrap");
  const before = await treeFiles(f.old);
  const output = await execute(process.execPath, [
    fileURLToPath(new URL("../scripts/install-codey-runtime.mjs", import.meta.url)),
    "--package", f.archive, "--sha256", await fileHash(f.archive), "--prefix", prefix,
    "--reuse-from", f.old, "--check",
  ], { env: { ...process.env, HOME: f.home, USERPROFILE: f.home }, timeout: 120000 });
  assert.match(output, /"dependencyMode":"reuse-installed-offline"/);
  assert.match(output, /"pathChanged":false/);
  assert.deepEqual(await treeFiles(f.old), before);
  assert.equal(await exists(path.join(f.home, ".local/bin")), false);
  assert.equal(await exists(path.join(f.home, ".config")), false);
  const root = path.join(prefix, ...(process.platform === "win32" ? [] : ["lib"]), "node_modules/codey");
  assert.equal((await readJson(path.join(root, "package.json"))).version, "2.0.0");
  assert.equal((await readJson(path.join(root, "node_modules/fixture/package.json"))).version, "1.0.0");
});

test("copying rejects a changed lock and optional absent packages remain optional", async t => {
  const f = await dependenciesFixture(t);
  const lock = await readJson(path.join(f.next, "npm-shrinkwrap.json"));
  lock.packages["node_modules/optional"] = { version: "1.0.0", optional: true };
  await verifyDependencyTree(f.old, lock);
  await assert.rejects(copyDependencies(f.old, f.next, lock), /identical dependency lock/);
  lock.packages["../../escape"] = { version: "1.0.0" };
  await assert.rejects(verifyDependencyTree(f.old, lock), /Unsafe dependency lock path/);
});

test("dependency symlinks cannot retain references outside the copied tree", {
  skip: process.platform === "win32",
}, async t => {
  const f = await dependenciesFixture(t);
  const lock = await readJson(path.join(f.next, "npm-shrinkwrap.json"));
  const link = path.join(f.old, "node_modules/link");
  await symlink(f.home, link);
  await assert.rejects(verifyDependencyTree(f.old, lock), /stay inside/);
  await rm(link);
  await symlink(path.join(f.old, "node_modules/fixture"), link);
  await assert.rejects(verifyDependencyTree(f.old, lock), /Absolute dependency links/);
  await rm(link);
  await symlink("fixture", link);
  await copyDependencies(f.old, f.next, lock);
  assert.equal(await readFile(path.join(f.next, "node_modules/link/index.js"), "utf8"),
    "module.exports = 'existing';\n");
});
