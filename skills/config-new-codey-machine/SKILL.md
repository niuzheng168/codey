---
name: config-new-codey-machine
description: "按完整发行包安装 Linux、Windows、macOS Codey 节点，并说明命令行与删除边界；不安装 Portal 或本地更新器。"
---

# Codey 节点安装与命令行

> 当前源码已移除两套更新器并改用 Node 执行 Mac 安装/守护，尚未发布；Windows/macOS 原生验收另行完成。
> 只在用户确认目标机器和操作范围后安装；代码评审、测试不等于允许部署或发布。

## 用户执行时的依赖

- **Linux x64**：Bash、curl、tar/xz、OpenSSL、`ss`（iproute2）等基础工具、systemd 用户服务；开启 linger 等操作需 sudo。
- **Windows x64**：PowerShell 5.1、.NET Framework 4.7.2+、任务计划程序；使用原用户的非管理员终端。
- **macOS arm64/x64**：原生终端与 GUI 登录会话；使用系统 Bash、curl、tar、OpenSSL、plutil、shasum、launchctl、lsof/ps。
- 脚本准备 Node/npm、官方 Codex CLI、Microsoft DevTunnel CLI 和 Codey 应用依赖；需联网并能完成 GitHub/Copilot 登录。
- **正常流程不要求预装 Python 或 Bun。** 若 npm 回退源码编译并索要 Python，停止报告具体模块，不擅自加装工具链。

## 完整安装入口

在解压后的完整 Skill 目录运行，不能只拿一个脚本或 npm 包当作完整节点安装。

| 平台 | 检查/计划 | 确认后安装 |
| --- | --- | --- |
| Linux | `bash scripts/install-npm.sh --package assets/codey-*.tgz --check` | 去掉 `--check`，加 `--expected-computer "实际机名"` |
| Windows | `powershell.exe -NoProfile -File .\scripts\install.ps1` | 加 `-Apply -NetworkApproved -ExpectedComputerName "实际机名"` |
| macOS | `bash scripts/install-macos.sh --check` | 改用 `--apply --network-approved --expected-computer "实际机名"` |

Linux 只走“npm 安装 → `codey setup`”，不再维护独立的暂存/切换安装流程；Windows 的 `-RepairServices` 重装入口已移除。
首次配置节点需覆盖已有 Codex 配置（Linux 也包括网关配置）时，另行确认并加 `--replace-existing`（Linux/Mac）或 `-ReplaceExisting`（Windows）；先备份，保留 auth/sessions。
Linux 入口先检查端口；`--check` **随后仍会下载、安装和检查 npm 依赖**，但不部署服务。
已完成的同版本、同配置节点允许继续验收和导出；复用现有程序、身份、证书、密钥，不覆盖运行版本、不重启服务，不把重跑安装当更新。
Mac 缺少 Node 时，检查只说明引导计划；获准安装后下载并校验官方 Node，再执行完整预检。
独立的 `node install-codey.mjs` 仍只安装运行包，不配置隧道、证书或后台服务。

## 完整安装流程

1. **预检**：确认原用户、原生系统/架构、机名、现有安装、配置覆盖和 `3001/4141/8443` 端口。
   端口空闲则继续；占用时，须由系统的 PID、所属用户、安装路径和启动配置确认来自本用户的 Codey，才复用并继续。
   任一端口属于其他程序或无法确认归属，立即终止安装；不凭进程名/健康页认领，不强杀、不自动改端口。配置服务前再次检查，防止检查后被抢占。
   旧 Python/升级代理节点须单独迁移；不要把重跑安装当作更新、卸载或事务恢复。
2. **准备应用**：从官方来源取得工具并校验，将唯一 Codey npm 包装到用户私有目录，按锁文件准备依赖，检查 SQLite/PTY 等原生模块。
3. **身份与证书**：生成节点 ID、模型 key、SSO/数据访问/隧道续期密钥，不再生成升级凭据。
   本机生成自签名非 CA 服务端证书，SAN 为 `<nodeId>.nodes.codey.internal`；私钥只留私有目录，不购买域名、不导入系统根证书库。
   已接入节点不可静默换证书；续期或轮换须同步 Portal 的证书指纹。
