#requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ConfigPath,
    [ValidateSet('Check', 'Install', 'RemoveCreated')][string]$Operation = 'Check'
)
$ErrorActionPreference = 'Stop'
$config = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if ($config.schema -ne 1 -or $config.kind -ne 'windows-devtunnel' -or
    $identity.User.Value -ne $config.ownerSid -or
    $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) -or
    $config.nodeId -notmatch '^n-[a-f0-9]{24}$') {
    throw 'Use the original logged-on, non-elevated Windows owner.'
}
foreach ($file in @($ConfigPath, $config.runnerPath, $config.pythonwExe)) {
    if (-not [IO.Path]::IsPathRooted($file) -or -not (Test-Path -LiteralPath $file -PathType Leaf) -or $file.Contains('"')) {
        throw 'Invalid pinned task input.'
    }
}
$scheduler = New-Object -ComObject Schedule.Service
$scheduler.Connect()
$folder = $scheduler.GetFolder('\')
$components = @('workspace', 'data', 'tunnel', 'renew')
$existing = @{}
foreach ($task in $folder.GetTasks(1)) {
    foreach ($component in $components) {
        if ($task.Name -eq "Codey Node $($config.nodeId) $component") { $existing[$component] = $task }
    }
}
if ($Operation -eq 'Check') {
    @{ existingTasks = @($existing.Values | ForEach-Object { $_.Name }) } | ConvertTo-Json -Compress
    exit 0
}
if ($Operation -eq 'RemoveCreated') {
    foreach ($component in $existing.Keys) {
        $task = $existing[$component]
        $actions = @($task.Definition.Actions)
        $arguments = '-X utf8 -I -B "' + $config.runnerPath + '" --config "' + $ConfigPath + '" --component ' + $component
        if ($task.Definition.RegistrationInfo.Description -ne "codey-windows-tunnel-v1:$($config.nodeId):$component" -or
            $task.Definition.Principal.UserId -notin @($config.ownerSid, $identity.Name, $env:USERNAME) -or
            $actions.Count -ne 1 -or $actions[0].Path -ne $config.pythonwExe -or $actions[0].Arguments -ne $arguments) {
            throw 'An existing task is not owned by this exact installation; nothing was replaced.'
        }
    }
    foreach ($task in $existing.Values) {
        $task.Stop(0)
        $folder.DeleteTask($task.Name, 0)
    }
    exit 0
}
if ($existing.Count) { throw 'Existing tasks require review; no takeover or restart.' }
$created = @()
try {
    foreach ($component in $components) {
        $definition = $scheduler.NewTask(0)
        $definition.RegistrationInfo.Description = "codey-windows-tunnel-v1:$($config.nodeId):$component"
        $definition.Principal.UserId = $config.ownerSid
        $definition.Principal.LogonType = 3
        $definition.Principal.RunLevel = 0
        $trigger = $definition.Triggers.Create(9)
        $trigger.UserId = $config.ownerSid
        $trigger.Delay = 'PT30S'
        $definition.Settings.Enabled = $true
        $definition.Settings.Hidden = $true
        $definition.Settings.MultipleInstances = 2
        $definition.Settings.DisallowStartIfOnBatteries = $false
        $definition.Settings.StopIfGoingOnBatteries = $false
        $definition.Settings.ExecutionTimeLimit = 'PT0S'
        $definition.Settings.RestartInterval = 'PT1M'
        $definition.Settings.RestartCount = 3
        $action = $definition.Actions.Create(0)
        $action.Path = $config.pythonwExe
        $action.Arguments = '-X utf8 -I -B "' + $config.runnerPath + '" --config "' + $ConfigPath + '" --component ' + $component
        $action.WorkingDirectory = Split-Path -Parent $config.runnerPath
        $created += $folder.RegisterTaskDefinition(
            "Codey Node $($config.nodeId) $component", $definition, 2, $config.ownerSid, $null, 3, $null)
    }
    foreach ($task in $created) { $null = $task.Run($null) }
    @{ createdTasks = @($created | ForEach-Object { $_.Name }); logonOnly = $true; existingModelServiceChanged = $false } |
        ConvertTo-Json -Compress
} catch {
    foreach ($task in $created) {
        $task.Stop(0)
        $folder.DeleteTask($task.Name, 0)
    }
    throw
}
