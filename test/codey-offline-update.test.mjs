import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { argumentsFor, makeOfflineStage, peX64, safeName, validateRecoveryScope, verifyBundle, verifyPackages } from "../scripts/windows/offline-update.mjs";
import { buildEnvironment } from "../packages/codey/lib/update-files.mjs";

const sha = value => createHash("sha256").update(value).digest("hex");
const pe = () => {
  const bytes = Buffer.alloc(128);
  bytes.write("MZ"); bytes.writeUInt32LE(64, 0x3c);
  bytes.write("PE\0\0", 64); bytes.writeUInt16LE(0x8664, 68);
  return bytes;
};

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "codey offline 中文 "));
  t.after(() => rm(root, { recursive: true, force: true }));
  const payloads = {
    "codey-0.1.4.tgz": Buffer.from("fixture-only-tarball"),
    "cache/_cacache/content-v2/sha512/aa/fixture": Buffer.from("fixture-only-cache"),
    "native/127/better_sqlite3.node": pe(),
    "native/137/better_sqlite3.node": pe(),
    "bootstrap/update.mjs": Buffer.from("// fixture only"),
  };
  const files = {};
  for (const [name, value] of Object.entries(payloads)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), value);
    files[name] = { size: value.length, sha256: sha(value) };
  }
  const manifest = {
    schema: 1, kind: "codey-offline-windows", version: "0.1.4", platform: "windows-x64",
    expectedComputer: "CPC-zhn-VZO0BX3", nodeAbis: [127, 137],
    package: { file: "codey-0.1.4.tgz", ...files["codey-0.1.4.tgz"] },
    sqlite: Object.fromEntries([127, 137].map(abi => [String(abi), {
      version: "12.11.1", file: `native/${abi}/better_sqlite3.node`,
      sha256: files[`native/${abi}/better_sqlite3.node`].sha256,
    }])),
    packages: { "node_modules/better-sqlite3": "12.11.1" }, files,
  };
  await writeFile(path.join(root, "manifest.json"), JSON.stringify(manifest));
  return { root, manifest, payloads };
}

test("offline paths reject traversal, ADS, devices, absolute and ambiguous Windows names", () => {
  assert.equal(safeName("cache/_cacache/content-v2/sha512/aa/fixture"), "cache/_cacache/content-v2/sha512/aa/fixture");
  for (const value of ["../a", "x/../a", "/a", "C:/a", "a\\b", "a:stream", "nul.txt", "x/COM1.dll", "a.", "a//b", "a/"]) {
    assert.throws(() => safeName(value), /Unsafe/);
  }
});

test("a complete pinned manifest verifies every offline payload", async t => {
  const f = await fixture(t);
  assert.deepEqual(await verifyBundle(f.root), f.manifest);
});

test("same-size payload tampering cannot pass bundle verification", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, "bootstrap/update.mjs"), "// Fixture only");
  await assert.rejects(verifyBundle(f.root), /checksum mismatch/);
});

test("missing or unexpected files fail closed, rather than silently trusting a cache", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, ".npmrc"), "fixture");
  await assert.rejects(verifyBundle(f.root), /unexpected files/);
  await rm(path.join(f.root, ".npmrc"));
  await rm(path.join(f.root, "native/127/better_sqlite3.node"));
  await assert.rejects(verifyBundle(f.root), /unexpected files/);
});

test("offline payload links are rejected", { skip: process.platform === "win32" }, async t => {
  const f = await fixture(t);
  await symlink(path.join(f.root, "manifest.json"), path.join(f.root, "linked"));
  await assert.rejects(verifyBundle(f.root), /links are not allowed/);
});

test("unsupported ABI metadata and mismatched native versions are rejected", async t => {
  const f = await fixture(t);
  f.manifest.sqlite["137"].version = "0.0.0";
  await writeFile(path.join(f.root, "manifest.json"), JSON.stringify(f.manifest));
  await assert.rejects(verifyBundle(f.root), /12.11.1/);
});

