import { requestError } from "./signed-store.mjs";

const nativeFiles = (platform, names) => names.map(name => `scripts/codey_node/platforms/${platform}/${name}`);
const defaultsFiles = [
  "templates/a100-models.json",
  ...["config_defaults.py", "config_files.py", "toml_edit.py"].map(name => `scripts/codey_node/common/${name}`),
];

export const MACHINE_PLATFORMS = Object.freeze([
  Object.freeze({
    id: "windows-x64", name: "Windows", entrypoint: "scripts/setup-windows.ps1",
    nodeSuffix: "win-x64.zip", updater: false, implemented: true, tunnel: true, privateNetwork: true, dataRelay: true,
    description: "Windows x64 · GitHub 私有 DevTunnel · 登录后运行 · 保留现有 Codex/模型代理",
    files: [...defaultsFiles, "scripts/setup-windows.ps1", ...nativeFiles("windows", [
      "__init__.py", "install.py", "build.py", "cli.py", "preflight.py", "package.py",
      "archives.py", "helpers.py", "owner.py", "process.py", "codex_runtime.py",
      "supervisor.py", "windows-tunnel-tasks.ps1",
    ])],
  }),
  Object.freeze({
    id: "linux-x64", name: "Linux", entrypoint: "scripts/setup-linux.sh",
    nodeSuffix: "linux-x64.tar.xz", updater: true, implemented: true, tunnel: true, privateNetwork: true,
    description: "Linux x64 · GitHub 私有 DevTunnel · systemd 用户服务 · 独立签名升级器",
    files: [...defaultsFiles, "scripts/setup-linux.sh", ...nativeFiles("linux", [
      "__init__.py", "install.py", "build.py", "cli.py", "legacy_takeover.py", "systemd.py", "supervisor.py",
    ])],
  }),
  Object.freeze({
    id: "macos-arm64", name: "macOS · Apple Silicon", entrypoint: "scripts/setup-macos.sh",
    nodeSuffix: "darwin-arm64.tar.gz", updater: false, implemented: true, tunnel: true, dataRelay: true,
    description: "macOS Apple Silicon · GitHub 私有 DevTunnel · 本人 launchd 服务 · 不改现有 Codex/模型代理",
    files: [...defaultsFiles, "scripts/setup-macos.sh", ...nativeFiles("macos", [
      "__init__.py", "install.py", "build.py", "process.py", "launchd.py", "supervisor.py",
    ])],
  }),
  Object.freeze({
    id: "macos-x64", name: "macOS · Intel", entrypoint: "scripts/setup-macos.sh",
    nodeSuffix: "darwin-x64.tar.gz", updater: false, implemented: true, tunnel: true, dataRelay: true,
    description: "macOS Intel · GitHub 私有 DevTunnel · 本人 launchd 服务 · 不改现有 Codex/模型代理",
    files: [...defaultsFiles, "scripts/setup-macos.sh", ...nativeFiles("macos", [
      "__init__.py", "install.py", "build.py", "process.py", "launchd.py", "supervisor.py",
    ])],
  }),
]);

export function machinePlatform(id = "linux-x64") {
  const platform = MACHINE_PLATFORMS.find((item) => item.id === id);
  if (!platform?.implemented) throw requestError("此平台尚未提供完整机器配置脚本，不会回退到 Linux 安装器", 400);
  return platform;
}
