import assert from "node:assert/strict";
import { chmod, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { buildToolUpdate } from "../scripts/build-tool-update.mjs";
import { inspectToolPackage, nativeToolHeader, stageToolPackage, toolPath, validateToolManifest } from "../packages/codey/lib/tool-update-package.mjs";
import { runToolUpdate, toolBaseline, toolUpdateOptions } from "../packages/codey/lib/tool-update.mjs";
import { appServerHandshake, assertTunnelConnected, isolatedToolEnvironment, probeTool, toolVersion } from "../packages/codey/lib/tool-update-probe.mjs";
import { atomicWrite, exists, fileHash, readJson } from "../packages/codey/lib/update-files.mjs";
import { runUpdate } from "../packages/codey/lib/update.mjs";
import { packageFixture, treeFiles, updateFixture } from "./codey-update-fixture.mjs";

function native(platform = "linux-x64", suffix = "") {
  const body = Buffer.alloc(128);
  if (platform === "linux-x64") {
    body.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]); body.writeUInt16LE(62, 18);
  } else {
    body.write("MZ"); body.writeUInt32LE(64, 60);
    body.set([0x50, 0x45, 0, 0], 64); body.writeUInt16LE(0x8664, 68);
  }
  return Buffer.concat([body, Buffer.from(suffix)]);
}

async function bundle(t, component = "codex", platform = "linux-x64") {
  const f = await updateFixture(t);
  const source = path.join(f.home, "reviewed vendor");
  const entry = component + (platform === "windows-x64" ? ".exe" : "");
  await mkdir(path.join(source, "support"), { recursive: true });
  await writeFile(path.join(source, entry), native(platform, component), { mode: 0o700 });
  await writeFile(path.join(source, "support/runtime.dat"), "retained companion");
  await writeFile(path.join(source, "support/empty"), "");
  const built = await buildToolUpdate({ component, platform, version: "0.154.0", source, output: path.join(f.home, "tool bundle") });
  return { ...f, built, entry, source, component, platform };
}

function dependencies(f) {
  const commands = [];
  const plan = {
    kind: "linux-tool", component: f.component, root: f.old, node: process.execPath,
    jobsRoot: path.join(f.home, ".local/share/codey-updater/local-updates"),
    services: [f.component === "codex" ? "codey-cloudcli.service" : "codey-devtunnel.service"],
    anchor: path.join(f.home, ".local/bin", f.component), version: "0.153.0",
    host: { file: "/usr/bin/python3", prefix: ["-I", "-S", "-B"] },
  };
  return {
    commands, home: f.home, platform: "linux", arch: "x64", discover: async () => plan, log() {},
    command: async (file, args) => {
      commands.push([file, ...args]);
      if (file === plan.node) return '{"ok":true}';
      const action = args.at(-2), input = args.at(-1);
      const doc = await readJson(input);
      if (action === "apply") {
        await atomicWrite(path.join(doc.job, "local-update.json"),
          { kind: plan.kind, state: "complete", request: doc });
      }
      return '{"ok":true,"modelRequests":false}';
    },
  };
}

async function engineFixture(f) {
  await mkdir(path.join(f.old, "updater"));
  for (const name of ["engine.py", "probe.mjs"]) await writeFile(path.join(f.old, "updater", name), "fixture only");
}

const argsFor = (f, ...flags) => [f.component, f.built.manifest, "--sha256", f.built.sha256, ...flags];

