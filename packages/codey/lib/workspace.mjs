/** Private CloudCLI worker, started by codey start or the native service. */
import { constants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

async function findCodex() {
  if (process.env.CODEY_CODEX_EXECUTABLE) return process.env.CODEY_CODEX_EXECUTABLE;
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, process.platform === "win32" ? "codex.exe" : "codex");
    try {
      await access(candidate, constants.X_OK);
      return await realpath(candidate);
    } catch { /* Try the next absolute PATH entry, never the package's own dependencies. */ }
  }
  return null;
}

Object.assign(process.env, {
  HOST: process.env.HOST ?? "127.0.0.1",
  SERVER_PORT: process.env.SERVER_PORT ?? "3001",
  CODEY_MANAGED: "true",
});
const codex = await findCodex();
if (codex) process.env.CODEY_CODEX_EXECUTABLE = codex;
const entry = path.join(ROOT, "dist-server/server/index.js");
process.chdir(ROOT);
process.argv = [process.execPath, entry];
await import(pathToFileURL(entry).href);
