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

from common import NODES, command, phase, read, require, save, sha


class Deploy:
    def __init__(self, args):
        self.args = args
        self.started = time.monotonic()
        self.release = "fast-" + datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%d-%H%M%S-") + secrets.token_hex(3)
        self.root = Path(args.workspace).resolve()
        self.job = self.root / "artifacts" / self.release
        self.job.mkdir(mode=0o700, parents=True)
        self.scripts = Path(__file__).resolve().parent
        self.remote = args.remote_root + "/artifacts/" + self.release
        self.node_job = "/home/zhn/.local/share/codey-deploy/" + self.release
        self.report = {"release": self.release, "startedAt": time.time(), "targetSeconds": args.target_seconds,
                       "status": "running", "forceActualRollout": True, "mcpTests": "skipped-by-user",
                       "protectedLocalCopilot": True, "phases": []}
        self.record = self.job / "report.json"
        self.lock = self.root / "artifacts/.codey-deploy-controller.lock"
        with self.lock.open("x", encoding="utf-8") as output:
            json.dump({"release": self.release, "pid": os.getpid()}, output)
        self.base = {"root": args.remote_root, "registry": args.registry}
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
        output = self.ssh(self.args.builder, ["/opt/az/bin/python3", self.remote + "/scripts/" + script],
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
        allowed = ("public/", "src/", "test/", "docs/", "skills/", "scripts/")
        require(files and all(name.startswith(allowed) or name in {"Dockerfile", "package.json", "package-lock.json"}
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

    def node_services(self):
        def inspect(node):
            output = self.ssh(node, [
                "systemctl", "--user", "show", "codey-cloudcli.service", "copilot-api.service",
                "--property=Id,ActiveState,MainPID,ExecMainStartTimestampMonotonic",
            ], timeout=20)
            require(output.count("ActiveState=active") == 2 and "\nMainPID=0" not in output,
                    "A protected remote service is not active: " + node)
            return node, output
        return dict(self.pool.map(inspect, NODES))

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
        if self.args.scope == "portal":
            return self.run_portal()
        try:
            with phase(self.report, "preflight-source-and-node-snapshots", self.record):
                self.report["localBefore"] = self.protected_local()
                self.report["worktreeBefore"] = command(["git", "status", "--short"], cwd=self.root)[0]
                self.upload(self.args.builder, [str(file) for file in self.scripts.iterdir()
                                               if file.suffix in {".py", ".mjs"}], self.remote + "/scripts")
                nodes = {node: self.pool.submit(self.prepare_node, node) for node in NODES}
                prepared = self.worker("prepare", timeout=100)
                self.topology = prepared["nodes"]
                self.report["source"] = prepared
                self.report["nodesBefore"] = {node: future.result() for node, future in nodes.items()}
                self.idle(NODES)
            with phase(self.report, "build-and-test-once-images-in-parallel", self.record):
                self.manifest = self.worker("build", timeout=300)
                save(self.job / "manifest.json", self.manifest)
            with phase(self.report, "download-and-parallel-stage", self.record):
                command(["scp", "-q", *[f"{self.args.builder}:{self.remote}/{name}" for name in
                                       ("cloudcli.tar.gz", "gateway.tar.gz", "ca.pem")], str(self.job)], timeout=90)
                self.report["staging"] = list(self.pool.map(lambda node: self.node(node, "stage"), NODES))
            with phase(self.report, "canary-activate-and-two-real-model-calls", self.record):
                canary = NODES[0]
                proofs = self.idle([canary])
                self.report["canary"] = self.node(canary, "activate", {"idle": proofs[canary]})
                cli = self.pool.submit(self.node, canary, "model")
                codey = self.pool.submit(self.worker, "models", script="portal.py",
                                         extra={"nodes": [canary]}, timeout=130)
                self.report["canaryCodex"] = cli.result()
                self.report["canaryCodey"] = codey.result()
            with phase(self.report, "aca-ui-and-remaining-nodes-in-parallel", self.record):
                remaining = NODES[1:]
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
                                                 extra={"modelNodes": list(NODES[1:])}, timeout=150)
                self.report["mcp"] = mcp.result()
                self.report["localAfter"] = self.protected_local()
                require(self.report["localBefore"] == self.report["localAfter"], "Protected local gateway changed")
                self.report["worktreeAfter"] = command(["git", "status", "--short"], cwd=self.root)[0]
                self.report["realModelCalls"] = {"codey": 4, "codex": 4, "total": 8}
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
    parser.add_argument("--scope", choices=("fleet", "portal"), default="fleet")
    parser.add_argument("--reviewed-working-tree", action="store_true",
                        help="Portal only: deploy explicitly reviewed local changes without committing/pushing")
    parser.add_argument("--apply", action="store_true", help="Authorized real ACA and remote-node deployment")
    return parser.parse_args()


if __name__ == "__main__":
    args = arguments()
    require(args.apply, "Read SKILL.md and obtain release authorization, then pass --apply")
    require(not args.reviewed_working_tree or args.scope == "portal",
            "Reviewed working-tree snapshots are limited to Portal-only releases")
    raise SystemExit(Deploy(args).run())
