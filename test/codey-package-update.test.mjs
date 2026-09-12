import assert from "node:assert/strict";
import { cp, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { commandPlan } from "../packages/codey/lib/cli.mjs";
import { inspectUpdateArchive } from "../packages/codey/lib/update-archive.mjs";
import { buildEnvironment, exists, readJson, execute, fileHash, findNpm } from "../packages/codey/lib/update-files.mjs";
import {
  discoverInstallation, recoverStandalone, runUpdate, stagePackage, updateOptions,
} from "../packages/codey/lib/update.mjs";
import { fingerprint, jsonFile, packFixture, tarEntries, treeFiles, updateFixture } from "./codey-update-fixture.mjs";

const planFor = f => ({
  kind: "npm", root: f.old, node: process.execPath,
  jobsRoot: path.join(path.dirname(f.old), ".codey-local-updates"), services: [],
});
const command = async (_file, args) => args[0] === "-p" ? process.versions.node : '{"ok":true}';
const staged = f => async (_artifact, _plan, job) => {
  await mkdir(path.join(job, "build-home"));
  const root = path.join(job, "candidate");
  await cp(f.next, root, { recursive: true });
  return root;
};
const dependencies = f => ({
  home: f.home, discover: async () => planFor(f), stage: staged(f),
  command, idle: async () => {}, log() {},
});

test("update is an independent CLI branch; local-only options reject registry names, URLs and ambiguous actions", () => {
  assert.deepEqual(commandPlan(["update", "/tmp/codey.tgz", "--check"]), {
    kind: "update", args: ["/tmp/codey.tgz", "--check"],
  });
  assert.deepEqual(updateOptions(["--recover"]), { recover: true });
  assert.deepEqual(updateOptions(["--help"]), { help: true });
  assert.equal(updateOptions(["/tmp/new codey.tgz", "--check", "--sha256", "A".repeat(64)]).sha256, "a".repeat(64));
  for (const args of [
    [], ["codey"], ["codey@latest"], ["https://example.test/codey.tgz"], ["file:/tmp/codey.tgz"],
    ["/tmp/codey.tgz", "--force"], ["/tmp/codey.tgz", "--check", "--check"],
    ["/tmp/codey.tgz", "--sha256", "invalid"], ["/tmp/codey.tgz", "--recover"],
    ["--recover", "--check"], ["/tmp/a.tgz", "/tmp/b.tgz"], ["--help", "/tmp/a.tgz"],
    ["/tmp/a.tgz", "--installed-root"], ["/tmp/a.tgz", "--installed-root", "relative/path"],
    ["--recover", "--installed-root", "/tmp/codey"],
  ]) assert.throws(() => updateOptions(args), Error, args.join(" "));
});

test("archive inspection validates the local shared package without extracting or executing it", async t => {
  const f = await updateFixture(t);
  const before = [...(await treeFiles(f.home)).keys()];
  const artifact = await inspectUpdateArchive(f.archive);
  assert.equal(artifact.pkg.version, "2.0.0");
  assert.equal(artifact.sha256, await fileHash(f.archive));
  assert.ok(artifact.files.has("lib/update.mjs"));
  assert.deepEqual([...await treeFiles(f.home)].map(([name]) => name), before);
  await assert.rejects(inspectUpdateArchive(f.archive, "f".repeat(64)), /SHA-256 mismatch/);
  await writeFile(path.join(f.next, "gateway/main.js"), "tampered");
  await packFixture(f.next, f.archive);
  await assert.rejects(inspectUpdateArchive(f.archive), /fingerprints/);
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
    await assert.rejects(inspectUpdateArchive(f.archive), /Invalid Codey package/, extra.name);
  }
  await writeFile(f.archive, tarEntries([{ name: "package/package.json", body: "{}" }]));
  await assert.rejects(inspectUpdateArchive(f.archive), /missing/);
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
  await assert.rejects(inspectUpdateArchive(f.archive), /another application or Codex/);
});

test("unexpected global CLI aliases and application install hooks are refused before lifecycle execution", async t => {
  const f = await updateFixture(t);
  const file = path.join(f.next, "package.json");
  const original = await readJson(file);
  for (const change of [
    { bin: { ...original.bin, codex: "bin/codex.mjs" } },
    { scripts: { install: "node onboarding/install-tools.mjs" } },
    { scripts: { postinstall: "codey setup" } },
  ]) {
    await jsonFile(file, { ...original, ...change });
    await fingerprint(f.next);
    await packFixture(f.next, f.archive);
    await assert.rejects(inspectUpdateArchive(f.archive), /executable|install hook/);
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
    await assert.rejects(inspectUpdateArchive(f.archive), /lock path|another application or Codex/);
  }
});

