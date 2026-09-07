[CmdletBinding()]
param(
    [string]$ConfigPath = (Join-Path $env:USERPROFILE '.config\codey-windows-workspace\runtime.json')
)

$ErrorActionPreference = 'Stop'
$config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
if ($config.schema -ne 1 -or
    [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value -ne $config.ownerSid) {
    throw 'The private tunnel must run as the configured Windows owner.'
}
if ($config.tunnelId -notmatch '^[a-z0-9][a-z0-9-]{1,58}\.[a-z0-9]{2,12}$' -or
    $config.port -ne 3001 -or $config.host -ne '127.0.0.1') {
    throw 'Only the configured authenticated Workspace tunnel may be hosted.'
}
if (-not (Test-Path -LiteralPath $config.devtunnelExe -PathType Leaf) -or
    (Get-FileHash -LiteralPath $config.devtunnelExe -Algorithm SHA256).Hash -ne $config.devtunnelSha256) {
    throw 'The signed, pinned Dev Tunnels executable is missing or changed.'
}
# Uses the owner's normal cached Microsoft login. No anonymous access, new
# ports, firewall exceptions, host token in argv, or SSH/VNet changes.
& $config.devtunnelExe host $config.tunnelId --host-header unchanged --origin-header unchanged
exit $LASTEXITCODE
