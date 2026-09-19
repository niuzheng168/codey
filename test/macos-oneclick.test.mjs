import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Installer, installOptions, macPortPreflight, modelConfiguration, readPackage } from "../skills/config-new-codey-machine/scripts/install-macos.mjs";
import { COMPONENTS, agentDefinition, checkedPath, command, digest, label, plist, readPrivate, runtime, supervise, writePrivate } from "../skills/config-new-codey-machine/scripts/macos-service.mjs";
import { registrationDocument, writeRegistration } from "../skills/config-new-codey-machine/scripts/registration.mjs";
import { machineFixture as fixture } from "./helpers/machine-installer-fixture.mjs";
import { treeFiles } from "./codey-update-fixture.mjs";
import { reuseMacCodex } from "../skills/config-new-codey-machine/scripts/macos-tools.mjs";
import { directory, run } from "../skills/config-new-codey-machine/scripts/machine-common.mjs";

const execute = promisify(execFile);
const hash = value => createHash("sha256").update(value).digest("hex");
const source = fileURLToPath(new URL("../skills/config-new-codey-machine", import.meta.url));
const nativeTest = (name, fn) => test(name, { skip: process.platform === "win32" }, fn);
const jsonFile = async file => JSON.parse(await readFile(file, "utf8"));
const target = "macos-arm64", computer = "fixture-mac";


test("Mac CLI distinguishes read-only checks, approved apply and invalid flags", () => {
  assert.deepEqual(installOptions([]), {});
  assert.deepEqual(installOptions(["--check"]), { check: true });
  for (const args of [["--check", "--apply"], ["--apply", "--apply"], ["--codex-home"], ["--unknown"]]) {
    assert.throws(() => installOptions(args));
  }
  assert.deepEqual(installOptions(["--help"]), { help: true });
});

nativeTest("Mac package preflight needs no Python and checks all bundled hashes and public metadata", async t => {
  const f = await fixture(t);
  assert.equal((await readPackage(f.skill, target)).setup.platform, target);
  const before = await treeFiles(f.home);
  await f.installer.apply({ "codex-home": f.options["codex-home"], check: true });
  assert.deepEqual(await treeFiles(f.home), before);
  assert.deepEqual(f.calls.map(call => call.file), ["/usr/sbin/sysctl", "/bin/launchctl", "/usr/sbin/ioreg"],
    "Only read-only native architecture/session queries; no downloads, writes or model requests");
  await writeFile(path.join(f.assets, "codey-0.1.16.tgz"), "tampered");
  await assert.rejects(readPackage(f.skill, target), /checksum mismatch/);
});

test("Mac port preflight allows empty ports and exact owner Codey processes without stopping anything", async () => {
  const previous = { ownerUid: 501, nodeExe: "/Users/owner's home 中文/node", codeyDirectory: "/Users/owner's home 中文/codey",
    codeyBin: "/Users/owner's home 中文/codey/bin/codey.mjs" };
  for (const port of [3001, 4141, 8443]) {
    let binds = 0;
    const free = await macPortPreflight(port, null, {
      uid: 501, execute: async () => ({ code: 1, stdout: "", stderr: "" }),
      bind: async number => { assert.equal(number, port); binds++; },
    });
    assert.deepEqual(free, { port, status: "free" });
    assert.equal(binds, 1);
    const entries = port === 3001 ? [path.join(previous.codeyDirectory, "lib/workspace.mjs"),
      `${previous.codeyBin} workspace --host 127.0.0.1 --port 3001`] :
      [`${previous.codeyBin} copilot start --host 127.0.0.1 --port 4141`,
        `${previous.codeyBin} gateway start --headless --host 127.0.0.1 --port 4141`];
    for (const entry of entries) {
      const calls = [];
      const owned = await macPortPreflight(port, previous, { uid: 501, bind: async () => assert.fail("Must not bind over Codey"),
        execute: async (file, args, options) => {
          calls.push({ file, args });
          if (file.endsWith("/ps")) assert.equal(options.env.LC_ALL, "en_US.UTF-8");
          const stdout = file.endsWith("lsof") ? `p123\nu501\nf20\nn127.0.0.1:${port}\nf21\nn[::1]:${port}\n` :
            args.at(-1) === "uid=" ? "501\n" : args.at(-1) === "comm=" ? previous.nodeExe + "\n" :
              `${previous.nodeExe} ${entry}\n`;
          return { code: 0, stdout, stderr: "" };
        } });
      assert.deepEqual(owned, { port, status: "owned-codey", pids: [123] });
      assert.deepEqual(calls.map(call => call.file), ["/usr/sbin/lsof", "/bin/ps", "/bin/ps", "/bin/ps"]);
    }
  }
});

