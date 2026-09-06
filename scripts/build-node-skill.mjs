import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { deflateRawSync } from "node:zlib";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const SKILL_NAME = "codey-node-onboarding";
export const SKILL_FILES = Object.freeze([
  "SKILL.md",
  "agents/openai.yaml",
  "references/enrollment-and-https.md",
  "references/workspace.md",
  "references/vnet.md",
  "references/verification.md",
  "scripts/gateway-entry.mjs",
]);
export const SKILL_ROOT = path.join(projectRoot, "skills", SKILL_NAME);
export const DOWNLOAD_ROOT = path.join(projectRoot, "public", "downloads");

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  return value >>> 0;
});

function crc32(body) {
  let crc = 0xffffffff;
  for (const byte of body) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

// Small deterministic ZIP writer for the fixed, reviewed text files only.
// No filesystem scan: credentials, backups, links and unrelated files cannot be bundled.
export async function buildNodeSkill(sourceRoot = SKILL_ROOT) {
  const root = await realpath(sourceRoot);
  const localEntries = [];
  const directoryEntries = [];
  let offset = 0;
  let totalBytes = 0;
  for (const file of SKILL_FILES) {
    const filePath = path.join(root, file);
    const relative = path.relative(root, await realpath(filePath));
    const info = await lstat(filePath);
    if (!info.isFile() || info.isSymbolicLink() || path.isAbsolute(relative) ||
        relative === ".." || relative.startsWith(`..${path.sep}`) || info.size > 128 * 1024) {
      throw new Error(`Unsafe or oversized skill source: ${file}`);
    }
    const body = Buffer.from((await readFile(filePath, "utf8")).replace(/^\uFEFF/, "").replaceAll("\r\n", "\n"));
    totalBytes += body.length;
    if (totalBytes > 256 * 1024) throw new Error("Skill exceeds the expected text-only size.");
    const name = Buffer.from(`${SKILL_NAME}/${file}`);
    const compressed = deflateRawSync(body, { level: 9 });
    const checksum = crc32(body);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(33, 12); // 1980-01-01, independent of source mtimes
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(name.length, 26);
    localEntries.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x314, 4); // Unix creator, ZIP 2.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(33, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(body.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    directoryEntries.push(central, name);
    offset += local.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(directoryEntries);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(SKILL_FILES.length, 8);
  end.writeUInt16LE(SKILL_FILES.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localEntries, directory, end]);
}

export function checksumText(archive) {
  return `${createHash("sha256").update(archive).digest("hex")}  ${SKILL_NAME}.zip\n`;
}

async function main() {
  if (process.argv.slice(2).some((arg) => arg !== "--check")) throw new Error("Usage: node scripts/build-node-skill.mjs [--check]");
  const archive = await buildNodeSkill();
  const files = [[`${SKILL_NAME}.zip`, archive], [`${SKILL_NAME}.sha256`, Buffer.from(checksumText(archive))]];
  if (process.argv.includes("--check")) {
    for (const [name, body] of files) {
      if (!(await readFile(path.join(DOWNLOAD_ROOT, name))).equals(body)) {
        throw new Error(`Stale download ${name}; run npm run skill:build`);
      }
    }
    console.log(`Skill download is up to date (${archive.length} bytes, ${SKILL_FILES.length} files).`);
  } else {
    await mkdir(DOWNLOAD_ROOT, { recursive: true });
    for (const [name, body] of files) await writeFile(path.join(DOWNLOAD_ROOT, name), body);
    console.log(`Built ${SKILL_NAME}.zip (${archive.length} bytes, ${SKILL_FILES.length} files).`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
