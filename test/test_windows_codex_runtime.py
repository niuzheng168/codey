"""Regression tests for disposable Desktop CLI paths and narrow active-node repairs."""
from contextlib import ExitStack, redirect_stdout
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "skills/config-new-codey-machine/scripts"


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, file)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


native = load("native_codex_test", SCRIPTS / "windows-codex-runtime.py")
repair = load("native_codex_repair_test", SCRIPTS / "repair-windows-codex.py")
resume = load("native_codex_resume_fixture", Path(__file__).with_name("test_windows_tunnel_resume.py"))
ID = resume.ID


class SnapshotTests(unittest.TestCase):
    def fixture(self, root):
        node = root / ID
        node.mkdir()
        desktop = root / "Desktop/bin/old-version"
        desktop.mkdir(parents=True)
        for name in native.FILES:
            (desktop / name).write_bytes(("native fixture " + name).encode())
        (desktop / "auth.json").write_text("never-copy-owner-credentials")
        (desktop / "config.toml").write_text("never-copy-owner-configuration")
        return node, desktop / "codex.exe"

    def test_plan_is_read_only_and_apply_pins_only_allowlisted_native_files(self):
        with tempfile.TemporaryDirectory() as directory:
            node, source = self.fixture(Path(directory))
            planned = native.pin(source, node, ID)
            self.assertEqual(list(node.iterdir()), [])
            actual = native.pin(source, node, ID, apply=True)
            self.assertEqual(planned, actual)
            destination = Path(actual["executable"]).parent
            self.assertEqual({file.name for file in destination.iterdir()}, set(native.FILES) | {"bundle.json"})
            self.assertNotIn("credentials", (destination / "bundle.json").read_text())
            for file, expected in native.hashes(actual).items():
                self.assertEqual(native.digest(file), expected)

    def test_pinned_native_runtime_survives_desktop_removal_and_does_not_silently_upgrade(self):
        with tempfile.TemporaryDirectory() as directory:
            node, source = self.fixture(Path(directory))
            saved = native.pin(source, node, ID, apply=True)
            original = Path(saved["executable"]).read_bytes()
            for name in native.FILES:
                (source.parent / name).unlink()  # Exact fixture files only, not a recursive delete.
            source.write_bytes(b"new Desktop release")
            self.assertEqual(native.verify(saved, node, ID), saved)
            self.assertEqual(Path(saved["executable"]).read_bytes(), original)
            newer = native.pin(source, node, ID, apply=True)
            self.assertNotEqual(newer["bundleId"], saved["bundleId"])
            self.assertEqual(native.verify(saved, node, ID), saved)
            self.assertEqual(Path(newer["executable"]).read_bytes(), b"new Desktop release")

    def test_tampered_receipt_binary_companion_or_foreign_node_is_rejected_without_overwrite(self):
        for kind in ("receipt", "binary", "companion", "unexpected", "node", "path"):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as directory:
                node, source = self.fixture(Path(directory))
                saved = native.pin(source, node, ID, apply=True)
                destination = Path(saved["executable"]).parent
                if kind == "receipt":
                    (destination / "bundle.json").write_text("{}")
                elif kind in ("binary", "companion"):
                    (destination / ("codex.exe" if kind == "binary" else "codex-command-runner.exe")).write_bytes(b"changed")
                elif kind == "unexpected":
                    (destination / "unknown.dll").write_bytes(b"unknown")
                elif kind == "node":
                    saved["nodeId"] = "n-" + "f" * 24
                else:
                    saved["executable"] = str(source)
                before = resume.snapshot(node)
                with self.assertRaises(native.NativeCodexError):
                    native.verify(saved, node, ID)
                self.assertEqual(resume.snapshot(node), before)
                if kind in ("receipt", "binary", "companion", "unexpected"):
                    with self.assertRaises(native.NativeCodexError):
                        native.pin(source, node, ID, apply=True)
                    self.assertEqual(resume.snapshot(node), before)

    def test_missing_relative_or_non_native_paths_never_search_PATH(self):
        with tempfile.TemporaryDirectory() as directory:
            node, source = self.fixture(Path(directory))
            for file in ("codex.exe", node / "absent.exe", source.with_name("codex.cmd")):
                with self.subTest(file=file), self.assertRaises(native.NativeCodexError):
                    native.pin(file, node, ID, apply=True)
            self.assertEqual(list(node.iterdir()), [])

    @unittest.skipUnless(os.name == "nt", "Windows junction boundary")
    def test_junction_source_or_destination_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            node, source = self.fixture(Path(directory))
            link = node / "native-codex"
            target = Path(directory) / "outside"
            target.mkdir()
            # Only a fixture junction is created; no data is moved or deleted through it.
            script = Path(directory) / "create-fixture-junction.ps1"
            script.write_text("param([string]$Link,[string]$Target)\n"
                              "$ErrorActionPreference='Stop'\n"
                              "New-Item -ItemType Junction -Path $Link -Target $Target | Out-Null\n")
            subprocess.run([repair.windows.native_powershell(), "-NoProfile", "-NonInteractive",
                            "-File", script, "-Link", link, "-Target", target], check=True, capture_output=True)
            try:
                with self.assertRaises(native.NativeCodexError):
                    native.pin(source, node, ID, apply=True)
                self.assertEqual(list(target.iterdir()), [])
            finally:
                self.assertTrue(link.is_junction())
                self.assertEqual(link.resolve(), target.resolve())
                link.rmdir()  # Remove the exact verified fixture junction, never its target.

    def test_source_changing_during_copy_never_publishes_a_bundle(self):
        with tempfile.TemporaryDirectory() as directory:
            node, source = self.fixture(Path(directory))
            original = native.inventory
            calls = 0

            def changed(path):
                nonlocal calls
                calls += 1
                result = original(path)
                return {**result, "codex.exe": "0" * 64} if calls > 1 else result

            with patch.object(native, "inventory", side_effect=changed), self.assertRaisesRegex(
                    native.NativeCodexError, "source_changed"):
                native.pin(source, node, ID, apply=True)
            self.assertTrue(all(".prepare-" in file.name for file in (node / "native-codex").iterdir()))


