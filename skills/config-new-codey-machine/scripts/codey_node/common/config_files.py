"""Owner-bound, non-link configuration snapshots and backed-up atomic writes."""
from contextlib import contextmanager
from dataclasses import dataclass, field
import os
from pathlib import Path
import secrets
import stat
import time

from .errors import SetupError

LIMIT = 16 * 1024 * 1024


def absolute(value):
    path = Path(value)
    if (not path.is_absolute() or ".." in path.parts or any(ord(char) < 32 for char in str(path))
            or (os.name == "nt" and (path.drive.startswith("\\") or any(
                any(char in part for char in '<>:"|?*') or part.endswith((".", " ")) or
                part.split(".")[0].upper() in {"CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$", *(f"COM{i}" for i in range(10)),
                                               *(f"LPT{i}" for i in range(10))}
                for part in path.parts[1:])))):
        raise SetupError("Configuration targets must be explicit absolute local paths without traversal or aliases")
    return path


def current_identity():
    if os.name == "nt":
        from ..platforms.windows.owner import owner_context
        context = owner_context()
        if context["elevated"]:
            raise SetupError("Configure defaults as the original non-elevated owner")
        return context["sid"]
    if os.getuid() == 0 or os.getuid() != os.geteuid():
        raise SetupError("Configure defaults as the target owner, not root or a different effective user")
    return os.getuid()


def windows_owner(path):
    import ctypes
    from ctypes import wintypes
    advapi, kernel = ctypes.WinDLL("advapi32", use_last_error=True), ctypes.WinDLL("kernel32", use_last_error=True)
    pointer = ctypes.c_void_p
    advapi.GetNamedSecurityInfoW.argtypes = [wintypes.LPWSTR, wintypes.DWORD, wintypes.DWORD,
                                            ctypes.POINTER(pointer), pointer, pointer, pointer, ctypes.POINTER(pointer)]
    advapi.GetNamedSecurityInfoW.restype = wintypes.DWORD
    advapi.ConvertSidToStringSidW.argtypes = [pointer, ctypes.POINTER(wintypes.LPWSTR)]
    kernel.LocalFree.argtypes = [pointer]
    descriptor, sid, text = pointer(), pointer(), wintypes.LPWSTR()
    if advapi.GetNamedSecurityInfoW(str(path), 1, 1, ctypes.byref(sid), None, None, None, ctypes.byref(descriptor)):
        raise SetupError("Cannot verify the configuration target's Windows owner")
    try:
        if not advapi.ConvertSidToStringSidW(sid, ctypes.byref(text)):
            raise SetupError("Cannot verify the configuration target's Windows SID")
        try:
            return text.value
        finally:
            kernel.LocalFree(text)
    finally:
        kernel.LocalFree(descriptor)


@contextmanager
def _windows_security(identity, *, directory=False):
    import ctypes
    from ctypes import wintypes
    class Attributes(ctypes.Structure):
        _fields_ = [("length", wintypes.DWORD), ("descriptor", ctypes.c_void_p), ("inherit", wintypes.BOOL)]
    advapi, kernel = ctypes.WinDLL("advapi32", use_last_error=True), ctypes.WinDLL("kernel32", use_last_error=True)
    advapi.ConvertStringSecurityDescriptorToSecurityDescriptorW.argtypes = [
        wintypes.LPCWSTR, wintypes.DWORD, ctypes.POINTER(ctypes.c_void_p), ctypes.c_void_p]
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    descriptor = ctypes.c_void_p()
    flags = "OICI" if directory else ""
    sddl = f"D:P(A;{flags};FA;;;{identity})(A;{flags};FA;;;SY)(A;{flags};FA;;;BA)"
    if not advapi.ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, ctypes.byref(descriptor), None):
        raise SetupError("Cannot create an owner-private configuration file")
    try:
        yield Attributes(ctypes.sizeof(Attributes), descriptor, False)
    finally:
        kernel.LocalFree(descriptor)


def _create(path, identity, *, directory=False):
    if os.name != "nt":
        if directory:
            path.mkdir(mode=0o700)
            return
        return os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    import ctypes
    from ctypes import wintypes
    import msvcrt
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    with _windows_security(identity, directory=directory) as attributes:
        if directory:
            kernel.CreateDirectoryW.argtypes = [wintypes.LPCWSTR, ctypes.c_void_p]
            if not kernel.CreateDirectoryW(str(path), ctypes.byref(attributes)):
                raise ctypes.WinError(ctypes.get_last_error())
            return
        kernel.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p,
                                      wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
        kernel.CreateFileW.restype = wintypes.HANDLE
        handle = kernel.CreateFileW(str(path), 0x40000000, 0, ctypes.byref(attributes), 1, 0x00200080, None)
        if handle == wintypes.HANDLE(-1).value:
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            return msvcrt.open_osfhandle(handle, os.O_WRONLY | os.O_BINARY)
        except Exception:
            kernel.CloseHandle.argtypes = [wintypes.HANDLE]
            kernel.CloseHandle(handle)
            raise


