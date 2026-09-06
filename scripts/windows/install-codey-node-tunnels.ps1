[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$config = Join-Path $HOME ".config\codey-node-relay"
$ssh = (Get-Command ssh.exe -ErrorAction Stop).Source
$powershell = (Get-Command powershell.exe -ErrorAction Stop).Source
$principal = "$env:USERDOMAIN\$env:USERNAME"
$targets = @(
    @{ Id = "westus2"; Port = 4243 },
    @{ Id = "jpe2"; Port = 4244 },
    @{ Id = "jpe3"; Port = 4245 },
    @{ Id = "zhn-a100"; Port = 4246 }
)

New-Item -ItemType Directory -Path $config -Force | Out-Null

foreach ($target in $targets) {
    $taskName = "Codey Node Tunnel $($target.Id)"
    $launcher = Join-Path $config "start-tunnel-$($target.Id).ps1"
    $log = Join-Path $config "tunnel-$($target.Id).log"
    $forward = "127.0.0.1:$($target.Port):127.0.0.1:4242"
    $launcherBody = @"
`$ErrorActionPreference = "Stop"
& "$ssh" -N -T `
    -o BatchMode=yes `
    -o ExitOnForwardFailure=yes `
    -o ServerAliveInterval=30 `
    -o ServerAliveCountMax=3 `
    -o LogLevel=ERROR `
    -L "$forward" `
    "$($target.Id)" *>> "$log"
exit `$LASTEXITCODE
"@
    Set-Content -LiteralPath $launcher -Value $launcherBody -Encoding utf8

    Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue |
        Unregister-ScheduledTask -Confirm:$false
    Get-NetTCPConnection -State Listen -LocalPort $target.Port -ErrorAction SilentlyContinue |
        ForEach-Object {
            $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($_.OwningProcess)"
            if (
                $process.Name -eq "ssh.exe" -and
                $process.CommandLine -match [regex]::Escape($forward)
            ) {
                Stop-Process -Id $_.OwningProcess
            }
            else {
                throw "Port $($target.Port) is owned by an unexpected process"
            }
        }

    $action = New-ScheduledTaskAction `
        -Execute $powershell `
        -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$launcher`""
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $principal
    $settings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -ExecutionTimeLimit ([TimeSpan]::Zero) `
        -RestartCount 999 `
        -RestartInterval (New-TimeSpan -Minutes 1)
    Register-ScheduledTask `
        -TaskName $taskName `
        -Action $action `
        -Trigger $trigger `
        -Settings $settings `
        -User $principal `
        -Force | Out-Null
    Start-ScheduledTask -TaskName $taskName
}

$deadline = (Get-Date).AddSeconds(30)
do {
    Start-Sleep -Milliseconds 500
    $ready = @(
        $targets | Where-Object {
            Get-NetTCPConnection -State Listen -LocalPort $_.Port -ErrorAction SilentlyContinue
        }
    ).Count -eq $targets.Count
} until ($ready -or (Get-Date) -ge $deadline)

if (-not $ready) {
    throw "One or more Codey node tunnels did not become ready"
}

$results = foreach ($target in $targets) {
    $health = Invoke-RestMethod `
        -Uri "http://127.0.0.1:$($target.Port)/healthz" `
        -TimeoutSec 5
    if (-not $health.ok -or $health.nodeId -ne $target.Id) {
        throw "Tunnel $($target.Id) returned an unexpected relay identity"
    }
    $listener = Get-NetTCPConnection -State Listen -LocalPort $target.Port |
        Select-Object -First 1
    [pscustomobject]@{
        Node = $target.Id
        Port = $target.Port
        ProcessId = $listener.OwningProcess
        Task = "Codey Node Tunnel $($target.Id)"
    }
}

$results
