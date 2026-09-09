import { requestError } from "./signed-store.mjs";

export const MACHINE_PLATFORMS = Object.freeze([
  Object.freeze({
    id: "windows-x64", name: "Windows", entrypoint: "scripts/setup-windows.ps1",
    nodeSuffix: "win-x64.zip", updater: false, implemented: true, tunnel: true, privateNetwork: true,
    description: "Windows x64 · 私有 DevTunnel · 登录后运行 · 保留现有 Codex/模型代理",
    files: ["scripts/setup-windows.ps1", "scripts/configure-windows.py",
      "scripts/windows-service.py", "scripts/windows-tasks.ps1",
      "scripts/configure-windows-tunnel.py", "scripts/windows-tunnel-client.py",
      "scripts/windows-tunnel-service.py", "scripts/windows-tunnel-tasks.ps1"],
  }),
  Object.freeze({
    id: "linux-x64", name: "Linux", entrypoint: "scripts/setup-linux.sh",
    nodeSuffix: "linux-x64.tar.xz", updater: true, implemented: true,
    description: "Azure Linux x64 · systemd 用户服务 · 独立签名升级器",
    files: ["scripts/setup-linux.sh"],
  }),
  Object.freeze({
    id: "macos-arm64", name: "macOS · Apple Silicon", entrypoint: "scripts/setup-macos.sh",
    nodeSuffix: "darwin-arm64.tar.gz", updater: false, implemented: true, tunnel: true,
    description: "macOS Apple Silicon · 本人 launchd 服务 · 私有 DevTunnel · 不改现有 Codex/模型代理",
    files: ["scripts/setup-macos.sh", "scripts/configure-macos.py", "scripts/macos-service.py"],
  }),
  Object.freeze({
    id: "macos-x64", name: "macOS · Intel", entrypoint: "scripts/setup-macos.sh",
    nodeSuffix: "darwin-x64.tar.gz", updater: false, implemented: true, tunnel: true,
    description: "macOS Intel · 本人 launchd 服务 · 私有 DevTunnel · 不改现有 Codex/模型代理",
    files: ["scripts/setup-macos.sh", "scripts/configure-macos.py", "scripts/macos-service.py"],
  }),
]);

export function machinePlatform(id = "linux-x64") {
  const platform = MACHINE_PLATFORMS.find((item) => item.id === id);
  if (!platform?.implemented) throw requestError("此平台尚未提供完整机器配置脚本，不会回退到 Linux 安装器", 400);
  return platform;
}
