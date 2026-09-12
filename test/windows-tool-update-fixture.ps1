# Portable semantic tests; native tasks, login, owner ACLs and process enumeration are mocked.
param([Parameter(Mandatory = $true)][string]$Root,
      [Parameter(Mandatory = $true)][string]$Source,
      [Parameter(Mandatory = $true)][string]$Library)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
foreach ($file in @($Library, $Source)) {
    $tokens = $null
    $errors = $null
    $ast = [Management.Automation.Language.Parser]::ParseFile($file, [ref]$tokens, [ref]$errors)
    if ($errors.Count) { throw ($errors | Out-String) }
    foreach ($definition in $ast.EndBlock.Statements | Where-Object { $_ -is [Management.Automation.Language.FunctionDefinitionAst] }) {
        . ([ScriptBlock]::Create($definition.Extent.Text))
    }
}
function Assert-Fixture($Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Fixture-Json($Value) { ConvertTo-Json -InputObject $Value -Depth 30 -Compress }
function Save-Fixture($File, $Value) {
    [IO.File]::WriteAllText($File, (Fixture-Json $Value), [Text.UTF8Encoding]::new($false))
}
function Write-CodeyFile($File, $Body) { [IO.File]::WriteAllText($File, $Body, [Text.UTF8Encoding]::new($false)) }
function Write-CodeyJson($File, $Value) { Save-Fixture $File $Value }
function Assert-HomePath($File, $OwnerHome) { return $File }
function Assert-CodeyPath($File, $OwnerHome) { return $File }
function Assert-ToolExternalTerminal { }

$script:configFile = Join-Path $Root 'runtime.json'
$script:owner = [pscustomobject]@{ Home = $Root; Sid = 'fixture' }
$runtime = Join-Path $Root 'runtime'
$job = Join-Path $runtime 'local-updates/job'
$payload = Join-Path $job 'payload'
$codexDirectory = Join-Path $runtime 'codex-bin'
foreach ($directory in @($runtime, $job, $payload, $codexDirectory)) { $null = [IO.Directory]::CreateDirectory($directory) }
$oldTunnel = Join-Path $runtime 'devtunnel.exe'
$newTunnel = Join-Path $payload 'devtunnel.exe'
$newCodex = Join-Path $payload 'codex.exe'
foreach ($file in @($oldTunnel, $newTunnel, $newCodex, (Join-Path $codexDirectory 'codex.exe'))) {
    [IO.File]::WriteAllText($file, ('fixture ' + $file))
}
[IO.File]::WriteAllText((Join-Path $payload 'companion.dll'), 'retained native companion')
$old = [pscustomobject]@{
    releaseId = 'retain-codey-release'; releaseDirectory = 'retain-original-tools-directory'; runtimeRoot = $runtime
    nodeId = 'n-fixture'; modelKey = 'retain-secret'; identityFile = 'retain-identity'; certificate = 'retain-certificate'
    nodeExe = 'retain-node'; codexHome = 'retain-codex-home'; codexExe = (Join-Path $codexDirectory 'codex.exe')
    devtunnelExe = $oldTunnel; runnerPath = 'retain-watchdog'; helperPath = 'retain-renew-helper'
    helperHashes = @{ fixture = 'retain-pinned-helper' }; codeyDirectory = 'retain-codey'; codeyBin = 'retain-codey-cli'
    services = [pscustomobject]@{
        codey = [pscustomobject]@{ executable = 'retain-node'; arguments = @('retain-codey-cli', 'start')
            workingDirectory = 'retain-codey'; environment = @{ CODEY_MODEL_API_KEY = 'retain-secret'
                CODEX_HOME = 'retain-codex-home'; CODEY_CODEX_EXECUTABLE = (Join-Path $codexDirectory 'codex.exe') } }
        tunnel = [pscustomobject]@{ executable = $oldTunnel; arguments = @('host', 'original.jpe', '--host-header', 'unchanged', '--origin-header', 'unchanged')
            workingDirectory = 'retain-original-tools-directory'; environment = @{ HOME = 'retain-login-home' } }
        renew = [pscustomobject]@{ executable = 'retain-node'; arguments = @('retain-renew-helper', 'renew', $script:configFile)
            environment = @{ HOME = 'retain-login-home' } }
    }
}
$request = [pscustomobject]@{ component = 'devtunnel'; candidate = $newTunnel; job = $job
    plan = @{ protected = [pscustomobject]@{}; entrySha256 = (Get-UpdateHash $oldTunnel) } }
$originalJson = Fixture-Json $old
$next = New-ToolRuntime $old $request
Assert-Fixture ((Fixture-Json $old) -ceq $originalJson) 'Input configuration was mutated.'
foreach ($property in $old.PSObject.Properties | Where-Object { $_.Name -notin @('devtunnelExe', 'services') }) {
    Assert-Fixture ((Fixture-Json $next.($property.Name)) -ceq (Fixture-Json $property.Value)) `
        ('Protected field changed: ' + $property.Name)
}
Assert-Fixture ($next.devtunnelExe -eq $newTunnel -and $next.services.tunnel.executable -eq $newTunnel) 'Tunnel does not use the new distribution.'
foreach ($name in @('codey', 'renew')) {
    Assert-Fixture ((Fixture-Json $old.services.$name) -ceq (Fixture-Json $next.services.$name)) 'Another service was modified.'
}
Assert-Fixture ((Fixture-Json $old.services.tunnel.arguments) -ceq (Fixture-Json $next.services.tunnel.arguments)) 'Tunnel ID/options changed.'
Assert-Fixture ((Fixture-Json $old.services.tunnel.environment) -ceq (Fixture-Json $next.services.tunnel.environment)) 'Tunnel login environment changed.'
Assert-Fixture ($next.services.tunnel.workingDirectory -eq $old.services.tunnel.workingDirectory) 'Unrelated original release changed.'
Assert-Fixture ((Get-ToolTaskComponents 'devtunnel') -join ',' -eq 'tunnel') 'Renewal task could be killed during a token request.'
Assert-Fixture ((Get-ToolTaskComponents 'codex') -join ',' -eq 'codey') 'Codex update touches unrelated tasks.'
$codexRequest = [pscustomobject]@{ component = 'codex'; candidate = $newCodex; job = $job; plan = @{} }
Assert-Fixture ((Fixture-Json (New-ToolRuntime $old $codexRequest)) -ceq $originalJson) 'Codex alias upgrade rewrites configuration.'
$unsafe = $old | ConvertTo-Json -Depth 30 | ConvertFrom-Json
$unsafe.services.renew.arguments[1] = 'setup'
$blocked = $false
try { $null = New-ToolRuntime $unsafe $request } catch { $blocked = $_.Exception.Message -match 'Unknown tunnel/renewal' }
Assert-Fixture $blocked 'Unexpected renewal helper could invoke setup.'

$script:actions = [Collections.Generic.List[string]]::new()
function Stop-ToolScope($Config, $Component) { $script:actions.Add('stop ' + $Component) }
function Set-CodeyTaskState($Config, $ConfigPath, [string[]]$Components, [switch]$Start) {
    Assert-Fixture ($Start -and $Components.Count -eq 1 -and $Components[0] -eq 'tunnel') 'Unexpected rollback service action.'
    $script:actions.Add('start tunnel')
}
function Wait-ToolHealth($Config, $Request, $Job, [switch]$Rollback) {
    Assert-Fixture ($Rollback -and $Config.devtunnelExe -eq $oldTunnel) 'Rollback did not verify the original executable.'
}
$beforeFile = Join-Path $job 'runtime-before.json'
$afterFile = Join-Path $job 'runtime-after.json'
Save-Fixture $beforeFile $old
Save-Fixture $afterFile $next
Save-Fixture $configFile $next
$journal = [pscustomobject]@{ request = $request; state = 'applying'
    beforeHash = (Get-UpdateHash $beforeFile); afterHash = (Get-UpdateHash $afterFile) }
$data = Join-Path $Root 'user-database'
[IO.File]::WriteAllText($data, 'fresh user data')
Restore-ToolUpdate $journal $job
Assert-Fixture ($journal.state -eq 'rolled_back') 'Rollback journal was not completed.'
Assert-Fixture ((Get-UpdateHash $configFile) -eq $journal.beforeHash) 'Original descriptor was not restored byte-for-byte.'
Assert-Fixture (($actions -join ',') -eq 'stop devtunnel,start tunnel') 'Rollback touches unrelated tasks.'
Assert-Fixture (([IO.File]::ReadAllText($data)) -eq 'fresh user data') 'Stale data was restored.'
$actions.Clear()
$foreign = $next | ConvertTo-Json -Depth 30 | ConvertFrom-Json
$foreign.modelKey = 'new-secret-from-another-operation'
Save-Fixture $configFile $foreign
$blocked = $false
try { Restore-ToolUpdate $journal $job } catch { $blocked = $_.Exception.Message -match 'Concurrent runtime' }
Assert-Fixture ($blocked -and $actions.Count -eq 0) 'A concurrent descriptor was modified.'

# Real private directory moves; only junction creation/path discovery are emulated on non-Windows.
function Get-ManagedCodexPath($Config) {
    $anchor = Join-Path $Config.runtimeRoot 'codex-bin'
    $item = Get-Item -LiteralPath $anchor -Force
    $linked = [bool]($item.Attributes -band [IO.FileAttributes]::ReparsePoint)
    $resolved = if ($linked) { $newCodex } else { Join-Path $anchor 'codex.exe' }
    [pscustomobject]@{ anchor = $anchor; resolved = $resolved; target = (Split-Path -Parent $resolved)
        entrySha256 = Get-UpdateHash $resolved; anchorKind = $(if ($linked) { 'junction' } else { 'directory' }) }
}
function New-Item([string]$ItemType, [string]$Path, [string]$Target) {
    Assert-Fixture ($ItemType -eq 'Junction' -and $Target -eq $payload) 'Unexpected pointer target.'
    $kind = if ($env:OS -eq 'Windows_NT') { 'Junction' } else { 'SymbolicLink' }
    Microsoft.PowerShell.Management\New-Item -ItemType $kind -Path $Path -Target $Target
}
function Invoke-CodeyProcess($Executable, $Arguments, $TimeoutSeconds) {
    Assert-Fixture ($Arguments[0] -eq '-p' -and $Arguments[1] -match 'realpathSync') 'Unexpected command during pointer recovery.'
    [pscustomobject]@{ Stdout = $Arguments[2] }
}
$codexRequest.plan.tool = Get-ManagedCodexPath $old
Switch-CodexPointer $old $codexRequest $job
Assert-Fixture (Test-Path -LiteralPath (Join-Path $job 'previous-codex/codex.exe')) 'Original distribution was not retained.'
Assert-Fixture ((Get-Item -LiteralPath $codexDirectory -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) 'Stable alias was not switched.'
Restore-CodexPointer $old $codexRequest $job -CheckOnly
Assert-Fixture ((Get-Item -LiteralPath $codexDirectory -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) 'Preflight changed the alias.'
Restore-CodexPointer $old $codexRequest $job
Assert-Fixture ((Get-UpdateHash $old.codexExe) -eq $codexRequest.plan.tool.entrySha256) 'Old CLI was not restored.'
Assert-Fixture (([IO.File]::ReadAllText((Join-Path $payload 'companion.dll'))) -eq 'retained native companion') 'Rollback deleted a version store.'
# Crash in the gap after Directory.Move, before a new junction exists.
[IO.Directory]::Move($codexDirectory, (Join-Path $job 'previous-codex'))
Restore-CodexPointer $old $codexRequest $job
Assert-Fixture (Test-Path -LiteralPath $old.codexExe) 'The interrupted pointer gap could not be recovered.'

Write-Output '{"passed":true,"nativeServices":false,"models":false,"checks":25}'
