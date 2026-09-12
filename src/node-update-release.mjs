import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { requestError } from "./signed-store.mjs";
import { UPDATE_RELEASE_ID, verifyNodeRelease } from "./node-update-manifest.mjs";
export { UPDATE_PROTOCOL, UPDATE_RELEASE_ID, UPDATE_COMPONENTS, UPDATE_PLATFORMS,
  validateNodeRelease, verifyNodeRelease } from "./node-update-manifest.mjs";
const fields = (value, allowed) => value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).every((key) => allowed.includes(key));
const invalid = () => requestError("节点升级发行版无效或签名验证失败", 503);

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
