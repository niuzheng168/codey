import test from "node:test";
import assert from "node:assert/strict";
import { validateConfig } from "../src/config.mjs";
import { NodeManager } from "../src/node-manager.mjs";

const artifact = {
  id: "copilot-api-2.1.11-2026-08-15-zhn",
  version: "2.1.11",
  buildDate: "2026-08-15",
  label: "zhn",
  fileName: "copilot-api-2.1.11-2026-08-15-zhn.tgzz",
  path: "Q:\\artifacts\\copilot-api-2.1.11.tgzz",
  sizeBytes: 1234,
  sha256: "a".repeat(64),
  changelog: "daily build",
};

function config() {
  return validateConfig({
    updateTimeoutMs: 180000,
    nodes: [
      {
        id: "remote",
        name: "Remote",
        endpoint: "https://remote.test/usage",
        management: {
          transport: "ssh",
          sshHost: "remote",
          runtimeBin: "/home/user/.local/bin",
          copilotApi: "systemd-user",
          codexCli: "npm-global",
        },
      },
    ],
  });
}

test("node manager deploys only the selected catalog artifact", async () => {
  const calls = [];
  const artifactCatalog = {
    async scan() {
      const { path: _path, ...publicArtifact } = artifact;
      return { artifacts: [publicArtifact], errors: [] };
    },
    async resolve(id) {
      assert.equal(id, artifact.id);
      return artifact;
    },
  };
  const runCommand = async (command, args, options = {}) => {
    calls.push({ command, args, input: options.input ?? "" });
    if (
      command === "ssh" &&
      args.includes("npm") &&
      args.includes("@openai/codex@latest")
    ) {
      return { code: 0, stdout: "0.147.0\n", stderr: "" };
    }
    if (options.input?.includes("COPILOT_BUILD_ID")) {
      return {
        code: 0,
        stdout: [
          "COPILOT_VERSION=2.1.11",
          `COPILOT_BUILD_ID=${artifact.id}`,
          "COPILOT_BUILD_DATE=2026-08-15",
          "COPILOT_BUILD_LABEL=zhn",
          "CODEX_VERSION=0.147.0",
          "COPILOT_SERVICE=active",
        ].join("\n"),
        stderr: "",
      };
    }
    if (options.input?.includes("CODEX_ARTIFACT_OK")) {
      return {
        code: 0,
        stdout: [
          "PREVIOUS_VERSION=2.1.8",
          "COPILOT_VERSION=2.1.11",
          `ARTIFACT_ID=${artifact.id}`,
          "COPILOT_SERVICE=active",
          "CODEX_CHECK=CODEX_ARTIFACT_OK",
        ].join("\n"),
        stderr: "",
      };
    }
    return { code: 0, stdout: "", stderr: "" };
  };

  const manager = new NodeManager(config(), { artifactCatalog, runCommand });
  const result = await manager.update("remote", "copilot-api", {
    artifactId: artifact.id,
  });

  assert.equal(result.ok, true);
  assert.equal(result.artifact.id, artifact.id);
  assert.equal(result.status.copilotApi.currentBuildId, artifact.id);
  const scp = calls.find((call) => call.command === "scp");
  assert.equal(scp.args.includes(artifact.path), true);
  assert.equal(
    scp.args.includes(
      `remote:.local/share/copilot-api/portal-updates/${artifact.id}-${artifact.sha256.slice(0, 12)}/copilot-api.tgz`,
    ),
    true,
  );
  const install = calls.find((call) => call.input.includes("CODEX_ARTIFACT_OK"));
  assert.equal(
    install.args.includes(`PORTAL_ARTIFACT_ID=${artifact.id}`),
    true,
  );
  assert.equal(
    install.args.includes(`PORTAL_PACKAGE_SHA256=${artifact.sha256}`),
    true,
  );
});

