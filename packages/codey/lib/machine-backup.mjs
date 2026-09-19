/** Bounded gzip/JSON settings archives: no archive paths are ever extracted verbatim. */
import { createHash, createPublicKey, randomBytes, X509Certificate } from "node:crypto";
import { lstat, readFile, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync, gunzipSync } from "node:zlib";
import { exists, fileHash } from "./package-files.mjs";
import { GH_BINDING_FILE } from "./copilot-auth.mjs";

const LIMIT = 32 * 1024 * 1024, FILE_LIMIT = 4 * 1024 * 1024;
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const fail = message => { throw new Error(message); };
const json = bytes => {
  try { return JSON.parse(bytes); } catch { fail("Invalid backup JSON; private contents were not printed"); }
};
const gatewayName = name => /^(?:(?!\.{1,2}\/)[a-zA-Z0-9_-]+\/)?(?:ent_)?github_token$/.test(name) ||
  ["config.json", "codex_credentials.json", GH_BINDING_FILE].includes(name);

function fixedFiles(m) {
  const c = m.config;
  return {
    "node/runtime.json": m.i.file,
    "node/identity.json": c.identityFile,
    "node/node-cert.pem": c.certificate,
    "node/node-key.pem": c.environment.CODEY_PORTAL_TLS_KEY,
    "node/client-signing.key": c.environment.COPILOT_API_CODEY_SIGNING_KEY_FILE,
    "node/tunnel.json": c.tunnelFile, "node/setup.json": c.setupFile,
    ...Object.fromEntries(["config.toml", "models.json", "auth.json"].map(name => ["codex/" + name, path.join(c.codexHome, name)])),
  };
}
function targetFile(m, name) {
  const fixed = fixedFiles(m);
  if (Object.hasOwn(fixed, name) && typeof fixed[name] === "string") return fixed[name];
  if (name.startsWith("gateway/") && gatewayName(name.slice(8))) return path.join(m.config.environment.COPILOT_API_HOME, name.slice(8));
  fail("Unsupported backup entry; no files were restored");
}

export async function backupDocument(m) {
  const targets = fixedFiles(m), gateway = m.config.environment.COPILOT_API_HOME;
  await m.i.checked(gateway);
  for (const item of await readdir(gateway, { withFileTypes: true })) {
    if (gatewayName(item.name)) targets["gateway/" + item.name] = path.join(gateway, item.name);
    else if (item.isDirectory() && /^[a-zA-Z0-9_-]+$/.test(item.name)) {
      // Only the gateway's declared OAuth token names, never databases, caches or sessions.
      for (const name of ["github_token", "ent_github_token"]) {
        const file = path.join(gateway, item.name, name);
        if (await exists(file)) targets[`gateway/${item.name}/${name}`] = file;
      }
    }
  }
  const files = [], missing = [];
  let total = 0;
  for (const [name, file] of Object.entries(targets)) {
    if (!file || !await exists(file)) { missing.push(name); continue; }
    await m.i.checked(file);
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > FILE_LIMIT) fail("Backup input must be a bounded regular file");
    const bytes = await readFile(file);
    total += bytes.length;
    if (total > LIMIT / 2 || files.length >= 64) fail("Settings backup exceeds size/file limits");
    files.push({ name, sha256: hash(bytes), data: bytes.toString("base64") });
  }
  for (const item of files) if (await fileHash(targetFile(m, item.name)) !== item.sha256) fail("Settings changed during backup; retry");
  return { schema: 1, kind: "codey-settings-backup", createdAt: new Date().toISOString(),
    node: { nodeId: m.config.nodeId, platform: m.i.target, computer: m.config.computer, ownerHome: m.i.home },
    files, missing, excluded: ["programs/dependencies", "databases/projects/sessions", "OS/gh credential stores (DevTunnel/Keychain/Credential Manager/GitHub CLI)"] };
}

export function decodeBackup(bytes) {
  if (!bytes.length || bytes.length > LIMIT) fail("Backup exceeds the 32 MiB limit");
  let document;
  try { document = json(gunzipSync(bytes, { maxOutputLength: LIMIT })); }
  catch { fail("Not a valid bounded Codey gzip backup"); }
  if (document?.schema !== 1 || document.kind !== "codey-settings-backup" ||
      !/^n-[a-f0-9]{24}$/.test(document.node?.nodeId) || !Array.isArray(document.files) ||
      document.files.length < 1 || document.files.length > 64) fail("Invalid Codey backup schema");
  const names = new Set();
  for (const item of document.files) {
    if (typeof item?.name !== "string" || names.has(item.name.toLowerCase()) ||
        typeof item.data !== "string" || item.data.length > FILE_LIMIT * 1.4) fail("Duplicate or oversized backup entry");
    names.add(item.name.toLowerCase());
    const bytes = Buffer.from(item.data, "base64");
    if (bytes.length > FILE_LIMIT || bytes.toString("base64") !== item.data || hash(bytes) !== item.sha256) fail("Backup entry checksum mismatch");
  }
  return document;
}

