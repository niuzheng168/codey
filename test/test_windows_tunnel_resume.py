"""Resume the exact pre-task CLI-format failure without rebuilding or adopting services."""
from contextlib import contextmanager, ExitStack, redirect_stdout
import hashlib
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
import zipfile

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("windows_tunnel_fixtures", Path(__file__).with_name("test_windows_tunnel.py"))
fixtures = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixtures)
installer, client, ID = fixtures.installer, fixtures.client, fixtures.ID
TUNNEL = "codey-" + ID
BINDING = {"tunnelId": TUNNEL, "clusterId": "jpe1"}


def snapshot(root):
    return {str(file.relative_to(root)): file.read_bytes() for file in root.rglob("*") if file.is_file()}


class CliFormatTests(unittest.TestCase):
    def test_both_cli_shapes_normalize_without_modifying_the_input(self):
        for wrapped in (False, True):
            for record in [
                {**BINDING}, {"tunnelId": TUNNEL + ".jpe1"},
                {"tunnelId": TUNNEL + ".jpe1", "clusterId": "jpe1"},
            ]:
                record["description"] = "Codey Windows " + ID
                value = {"tunnel": record} if wrapped else record
                original = json.dumps(value)
                actual = client.normalize_tunnel(value)
                self.assertEqual(actual["tunnelId"], TUNNEL)
                self.assertEqual(actual["clusterId"], "jpe1")
                self.assertEqual(json.dumps(value), original)

    def test_ambiguous_or_malformed_coordinates_never_default_to_a_cluster(self):
        for value in [
            None, [], {"tunnel": None}, {"tunnelId": TUNNEL},
            {"tunnelId": TUNNEL + ".jpe1", "clusterId": "usw2"},
            {"tunnelId": TUNNEL + ".jpe1", "clusterId": None},
            {"tunnelId": TUNNEL + ".jpe1.extra"}, {"tunnelId": TUNNEL + "."},
            {"tunnelId": "https://" + TUNNEL + ".jpe1"},
            {"tunnelId": TUNNEL + ".jpe1/path"}, {"tunnelId": TUNNEL + ".JPE1"},
            {"tunnelId": TUNNEL + ".jpe1 "}, {"tunnelId": TUNNEL + ".jpe1\n"},
            {"tunnelId": TUNNEL + "\\jpe1"}, {"tunnelId": True, "clusterId": "jpe1"},
        ]:
            with self.subTest(value=value), self.assertRaises(client.TunnelError):
                client.normalize_tunnel(value)

    def test_legacy_requested_only_journal_resumes_same_qualified_tunnel_and_only_missing_ports(self):
        with tempfile.TemporaryDirectory() as directory:
            journal = Path(directory) / "tunnel.json"
            journal.write_text(json.dumps({"requested": TUNNEL}))
            before = journal.read_bytes()
            calls = []
            record = {"tunnelId": TUNNEL + ".jpe1", "description": "Codey Windows " + ID,
                      "ports": [{"portNumber": 3001, "protocol": "https"}]}

            def runner(argv, **_kwargs):
                calls.append(argv[1:])
                self.assertNotEqual(argv[1], "create")
                self.assertNotIn("--allow-anonymous", argv)
                return SimpleNamespace(returncode=0, stdout=json.dumps({"tunnel": record}))

            result = client.ensure_tunnel("devtunnel.exe", fixtures.invitation(), directory, runner=runner,
                                          reuse_only=True, inspect_only=True)
            self.assertEqual(result, BINDING)
            self.assertEqual(journal.read_bytes(), before, "A resume plan must not modify even the tunnel journal")
            self.assertEqual(calls, [["show", TUNNEL, "--json"]])
            result = client.ensure_tunnel("devtunnel.exe", fixtures.invitation(), directory, runner=runner,
                                          reuse_only=True, expected_binding=BINDING)
            self.assertEqual(result, BINDING)
            self.assertEqual(calls[-1], ["port", "create", TUNNEL + ".jpe1", "--port-number", "8443",
                                         "--protocol", "https", "--json"])
            self.assertEqual(json.loads(journal.read_text()), {"requested": TUNNEL, "qualifiedId": TUNNEL + ".jpe1", **BINDING})
            record["ports"].append({"portNumber": 8443, "protocol": "https"})
            client.ensure_tunnel("devtunnel.exe", fixtures.invitation(), directory, runner=runner, reuse_only=True)
            self.assertEqual(calls[-1], ["show", TUNNEL + ".jpe1", "--json"])

    def test_binding_owner_cluster_and_port_rejections_do_not_rewrite_a_journal_or_create_resources(self):
        for changes in [
            {"tunnelId": "codey-n-" + "f" * 24 + ".jpe1"},
            {"tunnelId": TUNNEL + ".usw2"}, {"description": "Another installation"},
            {"clusterId": "usw2"}, {"ports": [{"portNumber": 22, "protocol": "https"}]},
            {"ports": [{"portNumber": 3001, "protocol": "http"}]},
            {"ports": [{"portNumber": 3001, "protocol": "https"}] * 2},
            {"ports": [None]}, {"ports": {}}, {"ports": [{"portNumber": "3001", "protocol": "https"}]},
        ]:
            with self.subTest(changes=changes), tempfile.TemporaryDirectory() as directory:
                journal = Path(directory) / "tunnel.json"
                journal.write_text(json.dumps({"requested": TUNNEL, "qualifiedId": TUNNEL + ".jpe1", **BINDING}))
                before, calls = journal.read_bytes(), []

                def runner(argv, **_kwargs):
                    calls.append(argv[1:])
                    return SimpleNamespace(returncode=0, stdout=json.dumps({"tunnel": {
                        "tunnelId": TUNNEL + ".jpe1", "description": "Codey Windows " + ID, "ports": [], **changes,
                    }}))

                with self.assertRaises(client.TunnelError):
                    client.ensure_tunnel("devtunnel.exe", fixtures.invitation(), directory, runner=runner, reuse_only=True)
                self.assertEqual(calls, [["show", TUNNEL + ".jpe1", "--json"]])
                self.assertEqual(journal.read_bytes(), before)
        with tempfile.TemporaryDirectory() as directory, patch.object(client, "cli") as cli:
            with self.assertRaisesRegex(client.TunnelError, "existing_tunnel_journal"):
                client.ensure_tunnel("devtunnel.exe", fixtures.invitation(), directory, reuse_only=True)
            cli.assert_not_called()
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_live_host_metrics_normalize_both_formats_and_reject_other_clusters(self):
        config = {**BINDING, "devtunnelExe": "devtunnel.exe"}
        for record, expected in [
            ({**BINDING, "hostConnections": 0}, 0),
            ({"tunnelId": TUNNEL + ".jpe1", "hostConnections": 1}, 1),
            ({"tunnelId": TUNNEL + ".usw2", "hostConnections": 0}, None),
            ({"tunnelId": "other-node.jpe1", "hostConnections": 0}, None),
            ({"tunnelId": TUNNEL + ".jpe1", "hostConnections": "0"}, None),
            ({"tunnelId": TUNNEL, "hostConnections": 0}, None),
        ]:
            for wrapped in (False, True):
                with self.subTest(record=record, wrapped=wrapped), patch.object(client, "cli", return_value=SimpleNamespace(
                        stdout=json.dumps({"tunnel": record} if wrapped else record))):
                    self.assertEqual(client.host_connections(config), expected)


