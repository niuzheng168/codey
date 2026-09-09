#!/usr/bin/env python3
"""One timed release command. SSH remains the only node distribution channel."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import datetime
import json
import os
from pathlib import Path
import secrets
import shlex
import sys
import time
import zipfile

from common import NODES, command, phase, read, release_name, require, save, sha


class Deploy:
    def __init__(self, args):
        expected = {name: value for name, value in [
            ("portal", getattr(args, "expected_portal_commit", None)),
            ("cloudcli", getattr(args, "expected_cloudcli_commit", None)),
        ] if value}
        require(all(len(value) == 40 and set(value) <= set("0123456789abcdef") for value in expected.values()),
                "Expected source commits must be full lowercase SHA-1 values")
        self.args = args
        self.started = time.monotonic()
        resumed = getattr(args, "resume_release", None)
        self.release = release_name(resumed) if resumed else "fast-" + datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%d-%H%M%S-") + secrets.token_hex(3)
        self.root = Path(args.workspace).resolve()
        self.job = self.root / "artifacts" / self.release
        self.job.mkdir(mode=0o700, parents=True, exist_ok=bool(resumed))
        self.scripts = Path(__file__).resolve().parent
        self.nodes = tuple(args.nodes)
        require(self.nodes and len(set(self.nodes)) == len(self.nodes), "Choose distinct target nodes")
        self.remote = args.remote_root + "/artifacts/" + self.release
        self.node_job = "/home/zhn/.local/share/codey-deploy/" + self.release
        self.report = {"release": self.release, "startedAt": time.time(), "targetSeconds": args.target_seconds,
                       "status": "running", "forceActualRollout": True, "mcpTests": "skipped-by-user",
                       "protectedLocalCopilot": True, "phases": []}
        self.record = self.job / "report.json"
        if resumed:
            previous = read(self.record)
            require(previous["status"] == "needs-attention" and previous.get("scope") == "workspace-only"
                    and previous["selectedNodes"] == list(self.nodes),
                    "Resume only the same failed Workspace release and selected nodes")
            attempt = len(previous.get("previousAttempts", [])) + 1
            backup = self.job / f"report-attempt-{attempt}.json"
            require(not backup.exists(), "Previous attempt evidence must not be overwritten")
            save(backup, previous)
            self.report = {**previous, "status": "running", "previousAttempts": [
                *previous.get("previousAttempts", []),
                {"report": str(backup), "error": previous.get("error"), "finishedAt": previous.get("finishedAt")},
            ]}
            for name in ("error", "finishedAt", "withinTarget", "lockCleanupError"):
                self.report.pop(name, None)
            # Recovery/diagnosis time remains part of the original end-to-end clock.
            self.started = time.monotonic() - max(0, time.time() - previous["startedAt"])
        self.lock = self.root / "artifacts/.codey-deploy-controller.lock"
        with self.lock.open("x", encoding="utf-8") as output:
            json.dump({"release": self.release, "pid": os.getpid()}, output)
        self.base = {"root": args.remote_root, "registry": args.registry, "nodes": list(self.nodes)}
        if expected:
            self.base["expectedCommits"] = expected
        if getattr(args, "reconcile_aca", False):
            self.base["reconcileAca"] = True
        self.report["selectedNodes"] = list(self.nodes)
        self.report["skippedNodes"] = [node for node in NODES if node not in self.nodes]
        if args.node_transport == "updater" and args.scope == "fleet":
            self.base["enableNodeUpdates"] = True
        if args.seed:
            self.base["seed"] = args.seed
        self.manifest = None
        self.topology = None
        self.pool = ThreadPoolExecutor(max_workers=12)

    def ssh(self, host, args, *, input=None, timeout=180, log=None):
        return command(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", host, shlex.join(args)],
                       input=input, timeout=timeout, log=log)[0]

    def upload(self, host, files, destination):
        self.ssh(host, ["mkdir", "-p", destination], timeout=15)
        self.ssh(host, ["chmod", "700", destination], timeout=15)
        command(["scp", "-q", *files, f"{host}:{destination}/"], timeout=90)

    def worker(self, mode, *, script="builder.py", extra=None, timeout=330):
        entry = self.remote + "/scripts/" + script
        bootstrap = "import sys,runpy;sys.path.insert(0," + json.dumps(self.remote + "/scripts") + ");runpy.run_path(" + json.dumps(entry) + ",run_name='__main__')"
        output = self.ssh(self.args.builder, ["/opt/az/bin/python3", "-I", "-c", bootstrap],
                          input=json.dumps({**self.base, "mode": mode, **(extra or {})}), timeout=timeout,
                          log=self.job / f"{script}-{mode}.log")
        result = json.loads(output.splitlines()[-1])
        require(result["ok"], result.get("error", "Worker failed"))
        return result["result"]

    def node(self, node, mode, extra=None):
        data = {"node": node, "mode": mode, **(extra or {})}
        if self.topology:
            data.update(self.topology[node])
        if mode == "stage":
            data["manifest"] = self.manifest
            self.upload(node, [str(self.job / name) for name in ("cloudcli.tar.gz", "gateway.tar.gz", "ca.pem")],
                        self.node_job)
        output = self.ssh(node, ["python3", "-S", self.node_job + "/node.py"],
                          input=json.dumps(data), timeout=260,
                          log=self.job / f"{node}-{mode}.log")
        result = json.loads(output.splitlines()[-1])
        require(result["ok"], result.get("error", "Node worker failed"))
        save(self.job / f"{node}-{mode}.json", result["result"])
        return result["result"]

    def protected_local(self):
        require(os.name == "nt", "Use the Windows controller so the protected local gateway can be checked")
        script = (
            "$ErrorActionPreference='Stop'; "
            "$ids=@(Get-NetTCPConnection -LocalPort 4141 -State Listen | Select-Object -ExpandProperty OwningProcess -Unique); "
            "if($ids.Count -ne 1){throw 'Expected one protected gateway listener'}; "
            "$p=Get-Process -Id $ids[0]; "
            "@{pid=$p.Id;started=$p.StartTime.ToUniversalTime().ToString('o');path=$p.Path}|ConvertTo-Json -Compress"
        )
        output, _ = command(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script], timeout=15)
        return json.loads(output)

    def prepare_node(self, node):
        existing = self.ssh(node, ["systemctl", "--user", "show", "codey-node-updater.service",
                                   "--property=ActiveState", "--value"], timeout=20)
        require(existing.strip() != "active", "This node uses the independent updater; do not run the legacy SSH activator")
        self.upload(node, [str(self.scripts / name) for name in ("common.py", "node.py")], self.node_job)
        return self.node(node, "preflight")

    def idle(self, nodes):
        result = self.worker("status", script="portal.py", extra={"nodes": list(nodes)}, timeout=75)
        proof = {row["node"]: row for row in result["nodes"]}
        require(all(row["runningSessionCount"] == 0 for row in proof.values()),
                "A target has an active Codey task. Staging is safe; activation must wait for the user.")
        return proof

    def freeze_portal(self):
        """Use a temporary Git index; never commit, stash or modify the user's index."""
        base = command(["git", "rev-parse", "HEAD"], cwd=self.root)[0]
        files = command(["git", "ls-files", "--modified", "--others", "--exclude-standard", "-z"], cwd=self.root)[0]
        files = sorted(set(name for name in files.split("\0") if name))
        allowed = ("public/", "src/", "test/", "docs/", "skills/", "scripts/", "node-updater/")
        require(files and all(name.startswith(allowed) or name in {"Dockerfile", ".dockerignore", ".env.example", "package.json", "package-lock.json"}
                              for name in files), "Review unexpected source/config changes before snapshotting")
        require(not command(["git", "ls-files", "--deleted"], cwd=self.root)[0],
                "Reviewed Portal snapshot must not silently delete code")
        env = {**os.environ, "GIT_INDEX_FILE": str(self.job / "reviewed.index")}
        command(["git", "read-tree", "HEAD"], cwd=self.root, env=env)
        command(["git", "add", "--", *files], cwd=self.root, env=env)
        tree = command(["git", "write-tree"], cwd=self.root, env=env)[0]
        archive = self.job / "portal-reviewed.tar.gz"
        command(["git", "archive", "--format=tar.gz", "--output", archive, tree], cwd=self.root)
        result = {"kind": "reviewed-working-tree", "baseCommit": base, "tree": tree,
                  "archiveSha256": sha(archive), "changedFiles": files, "commitCreated": False, "pushed": False}
        save(self.job / "reviewed-source.json", result)
        return result

    def node_services(self, nodes=None, services=("codey-cloudcli.service", "copilot-api.service")):
        def inspect(node):
            output = self.ssh(node, [
                "systemctl", "--user", "show", *services,
                "--property=Id,ActiveState,MainPID,ExecMainStartTimestampMonotonic",
            ], timeout=20)
            require(output.count("ActiveState=active") == len(services) and "\nMainPID=0" not in output,
                    "A protected remote service is not active: " + node)
            return node, output
        return dict(self.pool.map(inspect, nodes if nodes is not None else getattr(self, "nodes", NODES)))

    def native_idle(self):
        script = (self.scripts / "native-idle.mjs").read_text(encoding="utf-8")
        def inspect(node):
            launch = ('p=$(systemctl --user show codey-cloudcli.service --property=MainPID --value); '
                      'test "$p" -gt 0 && exec "$(readlink /proc/$p/exe)" --input-type=module')
            output = self.ssh(node, ["sh", "-c", launch], input=script, timeout=60)
            result = json.loads(output.splitlines()[-1])
            require(result["activeCount"] == 0, "A native Codex task is still active on " + node)
            if self.args.verify_steering:
                require(result["available"], "Native steering requires the existing Codex app daemon on " + node)
            return node, result
        return dict(self.pool.map(inspect, self.nodes))

    def preserved_gateway(self):
        script = ("import json,pathlib; "
                  "p=pathlib.Path.home()/'.config/codey-updater/installed.json'; "
                  "x=json.loads(p.read_text()); "
                  "print(json.dumps({'releaseId':x['releaseId'],'gateway':x['components']['copilotApi']}))")
        rows = {}
        for node in self.nodes:
            rows[node] = json.loads(self.ssh(node, ["python3", "-I", "-S", "-c", script], timeout=20))
        return {"releaseId": next(iter(rows.values()))["releaseId"],
                "nodes": {node: row["gateway"] for node, row in rows.items()}}

    def refresh_reviewed_updater(self):
        attempt = len(self.report.get("previousAttempts", []))
        archive = self.job / f"reviewed-updater-source-{attempt}.zip"
        require(not archive.exists(), "Do not overwrite reviewed updater evidence")
        hashes = {}
        with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as bundle:
            for name in ["updater.py", "engine.py", "probe.mjs", "install.py", "UPGRADE.md"]:
                file = self.root / "node-updater" / name
                hashes[name] = sha(file)
                bundle.write(file, "codey-updater/" + name)
        self.upload(self.args.builder, [str(archive)], self.remote)
        results = [self.install_updater({
            "node": node, "alreadyEnrolled": True, "useExistingConfig": True,
            "file": self.remote + "/" + archive.name, "sha256": sha(archive),
        }) for node in self.nodes]
        return {"nodes": results, "reviewedFiles": hashes, "archiveSha256": sha(archive),
                "credentialReused": True, "applicationServicesRestarted": False}

    def run_workspace(self):
        self.report["scope"] = "workspace-only"
        self.report["components"] = ["cloudcli"]
        self.report["forceActualRollout"] = False
        self.base["components"] = ["cloudcli"]
        try:
            if self.args.resume_release:
                with phase(self.report, "resume-existing-signed-workspace-release", self.record):
                    self.upload(self.args.builder, [str(file) for file in self.scripts.iterdir()
                                                   if file.suffix in {".py", ".mjs"}], self.remote + "/scripts")
                    self.manifest = self.worker("resume_workspace", timeout=60)
                    if self.manifest.get("acaReconciliation"):
                        self.report["acaReconciliation"] = self.manifest["acaReconciliation"]
                    attempt = len(self.report["previousAttempts"])
                    for name in ("node-update-jobs", "node-update-progress"):
                        command(["scp", "-q", f"{self.args.builder}:{self.remote}/{name}.json",
                                 str(self.job / f"{name}-attempt-{attempt}.json")], timeout=30)
                    self.worker("ready", script="updates.py", timeout=60)
                    require(self.protected_local() == self.report["localBefore"], "Protected local gateway changed")
                    require(self.node_services(services=("copilot-api.service",)) == self.report["gatewayBefore"],
                            "Protected node gateway changed before recovery")
                    self.report["worktreeBefore"] = command(["git", "status", "--short"], cwd=self.root)[0]
            else:
                with phase(self.report, "workspace-preflight-and-source", self.record):
                    self.report["localBefore"] = self.protected_local()
                    self.report["nodesBefore"] = self.node_services(nodes=NODES)
                    self.report["gatewayBefore"] = self.node_services(services=("copilot-api.service",))
                    self.report["updaterBefore"] = self.node_services(services=("codey-node-updater.service",))
                    self.report["worktreeBefore"] = command(["git", "status", "--short"], cwd=self.root)[0]
                    self.upload(self.args.builder, [str(file) for file in self.scripts.iterdir()
                                                   if file.suffix in {".py", ".mjs"}], self.remote + "/scripts")
                    self.report["source"] = self.worker("prepare", timeout=110)
                    self.idle(self.nodes)
                    self.report["nativeBefore"] = self.native_idle()
                    self.base["preservedGateway"] = self.preserved_gateway()
                with phase(self.report, "cloudcli-only-build-and-tests", self.record):
                    self.manifest = self.worker("build_workspace", timeout=480)
                    save(self.job / "manifest.json", self.manifest)
                with phase(self.report, "sign-cloudcli-only-release", self.record):
                    self.report["nodeRelease"] = self.worker("publish", script="updates.py", timeout=160)
                    require(self.report["nodeRelease"]["components"] == ["cloudcli"], "Gateway entered the release")
            if self.args.refresh_updater:
                with phase(self.report, "reviewed-independent-updater-repair", self.record):
                    self.worker("ready", script="updates.py", timeout=60)
                    before = self.node_services(nodes=NODES)
                    self.report["updaterRepair"] = self.refresh_reviewed_updater()
                    require(self.node_services(nodes=NODES) == before, "Updater repair restarted an application")
                    self.report.setdefault("updaterOriginalBefore", self.report["updaterBefore"])
                    self.report["updaterBefore"] = self.node_services(services=("codey-node-updater.service",))
            with phase(self.report, "selected-node-owner-confirmed-update", self.record):
                self.idle(self.nodes)
                self.report["nativeAtConfirmation"] = self.native_idle()
                # Existing enrolled updaters only. Do not bootstrap or replace an
                # updater as a side effect of changing the application backend.
                self.report["nodeUpdates"] = self.worker("rollout", script="updates.py", timeout=510)
            if self.args.verify_steering:
                with phase(self.report, "real-same-turn-steering-canary", self.record):
                    self.report["steering"] = self.worker("steering", script="portal.py", timeout=170)
            with phase(self.report, "shared-ui-and-real-steering-acceptance", self.record):
                self.report["ui"] = self.worker("publish_ui", timeout=200)
                self.report["aca"] = self.worker("verify_aca_unchanged", timeout=60)
                self.report["e2e"] = self.worker("verify", script="portal.py", extra={"modelNodes": []}, timeout=100)
                self.report["mcp"] = self.worker("mcp_health", timeout=60)
            with phase(self.report, "protected-services-and-worktree-check", self.record):
                self.report["nodesAfter"] = self.node_services(nodes=NODES)
                self.report["gatewayAfter"] = self.node_services(services=("copilot-api.service",))
                self.report["updaterAfter"] = self.node_services(services=("codey-node-updater.service",))
                self.report["localAfter"] = self.protected_local()
                require(self.report["localAfter"] == self.report["localBefore"], "Protected local gateway changed")
                require(self.report["gatewayAfter"] == self.report["gatewayBefore"], "A protected gateway changed")
                require(self.report["updaterAfter"] == self.report["updaterBefore"], "An updater was replaced")
                require(all(self.report["nodesAfter"][node] == self.report["nodesBefore"][node]
                            for node in NODES if node not in self.nodes), "An excluded node service changed")
                self.report["worktreeAfter"] = command(["git", "status", "--short"], cwd=self.root)[0]
                require(self.report["worktreeAfter"] == self.report["worktreeBefore"], "Development worktree changed")
            self.report["status"] = "complete"
        except Exception as error:
            self.report["status"] = "needs-attention"
            self.report["error"] = str(error)
        finally:
            self.finish()
        return 0 if self.report["status"] == "complete" and self.report["withinTarget"] else 1

    def run_portal(self):
        self.report["scope"] = "portal-only"
        try:
            with phase(self.report, "portal-preflight-and-source-snapshot", self.record):
                self.report["localBefore"] = self.protected_local()
                self.report["nodesBefore"] = self.node_services()
                self.upload(self.args.builder, [str(file) for file in self.scripts.iterdir()
                                               if file.suffix in {".py", ".mjs"}], self.remote + "/scripts")
                if self.args.reviewed_working_tree:
                    self.base["portalSnapshot"] = self.freeze_portal()
                    self.upload(self.args.builder, [str(self.job / "portal-reviewed.tar.gz")], self.remote)
                self.report["source"] = self.worker("prepare", timeout=100)
            with phase(self.report, "portal-checks-and-image-build", self.record):
                self.manifest = self.worker("build_portal", timeout=260)
                save(self.job / "manifest.json", self.manifest)
            with phase(self.report, "portal-aca-revision-rollout", self.record):
                self.report["aca"] = self.worker("activate", timeout=330)
            with phase(self.report, "portal-production-acceptance", self.record):
                mcp = self.pool.submit(self.worker, "mcp_health", timeout=60)
                self.report["e2e"] = self.worker("verify_portal", script="portal.py", timeout=100)
                self.report["mcp"] = mcp.result()
                self.report["nodesAfter"] = self.node_services()
                self.report["localAfter"] = self.protected_local()
                require(self.report["nodesAfter"] == self.report["nodesBefore"], "A remote service changed")
                require(self.report["localAfter"] == self.report["localBefore"], "Protected local gateway changed")
                self.report["remoteServicesUnchanged"] = True
            self.report["status"] = "complete"
        except Exception as error:
            self.report["status"] = "needs-attention"
            self.report["error"] = str(error)
        finally:
            self.finish()
        return 0 if self.report["status"] == "complete" and self.report["withinTarget"] else 1

    def run(self):
        if self.args.scope == "workspace":
            return self.run_workspace()
        if self.args.scope == "portal":
            return self.run_portal()
        if self.args.node_transport == "updater":
            return self.run_updater_fleet()
        try:
            with phase(self.report, "preflight-source-and-node-snapshots", self.record):
                self.report["localBefore"] = self.protected_local()
                self.report["worktreeBefore"] = command(["git", "status", "--short"], cwd=self.root)[0]
                self.upload(self.args.builder, [str(file) for file in self.scripts.iterdir()
                                               if file.suffix in {".py", ".mjs"}], self.remote + "/scripts")
                nodes = {node: self.pool.submit(self.prepare_node, node) for node in self.nodes}
                prepared = self.worker("prepare", timeout=100)
                self.topology = prepared["nodes"]
                self.report["source"] = prepared
                self.report["nodesBefore"] = {node: future.result() for node, future in nodes.items()}
                self.idle(self.nodes)
            with phase(self.report, "build-and-test-once-images-in-parallel", self.record):
                self.manifest = self.worker("build", timeout=300)
                save(self.job / "manifest.json", self.manifest)
            with phase(self.report, "download-and-parallel-stage", self.record):
                command(["scp", "-q", *[f"{self.args.builder}:{self.remote}/{name}" for name in
                                       ("cloudcli.tar.gz", "gateway.tar.gz", "ca.pem")], str(self.job)], timeout=90)
                self.report["staging"] = list(self.pool.map(lambda node: self.node(node, "stage"), self.nodes))
            with phase(self.report, "canary-activate-and-two-real-model-calls", self.record):
                canary = self.nodes[0]
                proofs = self.idle([canary])
                self.report["canary"] = self.node(canary, "activate", {"idle": proofs[canary]})
                cli = self.pool.submit(self.node, canary, "model")
                codey = self.pool.submit(self.worker, "models", script="portal.py",
                                         extra={"nodes": [canary]}, timeout=130)
                self.report["canaryCodex"] = cli.result()
                self.report["canaryCodey"] = codey.result()
            with phase(self.report, "aca-ui-and-remaining-nodes-in-parallel", self.record):
                remaining = self.nodes[1:]
                proofs = self.idle(remaining)
                aca = self.pool.submit(self.worker, "activate", timeout=330)
                ui = self.pool.submit(self.worker, "publish_ui", timeout=200)
                def activate_and_model(node):
                    return {"activation": self.node(node, "activate", {"idle": proofs[node]}),
                            "codex": self.node(node, "model")}
                nodes = {node: self.pool.submit(activate_and_model, node) for node in remaining}
                self.report["nodes"] = {node: future.result() for node, future in nodes.items()}
                self.report["aca"] = aca.result()
                self.report["ui"] = ui.result()
            with phase(self.report, "final-codey-models-and-fleet-acceptance", self.record):
                mcp = self.pool.submit(self.worker, "mcp_health", timeout=60)
                self.report["e2e"] = self.worker("verify", script="portal.py",
                                                 extra={"modelNodes": list(self.nodes[1:])}, timeout=150)
                self.report["mcp"] = mcp.result()
                self.report["localAfter"] = self.protected_local()
                require(self.report["localBefore"] == self.report["localAfter"], "Protected local gateway changed")
                self.report["worktreeAfter"] = command(["git", "status", "--short"], cwd=self.root)[0]
                self.report["realModelCalls"] = {"codey": len(self.nodes), "codex": len(self.nodes), "total": 2 * len(self.nodes)}
            self.report["status"] = "complete"
        except Exception as error:
            self.report["status"] = "needs-attention"
            self.report["error"] = str(error)
        finally:
            self.finish()
        return 0 if self.report["status"] == "complete" and self.report["withinTarget"] else 1

    def install_updater(self, row):
        if row.get("alreadyEnrolled") and not row.get("file"):
            return row
        node = row["node"]
        require(node in NODES, "Unexpected bootstrap node")
        local = self.job / (node + "-updater-private.zip")
        command(["scp", "-q", f"{self.args.builder}:{row['file']}", str(local)], timeout=30)
        # ZIP contains only this node's updater credential. Restrict its Windows ACL.
        sid = command(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
                       "[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value"], timeout=10)[0]
        require(sid.startswith("S-1-") and all(char in "S-0123456789" for char in sid), "Invalid Windows owner SID")
        # PS7 may export an incompatible PSModulePath to Windows PowerShell 5.
        # Use the native ACL utility and .NET readback, not Get-Acl module autoload.
        command(["icacls.exe", str(local), "/inheritance:r", "/grant:r", "*" + sid + ":(F)"], timeout=15)
        check = ("$ErrorActionPreference='Stop';$a=[System.IO.File]::GetAccessControl('" +
                 str(local).replace("'", "''") + "');foreach($r in $a.GetAccessRules($true,$true," +
                 "[System.Security.Principal.SecurityIdentifier])){if($r.AccessControlType -eq 'Allow' -and " +
                 "$r.IdentityReference.Value -ne '" + sid + "'){throw 'Private bootstrap ACL is not owner-only'}}")
        command(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", check], timeout=15)
        require(sha(local) == row["sha256"], "Private bootstrap transfer checksum differs")
        destination = self.node_job + "/updater-bootstrap"
        self.upload(node, [str(local)], destination)
        script = """import sys,os,zipfile,subprocess,json,shutil,hashlib
from pathlib import Path
root=Path(sys.argv[1]); archive=root/sys.argv[2]
existing=sys.argv[3]=='1'; expected_node=sys.argv[4]
def ensure(value,message):
 if not value: raise RuntimeError(message)
with zipfile.ZipFile(archive) as source:
 names=source.namelist()
 wanted=['install.py','updater.py','engine.py','probe.mjs','UPGRADE.md']+([] if existing else ['config.json'])
 ensure(len(names)==len(wanted) and len(set(names))==len(wanted),'Invalid bootstrap entries')
 ensure(set(names)=={'codey-updater/'+name for name in wanted},'Unrecognized bootstrap paths')
 ensure(sum(row.file_size for row in source.infolist())<1024*1024,'Oversized bootstrap')
 source.extractall(root)
config=Path.home()/'.config/codey-updater/config.json' if existing else root/'codey-updater/config.json'
ensure(config.is_file(),'An enrolled node lacks its local credential; explicit re-pairing is required')
ensure(json.loads(config.read_text())['nodeId']==expected_node,'Bootstrap belongs to another node')
config.chmod(0o600)
installed=Path.home()/'.local/share/codey-updater/agent-v1'
def digest(file): return hashlib.sha256(file.read_bytes()).hexdigest()
same=existing and all((installed/name).is_file() and digest(installed/name)==digest(root/'codey-updater'/name) for name in ['updater.py','engine.py','probe.mjs'])
if same:
 print(json.dumps({'node':expected_node,'updaterUnchanged':True,'nodeServicesRestarted':False}));sys.exit(0)
ensure(not (Path.home()/'.config/codey-updater/pending.json').exists(),'Finish the current updater transaction before replacing its implementation')
python=None
for name in [sys.executable,'python3.12','python3.13','/opt/az/bin/python3']:
 candidate=shutil.which(name)
 if not candidate: continue
 try:
  check=subprocess.run([candidate,'-I','-S','-c','import sys,shutil,ssl,sqlite3,tomllib; sys.exit(0 if sys.version_info>=(3,12) else 1)'],capture_output=True,timeout=10)
  if check.returncode==0: python=candidate;break
 except subprocess.TimeoutExpired: pass
ensure(python,'No healthy independent Python 3.12+ interpreter; do not modify global runtimes')
result=subprocess.run([python,'-I','-S',str(root/'codey-updater/install.py'),'--config',str(config),'--apply'],capture_output=True,text=True,timeout=180)
(root/'install.private.log').write_text(result.stdout+result.stderr)
ensure(result.returncode==0,'Updater-only installation failed; inspect the private install log')
print(json.dumps({'node':json.loads(config.read_text())['nodeId'],'updaterInstalled':True,'nodeServicesRestarted':False}))
"""
        output = self.ssh(node, ["python3", "-I", "-S", "-", destination, local.name,
                                "1" if row.get("useExistingConfig") else "0", node], input=script, timeout=200,
                          log=self.job / (node + "-updater-install.log"))
        # Remove only this credential-bearing temporary file, not an artifact directory.
        require(local.resolve().parent == self.job.resolve(), "Unexpected credential temporary path")
        local.unlink()
        return json.loads(output)

    def run_updater_fleet(self):
        self.report["scope"] = "fleet-updater"
        self.report["forceActualRollout"] = False
        try:
            with phase(self.report, "preflight-and-reviewed-source", self.record):
                self.report["localBefore"] = self.protected_local()
                self.report["nodesBefore"] = self.node_services()
                self.upload(self.args.builder, [str(file) for file in self.scripts.iterdir()
                                               if file.suffix in {".py", ".mjs"}], self.remote + "/scripts")
                if self.args.reviewed_working_tree:
                    self.base["portalSnapshot"] = self.freeze_portal()
                    self.upload(self.args.builder, [str(self.job / "portal-reviewed.tar.gz")], self.remote)
                self.report["source"] = self.worker("prepare", timeout=100)
                self.idle(self.nodes)
                self.report["nativeBefore"] = self.native_idle()
            with phase(self.report, "build-and-test-once", self.record):
                self.manifest = self.worker("build", timeout=380)
                save(self.job / "manifest.json", self.manifest)
            with phase(self.report, "sign-and-publish-node-feed", self.record):
                self.report["nodeRelease"] = self.worker("publish", script="updates.py", timeout=160)
            with phase(self.report, "aca-and-shared-ui", self.record):
                aca = self.pool.submit(self.worker, "activate", timeout=330)
                ui = self.pool.submit(self.worker, "publish_ui", timeout=200)
                self.report["aca"] = aca.result()
                self.report["ui"] = ui.result()
            with phase(self.report, "bootstrap-independent-updaters-if-needed", self.record):
                rows = self.worker("bootstrap", script="updates.py", timeout=100)["nodes"]
                self.report["updaterInstallation"] = list(self.pool.map(self.install_updater, rows))
                require(self.node_services() == self.report["nodesBefore"], "Updater bootstrap changed an application service")
            with phase(self.report, "owner-confirmed-canary-and-batch-model-e2e", self.record):
                self.idle(self.nodes)
                self.report["nativeAtConfirmation"] = self.native_idle()
                self.report["nodeUpdates"] = self.worker("rollout", script="updates.py", timeout=510)
            with phase(self.report, "final-aca-fleet-and-local-acceptance", self.record):
                mcp = self.pool.submit(self.worker, "mcp_health", timeout=60)
                self.report["e2e"] = self.worker("verify", script="portal.py", extra={"modelNodes": []}, timeout=100)
                self.report["mcp"] = mcp.result()
                self.report["nodesAfter"] = self.node_services()
                self.report["localAfter"] = self.protected_local()
                require(self.report["localAfter"] == self.report["localBefore"], "Protected local gateway changed")
                nodes = self.report["nodeUpdates"]
                self.report["realModelCalls"] = {"codey": nodes.get("codeyModelCalls", 0),
                                                "codex": nodes.get("codexModelCalls", 0)}
            self.report["status"] = "complete"
        except Exception as error:
            self.report["status"] = "needs-attention"
            self.report["error"] = str(error)
        finally:
            self.finish()
        return 0 if self.report["status"] == "complete" and self.report["withinTarget"] else 1

    def finish(self):
        # Wait for mutation/rollback workers; cleanup time is part of the measurement.
        self.pool.shutdown(wait=True, cancel_futures=True)
        try:
            self.report["releaseLock"] = self.worker("unlock", timeout=30)
        except Exception as error:
            self.report["lockCleanupError"] = str(error)
            self.report["status"] = "needs-attention"
        if read(self.lock)["release"] == self.release:
            self.lock.unlink()
        self.report["finishedAt"] = time.time()
        self.report["totalSeconds"] = round(time.monotonic() - self.started, 3)
        self.report["withinTarget"] = self.report["totalSeconds"] < self.args.target_seconds
        save(self.record, self.report)
        (self.root / "artifacts/codey-deploy-current.txt").write_text(str(self.job) + "\n", encoding="utf-8")
        print(json.dumps({"status": self.report["status"], "totalSeconds": self.report["totalSeconds"],
                          "withinTarget": self.report["withinTarget"], "report": str(self.record),
                          **({"error": self.report["error"]} if "error" in self.report else {})}), flush=True)


def arguments():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", default=r"Q:\codex_manager")
    parser.add_argument("--builder", default="westus2", choices=NODES)
    parser.add_argument("--remote-root", default="/home/zhn/g/codey")
    parser.add_argument("--registry", default="codexshareef492f53f0")
    parser.add_argument("--seed", help="Optional previously validated build cache; not a substitute for this run's tests")
    parser.add_argument("--target-seconds", type=int, default=600)
    parser.add_argument("--scope", choices=("fleet", "portal", "workspace"), default="fleet")
    parser.add_argument("--verify-steering", action="store_true",
                        help="Workspace scope: prove a correction reaches the same native Codex turn")
    parser.add_argument("--expected-cloudcli-commit", help="Fail rather than publishing an unexpected remote CloudCLI tip")
    parser.add_argument("--expected-portal-commit", help="Fail rather than publishing an unexpected remote parent tip")
    parser.add_argument("--resume-release", help="Explicitly resume a failed Workspace release without rebuilding or signing again")
    parser.add_argument("--refresh-updater", action="store_true",
                        help="Workspace recovery only: install reviewed updater source on selected enrolled nodes without restarting apps")
    parser.add_argument("--reconcile-aca", action="store_true",
                        help="Recovery only: accept a completed metadata-only ACA restart; reject image/config/UI drift")
    parser.add_argument("--node-transport", choices=("updater", "ssh"), default="updater",
                        help="Default: signed owner-confirmed pull updates. SSH is legacy-only before updater adoption.")
    parser.add_argument("--nodes", nargs="+", choices=NODES, default=list(NODES),
                        help="Explicit subset, e.g. skip a machine with a long-running user job")
    parser.add_argument("--reviewed-working-tree", action="store_true",
                        help="Deploy explicitly reviewed root-repository changes without committing/pushing")
    parser.add_argument("--apply", action="store_true", help="Authorized real ACA and remote-node deployment")
    return parser.parse_args()


if __name__ == "__main__":
    args = arguments()
    require(args.apply, "Read SKILL.md and obtain release authorization, then pass --apply")
    require(not args.verify_steering or args.scope == "workspace", "Steering acceptance is Workspace-scoped")
    require(args.scope != "workspace" or (args.node_transport == "updater" and not args.reviewed_working_tree),
            "Workspace-only releases require enrolled updaters and committed application source")
    require(not args.resume_release or args.scope == "workspace", "Resume is Workspace-scoped")
    require(not args.refresh_updater or (args.scope == "workspace" and args.resume_release),
            "Updater repair requires explicit recovery of a failed Workspace release")
    require(not args.reconcile_aca or (args.scope == "workspace" and args.resume_release),
            "ACA baseline reconciliation requires explicit Workspace recovery")
    require(not args.reviewed_working_tree or args.scope == "portal" or args.node_transport == "updater",
            "Reviewed source is supported by Portal-only and independent-updater releases, not legacy SSH")
    raise SystemExit(Deploy(args).run())
