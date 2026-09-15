import { isDeepStrictEqual } from "node:util";

const SHA = /^[a-f0-9]{40}$/;
const KEYS = ["codeyVersion", "commit", "kind", "ref", "schema", "sourceDirty", "submodules", "tree"];

/** Shared by producers and publication gates; old artifacts remain readable. */
export function validateReleaseSource(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(KEYS) ||
      value.schema !== 1 || value.kind !== "codey-main-source" || value.ref !== "refs/heads/main" ||
      value.sourceDirty !== false || ["commit", "tree"].some(key => typeof value[key] !== "string" || !SHA.test(value[key])) ||
      typeof value.codeyVersion !== "string" || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(value.codeyVersion) ||
      !value.submodules || Array.isArray(value.submodules) ||
      JSON.stringify(Object.keys(value.submodules).sort()) !== JSON.stringify(["cloudcli", "copilot-api"]) ||
      Object.values(value.submodules).some(commit => typeof commit !== "string" || !SHA.test(commit))) {
    throw new Error("Production publication requires verified, committed origin/main provenance");
  }
  return value;
}

export function verifyPackageSource(build, source) {
  validateReleaseSource(source);
  if (build.sourceDirty !== false || build.sourceCommit !== source.commit || build.version !== source.codeyVersion ||
      build.cloudcli?.commit !== source.submodules.cloudcli ||
      build.copilotApi?.commit !== source.submodules["copilot-api"] ||
      !isDeepStrictEqual(validateReleaseSource(build.releaseSource), source)) {
    throw new Error("Package source differs from its committed main provenance");
  }
  return source;
}
