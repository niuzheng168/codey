import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PROJECT_ROOT, saveConfig, validateConfig } from "./config.mjs";
import { deriveEndpointUrl } from "./metrics.mjs";

const SSH_HOST_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,252}[a-z0-9])?$/i;
const NODE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;
const POSIX_PATH_PATTERN = /^\/[a-zA-Z0-9._/+:-]+$/;
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const DEFAULT_ACCENT = "#60a5fa";

const WINDOWS_TARGET_PROBE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$node = Get-Command node.exe -ErrorAction Stop
$npm = Get-Command npm.cmd -ErrorAction Stop
$nodeMajor = [int]((& $node.Source -p 'process.versions.node.split(".")[0]').Trim())
if ($nodeMajor -lt 20) {
  throw "Node.js 20 or newer is required."
}
$npmRoot = (& $npm.Source root --global).Trim()
$packageJson = Join-Path $npmRoot '@jeffreycao\copilot-api\package.json'
$proxyConfig = Join-Path $HOME '.local\share\copilot-api\config.json'
$codexConfig = Join-Path $HOME '.codex\config.toml'
$models = Join-Path $HOME '.codex\models.json'
$launcher = Join-Path $env:LOCALAPPDATA 'CodexWorkstation\start-copilot-api.ps1'
$markerPath = Join-Path $HOME '.local\share\codex-portal\node.json'
$managedId = ''
if (Test-Path -LiteralPath $markerPath) {
  $managedId = (Get-Content -Raw -LiteralPath $markerPath | ConvertFrom-Json).id
}
$app = Get-AppxPackage -Name 'OpenAI.Codex' | Select-Object -First 1
$listener = Get-NetTCPConnection -LocalPort 4141 -State Listen -ErrorAction SilentlyContinue
Write-Output ('HOME_B64=' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($HOME)))
Write-Output ('HOSTNAME=' + $env:COMPUTERNAME)
Write-Output ('NODE_VERSION=' + (& $node.Source --version))
Write-Output ('MANAGED_ID=' + $managedId)
Write-Output ('COPILOT_PACKAGE=' + $(if (Test-Path -LiteralPath $packageJson) { 'yes' } else { 'no' }))
Write-Output ('COPILOT_CONFIG=' + $(if (Test-Path -LiteralPath $proxyConfig) { 'yes' } else { 'no' }))
Write-Output ('CODEX_CONFIG=' + $(if (Test-Path -LiteralPath $codexConfig) { 'yes' } else { 'no' }))
Write-Output ('MODELS_CONFIG=' + $(if (Test-Path -LiteralPath $models) { 'yes' } else { 'no' }))
Write-Output ('STARTUP_LAUNCHER=' + $(if (Test-Path -LiteralPath $launcher) { 'yes' } else { 'no' }))
Write-Output ('CHATGPT_APP=' + $(if ($app) { 'yes' } else { 'no' }))
Write-Output ('COPILOT_SERVICE=' + $(if ($listener) { 'active' } else { 'inactive' }))
`;

const WINDOWS_TARGET_KEYS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$configPath = Join-Path $HOME '.local\share\copilot-api\config.json'
$config = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
$apiKey = [string]$config.auth.apiKeys[0]
$sessionKey = [string]$config.auth.sessionHistoryApiKey
if (-not $apiKey -or -not $sessionKey) {
  throw 'Windows bootstrap API keys are missing.'
}
Write-Output ('API_KEY_B64=' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($apiKey)))
Write-Output ('SESSION_KEY_B64=' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($sessionKey)))
`;

const TARGET_PROBE_SCRIPT = String.raw`
set -euo pipefail
command -v node >/dev/null
command -v npm >/dev/null
command -v systemctl >/dev/null
command -v curl >/dev/null

node_major="$(node -p 'Number(process.versions.node.split(".")[0])')"
if [ "$node_major" -lt 20 ]; then
  printf 'Node.js 20 or newer is required; found %s.\n' "$(node --version)" >&2
  exit 1
fi

npm_prefix="$(npm config get prefix)"
case "$npm_prefix" in
  /*) ;;
  *) printf 'npm global prefix must be absolute: %s\n' "$npm_prefix" >&2; exit 1 ;;
esac

managed_id=""
marker="$HOME/.local/share/codex-portal/node.json"
if [ -f "$marker" ]; then
  managed_id="$(node -e 'const fs=require("fs");const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(String(j.id||""))' "$marker" 2>/dev/null || true)"
fi

printf 'HOME=%s\n' "$HOME"
printf 'HOSTNAME=%s\n' "$(hostname -f 2>/dev/null || hostname)"
printf 'NPM_PREFIX=%s\n' "$npm_prefix"
printf 'RUNTIME_BIN=%s/bin\n' "$npm_prefix"
printf 'NODE_VERSION=%s\n' "$(node --version)"
printf 'SYSTEMD_USER=%s\n' "$(systemctl --user show-environment >/dev/null 2>&1 && echo yes || echo no)"
printf 'LINGER=%s\n' "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null || true)"
printf 'MANAGED_ID=%s\n' "$managed_id"
printf 'EXISTING_SERVICE=%s\n' "$([ -f "$HOME/.config/systemd/user/copilot-api.service" ] && echo yes || echo no)"
printf 'EXISTING_COPILOT_CONFIG=%s\n' "$([ -f "$HOME/.local/share/copilot-api/config.json" ] && echo yes || echo no)"
printf 'EXISTING_CODEX_CONFIG=%s\n' "$([ -f "$HOME/.codex/config.toml" ] && echo yes || echo no)"
printf 'EXISTING_CODEX_BIN=%s\n' "$(command -v codex >/dev/null 2>&1 && echo yes || echo no)"
`;

