#requires -Version 5.1
# No installation side effects when dot-sourced; shared by installer and watchdog.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-CodeyPath {
    param([string]$Path, [string]$Root, [switch]$AllowRoot)
    if ($Path -notmatch '^[a-zA-Z]:[\\/]' -or $Path -match '[\x00-\x1f"*?<>|]' -or
        $Path.Substring(2).Contains(':')) { throw 'Expected an absolute local Windows path.' }
    $full = [IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
    if ($full -match '^[a-zA-Z]:$') { throw 'A drive root cannot be an installation/configuration path.' }
    if ($Root) {
        $base = [IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
        if (-not $full.StartsWith($base + '\', [StringComparison]::OrdinalIgnoreCase) -and
            -not ($AllowRoot -and $full.Equals($base, [StringComparison]::OrdinalIgnoreCase))) {
            throw 'Path escapes the approved installation directory.'
        }
    }
    $cursor = $full
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw 'Linked installation/configuration paths require manual review.'
            }
        }
        $parent = Split-Path -Parent $cursor
        if ($parent -eq $cursor) { break }
        $cursor = $parent
    }
    return $full
}

function Protect-CodeyPath {
    param([string]$Path)
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $directory = Test-Path -LiteralPath $Path -PathType Container
    $acl = if ($directory) { [Security.AccessControl.DirectorySecurity]::new() }
        else { [Security.AccessControl.FileSecurity]::new() }
    $acl.SetAccessRuleProtection($true, $false)
    $inheritance = if ($directory) {
        [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
    } else { [Security.AccessControl.InheritanceFlags]::None }
    foreach ($principal in @($sid, [Security.Principal.SecurityIdentifier]::new('S-1-5-18'))) {
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
            $principal, 'FullControl', $inheritance, 'None', 'Allow'))
    }
    # Never take ownership or write an SACL. Those operations can require
    # privileges even when setting the same Entra SID on Windows PowerShell.
    $info = if ($directory) { [IO.DirectoryInfo]::new($Path) } else { [IO.FileInfo]::new($Path) }
    if ('System.IO.FileSystemAclExtensions' -as [type]) {
        $existing = [IO.FileSystemAclExtensions]::GetAccessControl($info, [Security.AccessControl.AccessControlSections]::Owner)
    } else { $existing = $info.GetAccessControl([Security.AccessControl.AccessControlSections]::Owner) }
    if ($existing.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) {
        throw 'Refusing to change permissions on a path owned by another account.'
    }
    if ('System.IO.FileSystemAclExtensions' -as [type]) {
        [IO.FileSystemAclExtensions]::SetAccessControl($info, $acl)
    } else { $info.SetAccessControl($acl) }
}

function New-CodeyDirectory {
    param([string]$Path)
    $full = Assert-CodeyPath $Path
    if (-not (Test-Path -LiteralPath $full)) { [IO.Directory]::CreateDirectory($full) | Out-Null }
    Protect-CodeyPath $full
}

function Write-CodeyFile {
    param([string]$Path, [string]$Content, [switch]$Backup)
    $full = Assert-CodeyPath $Path
    $temporary = "$full.$([Guid]::NewGuid().ToString('N')).next"
    [IO.File]::WriteAllText($temporary, $Content, [Text.UTF8Encoding]::new($false))
    Protect-CodeyPath $temporary
    try {
        if (Test-Path -LiteralPath $full) {
            if ($Backup) {
                $backupFile = "$full.$([Guid]::NewGuid().ToString('N')).bak"
                [IO.File]::Replace($temporary, $full, $backupFile)
                Protect-CodeyPath $backupFile
            } else {
                # PowerShell otherwise converts $null to an empty path string.
                [IO.File]::Replace($temporary, $full, [NullString]::Value)
            }
        } else { [IO.File]::Move($temporary, $full) }
        Protect-CodeyPath $full
    } finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
    }
}

function Read-CodeyJson {
    param([string]$Path)
    Get-Content -LiteralPath (Assert-CodeyPath $Path) -Raw -Encoding UTF8 | ConvertFrom-Json
}

function Write-CodeyJson {
    param([string]$Path, $Value, [switch]$Backup)
    Write-CodeyFile $Path (($Value | ConvertTo-Json -Depth 30) + "`n") -Backup:$Backup
}

