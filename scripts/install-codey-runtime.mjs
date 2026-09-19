#!/usr/bin/env node
// Runtime-only installer for the shared Linux/Windows/macOS application artifact.
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile, appendFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_PACKAGE_FILE = "";
const DEFAULT_PACKAGE_SHA256 = "";
const MARKER = "CODEY_SHARED_NPM_LAUNCHER";
const PUBLIC_REGISTRY = "https://registry.npmjs.org";
export function npmRegistry(value = process.env.CODEY_NPM_REGISTRY || PUBLIC_REGISTRY) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("CODEY_NPM_REGISTRY must be an HTTPS registry without credentials, query or fragment.");
  }
  return url.href.replace(/\/$/, "");
}
const HELP = `Usage: node install-codey.mjs [--package FILE.tgz] [--sha256 HASH] [--prefix DIR] [--check | --no-launcher]
                              [--reuse-from EXISTING_CODEY_DIRECTORY]

Install the SAME Codey npm artifact on Linux x64, Windows x64 or macOS arm64/x64
using Node.js 22.13+.
A published installer has its adjacent package filename and SHA-256 built in.
Source use requires both --package and --sha256; public npm names are never accepted.
--prefix must be a new directory under the current user's home.
--check is read-only: verify the local archive SHA-256 and report the installation
plan without downloads, npm, files or PATH changes. Native dependencies are deferred.
--no-launcher installs/verifies the runtime without creating a CLI or changing PATH.
--reuse-from copies identical, already installed dependencies instead of downloading
or rebuilding them. This offline path requires the same dependency lock and a
compatible existing Node/native ABI; it never falls back to the registry.
CODEY_NPM_REGISTRY selects an HTTPS mirror for this install only; npm's global
configuration, locked versions, integrity hashes and TLS verification stay intact.

No services, DevTunnel, credentials or Codex settings are modified, and no Portal
registration JSON is generated. For a complete node use the installation Skill's
native entrypoint (install-npm.sh, install.ps1 or install-macos.sh).
`;

