import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { installedSetup, runInstall, installOptions, validateSetupConfig } from "../packages/codey/lib/install.mjs";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const publicKey = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" });
const config = {
  schema: 1, portalOrigin: "https://codey.example.test", platform: "linux-x64",
  network: { mode: "devtunnel" }, tunnelAuthProvider: "github",
};

async function fixture(t) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "codey-npm-setup-test-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const home = path.join(directory, "home");
  const pkg = path.join(home, ".local/share/package");
  await mkdir(pkg, { recursive: true });
  for (const name of ["bin", "lib"]) await cp(path.join(root, "packages/codey", name), path.join(pkg, name), { recursive: true });
  const document = { name: "codey", version: "0.1.0", type: "module", bin: { codey: "bin/codey.mjs" } };
  await writeFile(path.join(pkg, "package.json"), JSON.stringify(document));
  const lock = JSON.stringify({ name: "codey", version: "0.1.0", lockfileVersion: 3,
    packages: { "": { name: "codey", version: "0.1.0" } } });
  await writeFile(path.join(pkg, "npm-shrinkwrap.json"), lock);
  const entry = "// Only a setup-check fixture; never start a real service.\n";
  for (const name of [
    "dist-server/server/index.js", "gateway/main.js",
    "onboarding/scripts/install-machine.mjs", "onboarding/scripts/machine-common.mjs", "onboarding/scripts/machine-package.mjs",
    "onboarding/scripts/machine-resources.mjs", "onboarding/scripts/platform-linux.mjs", "onboarding/scripts/platform-macos.mjs",
    "onboarding/scripts/platform-windows.mjs", "onboarding/scripts/platform-unix.mjs", "onboarding/scripts/macos-service.mjs",
    "onboarding/dependencies.json", "onboarding/scripts/registration.mjs",
    "onboarding/templates/a100-models.json", "onboarding/templates/codex-config.toml",
    "onboarding/scripts/install-devtunnel-health.sh", "onboarding/scripts/linux-devtunnel-health.mjs",
    "onboarding/scripts/linux-preflight.sh", "onboarding/scripts/windows-runtime.mjs",
    "onboarding/scripts/github-auth.mjs", "onboarding/scripts/github-tunnel.mjs",
  ]) {
    await mkdir(path.dirname(path.join(pkg, name)), { recursive: true });
    await writeFile(path.join(pkg, name), entry);
  }
  const build = {
    schema: 1, name: "codey", version: "0.1.0", sourceCommit: "a".repeat(40),
    cloudcli: { commit: "b".repeat(40), version: "1.37.2" },
    copilotApi: { commit: "c".repeat(40), version: "2.5.4" },
    lockSha256: hash(lock), workspaceEntrySha256: hash(entry), gatewayEntrySha256: hash(entry),
  };
  await writeFile(path.join(pkg, "codey-build.json"), JSON.stringify(build));
  await writeFile(path.join(pkg, "onboarding/setup.json"), JSON.stringify(config));
  return { directory, pkg, home, build };
}

test("private installation options and configuration allow public deployment metadata only", () => {
  assert.deepEqual(installOptions(["--check"]), { check: true });
  assert.deepEqual(installOptions(["--expected-computer", "my-linux", "--replace-existing"]),
    { expectedComputer: "my-linux", replaceExisting: true });
  for (const args of [["--port", "4141"], ["--config"], ["--check", "--check"], ["--config", "a", "--config", "b"]]) {
    assert.throws(() => installOptions(args));
  }
  assert.deepEqual(validateSetupConfig(config), config);
  assert.deepEqual(validateSetupConfig({ ...config, updater: { protocol: 1, releasePublicKey: publicKey } }), config,
    "Legacy public updater metadata is ignored; it cannot enable an agent");
  for (const changed of [
    { portalOrigin: "http://codey.example.test" }, { portalOrigin: "https://user:password@codey.example.test" },
    { portalOrigin: "https://codey.example.test/path" }, { platform: "windows-x64" },
    { credentials: { token: "do-not-bundle" } }, { ownerId: "someone" },
    { updater: { protocol: 1, releasePublicKey: "-----BEGIN PRIVATE KEY-----\nprivate" } },
    { updater: { protocol: 1, releasePublicKey: publicKey, credential: "do-not-bundle" } },
  ]) assert.throws(() => validateSetupConfig({ ...config, ...changed }));
});

