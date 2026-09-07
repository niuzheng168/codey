#!/usr/bin/env python3
"""Plan/apply a node-scoped Azure private path without changing existing routes."""
import argparse
import ipaddress
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time
import urllib.request

NETWORK_API = "2024-05-01"
VM_API = "2024-07-01"
RESOURCE = re.compile(r"^/subscriptions/[a-f0-9-]{36}/resourceGroups/[a-z0-9_.()-]{1,90}/providers/Microsoft\.(?:Network|Compute)/[a-zA-Z0-9_./()-]+$", re.I)
NODE_ID = re.compile(r"^n-[a-f0-9]{24}$")
PORTS = ["8443", "3001"]
PROBE_SOURCE = "168.63.129.16/32"  # Azure platform load-balancer health probes.


class SetupError(RuntimeError):
    pass


def az(*args, missing=False):
    result = subprocess.run(["az", *map(str, args), "--only-show-errors", "-o", "json"],
                            text=True, capture_output=True)
    if result.returncode:
        if missing and any(code in result.stderr for code in ("ResourceNotFound", "NotFound", "ResourceGroupNotFound")):
            return None
        raise SetupError(f"Azure command failed ({' '.join(map(str, args[:3]))}): {result.stderr.strip()[:1800]}")
    return json.loads(result.stdout) if result.stdout.strip() else {}


def arm(resource, method="get", body=None, missing=False):
    if not RESOURCE.fullmatch(resource) or any(segment in ("", ".", "..") for segment in resource.split("/")[1:]):
        raise SetupError("Expected a specific Azure resource ID, not a URL")
    api = VM_API if "/Microsoft.Compute/" in resource else NETWORK_API
    args = ["rest", "--method", method, "--url", f"https://management.azure.com{resource}?api-version={api}",
            "--subscription", resource.split("/")[2]]
    if body is None:
        return az(*args, missing=missing)
    with tempfile.TemporaryDirectory(prefix="codey-arm-") as root:
        file = Path(root) / "resource.json"
        file.write_text(json.dumps(body))
        return az(*args, "--body", f"@{file}")


def properties(resource):
    return resource.get("properties", {})


def prefixes(resource):
    p = properties(resource)
    return p.get("addressSpace", {}).get("addressPrefixes") or p.get("addressPrefixes") or [p["addressPrefix"]]


def overlap(left, right):
    return any(ipaddress.ip_network(a).overlaps(ipaddress.ip_network(b)) for a in left for b in right)


def free_subnet(vnet, length=28):
    occupied = [prefix for subnet in properties(vnet).get("subnets", []) for prefix in prefixes(subnet)]
    for prefix in prefixes(vnet):
        network = ipaddress.ip_network(prefix)
        if network.version != 4 or network.prefixlen > length:
            continue
        for candidate in network.subnets(new_prefix=length):
            if not overlap([str(candidate)], occupied):
                return str(candidate)
    raise SetupError("No unused /28 exists for an isolated Private Link subnet; do not renumber the VM")


def port_applies(rule):
    p = properties(rule)
    if p.get("direction") != "Inbound" or p.get("protocol", "*").lower() not in ("tcp", "*"):
        return False
    for item in p.get("destinationPortRanges") or [p.get("destinationPortRange", "*")]:
        if item == "*":
            return True
        try:
            low, high = map(int, item.split("-")) if "-" in item else (int(item), int(item))
            if any(low <= int(port) <= high for port in PORTS):
                return True
        except (ValueError, TypeError):
            raise SetupError("Cannot safely interpret an existing NSG port rule")
    return False


def rule_priorities(nsg, node_id):
    rules = properties(nsg).get("securityRules", [])
    own_prefix = f"codey-{node_id}-"
    others = [r for r in rules if not r["name"].startswith(own_prefix)]
    occupied = {properties(rule)["priority"] for rule in others}
    boundary = min([properties(rule)["priority"] for rule in others if port_applies(rule)] + [4097])
    available = [priority for priority in range(100, boundary) if priority not in occupied]
    if len(available) < 2:
        raise SetupError("NSG has no two free priorities before existing 8443/3001 rules; operator review is required")
    return available[:2]


