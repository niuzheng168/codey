// Reuse the signed queue, locked npm staging and receipt logic, not a Windows
// task or a systemd service. All macOS service actions go through native.py.
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Runtime as PackageRuntime, controlEnvironment, execute, fileHash, ownedPath } from "../windows/runtime.mjs";
import { readJson, requireValue, UpdateError, validateConfig as validateNativeConfig } from "../windows/client.mjs";

export const directory = path.dirname(fileURLToPath(import.meta.url));
export const PLATFORMS = Object.freeze(["macos-arm64", "macos-x64"]);
export const validateConfig = value => validateNativeConfig(value, { platforms: PLATFORMS });

export class Runtime extends PackageRuntime {
  constructor(config, options = {}) {
    super(config, options);
    requireValue(PLATFORMS.includes(config.platform), "unsupported_platform");
    this.platform = config.platform;
    this.runtimeFile = path.join(this.home, ".config/codey-machine-macos/runtime.json");
  }
  environment(config) { return config.environment; }
  async native(action, input = this.runtimeFile) {
    if (this.nativeOverride) return this.nativeOverride(action, input);
    requireValue(process.platform === "darwin" && this.platform === `macos-${process.arch}` &&
      process.getuid() !== 0, "unsupported_platform");
    await ownedPath(this.runtimeFile, this.home);
    const bindingFile = path.join(this.private, "binding.json");
    await ownedPath(bindingFile, this.home);
    const config = await readJson(this.runtimeFile), binding = await readJson(bindingFile);
    requireValue(binding.schema === 1 && binding.platform === this.platform &&
      binding.nodeId === this.config.nodeId && binding.ownerId === this.config.ownerId &&
      binding.ownerUid === process.getuid() && binding.ownerHome === this.home &&
      config.pythonExe === binding.pythonExe && config.nodeExe === binding.nodeExe);
    const python = await realpath(binding.pythonExe);
    const info = await stat(python);
    requireValue(path.isAbsolute(python) && [0, process.getuid()].includes(info.uid) && !(info.mode & 0o022) &&
      await fileHash(python) === binding.pythonSha256);
    let output;
    try {
      output = await this.command(python, ["-I", "-S", "-B", path.join(directory, "native.py"), action, input], {
        env: controlEnvironment(this.home), cwd: this.home,
        timeout: ["apply", "verify", "recover"].includes(action) ? 900000 : 90000,
      });
    } catch (error) {
      // execute() retains the child's bounded, sanitized JSON on failure.
      // Never turn a refused busy/ownership check into an apparent success.
      if (typeof error.cause?.stdout !== "string") throw error;
      let failure;
      try { failure = JSON.parse(error.cause.stdout); } catch { throw error; }
      if (failure.ok !== false) throw error;
      throw new UpdateError(failure.code || "operation_failed");
    }
    const result = JSON.parse(output);
    if (!result.ok) throw new UpdateError(result.code || "operation_failed");
    return result;
  }
}

export async function checkHost(runtime) {
  const file = path.join(runtime.private, "agent.lock");
  await ownedPath(file, runtime.home);
  const host = JSON.parse(await readFile(file, "utf8"));
  requireValue(host.pid === process.ppid && host.nonce === process.env.CODEY_UPDATER_HOST_TOKEN &&
    /^[a-f0-9]{32}$/.test(host.nonce));
}

export { controlEnvironment, execute };
