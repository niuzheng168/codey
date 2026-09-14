# Cross-platform PowerShell execution of metadata resolution and export control flow.
# Native ACLs, COM tasks and processes remain covered by windows-oneclick-fixture.ps1.
param([Parameter(Mandatory = $true)][string]$Root)
$ErrorActionPreference = 'Stop'
foreach ($file in Get-ChildItem -LiteralPath (Join-Path $Root 'package/scripts') -Filter '*.ps1') {
    $tokens = $null; $errors = $null
    $null = [Management.Automation.Language.Parser]::ParseFile($file.FullName, [ref]$tokens, [ref]$errors)
    if ($errors.Count) { throw "PowerShell syntax error in $($file.Name): $($errors[0].Message)" }
}
. (Join-Path $Root 'package/scripts/install.ps1')
# Portable I/O adapters only; production absolute Windows path/ACL code is unchanged.
function Assert-CodeyPath { param($Path, $Root, [switch]$AllowRoot); return [IO.Path]::GetFullPath($Path) }
function Write-CodeyFile { param($Path, $Content); [IO.File]::WriteAllText($Path, $Content) }
function Check { param([bool]$Condition, [string]$Message); if (-not $Condition) { throw $Message } }

$packageRoot = Join-Path $Root 'package'
$manifestFile = Join-Path $packageRoot 'assets/manifest.json'
$before = [IO.File]::ReadAllText($manifestFile)
$package = Read-CodeyWindowsPackage $packageRoot
Check ($package.Setup.platform -eq 'windows-x64') 'Setup must resolve to the native Windows platform'
Check ($package.Manifest.platform -eq 'windows-x64') 'Windows runtime must not consume Linux service metadata'
Check ($package.Manifest.nodeDistribution.url -like '*-win-x64.zip') 'Windows must use its own official Node distribution'
Check ([IO.File]::ReadAllText($manifestFile) -ceq $before) 'Resolving the platform must not rewrite the shared artifact'
if ($package.Manifest.PSObject.Properties['runtimePlatforms']) {
    Check ($package.Setup.updater.protocol -eq 1) 'Keep the public key for automatic native updater bootstrap'
} else {
    Check ($package.Setup.updater.supported -eq $false) 'Legacy metadata remains readable'
}

# Exercise the real installed-package identity/platform check too, with only the
# native addon and CLI subprocesses stubbed. A shared build has no .platform field.
function Invoke-CodeyProcess {
    param($Executable, $Arguments, $WorkingDirectory, $TimeoutSeconds)
    if ($Arguments[0] -eq '-e') { return [pscustomobject]@{ Stdout = '' } }
    if ($Arguments[1] -eq '--version') { return [pscustomobject]@{ Stdout = 'codey 0.1.0' } }
    throw 'Unexpected command in installed-package fixture'
}
Assert-CodeyInstalledPackage (Join-Path $Root 'installed-codey') $package 'fixture-node'

$script:Operations = [Collections.Generic.List[string]]::new()
$owner = Join-Path $Root 'owner'
[IO.Directory]::CreateDirectory($owner) | Out-Null
$staging = Join-Path $owner 'registration.private.json'
$config = [pscustomobject]@{
    ownerHome = $owner; nodeExe = 'fixture-node'; helperPath = 'unused-old-helper'
    registrationStaging = $staging
}
function Invoke-CodeyProcess {
    param($Executable, $Arguments, $TimeoutSeconds)
    $script:Operations.Add($Arguments[1])
    if ($Arguments[1] -eq 'registration') {
        [IO.File]::WriteAllText($staging, '{"schema":2,"fixture":"private-existing-identity"}')
    } elseif ($Arguments[1] -eq 'check-registration') {
        Check (Test-Path -LiteralPath $Arguments[3]) 'Export must be present before success validation'
    } else { throw 'Unexpected process operation in export-only fixture' }
}
$configPath = Join-Path $owner 'runtime.json'
$output = Export-CodeyRegistration $config $configPath
Check ($output -eq (Join-Path $owner 'codey-machine-registration.json')) 'Export belongs in the original owner home'
Check (Test-Path -LiteralPath $output) 'Registration export must exist'
Check (-not (Test-Path -LiteralPath $staging)) 'Remove the private staging copy'
[IO.File]::Delete($output)
$null = Export-CodeyRegistration $config $configPath
Check (Test-Path -LiteralPath $output) 'Re-export a missing JSON without reinstalling'
Check (($script:Operations -join ',') -eq 'registration,check-registration,registration,check-registration') 'No service, auth or install operations'

$banner = "Welcome to dev tunnels!`n`n" + '{"token":"private-fixture"}'
Check ((ConvertFrom-CodeyTunnelJson $banner).token -ceq 'private-fixture') 'Handle DevTunnel banners'
$rejected = $false
try { ConvertFrom-CodeyTunnelJson '{"token":"private-fixture"} trailer' | Out-Null }
catch {
    $rejected = $true
    Check (-not $_.Exception.Message.Contains('private-fixture')) 'Do not print token-bearing parser errors'
}
Check $rejected 'Reject malformed DevTunnel JSON'

# Auto-install wiring must pass the native -Apply switch, then erase bootstrap
# credential copies. No real Node, service or Task Scheduler operation is run.
$config | Add-Member -NotePropertyName configRoot -NotePropertyValue $owner
$config | Add-Member -NotePropertyName powershellExe -NotePropertyValue 'fixture-powershell'
function New-CodeyDirectory { param($Path); [IO.Directory]::CreateDirectory($Path) | Out-Null }
$script:AutomaticCalls = 0
function Invoke-CodeyProcess {
    param($Executable, $Arguments, $WorkingDirectory, $TimeoutSeconds)
    $script:AutomaticCalls++
    if ($Executable -eq 'fixture-node') {
        Check ($Arguments[0].EndsWith('updater-bootstrap.mjs') -and $Arguments[1] -eq $configPath) 'Use the real native bootstrap entrypoint'
        [IO.File]::WriteAllText((Join-Path $Arguments[2] 'install.ps1'), '# fixture only')
    } else {
        Check ($Executable -eq 'fixture-powershell' -and $Arguments -contains '-Apply') 'Automatically apply the native updater installer'
        Check (Test-Path -LiteralPath $Arguments[4]) 'Execute the privately prepared installer'
    }
}
Install-CodeyAutomaticUpdater $config $configPath
Check ($script:AutomaticCalls -eq 2) 'Automatically prepare and install the updater'
Check (@(Get-ChildItem -LiteralPath $owner -Filter 'updater-bootstrap-*').Count -eq 0) 'No leftover bootstrap credentials'
Write-Output 'WINDOWS_REGISTRATION_FIXTURE_OK'
