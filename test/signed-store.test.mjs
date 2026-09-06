import assert from "node:assert/strict";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { replaceSignedFile } from "../src/signed-store.mjs";

async function files(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "codey-replace-test-"));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("codey-replace-test-"));
    await rm(root, { recursive: true, force: true });
  });
  const target = path.join(root, "accounts.json");
  const source = path.join(root, "accounts.json.test-only.tmp");
  await writeFile(target, "old-signed-state");
  await writeFile(source, "new-signed-state");
  return { source, target };
}

test("Windows temporary sharing errors retry the same atomic replacement without deleting old state", async (t) => {
  const { source, target } = await files(t);
  let calls = 0;
  const delays = [];
  await replaceSignedFile(source, target, {
    platform: "win32",
    async renameImpl(from, to) {
      assert.equal(from, source);
      assert.equal(to, target);
      assert.equal(await readFile(target, "utf8"), "old-signed-state");
      calls++;
      if (calls <= 2) throw Object.assign(new Error("test-only sharing violation"), { code: calls === 1 ? "EPERM" : "EBUSY" });
      await rename(from, to);
    },
    async delayImpl(ms) { delays.push(ms); },
  });
  assert.equal(calls, 3);
  assert.deepEqual(delays, [15, 30]);
  assert.equal(await readFile(target, "utf8"), "new-signed-state");
  await assert.rejects(readFile(source), { code: "ENOENT" });
});

test("persistent Windows sharing failure is bounded and retains both the old target and the original error", async (t) => {
  const { source, target } = await files(t);
  const failure = Object.assign(new Error("test-only locked file"), { code: "EPERM" });
  let calls = 0;
  const delays = [];
  await assert.rejects(replaceSignedFile(source, target, {
    platform: "win32",
    async renameImpl() { calls++; throw failure; },
    async delayImpl(ms) { delays.push(ms); },
  }), (error) => error === failure);
  assert.equal(calls, 6);
  assert.deepEqual(delays, [15, 30, 60, 120, 240]);
  assert.equal(await readFile(target, "utf8"), "old-signed-state");
  assert.equal(await readFile(source, "utf8"), "new-signed-state");
});

test("Linux and non-sharing filesystem errors are never retried or converted to non-atomic replacements", async () => {
  for (const [platform, code] of [["linux", "EPERM"], ["darwin", "EBUSY"], ["win32", "EACCES"], ["win32", "EXDEV"], ["win32", "ENOENT"]]) {
    const failure = Object.assign(new Error("test-only filesystem error"), { code });
    let calls = 0;
    await assert.rejects(replaceSignedFile("source.tmp", "target.json", {
      platform,
      async renameImpl() { calls++; throw failure; },
      async delayImpl() { assert.fail("No retry expected"); },
    }), (error) => error === failure);
    assert.equal(calls, 1);
  }
});
