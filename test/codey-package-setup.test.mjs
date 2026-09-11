import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { installedSetup, runSetup, setupOptions, validateSetupConfig } from "../packages/codey/lib/setup.mjs";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const publicKey = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" });
const config = {
  schema: 1, portalOrigin: "https://codey.example.test", platform: "linux-x64",
  network: { mode: "devtunnel" }, tunnelAuthProvider: "github",
  updater: { protocol: 1, releasePublicKey: publicKey },
};

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codey-npm-setup-test-"));
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
    "dist-server/server/index.js", "gateway/main.js", "updater/install.py",
    "updater/updater.py", "updater/engine.py", "updater/probe.mjs",
    "onboarding/scripts/install.sh", "onboarding/templates/a100-models.json",
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

test("setup options and configuration allow public deployment metadata only", () => {
  assert.deepEqual(setupOptions(["--check"]), { check: true });
  for (const args of [["--port", "4141"], ["--config"], ["--check", "--check"], ["--config", "a", "--config", "b"]]) {
    assert.throws(() => setupOptions(args));
  }
  assert.equal(validateSetupConfig(config), config);
  for (const changed of [
    { portalOrigin: "http://codey.example.test" }, { portalOrigin: "https://user:password@codey.example.test" },
    { portalOrigin: "https://codey.example.test/path" }, { platform: "windows-x64" },
    { credentials: { token: "do-not-bundle" } }, { ownerId: "someone" },
    { updater: { protocol: 1, releasePublicKey: "-----BEGIN PRIVATE KEY-----\nprivate" } },
    { updater: { ...config.updater, credential: "do-not-bundle" } },
  ]) assert.throws(() => validateSetupConfig({ ...config, ...changed }));
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "pem" });
  assert.throws(() => validateSetupConfig({ ...config, updater: { protocol: 1, releasePublicKey: rsa } }), /Ed25519/);
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

test("setup passes temporary metadata and the exact npm root to Bash, then removes metadata", async t => {
  const f = await fixture(t);
  let captured;
  const previousExitCode = process.exitCode;
  t.after(() => { process.exitCode = previousExitCode; });
  await runSetup(f.pkg, [], { home: f.home, spawnProcess(command, args, options) {
    captured = { command, args, options };
    const child = new EventEmitter();
    child.kill = () => true;
    setImmediate(() => child.emit("exit", 0));
    return child;
  } });
  assert.equal(captured.command, "bash");
  assert.deepEqual(captured.args, [path.join(f.pkg, "onboarding/scripts/install.sh")]);
  assert.equal(captured.options.env.CODEY_INSTALLED_PACKAGE, f.pkg);
  assert.equal(captured.options.env.CODEY_SETUP_NODE, process.execPath);
  await assert.rejects(stat(captured.options.env.CODEY_SETUP_ASSETS), { code: "ENOENT" });
  assert.equal(process.exitCode, 0);
});

test("setup refuses an unmanaged prefix before launching the deployment script", async t => {
  const f = await fixture(t);
  await assert.rejects(runSetup(f.pkg, [], {
    home: f.directory,
    spawnProcess() { throw new Error("Must not reach deployment"); },
  }), /supported HOME npm prefix/);
});

test("the npm one-click installer supports a local tarball and HTTPS URL without deploying in check mode", {
  skip: process.platform !== "linux", timeout: 120000,
}, async t => {
  const f = await fixture(t);
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
    const env = { ...process.env, HOME: f.home, NODE_EXTRA_CA_CERTS: cert,
      npm_config_cache: path.join(f.home, ".npm"), NO_PROXY: "*", no_proxy: "*",
      npm_config_offline: "false", npm_config_strict_ssl: "true" };
    const result = await exec("bash", [path.join(root, "scripts/linux/install-codey.sh"),
      "--package", spec, "--node-dir", path.dirname(path.dirname(process.execPath)),
      "--prefix", prefix, "--check"], { env, timeout: 60000, maxBuffer: 2 * 1024 * 1024 });
    assert.match(result.stdout, /"serviceChanges":false/);
    const installed = path.join(prefix, "lib/node_modules/codey");
    assert.equal((await installedSetup(installed)).setup.portalOrigin, config.portalOrigin);
    await assert.rejects(stat(path.join(f.home, ".config/codey-machine")), { code: "ENOENT" });
    await assert.rejects(stat(path.join(f.home, ".codex")), { code: "ENOENT" });
    for (const name of [".profile", ".bashrc", ".bash_profile", ".bash_login"]) {
      await assert.rejects(stat(path.join(f.home, name)), { code: "ENOENT" });
    }
    await assert.rejects(exec("bash", [path.join(root, "scripts/linux/install-codey.sh"),
      "--package", spec, "--node-dir", path.dirname(path.dirname(process.execPath)),
      "--prefix", prefix, "--check"], { env }), /Refusing to overwrite/);
  }
  assert.ok(requests > 0, "npm must fetch the HTTPS artifact itself");
});
