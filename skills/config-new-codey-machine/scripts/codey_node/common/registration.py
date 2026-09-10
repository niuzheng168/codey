"""Validate static setup metadata and create one private local registration identity."""
import base64
import getpass
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import time
import urllib.parse

from .errors import SetupError


KEY_NAMES = ("clientSigningKey", "workspaceSsoKey", "tunnelUpdateKey", "updaterCredential")
CREDENTIAL_NAMES = (*KEY_NAMES, "workspaceSubject", "workspaceUsername")
NODE_ID = re.compile(r"n-[a-f0-9]{24}")
SUBJECT = re.compile(r"m-[a-f0-9]{24}")
KEY = re.compile(r"[A-Za-z0-9_-]{43}")
PORTAL_USERNAME = re.compile(r"[a-z][a-z0-9_-]{0,31}")
BASE_SETUP_FIELDS = {
    "schema", "portalOrigin", "releaseId", "platform", "network", "tunnelAuthProvider",
}


def package_fields(setup):
    return {
        "portalOrigin": setup["portalOrigin"],
        "releaseId": setup["releaseId"],
        "platform": setup["platform"],
    }


def _exact_origin(value):
    parsed = urllib.parse.urlsplit(value if isinstance(value, str) else "")
    if (parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password
            or parsed.path or parsed.query or parsed.fragment):
        raise SetupError("setup.json portalOrigin must be an exact HTTPS origin")


def validate_setup(setup, target_platform, *, now=None):
    expected = BASE_SETUP_FIELDS | ({"updater"} if target_platform == "linux-x64" else set())
    allowed = [expected]
    if target_platform == "windows-x64":
        allowed.append(expected | {"acceptance"})
    if not isinstance(setup, dict) or set(setup) not in allowed or setup.get("schema") != 1:
        raise SetupError("assets/setup.json does not match the static setup schema")
    if setup.get("platform") != target_platform:
        raise SetupError("This static package does not match the target platform")
    if (not re.fullmatch(r"machine-[a-f0-9]{16}", setup.get("releaseId", ""))
            or setup.get("network") != {"mode": "devtunnel"}
            or setup.get("tunnelAuthProvider") != "github"):
        raise SetupError("Static packages require a pinned release and GitHub DevTunnel")
    _exact_origin(setup.get("portalOrigin"))
    if target_platform == "linux-x64":
        updater = setup.get("updater")
        if (not isinstance(updater, dict) or set(updater) != {"protocol", "releasePublicKey"}
                or updater.get("protocol") != 1
                or not isinstance(updater.get("releasePublicKey"), str)
                or not 0 < len(updater["releasePublicKey"]) < 8192):
            raise SetupError("Linux setup.json must contain updater protocol 1 and its public release key")
    if "acceptance" in setup:
        acceptance = setup["acceptance"]
        current = int(time.time() * 1000) if now is None else now
        if (target_platform != "windows-x64" or not isinstance(acceptance, dict)
                or set(acceptance) != {"expectedComputerName", "expiresAt"}
                or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9-]{0,62}",
                                    acceptance.get("expectedComputerName", ""))
                or type(acceptance.get("expiresAt")) is not int
                or acceptance["expiresAt"] <= current
                or acceptance["expiresAt"] > current + 7 * 86400000):
            raise SetupError("Windows preview acceptance in setup.json is invalid or expired")
    return setup


def load_setup(skill, target_platform):
    """Load the public package contract and reject every personalized predecessor."""
    assets = Path(skill) / "assets"
    forbidden = (assets / "enrollment.json", assets / "codey-updater/config.json")
    if any(path.exists() or path.is_symlink() for path in forbidden):
        raise SetupError(
            "Legacy personalized package rejected: use a static package with assets/setup.json "
            "and no enrollment.json or bundled updater config"
        )
    file = assets / "setup.json"
    if file.is_symlink() or not file.is_file() or file.stat().st_size > 16 * 1024:
        raise SetupError("The static package must contain an ordinary assets/setup.json")
    try:
        setup = json.loads(file.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, ValueError) as error:
        raise SetupError("assets/setup.json is not valid UTF-8 JSON") from error
    return validate_setup(setup, target_platform)


def _username():
    if os.name == "posix":
        import pwd
        return pwd.getpwuid(os.getuid()).pw_name
    return getpass.getuser()


