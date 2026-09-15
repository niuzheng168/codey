import { readFile } from "node:fs/promises";
import { validateReleaseSource } from "./release-source.mjs";

export async function readBuildInfo(file = new URL("../codey-source.json", import.meta.url)) {
  let bytes;
  try { bytes = await readFile(file); }
  catch (error) {
    if (error.code === "ENOENT") return null; // Local development has no claimed production SHA.
    throw error;
  }
  if (bytes.length > 8192) throw new Error("Oversized Portal build provenance");
  return validateReleaseSource(JSON.parse(bytes.toString("utf8")));
}

export function publicBuildInfo(source) {
  if (!source) return { sourceCommit: null, provenance: "unavailable" };
  validateReleaseSource(source);
  return {
    sourceCommit: source.commit, sourceTree: source.tree, sourceRef: source.ref,
    componentCommits: { ...source.submodules }, codeyVersion: source.codeyVersion, sourceDirty: false,
  };
}
