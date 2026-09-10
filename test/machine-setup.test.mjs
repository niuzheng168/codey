import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile, mkdir, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { AccountStore } from "../src/account-store.mjs";
import { validateConfig } from "../src/config.mjs";
import { NodePolicy } from "../src/node-policy.mjs";
import { PasswordAuthenticator, hashPassword } from "../src/password-auth.mjs";
import { SettingsApi } from "../src/settings-api.mjs";
import { createMultiUserPortalServer } from "../src/server.mjs";
import { MachineSetup, loadMachineBundle, machineNetworkConfig, machineReleaseId, MACHINE_SKILL_FILES, machineArtifacts } from "../src/machine-setup.mjs";
import { machineIdentity, machineServerName, privateMachineIp } from "../src/machine-identity.mjs";
import { NodeDataGateway } from "../src/node-data-gateway.mjs";
import { CloudCliGateway } from "../src/cloudcli-gateway.mjs";
import { crc32, zipStream } from "../src/zip-stream.mjs";
import { fetchNodeJson } from "../public/node-transport.js";
import { MachineUpdates } from "../src/machine-updates.mjs";
import { MACHINE_PLATFORMS } from "../src/machine-platforms.mjs";

const run = promisify(execFile);
const origin = "https://codey.example.test";
const subscription = "00000000-0000-0000-0000-000000000000";
const resourceRoot = `/subscriptions/${subscription}/resourceGroups/test/providers/Microsoft.Network/virtualNetworks/portal`;
const network = {
  portalSubnetId: `${resourceRoot}/subnets/infrastructure`,
  privateEndpointSubnetId: `${resourceRoot}/subnets/endpoints`,
};

test("the Portal image includes every platform helper that its download catalog promises", async () => {
  const dockerfile = await readFile(new URL("../Dockerfile", import.meta.url), "utf8");
  const copied = new Set(dockerfile.split(/\r?\n/).filter((line) => /^COPY /.test(line))
    .flatMap((line) => line.trim().split(/\s+/).slice(1, -1)));
  for (const file of [...MACHINE_SKILL_FILES, ...MACHINE_PLATFORMS.flatMap((platform) => platform.files)]) {
    assert.ok(copied.has(`skills/config-new-codey-machine/${file}`), `Missing image input: ${file}`);
  }
});

