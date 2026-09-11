"""Isolated Windows PowerShell installer, command and watchdog lifecycle tests."""
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import unittest
import zipfile
import zlib

ROOT = Path(__file__).resolve().parents[1]
SKILL = ROOT / "skills/config-new-codey-machine"
def metadata(file):
    file = Path(file)
    body = file.read_bytes()
    return {"file": file.name, "sha256": hashlib.sha256(body).hexdigest(),
            "size": len(body), "crc32": zlib.crc32(body)}


def write_json(file, value):
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def zip_entries(file, entries):
    with zipfile.ZipFile(file, "w") as archive:
        for name, content in entries:
            archive.writestr(name, content)


def make_codey_tgz(root):
    runtime = root / "installed-codey"
    package = {
        "name": "codey", "version": "0.1.0", "type": "module",
        "bin": {"codey": "bin/codey.mjs"},
        "imports": {"#codey/codex-sdk": "./lib/codex-sdk/index.js"},
        "dependencies": {}, "optionalDependencies": {},
    }
    lock = {
        "name": "codey", "version": "0.1.0", "lockfileVersion": 3,
        "packages": {"": {
            "name": "codey", "version": "0.1.0",
            "dependencies": {}, "optionalDependencies": {},
        }},
    }
    write_json(runtime / "package.json", package)
    write_json(runtime / "npm-shrinkwrap.json", lock)
    lock_hash = hashlib.sha256((runtime / "npm-shrinkwrap.json").read_bytes()).hexdigest()
    write_json(runtime / "codey-build.json", {
        "schema": 1, "name": "codey", "version": "0.1.0",
        "sourceCommit": "a" * 40, "sourceDirty": False, "platform": "windows-x64",
        "cloudcli": {"commit": "b" * 40, "version": "1.37.2"},
        "copilotApi": {"commit": "c" * 40, "version": "2.5.4"},
        "lockSha256": lock_hash,
    })
    for name in (
        "bin/codey.mjs", "lib/cli.mjs", "lib/codex-sdk/index.js",
        "dist-server/server/index.js", "dist/index.html",
        "gateway/main.js", "pages/index.html",
        "updater/install.py", "updater/engine.py", "updater/updater.py",
    ):
        file = runtime / name
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text("fixture only\n", encoding="utf-8")
    artifact = root / "codey-0.1.0.tgz"
    with tarfile.open(artifact, "w:gz") as archive:
        for file in sorted(runtime.rglob("*")):
            if file.is_file():
                info = tarfile.TarInfo("package/" + file.relative_to(runtime).as_posix())
                body = file.read_bytes()
                info.size = len(body)
                info.mode = 0o755 if file.name == "codey.mjs" else 0o644
                archive.addfile(info, io.BytesIO(body))
    inspected = {"version": package["version"], "commit": "a" * 40,
                 "entrySha256": metadata(runtime / "codey-build.json")["sha256"],
                 "lockSha256": lock_hash}
    built = {
        "schema": 1, "name": "codey", "platform": "windows-x64",
        "node": "24.20.0",
        "nodeDistribution": {
            "file": "node-v24.20.0-win-x64.zip",
            "url": "https://nodejs.org/dist/v24.20.0/node-v24.20.0-win-x64.zip",
            "sha256": "6cac9ffbca8f6a47091e4b5c772e0606049c3871cb67d900c0cedde630e545ba",
        },
        "bunBuildTool": "1.4.0",
        "dependencyRegistry": "https://packagefeedproxy.microsoft.io/npm/",
        "cloudcli": {"commit": "b" * 40, "version": "1.37.2"},
        "copilotApi": {"commit": "c" * 40, "version": "2.5.4"},
        "codey": inspected,
        "artifact": metadata(artifact),
    }
    return runtime, artifact, built


