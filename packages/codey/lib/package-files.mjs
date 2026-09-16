import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
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
  if (!inside(home, file)) throw new Error("Use an installation under your own HOME.");
  let cursor = file;
  while (cursor !== home) {
    try {
      const info = await lstat(cursor);
      if (info.isSymbolicLink() && !allowSymlink) throw new Error("Linked installation paths require manual review.");
      if (process.getuid && (info.uid !== process.getuid() || info.mode & 0o022)) {
        throw new Error("Installation paths must be owned by you and not writable by other users.");
      }
      const resolved = await realpath(cursor);
      if (resolved !== home && !inside(home, resolved)) throw new Error("Installation path resolves outside your HOME.");
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    cursor = path.dirname(cursor);
  }
  return file;
}

export async function fileHash(file) {
  const digest = createHash("sha256");
  for await (const block of createReadStream(file)) digest.update(block);
  return digest.digest("hex");
}

/** Read previous installed layouts, without making their bytes eligible for a different OS. */
export async function readInstalledPackageInfo(root, { platform = process.platform, arch = process.arch } = {}) {
  try { return await readPackageInfo(root, { platform, arch }); }
  catch (original) {
    root = await realpath(root);
    const [pkg, build, lock] = await Promise.all(
      ["package.json", "codey-build.json", "npm-shrinkwrap.json"].map(name => readJson(path.join(root, name))),
    );
    const previousPlatforms = ["linux-x64", "windows-x64", "macos-arm64"];
    const target = runtimePlatform(platform, arch);
    const previousShared = JSON.stringify(build.runtimePlatforms) === JSON.stringify(previousPlatforms) &&
      !Object.hasOwn(build, "platform");
    const previousNative = build.platform === target && !Object.hasOwn(build, "runtimePlatforms");
    if ((!previousShared && !previousNative) || previousShared && !previousPlatforms.includes(target)) throw original;
    validateRuntimeLock(pkg, lock);
    if (build.schema !== 1 || build.name !== "codey" || build.version !== pkg.version ||
        !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(pkg.version ?? "") ||
        !/^[a-f0-9]{40}$/.test(build.sourceCommit ?? "") ||
        Object.hasOwn(pkg, "os") && (!previousNative || JSON.stringify(pkg.os) !== JSON.stringify([platform])) ||
        Object.hasOwn(pkg, "cpu") && (!previousNative || JSON.stringify(pkg.cpu) !== JSON.stringify([arch])) ||
        await fileHash(path.join(root, "npm-shrinkwrap.json")) !== build.lockSha256 ||
        await fileHash(path.join(root, "dist-server/server/index.js")) !== build.workspaceEntrySha256 ||
        await fileHash(path.join(root, "gateway/main.js")) !== build.gatewayEntrySha256) throw original;
    return { root, pkg, build, entrySha256: await fileHash(path.join(root, "codey-build.json")) };
  }
}

/** Run a bounded local package probe without echoing child errors or credentials. */
export async function execute(file, args, { cwd, env = process.env, timeout = 60000 } = {}) {
  try {
    const result = await promisify(execFile)(file, args, {
      cwd, env, timeout, maxBuffer: 16 * 1024 * 1024, windowsHide: true, shell: false,
    });
    return result.stdout.trim();
  } catch (error) {
    throw new Error(`${path.basename(file)} failed.`, { cause: error });
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
  throw new Error("The selected Node runtime must include npm.");
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
