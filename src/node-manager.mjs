import { spawn } from "node:child_process";
import path from "node:path";
import { ArtifactCatalog } from "./artifact-catalog.mjs";
import { PROJECT_ROOT } from "./config.mjs";

const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const REGISTRY_CACHE_MS = 60 * 1000;

const REMOTE_STATUS_SCRIPT = String.raw`
set -u
npm_root="$(npm root --global 2>/dev/null || true)"
copilot_version=""
if [ -n "$npm_root" ] && [ -f "$npm_root/@jeffreycao/copilot-api/package.json" ]; then
  copilot_version="$(node -p "require(process.argv[1]).version" "$npm_root/@jeffreycao/copilot-api/package.json" 2>/dev/null || true)"
fi
codex_version="$(codex --version 2>/dev/null | tail -n 1 | awk '{print $NF}' || true)"
service_state="$(systemctl --user is-active copilot-api.service 2>/dev/null || true)"
build_id=""
build_date=""
build_label=""
build_marker="$HOME/.local/share/copilot-api/portal-build.json"
if [ -f "$build_marker" ]; then
  build_values="$(node - "$build_marker" "$copilot_version" <<'NODE' 2>/dev/null || true
const fs = require("fs")
const marker = JSON.parse(fs.readFileSync(process.argv[2], "utf8"))
if (String(marker.version || "") !== process.argv[3]) process.exit(0)
const clean = (value) => String(value || "").replace(/[\r\n=]/g, "").slice(0, 160)
console.log("BUILD_ID=" + clean(marker.artifactId))
console.log("BUILD_DATE=" + clean(marker.buildDate))
console.log("BUILD_LABEL=" + clean(marker.label))
NODE
)"
  build_id="$(printf '%s\n' "$build_values" | sed -n 's/^BUILD_ID=//p' | head -1)"
  build_date="$(printf '%s\n' "$build_values" | sed -n 's/^BUILD_DATE=//p' | head -1)"
  build_label="$(printf '%s\n' "$build_values" | sed -n 's/^BUILD_LABEL=//p' | head -1)"
fi
printf 'COPILOT_VERSION=%s\n' "$copilot_version"
printf 'COPILOT_BUILD_ID=%s\n' "$build_id"
printf 'COPILOT_BUILD_DATE=%s\n' "$build_date"
printf 'COPILOT_BUILD_LABEL=%s\n' "$build_label"
printf 'CODEX_VERSION=%s\n' "$codex_version"
printf 'COPILOT_SERVICE=%s\n' "$service_state"
`;

const REMOTE_ARTIFACT_PREPARE_SCRIPT = String.raw`
set -euo pipefail
case "$PORTAL_STAGE" in
  "$HOME"/.local/share/copilot-api/portal-updates/*) ;;
  *) printf 'Unsafe artifact staging path.\n' >&2; exit 1 ;;
esac
mkdir -p "$PORTAL_STAGE"
chmod 700 "$HOME/.local/share/copilot-api/portal-updates" "$PORTAL_STAGE"
rm -f "$PORTAL_STAGE/copilot-api.tgz" "$PORTAL_STAGE/codex-check.log"
`;