test("Mac preflight requires the exact private CloudCLI entry, without extra arguments or another script", async () => {
  const previous = { ownerUid: 501, nodeExe: "/Users/owner/node", codeyDirectory: "/Users/owner/codey",
    codeyBin: "/Users/owner/codey/bin/codey.mjs" };
  const worker = path.join(previous.codeyDirectory, "lib/workspace.mjs");
  for (const command of [
    `${previous.nodeExe} ${worker} --host 127.0.0.1`,
    `${previous.nodeExe} ${worker}.other`,
    `${previous.nodeExe} ${previous.codeyBin} ${worker}`,
    `${previous.nodeExe} -e '${worker}'`,
  ]) {
    await assert.rejects(macPortPreflight(3001, previous, {
      uid: 501, execute: async (file, args) => ({ code: 0, stderr: "", stdout:
        file.endsWith("lsof") ? "p123\nu501\nn127.0.0.1:3001\n" :
          args.at(-1) === "uid=" ? "501" : args.at(-1) === "comm=" ? previous.nodeExe : command }),
    }), /foreign or unverified/);
  }
});

test("Mac port preflight rejects unknown owners, wildcard/foreign addresses, spoofed paths and unreadable processes", async () => {
  const previous = { ownerUid: 501, nodeExe: "/Users/owner/node", codeyDirectory: "/Users/owner/codey",
    codeyBin: "/Users/owner/codey/bin/codey.mjs" };
  const proper = `${previous.nodeExe} ${previous.codeyBin} copilot start --host 127.0.0.1 --port 4141`;
  for (const changed of [
    { previous: null }, { owner: 502 }, { owner: "" }, { address: "*:4141" }, { address: "192.168.1.2:4141" },
    { comm: "/Users/owner/other-node" }, { args: proper + " --eval malicious" },
    { args: `${previous.nodeExe} /tmp/other.mjs "${previous.codeyBin}" copilot start` }, { processCode: 1 },
    { lsofCode: 2 }, { lsofStderr: "permission denied" },
  ]) {
    await assert.rejects(macPortPreflight(4141, Object.hasOwn(changed, "previous") ? changed.previous : previous, {
      uid: 501, bind: async () => assert.fail("Must not rebind an occupied port"),
      execute: async (file, args) => {
        if (file.endsWith("lsof")) return { code: changed.lsofCode ?? 0, stderr: changed.lsofStderr ?? "",
          stdout: `p123\nu${changed.owner ?? 501}\nf20\nn${changed.address ?? "127.0.0.1:4141"}\n` };
        return { code: changed.processCode ?? 0, stderr: "", stdout:
          args.at(-1) === "uid=" ? "501" : args.at(-1) === "comm=" ? changed.comm ?? previous.nodeExe : changed.args ?? proper };
      },
    }), /installation stopped/);
  }
  await assert.rejects(macPortPreflight(8443, null, {
    uid: 501, execute: async () => ({ code: 1, stdout: "", stderr: "" }),
    bind: async () => { throw new Error("hidden foreign listener"); },
  }), /hidden foreign listener/);
});

test("Mac's bind fallback detects a real listener hidden from the process listing", async t => {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { if (server.listening) server.close(); });
  const port = server.address().port;
  const options = { uid: 501, execute: async () => ({ code: 1, stdout: "", stderr: "" }) };
  await assert.rejects(macPortPreflight(port, null, options), /occupied or cannot be inspected/);
  await new Promise(resolve => server.close(resolve));
  assert.deepEqual(await macPortPreflight(port, null, options), { port, status: "free" });
});