function New-CodeySecret {
    param([int]$Bytes = 32, [switch]$Hex)
    $buffer = New-Object byte[] $Bytes
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($buffer) } finally { $rng.Dispose() }
    if ($Hex) { return -join ($buffer | ForEach-Object { $_.ToString('x2') }) }
    return [Convert]::ToBase64String($buffer).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function Join-CodeyArguments {
    param([AllowEmptyCollection()][string[]]$Values)
    # CommandLineToArgvW/CRT escaping, not cmd.exe or PowerShell interpolation.
    return (($Values | ForEach-Object {
        if ($_ -match '[\x00\r\n]') { throw 'Invalid native argument.' }
        '"' + [regex]::Replace([regex]::Replace($_, '(\\*)"', '$1$1\"'), '(\\+)$', '$1$1') + '"'
    }) -join ' ')
}

function Initialize-CodeyJob {
    if (-not ('CodeyChildJob' -as [type])) {
        Add-Type -Path (Join-Path $PSScriptRoot 'windows-process.cs')
    }
}

function Invoke-CodeyProcess {
    param([string]$Executable, [string[]]$Arguments = @(), [hashtable]$Environment = @{},
        [string]$WorkingDirectory = $PWD.Path, [int]$TimeoutSeconds = 300,
        [string]$InputText = '', [switch]$Interactive, [switch]$AllowFailure)
    if (-not [IO.Path]::IsPathRooted($Executable) -or
        -not (Test-Path -LiteralPath $Executable -PathType Leaf)) { throw 'Missing absolute native executable.' }
    Initialize-CodeyJob
    $job = [CodeyChildJob]::new()
    $process = [Diagnostics.Process]::new()
    $info = $process.StartInfo
    $info.FileName = $Executable
    $info.Arguments = Join-CodeyArguments $Arguments
    $info.WorkingDirectory = $WorkingDirectory
    $info.UseShellExecute = $false
    $info.CreateNoWindow = -not $Interactive
    $info.RedirectStandardInput = -not $Interactive
    $info.RedirectStandardOutput = -not $Interactive
    $info.RedirectStandardError = -not $Interactive
    if (-not $Interactive) {
        # Node/Codex emit UTF-8 even when Windows PowerShell's console is OEM.
        $info.StandardOutputEncoding = [Text.UTF8Encoding]::new($false)
        $info.StandardErrorEncoding = [Text.UTF8Encoding]::new($false)
    }
    foreach ($key in @('PSModulePath', 'CODEX_THREAD_ID', 'CODEX_PARENT_THREAD_ID', 'CODEX_INTERNAL_ORIGINATOR_OVERRIDE')) {
        $info.EnvironmentVariables.Remove($key)
    }
    foreach ($key in $Environment.Keys) { $info.EnvironmentVariables[$key] = [string]$Environment[$key] }
    try {
        $null = $process.Start()
        $job.Add($process)
        if (-not $Interactive) {
            $stdout = $process.StandardOutput.ReadToEndAsync()
            $stderr = $process.StandardError.ReadToEndAsync()
            $inputBytes = [Text.Encoding]::UTF8.GetBytes($InputText)
            $process.StandardInput.BaseStream.Write($inputBytes, 0, $inputBytes.Length)
            $process.StandardInput.Close()
        }
        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) { throw 'Native command timed out; its owned process tree was stopped.' }
        $process.WaitForExit()
        $result = [pscustomobject]@{
            ExitCode = $process.ExitCode
            Stdout = $(if ($Interactive) { '' } else { $stdout.GetAwaiter().GetResult() })
            Stderr = $(if ($Interactive) { '' } else { $stderr.GetAwaiter().GetResult() })
        }
        if ($result.ExitCode -ne 0 -and -not $AllowFailure) {
            # Never echo command arguments, provider keys, tokens or raw CLI output.
            throw "Native command failed ($([IO.Path]::GetFileName($Executable)), exit $($result.ExitCode))."
        }
        return $result
    } finally { $job.Dispose(); $process.Dispose() }
}

