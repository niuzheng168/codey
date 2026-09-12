#requires -Version 5.1
# The builder pins the exact ZIP checksum. No download, setup, task registration or force switch.
[CmdletBinding()]
param(
    [string]$BundlePath = (Join-Path $PSScriptRoot '@@BUNDLE_NAME@@'),
    [switch]$Apply,
    [switch]$Recover
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$expectedSha256 = '@@BUNDLE_SHA256@@'
$expectedManifestSha256 = '@@MANIFEST_SHA256@@'
$expectedRunnerSha256 = '@@RUNNER_SHA256@@'
$expectedComputer = '@@EXPECTED_COMPUTER@@'

function Require-Offline {
    param($Condition, [string]$Message)
    if (-not $Condition) { throw ('CODEY_OFFLINE: ' + $Message) }
}

function Assert-OwnerPath {
    param([string]$File, [string]$OwnerHome, [string]$OwnerSid)
    $full = [IO.Path]::GetFullPath($File)
    Require-Offline ($full.StartsWith($OwnerHome.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) `
        'Installation/bootstrap paths must remain under the original owner profile.'
    $cursor = $full
    while ($cursor -and $cursor -ne $OwnerHome) {
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force
            Require-Offline (-not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) 'Linked owner paths need manual review.'
            Require-Offline ((Get-Acl -LiteralPath $cursor).GetOwner([Security.Principal.SecurityIdentifier]).Value -eq $OwnerSid) `
                'A path belongs to another OS owner.'
        }
        $cursor = Split-Path -Parent $cursor
    }
}