test("native tool options are independent, explicit and fail closed for all/latest/installer/ambiguous actions", () => {
  assert.equal(toolUpdateOptions(["codex", "tool-update.json", "--sha256", "A".repeat(64), "--check"]).sha256, "a".repeat(64));
  assert.equal(toolUpdateOptions(["devtunnel", "tool-update.json", "--sha256", "a".repeat(64), "--check"]).allowDisconnect, undefined);
  for (const args of [
    ["all"], ["latest"], ["codex", "latest"], ["codex", "https://untrusted.test/tool.json"],
    ["codex", "setup.ps1"], ["codex", "tool.json"], ["codex", "tool.json", "--sha256", "bad"],
    ["codex", "tool.json", "--sha256", "a".repeat(64), "--allow-disconnect"],
    ["devtunnel", "tool.json", "--sha256", "a".repeat(64)],
    ["codex", "tool.json", "--sha256", "a".repeat(64), "--recover"],
    ["codex", "tool.json", "--sha256", "a".repeat(64), "--check", "--check"],
    ["codex", "tool.json", "--sha256", "a".repeat(64), "--installed-root", "relative"],
  ]) assert.throws(() => toolUpdateOptions(args), Error, args.join(" "));
  for (const version of ["0.1.3", "0.1.4", "0.2.0", "1.0.0"]) assert.equal(toolBaseline(version), true);
  for (const version of ["0.1.2", "0.0.5", "0.1.3-beta", "latest", null]) assert.equal(toolBaseline(version), false);
});

test("the tool builder binds the complete distribution without downloading, executing or publishing", async t => {
  const f = await bundle(t);
  assert.equal(f.built.files, 3);
  assert.equal(f.built.downloaded, false);
  assert.equal(f.built.executed, false);
  assert.equal(f.built.published, false);
  const artifact = await inspectToolPackage(f.built.manifest, f.built.sha256);
  const entry = await stageToolPackage(artifact, path.join(f.home, "private candidate"));
  assert.equal(await fileHash(entry), artifact.entrySha256);
  assert.equal(await readFile(path.join(path.dirname(entry), "support/runtime.dat"), "utf8"), "retained companion");
  await assert.rejects(buildToolUpdate({
    component: f.component, platform: f.platform, version: "0.154.0", source: f.source, output: path.dirname(f.built.manifest),
  }), /EEXIST/);
});

test("Windows native PE x64 payloads are accepted, but architecture, component and hashes are bound", async t => {
  const f = await bundle(t, "devtunnel", "windows-x64");
  const artifact = await inspectToolPackage(f.built.manifest, f.built.sha256, { component: "devtunnel", platform: "windows-x64" });
  assert.equal(artifact.manifest.entry, "devtunnel.exe");
  await assert.rejects(inspectToolPackage(f.built.manifest, f.built.sha256, { component: "codex" }), /component\/platform/);
  await assert.rejects(inspectToolPackage(f.built.manifest, f.built.sha256, { platform: "linux-x64" }), /component\/platform/);
  await assert.rejects(inspectToolPackage(f.built.manifest, "0".repeat(64)), /manifest SHA/);
  await assert.rejects(inspectToolPackage(f.built.manifest), /independent/);
  assert.equal(nativeToolHeader(native("windows-x64"), "linux-x64"), false);
  const wrong = native("windows-x64"); wrong.writeUInt16LE(0xaa64, 68);
  assert.equal(nativeToolHeader(wrong, "windows-x64"), false);
});

test("manifest validation rejects unsafe Windows/POSIX names, commands, collisions and oversized payloads", async t => {
  const f = await bundle(t);
  const good = await readJson(f.built.manifest);
  for (const name of ["../escape", "/root", "x\\y", "con.exe", "aux", "trailing.", "a//b", "a:b", "a?b", "a*b", "a|b", "a\u0000b"]) {
    assert.throws(() => toolPath(name), /unsafe/, name);
  }
  for (const change of [
    { command: "install" }, { platform: "windows-arm64" }, { minimumCodeyVersion: "0.1.2" }, { entry: "../codex" },
    { files: { ...good.files, CODEX: good.files.codex } },
    { files: { ...good.files, "support": good.files.codex } },
    { files: { ...good.files, codex: { ...good.files.codex, size: 2 ** 32 } } },
    { files: { ...good.files, codex: { ...good.files.codex, executable: false } } },
  ]) assert.throws(() => validateToolManifest({ ...good, ...change }), /Invalid tool/);
});

