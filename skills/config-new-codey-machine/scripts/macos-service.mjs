#!/usr/bin/env node
/** Owner-only LaunchAgent worker; installation is handled by install-machine.mjs. */
import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkedPath, digest, readPrivate, requireValue } from "./machine-common.mjs";
export { InstallationError, checkedPath, digest, directory, exists, readPrivate, requireValue, run, writePrivate } from "./machine-common.mjs";
export const COMPONENTS = Object.freeze(["codey", "tunnel", "renew"]);
export function label(nodeId, component) {
  requireValue(/^n-[a-f0-9]{24}$/.test(nodeId) && COMPONENTS.includes(component));
  return `com.codey.machine.${nodeId}.${component}`;
}
export function agentDefinition(config, file, component) {
  const value = {
    Label: label(config.nodeId, component),
    ProgramArguments: config.tunnelAuth?.source === "gh" && component !== "codey" ?
      [config.nodeExe, path.join(config.codeyDirectory, "lib/tunnel.mjs"), component === "tunnel" ? "host" : "renew", file] :
      [config.nodeExe, config.workerPath, component, file],
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
export async function runtime(file, { home = os.homedir(), worker = fileURLToPath(import.meta.url) } = {}) {
  home = await realpath(home);
  await checkedPath(file, home);
  const config = await readPrivate(file);
  requireValue(config.schema === 2 && config.kind === "codey-macos-oneclick" && config.workerRuntime === "node" &&
    config.layout === "npm-codey-package" && config.ownerUid === process.getuid() && config.ownerHome === home &&
    ["macos-arm64", "macos-x64"].includes(config.platform) && ["installing", "ready"].includes(config.state));
  requireValue(file === path.join(home, ".config/codey-machine-macos/runtime.json") &&
    config.runtimeRoot === path.join(home, ".local/share/codey-machine-macos"));
  for (const name of ["nodeExe", "devtunnelExe", "workerPath", "helperPath", "registrationHelper",
    ...["commonPath", "authHelperPath", "tunnelAuthHelperPath"].filter(name => config[name])]) {
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
  if (component === "codey") return [config.nodeExe, config.codeyBin, "start", "--foreground",
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
    cwd: component === "cli" ? process.cwd() : config.runtimeRoot,
    env: ["codey", "cli"].includes(component) ? config.environment : config.baseEnvironment });
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
