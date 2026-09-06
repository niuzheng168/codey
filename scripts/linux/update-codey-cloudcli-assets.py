#!/usr/bin/env -S python3 -I -S
"""Atomically publish ONLY static CloudCLI assets; never restart a service or replace a backend release."""
import sys

# A node's home directory can contain user scripts named copy.py, etc. Refuse to
# import any filesystem module until Python excludes cwd, PYTHONPATH and site.
if not sys.flags.isolated or not sys.flags.no_site:
    raise SystemExit("Run this installer with python3 -I -S")

import hashlib
import json
import os
import pathlib
import re
import shutil
import subprocess
import tarfile
import time
import uuid

if len(sys.argv) != 6:
    raise SystemExit("usage: update-codey-cloudcli-assets.py ARCHIVE NODE_ID EXPECTED_PID OLD_INDEX_SHA ARCHIVE_SHA")
archive_name, node, expected_pid, old_sha, archive_sha = sys.argv[1:]
if not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,31}", node) or not re.fullmatch(r"[1-9][0-9]*", expected_pid):
    raise SystemExit("Invalid node or PID")
if not all(re.fullmatch(r"[a-f0-9]{64}", value) for value in [old_sha, archive_sha]):
    raise SystemExit("Invalid expected hashes")

home = pathlib.Path.home().resolve()
install = home / ".local/share/codey-cloudcli"
if install.resolve() != install:
    raise SystemExit("Unexpected install-root link")
archive = pathlib.Path(archive_name).expanduser().resolve(strict=True)
if not archive.is_relative_to(install / "ui-staging") or archive.stat().st_size > 128 * 1024 * 1024:
    raise SystemExit("Archive is outside the approved staging directory or too large")
digest = lambda value: hashlib.sha256(value).hexdigest()
if digest(archive.read_bytes()) != archive_sha:
    raise SystemExit("Archive checksum mismatch")

def service_pid(name):
    return subprocess.check_output(
        ["systemctl", "--user", "show", name, "-p", "MainPID", "--value"], text=True, timeout=10
    ).strip()

def current_state():
    return {
        "cloudcliPid": service_pid("codey-cloudcli.service"),
        "copilotPid": service_pid("copilot-api.service"),
        "bootId": pathlib.Path("/proc/sys/kernel/random/boot_id").read_text().strip(),
    }

before = current_state()
if before["cloudcliPid"] != expected_pid:
    raise SystemExit("CloudCLI changed since the baseline; refusing to publish")
root = pathlib.Path(f"/proc/{expected_pid}/cwd").resolve(strict=True)
if not root.is_relative_to(install / "releases") or (install / "current").resolve() != root:
    raise SystemExit("Unexpected active CloudCLI release")
dist = root / "dist"
if dist.resolve() != dist or (dist / "index.html").is_symlink():
    raise SystemExit("Unexpected static-directory link")
index = dist / "index.html"
if digest(index.read_bytes()) != old_sha:
    raise SystemExit("User changed index.html since the baseline; refusing to replace it")

job = install / "ui-deployments" / f"voice-{time.strftime('%Y%m%d-%H%M%S', time.gmtime())}-{uuid.uuid4().hex[:8]}"
if not job.resolve().is_relative_to(install):
    raise SystemExit("Deployment backup directory escapes the install root")
job.mkdir(parents=True, mode=0o700)
stage = job / "staged"
stage.mkdir(mode=0o700)
entries = []
total = 0
with tarfile.open(archive, "r:gz") as package:
    for member in package:
        relative = pathlib.PurePosixPath(member.name)
        if len(entries) >= 5000 or not member.isfile() or relative.is_absolute() or any(
            part in {"..", "."} for part in relative.parts
        ) or "\\" in member.name:
            raise SystemExit("Unsafe archive entry")
        if member.name != "index.html" and not member.name.startswith("assets/"):
            raise SystemExit("Archive must contain only index.html and hashed assets")
        total += member.size
        if total > 256 * 1024 * 1024:
            raise SystemExit("Unpacked assets are too large")
        target = stage / member.name
        if target.exists() or not target.resolve().is_relative_to(stage):
            raise SystemExit("Duplicate or escaping archive entry")
        target.parent.mkdir(parents=True, exist_ok=True)
        with package.extractfile(member) as source, target.open("xb") as destination:
            shutil.copyfileobj(source, destination)
        entries.append(member.name)

new_index = stage / "index.html"
html = new_index.read_text(encoding="utf-8")
prefix = f"/cloudcli/{node}/"
if f"{prefix}assets/" not in html:
    raise SystemExit("This client was built for another node")
for url in re.findall(r'(?:src|href)=["\']([^"\']+)', html):
    if url.startswith("/cloudcli/") and not url.startswith(prefix):
        raise SystemExit("Client contains another node's asset prefix")

# Verify every target before writing any active asset. Never replace a hash-named
# file with different bytes: old tabs may still depend on it.
assets = [name for name in entries if name != "index.html"]
for name in assets:
    target = dist / name
    if target.is_symlink() or not target.resolve().is_relative_to(dist):
        raise SystemExit("Static target escapes its approved directory")
    if target.exists() and digest(target.read_bytes()) != digest((stage / name).read_bytes()):
        raise SystemExit("Refusing to change an existing immutable asset")
shutil.copy2(index, job / "previous-index.html")
added = 0
for name in assets:
    target = dist / name
    if target.exists():
        continue
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(target.name + ".codey-" + uuid.uuid4().hex + ".tmp")
    shutil.copyfile(stage / name, temporary)
    temporary.chmod(0o644)
    os.replace(temporary, target)
    added += 1

if current_state() != before or pathlib.Path(f"/proc/{expected_pid}/cwd").resolve() != root or digest(index.read_bytes()) != old_sha:
    raise SystemExit("Runtime or index changed during staging; new HTML was not published")
temporary_index = dist / (".codey-index-" + uuid.uuid4().hex + ".tmp")
shutil.copyfile(new_index, temporary_index)
temporary_index.chmod(0o644)
os.replace(temporary_index, index)
after = current_state()
report = {
    "node": node, "root": str(root), "oldIndexSha256": old_sha,
    "newIndexSha256": digest(index.read_bytes()), "addedAssets": added,
    "backupIndex": str(job / "previous-index.html"), "before": before, "after": after,
    "servicesUnchanged": before == after,
}
(job / "deployment.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
print(json.dumps(report))
if before != after:
    raise SystemExit("Runtime changed externally; inspect without restarting or reverting another deployment")
