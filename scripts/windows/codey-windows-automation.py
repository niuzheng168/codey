"""Owner-bound Windows watchdogs and connect-token renewal.

Run with Azure CLI's Python -I -B. Never run Workspace as SYSTEM, copy sign-in
caches, log child output/credentials, or mutate the protected copilot-api.
"""
import argparse
import base64
from contextlib import contextmanager
import copy
import ctypes
from ctypes import wintypes
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import uuid

ARM = "https://management.azure.com"
API = "2025-07-01"
DEPLOY_API = "2022-09-01"
SCHEMA = "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#"
MARKER = "codey-windows-automation-v1"
CREATE_NO_WINDOW = 0x08000000


class SafeError(Exception):
    """Only fixed, credential-free codes may cross the worker boundary."""


class InventoryUnavailable(SafeError):
    """A transient observation failure is not evidence that a service exited."""


def require(value, code):
    if not value:
        raise SafeError(code)


def now():
    return datetime.now(timezone.utc).isoformat()


def read(file, default=None):
    try:
        return json.loads(Path(file).read_text(encoding="utf-8-sig"))
    except FileNotFoundError:
        return default


def save(file, value):
    file = Path(file)
    temporary = file.with_name(file.name + f".{os.getpid()}.tmp")
    require(temporary.parent.resolve() == file.parent.resolve(), "unsafe_state_path")
    temporary.write_text(json.dumps(value, indent=2), encoding="utf-8")
    os.replace(temporary, file)


def clean(value):
    if isinstance(value, dict):
        return {key: clean(item) for key, item in value.items() if item is not None}
    if isinstance(value, list):
        return [clean(item) for item in value]
    return value


def ensure_standard_streams():
    # pythonw.exe has no console streams. Azure CLI/Knack still calls isatty()
    # while constructing Profile, so provide null handles without opening a
    # visible console or persisting potentially sensitive diagnostic output.
    for name, mode in [("stdin", "r"), ("stdout", "w"), ("stderr", "w")]:
        if getattr(sys, name) is None:
            setattr(sys, name, open(os.devnull, mode, encoding="utf-8"))


def windows_context():
    require(os.name == "nt", "windows_required")
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    advapi = ctypes.WinDLL("advapi32", use_last_error=True)
    kernel.GetCurrentProcess.restype = wintypes.HANDLE
    advapi.OpenProcessToken.argtypes = [wintypes.HANDLE, wintypes.DWORD, ctypes.POINTER(wintypes.HANDLE)]
    advapi.GetTokenInformation.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p,
                                          wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)]
    advapi.ConvertSidToStringSidW.argtypes = [ctypes.c_void_p, ctypes.POINTER(wintypes.LPWSTR)]
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    kernel.LocalFree.restype = ctypes.c_void_p
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.ProcessIdToSessionId.argtypes = [wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)]
    token = wintypes.HANDLE()
    require(advapi.OpenProcessToken(kernel.GetCurrentProcess(), 8, ctypes.byref(token)), "token_open_failed")
    try:
        length = wintypes.DWORD()
        advapi.GetTokenInformation(token, 1, None, 0, ctypes.byref(length))
        buffer = ctypes.create_string_buffer(length.value)
        require(advapi.GetTokenInformation(token, 1, buffer, length, ctypes.byref(length)), "token_user_failed")
        sid_pointer = ctypes.cast(buffer, ctypes.POINTER(ctypes.c_void_p))[0]
        text = wintypes.LPWSTR()
        require(advapi.ConvertSidToStringSidW(sid_pointer, ctypes.byref(text)), "sid_conversion_failed")
        try:
            sid = text.value
        finally:
            kernel.LocalFree(text)
        elevated = wintypes.DWORD()
        require(advapi.GetTokenInformation(token, 20, ctypes.byref(elevated), 4, ctypes.byref(length)),
                "token_elevation_failed")
        session = wintypes.DWORD()
        require(kernel.ProcessIdToSessionId(os.getpid(), ctypes.byref(session)), "session_lookup_failed")
        return {"sid": sid, "elevated": bool(elevated.value), "sessionId": session.value}
    finally:
        kernel.CloseHandle(token)


