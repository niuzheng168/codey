import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { verifyDependencyBinding } from "../packages/codey/lib/update-dependencies.mjs";

async function pythonRecord(lock, modules) {
  const script = `import json, sys
from pathlib import Path
sys.path.insert(0, str(Path("node-updater").resolve()))
import engine
value = json.load(sys.stdin)
record = engine.dependency_record(value["lock"], value["modules"], value["abi"])
engine.validate_dependency_record(record, value["lock"], value["abi"])
print(json.dumps(record, ensure_ascii=False))
`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.CODEY_TEST_PYTHON || (process.platform === "win32" ? "python" : "python3"),
      ["-X", "utf8", "-I", "-B", "-c", script], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const output = [], errors = [];
    const timer = setTimeout(() => { child.kill(); reject(new Error("Python binding fixture timed out")); }, 15000);
    child.stdout.on("data", chunk => output.push(chunk));
    child.stderr.on("data", chunk => errors.push(chunk));
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(Buffer.concat(errors).toString()));
      try { resolve(JSON.parse(Buffer.concat(output).toString())); } catch (error) { reject(error); }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify({ lock, modules, abi: process.versions.modules }));
  });
}

test("Python Portal dependency records match the actual CLI graph hash and binding contract", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "codey-py-binding-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const root = path.join(home, "candidate"), donor = path.join(home, "retained", "node_modules");
  await mkdir(root, { recursive: true, mode: 0o700 });
  await mkdir(donor, { recursive: true, mode: 0o700 });
  const modules = await realpath(donor);
  const lock = {
    version: "0.1.8", lockfileVersion: 3, name: "codey",
    packages: {
      "node_modules/fixture": { integrity: "sha512-中文", optional: false, version: "1.0.0",
        metadata: { "🧪": "unicode", "中文": "保留", "10": "ten", "2": "two" } },
      "": { version: "0.1.8", dependencies: { fixture: "1.0.0", "10": "1", "2": "1" },
        optionalDependencies: { optional: "2.0.0" } },
    },
  };
  const record = await pythonRecord(lock, modules);
  assert.equal(record.platform, "linux");
  assert.equal(record.arch, "x64");
  assert.equal(record.abi, process.versions.modules);
  assert.equal(record.modules, modules);
  assert.deepEqual(Object.keys(record).sort(),
    ["abi", "arch", "dependencySha256", "modules", "platform", "schema"]);
  const previous = structuredClone(lock);
  previous.version = previous.packages[""].version = "0.1.6";
  assert.equal((await pythonRecord(previous, modules)).dependencySha256, record.dependencySha256);

  // Only platform fields are adapted when this format fixture runs on Windows.
  // On Linux this is the unchanged Python-generated production record.
  const nativeRecord = { ...record, platform: process.platform, arch: process.arch };
  const file = path.join(root, "codey-dependency-link.json");
  await writeFile(file, JSON.stringify(nativeRecord), { mode: 0o600 });
  await symlink(modules, path.join(root, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  assert.equal(await verifyDependencyBinding(root, lock, { home }), modules);
  const unrelated = path.join(home, "unrelated");
  await mkdir(unrelated, { mode: 0o700 });
  for (const change of [{ abi: "wrong" }, { dependencySha256: "0".repeat(64) },
    { modules: path.dirname(home) }, { modules: unrelated }]) {
    await writeFile(file, JSON.stringify({ ...nativeRecord, ...change }));
    await assert.rejects(verifyDependencyBinding(root, lock, { home }));
  }
  await writeFile(file, JSON.stringify(nativeRecord));
  const changed = structuredClone(lock);
  changed.packages["node_modules/fixture"].version = "2.0.0";
  await assert.rejects(verifyDependencyBinding(root, changed, { home }));
});
