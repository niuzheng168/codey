import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { runDoctor, doctorOptions } from "../packages/codey/lib/doctor.mjs";
import { RUNTIME_PLATFORMS, readPackageInfo, runtimePlatform, validateRuntimeLock } from "../packages/codey/lib/package-info.mjs";
import { readInstalledPackageInfo } from "../packages/codey/lib/update-files.mjs";
import { installLauncher, installOptions, launcherContents, npmCandidates, npmPackageRoot, WINDOWS_PATH_SCRIPT } from "../scripts/install-codey-runtime.mjs";

const exec = promisify(execFile);
const digest = bytes => createHash("sha256").update(bytes).digest("hex");

async function fixture(t) {
  const home = await mkdtemp(path.join(os.tmpdir(), "codey-shared-runtime-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const root = path.join(home, "package with spaces");
  await mkdir(root);
  const pkg = { name: "codey", version: "0.1.1", type: "module", bin: { codey: "bin/codey.mjs" } };
  const lock = { name: pkg.name, version: pkg.version, lockfileVersion: 3, packages: {
    "": { name: pkg.name, version: pkg.version },
  } };
  await writeFile(path.join(root, "package.json"), JSON.stringify(pkg));
  const lockRaw = JSON.stringify(lock);
  await writeFile(path.join(root, "npm-shrinkwrap.json"), lockRaw);
  const entry = "// runtime entry fixture\n";
  for (const name of ["gateway/main.js", "dist-server/server/index.js", "bin/codey.mjs"]) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), name.startsWith("bin/") ? 'console.log("codey fixture");\n' : entry);
  }
  const build = { schema: 1, name: pkg.name, version: pkg.version, sourceCommit: "a".repeat(40),
    runtimePlatforms: RUNTIME_PLATFORMS, lockSha256: digest(lockRaw),
    workspaceEntrySha256: digest(entry), gatewayEntrySha256: digest(entry) };
  await writeFile(path.join(root, "codey-build.json"), JSON.stringify(build));
  return { root, home, pkg, lock, build };
}

test("one runtime manifest and fingerprint are shared by Linux, Windows and both Mac architectures", async t => {
  const f = await fixture(t);
  const reports = [];
  for (const [platform, arch] of [["linux", "x64"], ["win32", "x64"], ["darwin", "arm64"], ["darwin", "x64"]]) {
    let checks = 0;
    const report = await runDoctor(f.root, ["--json"], {
      platform, arch, nativeCheck: async root => { assert.equal(root, f.root); checks++; return { fixture: true }; },
      log: value => { assert.equal(JSON.parse(value).ok, true); },
    });
    assert.equal(checks, 1);
    assert.equal(report.serviceChanges, false);
    assert.equal(report.modelRequests, false);
    assert.deepEqual(report.runtimePlatforms, ["linux-x64", "windows-x64", "macos-arm64", "macos-x64"]);
    reports.push(report);
  }
  assert.equal(reports[0].entrySha256, reports[1].entrySha256);
  assert.equal(reports[0].lockSha256, reports[1].lockSha256);
  assert.equal(reports[1].platform, "windows-x64");
  assert.equal(reports[1].managedSetupSupported, false, "Runtime portability must not falsely claim Windows systemd setup");
  assert.deepEqual(reports.slice(2).map(report => report.platform), ["macos-arm64", "macos-x64"]);
  assert.ok(reports.slice(2).every(report => report.entrySha256 === reports[0].entrySha256 && !report.managedSetupSupported));
  assert.equal(runtimePlatform("win32", "x64"), "windows-x64");
  assert.throws(() => runtimePlatform("win32", "arm64"));
  assert.throws(() => runtimePlatform("darwin", "ia32"));
});

test("published Linux/Windows-only bytes remain valid, but cannot masquerade as a Mac release", async t => {
  const f = await fixture(t);
  const build = { ...f.build, runtimePlatforms: ["linux-x64", "windows-x64"] };
  await writeFile(path.join(f.root, "codey-build.json"), JSON.stringify(build));
  for (const platform of ["linux", "win32"]) assert.equal((await readPackageInfo(f.root, { platform, arch: "x64" })).pkg.version, f.pkg.version);
  for (const arch of ["arm64", "x64"]) {
    await assert.rejects(readPackageInfo(f.root, { platform: "darwin", arch }), /compatible with this platform/);
    await assert.rejects(readInstalledPackageInfo(f.root, { platform: "darwin", arch }));
  }
});

test("the original three-platform Apple Silicon installation can be read, not relabeled for Intel", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, "codey-build.json"),
    JSON.stringify({ ...f.build, runtimePlatforms: ["linux-x64", "windows-x64", "macos-arm64"] }));
  const installed = await readInstalledPackageInfo(f.root, { platform: "darwin", arch: "arm64" });
  assert.equal(installed.pkg.version, f.pkg.version);
  await assert.rejects(readInstalledPackageInfo(f.root, { platform: "darwin", arch: "x64" }));
});
test("doctor validates the package before native code and package-only mode never loads native modules", async t => {
  const f = await fixture(t);
  const nativeCheck = () => { throw new Error("Must not load native code"); };
  const result = await runDoctor(f.root, ["--package-only", "--json"], { nativeCheck, log() {} });
  assert.equal(result.native, null);
  await writeFile(path.join(f.root, "gateway/main.js"), "changed");
  await assert.rejects(runDoctor(f.root, [], { nativeCheck, log() {} }), /fingerprint mismatch/);
  for (const args of [["--json", "--json"], ["--port", "4141"], ["--package-only", "--package-only"]]) {
    assert.throws(() => doctorOptions(args));
  }
});

