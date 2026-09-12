import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { createGunzip } from "node:zlib";
import { knownRuntimePlatforms, validateRuntimeLock } from "./package-info.mjs";
import { fileHash, hash } from "./update-files.mjs";

const MAX_ARCHIVE = 512 * 1024 * 1024;
const MAX_EXPANDED = 4 * 1024 ** 3;
const required = [
  "package.json", "npm-shrinkwrap.json", "codey-build.json", "bin/codey.mjs",
  "lib/cli.mjs", "lib/doctor.mjs", "lib/package-info.mjs",
  "dist-server/server/index.js", "gateway/main.js", "dist/index.html", "pages/index.html",
];
const captured = new Set(["package.json", "npm-shrinkwrap.json", "codey-build.json"]);
const fail = message => { throw new Error("Invalid Codey package: " + message); };
const field = bytes => bytes.toString("utf8").replace(/\0.*$/s, "");
const octal = bytes => {
  const value = field(bytes).trim();
  if (!/^[0-7]*$/.test(value)) fail("unsupported tar numeric field");
  const number = parseInt(value || "0", 8);
  if (!Number.isSafeInteger(number)) fail("oversized tar entry");
  return number;
};

function pax(bytes) {
  const result = {};
  let offset = 0;
  while (offset < bytes.length) {
    const space = bytes.indexOf(32, offset);
    if (space < 0 || !/^[1-9]\d*$/.test(bytes.subarray(offset, space).toString("ascii"))) fail("malformed PAX header");
    const length = Number(bytes.subarray(offset, space).toString("ascii"));
    const end = offset + length;
    if (end > bytes.length || end <= space + 2 || bytes[end - 1] !== 10) fail("malformed PAX record");
    const pair = bytes.subarray(space + 1, end - 1).toString("utf8");
    const equals = pair.indexOf("=");
    if (equals < 1) fail("malformed PAX attribute");
    const key = pair.slice(0, equals);
    if (Object.hasOwn(result, key) || key.startsWith("GNU.sparse") || key === "linkpath") fail("unsafe PAX attribute");
    result[key] = pair.slice(equals + 1);
    offset = end;
  }
  return result;
}

