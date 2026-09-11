import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";

export const RUNTIME_PLATFORMS = Object.freeze(["linux-x64", "windows-x64"]);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sha256 = /^[a-f0-9]{64}$/;
const sameRecord = (a = {}, b = {}) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

export function runtimePlatform(platform = process.platform, arch = process.arch) {
  const name = `${platform === "win32" ? "windows" : platform}-${arch}`;
  if (!RUNTIME_PLATFORMS.includes(name)) throw new Error("This shared Codey release supports Linux x64 and Windows x64.");
  return name;
}

export function validateRuntimeLock(pkg, lock) {
  if (pkg.name !== "codey" || pkg.type !== "module" || pkg.bin?.codey !== "bin/codey.mjs" ||
      lock.name !== pkg.name || lock.version !== pkg.version || lock.lockfileVersion !== 3 ||
      lock.packages?.[""]?.name !== pkg.name || lock.packages[""].version !== pkg.version) {
    throw new Error("Not a complete, locked Codey npm application");
  }
  for (const group of ["dependencies", "optionalDependencies"]) {
    if (!sameRecord(pkg[group], lock.packages[""][group])) throw new Error("Codey manifest and dependency lock differ");
  }
  for (const [name, item] of Object.entries(lock.packages)) {
    if (!name) continue;
    let url;
    try { url = new URL(item.resolved); } catch { throw new Error("Codey dependencies must use the shared public npm lock"); }
    if (item.link || url.origin !== "https://registry.npmjs.org" || url.username || url.password || url.search || url.hash ||
        !/^sha(?:1|256|384|512)-[A-Za-z0-9+/]+={0,2}(?:\s|$)/.test(item.integrity ?? "")) {
      throw new Error("Codey dependencies must use the shared public npm lock");
    }
  }
}

export async function readPackageInfo(root) {
  root = await realpath(root);
  const [packageRaw, buildRaw, lockRaw] = await Promise.all(
    ["package.json", "codey-build.json", "npm-shrinkwrap.json"].map(name => readFile(path.join(root, name))),
  );
  const pkg = JSON.parse(packageRaw), build = JSON.parse(buildRaw), lock = JSON.parse(lockRaw);
  validateRuntimeLock(pkg, lock);
  if (build.schema !== 1 || build.name !== "codey" || build.version !== pkg.version ||
      !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(pkg.version ?? "") ||
      !/^[a-f0-9]{40}$/.test(build.sourceCommit ?? "") ||
      JSON.stringify(build.runtimePlatforms) !== JSON.stringify(RUNTIME_PLATFORMS) ||
      Object.hasOwn(build, "platform") || Object.hasOwn(pkg, "os") || Object.hasOwn(pkg, "cpu") ||
      !sha256.test(build.lockSha256 ?? "") || hash(lockRaw) !== build.lockSha256) {
    throw new Error("Not a shared Linux/Windows Codey release");
  }
  for (const [name, expected] of [
    ["dist-server/server/index.js", build.workspaceEntrySha256], ["gateway/main.js", build.gatewayEntrySha256],
  ]) {
    if (!sha256.test(expected ?? "") || hash(await readFile(path.join(root, name))) !== expected) {
      throw new Error(`Codey build fingerprint mismatch: ${name}`);
    }
  }
  return { root, pkg, build, entrySha256: hash(buildRaw) };
}
