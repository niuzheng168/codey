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

export async function checkNativeModules(root) {
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
  const terminal = require("node-pty").spawn(process.execPath, ["-e", "process.exit(0)"], {
    name: "xterm-color", cols: 80, rows: 24, cwd: root, env: process.env,
  });
  await new Promise((resolve, reject) => {
    const output = terminal.onData(() => {});
    const timer = setTimeout(() => {
      try { terminal.kill(); } catch { /* The owned probe may have already exited. */ }
      output.dispose();
      reject(new Error("PTY native check timed out"));
    }, 10000);
    terminal.onExit(({ exitCode }) => {
      clearTimeout(timer);
      output.dispose();
      if (exitCode === 0) resolve();
      else reject(new Error("PTY native check failed"));
    });
  });
  return { sqlite: true, bcrypt: true, ripgrep: true, pty: true, codexSdk: true };
}

export async function runDoctor(root, args, {
  platform = process.platform, arch = process.arch, nativeCheck = checkNativeModules, log = console.log,
} = {}) {
  const options = doctorOptions(args);
  if (options.help) return log(DOCTOR_HELP);
  const target = runtimePlatform(platform, arch);
  const { pkg, build, entrySha256 } = await readPackageInfo(root);
  const native = options.packageOnly ? null : await nativeCheck(root);
  const result = {
    ok: true, name: "codey", version: pkg.version, platform: target,
    runtimePlatforms: build.runtimePlatforms, sourceCommit: build.sourceCommit,
    entrySha256, lockSha256: build.lockSha256, native,
    managedSetupSupported: target === "linux-x64", serviceChanges: false, modelRequests: false,
  };
  log(JSON.stringify(result, null, options.json ? 0 : 2));
  return result;
}
