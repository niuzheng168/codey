import { cp, lstat, readFile, readdir, readlink, realpath } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { validateRuntimeLock } from "./package-info.mjs";
import { exists, inside, readInstalledPackageInfo, readJson } from "./update-files.mjs";

export function sameDependencies(previous, next) {
  const graph = lock => ({
    dependencies: lock.packages[""].dependencies ?? {},
    optionalDependencies: lock.packages[""].optionalDependencies ?? {},
    packages: Object.fromEntries(Object.entries(lock.packages).filter(([name]) => name)),
  });
  return isDeepStrictEqual(graph(previous), graph(next));
}

export async function reusableDependencies(root, nextLock) {
  const { pkg } = await readInstalledPackageInfo(root);
  const previous = await readJson(path.join(root, "npm-shrinkwrap.json"));
  validateRuntimeLock(pkg, previous);
  return sameDependencies(previous, nextLock) && await exists(path.join(root, "node_modules"));
}

export async function verifyDependencyTree(root, lock) {
  const modules = path.join(root, "node_modules");
  const info = await lstat(modules);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Dependency reuse requires a real, installed node_modules directory.");
  for (const [name, item] of Object.entries(lock.packages)) {
    if (!name) continue;
    if (!name.startsWith("node_modules/") || /[\\:\x00-\x1f]/.test(name) ||
        name.split("/").some(part => !part || part === "." || part === "..")) {
      throw new Error("Unsafe dependency lock path.");
    }
    const file = path.join(root, name, "package.json");
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
}

export async function copyDependencies(source, target, lock) {
  if (!await reusableDependencies(source, lock)) {
    throw new Error("Offline dependency reuse requires an installed Codey package with the identical dependency lock.");
  }
  await verifyDependencyTree(source, lock);
  await cp(path.join(source, "node_modules"), path.join(target, "node_modules"), {
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
