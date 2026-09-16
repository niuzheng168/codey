#!/usr/bin/env node
/** Owner-only Node launcher and LaunchAgent worker; no separate runtime or updater. */
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const COMPONENTS = Object.freeze(["codey", "tunnel", "renew"]);
export class InstallationError extends Error {}
export function requireValue(value, message = "Invalid private Codey macOS installation") {
  if (!value) throw new InstallationError(message);
}
export const exists = async file => {
  try { await lstat(file); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
};
export const inside = (home, file) => {
  const relative = path.relative(home, file);
  return relative && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
};
export async function digest(file) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest("hex");
}
export async function checkedPath(file, home, uid = process.getuid()) {
  home = await realpath(home);
  file = path.resolve(file);
  requireValue(inside(home, file), "Path must remain under the original owner's home");
  for (let entry = file; inside(home, entry); entry = path.dirname(entry)) {
    if (!await exists(entry)) continue;
    const info = await lstat(entry);
    requireValue(!info.isSymbolicLink() && info.uid === uid && !(info.mode & 0o022),
      "Unowned, linked or writable installation path");
  }
  return file;
}
export async function directory(file, home) {
  await checkedPath(file, home);
  await mkdir(file, { recursive: true, mode: 0o700 });
  await chmod(file, 0o700);
  return file;
}
export async function readPrivate(file) {
  const info = await lstat(file);
  requireValue(info.isFile() && !info.isSymbolicLink() && info.uid === process.getuid() &&
    !(info.mode & 0o077) && info.size <= 4 * 1024 * 1024);
  return JSON.parse(await readFile(file, "utf8"));
}
export async function writePrivate(file, value) {
  if (await exists(file)) {
    const info = await lstat(file);
    requireValue(info.isFile() && !info.isSymbolicLink() && info.uid === process.getuid(),
      "Refusing to replace a linked or unowned file");
  }
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value, null, 2) + "\n");
  const temporary = file + "." + randomBytes(12).toString("hex") + ".next";
  try {
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; });
  }
}
export function label(nodeId, component) {
  requireValue(/^n-[a-f0-9]{24}$/.test(nodeId) && COMPONENTS.includes(component));
  return `com.codey.machine.${nodeId}.${component}`;
}
export function agentDefinition(config, file, component) {
  const value = {
    Label: label(config.nodeId, component),
    ProgramArguments: [config.nodeExe, config.workerPath, component, file],
    RunAtLoad: true, ProcessType: "Background", ThrottleInterval: 15, Umask: 63,
    WorkingDirectory: config.runtimeRoot,
    StandardOutPath: path.join(config.stateRoot, component + ".log"),
    StandardErrorPath: path.join(config.stateRoot, component + ".log"),
    KeepAlive: true,
  };
  if (component === "renew") Object.assign(value, {
    StartInterval: 21600, KeepAlive: { SuccessfulExit: false }, ThrottleInterval: 120,
  });
  return value;
}
export function plist(value) {
  const xml = text => {
    requireValue(!/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text), "Invalid LaunchAgent text");
    return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  };
  const encode = item => {
    if (typeof item === "string") return `<string>${xml(item)}</string>`;
    if (typeof item === "boolean") return item ? "<true/>" : "<false/>";
    if (Number.isSafeInteger(item)) return `<integer>${item}</integer>`;
    if (Array.isArray(item)) return `<array>${item.map(encode).join("")}</array>`;
    requireValue(item && typeof item === "object", "Invalid LaunchAgent value");
    return `<dict>${Object.entries(item).map(([key, entry]) => `<key>${xml(key)}</key>${encode(entry)}`).join("")}</dict>`;
  };
  return Buffer.from('<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
    `<plist version="1.0">${encode(value)}</plist>\n`);
}
export function run(file, args, { env = process.env, cwd, timeout = 180000, interactive = false, check = true } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args.map(String), { env, cwd, shell: false, detached: !interactive,
      stdio: interactive ? "inherit" : ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", timedOut = false, interrupted = false, forceTimer;
    const stop = signal => {
      try { if (interactive) child.kill(signal); else if (child.pid) process.kill(-child.pid, signal); }
      catch (error) { if (error.code !== "ESRCH") child.kill(signal); }
    };
    const timer = setTimeout(() => { timedOut = true; stop("SIGKILL"); }, timeout);
    const interrupt = signal => {
      if (interrupted) return;
      interrupted = true;
      stop(signal);
      forceTimer = setTimeout(() => stop("SIGKILL"), 10000);
    };
    const onInterrupt = () => interrupt("SIGINT"), onTerminate = () => interrupt("SIGTERM");
    process.on("SIGINT", onInterrupt);
    process.on("SIGTERM", onTerminate);
    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(forceTimer);
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onTerminate);
    };
    for (const [stream, name] of [[child.stdout, "stdout"], [child.stderr, "stderr"]]) {
      stream?.setEncoding("utf8");
      stream?.on("data", bytes => {
        if (name === "stdout") stdout += bytes; else stderr += bytes;
        if (stdout.length + stderr.length > 2 * 1024 * 1024) { timedOut = true; stop("SIGKILL"); }
      });
    }
    child.once("error", () => { cleanup(); reject(new InstallationError(`${path.basename(file)} could not start`)); });
    child.once("close", (code, signal) => {
      cleanup();
      if (timedOut || interrupted || signal || check && code !== 0) {
        reject(new InstallationError(`${path.basename(file)} failed; inspect the private installation state`));
      } else resolve({ code, stdout, stderr });
    });
  });
}
export async function runtime(file, { home = os.homedir(), worker = fileURLToPath(import.meta.url) } = {}) {
  home = await realpath(home);
  await checkedPath(file, home);
  const config = await readPrivate(file);
  requireValue(config.schema === 2 && config.kind === "codey-macos-oneclick" && config.workerRuntime === "node" &&
    config.layout === "npm-codey-package" && config.ownerUid === process.getuid() && config.ownerHome === home &&
    ["macos-arm64", "macos-x64"].includes(config.platform) && ["installing", "ready"].includes(config.state));
  requireValue(file === path.join(home, ".config/codey-machine-macos/runtime.json") &&
    config.runtimeRoot === path.join(home, ".local/share/codey-machine-macos"));
  for (const name of ["nodeExe", "devtunnelExe", "workerPath", "helperPath", "registrationHelper"]) {
    await checkedPath(config[name], config.runtimeRoot);
    requireValue(await digest(config[name]) === config.fileHashes[name], "Native worker/tool fingerprint mismatch");
  }
  requireValue(config.workerPath === await realpath(worker));
  await checkedPath(config.codeyBin, config.runtimeRoot);
  requireValue(await digest(path.join(config.codeyDirectory, "codey-build.json")) === config.codeyEntrySha256);
  return config;
}
export function command(config, component, file, args = []) {
  if (component === "cli") return [config.nodeExe, config.codeyBin, ...args];
  if (component === "codey") return [config.nodeExe, config.codeyBin, "start",
    "--host", "127.0.0.1", "--workspace-port", "3001", "--gateway-port", "4141"];
  if (component === "tunnel") return [config.devtunnelExe, "host", config.qualifiedTunnel,
    "--host-header", "unchanged", "--origin-header", "unchanged"];
  requireValue(component === "renew");
  return [config.nodeExe, config.helperPath, "renew", file];
}
export async function supervise(config, component, file, args = [], { spawnProcess = spawn, signals = process, kill = process.kill } = {}) {
  const [executable, ...argv] = command(config, component, file, args);
  const grouped = component !== "cli";
  const child = spawnProcess(executable, argv, { shell: false, stdio: "inherit", detached: grouped,
    cwd: config.runtimeRoot, env: ["codey", "cli"].includes(component) ? config.environment : config.baseEnvironment });
  let timer;
  const stop = signal => {
    try { if (grouped && child.pid) kill(-child.pid, signal); else child.kill(signal); }
    catch (error) { if (error.code !== "ESRCH") throw error; }
  };
  const terminate = () => {
    if (timer) return;
    stop("SIGTERM");
    timer = setTimeout(() => stop("SIGKILL"), 10000);
    timer.unref();
  };
  const interrupt = () => grouped ? terminate() : stop("SIGINT");
  signals.on("SIGTERM", terminate);
  signals.on("SIGINT", interrupt);
  try {
    return await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve(code ?? (signal === "SIGINT" ? 130 : 143)));
    });
  } finally {
    clearTimeout(timer);
    signals.off("SIGTERM", terminate);
    signals.off("SIGINT", interrupt);
    if (grouped) stop("SIGTERM");
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  (async () => {
    requireValue(process.platform === "darwin" && process.getuid() !== 0);
    const [component, file, ...args] = process.argv.slice(2);
    requireValue([...COMPONENTS, "cli"].includes(component) && file && (component === "cli" || !args.length));
    process.exitCode = await supervise(await runtime(file), component, file, args);
  })().catch(() => {
    console.error("Codey macOS worker failed; inspect the owner-only runtime state.");
    process.exitCode = 1;
  });
}
