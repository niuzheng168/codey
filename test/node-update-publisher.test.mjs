import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createNodeUpdateRelease } from "../scripts/publish-node-update.mjs";
import { NodeUpdateCatalog, validateNodeRelease } from "../src/node-update-release.mjs";
import { digest, jsonFile, packageFixture, packFixture } from "./codey-update-fixture.mjs";

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
  const manifest = { release: "publisher-test-one", cloudcli: component, gateway: component };
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

test("publisher signs one whole Codey npm package and never mixes it with legacy app components", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codey-npm-update-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const keys = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const bytes = Buffer.from("reviewed-npm-package-fixture");
  const artifact = { file: "codey-0.1.0.tgz", size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex") };
  const source = { schema: 1, name: "codey", artifact,
    codey: { version: "0.1.0", commit: "a".repeat(40), entrySha256: "b".repeat(64), lockSha256: "c".repeat(64) } };
  const manifestPath = path.join(root, "codey-package.json");
  await writeFile(manifestPath, JSON.stringify(source));
  await writeFile(path.join(root, artifact.file), bytes);
  await writeFile(path.join(root, "validation.json"), '{"passed":true}');
  const options = { manifestPath, output: path.join(root, "feed"), privateKey: keys.privateKey, sequence: 1 };
  await assert.rejects(createNodeUpdateRelease({ ...options, components: ["cloudcli"] }), /reviewed/);
  const published = await createNodeUpdateRelease(options);
  assert.deepEqual(published.components, ["codey"]);
  assert.equal(published.artifactCount, 1);
  const catalog = new NodeUpdateCatalog({ root: options.output, publicKey: keys.publicKey });
  const release = (await catalog.list())[0].release;
  assert.equal(release.components.codey.file, artifact.file);
  assert.equal(release.components.codey.lockSha256, source.codey.lockSha256);
  assert.deepEqual(release.migrations, ["gateway-api-key-v1"]);
  assert.throws(() => validateNodeRelease({
    ...release, components: { ...release.components, cloudcli: { ...release.components.codey, file: "cloudcli.tar.gz" } },
  }));
  assert.throws(() => validateNodeRelease({
    ...release, components: { codey: { ...release.components.codey, file: "../codey.tgz" } },
  }));
  assert.throws(() => validateNodeRelease({
    ...release, components: { codey: { ...release.components.codey, lockSha256: undefined } },
  }));
  const stored = await catalog.artifact(release.id, artifact.file);
  assert.deepEqual(await readFile(stored.target), bytes);
});

test("one unchanged shared tarball can be signed for Windows with a distinct immutable ID and increasing sequence", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codey-win-publish-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const keys = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const bytes = Buffer.from("shared package fixture");
  const artifact = { file: "codey-0.1.5.tgz", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  const manifestPath = path.join(root, "codey-package.json");
  const source = { name: "codey", artifact,
    codey: { version: "0.1.5", commit: "a".repeat(40), entrySha256: "b".repeat(64), lockSha256: "c".repeat(64) } };
  await writeFile(manifestPath, JSON.stringify(source));
  await writeFile(path.join(root, artifact.file), bytes);
  await writeFile(path.join(root, "validation.json"), '{"passed":true}');
  const options = { manifestPath, output: path.join(root, "feed"), privateKey: keys.privateKey, sequence: 1 };
  await assert.rejects(createNodeUpdateRelease({ ...options, platform: "windows-x64" }), /shared/);
  source.runtimePlatforms = ["linux-x64", "windows-x64"];
  await writeFile(manifestPath, JSON.stringify(source));
  const linux = await createNodeUpdateRelease(options);
  const windows = await createNodeUpdateRelease({ ...options, platform: "windows-x64", sequence: 2 });
  assert.notEqual(windows.releaseId, linux.releaseId);
  const catalog = new NodeUpdateCatalog({ root: options.output, publicKey: keys.publicKey });
  const rows = await catalog.list();
  assert.deepEqual(rows.map(row => row.release.platform), ["windows-x64", "linux-x64"]);
  assert.equal(rows[0].release.components.codey.sha256, rows[1].release.components.codey.sha256);
  await assert.rejects(createNodeUpdateRelease({ ...options, platform: "windows-x64", sequence: 3 }), /immutable/);
  const renewed = await createNodeUpdateRelease({ ...options, platform: "windows-x64", sequence: 3,
    releaseId: "codey-windows-reauthorized" });
  assert.equal(renewed.releaseId, "codey-windows-reauthorized");
  assert.equal((await catalog.get(renewed.releaseId)).release.components.codey.sha256, artifact.sha256);
  assert.throws(() => validateNodeRelease({ ...rows[0].release, components: {
    cloudcli: { ...rows[0].release.components.codey, file: "cloudcli.tar.gz" },
  } }));
});

