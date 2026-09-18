/** Private bridge from the Linux npm bootstrap to the common installation workflow. */
import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import os from "node:os";
import path from "node:path";

const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const version = /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/;
const sha256 = /^[a-f0-9]{64}$/;

export function installOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const name = args[index];
    if (name === "--check" && !options.check) options.check = true;
    else if (name === "--replace-existing" && !options.replaceExisting) options.replaceExisting = true;
    else if (name === "--expected-computer" && !options.expectedComputer && args[index + 1] && !args[index + 1].startsWith("--")) {
      options.expectedComputer = args[++index];
    }
    else if (name === "--config" && !options.config && args[index + 1] && !args[index + 1].startsWith("--")) {
      options.config = path.resolve(args[++index]);
    } else throw new Error(`Invalid installation option: ${name}`);
  }
  return options;
}

/** Public deployment configuration only; never accept an owner or node credential. */
export function validateSetupConfig(config) {
  const fields = ["schema", "portalOrigin", "platform", "network", "tunnelAuthProvider", "updater"];
  if (!config || typeof config !== "object" || Array.isArray(config) ||
      Object.keys(config).some(key => !fields.includes(key)) ||
      config.schema !== 1 || !["auto", "linux-x64"].includes(config.platform) ||
      JSON.stringify(config.network) !== '{"mode":"devtunnel"}' ||
      config.tunnelAuthProvider !== "github") {
    throw new Error("Invalid public Codey setup configuration");
  }
  const origin = new URL(config.portalOrigin);
  if (origin.protocol !== "https:" || origin.origin !== config.portalOrigin || origin.username || origin.password) {
    throw new Error("Setup requires an exact HTTPS Portal origin");
  }
  if (config.updater !== undefined && (
    !config.updater || config.updater.protocol !== 1 ||
    Object.keys(config.updater).some(key => !["protocol", "releasePublicKey"].includes(key)) ||
    typeof config.updater.releasePublicKey !== "string" || config.updater.releasePublicKey.length > 8192 ||
    !config.updater.releasePublicKey.startsWith("-----BEGIN PUBLIC KEY-----\n") ||
    config.updater.releasePublicKey.includes("PRIVATE KEY"))) {
    throw new Error("Legacy setup may contain only public updater metadata");
  }
  const { updater: _retired, ...setup } = config;
  return setup;
}

export async function installedSetup(root, configFile, nodeVersion = process.versions.node) {
  root = await realpath(root);
  const [packageRaw, buildRaw, lockRaw] = await Promise.all(
    ["package.json", "codey-build.json", "npm-shrinkwrap.json"].map(name => readFile(path.join(root, name))),
  );
  const pkg = JSON.parse(packageRaw);
  const build = JSON.parse(buildRaw);
  if (pkg.name !== "codey" || !version.test(pkg.version) || pkg.version !== build.version ||
      pkg.bin?.codey !== "bin/codey.mjs" || build.name !== "codey" || build.schema !== 1 ||
      !sha256.test(build.lockSha256) || digest(lockRaw) !== build.lockSha256 ||
      !/^[a-f0-9]{40}$/.test(build.sourceCommit ?? "") ||
      !build.cloudcli?.version || !build.copilotApi?.version) {
    throw new Error("Not a complete, locked Codey npm application");
  }
  for (const [name, expected] of [
    ["dist-server/server/index.js", build.workspaceEntrySha256],
    ["gateway/main.js", build.gatewayEntrySha256],
  ]) {
    if (!sha256.test(expected ?? "") || digest(await readFile(path.join(root, name))) !== expected) {
      throw new Error(`Codey build fingerprint mismatch: ${name}`);
    }
  }
  for (const name of [
    "onboarding/scripts/install-machine.mjs", "onboarding/scripts/machine-package.mjs",
    "onboarding/scripts/machine-common.mjs", "onboarding/scripts/machine-resources.mjs",
    "onboarding/scripts/platform-linux.mjs", "onboarding/scripts/platform-macos.mjs",
    "onboarding/scripts/platform-windows.mjs", "onboarding/scripts/platform-unix.mjs",
    "onboarding/scripts/macos-service.mjs", "onboarding/dependencies.json", "onboarding/scripts/registration.mjs",
    "onboarding/templates/a100-models.json", "onboarding/templates/codex-config.toml",
    "onboarding/scripts/install-devtunnel-health.sh", "onboarding/scripts/linux-devtunnel-health.mjs",
    "onboarding/scripts/linux-preflight.sh", "onboarding/scripts/windows-runtime.mjs",
  ]) {
    if (!(await stat(path.join(root, name))).isFile()) throw new Error(`Missing Codey setup file: ${name}`);
  }
  let config;
  try {
    config = JSON.parse(await readFile(configFile ?? path.join(root, "onboarding/setup.json"), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") throw new Error("No Portal setup configuration. Use the complete installation Skill or install-codey-linux.sh --config FILE.");
    if (error instanceof SyntaxError) throw new Error("Setup configuration must be valid JSON");
    throw error;
  }
  config = validateSetupConfig(config);
  const entrySha256 = digest(buildRaw);
  const releaseId = `machine-${entrySha256.slice(0, 16)}`;
  const manifest = {
    schema: 2, name: "codey", platform: "linux-x64", node: nodeVersion, releaseId,
    dependencyMode: "npm-installed", artifacts: [],
    codey: { version: pkg.version, commit: build.sourceCommit, entrySha256, lockSha256: build.lockSha256 },
    cloudcli: build.cloudcli, copilotApi: build.copilotApi,
    bundledRuntimes: ["cloudcli", "copilot-api"],
    downloadedOfficialRuntimes: ["node", "codex", "devtunnel"],
  };
  return { root, manifest, setup: { ...config, platform: manifest.platform, releaseId } };
}

export async function runInstall(root, args, { createInstaller, home = os.homedir() } = {}) {
  const options = installOptions(args);
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error("Managed service setup supports Linux x64 only. Use the complete Skill's native Windows/macOS entrypoints, or codey doctor --runtime-only and codey start --foreground for a runtime-only package.");
  }
  const prepared = await installedSetup(root, options.config);
  home = await realpath(home);
  const allowed = [".local/share", ".local/lib/node_modules", ".npm-global/lib/node_modules", ".nvm/versions/node"];
  if (process.getuid() === 0 || (await stat(prepared.root)).uid !== process.getuid() ||
      !allowed.some(name => prepared.root.startsWith(path.join(home, name) + path.sep)) ||
      [prepared.root, home, process.execPath].some(value => /[\s%$"'\\]/.test(value))) {
    throw new Error("Managed setup requires a user-owned package under a supported HOME npm prefix without spaces or systemd metacharacters. Use the one-click installer.");
  }
  if (!options.check && options.expectedComputer !== os.hostname()) {
    throw new Error("Setup requires --expected-computer matching this machine's exact hostname.");
  }
  const skill = path.join(prepared.root, "onboarding");
  const installer = createInstaller ? await createInstaller(skill, { home, prepared }) :
    new (await import(pathToFileURL(path.join(skill, "scripts/install-machine.mjs")).href)).Installer(skill, { home, prepared });
  return installer.apply({ check: Boolean(options.check), apply: !options.check,
    "network-approved": !options.check, "expected-computer": options.expectedComputer,
    "replace-existing": Boolean(options.replaceExisting) });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.umask(0o077);
  try { await runInstall(fileURLToPath(new URL("../", import.meta.url)), process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
