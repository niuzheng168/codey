param([string]$Root, [string]$Source)
$ErrorActionPreference = 'Stop'
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($Source, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw ($parseErrors | ForEach-Object Message | Out-String) }
# Load functions only, not OS checks or the actual updater entrypoint.
$functions = $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $false)
foreach ($function in $functions) {
    . ([scriptblock]::Create($function.Extent.Text))
}
Add-Type -AssemblyName System.IO.Compression.FileSystem
function Make-Zip {
    param([string]$File, [string[]]$Names, [switch]$Linked)
    $zip = [IO.Compression.ZipFile]::Open($File, [IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($name in $Names) {
            $entry = $zip.CreateEntry($name)
            if ($Linked) { $entry.ExternalAttributes = 0xA000 -shl 16 }
            $stream = [IO.StreamWriter]::new($entry.Open())
            try { $stream.Write('fixture') } finally { $stream.Dispose() }
        }
    } finally { $zip.Dispose() }
}
$good = Join-Path $Root 'good.zip'
Make-Zip $good @('manifest.json', 'offline-update.mjs')
$destination = Join-Path $Root 'good'
$null = New-Item -ItemType Directory $destination
Expand-VerifiedBundle $good $destination
if ([IO.File]::ReadAllText((Join-Path $destination 'manifest.json')) -ne 'fixture') { throw 'Safe ZIP did not extract.' }
$cases = @(
    @('manifest.json', '../outside.txt'),
    @('manifest.json', 'C:/outside.txt'),
    @('manifest.json', 'x:ads'),
    @('manifest.json', 'aux.txt'),
    @('manifest.json', 'a.', 'a'),
    @('manifest.json', 'same.txt', 'SAME.txt'),
    @('manifest.json', 'x//y')
)
$number = 0
foreach ($names in $cases) {
    $number++
    $file = Join-Path $Root ("bad-$number.zip")
    Make-Zip $file $names
    $target = Join-Path $Root ("bad-$number")
    $null = New-Item -ItemType Directory $target
    $refused = $false
    try { Expand-VerifiedBundle $file $target } catch { $refused = $true }
    if (-not $refused -or @(Get-ChildItem -LiteralPath $target -Recurse -Force).Count) {
        throw "Unsafe ZIP $number was not rejected before extraction."
    }
}
$linked = Join-Path $Root 'linked.zip'
Make-Zip $linked @('manifest.json', 'link') -Linked
$target = Join-Path $Root 'linked'
$null = New-Item -ItemType Directory $target
$refused = $false
try { Expand-VerifiedBundle $linked $target } catch { $refused = $true }
if (-not $refused) { throw 'Linked ZIP accepted.' }
@{ passed = $true; cases = $number + 2; servicesChanged = $false; networkRequests = 0 } | ConvertTo-Json -Compress