async function temporary(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "codey-machine-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function bundle(root, platform = "linux-x64") {
  await mkdir(root, { recursive: true });
  const artifacts = [];
  for (const file of machineArtifacts(platform)) {
    const bytes = Buffer.from(`test fixture ${file}\n`);
    await writeFile(path.join(root, file), bytes);
    artifacts.push({ file, size: bytes.length, crc32: crc32(bytes), sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  const manifest = {
    schema: 1, platform,
    node: "24.20.0", cloudcli: { version: "test-cloudcli" }, copilotApi: { version: "test-copilot" }, artifacts,
    bunBuildTool: "1.4.2", dependencyMode: "install-on-target",
    nodeDistribution: {
      file: `node-v24.20.0-${MACHINE_PLATFORMS.find(item => item.id === platform).nodeSuffix}`,
      url: `https://nodejs.org/dist/v24.20.0/node-v24.20.0-${MACHINE_PLATFORMS.find(item => item.id === platform).nodeSuffix}`,
      sha256: (platform === "windows-x64" ? "b" : "a").repeat(64),
    },
  };
  manifest.releaseId = machineReleaseId(manifest);
  await writeFile(path.join(root, "manifest.json"), JSON.stringify(manifest));
  return manifest;
}

function unzip(archive) {
  const entries = new Map();
  let offset = 0;
  while (archive.readUInt32LE(offset) === 0x04034b50) {
    assert.equal(archive.readUInt16LE(offset + 8), 0);
    const size = archive.readUInt32LE(offset + 18);
    const nameSize = archive.readUInt16LE(offset + 26);
    const name = archive.subarray(offset + 30, offset + 30 + nameSize).toString();
    const begin = offset + 30 + nameSize;
    const data = archive.subarray(begin, begin + size);
    assert.equal(crc32(data), archive.readUInt32LE(offset + 14));
    assert.ok(!entries.has(name));
    entries.set(name, data);
    offset = begin + size;
  }
  assert.equal(archive.readUInt32LE(offset), 0x02014b50);
  assert.equal(archive.readUInt32LE(archive.length - 22), 0x06054b50);
  assert.equal(archive.readUInt16LE(archive.length - 12), entries.size);
  return entries;
}

function clientCredentials() {
  return {
    clientSigningKey: randomBytes(32).toString("base64url"),
    workspaceSsoKey: randomBytes(32).toString("base64url"),
    tunnelUpdateKey: randomBytes(32).toString("base64url"),
    updaterCredential: randomBytes(32).toString("base64url"),
    workspaceSubject: `m-${randomBytes(12).toString("hex")}`,
    workspaceUsername: "member",
  };
}

function connectToken(coordinates, now = Date.now()) {
  return ["e30", Buffer.from(JSON.stringify({
    ...coordinates, scp: "connect", exp: Math.floor(now / 1000) + 72000,
  })).toString("base64url"), "c2ln"].join(".");
}

function registration(manifest, machine, credentials = clientCredentials(), token = connectToken(machine.devTunnel)) {
  return {
    schema: 2,
    package: { portalOrigin: origin, releaseId: manifest.releaseId, platform: manifest.platform },
    machine,
    credentials,
    devTunnelConnectToken: token,
  };
}

async function machineFile(root, nodeId, options = {}) {
  const cert = path.join(root, `${nodeId}.pem`);
  const key = path.join(root, `${nodeId}.key`);
  const dns = options.dns ?? machineServerName(nodeId);
  await run("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-noenc", "-days", "365",
    "-keyout", key, "-out", cert, "-subj", `/CN=${dns}`,
    "-addext", `subjectAltName=DNS:${dns}`, "-addext", `basicConstraints=critical,CA:${options.ca ? "TRUE" : "FALSE"}`,
    "-addext", `keyUsage=critical,${options.ca ? "keyCertSign,cRLSign" : "digitalSignature,keyEncipherment"}`,
    "-addext", "extendedKeyUsage=serverAuth",
  ]);
  return {
    schema: 1, nodeId, name: "My prepared VM", region: "Japan East", privateIp: "10.42.0.4",
    tlsCertificate: await readFile(cert, "utf8"), networkMode: "private-link",
    vmResourceId: `/subscriptions/${subscription}/resourceGroups/test/providers/Microsoft.Compute/virtualMachines/my-vm`,
  };
}

async function fixture(t) {
  const root = await temporary(t);
  const master = randomBytes(32).toString("base64url");
  const ticketMaster = randomBytes(32).toString("base64url");
  const password = "Private-Machine-Fixture-42!";
  const credential = { username: "admin", principalId: "machine-test-admin", passwordHash: await hashPassword(password) };
  const accounts = new AccountStore({ root, master, credential });
  await accounts.initialize();
  const member = await accounts.create({ username: "member", password });
  const config = validateConfig({ nodes: [], clientNodes: [] });
  const policy = new NodePolicy({
    root, master, ticketMaster, defaults: config, seedPrincipalId: credential.principalId,
    legacyConfigStore: { load: async () => ({ config }) },
  });
  await policy.initialize();
  const auth = new PasswordAuthenticator({ credential, accountStore: accounts, root, publicBaseUrl: origin, staticRoot: path.resolve("public") });
  const admin = (await auth.login("admin", password)).cookie.split(";")[0];
  const cookie = (await auth.login("member", password)).cookie.split(";")[0];
  const bundleRoot = path.join(root, "bundle");
  const manifest = await bundle(bundleRoot);
  const data = new NodeDataGateway({ nodes: [], signingKey: ticketMaster, ca: "legacy-test-ca" }, { nodePolicy: policy });
  const workspace = new CloudCliGateway({ nodes: [], ssoMaster: master, ca: "legacy-test-ca" }, { sessionAuthenticator: auth, nodePolicy: policy });
  const probes = [];
  const tunnelProbes = [];
  const updates = new MachineUpdates({ root, master, nodePolicy: policy, accounts, authenticator: auth,
    sourceRoot: path.resolve("node-updater"), catalogRoot: path.join(root, "node-updates"),
    publicKey: generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }) });
  await updates.initialize();
  const machineSetup = new MachineSetup({
    nodePolicy: policy, accounts, authenticator: auth, origin, bundleRoot, network, cloudCliGateway: workspace,
    nodeDataGateway: data, cloudCliUi: {}, machineUpdates: updates, verify: async (machine, options) => {
      probes.push({ machine, options });
      return { https: true, usage: true, history: true, workspaceSso: true, websocket: true, anonymousDenied: true };
    },
    verifyTunnel: async (coordinates, token) => { tunnelProbes.push({ coordinates, token }); },
  });
  const settings = new SettingsApi({ accounts, nodePolicy: policy, authenticator: auth, cloudCliGateway: workspace, nodeDataGateway: data, machineSetup });
  const server = createMultiUserPortalServer({
    config, nodePolicy: policy, passwordAuthenticator: auth, settingsApi: settings,
    machineSetup, nodeDataGateway: data, cloudCliGateway: workspace, staticRoot: path.resolve("public"),
    readOnly: true, clientOnly: true, clientRelaySigningKey: ticketMaster,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (pathname, { method = "GET", value, user = cookie, headers = {} } = {}) => fetch(base + pathname, {
    method, redirect: "manual", headers: {
      cookie: user, origin, ...(value !== undefined ? { "content-type": "application/json" } : {}), ...headers,
    }, ...(value !== undefined ? { body: JSON.stringify(value) } : {}),
  });
  return {
    root, base, accounts, policy, auth, credential, member, cookie, admin, manifest, bundleRoot,
    machineSetup, data, workspace, probes, tunnelProbes, request, master, ticketMaster,
  };
}

test("all native packages are reusable and activate client-generated identities only after scoped tunnel proof", async t => {
  const f = await fixture(t);
  f.machineSetup.network = null;
  for (const [index, platform] of ["macos-arm64", "macos-x64", "windows-x64", "linux-x64"].entries()) {
    const manifest = platform === "linux-x64" ? f.manifest
      : await bundle(path.join(f.bundleRoot, "platforms", platform), platform);
    const response = await f.request(`/api/settings/machines/skill?platform=${platform}`, { method: "POST" });
    assert.equal(response.status, 200);
    const expectedName = platform === "linux-x64" ? "config-new-codey-machine.zip"
      : platform === "windows-x64" ? "config-new-codey-machine-windows.zip"
        : `config-new-codey-machine-${platform}.zip`;
    assert.equal(response.headers.get("content-disposition"), `attachment; filename="${expectedName}"`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const files = unzip(bytes);
    for (const file of [...MACHINE_SKILL_FILES, ...MACHINE_PLATFORMS.find(item => item.id === platform).files]) {
      assert.ok(files.has(`config-new-codey-machine/${file}`), file);
    }
    assert.equal(files.has("config-new-codey-machine/assets/portal-node-source.tar.gz"), platform !== "linux-x64");
    assert.ok(![...files.keys()].some(name => name.includes("archive/") || name.includes("azure-vnet.py") ||
      name.includes("configure-machine.py") || name.endsWith("/configure-windows.py") ||
      name.includes("repair-windows") || name.endsWith("/resume.py") || name.includes("windows-recovery")));
    if (platform === "windows-x64") {
      assert.match(files.get("config-new-codey-machine/SKILL.md").toString(), /Copilot 配额不是聊天健康检查/);
      assert.match(files.get("config-new-codey-machine/scripts/codey_node/platforms/windows/preflight.py").toString(), /probe\("\/token-usage"\)/);
      assert.match(files.get("config-new-codey-machine/scripts/codey_node/common/verification.py").toString(), /copilot_quota_unavailable_model_inference_not_tested/);
      assert.match(files.get("config-new-codey-machine/scripts/codey_node/platforms/windows/install.py").toString(), /native\.pin\(codex, root, node_id/);
    }
    assert.equal(
      files.has("config-new-codey-machine/scripts/codey_node/common/codex_cli.py"),
      platform !== "linux-x64",
    );
    const dependencies = JSON.parse(files.get("config-new-codey-machine/dependencies.json"));
    assert.equal(dependencies.codexCli.version, "0.146.0");
    assert.deepEqual(dependencies.linuxCodexInstaller, {
      url: "https://chatgpt.com/codex/install.sh", release: "latest",
    });
    for (const other of ["linux", "macos", "windows"].filter(other => !platform.startsWith(other))) {
      assert.ok(![...files.keys()].some(name => name.includes(`/platforms/${other}/`)));
    }
    assert.ok(!files.has(`config-new-codey-machine/scripts/${platform === "windows-x64" ? "setup-macos.sh" : "setup-windows.ps1"}`));
    assert.equal(files.has("config-new-codey-machine/scripts/setup-linux.sh"), platform === "linux-x64");
    assert.equal([...files.keys()].some(name => name.includes("assets/codey-updater/")), platform === "linux-x64");
    assert.equal(files.has("config-new-codey-machine/assets/enrollment.json"), false);
    assert.equal(files.has("config-new-codey-machine/assets/codey-updater/config.json"), false);
    const setup = JSON.parse(files.get("config-new-codey-machine/assets/setup.json"));
    assert.deepEqual(setup.network, { mode: "devtunnel" });
    assert.equal(setup.tunnelAuthProvider, "github");
    assert.equal(setup.platform, platform);
    assert.equal(setup.releaseId, manifest.releaseId);
    if (platform === "linux-x64") {
      assert.equal(setup.updater.protocol, 1);
      assert.match(setup.updater.releasePublicKey, /BEGIN PUBLIC KEY/);
    } else {
      assert.equal(setup.updater, undefined);
    }
    const repeated = await f.request(`/api/settings/machines/skill?platform=${platform}`, { method: "POST" });
    assert.deepEqual(Buffer.from(await repeated.arrayBuffer()), bytes, "The same release must produce the same reusable package");

    const nodeId = `n-${randomBytes(12).toString("hex")}`;
    const vm = await machineFile(f.root, nodeId);
    const { privateIp, vmResourceId, ...fields } = vm;
    const coordinates = { tunnelId: `codey-fixture-${index}`, clusterId: "jpe1" };
    const machine = { ...fields, platform, networkMode: "devtunnel", devTunnel: coordinates };
    const credentials = clientCredentials();
    const token = connectToken(coordinates);
    const payload = registration(manifest, machine, credentials, token);
    const activation = await f.request("/api/settings/machines/activate", { method: "POST", value: payload });
    assert.equal(activation.status, 201);
    const node = (await activation.json()).node;
    assert.equal(node.platform, platform);
    assert.equal(node.networkMode, "devtunnel");
    assert.equal(node.vnetOnly, true, "Never try browser loopback for a remotely consumed Mac node");
    assert.equal(f.workspace.match(`/cloudcli/${node.id}/`).devTunnel.port, 3001);
    assert.equal(f.data.nodes.get(node.id).devTunnel.port, 8443);
    assert.equal(await f.policy.keyFor(f.member.id, node.id), credentials.clientSigningKey);
    assert.deepEqual(await f.policy.workspaceBindingFor(f.member.id, node.id), {
      key: credentials.workspaceSsoKey,
      subject: credentials.workspaceSubject,
      username: credentials.workspaceUsername,
    });
    assert.equal(await f.policy.tunnelKeyFor(node.id), credentials.tunnelUpdateKey);
    assert.ok(!JSON.stringify(node).includes(token));
    const stored = JSON.stringify(await f.policy.records());
    for (const secret of [...Object.values(credentials).filter(value => value.length === 43), token]) {
      assert.ok(!stored.includes(secret));
    }
    const device = (await f.machineSetup.machineUpdates.store.read()).data.devices[node.id];
    assert.equal(Boolean(device), platform === "linux-x64");
    if (device) {
      assert.ok(!JSON.stringify(device).includes(credentials.updaterCredential));
      assert.equal((await f.machineSetup.machineUpdates.authenticateAgent({ headers: {
        "x-codey-node-id": node.id,
        authorization: `Bearer ${credentials.updaterCredential}`,
      } })).ownerId, f.member.id);
      await assert.rejects(f.machineSetup.machineUpdates.authenticateAgent({ headers: {
        "x-codey-node-id": node.id,
        authorization: `Bearer ${randomBytes(32).toString("base64url")}`,
      } }), { status: 401 });
    }
  }
  assert.equal(f.probes.length, 4);
  assert.equal(f.tunnelProbes.length, 4);
});

test("complete Skill download is deterministic, owner-independent and contains no private credentials", async (t) => {
  const f = await fixture(t);
  const response = await f.request("/api/settings/machines/skill", { method: "POST" });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("vary"), "Cookie");
  assert.equal(response.headers.get("content-type"), "application/zip");
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(Number(response.headers.get("content-length")), bytes.length);
  const entries = unzip(bytes);
  for (const name of MACHINE_SKILL_FILES) assert.ok(entries.has(`config-new-codey-machine/${name}`), name);
  for (const item of f.manifest.artifacts) {
    const artifact = entries.get(`config-new-codey-machine/assets/${item.file}`);
    assert.equal(createHash("sha256").update(artifact).digest("hex"), item.sha256);
  }
  const setup = JSON.parse(entries.get("config-new-codey-machine/assets/setup.json"));
  assert.deepEqual(setup, {
    schema: 1,
    portalOrigin: origin,
    releaseId: f.manifest.releaseId,
    platform: "linux-x64",
    network: { mode: "devtunnel" },
    tunnelAuthProvider: "github",
    updater: { protocol: 1, releasePublicKey: f.machineSetup.machineUpdates.publicKey },
  });
  assert.equal(entries.has("config-new-codey-machine/assets/enrollment.json"), false);
  assert.equal(entries.has("config-new-codey-machine/assets/codey-updater/config.json"), false);
  for (const name of ["install.py", "updater.py", "engine.py", "probe.mjs", "UPGRADE.md"]) {
    assert.ok(entries.has("config-new-codey-machine/assets/codey-updater/" + name));
  }
  for (const data of entries.values()) {
    assert.ok(!data.includes(f.master));
    assert.ok(!data.includes(f.ticketMaster));
    assert.ok(!data.includes("BEGIN PRIVATE KEY"));
  }
  assert.deepEqual(await f.policy.list(f.member.id), [], "Downloading must NOT add an unconfigured node");
  assert.equal((await f.policy.pendingMachines(f.member.id)).length, 0);
  assert.deepEqual(await f.policy.pendingMachines(f.credential.principalId), []);
  const status = await (await f.request("/api/settings")).json();
  assert.equal(status.machineSetup.enabled, true);
  assert.equal(status.pendingMachines.length, 0);
  const repeat = await f.request("/api/settings/machines/skill", { method: "POST", user: f.admin });
  assert.equal(repeat.status, 200);
  assert.deepEqual(Buffer.from(await repeat.arrayBuffer()), bytes,
    "The package must be identical for another authenticated owner");
});

test("a previously distributed static release remains importable after the active bundle changes", async (t) => {
  const f = await fixture(t);
  const id = `n-${randomBytes(12).toString("hex")}`;
  const vm = await machineFile(f.root, id);
  const { privateIp, vmResourceId, ...publicFields } = vm;
  const coordinates = { tunnelId: "codey-previous-release", clusterId: "jpe1" };
  const machine = {
    ...publicFields, platform: "linux-x64", networkMode: "devtunnel", devTunnel: coordinates,
  };
  const older = {
    ...f.manifest,
    releaseId: "machine-" + "0".repeat(16),
  };
  const response = await f.request("/api/settings/machines/activate", {
    method: "POST",
    value: registration(older, machine),
  });
  assert.equal(response.status, 201);
  assert.equal((await response.json()).node.id, id);
});

test("platform downloads are distinct and missing Mac/Windows releases never fall back to Linux", async (t) => {
  const f = await fixture(t);
  const initial = (await (await f.request("/api/settings")).json()).machineSetup;
  assert.equal(initial.platforms.find((item) => item.platform === "linux-x64").enabled, true);
  assert.equal(initial.platforms.find((item) => item.platform === "windows-x64").enabled, false);
  assert.equal(initial.platforms.find((item) => item.platform === "macos-arm64").enabled, false);
  assert.equal(initial.platforms.find((item) => item.platform === "macos-x64").enabled, false);
  for (const value of ["macos", "darwin", "../linux-x64", ""]) {
    assert.equal((await f.request("/api/settings/machines/skill?platform=" + encodeURIComponent(value),
      { method: "POST" })).status, 400);
  }
  assert.equal((await f.request("/api/settings/machines/skill?platform=windows-x64", { method: "POST" })).status, 503);
  assert.equal((await f.policy.pendingMachines(f.member.id)).length, 0, "Unavailable/wrong platforms do not reserve IDs");
  await bundle(path.join(f.bundleRoot, "platforms/windows-x64"), "windows-x64");
  const response = await f.request("/api/settings/machines/skill?platform=windows-x64", { method: "POST" });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-disposition"), 'attachment; filename="config-new-codey-machine-windows.zip"');
  const files = unzip(Buffer.from(await response.arrayBuffer()));
  for (const file of MACHINE_PLATFORMS.find(item => item.id === "windows-x64").files) {
    assert.ok(files.has("config-new-codey-machine/" + file));
  }
  assert.ok(!files.has("config-new-codey-machine/scripts/setup-linux.sh"));
  assert.ok(![...files.keys()].some((name) => name.includes("assets/codey-updater/")));
  const setup = JSON.parse(files.get("config-new-codey-machine/assets/setup.json"));
  assert.equal(setup.platform, "windows-x64");
  assert.equal((await f.policy.pendingMachines(f.member.id)).length, 0);
  const vm = await machineFile(f.root, `n-${randomBytes(12).toString("hex")}`);
  const { privateIp, vmResourceId, ...publicFields } = vm;
  const coordinates = { tunnelId: "codey-windows-fixture", clusterId: "jpe1" };
  const machine = { ...publicFields, platform: "windows-x64", networkMode: "devtunnel", devTunnel: coordinates };
  const windowsManifest = JSON.parse(files.get("config-new-codey-machine/assets/manifest.json"));
  const activation = await f.request("/api/settings/machines/activate", {
    method: "POST", value: registration(windowsManifest, machine),
  });
  assert.equal(activation.status, 201);
  const node = (await activation.json()).node;
  assert.equal(node.platform, "windows-x64");
  assert.equal(f.workspace.match(`/cloudcli/${node.id}/`).healthMonitoring, true);
  await assert.rejects(f.machineSetup.machineUpdates.bootstrap(f.member.id, node.id), { status: 409 });
  assert.equal((await f.machineSetup.machineUpdates.store.read()).data.devices[node.id], undefined);
});

test("Windows acceptance packages are tester-only, target-bound, expiring and never a general release", async t => {
  const f = await fixture(t);
  const candidate = await bundle(path.join(f.bundleRoot, "acceptance/platforms/windows-x64"), "windows-x64");
  const policy = {
    schema: 1, platform: "windows-x64", owners: [f.member.id],
    expectedComputerName: "CPC-test-WINBOX", expiresAt: Date.now() + 86400000,
  };
  const policyFile = path.join(f.bundleRoot, "acceptance.json");
  await writeFile(policyFile, JSON.stringify(policy));
  const windowsStatus = async user => (await (await f.request("/api/settings", { user })).json())
    .machineSetup.platforms.find(row => row.platform === "windows-x64");
  const visible = await windowsStatus();
  assert.equal(visible.enabled, true);
  assert.equal(visible.preview, true);
  assert.equal(visible.releaseId, candidate.releaseId);
  assert.equal(visible.expectedComputerName, policy.expectedComputerName);
  assert.equal(JSON.stringify(visible).includes(f.member.id), false, "Do not disclose the allowlist");
  assert.equal((await windowsStatus(f.admin)).enabled, false, "Admins cannot inherit the tester's invitation");
  assert.equal((await f.request("/api/settings/machines/skill?platform=windows-x64", { method: "POST", user: f.admin })).status, 503);
  assert.equal((await f.machineSetup.availability("windows-x64")).enabled, false, "No principal means no candidate");
  const response = await f.request("/api/settings/machines/skill?platform=windows-x64", { method: "POST" });
  assert.equal(response.status, 200);
  const files = unzip(Buffer.from(await response.arrayBuffer()));
  const setup = JSON.parse(files.get("config-new-codey-machine/assets/setup.json"));
  assert.deepEqual(setup.acceptance, { expectedComputerName: policy.expectedComputerName, expiresAt: policy.expiresAt });
  assert.deepEqual(setup.network, { mode: "devtunnel" });
  const vm = await machineFile(f.root, `n-${randomBytes(12).toString("hex")}`);
  const { privateIp, vmResourceId, ...publicFields } = vm;
  const coordinates = { tunnelId: "codey-acceptance-fixture", clusterId: "jpe1" };
  const candidateMachine = {
    ...publicFields, platform: "windows-x64", networkMode: "devtunnel", devTunnel: coordinates,
  };
  const wrong = await f.request("/api/settings/machines/activate", {
    method: "POST", value: registration(candidate, candidateMachine),
  });
  assert.equal(wrong.status, 409);
  assert.equal(f.probes.length, 0);
  const accepted = await f.request("/api/settings/machines/activate", {
    method: "POST", value: registration(candidate, { ...candidateMachine, name: policy.expectedComputerName }),
  });
  assert.equal(accepted.status, 201);
  for (const changed of [
    { expiresAt: Date.now() - 1 }, { owners: ["*"] }, { owners: [f.admin.id] },
    { expectedComputerName: "../other" }, { expiresAt: Date.now() + 30 * 86400000 },
  ]) {
    await writeFile(policyFile, JSON.stringify({ ...policy, ...changed }));
    assert.equal((await windowsStatus()).enabled, false);
  }
  await bundle(path.join(f.bundleRoot, "platforms/windows-x64"), "windows-x64");
  const released = await windowsStatus();
  assert.equal(released.enabled, true);
  assert.equal(released.preview, undefined, "A normal release does not inherit preview restrictions");
});

test("machine downloads reject anonymous/forged/cross-origin requests, caller identities, wrong methods and logout", async (t) => {
  const f = await fixture(t);
  for (const user of ["", "__Host-codey_session=forged"]) {
    assert.equal((await f.request("/api/settings/machines/skill", { method: "POST", user, headers: { "x-ms-client-principal-id": f.member.id } })).status, 401);
  }
  for (const deniedOrigin of ["https://evil.example", "null", ""]) {
    assert.equal((await f.request("/api/settings/machines/skill", {
      method: "POST", headers: { origin: deniedOrigin },
    })).status, 403);
  }
  for (const method of ["GET", "HEAD", "DELETE", "PUT"]) {
    assert.equal((await f.request("/api/settings/machines/skill", { method })).status, 405);
  }
  for (const value of [{ ownerId: "someone-else" }, { nodeId: "old-node" }]) {
    assert.equal((await f.request("/api/settings/machines/skill", { method: "POST", value })).status, 400);
  }
  assert.deepEqual(await f.policy.pendingMachines(f.member.id), []);
  await f.auth.revoke({ headers: { cookie: f.cookie } });
  assert.equal((await f.request("/api/settings/machines/skill", { method: "POST" })).status, 401);
});

test("client registration rejects malformed, reused or mismatched secrets before persistence", async (t) => {
  const f = await fixture(t);
  const id = `n-${randomBytes(12).toString("hex")}`;
  const vm = await machineFile(f.root, id);
  const { privateIp, vmResourceId, ...publicFields } = vm;
  const coordinates = { tunnelId: "codey-registration-fixture", clusterId: "jpe1" };
  const machine = { ...publicFields, platform: "linux-x64", networkMode: "devtunnel", devTunnel: coordinates };
  const valid = registration(f.manifest, machine);
  assert.equal((await f.request("/api/settings/machines/activate", {
    method: "POST", value: valid, user: "",
  })).status, 401);
  assert.equal((await f.request("/api/settings/machines/activate", {
    method: "POST", value: valid, headers: { origin: "https://evil.example" },
  })).status, 403);
  assert.equal((await f.request("/api/settings/machines/activate")).status, 405);
  const duplicate = { ...valid.credentials, workspaceSsoKey: valid.credentials.clientSigningKey };
  const nonCanonical = {
    ...valid.credentials,
    clientSigningKey: "A".repeat(43),
    workspaceSsoKey: "A".repeat(42) + "B",
  };
  const cases = [
    { ...valid, schema: 1 },
    { ...valid, unexpected: true },
    { ...valid, package: { ...valid.package, portalOrigin: "https://other.example.test" } },
    { ...valid, package: { ...valid.package, platform: "windows-x64" } },
    { ...valid, credentials: duplicate },
    { ...valid, credentials: nonCanonical },
    { ...valid, credentials: { ...valid.credentials, workspaceSubject: "member" } },
    { ...valid, credentials: { ...valid.credentials, workspaceUsername: "../root" } },
    { ...valid, devTunnelConnectToken: connectToken({ ...coordinates, tunnelId: "other-tunnel" }) },
    { ...valid, machine: { ...valid.machine, clientSigningKey: valid.credentials.clientSigningKey } },
  ];
  for (const value of cases) {
    const response = await f.request("/api/settings/machines/activate", { method: "POST", value });
    assert.ok([400, 409, 503].includes(response.status), await response.text());
  }
  assert.equal(f.probes.length, 0);
  assert.equal(f.tunnelProbes.length, 0);
  assert.deepEqual(await f.policy.list(f.member.id), []);
  assert.equal((await f.machineSetup.machineUpdates.store.read()).data.devices[id], undefined);

  f.machineSetup.verify = async () => { throw Object.assign(new Error("fixture verification failure"), { status: 502 }); };
  assert.equal((await f.request("/api/settings/machines/activate", { method: "POST", value: valid })).status, 502);
  assert.deepEqual(await f.policy.list(f.member.id), []);
  assert.equal((await f.machineSetup.machineUpdates.store.read()).data.devices[id], undefined);
});

test("client activation is recoverable and idempotent across partial or concurrent retries", async (t) => {
  const f = await fixture(t);
  const id = `n-${randomBytes(12).toString("hex")}`;
  const vm = await machineFile(f.root, id);
  const { privateIp, vmResourceId, ...publicFields } = vm;
  const coordinates = { tunnelId: "codey-retry-fixture", clusterId: "jpe1" };
  const value = registration(f.manifest, {
    ...publicFields, platform: "linux-x64", networkMode: "devtunnel", devTunnel: coordinates,
  });
  const register = f.machineSetup.machineUpdates.registerClientMachine.bind(f.machineSetup.machineUpdates);
  let failed = false;
  f.machineSetup.machineUpdates.registerClientMachine = async (...args) => {
    if (!failed) {
      failed = true;
      throw new Error("fixture updater persistence interruption");
    }
    return register(...args);
  };
  assert.equal((await f.request("/api/settings/machines/activate", {
    method: "POST", value,
  })).status, 503);
  assert.deepEqual(await f.policy.list(f.member.id), [], "An incomplete activation must stay hidden");
  const staged = (await f.policy.records()).data.nodes.find((node) => node.id === id);
  assert.equal(staged.setup.status, "importing");
  assert.equal(staged.enabled, false);

  const retries = await Promise.all([
    f.request("/api/settings/machines/activate", { method: "POST", value }),
    f.request("/api/settings/machines/activate", { method: "POST", value }),
  ]);
  assert.deepEqual(retries.map((response) => response.status), [201, 201]);
  assert.equal((await f.policy.list(f.member.id)).filter((node) => node.id === id).length, 1);
  const device = (await f.machineSetup.machineUpdates.store.read()).data.devices[id];
  assert.equal(device.ownerId, f.member.id);
  const replayAfterUpdaterRotation = {
    ...value,
    credentials: {
      ...value.credentials,
      updaterCredential: randomBytes(32).toString("base64url"),
    },
  };
  assert.equal((await f.request("/api/settings/machines/activate", {
    method: "POST", value: replayAfterUpdaterRotation,
  })).status, 201);
  assert.equal((await f.machineSetup.machineUpdates.store.read()).data.devices[id].credentialHash,
    device.credentialHash, "An active updater credential is not replaced by a registration replay");
});

test("only the invitation owner can activate, and activation verifies before exposing a private gateway", async (t) => {
  const f = await fixture(t);
  const reserved = await f.policy.reserveMachine(f.member.id);
  const machine = await machineFile(f.root, reserved.id);
  const endpoint = `/api/settings/machines/${reserved.id}/activate`;
  assert.equal((await f.request(endpoint, { method: "POST", user: f.admin, value: machine })).status, 404);
  assert.equal(f.probes.length, 0);
  assert.equal((await f.request(endpoint, { method: "POST", value: { ...machine, ownerId: f.credential.principalId } })).status, 400);
  assert.equal(f.probes.length, 0);
  assert.equal(f.data.endpoint(reserved.id, [reserved.id]), null);
  const activated = await f.request(endpoint, { method: "POST", value: machine });
  assert.equal(activated.status, 201);
  assert.equal((await activated.json()).node.vnetOnly, true);
  assert.equal(f.probes.length, 1);
  assert.equal(f.probes[0].options.principal.id, f.member.id);
  assert.equal(f.probes[0].machine.tlsServerName, machineServerName(reserved.id));
  const own = await (await f.request("/api/client-nodes")).json();
  assert.deepEqual(own.connectionModes, ["vnet"]);
  assert.equal(own.nodes[0].id, reserved.id);
  assert.equal(own.nodes[0].vnetOnly, true);
  assert.equal(own.nodes[0].proxyEndpoint, `/api/node-data/${reserved.id}/usage`);
  assert.equal(f.data.nodes.get(reserved.id).ca, machine.tlsCertificate);
  assert.equal(f.workspace.match(`/cloudcli/${reserved.id}/`).ca, machine.tlsCertificate);
  const other = await (await f.request("/api/client-nodes", { user: f.admin })).json();
  assert.deepEqual(other.nodes, []);
  assert.deepEqual(await f.policy.pendingMachines(f.member.id), []);
  assert.equal((await f.request(endpoint, { method: "POST", value: machine })).status, 404, "Consumed invitation cannot be replayed");
  assert.equal((await f.request(`/api/settings/nodes/${reserved.id}`, { method: "DELETE" })).status, 200);
  assert.equal((await f.request(endpoint, { method: "POST", value: machine })).status, 404);
  await f.machineSetup.refreshGateways();
  assert.equal(f.data.endpoint(reserved.id, [reserved.id]), null);
  assert.equal(f.workspace.match(`/cloudcli/${reserved.id}/`), null);
});

test("failed TLS/VNet verification keeps a node unadded; cancellation, expiry, account changes and capacity fail closed", async (t) => {
  const f = await fixture(t);
  const reserved = await f.policy.reserveMachine(f.member.id);
  const machine = await machineFile(f.root, reserved.id);
  f.machineSetup.verify = async () => { throw Object.assign(new Error("Private link verification failed"), { status: 502 }); };
  assert.equal((await f.request(`/api/settings/machines/${reserved.id}/activate`, { method: "POST", value: machine })).status, 502);
  assert.deepEqual(await f.policy.list(f.member.id), []);
  f.machineSetup.verify = async () => {
    await f.accounts.setEnabled(f.member.id, false, f.credential.principalId);
    return {};
  };
  assert.equal((await f.request(`/api/settings/machines/${reserved.id}/activate`, { method: "POST", value: machine })).status, 401);
  assert.deepEqual(await f.policy.list(f.member.id), []);
  const cancelled = await f.policy.reserveMachine(f.credential.principalId);
  await f.policy.cancelMachine(f.credential.principalId, cancelled.id);
  await assert.rejects(f.policy.reservedMachine(f.credential.principalId, cancelled.id), { status: 404 });
  const expired = await f.policy.reserveMachine(f.credential.principalId, Date.now() - 8 * 86400000);
  await assert.rejects(f.policy.reservedMachine(f.credential.principalId, expired.id), { status: 410 });
  for (let index = 0; index < 4; index++) await f.policy.reserveMachine(f.credential.principalId);
  await assert.rejects(f.policy.reserveMachine(f.credential.principalId), { status: 409 });
});

test("logout during machine verification cannot complete activation", async (t) => {
  const f = await fixture(t);
  const reserved = await f.policy.reserveMachine(f.member.id);
  const machine = await machineFile(f.root, reserved.id);
  f.machineSetup.verify = async () => {
    await f.auth.revoke({ headers: { cookie: f.cookie } });
    return {};
  };
  const response = await f.request(`/api/settings/machines/${reserved.id}/activate`, { method: "POST", value: machine });
  assert.equal(response.status, 401);
  assert.deepEqual(await f.policy.list(f.member.id), []);
  assert.equal((await f.policy.pendingMachines(f.member.id)).length, 1);
});

test("descriptive Azure IDs cannot squat another user's VM; the verified private endpoint remains unique", async (t) => {
  const f = await fixture(t);
  const first = await f.policy.reserveMachine(f.member.id);
  const second = await f.policy.reserveMachine(f.credential.principalId);
  const value = { privateIp: "10.42.0.4", vmResourceId: "descriptive-only", name: "First", region: "Test" };
  await f.policy.activateMachine(f.member.id, { ...value, id: first.id });
  await f.policy.activateMachine(f.credential.principalId, { ...value, id: second.id, privateIp: "10.42.0.5" });
  const third = await f.policy.reserveMachine(f.member.id);
  await assert.rejects(f.policy.activateMachine(f.member.id, { ...value, id: third.id }), { status: 409 });
});

test("machine identity rejects arbitrary IP/URL, copied certificates, CA certificates and key-bearing imports before networking", async (t) => {
  const root = await temporary(t);
  const id = `n-${randomBytes(12).toString("hex")}`;
  const value = await machineFile(root, id);
  assert.equal(machineIdentity(value, id).privateIp, value.privateIp);
  for (const ip of ["127.0.0.1", "169.254.169.254", "168.63.129.16", "8.8.8.8", "localhost", "10.42.0.4/path", "::1"]) {
    assert.equal(privateMachineIp(ip), false);
    assert.throws(() => machineIdentity({ ...value, privateIp: ip }, id));
  }
  for (const patch of [
    { nodeId: "other-node" }, { schema: 2 }, { networkMode: "public" }, { name: "\ninvalid" },
    { tlsCertificate: value.tlsCertificate + value.tlsCertificate },
    { workspaceSsoKey: "do-not-import-secrets" }, { vmResourceId: "https://management.azure.com/" },
  ]) assert.throws(() => machineIdentity({ ...value, ...patch }, id));
  const other = await machineFile(root, id, { dns: "another.nodes.codey.internal" });
  assert.throws(() => machineIdentity(other, id));
  const ca = await machineFile(root, id, { ca: true });
  assert.throws(() => machineIdentity(ca, id));
  assert.throws(() => machineIdentity(value, id, Date.now() + 366 * 86400000));
});

test("bundle selection is immutable/path-restricted and a corrupt stream never completes its ZIP", async (t) => {
  const root = await temporary(t);
  const manifest = await bundle(root);
  const loaded = await loadMachineBundle(root);
  const file = loaded.files[0];
  const archive = zipStream([{ name: "skill/runtime.tar.gz", ...file }]);
  const chunks = [];
  for await (const chunk of archive) chunks.push(chunk);
  const bytes = Buffer.concat(chunks);
  assert.equal(bytes.length, archive.length);
  assert.deepEqual(unzip(bytes).get("skill/runtime.tar.gz"), await readFile(file.path));
  await writeFile(file.path, Buffer.alloc(file.size, 120));
  await assert.rejects(async () => { for await (const _ of zipStream([{ name: "skill/runtime.tar.gz", ...file }])) { /* drain */ } }, /checksum/);
  await writeFile(path.join(root, "active.json"), JSON.stringify({ releaseId: "../../secrets" }));
  await assert.rejects(loadMachineBundle(root), /active/);
  await rm(path.join(root, "active.json"));
  manifest.artifacts[0].file = "../credentials";
  await writeFile(path.join(root, "manifest.json"), JSON.stringify(manifest));
  await assert.rejects(loadMachineBundle(root), /metadata/);
  for (const name of ["../key", "/key", "x//y", "x/./y", "x\\key"]) assert.throws(() => zipStream([{ name, data: "no" }]));
  if (process.platform !== "win32") {
    await bundle(root);
    await rm(file.path);
    await symlink(path.join(root, "copilot-api-source.tar.gz"), file.path);
    await assert.rejects(loadMachineBundle(root), /Unsafe/);
  }
});

test("network configuration cannot put Private Endpoints in the ACA subnet or another VNet", () => {
  assert.deepEqual(machineNetworkConfig(network), network);
  for (const value of [
    {}, { ...network, privateEndpointSubnetId: network.portalSubnetId },
    { ...network, privateEndpointSubnetId: network.privateEndpointSubnetId.replace("/portal/", "/other/") },
    { ...network, portalSubnetId: "http://metadata.invalid" },
  ]) assert.throws(() => machineNetworkConfig(value));
});

test("declared VNet-only machines never send a browser ticket to an untrusted direct certificate", async () => {
  const node = {
    id: "n-0123456789abcdef01234567", vnetOnly: true, ticket: "must-not-be-sent",
    proxyEndpoint: "/api/node-data/n-0123456789abcdef01234567/usage",
  };
  const result = await fetchNodeJson(node, "https://n-0123456789abcdef01234567.nodes.codey.internal:8443/usage", {
    connectionMode: "direct", fetchImpl: async (url, options) => {
      assert.equal(url, node.proxyEndpoint);
      assert.equal(options.credentials, "same-origin");
      assert.equal(options.mode, "same-origin");
      assert.equal(options.headers.authorization, undefined);
      return new Response('{"ok":true}', { status: 200 });
    },
  });
  assert.deepEqual(result, { ok: true });
});
