#!/usr/bin/env node
// One installer and one application artifact for Linux x64 and Windows x64.
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile, appendFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_PACKAGE_FILE = "";
const DEFAULT_PACKAGE_SHA256 = "";
const MARKER = "CODEY_SHARED_NPM_LAUNCHER";
const PUBLIC_REGISTRY = "https://registry.npmjs.org";
const HELP = `Usage: node install-codey.mjs [--package FILE.tgz] [--sha256 HASH] [--prefix DIR] [--check]

Install the SAME Codey npm artifact on Linux x64 or Windows x64 using Node.js 22.13+.
A published installer has its adjacent package filename and SHA-256 built in.
Source use requires both --package and --sha256; public npm names are never accepted.
--prefix must be a new directory under the current user's home.
--check installs and verifies the package/native dependencies, but does not change PATH.

No services, DevTunnel, credentials or Codex settings are modified. On Linux, run
codey setup separately for managed deployment; Windows service hosting stays external.
`;

export function installOptions(args, directory = path.dirname(fileURLToPath(import.meta.url))) {
  const options = { package: DEFAULT_PACKAGE_FILE ? path.join(directory, DEFAULT_PACKAGE_FILE) : "",
    sha256: DEFAULT_PACKAGE_SHA256, check: false };
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (["--help", "-h"].includes(flag)) return { help: true };
    if (seen.has(flag)) throw new Error(`Duplicate installer option: ${flag}`);
    seen.add(flag);
    if (flag === "--check") options.check = true;
    else if (["--package", "--sha256", "--prefix"].includes(flag) && args[index + 1] && !args[index + 1].startsWith("--")) {
      options[flag.slice(2)] = args[++index];
    } else throw new Error(`Invalid installer option: ${flag}`);
  }
  if (!options.package.endsWith(".tgz") || /^[a-z]+:/i.test(options.package) && !/^[a-z]:[\\/]/i.test(options.package) ||
      !/^[a-f0-9]{64}$/i.test(options.sha256)) {
    throw new Error("Provide a local Codey .tgz and its SHA-256; do not install the unrelated public npm package.");
  }
  options.sha256 = options.sha256.toLowerCase();
  return options;
}

export function npmPackageRoot(prefix, platform = process.platform) {
  return platform === "win32" ? path.win32.join(prefix, "node_modules", "codey")
    : path.join(prefix, "lib", "node_modules", "codey");
}

export function npmCandidates(node = process.execPath, platform = process.platform) {
  const paths = platform === "win32" ? path.win32 : path;
  const bin = paths.dirname(node);
  return [
    paths.join(bin, "node_modules/npm/bin/npm-cli.js"),
    paths.resolve(bin, "../lib/node_modules/npm/bin/npm-cli.js"),
    paths.resolve(bin, "../share/nodejs/npm/bin/npm-cli.js"),
  ];
}

