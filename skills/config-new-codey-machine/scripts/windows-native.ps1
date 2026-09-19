#requires -Version 5.1
# OS adapter only. Package preparation, login, identity, config and verification are Node code.
[CmdletBinding()]
param([string]$RequestFile = '')
. (Join-Path $PSScriptRoot 'windows-common.ps1')
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

function Assert-CodeyOwnedPath {
    param([string]$File, [string]$Home, [switch]$Private)
    $full = Assert-CodeyPath $File $Home
    for ($cursor = $full; $cursor -and $cursor -ne $Home; $cursor = Split-Path -Parent $cursor) {
        if (-not (Test-Path -LiteralPath $cursor)) { continue }
        $acl = Get-Acl -LiteralPath $cursor
        $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid) {
            throw 'Installation paths must belong to the original owner.'
        }
        foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
            if ($rule.AccessControlType -ne 'Allow' -or $rule.IdentityReference.Value -in @($sid, 'S-1-5-18')) { continue }
            if (-not ($Private -and $cursor -eq $full) -and $rule.IdentityReference.Value -eq 'S-1-5-32-544') { continue }
            $forbidden = if ($Private -and $cursor -eq $full) { [Security.AccessControl.FileSystemRights]::ReadData }
                else { [Security.AccessControl.FileSystemRights]'WriteData, Delete, ChangePermissions, TakeOwnership' }
            if ($rule.FileSystemRights -band $forbidden) { throw 'Installation path has shared access; review its ACL.' }
        }
    }
    return $full
}
function New-CodeyCertificate {
    param([string]$Node, [string]$ServerName, [string]$CertificateFile, [string]$KeyFile)
    if ($ServerName -notmatch '^n-[a-f0-9]{24}\.nodes\.codey\.internal$') { throw 'Invalid node certificate name.' }
    # Use system cryptography in memory, not Git/OpenSSL or the Windows certificate store.
    $rsa = [Security.Cryptography.RSA]::Create()
    $certificate = $null
    try {
        $rsa.KeySize = 3072
        if ($rsa -is [Security.Cryptography.RSACryptoServiceProvider]) { $rsa.PersistKeyInCsp = $false }
        $request = [Security.Cryptography.X509Certificates.CertificateRequest]::new(
            "CN=$ServerName", $rsa, [Security.Cryptography.HashAlgorithmName]::SHA256,
            [Security.Cryptography.RSASignaturePadding]::Pkcs1)
        $request.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new(
            $false, $false, 0, $true))
        $request.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new(
            [Security.Cryptography.X509Certificates.X509KeyUsageFlags]'DigitalSignature, KeyEncipherment', $true))
        $purposes = [Security.Cryptography.OidCollection]::new()
        $null = $purposes.Add([Security.Cryptography.Oid]::new('1.3.6.1.5.5.7.3.1'))
        $request.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($purposes, $false))
        $san = [Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
        $san.AddDnsName($ServerName)
        $request.CertificateExtensions.Add($san.Build($false))
        $now = [DateTimeOffset]::UtcNow
        $certificate = $request.CreateSelfSigned($now.AddMinutes(-5), $now.AddDays(365))
        $parameters = $rsa.ExportParameters($true)
        $jwk = @{ kty = 'RSA' }
        $fields = @{ n = 'Modulus'; e = 'Exponent'; d = 'D'; p = 'P'; q = 'Q'; dp = 'DP'; dq = 'DQ'; qi = 'InverseQ' }
        foreach ($name in $fields.Keys) {
            $jwk[$name] = [Convert]::ToBase64String($parameters.($fields[$name])).TrimEnd('=').Replace('+', '-').Replace('/', '_')
        }
        # Node performs the standard JWK -> PKCS#8 conversion. Private material
        # travels only through stdin/stdout pipes, never arguments or log files.
        $convert = 'const {createPrivateKey}=require("node:crypto"); const fs=require("node:fs");' +
            'process.stdout.write(createPrivateKey({key:JSON.parse(fs.readFileSync(0,"utf8")),format:"jwk"}).export({type:"pkcs8",format:"pem"}));'
        $key = (Invoke-CodeyProcess $Node @('-e', $convert) -InputText ($jwk | ConvertTo-Json -Compress) -TimeoutSeconds 20).Stdout
        Write-CodeyFile $KeyFile $key
        Write-CodeyFile $CertificateFile ("-----BEGIN CERTIFICATE-----`n" +
            [Convert]::ToBase64String($certificate.RawData, [Base64FormattingOptions]::InsertLineBreaks) +
            "`n-----END CERTIFICATE-----`n")
    } finally {
        if ($certificate) { $certificate.Dispose() }
        $rsa.Dispose()
    }
}

