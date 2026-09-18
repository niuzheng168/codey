import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { inspectPackageArchive } from "../packages/codey/lib/package-archive.mjs";
import { buildEnvironment, fileHash, readJson } from "../packages/codey/lib/package-files.mjs";
import { fingerprint, jsonFile, packFixture, tarEntries, treeFiles, updateFixture } from "./codey-update-fixture.mjs";

test("archive inspection validates the local shared package without extracting or executing it", async t => {
  const f = await updateFixture(t);
  const before = [...(await treeFiles(f.home)).keys()];
  const artifact = await inspectPackageArchive(f.archive);
  assert.equal(artifact.pkg.version, "2.0.0");
  assert.equal(artifact.sha256, await fileHash(f.archive));
  assert.ok(artifact.files.has("lib/package-archive.mjs"));
  assert.ok(artifact.files.has("lib/workspace.mjs"));
  assert.equal(artifact.files.has("lib/update.mjs"), false);
  assert.deepEqual([...await treeFiles(f.home)].map(([name]) => name), before);
  await assert.rejects(inspectPackageArchive(f.archive, "f".repeat(64)), /SHA-256 mismatch/);
  await writeFile(path.join(f.next, "gateway/main.js"), "tampered");
  await packFixture(f.next, f.archive);
  await assert.rejects(inspectPackageArchive(f.archive), /fingerprints/);
});

test("missing private CloudCLI/installation entrypoints are rejected before installation or update", async t => {
  for (const name of ["lib/workspace.mjs", "lib/install.mjs"]) {
    const f = await updateFixture(t);
    await rm(path.join(f.next, name));
    await fingerprint(f.next);
    await packFixture(f.next, f.archive);
    await assert.rejects(inspectPackageArchive(f.archive), error => error.message.includes(`missing ${name}`));
  }
});

test("unsafe tar entries, duplicate names, embedded runtimes and traversal are rejected before npm", async t => {
  const f = await updateFixture(t);
  for (const extra of [
    { name: "package/../../escape", body: "bad" },
    { name: "/package/absolute", body: "bad" },
    { name: "package\\windows-escape", body: "bad" },
    { name: "package/link", type: "2", link: "/etc/passwd" },
    { name: "package/hardlink", type: "1", link: "../elsewhere" },
    { name: "package/bin/CODEY.mjs", body: "duplicate on Windows" },
    { name: "package/node_modules/codex/index.js", body: "nested dependency" },
    { name: "package/internal/package.json", body: "{}" },
    { name: "package/aux.txt", body: "reserved Windows device" },
    { name: "package/codey.exe", body: "binary" },
    { name: "package/native", body: Buffer.from("7f454c460000", "hex") },
    { name: "package/.npmrc", body: "registry=https://untrusted.test" },
  ]) {
    await packFixture(f.next, f.archive, [extra]);
    await assert.rejects(inspectPackageArchive(f.archive), /Invalid Codey package/, extra.name);
  }
  await writeFile(f.archive, tarEntries([{ name: "package/package.json", body: "{}" }]));
  await assert.rejects(inspectPackageArchive(f.archive), /missing/);
});

test("the archive cannot cause npm to install Codex as another application", async t => {
  const f = await updateFixture(t);
  const pkg = await readJson(path.join(f.next, "package.json"));
  const lock = await readJson(path.join(f.next, "npm-shrinkwrap.json"));
  pkg.dependencies["@openai/codex"] = "1.0.0";
  lock.packages[""].dependencies = pkg.dependencies;
  await jsonFile(path.join(f.next, "package.json"), pkg);
  await jsonFile(path.join(f.next, "npm-shrinkwrap.json"), lock);
  await fingerprint(f.next);
  await packFixture(f.next, f.archive);
  await assert.rejects(inspectPackageArchive(f.archive), /another application or Codex/);
});

test("unexpected global CLI aliases and application install hooks are refused before lifecycle execution", async t => {
  const f = await updateFixture(t);
  const file = path.join(f.next, "package.json");
  const original = await readJson(file);
  for (const change of [
    { bin: { ...original.bin, codex: "bin/codex.mjs" } },
    { scripts: { install: "node onboarding/install-tools.mjs" } },
    { scripts: { postinstall: "codey guard" } },
  ]) {
    await jsonFile(file, { ...original, ...change });
    await fingerprint(f.next);
    await packFixture(f.next, f.archive);
    await assert.rejects(inspectPackageArchive(f.archive), /executable|install hook/);
  }
});

test("dependency lock paths cannot escape the private npm prefix or hide a native Codex package", async t => {
  const f = await updateFixture(t);
  const file = path.join(f.next, "npm-shrinkwrap.json");
  const original = await readJson(file);
  for (const name of ["../../.codex", "node_modules/../../outside", "node_modules/@openai/codex-linux-x64"]) {
    const lock = structuredClone(original);
    lock.packages[name] = {
      version: "1.0.0", resolved: "https://registry.npmjs.org/fixture/-/fixture-1.0.0.tgz", integrity: "sha512-YWJjZA==",
    };
    await jsonFile(file, lock);
    await fingerprint(f.next);
    await packFixture(f.next, f.archive);
    await assert.rejects(inspectPackageArchive(f.archive), /lock path|another application or Codex/);
  }
});

test("npm/native hooks receive a private HOME and no provider credentials or npm override environment", () => {
  const env = buildEnvironment("/tmp/build-home", "/opt/node/bin/node", {
    CODEY_MODEL_API_KEY: "secret", COPILOT_API_GITHUB_TOKEN: "secret", CODEX_HOME: "/real/.codex",
    NODE_OPTIONS: "--require=/malicious", npm_config_prefix: "/real/global", npm_config_ignore_scripts: "true",
    HTTPS_PROXY: "https://proxy.example.test", PATH: "/untrusted", LANG: "C.UTF-8",
  });
  for (const name of ["CODEY_MODEL_API_KEY", "COPILOT_API_GITHUB_TOKEN", "CODEX_HOME", "NODE_OPTIONS", "npm_config_prefix"]) {
    assert.equal(env[name], undefined);
  }
  assert.equal(env.HOME, "/tmp/build-home");
  assert.equal(env.HTTPS_PROXY, "https://proxy.example.test");
  assert.ok(!env.PATH.includes("/untrusted"));
});
