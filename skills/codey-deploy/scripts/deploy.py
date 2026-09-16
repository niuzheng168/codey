#!/usr/bin/env python3
"""Deploy one committed main release without editing the development worktree."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import datetime
import hashlib
import json
import os
from pathlib import Path
import secrets
import shlex
import shutil
import sys
import time

from common import NODES, command, phase, read, release_name, require, save, sha
from release_source import commits as source_commits, git, select_main, validate_source, verify_tooling


class Deploy:
    def __init__(self, args):
        require(not getattr(args, "reviewed_working_tree", False),
                "Uncommitted production snapshots are disabled; merge changes into main first")
        expected = {name: value for name, value in [
            ("portal", getattr(args, "expected_portal_commit", None)),
            ("cloudcli", getattr(args, "expected_cloudcli_commit", None)),
            ("copilot-api", getattr(args, "expected_copilot_api_commit", None)),
        ] if value}
        require(all(len(value) == 40 and set(value) <= set("0123456789abcdef") for value in expected.values()),
                "Expected source commits must be full lowercase SHA-1 values")
        self.args = args
        self.started = time.monotonic()
        resumed = getattr(args, "resume_release", None)
        self.release = release_name(resumed) if resumed else "fast-" + datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%d-%H%M%S-") + secrets.token_hex(3)
        self.root = Path(args.workspace).resolve()
        if getattr(args, "local_builder", False):
            require(args.scope == "portal" and self.root == Path(args.remote_root).resolve(),
                    "Local builder is Portal-only and requires matching workspace/remote roots")
        require(args.scope != "workspace" and (args.scope == "portal" or getattr(args, "node_transport", None) == "ssh"),
                "Updater-based node deployment has been removed; use Portal-only deployment or explicitly selected legacy SSH")
        self.job = self.root / "artifacts" / self.release
        self.job.mkdir(mode=0o700, parents=True, exist_ok=bool(resumed))
        self.scripts = Path(__file__).resolve().parent
        self.workers_ready = False
        self.nodes = tuple(args.nodes)
        require(self.nodes and len(set(self.nodes)) == len(self.nodes), "Choose distinct target nodes")
        self.remote = args.remote_root + "/artifacts/" + self.release
        self.node_job = "/home/zhn/.local/share/codey-deploy/" + self.release
        self.report = {"release": self.release, "startedAt": time.time(), "targetSeconds": args.target_seconds,
                       "status": "running", "forceActualRollout": True,
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
        if args.seed:
            self.base["seed"] = args.seed
        self.manifest = None
        self.topology = None
        self.pool = ThreadPoolExecutor(max_workers=12)

    def ssh(self, host, args, *, input=None, timeout=180, log=None):
        require(not getattr(self.args, "local_builder", False), "Local Portal releases must not use SSH")
        return command(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", host, shlex.join(args)],
                       input=input, timeout=timeout, log=log)[0]

    def upload(self, host, files, destination):
        if getattr(self.args, "local_builder", False):
            target = Path(destination).resolve()
            require(target.is_relative_to(self.job.resolve()), "Local build files must stay in the release directory")
            target.mkdir(mode=0o700, parents=True, exist_ok=True)
            for file in files:
                source = Path(file).resolve()
                output = target / source.name
                if source != output:
                    shutil.copy2(source, output)
            return
        self.ssh(host, ["mkdir", "-p", destination], timeout=15)
        self.ssh(host, ["chmod", "700", destination], timeout=15)
        command(["scp", "-q", *files, f"{host}:{destination}/"], timeout=90)

    def worker(self, mode, *, script="builder.py", extra=None, timeout=330):
        entry = self.remote + "/scripts/" + script
        bootstrap = "import sys,runpy;sys.path.insert(0," + json.dumps(self.remote + "/scripts") + ");runpy.run_path(" + json.dumps(entry) + ",run_name='__main__')"
        args = ["/opt/az/bin/python3", "-I", "-c", bootstrap]
        options = {"input": json.dumps({**self.base, "mode": mode, **(extra or {})}), "timeout": timeout,
                   "log": self.job / f"{script}-{mode}.log"}
        output = command(args, **options)[0] if getattr(self.args, "local_builder", False) else \
            self.ssh(self.args.builder, args, **options)
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
        raise RuntimeError("Uncommitted production snapshots are disabled; merge changes into main first")

    def pin_source(self):
        resumed = getattr(self.args, "resume_release", None)
        requested = self.base.get("expectedCommits", {})
        current = select_main(self.root, self.release, None if resumed else requested.get("portal"))
        require(self.scripts == self.root / "skills/codey-deploy/scripts",
                "Run the deployer from the selected production checkout, not another worktree")
        verify_tooling(self.root, current)
        self.main_source = current
        source = validate_source(read(self.job / "manifest.json").get("releaseSource")) if resumed else current
        if resumed:
            git(self.root, "merge-base", "--is-ancestor", source["commit"], current["commit"])
        require(all(source_commits(source).get(name) == commit for name, commit in requested.items()),
                "Component overrides cannot differ from main's recorded gitlinks")
        self.base["expectedCommits"] = source_commits(source)
        self.report["releaseSource"] = source
        return source

    def upload_workers(self):
        self.pin_source()
        self.upload(self.args.builder, [str(file) for file in self.scripts.iterdir()
                                       if file.suffix in {".py", ".mjs"}], self.remote + "/scripts")
        self.workers_ready = True

    def node_services(self, nodes=None, services=("codey-cloudcli.service", "copilot-api.service")):
        def inspect(node):
            aliases = {
                "copilot-api.service": ("copilot-api.service", "codey-copilot-api.service"),
            }
            units = tuple(dict.fromkeys(
                candidate for service in services for candidate in aliases.get(service, (service,))
            ))
            output = self.ssh(node, [
                "systemctl", "--user", "show", *units,
                "--property=Id,ActiveState,MainPID,ExecMainStartTimestampMonotonic",
            ], timeout=20)
            records = []
            for block in output.strip().split("\n\n"):
                record = dict(line.split("=", 1) for line in block.splitlines() if "=" in line)
                if record.get("Id"):
                    records.append(record)
            selected = {}
            for service in services:
                candidates = set(aliases.get(service, (service,)))
                active = [record for record in records if record.get("Id") in candidates
                          and record.get("ActiveState") == "active"
                          and record.get("MainPID", "0").isdigit() and int(record["MainPID"]) > 0]
                require(len(active) == 1, "A protected remote service is not active or is duplicated: " + node)
                selected[service] = active[0]
            return node, selected
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




    def run_portal(self):
        self.report["scope"] = "portal-only"
        self.report["selectedNodes"] = []
        self.report["skippedNodes"] = list(NODES)
        self.report["nodeChecksPerformed"] = False
        try:
            with phase(self.report, "portal-preflight-and-source-snapshot", self.record):
                self.upload_workers()
                self.report["source"] = self.worker("prepare", timeout=100)
            with phase(self.report, "portal-checks-and-image-build", self.record):
                self.manifest = self.worker("build_portal", timeout=480)
                save(self.job / "manifest.json", self.manifest)
            with phase(self.report, "portal-aca-revision-rollout", self.record):
                self.report["aca"] = self.worker("activate", timeout=330)
            with phase(self.report, "portal-production-acceptance", self.record):
                self.report["e2e"] = self.worker("verify_portal", script="portal.py", timeout=100)
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
        require(self.args.scope == "fleet" and self.args.node_transport == "ssh",
                "Updater-based node deployment has been removed")
        try:
            with phase(self.report, "preflight-source-and-node-snapshots", self.record):
                self.report["localBefore"] = self.protected_local()
                self.report["worktreeBefore"] = command(["git", "status", "--short"], cwd=self.root)[0]
                self.upload_workers()
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
                self.report["e2e"] = self.worker("verify", script="portal.py",
                                                 extra={"modelNodes": list(self.nodes[1:])}, timeout=150)
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



    def finish(self):
        # Wait for mutation/rollback workers; cleanup time is part of the measurement.
        self.pool.shutdown(wait=True, cancel_futures=True)
        if self.workers_ready:
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
    parser.add_argument("--local-builder", action="store_true",
                        help="Portal-only: execute the existing workers on this build machine, without SSH/SCP")
    parser.add_argument("--remote-root", default="/home/zhn/g/codey")
    parser.add_argument("--registry", default="codexshareef492f53f0")
    parser.add_argument("--seed", help="Optional previously validated build cache; not a substitute for this run's tests")
    parser.add_argument("--target-seconds", type=int, default=600)
    parser.add_argument("--scope", choices=("fleet", "portal", "workspace"), default="fleet")
    parser.add_argument("--verify-steering", action="store_true",
                        help="Workspace scope: prove a correction reaches the same native Codex turn")
    parser.add_argument("--expected-cloudcli-commit", help="Assert main's recorded CloudCLI gitlink (not an override)")
    parser.add_argument("--expected-copilot-api-commit", help="Assert main's recorded gateway gitlink (not an override)")
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
    parser.add_argument("--reviewed-working-tree", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--apply", action="store_true", help="Authorized real ACA and remote-node deployment")
    args = parser.parse_args()
    if args.reviewed_working_tree:
        parser.error("Uncommitted production snapshots are disabled; merge changes into main first")
    return args


if __name__ == "__main__":
    args = arguments()
    require(args.apply, "Read SKILL.md and obtain release authorization, then pass --apply")
    require(not args.verify_steering or args.scope == "workspace", "Steering acceptance is Workspace-scoped")
    require(args.scope != "workspace" or args.node_transport == "updater",
            "Workspace-only releases require enrolled updaters and committed application source")
    require(not args.resume_release or args.scope == "workspace", "Resume is Workspace-scoped")
    require(not args.refresh_updater or (args.scope == "workspace" and args.resume_release),
            "Updater repair requires explicit recovery of a failed Workspace release")
    require(not args.reconcile_aca or (args.scope == "workspace" and args.resume_release),
            "ACA baseline reconciliation requires explicit Workspace recovery")
    raise SystemExit(Deploy(args).run())
