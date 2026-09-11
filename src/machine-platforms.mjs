import { requestError } from "./signed-store.mjs";

export const MACHINE_PLATFORMS = Object.freeze([
  Object.freeze({
    id: "linux-x64", name: "Linux", entrypoint: "scripts/install.sh",
    nodeSuffix: "linux-x64.tar.xz", updater: true, implemented: true,
    tunnel: true, privateNetwork: true, dataRelay: false,
    description: "Linux x64 · 直接 npm 安装 · codey setup · 私有 DevTunnel · systemd 守护",
    files: ["scripts/install.sh", "templates/a100-models.json"],
  }),
  Object.freeze({
    id: "windows-x64", name: "Windows", entrypoint: null,
    nodeSuffix: "win-x64.zip", updater: false, implemented: false,
    tunnel: true, privateNetwork: true, dataRelay: true,
    description: "Linux 一键流程验收完成后再实现 PowerShell 版本",
    files: [],
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
