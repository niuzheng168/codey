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
if ($config.schema -ne 1 -or $identity.User.Value -ne $config.ownerSid -or
    $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) -or
    $config.nodeId -notmatch '^n-[a-f0-9]{24}$') {
    throw 'Tasks must be managed by the original non-elevated node owner.'
}
foreach ($file in @($ConfigPath, $config.runnerPath, $config.pythonwExe)) {
    if (-not [IO.Path]::IsPathRooted($file) -or -not (Test-Path -LiteralPath $file -PathType Leaf) -or $file.Contains('"')) {
        throw 'A pinned task input is missing or invalid.'
    }
}
$scheduler = New-Object -ComObject 'Schedule.Service'
$scheduler.Connect()
$folder = $scheduler.GetFolder('\')
$names = @{}
foreach ($component in @('copilot-api', 'workspace')) {
    $names[$component] = "Codey Node $($config.nodeId) $component"
}
$existing = @{}
foreach ($task in $folder.GetTasks(1)) {
    foreach ($component in $names.Keys) {
        if ($task.Name -eq $names[$component]) { $existing[$component] = $task }
    }
}
if ($Operation -eq 'Check') {
    @{ existingTasks = @($existing.Values | ForEach-Object { $_.Name }) } | ConvertTo-Json -Compress
    exit 0
}
if ($Operation -eq 'RemoveCreated') {
    foreach ($component in $existing.Keys) {
        $task = $existing[$component]
        $action = @($task.Definition.Actions)[0]
        if ($task.Definition.RegistrationInfo.Description -ne "codey-machine-v1:$($config.nodeId):$component" -or
            $task.Definition.Principal.UserId -notin @($config.ownerSid, $identity.Name, $env:USERNAME) -or
            $action.Path -ne $config.pythonwExe -or -not $action.Arguments.Contains('"' + $ConfigPath + '"') -or
            -not $action.Arguments.Contains('"' + $config.runnerPath + '"')) {
            throw 'Refusing to remove a task not created for this exact installation.'
        }
        $task.Stop(0)
        $folder.DeleteTask($task.Name, 0)
    }
    exit 0
}
if ($existing.Count) { throw 'Existing task names must be reviewed; the installer will not replace or restart them.' }
$created = @()
try {
    foreach ($component in @('copilot-api', 'workspace')) {
        $definition = $scheduler.NewTask(0)
        $definition.RegistrationInfo.Description = "codey-machine-v1:$($config.nodeId):$component"
        $definition.Principal.UserId = $config.ownerSid
        $definition.Principal.LogonType = 3 # InteractiveToken; no password/S4U/SYSTEM
        $definition.Principal.RunLevel = 0 # LeastPrivilege
        $trigger = $definition.Triggers.Create(9) # Logon only; never boot
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
        $task = $folder.RegisterTaskDefinition($names[$component], $definition, 2, $config.ownerSid, $null, 3, $null)
        $created += $task
    }
    foreach ($task in $created) { $null = $task.Run($null) }
    @{ createdTasks = @($created | ForEach-Object { $_.Name }); logonOnly = $true } | ConvertTo-Json -Compress
} catch {
    # This invocation only created these exact task objects.
    foreach ($task in $created) {
        $task.Stop(0)
        $folder.DeleteTask($task.Name, 0)
    }
    throw
}