test("native payload must actually be PE/AMD64, not Linux, x86 or a truncated header", () => {
  assert.equal(peX64(pe()), true);
  const x86 = pe(); x86.writeUInt16LE(0x14c, 68);
  assert.equal(peX64(x86), false);
  assert.equal(peX64(Buffer.from("\x7fELF")), false);
  const badOffset = pe(); badOffset.writeUInt32LE(9000, 0x3c);
  assert.equal(peX64(badOffset), false);
});

test("the complete installed locked dependency graph is checked", async t => {
  const f = await fixture(t), app = path.join(f.root, "app");
  await mkdir(path.join(app, "node_modules/better-sqlite3"), { recursive: true });
  const file = path.join(app, "node_modules/better-sqlite3/package.json");
  await writeFile(file, '{"version":"12.11.1"}');
  await verifyPackages(app, f.manifest);
  await writeFile(file, '{"version":"12.0.0"}');
  await assert.rejects(verifyPackages(app, f.manifest), /Locked offline dependency differs/);
});

test("offline staging uses private cache, disabled network/hooks and a real doctor command (mocked processes)", async t => {
  const f = await fixture(t), job = path.join(f.root, "job");
  await mkdir(job);
  const calls = [];
  let packageVerifications = 0;
  const core = {
    buildEnvironment: (home, node) => buildEnvironment(home, node, {
      OPENAI_API_KEY: "fixture-not-a-real-key", NODE_OPTIONS: "--require=untrusted",
      npm_config_registry: "https://untrusted.invalid", HTTPS_PROXY: "http://untrusted.invalid",
    }),
    verifyStagedPackage: async () => { packageVerifications++; },
  };
  const stage = makeOfflineStage(f.root, f.manifest, core, { abi: 137 });
  const command = async (file, args, options) => {
    calls.push({ file, args, options });
    assert.equal(options.env.npm_config_offline, "true");
    assert.equal(options.env.npm_config_ignore_scripts, "true");
    assert.equal(options.env.OPENAI_API_KEY, undefined);
    assert.equal(options.env.NODE_OPTIONS, undefined);
    assert.equal(options.env.HTTPS_PROXY, undefined);
    if (args[0] === "--input-type=commonjs") {
      assert.match(args[2], /pacote.extract/);
      assert.match(args[2], /offline:true/);
      assert.match(args[2], /ignoreScripts:true/);
      assert.match(args[7], /^sha256-/);
      await mkdir(args[5], { recursive: true });
    } else if (args[1] === "ci") {
      const prefix = args[args.indexOf("--prefix") + 1];
      const dependency = path.join(prefix, "node_modules/better-sqlite3");
      await mkdir(dependency, { recursive: true });
      await writeFile(path.join(dependency, "package.json"), '{"version":"12.11.1"}');
      assert.ok(args.includes("--offline") && args.includes("--ignore-scripts"));
      assert.ok(args.includes("--os=win32") && args.includes("--cpu=x64"));
      assert.equal(args[args.indexOf("--cache") + 1], path.join(job, "build-home/.npm"));
    } else {
      assert.deepEqual(args.slice(1), ["doctor", "--json"]);
    }
    return "";
  };
  const candidate = await stage({ file: path.join(f.root, f.manifest.package.file), sha256: f.manifest.package.sha256 },
    { node: process.execPath }, job, { command, npm: "/fixture/npm-cli.js" });
  assert.equal(calls.length, 3);
  assert.equal(packageVerifications, 3);
  assert.equal(sha(await readFile(path.join(candidate, "node_modules/better-sqlite3/build/Release/better_sqlite3.node"))),
    f.manifest.sqlite["137"].sha256);
  assert.ok(calls.every(call => !call.args.includes("rebuild") && !call.args.includes("setup")));
});