const TEMPLATE_PROBE_SCRIPT = String.raw`
set -euo pipefail
for file in \
  "$HOME/.local/share/copilot-api/config.json" \
  "$HOME/.local/share/copilot-api/github_token" \
  "$HOME/.codex/config.toml" \
  "$HOME/.codex/models.json"; do
  if [ ! -f "$file" ]; then
    printf 'Template file is missing: %s\n' "$file" >&2
    exit 1
  fi
done
printf 'HOME=%s\n' "$HOME"
`;

const PREPARE_STAGE_SCRIPT = String.raw`
set -euo pipefail
case "$PORTAL_STAGE" in
  "$HOME"/.local/share/codex-portal/staging/*) ;;
  *) printf 'Unsafe staging path.\n' >&2; exit 1 ;;
esac
mkdir -p "$PORTAL_STAGE"
chmod 700 "$HOME/.local/share/codex-portal" "$HOME/.local/share/codex-portal/staging" "$PORTAL_STAGE"
`;

const CLEAN_STAGE_SCRIPT = String.raw`
set -u
case "$PORTAL_STAGE" in
  "$HOME"/.local/share/codex-portal/staging/*) ;;
  *) exit 0 ;;
esac
rm -f \
  "$PORTAL_STAGE/copilot-api.tgz" \
  "$PORTAL_STAGE/copilot-config.json" \
  "$PORTAL_STAGE/github_token" \
  "$PORTAL_STAGE/codex-config.toml" \
  "$PORTAL_STAGE/codex-models.json"
rmdir "$PORTAL_STAGE" 2>/dev/null || true
`;

