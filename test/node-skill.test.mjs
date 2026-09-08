import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { runInNewContext } from "node:vm";
import { inflateRawSync } from "node:zlib";
import { buildNodeSkill, checksumText, DOWNLOAD_ROOT, SKILL_FILES, SKILL_NAME, SKILL_ROOT } from "../scripts/build-node-skill.mjs";
import { gatewayEntries } from "../skills/codey-node-onboarding/scripts/gateway-entry.mjs";
import { AccountStore } from "../src/account-store.mjs";
import { validateConfig } from "../src/config.mjs";
import { NodePolicy } from "../src/node-policy.mjs";
import { PasswordAuthenticator, hashPassword } from "../src/password-auth.mjs";
import { createMultiUserPortalServer } from "../src/server.mjs";
import { resolveCloudCliGatewayConfig } from "../src/cloudcli-gateway.mjs";
import { resolveNodeDataGatewayConfig } from "../src/node-data-gateway.mjs";

const run = promisify(execFile);
const download = `/downloads/${SKILL_NAME}.zip`;
const sumPath = `/downloads/${SKILL_NAME}.sha256`;
const fixtureNode = "n-0123456789abcdef01234567";

async function temporary(t) {
  const prefix = "codey-skill-test-";
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith(prefix));
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

function unzipText(archive) {
  const entries = new Map();
  let offset = 0;
  while (archive.readUInt32LE(offset) === 0x04034b50) {
    assert.equal(archive.readUInt16LE(offset + 6), 0x800);
    assert.equal(archive.readUInt16LE(offset + 8), 8);
    const packedSize = archive.readUInt32LE(offset + 18);
    const size = archive.readUInt32LE(offset + 22);
    const nameLength = archive.readUInt16LE(offset + 26);
    const extraLength = archive.readUInt16LE(offset + 28);
    const name = archive.subarray(offset + 30, offset + 30 + nameLength).toString();
    assert.ok(!entries.has(name));
    assert.ok(!name.includes("..") && !name.includes("\\") && !name.startsWith("/"));
    const begin = offset + 30 + nameLength + extraLength;
    const data = inflateRawSync(archive.subarray(begin, begin + packedSize));
    assert.equal(data.length, size);
    entries.set(name, data.toString("utf8"));
    offset = begin + packedSize;
  }
  assert.equal(archive.readUInt32LE(offset), 0x02014b50);
  assert.equal(archive.readUInt32LE(archive.length - 22), 0x06054b50);
  assert.equal(archive.readUInt16LE(archive.length - 12), entries.size);
  return entries;
}

test("node skill ZIP is reproducible, complete, small, source-matched, and has a matching checksum", async () => {
  const archive = await buildNodeSkill();
  assert.deepEqual(archive, await buildNodeSkill());
  assert.deepEqual(archive, await readFile(path.join(DOWNLOAD_ROOT, `${SKILL_NAME}.zip`)));
  assert.equal(await readFile(path.join(DOWNLOAD_ROOT, `${SKILL_NAME}.sha256`), "utf8"), checksumText(archive));
  assert.ok(archive.length < 64 * 1024);
  const entries = unzipText(archive);
  assert.deepEqual([...entries.keys()], SKILL_FILES.map((file) => `${SKILL_NAME}/${file}`));
  for (const file of SKILL_FILES) {
    const text = entries.get(`${SKILL_NAME}/${file}`);
    assert.equal(text, (await readFile(path.join(SKILL_ROOT, file), "utf8")).replace(/^\uFEFF/, "").replaceAll("\r\n", "\n"));
    assert.doesNotMatch(text, /-----BEGIN [^\n]*PRIVATE KEY-----|(?:sk|ghp|github_pat)-[A-Za-z0-9_-]{24,}/);
    assert.doesNotMatch(text, /(?:CODEY_PORTAL_SSO_KEY|PASSWORD)=[A-Za-z0-9_+/=-]{24,}/);
    assert.doesNotMatch(text, /C:\\Users\\zhn|zhn-a100|zhn@microsoft\.com|9e7a208d-62e7-459d-a5be-f74e4b726a5a/);
    if (!file.endsWith(".md")) continue;
    for (const [, target] of text.matchAll(/\[[^\]]+\]\(([^)\s]+)\)/g)) {
      if (/^[a-z]+:/.test(target)) continue;
      const resolved = path.posix.normalize(path.posix.join(SKILL_NAME, path.posix.dirname(file), target.split("#")[0]));
      assert.ok(entries.has(resolved), `Broken skill reference ${file}: ${target}`);
    }
  }
  assert.match(entries.get(`${SKILL_NAME}/SKILL.md`), /^---\nname: codey-node-onboarding\ndescription: ".+"\n/);
});