const REMOTE_COPILOT_ARTIFACT_UPDATE_SCRIPT = String.raw`
set -euo pipefail
case "$PORTAL_ARTIFACT_ID" in
  *[!a-zA-Z0-9._+-]*|"") printf 'Invalid artifact id.\n' >&2; exit 1 ;;
esac
case "$PORTAL_STAGE" in
  "$HOME"/.local/share/copilot-api/portal-updates/*) ;;
  *) printf 'Unsafe artifact staging path.\n' >&2; exit 1 ;;
esac
if [[ ! "$PORTAL_PACKAGE_VERSION" =~ ^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$ ]]; then
  printf 'Invalid package version.\n' >&2
  exit 1
fi
if [[ ! "$PORTAL_PACKAGE_SHA256" =~ ^[a-f0-9]{64}$ ]]; then
  printf 'Invalid package checksum.\n' >&2
  exit 1
fi

package_file="$PORTAL_STAGE/copilot-api.tgz"
[ -f "$package_file" ]
actual_sha="$(sha256sum "$package_file" | awk '{print $1}')"
if [ "$actual_sha" != "$PORTAL_PACKAGE_SHA256" ]; then
  printf 'Package checksum mismatch.\n' >&2
  exit 1
fi

npm_root="$(npm root --global)"
npm_prefix="$(npm config get prefix)"
runtime_bin="$npm_prefix/bin"
export PATH="$runtime_bin:/usr/local/bin:/usr/bin:/bin:/snap/bin"
package_dir="$npm_root/@jeffreycao/copilot-api"
backup_file="$PORTAL_STAGE/package-tree-before.tgz"
marker_file="$HOME/.local/share/copilot-api/portal-build.json"
marker_backup="$PORTAL_STAGE/portal-build-before.json"
had_marker=0

[ -d "$package_dir" ]
tar -C "$npm_root" -czf "$backup_file" "@jeffreycao/copilot-api"
if [ -f "$marker_file" ]; then
  cp -p "$marker_file" "$marker_backup"
  had_marker=1
else
  rm -f "$marker_backup"
fi

rollback() {
  code=$?
  trap - ERR
  set +e
  printf 'Rolling back copilot-api after failed verification.\n' >&2
  rm -rf "$package_dir"
  tar -C "$npm_root" -xzf "$backup_file"
  if [ "$had_marker" = 1 ] && [ -f "$marker_backup" ]; then
    cp -p "$marker_backup" "$marker_file"
  else
    rm -f "$marker_file"
  fi
  systemctl --user restart copilot-api.service
  for attempt in $(seq 1 60); do
    curl -fsS --max-time 2 http://127.0.0.1:4141/usage >/dev/null && break
    sleep 1
  done
  exit "$code"
}
trap rollback ERR

previous_version="$(node -p 'require(process.argv[1]).version' "$package_dir/package.json")"
npm install --global "$package_file" --loglevel=error
updated_version="$(node -p 'require(process.argv[1]).version' "$package_dir/package.json")"
if [ "$updated_version" != "$PORTAL_PACKAGE_VERSION" ]; then
  printf 'Expected copilot-api %s, found %s.\n' "$PORTAL_PACKAGE_VERSION" "$updated_version" >&2
  false
fi
grep -Rqs 'invalid-encrypted-content' "$package_dir/dist"
grep -Rqs 'reasoning_effort TEXT' "$package_dir/dist"

systemctl --user restart copilot-api.service
for attempt in $(seq 1 60); do
  if curl -fsS --max-time 2 http://127.0.0.1:4141/usage >/dev/null; then
    break
  fi
  sleep 1
  [ "$attempt" -lt 60 ]
done
systemctl --user is-active --quiet copilot-api.service

api_key="$(node -e 'const fs=require("fs");const p=process.env.HOME+"/.local/share/copilot-api/config.json";const j=JSON.parse(fs.readFileSync(p,"utf8"));process.stdout.write(j.auth?.apiKeys?.[0]??"local-copilot-api")')"
check_output="$PORTAL_STAGE/codex-check.log"
if ! timeout 240 env GITHUB_COPILOT_API_KEY="$api_key" "$runtime_bin/codex" exec \
  --ephemeral \
  --skip-git-repo-check \
  --color never \
  'Do not use tools. Reply with exactly CODEX_ARTIFACT_OK' < /dev/null >"$check_output" 2>&1; then
  tail -80 "$check_output" >&2
  false
fi
grep -q CODEX_ARTIFACT_OK "$check_output"
curl -fsS --max-time 10 \
  'http://127.0.0.1:4141/token-usage/events?period=day&page=1&page_size=20' \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const j=JSON.parse(s);if(!j.items?.some(x=>typeof x.reasoning_effort==="string"&&x.reasoning_effort.length>0))process.exit(1)})'
rm -f "$check_output"

node - "$marker_file" <<'NODE'
const fs = require("fs")
const markerPath = process.argv[2]
const marker = {
  artifactId: process.env.PORTAL_ARTIFACT_ID,
  version: process.env.PORTAL_PACKAGE_VERSION,
  buildDate: process.env.PORTAL_BUILD_DATE,
  label: process.env.PORTAL_BUILD_LABEL,
  sha256: process.env.PORTAL_PACKAGE_SHA256,
  installedAt: new Date().toISOString(),
}
const temporaryPath = markerPath + ".tmp-" + process.pid
fs.writeFileSync(temporaryPath, JSON.stringify(marker, null, 2) + "\n", {
  encoding: "utf8",
  mode: 0o600,
})
fs.renameSync(temporaryPath, markerPath)
NODE

trap - ERR
printf 'PREVIOUS_VERSION=%s\n' "$previous_version"
printf 'COPILOT_VERSION=%s\n' "$updated_version"
printf 'ARTIFACT_ID=%s\n' "$PORTAL_ARTIFACT_ID"
printf 'COPILOT_SERVICE=%s\n' "$(systemctl --user is-active copilot-api.service)"
printf 'CODEX_CHECK=CODEX_ARTIFACT_OK\n'
`;

const REMOTE_CODEX_UPDATE_SCRIPT = String.raw`
set -euo pipefail
installed="$(codex --version 2>/dev/null | tail -n 1 | awk '{print $NF}' || true)"
latest="$(npm view @openai/codex@latest version --silent)"
if [[ ! "$latest" =~ ^[0-9A-Za-z][0-9A-Za-z.+-]*$ ]]; then
  printf 'Unable to determine a valid latest Codex CLI version.\n' >&2
  exit 1
fi
if [[ "$installed" == "$latest" ]]; then
  printf 'Codex CLI is already current (%s).\n' "$installed"
else
  printf 'Updating Codex CLI from %s to %s.\n' "$installed" "$latest"
  npm install --global "@openai/codex@$latest"
fi
updated="$(codex --version 2>/dev/null | tail -n 1 | awk '{print $NF}' || true)"
if [[ "$updated" != "$latest" ]]; then
  printf 'Expected Codex CLI %s after update, but found %s.\n' "$latest" "$updated" >&2
  exit 1
fi
api_key="$(node -e 'const fs=require("fs");const p=process.env.HOME+"/.local/share/copilot-api/config.json";const j=JSON.parse(fs.readFileSync(p,"utf8"));process.stdout.write(j.auth?.apiKeys?.[0]??"local-copilot-api")')"
check_output="$(mktemp)"
if ! timeout 240 env GITHUB_COPILOT_API_KEY="$api_key" codex exec \
  --ephemeral \
  --skip-git-repo-check \
  --color never \
  'Do not use tools. Reply with exactly CODEX_UPDATE_OK' < /dev/null >"$check_output" 2>&1; then
  tail -80 "$check_output" >&2
  rm -f "$check_output"
  exit 1
fi
grep -q CODEX_UPDATE_OK "$check_output"
rm -f "$check_output"
printf 'Codex CLI %s is ready.\n' "$updated"
`;

const REMOTE_COPILOT_START_SCRIPT = String.raw`
set -euo pipefail
systemctl --user start copilot-api.service
for attempt in $(seq 1 60); do
  if curl -fsS --max-time 2 http://127.0.0.1:4141/usage >/dev/null; then
    break
  fi
  sleep 1
  [ "$attempt" -lt 60 ]
done
systemctl --user is-active --quiet copilot-api.service
printf 'COPILOT_SERVICE=%s\n' "$(systemctl --user is-active copilot-api.service)"
`;

