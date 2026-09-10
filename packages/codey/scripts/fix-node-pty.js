import { chmod } from "node:fs/promises";

// Some node-pty macOS prebuilds omit the spawn helper's executable bit.
if (process.platform === "darwin") {
  for (const arch of ["arm64", "x64"]) {
    try {
      await chmod(new URL(`../node_modules/node-pty/prebuilds/darwin-${arch}/spawn-helper`, import.meta.url), 0o755);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}
