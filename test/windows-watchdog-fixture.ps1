# Real processes in a private temporary directory; no production tasks or network.
param([Parameter(Mandatory = $true)][string]$Root)
$ErrorActionPreference = 'Stop'
$scripts = Join-Path $Root 'package\scripts'
. (Join-Path $scripts 'windows-common.ps1')
$checks = 0
function Check([bool]$Condition, [string]$Name) {
    if (-not $Condition) { throw "Assertion failed: $Name" }
    $script:checks++
}
function Wait-Until([scriptblock]$Condition, [int]$Seconds = 20) {
    $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
    do {
        if (& $Condition) { return }
        Start-Sleep -Milliseconds 150
    } while ([DateTime]::UtcNow -lt $deadline)
    throw 'Isolated watchdog fixture timed out.'
}
$owner = Get-CodeyOwner
$supervisor = Join-Path $Root 'runtime\supervisor'
$state = Join-Path $Root 'runtime\state'
New-CodeyDirectory $supervisor
New-CodeyDirectory $state
$hashes = @{}
foreach ($name in @('windows-common.ps1','windows-process.cs','windows-service.ps1','windows-runtime.mjs')) {
    $target = Join-Path $supervisor $name
    Copy-Item -LiteralPath (Join-Path $scripts $name) -Destination $target
    $hashes[$name] = (Get-FileHash -LiteralPath $target).Hash
}
$hostExe = Install-CodeyTaskHost $supervisor
$hashes['codey-task-host.exe'] = (Get-FileHash -LiteralPath $hostExe).Hash
# Inspect the PE subsystem, not just a WindowStyle flag.
$pe = [IO.File]::ReadAllBytes($hostExe)
$peOffset = [BitConverter]::ToInt32($pe, 0x3c)
Check ([BitConverter]::ToUInt16($pe, $peOffset + 24 + 68) -eq 2) 'task host is a Windows GUI executable'
$source = Join-Path $Root 'probe.cs'
[IO.File]::WriteAllText($source, @'
using System;
using System.IO;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
public static class Probe {
    [DllImport("kernel32.dll")] static extern IntPtr GetConsoleWindow();
    public static int Main(string[] args) {
        var directory = Environment.GetEnvironmentVariable("FIXTURE_STATE");
        Console.WriteLine("CONSOLE=" + GetConsoleWindow().ToInt64());
        Console.Error.WriteLine("STDERR_CAPTURED");
        Console.WriteLine("TOKEN_FILE=" + File.ReadAllText(Path.Combine(directory, "github_token")));
        if (File.Exists(Path.Combine(directory, "crash-once"))) {
            File.Delete(Path.Combine(directory, "crash-once"));
            Console.WriteLine("INTENTIONAL_FIXTURE_EXIT_17");
            return 17;
        }
        var info = new ProcessStartInfo(args[0], "-NoLogo -NoProfile -NonInteractive -Command \"Start-Sleep -Seconds 90\"");
        info.UseShellExecute = false; info.CreateNoWindow = true;
        var child = Process.Start(info);
        File.WriteAllText(Path.Combine(directory, "child.pid"), child.Id.ToString());
        File.WriteAllText(Path.Combine(directory, "running.pid"), Process.GetCurrentProcess().Id.ToString());
        for (;;) Thread.Sleep(200);
    }
}
'@)
$probe = Join-Path $Root 'runtime\probe.exe'
$compiler = Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$null = Invoke-CodeyProcess $compiler @('/nologo', '/target:exe', "/out:$probe", $source)
$token = Join-Path $state 'github_token'
Write-CodeyFile $token 'persistent-fixture-credential'
$tokenBefore = (Get-FileHash -LiteralPath $token).Hash
Write-CodeyFile (Join-Path $state 'crash-once') 'fixture'
$configFile = Join-Path $Root 'runtime.json'
$config = [pscustomobject]@{
    schema = 2; kind = 'codey-windows-oneclick'; layout = 'npm-codey-package'; ready = $true
    ownerSid = $owner.Sid; ownerHome = $owner.Home; computer = $owner.Computer
    nodeId = 'n-' + [Guid]::NewGuid().ToString('N').Substring(0,24)
    runnerPath = Join-Path $supervisor 'windows-service.ps1'
    helperPath = Join-Path $supervisor 'windows-runtime.mjs'; helperHashes = $hashes
    runtimeRoot = Join-Path $Root 'runtime'; configRoot = $Root; stateRoot = $state
    taskHostExe = $hostExe; releaseDirectory = $Root; nodeExe = $probe; devtunnelExe = $probe
    powershellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    services = @{ codey = @{ executable = $probe
        arguments = @((Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'))
        workingDirectory = $Root; environment = @{ FIXTURE_STATE = $state } } }
}
Write-CodeyJson $configFile $config

# Real COM definitions with an in-memory folder: no registration API is called.
$script:scheduler = New-Object -ComObject Schedule.Service
$script:scheduler.Connect()
$script:definitions = [Collections.Generic.List[object]]::new()
function Get-CodeyTaskFolder {
    $folder = [pscustomobject]@{}
    $folder | Add-Member ScriptMethod GetTasks { param($flags); return @() }
    $folder | Add-Member ScriptMethod RegisterTaskDefinition {
        param($name,$definition,$flags,$owner,$password,$type,$sddl)
        $script:definitions.Add($definition)
        return [pscustomobject]@{ Definition = $definition }
    }
    return @{ Scheduler = $script:scheduler; Folder = $folder }
}
Install-CodeyTasks $config $configFile
Check ($definitions.Count -eq 3) 'exactly three task definitions'
foreach ($definition in $definitions) {
    $xml = [xml]$definition.XmlText
    Check ($xml.Task.Triggers.TimeTrigger.Repetition.Interval -eq 'PT1M') 'indefinite minute recovery'
    Check ($xml.Task.Settings.MultipleInstancesPolicy -eq 'IgnoreNew') 'recovery never duplicates a running task'
    Check ($xml.Task.Settings.RestartOnFailure.Interval -eq 'PT1M') 'scheduler also retries failures'
    Check ($xml.Task.Actions.Exec.Command -eq $hostExe) 'task launches GUI host not PowerShell'
}

$hostInfo = [Diagnostics.ProcessStartInfo]::new()
$hostInfo.FileName = $hostExe
$hostInfo.Arguments = Join-CodeyArguments @($configFile,'codey')
$hostInfo.WorkingDirectory = $supervisor
$owned = [CodeyBackgroundProcess]::new($hostInfo, $null, $null)
try {
    Wait-Until { Test-Path -LiteralPath (Join-Path $state 'running.pid') }
    $firstPid = [int](Get-Content -LiteralPath (Join-Path $state 'running.pid'))
    $grandchildPid = [int](Get-Content -LiteralPath (Join-Path $state 'child.pid'))
    Wait-Until { (Get-Content -LiteralPath (Join-Path $state 'codey.stdout.log') -Raw) -match 'TOKEN_FILE=persistent-fixture-credential' }
    $log = Get-Content -LiteralPath (Join-Path $state 'codey.stdout.log') -Raw
    Check ($log -match 'INTENTIONAL_FIXTURE_EXIT_17') 'crash log survives automatic restart'
    Check (($log -split 'CONSOLE=0').Count -ge 3 -and $log -notmatch 'CONSOLE=[1-9]') 'both service starts have no console'
    Check ((Get-Content -LiteralPath (Join-Path $state 'codey.stderr.log') -Raw) -match 'STDERR_CAPTURED') 'stderr streams while service runs'
    Check ((Get-FileHash -LiteralPath $token).Hash -eq $tokenBefore) 'restart reuses stored credential unchanged'
    # Kill only the exact fixture process obtained from its private pid file.
    [Diagnostics.Process]::GetProcessById($firstPid).Kill()
    Wait-Until { [int](Get-Content -LiteralPath (Join-Path $state 'running.pid')) -ne $firstPid }
    Wait-Until { -not (Get-Process -Id $grandchildPid -ErrorAction SilentlyContinue) }
    Check (-not (Get-Process -Id $grandchildPid -ErrorAction SilentlyContinue)) 'crashed service descendants are cleaned before restart'
    $lastPid = [int](Get-Content -LiteralPath (Join-Path $state 'running.pid'))
    $lastChild = [int](Get-Content -LiteralPath (Join-Path $state 'child.pid'))
    Check ((Read-CodeyJson (Join-Path $state 'codey.status.json')).state -eq 'running') 'watchdog publishes non-secret status'
} finally { $owned.Dispose() }
Wait-Until { -not (Get-Process -Id $lastPid,$lastChild -ErrorAction SilentlyContinue) }
Check (-not (Get-Process -Id $lastChild -ErrorAction SilentlyContinue)) 'stopping GUI host kills the complete fixture tree'
Check ((Get-FileHash -LiteralPath $token).Hash -eq $tokenBefore) 'stopping host preserves credentials'
Write-Output ('WATCHDOG_RESULT=' + (@{ passed = $checks } | ConvertTo-Json -Compress))
