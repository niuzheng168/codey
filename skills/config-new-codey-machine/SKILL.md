---
name: config-new-codey-machine
description: "跨平台安装和管理 Codey：复用 gh 的 Copilot/DevTunnel 认证、后台守护与节点启停、状态诊断、备份恢复和本地包更新。保留已有账号与 TLS/SSO，仅导出私有注册 JSON，不自动注册 Portal。"
---

# Codey 安装与日常操作

> 本次变更尚未发布；Windows/macOS 原生验收另行完成。
> 只在用户确认目标机器和操作范围后安装；代码评审、测试不等于允许部署或发布。

## 按操作选择命令

日常操作使用以下 CLI，不重跑安装、不临时拼装各平台的服务脚本。节点管理操作要求已完成本机安装；仅安装 npm 运行包时可用前台模式。

| 操作 | 命令 | 作用 |
| --- | --- | --- |
| 1. Copilot 登录/单独启动 | `codey copilot login` / `codey copilot start` | 保留已有凭据，否则自动复用 gh；确需重新设备码登录用 `login --force`。start 保留 Responses＋用量和已配置的 `8443` HTTPS 入口 |
| 2. DevTunnel 登录 | `codey devtunnel login` | 保留已有 GitHub 登录，否则自动复用 gh，均不可用时才设备码登录；不自动切换其他 provider |
| 3. 隧道启停 | `codey devtunnel start` / `stop` | 单独管理本节点 host、续期及健康守护，不启停 Workspace/网关，不删除云端隧道 |
| 4. 节点状态 | `codey status [--json]` | 版本、节点与各原生服务状态；只读，不输出密钥 |
| 5. 节点启停 | `codey start` / `restart` / `stop` | 管理 Copilot API＋CloudCLI（Workspace）＋DevTunnel 整个后台节点；停止时禁用守护，直到再次 start |
| 后台守护 | `codey guard [--json] [--timeout SECONDS]` | 启用并启动已安装的应用/隧道保活、token 续期和 Linux 隧道健康监测；与后台 start 共用幂等流程，不新增常驻层 |
| 6. 组件检查 | `codey doctor [--json]` | 包/原生模块、工具、服务、端口、凭据存在、隧道连接、证书和本地 TLS/SSO/鉴权；`--model` 才调用真实模型 |
| 7. 压缩备份/恢复 | `codey export FILE.gz` / `codey import FILE.gz` | 备份文件型 key/token/设置与节点证书；恢复先 `--check`，确认覆盖后加 `--replace-existing` |
| 8. 从包更新 | `codey update FILE.tgz` | 先 `--check`；Linux 支持 `--background`，在 Codex/Workspace 内自动交给独立一次性任务，短暂断连后重连；用 `update --status` 确认完成 |

各命令的用途、长短参数、默认值、约束和示例见 **[Codey 命令行参考](references/codey-cli.md)**：按 `codey <命令>` 分组，Copilot/DevTunnel 的子命令分别说明；回答 CLI 问题或拼接命令时只读对应项，不猜参数。
安装只走下方安装脚本；公开 `setup/workspace/gateway/auth/mcp` 入口均已删除。`guard` 不安装或重建服务，未完成安装时停止。
`codey start --foreground` 才是前台 Workspace＋网关，不启动隧道；后台节点已运行时不要重复开前台。改前台端口不会重配后台节点。
CloudCLI 统一由 `codey start` 启动，没有独立子命令。`copilot start` 只运行 API，不启动 CloudCLI 或隧道。
备份含秘密且**未加密**，只能保存在用户 Home 内的私有文件，不上传聊天；不备份程序/依赖、数据库/项目/会话或系统凭据库。恢复后用 `devtunnel login`、`doctor` 验证。
完整恢复限同一节点/用户/平台；跨节点用 `import --settings-only`，只迁移网关/Codex 文件设置与凭据，保留目标节点身份。节点密钥或证书变化需重新接入/固定 Portal 凭据。
更新保留配置、身份、工具、证书和原版本；捕获到失败时回退，不增加 Python、Portal 更新代理或常驻更新器。中断留下 `install.lock` 时先核对状态，不强删锁重试。
不要使用 `copilot login --show-token` 做普通诊断。停止/重启、恢复，以及 Windows/macOS 更新仍在原用户的外部终端运行。
Linux 后台更新无须退出客户端，不等于零中断：进行中的请求、工作区终端命令可能被中断，不自动重放。先保存工作，长任务结束后再切换。
提交成功只表示已排队，不表示已升级；以 `codey update --status` 的 `completed` 及 `codey doctor` 为准。独立任务接管同一操作锁，断连后不能重复提交、强删锁；失败或未知状态先核对私有报告。旧版 CLI 不具备此行为，第一次升级仍需外部原用户终端或经授权的一次性原生任务。