async function npmCli(node) {
  for (const candidate of npmCandidates(node)) {
    try { if ((await lstat(candidate)).isFile()) return await realpath(candidate); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  throw new Error("The selected Node installation needs npm (npm-cli.js).");
}

export function command(file, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env, stdio: "inherit", shell: false });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(file)} failed (${signal || code})`));
    });
  });
}

const inside = (home, file) => {
  const relative = path.relative(home, file);
  return relative && !relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative);
};

async function ensureHomeDirectory(home, directory) {
  if (directory !== home && !inside(home, directory)) throw new Error("Use a new npm prefix under your own home.");
  let existing = directory;
  while (true) {
    try {
      const resolved = await realpath(existing);
      if (resolved !== home && !inside(home, resolved)) throw new Error("The installation path resolves outside your home.");
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      existing = path.dirname(existing);
    }
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
}

const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";

export function launcherContents(node, entry, platform = process.platform, bin) {
  if (platform === "win32") {
    if ([node, entry].some(value => /[\r\n"%!^&|<>]/.test(value))) throw new Error("Unsupported Windows launcher path characters.");
    const fromBin = value => {
      if (!bin) return value;
      const relative = path.win32.relative(bin, value);
      return path.win32.isAbsolute(relative) ? value : "%~dp0" + relative;
    };
    const nodePath = fromBin(node), entryPath = fromBin(entry);
    // CMD does not reliably interpret UTF-8 batch literals. Relative %~dp0
    // paths also support non-ASCII profile names without changing code pages.
    if (/[^\x20-\x7e]/.test(nodePath + entryPath)) {
      throw new Error("Use a Node/package path reachable from the CLI directory without non-ASCII batch literals.");
    }
    // A .cmd entry works in PowerShell without changing its execution policy.
    return { "codey.cmd": `@echo off\r\n@rem ${MARKER}\r\nsetlocal DisableDelayedExpansion\r\n"${nodePath}" "${entryPath}" %*\r\nexit /b %errorlevel%\r\n` };
  }
  return { codey: `#!/bin/sh\n# ${MARKER}\nexec ${shellQuote(node)} ${shellQuote(entry)} "$@"\n` };
}

