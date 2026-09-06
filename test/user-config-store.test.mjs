import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { UserConfigStore } from "../src/user-config-store.mjs";

const tenantId = "tenant";
const principalId = "seed-user";

function config(clientNodes) {
  return {
    clientNodes,
    nodes: [],
  };
}

test("seed user endpoints are reconciled without replacing custom nodes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codey-user-config-"));
  try {
    const oldSeed = {
      id: "zhn-a100",
      name: "ZHN A100",
      region: "Azure Japan East",
      endpoint: "http://127.0.0.1:4246/usage",
      accent: "#60a5fa",
    };
    const newSeed = {
      ...oldSeed,
      endpoint: "https://zhn-a100.example.test:8443/usage",
    };
    const custom = {
      id: "custom",
      name: "Custom",
      region: "",
      endpoint: "https://custom.example.test/usage",
      accent: "#8b5cf6",
    };
    const store = new UserConfigStore(root, {
      tenantId,
      seedPrincipalId: principalId,
      seedConfig: config([newSeed]),
    });
    await store.load(principalId);
    const [ownerDirectory] = await readdir(root);
    const configPath = path.join(root, ownerDirectory, "nodes.json");
    await writeFile(
      configPath,
      `${JSON.stringify(config([oldSeed, custom]), null, 2)}\n`,
    );

    const loaded = await store.load(principalId);
    assert.equal(
      loaded.config.clientNodes.find((node) => node.id === "zhn-a100").endpoint,
      newSeed.endpoint,
    );
    assert.equal(
      loaded.config.clientNodes.find((node) => node.id === "custom").endpoint,
      custom.endpoint,
    );
    const persisted = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(persisted.clientNodes[0].endpoint, newSeed.endpoint);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("seed reconciliation does not add a default node the user removed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codey-user-config-"));
  try {
    const seedNode = {
      id: "zhn-a100",
      name: "ZHN A100",
      region: "Azure Japan East",
      endpoint: "https://zhn-a100.example.test:8443/usage",
      accent: "#60a5fa",
    };
    const store = new UserConfigStore(root, {
      tenantId,
      seedPrincipalId: principalId,
      seedConfig: config([seedNode]),
    });
    const initial = await store.load(principalId);
    await writeFile(
      initial.configPath,
      `${JSON.stringify(config([]), null, 2)}\n`,
    );
    const loaded = await store.load(principalId);
    assert.deepEqual(loaded.config.clientNodes, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local relay endpoint migrates to built-in HTTPS without changing other users", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codey-local-https-"));
  try {
    const oldLocal = {
      id: "local",
      name: "Local",
      endpoint: "http://127.0.0.1:4242/usage",
      accent: "#8b5cf6",
    };
    const newLocal = {
      ...oldLocal,
      endpoint: "https://127.0.0.1:8443/usage",
    };
    const store = new UserConfigStore(root, {
      tenantId,
      seedPrincipalId: principalId,
      seedConfig: config([newLocal]),
    });
    const seed = await store.load(principalId);
    const other = await store.load("other-user");
    await writeFile(seed.configPath, JSON.stringify(config([oldLocal])));
    await writeFile(other.configPath, JSON.stringify(config([oldLocal])));

    const migrated = await store.load(principalId);
    assert.equal(migrated.config.clientNodes[0].endpoint, newLocal.endpoint);
    assert.equal(
      JSON.parse(await readFile(seed.configPath, "utf8")).clientNodes[0].endpoint,
      newLocal.endpoint,
    );
    assert.equal(
      (await store.load("other-user")).config.clientNodes[0].endpoint,
      oldLocal.endpoint,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
