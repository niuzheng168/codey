---
name: config-new-codey-machine
description: "跨平台安装和管理 Codey：Copilot/DevTunnel 登录、后台守护与节点启停、状态诊断、压缩备份恢复、本地包更新。安装保留 TLS/SSO，仅导出私有注册 JSON，不自动注册 Portal。"
---

# Codey 安装与日常操作

> 本次变更尚未发布；Windows/macOS 原生验收另行完成。
> 只在用户确认目标机器和操作范围后安装；代码评审、测试不等于允许部署或发布。

## 按操作选择命令

日常操作使用以下 CLI，不重跑安装、不临时拼装各平台的服务脚本。节点管理操作要求已完成本机安装；仅安装 npm 运行包时可用前台模式。

| 操作 | 命令 | 作用 |
| --- | --- | --- |
| 1. Copilot 登录/单独启动 | `codey copilot login` / `codey copilot start` | 登录保存凭据；start 前台运行 Responses＋用量 API，保留已配置的 `8443` HTTPS 只读入口 |
| 2. DevTunnel 登录 | `codey devtunnel login` | 检查现有 GitHub 账号，必要时设备码登录；与 Copilot 登录分开，不自动切换其他 provider |
| 3. 隧道启停 | `codey devtunnel start` / `stop` | 单独管理本节点 host、续期及健康守护，不启停 Workspace/网关，不删除云端隧道 |
| 4. 节点状态 | `codey status [--json]` | 版本、节点与各原生服务状态；只读，不输出密钥 |
| 5. 节点启停 | `codey start` / `restart` / `stop` | 管理 Copilot API＋CloudCLI（Workspace）＋DevTunnel 整个后台节点；停止时禁用守护，直到再次 start |
| 后台守护 | `codey guard [--json] [--timeout SECONDS]` | 启用并启动已安装的应用/隧道保活、token 续期和 Linux 隧道健康监测；与后台 start 共用幂等流程，不新增常驻层 |
| 6. 组件检查 | `codey doctor [--json]` | 包/原生模块、工具、服务、端口、凭据存在、隧道连接、证书和本地 TLS/SSO/鉴权；`--model` 才调用真实模型 |
| 7. 压缩备份/恢复 | `codey export FILE.gz` / `codey import FILE.gz` | 备份文件型 key/token/设置与节点证书；恢复先 `--check`，确认覆盖后加 `--replace-existing` |
| 8. 从包更新 | `codey update FILE.tgz` | 一次性校验、准备新版本、切换服务；先 `--check`，离线用 `--offline`，可用 `--sha256 HASH` 核对发行摘要 |

各命令的用途、长短参数、默认值、约束和示例见 **[Codey 命令行参考](references/codey-cli.md)**：按 `codey <命令>` 分组，Copilot/DevTunnel 的子命令分别说明；回答 CLI 问题或拼接命令时只读对应项，不猜参数。
安装只走下方安装脚本；公开 `setup/workspace/gateway/auth/mcp` 入口均已删除。`guard` 不安装或重建服务，未完成安装时停止。
`codey start --foreground` 才是前台 Workspace＋网关，不启动隧道；后台节点已运行时不要重复开前台。改前台端口不会重配后台节点。
CloudCLI 统一由 `codey start` 启动，没有独立子命令。`copilot start` 只运行 API，不启动 CloudCLI 或隧道。
备份含秘密且**未加密**，只能保存在用户 Home 内的私有文件，不上传聊天；不备份程序/依赖、数据库/项目/会话或系统凭据库。恢复后用 `devtunnel login`、`doctor` 验证。
完整恢复限同一节点/用户/平台；跨节点用 `import --settings-only`，只迁移网关/Codex 文件设置与凭据，保留目标节点身份。节点密钥或证书变化需重新接入/固定 Portal 凭据。
更新保留配置、身份、工具、证书和原版本；捕获到失败时回退，不增加 Python、Portal 更新代理或常驻更新器。中断留下 `install.lock` 时先核对状态，不强删锁重试。
不要使用 `copilot login --show-token` 做普通诊断。停止/重启、恢复和更新在原用户的外部终端运行。

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

三平台共用 `scripts/install-machine.mjs` 的 Node 安装流程，入口只做原生预检和必要的 Node 引导；不再维护三套安装编排。
已有 Node 时也可直接运行 `node scripts/install-machine.mjs --check`，确认后改用 `--apply --network-approved --expected-computer "实际机名"`。
首次配置节点需覆盖已有 Codex 配置（Linux 也包括网关配置）时，另行确认并加 `--replace-existing`（Linux/Mac）或 `-ReplaceExisting`（Windows）；先备份，保留 auth/sessions。
**安装预检均只读**：不下载、不运行 npm、不写配置、不登录、不启动服务或调用模型。缺少 Node 等导致不能检查的项目明确标为待检查，不当作已通过。
已完成的同版本、同配置节点允许继续验收和导出；复用现有程序、身份、证书、密钥，不覆盖运行版本、不重启服务，不把重跑安装当更新。
独立的 `node install-codey.mjs` 只安装运行包；其 `--check` 也只读，`--no-launcher` 才是安装依赖但不改 CLI/PATH。

## 完整安装流程

