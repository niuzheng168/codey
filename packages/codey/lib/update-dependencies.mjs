import { cp, lstat, readFile, readdir, readlink, realpath, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { validateRuntimeLock } from "./package-info.mjs";
import { atomicWrite, exists, hash, inside, ownedPath, readInstalledPackageInfo, readJson } from "./update-files.mjs";

const LINK_RECORD = "codey-dependency-link.json";
const graph = lock => ({
  dependencies: lock.packages[""].dependencies ?? {},
  optionalDependencies: lock.packages[""].optionalDependencies ?? {},
  packages: Object.fromEntries(Object.entries(lock.packages).filter(([name]) => name)),
});
const sorted = value => Array.isArray(value) ? value.map(sorted) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
const dependencyHash = lock => hash(JSON.stringify(sorted(graph(lock))));
const samePath = (left, right) => process.platform === "win32"
  ? path.toNamespacedPath(left).toLowerCase() === path.toNamespacedPath(right).toLowerCase() : left === right;

export function sameDependencies(previous, next) {
  return isDeepStrictEqual(graph(previous), graph(next));
}

export async function reusableDependencies(root, nextLock) {
  const { pkg } = await readInstalledPackageInfo(root);
  const previous = await readJson(path.join(root, "npm-shrinkwrap.json"));
  validateRuntimeLock(pkg, previous);
  return sameDependencies(previous, nextLock) && await exists(path.join(root, "node_modules"));
}

async function dependencyRoot(root, lock, home, allowInstalledLink = false) {
  const modules = path.join(root, "node_modules");
  const info = await lstat(modules);
  if (!info.isSymbolicLink()) {
    if (!info.isDirectory()) throw new Error("Dependency reuse requires an installed node_modules directory.");
    if (await exists(path.join(root, LINK_RECORD))) throw new Error("Shared dependency binding requires its original link.");
    return modules;
  }
  const file = path.join(root, LINK_RECORD);
  if (allowInstalledLink && !await exists(file)) {
    const retained = await realpath(modules);
    await ownedPath(root, home);
    await ownedPath(retained, home);
    if (!(await lstat(retained)).isDirectory()) throw new Error("Installed dependency link is not a directory.");
    return retained;
  }
  await ownedPath(file, home);
  const record = await readJson(file);
  if (record.schema !== 1 || record.dependencySha256 !== dependencyHash(lock) ||
      record.platform !== process.platform || record.arch !== process.arch ||
      record.abi !== process.versions.modules || typeof record.modules !== "string" ||
      !path.isAbsolute(record.modules)) throw new Error("Shared dependency binding differs from this package or runtime.");
  await ownedPath(record.modules, home);
  if (!(await lstat(record.modules)).isDirectory() || !samePath(await realpath(modules), record.modules)) {
    throw new Error("Shared dependency link no longer matches its retained installation.");
  }
  return record.modules;
}

export async function verifyDependencyBinding(root, lock, { home = os.homedir() } = {}) {
  const modules = path.join(root, "node_modules");
  if (await exists(path.join(root, LINK_RECORD)) ||
      await exists(modules) && (await lstat(modules)).isSymbolicLink()) {
    return dependencyRoot(root, lock, home);
  }
}

export async function verifyDependencyTree(root, lock, { home = os.homedir(), allowInstalledLink = false } = {}) {
  const modules = await dependencyRoot(root, lock, home, allowInstalledLink);
  for (const [name, item] of Object.entries(lock.packages)) {
    if (!name) continue;
    if (!name.startsWith("node_modules/") || /[\\:\x00-\x1f]/.test(name) ||
        name.split("/").some(part => !part || part === "." || part === "..")) {
      throw new Error("Unsafe dependency lock path.");
    }
    const file = path.join(modules, name.slice("node_modules/".length), "package.json");
    if (!await exists(file) && (item.optional || item.dev || item.devOptional)) continue;
    const installed = await readJson(file);
    if (installed.version !== item.version) throw new Error(`Installed dependency differs from the release lock: ${name}`);
  }
  async function checkLinks(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const resolved = await realpath(file);
        if (!inside(modules, resolved)) throw new Error("Dependency links must stay inside the installed dependency tree.");
        // Absolute links would keep pointing at the old tree after activation.
        if (path.isAbsolute(await readlink(file))) throw new Error("Absolute dependency links cannot be reused.");
      } else if (entry.isDirectory()) await checkLinks(file);
      else if (!entry.isFile()) throw new Error("Dependency tree contains a special file.");
    }
  }
  await checkLinks(modules);
  return modules;
}

