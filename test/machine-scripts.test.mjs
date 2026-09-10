import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

test("standalone machine scripts enforce topology, native platform, identity, archive and export boundaries", async () => {
  await promisify(execFile)(process.env.PYTHON || (process.platform === "win32" ? "python" : "python3"),
    ["-X", "utf8", "-I", "-B", "test/machine-scripts.py"]);
});

test("Linux DevTunnel installer enforces GitHub, loopback, startup and transaction boundaries", async () => {
  await promisify(execFile)(process.env.PYTHON || (process.platform === "win32" ? "python" : "python3"),
    ["-X", "utf8", "-I", "-B", "test/test_linux_node.py"]);
});

test("copied Python service modules are complete, isolated and verified before import", async () => {
  await promisify(execFile)(process.env.PYTHON || (process.platform === "win32" ? "python" : "python3"),
    ["-X", "utf8", "-I", "-B", "test/test_node_modules.py"]);
});

test("a clean machine can prepare pinned native Codex without Node or model credentials", async () => {
  await promisify(execFile)(process.env.PYTHON || (process.platform === "win32" ? "python" : "python3"),
    ["-X", "utf8", "-I", "-B", "test/test_codex_cli.py"]);
});

test("Mac native installer and scoped renewal preserve runtime, credentials and archive boundaries",
  { skip: process.platform === "win32" }, async () => {
    await promisify(execFile)(process.env.PYTHON || "python3", ["-I", "-B", "test/test_macos_node.py"]);
  });