export function installerPlatform(platform = process.platform, arch = process.arch) {
  const target = `${platform === "win32" ? "windows" : platform === "darwin" ? "macos" : platform}-${arch}`;
  if (!["linux-x64", "windows-x64", "macos-arm64", "macos-x64"].includes(target)) {
    throw new Error("Native Linux x64, Windows x64 or macOS arm64/x64 is required.");
  }
  return target;
}

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
    else if (flag === "--no-launcher") options.noLauncher = true;
    else if (["--package", "--sha256", "--prefix", "--reuse-from"].includes(flag) && args[index + 1] && !args[index + 1].startsWith("--")) {
      options[flag.slice(2)] = args[++index];
    } else throw new Error(`Invalid installer option: ${flag}`);
  }
  if (!options.package.endsWith(".tgz") || /^[a-z]+:/i.test(options.package) && !/^[a-z]:[\\/]/i.test(options.package) ||
      !/^[a-f0-9]{64}$/i.test(options.sha256)) {
    throw new Error("Provide a local Codey .tgz and its SHA-256; do not install the unrelated public npm package.");
  }
  options.sha256 = options.sha256.toLowerCase();
  if (options.check && options.noLauncher) throw new Error("--check cannot be combined with --no-launcher");
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
    if (platform === "darwin") profiles.push(".zprofile", ".zshrc");
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
  const registry = npmRegistry();
  const platform = process.platform;
  const target = installerPlatform();
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
  const donor = options["reuse-from"] ? await realpath(options["reuse-from"]) : null;
  if (donor && !inside(home, donor)) throw new Error("Reuse dependencies only from an existing installation under your own home.");
  if (options.check) {
    if (options.prefix) {
      const prefix = path.resolve(options.prefix);
      if (!inside(home, prefix)) throw new Error("Use a new npm prefix under your own home.");
      try { await lstat(prefix); throw new Error("Refusing to overwrite an existing npm prefix."); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    const plan = { ok: true, mode: "check", platform: target, packageSha256: options.sha256,
      pathChanged: false, serviceChanges: false, modelRequests: false, downloads: false, fileChanges: false,
      deferred: ["package/native dependency verification during installation"], registrationFile: null };
    console.log(JSON.stringify(plan));
    return plan;
  }

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
  const npmFlags = ["--omit=dev", "--no-audit", "--no-fund", "--prefer-offline", "--umask=0077", "--strict-ssl=true", `--registry=${registry}`];
  const npmArgs = platform === "win32" ? [npm] : [
    "--input-type=commonjs", "-e", "process.umask(0o077); require(process.argv[1]);", npm,
  ];
  console.log(`Installing the shared Codey artifact through npm into ${prefix}`);
  const app = npmPackageRoot(prefix);
  // Bootstrap before package helpers exist, with a private child-process umask.
  const extract = `process.umask(0o077);
require('node:module').createRequire(process.argv[1])('pacote').extract(process.argv[2],process.argv[3],{
  cache:process.argv[4],integrity:process.argv[5],offline:true,ignoreScripts:true,
  umask:0o077,fmode:0o600,dmode:0o700
}).catch(error=>{console.error(error.message);process.exitCode=1});`;
  await command(node, ["--input-type=commonjs", "-e", extract, npm, file, app,
    path.join(prefix, ".npm"), "sha256-" + Buffer.from(options.sha256, "hex").toString("base64")], env);
  if (donor) {
    // The independently checked release supplies the offline installer helpers.
    const load = name => import(pathToFileURL(path.join(app, "lib", name)).href);
    const { inspectPackageArchive, verifyStagedPackage } = await load("package-archive.mjs");
    const { copyDependencies } = await load("package-dependencies.mjs");
    const { ownedPath, buildEnvironment } = await load("package-files.mjs");
    await ownedPath(donor, home);
    const artifact = await inspectPackageArchive(file, options.sha256);
    await verifyStagedPackage(app, artifact);
    await copyDependencies(donor, app, artifact.lock);
    await verifyStagedPackage(app, artifact);
    const buildHome = path.join(prefix, "build-home");
    await mkdir(buildHome, { mode: 0o700 });
    await command(node, [path.join(app, "bin/codey.mjs"), "doctor", "--runtime-only", "--json"], buildEnvironment(buildHome, node));
  } else {
    // Call npm's JS entrypoint directly: npm.cmd is not spawnable without a shell.
    await command(node, [...npmArgs, "ci", "--prefix", app, "--ignore-scripts", ...npmFlags], env);
  }
  const pkg = JSON.parse(await readFile(path.join(app, "package.json"), "utf8"));
  if (pkg.name !== "codey" || pkg.bin?.codey !== "bin/codey.mjs") throw new Error("Not the shared Codey application.");
  const cli = path.join(app, "bin/codey.mjs");
  await command(node, [cli, "doctor", "--package-only", "--json"], env);
  if (!donor) {
    await command(node, [...npmArgs, "rebuild", "--prefix", app, ...npmFlags], env);
    await command(node, [cli, "doctor", "--runtime-only", "--json"], env);
  }
  const bin = options.noLauncher ? null : await installLauncher(home, node, app);
  const result = { ok: true, name: "codey", version: pkg.version, packageSha256: options.sha256,
    platform: target, packageRoot: app, bin, installationKind: "runtime-only", registrationFile: null,
    pathChanged: !options.noLauncher, serviceChanges: false, modelRequests: false,
    dependencyMode: donor ? "reuse-installed-offline" : "npm-install" };
  console.log(JSON.stringify(result));
  if (bin) {
    console.log("Open a new terminal to use codey. For the current terminal:");
    console.log(platform === "win32" ? `$env:Path = '${bin.replaceAll("'", "''")};' + $env:Path`
      : 'export PATH="$HOME/.local/bin:$PATH"');
    console.log("Authenticate with codey copilot login; use codey start --foreground or codey copilot start.");
  }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  installRuntime(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
