import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { nativeClient, windowsShellEnvironment } from "../skills/config-new-codey-machine/scripts/windows-native-client.mjs";
import { Installer } from "../skills/config-new-codey-machine/scripts/install-machine.mjs";
import { windowsAdapter } from "../skills/config-new-codey-machine/scripts/platform-windows.mjs";
import { run } from "../skills/config-new-codey-machine/scripts/machine-common.mjs";
import { prepareUpdate } from "../packages/codey/lib/machine-update.mjs";
import { inspectPackageArchive } from "../packages/codey/lib/package-archive.mjs";
import { packageFixture, packFixture } from "./codey-update-fixture.mjs";

test("Windows PowerShell never inherits PowerShell Core module paths", () => {
  assert.deepEqual(windowsShellEnvironment({ PATH: "x", PSModulePath: "core", psmodulepath: "other" }), { PATH: "x" });
});

test("native dispatcher preserves empty/singleton arrays and refuses stale tasks before writes", {
  skip: process.platform !== "win32", timeout: 30000,
}, async () => {
  const { stdout } = await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-File",
    fileURLToPath(new URL("./windows-native-contract-fixture.ps1", import.meta.url)), "-Source",
    fileURLToPath(new URL("../skills/config-new-codey-machine/scripts", import.meta.url))],
  { env: windowsShellEnvironment(), timeout: 25000 });
  assert.match(stdout, /NATIVE_CONTRACT_OK/);
});

test("real 5.1 native pipe preserves JSON null, serializes calls and reports safe failures", {
  skip: process.platform !== "win32", timeout: 60000,
}, async t => {
  const root = await mkdtemp(path.join(os.userInfo().homedir, ".codey-native-pipe-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const native = fileURLToPath(new URL("../skills/config-new-codey-machine/scripts/windows-native.ps1", import.meta.url));
  const shell = path.join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe");
  const invoke = nativeClient(shell, native, { env: { ...process.env, PSModulePath: "invalid-Core-modules" }, idleMs: 50 });
  const owner = await invoke({ operation: "owner" });
  assert.equal(owner.Home.toLowerCase(), os.userInfo().homedir.toLowerCase());
  assert.equal(await invoke({ operation: "directory", file: root }), root);
  const file = path.join(root, "fixture.txt");
  assert.equal(await invoke({ operation: "write", file, bytes: Buffer.from("fixture").toString("base64") }), null);
  assert.equal(await readFile(file, "utf8"), "fixture");
  const start = performance.now();
  const paths = await Promise.all(Array.from({ length: 30 }, () => invoke({ operation: "path", file, private: true })));
  assert.deepEqual(paths, Array(30).fill(file));
  assert.ok(performance.now() - start < 15000, "Small native calls must reuse the host, not launch PowerShell 30 times");
  await assert.rejects(invoke({ operation: "unknown", secret: "DO_NOT_LOG_THIS" }),
    error => /unknown failed.*line \d+/.test(error.message) && !error.message.includes("DO_NOT_LOG_THIS"));
  assert.equal(await invoke({ operation: "path", file, private: true }), file);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(await invoke({ operation: "path", file, private: true }), file, "Idle host can restart");
});

test("Windows retries accept only the owner-managed official Codex junction", {
  skip: process.platform !== "win32", timeout: 30000,
}, async t => {
  const home = await mkdtemp(path.join(os.userInfo().homedir, ".codey-codex-junction-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const skill = fileURLToPath(new URL("../skills/config-new-codey-machine", import.meta.url));
  const native = path.join(skill, "scripts/windows-native.ps1");
  const invoke = nativeClient(path.join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"), native);
  await invoke({ operation: "directory", file: home });
  const i = new Installer(skill, { home, execute: async () => { throw new Error("No commands allowed"); },
    adapter: { checked: file => invoke({ operation: "path", file, private: false }) } });
  const release = path.join(i.root, "codex-install/packages/standalone/releases/fixture-win-x64/bin");
  await mkdir(release, { recursive: true });
  await writeFile(path.join(release, "codex.exe"), "fixture-not-executed");
  const bin = path.join(i.root, "codex-bin");
  await symlink(release, bin, "junction");
  assert.equal(await i.codexDirectory(), bin);
  await rm(bin);
  const foreign = path.join(home, "foreign");
  await mkdir(foreign);
  await symlink(foreign, bin, "junction");
  await assert.rejects(i.codexDirectory(), /official standalone release/);
});

test("native process arguments preserve multiline Node scripts and quoted data without a shell", {
  skip: process.platform !== "win32", timeout: 30000,
}, async () => {
  const native = fileURLToPath(new URL("../skills/config-new-codey-machine/scripts/windows-native.ps1", import.meta.url));
  const invoke = nativeClient(path.join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"), native);
  const values = ["", "two words", 'quoted"argument', "trailing\\", "\\\"",
    "line\nfeed", "carriage\rreturn", "both\r\nlines", "tab\tvalue", "& | > $() %PATH%"];
  const request = { operation: "run", executable: process.execPath,
    arguments: ["--input-type=commonjs", "-e", "const values = process.argv.slice(1);\r\nprocess.stdout.write(JSON.stringify(values));\n",
      "--", ...values],
    environment: {}, cwd: os.userInfo().homedir, timeout: 10,
    interactive: false, allowFailure: false, replaceEnvironment: false };
  const result = await invoke(request);
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), values);
  await assert.rejects(invoke({ ...request, arguments: ["-e", "process.exit(0)", "invalid\0argument"] }),
    error => /Windows native run failed/.test(error.message) && !error.message.includes("invalid"));
});

test("Windows update stages and verifies an offline package through the real native process bridge", {
  skip: process.platform !== "win32", timeout: 120000,
}, async t => {
  const home = os.userInfo().homedir;
  const root = await mkdtemp(path.join(home, ".codey-native-update-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const i = { home, configRoot: path.join(root, "config"), run,
    skill: fileURLToPath(new URL("../skills/config-new-codey-machine", import.meta.url)) };
  i.adapter = windowsAdapter(i);
  i.directory = file => i.adapter.directory(file);
  i.write = (file, value) => i.adapter.write(file, value);
  await i.directory(root);
  await i.directory(i.configRoot);
  const previous = await packageFixture(path.join(root, "previous"), "1.0.0");
  const next = await packageFixture(path.join(root, "next"), "2.0.0");
  await mkdir(path.join(previous, "node_modules"));
  const archive = await packFixture(next, path.join(root, "codey-2.0.0.tgz"));
  const artifact = await inspectPackageArchive(archive);
  const release = await i.directory(path.join(root, "staged"));
  const app = await prepareUpdate({ i, config: { nodeExe: process.execPath, codeyDirectory: previous } },
    artifact, release, { offline: true, reuse: true });
  assert.equal(app, path.join(release, "app"));
  assert.equal(JSON.parse(await readFile(path.join(app, "package.json"))).version, "2.0.0");
  assert.equal(JSON.parse(await readFile(path.join(previous, "package.json"))).version, "1.0.0");
});