const PROVISION_SCRIPT = String.raw`
set -euo pipefail

case "$PORTAL_NODE_ID" in
  *[!a-z0-9_-]*|"") printf 'Invalid node id.\n' >&2; exit 1 ;;
esac
case "$PORTAL_STAGE" in
  "$HOME"/.local/share/codex-portal/staging/*) ;;
  *) printf 'Unsafe staging path.\n' >&2; exit 1 ;;
esac

npm_prefix="$(npm config get prefix)"
runtime_bin="$npm_prefix/bin"
export PATH="$runtime_bin:/usr/local/bin:/usr/bin:/bin:/snap/bin:$PATH"
package_file="$PORTAL_STAGE/copilot-api.tgz"

actual_sha="$(sha256sum "$package_file" | awk '{print $1}')"
if [ "$actual_sha" != "$PORTAL_PACKAGE_SHA256" ]; then
  printf 'Package checksum mismatch.\n' >&2
  exit 1
fi

mkdir -p \
  "$npm_prefix" \
  "$HOME/.local/bin" \
  "$HOME/.local/share/copilot-api" \
  "$HOME/.local/share/codex-portal" \
  "$HOME/.config/codex-portal" \
  "$HOME/.config/systemd/user" \
  "$HOME/.codex"

npm install --global "$package_file"
npm install --global "@openai/codex@latest"

copilot_root="$(npm root --global)/@jeffreycao/copilot-api"
copilot_version="$(node -p 'require(process.argv[1]).version' "$copilot_root/package.json")"
if [ "$copilot_version" != "$PORTAL_PACKAGE_VERSION" ]; then
  printf 'Expected copilot-api %s, found %s.\n' "$PORTAL_PACKAGE_VERSION" "$copilot_version" >&2
  exit 1
fi
grep -Rqs 'invalid-encrypted-content' "$copilot_root/dist"
grep -Rqs 'reasoning_effort TEXT' "$copilot_root/dist"

install -m 600 "$PORTAL_STAGE/copilot-config.json" "$HOME/.local/share/copilot-api/config.json"
install -m 600 "$PORTAL_STAGE/github_token" "$HOME/.local/share/copilot-api/github_token"
install -m 600 "$PORTAL_STAGE/codex-config.toml" "$HOME/.codex/config.toml"
install -m 644 "$PORTAL_STAGE/codex-models.json" "$HOME/.codex/models.json"

node - <<'NODE'
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const home = process.env.HOME;
const proxyConfigPath = path.join(home, ".local/share/copilot-api/config.json");
const proxyConfig = JSON.parse(fs.readFileSync(proxyConfigPath, "utf8"));
proxyConfig.auth = proxyConfig.auth && typeof proxyConfig.auth === "object"
  ? proxyConfig.auth
  : {};
proxyConfig.auth.apiKeys = [];
proxyConfig.auth.adminApiKey = crypto.randomBytes(32).toString("hex");
fs.writeFileSync(proxyConfigPath, JSON.stringify(proxyConfig, null, 2) + "\n", { mode: 0o600 });

const codexConfigPath = path.join(home, ".codex/config.toml");
let codexConfig = fs.readFileSync(codexConfigPath, "utf8");
codexConfig = codexConfig
  .replace(/^base_url\s*=.*$/m, 'base_url = "http://localhost:4141"')
  .replace(
    /^model_catalog_json\s*=.*$/m,
    'model_catalog_json = "' + path.join(home, ".codex/models.json").replaceAll("\\", "\\\\") + '"',
  );
const keptLines = [];
let skipSection = false;
for (const line of codexConfig.split(/\r?\n/)) {
  const section = line.match(/^\[([^\]]+)\]$/)?.[1] ?? null;
  if (section) {
    skipSection =
      section === "mcp_servers.session_share" ||
      section.startsWith("projects.") ||
      section.startsWith("marketplaces.") ||
      section.startsWith("plugins.");
  }
  if (!skipSection) keptLines.push(line);
}
codexConfig = keptLines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
fs.writeFileSync(codexConfigPath, codexConfig, { mode: 0o600 });
NODE

cat > "$HOME/.config/codex-portal/env.sh" <<EOF
export PATH="$runtime_bin:\$HOME/.local/bin:\$PATH"
export GITHUB_COPILOT_API_KEY="local-copilot-api"
EOF
chmod 600 "$HOME/.config/codex-portal/env.sh"

ensure_shell_source() {
  file="$1"
  marker="# codex-portal managed environment"
  touch "$file"
  if ! grep -Fq "$marker" "$file"; then
    cat >> "$file" <<'EOF'

# codex-portal managed environment
[ -f "$HOME/.config/codex-portal/env.sh" ] && . "$HOME/.config/codex-portal/env.sh"
EOF
  fi
}
ensure_shell_source "$HOME/.profile"
ensure_shell_source "$HOME/.bashrc"

cat > "$HOME/.local/bin/copilot-api-update" <<EOF
#!/usr/bin/env bash
set -euo pipefail
export PATH="$runtime_bin:/usr/local/bin:/usr/bin:/bin:/snap/bin"
package_name="@jeffreycao/copilot-api"
package_json="\$(npm root --global)/\${package_name}/package.json"
portal_build="\$HOME/.local/share/copilot-api/portal-build.json"
if [ -f "\$portal_build" ] && node -e \
  'const fs=require("fs");const value=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.exit(value.artifactId?0:1)' \
  "\$portal_build"; then
  printf 'Copilot API is pinned to a Portal-selected build; update it from the Portal.\n'
  exit 0
fi
installed="\$(node -p 'require(process.argv[1]).version' "\$package_json")"
latest="\$(npm view "\${package_name}@latest" version --silent --registry=https://registry.npmjs.org)"
if [[ ! "\$latest" =~ ^[0-9A-Za-z][0-9A-Za-z.+-]*\$ ]]; then
  printf 'Unable to determine a valid latest copilot-api version.\n' >&2
  exit 1
fi
if [ "\$installed" = "\$latest" ]; then
  printf 'Copilot API is already current (%s).\n' "\$installed"
  exit 0
fi

tmp="\$(mktemp -d)"
trap 'rm -rf "\$tmp"' EXIT
npm pack "\${package_name}@\${latest}" --pack-destination "\$tmp" --silent >/dev/null
tarball="\$(find "\$tmp" -maxdepth 1 -type f -name '*.tgz' -print -quit)"
server_entry="\$(tar -tf "\$tarball" | grep -E '^package/dist/server-.*\\.js$' | head -1)"
tar -xOf "\$tarball" "\$server_entry" > "\$tmp/server.js"
if ! grep -q 'invalid-encrypted-content' "\$tmp/server.js" \
  || ! grep -q 'reasoning_effort TEXT' "\$tmp/server.js"; then
  printf 'Deferring %s: published package lacks source-integrated resilience or reasoning usage support.\n' "\$latest"
  exit 0
fi

npm install --global "\$tarball"
updated="\$(node -p 'require(process.argv[1]).version' "\$package_json")"
if [ "\$updated" != "\$latest" ]; then
  printf 'Expected %s after update, found %s.\n' "\$latest" "\$updated" >&2
  exit 1
fi
systemctl --user restart copilot-api.service
for attempt in \$(seq 1 60); do
  if curl -fsS --max-time 2 http://127.0.0.1:4141/usage >/dev/null; then
    break
  fi
  sleep 1
  [ "\$attempt" -lt 60 ]
done
systemctl --user is-active --quiet copilot-api.service
printf 'Copilot API %s is active.\n' "\$updated"
EOF
chmod 755 "$HOME/.local/bin/copilot-api-update"

cat > "$HOME/.config/systemd/user/copilot-api.service" <<EOF
[Unit]
Description=Copilot API Proxy
Documentation=https://github.com/caozhiyuan/copilot-api
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
Environment=HOME=$HOME
Environment=PATH=$runtime_bin:/usr/local/bin:/usr/bin:/bin:/snap/bin
Environment=HOST=0.0.0.0
WorkingDirectory=$HOME
ExecStart=$runtime_bin/copilot-api start --port 4141
Restart=always
RestartSec=5s
TimeoutStopSec=30s

[Install]
WantedBy=default.target
EOF

cat > "$HOME/.config/systemd/user/copilot-api-update.service" <<EOF
[Unit]
Description=Update Copilot API Proxy
Documentation=https://github.com/caozhiyuan/copilot-api
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
Environment=HOME=$HOME
Environment=PATH=$runtime_bin:/usr/local/bin:/usr/bin:/bin:/snap/bin
ExecStart=$HOME/.local/bin/copilot-api-update
EOF

cat > "$HOME/.config/systemd/user/copilot-api-update.timer" <<'EOF'
[Unit]
Description=Check daily for Copilot API Proxy updates

[Timer]
OnCalendar=daily
Persistent=true
RandomizedDelaySec=30m
Unit=copilot-api-update.service

[Install]
WantedBy=timers.target
EOF

node - <<'NODE'
const fs = require("fs");
const path = require("path");
const marker = {
  id: process.env.PORTAL_NODE_ID,
  templateNodeId: process.env.PORTAL_TEMPLATE_NODE_ID,
  managedAt: new Date().toISOString(),
};
fs.writeFileSync(
  path.join(process.env.HOME, ".local/share/codex-portal/node.json"),
  JSON.stringify(marker, null, 2) + "\n",
  { mode: 0o600 },
);
NODE

if command -v loginctl >/dev/null && [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null || true)" != "yes" ]; then
  sudo -n loginctl enable-linger "$USER" 2>/dev/null || true
fi

systemctl --user daemon-reload
systemctl --user enable --now copilot-api.service
systemctl --user enable --now copilot-api-update.timer

for attempt in $(seq 1 60); do
  if curl -fsS --max-time 2 http://127.0.0.1:4141/usage >/dev/null; then
    break
  fi
  sleep 1
  [ "$attempt" -lt 60 ]
done
systemctl --user is-active --quiet copilot-api.service
systemctl --user is-enabled --quiet copilot-api-update.timer

codex_output="$(mktemp)"
if ! timeout 240 env GITHUB_COPILOT_API_KEY=local-copilot-api codex exec \
  --ephemeral \
  --skip-git-repo-check \
  --color never \
  'Do not use tools. Reply with exactly CODEX_PROVISION_OK' < /dev/null >"$codex_output" 2>&1; then
  tail -80 "$codex_output" >&2
  rm -f "$codex_output"
  exit 1
fi
grep -q CODEX_PROVISION_OK "$codex_output"
rm -f "$codex_output"

printf 'RUNTIME_BIN=%s\n' "$runtime_bin"
printf 'COPILOT_VERSION=%s\n' "$copilot_version"
printf 'CODEX_VERSION=%s\n' "$(codex --version | awk '{print $NF}')"
printf 'COPILOT_SERVICE=%s\n' "$(systemctl --user is-active copilot-api.service)"
printf 'UPDATE_TIMER=%s\n' "$(systemctl --user is-enabled copilot-api-update.timer)"
printf 'CODEX_CHECK=CODEX_PROVISION_OK\n'
`;