function Get-CodeyDownload {
    param([string]$Url, [string]$Destination, [string]$Sha256)
    if (([uri]$Url).Scheme -ne 'https') { throw 'Only official HTTPS downloads are allowed.' }
    $full = Assert-CodeyPath $Destination
    $temporary = "$full.$([Guid]::NewGuid().ToString('N')).part"
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $temporary -TimeoutSec 300 | Out-Null
        if ($Sha256 -and (Get-FileHash -LiteralPath $temporary -Algorithm SHA256).Hash -ne $Sha256) {
            throw 'Official download SHA-256 mismatch; nothing was installed.'
        }
        Protect-CodeyPath $temporary
        if (Test-Path -LiteralPath $full) { [IO.File]::Replace($temporary, $full, [NullString]::Value) }
        else { [IO.File]::Move($temporary, $full) }
    } finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
    }
}

function Expand-CodeyZip {
    param([string]$Archive, [string]$Destination)
    $target = Assert-CodeyPath $Destination
    if (Test-Path -LiteralPath $target) { throw 'Archive destination must be new.' }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::OpenRead((Assert-CodeyPath $Archive))
    try {
        $names = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
        $files = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
        $total = [long]0
        foreach ($entry in $zip.Entries) {
            $name = $entry.FullName.TrimEnd('/')
            $parts = $name.Split('/')
            if (-not $name -or $name.Length -gt 1024 -or $name -match '[\\:\x00-\x1f"*?<>|]' -or
                ($parts | Where-Object {
                    $_ -in @('', '.', '..') -or $_ -match '[. ]$' -or
                    $_ -match '^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)'
                }) -or -not $names.Add($name)) { throw 'Unsafe or duplicate Windows archive entry.' }
            $kind = ($entry.ExternalAttributes -shr 16) -band 0xF000
            if ($kind -notin @(0, 0x8000, 0x4000) -or
                ($entry.ExternalAttributes -band 0x400)) { throw 'Archive links/reparse points are not allowed.' }
            $total += $entry.Length
            if ($total -gt 8GB -or $zip.Entries.Count -gt 150000) { throw 'Archive exceeds extraction limits.' }
            if (-not $entry.FullName.EndsWith('/')) { $null = $files.Add($name) }
            $null = Assert-CodeyPath (Join-Path $target ($name.Replace('/', '\'))) $target
        }
        foreach ($name in $names) {
            $parts = $name.Split('/')
            for ($i = 1; $i -lt $parts.Length; $i++) {
                if ($files.Contains(($parts[0..($i - 1)] -join '/'))) { throw 'Archive file/directory collision.' }
            }
        }
        # Validation completes before creating any output.
        New-CodeyDirectory $target
        foreach ($entry in $zip.Entries) {
            $path = Join-Path $target ($entry.FullName.TrimEnd('/').Replace('/', '\'))
            if ($entry.FullName.EndsWith('/')) { [IO.Directory]::CreateDirectory($path) | Out-Null; continue }
            [IO.Directory]::CreateDirectory((Split-Path -Parent $path)) | Out-Null
            $inputStream = $entry.Open()
            $outputStream = [IO.File]::Open($path, [IO.FileMode]::CreateNew)
            try { $inputStream.CopyTo($outputStream) }
            finally { $outputStream.Dispose(); $inputStream.Dispose() }
        }
    } finally { $zip.Dispose() }
}

function Get-CodeyOwner {
    if ($env:OS -ne 'Windows_NT' -or -not [Environment]::Is64BitProcess -or
        $env:PROCESSOR_ARCHITECTURE -ne 'AMD64') { throw 'Use native x64 PowerShell on Windows x64, not WSL or an emulated host.' }
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) -or
        [Diagnostics.Process]::GetCurrentProcess().SessionId -eq 0) {
        throw 'Run as the original logged-on owner, without elevation.'
    }
    return [pscustomobject]@{ Sid = $identity.User.Value; Name = $identity.Name
        Home = [Environment]::GetFolderPath('UserProfile'); Computer = $env:COMPUTERNAME }
}

function Get-CodeyProcesses {
    param([string]$OwnerSid)
    $all = @(Get-CimInstance Win32_Process -ErrorAction Stop)
    foreach ($process in $all) {
        if (-not $process.ExecutablePath) { continue }
        $owner = Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid -ErrorAction SilentlyContinue
        if ($owner -and $owner.Sid -eq $OwnerSid) { $process }
    }
}

function Assert-CodeyExternalTerminal {
    param($Processes)
    $currentId = $PID
    for ($i = 0; $i -lt 64 -and $currentId; $i++) {
        $process = @($Processes | Where-Object { $_.ProcessId -eq $currentId })
        if (-not $process.Count) { break }
        if ($process[0].Name -match '^codex(\.exe)?$' -or
            $process[0].CommandLine -match 'bin[\\/]codey\.mjs|dist-server[\\/]server[\\/]index\.js|copilot-api[\\/]dist[\\/]main\.js') {
            throw 'Run installation from a separate Windows terminal, not Codex or a Codey Workspace terminal.'
        }
        $currentId = $process[0].ParentProcessId
    }
}

function Stop-CodeyProcessSnapshot {
    param($Process, [string]$OwnerSid)
    $current = Get-CimInstance Win32_Process -Filter "ProcessId=$($Process.ProcessId)" -ErrorAction Stop
    if (-not $current) { return }
    $owner = Invoke-CimMethod -InputObject $current -MethodName GetOwnerSid -ErrorAction Stop
    if ($owner.Sid -ne $OwnerSid -or $current.ExecutablePath -ne $Process.ExecutablePath -or
        $current.CreationDate -ne $Process.CreationDate -or $current.ProcessId -eq $PID) {
        throw 'Process identity changed; refusing to stop it.'
    }
    Stop-Process -Id $current.ProcessId -ErrorAction Stop
}

function Get-CodeyTaskArguments {
    param([string]$Runner, [string]$Config, [string]$Component, [switch]$NativeHost)
    if ($NativeHost) { return (Join-CodeyArguments @($Config, $Component)) }
    Join-CodeyArguments @('-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
        '-File', $Runner, '-ConfigPath', $Config, '-Component', $Component)
}

function Get-CodeyTaskHost {
    param($Config)
    if ($Config.PSObject.Properties['taskHostExe'] -and $Config.taskHostExe) {
        return (Assert-CodeyPath $Config.taskHostExe $Config.runtimeRoot)
    }
    # Existing installations remain inspectable/removable without taking them over.
    return $Config.powershellExe
}

function Install-CodeyTaskHost {
    param([string]$Directory)
    $compiler = Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
    $target = Assert-CodeyPath (Join-Path $Directory 'codey-task-host.exe') $Directory
    $null = Invoke-CodeyProcess $compiler @('/nologo', '/target:winexe',
        "/out:$target", (Join-Path $Directory 'windows-process.cs')) -TimeoutSeconds 60
    Protect-CodeyPath $target
    return $target
}

function Get-CodeyTaskFolder {
    $scheduler = New-Object -ComObject Schedule.Service
    $scheduler.Connect()
    return @{ Scheduler = $scheduler; Folder = $scheduler.GetFolder('\') }
}

function Assert-CodeyTask {
    param($Task, $Config, [string]$ConfigPath, [string]$Component)
    $definition = $Task.Definition
    $actions = @($definition.Actions)
    $taskOwner = [string]$definition.Principal.UserId
    if ($taskOwner -ne $Config.ownerSid) {
        # Windows normalizes IPrincipal.UserId to a display name (e.g. "zhn"),
        # even when registered with an Entra SID. The task XML retains the SID.
        # Never accept an ambiguous display-name comparison as owner proof.
        try {
            $xml = [Xml.XmlDocument]::new()
            $xml.XmlResolver = $null
            $xml.LoadXml([string]$definition.XmlText)
            $taskOwner = [string]$xml.Task.Principals.Principal.UserId
        } catch { throw 'The task owner SID could not be verified.' }
    }
    if ($definition.RegistrationInfo.Description -ne "codey-windows-oneclick:$($Config.nodeId):$Component" -or
        $taskOwner -ne $Config.ownerSid -or $definition.Principal.LogonType -ne 3 -or
        $definition.Principal.RunLevel -ne 0 -or $actions.Count -ne 1 -or
        $actions[0].Path -ne (Get-CodeyTaskHost $Config) -or
        $actions[0].WorkingDirectory -ne (Split-Path -Parent $Config.runnerPath) -or
        $actions[0].Arguments -ne (Get-CodeyTaskArguments $Config.runnerPath $ConfigPath $Component `
            -NativeHost:((Get-CodeyTaskHost $Config) -ne $Config.powershellExe))) {
        throw 'Existing task is not owned by this exact installation; no task was changed.'
    }
}

function Install-CodeyTasks {
    param($Config, [string]$ConfigPath, $PreviousConfig = $null)
    $service = Get-CodeyTaskFolder
    $existing = @($service.Folder.GetTasks(1))
    $components = @('codey', 'tunnel', 'renew')
    # Validate the entire replacement set before touching any task.
    foreach ($component in $components) {
        foreach ($task in $existing | Where-Object { $_.Name -eq "Codey Machine $($Config.nodeId) $component" }) {
            $expectedConfig = if ($PreviousConfig) { $PreviousConfig } else { $Config }
            Assert-CodeyTask $task $expectedConfig $ConfigPath $component
        }
    }
    $written = @()
    try {
      foreach ($component in $components) {
        $definition = $service.Scheduler.NewTask(0)
        $definition.RegistrationInfo.Description = "codey-windows-oneclick:$($Config.nodeId):$component"
        $definition.Principal.UserId = $Config.ownerSid
        $definition.Principal.LogonType = 3
        $definition.Principal.RunLevel = 0
        $trigger = $definition.Triggers.Create(9)
        $trigger.UserId = $Config.ownerSid
        $trigger.Delay = 'PT30S'
        # RestartOnFailure alone misses a clean/externally ended watchdog.
        # Repeat indefinitely while this owner is logged on; IgnoreNew prevents
        # duplicates. An intentional stop must disable the task first.
        $recovery = $definition.Triggers.Create(1)
        $recovery.StartBoundary = [DateTime]::Now.AddMinutes(1).ToString('s')
        $recovery.Repetition.Interval = 'PT1M'
        $definition.Settings.Enabled = $true
        $definition.Settings.Hidden = $true
        $definition.Settings.MultipleInstances = 2
        $definition.Settings.DisallowStartIfOnBatteries = $false
        $definition.Settings.StopIfGoingOnBatteries = $false
        $definition.Settings.ExecutionTimeLimit = 'PT0S'
        $definition.Settings.RestartInterval = 'PT1M'
        $definition.Settings.RestartCount = 999
        $definition.Settings.StartWhenAvailable = $true
        $action = $definition.Actions.Create(0)
        $action.Path = Get-CodeyTaskHost $Config
        $action.Arguments = Get-CodeyTaskArguments $Config.runnerPath $ConfigPath $component `
            -NativeHost:($action.Path -ne $Config.powershellExe)
        $action.WorkingDirectory = Split-Path -Parent $Config.runnerPath
        $written += $service.Folder.RegisterTaskDefinition(
            "Codey Machine $($Config.nodeId) $component", $definition, 6, $Config.ownerSid, $null, 3, $null)
      }
    } catch {
        foreach ($task in $written) { $task.Enabled = $false; $task.Stop(0) }
        throw
    }
}

function Assert-CodeyTasksRunning {
    param($Config, [string]$ConfigPath)
    $service = Get-CodeyTaskFolder
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        $running = $true
        foreach ($component in @('codey', 'tunnel', 'renew')) {
            $task = $service.Folder.GetTask("Codey Machine $($Config.nodeId) $component")
            Assert-CodeyTask $task $Config $ConfigPath $component
            if (-not $task.Enabled -or $task.State -ne 4) { $running = $false }
        }
        if ($running) { return }
        Start-Sleep -Milliseconds 500
    }
    throw 'One or more owned logon watchdogs are not running.'
}

function Set-CodeyTaskState {
    param($Config, [string]$ConfigPath, [string[]]$Components, [switch]$Start)
    $service = Get-CodeyTaskFolder
    $tasks = @()
    foreach ($component in $Components) {
        $task = $service.Folder.GetTask("Codey Machine $($Config.nodeId) $component")
        Assert-CodeyTask $task $Config $ConfigPath $component
        $tasks += $task
    }
    foreach ($task in $tasks) {
        if ($Start) { $task.Enabled = $true; $null = $task.Run($null) }
        else { $task.Enabled = $false; $task.Stop(0) }
    }
}
