import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assertLinuxCodexAvailable } from "../skills/config-new-codey-machine/scripts/platform-linux.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "codey-codex-processes-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const procRoot = path.join(root, "proc"), target = path.join(root, "codey-codex");
  await mkdir(procRoot);
  await mkdir(target);
  const processFile = async (id, home, { parent = 1, start = 123, codeyHome = true } = {}) => {
    const directory = path.join(procRoot, String(id));
    await mkdir(directory, { recursive: true });
    const fields = ["S", String(parent), ...Array(17).fill("0"), String(start)];
    await writeFile(path.join(directory, "stat"), `${id} (codex) ${fields.join(" ")}\n`);
    await writeFile(path.join(directory, "environ"), home ? `${codeyHome ? "CODEX_HOME" : "HOME"}=${home}\0` : "");
  };
  await processFile(99, target);
  const f = { root, procRoot, target, processFile, candidates: [123], calls: [] };
  f.check = () => assertLinuxCodexAvailable(target, { procRoot, pid: 99, uid: 1000, execute: async (file, args) => {
    f.calls.push([file, ...args]);
    assert.equal(file, "/usr/bin/pgrep");
    return { code: f.candidates.length ? 0 : 1, stdout: f.candidates.join("\n") };
  } });
  return f;
}

test("Linux installation allows another service's independent Codex home without stopping it", async t => {
  const f = await fixture(t);
  await f.processFile(123, path.join(f.root, "niuma/codex"));
  await f.check();
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls.every(([file]) => file === "/usr/bin/pgrep"));
});

test("Linux installation rejects a Codex process sharing or overlapping the target home", async t => {
  const f = await fixture(t);
  for (const home of [f.target, path.join(f.target, "child"), f.root]) {
    await f.processFile(123, home);
    await assert.rejects(f.check(), /Close Codex\/Desktop yourself/);
  }
});

test("Linux Codex conflict checks resolve owner symlinks and the default HOME/.codex", async t => {
  const f = await fixture(t), alias = path.join(f.root, "alias");
  await symlink(f.target, alias);
  await f.processFile(123, alias);
  await assert.rejects(f.check(), /Close Codex\/Desktop yourself/);
  const owner = path.join(f.root, "owner");
  await mkdir(owner);
  await symlink(f.target, path.join(owner, ".codex"));
  await f.processFile(123, owner, { codeyHome: false });
  await assert.rejects(f.check(), /Close Codex\/Desktop yourself/);
});

test("Linux Codex checks never permit running the installer below Codex, even with an isolated home", async t => {
  const f = await fixture(t);
  await f.processFile(99, f.target, { parent: 123 });
  await f.processFile(123, path.join(f.root, "other"));
  await assert.rejects(f.check(), /external terminal/);
});

test("Linux Codex checks fail closed on unknown/relative home and unreadable process status", async t => {
  const f = await fixture(t);
  await f.processFile(123, "");
  await assert.rejects(f.check(), /Cannot determine/);
  await f.processFile(123, "relative");
  await assert.rejects(f.check(), /Cannot determine/);
  await writeFile(path.join(f.procRoot, "123/stat"), "unreadable status");
  await assert.rejects(f.check(), /Cannot inspect/);
});

test("Linux Codex checks tolerate a process that exited and no running Codex", async t => {
  const f = await fixture(t);
  await f.check();
  f.candidates = [];
  await f.check();
});

test("Linux Codex checks reject failed or malformed pgrep output without executing other commands", async () => {
  for (const result of [{ code: 2, stdout: "" }, { code: 0, stdout: "bad pid" }]) {
    await assert.rejects(assertLinuxCodexAvailable("/owner/codey", { execute: async () => result }), /Cannot inspect/);
  }
});
