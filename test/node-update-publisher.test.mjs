import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createNodeUpdateRelease } from "../scripts/publish-node-update.mjs";
import { NodeUpdateCatalog, validateNodeRelease } from "../src/node-update-release.mjs";

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