## GitHub 认证复用

- 已有 `gh auth login` 时，无自身凭据的 Copilot/DevTunnel 自动复用该账号；
  不需要再次授权两个应用。`gh` 是可选依赖，不自动安装、登录或增加 scopes。
  没有可用 gh 时，显式 login/安装仍可走原设备码流程；start/guard/doctor 不弹登录。
- 已有独立凭据优先，不能因为 gh active account 不同就切换现有模型配额/隧道所有者。
  首次复用记录账号 ID、用户名、gh 可执行文件与配置目录；不复制 gh token，不随
  `gh auth switch` 自动换号。失效的 pinned 账号停止并报告，不尝试另一个账号。
- **全新 Mac 节点例外**：先验证并复用 gh，不先执行会读取系统钥匙串的
  `devtunnel user show`；没有可用 gh 时才走原生登录路径。已有节点的认证绑定不变。
  Codey 不保存 gh token；gh 自身采用的存储仍须能被原用户非交互读取。
- 普通 `GH_TOKEN`/`GITHUB_TOKEN` 不替代 gh 的登录缓存；显式
  `COPILOT_API_GITHUB_TOKEN`、OAuth app、Enterprise 设置仍优先。
  gh 模式下原始 `devtunnel user show` 可以仍显示未登录，用 `codey doctor` 检查。
- 既有节点切换到 gh 隧道认证前，验证该账号能访问原 tunnel ID；不重建 404 的隧道。
  隧道正在运行时先由用户 `codey devtunnel stop`，再 login/start，不借登录重启其他服务。
  备份不含 gh 登录缓存；settings-only 导入也不覆盖目标机器的 gh 账号绑定。

## 用户执行时的依赖

- **Linux x64**：Bash、curl、tar/xz、OpenSSL、`ss`（iproute2）等基础工具、systemd 用户服务；开启 linger 等操作需 sudo。
- **Windows x64**：PowerShell 5.1、.NET Framework 4.7.2+、任务计划程序；使用原用户的非管理员终端。
- **macOS arm64/x64**：原生终端与 GUI 登录会话；使用系统 Bash、curl、tar、OpenSSL、plutil、shasum、launchctl、lsof/ps。
- 脚本准备 Node/npm、官方 Codex CLI、Microsoft DevTunnel CLI 和 Codey 应用依赖；需联网并能完成 GitHub/Copilot 登录。
- 可选的 GitHub CLI：若已安装且已登录，自动复用；后台用已记录的绝对路径读取原账号，
  不依赖 LaunchAgent/systemd 的交互式 PATH。OS 安全存储须对原用户可用且已解锁；
  Linux keyring 使用运行时的 D-Bus/XDG 会话，不把会话地址或秘密复制进账号绑定。
- **正常流程不要求预装 Python 或 Bun。** 若 npm 回退源码编译并索要 Python，停止报告具体模块，不擅自加装工具链。
- macOS 默认优先复制本用户已有的完整官方 standalone Codex（稳定版 0.152.0+），核对 OpenAI 签名、
  原生架构、版本和伴随文件；不覆盖原有程序，不采用 npm shim、Desktop 缓存或单独的可执行文件。
  找不到兼容安装才下载最新版；发现完整包但签名/完整性异常时停止，不绕过检查。

## 完整安装入口

在解压后的完整 Skill 目录运行，不能只拿一个脚本或 npm 包当作完整节点安装。

| 平台 | 检查/计划 | 确认后安装 |
| --- | --- | --- |
| Linux | `bash scripts/install-npm.sh --package assets/codey-*.tgz --check` | 去掉 `--check`，加 `--expected-computer "实际机名"` |
| Windows | `powershell.exe -NoProfile -File .\scripts\install.ps1` | 加 `-Apply -NetworkApproved -ExpectedComputerName "实际机名"` |
| macOS | `bash scripts/install-macos.sh --check` | 改用 `--apply --network-approved --expected-computer "实际机名"` |

