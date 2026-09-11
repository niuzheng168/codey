import { requestError } from "./signed-store.mjs";

export const MACHINE_PLATFORMS = Object.freeze([
  Object.freeze({
    id: "linux-x64", name: "Linux", entrypoint: "scripts/install.sh",
    nodeSuffix: "linux-x64.tar.xz", updater: true, implemented: true, registrationSupported: true,
    tunnel: true, privateNetwork: true, dataRelay: false,
    description: "Linux x64 · GitHub 私有 DevTunnel · 一键覆盖安装 · systemd 守护",
    files: ["scripts/install.sh", "templates/a100-models.json"],
  }),
  Object.freeze({
    id: "windows-x64", name: "Windows", entrypoint: "scripts/install.ps1",
    nodeSuffix: "win-x64.zip", updater: false, implemented: false, registrationSupported: true,
    tunnel: true, privateNetwork: true, dataRelay: true,
    description: "支持导入 Windows 安装器生成的注册文件；完整 npm 安装包尚未开放下载",
    files: ["scripts/install.ps1", "scripts/windows-common.ps1", "scripts/windows-process.cs",
      "scripts/windows-service.ps1", "scripts/windows-runtime.mjs", "templates/a100-models.json"],
  }),
  Object.freeze({
    id: "macos-arm64", name: "macOS · Apple Silicon", entrypoint: null,
    nodeSuffix: "darwin-arm64.tar.gz", updater: false, implemented: false,
    tunnel: true, privateNetwork: true, dataRelay: true,
    description: "尚未迁移到新的精简一键流程",
    files: [],
  }),
  Object.freeze({
    id: "macos-x64", name: "macOS · Intel", entrypoint: null,
    nodeSuffix: "darwin-x64.tar.gz", updater: false, implemented: false,
    tunnel: true, privateNetwork: true, dataRelay: true,
    description: "尚未迁移到新的精简一键流程",
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