def process_alive(pid):
    if not isinstance(pid, int) or pid <= 0:
        return False
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    handle = kernel.OpenProcess(0x100000, False, pid)
    if not handle:
        return ctypes.get_last_error() != 87  # Access denied is not proof of a dead process.
    try:
        return kernel.WaitForSingleObject(handle, 0) == 258
    finally:
        kernel.CloseHandle(handle)


def windows_argv(command):
    if not command:
        return []
    shell = ctypes.WinDLL("shell32", use_last_error=True)
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    shell.CommandLineToArgvW.argtypes = [wintypes.LPCWSTR, ctypes.POINTER(ctypes.c_int)]
    shell.CommandLineToArgvW.restype = ctypes.POINTER(wintypes.LPWSTR)
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    kernel.LocalFree.restype = ctypes.c_void_p
    count = ctypes.c_int()
    arguments = shell.CommandLineToArgvW(command, ctypes.byref(count))
    require(bool(arguments), "command_line_parse_failed")
    try:
        return [arguments[index] for index in range(count.value)]
    finally:
        kernel.LocalFree(arguments)


@contextmanager
def singleton(file):
    import msvcrt
    with open(file, "a+b") as stream:
        stream.seek(0)
        if not stream.read(1):
            stream.write(b"0")
            stream.flush()
        stream.seek(0)
        try:
            msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError:
            raise SafeError("already_running")
        try:
            yield
        finally:
            stream.seek(0)
            msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)


def status(config, component, state, **fields):
    # Whitelisted structured state only: never child stdout, HTTP bodies, or exceptions.
    record = {"schema": 1, "component": component, "state": state, "updatedAt": now(),
              "workerPid": os.getpid(), **fields}
    save(Path(config["stateRoot"]) / (component + ".json"), record)
    return record


def load_config(file, enforce_context=True):
    config = read(file)
    require(config and config.get("schema") == 1, "invalid_automation_config")
    runtime = read(config["runtimeConfig"])
    require(runtime and runtime["ownerSid"] == config["ownerSid"], "runtime_owner_mismatch")
    require(runtime["host"] == "127.0.0.1" and runtime["port"] == 3001, "unsafe_workspace_binding")
    require(runtime["tunnelId"] == config["tunnelId"] + "." + config["clusterId"], "tunnel_mismatch")
    require(config["tokenEnvironment"] == "CODEY_WINDOWS_WORKSPACE_TUNNEL_TOKEN", "unexpected_secret_reference")
    require(config["appName"] == "codey", "unexpected_azure_app")
    require(re.fullmatch(r"[0-9a-f-]{36}", config["subscription"]), "invalid_subscription")
    require(re.fullmatch(r"[a-z0-9-]+", config["resourceGroup"]), "invalid_resource_group")
    require(re.fullmatch(r"[a-z0-9][a-z0-9-]{1,58}", config["tunnelId"]) and
            re.fullmatch(r"[a-z0-9]{2,12}", config["clusterId"]), "invalid_tunnel_id")
    require(3600 <= config["renewBeforeSeconds"] <= 43200, "unsafe_renewal_window")
    require(Path(config["stateRoot"]).is_dir(), "missing_private_state_directory")
    require(Path(config["deploymentLock"]).parent.is_dir(), "missing_deployment_lock_directory")
    for name in ["runtimeConfig", "powershellExe", "pythonExe", "workerPath",
                 "workspaceLauncher", "tunnelLauncher"]:
        require(Path(config[name]).is_absolute() and Path(config[name]).is_file(), "missing_automation_input")
    require(Path(__file__).resolve() == Path(config["workerPath"]).resolve(), "unexpected_worker_path")
    for name in ["workerPath", "workspaceLauncher", "tunnelLauncher"]:
        actual = hashlib.sha256(Path(config[name]).read_bytes()).hexdigest()
        require(actual.lower() == config["fileHashes"][name].lower(), "automation_input_changed")
    for name in ["nodeExe", "devtunnelExe"]:
        sha_name = "nodeSha256" if name == "nodeExe" else "devtunnelSha256"
        actual = hashlib.sha256(Path(runtime[name]).read_bytes()).hexdigest()
        require(actual.lower() == runtime[sha_name].lower(), "pinned_executable_changed")
    if enforce_context:
        context = windows_context()
        require(context["sid"] == config["ownerSid"], "wrong_windows_owner")
        require(not context["elevated"], "worker_must_not_be_elevated")
    return config, runtime


