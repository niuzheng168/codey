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
import { MachineSetup, loadMachineBundle, machineNetworkConfig, machineReleaseId } from "../src/machine-setup.mjs";
import { machineIdentity, machineServerName, privateMachineIp } from "../src/machine-identity.mjs";
import { NodeDataGateway } from "../src/node-data-gateway.mjs";
import { CloudCliGateway } from "../src/cloudcli-gateway.mjs";
import { crc32, zipStream } from "../src/zip-stream.mjs";
import { fetchNodeJson } from "../public/node-transport.js";
import { MachineUpdates } from "../src/machine-updates.mjs";
import { machinePlatform, machineRegistrationPlatform } from "../src/machine-platforms.mjs";

const run = promisify(execFile);
const origin = "https://codey.example.test";
const subscription = "00000000-0000-0000-0000-000000000000";
const resourceRoot = `/subscriptions/${subscription}/resourceGroups/test/providers/Microsoft.Network/virtualNetworks/portal`;
const network = {
  portalSubnetId: `${resourceRoot}/subnets/infrastructure`,
  privateEndpointSubnetId: `${resourceRoot}/subnets/endpoints`,
};

test("the Portal image does not embed the independently published machine Skill", async () => {
  const dockerfile = await readFile(new URL("../Dockerfile", import.meta.url), "utf8");
  assert.doesNotMatch(dockerfile, /COPY .*skills\/config-new-codey-machine/);
});

