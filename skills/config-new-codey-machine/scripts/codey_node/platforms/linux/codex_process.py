"""Recognize and stop only this owner's Codex app-server processes."""
import os
from pathlib import Path
import signal
import time

from ...common.errors import SetupError


def recognized(home, executable, arguments):
    home, executable = Path(home), Path(executable)
    if "app-server" not in arguments:
        return False
    if executable.name == "node" and len(arguments) >= 2:
        script = Path(arguments[1])
        try:
            script = script.resolve()
        except OSError:
            return False
        return script.is_relative_to(home) and script.as_posix().endswith("/@openai/codex/bin/codex.js")
    if not executable.is_relative_to(home):
        return False
    text = executable.as_posix()
    return "/@openai/codex" in text or "/codey-tools/codex/" in text


def record(home, pid):
    process = Path("/proc") / str(pid)
    info = process.stat()
    if info.st_uid != os.getuid():
        return None
    arguments = [part.decode("utf-8", "replace")
                 for part in (process / "cmdline").read_bytes().split(b"\0") if part]
    executable = (process / "exe").resolve()
    if not recognized(home, executable, arguments):
        return None
    fields = (process / "stat").read_text().split()
    return {"pid": pid, "start": fields[21], "executable": str(executable)}


def _model_key(pid):
    try:
        for item in (Path("/proc") / str(pid) / "environ").read_bytes().split(b"\0"):
            if item.startswith(b"CODEY_MODEL_API_KEY="):
                return item.split(b"=", 1)[1].decode()
    except (OSError, UnicodeError):
        pass
    return None


def inspect(home, current_key=None):
    rows = []
    for process in Path("/proc").iterdir():
        if not process.name.isdigit():
            continue
        try:
            item = record(Path(home), int(process.name))
            if item and (current_key is None or _model_key(item["pid"]) != current_key):
                rows.append(item)
        except (OSError, ValueError, UnicodeError):
            pass
    return sorted(rows, key=lambda item: item["pid"])


def stop(home, planned, *, term_seconds=10, kill_seconds=5):
    def same(item):
        try:
            return record(Path(home), item["pid"]) == item
        except (OSError, ValueError, UnicodeError):
            return False

    for item in planned:
        if not same(item):
            raise SetupError("A planned Codex app-server changed before it could be stopped")
    for item in planned:
        os.kill(item["pid"], signal.SIGTERM)
    deadline = time.monotonic() + term_seconds
    remaining = {item["pid"] for item in planned}
    while remaining and time.monotonic() < deadline:
        remaining = {item["pid"] for item in planned if item["pid"] in remaining and same(item)}
        time.sleep(0.2)
    for pid in remaining:
        expected = next(item for item in planned if item["pid"] == pid)
        if same(expected):
            os.kill(pid, signal.SIGKILL)
    deadline = time.monotonic() + kill_seconds
    while any(same(item) for item in planned) and time.monotonic() < deadline:
        time.sleep(0.2)
    if any(same(item) for item in planned):
        raise SetupError("A recognized old Codex app-server did not exit")
    return [item["pid"] for item in planned]