三平台共用 `scripts/install-machine.mjs` 的 Node 安装流程，入口只做原生预检和必要的 Node 引导；不再维护三套安装编排。
已有 Node 时也可直接运行 `node scripts/install-machine.mjs --check`，确认后改用 `--apply --network-approved --expected-computer "实际机名"`。
Linux 与其他 Codex 服务共存时，可用 `CODEX_HOME="$HOME/.local/share/codey-machine/codex-home"` 调用上述完整 Skill 入口；
只检查该目录的使用冲突和安装器进程祖先，不停止其他独立 `CODEX_HOME` 的服务，也不覆盖共享 `~/.codex`。
首次配置节点需覆盖已有 Codex 配置（Linux 也包括网关配置）时，另行确认并加 `--replace-existing`（Linux/Mac）或 `-ReplaceExisting`（Windows）；先备份，保留 auth/sessions。
**安装预检均只读**：不下载、不运行 npm、不写配置、不登录、不启动服务或调用模型。缺少 Node 等导致不能检查的项目明确标为待检查，不当作已通过。
已完成的同版本、同配置节点允许继续验收和导出；复用现有程序、身份、证书、密钥，不覆盖运行版本、不重启服务，不把重跑安装当更新。
独立的 `node install-codey.mjs` 只安装运行包；其 `--check` 也只读，`--no-launcher` 才是安装依赖但不改 CLI/PATH。

### 失败续装、镜像与耗时

先核对失败状态，再使用 `--retry-failed`（Windows：`-RetryFailed`）。当前安装器用 `application.json` 分阶段记录 Node 和应用，也兼容此前的 `prepared.json`；核对用户/平台/发行版、Node 和包摘要、依赖树及原生模块后原地继续，不复制 `node_modules`、不重新下载 Node。没有准备凭据的旧失败目录不能直接认领。
已校验的 DevTunnel/Codex 使用本机私有摘要凭据复用；Windows 官方 Codex junction 只允许解析到本节点拥有的 standalone release，其他链接仍拒绝。准备文件或工具被修改时停止，不静默创建新目录绕过错误。

需要公共 npm 镜像时，Windows 加 `-Registry https://mirrors.cloud.tencent.com/npm/`，Node 共用入口和独立运行包安装器加 `--registry https://mirrors.cloud.tencent.com/npm/`；未指定参数时可用 `CODEY_NPM_REGISTRY` 设置本次安装的默认镜像。只接受不含账号、查询串的 HTTPS 地址；隔离用户/全局 npm 配置和 npm 凭据，保留锁文件完整性和 TLS 校验，不修改全局 npm 源。

Windows 在写入程序前检查指向安装目录的旧计划任务，即使端口暂时空闲也会阻止它们在安装中途自动启动。须由用户审查、备份并禁用/停止相关任务；安装器不会自动处理不明归属任务。
GitHub 登录后立即检查 GitHub 用户和 Copilot 访问权限，401/403 在下载 Codex、启动服务前报告。

安装输出阶段时间戳、耗时和每 10 秒的进度，私有配置目录保存不含凭据的 `install-timings.json`。不要固定等待 90/120 秒猜测进程是否完成，应观察退出码和阶段结果。
三分钟应分别计量“运行包＋依赖”和“完整空白机器节点”；后者还包含 Node/DevTunnel/Codex 下载、认证检查及真实模型响应。已有有效 gh 登录时不需设备授权；否则单独记录设备登录的人工等待。不得把缓存续装或只安装 `.tgz` 的成绩宣称为全新机器完整安装成绩。

### Mac 快速路径与失败重试

一次授权后直接执行 `--apply` 即包含预检；不必先反复测试镜像、逐项手工运行 doctor 或重装全部依赖。
安装器输出阶段耗时。若网络限制公共 npm，可在同一条安装命令前指定
`CODEY_NPM_REGISTRY=https://mirrors.cloud.tencent.com/npm`；也可指定其他可信 HTTPS registry。
只影响本次依赖安装，优先使用 npm 缓存；不修改全局 npm 配置、锁文件版本/SRI 或 TLS 校验。
不自动遍历镜像，也不在失败后无提示地换源重新下载。

失败后先查看报错阶段和私有状态，确认没有仍在运行的安装，再使用原命令加 `--retry-failed`。
`application.json` 分别记录已校验的 Node 和应用；重试检查摘要、包文件和原生模块后继续，
不重复下载已成功准备的 Node/DevTunnel/Codex，不创建另一份应用版本，不重复备份相同模型配置。
捕获到 npm 失败时仅删除本次新建的 app prefix；进程被强杀、残留锁或校验失败仍需人工审查。
旧布局或失效启动器在下载前报告，不自动卸载或认领旧服务。

新 Mac 节点用私有硬件 UUID 绑定机器，hostname 仅用于当前操作确认和展示；
网络切换导致 hostname 改变不会阻断继续安装。没有此标识的旧节点仍保留原来的机名检查。
普通 zsh/bash 终端从 `0600` 的 `provider.env` 加载模型 key，shell 配置不直接保存密钥。

