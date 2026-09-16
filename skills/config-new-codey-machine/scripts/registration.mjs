/** The private Portal registration contract, shared by all native installers. */
import { randomBytes, X509Certificate } from "node:crypto";
import { lstat, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REGISTRATION_FILE = "codey-machine-registration.json";
export const PLATFORMS = Object.freeze(["linux-x64", "windows-x64", "macos-arm64", "macos-x64"]);
const keys = ["clientSigningKey", "workspaceSsoKey", "tunnelUpdateKey"];
const credentials = [...keys, "workspaceSubject", "workspaceUsername"];
const requireValue = (condition, message) => { if (!condition) throw new Error(message); };
const exact = (value, fields) => value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key));

export function nativePlatform(platform = process.platform, arch = process.arch) {
  const target = `${platform === "win32" ? "windows" : platform === "darwin" ? "macos" : platform}-${arch}`;
  requireValue(PLATFORMS.includes(target), "Use native Linux x64, Windows x64 or macOS arm64/x64.");
  return target;
}

export function validateRegistration(document, expected = {}, now = Date.now()) {
  requireValue(exact(document, ["schema", "package", "machine", "credentials", "devTunnelConnectToken"]) &&
    document.schema === 2, "Missing a complete schema-2 Portal registration; runtime installation alone is not enrollment.");
  const descriptor = document.package, machine = document.machine, identity = document.credentials;
  requireValue(exact(descriptor, ["portalOrigin", "releaseId", "platform"]) &&
    PLATFORMS.includes(descriptor.platform) && /^machine-[a-f0-9]{16}$/.test(descriptor.releaseId),
  "Invalid registration package identity.");
  let origin;
  try { origin = new URL(descriptor.portalOrigin); } catch { /* Fail without printing input. */ }
  requireValue(origin?.protocol === "https:" && origin.origin === descriptor.portalOrigin &&
    !origin.username && !origin.password, "Invalid registration Portal origin.");
  for (const name of ["platform", "portalOrigin", "releaseId"]) {
    requireValue(expected[name] === undefined || expected[name] === descriptor[name],
      "Registration does not match this machine's platform, Portal or release.");
  }
  requireValue(exact(machine, ["schema", "nodeId", "name", "region", "platform", "tlsCertificate", "networkMode", "devTunnel"]) &&
    machine.schema === 1 && /^n-[a-f0-9]{24}$/.test(machine.nodeId) &&
    machine.platform === descriptor.platform && machine.networkMode === "devtunnel" &&
    typeof machine.name === "string" && machine.name.trim().length > 0 && machine.name.length <= 80 &&
    typeof machine.region === "string" && machine.region.length <= 120 &&
    !/[\x00-\x1f]/.test(machine.name + machine.region), "Invalid native machine registration.");
  const legacy = identity && Object.hasOwn(identity, "updaterCredential");
  const identityKeys = legacy ? [...keys, "updaterCredential"] : keys;
  requireValue(exact(identity, legacy ? [...credentials, "updaterCredential"] : credentials) &&
    /^m-[a-f0-9]{24}$/.test(identity.workspaceSubject) &&
    /^[a-z][a-z0-9_-]{0,31}$/.test(identity.workspaceUsername) &&
    identityKeys.every(key => typeof identity[key] === "string" && /^[A-Za-z0-9_-]{43}$/.test(identity[key]) &&
      Buffer.from(identity[key], "base64url").toString("base64url") === identity[key]) &&
    new Set(identityKeys.map(key => identity[key])).size === identityKeys.length, "Invalid or missing node credentials.");
  const tunnel = machine.devTunnel;
  requireValue(exact(tunnel, ["tunnelId", "clusterId"]) && tunnel.tunnelId === `codey-${machine.nodeId}` &&
    /^[a-z][a-z0-9]{1,15}$/.test(tunnel.clusterId), "Registration tunnel is not bound to this node.");
  const token = document.devTunnelConnectToken;
  let claims;
  try {
    requireValue(typeof token === "string" && token.length <= 8192 &&
      /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token), "");
    claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url"));
  } catch { /* Never include credential-bearing JSON in an error. */ }
  requireValue(claims?.scp === "connect" && claims.tunnelId === tunnel.tunnelId &&
    claims.clusterId === tunnel.clusterId && Number.isInteger(claims.exp) &&
    claims.exp > now / 1000 + 3600 && claims.exp <= now / 1000 + 86400 + 300,
  "Registration requires a fresh connect-only token for this private tunnel.");
  const pem = machine.tlsCertificate, serverName = `${machine.nodeId}.nodes.codey.internal`;
  let validCertificate = false;
  try {
    requireValue(typeof pem === "string" && pem.length <= 8192 &&
      /^-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----\s*$/.test(pem), "");
    const cert = new X509Certificate(pem), key = cert.publicKey;
    validCertificate = !cert.ca && cert.subjectAltName === `DNS:${serverName}` &&
      cert.issuer === cert.subject && cert.verify(key) && cert.checkHost(serverName, { wildcards: false }) &&
      Date.parse(cert.validFrom) <= now && Date.parse(cert.validTo) >= now + 86400000 &&
      Date.parse(cert.validTo) <= now + 400 * 86400000 && ["rsa", "ec", "ed25519"].includes(key.asymmetricKeyType) &&
      (key.asymmetricKeyType !== "rsa" || key.asymmetricKeyDetails.modulusLength >= 2048);
  } catch { /* Public certificate diagnostics must not accidentally print private input. */ }
  requireValue(validCertificate, "Registration requires this node's valid, self-signed non-CA TLS certificate.");
  requireValue(Buffer.byteLength(JSON.stringify(document, null, 2) + "\n") <= 32768, "Registration exceeds the Portal's 32 KiB limit.");
  return document;
}

