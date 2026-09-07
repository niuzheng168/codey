#!/usr/bin/env python3
"""Pull only owner-confirmed, signed Codey updates. No inbound listener."""
import os
import sys
if __name__ == "__main__" and not sys.flags.isolated:
    os.execv(sys.executable, [sys.executable, "-I", "-S", os.path.abspath(__file__), *sys.argv[1:]])

import argparse
import json
from pathlib import Path
import re
import signal
import ssl
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, str(Path(__file__).resolve().parent))
from engine import PROTOCOL, Runtime, UpdateError, Upgrade, read, require, save, sha, verify_envelope


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise UpdateError("download_failed")


def load_config(file):
    file = Path(file).resolve()
    require(file.is_file() and (os.name == "nt" or file.stat().st_mode & 0o777 == 0o600), "configuration_changed")
    value = read(file)
    require(value.get("schema") == 1 and value.get("protocol") == PROTOCOL
            and re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,31}", value.get("nodeId", ""))
            and value["nodeId"] != "local"
            and re.fullmatch(r"[a-z0-9-]{1,80}", value.get("ownerId", ""))
            and re.fullmatch(r"[a-z][a-z0-9_-]{0,31}", value.get("username", ""))
            and re.fullmatch(r"[A-Za-z0-9_-]{43}", value.get("credential", ""))
            and isinstance(value.get("releasePublicKey"), str)
            and len(value["releasePublicKey"]) < 8192, "configuration_changed")
    url = urllib.parse.urlsplit(value["portalOrigin"])
    require(url.scheme == "https" and url.hostname and not url.username and not url.password
            and not url.query and not url.fragment and url.path in {"", "/"}, "configuration_changed")
    value["portalOrigin"] = urllib.parse.urlunsplit((url.scheme, url.netloc, "", "", ""))
    return value


class Client:
    def __init__(self, config, opener=None):
        self.config = config
        # Never disable TLS verification or follow an artifact redirect carrying credentials.
        self.opener = opener or urllib.request.build_opener(
            NoRedirect(), urllib.request.HTTPSHandler(context=ssl.create_default_context()))

    def request(self, path, value=None):
        require(path.startswith("/api/node-updater/") and not path.startswith("//"), "configuration_changed")
        body = None if value is None else json.dumps(value).encode()
        request = urllib.request.Request(self.config["portalOrigin"] + path, data=body, headers={
            "Authorization": "Bearer " + self.config["credential"], "x-codey-node-id": self.config["nodeId"],
            "Content-Type": "application/json",
        })
        try:
            return self.opener.open(request, timeout=30)
        except urllib.error.HTTPError as error:
            raise UpdateError("lease_lost" if error.code in {401, 403, 409} else "download_failed") from None

    def json(self, path, value):
        with self.request(path, value) as response:
            content = response.read(1024 * 1024 + 1)
            require(len(content) <= 1024 * 1024, "download_failed")
            return json.loads(content)

    def download(self, release, artifact, file):
        if file.is_file() and file.stat().st_size == artifact["size"] and sha(file) == artifact["sha256"]:
            return
        temporary = file.with_name(file.name + ".part")
        size = 0
        deadline = time.monotonic() + 180
        with self.request(f"/api/node-updater/releases/{release}/{artifact['file']}") as response, temporary.open("wb") as output:
            while True:
                require(time.monotonic() < deadline, "download_failed")
                block = response.read(1024 * 1024)
                if not block:
                    break
                size += len(block)
                require(size <= artifact["size"], "download_failed")
                output.write(block)
            output.flush()
            os.fsync(output.fileno())
        temporary.chmod(0o600)
        require(size == artifact["size"] and sha(temporary) == artifact["sha256"], "signature_invalid")
        os.replace(temporary, file)


