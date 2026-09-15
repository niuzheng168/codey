export function mainSource({
  commit = "a".repeat(40), tree = "b".repeat(40), cloudcli = "c".repeat(40),
  copilotApi = "d".repeat(40), version = "0.1.0",
} = {}) {
  return {
    schema: 1, kind: "codey-main-source", ref: "refs/heads/main", commit, tree,
    submodules: { cloudcli, "copilot-api": copilotApi }, sourceDirty: false, codeyVersion: version,
  };
}
