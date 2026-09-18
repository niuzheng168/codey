#!/usr/bin/env node
// Compatibility entry: the installation workflow is shared across all platforms.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Installer, HELP, installOptions } from "./install-machine.mjs";
export { Installer, HELP, installOptions } from "./install-machine.mjs";
export { macPortPreflight } from "./platform-macos.mjs";
export { modelConfiguration, readPackage } from "./machine-package.mjs";
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = installOptions(process.argv.slice(2));
  if (options.help) console.log(HELP);
  else {
    process.umask(0o077);
    await new Installer(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")).apply(options)
      .catch(() => { console.error("Installation failed; inspect the private installation state."); process.exitCode = 1; });
  }
}