export async function linkDependencies(source, target, lock, { home = os.homedir() } = {}) {
  await ownedPath(source, home);
  await ownedPath(target, home);
  if (!await reusableDependencies(source, lock)) {
    throw new Error("Offline dependency reuse requires an installed Codey package with the identical dependency lock.");
  }
  const modules = await realpath(await verifyDependencyTree(source, lock, { home, allowInstalledLink: true }));
  await ownedPath(modules, home);
  const link = path.join(target, "node_modules");
  const record = { schema: 1, modules, dependencySha256: dependencyHash(lock),
    platform: process.platform, arch: process.arch, abi: process.versions.modules };
  await writeFile(path.join(target, LINK_RECORD), JSON.stringify(record) + "\n", { flag: "wx", mode: 0o600 });
  await symlink(modules, link, process.platform === "win32" ? "junction" : "dir");
  await dependencyRoot(target, lock, home);
  if (!sameDependencies(await readJson(path.join(source, "npm-shrinkwrap.json")), lock)) {
    throw new Error("Installed dependencies changed during staging.");
  }
  return { mode: "reuse-installed-linked", copiedFiles: 0, copiedBytes: 0, modules };
}

/** Standalone activation moves the old package; retain its tree in the rollback directory. */
export async function relocateDependencyLink(root, previous, retained, { home = os.homedir() } = {}) {
  const file = path.join(root, LINK_RECORD);
  if (!await exists(file)) return;
  await ownedPath(file, home);
  const record = await readJson(file);
  if (typeof record.modules !== "string" || !path.isAbsolute(record.modules)) {
    throw new Error("Invalid shared dependency binding.");
  }
  if (!inside(previous, record.modules)) {
    await dependencyRoot(root, await readJson(path.join(root, "npm-shrinkwrap.json")), home);
    return;
  }
  const link = path.join(root, "node_modules");
  if (!(await lstat(link)).isSymbolicLink() ||
      !samePath(path.resolve(path.dirname(link), await readlink(link)), record.modules)) {
    throw new Error("Shared dependency link changed before activation.");
  }
  const modules = path.join(retained, path.relative(previous, record.modules));
  await ownedPath(modules, home);
  if (!(await lstat(modules)).isDirectory()) throw new Error("Retained dependency tree is missing.");
  await unlink(link);
  await symlink(modules, link, process.platform === "win32" ? "junction" : "dir");
  await atomicWrite(file, { ...record, modules });
  await dependencyRoot(root, await readJson(path.join(root, "npm-shrinkwrap.json")), home);
}

export async function copyDependencies(source, target, lock) {
  if (!await reusableDependencies(source, lock)) {
    throw new Error("Offline dependency reuse requires an installed Codey package with the identical dependency lock.");
  }
  const modules = await verifyDependencyTree(source, lock);
  await cp(modules, path.join(target, "node_modules"), {
    recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true,
  });
  await verifyDependencyTree(target, lock);
  const before = await readFile(path.join(source, "npm-shrinkwrap.json"));
  if (!sameDependencies(JSON.parse(before), lock)) throw new Error("Installed dependencies changed during staging.");
}

// Use npm's existing tarball implementation, without dependency resolution or hooks.
export const EXTRACT_PACKAGE = `const {createRequire}=require('node:module');
process.umask(0o077);
createRequire(process.argv[1])('pacote').extract(process.argv[2],process.argv[3],{
  cache:process.argv[4],integrity:process.argv[5],offline:true,ignoreScripts:true,
  umask:0o077,fmode:0o600,dmode:0o700
}).catch(error=>{console.error(error.message);process.exitCode=1});`;
