#requires -Version 5.1
# Thin native owner/Node bootstrap. All platforms use install-machine.mjs.
[CmdletBinding()]
param([switch]$Apply, [switch]$NetworkApproved, [switch]$ReplaceExisting,
    [switch]$RetryFailed, [string]$ExpectedComputerName = '', [string]$CodexHome = '', [string]$Registry = '')
. (Join-Path $PSScriptRoot 'windows-native.ps1')

function Invoke-CodeyWindowsInstall {
    [CmdletBinding()]
    param([bool]$DoApply, [bool]$ApprovedNetwork, [bool]$Replace, [bool]$Retry,
        [string]$ExpectedComputer, [string]$RequestedCodexHome, [string]$DependencyRegistry = '')
    $owner = Get-CodeyOwner
    if ($DoApply -and (-not $ApprovedNetwork -or $ExpectedComputer -cne $owner.Computer)) {
        throw 'Apply requires -NetworkApproved and -ExpectedComputerName matching this computer exactly.'
    }
    $runtimeFile = Join-Path $owner.Home '.config\codey-machine-windows\runtime.json'
    $previous = $null
    if (Test-Path -LiteralPath $runtimeFile) {
        $null = Assert-CodeyOwnedPath $runtimeFile $owner.Home -Private
        $previous = Read-CodeyJson $runtimeFile
    }
    $null = Assert-CodeyPortOwnership $owner.Sid $previous
    $node = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    $nodeFile = if ($node) { $node.Source } else { '' }
    if (-not $nodeFile -and $previous) {
        if ($previous.kind -ne 'codey-windows-oneclick' -or $previous.ownerSid -ne $owner.Sid -or
            $previous.ownerHome -ne $owner.Home -or $previous.computer -cne $owner.Computer) {
            throw 'Existing installation owner does not match.'
        }
        $root = Join-Path $owner.Home '.local\share\codey-machine-windows'
        $nodeFile = Assert-CodeyOwnedPath (Assert-CodeyPath $previous.nodeExe $root) $owner.Home
        if ($previous.PSObject.Properties['fileHashes'] -and
            (Get-FileHash -LiteralPath $nodeFile -Algorithm SHA256).Hash -ne $previous.fileHashes.nodeExe) {
            throw 'Existing Node fingerprint mismatch; no download or reinstall was attempted.'
        }
    }
    if ($nodeFile) {
        & $nodeFile -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||a===22&&b>=13?0:1)"
        if ($LASTEXITCODE -ne 0) { $nodeFile = '' }
    }
    if (-not $nodeFile -and -not $DoApply) {
        @{ mode = 'check'; computer = $owner.Computer; platform = 'windows-x64'; downloads = $false; changes = $false
            deferred = @('Node/npm missing: package/configuration checks require Node', 'login, services, models and registration require apply') } |
            ConvertTo-Json -Depth 5
        return
    }
    $temporary = ''
    try {
        if (-not $nodeFile) {
            $pins = Read-CodeyJson (Join-Path (Split-Path -Parent $PSScriptRoot) 'dependencies.windows.json')
            if ($pins.node.version -notmatch '^\d+\.\d+\.\d+$' -or $pins.node.sha256 -notmatch '^[a-f0-9]{64}$' -or
                $pins.node.url -ne "https://nodejs.org/dist/v$($pins.node.version)/node-v$($pins.node.version)-win-x64.zip") {
                throw 'Invalid official Node pin.'
            }
            $temporary = Join-Path $owner.Home ('.codey-bootstrap-' + [Guid]::NewGuid().ToString('N'))
            New-CodeyDirectory $temporary
            $archive = Join-Path $temporary 'node.zip'
            Get-CodeyDownload $pins.node.url $archive $pins.node.sha256
            Expand-CodeyZip $archive (Join-Path $temporary 'node')
            $nodeFile = Join-Path $temporary "node\node-v$($pins.node.version)-win-x64\node.exe"
            $env:CODEY_BOOTSTRAP_NODE_ARCHIVE = $archive
        }
        $arguments = @((Join-Path $PSScriptRoot 'install-machine.mjs'))
        if ($DoApply) { $arguments += @('--apply', '--network-approved', '--expected-computer', $ExpectedComputer) }
        else { $arguments += '--check' }
        if ($Replace) { $arguments += '--replace-existing' }
        if ($Retry) { $arguments += '--retry-failed' }
        if ($RequestedCodexHome) { $arguments += @('--codex-home', $RequestedCodexHome) }
        if ($DependencyRegistry) { $arguments += @('--registry', $DependencyRegistry) }
        if ($DoApply) {
            # Only apply needs a Job Object. A read-only check must not compile
            # the C# runner or create compiler temporary files.
            $null = Invoke-CodeyProcess $nodeFile $arguments -Interactive -TimeoutSeconds 7200
        } else {
            & $nodeFile @arguments
            if ($LASTEXITCODE -ne 0) { throw 'Read-only preflight failed.' }
        }
    } finally {
        if ($temporary) { Remove-Item -LiteralPath $temporary -Recurse -Force; Remove-Item Env:CODEY_BOOTSTRAP_NODE_ARCHIVE -ErrorAction SilentlyContinue }
    }
}
if ($MyInvocation.InvocationName -ne '.') {
    Invoke-CodeyWindowsInstall -DoApply $Apply -ApprovedNetwork $NetworkApproved -Replace $ReplaceExisting -Retry $RetryFailed `
        -ExpectedComputer $ExpectedComputerName -RequestedCodexHome $CodexHome -DependencyRegistry $Registry
}