nativeTest("Mac bootstrap without Node previews without downloads, Python, or filesystem changes", async t => {
  const f = await fixture(t), bin = path.join(f.temp, "bootstrap-bin");
  await mkdir(bin);
  for (const [name, body] of Object.entries({
    uname: 'printf "Darwin\\n"', id: `printf "${process.getuid()}\\n"`, hostname: `printf "${computer}\\n"`,
  })) await writeFile(path.join(bin, name), "#!/bin/sh\n" + body + "\n", { mode: 0o700 });
  await symlink("/usr/bin/dirname", path.join(bin, "dirname"));
  const invoke = args => execute("/bin/bash", [path.join(f.skill, "scripts/install-macos.sh"), ...args],
    { env: { HOME: f.home, PATH: bin }, timeout: 10000 });
  const before = await treeFiles(f.home);
  assert.match((await invoke(["--check"])).stdout, /Full package preflight requires Node/);
  await assert.rejects(invoke(["--check", "--apply"]), /cannot be combined/);
  await assert.rejects(invoke(["--apply", "--expected-computer", computer]), /Apply requires/);
  assert.deepEqual(await treeFiles(f.home), before);
});

nativeTest("interrupting an installer command terminates its owned child instead of leaving a detached install running", async t => {
  const f = await fixture(t), pidFile = path.join(f.temp, "child.pid"), controller = path.join(f.temp, "controller.mjs");
  const module = pathToFileURL(path.join(source, "scripts/macos-service.mjs")).href;
  const childCode = `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(()=>{},1000);`;
  await writeFile(controller, `import {run} from ${JSON.stringify(module)};
try { await run(process.execPath, ["-e", ${JSON.stringify(childCode)}], {timeout:10000}); }
catch { process.exitCode=1; }\n`);
  const child = spawn(process.execPath, [controller], { stdio: "ignore" });
  t.after(() => child.kill("SIGKILL"));
  const exited = once(child, "exit");
  let pid;
  for (let i = 0; i < 100; i++) {
    try { pid = Number(await readFile(pidFile, "utf8")); break; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(pid, "The isolated child must start before interruption");
  child.kill("SIGTERM");
  assert.equal((await exited)[0], 1);
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

nativeTest("Mac rejects private setup metadata, wrong architecture, unapproved or wrong-machine apply without writes", async t => {
  const f = await fixture(t), before = await treeFiles(f.home);
  for (const extra of [{ "network-approved": false }, { "expected-computer": "another-mac" }]) {
    await assert.rejects(f.installer.apply({ ...f.options, ...extra }), /Apply requires/);
  }
  assert.throws(() => new Installer(f.skill, { platform: "darwin", arch: "ia32" }), /native platform/);
  await writePrivate(path.join(f.assets, "setup.json"), { ...f.setup, credential: "must-not-ship" });
  await f.refreshSums();
  await assert.rejects(readPackage(f.skill, target), /public setup metadata/);
  assert.deepEqual(await treeFiles(f.home), before);
});

nativeTest("Mac respects foreign directories, symlinks and existing Codex configuration before downloading", async t => {
  const f = await fixture(t), codex = f.options["codex-home"];
  await mkdir(codex, { mode: 0o700 });
  await writeFile(path.join(codex, "config.toml"), "my original config", { mode: 0o600 });
  await assert.rejects(f.installer.apply(f.options), /--replace-existing/);
  await rm(codex, { recursive: true });
  await symlink(f.temp, codex);
  await assert.rejects(f.installer.preflight(f.options), /linked/);
  await rm(codex);
  await mkdir(f.installer.configRoot, { recursive: true, mode: 0o700 });
  await writePrivate(path.join(f.installer.configRoot, "foreign.json"), { important: true });
  await assert.rejects(f.installer.apply(f.options), /not owned by this installer/);
  assert.ok(f.calls.every(call => call.file !== "/usr/bin/curl"));
});

nativeTest("complete Mac installation exports node-only credentials and starts only three Node-backed LaunchAgents", async t => {
  const f = await fixture(t);
  const config = await f.installer.apply(f.options);
  assert.equal(config.workerRuntime, "node");
  assert.equal(config.pythonExe, undefined);
  assert.equal(config.updater, undefined);
  const registration = await readPrivate(path.join(f.home, "codey-machine-registration.json"));
  assert.equal(registration.credentials.updaterCredential, undefined);
  assert.equal(registration.machine.platform, target);
  assert.equal(Object.keys(registration.credentials).length, 5);
  assert.ok(!JSON.stringify(registration).includes(config.modelKey));
  const launcher = await readFile(path.join(f.home, ".local/bin/codey"), "utf8");
  assert.match(launcher, /macos-service\.mjs/);
  assert.doesNotMatch(launcher, /python|\.py(?:['"]|\s)/i);
  assert.deepEqual(f.calls.filter(call => call.args[0] === "bootstrap").map(call => path.basename(call.args[2]).split(".").at(-2)),
    COMPONENTS);
  assert.ok(f.calls.some(call => call.args[0] === "exec"));
  assert.ok(f.calls.some(call => call.args[1] === "sdk-probe"));
  assert.equal((await runtime(f.installer.file, { home: f.home, worker: config.workerPath })).nodeId, config.nodeId);
});

nativeTest("same-release Mac rerun retains keys/certificate/session files and does not reinstall or invoke models", async t => {
  const f = await fixture(t), config = await f.installer.apply(f.options);
  const certificate = await readFile(config.certificate), identity = await readPrivate(config.identityFile);
  const session = path.join(config.codexHome, "auth.json");
  await writePrivate(session, { preserved: "fixture session" });
  f.calls.length = 0;
  await f.installer.apply(f.options);
  assert.deepEqual(await readFile(config.certificate), certificate);
  assert.deepEqual(await readPrivate(config.identityFile), identity);
  assert.deepEqual(await readPrivate(session), { preserved: "fixture session" });
  assert.ok(!f.calls.some(call => call.file === "/usr/bin/curl" || call.args[0] === "exec" ||
    call.args[1] === "sdk-probe" || call.args[1] === "copilot" && call.args[2] === "login" || call.args[0] === "bootstrap"));
  assert.deepEqual(f.calls.filter(call => call.args[0]?.endsWith("windows-runtime.mjs")).map(call => call.args[1]),
    ["registration"], "The export performs the live check; no duplicate standalone verification");
});

nativeTest("Mac retries npm without downloading Node again or accumulating failed application prefixes", async t => {
  const f = await fixture(t);
  f.failNpm = true;
  await assert.rejects(f.installer.apply(f.options), /npm failure/);
  const prepared = await readPrivate(path.join(f.installer.configRoot, "application.json"));
  await assert.rejects(stat(path.join(prepared.releaseDirectory, "app")), { code: "ENOENT" });
  f.failNpm = false;
  f.calls.length = 0;
  const config = await f.installer.apply({ ...f.options, "retry-failed": true });
  assert.equal(config.releaseDirectory, prepared.releaseDirectory);
  assert.equal(f.calls.filter(call => call.args[0]?.endsWith("install-runtime.mjs")).length, 1);
  assert.ok(!f.calls.some(call => call.args.at(-1) === f.pins.platforms[target].node.url));
  assert.equal((await readdir(path.join(f.installer.root, "releases"))).length, 1);
});

nativeTest("Mac retries failed tunnel authentication from the verified application checkpoint", async t => {
  const f = await fixture(t);
  f.failTunnel = true;
  await assert.rejects(f.installer.apply(f.options), /tunnel login failure/);
  await assert.rejects(stat(f.installer.file), { code: "ENOENT" });
  f.calls.length = 0;
  f.failTunnel = false;
  const config = await f.installer.apply({ ...f.options, "retry-failed": true });
  assert.ok(!f.calls.some(call => call.args[0]?.endsWith("install-runtime.mjs") ||
    [f.pins.platforms[target].node.url, f.pins.platforms[target].devTunnel.url].includes(call.args.at(-1))));
  assert.ok(f.calls.some(call => call.args[1] === "doctor" && call.args.includes("--runtime-only")));
  assert.equal((await readdir(path.join(config.runtimeRoot, "releases"))).length, 1);
});

nativeTest("Mac retries a failed model response without npm, any downloads, new keys or duplicate configuration backups", async t => {
  const f = await fixture(t);
  f.answer = "not a real accepted response";
  await assert.rejects(f.installer.apply(f.options), /response mismatch/);
  const previous = await readPrivate(f.installer.file);
  const cert = await readFile(previous.certificate);
  f.answer = "CODEY_CODEX_OK";
  f.calls.length = 0;
  const config = await f.installer.apply({ ...f.options, "retry-failed": true });
  assert.equal(config.nodeId, previous.nodeId);
  assert.equal(config.nodeExe, previous.nodeExe);
  assert.equal(config.modelKey, previous.modelKey);
  assert.deepEqual(await readFile(config.certificate), cert);
  assert.ok(!f.calls.some(call => call.file === "/usr/bin/curl" || call.file === "/bin/bash" ||
    call.args[0]?.endsWith("install-runtime.mjs")));
  assert.deepEqual((await readdir(config.codexHome)).sort(), ["config.toml", "models.json"]);
});

nativeTest("Mac refuses altered prepared Node, application, Codex companions and broken native dependencies", async t => {
  for (const changed of ["node", "application", "codex", "native"]) {
    const f = await fixture(t);
    f.answer = "wrong";
    await assert.rejects(f.installer.apply(f.options));
    const config = await readPrivate(f.installer.file);
    if (changed === "native") f.failNative = true;
    else {
      const file = changed === "node" ? config.nodeExe : changed === "application" ? config.codeyBin :
        path.join(path.dirname(await realpath(config.codexExe)), "codex-code-mode-host");
      await writeFile(file, "tampered");
    }
    f.calls.length = 0;
    await assert.rejects(f.installer.apply({ ...f.options, "retry-failed": true }));
    assert.ok(!f.calls.some(call => call.file === "/usr/bin/curl" || call.args[0] === "bootstrap"));
    await assert.rejects(stat(path.join(f.home, "codey-machine-registration.json")), { code: "ENOENT" });
  }
});

nativeTest("Mac reuses a signed complete standalone Codex privately and preserves its original files", async t => {
  const f = await fixture(t), original = path.join(f.home, ".codex/packages/standalone/releases/official");
  await f.createCodex(original);
  await symlink("releases/official", path.join(f.home, ".codex/packages/standalone/current"));
  const before = await treeFiles(original);
  const config = await f.installer.apply(f.options);
  assert.deepEqual(await treeFiles(original), before);
  assert.ok((await realpath(config.codexExe)).startsWith(path.join(f.installer.root, "codex-install/reused-")));
  assert.ok(!f.calls.some(call => call.file === "/bin/bash" || call.args.at(-1) === f.pins.codex.url));
  assert.ok(f.calls.some(call => call.file === "/usr/bin/codesign"));
  assert.ok(f.calls.some(call => call.args[0] === "exec") && f.calls.some(call => call.args[1] === "sdk-probe"));
});

nativeTest("Mac does not execute or copy a standalone Codex with an invalid OpenAI signature", async t => {
  const f = await fixture(t), original = path.join(f.home, ".codex/packages/standalone/releases/official");
  await f.createCodex(original);
  await symlink("releases/official", path.join(f.home, ".codex/packages/standalone/current"));
  f.badSignature = true;
  await assert.rejects(f.installer.apply(f.options), /signature/);
  assert.ok(!f.calls.some(call => call.file === path.join(original, "bin/codex") || call.args[0] === "bootstrap"));
});

nativeTest("Mac leaves an incompatible standalone Codex untouched and downloads the native version instead", async t => {
  const f = await fixture(t), original = path.join(f.home, ".codex/packages/standalone/releases/intel");
  await f.createCodex(original);
  const metadata = path.join(original, "codex-package.json");
  await writePrivate(metadata, { ...await readPrivate(metadata), target: "x86_64-apple-darwin" });
  await symlink("releases/intel", path.join(f.home, ".codex/packages/standalone/current"));
  const before = await treeFiles(original);
  await f.installer.apply(f.options);
  assert.deepEqual(await treeFiles(original), before);
  assert.ok(f.calls.some(call => call.file === "/bin/bash"));
  assert.ok(!f.calls.some(call => call.file === path.join(original, "bin/codex")));
});

nativeTest("Mac identity survives network hostname changes, but never another hardware UUID", async t => {
  const f = await fixture(t);
  f.answer = "wrong";
  await assert.rejects(f.installer.apply(f.options));
  const previous = await readPrivate(f.installer.file);
  f.installer.computer = "new-network-hostname";
  const options = { ...f.options, "expected-computer": f.installer.computer, "retry-failed": true };
  f.answer = "CODEY_CODEX_OK";
  const config = await f.installer.apply(options);
  assert.equal(config.nodeId, previous.nodeId);
  assert.equal(config.machineId, previous.machineId);
  f.installer.computer = "another-network";
  await f.installer.apply({ ...options, "expected-computer": f.installer.computer });
  f.machineId = "87654321-1234-1234-1234-123456789abc";
  await assert.rejects(f.installer.apply({ ...options, "expected-computer": f.installer.computer }), /migration/);
});

nativeTest("Mac stops on legacy configuration or a stale launcher before downloading anything", async t => {
  for (const legacy of ["config", "launcher"]) {
    const f = await fixture(t);
    if (legacy === "config") {
      const root = path.join(f.home, ".config/codey-machine");
      await mkdir(root, { recursive: true, mode: 0o700 });
      await writePrivate(path.join(root, "identity.json"), { legacy: true });
    } else {
      await mkdir(path.join(f.home, ".local/bin"), { recursive: true, mode: 0o700 });
      await symlink(path.join(f.home, "missing-old-runtime"), path.join(f.home, ".local/bin/codey"));
    }
    const snapshot = () => legacy === "config" ? treeFiles(f.home) : readlink(path.join(f.home, ".local/bin/codey"));
    const before = await snapshot();
    await assert.rejects(f.installer.apply(f.options), /[Ll]egacy|[Ss]tale/);
    assert.deepEqual(await snapshot(), before);
    assert.ok(!f.calls.some(call => call.file === "/usr/bin/curl"));
  }
});

test("fresh macOS login and interactive shells load the private model key without inheriting it", {
  skip: process.platform !== "darwin",
}, async t => {
  const f = await fixture(t), config = await f.installer.apply(f.options);
  const env = { HOME: f.home, ZDOTDIR: f.home, PATH: "/usr/bin:/bin", EXPECTED_KEY: config.modelKey };
  for (const args of [["-lc"], ["-ic"]]) {
    const result = await execute("/bin/zsh", [...args, '[[ "$CODEY_MODEL_API_KEY" == "$EXPECTED_KEY" ]] && print -r -- MODEL_ENV_OK'],
      { env, timeout: 10000 });
    assert.equal(result.stdout.trim(), "MODEL_ENV_OK");
  }
  assert.equal((await stat(path.join(f.installer.configRoot, "provider.env"))).mode & 0o777, 0o600);
  const resources = await readPrivate(path.join(f.installer.configRoot, "resources.json"));
  for (const name of [".profile", ".bashrc", ".zprofile", ".zshrc"]) {
    const file = path.join(f.home, name);
    assert.ok(!(await readFile(file, "utf8")).includes(config.modelKey));
    assert.ok(resources.modified.some(item => item.path === file && item.marker === "# >>> Codey model API >>>"));
  }
});

test("native Mac experiment copies and verifies the real official Codex without modifying the installed node", {
  skip: process.platform !== "darwin" || !process.env.CODEY_TEST_NATIVE_CODEX,
}, async t => {
  const home = await realpath(os.homedir());
  const temporary = await mkdtemp(path.join(home, ".codey-mac-tools-test-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const i = { home, target: `macos-${process.arch}`, root: path.join(temporary, "runtime"),
    configRoot: path.join(temporary, "config"), checked: file => checkedPath(file, home),
    directory: file => directory(file, home), read: readPrivate, write: writePrivate, run };
  await i.directory(i.configRoot);
  const config = { codexHome: path.join(home, ".codex"),
    codexExe: path.join(await i.directory(path.join(i.root, "codex-bin")), "codex") };
  const start = performance.now();
  assert.equal(await reuseMacCodex(i, config), true);
  const seconds = (performance.now() - start) / 1000;
  assert.ok(seconds < 180, "Verified Codex copy exceeds the three-minute budget");
  t.diagnostic(`Actual signed Codex reuse: ${seconds.toFixed(1)}s`);
  assert.equal(await reuseMacCodex(i, config), true);
});

nativeTest("Mac's final registration still refuses failed TLS/SSO after removing the duplicate verify call", async t => {
  const f = await fixture(t), config = await f.installer.apply(f.options);
  const output = path.join(f.home, "codey-machine-registration.json");
  await rm(output);
  f.calls.length = 0;
  f.failVerify = true;
  await assert.rejects(f.installer.apply(f.options), /TLS\/SSO failure/);
  assert.ok(!(await readdir(f.home)).includes("codey-machine-registration.json"));
  assert.equal((await readPrivate(config.identityFile)).nodeId, config.nodeId);
  assert.ok(!f.calls.some(call => call.args[0] === "bootstrap" || call.file === "/usr/bin/curl"));
});

test("the shared model template preserves spaces, Unicode, quotes and dollar sequences in catalog paths", async () => {
  const template = await readFile(path.join(source, "templates/codex-config.toml"), "utf8");
  assert.equal(template.split("__CODEY_MODEL_CATALOG__").length, 2);
  for (const models of ["/Users/owner's home 中文/$&/models.json", 'C:\\Users\\owner $` name\\models.json', '/tmp/"quoted"/models.json']) {
    const result = await modelConfiguration(models);
    const literal = /^model_catalog_json = (.+)$/m.exec(result)[1];
    assert.equal(JSON.parse(literal), models);
    assert.equal(result, template.replace("__CODEY_MODEL_CATALOG__", () => JSON.stringify(models)));
    assert.match(result, /base_url = "http:\/\/127\.0\.0\.1:4141"/);
  }
});

nativeTest("Mac checks every port even on a ready-node rerun and stops before downloads, writes or registration", async t => {
  const f = await fixture(t), config = await f.installer.apply(f.options), before = await treeFiles(f.home);
  const checked = [];
  f.calls.length = 0;
  f.installer.portCheck = async (port, previous) => {
    assert.equal(previous.nodeId, config.nodeId);
    checked.push(port);
    if (port === 8443) throw new Error("Port 8443 has a foreign listener");
    return { port, status: "owned-codey" };
  };
  await assert.rejects(f.installer.apply(f.options), /foreign listener/);
  assert.deepEqual(checked, [3001, 4141, 8443]);
  assert.deepEqual(await treeFiles(f.home), before);
  assert.ok(f.calls.every(call => ["/usr/sbin/sysctl", "/bin/launchctl", "/usr/sbin/ioreg"].includes(call.file)));
});

nativeTest("Mac refuses old Python descriptors, changed release/Codex home, and stale install locks without takeover", async t => {
  const f = await fixture(t), config = await f.installer.apply(f.options), before = await treeFiles(f.home);
  await assert.rejects(f.installer.apply({ ...f.options, "codex-home": path.join(f.home, "other-home") }), /differs/);
  for (const change of [{ workerRuntime: "python", pythonExe: "/usr/bin/python3" }, { releaseId: "machine-" + "b".repeat(16) }]) {
    await writePrivate(f.installer.file, { ...config, ...change });
    await assert.rejects(f.installer.apply(f.options), /explicit migration|differs/);
  }
  await writePrivate(f.installer.file, config);
  const lock = path.join(f.installer.configRoot, "install.lock");
  await mkdir(lock, { mode: 0o700 });
  await assert.rejects(f.installer.apply(f.options), /install.lock/);
  await rm(lock, { recursive: true });
  assert.deepEqual(await treeFiles(f.home), before);
});

nativeTest("failed Mac service startup preserves identity, stops only owned agents, and exports no registration", async t => {
  const f = await fixture(t);
  f.failBootstrap = "tunnel";
  await assert.rejects(f.installer.apply(f.options), /fixture LaunchAgent failure/);
  const config = await readPrivate(f.installer.file);
  assert.equal(config.ready, false);
  assert.equal(config.state, "failed");
  assert.equal((await readPrivate(config.identityFile)).nodeId, config.nodeId);
  assert.ok(!(await readdir(f.home)).includes("codey-machine-registration.json"));
  const stopped = f.calls.filter(call => call.args[0] === "bootout").map(call => call.args[1]);
  assert.deepEqual(stopped, ["tunnel", "codey"].map(component => f.installer.domain + "/" + label(config.nodeId, component)));
});

nativeTest("failed Mac TLS/SSO or real Codex response cannot be reported as installation success", async t => {
  for (const reason of ["health", "answer"]) {
    const f = await fixture(t);
    if (reason === "health") f.failVerify = true;
    else f.answer = "prompt contains CODEY_CODEX_OK but the final response is wrong";
    await assert.rejects(f.installer.apply(f.options));
    assert.equal((await readPrivate(f.installer.file)).ready, false);
    assert.ok(!(await readdir(f.home)).includes("codey-machine-registration.json"));
  }
});

nativeTest("Mac worker rejects tampered files and unsafe private path ownership", async t => {
  const f = await fixture(t), config = await f.installer.apply(f.options);
  await writeFile(config.workerPath, "tampered worker");
  await assert.rejects(runtime(f.installer.file, { home: f.home, worker: config.workerPath }), /fingerprint mismatch/);
  await chmod(f.installer.state, 0o777);
  await assert.rejects(checkedPath(config.identityFile, f.home), /writable/);
  await assert.rejects(checkedPath(f.home, f.home), /remain under/);
});

test("LaunchAgents and service commands use Node, preserve renewal and escape plist values", () => {
  const config = { nodeId: "n-" + "a".repeat(24), nodeExe: "/home/private/node", workerPath: "/home/private/worker.mjs",
    codeyBin: "/home/private/codey.mjs", runtimeRoot: "/home/a&b", stateRoot: "/home/private/state",
    devtunnelExe: "/home/private/devtunnel", helperPath: "/home/private/helper.mjs", qualifiedTunnel: "codey-node.jpe1" };
  for (const component of COMPONENTS) {
    const definition = agentDefinition(config, "/home/private/runtime.json", component);
    assert.equal(definition.ProgramArguments[0], config.nodeExe);
    assert.ok(!definition.ProgramArguments.some(arg => /python|\.py$/.test(arg)));
    assert.match(plist(definition).toString(), /a&amp;b/);
  }
  assert.equal(agentDefinition(config, "runtime.json", "renew").StartInterval, 21600);
  assert.deepEqual(command(config, "cli", "runtime.json", ["--version"]), [config.nodeExe, config.codeyBin, "--version"]);
  assert.equal(command(config, "codey", "runtime.json")[2], "start");
  assert.throws(() => label("untrusted/id", "codey"));
  assert.throws(() => plist({ invalid: "\0" }));
});

test("Mac Node worker forwards termination only to its own child process group", async () => {
  const child = new EventEmitter(), signals = new EventEmitter(), killed = [];
  child.pid = 1234;
  child.kill = signal => killed.push([child.pid, signal]);
  const config = { nodeExe: "/node", codeyBin: "/codey", runtimeRoot: "/home/private",
    environment: { MODEL_KEY: "fixture" }, baseEnvironment: {} };
  const pending = supervise(config, "codey", "runtime.json", [], {
    signals, kill: (pid, signal) => killed.push([pid, signal]),
    spawnProcess: (file, args, options) => {
      assert.equal(file, config.nodeExe);
      assert.equal(options.detached, true);
      assert.equal(options.shell, false);
      return child;
    },
  });
  signals.emit("SIGTERM");
  child.emit("exit", 0);
  assert.equal(await pending, 0);
  assert.ok(killed.length && killed.every(([pid, signal]) => pid === -1234 && signal === "SIGTERM"));
  assert.equal(signals.listenerCount("SIGTERM"), 0);
  assert.equal(signals.listenerCount("SIGINT"), 0);
});