/** Inspect only: no tar extraction, npm invocation, package import or install hook. */
export async function inspectUpdateArchive(filename, expectedSha256) {
  const file = await realpath(filename);
  const info = await lstat(file);
  if (!info.isFile() || info.size === 0 || info.size > MAX_ARCHIVE) fail("expected a local .tgz file under 512 MiB");
  const archiveSha256 = await fileHash(file);
  if (expectedSha256 && expectedSha256.toLowerCase() !== archiveSha256) fail("SHA-256 mismatch; nothing changed");
  const input = createReadStream(file);
  const gzip = createGunzip();
  input.on("error", error => gzip.destroy(error));
  input.pipe(gzip);
  const iterator = gzip[Symbol.asyncIterator]();
  let buffer = Buffer.alloc(0), ended = false, expanded = 0, pending = null, zeroBlocks = 0, entries = 0;
  const files = new Map(), names = new Set(), documents = new Map();
  async function take(count, eof = false) {
    const chunks = [];
    let remaining = count;
    while (remaining) {
      if (!buffer.length && !ended) {
        const next = await iterator.next();
        ended = next.done;
        buffer = next.done ? Buffer.alloc(0) : next.value;
      }
      if (!buffer.length) {
        if (eof && remaining === count) return null;
        fail("truncated tar archive");
      }
      const size = Math.min(remaining, buffer.length);
      chunks.push(buffer.subarray(0, size));
      buffer = buffer.subarray(size);
      remaining -= size;
    }
    return chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, count);
  }
  try {
    while (true) {
      const header = await take(512, true);
      if (!header) break;
      if (header.every(byte => byte === 0)) { zeroBlocks++; continue; }
      if (zeroBlocks) fail("data after the tar end marker");
      if (++entries > 100000) fail("too many entries");
      const sum = header.reduce((total, byte, index) => total + (index >= 148 && index < 156 ? 32 : byte), 0);
      if (sum !== octal(header.subarray(148, 156))) fail("tar checksum mismatch");
      let size = octal(header.subarray(124, 136));
      const type = header[156] === 0 ? "0" : String.fromCharCode(header[156]);
      let name = [field(header.subarray(345, 500)), field(header.subarray(0, 100))].filter(Boolean).join("/");
      if (["x", "g"].includes(type)) {
        expanded += size;
        if (expanded > MAX_EXPANDED) fail("expanded archive is too large");
        if (size > 1024 * 1024 || pending) fail("oversized or repeated PAX header");
        const attrs = pax(await take(size));
        await take((512 - size % 512) % 512);
        if (type === "g") {
          if ("path" in attrs || "size" in attrs) fail("global PAX path/size overrides are unsupported");
        } else pending = attrs;
        continue;
      }
      if (pending) {
        name = pending.path ?? name;
        if (pending.size !== undefined) {
          if (!/^\d+$/.test(pending.size)) fail("invalid PAX size");
          size = Number(pending.size);
        }
        pending = null;
      }
      expanded += size;
      if (!Number.isSafeInteger(size) || size < 0 || size > MAX_ARCHIVE || expanded > MAX_EXPANDED) fail("expanded archive is too large");
      if (!["0", "5"].includes(type)) fail("links, devices and special files are forbidden");
      if (name.endsWith("/") && type === "5") name = name.slice(0, -1);
      const parts = name.split("/");
      if (name.length > 500 || /[\x00-\x1f\\:]/.test(name) || parts[0] !== "package" ||
          parts.some(part => !part || part === "." || part === ".." || /[ .]$/.test(part) ||
            /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) ||
          parts.includes("node_modules") || parts.includes(".git") || parts.includes(".npmrc") ||
          names.has(name.toLowerCase())) fail("unsafe or duplicate archive path");
      names.add(name.toLowerCase());
      if (type === "5") {
        if (size) fail("directory has file data");
        continue;
      }
      const relative = parts.slice(1).join("/");
      if (!relative || relative.endsWith(".tgz") || relative.endsWith(".tar.gz") ||
          parts.at(-1) === "package.json" && relative !== "package.json" ||
          /\.(node|exe|dll|so|dylib)$/i.test(relative)) fail("nested apps or native runtimes are forbidden");
      if (captured.has(relative) && size > 16 * 1024 * 1024) fail("oversized package metadata");
      const digest = createHash("sha256"), chunks = [];
      let remaining = size, first = true;
      while (remaining) {
        const chunk = await take(Math.min(remaining, 65536));
        if (first) {
          const magic = chunk.subarray(0, 4).toString("hex");
          if (magic === "7f454c46" || magic.startsWith("4d5a") ||
              ["feedface", "cefaedfe", "feedfacf", "cffaedfe", "cafebabe", "bebafeca"].includes(magic)) {
            fail("bundled native executable");
          }
          first = false;
        }
        digest.update(chunk);
        if (captured.has(relative)) chunks.push(chunk);
        remaining -= chunk.length;
      }
      await take((512 - size % 512) % 512);
      files.set(relative, { sha256: digest.digest("hex"), size });
      if (captured.has(relative)) documents.set(relative, Buffer.concat(chunks));
    }
    if (zeroBlocks < 2 || pending) fail("missing tar end marker");
  } finally {
    input.destroy();
    gzip.destroy();
  }
  for (const name of required) if (!files.has(name)) fail("missing " + name);
  let pkg, build, lock;
  try {
    pkg = JSON.parse(documents.get("package.json"));
    build = JSON.parse(documents.get("codey-build.json"));
    lock = JSON.parse(documents.get("npm-shrinkwrap.json"));
  } catch { fail("malformed package metadata"); }
  validateRuntimeLock(pkg, lock);
  const lockedNames = new Set();
  for (const name of Object.keys(lock.packages)) {
    if (!name) continue;
    const parts = name.split("/");
    if (!name.startsWith("node_modules/") || /[\\:\x00-\x1f]/.test(name) ||
        parts.some(part => !part || part === "." || part === "..") ||
        lockedNames.has(name.toLowerCase())) fail("unsafe or duplicate dependency lock path");
    lockedNames.add(name.toLowerCase());
  }
  if (Object.keys(pkg.bin).length !== 1) fail("only the Codey executable may be installed");
  for (const name of ["preinstall", "install", "postinstall", "preprepare", "prepare", "postprepare", "prepublish"]) {
    if (Object.hasOwn(pkg.scripts ?? {}, name) &&
        !(name === "postinstall" && pkg.scripts[name] === "node scripts/fix-node-pty.js")) {
      fail("unsupported application install hook; update must not run setup or tool installers");
    }
  }
  for (const group of ["dependencies", "optionalDependencies", "peerDependencies", "devDependencies"]) {
    if (["@openai/codex", "@openai/codex-sdk", "@cloudcli-ai/cloudcli", "@jeffreycao/copilot-api"]
      .some(name => Object.hasOwn(pkg[group] ?? {}, name))) fail("Codey must not install another application or Codex");
  }
  if (Object.keys(lock.packages).some(name =>
    /(?:^|\/)node_modules\/(?:@openai\/codex(?:$|-)|@cloudcli-ai\/cloudcli$|@jeffreycao\/copilot-api$)/.test(name))) {
    fail("the dependency lock includes another application or Codex");
  }
  const content = createHash("sha256");
  for (const name of [...files.keys()].filter(name => name !== "codey-build.json")
    .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    content.update(name + "\0");
    content.update(Buffer.from(files.get(name).sha256, "hex"));
  }
  if (build.schema !== 1 || build.name !== "codey" || build.version !== pkg.version ||
      !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(pkg.version) ||
      !/^[a-f0-9]{40}$/.test(build.sourceCommit ?? "") ||
      Object.hasOwn(build, "platform") || Object.hasOwn(pkg, "os") || Object.hasOwn(pkg, "cpu") ||
      !knownRuntimePlatforms(build.runtimePlatforms) ||
      build.lockSha256 !== files.get("npm-shrinkwrap.json").sha256 ||
      build.workspaceEntrySha256 !== files.get("dist-server/server/index.js").sha256 ||
      build.gatewayEntrySha256 !== files.get("gateway/main.js").sha256 ||
      !/^[a-f0-9]{64}$/.test(build.contentSha256 ?? "")) fail("build/lock fingerprints differ");
  // contentSha256 describes the builder's pre-pack tree, which can contain files
  // npm omits. Bind the actual payload to the tarball SHA and verify every packed
  // file after npm installation instead of equating these two different trees.
  return {
    file, size: info.size, sha256: archiveSha256, pkg, build, files,
    entrySha256: hash(documents.get("codey-build.json")), packedContentSha256: content.digest("hex"),
  };
}
