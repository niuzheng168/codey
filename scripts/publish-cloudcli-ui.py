"""Publish one immutable UI package to a dedicated local or Azure Files store.

No VM commands, service restarts, model calls or secret files. A cooperative
writer lock and atomic active.json rename retain older releases for open tabs.
"""
import argparse
import datetime
import hashlib
import json
import logging
import os
from pathlib import Path
import re
import subprocess
import sys
import uuid

logging.disable(logging.CRITICAL)
PROJECT = Path(__file__).resolve().parent.parent
MARKER = b'{"schema":1,"kind":"codey-cloudcli-ui-store"}\n'
RELEASE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")


class PublishError(Exception):
    pass


def checked_name(name):
    if not isinstance(name, str) or len(name) > 512 or not re.fullmatch(r"[a-zA-Z0-9_./-]+", name) or name.startswith("/") or any(
        part in {"", ".", ".."} for part in name.split("/")
    ):
        raise PublishError("UNSAFE_STORE_PATH")
    return name


class LocalStore:
    def __init__(self, root):
        self.root = Path(root).absolute()
        if self.root.is_symlink():
            raise PublishError("STORE_SYMLINK")
        self.root = self.root.resolve()

    def target(self, name):
        target = self.root / checked_name(name)
        if target.resolve() != target or target.is_symlink():
            raise PublishError("STORE_SYMLINK")
        return target

    def ensure_root(self):
        self.root.mkdir(parents=True, exist_ok=True)

    def list_root(self):
        return [item.name for item in self.root.iterdir()]

    def mkdir(self, name, exclusive=False):
        self.target(name).mkdir(parents=not exclusive, exist_ok=not exclusive)

    def read(self, name, limit):
        target = self.target(name)
        try:
            with target.open("rb") as source:
                value = source.read(limit + 1)
            if len(value) > limit:
                raise PublishError("STORE_FILE_TOO_LARGE")
            return value
        except FileNotFoundError:
            return None

    def write_new(self, name, value):
        target = self.target(name)
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("xb") as output:
            output.write(value)
            output.flush()
            os.fsync(output.fileno())

    def replace(self, source, destination):
        os.replace(self.target(source), self.target(destination))

    def unlink(self, name):
        self.target(name).unlink(missing_ok=True)

    def rmdir(self, name):
        self.target(name).rmdir()


class AzureStore:
    def __init__(self, config):
        from azure.storage.fileshare import ShareClient
        from azure.core.exceptions import ResourceExistsError, ResourceNotFoundError
        self.not_found = ResourceNotFoundError
        self.exists = ResourceExistsError
        self.directory = config["directory"]
        self.directories = set()
        result = subprocess.run([
            "az", "storage", "account", "keys", "list", "--subscription", config["subscription"],
            "--resource-group", config["resourceGroup"], "--account-name", config["storageAccount"],
            "--query", "[0].value", "--only-show-errors", "-o", "json",
        ], capture_output=True, text=True, timeout=60)
        if result.returncode:
            raise PublishError("AZURE_CREDENTIAL_LOOKUP_FAILED")
        # The credential stays in memory and is never part of an argument, URL or report.
        self.share = ShareClient(
            f"https://{config['storageAccount']}.file.core.windows.net",
            share_name=config["share"], credential=json.loads(result.stdout),
            connection_timeout=15, read_timeout=30,
        )

    def target(self, name):
        return self.directory + "/" + checked_name(name)

    def ensure_directory(self, path):
        for index in range(1, len(path.split("/")) + 1):
            directory = "/".join(path.split("/")[:index])
            if directory in self.directories:
                continue
            try:
                self.share.get_directory_client(directory).create_directory()
            except self.exists:
                pass
            self.directories.add(directory)

    def ensure_root(self):
        # The existing share must already be mounted in the Portal; never create a share/resource.
        self.share.get_share_properties()
        self.ensure_directory(self.directory)

    def list_root(self):
        return [item["name"] for item in self.share.get_directory_client(self.directory).list_directories_and_files()]

    def mkdir(self, name, exclusive=False):
        if exclusive:
            try:
                self.share.get_directory_client(self.target(name)).create_directory()
            except self.exists as reason:
                raise FileExistsError(name) from reason
        else:
            self.ensure_directory(self.target(name))

    def read(self, name, limit):
        file = self.share.get_file_client(self.target(name))
        try:
            if file.get_file_properties().size > limit:
                raise PublishError("STORE_FILE_TOO_LARGE")
            value = file.download_file().readall()
            if len(value) > limit:
                raise PublishError("STORE_FILE_TOO_LARGE")
            return value
        except self.not_found:
            return None

    def write_new(self, name, value):
        file = self.share.get_file_client(self.target(name))
        try:
            file.get_file_properties()
            raise PublishError("REFUSING_EXISTING_FILE")
        except self.not_found:
            pass
        self.ensure_directory(self.target(name).rsplit("/", 1)[0])
        # All writes are under our exclusive publish.lock, and release paths are immutable.
        file.upload_file(value, metadata={"sha256": hashlib.sha256(value).hexdigest()})

    def replace(self, source, destination):
        self.share.get_file_client(self.target(source)).rename_file(self.target(destination), overwrite=True)

    def unlink(self, name):
        try:
            self.share.get_file_client(self.target(name)).delete_file()
        except self.not_found:
            pass

    def rmdir(self, name):
        self.share.get_directory_client(self.target(name)).delete_directory()


