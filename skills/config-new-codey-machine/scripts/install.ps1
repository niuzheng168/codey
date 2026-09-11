#requires -Version 5.1
<#
.SYNOPSIS
Native Windows counterpart of install.sh. Default: read-only installation plan.
.DESCRIPTION
Use a Windows x64 package built on Windows, not the Linux tarballs or archived
installer. Apply requires an external, non-elevated owner terminal and explicit
network approval. Replacement is limited to this installer's own tasks/services.
The Linux/systemd signed updater is deliberately NOT installed on Windows.
#>
[CmdletBinding()]
param(
    [switch]$Apply,
    [switch]$NetworkApproved,
    [switch]$ReplaceExisting,
    [switch]$RepairServices,
    [string]$ExpectedComputerName = '',
    [string]$CodexHome = '',
    [string]$OpenSslExe = ''
)
. (Join-Path $PSScriptRoot 'windows-common.ps1')
$ProgressPreference = 'SilentlyContinue'

function Read-CodeyWindowsPackage {
    param([string]$Root)
    $assets = Join-Path $Root 'assets'
    $pinFile = Join-Path $Root 'dependencies.windows.json'
    if (-not (Test-Path -LiteralPath $pinFile)) { $pinFile = Join-Path $Root 'dependencies.json' }
    foreach ($name in @('manifest.json', 'setup.json', 'SHA256SUMS')) {
        if (-not (Test-Path -LiteralPath (Join-Path $assets $name) -PathType Leaf)) {
            throw 'A complete native Windows Codey npm package is required.'
        }
    }
    $pins = Read-CodeyJson $pinFile
    $manifest = Read-CodeyJson (Join-Path $assets 'manifest.json')
    $setup = Read-CodeyJson (Join-Path $assets 'setup.json')
    $artifact = @($manifest.artifacts)[0]
    if ($pins.schema -ne 2 -or $pins.platform -ne 'windows-x64' -or
        $pins.npmPackage.name -ne 'codey' -or $pins.npmPackage.dependencies -ne 'npm-shrinkwrap.json' -or
        $manifest.schema -ne 2 -or $manifest.name -ne 'codey' -or $manifest.platform -ne 'windows-x64' -or
        $setup.schema -ne 1 -or $setup.platform -ne 'windows-x64' -or
        $manifest.releaseId -notmatch '^machine-[a-f0-9]{16}$' -or
        $setup.releaseId -ne $manifest.releaseId -or
        $manifest.dependencyMode -ne 'npm-codey-package' -or
        @($manifest.artifacts).Count -ne 1 -or
        $manifest.codey.version -notmatch '^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$' -or
        $artifact.file -ne "codey-$($manifest.codey.version).tgz" -or
        $artifact.sha256 -notmatch '^[a-f0-9]{64}$' -or $artifact.size -le 0 -or
        $manifest.codey.entrySha256 -notmatch '^[a-f0-9]{64}$' -or
        $manifest.codey.lockSha256 -notmatch '^[a-f0-9]{64}$' -or
        (@($manifest.bundledRuntimes) -join ',') -ne 'cloudcli,copilot-api,updater' -or
        $setup.network.mode -ne 'devtunnel' -or $setup.tunnelAuthProvider -ne 'github' -or
        $setup.updater.supported -ne $false -or
        $pins.codex.url -ne 'https://chatgpt.com/codex/install.ps1' -or $pins.codex.release -ne 'latest' -or
        $pins.devTunnel.url -ne 'https://aka.ms/TunnelsCliDownload/win-x64' -or
        $pins.devTunnel.sha256 -notmatch '^[a-f0-9]{64}$' -or $pins.devTunnel.provider -ne 'github' -or
        $manifest.node -ne $pins.node.version -or $pins.node.version -notmatch '^\d+\.\d+\.\d+$' -or
        $pins.node.sha256 -notmatch '^[a-f0-9]{64}$' -or
        $pins.node.url -ne "https://nodejs.org/dist/v$($pins.node.version)/node-v$($pins.node.version)-win-x64.zip" -or
        $manifest.nodeDistribution.url -ne $pins.node.url -or
        $manifest.nodeDistribution.sha256 -ne $pins.node.sha256) { throw 'Invalid or mismatched Windows package metadata.' }
    $registry = [uri]$manifest.dependencyRegistry
    if (-not $registry.IsAbsoluteUri -or $registry.Scheme -ne 'https' -or $registry.UserInfo -or
        $registry.Query -or $registry.Fragment -or -not $manifest.dependencyRegistry.EndsWith('/')) {
        throw 'Package npm registry must be a credential-free HTTPS URL.'
    }
    $origin = [uri]$setup.portalOrigin
    if ($origin.Scheme -ne 'https' -or $origin.UserInfo -or $origin.Query -or $origin.Fragment -or
        $origin.AbsolutePath -ne '/' -or $setup.portalOrigin -ne $origin.GetLeftPart([UriPartial]::Authority)) {
        throw 'Package portalOrigin must be an exact HTTPS origin.'
    }
    $artifactPath = Assert-CodeyPath (Join-Path $assets $artifact.file) $assets
    if (-not (Test-Path -LiteralPath $artifactPath -PathType Leaf) -or
        (Get-Item -LiteralPath $artifactPath).Length -ne $artifact.size) {
        throw 'Codey npm package is missing or has the wrong size.'
    }
    $expected = @($artifact.file, 'manifest.json', 'setup.json')
    $sums = @{}
    foreach ($line in Get-Content -LiteralPath (Join-Path $assets 'SHA256SUMS') -Encoding ASCII) {
        if ($line -notmatch '^([a-f0-9]{64})  ([a-zA-Z0-9.-]+)$' -or
            $Matches[2] -notin $expected -or $sums.ContainsKey($Matches[2])) { throw 'Invalid package checksum list.' }
        $sums[$Matches[2]] = $Matches[1]
    }
    if ($sums.Count -ne $expected.Count) { throw 'Unexpected Windows package payload set.' }
    foreach ($name in $expected) {
        $file = Assert-CodeyPath (Join-Path $assets $name) $assets
        if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $sums[$name]) { throw 'Package checksum mismatch.' }
    }
    if ($artifact.sha256 -ne $sums[$artifact.file]) { throw 'Codey npm package does not match the manifest.' }
    $models = Join-Path $Root 'templates\a100-models.json'
    $null = Read-CodeyJson $models
    return [pscustomobject]@{
        Manifest = $manifest; Setup = $setup; Pins = $pins; Assets = $assets
        Models = $models; Artifact = $artifactPath
    }
}

