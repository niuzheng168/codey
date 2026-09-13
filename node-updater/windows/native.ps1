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
$script:failureCode = 'configuration_changed'

function Get-AgentFailureCode {
    param($Failure, [string]$Default = 'health_failed')
    $code = $Failure.Exception.Data['CodeyUpdateCode']
    if ($code -in @('signature_invalid', 'unsupported_platform', 'configuration_changed', 'health_failed', 'lease_lost',
        'model_failed', 'busy', 'rollback_failed')) { return $code }
    return $Default
}
function Assert-AgentProof {
    param($Request, $Proof)
    if ($Request.PSObject.Properties['acceptance']) {
        Require-Update ($Request.acceptance -eq 'authenticated-health-v1') 'Unknown acceptance policy.'
        $component = $Request.release.components.codey
        Require-Update ($Request.version -eq $component.version -and $Request.entrySha256 -eq $component.entrySha256 -and
            $Proof.schema -eq 1 -and $Proof.acceptance -eq $Request.acceptance -and
            $Proof.passed -eq $true -and $Proof.healthy -eq $true -and $Proof.authenticated -eq $true -and
            $Proof.modelRequests -is [bool] -and -not $Proof.modelRequests -and
            $Proof.digest -eq $Request.digest -and $Proof.jobId -eq $Request.jobId -and
            $Proof.version -eq $component.version -and $Proof.entrySha256 -eq $component.entrySha256 -and
            $Proof.checkedAt -gt 0) 'Completed authenticated health proof is missing or differs from the release.'
    } else {
        Require-Update ($Proof.passed -eq $true -and $Proof.codeyModel -eq $true -and $Proof.codexModel -eq $true -and
            $Proof.syntheticSessionArchived -eq $true -and $Proof.digest -eq $Request.digest -and
            $Proof.jobId -eq $Request.jobId) 'Completed historical model proof is missing.'
    }
}

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
function Get-AgentProcessId {
    Require-Update ($config.ready -and $task.Enabled -and $task.State -eq 4) 'Codey is not running.'
    $status = Read-UpdateJson (Join-Path $config.stateRoot 'codey.status.json')
    Require-Update ($status.state -eq 'running' -and $status.pid -gt 0) 'Codey process status is unavailable.'
    $process = Get-CimInstance Win32_Process -Filter ("ProcessId=" + [int]$status.pid) -ErrorAction Stop
    $processOwner = Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid -ErrorAction Stop
    Require-Update ($processOwner.Sid -eq $owner.Sid -and $process.ExecutablePath -ieq $config.nodeExe -and
        $process.CommandLine -match ([regex]::Escape($config.codeyBin) + '"?\s+"?start(?:\s|"|$)')) `
        'The running Codey process does not match runtime.json.'
    return [int]$status.pid
}
function Assert-AgentBefore {
    param($Plan)
    Require-Update ((Get-UpdateHash $configFile) -ceq $Plan.configHash -and
        $config.codeyDirectory -ceq $Plan.root -and $config.nodeExe -ceq $Plan.node) 'Runtime changed before activation.'
    Assert-AgentProtected $Plan.protected
    Require-Update (($Plan.pid -is [int] -or $Plan.pid -is [long]) -and
        (Get-AgentProcessId) -eq $Plan.pid) 'Original Codey process changed before activation.'
    $actual = Get-OtherAgentTasks
    Require-Update (@($Plan.otherTasks.PSObject.Properties).Count -eq 2) 'Other task identities changed.'
    foreach ($name in @('tunnel', 'renew')) {
        $expected = $Plan.otherTasks.$name
        Require-Update ($expected.definition -is [string] -and $actual[$name].definition -ceq $expected.definition -and
            $expected.enabled -is [bool] -and $actual[$name].enabled -eq $expected.enabled) 'Another task changed before activation.'
        $currentInstances = @($actual[$name].instances)
        $previousInstances = @($expected.instances)
        Require-Update ($currentInstances.Count -eq $previousInstances.Count) 'Other task instances changed.'
        for ($index = 0; $index -lt $currentInstances.Count; $index++) {
            Require-Update ($previousInstances[$index] -is [string] -and
                $currentInstances[$index] -ceq $previousInstances[$index]) 'Another task restarted before activation.'
        }
    }
}
function Get-AgentSnapshot {
    param([switch]$RequireReady)
    $null = Get-ProtectedHashes $config
    $pidValue = 0
    if ($RequireReady) {
        $pidValue = Get-AgentProcessId
        $version = (Read-UpdateJson (Join-Path $config.codeyDirectory 'package.json')).version
        $script:failureCode = 'health_failed'
        Invoke-UpdateProbe $config (Join-Path $PSScriptRoot 'lib') 'health' $version
    }
    return @{ ok = $true; kind = 'windows-managed'; root = $config.codeyDirectory; node = $config.nodeExe
        jobsRoot = $jobsRoot; pid = $pidValue; services = @("Codey Machine $($config.nodeId) codey")
        otherTasks = Get-OtherAgentTasks }
}
function Invoke-AgentAcceptance {
    param([string]$RequestFile, $Request)
    $result = Invoke-CodeyProcess $config.nodeExe @((Join-Path $PSScriptRoot 'verify.mjs'), $RequestFile) `
        -WorkingDirectory $owner.Home -TimeoutSeconds 240 -AllowFailure
    $proof = $result.Stdout | ConvertFrom-Json
    if ($result.ExitCode -ne 0) {
        $errorValue = [InvalidOperationException]::new('Codey acceptance failed.')
        if ($proof.PSObject.Properties['code']) { $errorValue.Data['CodeyUpdateCode'] = $proof.code }
        throw $errorValue
    }
    Assert-AgentProof $Request $proof
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
        $script:failureCode = 'health_failed'
        Wait-UpdatedCodey $config $Job $Journal.request.version
        $proofFile = if ($Journal.request.PSObject.Properties['acceptance']) { 'health-proof.json' } else { 'model-proof.json' }
        if ($proofFile -eq 'model-proof.json') { $script:failureCode = 'model_failed' }
        Assert-AgentProof $Journal.request (Read-UpdateJson (Join-Path $Job $proofFile))
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
            $script:failureCode = 'busy'
            try { $held = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $held = $true }
            Require-Update $held 'Another installer or local update is running.'
            $script:failureCode = 'configuration_changed'
            if ($Operation -eq 'recover') {
                $script:failureCode = 'rollback_failed'
                $result = Recover-AgentTransaction $document $job
            } else {
                Require-Update ($request.acceptance -eq 'authenticated-health-v1') 'A new health-only request is required.'
                Assert-AgentBefore $request.plan
                Require-Update ($request.agentConfig -eq (Join-Path $owner.Home '.config\codey-updater\config.json')) `
                    'Agent configuration path changed.'
                if ($request.changed) {
                    $script:failureCode = 'busy'
                    Assert-ExternalUpdate
                    Invoke-UpdateProbe $config $job 'idle'
                    Assert-ModelIdle
                    # Recheck every staged application file while holding the
                    # shared installer mutex, immediately before any service stop.
                    $script:failureCode = 'signature_invalid'
                    $null = Invoke-CodeyProcess $config.nodeExe @((Join-Path $PSScriptRoot 'agent.mjs'),
                        'candidate', $InputFile) -WorkingDirectory $owner.Home -TimeoutSeconds 60
                }
                $script:failureCode = 'signature_invalid'
                $candidate = Assert-CodeyPath $request.candidate $config.runtimeRoot
                $build = Read-UpdateJson (Join-Path $candidate 'codey-build.json')
                Require-Update ((Get-UpdateHash (Join-Path $candidate 'codey-build.json')) -eq $request.entrySha256 -and
                    $build.version -eq $request.version) 'Candidate fingerprint changed.'
                $journal = [pscustomobject]@{ schema = 1; kind = 'windows-managed'; state = 'applying'
                    request = $request; changed = [bool]$request.changed; beforeHash = $null; afterHash = $null }
                if ($request.changed) {
                    $script:failureCode = 'configuration_changed'
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
                $script:failureCode = 'configuration_changed'
                try {
                    if ($request.changed) {
                        Set-CodeyTaskState $config $configFile @('codey')
                        Wait-CodeyStopped
                        Require-Update ((Get-UpdateHash $configFile) -eq $journal.beforeHash) 'Runtime changed during stop.'
                        Write-CodeyFile $configFile ([IO.File]::ReadAllText($afterFile, [Text.Encoding]::UTF8))
                        $script:failureCode = 'health_failed'
                        Set-CodeyTaskState $next $configFile @('codey') -Start
                        Wait-UpdatedCodey $next $job $request.version
                    }
                    $script:failureCode = 'health_failed'
                    Invoke-AgentAcceptance $InputFile $request
                    $script:failureCode = 'configuration_changed'
                    Assert-AgentProtected $request.plan.protected
                    $expectedHash = if ($request.changed) { $journal.afterHash } else { $request.plan.configHash }
                    Require-Update ((Get-UpdateHash $configFile) -eq $expectedHash) 'Runtime changed during acceptance checks.'
                    $journal.state = 'complete'
                    Write-CodeyJson (Join-Path $job 'local-update.json') $journal
                    $result = @{ ok = $true; state = 'complete' }
                } catch {
                    $code = Get-AgentFailureCode $_ $script:failureCode
                    if ($request.changed) {
                        $script:failureCode = 'rollback_failed'
                        Restore-LocalUpdate $journal $job
                        $result = @{ ok = $true; state = 'rolled_back'; code = $code }
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
    @{ ok = $false; code = (Get-AgentFailureCode $_ $script:failureCode) } | ConvertTo-Json -Compress
}