test("node manager starts a remote Copilot API user service", async () => {
  const calls = [];
  const artifactCatalog = {
    async scan() {
      const { path: _path, ...publicArtifact } = artifact;
      return { artifacts: [publicArtifact], errors: [] };
    },
  };
  const runCommand = async (command, args, options = {}) => {
    calls.push({ command, args, input: options.input ?? "" });
    if (options.input?.includes("systemctl --user start copilot-api.service")) {
      return {
        code: 0,
        stdout: "COPILOT_SERVICE=active\n",
        stderr: "",
      };
    }
    if (options.input?.includes("COPILOT_BUILD_ID")) {
      return {
        code: 0,
        stdout: [
          "COPILOT_VERSION=2.1.11",
          `COPILOT_BUILD_ID=${artifact.id}`,
          "COPILOT_BUILD_DATE=2026-08-15",
          "COPILOT_BUILD_LABEL=zhn",
          "CODEX_VERSION=0.147.0",
          "COPILOT_SERVICE=active",
        ].join("\n"),
        stderr: "",
      };
    }
    if (args.includes("@openai/codex@latest")) {
      return { code: 0, stdout: "0.147.0\n", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };

  const manager = new NodeManager(config(), { artifactCatalog, runCommand });
  const result = await manager.startCopilotApi("remote");

  assert.equal(result.ok, true);
  assert.equal(result.status.copilotApi.service, "active");
  assert.equal(result.status.copilotApi.canStart, true);
  assert.equal(
    calls.some((call) =>
      call.input.includes("systemctl --user start copilot-api.service"),
    ),
    true,
  );
});

test("node manager starts the local proxy from a verified artifact", async () => {
  const calls = [];
  const localConfig = validateConfig({
    updateTimeoutMs: 180000,
    nodes: [
      {
        id: "local",
        name: "Local",
        endpoint: "http://127.0.0.1:4141/usage",
        management: {
          transport: "local",
          sessionRoot: "C:\\Users\\test\\.codex\\sessions",
          copilotApi: "none",
          codexCli: "desktop-managed",
        },
      },
    ],
  });
  const artifactCatalog = {
    async scan() {
      const { path: _path, ...publicArtifact } = artifact;
      return { artifacts: [publicArtifact], errors: [] };
    },
    async resolve(id) {
      assert.equal(id, artifact.id);
      return artifact;
    },
  };
  const runCommand = async (command, args, options = {}) => {
    calls.push({ command, args, options });
    const script = String(args.at(-1) ?? "");
    if (command === "npm.cmd") {
      return { code: 0, stdout: "0.147.0\n", stderr: "" };
    }
    if (script.includes("CODEX_PORTAL_PACKAGE_PATH")) {
      return {
        code: 0,
        stdout: '{"status":"active","processId":1234}\n',
        stderr: "",
      };
    }
    if (script.includes("Get-CimInstance Win32_Process")) {
      return {
        code: 0,
        stdout: JSON.stringify({
          copilotVersion: "2.1.11",
          copilotService: "active",
          codexVersion: "0.147.0",
        }),
        stderr: "",
      };
    }
    return { code: 0, stdout: "", stderr: "" };
  };

  const manager = new NodeManager(localConfig, {
    artifactCatalog,
    platform: "win32",
    runCommand,
  });
  const result = await manager.startCopilotApi("local");

  assert.equal(result.ok, true);
  assert.equal(result.artifact.id, artifact.id);
  assert.equal(result.status.copilotApi.service, "active");
  assert.equal(result.status.copilotApi.canStart, true);
  const startCall = calls.find(
    (call) =>
      call.options?.spawnOptions?.env?.CODEX_PORTAL_PACKAGE_PATH ===
      artifact.path,
  );
  assert.equal(
    startCall.options.spawnOptions.env.CODEX_PORTAL_PACKAGE_PATH,
    artifact.path,
  );
  assert.equal(
    startCall.options.spawnOptions.env.CODEX_PORTAL_FORCE_RESTART,
    "false",
  );
  assert.equal(startCall.args.length, 5);
  assert.equal(startCall.args.at(-1).includes("CopilotApiForCodex"), true);

  const update = await manager.update("local", "copilot-api", {
    artifactId: artifact.id,
  });
  assert.equal(update.ok, true);
  const deployCall = calls
    .filter(
      (call) =>
        call.options?.spawnOptions?.env?.CODEX_PORTAL_PACKAGE_PATH ===
        artifact.path,
    )
    .at(-1);
  assert.equal(
    deployCall.options.spawnOptions.env.CODEX_PORTAL_FORCE_RESTART,
    "true",
  );
});

test("node manager deploys one artifact across the managed fleet", async () => {
  let installed = false;
  const calls = [];
  const artifactCatalog = {
    async scan() {
      const { path: _path, ...publicArtifact } = artifact;
      return { artifacts: [publicArtifact], errors: [] };
    },
    async resolve(id) {
      assert.equal(id, artifact.id);
      return artifact;
    },
  };
  const runCommand = async (command, args, options = {}) => {
    calls.push({ command, args, input: options.input ?? "" });
    if (args.includes("@openai/codex@latest")) {
      return { code: 0, stdout: "0.147.0\n", stderr: "" };
    }
    if (options.input?.includes("CODEX_ARTIFACT_OK")) {
      installed = true;
      return {
        code: 0,
        stdout: [
          "PREVIOUS_VERSION=2.1.8",
          "COPILOT_VERSION=2.1.11",
          `ARTIFACT_ID=${artifact.id}`,
          "COPILOT_SERVICE=active",
          "CODEX_CHECK=CODEX_ARTIFACT_OK",
        ].join("\n"),
        stderr: "",
      };
    }
    if (options.input?.includes("COPILOT_BUILD_ID")) {
      return {
        code: 0,
        stdout: [
          "COPILOT_VERSION=2.1.11",
          `COPILOT_BUILD_ID=${installed ? artifact.id : "previous-build"}`,
          "COPILOT_BUILD_DATE=2026-08-15",
          "COPILOT_BUILD_LABEL=zhn",
          "CODEX_VERSION=0.147.0",
          "COPILOT_SERVICE=active",
        ].join("\n"),
        stderr: "",
      };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  const manager = new NodeManager(config(), { artifactCatalog, runCommand });

  const result = await manager.deployCopilotArtifactToAll(artifact.id);

  assert.equal(result.requested, 1);
  assert.equal(result.deployed, 1);
  assert.equal(result.skipped, 0);
  assert.equal(result.failed, 0);
  assert.equal(result.results[0].nodeId, "remote");
  assert.equal(
    calls.some((call) => call.input.includes("CODEX_ARTIFACT_OK")),
    true,
  );
});

test("node manager reads and starts a prepared Windows SSH node", async () => {
  const windowsConfig = validateConfig({
    nodes: [
      {
        id: "windows",
        name: "Windows",
        endpoint: "http://windows.test:4141/usage",
        apiKeyFile: "C:\\secure\\windows.api.key",
        management: {
          transport: "windows-ssh",
          sshHost: "windows-alias",
          sessionApiKeyFile: "C:\\secure\\windows.session.key",
          copilotApi: "windows-startup",
          codexCli: "desktop-managed",
        },
      },
    ],
  });
  const calls = [];
  const runCommand = async (command, args) => {
    calls.push({ command, args });
    if (command === "npm.cmd") {
      return { code: 0, stdout: "0.151.0\n", stderr: "" };
    }
    const script = Buffer.from(args.at(-1), "base64").toString("utf16le");
    if (script.includes("COPILOT_BUILD_ID=")) {
      return {
        code: 0,
        stdout: [
          "COPILOT_VERSION=2.3.9",
          `COPILOT_BUILD_ID=${artifact.id}`,
          "COPILOT_BUILD_DATE=2026-08-29",
          "COPILOT_BUILD_LABEL=zhn",
          "CODEX_VERSION=26.810.7004.0",
          "COPILOT_SERVICE=active",
        ].join("\n"),
        stderr: "",
      };
    }
    if (script.includes("Windows Copilot API did not become ready")) {
      return {
        code: 0,
        stdout: "COPILOT_SERVICE=active\n",
        stderr: "",
      };
    }
    throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
  };
  const manager = new NodeManager(windowsConfig, {
    artifactCatalog: {
      async scan() {
        const { path: _path, ...publicArtifact } = artifact;
        return { artifacts: [publicArtifact], errors: [] };
      },
    },
    platform: "win32",
    runCommand,
  });

  const status = await manager.status(["windows"]);
  assert.equal(status.nodes[0].copilotApi.currentVersion, "2.3.9");
  assert.equal(status.nodes[0].copilotApi.canStart, true);
  assert.equal(status.nodes[0].copilotApi.canDeploy, false);
  assert.equal(status.nodes[0].codexCli.mode, "desktop-managed");

  const started = await manager.startCopilotApi("windows");
  assert.equal(started.ok, true);
  assert.equal(started.status.copilotApi.service, "active");
  assert.equal(
    calls.filter((call) => call.args.includes("powershell.exe")).length >= 3,
    true,
  );
});