function Get-CodeyOpenSsl {
    param([string]$Explicit)
    $candidates = @()
    if ($Explicit) { $candidates += (Assert-CodeyPath $Explicit) }
    else {
        $command = Get-Command openssl.exe -CommandType Application -ErrorAction SilentlyContinue
        if ($command) { $candidates += $command.Source }
        $candidates += @((Join-Path $env:ProgramFiles 'Git\usr\bin\openssl.exe'),
            (Join-Path $env:ProgramFiles 'Git\mingw64\bin\openssl.exe'))
    }
    foreach ($file in $candidates) {
        if (Test-Path -LiteralPath $file -PathType Leaf) {
            $version = Invoke-CodeyProcess $file @('version') -TimeoutSeconds 10 -AllowFailure
            if ($version.ExitCode -eq 0 -and $version.Stdout -match '^OpenSSL 3\.') { return $file }
        }
    }
    throw 'OpenSSL 3 is required, as on Linux. Install Git for Windows or specify -OpenSslExe with its absolute path.'
}

function Get-CodeyListeners {
    @(Get-NetTCPConnection -State Listen -ErrorAction Stop |
        Where-Object { $_.LocalPort -in @(3001, 4141, 8443) } |
        Select-Object LocalAddress, LocalPort, OwningProcess)
}

function Get-CodeyForeignListeners {
    param($Listeners, $Processes, $Previous)
    foreach ($listener in $Listeners) {
        $process = @($Processes | Where-Object { $_.ProcessId -eq $listener.OwningProcess })
        $expectedEntry = if ($Previous) { Join-Path $Previous.codeyDirectory 'bin\codey.mjs' } else { '' }
        $expectedCommand = if ($listener.LocalPort -eq 3001) { 'workspace' } else { 'gateway' }
        if (-not $Previous -or $process.Count -ne 1 -or
            $process[0].ExecutablePath -ne $Previous.nodeExe -or
            -not $process[0].CommandLine.Contains($expectedEntry) -or
            $process[0].CommandLine -notmatch "(?:^|\s)$expectedCommand(?:\s|$)" -or
            $listener.LocalAddress -notin @('127.0.0.1', '::1')) { $listener }
    }
}

function Wait-CodeyPortsFree {
    param([int[]]$Ports)
    for ($i = 0; $i -lt 60; $i++) {
        if (-not @(Get-CodeyListeners | Where-Object { $_.LocalPort -in $Ports }).Count) { return }
        Start-Sleep -Milliseconds 500
    }
    throw 'Ports did not close after stopping owned tasks; no foreign listener will be killed.'
}

