# The package/configuration workflow is now Node, not a duplicate PowerShell parser.
param([string]$Root, [string]$Node)
$ErrorActionPreference = 'Stop'
. (Join-Path $Root 'package/scripts/install.ps1')
$script = @'
const fs = require("node:fs"), path = require("node:path"), {pathToFileURL} = require("node:url");
(async () => {
  const root = process.argv[1], skill = path.join(root, "package");
  const {readPackage, assertInstalled} = await import(pathToFileURL(path.join(skill, "scripts/machine-package.mjs")));
  const manifest = JSON.parse(fs.readFileSync(path.join(skill, "assets/manifest.json")));
  const original = fs.readFileSync(path.join(skill, "assets/manifest.json"));
  if (!manifest.runtimePlatforms) {
    await require("node:assert/strict").rejects(readPackage(skill, "windows-x64"));
    return;
  }
  const prepared = await readPackage(skill, "windows-x64");
  require("node:assert/strict").equal(prepared.setup.platform, "windows-x64");
  require("node:assert/strict").ok(prepared.pins.node.url.endsWith("-win-x64.zip"));
  await assertInstalled(path.join(root, "installed-codey"), prepared.manifest);
  require("node:assert/strict").deepEqual(fs.readFileSync(path.join(skill, "assets/manifest.json")), original);
})().catch(e => {console.error(e.message);process.exitCode=1});
'@
& $Node -e $script $Root
if ($LASTEXITCODE -ne 0) { throw 'Shared Node package verification failed' }
if (Get-Command Read-CodeyWindowsPackage -ErrorAction SilentlyContinue) { throw 'A second package workflow survived' }
if (Get-Command Install-CodeyAutomaticUpdater -ErrorAction SilentlyContinue) { throw 'An updater survived' }
Write-Output 'WINDOWS_REGISTRATION_FIXTURE_OK'
