"""Owner-scoped node transaction: immutable packages, no credential migration."""
import hashlib
import http.client
import ipaddress
import json
import os
from pathlib import Path
import re
import shutil
import socket
import sqlite3
import ssl
import sys
import time
import urllib.error
import urllib.request

from common import NODES, command, read, release_name, require, safe_extract, save, sha


def environment(pid):
    return dict(part.decode().split("=", 1) for part in
                Path(f"/proc/{pid}/environ").read_bytes().split(b"\0") if b"=" in part)


def pid(service):
    value = int(command(["systemctl", "--user", "show", service, "-p", "MainPID", "--value"], timeout=10)[0])
    require(value > 0, f"{service} is not running")
    return value


def model_connections(process):
    inodes = set()
    for entry in Path(f"/proc/{process}/fd").iterdir():
        try:
            target = os.readlink(entry)
            if target.startswith("socket:["):
                inodes.add(target[8:-1])
        except FileNotFoundError:
            pass
    count = 0
    for name in ("tcp", "tcp6"):
        for line in Path(f"/proc/net/{name}").read_text().splitlines()[1:]:
            fields = line.split()
            if fields[9] not in inodes or fields[3] != "01" or int(fields[1].rsplit(":", 1)[1], 16) != 4141:
                continue
            raw = bytes.fromhex(fields[2].rsplit(":", 1)[0])
            raw = b"".join(raw[index:index + 4][::-1] for index in range(0, len(raw), 4))
            address = ipaddress.ip_address(socket.inet_ntop(socket.AF_INET if name == "tcp" else socket.AF_INET6, raw))
            if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped:
                address = address.ipv4_mapped
            if str(address) != "168.63.129.16":  # Azure load-balancer TCP probe, not a caller.
                count += 1
    return count


def protected_hash(path):
    body = Path(path).read_bytes()
    if Path(path).as_posix().endswith("/.codex/config.toml"):
        # Login refresh adds/removes this timestamp; it is not an authentication or model setting.
        body = re.sub(rb'(?m)^last_updated\s*=\s*"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z"\r?\n?', b"", body)
    return hashlib.sha256(body).hexdigest()


