# Native PowerShell semantics test: all scheduler/process/ACL operations are fakes.
param([string]$Controller, [string]$ConfigPath, [string]$Case)
$ErrorActionPreference = 'Stop'
$global:FixtureConfig = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
$global:FixtureCase = $Case
$global:FixtureCalls = [Collections.Generic.List[string]]::new()
$global:FixtureTasks = @{}
foreach ($component in @('workspace', 'data', 'tunnel', 'renew')) {
    $arguments = '-X utf8 -I -B "' + $global:FixtureConfig.runnerPath + '" --config "' +
        $ConfigPath + '" --component ' + $component
    $task = [pscustomobject]@{
        Component = $component
        State = $(if ($component -eq 'renew') { 3 } else { 4 })
        Definition = [pscustomobject]@{
            RegistrationInfo = [pscustomobject]@{
                Description = "codey-windows-tunnel-v1:$($global:FixtureConfig.nodeId):$component"
            }
            Principal = [pscustomobject]@{ UserId = $global:FixtureConfig.ownerSid; LogonType = 3; RunLevel = 0 }
            Settings = [pscustomobject]@{ Enabled = $true }
            Actions = @([pscustomobject]@{
                Path = $global:FixtureConfig.pythonwExe; Arguments = $arguments
                WorkingDirectory = (Split-Path -Parent $global:FixtureConfig.runnerPath)
            })
        }
    }
    $task | Add-Member ScriptMethod Stop {
        param($unused)
        $global:FixtureCalls.Add("stop:$($this.Component)")
        $this.State = 3
    }
    $task | Add-Member ScriptMethod Run {
        param($unused)
        $global:FixtureCalls.Add("run:$($this.Component)")
        $this.State = 4
    }
    $global:FixtureTasks["Codey Node $($global:FixtureConfig.nodeId) $component"] = $task
}
if ($Case -eq 'foreign') {
    $global:FixtureTasks["Codey Node $($global:FixtureConfig.nodeId) data"].Definition.Actions[0].Arguments = 'foreign'
}
$global:FixtureFolder = [pscustomobject]@{}
$global:FixtureFolder | Add-Member ScriptMethod GetTask {
    param($name)
    if (-not $global:FixtureTasks.ContainsKey($name)) { throw 'Fixture refuses unknown task lookup' }
    return $global:FixtureTasks[$name]
}
$global:FixtureScheduler = [pscustomobject]@{}
$global:FixtureScheduler | Add-Member ScriptMethod Connect {}
$global:FixtureScheduler | Add-Member ScriptMethod GetFolder {
    param($folder)
    if ($folder -ne '\') { throw 'Fixture refuses unknown task folder' }
    return $global:FixtureFolder
}
function New-Object {
    param([string]$ComObject)
    if ($ComObject -ne 'Schedule.Service') { throw 'Fixture never opens real COM services' }
    return $global:FixtureScheduler
}
function Get-Acl {
    param([string]$LiteralPath)
    $acl = [pscustomobject]@{}
    $acl | Add-Member ScriptMethod GetOwner {
        param($type)
        return [Security.Principal.SecurityIdentifier]::new($global:FixtureConfig.ownerSid)
    }
    $acl | Add-Member ScriptMethod GetAccessRules {
        param($a, $b, $type)
        $sid = if ($global:FixtureCase -eq 'acl') { 'S-1-1-0' } else { $global:FixtureConfig.ownerSid }
        return @([pscustomobject]@{ AccessControlType = 'Allow'
            IdentityReference = [Security.Principal.SecurityIdentifier]::new($sid) })
    }
    return $acl
}
function Get-NetTCPConnection {
    param($State, $ErrorAction)
    return [pscustomobject]@{ LocalPort = 3001; OwningProcess = 2147480000 }
}
function Get-CimInstance {
    param($ClassName, $Filter, $ErrorAction)
    if ($Filter -eq 'ProcessId=2147480000') {
        return [pscustomobject]@{
            ExecutablePath = $(if ($global:FixtureCase -eq 'other-process') { 'foreign.exe' } else { $global:FixtureConfig.nodeExe })
            CommandLine = $global:FixtureConfig.workspaceEntry; ParentProcessId = 0
        }
    }
    return [pscustomobject]@{
        ParentProcessId = $(if ($global:FixtureCase -eq 'inside') { 2147480000 } else { 0 })
    }
}
function Invoke-CimMethod {
    param($InputObject, $MethodName)
    if ($MethodName -ne 'GetOwnerSid') { throw 'Fixture refuses unexpected CIM action' }
    return [pscustomobject]@{ Sid = $global:FixtureConfig.ownerSid }
}
$rejected = $false
$failure = ''
try {
    $operation = if ($Case -eq 'plan') { 'Check' } else { 'Restart' }
    & $Controller -ConfigPath $ConfigPath -Operation $operation | Out-Null
} catch { $rejected = $true; $failure = $_.Exception.Message }
@{ rejected = $rejected; calls = @($global:FixtureCalls); schedulerWasFake = $true; fixtureError = $failure } |
    ConvertTo-Json -Compress
