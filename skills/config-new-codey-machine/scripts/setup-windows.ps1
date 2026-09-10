#requires -Version 5.1
<#
.SYNOPSIS
Plan or install a native Windows Codey node from the reusable static package.
.DESCRIPTION
Uses public assets/setup.json and generates this machine's registration
credentials locally. DevTunnel uses the owner's GitHub login. Default is a
read-only plan. -Apply -NetworkApproved approves only the private outbound
tunnel and loopback listeners; firewall/network rules are not changed.
The final output is a private schema 2 registration file.
#>
[CmdletBinding()]
param(
    [string]$Out = (Join-Path $HOME 'codey-machine-registration.json'),
    [string]$Name = '',
    [string]$PythonExe = '',
    [string]$OpenSslExe = '',
    [string]$CodexExe = '',
    [string]$CodexHome = '',
    [string]$CopilotApiConfig = '',
    [string]$ModelKeyFile = '',
    [string]$DevTunnelExe = '',
    [string]$UsageKeyFile = '',
    [string]$WorkspaceRoot = '',
    [string]$ExpectedComputerName = '',
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
$arguments = @('-X', 'utf8', '-I', '-B', (Join-Path $PSScriptRoot 'codey.py'), 'windows',
    '--out', $Out)
if ($DevTunnelExe) { $arguments += @('--devtunnel-executable', $DevTunnelExe) }
if ($UsageKeyFile) { $arguments += @('--usage-key-file', $UsageKeyFile) }
if ($WorkspaceRoot) { $arguments += @('--workspace-root', $WorkspaceRoot) }
if ($ExpectedComputerName) { $arguments += @('--expected-computer-name', $ExpectedComputerName) }
if ($Name) { $arguments += @('--name', $Name) }
if ($OpenSslExe) { $arguments += @('--openssl', $OpenSslExe) }
if ($CodexExe) { $arguments += @('--codex-executable', $CodexExe) }
if ($CodexHome) { $arguments += @('--codex-home', $CodexHome) }
if ($CopilotApiConfig) { $arguments += @('--copilot-api-config', $CopilotApiConfig) }
if ($ModelKeyFile) { $arguments += @('--model-key-file', $ModelKeyFile) }
if ($Apply) { $arguments += '--apply' }
if ($NetworkApproved) { $arguments += '--network-approved' }
& $PythonExe @arguments
if ($LASTEXITCODE -ne 0) { throw "Windows node setup exited with code $LASTEXITCODE; no Linux fallback attempted." }