test("private feeds, missing integrity and OS-specific package identities cannot enter the shared runtime", async t => {
  const f = await fixture(t);
  const lock = structuredClone(f.lock);
  const good = { version: "1.0.0", resolved: "https://registry.npmjs.org/example/-/example-1.0.0.tgz", integrity: "sha512-YWJjZA==" };
  lock.packages["node_modules/example"] = good;
  validateRuntimeLock(f.pkg, lock);
  for (const changed of [
    { resolved: "https://ms-feed-25.pkgs.visualstudio.com/example.tgz" },
    { resolved: "file:C:/Users/builder/example.tgz" },
    { resolved: "https://user:secret@registry.npmjs.org/example.tgz" },
    { integrity: "" }, { link: true },
  ]) {
    lock.packages["node_modules/example"] = { ...good, ...changed };
    assert.throws(() => validateRuntimeLock(f.pkg, lock), /shared public npm lock/);
  }
  await writeFile(path.join(f.root, "codey-build.json"), JSON.stringify({ ...f.build, platform: "windows-x64" }));
  await assert.rejects(readPackageInfo(f.root), /shared Linux\/Windows/);
});

test("the universal installer accepts explicit local artifacts, not public package names or missing checksums", () => {
  const sha = "a".repeat(64);
  for (const file of ["/tmp/codey-0.1.1.tgz", "C:\\Users\\Example User\\codey-0.1.1.tgz"]) {
    assert.equal(installOptions(["--package", file, "--sha256", sha, "--check"]).check, true);
  }
  for (const args of [
    ["--package", "codey"], ["--package", "codey@0.1.1", "--sha256", sha],
    ["--package", "https://example.test/codey.tgz", "--sha256", sha],
    ["--package", "/tmp/codey.tgz"], ["--check", "--check"],
  ]) assert.throws(() => installOptions(args));
});

test("Windows installation uses npm's JS entry and native global layout, not Linux paths or npm.cmd spawning", () => {
  assert.equal(npmPackageRoot("C:\\Users\\Demo\\.local\\release", "win32"), "C:\\Users\\Demo\\.local\\release\\node_modules\\codey");
  assert.equal(npmCandidates("C:\\Program Files\\nodejs\\node.exe", "win32")[0],
    "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js");
  const shims = launcherContents("C:\\Program Files\\nodejs\\node.exe", "C:\\Users\\Demo User\\codey\\bin\\codey.mjs", "win32");
  assert.deepEqual(Object.keys(shims), ["codey.cmd"]);
  assert.match(shims["codey.cmd"], /"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\Demo User\\codey\\bin\\codey.mjs" %\*/);
  assert.throws(() => launcherContents("C:\\node.exe", "C:\\bad%PATH%\\codey.mjs", "win32"));
  const unicodeHome = "C:\\Users\\测试 用户";
  const localized = launcherContents("C:\\Program Files\\nodejs\\node.exe",
    unicodeHome + "\\.local\\share\\codey\\bin\\codey.mjs", "win32", unicodeHome + "\\.local\\bin")["codey.cmd"];
  assert.doesNotMatch(localized, /[^\x00-\x7f]/);
  assert.match(localized, /%~dp0\.\.\\share\\codey\\bin\\codey.mjs/);
  assert.match(WINDOWS_PATH_SCRIPT, /SetEnvironmentVariable\('Path', \$next, 'User'\)/);
  assert.doesNotMatch(WINDOWS_PATH_SCRIPT, /Set-ExecutionPolicy|Register-ScheduledTask|Start-Service/);
});

test("runtime-only CLI setup preserves existing files and PATH entries, including spaces in the package root", {
  skip: process.platform !== "linux",
}, async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.home, ".bashrc"), "export EXISTING_SETTING=kept\n");
  const bin = await installLauncher(f.home, process.execPath, f.root);
  const before = await readFile(path.join(f.home, ".bashrc"), "utf8");
  await installLauncher(f.home, process.execPath, f.root);
  assert.equal(await readFile(path.join(f.home, ".bashrc"), "utf8"), before);
  const result = await exec("/bin/sh", ["-c", '. "$HOME/.profile"; codey --version'], {
    env: { HOME: f.home, PATH: "/usr/bin:/bin" },
  });
  assert.equal(result.stdout.trim(), "codey fixture");
  assert.equal(await readFile(path.join(f.root, "bin/codey.mjs"), "utf8"), 'console.log("codey fixture");\n');
  await writeFile(path.join(bin, "codey"), "user-owned command");
  await assert.rejects(installLauncher(f.home, process.execPath, f.root), /unmanaged CLI entry/);
  assert.equal(await readFile(path.join(bin, "codey"), "utf8"), "user-owned command");
});

test("runtime CLI installation refuses symlinked bin directories outside the selected home", {
  skip: process.platform !== "linux",
}, async t => {
  const f = await fixture(t);
  const outside = await mkdtemp(path.join(os.tmpdir(), "codey-outside-bin-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await mkdir(path.join(f.home, ".local"));
  await symlink(outside, path.join(f.home, ".local/bin"));
  await assert.rejects(installLauncher(f.home, process.execPath, f.root), /outside your home/);
});