class Agent:
    def __init__(self, config, runtime=None, client=None):
        self.config = config
        self.runtime = runtime or Runtime(config)
        self.client = client or Client(config)
        self.pending = self.runtime.private / "pending.json"

    def once(self):
        pending = read(self.pending) if self.pending.exists() else None
        if pending:
            transaction_file = self.runtime.root / "jobs" / pending["id"] / "transaction.json"
            if transaction_file.exists():
                transaction = read(transaction_file)
                if transaction["state"] in {"applying", "verifying"}:
                    # Recover locally before depending on either target service or the Portal.
                    self.runtime.rollback(transaction["anchors"], transaction_file.parent)
                    self.runtime.health(self.runtime.snapshot())
                    pending["recovered"] = True
                    save(self.pending, pending)
        try:
            report = self.runtime.report()
        except UpdateError as error:
            installed_file = self.runtime.private / "installed.json"
            installed = read(installed_file) if installed_file.exists() else {}
            report = {"platform": "unsupported", "layout": "unsupported", "components": {},
                      "highestSequence": installed.get("sequence", 0), "readyMigrations": [], "blockedReason":
                      error.code if error.code in {"unsupported_platform", "configuration_changed"} else "configuration_changed"}
        result = self.client.json("/api/node-updater/poll", {
            "protocol": PROTOCOL, "report": report,
            **({"leaseToken": pending["leaseToken"]} if pending else {}),
        })
        job = result.get("job")
        if not job:
            if pending and not result.get("waitingForCanary") and not result.get("waitingForIdle"):
                self.pending.unlink(missing_ok=True)
            return result
        require(re.fullmatch(r"[a-f0-9]{32}", job.get("id", "")) and
                re.fullmatch(r"[A-Za-z0-9_-]{43}", job.get("leaseToken", "")), "signature_invalid")
        work = self.runtime.root / "jobs" / job["id"]
        work.mkdir(mode=0o700, parents=True, exist_ok=True)
        save(self.pending, {"id": job["id"], "leaseToken": job["leaseToken"], "releaseId": job["releaseId"]})

        def notify(state, code):
            self.client.json("/api/node-updater/report", {
                "jobId": job["id"], "leaseToken": job["leaseToken"], "state": state, "code": code,
            })
            save(work / "last-report.json", {"state": state, "code": code, "reportedAt": int(time.time() * 1000)})

        transaction = read(work / "transaction.json") if (work / "transaction.json").exists() else None
        if (pending and pending["id"] == job["id"] and pending.get("recovered")) or (
                transaction and transaction["state"] == "rolled_back"):
            notify("rolled_back", "recovered_rollback")
            self.pending.unlink()
            return {"state": "rolled_back"}
        if transaction and transaction["state"] == "succeeded":
            self.runtime.health(self.runtime.snapshot())
            notify("succeeded", "ok")
            self.pending.unlink()
            return {"state": "succeeded"}
        try:
            # Staging has no service side effects. A fresh, explicit retry gets new paths;
            # never repeat a half-staged transaction or move its state backwards.
            require(job["state"] == "claimed", "configuration_changed")
            manifest, digest = verify_envelope(job["envelope"], self.config["releasePublicKey"], work)
            require(digest == job["digest"] and manifest["id"] == job["releaseId"], "signature_invalid")
            answer = Upgrade(self.runtime, notify, self.client.download).execute(manifest, digest, work)
        except Exception as original:
            diagnostic = work / "failure.private.log"
            diagnostic.write_text(traceback.format_exc())
            diagnostic.chmod(0o600)
            error = original if isinstance(original, UpdateError) else UpdateError("operation_failed")
            journal = read(work / "transaction.json") if (work / "transaction.json").exists() else None
            if journal and journal["state"] in {"succeeded", "rolled_back"}:
                # The local transaction is already final; retry only its acknowledgement.
                raise
            if error.code == "lease_lost":
                # Do not misreport a revoked lease or repeat an uncertain transaction.
                raise
            state = "needs_migration" if error.code in {"model_auth_migration_required", "migration_unsupported"} else (
                "needs_action" if error.code in {"busy", "unsupported_platform", "runtime_incompatible",
                                                "configuration_changed", "model_login_required", "rollback_failed"} else "failed")
            notify(state, error.code if error.code in {
                "model_auth_migration_required", "migration_unsupported", "busy", "unsupported_platform",
                "runtime_incompatible", "configuration_changed", "model_login_required", "rollback_failed",
                "signature_invalid", "stage_failed", "health_failed", "model_failed", "download_failed",
            } else "operation_failed")
            answer = {"state": state, "code": error.code}
        self.pending.unlink(missing_ok=True)
        return answer


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default=str(Path.home() / ".config/codey-updater/config.json"))
    parser.add_argument("command", choices=["status", "once", "run"])
    args = parser.parse_args()
    require(sys.platform == "linux" and os.getuid() != 0, "unsupported_platform")
    config = load_config(args.config)
    agent = Agent(config)
    if args.command == "status":
        print(json.dumps(agent.runtime.report()))
        return
    import fcntl
    with (agent.runtime.private / "agent.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        stopping = False
        def stop(*_):
            nonlocal stopping
            stopping = True
        signal.signal(signal.SIGTERM, stop)
        signal.signal(signal.SIGINT, stop)
        while not stopping:
            try:
                result = agent.once()
                print(json.dumps({"nodeId": config["nodeId"], "state": result.get("state", "polling")}), flush=True)
            except Exception as error:
                # Never write command stderr, provider secrets, enrollment data or response bodies to journald.
                code = error.code if isinstance(error, UpdateError) else "operation_failed"
                print(json.dumps({"nodeId": config["nodeId"], "code": code}), flush=True)
                if args.command == "once":
                    raise SystemExit(1)
            if args.command == "once":
                break
            for _ in range(15):
                if stopping:
                    break
                time.sleep(1)


if __name__ == "__main__":
    main()