test("Mac publisher binds the actual tarball architecture and native doctor evidence, with separate ARM/Intel IDs", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codey-mac-publish-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const keys = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const app = await packageFixture(path.join(root, "candidate"), "0.1.5");
  const build = JSON.parse(await readFile(path.join(app, "codey-build.json")));
  const file = await packFixture(app, path.join(root, "codey-0.1.5.tgz"));
  const bytes = await readFile(file);
  const source = { name: "codey", runtimePlatforms: build.runtimePlatforms,
    artifact: { file: path.basename(file), size: bytes.length, sha256: digest(bytes) },
    codey: { version: build.version, commit: build.sourceCommit, lockSha256: build.lockSha256,
      entrySha256: digest(await readFile(path.join(app, "codey-build.json"))) } };
  const manifestPath = path.join(root, "codey-package.json");
  await jsonFile(manifestPath, source);
  await jsonFile(path.join(root, "validation.json"), { passed: true });
  const options = { manifestPath, output: path.join(root, "feed"), privateKey: keys.privateKey,
    platform: "macos-arm64", sequence: 1 };
  await assert.rejects(createNodeUpdateRelease(options), /macOS native validation/);
  const doctor = { ok: true, platform: options.platform, version: "0.1.5", nodeMajor: 24,
    sourceCommit: build.sourceCommit, lockSha256: build.lockSha256, entrySha256: source.codey.entrySha256,
    native: { sqlite: true, bcrypt: true, ripgrep: true, pty: true, codexSdk: true } };
  const proof = path.join(root, "doctor-macos-arm64.json");
  for (const patch of [{ platform: "linux-x64" }, { nodeMajor: 22 }, { entrySha256: "a".repeat(64) },
    { native: { ...doctor.native, pty: false } }]) {
    await jsonFile(proof, { ...doctor, ...patch });
    await assert.rejects(createNodeUpdateRelease(options), /native validation does not match/);
  }
  await jsonFile(proof, doctor);
  const arm = await createNodeUpdateRelease(options);
  await jsonFile(path.join(root, "doctor-macos-x64.json"), { ...doctor, platform: "macos-x64" });
  const intel = await createNodeUpdateRelease({ ...options, platform: "macos-x64", sequence: 2 });
  assert.notEqual(arm.releaseId, intel.releaseId);
  const catalog = new NodeUpdateCatalog({ root: options.output, publicKey: keys.publicKey });
  const rows = await catalog.list();
  assert.deepEqual(rows.map(row => row.release.platform), ["macos-x64", "macos-arm64"]);
  assert.ok(rows.every(row => row.release.components.codey.sha256 === source.artifact.sha256));
  assert.throws(() => validateNodeRelease({ ...rows[0].release, components: {
    cloudcli: { ...rows[0].release.components.codey, file: "cloudcli.tar.gz" },
  } }));

  // A source manifest claiming four platforms cannot authorize two-platform bytes.
  await jsonFile(path.join(app, "codey-build.json"), { ...build, runtimePlatforms: ["linux-x64", "windows-x64"] });
  await packFixture(app, file);
  const oldBytes = await readFile(file);
  await jsonFile(manifestPath, { ...source,
    artifact: { ...source.artifact, sha256: digest(oldBytes), size: oldBytes.length },
    codey: { ...source.codey, entrySha256: digest(await readFile(path.join(app, "codey-build.json"))) } });
  await assert.rejects(createNodeUpdateRelease({ ...options, sequence: 3 }), /macOS platform\/build fingerprints differ/);
});
