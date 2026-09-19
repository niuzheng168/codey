param([string]$Root, [string]$Source, [string]$Node)
$ErrorActionPreference = 'Stop'
. (Join-Path $Source 'install.ps1')
function Check($Value, [string]$Message) { if (-not $Value) { throw $Message } }
if ($env:OS -ne 'Windows_NT') {
    # Only Windows path/ACL and Job Object adapters are replaced on Linux.
    # Cryptography, PEM export, downloads/cache and process I/O use real code.
    function Assert-CodeyPath($Path, $Root) { return [IO.Path]::GetFullPath($Path) }
    function Protect-CodeyPath($Path) {}
    Add-Type @'
using System;
using System.Diagnostics;
public sealed class CodeyChildJob : IDisposable {
    private Process child;
    public void Add(Process process) { child = process; }
    public void Dispose() { if (child != null && !child.HasExited) child.Kill(true); }
}
'@
}

$server = 'n-' + ('a' * 24) + '.nodes.codey.internal'
New-CodeyCertificate $Node $server (Join-Path $Root 'cert.pem') (Join-Path $Root 'key.pem')
New-CodeyCertificate $Node $server (Join-Path $Root 'cert2.pem') (Join-Path $Root 'key2.pem')
$verify = @'
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { X509Certificate, createPrivateKey } = require('node:crypto');
const { createServer, connect } = require('node:tls');
const [root, name] = process.argv.slice(2);
const pem = fs.readFileSync(path.join(root, 'cert.pem'));
const key = fs.readFileSync(path.join(root, 'key.pem'));
const cert = new X509Certificate(pem);
assert.equal(cert.ca, false);
assert.equal(cert.subjectAltName, `DNS:${name}`);
assert.equal(cert.issuer, cert.subject);
assert.ok(cert.verify(cert.publicKey));
assert.ok(cert.checkPrivateKey(createPrivateKey(key)));
assert.equal(cert.publicKey.asymmetricKeyDetails.modulusLength, 3072);
assert.deepEqual(cert.keyUsage, ['1.3.6.1.5.5.7.3.1']);
assert.ok(Date.parse(cert.validFrom) <= Date.now());
assert.ok(Date.parse(cert.validTo) > Date.now() + 364 * 86400000);
assert.ok(Date.parse(cert.validTo) < Date.now() + 366 * 86400000);
assert.notDeepEqual(key, fs.readFileSync(path.join(root, 'key2.pem')));
const server = createServer({key, cert:pem}, socket => socket.end('TLS_OK'));
const timeout = setTimeout(() => process.exit(1), 8000);
server.listen(0, '127.0.0.1', () => {
  const socket = connect({host:'127.0.0.1', port:server.address().port, servername:name, ca:pem});
  let result = '';
  socket.on('data', chunk => {result += chunk});
  socket.on('error', () => process.exit(1));
  socket.on('end', () => {
    assert.equal(socket.authorized, true);
    assert.equal(result, 'TLS_OK');
    server.close(() => {clearTimeout(timeout); console.log('CERTIFICATE_OK')});
  });
});
'@
$verifyFile = Join-Path $Root 'verify-certificate.cjs'
[IO.File]::WriteAllText($verifyFile, $verify)
$result = Invoke-CodeyProcess $Node @($verifyFile, $Root, $server) -TimeoutSeconds 15
Check ($result.Stdout.Trim() -eq 'CERTIFICATE_OK') 'Generated certificate failed native Node/TLS verification.'
$refused = $false
try { New-CodeyCertificate $Node 'wrong-node.example' (Join-Path $Root 'bad.pem') (Join-Path $Root 'bad-key.pem') }
catch { $refused = $true }
Check ($refused -and -not (Test-Path (Join-Path $Root 'bad-key.pem'))) 'An unbound certificate name was accepted.'

