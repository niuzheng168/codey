# Native launcher tests; all persistent user-PATH operations are mocked.
param([string]$Root, [string]$NodeExe)
$ErrorActionPreference = 'Stop'
. (Join-Path $Root 'package\scripts\install.ps1')
$script:Count = 0
function Check($condition, $name) {
    if (-not $condition) { throw "Assertion failed: $name" }
    $script:Count++
}
$script:UserPath = 'C:\existing-tools;%USERPROFILE%\bin'
$script:PathWrites = 0
function Get-CodeyUserPath { $script:UserPath }
function Set-CodeyUserPath($Value, $Expected) {
    if ($Expected -cne $script:UserPath) { throw 'Concurrent PATH edit' }
    $script:UserPath = $Value
    $script:PathWrites++
}

$owner = Get-CodeyOwner
$runtime = Join-Path $Root "owner's runtime"
$configRoot = Join-Path $Root "owner's config"
New-CodeyDirectory $runtime
New-CodeyDirectory $configRoot
$supervisor = Join-Path $runtime 'supervisor'
New-CodeyDirectory $supervisor
foreach ($name in @('windows-common.ps1', 'windows-process.cs')) {
    Copy-Item -LiteralPath (Join-Path $Root "package\scripts\$name") -Destination (Join-Path $supervisor $name)
}
$nodeDirectory = Join-Path $runtime 'pinned-node'
New-CodeyDirectory $nodeDirectory
$node = Join-Path $nodeDirectory 'node.exe'
Copy-Item -LiteralPath $NodeExe -Destination $node
$app = Join-Path $runtime 'releases\first\app'
New-CodeyDirectory (Join-Path $app 'bin')
$entry = Join-Path $app 'bin\codey.mjs'
Write-CodeyFile $entry @'
if (process.argv[2] === "--version") console.log("codey fixture-one");
else if (process.argv[2] === "fail") process.exitCode = 37;
else console.log(JSON.stringify({
  args: process.argv.slice(2), home: process.env.COPILOT_API_HOME,
  key: process.env.CODEY_COMMAND_FIXTURE, execPath: process.execPath,
  pathFirst: process.env.PATH.split(";")[0]
}));
'@
$config = @{
    schema = 2; kind = 'codey-windows-oneclick'; layout = 'npm-codey-package'; ready = $true
    ownerSid = $owner.Sid; ownerHome = $owner.Home; computer = $owner.Computer
    runtimeRoot = $runtime; configRoot = $configRoot
    nodeExe = $node; codeyBin = $entry; codeyDirectory = $app
    services = @{ codey = @{ environment = @{
        COPILOT_API_HOME = Join-Path $runtime 'gateway-home'
        CODEY_COMMAND_FIXTURE = 'child-only-fixture'
    } } }
}
$configPath = Join-Path $configRoot 'runtime.json'
Write-CodeyJson $configPath $config
Install-CodeyCommand ([pscustomobject]$config) $configPath
$bin = Join-Path $runtime 'bin'
$launcher = Join-Path $bin 'codey.ps1'
Check ((Get-Command codey).Source -eq $launcher) 'current PowerShell discovers the stable command through PATH'
Check ($script:UserPath -ceq "C:\existing-tools;%USERPROFILE%\bin;$bin") 'original PATH values are preserved'
Check ($script:PathWrites -eq 1) 'one persistent PATH update'
$before = [IO.File]::ReadAllText($launcher)
Check (-not $before.Contains('child-only-fixture')) 'launcher never embeds runtime secrets'
Install-CodeyCommand ([pscustomobject]$config) $configPath
Check ($script:PathWrites -eq 1) 'repeat registration does not duplicate PATH'
Check ([IO.File]::ReadAllText($launcher) -ceq $before) 'repeat registration is deterministic'
Check ((Add-CodeyPathEntry ($bin.ToUpperInvariant() + '\') $bin) -ceq ($bin.ToUpperInvariant() + '\')) 'case and trailing separator compare equivalently'
$env:CODEY_PATH_FIXTURE = $bin
Check ((Add-CodeyPathEntry '%CODEY_PATH_FIXTURE%' $bin) -ceq '%CODEY_PATH_FIXTURE%') 'expanded PATH entries do not create duplicates'
Check ((Add-CodeyPathEntry '' $bin) -ceq $bin) 'empty PATH has no relative empty entry'
Check ((Add-CodeyPathEntry 'C:\other;' $bin) -ceq "C:\other;$bin") 'trailing separator does not create another empty entry'

# A fresh -NoProfile shell receives only PATH, not any function definition.
$shell = (Get-Process -Id $PID).Path
function Run-Codey([string[]]$Values) {
    $literal = (@($Values | ForEach-Object { "'" + $_.Replace("'", "''") + "'" }) -join ',')
    $text = '$forward = @(' + $literal + '); codey @forward; exit $LASTEXITCODE'
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($text))
    Invoke-CodeyProcess $shell @('-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', $encoded) `
        -TimeoutSeconds 25 -AllowFailure
}
$version = Run-Codey @('--version')
Check ($version.ExitCode -eq 0 -and $version.Stdout.Trim() -eq 'codey fixture-one') ("fresh PowerShell invokes codey without global Node or a profile: " + $version.Stdout + $version.Stderr)
$env:CODEY_COMMAND_FIXTURE = 'parent-fixture'
$values = @('gateway', 'start', '--port', '4141', 'a"b', '', "space's & value", 'C:\trailing\',
    ('unicode-' + [char]0x4e2d + [char]0x6587))
$result = Run-Codey $values
Check ($result.ExitCode -eq 0) 'native launcher succeeds'
$observed = $result.Stdout | ConvertFrom-Json
Check (($observed.args | ConvertTo-Json -Compress) -ceq ($values | ConvertTo-Json -Compress)) ("all arguments survive native Windows quoting: " + ($observed.args | ConvertTo-Json -Compress))
Check ($observed.execPath -eq $node -and $observed.pathFirst -eq $nodeDirectory) 'pinned Node is used and propagated to child tools'
Check ($observed.home -eq $config.services.codey.environment.COPILOT_API_HOME) 'managed gateway login directory is reused'
Check ($observed.key -eq 'child-only-fixture' -and $env:CODEY_COMMAND_FIXTURE -eq 'parent-fixture') 'runtime environment does not leak back into the caller'
Check ((Run-Codey @('fail')).ExitCode -eq 37) 'CLI exit code propagates to callers'

# Changing the active runtime switches the same stable command without changing PATH.
$second = Join-Path $runtime 'releases\second\app'
New-CodeyDirectory (Join-Path $second 'bin')
$config.codeyDirectory = $second
$config.codeyBin = Join-Path $second 'bin\codey.mjs'
Write-CodeyFile $config.codeyBin "console.log('codey fixture-two')"
Write-CodeyJson $configPath $config
$version = Run-Codey @('--version')
Check ($version.ExitCode -eq 0 -and $version.Stdout.Trim() -eq 'codey fixture-two') 'command follows runtime.json after an upgrade'
Check ([IO.File]::ReadAllText($launcher) -ceq $before -and $script:PathWrites -eq 1) 'upgrade does not modify the stable command or PATH'
$config.ready = $false
Write-CodeyJson $configPath $config
$rejected = Run-Codey @('--version')
Check ($rejected.ExitCode -ne 0 -and -not $rejected.Stdout.Contains('fixture-two')) 'failed installations cannot be launched'
$config.ready = $true
$config.ownerSid = 'S-1-5-18'
Write-CodeyJson $configPath $config
Check ((Run-Codey @('--version')).ExitCode -ne 0) 'other-owner runtime is rejected'

Write-CodeyFile $launcher '# unrelated owner command'
$denied = $false
try { Install-CodeyCommand ([pscustomobject]$config) $configPath } catch { $denied = $true }
Check ($denied -and [IO.File]::ReadAllText($launcher) -eq '# unrelated owner command') 'unmanaged command is not overwritten'
Write-Output ('COMMAND_RESULT=' + (@{ passed = $script:Count } | ConvertTo-Json -Compress))