test("--check is read-only and Node incompatibility is a blocker, not a toolchain upgrade", async t => {
  const f = await updateFixture(t);
  const before = await treeFiles(f.home);
  let stages = 0;
  const result = await runUpdate(f.old, [f.archive, "--check"], {
    ...dependencies(f), stage() { stages++; assert.fail("No installation in check mode"); },
  });
  assert.equal(result.mode, "check");
  assert.equal(result.toVersion, "2.0.0");
  assert.equal(result.serviceChanges, false);
  assert.equal(stages, 0);
  assert.deepEqual(await treeFiles(f.home), before);
  await assert.rejects(runUpdate(f.old, [f.archive, "--check"], {
    ...dependencies(f), command: async () => "20.0.0",
  }), /incompatible with existing Node/);
  assert.deepEqual(await treeFiles(f.home), before);
});

test("local update swaps only the npm application and retains all external components/configuration/data", async t => {
  const f = await updateFixture(t);
  const sentinels = new Map([
    [".codex/config.toml", "model and provider settings"], [".codex/auth.json", "private existing auth"],
    [".codex/sessions/one.jsonl", "session history"], [".local/bin/codex", "existing codex executable"],
    [".local/bin/devtunnel", "existing devtunnel"], [".cloudcli/auth.db", "existing user database"],
    [".config/codey-provider/config.json", "existing gateway key"],
  ]);
  for (const [name, body] of sentinels) {
    await mkdir(path.dirname(path.join(f.home, name)), { recursive: true });
    await writeFile(path.join(f.home, name), body);
  }
  const result = await runUpdate(f.old, [f.archive], dependencies(f));
  assert.equal(result.ok, true);
  assert.equal((await readJson(path.join(f.old, "package.json"))).version, "2.0.0");
  assert.equal((await readJson(path.join(result.job, "previous-codey/package.json"))).version, "1.0.0");
  assert.equal((await readJson(path.join(result.job, "local-update.json"))).state, "complete");
  assert.equal(result.modelRequests, false);
  assert.equal(result.serviceChanges, false);
  for (const [name, body] of sentinels) assert.equal(await readFile(path.join(f.home, name), "utf8"), body);
  assert.equal(await exists(path.join(f.home, ".local/share/codey-local-update/lock")), false);
});

test("identical builds are a no-op even when the tarball filename differs", async t => {
  const f = await updateFixture(t);
  await packFixture(f.old, f.archive);
  const before = await treeFiles(f.home);
  const result = await runUpdate(f.old, [f.archive], {
    ...dependencies(f), stage() { assert.fail("Unchanged packages must not be installed again"); },
  });
  assert.equal(result.unchanged, true);
  assert.deepEqual(await treeFiles(f.home), before);
});

test("a new CLI can explicitly bootstrap an old installed package without setup or changing the bootstrap copy", async t => {
  const f = await updateFixture(t);
  const bootstrap = await treeFiles(f.next);
  const result = await runUpdate(f.next, [f.archive, "--installed-root", f.old], dependencies(f));
  assert.equal(result.ok, true);
  assert.equal((await readJson(path.join(f.old, "package.json"))).version, "2.0.0");
  assert.deepEqual(await treeFiles(f.next), bootstrap);
});

test("historical installed metadata remains updatable without re-enabling its retired platform", async t => {
  const f = await updateFixture(t);
  const file = path.join(f.old, "codey-build.json");
  const old = await readJson(file);
  old.runtimePlatforms = ["linux-x64", "windows-x64", "macos-arm64"];
  await jsonFile(file, old);
  const result = await runUpdate(f.old, [f.archive], dependencies(f));
  assert.equal(result.ok, true);
  assert.equal((await readJson(path.join(f.old, "package.json"))).version, "2.0.0");
  assert.deepEqual((await readJson(path.join(result.job, "previous-codey/codey-build.json"))).runtimePlatforms,
    old.runtimePlatforms);
  await assert.rejects(runUpdate(f.old, [f.archive, "--check"], {
    ...dependencies(f), platform: "darwin", arch: "arm64",
  }), /supports Linux|support Linux/);
});

