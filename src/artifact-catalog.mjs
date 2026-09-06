import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";

const ARTIFACT_NAME_PATTERN =
  /^copilot-api-(.+)-(\d{4}-\d{2}-\d{2})-([a-z0-9][a-z0-9._-]{0,31})\.(tgz|tgzz)$/i;
const ARTIFACT_ID_PATTERN =
  /^copilot-api-[0-9A-Za-z.+-]{1,64}-\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9._-]{0,31}$/i;
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;
const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 128 * 1024 * 1024;
const MAX_CHANGELOG_BYTES = 256 * 1024;
const REQUIRED_PACKAGE_NAME = "@jeffreycao/copilot-api";
const REQUIRED_BUNDLE_MARKERS = [
  "invalid-encrypted-content",
  "reasoning_effort TEXT",
];

function requestError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  error.expose = true;
  return error;
}

function readTarString(buffer, start, length) {
  const slice = buffer.subarray(start, start + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end < 0 ? slice.length : end).toString("utf8").trim();
}

function readTarSize(header) {
  const raw = readTarString(header, 124, 12).replace(/\s/g, "");
  if (!/^[0-7]+$/.test(raw)) throw new Error("tar entry has an invalid size");
  return Number.parseInt(raw, 8);
}

function safeArchivePath(value) {
  const normalized = value.replaceAll("\\", "/");
  return (
    normalized.length > 0 &&
    !normalized.startsWith("/") &&
    !normalized.includes("\0") &&
    !normalized.split("/").includes("..")
  );
}

function readTarEntries(archive) {
  const entries = new Map();
  let offset = 0;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;

    const name = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const entryPath = prefix ? `${prefix}/${name}` : name;
    if (!safeArchivePath(entryPath)) throw new Error("tar archive contains an unsafe path");

    const size = readTarSize(header);
    const contentStart = offset + 512;
    const contentEnd = contentStart + size;
    if (!Number.isSafeInteger(size) || size < 0 || contentEnd > archive.length) {
      throw new Error("tar archive is truncated");
    }

    const type = String.fromCharCode(header[156] || 48);
    if (type === "0" || type === "\0") {
      entries.set(entryPath, archive.subarray(contentStart, contentEnd));
    }
    offset = contentStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function inspectArchive(contents) {
  if (contents[0] !== 0x1f || contents[1] !== 0x8b) {
    throw new Error("package is not a gzip archive");
  }
  const uncompressed = gunzipSync(contents, {
    maxOutputLength: MAX_UNCOMPRESSED_BYTES,
  });
  const entries = readTarEntries(uncompressed);
  const packageJsonEntry = entries.get("package/package.json");
  if (!packageJsonEntry) throw new Error("package/package.json is missing");

  let packageJson;
  try {
    packageJson = JSON.parse(packageJsonEntry.toString("utf8"));
  } catch {
    throw new Error("package/package.json is invalid");
  }

  const serverBundles = [...entries.entries()]
    .filter(([entryPath]) => /^package\/dist\/server-.*\.js$/.test(entryPath))
    .map(([, entry]) => entry.toString("utf8"));
  if (serverBundles.length === 0) throw new Error("server bundle is missing");
  const serverSource = serverBundles.join("\n");
  const missingCapabilities = REQUIRED_BUNDLE_MARKERS.filter(
    (marker) => !serverSource.includes(marker),
  );
  if (missingCapabilities.length > 0) {
    throw new Error(
      `package lacks required source capability: ${missingCapabilities.join(", ")}`,
    );
  }
  return packageJson;
}

function parseArtifactName(fileName) {
  const match = ARTIFACT_NAME_PATTERN.exec(fileName);
  if (!match) return null;
  const [, version, buildDate, label] = match;
  if (!VERSION_PATTERN.test(version)) return null;
  const date = new Date(`${buildDate}T00:00:00Z`);
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== buildDate) {
    return null;
  }
  return {
    id: fileName.replace(/\.(?:tgz|tgzz)$/i, ""),
    version,
    buildDate,
    label: label.toLowerCase(),
  };
}

function publicArtifact(artifact) {
  return {
    id: artifact.id,
    version: artifact.version,
    buildDate: artifact.buildDate,
    label: artifact.label,
    fileName: artifact.fileName,
    sizeBytes: artifact.sizeBytes,
    sha256: artifact.sha256,
    changelog: artifact.changelog,
  };
}

function insideRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export class ArtifactCatalog {
  constructor(root, options = {}) {
    this.root = path.resolve(root);
    this.readFile = options.readFile ?? readFile;
  }

  async scan() {
    let entries;
    try {
      entries = await readdir(this.root, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return { artifacts: [], errors: [] };
      throw error;
    }

    const inspectedArtifacts = [];
    const errors = [];
    for (const entry of entries) {
      const parsed = entry.isFile() ? parseArtifactName(entry.name) : null;
      if (!parsed) continue;
      try {
        inspectedArtifacts.push(await this.#inspect(entry.name, parsed));
      } catch (error) {
        errors.push({
          fileName: entry.name,
          message: String(error?.message || "invalid artifact").slice(0, 300),
        });
      }
    }

    const uniqueArtifacts = new Map();
    const duplicateIds = new Set();
    for (const artifact of inspectedArtifacts) {
      if (duplicateIds.has(artifact.id)) {
        errors.push({
          fileName: artifact.fileName,
          message: `duplicate artifact id ${artifact.id}`,
        });
        continue;
      }
      const existing = uniqueArtifacts.get(artifact.id);
      if (existing) {
        uniqueArtifacts.delete(artifact.id);
        duplicateIds.add(artifact.id);
        errors.push(
          {
            fileName: existing.fileName,
            message: `duplicate artifact id ${artifact.id}`,
          },
          {
            fileName: artifact.fileName,
            message: `duplicate artifact id ${artifact.id}`,
          },
        );
        continue;
      }
      uniqueArtifacts.set(artifact.id, artifact);
    }
    const artifacts = [...uniqueArtifacts.values()];
    artifacts.sort(
      (left, right) =>
        right.buildDate.localeCompare(left.buildDate) ||
        right.version.localeCompare(left.version, undefined, {
          numeric: true,
          sensitivity: "base",
        }) ||
        right.label.localeCompare(left.label),
    );
    return {
      artifacts: artifacts.map(publicArtifact),
      errors,
    };
  }

  async resolve(artifactId) {
    const id = String(artifactId ?? "").trim();
    if (!ARTIFACT_ID_PATTERN.test(id)) {
      throw requestError("artifactId 格式无效");
    }
    const scan = await this.scan();
    const artifact = scan.artifacts.find((item) => item.id === id);
    if (!artifact) throw requestError("所选 copilot-api 构建不存在", 404);
    return {
      ...artifact,
      path: path.join(this.root, artifact.fileName),
    };
  }

  async #inspect(fileName, parsed) {
    const filePath = path.join(this.root, fileName);
    const [rootPath, resolvedPath, metadata] = await Promise.all([
      realpath(this.root),
      realpath(filePath),
      lstat(filePath),
    ]);
    if (!metadata.isFile() || metadata.isSymbolicLink() || !insideRoot(rootPath, resolvedPath)) {
      throw new Error("artifact must be a regular file inside the artifact directory");
    }
    if (metadata.size < 1 || metadata.size > MAX_ARCHIVE_BYTES) {
      throw new Error("artifact size is outside the allowed range");
    }

    const changelogName = `${parsed.id}-CHANGELOG.md`;
    const changelogPath = path.join(this.root, changelogName);
    const changelogMetadata = await lstat(changelogPath);
    if (
      !changelogMetadata.isFile() ||
      changelogMetadata.isSymbolicLink() ||
      changelogMetadata.size < 1 ||
      changelogMetadata.size > MAX_CHANGELOG_BYTES
    ) {
      throw new Error("paired changelog is invalid or too large");
    }
    const [contents, changelog] = await Promise.all([
      this.readFile(resolvedPath),
      this.readFile(changelogPath, "utf8"),
    ]);

    const packageJson = inspectArchive(contents);
    if (packageJson?.name !== REQUIRED_PACKAGE_NAME) {
      throw new Error(`expected package ${REQUIRED_PACKAGE_NAME}`);
    }
    if (packageJson?.version !== parsed.version) {
      throw new Error(
        `filename version ${parsed.version} does not match package version ${packageJson?.version ?? "unknown"}`,
      );
    }

    return {
      ...parsed,
      fileName,
      sizeBytes: metadata.size,
      sha256: createHash("sha256").update(contents).digest("hex"),
      changelog: String(changelog).trim().slice(0, MAX_CHANGELOG_BYTES),
    };
  }
}

export const artifactCatalogInternals = Object.freeze({
  ARTIFACT_ID_PATTERN,
  inspectArchive,
  parseArtifactName,
  publicArtifact,
});
