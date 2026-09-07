"""Builder-side signed feed + normal owner API. No remote shell channel in ACA."""
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
from pathlib import Path
import sys
import time
import zipfile

import requests

from builder import Builder
from common import NODES, command, read, require, save
from portal import Portal


class Updates:
    def __init__(self, request):
        self.request = request
        self.builder = Builder(request)
        self.job = self.builder.job
        self.portal = None
        self.session_started = 0
        self.targets = request.get("nodes", list(NODES))
        require(self.targets and len(set(self.targets)) == len(self.targets) and set(self.targets).issubset(NODES),
                "Unexpected node update targets")

    def close(self):
        if self.portal and self.portal.created:
            self.portal.session_file.delete_file()
            self.portal.created = False

    def api(self, path, value=None, binary=False):
        require(path.startswith("/api/settings/"), "Only normal owner settings endpoints are permitted")
        if not self.portal or time.monotonic() - self.session_started > 150:
            self.close()
            self.portal = Portal(self.request)
            self.portal.session()
            self.session_started = time.monotonic()
        response = requests.request(
            "GET" if value is None else "POST", self.portal.base + path, json=value,
            headers={"Cookie": self.portal.cookie, "Origin": self.portal.base}, timeout=45, allow_redirects=False)
        require(response.status_code in {200, 202}, f"Owner update API returned {response.status_code}: {path}")
        require(len(response.content) <= 8 * 1024 * 1024, "Oversized settings response")
        return response.content if binary else response.json()

    def publish(self):
        source = self.builder.source / "portal"
        manifest = self.job / "manifest.json"
        require(read(self.job / "validation.json")["passed"], "Build tests must pass before signing")
        signing = Path.home() / ".config/codey-node-release-signing"
        signing.mkdir(mode=0o700, parents=True, exist_ok=True)
        private, public = signing / "private.pem", signing / "public.pem"
        require(private.exists() == public.exists(), "Incomplete signing key pair; never replace an existing trust root")
        if not private.exists():
            command(["node", str(source / "scripts/publish-node-update.mjs"), "keygen",
                     "--private-key", private, "--public-key", public], timeout=15)
        require(private.stat().st_mode & 0o777 == 0o600, "Signing private key permissions must be 0600")
        store = self.builder.publisher().AzureStore({**self.builder.config, "directory": "node-updates"})
        store.ensure_root()
        store.mkdir("publish.lock", exclusive=True)
        try:
            pinned = store.read("release-public.pem", 8192)
            require(pinned is None or pinned == public.read_bytes(), "Release signing public key changed")
            feed = self.job / "node-update-feed"
            feed.mkdir(mode=0o700, exist_ok=True)
            previous = store.read("catalog.json", 4 * 1024 * 1024)
            sequence = 1
            if previous:
                (feed / "catalog.json").write_bytes(previous)
                import base64
                sequence = max((json.loads(base64.b64decode(row["payload"]))["sequence"]
                                for row in json.loads(previous)["releases"]), default=0) + 1
            command(["node", str(source / "scripts/publish-node-update.mjs"), "publish", "--manifest", manifest,
                     "--output", feed, "--private-key", private, "--sequence", str(sequence),
                     "--cloudcli-node-majors", "22,24", "--gateway-node-majors", "22,24,26",
                     "--notes", "Reviewed Codey fleet build; retain existing Node/identity; both clients must pass real model checks"],
                    timeout=60, log=self.job / "node-update-signing.log")
            release = read(manifest)["release"]
            files = [("releases/" + release + "/" + item.name, item)
                     for item in (feed / "releases" / release).iterdir()]
            if pinned is None:
                store.write_new("release-public.pem", public.read_bytes())
            def upload(item):
                name, file = item
                payload = file.read_bytes()
                store.write_new(name, payload)
                require(hashlib.sha256(store.read(name, len(payload))).digest() == hashlib.sha256(payload).digest(),
                        "Published node artifact differs")
            # Create directories before concurrent immutable file uploads.
            store.mkdir("releases/" + release)
            with ThreadPoolExecutor(max_workers=3) as pool:
                list(pool.map(upload, files))
            next_name = "catalog-" + release + ".next"
            store.write_new(next_name, (feed / "catalog.json").read_bytes())
            store.replace(next_name, "catalog.json")
            result = {"releaseId": release, "sequence": sequence, "signed": True,
                      "artifactsVerified": True, "privateKeyDistributed": False}
            save(self.job / "node-update-release.json", result)
            return result
        finally:
            store.rmdir("publish.lock")

    def bootstrap(self):
        status = self.api("/api/settings/updates")
        targets = {node["id"]: node for node in status["nodes"]}
        require(all(node in targets and not targets[node]["protected"] for node in self.targets),
                "Deployment owner does not own the selected remote nodes")
        outputs = []
        directory = self.job / "updater-bootstrap-private"
        directory.mkdir(mode=0o700, exist_ok=True)
        source_archive = directory / "agent-source.zip"
        with zipfile.ZipFile(source_archive, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for name in ["updater.py", "engine.py", "probe.mjs", "install.py", "UPGRADE.md"]:
                archive.write(self.builder.source / "portal/node-updater" / name, "codey-updater/" + name)
        source_archive.chmod(0o600)
        for node in self.targets:
            require(not targets[node]["activeJob"], "A selected node still has an unfinished update; do not replace its updater")
            if targets[node]["enrolled"]:
                outputs.append({"node": node, "alreadyEnrolled": True, "useExistingConfig": True,
                                "file": str(source_archive), "sha256": hashlib.sha256(source_archive.read_bytes()).hexdigest()})
                continue
            payload = self.api("/api/settings/updates/bootstrap/" + node,
                               {"confirmation": "enable-node-updater"}, binary=True)
            file = directory / (node + ".zip")
            file.write_bytes(payload)
            file.chmod(0o600)
            outputs.append({"node": node, "file": str(file), "sha256": hashlib.sha256(payload).hexdigest()})
        return {"nodes": outputs}

    def rollout(self):
        release = read(self.job / "node-update-release.json")["releaseId"]
        started = time.monotonic()
        while time.monotonic() - started < 70:
            status = self.api("/api/settings/updates")
            targets = {node["id"]: node for node in status["nodes"]}
            if all(targets.get(node, {}).get("connected") for node in self.targets):
                break
            time.sleep(3)
        require(all(targets.get(node, {}).get("connected") for node in self.targets), "A node updater did not connect; do not restart model services")
        plan = self.api("/api/settings/updates/plans", {"nodeIds": self.targets, "releaseId": release})
        require(all(row["eligible"] or row["reason"] == "up_to_date" for row in plan["targets"]),
                "A node requires compatibility/configuration migration; inspect the Settings preview")
        selected = [row for row in plan["targets"] if row["eligible"]]
        if not selected:
            return {"state": "already-verified", "releaseId": release, "jobs": [], "realModelCallsThisRun": 0}
        result = self.api("/api/settings/updates/jobs", {"planId": plan["id"], "confirmation": "update-reviewed-machines"})
        save(self.job / "node-update-jobs.json", result)
        ids = {job["id"] for job in result["jobs"]}
        terminal = {"succeeded", "failed", "rolled_back", "needs_action", "needs_migration", "cancelled"}
        while time.monotonic() - started < 480:
            jobs = [row for row in self.api("/api/settings/updates")["jobs"] if row["id"] in ids]
            save(self.job / "node-update-progress.json", {"jobs": jobs, "seconds": round(time.monotonic() - started, 3)})
            failed = [row for row in jobs if row["state"] in terminal and row["state"] != "succeeded"]
            require(not failed, "Node update requires attention: " + ",".join(row["nodeId"] + ":" + str(row["code"]) for row in failed))
            if len(jobs) == len(ids) and all(row["state"] == "succeeded" for row in jobs):
                return {"state": "succeeded", "releaseId": release, "jobs": jobs,
                        "codeyModelCalls": len(jobs), "codexModelCalls": len(jobs),
                        "seconds": round(time.monotonic() - started, 3)}
            time.sleep(5)
        raise TimeoutError("Node rollout still pending. Inspect the durable jobs; do not enqueue duplicates or kill transactions.")


def main():
    request = json.load(sys.stdin)
    updates = Updates(request)
    try:
        require(request["mode"] in {"publish", "bootstrap", "rollout"}, "Unknown updater release operation")
        result = getattr(updates, request["mode"])()
        print(json.dumps({"ok": True, "result": result}), flush=True)
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)}), flush=True)
        raise SystemExit(1)
    finally:
        updates.close()


if __name__ == "__main__":
    main()
