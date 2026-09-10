#!/usr/bin/env python3
"""Publish one complete machine Skill ZIP independently from the ACA image."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import uuid
import zipfile

MARKER = b'{"schema":1,"kind":"codey-machine-skill-store"}\n'
RELEASE = re.compile(r"machine-[a-f0-9]{16}")
PACKAGE_NAME = "config-new-codey-machine.zip"
MAX_PACKAGE = 1536 * 1024 * 1024


class PublishError(Exception):
    pass


def azure_cli_command(arguments):
    executable = shutil.which("az")
    if not executable:
        raise PublishError("AZURE_CLI_NOT_FOUND")
    command = [executable, *arguments]
    if os.name == "nt" and Path(executable).suffix.lower() in {".bat", ".cmd"}:
        command = [os.environ.get("COMSPEC", "cmd.exe"), "/d", "/c", *command]
    return command


def sha256(file):
    digest = hashlib.sha256()
    with Path(file).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def checked_name(name):
    value = PurePosixPath(name)
    if (not name or len(name) > 512 or value.is_absolute() or ".." in value.parts
            or "\\" in name or ":" in name or any(part in {"", "."} for part in value.parts)):
        raise PublishError("UNSAFE_STORE_PATH")
    return value.as_posix()


def inspect_package(file):
    file = Path(file).resolve(strict=True)
    size = file.stat().st_size
    if not 0 < size <= MAX_PACKAGE:
        raise PublishError("INVALID_PACKAGE_SIZE")
    package_sha = sha256(file)
    with zipfile.ZipFile(file) as archive:
        records = archive.infolist()
        if not records or len(records) > 100:
            raise PublishError("INVALID_PACKAGE_CONTENTS")
        names = {record.filename for record in records if not record.is_dir()}
        if len(names) != len([record for record in records if not record.is_dir()]):
            raise PublishError("DUPLICATE_PACKAGE_ENTRY")
        for record in records:
            name = PurePosixPath(record.filename)
            if (name.is_absolute() or ".." in name.parts or "\\" in record.filename
                    or record.file_size > MAX_PACKAGE or record.compress_size != record.file_size):
                raise PublishError("UNSAFE_PACKAGE_ENTRY")
        root = "config-new-codey-machine/"
        required = {
            root + "SKILL.md", root + "dependencies.json", root + "agents/openai.yaml",
            root + "scripts/install.sh", root + "templates/a100-models.json",
            root + "assets/cloudcli.tar.gz", root + "assets/copilot-api.tar.gz",
            root + "assets/updater.tar.gz", root + "assets/manifest.json",
            root + "assets/setup.json", root + "assets/SHA256SUMS",
        }
        if names != required:
            raise PublishError("INCOMPLETE_SKILL_PACKAGE")
        manifest_raw = archive.read(root + "assets/manifest.json")
        setup_raw = archive.read(root + "assets/setup.json")
        if len(manifest_raw) > 16384 or len(setup_raw) > 16384:
            raise PublishError("OVERSIZED_PACKAGE_METADATA")
        manifest = json.loads(manifest_raw)
        setup = json.loads(setup_raw)
        if (manifest.get("schema") != 1 or manifest.get("platform") != "linux-x64"
                or manifest.get("dependencyMode") != "prebuilt-private-components"
                or not RELEASE.fullmatch(manifest.get("releaseId", ""))
                or setup.get("schema") != 1 or setup.get("platform") != "linux-x64"
                or setup.get("releaseId") != manifest["releaseId"]
                or setup.get("network") != {"mode": "devtunnel"}
                or setup.get("tunnelAuthProvider") != "github"):
            raise PublishError("INVALID_PACKAGE_METADATA")
        expected = {
            item["file"]: item for item in manifest.get("artifacts", [])
            if isinstance(item, dict) and isinstance(item.get("file"), str)
        }
        if set(expected) != {"cloudcli.tar.gz", "copilot-api.tar.gz", "updater.tar.gz"}:
            raise PublishError("INVALID_PACKAGE_ARTIFACTS")
        for name, item in expected.items():
            body = archive.read(root + "assets/" + name)
            if len(body) != item.get("size") or hashlib.sha256(body).hexdigest() != item.get("sha256"):
                raise PublishError("PACKAGE_ARTIFACT_MISMATCH")
        checksums = archive.read(root + "assets/SHA256SUMS").decode("ascii").splitlines()
        expected_sums = {}
        for line in checksums:
            digest, name = line.split("  ", 1)
            if name in expected_sums or not re.fullmatch(r"[a-f0-9]{64}", digest):
                raise PublishError("INVALID_PACKAGE_CHECKSUMS")
            expected_sums[name] = digest
        for name in [*expected, "manifest.json", "setup.json"]:
            if expected_sums.get(name) != hashlib.sha256(
                archive.read(root + "assets/" + name)
            ).hexdigest():
                raise PublishError("PACKAGE_CHECKSUM_MISMATCH")
    outer = {
        "schema": 2,
        "kind": "codey-machine-skill",
        "releaseId": "machine-" + package_sha[:16],
        "installerReleaseId": manifest["releaseId"],
        "platform": "linux-x64",
        "registrationSchema": 2,
        "node": manifest["node"],
        "cloudcli": manifest["cloudcli"],
        "copilotApi": manifest["copilotApi"],
        "bundledRuntimes": ["cloudcli", "copilot-api", "updater"],
        "downloadedOfficialRuntimes": ["node", "codex", "devtunnel"],
        "package": {"file": PACKAGE_NAME, "size": size, "sha256": package_sha},
    }
    return file, outer, (json.dumps(outer, indent=2) + "\n").encode()


class AzureStore:
    def __init__(self, config):
        from azure.core.exceptions import ResourceExistsError, ResourceNotFoundError
        from azure.storage.fileshare import ShareClient
        self.exists = ResourceExistsError
        self.not_found = ResourceNotFoundError
        self.directory = config["directory"]
        result = subprocess.run(azure_cli_command([
            "storage", "account", "keys", "list",
            "--subscription", config["subscription"],
            "--resource-group", config["resourceGroup"],
            "--account-name", config["storageAccount"],
            "--query", "[0].value", "--only-show-errors", "-o", "json",
        ]), capture_output=True, text=True, timeout=60)
        if result.returncode:
            raise PublishError("AZURE_CREDENTIAL_LOOKUP_FAILED")
        self.share = ShareClient(
            f"https://{config['storageAccount']}.file.core.windows.net",
            share_name=config["share"], credential=json.loads(result.stdout),
            connection_timeout=15, read_timeout=60,
        )

    def target(self, name):
        return self.directory + "/" + checked_name(name)

    def ensure_directory(self, value):
        built = []
        for part in value.split("/"):
            built.append(part)
            try:
                self.share.get_directory_client("/".join(built)).create_directory()
            except self.exists:
                pass

    def ensure_root(self):
        self.share.get_share_properties()
        self.ensure_directory(self.directory)

    def list_root(self):
        return [item["name"] for item in self.share.get_directory_client(self.directory).list_directories_and_files()]

    def mkdir(self, name, exclusive=False):
        target = self.target(name)
        if exclusive:
            try:
                self.share.get_directory_client(target).create_directory()
            except self.exists as error:
                raise FileExistsError(name) from error
        else:
            self.ensure_directory(target)

    def read(self, name, limit):
        client = self.share.get_file_client(self.target(name))
        try:
            if client.get_file_properties().size > limit:
                raise PublishError("STORE_FILE_TOO_LARGE")
            return client.download_file().readall()
        except self.not_found:
            return None

    def verify_file(self, name, size, digest):
        client = self.share.get_file_client(self.target(name))
        try:
            properties = client.get_file_properties()
        except self.not_found:
            return False
        if properties.size != size or properties.metadata.get("sha256") != digest:
            raise PublishError("IMMUTABLE_RELEASE_COLLISION")
        return True

    def write_bytes_new(self, name, data):
        client = self.share.get_file_client(self.target(name))
        try:
            client.get_file_properties()
            raise PublishError("REFUSING_EXISTING_FILE")
        except self.not_found:
            pass
        self.ensure_directory(self.target(name).rsplit("/", 1)[0])
        client.upload_file(data, metadata={"sha256": hashlib.sha256(data).hexdigest()})

    def write_file_new(self, name, file, size, digest):
        if self.verify_file(name, size, digest):
            return
        self.ensure_directory(self.target(name).rsplit("/", 1)[0])
        with Path(file).open("rb") as stream:
            self.share.get_file_client(self.target(name)).upload_file(
                stream, length=size, max_concurrency=4, metadata={"sha256": digest},
            )
        if not self.verify_file(name, size, digest):
            raise PublishError("UPLOADED_FILE_MISMATCH")

    def replace(self, source, destination):
        self.share.get_file_client(self.target(source)).rename_file(
            self.target(destination), overwrite=True,
        )

    def unlink(self, name):
        try:
            self.share.get_file_client(self.target(name)).delete_file()
        except self.not_found:
            pass

    def rmdir(self, name):
        self.share.get_directory_client(self.target(name)).delete_directory()


def load_config(file):
    config = json.loads(Path(file).read_text())
    required = {"subscription", "resourceGroup", "storageAccount", "share", "directory"}
    if set(config) != required or any(not isinstance(value, str) or not value for value in config.values()):
        raise PublishError("INVALID_PUBLISH_CONFIG")
    checked_name(config["directory"])
    if config["directory"].split("/")[-2:] != ["machine-bundles", "packages-v2"]:
        raise PublishError("TARGET_MUST_BE_MACHINE_PACKAGE_V2")
    return config


def active(raw):
    if raw is None:
        return None
    value = json.loads(raw)
    if (value.get("schema") != 1 or not RELEASE.fullmatch(value.get("releaseId", ""))
            or not re.fullmatch(r"[a-f0-9]{64}", value.get("manifestSha256", ""))):
        raise PublishError("INVALID_ACTIVE_DESCRIPTOR")
    return value


def publish(store, package_file, manifest, manifest_raw, expected_current):
    expected = None if expected_current == "none" else expected_current
    if expected is not None and not RELEASE.fullmatch(expected):
        raise PublishError("INVALID_EXPECTED_CURRENT")
    store.ensure_root()
    marker = store.read(".codey-machine-skill-store.json", 1024)
    if marker is None:
        if store.list_root():
            raise PublishError("REFUSING_NON_MACHINE_PACKAGE_DIRECTORY")
        store.write_bytes_new(".codey-machine-skill-store.json", MARKER)
    elif marker != MARKER:
        raise PublishError("INVALID_MACHINE_PACKAGE_STORE")
    try:
        store.mkdir("publish.lock", exclusive=True)
    except FileExistsError:
        raise PublishError("MACHINE_PACKAGE_PUBLISH_LOCKED") from None
    transaction = uuid.uuid4().hex
    owner = (json.dumps({"transaction": transaction, "pid": os.getpid()}) + "\n").encode()
    temporary = f".active-{transaction}.tmp"
    committed = False
    try:
        store.write_bytes_new("publish.lock/owner.json", owner)
        previous_raw = store.read("active.json", 1024)
        previous = active(previous_raw)
        if (previous["releaseId"] if previous else None) != expected:
            raise PublishError("ACTIVE_RELEASE_CHANGED")
        release_root = "releases/" + manifest["releaseId"]
        store.mkdir(release_root)
        package = manifest["package"]
        store.write_file_new(
            release_root + "/" + PACKAGE_NAME,
            package_file, package["size"], package["sha256"],
        )
        manifest_name = release_root + "/manifest.json"
        existing = store.read(manifest_name, 16384)
        if existing is None:
            store.write_bytes_new(manifest_name, manifest_raw)
        elif existing != manifest_raw:
            raise PublishError("IMMUTABLE_MANIFEST_COLLISION")
        if store.read("active.json", 1024) != previous_raw:
            raise PublishError("ACTIVE_DESCRIPTOR_CHANGED_DURING_UPLOAD")
        descriptor = {
            "schema": 1, "releaseId": manifest["releaseId"],
            "manifestSha256": hashlib.sha256(manifest_raw).hexdigest(),
        }
        descriptor_raw = (json.dumps(descriptor, separators=(",", ":")) + "\n").encode()
        store.write_bytes_new(temporary, descriptor_raw)
        store.replace(temporary, "active.json")
        committed = True
        if store.read("active.json", 1024) != descriptor_raw:
            raise PublishError("ACTIVATION_VERIFICATION_FAILED")
        report = {
            "schema": 1, "committed": True, "previous": previous, "active": descriptor,
            "packageSha256": package["sha256"], "packageBytes": package["size"],
            "publishedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "acaDeployments": 0, "serviceRestarts": 0, "oldReleasesRetained": True,
        }
        store.write_bytes_new(
            f"history/{transaction}.json", (json.dumps(report, indent=2) + "\n").encode(),
        )
        return report
    except Exception as error:
        if committed:
            raise PublishError("ACTIVATION_COMMITTED_CHECK_STORE_BEFORE_RETRY") from error
        raise
    finally:
        store.unlink(temporary)
        if store.read("publish.lock/owner.json", 1024) != owner:
            raise PublishError("LOCK_OWNERSHIP_CHANGED")
        store.unlink("publish.lock/owner.json")
        store.rmdir("publish.lock")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True)
    parser.add_argument("--package", required=True)
    parser.add_argument("--expected-current", required=True)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    package_file, manifest, manifest_raw = inspect_package(args.package)
    if not args.apply:
        print(json.dumps({
            "dryRun": True, "releaseId": manifest["releaseId"],
            "package": manifest["package"], "azureRequests": 0,
        }, indent=2))
        return
    report = publish(
        AzureStore(load_config(args.config)), package_file, manifest, manifest_raw,
        args.expected_current,
    )
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
