import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createNodeUpdateRelease } from "../scripts/publish-node-update.mjs";
import { NodeUpdateCatalog, validateNodeRelease, verifyNodeRelease, releaseSupportsPlatform } from "../src/node-update-release.mjs";
import { digest, jsonFile, packageFixture, packFixture } from "./codey-update-fixture.mjs";
import { mainSource } from "./release-source-fixture.mjs";

test("publisher verifies evidence/checksums and publishes immutable, monotonic, signed component releases", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codey-publish-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const keys = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const build = path.join(root, "build");
  await mkdir(build);
  const bytes = Buffer.from("reviewed-test-archive");
  const checksum = createHash("sha256").update(bytes).digest("hex");
  const component = { version: "2.0.0", sourceCommit: "a".repeat(40), entrySha256: "b".repeat(64),
    archiveSha256: checksum, lockSha256: "c".repeat(64) };
  const manifest = { release: "publisher-test-one", cloudcli: component, gateway: component,
    releaseSource: mainSource({ cloudcli: component.sourceCommit, copilotApi: component.sourceCommit }) };
  const manifestPath = path.join(build, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest));
  for (const name of ["cloudcli.tar.gz", "gateway.tar.gz"]) await writeFile(path.join(build, name), bytes);
  const options = { manifestPath, output: path.join(root, "feed"), privateKey: keys.privateKey, sequence: 1 };
  await assert.rejects(createNodeUpdateRelease(options), /ENOENT/);
  await writeFile(path.join(build, "validation.json"), JSON.stringify({ passed: false }));
  await assert.rejects(createNodeUpdateRelease(options), /validation/);
  await writeFile(path.join(build, "validation.json"), JSON.stringify({ passed: true }));
  const published = await createNodeUpdateRelease(options);
  assert.equal(published.artifactCount, 2);
  const catalog = new NodeUpdateCatalog({ root: options.output, publicKey: keys.publicKey });
  const first = (await catalog.list())[0].release;
  assert.deepEqual(first.migrations, ["gateway-api-key-v1"]);
  assert.equal(first.components.copilotApi.commit, component.sourceCommit);
  await assert.rejects(createNodeUpdateRelease({ ...options, sequence: 2 }), /immutable/);
  manifest.release = "publisher-test-two";
  await writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(createNodeUpdateRelease(options), /increase/);
  await createNodeUpdateRelease({ ...options, sequence: 2, components: ["cloudcli"] });
  const second = (await catalog.list())[0].release;
  assert.equal(second.id, manifest.release);
  assert.deepEqual(Object.keys(second.components), ["cloudcli"]);
  assert.deepEqual(second.migrations, []);
  assert.equal((await catalog.list()).length, 2);
  await writeFile(path.join(build, "gateway.tar.gz"), "tampered");
  await assert.rejects(createNodeUpdateRelease({ ...options, sequence: 3 }), /checksum/);
  assert.ok(!(await readFile(path.join(options.output, "catalog.json"), "utf8")).includes(keys.privateKey));
});

const platforms = ["linux-x64", "windows-x64", "macos-arm64", "macos-x64"];

async function sharedPublisherFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "codey-shared-publish-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const keys = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const app = await packageFixture(path.join(root, "candidate"), "0.1.5");
  const build = JSON.parse(await readFile(path.join(app, "codey-build.json")));
  build.sourceDirty = false;
  build.releaseSource = mainSource({
    commit: build.sourceCommit, cloudcli: build.cloudcli.commit,
    copilotApi: build.copilotApi.commit, version: build.version,
  });
  await jsonFile(path.join(app, "codey-build.json"), build);
  const file = await packFixture(app, path.join(root, "codey-0.1.5.tgz"));
  const bytes = await readFile(file);
  const source = { name: "codey", runtimePlatforms: build.runtimePlatforms, releaseSource: build.releaseSource,
    artifact: { file: path.basename(file), size: bytes.length, sha256: digest(bytes) },
    codey: { version: build.version, commit: build.sourceCommit, lockSha256: build.lockSha256,
      entrySha256: digest(await readFile(path.join(app, "codey-build.json"))) } };
  const manifestPath = path.join(root, "codey-package.json");
  await jsonFile(manifestPath, source);
  await jsonFile(path.join(root, "validation.json"), { passed: true, artifactSha256: source.artifact.sha256 });
  const options = { manifestPath, output: path.join(root, "feed"), privateKey: keys.privateKey, sequence: 1 };
  return { root, keys, app, build, file, bytes, source, manifestPath, options };
}

