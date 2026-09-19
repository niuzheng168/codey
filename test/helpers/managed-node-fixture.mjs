// Real private files/package/certificate, replace only native OS services and network.
import { chmod, cp, mkdir, readFile, readdir, realpath } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { Machine, machinePaths } from "../../packages/codey/lib/machine.mjs";
import { readPackageInfo } from "../../packages/codey/lib/package-info.mjs";
import { checkedPath, digest, directory, readPrivate, writePrivate } from "../../skills/config-new-codey-machine/scripts/machine-common.mjs";
import { packageFixture, fingerprint, packFixture } from "../codey-update-fixture.mjs";
import { registrationFixture } from "./registration-fixture.mjs";
import { Installer } from "../../skills/config-new-codey-machine/scripts/install-machine.mjs";

export async function addOnboarding(root) {
  await cp(new URL("../../skills/config-new-codey-machine/", import.meta.url), path.join(root, "onboarding"),
    { recursive: true, filter: source => !source.includes("__pycache__") && !source.includes("/assets") });
  const protect = async file => {
    await chmod(file, 0o700);
    for (const entry of await readdir(file, { withFileTypes: true })) {
      const next = path.join(file, entry.name);
      if (entry.isDirectory()) await protect(next);
      else await chmod(next, 0o600);
    }
  };
  await protect(path.join(root, "onboarding"));
  await fingerprint(root);
}

