#!/usr/bin/env python3
"""Local, owner-authorized Codey package switching. No setup, tool installs or model calls."""
import argparse
import contextlib
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time


class UpdateError(RuntimeError):
    pass


def require(value, message):
    if not value:
        raise UpdateError(message)


def sha(file):
    with Path(file).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def read(file):
    return json.loads(Path(file).read_text(encoding="utf-8-sig"))


def owned(file, home, *, links=False):
    file, home = Path(os.path.abspath(file)), Path(home).resolve(strict=True)
    require(file != home and file.is_relative_to(home), "Path is outside the owner's HOME")
    for item in [file, *file.parents]:
        if item == home:
            break
        if item.exists() or item.is_symlink():
            require(links or not item.is_symlink(), "Linked update paths require manual review")
            info = item.stat()
            require(info.st_uid == os.getuid() and not info.st_mode & 0o022, "Unowned or writable update path")
            require(item.resolve().is_relative_to(home), "Update path resolves outside HOME")
    return file


def private(file):
    file = owned(file, Path.home())
    require(file.is_file() and not file.stat().st_mode & 0o077, "Expected an owner-only update record")
    return read(file)


def save(file, value):
    file = Path(file)
    owned(file, Path.home())
    body = value if isinstance(value, bytes) else (json.dumps(value, indent=2) + "\n").encode()
    temporary = file.with_name(file.name + ".local-next")
    with temporary.open("xb") as stream:
        os.chmod(temporary, 0o600)
        stream.write(body)
        stream.flush()
        os.fsync(stream.fileno())
    try:
        os.replace(temporary, file)
    finally:
        temporary.unlink(missing_ok=True)


def run(args, timeout=60, env=None):
    result = subprocess.run([str(arg) for arg in args], capture_output=True, text=True,
                            stdin=subprocess.DEVNULL, timeout=timeout, env=env)
    require(result.returncode == 0, f"{Path(args[0]).name} failed; inspect the existing service state")
    return result.stdout.strip()


def module(file, name):
    spec = importlib.util.spec_from_file_location(name, file)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


