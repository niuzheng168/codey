[CmdletBinding()]
param(
    [string]$ManifestPath = "$HOME\.config\codey-local-https\runtime.json"
)

$ErrorActionPreference = 'Stop'
$manifest = Get-Content -LiteralPath $ManifestPath -Raw -Encoding utf8 | ConvertFrom-Json

foreach ($name in @('NodeExe', 'EntryPath', 'CertificatePath', 'PrivateKeyPath', 'SigningKeyPath')) {
    if (-not (Test-Path -LiteralPath $manifest.$name -PathType Leaf)) {
        throw "Missing runtime file: $name"
    }
}

# A separate browser listener shares the existing gateway process and data
# directory. Only the read-only HTTPS listener is exposed to the Codey page.
$env:COPILOT_API_HOME = $manifest.DataHome
$env:CODEX_HOME = $manifest.CodexHome
$env:COPILOT_API_CODEY_HTTPS_PORT = [string]$manifest.HttpsPort
$env:COPILOT_API_CODEY_HTTPS_HOST = '127.0.0.1'
$env:COPILOT_API_CODEY_TLS_CERT = $manifest.CertificatePath
$env:COPILOT_API_CODEY_TLS_KEY = $manifest.PrivateKeyPath
$env:COPILOT_API_CODEY_SIGNING_KEY_FILE = $manifest.SigningKeyPath
$env:COPILOT_API_CODEY_NODE_ID = 'local'
$env:COPILOT_API_CODEY_ALLOWED_ORIGIN = $manifest.AllowedOrigin
$env:NODE_USE_SYSTEM_CA = '1'

# Direct Node execution avoids the old npx download/cache dependency. Separate
# redirected streams also keep harmless native stderr warnings from causing
# PowerShell's Stop error policy to terminate the server.
$process = Start-Process -FilePath $manifest.NodeExe `
    -ArgumentList @("`"$($manifest.EntryPath)`"", 'start', '--port', [string]$manifest.HttpPort) `
    -WorkingDirectory (Split-Path -Parent $manifest.EntryPath) `
    -WindowStyle Hidden `
    -RedirectStandardOutput $manifest.StdoutPath `
    -RedirectStandardError $manifest.StderrPath `
    -Wait -PassThru
exit $process.ExitCode