@unittest.skipUnless(os.name == "nt", "Native Windows installation transaction fixtures")
class RepairTests(unittest.TestCase):
    def test_native_task_controller_restarts_only_exact_idle_owned_tasks(self):
        context = repair.windows.service.owner_context()
        if context["elevated"]:
            self.skipTest("Repair deliberately refuses an elevated owner")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            runner = root / "runner.py"
            runner.write_text("# never executed")
            config_file = root / "runtime.json"
            config_file.write_text(json.dumps({
                "schema": 1, "kind": "windows-devtunnel", "nodeId": ID, "ownerSid": context["sid"],
                "computerName": repair.platform.node(), "root": str(root), "configRoot": str(root),
                "runnerPath": str(runner), "pythonwExe": str(Path(os.sys.executable).with_name("pythonw.exe")),
                "nodeExe": str(root / "fixture-node.exe"), "workspaceEntry": str(root / "fixture-server.js"),
            }))
            for case in ("restart", "plan", "foreign", "inside", "other-process", "acl"):
                with self.subTest(case=case):
                    result = subprocess.run([
                        repair.windows.native_powershell(), "-NoProfile", "-NonInteractive", "-File",
                        Path(__file__).with_name("windows-codex-tasks-fixture.ps1"),
                        "-Controller", SCRIPTS / "windows-codex-repair-tasks.ps1",
                        "-ConfigPath", config_file, "-Case", case,
                    ], check=True, capture_output=True, text=True, timeout=20)
                    body = json.loads(result.stdout)
                    self.assertTrue(body["schedulerWasFake"])
                    self.assertEqual(body["rejected"], case not in ("restart", "plan"), body["fixtureError"])
                    self.assertEqual(body["calls"], ["stop:workspace", "run:workspace", "run:renew"]
                                     if case == "restart" else [])

    def fixture(self, root):
        fixture_builder = resume.ResumeTests()
        fixture = fixture_builder.fixture(root)
        with fixture_builder.environment(fixture):
            resume.installer.configure(fixture.args)
        config_file, state_file = fixture.config_root / "runtime.json", fixture.config_root / "installation.json"
        config, state = json.loads(config_file.read_text()), json.loads(state_file.read_text())
        # Reproduce the released installer before this fix: direct Desktop-cache pin.
        saved = config.pop("nativeCodex")
        config["fileHashes"] = {file: value for file, value in config["fileHashes"].items()
                                if file not in native.hashes(saved)}
        old = fixture.args.codex_executable
        config["codexExe"] = old
        config["fileHashes"][old] = native.digest(old)
        state.pop("nativeCodex")
        state["codexExecutable"] = old
        config_file.write_text(json.dumps(config))
        state_file.write_text(json.dumps(state))
        Path(old).unlink()
        current = root / "Desktop/bin/new-version/codex.exe"
        current.parent.mkdir(parents=True)
        current.write_bytes(b"new native Codex fixture; never executed")
        current.with_name("codex-command-runner.exe").write_bytes(b"native companion fixture")
        fixture.repair_args = SimpleNamespace(
            node_id=ID, expected_computer_name=state["computerName"], codex_executable=str(current), apply=True)
        return fixture

    def environment(self, fixture, *, idle=True, inside=False, task_error=False):
        stack = ExitStack()
        stack.enter_context(patch.object(repair.Path, "home", return_value=fixture.home))
        stack.enter_context(patch.object(repair.platform, "node", return_value=fixture.repair_args.expected_computer_name))
        stack.enter_context(patch.object(repair.windows.service, "owner_context",
                                        return_value={"sid": "test-owner", "sessionId": 1, "elevated": False}))
        stack.enter_context(patch.object(repair.setup, "gateway_proof", return_value=fixture.proof))
        task_mock = stack.enter_context(patch.object(
            repair, "tasks", side_effect=repair.Error("unowned_task") if task_error else None,
            return_value={"ownerVerified": True, "tasksVerified": True, "insideWorkspace": inside}))
        stack.enter_context(patch.object(repair, "workspace_get", return_value={
            "success": True, "data": {"sessions": [] if idle else [{"sessionId": "existing-busy-chat"}]}}))
        protocol = stack.enter_context(patch.object(repair, "native_probe", return_value={
            "nativeStdio": True, "modelCatalog": True, "realModelCallsTested": False}))
        stack.enter_context(patch.object(repair.windows.common, "verify", return_value={"workspaceSso": True}))
        stack.enter_context(patch.object(repair.setup, "run", side_effect=AssertionError("unexpected command")))
        output = io.StringIO()
        stack.enter_context(redirect_stdout(output))
        return stack, task_mock, protocol, output

    def test_ready_repair_plan_does_not_write_or_stop_anything(self):
        with tempfile.TemporaryDirectory() as directory:
            fixture = self.fixture(Path(directory))
            fixture.repair_args.apply = False
            before = resume.snapshot(fixture.home)
            env, task, probe, output = self.environment(fixture)
            with env:
                repair.repair(fixture.repair_args)
            self.assertEqual(resume.snapshot(fixture.home), before)
            self.assertFalse(json.loads(output.getvalue())["oldExecutableExists"])
            self.assertEqual(task.call_count, 1)
            probe.assert_not_called()

    def test_ready_repair_pins_current_native_runtime_and_keeps_every_other_input(self):
        with tempfile.TemporaryDirectory() as directory:
            fixture = self.fixture(Path(directory))
            before = resume.snapshot(fixture.home)
            env, task, probe, output = self.environment(fixture)
            with env:
                repair.repair(fixture.repair_args)
            report = json.loads(output.getvalue())
            self.assertTrue(report["ok"] and report["nativeStdio"])
            self.assertFalse(report["realModelCallsTested"])
            self.assertEqual(task.call_args_list[-1].args[-1], "Restart")
            self.assertEqual(task.call_count, 3)
            probe.assert_called_once()
            for name, value in before.items():
                if Path(name).name not in ("runtime.json", "installation.json"):
                    self.assertEqual((fixture.home / name).read_bytes(), value, name)
            config = json.loads((fixture.config_root / "runtime.json").read_text())
            state = json.loads((fixture.config_root / "installation.json").read_text())
            self.assertEqual(config["codexExe"], state["codexExecutable"])
            self.assertNotEqual(config["codexExe"], fixture.repair_args.codex_executable)
            self.assertEqual(config["tunnelId"], "codey-" + ID)
            self.assertEqual(config["nativeCodex"], state["nativeCodex"])
            self.assertNotIn(fixture.args.codex_executable, config["fileHashes"])
            for file, expected in native.hashes(config["nativeCodex"]).items():
                self.assertEqual(config["fileHashes"][file], expected)
            self.assertEqual(len(list(fixture.config_root.glob("runtime.before-codex-repair-*.json"))), 1)
            self.assertNotIn("A" * 43, output.getvalue())

    def test_busy_codey_terminal_or_foreign_task_fails_before_any_write(self):
        for options in ({"idle": False}, {"inside": True}, {"task_error": True}):
            with self.subTest(options=options), tempfile.TemporaryDirectory() as directory:
                fixture = self.fixture(Path(directory))
                before = resume.snapshot(fixture.home)
                env, task, probe, _output = self.environment(fixture, **options)
                with env, self.assertRaises(repair.Error):
                    repair.repair(fixture.repair_args)
                self.assertEqual(resume.snapshot(fixture.home), before)
                self.assertEqual(task.call_count, 1)
                probe.assert_not_called()

    def test_unknown_running_session_response_never_means_idle(self):
        for body in ({}, {"success": True}, {"success": True, "data": {"sessions": {}}},
                     {"success": False, "data": {"sessions": []}}):
            with patch.object(repair, "workspace_get", return_value=body), self.assertRaises(repair.Error):
                repair.require_idle({}, {})

    def test_identity_or_non_codex_input_tampering_never_bypasses_pins(self):
        for kind in ("owner", "computer", "ready", "enrollment", "tunnel", "runtime-pin"):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as directory:
                fixture = self.fixture(Path(directory))
                if kind in ("owner", "computer", "ready"):
                    file = fixture.config_root / "installation.json"
                    record = json.loads(file.read_text())
                    record[{"owner": "ownerSid", "computer": "computerName", "ready": "ready"}[kind]] = False
                    file.write_text(json.dumps(record))
                elif kind in ("enrollment", "tunnel"):
                    file = fixture.config_root / (kind + ".json")
                    record = json.loads(file.read_text())
                    record["nodeId" if kind == "enrollment" else "tunnelId"] = "foreign"
                    file.write_text(json.dumps(record))
                else:
                    (fixture.root / "bin/windows-tunnel-service.py").write_text("tampered")
                before = resume.snapshot(fixture.home)
                env, task, probe, _output = self.environment(fixture)
                with env, self.assertRaises((repair.Error, RuntimeError, AttributeError)):
                    repair.repair(fixture.repair_args)
                self.assertEqual(resume.snapshot(fixture.home), before)
                task.assert_not_called()
                probe.assert_not_called()

    def test_failed_native_probe_leaves_existing_tasks_and_config_unchanged(self):
        with tempfile.TemporaryDirectory() as directory:
            fixture = self.fixture(Path(directory))
            before = {name: (fixture.config_root / name).read_bytes() for name in ("runtime.json", "installation.json")}
            env, task, probe, _output = self.environment(fixture)
            probe.side_effect = repair.Error("native fixture rejected")
            with env, self.assertRaisesRegex(repair.Error, "native fixture"):
                repair.repair(fixture.repair_args)
            self.assertEqual(task.call_count, 1)
            for name, value in before.items():
                self.assertEqual((fixture.config_root / name).read_bytes(), value)

    def test_resume_after_cache_disappears_uses_original_verified_private_bundle(self):
        with tempfile.TemporaryDirectory() as directory:
            builder = resume.ResumeTests()
            fixture = builder.fixture(Path(directory))
            state_file = fixture.config_root / "installation.json"
            state = json.loads(state_file.read_text())
            pinned = native.pin(fixture.args.codex_executable, fixture.root, ID, apply=True)
            state.update(nativeCodex=pinned, codexExecutable=pinned["executable"])
            state_file.write_text(json.dumps(state))
            Path(fixture.args.codex_executable).unlink()
            with builder.environment(fixture):
                resume.installer.configure(fixture.args)
            config = json.loads((fixture.config_root / "runtime.json").read_text())
            self.assertEqual(config["codexExe"], pinned["executable"])
            self.assertEqual(config["name"], "Test Windows")


if __name__ == "__main__":
    unittest.main()
