import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildNativeUpdaters } from "../scripts/build-native-updaters.mjs";
import { prepareUpdater } from "../skills/config-new-codey-machine/scripts/updater-bootstrap.mjs";

const save = async (file, value) => {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value), { mode: 0o600 });
};

test("all native automatic bootstraps use the local identity, public trust and complete Portal agent payload", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "codey-auto-updater-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const app = path.join(home, "codey");
  await buildNativeUpdaters(path.join(app, "updater/native"));
  const key = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" });
  for (const platform of ["windows-x64", "macos-arm64", "macos-x64"]) {
    const ownerHome = path.join(home, platform);
    // Keep one shared npm artifact inside each fixture's declared owner home.
    const identity = { nodeId: "n-" + randomBytes(12).toString("hex"), workspaceSubject: "m-" + randomBytes(12).toString("hex"),
      workspaceUsername: "owner", updaterCredential: randomBytes(32).toString("base64url") };
    const setup = { platform, portalOrigin: "https://portal.example.test", updater: { protocol: 1, releasePublicKey: key } };
    const environment = { CODEY_PORTAL_NODE_ID: identity.nodeId, CODEY_PORTAL_PRINCIPAL_ID: identity.workspaceSubject,
      CODEY_PORTAL_USERNAME: identity.workspaceUsername };
    const cfg = { schema: 2, layout: "npm-codey-package", platform, ready: true,
      kind: platform === "windows-x64" ? "codey-windows-oneclick" : "codey-macos-oneclick",
      ownerHome: home, codeyDirectory: app, nodeId: identity.nodeId, portalOrigin: setup.portalOrigin,
      identityFile: path.join(ownerHome, "identity.json"), setupFile: path.join(ownerHome, "setup.json"),
      environment, services: { codey: { environment } } };
    const file = path.join(ownerHome, "runtime.json");
    await save(cfg.identityFile, identity);
    await save(cfg.setupFile, setup);
    await save(file, cfg);
    const destination = path.join(ownerHome, "bootstrap");
    await prepareUpdater(file, destination, { platform });
    const config = JSON.parse(await readFile(path.join(destination, "config.json")));
    assert.equal(config.credential, identity.updaterCredential);
    assert.equal(config.ownerId, identity.workspaceSubject);
    assert.equal(config.platform, platform);
    assert.equal(config.releasePublicKey, key);
    assert.equal(config.minimumSequence, 0);
    const source = path.join(app, "updater/native", platform);
    assert.deepEqual(await readFile(path.join(destination, "agent-files.json")), await readFile(path.join(source, "agent-files.json")));
    await assert.rejects(readFile(path.join(source, "config.json")), { code: "ENOENT" }, "Packages cannot carry a machine credential");
    const saved = { ...config, credential: randomBytes(32).toString("base64url"), minimumSequence: 17 };
    const existing = path.join(home, ".config/codey-updater/config.json");
    await save(existing, saved);
    await prepareUpdater(file, path.join(ownerHome, "retry"), { platform });
    assert.deepEqual(JSON.parse(await readFile(path.join(ownerHome, "retry/config.json"))), saved,
      "Do not rotate an already enrolled credential or reset the anti-downgrade floor");
    await save(existing, { ...saved, ownerId: "another-owner" });
    await assert.rejects(prepareUpdater(file, path.join(ownerHome, "wrong-owner"), { platform }));
    await rm(existing);
  }
});