function Wait-CodeyProbe {
    param($Config, [string]$ConfigPath, [string]$Operation)
    for ($i = 0; $i -lt 30; $i++) {
        $result = Invoke-CodeyProcess $Config.nodeExe @($Config.helperPath, $Operation, $ConfigPath) `
            -WorkingDirectory $Config.releaseDirectory -TimeoutSeconds 40 -AllowFailure
        if ($result.ExitCode -eq 0) { return }
        Start-Sleep -Seconds 2
    }
    throw "Windows $Operation verification failed; installation is not marked ready."
}

function New-CodeyIdentity {
    param([string]$File, $Owner)
    if (Test-Path -LiteralPath $File) {
        $identity = Read-CodeyJson $File
        if ($identity.schema -ne 1 -or $identity.ownerSid -ne $Owner.Sid -or
            $identity.computer -cne $Owner.Computer -or
            $identity.nodeId -notmatch '^n-[a-f0-9]{24}$' -or
            $identity.workspaceSubject -notmatch '^m-[a-f0-9]{24}$' -or
            $identity.workspaceUsername -notmatch '^[a-z][a-z0-9_-]{0,31}$') { throw 'Existing identity requires review; it will not be replaced.' }
        foreach ($key in @('clientSigningKey', 'workspaceSsoKey', 'tunnelUpdateKey', 'updaterCredential')) {
            if ($identity.$key -notmatch '^[A-Za-z0-9_-]{43}$') { throw 'Invalid existing identity credential.' }
        }
        return $identity
    }
    $identity = [ordered]@{ schema = 1; ownerSid = $Owner.Sid; computer = $Owner.Computer
        nodeId = 'n-' + (New-CodeySecret -Bytes 12 -Hex)
        workspaceSubject = 'm-' + (New-CodeySecret -Bytes 12 -Hex)
        workspaceUsername = 'owner'
        clientSigningKey = New-CodeySecret; workspaceSsoKey = New-CodeySecret
        tunnelUpdateKey = New-CodeySecret; updaterCredential = New-CodeySecret }
    Write-CodeyJson $File $identity
    return [pscustomobject]$identity
}

function Get-CodeyCodexConfiguration {
    param([string]$ModelsFile)
    # JSON's quoted string escaping is compatible with a TOML basic string.
    $catalog = ConvertTo-Json -InputObject $ModelsFile -Compress
    return @"
model = "gpt-6-astra"
model_provider = "copilot_api"
model_reasoning_effort = "max"
model_reasoning_summary = "auto"
model_context_window = 872000
model_auto_compact_token_limit = 722000
model_catalog_json = $catalog
personality = "pragmatic"
approvals_reviewer = "user"
sandbox_mode = "danger-full-access"
approval_policy = "never"

[model_providers.copilot_api]
name = "OpenAI"
base_url = "http://127.0.0.1:4141"
env_key = "CODEY_MODEL_API_KEY"
requires_openai_auth = false
supports_websockets = false
wire_api = "responses"
request_max_retries = 3
stream_max_retries = 1
stream_idle_timeout_ms = 300000

[features]
remote_compaction_v2 = true
"@
}

function Set-CodeyUserModelKey {
    param([string]$Key)
    [Environment]::SetEnvironmentVariable('CODEY_MODEL_API_KEY', $Key, 'User')
}

function Add-CodeyPathEntry {
    param([string]$Value, [string]$Entry)
    if ($Entry.Contains(';')) { throw 'The Codey command directory cannot contain a PATH separator.' }
    foreach ($part in $Value.Split(';')) {
        $expanded = [Environment]::ExpandEnvironmentVariables($part.Trim().Trim('"')).TrimEnd('\', '/')
        if ($expanded.Equals($Entry.TrimEnd('\', '/'), [StringComparison]::OrdinalIgnoreCase)) { return $Value }
    }
    $result = if (-not $Value) { $Entry } elseif ($Value.EndsWith(';')) { $Value + $Entry } else { "$Value;$Entry" }
    if ($result.Length -ge 32767) { throw 'User PATH would exceed the Windows environment limit.' }
    return $result
}

function Get-CodeyUserPath {
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment')
    try {
        if (-not $key) { return '' }
        return [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    } finally { if ($key) { $key.Dispose() } }
}

function Set-CodeyUserPath {
    param([string]$Value, [string]$Expected)
    $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
    try {
        $current = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        if ($current -cne $Expected) { throw 'User PATH changed concurrently; retry command registration.' }
        $kind = if ($key.GetValueNames() -contains 'Path') { $key.GetValueKind('Path') }
            else { [Microsoft.Win32.RegistryValueKind]::ExpandString }
        if ($kind -notin @([Microsoft.Win32.RegistryValueKind]::String,
            [Microsoft.Win32.RegistryValueKind]::ExpandString)) { throw 'Unexpected user PATH registry value kind.' }
        $key.SetValue('Path', $Value, $kind)
    } finally { $key.Dispose() }
    # Let Explorer refresh the environment inherited by future terminal processes.
    if (-not ('CodeyPathNotification' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CodeyPathNotification {
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern IntPtr SendMessageTimeout(
        IntPtr window, uint message, UIntPtr wParam, string lParam,
        uint flags, uint timeout, out UIntPtr result);
}
'@
    }
    $result = [UIntPtr]::Zero
    $null = [CodeyPathNotification]::SendMessageTimeout(
        [IntPtr]0xffff, 0x001a, [UIntPtr]::Zero, 'Environment', 2, 3000, [ref]$result)
}

function Install-CodeyCommand {
    param($Config, [string]$ConfigPath)
    $directory = Assert-CodeyPath (Join-Path $Config.runtimeRoot 'bin') $Config.runtimeRoot
    $file = Assert-CodeyPath (Join-Path $directory 'codey.ps1') $directory
    $null = Assert-CodeyPath $ConfigPath $Config.configRoot
    # Keep the generated script ASCII: Windows PowerShell 5.1 reads BOM-less scripts as ANSI.
    $encodedConfig = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($ConfigPath))
    $content = (Get-Content -LiteralPath (Join-Path $PSScriptRoot 'windows-command.ps1') -Raw -Encoding UTF8).
        Replace('__CODEY_CONFIG_PATH_BASE64__', $encodedConfig)
    $exists = Test-Path -LiteralPath $file
    $current = if ($exists) { [string](Get-Content -LiteralPath $file -Raw -Encoding UTF8) } else { '' }
    if ($exists -and -not $current.StartsWith('# Codey managed command launcher v1')) {
        throw 'An unmanaged codey.ps1 occupies the command directory; it will not be overwritten.'
    }
    $userPath = Get-CodeyUserPath
    $newUserPath = Add-CodeyPathEntry $userPath $directory
    $newProcessPath = Add-CodeyPathEntry $env:PATH $directory
    if (-not (Test-Path -LiteralPath $directory)) { New-CodeyDirectory $directory }
    if ($current -cne $content) { Write-CodeyFile $file $content }
    if ($newUserPath -cne $userPath) { Set-CodeyUserPath $newUserPath $userPath }
    $env:PATH = $newProcessPath
}

function Assert-CodeyInstalledPackage {
    param([string]$codey, $package, [string]$node)
    $codeyBin = Join-Path $codey 'bin\codey.mjs'
    foreach ($entry in @(
        'package.json', 'npm-shrinkwrap.json', 'bin\codey.mjs', 'codey-build.json',
        'dist-server\server\index.js', 'gateway\main.js', 'updater\install.py'
    )) {
        if (-not (Test-Path -LiteralPath (Join-Path $codey $entry) -PathType Leaf)) {
            throw "Installed Codey npm package is incomplete: $entry"
        }
    }
    $installedPackage = Read-CodeyJson (Join-Path $codey 'package.json')
    $installedBuild = Read-CodeyJson (Join-Path $codey 'codey-build.json')
    $buildHash = (Get-FileHash -LiteralPath (Join-Path $codey 'codey-build.json') -Algorithm SHA256).Hash
    $lockHash = (Get-FileHash -LiteralPath (Join-Path $codey 'npm-shrinkwrap.json') -Algorithm SHA256).Hash
    if ($installedPackage.name -ne 'codey' -or
        $installedPackage.version -ne $package.Manifest.codey.version -or
        $installedBuild.name -ne 'codey' -or $installedBuild.version -ne $installedPackage.version -or
        $installedBuild.platform -ne 'windows-x64' -or
        $buildHash -ne $package.Manifest.codey.entrySha256 -or
        $lockHash -ne $package.Manifest.codey.lockSha256) {
        throw 'Installed Codey identity, platform or dependency lock does not match the package manifest.'
    }
    foreach ($forbidden in @(
        'node_modules\@cloudcli-ai\cloudcli', 'node_modules\@jeffreycao\copilot-api',
        'node_modules\@openai\codex', 'node_modules\@openai\codex-sdk'
    )) {
        if (Test-Path -LiteralPath (Join-Path $codey $forbidden)) {
            throw 'Codey npm installation contains a forbidden nested application/runtime.'
        }
    }
    $nativeProbe = "require('better-sqlite3')(':memory:').close();" +
        "const p=require('node-pty').spawn(process.env.COMSPEC,['/d','/c','exit 0'],{env:process.env});" +
        "p.onExit(e=>process.exit(e.exitCode));setTimeout(()=>process.exit(1),10000).unref();"
    $null = Invoke-CodeyProcess $node @('-e', $nativeProbe) -WorkingDirectory $codey -TimeoutSeconds 30
    $installedVersion = (Invoke-CodeyProcess $node @($codeyBin, '--version') `
        -WorkingDirectory $codey -TimeoutSeconds 20).Stdout.Trim()
    if ($installedVersion -ne "codey $($package.Manifest.codey.version)") {
        throw 'Installed Codey CLI version mismatch.'
    }
}

