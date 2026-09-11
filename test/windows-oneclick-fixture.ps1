# Every install-side external command/task/registry write below is mocked.
# Only the first section launches real, isolated Node subprocesses.
param([Parameter(Mandatory = $true)][string]$Root, [Parameter(Mandatory = $true)][string]$NodeExe)
$ErrorActionPreference = 'Stop'
. (Join-Path $Root 'package\scripts\install.ps1')
$script:Checks = [Collections.Generic.List[string]]::new()
function Check {
    param([bool]$Condition, [string]$Name)
    if (-not $Condition) { throw "Assertion failed: $Name" }
    $script:Checks.Add($Name)
}
function Reject {
    param([scriptblock]$Action, [string]$Name)
    $failed = $false
    try { & $Action | Out-Null } catch { $failed = $true }
    Check $failed $Name
}
function Fingerprint {
    param([string]$Path)
    return (@(Get-ChildItem -LiteralPath $Path -Recurse -File -Force | Sort-Object FullName |
        ForEach-Object { $_.FullName + ':' + (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash }) -join "`n")
}

# Native PowerShell 5.1/7 escaping, stdin EOF, timeout/process-tree ownership.
$values = @('space value', 'a"b', 'C:\trailing\', '', ('unicode-' + [char]0x4e2d + [char]0x6587))
$json = (Invoke-CodeyProcess $NodeExe (@('-e', 'console.log(JSON.stringify(process.argv.slice(1)))', '--') + $values)).Stdout
$received = $json | ConvertFrom-Json
Check ($received.Count -eq $values.Count -and
    @(0..($values.Count - 1) | Where-Object { $received[$_] -cne $values[$_] }).Count -eq 0) 'native argument quoting roundtrip'
$eof = Invoke-CodeyProcess $NodeExe @('-e', "process.stdin.resume();process.stdin.on('end',()=>console.log('EOF_OK'))") -TimeoutSeconds 10
Check ($eof.Stdout.Trim() -eq 'EOF_OK') 'native stdin is closed'
Reject { Invoke-CodeyProcess $NodeExe @('-e', 'setInterval(()=>{},1000)') -TimeoutSeconds 1 } 'native command timeout'
$childPidFile = Join-Path $Root 'child.pid'
$childCode = "const {spawn}=require('node:child_process');const fs=require('node:fs');" +
    "setTimeout(()=>{const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});" +
    "fs.writeFileSync(process.argv[1],String(c.pid));},100);setInterval(()=>{},1000);"
Reject { Invoke-CodeyProcess $NodeExe @('-e', $childCode, $childPidFile) -TimeoutSeconds 2 } 'owned process tree timeout'
Start-Sleep -Milliseconds 300
$childPid = [int](Get-Content -LiteralPath $childPidFile)
Check (-not (Get-Process -Id $childPid -ErrorAction SilentlyContinue)) 'job closes descendant process'

foreach ($name in @('traversal', 'drive', 'ads', 'reserved', 'trailing', 'case', 'link', 'file-directory')) {
    $destination = Join-Path $Root "unpack-$name"
    Reject { Expand-CodeyZip (Join-Path $Root "$name.zip") $destination } "reject unsafe ZIP $name"
    Check (-not (Test-Path -LiteralPath $destination)) "no extraction writes for $name"
}
$good = Join-Path $Root 'unpack-good'
Expand-CodeyZip (Join-Path $Root 'good.zip') $good
Check ((Get-Content -LiteralPath (Join-Path $good 'dir\file.txt')) -eq 'fixture') 'valid Windows ZIP extraction'
Reject { Assert-CodeyPath (Join-Path $Root '..\outside') $Root } 'bounded installation paths'
Reject { Assert-CodeyPath ((Join-Path $Root 'file') + ':stream') } 'reject NTFS alternate data stream'
Reject { Assert-CodeyPath ([IO.Path]::GetPathRoot($Root)) } 'reject drive root installation'
Reject { Join-CodeyArguments @("bad`narg") } 'reject multiline process arguments'
$file = Join-Path $Root 'private.txt'
Write-CodeyFile $file 'before'
Write-CodeyFile $file 'after' -Backup
Check ((Get-Content -LiteralPath $file) -eq 'after') 'atomic file replacement'
$backups = @(Get-ChildItem -LiteralPath $Root -Filter 'private.txt.*.bak')
Check ($backups.Count -eq 1 -and (Get-Content -LiteralPath $backups[0].FullName) -eq 'before') 'original configuration backup'
$acl = Get-Acl -LiteralPath $file
$sids = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) |
    Where-Object { $_.AccessControlType -eq 'Allow' } | ForEach-Object { $_.IdentityReference.Value })
