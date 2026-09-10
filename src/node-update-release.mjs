import { createHash, createPublicKey, verify } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { requestError } from "./signed-store.mjs";

export const UPDATE_PROTOCOL = 1;
export const UPDATE_RELEASE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const UPDATE_COMPONENTS = Object.freeze(["cloudcli", "copilotApi", "codey"]);
const HASH = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/;
const fields = (value, allowed) => value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).every((key) => allowed.includes(key));
const invalid = () => requestError("节点升级发行版无效或签名验证失败", 503);

export function validateNodeRelease(value, now = Date.now(), allowExpired = false) {
  if (!fields(value, ["schema", "kind", "id", "sequence", "createdAt", "expiresAt", "protocol", "platform",
    "components", "migrations", "configSchema", "notes", "rollback"]) ||
      value.schema !== 1 || value.kind !== "codey-node-release" || !UPDATE_RELEASE_ID.test(value.id ?? "") ||
      !Number.isSafeInteger(value.sequence) || value.sequence < 1 || value.protocol !== UPDATE_PROTOCOL ||
      value.platform !== "linux-x64" || value.configSchema !== 1 || value.rollback !== "code-only" ||
      !Number.isSafeInteger(value.createdAt) || value.createdAt > now + 60000 ||
      !Number.isSafeInteger(value.expiresAt) || (!allowExpired && value.expiresAt <= now) || value.expiresAt <= value.createdAt ||
      value.expiresAt - value.createdAt > 90 * 86400000 ||
      typeof value.notes !== "string" || value.notes.length > 4000 ||
      !Array.isArray(value.migrations) || value.migrations.length > 20 ||
      value.migrations.some((id) => !/^[a-z0-9][a-z0-9-]{0,79}$/.test(id)) ||
      new Set(value.migrations).size !== value.migrations.length ||
      !fields(value.components, UPDATE_COMPONENTS) || !Object.keys(value.components).length) throw invalid();
  if (Object.hasOwn(value.components, "codey") && Object.keys(value.components).length !== 1) throw invalid();
  for (const [name, component] of Object.entries(value.components)) {
    if (!fields(component, ["version", "commit", "file", "sha256", "size", "entrySha256", "lockSha256", "nodeMajors"]) ||
        !VERSION.test(component.version ?? "") || !COMMIT.test(component.commit ?? "") ||
        component.file !== (name === "codey" ? `codey-${component.version}.tgz`
          : name === "cloudcli" ? "cloudcli.tar.gz" : "gateway.tar.gz") ||
        !HASH.test(component.sha256 ?? "") || !HASH.test(component.entrySha256 ?? "") ||
        (["cloudcli", "codey"].includes(name) && !HASH.test(component.lockSha256 ?? "")) ||
        !Number.isSafeInteger(component.size) || component.size < 1 || component.size > 512 * 1024 * 1024 ||
        !Array.isArray(component.nodeMajors) || !component.nodeMajors.length || component.nodeMajors.length > 10 ||
        component.nodeMajors.some((major) => !Number.isInteger(major) || major < 20 || major > 40)) throw invalid();
  }
  return value;
}

export function verifyNodeRelease(envelope, publicKey, now = Date.now(), allowExpired = false) {
  if (!fields(envelope, ["payload", "signature"]) || typeof envelope.payload !== "string" ||
      envelope.payload.length > 100000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.payload) ||
      typeof envelope.signature !== "string" || !/^[A-Za-z0-9_-]{86}$/.test(envelope.signature)) throw invalid();
  const key = createPublicKey(publicKey);
  if (key.asymmetricKeyType !== "ed25519") throw invalid();
  const bytes = Buffer.from(envelope.payload, "base64");
  if (bytes.toString("base64") !== envelope.payload ||
      !verify(null, bytes, key, Buffer.from(envelope.signature, "base64url"))) throw invalid();
  let release;
  try { release = JSON.parse(bytes.toString("utf8")); } catch { throw invalid(); }
  validateNodeRelease(release, now, allowExpired);
  return { release, envelope, digest: createHash("sha256").update(bytes).digest("hex") };
}

export async function readUpdateFile(root, relative, maximum) {
  const parts = relative.split("/");
  if (path.isAbsolute(relative) || relative.includes("\\") ||
      parts.some((part) => !/^[a-zA-Z0-9_.-]+$/.test(part) || part === "." || part === "..")) throw invalid();
  let target = path.resolve(root);
  if ((await lstat(target)).isSymbolicLink()) throw invalid();
  for (const part of parts) {
    target = path.join(target, part);
    if ((await lstat(target)).isSymbolicLink()) throw invalid();
  }
  const info = await lstat(target);
  if (!info.isFile() || info.size > maximum) throw invalid();
  return { target, size: info.size };
}

export class NodeUpdateCatalog {
  constructor({ root, publicKey, clock = Date.now }) {
    Object.assign(this, { root: root ? path.resolve(root) : null, publicKey, clock });
  }

  get configured() { return Boolean(this.root && this.publicKey); }

  async list() {
    if (!this.configured) return [];
    let target;
    try { ({ target } = await readUpdateFile(this.root, "catalog.json", 4 * 1024 * 1024)); }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
    const catalog = JSON.parse(await readFile(target, "utf8"));
    if (!fields(catalog, ["schema", "releases"]) || catalog.schema !== 1 ||
        !Array.isArray(catalog.releases) || catalog.releases.length > 100) throw invalid();
    const now = this.clock();
    const rows = catalog.releases.map((entry) => verifyNodeRelease(entry, this.publicKey, now, true));
    if (new Set(rows.map((row) => row.release.id)).size !== rows.length ||
        new Set(rows.map((row) => row.release.sequence)).size !== rows.length) throw invalid();
    return rows.filter((row) => row.release.expiresAt > now).sort((a, b) => b.release.sequence - a.release.sequence);
  }

  async get(id, digest) {
    if (!UPDATE_RELEASE_ID.test(id ?? "")) throw requestError("未知发行版", 404);
    const row = (await this.list()).find((item) => item.release.id === id);
    if (!row) throw requestError("发行版不可用或已过期", 409);
    if (digest && digest !== row.digest) throw requestError("发行版清单已改变，请重新确认", 409);
    return row;
  }

  async artifact(id, filename) {
    const row = await this.get(id);
    const component = Object.values(row.release.components).find((item) => item.file === filename);
    if (!component) throw requestError("文件不存在", 404);
    const file = await readUpdateFile(this.root, `releases/${id}/${filename}`, component.size);
    if (file.size !== component.size) throw invalid();
    return { ...file, sha256: component.sha256 };
  }
}