export function registrationDocument(setup, identity, coordinates, token, certificate, computer) {
  const regions = { "linux-x64": "Linux", "windows-x64": "Windows", "macos-arm64": "macOS", "macos-x64": "macOS" };
  return validateRegistration({
    schema: 2,
    package: { portalOrigin: setup.portalOrigin, releaseId: setup.releaseId, platform: setup.platform },
    machine: {
      schema: 1, nodeId: identity.nodeId, name: computer, region: `${regions[setup.platform]} · DevTunnel`,
      platform: setup.platform, tlsCertificate: certificate, networkMode: "devtunnel", devTunnel: coordinates,
    },
    credentials: Object.fromEntries(credentials.map(key => [key, identity[key]])),
    devTunnelConnectToken: token,
  });
}

export async function writeRegistration(file, document) {
  validateRegistration(document);
  // Windows exports through Write-CodeyFile instead, which applies an owner/SYSTEM ACL.
  requireValue(process.platform !== "win32", "Use the native Windows owner-only ACL exporter.");
  try {
    const info = await lstat(file);
    requireValue(info.isFile() && !info.isSymbolicLink() && info.uid === process.getuid(),
      "Refusing to replace an unowned or linked registration file.");
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const temporary = file + "." + randomBytes(12).toString("hex") + ".next";
  try {
    await writeFile(temporary, JSON.stringify(document, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; });
  }
  return verifyRegistrationFile(file, document.package);
}

export async function verifyRegistrationFile(file, expected = {}) {
  const info = await lstat(file);
  requireValue(info.isFile() && !info.isSymbolicLink() && info.size <= 32768,
    "Missing a regular, bounded registration JSON file.");
  requireValue(process.platform === "win32" || (info.uid === process.getuid() && !(info.mode & 0o077)),
    "Registration credentials must be readable only by the owner.");
  let document;
  try { document = JSON.parse(await readFile(file, "utf8")); }
  catch { throw new Error("Registration is not valid JSON."); }
  validateRegistration(document, expected);
  return { file: path.resolve(file), nodeId: document.machine.nodeId, platform: document.machine.platform };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [operation, file, platform] = process.argv.slice(2);
  Promise.resolve().then(async () => {
    requireValue(operation === "check" && file && process.argv.length <= 5, "Usage: registration.mjs check FILE [PLATFORM]");
    console.log(JSON.stringify({ ok: true, ...await verifyRegistrationFile(file, { platform: platform ?? nativePlatform() }) }));
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
