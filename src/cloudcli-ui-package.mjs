import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

// Shared by the single-build packager and Portal's authenticated UI host.
export const UI_ASSET_PREFIX = "/cloudcli-ui/";
export const UI_RUNTIME_MARKER = "<!-- CODEY_WORKSPACE_RUNTIME -->";
export const UI_MANIFEST_MARKER = "__CODEY_WORKSPACE_MANIFEST__";
export const UI_PACKAGE_FILE = "ui-package.json";
const RELEASE_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 128 * 1024 * 1024;
const TYPES = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".eot": "application/vnd.ms-fontobject",
  ".wasm": "application/wasm",
};

/** The package builder, publisher and host use the same immutable release namespace. */
export function validateUiRelease(value) {
  if (typeof value !== "string" || !RELEASE_PATTERN.test(value)) throw new Error("Invalid workspace UI release");
  return value;
}

/** Only reviewed browser assets can be packaged; never expose configs, maps or arbitrary public HTML. */
export function uiContentType(name) {
  if (typeof name !== "string" || name.length > 240 ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_./-]*$/.test(name) ||
      name.split("/").some((part) => !part || part.startsWith("."))) return null;
  if (name === "index.html") return "text/html; charset=utf-8";
  if (name === "manifest.json") return "application/manifest+json; charset=utf-8";
  if (name === "sw.js") return TYPES[".js"];
  const type = TYPES[path.posix.extname(name)];
  if (!type) return null;
  if (name.startsWith("assets/")) return type;
  if (/^(?:favicon(?:\.|$)|logo(?:-\d+)?\.|icons\/|screenshots\/)/.test(name) && type.startsWith("image/")) return type;
  return null;
}

/** Bounds and validates the package contract before either publishing or serving its files. */
export function validateUiManifest(value) {
  if (!value || value.schema !== 1 || value.kind !== "codey-cloudcli-ui" || value.apiContract !== 1) {
    throw new Error("Unsupported workspace UI package");
  }
  validateUiRelease(value.release);
  if (value.assetBase !== `${UI_ASSET_PREFIX}${value.release}/` ||
      typeof value.cloudCliVersion !== "string" || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(value.cloudCliVersion) ||
      !HASH_PATTERN.test(value.sourceSha256 || "") || !value.files || Array.isArray(value.files)) {
    throw new Error("Invalid workspace UI metadata");
  }
  const entries = Object.entries(value.files);
  let size = 0;
  if (entries.length < 4 || entries.length > 5000) throw new Error("Invalid workspace UI file count");
  for (const [name, item] of entries) {
    if (!uiContentType(name) || !item || !HASH_PATTERN.test(item.sha256 || "") ||
        !Number.isSafeInteger(item.bytes) || item.bytes < 0 || item.bytes > MAX_FILE_BYTES) {
      throw new Error("Invalid workspace UI file entry");
    }
    size += item.bytes;
  }
  if (size > MAX_PACKAGE_BYTES || !["index.html", "manifest.json", "sw.js"].every((name) => Object.hasOwn(value.files, name)) ||
      !entries.some(([name]) => name.startsWith("assets/") && name.endsWith(".js"))) {
    throw new Error("Incomplete or oversized workspace UI package");
  }
  return value;
}

/** The builder, publisher and host require exactly one node-scoped bootstrap and manifest slot. */
export function validateUiTemplate(template) {
  if (typeof template !== "string" || template.split(UI_RUNTIME_MARKER).length !== 2 ||
      template.split(UI_MANIFEST_MARKER).length !== 2) {
    throw new Error("Invalid workspace UI bootstrap");
  }
  return template;
}

/** Read bounded regular files under a trusted package/store root, never following escaping links. */
export async function readUiStoreFile(root, name, limit) {
  const resolvedRoot = await realpath(root);
  const file = path.join(resolvedRoot, name);
  const info = await lstat(file);
  const resolvedFile = await realpath(file);
  const relative = path.relative(resolvedRoot, resolvedFile);
  if (!info.isFile() || info.isSymbolicLink() || resolvedFile !== file || path.isAbsolute(relative) ||
      relative === ".." || relative.startsWith(`..${path.sep}`) || info.size > limit) {
    throw new Error("Unsafe workspace UI file");
  }
  const handle = await open(resolvedFile, "r");
  try {
    // A bounded read also protects against a file growing after stat.
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > limit) throw new Error("Oversized workspace UI file");
    return buffer.subarray(0, length);
  } finally {
    await handle.close();
  }
}

/** The Portal and offline verifier load only a committed, checksummed package manifest. */
export async function readUiPackage(directory, expectedSha256) {
  if ((await lstat(directory)).isSymbolicLink()) throw new Error("Unsafe workspace UI package link");
  const root = await realpath(directory);
  const bytes = await readUiStoreFile(root, UI_PACKAGE_FILE, 1024 * 1024);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (expectedSha256 !== undefined && (!HASH_PATTERN.test(expectedSha256) || sha256 !== expectedSha256)) {
    throw new Error("Workspace UI manifest checksum mismatch");
  }
  const manifest = validateUiManifest(JSON.parse(bytes.toString("utf8")));
  return { root, manifest, sha256 };
}

/** File paths come from the manifest, not arbitrary request paths; verify bytes before sending them. */
export async function readUiPackageFile(bundle, name) {
  const entry = Object.hasOwn(bundle.manifest.files, name) ? bundle.manifest.files[name] : null;
  if (!entry) return null;
  const body = await readUiStoreFile(bundle.root, name, entry.bytes);
  if (body.length !== entry.bytes || createHash("sha256").update(body).digest("hex") !== entry.sha256) {
    throw new Error("Workspace UI asset checksum mismatch");
  }
  return body;
}