test("production signing refuses missing main proof, dirty packages and mismatched gitlinks before writing", async t => {
  const f = await sharedPublisherFixture(t);
  for (const releaseSource of [undefined, { ...f.source.releaseSource, sourceDirty: true },
    { ...f.source.releaseSource, ref: "refs/heads/dev" },
    { ...f.source.releaseSource, submodules: { ...f.source.releaseSource.submodules, cloudcli: "e".repeat(40) } }]) {
    await jsonFile(f.manifestPath, { ...f.source, releaseSource });
    await assert.rejects(createNodeUpdateRelease(f.options), /main|provenance/);
    await assert.rejects(readFile(path.join(f.options.output, "catalog.json")), { code: "ENOENT" });
  }
  await jsonFile(path.join(f.app, "codey-build.json"), { ...f.build, sourceDirty: true });
  await packFixture(f.app, f.file);
  const bytes = await readFile(f.file);
  const source = { ...f.source,
    artifact: { ...f.source.artifact, sha256: digest(bytes), size: bytes.length },
    codey: { ...f.source.codey, entrySha256: digest(await readFile(path.join(f.app, "codey-build.json"))) } };
  await jsonFile(f.manifestPath, source);
  await jsonFile(path.join(f.root, "validation.json"), { passed: true, artifactSha256: source.artifact.sha256 });
  await assert.rejects(createNodeUpdateRelease(f.options), /main provenance/);
  await assert.rejects(readFile(path.join(f.options.output, "catalog.json")), { code: "ENOENT" });
});

test("one Codey publication creates one artifact, signature and sequence for every supported runtime", async t => {
  const f = await sharedPublisherFixture(t);
  await assert.rejects(createNodeUpdateRelease({ ...f.options, components: ["cloudcli"] }), /reviewed/);
  const published = await createNodeUpdateRelease(f.options);
  assert.deepEqual(published.components, ["codey"]);
  assert.equal(published.artifactCount, 1);
  assert.match(published.releaseId, /^codey-shared-/);
  const catalog = new NodeUpdateCatalog({ root: f.options.output, publicKey: f.keys.publicKey });
  const rows = await catalog.list();
  assert.equal(rows.length, 1);
  const release = rows[0].release;
  assert.equal(release.platform, "shared");
  assert.deepEqual(release.runtimePlatforms, platforms);
  assert.deepEqual(release.migrations, ["gateway-api-key-v1"]);
  assert.deepEqual(release.components.codey.nodeMajors, [24]);
  assert.deepEqual(await readdir(path.join(f.options.output, "releases")), [release.id]);
  assert.deepEqual((await readdir(path.join(f.options.output, "releases", release.id))).sort(), [f.source.artifact.file, "release.json"]);
  for (const platform of platforms) {
    assert.equal(releaseSupportsPlatform(release, platform), true);
    const verified = verifyNodeRelease(rows[0].envelope, f.keys.publicKey);
    assert.equal(verified.digest, published.digest);
    assert.equal(verified.release.id, release.id);
  }
  const stored = await catalog.artifact(release.id, f.source.artifact.file);
  assert.deepEqual(await readFile(stored.target), f.bytes);
  await assert.rejects(createNodeUpdateRelease({ ...f.options, sequence: 2 }), /immutable/);
  await createNodeUpdateRelease({ ...f.options, sequence: 2, releaseId: "shared-reauthorized" });
  assert.equal((await catalog.get("shared-reauthorized")).release.components.codey.sha256, f.source.artifact.sha256);
});

test("Codey publication no longer accepts a host-specific publishing or Mac canary switch", async t => {
  const f = await sharedPublisherFixture(t);
  for (const platform of [...platforms, "unknown"]) {
    await assert.rejects(createNodeUpdateRelease({ ...f.options, platform }), /omit --platform/);
  }
  for (const macosValidation of ["native", "canary", "skip", "", null, true]) {
    await assert.rejects(createNodeUpdateRelease({ ...f.options, macosValidation }), /does not use --macos-validation/);
  }
  await assert.rejects(readFile(path.join(f.options.output, "catalog.json")), { code: "ENOENT" });
});

