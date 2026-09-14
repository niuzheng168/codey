#!/usr/bin/env node
// Reuse the reviewed Portal enrollment sources, with shared-package LF normalization.
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MachineUpdates } from "../src/machine-updates.mjs";

export async function buildNativeUpdaters(output) {
  const sourceRoot = fileURLToPath(new URL("../node-updater", import.meta.url));
  for (const platform of ["windows-x64", "macos-arm64", "macos-x64"]) {
    const entries = await MachineUpdates.prototype.sources.call({ sourceRoot }, platform);
    const manifest = JSON.parse(entries.find(entry => entry.name.endsWith("/agent-files.json")).data);
    for (const { name, data } of entries) {
      const relative = name.slice("codey-updater/".length);
      if (relative === "agent-files.json") continue;
      const file = path.join(output, platform, relative);
      const bytes = Buffer.from(data.toString().replaceAll("\r\n", "\n"));
      manifest.files[relative] = createHash("sha256").update(bytes).digest("hex");
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await writeFile(file, bytes, { mode: 0o600, flag: "wx" });
    }
    await writeFile(path.join(output, platform, "agent-files.json"), JSON.stringify(manifest) + "\n",
      { mode: 0o600, flag: "wx" });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  Promise.resolve().then(async () => {
    if (process.argv.length !== 3) throw new Error("Usage: build-native-updaters.mjs OUTPUT");
    await buildNativeUpdaters(path.resolve(process.argv[2]));
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