$script:requests = 0
$script:downloadBody = 'verified fixture download'
function Invoke-WebRequest {
    param($Uri, $OutFile, $TimeoutSec, [switch]$UseBasicParsing)
    Check ($Uri -eq 'https://download.example.test/tool') 'Unexpected network operation.'
    $script:requests++
    [IO.File]::WriteAllText($OutFile, $script:downloadBody)
}
$cache = Join-Path $Root 'tool'
[IO.File]::WriteAllText($cache, $script:downloadBody)
$hash = (Get-FileHash -LiteralPath $cache -Algorithm SHA256).Hash
Get-CodeyDownload 'https://download.example.test/tool' $cache $hash
Check ($script:requests -eq 0) 'Verified download cache was not reused.'
[IO.File]::WriteAllText($cache, 'corrupted')
Get-CodeyDownload 'https://download.example.test/tool' $cache $hash
Check ($script:requests -eq 1 -and (Get-FileHash $cache).Hash -eq $hash) 'Corrupt cache was reused.'
Get-CodeyDownload 'https://download.example.test/tool' $cache ''
Check ($script:requests -eq 2) 'Unpinned latest installer was cached without verification.'
$script:downloadBody = 'wrong server bytes'
$refused = $false
try { Get-CodeyDownload 'https://download.example.test/tool' (Join-Path $Root 'rejected') $hash } catch { $refused = $true }
Check ($refused -and -not (Test-Path (Join-Path $Root 'rejected')) -and
    -not @(Get-ChildItem -LiteralPath $Root -Filter '*.part').Count) 'Unverified download survived.'

$events = & {
    $script:result = Invoke-CodeyProcess $Node @('-e',
        'process.stdout.write("fixture-private-output"); process.stderr.write("fixture-private-error"); setTimeout(()=>{},5200)') `
        -TimeoutSeconds 12 -Activity 'Fixture dependency installation'
} 6>&1
$messages = $events | Out-String
Check ($messages -match '\[progress\].*\d+s' -and $messages -match '\[done\]') 'Missing bounded progress/timing.'
Check ($messages -notmatch 'fixture-private') 'Progress leaked command output.'
Check ($script:result.Stdout -eq 'fixture-private-output' -and
    $script:result.Stderr -eq 'fixture-private-error') 'Progress broke captured CLI output.'

# Exercise the real native dispatcher; only OS owner/signature results are mocked.
# This is not a claim that a Windows trust chain was validated on this test host.
function Get-CodeyOwner { return [pscustomobject]@{ Home = $Root; Sid = 'fixture-owner' } }
$script:signature = [pscustomobject]@{ Status = 'Valid'
    SignerCertificate = [pscustomobject]@{ Subject = 'CN=Microsoft Corporation, O=Microsoft Corporation, C=US' } }
function Get-AuthenticodeSignature { param([string]$LiteralPath); return $script:signature }
$null = Invoke-CodeyNative ([pscustomobject]@{ operation = 'signature'; file = $cache })
foreach ($invalid in @(
    @('NotSigned', 'O=Microsoft Corporation'),
    @('HashMismatch', 'O=Microsoft Corporation'),
    @('NotTrusted', 'O=Microsoft Corporation'),
    @('Valid', 'O=Another Publisher'),
    @('Valid', 'O=Microsoft Corporation Impostor'),
    @('Valid', 'CN=O=Microsoft Corporation, O=Another Publisher')
)) {
    $script:signature.Status = $invalid[0]
    $script:signature.SignerCertificate.Subject = $invalid[1]
    $refused = $false
    try { $null = Invoke-CodeyNative ([pscustomobject]@{ operation = 'signature'; file = $cache }) } catch { $refused = $true }
    Check $refused 'An invalid or foreign publisher signature was accepted.'
}
@{ passed = $true; certificate = $true; tls = $true; cache = $true; secretSafeProgress = $true
    signaturePolicy = $true; nativeServices = $false; modelCalls = 0 } | ConvertTo-Json -Compress
