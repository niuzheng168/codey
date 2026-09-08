import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

test("standalone machine scripts enforce topology, native platform, identity, archive and export boundaries", async () => {
  await promisify(execFile)(process.env.PYTHON || (process.platform === "win32" ? "python" : "python3"),
    ["-X", "utf8", "-I", "-B", "test/machine-scripts.py"]);
});

test("Mac native installer and scoped renewal preserve runtime, credentials and archive boundaries",
  { skip: process.platform === "win32" }, async () => {
    await promisify(execFile)(process.env.PYTHON || "python3", ["-I", "-B", "test/test_macos_node.py"]);
  });
