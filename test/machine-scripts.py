import importlib.util
import hashlib
import io
import json
from pathlib import Path
import tarfile
import tempfile
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, ROOT / file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


network = load("machine_network", "skills/config-new-codey-machine/scripts/azure-vnet.py")
installer = load("machine_installer", "skills/config-new-codey-machine/scripts/configure-machine.py")
ID = "n-0123456789abcdef01234567"
VNET = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/test/providers/Microsoft.Network/virtualNetworks/node"


class NetworkTests(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
