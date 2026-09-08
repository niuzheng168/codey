#requires -Version 5.1
<#
.SYNOPSIS
Plan or install a fresh owner-bound Windows Codey node, never a Linux/WSL node.
.DESCRIPTION
Uses the downloaded Windows package and reviewed Azure network file.
Default is a read-only plan. -Apply -NetworkApproved explicitly approves the
listed private listeners. This script never changes firewall/network rules.
Services start only while the original Windows owner is logged on.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$NetworkFile,
    [string]$Out = (Join-Path $PSScriptRoot '..\output\codey-machine.json'),
    [string]$Enrollment = (Join-Path $PSScriptRoot '..\assets\enrollment.json'),
    [string]$Name = '',
    [string]$PythonExe = '',
    [string]$OpenSslExe = '',
    [string]$CodexExe = '',
    [switch]$Apply,
    [switch]$NetworkApproved
)
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT' -or -not [Environment]::Is64BitOperatingSystem) {
    throw 'This entry point requires native Windows x64. It does not use WSL or install on macOS.'
}
if ($Apply -and -not $NetworkApproved) {
    throw 'Review the network file and private 3001/8443 listeners first; confirm explicitly with -NetworkApproved. No firewall rules will be changed.'
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
$arguments = @('-X', 'utf8', '-I', '-B', (Join-Path $PSScriptRoot 'configure-windows.py'),
    '--enrollment', $Enrollment, '--network-file', $NetworkFile, '--out', $Out)
if ($Name) { $arguments += @('--name', $Name) }
if ($OpenSslExe) { $arguments += @('--openssl', $OpenSslExe) }
if ($CodexExe) { $arguments += @('--codex-executable', $CodexExe) }
if ($Apply) { $arguments += '--apply' }
if ($NetworkApproved) { $arguments += '--network-approved' }
& $PythonExe @arguments
if ($LASTEXITCODE -ne 0) { throw "Windows node setup exited with code $LASTEXITCODE; no Linux fallback attempted." }