def _fingerprint(setup):
    encoded = json.dumps(setup, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()[:24]


def state_path(home, setup):
    home = Path(home).resolve()
    return home / ".local/state/codey-machine-bootstrap" / (
        setup["platform"] + "-" + _fingerprint(setup) + ".json"
    )


def _checked_state_path(home, setup, *, create):
    home = Path(home).resolve()
    file = state_path(home, setup)
    parent = file.parent
    if create:
        parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if parent.exists():
        actual = parent.resolve()
        if parent.is_symlink() or actual != parent or not actual.is_relative_to(home):
            raise SetupError("Local registration state directory must stay inside the owner Home and not be linked")
    return file


def _validate_username(value, platform):
    if (not isinstance(value, str) or not value or value != value.strip() or len(value) > 128
            or any(ord(character) < 32 for character in value) or "/" in value or "\\" in value):
        raise SetupError("The current OS username cannot be represented in a registration file")
    if not PORTAL_USERNAME.fullmatch(value):
        raise SetupError("The current OS username must match [a-z][a-z0-9_-]{0,31} for Portal SSO")


def _key_bytes(value):
    try:
        decoded = base64.urlsafe_b64decode(value + "=")
    except (ValueError, TypeError):
        raise SetupError("Persisted local registration key is invalid") from None
    if (not KEY.fullmatch(value) or len(decoded) != 32
            or base64.urlsafe_b64encode(decoded).decode().rstrip("=") != value):
        raise SetupError("Persisted local registration key is invalid")
    return decoded


def _validate_record(record, setup):
    if (not isinstance(record, dict) or set(record) != {"schema", "package", "nodeId", "credentials"}
            or record.get("schema") != 1 or record.get("package") != package_fields(setup)
            or not NODE_ID.fullmatch(record.get("nodeId", ""))):
        raise SetupError("Persisted local registration identity does not match this static package")
    credentials = record.get("credentials")
    if not isinstance(credentials, dict) or set(credentials) != set(CREDENTIAL_NAMES):
        raise SetupError("Persisted local registration credentials are incomplete")
    decoded = [_key_bytes(credentials.get(name, "")) for name in KEY_NAMES]
    if len(set(decoded)) != len(KEY_NAMES):
        raise SetupError("Local registration keys must be purpose-separated")
    if not SUBJECT.fullmatch(credentials.get("workspaceSubject", "")):
        raise SetupError("Persisted Workspace subject is invalid")
    _validate_username(credentials.get("workspaceUsername"), setup["platform"])
    return record


def _read(file, setup):
    info = file.lstat()
    if file.is_symlink() or not file.is_file() or info.st_size > 32 * 1024:
        raise SetupError("Local registration identity must be an ordinary private file")
    if os.name == "posix" and (info.st_uid != os.getuid() or info.st_mode & 0o077):
        raise SetupError("Local registration identity must be owned by this user with mode 0600")
    try:
        return _validate_record(json.loads(file.read_text(encoding="utf-8")), setup)
    except (OSError, UnicodeError, ValueError) as error:
        raise SetupError("Local registration identity is not valid JSON") from error


def existing(home, setup):
    file = _checked_state_path(home, setup, create=False)
    if not file.exists() and not file.is_symlink():
        return None
    return runtime_identity(setup, _read(file, setup))


def _new_key():
    return base64.urlsafe_b64encode(secrets.token_bytes(32)).decode().rstrip("=")


def _create_once(file, record):
    temporary = file.with_name(file.name + "." + secrets.token_hex(8) + ".next")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(record, stream, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        try:
            os.link(temporary, file)
            return True
        except FileExistsError:
            return False
    finally:
        temporary.unlink(missing_ok=True)


def load_or_create(home, setup, *, username=None):
    """Persist before network/service changes so a failed rerun keeps the same identity."""
    file = _checked_state_path(home, setup, create=True)
    parent = file.parent
    if os.name == "posix":
        info = parent.stat()
        if info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise SetupError("Local registration state directory must be owner-only")
        parent.chmod(0o700)
    if file.exists() or file.is_symlink():
        return runtime_identity(setup, _read(file, setup))
    values = []
    while len(values) != len(KEY_NAMES):
        candidate = _new_key()
        if candidate not in values:
            values.append(candidate)
    current_user = _username() if username is None else username
    _validate_username(current_user, setup["platform"])
    credentials = dict(zip(KEY_NAMES, values))
    credentials.update({
        "workspaceSubject": "m-" + secrets.token_hex(12),
        "workspaceUsername": current_user,
    })
    record = {
        "schema": 1,
        "package": package_fields(setup),
        "nodeId": "n-" + secrets.token_hex(12),
        "credentials": credentials,
    }
    _validate_record(record, setup)
    if not _create_once(file, record):
        record = _read(file, setup)
    if os.name == "posix":
        file.chmod(0o600)
    return runtime_identity(setup, record)


def runtime_identity(setup, record):
    credentials = record["credentials"]
    return {
        "nodeId": record["nodeId"],
        **package_fields(setup),
        "network": {"mode": "devtunnel"},
        "tunnelAuthProvider": "github",
        **credentials,
    }


def updater_config(setup, identity):
    return {
        "schema": 1,
        "nodeId": identity["nodeId"],
        "ownerId": identity["workspaceSubject"],
        "username": identity["workspaceUsername"],
        "portalOrigin": setup["portalOrigin"],
        "credential": identity["updaterCredential"],
        "releasePublicKey": setup["updater"]["releasePublicKey"],
        "protocol": setup["updater"]["protocol"],
    }


def exported_credentials(identity):
    return {name: identity[name] for name in CREDENTIAL_NAMES}


def document(setup, identity, machine, connect_token):
    return {
        "schema": 2,
        "package": package_fields(setup),
        "machine": machine,
        "credentials": exported_credentials(identity),
        "devTunnelConnectToken": connect_token,
    }