function requestError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  error.expose = true;
  return error;
}

function safeText(value, maximumLength) {
  return String(value ?? "").trim().slice(0, maximumLength);
}

function parseKeyValues(output) {
  const values = {};
  for (const line of String(output).split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator > 0) values[line.slice(0, separator)] = line.slice(separator + 1).trim();
  }
  return values;
}

function encodedPowerShell(script) {
  return Buffer.from(script, "utf16le").toString("base64");
}

function decodeBase64(value) {
  return Buffer.from(String(value ?? ""), "base64").toString("utf8");
}

function cleanMessage(value, maximumLength = 1800) {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim()
    .slice(-maximumLength);
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      ...options.spawnOptions,
    });
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    let settled = false;
    let timer;

    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    };
    const collect = (target) => (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) {
        child.kill();
        finish(new Error("命令输出超过安全上限"));
        return;
      }
      target.push(chunk);
    };

    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.once("error", (error) => finish(error));
    child.once("close", (code) => {
      const result = {
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (code !== 0) {
        const error = new Error(cleanMessage(result.stderr || result.stdout) || `命令退出码 ${code}`);
        error.result = result;
        finish(error);
      } else {
        finish(null, result);
      }
    });
    timer = setTimeout(() => {
      child.kill();
      finish(new Error("操作超时"));
    }, options.timeoutMs ?? 15000);
    timer.unref?.();
    child.stdin.end(options.input ?? "");
  });
}

