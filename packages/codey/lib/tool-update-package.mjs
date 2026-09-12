// Declarative, owner-reviewed native tool payloads. Never run a vendor installer.
import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { fileHash, hash, inside } from "./update-files.mjs";

export const TOOL_COMPONENTS = Object.freeze(["codex", "devtunnel"]);
export const TOOL_PLATFORMS = Object.freeze(["linux-x64", "windows-x64"]);
export const TOOL_BASELINE = "0.1.3";
export const TOOL_VERSION = /^\d+\.\d+\.\d+(?:\.\d+)?(?:[-+][A-Za-z0-9.-]+)?$/;
const SHA = /^[a-f0-9]{64}$/;
const MAX_FILE = 512 * 1024 * 1024;
const MAX_TOTAL = 2 * 1024 ** 3;
const fail = message => { throw new Error(`Invalid tool update: ${message}`); };
const fields = (value, names) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).every(name => names.includes(name));

export function toolEntry(component, platform) {
  if (!TOOL_COMPONENTS.includes(component) || !TOOL_PLATFORMS.includes(platform)) fail("unsupported component/platform");
  return component + (platform === "windows-x64" ? ".exe" : "");
}

export function toolPath(value) {
  if (typeof value !== "string" || !value || value.length > 400 || /[\\:*?"<>|\x00-\x1f\x7f]/.test(value)) fail("unsafe payload path");
  const parts = value.split("/");
  if (parts.some(part => !part || [".", ".."].includes(part) || /[ .]$/.test(part)
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) fail("unsafe payload path");
  return value;
}

export function validateToolManifest(value) {
  if (!fields(value, ["schema", "kind", "component", "platform", "version", "minimumCodeyVersion", "entry", "files"])
      || value.schema !== 1 || value.kind !== "codey-tool-update"
      || !TOOL_COMPONENTS.includes(value.component) || !TOOL_PLATFORMS.includes(value.platform)
      || typeof value.version !== "string" || value.version.length > 128 || !TOOL_VERSION.test(value.version)
      || value.minimumCodeyVersion !== TOOL_BASELINE
      || value.entry !== toolEntry(value.component, value.platform)
      || !value.files || typeof value.files !== "object" || Array.isArray(value.files)) fail("unsupported manifest");
  const files = Object.entries(value.files);
  if (!files.length || files.length > 10000 || !Object.hasOwn(value.files, value.entry)) fail("missing entry or oversized file list");
  const names = new Set();
  let total = 0;
  for (const [name, item] of files) {
    toolPath(name);
    if (names.has(name.toLowerCase()) || !fields(item, ["sha256", "size", "executable"])
        || !SHA.test(item.sha256 ?? "") || !Number.isSafeInteger(item.size) || item.size < 0 || item.size > MAX_FILE
        || typeof item.executable !== "boolean") fail("invalid or duplicate file");
    names.add(name.toLowerCase());
    total += item.size;
  }
  // A file must not also be an ancestor of another file, including on Windows.
  for (const name of names) {
    const parts = name.split("/");
    while (parts.length > 1) {
      parts.pop();
      if (names.has(parts.join("/"))) fail("file/directory collision");
    }
  }
  if (total > MAX_TOTAL || !value.files[value.entry].executable || !value.files[value.entry].size) fail("oversized payload or non-executable entry");
  return value;
}

async function regularPayloadFile(root, relative) {
  const file = path.join(root, ...toolPath(relative).split("/"));
  let current = root;
  for (const part of relative.split("/")) {
    current = path.join(current, part);
    if ((await lstat(current)).isSymbolicLink()) fail("linked payload");
  }
  const info = await lstat(file);
  if (!info.isFile() || !inside(root, await realpath(file))) fail("payload escapes its directory");
  return { file, info };
}

export async function payloadNames(root, prefix = "", count = { entries: 0 }) {
  const names = [];
  for (const item of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    const name = [prefix, item.name].filter(Boolean).join("/");
    toolPath(name);
    if (++count.entries > 20000) fail("too many payload entries");
    if (item.isSymbolicLink() || !item.isDirectory() && !item.isFile()) fail("linked or special payload");
    if (item.isDirectory()) names.push(...await payloadNames(root, name, count));
    else names.push(name);
    if (names.length > 10000) fail("too many payload files");
  }
  return names;
}

/** Bounded header check; a matching hash is still a trust requirement, not a malware scan. */
export function nativeToolHeader(bytes, platform) {
  if (platform === "linux-x64") {
    return bytes.length >= 20 && bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
      && bytes[4] === 2 && bytes[5] === 1 && bytes.readUInt16LE(18) === 62;
  }
  if (platform === "windows-x64" && bytes.length >= 64 && bytes.toString("ascii", 0, 2) === "MZ") {
    const offset = bytes.readUInt32LE(60);
    return offset >= 64 && offset + 6 <= bytes.length
      && bytes.subarray(offset, offset + 4).equals(Buffer.from([0x50, 0x45, 0, 0]))
      && bytes.readUInt16LE(offset + 4) === 0x8664;
  }
  return false;
}

async function entryHeader(file) {
  const { open } = await import("node:fs/promises");
  const stream = await open(file, "r");
  try {
    const bytes = Buffer.alloc(65536);
    const { bytesRead } = await stream.read(bytes, 0, bytes.length, 0);
    return bytes.subarray(0, bytesRead);
  } finally { await stream.close(); }
}

/** Read only. The independently supplied manifest digest binds the entire file set. */
export async function inspectToolPackage(filename, expectedSha256, { component, platform } = {}) {
  if (!SHA.test(expectedSha256 ?? "")) fail("an independent --sha256 manifest digest is required");
  const info = await lstat(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > 4 * 1024 * 1024) fail("invalid manifest file");
  const file = await realpath(filename), bytes = await readFile(file);
  if (bytes.length > 4 * 1024 * 1024 || hash(bytes) !== expectedSha256) fail("manifest SHA-256 mismatch");
  let manifest;
  try { manifest = JSON.parse(bytes); } catch { fail("malformed manifest JSON"); }
  validateToolManifest(manifest);
  if (component && manifest.component !== component || platform && manifest.platform !== platform) fail("component/platform mismatch");
  const root = path.join(path.dirname(file), "files");
  if ((await lstat(root)).isSymbolicLink() || await realpath(root) !== root) fail("linked payload directory");
  const actualNames = (await payloadNames(root)).sort();
  const wantedNames = Object.keys(manifest.files).sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(wantedNames)) fail("unexpected or missing companion files");
  for (const [name, expected] of Object.entries(manifest.files)) {
    const item = await regularPayloadFile(root, name);
    if (item.info.size !== expected.size || await fileHash(item.file) !== expected.sha256) fail("payload checksum mismatch");
  }
  if (!nativeToolHeader(await entryHeader(path.join(root, manifest.entry)), manifest.platform)) fail("entry is not the selected native x64 executable");
  return { file, root, manifest, sha256: expectedSha256, entrySha256: manifest.files[manifest.entry].sha256 };
}

export async function stageToolPackage(artifact, destination) {
  // Re-read source bytes immediately before copying; no executing tools from Downloads.
  await inspectToolPackage(artifact.file, artifact.sha256, {
    component: artifact.manifest.component, platform: artifact.manifest.platform,
  });
  await mkdir(destination, { mode: 0o700 });
  for (const [name, expected] of Object.entries(artifact.manifest.files)) {
    const source = await regularPayloadFile(artifact.root, name);
    const target = path.join(destination, ...name.split("/"));
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await copyFile(source.file, target, constants.COPYFILE_EXCL);
    await chmod(target, expected.executable ? 0o700 : 0o600);
    if (await fileHash(target) !== expected.sha256) fail("staged companion checksum mismatch");
  }
  return path.join(destination, artifact.manifest.entry);
}
