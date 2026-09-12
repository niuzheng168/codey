import assert from "node:assert/strict";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { copyDependencies, sameDependencies, verifyDependencyTree } from "../packages/codey/lib/update-dependencies.mjs";
import { execute, exists, fileHash, readJson } from "../packages/codey/lib/update-files.mjs";
import { runUpdate, updateOptions } from "../packages/codey/lib/update.mjs";
import { installOptions } from "../scripts/install-codey-runtime.mjs";
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
  await mkdir(path.join(f.old, "node_modules/fixture"), { recursive: true });
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

test("real offline update copies dependencies independently and invokes no npm install/rebuild", { timeout: 120000 }, async t => {
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
  assert.equal(check.dependencyMode, "reuse-installed-offline");
  assert.deepEqual(await treeFiles(f.home), before);
  const result = await runUpdate(f.old, [f.archive, "--offline"], options);
  assert.equal(result.ok, true);
  assert.equal(result.fromVersion, "1.0.0");
  assert.equal(result.toVersion, "2.0.0");
  assert.ok(calls.some(args => args.includes("--input-type=commonjs")));
  assert.equal(await exists(path.join(result.job, "npm-install.private.log")), false);
  const copied = path.join(f.old, "node_modules/fixture/index.js");
  assert.equal(await readFile(copied, "utf8"), "module.exports = 'existing';\n");
  await writeFile(copied, "new copy");
  assert.equal(await readFile(path.join(result.job, "previous-codey/node_modules/fixture/index.js"), "utf8"),
    "module.exports = 'existing';\n");
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