test("unsupported Node ABI is rejected before any stage command", async t => {
  const f = await fixture(t);
  const stage = makeOfflineStage(f.root, f.manifest, {}, { abi: 999 });
  await assert.rejects(stage({ sha256: f.manifest.package.sha256 }, {}, path.join(f.root, "job"), {}),
    /existing Node 22\/24/);
});

test("there is no force, unknown flag, component update or web-download CLI", () => {
  const args = ["--mode", "check", "--bundle-root", path.resolve("/fixture"), "--expected-computer", "CPC-zhn-VZO0BX3"];
  assert.equal(argumentsFor(args)["--mode"], "check");
  assert.throws(() => argumentsFor([...args, "--force", "true"]));
  assert.throws(() => argumentsFor([...args, "--mode", "apply"]));
  assert.throws(() => argumentsFor(args.map(value => value === "check" ? "codex" : value)));
});

test("recovery includes interruption before a request/journal and both sides of descriptor switching", () => {
  const manifest = { package: { sha256: "a".repeat(64) } };
  const request = { sha256: manifest.package.sha256, plan: { kind: "windows-managed", root: "C:\\old" },
    candidate: "C:\\candidate" };
  validateRecoveryScope(null, null, manifest, "C:\\old");
  validateRecoveryScope(request, null, manifest, "C:\\old");
  validateRecoveryScope(null, { kind: "windows-managed", request }, manifest, "C:\\candidate");
});

test("offline recovery will not switch an unrelated tool, package or node", () => {
  const manifest = { package: { sha256: "a".repeat(64) } };
  const request = { sha256: manifest.package.sha256, plan: { kind: "windows-managed", root: "C:\\old" },
    candidate: "C:\\candidate" };
  assert.throws(() => validateRecoveryScope(request, { kind: "windows-tool", request }, manifest, "C:\\old"));
  assert.throws(() => validateRecoveryScope({ ...request, sha256: "b".repeat(64) }, null, manifest, "C:\\old"));
  assert.throws(() => validateRecoveryScope(request, null, manifest, "C:\\unrelated"));
  assert.throws(() => validateRecoveryScope(null, { kind: "windows-managed" }, manifest, "C:\\old"));
});

test("PowerShell launcher authenticates both cached manifest and runner before Node; never mutates service registration", async () => {
  const source = await readFile(new URL("../scripts/windows/update-codey-offline.ps1", import.meta.url), "utf8");
  assert.doesNotMatch(source, /Invoke-WebRequest|Invoke-RestMethod|Stop-Process|taskkill|Register-ScheduledTask|Set-ExecutionPolicy/);
  assert.match(source, /@@BUNDLE_SHA256@@/);
  assert.match(source, /@@MANIFEST_SHA256@@/);
  assert.match(source, /@@RUNNER_SHA256@@/);
  assert.ok(source.indexOf("Cached offline runner was changed") < source.indexOf("& $runtime.nodeExe"));
  assert.match(source, /-not \$principal.IsInRole/);
  assert.match(source, /runtime.ownerSid -eq \$identity.User.Value/);
  assert.doesNotMatch(source, /\$home\b/i);
});

const powershell = process.env.CODEY_TEST_POWERSHELL;
test("PowerShell parses the entire launcher and rejects malicious ZIPs using isolated fixtures", {
  skip: !powershell, timeout: 30000,
}, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codey offline PS "));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { stdout } = await promisify(execFile)(powershell, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-File",
    fileURLToPath(new URL("./windows-offline-update-fixture.ps1", import.meta.url)),
    "-Root", root, "-Source", fileURLToPath(new URL("../scripts/windows/update-codey-offline.ps1", import.meta.url)),
  ], { timeout: 29000, maxBuffer: 1024 * 1024 });
  const report = JSON.parse(stdout);
  assert.equal(report.passed, true);
  assert.equal(report.servicesChanged, false);
  assert.equal(report.networkRequests, 0);
});
