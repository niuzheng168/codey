# Codey managed command launcher v1
# Installed as <runtime>/bin/codey.ps1. No profile or global Node is required.
# Intentionally no param/CmdletBinding: all arguments belong to the Codey CLI.
$ErrorActionPreference = 'Stop'
$configFile = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__CODEY_CONFIG_PATH_BASE64__'))
$forwardArguments = @($args)
$child = $null
$job = $null
$exitCode = 1
try {
    $runtimeRoot = Split-Path -Parent $PSScriptRoot
    . (Join-Path $runtimeRoot 'supervisor\windows-common.ps1')
    $owner = Get-CodeyOwner
    $config = Read-CodeyJson $configFile
    if ($config.schema -ne 2 -or $config.kind -ne 'codey-windows-oneclick' -or
        $config.layout -ne 'npm-codey-package' -or -not $config.ready -or
        $config.ownerSid -ne $owner.Sid -or $config.ownerHome -ne $owner.Home -or
        $config.computer -cne $owner.Computer -or $config.runtimeRoot -ne $runtimeRoot) {
        throw 'The installed runtime is not ready or belongs to another owner.'
    }
    if ($config.PSObject.Properties['runnerPath']) {
        $runner = Assert-CodeyPath $config.runnerPath $runtimeRoot
        . (Join-Path (Split-Path -Parent $runner) 'windows-common.ps1')
    }
    $node = Assert-CodeyPath $config.nodeExe $runtimeRoot
    $entry = Assert-CodeyPath $config.codeyBin $runtimeRoot
    $directory = Assert-CodeyPath $config.codeyDirectory $runtimeRoot
    if (-not (Test-Path -LiteralPath $node -PathType Leaf) -or
        $entry -ne (Join-Path $directory 'bin\codey.mjs') -or
        -not (Test-Path -LiteralPath $entry -PathType Leaf)) {
        throw 'The pinned Codey installation is missing.'
    }
    Initialize-CodeyJob
    $job = [CodeyChildJob]::new()
    $child = [Diagnostics.Process]::new()
    $child.StartInfo.FileName = $node
    $child.StartInfo.Arguments = Join-CodeyArguments (@($entry) + $forwardArguments)
    $child.StartInfo.WorkingDirectory = $directory
    $child.StartInfo.UseShellExecute = $false
    # Inherit the interactive console, but change environment only for the child.
    foreach ($name in @('PSModulePath', 'CODEX_THREAD_ID', 'CODEX_PARENT_THREAD_ID', 'CODEX_INTERNAL_ORIGINATOR_OVERRIDE')) {
        $child.StartInfo.EnvironmentVariables.Remove($name)
    }
    foreach ($property in $config.services.codey.environment.PSObject.Properties) {
        $child.StartInfo.EnvironmentVariables[$property.Name] = [string]$property.Value
    }
    $child.StartInfo.EnvironmentVariables['PATH'] = (Split-Path -Parent $node) + ';' +
        $child.StartInfo.EnvironmentVariables['PATH']
    $null = $child.Start()
    $job.Add($child)
    # Polling permits Ctrl+C to unwind finally and terminate this CLI's child tree.
    while (-not $child.WaitForExit(200)) { }
    $exitCode = $child.ExitCode
} catch {
    # Runtime state contains keys. Do not print configuration or raw child arguments.
    [Console]::Error.WriteLine('Unable to launch installed Codey; check the owner and ready runtime.json.')
} finally {
    if ($job) { $job.Dispose() }
    if ($child) { $child.Dispose() }
}
exit $exitCode