export async function writeBackup(m, file, document) {
  await m.i.checked(file);
  if (await exists(file)) fail("Backup output already exists; choose a new filename");
  if (!await exists(path.dirname(file))) fail("Create the backup's parent directory first");
  await m.i.write(file, gzipSync(Buffer.from(JSON.stringify(document))));
  await m.privateFile(file);
}

export async function exportMachine(m, options) {
  return m.lock(async () => {
    await writeBackup(m, options.file, await backupDocument(m));
    return { ok: true, operation: "export", file: options.file,
      warning: "Private gzip backup, NOT encrypted. Keep it secret. OS-managed login caches are excluded; DevTunnel may require login again." };
  });
}

function validateIdentity(m, files) {
  const identity = json(files.get("node/identity.json") ?? "");
  if (identity.nodeId !== m.config.nodeId || identity.ownerHome !== m.i.home ||
      (m.i.ownerSid ? identity.ownerSid !== m.i.ownerSid : identity.ownerUid !== process.getuid()) ||
      !/^m-[a-f0-9]{24}$/.test(identity.workspaceSubject) || !/^[a-z][a-z0-9_-]{0,31}$/.test(identity.workspaceUsername) ||
      !["clientSigningKey", "workspaceSsoKey", "tunnelUpdateKey"].every(name => /^[A-Za-z0-9_-]{43}$/.test(identity[name]))) {
    fail("Backup node identity differs; use --settings-only when moving provider settings to another node");
  }
  try {
    const certificate = new X509Certificate(files.get("node/node-cert.pem"));
    const key = createPublicKey(files.get("node/node-key.pem"));
    if (certificate.ca || certificate.subjectAltName !== `DNS:${m.config.nodeId}.nodes.codey.internal` ||
        !certificate.checkHost(`${m.config.nodeId}.nodes.codey.internal`, { wildcards: false }) ||
        Date.parse(certificate.validFrom) > Date.now() ||
        !certificate.verify(certificate.publicKey) ||
        !certificate.publicKey.export({ type: "spki", format: "der" }).equals(key.export({ type: "spki", format: "der" })) ||
        Date.parse(certificate.validTo) <= Date.now()) throw new Error();
  } catch { fail("Backup TLS certificate/key is invalid or expired"); }
  if (files.get("node/client-signing.key")?.toString().trim() !== identity.clientSigningKey) fail("Backup node signing keys disagree");
  return identity;
}