test("npm setup uses the installed root and derives stable metadata without a tarball or ZIP", async t => {
  const f = await fixture(t);
  const prepared = await installedSetup(f.pkg);
  assert.equal(prepared.root, f.pkg);
  assert.equal(prepared.manifest.dependencyMode, "npm-installed");
  assert.deepEqual(prepared.manifest.artifacts, []);
  assert.equal(prepared.setup.releaseId, `machine-${hash(await readFile(path.join(f.pkg, "codey-build.json"))).slice(0, 16)}`);
  assert.equal(prepared.manifest.node, process.versions.node);
  await writeFile(path.join(f.pkg, "gateway/main.js"), "tampered");
  await assert.rejects(installedSetup(f.pkg), /fingerprint mismatch/);
});

test("the shared package's auto configuration resolves only at Linux managed setup time", async t => {
  const f = await fixture(t);
  const shared = { ...config, platform: "auto" };
  assert.deepEqual(validateSetupConfig(shared), shared);
  const file = path.join(f.pkg, "onboarding/setup.json");
  const bytes = JSON.stringify(shared);
  await writeFile(file, bytes);
  const prepared = await installedSetup(f.pkg);
  assert.equal(prepared.manifest.platform, "linux-x64");
  assert.equal(prepared.setup.platform, "linux-x64");
  assert.equal(await readFile(file, "utf8"), bytes, "Setup must not rewrite the shared npm artifact");
});

test("missing baked setup can use an explicit public config; missing or changed locks fail", async t => {
  const f = await fixture(t);
  await rm(path.join(f.pkg, "onboarding/setup.json"));
  await assert.rejects(installedSetup(f.pkg), /--config FILE/);
  const explicit = path.join(f.directory, "public-setup.json");
  await writeFile(explicit, JSON.stringify(config));
  assert.equal((await installedSetup(f.pkg, explicit)).setup.portalOrigin, config.portalOrigin);
  await writeFile(path.join(f.pkg, "npm-shrinkwrap.json"), "{}");
  await assert.rejects(installedSetup(f.pkg, explicit), /locked Codey/);
});

test("the private npm bridge calls the common Node workflow with the installed root and no temporary metadata or Bash", {
  skip: process.platform !== "linux",
}, async t => {
  const f = await fixture(t);
  let captured;
  const createInstaller = async (skill, context) => ({ apply: async options => { captured = { skill, context, options }; } });
  await runInstall(f.pkg, ["--expected-computer", os.hostname(), "--replace-existing"], { home: f.home, createInstaller });
  assert.equal(captured.skill, path.join(f.pkg, "onboarding"));
  assert.equal(captured.context.prepared.root, f.pkg);
  assert.deepEqual(captured.options, { check: false, apply: true, "network-approved": true,
    "expected-computer": os.hostname(), "replace-existing": true });
  await runInstall(f.pkg, ["--check"], { home: f.home, createInstaller });
  assert.equal(captured.options.check, true);
  assert.equal(captured.options.apply, false);
});

test("the bootstrap's private module runs from another cwd and never requires a public setup command", {
  skip: process.platform !== "linux",
}, async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.pkg, "onboarding/scripts/install-machine.mjs"), `
export class Installer {
  constructor(skill, context) { this.skill = skill; this.context = context; }
  apply(options) { console.log(JSON.stringify({skill:this.skill,root:this.context.prepared.root,options})); }
}
`);
  for (const args of [["--check"], ["--expected-computer", os.hostname(), "--replace-existing"]]) {
    const result = await exec(process.execPath, [path.join(f.pkg, "lib/install.mjs"), ...args],
      { cwd: f.directory, env: { ...process.env, HOME: f.home } });
    const value = JSON.parse(result.stdout);
    assert.equal(value.root, f.pkg);
    assert.equal(value.skill, path.join(f.pkg, "onboarding"));
    assert.equal(value.options.check, args.includes("--check"));
    assert.equal(value.options.apply, !args.includes("--check"));
  }
  await assert.rejects(exec(process.execPath, [path.join(f.pkg, "lib/install.mjs")], {
    cwd: f.directory, env: { ...process.env, HOME: f.home },
  }), error => error.code === 1 && /expected-computer/.test(error.stderr));
  await assert.rejects(exec(process.execPath, [path.join(f.pkg, "bin/codey.mjs"), "setup", "--check"], {
    cwd: f.directory, env: { ...process.env, HOME: f.home },
  }), error => error.code === 1 && /Unknown command: setup/.test(error.stderr));
});

