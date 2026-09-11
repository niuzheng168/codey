import { X509Certificate } from "node:crypto";
import { isIP } from "node:net";
import { checkServerIdentity } from "node:tls";
import { requestError } from "./signed-store.mjs";
import { machineRegistrationPlatform } from "./machine-platforms.mjs";
import { validDevTunnelCoordinates } from "./devtunnel-transport.mjs";

export const MACHINE_ID = /^n-[a-f0-9]{24}$/;
export const machineServerName = (id) => `${id}.nodes.codey.internal`;

export function privateMachineIp(value) {
  if (typeof value !== "string" || isIP(value) !== 4) return false;
  const [a, b] = value.split(".").map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

// A fresh, unpredictable node-specific leaf is the authority for this target,
// not an editable URL or a caller-supplied CA. TLS must verify it before ANY
// HTTP request (and therefore any ticket/SSO assertion) reaches the target.
export function machineIdentity(input, expectedId, now = Date.now()) {
  const fields = new Set(["schema", "nodeId", "name", "region", "privateIp", "tlsCertificate", "networkMode", "vmResourceId", "platform", "devTunnel"]);
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).some((key) => !fields.has(key)) || input.schema !== 1 ||
      !MACHINE_ID.test(expectedId) || input.nodeId !== expectedId) {
    throw requestError("请选择此账号下载的 Skill 生成的 codey-machine.json");
  }
  const definition = machineRegistrationPlatform(input.platform ?? "linux-x64");
  const platform = definition.id;
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const region = typeof input.region === "string" ? input.region.trim() : "";
  if (!name || name.length > 80 || region.length > 120 || /[\x00-\x1f]/.test(String(input.name) + String(input.region ?? ""))) {
    throw requestError("机器名称或区域不正确");
  }
  const useTunnel = definition.tunnel && input.networkMode === "devtunnel";
  if (definition.tunnel && !definition.privateNetwork && !useTunnel) {
    throw requestError("此平台的机器文件必须使用本节点的私有 DevTunnel");
  }
  if (useTunnel) {
    if (input.networkMode !== "devtunnel" || Object.hasOwn(input, "privateIp") || Object.hasOwn(input, "vmResourceId") ||
        !validDevTunnelCoordinates(input.devTunnel) ||
        Object.keys(input.devTunnel).some(key => !["tunnelId", "clusterId"].includes(key))) {
      throw requestError("机器文件必须使用本节点的私有 DevTunnel，不接受地址、令牌或 Azure VM 字段");
    }
  } else {
    if (input.devTunnel !== undefined || !privateMachineIp(input.privateIp)) {
      throw requestError("机器网关必须使用私网 IPv4，不能使用公网、回环或 metadata 地址");
    }
    if (!["same-vnet", "peering", "private-link"].includes(input.networkMode)) {
      throw requestError("请先完成 Skill 的 Azure 私网配置");
    }
    if (typeof input.vmResourceId !== "string" ||
        !/^\/subscriptions\/[a-f0-9-]{36}\/resourceGroups\/[a-z0-9_.()-]{1,90}\/providers\/Microsoft\.Compute\/virtualMachines\/[a-z0-9_.-]{1,64}$/i.test(input.vmResourceId)) {
      throw requestError("机器文件缺少有效的 Azure VM resource ID");
    }
  }
  const pem = input.tlsCertificate;
  if (typeof pem !== "string" || pem.length > 8192 ||
      !/^-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----\s*$/.test(pem)) {
    throw requestError("机器文件必须只包含本节点的公开 TLS 证书");
  }
  const serverName = machineServerName(expectedId);
  let certificate;
  try {
    certificate = new X509Certificate(pem);
    const publicKey = certificate.publicKey;
    // checkIssued() applies CA/keyCertSign rules and rejects a valid self-signed
    // server leaf with digitalSignature/keyEncipherment usage. Verify the
    // self-signature and issuer name instead; TLS additionally pins this leaf.
    if (certificate.ca || certificate.subjectAltName !== `DNS:${serverName}` ||
        certificate.issuer !== certificate.subject || !certificate.verify(publicKey) ||
        !certificate.checkHost(serverName, { wildcards: false }) ||
        Date.parse(certificate.validFrom) > now || Date.parse(certificate.validTo) < now + 86400000 ||
        Date.parse(certificate.validTo) > now + 400 * 86400000 ||
        !["rsa", "ec", "ed25519"].includes(publicKey.asymmetricKeyType) ||
        (publicKey.asymmetricKeyType === "rsa" && publicKey.asymmetricKeyDetails.modulusLength < 2048)) {
      throw new Error("Invalid node leaf");
    }
  } catch { throw requestError("TLS 证书必须是绑定本次机器 ID、有效且非 CA 的独立自签名证书"); }
  return {
    id: expectedId, name, region, platform,
    tlsServerName: serverName, ca: certificate.toString(),
    fingerprint: certificate.fingerprint256,
    networkMode: input.networkMode,
    ...(useTunnel
      ? { devTunnel: { tunnelId: input.devTunnel.tunnelId, clusterId: input.devTunnel.clusterId } }
      : { privateIp: input.privateIp, vmResourceId: input.vmResourceId }),
  };
}

export function preparedGateways(node, { getTunnelToken, getWorkspaceBinding } = {}) {
  const machine = node.machine;
  const host = machine.networkMode === "devtunnel" ? "127.0.0.1" : machine.privateIp;
  const tunnel = (port) => machine.networkMode === "devtunnel" ? {
    devTunnel: { ...machine.devTunnel, port },
    getTunnelToken: getTunnelToken ?? (() => { throw new Error("No machine tunnel credential provider"); }),
  } : {};
  return {
    data: {
      id: node.id, upstream: new URL(`https://${host}:8443`),
      tlsServerName: machine.tlsServerName, ca: machine.ca, fingerprint: machine.fingerprint,
      ...tunnel(8443),
    },
    workspace: {
      id: node.id, name: node.name, region: node.region, basePath: `/cloudcli/${node.id}`,
      upstream: new URL(`https://${host}:3001`),
      tlsServerName: machine.tlsServerName, ca: machine.ca, fingerprint: machine.fingerprint,
      healthMonitoring: !machineRegistrationPlatform(machine.platform ?? "linux-x64").updater,
      ...(getWorkspaceBinding ? { getWorkspaceBinding } : {}),
      ...tunnel(3001),
    },
  };
}

export function nodeTlsOptions(node, fallbackCa) {
  return {
    ca: node.ca ?? fallbackCa,
    servername: node.tlsServerName || undefined,
    rejectUnauthorized: true,
    ...(node.fingerprint ? {
      checkServerIdentity(hostname, certificate) {
        const error = checkServerIdentity(hostname, certificate);
        return error || (certificate.fingerprint256 !== node.fingerprint
          ? new Error("Node leaf certificate fingerprint does not match the enrolled machine") : undefined);
      },
    } : {}),
  };
}
