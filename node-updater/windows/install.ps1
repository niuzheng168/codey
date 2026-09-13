#requires -Version 5.1
[CmdletBinding()]
param([switch]$Apply)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib\update-windows.ps1') -Library
. Initialize-LocalWindows

function Assert-UpdaterTask {
    param($Task, $Binding)
    $definition = $Task.Definition
    $xml = [Xml.XmlDocument]::new()
    $xml.XmlResolver = $null
    $xml.LoadXml([string]$definition.XmlText)
    $actions = @($definition.Actions)
    Require-Update ($definition.RegistrationInfo.Description -eq "codey-windows-updater:$($config.nodeId)" -and
        [string]$xml.Task.Principals.Principal.UserId -eq $owner.Sid -and
        $definition.Principal.LogonType -eq 3 -and $definition.Principal.RunLevel -eq 0 -and
        $actions.Count -eq 1 -and $actions[0].Path -eq $Binding.host -and
        $actions[0].Arguments -eq (Join-CodeyArguments @($config.nodeExe, $agentFile)) -and
        $actions[0].WorkingDirectory -eq $Binding.directory) 'Existing updater task is not owned by this installation.'
}
function Register-UpdaterTask {
    param($Binding)
    $scheduler = Get-CodeyTaskFolder
    $definition = $scheduler.Scheduler.NewTask(0)
    $definition.RegistrationInfo.Description = "codey-windows-updater:$($config.nodeId)"
    $definition.Principal.UserId = $owner.Sid
    $definition.Principal.LogonType = 3
    $definition.Principal.RunLevel = 0
    $trigger = $definition.Triggers.Create(9)
    $trigger.UserId = $owner.Sid
    $trigger.Delay = 'PT15S'
    $retry = $definition.Triggers.Create(1)
    $retry.StartBoundary = [DateTime]::Now.AddMinutes(1).ToString('s')
    $retry.Repetition.Interval = 'PT1M'
    $definition.Settings.Hidden = $true
    $definition.Settings.Enabled = $true
    $definition.Settings.MultipleInstances = 2
    $definition.Settings.ExecutionTimeLimit = 'PT0S'
    $definition.Settings.DisallowStartIfOnBatteries = $false
    $definition.Settings.StopIfGoingOnBatteries = $false
    $definition.Settings.StartWhenAvailable = $true
    $definition.Settings.RestartInterval = 'PT1M'
    $definition.Settings.RestartCount = 999
    $action = $definition.Actions.Create(0)
    $action.Path = $Binding.host
    $action.Arguments = Join-CodeyArguments @($config.nodeExe, $agentFile)
    $action.WorkingDirectory = $Binding.directory
    return $scheduler.Folder.RegisterTaskDefinition($taskName, $definition, 6, $owner.Sid, $null, 3, $null)
}

$bootstrapFile = Join-Path $PSScriptRoot 'config.json'
$agentConfig = Read-UpdateJson $bootstrapFile
$manifest = Read-UpdateJson (Join-Path $PSScriptRoot 'agent-files.json')
Require-Update ($agentConfig.platform -eq 'windows-x64' -and $agentConfig.schema -eq 1 -and
    $agentConfig.protocol -eq 1 -and $agentConfig.nodeId -eq $config.nodeId -and
    $agentConfig.ownerId -eq $config.services.codey.environment.CODEY_PORTAL_PRINCIPAL_ID -and
    $agentConfig.username -eq $config.services.codey.environment.CODEY_PORTAL_USERNAME -and
    $agentConfig.portalOrigin -eq $config.portalOrigin -and $agentConfig.credential -match '^[A-Za-z0-9_-]{43}$' -and
    $agentConfig.minimumSequence -ge 0 -and $manifest.schema -eq 1 -and $manifest.platform -eq 'windows-x64') `
    'Bootstrap belongs to another owner, node, Portal or platform.'
foreach ($entry in $manifest.files.PSObject.Properties) {
    Require-Update ($entry.Name -match '^[A-Za-z0-9_-]+(?:/[A-Za-z0-9_.-]+)?\.[A-Za-z0-9]+$' -and
        $entry.Name -notmatch '\.\.' -and $entry.Value -match '^[a-f0-9]{64}$') 'Unsafe agent file manifest.'
    $file = Join-Path $PSScriptRoot $entry.Name.Replace('/', '\')
    $null = Assert-CodeyPath $file $PSScriptRoot
    Require-Update ((Get-UpdateHash $file) -eq $entry.Value) 'Bootstrap source checksum mismatch.'
}
$null = Invoke-CodeyProcess $config.nodeExe @((Join-Path $PSScriptRoot 'agent.mjs'), 'validate',
    '--config', $bootstrapFile) -WorkingDirectory $owner.Home -TimeoutSeconds 30
$version = (Read-UpdateJson (Join-Path $config.codeyDirectory 'package.json')).version
$beforeHash = Get-UpdateHash $configFile
$beforeTask = [string]$task.Definition.XmlText
$beforeInstances = @($task.GetInstances(0) | ForEach-Object { $_.InstanceGuid } | Sort-Object) -join ','
$private = Join-Path $owner.Home '.config\codey-updater'
$root = Join-Path $owner.Home '.local\share\codey-updater'
$agentFile = Join-Path $private 'config.json'
$bindingFile = Join-Path $private 'windows-agent.json'
$taskName = "Codey Node Updater $($config.nodeId)"
$previous = if (Test-Path -LiteralPath $bindingFile) { Read-UpdateJson $bindingFile } else { $null }
$scheduler = Get-CodeyTaskFolder
$existing = @($scheduler.Folder.GetTasks(1) | Where-Object Name -eq $taskName)
Require-Update (-not $existing.Count -or $previous) 'An unrecognized updater task already exists.'
if ($existing.Count) { Assert-UpdaterTask $existing[0] $previous }
if (Test-Path -LiteralPath $agentFile) {
    $saved = Read-UpdateJson $agentFile
    Require-Update ($saved.platform -eq 'windows-x64' -and $saved.nodeId -eq $agentConfig.nodeId -and $saved.ownerId -eq $agentConfig.ownerId -and
        $saved.releasePublicKey -eq $agentConfig.releasePublicKey) 'Updater identity/trust root changed.'
    if ($saved.minimumSequence -gt $agentConfig.minimumSequence) { $agentConfig.minimumSequence = $saved.minimumSequence }
}
Require-Update (-not (Test-Path -LiteralPath (Join-Path $private 'pending.json')) -and
    -not (Test-Path -LiteralPath (Join-Path $owner.Home '.local\share\codey-local-update\active.json'))) `
    'Finish/recover the current update before installing or replacing its agent.'