def fixture(root):
    package = root / "package"
    shutil.copytree(SKILL / "scripts", package / "scripts")
    shutil.copy2(SKILL / "dependencies.windows.json", package / "dependencies.json")
    shutil.copytree(SKILL / "templates", package / "templates")
    runtime, artifact, built = make_codey_tgz(root)
    assets = package / "assets"
    assets.mkdir()
    shutil.copy2(artifact, assets / artifact.name)
    manifest = {
        "schema": 2, "name": "codey", "platform": "windows-x64",
        "releaseId": "machine-" + "a" * 16,
        "dependencyMode": "npm-codey-package", "node": built["node"],
        "nodeDistribution": built["nodeDistribution"],
        "bunBuildTool": built["bunBuildTool"],
        "dependencyRegistry": built["dependencyRegistry"],
        "codey": built["codey"], "cloudcli": built["cloudcli"],
        "copilotApi": built["copilotApi"],
        "bundledRuntimes": ["cloudcli", "copilot-api", "updater"],
        "artifacts": [built["artifact"]],
    }
    write_json(assets / "manifest.json", manifest)
    write_json(assets / "setup.json", {
        "schema": 1, "platform": "windows-x64", "releaseId": manifest["releaseId"],
        "portalOrigin": "https://codey.example.test",
        "network": {"mode": "devtunnel"}, "tunnelAuthProvider": "github",
        "updater": {"supported": False, "reason": "unsupported_platform"},
    })
    names = [artifact.name, "manifest.json", "setup.json"]
    (assets / "SHA256SUMS").write_text(
        "\n".join(f"{metadata(assets / name)['sha256']}  {name}" for name in names) + "\n",
        encoding="ascii",
    )
    zip_entries(root / "node.zip", [
        ("node-v24.20.0-win-x64/node.exe", "fixture"),
        ("node-v24.20.0-win-x64/node_modules/npm/bin/npm-cli.js", "fixture"),
    ])
    for name, entries in {
        "good": [("dir/file.txt", "fixture")],
        "traversal": [("../out.txt", "no")],
        "drive": [("C:/out.txt", "no")],
        "ads": [("file:secret", "no")],
        "reserved": [("dir/NUL.txt", "no")],
        "trailing": [("dir/file. ", "no")],
        "case": [("file.txt", "no"), ("FILE.txt", "no")],
        "file-directory": [("file", "no"), ("file/child", "no")],
    }.items():
        zip_entries(root / f"{name}.zip", entries)
    link = zipfile.ZipInfo("link")
    link.external_attr = 0o120777 << 16
    zip_entries(root / "link.zip", [(link, "../outside")])
    return runtime


@unittest.skipUnless(os.name == "nt", "Native PowerShell behavior requires Windows")
class PowerShellTests(unittest.TestCase):
    def test_console_free_watchdog_restart_and_credentials(self):
        for shell in filter(None, [shutil.which("powershell.exe"), shutil.which("pwsh.exe")]):
            with self.subTest(shell=shell), \
                    tempfile.TemporaryDirectory(prefix="codey watchdog \u4e2d\u6587 ") as directory:
                root = Path(directory)
                fixture(root)
                result = subprocess.run([
                    shell, "-NoLogo", "-NoProfile", "-NonInteractive", "-File",
                    str(ROOT / "test/windows-watchdog-fixture.ps1"), "-Root", str(root),
                ], capture_output=True, text=True, encoding="utf-8", errors="replace",
                    timeout=100, env={key: value for key, value in os.environ.items()
                                      if key.upper() != "PSMODULEPATH"})
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                marker = next(line.split("WATCHDOG_RESULT=", 1)[1]
                              for line in result.stdout.splitlines() if "WATCHDOG_RESULT=" in line)
                report = json.loads(marker)
                self.assertGreaterEqual(report["passed"], 20)
                print(f"{Path(shell).name}: {report['passed']} console-free restart checks passed")

    def test_persistent_command_in_native_fresh_powershell(self):
        for shell in filter(None, [shutil.which("powershell.exe"), shutil.which("pwsh.exe")]):
            with self.subTest(shell=shell), \
                    tempfile.TemporaryDirectory(prefix="codey command \u4e2d\u6587 ") as directory:
                root = Path(directory)
                fixture(root)
                result = subprocess.run([
                    shell, "-NoLogo", "-NoProfile", "-NonInteractive", "-File",
                    str(ROOT / "test/windows-command-fixture.ps1"),
                    "-Root", str(root), "-NodeExe", shutil.which("node.exe"),
                ], capture_output=True, text=True, encoding="utf-8", errors="replace",
                    timeout=180, env={key: value for key, value in os.environ.items()
                                      if key.upper() != "PSMODULEPATH"})
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                marker = next(line.split("COMMAND_RESULT=", 1)[1]
                              for line in result.stdout.splitlines() if "COMMAND_RESULT=" in line)
                report = json.loads(marker)
                self.assertGreaterEqual(report["passed"], 20)
                print(f"{Path(shell).name}: {report['passed']} native command/PATH checks passed")

    def test_native_powershell_installer_isolated_lifecycle(self):
        shells = [shutil.which("powershell.exe"), shutil.which("pwsh.exe")]
        node = shutil.which("node.exe")
        self.assertIsNotNone(node)
        for shell in filter(None, shells):
            with self.subTest(shell=shell), \
                    tempfile.TemporaryDirectory(prefix="codey win \u4e2d\u6587 ") as directory:
                root = Path(directory)
                fixture(root)
                result = subprocess.run([
                    shell, "-NoLogo", "-NoProfile", "-NonInteractive", "-File",
                    str(ROOT / "test/windows-oneclick-fixture.ps1"),
                    "-Root", str(root), "-NodeExe", node,
                ], capture_output=True, text=True, encoding="utf-8", errors="replace",
                    timeout=240, env={
                        key: value for key, value in os.environ.items()
                        if key.upper() != "PSMODULEPATH"
                    })
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                marker = next(
                    line.split("FIXTURE_RESULT=", 1)[1]
                    for line in result.stdout.splitlines() if "FIXTURE_RESULT=" in line)
                report = json.loads(marker)
                self.assertGreaterEqual(report["passed"], 45)
                print(f"{Path(shell).name}: {report['passed']} isolated checks passed")


if __name__ == "__main__":
    unittest.main()