class Arm:
    def __init__(self, config):
        ensure_standard_streams()
        import requests
        from azure.cli.core._profile import Profile
        try:
            profile = Profile()
        except Exception:
            raise SafeError("azure_cli_initialization_failed") from None
        try:
            auth, _, _ = profile.get_raw_token(resource=ARM + "/", subscription=config["subscription"])
        except Exception:
            raise SafeError("azure_authentication_failed") from None
        self.config = config
        self.session = requests.Session()
        self.session.headers.update({"Authorization": "Bearer " + auth[1], "Content-Type": "application/json"})
        self.app_id = (f"/subscriptions/{config['subscription']}/resourceGroups/{config['resourceGroup']}"
                       f"/providers/Microsoft.App/containerApps/{config['appName']}")

    def request(self, method, resource, body=None, api=API, allow_missing=False):
        require(resource.startswith(f"/subscriptions/{self.config['subscription']}/"), "unexpected_arm_scope")
        require("/listsecrets" not in resource.lower(), "local_secret_export_forbidden")
        try:
            response = self.session.request(method, ARM + resource + "?api-version=" + api,
                                            json=body, timeout=60)
        except Exception:
            raise SafeError("azure_network_failure") from None
        if allow_missing and response.status_code == 404:
            return None
        require(response.ok, "azure_http_" + str(response.status_code))
        return response.json() if response.content else {}

    def app(self):
        return self.request("GET", self.app_id)

    def deployment_id(self, suffix):
        return (f"/subscriptions/{self.config['subscription']}/resourceGroups/{self.config['resourceGroup']}"
                f"/providers/Microsoft.Resources/deployments/{suffix}")


def stable_app(app):
    properties = app["properties"]
    require(properties["provisioningState"] == "Succeeded" and
            properties["latestRevisionName"] == properties["latestReadyRevisionName"], "azure_deployment_busy")


def unchanged(before, current):
    stable_app(current)
    require(clean(before["properties"]["template"]) == clean(current["properties"]["template"]) and
            comparable_configuration(before["properties"]["configuration"]) ==
            comparable_configuration(current["properties"]["configuration"]) and
            before.get("identity") == current.get("identity") and
            resource_settings(before) == resource_settings(current), "concurrent_azure_change")


def comparable_configuration(configuration):
    result = clean(copy.deepcopy(configuration))
    if "secrets" in result:
        names = [secret["name"] for secret in result["secrets"]]
        require(len(names) == len(set(names)), "duplicate_azure_secret_names")
        # listSecrets and GET containerApp do not guarantee the same order.
        # Compare exact names and metadata, never ignore added/removed secrets.
        result["secrets"] = sorted(result["secrets"], key=lambda secret: secret["name"])
    return result


def resource_settings(app):
    return clean({
        "location": app["location"], "tags": app.get("tags", {}),
        **{name: app["properties"].get(name) for name in
           ["managedEnvironmentId", "environmentId", "workloadProfileName"]},
    })


def secret_reference(app, config):
    portal = next(c for c in app["properties"]["template"]["containers"] if c["name"] == "portal")
    refs = [v for v in portal.get("env", []) if v["name"] == config["tokenEnvironment"]]
    require(len(refs) == 1 and refs[0].get("secretRef", "").startswith("winws-connect-"), "missing_tunnel_secret")
    name = refs[0]["secretRef"]
    secret = next(s for s in app["properties"]["configuration"]["secrets"] if s["name"] == name)
    require(not secret.get("keyVaultUrl"), "unexpected_keyvault_migration")
    return name


