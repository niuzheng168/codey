import importlib.util
import hashlib
import io
import json
import os
from pathlib import Path
from types import SimpleNamespace
import tarfile
import tempfile
import time
import unittest
import zipfile
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, ROOT / file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


network = load("machine_network", "skills/config-new-codey-machine/scripts/azure-vnet.py")
installer = load("machine_installer", "skills/config-new-codey-machine/scripts/configure-machine.py")
windows = load("machine_windows", "skills/config-new-codey-machine/scripts/configure-windows.py")
ID = "n-0123456789abcdef01234567"
VNET = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/test/providers/Microsoft.Network/virtualNetworks/node"


class NetworkTests(unittest.TestCase):
    def test_windows_azure_cli_uses_its_installed_python_without_shell_interpolation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            launcher = root / "wbin/az.cmd"
            launcher.parent.mkdir()
            launcher.write_text("fixture only")
            python = root / "python.exe"
            python.write_text("fixture only")
            with patch.object(network.sys, "platform", "win32"), \
                 patch.object(network.shutil, "which", return_value=str(launcher)):
                self.assertEqual(network.az_command(), [str(python), "-X", "utf8", "-I", "-B", "-m", "azure.cli"])

    def test_overlap_includes_existing_peers_not_just_portal_cidr(self):
        self.assertFalse(network.overlap(["172.16.0.0/16"], ["10.0.0.0/16"]))
        self.assertTrue(network.overlap(["172.16.0.0/16"], ["172.16.0.0/24"]))
        self.assertFalse(network.overlap(["172.18.0.0/16"], ["172.16.0.0/16"]))

    def test_subnet_allocator_does_not_change_or_overlap_an_existing_subnet(self):
        vnet = {"properties": {"addressSpace": {"addressPrefixes": ["172.16.0.0/16"]},
                              "subnets": [{"properties": {"addressPrefix": "172.16.0.0/24"}}]}}
        self.assertEqual(network.free_subnet(vnet), "172.16.1.0/28")
        vnet["properties"]["addressSpace"]["addressPrefixes"] = ["172.16.0.0/24"]
        with self.assertRaises(network.SetupError):
            network.free_subnet(vnet)

    def test_security_rule_priorities_do_not_override_corporate_rules(self):
        nsg = {"properties": {"securityRules": [
            {"name": "https", "properties": {"priority": 101, "direction": "Inbound", "protocol": "Tcp", "destinationPortRange": "443"}},
            {"name": "corpnet", "properties": {"priority": 103, "direction": "Inbound", "protocol": "*", "destinationPortRange": "*"}},
        ]}}
        self.assertEqual(network.rule_priorities(nsg, ID), [100, 102])
        nsg["properties"]["securityRules"].append({"name": "protected", "properties": {
            "priority": 100, "direction": "Inbound", "protocol": "Tcp", "destinationPortRange": "8443"}})
        with self.assertRaises(network.SetupError):
            network.rule_priorities(nsg, ID)

    def test_dynamic_pls_nat_ip_comes_from_its_nic_not_the_empty_pls_property(self):
        subnet = VNET + "/subnets/dedicated"
        pls = {"properties": {"ipConfigurations": [{"properties": {"privateIPAllocationMethod": "Dynamic"}}],
                              "networkInterfaces": [{"id": "owned-nat-nic"}]}}
        nic = {"properties": {"ipConfigurations": [{"properties": {
            "subnet": {"id": subnet}, "privateIPAddress": "172.16.1.5"}}]}}
        with patch.object(network, "arm", return_value=nic) as arm:
            self.assertEqual(network.private_link_nat_sources(pls, subnet), ["172.16.1.5/32"])
            arm.assert_called_once_with("owned-nat-nic")
        nic["properties"]["ipConfigurations"][0]["properties"]["subnet"]["id"] = VNET + "/subnets/other"
        with patch.object(network, "arm", return_value=nic), self.assertRaises(network.SetupError):
            network.private_link_nat_sources(pls, subnet)

    def test_shared_nsg_across_overlapping_vnets_is_rejected_before_writes(self):
        nsg = {"properties": {"subnets": [{"id": VNET.replace("/node", "/other") + "/subnets/default"}]}}
        with patch.object(network, "arm") as arm, self.assertRaises(network.SetupError):
            network.check_nsg_scope(nsg, VNET, "target-nic")
        arm.assert_not_called()
        network.check_nsg_scope({"properties": {"subnets": [{"id": VNET + "/subnets/default"}]}}, VNET, "target-nic")

    def test_resource_ids_cannot_be_urls_or_contain_path_traversal(self):
        with patch.object(network, "az") as az:
            for resource in ["https://example.test/", VNET + "/../../keys", VNET + "/subnets//other"]:
                with self.assertRaises(network.SetupError):
                    network.arm(resource)
            az.assert_not_called()

    def test_partial_state_cannot_be_reused_for_another_vm(self):
        with tempfile.TemporaryDirectory() as root:
            output = Path(root) / "network.json"
            output.with_suffix(".azure-state.json").write_text(json.dumps({
                "nodeId": ID, "vmResourceId": "different-vm", "resourcesCreated": [], "associationsAdded": [],
            }))
            with self.assertRaises(network.SetupError):
                network.Apply({"nodeId": ID, "vm": {"id": "intended-vm"}}, output)


