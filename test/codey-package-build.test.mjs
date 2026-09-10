import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

test("Codey npm format, local npm installation and machine publication contract", { timeout: 120000 }, async () => {
  await promisify(execFile)(process.env.PYTHON || (process.platform === "win32" ? "python" : "python3"),
    ["-I", "-B", "test/codey_package.py"], { maxBuffer: 4 * 1024 * 1024 });
});