const WINDOWS_REMOTE_STATUS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$npmRoot = (& npm.cmd root --global).Trim()
$packageJson = Join-Path $npmRoot '@jeffreycao\copilot-api\package.json'
$copilotVersion = if (Test-Path -LiteralPath $packageJson) {
  (Get-Content -Raw -LiteralPath $packageJson | ConvertFrom-Json).version
} else {
  ''
}
$listener = Get-NetTCPConnection -LocalPort 4141 -State Listen -ErrorAction SilentlyContinue
$markerPath = Join-Path $HOME '.local\share\copilot-api\portal-build.json'
$marker = if (Test-Path -LiteralPath $markerPath) {
  Get-Content -Raw -LiteralPath $markerPath | ConvertFrom-Json
} else {
  $null
}
$app = Get-AppxPackage -Name 'OpenAI.Codex' | Select-Object -First 1
Write-Output ('COPILOT_VERSION=' + $copilotVersion)
Write-Output ('COPILOT_BUILD_ID=' + $(if ($marker) { $marker.artifactId } else { '' }))
Write-Output ('COPILOT_BUILD_DATE=' + $(if ($marker) { $marker.buildDate } else { '' }))
Write-Output ('COPILOT_BUILD_LABEL=' + $(if ($marker) { $marker.label } else { '' }))
Write-Output ('CODEX_VERSION=' + $(if ($app) { $app.Version.ToString() } else { '' }))
Write-Output ('COPILOT_SERVICE=' + $(if ($listener) { 'active' } else { 'inactive' }))
`;

const WINDOWS_REMOTE_START_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$listener = Get-NetTCPConnection -LocalPort 4141 -State Listen -ErrorAction SilentlyContinue
if (-not $listener) {
  $launcher = Join-Path $env:LOCALAPPDATA 'CodexWorkstation\start-copilot-api.ps1'
  if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) {
    throw 'Windows bootstrap launcher is missing.'
  }
  $arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $launcher + '" -Port 4141'
  Start-Process -FilePath 'powershell.exe' -ArgumentList $arguments -WindowStyle Hidden
}
$ready = $false
for ($attempt = 0; $attempt -lt 60; $attempt++) {
  Start-Sleep -Milliseconds 500
  $client = [Net.Sockets.TcpClient]::new()
  try {
    $pending = $client.ConnectAsync('127.0.0.1', 4141)
    if ($pending.Wait(500) -and $client.Connected) {
      $ready = $true
      break
    }
  } finally {
    $client.Dispose()
  }
}
if (-not $ready) {
  throw 'Windows Copilot API did not become ready.'
}
Write-Output 'COPILOT_SERVICE=active'
`;