def connect_token(config, runtime):
    try:
        completed = subprocess.run([
            runtime["devtunnelExe"], "token", runtime["tunnelId"], "--scope", "connect", "--json",
        ], capture_output=True, text=True, encoding="utf-8", timeout=40, creationflags=CREATE_NO_WINDOW)
        require(completed.returncode == 0, "devtunnel_interactive_login_required")
        token = json.loads(completed.stdout)["token"]
        payload = token.split(".")[1]
        claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
        timestamp = time.time()
        require(claims["scp"] == "connect" and claims["tunnelId"] == config["tunnelId"] and
                claims["clusterId"] == config["clusterId"] and
                timestamp + 3600 < claims["exp"] <= timestamp + 90000, "unexpected_tunnel_credential")
        return token, datetime.fromtimestamp(claims["exp"], timezone.utc).isoformat()
    except SafeError:
        raise
    except Exception:
        raise SafeError("devtunnel_credential_failure") from None


def renewal_template(app, config, plan, app_id):
    properties = {name: copy.deepcopy(app["properties"][name]) for name in [
        "managedEnvironmentId", "environmentId", "workloadProfileName", "configuration", "template",
    ] if name in app["properties"]}
    properties["template"]["revisionSuffix"] = plan["suffix"]
    properties["configuration"].get("ingress", {}).pop("fqdn", None)
    properties["configuration"].pop("secrets", None)
    # Replace exactly the existing connect secret INSIDE Azure; do not accumulate
    # secrets or download any of the existing values into this Windows process.
    properties["configuration"]["copy"] = [{
        "name": "secrets", "count": "[length(parameters('existingSecrets').value)]",
        "input": ("[if(equals(parameters('existingSecrets').value[copyIndex('secrets')].name,"
                  "parameters('secretName')),createObject('name',parameters('secretName'),"
                  "'value',parameters('connectToken')),"
                  "parameters('existingSecrets').value[copyIndex('secrets')])]"),
    }]
    identity = copy.deepcopy(app["identity"])
    for name in ["principalId", "tenantId"]:
        identity.pop(name, None)
    if "userAssignedIdentities" in identity:
        identity["userAssignedIdentities"] = {key: {} for key in identity["userAssignedIdentities"]}
    inner = {
        "$schema": SCHEMA, "contentVersion": "1.0.0.0",
        "parameters": {"existingSecrets": {"type": "secureObject"},
                       "connectToken": {"type": "secureString"}, "secretName": {"type": "string"}},
        "resources": [{
            "type": "Microsoft.App/containerApps", "apiVersion": API, "name": config["appName"],
            "location": app["location"], "identity": identity, "tags": app.get("tags", {}),
            "properties": clean(properties),
        }],
    }
    return {
        "$schema": SCHEMA, "contentVersion": "1.0.0.0",
        "parameters": {"connectToken": {"type": "secureString"}},
        "resources": [{
            "type": "Microsoft.Resources/deployments", "apiVersion": DEPLOY_API,
            "name": plan["suffix"] + "-apply",
            "properties": {
                "mode": "Incremental", "expressionEvaluationOptions": {"scope": "inner"},
                "parameters": {
                    "existingSecrets": {"value": f"[listSecrets('{app_id}','{API}')]"},
                    "connectToken": {"value": "[parameters('connectToken')]"},
                    "secretName": {"value": plan["secretName"]},
                }, "template": inner,
            },
        }],
    }


def renewal_due(state, config, timestamp=None):
    timestamp = time.time() if timestamp is None else timestamp
    if not state.get("expiresAt"):
        return True
    return datetime.fromisoformat(state["expiresAt"]).timestamp() - timestamp <= config["renewBeforeSeconds"]


