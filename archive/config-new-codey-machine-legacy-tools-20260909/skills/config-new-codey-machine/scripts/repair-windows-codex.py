"""Repair only an active Windows node's explicit native Codex pin; never reinstall it."""
import argparse
import base64
import copy
import importlib.util
import json
import os
from pathlib import Path
import platform
import queue
import re
import secrets
import subprocess
import sys
import threading
import time

SCRIPT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("codey_windows_repair_helpers", SCRIPT / "configure-windows-tunnel.py")
setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup)
native, worker, windows, tunnel = setup.native, setup.worker, setup.windows, setup.tunnel
Error = windows.SetupError


def read_json(file):
    file = native.ordinary_path(file)
    if not file.is_file() or file.stat().st_size > 1024 * 1024:
        raise Error("repair_requires_existing_bounded_installation_state")
    value = json.loads(file.read_text(encoding="utf-8-sig"))
    if not isinstance(value, dict):
        raise Error("repair_requires_object_installation_state")
    return value


def tasks(runtime_file, operation="Check"):
    result = setup.run([
        windows.native_powershell(), "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden",
        "-File", SCRIPT / "windows-codex-repair-tasks.ps1",
        "-ConfigPath", runtime_file, "-Operation", operation,
    ], timeout=60)
    return json.loads(result.stdout)


def workspace_get(config, enrollment, path):
    now = int(time.time())
    assertion = windows.common.signed({
        "iss": "codey-portal", "aud": config["nodeId"], "sub": enrollment["principalId"],
        "username": enrollment["username"], "sid": secrets.token_hex(32), "method": "GET", "path": path,
        "iat": now, "exp": now + 20, "nonce": windows.common.b64(secrets.token_bytes(16)),
    }, base64.urlsafe_b64decode(enrollment["workspaceSsoKey"] + "="))
    status, body = windows.common.local_probe(
        "127.0.0.1", 3001, config["nodeId"] + ".nodes.codey.internal",
        Path(config["certificate"]), path, {"x-codey-workspace-assertion": assertion})
    if status != 200 or not isinstance(body, dict):
        raise Error("repair_workspace_authenticated_probe_failed")
    return body


def require_idle(config, enrollment):
    body = workspace_get(config, enrollment, "/api/providers/sessions/running")
    data = body.get("data")
    if (body.get("success") is not True or not isinstance(data, dict)
            or not isinstance(data.get("sessions"), list)):
        raise Error("cannot_prove_workspace_idle_no_task_restarted")
    if data["sessions"]:
        raise Error("workspace_has_running_sessions_wait_until_idle_no_task_restarted")