const LOCAL_STATUS_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$processes = @(Get-CimInstance Win32_Process)
$active = @($processes | Where-Object {
  $_.CommandLine -match '@jeffreycao[\\/]copilot-api[\\/]dist[\\/]main\.js' -and
  $_.CommandLine -match '(?:^|\s)start(?:\s|$)'
})
$copilotVersion = $null
$copilotBuildId = $null
$copilotBuildDate = $null
$copilotBuildLabel = $null
$main = $active | Select-Object -First 1
if ($main) {
  $match = [regex]::Match(
    $main.CommandLine,
    '(?<entry>[A-Za-z]:\\[^\"]*?@jeffreycao\\copilot-api\\dist\\main\.js)',
    [Text.RegularExpressions.RegexOptions]::IgnoreCase
  )
  if ($match.Success) {
    $entry = [IO.Path]::GetFullPath($match.Groups['entry'].Value)
    $packageRoot = Split-Path -Parent (Split-Path -Parent $entry)
    $packageJson = Join-Path $packageRoot 'package.json'
    if (Test-Path -LiteralPath $packageJson) {
      $copilotVersion = (Get-Content -Raw -LiteralPath $packageJson | ConvertFrom-Json).version
    }
  }
}
$buildMarker = Join-Path $HOME '.local\share\copilot-api\portal-runtime\portal-build.json'
if (Test-Path -LiteralPath $buildMarker) {
  try {
    $build = Get-Content -Raw -LiteralPath $buildMarker | ConvertFrom-Json
    $copilotBuildId = $build.artifactId
    $copilotBuildDate = $build.buildDate
    $copilotBuildLabel = $build.label
  } catch {
  }
}
$app = Get-AppxPackage -Name 'OpenAI.Codex' | Select-Object -First 1
[pscustomobject]@{
  copilotVersion = $copilotVersion
  copilotBuildId = $copilotBuildId
  copilotBuildDate = $copilotBuildDate
  copilotBuildLabel = $copilotBuildLabel
  copilotService = $(if ($active.Count -gt 0) { 'active' } else { 'inactive' })
  codexVersion = $(if ($app) { $app.Version.ToString() } else { $null })
} | ConvertTo-Json -Compress
`;

const LOCAL_COPILOT_START_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$packagePath = [IO.Path]::GetFullPath($env:CODEX_PORTAL_PACKAGE_PATH)
if (-not (Test-Path -LiteralPath $packagePath -PathType Leaf)) {
  throw 'The verified Copilot API package was not found.'
}

$forceRestart = $env:CODEX_PORTAL_FORCE_RESTART -eq 'true'
$processes = @(Get-CimInstance Win32_Process)
$active = @($processes | Where-Object {
  $_.CommandLine -match '@jeffreycao[\\/]copilot-api[\\/]dist[\\/]main\.js' -and
  $_.CommandLine -match '(?:^|\s)start(?:\s|$)'
})
if ($active.Count -gt 0 -and -not $forceRestart) {
  [pscustomobject]@{
    status = 'already-active'
    processId = $active[0].ProcessId
  } | ConvertTo-Json -Compress
  exit 0
}

$runtimeRoot = Join-Path $HOME '.local\share\copilot-api\portal-runtime'
New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
$runtimePackage = Join-Path $runtimeRoot 'copilot-api.tgz'
$runtimeBackup = Join-Path $runtimeRoot 'copilot-api.before.tgz'
$launcherPath = Join-Path $runtimeRoot 'start-copilot-api.cmd'
$stdoutPath = Join-Path $runtimeRoot 'copilot-api.stdout.log'
$stderrPath = Join-Path $runtimeRoot 'copilot-api.stderr.log'
$markerPath = Join-Path $runtimeRoot 'portal-build.json'
$markerBackup = Join-Path $runtimeRoot 'portal-build.before.json'
$hadRuntimePackage = Test-Path -LiteralPath $runtimePackage
$hadMarker = Test-Path -LiteralPath $markerPath
if ($hadRuntimePackage) {
  Copy-Item -LiteralPath $runtimePackage -Destination $runtimeBackup -Force
}
if ($hadMarker) {
  Copy-Item -LiteralPath $markerPath -Destination $markerBackup -Force
}

if ($active.Count -gt 0) {
  $rootProcess = $active[0]
  $current = $active[0]
  for ($depth = 0; $depth -lt 8; $depth++) {
    $parent = $processes |
      Where-Object ProcessId -eq $current.ParentProcessId |
      Select-Object -First 1
    if (-not $parent) { break }
    if (
      $parent.CommandLine -match 'npm-cli\.js.*copilot-api' -or
      $parent.CommandLine -match 'start-copilot-api\.cmd'
    ) {
      $rootProcess = $parent
    }
    $current = $parent
  }
  & taskkill.exe /PID $rootProcess.ProcessId /T /F | Out-Null
  Start-Sleep -Milliseconds 800
}

Copy-Item -LiteralPath $packagePath -Destination $runtimePackage -Force
$quote = [char]34
$launcher = @(
  '@echo off'
  (
    'call npm.cmd exec --yes --package=' +
    $quote + $runtimePackage + $quote +
    ' -- copilot-api start 1>>' +
    $quote + $stdoutPath + $quote +
    ' 2>>' + $quote + $stderrPath + $quote
  )
)
Set-Content -LiteralPath $launcherPath -Value $launcher -Encoding Ascii

$startOptions = @{
  FilePath = $launcherPath
  WindowStyle = 'Hidden'
  PassThru = $true
}
$started = Start-Process @startOptions

$ready = $false
for ($attempt = 0; $attempt -lt 60; $attempt++) {
  Start-Sleep -Milliseconds 500
  $client = [Net.Sockets.TcpClient]::new()
  try {
    $pending = $client.ConnectAsync('127.0.0.1', 4141)
    if ($pending.Wait(500) -and $client.Connected) {
      $ready = $true
      break
    }
  } catch {
  } finally {
    $client.Dispose()
  }
}
if (-not $ready) {
  try {
    $started.Kill($true)
  } catch {
  }
  if ($hadRuntimePackage -and (Test-Path -LiteralPath $runtimeBackup)) {
    Copy-Item -LiteralPath $runtimeBackup -Destination $runtimePackage -Force
    Start-Process -FilePath $launcherPath -WindowStyle Hidden | Out-Null
  }
  if ($hadMarker -and (Test-Path -LiteralPath $markerBackup)) {
    Copy-Item -LiteralPath $markerBackup -Destination $markerPath -Force
  } else {
    Remove-Item -LiteralPath $markerPath -Force -ErrorAction SilentlyContinue
  }
  $errorTail = if (Test-Path -LiteralPath $stderrPath) {
    (Get-Content -LiteralPath $stderrPath -Tail 30) -join [Environment]::NewLine
  } else {
    ''
  }
  throw "The local copilot-api did not become ready. $errorTail"
}

$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$runCommand = 'cmd.exe /d /c ""' + $launcherPath + '""'
New-Item -Path $runKey -Force | Out-Null
New-ItemProperty -Path $runKey -Name 'CopilotApiForCodex' -Value $runCommand -PropertyType String -Force | Out-Null

$marker = [ordered]@{
  artifactId = $env:CODEX_PORTAL_ARTIFACT_ID
  version = $env:CODEX_PORTAL_PACKAGE_VERSION
  buildDate = $env:CODEX_PORTAL_BUILD_DATE
  label = $env:CODEX_PORTAL_BUILD_LABEL
  sha256 = $env:CODEX_PORTAL_PACKAGE_SHA256
  installedAt = [DateTime]::UtcNow.ToString('o')
}
$temporaryMarker = $markerPath + '.tmp'
$marker | ConvertTo-Json | Set-Content -LiteralPath $temporaryMarker -Encoding UTF8
Move-Item -LiteralPath $temporaryMarker -Destination $markerPath -Force
Remove-Item -LiteralPath $runtimeBackup, $markerBackup -Force -ErrorAction SilentlyContinue

[pscustomobject]@{
  status = 'active'
  processId = $started.Id
  packageId = $env:CODEX_PORTAL_ARTIFACT_ID
} | ConvertTo-Json -Compress
`;

const LOCAL_COPILOT_UPDATE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$targetVersion = $env:CODEX_PORTAL_TARGET_VERSION
if ($targetVersion -notmatch '^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$') {
  throw 'Invalid target version.'
}
$packageSpec = "@jeffreycao/copilot-api@$targetVersion"
$processes = @(Get-CimInstance Win32_Process)
$main = $processes | Where-Object {
  $_.CommandLine -match '@jeffreycao[\\/]copilot-api[\\/]dist[\\/]main\.js' -and
  $_.CommandLine -match '(?:^|\s)start(?:\s|$)'
} | Select-Object -First 1
if (-not $main) {
  throw 'The local copilot-api process was not found.'
}

$oldVersion = $null
$match = [regex]::Match(
  $main.CommandLine,
  '(?<entry>[A-Za-z]:\\[^\"]*?@jeffreycao\\copilot-api\\dist\\main\.js)',
  [Text.RegularExpressions.RegexOptions]::IgnoreCase
)
if ($match.Success) {
  $entry = [IO.Path]::GetFullPath($match.Groups['entry'].Value)
  $packageRoot = Split-Path -Parent (Split-Path -Parent $entry)
  $packageJson = Join-Path $packageRoot 'package.json'
  if (Test-Path -LiteralPath $packageJson) {
    $oldVersion = (Get-Content -Raw -LiteralPath $packageJson | ConvertFrom-Json).version
  }
}

& npm.cmd cache add $packageSpec | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Unable to cache the requested package.' }