test("an old OS-specific npm installation can migrate its package without migrating tools/configuration", async t => {
  const f = await updateFixture(t);
  const file = path.join(f.old, "codey-build.json");
  const old = await readJson(file);
  delete old.runtimePlatforms;
  old.platform = process.platform === "win32" ? "windows-x64" : "linux-x64";
  await jsonFile(file, old);
  const result = await runUpdate(f.next, [f.archive, "--installed-root", f.old], dependencies(f));
  assert.equal(result.ok, true);
  assert.equal((await readJson(path.join(f.old, "package.json"))).version, "2.0.0");
  assert.equal((await readJson(path.join(result.job, "previous-codey/codey-build.json"))).platform, old.platform);
});

test("failed activation restores the old package but never stale user data", async t => {
  const f = await updateFixture(t);
  const data = path.join(f.home, "user-data.txt");
  await writeFile(data, "before");
  await assert.rejects(runUpdate(f.old, [f.archive], {
    ...dependencies(f), command: async (file, args, options) => {
      if (options?.log?.endsWith("doctor-active.private.log")) {
        await writeFile(data, "new data written after restart");
        throw new Error("synthetic native validation failed");
      }
      return command(file, args);
    },
  }), /synthetic native validation failed/);
  assert.equal((await readJson(path.join(f.old, "package.json"))).version, "1.0.0");
  assert.equal(await readFile(data, "utf8"), "new data written after restart");
  assert.equal(await exists(path.join(f.home, ".local/share/codey-local-update/active.json")), false);
});

test("busy nodes and staging failures never activate or overwrite the current package", async t => {
  const f = await updateFixture(t);
  const original = await readFile(path.join(f.old, "codey-build.json"));
  for (const overrides of [
    { idle: async () => { throw new Error("busy"); } },
    { stage: async () => { throw new Error("dependency installation failed"); } },
  ]) {
    await assert.rejects(runUpdate(f.old, [f.archive], { ...dependencies(f), ...overrides }));
    assert.deepEqual(await readFile(path.join(f.old, "codey-build.json")), original);
  }
});

test("a concurrent deployment during staging is not overwritten or rolled back", async t => {
  const f = await updateFixture(t);
  let changed;
  await assert.rejects(runUpdate(f.old, [f.archive], {
    ...dependencies(f), stage: async (...args) => {
      const root = await staged(f)(...args);
      const build = await readJson(path.join(f.old, "codey-build.json"));
      build.sourceCommit = "e".repeat(40);
      await jsonFile(path.join(f.old, "codey-build.json"), build);
      changed = await readFile(path.join(f.old, "codey-build.json"));
      return root;
    },
  }), /changed during staging/);
  assert.deepEqual(await readFile(path.join(f.old, "codey-build.json")), changed);
});

test("interrupted first-directory activation can be recovered without another install", async t => {
  const f = await updateFixture(t);
  const job = path.join(planFor(f).jobsRoot, "interrupted");
  await mkdir(job, { recursive: true, mode: 0o700 });
  const target = path.join(job, "candidate");
  await cp(f.next, target, { recursive: true });
  const request = {
    plan: planFor(f), job, candidate: target,
    previousEntrySha256: await fileHash(path.join(f.old, "codey-build.json")),
    entrySha256: await fileHash(path.join(f.next, "codey-build.json")),
  };
  const backup = path.join(job, "previous-codey");
  await rename(f.old, backup);
  const journal = { schema: 1, kind: "npm", state: "applying", backup, request };
  const result = await recoverStandalone(journal, f.home, async () => {});
  assert.equal(result.recovered, "rolled_back");
  assert.equal((await readJson(path.join(f.old, "package.json"))).version, "1.0.0");
  assert.equal((await readJson(path.join(target, "package.json"))).version, "2.0.0");
});

test("recovery refuses to overwrite an unrelated package pointer", async t => {
  const f = await updateFixture(t);
  const job = path.join(planFor(f).jobsRoot, "concurrent");
  await mkdir(job, { recursive: true, mode: 0o700 });
  const backup = path.join(job, "previous-codey");
  await cp(f.old, backup, { recursive: true });
  const journal = { state: "applying", backup, request: {
    job, plan: planFor(f), candidate: path.join(job, "candidate"),
    previousEntrySha256: await fileHash(path.join(backup, "codey-build.json")),
    entrySha256: await fileHash(path.join(f.next, "codey-build.json")),
  } };
  await assert.rejects(recoverStandalone(journal, f.home, async () => {}), /Another installation/);
  assert.equal((await readJson(path.join(f.old, "package.json"))).version, "1.0.0");
});

