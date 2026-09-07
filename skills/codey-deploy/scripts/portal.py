"""Small authenticated Codey acceptance check with a revocable synthetic session."""
from concurrent.futures import ThreadPoolExecutor
import base64
import hashlib
import hmac
import json
import logging
import os
from pathlib import Path
import re
import secrets
import sys
import time

import requests
from azure.core.exceptions import ResourceNotFoundError
from azure.storage.fileshare import ShareFileClient

from builder import Builder
from common import NODES, command, read, require, save

logging.disable(logging.CRITICAL)


def b64(data):
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


class Portal:
    def __init__(self, request):
        self.request = request
        self.builder = Builder(request)
        self.job = self.builder.job
        before = read(self.job / "aca-before.private.json")
        self.base = "https://" + before["properties"]["configuration"]["ingress"]["fqdn"]
        self.cookie = None
        self.session_file = None
        self.created = False
        self.report = {"passed": False, "mcpTests": "skipped-by-user", "existingUserSessionsModified": 0}

    def http(self, path, *, authenticated=True, expected=200, origin=None, method="GET"):
        require(path.startswith("/") and not path.startswith("//"), "Unsafe probe URL")
        headers = {"Origin": origin or self.base, "Cache-Control": "no-cache"}
        if authenticated:
            headers["Cookie"] = self.cookie
        response = requests.request(method, self.base + path, headers=headers, timeout=15, allow_redirects=False)
        require(response.status_code == expected, f"Probe HTTP {response.status_code}: {path}")
        require(len(response.content) <= 16 * 1024 * 1024, "Probe response exceeds limit")
        return response

    def session(self):
        config = self.builder.config
        with ThreadPoolExecutor(max_workers=2) as pool:
            storage = pool.submit(self.builder.az, [
                "storage", "account", "keys", "list", "-g", config["resourceGroup"],
                "--account-name", config["storageAccount"], "--query", "[0].value"])
            auth = pool.submit(self.builder.az, [
                "containerapp", "secret", "list", "-n", "codey", "-g", config["resourceGroup"], "--show-values",
                "--query", "[?name=='codey-password-account'||name=='codey-workspace-sso'].{name:name,value:value}"])
            key = storage.result()
            values = {row["name"]: row["value"] for row in auth.result()}
        credential = json.loads(values["codey-password-account"])

        def file(path):
            return ShareFileClient(f"https://{config['storageAccount']}.file.core.windows.net",
                                   share_name=config["share"], file_path=path, credential=key,
                                   connection_timeout=8, read_timeout=15)

        accounts = file("portal-auth/accounts.json")
        require(accounts.get_file_properties().size < 16 * 1024 * 1024, "Unexpected account-store size")
        envelope = json.loads(accounts.download_file().readall())
        store_key = hmac.new(values["codey-workspace-sso"].encode(), b"codey-store-v1:accounts.json", hashlib.sha256).digest()
        require(hmac.compare_digest(b64(hmac.new(store_key, envelope["payload"].encode(), hashlib.sha256).digest()),
                                    envelope["mac"]), "Account-store integrity failed")
        account = next(row for row in json.loads(envelope["payload"])["data"]["users"]
                       if row["principalId"] == credential["principalId"])
        require(account["enabled"] and account["role"] == "admin", "Deployment account is disabled")
        token = b64(secrets.token_bytes(32))
        session_id = hashlib.sha256(token.encode()).hexdigest()
        session = {"version": account["authVersion"], "expiresAt": int(time.time() * 1000) + 240000,
                   "userId": account["principalId"]}
        digest = account["passwordHash"].split("$")[2]
        digest = base64.urlsafe_b64decode(digest + "=" * (-len(digest) % 4))
        signed = f"codey-session-v1:{session_id}:{session['version']}:{session['userId']}:{session['expiresAt']}"
        session["mac"] = b64(hmac.new(digest, signed.encode(), hashlib.sha256).digest())
        self.session_file = file(f"portal-auth/sessions/{session_id}.json")
        try:
            self.session_file.get_file_properties()
            raise RuntimeError("Synthetic session collision")
        except ResourceNotFoundError:
            pass
        self.created = True  # Cleanup also reconciles a timed-out upload.
        self.session_file.upload_file(json.dumps(session).encode(), metadata={"codey_deploy_probe": self.builder.release})
        self.cookie = "__Host-codey_session=" + token
        require(self.http("/portal-auth/session").json()["userId"] == account["principalId"], "Session identity mismatch")

    def status(self):
        targets = self.request.get("nodes", list(NODES))
        require(set(targets).issubset(NODES), "Unexpected probe targets")
        def check(node):
            running = self.http(f"/cloudcli/{node}/api/providers/sessions/running").json()["data"]["sessions"]
            require(isinstance(running, list), "Invalid running-session response")
            return {"node": node, "runningSessionCount": len(running), "observedAt": time.time()}
        with ThreadPoolExecutor(max_workers=4) as pool:
            return list(pool.map(check, targets))

    def models(self, nodes):
        output, seconds = command(
            ["node", str(Path(__file__).with_name("codey-model.mjs"))], timeout=100,
            input=json.dumps({
                "base": self.base, "cookie": self.cookie, "nodes": nodes,
                "projectPath": f"/home/zhn/.local/share/codey-deploy/{self.builder.release}/probe",
                "dependencyRoot": str(self.job / "source/cloudcli"),
            }),
            log=self.job / ("codey-model-" + "-".join(nodes) + ".private.log"),
        )
        result = json.loads(output)
        require(result["passed"], "A Codey real model call failed")
        return {**result, "seconds": seconds}

    def verify(self):
        require(read(self.job / "aca-result.json")["ready"], "ACA rollout has not completed")
        active = read(self.job / "ui-result.json")["active"]
        self.http("/api/health", authenticated=False)
        manifest = read(self.job / "manifest.json")
        ui_manifest = read(Path(manifest["ui"]["directory"]) / "ui-package.json")
        def check(node):
            prefix = f"/cloudcli/{node}"
            html = self.http(prefix + "/")
            require(html.headers["x-codey-ui-release"] == active["release"], "Wrong shared UI release")
            entry = re.search(r'<script[^>]*type="module"[^>]*src="([^"]+)"', html.text).group(1)
            require(entry.startswith(ui_manifest["assetBase"]), "Wrong shared UI asset base")
            require(self.http(prefix + "/api/auth/status").json()["managedAuthentication"], "Workspace SSO failed")
            self.http(prefix + "/api/auth/status", authenticated=False, expected=401)
            self.http(f"/api/node-data/{node}/usage")
            self.http(f"/api/node-data/{node}/usage", authenticated=False, expected=401)
            self.http(prefix + "/api/auth/status", origin="https://untrusted.invalid", method="POST", expected=403)
            return {"node": node, "ui": active["release"], "sso": 200, "usage": 200,
                    "anonymous": 401, "foreignOrigin": 403, "entry": entry}
        targets = self.request.get("nodes", list(NODES))
        require(targets and set(targets).issubset(NODES), "Unexpected verification targets")
        with ThreadPoolExecutor(max_workers=4) as pool:
            nodes = list(pool.map(check, targets))
        entries = {row["entry"] for row in nodes}
        require(len(entries) == 1, "Nodes are serving different shared UI assets")
        entry = next(iter(entries))
        name = entry[len(ui_manifest["assetBase"]):]
        require(hashlib.sha256(self.http(entry).content).hexdigest() == ui_manifest["files"][name]["sha256"],
                "Served UI entry checksum mismatch")
        model_nodes = self.request.get("modelNodes", targets)
        models = self.models(model_nodes) if model_nodes else {"passed": True, "nodes": []}
        return {"nodes": nodes, "codeyModels": models, "portalHealth": 200,
                "sharedUiEntryVerified": True, "allPublishedAssetsVerifiedDuringUpload": True}

    def verify_portal(self):
        manifest = read(self.job / "manifest.json")
        require(manifest["scope"] == "portal", "Not a Portal-only release")
        require(read(self.job / "aca-result.json")["ready"], "ACA is not ready")
        self.http("/api/health", authenticated=False)
        for pathname, digest in manifest["publicSha256"].items():
            require(hashlib.sha256(self.http(pathname).content).hexdigest() == digest,
                    "Production public file differs from the frozen source: " + pathname)
        history_hidden = manifest.get("features", {}).get("sessionHistory") is False
        if history_hidden:
            html = self.http("/?view=sessions").text
            require(re.search(r'<button[^>]+data-portal-view="sessions"[^>]+\bhidden\b', html),
                    "Session History navigation is not hidden before hydration")
        def check(node):
            prefix = f"/cloudcli/{node}"
            require(self.http(prefix + "/").headers["x-codey-ui-release"] == manifest["sharedUi"]["release"],
                    "Portal-only deployment changed shared Workspace UI")
            require(self.http(prefix + "/api/auth/status").json()["managedAuthentication"], "Workspace SSO failed")
            self.http(prefix + "/api/auth/status", authenticated=False, expected=401)
            self.http(f"/api/node-data/{node}/usage")
            return {"node": node, "workspaceSso": 200, "anonymous": 401, "usage": 200}
        with ThreadPoolExecutor(max_workers=4) as pool:
            nodes = list(pool.map(check, NODES))
        return {"portalHealth": 200, "sessionHistoryHidden": history_hidden,
                "publicFilesVerified": len(manifest["publicSha256"]), "sharedUiUnchanged": True, "nodes": nodes,
                "realModelCalls": 0, "acceptanceScope": "Portal navigation, deployed source, Workspace SSO and Usage"}

    def run(self):
        try:
            self.session()
            mode = self.request["mode"]
            if mode == "status":
                self.report["nodes"] = self.status()
            elif mode == "models":
                self.report["codeyModels"] = self.models(self.request["nodes"])
            elif mode == "verify":
                self.report.update(self.verify())
            elif mode == "verify_portal":
                self.report.update(self.verify_portal())
            else:
                raise RuntimeError("Unknown Portal operation")
            self.report["passed"] = True
            return self.report
        finally:
            if self.created:
                try:
                    self.session_file.delete_file()
                except ResourceNotFoundError:
                    pass
                if self.cookie:
                    self.http("/portal-auth/session", expected=401)
                self.report["syntheticSessionRevoked"] = True
            save(self.job / ("portal-" + self.request["mode"] + ".json"), self.report)


if __name__ == "__main__":
    request = json.load(sys.stdin)
    try:
        print(json.dumps({"ok": True, "result": Portal(request).run()}), flush=True)
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)}), flush=True)
        raise SystemExit(1)