1. **预检**：确认原用户、原生系统/架构、机名、现有安装、配置覆盖和 `3001/4141/8443` 端口。
   端口空闲则继续；占用时，须由系统的 PID、所属用户、安装路径和启动配置确认来自本用户的 Codey，才复用并继续。
   任一端口属于其他程序或无法确认归属，立即终止安装；不凭进程名/健康页认领，不强杀、不自动改端口。配置服务前再次检查，防止检查后被抢占。
   旧 Python/升级代理节点须单独迁移；不要把重跑安装当作更新、卸载或事务恢复。
2. **准备本机状态和应用**：在原用户私有目录创建节点 ID、SSO/数据访问/隧道续期密钥；准备经校验的官方 Node/npm。
   将唯一 Codey npm 包装入新的私有目录，按锁文件准备依赖并检查 SQLite/PTY 等原生模块；同版本重跑先核对包文件，直接复用，不先装一遍 npm。
3. **DevTunnel**：使用与 `codey devtunnel login` 相同的登录逻辑，检查本人 GitHub 登录，必要时设备码登录；不切换其他账号。
   三平台均只从指定微软 HTTPS 地址下载 DevTunnel，不固定滚动文件的旧 SHA-256；Windows 额外校验微软 Authenticode 签名。Node/Codey 版本包和已安装文件的完整性校验仍保留。
   创建或复用私有 `codey-<nodeId>` 隧道，记录实际 tunnel/cluster ID；仅转发 HTTPS `3001/8443`，禁止匿名访问，不转发 `4141`。
4. **证书与配置**：生成本机模型 key，保留已有身份、证书与密钥，不生成升级凭据。
   本机生成自签名非 CA 服务端证书，SAN 为 `<nodeId>.nodes.codey.internal`；私钥只留私有目录，不购买域名、不导入系统根证书库。
   已接入节点不可静默换证书；续期或轮换须同步 Portal 的证书指纹。
5. **服务与模型**：安装官方 Codex CLI。`4141` 为带 API key 的本地模型网关；`3001` 为 HTTPS Workspace + Portal SSO；`8443` 为鉴权只读用量/历史接口。
   三者只监听 `127.0.0.1`，两项 HTTPS 共用节点证书。按需执行 `codey copilot login`，配置 Codex 并保留 auth/sessions。
   模型配置统一来自 `templates/codex-config.toml`，平台脚本只填入本机模型目录路径。
   `8443` 是同一网关的第二个监听，不是更新器。当前 `4141` 为 HTTP 且含模型/管理接口，不能直接当作 HTTPS 只读入口；合并需另改 TLS 与鉴权，本流程暂保留隔离。
6. **启动与守护**：配置稳定的 `codey` 命令和用户 PATH，启动 Codey、DevTunnel host 与 connect token 定时续期。
   Linux 使用 systemd 用户服务与 linger，并保留隧道健康监测；Windows 使用计划任务；Mac 使用 Node worker + LaunchAgents。后两者依赖原用户登录。
   此后用 `codey guard` 启用/启动全部已有守护；也可沿用后台 `codey start`，二者不会重复拉起。用 `codey restart/stop` 重启或停止整节点。
7. **本机验收**：检查服务守护、隧道私有配置、TLS、SSO、数据鉴权和匿名拒绝；经授权执行有超时的 Codex CLI/SDK 短请求并核对真实响应，不接受提示词回显。
   日常以 `codey status`、`codey doctor` 检查，经授权再用 `codey doctor --model`；本机检查不能替代导入后从 Portal 完成的真实访问验收。
8. **导出 JSON，安装到此结束**：取得新鲜 connect-only token，在原用户 Home 写出私有 `codey-machine-registration.json`。
   内容包含平台、节点/隧道信息、公开证书和节点接入凭据，不含 TLS 私钥、模型 key 或 GitHub 登录令牌；Unix 权限 `0600`，Windows 为原用户/SYSTEM 私有 ACL。
   只报告文件绝对路径和验收结果，不在聊天中粘贴凭据。**不调用 Portal 注册/导入接口**；仅报告“本机完成，待接入”。
   用户自行导入 Portal，另行完成真实隧道/TLS/SSO 验收，随后删除注册文件。connect token 续期守护仍保留，不是注册代理。

## 删除与边界

当前尚无统一 `codey uninstall` 命令，不把它写成已可用功能。
安装记录私有 `resources.json`：Linux 在 `~/.config/codey-machine/`，Windows/Mac 分别为 `codey-machine-windows/`、`codey-machine-macos/`。
清单列出程序、原生服务、CLI/PATH 项及保留目录，不包含密钥，也不是升级事务日志。
删除时读取清单，重新核对实际用户、路径、文件摘要和服务归属；获准后停止并移除确认属于本安装的项目。清单本身不构成删除授权。
默认保留配置、登录凭据、Codex auth/sessions 和数据；失败安装中未验证的资源须先人工核对。
程序只清理确认过的版本目录，不整删 `runtimeRoot`，其中可能含数据和登录凭据。
不删除项目、共享工具、其他程序的配置/会话，不自动删除 Portal 记录或云端隧道。

只在原用户的外部终端操作，不从 Codey/Codex 进程树内安装；需要的额外权限单独确认。
不从公共 npm 安装同名 `codey` 项目。未知归属、未完成事务或安全校验失败时停止，不强制接管。