function Repair-CodeyWindowsServices {
    param($Previous, [string]$ConfigPath, $Package, $Owner)
    if (-not $Previous -or (-not $Previous.ready -and
        -not ($Previous.PSObject.Properties['repairPending'] -and $Previous.repairPending))) {
        throw 'Service repair requires an existing successful installation (or an interrupted service repair).'
    }
    $tasks = Get-CodeyTaskFolder
    foreach ($component in @('codey', 'tunnel', 'renew')) {
        Assert-CodeyTask ($tasks.Folder.GetTask("Codey Machine $($Previous.nodeId) $component")) `
            $Previous $ConfigPath $component
    }
    $mutex = [Threading.Mutex]::new($false, ('Local\CodeyWindowsInstall-' + $Owner.Sid))
    $held = $false
    $stopped = $false
    try {
        try { $held = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $held = $true }
        if (-not $held) { throw 'Another installer is running for this owner.' }
        $originalHash = (Get-FileHash -LiteralPath $ConfigPath).Hash
        $stage = Assert-CodeyPath (Join-Path $Previous.runtimeRoot (
            'service-repairs\' + [Guid]::NewGuid().ToString('N'))) $Previous.runtimeRoot
        New-CodeyDirectory $stage
        $node = Assert-CodeyPath $Previous.nodeExe $Previous.runtimeRoot
        if ((Invoke-CodeyProcess $node @('--version')).Stdout.Trim() -ne "v$($Package.Pins.node.version)") {
            throw 'Repair cannot replace Node; use a reviewed full upgrade for a different Node version.'
        }
        $npm = Join-Path (Split-Path -Parent $node) 'node_modules\npm\bin\npm-cli.js'
        $prefix = Join-Path $stage 'app'
        Write-Host '[repair 1/3] Stage and verify the fixed npm package; current services remain running'
        $null = Invoke-CodeyProcess $node @($npm, 'install', '--global', '--prefix', $prefix, '--omit=dev',
            '--no-audit', '--no-fund', '--registry', $Package.Manifest.dependencyRegistry, $Package.Artifact) `
            -Environment @{ npm_config_registry = $Package.Manifest.dependencyRegistry
                npm_config_cache = Join-Path $Previous.runtimeRoot 'downloads\npm'
                PATH = (Split-Path -Parent $node) + ';' + $env:PATH
                NODE_USE_SYSTEM_CA = '1'; ELECTRON_SKIP_BINARY_DOWNLOAD = '1'; CI = 'true' } `
            -WorkingDirectory $stage -TimeoutSeconds 1200
        $codey = Join-Path $prefix 'node_modules\codey'
        Assert-CodeyInstalledPackage $codey $Package $node
        $supervisor = Join-Path $stage 'supervisor'
        New-CodeyDirectory $supervisor
        $hashes = @{}
        foreach ($name in @('windows-common.ps1','windows-process.cs','windows-service.ps1','windows-runtime.mjs')) {
            $target = Join-Path $supervisor $name
            Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination $target
            Protect-CodeyPath $target
            $hashes[$name] = (Get-FileHash -LiteralPath $target).Hash
        }
        $hostExe = Install-CodeyTaskHost $supervisor
        $hashes['codey-task-host.exe'] = (Get-FileHash -LiteralPath $hostExe).Hash
        $config = $Previous | ConvertTo-Json -Depth 20 | ConvertFrom-Json
        $config.runnerPath = Join-Path $supervisor 'windows-service.ps1'
        $config.helperPath = Join-Path $supervisor 'windows-runtime.mjs'
        $config.helperHashes = [pscustomobject]$hashes
        $config | Add-Member NoteProperty taskHostExe $hostExe -Force
        $config | Add-Member NoteProperty repairPending $true -Force
        $config.codeyDirectory = $codey
        $config.codeyBin = Join-Path $codey 'bin\codey.mjs'
        $config.releaseId = $Package.Manifest.releaseId
        $config.npmPackage = [IO.Path]::GetFileName($Package.Artifact)
        $config.npmPackageSha256 = $Package.Manifest.artifacts[0].sha256
        $config.dependencyRegistry = $Package.Manifest.dependencyRegistry
        $config.services.codey.arguments[0] = $config.codeyBin
        $config.services.codey.workingDirectory = $codey
        $config.services.codey.environment | Add-Member NoteProperty PATH `
            ((Split-Path -Parent $node) + ';' + $env:PATH) -Force
        $config.services.renew.arguments[0] = $config.helperPath
        foreach ($name in @('COPILOT_API_GITHUB_TOKEN','COPILOT_API_OAUTH_APP','COPILOT_API_ENTERPRISE_URL')) {
            if (-not $config.services.codey.environment.PSObject.Properties[$name]) {
                $config.services.codey.environment | Add-Member NoteProperty $name ''
            }
        }
        if ((Get-FileHash -LiteralPath $ConfigPath).Hash -ne $originalHash) {
            throw 'Runtime changed during staging; no service was stopped.'
        }
        Write-Host '[repair 2/3] Switch only this node''s three tasks; preserve all identities, credentials and Codex configuration'
        Set-CodeyTaskState $Previous $ConfigPath @('codey','tunnel','renew')
        $stopped = $true
        Wait-CodeyPortsFree @(3001,4141,8443)
        $config.ready = $false
        # Validate/replace the exact old action set, not any similarly named task.
        Install-CodeyTasks $config $ConfigPath -PreviousConfig $Previous
        Write-CodeyJson $ConfigPath $config -Backup
        Set-CodeyTaskState $config $ConfigPath @('codey','tunnel','renew') -Start
        Write-Host '[repair 3/3] Verify gateway, Workspace, TLS/SSO and running watchdogs'
        Wait-CodeyProbe $config $ConfigPath 'verify'
        Assert-CodeyTasksRunning $config $ConfigPath
        $config.ready = $true
        $config.repairPending = $false
        Write-CodeyJson $ConfigPath $config
        Install-CodeyCommand $config $ConfigPath
        Write-Output 'WINDOWS_SERVICES_REPAIRED_CREDENTIALS_PRESERVED'
    } catch {
        if ($stopped) {
            # Keep diagnostics and both staged/old runtimes. Never clear tokens,
            # rotate keys, or attempt device login on behalf of a background task.
            Write-Warning 'Repair interrupted. Inspect private logs and runtime.json before retrying; no credentials were cleared.'
        }
        throw
    } finally {
        if ($held) { $mutex.ReleaseMutex() }
        $mutex.Dispose()
    }
}

