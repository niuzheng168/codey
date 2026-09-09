#requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ConfigPath,
    [ValidateSet('Check', 'Restart')][string]$Operation = 'Check'
)
$ErrorActionPreference = 'Stop'
$config = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if ($config.schema -ne 1 -or $config.kind -ne 'windows-devtunnel' -or
    $identity.User.Value -ne $config.ownerSid -or
    $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) -or
    [Environment]::MachineName -ine $config.computerName -or
    $config.nodeId -notmatch '^n-[a-f0-9]{24}$') {
    throw 'Repair requires the original logged-on, non-admin Windows owner and computer.'
}
$allowed = @($config.ownerSid, 'S-1-3-4', 'S-1-5-18', 'S-1-5-32-544')
foreach ($path in @($config.root, $config.configRoot, $ConfigPath)) {
    $acl = Get-Acl -LiteralPath $path
    if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $config.ownerSid) {
        throw 'Repair directory/file belongs to another owner.'
    }
    foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
        if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin $allowed) {
            throw 'Repair requires existing owner-only installation permissions; no ACL was changed.'
        }
    }
}
foreach ($file in @($ConfigPath, $config.runnerPath, $config.pythonwExe)) {
    if (-not [IO.Path]::IsPathRooted($file) -or -not (Test-Path -LiteralPath $file -PathType Leaf) -or $file.Contains('"')) {
        throw 'Invalid pinned task input.'
    }
}
$scheduler = New-Object -ComObject Schedule.Service
$scheduler.Connect()
$folder = $scheduler.GetFolder('\')
$tasks = @{}
foreach ($component in @('workspace', 'data', 'tunnel', 'renew')) {
    $task = $folder.GetTask("Codey Node $($config.nodeId) $component")
    $definition = $task.Definition
    $actions = @($definition.Actions)
    $arguments = '-X utf8 -I -B "' + $config.runnerPath + '" --config "' + $ConfigPath + '" --component ' + $component
    if ($definition.RegistrationInfo.Description -ne "codey-windows-tunnel-v1:$($config.nodeId):$component" -or
        $definition.Principal.UserId -notin @($config.ownerSid, $identity.Name, $env:USERNAME) -or
        $definition.Principal.LogonType -ne 3 -or $definition.Principal.RunLevel -ne 0 -or
        -not $definition.Settings.Enabled -or $actions.Count -ne 1 -or
        $actions[0].Path -ne $config.pythonwExe -or $actions[0].Arguments -ne $arguments -or
        $actions[0].WorkingDirectory -ne (Split-Path -Parent $config.runnerPath)) {
        throw 'A task does not belong to this exact installation. No task was changed.'
    }
    $tasks[$component] = $task
}
$listeners = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
    Where-Object { $_.LocalPort -eq 3001 } | Select-Object -ExpandProperty OwningProcess -Unique)
if ($listeners.Count -gt 1) { throw 'Ambiguous Workspace listener. No process was stopped.' }
foreach ($listener in $listeners) {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$listener"
    if ($process.ExecutablePath -ine $config.nodeExe -or
        ([string]$process.CommandLine).IndexOf($config.workspaceEntry, [StringComparison]::OrdinalIgnoreCase) -lt 0 -or
        (Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid).Sid -ne $config.ownerSid) {
        throw 'Port 3001 is not this installation Workspace. No process was stopped.'
    }
}
$insideWorkspace = $false
$ancestorId = $PID
$visited = @{}
while ($ancestorId -gt 0 -and -not $visited.ContainsKey($ancestorId)) {
    $visited[$ancestorId] = $true
    if ($ancestorId -in $listeners) { $insideWorkspace = $true; break }
    $ancestor = Get-CimInstance Win32_Process -Filter "ProcessId=$ancestorId" -ErrorAction SilentlyContinue
    if (-not $ancestor) { break }
    $ancestorId = [int]$ancestor.ParentProcessId
}
if ($Operation -eq 'Check') {
    @{ ownerVerified = $true; tasksVerified = $true; insideWorkspace = $insideWorkspace;
       workspaceListening = ($listeners.Count -eq 1); restartComponents = @('workspace', 'renew') } |
        ConvertTo-Json -Compress
    exit 0
}
if ($insideWorkspace) {
    throw 'Run repair in regular owner PowerShell, not the Codey terminal which this restart would terminate.'
}
# Only these two exact existing tasks need the new executable pins immediately.
# Running data/tunnel workers, Desktop, model proxy, task definitions and network stay untouched.
foreach ($component in @('workspace', 'renew')) {
    if ($tasks[$component].State -in @(2, 4)) { $tasks[$component].Stop(0) }
}
$deadline = [DateTime]::UtcNow.AddSeconds(30)
while (@(@('workspace', 'renew') | Where-Object { $tasks[$_].State -in @(2, 4) }).Count -gt 0) {
    if ([DateTime]::UtcNow -gt $deadline) { throw 'Owned tasks did not stop in time; no PID was killed.' }
    Start-Sleep -Milliseconds 200
}
foreach ($component in @('workspace', 'renew')) { $null = $tasks[$component].Run($null) }
@{ restarted = @('workspace', 'renew'); definitionsChanged = $false; protectedServicesChanged = $false } |
    ConvertTo-Json -Compress
