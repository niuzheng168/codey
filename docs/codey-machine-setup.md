# Codey Linux / Windows / macOS 节点接入

当前源码已移除 Portal 更新代理、本地更新器与升级凭据。Mac 安装器、命令包装和
LaunchAgent worker 使用 Node，不再要求 Python。此变更尚未发布，原生 Windows/macOS
验收与旧节点迁移需单独完成。

完整操作以 [安装 Skill](../skills/config-new-codey-machine/SKILL.md) 为准；运行包的
CLI 参考见 [Codey 包说明](../packages/codey/README.md)。

## 一个发行包

同一份 `codey-<version>.tgz` 和 SHA-256 支持 Linux x64、Windows x64、macOS arm64/x64。
包含编译后的 Workspace、模型网关与统一依赖锁；不内置另一份应用、平台原生二进制、
`node_modules`、Python 脚本或升级器。原生 npm 依赖在目标机准备。

完整 `config-new-codey-machine.zip` 包含 Skill、平台依赖声明、Linux/Windows 原生入口、
公共 `install-machine.mjs`、三个原生平台适配、共享注册与验证工具，
以及唯一的应用 `.tgz`。不能把独立运行包安装成功当作节点已接入。

Portal 的 `POST /api/settings/machines/shared-skill` 仍提供一个跨平台下载入口。
新发布器拒绝夹带 Python 或升级器的运行包；新 Portal 不再提供声明包含升级器的旧 Skill，
不会为了维持下载入口而回退到旧安装器。发布新的完整 Skill 后该入口才可用。

## 安装与依赖

- Linux：Bash、curl、tar/xz、OpenSSL、ss、systemd 用户服务及必要的 sudo。
- Windows：原生 PowerShell 5.1、.NET Framework 4.7.2+、任务计划程序；不使用管理员终端。
- Mac：原生 GUI 登录会话、系统 Bash/curl/tar/OpenSSL/plutil/shasum/launchctl/lsof/ps；无 Node 时由薄引导准备。
- 脚本准备 Node/npm、官方 Codex 与 Microsoft DevTunnel；正常流程不要求 Python 或 Bun。
  若原生模块没有匹配的预编译文件并要求源码编译，停止说明缺失模块，不擅自安装 Python/编译工具链。

在完整 Skill 目录中：

```sh
# Linux：--check 只读，不下载、不运行 npm、不写配置
bash scripts/install-npm.sh --package assets/codey-*.tgz --check
# 确认目标后安装；覆盖已有 Codex 配置另加 --replace-existing
bash scripts/install-npm.sh --package assets/codey-*.tgz --expected-computer "$(hostname)"
```

```powershell
# Windows：默认只读计划；确认后增加 Apply/NetworkApproved/机名
powershell.exe -NoProfile -File .\scripts\install.ps1
powershell.exe -NoProfile -File .\scripts\install.ps1 -Apply -NetworkApproved -ExpectedComputerName $env:COMPUTERNAME
```

```sh
# Mac：检查只读；缺少 Node 的项目明确标记为待检查
bash scripts/install-macos.sh --check
bash scripts/install-macos.sh --apply --network-approved --expected-computer "$(hostname)"
```

已有 Codex config/models 的覆盖必须另行批准。原用户 auth/sessions、节点身份和数据不用于
修复升级器；不接管旧 Python/代理布局，也不覆盖未完成的更新事务。
独立 `node install-codey.mjs` 只安装运行包和 CLI，不配置服务、隧道或 Portal 注册。
三平台的依赖、身份、隧道、模型配置、验收和导出由同一个 Node 安装器编排；
原生脚本仅负责引导及系统操作。Linux 独立 npm 引导入口保留，通过包内私有安装模块调用公共流程，
不再经临时 metadata → Bash → 内联 Node 来回传递。Windows `-RepairServices` 重装分支已移除。
三平台共用 `templates/codex-config.toml`，只替换本机模型目录路径，避免配置各自漂移。

预检覆盖原用户、原生架构、机名、现有安装、配置覆盖和 `3001/4141/8443`：
端口空闲或经系统 PID/用户/路径/启动配置确认属于本用户 Codey 才继续。
其他程序占用或归属不明时终止，不按进程名猜测、不强杀清端口。配置服务前重新检查。
同版本、同配置的完成节点复用身份、证书和密钥，继续验收/导出，不覆盖运行版本或重启服务。

## 服务、证书与隧道

