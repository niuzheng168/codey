import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

test("standalone machine scripts enforce topology, native platform, identity, archive and export boundaries", async () => {
  await promisify(execFile)(process.env.PYTHON || (process.platform === "win32" ? "python" : "python3"), ["test/machine-scripts.py"]);
});