export const WINDOWS_PATH_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$bin = $env:CODEY_RUNTIME_BIN
if (-not [IO.Path]::IsPathRooted($bin) -or -not (Test-Path -LiteralPath $bin -PathType Container)) { throw 'Invalid Codey bin directory' }
$old = [Environment]::GetEnvironmentVariable('Path', 'User')
$found = @($old -split ';' | Where-Object { [Environment]::ExpandEnvironmentVariables($_).TrimEnd('\') -ieq $bin.TrimEnd('\') }).Count -gt 0
if (-not $found) {
  $next = if ($old) { $bin + ';' + $old } else { $bin }
  [Environment]::SetEnvironmentVariable('Path', $next, 'User')
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CodeyEnvironmentBroadcast {
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint msg, UIntPtr wParam,
    string lParam, uint flags, uint timeout, out UIntPtr result);
}
'@
  $result = [UIntPtr]::Zero
  $null = [CodeyEnvironmentBroadcast]::SendMessageTimeout([IntPtr]0xffff, 0x1a,
    [UIntPtr]::Zero, 'Environment', 2, 1000, [ref]$result)
}
`;

export async function installLauncher(home, node, root, { execute = command, platform = process.platform } = {}) {
  const bin = path.join(home, ".local", "bin");
  await ensureHomeDirectory(home, bin);
  const shims = launcherContents(node, path.join(root, "bin", "codey.mjs"), platform, bin);
  for (const [name, body] of Object.entries(shims)) {
    const destination = path.join(bin, name);
    try {
      const info = await lstat(destination);
      if (!info.isFile() || info.isSymbolicLink() || !(await readFile(destination, "utf8")).includes(MARKER)) {
        throw new Error(`Refusing to replace an unmanaged CLI entry: ${destination}`);
      }
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    const temporary = path.join(bin, `.codey-${randomBytes(8).toString("hex")}.tmp`);
    try {
      await writeFile(temporary, body, { mode: 0o700, flag: "wx" });
      await rename(temporary, destination);
    } finally { await rm(temporary, { force: true }); }
  }
  if (platform === "win32") {
    if (!process.env.SystemRoot) throw new Error("Windows SystemRoot is required to configure the user PATH.");
    const powershell = path.win32.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    await execute(powershell, ["-NoProfile", "-NonInteractive", "-EncodedCommand",
      Buffer.from(WINDOWS_PATH_SCRIPT, "utf16le").toString("base64")], { ...process.env, CODEY_RUNTIME_BIN: bin });
  } else {
    const profiles = [".profile", ".bashrc"];
    for (const name of [".bash_profile", ".bash_login"]) {
      try { await lstat(path.join(home, name)); profiles.push(name); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    const block = '\n# >>> Codey PATH >>>\ncase ":${PATH:-}:" in\n  *":$HOME/.local/bin:"*) ;;\n  *) PATH="$HOME/.local/bin${PATH:+:$PATH}" ;;\nesac\nexport PATH\n# <<< Codey PATH <<<\n';
    for (const name of profiles) {
      const file = path.join(home, name);
      let text = "";
      try { text = await readFile(file, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
      if (!text.split(/\r?\n/).includes("# >>> Codey PATH >>>")) await appendFile(file, block, { mode: 0o600 });
    }
  }
  return bin;
}

export async function installRuntime(args) {
  const options = installOptions(args);
  if (options.help) return console.log(HELP);
  const platform = process.platform;
  if (!["linux", "win32"].includes(platform) || process.arch !== "x64") throw new Error("Linux x64 or Windows x64 is required.");
  if (process.getuid?.() === 0 || os.userInfo().username.toUpperCase() === "SYSTEM") throw new Error("Run as the target OS user, not root or SYSTEM.");
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || major === 22 && minor < 13) throw new Error("Node.js 22.13+ is required.");
  const home = await realpath(os.homedir()), node = process.execPath;
  const npm = await npmCli(node);
  const file = await realpath(options.package);
  const info = await lstat(file);
  if (!info.isFile() || info.size > 512 * 1024 * 1024) throw new Error("Invalid Codey npm artifact.");
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  if (hash.digest("hex") !== options.sha256) throw new Error("Codey artifact SHA-256 mismatch; nothing installed.");

  let prefix;
  if (options.prefix) {
    prefix = path.resolve(options.prefix);
    try { await lstat(prefix); throw new Error("Refusing to overwrite an existing npm prefix."); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    await ensureHomeDirectory(home, path.dirname(prefix));
    await mkdir(prefix, { mode: 0o700 });
  } else {
    const releases = path.join(home, ".local/share/codey-machine/releases");
    await ensureHomeDirectory(home, releases);
    prefix = await mkdtemp(path.join(releases, "npm-"));
  }
  await chmod(prefix, 0o700);
  const env = { ...process.env, PATH: path.dirname(node) + path.delimiter + (process.env.PATH ?? "") };
  const npmFlags = ["--omit=dev", "--no-audit", "--no-fund", "--strict-ssl=true", `--registry=${PUBLIC_REGISTRY}`];
  console.log(`Installing the shared Codey artifact through npm into ${prefix}`);
  // Call npm's JS entrypoint directly: npm.cmd is not spawnable without a shell.
  await command(node, [npm, "install", "--global", "--prefix", prefix, "--ignore-scripts", ...npmFlags, file], env);
  const app = npmPackageRoot(prefix);
  const pkg = JSON.parse(await readFile(path.join(app, "package.json"), "utf8"));
  if (pkg.name !== "codey" || pkg.bin?.codey !== "bin/codey.mjs") throw new Error("Not the shared Codey application.");
  const cli = path.join(app, "bin/codey.mjs");
  await command(node, [cli, "doctor", "--package-only", "--json"], env);
  await command(node, [npm, "rebuild", "--prefix", app, ...npmFlags], env);
  await command(node, [cli, "doctor", "--json"], env);
  const bin = options.check ? null : await installLauncher(home, node, app);
  console.log(JSON.stringify({ ok: true, name: "codey", version: pkg.version, packageSha256: options.sha256,
    platform: platform === "win32" ? "windows-x64" : "linux-x64", packageRoot: app, bin,
    pathChanged: !options.check, serviceChanges: false, modelRequests: false }));
  if (bin) {
    console.log("Open a new terminal to use codey. For the current terminal:");
    console.log(platform === "win32" ? `$env:Path = '${bin.replaceAll("'", "''")};' + $env:Path`
      : 'export PATH="$HOME/.local/bin:$PATH"');
    console.log("Authenticate with codey auth login --provider copilot; use codey start or codey gateway.");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  installRuntime(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