function New-PrivateDirectory {
    param([string]$Directory, [Security.Principal.SecurityIdentifier]$Sid)
    $null = [IO.Directory]::CreateDirectory($Directory)
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetOwner($Sid)
    $acl.SetAccessRuleProtection($true, $false)
    $rule = [Security.AccessControl.FileSystemAccessRule]::new($Sid, 'FullControl',
        'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $acl.AddAccessRule($rule)
    Set-Acl -LiteralPath $Directory -AclObject $acl
}

function Expand-VerifiedBundle {
    param([string]$Archive, [string]$Destination)
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::OpenRead($Archive)
    try {
        Require-Offline ($zip.Entries.Count -gt 1 -and $zip.Entries.Count -lt 20000) 'Unexpected ZIP entry count.'
        $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
        $total = [long]0
        foreach ($entry in $zip.Entries) {
            $name = $entry.FullName
            Require-Offline ($name -match '^[A-Za-z0-9_@+./-]+$' -and -not $name.EndsWith('/')) 'Unexpected ZIP filename.'
            foreach ($part in $name.Split('/')) {
                Require-Offline ($part -and $part -notin @('.', '..') -and $part -notmatch '[. ]$' -and
                    $part -notmatch '^(?i:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)') 'Unsafe ZIP path.'
            }
            Require-Offline ($seen.Add($name)) 'Duplicate/colliding Windows ZIP path.'
            $mode = ($entry.ExternalAttributes -shr 16) -band 0xF000
            Require-Offline ($mode -eq 0 -or $mode -eq 0x8000) 'ZIP links/special files are not allowed.'
            $total += $entry.Length
            Require-Offline ($entry.Length -ge 0 -and $total -lt 4GB) 'Oversized offline ZIP.'
        }
        foreach ($entry in $zip.Entries) {
            $file = Join-Path $Destination ($entry.FullName.Replace('/', '\'))
            $null = [IO.Directory]::CreateDirectory((Split-Path -Parent $file))
            [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $file, $false)
        }
    } finally { $zip.Dispose() }
}

Require-Offline (-not ($Apply -and $Recover)) 'Choose either -Apply or -Recover, not both.'
Require-Offline ($env:OS -eq 'Windows_NT' -and [Environment]::Is64BitProcess -and
    $env:PROCESSOR_ARCHITECTURE -eq 'AMD64') 'Use native x64 PowerShell on Windows, not WSL.'
Require-Offline ($env:COMPUTERNAME -ieq $expectedComputer) ('This kit is pinned to ' + $expectedComputer + '.')
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
Require-Offline (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) -and
    [Diagnostics.Process]::GetCurrentProcess().SessionId -ne 0) 'Run as the original logged-on owner, without Administrator elevation.'
$ownerHome = [Environment]::GetFolderPath('UserProfile')
$runtimeFile = Join-Path $ownerHome '.config\codey-machine-windows\runtime.json'
Assert-OwnerPath $runtimeFile $ownerHome $identity.User.Value
$runtime = [IO.File]::ReadAllText($runtimeFile, [Text.Encoding]::UTF8) | ConvertFrom-Json
Require-Offline ($runtime.schema -eq 2 -and $runtime.kind -eq 'codey-windows-oneclick' -and
    $runtime.layout -eq 'npm-codey-package' -and $runtime.ownerSid -eq $identity.User.Value -and
    $runtime.ownerHome -eq $ownerHome -and $runtime.computer -ceq $env:COMPUTERNAME) `
    'The original managed Windows installation was not recognized. No reinstall or registration was performed.'
Assert-OwnerPath $runtime.nodeExe $ownerHome $identity.User.Value
Require-Offline (Test-Path -LiteralPath $runtime.nodeExe -PathType Leaf) 'The original Node executable is missing.'
Require-Offline (Test-Path -LiteralPath $BundlePath -PathType Leaf) 'Place the matching offline ZIP beside this script.'
Require-Offline ((Get-FileHash -LiteralPath $BundlePath -Algorithm SHA256).Hash -ieq $expectedSha256) `
    'Offline ZIP checksum mismatch; nothing was installed.'

# Keep the bootstrap/cache path short enough for Windows PowerShell 5.1 ZIP APIs.
# The full ZIP/manifest/runner hashes are still checked; this is only a directory label.
$base = Join-Path $ownerHome '.codey-offline'
Assert-OwnerPath $base $ownerHome $identity.User.Value
if (-not (Test-Path -LiteralPath $base)) { New-PrivateDirectory $base $identity.User }
$kit = Join-Path $base $expectedSha256.Substring(0, 16)
Assert-OwnerPath $kit $ownerHome $identity.User.Value
if (-not (Test-Path -LiteralPath $kit)) {
    $work = Join-Path $base ('x-' + [guid]::NewGuid().ToString('N').Substring(0, 12))
    New-PrivateDirectory $work $identity.User
    Expand-VerifiedBundle ([IO.Path]::GetFullPath($BundlePath)) $work
    Move-Item -LiteralPath $work -Destination $kit
}
Require-Offline ((Get-FileHash -LiteralPath (Join-Path $kit 'manifest.json') -Algorithm SHA256).Hash -ieq
    $expectedManifestSha256) 'Cached offline manifest was changed; do not execute it.'
Require-Offline ((Get-FileHash -LiteralPath (Join-Path $kit 'offline-update.mjs') -Algorithm SHA256).Hash -ieq
    $expectedRunnerSha256) 'Cached offline runner was changed; do not execute it.'

$mode = if ($Recover) { 'recover' } elseif ($Apply) { 'apply' } else { 'check' }
Write-Host ('Codey offline kit @@VERSION@@; mode=' + $mode + '; computer=' + $expectedComputer)
Write-Host 'No Portal enrollment, npm download, Node/Codex/DevTunnel update or setup.'
Write-Host 'Apply requires an external terminal with native Codex exited and Codey tasks idle.'
Write-Host 'Existing model services may still contact their providers during normal restart.'
# Only the child environment is affected; never persist changes to model/user settings.
$savedNodeOptions = [Environment]::GetEnvironmentVariable('NODE_OPTIONS', 'Process')
$savedNodePath = [Environment]::GetEnvironmentVariable('NODE_PATH', 'Process')
try {
    [Environment]::SetEnvironmentVariable('NODE_OPTIONS', $null, 'Process')
    [Environment]::SetEnvironmentVariable('NODE_PATH', $null, 'Process')
    & $runtime.nodeExe (Join-Path $kit 'offline-update.mjs') --bundle-root $kit --mode $mode --expected-computer $expectedComputer
    Require-Offline ($LASTEXITCODE -eq 0) 'Update/check failed. Keep the output and private job records; do not reinstall or delete locks.'
} finally {
    [Environment]::SetEnvironmentVariable('NODE_OPTIONS', $savedNodeOptions, 'Process')
    [Environment]::SetEnvironmentVariable('NODE_PATH', $savedNodePath, 'Process')
}
if ($mode -eq 'check') {
    Write-Host 'Preflight passed. To install, run the same script with -Apply from this external terminal.'
}
