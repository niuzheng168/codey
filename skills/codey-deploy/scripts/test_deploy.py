"""Offline regression checks; never connect to Azure, SSH, or a model."""
import io
from contextlib import nullcontext
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace

from common import archive_tree, canonical, read, release_name, require, safe_extract, save, sha
from node import protected_hash


class DeploymentSafety(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)

    def tearDown(self):
        self.temporary.cleanup()

    def archive(self, rows):
        target = self.root / "input.tar.gz"
        with tarfile.open(target, "w:gz") as output:
            for name, kind, value in rows:
                item = tarfile.TarInfo(name)
                item.mode = 0o644
                if kind == "file":
                    item.size = len(value)
                    output.addfile(item, io.BytesIO(value))
                else:
                    item.type = tarfile.SYMTYPE if kind == "link" else tarfile.LNKTYPE
                    item.linkname = value
                    output.addfile(item)
        return target

    def test_safe_package_roundtrip(self):
        source = self.root / "source"
        source.mkdir()
        (source / "entry.js").write_text("export const ok = true;")
        archive_tree(source, self.root / "package.tar.gz")
        safe_extract(self.root / "package.tar.gz", self.root / "destination")
        self.assertEqual(sha(source / "entry.js"), sha(self.root / "destination/entry.js"))

    def test_archive_traversal_denied_before_creating_destination(self):
        target = self.archive([("../escape", "file", b"bad")])
        with self.assertRaises(RuntimeError):
            safe_extract(target, self.root / "destination")
        self.assertFalse((self.root / "destination").exists())
        self.assertFalse((self.root / "escape").exists())

    def test_absolute_archive_denied(self):
        target = self.archive([("/escape", "file", b"bad")])
        with self.assertRaises(RuntimeError):
            safe_extract(target, self.root / "destination")

    def test_package_symlinks_denied(self):
        target = self.archive([("entry", "link", "../escape")])
        with self.assertRaises(RuntimeError):
            safe_extract(target, self.root / "destination")

    def test_hardlinks_denied_even_in_source(self):
        target = self.archive([("entry", "hardlink", "elsewhere")])
        with self.assertRaises(RuntimeError):
            safe_extract(target, self.root / "destination", allow_source_symlinks=True)

    def test_escaping_source_symlink_denied(self):
        target = self.archive([("entry", "link", "../escape")])
        with self.assertRaises(RuntimeError):
            safe_extract(target, self.root / "destination", allow_source_symlinks=True)

    def test_duplicate_archive_path_denied(self):
        target = self.archive([("one", "file", b"a"), ("./one", "file", b"b")])
        with self.assertRaises(RuntimeError):
            safe_extract(target, self.root / "destination")

    def test_existing_destination_never_overwritten(self):
        destination = self.root / "destination"
        destination.mkdir()
        (destination / "user.txt").write_text("keep")
        target = self.archive([("user.txt", "file", b"replace")])
        with self.assertRaises(RuntimeError):
            safe_extract(target, destination)
        self.assertEqual((destination / "user.txt").read_text(), "keep")

    def test_timestamp_add_remove_is_not_config_drift(self):
        file = self.root / ".codex/config.toml"
        file.parent.mkdir()
        file.write_text('model = "gpt-6-astra"\nlast_updated = "2026-09-07T10:00:00Z"\n')
        before = protected_hash(file)
        file.write_text('model = "gpt-6-astra"\n')
        self.assertEqual(before, protected_hash(file))

    def test_actual_model_or_auth_config_change_is_drift(self):
        file = self.root / ".codex/config.toml"
        file.parent.mkdir()
        file.write_text('env_key = "CODEY_MODEL_API_KEY"\n')
        before = protected_hash(file)
        file.write_text('env_key = "UNAUTHORIZED_REPLACEMENT"\n')
        self.assertNotEqual(before, protected_hash(file))

    def test_only_well_formed_release_names(self):
        self.assertEqual(release_name("fast-20260907-120000-abc123"), "fast-20260907-120000-abc123")
        for name in ("../release", "local", "fast-20260907-120000-ABC123", "fast-20260907-120000-abc123/other"):
            with self.assertRaises(RuntimeError):
                release_name(name)

    def test_secret_reference_canonicalization_preserves_other_configuration(self):
        self.assertEqual(canonical({"env": [{"name": "TOKEN", "value": "", "secretRef": "token"}]}),
                         {"env": [{"name": "TOKEN", "secretRef": "token"}]})
        self.assertNotEqual(canonical({"scale": {"minReplicas": 1}}), canonical({"scale": {"minReplicas": 0}}))

    def test_atomic_report_write(self):
        target = self.root / "report.json"
        save(target, {"passed": False})
        save(target, {"passed": True})
        self.assertEqual(read(target), {"passed": True})
        self.assertFalse((self.root / "report.json.next").exists())

    def test_guards_are_not_python_asserts(self):
        with self.assertRaisesRegex(RuntimeError, "guard"):
            require(False, "guard")

    def test_controller_requires_explicit_apply(self):
        from common import command
        import sys
        with self.assertRaises(RuntimeError):
            command([sys.executable, str(Path(__file__).with_name("deploy.py"))], timeout=5)

    def test_explicit_target_subset_is_preserved_and_defaults_to_all_existing_nodes(self):
        import sys
        from deploy import arguments
        with patch.object(sys, "argv", ["deploy.py", "--nodes", "zhn-a100", "jpe3", "westus2"]):
            self.assertEqual(arguments().nodes, ["zhn-a100", "jpe3", "westus2"])
        with patch.object(sys, "argv", ["deploy.py"]):
            self.assertEqual(len(arguments().nodes), 4)

    def test_workspace_scope_keeps_the_explicit_canary_and_commit_pins(self):
        import sys
        from deploy import arguments, Deploy
        with patch.object(sys, "argv", [
            "deploy.py", "--scope", "workspace", "--nodes", "zhn-a100", "--verify-steering",
            "--expected-cloudcli-commit", "a" * 40, "--expected-copilot-api-commit", "c" * 40,
            "--expected-portal-commit", "b" * 40,
        ]):
            args = arguments()
        self.assertEqual(args.nodes, ["zhn-a100"])
        self.assertEqual(args.node_transport, "updater")
        self.assertTrue(args.verify_steering)
        self.assertEqual(args.expected_cloudcli_commit, "a" * 40)
        self.assertEqual(args.expected_copilot_api_commit, "c" * 40)
        worker = object.__new__(Deploy)
        worker.args = args
        with patch.object(worker, "run_workspace", return_value=0) as workspace, \
                patch.object(worker, "run_updater_fleet", side_effect=AssertionError("fleet must not run")), \
                patch.object(worker, "run_portal", side_effect=AssertionError("ACA must not deploy")):
            self.assertEqual(worker.run(), 0)
            workspace.assert_called_once()

    def test_remote_service_baseline_accepts_exactly_one_old_or_new_gateway_unit(self):
        from deploy import Deploy
        worker = object.__new__(Deploy)
        worker.nodes = ("zhn-a100", "jpe2")
        worker.pool = SimpleNamespace(map=lambda function, values: map(function, values))

        def ssh(node, _arguments, **_kwargs):
            active = "codey-copilot-api.service" if node == "zhn-a100" else "copilot-api.service"
            inactive = "copilot-api.service" if node == "zhn-a100" else "codey-copilot-api.service"
            return (
                "Id=codey-cloudcli.service\nActiveState=active\nMainPID=10\n"
                "ExecMainStartTimestampMonotonic=100\n\n"
                f"Id={active}\nActiveState=active\nMainPID=20\nExecMainStartTimestampMonotonic=200\n\n"
                f"Id={inactive}\nActiveState=inactive\nMainPID=0\nExecMainStartTimestampMonotonic=0\n"
            )

        worker.ssh = ssh
        result = worker.node_services()
        self.assertEqual(result["zhn-a100"]["copilot-api.service"]["Id"], "codey-copilot-api.service")
        self.assertEqual(result["jpe2"]["copilot-api.service"]["Id"], "copilot-api.service")

        worker.ssh = lambda *_args, **_kwargs: (
            "Id=codey-cloudcli.service\nActiveState=active\nMainPID=10\n\n"
            "Id=copilot-api.service\nActiveState=active\nMainPID=20\n\n"
            "Id=codey-copilot-api.service\nActiveState=active\nMainPID=30\n"
        )
        with self.assertRaisesRegex(RuntimeError, "duplicated"):
            worker.node_services(nodes=("zhn-a100",))

    def test_portal_verifier_resolves_migrated_machine_ids_and_honors_selected_nodes(self):
        from common import portal_node_ids
        rows = [
            {"id": "local", "name": "windows-devbox"},
            {"id": "n-" + "a" * 24, "name": "ZHN A100 (DevTunnel)"},
            {"id": "n-" + "b" * 24, "name": "zhn-jpe-2"},
            {"id": "jpe3", "name": "Japan East 3"},
            {"id": "westus2", "name": "West US 2"},
        ]
        self.assertEqual(portal_node_ids(rows, ("zhn-a100", "jpe3", "westus2")),
                         ["n-" + "a" * 24, "jpe3", "westus2"])
        self.assertEqual(portal_node_ids(rows, ("jpe2",)), ["n-" + "b" * 24])
        with self.assertRaisesRegex(RuntimeError, "Cannot resolve"):
            portal_node_ids(rows, ("zhn-a100", "jpe2", "jpe3", "westus2", "missing"))

    def test_portal_only_controller_never_reads_node_or_local_service_state(self):
        from deploy import Deploy
        worker = object.__new__(Deploy)
        worker.args = SimpleNamespace(builder="westus2", reviewed_working_tree=False)
        worker.report = {"withinTarget": True}
        worker.job = self.root / "portal-job"
        worker.job.mkdir()
        worker.record = worker.job / "report.json"
        worker.scripts = Path(__file__).parent
        worker.remote = "/isolated/release"
        worker.base = {}
        worker.manifest = None
        worker.pool = SimpleNamespace(
            submit=lambda function, *args, **kwargs:
                SimpleNamespace(result=lambda: function(*args, **kwargs)),
        )
        results = {
            "prepare": {"commits": {}},
            "build_portal": {"scope": "portal"},
            "activate": {"ready": True},
            "verify_portal": {"portalHealth": 200, "nodeChecksPerformed": False},
            "mcp_health": {"health": 200},
        }
        with patch("deploy.phase", side_effect=lambda *_: nullcontext()), \
                patch.object(worker, "upload"), patch.object(worker, "finish"), \
                patch.object(worker, "protected_local", side_effect=AssertionError("local state is out of scope")), \
                patch.object(worker, "node_services", side_effect=AssertionError("node state is out of scope")), \
                patch.object(worker, "worker", side_effect=lambda mode, **_: results[mode]):
            self.assertEqual(worker.run_portal(), 0)
        self.assertEqual(worker.report["status"], "complete")
        self.assertEqual(worker.report["selectedNodes"], [])
        self.assertEqual(worker.report["skippedNodes"], ["zhn-a100", "jpe2", "jpe3", "westus2"])
        self.assertFalse(worker.report["nodeChecksPerformed"])

    def test_portal_only_verifier_never_requests_node_routes(self):
        import hashlib
        import sys
        from types import ModuleType
        storage = ModuleType("azure.storage")
        fileshare = ModuleType("azure.storage.fileshare")
        fileshare.ShareFileClient = object
        with patch.dict(sys.modules, {"azure.storage": storage, "azure.storage.fileshare": fileshare}):
            from portal import Portal
        worker = object.__new__(Portal)
        worker.job = self.root / "portal-verifier"
        worker.job.mkdir()
        public = b"frozen portal settings"
        save(worker.job / "manifest.json", {
            "scope": "portal",
            "publicSha256": {"/settings": hashlib.sha256(public).hexdigest()},
            "features": {"sessionHistory": False},
        })
        save(worker.job / "aca-result.json", {"ready": True})
        paths = []

        def http(path, **_kwargs):
            paths.append(path)
            if path == "/settings":
                return SimpleNamespace(content=public, text=public.decode())
            if path == "/?view=sessions":
                return SimpleNamespace(content=b"", text='<button data-portal-view="sessions" hidden>')
            return SimpleNamespace(content=b"ok", text="ok")

        worker.http = http
        result = worker.verify_portal()
        self.assertEqual(paths, ["/api/health", "/settings", "/?view=sessions"])
        self.assertFalse(result["nodeChecksPerformed"])
        self.assertTrue(result["authenticatedPortalSession"])
        self.assertNotIn("nodes", result)
        self.assertFalse(any(path.startswith("/cloudcli/") or path.startswith("/api/node-data/")
                             for path in paths))

    def test_test_home_and_tmp_stay_outside_source_worktrees_without_credentials(self):
        from builder import Builder
        worker = object.__new__(Builder)
        worker.root = self.root
        worker.job = self.root / "release"
        worker.job.mkdir()
        with patch.dict("os.environ", {"OPENAI_API_KEY": "must-not-inherit", "CODEX_HOME": "real-user-state"}), \
                patch("builder.tempfile.TemporaryDirectory", return_value=nullcontext(str(self.root))) as directory:
            with worker.test_directory("codey-test-") as temporary:
                env = worker.test_environment(temporary)
                self.assertEqual(env["HOME"], temporary)
                self.assertEqual(env["TMPDIR"], temporary)
                self.assertEqual(env["DATABASE_PATH"], ":memory:")
                self.assertNotIn("OPENAI_API_KEY", env)
                self.assertNotIn("CODEX_HOME", env)
        directory.assert_called_once_with(prefix="codey-test-", dir="/var/tmp")
        self.assertTrue(worker.job.is_dir())

    def test_workspace_build_preserves_gateway_metadata_and_never_builds_it(self):
        from builder import Builder
        worker = object.__new__(Builder)
        worker.root = self.root
        worker.job = self.root / "job"
        worker.job.mkdir()
        worker.release = "fast-20260908-120000-abc123"
        worker.report = {"checks": []}
        previous = "fast-20260907-120000-abc123"
        prior = self.root / "artifacts" / previous
        prior.mkdir(parents=True)
        gateway = {"version": "2.5.1", "sourceCommit": "c" * 40, "entrySha256": "d" * 64}
        worker.request = {"components": ["cloudcli"], "preservedGateway": {
            "releaseId": previous, "nodes": {"zhn-a100": {
                "version": gateway["version"], "commit": gateway["sourceCommit"], "entrySha256": gateway["entrySha256"],
            }},
        }}
        save(prior / "validation.json", {"passed": True})
        save(prior / "manifest.json", {"gateway": gateway})
        save(worker.job / "source.json", {"cloudcli": "a" * 40})
        (worker.job / "ui").mkdir()
        save(worker.job / "ui/latest-build.json", {"directory": "/isolated/ui"})
        with patch("builder.tempfile.TemporaryDirectory", return_value=nullcontext(str(self.root))) as temporary, \
                patch.object(worker, "build_cloudcli", return_value={"sourceCommit": "a" * 40}) as build:
            result = worker.build_workspace()
        temporary.assert_called_once_with(prefix="codey-workspace-", dir="/var/tmp")
        build.assert_called_once()
        self.assertEqual(result["components"], ["cloudcli"])
        self.assertEqual(result["gateway"], gateway)
        self.assertEqual(result["images"], {})
        self.assertFalse((worker.job / "gateway.tar.gz").exists())
        self.assertFalse(read(worker.job / "validation.json")["gatewayRebuilt"])
        worker.request["preservedGateway"]["nodes"]["zhn-a100"]["commit"] = "e" * 40
        with patch.object(worker, "build_cloudcli") as build:
            with self.assertRaisesRegex(RuntimeError, "gateway differs"):
                worker.build_workspace()
            build.assert_not_called()
        worker.request["components"].append("copilotApi")
        with self.assertRaisesRegex(RuntimeError, "only publish CloudCLI"):
            worker.build_workspace()

    def test_native_idle_guard_refuses_busy_or_missing_daemons_for_steering(self):
        from deploy import Deploy
        worker = object.__new__(Deploy)
        worker.scripts = Path(__file__).parent
        worker.args = SimpleNamespace(verify_steering=True)
        worker.nodes = ("zhn-a100",)
        worker.pool = SimpleNamespace(map=map)
        with patch.object(worker, "ssh", return_value=json.dumps({"available": True, "loadedCount": 0, "activeCount": 0})) as ssh:
            self.assertEqual(worker.native_idle()["zhn-a100"]["activeCount"], 0)
            self.assertEqual(ssh.call_args.args[0], "zhn-a100")
        with patch.object(worker, "ssh", return_value=json.dumps({"available": True, "loadedCount": 1, "activeCount": 1})):
            with self.assertRaisesRegex(RuntimeError, "still active"):
                worker.native_idle()
        with patch.object(worker, "ssh", return_value=json.dumps({"available": False, "loadedCount": 0, "activeCount": 0})):
            with self.assertRaisesRegex(RuntimeError, "requires the existing"):
                worker.native_idle()

    def test_fleet_checks_native_tasks_before_build_and_again_before_update_confirmation(self):
        from deploy import Deploy
        for busy_at in (0, 1):
            with self.subTest(busy_at=busy_at):
                worker = object.__new__(Deploy)
                worker.args = SimpleNamespace(builder="westus2", reviewed_working_tree=False)
                worker.report = {"withinTarget": True}
                worker.job = self.root
                worker.record = self.root / "report.json"
                worker.scripts = Path(__file__).parent
                worker.remote = "/isolated/release"
                worker.nodes = ("zhn-a100",)
                worker.pool = SimpleNamespace(
                    map=map,
                    submit=lambda fn, *args, **kwargs: SimpleNamespace(result=lambda: fn(*args, **kwargs)),
                )
                states = [{}] * busy_at + [RuntimeError("A native Codex task is still active")]
                with patch("deploy.phase", side_effect=lambda *_: nullcontext()), \
                        patch.object(worker, "protected_local", return_value={}), \
                        patch.object(worker, "node_services", return_value={}), \
                        patch.object(worker, "upload"), patch.object(worker, "idle") as idle, \
                        patch.object(worker, "native_idle", side_effect=states), \
                        patch.object(worker, "finish"), \
                        patch.object(worker, "worker", side_effect=lambda mode, **_: {"nodes": []} if mode == "bootstrap" else {}) as remote:
                    self.assertEqual(worker.run_updater_fleet(), 1)
                modes = [call.args[0] for call in remote.call_args_list]
                self.assertNotIn("rollout", modes)
                self.assertEqual(worker.report["status"], "needs-attention")
                self.assertEqual(idle.call_count, busy_at + 1)
                if busy_at == 0:
                    self.assertNotIn("build", modes)
                else:
                    self.assertIn("bootstrap", modes)

    def test_workspace_acceptance_reads_aca_without_activating_it(self):
        from builder import Builder
        worker = object.__new__(Builder)
        worker.job = self.root
        properties = {"latestRevisionName": "unchanged", "latestReadyRevisionName": "unchanged",
                      "template": {"containers": []}, "configuration": {"activeRevisionsMode": "Single"}}
        save(worker.job / "aca-before.private.json", {"properties": properties})
        with patch.object(worker, "app", return_value={"properties": properties}), \
                patch.object(worker, "activate", side_effect=AssertionError("must not patch ACA")):
            self.assertTrue(worker.verify_aca_unchanged()["unchanged"])
        changed = {**properties, "latestRevisionName": "other-deployment"}
        with patch.object(worker, "app", return_value={"properties": changed}):
            with self.assertRaisesRegex(RuntimeError, "revision changed"):
                worker.verify_aca_unchanged()

    def test_workspace_recovery_reuses_only_the_unchanged_validated_archive(self):
        from builder import Builder
        worker = object.__new__(Builder)
        worker.job = self.root / "job"
        worker.job.mkdir()
        worker.lease = self.root / "lease"
        worker.release = "fast-20260908-120000-abc123"
        worker.request = {"expectedCommits": {"cloudcli": "a" * 40}}
        artifact = worker.job / "cloudcli.tar.gz"
        artifact.write_bytes(b"already-reviewed-artifact")
        manifest = {"scope": "workspace", "components": ["cloudcli"], "commits": {"cloudcli": "a" * 40},
                    "cloudcli": {"archiveSha256": sha(artifact)}}
        save(worker.job / "manifest.json", manifest)
        save(worker.job / "validation.json", {"passed": True})
        with patch.object(worker, "verify_aca_unchanged", return_value={"unchanged": True}), \
                patch.object(worker, "build", side_effect=AssertionError("no rebuilding")), \
                patch.object(worker, "prepare", side_effect=AssertionError("no refetching source")):
            self.assertEqual(worker.resume_workspace(), manifest)
        self.assertEqual(read(worker.lease / "owner.json")["release"], worker.release)
        artifact.write_bytes(b"tampered")
        with self.assertRaisesRegex(RuntimeError, "artifact changed"):
            worker.resume_workspace()

    def test_updater_repair_packages_code_only_and_targets_only_selected_nodes(self):
        from deploy import Deploy
        import zipfile
        worker = object.__new__(Deploy)
        worker.root = self.root
        worker.job = self.root / "job"
        worker.job.mkdir()
        worker.remote = "/isolated/job"
        worker.args = SimpleNamespace(builder="westus2")
        worker.nodes = ("zhn-a100",)
        worker.report = {"previousAttempts": [{}]}
        source = self.root / "node-updater"
        source.mkdir()
        for name in ["updater.py", "engine.py", "probe.mjs", "install.py", "UPGRADE.md"]:
            (source / name).write_text("reviewed code, no credentials")
        with patch.object(worker, "upload"), patch.object(worker, "install_updater", return_value={"node": "zhn-a100"}) as install:
            result = worker.refresh_reviewed_updater()
        self.assertEqual(install.call_count, 1)
        row = install.call_args.args[0]
        self.assertEqual(row["node"], "zhn-a100")
        self.assertTrue(row["useExistingConfig"])
        self.assertFalse(result["applicationServicesRestarted"])
        with zipfile.ZipFile(worker.job / "reviewed-updater-source-1.zip") as archive:
            self.assertEqual(len(archive.namelist()), 5)
            self.assertNotIn("codey-updater/config.json", archive.namelist())

    def test_aca_reconciliation_accepts_only_a_ready_metadata_only_restart(self):
        from builder import Builder
        worker = object.__new__(Builder)
        worker.job = self.root / "job"
        worker.job.mkdir()
        worker.lease = self.root / "lease"
        worker.release = "fast-20260908-120000-abc123"
        worker.config = {}
        worker.request = {"reconcileAca": True}
        artifact = worker.job / "cloudcli.tar.gz"
        artifact.write_bytes(b"reviewed")
        save(worker.job / "manifest.json", {"scope": "workspace", "components": ["cloudcli"],
             "cloudcli": {"archiveSha256": sha(artifact)}, "commits": {}})
        save(worker.job / "validation.json", {"passed": True})
        old = {"provisioningState": "Succeeded", "latestRevisionName": "old", "latestReadyRevisionName": "old",
               "template": {"revisionSuffix": "old", "containers": [{"image": "same-digest"}]},
               "configuration": {"activeRevisionsMode": "Single"}}
        new = {**old, "latestRevisionName": "new", "latestReadyRevisionName": "new",
               "template": {**old["template"], "revisionSuffix": "new"}}
        save(worker.job / "aca-before.private.json", {"properties": old})
        save(worker.job / "ui-before.json", {"release": "unchanged-ui"})
        publisher = SimpleNamespace(AzureStore=lambda _: SimpleNamespace(read=lambda *_: b'{"release":"unchanged-ui"}'))
        with patch.object(worker, "app", return_value={"properties": new}), patch.object(worker, "publisher", return_value=publisher):
            result = worker.resume_workspace()
        self.assertEqual(result["acaReconciliation"]["acceptedRevision"], "new")
        self.assertTrue(list(worker.job.glob("aca-before-reconcile-*.private.json")))
        # Use fresh lease directories to isolate each refusal, without bypassing locking.
        worker.lease = self.root / "changed-lease"
        changed = {**new, "template": {**new["template"], "containers": [{"image": "different-digest"}]}}
        with patch.object(worker, "app", return_value={"properties": changed}):
            with self.assertRaisesRegex(RuntimeError, "not a metadata-only"):
                worker.resume_workspace()
        worker.lease = self.root / "pending-lease"
        with patch.object(worker, "app", return_value={"properties": {**new, "latestRevisionName": "pending"}}):
            with self.assertRaisesRegex(RuntimeError, "other ACA rollout"):
                worker.resume_workspace()

    def test_azure_secret_reads_are_not_logged(self):
        from builder import Builder
        worker = object.__new__(Builder)
        worker.config = {"subscription": "test"}
        worker.job = self.root
        with patch("builder.command", return_value=('{"value":"must-stay-in-memory"}', 0)) as run:
            worker.az(["containerapp", "secret", "list", "--show-values"])
            self.assertIsNone(run.call_args.kwargs["log"])
        with patch("builder.command", return_value=('"must-stay-in-memory"', 0)) as run:
            worker.az(["storage", "account", "keys", "list"])
            self.assertIsNone(run.call_args.kwargs["log"])

    def test_reviewed_snapshot_preserves_real_index_head_and_dirty_files(self):
        from common import command
        from deploy import Deploy
        repository = self.root / "repository"
        repository.mkdir()
        command(["git", "init", "--quiet"], cwd=repository)
        command(["git", "config", "user.name", "Offline release test"], cwd=repository)
        command(["git", "config", "user.email", "release-test@example.invalid"], cwd=repository)
        (repository / "public").mkdir()
        file = repository / "public/app.js"
        file.write_text("before\n")
        command(["git", "add", "public/app.js"], cwd=repository)
        command(["git", "commit", "--quiet", "-m", "Offline test baseline"], cwd=repository)
        head = command(["git", "rev-parse", "HEAD"], cwd=repository)[0]
        index = sha(repository / ".git/index")
        file.write_text("after\n")
        (repository / "public/portal-features.js").write_text("export const enabled = false;\n")
        worker = object.__new__(Deploy)
        worker.root = repository
        worker.job = self.root / "snapshot-job"
        worker.job.mkdir()
        result = worker.freeze_portal()
        self.assertEqual(result["baseCommit"], head)
        self.assertFalse(result["commitCreated"])
        self.assertFalse(result["pushed"])
        self.assertEqual(index, sha(repository / ".git/index"))
        self.assertEqual(head, command(["git", "rev-parse", "HEAD"], cwd=repository)[0])
        self.assertEqual(file.read_text(), "after\n")
        safe_extract(worker.job / "portal-reviewed.tar.gz", self.root / "snapshot")
        self.assertEqual((self.root / "snapshot/public/app.js").read_text(), "after\n")
        self.assertTrue((self.root / "snapshot/public/portal-features.js").is_file())


if __name__ == "__main__":
    unittest.main()
