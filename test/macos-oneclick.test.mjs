import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { promisify } from "node:util";

test("Mac one-click native layout, registration export, recovery and failure fixtures", {
  skip: process.platform === "win32", timeout: 120000,
}, async () => {
  const result = await promisify(execFile)(process.env.PYTHON || "python3", [
    "-I", "-B", "test/test_macos_oneclick.py",
  ], { timeout: 115000, maxBuffer: 2 * 1024 * 1024 });
  assert.match(result.stderr, /OK/);
});
