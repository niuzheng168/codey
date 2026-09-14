/** Prepare a private native updater from the installed, checksum-bound npm payload. */
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { nativePlatform } from "./registration.mjs";

const requireValue = value => { if (!value) throw new Error("Invalid native updater bootstrap or existing identity."); };
const read = async file => JSON.parse(await readFile(file, "utf8"));
const inside = (root, file) => {
  const relative = path.relative(root, file);
  return relative && !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(".." + path.sep);
};

export async function prepareUpdater(runtimeFile, destination, { platform = nativePlatform() } = {}) {
  requireValue(["windows-x64", "macos-arm64", "macos-x64"].includes(platform));
  const runtime = await read(runtimeFile), windows = platform === "windows-x64";
  requireValue(runtime.schema === 2 && runtime.layout === "npm-codey-package" && runtime.ready === true &&
    runtime.kind === (windows ? "codey-windows-oneclick" : "codey-macos-oneclick") &&
    (windows || runtime.platform === platform));
  const home = await realpath(runtime.ownerHome);
  const source = await realpath(path.join(runtime.codeyDirectory, "updater/native", platform));
  requireValue(inside(home, source) && inside(home, path.resolve(destination)));
  const identity = await read(runtime.identityFile), setup = await read(runtime.setupFile);
  const env = windows ? runtime.services.codey.environment : runtime.environment;
  requireValue(identity.nodeId === runtime.nodeId && env.CODEY_PORTAL_NODE_ID === identity.nodeId &&
    env.CODEY_PORTAL_PRINCIPAL_ID === identity.workspaceSubject &&
    env.CODEY_PORTAL_USERNAME === identity.workspaceUsername &&
    setup.platform === platform && setup.portalOrigin === runtime.portalOrigin && setup.updater?.protocol === 1);
  const raw = await readFile(path.join(source, "agent-files.json"));
  const manifest = JSON.parse(raw);
  requireValue(manifest.schema === 1 && manifest.platform === platform &&
    manifest.files && Object.keys(manifest.files).length > 5 && Object.keys(manifest.files).length <= 100);
  const payload = [];
  for (const [name, hash] of Object.entries(manifest.files)) {
    requireValue(/^[\w.-]+(?:\/[\w.-]+)*$/.test(name) &&
      !name.split("/").some(part => [".", "..", "config.json", "agent-files.json"].includes(part)) &&
      /^[a-f0-9]{64}$/.test(hash));
    const file = path.join(source, name), info = await lstat(file);
    requireValue(info.isFile() && !info.isSymbolicLink() && inside(source, await realpath(file)));
    const bytes = await readFile(file);
    requireValue(createHash("sha256").update(bytes).digest("hex") === hash);
    payload.push([name, bytes]);
  }
  const client = windows ? "client.mjs" : "windows/client.mjs";
  requireValue(Object.hasOwn(manifest.files, client) &&
    Object.hasOwn(manifest.files, windows ? "install.ps1" : "install.py"));
  const { validateConfig } = await import(pathToFileURL(path.join(source, client)).href);
  let config = validateConfig({
    schema: 1, protocol: 1, platform, nodeId: identity.nodeId,
    ownerId: identity.workspaceSubject, username: identity.workspaceUsername,
    portalOrigin: runtime.portalOrigin, credential: identity.updaterCredential,
    releasePublicKey: setup.updater.releasePublicKey, minimumSequence: 0,
  }, { platforms: [platform] });
  // A later explicit credential rotation or sequence floor must survive reruns.
  try {
    const saved = validateConfig(await read(path.join(home, ".config/codey-updater/config.json")), { platforms: [platform] });
    requireValue(["nodeId", "ownerId", "username", "portalOrigin", "releasePublicKey"]
      .every(name => saved[name] === config[name]));
    config = saved;
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  await mkdir(destination, { recursive: true, mode: 0o700 });
  requireValue((await lstat(destination)).isDirectory() && !(await lstat(destination)).isSymbolicLink() &&
    inside(home, await realpath(destination)) && (await readdir(destination)).length === 0);
  for (const [name, bytes] of [...payload, ["agent-files.json", raw]]) {
    const file = path.join(destination, name);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, bytes, { mode: 0o600, flag: "wx" });
  }
  await writeFile(path.join(destination, "config.json"), JSON.stringify(config, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  return { platform, nodeId: config.nodeId, directory: path.resolve(destination) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  Promise.resolve().then(async () => {
    requireValue(process.argv.length === 4);
    console.log(JSON.stringify(await prepareUpdater(process.argv[2], process.argv[3])));
  }).catch(() => { console.error("Native updater bootstrap failed; existing credentials were not replaced."); process.exitCode = 1; });
}
