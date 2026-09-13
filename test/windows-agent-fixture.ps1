param([string]$Root, [string]$Source)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
function Check($Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
foreach ($name in @('native.ps1', 'install.ps1')) {
    $tokens = $null; $errors = $null
    $ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $Source $name), [ref]$tokens, [ref]$errors)
    Check (-not $errors.Count) ($errors | Out-String)
    foreach ($definition in $ast.EndBlock.Statements | Where-Object { $_ -is [Management.Automation.Language.FunctionDefinitionAst] }) {
        # AST-created script blocks have no source-file PSScriptRoot.
        $body = $definition.Extent.Text.Replace('$PSScriptRoot', ("'" + $Source.Replace("'", "''") + "'"))
        . ([scriptblock]::Create($body))
    }
}
# Compile managed declarations only. No Windows Job Object or executable is run.
Add-Type -Path @((Join-Path $Source 'host.cs'), (Join-Path $Source 'process-tree.cs'))
Check ([bool]('CodeyUpdaterHost' -as [type])) 'Host did not compile.'
$environmentBefore = @{}
foreach ($name in @('COMPUTERNAME', 'NODE_OPTIONS', 'CODEY_MODEL_API_KEY', 'PSModulePath')) {
    $environmentBefore[$name] = [Environment]::GetEnvironmentVariable($name)
}
try {
    [Environment]::SetEnvironmentVariable('COMPUTERNAME', 'Codey-Fixture-PC')
    foreach ($name in @('NODE_OPTIONS', 'CODEY_MODEL_API_KEY', 'PSModulePath')) {
        [Environment]::SetEnvironmentVariable($name, 'must-not-reach-agent')
    }
    $factory = [CodeyUpdaterHost].GetMethod('CreateStartInfo', [Reflection.BindingFlags]'NonPublic,Static')
    $startInfo = $factory.Invoke($null, @('C:\original\node.exe', 'C:\private-agent',
        'C:\owner\.config\codey-updater\config.json', 'C:\owner', 'fixture-nonce'))
    Check ($startInfo.EnvironmentVariables['COMPUTERNAME'] -ceq 'Codey-Fixture-PC') `
        'Background agent lost the machine identity needed by Initialize-LocalWindows.'
    foreach ($name in @('NODE_OPTIONS', 'CODEY_MODEL_API_KEY', 'PSModulePath')) {
        Check (-not $startInfo.EnvironmentVariables.ContainsKey($name)) 'Host leaked a forbidden environment variable.'
    }
    Check ($startInfo.EnvironmentVariables['HOME'] -eq 'C:\owner' -and
        $startInfo.EnvironmentVariables['CODEY_UPDATER_HOST_TOKEN'] -eq 'fixture-nonce' -and
        $startInfo.FileName -eq 'C:\original\node.exe' -and $startInfo.WorkingDirectory -eq 'C:\private-agent') `
        'Host changed the original Node, owner home, agent directory or lifetime binding.'
} finally {
    foreach ($name in $environmentBefore.Keys) {
        [Environment]::SetEnvironmentVariable($name, $environmentBefore[$name])
    }
}
function Require-Update($Value, [string]$Message) { Check $Value $Message }
function Read-UpdateJson($File) { Get-Content -LiteralPath $File -Raw | ConvertFrom-Json }
function Write-CodeyJson($File, $Value) { $Value | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $File }
function Get-UpdateHash($File) { return 'same' }
$script:actions = [Collections.Generic.List[string]]::new()
$script:busy = $false
function Assert-AgentProtected($Value) { $script:actions.Add('protected') }
function Wait-UpdatedCodey($Config, $Job, $Version) { $script:actions.Add('health') }
function Restore-LocalUpdate($Journal, $Job) { $script:actions.Add('rollback'); $Journal.state = 'rolled_back' }
function Assert-ExternalUpdate { if ($script:busy) { throw 'busy' }; $script:actions.Add('idle-processes') }
function Invoke-UpdateProbe($Config, $Job, $Mode) { $script:actions.Add('idle-codey') }
function Assert-ModelIdle { $script:actions.Add('idle-model') }
$script:task = [pscustomobject]@{ Enabled = $true; State = 4 }
$script:config = [pscustomobject]@{ nodeId = 'n-fixture'; nodeExe = 'C:\original\node.exe' }
$script:configFile = Join-Path $Root 'runtime.json'
$request = [pscustomobject]@{ version = '0.1.5'; digest = 'reviewed-digest'; jobId = 'fixture-job'
    plan = @{ protected = @{}; configHash = 'same' } }