test("extra/missing/tampered companions and a source changed after review are refused", async t => {
  const f = await bundle(t);
  const artifact = await inspectToolPackage(f.built.manifest, f.built.sha256);
  const companion = path.join(artifact.root, "support/runtime.dat");
  const original = await readFile(companion);
  await writeFile(companion, "tampered");
  await assert.rejects(inspectToolPackage(f.built.manifest, f.built.sha256), /checksum/);
  await assert.rejects(stageToolPackage(artifact, path.join(f.home, "candidate")), /checksum/);
  assert.equal(await exists(path.join(f.home, "candidate")), false);
  await writeFile(companion, original);
  await writeFile(path.join(artifact.root, "unreviewed.dll"), "unexpected");
  await assert.rejects(inspectToolPackage(f.built.manifest, f.built.sha256), /unexpected/);
  await rm(path.join(artifact.root, "unreviewed.dll"));
  await rm(companion);
  await assert.rejects(inspectToolPackage(f.built.manifest, f.built.sha256), /missing/);
});

test("linked native payloads and script launchers are never adopted as native executables", { skip: process.platform === "win32" }, async t => {
  const f = await bundle(t);
  const artifact = await inspectToolPackage(f.built.manifest, f.built.sha256);
  const entry = path.join(artifact.root, f.entry);
  await rm(entry);
  await symlink(path.join(f.source, f.entry), entry);
  await assert.rejects(inspectToolPackage(f.built.manifest, f.built.sha256), /linked/);
  await rm(entry);
  await writeFile(entry, "#!/bin/sh\necho unreviewed\n");
  assert.equal(nativeToolHeader(await readFile(entry), "linux-x64"), false);
  await assert.rejects(buildToolUpdate({ component: "codex", platform: "linux-x64", version: "1.0.0",
    source: artifact.root, output: path.join(f.home, "script-bundle") }), /native x64/);
});

test("--check on the new named route does not stage, execute the candidate, stop services or write a journal", async t => {
  const f = await bundle(t);
  await packageFixture(f.old, "0.1.3");
  const deps = dependencies(f);
  const before = await treeFiles(f.home);
  const result = await runUpdate(f.old, argsFor(f, "--check"), { ...deps, toolDependencies: deps });
  assert.equal(result.toVersion, "0.154.0");
  assert.equal(result.fromVersion, "0.153.0");
  assert.equal(result.component, "codex");
  assert.equal(result.codeyVersion, "0.1.3");
  assert.equal(result.candidateExecuted, false);
  assert.equal(result.serviceChanges, false);
  assert.equal(deps.commands.length, 0);
  assert.deepEqual(await treeFiles(f.home), before);
});

test("an installed pre-0.1.3 Codey fails before tool discovery or any write", async t => {
  const f = await bundle(t);
  await packageFixture(f.old, "0.1.2");
  const before = await treeFiles(f.home);
  await assert.rejects(runToolUpdate(f.old, argsFor(f, "--check"), {
    ...dependencies(f), discover: () => assert.fail("Do not inspect tools on an unsupported baseline"),
  }), /at least stable 0.1.3/);
  assert.deepEqual(await treeFiles(f.home), before);
});

test("new tool activation retains full payload, original runtimes, shared recovery helpers and one component scope", async t => {
  const f = await bundle(t);
  await engineFixture(f);
  const deps = dependencies(f);
  const before = await treeFiles(f.old);
  const result = await runToolUpdate(f.old, argsFor(f), deps);
  assert.equal(result.ok, true);
  assert.equal(result.modelRequests, false);
  assert.deepEqual(result.services, ["codey-cloudcli.service"]);
  assert.equal(await exists(path.join(result.job, "payload/support/runtime.dat")), true);
  assert.equal(await exists(path.join(result.job, "tool-update-service.py")), true);
  assert.equal(await exists(path.join(result.job, "update-service.py")), true);
  assert.equal(await fileHash(path.join(result.job, "tool-update.json")), f.built.sha256);
  assert.deepEqual(await treeFiles(f.old), before);
  assert.equal(deps.commands.length, 2, "Only the existing Node probe and native adapter are invoked, never npm/setup/installers");
  assert.equal(await exists(path.join(f.home, ".local/share/codey-local-update/lock")), false);
});

