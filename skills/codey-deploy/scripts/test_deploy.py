"""Offline regression checks; never connect to Azure, SSH, or a model."""
import io
import copy
from contextlib import nullcontext
import json
import os
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace

from common import archive_tree, canonical, read, release_name, require, safe_extract, save, sha
from node import protected_hash
from release_source import SOURCE_FILE, commits as source_commits

MAIN_SOURCE = {
    "schema": 1, "kind": "codey-main-source", "ref": "refs/heads/main",
    "commit": "b" * 40, "tree": "d" * 40, "sourceDirty": False, "codeyVersion": "0.1.0",
    "submodules": {"cloudcli": "a" * 40, "copilot-api": "c" * 40},
}


def committed_fixture(worker):
    worker.source = worker.job / "source"
    (worker.source / "portal").mkdir(parents=True, exist_ok=True)
    save(worker.source / "portal" / SOURCE_FILE, MAIN_SOURCE)
    save(worker.job / "release-source.json", MAIN_SOURCE)
    save(worker.job / "source.json", source_commits(MAIN_SOURCE))


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

    def test_removed_updater_transport_fails_before_any_local_or_remote_mutation(self):
        import sys
        from deploy import arguments, Deploy
        for scope in ("fleet", "workspace"):
            with patch.object(sys, "argv", ["deploy.py", "--scope", scope, "--node-transport", "updater",
                                           "--workspace", str(self.root)]):
                args = arguments()
            before = list(self.root.rglob("*"))
            with patch("deploy.command", side_effect=AssertionError("No command may run")):
                with self.assertRaisesRegex(RuntimeError, "removed"):
                    Deploy(args)
            self.assertEqual(list(self.root.rglob("*")), before)

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
        }
        with patch("deploy.phase", side_effect=lambda *_: nullcontext()), \
                patch.object(worker, "pin_source", return_value=MAIN_SOURCE), \
                patch.object(worker, "upload"), patch.object(worker, "finish"), \
                patch.object(worker, "protected_local", side_effect=AssertionError("local state is out of scope")), \
                patch.object(worker, "node_services", side_effect=AssertionError("node state is out of scope")), \
                patch.object(worker, "worker", side_effect=lambda mode, **_: results[mode]):
            self.assertEqual(worker.run_portal(), 0)
        self.assertEqual(worker.report["status"], "complete")
        self.assertEqual(worker.report["selectedNodes"], [])
        self.assertEqual(worker.report["skippedNodes"], ["zhn-a100", "jpe2", "jpe3", "westus2"])
        self.assertFalse(worker.report["nodeChecksPerformed"])
        self.assertNotIn("mcp", worker.report)

    def test_local_builder_is_restricted_to_portal_and_the_current_build_root(self):
        from deploy import Deploy
        for scope, remote in [("fleet", str(self.root)), ("workspace", str(self.root)),
                              ("portal", str(self.root / "other"))]:
            args = SimpleNamespace(local_builder=True, scope=scope,
                                   workspace=str(self.root), remote_root=remote)
            with self.assertRaisesRegex(RuntimeError, "Local builder is Portal-only"):
                Deploy(args)
        self.assertFalse((self.root / "artifacts").exists())

    def test_local_portal_files_and_workers_never_use_ssh_or_scp(self):
        from deploy import Deploy
        worker = object.__new__(Deploy)
        worker.args = SimpleNamespace(local_builder=True, builder="westus2")
        worker.job = self.root / "release"
        worker.job.mkdir()
        worker.remote = str(worker.job)
        worker.base = {"root": str(self.root)}
        source = self.root / "builder.py"
        source.write_text("# synthetic worker\n")
        with patch.object(worker, "ssh", side_effect=AssertionError("No node connections")):
            worker.upload("westus2", [source], str(worker.job / "scripts"))
            self.assertEqual((worker.job / "scripts/builder.py").read_text(), source.read_text())
            archive = worker.job / "portal-reviewed.tar.gz"
            archive.write_bytes(b"keep the already-local archive")
            worker.upload("westus2", [archive], str(worker.job))
            self.assertEqual(archive.read_bytes(), b"keep the already-local archive")
            with self.assertRaisesRegex(RuntimeError, "release directory"):
                worker.upload("westus2", [source], str(self.root / "outside"))
            with patch("deploy.command", return_value=('{"ok":true,"result":{"ready":true}}', 0)) as run:
                self.assertEqual(worker.worker("build_portal"), {"ready": True})
                self.assertEqual(run.call_args.args[0][:3], ["/opt/az/bin/python3", "-I", "-c"])
                self.assertEqual(json.loads(run.call_args.kwargs["input"])["mode"], "build_portal")
        with self.assertRaisesRegex(RuntimeError, "must not use SSH"):
            worker.ssh("any-node", ["true"])

    def test_portal_deployment_removes_the_legacy_mcp_sidecar_and_proxy_configuration(self):
        from builder import portal_deployment_template
        original = {
            "revisionSuffix": "before",
            "containers": [
                {"name": "portal", "image": "portal@sha256:old", "env": [
                    {"name": "PORTAL_MCP_PROXY_URL", "value": "http://127.0.0.1:8000"},
                    {"name": "SESSION_SHARE_PORTAL_CONFIG", "value": "/app/config/session-share.aca.json"},
                    {"name": "KEEP", "secretRef": "keep-this"},
                ]},
                {"name": "mcp", "image": "mcp@sha256:old"},
            ],
            "scale": {"minReplicas": 1, "maxReplicas": 1},
        }
        template, removed = portal_deployment_template(
            original, "registry.example/codey@sha256:" + "a" * 64,
        )
        self.assertTrue(removed)
        self.assertEqual([row["name"] for row in template["containers"]], ["portal"])
        portal = template["containers"][0]
        self.assertEqual([row["name"] for row in portal["env"]], ["KEEP"])
        self.assertEqual(original["containers"][0]["image"], "portal@sha256:old")
        self.assertEqual(original["containers"][1]["name"], "mcp")

    def test_portal_deployment_rejects_any_new_sidecar(self):
        from builder import portal_deployment_template
        with self.assertRaisesRegex(RuntimeError, "at most the removable legacy MCP"):
            portal_deployment_template({
                "containers": [
                    {"name": "portal", "image": "portal@sha256:old"},
                    {"name": "new-sidecar", "image": "other@sha256:old"},
                ],
            }, "registry.example/codey@sha256:" + "a" * 64)

    def test_aca_reads_pin_the_write_api_instead_of_inheriting_cli_response_fields(self):
        from builder import Builder, CONTAINER_APP_API_VERSION
        worker = object.__new__(Builder)
        worker.config = {"resourceGroup": "existing-resource-group"}
        response = {"id": "existing-app", "properties": {"template": {"containers": [
            {"name": "portal", "image": "old-image", "probes": [], "resources": {"cpu": 1}},
        ]}}}
        with patch.object(worker, "az", return_value=response) as az:
            self.assertIs(worker.app(), response)
        self.assertEqual(az.call_args.args[0], [
            "resource", "show", "-g", "existing-resource-group", "-n", "codey",
            "--resource-type", "Microsoft.App/containerApps",
            "--api-version", CONTAINER_APP_API_VERSION,
        ])

    def test_aca_activation_uses_one_pinned_contract_and_preserves_full_drift_checks(self):
        from builder import Builder, CONTAINER_APP_API_VERSION
        for introduce_drift in (False, True):
            with self.subTest(introduce_drift=introduce_drift):
                worker = object.__new__(Builder)
                worker.root = self.root
                worker.job = self.root / ("drift" if introduce_drift else "success")
                worker.job.mkdir()
                worker.request = {}
                worker.config = {"resourceGroup": "existing-resource-group"}
                worker.release = "fast-20260921-080000-abcdef"
                committed_fixture(worker)
                before = {
                    "id": "/subscriptions/fixture/resourceGroups/existing-resource-group/providers/Microsoft.App/containerApps/codey",
                    "identity": {"type": "SystemAssigned", "principalId": "unchanged"},
                    "properties": {
                        "configuration": {"activeRevisionsMode": "Single", "ingress": {"external": True}},
                        "template": {
                            "revisionSuffix": "previous",
                            "containers": [{
                                "name": "portal", "image": "registry.example/codey@sha256:" + "a" * 64,
                                "env": [{"name": "KEEP", "secretRef": "unchanged-secret"}],
                                "resources": {"cpu": 1, "memory": "2Gi"},
                                "probes": [{"type": "Readiness", "httpGet": {"path": "/api/health", "port": 3000}}],
                            }],
                            "scale": {"minReplicas": 1, "maxReplicas": 1},
                        },
                        "latestRevisionName": "codey--previous",
                        "latestReadyRevisionName": "codey--previous",
                        "provisioningState": "Succeeded",
                    },
                }
                save(worker.job / "aca-before.private.json", before)
                save(worker.job / "manifest.json", {
                    "releaseSource": MAIN_SOURCE,
                    "images": {"portal": {"image": "registry.example/codey@sha256:" + "b" * 64}},
                })
                save(worker.job / "validation.json", {"passed": True})
                observed = copy.deepcopy(before)
                patches = []
                read_calls = []

                def azure(arguments, **_kwargs):
                    if arguments[:2] == ["resource", "show"]:
                        read_calls.append(arguments)
                        self.assertEqual(arguments[-2:], ["--api-version", CONTAINER_APP_API_VERSION])
                        return copy.deepcopy(observed)
                    if arguments[:2] == ["rest", "--method"]:
                        self.assertEqual(arguments[2], "patch")
                        self.assertEqual(arguments[4], before["id"] + "?api-version=" + CONTAINER_APP_API_VERSION)
                        body = read(arguments[6].removeprefix("@"))
                        patches.append(body)
                        template = body["properties"]["template"]
                        self.assertNotIn("imageType", template["containers"][0])
                        self.assertEqual(template["scale"], before["properties"]["template"]["scale"])
                        self.assertEqual(template["containers"][0]["env"], before["properties"]["template"]["containers"][0]["env"])
                        self.assertEqual(template["containers"][0]["probes"], before["properties"]["template"]["containers"][0]["probes"])
                        observed["properties"].update({
                            "template": copy.deepcopy(template),
                            "latestRevisionName": "codey--" + template["revisionSuffix"],
                            "latestReadyRevisionName": "codey--" + template["revisionSuffix"],
                        })
                        if introduce_drift:
                            observed["properties"]["template"]["containers"][0]["resources"]["cpu"] = 2
                        return {}
                    if arguments[:3] == ["containerapp", "replica", "list"]:
                        return [{"properties": {"containers": [{"name": "portal", "ready": True, "restartCount": 0}]}}]
                    raise AssertionError("Unexpected Azure command: " + repr(arguments))

                with patch.object(worker, "az", side_effect=azure), \
                        patch("builder.verify_source_files"), patch("builder.verify_gateway_routes"):
                    if introduce_drift:
                        with self.assertRaisesRegex(RuntimeError, "Unexpected ACA template change"):
                            worker.activate()
                    else:
                        result = worker.activate()
                        self.assertTrue(result["ready"])
                        self.assertTrue(result["configurationPreserved"])
                self.assertEqual(len(patches), 1)
                self.assertEqual(len(read_calls), 2)
                self.assertNotIn("imageType", before["properties"]["template"]["containers"][0])

    def test_portal_only_verifier_never_requests_node_routes(self):
        import hashlib
        import sys
        from types import ModuleType
        storage = ModuleType("azure.storage")
        fileshare = ModuleType("azure.storage.fileshare")
        fileshare.ShareFileClient = object
        exceptions = ModuleType("azure.core.exceptions")
        exceptions.ResourceNotFoundError = type("ResourceNotFoundError", (Exception,), {})
        with patch.dict(sys.modules, {"azure.storage": storage, "azure.storage.fileshare": fileshare,
                                      "azure.core.exceptions": exceptions}):
            from portal import Portal
        worker = object.__new__(Portal)
        worker.job = self.root / "portal-verifier"
        worker.job.mkdir()
        public = b"frozen portal settings"
        save(worker.job / "manifest.json", {
            "scope": "portal",
            "releaseSource": MAIN_SOURCE,
            "publicSha256": {"/settings": hashlib.sha256(public).hexdigest()},
            "features": {"sessionHistory": False},
        })
        save(worker.job / "aca-result.json", {
            "ready": True,
            "containers": [{"name": "portal", "ready": True, "restartCount": 0}],
        })
        paths = []

        def http(path, **_kwargs):
            paths.append(path)
            if path == "/settings":
                return SimpleNamespace(content=public, text=public.decode())
            if path == "/?view=sessions":
                return SimpleNamespace(content=b"", text='<button data-portal-view="sessions" hidden>')
            if path == "/api/version":
                return SimpleNamespace(json=lambda: {
                    "sourceCommit": MAIN_SOURCE["commit"], "sourceTree": MAIN_SOURCE["tree"],
                    "sourceRef": MAIN_SOURCE["ref"], "sourceDirty": False,
                    "componentCommits": MAIN_SOURCE["submodules"],
                })
            return SimpleNamespace(content=b"ok", text="ok")

        worker.http = http
        result = worker.verify_portal()
        self.assertEqual(paths, ["/api/health", "/settings", "/?view=sessions", "/api/version"])
        self.assertTrue(result["sourceCommitVerified"])
        self.assertFalse(result["nodeChecksPerformed"])
        self.assertTrue(result["authenticatedPortalSession"])
        self.assertEqual(result["deploymentContainers"], ["portal"])
        self.assertFalse(result["mcpDeployed"])
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

    def test_portal_test_storage_honors_tmpdir_with_a_new_private_directory(self):
        from builder import Builder
        worker = object.__new__(Builder)
        worker.root = self.root / "checkout"
        worker.job = worker.root / "artifacts/release"
        storage = self.root / "temporary-storage"
        storage.mkdir(mode=0o700)
        with patch.dict("os.environ", {"TMPDIR": str(storage)}), patch("tempfile.tempdir", None):
            with worker.test_directory("codey-portal-", use_system_temp=True) as temporary:
                directory = Path(temporary)
                self.assertEqual(directory.parent, storage.resolve())
                self.assertTrue(directory.name.startswith("codey-portal-"))
                if os.name == "posix":
                    self.assertEqual(directory.stat().st_mode & 0o777, 0o700)
                    self.assertEqual(directory.stat().st_uid, os.getuid())
                self.assertFalse(directory.is_relative_to(worker.root))
            self.assertFalse(directory.exists())

    def test_portal_test_storage_rejects_checkout_and_frozen_source_roots(self):
        from builder import Builder
        worker = object.__new__(Builder)
        worker.root = self.root / "checkout"
        worker.job = self.root / "release"
        for root in (worker.root, worker.root / "temporary", worker.job, worker.job / "source/portal/tmp"):
            with self.subTest(root=root), \
                    patch("builder.tempfile.gettempdir", return_value=str(root)), \
                    patch("builder.tempfile.TemporaryDirectory") as directory:
                with self.assertRaisesRegex(RuntimeError, "outside source worktrees"):
                    worker.test_directory("codey-portal-", use_system_temp=True)
                directory.assert_not_called()

    def test_portal_full_suite_has_a_bounded_disk_io_budget_without_changing_other_checks(self):
        from builder import Builder
        worker = object.__new__(Builder)
        worker.source, worker.job, worker.report = self.root, self.root, {"checks": []}
        with patch("builder.command", return_value=("", 1)) as run:
            worker.check("portal", "tests", ["npm", "test"], {"HOME": "/isolated"})
            self.assertEqual(run.call_args.kwargs["timeout"], 180)
            self.assertEqual(run.call_args.args[0], ["npm", "test"])
            worker.check("portal", "check", ["npm", "run", "check"], {})
            self.assertEqual(run.call_args.kwargs["timeout"], 100)
            worker.check("cloudcli", "backend-tests", ["npm", "test"], {})
            self.assertEqual(run.call_args.kwargs["timeout"], 100)
            worker.check("portal", "tests", ["npm", "test"], {}, timeout=75)
            self.assertEqual(run.call_args.kwargs["timeout"], 75)
        self.assertEqual(len(worker.report["checks"]), 4)

    def test_workspace_build_preserves_gateway_metadata_and_never_builds_it(self):
        from builder import Builder
        # This test isolates component selection; real Git byte verification is
        # exercised by test_release_source.py and the isolated build fixture.
        source_check = patch("builder.verify_source_files")
        source_check.start()
        self.addCleanup(source_check.stop)
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
        committed_fixture(worker)
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
                    "releaseSource": MAIN_SOURCE, "cloudcli": {"archiveSha256": sha(artifact)}}
        committed_fixture(worker)
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
             "cloudcli": {"archiveSha256": sha(artifact)}, "commits": {}, "releaseSource": MAIN_SOURCE})
        committed_fixture(worker)
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

    def test_disabled_snapshot_does_not_touch_real_index_head_or_dirty_files(self):
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
        (repository / "README.md").write_text("Reviewed Portal documentation.\n")
        (repository / "packages/codey/lib").mkdir(parents=True)
        (repository / "packages/codey/lib/setup.mjs").write_text("Reviewed onboarding code.\n")
        worker = object.__new__(Deploy)
        worker.root = repository
        worker.job = self.root / "snapshot-job"
        worker.job.mkdir()
        with self.assertRaisesRegex(RuntimeError, "disabled"):
            worker.freeze_portal()
        self.assertEqual(index, sha(repository / ".git/index"))
        self.assertEqual(head, command(["git", "rev-parse", "HEAD"], cwd=repository)[0])
        self.assertEqual(file.read_text(), "after\n")
        self.assertEqual(list(worker.job.iterdir()), [])

    def test_both_controller_and_worker_refuse_the_old_uncommitted_snapshot_escape_hatch(self):
        import sys
        from builder import Builder
        from deploy import Deploy, arguments
        with patch.object(sys, "argv", ["deploy.py", "--reviewed-working-tree"]), \
                self.assertRaises(SystemExit):
            arguments()
        with self.assertRaisesRegex(RuntimeError, "disabled"):
            Deploy(SimpleNamespace(reviewed_working_tree=True))
        with self.assertRaisesRegex(RuntimeError, "forbidden"):
            Builder({"portalSnapshot": {"kind": "reviewed-working-tree"}})

    def test_activation_rejects_unproven_or_mutated_source_before_contacting_azure(self):
        from builder import Builder
        worker = object.__new__(Builder)
        worker.job = self.root / "job"
        worker.job.mkdir()
        worker.request = {}
        committed_fixture(worker)
        save(worker.source / "portal" / SOURCE_FILE, {**MAIN_SOURCE, "commit": "e" * 40})
        with patch.object(worker, "app", side_effect=AssertionError("No Azure side effects")):
            with self.assertRaisesRegex(RuntimeError, "provenance changed"):
                worker.activate()


if __name__ == "__main__":
    unittest.main()