async function temporary(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "codey-machine-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function bundle(root, platform = "linux-x64") {
  assert.equal(platform, "linux-x64");
  await mkdir(root, { recursive: true });
  const entries = [
    ["SKILL.md", "---\nname: config-new-codey-machine\ndescription: fixture\n---\n"],
    ["dependencies.json", "{}\n"], ["agents/openai.yaml", "interface: {}\n"],
    ["scripts/install.sh", "#!/usr/bin/env bash\n"], ["templates/a100-models.json", '{"models":[]}\n'],
    ["assets/codey-0.1.0.tgz", "codey"], ["assets/manifest.json", '{"schema":2,"name":"codey"}\n'],
    ["assets/setup.json", '{"schema":1}\n'], ["assets/SHA256SUMS", "fixture\n"],
  ].map(([name, data]) => ({ name: `config-new-codey-machine/${name}`, data }));
  const stream = zipStream(entries);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const packageBytes = Buffer.concat(chunks);
  const packageSha256 = createHash("sha256").update(packageBytes).digest("hex");
  const manifest = {
    schema: 2, kind: "codey-machine-skill", platform, registrationSchema: 2,
    releaseId: `machine-${packageSha256.slice(0, 16)}`, installerReleaseId: "machine-" + "a".repeat(16),
    node: "24.20.0", cloudcli: { version: "test-cloudcli" }, copilotApi: { version: "test-copilot" },
    runtimePackage: { name: "codey", file: "codey-0.1.0.tgz" }, codey: { version: "0.1.0" },
    bundledRuntimes: ["cloudcli", "copilot-api", "updater"],
    downloadedOfficialRuntimes: ["node", "codex", "devtunnel"],
    package: {
      file: "config-new-codey-machine.zip", size: packageBytes.length, sha256: packageSha256,
    },
  };
  manifest.releaseId = machineReleaseId(manifest);
  const store = path.join(root, "packages-v2");
  const release = path.join(store, "releases", manifest.releaseId);
  await mkdir(release, { recursive: true });
  await writeFile(path.join(release, manifest.package.file), packageBytes);
  const raw = JSON.stringify(manifest);
  await writeFile(path.join(release, "manifest.json"), raw);
  await writeFile(path.join(store, "active.json"), JSON.stringify({
    schema: 1, releaseId: manifest.releaseId,
    manifestSha256: createHash("sha256").update(raw).digest("hex"),
  }));
  return { ...manifest, packageBytes };
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

test("the independently published Linux Skill streams unchanged and activates only after scoped tunnel proof", async t => {
  const f = await fixture(t);
  f.machineSetup.network = null;
  const response = await f.request("/api/settings/machines/skill", { method: "POST" });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-disposition"), 'attachment; filename="config-new-codey-machine.zip"');
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.deepEqual(bytes, f.manifest.packageBytes);
  const files = unzip(bytes);
  assert.ok(files.has("config-new-codey-machine/scripts/install.sh"));
  assert.ok(files.has("config-new-codey-machine/assets/codey-0.1.0.tgz"));
  assert.equal([...files.keys()].filter(name => name.endsWith(".tgz") || name.endsWith(".tar.gz")).length, 1);
  assert.ok(![...files.keys()].some(name => name.includes("codey_node/") || name.includes("setup-windows")));
  const repeated = await f.request("/api/settings/machines/skill", { method: "POST" });
  assert.deepEqual(Buffer.from(await repeated.arrayBuffer()), bytes);

  const nodeId = `n-${randomBytes(12).toString("hex")}`;
  const vm = await machineFile(f.root, nodeId);
  const { privateIp, vmResourceId, ...fields } = vm;
  const coordinates = { tunnelId: "codey-fixture-linux", clusterId: "jpe1" };
  const machine = { ...fields, platform: "linux-x64", networkMode: "devtunnel", devTunnel: coordinates };
  const credentials = clientCredentials();
  const token = connectToken(coordinates);
  const activation = await f.request("/api/settings/machines/activate", {
    method: "POST", value: registration(f.manifest, machine, credentials, token),
  });
  assert.equal(activation.status, 201);
  const node = (await activation.json()).node;
  assert.equal(node.platform, "linux-x64");
  assert.equal(f.workspace.match(`/cloudcli/${node.id}/`).devTunnel.port, 3001);
  assert.equal(f.data.nodes.get(node.id).devTunnel.port, 8443);
  assert.equal(await f.policy.keyFor(f.member.id, node.id), credentials.clientSigningKey);
  assert.deepEqual(await f.policy.workspaceBindingFor(f.member.id, node.id), {
    key: credentials.workspaceSsoKey,
    subject: credentials.workspaceSubject,
    username: credentials.workspaceUsername,
  });
  assert.equal(await f.policy.tunnelKeyFor(node.id), credentials.tunnelUpdateKey);
  const device = (await f.machineSetup.machineUpdates.store.read()).data.devices[node.id];
  assert.ok(device);
  assert.equal((await f.machineSetup.machineUpdates.authenticateAgent({ headers: {
    "x-codey-node-id": node.id,
    authorization: `Bearer ${credentials.updaterCredential}`,
  } })).ownerId, f.member.id);
  assert.equal(f.probes.length, 1);
  assert.equal(f.tunnelProbes.length, 1);
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
  assert.deepEqual(bytes, f.manifest.packageBytes);
  const entries = unzip(bytes);
  assert.ok(entries.has("config-new-codey-machine/SKILL.md"));
  assert.ok(entries.has("config-new-codey-machine/scripts/install.sh"));
  assert.ok(entries.has("config-new-codey-machine/assets/codey-0.1.0.tgz"));
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

test("only Linux is currently published and other native launchers never fall back to Bash", async (t) => {
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
  for (const platform of ["windows-x64", "macos-arm64", "macos-x64"]) {
    assert.equal((await f.request(`/api/settings/machines/skill?platform=${platform}`, { method: "POST" })).status, 400);
  }
  assert.equal((await f.policy.pendingMachines(f.member.id)).length, 0, "Unavailable/wrong platforms do not reserve IDs");
});

test("native registration support is independent from the installer download gate", () => {
  assert.equal(machinePlatform().id, "linux-x64");
  assert.equal(machineRegistrationPlatform("linux-x64").updater, true);
  assert.equal(machineRegistrationPlatform("windows-x64").updater, false);
  assert.throws(() => machinePlatform("windows-x64"), { status: 400 });
  for (const id of [undefined, null, "", "macos-arm64", "macos-x64", "../linux-x64", "other"]) {
    assert.throws(() => machineRegistrationPlatform(id), { status: 400 });
  }
});

test("Windows registration imports without a published bundle or Linux updater and restores both gateways", async t => {
  const f = await fixture(t);
  f.machineSetup.bundleRoot = null;
  const updates = f.machineSetup.machineUpdates;
  f.machineSetup.machineUpdates = null;
  f.machineSetup.selectedBundle = async () => { assert.fail("Registration must not load a download"); };
  const id = `n-${randomBytes(12).toString("hex")}`;
  const { privateIp, vmResourceId, ...fields } = await machineFile(f.root, id);
  const machine = { ...fields, platform: "windows-x64", networkMode: "devtunnel",
    devTunnel: { tunnelId: "codey-windows-registration", clusterId: "jpe1" } };
  const value = registration({ platform: "windows-x64", releaseId: "machine-" + "b".repeat(16) }, machine);
  const post = options => f.request("/api/settings/machines/activate", { method: "POST", value, ...options });

  assert.equal((await post({ user: "" })).status, 401);
  assert.equal((await post({ headers: { origin: "https://evil.example" } })).status, 403);
  assert.equal(f.probes.length, 0);
  const response = await post();
  assert.equal(response.status, 201, await response.clone().text());
  const node = (await response.json()).node;
  assert.equal(node.id, id);
  assert.equal(node.platform, "windows-x64");
  assert.equal(f.tunnelProbes.length, 1);
  assert.equal(f.probes.length, 1);
  assert.equal(await f.probes[0].options.getTunnelToken(), value.devTunnelConnectToken);
  assert.equal(f.probes[0].options.workspaceBinding.key, value.credentials.workspaceSsoKey);
  assert.equal(await f.policy.keyFor(f.member.id, id), value.credentials.clientSigningKey);
  assert.equal((await updates.store.read()).data.devices[id], undefined,
    "Windows must not enroll in the Linux/systemd updater");
  assert.equal((await f.policy.list(f.credential.principalId)).length, 0);
  assert.equal((await post({ user: f.admin })).status, 409, "Another owner cannot reclaim the node");
  assert.equal((await post()).status, 201, "Same-owner retries are idempotent");
  assert.equal((await f.policy.list(f.member.id)).length, 1);
  const settings = await (await f.request("/api/settings")).json();
  assert.equal(settings.machineSetup.platforms.find(p => p.platform === "windows-x64").enabled, false);
  assert.equal((await f.request("/api/settings/machines/skill?platform=windows-x64", { method: "POST" })).status, 400);

  // Simulate gateway reconstruction after a Portal restart, not only the initial import.
  f.workspace.setMachineNodes([]);
  f.data.setMachineNodes([]);
  f.machineSetup.gatewayRevision = undefined;
  await f.machineSetup.refreshGateways();
  const workspace = f.workspace.match(`/cloudcli/${id}/`);
  assert.equal(workspace.devTunnel.port, 3001);
  assert.equal(workspace.healthMonitoring, true);
  assert.equal(f.data.nodes.get(id).devTunnel.port, 8443);
  assert.equal(await f.policy.machineTunnelToken(id), value.devTunnelConnectToken);
});

test("Windows import retains metadata, tunnel, TLS and account checks before any persistence", async t => {
  const f = await fixture(t);
  f.machineSetup.bundleRoot = null;
  f.machineSetup.machineUpdates = null;
  const id = `n-${randomBytes(12).toString("hex")}`;
  const { privateIp, vmResourceId, ...fields } = await machineFile(f.root, id);
  const value = registration({ platform: "windows-x64", releaseId: "machine-" + "c".repeat(16) }, {
    ...fields, platform: "windows-x64", networkMode: "devtunnel",
    devTunnel: { tunnelId: "codey-windows-negative", clusterId: "jpe1" },
  });
  const invalid = [
    { ...value, package: { ...value.package, portalOrigin: "https://other.example.test" } },
    { ...value, machine: { ...value.machine, platform: "linux-x64" } },
    { ...value, machine: { ...value.machine, nodeId: `n-${"d".repeat(24)}` } },
    { ...value, credentials: { ...value.credentials, workspaceSsoKey: value.credentials.clientSigningKey } },
    { ...value, package: { ...value.package, platform: "macos-arm64" },
      machine: { ...value.machine, platform: "macos-arm64" } },
    { ...value, devTunnelConnectToken: connectToken(value.machine.devTunnel, Date.now() - 86400000) },
  ];
  for (const document of invalid) {
    const response = await f.request("/api/settings/machines/activate", { method: "POST", value: document });
    assert.ok([400, 409, 503].includes(response.status));
  }
  assert.equal(f.tunnelProbes.length, 0);
  assert.equal(f.probes.length, 0);
  const tunnelProbe = f.machineSetup.verifyTunnel;
  f.machineSetup.verifyTunnel = async () => { throw new Error("Invalid token at the tunnel service"); };
  assert.equal((await f.request("/api/settings/machines/activate", { method: "POST", value })).status, 503);
  assert.equal(f.probes.length, 0, "A valid-looking JWT is not a substitute for tunnel authorization");
  f.machineSetup.verifyTunnel = tunnelProbe;
  f.machineSetup.verify = async () => { throw Object.assign(new Error("TLS/SSO proof failed"), { status: 502 }); };
  assert.equal((await f.request("/api/settings/machines/activate", { method: "POST", value })).status, 502);
  assert.equal((await f.policy.records()).data.nodes.length, 0);
  f.machineSetup.verify = async () => {
    await f.auth.revoke({ headers: { cookie: f.cookie } });
    return {};
  };
  assert.equal((await f.request("/api/settings/machines/activate", { method: "POST", value })).status, 401);
  assert.equal((await f.policy.records()).data.nodes.length, 0, "Logout during proof must not add a node");
});

test("registration still requires gateways and, on Linux only, a configured signed updater", async t => {
  const f = await fixture(t);
  f.machineSetup.bundleRoot = null;
  assert.equal(f.machineSetup.registrationAvailability("windows-x64").enabled, true);
  assert.equal(f.machineSetup.registrationAvailability("linux-x64").enabled, true);
  f.machineSetup.machineUpdates = null;
  assert.equal(f.machineSetup.registrationAvailability("windows-x64").enabled, true);
  assert.equal(f.machineSetup.registrationAvailability("linux-x64").enabled, false);
  f.machineSetup.machineUpdates = { catalog: { configured: false } };
  assert.equal(f.machineSetup.registrationAvailability("linux-x64").enabled, false);
  for (const name of ["cloudCliGateway", "nodeDataGateway"]) {
    const gateway = f.machineSetup[name];
    f.machineSetup[name] = null;
    assert.equal(f.machineSetup.registrationAvailability("windows-x64").enabled, false);
    f.machineSetup[name] = gateway;
  }
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
  const normalizedCertificate = machine.tlsCertificate.replace(/\r\n/g, "\n");
  assert.equal(f.data.nodes.get(reserved.id).ca, normalizedCertificate);
  assert.equal(f.workspace.match(`/cloudcli/${reserved.id}/`).ca, normalizedCertificate);
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

test("independent package selection is immutable and path-restricted", async (t) => {
  const root = await temporary(t);
  const manifest = await bundle(root);
  const loaded = await loadMachineBundle(root);
  assert.deepEqual(await readFile(loaded.package.path), manifest.packageBytes);
  const store = path.join(root, "packages-v2");
  await writeFile(path.join(store, "active.json"), JSON.stringify({ releaseId: "../../secrets" }));
  await assert.rejects(loadMachineBundle(root), /active/);
  await bundle(root);
  const release = path.join(store, "releases", manifest.releaseId);
  const outer = { ...manifest, packageBytes: undefined, package: { ...manifest.package, file: "../credentials" } };
  const raw = JSON.stringify(outer);
  await writeFile(path.join(release, "manifest.json"), raw);
  await writeFile(path.join(store, "active.json"), JSON.stringify({
    schema: 1, releaseId: manifest.releaseId,
    manifestSha256: createHash("sha256").update(raw).digest("hex"),
  }));
  await assert.rejects(loadMachineBundle(root), /manifest/);
  for (const name of ["../key", "/key", "x//y", "x/./y", "x\\key"]) assert.throws(() => zipStream([{ name, data: "no" }]));
  if (process.platform !== "win32") {
    await bundle(root);
    const selected = await loadMachineBundle(root);
    await rm(selected.package.path);
    await symlink(path.join(root, "outside.zip"), selected.package.path);
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