**3 分钟是快速路径目标，不是冷安装保证**：首次 Node/依赖下载、用户设备登录、上游模型延迟和
Portal 手动导入均可能超出此预算。必须分开报告实测的包安装时间与完整节点接入时间，
不能用模拟测试或“本机完成”冒充已经在 Portal 添加成功。

## 完整安装流程

1. **预检**：确认原用户、原生系统/架构、机名、现有安装、配置覆盖和 `3001/4141/8443` 端口。
   端口空闲则继续；占用时，须由系统的 PID、所属用户、安装路径和启动配置确认来自本用户的 Codey，才复用并继续。
   任一端口属于其他程序或无法确认归属，立即终止安装；不凭进程名/健康页认领，不强杀、不自动改端口。配置服务前再次检查，防止检查后被抢占。
   旧 Python/升级代理节点须单独迁移；不要把重跑安装当作更新、卸载或事务恢复。
2. **准备本机状态和应用**：在原用户私有目录创建节点 ID、SSO/数据访问/隧道续期密钥；准备经校验的官方 Node/npm。
   将唯一 Codey npm 包装入新的私有目录，按锁文件准备依赖并检查 SQLite/PTY 等原生模块；同版本重跑先核对包文件，直接复用，不先装一遍 npm。
3. **DevTunnel**：与 `codey devtunnel login` 共用认证选择；已有节点/其他平台缓存优先，否则尝试 gh；
   全新 Mac 节点先尝试 gh，避免读取无关的 DevTunnel 钥匙串条目。
   只有两者都不存在时才设备码登录。gh 模式用管理 API 创建/检查隧道并签发限 scope token，
   官方 host CLI 只通过 stdin 接收 host-only token，不接收高权限 GitHub token。
   三平台均只从指定微软 HTTPS 地址下载 DevTunnel，不固定滚动文件的旧 SHA-256；Windows 额外校验微软 Authenticode 签名。Node/Codey 版本包和已安装文件的完整性校验仍保留。
   创建或复用私有 `codey-<nodeId>` 隧道，记录实际 tunnel/cluster ID；仅转发 HTTPS `3001/8443`，禁止匿名访问，不转发 `4141`。
4. **证书与配置**：生成本机模型 key，保留已有身份、证书与密钥，不生成升级凭据。
   本机生成自签名非 CA 服务端证书，SAN 为 `<nodeId>.nodes.codey.internal`；私钥只留私有目录，不购买域名、不导入系统根证书库。
   已接入节点不可静默换证书；续期或轮换须同步 Portal 的证书指纹。
5. **服务与模型**：安装官方 Codex CLI。`4141` 为带 API key 的本地模型网关；`3001` 为 HTTPS Workspace + Portal SSO；`8443` 为鉴权只读用量/历史接口。
   三者只监听 `127.0.0.1`，两项 HTTPS 共用节点证书。按需执行 `codey copilot login`；
   有 gh 时验证 Copilot 账号和模型目录、保存无 token 的账号绑定，网关采用 direct OAuth，
   不把 gh token 送入默认的 VS Code token-exchange 路径。配置 Codex 并保留 auth/sessions。
   模型配置统一来自 `templates/codex-config.toml`，平台脚本只填入本机模型目录路径。
   `8443` 是同一网关的第二个监听，不是更新器。当前 `4141` 为 HTTP 且含模型/管理接口，不能直接当作 HTTPS 只读入口；合并需另改 TLS 与鉴权，本流程暂保留隔离。
6. **启动与守护**：配置稳定的 `codey` 命令和用户 PATH，启动 Codey、DevTunnel host 与 connect token 定时续期。
   Linux 使用 systemd 用户服务与 linger，并保留隧道健康监测；Windows 使用计划任务；Mac 使用 Node worker + LaunchAgents。后两者依赖原用户登录。
   gh host 的 Node 凭据传递进程属于同一个原生服务；提前 5 分钟结束 host，由已有守护重启、
   重读 pinned gh 并签发新 host token。connect-only 令牌继续走独立续期，不新增守护服务。
   此后用 `codey guard` 启用/启动全部已有守护；也可沿用后台 `codey start`，二者不会重复拉起。用 `codey restart/stop` 重启或停止整节点。
7. **本机验收**：检查服务守护、隧道私有配置、TLS、SSO、数据鉴权和匿名拒绝；经授权并行执行 Codex CLI/SDK 短请求，各限时 60 秒、使用低推理强度并核对真实响应，不接受提示词回显。
   仅覆盖验收请求，不改变用户正常会话的模型/推理设置；两项请求均结束后才导出或回滚。
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