def private_link_nat_sources(pls, subnet_id):
    # ARM can omit privateIPAddress on dynamic PLS IP configurations even after
    # provisioning succeeds. The PLS-owned NIC is the authoritative allocation.
    values = []
    for reference in properties(pls).get("networkInterfaces", []):
        nic = arm(reference["id"])
        for config in properties(nic).get("ipConfigurations", []):
            p = properties(config)
            if p.get("subnet", {}).get("id", "").lower() != subnet_id.lower():
                raise SetupError("PLS NAT NIC is not in this machine's dedicated subnet")
            address = ipaddress.ip_address(p.get("privateIPAddress", ""))
            if address.version != 4 or not any(address in ipaddress.ip_network(prefix) for prefix in
                                               ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16")):
                raise SetupError("PLS NAT allocation is not a private IPv4 address")
            values.append(str(address) + "/32")
    if not values:
        raise SetupError("PLS NAT NIC/IP is not ready; rerun this same invitation, do not create another PLS")
    return sorted(set(values))


def check_nsg_scope(nsg, node_vnet_id, node_nic_id):
    # A /32 is not node-specific when one NSG is shared across overlapping
    # VNets. Refuse that case before creating resources or writing any rule.
    for subnet in properties(nsg).get("subnets", []):
        if subnet["id"].rsplit("/subnets/", 1)[0].lower() != node_vnet_id.lower():
            raise SetupError("NSG is shared with another VNet; operator review is required before adding node rules")
    for reference in properties(nsg).get("networkInterfaces", []):
        if reference["id"].lower() == node_nic_id.lower():
            continue
        other = arm(reference["id"])
        for config in properties(other).get("ipConfigurations", []):
            subnet_id = properties(config).get("subnet", {}).get("id", "")
            if subnet_id.rsplit("/subnets/", 1)[0].lower() != node_vnet_id.lower():
                raise SetupError("NSG is shared with a NIC in another VNet; do not change it automatically")


def discover(enrollment, vm_id):
    node_id = enrollment.get("nodeId", "")
    if not NODE_ID.fullmatch(node_id):
        raise SetupError("Invalid reserved machine identity")
    portal_subnet_id = enrollment["network"]["portalSubnetId"]
    endpoint_subnet_id = enrollment["network"]["privateEndpointSubnetId"]
    vm = arm(vm_id)
    nics = properties(vm)["networkProfile"]["networkInterfaces"]
    primary = next((nic for nic in nics if properties(nic).get("primary")), nics[0] if len(nics) == 1 else None)
    if not primary:
        raise SetupError("VM has multiple NICs and no unambiguous primary NIC")
    nic = arm(primary["id"])
    configurations = properties(nic)["ipConfigurations"]
    config = next((item for item in configurations if properties(item).get("primary")),
                  configurations[0] if len(configurations) == 1 else None)
    if not config:
        raise SetupError("NIC has no unambiguous primary IP configuration")
    node_subnet = arm(properties(config)["subnet"]["id"])
    node_vnet_id = node_subnet["id"].rsplit("/subnets/", 1)[0]
    portal_vnet_id = portal_subnet_id.rsplit("/subnets/", 1)[0]
    node_vnet, portal_vnet = arm(node_vnet_id), arm(portal_vnet_id)
    portal_subnet, endpoint_subnet = arm(portal_subnet_id), arm(endpoint_subnet_id)
    if portal_vnet_id.lower() != endpoint_subnet_id.rsplit("/subnets/", 1)[0].lower() or portal_subnet_id.lower() == endpoint_subnet_id.lower():
        raise SetupError("Private Endpoint subnet must be separate from ACA infrastructure in the Portal VNet")
    if properties(endpoint_subnet).get("delegations"):
        raise SetupError("Private Endpoint subnet must not be delegated to ACA or another service")
    peers = properties(portal_vnet).get("virtualNetworkPeerings", [])
    existing = next((peer for peer in peers if properties(peer)["remoteVirtualNetwork"]["id"].lower() == node_vnet_id.lower()), None)
    conflicts = []
    for peer in peers:
        remote_id = properties(peer)["remoteVirtualNetwork"]["id"]
        if remote_id.lower() == node_vnet_id.lower():
            continue
        remote = arm(remote_id)
        if overlap(prefixes(node_vnet), prefixes(remote)):
            conflicts.append(remote_id)
    if node_vnet_id.lower() == portal_vnet_id.lower():
        mode = "same-vnet"
    elif existing and properties(existing).get("peeringState") == "Connected":
        mode = "peering"
    elif overlap(prefixes(node_vnet), prefixes(portal_vnet)) or conflicts:
        mode = "private-link"
    else:
        mode = "peering"
    nsg_ids = {properties(item).get("networkSecurityGroup", {}).get("id") for item in [nic, node_subnet]}
    nsgs = [arm(resource) for resource in sorted(nsg_ids - {None})]
    if not nsgs:
        raise SetupError("VM needs an existing NSG; do not silently replace its NIC/subnet security boundary")
    for nsg in nsgs:
        check_nsg_scope(nsg, node_vnet_id, nic["id"])
        rule_priorities(nsg, node_id)
    if mode == "private-link" and not properties(config).get("publicIPAddress") and not properties(node_subnet).get("natGateway"):
        raise SetupError("Verify an explicit VM egress path before adding a Standard LB backend; default outbound must not be disrupted")
    return {
        "nodeId": node_id, "vm": vm, "nic": nic, "ipConfig": config,
        "nodeSubnet": node_subnet, "nodeVnet": node_vnet,
        "portalSubnet": portal_subnet, "portalVnet": portal_vnet,
        "endpointSubnet": endpoint_subnet, "nsgs": nsgs, "mode": mode, "conflicts": conflicts,
        "privateIp": properties(config)["privateIPAddress"],
    }


class Apply:
    def __init__(self, topology, output):
        self.t = topology
        self.output = Path(output).resolve()
        self.output.parent.mkdir(parents=True, exist_ok=True)
        self.id = topology["nodeId"]
        self.state_file = self.output.with_suffix(".azure-state.json")
        self.state = {"schema": 1, "nodeId": self.id, "vmResourceId": topology["vm"]["id"], "resourcesCreated": [], "associationsAdded": []}
        if self.state_file.exists():
            self.state = json.loads(self.state_file.read_text())
            if self.state.get("nodeId") != self.id or self.state.get("vmResourceId", "").lower() != topology["vm"]["id"].lower():
                raise SetupError("Azure state belongs to another machine")
        self.tags = {"codey-machine": self.id, "managed-by": "codey-machine-skill"}

    def save(self):
        temporary = self.state_file.with_suffix(".tmp")
        temporary.write_text(json.dumps(self.state, indent=2) + "\n")
        os.replace(temporary, self.state_file)

    def wait(self, resource):
        for _ in range(90):
            value = arm(resource)
            status = properties(value).get("provisioningState", "Succeeded")
            if status == "Succeeded":
                return value
            if status in ("Failed", "Canceled"):
                raise SetupError(f"Azure resource failed: {resource}")
            time.sleep(2)
        raise SetupError(f"Azure resource did not become ready: {resource}")

    def create(self, resource, body, child=False):
        current = arm(resource, missing=True)
        if current:
            owned = resource.lower() in {item.lower() for item in self.state["resourcesCreated"]}
            owned = owned or current.get("tags", {}).get("codey-machine") == self.id
            if not owned:
                raise SetupError(f"Refusing to overwrite an existing resource: {resource}")
            return self.wait(resource)
        if not child:
            body["tags"] = self.tags
        arm(resource, "put", body)
        self.state["resourcesCreated"].append(resource)
        self.save()
        return self.wait(resource)

    def peering(self):
        t = self.t
        for local, remote in [(t["portalVnet"], t["nodeVnet"]), (t["nodeVnet"], t["portalVnet"])]:
            matches = [peer for peer in properties(arm(local["id"])).get("virtualNetworkPeerings", [])
                       if properties(peer)["remoteVirtualNetwork"]["id"].lower() == remote["id"].lower()]
            if matches:
                if properties(matches[0]).get("peeringState") not in ("Connected", "Initiated"):
                    raise SetupError("An existing peering is disconnected; do not overwrite it")
                continue
            self.create(local["id"] + f"/virtualNetworkPeerings/codey-{self.id}", {
                "properties": {"remoteVirtualNetwork": {"id": remote["id"]}, "allowVirtualNetworkAccess": True,
                               "allowForwardedTraffic": False, "allowGatewayTransit": False, "useRemoteGateways": False},
            }, child=True)
        for local, remote in [(t["portalVnet"], t["nodeVnet"]), (t["nodeVnet"], t["portalVnet"])]:
            peers = properties(arm(local["id"]))["virtualNetworkPeerings"]
            if not any(properties(peer)["remoteVirtualNetwork"]["id"].lower() == remote["id"].lower() and
                       properties(peer).get("peeringState") == "Connected" for peer in peers):
                raise SetupError("Both peering directions must be Connected")

    def private_link(self):
        t = self.t
        suffix = self.id[2:14]
        root = t["nodeVnet"]["id"].split("/providers/")[0] + "/providers/Microsoft.Network"
        portal_root = t["portalVnet"]["id"].split("/providers/")[0] + "/providers/Microsoft.Network"
        subnet_id = t["nodeVnet"]["id"] + f"/subnets/codey-{suffix}-pls"
        existing_subnet = next((subnet for subnet in properties(t["nodeVnet"]).get("subnets", [])
                                if subnet["id"].lower() == subnet_id.lower()), None)
        subnet = self.create(subnet_id, {"properties": {
            "addressPrefix": prefixes(existing_subnet)[0] if existing_subnet else free_subnet(t["nodeVnet"]),
            "privateLinkServiceNetworkPolicies": "Disabled",
        }}, child=True)
        lb_id = root + f"/loadBalancers/codey-{suffix}-lb"
        frontend_id = lb_id + "/frontendIPConfigurations/node"
        pool_id = lb_id + "/backendAddressPools/node"
        location = t["vm"]["location"]
        self.create(lb_id, {
            "location": location, "sku": {"name": "Standard", "tier": "Regional"},
            "properties": {
                "frontendIPConfigurations": [{"name": "node", "properties": {
                    "subnet": {"id": subnet["id"]}, "privateIPAllocationMethod": "Dynamic"}}],
                "backendAddressPools": [{"name": "node"}],
                "probes": [{"name": f"tcp-{port}", "properties": {
                    "protocol": "Tcp", "port": int(port), "intervalInSeconds": 5, "numberOfProbes": 2}} for port in PORTS],
                "loadBalancingRules": [{"name": f"tcp-{port}", "properties": {
                    "frontendIPConfiguration": {"id": frontend_id}, "backendAddressPool": {"id": pool_id},
                    "probe": {"id": lb_id + f"/probes/tcp-{port}"}, "protocol": "Tcp",
                    "frontendPort": int(port), "backendPort": int(port),
                    "enableFloatingIP": False, "disableOutboundSnat": True,
                    "enableTcpReset": True, "idleTimeoutInMinutes": 15}} for port in PORTS],
            },
        })
        nic = arm(t["nic"]["id"])
        ip_config = next(item for item in properties(nic)["ipConfigurations"] if item["name"] == t["ipConfig"]["name"])
        if not any(item["id"].lower() == pool_id.lower() for item in properties(ip_config).get("loadBalancerBackendAddressPools", [])):
            nic_parts = nic["id"].split("/")
            az("network", "nic", "ip-config", "address-pool", "add",
               "--subscription", nic_parts[2], "-g", nic_parts[4], "--nic-name", nic["name"],
               "--ip-config-name", ip_config["name"], "--address-pool", pool_id)
            self.state["associationsAdded"].append({"nic": nic["id"], "ipConfig": ip_config["name"], "pool": pool_id})
            self.save()
        pls_id = root + f"/privateLinkServices/codey-{suffix}-pls"
        pls = self.create(pls_id, {"location": location, "properties": {
            "loadBalancerFrontendIpConfigurations": [{"id": frontend_id}],
            "ipConfigurations": [{"name": "nat", "properties": {
                "subnet": {"id": subnet["id"]}, "privateIPAllocationMethod": "Dynamic", "primary": True}}],
            "visibility": {"subscriptions": [t["portalVnet"]["id"].split("/")[2]]},
            "autoApproval": {"subscriptions": []}, "enableProxyProtocol": False,
        }})
        pe_id = portal_root + f"/privateEndpoints/codey-{suffix}-pe"
        pe = self.create(pe_id, {"location": t["portalVnet"]["location"], "properties": {
            "subnet": {"id": t["endpointSubnet"]["id"]},
            "privateLinkServiceConnections": [{"name": "node", "properties": {
                "privateLinkServiceId": pls_id, "groupIds": [], "requestMessage": f"Codey machine {self.id}"}}],
        }})
        for connection in properties(arm(pls_id)).get("privateEndpointConnections", []):
            if properties(connection).get("privateEndpoint", {}).get("id", "").lower() != pe_id.lower():
                continue
            status = properties(connection).get("privateLinkServiceConnectionState", {}).get("status")
            if status == "Pending":
                az("network", "private-endpoint-connection", "approve", "--id", connection["id"],
                   "--description", f"Approved only Codey machine {self.id}")
            elif status != "Approved":
                raise SetupError("Private Link connection was rejected or disconnected")
        pe = self.wait(pe_id)
        connections = properties(pe).get("privateLinkServiceConnections", [])
        if not connections or any(properties(c).get("privateLinkServiceConnectionState", {}).get("status") != "Approved" for c in connections):
            raise SetupError("Private Endpoint has not been approved")
        endpoint_nic = arm(properties(pe)["networkInterfaces"][0]["id"])
        endpoint_ip = properties(properties(endpoint_nic)["ipConfigurations"][0])["privateIPAddress"]
        nat_ips = private_link_nat_sources(pls, subnet["id"])
        return endpoint_ip, nat_ips + [PROBE_SOURCE]

    def secure_ports(self, sources):
        for old in self.t["nsgs"]:
            nsg = arm(old["id"])
            allow, deny = rule_priorities(nsg, self.id)
            for label, access, priority, addresses in [
                ("allow", "Allow", allow, sources), ("deny", "Deny", deny, ["*"]),
            ]:
                body = {"properties": {
                    "description": f"Codey machine {self.id}: only private gateway and platform probes",
                    "protocol": "Tcp", "sourcePortRange": "*", "destinationPortRanges": PORTS,
                    "destinationAddressPrefix": self.t["privateIp"] + "/32",
                    "access": access, "priority": priority, "direction": "Inbound",
                    **({"sourceAddressPrefix": addresses[0]} if len(addresses) == 1 else {"sourceAddressPrefixes": addresses}),
                }}
                rule_id = nsg["id"] + f"/securityRules/codey-{self.id}-{label}"
                current = arm(rule_id, missing=True)
                if current:
                    expected = body["properties"]
                    if any(properties(current).get(key) != value for key, value in expected.items()):
                        raise SetupError(f"Existing Codey NSG rule differs; review instead of overwriting: {rule_id}")
                else:
                    self.create(rule_id, body, child=True)

    def run(self):
        t = self.t
        if t["mode"] == "private-link":
            upstream_ip, sources = self.private_link()
        else:
            if t["mode"] == "peering":
                self.peering()
            upstream_ip, sources = t["privateIp"], prefixes(t["portalSubnet"])
        self.secure_ports(sources)
        result = {
            "schema": 1, "nodeId": self.id, "networkMode": t["mode"],
            "vmResourceId": t["vm"]["id"], "privateIp": upstream_ip, "listenIp": t["privateIp"],
            "region": t["vm"]["location"], "name": t["vm"]["name"],
            "allowedSources": sources, "azureStateFile": str(self.state_file),
        }
        self.output.write_text(json.dumps(result, indent=2) + "\n")
        print(json.dumps({"ok": True, "networkMode": t["mode"], "machineNetworkFile": str(self.output),
                          "resourcesCreated": len(self.state["resourcesCreated"]),
                          "note": "Network resources ready; Portal must still verify TLS, HTTP and WebSocket before adding the node"}, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--enrollment", required=True)
    parser.add_argument("--vm-id")
    parser.add_argument("--out", required=True)
    parser.add_argument("--apply", action="store_true", help="Authorize node-scoped resources/NSG rules shown by the plan")
    args = parser.parse_args()
    enrollment = json.loads(Path(args.enrollment).read_text())
    if enrollment.get("expiresAt", 0) <= time.time() * 1000:
        raise SetupError("This machine invitation has expired; download a fresh skill")
    vm_id = args.vm_id
    if not vm_id:
        # Never send Azure login tokens to IMDS or log the complete response.
        request = urllib.request.Request(
            "http://169.254.169.254/metadata/instance/compute/resourceId?api-version=2021-02-01&format=text",
            headers={"Metadata": "true"})
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(request, timeout=5) as response:
            vm_id = response.read().decode().strip()
    topology = discover(enrollment, vm_id)
    summary = {
        "nodeId": topology["nodeId"], "vmResourceId": vm_id, "mode": topology["mode"],
        "privateIp": topology["privateIp"], "overlappingExistingPeers": topology["conflicts"],
        "changes": (["dedicated /28 subnet", "Standard internal LB", "NIC backend membership", "Private Link Service", "Private Endpoint"]
                    if topology["mode"] == "private-link" else ["reuse private routing / create missing peering directions"]),
        "nsgChanges": "Only 8443/3001 to this VM: allow exact private sources, deny other sources",
        "unchanged": ["VM IP", "public IP", "SSH rules", "default routes", "existing peerings/services"],
        "cost": "Private Link / Standard LB / peering can incur Azure charges; review before --apply",
    }
    if not args.apply:
        print(json.dumps(summary, indent=2))
        return
    lock = Path(args.out).resolve().with_suffix(".lock")
    lock.parent.mkdir(parents=True, exist_ok=True)
    with lock.open("x") as handle:
        handle.write(str(os.getpid()))
    try:
        Apply(topology, args.out).run()
    finally:
        lock.unlink()


if __name__ == "__main__":
    try:
        main()
    except (SetupError, KeyError, ValueError, FileExistsError) as error:
        raise SystemExit(str(error))