$journal = [pscustomobject]@{ state = 'applying'; changed = $true; request = $request; afterHash = 'same' }
$result = Recover-AgentTransaction $journal $Root
Check ($result.state -eq 'rolled_back' -and $script:actions.Contains('rollback')) 'Interrupted switch was not recovered.'
$script:actions.Clear()
$journal.state = 'applying'; $script:busy = $true
$refused = $false
try { $null = Recover-AgentTransaction $journal $Root } catch { $refused = $_.Exception.Message -eq 'busy' }
Check ($refused -and -not $script:actions.Contains('rollback')) 'Recovery interrupted fresh user work.'
$script:busy = $false
$journal.changed = $false
$result = Recover-AgentTransaction $journal $Root
Check ($result.state -eq 'aborted' -and -not $script:actions.Contains('rollback')) 'Verification-only recovery restarted Codey.'
$journal.state = 'complete'
Write-CodeyJson (Join-Path $Root 'model-proof.json') @{ passed = $true; digest = 'reviewed-digest'; jobId = 'fixture-job'
    codeyModel = $true; codexModel = $true; syntheticSessionArchived = $true }
$script:actions.Clear()
$result = Recover-AgentTransaction $journal $Root
Check ($result.state -eq 'complete' -and -not $script:actions.Contains('rollback')) 'Completed verification was repeated/rolled back.'
Write-CodeyJson (Join-Path $Root 'model-proof.json') @{ passed = $false; digest = 'reviewed-digest'; jobId = 'fixture-job'
    codeyModel = $false; codexModel = $false; syntheticSessionArchived = $false }
$refused = $false
try { $null = Recover-AgentTransaction $journal $Root } catch { $refused = $true }
Check $refused 'Missing model proof was accepted.'

$request | Add-Member NoteProperty acceptance 'authenticated-health-v1'
$request | Add-Member NoteProperty entrySha256 ('a' * 64)
$request | Add-Member NoteProperty release ([pscustomobject]@{ components = [pscustomobject]@{
    codey = [pscustomobject]@{ version = $request.version; entrySha256 = $request.entrySha256 } } })
$health = @{ schema = 1; acceptance = $request.acceptance; passed = $true; healthy = $true; authenticated = $true
    modelRequests = $false; digest = $request.digest; jobId = $request.jobId
    version = $request.version; entrySha256 = $request.entrySha256; checkedAt = 1000 }
