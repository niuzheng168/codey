import assert from "node:assert/strict";
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { copyDependencies, sameDependencies, verifyDependencyTree } from "../packages/codey/lib/package-dependencies.mjs";
import { execute, exists, fileHash, readJson } from "../packages/codey/lib/package-files.mjs";
import { installOptions } from "../scripts/install-codey-runtime.mjs";
import { inspectPackageArchive } from "../packages/codey/lib/package-archive.mjs";
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

test("an application archive cannot supply its own installed dependency binding", async t => {
  const f = await dependenciesFixture(t);
  await packFixture(f.next, f.archive, [{ name: "package/codey-dependency-link.json", body: "{}\n" }]);
  await assert.rejects(inspectPackageArchive(f.archive), /unsafe or duplicate archive path/);
});

test("the standalone installer bootstraps offline without changing PATH, services or the donor", { timeout: 120000 }, async t => {
  const f = await dependenciesFixture(t);
  const prefix = path.join(f.home, "offline bootstrap");
  const before = await treeFiles(f.old);
  const output = await execute(process.execPath, [
    fileURLToPath(new URL("../scripts/install-codey-runtime.mjs", import.meta.url)),
    "--package", f.archive, "--sha256", await fileHash(f.archive), "--prefix", prefix,
    "--reuse-from", f.old, "--no-launcher",
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

test("runtime-only --check is genuinely read-only even when dependencies are not installed", async t => {
  const f = await dependenciesFixture(t);
  const before = await treeFiles(f.home);
  const output = await execute(process.execPath, [
    fileURLToPath(new URL("../scripts/install-codey-runtime.mjs", import.meta.url)),
    "--package", f.archive, "--sha256", await fileHash(f.archive),
    "--prefix", path.join(f.home, "must-not-exist"), "--check",
  ], { env: { ...process.env, HOME: f.home, USERPROFILE: f.home, npm_config_offline: "true" } });
  assert.equal(JSON.parse(output).fileChanges, false);
  assert.equal(JSON.parse(output).downloads, false);
  assert.deepEqual(await treeFiles(f.home), before);
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
