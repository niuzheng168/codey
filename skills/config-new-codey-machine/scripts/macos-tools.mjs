import { constants } from "node:fs";
import { cp, lstat, readFile, readdir, readlink, realpath, symlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { checkedPath, digest, exists, inside, requireValue } from "./machine-common.mjs";

const signingRequirement = 'anchor apple generic and certificate leaf[subject.OU] = "2DC432GLL2"';
const receiptFile = i => path.join(i.configRoot, "codex-tool.json");

async function files(root, home) {
  await checkedPath(root, home);
  const result = {};
  async function visit(directory) {
    for (const name of (await readdir(directory)).sort()) {
      const file = path.join(directory, name), info = await lstat(file), relative = path.relative(root, file);
      requireValue(info.uid === process.getuid() && (info.isSymbolicLink() || !(info.mode & 0o022)),
        "Codex package contains unowned or writable files");
      if (info.isSymbolicLink()) {
        const link = await readlink(file);
        requireValue(!path.isAbsolute(link) && inside(root, await realpath(file)), "Codex package link escapes its directory");
        result[relative] = { link };
      } else if (info.isDirectory()) await visit(file);
      else {
        requireValue(info.isFile(), "Unexpected Codex package file");
        result[relative] = { sha256: await digest(file), mode: info.mode & 0o777 };
      }
    }
  }
  await visit(root);
  return result;
}

async function metadata(root, home) {
  await checkedPath(root, home);
  const metadata = path.join(root, "codex-package.json");
  await checkedPath(metadata, home);
  requireValue((await lstat(metadata)).size < 65536, "Invalid Codex package metadata");
  return JSON.parse(await readFile(metadata, "utf8"));
}
const codexTarget = i => `${i.target === "macos-arm64" ? "aarch64" : "x86_64"}-apple-darwin`;
function compatible(pkg, i) {
  const [major, minor] = String(pkg.version).split(".").map(Number);
  return pkg.layoutVersion === 1 && pkg.variant === "codex" && pkg.target === codexTarget(i) &&
    pkg.entrypoint === "bin/codex" && pkg.pathDir === "codex-path" && pkg.resourcesDir === "codex-resources" &&
    /^\d+\.\d+\.\d+$/.test(pkg.version) && (major > 0 || minor >= 152);
}
async function inspect(i, root) {
  const pkg = await metadata(root, i.home);
  const arch = i.target === "macos-arm64" ? "arm64" : "x86_64";
  requireValue(compatible(pkg, i), "Codex requires a compatible native standalone package (stable 0.152.0+)");
  for (const name of ["bin/codex", "bin/codex-code-mode-host", "codex-path/rg"]) {
    const file = path.join(root, name);
    await checkedPath(file, i.home);
    requireValue((await lstat(file)).isFile(), "Incomplete official Codex package");
    await i.run("/usr/bin/codesign", ["--verify", "--strict", "-R", "=" + signingRequirement, file]);
    requireValue((await i.run("/usr/bin/lipo", ["-archs", file])).stdout.trim().split(/\s+/).includes(arch),
      "Existing Codex requires a different native architecture");
  }
  requireValue((await i.run(path.join(root, pkg.entrypoint), ["--version"], { timeout: 10000 })).stdout.trim() ===
    `codex-cli ${pkg.version}`, "Codex package version mismatch");
  return pkg;
}

export async function recordMacCodex(i, config) {
  const executable = await realpath(config.codexExe), root = path.resolve(executable, "../..");
  requireValue(inside(path.join(i.root, "codex-install"), root), "Codex must use a private complete installation");
  const pkg = await inspect(i, root);
  await i.write(receiptFile(i), { schema: 1, root, executable, version: pkg.version, files: await files(root, i.home) });
}

export async function reuseMacCodex(i, config) {
  const receipt = receiptFile(i);
  if (await exists(receipt)) {
    await i.checked(receipt);
    const saved = await i.read(receipt);
    requireValue(saved.schema === 1 && inside(path.join(i.root, "codex-install"), saved.root) &&
      saved.executable === path.join(saved.root, "bin/codex") &&
      await realpath(config.codexExe) === saved.executable &&
      isDeepStrictEqual(await files(saved.root, i.home), saved.files), "Private Codex package fingerprint mismatch");
    console.log(`Reuse verified private Codex ${saved.version}; no download`);
    return true;
  }
  // Only the complete signed standalone distribution is reusable, never npm
  // shims, Desktop caches, or a lone binary missing its companions/resources.
  const candidates = [...new Set([
    config.codexExe,
    path.join(config.codexHome, "packages/standalone/current/bin/codex"),
    path.join(i.home, ".local/bin/codex"),
    ...(process.env.PATH ?? "").split(path.delimiter).filter(value => path.isAbsolute(value))
      .map(value => path.join(value, "codex")),
  ])];
  for (const candidate of candidates) {
    if (!await exists(candidate)) continue;
    const executable = await realpath(candidate), root = path.resolve(executable, "../..");
    if (!inside(i.home, root) || !await exists(path.join(root, "codex-package.json"))) {
      console.log("Existing Codex is not a complete owner-local standalone package; checking other candidates");
      continue;
    }
    const pkg = await metadata(root, i.home);
    if (!compatible(pkg, i)) {
      console.log("Existing Codex version, architecture or standalone layout is incompatible; checking other candidates");
      continue;
    }
    if (inside(path.join(i.root, "codex-install"), root) && candidate === config.codexExe) {
      await recordMacCodex(i, config);
      console.log(`Reuse complete private Codex ${pkg.version}; no download`);
      return true;
    }
    await inspect(i, root);
    const snapshot = await files(root, i.home);
    const destination = path.join(await i.directory(path.join(i.root, "codex-install")), "reused-" + randomBytes(12).toString("hex"));
    await cp(root, destination, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE, errorOnExist: true, force: false });
    requireValue(isDeepStrictEqual(await files(destination, i.home), snapshot), "Copied Codex package fingerprint mismatch");
    await inspect(i, destination);
    for (const name of ["codex", "codex-code-mode-host"]) {
      const link = path.join(path.dirname(config.codexExe), name);
      requireValue(!await exists(link), "Existing private Codex command requires review");
      await symlink(path.join(destination, "bin", name), link);
    }
    await i.write(receipt, { schema: 1, root: destination, executable: path.join(destination, "bin/codex"),
      version: pkg.version, files: snapshot });
    console.log(`Reuse official Codex ${pkg.version} (private copy); no download`);
    return true;
  }
  console.log("No reusable official Codex found; downloading a separate official installation");
  return false;
}