@contextmanager
def deployment_lock(config):
    lock = Path(config["deploymentLock"])
    owner = {"release": MARKER, "pid": os.getpid(), "createdAt": now()}
    try:
        with lock.open("x", encoding="utf-8") as output:
            json.dump(owner, output)
    except FileExistsError:
        previous = read(lock, {})
        # Recover only this worker's dead lock, never another deployment's lock.
        require(previous.get("release") == MARKER and not process_alive(int(previous.get("pid", 0))),
                "other_deployment_or_stale_lock")
        require(read(lock) == previous, "deployment_lock_changed")
        save(lock, owner)
    try:
        yield
    finally:
        if read(lock) == owner:
            lock.unlink()


def reconcile(arm, config, state):
    pending = state["pending"]
    endpoint = arm.deployment_id(pending["suffix"])
    deployment = arm.request("GET", endpoint, api=DEPLOY_API, allow_missing=True)
    if deployment is None:
        # A crash may precede submission. Do not resubmit an indeterminate PUT.
        require(time.time() - pending["createdEpoch"] > 900, "deployment_submission_indeterminate")
        stable_app(arm.app())
        state.pop("pending")
        return False
    phase = deployment["properties"]["provisioningState"]
    if phase in {"Failed", "Canceled"}:
        state["lastFailedDeployment"] = pending["suffix"]
        state.pop("pending")
        raise SafeError("azure_deployment_" + phase.lower())
    if phase != "Succeeded":
        return False
    app = arm.app()
    properties = app["properties"]
    previous_revision = config["appName"] + "--" + pending["beforeTemplate"]["revisionSuffix"]
    require(properties["latestRevisionName"] in {pending["revision"], previous_revision},
            "deployment_superseded")
    require(properties["provisioningState"] not in {"Failed", "Canceled"}, "azure_revision_failed")
    # ARM can finish the resource deployment before ACA's replicas become ready.
    # Keep reconciling the same operation; do not mint another token or start a
    # second deployment while the new revision is still starting.
    if (properties["provisioningState"] != "Succeeded" or
            properties["latestRevisionName"] != pending["revision"] or
            properties["latestReadyRevisionName"] != pending["revision"]):
        return False
    expected = copy.deepcopy(pending["beforeTemplate"])
    expected["revisionSuffix"] = pending["suffix"]
    require(clean(app["properties"]["template"]) == clean(expected), "unexpected_template_change")
    require(comparable_configuration(app["properties"]["configuration"]) ==
            comparable_configuration(pending["beforeConfiguration"]),
            "unexpected_configuration_change")
    require(app["identity"] == pending["beforeIdentity"], "unexpected_identity_change")
    require(resource_settings(app) == pending["beforeResourceSettings"], "unexpected_resource_change")
    state.update({"expiresAt": pending["expiresAt"], "secretName": pending["secretName"],
                  "revision": pending["revision"], "lastSucceededAt": now()})
    state.pop("pending")
    return True