function normalizeEndpoint(value, resolvedHostname) {
  const raw = safeText(value, 1024);
  const endpoint = new URL(raw || `http://${resolvedHostname}:4141/usage`);
  if (endpoint.pathname === "/" || endpoint.pathname === "") endpoint.pathname = "/usage";
  return endpoint.toString();
}

export function validateProvisionInput(raw, config) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw requestError("部署参数必须是对象");
  }
  const id = safeText(raw.id, 32).toLowerCase();
  if (!NODE_ID_PATTERN.test(id)) throw requestError("节点 ID 只能包含小写字母、数字、下划线和连字符");
  if (config.nodes.some((node) => node.id === id)) throw requestError("节点 ID 已存在", 409);

  const name = safeText(raw.name, 80);
  if (!name) throw requestError("机器名称不能为空");
  const region = safeText(raw.region, 120);
  const sshHost = safeText(raw.sshHost, 254);
  if (!SSH_HOST_PATTERN.test(sshHost)) throw requestError("SSH Host 格式无效");

  const platform = safeText(raw.platform || "linux", 16).toLowerCase();
  if (!["linux", "windows"].includes(platform)) {
    throw requestError("节点平台必须是 Linux 或 Windows");
  }
  const templateNodeId = safeText(
    raw.templateNodeId || "jpe2",
    32,
  ).toLowerCase();
  const templateNode =
    platform === "linux"
      ? config.nodes.find((node) => node.id === templateNodeId)
      : null;
  if (
    platform === "linux" &&
    (!templateNode?.management || templateNode.management.transport !== "ssh")
  ) {
    throw requestError("模板节点不存在或不是 Linux SSH 节点");
  }

  const accent = safeText(raw.accent || DEFAULT_ACCENT, 16).toLowerCase();
  if (!HEX_COLOR_PATTERN.test(accent)) throw requestError("节点颜色必须是六位十六进制颜色");

  return {
    id,
    name,
    region,
    sshHost,
    endpoint: safeText(raw.endpoint, 1024),
    platform,
    templateNode,
    templateNodeId,
    accent,
  };
}

function parsePackageVersion(fileName) {
  const match = fileName.match(/^copilot-api-([0-9A-Za-z.+-]+)-reasoning-effort\.tgz$/);
  return match && VERSION_PATTERN.test(match[1]) ? match[1] : null;
}

export class NodeProvisioner {
  constructor(config, options = {}) {
    this.config = config;
    this.configPath = options.configPath;
    this.projectRoot = options.projectRoot ?? PROJECT_ROOT;
    this.packagePath = options.packagePath ?? process.env.COPILOT_PACKAGE_PATH ?? null;
    this.runCommand = options.runCommand ?? runCommand;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.onConfigChange = options.onConfigChange ?? (() => {});
    this.secretRoot =
      options.secretRoot ??
      path.join(
        os.homedir(),
        ".config",
        "codex-usage-portal",
        "node-keys",
      );
    this.activeTargets = new Set();
  }

  setConfig(config) {
    this.config = config;
  }

