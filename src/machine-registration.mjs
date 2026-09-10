import { machineCredentials } from "./machine-credentials.mjs";
import { machineIdentity } from "./machine-identity.mjs";
import { machinePlatform } from "./machine-platforms.mjs";
import { requestError } from "./signed-store.mjs";
import { validateDevTunnelConnectToken } from "./devtunnel-transport.mjs";

const RELEASE = /^machine-[a-f0-9]{16}$/;

function exactOrigin(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.origin !== value || url.username || url.password) throw new Error();
    return value;
  } catch {
    throw requestError("注册文件绑定的 Portal 地址无效");
  }
}

export function machineRegistration(input, expected, now = Date.now()) {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      input.schema !== 2 ||
      Object.keys(input).length !== 5 ||
      Object.keys(input).some((name) =>
        !["schema", "package", "machine", "credentials", "devTunnelConnectToken"].includes(name))) {
    throw requestError("请选择 Skill 生成的 codey-machine-registration.json");
  }
  const descriptor = input.package;
  if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor) ||
      Object.keys(descriptor).length !== 3 ||
      Object.keys(descriptor).some((name) => !["portalOrigin", "releaseId", "platform"].includes(name)) ||
      !RELEASE.test(descriptor.releaseId ?? "")) {
    throw requestError("注册文件缺少有效的固定 Skill 版本");
  }
  const platform = machinePlatform(descriptor.platform).id;
  const portalOrigin = exactOrigin(descriptor.portalOrigin);
  if (expected?.portalOrigin !== portalOrigin ||
      (expected?.releaseId && expected.releaseId !== descriptor.releaseId) ||
      expected?.platform !== platform) {
    throw requestError("注册文件与当前 Portal 发布的对应平台 Skill 不匹配", 409);
  }
  const machine = machineIdentity(input.machine, input.machine?.nodeId, now);
  if (machine.platform !== platform || machine.networkMode !== "devtunnel") {
    throw requestError("固定 Skill 只接受本机生成的私有 DevTunnel 节点");
  }
  const credentials = machineCredentials(input.credentials);
  const connectToken = validateDevTunnelConnectToken(input.devTunnelConnectToken, machine.devTunnel, now);
  return Object.freeze({
    descriptor: Object.freeze({ portalOrigin, releaseId: descriptor.releaseId, platform }),
    machine, credentials, connectToken,
  });
}