test("shared publication retains validation and inspects the actual archive for all hosts", async t => {
  const f = await sharedPublisherFixture(t);
  await jsonFile(path.join(f.root, "validation.json"), { passed: false });
  await assert.rejects(createNodeUpdateRelease(f.options), /Build validation has not passed/);
  for (const evidence of [{ passed: true }, { passed: true, artifactSha256: "a".repeat(64) }]) {
    await jsonFile(path.join(f.root, "validation.json"), evidence);
    await assert.rejects(createNodeUpdateRelease(f.options), /validation must match/);
  }
  await jsonFile(path.join(f.root, "validation.json"), { passed: true, artifactSha256: f.source.artifact.sha256 });
  for (const key of ["entrySha256", "lockSha256", "commit"]) {
    await jsonFile(f.manifestPath, { ...f.source, codey: { ...f.source.codey, [key]: "f".repeat(key === "commit" ? 40 : 64) } });
    await assert.rejects(createNodeUpdateRelease(f.options), /fingerprints differ/);
  }
  await jsonFile(f.manifestPath, f.source);
  await writeFile(f.file, "corrupt archive");
  await assert.rejects(createNodeUpdateRelease(f.options), /checksum/);
  const bytes = await readFile(f.file);
  await jsonFile(f.manifestPath, { ...f.source, artifact: { ...f.source.artifact, sha256: digest(bytes), size: bytes.length } });
  await jsonFile(path.join(f.root, "validation.json"), { passed: true, artifactSha256: digest(bytes) });
  await assert.rejects(createNodeUpdateRelease(f.options));
  await assert.rejects(readFile(path.join(f.options.output, "catalog.json")), { code: "ENOENT" });
});

test("a shared declaration cannot add runtimes absent from the immutable application", async t => {
  const f = await sharedPublisherFixture(t);
  await jsonFile(path.join(f.app, "codey-build.json"), { ...f.build, runtimePlatforms: ["linux-x64", "windows-x64"] });
  await packFixture(f.app, f.file);
  const bytes = await readFile(f.file);
  const source = { ...f.source,
    artifact: { ...f.source.artifact, sha256: digest(bytes), size: bytes.length },
    codey: { ...f.source.codey, entrySha256: digest(await readFile(path.join(f.app, "codey-build.json"))) } };
  await jsonFile(f.manifestPath, source);
  await jsonFile(path.join(f.root, "validation.json"), { passed: true, artifactSha256: source.artifact.sha256 });
  await assert.rejects(createNodeUpdateRelease(f.options), /fingerprints differ/);
  await jsonFile(f.manifestPath, { ...source, runtimePlatforms: ["linux-x64", "windows-x64"] });
  const published = await createNodeUpdateRelease(f.options);
  const catalog = new NodeUpdateCatalog({ root: f.options.output, publicKey: f.keys.publicKey });
  const { release } = await catalog.get(published.releaseId);
  assert.equal(release.platform, "shared");
  assert.equal(releaseSupportsPlatform(release, "windows-x64"), true);
  assert.equal(releaseSupportsPlatform(release, "macos-arm64"), false);
});

test("provided native evidence remains binding without requiring one publication per operating system", async t => {
  const f = await sharedPublisherFixture(t);
  const doctor = { ok: true, platform: "macos-arm64", version: f.build.version, nodeMajor: 24,
    sourceCommit: f.build.sourceCommit, lockSha256: f.build.lockSha256, entrySha256: f.source.codey.entrySha256,
    native: { sqlite: true, bcrypt: true, ripgrep: true, pty: true, codexSdk: true } };
  const proof = path.join(f.root, "doctor-macos-arm64.json");
  for (const patch of [{ ok: false }, { platform: "linux-x64" }, { nodeMajor: 22 }, { entrySha256: "a".repeat(64) },
    { native: { ...doctor.native, pty: false } }]) {
    await jsonFile(proof, { ...doctor, ...patch });
    await assert.rejects(createNodeUpdateRelease(f.options), /Supplied native validation/);
  }
  await writeFile(proof, "{");
  await assert.rejects(createNodeUpdateRelease(f.options));
  await jsonFile(proof, doctor);
  await createNodeUpdateRelease(f.options);
  assert.deepEqual((await new NodeUpdateCatalog({ root: f.options.output, publicKey: f.keys.publicKey }).list())[0].release.runtimePlatforms, platforms);
  // No files claiming native Windows/Intel acceptance were invented.
  await assert.rejects(readFile(path.join(f.root, "doctor-windows-x64.json")), { code: "ENOENT" });
  await assert.rejects(readFile(path.join(f.root, "doctor-macos-x64.json")), { code: "ENOENT" });
});

