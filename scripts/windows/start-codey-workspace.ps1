[CmdletBinding()]
param(
    [string]$ConfigPath = (Join-Path $env:USERPROFILE '.config\codey-windows-workspace\runtime.json')
)

$ErrorActionPreference = 'Stop'
$config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
if ($config.schema -ne 1 -or $identity.User.Value -ne $config.ownerSid) {
    throw 'Workspace runtime must run as the configured Windows owner.'
}
if ($config.host -ne '127.0.0.1' -or $config.port -ne 3001) {
    throw 'This Windows Workspace launcher permits loopback port 3001 only.'
}
$enrollment = Get-Content -LiteralPath $config.enrollmentFile -Raw | ConvertFrom-Json
if ($enrollment.nodeId -ne $config.nodeId -or
    $enrollment.workspaceSsoKey -notmatch '^[A-Za-z0-9_-]{43}$' -or
    $enrollment.principalId -notmatch '^[a-z0-9-]{1,80}$' -or
    $enrollment.username -notmatch '^[a-z][a-z0-9_-]{0,31}$') {
    throw 'The owner-bound Workspace enrollment is invalid.'
}
foreach ($file in @($config.nodeExe, $config.entryPath, $config.tlsCertificate, $config.tlsPrivateKey, $config.codexExe)) {
    if (-not [IO.Path]::IsPathRooted($file) -or -not (Test-Path -LiteralPath $file -PathType Leaf)) {
        throw 'A pinned Workspace runtime input is missing.'
    }
}
if ((Get-FileHash -LiteralPath $config.nodeExe -Algorithm SHA256).Hash -ne $config.nodeSha256) {
    throw 'The isolated Node runtime hash changed.'
}
$listeners = @(Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue)
if ($listeners.Count) {
    $ours = @($listeners | Where-Object {
        $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($_.OwningProcess)" -ErrorAction SilentlyContinue
        $_.LocalAddress -eq '127.0.0.1' -and
            $process.ExecutablePath -eq $config.nodeExe -and
            $process.CommandLine.Contains($config.entryPath)
    })
    if ($ours.Count -eq $listeners.Count) {
        Write-Output 'The configured Windows Workspace is already running; nothing restarted.'
        exit 0
    }
    throw 'Port 3001 belongs to another process; no existing process was changed.'
}

# Process-local environment only. Do not modify the owner's Codex config,
# provider authentication, system PATH, or protected copilot-api process.
foreach ($name in @('CODEX_THREAD_ID', 'CODEX_PARENT_THREAD_ID', 'CODEX_INTERNAL_ORIGINATOR_OVERRIDE')) {
    [Environment]::SetEnvironmentVariable($name, $null, 'Process')
}
$env:NODE_ENV = 'production'
$env:HOST = '127.0.0.1'
$env:SERVER_PORT = '3001'
$env:CODEY_MANAGED = 'true'
$env:CODEY_PORTAL_SSO = 'true'
$env:CODEY_PORTAL_NODE_ID = $enrollment.nodeId
$env:CODEY_PORTAL_USERNAME = $enrollment.username
$env:CODEY_PORTAL_PRINCIPAL_ID = $enrollment.principalId
$env:CODEY_PORTAL_SSO_KEY = $enrollment.workspaceSsoKey
$env:CODEY_PORTAL_TLS_CERT = $config.tlsCertificate
$env:CODEY_PORTAL_TLS_KEY = $config.tlsPrivateKey
$env:DATABASE_PATH = $config.databasePath
$env:CODEX_HOME = $config.codexHome
$env:CODEY_CODEX_EXECUTABLE = $config.codexExe
$env:WORKSPACES_ROOT = $config.workspaceRoot
$env:VITE_IS_PLATFORM = 'false'
$env:PATH = (Split-Path -Parent $config.nodeExe) + ';' +
    (Split-Path -Parent $config.codexExe) + ';' + $env:PATH
$dataDirectory = Split-Path -Parent $config.databasePath
if (-not (Test-Path -LiteralPath $dataDirectory)) {
    New-Item -ItemType Directory -Path $dataDirectory | Out-Null
}
Set-Location -LiteralPath $config.releaseRoot
& $config.nodeExe $config.entryPath
exit $LASTEXITCODE
