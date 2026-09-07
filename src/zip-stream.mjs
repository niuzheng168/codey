import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";

const table = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  return value >>> 0;
});
export function updateCrc(crc, bytes) {
  for (const byte of bytes) crc = (crc >>> 8) ^ table[(crc ^ byte) & 255];
  return crc >>> 0;
}
export const crc32 = (bytes) => (updateCrc(0xffffffff, bytes) ^ 0xffffffff) >>> 0;

// STORE entries let an already compressed runtime tarball stream with bounded
// memory. Personalized enrollment bytes never need a temporary file on Portal.
export function zipStream(entries) {
  if (!entries.length || entries.length > 100) throw new Error("Invalid ZIP entry count");
  const seen = new Set();
  let offset = 0;
  const parts = entries.map((entry) => {
    if (!/^[a-zA-Z0-9_./-]{1,240}$/.test(entry.name) || entry.name.startsWith("/") ||
        entry.name.split("/").some((part) => !part || part === "." || part === "..") || seen.has(entry.name)) {
      throw new Error("Unsafe ZIP name");
    }
    seen.add(entry.name);
    const data = entry.data == null ? null : Buffer.from(entry.data);
    const size = data ? data.length : entry.size;
    const crc = data ? crc32(data) : entry.crc32;
    if (!Number.isInteger(size) || size < 0 || size > 1536 * 1024 * 1024 || !Number.isInteger(crc)) {
      throw new Error("Invalid ZIP metadata");
    }
    const name = Buffer.from(entry.name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(33, 12);
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(size, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(0x314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(33, 14);
    central.writeUInt32LE(crc >>> 0, 16);
    central.writeUInt32LE(size, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((0o100600 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    offset += local.length + name.length + size;
    return { ...entry, data, size, crc, name, local, central };
  });
  const directory = Buffer.concat(parts.flatMap((entry) => [entry.central, entry.name]));
  if (offset + directory.length + 22 >= 0xffffffff) throw new Error("ZIP64 is not supported");
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(parts.length, 8);
  end.writeUInt16LE(parts.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return {
    length: offset + directory.length + end.length,
    async *[Symbol.asyncIterator]() {
      for (const entry of parts) {
        yield entry.local;
        yield entry.name;
        if (entry.data) { yield entry.data; continue; }
        const hash = createHash("sha256");
        let size = 0;
        let crc = 0xffffffff;
        for await (const chunk of createReadStream(entry.path)) {
          size += chunk.length;
          if (size > entry.size) throw new Error("Bundle changed during download");
          hash.update(chunk);
          crc = updateCrc(crc, chunk);
          yield chunk;
        }
        if (size !== entry.size || ((crc ^ 0xffffffff) >>> 0) !== entry.crc ||
            hash.digest("hex") !== entry.sha256) throw new Error("Bundle checksum mismatch");
      }
      yield directory;
      yield end;
    },
  };
}