def renew(config, runtime, validate_only=False):
    root = Path(config["stateRoot"])
    state_file = root / "renewal-state.json"
    state = read(state_file, {})
    if not state.get("pending") and not validate_only and not renewal_due(state, config):
        return status(config, "renew", "not_due", expiresAt=state["expiresAt"])
    with deployment_lock(config):
        arm = Arm(config)
        if state.get("pending"):
            deadline = time.monotonic() + 600
            while time.monotonic() < deadline:
                try:
                    complete = reconcile(arm, config, state)
                finally:
                    save(state_file, state)
                if complete:
                    return status(config, "renew", "renewed", expiresAt=state["expiresAt"], revision=state["revision"])
                if not state.get("pending"):
                    break
                status(config, "renew", "waiting_for_revision", revision=state["pending"]["revision"])
                time.sleep(5)
            require(not state.get("pending"), "azure_deployment_still_pending")
        app = arm.app()
        stable_app(app)
        secret = secret_reference(app, config)
        token, expiration = connect_token(config, runtime)
        suffix = "winws-r-" + datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:4]
        plan = {"suffix": suffix, "revision": config["appName"] + "--" + suffix,
                "secretName": secret, "expiresAt": expiration, "createdEpoch": time.time(),
                "beforeTemplate": clean(copy.deepcopy(app["properties"]["template"])),
                "beforeConfiguration": clean(copy.deepcopy(app["properties"]["configuration"])),
                "beforeIdentity": copy.deepcopy(app["identity"]),
                "beforeResourceSettings": resource_settings(app)}
        payload = {"properties": {
            "mode": "Incremental", "template": renewal_template(app, config, plan, arm.app_id),
            "parameters": {"connectToken": {"value": token}},
        }}
        endpoint = arm.deployment_id(suffix)
        arm.request("POST", endpoint + "/validate", payload, api=DEPLOY_API)
        if validate_only:
            return status(config, "renew", "validated_only", noAzureChange=True)
        unchanged(app, arm.app())
        state["pending"] = plan  # No credential value in the crash/reconciliation journal.
        save(state_file, state)
        arm.request("PUT", endpoint, payload, api=DEPLOY_API)
        status(config, "renew", "waiting_for_revision", revision=plan["revision"])
        deadline = time.monotonic() + 600
        while time.monotonic() < deadline:
            time.sleep(5)
            try:
                complete = reconcile(arm, config, state)
            finally:
                save(state_file, state)
            if complete:
                return status(config, "renew", "renewed", expiresAt=state["expiresAt"], revision=state["revision"])
        raise SafeError("azure_deployment_still_pending")


def matching_processes(config, runtime, component):
    # Metadata-only process lookup. Never print command lines or read process memory.
    script = r"""
      $ErrorActionPreference='Stop'
      [Console]::OutputEncoding = New-Object Text.UTF8Encoding $false
      $query="Name='$($env:CODEY_WATCH_PROCESS_NAME)'"
      $rows = @(Get-CimInstance Win32_Process -Filter $query -OperationTimeoutSec 8 |
        Where-Object {$_.ExecutablePath -ieq $env:CODEY_WATCH_EXECUTABLE} |
        ForEach-Object {
          $owner=Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid -OperationTimeoutSec 8 -ErrorAction Stop
          if($owner.ReturnValue -ne 0 -or -not $owner.Sid){throw 'Owner inventory unavailable'}
          @{pid=$_.ProcessId;exe=$_.ExecutablePath;cmd=$_.CommandLine;sid=$owner.Sid}
        })
      ConvertTo-Json -InputObject $rows -Compress
    """
    env = {**os.environ,
           "CODEY_WATCH_PROCESS_NAME": "devtunnel.exe" if component == "tunnel" else "node.exe",
           "CODEY_WATCH_EXECUTABLE": runtime["devtunnelExe" if component == "tunnel" else "nodeExe"]}
    try:
        completed = subprocess.run([config["powershellExe"], "-NoProfile", "-NonInteractive", "-Command", script],
                                   capture_output=True, text=True, encoding="utf-8", errors="replace",
                                   timeout=30, creationflags=CREATE_NO_WINDOW, env=env)
    except subprocess.TimeoutExpired:
        raise InventoryUnavailable("process_inventory_timeout") from None
    except OSError:
        raise InventoryUnavailable("process_inventory_unavailable") from None
    if completed.returncode != 0:
        raise InventoryUnavailable("process_inventory_failed")
    try:
        rows = json.loads(completed.stdout)
    except (ValueError, TypeError):
        raise InventoryUnavailable("invalid_process_inventory") from None
    if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
        raise InventoryUnavailable("invalid_process_inventory")
    found = []
    for row in rows:
        exe, command = (row.get("exe") or "").lower(), row.get("cmd") or ""
        if component == "tunnel":
            arguments = windows_argv(command) if exe == runtime["devtunnelExe"].lower() else []
            match = len(arguments) >= 3 and arguments[1:3] == ["host", runtime["tunnelId"]]
        else:
            entries = [runtime["entryPath"], *config.get("acceptedPreviousEntries", [])]
            arguments = windows_argv(command) if exe == runtime["nodeExe"].lower() else []
            match = len(arguments) >= 2 and arguments[1].lower() in {entry.lower() for entry in entries}
        if match:
            require(row.get("sid") == config["ownerSid"], "component_has_different_owner")
            found.append(int(row["pid"]))
    require(len(found) <= 1, "duplicate_component_processes")
    return found


