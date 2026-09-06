import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export const requestError = (message, status = 400) => Object.assign(new Error(message), { status, expose: true });

export async function replaceSignedFile(source, target, {
  platform = process.platform, renameImpl = rename, delayImpl = delay,
} = {}) {
  for (let attempt = 0; ; attempt++) {
    try { await renameImpl(source, target); return; }
    catch (error) {
      // Windows readers/scanners can briefly hold the destination open. Keep
      // the writer lock and retry the SAME atomic rename for at most 465 ms.
      // Never unlink the destination, bypass permissions or steal a lock.
      if (platform !== "win32" || !["EPERM", "EBUSY"].includes(error.code) || attempt >= 5) throw error;
      await delayImpl(15 * (2 ** attempt));
    }
  }
}

// Shared-file state uses an exclusive cross-replica writer lock and atomic
// replacement. A crashed writer's lock is deliberately NOT stolen by a timer:
// an operator must confirm the old writer stopped before clearing that lock.
export class SignedStore {
  constructor(root, name, master) {
    if (!root || !/^[a-z][a-z0-9-]*\.json$/.test(name) || String(master ?? "").length < 32) {
      throw new Error("Persistent signed store is not configured");
    }
    this.root = path.resolve(root);
    this.file = path.join(this.root, name);
    this.lock = `${this.file}.lock`;
    this.key = createHmac("sha256", master).update(`codey-store-v1:${name}`).digest();
  }

  signature(payload) {
    return createHmac("sha256", this.key).update(payload).digest("base64url");
  }

  async read() {
    const raw = await readFile(this.file);
    if (raw.length > 16 * 1024 * 1024) throw new Error("Signed store exceeds size limit");
    const envelope = JSON.parse(raw.toString("utf8"));
    if (typeof envelope.payload !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(envelope.mac ?? "") ||
        !timingSafeEqual(Buffer.from(envelope.mac), Buffer.from(this.signature(envelope.payload)))) {
      throw new Error("Signed store integrity check failed");
    }
    const record = JSON.parse(envelope.payload);
    if (record.schema !== 1 || !/^[a-f0-9]{32}$/.test(record.revision ?? "")) {
      throw new Error("Signed store format is invalid");
    }
    return record;
  }

  async write(data) {
    const record = { schema: 1, revision: randomBytes(16).toString("hex"), data };
    const payload = JSON.stringify(record);
    const temporary = `${this.file}.${randomBytes(16).toString("hex")}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ payload, mac: this.signature(payload) }), { flag: "wx", mode: 0o600 });
      await replaceSignedFile(temporary, this.file);
    } finally {
      await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; });
    }
    return record;
  }

  async withLock(operation) {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    let handle;
    const deadline = Date.now() + 10000;
    while (!handle) {
      try { handle = await open(this.lock, "wx", 0o600); }
      catch (error) {
        if (error.code !== "EEXIST") throw error;
        if (Date.now() >= deadline) throw requestError("设置正在更新，请稍后重试", 503);
        await delay(40);
      }
    }
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
      return await operation();
    } finally {
      await handle.close();
      await unlink(this.lock);
    }
  }

  async initialize(data) {
    return this.withLock(async () => {
      try { return await this.read(); }
      catch (error) {
        if (error.code !== "ENOENT") throw error;
        return this.write(data);
      }
    });
  }

  async mutate(operation) {
    return this.withLock(async () => {
      const current = await this.read();
      const result = await operation(current.data);
      await this.write(current.data);
      return result;
    });
  }
}
