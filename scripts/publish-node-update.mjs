import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { copyFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { UPDATE_PLATFORMS, validateNodeRelease, verifyNodeRelease } from "../src/node-update-release.mjs";
import { knownRuntimePlatforms } from "../packages/codey/lib/package-info.mjs";
import { inspectUpdateArchive } from "../packages/codey/lib/update-archive.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const parseMajors = (value = "24") => value.split(",").map((item) => Number(item));

export async function createNodeUpdateRelease({
  manifestPath, output, privateKey, sequence, components,
  cloudcliNodeMajors = [24], gatewayNodeMajors = [24], codeyNodeMajors = [24], notes = "", migrations,
  platform = "linux-x64", releaseId,
  now = Date.now(), expiresAt = now + 30 * 86400000,
}) {
  const directory = path.dirname(path.resolve(manifestPath));
  const source = JSON.parse(await readFile(manifestPath, "utf8"));
  const npm = source.name === "codey" && source.codey;
  const npmArtifact = source.artifact ?? source.artifacts?.[0];
  components ??= npm ? ["codey"] : ["cloudcli", "copilotApi"];
  if (!UPDATE_PLATFORMS.includes(platform) || platform !== "linux-x64" && !npm) {
    throw new Error("Native signed updates require the shared whole-Codey npm package");
  }
  if (platform !== "linux-x64" &&
      (!knownRuntimePlatforms(source.runtimePlatforms) || !source.runtimePlatforms.includes(platform))) {
    throw new Error("This platform requires a compatible, validated shared Codey artifact");
  }
  if ((!npm && (!source.cloudcli || !source.gateway)) || !components.length ||
      components.some((name) => !["cloudcli", "copilotApi", "codey"].includes(name)) ||
      (npm ? components.length !== 1 || components[0] !== "codey" || !npmArtifact
        : components.includes("codey")) ||
      new Set(components).size !== components.length) throw new Error("A full, reviewed node build manifest is required");
  let evidence;
  try { evidence = JSON.parse(await readFile(path.join(directory, "validation.json"), "utf8")); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    evidence = JSON.parse(await readFile(path.join(directory, "report.json"), "utf8"));
  }
  if (evidence.passed !== true && evidence.status !== "complete") throw new Error("Build validation has not passed");
  const release = {
    schema: 1, kind: "codey-node-release",
    id: releaseId ?? (npm ? platform.startsWith("macos-") ? `codey-${platform}-${npmArtifact.sha256.slice(0, 16)}`
      : platform === "windows-x64" ? `codey-windows-${npmArtifact.sha256.slice(0, 16)}`
      : source.releaseId ?? `codey-${npmArtifact.sha256.slice(0, 16)}` : source.release),
    sequence, createdAt: now, expiresAt,
    protocol: 1, platform, configSchema: 1, rollback: "code-only", notes,
    migrations: migrations ?? (npm || components.includes("copilotApi") ? ["gateway-api-key-v1"] : []), components: {},
  };
  const files = [];
  for (const name of components) {
    const item = npm ? source.codey : source[name === "cloudcli" ? "cloudcli" : "gateway"];
    const filename = npm ? `codey-${item.version}.tgz` : name === "cloudcli" ? "cloudcli.tar.gz" : "gateway.tar.gz";
    if (npm && npmArtifact.file !== filename) throw new Error("Invalid Codey npm package filename");
    const body = await readFile(path.join(directory, filename));
    const archiveSha256 = npm ? npmArtifact.sha256 : item.archiveSha256;
    if (hash(body) !== archiveSha256 || (npm && body.length !== npmArtifact.size)) throw new Error("Node artifact checksum mismatch");
    if (platform.startsWith("macos-")) {
      // In particular, editing codey-package.json cannot make the published
      // Linux/Windows-only 0.1.4 tarball into a macOS release.
      const artifact = await inspectUpdateArchive(path.join(directory, filename), archiveSha256);
      if (!artifact.build.runtimePlatforms.includes(platform) ||
          artifact.pkg.version !== item.version || artifact.build.sourceCommit !== item.commit ||
          artifact.entrySha256 !== item.entrySha256 || artifact.build.lockSha256 !== item.lockSha256 ||
          JSON.stringify(artifact.build.runtimePlatforms) !== JSON.stringify(source.runtimePlatforms)) {
        throw new Error("macOS platform/build fingerprints differ from the actual Codey package");
      }
      let native;
      try { native = JSON.parse(await readFile(path.join(directory, `doctor-${platform}.json`), "utf8")); }
      catch { throw new Error("macOS native validation is required: save the target's codey doctor --json report beside the build"); }
      if (native.ok !== true || native.platform !== platform || native.version !== item.version ||
          native.entrySha256 !== item.entrySha256 || native.lockSha256 !== item.lockSha256 ||
          native.sourceCommit !== item.commit || !codeyNodeMajors.includes(native.nodeMajor) ||
          codeyNodeMajors.length !== 1 ||
          ["sqlite", "bcrypt", "ripgrep", "pty", "codexSdk"].some(name => native.native?.[name] !== true)) {
        throw new Error("macOS native validation does not match this platform, package or Node major");
      }
    }
    release.components[name] = {
      version: item.version, commit: npm ? item.commit : item.sourceCommit, file: filename,
      sha256: archiveSha256, size: body.length, entrySha256: item.entrySha256,
      ...(name === "cloudcli" || npm ? { lockSha256: item.lockSha256 } : {}),
      nodeMajors: npm ? codeyNodeMajors : name === "cloudcli" ? cloudcliNodeMajors : gatewayNodeMajors,
    };
    files.push({ name: filename, component: name, source: path.join(directory, filename) });
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
      if (hash(await readFile(destination)) !== release.components[file.component].sha256) {
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
      components: options.has("components") ? options.get("components").split(",") : undefined,
      cloudcliNodeMajors: parseMajors(options.get("cloudcli-node-majors")),
      gatewayNodeMajors: parseMajors(options.get("gateway-node-majors")),
      codeyNodeMajors: parseMajors(options.get("codey-node-majors")), notes: options.get("notes") || "",
      platform: options.get("platform") || "linux-x64",
      releaseId: options.get("release-id"),
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
