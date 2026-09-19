/** One public package/config validation path for every native installer. */
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { digest, requireValue } from "./machine-common.mjs";
import { PLATFORMS } from "./registration.mjs";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const jsonFile = async file => JSON.parse(await readFile(file, "utf8"));
const sameFields = (value, fields) => value && typeof value === "object" && !Array.isArray(value) &&
  isDeepStrictEqual(Object.keys(value).sort(), [...fields].sort());
export async function readPins(skill, target) {
  const mac = target.startsWith("macos-"), windows = target === "windows-x64", arch = target.split("-")[1];
  const raw = await jsonFile(path.join(skill, mac ? "dependencies.macos.json" : windows ? "dependencies.windows.json" : "dependencies.json"));
  const pins = mac ? { node: { ...raw.platforms?.[target]?.node, version: raw.nodeVersion },
    devTunnel: raw.platforms?.[target]?.devTunnel, codex: raw.codex } : raw;
  const version = pins.node?.version;
  requireValue(/^\d+\.\d+\.\d+$/.test(version) &&
    pins.node.url === `https://nodejs.org/dist/v${version}/node-v${version}-${mac ? "darwin" : windows ? "win" : "linux"}-${arch}.${windows ? "zip" : mac ? "tar.gz" : "tar.xz"}` &&
    pins.devTunnel?.url === (windows ? "https://aka.ms/TunnelsCliDownload/win-x64" :
      `https://tunnelsassetsprod.blob.core.windows.net/cli/${mac ? "osx" : "linux"}-${arch}-devtunnel`) &&
    /^[a-f0-9]{64}$/.test(pins.node?.sha256) &&
    isDeepStrictEqual(pins.codex, { url: `https://chatgpt.com/codex/install.${windows ? "ps1" : "sh"}`, release: "latest" }),
    "Invalid official runtime pins");
  // DevTunnel URLs serve current Microsoft builds, not immutable release bytes.
  // Only the exact official HTTPS URL for this platform is allowed; Windows
  // additionally checks Authenticode before execution. Discard legacy hashes
  // on every platform so old pin files cannot restore the stale gate.
  const { sha256: _legacyDevTunnelHash, ...devTunnel } = pins.devTunnel;
  return { ...pins, devTunnel };
}
export async function assertInstalled(root, manifest, { artifact, home } = {}) {
  const pkg = await jsonFile(path.join(root, "package.json")), build = await jsonFile(path.join(root, "codey-build.json"));
  requireValue(pkg.name === "codey" && pkg.version === manifest.codey.version && pkg.bin?.codey === "bin/codey.mjs" &&
    build.name === "codey" && build.schema === 1 && build.version === pkg.version &&
    await digest(path.join(root, "codey-build.json")) === manifest.codey.entrySha256 &&
    await digest(path.join(root, "npm-shrinkwrap.json")) === manifest.codey.lockSha256,
    "Existing Codey package differs from this release");
  for (const [name, hash] of [["gateway/main.js", build.gatewayEntrySha256], ["dist-server/server/index.js", build.workspaceEntrySha256]]) {
    requireValue(/^[a-f0-9]{64}$/.test(hash) && await digest(path.join(root, name)) === hash, "Codey entry fingerprint mismatch");
  }
  if (artifact) {
    // The same release means the packed files match, not just a version label
    // or the two server entrypoints. Reuse the package's existing tar verifier.
    const { inspectPackageArchive, verifyStagedPackage } = await import(pathToFileURL(path.join(root, "lib/package-archive.mjs")).href);
    await verifyStagedPackage(root, await inspectPackageArchive(artifact, manifest.artifacts[0].sha256), { home });
  }
}
export async function readPackage(skill, target) {
  requireValue(PLATFORMS.includes(target), "Use a supported native platform");
  const assets = path.join(skill, "assets");
  const manifest = await jsonFile(path.join(assets, "manifest.json"));
  const setup = await jsonFile(path.join(assets, "setup.json"));
  const pins = await readPins(skill, target);
  requireValue(manifest.schema === 2 && manifest.name === "codey" &&
    isDeepStrictEqual(manifest.runtimePlatforms, PLATFORMS) && manifest.platform === "linux-x64" &&
    manifest.dependencyMode === "npm-codey-package" &&
    isDeepStrictEqual(manifest.bundledRuntimes, ["cloudcli", "copilot-api"]), "Use a complete updater-free Codey Skill");
  requireValue(sameFields(setup, ["schema", "portalOrigin", "releaseId", "platform", "network", "tunnelAuthProvider"]) &&
    setup.schema === 1 && setup.platform === "linux-x64" && setup.tunnelAuthProvider === "github" &&
    isDeepStrictEqual(setup.network, { mode: "devtunnel" }) &&
    setup.releaseId === manifest.releaseId && /^machine-[a-f0-9]{16}$/.test(setup.releaseId), "Invalid public setup metadata");
  const origin = new URL(setup.portalOrigin);
  requireValue(origin.protocol === "https:" && origin.origin === setup.portalOrigin &&
    !origin.username && !origin.password, "Invalid Portal origin");
  requireValue(Array.isArray(manifest.artifacts) && manifest.artifacts.length === 1);
  const artifact = manifest.artifacts[0];
  requireValue(/^codey-\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?\.tgz$/.test(artifact.file) &&
    artifact.file === `codey-${manifest.codey.version}.tgz`);
  const sums = new Map();
  for (const line of (await readFile(path.join(assets, "SHA256SUMS"), "utf8")).trim().split(/\r?\n/)) {
    const match = /^([a-f0-9]{64})  ([a-zA-Z0-9.-]+)$/.exec(line);
    requireValue(match && !sums.has(match[2]), "Invalid Skill checksums");
    sums.set(match[2], match[1]);
  }
  requireValue(isDeepStrictEqual([...sums.keys()].sort(), [artifact.file, "manifest.json", "setup.json"].sort()));
  for (const [name, expected] of sums) {
    const file = path.join(assets, name), info = await lstat(file);
    requireValue(info.isFile() && !info.isSymbolicLink() && await digest(file) === expected, "Skill checksum mismatch");
  }
  requireValue(artifact.sha256 === sums.get(artifact.file) &&
    (await lstat(path.join(assets, artifact.file))).size === artifact.size);
  return { manifest, setup: { ...setup, platform: target }, pins };
}
export async function modelConfiguration(models, templateFile = path.join(HERE, "../templates/codex-config.toml")) {
  const template = await readFile(templateFile, "utf8");
  return template.replace("__CODEY_MODEL_CATALOG__", () => JSON.stringify(models));
}