function Get-CodeyListeners {
    @(Get-NetTCPConnection -State Listen -ErrorAction Stop |
        Where-Object { $_.LocalPort -in @(3001, 4141, 8443) } |
        Select-Object LocalAddress, LocalPort, OwningProcess)
}

function Get-CodeyForeignListeners {
    param($Listeners, $Processes, $Previous)
    foreach ($listener in $Listeners) {
        $process = @($Processes | Where-Object { $_.ProcessId -eq $listener.OwningProcess })
        $pattern = ''
        if ($Previous) {
            $entry = Join-Path $Previous.codeyDirectory 'bin\codey.mjs'
            $argumentSets = @(
                if ($listener.LocalPort -eq 3001) {
                    ,@((Join-Path $Previous.codeyDirectory 'lib\workspace.mjs'))
                    ,@($entry, 'workspace', '--host', '127.0.0.1', '--port', '3001')
                }
                else {
                    ,@($entry, 'copilot', 'start', '--host', '127.0.0.1', '--port', '4141')
                    ,@($entry, 'gateway', 'start', '--headless', '--host', '127.0.0.1', '--port', '4141')
                }
            )
            # Match whole native arguments, not a path appearing in --eval,
            # another filename or a script's unrelated argument.
            # Old argv is accepted only to identify an existing process, not as a public alias.
            $patterns = foreach ($arguments in $argumentSets) {
                $tokens = @($Previous.nodeExe) + $arguments
                ($tokens | ForEach-Object {
                    $escaped = [regex]::Escape($_)
                    if ($_ -match '\s') { '"' + $escaped + '"' }
                    else { '(?:"' + $escaped + '"|' + $escaped + ')' }
                }) -join '[ \t]+'
            }
            $pattern = '^(?:' + ($patterns -join '|') + ')$'
        }
        if (-not $Previous -or $process.Count -ne 1 -or
            $process[0].ExecutablePath -ne $Previous.nodeExe -or
            -not $process[0].CommandLine -or $process[0].CommandLine -notmatch $pattern -or
            $listener.LocalAddress -notin @('127.0.0.1', '::1')) { $listener }
    }
}

function Assert-CodeyPortOwnership {
    param([string]$OwnerSid, $Previous)
    $listeners = @(Get-CodeyListeners)
    $processes = @(Get-CodeyProcesses $OwnerSid)
    $foreign = @(Get-CodeyForeignListeners $listeners $processes $Previous)
    if ($foreign.Count) {
        $ports = @($foreign | Select-Object -ExpandProperty LocalPort -Unique) -join '/'
        throw "Ports $ports have foreign or unverified listeners; installation stopped. No process was killed."
    }
}

function Set-CodeyUserModelKey {
    param([string]$Key)
    if ([Environment]::GetEnvironmentVariable('CODEY_MODEL_API_KEY', 'User') -ceq $Key) { return }
    [Environment]::SetEnvironmentVariable('CODEY_MODEL_API_KEY', $Key, 'User')
    Send-CodeyEnvironmentChanged
}