export async function importMachine(m, options) {
  await m.privateFile(options.file);
  const info = await lstat(options.file);
  if (info.size > LIMIT) fail("Backup exceeds the 32 MiB limit");
  const document = decodeBackup(await readFile(options.file));
  // Validate every name, including omitted node entries in --settings-only mode.
  const files = new Map(document.files.map(item => {
    targetFile(m, item.name);
    return [item.name, Buffer.from(item.data, "base64")];
  }));
  const snapshot = json(files.get("node/runtime.json") ?? "");
  if (snapshot?.schema !== 2 || snapshot.layout !== "npm-codey-package" ||
      typeof snapshot.environment !== "object" || !snapshot.environment) fail("Invalid saved node configuration");
  const settingsOnly = Boolean(options["settings-only"]);
  const ghName = `gateway/${GH_BINDING_FILE}`;
  if (files.has(ghName)) {
    const { validateGhBinding } = await import(pathToFileURL(path.join(m.i.skill, "scripts/github-auth.mjs")).href);
    validateGhBinding(json(files.get(ghName)), String(document.node.platform).startsWith("windows-") ? "win32" : "linux");
  }
  if (!settingsOnly && (document.node.nodeId !== m.config.nodeId || document.node.ownerHome !== m.i.home ||
      document.node.platform !== m.i.target || document.node.computer !== m.config.computer)) {
    fail("Full restore is for the same node/owner/platform; use --settings-only on a different node");
  }
  const next = structuredClone(m.config);
  const provider = json(files.get("gateway/config.json") ?? "");
  if (!/^[A-Za-z0-9_-]{43}$/.test(snapshot.modelKey) || !provider.auth?.apiKeys?.includes(snapshot.modelKey)) fail("Backup model key and gateway configuration disagree");
  next.modelKey = snapshot.modelKey;
  next.environment.CODEY_MODEL_API_KEY = snapshot.modelKey;
  // Restore application options, never executable paths, node bindings or process environment.
  const preserved = /(?:_HOME|_FILE|_PATH|_DIR|_TLS_CERT|_TLS_KEY|_NODE_ID|_ALLOWED_ORIGIN|_SSO_KEY|_USERNAME|_PRINCIPAL_ID)$/;
  const setting = name => /^COPILOT_API_[A-Z0-9_]+$/.test(name) &&
    !name.startsWith("COPILOT_API_CODEY_") && !preserved.test(name);
  for (const name of Object.keys(next.environment).filter(setting)) delete next.environment[name];
  for (const [name, value] of Object.entries(snapshot.environment).filter(([name]) => setting(name))) {
    if (typeof value !== "string" || value.length > 32768 || /[\0\r\n]/.test(value)) fail("Invalid backed-up application setting");
    next.environment[name] = value;
  }
  if (!settingsOnly) {
    const identity = validateIdentity(m, files);
    const setup = json(files.get("node/setup.json") ?? "");
    if (setup.portalOrigin !== m.config.portalOrigin || snapshot.nodeId !== m.config.nodeId) fail("Backup Portal/node binding differs");
    const tunnel = json(files.get("node/tunnel.json") ?? "");
    const { validateTunnel } = await import(pathToFileURL(path.join(m.i.skill, "scripts/windows-runtime.mjs")).href);
    validateTunnel(tunnel, `codey-${m.config.nodeId}`, m.config.qualifiedTunnel.split(".")[1]);
    next.environment.CODEY_PORTAL_SSO_KEY = identity.workspaceSsoKey;
    next.environment.CODEY_PORTAL_USERNAME = identity.workspaceUsername;
    next.environment.CODEY_PORTAL_PRINCIPAL_ID = identity.workspaceSubject;
  }
  const writes = [];
  for (const [name, original] of files) {
    if (name === "node/runtime.json" || name === "node/setup.json" ||
        settingsOnly && (name.startsWith("node/") || name === ghName)) continue;
    const file = targetFile(m, name);
    await m.i.checked(file);
    let bytes = original;
    if (name === "codex/config.toml" && settingsOnly) {
      // Only the installer-owned catalog path is machine-specific; don't rewrite arbitrary TOML.
      const text = bytes.toString("utf8");
      bytes = Buffer.from(text.replace(/^model_catalog_json\s*=.*$/m,
        "model_catalog_json = " + JSON.stringify(path.join(m.config.codexHome, "models.json"))));
    }
    writes.push({ file, bytes, name });
  }
  const collisions = [];
  for (const item of writes) if (await exists(item.file)) collisions.push(item.name);
  const result = { ok: true, operation: "import", file: options.file, check: Boolean(options.check),
    settingsOnly, entries: writes.map(item => item.name), overwrite: collisions.length,
    warning: "OS-managed login caches are not restored. Run codey devtunnel login and codey doctor afterwards; changed certificates require Portal re-pinning." };
  if (options.check) return result;
  if (collisions.length && !options["replace-existing"]) fail("Restore would overwrite settings; inspect --check, then use --replace-existing");
  await m.external();
  return m.lock(async () => {
    await m.tools();
    const before = structuredClone(m.config), undo = [];
    const states = (await m.services()).map(item => item.auxiliary ? { ...item, running: false, enabled: false } : item);
    const backup = path.join(m.i.configRoot, `before-import-${randomBytes(8).toString("hex")}.gz`);
    await writeBackup(m, backup, await backupDocument(m));
    for (const item of writes) undo.push({ file: item.file, bytes: await exists(item.file) ? await readFile(item.file) : null });
    const stopped = states.map(item => ({ ...item, running: false, enabled: false }));
    try {
      await m.setStates(stopped);
      await m.waitFor(stopped);
      await m.i.checkPorts(m.config);
      for (const item of writes) {
        await m.i.directory(path.dirname(item.file));
        await m.i.write(item.file, item.bytes);
      }
      await m.save(next);
      await m.setStates(states);
      await m.waitFor(states);
      await m.verifyRunning(states);
      return { ...result, backup };
    } catch {
      try {
        await m.setStates(stopped);
        await m.waitFor(stopped);
        for (const item of undo) {
          if (item.bytes === null) await unlink(item.file).catch(error => { if (error.code !== "ENOENT") throw error; });
          else await m.i.write(item.file, item.bytes);
        }
        await m.save(before);
        await m.setStates(states);
        await m.waitFor(states);
      } catch { m.keepLock = true; fail(`Restore failed and rollback needs review; services may be stopped. Private backup: ${backup}`); }
      fail("Restore failed; previous settings and service state were restored");
    }
  });
}