  async provision(raw) {
    if (!this.configPath) throw requestError("Portal 未配置可写节点配置文件", 409);
    const request = validateProvisionInput(raw, this.config);
    const lockKey = `${request.id}:${request.sshHost}`;
    if (this.activeTargets.has(lockKey)) throw requestError("该机器正在部署", 409);
    this.activeTargets.add(lockKey);

    let stage = null;
    try {
      const sshConfig = await this.#resolveSshConfig(request.sshHost);
      if (request.platform === "windows") {
        return await this.#registerWindows(request, sshConfig);
      }
      const target = await this.#probeTarget(request.sshHost);
      this.#assertTargetAvailable(request, target);
      const template = await this.#probeTemplate(request.templateNode);
      const packageInfo = await this.#resolvePackage();
      const endpoint = normalizeEndpoint(request.endpoint, sshConfig.hostname);
      const nodeCandidate = {
        id: request.id,
        name: request.name,
        region: request.region,
        endpoint,
        apiKeyEnv: "",
        accent: request.accent,
        management: {
          transport: "ssh",
          sshHost: request.sshHost,
          runtimeBin: target.RUNTIME_BIN,
          copilotApi: "systemd-user",
          codexCli: "npm-global",
        },
      };
      const nextConfig = validateConfig({
        ...this.config,
        nodes: [...this.config.nodes, nodeCandidate],
      });

      stage = `${target.HOME}/.local/share/codex-portal/staging/${request.id}`;
      await this.#prepareStage(request.sshHost, stage);
      await this.#copyTemplateFiles(request.templateNode, template.HOME, request.sshHost, stage);
      await this.#copyPackage(packageInfo.path, request.sshHost, stage);
      const result = await this.#install(request, target, packageInfo, stage);
      const values = parseKeyValues(result.stdout);
      if (
        values.COPILOT_VERSION !== packageInfo.version ||
        values.COPILOT_SERVICE !== "active" ||
        values.UPDATE_TIMER !== "enabled" ||
        values.CODEX_CHECK !== "CODEX_PROVISION_OK"
      ) {
        throw new Error(
          `远程验证结果不完整：${JSON.stringify({
            copilotVersion: values.COPILOT_VERSION ?? null,
            codexVersion: values.CODEX_VERSION ?? null,
            copilotService: values.COPILOT_SERVICE ?? null,
            updateTimer: values.UPDATE_TIMER ?? null,
            codexCheck: values.CODEX_CHECK ?? null,
            stdoutTail: cleanMessage(result.stdout, 600),
            stderrTail: cleanMessage(result.stderr, 600),
          })}`,
        );
      }

      await this.#verifyPublicEndpoint(nodeCandidate);

      const savedConfig = await saveConfig(this.configPath, nextConfig);
      this.config = savedConfig;
      await this.onConfigChange(savedConfig);
      await this.#cleanupStage(request.sshHost, stage);
      stage = null;

      return {
        ok: true,
        node: savedConfig.nodes.find((node) => node.id === request.id),
        verification: {
          copilotVersion: values.COPILOT_VERSION,
          codexVersion: values.CODEX_VERSION,
          copilotService: values.COPILOT_SERVICE,
          updateTimer: values.UPDATE_TIMER,
          codexCheck: values.CODEX_CHECK,
        },
        message: `${request.name} 已完成安装、自动更新配置和 Codex 实际调用验证`,
      };
    } catch (cause) {
      if (stage) await this.#cleanupStage(request.sshHost, stage).catch(() => {});
      if (cause?.status) throw cause;
      throw requestError(`一键部署失败：${cleanMessage(cause?.message) || "未知错误"}`, 502);
    } finally {
      this.activeTargets.delete(lockKey);
    }
  }