test("DevTunnel requires explicit disconnect consent, not just an implicit tool update", async t => {
  const f = await bundle(t, "devtunnel");
  await engineFixture(f);
  const deps = dependencies(f);
  await assert.rejects(runToolUpdate(f.old, argsFor(f), deps), /--allow-disconnect/);
  assert.equal(deps.commands.length, 0);
  const result = await runToolUpdate(f.old, argsFor(f, "--allow-disconnect"), deps);
  assert.equal(result.disconnectsTunnel, true);
  assert.deepEqual(result.services, ["codey-devtunnel.service"]);
});

test("candidate probe failure never activates a tool and leaves no live transaction lock", async t => {
  const f = await bundle(t);
  await engineFixture(f);
  const deps = dependencies(f);
  await assert.rejects(runToolUpdate(f.old, argsFor(f), {
    ...deps, command: async (file) => { assert.equal(file, process.execPath); throw new Error("fixture protocol incompatible"); },
  }), /protocol incompatible/);
  assert.equal(await exists(path.join(f.home, ".local/share/codey-local-update/active.json")), false);
  assert.equal(await exists(path.join(f.home, ".local/share/codey-local-update/lock")), false);
});

test("Codey and tool transactions share a lock and --recover dispatches the retained tool helper", async t => {
  const f = await bundle(t);
  await engineFixture(f);
  const deps = dependencies(f);
  await assert.rejects(runToolUpdate(f.old, argsFor(f), {
    ...deps, command: async (file, args) => {
      if (file === process.execPath) return '{"ok":true}';
      const request = await readJson(args.at(-1));
      await atomicWrite(path.join(request.job, "local-update.json"), { kind: "linux-tool", state: "applying", request });
      throw new Error("fixture interrupted native switch");
    },
  }), /--recover/);
  await assert.rejects(runToolUpdate(f.old, argsFor(f), deps), /running or interrupted/);
  const activeFile = path.join(f.home, ".local/share/codey-local-update/active.json");
  const active = await readJson(activeFile);
  await atomicWrite(activeFile, { ...active, pid: 99999999 });
  const result = await runUpdate(f.old, ["--recover"], {
    ...deps, command: async (file, args) => {
      assert.equal(file, "/usr/bin/python3");
      assert.ok(args.some(arg => arg.endsWith("tool-update-service.py")));
      assert.equal(args.at(-2), "recover");
      return '{"ok":true,"recovered":"rolled_back"}';
    },
  });
  assert.equal(result.recovered, "rolled_back");
  assert.equal(await exists(activeFile), false);
});

test("unknown/global/Desktop installations are not silently adopted as tool-managed nodes", async t => {
  const f = await bundle(t);
  await assert.rejects(runToolUpdate(f.old, argsFor(f, "--check"), { home: f.home, log() {} }), /existing owner-managed/);
});

test("native tool version checks match exact CLI/app-server distribution and four-part DevTunnel versions", () => {
  assert.equal(toolVersion("codex-cli 0.154.0\n", "codex"), "0.154.0");
  assert.equal(toolVersion("devtunnel 1.0.1447.0+abcdef\n", "devtunnel"), "1.0.1447.0+abcdef");
  for (const text of ["app-server 0.154.0", "anything 0.154.0", "codex-cli latest"]) assert.throws(() => toolVersion(text, "codex"));
});