@dataclass(frozen=True)
class Owner:
    home: Path
    identity: object

    @classmethod
    def target(cls, home=None):
        owner = cls(absolute(home if home is not None else Path.home()), current_identity())
        if not owner.check(owner.home).is_dir():
            raise SetupError("The target owner home must already exist")
        return owner

    def check(self, value):
        path = absolute(value)
        chain = (path, *path.parents)
        nearest = True
        for part in chain:
            try:
                info = part.lstat()
            except FileNotFoundError:
                continue
            if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
                raise SetupError(f"Refusing a linked/reparse configuration path: {part}")
            if not (stat.S_ISDIR(info.st_mode) or (part == path and stat.S_ISREG(info.st_mode))):
                raise SetupError("Configuration paths must contain only ordinary directories and regular files")
            if stat.S_ISREG(info.st_mode) and info.st_nlink != 1:
                raise SetupError(f"Refusing a hard-linked configuration file: {part}")
            identity = windows_owner(part) if os.name == "nt" else info.st_uid
            trusted = {self.identity, "S-1-5-18", "S-1-5-32-544",
                       "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464"} if os.name == "nt" else {self.identity, 0}
            strict = nearest or part.is_relative_to(self.home)
            if identity not in ({self.identity} if strict else trusted):
                raise SetupError(f"Configuration path belongs to a different owner: {part}")
            nearest = False
        if path.resolve() != path:
            raise SetupError("Configuration path has an unresolved alias")
        return path

    def mkdir(self, directory):
        directory = self.check(directory)
        if directory.exists():
            if not directory.is_dir():
                raise SetupError("Expected a configuration directory")
            return
        self.mkdir(directory.parent)
        self.check(directory)
        _create(directory, self.identity, directory=True)
        self.check(directory)

    def read(self, value):
        path = self.check(value)
        try:
            before = path.lstat()
        except FileNotFoundError:
            return Snapshot(path, None, None)
        if not stat.S_ISREG(before.st_mode) or before.st_size > LIMIT:
            raise SetupError("Expected a bounded regular configuration file")
        flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
        with os.fdopen(os.open(path, flags), "rb") as stream:
            if fingerprint(os.fstat(stream.fileno())) != fingerprint(before):
                raise SetupError("Configuration changed while it was being read")
            data = stream.read(LIMIT + 1)
            after = os.fstat(stream.fileno())
        self.check(path)
        if len(data) > LIMIT or fingerprint(after) != fingerprint(path.lstat()) or fingerprint(after) != fingerprint(before):
            raise SetupError("Configuration changed while it was being read")
        return Snapshot(path, data, fingerprint(after))

    def write_new(self, value, data):
        path = self.check(value)
        descriptor = _create(path, self.identity)
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        self.check(path)


def fingerprint(info):
    # Python 3.12 Windows stat/fstat disagree on the deprecated ctime field.
    created_or_changed = getattr(info, "st_birthtime_ns", 0) if os.name == "nt" else info.st_ctime_ns
    return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, created_or_changed, info.st_mode


def stable_fingerprint(version):
    """Ignore same-byte atomic rewrites while retaining filesystem and mode checks."""
    return None if version is None else (version[0], version[5])


@dataclass(frozen=True)
class Snapshot:
    path: Path
    data: bytes | None = field(repr=False)
    version: tuple | None = field(repr=False)

    def verify(self, owner):
        actual = owner.read(self.path)
        if actual.data != self.data or stable_fingerprint(actual.version) != stable_fingerprint(self.version):
            raise SetupError(f"Configuration changed since planning; re-plan before applying: {self.path}")


@dataclass(frozen=True)
class Change:
    before: Snapshot
    data: bytes = field(repr=False)

    @property
    def changed(self):
        return self.before.data != self.data


def _replace(source, destination):
    for attempt in range(6):
        try:
            os.replace(source, destination)
            break
        except OSError as error:
            if os.name != "nt" or getattr(error, "winerror", None) not in (5, 32, 33) or attempt == 5:
                raise
            time.sleep(0.05 * (attempt + 1))
    if os.name != "nt":
        descriptor = os.open(destination.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)


def commit(owner, changes, *, watches=()):
    """Preflight every input, back up every old file, then atomically replace each file."""
    paths = [item.before.path for item in changes]
    if len(paths) != len(set(paths)):
        raise SetupError("Configuration targets overlap; no files were changed")
    for snapshot in (*watches, *(item.before for item in changes)):
        snapshot.verify(owner)
    changed = [item for item in changes if item.changed]
    backups, stages, installed = [], [], []
    tag = time.strftime("%Y%m%dT%H%M%S", time.gmtime()) + "-" + secrets.token_hex(8)
    try:
        for item in changed:
            target = item.before.path
            owner.mkdir(target.parent)
            item.before.verify(owner)
            if item.before.data is not None:
                backup = target.with_name(target.name + ".codey-defaults-" + tag + ".bak")
                owner.write_new(backup, item.before.data)
                backups.append(str(backup))
            stage = target.with_name(target.name + ".codey-defaults-" + tag + ".next")
            stages.append(stage)
            owner.write_new(stage, item.data)
        for snapshot in (*watches, *(item.before for item in changes)):
            snapshot.verify(owner)
        for item, stage in zip(changed, stages):
            item.before.verify(owner)
            if owner.read(stage).data != item.data:
                raise SetupError("Staged configuration changed before atomic replacement")
            installed.append(item)
            _replace(stage, item.before.path)
            if owner.read(item.before.path).data != item.data:
                raise SetupError("Configuration verification failed after atomic replacement")
    except Exception:
        # Roll back only our bytes. Concurrent owner edits are never discarded.
        for item in reversed(installed):
            target = item.before.path
            restore = target.with_name(target.name + ".codey-defaults-" + tag + ".restore")
            try:
                if owner.read(target).data != item.data:
                    continue
                if item.before.data is None:
                    owner.check(target).unlink()
                else:
                    owner.write_new(restore, item.before.data)
                    owner.check(target)
                    _replace(restore, target)
            except (OSError, SetupError):
                pass
            finally:
                if restore.exists():
                    owner.check(restore).unlink()
        raise
    finally:
        for stage in stages:
            if stage.exists():
                owner.check(stage).unlink()
    return backups
