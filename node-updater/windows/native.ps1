#requires -Version 5.1
# Only original-owner Codey tasks can be switched. No tunnel/tool/task registration.
[CmdletBinding()]
param([ValidateSet('snapshot', 'recovery-snapshot', 'idle', 'apply', 'verify', 'recover')][string]$Operation,
      [string]$InputFile)
$wantedOperation = $Operation
$wantedInput = $InputFile
. (Join-Path $PSScriptRoot 'lib\update-windows.ps1') -Library
$Operation = $wantedOperation
$InputFile = $wantedInput

function Get-AgentProtectedHashes {
    # Core discovery first validates owner/path/junction bindings.
    $null = Get-ProtectedHashes $config
    $probePath = Join-Path $owner.Home '.local\share\codey-updater\probe'
    $result = Invoke-CodeyProcess $config.nodeExe @((Join-Path $PSScriptRoot 'agent.mjs'), 'hashes', $configFile, $probePath) `
        -WorkingDirectory $owner.Home -TimeoutSeconds 30
    return ($result.Stdout | ConvertFrom-Json)
}
function Assert-AgentProtected {
    param($Expected)
    $actual = Get-AgentProtectedHashes
    Require-Update (@($actual.PSObject.Properties).Count -eq @($Expected.PSObject.Properties).Count) 'Protected configuration changed.'
    foreach ($property in $Expected.PSObject.Properties) {
        Require-Update ($actual.PSObject.Properties[$property.Name] -and $actual.($property.Name) -eq $property.Value) `
            'A tool, identity, model or helper configuration changed.'
    }
}
function Get-OtherAgentTasks {
    $result = [ordered]@{}
    foreach ($name in @('tunnel', 'renew')) {
        $task = (Get-CodeyTaskFolder).Folder.GetTask("Codey Machine $($config.nodeId) $name")
        Assert-CodeyTask $task $config $configFile $name
        $bytes = [Text.Encoding]::UTF8.GetBytes([string]$task.Definition.XmlText)
        $hash = [Security.Cryptography.SHA256]::Create()
        try { $digest = -join ($hash.ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') }) } finally { $hash.Dispose() }
        # Retry triggers advance LastRunTime even when the same host keeps running.
        $result[$name] = @{ definition = $digest; enabled = $task.Enabled
            instances = @($task.GetInstances(0) | ForEach-Object { $_.InstanceGuid } | Sort-Object) }
    }
    return $result
}
function Get-AgentSnapshot {
    param([switch]$RequireReady)
    $null = Get-ProtectedHashes $config
    $pidValue = 0
    if ($RequireReady) {
        Require-Update ($config.ready -and $task.Enabled -and $task.State -eq 4) 'Codey is not running.'
        $status = Read-UpdateJson (Join-Path $config.stateRoot 'codey.status.json')
        Require-Update ($status.state -eq 'running' -and $status.pid -gt 0) 'Codey process status is unavailable.'
        $process = Get-CimInstance Win32_Process -Filter ("ProcessId=" + [int]$status.pid) -ErrorAction Stop
        $processOwner = Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid -ErrorAction Stop
        Require-Update ($processOwner.Sid -eq $owner.Sid -and $process.ExecutablePath -ieq $config.nodeExe -and
            $process.CommandLine -match ([regex]::Escape($config.codeyBin) + '"?\s+"?start(?:\s|"|$)')) `
            'The running Codey process does not match runtime.json.'
        $pidValue = [int]$status.pid
        $version = (Read-UpdateJson (Join-Path $config.codeyDirectory 'package.json')).version
        Invoke-UpdateProbe $config (Join-Path $PSScriptRoot 'lib') 'health' $version
    }
    return @{ ok = $true; kind = 'windows-managed'; root = $config.codeyDirectory; node = $config.nodeExe
        jobsRoot = $jobsRoot; pid = $pidValue; services = @("Codey Machine $($config.nodeId) codey")
        otherTasks = Get-OtherAgentTasks }
}
function Invoke-AgentModels {
    param([string]$RequestFile)
    $result = Invoke-CodeyProcess $config.nodeExe @((Join-Path $PSScriptRoot 'verify.mjs'), $RequestFile) `
        -WorkingDirectory $owner.Home -TimeoutSeconds 240
    $proof = $result.Stdout | ConvertFrom-Json
    Require-Update ($proof.passed -and $proof.codeyModel -and $proof.codexModel -and $proof.syntheticSessionArchived) `
        'Codey/Codex real-model verification failed.'
}
function Recover-AgentTransaction {
    param($Journal, [string]$Job)
    if ($Journal.state -eq 'complete') {
        Assert-AgentProtected $Journal.request.plan.protected
        if ($Journal.changed) {
            Require-Update ((Get-UpdateHash $configFile) -eq $Journal.afterHash) 'Completed runtime changed.'
        } else {
            Require-Update ((Get-UpdateHash $configFile) -eq $Journal.request.plan.configHash) 'Verified runtime changed.'
        }
        Wait-UpdatedCodey $config $Job $Journal.request.version
        $proof = Read-UpdateJson (Join-Path $Job 'model-proof.json')
        Require-Update ($proof.passed -and $proof.codeyModel -and $proof.codexModel -and $proof.syntheticSessionArchived -and
            $proof.digest -eq $Journal.request.digest -and $proof.jobId -eq $Journal.request.jobId) 'Completed model proof is missing.'
        return @{ ok = $true; state = 'complete' }
    }
    if ($Journal.state -in @('rolled_back', 'aborted')) { return @{ ok = $true; state = $Journal.state } }
    if (-not $Journal.changed) {
        $Journal.state = 'aborted'
        Write-CodeyJson (Join-Path $Job 'local-update.json') $Journal
        return @{ ok = $true; state = 'aborted' }
    }
    # Do not stop new user work after a crash if the application already came back.
    if ($task.Enabled -and $task.State -eq 4) {
        Assert-ExternalUpdate
        Invoke-UpdateProbe $config $Job 'idle'
        Assert-ModelIdle
    }
    Restore-LocalUpdate $Journal $Job
    return @{ ok = $true; state = 'rolled_back' }
}

try {
    . Initialize-LocalWindows
    if ($Operation -in @('snapshot', 'recovery-snapshot')) {
        $result = Get-AgentSnapshot -RequireReady:($Operation -eq 'snapshot')
    } elseif ($Operation -eq 'idle') {
        $idle = $true
        try {
            Assert-ExternalUpdate
            Invoke-UpdateProbe $config (Join-Path $PSScriptRoot 'lib') 'idle'
            Assert-ModelIdle
        } catch { $idle = $false }
        $result = @{ ok = $true; idle = $idle }
    } else {
        $null = Assert-CodeyPath $InputFile $jobsRoot
        $document = Read-UpdateJson $InputFile
        $request = if ($Operation -eq 'recover') { $document.request } else { $document }
        $job = Assert-CodeyPath $request.job $jobsRoot
        Require-Update ((Split-Path -Parent $job) -eq $jobsRoot -and
            (Split-Path -Leaf $job) -eq $request.jobId -and
            $request.release.platform -eq 'windows-x64') 'Unexpected signed update job.'
        $mutex = [Threading.Mutex]::new($false, ('Local\CodeyWindowsInstall-' + $owner.Sid))
        $held = $false
        try {
            try { $held = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $held = $true }
            Require-Update $held 'Another installer or local update is running.'
            if ($Operation -eq 'recover') {
                $result = Recover-AgentTransaction $document $job
            } else {
                Require-Update ((Get-UpdateHash $configFile) -eq $request.plan.configHash) 'Runtime changed before activation.'
                Assert-AgentProtected $request.plan.protected
                Require-Update ($request.agentConfig -eq (Join-Path $owner.Home '.config\codey-updater\config.json')) `
                    'Agent configuration path changed.'
                if ($request.changed) {
                    Assert-ExternalUpdate
                    Invoke-UpdateProbe $config $job 'idle'
                    Assert-ModelIdle
                    # Recheck every staged application file while holding the
                    # shared installer mutex, immediately before any service stop.
                    $null = Invoke-CodeyProcess $config.nodeExe @((Join-Path $PSScriptRoot 'agent.mjs'),
                        'candidate', $InputFile) -WorkingDirectory $owner.Home -TimeoutSeconds 60
                }
                $candidate = Assert-CodeyPath $request.candidate $config.runtimeRoot
                $build = Read-UpdateJson (Join-Path $candidate 'codey-build.json')
                Require-Update ((Get-UpdateHash (Join-Path $candidate 'codey-build.json')) -eq $request.entrySha256 -and
                    $build.version -eq $request.version) 'Candidate fingerprint changed.'
                $journal = [pscustomobject]@{ schema = 1; kind = 'windows-managed'; state = 'applying'
                    request = $request; changed = [bool]$request.changed; beforeHash = $null; afterHash = $null }
                if ($request.changed) {
                    $beforeFile = Join-Path $job 'runtime-before.json'
                    [IO.File]::WriteAllBytes($beforeFile, [IO.File]::ReadAllBytes($configFile))
                    Protect-CodeyPath $beforeFile
                    $next = New-UpdatedCodeyRuntime $config $request
                    $afterFile = Join-Path $job 'runtime-after.json'
                    Write-CodeyJson $afterFile $next
                    $journal.beforeHash = Get-UpdateHash $beforeFile
                    $journal.afterHash = Get-UpdateHash $afterFile
                    Require-Update ($journal.beforeHash -eq $request.plan.configHash) 'Concurrent runtime modification.'
                }
                Write-CodeyJson (Join-Path $job 'local-update.json') $journal
                try {
                    if ($request.changed) {
                        Set-CodeyTaskState $config $configFile @('codey')
                        Wait-CodeyStopped
                        Require-Update ((Get-UpdateHash $configFile) -eq $journal.beforeHash) 'Runtime changed during stop.'
                        Write-CodeyFile $configFile ([IO.File]::ReadAllText($afterFile, [Text.Encoding]::UTF8))
                        Set-CodeyTaskState $next $configFile @('codey') -Start
                        Wait-UpdatedCodey $next $job $request.version
                    }
                    Invoke-AgentModels $InputFile
                    Assert-AgentProtected $request.plan.protected
                    $expectedHash = if ($request.changed) { $journal.afterHash } else { $request.plan.configHash }
                    Require-Update ((Get-UpdateHash $configFile) -eq $expectedHash) 'Runtime changed during model checks.'
                    $journal.state = 'complete'
                    Write-CodeyJson (Join-Path $job 'local-update.json') $journal
                    $result = @{ ok = $true; state = 'complete' }
                } catch {
                    if ($request.changed) {
                        Restore-LocalUpdate $journal $job
                        $result = @{ ok = $true; state = 'rolled_back'; code = 'health_failed' }
                    } else {
                        $journal.state = 'aborted'
                        Write-CodeyJson (Join-Path $job 'local-update.json') $journal
                        throw
                    }
                }
            }
        } finally { if ($held) { $mutex.ReleaseMutex() }; $mutex.Dispose() }
    }
    $result | ConvertTo-Json -Depth 18 -Compress
} catch {
    # No credentials, process command lines, raw model output or runtime JSON.
    @{ ok = $false; code = 'configuration_changed' } | ConvertTo-Json -Compress
}