def inventory_with_retry(config, runtime, component, last_known_pid=None):
    delay = 5
    while True:
        try:
            return matching_processes(config, runtime, component)
        except InventoryUnavailable as error:
            # Keep the watchdog alive, but do not start/stop anything while the
            # inventory is unknown. Wrong-owner/duplicate-process errors remain fatal.
            status(config, component, "inventory_retry", code=str(error), retryInSeconds=delay,
                   lastKnownPid=last_known_pid, serviceProcessesChanged=False)
            time.sleep(delay)
            delay = min(delay * 2, 60)


def supervise(config, runtime, component):
    delay = 5
    while True:
        found = inventory_with_retry(config, runtime, component)
        if found:
            pid = found[0]
            status(config, component, "adopted", pid=pid, context=windows_context())
            while process_alive(pid) and inventory_with_retry(config, runtime, component, pid) == [pid]:
                time.sleep(15)
                status(config, component, "adopted", pid=pid, context=windows_context())
            status(config, component, "restart_pending")
            # A user may already have replaced the exited manual process.
            # Reconcile a fresh inventory before starting a new host.
            continue
        launcher = config["workspaceLauncher" if component == "workspace" else "tunnelLauncher"]
        # The existing launchers enforce SID, loopback binding, hashes, and port ownership.
        # Raw child output is deliberately discarded, not persisted as potentially sensitive logs.
        with subprocess.Popen([
            config["powershellExe"], "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden",
            "-File", launcher, "-ConfigPath", config["runtimeConfig"],
        ], cwd=str(Path(launcher).parent), stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL, creationflags=CREATE_NO_WINDOW) as child:
            started = time.monotonic()
            while child.poll() is None:
                status(config, component, "supervising", launcherPid=child.pid, context=windows_context())
                time.sleep(15)
            delay = 5 if time.monotonic() - started > 120 else min(delay * 2, 300)
            status(config, component, "component_exited", exitCode=child.returncode, retryInSeconds=delay)
        time.sleep(delay)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--component", choices=["workspace", "tunnel", "renew", "probe"], required=True)
    parser.add_argument("--validate-renewal", action="store_true")
    parser.add_argument("--probe-nonce")
    args = parser.parse_args()
    require(not args.validate_renewal or args.component == "renew", "invalid_validation_component")
    config, runtime = load_config(args.config)
    try:
        with singleton(Path(config["stateRoot"]) / (args.component + ".lock")):
            if args.component == "probe":
                context = windows_context()
                # The approved startup mode is the owner's logged-in session.
                # Never silently switch to PASSWORD, S4U, or SYSTEM execution.
                require(context["sessionId"] > 0, "probe_requires_logged_in_session")
                require(args.probe_nonce and re.fullmatch(r"[a-f0-9]{32}", args.probe_nonce),
                        "missing_probe_nonce")
                token, expiration = connect_token(config, runtime)
                del token
                app = Arm(config).app()
                stable_app(app)
                secret_reference(app, config)
                status(config, "probe", "passed", nonce=args.probe_nonce,
                       context=context, tokenExpiresAt=expiration,
                       existingSecretsExported=False)
            elif args.component == "renew":
                renew(config, runtime, validate_only=args.validate_renewal)
            else:
                supervise(config, runtime, args.component)
    except SafeError as error:
        status(config, args.component, "needs_attention", code=str(error))
        return 0 if str(error) == "already_running" else 1
    except Exception as error:
        status(config, args.component, "needs_attention", code=type(error).__name__)
        return 1
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SafeError as error:
        print(json.dumps({"state": "needs_attention", "code": str(error)}))
        raise SystemExit(1)
    except Exception as error:
        print(json.dumps({"state": "needs_attention", "code": "startup_" + type(error).__name__}))
        raise SystemExit(1)
