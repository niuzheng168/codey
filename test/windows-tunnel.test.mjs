import test from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("Windows tunnel bootstrap, renewal and owned-process safety checks", () => {
  execFileSync(process.platform === "win32" ? "python" : "python3", [
    "-X", "utf8", "-I", "-B", fileURLToPath(new URL("./test_windows_tunnel.py", import.meta.url)),
  ], { encoding: "utf8", timeout: 60000, windowsHide: true });
});

test("Windows CLI qualified IDs and pre-task resume preserve the same node, tunnel and completed runtime", () => {
  execFileSync(process.platform === "win32" ? "python" : "python3", [
    "-X", "utf8", "-I", "-B", fileURLToPath(new URL("./test_windows_tunnel_resume.py", import.meta.url)),
  ], { encoding: "utf8", timeout: 60000, windowsHide: true });
});
