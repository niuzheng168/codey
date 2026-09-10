#requires -Version 5.1
<#
.SYNOPSIS
Plan or install a fresh owner-bound Windows Codey node, never a Linux/WSL node.
.DESCRIPTION
Uses the personalized Windows DevTunnel package while preserving an existing
model proxy and Codex installation. DevTunnel uses the owner's GitHub login.
Default is a read-only plan. -Apply -NetworkApproved approves the private
outbound tunnel and loopback listeners; firewall/network rules are not changed.
Services start only while the original Windows owner is logged on.
-Resume verifies and reuses a completed runtime that stopped at tunnel binding,
before runtime configuration or tasks were created. It never rebuilds or creates
a replacement tunnel. A successful installation remains verification-only.
#>
[CmdletBinding()]
param(
    [string]$Out = (Join-Path $PSScriptRoot '..\output\codey-machine.json'),
    [string]$Enrollment = (Join-Path $PSScriptRoot '..\assets\enrollment.json'),
    [string]$Name = '',
    [string]$PythonExe = '',
    [string]$OpenSslExe = '',
    [string]$CodexExe = '',
    [string]$DevTunnelExe = '',
    [string]$UsageKeyFile = '',
    [string]$WorkspaceRoot = '',
    [string]$ExpectedComputerName = '',
    [switch]$Resume,
    [switch]$Apply,
    [switch]$NetworkApproved
)
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT' -or -not [Environment]::Is64BitOperatingSystem) {
    throw 'This entry point requires native Windows x64. It does not use WSL or install on macOS.'
}
if ($Apply -and -not $NetworkApproved) {
    throw 'Review the private DevTunnel plan first; confirm with -NetworkApproved. No firewall rules will be changed.'
}
if ($ExpectedComputerName -and $env:COMPUTERNAME -ine $ExpectedComputerName) {
    throw 'Wrong computer. No installation or environment change was attempted.'
}
$invitation = Get-Content -LiteralPath $Enrollment -Raw -Encoding UTF8 | ConvertFrom-Json
if ($invitation.acceptance.expectedComputerName -and
    $env:COMPUTERNAME -ine $invitation.acceptance.expectedComputerName) {
    throw 'This acceptance package is bound to a different computer. Do not use it on the existing working node.'
}
if (-not $PythonExe) {
    $command = Get-Command python.exe -ErrorAction SilentlyContinue
    if (-not $command -or $command.Source -like '*\WindowsApps\*') {
        throw 'Use an existing Python 3.12+ installation via -PythonExe. No system Python or execution policy will be changed.'
    }
    $PythonExe = $command.Source
}
if (-not [IO.Path]::IsPathRooted($PythonExe) -or -not (Test-Path -LiteralPath $PythonExe -PathType Leaf)) {
    throw 'PythonExe must name an existing absolute executable path.'
}
if ($invitation.network.mode -ne 'devtunnel') {
    throw 'Download this account''s current private DevTunnel package. Existing nodes are not migrated by this installer.'
}
$arguments = @('-X', 'utf8', '-I', '-B', (Join-Path $PSScriptRoot 'configure-windows-tunnel.py'),
    '--enrollment', $Enrollment, '--out', $Out)
if ($DevTunnelExe) { $arguments += @('--devtunnel-executable', $DevTunnelExe) }
if ($UsageKeyFile) { $arguments += @('--usage-key-file', $UsageKeyFile) }
if ($WorkspaceRoot) { $arguments += @('--workspace-root', $WorkspaceRoot) }
if ($ExpectedComputerName) { $arguments += @('--expected-computer-name', $ExpectedComputerName) }
if ($Resume) { $arguments += '--resume' }
if ($Name) { $arguments += @('--name', $Name) }
if ($OpenSslExe) { $arguments += @('--openssl', $OpenSslExe) }
if ($CodexExe) { $arguments += @('--codex-executable', $CodexExe) }
if ($Apply) { $arguments += '--apply' }
if ($NetworkApproved) { $arguments += '--network-approved' }
& $PythonExe @arguments
if ($LASTEXITCODE -ne 0) { throw "Windows node setup exited with code $LASTEXITCODE; no Linux fallback attempted." }