class InstallerTests(unittest.TestCase):
    def test_enrollment_and_platform_are_required_and_never_generated_as_fallback(self):
        enrollment = {"schema": 1, "nodeId": ID, "principalId": "owner-test", "username": "alice",
                      "expiresAt": int(time.time() * 1000) + 60000, "portalOrigin": "https://codey.example.test",
                      "clientSigningKey": "a" * 43, "workspaceSsoKey": "b" * 43}
        manifest = {"schema": 1, "platform": "linux-x64", "node": "24.20.0", "bunBuildTool": "1.4.2",
                    "dependencyMode": "install-on-target",
                    "nodeDistribution": {"file": "node-v24.20.0-linux-x64.tar.xz",
                                         "url": "https://nodejs.org/dist/v24.20.0/node-v24.20.0-linux-x64.tar.xz",
                                         "sha256": "a" * 64},
                    "artifacts": [{"file": name, "sha256": "b" * 64, "size": 1}
                                  for name in ["cloudcli-source.tar.gz", "copilot-api-source.tar.gz"]]}
        identity = "\n".join(["24.20.0", "1.4.2", "a" * 64, "b" * 64, "b" * 64])
        manifest["releaseId"] = enrollment["releaseId"] = "machine-" + hashlib.sha256(identity.encode()).hexdigest()[:16]
        topology = {"schema": 1, "nodeId": ID, "networkMode": "private-link", "listenIp": "172.16.0.4", "privateIp": "10.0.2.5"}
        self.assertEqual(installer.validate_inputs(enrollment, manifest, topology)[0]["size"], 1)
        for changed in [{"expiresAt": 0}, {"clientSigningKey": "not-a-key"}, {"portalOrigin": "http://example.test"}, {"username": "../root"}]:
            with self.assertRaises(installer.SetupError):
                installer.validate_inputs({**enrollment, **changed}, manifest, topology)
        with self.assertRaises(installer.SetupError):
            installer.validate_inputs(enrollment, {**manifest, "platform": "win32-x64"}, topology)
        with self.assertRaises(installer.SetupError):
            installer.validate_inputs(enrollment, manifest, {**topology, "listenIp": "127.0.0.1"})
        with self.assertRaises(installer.SetupError):
            installer.validate_inputs(enrollment, {**manifest, "nodeDistribution": {
                **manifest["nodeDistribution"], "url": "https://untrusted.example/node.tar.xz"}}, topology)

    def test_archive_extraction_rejects_traversal_and_unknown_roots(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            for name in ["../outside", "/outside", "unexpected/file"]:
                archive = root / "runtime.tar.gz"
                with tarfile.open(archive, "w:gz") as output:
                    info = tarfile.TarInfo(name)
                    info.size = 1
                    output.addfile(info, io.BytesIO(b"x"))
                with self.assertRaises(installer.SetupError):
                    installer.unpack(archive, root / "destination")
            self.assertFalse((root / "outside").exists())

    def test_machine_file_has_no_signing_or_tls_private_keys(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            cert = root / "cert.pem"
            cert.write_text("public certificate")
            enrollment = {"nodeId": ID, "clientSigningKey": "private-client", "workspaceSsoKey": "private-sso"}
            topology = {"name": "vm", "region": "test", "privateIp": "10.0.2.5", "networkMode": "private-link", "vmResourceId": "test-vm"}
            with patch("sys.stdout", new_callable=io.StringIO):
                installer.emit_machine(enrollment, topology, cert, root / "machine.json")
            output = (root / "machine.json").read_text()
            self.assertNotIn("private-client", output)
            self.assertNotIn("private-sso", output)
            self.assertEqual(json.loads(output)["tlsCertificate"], "public certificate")


class WindowsInstallerTests(unittest.TestCase):
    def fixture(self, root):
        assets = root / "skill/assets"
        assets.mkdir(parents=True)
        enrollment = {"schema": 1, "nodeId": ID, "platform": "windows-x64",
                      "principalId": "fixture-owner", "username": "alice",
                      "expiresAt": int(time.time() * 1000) + 3600000, "portalOrigin": "https://codey.example.test",
                      "clientSigningKey": "a" * 43, "workspaceSsoKey": "b" * 43}
        artifacts = []
        for name in ("cloudcli-source.tar.gz", "copilot-api-source.tar.gz"):
            data = ("fixture only: " + name).encode()
            (assets / name).write_bytes(data)
            artifacts.append({"file": name, "size": len(data), "sha256": hashlib.sha256(data).hexdigest()})
        manifest = {
            "schema": 1, "platform": "windows-x64", "node": "24.20.0", "bunBuildTool": "1.4.2",
            "dependencyMode": "install-on-target", "artifacts": artifacts,
            "nodeDistribution": {"file": "node-v24.20.0-win-x64.zip",
                                 "url": "https://nodejs.org/dist/v24.20.0/node-v24.20.0-win-x64.zip",
                                 "sha256": "c" * 64},
        }
        value = "\n".join(["24.20.0", "1.4.2", "c" * 64] + [item["sha256"] for item in artifacts])
        enrollment["releaseId"] = manifest["releaseId"] = "machine-" + hashlib.sha256(value.encode()).hexdigest()[:16]
        topology = {"schema": 1, "nodeId": ID, "name": "windows-devbox", "region": "Japan East",
                    "networkMode": "same-vnet", "listenIp": "10.0.1.4", "privateIp": "10.0.1.4",
                    "allowedSources": ["10.0.2.0/24"], "vmResourceId": "descriptive-fixture"}
        for name, value in [("enrollment.json", enrollment), ("manifest.json", manifest)]:
            (assets / name).write_text(json.dumps(value), encoding="utf-8")
        network_file = root / "network.json"
        network_file.write_text(json.dumps(topology), encoding="utf-8")
        home = root / "home"
        home.mkdir()
        args = SimpleNamespace(enrollment=assets / "enrollment.json", network_file=network_file,
                               out=root / "machine.json", name=None, openssl=None, codex_executable=None,
                               apply=False, network_approved=False)
        return assets.parent, home, args, enrollment, manifest, topology

    def test_distinct_platforms_reject_each_others_enrollment_and_node_archive(self):
        with tempfile.TemporaryDirectory() as directory:
            _, _, _, enrollment, manifest, topology = self.fixture(Path(directory))
            self.assertEqual(len(installer.validate_inputs(enrollment, manifest, topology, "windows-x64")), 2)
            with self.assertRaises(installer.SetupError):
                installer.validate_inputs(enrollment, manifest, topology)
            with self.assertRaises(installer.SetupError):
                installer.validate_inputs({**enrollment, "platform": "linux-x64"}, manifest, topology, "windows-x64")
            with self.assertRaises(installer.SetupError):
                installer.validate_inputs(enrollment, {**manifest, "nodeDistribution": {
                    **manifest["nodeDistribution"], "file": "node-v24.20.0-linux-x64.tar.xz"}}, topology, "windows-x64")

    def test_windows_archive_traversal_drive_ads_reserved_names_links_and_case_collisions_are_rejected(self):
        for name in ("../out", "/out", "C:/out", "C:out", "a\\out", "a:stream", "CON", "a/NUL.txt",
                     "a/trailing.", "a/space ", "a/a?.txt", "a/a|.txt"):
            with self.subTest(name=name), self.assertRaises(windows.SetupError):
                windows.archive_name(name)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for entries in [
                ["node-win/README", "node-win/readme"], ["other-root/file"], ["node-win/../../out"],
            ]:
                archive = root / "node.zip"
                with zipfile.ZipFile(archive, "w") as output:
                    for name in entries:
                        output.writestr(name, "fixture")
                with self.assertRaises(windows.SetupError):
                    windows.extract_zip(archive, root / "target", "node-win")
            self.assertFalse((root / "out").exists())

    def test_windows_source_file_links_are_materialized_without_link_privilege_or_escape(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for target in ("AGENTS.md", "../outside", "C:/outside", "CLAUDE.md"):
                archive = root / "source.tar.gz"
                with tarfile.open(archive, "w:gz") as output:
                    item = tarfile.TarInfo("AGENTS.md")
                    item.size = 7
                    output.addfile(item, io.BytesIO(b"fixture"))
                    link = tarfile.TarInfo("CLAUDE.md")
                    link.type, link.linkname = tarfile.SYMTYPE, target
                    output.addfile(link)
                destination = root / ("valid" if target == "AGENTS.md" else "invalid")
                if target == "AGENTS.md":
                    windows.extract_source(archive, destination)
                    self.assertEqual((destination / "CLAUDE.md").read_text(), "fixture")
                    self.assertFalse((destination / "CLAUDE.md").is_symlink())
                else:
                    with self.assertRaises(windows.SetupError):
                        windows.extract_source(archive, destination)
            self.assertFalse((root / "outside").exists())

    @unittest.skipUnless(os.name == "nt", "Native Windows path planning is verified on Windows")
    def test_windows_plan_only_reads_inputs_and_never_installs_runs_or_changes_firewall(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            skill, home, args, _, _, _ = self.fixture(root)
            context = {"sid": "owner-test", "elevated": False, "sessionId": 1}
            before = sorted(str(file.relative_to(root)) for file in root.rglob("*"))
            with patch.object(windows.os, "name", "nt"), patch.object(windows.platform, "machine", return_value="AMD64"), \
                 patch.object(windows.service, "owner_context", return_value=context), \
                 patch.object(windows, "SKILL", skill), patch.object(windows.Path, "home", return_value=home), \
                 patch.object(windows, "port_conflicts", return_value=["127.0.0.1:4141"]), \
                 patch.object(windows, "command") as command, patch.object(windows, "runtime") as runtime, \
                 patch("sys.stdout", new_callable=io.StringIO) as output:
                windows.configure(args)
                report = json.loads(output.getvalue())
            self.assertEqual(report["portConflicts"], ["127.0.0.1:4141"])
            self.assertEqual(report["updater"], "unsupported; no Linux updater is installed")
            self.assertFalse(report["firewallChanged"])
            self.assertTrue(report["logonOnly"])
            command.assert_not_called()
            runtime.assert_not_called()
            self.assertEqual(sorted(str(file.relative_to(root)) for file in root.rglob("*")), before)

    def test_windows_apply_requires_explicit_network_confirmation_before_any_file_or_process_change(self):
        args = SimpleNamespace(apply=True, network_approved=False)
        with patch.object(windows.os, "name", "nt"), patch.object(windows.platform, "machine", return_value="AMD64"), \
             patch.object(windows.service, "owner_context", return_value={"sid": "owner", "elevated": False, "sessionId": 1}), \
             patch.object(windows, "command") as command, patch.object(windows, "runtime") as runtime:
            with self.assertRaisesRegex(windows.SetupError, "network-approved"):
                windows.configure(args)
        command.assert_not_called()
        runtime.assert_not_called()

    @unittest.skipUnless(os.name == "nt", "Native Windows transaction paths are verified on Windows")
    def test_mocked_windows_install_preserves_codex_home_and_only_marks_ready_after_successful_export(self):
        for export_fails in (False, True):
            with self.subTest(export_fails=export_fails), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                skill, home, args, _, _, _ = self.fixture(root)
                tools = root / "tools"
                tools.mkdir()
                for name in ("python.exe", "pythonw.exe", "openssl.exe", "codex.exe"):
                    (tools / name).write_bytes(b"test stub, never executed")
                codex_home = root / "existing-codex-home"
                codex_home.mkdir()
                original = codex_home / "config.toml"
                original.write_text("original owner configuration")
                args.apply = args.network_approved = True
                args.openssl, args.codex_executable = str(tools / "openssl.exe"), str(tools / "codex.exe")
                context = {"sid": "test-owner", "elevated": False, "sessionId": 1}
                commands = []

                def fake_runtime(_manifest, _enrollment, _root, stage, _log):
                    for name in ("node/node.exe", "copilot-api/dist/main.js", "cloudcli/dist-server/server/index.js"):
                        file = stage / name
                        file.parent.mkdir(parents=True, exist_ok=True)
                        file.write_bytes(b"test stub, never executed")

                def fake_command(arguments, **_kwargs):
                    values = [str(value) for value in arguments]
                    commands.append(values)
                    if values[0] == args.openssl:
                        Path(values[values.index("-out") + 1]).write_text("test public certificate")
                        Path(values[values.index("-keyout") + 1]).write_text("test private key")

                export = windows.machine_file
                with patch.object(windows.service, "owner_context", return_value=context), \
                     patch.object(windows, "SKILL", skill), patch.object(windows.Path, "home", return_value=home), \
                     patch.object(windows.sys, "executable", str(tools / "python.exe")), \
                     patch.dict(os.environ, {"CODEX_HOME": str(codex_home)}), \
                     patch.object(windows, "port_conflicts", return_value=[]), \
                     patch.object(windows.shutil, "disk_usage", return_value=SimpleNamespace(free=16 * 1024 ** 3)), \
                     patch.object(windows, "runtime", side_effect=fake_runtime), \
                     patch.object(windows, "command", side_effect=fake_command), \
                     patch.object(windows.common, "verify") as verify, \
                     patch.object(windows, "machine_file", side_effect=OSError("test output failure") if export_fails else export), \
                     patch("sys.stdout", new_callable=io.StringIO) as output:
                    if export_fails:
                        with self.assertRaisesRegex(OSError, "test output failure"):
                            windows.configure(args)
                        self.assertEqual(output.getvalue(), "")
                    else:
                        windows.configure(args)
                        self.assertTrue(json.loads(output.getvalue())["ok"])
                config = home / ".config/codey-machine-windows"
                state = json.loads((config / "installation.json").read_text())
                runtime = json.loads((config / "runtime.json").read_text())
                self.assertEqual(state["ready"], not export_fails)
                self.assertEqual(runtime["environment"]["CODEX_HOME"], str(codex_home))
                self.assertEqual(original.read_text(), "original owner configuration")
                verify.assert_called_once()
                task_commands = [call for call in commands if "-Operation" in call]
                self.assertEqual([call[-1] for call in task_commands], ["Install", "RemoveCreated"] if export_fails else ["Install"])
                for call in task_commands:
                    self.assertEqual(call[call.index("-ConfigPath") + 1], str(config / "runtime.json"))

    def test_gateway_source_ranges_and_computed_paths_are_bounded(self):
        self.assertEqual(windows.approved_sources({"allowedSources": ["10.0.0.0/24"]}), ["10.0.0.0/24"])
        for sources in ([], ["0.0.0.0/0"], ["*"], ["169.254.169.254/32"], ["::/0"], ["8.8.8.8/32"]):
            with self.assertRaises((windows.SetupError, ValueError, TypeError)):
                windows.approved_sources({"allowedSources": sources})
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaises(windows.SetupError):
                windows.within(root / "../outside", root)
            self.assertEqual(windows.within(root / "release", root), root / "release")

    def test_supervisor_refuses_foreign_owner_elevation_no_login_and_unpinned_runtime(self):
        for context in [
            {"sid": "someone-else", "elevated": False, "sessionId": 1},
            {"sid": "owner", "elevated": True, "sessionId": 1},
            {"sid": "owner", "elevated": False, "sessionId": 0},
        ]:
            with self.assertRaisesRegex(RuntimeError, "original_logged_on"):
                windows.service.validate({"schema": 1, "ownerSid": "owner"}, "workspace", context)
        script = (ROOT / "skills/config-new-codey-machine/scripts/windows-tasks.ps1").read_text()
        self.assertIn("LogonType = 3", script)
        self.assertIn("RunLevel = 0", script)
        self.assertIn("Triggers.Create(9)", script)
        for forbidden in ("ExecutionPolicy", "RunAs", "New-NetFirewallRule", "Triggers.Create(8)", "Codey Local Copilot API"):
            self.assertNotIn(forbidden, script)

    def test_windows_machine_export_has_platform_but_no_node_or_tls_private_keys(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            _, _, _, enrollment, _, topology = self.fixture(root)
            cert = root / "public.pem"
            cert.write_text("public certificate")
            with patch("sys.stdout", new_callable=io.StringIO) as output:
                report = windows.machine_file(enrollment, topology, cert, root / "machine.json", "windows-devbox")
            self.assertEqual(output.getvalue(), "", "Do not announce success before installation state is saved")
            self.assertTrue(report["logonOnly"])
            self.assertFalse(report["firewallChanged"])
            text = (root / "machine.json").read_text()
            self.assertEqual(json.loads(text)["platform"], "windows-x64")
            self.assertNotIn(enrollment["clientSigningKey"], text)
            self.assertNotIn(enrollment["workspaceSsoKey"], text)


if __name__ == "__main__":
    unittest.main()