def node_command(arguments):
    result = subprocess.run(["node", str(PROJECT / "scripts/build-cloudcli-ui.mjs"), *arguments],
                            capture_output=True, text=True, cwd=PROJECT, timeout=360)
    if result.returncode:
        # Build/verification runs offline against source with no .env. Azure failures never print bodies.
        sys.stderr.write(result.stdout[-3000:] + result.stderr[-3000:])
        raise PublishError("UI_BUILD_OR_VERIFICATION_FAILED")
    return json.loads(result.stdout.strip().splitlines()[-1])


def read_package(directory):
    directory = Path(directory).resolve(strict=True)
    verified = node_command(["--verify", str(directory)])
    raw = (directory / "ui-package.json").read_bytes()
    manifest = json.loads(raw)
    if hashlib.sha256(raw).hexdigest() != verified["manifestSha256"]:
        raise PublishError("PACKAGE_CHANGED_DURING_VERIFICATION")
    return directory, manifest, raw, verified


def active_descriptor(raw):
    if raw is None:
        return None
    try:
        value = json.loads(raw)
        if value["schema"] != 1 or not RELEASE.fullmatch(value["release"]) or not re.fullmatch(
            r"[a-f0-9]{64}", value["manifestSha256"]
        ):
            raise ValueError()
        return value
    except (KeyError, TypeError, ValueError):
        raise PublishError("INVALID_ACTIVE_DESCRIPTOR") from None