$rootProcess = $main
$current = $main
for ($depth = 0; $depth -lt 8; $depth++) {
  $parent = $processes | Where-Object ProcessId -eq $current.ParentProcessId | Select-Object -First 1
  if (-not $parent) { break }
  if ($parent.CommandLine -match 'npx-cli\.js.*@jeffreycao/copilot-api') {
    $rootProcess = $parent
    break
  }
  $current = $parent
}

& taskkill.exe /PID $rootProcess.ProcessId /T /F | Out-Null
Start-Sleep -Milliseconds 800
$started = Start-Process -FilePath 'npx.cmd' -ArgumentList @('--yes', $packageSpec, 'start') -WindowStyle Hidden -PassThru

$ready = $false
for ($attempt = 0; $attempt -lt 60; $attempt++) {
  Start-Sleep -Milliseconds 500
  $client = [Net.Sockets.TcpClient]::new()
  try {
    $pending = $client.ConnectAsync('127.0.0.1', 4141)
    if ($pending.Wait(500) -and $client.Connected) {
      $ready = $true
      break
    }
  } catch {
  } finally {
    $client.Dispose()
  }
}

if (-not $ready) {
  & taskkill.exe /PID $started.Id /T /F 2>$null | Out-Null
  if ($oldVersion -and $oldVersion -match '^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$') {
    Start-Process -FilePath 'npx.cmd' -ArgumentList @('--yes', "@jeffreycao/copilot-api@$oldVersion", 'start') -WindowStyle Hidden | Out-Null
  }
  throw 'The updated local copilot-api did not become ready; the previous version was restarted when available.'
}