def native_probe(config, enrollment):
    """Exercise the exact native stdio protocol, without creating/resuming any thread."""
    env = worker.environment(config, enrollment)
    version = setup.run([config["codexExe"], "--version"], cwd=config["codexHome"], env=env, timeout=30)
    if not version.stdout.strip().lower().startswith("codex"):
        raise Error("selected_executable_is_not_native_codex")
    messages = queue.Queue(maxsize=32)
    child = subprocess.Popen(
        [config["codexExe"], "app-server", "--stdio"], cwd=config["codexHome"], env=env,
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        text=True, encoding="utf-8", errors="strict", creationflags=worker.CREATE_NO_WINDOW)
    job = None
    try:
        job = worker.ChildJob(child)

        def read():
            try:
                while line := child.stdout.readline(1024 * 1024 + 1):
                    if len(line) > 1024 * 1024:
                        break
                    try:
                        messages.put_nowait(json.loads(line))
                    except (ValueError, queue.Full):
                        break
            except (OSError, UnicodeError):
                pass
            finally:
                try:
                    messages.put_nowait(None)
                except queue.Full:
                    pass

        reader = threading.Thread(target=read, daemon=True)
        reader.start()

        def request(identifier, method, params):
            child.stdin.write(json.dumps({"id": identifier, "method": method, "params": params}) + "\n")
            child.stdin.flush()
            deadline = time.monotonic() + 30
            while True:
                try:
                    message = messages.get(timeout=max(0, deadline - time.monotonic()))
                except queue.Empty:
                    raise Error("native_codex_stdio_probe_timed_out_no_model_request_sent") from None
                if message is None:
                    raise Error("native_codex_stdio_probe_exited")
                if isinstance(message, dict) and message.get("id") == identifier:
                    if "error" in message or not isinstance(message.get("result"), dict):
                        raise Error("native_codex_stdio_probe_rejected")
                    return message["result"]
                if time.monotonic() >= deadline:
                    raise Error("native_codex_stdio_probe_timed_out_no_model_request_sent")

        request(1, "initialize", {"clientInfo": {"name": "codey-repair-check", "version": "1"},
                                   "capabilities": {"experimentalApi": True}})
        child.stdin.write(json.dumps({"method": "initialized", "params": {}}) + "\n")
        child.stdin.flush()
        models = request(2, "model/list", {"limit": 1})
        if not isinstance(models.get("data"), list):
            raise Error("native_codex_model_catalog_probe_failed")
        return {"nativeStdio": True, "modelCatalog": True, "realModelCallsTested": False}
    finally:
        if job:
            job.close()  # Only this probe's own child tree, never Desktop's app-server.
        elif child.poll() is None:
            child.terminate()
        child.wait(timeout=15)
        if "reader" in locals():
            reader.join(timeout=2)
        child.stdin.close()
        child.stdout.close()


def load_installation(args, context, home, computer):
    node_id = args.node_id
    if (not tunnel.NODE_ID.fullmatch(node_id)
            or not args.expected_computer_name or computer.casefold() != args.expected_computer_name.casefold()):
        raise Error("repair_requires_the_exact_existing_node_and_expected_computer")
    root = native.ordinary_path(home / ".local/share/codey-machine-windows" / node_id)
    config_root = native.ordinary_path(home / ".config/codey-machine-windows" / node_id)
    runtime_file, state_file = config_root / "runtime.json", config_root / "installation.json"
    config, state = read_json(runtime_file), read_json(state_file)
    package_file = SCRIPT.parent / "LOCAL-CODEX-REPAIR.json"
    if package_file.exists():
        package = read_json(package_file)
        if (package.get("schema") != 1 or package.get("kind") != "windows-ready-node-codex-repair"
                or package.get("nodeId") != node_id or package.get("releaseId") != state.get("releaseId")
                or not isinstance(package.get("expectedComputerName"), str)
                or package["expectedComputerName"].casefold() != computer.casefold()):
            raise Error("local_codex_repair_package_identity_mismatch")
    for record in (config, state):
        if (record.get("nodeId") != node_id or record.get("ownerSid") != context["sid"]
                or not isinstance(record.get("computerName"), str)
                or record["computerName"].casefold() != computer.casefold()):
            raise Error("repair_existing_installation_owner_or_computer_mismatch")
    if (config.get("schema") != 1 or config.get("kind") != "windows-devtunnel"
            or state.get("ready") is not True or state.get("platform") != "windows-x64"
            or state.get("mode") != "private-devtunnel-existing-model"
            or config.get("root") != str(root) or config.get("configRoot") != str(config_root)
            or config.get("codexHome") != state.get("codexHome")
            or config.get("codexExe") != state.get("codexExecutable")
            or not re.fullmatch(r"machine-[a-f0-9]{16}", state.get("releaseId", ""))):
        raise Error("repair_supports_only_a_ready_matching_windows_devtunnel_installation")
    for field in ("enrollmentFile", "certificate", "privateKey", "ticketKeyFile"):
        if not native.ordinary_path(config[field]).is_relative_to(config_root):
            raise Error("repair_private_input_outside_existing_installation")
    enrollment = read_json(config["enrollmentFile"])
    release = read_json(root / "releases" / state["releaseId"] / "release.json")
    binding = read_json(config_root / "tunnel.json")
    if (enrollment.get("nodeId") != node_id or enrollment.get("platform") != "windows-x64"
            or enrollment.get("releaseId") != state["releaseId"] or release.get("releaseId") != state["releaseId"]
            or enrollment.get("network", {}).get("mode") != "devtunnel"
            or config.get("tunnelId") != "codey-" + node_id
            or binding.get("tunnelId") != config["tunnelId"] or binding.get("clusterId") != config["clusterId"]
            or Path(config["ticketKeyFile"]).read_text(encoding="utf-8").strip() != enrollment.get("clientSigningKey")):
        raise Error("repair_enrollment_release_or_tunnel_identity_mismatch_no_replacement")
    old = config["codexExe"]
    if old not in config["fileHashes"] or not Path(old).is_absolute():
        raise Error("repair_requires_an_existing_explicit_native_codex_pin")
    replaced = {old}
    if config.get("nativeCodex"):
        native.verify(config["nativeCodex"], root, node_id)
        if config["nativeCodex"] != state.get("nativeCodex"):
            raise Error("repair_native_snapshot_state_mismatch")
        replaced.update(native.hashes(config["nativeCodex"]))
    # The explicitly replaced Codex bundle alone may be missing. All other pins
    # and all identity/TLS/provider inputs remain mandatory and byte-preserved.
    preserved = {file: expected for file, expected in config["fileHashes"].items() if file not in replaced}
    for file in preserved:
        native.ordinary_path(file)
    setup.assert_resume_files(preserved)
    for field in ("runnerPath", "ownerHelper", "tunnelHelper", "nodeExe", "workspaceEntry", "dataEntry"):
        if (config[field] not in preserved or not native.ordinary_path(config[field]).is_relative_to(root)):
            raise Error("repair_unpinned_or_foreign_runtime_input")
    if config["devtunnelExe"] not in preserved:
        raise Error("repair_unpinned_devtunnel_executable")
    for file in (config["enrollmentFile"], config["certificate"], config["privateKey"], config["ticketKeyFile"],
                 config_root / "tunnel.json", root / "releases" / state["releaseId"] / "release.json"):
        preserved[str(file)] = native.digest(native.ordinary_path(file))
    for name in ("config.toml", "auth.json"):
        file = native.ordinary_path(Path(config["codexHome"]) / name)
        if file.exists():
            preserved[str(file)] = native.digest(file)
    return root, config_root, config, state, enrollment, preserved, replaced