Check ('S-1-1-0' -notin $sids -and 'S-1-5-32-545' -notin $sids -and $acl.AreAccessRulesProtected) 'private file ACL'

# Real native COM semantics, but only an in-memory definition: never register,
# run, stop, delete or modify any actual scheduled task.
$scheduler = New-Object -ComObject Schedule.Service
$scheduler.Connect()
$definition = $scheduler.NewTask(0)
$nativeConfig = [pscustomobject]@{
    ownerSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    nodeId = 'n-aaaaaaaaaaaaaaaaaaaaaaaa'
    powershellExe = (Get-Process -Id $PID).Path
    runnerPath = Join-Path $Root 'package\scripts\windows-service.ps1'
}
$nativeConfigPath = Join-Path $Root 'native-task.private.json'
$definition.Principal.UserId = $nativeConfig.ownerSid
$definition.Principal.LogonType = 3
$definition.Principal.RunLevel = 0
$definition.RegistrationInfo.Description = "codey-windows-oneclick:$($nativeConfig.nodeId):codey"
$action = $definition.Actions.Create(0)
$action.Path = $nativeConfig.powershellExe
$action.Arguments = Get-CodeyTaskArguments $nativeConfig.runnerPath $nativeConfigPath 'codey'
$action.WorkingDirectory = Split-Path -Parent $nativeConfig.runnerPath
$nativeTask = [pscustomobject]@{ Definition = $definition }
Assert-CodeyTask $nativeTask $nativeConfig $nativeConfigPath 'codey'
Check $true 'native Task Scheduler display-name normalization resolves to the exact XML SID'
$definition.Principal.UserId = 'S-1-5-18'
Reject { Assert-CodeyTask $nativeTask $nativeConfig $nativeConfigPath 'codey' } 'another native task owner is rejected'

