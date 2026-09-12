// The Portal and native agents share the exact signature/schema verifier.
import { createHash, createPublicKey, verify } from "node:crypto";

export const UPDATE_PROTOCOL = 1;
export const UPDATE_RELEASE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const UPDATE_COMPONENTS = Object.freeze(["cloudcli", "copilotApi", "codey"]);
export const UPDATE_PLATFORMS = Object.freeze(["linux-x64", "windows-x64", "macos-arm64", "macos-x64"]);
const HASH = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/;
const fields = (value, allowed) => value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).every(key => allowed.includes(key));
const invalid = () => Object.assign(new Error("节点升级发行版无效或签名验证失败"), { status: 503, code: "signature_invalid" });

export function validateNodeRelease(value, now = Date.now(), allowExpired = false) {
  if (!fields(value, ["schema", "kind", "id", "sequence", "createdAt", "expiresAt", "protocol", "platform",
    "components", "migrations", "configSchema", "notes", "rollback"]) ||
      value.schema !== 1 || value.kind !== "codey-node-release" || !UPDATE_RELEASE_ID.test(value.id ?? "") ||
      !Number.isSafeInteger(value.sequence) || value.sequence < 1 || value.protocol !== UPDATE_PROTOCOL ||
      !UPDATE_PLATFORMS.includes(value.platform) || value.configSchema !== 1 || value.rollback !== "code-only" ||
      !Number.isSafeInteger(value.createdAt) || value.createdAt > now + 60000 ||
      !Number.isSafeInteger(value.expiresAt) || (!allowExpired && value.expiresAt <= now) || value.expiresAt <= value.createdAt ||
      value.expiresAt - value.createdAt > 90 * 86400000 ||
      typeof value.notes !== "string" || value.notes.length > 4000 ||
      !Array.isArray(value.migrations) || value.migrations.length > 20 ||
      value.migrations.some(id => !/^[a-z0-9][a-z0-9-]{0,79}$/.test(id)) ||
      new Set(value.migrations).size !== value.migrations.length ||
      !fields(value.components, UPDATE_COMPONENTS) || !Object.keys(value.components).length) throw invalid();
  if (Object.hasOwn(value.components, "codey") && Object.keys(value.components).length !== 1) throw invalid();
  // Native desktop agents have no legacy split-component/systemd adapter.
  if (value.platform !== "linux-x64" && !Object.hasOwn(value.components, "codey")) throw invalid();
  for (const [name, component] of Object.entries(value.components)) {
    if (!fields(component, ["version", "commit", "file", "sha256", "size", "entrySha256", "lockSha256", "nodeMajors"]) ||
        !VERSION.test(component.version ?? "") || !COMMIT.test(component.commit ?? "") ||
        component.file !== (name === "codey" ? `codey-${component.version}.tgz`
          : name === "cloudcli" ? "cloudcli.tar.gz" : "gateway.tar.gz") ||
        !HASH.test(component.sha256 ?? "") || !HASH.test(component.entrySha256 ?? "") ||
        (["cloudcli", "codey"].includes(name) && !HASH.test(component.lockSha256 ?? "")) ||
        !Number.isSafeInteger(component.size) || component.size < 1 || component.size > 512 * 1024 * 1024 ||
        !Array.isArray(component.nodeMajors) || !component.nodeMajors.length || component.nodeMajors.length > 10 ||
        component.nodeMajors.some(major => !Number.isInteger(major) || major < 20 || major > 40)) throw invalid();
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
