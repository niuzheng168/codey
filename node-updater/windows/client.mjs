import { createHash, createPublicKey } from "node:crypto";
import { open, readFile, rename, stat } from "node:fs/promises";

export class UpdateError extends Error {
  constructor(code, options) { super(code, options); this.code = code; }
}
export function requireValue(value, code = "configuration_changed") {
  if (!value) throw new UpdateError(code);
}
export const sha = value => createHash("sha256").update(value).digest("hex");
export async function readJson(file) {
  try { return JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, "")); }
  catch { throw new UpdateError("configuration_changed"); }
}
export async function save(file, value) {
  const temporary = file + ".next";
  const stream = await open(temporary, "w", 0o600);
  try { await stream.writeFile(JSON.stringify(value, null, 2) + "\n"); await stream.sync(); }
  finally { await stream.close(); }
  await rename(temporary, file);
}
export function validateConfig(value, { platforms = ["windows-x64"] } = {}) {
  requireValue(value && value.schema === 1 && value.protocol === 1 && platforms.includes(value.platform) &&
    /^[a-z0-9][a-z0-9_-]{0,31}$/.test(value.nodeId) && value.nodeId !== "local" &&
    /^[a-z0-9-]{1,80}$/.test(value.ownerId) && /^[a-z][a-z0-9_-]{0,31}$/.test(value.username) &&
    /^[A-Za-z0-9_-]{43}$/.test(value.credential) && Number.isSafeInteger(value.minimumSequence) &&
    value.minimumSequence >= 0 && typeof value.releasePublicKey === "string" && value.releasePublicKey.length < 8192);
  const origin = new URL(value.portalOrigin);
  requireValue(origin.protocol === "https:" && !origin.username && !origin.password && !origin.search &&
    !origin.hash && ["", "/"].includes(origin.pathname));
  requireValue(createPublicKey(value.releasePublicKey).asymmetricKeyType === "ed25519", "signature_invalid");
  return { ...value, portalOrigin: origin.origin };
}

export class Client {
  constructor(config, { fetchImpl = fetch } = {}) { this.config = config; this.fetch = fetchImpl; }
  async request(route, value, timeout = 30000) {
    requireValue(/^\/api\/node-updater\/(?:poll|report|releases\/[a-z0-9-]{1,64}\/codey-[0-9A-Za-z.-]+\.tgz)$/.test(route));
    let response;
    try {
      response = await this.fetch(this.config.portalOrigin + route, {
        method: value === undefined ? "GET" : "POST", redirect: "error",
        signal: AbortSignal.timeout(timeout), cache: "no-store",
        headers: { Authorization: "Bearer " + this.config.credential,
          "x-codey-node-id": this.config.nodeId, "Content-Type": "application/json" },
        ...(value === undefined ? {} : { body: JSON.stringify(value) }),
      });
    } catch { throw new UpdateError("download_failed"); }
    requireValue(response.ok, [401, 403, 409].includes(response.status) ? "lease_lost" : "download_failed");
    return response;
  }
  async json(route, value) {
    const response = await this.request(route, value);
    const chunks = [];
    let size = 0;
    for await (const bytes of response.body) {
      size += bytes.length;
      requireValue(size <= 1024 * 1024, "download_failed");
      chunks.push(bytes);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw new UpdateError("download_failed"); }
  }
  async download(releaseId, artifact, file) {
    requireValue(/^[a-z0-9-]{1,64}$/.test(releaseId) && artifact.file === `codey-${artifact.version}.tgz` &&
      /^[a-f0-9]{64}$/.test(artifact.sha256) && Number.isSafeInteger(artifact.size) &&
      artifact.size > 0 && artifact.size <= 512 * 1024 * 1024, "signature_invalid");
    try {
      const info = await stat(file);
      requireValue(info.isFile() && info.size === artifact.size && sha(await readFile(file)) === artifact.sha256,
        "signature_invalid");
      return;
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    const response = await this.request(`/api/node-updater/releases/${releaseId}/${artifact.file}`, undefined, 180000);
    const temporary = file + ".part";
    const output = await open(temporary, "wx", 0o600);
    const digest = createHash("sha256");
    let size = 0;
    try {
      for await (const bytes of response.body) {
        size += bytes.length;
        requireValue(size <= artifact.size, "signature_invalid");
        digest.update(bytes);
        await output.writeFile(bytes);
      }
      await output.sync();
    } finally { await output.close(); }
    requireValue(size === artifact.size && digest.digest("hex") === artifact.sha256, "signature_invalid");
    await rename(temporary, file);
  }
}
