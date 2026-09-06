import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig, saveConfig, validateConfig } from "../src/config.mjs";
import {
  NodeProvisioner,
  provisionerInternals,
  validateProvisionInput,
} from "../src/provisioner.mjs";

function config() {
  return validateConfig({
    nodes: [
      {
        id: "jpe2",
        name: "Japan East 2",
        endpoint: "https://jpe2.example/usage",
        management: {
          transport: "ssh",
          sshHost: "jpe2",
          runtimeBin: "/home/zhn/.local/bin",
          copilotApi: "systemd-user",
          codexCli: "npm-global",
        },
      },
    ],
  });
}

test("provision input accepts only structured node and SSH identifiers", () => {
  const value = validateProvisionInput(
    {
      id: "zhn-a100",
      name: "ZHN A100",
      region: "Azure Japan East",
      sshHost: "zhn-a100",
      templateNodeId: "jpe2",
    },
    config(),
  );
  assert.equal(value.id, "zhn-a100");
  assert.equal(value.templateNode.id, "jpe2");

  assert.throws(
    () => validateProvisionInput(
      {
        id: "bad",
        name: "Bad",
        sshHost: "host; touch /tmp/bad",
        templateNodeId: "jpe2",
      },
      config(),
    ),
    /SSH Host/,
  );
  assert.throws(
    () => validateProvisionInput(
      {
        id: "jpe2",
        name: "Duplicate",
        sshHost: "duplicate",
        templateNodeId: "jpe2",
      },
      config(),
    ),
    /已存在/,
  );
});

test("managed package and endpoint normalization are deterministic", () => {
  assert.equal(
    provisionerInternals.parsePackageVersion("copilot-api-2.1.6-reasoning-effort.tgz"),
    "2.1.6",
  );
  assert.equal(provisionerInternals.parsePackageVersion("other.tgz"), null);
  assert.equal(
    provisionerInternals.normalizeEndpoint("", "node.example.com"),
    "http://node.example.com:4141/usage",
  );
  assert.equal(
    provisionerInternals.normalizeEndpoint("https://node.example.com", "ignored"),
    "https://node.example.com/usage",
  );
});

test("normalized runtime config can be persisted and loaded again", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-portal-config-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, "nodes.json");
  const value = config();
  await saveConfig(configPath, value);
  const loaded = await loadConfig(configPath);
  assert.equal(loaded.config.nodes[0].id, "jpe2");
  assert.equal(loaded.config.nodes[0].management.runtimeBin, "/home/zhn/.local/bin");
});

test("prepared Windows nodes can be registered without copying credentials", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "windows-node-register-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, "nodes.json");
  const secretRoot = path.join(directory, "keys");
  await saveConfig(configPath, config());
  const calls = [];
  const runCommand = async (command, args) => {
    calls.push({ command, args });
    if (command === "ssh" && args[0] === "-G") {
      return {
        code: 0,
        stdout: "hostname windows-node.example.com\nuser codex-user\n",
        stderr: "",
      };
    }
    const encoded = args.at(-1);
    const script = Buffer.from(encoded, "base64").toString("utf16le");
    if (script.includes("COPILOT_PACKAGE=")) {
      return {
        code: 0,
        stdout: [
          `HOME_B64=${Buffer.from("C:\\Users\\codex-user").toString("base64")}`,
          "HOSTNAME=WIN-CODEX",
          "NODE_VERSION=v22.21.0",
          "MANAGED_ID=",
          "COPILOT_PACKAGE=yes",
          "COPILOT_CONFIG=yes",
          "CODEX_CONFIG=yes",
          "MODELS_CONFIG=yes",
          "STARTUP_LAUNCHER=yes",
          "CHATGPT_APP=yes",
          "COPILOT_SERVICE=active",
        ].join("\n"),
        stderr: "",
      };
    }
    if (script.includes("API_KEY_B64=")) {
      return {
        code: 0,
        stdout: [
          `API_KEY_B64=${Buffer.from("windows-api-key").toString("base64")}`,
          `SESSION_KEY_B64=${Buffer.from("windows-session-key").toString("base64")}`,
        ].join("\n"),
        stderr: "",
      };
    }
    if (script.includes("registeredAt")) {
      return { code: 0, stdout: "", stderr: "" };
    }
    throw new Error(`unexpected Windows script: ${script.slice(0, 80)}`);
  };
  const fetchImpl = async (url, options) => {
    assert.equal(options.headers["x-api-key"], "windows-api-key");
    return Response.json(
      String(url).includes("token-usage/events") ? { items: [] } : { ok: true },
    );
  };
  const provisioner = new NodeProvisioner(config(), {
    configPath,
    fetchImpl,
    runCommand,
    secretRoot,
  });

  const result = await provisioner.provision({
    platform: "windows",
    id: "win-node",
    name: "Windows Node",
    region: "Office",
    sshHost: "win-node",
    endpoint: "",
    accent: "#60a5fa",
  });

  assert.equal(result.ok, true);
  assert.equal(result.verification.platform, "windows");
  const saved = await loadConfig(configPath);
  const node = saved.config.nodes.find((item) => item.id === "win-node");
  assert.equal(node.management.transport, "windows-ssh");
  assert.equal(node.management.copilotApi, "windows-startup");
  assert.equal(node.management.codexCli, "desktop-managed");
  assert.equal(node.endpoint, "http://windows-node.example.com:4141/usage");
  assert.equal((await readFile(node.apiKeyFile, "utf8")).trim(), "windows-api-key");
  assert.equal(
    (await readFile(node.management.sessionApiKeyFile, "utf8")).trim(),
    "windows-session-key",
  );
  assert.equal(
    calls.some((call) => call.args.includes("powershell.exe")),
    true,
  );
});
