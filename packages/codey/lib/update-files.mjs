import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { readPackageInfo, runtimePlatform, validateRuntimeLock } from "./package-info.mjs";

export const hash = bytes => createHash("sha256").update(bytes).digest("hex");
export const readJson = async file => {
  const body = await readFile(file, "utf8");
  try { return JSON.parse(body.replace(/^\uFEFF/, "")); }
  catch { throw new Error(`Invalid JSON in ${file}; contents were not printed.`); }
};
export const exists = async file => {
  try { await lstat(file); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
};
export const inside = (root, file) => {
  const relative = path.relative(root, file);
  return relative !== "" && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
};

/** Do not follow an installation/state path outside the owner's HOME. */
export async function ownedPath(file, home, { allowSymlink = false } = {}) {
  file = path.resolve(file);
  home = await realpath(home);
  if (!inside(home, file)) throw new Error("Local updates require an installation under your own HOME.");
  let cursor = file;
  while (cursor !== home) {
    try {
      const info = await lstat(cursor);
      if (info.isSymbolicLink() && !allowSymlink) throw new Error("Linked update/state paths require manual review.");
      if (process.getuid && (info.uid !== process.getuid() || info.mode & 0o022)) {
        throw new Error("Update paths must be owned by you and not writable by other users.");
      }
      const resolved = await realpath(cursor);
      if (resolved !== home && !inside(home, resolved)) throw new Error("Update path resolves outside your HOME.");
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    cursor = path.dirname(cursor);
  }
  return file;
}

export async function privateDirectory(directory, home) {
  await ownedPath(directory, home);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  return directory;
}

export async function atomicWrite(file, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n");
  if (await exists(file)) {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Refusing to overwrite a linked or non-file update record.");
  }
  const temporary = file + "." + randomBytes(8).toString("hex") + ".next";
  const stream = await open(temporary, "wx", 0o600);
  try { await stream.writeFile(bytes); await stream.sync(); }
  finally { await stream.close(); }
  try { await rename(temporary, file); }
  finally { await rm(temporary, { force: true }); }
}

export async function fileHash(file) {
  const digest = createHash("sha256");
  for await (const block of createReadStream(file)) digest.update(block);
  return digest.digest("hex");
}

/** Read the previous shared layout without changing its metadata or enabling a retired platform. */
export async function readInstalledPackageInfo(root) {
  try { return await readPackageInfo(root); }
  catch (original) {
    root = await realpath(root);
    const [pkg, build, lock] = await Promise.all(
      ["package.json", "codey-build.json", "npm-shrinkwrap.json"].map(name => readJson(path.join(root, name))),
    );
    const previousPlatforms = ["linux-x64", "windows-x64", "macos-arm64"];
    const target = runtimePlatform();
    const previousShared = JSON.stringify(build.runtimePlatforms) === JSON.stringify(previousPlatforms) &&
      !Object.hasOwn(build, "platform");
    const previousNative = build.platform === target && !Object.hasOwn(build, "runtimePlatforms");
    if ((!previousShared && !previousNative) || !["linux-x64", "windows-x64"].includes(target)) throw original;
    validateRuntimeLock(pkg, lock);
    if (build.schema !== 1 || build.name !== "codey" || build.version !== pkg.version ||
        !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(pkg.version ?? "") ||
        !/^[a-f0-9]{40}$/.test(build.sourceCommit ?? "") ||
        Object.hasOwn(pkg, "os") && (!previousNative || JSON.stringify(pkg.os) !== JSON.stringify([process.platform])) ||
        Object.hasOwn(pkg, "cpu") && (!previousNative || JSON.stringify(pkg.cpu) !== '["x64"]') ||
        await fileHash(path.join(root, "npm-shrinkwrap.json")) !== build.lockSha256 ||
        await fileHash(path.join(root, "dist-server/server/index.js")) !== build.workspaceEntrySha256 ||
        await fileHash(path.join(root, "gateway/main.js")) !== build.gatewayEntrySha256) throw original;
    return { root, pkg, build, entrySha256: await fileHash(path.join(root, "codey-build.json")) };
  }
}

/** Captured output can contain private paths; callers log it only in the job directory. */
export async function execute(file, args, { cwd, env = process.env, log, timeout = 60000 } = {}) {
  try {
    const result = await promisify(execFile)(file, args, {
      cwd, env, timeout, maxBuffer: 16 * 1024 * 1024, windowsHide: true, shell: false,
    });
    if (log) await atomicWrite(log, result.stdout + result.stderr);
    return result.stdout.trim();
  } catch (error) {
    if (log) await atomicWrite(log, (error.stdout ?? "") + (error.stderr ?? "") + "\n" + (error.code ?? "failed"));
    throw new Error(`${path.basename(file)} failed${log ? `; inspect ${log}` : ""}.`, { cause: error });
  }
}

export function npmPaths(node, platform = process.platform) {
  const paths = platform === "win32" ? path.win32 : path;
  const bin = paths.dirname(node);
  return [
    paths.join(bin, "node_modules/npm/bin/npm-cli.js"),
    paths.resolve(bin, "../lib/node_modules/npm/bin/npm-cli.js"),
    paths.resolve(bin, "../share/nodejs/npm/bin/npm-cli.js"),
  ];
}

export async function findNpm(node, platform = process.platform) {
  for (const candidate of npmPaths(node, platform)) {
    if (await exists(candidate)) return realpath(candidate);
  }
  throw new Error("The existing Node runtime must include npm; codey update will not install a runtime.");
}

/** Native dependency hooks must not inherit provider credentials, NODE_OPTIONS or npm overrides. */
export function buildEnvironment(home, node, source = process.env) {
  const env = {};
  for (const name of [
    "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "SYSTEMDRIVE", "TEMP", "TMP",
    "LANG", "LC_ALL", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
    "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
  ]) if (source[name] !== undefined) env[name] = source[name];
  const windows = process.platform === "win32";
  const system = windows
    ? [source.SystemRoot && path.join(source.SystemRoot, "System32"), source.SystemRoot].filter(Boolean).join(path.delimiter)
    : "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
  return {
    ...env, HOME: home, USERPROFILE: home, APPDATA: path.join(home, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(home, "AppData", "Local"),
    PATH: path.dirname(node) + path.delimiter + system,
    CI: "true", HUSKY: "0", ELECTRON_SKIP_BINARY_DOWNLOAD: "1", NODE_ENV: "production",
    npm_config_userconfig: path.join(home, ".npmrc"),
    npm_config_globalconfig: path.join(home, "global.npmrc"),
    npm_config_cache: path.join(home, ".npm"),
    DATABASE_PATH: ":memory:", CODEY_MANAGED: "false", CODEY_PORTAL_SSO: "false",
  };
}

/** Service discovery needs the owner's OS session, not application/provider or npm overrides. */
export function controlEnvironment(home, source = process.env) {
  const result = { HOME: home, USERPROFILE: home, PYTHONDONTWRITEBYTECODE: "1" };
  for (const name of [
    "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "SYSTEMDRIVE", "TEMP", "TMP",
    "OS", "COMPUTERNAME", "PROCESSOR_ARCHITECTURE", "APPDATA", "LOCALAPPDATA",
    "USER", "LOGNAME", "LANG", "LC_ALL", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS",
  ]) if (source[name] !== undefined) result[name] = source[name];
  result.PATH = process.platform === "win32"
    ? [source.SystemRoot && path.join(source.SystemRoot, "System32"), source.SystemRoot].filter(Boolean).join(path.delimiter)
    : "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
  return result;
}
