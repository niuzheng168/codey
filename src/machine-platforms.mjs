import { requestError } from "./signed-store.mjs";

export const MACHINE_PLATFORMS = Object.freeze([
  Object.freeze({
    id: "linux-x64", name: "Linux", entrypoint: "scripts/install.sh",
    nodeSuffix: "linux-x64.tar.xz", implemented: true, registrationSupported: true,
    tunnel: true, privateNetwork: true, dataRelay: false,
    description: "Linux x64 · npm 安装与公共配置流程 · 私有 DevTunnel · systemd 守护",
    files: ["scripts/install.sh", "templates/a100-models.json"],
  }),
  Object.freeze({
    id: "windows-x64", name: "Windows", entrypoint: "scripts/install.ps1",
    // Shared-Skill registration is independent of the legacy per-platform download gate.
    nodeSuffix: "win-x64.zip", implemented: false, registrationSupported: true,
    tunnel: true, privateNetwork: true, dataRelay: true,
    description: "共享 Skill 原生安装 Windows 节点；私有 DevTunnel 与计划任务守护，无升级代理",
    files: ["scripts/install.ps1", "scripts/windows-common.ps1", "scripts/windows-process.cs",
      "scripts/windows-service.ps1", "scripts/windows-runtime.mjs", "scripts/windows-command.ps1",
      "templates/a100-models.json"],
  }),
  Object.freeze({
    id: "macos-arm64", name: "macOS · Apple Silicon", entrypoint: "scripts/install-macos.sh",
    nodeSuffix: "darwin-arm64.tar.gz", implemented: false, registrationSupported: true,
    tunnel: true, privateNetwork: true, dataRelay: true,
    description: "共享 Skill 使用 Node 安装 macOS 节点；LaunchAgents 守护，无 Python 或升级代理",
    files: [],
  }),
  Object.freeze({
    id: "macos-x64", name: "macOS · Intel", entrypoint: "scripts/install-macos.sh",
    nodeSuffix: "darwin-x64.tar.gz", implemented: false, registrationSupported: true,
    tunnel: true, privateNetwork: true, dataRelay: true,
    description: "共享 Skill 使用 Node 安装 macOS 节点；LaunchAgents 守护，无 Python 或升级代理",
    files: [],
  }),
]);

export function machinePlatform(id = "linux-x64") {
  const platform = MACHINE_PLATFORMS.find((item) => item.id === id);
  if (!platform?.implemented) throw requestError("此平台尚未提供新的精简一键安装器", 400);
  return platform;
}

// Registration and existing-node routing must not depend on download publication.
// Only explicitly supported native runtimes can enroll; this does not enable downloads.
export function machineRegistrationPlatform(id) {
  const platform = MACHINE_PLATFORMS.find((item) => item.id === id);
  if (!platform?.registrationSupported) throw requestError("此平台尚不支持机器注册", 400);
  return platform;
}
