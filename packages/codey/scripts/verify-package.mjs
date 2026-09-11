import { stat } from "node:fs/promises";

for (const name of [
  "npm-shrinkwrap.json", "codey-build.json", "dist-server/server/index.js",
  "dist/index.html", "gateway/main.js", "pages/index.html", "lib/codex-sdk/index.js",
  "lib/setup.mjs", "onboarding/scripts/install.sh", "onboarding/templates/a100-models.json",
  "lib/package-info.mjs", "lib/doctor.mjs",
  "lib/update.mjs", "lib/update-files.mjs", "lib/update-archive.mjs",
  "lib/update-probe.mjs", "lib/update-service.py", "lib/update-windows.ps1",
]) {
  try {
    if (!(await stat(new URL(`../${name}`, import.meta.url))).isFile()) throw new Error("Not a file");
  } catch {
    throw new Error(`Missing ${name}. Build from the repository with npm run codey:build; do not pack the source scaffold.`);
  }
}