@{ nodeId = $config.nodeId; platform = 'windows-x64'; version = $version; task = $taskName
    applicationServicesRestarted = $false; mode = $(if ($Apply) { 'apply' } else { 'check' })
    scope = 'Independent owner-confirmed signed updater only; no setup, tool update, login or model calls.' } | ConvertTo-Json
if (-not $Apply) { return }

New-CodeyDirectory $private
New-CodeyDirectory $root
$guardPath = Assert-CodeyPath (Join-Path $private 'installer.lock') $private
# Kernel-owned, cross-session exclusion; a crashed installer leaves no stale lock.
$maintenance = [IO.FileStream]::new($guardPath, [IO.FileMode]::OpenOrCreate,
    [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
try {
$oldAgentBytes = if (Test-Path -LiteralPath $agentFile) { [IO.File]::ReadAllBytes($agentFile) } else { $null }
$oldBindingBytes = if (Test-Path -LiteralPath $bindingFile) { [IO.File]::ReadAllBytes($bindingFile) } else { $null }
$oldTaskXml = if ($existing.Count) { [string]$existing[0].Definition.XmlText } else { $null }
$writtenAgentHash = $null
$writtenBindingHash = $null
$agents = Join-Path $root 'windows-agents'
New-CodeyDirectory $agents
$destination = Join-Path $agents ([guid]::NewGuid().ToString('N'))
New-CodeyDirectory $destination
foreach ($entry in $manifest.files.PSObject.Properties) {
    $file = Join-Path $destination $entry.Name.Replace('/', '\')
    New-CodeyDirectory (Split-Path -Parent $file)
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $entry.Name.Replace('/', '\')) -Destination $file
    Protect-CodeyPath $file
    Require-Update ((Get-UpdateHash $file) -eq $entry.Value) 'Staged agent source changed.'
}
$compiler = Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$hostFile = Join-Path $destination 'codey-updater-host.exe'
$null = Invoke-CodeyProcess $compiler @('/nologo', '/target:winexe', '/main:CodeyUpdaterHost', "/out:$hostFile",
    (Join-Path $destination 'host.cs'), (Join-Path $destination 'process-tree.cs')) -TimeoutSeconds 60
Protect-CodeyPath $hostFile
$binding = @{ schema = 1; nodeId = $config.nodeId; ownerSid = $owner.Sid; directory = $destination
    host = $hostFile; node = $config.nodeExe; source = $manifest.files; hostSha256 = Get-UpdateHash $hostFile }
$stopFile = Join-Path $private 'stop.json'
$stopOwned = $false
$oldEnabled = $false
try {
    if ($existing.Count) {
        Assert-UpdaterTask $existing[0] $previous
        $oldEnabled = $existing[0].Enabled
        $existing[0].Enabled = $false
        Require-Update (-not (Test-Path -LiteralPath $stopFile)) 'An updater stop/repair is already in progress.'
        Write-CodeyJson $stopFile @{ nodeId = $config.nodeId; requestedAt = [DateTime]::UtcNow.ToString('o') }
        $stopOwned = $true
        $deadline = [DateTime]::UtcNow.AddSeconds(180)
        while ($existing[0].State -eq 4) {
            Require-Update ([DateTime]::UtcNow -lt $deadline) 'Updater is still finishing work; it was not force-killed.'
            Start-Sleep -Seconds 1
        }
    }
    Require-Update (-not (Test-Path -LiteralPath (Join-Path $private 'pending.json')) -and
        -not (Test-Path -LiteralPath (Join-Path $owner.Home '.local\share\codey-local-update\active.json'))) `
        'An update started while preparing the new agent; no agent code was replaced.'
    $application = (Get-CodeyTaskFolder).Folder.GetTask("Codey Machine $($config.nodeId) codey")
    Require-Update ((Get-UpdateHash $configFile) -eq $beforeHash -and
        [string]$application.Definition.XmlText -eq $beforeTask -and
        (@($application.GetInstances(0) | ForEach-Object { $_.InstanceGuid } | Sort-Object) -join ',') -eq $beforeInstances) `
        'Application runtime changed during updater installation.'
    if ($existing.Count) { Assert-UpdaterTask $existing[0] $previous }
    Write-CodeyJson $agentFile $agentConfig
    $writtenAgentHash = Get-UpdateHash $agentFile
    Write-CodeyJson $bindingFile $binding
    $writtenBindingHash = Get-UpdateHash $bindingFile
    if ($stopOwned) { Remove-Item -LiteralPath $stopFile; $stopOwned = $false }
    $registered = Register-UpdaterTask $binding
    $null = $registered.Run($null)
    $startedBy = [DateTime]::UtcNow.AddSeconds(30)
    while ($registered.State -ne 4) {
        Require-Update ([DateTime]::UtcNow -lt $startedBy) 'Updater task did not start; inspect private updater logs.'
        Start-Sleep -Seconds 1
    }
    Require-Update ((Get-UpdateHash $configFile) -eq $beforeHash) 'Application configuration changed.'
    Write-Output 'WINDOWS_UPDATER_INSTALLED_APPLICATION_SERVICES_UNCHANGED'
} catch {
    # Registration failure must not strand an old task with a new binding. Never
    # roll metadata back beneath a running/newly claimed updater transaction.
    $current = @((Get-CodeyTaskFolder).Folder.GetTasks(1) | Where-Object Name -eq $taskName)
    $unfinished = (Test-Path -LiteralPath (Join-Path $private 'pending.json')) -or
        (Test-Path -LiteralPath (Join-Path $owner.Home '.local\share\codey-local-update\active.json'))
    if (-not $unfinished -and (-not $current.Count -or $current[0].State -ne 4)) {
        if ($writtenAgentHash) {
            Require-Update ((Get-UpdateHash $agentFile) -eq $writtenAgentHash) 'Concurrent updater credential change; no stale file restored.'
        }
        if ($writtenBindingHash) {
            Require-Update ((Get-UpdateHash $bindingFile) -eq $writtenBindingHash) 'Concurrent updater binding change; no stale file restored.'
        }
        if ($current.Count) {
            $expected = if ($current[0].Definition.Actions.Item(1).Path -eq $hostFile) { $binding } else { $previous }
            Require-Update $expected 'Unexpected concurrent task; no task restored.'
            Assert-UpdaterTask $current[0] $expected
        }
        if ($oldTaskXml) {
            $restore = (Get-CodeyTaskFolder).Scheduler.NewTask(0)
            $restore.XmlText = $oldTaskXml
            $null = (Get-CodeyTaskFolder).Folder.RegisterTaskDefinition(
                $taskName, $restore, 6, $owner.Sid, $null, 3, $null)
        } elseif ($current.Count) {
            (Get-CodeyTaskFolder).Folder.DeleteTask($taskName, 0)
        }
        foreach ($restore in @(
            @{ file = $agentFile; bytes = $oldAgentBytes; written = $writtenAgentHash },
            @{ file = $bindingFile; bytes = $oldBindingBytes; written = $writtenBindingHash })) {
            if ($restore.written) {
                if ($null -ne $restore.bytes) {
                    $temporary = $restore.file + '.restore-' + [guid]::NewGuid().ToString('N') + '.next'
                    [IO.File]::WriteAllBytes($temporary, [byte[]]$restore.bytes)
                    Protect-CodeyPath $temporary
                    [IO.File]::Replace($temporary, $restore.file, [NullString]::Value)
                } else { Remove-Item -LiteralPath $restore.file }
            }
        }
    }
    throw
} finally {
    if ($stopOwned) { Remove-Item -LiteralPath $stopFile }
    if ($existing.Count -and $oldEnabled -and -not (Get-CodeyTaskFolder).Folder.GetTask($taskName).Enabled) {
        $resume = (Get-CodeyTaskFolder).Folder.GetTask($taskName)
        $expected = if ($resume.Definition.Actions.Item(1).Path -eq $hostFile) { $binding } else { $previous }
        Assert-UpdaterTask $resume $expected
        $resume.Enabled = $true
    }
}
} finally { $maintenance.Dispose() }
