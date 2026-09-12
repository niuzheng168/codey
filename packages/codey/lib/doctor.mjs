import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { readPackageInfo, runtimePlatform } from "./package-info.mjs";

export const DOCTOR_HELP = `Usage: codey doctor [--package-only] [--json]

Verify the shared Codey package and its locked runtime entrypoints.
By default, also check SQLite, bcrypt, ripgrep, the bundled SDK and a short-lived PTY.
--package-only skips native modules, for validation before npm rebuild.
No service changes, provider login, credentials or model requests.
`;

export function doctorOptions(args) {
  const options = {};
  for (const arg of args) {
    if (["--help", "-h"].includes(arg)) return { help: true };
    const name = arg === "--package-only" ? "packageOnly" : arg === "--json" ? "json" : null;
    if (!name || options[name]) throw new Error(`Invalid doctor option: ${arg}`);
    options[name] = true;
  }
  return options;
}

// Windows node-pty workers can retain handles after onExit. Only this isolated
// probe may explicitly exit; doctor must await its completion and verified result.
const PTY_PROBE = String.raw`
const { createRequire } = require("node:module");
const { writeSync } = require("node:fs");
const path = require("node:path");
const root = process.argv[1];
let terminal, output, exit;
let settled = false, exited = false;
function finish(error) {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  if (!exited) {
    try { terminal?.kill(process.platform === "win32" ? undefined : "SIGKILL"); }
    catch { /* The owned PTY may have already exited. */ }
  }
  for (const subscription of [output, exit]) {
    try { subscription?.dispose(); }
    catch (cause) { error ||= "PTY native check failed: " + cause.message; }
  }
  try { writeSync(error ? 2 : 1, error ? error + "\n" : "codey-pty-ok\n"); }
  finally { process.exit(error ? 1 : 0); }
}
const timer = setTimeout(() => finish("PTY native check timed out"), Number(process.argv[2]));
try {
  terminal = createRequire(path.join(root, "package.json"))("node-pty").spawn(
    process.execPath, ["-e", "process.exit(0)"],
    { name: "xterm-color", cols: 80, rows: 24, cwd: root, env: process.env },
  );
  output = terminal.onData(() => {});
  exit = terminal.onExit(({ exitCode, signal }) => {
    exited = true;
    finish(exitCode === 0 && !signal ? null :
      "PTY native check failed (exit code " + exitCode + ", signal " + (signal || 0) + ")");
  });
} catch (error) { finish("PTY native check failed: " + error.message); }
`;

export async function checkNativeModules(root, { ptyTimeout = 10000 } = {}) {
  const require = createRequire(path.join(root, "package.json"));
  const Database = require("better-sqlite3");
  const db = new Database(":memory:");
  try { db.prepare("SELECT 1").get(); } finally { db.close(); }
  const bcrypt = require("bcrypt");
  if (!bcrypt.compareSync("codey-native-probe", bcrypt.hashSync("codey-native-probe", 4))) {
    throw new Error("bcrypt native check failed");
  }
  await import(pathToFileURL(require.resolve("#codey/codex-sdk")).href);
  await promisify(execFile)(require("@vscode/ripgrep").rgPath, ["--version"], {
    timeout: 10000, maxBuffer: 65536, windowsHide: true,
  });
  let probe;
  try {
    probe = await promisify(execFile)(process.execPath, [
      "--input-type=commonjs", "-e", PTY_PROBE, root, String(ptyTimeout),
    ], {
      cwd: root, timeout: ptyTimeout + 1000, killSignal: "SIGKILL",
      maxBuffer: 65536, windowsHide: true,
    });
  } catch (error) {
    if (error.killed && error.signal === "SIGKILL") {
      throw new Error("PTY native check timed out", { cause: error });
    }
    const detail = error.stderr?.trim();
    throw new Error(detail?.startsWith("PTY native check ") ? detail :
      `PTY native check failed: ${detail || error.code || error.message}`, { cause: error });
  }
  if (probe.stdout.trim() !== "codey-pty-ok") throw new Error("PTY native check failed: missing exit confirmation");
  return { sqlite: true, bcrypt: true, ripgrep: true, pty: true, codexSdk: true };
}

export async function runDoctor(root, args, {
  platform = process.platform, arch = process.arch, nativeCheck = checkNativeModules, log = console.log,
} = {}) {
  const options = doctorOptions(args);
  if (options.help) return log(DOCTOR_HELP);
  const target = runtimePlatform(platform, arch);
  const { pkg, build, entrySha256 } = await readPackageInfo(root, { platform, arch });
  const native = options.packageOnly ? null : await nativeCheck(root);
  const result = {
    ok: true, name: "codey", version: pkg.version, platform: target,
    runtimePlatforms: build.runtimePlatforms, sourceCommit: build.sourceCommit,
    nodeMajor: Number(process.versions.node.split(".")[0]),
    entrySha256, lockSha256: build.lockSha256, native,
    managedSetupSupported: target === "linux-x64", serviceChanges: false, modelRequests: false,
  };
  log(JSON.stringify(result, null, options.json ? 0 : 2));
  return result;
}