# From here on, no live model, tunnel, task, process termination, or user env changes.
$script:FixtureHome = Join-Path $Root 'owner home'
$script:FixtureSid = 'fixture-' + [Guid]::NewGuid().ToString('N')
$script:FixtureProcesses = @()
$script:FixtureListeners = @()
$script:Calls = [Collections.Generic.List[string]]::new()
$script:BadAnswer = $false
$script:BadNpm = $false
$script:UserPath = 'C:\fixture-tools;%USERPROFILE%\fixture-bin'
$global:CodeyFixtureTasks = @{}
$global:CodeyFixtureTaskCalls = [Collections.Generic.List[string]]::new()
function Get-CodeyOwner {
    [pscustomobject]@{ Sid = $script:FixtureSid; Name = 'fixture\owner'; Home = $script:FixtureHome; Computer = 'FIXTURE-PC' }
}
function Get-CodeyProcesses { param($OwnerSid); return $script:FixtureProcesses }
function Get-CodeyListeners { return $script:FixtureListeners }
function Get-CodeyOpenSsl { param($Explicit); return (Join-Path $Root 'openssl.exe') }
function Set-CodeyUserModelKey { param($Key); $script:Calls.Add('user-environment'); Check ($Key.Length -eq 43) 'model key is locally generated' }
function Install-CodeyTaskHost {
    param($Directory)
    $target = Join-Path $Directory 'codey-task-host.exe'
    [IO.File]::WriteAllText($target, 'fixture-only-not-executable')
    $script:Calls.Add('install-console-free-host')
    return $target
}
function Get-CodeyUserPath { return $script:UserPath }
function Set-CodeyUserPath {
    param($Value, $Expected)
    Check ($Expected -ceq $script:UserPath) 'PATH update checks the previous value'
    $script:UserPath = $Value
    $script:Calls.Add('user-path')
}
function Invoke-WebRequest { throw 'Fixture refuses all real network requests' }
function Stop-Process { throw 'Fixture refuses real process termination' }
function Register-ScheduledTask { throw 'Fixture refuses real task registration' }
function Get-AuthenticodeSignature {
    param($LiteralPath)
    return [pscustomobject]@{ Status = 'Valid'; SignerCertificate = [pscustomobject]@{ Subject = 'O=Microsoft Corporation' } }
}
function Get-CodeyDownload {
    param($Url, $Destination, $Sha256)
    $null = Assert-CodeyPath $Destination $script:FixtureHome
    $script:Calls.Add('download:' + ([uri]$Url).Host)
    if ($Url -like '*node-v*-win-x64.zip') { Copy-Item -LiteralPath (Join-Path $Root 'node.zip') -Destination $Destination }
    elseif ($Url -like '*TunnelsCliDownload*') { [IO.File]::WriteAllText($Destination, 'fixture-only-not-executable') }
    elseif ($Url -eq 'https://chatgpt.com/codex/install.ps1') {
        [IO.File]::WriteAllText($Destination, '# fixture-only https://releases.openai.com/codex')
    } else { throw 'Unexpected fixture download URL' }
}
function Invoke-CodeyProcess {
    param($Executable, $Arguments, $Environment = @{}, $WorkingDirectory, $TimeoutSeconds,
        $InputText, [switch]$Interactive, [switch]$AllowFailure)
    $leaf = [IO.Path]::GetFileName($Executable)
    $result = [pscustomobject]@{ ExitCode = 0; Stdout = ''; Stderr = '' }
    if ($leaf -eq 'devtunnel.exe') {
        $script:Calls.Add('devtunnel:' + ($Arguments[0..1] -join ' '))
        if ($Arguments[0] -eq 'user') { $result.Stdout = '{"status":"Logged in","provider":"github"}' }
        elseif ($Arguments[0] -in @('show', 'create')) {
            $id = $Arguments[1].Split('.')[0]
            $result.Stdout = (@{ tunnelId = $id; clusterId = 'jpe1'; ports = @(
                @{ portNumber = 3001; protocol = 'https' }, @{ portNumber = 8443; protocol = 'https' })
            } | ConvertTo-Json -Depth 8)
        }
    } elseif ($leaf -eq 'openssl.exe') {
        $script:Calls.Add('tls')
        [IO.File]::WriteAllText($Arguments[[array]::IndexOf($Arguments, '-keyout') + 1], 'fake-private-key')
        [IO.File]::WriteAllText($Arguments[[array]::IndexOf($Arguments, '-out') + 1], 'fake-public-cert')
    } elseif ($leaf -eq 'powershell.exe') {
        $script:Calls.Add('official-codex-install')
        [IO.Directory]::CreateDirectory($Environment.CODEX_INSTALL_DIR) | Out-Null
        [IO.File]::WriteAllText((Join-Path $Environment.CODEX_INSTALL_DIR 'codex.exe'), 'fixture-only')
    } elseif ($leaf -eq 'codex.exe') {
        if ($Arguments[0] -eq '--version') { $result.Stdout = 'codex-cli fixture' }
        elseif ($Arguments[0] -eq 'exec') {
            $script:Calls.Add('codex-model')
            $answer = if ($script:BadAnswer) { 'incorrect final response' } else { 'CODEY_CODEX_OK' }
            [IO.File]::WriteAllText($Arguments[[array]::IndexOf($Arguments, '--output-last-message') + 1], $answer)
            $result.Stdout = 'prompt echo: Reply with only CODEY_CODEX_OK'
        } else { throw 'Unexpected fake Codex operation' }
    } elseif ($leaf -eq 'node.exe') {
        if ($Arguments[0] -eq '--version') { $result.Stdout = 'v24.20.0' }
        elseif ($Arguments[0] -like '*npm-cli.js' -and $Arguments[1] -eq 'install') {
            $script:Calls.Add('npm-install')
            Check ($Arguments -contains '--global' -and $Arguments -contains '--omit=dev') 'npm installs one production package'
            Check ($Arguments[-1] -like '*codey-0.1.0.tgz') 'npm installs the package-local tgz'
            Check ($Environment.PATH.Split(';')[0] -eq (Split-Path -Parent $Executable)) 'npm lifecycle scripts use pinned Node, not system Node'
            if ($script:BadNpm) { throw 'Fixture npm staging failure' }
            $prefix = $Arguments[[array]::IndexOf($Arguments, '--prefix') + 1]
            $modules = Join-Path $prefix 'node_modules'
            [IO.Directory]::CreateDirectory($modules) | Out-Null
            Copy-Item -LiteralPath (Join-Path $Root 'installed-codey') `
                -Destination (Join-Path $modules 'codey') -Recurse
        }
        elseif ($Arguments[0] -eq '-e') { $script:Calls.Add('native-addon-probe') }
        elseif ($Arguments[0] -like '*windows-runtime.mjs') {
            $operation = $Arguments[1]
            $script:Calls.Add('probe:' + $operation)
            if ($operation -eq 'registration') {
                $cfg = Read-CodeyJson $Arguments[2]
                Write-CodeyJson $cfg.registrationStaging @{ schema = 2; credentials = @{ fixture = 'private' } }
            }
        } elseif ($Arguments[0] -like '*codey.mjs' -and $Arguments[1] -eq '--version') {
            $result.Stdout = 'codey 0.1.0'
        } elseif ($Arguments[0] -like '*codey.mjs' -and $Arguments[1] -eq 'auth') {
            $script:Calls.Add('copilot-login')
        } else { throw 'Unexpected fake Node operation' }
    } else { throw "Unexpected executable in fixture: $leaf" }
    return $result
}
function Install-CodeyTasks {
    param($Config, $ConfigPath, $PreviousConfig)
    $script:Calls.Add('register-tasks')
    foreach ($component in @('codey', 'tunnel', 'renew')) {
        $task = [pscustomobject]@{
            Name = "Codey Machine $($Config.nodeId) $component"; Component = $component; Enabled = $true; State = 3
            Definition = [pscustomobject]@{
                RegistrationInfo = [pscustomobject]@{ Description = "codey-windows-oneclick:$($Config.nodeId):$component" }
                Principal = [pscustomobject]@{ UserId = $Config.ownerSid; LogonType = 3; RunLevel = 0 }
                Actions = @([pscustomobject]@{ Path = (Get-CodeyTaskHost $Config)
                    WorkingDirectory = Split-Path -Parent $Config.runnerPath
                    Arguments = Get-CodeyTaskArguments $Config.runnerPath $ConfigPath $component -NativeHost })
            }
        }
        $task | Add-Member ScriptMethod Run { param($ignored); $this.State = 4; $global:CodeyFixtureTaskCalls.Add("start:$($this.Component)") }
        $task | Add-Member ScriptMethod Stop { param($ignored); $this.State = 3; $global:CodeyFixtureTaskCalls.Add("stop:$($this.Component)") }
        $global:CodeyFixtureTasks[$task.Name] = $task
    }
}
function Get-CodeyTaskFolder {
    $folder = [pscustomobject]@{}
    $folder | Add-Member ScriptMethod GetTask {
        param($name)
        if (-not $global:CodeyFixtureTasks.ContainsKey($name)) { throw 'Missing fake task' }
        return $global:CodeyFixtureTasks[$name]
    }
    return @{ Folder = $folder }
}
$invoke = @{
    DoApply = $true; ApprovedNetwork = $true; Replace = $true; ExpectedComputer = 'FIXTURE-PC'
    RequestedCodexHome = ''; RequestedOpenSsl = ''
}
$env:CODEX_HOME = ''
$planArgs = $invoke.Clone(); $planArgs.DoApply = $false
$before = Fingerprint $Root
$plan = (Invoke-CodeyWindowsInstall @planArgs) | ConvertFrom-Json
Check ($plan.mode -eq 'plan' -and $plan.updater -match 'unsupported_platform') 'read-only Windows plan'
Check ((Fingerprint $Root) -eq $before -and $script:Calls.Count -eq 0) 'plan has no writes or external commands'
$bad = $invoke.Clone(); $bad.ApprovedNetwork = $false
Reject { Invoke-CodeyWindowsInstall @bad } 'explicit network approval gate'
$bad = $invoke.Clone(); $bad.ExpectedComputer = 'WRONG-PC'
Reject { Invoke-CodeyWindowsInstall @bad } 'exact computer approval gate'
$bad = $invoke.Clone(); $bad.Repair = $true
Reject { Invoke-CodeyWindowsInstall @bad } 'repair and full replacement cannot be combined'
$bad.Replace = $false
Reject { Invoke-CodeyWindowsInstall @bad } 'repair cannot silently become a first-time installation'
Check ((Fingerprint $Root) -eq $before -and $script:Calls.Count -eq 0) 'approval gates precede all side effects'
$script:FixtureListeners = @([pscustomobject]@{ LocalAddress = '127.0.0.1'; LocalPort = 4141; OwningProcess = 2147480001 })
Reject { Invoke-CodeyWindowsInstall @invoke } 'foreign listener is never killed even with replacement approved'
$script:FixtureListeners = @()
$script:FixtureProcesses = @([pscustomobject]@{
    Name = 'codex.exe'; ProcessId = 2147480001; ExecutablePath = 'C:\other\codex.exe'; ParentProcessId = 0
})
Reject { Invoke-CodeyWindowsInstall @invoke } 'unmanaged Codex is not terminated'
$script:FixtureProcesses = @(
    [pscustomobject]@{ Name = 'powershell.exe'; ProcessId = $PID; ParentProcessId = 2147480001; CommandLine = '' },
    [pscustomobject]@{ Name = 'codex.exe'; ProcessId = 2147480001; ParentProcessId = 0; CommandLine = '' }
)
Reject { Assert-CodeyExternalTerminal $script:FixtureProcesses } 'installer refuses its own Codex terminal ancestry'
$script:FixtureProcesses = @()
Check ((Fingerprint $Root) -eq $before) 'conflict checks leave all files unchanged'

# A complete mocked install uses real ZIP extraction, keys, files, backups and ACLs.
[IO.Directory]::CreateDirectory((Join-Path $script:FixtureHome '.codex\sessions')) | Out-Null
[IO.File]::WriteAllText((Join-Path $script:FixtureHome '.codex\auth.json'), 'original-auth')
[IO.File]::WriteAllText((Join-Path $script:FixtureHome '.codex\sessions\original.jsonl'), 'original-session')
[IO.File]::WriteAllText((Join-Path $script:FixtureHome '.codex\config.toml'), 'original-config')
$bad = $invoke.Clone(); $bad.Replace = $false
Reject { Invoke-CodeyWindowsInstall @bad } 'configuration replacement needs explicit approval'
Invoke-CodeyWindowsInstall @invoke | Out-Null
$configPath = Join-Path $script:FixtureHome '.config\codey-machine-windows\runtime.json'
$config = Read-CodeyJson $configPath
Check $config.ready 'complete mocked installation marks ready only after verification'
Check (Test-Path -LiteralPath (Join-Path $config.runtimeRoot 'bin\codey.ps1')) 'successful install creates a stable command'
Check ($script:UserPath.StartsWith('C:\fixture-tools;%USERPROFILE%\fixture-bin;')) 'user PATH retains existing entries and expansion variables'
Check ($script:Calls.IndexOf('user-path') -gt $script:Calls.IndexOf('probe:sdk-probe')) 'PATH registration follows successful runtime probes'
Check ($config.schema -eq 2 -and $config.layout -eq 'npm-codey-package') 'runtime records the unified npm layout'
Check ($config.updater -eq 'unsupported_platform' -and $config.logonOnly) 'updater and logon limitations remain explicit'
Check ($script:Calls.Contains('npm-install')) 'installer invokes npm for the package-local tgz'
Check ($script:Calls.IndexOf('npm-install') -lt $script:Calls.IndexOf('devtunnel:user show')) 'npm staging precedes service and tunnel changes'
Check ((Get-Content -LiteralPath (Join-Path $script:FixtureHome '.codex\auth.json')) -eq 'original-auth') 'existing auth preserved'
Check ((Get-Content -LiteralPath (Join-Path $script:FixtureHome '.codex\sessions\original.jsonl')) -eq 'original-session') 'existing sessions preserved'
Check ($script:Calls.IndexOf('probe:check-tunnel') -lt $script:Calls.IndexOf('tls')) 'private tunnel validated before key/config replacement'
Check ($script:Calls.IndexOf('codex-model') -lt $script:Calls.IndexOf('probe:sdk-probe')) 'both model paths are independently checked'
Check ($script:Calls[$script:Calls.Count - 1] -eq 'user-environment') 'user environment is published only after probes pass'
Check ((Read-CodeyJson (Join-Path $script:FixtureHome 'codey-machine-registration.json')).schema -eq 2) 'private schema-2 registration export'
Check ($global:CodeyFixtureTaskCalls.Contains('start:codey') -and
    $global:CodeyFixtureTaskCalls.Contains('start:renew') -and
    $global:CodeyFixtureTaskCalls.Contains('start:tunnel')) 'all native watchdog components started'

# Ready-node rerun is verification only, not key rotation or a restart.
$identityBefore = [IO.File]::ReadAllText($config.identityFile)
$readyBefore = Fingerprint $script:FixtureHome
$script:Calls.Clear(); $global:CodeyFixtureTaskCalls.Clear()
$verifyArgs = $invoke.Clone(); $verifyArgs.Replace = $false
Invoke-CodeyWindowsInstall @verifyArgs | Out-Null
Check ((Fingerprint $script:FixtureHome) -eq $readyBefore) 'ready-node retry does not rewrite configuration'
Check ($script:Calls.Count -eq 1 -and $script:Calls[0] -eq 'probe:verify' -and $global:CodeyFixtureTaskCalls.Count -eq 0) 'ready-node retry has no download/restart'

# Upgrade an existing ready install that predates the persistent command, without rotation or restarts.
$commandPath = Join-Path $config.runtimeRoot 'bin\codey.ps1'
Remove-Item -LiteralPath $commandPath
$script:UserPath = 'C:\fixture-tools'
$script:Calls.Clear(); $global:CodeyFixtureTaskCalls.Clear()
$configBefore = [IO.File]::ReadAllText($configPath)
Invoke-CodeyWindowsInstall @verifyArgs | Out-Null
Check (Test-Path -LiteralPath $commandPath) 'ready-node retry repairs a missing command'
Check ([IO.File]::ReadAllText($configPath) -ceq $configBefore) 'command repair preserves runtime config and secrets'
Check ($script:Calls.Contains('user-path') -and -not $script:Calls.Contains('npm-install') -and
    $global:CodeyFixtureTaskCalls.Count -eq 0) 'command repair does not reinstall or restart services'

# Dedicated service repair stages npm and changes watchdogs without re-enrollment.
Write-CodeyFile (Join-Path $config.services.codey.environment.COPILOT_API_HOME 'github_token') 'fixture-persisted-github-token'
$credentialHash = (Get-FileHash -LiteralPath (Join-Path $config.services.codey.environment.COPILOT_API_HOME 'github_token')).Hash
$keyBefore = $config.modelKey
$registrationBefore = [IO.File]::ReadAllText((Join-Path $script:FixtureHome 'codey-machine-registration.json'))
$codexBefore = [IO.File]::ReadAllText((Join-Path $config.codexHome 'config.toml'))
$script:Calls.Clear(); $global:CodeyFixtureTaskCalls.Clear()
$repairArgs = $verifyArgs.Clone(); $repairArgs.Repair = $true
$runtimeBeforeRepair = [IO.File]::ReadAllText($configPath)
$script:BadNpm = $true
Reject { Invoke-CodeyWindowsInstall @repairArgs } 'failed npm staging aborts repair'
$script:BadNpm = $false
Check ($global:CodeyFixtureTaskCalls.Count -eq 0 -and
    [IO.File]::ReadAllText($configPath) -ceq $runtimeBeforeRepair) 'staging failure leaves live tasks and runtime untouched'
$script:Calls.Clear()
Invoke-CodeyWindowsInstall @repairArgs | Out-Null
$config = Read-CodeyJson $configPath
Check ($config.ready -and -not $config.repairPending) 'service repair finishes ready'
Check ($config.modelKey -ceq $keyBefore) 'service repair preserves model API key'
Check ((Get-FileHash -LiteralPath (Join-Path $config.services.codey.environment.COPILOT_API_HOME 'github_token')).Hash -eq $credentialHash) 'service repair preserves GitHub credential bytes'
Check ([IO.File]::ReadAllText((Join-Path $script:FixtureHome 'codey-machine-registration.json')) -ceq $registrationBefore) 'service repair preserves registration'
Check ([IO.File]::ReadAllText((Join-Path $config.codexHome 'config.toml')) -ceq $codexBefore) 'service repair preserves Codex configuration'
Check ($script:Calls.Contains('npm-install') -and -not $script:Calls.Contains('copilot-login') -and
    -not $script:Calls.Contains('tls') -and -not $script:Calls.Contains('official-codex-install') -and
    -not $script:Calls.Contains('user-environment')) 'repair never reauthenticates or rotates installation state'
Check ($config.services.codey.environment.COPILOT_API_GITHUB_TOKEN -ceq '' -and
    $config.services.codey.environment.COPILOT_API_OAUTH_APP -ceq '' -and
    $config.services.codey.environment.COPILOT_API_ENTERPRISE_URL -ceq '') 'scheduled and manual starts pin the same credential namespace'
Check ($global:CodeyFixtureTaskCalls.Contains('stop:codey') -and
    $global:CodeyFixtureTaskCalls.Contains('start:codey')) 'only explicit service repair restarts Codey'

# Full replacement stops the exact old task set; identity/auth/session files survive.
$script:Calls.Clear(); $global:CodeyFixtureTaskCalls.Clear()
Invoke-CodeyWindowsInstall @invoke | Out-Null
Check ([IO.File]::ReadAllText($config.identityFile) -eq $identityBefore) 'replacement preserves node identity and enrollment keys'
Check ($global:CodeyFixtureTaskCalls.Contains('stop:codey')) 'replacement stops the single old Codey service tree'

# Task ownership mismatch must reject the entire set before changing any task.
$config = Read-CodeyJson $configPath
$name = "Codey Machine $($config.nodeId) tunnel"
$savedArguments = $global:CodeyFixtureTasks[$name].Definition.Actions[0].Arguments
$global:CodeyFixtureTasks[$name].Definition.Actions[0].Arguments = 'foreign'
$global:CodeyFixtureTaskCalls.Clear()
Reject { Set-CodeyTaskState $config $configPath @('codey', 'tunnel') } 'foreign task action is rejected'
Check ($global:CodeyFixtureTaskCalls.Count -eq 0) 'task validation precedes every state change'
$global:CodeyFixtureTasks[$name].Definition.Actions[0].Arguments = $savedArguments

# Seeing the marker in prompt/stdout is not a model response. Failure disables
# only this attempt's own tasks and leaves a recoverable not-ready runtime.
$script:BadAnswer = $true
$script:Calls.Clear(); $global:CodeyFixtureTaskCalls.Clear()
Reject { Invoke-CodeyWindowsInstall @invoke } 'prompt echo is not accepted as model success'
Check (-not (Read-CodeyJson $configPath).ready) 'failed install is never marked ready'
Check (-not $script:Calls.Contains('user-environment')) 'failed install does not change user model environment'
Check (-not $script:Calls.Contains('user-path')) 'failed probes never register a new user PATH'
foreach ($component in @('codey', 'tunnel', 'renew')) {
    Check ($global:CodeyFixtureTaskCalls.Contains("stop:$component")) "failure stops owned $component task"
}
Check ([IO.File]::ReadAllText($config.identityFile) -eq $identityBefore) 'failure preserves enrollment identity'
Reject { New-CodeyIdentity $config.identityFile ([pscustomobject]@{
    Sid = $script:FixtureSid; Computer = 'ANOTHER-PC'
}) } 'copied machine identity cannot be silently reused on another computer'

Write-Output ('FIXTURE_RESULT=' + (@{ passed = $script:Checks.Count; checks = @($script:Checks) } | ConvertTo-Json -Compress -Depth 5))
