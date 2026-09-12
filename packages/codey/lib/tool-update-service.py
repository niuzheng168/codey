#!/usr/bin/env python3
"""Owner-managed Linux native tools. Never run setup, an installer, login or a model."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import shlex
import signal
import sys
import time

_spec = importlib.util.spec_from_file_location("codey_tool_local", Path(__file__).with_name("update-service.py"))
local = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(local)
require, owned, sha, read, save, run = local.require, local.owned, local.sha, local.read, local.save, local.run
TERMINAL = ("complete", "rolled_back", "aborted")
HOST = "codey-devtunnel.service"
RENEW = "codey-devtunnel-renew.service"
TIMER = "codey-devtunnel-renew.timer"


def version(file, component):
    output = run([file, "--version"], timeout=15)
    prefix = r"codex(?:-cli)?" if component == "codex" else "devtunnel"
    match = re.match(prefix + r"\s+(?:version\s+)?v?(\d+\.\d+\.\d+(?:\.\d+)?(?:[-+][A-Za-z0-9.-]+)?)(?:\s|$)",
                     output.strip(), re.I)
    require(match, "Unrecognized installed native tool version")
    return match[1]


def native_anchor(file, home):
    file = Path(file)
    require(file.is_absolute() and file.name in ("codex", "devtunnel"), "A stable owner-managed native entrypoint is required")
    owned(file.parent, home)  # No linked ancestors; only this one stable entry may be a symlink.
    require(file.lstat().st_uid == os.getuid(), "Unowned native entrypoint")
    target = owned(file.resolve(strict=True), home)
    require(target.is_file() and os.access(target, os.X_OK), "Native tool is not executable")
    with target.open("rb") as stream:
        header = stream.read(20)
    require(len(header) == 20 and header[:6] == b"\x7fELF\x02\x01" and header[18:20] == b"\x3e\x00",
            "Only native Linux x64 tools can be managed, not npm wrappers or Desktop launchers")
    return {"anchor": str(file), "resolved": str(target), "entrySha256": sha(target),
            "anchorKind": "symlink" if file.is_symlink() else "file",
            "linkText": os.readlink(file) if file.is_symlink() else None}


def validate_payload(request, home):
    job = owned(request["job"], home)
    manifest_file = owned(job / "tool-update.json", home)
    require(sha(manifest_file) == request["sha256"], "Reviewed tool manifest changed")
    manifest = read(manifest_file)
    require(manifest == request["manifest"] and manifest["component"] == request["component"]
            and manifest["platform"] == "linux-x64" and manifest["version"] == request["version"]
            and manifest["entry"] == request["component"], "Tool manifest/request mismatch")
    directory = owned(job / "payload", home)
    target = owned(request["candidate"], home)
    require(target == directory / manifest["entry"], "Unexpected native tool entrypoint")
    actual = set()
    for file in directory.rglob("*"):
        owned(file, home)
        require(not file.is_symlink() and (file.is_dir() or file.is_file()), "Linked or special native payload")
        if file.is_file():
            actual.add(file.relative_to(directory).as_posix())
    require(actual == set(manifest["files"]), "Native companion file set changed")
    for name, item in manifest["files"].items():
        file = owned(directory / name, home)
        require(file.is_relative_to(directory) and file.stat().st_size == item["size"]
                and sha(file) == item["sha256"] and bool(file.stat().st_mode & 0o111) == item["executable"],
                "Native payload checksum or executable mode changed")
    require(sha(target) == request["entrySha256"], "Native executable changed")
    return target


def unit(name, home):
    output = run(["systemctl", "--user", "show", name,
                  "--property=ActiveState,FragmentPath,MainPID,DropInPaths"])
    state = dict(line.split("=", 1) for line in output.splitlines() if "=" in line)
    file = owned(state.get("FragmentPath", ""), home)
    require(file == home / ".config/systemd/user" / name and not state.get("DropInPaths"),
            "Unrecognized or overridden tool service")
    require(state.get("ActiveState") in ("active", "inactive", "failed"), "Tool service is changing state; retry later")
    return {"file": str(file), "hash": sha(file), "active": state["ActiveState"] == "active",
            "pid": int(state.get("MainPID") or 0)}


def descendants(pid, ancestor):
    for _ in range(100):
        if pid == ancestor:
            return True
        if pid <= 1:
            return False
        try:
            status = Path(f"/proc/{pid}/status").read_text()
            pid = int(re.search(r"^PPid:\s+(\d+)$", status, re.M)[1])
        except (FileNotFoundError, ProcessLookupError):
            return False
    return False


def assert_host_process(pid, target):
    require(pid > 1 and Path(f"/proc/{pid}").stat().st_uid == os.getuid()
            and Path(f"/proc/{pid}/exe").resolve() == Path(target),
            "The tunnel host is not running the configured native executable")


def tool_processes(component):
    for directory in Path("/proc").iterdir():
        if not directory.name.isdigit():
            continue
        try:
            if directory.stat().st_uid != os.getuid():
                continue
            args = (directory / "cmdline").read_bytes().decode().split("\0")
            executable = (directory / "exe").resolve(strict=True)
            if executable.name == component or any(Path(arg).name in (component, component + ".js") for arg in args[:2]):
                yield int(directory.name), executable, args
        except (FileNotFoundError, ProcessLookupError):
            continue
        except (PermissionError, UnicodeError):
            raise local.UpdateError("Cannot verify owner tool processes; no process will be terminated")


class LinuxTool(local.Linux):
    def tool_snapshot(self, component, before):
        require(component in ("codex", "devtunnel"), "Unknown update component")
        units = {}
        extra = {}
        if component == "codex":
            env = self.engine.environment(before["cloudcliPid"])
            anchor = env.get("CODEY_CODEX_EXECUTABLE")
            if not anchor:
                choices = [Path(folder) / "codex" for folder in env.get("PATH", "").split(os.pathsep)
                           if Path(folder).is_absolute()]
                anchor = next((str(file) for file in choices if file.is_file() and os.access(file, os.X_OK)), None)
            require(anchor, "No configured native Codex runtime")
            require(Path(anchor) in (self.home / ".local/bin/codex",
                                     self.home / ".local/share/codey-tools/codex/codex"),
                    "Codex must use its stable owner-managed CLI entrypoint; immutable/system/Desktop paths are not adopted")
            services = ["codey-cloudcli.service"]
        else:
            units = {name: unit(name, self.home) for name in (HOST, RENEW, TIMER)}
            require(units[HOST]["active"] and not units[RENEW]["active"], "Tunnel must be running and token renewal idle")
            text = Path(units[HOST]["file"]).read_text()
            commands = re.findall(r"^ExecStart=(.+)$", text, re.M)
            require(len(commands) == 1, "Unknown tunnel launch command")
            arguments = shlex.split(commands[0])
            require(len(arguments) == 7 and arguments[1] == "host"
                    and arguments[3:] == ["--host-header", "unchanged", "--origin-header", "unchanged"]
                    and re.fullmatch(r"[a-z0-9][a-z0-9-]{1,58}\.[a-z0-9]{2,12}", arguments[2]),
                    "Unknown tunnel host command")
            anchor = arguments[0]
            require(Path(anchor) in (self.home / ".local/share/codey-tools/devtunnel/devtunnel",
                                     self.home / ".local/bin/devtunnel"), "Unknown DevTunnel entrypoint")
            renew_file = self.home / ".local/share/codey-machine/renew-devtunnel.sh"
            owned(renew_file, self.home)
            require(re.findall(r"^ExecStart=(.+)$", Path(units[RENEW]["file"]).read_text(), re.M) == [str(renew_file)]
                    and f'"{anchor}" token "{arguments[2]}" --scope connect --json' in renew_file.read_text()
                    and f"Unit={RENEW}" in Path(units[TIMER]["file"]).read_text(),
                    "Token renewal does not use the same stable tool entrypoint")
            extra = {"tunnelId": arguments[2], "renewFile": str(renew_file), "renewHash": sha(renew_file)}
            services = [HOST, TIMER] if units[TIMER]["active"] else [HOST]
        result = native_anchor(anchor, self.home)
        require(not Path(result["resolved"]).is_relative_to(self.root), "Native tools must live outside Codey")
        if component == "devtunnel":
            assert_host_process(units[HOST]["pid"], result["resolved"])
        return {**result, **extra, "component": component, "units": units, "services": services,
                "version": version(anchor, component)}

    def plan_tool(self, component):
        plan = super().plan()
        before = self.snapshot()
        require(local.stamp(before) == plan["baseline"], "Node changed during discovery")
        tool = self.tool_snapshot(component, before)
        return {**plan, **tool, "kind": "linux-tool", "toolBaseline": local.stamp(tool)}

    def assert_processes(self, component, before, tool, stopped=False):
        for pid, executable, args in tool_processes(component):
            if not stopped and component == "codex" and "app-server" in args and descendants(pid, before["cloudcliPid"]):
                continue
            if not stopped and component == "devtunnel" and pid == tool["units"][HOST]["pid"]:
                continue
            raise local.UpdateError("Finish external native tool tasks first; CLI/Desktop/unknown processes will not be killed")

    def guard(self, request):
        require(sha(self.config_file) == request["plan"]["configHash"], "Node identity changed; manual recovery required")
        for item in request["plan"]["units"].values():
            owned(item["file"], self.home)
            require(sha(item["file"]) == item["hash"], "Native service definition changed")
        if request["component"] == "devtunnel":
            require(sha(request["plan"]["renewFile"]) == request["plan"]["renewHash"], "Token renewal configuration changed")

    def stop_scope(self, request):
        if request["component"] == "codex":
            run(["systemctl", "--user", "stop", "codey-cloudcli.service"])
        else:
            if request["plan"]["units"][TIMER]["active"]:
                run(["systemctl", "--user", "stop", TIMER])
            require(not unit(RENEW, self.home)["active"], "Token renewal started concurrently; retry after it finishes")
            run(["systemctl", "--user", "stop", HOST])

    def start_scope(self, request):
        run(["systemctl", "--user", "start", "codey-cloudcli.service" if request["component"] == "codex" else HOST])
        if request["component"] == "devtunnel" and request["plan"]["units"][TIMER]["active"]:
            run(["systemctl", "--user", "start", TIMER])

    def switch_anchor(self, request):
        plan = request["plan"]
        anchor, backup = Path(plan["anchor"]), Path(request["job"]) / "previous-entry"
        require(native_anchor(anchor, self.home) == {key: plan[key] for key in
                ("anchor", "resolved", "entrySha256", "anchorKind", "linkText")}, "Tool entrypoint changed before switching")
        require(anchor.parent.stat().st_dev == backup.parent.stat().st_dev, "Tool entrypoint backup is on another filesystem")
        require(not backup.exists() and not backup.is_symlink(), "An entrypoint backup already exists")
        anchor.rename(backup)
        anchor.symlink_to(request["candidate"])

    def restore_anchor(self, request, check_only=False):
        plan = request["plan"]
        anchor, backup = Path(plan["anchor"]), Path(request["job"]) / "previous-entry"
        owned(anchor.parent, self.home)
        if backup.exists() or backup.is_symlink():
            if plan["anchorKind"] == "symlink":
                require(backup.is_symlink() and os.readlink(backup) == plan["linkText"]
                        and sha(plan["resolved"]) == plan["entrySha256"], "Original tool link/target changed")
            else:
                owned(backup, self.home)
                require(not backup.is_symlink() and sha(backup) == plan["entrySha256"], "Original tool executable changed")
            if anchor.exists() or anchor.is_symlink():
                require(anchor.is_symlink() and os.readlink(anchor) == request["candidate"],
                        "Another installation changed the tool entrypoint; refusing to overwrite it")
            if check_only:
                return
            if anchor.exists() or anchor.is_symlink():
                anchor.unlink()
            backup.rename(anchor)
        else:
            require(native_anchor(anchor, self.home) == {key: plan[key] for key in
                    ("anchor", "resolved", "entrySha256", "anchorKind", "linkText")}, "Original tool is missing")

    def verify(self, before, request, job, rollback=False):
        expected = request["plan"]["entrySha256"] if rollback else request["entrySha256"]
        deadline = time.monotonic() + 60
        while True:
            try:
                after = self.snapshot()
                self.runtime.assert_unchanged(before, after, package_paths=False)
                require(all(after[key] == before[key] for key in
                            ("components", "cloudcliPath", "copilotPath", "copilotPid", "pinHash", "highestSequence")),
                        "Codey or signed release state changed during a tool update")
                self.runtime.health(after)
                self.runtime.probe("idle", after, job)
                tool = self.tool_snapshot(request["component"], after)
                require(tool["entrySha256"] == expected, "Running tool entrypoint differs from the selected version")
                if not rollback:
                    require(tool["resolved"] == request["candidate"], "Another installation moved the native tool entrypoint")
                if request["component"] == "devtunnel":
                    run([request["plan"]["node"], job / "tool-update-probe.mjs", "tunnel",
                         job / "request.json", request["plan"]["anchor"]], timeout=25)
                elif not rollback:
                    run([request["plan"]["node"], job / "tool-update-probe.mjs", "probe",
                         job / "request.json", request["plan"]["anchor"]], timeout=40)
                if not rollback:
                    validate_payload(request, self.home)
                    require(str(Path(request["plan"]["anchor"]).resolve()) == request["candidate"],
                            "Native tool entrypoint changed during verification")
                self.guard(request)
                return
            except Exception:
                if time.monotonic() >= deadline:
                    raise
                time.sleep(1)

    def rollback(self, journal, job):
        request = journal["request"]
        self.guard(request)
        self.restore_anchor(request, check_only=True)
        self.stop_scope(request)
        self.assert_processes(request["component"], journal["before"], request["plan"], stopped=True)
        self.restore_anchor(request)
        self.start_scope(request)
        self.verify(journal["before"], request, job, rollback=True)
        journal.update(state="rolled_back", outcome="rolled_back")
        save(job / "local-update.json", journal)

    def activate(self, request):
        job = owned(request["job"], self.home)
        require(job.parent == self.jobs, "Tool job is outside the managed update directory")
        require(request["component"] != "devtunnel" or request.get("allowDisconnect") is True, "Explicit tunnel disconnect consent is required")
        validate_payload(request, self.home)
        self.guard(request)
        before = self.snapshot()
        require(local.stamp(before) == request["plan"]["baseline"], "Node changed while staging")
        local.external_linux(before)
        tool = self.tool_snapshot(request["component"], before)
        require(local.stamp(tool) == request["plan"]["toolBaseline"], "Native tool changed while staging")
        self.assert_processes(request["component"], before, tool)
        journal = {"schema": 1, "kind": "linux-tool", "state": "prepared", "request": request, "before": before}
        with self.exclusive(job, journal):
            require(local.stamp(self.snapshot()) == request["plan"]["baseline"], "Node changed while pausing the pull updater")
            require(self.runtime.idle(before, job), "Codey/model/Codex work is active; finish it and retry")
            require(local.stamp(self.tool_snapshot(request["component"], before)) == request["plan"]["toolBaseline"],
                    "Tool service changed before activation")
            validate_payload(request, self.home)
            self.assert_processes(request["component"], before, tool)
            journal["state"] = "applying"
            save(job / "local-update.json", journal)
            try:
                self.stop_scope(request)
                self.assert_processes(request["component"], before, tool, stopped=True)
                self.guard(request)
                self.switch_anchor(request)
                self.start_scope(request)
                self.verify(before, request, job)
                journal.update(state="complete", outcome="complete")
                save(job / "local-update.json", journal)
            except BaseException:
                self.rollback(journal, job)
                raise
        return {"ok": True, "version": request["version"], "source": "local-tool",
                "signedSequencePreserved": before["highestSequence"], "modelRequests": False}

    def recover(self, journal, job):
        import fcntl
        self.guard(journal["request"])
        state = journal.get("outcome", journal["state"])
        if state in TERMINAL or state == "prepared":
            journal["state"] = "aborted" if state == "prepared" else state
        else:
            require(not (self.runtime.private / "pending.json").exists(), "A Portal update needs recovery first")
            with owned(self.runtime.private / "agent.lock", self.home).open("a") as lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                local.external_linux(journal["before"])
                self.rollback(journal, job)
        save(job / "local-update.json", journal)
        if journal.get("updaterWasActive"):
            run(["systemctl", "--user", "start", "codey-node-updater.service"])
        return {"ok": True, "recovered": journal["state"], "modelRequests": False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("plan", "apply", "recover"))
    parser.add_argument("path")
    args = parser.parse_args()
    require(sys.platform == "linux" and sys.version_info >= (3, 12) and os.getuid() != 0,
            "Use the original owner and existing Linux Python 3.12+")
    if args.action == "plan":
        options = json.loads(args.path)
        result = LinuxTool(options["root"]).plan_tool(options["component"])
    else:
        document = local.private(args.path)
        request = document["request"] if args.action == "recover" else document
        adapter = LinuxTool(request["plan"]["root"])
        job = owned(request["job"], Path.home())
        require(job.parent == adapter.jobs, "Unexpected tool update recovery directory")
        result = adapter.recover(document, job) if args.action == "recover" else adapter.activate(request)
    print(json.dumps(result))


if __name__ == "__main__":
    def interrupted(*_):
        raise local.UpdateError("Native tool update interrupted")
    signal.signal(signal.SIGINT, interrupted)
    signal.signal(signal.SIGTERM, interrupted)
    try:
        main()
    except Exception as error:
        print(str(error) if isinstance(error, local.UpdateError) else
              "Native tool update failed; inspect the private job and existing services.", file=sys.stderr)
        sys.exit(1)