4. **DevTunnel**：检查本人 GitHub 登录，必要时设备码登录；不切换其他账号。
   创建或复用私有 `codey-<nodeId>` 隧道，记录实际 tunnel/cluster ID；仅转发 HTTPS `3001/8443`，禁止匿名访问，不转发 `4141`。
5. **服务与模型**：`4141` 为带 API key 的本地模型网关；`3001` 为 HTTPS Workspace + Portal SSO；`8443` 为鉴权只读用量/历史接口。
   三者只监听 `127.0.0.1`，两项 HTTPS 共用节点证书。按需单独完成 Copilot API 的 GitHub 登录，配置 Codex 并保留 auth/sessions。
   模型配置统一来自 `templates/codex-config.toml`，平台脚本只填入本机模型目录路径。
   `8443` 是同一网关的第二个监听，不是更新器。当前 `4141` 为 HTTP 且含模型/管理接口，不能直接当作 HTTPS 只读入口；合并需另改 TLS 与鉴权，本流程暂保留隔离。
6. **启动与守护**：配置稳定的 `codey` 命令和用户 PATH，启动 Codey、DevTunnel host 与 connect token 定时续期。
   Linux 使用 systemd 用户服务与 linger，并保留隧道健康监测；Windows 使用计划任务；Mac 使用 Node worker + LaunchAgents。后两者依赖原用户登录。
7. **验收**：检查服务守护、隧道云端 host、TLS、SSO、数据鉴权和匿名拒绝；经授权执行有超时的 Codex CLI/SDK 短请求并核对真实响应。
   不能只凭 npm 安装成功、PID 或 `doctor` 判定完整安装成功。
8. **接入 Portal**：取得新鲜 connect-only token，在原用户 Home 写出私有 `codey-machine-registration.json`。
   内容包含平台、节点/隧道信息、公开证书和节点接入凭据，不含 TLS 私钥、模型 key 或 GitHub 登录令牌；Unix 权限 `0600`，Windows 为原用户/SYSTEM 私有 ACL。
   只报告绝对路径。用户导入 Portal，经隧道/TLS/SSO 验收后绑定节点与证书指纹，再删除文件；导入前只报告“本机完成，待接入”。不注册升级代理。

## codey 命令行用法

`[...]` 为可选参数，`PORT`/`FILE` 替换为实际值；有空格的路径加双引号。

| 命令 | 用途 |
| --- | --- |
| `codey --help` / `codey --version` | 帮助 / 应用版本 |
| `codey doctor [--json] [--package-only]` | 检查运行包与原生模块；`--package-only` 跳过原生模块，不验证隧道、登录或模型 |
| `codey auth login --provider copilot` | 登录模型网关，与 DevTunnel 登录分开 |
| `codey start [--workspace-port PORT] [--gateway-port PORT]` | 前台运行 Workspace + 网关，默认 `127.0.0.1:3001/4141`；`Ctrl+C` 停止 |
| `codey workspace --host 127.0.0.1 --port 3001` | 仅前台运行 Workspace |
| `codey gateway` | 仅前台运行网关，默认 `127.0.0.1:4141` |
| `codey gateway debug --json` | 网关诊断；分享前脱敏 |
| `codey gateway --help` / `codey mcp --help` | 网关 / MCP 参数 |
| `codey setup [--config FILE] --check` | 只检查 Linux 运行包/公开配置，不部署服务 |
| `codey setup [--config FILE] --expected-computer NAME [--replace-existing]` | Linux 托管安装或同版本重复验收；不用于更新或恢复 |

启动命令不安装后台服务、不启动 DevTunnel；后台节点已运行时不要重复启动。
`codey update`、`codey --update` 及恢复/工具更新入口已移除，不提供替代的覆盖升级流程。

## 删除与边界

当前尚无统一 `codey uninstall` 命令，不把它写成已可用功能。
删除时先列出本安装拥有的原生服务、程序目录、CLI/PATH 项，获准后停止并移除；默认保留配置、登录凭据与数据。
程序只清理确认过的版本目录，不整删 `runtimeRoot`，其中可能含数据和登录凭据。
不删除项目、共享工具、其他程序的配置/会话，不自动删除 Portal 记录或云端隧道。

只在原用户的外部终端操作，不从 Codey/Codex 进程树内安装；需要的额外权限单独确认。
不从公共 npm 安装同名 `codey` 项目。未知归属、未完成事务或安全校验失败时停止，不强制接管。