def repair(args):
    if os.name != "nt" or platform.machine().lower() not in ("amd64", "x86_64") or sys.version_info < (3, 12):
        raise Error("native_windows_x64_and_python_3_12_required")
    context = windows.service.owner_context()
    if context["elevated"] or context["sessionId"] <= 0:
        raise Error("use_original_logged_on_non_elevated_owner")
    root, config_root, config, state, enrollment, preserved, replaced = load_installation(
        args, context, Path.home().resolve(), platform.node())
    runtime_file, state_file = config_root / "runtime.json", config_root / "installation.json"
    runtime_before, state_before = runtime_file.read_bytes(), state_file.read_bytes()
    task_check = tasks(runtime_file)
    if task_check.get("ownerVerified") is not True or task_check.get("tasksVerified") is not True:
        raise Error("repair_owner_and_task_probe_failed")
    if args.apply and task_check.get("insideWorkspace") is not False:
        raise Error("run_repair_in_regular_owner_PowerShell_not_the_Codey_terminal")
    proof = setup.gateway_proof()
    if proof["ownerSid"] != context["sid"]:
        raise Error("4141_process_belongs_to_another_owner")
    require_idle(config, enrollment)
    pinned = native.pin(args.codex_executable, root, config["nodeId"])
    plan = {
        "nodeId": config["nodeId"], "computerName": config["computerName"], "readyNodeRepair": True,
        "oldExecutable": config["codexExe"], "oldExecutableExists": Path(config["codexExe"]).is_file(),
        "sourceExecutable": pinned["sourceExecutable"], "newExecutable": pinned["executable"],
        "bundleId": pinned["bundleId"], "companionFiles": list(pinned["files"]),
        "restartComponents": ["workspace", "renew"], "builtRuntimeReused": True,
        "nodeAndTunnelReused": True, "networkChanged": False, "firewallChanged": False,
        "existingModelServiceChanged": False, "desktopChanged": False,
    }
    if not args.apply:
        print(json.dumps({**plan, "applied": False}, indent=2))
        return
    # The copy and protocol probe happen before any existing task is stopped.
    if native.pin(args.codex_executable, root, config["nodeId"], apply=True) != pinned:
        raise Error("native_codex_source_changed_retry_plan_no_tasks_restarted")
    updated = copy.deepcopy(config)
    updated["codexExe"], updated["nativeCodex"] = pinned["executable"], pinned
    updated["fileHashes"] = {file: expected for file, expected in config["fileHashes"].items() if file not in replaced}
    updated["fileHashes"].update(native.hashes(pinned))
    directory = str(Path(pinned["executable"]).parent)
    updated["servicePath"] = os.pathsep.join(
        [directory] + [item for item in config["servicePath"].split(os.pathsep) if item.casefold() != directory.casefold()])
    updated_state = {**state, "codexExecutable": pinned["executable"], "nativeCodex": pinned,
                     "sourceCodexExecutable": pinned["sourceExecutable"]}
    worker.validate(updated, "workspace", context)
    protocol = native_probe(updated, enrollment)
    setup.assert_resume_files(preserved)
    if setup.gateway_proof() != proof:
        raise Error("protected_model_process_changed_no_task_restarted")
    require_idle(config, enrollment)
    tasks(runtime_file)  # Revalidate task ownership immediately before changing the pins.
    if runtime_file.read_bytes() != runtime_before or state_file.read_bytes() != state_before:
        raise Error("installation_changed_during_repair_no_configuration_overwritten")
    audit = str(time.time_ns())
    for file, content in ((config_root / ("runtime.before-codex-repair-" + audit + ".json"), runtime_before),
                          (config_root / ("installation.before-codex-repair-" + audit + ".json"), state_before)):
        with file.open("xb") as stream:
            stream.write(content)
    tunnel.write_state(runtime_file, updated)
    try:
        tunnel.write_state(state_file, updated_state)
    except BaseException:
        tunnel.write_state(runtime_file, config)
        raise
    # Once restarted, never roll back to the known-missing Desktop executable.
    # Keep valid pins + backups for a safe forward retry if TLS/SSO verification fails.
    tasks(runtime_file, "Restart")
    verification = None
    for attempt in range(20):
        try:
            verification = windows.common.verify(enrollment, {"listenIp": "127.0.0.1"}, Path(config["certificate"]))
            break
        except (OSError, ValueError, windows.SetupError, setup.http.client.HTTPException):
            if attempt == 19:
                raise Error("codex_pin_repaired_but_TLS_SSO_verification_failed_keep_backups_do_not_reinstall")
            time.sleep(2)
    setup.assert_resume_files(preserved)
    if setup.gateway_proof() != proof:
        raise Error("protected_model_process_changed_during_repair")
    report = {**plan, "applied": True, "ok": True, **protocol, "verification": verification,
              "originalNodeAndTunnelUnchanged": True, "existingModelProcessUnchanged": True,
              "existingCodexConfigUnchanged": True, "auditId": audit,
              "nextStep": "Verify a real Codey reply, same-thread continuation and an image attachment."}
    tunnel.write_state(config_root / "codex-repair-report.json", report)
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--node-id", required=True)
    parser.add_argument("--expected-computer-name", required=True)
    parser.add_argument("--codex-executable", required=True)
    parser.add_argument("--apply", action="store_true")
    try:
        repair(parser.parse_args())
    except Exception as error:
        print(json.dumps(setup.setup_error(error)))
        raise SystemExit(1)
