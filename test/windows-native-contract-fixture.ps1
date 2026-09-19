param([string]$Source)
$ErrorActionPreference = 'Stop'
. (Join-Path $Source 'windows-native.ps1')
function Check($Value) { if (-not $Value) { throw 'Native adapter contract failed' } }
function Get-CodeyOwner { [pscustomobject]@{ Home = 'C:\fixture'; Sid = 'owner' } }
$script:processQueries = 0
function Get-CodeyProcesses { $script:processQueries++; return @() }
function Get-CodeyListeners { return @() }
function Get-CodeyServiceState { return @([pscustomobject]@{ name = 'fixture'; running = $true }) }
$ports = Invoke-CodeyNative ([pscustomobject]@{ operation = 'ports'; previous = $null })
Check ((ConvertTo-Json -InputObject $ports -Compress) -eq '[]')
Check ($script:processQueries -eq 0)
$states = Invoke-CodeyNative ([pscustomobject]@{ operation = 'service-status'; config = @{}; file = '' })
Check ($states -is [array] -and $states.Count -eq 1)
Check ((ConvertTo-Json -InputObject $states -Compress) -eq '[{"name":"fixture","running":true}]')

$script:tasks = @()
$folder = [pscustomobject]@{}
$folder | Add-Member ScriptMethod GetTasks { param($Flags); return $script:tasks }
function Get-CodeyTaskFolder { return @{ Folder = $folder } }
$root = 'C:\fixture\runtime'
$config = 'C:\fixture\config\runtime.json'
$task = [pscustomobject]@{ Name = 'Codey Machine old codey'; Enabled = $true; State = 3
    Definition = [pscustomobject]@{ Actions = @([pscustomobject]@{
        Type = 0; Path = "$root\supervisor\codey-task-host.exe"; Arguments = "--config $config"
    }) } }
$script:tasks = @($task)
$denied = $false
try { Assert-CodeyNoStaleTasks $root $config $null } catch { $denied = $_.Exception.Message -match 'stale tasks' }
Check $denied
$task.Enabled = $false
Assert-CodeyNoStaleTasks $root $config $null
$task.State = 4
$denied = $false
try { Assert-CodeyNoStaleTasks $root $config $null } catch { $denied = $true }
Check $denied
Write-Output 'NATIVE_CONTRACT_OK'