test("new shared signatures coexist with unchanged historical platform signatures for the same tarball", async t => {
  const f = await sharedPublisherFixture(t);
  const now = Date.now();
  const old = { schema: 1, kind: "codey-node-release", id: "codey-" + f.source.artifact.sha256.slice(0, 16),
    sequence: 1, createdAt: now - 1000, expiresAt: now + 86400000, protocol: 1, platform: "linux-x64",
    configSchema: 1, rollback: "code-only", notes: "Original platform-scoped release", migrations: ["gateway-api-key-v1"],
    components: { codey: { ...f.source.codey, file: f.source.artifact.file, sha256: f.source.artifact.sha256,
      size: f.bytes.length, nodeMajors: [24] } } };
  const body = Buffer.from(JSON.stringify(old));
  const envelope = { payload: body.toString("base64"), signature: sign(null, body, f.keys.privateKey).toString("base64url") };
  await mkdir(f.options.output);
  await jsonFile(path.join(f.options.output, "catalog.json"), { schema: 1, releases: [envelope] });
  const published = await createNodeUpdateRelease({ ...f.options, sequence: 2 });
  const rows = await new NodeUpdateCatalog({ root: f.options.output, publicKey: f.keys.publicKey }).list();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].release.id, published.releaseId);
  assert.deepEqual(rows[1].envelope, envelope);
  assert.equal(rows[0].release.components.codey.sha256, rows[1].release.components.codey.sha256);
  assert.equal(releaseSupportsPlatform(rows[0].release, "windows-x64"), true);
  assert.equal(releaseSupportsPlatform(rows[1].release, "windows-x64"), false);
});

test("shared schema rejects ambiguous runtime grants, mixed packages and unsupported target identities", async t => {
  const f = await sharedPublisherFixture(t);
  const published = await createNodeUpdateRelease(f.options);
  const { release } = await new NodeUpdateCatalog({ root: f.options.output, publicKey: f.keys.publicKey }).get(published.releaseId);
  for (const runtimePlatforms of [undefined, [], null, "all", ["linux-arm64"], ["linux-x64", "linux-x64"], ["shared"]]) {
    assert.throws(() => validateNodeRelease({ ...release, runtimePlatforms }));
  }
  assert.throws(() => validateNodeRelease({ ...release, platform: "linux-x64" }));
  assert.throws(() => validateNodeRelease({ ...release, components: {
    ...release.components, cloudcli: { ...release.components.codey, file: "cloudcli.tar.gz" },
  } }));
  assert.throws(() => validateNodeRelease({ ...release, components: {
    cloudcli: { ...release.components.codey, file: "cloudcli.tar.gz" },
  } }));
  assert.throws(() => validateNodeRelease({ ...release, components: {
    codey: { ...release.components.codey, file: "../codey.tgz" },
  } }));
  assert.throws(() => validateNodeRelease({ ...release, components: {
    codey: { ...release.components.codey, lockSha256: undefined },
  } }));
  for (const target of ["shared", "linux-arm64", "windows-arm64", undefined]) {
    assert.equal(releaseSupportsPlatform(release, target), false);
  }
});

test("the ordinary publication CLI produces a single shared release without any platform option", async t => {
  const f = await sharedPublisherFixture(t), privateKey = path.join(f.root, "test-private.pem");
  await writeFile(privateKey, f.keys.privateKey, { mode: 0o600 });
  const result = await promisify(execFile)(process.execPath, [path.resolve("scripts/publish-node-update.mjs"), "publish",
    "--manifest", f.manifestPath, "--output", f.options.output, "--private-key", privateKey,
    "--sequence", "1", "--notes", "One shared application release",
  ], { timeout: 30000, maxBuffer: 1024 * 1024 });
  assert.equal(JSON.parse(result.stdout).artifactCount, 1);
  const rows = await new NodeUpdateCatalog({ root: f.options.output, publicKey: f.keys.publicKey }).list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].release.platform, "shared");
  assert.deepEqual(rows[0].release.runtimePlatforms, platforms);
  assert.equal(rows[0].release.notes, "One shared application release");
});