function Add-CodeyPathEntry {
    param([string]$Value, [string]$Entry)
    if ($Entry.Contains(';')) { throw 'The Codey command directory cannot contain a PATH separator.' }
    foreach ($part in $Value.Split(';')) {
        $expanded = [Environment]::ExpandEnvironmentVariables($part.Trim().Trim('"')).TrimEnd('\', '/')
        if ($expanded.Equals($Entry.TrimEnd('\', '/'), [StringComparison]::OrdinalIgnoreCase)) { return $Value }
    }
    $result = if (-not $Value) { $Entry } elseif ($Value.EndsWith(';')) { $Value + $Entry } else { "$Value;$Entry" }
    if ($result.Length -ge 32767) { throw 'User PATH would exceed the Windows environment limit.' }
    return $result
}

function Get-CodeyUserPath {
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment')
    try {
        if (-not $key) { return '' }
        return [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    } finally { if ($key) { $key.Dispose() } }
}

function Set-CodeyUserPath {
    param([string]$Value, [string]$Expected)
    $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
    try {
        $current = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        if ($current -cne $Expected) { throw 'User PATH changed concurrently; retry command registration.' }
        $kind = if ($key.GetValueNames() -contains 'Path') { $key.GetValueKind('Path') }
            else { [Microsoft.Win32.RegistryValueKind]::ExpandString }
        if ($kind -notin @([Microsoft.Win32.RegistryValueKind]::String,
            [Microsoft.Win32.RegistryValueKind]::ExpandString)) { throw 'Unexpected user PATH registry value kind.' }
        $key.SetValue('Path', $Value, $kind)
    } finally { $key.Dispose() }
    Send-CodeyEnvironmentChanged
}

function Send-CodeyEnvironmentChanged {
    # Let future terminal processes inherit the new PATH/model key.
    if (-not ('CodeyPathNotification' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CodeyPathNotification {
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern IntPtr SendMessageTimeout(
        IntPtr window, uint message, UIntPtr wParam, string lParam,
        uint flags, uint timeout, out UIntPtr result);
}
'@
    }
    $result = [UIntPtr]::Zero
    $null = [CodeyPathNotification]::SendMessageTimeout(
        [IntPtr]0xffff, 0x001a, [UIntPtr]::Zero, 'Environment', 2, 3000, [ref]$result)
}

function Install-CodeyCommand {
    param($Config, [string]$ConfigPath)
    $directory = Assert-CodeyPath (Join-Path $Config.runtimeRoot 'bin') $Config.runtimeRoot
    $file = Assert-CodeyPath (Join-Path $directory 'codey.ps1') $directory
    $null = Assert-CodeyPath $ConfigPath $Config.configRoot
    # Keep the generated script ASCII: Windows PowerShell 5.1 reads BOM-less scripts as ANSI.
    $encodedConfig = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($ConfigPath))
    $content = (Get-Content -LiteralPath (Join-Path $PSScriptRoot 'windows-command.ps1') -Raw -Encoding UTF8).
        Replace('__CODEY_CONFIG_PATH_BASE64__', $encodedConfig)
    $exists = Test-Path -LiteralPath $file
    $current = if ($exists) { [string](Get-Content -LiteralPath $file -Raw -Encoding UTF8) } else { '' }
    if ($exists -and -not $current.StartsWith('# Codey managed command launcher v1')) {
        throw 'An unmanaged codey.ps1 occupies the command directory; it will not be overwritten.'
    }
    $userPath = Get-CodeyUserPath
    $newUserPath = Add-CodeyPathEntry $userPath $directory
    $newProcessPath = Add-CodeyPathEntry $env:PATH $directory
    if (-not (Test-Path -LiteralPath $directory)) { New-CodeyDirectory $directory }
    if ($current -cne $content) { Write-CodeyFile $file $content }
    if ($newUserPath -cne $userPath) { Set-CodeyUserPath $newUserPath $userPath }
    $env:PATH = $newProcessPath
}

function Invoke-CodeyNative {
    param($Request)
    $owner = Get-CodeyOwner
    switch ($Request.operation) {
        'owner' { return $owner }
        'path' { return Assert-CodeyOwnedPath $Request.file $owner.Home -Private:([bool]$Request.private) }
        'directory' { $file = Assert-CodeyOwnedPath $Request.file $owner.Home; New-CodeyDirectory $file; return $file }
        'write' {
            $file = Assert-CodeyOwnedPath $Request.file $owner.Home
            Write-CodeyBytes $file ([Convert]::FromBase64String($Request.bytes))
            return $null
        }
        'ports' {
            Assert-CodeyPortOwnership $owner.Sid $Request.previous
            return @(Get-CodeyListeners)
        }
        'available' {
            $processes = @(Get-CodeyProcesses $owner.Sid)
            Assert-CodeyExternalTerminal $processes
            if (@($processes | Where-Object { $_.Name -ieq 'codex.exe' }).Count) {
                throw 'Close Codex/Desktop yourself from an external terminal; no process will be killed.'
            }
            if (-not ('System.Security.Cryptography.X509Certificates.CertificateRequest' -as [type])) {
                throw 'Certificate support requires .NET Framework 4.7.2 or newer.'
            }
            return $null
        }
        'download' {
            $null = Assert-CodeyOwnedPath $Request.destination $owner.Home
            Get-CodeyDownload $Request.url $Request.destination $Request.sha256
            return $null
        }
        'extract' { Expand-CodeyZip $Request.archive $Request.destination; return $null }
        'signature' {
            $signature = Get-AuthenticodeSignature -LiteralPath $Request.file
            if ($signature.Status -ne 'Valid' -or
                $signature.SignerCertificate.Subject -notmatch '(?:^|,\s*)O=Microsoft Corporation(?:,|$)') {
                throw 'DevTunnel Authenticode verification failed.'
            }
            return $null
        }
        'certificate' {
            New-CodeyCertificate $Request.node $Request.serverName $Request.certificate $Request.key
            return $null
        }
        'task-host' { return Install-CodeyTaskHost $Request.directory }
        'start' {
            Install-CodeyTasks $Request.config $Request.file -PreviousConfig $Request.previous
            Set-CodeyTaskState $Request.config $Request.file @('codey', 'tunnel', 'renew') -Start
            return $null
        }
        'stop' { Set-CodeyTaskState $Request.config $Request.file @('codey', 'tunnel', 'renew'); return $null }
        'service-status' { return @(Get-CodeyServiceState $Request.config $Request.file) }
        'service-state' { Set-CodeyServiceState $Request.config $Request.file $Request.states; return $null }
        'external' { Assert-CodeyExternalTerminal @(Get-CodeyProcesses $owner.Sid); return $null }
        'model-key' { Set-CodeyUserModelKey $Request.key; return $null }
        'verify' { Assert-CodeyTasksRunning $Request.config $Request.file; return $null }
        'command' {
            Install-CodeyCommand $Request.config $Request.file
            if ($Request.fresh) { Set-CodeyUserModelKey $Request.config.modelKey }
            return $null
        }
        'run' {
            $environment = @{}
            foreach ($property in $Request.environment.PSObject.Properties) { $environment[$property.Name] = [string]$property.Value }
            $result = Invoke-CodeyProcess $Request.executable @($Request.arguments) -Environment $environment `
                -WorkingDirectory $Request.cwd -TimeoutSeconds $Request.timeout `
                -Interactive:([bool]$Request.interactive) -AllowFailure:([bool]$Request.allowFailure) `
                -ReplaceEnvironment:([bool]$Request.replaceEnvironment)
            return @{ code = $result.ExitCode; stdout = $result.Stdout; stderr = $result.Stderr }
        }
        default { throw 'Unknown native operation.' }
    }
}

if ($MyInvocation.InvocationName -ne '.') {
    try {
        if ($RequestFile) {
            $owner = Get-CodeyOwner
            $null = Assert-CodeyOwnedPath $RequestFile $owner.Home -Private
            $request = Read-CodeyJson $RequestFile
        } else { $request = [Console]::In.ReadToEnd() | ConvertFrom-Json }
        $result = Invoke-CodeyNative $request
        ConvertTo-Json -InputObject $result -Depth 30 -Compress
    } catch {
        # Requests may contain credentials. Never print the request, native argv
        # or a ConvertFrom-Json error that could echo private input.
        [Console]::Error.WriteLine('Windows native operation failed; inspect ownership, ports and private installation state.')
        exit 1
    }
}