def stamp(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


def candidate(request, home):
    directory = owned(request["candidate"], home)
    require(directory.is_dir() and directory.is_relative_to(Path(request["job"])), "Candidate is outside this update job")
    build = read(directory / "codey-build.json")
    pkg = read(directory / "package.json")
    require(pkg.get("name") == build.get("name") == "codey"
            and pkg.get("version") == build.get("version") == request["version"]
            and sha(directory / "codey-build.json") == request["entrySha256"]
            and sha(directory / "npm-shrinkwrap.json") == build["lockSha256"]
            and sha(directory / "dist-server/server/index.js") == build["workspaceEntrySha256"]
            and sha(directory / "gateway/main.js") == build["gatewayEntrySha256"], "Staged Codey package changed")
    return directory, build


def external_linux(snapshot):
    pid = os.getppid()
    for _ in range(100):
        if pid <= 1:
            return
        require(pid not in (snapshot["cloudcliPid"], snapshot["copilotPid"]),
                "Run codey update from an external terminal, not inside Codey")
        try:
            args = Path(f"/proc/{pid}/cmdline").read_bytes().decode().split("\0")
            require(not args or Path(args[0]).name not in ("codex", "codex.js"),
                    "Run codey update from an external terminal, not inside Codex")
            status = Path(f"/proc/{pid}/status").read_text()
            pid = int(re.search(r"^PPid:\s+(\d+)$", status, re.M)[1])
        except (FileNotFoundError, ProcessLookupError):
            return
    raise UpdateError("Could not verify an external terminal")


class Linux:
    def __init__(self, root):
        self.home = Path.home().resolve()
        # Recovery can run from the retained job even if a first directory switch
        # was interrupted in the brief gap before the stable symlink was created.
        self.root = owned(root, self.home, links=True).resolve()
        self.config_file = self.home / ".config/codey-updater/config.json"
        config = private(self.config_file)
        require(config.get("nodeId") != "local" and config.get("username") and config.get("ownerId"),
                "Only an existing owner-managed Codey node can be updated")
        # A job keeps the reviewed engine/probe outside the package pointer being switched.
        engine_file = Path(__file__).with_name("engine.py")
        if not engine_file.is_file():
            engine_file = self.root / "updater/engine.py"
        self.engine = module(engine_file, "codey_local_update_engine")
        self.runtime = self.engine.Runtime(config, create=False)
        self.jobs = self.runtime.root / "local-updates"

    def snapshot(self):
        value = self.runtime.snapshot()
        require(value["layout"] == "npm" and value["cloudcliPath"] == value["copilotPath"],
                "Legacy split-component nodes need an explicit migration, not codey update")
        app = Path(value["cloudcliPath"])
        require(not any(Path(file).resolve().is_relative_to(app) for file in value["protected"]),
                "Persistent model/identity configuration must live outside the application directory")
        return value

    def plan(self):
        before = self.snapshot()
        require(Path(before["cloudcliPath"]) == self.root, "This CLI is not the package used by the node's services")
        return {"kind": "linux-managed", "root": str(self.root), "node": before["cloudcliNode"],
                "jobsRoot": str(self.jobs), "baseline": stamp(before), "configHash": sha(self.config_file),
                "services": ["codey-cloudcli.service", before["copilotService"]],
                "pausedService": "codey-node-updater.service"}

    @contextlib.contextmanager
    def exclusive(self, job, journal):
        import fcntl
        pending = self.runtime.private / "pending.json"
        require(not pending.exists(), "A Portal update is pending; finish it before a local update")
        unit = "codey-node-updater.service"
        output = run(["systemctl", "--user", "show", unit, "--property=ActiveState,FragmentPath"])
        state = dict(line.split("=", 1) for line in output.splitlines() if "=" in line)
        active = state.get("ActiveState") == "active"
        require(state.get("ActiveState") in ("active", "inactive", "failed"), "Updater is changing state; retry later")
        if active:
            file = owned(state.get("FragmentPath", ""), self.home)
            require(file.parent == self.home / ".config/systemd/user" and file.name == unit
                    and "updater.py" in file.read_text() and "TimeoutStopSec=900" in file.read_text(),
                    "Unrecognized updater service; refusing to stop it")
        journal["updaterWasActive"] = active
        save(job / "local-update.json", journal)
        lock = None
        try:
            if active:
                # The existing service finishes its bounded transaction on SIGTERM.
                # Never kill its child process tree or stop the model applications here.
                run(["systemctl", "--user", "stop", unit], timeout=920)
            lock_file = owned(self.runtime.private / "agent.lock", self.home)
            lock = lock_file.open("a")
            os.chmod(lock_file, 0o600)
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            require(not pending.exists(), "A Portal transaction needs acknowledgement/recovery before this update")
            yield
        except BaseException:
            if journal["state"] == "prepared":
                journal["state"] = "aborted"
                save(job / "local-update.json", journal)
            raise
        finally:
            if lock:
                lock.close()
            if active and journal["state"] in ("complete", "rolled_back", "aborted"):
                try:
                    run(["systemctl", "--user", "start", unit])
                except Exception:
                    journal["state"] = "resume_updater"
                    save(job / "local-update.json", journal)
                    raise
            # An uncertain/failed rollback must not release another Portal job
            # over its pointers. Recovery resumes the previously active daemon.

    def verify(self, before, request, job):
        deadline = time.monotonic() + 60
        while True:
            try:
                after = self.snapshot()
                self.runtime.health(after)
                self.runtime.probe("idle", after, job)  # Authenticated GET only, never a model request.
                self.runtime.assert_unchanged(before, after, package_paths=False)
                require(after["components"]["codey"]["entrySha256"] == request["entrySha256"],
                        "Running package differs from the reviewed candidate")
                return after
            except Exception:
                if time.monotonic() >= deadline:
                    raise
                time.sleep(1)

    def activate(self, request):
        job = owned(request["job"], self.home)
        target, build = candidate(request, self.home)
        require(job.parent == self.jobs and sha(self.config_file) == request["plan"]["configHash"], "Node identity changed")
        before = self.snapshot()
        require(stamp(before) == request["plan"]["baseline"], "Node changed while staging; no service was stopped")
        external_linux(before)
        require(Path(before["cloudcliNode"]) == Path(request["plan"]["node"]), "Existing Node runtime changed")
        journal = {"schema": 1, "kind": "linux-managed", "state": "prepared", "request": request}
        with self.exclusive(job, journal):
            self.runtime.assert_unchanged(before)
            require(self.runtime.idle(before, job), "Codey/model/Codex work is active; finish it and retry")
            anchor = Path(before["codeyAnchor"])
            backup = job / "backup/codey"
            backup.parent.mkdir(mode=0o700, exist_ok=True)
            require(anchor.parent.stat().st_dev == backup.parent.stat().st_dev, "Update backup is on another filesystem")
            # A first local update may adopt an existing npm directory, exactly as the signed updater does.
            if not self.runtime.profile_file.exists():
                self.engine.save(self.runtime.profile_file, self.runtime.profile)
            anchors = [{"component": "codey", "anchor": str(anchor), "target": str(target),
                        "kind": "symlink" if anchor.is_symlink() else "directory",
                        "previousTarget": str(anchor.resolve()), "backup": str(backup),
                        "service": "codey-cloudcli.service",
                        "services": ["codey-cloudcli.service", before["copilotService"]]}]
            release = {"id": "local-" + request["sha256"][:24], "components": {"codey": {
                "version": request["version"], "commit": build["sourceCommit"], "sha256": request["sha256"]}}}
            self.runtime.prepare_metadata(release, before, ["codey"], job)
            journal.update({"state": "applying", "anchors": anchors, "before": before})
            save(job / "local-update.json", journal)
            try:
                # Recheck after all preparation, immediately before stopping the two apps.
                self.runtime.assert_unchanged(before)
                require(self.runtime.idle(before, job), "Node became busy; no application was stopped")
                self.runtime.switch(anchors, job)
                self.runtime.update_pin(release, before, ["codey"])
                after = self.verify(before, request, job)
                self.engine.save(self.runtime.private / "installed.json", {
                    "releaseId": release["id"], "sequence": before["highestSequence"],
                    "digest": request["sha256"], "source": "local-package",
                    "components": after["components"], "updatedAt": int(time.time() * 1000),
                })
                self.engine.save(job / "transaction.json", {"state": "succeeded", "anchors": anchors})
                journal["state"] = "complete"
                save(job / "local-update.json", journal)
            except BaseException:
                # No stale database, key or model configuration is restored.
                if (job / "transaction.json").exists():
                    self.runtime.rollback(anchors, job)
                    self.runtime.health(self.snapshot())
                    journal["state"] = "rolled_back"
                else:
                    journal["state"] = "aborted"
                save(job / "local-update.json", journal)
                raise
        return {"ok": True, "version": request["version"], "services": request["plan"]["services"],
                "source": "local-package", "signedSequencePreserved": before["highestSequence"], "modelRequests": False}

    def recover(self, journal, job):
        request = journal["request"]
        require(sha(self.config_file) == request["plan"]["configHash"], "Node identity changed; manual recovery required")
        transaction = job / "transaction.json"
        if journal.get("state") in ("complete", "rolled_back", "aborted"):
            # Do not reacquire the daemon's lifetime flock after a finished rollback.
            if journal.get("updaterWasActive"):
                run(["systemctl", "--user", "start", "codey-node-updater.service"])
            return {"ok": True, "recovered": journal["state"], "modelRequests": False}
        # Do not undo a completed activation if the CLI died while reporting success.
        if transaction.exists() and read(transaction)["state"] in ("succeeded", "rolled_back"):
            journal["state"] = "complete" if read(transaction)["state"] == "succeeded" else "rolled_back"
        elif journal.get("state") in ("applying", "resume_updater") and transaction.exists():
            import fcntl
            require(not (self.runtime.private / "pending.json").exists(), "A Portal update needs recovery first")
            with owned(self.runtime.private / "agent.lock", self.home).open("a") as lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                self.runtime.rollback(read(transaction)["anchors"], job)
                self.runtime.health(self.snapshot())
            journal["state"] = "rolled_back"
        elif journal.get("state") != "complete":
            journal["state"] = "aborted"
        save(job / "local-update.json", journal)
        if journal.get("updaterWasActive"):
            run(["systemctl", "--user", "start", "codey-node-updater.service"])
        return {"ok": True, "recovered": journal["state"], "modelRequests": False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("plan", "apply", "recover"))
    parser.add_argument("path")
    args = parser.parse_args()
    require(sys.version_info >= (3, 12) and os.getuid() != 0, "Use the original owner and existing Python 3.12+")
    cls = Linux if sys.platform == "linux" else None
    require(cls is not None, "Unsupported service platform")
    if args.action == "plan":
        answer = cls(args.path).plan()
    else:
        request = private(args.path)
        if args.action == "recover":
            request = request["request"]
        adapter = cls(request["plan"]["root"])
        job = owned(request["job"], Path.home())
        require(job.parent == adapter.jobs, "Recovery job is outside the managed update directory")
        if args.action == "apply":
            answer = adapter.activate(request)
        else:
            answer = adapter.recover(private(job / "local-update.json"), job)
    print(json.dumps(answer))


if __name__ == "__main__":
    def interrupted(*_):
        raise UpdateError("Local update interrupted")
    signal.signal(signal.SIGINT, interrupted)
    signal.signal(signal.SIGTERM, interrupted)
    try:
        main()
    except Exception as error:
        # Native errors can contain model configuration. Keep stdout machine-readable and redact stderr.
        print(str(error) if isinstance(error, UpdateError) else
              "Local Codey service update failed; inspect the private job and existing services.", file=sys.stderr)
        sys.exit(1)
