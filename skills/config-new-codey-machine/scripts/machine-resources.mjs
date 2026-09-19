/** Resource ownership inventory, not an updater journal or permission to delete. */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { digest, exists, inside, requireValue } from "./machine-common.mjs";
import { unixProfiles } from "./platform-unix.mjs";

export async function writeResources(i, config) {
  const windows = i.target === "windows-x64";
  const cli = windows ? path.join(i.root, "bin/codey.ps1") : path.join(i.home, ".local/bin/codey");
  const file = await i.checked(path.join(i.configRoot, "resources.json"));
  const programs = [];
  if (await exists(file)) {
    const previous = await i.read(file);
    requireValue(previous.schema === 1 && previous.kind === "codey-install-resources" &&
      previous.nodeId === config.nodeId && previous.ownerHome === i.home && previous.platform === i.target,
    "Existing resource inventory belongs to another installation");
    for (const item of previous.programs) {
      requireValue(item.kind === "release" && inside(path.join(i.root, "releases"), item.path) ||
        item.kind === "npm-package" && inside(i.home, item.path) && path.basename(item.path) === "codey",
      "Invalid recorded program path");
      programs.push(item);
    }
  }
  // A global/user-shared npm prefix is not exclusively ours. Never inventory
  // an entire runtime root as disposable: it also holds credentials and data.
  if (inside(path.join(i.root, "releases"), config.releaseDirectory) &&
      !programs.some(item => item.path === config.releaseDirectory)) {
    programs.push({ path: config.releaseDirectory, kind: "release", codeyBuildSha256: config.codeyEntrySha256 });
  } else if (!inside(path.join(i.root, "releases"), config.releaseDirectory) && config.codeyDirectory &&
      !programs.some(item => item.path === config.codeyDirectory)) {
    programs.push({ path: config.codeyDirectory, kind: "npm-package", codeyBuildSha256: config.codeyEntrySha256 });
  }
  const commands = i.commandRegistered && await exists(cli) ? [{ path: cli, sha256: await digest(cli) }] : [];
  const services = config.helperPath ? i.adapter.resources(config).map(item => ({
    ...item, ownership: config.ready ? "verified" : "requires-verification",
  })) : [];
  const document = {
    schema: 1, kind: "codey-install-resources", platform: i.target, nodeId: config.nodeId,
    ownerHome: i.home, ...(i.ownerSid ? { ownerSid: i.ownerSid } : { ownerUid: process.getuid() }),
    releaseId: config.releaseId, state: config.state ?? (config.ready ? "ready" : "installing"),
    programs, services, commands, supportFiles: [],
    modified: windows
      ? [{ kind: "user-path-entry", value: path.join(i.root, "bin") }, { kind: "user-environment", name: "CODEY_MODEL_API_KEY" }]
      : unixProfiles(i.target).map(name => ({ path: path.join(i.home, name), kind: "shell-block", marker: "# >>> Codey PATH >>>" })),
    preserve: [...new Set([i.root, i.configRoot, i.state, config.codexHome,
      config.environment?.COPILOT_API_HOME, path.dirname(config.environment?.DATABASE_PATH ?? path.join(i.root, "data/auth.db")),
      path.join(i.root, "codex-bin"), path.join(i.root, "codex-install"),
      ...(i.target === "linux-x64" ? [path.join(i.home, ".local/share/codey-tools")] : [])].filter(Boolean))]
      .map(file => ({ path: file, reason: "data, credentials, configuration or shared/official tools; keep by default" })),
    configuration: ["config.toml", "models.json"].map(name => ({ path: path.join(config.codexHome, name), keep: true })),
    cloud: { tunnel: config.qualifiedTunnel, deleteTunnel: false, deletePortalRecord: false },
    uninstallImplemented: false, reverifyBeforeRemoval: true,
  };
  for (const candidate of [...new Set([config.helperPath, config.registrationHelper, config.commonPath,
    config.authHelperPath, config.tunnelAuthHelperPath, config.workerPath,
    config.runnerPath, config.taskHostExe,
    ...Object.keys(config.helperHashes ?? {}).map(name => path.join(i.root, "supervisor", name)),
    ...(i.target === "linux-x64" ? [path.join(i.root, "linux-devtunnel-health.mjs")] : [])].filter(Boolean))]) {
    if (inside(i.root, candidate) && await exists(candidate)) document.supportFiles.push({ path: candidate, sha256: await digest(candidate) });
  }
  if (i.target === "linux-x64") document.modified.push(...[".profile", ".bashrc"].map(name => ({
    path: path.join(i.home, name), kind: "shell-block", marker: "# >>> Codey model API >>>",
  })));
  if (!windows) {
    const actual = [];
    for (const item of document.modified) {
      if (await exists(item.path) && (await readFile(item.path, "utf8")).includes(item.marker)) actual.push(item);
    }
    document.modified = actual;
  }
  for (const item of [...programs, ...commands, ...document.preserve, ...services]) {
    requireValue(inside(i.home, item.path), "Resource inventory path escaped the owner's home");
  }
  const bytes = JSON.stringify(document, null, 2) + "\n";
  if (!await exists(file) || await readFile(file, "utf8") !== bytes) await i.write(file, Buffer.from(bytes));
  return document;
}
