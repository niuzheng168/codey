#requires -Version 5.1

<#
.SYNOPSIS
Installs the ChatGPT Windows app and configures Codex to use a verified Copilot API build.

.DESCRIPTION
This script:
1. Installs the official ChatGPT Windows app from Microsoft Store.
2. Installs Node.js LTS when required.
3. Downloads or copies a Copilot API package and verifies its SHA-256.
4. Installs the package globally with npm.
5. Creates a protected local proxy configuration and Codex model catalog.
6. Runs the interactive GitHub Copilot login.
7. Registers the proxy to start for the current user at sign-in.
8. Starts the proxy and verifies its authenticated model endpoint.

Existing Codex or Copilot API configuration is never overwritten unless -Force
is supplied. Secrets are generated locally and are not printed.

.EXAMPLE
.\install-codex-workstation.ps1 `
  -CopilotApiPackage .\copilot-api-2.2.13-2026-08-22-zhn.tgzz `
  -CopilotApiSha256 35dc565170b440d4b1c8d86a15baafcb235bb16892af474db94e1da696d37d01

.EXAMPLE
.\install-codex-workstation.ps1 `
  -CopilotApiPackage https://contoso.example/packages/copilot-api.tgz `
  -CopilotApiSha256 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef `
  -ValidateOnly
#>

[CmdletBinding()]
param(
    [string]$CopilotApiPackage = '',

    [ValidatePattern('^(?:__PORTAL_PACKAGE_SHA256__|[0-9a-fA-F]{64})$')]
    [string]$CopilotApiSha256 = '__PORTAL_PACKAGE_SHA256__',

    [ValidateRange(1024, 65535)]
    [int]$Port = 4141,

    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$')]
    [string]$Model = 'gpt-6-astra',

    [ValidateSet('low', 'medium', 'high', 'xhigh', 'max')]
    [string]$ReasoningEffort = 'max',

    [switch]$Force,
    [switch]$SkipChatGPT,
    [switch]$SkipCopilotLogin,
    [switch]$SkipStartupRegistration,
    [switch]$SkipStart,
    [switch]$EnableOpenSsh,
    [string]$PortalSshPublicKey = '',
    [switch]$ValidateOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

if ($env:OS -ne 'Windows_NT') {
    throw 'This installer supports Windows only.'
}
if ($Model -ne 'gpt-6-astra') {
    throw (
        "The embedded catalog contains gpt-6-astra only. " +
        "Use -Model gpt-6-astra or edit the catalog in this script."
    )
}

function Write-Step {
    param([Parameter(Mandatory = $true)][string]$Message)
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Refresh-ProcessPath {
    $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $pathParts = @($machinePath, $userPath) |
        Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
    $env:Path = [string]::Join(';', $pathParts)
}

function Invoke-CheckedCommand {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )

    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$FilePath exited with code $LASTEXITCODE."
    }
}

function Write-Utf8NoBom {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Content
    )

    [IO.File]::WriteAllText(
        $Path,
        $Content,
        [Text.UTF8Encoding]::new($false)
    )
}

function New-RandomHex {
    param([ValidateRange(16, 128)][int]$ByteCount = 32)

    $bytes = [byte[]]::new($ByteCount)
    $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $generator.GetBytes($bytes)
    }
    finally {
        $generator.Dispose()
    }
    return -join ($bytes | ForEach-Object { $_.ToString('x2') })
}

function Protect-ConfigurationFile {
    param([Parameter(Mandatory = $true)][string]$Path)

    $currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $system = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
    $administrators =
        [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
    $acl = [Security.AccessControl.FileSecurity]::new()
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($identity in @($currentUser, $system, $administrators)) {
        $rule = [Security.AccessControl.FileSystemAccessRule]::new(
            $identity,
            [Security.AccessControl.FileSystemRights]::FullControl,
            [Security.AccessControl.AccessControlType]::Allow
        )
        [void]$acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $Path -AclObject $acl
}

function Backup-ConfigurationFile {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return $null
    }
    $timestamp = [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss')
    $backupPath = "$Path.before-codex-setup-$timestamp"
    Copy-Item -LiteralPath $Path -Destination $backupPath
    return $backupPath
}

function Assert-ConfigurationMayBeWritten {
    param([Parameter(Mandatory = $true)][string[]]$Paths)

    $existing = @($Paths | Where-Object {
        Test-Path -LiteralPath $_ -PathType Leaf
    })
    if ($existing.Count -gt 0 -and -not $Force) {
        throw (
            "Configuration already exists. Re-run with -Force to back up and " +
            "replace these files:`n" + ($existing -join "`n")
        )
    }
}

function Get-CopilotPackage {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Destination
    )

    $uri = $null
    if (
        [Uri]::TryCreate($Source, [UriKind]::Absolute, [ref]$uri) -and
        $uri.Scheme -match '^https?$'
    ) {
        if ($uri.Scheme -ne 'https') {
            throw 'CopilotApiPackage URLs must use HTTPS.'
        }
        Write-Step "Downloading Copilot API package from $($uri.Host)"
        Invoke-WebRequest -UseBasicParsing -Uri $uri -OutFile $Destination
        return
    }

    $sourcePath = (Resolve-Path -LiteralPath $Source).Path
    if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
        throw "Copilot API package was not found: $Source"
    }
    Copy-Item -LiteralPath $sourcePath -Destination $Destination
}

function Test-TcpPort {
    param(
        [Parameter(Mandatory = $true)][string]$HostName,
        [Parameter(Mandatory = $true)][int]$PortNumber,
        [ValidateRange(100, 10000)][int]$TimeoutMs = 500
    )

    $client = [Net.Sockets.TcpClient]::new()
    try {
        $pending = $client.ConnectAsync($HostName, $PortNumber)
        return $pending.Wait($TimeoutMs) -and $client.Connected
    }
    catch {
        return $false
    }
    finally {
        $client.Dispose()
    }
}

function Wait-ForProxy {
    param(
        [Parameter(Mandatory = $true)][int]$PortNumber,
        [ValidateRange(1, 300)][int]$TimeoutSeconds = 90
    )

    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        if (Test-TcpPort -HostName '127.0.0.1' -PortNumber $PortNumber) {
            return
        }
        Start-Sleep -Milliseconds 500
    }
    throw "Copilot API did not listen on port $PortNumber within $TimeoutSeconds seconds."
}

function Resolve-CommandPath {
    param([Parameter(Mandatory = $true)][string]$Name)

    $command = Get-Command $Name -ErrorAction SilentlyContinue
    if (-not $command) {
        throw "Required command was not found: $Name"
    }

    function Enable-PortalOpenSsh {
        param([string]$PublicKey)

        $identity = [Security.Principal.WindowsPrincipal]::new(
            [Security.Principal.WindowsIdentity]::GetCurrent()
        )
        if (-not $identity.IsInRole(
            [Security.Principal.WindowsBuiltInRole]::Administrator
        )) {
            throw '-EnableOpenSsh must run from an elevated PowerShell window.'
        }

        $capability = Get-WindowsCapability -Online |
            Where-Object Name -Like 'OpenSSH.Server*' |
            Select-Object -First 1
        if (-not $capability) {
            throw 'The Windows OpenSSH Server capability is unavailable.'
        }
        if ($capability.State -ne 'Installed') {
            Add-WindowsCapability -Online -Name $capability.Name | Out-Null
        }
        Set-Service -Name sshd -StartupType Automatic
        Start-Service -Name sshd

        if (-not (Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue)) {
            New-NetFirewallRule `
                -Name 'OpenSSH-Server-In-TCP' `
                -DisplayName 'OpenSSH Server (sshd)' `
                -Enabled True `
                -Direction Inbound `
                -Protocol TCP `
                -Action Allow `
                -LocalPort 22 | Out-Null
        }
        if (-not (Get-NetFirewallRule -Name 'Codex-Copilot-API-In-TCP' -ErrorAction SilentlyContinue)) {
            New-NetFirewallRule `
                -Name 'Codex-Copilot-API-In-TCP' `
                -DisplayName 'Codex Copilot API' `
                -Enabled True `
                -Direction Inbound `
                -Protocol TCP `
                -Action Allow `
                -LocalPort $Port | Out-Null
        }

        $normalizedKey = $PublicKey.Trim()
        if ($normalizedKey) {
            if ($normalizedKey -notmatch '^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp\d+)\s+[A-Za-z0-9+/=]+(?:\s+.*)?$') {
                throw 'PortalSshPublicKey is not a supported OpenSSH public key.'
            }
            $isAdministrator = $identity.IsInRole(
                [Security.Principal.WindowsBuiltInRole]::Administrator
            )
            $sshDirectory = if ($isAdministrator) {
                Join-Path $env:ProgramData 'ssh'
            }
            else {
                Join-Path $HOME '.ssh'
            }
            $authorizedKeys = if ($isAdministrator) {
                Join-Path $sshDirectory 'administrators_authorized_keys'
            }
            else {
                Join-Path $sshDirectory 'authorized_keys'
            }
            New-Item -ItemType Directory -Path $sshDirectory -Force | Out-Null
            $existingKeys = if (Test-Path -LiteralPath $authorizedKeys) {
                @(Get-Content -LiteralPath $authorizedKeys)
            }
            else {
                @()
            }
            if ($existingKeys -notcontains $normalizedKey) {
                Add-Content -LiteralPath $authorizedKeys -Value $normalizedKey -Encoding Ascii
            }
            if ($isAdministrator) {
                & icacls.exe $authorizedKeys /inheritance:r /grant:r '*S-1-5-18:F' '*S-1-5-32-544:F' | Out-Null
            }
            else {
                & icacls.exe $sshDirectory /inheritance:r /grant:r "$env:USERNAME:(OI)(CI)F" | Out-Null
                & icacls.exe $authorizedKeys /inheritance:r /grant:r "$env:USERNAME:F" | Out-Null
            }
        }
    }
    return $command.Source
}

$workRoot = Join-Path $env:TEMP (
    'codex-workstation-setup-' + [Guid]::NewGuid().ToString('N')
)
$packagePath = Join-Path $workRoot 'copilot-api.tgz'
$embeddedPackageBase64 = @'
__PORTAL_PACKAGE_BASE64__
'@
$codexHome = Join-Path $HOME '.codex'
$modelsPath = Join-Path $codexHome 'models.json'
$codexConfigPath = Join-Path $codexHome 'config.toml'
$copilotHome = Join-Path $HOME '.local\share\copilot-api'
$copilotConfigPath = Join-Path $copilotHome 'config.json'
$deploymentRoot = Join-Path $env:LOCALAPPDATA 'CodexWorkstation'
$launcherPath = Join-Path $deploymentRoot 'start-copilot-api.ps1'
$stdoutPath = Join-Path $deploymentRoot 'copilot-api.stdout.log'
$stderrPath = Join-Path $deploymentRoot 'copilot-api.stderr.log'
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$runValueName = 'CopilotApiForCodex'

New-Item -ItemType Directory -Path $workRoot -Force | Out-Null

try {
    if ([string]::IsNullOrWhiteSpace($CopilotApiPackage)) {
        if ($embeddedPackageBase64.Length -lt 100) {
            throw 'No embedded package is present. Pass -CopilotApiPackage explicitly.'
        }
        $embeddedPackagePath = Join-Path $workRoot '__PORTAL_PACKAGE_FILE__'
        [IO.File]::WriteAllBytes(
            $embeddedPackagePath,
            [Convert]::FromBase64String($embeddedPackageBase64)
        )
        $CopilotApiPackage = $embeddedPackagePath
    }
    Get-CopilotPackage -Source $CopilotApiPackage -Destination $packagePath
    $actualHash = (
        Get-FileHash -LiteralPath $packagePath -Algorithm SHA256
    ).Hash.ToLowerInvariant()
    if ($actualHash -ne $CopilotApiSha256.ToLowerInvariant()) {
        throw (
            "Copilot API SHA-256 mismatch. Expected " +
            "$($CopilotApiSha256.ToLowerInvariant()), found $actualHash."
        )
    }
    Write-Step 'Copilot API package SHA-256 verified'

    $tarCommand = Get-Command tar.exe -ErrorAction SilentlyContinue
    if ($tarCommand) {
        $entries = & $tarCommand.Source -tf $packagePath
        if ($LASTEXITCODE -ne 0 -or $entries -notcontains 'package/package.json') {
            throw 'The Copilot API package is not a valid npm archive.'
        }
        $packageManifestText = (
            & $tarCommand.Source -xOf $packagePath 'package/package.json'
        ) -join "`n"
        if ($LASTEXITCODE -ne 0 -or -not $packageManifestText) {
            throw 'Unable to inspect the Copilot API package metadata.'
        }
        $packageManifest = $packageManifestText | ConvertFrom-Json
        if ($packageManifest.name -ne '@jeffreycao/copilot-api') {
            throw "Unexpected package name: $($packageManifest.name)"
        }
    }

    $configurationPaths = @(
        $modelsPath,
        $codexConfigPath,
        $copilotConfigPath
    )
    if (-not $ValidateOnly) {
        Assert-ConfigurationMayBeWritten -Paths $configurationPaths
    }

    $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
    $node = Get-Command node.exe -ErrorAction SilentlyContinue
    $nodeVersion = if ($node) {
        (& $node.Source -p 'process.versions.node').Trim()
    }
    else {
        $null
    }
    $nodeMajor = if ($nodeVersion -match '^(\d+)\.') {
        [int]$Matches[1]
    }
    else {
        0
    }
    $chatGpt = Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction SilentlyContinue

    if ($ValidateOnly) {
        [pscustomobject]@{
            Status = 'validated'
            Package = $CopilotApiPackage
            SHA256 = $actualHash
            WingetAvailable = [bool]$winget
            NodeInstalled = [bool]$node
            NodeVersion = $nodeVersion
            NodeMeetsRequirement = $nodeMajor -ge 20
            ChatGPTInstalled = [bool]$chatGpt
            ExistingConfiguration = @(
                $configurationPaths | Where-Object {
                    Test-Path -LiteralPath $_ -PathType Leaf
                }
            )
            Port = $Port
            Model = $Model
        }
        return
    }

    if (-not $winget) {
        throw (
            'winget.exe is required. Install Microsoft App Installer, then ' +
            'run this script again.'
        )
    }

    if (-not $SkipChatGPT -and -not $chatGpt) {
        Write-Step 'Installing the official ChatGPT Windows app'
        Invoke-CheckedCommand -FilePath $winget.Source -Arguments @(
            'install',
            '--id', '9PLM9XGG6VKS',
            '--exact',
            '--source', 'msstore',
            '--accept-package-agreements',
            '--accept-source-agreements',
            '--silent'
        )
    }

    if ($EnableOpenSsh -or $PortalSshPublicKey.Trim()) {
        Write-Step 'Enabling Windows OpenSSH management'
        Enable-PortalOpenSsh -PublicKey $PortalSshPublicKey
    }

    if (-not $node -or $nodeMajor -lt 20) {
        Write-Step 'Installing Node.js LTS'
        Invoke-CheckedCommand -FilePath $winget.Source -Arguments @(
            'install',
            '--id', 'OpenJS.NodeJS.LTS',
            '--exact',
            '--force',
            '--accept-package-agreements',
            '--accept-source-agreements',
            '--silent'
        )
        Refresh-ProcessPath
    }

    $nodeCommand = Resolve-CommandPath -Name 'node.exe'
    $npmCommand = Resolve-CommandPath -Name 'npm.cmd'

    Write-Step 'Installing the verified Copilot API package'
    Invoke-CheckedCommand -FilePath $npmCommand -Arguments @(
        'install',
        '--global',
        $packagePath,
        '--no-audit',
        '--no-fund',
        '--loglevel=error'
    )

    $npmPrefix = (& $npmCommand 'prefix' '--global').Trim()
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($npmPrefix)) {
        throw 'Unable to resolve the global npm prefix.'
    }
    $copilotCommand = Join-Path $npmPrefix 'copilot-api.cmd'
    if (-not (Test-Path -LiteralPath $copilotCommand -PathType Leaf)) {
        throw "Copilot API command was not installed: $copilotCommand"
    }
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $userPathEntries = @($userPath -split ';' | Where-Object { $_ })
    if ($userPathEntries -notcontains $npmPrefix) {
        $newUserPath = [string]::Join(
            ';',
            @($userPathEntries + $npmPrefix)
        )
        [Environment]::SetEnvironmentVariable('Path', $newUserPath, 'User')
        $env:Path = "$env:Path;$npmPrefix"
    }

    $npmRoot = (& $npmCommand 'root' '--global').Trim()
    $installedPackageJson = Join-Path (
        Join-Path $npmRoot '@jeffreycao\copilot-api'
    ) 'package.json'
    if (-not (Test-Path -LiteralPath $installedPackageJson -PathType Leaf)) {
        throw 'The installed Copilot API package metadata was not found.'
    }
    $installedPackage = Get-Content -Raw -LiteralPath $installedPackageJson |
        ConvertFrom-Json
    if ($installedPackage.name -ne '@jeffreycao/copilot-api') {
        throw "Unexpected installed package name: $($installedPackage.name)"
    }

    $serverBundles = Get-ChildItem (
        Join-Path (Split-Path $installedPackageJson) 'dist'
    ) -Filter 'server-*.js' -File
    $serverText = ($serverBundles | Get-Content -Raw) -join "`n"
    foreach ($marker in @(
        'invalid-encrypted-content',
        'reasoning_effort TEXT',
        'session-history'
    )) {
        if (-not $serverText.Contains($marker)) {
            throw "Installed Copilot API is missing required capability: $marker"
        }
    }

    Write-Step 'Writing protected Copilot API and Codex configuration'
    New-Item -ItemType Directory -Path $codexHome -Force | Out-Null
    New-Item -ItemType Directory -Path $copilotHome -Force | Out-Null
    New-Item -ItemType Directory -Path $deploymentRoot -Force | Out-Null

    $backups = @(
        Backup-ConfigurationFile -Path $modelsPath
        Backup-ConfigurationFile -Path $codexConfigPath
        Backup-ConfigurationFile -Path $copilotConfigPath
    ) | Where-Object { $_ }

    $gatewayApiKey = New-RandomHex
    $adminApiKey = New-RandomHex
    $sessionHistoryApiKey = New-RandomHex
    $proxyConfig = [ordered]@{
        auth = [ordered]@{
            apiKeys = @($gatewayApiKey)
            adminApiKey = $adminApiKey
            sessionHistoryApiKey = $sessionHistoryApiKey
        }
        providers = [ordered]@{}
        modelMappings = [ordered]@{}
        contextManagement = [ordered]@{
            messages = $true
            responses = $false
        }
        modelReasoningEfforts = [ordered]@{
            $Model = $ReasoningEffort
        }
        useMessagesApi = $true
        useResponsesApiWebSocket = $true
        useResponsesApiWebSearch = $true
    }
    Write-Utf8NoBom -Path $copilotConfigPath -Content (
        ($proxyConfig | ConvertTo-Json -Depth 12) + "`n"
    )
    Protect-ConfigurationFile -Path $copilotConfigPath

    $modelCatalog = @'
{
  "models": [
    {
      "slug": "gpt-6-astra",
      "display_name": "GPT-6 Astra",
      "description": "GPT-6 Astra coding model with an 872K prompt context.",
      "default_reasoning_level": "max",
      "supported_reasoning_levels": [
        { "effort": "low", "description": "Fast responses with lighter reasoning" },
        { "effort": "medium", "description": "Balances speed and reasoning depth" },
        { "effort": "high", "description": "Greater reasoning depth for complex problems" },
        { "effort": "xhigh", "description": "Extra high reasoning depth for complex problems" },
        { "effort": "max", "description": "Maximum reasoning depth" }
      ],
      "shell_type": "shell_command",
      "visibility": "list",
      "minimal_client_version": "0.98.0",
      "supported_in_api": true,
      "priority": 100,
      "additional_speed_tiers": [],
      "service_tiers": [],
      "default_service_tier": null,
      "availability_nux": null,
      "upgrade": null,
      "base_instructions": "You are Codex, a coding agent. Inspect relevant code before changing it, follow repository instructions, make focused edits, validate changes, and do not undo unrelated user changes.",
      "model_messages": null,
      "include_skills_usage_instructions": false,
      "supports_reasoning_summaries": true,
      "supports_reasoning_summary_parameter": true,
      "default_reasoning_summary": "auto",
      "support_verbosity": true,
      "default_verbosity": "low",
      "apply_patch_tool_type": "freeform",
      "web_search_tool_type": "text_and_image",
      "truncation_policy": { "mode": "tokens", "limit": 10000 },
      "supports_parallel_tool_calls": true,
      "supports_image_detail_original": true,
      "context_window": 872000,
      "max_context_window": 1000000,
      "auto_compact_token_limit": 722000,
      "comp_hash": "3000",
      "effective_context_window_percent": 100,
      "experimental_supported_tools": [],
      "input_modalities": ["text", "image"],
      "supports_search_tool": true,
      "use_responses_lite": false,
      "auto_review_model_override": null,
      "tool_mode": null,
      "multi_agent_version": null
    }
  ]
}
'@
    Write-Utf8NoBom -Path $modelsPath -Content ($modelCatalog.Trim() + "`n")

    $escapedModelsPath = $modelsPath.Replace('\', '\\').Replace('"', '\"')
    $codexConfig = @"
model = "$Model"
model_provider = "copilot_api"
model_catalog_json = "$escapedModelsPath"
model_reasoning_effort = "$ReasoningEffort"
model_reasoning_summary = "auto"
model_context_window = 872000
model_auto_compact_token_limit = 722000
personality = "pragmatic"
approval_policy = "on-request"
sandbox_mode = "workspace-write"

[model_providers.copilot_api]
name = "OpenAI"
base_url = "http://localhost:$Port"
requires_openai_auth = false
supports_websockets = false
wire_api = "responses"
request_max_retries = 3
stream_max_retries = 1
stream_idle_timeout_ms = 300000

[model_providers.copilot_api.auth]
command = "powershell.exe"
args = [
  "-NoProfile",
  "-NonInteractive",
  "-Command",
  '[Console]::Out.Write([Environment]::GetEnvironmentVariable("GITHUB_COPILOT_API_KEY", "User"))'
]

[features]
memories = true

[analytics]
enabled = false

[windows]
sandbox = "unelevated"
"@
    Write-Utf8NoBom -Path $codexConfigPath -Content (
        $codexConfig.Trim() + "`n"
    )
    Protect-ConfigurationFile -Path $codexConfigPath
    Protect-ConfigurationFile -Path $modelsPath

    [Environment]::SetEnvironmentVariable(
        'GITHUB_COPILOT_API_KEY',
        $gatewayApiKey,
        'User'
    )
    $env:GITHUB_COPILOT_API_KEY = $gatewayApiKey

    if (-not $SkipCopilotLogin) {
        Write-Step 'Starting interactive GitHub Copilot authentication'
        Invoke-CheckedCommand -FilePath $copilotCommand -Arguments @(
            'auth', 'login', '--provider', 'copilot'
        )
    }

    $launcher = @"
param([int]`$Port = $Port)
`$ErrorActionPreference = 'Stop'
`$listener = Get-NetTCPConnection -LocalPort `$Port -State Listen -ErrorAction SilentlyContinue
if (`$listener) { exit 0 }
`$npmPrefix = (& npm.cmd prefix --global).Trim()
if (`$LASTEXITCODE -ne 0 -or -not `$npmPrefix) { exit 1 }
`$copilotApi = Join-Path `$npmPrefix 'copilot-api.cmd'
if (-not (Test-Path -LiteralPath `$copilotApi -PathType Leaf)) { exit 1 }
& `$copilotApi start --port `$Port *>> '$stdoutPath'
"@
    Write-Utf8NoBom -Path $launcherPath -Content ($launcher.Trim() + "`n")
    Protect-ConfigurationFile -Path $launcherPath

    if (-not $SkipStartupRegistration) {
        Write-Step 'Registering Copilot API startup for the current user'
        $runCommand = (
            'powershell.exe -NoProfile -ExecutionPolicy Bypass ' +
            "-WindowStyle Hidden -File `"$launcherPath`" -Port $Port"
        )
        New-Item -Path $runKey -Force | Out-Null
        New-ItemProperty `
            -Path $runKey `
            -Name $runValueName `
            -Value $runCommand `
            -PropertyType String `
            -Force | Out-Null
    }

    if (-not $SkipStart) {
        if (-not (Test-TcpPort -HostName '127.0.0.1' -PortNumber $Port)) {
            Write-Step 'Starting Copilot API'
            $startArguments = (
                '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden ' +
                "-File `"$launcherPath`" -Port $Port"
            )
            Start-Process `
                -FilePath 'powershell.exe' `
                -ArgumentList $startArguments `
                -WindowStyle Hidden | Out-Null
            Wait-ForProxy -PortNumber $Port
        }

        Write-Step 'Verifying the authenticated model endpoint'
        $modelsResponse = Invoke-RestMethod `
            -Uri "http://127.0.0.1:$Port/v1/models" `
            -Headers @{ 'x-api-key' = $gatewayApiKey } `
            -TimeoutSec 30
        if (-not $modelsResponse.data) {
            throw 'Copilot API returned no models.'
        }
    }

    if (-not $SkipChatGPT) {
        $installedApp = Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction SilentlyContinue
        if (-not $installedApp) {
            throw (
                'ChatGPT installation completed but OpenAI.Codex was not found. ' +
                'Open Microsoft Store and finish the installation.'
            )
        }
        Start-Process `
            -FilePath 'explorer.exe' `
            -ArgumentList 'shell:AppsFolder\OpenAI.Codex_2p2nqsd0c76g0!App'
    }

    [pscustomobject]@{
        Status = 'installed'
        ChatGPT = if ($SkipChatGPT) { 'skipped' } else { 'installed' }
        CopilotApiVersion = $installedPackage.version
        CopilotApiPort = $Port
        Model = $Model
        CodexConfig = $codexConfigPath
        ModelCatalog = $modelsPath
        CopilotApiConfig = $copilotConfigPath
        StartupRegistered = -not $SkipStartupRegistration
        OpenSshEnabled = $EnableOpenSsh -or [bool]$PortalSshPublicKey.Trim()
        ConfigurationBackups = $backups
        NextStep = 'Sign in to ChatGPT, open Codex, and select GPT-6 Astra.'
    }
}
finally {
    Remove-Item -LiteralPath $workRoot -Recurse -Force -ErrorAction SilentlyContinue
}
