#requires -Version 5.1
# Independent native tool transactions; original watchdogs/identity/login/configuration are retained.
[CmdletBinding()]
param([Parameter(Mandatory = $true)][ValidateSet('plan', 'apply', 'recover')][string]$Action,
      [Parameter(Mandatory = $true)][string]$InputPath)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$toolAction = $Action
$toolInputPath = $InputPath
. (Join-Path $PSScriptRoot 'update-windows.ps1') -Library
$Action = $toolAction
$InputPath = $toolInputPath

function Get-ToolVersion {
    param($Config, [string]$File, [string]$Component)
    $output = (Invoke-CodeyProcess $File @('--version') -TimeoutSeconds 15).Stdout.Trim()
    $prefix = if ($Component -eq 'codex') { 'codex(?:-cli)?' } else { 'devtunnel' }
    Require-Update ($output -match ('^' + $prefix + '\s+(?:version\s+)?v?(\d+\.\d+\.\d+(?:\.\d+)?(?:[-+][A-Za-z0-9.-]+)?)(?:\s|$)')) `
        'Unrecognized installed native tool version.'
    return $Matches[1]
}

function Get-ToolTaskComponents {
    param([string]$Component)
    if ($Component -eq 'codex') { return ,@('codey') }
    Require-Update ($Component -eq 'devtunnel') 'Unknown native update component.'
    # The renewal watchdog is NOT killed: an in-flight one-shot may finish on the
    # immutable old exe; its next invocation reads the updated runtime descriptor.
    return ,@('tunnel')
}

function New-ToolRuntime {
    param($Config, $Request)
    $next = $Config | ConvertTo-Json -Depth 30 | ConvertFrom-Json
    if ($Request.component -eq 'devtunnel') {
        Require-Update ($Config.services.tunnel.executable -eq $Config.devtunnelExe -and
            $Config.services.renew.executable -eq $Config.nodeExe -and
            @($Config.services.renew.arguments).Count -eq 3 -and
            $Config.services.renew.arguments[0] -eq $Config.helperPath -and
            $Config.services.renew.arguments[1] -eq 'renew' -and
            $Config.services.renew.arguments[2] -eq $script:configFile) 'Unknown tunnel/renewal commands.'
        $next.devtunnelExe = $Request.candidate
        $next.services.tunnel.executable = $Request.candidate
    } else { Require-Update ($Request.component -eq 'codex') 'Unknown tool component.' }
    # Codex retains the CLI alias AND CODEY_CODEX_EXECUTABLE; only its directory pointer changes.
    return $next
}

function Assert-ToolExternalTerminal {
    $processes = @(Get-CodeyProcesses $script:owner.Sid)
    $currentId = $PID
    for ($i = 0; $i -lt 100 -and $currentId; $i++) {
        $parent = @($processes | Where-Object { $_.ProcessId -eq $currentId })
        if (-not $parent.Count) { return }
        Require-Update ($parent[0].Name -notmatch '^codex(\.exe)?$' -and
            $parent[0].CommandLine -notmatch 'codey\.mjs"?\s+"?(start|workspace|gateway)\b') `
            'Run tool updates in a separate owner terminal, never inside Codey or Codex.'
        $currentId = $parent[0].ParentProcessId
    }
    Require-Update (-not $currentId) 'Could not verify an external terminal.'
}

function Test-WorkspaceDescendant {
    param($Process, $Processes, $Config)
    $currentId = $Process.ParentProcessId
    for ($i = 0; $i -lt 100 -and $currentId; $i++) {
        $parents = @($Processes | Where-Object { $_.ProcessId -eq $currentId })
        if (-not $parents.Count) { return $false }
        $parent = $parents[0]
        if ($parent.ExecutablePath -eq $Config.nodeExe -and
            $parent.CommandLine -match ([regex]::Escape($Config.codeyBin) + '"?\s+"?(start|workspace)"?(?:\s|$)')) {
            return $true
        }
        $currentId = $parent.ParentProcessId
    }
    return $false
}

