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
        return {"nodeId": "alpha", "ownerId": "owner-a", "layout": "legacy", "platform": "linux-x64",
                "cloudcliPid": 10, "copilotPid": 11, "cloudcliNode": "/fixture/node", "copilotNode": "/fixture/node",
                "cloudcliPath": str(self.anchors["cloudcli"].resolve()), "copilotPath": str(self.anchors["copilotApi"].resolve()),
                "cloudcliAnchor": str(self.anchors["cloudcli"]), "copilotAnchor": str(self.anchors["copilotApi"]),
                "copilotService": "copilot-api.service", "copilotHome": str(self.data), "database": str(self.data / "absent.sqlite"),
                "components": values, "highestSequence": installed.get("sequence", 0), "installedDigest": installed.get("digest"),
                "currentRelease": installed.get("releaseId"), "readyMigrations": ["gateway-api-key-v1"],
                "protected": {str(self.data / "config.json"): engine.sha(self.data / "config.json")},
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
