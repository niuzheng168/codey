# Portable tests of the real PowerShell classifier, without Windows services,
# sockets, process termination, downloads or registry changes.
param([Parameter(Mandatory = $true)][string]$Installer)
$ErrorActionPreference = 'Stop'
foreach ($file in @($Installer, (Join-Path $PSScriptRoot 'windows-oneclick-fixture.ps1'))) {
    $tokens = $null; $errors = $null
    $null = [System.Management.Automation.Language.Parser]::ParseFile($file, [ref]$tokens, [ref]$errors)
    if ($errors.Count) { throw ($errors | Out-String) }
}
. $Installer
# Removed workflow flags still fail before native installation.
$rejected = $false
try { Invoke-CodeyWindowsInstall -Repair $true } catch { $rejected = $_.FullyQualifiedErrorId -like 'NamedParameterNotFound*' }
if (-not $rejected) { throw 'Removed repair option must fail before native installation can run' }
# Keep native Windows spelling when this test runs in PowerShell on Linux.
function Join-Path { param([string]$Path, [string]$ChildPath); $Path.TrimEnd('\') + '\' + $ChildPath }
$previous = [pscustomobject]@{
    nodeExe = 'C:\Users\owner name\Codey\node.exe'
    codeyDirectory = 'C:\Users\owner name\Codey\app\node_modules\codey'
}
$entry = Join-Path $previous.codeyDirectory 'bin\codey.mjs'
$worker = Join-Path $previous.codeyDirectory 'lib\workspace.mjs'
$workspace = [pscustomobject]@{
    ProcessId = 11; ExecutablePath = $previous.nodeExe
    CommandLine = Join-CodeyArguments @($previous.nodeExe, $worker)
}
$gateway = [pscustomobject]@{
    ProcessId = 12; ExecutablePath = $previous.nodeExe
    CommandLine = Join-CodeyArguments @($previous.nodeExe, $entry, 'copilot', 'start', '--host', '127.0.0.1', '--port', '4141')
}
$script:Processes = @($workspace, $gateway)
$script:Listeners = @(
    [pscustomobject]@{ LocalAddress = '127.0.0.1'; LocalPort = 3001; OwningProcess = 11 },
    [pscustomobject]@{ LocalAddress = '127.0.0.1'; LocalPort = 4141; OwningProcess = 12 },
    [pscustomobject]@{ LocalAddress = '::1'; LocalPort = 8443; OwningProcess = 12 }
)
$script:Checks = 0
function Check { param([bool]$Value); if (-not $Value) { throw 'Windows port ownership assertion failed' }; $script:Checks++ }
function Get-CodeyListeners { $script:Listeners }
function Get-CodeyProcesses { param($OwnerSid); if ($OwnerSid -eq 'owner') { $script:Processes } }
function Stop-Process { throw 'Must never stop a process during preflight' }

Check (@(Get-CodeyForeignListeners @() $script:Processes $null).Count -eq 0)
Check (@(Get-CodeyForeignListeners $script:Listeners $script:Processes $previous).Count -eq 0)
Assert-CodeyPortOwnership 'owner' $previous
Check (@(Get-CodeyForeignListeners $script:Listeners $script:Processes $null).Count -eq 3)
Check (@(Get-CodeyForeignListeners $script:Listeners @() $previous).Count -eq 3)

$goodWorker = $workspace.CommandLine
$workspace.CommandLine = Join-CodeyArguments @($previous.nodeExe, $entry, 'workspace', '--host', '127.0.0.1', '--port', '3001')
Check (@(Get-CodeyForeignListeners $script:Listeners $script:Processes $previous).Count -eq 0)
foreach ($bad in @(
    ($goodWorker + ' --host 127.0.0.1'),
    (Join-CodeyArguments @($previous.nodeExe, '-e', $worker)),
    (Join-CodeyArguments @($previous.nodeExe, ($worker + '.other'))),
    (Join-CodeyArguments @($previous.nodeExe, $entry, $worker))
)) {
    $workspace.CommandLine = $bad
    Check (@(Get-CodeyForeignListeners $script:Listeners $script:Processes $previous).Count -eq 1)
}
$workspace.CommandLine = $goodWorker

$good = $gateway.CommandLine
$gateway.CommandLine = Join-CodeyArguments @($previous.nodeExe, $entry, 'gateway', 'start', '--headless', '--host', '127.0.0.1', '--port', '4141')
Check (@(Get-CodeyForeignListeners $script:Listeners $script:Processes $previous).Count -eq 0)
$gateway.CommandLine = $good
foreach ($bad in @(
    ($good + ' --eval other'),
    (Join-CodeyArguments @($previous.nodeExe, '-e', "echo $entry gateway")),
    (Join-CodeyArguments @($previous.nodeExe, ($entry + '.other'), 'gateway', 'start', '--headless', '--host', '127.0.0.1', '--port', '4141')),
    (Join-CodeyArguments @($previous.nodeExe, $worker))
)) {
    $gateway.CommandLine = $bad
    Check (@(Get-CodeyForeignListeners $script:Listeners $script:Processes $previous).Count -eq 2)
}
$gateway.CommandLine = $good
foreach ($address in @('0.0.0.0', '::', '192.168.1.2')) {
    $script:Listeners[2].LocalAddress = $address
    Check (@(Get-CodeyForeignListeners $script:Listeners $script:Processes $previous).Count -eq 1)
    $failed = $false
    try { Assert-CodeyPortOwnership 'owner' $previous } catch { $failed = $_.Exception.Message -match '8443.*foreign or unverified' }
    Check $failed
}
$script:Listeners[2].LocalAddress = '::1'
$gateway.ExecutablePath = 'C:\another\node.exe'
Check (@(Get-CodeyForeignListeners $script:Listeners $script:Processes $previous).Count -eq 2)
$gateway.ExecutablePath = $previous.nodeExe
$failed = $false
try { Assert-CodeyPortOwnership 'other-owner' $previous } catch { $failed = $_.Exception.Message -match 'foreign or unverified' }
Check $failed
Write-Output "WINDOWS_PORT_PREFLIGHT_OK checks=$script:Checks"
