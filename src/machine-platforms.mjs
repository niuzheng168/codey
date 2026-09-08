import { requestError } from "./signed-store.mjs";

export const MACHINE_PLATFORMS = Object.freeze([
  Object.freeze({
    id: "windows-x64", name: "Windows", entrypoint: "scripts/setup-windows.ps1",
    nodeSuffix: "win-x64.zip", updater: false, implemented: true,
    description: "Azure Windows x64 · 原用户登录后运行 · 网络与防火墙改动须另行确认",
    files: ["scripts/setup-windows.ps1", "scripts/configure-windows.py",
      "scripts/windows-service.py", "scripts/windows-tasks.ps1"],
  }),
  Object.freeze({
    id: "linux-x64", name: "Linux", entrypoint: "scripts/setup-linux.sh",
    nodeSuffix: "linux-x64.tar.xz", updater: true, implemented: true,
    description: "Azure Linux x64 · systemd 用户服务 · 独立签名升级器",
    files: ["scripts/setup-linux.sh"],
  }),
  Object.freeze({
    id: "macos", name: "macOS", entrypoint: null, updater: false, implemented: false,
    description: "规划中 · 尚未提供完整机器配置安装器", files: [],
  }),
]);

export function machinePlatform(id = "linux-x64") {
  const platform = MACHINE_PLATFORMS.find((item) => item.id === id);
  if (!platform?.implemented) throw requestError("此平台尚未提供完整机器配置脚本，不会回退到 Linux 安装器", 400);
  return platform;
}
