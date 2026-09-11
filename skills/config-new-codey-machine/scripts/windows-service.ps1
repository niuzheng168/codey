#requires -Version 5.1
[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$ConfigPath,
    [Parameter(Mandatory = $true)][ValidateSet('codey', 'tunnel', 'renew')][string]$Component)
. (Join-Path $PSScriptRoot 'windows-common.ps1')

$owner = Get-CodeyOwner
$config = Read-CodeyJson $ConfigPath
if ($config.schema -ne 2 -or $config.kind -ne 'codey-windows-oneclick' -or
    $config.layout -ne 'npm-codey-package' -or
    $config.ownerSid -ne $owner.Sid -or $config.ownerHome -ne $owner.Home -or
    $config.computer -cne $owner.Computer -or
    $config.nodeId -notmatch '^n-[a-f0-9]{24}$' -or $config.runnerPath -ne $PSCommandPath) {
    throw 'Task must run as the original logged-on owner using its pinned runtime.'
}
$null = Assert-CodeyPath $ConfigPath $config.configRoot
$null = Assert-CodeyPath $config.nodeExe $config.runtimeRoot
$null = Assert-CodeyPath $config.devtunnelExe $config.runtimeRoot
$helpers = @($PSCommandPath, (Join-Path $PSScriptRoot 'windows-common.ps1'),
    (Join-Path $PSScriptRoot 'windows-process.cs'), $config.helperPath)
if ($config.PSObject.Properties['taskHostExe']) { $helpers += $config.taskHostExe }
foreach ($file in $helpers) {
    $null = Assert-CodeyPath $file $config.runtimeRoot
    $expected = $config.helperHashes.PSObject.Properties[[IO.Path]::GetFileName($file)]
    if (-not $expected -or (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $expected.Value) {
        throw 'Installed watchdog helper hash mismatch.'
    }
}
Initialize-CodeyJob
foreach ($name in @('PSModulePath', 'CODEX_THREAD_ID', 'CODEX_PARENT_THREAD_ID', 'CODEX_INTERNAL_ORIGINATOR_OVERRIDE')) {
    [Environment]::SetEnvironmentVariable($name, $null, 'Process')
}
$lockName = "Local\CodeyMachine-$($config.nodeId)-$Component"
$mutex = [Threading.Mutex]::new($false, $lockName)
$held = $false
try {
    try { $held = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $held = $true }
    if (-not $held) { throw 'This component already has a supervisor.' }
    if ($Component -eq 'renew') { Start-Sleep -Seconds 1800 }
    while ($true) {
        $delay = 5
        try {
            # Re-read keys/config after every restart; don't retain stale provider credentials.
            $current = Read-CodeyJson $ConfigPath
            if ($current.nodeId -ne $config.nodeId -or $current.ownerSid -ne $owner.Sid -or
                $current.releaseDirectory -ne $config.releaseDirectory) { throw 'Runtime changed; restart the task explicitly.' }
            $service = $current.services.PSObject.Properties[$Component].Value
            foreach ($property in $service.environment.PSObject.Properties) {
                [Environment]::SetEnvironmentVariable($property.Name, [string]$property.Value, 'Process')
            }
            $stdout = Join-Path $config.stateRoot "$Component.stdout.log"
            $stderr = Join-Path $config.stateRoot "$Component.stderr.log"
            $child = $null
            try {
                # A Windows Job Object makes Task Scheduler Stop kill this whole
                # service tree, not just the hidden PowerShell watchdog.
                $info = [Diagnostics.ProcessStartInfo]::new()
                $info.FileName = $service.executable
                $info.Arguments = Join-CodeyArguments @($service.arguments)
                $info.WorkingDirectory = $service.workingDirectory
                $child = [CodeyBackgroundProcess]::new($info, $stdout, $stderr)
                Write-CodeyFile (Join-Path $config.stateRoot "$Component.status.json") `
                    (@{ state = 'running'; pid = $child.Process.Id; time = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json)
                if ($Component -eq 'renew') {
                    if (-not $child.Process.WaitForExit(120000)) { throw 'Token renewal timed out.' }
                    $delay = if ($child.Process.ExitCode -eq 0) { 21600 } else { 120 }
                } else { $child.Process.WaitForExit() }
                $exitCode = $child.Process.ExitCode
                # Kill any leftover descendants before waiting for pipe EOF.
            } finally { if ($child) { $child.Dispose() } }
            Write-CodeyFile (Join-Path $config.stateRoot "$Component.status.json") `
                (@{ state = 'waiting'; exitCode = $exitCode; retrySeconds = $delay
                    time = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json)
        } catch {
            $delay = 30
            Write-CodeyFile (Join-Path $config.stateRoot "$Component.error.log") `
                ("{0:o} Component failed; see private stdout/stderr logs.`n" -f [DateTime]::UtcNow)
            Write-CodeyFile (Join-Path $config.stateRoot "$Component.status.json") `
                (@{ state = 'retrying'; retrySeconds = $delay; time = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json)
        }
        Start-Sleep -Seconds $delay
    }
} finally {
    if ($held) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
