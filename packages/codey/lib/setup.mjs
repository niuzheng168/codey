import { spawn } from "node:child_process";
import { createHash, createPublicKey } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const version = /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/;
const sha256 = /^[a-f0-9]{64}$/;

export const SETUP_HELP = `Usage: codey setup [--config FILE] [--check]

Configure this installed Codey npm package as a Linux x64 managed node.
Uses onboarding/setup.json from a machine build, or an explicit public config.
--check validates the package/configuration without installing tools, stopping
processes, writing credentials, contacting models, or changing system services.
Without --check, setup replaces Codey service/model configuration and stops
the current user's old Codex processes. Auth and session files are retained.
`;

export function setupOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const name = args[index];
    if (name === "--help" || name === "-h") return { help: true };
    if (name === "--check" && !options.check) options.check = true;
    else if (name === "--config" && !options.config && args[index + 1] && !args[index + 1].startsWith("--")) {
      options.config = path.resolve(args[++index]);
    } else throw new Error(`Invalid setup option: ${name}`);
  }
  return options;
}

/** Public deployment configuration only; never accept an owner or node credential. */
export function validateSetupConfig(config) {
  const fields = ["schema", "portalOrigin", "platform", "network", "tunnelAuthProvider", "updater"];
  if (!config || typeof config !== "object" || Array.isArray(config) ||
      Object.keys(config).some(key => !fields.includes(key)) ||
      config.schema !== 1 || config.platform !== "linux-x64" ||
      JSON.stringify(config.network) !== '{"mode":"devtunnel"}' ||
      config.tunnelAuthProvider !== "github" || config.updater?.protocol !== 1 ||
      Object.keys(config.updater).some(key => !["protocol", "releasePublicKey"].includes(key))) {
    throw new Error("Invalid public Codey setup configuration");
  }
  const origin = new URL(config.portalOrigin);
  if (origin.protocol !== "https:" || origin.origin !== config.portalOrigin || origin.username || origin.password) {
    throw new Error("Setup requires an exact HTTPS Portal origin");
  }
  const key = config.updater.releasePublicKey;
  if (typeof key !== "string" || key.length > 8192 ||
      !key.startsWith("-----BEGIN PUBLIC KEY-----\n") || key.includes("PRIVATE KEY")) {
    throw new Error("Setup requires the updater public key, not a private key");
  }
  if (createPublicKey(key).asymmetricKeyType !== "ed25519") {
    throw new Error("The Codey updater requires an Ed25519 public key");
  }
  return config;
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
    "onboarding/scripts/install.sh", "onboarding/templates/a100-models.json",
    "updater/install.py", "updater/updater.py", "updater/engine.py", "updater/probe.mjs",
  ]) {
    if (!(await stat(path.join(root, name))).isFile()) throw new Error(`Missing Codey setup file: ${name}`);
  }
  let config;
  try {
    config = JSON.parse(await readFile(configFile ?? path.join(root, "onboarding/setup.json"), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") throw new Error("No Portal setup configuration. Use a machine npm build or codey setup --config FILE.");
    if (error instanceof SyntaxError) throw new Error("Setup configuration must be valid JSON");
    throw error;
  }
  validateSetupConfig(config);
  const entrySha256 = digest(buildRaw);
  const releaseId = `machine-${entrySha256.slice(0, 16)}`;
  const manifest = {
    schema: 2, name: "codey", platform: "linux-x64", node: nodeVersion, releaseId,
    dependencyMode: "npm-installed", artifacts: [],
    codey: { version: pkg.version, commit: build.sourceCommit, entrySha256, lockSha256: build.lockSha256 },
    cloudcli: build.cloudcli, copilotApi: build.copilotApi,
    bundledRuntimes: ["cloudcli", "copilot-api", "updater"],
    downloadedOfficialRuntimes: ["node", "codex", "devtunnel"],
  };
  return { root, manifest, setup: { ...config, releaseId } };
}

export async function runSetup(root, args, { spawnProcess = spawn, home = os.homedir() } = {}) {
  const options = setupOptions(args);
  if (options.help) return console.log(SETUP_HELP);
  if (process.platform !== "linux" || process.arch !== "x64") throw new Error("Managed setup supports Linux x64 only");
  const prepared = await installedSetup(root, options.config);
  home = await realpath(home);
  const allowed = [".local/share", ".local/lib/node_modules", ".npm-global/lib/node_modules", ".nvm/versions/node"];
  if (process.getuid() === 0 || (await stat(prepared.root)).uid !== process.getuid() ||
      !allowed.some(name => prepared.root.startsWith(path.join(home, name) + path.sep)) ||
      [prepared.root, home, process.execPath].some(value => /[\s%$"'\\]/.test(value))) {
    throw new Error("Managed setup requires a user-owned package under a supported HOME npm prefix without spaces or systemd metacharacters. Use the one-click installer or npm install --global --prefix \"$HOME/.local\".");
  }
  if (options.check) {
    console.log(JSON.stringify({
      ok: true, name: "codey", version: prepared.manifest.codey.version,
      platform: "linux-x64", portalOrigin: prepared.setup.portalOrigin,
      releaseId: prepared.manifest.releaseId, serviceChanges: false,
    }));
    return;
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), "codey-npm-setup-"));
  try {
    const checksums = [];
    for (const [name, document] of [["manifest.json", prepared.manifest], ["setup.json", prepared.setup]]) {
      const bytes = JSON.stringify(document, null, 2) + "\n";
      await writeFile(path.join(directory, name), bytes, { mode: 0o600 });
      checksums.push(`${digest(bytes)}  ${name}`);
    }
    await writeFile(path.join(directory, "SHA256SUMS"), checksums.join("\n") + "\n", { mode: 0o600 });
    const child = spawnProcess("bash", [path.join(prepared.root, "onboarding/scripts/install.sh")], {
      stdio: "inherit", shell: false,
      env: { ...process.env, CODEY_INSTALLED_PACKAGE: prepared.root,
        CODEY_SETUP_ASSETS: directory, CODEY_SETUP_NODE: process.execPath },
    });
    const interrupt = () => child.kill("SIGINT");
    const terminate = () => child.kill("SIGTERM");
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", terminate);
    try {
      process.exitCode = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => resolve(code ?? (signal === "SIGINT" ? 130 : 143)));
      });
    } finally {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", terminate);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
