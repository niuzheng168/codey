[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$PlanPath
)

$ErrorActionPreference = 'Stop'
$plan = Get-Content -LiteralPath $PlanPath -Raw -Encoding utf8 | ConvertFrom-Json
$manifest = Get-Content -LiteralPath $plan.ManifestPath -Raw -Encoding utf8 | ConvertFrom-Json
$configPath = Join-Path $manifest.DataHome 'config.json'
$configBackup = Join-Path $plan.BackupDirectory 'config-before-cutover.json'
$resultPath = Join-Path $plan.BackupDirectory 'cutover-result.json'
$stoppedOldProcess = $false
$configChanged = $false

function Write-Result {
    param([string]$Status, [string]$Message)
    [ordered]@{
        status = $Status
        message = $Message
        checkedAt = [DateTime]::UtcNow.ToString('o')
    } | ConvertTo-Json | Set-Content -LiteralPath $resultPath -Encoding utf8
}

function Test-Gateway {
    param([bool]$RequireHttps)
    try {
        $models = Invoke-RestMethod -Uri 'http://127.0.0.1:4141/v1/models' -TimeoutSec 3
        if (-not ($models.data | Where-Object { $_.id -eq 'gpt-6-astra' })) {
            return $false
        }
        if ($RequireHttps) {
            $health = Invoke-RestMethod -Uri 'https://127.0.0.1:8443/healthz' -TimeoutSec 3
            return $health.ok -and $health.nodeId -eq 'local'
        }
        return $true
    } catch {
        return $false
    }
}

try {
    Write-Result 'validating' 'Checking the exact current gateway before cutover.'
    $old = Get-CimInstance Win32_Process -Filter "ProcessId=$($plan.OldPid)"
    if (-not $old -or $old.CommandLine -ne $plan.OldCommandLine -or
        $old.ExecutablePath -ne $plan.OldNodeExe) {
        throw 'The old gateway process no longer matches the recorded identity.'
    }
    $listener = Get-NetTCPConnection -State Listen -LocalPort 4141 -ErrorAction Stop
    if (@($listener.OwningProcess | Select-Object -Unique).Count -ne 1 -or
        $listener[0].OwningProcess -ne $plan.OldPid) {
        throw 'Port 4141 is no longer owned by the recorded gateway.'
    }
    if (Get-NetTCPConnection -State Listen -LocalPort 8443 -ErrorAction SilentlyContinue) {
        throw 'Port 8443 is already in use; refusing to replace an unrelated service.'
    }
    if (-not (Test-Path -LiteralPath $plan.OldEntryPath -PathType Leaf)) {
        throw 'The old gateway entrypoint is unavailable for rollback.'
    }
    if (Test-Path -LiteralPath $configBackup) {
        throw 'A cutover backup already exists. Inspect the earlier attempt first.'
    }

    Copy-Item -LiteralPath $configPath -Destination $configBackup
    # Explicit UTF-8 keeps non-ASCII prompts intact under Windows PowerShell 5.1.
    $config = Get-Content -LiteralPath $configPath -Raw -Encoding utf8 | ConvertFrom-Json
    $prepared = Get-Content -LiteralPath $plan.PreparedConfigPath -Raw -Encoding utf8 | ConvertFrom-Json
    # Add the private internal history key without replacing any existing
    # provider credentials, models, mappings, transport settings, or API keys.
    $config.auth | Add-Member -NotePropertyName sessionHistoryApiKey `
        -NotePropertyValue $prepared.auth.sessionHistoryApiKey -Force
    $temporary = "$configPath.codey-next"
    [IO.File]::WriteAllText(
        $temporary,
        ($config | ConvertTo-Json -Depth 50) + "`n",
        [Text.UTF8Encoding]::new($false)
    )
    # Windows ReplaceFile preserves the destination DACL. Avoid loading the
    # PowerShell 7 Security module into a Windows PowerShell 5.1 helper through
    # an inherited PSModulePath just to reapply that same DACL.
    # Windows PowerShell 5.1 marshals $null to an empty string for this API,
    # so use an explicit backup filename rather than its nullable parameter.
    [IO.File]::Replace(
        $temporary,
        $configPath,
        (Join-Path $plan.BackupDirectory 'config-replace-backup.json')
    )
    $configChanged = $true

    Write-Result 'switching' 'Restarting only the identified local gateway.'
    Stop-Process -Id $plan.OldPid -ErrorAction Stop
    $stoppedOldProcess = $true
    Wait-Process -Id $plan.OldPid -Timeout 10 -ErrorAction SilentlyContinue
    Start-ScheduledTask -TaskName $plan.TaskName

    $ready = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        if (Test-Gateway -RequireHttps $true) {
            $ready = $true
            break
        }
        Start-Sleep -Seconds 1
    }
    if (-not $ready) {
        throw 'The replacement did not pass HTTP and verified HTTPS health checks.'
    }
    $ports = Get-NetTCPConnection -State Listen -LocalPort 4141,8443
    if (@($ports.OwningProcess | Select-Object -Unique).Count -ne 1) {
        throw 'HTTP and HTTPS are not served by the same process.'
    }
    Write-Result 'ready' 'One gateway process serves 4141 and loopback HTTPS 8443.'
    exit 0
} catch {
    $failure = $_.Exception.Message
    if ($stoppedOldProcess) {
        Stop-ScheduledTask -TaskName $plan.TaskName -ErrorAction SilentlyContinue
        Disable-ScheduledTask -TaskName $plan.TaskName -ErrorAction SilentlyContinue | Out-Null
        # Do not stop any other Node/Codex process, even during rollback.
        Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
            Where-Object {
                $_.CommandLine -like "*$($manifest.EntryPath)*" -and
                $_.CommandLine -match '--port\s+4141'
            } |
            ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }
    }
    if ($configChanged) {
        Copy-Item -LiteralPath $configBackup -Destination $configPath -Force
    }
    if ($stoppedOldProcess) {
        Start-Process -FilePath $plan.OldNodeExe `
            -ArgumentList @("`"$($plan.OldEntryPath)`"", 'start') `
            -WindowStyle Hidden `
            -RedirectStandardOutput (Join-Path $plan.BackupDirectory 'rollback.stdout.log') `
            -RedirectStandardError (Join-Path $plan.BackupDirectory 'rollback.stderr.log') | Out-Null
        for ($attempt = 0; $attempt -lt 30; $attempt++) {
            if (Test-Gateway -RequireHttps $false) {
                Write-Result 'rolled-back' $failure
                exit 1
            }
            Start-Sleep -Seconds 1
        }
        Write-Result 'rollback-needs-attention' $failure
    } else {
        Write-Result 'validation-failed' $failure
    }
    exit 1
}