test("skill packaging never scans unrelated credentials and refuses oversized sources", async (t) => {
  const root = await temporary(t);
  const source = path.join(root, "source");
  await cp(SKILL_ROOT, source, { recursive: true });
  await writeFile(path.join(source, ".env"), "SECRET=DO-NOT-BUNDLE");
  await writeFile(path.join(source, "accounts.json"), '{"passwordHash":"DO-NOT-BUNDLE"}');
  assert.deepEqual(await buildNodeSkill(source), await buildNodeSkill());
  await writeFile(path.join(source, "SKILL.md"), "x".repeat(129 * 1024));
  await assert.rejects(buildNodeSkill(source), /oversized/);
});

test("offline gateway entries are accepted by the actual data and workspace config loaders", () => {
  const entries = gatewayEntries({ nodeId: fixtureNode, ip: "10.42.0.4", tls: "node.example.test", name: "Example", region: "Test" });
  const files = {
    "node-data.json": JSON.stringify({ nodes: [entries["node-data.aca.json"]] }),
    "cloudcli.json": JSON.stringify({ nodes: [entries["cloudcli-nodes.aca.json"]] }),
    "public-ca.pem": "test-only-public-ca",
  };
  const read = (name) => {
    assert.ok(Object.hasOwn(files, name), `Unexpected file read ${name}`);
    return files[name];
  };
  const data = resolveNodeDataGatewayConfig({
    PORTAL_NODE_DATA_CONFIG: "node-data.json",
    PORTAL_CLIENT_RELAY_SIGNING_KEY: "test-only-key-".repeat(4),
    PORTAL_NODE_DATA_CA_FILE: "public-ca.pem",
  }, read);
  assert.equal(data.nodes[0].upstream.href, "https://10.42.0.4:8443/");
  assert.equal(data.nodes[0].id, fixtureNode);
  const workspace = resolveCloudCliGatewayConfig({
    PORTAL_CLOUDCLI_CONFIG: "cloudcli.json",
    PORTAL_CLOUDCLI_CA_FILE: "public-ca.pem",
  }, read);
  assert.equal(workspace.nodes[0].upstream.href, "https://10.42.0.4:3001/");
  assert.equal(workspace.nodes[0].basePath, `/cloudcli/${fixtureNode}`);
  assert.equal(entries["node-data.aca.json"].tlsServerName, "node.example.test");
});

test("offline gateway helper rejects legacy IDs, public/loopback/metadata addresses and unsafe DNS/ports", () => {
  const base = { nodeId: fixtureNode, ip: "10.42.0.4", tls: "node.example.test" };
  for (const ip of ["127.0.0.1", "169.254.169.254", "8.8.8.8", "172.15.0.1", "172.32.0.1", "10.1.1.999", "10.0.0.1/path", "::1", "node.example.test", "10.1"]) {
    assert.throws(() => gatewayEntries({ ...base, ip }));
  }
  for (const ip of ["10.0.0.1", "172.16.0.4", "172.31.255.254", "192.168.1.4"]) {
    assert.equal(gatewayEntries({ ...base, ip })["node-data.aca.json"].upstream, `https://${ip}:8443`);
  }
  for (const nodeId of ["local", "existing-vm", "../other", `${fixtureNode}/other`, fixtureNode.toUpperCase()]) {
    assert.throws(() => gatewayEntries({ ...base, nodeId }));
  }
  for (const tls of ["10.42.0.4", "*.example.test", "https://node.example.test", "bad\r\nhost", "-bad.example.test", "bad..example.test"]) {
    assert.throws(() => gatewayEntries({ ...base, tls }));
  }
  for (const dataPort of ["0", "-1", "1.5", "65536", "8443/path", "0x20", "1e3", "00443"]) {
    assert.throws(() => gatewayEntries({ ...base, dataPort }));
  }
  assert.throws(() => gatewayEntries({ ...base, region: "one\ntwo" }));
  assert.throws(() => gatewayEntries({ ...base, name: "a".repeat(81) }));
});

