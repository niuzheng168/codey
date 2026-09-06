# CloudCLI Workspace：独立服务与门户 SSO

这里只部署独立的 CloudCLI，不替换 copilot-api 或全局 Codex。先确认目标用户
确实有权通过网页读写该机器的文件、运行 Codex 与终端。一个部署绑定一个 owner，
不是把一个 Linux 账号中的多个目录当作多租户隔离。

## 源码与构建边界

使用当前 Codey 工作区 `cloudcli/` 的改版源码；用户 fork 是
`https://github.com/niuzheng168/claudecodeui`。先核实实际分支、未提交改动和
Codey SSO/TLS/子路径补丁；仅拉 fork 默认分支或上游最新版不保证包含部署补丁。
遵循其 AGPL 及随包许可证要求，不覆盖用户 dirty checkout。

该部署要求：

```dotenv
VITE_BASE_PATH=/cloudcli/<enrollment.nodeId>/
VITE_CODEY_MANAGED=true
VITE_CODEY_PORTAL_SSO=true
```

这是**编译期**设置，不是改运行环境就能修复静态资源路径。源码包在解压根目录
必须有 `package.json`、lockfile、前后端源码及许可证；不得带入 `.env`、
`node_modules`、数据库、SSH key 或其他用户的 `.codex`。

先确认锁文件及 native dependencies 支持的 Node 版本。当前 Linux 安装脚本限定
22–25；必要时选择已有兼容版本或独立 runtime，不能更改全局 nvm/default Node。
选择真实 Codex 可执行文件，避免旧 `/usr/bin/codex` 遮盖用户安装版本。

## Linux：先 stage，不使用旧自动激活路径

仓库脚本的 **`--stage-only`** 只构建新 release，不切换正在运行的 CloudCLI：

```bash
bash scripts/linux/install-codey-cloudcli.sh \
  --archive /path/to/reviewed-cloudcli-source.tar.gz \
  --node-id '<enrollment.nodeId>' \
  --host '<VM_PRIVATE_IP>' \
  --runtime-bin /path/to/compatible-node/bin \
  --codex-bin /path/to/current/codex \
  --portal-sso --stage-only
```

确认当前 shell 运行于目标 VM owner 对应的 OS 账号，并替换所有占位符。
`--runtime-bin`、`--codex-bin` 可在正确运行环境下省略。脚本会执行测试、typecheck、
build，并在 `~/.local/share/codey-cloudcli/staged-release` 记录新目录。

不要直接去掉 `--stage-only`：现有普通安装路径最后使用 HTTP health probe，
而 managed SSO 使用 HTTPS。也不要对新机器直接运行
`activate-codey-cloudcli-sso.sh`：该脚本是旧部署迁移器，假设 previous release、
既有数据库和特定迁移目录已经存在。应按下面的首次安装流程生成配置，或在另一个
明确授权的代码任务中改造安装器。

## 配置 owner 与 TLS

创建 `~/.config/codey-cloudcli/portal-sso.env`，仅服务账号可读（`0600`）：

```dotenv
CODEY_PORTAL_SSO=true
CODEY_PORTAL_NODE_ID=<enrollment.nodeId>
CODEY_PORTAL_USERNAME=<enrollment.username>
CODEY_PORTAL_PRINCIPAL_ID=<enrollment.principalId>
CODEY_PORTAL_SSO_KEY=<enrollment.workspaceSsoKey>
CODEY_PORTAL_TLS_CERT=<节点fullchain.pem绝对路径>
CODEY_PORTAL_TLS_KEY=<节点server.key.pem绝对路径>
```

这些值取自本节点接入资料；不是 Linux 用户名、别人的 principal、门户密码、
client key 或 ACA master。EnvironmentFile 内使用绝对路径，不依赖 `$HOME` 展开。
可以只读复用该节点 copilot-api 的 leaf 证书，不复制 CA private key。

若 Codex config 引用 provider `env_key`，将对应用户已有 provider 凭据保存到
独立受保护的 `provider.env`，不打印值、不覆盖其他工作环境，不重做用户的 Codex
登录。已有文件不得因当前 shell 未设置变量而被截断。

首次安装可按当前服务约定生成以下 systemd user unit，替换私有 IP 并检查实际路径：

```ini
[Unit]
Description=Codey CloudCLI node workspace
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment=HOME=%h
Environment=PATH=%h/.local/share/codey-cloudcli/current/.codey-bin:%h/.local/bin:/usr/local/bin:/usr/bin:/bin
Environment=NODE_ENV=production
Environment=CODEY_MANAGED=true
Environment=HOST=<VM_PRIVATE_IP>
Environment=SERVER_PORT=3001
Environment=DATABASE_PATH=%h/.local/share/codey-cloudcli/data/auth.db
EnvironmentFile=-%h/.config/codey-cloudcli/provider.env
EnvironmentFile=%h/.config/codey-cloudcli/portal-sso.env
WorkingDirectory=%h/.local/share/codey-cloudcli/current
ExecStart=%h/.local/share/codey-cloudcli/current/.codey-bin/node %h/.local/share/codey-cloudcli/current/dist-server/server/index.js
Restart=on-failure
RestartSec=5s
NoNewPrivileges=true
PrivateTmp=true
UMask=0077

[Install]
WantedBy=default.target
```

安装前核实 `3001` 未被其他进程使用。启动时必须存在 SSO env；不能用可选文件
掩盖缺失的 SSO 配置。stage 的 `.codey-bin` 固定了 Node/Codex；Snap runtime 使用
真正的可执行文件，不能让需要额外权限的 `/snap/bin/node` launcher 与
`NoNewPrivileges` 冲突。资源限额由当前机器 workload 决定，不照抄别台机器的限额。

## 激活和回退

1. 记录已有 unit、release symlink、CloudCLI/copilot PID 和 VM boot ID。
   若已有 `data/auth.db`，用 SQLite online backup API 备份（包含 WAL 中的事务），
   不把直接复制活动 DB 当成完整备份。不动 `~/.codex`、项目或其他用户目录。
2. 核实 `staged-release` 的解析绝对路径位于预期的 `releases/` 内、shim 和
   `dist-server/server/index.js` 存在。准备 `data/`、env、unit 后，原子切换
   `current` symlink。首次安装无 previous；升级必须保留 previous。
3. 只 reload user units、enable/start 或 restart **`codey-cloudcli.service`**。
   不重启 copilot-api、SSH、网络或 VM。需要 linger 才能退出 SSH 后继续运行时，
   另行说明并确认 OS 级设置，不默认执行。
4. 使用正确 SNI/CA 验证 HTTPS `/health`；匿名 `/api/auth/status` 应 `401`。
   然后经 ACA `/cloudcli/<nodeId>/` 验证免二次登录、静态资源、WebSocket 和终端。
5. 有限次健康探测仍失败就停止本次激活；升级恢复原 unit/env/symlink 并仅重启
   CloudCLI，首次安装则仅停止新建 CloudCLI。保留数据与诊断，不循环重装。
   已修改数据库 schema 时先确认旧版本兼容，不能盲目覆盖数据库回退。

Windows/macOS 没有在本仓库中验证过同等的 CloudCLI 一键部署器。需要这类
Workspace 时先检查 fork 的 native PTY/SQLite 兼容性，使用该 OS 的独立服务管理
方式；不能声称 Linux 脚本直接支持它们。只做 `8443` 直连无需部署 CloudCLI。

网络放行与 ACA 上游配置继续 [VNet](vnet.md)，最终按 [验收](verification.md) 检查。