  async #registerWindows(request, sshConfig) {
    const target = await this.#runWindowsPowerShell(
      request.sshHost,
      WINDOWS_TARGET_PROBE_SCRIPT,
      30000,
    );
    const values = parseKeyValues(target.stdout);
    const missing = [
      ["Copilot API package", values.COPILOT_PACKAGE],
      ["Copilot API config", values.COPILOT_CONFIG],
      ["Codex config", values.CODEX_CONFIG],
      ["model catalog", values.MODELS_CONFIG],
      ["startup launcher", values.STARTUP_LAUNCHER],
      ["ChatGPT app", values.CHATGPT_APP],
    ]
      .filter(([, status]) => status !== "yes")
      .map(([label]) => label);
    if (missing.length) {
      throw requestError(
        `Windows 节点尚未完成 bootstrap：${missing.join("、")}`,
        409,
      );
    }
    if (values.MANAGED_ID && values.MANAGED_ID !== request.id) {
      throw requestError(
        `目标 Windows 机器已由节点 ${values.MANAGED_ID} 管理`,
        409,
      );
    }

    const keysResult = await this.#runWindowsPowerShell(
      request.sshHost,
      WINDOWS_TARGET_KEYS_SCRIPT,
      15000,
    );
    const keys = parseKeyValues(keysResult.stdout);
    const apiKey = decodeBase64(keys.API_KEY_B64).trim();
    const sessionKey = decodeBase64(keys.SESSION_KEY_B64).trim();
    if (!apiKey || !sessionKey || apiKey.length > 512 || sessionKey.length > 512) {
      throw new Error("Windows 节点返回了无效 API key");
    }

    await mkdir(this.secretRoot, { recursive: true, mode: 0o700 });
    const apiKeyFile = path.join(this.secretRoot, `${request.id}.api.key`);
    const sessionApiKeyFile = path.join(
      this.secretRoot,
      `${request.id}.session.key`,
    );
    await Promise.all([
      writeFile(apiKeyFile, `${apiKey}\n`, { encoding: "utf8", mode: 0o600 }),
      writeFile(sessionApiKeyFile, `${sessionKey}\n`, {
        encoding: "utf8",
        mode: 0o600,
      }),
    ]);

    try {
      const endpoint = normalizeEndpoint(request.endpoint, sshConfig.hostname);
      const nodeCandidate = {
        id: request.id,
        name: request.name,
        region: request.region,
        endpoint,
        apiKeyEnv: "",
        apiKeyFile,
        accent: request.accent,
        management: {
          transport: "windows-ssh",
          sshHost: request.sshHost,
          sessionApiKeyFile,
          copilotApi: "windows-startup",
          codexCli: "desktop-managed",
        },
      };
      const nextConfig = validateConfig({
        ...this.config,
        nodes: [...this.config.nodes, nodeCandidate],
      });
      await this.#verifyPublicEndpoint(nodeCandidate, apiKey, false);
      const markerScript = `
$ErrorActionPreference = 'Stop'
$directory = Join-Path $HOME '.local\\share\\codex-portal'
New-Item -ItemType Directory -Path $directory -Force | Out-Null
$marker = @{ id = '${request.id}'; platform = 'windows'; registeredAt = [DateTime]::UtcNow.ToString('o') }
$marker | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $directory 'node.json') -Encoding UTF8
`;
      await this.#runWindowsPowerShell(
        request.sshHost,
        markerScript,
        15000,
      );
      const savedConfig = await saveConfig(this.configPath, nextConfig);
      this.config = savedConfig;
      await this.onConfigChange(savedConfig);
      return {
        ok: true,
        node: savedConfig.nodes.find((node) => node.id === request.id),
        verification: {
          platform: "windows",
          nodeVersion: values.NODE_VERSION,
          chatGptApp: values.CHATGPT_APP,
          copilotService: values.COPILOT_SERVICE,
        },
        message:
          `${request.name} Windows 工作站已注册；Portal 可读取用量、会话并启动代理`,
      };
    } catch (error) {
      await Promise.all([
        rm(apiKeyFile, { force: true }),
        rm(sessionApiKeyFile, { force: true }),
      ]);
      throw error;
    }
  }

  async #resolveSshConfig(sshHost) {
    const result = await this.runCommand("ssh", ["-G", sshHost], { timeoutMs: 10000 });
    const settings = {};
    for (const line of result.stdout.split(/\r?\n/)) {
      const separator = line.indexOf(" ");
      if (separator > 0) settings[line.slice(0, separator)] = line.slice(separator + 1).trim();
    }
    if (!SSH_HOST_PATTERN.test(settings.hostname || "")) {
      throw new Error("无法从 SSH 配置解析目标 HostName");
    }
    return settings;
  }

  async #probeTarget(sshHost) {
    const result = await this.runCommand(
      "ssh",
      ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", sshHost, "bash", "-s"],
      { input: TARGET_PROBE_SCRIPT, timeoutMs: 20000 },
    );
    const values = parseKeyValues(result.stdout);
    if (
      !POSIX_PATH_PATTERN.test(values.HOME || "") ||
      !POSIX_PATH_PATTERN.test(values.RUNTIME_BIN || "")
    ) {
      throw new Error("目标机器返回了无效安装路径");
    }
    if (values.SYSTEMD_USER !== "yes") throw new Error("目标机器的 systemd user manager 不可用");
    return values;
  }

  #assertTargetAvailable(request, target) {
    if (target.MANAGED_ID && target.MANAGED_ID !== request.id) {
      throw requestError(`目标机器已由节点 ${target.MANAGED_ID} 管理`, 409);
    }
    if (target.MANAGED_ID === request.id) return;
    const existing = [
      ["copilot-api 服务", target.EXISTING_SERVICE],
      ["copilot-api 配置", target.EXISTING_COPILOT_CONFIG],
      ["Codex 配置", target.EXISTING_CODEX_CONFIG],
      ["Codex CLI", target.EXISTING_CODEX_BIN],
    ].filter(([, value]) => value === "yes");
    if (existing.length > 0) {
      throw requestError(
        `目标机器不是空白节点，已存在：${existing.map(([label]) => label).join("、")}`,
        409,
      );
    }
  }

  async #probeTemplate(node) {
    const result = await this.runCommand(
      "ssh",
      [
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=8",
        node.management.sshHost,
        "bash",
        "-s",
      ],
      { input: TEMPLATE_PROBE_SCRIPT, timeoutMs: 15000 },
    );
    const values = parseKeyValues(result.stdout);
    if (!POSIX_PATH_PATTERN.test(values.HOME || "")) throw new Error("模板节点 HOME 路径无效");
    return values;
  }

  async #resolvePackage() {
    let packagePath = this.packagePath;
    if (!packagePath) {
      const artifacts = path.join(this.projectRoot, "artifacts");
      const candidates = (await readdir(artifacts))
        .map((name) => ({ name, version: parsePackageVersion(name) }))
        .filter((item) => item.version)
        .sort((left, right) =>
          right.version.localeCompare(left.version, undefined, { numeric: true, sensitivity: "base" }),
        );
      if (!candidates.length) throw new Error("未找到 reasoning-effort 定制安装包");
      packagePath = path.join(artifacts, candidates[0].name);
    }
    const version = parsePackageVersion(path.basename(packagePath));
    if (!version) throw new Error("定制包文件名不符合版本命名规则");
    await access(packagePath);
    const contents = await readFile(packagePath);
    return {
      path: packagePath,
      version,
      sha256: createHash("sha256").update(contents).digest("hex"),
    };
  }

  async #prepareStage(sshHost, stage) {
    await this.runCommand(
      "ssh",
      [
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=8",
        sshHost,
        "env",
        `PORTAL_STAGE=${stage}`,
        "bash",
        "-s",
      ],
      { input: PREPARE_STAGE_SCRIPT, timeoutMs: 15000 },
    );
  }

  async #copyTemplateFiles(templateNode, templateHome, sshHost, stage) {
    const files = [
      [".local/share/copilot-api/config.json", "copilot-config.json"],
      [".local/share/copilot-api/github_token", "github_token"],
      [".codex/config.toml", "codex-config.toml"],
      [".codex/models.json", "codex-models.json"],
    ];
    for (const [source, target] of files) {
      await this.runCommand(
        "scp",
        [
          "-3",
          "-q",
          "-p",
          "-o",
          "BatchMode=yes",
          "-o",
          "ConnectTimeout=8",
          `${templateNode.management.sshHost}:${templateHome}/${source}`,
          `${sshHost}:${stage}/${target}`,
        ],
        { timeoutMs: 30000 },
      );
    }
  }

  async #copyPackage(packagePath, sshHost, stage) {
    await this.runCommand(
      "scp",
      [
        "-q",
        "-p",
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=8",
        packagePath,
        `${sshHost}:${stage}/copilot-api.tgz`,
      ],
      { timeoutMs: 30000 },
    );
  }

  async #install(request, target, packageInfo, stage) {
    return this.runCommand(
      "ssh",
      [
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=8",
        request.sshHost,
        "env",
        `PORTAL_NODE_ID=${request.id}`,
        `PORTAL_TEMPLATE_NODE_ID=${request.templateNodeId}`,
        `PORTAL_PACKAGE_VERSION=${packageInfo.version}`,
        `PORTAL_PACKAGE_SHA256=${packageInfo.sha256}`,
        `PORTAL_STAGE=${stage}`,
        "bash",
        "-s",
      ],
      {
        input: PROVISION_SCRIPT,
        timeoutMs: Math.max(this.config.updateTimeoutMs, 600000),
      },
    );
  }

  async #cleanupStage(sshHost, stage) {
    await this.runCommand(
      "ssh",
      [
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=8",
        sshHost,
        "env",
        `PORTAL_STAGE=${stage}`,
        "bash",
        "-s",
      ],
      { input: CLEAN_STAGE_SCRIPT, timeoutMs: 15000 },
    );
  }

  async #verifyPublicEndpoint(
    node,
    apiKey = "",
    requireReasoningEffort = true,
  ) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    timeout.unref?.();
    try {
      const usage = await this.fetchImpl(node.endpoint, {
        headers: {
          accept: "application/json",
          "user-agent": "codex-usage-portal/provision",
          ...(apiKey ? { "x-api-key": apiKey } : {}),
        },
        redirect: "error",
        signal: controller.signal,
      });
      if (!usage.ok) throw new Error(`公开用量地址返回 HTTP ${usage.status}`);

      const eventsUrl = deriveEndpointUrl(node.endpoint, "token-usage/events");
      eventsUrl.searchParams.set("page", "1");
      eventsUrl.searchParams.set("page_size", "10");
      const eventsResponse = await this.fetchImpl(eventsUrl, {
        headers: {
          accept: "application/json",
          "user-agent": "codex-usage-portal/provision",
          ...(apiKey ? { "x-api-key": apiKey } : {}),
        },
        redirect: "error",
        signal: controller.signal,
      });
      if (!eventsResponse.ok) throw new Error(`公开事件地址返回 HTTP ${eventsResponse.status}`);
      const events = await eventsResponse.json();
      if (
        requireReasoningEffort &&
        !events?.items?.some((event) => event.reasoning_effort)
      ) {
        throw new Error("公开事件接口尚未返回 reasoning_effort 验收记录");
      }

    } finally {
      clearTimeout(timeout);
    }
  }

  async #runWindowsPowerShell(sshHost, script, timeoutMs) {
    return this.runCommand(
      "ssh",
      [
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=8",
        sshHost,
        "powershell.exe",
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        encodedPowerShell(script),
      ],
      { timeoutMs },
    );
  }
}

export const provisionerInternals = Object.freeze({
  normalizeEndpoint,
  parseKeyValues,
  parsePackageVersion,
  WINDOWS_TARGET_KEYS_SCRIPT,
  WINDOWS_TARGET_PROBE_SCRIPT,
  encodedPowerShell,
});
