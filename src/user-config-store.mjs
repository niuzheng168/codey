import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { validateConfig } from "./config.mjs";

function ownerKey(tenantId, principalId) {
  return createHash("sha256")
    .update(`${tenantId.trim().toLowerCase()}:${principalId.trim().toLowerCase()}`)
    .digest("hex");
}

function reconcileSeedClientNodes(config, seedConfig) {
  if (!seedConfig?.clientNodes?.length || !config.clientNodes.length) {
    return config;
  }
  const seedNodes = new Map(seedConfig.clientNodes.map((node) => [node.id, node]));
  let changed = false;
  const clientNodes = config.clientNodes.map((node) => {
    const seedNode = seedNodes.get(node.id);
    if (
      !seedNode ||
      ["id", "name", "region", "endpoint", "accent"].every(
        (key) => node[key] === seedNode[key],
      )
    ) {
      return node;
    }
    changed = true;
    return seedNode;
  });
  return changed ? validateConfig({ ...config, clientNodes }) : config;
}

export class UserConfigStore {
  constructor(root, options = {}) {
    this.root = path.resolve(root);
    this.tenantId = String(options.tenantId ?? "").trim();
    this.seedPrincipalId = String(options.seedPrincipalId ?? "").trim().toLowerCase();
    this.seedConfig = options.seedConfig;
  }

  async load(principalId) {
    principalId = String(principalId ?? "").trim().toLowerCase();
    if (!principalId) throw new Error("Authenticated principal is unavailable");
    const directory = path.join(this.root, ownerKey(this.tenantId, principalId));
    const configPath = path.join(directory, "nodes.json");
    try {
      const raw = JSON.parse(await readFile(configPath, "utf8"));
      let config = validateConfig(raw);
      if (
        principalId === this.seedPrincipalId &&
        !Object.hasOwn(raw, "clientNodes") &&
        this.seedConfig?.clientNodes?.length
      ) {
        config = validateConfig({
          ...config,
          clientNodes: this.seedConfig.clientNodes,
        });
        await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, {
          encoding: "utf8",
          mode: 0o600,
        });
      } else if (principalId === this.seedPrincipalId) {
        const reconciled = reconcileSeedClientNodes(config, this.seedConfig);
        if (reconciled !== config) {
          config = reconciled;
          await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, {
            encoding: "utf8",
            mode: 0o600,
          });
        }
      }
      return {
        config,
        configPath,
      };
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const initial =
      principalId === this.seedPrincipalId && this.seedConfig
        ? this.seedConfig
        : validateConfig({ nodes: [] });
    await mkdir(directory, { recursive: true });
    await writeFile(configPath, `${JSON.stringify(initial, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    }).catch((error) => {
      if (error?.code !== "EEXIST") throw error;
    });
    return {
      config: validateConfig(JSON.parse(await readFile(configPath, "utf8"))),
      configPath,
    };
  }
}
