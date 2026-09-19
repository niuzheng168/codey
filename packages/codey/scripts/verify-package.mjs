import { stat } from "node:fs/promises";

for (const name of [
  "npm-shrinkwrap.json", "codey-build.json", "dist-server/server/index.js",
  "dist/index.html", "gateway/main.js", "pages/index.html", "lib/codex-sdk/index.js",
  "lib/install.mjs", "lib/workspace.mjs", "onboarding/scripts/install.sh",
  "onboarding/templates/a100-models.json", "onboarding/templates/codex-config.toml",
  "onboarding/scripts/linux-preflight.sh", "onboarding/scripts/windows-runtime.mjs",
  "onboarding/scripts/github-auth.mjs", "onboarding/scripts/github-tunnel.mjs",
  "lib/copilot-auth.mjs", "lib/tunnel.mjs",
  "lib/machine-update.mjs", "lib/machine-update-job.mjs",
  "onboarding/scripts/install-devtunnel-health.sh", "onboarding/scripts/linux-devtunnel-health.mjs",
  "lib/package-info.mjs", "lib/doctor.mjs",
  "lib/package-files.mjs", "lib/package-archive.mjs", "lib/package-dependencies.mjs",
]) {
  try {
    if (!(await stat(new URL(`../${name}`, import.meta.url))).isFile()) throw new Error("Not a file");
  } catch {
    throw new Error(`Missing ${name}. Build from the repository with npm run codey:build; do not pack the source scaffold.`);
  }
}