test("the recover command serializes recovery and clears only the finished transaction's state", async t => {
  const f = await updateFixture(t);
  const state = path.join(f.home, ".local/share/codey-local-update");
  await mkdir(path.join(state, "lock"), { recursive: true, mode: 0o700 });
  const job = path.join(planFor(f).jobsRoot, "interrupted-command");
  await mkdir(job, { recursive: true, mode: 0o700 });
  const target = path.join(job, "candidate"), backup = path.join(job, "previous-codey");
  await cp(f.next, target, { recursive: true });
  const request = {
    plan: planFor(f), job, candidate: target,
    previousEntrySha256: await fileHash(path.join(f.old, "codey-build.json")),
    entrySha256: await fileHash(path.join(f.next, "codey-build.json")),
  };
  await rename(f.old, backup);
  await jsonFile(path.join(job, "local-update.json"), { schema: 1, kind: "npm", state: "applying", request, backup });
  await jsonFile(path.join(state, "active.json"), { schema: 1, pid: 99999999, job });
  await jsonFile(path.join(state, "lock/owner.json"), { pid: 99999999 });
  await mkdir(path.join(state, "recovery.lock"), { mode: 0o700 });
  await assert.rejects(runUpdate(f.next, ["--recover"], dependencies(f)), /Another recovery/);
  assert.equal(await exists(f.old), false);
  await rm(path.join(state, "recovery.lock"), { recursive: true });
  const result = await runUpdate(f.next, ["--recover"], dependencies(f));
  assert.equal(result.recovered, "rolled_back");
  assert.equal((await readJson(path.join(f.old, "package.json"))).version, "1.0.0");
  for (const name of ["active.json", "lock", "recovery.lock"]) assert.equal(await exists(path.join(state, name)), false);
});

test("unrecognized managed installations cannot silently fall back to replacing a CLI-only copy", async t => {
  const f = await updateFixture(t);
  await mkdir(path.join(f.home, ".config/codey-machine"), { recursive: true });
  await assert.rejects(discoverInstallation(f.old, f.home, "linux", () => assert.fail("No services should be called")), /Incomplete managed/);
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

test("real npm staging and CLI update work in a disposable HOME without any model/native dependency", {
  timeout: 120000, skip: process.platform !== "linux",
}, async t => {
  const previousMask = process.umask(0o002);
  t.after(() => process.umask(previousMask));
  const f = await updateFixture(t);
  const result = await runUpdate(f.old, [f.archive], {
    ...dependencies(f), stage: stagePackage, command: execute,
  });
  assert.equal(result.ok, true);
  const output = await execute(process.execPath, [path.join(f.old, "bin/codey.mjs"), "--version"], {
    cwd: f.home, env: { ...process.env, HOME: f.home },
  });
  assert.equal(output, "codey 2.0.0");
  assert.match(await readFile(path.join(result.job, "npm-install.private.log"), "utf8"), /up to date/);
  assert.deepEqual(await readFile(path.join(f.old, "npm-shrinkwrap.json")),
    await readFile(path.join(f.next, "npm-shrinkwrap.json")), "npm ci must retain the exact reviewed lock");
  const doctor = await readJson(path.join(result.job, "doctor.private.log"));
  assert.equal(doctor.fixture, true, "This test must not claim real native-module/model validation");
  assert.ok(await exists(path.join(result.job, "previous-codey/bin/codey.mjs")));
  assert.equal((await stat(f.old)).mode & 0o022, 0, "The staged package must remain safe under a group-writable caller umask");
  const unchanged = await runUpdate(f.old, [f.archive], dependencies(f));
  assert.equal(unchanged.unchanged, true, "The new package must remain eligible for the next local update");
});

test("changed source archives fail before npm is started", async t => {
  const f = await updateFixture(t);
  const artifact = await inspectUpdateArchive(f.archive);
  await writeFile(f.archive, "replaced after inspection");
  const job = path.join(f.home, "stage-check");
  await mkdir(job);
  await assert.rejects(stagePackage(artifact, planFor(f), job, {
    command() { assert.fail("npm must not run"); }, npm: await findNpm(process.execPath),
  }), /source tarball changed/);
});
