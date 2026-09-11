# Portable PowerShell tests. Import functions from the AST, never execute the native adapter's main block.
param([Parameter(Mandatory = $true)][string]$Root,
      [Parameter(Mandatory = $true)][string]$Source)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$tokens = $null
$errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($Source, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
foreach ($definition in $ast.EndBlock.Statements | Where-Object { $_ -is [Management.Automation.Language.FunctionDefinitionAst] }) {
    . ([ScriptBlock]::Create($definition.Extent.Text))
}
function Assert-Fixture($Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Fixture-Json($Value) { ConvertTo-Json -InputObject $Value -Depth 30 -Compress }
function Save-Fixture($File, $Value) {
    [IO.File]::WriteAllText($File, (Fixture-Json $Value), [Text.UTF8Encoding]::new($false))
}

$oldRoot = Join-Path $Root 'old package'
$candidate = Join-Path $Root 'new package'
$job = Join-Path $Root 'job'
foreach ($directory in @($oldRoot, $candidate, $job)) { $null = [IO.Directory]::CreateDirectory($directory) }
Save-Fixture (Join-Path $oldRoot 'package.json') @{ name = 'codey'; version = '1.0.0' }
$old = [pscustomobject]@{
    releaseId = 'old-release'; releaseDirectory = (Join-Path $Root 'original-tools-release')
    nodeId = 'n-fixture'; ready = $true; modelKey = 'retain-secret'; identityFile = 'retain-identity'
    nodeExe = 'retain-node'; codexExe = 'retain-codex'; devtunnelExe = 'retain-devtunnel'
    runnerPath = 'retain-supervisor'; helperHashes = @{ fixture = 'retain-helper-hash' }
    codeyDirectory = $oldRoot; codeyBin = (Join-Path $oldRoot 'bin/codey.mjs')
    npmPackage = 'codey-1.0.0.tgz'; npmPackageSha256 = ('a' * 64)
    services = [pscustomobject]@{
        codey = [pscustomobject]@{ executable = 'retain-node'; arguments = @((Join-Path $oldRoot 'bin/codey.mjs'), 'start')
            workingDirectory = $oldRoot; environment = @{ CODEY_MODEL_API_KEY = 'retain-secret'; CODEX_HOME = 'retain-codex-home' } }
        tunnel = @{ executable = 'retain-devtunnel'; arguments = @('host', 'retain-tunnel'); environment = @{ PATH = 'retain-path' } }
        renew = @{ executable = 'retain-node'; arguments = @('retain-helper', 'renew'); environment = @{ HOME = 'retain-home' } }
    }
}
$request = [pscustomobject]@{
    candidate = $candidate; entrySha256 = ('b' * 64); sha256 = ('c' * 64)
    packageName = 'codey-2.0.0.tgz'; job = $job; plan = @{ services = @('codey') }
}
$originalJson = Fixture-Json $old
$next = New-UpdatedCodeyRuntime $old $request
Assert-Fixture ((Fixture-Json $old) -ceq $originalJson) 'Input configuration was mutated'
foreach ($property in $old.PSObject.Properties | Where-Object {
    $_.Name -notin @('codeyDirectory', 'codeyBin', 'releaseId', 'npmPackage', 'npmPackageSha256', 'services')
}) {
    Assert-Fixture ((Fixture-Json $next.($property.Name)) -ceq (Fixture-Json $property.Value)) `
        ('Protected field changed: ' + $property.Name)
}
Assert-Fixture ((Fixture-Json $old.services.tunnel) -ceq (Fixture-Json $next.services.tunnel)) 'Tunnel service changed'
Assert-Fixture ((Fixture-Json $old.services.renew) -ceq (Fixture-Json $next.services.renew)) 'Renewal service changed'
Assert-Fixture ((Fixture-Json $old.services.codey.environment) -ceq (Fixture-Json $next.services.codey.environment)) 'Codey environment changed'
Assert-Fixture ($next.services.codey.executable -eq $old.services.codey.executable) 'Node was replaced'
Assert-Fixture ($next.services.codey.arguments[0] -eq $next.codeyBin) 'Service does not use the new package'
Assert-Fixture ($next.services.codey.workingDirectory -eq $candidate) 'Working directory was not switched'
Assert-Fixture ($next.releaseDirectory -eq $old.releaseDirectory) 'Unrelated watchdogs would see a changed tools release'
$unsafe = $old | ConvertTo-Json -Depth 30 | ConvertFrom-Json
$unsafe.services.codey.arguments[1] = 'setup'
$blocked = $false
try { $null = New-UpdatedCodeyRuntime $unsafe $request } catch { $blocked = $_.Exception.Message -match 'never setup' }
Assert-Fixture $blocked 'An unexpected task could invoke setup during restart'

$script:actions = [Collections.Generic.List[string]]::new()
function Set-CodeyTaskState($Config, $ConfigPath, [string[]]$Components, [switch]$Start) {
    Assert-Fixture ($Components.Count -eq 1 -and $Components[0] -eq 'codey') 'Attempted to control another task'
    $script:actions.Add($(if ($Start) { 'start codey' } else { 'stop codey' }))
}
function Wait-CodeyStopped { }
function Wait-UpdatedCodey($Config, $Job, $Version) {
    Assert-Fixture ($Version -eq '1.0.0') 'Rollback did not verify the original package'
}
function Write-CodeyFile($File, $Body) { [IO.File]::WriteAllText($File, $Body, [Text.UTF8Encoding]::new($false)) }
function Write-CodeyJson($File, $Value) { Save-Fixture $File $Value }
$script:configFile = Join-Path $Root 'runtime.json'
$beforeFile = Join-Path $job 'runtime-before.json'
$afterFile = Join-Path $job 'runtime-after.json'
Save-Fixture $beforeFile $old
Save-Fixture $afterFile $next
Save-Fixture $configFile $next
$journal = [pscustomobject]@{
    state = 'applying'; request = $request
    beforeHash = (Get-UpdateHash $beforeFile); afterHash = (Get-UpdateHash $afterFile)
}
$data = Join-Path $Root 'user-database'
[IO.File]::WriteAllText($data, 'new user data, not a stale backup')
Restore-LocalUpdate $journal $job
Assert-Fixture ((Get-UpdateHash $configFile) -eq $journal.beforeHash) 'Original descriptor was not restored byte-for-byte'
Assert-Fixture (($actions -join ',') -eq 'stop codey,start codey') 'Wrong rollback task scope'
Assert-Fixture (([IO.File]::ReadAllText($data)) -eq 'new user data, not a stale backup') 'User data was overwritten'
Assert-Fixture ($journal.state -eq 'rolled_back') 'Rollback journal was not completed'

$actions.Clear()
$foreign = $next | ConvertTo-Json -Depth 30 | ConvertFrom-Json
$foreign | Add-Member NoteProperty anotherDeployment $true
Save-Fixture $configFile $foreign
$foreignHash = Get-UpdateHash $configFile
$blocked = $false
try { Restore-LocalUpdate $journal $job } catch {
    $blocked = $_.Exception.Message -match 'Concurrent runtime change'
}
Assert-Fixture $blocked 'Concurrent deployment was not protected'
Assert-Fixture ((Get-UpdateHash $configFile) -eq $foreignHash -and $actions.Count -eq 0) 'Concurrent deployment was modified'

$script:owner = [pscustomobject]@{ Sid = 'fixture-owner' }
function Get-CodeyProcesses($OwnerSid) {
    @([pscustomobject]@{ ProcessId = $PID; ParentProcessId = 200; Name = 'powershell.exe'; CommandLine = 'fixture' },
      [pscustomobject]@{ ProcessId = 200; ParentProcessId = 1; Name = 'node.exe'
          CommandLine = '"node.exe" "C:\fixture\bin\codey.mjs" start' })
}
$blocked = $false
try { Assert-ExternalUpdate } catch { $blocked = $_.Exception.Message -match 'separate owner terminal' }
Assert-Fixture $blocked 'A Workspace-hosted updater could kill itself during the switch'

Write-Output '{"passed":true,"nativeServices":false,"models":false,"checks":17}'
