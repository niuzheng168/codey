"""Isolated updater transactions; never runs systemctl or touches real node data."""
import base64
import copy
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "node-updater"))
import engine
from updater import Agent, Client, NoRedirect, load_config


class FakeRuntime(engine.Runtime):
    def __init__(self, home, *, directory_anchor=False, model_failure=False):
        self.config = {"nodeId": "alpha", "ownerId": "owner-a"}
        self.home = Path(home).resolve()
        self.root = self.home / ".local/share/codey-updater"
        self.private = self.home / ".config/codey-updater"
        self.root.mkdir(parents=True)
        self.private.mkdir(parents=True)
        self.model_failure = model_failure
        self.actions = []
        self.model_calls = 0
        self.profile = {"layout": "legacy"}
        self.anchors = {}
        self.data = self.home / "persistent"
        self.data.mkdir()
        (self.data / "user-data.txt").write_text("must survive rollback")
        (self.data / "config.json").write_text('{"auth":{"apiKeys":["' + "x" * 64 + '"]}}\n')
        (self.data / "portal-build.json").write_text('{"artifactId":"old","version":"1.0.0"}\n')
        for name in engine.COMPONENTS:
            directory = self.home / "old" / name
            self.package(directory, name, "1.0.0", "old entry", "a" * 40)
            anchor = self.home / "anchors" / name
            anchor.parent.mkdir(exist_ok=True)
            if directory_anchor:
                os.rename(directory, anchor)
            else:
                anchor.symlink_to(directory, target_is_directory=True)
            self.anchors[name] = anchor
        self.before_data = (self.data / "config.json").read_bytes()
        self.before_pin = (self.data / "portal-build.json").read_bytes()

    @staticmethod
    def package(directory, name, version, entry_text, commit):
        directory.mkdir(parents=True)
        entry = directory / ("dist-server/server/index.js" if name == "cloudcli" else "dist/main.js")
        entry.parent.mkdir(parents=True)
        entry.write_text(entry_text)
        engine.save(directory / "package.json", {"name": name, "version": version, "scripts": {}})
        engine.save(directory / "codey-release.json", {"sourceCommit": commit})
        if name == "cloudcli":
            (directory / "package-lock.json").write_text('{"lockfileVersion":3}\n')

    def snapshot(self):
        values = {}
        for name, anchor in self.anchors.items():
            directory = anchor.resolve()
            entry = directory / ("dist-server/server/index.js" if name == "cloudcli" else "dist/main.js")
            values[name] = {"version": engine.read(directory / "package.json")["version"],
                            "commit": engine.read(directory / "codey-release.json")["sourceCommit"],
                            "entrySha256": engine.sha(entry), "nodeMajor": 24}
        installed_file = self.private / "installed.json"
        installed = engine.read(installed_file) if installed_file.exists() else {}
        return {"nodeId": self.config["nodeId"], "ownerId": self.config["ownerId"],
                "layout": self.profile["layout"], "platform": "linux-x64",
                "cloudcliPid": 10, "copilotPid": 11, "cloudcliNode": "/fixture/node", "copilotNode": "/fixture/node",
                "cloudcliPath": str(self.anchors["cloudcli"].resolve()), "copilotPath": str(self.anchors["copilotApi"].resolve()),
                "cloudcliAnchor": str(self.anchors["cloudcli"]), "copilotAnchor": str(self.anchors["copilotApi"]),
                "copilotService": self.profile.get("copilotService", "copilot-api.service"),
                "copilotHome": str(self.data), "database": str(self.data / "absent.sqlite"),
                "components": values, "highestSequence": installed.get("sequence", 0), "installedDigest": installed.get("digest"),
                "currentRelease": installed.get("releaseId"), "readyMigrations": ["gateway-api-key-v1"],
                "protected": {str(self.data / "config.json"): engine.gateway_config_hash(self.data / "config.json"),
                              **{str(file): engine.config_hash(file, self.root / "probe")
                                 for file in self.model_config_paths(getattr(self, "cloudcli_env", {})) if file.is_file()}},
                "pinHash": engine.sha(self.data / "portal-build.json")}

    def prepare_dependencies(self, before, candidate, job):
        pass

    def candidate(self, name, release_id, attempt):
        return self.root / "releases" / (release_id + "-" + attempt[:8]) / name

    def idle(self, before, job):
        self.assert_unchanged(before)
        return True

    def health(self, snapshot):
        return True

    def model(self, snapshot, job):
        self.model_calls += 1
        if self.model_failure:
            (self.data / "user-data.txt").write_text("new user data written during verification")
            raise engine.UpdateError("model_failed")

    def runner(self, arguments, **_):
        if arguments[:3] not in (["systemctl", "--user", "stop"], ["systemctl", "--user", "start"]):
            raise AssertionError("The fixture must never execute an unmocked command")
        self.actions.append(arguments)
        return ""


class NodeUpdaterTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="codey-updater-test-")
        self.root = Path(self.temp.name).resolve()

    def tearDown(self):
        self.assertTrue(self.root.name.startswith("codey-updater-test-"))
        self.temp.cleanup()

    def runtime(self, **options):
        try:
            return FakeRuntime(self.root / "home", **options)
        except OSError as error:
            if os.name == "nt" and getattr(error, "winerror", None) == 1314:
                self.skipTest("Symlink transaction tests run in the isolated Linux validation environment")
            raise

    def package(self, runtime, components=engine.COMPONENTS, sequence=1):
        manifest = {"schema": 1, "kind": "codey-node-release", "id": "node-release-one", "sequence": sequence,
                    "createdAt": int(time.time() * 1000) - 1000, "expiresAt": int(time.time() * 1000) + 86400000,
                    "protocol": 1, "platform": "linux-x64", "configSchema": 1, "rollback": "code-only",
                    "migrations": ["gateway-api-key-v1"], "notes": "fixture", "components": {}}
        artifacts = self.root / "artifacts"
        artifacts.mkdir()
        for name in components:
            directory = self.root / "build" / name
            FakeRuntime.package(directory, name, "2.0.0", "new entry " + name, "b" * 40)
            filename = "cloudcli.tar.gz" if name == "cloudcli" else "gateway.tar.gz"
            archive = artifacts / filename
            with tarfile.open(archive, "w:gz") as output:
                for file in directory.rglob("*"):
                    if file.is_file():
                        output.add(file, arcname=file.relative_to(directory).as_posix(), recursive=False)
            component = {"version": "2.0.0", "commit": "b" * 40, "file": filename,
                         "sha256": engine.sha(archive), "size": archive.stat().st_size, "nodeMajors": [24],
                         "entrySha256": engine.sha(directory / ("dist-server/server/index.js" if name == "cloudcli" else "dist/main.js"))}
            if name == "cloudcli":
                component["lockSha256"] = engine.sha(directory / "package-lock.json")
            manifest["components"][name] = component
        def download(_release, artifact, target):
            shutil.copy2(artifacts / artifact["file"], target)
        return manifest, download

    def dependency_candidate(self):
        runtime = self.runtime(directory_anchor=True)
        candidate = runtime.root / "releases/dependency-fixture/cloudcli"
        FakeRuntime.package(candidate, "cloudcli", "2.0.0", "fixture entry", "b" * 40)
        package = {"name": "@cloudcli-ai/cloudcli", "version": "2.0.0",
                   "scripts": {"prepare": "husky", "preinstall": "node preinstall.js",
                               "install": "node install.js", "postinstall": "node scripts/fix-node-pty.js"},
                   "devDependencies": {"husky": "9.1.7"},
                   "dependencies": {"fixture-native": "1.0.0"}}
        original = b"\xef\xbb\xbf" + (json.dumps(package, indent="\t") + "\n").replace("\n", "\r\n").encode()
        (candidate / "package.json").write_bytes(original)
        node = runtime.home / "fixture-node/bin/node"
        npm = node.parent.parent / "lib/node_modules/npm/bin/npm-cli.js"
        npm.parent.mkdir(parents=True)
        npm.write_text("fixture-only; never executed")
        before = {**runtime.snapshot(), "cloudcliNode": str(node)}
        job = runtime.root / "jobs/dependency-fixture"
        job.mkdir(parents=True)
        return runtime, before, candidate, job, original

    def test_dependency_install_omits_only_known_dev_husky_prepare_and_restores_signed_bytes(self):
        runtime, before, candidate, job, original = self.dependency_candidate()
        lock_before = engine.sha(candidate / "package-lock.json")
        original_scripts = json.loads(original)["scripts"]

        def npm(arguments, **options):
            during = engine.read(candidate / "package.json")
            self.assertEqual(during["scripts"], {key: value for key, value in original_scripts.items() if key != "prepare"})
            self.assertEqual(arguments[2:], ["ci", "--omit=dev", "--no-audit", "--no-fund"])
            self.assertEqual(options["cwd"], candidate)
            self.assertEqual(options["env"]["HOME"], str(job / "build-home"))
            self.assertEqual(options["env"]["HUSKY"], "0")
            self.assertNotIn("--ignore-scripts", arguments)
            self.assertNotIn("npm_config_ignore_scripts", options["env"])
            return ""

        with patch("engine.run", side_effect=npm) as command:
            engine.Runtime.prepare_dependencies(runtime, before, candidate, job)
        command.assert_called_once()
        self.assertEqual((candidate / "package.json").read_bytes(), original)
        self.assertEqual(engine.sha(candidate / "package-lock.json"), lock_before)
        self.assertEqual(runtime.actions, [])

    def test_dependency_install_failure_and_timeout_restore_original_package_bytes(self):
        runtime, before, candidate, job, original = self.dependency_candidate()
        lock_before = engine.sha(candidate / "package-lock.json")
        for failure in [engine.UpdateError("operation_failed"), subprocess.TimeoutExpired("fixture-npm", 180)]:
            def npm(*_, **__):
                self.assertNotIn("prepare", engine.read(candidate / "package.json")["scripts"])
                raise failure

            with self.subTest(failure=type(failure).__name__), patch("engine.run", side_effect=npm), self.assertRaises(type(failure)):
                engine.Runtime.prepare_dependencies(runtime, before, candidate, job)
            self.assertEqual((candidate / "package.json").read_bytes(), original)
            self.assertEqual(engine.sha(candidate / "package-lock.json"), lock_before)
        self.assertEqual(runtime.actions, [])

    def test_dependency_install_lock_drift_fails_staging_without_restoring_or_hiding_the_lock_change(self):
        runtime, before, candidate, job, original = self.dependency_candidate()
        lock = candidate / "package-lock.json"

        def npm(*_, **__):
            lock.write_text('{"unexpected":"lifecycle changed the signed lock"}\n')
            return ""

        with patch("engine.run", side_effect=npm), self.assertRaisesRegex(engine.UpdateError, "stage_failed"):
            engine.Runtime.prepare_dependencies(runtime, before, candidate, job)
        self.assertEqual((candidate / "package.json").read_bytes(), original)
        self.assertIn("unexpected", engine.read(lock))
        self.assertEqual(runtime.actions, [])

    def test_dependency_install_never_suppresses_unknown_or_production_prepare_hooks(self):
        runtime, before, candidate, job, original = self.dependency_candidate()
        baseline = json.loads(original)
        variants = [
            {"name": "another-package"},
            {"scripts": {**baseline["scripts"], "prepare": "husky && node build.js"}},
            {"scripts": {**baseline["scripts"], "prepare": "node build.js"}},
            {"devDependencies": {}},
            {"dependencies": {"husky": "9.1.7"}},
            {"optionalDependencies": {"husky": "9.1.7"}},
            {"peerDependencies": {"husky": "9.1.7"}},
        ]
        for change in variants:
            value = {**baseline, **change}
            engine.save(candidate / "package.json", value)
            expected = (candidate / "package.json").read_bytes()

            def npm(arguments, **_):
                self.assertEqual((candidate / "package.json").read_bytes(), expected)
                self.assertNotIn("--ignore-scripts", arguments)
                return ""

            with self.subTest(change=change), patch("engine.run", side_effect=npm):
                engine.Runtime.prepare_dependencies(runtime, before, candidate, job)
            self.assertEqual((candidate / "package.json").read_bytes(), expected)

    def test_symlink_layout_updates_only_changed_component_and_preserves_configuration(self):
        if os.name == "nt":
            self.skipTest("POSIX atomic directory-symlink replacement is validated on Linux, not Windows")
        runtime = self.runtime()
        before = runtime.snapshot()
        manifest, download = self.package(runtime, ["cloudcli"])
        events = []
        with patch("engine.run", side_effect=runtime.runner):
            result = engine.Upgrade(runtime, lambda state, code: events.append((state, code)), download).execute(
                manifest, "d" * 64, runtime.root / "jobs/job-one")
        self.assertEqual(result["state"], "succeeded")
        self.assertEqual(runtime.snapshot()["components"]["cloudcli"]["version"], "2.0.0")
        self.assertEqual(runtime.snapshot()["components"]["copilotApi"], before["components"]["copilotApi"])
        self.assertEqual(runtime.model_calls, 1)
        self.assertEqual(runtime.actions, [["systemctl", "--user", "stop", "codey-cloudcli.service"],
                                          ["systemctl", "--user", "start", "codey-cloudcli.service"]])
        self.assertEqual((runtime.data / "config.json").read_bytes(), runtime.before_data)
        self.assertEqual(events[-1], ("succeeded", "ok"))

    def test_directory_layout_adopts_atomic_links_without_changing_node_runtime_or_identity(self):
        runtime = self.runtime(directory_anchor=True)
        manifest, download = self.package(runtime)
        with patch("engine.run", side_effect=runtime.runner):
            result = engine.Upgrade(runtime, lambda *_: None, download).execute(
                manifest, "d" * 64, runtime.root / "jobs/job-one")
        self.assertEqual(result["state"], "succeeded")
        for name in engine.COMPONENTS:
            self.assertTrue(runtime.anchors[name].is_symlink())
            self.assertTrue((runtime.root / "jobs/job-one/backup" / name).is_dir())
        self.assertEqual((runtime.data / "config.json").read_bytes(), runtime.before_data)
        self.assertEqual(engine.read(runtime.data / "portal-build.json")["releaseId"], manifest["id"])

    def test_managed_directory_anchors_keep_dependencies_reachable_and_preserve_new_node_identity(self):
        runtime = self.runtime(directory_anchor=True)
        runtime.config = {"nodeId": "n-6f1362ba8058004606dbd9a9",
                          "ownerId": "9e7a208d-62e7-459d-a5be-f74e4b726a5a"}
        runtime.profile = {"layout": "managed", "copilotService": "codey-copilot-api.service"}
        release = runtime.home / ".local/share/codey-machine/releases/machine-fixture"
        release.mkdir(parents=True)
        for name, anchor in runtime.anchors.items():
            target = release / ("copilot-api" if name == "copilotApi" else name)
            os.rename(anchor, target)
            runtime.anchors[name] = target
        node = release / "node/bin/node"
        node.parent.mkdir(parents=True)
        node.write_text("untouched fixture runtime")
        modules = runtime.anchors["cloudcli"] / "node_modules"
        modules.mkdir()
        (modules / "fixture.js").write_text("dependency survives moving the original directory")
        assets = runtime.anchors["cloudcli"] / "dist"
        assets.mkdir()
        (assets / "index.html").write_text("preserved managed UI")
        before = runtime.snapshot()
        manifest, download = self.package(runtime, sequence=5)
        copies = []

        def runner(arguments, **kwargs):
            if arguments == [before["cloudcliNode"], "-p", "process.versions.modules"]:
                return "137"
            if arguments[:3] == ["cp", "-a", "--reflink=auto"]:
                copies.append(arguments)
                shutil.copytree(arguments[3], arguments[4], symlinks=True)
                return ""
            return runtime.runner(arguments, **kwargs)

        with patch("engine.run", side_effect=runner), patch.object(runtime, "prepare_dependencies",
                side_effect=lambda *args: engine.Runtime.prepare_dependencies(runtime, *args)):
            result = engine.Upgrade(runtime, lambda *_: None, download).execute(
                manifest, "d" * 64, runtime.root / "jobs/managed-directory")
        after = runtime.snapshot()
        self.assertEqual(result, {"state": "succeeded", "changed": ["cloudcli", "copilotApi"]})
        self.assertEqual((after["nodeId"], after["ownerId"]), (runtime.config["nodeId"], runtime.config["ownerId"]))
        self.assertEqual(after["highestSequence"], 5)
        self.assertEqual(node.read_text(), "untouched fixture runtime")
        self.assertEqual(len(copies), 1)
        self.assertTrue((runtime.anchors["cloudcli"] / "node_modules").resolve().is_relative_to(runtime.root / "dependencies"))
        self.assertEqual((runtime.anchors["cloudcli"] / "node_modules/fixture.js").read_text(),
                         "dependency survives moving the original directory")
        self.assertEqual((runtime.anchors["cloudcli"] / "dist/index.html").read_text(), "preserved managed UI")
        for name, anchor in runtime.anchors.items():
            self.assertTrue(anchor.is_symlink())
            self.assertTrue(anchor.resolve().is_relative_to(runtime.root / "releases"))
            self.assertTrue((runtime.root / "jobs/managed-directory/backup" / name).is_dir())
        self.assertEqual(runtime.actions, [
            ["systemctl", "--user", "stop", "codey-cloudcli.service", "codey-copilot-api.service"],
            ["systemctl", "--user", "start", "codey-cloudcli.service", "codey-copilot-api.service"],
        ])
        self.assertEqual(after["protected"], before["protected"])

    def test_identical_packages_verify_both_clients_without_restart_and_record_signed_release(self):
        runtime = self.runtime(directory_anchor=True)
        manifest, _ = self.package(runtime)
        before = runtime.snapshot()
        for name, component in manifest["components"].items():
            component.update({key: before["components"][name][key] for key in ["version", "commit", "entrySha256"]})
        events = []
        with patch("engine.run", side_effect=runtime.runner):
            result = engine.Upgrade(runtime, lambda *args: events.append(args),
                                    lambda *_: self.fail("Identical code must not be downloaded again")).execute(
                manifest, "d" * 64, runtime.root / "jobs/job-one")
        self.assertEqual(result, {"state": "succeeded", "changed": []})
        self.assertEqual(runtime.actions, [])
        self.assertEqual(runtime.model_calls, 1)
        self.assertEqual(runtime.snapshot()["highestSequence"], 1)
        self.assertEqual(events, [("verifying", "ok"), ("succeeded", "up_to_date")])

    def test_changed_commit_with_identical_version_and_entry_hash_still_switches_packages(self):
        runtime = self.runtime(directory_anchor=True)
        manifest, download = self.package(runtime, ["cloudcli"])
        package = runtime.anchors["cloudcli"] / "package.json"
        engine.save(package, {**engine.read(package), "version": "2.0.0"})
        (runtime.anchors["cloudcli"] / "dist-server/server/index.js").write_text("new entry cloudcli")
        before = runtime.snapshot()
        events = []
        job = runtime.root / "jobs/commit-only"
        with patch("engine.run", side_effect=runtime.runner):
            result = engine.Upgrade(runtime, lambda *args: events.append(args), download).execute(
                manifest, "d" * 64, job)
        after = runtime.snapshot()
        self.assertEqual(result, {"state": "succeeded", "changed": ["cloudcli"]})
        for key in ["version", "entrySha256"]:
            self.assertEqual(before["components"]["cloudcli"][key], after["components"]["cloudcli"][key])
        self.assertNotEqual(before["components"]["cloudcli"]["commit"], after["components"]["cloudcli"]["commit"])
        self.assertEqual(len(engine.read(job / "transaction.json")["anchors"]), 1)
        self.assertIn(("applying", "ok"), events)
        self.assertNotIn(("succeeded", "up_to_date"), events)

    def test_only_the_exact_synthetic_project_trust_record_is_ignored_not_provider_or_other_projects(self):
        file = self.root / "config.toml"
        probe = self.root / "empty-probe"
        baseline = 'model = "approved"\n[model_providers.mine]\nenv_key = "MODEL_KEY"\n'
        file.write_text(baseline)
        before = engine.config_hash(file, probe)
        file.write_text(baseline + "\n[projects." + json.dumps(str(probe)) + ']\ntrust_level = "trusted"\n')
        self.assertEqual(engine.config_hash(file, probe), before)
        file.write_text(file.read_text().replace('env_key = "MODEL_KEY"', 'env_key = "DIFFERENT_KEY"'))
        self.assertNotEqual(engine.config_hash(file, probe), before)
        file.write_text(baseline + '\n[projects."/another/project"]\ntrust_level = "trusted"\n')
        self.assertNotEqual(engine.config_hash(file, probe), before)
        file.write_text(baseline + "\n[projects." + json.dumps(str(probe)) + ']\ntrust_level = "untrusted"\n')
        self.assertNotEqual(engine.config_hash(file, probe), before)

    def test_gateway_transport_renames_preserve_every_setting_and_other_files_stay_byte_protected(self):
        file = self.root / "config.json"
        legacy = {"auth": {"apiKeys": ["owner-key"]}, "providers": [{"url": "https://approved.invalid"}],
                  "responsesTransport": {"headersTimeoutMsV2": 12345, "streamInactivityTimeoutMs": 45678}}
        current = {**legacy, "upstreamTransport": {
            "headersTimeoutMs": 12345, "streamInactivityTimeoutMs": 45678}}
        current.pop("responsesTransport")
        engine.save(file, legacy)
        expected = engine.gateway_config_hash(file)
        raw = engine.config_hash(file)
        for value in [current, {**current, "responsesTransport": legacy["responsesTransport"]},
                      {**current, "upstreamTransport": {
                          **current["upstreamTransport"], "headersTimeoutMsV2": 12345}}]:
            engine.save(file, value)
            self.assertEqual(engine.gateway_config_hash(file), expected)
        self.assertNotEqual(engine.config_hash(file), raw)
        changes = [
            {**current, "auth": {"apiKeys": ["different-key"]}},
            {**current, "providers": [{"url": "https://different.invalid"}]},
            {**current, "upstreamTransport": {**current["upstreamTransport"], "headersTimeoutMs": 12346}},
            {**current, "upstreamTransport": {"headersTimeoutMs": 12345}},
            {**current, "unexpected": True},
            {key: value for key, value in current.items() if key != "upstreamTransport"},
        ]
        for value in changes:
            engine.save(file, value)
            self.assertNotEqual(engine.gateway_config_hash(file), expected)

    def test_conflicting_gateway_aliases_and_malformed_blocks_are_not_normalized_away(self):
        file = self.root / "config.json"
        for value in [
            {"responsesTransport": {"headersTimeoutMsV2": 10}, "upstreamTransport": {"headersTimeoutMs": 20}},
            {"upstreamTransport": {"headersTimeoutMsV2": 10, "headersTimeoutMs": 20}},
            {"upstreamTransport": {"headersTimeoutMsV2": True, "headersTimeoutMs": 1}},
            {"responsesTransport": []}, {"upstreamTransport": None}, [],
        ]:
            with self.subTest(value=value):
                engine.save(file, value)
                with self.assertRaises(engine.UpdateError) as error:
                    engine.gateway_config_hash(file)
                self.assertEqual(error.exception.code, "configuration_changed")

    def test_gateway_startup_transport_migration_passes_transaction_without_changing_credentials(self):
        if os.name == "nt":
            self.skipTest("POSIX activation is validated in the isolated Linux environment")
        runtime = self.runtime(directory_anchor=True)
        file = runtime.data / "config.json"
        original = {**engine.read(file), "responsesTransport": {
            "headersTimeoutMsV2": 12345, "streamInactivityTimeoutMs": 45678}}
        engine.save(file, original)
        before = runtime.snapshot()
        manifest, download = self.package(runtime, ["copilotApi"])

        def migrate_at_start(arguments, **kwargs):
            result = runtime.runner(arguments, **kwargs)
            if arguments[:3] == ["systemctl", "--user", "start"]:
                document = engine.read(file)
                block = document.pop("responsesTransport")
                block["headersTimeoutMs"] = block.pop("headersTimeoutMsV2")
                document["upstreamTransport"] = block
                engine.save(file, document)
            return result

        with patch("engine.run", side_effect=migrate_at_start):
            result = engine.Upgrade(runtime, lambda *_: None, download).execute(
                manifest, "d" * 64, runtime.root / "jobs/transport-migration")
        self.assertEqual(result["state"], "succeeded")
        self.assertEqual(runtime.snapshot()["protected"], before["protected"])
        self.assertEqual(engine.read(file)["auth"], original["auth"])
        self.assertNotIn("responsesTransport", engine.read(file))
        self.assertEqual(engine.read(file)["upstreamTransport"]["headersTimeoutMs"], 12345)
        self.assertEqual(runtime.model_calls, 1)

    def test_model_failure_rolls_back_code_and_pin_but_not_new_user_data(self):
        runtime = self.runtime(directory_anchor=True, model_failure=True)
        manifest, download = self.package(runtime)
        events = []
        with patch("engine.run", side_effect=runtime.runner):
            result = engine.Upgrade(runtime, lambda state, code: events.append((state, code)), download).execute(
                manifest, "d" * 64, runtime.root / "jobs/job-one")
        self.assertEqual(result["state"], "rolled_back")
        self.assertTrue(all(item["version"] == "1.0.0" for item in runtime.snapshot()["components"].values()))
        self.assertEqual((runtime.data / "config.json").read_bytes(), runtime.before_data)
        self.assertEqual((runtime.data / "portal-build.json").read_bytes(), runtime.before_pin)
        self.assertEqual((runtime.data / "user-data.txt").read_text(), "new user data written during verification")
        self.assertFalse((runtime.private / "installed.json").exists())
        self.assertEqual(events[-1][0], "rolled_back")

    def test_configuration_drift_during_successful_model_probe_cannot_commit_a_release(self):
        runtime = self.runtime(directory_anchor=True)
        before = runtime.snapshot()
        manifest, download = self.package(runtime)
        events = []
        changed_config = {"auth": {"apiKeys": ["fixture-new-key-" + "y" * 48]}}

        def model_changes_configuration(snapshot, job):
            engine.save(runtime.data / "config.json", changed_config)

        with patch("engine.run", side_effect=runtime.runner), patch.object(
                runtime, "model", side_effect=model_changes_configuration):
            result = engine.Upgrade(runtime, lambda *args: events.append(args), download).execute(
                manifest, "d" * 64, runtime.root / "jobs/model-config-drift")
        self.assertEqual(result["state"], "rolled_back")
        self.assertEqual(runtime.snapshot()["components"], before["components"])
        self.assertFalse((runtime.private / "installed.json").exists())
        self.assertEqual((runtime.data / "portal-build.json").read_bytes(), runtime.before_pin)
        self.assertEqual(engine.read(runtime.data / "config.json"), changed_config,
                         "Rollback must not overwrite a concurrent owner configuration change")
        self.assertNotIn(("succeeded", "ok"), events)

    def test_model_configuration_paths_cover_owner_key_and_actual_codex_home(self):
        runtime = self.runtime(directory_anchor=True)
        custom_home = runtime.home / "custom-codex"
        files = runtime.model_config_paths({"CODEX_HOME": str(custom_home)})
        self.assertIn(runtime.home / ".config/codey-model-auth/api-key", files)
        self.assertIn(runtime.home / ".codex/config.toml", files)
        self.assertIn(custom_home / "config.toml", files)
        for file in files:
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text('model = "fixture-before"\n' if file.name == "config.toml" else "fixture-key-before")
            before = engine.config_hash(file, runtime.root / "probe")
            file.write_text('model = "fixture-after"\n' if file.name == "config.toml" else "fixture-key-after")
            self.assertNotEqual(engine.config_hash(file, runtime.root / "probe"), before)
        with self.assertRaisesRegex(engine.UpdateError, "configuration_changed"):
            runtime.model_config_paths({"CODEX_HOME": str(self.root / "another-owner")})
        key = runtime.home / ".config/codey-model-auth/api-key"
        key.unlink()
        external = self.root / "another-owner-key"
        external.write_text("fixture-must-not-be-read")
        key.symlink_to(external)
        with self.assertRaisesRegex(engine.UpdateError, "configuration_changed"):
            runtime.model_config_paths({})

    def test_model_catalog_paths_follow_the_actual_codex_home_and_hash_catalog_bytes(self):
        runtime = self.runtime(directory_anchor=True)
        config_home = runtime.home / "custom-codex"
        config_home.mkdir()
        runtime.cloudcli_env = {"CODEX_HOME": str(config_home)}
        catalog = config_home / "models.json"
        catalog.write_text('{"models":[{"slug":"fixture-before"}]}\n')
        inactive = runtime.home / ".codex/config.toml"
        inactive.parent.mkdir()
        inactive.write_text("model_catalog_json = " + json.dumps(str(self.root / "inactive-outside-owner.json")) + "\n")
        for reference in [str(catalog), "models.json", "~/custom-codex/models.json"]:
            with self.subTest(reference=reference):
                (config_home / "config.toml").write_text("model_catalog_json = " + json.dumps(reference) + "\n")
                self.assertIn(catalog, runtime.model_config_paths(runtime.cloudcli_env))
                before = runtime.snapshot()
                self.assertEqual(before["protected"][str(catalog)], engine.sha(catalog))
                catalog.write_text(catalog.read_text() + " ")
                with self.assertRaisesRegex(engine.UpdateError, "configuration_changed"):
                    runtime.assert_unchanged(before)

    def test_model_catalog_paths_reject_missing_invalid_and_outside_owner_targets(self):
        runtime = self.runtime(directory_anchor=True)
        config_home = runtime.home / ".codex"
        config_home.mkdir()
        outside = self.root / "another-owner-models.json"
        outside.write_text('{"fixture":"must not be read"}')
        link = config_home / "linked-models.json"
        link.symlink_to(outside)
        for reference in [1, "", "missing.json", str(config_home), str(outside),
                          "../../another-owner-models.json", "~another-owner/models.json", str(link)]:
            with self.subTest(reference=reference):
                (config_home / "config.toml").write_text("model_catalog_json = " + json.dumps(reference) + "\n")
                with self.assertRaisesRegex(engine.UpdateError, "configuration_changed"):
                    runtime.model_config_paths({})

    def test_model_catalog_drift_during_probe_rolls_back_code_without_overwriting_the_catalog(self):
        runtime = self.runtime(directory_anchor=True)
        config_home = runtime.home / ".codex"
        config_home.mkdir()
        (config_home / "config.toml").write_text('model_catalog_json = "models.json"\n')
        catalog = config_home / "models.json"
        catalog.write_text('{"models":[{"slug":"owner-approved"}]}\n')
        before = runtime.snapshot()
        manifest, download = self.package(runtime)
        replacement = '{"models":[{"slug":"concurrent-owner-change"}]}\n'
        with patch("engine.run", side_effect=runtime.runner), patch.object(
                runtime, "model", side_effect=lambda *_: catalog.write_text(replacement)):
            result = engine.Upgrade(runtime, lambda *_: None, download).execute(
                manifest, "d" * 64, runtime.root / "jobs/catalog-drift")
        self.assertEqual(result["state"], "rolled_back")
        self.assertEqual(runtime.snapshot()["components"], before["components"])
        self.assertEqual(catalog.read_text(), replacement)
        self.assertFalse((runtime.private / "installed.json").exists())

    def test_codex_probe_uses_service_environment_read_only_mode_and_an_exact_model_reply(self):
        runtime = self.runtime(directory_anchor=True)
        config_home = runtime.home / "custom-codex"
        config_home.mkdir()
        (config_home / "config.toml").write_text(
            'model = "fixture-model"\n[model_providers.fixture]\nenv_key = "FIXTURE_MODEL_KEY"\n'
            '[mcp_servers.fixture_mcp]\ncommand = "must-never-run"\n')
        job = runtime.root / "jobs/model-probe"
        job.mkdir(parents=True)
        (runtime.root / "probe").mkdir()
        service_env = {"PATH": str(runtime.home / "bin"), "CODEX_HOME": str(config_home),
                       "FIXTURE_MODEL_KEY": "synthetic-model-key", "UNRELATED_SECRET": "must-not-be-copied"}
        calls = []

        def runner(arguments, **kwargs):
            calls.append((arguments, kwargs))
            answer = Path(arguments[arguments.index("--output-last-message") + 1])
            answer.write_text(reply)
            return ""

        for reply in ["CODEX_NODE_UPDATE_OK", "not-the-requested-marker"]:
            with self.subTest(reply=reply), patch("engine.environment", return_value=service_env), patch(
                    "engine.shutil.which", return_value="/fixture/codex") as which, patch.object(
                    runtime, "probe", return_value={"passed": True}) as probe, patch("engine.run", side_effect=runner):
                if reply == "CODEX_NODE_UPDATE_OK":
                    engine.Runtime.model(runtime, runtime.snapshot(), job)
                else:
                    with self.assertRaisesRegex(engine.UpdateError, "model_failed"):
                        engine.Runtime.model(runtime, runtime.snapshot(), job)
                which.assert_called_once_with("codex", path=service_env["PATH"])
                probe.assert_called_once()
                self.assertEqual(probe.call_args.args[0], "verify")
        arguments, options = calls[0]
        self.assertEqual(arguments[:8], ["/fixture/codex", "exec", "--ephemeral", "--skip-git-repo-check",
                                        "--sandbox", "read-only", "--json", "--config"])
        self.assertIn('approval_policy="never"', arguments)
        self.assertIn("mcp_servers.fixture_mcp.enabled=false", arguments)
        self.assertEqual(options["cwd"], runtime.root / "probe")
        self.assertEqual(options["timeout"], 90)
        self.assertEqual(options["env"], {"HOME": str(runtime.home), "PATH": service_env["PATH"],
                                         "CODEX_HOME": str(config_home), "FIXTURE_MODEL_KEY": "synthetic-model-key"})

    def test_downgrade_and_equal_sequence_digest_changes_do_not_download_or_restart(self):
        runtime = self.runtime(directory_anchor=True)
        manifest, _ = self.package(runtime, sequence=7)
        receipt = {"releaseId": "already-verified", "sequence": 7, "digest": "d" * 64}
        engine.save(runtime.private / "installed.json", receipt)
        for sequence, digest in [(6, "d" * 64), (7, "e" * 64)]:
            with self.subTest(sequence=sequence), self.assertRaisesRegex(engine.UpdateError, "signature_invalid"):
                engine.Upgrade(runtime, lambda *_: self.fail("Must reject before job progress"),
                               lambda *_: self.fail("Must reject before downloading")).execute(
                    {**manifest, "sequence": sequence}, digest, runtime.root / ("jobs/rejected-" + str(sequence)))
        self.assertEqual(runtime.actions, [])
        self.assertEqual(engine.read(runtime.private / "installed.json"), receipt)

    def test_failure_after_receipt_write_restores_previous_successful_high_water_mark(self):
        runtime = self.runtime(directory_anchor=True)
        before = runtime.snapshot()
        receipt = {"releaseId": "previous-success", "sequence": 5, "digest": "c" * 64,
                   "components": before["components"]}
        engine.save(runtime.private / "installed.json", receipt)
        manifest, download = self.package(runtime, ["cloudcli"], sequence=6)
        job = runtime.root / "jobs/receipt-write-failure"
        real_save = engine.save
        written_sequences = []

        def fail_final_journal(file, value):
            if Path(file) == runtime.private / "installed.json":
                written_sequences.append(value["sequence"])
            if Path(file) == job / "transaction.json" and value.get("state") == "succeeded":
                raise OSError("fixture final journal write failure")
            real_save(file, value)

        with patch("engine.run", side_effect=runtime.runner), patch("engine.save", side_effect=fail_final_journal):
            result = engine.Upgrade(runtime, lambda *_: None, download).execute(manifest, "d" * 64, job)
        self.assertEqual(written_sequences, [6], "Exercise restoration after the newer receipt really was saved")
        self.assertEqual(result["state"], "rolled_back")
        self.assertEqual(engine.read(runtime.private / "installed.json"), receipt)
        self.assertEqual(runtime.snapshot()["highestSequence"], 5)
        self.assertEqual(runtime.snapshot()["components"], before["components"])
        self.assertEqual(engine.read(job / "transaction.json")["state"], "rolled_back")

    def test_interrupted_activation_recovers_locally_before_polling_and_reports_recovered_rollback(self):
        runtime = self.runtime(directory_anchor=True)
        runtime.profile = {"layout": "managed", "copilotService": "codey-copilot-api.service"}
        before = runtime.snapshot()
        manifest, download = self.package(runtime)
        job = {"id": "a" * 32, "leaseToken": "b" * 43, "releaseId": manifest["id"], "state": "applying"}
        work = runtime.root / "jobs" / job["id"]
        events = []
        polled_states = []

        class InterruptedProcess(BaseException):
            pass

        def interrupt_start(arguments, **kwargs):
            runtime.runner(arguments, **kwargs)
            if arguments[:3] == ["systemctl", "--user", "start"]:
                raise InterruptedProcess()
            return ""

        with patch("engine.run", side_effect=interrupt_start), self.assertRaises(InterruptedProcess):
            engine.Upgrade(runtime, lambda *_: None, download).execute(manifest, "d" * 64, work)
        self.assertEqual(engine.read(work / "transaction.json")["state"], "verifying")
        self.assertNotEqual(runtime.snapshot()["components"], before["components"])
        engine.save(runtime.private / "pending.json", job)

        class Api:
            def json(self, url, value):
                if url.endswith("/poll"):
                    polled_states.append((engine.read(work / "transaction.json")["state"],
                                          runtime.snapshot()["components"]))
                    return {"job": job}
                events.append(value)
                return {}

        with patch("engine.run", side_effect=runtime.runner), patch.object(runtime, "report", return_value={}):
            result = Agent({"releasePublicKey": "fixture-unused-during-recovery"}, runtime, Api()).once()
        self.assertEqual(result, {"state": "rolled_back"})
        self.assertEqual(polled_states, [("rolled_back", before["components"])])
        self.assertEqual((events[-1]["state"], events[-1]["code"]), ("rolled_back", "recovered_rollback"))
        self.assertFalse((runtime.private / "pending.json").exists())
        self.assertFalse((runtime.private / "installed.json").exists())
        self.assertEqual(runtime.model_calls, 0, "Recovery only checks gateway health, not real model replies")
        self.assertEqual((runtime.data / "config.json").read_bytes(), runtime.before_data)

    def test_unknown_migrations_and_incompatible_runtimes_never_download_or_stop_services(self):
        runtime = self.runtime()
        manifest, _ = self.package(runtime)
        for change, expected in [({"migrations": ["unknown-schema-v2"]}, "migration_unsupported"),
                                 ({"platform": "win32-x64"}, "unsupported_platform")]:
            with self.subTest(change=change):
                item = {**manifest, **change}
                with self.assertRaises(engine.UpdateError) as error:
                    engine.Upgrade(runtime, lambda *_: None, lambda *_: self.fail("must not download")).execute(
                        item, "d" * 64, runtime.root / "jobs/job-one")
                self.assertEqual(error.exception.code, expected)
                self.assertEqual(runtime.actions, [])
        manifest["components"]["cloudcli"]["nodeMajors"] = [26]
        with self.assertRaisesRegex(engine.UpdateError, "runtime_incompatible"):
            engine.Upgrade(runtime, lambda *_: None, lambda *_: self.fail("must not download")).execute(
                manifest, "d" * 64, runtime.root / "jobs/job-two")

    def test_concurrent_anchor_change_is_not_stopped_or_overwritten_by_rollback(self):
        runtime = self.runtime()
        manifest, download = self.package(runtime, ["cloudcli"])
        job = runtime.root / "jobs/job-one"
        with patch("engine.run", side_effect=runtime.runner):
            engine.Upgrade(runtime, lambda *_: None, download).execute(manifest, "d" * 64, job)
        transaction = engine.read(job / "transaction.json")
        foreign = self.root / "different-release"
        foreign.mkdir()
        runtime.anchors["cloudcli"].unlink()
        runtime.anchors["cloudcli"].symlink_to(foreign, target_is_directory=True)
        runtime.actions.clear()
        with patch("engine.run", side_effect=runtime.runner), self.assertRaisesRegex(engine.UpdateError, "rollback_failed"):
            runtime.rollback(transaction["anchors"], job)
        self.assertEqual(runtime.actions, [])
        self.assertEqual(runtime.anchors["cloudcli"].resolve(), foreign)

    def test_expired_release_cannot_reach_activation(self):
        runtime = self.runtime()
        manifest, download = self.package(runtime)
        manifest["expiresAt"] = 1
        with patch("engine.run", side_effect=runtime.runner), self.assertRaisesRegex(engine.UpdateError, "signature_invalid"):
            engine.Upgrade(runtime, lambda *_: None, download).execute(manifest, "d" * 64, runtime.root / "jobs/job-one")
        self.assertEqual(runtime.actions, [])

    def test_invalid_archive_types_paths_duplicates_and_size_never_overwrite_files(self):
        for case in ["traversal", "absolute", "symlink", "hardlink", "duplicate", "oversized"]:
            with self.subTest(case=case):
                file = self.root / (case + ".tgz")
                with tarfile.open(file, "w:gz") as output:
                    member = tarfile.TarInfo({"traversal": "../escape", "absolute": "/escape"}.get(case, "entry"))
                    if case in {"symlink", "hardlink"}:
                        member.type = tarfile.SYMTYPE if case == "symlink" else tarfile.LNKTYPE
                        member.linkname = "../escape"
                    if case == "oversized":
                        member.name = "x" * 501
                    output.addfile(member)
                    if case == "duplicate":
                        output.addfile(tarfile.TarInfo("./entry"))
                destination = self.root / ("out-" + case)
                with self.assertRaises(engine.UpdateError):
                    engine.extract(file, destination)
                self.assertFalse(destination.exists())
        self.assertFalse((self.root / "escape").exists())

    def test_client_rejects_plain_http_origins_local_node_and_non_updater_paths(self):
        config = {"schema": 1, "protocol": 1, "nodeId": "alpha", "ownerId": "owner-a", "username": "alice",
                  "portalOrigin": "https://codey.example.test", "credential": "x" * 43,
                  "releasePublicKey": "public"}
        file = self.root / "config.json"
        for patch_value in [{"portalOrigin": "http://codey.example"}, {"nodeId": "local"},
                            {"portalOrigin": "https://user:password@codey.example"}]:
            engine.save(file, {**config, **patch_value})
            with self.assertRaises(engine.UpdateError):
                load_config(file)
        with self.assertRaises(engine.UpdateError):
            Client(config).request("/api/admin/users", {})
        with self.assertRaises(engine.UpdateError):
            NoRedirect().redirect_request(None, None, None, None, None)

    def test_openssl_verifies_the_node_signed_envelope_and_rejects_tampering(self):
        openssl = shutil.which("openssl")
        if not openssl:
            self.skipTest("OpenSSL is exercised in the Linux validation environment")
        helper = r"""
const c=require('node:crypto'),fs=require('node:fs');
const key=c.generateKeyPairSync('ed25519');
const m=JSON.parse(fs.readFileSync(process.argv[1]));
const b=Buffer.from(JSON.stringify(m));
fs.writeFileSync(process.argv[2],JSON.stringify({payload:b.toString('base64'),signature:c.sign(null,b,key.privateKey).toString('base64url')}));
fs.writeFileSync(process.argv[3],key.publicKey.export({type:'spki',format:'pem'}));
"""
        manifest = {"schema": 1, "kind": "codey-node-release", "id": "fixture", "sequence": 1,
                    "createdAt": int(time.time() * 1000) - 1000, "expiresAt": int(time.time() * 1000) + 86400000,
                    "protocol": 1, "platform": "linux-x64", "configSchema": 1, "rollback": "code-only",
                    "migrations": [], "components": {"copilotApi": {"version": "2.0.0", "commit": "a" * 40,
                        "file": "gateway.tar.gz", "sha256": "b" * 64, "size": 1, "entrySha256": "c" * 64, "nodeMajors": [24]}}}
        engine.save(self.root / "manifest.json", manifest)
        subprocess.run(["node", "-e", helper, str(self.root / "manifest.json"), str(self.root / "signed.json"),
                        str(self.root / "public.pem")], check=True)
        envelope = engine.read(self.root / "signed.json")
        public = (self.root / "public.pem").read_text()
        actual, _ = engine.verify_envelope(envelope, public, self.root)
        self.assertEqual(actual, manifest)
        envelope["payload"] = base64.b64encode(b'{"changed":true}').decode()
        with self.assertRaisesRegex(engine.UpdateError, "signature_invalid"):
            engine.verify_envelope(envelope, public, self.root)

    def test_agent_reports_invalid_signature_instead_of_leaving_a_claimed_job_forever(self):
        runtime = self.runtime(directory_anchor=True)
        job = {"id": "a" * 32, "state": "claimed", "leaseToken": "b" * 43, "releaseId": "test", "envelope": {},
               "digest": "d" * 64}
        events = []
        class Api:
            def json(self, url, value):
                if url.endswith("/poll"):
                    return {"job": job}
                events.append(value)
                return {}
            def download(self, *_):
                raise AssertionError("Invalid signature must not download")
        with patch.object(runtime, "report", return_value={}), patch("updater.verify_envelope", side_effect=engine.UpdateError("signature_invalid")):
            result = Agent({"releasePublicKey": "test"}, runtime, Api()).once()
        self.assertEqual(result["state"], "failed")
        self.assertEqual(events[-1]["code"], "signature_invalid")
        self.assertEqual(runtime.actions, [])
        self.assertFalse((runtime.private / "pending.json").exists())

    def test_interrupted_stage_requires_a_new_explicit_retry_and_never_restarts_services(self):
        runtime = self.runtime(directory_anchor=True)
        job = {"id": "a" * 32, "state": "staging", "leaseToken": "b" * 43, "releaseId": "test"}
        events = []
        class Api:
            def json(self, url, value):
                if url.endswith("/poll"):
                    return {"job": job}
                events.append(value)
                return {}
        with patch.object(runtime, "report", return_value={}):
            result = Agent({"releasePublicKey": "test"}, runtime, Api()).once()
        self.assertEqual(result["state"], "needs_action")
        self.assertEqual(events[-1]["code"], "configuration_changed")
        self.assertEqual(runtime.actions, [])

    def test_executable_entrypoints_ignore_cwd_and_pythonpath_module_shadowing(self):
        marker = self.root / "untrusted-import-ran"
        (self.root / "json.py").write_text("from pathlib import Path\nPath(" + repr(str(marker)) + ").write_text('bad')\nraise RuntimeError('CWD must not be imported')\n")
        (self.root / "copy.py").write_text((self.root / "json.py").read_text())
        env = {**os.environ, "PYTHONPATH": str(self.root)}
        for entry in ["install.py", "updater.py"]:
            with self.subTest(entry=entry):
                result = subprocess.run([sys.executable, str(ROOT / "node-updater" / entry), "--help"],
                                        cwd=self.root, env=env, capture_output=True, text=True, timeout=10)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertFalse(marker.exists())


if __name__ == "__main__":
    unittest.main()
