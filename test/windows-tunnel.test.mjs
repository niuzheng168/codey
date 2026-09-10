import test from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("Windows native Codex pins survive Desktop cache changes and ready-node repairs preserve identity", () => {
  execFileSync(process.platform === "win32" ? "python" : "python3", [
    "-X", "utf8", "-I", "-B", fileURLToPath(new URL("./test_windows_codex_runtime.py", import.meta.url)),
  ], { encoding: "utf8", timeout: 90000, windowsHide: true });
});