test("probe environments cannot inherit provider credentials, real Codex HOME, hooks or proxy settings", () => {
  const env = isolatedToolEnvironment("/private/probe", process.execPath, {
    CODEX_HOME: "/real/codex", OPENAI_API_KEY: "private", CODEY_MODEL_API_KEY: "private",
    NODE_OPTIONS: "--require=unreviewed", HTTPS_PROXY: "private-proxy", HOME: "/real/home",
  });
  assert.equal(env.HOME, "/private/probe");
  assert.equal(env.CODEX_HOME, "/private/probe/.codex");
  for (const name of ["OPENAI_API_KEY", "CODEY_MODEL_API_KEY", "NODE_OPTIONS", "HTTPS_PROXY"]) assert.equal(env[name], undefined);
});

test("tunnel connectivity checks bind the existing ID/cluster and require a single connected host", () => {
  for (const count of [1, { current: 1, limit: 1 }]) {
    assert.equal(assertTunnelConnected({ tunnel: { tunnelId: "fixture", clusterId: "jpe", status: { hostConnectionCount: count } } },
      "fixture.jpe").connected, true);
  }
  for (const change of [
    { tunnelId: "another" }, { clusterId: "eus" }, { status: { hostConnectionCount: 0 } },
    { status: { hostConnectionCount: 2 } }, { status: {} },
  ]) assert.throws(() => assertTunnelConnected({
    tunnelId: "fixture", clusterId: "jpe", status: { hostConnectionCount: 1 }, ...change,
  }, "fixture.jpe"), /original DevTunnel/);
});

async function fakeCodex(f, loaded = 0) {
  const file = path.join(f.home, "protocol-fixture");
  await writeFile(file, `#!/usr/bin/env node
import fs from 'node:fs';
import readline from 'node:readline';
if (process.argv.includes('--version')) { console.log('codex-cli 0.154.0'); process.exit(0); }
if (process.argv[2] !== 'app-server') process.exit(2);
const methods = [];
const rl = readline.createInterface({input:process.stdin});
rl.on('line', line => {
  const request = JSON.parse(line); methods.push(request.method);
  if (!['initialize','initialized','thread/loaded/list'].includes(request.method)) process.exit(3);
  if (request.id) console.log(JSON.stringify({id:request.id,result: request.id === 1 ? {userAgent:'fixture'} : {data:Array(${loaded}).fill('active')}}));
});
rl.on('close', () => {
  fs.writeFileSync(process.env.HOME + '/methods.json', JSON.stringify(methods));
  process.exit(0);
});`, { mode: 0o700 });
  await chmod(file, 0o700);
  return file;
}

test("Codex protocol probe initializes the new app-server in an isolated HOME without a thread/prompt/model", {
  skip: process.platform === "win32",
}, async t => {
  const f = await bundle(t);
  const file = await fakeCodex(f);
  const job = path.join(f.home, "probe job");
  await mkdir(job);
  const result = await probeTool({ component: "codex", candidate: file, version: "0.154.0", job, plan: { node: process.execPath } });
  assert.equal(result.appServer, true);
  assert.equal(result.modelRequests, false);
  assert.deepEqual(await readJson(path.join(job, "tool-probe-home/methods.json")), ["initialize", "initialized", "thread/loaded/list"]);
  await assert.rejects(probeTool({ component: "codex", candidate: file, version: "0.155.0", job, plan: { node: process.execPath } }), /version differs/);
});

test("Codex protocol rejection and timeout clean up only the isolated probe", { skip: process.platform === "win32" }, async t => {
  const f = await bundle(t);
  const file = await fakeCodex(f, 1);
  await assert.rejects(appServerHandshake(file, {
    env: isolatedToolEnvironment(f.home, process.execPath), cwd: f.home, timeout: 3000,
  }), /protocol compatibility/);
  await writeFile(file, "#!/usr/bin/env node\nprocess.stdin.resume(); setInterval(()=>{}, 1000);\n");
  await assert.rejects(appServerHandshake(file, {
    env: isolatedToolEnvironment(f.home, process.execPath), cwd: f.home, timeout: 100,
  }), /protocol compatibility/);
});
