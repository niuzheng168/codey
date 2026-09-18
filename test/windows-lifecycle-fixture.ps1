param([string]$Common)
. $Common
# Only native path spelling is substituted on this portable host. Task ownership,
# arguments, all-or-nothing validation, state changes and binary writing are real.
if ($env:OS -ne 'Windows_NT') {
    function Assert-CodeyPath { param([string]$Path, [string]$Root = '')
        if (-not [IO.Path]::IsPathRooted($Path)) { throw 'Expected an absolute fixture path' }
        return [IO.Path]::GetFullPath($Path)
    }
}
$root = Join-Path ([IO.Path]::GetTempPath()) ("codey-lifecycle-" + [Guid]::NewGuid().ToString('N'))
$null = [IO.Directory]::CreateDirectory($root)
try {
    $config = [pscustomobject]@{
        nodeId = 'n-aaaaaaaaaaaaaaaaaaaaaaaa'; ownerSid = 'S-1-5-21-fixture'; runtimeRoot = $root
        runnerPath = Join-Path $root 'windows-service.ps1'
        powershellExe = Join-Path $root 'powershell.exe'
        taskHostExe = Join-Path $root 'codey-task-host.exe'
    }
    $file = Join-Path $root 'runtime.json'
    $script:Tasks = @{}
    foreach ($component in @('codey', 'tunnel', 'renew')) {
        $name = "Codey Machine $($config.nodeId) $component"
        $task = [pscustomobject]@{
            Name = $name; Enabled = $true; State = 4; Stops = 0; Runs = 0
            Definition = [pscustomobject]@{
                RegistrationInfo = [pscustomobject]@{ Description = "codey-windows-oneclick:$($config.nodeId):$component" }
                Principal = [pscustomobject]@{ UserId = $config.ownerSid; LogonType = 3; RunLevel = 0 }
                Actions = @([pscustomobject]@{
                    Path = $config.taskHostExe; WorkingDirectory = $root
                    Arguments = Get-CodeyTaskArguments $config.runnerPath $file $component -NativeHost
                })
            }
        }
        $task | Add-Member ScriptMethod Stop { param($flags)
            if ($this.Enabled) { throw 'Disable the watchdog before stopping it' }
            $this.State = 3; $this.Stops++
        }
        $task | Add-Member ScriptMethod Run { param($args)
            if (-not $this.Enabled) { throw 'Enable before starting' }
            $this.State = 4; $this.Runs++
        }
        $script:Tasks[$name] = $task
    }
    $folder = [pscustomobject]@{}
    $folder | Add-Member ScriptMethod GetTask { param($name); return $script:Tasks[$name] }
    function Get-CodeyTaskFolder { return @{ Folder = $folder } }
    $before = @(Get-CodeyServiceState $config $file)
    if ($before.Count -ne 3) { throw 'Missing tasks' }
    $stopped = @($before | ForEach-Object { @{ name = $_.name; enabled = $false; running = $false } })
    Set-CodeyServiceState $config $file $stopped
    if (@(Get-CodeyServiceState $config $file | Where-Object { $_.enabled -or $_.running }).Count) { throw 'Tasks not stopped' }
    Set-CodeyServiceState $config $file $before
    Set-CodeyServiceState $config $file $before
    if (@($script:Tasks.Values | Where-Object { $_.Runs -ne 1 -or $_.Stops -ne 1 }).Count) { throw 'Start not idempotent' }
    $script:Tasks[$before[2].name].Definition.Principal.UserId = 'other owner'
    $rejected = $false
    try { Set-CodeyServiceState $config $file $stopped } catch { $rejected = $true }
    if (-not $rejected -or $script:Tasks[$before[0].name].Stops -ne 1) { throw 'Validate whole task set first' }
    # Removing the public workspace command must not bypass the self-stop guard.
    $terminal = [pscustomobject]@{
        ProcessId = $PID; ParentProcessId = 2147480000; Name = 'powershell.exe'; CommandLine = 'powershell.exe'
    }
    $ancestor = [pscustomobject]@{
        ProcessId = 2147480000; ParentProcessId = 0; Name = 'node.exe'
        CommandLine = '"C:\owner home\node.exe" "C:\owner home\codey\lib\workspace.mjs"'
    }
    $rejected = $false
    try { Assert-CodeyExternalTerminal @($terminal, $ancestor) } catch {
        $rejected = $_.Exception.Message -match 'separate Windows terminal'
    }
    if (-not $rejected) { throw 'A private CloudCLI worker must still be recognized in the process ancestry' }
    $ancestor.CommandLine = '"C:\owner home\node.exe" "C:\owner home\unrelated.mjs"'
    Assert-CodeyExternalTerminal @($terminal, $ancestor)
    # Portable assertion: protection must happen before writing binary/secret bytes.
    $script:Protected = $false
    function Protect-CodeyPath { param($Path)
        if (-not $script:Protected -and ([IO.FileInfo]::new($Path)).Length -ne 0) { throw 'Secret written before private ACL' }
        $script:Protected = $true
    }
    $binary = Join-Path $root 'archive.gz'
    $bytes = [byte[]]@(31, 139, 0, 255, 192, 128, 0, 42)
    Write-CodeyBytes $binary $bytes
    if ([Convert]::ToBase64String([IO.File]::ReadAllBytes($binary)) -cne [Convert]::ToBase64String($bytes)) { throw 'Binary archive corrupted' }
    'WINDOWS_LIFECYCLE_OK'
} finally { [IO.Directory]::Delete($root, $true) }
