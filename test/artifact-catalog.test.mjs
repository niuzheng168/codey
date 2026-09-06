import test from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ArtifactCatalog } from "../src/artifact-catalog.mjs";

function tarEntry(name, content) {
  const body = Buffer.from(content);
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write("0000644\0", 100, 8, "ascii");
  header.write("0000000\0", 108, 8, "ascii");
  header.write("0000000\0", 116, 8, "ascii");
  header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
  header.write("00000000000\0", 136, 12, "ascii");
  header[156] = "0".charCodeAt(0);
  header.write("ustar\0", 257, 6, "ascii");
  const padding = Buffer.alloc(Math.ceil(body.length / 512) * 512 - body.length);
  return Buffer.concat([header, body, padding]);
}

function packageArchive(version = "2.1.11") {
  return gzipSync(
    Buffer.concat([
      tarEntry(
        "package/package.json",
        JSON.stringify({
          name: "@jeffreycao/copilot-api",
          version,
        }),
      ),
      tarEntry(
        "package/dist/server-test.js",
        'const stateFile = "invalid-encrypted-content.json"; const schema = "reasoning_effort TEXT";',
      ),
      Buffer.alloc(1024),
    ]),
  );
}

async function createArtifactDirectory(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "copilot-artifacts-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  return directory;
}

test("artifact catalog validates and returns selectable daily builds", async (t) => {
  const directory = await createArtifactDirectory(t);
  const id = "copilot-api-2.1.11-2026-08-15-zhn";
  await Promise.all([
    writeFile(path.join(directory, `${id}.tgzz`), packageArchive()),
    writeFile(
      path.join(directory, `${id}-CHANGELOG.md`),
      "# Build 2.1.11\n\n- Includes source resilience.",
    ),
  ]);

  const catalog = new ArtifactCatalog(directory);
  const scan = await catalog.scan();
  assert.equal(scan.errors.length, 0);
  assert.equal(scan.artifacts.length, 1);
  assert.deepEqual(
    {
      id: scan.artifacts[0].id,
      version: scan.artifacts[0].version,
      buildDate: scan.artifacts[0].buildDate,
      label: scan.artifacts[0].label,
    },
    {
      id,
      version: "2.1.11",
      buildDate: "2026-08-15",
      label: "zhn",
    },
  );
  assert.match(scan.artifacts[0].changelog, /source resilience/);
  assert.match(scan.artifacts[0].sha256, /^[a-f0-9]{64}$/);
  assert.equal(Object.hasOwn(scan.artifacts[0], "path"), false);

  const resolved = await catalog.resolve(id);
  assert.equal(resolved.path, path.join(directory, `${id}.tgzz`));
  await assert.rejects(() => catalog.resolve("../outside"), /artifactId/);
});

test("artifact catalog isolates invalid packages without hiding valid builds", async (t) => {
  const directory = await createArtifactDirectory(t);
  const validId = "copilot-api-2.1.11-2026-08-15-zhn";
  const invalidId = "copilot-api-2.1.10-2026-08-14-zhn";
  await Promise.all([
    writeFile(path.join(directory, `${validId}.tgz`), packageArchive("2.1.11")),
    writeFile(path.join(directory, `${validId}-CHANGELOG.md`), "valid"),
    writeFile(path.join(directory, `${invalidId}.tgzz`), packageArchive("2.1.9")),
    writeFile(path.join(directory, `${invalidId}-CHANGELOG.md`), "invalid"),
  ]);

  const scan = await new ArtifactCatalog(directory).scan();
  assert.deepEqual(scan.artifacts.map((artifact) => artifact.id), [validId]);
  assert.equal(scan.errors.length, 1);
  assert.equal(scan.errors[0].fileName, `${invalidId}.tgzz`);
  assert.match(scan.errors[0].message, /does not match package version/);
});
