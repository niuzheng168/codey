import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { committedUiSource } from "../scripts/build-cloudcli-ui.mjs";
import { mainSource } from "./release-source-fixture.mjs";

test("UI provenance binds every input to the main gitlink, allowing only the Codey version substitution", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codey-ui-source-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = mainSource({ version: "0.2.0" });
  for (const dir of ["src", "shared", "public"]) await mkdir(path.join(root, dir));
  const names = [
    "src/app.js", "shared/types.ts", "public/sw.js", "index.html", "package.json", "package-lock.json",
    "vite.config.js", "tsconfig.json", "tailwind.config.js", "postcss.config.js", "vitest.config.ts", "vitest.setup.ts",
  ];
  const files = {};
  const packageJson = JSON.stringify({ name: "cloudcli", version: "1.0.0", scripts: { build: "reviewed" } });
  for (const name of names) {
    const body = name === "package.json" ? packageJson : "committed fixture";
    await writeFile(path.join(root, name), body);
    files[name] = createHash("sha256").update(body).digest("hex");
  }
  assert.equal(await committedUiSource(root), null); // Readable local preview, not publishable.
  const file = path.join(root, ".codey-component-source.json");
  const proof = { schema: 1, component: "cloudcli", source, files, packageJson };
  await writeFile(file, JSON.stringify(proof));
  assert.deepEqual(await committedUiSource(root), source);
  await writeFile(path.join(root, "package.json"), JSON.stringify({ ...JSON.parse(packageJson), version: "0.2.0" }));
  assert.deepEqual(await committedUiSource(root), source);
  await writeFile(path.join(root, "package.json"), JSON.stringify({ ...JSON.parse(packageJson), scripts: { build: "unmerged" } }));
  await assert.rejects(committedUiSource(root), /source changed/);
  await writeFile(path.join(root, "package.json"), packageJson);
  await writeFile(path.join(root, "src/extra.js"), "untracked");
  await assert.rejects(committedUiSource(root), /input files changed/);
  await rm(path.join(root, "src/extra.js"));
  const original = await readFile(path.join(root, "src/app.js"));
  await writeFile(path.join(root, "src/app.js"), "unmerged");
  await assert.rejects(committedUiSource(root), /source changed/);
  await writeFile(path.join(root, "src/app.js"), original);
  await writeFile(file, JSON.stringify({ ...proof, source: { ...source, sourceDirty: true } }));
  await assert.rejects(committedUiSource(root), /main provenance/);
  await rm(file);
  await symlink(path.join(root, "package.json"), file);
  await assert.rejects(committedUiSource(root), /Invalid committed/);
});
