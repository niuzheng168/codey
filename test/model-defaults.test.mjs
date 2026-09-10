import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import test from "node:test";
import { MACHINE_PLATFORMS } from "../src/machine-platforms.mjs";

test("A100 defaults preserve configuration, ownership, credentials and plan/apply boundaries", async () => {
  await promisify(execFile)(process.env.PYTHON || (process.platform === "win32" ? "python" : "python3"),
    ["-X", "utf8", "-I", "-B", "test/test_model_defaults.py"], { timeout: 120_000 });
});

test("Mac first-install defaults and verification-only reruns are correct with all native operations mocked", async () => {
  await promisify(execFile)(process.env.PYTHON || (process.platform === "win32" ? "python" : "python3"),
    ["-X", "utf8", "-I", "-B", "test/test_model_defaults_macos.py"], { timeout: 120_000 });
});

test("every native first-install package carries the shared defaults modules and exact public catalog", async () => {
  const expected = [
    "templates/a100-models.json",
    "scripts/codey_node/common/config_defaults.py",
    "scripts/codey_node/common/config_files.py",
    "scripts/codey_node/common/toml_edit.py",
  ];
  for (const platform of MACHINE_PLATFORMS) {
    for (const file of expected) {
      assert.equal(platform.files.filter(name => name === file).length, 1, `${platform.id}: ${file}`);
      assert.ok((await readFile(new URL(`../skills/config-new-codey-machine/${file}`, import.meta.url))).length > 0);
    }
  }
  const catalog = await readFile(new URL("../skills/config-new-codey-machine/templates/a100-models.json", import.meta.url));
  assert.equal(createHash("sha256").update(catalog).digest("hex"), "b239fe781d86a0d8bad2f39595e12fb3ecb275600d215d77502be4a11be5fd6d");
  assert.deepEqual(JSON.parse(catalog).models.map(model => model.slug), ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-sol-fast"]);
});