def publish_package(store, directory, expected_current):
    package, manifest, manifest_bytes, verified = read_package(directory)
    expected = None if expected_current == "none" else expected_current
    if expected is not None and not RELEASE.fullmatch(expected):
        raise PublishError("INVALID_EXPECTED_CURRENT")
    store.ensure_root()
    marker = store.read(".codey-ui-store.json", 1024)
    if marker is None:
        if store.list_root():
            raise PublishError("REFUSING_NON_UI_DIRECTORY")
        store.write_new(".codey-ui-store.json", MARKER)
    elif marker != MARKER:
        raise PublishError("INVALID_UI_STORE")
    try:
        store.mkdir("publish.lock", exclusive=True)
    except FileExistsError:
        raise PublishError("UI_PUBLISH_LOCKED_DO_NOT_STEAL") from None
    transaction = uuid.uuid4().hex
    lock_owner = json.dumps({"transaction": transaction, "pid": os.getpid()}).encode()
    temporary = f".active-{transaction}.tmp"
    committed = False
    activation_attempted = False
    try:
        store.write_new("publish.lock/owner.json", lock_owner)
        previous_bytes = store.read("active.json", 1024)
        previous = active_descriptor(previous_bytes)
        if (previous["release"] if previous else None) != expected:
            raise PublishError("ACTIVE_RELEASE_CHANGED")
        release_root = "releases/" + manifest["release"]
        store.mkdir(release_root)
        for name, info in manifest["files"].items():
            body = (package / name).read_bytes()
            if len(body) != info["bytes"] or hashlib.sha256(body).hexdigest() != info["sha256"]:
                raise PublishError("PACKAGE_FILE_CHANGED")
            target = release_root + "/" + checked_name(name)
            existing = store.read(target, info["bytes"])
            if existing is None:
                store.write_new(target, body)
            elif existing != body:
                raise PublishError("IMMUTABLE_RELEASE_COLLISION")
            if store.read(target, info["bytes"]) != body:
                raise PublishError("UPLOADED_FILE_MISMATCH")
        manifest_target = release_root + "/ui-package.json"
        existing = store.read(manifest_target, 1024 * 1024)
        if existing is None:
            store.write_new(manifest_target, manifest_bytes)
        elif existing != manifest_bytes:
            raise PublishError("IMMUTABLE_MANIFEST_COLLISION")
        if store.read(manifest_target, 1024 * 1024) != manifest_bytes:
            raise PublishError("UPLOADED_MANIFEST_MISMATCH")
        # Detect out-of-band edits during upload. The cooperative writer lock
        # must remain held through rename; never steal it from another publisher.
        if store.read("active.json", 1024) != previous_bytes:
            raise PublishError("ACTIVE_DESCRIPTOR_CHANGED_DURING_UPLOAD")
        active = {"schema": 1, "release": manifest["release"], "manifestSha256": verified["manifestSha256"]}
        new_bytes = (json.dumps(active, separators=(",", ":")) + "\n").encode()
        store.write_new(temporary, new_bytes)
        activation_attempted = True
        store.replace(temporary, "active.json")
        committed = True
        if store.read("active.json", 1024) != new_bytes:
            raise PublishError("ACTIVATION_VERIFICATION_FAILED")
        report = {
            "schema": 1, "committed": True, "previous": previous, "active": active,
            "publishedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "fileCount": len(manifest["files"]), "cloudCliVersion": manifest["cloudCliVersion"],
            "apiContract": manifest["apiContract"], "sourceSha256": manifest["sourceSha256"],
            "nodeDeployments": 0, "serviceRestarts": 0, "oldReleasesRetained": True,
        }
        store.write_new(f"history/{transaction}.json", (json.dumps(report, indent=2) + "\n").encode())
        return report
    except Exception as reason:
        if committed:
            raise PublishError("ACTIVATION_COMMITTED_CHECK_STORE_BEFORE_RETRY") from reason
        if activation_attempted:
            raise PublishError("ACTIVATION_MAY_HAVE_COMMITTED_CHECK_STORE_BEFORE_RETRY") from reason
        raise
    finally:
        store.unlink(temporary)
        if store.read("publish.lock/owner.json", 1024) != lock_owner:
            raise PublishError("LOCK_OWNERSHIP_CHANGED_DO_NOT_REMOVE")
        store.unlink("publish.lock/owner.json")
        store.rmdir("publish.lock")


def load_config(file):
    config = json.loads(Path(file).read_text())
    required = {"subscription", "resourceGroup", "storageAccount", "share", "directory"}
    if set(config) != required or any(not isinstance(value, str) or not value for value in config.values()):
        raise PublishError("INVALID_PUBLISH_CONFIG")
    if not re.fullmatch(r"[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}", config["subscription"]) or not re.fullmatch(
        r"[a-z0-9]{3,24}", config["storageAccount"]
    ) or not re.fullmatch(r"[a-z0-9][a-z0-9-]{1,61}[a-z0-9]", config["share"]):
        raise PublishError("INVALID_AZURE_TARGET")
    checked_name(config["directory"])
    if config["directory"].split("/")[-1] != "cloudcli-ui":
        raise PublishError("TARGET_MUST_BE_DEDICATED_CLOUDCLI_UI_DIRECTORY")
    return config


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument("--config", help="Non-secret Azure Files target JSON")
    target.add_argument("--local", help="Local/shared filesystem UI root, for development or mounted storage")
    parser.add_argument("--package", help="Previously built package directory; omit to build and test once")
    parser.add_argument("--apply", action="store_true", help="Actually publish; default is offline dry-run")
    parser.add_argument("--expected-current", help="Current release ID, or 'none' for the first publication")
    args = parser.parse_args()
    if args.apply and args.expected_current is None:
        parser.error("--apply requires --expected-current RELEASE (or none)")
    config = load_config(args.config) if args.config else None
    directory = args.package
    if not directory:
        print("Building and testing one shared Workspace UI package...", flush=True)
        directory = node_command(["--test"])["directory"]
    _, manifest, _, verified = read_package(directory)
    if not args.apply:
        print(json.dumps({
            "dryRun": True, "azureRequests": 0, "nodeDeployments": 0,
            "package": verified, "cloudCliVersion": manifest["cloudCliVersion"], "apiContract": manifest["apiContract"],
            "target": config or {"directory": str(Path(args.local).absolute())},
        }, indent=2))
        return
    store = AzureStore(config) if config else LocalStore(args.local)
    print(json.dumps(publish_package(store, directory, args.expected_current), indent=2))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"failed": True, "code": str(error) if isinstance(error, PublishError) else type(error).__name__}))
        sys.exit(1)
