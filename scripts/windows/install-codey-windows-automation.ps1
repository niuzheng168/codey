[CmdletBinding()]
param(
    [string]$ConfigPath = (Join-Path $env:USERPROFILE '.config\codey-windows-workspace\automation\automation.json'),
    [switch]$Apply
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$marker = 'codey-windows-automation-v1'
$config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if ($config.schema -ne 1 -or $identity.User.Value -ne $config.ownerSid) {
    throw 'Run this installer as the original Windows owner, not another administrator or SYSTEM.'
}
if (-not [IO.Path]::IsPathRooted($ConfigPath) -or $ConfigPath.Contains('"')) {
    throw 'Use an absolute configuration path without embedded quotes.'
}
foreach ($name in @('runtimeConfig', 'powershellExe', 'pythonExe', 'workerPath', 'workspaceLauncher', 'tunnelLauncher')) {
    $file = [string]$config.$name
    if (-not [IO.Path]::IsPathRooted($file) -or -not (Test-Path -LiteralPath $file -PathType Leaf) -or $file.Contains('"')) {
        throw 'A trusted automation input is missing or invalid.'
    }
}
foreach ($name in @('workerPath', 'workspaceLauncher', 'tunnelLauncher')) {
    if ((Get-FileHash -LiteralPath $config.$name -Algorithm SHA256).Hash -ne $config.fileHashes.$name) {
        throw 'A pinned automation input has changed. Revalidate the package before installing.'
    }
}
if (-not (Test-Path -LiteralPath $config.stateRoot -PathType Container)) {
    throw 'The private automation state directory has not been prepared.'
}

function Escape-Xml([string]$Value) {
    [Security.SecurityElement]::Escape($Value)
}

function Get-TaskXml([string]$Component, [string]$Nonce = '') {
    $isProbe = $Component -eq 'probe'
    $description = "$marker;component=$Component;ownerSid=$($config.ownerSid)"
    if ($isProbe) { $description += ";nonce=$Nonce" }
    $arguments = '-X utf8 -I -B "' + $config.workerPath + '" --config "' + $ConfigPath + '" --component ' + $Component
    if ($isProbe) { $arguments += " --probe-nonce $Nonce" }
    $triggers = ''
    $limit = 'PT0S'
    $restart = '<RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure>'
    if (-not $isProbe) {
        $triggers = @"
    <LogonTrigger><Enabled>true</Enabled><UserId>$(Escape-Xml $config.ownerSid)</UserId><Delay>PT30S</Delay></LogonTrigger>
"@
    }
    if ($Component -eq 'renew') {
        $limit = 'PT15M'
        $boundary = (Get-Date).AddMinutes(5).ToString('yyyy-MM-ddTHH:mm:sszzz')
        $triggers += @"
    <TimeTrigger><Repetition><Interval>PT1H</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition><StartBoundary>$boundary</StartBoundary><Enabled>true</Enabled></TimeTrigger>
"@
    }
    if ($isProbe) {
        $limit = 'PT3M'
        $restart = ''
    }
    # No password, S4U, SYSTEM, boot trigger, or elevation. This is explicitly
    # "run only when the original user is logged on."
    $enabled = if ($isProbe) { 'true' } else { 'false' }
    @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Author>$(Escape-Xml $identity.Name)</Author><Description>$(Escape-Xml $description)</Description></RegistrationInfo>
  <Triggers>$triggers</Triggers>
  <Principals><Principal id="Owner"><UserId>$(Escape-Xml $config.ownerSid)</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>$enabled</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>$limit</ExecutionTimeLimit>
    <Priority>7</Priority>
    $restart
  </Settings>
  <Actions Context="Owner"><Exec><Command>$(Escape-Xml $config.pythonExe)</Command><Arguments>$(Escape-Xml $arguments)</Arguments><WorkingDirectory>$(Escape-Xml (Split-Path -Parent $config.workerPath))</WorkingDirectory></Exec></Actions>
</Task>
"@
}

function Get-XmlHash([string]$Xml) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Xml))).Replace('-', '') }
    finally { $sha.Dispose() }
}

