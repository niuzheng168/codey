# Native entrypoint contract. The shared Node lifecycle is covered by machine-install-flow.test.mjs.
param([string]$Root, [string]$NodeExe)
$ErrorActionPreference = 'Stop'
. (Join-Path $Root 'package/scripts/install.ps1')
$script:Count = 0
function Check($Value) { if (-not $Value) { throw 'Bootstrap contract failed' }; $script:Count++ }
$home = Join-Path $Root 'home'
[IO.Directory]::CreateDirectory($home) > $null
function Get-CodeyOwner { [pscustomobject]@{ Home=$home; Computer='fixture-pc'; Sid='fixture-sid' } }
function Assert-CodeyPortOwnership { param($OwnerSid,$Previous); Check ($OwnerSid -eq 'fixture-sid') }
# Inject a real installed Node, but never run a real installation.
function Get-Command { param($Name,$CommandType,$ErrorAction); if($Name -eq 'node.exe'){[pscustomobject]@{Source=$NodeExe}} }
$script:Forwarded = @()
function Invoke-CodeyProcess {
    param($Executable,$Arguments,[switch]$Interactive,$TimeoutSeconds)
    Check ($Executable -eq $NodeExe); Check $Interactive
    Check ($TimeoutSeconds -eq 7200)
    $script:Forwarded = $Arguments
}
foreach ($name in @('', 'another-pc')) {
    $failed = $false
    try { Invoke-CodeyWindowsInstall -DoApply $true -ApprovedNetwork $true -ExpectedComputer $name }
    catch { $failed = $_.Exception.Message -match 'ExpectedComputerName' }
    Check $failed
}
$failed = $false
try { Invoke-CodeyWindowsInstall -DoApply $true -ExpectedComputer 'fixture-pc' }
catch { $failed = $true }
Check $failed
Invoke-CodeyWindowsInstall -DoApply $true -ApprovedNetwork $true -ExpectedComputer 'fixture-pc' -Replace $true -Retry $true `
    -RequestedCodexHome (Join-Path $home '.codex')
Check ($script:Forwarded[0] -like '*install-machine.mjs')
foreach ($argument in @('--apply','--network-approved','--expected-computer','fixture-pc','--replace-existing','--retry-failed','--codex-home')) {
    Check ($script:Forwarded -contains $argument)
}
Check (-not (Test-Path -LiteralPath (Join-Path $home '.config')))
Write-Output ('FIXTURE_RESULT=' + (@{passed=$script:Count} | ConvertTo-Json -Compress))