test("Linux setup requires the exact approved computer before creating metadata or launching deployment", {
  skip: process.platform !== "linux",
}, async t => {
  const f = await fixture(t);
  for (const args of [[], ["--expected-computer", "not-this-machine"]]) {
    await assert.rejects(runInstall(f.pkg, args, { home: f.home,
      createInstaller() { assert.fail("No deployment before host confirmation"); },
    }), /expected-computer/);
  }
});

test("setup refuses an unmanaged prefix before launching the deployment script", {
  skip: process.platform !== "linux",
}, async t => {
  const f = await fixture(t);
  await assert.rejects(runInstall(f.pkg, [], {
    home: f.directory,
    createInstaller() { throw new Error("Must not reach deployment"); },
  }), /supported HOME npm prefix/);
});

test("unsupported platforms reject Linux setup before launching any process", {
  skip: process.platform === "linux",
}, async () => {
  await assert.rejects(runInstall(root, ["--check"], {
    createInstaller() { assert.fail("Must not launch a deployment on this platform"); },
  }), /Managed service setup supports Linux x64 only/);
});

test("the npm one-click installer supports a local tarball and HTTPS URL without deploying in check mode", {
  skip: process.platform !== "linux", timeout: 120000,
}, async t => {
  const f = await fixture(t);
  const stubs = path.join(f.directory, "preflight-stubs");
  await mkdir(stubs);
  await writeFile(path.join(stubs, "ss"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  await writeFile(path.join(stubs, "getent"),
    '#!/bin/sh\nprintf "fixture:x:%s:1000::%s:/bin/bash\\n" "$(id -u)" "$HOME"\n', { mode: 0o700 });
  const npm = path.join(path.dirname(process.execPath), "npm");
  await exec(npm, ["pack", "--ignore-scripts", "--pack-destination", f.directory], { cwd: f.pkg });
  const archive = path.join(f.directory, "codey-0.1.0.tgz");
  const cert = path.join(f.directory, "cert.pem"), key = path.join(f.directory, "key.pem");
  await exec("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-noenc", "-days", "1",
    "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1",
    "-keyout", key, "-out", cert]);
  const bytes = await readFile(archive);
  let requests = 0;
  const server = https.createServer({ key: await readFile(key), cert: await readFile(cert) }, (req, res) => {
    requests++;
    assert.equal(req.url, "/codey-0.1.0.tgz");
    res.writeHead(200, { "content-type": "application/gzip", "content-length": bytes.length });
    res.end(bytes);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  for (const [kind, spec] of [
    ["file", archive], ["https", `https://127.0.0.1:${server.address().port}/codey-0.1.0.tgz`],
  ]) {
    const prefix = path.join(f.home, ".local/share", `installed-${kind}`);
    const env = { ...process.env, HOME: f.home, SUDO_USER: "", PATH: `${stubs}:${process.env.PATH}`, NODE_EXTRA_CA_CERTS: cert,
      npm_config_cache: path.join(f.home, ".npm"), NO_PROXY: "*", no_proxy: "*",
      npm_config_offline: "false", npm_config_strict_ssl: "true" };
    const result = await exec("bash", [path.join(root, "scripts/linux/install-codey.sh"),
      "--package", spec, "--node-dir", path.dirname(path.dirname(process.execPath)),
      "--prefix", prefix, "--check"], { env, timeout: 60000, maxBuffer: 2 * 1024 * 1024 });
    assert.match(result.stdout, /Read-only check/);
    await assert.rejects(stat(prefix), { code: "ENOENT" });
    await assert.rejects(stat(path.join(f.home, ".config/codey-machine")), { code: "ENOENT" });
    await assert.rejects(stat(path.join(f.home, ".codex")), { code: "ENOENT" });
    for (const name of [".profile", ".bashrc", ".bash_profile", ".bash_login"]) {
      await assert.rejects(stat(path.join(f.home, name)), { code: "ENOENT" });
    }
    await mkdir(prefix, { recursive: true });
    await assert.rejects(exec("bash", [path.join(root, "scripts/linux/install-codey.sh"),
      "--package", spec, "--node-dir", path.dirname(path.dirname(process.execPath)),
      "--prefix", prefix, "--check"], { env }), /Refusing to overwrite/);
  }
  assert.equal(requests, 0, "Read-only checks must never contact the HTTPS artifact server");
});