function Assert-ToolProcesses {
    param($Config, [string]$Component, [switch]$Stopped)
    $processes = @(Get-CodeyProcesses $script:owner.Sid)
    if ($Component -eq 'codex') {
        foreach ($process in @($processes | Where-Object { $_.Name -ieq 'codex.exe' })) {
            Require-Update (-not $Stopped -and $process.CommandLine -match '\bapp-server\b' -and
                (Test-WorkspaceDescendant $process $processes $Config)) `
                'Finish external native Codex tasks first; CLI/Desktop processes will not be killed.'
        }
    } else {
        foreach ($process in @($processes | Where-Object { $_.Name -ieq 'devtunnel.exe' -and $_.CommandLine -match '(?:^|\s)"?host"?(?:\s|$)' })) {
            Require-Update (-not $Stopped -and $process.ExecutablePath -eq $Config.devtunnelExe) `
                'Another native tunnel host is running; it will not be terminated.'
        }
    }
}

function Assert-ToolPayload {
    param($Request, [string]$Job)
    $manifestFile = Assert-CodeyPath (Join-Path $Job 'tool-update.json') $Job
    Require-Update ((Get-UpdateHash $manifestFile) -eq $Request.sha256) 'Reviewed tool manifest changed.'
    $manifest = Read-UpdateJson $manifestFile
    $payload = Assert-CodeyPath (Join-Path $Job 'payload') $Job
    $entry = $Request.component + '.exe'
    Require-Update ($manifest.schema -eq 1 -and $manifest.kind -eq 'codey-tool-update' -and
        $manifest.platform -eq 'windows-x64' -and $manifest.component -eq $Request.component -and
        $manifest.version -eq $Request.version -and $manifest.entry -eq $entry -and
        $Request.candidate -eq (Join-Path $payload $entry)) 'Tool request does not match its manifest.'
    $names = @($manifest.files.PSObject.Properties.Name)
    $actual = @(Get-ChildItem -LiteralPath $payload -Recurse -Force -File)
    Require-Update ($actual.Count -eq $names.Count) 'Native companion file set changed.'
    foreach ($file in $actual) {
        $null = Assert-HomePath $file.FullName $script:owner.Home
        $name = $file.FullName.Substring($payload.Length + 1).Replace('\', '/')
        Require-Update ($names -ccontains $name) 'Unexpected native companion file.'
        $expected = $manifest.files.PSObject.Properties[$name].Value
        Require-Update ($file.Length -eq $expected.size -and (Get-UpdateHash $file.FullName) -eq $expected.sha256) `
            'Native companion checksum changed.'
    }
    Require-Update ((Get-UpdateHash $Request.candidate) -eq $Request.entrySha256) 'Native executable changed.'
}

function Get-WindowsToolPlan {
    param($Config, [string]$Component, [string]$Root)
    Require-Update ($Config.ready -and $Root -eq $Config.codeyDirectory) 'This CLI is not the managed Codey package.'
    $components = Get-ToolTaskComponents $Component
    foreach ($name in $components) {
        $task = (Get-CodeyTaskFolder).Folder.GetTask("Codey Machine $($Config.nodeId) $name")
        Assert-CodeyTask $task $Config $script:configFile $name
        Require-Update ($task.Enabled -and $task.State -eq 4) 'The component watchdog must already be running.'
    }
    $tool = if ($Component -eq 'codex') { Get-ManagedCodexPath $Config } else {
        $null = Assert-HomePath $Config.devtunnelExe $script:owner.Home
        Require-Update ($Config.services.tunnel.executable -eq $Config.devtunnelExe -and
            @($Config.services.tunnel.arguments).Count -eq 6 -and
            $Config.services.tunnel.arguments[0] -eq 'host' -and
            $Config.services.tunnel.arguments[1] -match '^[a-z0-9][a-z0-9-]{1,58}\.[a-z0-9]{2,12}$' -and
            (($Config.services.tunnel.arguments[2..5]) -join ' ') -eq '--host-header unchanged --origin-header unchanged') `
            'Unknown tunnel launch command.'
        [pscustomobject]@{ anchor = $Config.devtunnelExe; executable = $Config.devtunnelExe; resolved = $Config.devtunnelExe
            target = (Split-Path -Parent $Config.devtunnelExe); anchorKind = 'descriptor'; entrySha256 = Get-UpdateHash $Config.devtunnelExe }
    }
    return @{ kind = 'windows-tool'; component = $Component; root = $Config.codeyDirectory; node = $Config.nodeExe
        jobsRoot = (Join-Path $Config.runtimeRoot 'local-updates'); configHash = Get-UpdateHash $script:configFile
        protected = Get-ProtectedHashes $Config $Component; anchor = $tool.anchor; tool = $tool
        entrySha256 = $tool.entrySha256; version = Get-ToolVersion $Config $tool.executable $Component
        codeyEntrySha256 = Get-UpdateHash (Join-Path $Config.codeyDirectory 'codey-build.json')
        services = @($components | ForEach-Object { "Codey Machine $($Config.nodeId) $_" })
        tunnelId = $(if ($Component -eq 'devtunnel') { $Config.services.tunnel.arguments[1] } else { '' }) }
}

function Switch-CodexPointer {
    param($Config, $Request, [string]$Job)
    $current = Get-ManagedCodexPath $Config
    Require-Update ($current.resolved -eq $Request.plan.tool.resolved -and
        $current.entrySha256 -eq $Request.plan.tool.entrySha256 -and
        $current.anchorKind -eq $Request.plan.tool.anchorKind) 'Codex entrypoint changed before switching.'
    $backup = Join-Path $Job 'previous-codex'
    Require-Update (-not (Test-Path -LiteralPath $backup) -and
        [IO.Path]::GetPathRoot($current.anchor) -eq [IO.Path]::GetPathRoot($backup)) 'Invalid Codex rollback directory.'
    [IO.Directory]::Move($current.anchor, $backup)
    $null = New-Item -ItemType Junction -Path $current.anchor -Target (Split-Path -Parent $Request.candidate)
}

function Restore-CodexPointer {
    param($Config, $Request, [string]$Job, [switch]$CheckOnly)
    $anchor = $Request.plan.tool.anchor
    Require-Update ($anchor -eq (Join-Path $Config.runtimeRoot 'codex-bin')) 'Unknown Codex alias during recovery.'
    $null = Assert-HomePath (Split-Path -Parent $anchor) $script:owner.Home
    $backup = Join-Path $Job 'previous-codex'
    if (Test-Path -LiteralPath $backup) {
        $item = Get-Item -LiteralPath $backup -Force
        $linked = [bool]($item.Attributes -band [IO.FileAttributes]::ReparsePoint)
        Require-Update (($linked -and $Request.plan.tool.anchorKind -eq 'junction' -and $item.LinkType -eq 'Junction') -or
            (-not $linked -and $Request.plan.tool.anchorKind -eq 'directory')) 'Codex backup type changed.'
        $backupExe = Join-Path $backup 'codex.exe'
        $resolved = (Invoke-CodeyProcess $Config.nodeExe @('-p',
            'require("node:fs").realpathSync(process.argv[1])', $backupExe) -TimeoutSeconds 10).Stdout.Trim()
        $null = Assert-HomePath $resolved $script:owner.Home
        Require-Update ((-not $linked -or $resolved -eq $Request.plan.tool.resolved) -and
            (Get-UpdateHash $resolved) -eq $Request.plan.tool.entrySha256) 'Original Codex distribution changed.'
        if (Test-Path -LiteralPath $anchor) {
            $active = Get-ManagedCodexPath $Config
            Require-Update ($active.anchorKind -eq 'junction' -and $active.resolved -eq $Request.candidate) `
                'Another installation changed the Codex alias; refusing to overwrite it.'
        }
        if ($CheckOnly) { return }
        if (Test-Path -LiteralPath $anchor) {
            # Delete only the junction itself. NEVER recurse into an official version store.
            [IO.Directory]::Delete($anchor, $false)
        }
        [IO.Directory]::Move($backup, $anchor)
    } else {
        $active = Get-ManagedCodexPath $Config
        Require-Update ($active.resolved -eq $Request.plan.tool.resolved -and
            $active.entrySha256 -eq $Request.plan.tool.entrySha256) 'Original Codex entrypoint is missing.'
    }
}

function Stop-ToolScope {
    param($Config, [string]$Component)
    Set-CodeyTaskState $Config $script:configFile (Get-ToolTaskComponents $Component)
    if ($Component -eq 'codex') { Wait-CodeyStopped }
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        try { Assert-ToolProcesses $Config $Component -Stopped; return } catch {
            if ($attempt -eq 29) { throw }
            Start-Sleep -Milliseconds 500
        }
    }
}

function Wait-ToolHealth {
    param($Config, $Request, [string]$Job, [switch]$Rollback)
    $version = (Read-UpdateJson (Join-Path $Config.codeyDirectory 'package.json')).version
    $expected = if ($Rollback) { $Request.plan.entrySha256 } else { $Request.entrySha256 }
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        try {
            Require-Update ((Get-UpdateHash (Join-Path $Config.codeyDirectory 'codey-build.json')) -eq $Request.plan.codeyEntrySha256) `
                'Codey changed during a tool update.'
            Assert-Protected $Request.plan.protected
            Wait-UpdatedCodey $Config $Job $version
            if ($Request.component -eq 'codex') {
                $tool = Get-ManagedCodexPath $Config
                Require-Update ($tool.entrySha256 -eq $expected) 'The Codex alias uses an unexpected binary.'
                if (-not $Rollback) {
                    Require-Update ($tool.resolved -eq $Request.candidate) 'Another installation moved the Codex alias.'
                    $null = Invoke-CodeyProcess $Config.nodeExe @((Join-Path $Job 'tool-update-probe.mjs'), 'probe',
                        (Join-Path $Job 'request.json'), $Config.codexExe) -TimeoutSeconds 50
                    Require-Update ((Get-ManagedCodexPath $Config).resolved -eq $Request.candidate) 'Codex alias changed during verification.'
                }
            } else {
                Require-Update ((Get-UpdateHash $Config.devtunnelExe) -eq $expected) 'Unexpected tunnel binary.'
                $task = (Get-CodeyTaskFolder).Folder.GetTask("Codey Machine $($Config.nodeId) tunnel")
                Assert-CodeyTask $task $Config $script:configFile 'tunnel'
                $hosts = @(Get-CodeyProcesses $script:owner.Sid | Where-Object {
                    $_.ExecutablePath -eq $Config.devtunnelExe -and $_.CommandLine -match '(?:^|\s)"?host"?(?:\s|$)' })
                Require-Update ($task.Enabled -and $task.State -eq 4 -and $hosts.Count -eq 1) 'The selected tunnel host is not running.'
                $null = Invoke-CodeyProcess $Config.nodeExe @((Join-Path $Job 'tool-update-probe.mjs'), 'tunnel',
                    (Join-Path $Job 'request.json'), $Config.devtunnelExe) -TimeoutSeconds 30
            }
            if (-not $Rollback) { Assert-ToolPayload $Request $Job }
            Assert-Protected $Request.plan.protected
            return
        } catch {
            if ($attempt -eq 29) { throw }
            Start-Sleep -Seconds 1
        }
    }
}

function Restore-ToolUpdate {
    param($Journal, [string]$Job)
    $request = $Journal.request
    $beforeFile = Join-Path $Job 'runtime-before.json'
    Require-Update ((Get-UpdateHash $beforeFile) -eq $Journal.beforeHash -and
        (Get-UpdateHash $script:configFile) -in @($Journal.beforeHash, $Journal.afterHash)) `
        'Concurrent runtime change; refusing to overwrite another deployment.'
    Assert-Protected $request.plan.protected
    $original = Read-UpdateJson $beforeFile
    $current = Read-UpdateJson $script:configFile
    Assert-ToolExternalTerminal
    if ($request.component -eq 'codex') { Restore-CodexPointer $original $request $Job -CheckOnly }
    else { Require-Update ((Get-UpdateHash $original.devtunnelExe) -eq $request.plan.entrySha256) 'Original DevTunnel changed.' }
    Stop-ToolScope $current $request.component
    if ($request.component -eq 'codex') { Restore-CodexPointer $original $request $Job }
    # Only these two descriptor fields could have changed; never restore keys, DBs or login state.
    Write-CodeyFile $script:configFile ([IO.File]::ReadAllText($beforeFile, [Text.Encoding]::UTF8))
    Set-CodeyTaskState $original $script:configFile (Get-ToolTaskComponents $request.component) -Start
    Wait-ToolHealth $original $request $Job -Rollback
    $Journal.state = 'rolled_back'
    Write-CodeyJson (Join-Path $Job 'local-update.json') $Journal
}

try {
    . Initialize-LocalWindows
    if ($Action -eq 'plan') {
        $options = $InputPath | ConvertFrom-Json
        $result = Get-WindowsToolPlan $config $options.component $options.root
    } else {
        $null = Assert-CodeyPath $InputPath $jobsRoot
        $document = Read-UpdateJson $InputPath
        $request = if ($Action -eq 'recover') { $document.request } else { $document }
        $job = Assert-CodeyPath $request.job $jobsRoot
        Require-Update ((Split-Path -Parent $job) -eq $jobsRoot) 'Unexpected tool update job.'
        $mutex = [Threading.Mutex]::new($false, ('Local\CodeyWindowsInstall-' + $owner.Sid))
        $held = $false
        try {
            try { $held = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $held = $true }
            Require-Update $held 'Another installation/update is running for this owner.'
            if ($Action -eq 'recover') {
                if ($document.state -notin @('complete', 'rolled_back', 'aborted')) { Restore-ToolUpdate $document $job }
                $result = @{ ok = $true; recovered = $document.state; modelRequests = $false }
            } else {
                Require-Update ($request.component -ne 'devtunnel' -or $request.allowDisconnect -eq $true) `
                    'Explicit tunnel disconnect consent is required.'
                Require-Update ((Get-UpdateHash $configFile) -eq $request.plan.configHash) 'Runtime changed during staging.'
                Assert-Protected $request.plan.protected
                Assert-ToolExternalTerminal
                Assert-ToolProcesses $config $request.component
                Invoke-UpdateProbe $config $job 'idle'
                Assert-ModelIdle
                Assert-ToolPayload $request $job
                $beforeFile = Join-Path $job 'runtime-before.json'
                [IO.File]::WriteAllBytes($beforeFile, [IO.File]::ReadAllBytes($configFile))
                Protect-CodeyPath $beforeFile
                $next = New-ToolRuntime $config $request
                $afterFile = Join-Path $job 'runtime-after.json'
                if ($request.component -eq 'codex') {
                    [IO.File]::WriteAllBytes($afterFile, [IO.File]::ReadAllBytes($configFile))
                    Protect-CodeyPath $afterFile
                } else { Write-CodeyJson $afterFile $next }
                $journal = [pscustomobject]@{ schema = 1; kind = 'windows-tool'; state = 'applying'; request = $request
                    beforeHash = Get-UpdateHash $beforeFile; afterHash = Get-UpdateHash $afterFile }
                Require-Update ($journal.beforeHash -eq $request.plan.configHash) 'Runtime changed while preparing rollback records.'
                Write-CodeyJson (Join-Path $job 'local-update.json') $journal
                try {
                    Stop-ToolScope $config $request.component
                    Require-Update ((Get-UpdateHash $configFile) -eq $journal.beforeHash) 'Runtime changed during service stop.'
                    Assert-Protected $request.plan.protected
                    Assert-ToolPayload $request $job
                    if ($request.component -eq 'codex') { Switch-CodexPointer $config $request $job }
                    else {
                        Require-Update ((Get-UpdateHash $config.devtunnelExe) -eq $request.plan.entrySha256) 'Original DevTunnel changed.'
                        Write-CodeyFile $configFile ([IO.File]::ReadAllText($afterFile, [Text.Encoding]::UTF8))
                    }
                    Set-CodeyTaskState $next $configFile (Get-ToolTaskComponents $request.component) -Start
                    Wait-ToolHealth $next $request $job
                    Require-Update ((Get-UpdateHash $configFile) -eq $journal.afterHash) 'Runtime changed during tool verification.'
                    $journal.state = 'complete'
                    Write-CodeyJson (Join-Path $job 'local-update.json') $journal
                } catch {
                    Restore-ToolUpdate $journal $job
                    throw
                }
                $result = @{ ok = $true; version = $request.version; source = 'local-tool'; modelRequests = $false }
            }
        } finally {
            if ($held) { $mutex.ReleaseMutex() }
            $mutex.Dispose()
        }
    }
    $result | ConvertTo-Json -Depth 16 -Compress
} catch {
    $message = $_.Exception.Message
    if ($message.StartsWith('CODEY_LOCAL_UPDATE: ')) { [Console]::Error.WriteLine($message.Substring('CODEY_LOCAL_UPDATE: '.Length)) }
    else { [Console]::Error.WriteLine('Native tool update failed; inspect the private job and existing services.') }
    exit 1
}