function Write-InstallState($Value) {
    $file = Join-Path $config.stateRoot 'installation.json'
    $temporary = Join-Path $config.stateRoot ("installation.$PID.tmp")
    $Value | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $temporary -Encoding UTF8
    # Only one known file in the explicitly configured private directory.
    Move-Item -LiteralPath $temporary -Destination $file -Force
}

$service = New-Object -ComObject Schedule.Service
$service.Connect()
$root = $service.GetFolder('\')
$taskNames = [ordered]@{
    workspace = 'Codey Windows Workspace Watchdog'
    tunnel = 'Codey Windows Dev Tunnel Watchdog'
    renew = 'Codey Windows Tunnel Renewal'
}
$protectedName = 'Codey Local Copilot API'
$protectedHash = Get-XmlHash ($root.GetTask($protectedName).Xml)
$nonce = [Guid]::NewGuid().ToString('N')
$probeName = "Codey Windows Authentication Probe $nonce"
$definitions = @{}
foreach ($component in @('workspace', 'tunnel', 'renew', 'probe')) {
    $definition = $service.NewTask(0)
    $definition.XmlText = Get-TaskXml $component $nonce
    # TASK_VALIDATE_ONLY checks syntax and creates no scheduled task.
    $null = $root.RegisterTaskDefinition(
        "Codey Windows Validate $component", $definition, 1, $null, $null, 0, $null
    )
    $definitions[$component] = $definition
}
if (-not $Apply) {
    [pscustomobject]@{
        state = 'validated_only'
        taskDefinitions = 4
        logonType = 'InteractiveToken'
        runLevel = 'LeastPrivilege'
        bootTrigger = $false
        hourlyRenewalCheck = $true
        passwordStored = $false
        registered = $false
        protectedTaskUnchanged = ((Get-XmlHash ($root.GetTask($protectedName).Xml)) -eq $protectedHash)
    } | ConvertTo-Json
    return
}

$existingNames = @($root.GetTasks(1) | ForEach-Object { $_.Name })
$matchingExisting = @()
foreach ($component in $taskNames.Keys) {
    $name = $taskNames[$component]
    if ($name -in $existingNames) {
        $task = $root.GetTask($name)
        $definition = $task.Definition
        $principalId = $definition.Principal.UserId
        if ($principalId -notmatch '^S-1-') {
            $principalId = ([Security.Principal.NTAccount]$principalId).Translate([Security.Principal.SecurityIdentifier]).Value
        }
        if ($definition.RegistrationInfo.Description -ne "$marker;component=$component;ownerSid=$($config.ownerSid)" -or
            $definition.Principal.LogonType -ne 3 -or $definition.Principal.RunLevel -ne 0 -or
            $principalId -ne $config.ownerSid -or $definition.Actions.Count -ne 1 -or
            $definition.Actions.Item(1).Path -ne $config.pythonExe -or
            $definition.Actions.Item(1).Arguments -ne $definitions[$component].Actions.Item(1).Arguments) {
            throw "Task name collision: $name. Nothing was replaced."
        }
        $matchingExisting += $name
    }
}
if ($matchingExisting.Count) {
    if ($matchingExisting.Count -eq $taskNames.Count) {
        [pscustomobject]@{ state = 'already_installed'; taskNames = $matchingExisting; changed = $false } | ConvertTo-Json
        return
    }
    throw 'A partial installation already exists. Inspect its state before changing or deleting any tasks.'
}

$probeCreated = $false
$created = New-Object 'Collections.Generic.List[string]'
$activated = $false
$phase = 'interactive_probe_registration'
try {
    # TASK_CREATE (not UPDATE): unknown or concurrently created tasks are never overwritten.
    $null = $root.RegisterTaskDefinition($probeName, $definitions.probe, 2, $config.ownerSid, $null, 3, $null)
    $probeCreated = $true
    $phase = 'interactive_probe_execution'
    $null = $root.GetTask($probeName).Run($null)
    $deadline = (Get-Date).AddSeconds(190)
    $passed = $false
    do {
        Start-Sleep -Seconds 2
        $probeTask = $root.GetTask($probeName)
        $probeFile = Join-Path $config.stateRoot 'probe.json'
        if (Test-Path -LiteralPath $probeFile) {
            $probe = Get-Content -LiteralPath $probeFile -Raw | ConvertFrom-Json
            if ($probe.state -eq 'passed' -and $probe.nonce -eq $nonce -and
                $probe.context.sid -eq $config.ownerSid -and $probe.context.sessionId -gt 0 -and
                -not $probe.context.elevated -and $probeTask.State -ne 4 -and
                $probeTask.LastTaskResult -eq 0) {
                $passed = $true
                break
            }
        }
        # A new, uniquely named task reports 0x41303 until its first run.
        # Do not compare COM's unspecified-kind LastRunTime against local time.
        if ($probeTask.LastTaskResult -ne 267011 -and $probeTask.State -notin @(2, 4)) {
            throw ('Authentication probe failed; Task Scheduler result: 0x{0:X8}. See private probe status; no startup tasks were installed.' -f $probeTask.LastTaskResult)
        }
    } while ((Get-Date) -lt $deadline)
    if (-not $passed) { throw 'Authentication probe timed out. No startup tasks were installed.' }

    $phase = 'register_disabled_tasks'
    foreach ($component in $taskNames.Keys) {
        $name = $taskNames[$component]
        $null = $root.RegisterTaskDefinition($name, $definitions[$component], 2, $config.ownerSid, $null, 3, $null)
        $created.Add($name)
    }
    $phase = 'activate'
    # The watchdogs adopt exact matching manual processes instead of stopping them.
    $activated = $true
    foreach ($name in $created) { $root.GetTask($name).Enabled = $true }
    foreach ($name in $created) { $null = $root.GetTask($name).Run($null) }
    $unchanged = (Get-XmlHash ($root.GetTask($protectedName).Xml)) -eq $protectedHash
    Write-InstallState @{
        schema = 1; state = 'installed'; installedAt = (Get-Date).ToString('o')
        ownerSid = $config.ownerSid; taskNames = @($created.ToArray())
        authenticationProbePassed = $true; sessionId = $probe.context.sessionId
        logonType = 'InteractiveToken'; runLevel = 'LeastPrivilege'; passwordStored = $false
        realRelogonTested = $false; protectedCopilotTaskUnchanged = $unchanged
    }
    [pscustomobject]@{
        state = 'installed'; taskNames = @($created.ToArray())
        authenticationProbePassed = $true; existingProcessesStopped = $false
        passwordStored = $false; protectedCopilotTaskUnchanged = $unchanged
        realRelogonTested = $false; renewalResult = 'check_worker_state'
    } | ConvertTo-Json
} catch {
    Write-InstallState @{
        schema = 1; state = 'needs_attention'; updatedAt = (Get-Date).ToString('o')
        phase = $phase; activated = $activated
        # Exception messages and credential objects are never persisted.
        code = $_.Exception.GetType().Name
    }
    if (-not $activated) {
        foreach ($name in $created) {
            $task = $root.GetTask($name)
            if ($task.Definition.RegistrationInfo.Description.StartsWith("$marker;") -and $task.State -ne 4) {
                $root.DeleteTask($name, 0)
            }
        }
    }
    throw
} finally {
    if ($probeCreated) {
        $task = $root.GetTask($probeName)
        if ($task.Definition.RegistrationInfo.Description -eq "$marker;component=probe;ownerSid=$($config.ownerSid);nonce=$nonce") {
            if ($task.State -eq 4) { $task.Stop(0) }
            $root.DeleteTask($probeName, 0)
        }
    }
}
