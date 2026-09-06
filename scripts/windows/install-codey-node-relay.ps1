[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$SourceRoot,

    [string]$SigningKeyPath = "$HOME\.config\codey-node-relay\signing.key",

    [string]$AllowedOrigin =
        "https://codey.ambitiouspond-a4ecfeb2.japaneast.azurecontainerapps.io"
)

$ErrorActionPreference = "Stop"
$source = (Resolve-Path -LiteralPath $SourceRoot).Path
$key = (Resolve-Path -LiteralPath $SigningKeyPath).Path
$runtime = Join-Path $HOME ".local\share\codey-node-relay"
$config = Join-Path $HOME ".config\codey-node-relay"
$log = Join-Path $config "relay.log"
$launcher = Join-Path $config "start-relay.ps1"
$node = (Get-Command node -ErrorAction Stop).Source

New-Item -ItemType Directory -Path (Join-Path $runtime "node-relay") -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $runtime "src") -Force | Out-Null
New-Item -ItemType Directory -Path $config -Force | Out-Null

Copy-Item -LiteralPath (Join-Path $source "node-relay\server.mjs") `
    -Destination (Join-Path $runtime "node-relay\server.mjs") -Force
foreach ($name in @(
    "client-ticket.mjs",
    "config.mjs",
    "node-session-history.mjs",
    "metrics.mjs"
)) {
    Copy-Item -LiteralPath (Join-Path $source "src\$name") `
        -Destination (Join-Path $runtime "src\$name") -Force
}

$launcherBody = @"
`$ErrorActionPreference = "Stop"
`$env:CODEY_RELAY_NODE_ID = "local"
`$env:CODEY_RELAY_NODE_NAME = "本机"
`$env:CODEY_RELAY_NODE_REGION = "Local"
`$env:CODEY_RELAY_NODE_ACCENT = "#8b5cf6"
`$env:CODEY_RELAY_ALLOWED_ORIGIN = "$AllowedOrigin"
`$env:CODEY_RELAY_SIGNING_KEY_FILE = "$key"
`$env:CODEY_RELAY_SESSION_ROOT = "$HOME\.codex\sessions"
`$env:CODEY_RELAY_HOST = "127.0.0.1"
`$env:CODEY_RELAY_PORT = "4242"
& "$node" "$runtime\node-relay\server.mjs" *>> "$log"
"@
Set-Content -LiteralPath $launcher -Value $launcherBody -Encoding utf8

$principal = "$env:USERDOMAIN\$env:USERNAME"
& icacls.exe $config /inheritance:r /grant:r "${principal}:(OI)(CI)F" | Out-Null
& icacls.exe $key /inheritance:r /grant:r "${principal}:F" | Out-Null

$action = New-ScheduledTaskAction `
    -Execute (Get-Command powershell.exe).Source `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$launcher`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $principal
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask `
    -TaskName "Codey Node Relay" `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -User $principal `
    -Force | Out-Null

Get-NetTCPConnection -State Listen -LocalPort 4242 -ErrorAction SilentlyContinue |
    ForEach-Object {
        $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($_.OwningProcess)"
        if ($process.CommandLine -match "codey-node-relay.+server\.mjs") {
            Stop-Process -Id $_.OwningProcess
        }
    }
Start-ScheduledTask -TaskName "Codey Node Relay"

$ready = $false
for ($attempt = 0; $attempt -lt 40; $attempt++) {
    Start-Sleep -Milliseconds 500
    try {
        $health = Invoke-RestMethod -Uri "http://127.0.0.1:4242/healthz" -TimeoutSec 2
        if ($health.ok -and $health.nodeId -eq "local") {
            $ready = $true
            break
        }
    }
    catch {
    }
}
if (-not $ready) {
    throw "Codey Node Relay did not become healthy on port 4242"
}

[pscustomobject]@{
    Status = "CODEY_RELAY_INSTALLED"
    Node = "local"
    Port = 4242
    Task = "Codey Node Relay"
    Runtime = $runtime
}