test("downloaded offline helper runs standalone and reports invalid CLI input without generating config", async (t) => {
  const root = await temporary(t);
  const script = path.join(root, "gateway-entry.mjs");
  await writeFile(script, unzipText(await buildNodeSkill()).get(`${SKILL_NAME}/scripts/gateway-entry.mjs`));
  const { stdout, stderr } = await run(process.execPath, [
    script, "--node-id", fixtureNode, "--ip", "10.42.0.4", "--tls", "node.example.test",
    "--data-port", "9443", "--workspace-port", "4001",
  ], { cwd: root });
  assert.equal(stderr, "");
  assert.equal(JSON.parse(stdout)["node-data.aca.json"].upstream, "https://10.42.0.4:9443");
  assert.equal(JSON.parse(stdout)["cloudcli-nodes.aca.json"].upstream, "https://10.42.0.4:4001");
  await assert.rejects(run(process.execPath, [script, "--node-id", fixtureNode, "--ip", "127.0.0.1", "--tls", "node.example.test"]),
    (error) => error.code === 1 && error.stdout === "" && /RFC1918/.test(error.stderr));
  await assert.rejects(run(process.execPath, [script, "--node-id", fixtureNode, "--node-id", fixtureNode]),
    (error) => error.code === 1 && error.stdout === "" && /Duplicate option/.test(error.stderr));
});

test("skill downloads require valid portal login, support members/HEAD, reject writes and revoke with logout", async (t) => {
  const root = await temporary(t);
  const origin = "https://codey.example.test";
  const password = "Test-only-Node-Skill-Login-42!";
  const credential = { username: "owner", principalId: "skill-test-owner", passwordHash: await hashPassword(password) };
  const master = randomBytes(32).toString("base64url");
  const accounts = new AccountStore({ root, master, credential });
  await accounts.initialize();
  await accounts.create({ username: "member", password });
  const config = validateConfig({ nodes: [], clientNodes: [] });
  const nodePolicy = new NodePolicy({
    root, master, ticketMaster: randomBytes(48).toString("base64url"),
    seedPrincipalId: credential.principalId, defaults: config,
    legacyConfigStore: { async load() { return { config }; } },
  });
  await nodePolicy.initialize();
  const auth = new PasswordAuthenticator({
    credential, accountStore: accounts, root, publicBaseUrl: origin, staticRoot: path.resolve("public"),
  });
  const server = createMultiUserPortalServer({
    passwordAuthenticator: auth, nodePolicy, staticRoot: path.resolve("public"),
    portalName: "Codey", readOnly: true, clientOnly: true,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  for (const target of [download, sumPath]) {
    for (const headers of [{}, { cookie: "__Host-codey_session=forged" }, { "x-ms-client-principal-id": credential.principalId }]) {
      const response = await fetch(baseUrl + target, { headers, redirect: "manual" });
      assert.equal(response.status, 401);
      assert.notEqual(response.headers.get("content-type"), "application/zip");
    }
    const navigation = await fetch(baseUrl + target, { headers: { accept: "text/html" }, redirect: "manual" });
    assert.equal(navigation.status, 302);
    assert.equal(navigation.headers.get("location"), "/portal-auth/login");
  }
  const archive = await buildNodeSkill();
  for (const username of ["owner", "member"]) {
    const cookie = (await auth.login(username, password)).cookie.split(";")[0];
    const headers = { cookie };
    const response = await fetch(baseUrl + download, { headers });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/zip");
    assert.equal(response.headers.get("content-disposition"), `attachment; filename="${SKILL_NAME}.zip"`);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(response.headers.get("vary"), "Cookie");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("content-length"), String(archive.length));
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), archive);
    const head = await fetch(baseUrl + download, { method: "HEAD", headers });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-length"), String(archive.length));
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    const checksum = await fetch(baseUrl + sumPath, { headers });
    assert.equal(checksum.status, 200);
    assert.equal(await checksum.text(), checksumText(archive));
    for (const method of ["POST", "PUT", "DELETE", "OPTIONS"]) {
      const denied = await fetch(baseUrl + download, { method, headers: { ...headers, origin } });
      assert.equal(denied.status, 405);
      assert.equal(denied.headers.get("allow"), "GET, HEAD");
    }
    const crossOrigin = await fetch(baseUrl + download, { method: "POST", headers: { ...headers, origin: "https://evil.example.test" } });
    assert.equal(crossOrigin.status, 403);
    for (const suffix of ["/downloads/unknown.zip", "/downloads/%2e%2e%2fconfig%2fnodes.json", `${download}/extra`, "/downloads/codey-node-onboarding/../../.env"]) {
      assert.equal((await fetch(baseUrl + suffix, { headers })).status, 404);
    }
    await auth.revoke({ headers });
    assert.equal((await fetch(baseUrl + download, { headers, redirect: "manual" })).status, 401);
  }
});

