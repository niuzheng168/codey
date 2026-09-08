"""Owner-only, hidden Windows process supervisor; no updater/model/network API."""
import argparse
import ctypes
from ctypes import wintypes
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time

CREATE_NO_WINDOW = 0x08000000


def owner_context():
    if os.name != "nt":
        raise RuntimeError("native_windows_required")
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    advapi = ctypes.WinDLL("advapi32", use_last_error=True)
    kernel.GetCurrentProcess.restype = wintypes.HANDLE
    advapi.OpenProcessToken.argtypes = [wintypes.HANDLE, wintypes.DWORD, ctypes.POINTER(wintypes.HANDLE)]
    advapi.GetTokenInformation.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p,
                                         wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)]
    advapi.ConvertSidToStringSidW.argtypes = [ctypes.c_void_p, ctypes.POINTER(wintypes.LPWSTR)]
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.ProcessIdToSessionId.argtypes = [wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)]
    token = wintypes.HANDLE()
    if not advapi.OpenProcessToken(kernel.GetCurrentProcess(), 8, ctypes.byref(token)):
        raise RuntimeError("owner_token_unavailable")
    try:
        length = wintypes.DWORD()
        advapi.GetTokenInformation(token, 1, None, 0, ctypes.byref(length))
        buffer = ctypes.create_string_buffer(length.value)
        if not advapi.GetTokenInformation(token, 1, buffer, length, ctypes.byref(length)):
            raise RuntimeError("owner_sid_unavailable")
        sid = wintypes.LPWSTR()
        if not advapi.ConvertSidToStringSidW(ctypes.cast(buffer, ctypes.POINTER(ctypes.c_void_p))[0], ctypes.byref(sid)):
            raise RuntimeError("owner_sid_unavailable")
        try:
            value = sid.value
        finally:
            kernel.LocalFree(sid)
        elevated, session = wintypes.DWORD(), wintypes.DWORD()
        if not advapi.GetTokenInformation(token, 20, ctypes.byref(elevated), 4, ctypes.byref(length)):
            raise RuntimeError("owner_elevation_unavailable")
        if not kernel.ProcessIdToSessionId(os.getpid(), ctypes.byref(session)):
            raise RuntimeError("owner_session_unavailable")
        return {"sid": value, "elevated": bool(elevated.value), "sessionId": session.value}
    finally:
        kernel.CloseHandle(token)


def validate(config, component, context):
    if (config.get("schema") != 1 or config.get("ownerSid") != context["sid"]
            or context["elevated"] or context["sessionId"] <= 0
            or component not in ("copilot-api", "workspace")):
        raise RuntimeError("original_logged_on_unelevated_owner_required")
    root = Path(config["root"]).resolve()
    service = config["services"][component]
    for name in [config["nodeExe"], service["entry"], service["cwd"], config["runnerPath"]]:
        candidate = Path(name)
        if not candidate.is_absolute() or not candidate.exists() or not candidate.resolve().is_relative_to(root):
            raise RuntimeError("pinned_service_path_invalid")
    with Path(config["nodeExe"]).open("rb") as stream:
        if hashlib.file_digest(stream, "sha256").hexdigest() != config["nodeSha256"]:
            raise RuntimeError("pinned_node_changed")
    with Path(config["runnerPath"]).open("rb") as stream:
        if hashlib.file_digest(stream, "sha256").hexdigest() != config["runnerSha256"]:
            raise RuntimeError("pinned_supervisor_changed")
    return service


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--component", choices=["copilot-api", "workspace"], required=True)
    args = parser.parse_args()
    config = json.loads(args.config.read_text(encoding="utf-8-sig"))
    service = validate(config, args.component, owner_context())
    import msvcrt
    lock = args.config.with_name(args.component + ".lock")
    with lock.open("a+b") as stream:
        if stream.tell() == 0:
            stream.write(b"0")
            stream.flush()
        stream.seek(0)
        try:
            msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError:
            return
        environment = {key: value for key, value in os.environ.items()
                       if key.upper() not in ("CODEX_THREAD_ID", "CODEX_PARENT_THREAD_ID",
                                              "CODEX_INTERNAL_ORIGINATOR_OVERRIDE", "PSMODULEPATH")}
        environment.update(config["environment"])
        environment.update(service["environment"])
        delay = 5
        while True:
            # No shell, stdin, visible console, credential-bearing output, or
            # termination/adoption of processes created by somebody else.
            with subprocess.Popen(
                [config["nodeExe"], service["entry"], *service.get("arguments", [])],
                cwd=service["cwd"], env=environment, stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                creationflags=CREATE_NO_WINDOW,
            ) as child:
                started = time.monotonic()
                child.wait()
            delay = 5 if time.monotonic() - started >= 60 else min(60, delay * 2)
            time.sleep(delay)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Task Scheduler records failure; never print config or exception data.
        raise SystemExit(1)