[pscustomobject]@{
  previousVersion = $oldVersion
  currentVersion = $targetVersion
  processId = $started.Id
} | ConvertTo-Json -Compress
`;

function cleanVersion(value) {
  const version = String(value ?? "").trim();
  return VERSION_PATTERN.test(version) ? version : null;
}

function cleanMessage(value, maximumLength = 1400) {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim()
    .slice(-maximumLength);
}

function parseKeyValues(output) {
  const result = {};
  for (const line of String(output).split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    result[line.slice(0, separator)] = line.slice(separator + 1).trim();
  }
  return result;
}

function encodedPowerShell(script) {
  return Buffer.from(script, "utf16le").toString("base64");
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

function componentStatus({
  currentVersion,
  latestVersion,
  currentBuildId,
  latestBuildId,
  canUpdate,
  canStart,
  canDeploy,
  mode,
  service,
  note,
}) {
  const cleanCurrentVersion = cleanVersion(currentVersion);
  const cleanLatestVersion = cleanVersion(latestVersion);
  const normalizedCurrentBuildId = String(currentBuildId ?? "").slice(0, 160) || null;
  const normalizedLatestBuildId = String(latestBuildId ?? "").slice(0, 160) || null;
  return {
    currentVersion: cleanCurrentVersion,
    latestVersion: cleanLatestVersion,
    currentBuildId: normalizedCurrentBuildId,
    latestBuildId: normalizedLatestBuildId,
    updateAvailable: Boolean(
      cleanCurrentVersion &&
      cleanLatestVersion &&
      (
        cleanCurrentVersion !== cleanLatestVersion ||
        (
          normalizedLatestBuildId &&
          normalizedCurrentBuildId !== normalizedLatestBuildId
        )
      ),
    ),
    canUpdate: Boolean(canUpdate),
    canStart: Boolean(canStart),
    canDeploy: Boolean(canDeploy),
    mode,
    service: String(service ?? "unknown").slice(0, 40),
    note: String(note ?? "").slice(0, 160),
  };
}

export class NodeManager {
  constructor(config, options = {}) {
    this.config = config;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.runCommand = options.runCommand ?? runCommand;
    this.platform = options.platform ?? process.platform;
    this.artifactCatalog =
      options.artifactCatalog ??
      new ArtifactCatalog(
        options.artifactsRoot ??
          process.env.COPILOT_ARTIFACTS_DIR ??
          path.join(PROJECT_ROOT, "copilot-api-artifacts"),
      );
    this.registryCache = new Map();
    this.activeUpdates = new Set();
  }

  setConfig(config) {
    this.config = config;
    this.registryCache.clear();
  }

  selectNodes(nodeIds) {
    if (!nodeIds || nodeIds.length === 0) return this.config.nodes;
    const requested = new Set(nodeIds);
    const selected = this.config.nodes.filter((node) => requested.has(node.id));
    if (selected.length !== requested.size) {
      const error = new Error("包含未知节点");
      error.status = 400;
      throw error;
    }
    return selected;
  }

  async status(nodeIds = []) {
    const selected = this.selectNodes(nodeIds);
    const [artifactScan, codexLatest] = await Promise.all([
      this.artifactCatalog.scan().catch((error) => ({
        artifacts: [],
        errors: [
          {
            fileName: "copilot-api-artifacts",
            message: cleanMessage(error?.message, 300) || "构建目录读取失败",
          },
        ],
      })),
      this.#latestVersion("@openai/codex"),
    ]);
    const latestArtifact = artifactScan.artifacts[0] ?? null;
    const nodes = await Promise.all(
      selected.map((node) =>
        this.#nodeStatus(node, {
          copilotLatest: latestArtifact?.version ?? null,
          copilotLatestBuildId: latestArtifact?.id ?? null,
          codexLatest,
        }),
      ),
    );
    return {
      checkedAt: new Date().toISOString(),
      artifacts: artifactScan.artifacts,
      artifactErrors: artifactScan.errors,
      nodes,
    };
  }

  async update(nodeId, component, options = {}) {
    const node = this.config.nodes.find((item) => item.id === nodeId);
    if (!node) {
      const error = new Error("未知节点");
      error.status = 404;
      throw error;
    }

    if (component !== "copilot-api" && component !== "codex-cli") {
      const error = new Error("component must be copilot-api or codex-cli");
      error.status = 400;
      throw error;
    }
    const lockKey = `${nodeId}:${component}`;
    if (this.activeUpdates.has(lockKey)) {
      const error = new Error("该更新已在执行");
      error.status = 409;
      throw error;
    }

    const mode = component === "copilot-api"
      ? node.management?.copilotApi
      : node.management?.codexCli;
    const supportedCopilotTarget =
      component === "copilot-api" &&
      (node.management?.transport === "local" ||
        (node.management?.transport === "ssh" && mode === "systemd-user"));
    if (
      (!supportedCopilotTarget && component === "copilot-api") ||
      (component === "codex-cli" &&
        (!mode || mode === "none" || mode === "desktop-managed"))
    ) {
      const error = new Error(
        mode === "desktop-managed" ? "本机 Codex CLI 随桌面应用更新" : "该组件未配置 Portal 更新器",
      );
      error.status = 409;
      throw error;
    }

    this.activeUpdates.add(lockKey);
    try {
      let output;
      let artifact = null;
      if (node.management.transport === "ssh") {
        if (component === "copilot-api") {
          artifact = await this.artifactCatalog.resolve(options.artifactId);
          output = await this.#remoteArtifactUpdate(node, artifact);
        } else {
          output = await this.#remoteUpdate(node, REMOTE_CODEX_UPDATE_SCRIPT);
        }
      } else if (component === "copilot-api") {
        artifact = await this.artifactCatalog.resolve(options.artifactId);
        output = await this.#localCopilotStart(artifact, {
          forceRestart: true,
        });
      } else {
        const error = new Error("此更新组合不受支持");
        error.status = 409;
        throw error;
      }

      const refreshed = await this.status([nodeId]);
      return {
        ok: true,
        nodeId,
        component,
        artifact: artifact
          ? {
              id: artifact.id,
              version: artifact.version,
              buildDate: artifact.buildDate,
              label: artifact.label,
              sha256: artifact.sha256,
            }
          : null,
        message: cleanMessage(output) || "更新完成并已验证",
        status: refreshed.nodes[0],
      };
    } catch (cause) {
      if (cause?.status) throw cause;
      const error = new Error(`更新失败：${cleanMessage(cause?.message) || "未知错误"}`);
      error.status = 502;
      error.expose = true;
      throw error;
    } finally {
      this.activeUpdates.delete(lockKey);
    }
  }

  async deployCopilotArtifactToAll(artifactId) {
    const artifact = await this.artifactCatalog.resolve(artifactId);
    const candidates = this.config.nodes.filter(
      (node) =>
        node.management?.transport === "local" ||
        (node.management?.transport === "ssh" &&
          node.management.copilotApi === "systemd-user"),
    );
    if (candidates.length === 0) {
      const error = new Error("没有可部署 Copilot API 的节点");
      error.status = 409;
      throw error;
    }

    const current = await this.status(candidates.map((node) => node.id));
    const statusById = new Map(current.nodes.map((node) => [node.id, node]));
    const results = await Promise.all(
      candidates.map(async (node) => {
        const status = statusById.get(node.id);
        if (
          status?.copilotApi?.currentBuildId === artifact.id &&
          status.copilotApi.service === "active"
        ) {
          return {
            nodeId: node.id,
            nodeName: node.name,
            ok: true,
            skipped: true,
            message: "already deployed and active",
          };
        }
        try {
          const result = await this.update(node.id, "copilot-api", {
            artifactId: artifact.id,
          });
          return {
            nodeId: node.id,
            nodeName: node.name,
            ok: true,
            skipped: false,
            message: result.message,
            status: result.status,
          };
        } catch (error) {
          return {
            nodeId: node.id,
            nodeName: node.name,
            ok: false,
            skipped: false,
            error: cleanMessage(error?.message, 500) || "deployment failed",
          };
        }
      }),
    );
    const deployed = results.filter((item) => item.ok && !item.skipped).length;
    const skipped = results.filter((item) => item.skipped).length;
    const failed = results.length - deployed - skipped;
    return {
      artifact: {
        id: artifact.id,
        version: artifact.version,
        buildDate: artifact.buildDate,
        label: artifact.label,
        sha256: artifact.sha256,
      },
      requested: results.length,
      deployed,
      skipped,
      failed,
      results,
    };
  }

  async startCopilotApi(nodeId) {
    const node = this.config.nodes.find((item) => item.id === nodeId);
    if (!node) {
      const error = new Error("未知节点");
      error.status = 404;
      throw error;
    }
    const management = node.management;
    const canStart =
      management?.transport === "local" ||
      (management?.transport === "ssh" &&
        management.copilotApi === "systemd-user") ||
      (management?.transport === "windows-ssh" &&
        management.copilotApi === "windows-startup");
    if (!canStart) {
      const error = new Error("该节点未配置可启动的 Copilot API");
      error.status = 409;
      throw error;
    }

    const lockKey = `${nodeId}:copilot-api`;
    if (this.activeUpdates.has(lockKey)) {
      const error = new Error("该 Copilot API 操作已在执行");
      error.status = 409;
      throw error;
    }

    this.activeUpdates.add(lockKey);
    try {
      let output;
      let artifact = null;
      if (management.transport === "ssh") {
        output = await this.#remoteUpdate(node, REMOTE_COPILOT_START_SCRIPT);
      } else if (management.transport === "windows-ssh") {
        output = await this.#windowsRemotePowerShell(
          node,
          WINDOWS_REMOTE_START_SCRIPT,
          60000,
        );
      } else {
        const scan = await this.artifactCatalog.scan();
        const selected = scan.artifacts[0];
        if (!selected) {
          const error = new Error("没有可用于启动本机 Copilot API 的有效构建");
          error.status = 409;
          throw error;
        }
        artifact = await this.artifactCatalog.resolve(selected.id);
        output = await this.#localCopilotStart(artifact);
      }

      const refreshed = await this.status([nodeId]);
      const status = refreshed.nodes[0];
      if (status?.copilotApi?.service !== "active") {
        throw new Error("Copilot API 启动命令完成，但服务未进入 active 状态");
      }
      return {
        ok: true,
        nodeId,
        component: "copilot-api",
        artifact: artifact
          ? {
              id: artifact.id,
              version: artifact.version,
              buildDate: artifact.buildDate,
              label: artifact.label,
              sha256: artifact.sha256,
            }
          : null,
        message: cleanMessage(output) || "Copilot API 已启动",
        status,
      };
    } catch (cause) {
      if (cause?.status) throw cause;
      const error = new Error(
        `启动失败：${cleanMessage(cause?.message) || "未知错误"}`,
      );
      error.status = 502;
      error.expose = true;
      throw error;
    } finally {
      this.activeUpdates.delete(lockKey);
    }
  }

  async #latestVersion(packageName) {
    const cached = this.registryCache.get(packageName);
    if (cached?.expiresAt > Date.now()) return cached.version;
    try {
      const registryNode = this.config.nodes.find(
        (node) => node.management?.transport === "ssh",
      );
      const command = registryNode ? "ssh" : this.platform === "win32" ? "npm.cmd" : "npm";
      const args = registryNode
        ? [
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=8",
            registryNode.management.sshHost,
            "env",
            `PATH=${registryNode.management.runtimeBin}:/usr/local/bin:/usr/bin:/bin:/snap/bin`,
            "npm",
            "view",
            `${packageName}@latest`,
            "version",
            "--silent",
            "--registry=https://registry.npmjs.org",
          ]
        : [
            "view",
            `${packageName}@latest`,
            "version",
            "--silent",
            "--registry=https://registry.npmjs.org",
          ];
      const result = await this.runCommand(
        command,
        args,
        { timeoutMs: 15000 },
      );
      const value = cleanVersion(result.stdout.split(/\r?\n/).filter(Boolean).at(-1));
      this.registryCache.set(packageName, {
        version: value,
        expiresAt: Date.now() + REGISTRY_CACHE_MS,
      });
      return value;
    } catch {
      return null;
    }
  }

  async #nodeStatus(node, latest) {
    if (!node.management) {
      return {
        id: node.id,
        name: node.name,
        region: node.region,
        reachable: false,
        error: "未配置管理连接",
        copilotApi: componentStatus({ mode: "none", canUpdate: false }),
        codexCli: componentStatus({ mode: "none", canUpdate: false }),
      };
    }
    try {
      const details =
        node.management.transport === "ssh"
          ? await this.#remoteStatus(node)
          : node.management.transport === "windows-ssh"
            ? await this.#windowsRemoteStatus(node)
            : await this.#localStatus();
      return {
        id: node.id,
        name: node.name,
        region: node.region,
        reachable: true,
        error: null,
        copilotApi: componentStatus({
          currentVersion: details.copilotVersion,
          latestVersion: latest.copilotLatest,
          currentBuildId: details.copilotBuildId,
          latestBuildId: latest.copilotLatestBuildId,
          canUpdate:
            node.management.transport !== "windows-ssh" &&
            node.management.copilotApi !== "none",
          canStart:
            node.management.transport === "local" ||
            node.management.copilotApi === "systemd-user" ||
            node.management.copilotApi === "windows-startup",
          canDeploy:
            node.management.transport === "local" ||
            node.management.copilotApi === "systemd-user",
          mode: node.management.copilotApi,
          service: details.copilotService,
          note:
            node.management.transport === "local"
              ? "npx 进程；更新时会短暂重启"
              : node.management.transport === "windows-ssh"
                ? "Windows startup launcher"
                : "systemd user service",
        }),
        codexCli: componentStatus({
          currentVersion: details.codexVersion,
          latestVersion: node.management.codexCli === "desktop-managed" ? null : latest.codexLatest,
          canUpdate: node.management.codexCli === "npm-global",
          mode: node.management.codexCli,
          service: node.management.codexCli === "desktop-managed" ? "managed" : "installed",
          note: node.management.codexCli === "desktop-managed"
            ? "随 Codex 桌面应用自动更新"
            : "npm global stable channel",
        }),
      };
    } catch (error) {
      return {
        id: node.id,
        name: node.name,
        region: node.region,
        reachable: false,
        error: cleanMessage(error.message, 240) || "管理连接不可用",
        copilotApi: componentStatus({
          latestVersion: latest.copilotLatest,
          latestBuildId: latest.copilotLatestBuildId,
          canUpdate:
            node.management.transport !== "windows-ssh" &&
            node.management.copilotApi !== "none",
          canStart:
            node.management.transport === "local" ||
            node.management.copilotApi === "systemd-user" ||
            node.management.copilotApi === "windows-startup",
          canDeploy:
            node.management.transport === "local" ||
            node.management.copilotApi === "systemd-user",
          mode: node.management.copilotApi,
        }),
        codexCli: componentStatus({
          latestVersion: node.management.codexCli === "desktop-managed" ? null : latest.codexLatest,
          canUpdate: node.management.codexCli === "npm-global",
          mode: node.management.codexCli,
          note: node.management.codexCli === "desktop-managed" ? "随 Codex 桌面应用自动更新" : "",
        }),
      };
    }
  }

  async #remoteStatus(node) {
    const result = await this.runCommand(
      "ssh",
      [
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=8",
        node.management.sshHost,
        "env",
        `PATH=${node.management.runtimeBin}:/usr/local/bin:/usr/bin:/bin:/snap/bin`,
        "bash",
        "-s",
      ],
      { input: REMOTE_STATUS_SCRIPT, timeoutMs: 15000 },
    );
    const values = parseKeyValues(result.stdout);
    return {
      copilotVersion: cleanVersion(values.COPILOT_VERSION),
      copilotBuildId: values.COPILOT_BUILD_ID || null,
      copilotBuildDate: values.COPILOT_BUILD_DATE || null,
      copilotBuildLabel: values.COPILOT_BUILD_LABEL || null,
      codexVersion: cleanVersion(values.CODEX_VERSION),
      copilotService: values.COPILOT_SERVICE || "unknown",
    };
  }

  async #windowsRemoteStatus(node) {
    const result = await this.#windowsRemotePowerShell(
      node,
      WINDOWS_REMOTE_STATUS_SCRIPT,
      20000,
    );
    const values = parseKeyValues(result.stdout);
    return {
      copilotVersion: cleanVersion(values.COPILOT_VERSION),
      copilotBuildId: values.COPILOT_BUILD_ID || null,
      copilotBuildDate: values.COPILOT_BUILD_DATE || null,
      copilotBuildLabel: values.COPILOT_BUILD_LABEL || null,
      codexVersion: cleanVersion(values.CODEX_VERSION),
      copilotService: values.COPILOT_SERVICE || "unknown",
    };
  }

  async #windowsRemotePowerShell(node, script, timeoutMs) {
    return this.runCommand(
      "ssh",
      [
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=8",
        node.management.sshHost,
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

  async #localStatus() {
    if (this.platform !== "win32") throw new Error("本机管理器仅支持 Windows");
    const result = await this.runCommand(
      "pwsh.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", LOCAL_STATUS_SCRIPT],
      { timeoutMs: 20000 },
    );
    const parsed = JSON.parse(result.stdout);
    return {
      copilotVersion: cleanVersion(parsed.copilotVersion),
      copilotBuildId: parsed.copilotBuildId || null,
      copilotBuildDate: parsed.copilotBuildDate || null,
      copilotBuildLabel: parsed.copilotBuildLabel || null,
      codexVersion: cleanVersion(parsed.codexVersion),
      copilotService: parsed.copilotService || "unknown",
    };
  }

  async #localCopilotStart(artifact, options = {}) {
    if (this.platform !== "win32") {
      throw new Error("本机 Copilot API 启动器仅支持 Windows");
    }
    const result = await this.runCommand(
      "pwsh.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        LOCAL_COPILOT_START_SCRIPT,
      ],
      {
        timeoutMs: 60000,
        spawnOptions: {
          env: {
            ...process.env,
            CODEX_PORTAL_ARTIFACT_ID: artifact.id,
            CODEX_PORTAL_BUILD_DATE: artifact.buildDate,
            CODEX_PORTAL_BUILD_LABEL: artifact.label,
            CODEX_PORTAL_FORCE_RESTART: options.forceRestart ? "true" : "false",
            CODEX_PORTAL_PACKAGE_PATH: artifact.path,
            CODEX_PORTAL_PACKAGE_SHA256: artifact.sha256,
            CODEX_PORTAL_PACKAGE_VERSION: artifact.version,
          },
        },
      },
    );
    return result.stdout || result.stderr;
  }

  async #remoteUpdate(node, script) {
    const result = await this.runCommand(
      "ssh",
      [
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=8",
        node.management.sshHost,
        "env",
        `PATH=${node.management.runtimeBin}:/usr/local/bin:/usr/bin:/bin:/snap/bin`,
        "bash",
        "-s",
      ],
      { input: script, timeoutMs: this.config.updateTimeoutMs },
    );
    return result.stdout || result.stderr;
  }

  async #remoteArtifactUpdate(node, artifact) {
    const stage = `${artifact.id}-${artifact.sha256.slice(0, 12)}`;
    const remoteStage =
      `$HOME/.local/share/copilot-api/portal-updates/${stage}`;
    await this.runCommand(
      "ssh",
      [
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=8",
        node.management.sshHost,
        "env",
        `PATH=${node.management.runtimeBin}:/usr/local/bin:/usr/bin:/bin:/snap/bin`,
        `PORTAL_STAGE=${remoteStage}`,
        "bash",
        "-s",
      ],
      {
        input: REMOTE_ARTIFACT_PREPARE_SCRIPT,
        timeoutMs: 15000,
      },
    );
    await this.runCommand(
      "scp",
      [
        "-q",
        "-p",
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=8",
        artifact.path,
        `${node.management.sshHost}:.local/share/copilot-api/portal-updates/${stage}/copilot-api.tgz`,
      ],
      { timeoutMs: 60000 },
    );
    const result = await this.runCommand(
      "ssh",
      [
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=8",
        node.management.sshHost,
        "env",
        `PATH=${node.management.runtimeBin}:/usr/local/bin:/usr/bin:/bin:/snap/bin`,
        `PORTAL_STAGE=${remoteStage}`,
        `PORTAL_ARTIFACT_ID=${artifact.id}`,
        `PORTAL_PACKAGE_VERSION=${artifact.version}`,
        `PORTAL_PACKAGE_SHA256=${artifact.sha256}`,
        `PORTAL_BUILD_DATE=${artifact.buildDate}`,
        `PORTAL_BUILD_LABEL=${artifact.label}`,
        "bash",
        "-s",
      ],
      {
        input: REMOTE_COPILOT_ARTIFACT_UPDATE_SCRIPT,
        timeoutMs: Math.max(this.config.updateTimeoutMs, 600000),
      },
    );
    return result.stdout || result.stderr;
  }

  async #localCopilotUpdate() {
    if (this.platform !== "win32") throw new Error("本机 copilot-api 更新器仅支持 Windows");
    const latest = await this.#latestVersion("@jeffreycao/copilot-api");
    if (!latest) throw new Error("无法从 npm registry 获取最新 copilot-api 版本");
    const result = await this.runCommand(
      "pwsh.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", LOCAL_COPILOT_UPDATE_SCRIPT],
      {
        timeoutMs: this.config.updateTimeoutMs,
        spawnOptions: {
          env: { ...process.env, CODEX_PORTAL_TARGET_VERSION: latest },
        },
      },
    );
    return result.stdout || result.stderr;
  }
}

export const managerInternals = Object.freeze({
  REMOTE_ARTIFACT_PREPARE_SCRIPT,
  REMOTE_COPILOT_ARTIFACT_UPDATE_SCRIPT,
  REMOTE_COPILOT_START_SCRIPT,
  REMOTE_STATUS_SCRIPT,
  LOCAL_COPILOT_START_SCRIPT,
  cleanVersion,
  componentStatus,
  parseKeyValues,
});
