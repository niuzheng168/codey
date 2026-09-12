import { requestError } from "./signed-store.mjs";

export const MACHINE_PLATFORMS = Object.freeze([
  Object.freeze({
    id: "linux-x64", name: "Linux", entrypoint: "scripts/install.sh",
    nodeSuffix: "linux-x64.tar.xz", updater: true, implemented: true, registrationSupported: true,
    tunnel: true, privateNetwork: true, dataRelay: false,
    description: "Linux x64 · 直接 npm 安装 · codey setup · 私有 DevTunnel · systemd 守护",
    files: ["scripts/install.sh", "templates/a100-models.json"],
  }),
  Object.freeze({
    id: "windows-x64", name: "Windows", entrypoint: "scripts/install.ps1",
    // Keep legacy registration independent of agent enrollment; existing owners
    // explicitly opt in through Settings, without reinstalling/re-registering.
    nodeSuffix: "win-x64.zip", updater: false, portalUpdater: true, implemented: false, registrationSupported: true,
    tunnel: true, privateNetwork: true, dataRelay: true,
    description: "支持导入 Windows 注册文件并单独接入 Portal 升级代理；新机完整安装入口仍独立管理",
    files: ["scripts/install.ps1", "scripts/windows-common.ps1", "scripts/windows-process.cs",
      "scripts/windows-service.ps1", "scripts/windows-runtime.mjs", "scripts/windows-command.ps1",
      "templates/a100-models.json"],
  }),
  Object.freeze({
    id: "macos-arm64", name: "macOS · Apple Silicon", entrypoint: null,
    nodeSuffix: "darwin-arm64.tar.gz", updater: false, portalUpdater: true, implemented: false, registrationSupported: true,
    tunnel: true, privateNetwork: true, dataRelay: true,
    description: "支持导入 macOS 注册文件并单独接入 Portal 升级代理；不以升级器替代新机安装或旧布局迁移",
    files: [],
  }),
  Object.freeze({
    id: "macos-x64", name: "macOS · Intel", entrypoint: null,
    nodeSuffix: "darwin-x64.tar.gz", updater: false, portalUpdater: true, implemented: false, registrationSupported: true,
    tunnel: true, privateNetwork: true, dataRelay: true,
    description: "支持导入 macOS 注册文件并单独接入 Portal 升级代理；不以升级器替代新机安装或旧布局迁移",
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