export async function managedFixture(t, target = "linux-x64") {
  const f = await registrationFixture(t, target);
  f.home = await realpath(f.home);
  const platform = target.startsWith("macos") ? "darwin" : target.startsWith("windows") ? "win32" : "linux";
  const locations = machinePaths(f.home, platform), state = path.join(locations.root, "state");
  const app = await packageFixture(path.join(locations.root, "releases/old/app"), "1.0.0");
  await addOnboarding(app);
  await mkdir(path.join(app, "node_modules"), { mode: 0o700 });
  const info = await readPackageInfo(app, { platform, arch: target.split("-")[1] });
  const gateway = path.join(locations.root, "gateway"), codexHome = path.join(f.home, ".codex");
  for (const folder of [locations.configRoot, state, gateway, codexHome, path.join(locations.root, "supervisor")]) await directory(folder, f.home);
  const identity = { ...f.identity, ownerHome: f.home, ownerUid: process.getuid(),
    ...(platform === "win32" ? { ownerSid: "S-1-5-21-fixture" } : {}) };
  delete identity.updaterCredential;
  const cert = path.join(locations.configRoot, "node-cert.pem"), key = path.join(locations.configRoot, "node-key.pem");
  const modelKey = randomBytes(32).toString("base64url");
  const config = {
    schema: 2, kind: `codey-${target.split("-")[0]}-oneclick`, platform: target, workerRuntime: "node",
    layout: "npm-codey-package", ownerHome: f.home, ownerUid: process.getuid(), computer: "fixture-node",
    ...(platform === "win32" ? { ownerSid: identity.ownerSid } : {}),
    runtimeRoot: locations.root, configRoot: locations.configRoot, stateRoot: state,
    nodeId: identity.nodeId, portalOrigin: f.setup.portalOrigin, ready: true, state: "ready",
    releaseId: `machine-${info.entrySha256.slice(0, 16)}`, releaseDirectory: path.join(locations.root, "releases/old"),
    codeyDirectory: app, codeyBin: path.join(app, "bin/codey.mjs"), codeyEntrySha256: info.entrySha256,
    nodeExe: process.execPath, codexExe: path.join(locations.root, "codex"), devtunnelExe: path.join(locations.root, "devtunnel"),
    helperPath: path.join(locations.root, "supervisor/windows-runtime.mjs"),
    registrationHelper: path.join(locations.root, "supervisor/registration.mjs"),
    identityFile: path.join(state, "identity.json"), certificate: cert, serverName: `${identity.nodeId}.nodes.codey.internal`,
    tunnelFile: path.join(locations.configRoot, "tunnel.json"), qualifiedTunnel: `codey-${identity.nodeId}.jpe1`,
    setupFile: path.join(locations.configRoot, "setup.json"), codexHome, modelKey,
    baseEnvironment: { HOME: f.home }, environment: {
      HOME: f.home, COPILOT_API_HOME: gateway, CODEX_HOME: codexHome, CODEY_MODEL_API_KEY: modelKey,
      CODEY_PORTAL_TLS_CERT: cert, CODEY_PORTAL_TLS_KEY: key,
      COPILOT_API_CODEY_SIGNING_KEY_FILE: path.join(locations.configRoot, "client-signing.key"),
      CODEY_PORTAL_SSO_KEY: identity.workspaceSsoKey, COPILOT_API_OAUTH_APP: "",
    }, fileHashes: {},
  };
  await writePrivate(config.identityFile, identity);
  await writePrivate(cert, Buffer.from(f.certificate));
  await writePrivate(key, await readFile(path.join(f.home, "key.pem")));
  await writePrivate(config.environment.COPILOT_API_CODEY_SIGNING_KEY_FILE, Buffer.from(identity.clientSigningKey + "\n"));
  await writePrivate(config.tunnelFile, { tunnelId: `codey-${identity.nodeId}`, clusterId: "jpe1", hostConnections: 1,
    ports: [3001, 8443].map(portNumber => ({ portNumber, protocol: "https" })) });
  await writePrivate(config.setupFile, { ...f.setup, schema: 1, releaseId: config.releaseId });
  await writePrivate(path.join(gateway, "config.json"), { auth: { apiKeys: [modelKey] }, setting: "original" });
  await writePrivate(path.join(gateway, "github_token"), Buffer.from("fixture-github-token"));
  await writePrivate(path.join(gateway, "codex_credentials.json"), { token: "fixture-codex-provider-token" });
  await writePrivate(path.join(codexHome, "config.toml"), Buffer.from(`model = "fixture"\nmodel_catalog_json = ${JSON.stringify(path.join(codexHome, "models.json"))}\n`));
  await writePrivate(path.join(codexHome, "models.json"), { models: [] });
  await writePrivate(path.join(codexHome, "auth.json"), { token: "fixture-codex-auth" });
  for (const name of ["codexExe", "devtunnelExe", "helperPath", "registrationHelper"]) {
    await writePrivate(config[name], Buffer.from("fixture-tool-not-executed"));
    config.fileHashes[name] = await digest(config[name]);
  }
  await writePrivate(locations.file, config);
  f.calls = []; f.states = ["apps", "host", "renew", "health"].map((name, index) => ({
    name, component: index === 0 ? "codey" : "tunnel", enabled: true, running: true, auxiliary: false, state: "running", pid: null,
  }));
  f.user = { status: "Logged in", provider: "github" };
  const i = {
    ...locations, home: f.home, target, state, computer: config.computer, skill: path.join(app, "onboarding"),
    auth: { github: async () => null },
    ownerSid: config.ownerSid, setup: await readPrivate(config.setupFile), commandRegistered: false,
    checked: file => checkedPath(file, f.home), directory: file => directory(file, f.home),
    read: readPrivate, write: writePrivate, pause: ms => new Promise(resolve => setTimeout(resolve, Math.min(ms, 2))),
    sameComputer: config => Installer.prototype.sameComputer.call(i, config),
    async run(file, args, options) {
      f.calls.push({ file, args, options });
      if (args[0] === "--version") return { code: 0, stdout: "fixture version", stderr: "" };
      if (args.join(" ") === "user login --github --use-device-code-auth") f.user = { status: "Logged in", provider: "github" };
      const response = args[0] === "user" ? f.user : await readPrivate(config.tunnelFile);
      return { code: 0, stdout: JSON.stringify(response), stderr: "" };
    },
    async checkPorts() { f.calls.push("ports"); if (f.foreignPort) throw new Error("foreign or unverified listener"); return []; },
    async probe() { f.calls.push("probe"); if (f.probeError) throw new Error("fixture secret must not print"); },
    async certificate() { f.calls.push("certificate"); },
    async verifyModels() { f.calls.push("model"); },
  };
  i.adapter = {
    async status() { if (f.foreignService) throw new Error("foreign service"); return structuredClone(f.states); },
    async setStates(c, values) {
      f.calls.push({ operation: "setStates", values: structuredClone(values) });
      for (const value of values) Object.assign(f.states.find(item => item.name === value.name), value,
        { state: value.running ? "running" : "stopped" });
    },
    async configure(c) { await writePrivate(path.join(i.configRoot, "provider.env"), Buffer.from("CODEY_MODEL_API_KEY=" + c.modelKey + "\n")); },
    async switchPackage() { f.calls.push("switch"); if (f.failSwitch) { f.failSwitch = false; throw new Error("fixture switch failure"); } },
    async ready() {}, async inspect() {}, async machineIdentity() {}, async external() { f.calls.push("external"); },
    resources: c => f.states.map(item => ({ kind: "fixture-service", name: item.name, path: path.join(i.root, item.name) })),
  };
  Object.assign(f, { app, config, i, identity, modelKey, platform, m: new Machine(i, config, info) });
  f.nextPackage = async () => {
    const next = await packageFixture(path.join(f.home, "next-package"), "2.0.0");
    await addOnboarding(next);
    const file = await packFixture(next, path.join(f.home, "codey-2.0.0.tgz"));
    return { next, file };
  };
  return f;
}