@unittest.skipUnless(os.name == "nt", "Native Windows pre-task resume transaction")
class ResumeTests(unittest.TestCase):
    def fixture(self, root):
        home, skill, codex_home, args = fixtures.WindowsTunnelTests.install_fixture(self, root)
        node_root, config_root = home / ".local/share/codey-machine-windows" / ID, home / ".config/codey-machine-windows" / ID
        node_root.mkdir(parents=True)
        config_root.mkdir(parents=True)
        manifest = json.loads((skill / "assets/manifest.json").read_text())
        archive = node_root / manifest["nodeDistribution"]["file"]
        executable = b"fixture Node executable; never executed"
        with zipfile.ZipFile(archive, "w") as package:
            package.writestr(manifest["nodeDistribution"]["file"].removesuffix(".zip") + "/node.exe", executable)
        manifest["nodeDistribution"]["sha256"] = client.digest(archive)
        identity = "\n".join([manifest["node"], manifest["bunBuildTool"], manifest["nodeDistribution"]["sha256"]]
                             + [row["sha256"] for row in manifest["artifacts"]])
        manifest["releaseId"] = "machine-" + hashlib.sha256(identity.encode()).hexdigest()[:16]
        enrollment = json.loads(Path(args.enrollment).read_text())
        enrollment["releaseId"] = manifest["releaseId"]
        Path(args.enrollment).write_text(json.dumps(enrollment))
        (skill / "assets/manifest.json").write_text(json.dumps(manifest))
        release = node_root / "releases" / manifest["releaseId"]
        for name in ("node/node.exe", "cloudcli/dist-server/server/index.js", "portal-node/node-relay/server.mjs",
                     "cloudcli/package.json", "cloudcli/package-lock.json",
                     "cloudcli/node_modules/better-sqlite3/package.json", "cloudcli/node_modules/node-pty/package.json"):
            file = release / name
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_bytes(executable if name == "node/node.exe" else b"{}")
        (release / "release.json").write_text(json.dumps(manifest))
        proof = {"pid": 12345, "ownerSid": "test-owner", "executable": "protected-node.exe",
                 "startedUtc": "original start", "mentionsCopilotApi": True}
        state = {"ready": False, "platform": "windows-x64", "mode": "private-devtunnel-existing-model",
                 "nodeId": ID, "releaseId": manifest["releaseId"], "ownerSid": "test-owner",
                 "computerName": os.environ.get("COMPUTERNAME"), "protectedModelProcess": proof,
                 "codexHome": str(codex_home), "codexExecutable": args.codex_executable, "opensslExecutable": args.openssl}
        # This intentionally matches the older installer: no stored display name
        # or canonical cluster; build/TLS/enrollment exist but runtime/tasks do not.
        (config_root / "installation.json").write_text(json.dumps(state))
        (config_root / "enrollment.json").write_text(json.dumps(enrollment))
        (config_root / "ticket.key").write_text(enrollment["clientSigningKey"])
        (config_root / "node-cert.pem").write_text("original public certificate fixture")
        (config_root / "node-key.pem").write_text("original private key fixture")
        (config_root / "tunnel.json").write_text(json.dumps({"requested": TUNNEL}))
        args.resume = True
        return SimpleNamespace(home=home, skill=skill, codex_home=codex_home, args=args, root=node_root,
                               config_root=config_root, release=release, archive=archive, manifest=manifest, proof=proof)

    @contextmanager
    def environment(self, fixture, *, tasks_exist=False, tunnel_record=None):
        commands, calls = [], []
        ports = []
        output = io.StringIO()

        def cli(_executable, argv, **_kwargs):
            calls.append(argv)
            if argv[0] == "show":
                record = {"tunnelId": TUNNEL + ".jpe1", "description": "Codey Windows " + ID, "ports": list(ports)}
                return SimpleNamespace(returncode=0, stdout=json.dumps({"tunnel": record if tunnel_record is None else tunnel_record}))
            self.assertEqual(argv[:2], ["port", "create"], "A resume must never allocate another tunnel")
            ports.append({"portNumber": int(argv[argv.index("--port-number") + 1]), "protocol": "https"})
            return SimpleNamespace(returncode=0, stdout="{}")

        def command(argv, **_kwargs):
            values = [str(item) for item in argv]
            commands.append(values)
            self.assertNotIn("req", values, "Do not regenerate the certificate or private key")
            self.assertNotIn("npm", values)
            return SimpleNamespace(returncode=0, stdout="{}")

        with ExitStack() as stack:
            stack.enter_context(patch.object(installer, "SKILL", fixture.skill))
            stack.enter_context(patch.object(installer.Path, "home", return_value=fixture.home))
            stack.enter_context(patch.dict(os.environ, {"CODEX_HOME": str(fixture.codex_home)}))
            stack.enter_context(patch.object(installer.windows.service, "owner_context",
                                            return_value={"sid": "test-owner", "sessionId": 1, "elevated": False}))
            stack.enter_context(patch.object(installer, "gateway_proof", return_value=fixture.proof))
            stack.enter_context(patch.object(installer, "free_ports", return_value=[]))
            stack.enter_context(patch.object(installer, "verify_usage", return_value={"usage": False, "tokenUsage": True}))
            stack.enter_context(patch.object(installer, "check_resume_owner_and_tasks",
                side_effect=installer.Error("existing_tasks_fixture") if tasks_exist else None))
            stack.enter_context(patch.object(installer, "prepare_devtunnel", return_value=Path(fixture.args.devtunnel_executable)))
            stack.enter_context(patch.object(installer, "verify_resume_tls"))
            stack.enter_context(patch.object(installer, "run", side_effect=command))
            stack.enter_context(patch.object(installer.tunnel, "cli", side_effect=cli))
            stack.enter_context(patch.object(installer.tunnel, "renew", return_value={"ok": True}))
            stack.enter_context(patch.object(installer.windows.common, "verify", return_value={"usage": False, "tokenUsage": True}))
            for name in ("download", "build_runtime"):
                stack.enter_context(patch.object(installer, name, side_effect=AssertionError("Resume must not " + name)))
            stack.enter_context(patch.object(installer.windows, "private_directory",
                                            side_effect=AssertionError("Resume must not recreate installation directories")))
            stack.enter_context(redirect_stdout(output))
            yield output, commands, calls

    def test_plan_reuses_every_input_but_makes_no_local_or_tunnel_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            fixture = self.fixture(Path(directory))
            fixture.args.apply = False
            before = snapshot(fixture.home)
            with self.environment(fixture) as (output, commands, calls):
                installer.configure(fixture.args)
            result = json.loads(output.getvalue())
            self.assertTrue(result["resume"] and result["builtRuntimeReused"])
            self.assertFalse(result["buildCommandsRun"] or result["newTunnelCreated"])
            self.assertEqual(result["existingTunnel"], BINDING)
            self.assertEqual(snapshot(fixture.home), before)
            self.assertEqual(calls, [["show", TUNNEL, "--json"]])
            self.assertTrue(all("-Operation" not in row for row in commands))

    def test_apply_uses_same_identity_tunnel_keys_and_built_runtime_then_successful_rerun_is_verification_only(self):
        with tempfile.TemporaryDirectory() as directory:
            fixture = self.fixture(Path(directory))
            before = snapshot(fixture.home)
            with self.environment(fixture) as (output, commands, calls):
                installer.configure(fixture.args)
            result = json.loads(output.getvalue())
            self.assertTrue(result["resumed"] and result["builtRuntimeReused"])
            self.assertFalse(result["newTunnelCreated"])
            for name, data in before.items():
                if Path(name).name not in ("installation.json", "tunnel.json"):
                    self.assertEqual((fixture.home / name).read_bytes(), data, name)
            self.assertEqual([row[-1] for row in commands if "-Operation" in row], ["Install"])
            self.assertEqual([row[:2] for row in calls], [["show", TUNNEL], ["show", TUNNEL], ["port", "create"], ["port", "create"]])
            self.assertTrue(json.loads((fixture.config_root / "installation.json").read_text())["ready"])
            self.assertEqual(len(list(fixture.config_root.glob("installation.before-resume-*.json"))), 1)
            activation = json.loads(Path(fixture.args.out).read_text())
            self.assertEqual(activation["nodeId"], ID)
            self.assertEqual(activation["devTunnel"], BINDING)
            for secret in ("A" * 43, "B" * 43, "C" * 43, "original private key fixture"):
                self.assertNotIn(secret, Path(fixture.args.out).read_text())
            after = snapshot(fixture.home)
            with self.environment(fixture) as (output, commands, calls):
                installer.configure(fixture.args)
            self.assertTrue(json.loads(output.getvalue())["alreadyConfigured"])
            self.assertEqual(calls, [])
            self.assertEqual(commands, [])
            self.assertEqual(snapshot(fixture.home), after)

    def test_resume_rejects_wrong_identity_incomplete_or_tampered_runtime_and_later_installation_stages_before_writes(self):
        for kind in ("owner", "release", "credential", "receipt", "node", "archive", "missing_library", "runtime", "bin", "activation"):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as directory:
                fixture = self.fixture(Path(directory))
                if kind in ("owner", "release"):
                    file = fixture.config_root / "installation.json"
                    state = json.loads(file.read_text())
                    state["ownerSid" if kind == "owner" else "releaseId"] = "different"
                    file.write_text(json.dumps(state))
                elif kind == "credential":
                    file = Path(fixture.args.enrollment)
                    enrollment = json.loads(file.read_text())
                    enrollment["clientSigningKey"] = "D" * 43
                    file.write_text(json.dumps(enrollment))
                elif kind == "receipt":
                    (fixture.release / "release.json").write_text("{}")
                elif kind == "node":
                    (fixture.release / "node/node.exe").write_bytes(b"unreviewed executable")
                elif kind == "archive":
                    fixture.archive.write_bytes(b"not the pinned Node archive")
                elif kind == "missing_library":
                    (fixture.release / "cloudcli/node_modules/node-pty/package.json").unlink()
                elif kind == "runtime":
                    (fixture.config_root / "runtime.json").write_text("{}")
                elif kind == "bin":
                    (fixture.root / "bin").mkdir()
                else:
                    Path(fixture.args.out).parent.mkdir()
                    Path(fixture.args.out).write_text("{}")
                before = snapshot(fixture.home)
                with self.environment(fixture) as (_output, commands, calls):
                    with self.assertRaises(installer.Error):
                        installer.configure(fixture.args)
                self.assertEqual(snapshot(fixture.home), before)
                self.assertEqual(calls, [])
                self.assertFalse(any("-Operation" in row for row in commands))

    def test_existing_tasks_wrong_tunnel_and_missing_journal_cannot_be_adopted(self):
        for kind in ("tasks", "foreign-tunnel", "missing-journal"):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as directory:
                fixture = self.fixture(Path(directory))
                if kind == "missing-journal":
                    (fixture.config_root / "tunnel.json").unlink()
                record = {"tunnelId": "other-node.jpe1", "description": "Codey Windows " + ID, "ports": []}
                before = snapshot(fixture.home)
                with self.environment(fixture, tasks_exist=kind == "tasks",
                                      tunnel_record=record if kind == "foreign-tunnel" else None) as (_out, commands, calls):
                    with self.assertRaises((installer.Error, installer.tunnel.TunnelError)):
                        installer.configure(fixture.args)
                self.assertEqual(snapshot(fixture.home), before)
                self.assertFalse(any(row[0] != "show" for row in calls))
                self.assertFalse(any("-Operation" in row for row in commands))

    def test_local_recovery_package_refuses_fresh_mode_or_a_different_node_before_any_action(self):
        for wrong_node in (False, True):
            with self.subTest(wrong_node=wrong_node), tempfile.TemporaryDirectory() as directory:
                fixture = self.fixture(Path(directory))
                marker = {"schema": 1, "kind": "windows-pre-task-resume",
                          "nodeId": "n-" + "f" * 24 if wrong_node else ID,
                          "releaseId": fixture.manifest["releaseId"], "expectedComputerName": os.environ["COMPUTERNAME"]}
                (fixture.skill / "LOCAL-RESUME.json").write_text(json.dumps(marker))
                fixture.args.resume = wrong_node
                before = snapshot(fixture.home)
                with self.environment(fixture) as (_output, commands, calls):
                    with self.assertRaisesRegex(installer.Error, "identity_mismatch" if wrong_node else "requires_Resume"):
                        installer.configure(fixture.args)
                self.assertEqual(snapshot(fixture.home), before)
                self.assertEqual(commands, [])
                self.assertEqual(calls, [])

    def test_real_tls_resume_check_preserves_leaf_and_key_and_rejects_another_identity_or_key(self):
        openssl = Path(os.environ.get("ProgramFiles", "C:/Program Files")) / "Git/usr/bin/openssl.exe"
        if not openssl.is_file():
            self.skipTest("Native Git OpenSSL is unavailable")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            self.assertTrue(root.is_relative_to(Path(tempfile.gettempdir()).resolve()))
            cert, key = root / "cert.pem", root / "key.pem"
            result = subprocess.run([str(openssl), "req", "-x509", "-newkey", "rsa:2048", "-noenc", "-days", "1",
                "-keyout", str(key), "-out", str(cert), "-subj", "/CN=" + ID + ".nodes.codey.internal",
                "-addext", "subjectAltName=DNS:" + ID + ".nodes.codey.internal",
                "-addext", "basicConstraints=critical,CA:FALSE"], capture_output=True, stdin=subprocess.DEVNULL,
                timeout=30, creationflags=installer.worker.CREATE_NO_WINDOW)
            self.assertEqual(result.returncode, 0)
            before = snapshot(root)
            installer.verify_resume_tls(openssl, cert, key, ID)
            self.assertEqual(snapshot(root), before)
            with self.assertRaisesRegex(installer.Error, "existing_node_leaf"):
                installer.verify_resume_tls(openssl, cert, key, "n-" + "f" * 24)
            result = subprocess.run([str(openssl), "genpkey", "-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:2048",
                                     "-out", str(root / "other.key")], capture_output=True, stdin=subprocess.DEVNULL,
                                    timeout=30, creationflags=installer.worker.CREATE_NO_WINDOW)
            self.assertEqual(result.returncode, 0)
            with self.assertRaisesRegex(installer.Error, "do_not_match"):
                installer.verify_resume_tls(openssl, cert, root / "other.key", ID)

    def test_real_owner_acl_and_task_probe_are_read_only_and_do_not_manage_existing_services(self):
        with tempfile.TemporaryDirectory() as directory:
            parent = Path(directory).resolve()
            self.assertTrue(parent.is_relative_to(Path(tempfile.gettempdir()).resolve()))
            root, config_root = parent / "runtime", parent / "config"
            context = installer.windows.service.owner_context()
            installer.windows.private_directory(root, context["sid"])
            installer.windows.private_directory(config_root, context["sid"])
            before = snapshot(parent)
            installer.check_resume_owner_and_tasks(root, config_root, ID, context["sid"])
            self.assertEqual(snapshot(parent), before)
            with self.assertRaisesRegex(installer.Error, "owner_only"):
                installer.check_resume_owner_and_tasks(root, config_root, ID, "S-1-5-21-1-2-3-9999")
            # A recognized OWNER RIGHTS ACE must not make unrelated principals
            # acceptable. This is only an empty, newly created fixture directory.
            installer.windows.command([Path(os.environ["WINDIR"]) / "System32/icacls.exe",
                                       root, "/grant", "*S-1-1-0:(R)"])
            with self.assertRaisesRegex(installer.Error, "owner_only"):
                installer.check_resume_owner_and_tasks(root, config_root, ID, context["sid"])


if __name__ == "__main__":
    unittest.main()
