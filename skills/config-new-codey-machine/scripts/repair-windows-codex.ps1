#requires -Version 5.1
<#
.SYNOPSIS
Plan/apply a native Codex pin repair on an already activated Windows DevTunnel node.
.DESCRIPTION
Run under the original non-admin owner in regular PowerShell, not Codey's terminal.
Does not reinstall, log in, rebuild, change network rules or modify existing model/Desktop services.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$NodeId,
    [Parameter(Mandatory = $true)][string]$ExpectedComputerName,
    [Parameter(Mandatory = $true)][string]$CodexExe,
    [string]$PythonExe = '',
    [switch]$Apply
)
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT' -or -not [Environment]::Is64BitOperatingSystem -or
    [Environment]::MachineName -ine $ExpectedComputerName -or $NodeId -notmatch '^n-[a-f0-9]{24}$') {
    throw 'Use the exact activated node on the expected native Windows computer.'
}
if (-not $PythonExe) {
    $command = Get-Command python.exe -ErrorAction SilentlyContinue
    if (-not $command -or $command.Source -like '*\WindowsApps\*') {
        throw 'Specify an existing Python 3.12+ with -PythonExe. No Python or policy will be installed/changed.'
    }
    $PythonExe = $command.Source
}
foreach ($file in @($PythonExe, $CodexExe)) {
    if (-not [IO.Path]::IsPathRooted($file) -or -not (Test-Path -LiteralPath $file -PathType Leaf)) {
        throw 'Explicit, existing absolute Python/Codex executables are required; no Codex PATH fallback.'
    }
}
$arguments = @('-X', 'utf8', '-I', '-B', (Join-Path $PSScriptRoot 'repair-windows-codex.py'),
    '--node-id', $NodeId, '--expected-computer-name', $ExpectedComputerName, '--codex-executable', $CodexExe)
if ($Apply) { $arguments += '--apply' }
& $PythonExe @arguments
if ($LASTEXITCODE -ne 0) {
    throw 'Native Codex repair stopped. Review the structured error; do not reinstall or delete the existing node/tunnel.'
}
