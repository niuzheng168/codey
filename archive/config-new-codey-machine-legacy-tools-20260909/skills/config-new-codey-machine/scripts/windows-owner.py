"""Read the current Windows owner, elevation and interactive session; no services."""
import ctypes
from ctypes import wintypes
import os

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