class Node:
    def __init__(self, request):
        self.request = request
        self.node = request["node"]
        require(self.node in NODES, "Unsupported node (local Windows is never a target)")
        self.home = Path.home()
        require(self.home == Path("/home/zhn") and os.getuid() != 0, "Run only as the existing service owner")
        self.job = Path(__file__).resolve().parent
        self.release = release_name(self.job.name)
        require(self.job == self.home / ".local/share/codey-deploy" / self.release, "Unexpected deployment directory")
        self.install = self.home / ".local/share/codey-cloudcli"
        self.candidate = self.install / "releases" / self.release
        self.cp_home = self.home / ".local/share/copilot-api"
        self.key_file = self.home / ".config/codey-model-auth/api-key"

    def key(self):
        require(self.key_file.stat().st_mode & 0o777 == 0o600, "Model key permissions must be 0600")
        value = self.key_file.read_text().strip()
        require(len(value) >= 32, "Independent model API key is missing")
        return value

    def snapshot(self):
        cc, cp = pid("codey-cloudcli.service"), pid("copilot-api.service")
        cc_env, cp_env = environment(cc), environment(cp)
        require(cc_env.get("CODEY_PORTAL_NODE_ID") == cp_env.get("COPILOT_API_CODEY_NODE_ID") == self.node,
                "Node ownership does not match both running services")
        live = Path(f"/proc/{cc}/cwd").resolve(strict=True)
        require(live.is_relative_to(self.install / "releases") and (self.install / "current").resolve() == live,
                "CloudCLI release changed outside the managed installation")
        launch = {
            "westus2": self.home / ".local/bin/copilot-api", "jpe2": self.home / ".local/bin/copilot-api",
            "jpe3": self.home / ".nvm/versions/node/v26.5.0/bin/copilot-api",
            "zhn-a100": self.home / ".npm-global/bin/copilot-api",
        }[self.node]
        require(str(launch) in Path(f"/proc/{cp}/cmdline").read_bytes().decode().split("\0"),
                "Gateway service launch path changed")
        package = launch.resolve(strict=True).parent.parent
        require(package.is_relative_to(self.home) and read(package / "package.json")["name"] == "@jeffreycao/copilot-api",
                "Unexpected gateway package")
        require(os.stat(package).st_dev == os.stat(self.job).st_dev, "Package swap would cross filesystems")
        key = self.key()
        require(key in read(self.cp_home / "config.json").get("auth", {}).get("apiKeys", []),
                "Perform the separately authorized authentication migration before deploying")
        require(cc_env.get("CODEY_MODEL_API_KEY") == key, "CloudCLI has not loaded its model key")
        require('env_key = "CODEY_MODEL_API_KEY"' in (self.home / ".codex/config.toml").read_text(),
                "Codex model authentication is not configured")
        files = [
            self.home / ".codex/config.toml", self.home / ".codex/auth.json", self.key_file,
            self.home / ".config/codey-model-auth/env.sh",
            self.home / ".config/codey-cloudcli/provider.env", self.home / ".config/codey-cloudcli/portal-sso.env",
            self.home / ".config/systemd/user/codey-cloudcli.service",
            self.home / ".config/systemd/user/copilot-api.service",
            self.cp_home / "config.json", self.cp_home / "github_token",
            *(self.home / ".config/systemd/user/copilot-api.service.d").glob("*.conf"),
            *(Path(cp_env[name]) for name in ("COPILOT_API_CODEY_TLS_CERT", "COPILOT_API_CODEY_TLS_KEY",
                                             "COPILOT_API_CODEY_SIGNING_KEY_FILE")),
        ]
        return {
            "node": self.node, "cloudcliPid": cc, "copilotPid": cp, "cloudcliRelease": str(live),
            "gatewayPackage": str(package), "gatewayVersion": read(package / "package.json")["version"],
            "gatewayEntrySha256": sha(package / "dist/main.js"),
            "cloudcliNode": str(Path(f"/proc/{cc}/exe").resolve(strict=True)),
            "gatewayNode": str(Path(f"/proc/{cp}/exe").resolve(strict=True)),
            "bootId": Path("/proc/sys/kernel/random/boot_id").read_text().strip(),
            "database": cc_env["DATABASE_PATH"], "lockSha256": sha(live / "package-lock.json"),
            "protected": {str(file): protected_hash(file) for file in files if file.is_file()},
            "observedAt": time.time(),
        }

    def preflight(self):
        require(not (self.job / "baseline.json").exists(), "This run already has a baseline")
        require(shutil.disk_usage(self.job).free > 1024 ** 3, "Less than 1 GiB free for rollback-safe deployment")
        before = self.snapshot()
        save(self.job / "baseline.json", before)
        return {key: value for key, value in before.items() if key not in {"protected", "database"}}

    def unchanged(self):
        before, after = read(self.job / "baseline.json"), self.snapshot()
        for key in ("cloudcliPid", "copilotPid", "cloudcliRelease", "gatewayPackage", "gatewayEntrySha256",
                    "cloudcliNode", "gatewayNode", "bootId", "protected", "lockSha256"):
            require(before[key] == after[key], "Concurrent node change: " + key)
        return before

    def stage(self):
        before = self.unchanged()
        manifest = self.request["manifest"]
        require(manifest["release"] == self.release, "Package belongs to another release")
        for component, filename in (("cloudcli", "cloudcli.tar.gz"), ("gateway", "gateway.tar.gz")):
            require(sha(self.job / filename) == manifest[component]["archiveSha256"], "Package checksum mismatch")
        safe_extract(self.job / "cloudcli.tar.gz", self.candidate)
        safe_extract(self.job / "gateway.tar.gz", self.job / "gateway")
        require(sha(self.candidate / "dist-server/server/index.js") == manifest["cloudcli"]["entrySha256"],
                "CloudCLI built entry differs")
        require(sha(self.job / "gateway/dist/main.js") == manifest["gateway"]["entrySha256"], "Gateway entry differs")
        prior = Path(before["cloudcliRelease"])
        require(sha(self.candidate / "package-lock.json") == manifest["cloudcli"]["lockSha256"], "CloudCLI lock differs")
        for directory in ("dist", ".codey-bin"):
            shutil.copytree(prior / directory, self.candidate / directory, symlinks=True)
        if before["lockSha256"] == manifest["cloudcli"]["lockSha256"]:
            # The same running Node executable/ABI will use these already-working dependencies.
            # The dependency-owning release must not be pruned while this link exists.
            (self.candidate / "node_modules").symlink_to((prior / "node_modules").resolve(), target_is_directory=True)
            mode = "reused-locked-node-local-dependencies"
        else:
            node = before["cloudcliNode"]
            npm = Path(node).parent.parent / "lib/node_modules/npm/bin/npm-cli.js"
            if not npm.is_file():
                npm = Path("/usr/share/nodejs/npm/bin/npm-cli.js")
            require(npm.is_file(), "No matching npm runtime")
            env = {"PATH": str(Path(node).parent) + ":/usr/bin:/bin", "HOME": str(self.job),
                   "CI": "true", "HUSKY": "0", "ELECTRON_SKIP_BINARY_DOWNLOAD": "1",
                   "DATABASE_PATH": ":memory:", "CODEY_MANAGED": "false", "CODEY_PORTAL_SSO": "false"}
            command([node, npm, "ci", "--omit=dev", "--no-audit", "--no-fund"],
                    cwd=self.candidate, env=env, timeout=150, log=self.job / "install.log")
            mode = "cold-production-install"
        (self.job / "probe").mkdir(mode=0o700)
        self.unchanged()
        save(self.job / "manifest.json", manifest)
        result = {"node": self.node, "staged": True, "dependencyMode": mode, "archiveChecksumsVerified": True,
                  "compiledOnNode": False, "fullTestsRunOnNode": False}
        save(self.job / "stage.json", result)
        return result

    def idle(self):
        proof = self.request["idle"]
        require(proof["node"] == self.node and proof["runningSessionCount"] == 0
                and 0 <= time.time() - proof["observedAt"] < 60, "Missing fresh authenticated Codey idle proof")
        deadline = time.monotonic() + 20
        quiet = None
        while time.monotonic() < deadline:
            if model_connections(pid("copilot-api.service")) == 0:
                quiet = quiet or time.monotonic()
                if time.monotonic() - quiet >= 3:
                    return
            else:
                quiet = None
            time.sleep(0.5)
        raise RuntimeError("Model callers are busy; no service was interrupted")

    def backup(self, before):
        folder = self.job / "backup"
        folder.mkdir(mode=0o700)
        for source, name in ((Path(before["database"]), "cloudcli-auth.sqlite"),
                             (self.cp_home / "copilot-api.sqlite", "copilot-api.sqlite")):
            if source.is_file():
                with sqlite3.connect("file:" + str(source) + "?mode=ro", uri=True, timeout=5) as src:
                    with sqlite3.connect(folder / name) as target:
                        deadline = time.monotonic() + 20
                        def progress(*_):
                            require(time.monotonic() < deadline, "Online database backup timed out")
                        src.backup(target, pages=512, progress=progress, sleep=0.02)
                        require(target.execute("PRAGMA quick_check").fetchone()[0] == "ok", "Invalid database backup")
                (folder / name).chmod(0o600)
        marker = self.cp_home / "portal-build.json"
        if marker.is_file():
            shutil.copy2(marker, folder / "portal-build.json")
        save(folder / "rollback.json", {"previousCloudcli": before["cloudcliRelease"],
             "gatewayPackage": before["gatewayPackage"], "restoreDatabasesOrCredentials": False})

    def swap_cloudcli(self, target):
        temporary = self.install / ("current." + self.release)
        require(not temporary.exists() and not temporary.is_symlink(), "Unexpected pending symlink")
        temporary.symlink_to(target, target_is_directory=True)
        os.replace(temporary, self.install / "current")

    def http(self, path, key=None):
        request = urllib.request.Request("http://127.0.0.1:4141" + path,
                                         headers={"Authorization": "Bearer " + key} if key else {})
        try:
            response = urllib.request.urlopen(request, timeout=4)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            return response.status, response.read(4 * 1024 * 1024)

    def health(self):
        deadline = time.monotonic() + 45
        while time.monotonic() < deadline:
            try:
                status, body = self.http("/v1/models", self.key())
                require(status == 200 and json.loads(body)["data"], "No authenticated model metadata")
                require(self.http("/v1/models")[0] == self.http("/v1/models", "invalid-release-probe")[0] == 401,
                        "Model authentication is not enforced")
                env = environment(pid("codey-cloudcli.service"))
                context = ssl.create_default_context(cafile=str(self.job / "ca.pem"))
                host = self.request["tlsServerName"]
                raw = socket.create_connection((env["HOST"], int(env["SERVER_PORT"])), timeout=4)
                connection = http.client.HTTPSConnection(host, int(env["SERVER_PORT"]), timeout=4, context=context)
                connection.sock = context.wrap_socket(raw, server_hostname=host)
                try:
                    connection.request("GET", "/health")
                    response = connection.getresponse()
                    response.read(65536)
                    require(response.status == 200, "CloudCLI health failed")
                finally:
                    connection.close()
                return {"gatewayModels": 200, "anonymous": 401, "wrongKey": 401, "cloudcliTlsHealth": 200}
            except (OSError, ValueError, RuntimeError, http.client.HTTPException):
                time.sleep(1)
        raise RuntimeError("Post-activation health/authentication failed")

    def activate(self):
        require(read(self.job / "stage.json")["staged"], "Node was not staged")
        before = self.unchanged()
        self.idle()
        self.backup(before)
        self.unchanged()
        self.idle()
        package = Path(before["gatewayPackage"])
        backup = self.job / "backup/gateway-package"
        moved = switched = cc_switched = False
        try:
            os.replace(package, backup)
            moved = True
            os.replace(self.job / "gateway", package)
            switched = True
            manifest = read(self.job / "manifest.json")
            gateway = manifest["gateway"]
            save(self.cp_home / "portal-build.json", {
                "artifactId": f"copilot-api-{gateway['version']}-{gateway['sourceCommit'][:8]}-codey",
                "version": gateway["version"], "sourceCommit": gateway["sourceCommit"],
                "label": "Codey verified fast release", "sha256": gateway["archiveSha256"],
                "buildDate": time.strftime("%Y-%m-%d", time.gmtime()), "release": self.release,
            })
            self.swap_cloudcli(self.candidate)
            cc_switched = True
            command(["systemctl", "--user", "restart", "copilot-api.service", "codey-cloudcli.service"], timeout=40,
                    log=self.job / "restart.log")
            health = self.health()
            after = self.snapshot()
            require(after["protected"] == before["protected"], "Protected configuration changed across activation")
            require(after["cloudcliRelease"] == str(self.candidate), "Wrong running CloudCLI release")
            require(after["gatewayEntrySha256"] == gateway["entrySha256"], "Wrong running gateway build")
            require(after["cloudcliPid"] != before["cloudcliPid"] and after["copilotPid"] != before["copilotPid"],
                    "A service did not switch to the new package")
            result = {"node": self.node, "deployed": True, "release": self.release,
                      "cloudcliCommit": manifest["cloudcli"]["sourceCommit"], "gatewayCommit": gateway["sourceCommit"],
                      "cloudcliPid": after["cloudcliPid"], "copilotPid": after["copilotPid"], "health": health,
                      "protectedConfigurationPreserved": True, "backup": str(self.job / "backup")}
            save(self.job / "activation.json", result)
            return result
        except Exception:
            # Roll back only packages owned by this exact transaction, never user databases.
            if cc_switched:
                require((self.install / "current").resolve() == self.candidate, "CloudCLI superseded; do not roll back")
                self.swap_cloudcli(Path(before["cloudcliRelease"]))
            if moved:
                if switched:
                    require(read(package / "codey-release.json")["release"] == self.release,
                            "Gateway superseded; do not roll back")
                    os.replace(package, self.job / "failed-gateway")
                os.replace(backup, package)
                marker_backup = self.job / "backup/portal-build.json"
                if marker_backup.is_file():
                    shutil.copy2(marker_backup, self.cp_home / "portal-build.json")
                else:
                    (self.cp_home / "portal-build.json").unlink(missing_ok=True)
            command(["systemctl", "--user", "restart", "copilot-api.service", "codey-cloudcli.service"], timeout=40)
            save(self.job / "rollback-result.json", {"packagesRestored": True, "health": self.health(),
                                                   "databasesAndCredentialsRestored": False})
            raise

    def model(self):
        require(read(self.job / "activation.json")["deployed"], "Node activation did not pass")
        key = self.key()
        output, _ = command(["bash", "-lc", "env -0"], timeout=15)
        env = dict(part.split("=", 1) for part in output.split("\0") if "=" in part)
        require(env.get("CODEY_MODEL_API_KEY") == key, "Fresh login shell does not load the API key")
        cli = shutil.which("codex", path=env["PATH"])
        require(cli is not None, "Codex is absent from the login PATH; fix separately, do not change Node silently")
        marker = "CODEX_FAST_DEPLOY_OK"
        answer = self.job / "codex-answer.txt"
        args = [cli, "exec", "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only", "--json",
                "--config", 'approval_policy="never"', "--output-last-message", str(answer)]
        for name in re.findall(r"(?m)^\[mcp_servers\.([A-Za-z0-9_-]+)\]", (self.home / ".codex/config.toml").read_text()):
            args.extend(["--config", f"mcp_servers.{name}.enabled=false"])
        args.append(f"Authorized deployment connectivity check. Reply with exactly {marker}. "
                    "Do not use tools, read files, browse, or make changes.")
        output, seconds = command(args, cwd=self.job / "probe", env=env, timeout=75,
                                  log=self.job / "codex-model.private.jsonl")
        require(answer.is_file() and answer.read_text().strip() == marker, "Codex real model response mismatch")
        events = []
        for line in output.splitlines():
            try:
                events.append(json.loads(line))
            except ValueError:
                pass
        require(any(row.get("type") == "turn.completed" for row in events), "Codex turn did not complete")
        thread = next(row["thread_id"] for row in events if row.get("type") == "thread.started")
        matches = []
        for _ in range(8):
            status, body = self.http("/token-usage/events?period=day&page_size=100&page=1", key)
            require(status == 200, "Cannot verify the model request in gateway events")
            matches = [row for row in json.loads(body).get("items", []) if row.get("session_id") == thread]
            if matches:
                break
            time.sleep(0.5)
        require(matches, "The real Codex call did not produce an authenticated gateway event")
        result = {"node": self.node, "passed": True, "response": marker, "threadId": thread,
                  "seconds": seconds, "ephemeral": True, "freshLoginAuthentication": True,
                  "model": matches[0].get("model"), "effort": matches[0].get("reasoning_effort")}
        save(self.job / "codex-result.json", result)
        return result


if __name__ == "__main__":
    import fcntl
    request = json.load(sys.stdin)
    worker = Node(request)
    locks = [
        (worker.home / ".local/share/codey-deploy/operation.lock").open("a"),
        (worker.install / "backend-deploy.lock").open("a"),
    ]
    try:
        for handle in locks:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        result = getattr(worker, request["mode"])()
        print(json.dumps({"ok": True, "result": result}), flush=True)
    except Exception as error:
        save(worker.job / (request["mode"] + "-error.json"), {"error": str(error), "type": type(error).__name__})
        print(json.dumps({"ok": False, "error": str(error)}), flush=True)
        raise SystemExit(1)
