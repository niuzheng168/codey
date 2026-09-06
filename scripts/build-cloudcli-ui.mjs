import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  UI_ASSET_PREFIX, UI_MANIFEST_MARKER, UI_PACKAGE_FILE, UI_RUNTIME_MARKER,
  readUiPackage, readUiPackageFile, uiContentType, validateUiManifest, validateUiRelease, validateUiTemplate,
} from "../src/cloudcli-ui-package.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INPUTS = [
  "src", "shared", "public", "index.html", "package.json", "package-lock.json",
  "vite.config.js", "tsconfig.json", "tailwind.config.js", "postcss.config.js",
  "vitest.config.ts", "vitest.setup.ts",
];
const sha256 = (body) => createHash("sha256").update(body).digest("hex");

async function filesUnder(root, directory = root) {
  const info = await lstat(directory);
  if (info.isSymbolicLink()) throw new Error("UI build inputs must not contain symlinks");
  if (info.isFile()) return [path.relative(root, directory).split(path.sep).join("/")];
  if (!info.isDirectory()) throw new Error("Unsupported UI build input");
  const files = [];
  for (const name of (await readdir(directory)).sort()) files.push(...await filesUnder(root, path.join(directory, name)));
  return files;
}

async function sourceFingerprint(source) {
  const entries = [];
  for (const name of INPUTS) {
    for (const relative of await filesUnder(source, path.join(source, name))) {
      entries.push([relative, sha256(await readFile(path.join(source, relative)))]);
    }
  }
  return sha256(JSON.stringify(entries.sort(([left], [right]) => left.localeCompare(right))));
}

function command(args, cwd, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.platform === "win32" ? "npm.cmd" : "npm", args, {
      cwd, env, stdio: ["ignore", "inherit", "inherit"],
    });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`UI build command exited with ${code}`)));
  });
}

/** The build command and tests package only static browser assets, never the node backend or .env. */
export async function packageCloudCliUi(buildRoot, destination, { release, cloudCliVersion, sourceSha256 }) {
  validateUiRelease(release);
  const assetBase = `${UI_ASSET_PREFIX}${release}/`;
  let html = await readFile(path.join(buildRoot, "index.html"), "utf8");
  const runtimeTag = /<script\s+id=["']cloudcli-runtime["'][^>]*>[\s\S]*?<\/script>/g;
  if ([...html.matchAll(runtimeTag)].length !== 1 ||
      html.split(`href="${assetBase}manifest.json"`).length !== 2 ||
      !html.includes(`${assetBase}assets/`)) {
    throw new Error("UI build does not have the shared asset base and runtime bootstrap");
  }
  html = html.replace(runtimeTag, UI_RUNTIME_MARKER)
    .replace(`href="${assetBase}manifest.json"`, `href="${UI_MANIFEST_MARKER}"`);
  validateUiTemplate(html);
  await mkdir(path.dirname(destination), { recursive: true });
  // No overwrite: a release is immutable even when the caller reuses --release.
  await mkdir(destination);
  const files = {};
  for (const name of await filesUnder(buildRoot)) {
    if (!uiContentType(name)) continue;
    const body = name === "index.html" ? Buffer.from(html) : await readFile(path.join(buildRoot, name));
    files[name] = { bytes: body.length, sha256: sha256(body) };
    await mkdir(path.dirname(path.join(destination, name)), { recursive: true });
    await writeFile(path.join(destination, name), body, { flag: "wx" });
  }
  const manifest = validateUiManifest({
    schema: 1, kind: "codey-cloudcli-ui", release, assetBase, apiContract: 1,
    cloudCliVersion, sourceSha256, files,
  });
  for (const [, url] of html.matchAll(/(?:src|href)=["']([^"']+)["']/g)) {
    if (url.startsWith(assetBase) && !Object.hasOwn(files, url.slice(assetBase.length))) {
      throw new Error("UI entry references an unpackaged asset");
    }
  }
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  // The manifest is the commit marker and is always written last.
  await writeFile(path.join(destination, UI_PACKAGE_FILE), bytes, { flag: "wx" });
  return { directory: destination, release, manifestSha256: sha256(bytes), fileCount: Object.keys(files).length };
}

/** The publish command builds this single node-independent package from a frozen source snapshot. */
export async function buildCloudCliUi({
  source = path.join(projectRoot, "cloudcli"),
  output = path.join(projectRoot, "dist", "cloudcli-ui"),
  release = `ui-${new Date().toISOString().replace(/[-:.]/g, "").toLowerCase()}-${randomBytes(4).toString("hex")}`,
  test = false,
} = {}) {
  validateUiRelease(release);
  const fingerprint = await sourceFingerprint(source);
  const temporary = await mkdtemp(path.join(os.tmpdir(), "codey-shared-ui-"));
  try {
    const snapshot = path.join(temporary, "source");
    await mkdir(snapshot);
    for (const name of INPUTS) await cp(path.join(source, name), path.join(snapshot, name), { recursive: true });
    if (await sourceFingerprint(snapshot) !== fingerprint || await sourceFingerprint(source) !== fingerprint) {
      throw new Error("UI source changed during snapshot");
    }
    await symlink(path.join(source, "node_modules"), path.join(snapshot, "node_modules"), "junction");
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("VITE_")));
    if (test) await command(["run", "test:client"], snapshot, { ...env, NODE_ENV: "test" });
    const built = path.join(temporary, "built");
    await command(["run", "build:client", "--", "--outDir", built], snapshot, {
      ...env, NODE_ENV: "production", VITE_IS_PLATFORM: "false",
      VITE_CODEY_MANAGED: "true", VITE_CODEY_PORTAL_SSO: "true",
      VITE_BASE_PATH: `${UI_ASSET_PREFIX}${release}/`,
    });
    if (await sourceFingerprint(source) !== fingerprint) throw new Error("UI source changed during build");
    const version = JSON.parse(await readFile(path.join(snapshot, "package.json"), "utf8")).version;
    const result = await packageCloudCliUi(built, path.join(output, release), {
      release, cloudCliVersion: version, sourceSha256: fingerprint,
    });
    await writeFile(path.join(output, "latest-build.json"), `${JSON.stringify(result, null, 2)}\n`);
    return result;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function main() {
  const args = process.argv.slice(2);
  const options = {};
  let verify;
  for (let index = 0; index < args.length; index++) {
    const option = args[index];
    if (option === "--test") options.test = true;
    else if (["--source", "--output", "--release", "--verify"].includes(option) && args[index + 1]) {
      const value = args[++index];
      if (option === "--verify") verify = path.resolve(value);
      else options[option.slice(2)] = option === "--release" ? value : path.resolve(value);
    } else throw new Error("Usage: workspace:build [--test] [--release ID] [--source DIR] [--output DIR] | --verify PACKAGE_DIR");
  }
  if (verify) {
    const bundle = await readUiPackage(verify);
    for (const name of Object.keys(bundle.manifest.files)) await readUiPackageFile(bundle, name);
    validateUiTemplate((await readUiPackageFile(bundle, "index.html")).toString("utf8"));
    console.log(JSON.stringify({
      directory: verify, release: bundle.manifest.release,
      manifestSha256: bundle.sha256, fileCount: Object.keys(bundle.manifest.files).length, verified: true,
    }));
  } else console.log(JSON.stringify(await buildCloudCliUi(options)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
