import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { copyFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { validateNodeRelease, verifyNodeRelease } from "../src/node-update-release.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const parseMajors = (value = "24") => value.split(",").map((item) => Number(item));

export async function createNodeUpdateRelease({
  manifestPath, output, privateKey, sequence, components = ["cloudcli", "copilotApi"],
  cloudcliNodeMajors = [24], gatewayNodeMajors = [24], notes = "", migrations,
  now = Date.now(), expiresAt = now + 30 * 86400000,
}) {
  const directory = path.dirname(path.resolve(manifestPath));
  const source = JSON.parse(await readFile(manifestPath, "utf8"));
  if (!source.cloudcli || !source.gateway || !components.length ||
      components.some((name) => !["cloudcli", "copilotApi"].includes(name)) ||
      new Set(components).size !== components.length) throw new Error("A full, reviewed node build manifest is required");
  let evidence;
  try { evidence = JSON.parse(await readFile(path.join(directory, "validation.json"), "utf8")); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    evidence = JSON.parse(await readFile(path.join(directory, "report.json"), "utf8"));
  }
  if (evidence.passed !== true && evidence.status !== "complete") throw new Error("Build validation has not passed");
  const release = {
    schema: 1, kind: "codey-node-release", id: source.release, sequence, createdAt: now, expiresAt,
    protocol: 1, platform: "linux-x64", configSchema: 1, rollback: "code-only", notes,
    migrations: migrations ?? (components.includes("copilotApi") ? ["gateway-api-key-v1"] : []), components: {},
  };
  const files = [];
  for (const name of components) {
    const item = source[name === "cloudcli" ? "cloudcli" : "gateway"];
    const filename = name === "cloudcli" ? "cloudcli.tar.gz" : "gateway.tar.gz";
    const body = await readFile(path.join(directory, filename));
    if (hash(body) !== item.archiveSha256) throw new Error("Node artifact checksum mismatch");
    release.components[name] = {
      version: item.version, commit: item.sourceCommit, file: filename,
      sha256: item.archiveSha256, size: body.length, entrySha256: item.entrySha256,
      ...(name === "cloudcli" ? { lockSha256: item.lockSha256 } : {}),
      nodeMajors: name === "cloudcli" ? cloudcliNodeMajors : gatewayNodeMajors,
    };
    files.push({ name: filename, source: path.join(directory, filename) });
  }
  validateNodeRelease(release, now);
  const key = createPrivateKey(privateKey);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("An Ed25519 release signing key is required");
  const bytes = Buffer.from(JSON.stringify(release));
  const envelope = { payload: bytes.toString("base64"), signature: sign(null, bytes, key).toString("base64url") };
  const publicKey = createPublicKey(key).export({ type: "spki", format: "pem" });
  verifyNodeRelease(envelope, publicKey, now);
  const root = path.resolve(output);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const lock = path.join(root, "publish.lock");
  await mkdir(lock); // Never steal a competing/crashed publisher's lock.
  try {
    let previous = { schema: 1, releases: [] };
    try { previous = JSON.parse(await readFile(path.join(root, "catalog.json"), "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (previous.schema !== 1 || !Array.isArray(previous.releases) || previous.releases.length >= 100) {
      throw new Error("Invalid or full release catalog");
    }
    let highest = 0;
    const retained = [];
    for (const row of previous.releases) {
      const content = Buffer.from(row.payload, "base64");
      if (!verify(null, content, publicKey, Buffer.from(row.signature, "base64url"))) throw new Error("Existing catalog signature is invalid");
      const item = JSON.parse(content);
      highest = Math.max(highest, item.sequence);
      if (item.id === release.id) throw new Error("Release IDs and artifacts are immutable");
      if (item.expiresAt > now) retained.push(row);
    }
    if (sequence <= highest) throw new Error("Release sequence must increase");
    const target = path.join(root, "releases", release.id);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await mkdir(target, { mode: 0o700 });
    for (const file of files) {
      const destination = path.join(target, file.name);
      await copyFile(file.source, destination);
      if (hash(await readFile(destination)) !== release.components[file.name === "cloudcli.tar.gz" ? "cloudcli" : "copilotApi"].sha256) {
        throw new Error("Published artifact verification failed");
      }
    }
    await writeFile(path.join(target, "release.json"), JSON.stringify(envelope, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    const temporary = path.join(root, `catalog-${release.id}.next`);
    await writeFile(temporary, JSON.stringify({ schema: 1, releases: [envelope, ...retained] }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    await rename(temporary, path.join(root, "catalog.json"));
    return { releaseId: release.id, sequence, digest: hash(bytes), components, artifactCount: files.length };
  } finally {
    const { rmdir } = await import("node:fs/promises");
    await rmdir(lock);
  }
}

async function main() {
  const [mode, ...args] = process.argv.slice(2);
  const options = new Map();
  for (let index = 0; index < args.length; index += 2) {
    if (!args[index]?.startsWith("--") || args[index + 1] === undefined) throw new Error("Use --option value pairs");
    options.set(args[index].slice(2), args[index + 1]);
  }
  if (mode === "keygen") {
    if (!options.get("private-key") || !options.get("public-key")) throw new Error("Specify private-key and public-key output paths");
    const keys = generateKeyPairSync("ed25519", {
      privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" },
    });
    await writeFile(options.get("private-key"), keys.privateKey, { flag: "wx", mode: 0o600 });
    await writeFile(options.get("public-key"), keys.publicKey, { flag: "wx", mode: 0o644 });
    console.log(JSON.stringify({ generated: true, privateKeyPrinted: false }));
  } else if (mode === "publish") {
    for (const name of ["manifest", "output", "private-key", "sequence"]) if (!options.get(name)) throw new Error(`Missing --${name}`);
    const result = await createNodeUpdateRelease({
      manifestPath: options.get("manifest"), output: options.get("output"),
      privateKey: await readFile(options.get("private-key"), "utf8"), sequence: Number(options.get("sequence")),
      components: (options.get("components") || "cloudcli,copilotApi").split(","),
      cloudcliNodeMajors: parseMajors(options.get("cloudcli-node-majors")),
      gatewayNodeMajors: parseMajors(options.get("gateway-node-majors")), notes: options.get("notes") || "",
      migrations: options.has("migrations") ? options.get("migrations").split(",").filter(Boolean) : undefined,
    });
    console.log(JSON.stringify(result));
  } else {
    throw new Error("Use keygen or publish; see docs/node-updates.md. This command does not deploy ACA or update nodes.");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
