#requires -Version 5.1
# Local package maintenance only. Never invoke setup, install tools or replace login tasks.
[CmdletBinding()]
param(
    [ValidateSet('plan', 'apply', 'recover')][string]$Action,
    [string]$InputPath,
    [switch]$Library
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Require-Update {
    param($Value, [string]$Message)
    if (-not $Value) { throw ('CODEY_LOCAL_UPDATE: ' + $Message) }
}

function Read-UpdateJson {
    param([string]$File)
    [IO.File]::ReadAllText($File, [Text.Encoding]::UTF8) | ConvertFrom-Json
}

function Get-UpdateHash {
    param([string]$File)
    (Get-FileHash -LiteralPath $File -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
}

function Assert-HomePath {
    param([string]$File, [string]$OwnerHome)
    $full = [IO.Path]::GetFullPath($File)
    Require-Update ($full.StartsWith($OwnerHome.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) `
        'Update path is outside the original owner profile.'
    $cursor = $full
    while ($cursor -and $cursor -ne $OwnerHome) {
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force
            Require-Update (-not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) `
                'Linked update paths require manual review.'
            $acl = Get-Acl -LiteralPath $cursor
            Require-Update ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -eq $script:ownerSid) `
                'Update path belongs to another owner.'
        }
        $cursor = Split-Path -Parent $cursor
    }
    $full
}

function Get-ProtectedHashes {
    param($Config, [ValidateSet('', 'codex', 'devtunnel')][string]$ExcludeTool = '')
    $files = @($Config.nodeExe, $Config.identityFile, $Config.certificate)
    if ($ExcludeTool -ne 'devtunnel') { $files += $Config.devtunnelExe }
    if ($ExcludeTool -ne 'codex') {
        # The official standalone installer owns one known codex-bin junction.
        $null = Get-ManagedCodexPath $Config
        $files += $Config.codexExe
    }
    $envMap = $Config.services.codey.environment
    foreach ($name in @('COPILOT_API_CODEY_TLS_KEY', 'COPILOT_API_CODEY_SIGNING_KEY_FILE')) {
        if ($envMap.PSObject.Properties[$name]) { $files += $envMap.$name }
    }
    foreach ($name in @('config.toml', 'models.json')) {
        $file = Join-Path $Config.codexHome $name
        if (Test-Path -LiteralPath $file) { $files += $file }
    }
    $files += Join-Path $envMap.COPILOT_API_HOME 'config.json'
    $result = [ordered]@{}
    foreach ($file in @($files | Sort-Object -Unique)) {
        if ($file -ne $Config.codexExe) { $null = Assert-HomePath $file $script:owner.Home }
        $result[$file] = Get-UpdateHash $file
    }
    $result
}

function Get-ManagedCodexPath {
    param($Config)
    $anchor = Join-Path $Config.runtimeRoot 'codex-bin'
    Require-Update ($Config.codexExe -eq (Join-Path $anchor 'codex.exe') -and
        $Config.services.codey.environment.CODEY_CODEX_EXECUTABLE -eq $Config.codexExe) `
        'Codex must use the existing owner-managed native CLI, not a Desktop/system installation.'
    $null = Assert-HomePath (Split-Path -Parent $anchor) $script:owner.Home
    $item = Get-Item -LiteralPath $anchor -Force
    $linked = [bool]($item.Attributes -band [IO.FileAttributes]::ReparsePoint)
    Require-Update ($item.PSIsContainer -and (-not $linked -or $item.LinkType -eq 'Junction')) `
        'Only the official standalone Codex directory/junction is supported.'
    Require-Update ((Get-Acl -LiteralPath $anchor).GetOwner([Security.Principal.SecurityIdentifier]).Value -eq $script:owner.Sid) `
        'The Codex entrypoint belongs to another owner.'
    $resolved = (Invoke-CodeyProcess $Config.nodeExe @('-p',
        'require("node:fs").realpathSync(process.argv[1])', $Config.codexExe) -TimeoutSeconds 10).Stdout.Trim()
    $null = Assert-HomePath $resolved $script:owner.Home
    if ($linked) {
        $store = $Config.codexStandaloneRoot.TrimEnd('\') + '\'
        $updates = (Join-Path $Config.runtimeRoot 'local-updates').TrimEnd('\') + '\'
        Require-Update ($resolved.StartsWith($store, [StringComparison]::OrdinalIgnoreCase) -or
            ($resolved.StartsWith($updates, [StringComparison]::OrdinalIgnoreCase) -and
             $resolved.Substring($updates.Length) -match '^[a-f0-9]{32}\\payload\\codex\.exe$')) `
            'The Codex junction targets an unknown installation.'
    } else {
        Require-Update ($resolved -eq $Config.codexExe) 'Unexpected linked Codex executable.'
    }
    return [pscustomobject]@{ anchor = $anchor; executable = $Config.codexExe; resolved = $resolved
        target = (Split-Path -Parent $resolved); anchorKind = $(if ($linked) { 'junction' } else { 'directory' })
        entrySha256 = Get-UpdateHash $resolved }
}

function Assert-Protected {
    param($Expected)
    foreach ($property in $Expected.PSObject.Properties) {
        Require-Update ((Get-UpdateHash $property.Name) -eq $property.Value) `
            'A tool, identity, certificate or model configuration changed; no stale data will be restored.'
    }
}

function Assert-ExternalUpdate {
    $processes = @(Get-CodeyProcesses $script:owner.Sid)
    $currentId = $PID
    for ($i = 0; $i -lt 100 -and $currentId; $i++) {
        $parent = @($processes | Where-Object { $_.ProcessId -eq $currentId })
        if (-not $parent.Count) { break }
        Require-Update ($parent[0].Name -notmatch '^codex(\.exe)?$' -and
            $parent[0].CommandLine -notmatch 'codey\.mjs"?\s+"?(start|workspace|gateway)\b') `
            'Run codey update in a separate owner terminal, not inside Codey or Codex.'
        $currentId = $parent[0].ParentProcessId
    }
    Require-Update (-not @($processes | Where-Object { $_.Name -ieq 'codex.exe' }).Count) `
        'Finish native Codex tasks before updating; they will not be terminated.'
}

function Assert-ModelIdle {
    try {
        $connections = @(Get-NetTCPConnection -LocalPort 4141 -State Established -ErrorAction Stop)
    } catch {
        if ($_.CategoryInfo.Category -ne 'ObjectNotFound') { throw }
        $connections = @()
    }
    Require-Update (-not $connections.Count) 'Active model sockets block this update.'
}

function Invoke-UpdateProbe {
    param($Config, [string]$Job, [string]$Mode, [string]$Version = '')
    $arguments = @((Join-Path $Job 'update-probe.mjs'), $script:configFile, $Mode)
    if ($Version) { $arguments += $Version }
    $null = Invoke-CodeyProcess $Config.nodeExe $arguments -TimeoutSeconds 50
}

function Wait-UpdatedCodey {
    param($Config, [string]$Job, [string]$Version)
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        try {
            $task = (Get-CodeyTaskFolder).Folder.GetTask("Codey Machine $($Config.nodeId) codey")
            Assert-CodeyTask $task $Config $script:configFile 'codey'
            Require-Update ($task.Enabled -and $task.State -eq 4) 'Codey watchdog is not running.'
            Invoke-UpdateProbe $Config $Job 'health' $Version
            return
        } catch {
            if ($attempt -eq 29) { throw }
            Start-Sleep -Seconds 1
        }
    }
}

function Wait-CodeyStopped {
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
        $listeners = @([Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() |
            Where-Object { $_.Port -in @(3001, 4141, 8443) })
        if (-not $listeners.Count) { return }
        Start-Sleep -Milliseconds 500
    }
    throw 'Codey listeners did not stop; no unrelated process will be killed.'
}

function New-UpdatedCodeyRuntime {
    param($Config, $Request)
    Require-Update (@($Config.services.codey.arguments).Count -ge 2 -and
        $Config.services.codey.arguments[1] -eq 'start') 'The managed task must run codey start, never setup or another command.'
    $next = $Config | ConvertTo-Json -Depth 30 | ConvertFrom-Json
    $next.codeyDirectory = $Request.candidate
    $next.codeyBin = Join-Path $Request.candidate 'bin\codey.mjs'
    $next.releaseId = 'machine-' + $Request.entrySha256.Substring(0, 16)
    $next.npmPackage = $Request.packageName
    $next.npmPackageSha256 = $Request.sha256
    $next.services.codey.arguments[0] = $next.codeyBin
    $next.services.codey.workingDirectory = $Request.candidate
    # releaseDirectory, tools, helpers, task definitions, environment and credentials stay untouched.
    return $next
}

function Restore-LocalUpdate {
    param($Journal, [string]$Job)
    $beforeFile = Join-Path $Job 'runtime-before.json'
    $original = Read-UpdateJson $beforeFile
    Require-Update ((Get-UpdateHash $beforeFile) -eq $Journal.beforeHash -and
        (Get-UpdateHash $script:configFile) -in @($Journal.beforeHash, $Journal.afterHash)) `
        'Concurrent runtime change; refusing to overwrite another deployment.'
    $current = Read-UpdateJson $script:configFile
    Set-CodeyTaskState $current $script:configFile @('codey')
    Wait-CodeyStopped
    Write-CodeyFile $script:configFile ([IO.File]::ReadAllText($beforeFile, [Text.Encoding]::UTF8))
    Set-CodeyTaskState $original $script:configFile @('codey') -Start
    $version = (Read-UpdateJson (Join-Path $original.codeyDirectory 'package.json')).version
    Wait-UpdatedCodey $original $Job $version
    $Journal.state = 'rolled_back'
    Write-CodeyJson (Join-Path $Job 'local-update.json') $Journal
}

function Initialize-LocalWindows {
    $script:ownerSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $ownerHome = [Environment]::GetFolderPath('UserProfile')
    $script:configFile = Join-Path $ownerHome '.config\codey-machine-windows\runtime.json'
    $null = Assert-HomePath $configFile $ownerHome
    $config = Read-UpdateJson $configFile
    Require-Update ($config.schema -eq 2 -and $config.kind -eq 'codey-windows-oneclick' -and
        $config.layout -eq 'npm-codey-package' -and $config.ownerSid -eq $ownerSid -and
        $config.ownerHome -eq $ownerHome -and $config.computer -ceq $env:COMPUTERNAME -and
        $config.runtimeRoot -eq (Join-Path $ownerHome '.local\share\codey-machine-windows')) `
        'This is not an existing owner-managed Codey installation.'
    $common = Join-Path (Split-Path -Parent $config.runnerPath) 'windows-common.ps1'
    $null = Assert-HomePath $common $ownerHome
    Require-Update ((Get-UpdateHash $common) -eq $config.helperHashes.'windows-common.ps1'.ToLowerInvariant()) `
        'Pinned Windows service helpers changed.'
    . $common
    $script:owner = Get-CodeyOwner
    foreach ($file in @($config.runnerPath, (Join-Path (Split-Path -Parent $common) 'windows-process.cs'), $config.helperPath)) {
        $null = Assert-CodeyPath $file $config.runtimeRoot
        Require-Update ((Get-UpdateHash $file) -eq $config.helperHashes.([IO.Path]::GetFileName($file)).ToLowerInvariant()) `
            'Pinned Windows service helper changed.'
    }
    foreach ($file in @($config.nodeExe, $config.codeyDirectory, $config.codeyBin, $config.identityFile)) {
        $null = Assert-CodeyPath $file $config.runtimeRoot
    }
    Require-Update ($config.codeyBin -eq (Join-Path $config.codeyDirectory 'bin\codey.mjs') -and
        $config.services.codey.executable -eq $config.nodeExe -and
        @($config.services.codey.arguments).Count -ge 2 -and
        $config.services.codey.arguments[1] -eq 'start' -and
        $config.services.codey.arguments[0] -eq $config.codeyBin -and
        $config.services.codey.workingDirectory -eq $config.codeyDirectory) 'Unrecognized Codey service command.'
    $task = (Get-CodeyTaskFolder).Folder.GetTask("Codey Machine $($config.nodeId) codey")
    Assert-CodeyTask $task $config $configFile 'codey'
    $jobsRoot = Join-Path $config.runtimeRoot 'local-updates'
}

if ($Library) { return }
try {
    Require-Update ($Action -and $InputPath) 'Specify the update action and input.'
    # Dot-source so only these reviewed functions can load the already pinned OS helper.
    . Initialize-LocalWindows
    if ($Action -eq 'plan') {
        Require-Update ($config.ready -and $task.Enabled -and $task.State -eq 4 -and
            [IO.Path]::GetFullPath($InputPath).TrimEnd('\') -eq $config.codeyDirectory) `
            'This CLI is not the running Windows node package.'
        $result = @{ kind = 'windows-managed'; root = $config.codeyDirectory; node = $config.nodeExe
            jobsRoot = $jobsRoot; configHash = Get-UpdateHash $configFile
            protected = Get-ProtectedHashes $config; services = @("Codey Machine $($config.nodeId) codey") }
    } else {
        $null = Assert-CodeyPath $InputPath $jobsRoot
        $inputDocument = Read-UpdateJson $InputPath
        $request = if ($Action -eq 'recover') { $inputDocument.request } else { $inputDocument }
        $job = Assert-CodeyPath $request.job $jobsRoot
        Require-Update ((Split-Path -Parent $job) -eq $jobsRoot) 'Unexpected local update job directory.'
        $mutex = [Threading.Mutex]::new($false, ('Local\CodeyWindowsInstall-' + $owner.Sid))
        $held = $false
        try {
            try { $held = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $held = $true }
            Require-Update $held 'Another Codey installer/update is running for this owner.'
            if ($Action -eq 'recover') {
                if ($inputDocument.state -notin @('complete', 'rolled_back', 'aborted')) {
                    Restore-LocalUpdate $inputDocument $job
                }
                $result = @{ ok = $true; recovered = $inputDocument.state; modelRequests = $false }
            } else {
                Require-Update ((Get-UpdateHash $configFile) -eq $request.plan.configHash) `
                    'Runtime changed while staging; no service was stopped.'
                Assert-Protected $request.plan.protected
                Assert-ExternalUpdate
                Invoke-UpdateProbe $config $job 'idle'
                Assert-ModelIdle
                $candidate = Assert-CodeyPath $request.candidate $job
                $buildFile = Join-Path $candidate 'codey-build.json'
                $build = Read-UpdateJson $buildFile
                $pkg = Read-UpdateJson (Join-Path $candidate 'package.json')
                Require-Update ($pkg.name -eq 'codey' -and $pkg.version -eq $request.version -and
                    $build.version -eq $request.version -and (Get-UpdateHash $buildFile) -eq $request.entrySha256 -and
                    (Get-UpdateHash (Join-Path $candidate 'npm-shrinkwrap.json')) -eq $build.lockSha256 -and
                    (Get-UpdateHash (Join-Path $candidate 'gateway\main.js')) -eq $build.gatewayEntrySha256 -and
                    (Get-UpdateHash (Join-Path $candidate 'dist-server\server\index.js')) -eq $build.workspaceEntrySha256) `
                    'Staged Codey package changed.'
                $beforeFile = Join-Path $job 'runtime-before.json'
                [IO.File]::WriteAllBytes($beforeFile, [IO.File]::ReadAllBytes($configFile))
                Protect-CodeyPath $beforeFile
                $next = New-UpdatedCodeyRuntime $config $request
                $afterFile = Join-Path $job 'runtime-after.json'
                Write-CodeyJson $afterFile $next
                $journal = [pscustomobject]@{ schema = 1; kind = 'windows-managed'; state = 'applying'
                    request = $request; beforeHash = Get-UpdateHash $beforeFile; afterHash = Get-UpdateHash $afterFile }
                Require-Update ($journal.beforeHash -eq $request.plan.configHash) 'Runtime changed while preparing rollback records.'
                Write-CodeyJson (Join-Path $job 'local-update.json') $journal
                try {
                    Set-CodeyTaskState $config $configFile @('codey')
                    Wait-CodeyStopped
                    Require-Update ((Get-UpdateHash $configFile) -eq $journal.beforeHash) 'Runtime changed during service stop.'
                    Write-CodeyFile $configFile ([IO.File]::ReadAllText($afterFile, [Text.Encoding]::UTF8))
                    Set-CodeyTaskState $next $configFile @('codey') -Start
                    Wait-UpdatedCodey $next $job $request.version
                    Assert-Protected $request.plan.protected
                    Require-Update ((Get-UpdateHash $configFile) -eq $journal.afterHash) 'Runtime changed during verification.'
                    $journal.state = 'complete'
                    Write-CodeyJson (Join-Path $job 'local-update.json') $journal
                } catch {
                    Restore-LocalUpdate $journal $job
                    throw
                }
                $result = @{ ok = $true; version = $request.version; services = $request.plan.services; modelRequests = $false }
            }
        } finally {
            if ($held) { $mutex.ReleaseMutex() }
            $mutex.Dispose()
        }
    }
    $result | ConvertTo-Json -Depth 12 -Compress
} catch {
    # Never print runtime.json, process command lines, tokens or model response bodies.
    $message = $_.Exception.Message
    if ($message.StartsWith('CODEY_LOCAL_UPDATE: ')) {
        [Console]::Error.WriteLine($message.Substring('CODEY_LOCAL_UPDATE: '.Length))
    } else {
        [Console]::Error.WriteLine('Local Codey update failed; inspect the owner-only update job and existing services.')
    }
    exit 1
}