- 模型网关 HTTP `4141` 只监听 loopback，要求模型 API key。
- Workspace HTTPS `3001` 验证 Portal SSO；只读用量/历史 HTTPS `8443` 验证数据访问票据。
  `8443` 与 `4141` 属于同一网关进程，不是更新器端口。可以设计统一 HTTPS 网关，
  但不能直接把当前 HTTP `4141` 改作隧道入口：还需处理本地客户端证书信任、只读票据与模型/管理权限。
  本轮保留两个监听，避免为减少端口引入协议混用或关闭证书验证。
- 两项 HTTPS 共用本节点自签名非 CA 证书，SAN 为 `<nodeId>.nodes.codey.internal`。
  Portal 验证并绑定证书指纹；不购买域名、不导入系统根证书库，也不把私钥发送给 Portal。
  用户明确导出的私有设置备份包含私钥，须当作秘密保管。
- GitHub 私有 DevTunnel 仅转发 `3001/8443`，拒绝匿名访问，不暴露模型网关。
- systemd/计划任务/LaunchAgents 负责应用和隧道守护；connect token 定期续期。
  Mac 的守护包装使用同一 Node 运行时，不是另一套升级代理。

本机验收保留 TLS、SSO、匿名拒绝、数据鉴权、真实 Codex CLI/SDK 响应及隧道私有配置检查。
真实隧道连通性与 Portal 绑定在用户导入 JSON 时另行验收，安装器不调用 Portal 注册接口。
`codey doctor` 复用本机组件检查，`--model` 才执行真实模型请求；进程存活或本机体检不能替代 Portal 导入后的端到端验收。

## 注册与兼容边界

成功后在原用户 Home 输出 `codey-machine-registration.json`，Unix `0600`，Windows 为
原用户/SYSTEM 私有 ACL。它包含公开证书、connect-only token、三个互异的节点接入密钥、
Workspace subject/username，不包含 TLS 私钥、模型 key、GitHub 登录令牌或升级凭据。

导入仍验证登录、CSRF、平台、隧道、TLS、SSO、账号状态及节点归属；失败的激活不可访问，
相同身份重试保持幂等。旧 schema-2 文件可带合法的 `updaterCredential`，但会被忽略、
不会持久化或触发代理注册。旧节点的数据/认证格式不因此自动迁移。

节点总览改为按需 Workspace 健康检查，不建立状态上报代理；Workspace 版本不冒充 Codey
整包版本。当前可以在节点使用 `codey --version` 查询应用版本。

节点日常操作统一使用 `codey copilot login`、`codey devtunnel login/start/stop`、
`codey start/restart/stop`、`codey status` 和 `codey doctor`。
`codey setup` 已从公开 CLI 删除，安装全部交给安装脚本。`codey guard` 显式启用/启动已安装的全部原生守护，
覆盖应用/隧道保活、token 续期和 Linux 隧道健康监测；与后台 `start` 共用流程，不新增常驻层。
`start` 管后台整节点，包含 CloudCLI（Workspace）、Copilot API 和 DevTunnel；前台整组用 `start --foreground`。
单独启动 API 用 `codey copilot start`，同时提供 Responses 与用量接口，保留已配置的 `8443` 只读 HTTPS；
CloudCLI 统一由 `codey start` 启动；已删除 `workspace` 子命令，不再透传 `gateway/auth/debug/mcp` 命令树。
`codey export FILE.gz` / `import FILE.gz` 处理私有设置备份，恢复先用 `--check`，覆盖需 `--replace-existing`；
系统凭据库不在备份范围内，完整恢复限同一节点，跨节点用 `--settings-only` 保留目标身份。
`codey update FILE.tgz` 是一次性本地包更新，可先 `--check`，以 `--offline` 禁止下载；
不恢复 Portal 代理、常驻本地更新器或 Python，不把重跑安装当更新。
旧 `--update`、工具更新、恢复和旧离线更新包入口仍不支持。完整参数见 Skill 中的 CLI 参考。
统一 `codey uninstall` 尚未实现。安装会在原生 configRoot 中写出私有 `resources.json`，
列出程序版本目录、守护文件、原生服务、CLI/PATH 项与默认保留目录，不包含密钥。
删除前重新核对清单中的文件摘要、路径及服务归属；不整删 runtimeRoot，默认保留数据、凭据、项目和云资源。

## 构建与发布

```sh
npm run machine:build -- --output artifacts/codey-machine --portal-origin https://YOUR-PORTAL
```

不再需要 `--updater-public-key-file`。仍使用 main-only 来源门禁、冻结的子模块 gitlinks、
唯一锁文件、包摘要和独立发布器；构建端 Python/Bun 不属于用户执行 Skill 的依赖。
本地测试与构建不自动上传、发布或改动既有节点。发布前必须完成对应原生平台验收。