function Invoke-CodeyWindowsInstall {
    param([bool]$DoApply, [bool]$ApprovedNetwork, [bool]$Replace, [string]$ExpectedComputer,
        [string]$RequestedCodexHome, [string]$RequestedOpenSsl, [bool]$Repair = $false)
    $owner = Get-CodeyOwner
    if ($DoApply -and (-not $ApprovedNetwork -or $ExpectedComputer -cne $owner.Computer)) {
        throw 'Apply requires -NetworkApproved and -ExpectedComputerName matching this computer exactly.'
    }
    $packageRoot = Split-Path -Parent $PSScriptRoot
    $package = Read-CodeyWindowsPackage $packageRoot
    if ($Repair -and $Replace) { throw 'Choose -RepairServices or -ReplaceExisting, not both.' }
    $runtimeRoot = Assert-CodeyPath (Join-Path $owner.Home '.local\share\codey-machine-windows') $owner.Home
    $configRoot = Assert-CodeyPath (Join-Path $owner.Home '.config\codey-machine-windows') $owner.Home
    $stateRoot = Join-Path $runtimeRoot 'state'
    $configPath = Join-Path $configRoot 'runtime.json'
    if (-not $RequestedCodexHome) { $RequestedCodexHome = $env:CODEX_HOME }
    if (-not $RequestedCodexHome) { $RequestedCodexHome = Join-Path $owner.Home '.codex' }
    $codexRoot = Assert-CodeyPath $RequestedCodexHome
    $previous = $null
    if (Test-Path -LiteralPath $configPath) {
        $previous = Read-CodeyJson $configPath
        if ($previous.kind -ne 'codey-windows-oneclick' -or $previous.schema -ne 2 -or
            $previous.layout -ne 'npm-codey-package' -or
            $previous.ownerSid -ne $owner.Sid -or $previous.ownerHome -ne $owner.Home -or
            $previous.computer -cne $owner.Computer -or
            $previous.runtimeRoot -ne $runtimeRoot -or $previous.configRoot -ne $configRoot) {
            throw 'This directory belongs to another/legacy installation; it will not be taken over.'
        }
    } elseif (Test-Path -LiteralPath $configRoot) {
        if (@(Get-ChildItem -LiteralPath $configRoot -Force).Count) {
            throw 'Nonempty configuration directory has no recognized runtime; manual recovery is required.'
        }
    }
    $processes = @(Get-CodeyProcesses $owner.Sid)
    $listeners = @(Get-CodeyListeners)
    $foreign = @(Get-CodeyForeignListeners $listeners $processes $previous)
    $codexProcesses = @($processes | Where-Object { $_.Name -ieq 'codex.exe' })
    $unknownCodex = @($codexProcesses | Where-Object {
        -not $previous -or -not $_.ExecutablePath.StartsWith(
            ($previous.codexStandaloneRoot.TrimEnd('\') + '\'), [StringComparison]::OrdinalIgnoreCase)
    })
    $overwrites = @((Join-Path $codexRoot 'config.toml'), (Join-Path $codexRoot 'models.json')) |
        Where-Object { Test-Path -LiteralPath $_ }
    $plan = [ordered]@{
        platform = 'windows-x64'; computer = $owner.Computer; owner = $owner.Name
        releaseId = $package.Manifest.releaseId; runtimeRoot = $runtimeRoot; configRoot = $configRoot
        npmPackage = [IO.Path]::GetFileName($package.Artifact)
        npmRegistry = $package.Manifest.dependencyRegistry
        codexHome = $codexRoot; replaceConfiguration = @($overwrites)
        listeners = $listeners; blockingForeignListeners = $foreign
        ownerCodexProcesses = @($codexProcesses | Select-Object ProcessId, ExecutablePath)
        requiresClosingUnmanagedCodex = ($unknownCodex.Count -gt 0)
        requiresReplaceExisting = ([bool]$previous -or @($overwrites).Count -gt 0)
        network = 'Private GitHub DevTunnel; HTTPS 3001/8443 only; loopback listeners; no firewall/routes'
        commandPath = Join-Path $runtimeRoot 'bin\codey.ps1'
        userEnvironmentChanges = @('Codey stable bin added to user PATH',
            'Official Codex installer adds its bin to user PATH', 'CODEY_MODEL_API_KEY')
        startup = 'Original owner logon only; hidden restart watchdogs; not unattended Windows boot'
        updater = 'unsupported_platform: package contains updater source but Windows does not install it'
        mode = $(if ($DoApply) { 'apply' } else { 'plan' })
        repairServices = $Repair
    }
    if ($Repair) {
        if ($previous) { $plan.codexHome = $previous.codexHome }
        $plan.replaceConfiguration = @()
        $plan.userEnvironmentChanges = @('Codey stable bin added to user PATH')
        $plan.requiresClosingUnmanagedCodex = $false
        $plan.requiresReplaceExisting = $false
        $plan.operation = 'Stage npm package, then restart only this node; preserve credentials, TLS, registration and Codex'
    }
    if (-not $DoApply) { $plan | ConvertTo-Json -Depth 12; return }
    Assert-CodeyExternalTerminal $processes
    if ($foreign.Count) { throw 'Ports are owned by another service. No service, key, file or firewall rule was changed.' }
    if ($Repair) {
        Repair-CodeyWindowsServices $previous $configPath $package $owner
        return
    }
    if ($previous -and $previous.ready -and -not $Replace) {
        if ($previous.releaseId -ne $package.Manifest.releaseId -or $previous.codexHome -ne $codexRoot) {
            throw 'An installed node differs from this plan. Replacement must be explicitly approved.'
        }
        Wait-CodeyProbe $previous $configPath 'verify'
        Assert-CodeyTasksRunning $previous $configPath
        Install-CodeyCommand $previous $configPath
        Write-Output 'WINDOWS_ALREADY_INSTALLED_VERIFIED_NO_RESTART'
        Write-Output 'Codey command/PATH registered. Reopen the terminal app if its environment is cached.'
        return
    }
    if ($unknownCodex.Count) { throw 'Close unmanaged Codex/Desktop processes from an external terminal first; they will not be killed automatically.' }
    if (($previous -or @($overwrites).Count -gt 0) -and -not $Replace) {
        throw 'Replacing this installation or existing Codex configuration requires -ReplaceExisting.'
    }
    $openssl = Get-CodeyOpenSsl $RequestedOpenSsl
    $drive = [IO.DriveInfo]::new([IO.Path]::GetPathRoot($runtimeRoot))
    if ($drive.AvailableFreeSpace -lt 8GB) { throw 'At least 8 GiB of free space is required.' }
    if ($previous) {
        $taskService = Get-CodeyTaskFolder
        foreach ($component in @('codey', 'tunnel', 'renew')) {
            Assert-CodeyTask ($taskService.Folder.GetTask("Codey Machine $($previous.nodeId) $component")) `
                $previous $configPath $component
        }
    }
    # The mutex is not created until all read-only checks/explicit approvals pass.
    $mutex = [Threading.Mutex]::new($false, ('Local\CodeyWindowsInstall-' + $owner.Sid))
    $held = $false
    $registered = $false
    $config = $null
    try {
        try { $held = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $held = $true }
        if (-not $held) { throw 'Another installer is running for this owner.' }
        foreach ($directory in @($runtimeRoot, $configRoot, $stateRoot, (Join-Path $runtimeRoot 'releases'))) {
            New-CodeyDirectory $directory
        }
        $identityFile = Join-Path $stateRoot 'identity.json'
        $identity = New-CodeyIdentity $identityFile $owner
        if ($previous -and $previous.nodeId -ne $identity.nodeId) { throw 'Runtime and local identity disagree.' }
        $release = Assert-CodeyPath (Join-Path $runtimeRoot (
            'releases\' + $package.Manifest.releaseId + '-' + [Guid]::NewGuid().ToString('N'))) $runtimeRoot
        New-CodeyDirectory $release
        $cache = Join-Path $runtimeRoot 'downloads'
        New-CodeyDirectory $cache
        $nodeZip = Join-Path $cache "node-$($package.Pins.node.version)-win-x64.zip"
        if (-not (Test-Path -LiteralPath $nodeZip) -or
            (Get-FileHash -LiteralPath $nodeZip -Algorithm SHA256).Hash -ne $package.Pins.node.sha256) {
            Get-CodeyDownload $package.Pins.node.url $nodeZip $package.Pins.node.sha256
        }
        Expand-CodeyZip $nodeZip (Join-Path $release 'node')
        $node = Join-Path $release "node\node-v$($package.Pins.node.version)-win-x64\node.exe"
        if ((Invoke-CodeyProcess $node @('--version') -TimeoutSeconds 10).Stdout.Trim() -ne "v$($package.Pins.node.version)") {
            throw 'Native Windows Node verification failed.'
        }
        $nodeRoot = Split-Path -Parent $node
        $npmCli = Join-Path $nodeRoot 'node_modules\npm\bin\npm-cli.js'
        if (-not (Test-Path -LiteralPath $npmCli -PathType Leaf)) { throw 'Official Node npm CLI is missing.' }
        $appPrefix = Join-Path $release 'app'
        New-CodeyDirectory $appPrefix
        $npmEnvironment = @{
            PATH = $nodeRoot + ';' + $env:PATH
            npm_config_registry = $package.Manifest.dependencyRegistry
            npm_config_cache = Join-Path $cache 'npm'
            npm_config_audit = 'false'; npm_config_fund = 'false'
            NODE_USE_SYSTEM_CA = '1'; ELECTRON_SKIP_BINARY_DOWNLOAD = '1'; CI = 'true'
        }
        Write-Host '[prepare] Install the single local Codey tgz with npm'
        $null = Invoke-CodeyProcess $node @(
            $npmCli, 'install', '--global', '--prefix', $appPrefix, '--omit=dev',
            '--no-audit', '--no-fund', '--registry', $package.Manifest.dependencyRegistry,
            $package.Artifact
        ) -Environment $npmEnvironment -WorkingDirectory $release -TimeoutSeconds 1200
        $codey = Join-Path $appPrefix 'node_modules\codey'
        $codeyBin = Join-Path $codey 'bin\codey.mjs'
        Assert-CodeyInstalledPackage $codey $package $node

        Write-Host '[1/5] Install/configure private GitHub DevTunnel'
        $devtunnel = Join-Path $release 'devtunnel.exe'
        Get-CodeyDownload $package.Pins.devTunnel.url $devtunnel $package.Pins.devTunnel.sha256
        $signature = Get-AuthenticodeSignature -LiteralPath $devtunnel
        if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation') {
            throw 'DevTunnel Authenticode verification failed.'
        }
        $login = Invoke-CodeyProcess $devtunnel @('user', 'show', '--json') -TimeoutSeconds 30 -AllowFailure
        $user = if ($login.ExitCode -eq 0) { $login.Stdout | ConvertFrom-Json } else { $null }
        if ($user -and $user.status -eq 'Logged in' -and $user.provider -ne 'github') {
            throw 'Existing DevTunnel login is not GitHub; the installer will not log out or switch accounts.'
        }
        if (-not $user -or $user.status -ne 'Logged in') {
            $null = Invoke-CodeyProcess $devtunnel @('user', 'login', '--github', '--use-device-code-auth') `
                -Interactive -TimeoutSeconds 900
            $user = (Invoke-CodeyProcess $devtunnel @('user', 'show', '--json')).Stdout | ConvertFrom-Json
        }
        if ($user.status -ne 'Logged in' -or $user.provider -ne 'github') { throw 'GitHub DevTunnel login was not verified.' }
        if ($previous) {
            # A failed replacement must not leave an old "ready" flag behind
            # while one of its watchdogs has already been stopped.
            $previous.ready = $false
            Write-CodeyJson $configPath $previous -Backup
            Set-CodeyTaskState $previous $configPath @('tunnel', 'renew')
        }
        $tunnelId = "codey-$($identity.nodeId)"
        $shown = Invoke-CodeyProcess $devtunnel @('show', $tunnelId, '--json') -AllowFailure
        if ($shown.ExitCode -ne 0) {
            $shown = Invoke-CodeyProcess $devtunnel @('create', $tunnelId, '--description', "Codey Windows $($identity.nodeId)", '--json')
        }
        $raw = $shown.Stdout | ConvertFrom-Json
        $tunnel = if ($raw.PSObject.Properties['tunnel']) { $raw.tunnel } else { $raw }
        $idParts = $tunnel.tunnelId.Split('.')
        $cluster = if ($idParts.Count -eq 2) { $idParts[1] } else { $tunnel.clusterId }
        if ($idParts[0] -ne $tunnelId -or $idParts.Count -gt 2 -or $cluster -notmatch '^[a-z][a-z0-9]{1,15}$') {
            throw 'Unexpected DevTunnel coordinates.'
        }
        $qualified = "$tunnelId.$cluster"
        $tunnelPorts = if ($tunnel.PSObject.Properties['ports']) { @($tunnel.ports) } else { @() }
        foreach ($port in @(3001, 8443)) {
            if (-not @($tunnelPorts | Where-Object { $_.portNumber -eq $port -and $_.protocol -eq 'https' }).Count) {
                $null = Invoke-CodeyProcess $devtunnel @('port', 'create', $qualified, '--port-number', "$port", '--protocol', 'https', '--json')
            }
        }
        $tunnelFile = Join-Path $configRoot 'tunnel.json'
        Write-CodeyFile $tunnelFile (Invoke-CodeyProcess $devtunnel @('show', $qualified, '--json')).Stdout
        $null = Invoke-CodeyProcess $node @((Join-Path $PSScriptRoot 'windows-runtime.mjs'),
            'check-tunnel', $tunnelFile, $tunnelId)
        $cert = Join-Path $configRoot 'node-cert.pem'
        $key = Join-Path $configRoot 'node-key.pem'
        $serverName = "$($identity.nodeId).nodes.codey.internal"

        Write-Host '[2/5] Stop owned Codey/Codex, rotate the model key and start the unified package'
        if ($previous) {
            Set-CodeyTaskState $previous $configPath @('codey')
            Wait-CodeyPortsFree @(3001, 4141, 8443)
        }
        # Re-enumerate after stopping the watchdog, including on a first install:
        # an owner may have started another Codex since the read-only preflight.
        foreach ($process in @(Get-CodeyProcesses $owner.Sid | Where-Object { $_.Name -ieq 'codex.exe' })) {
            if (-not $previous -or -not $process.ExecutablePath.StartsWith(
                ($previous.codexStandaloneRoot.TrimEnd('\') + '\'), [StringComparison]::OrdinalIgnoreCase)) {
                throw 'A new unmanaged Codex process appeared; nothing will rotate its model key.'
            }
            Stop-CodeyProcessSnapshot $process $owner.Sid
        }
        if (@(Get-CodeyProcesses $owner.Sid | Where-Object { $_.Name -ieq 'codex.exe' }).Count) {
            throw 'Old Codex processes remain; stop them before key rotation.'
        }
        Wait-CodeyPortsFree @(3001, 4141, 8443)
        # No global gateway/home is taken over. Credentials belong to this install.
        $copilotHome = Join-Path $runtimeRoot 'copilot-home'
        $dataRoot = Join-Path $runtimeRoot 'data'
        New-CodeyDirectory $copilotHome
        New-CodeyDirectory $dataRoot
        $modelKey = New-CodeySecret
        Write-CodeyJson (Join-Path $copilotHome 'config.json') @{
            auth = @{ apiKeys = @($modelKey); adminApiKey = New-CodeySecret; sessionHistoryApiKey = New-CodeySecret }
        } -Backup
        Write-CodeyFile (Join-Path $configRoot 'provider.env') "CODEY_MODEL_API_KEY=$modelKey`n" -Backup
        $null = Invoke-CodeyProcess $openssl @('req', '-x509', '-newkey', 'rsa:3072', '-noenc', '-days', '365',
            '-keyout', $key, '-out', $cert, '-subj', "/CN=$serverName", '-addext', "subjectAltName=DNS:$serverName",
            '-addext', 'basicConstraints=critical,CA:FALSE', '-addext', 'keyUsage=critical,digitalSignature,keyEncipherment',
            '-addext', 'extendedKeyUsage=serverAuth') -TimeoutSeconds 60
        Protect-CodeyPath $key
        Protect-CodeyPath $cert
        $signingFile = Join-Path $configRoot 'client-signing.key'
        Write-CodeyFile $signingFile "$($identity.clientSigningKey)`n"
        $supervisor = Join-Path $runtimeRoot 'supervisor'
        New-CodeyDirectory $supervisor
        $hashes = @{}
        foreach ($name in @('windows-common.ps1', 'windows-process.cs', 'windows-service.ps1', 'windows-runtime.mjs')) {
            $destination = Join-Path $supervisor $name
            Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination $destination -Force
            Protect-CodeyPath $destination
            $hashes[$name] = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash
        }
        $taskHost = Install-CodeyTaskHost $supervisor
        $hashes['codey-task-host.exe'] = (Get-FileHash -LiteralPath $taskHost -Algorithm SHA256).Hash
        $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
        $codexBin = Join-Path $runtimeRoot 'codex-bin'
        $config = [ordered]@{
            schema = 2; kind = 'codey-windows-oneclick'; layout = 'npm-codey-package'; ready = $false
            ownerSid = $owner.Sid; ownerHome = $owner.Home; computer = $owner.Computer; nodeId = $identity.nodeId
            runtimeRoot = $runtimeRoot; configRoot = $configRoot; stateRoot = $stateRoot
            releaseId = $package.Manifest.releaseId; releaseDirectory = $release
            nodeExe = $node; devtunnelExe = $devtunnel; powershellExe = $powershell
            runnerPath = Join-Path $supervisor 'windows-service.ps1'
            taskHostExe = $taskHost
            helperPath = Join-Path $supervisor 'windows-runtime.mjs'; helperHashes = $hashes
            codexHome = $codexRoot; codexExe = Join-Path $codexBin 'codex.exe'
            codexStandaloneRoot = Join-Path $codexRoot 'packages\standalone'
            codeyDirectory = $codey; codeyBin = $codeyBin; modelKey = $modelKey
            npmPackage = [IO.Path]::GetFileName($package.Artifact)
            npmPackageSha256 = $package.Manifest.artifacts[0].sha256
            dependencyRegistry = $package.Manifest.dependencyRegistry
            identityFile = $identityFile; tunnelFile = $tunnelFile; certificate = $cert; serverName = $serverName
            portalOrigin = $package.Setup.portalOrigin; setupFile = Join-Path $configRoot 'setup.json'
            registrationStaging = Join-Path $configRoot 'registration.private.json'
            updater = 'unsupported_platform'; logonOnly = $true; services = @{}
        }
        $baseEnv = @{ HOME = $owner.Home; USERPROFILE = $owner.Home; NODE_ENV = 'production'; NODE_USE_SYSTEM_CA = '1'
            PATH = $nodeRoot + ';' + $env:PATH }
        $codeyEnv = $baseEnv.Clone()
        $codeyEnv.CODEY_MANAGED = 'true'; $codeyEnv.CODEY_PORTAL_SSO = 'true'
        $codeyEnv.COPILOT_API_HOME = $copilotHome; $codeyEnv.CODEX_HOME = $codexRoot
        # Pin the credential namespace for BOTH interactive auth and scheduled
        # starts. An unrelated shell/User environment must not override the file.
        $codeyEnv.COPILOT_API_GITHUB_TOKEN = ''
        $codeyEnv.COPILOT_API_OAUTH_APP = ''
        $codeyEnv.COPILOT_API_ENTERPRISE_URL = ''
        $codeyEnv.COPILOT_API_CODEY_HTTPS_PORT = '8443'; $codeyEnv.COPILOT_API_CODEY_HTTPS_HOST = '127.0.0.1'
        $codeyEnv.COPILOT_API_CODEY_TLS_CERT = $cert; $codeyEnv.COPILOT_API_CODEY_TLS_KEY = $key
        $codeyEnv.COPILOT_API_CODEY_NODE_ID = $identity.nodeId
        $codeyEnv.COPILOT_API_CODEY_ALLOWED_ORIGIN = $package.Setup.portalOrigin
        $codeyEnv.COPILOT_API_CODEY_SIGNING_KEY_FILE = $signingFile
        $codeyEnv.DATABASE_PATH = Join-Path $dataRoot 'auth.db'
        $codeyEnv.CODEY_PORTAL_NODE_ID = $identity.nodeId; $codeyEnv.CODEY_PORTAL_USERNAME = $identity.workspaceUsername
        $codeyEnv.CODEY_PORTAL_PRINCIPAL_ID = $identity.workspaceSubject; $codeyEnv.CODEY_PORTAL_SSO_KEY = $identity.workspaceSsoKey
        $codeyEnv.CODEY_PORTAL_TLS_CERT = $cert; $codeyEnv.CODEY_PORTAL_TLS_KEY = $key
        $codeyEnv.CODEY_CODEX_EXECUTABLE = $config.codexExe; $codeyEnv.CODEY_MODEL_API_KEY = $modelKey
        $config.services = @{
            codey = @{ executable = $node; arguments = @($codeyBin, 'start', '--host', '127.0.0.1',
                '--workspace-port', '3001', '--gateway-port', '4141')
                workingDirectory = $codey; environment = $codeyEnv }
            tunnel = @{ executable = $devtunnel; arguments = @('host', $qualified, '--host-header', 'unchanged',
                '--origin-header', 'unchanged'); workingDirectory = $release; environment = $baseEnv }
            renew = @{ executable = $node; arguments = @($config.helperPath, 'renew', $configPath)
                workingDirectory = $release; environment = $baseEnv }
        }
        Write-CodeyJson $config.setupFile $package.Setup
        Write-CodeyJson $configPath $config -Backup
        $null = Invoke-CodeyProcess $node @($config.helperPath, 'tunnel', $configPath)
        $githubTokenFile = Join-Path $copilotHome 'github_token'
        if (-not (Test-Path -LiteralPath $githubTokenFile) -or (Get-Item -LiteralPath $githubTokenFile).Length -eq 0) {
            $null = Invoke-CodeyProcess $node @($codeyBin, 'auth', 'login', '--provider', 'copilot') `
                -Environment $codeyEnv -WorkingDirectory $codey -Interactive -TimeoutSeconds 900
        }
        Install-CodeyTasks ([pscustomobject]$config) $configPath -PreviousConfig $previous
        $registered = $true
        Set-CodeyTaskState ([pscustomobject]$config) $configPath @('codey') -Start
        Wait-CodeyProbe ([pscustomobject]$config) $configPath 'gateway'

        Write-Host '[3/5] Install latest official native Codex, configure and verify a real response'
        $installer = Join-Path $cache 'codex-install.ps1'
        Get-CodeyDownload $package.Pins.codex.url $installer ''
        if ((Get-Content -LiteralPath $installer -Raw) -notmatch 'https://releases\.openai\.com/codex') {
            throw 'Unexpected official Codex installer.'
        }
        $codexEnvironment = @{
            CODEX_HOME = $codexRoot; CODEX_INSTALL_DIR = $codexBin; CODEX_NON_INTERACTIVE = 'true'
            CODEX_RELEASE = 'latest'; CODEX_INSTALLER_USE_RELEASES_OPENAI_COM = 'true'
            CODEY_MODEL_API_KEY = $modelKey
        }
        # Official installer performs its own release digest verification and owns
        # its junctions/companions. Never overwrite a Desktop cache or npm shim.
        $null = Invoke-CodeyProcess $powershell @('-NoLogo', '-NoProfile', '-NonInteractive', '-File', $installer) `
            -Environment $codexEnvironment -TimeoutSeconds 900
        $version = (Invoke-CodeyProcess $config.codexExe @('--version') -TimeoutSeconds 20).Stdout.Trim()
        if ($version -notmatch '^codex-cli \S+') { throw 'Official native Codex did not report a version.' }
        if (-not (Test-Path -LiteralPath $codexRoot)) { New-CodeyDirectory $codexRoot }
        Write-CodeyFile (Join-Path $codexRoot 'models.json') (Get-Content -LiteralPath $package.Models -Raw -Encoding UTF8) -Backup
        Write-CodeyFile (Join-Path $codexRoot 'config.toml') `
            (Get-CodeyCodexConfiguration (Join-Path $codexRoot 'models.json')) -Backup
        $answerFile = Join-Path $stateRoot ('codex-answer-' + [Guid]::NewGuid().ToString('N') + '.txt')
        $null = Invoke-CodeyProcess $config.codexExe @('exec', '--skip-git-repo-check', '--output-last-message', $answerFile,
            'Reply with only CODEY_CODEX_OK. Do not use tools.') -Environment $codexEnvironment -TimeoutSeconds 300 `
            -WorkingDirectory $owner.Home
        if ((Get-Content -LiteralPath $answerFile -Raw -Encoding UTF8).Trim() -cne 'CODEY_CODEX_OK') {
            throw 'Real Codex response mismatch; a prompt echo is not accepted.'
        }

        Write-Host '[4/5] Verify the unified Codey gateway, Workspace, TLS, SSO and Codex SDK'
        Wait-CodeyProbe ([pscustomobject]$config) $configPath 'verify'
        $null = Invoke-CodeyProcess $node @($config.helperPath, 'sdk-probe', $configPath) `
            -Environment $codexEnvironment -WorkingDirectory $codey -TimeoutSeconds 300

        Write-CodeyJson (Join-Path $release 'release.json') $package.Manifest
        Write-CodeyJson (Join-Path $copilotHome 'portal-build.json') @{
            schema = 1; sourceCommit = $package.Manifest.copilotApi.commit; version = $package.Manifest.copilotApi.version
        }
        Write-Host '[5/5] Enable owner-logon watchdogs and export private registration'
        Set-CodeyTaskState ([pscustomobject]$config) $configPath @('tunnel', 'renew') -Start
        $null = Invoke-CodeyProcess $node @($config.helperPath, 'registration', $configPath) -TimeoutSeconds 120
        $output = Join-Path $owner.Home 'codey-machine-registration.json'
        Write-CodeyFile $output (Get-Content -LiteralPath $config.registrationStaging -Raw -Encoding UTF8) -Backup
        Remove-Item -LiteralPath $config.registrationStaging -Force
        Wait-CodeyProbe ([pscustomobject]$config) $configPath 'verify'
        Assert-CodeyTasksRunning ([pscustomobject]$config) $configPath
        Install-CodeyCommand ([pscustomobject]$config) $configPath
        Set-CodeyUserModelKey $modelKey
        $config.ready = $true
        Write-CodeyJson $configPath $config
        Write-Output "Codey Windows installed and locally verified. Registration: $output"
        Write-Output 'Registration contains private credentials: import only into your Codey Portal. Portal/tunnel acceptance remains a separate step.'
        Write-Output 'One local Codey npm package runs both services. Startup is after owner logon; the signed updater remains unsupported on Windows.'
        Write-Output 'Codey is on your user PATH: codey --version. Reopen the terminal app if its environment is cached.'
    } catch {
        if ($registered -and $config) {
            try { Set-CodeyTaskState ([pscustomobject]$config) $configPath @('codey', 'tunnel', 'renew') }
            catch { Write-Warning 'Could not stop every task owned by this attempt; inspect its private runtime state.' }
        }
        # Preserve identity, previous releases, backups and diagnostics for retry.
        # Never restore stale provider keys or start old Codex processes.
        throw
    } finally {
        if ($held) { $mutex.ReleaseMutex() }
        $mutex.Dispose()
    }
}

if ($MyInvocation.InvocationName -ne '.') {
    Invoke-CodeyWindowsInstall -DoApply $Apply -ApprovedNetwork $NetworkApproved -Replace $ReplaceExisting `
        -ExpectedComputer $ExpectedComputerName -RequestedCodexHome $CodexHome -RequestedOpenSsl $OpenSslExe `
        -Repair $RepairServices
}