test("add-machine and empty-node entry points only expose the verified automatic setup flow", async () => {
  const settings = await readFile(path.resolve("public/settings.html"), "utf8");
  const script = await readFile(path.resolve("public/settings.js"), "utf8");
  const styles = await readFile(path.resolve("public/settings.css"), "utf8");
  const app = await readFile(path.resolve("public/app.js"), "utf8");
  assert.match(settings, /<dialog id="add-node"[^>]*aria-labelledby="add-node-title"/);
  assert.doesNotMatch(settings.match(/<dialog id="add-node"[^>]*>/)[0], /\bopen\b/);
  assert.doesNotMatch(settings, /高级：手动注册与接入说明|manual-node-setup|create-node-form/);
  assert.ok(!settings.includes(download));
  assert.ok(!settings.includes(sumPath));
  assert.doesNotMatch(script, /create-node-form/);
  assert.doesNotMatch(styles, /manual-node-setup|node-skill-tools|\.skill-download|\.skill-checksum|\.skill-install/);
  assert.ok(app.includes('window.location.assign("/settings#add-node")'));
  assert.ok(app.match(/node-onboarding-actions[\s\S]*?<\/div>/)?.[0].includes('href="/settings#add-node"'));
  assert.ok(app.match(/elements\.dashboard\.innerHTML = '<section class="empty-state">[^\n]+/)?.[0].includes("完整机器配置 Skill"));
  assert.ok(settings.includes('action="/api/settings/machines/skill" method="post"'));
  assert.ok(settings.indexOf('id="machine-skill-form"') < settings.indexOf('id="add-prepared-machine-form"'));
});

test("add-node navigation waits for async node rendering and does not open on ordinary settings visits", async () => {
  const source = await readFile(path.resolve("public/settings.js"), "utf8");
  for (const hash of ["#add-node", "#nodes", ""]) {
    const events = [];
    const nodes = new Map();
    const listeners = new Map();
    const element = () => ({
      addEventListener() {}, append() {}, classList: { toggle() {} }, querySelectorAll() { return []; },
      replaceChildren() { events.push("nodes-rendered"); },
      showModal() { this.open = true; events.push("opened"); },
      scrollIntoView() { throw new Error("Settings navigation must not scroll a long page"); },
    });
    const window = { location: { hash }, addEventListener(name, fn) { listeners.set(name, fn); } };
    const document = {
      createElement: element,
      querySelectorAll() { return []; },
      querySelector(selector) {
        // The removed legacy form must not be needed to bootstrap settings.
        if (selector === "#create-node-form") return null;
        if (!nodes.has(selector)) nodes.set(selector, element());
        return nodes.get(selector);
      },
    };
    let releaseResponse;
    const gate = new Promise((resolve) => { releaseResponse = resolve; });
    runInNewContext(source, {
      window, document,
      fetch: async () => {
        await gate;
        events.push("response");
        return { status: 200, ok: true, json: async () => ({ nodes: [], user: { role: "user" } }) };
      },
    });
    assert.deepEqual(events, []);
    releaseResponse();
    await new Promise(setImmediate);
    assert.deepEqual(events, hash === "#add-node" ? ["response", "nodes-rendered", "opened"] : ["response", "nodes-rendered"]);
    if (hash === "#add-node") assert.equal(nodes.get("#add-node").open, true);
    else assert.ok(!nodes.get("#add-node").open);
    window.location.hash = "#add-node";
    listeners.get("hashchange")();
    assert.equal(nodes.get("#add-node").open, true);
    assert.equal(events.at(-1), "opened");
  }
});