Write-CodeyJson (Join-Path $Root 'health-proof.json') $health
$script:actions.Clear()
$result = Recover-AgentTransaction $journal $Root
Check ($result.state -eq 'complete' -and -not $script:actions.Contains('rollback')) 'Completed health acceptance was repeated.'
foreach ($field in @('passed', 'healthy', 'authenticated', 'modelRequests', 'digest', 'jobId', 'version', 'entrySha256', 'checkedAt')) {
    $bad = $health.Clone()
    $bad[$field] = if ($field -in @('passed', 'healthy', 'authenticated')) { $false } `
        elseif ($field -eq 'modelRequests') { $true } elseif ($field -eq 'checkedAt') { 0 } else { 'wrong' }
    Write-CodeyJson (Join-Path $Root 'health-proof.json') $bad
    $refused = $false
    try { $null = Recover-AgentTransaction $journal $Root } catch { $refused = $true }
    Check $refused ("Invalid health proof accepted: " + $field)
}
$journal.state = 'rolled_back'
$result = Recover-AgentTransaction $journal $Root
Check ($result.state -eq 'rolled_back') 'A historical rollback was changed to success.'

$script:owner = [pscustomobject]@{ Home = $Root; Sid = 'S-1-5-21-fixture' }
$script:acceptanceExit = 0
$script:acceptanceCode = ''
function Invoke-CodeyProcess {
    param($Executable, $ArgumentList, $WorkingDirectory, $TimeoutSeconds, [switch]$AllowFailure)
    Check ($AllowFailure -and (Split-Path -Leaf $ArgumentList[0]) -eq 'verify.mjs' -and
        $ArgumentList.Count -eq 2) 'Acceptance attempted an unexpected executable or inference command.'
    $output = if ($script:acceptanceExit -eq 0) { $health } else { @{ passed = $false; code = $script:acceptanceCode } }
    return [pscustomobject]@{ ExitCode = $script:acceptanceExit; Stdout = ($output | ConvertTo-Json -Compress) }
}
Invoke-AgentAcceptance (Join-Path $Root 'request.json') $request
$script:acceptanceExit = 1
foreach ($expectedCode in @('health_failed', 'signature_invalid', 'configuration_changed', 'lease_lost')) {
    $script:acceptanceCode = $expectedCode
    $actualCode = ''
    try { Invoke-AgentAcceptance (Join-Path $Root 'request.json') $request }
    catch { $actualCode = Get-AgentFailureCode $_ }
    Check ($actualCode -eq $expectedCode) 'Acceptance failure was disguised as a different category.'
}

# Mock only COM scheduling, not its security assertions.
$script:owner = [pscustomobject]@{ Sid = 'S-1-5-21-fixture' }
$script:agentFile = 'C:\owner\.config\codey-updater\config.json'
$script:taskName = 'Codey Node Updater n-fixture'
$script:definition = [pscustomobject]@{
    RegistrationInfo = [pscustomobject]@{ Description = '' }
    Principal = [pscustomobject]@{ UserId = ''; LogonType = 0; RunLevel = 1 }
    Triggers = [Collections.Generic.List[object]]::new()
    Settings = [pscustomobject]@{ Hidden = $false; Enabled = $false; MultipleInstances = 0; ExecutionTimeLimit = ''
        DisallowStartIfOnBatteries = $true; StopIfGoingOnBatteries = $true; StartWhenAvailable = $false
        RestartInterval = ''; RestartCount = 0 }
    Actions = [Collections.Generic.List[object]]::new()
    XmlText = '<Task><Principals><Principal><UserId>S-1-5-21-fixture</UserId></Principal></Principals></Task>'
}
Add-Member -InputObject $script:definition.Triggers -MemberType ScriptMethod -Name Create -Value {
    param($Type)
    $item = [pscustomobject]@{ Type = $Type; UserId = ''; Delay = ''; StartBoundary = ''
        Repetition = [pscustomobject]@{ Interval = '' } }
    $this.Add($item); return $item
}
Add-Member -InputObject $script:definition.Actions -MemberType ScriptMethod -Name Create -Value {
    param($Type)
    $item = [pscustomobject]@{ Path = ''; Arguments = ''; WorkingDirectory = '' }
    $this.Add($item); return $item
}
$scheduler = [pscustomobject]@{}
$scheduler | Add-Member -MemberType ScriptMethod -Name NewTask -Value { param($Flag) return $script:definition }
$folder = [pscustomobject]@{}
$folder | Add-Member -MemberType ScriptMethod -Name RegisterTaskDefinition -Value {
    param($Name, $Definition, $Flags, $User, $Password, $Logon, $Sddl)
    Check ($Name -eq $script:taskName -and $Flags -eq 6 -and $User -eq $script:owner.Sid -and
        $null -eq $Password -and $Logon -eq 3) 'Task registration escaped the original owner.'
    return [pscustomobject]@{ Definition = $Definition }
}
$script:scheduler = @{ Scheduler = $scheduler; Folder = $folder }
function Get-CodeyTaskFolder { return $script:scheduler }
function Join-CodeyArguments($Values) { return ($Values -join '|') }
$binding = [pscustomobject]@{ host = 'C:\private-agent\updater.exe'; directory = 'C:\private-agent' }
$registered = Register-UpdaterTask $binding
Assert-UpdaterTask $registered $binding
Check ($script:definition.Settings.Hidden -and $script:definition.Settings.MultipleInstances -eq 2 -and
    $script:definition.Settings.ExecutionTimeLimit -eq 'PT0S' -and $script:definition.Principal.RunLevel -eq 0) `
    'Updater task was interactive/elevated, finite or allowed duplicate instances.'
$script:definition.Actions[0].Path = 'C:\unrelated.exe'
$refused = $false
try { Assert-UpdaterTask $registered $binding } catch { $refused = $true }
Check $refused 'Unrelated task was adopted.'
$script:otherTask = [pscustomobject]@{ Definition = [pscustomobject]@{ XmlText = '<Task>unchanged</Task>' }
    Enabled = $true; LastRunTime = [DateTime]::Now; InstanceGuid = 'same-running-host' }
$script:otherTask | Add-Member ScriptMethod GetInstances { param($Flags)
    return [pscustomobject]@{ InstanceGuid = $this.InstanceGuid }
}
$folder | Add-Member ScriptMethod GetTask { param($Name) return $script:otherTask }
function Assert-CodeyTask { param($Task, $Config, $File, $Name) }
$baseline = Get-OtherAgentTasks | ConvertTo-Json -Depth 8 -Compress
$script:otherTask.LastRunTime = $script:otherTask.LastRunTime.AddMinutes(1)
Check ((Get-OtherAgentTasks | ConvertTo-Json -Depth 8 -Compress) -eq $baseline) 'Retry trigger looked like a service restart.'
$script:otherTask.InstanceGuid = 'new-host'
Check ((Get-OtherAgentTasks | ConvertTo-Json -Depth 8 -Compress) -ne $baseline) 'Actual host restart was ignored.'
$script:otherTask.InstanceGuid = 'same-running-host'
$script:otherTask.Definition.XmlText = '<Task>changed</Task>'
Check ((Get-OtherAgentTasks | ConvertTo-Json -Depth 8 -Compress) -ne $baseline) 'Changed task definition was ignored.'
@{ passed = $true; nativeServices = $false; modelCalls = 0; hostCompiled = $true; hostEnvironmentVerified = $true } | ConvertTo-Json -Compress
