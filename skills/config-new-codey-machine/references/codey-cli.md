# Codey 命令行参考

对应当前源码，尚未发布。后台节点操作要求已完成本机安装；安装流程见 [Skill](../SKILL.md)。

## `codey copilot`

### `codey copilot login`

优先复用已有 Copilot 凭据；没有自身凭据时自动复用已登录的 GitHub CLI（gh）。
均不可用时才通过设备码登录。不会启动 API，也不登录 DevTunnel。

```text
codey copilot login [--api-home DIR] [--oauth-app APP] [--enterprise-url DOMAIN]
                    [--force] [--verbose] [--show-token]
```

| 参数 / 别名 | 取值与默认值 | 含义 |
| --- | --- | --- |
| `--api-home DIR` | 目录；`COPILOT_API_HOME`，否则 `~/.local/share/copilot-api` | 保存配置、凭据和用量数据；建议绝对路径 |
| `--oauth-app APP` | 字符串；`COPILOT_API_OAUTH_APP`，否则内置默认应用 | 选择 OAuth 应用；`opencode` 选择其内置应用，不是任意 OAuth client ID |
| `--enterprise-url DOMAIN` | 域名；`COPILOT_API_ENTERPRISE_URL`，否则 `github.com` | 使用指定 GitHub Enterprise 域名 |
| `--force` | 布尔；`false` | 跳过复用，明确重新进行 GitHub 设备码登录；由 Codey 处理，不传成上游参数 |
| `--verbose`, `-v` | 布尔；`false` | 输出详细登录日志 |
| `--show-token` | 布尔；`false` | 设备码登录流程可打印 token；复用已有/gh 凭据不打印。常规操作不要开启 |

默认不强制重新认证；固定为 Copilot，不接受 `--provider` 或 `--alias`。
显式 OAuth app/Enterprise 选择保留其自己的登录流程，不自动使用 github.com 的 gh 凭据。
值参数支持 `--name=value`；布尔参数可用 `--no-force`、`--no-verbose`、`--no-show-token` 或 `--name=false` 关闭。拒绝重复或未知参数。

gh 复用验证实际 GitHub 账号及 Copilot 模型访问权限，在 API home 的 `github-cli.json`
保存账号和 gh 路径，不复制 token。后续固定该账号，不跟随 `gh auth switch`，也不会被普通
`GH_TOKEN`/`GITHUB_TOKEN` 环境变量换号。已有独立 token 或显式 `COPILOT_API_GITHUB_TOKEN`
优先；失效凭据报错，不自动改用另一个账号。gh 缓存失效应由原用户重新 `gh auth login`。

**示例**

```sh
codey copilot login
codey copilot login --api-home "$HOME/.local/share/copilot-api" --verbose
codey copilot login --force
```

### `codey copilot start`

仅在前台运行 Copilot API，包含 Responses 和用量接口；`Ctrl+C` 停止。不启动 CloudCLI 或 DevTunnel。

```text
codey copilot start [--host HOST] [--port PORT] [--api-home DIR]
                    [--oauth-app APP] [--enterprise-url DOMAIN] [--verbose] [--proxy-env]
```

| 参数 / 别名 | 取值与默认值 | 含义 |
| --- | --- | --- |
| `--host HOST` | 地址；`127.0.0.1` | HTTP API 监听地址，不继承 `HOST`；非回环地址必须已配置 API key |
| `--port PORT`, `-p PORT` | 十进制整数 `1–65535`；`4141` | 模型与本地用量 API 的共用端口，不受 `SERVER_PORT` 影响 |
| `--api-home DIR` | 目录；`COPILOT_API_HOME`，否则 `~/.local/share/copilot-api` | 读取配置、凭据和用量数据；应与登录时一致 |
| `--oauth-app APP` | 字符串；`COPILOT_API_OAUTH_APP`，否则内置默认应用 | 与登录时使用同一个 OAuth 应用选择 |
| `--enterprise-url DOMAIN` | 域名；`COPILOT_API_ENTERPRISE_URL`，否则 `github.com` | 与登录时使用同一个 GitHub Enterprise 域名 |
| `--verbose`, `-v` | 布尔；`false` | 输出详细运行日志 |
| `--proxy-env` | 布尔；`false` | 启用 `HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY`；此参数不接收代理 URL |

- HTTP `4141` 提供 `POST /responses`、`POST /v1/responses`、`/usage`、`/token-usage` 及其 `/daily`、`/events` 接口。
- 已配置的节点保留同进程 HTTPS `8443` 只读用量/历史接口和现有证书、鉴权；`8443` 不提供 Responses。不在此命令中创建证书或后台服务。
- 启动不交互登录。依次使用显式 `COPILOT_API_GITHUB_TOKEN`、已保存的 token、已固定/当前
  gh 账号；显式 app/Enterprise 配置不自动回退 gh。gh 走 direct OAuth，不调用默认的 v2
  token exchange；选中账号仍须有 Copilot 权限。GitHub token 不等于客户端访问 API 的 key。
- 值参数支持等号写法；布尔参数支持 `--no-verbose`、`--no-proxy-env` 或 `--name=false`。内部固定 `headless`，不提供额外的上游启动参数。
- 改 HTTP 端口不会同步修改模型地址、HTTPS `8443` 或隧道；已有后台节点时不要重复启动。

**示例**

```sh
codey copilot start
codey copilot start --host 127.0.0.1 --port 4141 --proxy-env
```

## `codey devtunnel`

### `codey devtunnel login`

检查本节点的 DevTunnel GitHub 登录；没有自身登录时，自动尝试已登录的 gh。
两者都不可用才执行设备码认证，最长等待 15 分钟。

```text
codey devtunnel login
```

**参数：** 无业务参数。使用本节点保存的 DevTunnel 可执行文件和原用户环境。

已有 GitHub 登录直接复用；已有其他 provider 时停止，不自动切换账号。
gh 模式将账号绑定保存在原节点 runtime 配置，验证可以访问原 tunnel ID，准备三平台
host/续期/健康检查使用的限 scope 令牌通道；不写 GitHub token，不登录 Copilot、不创建或启动隧道。
首次从旧缓存模式改为 gh 时，若隧道正在运行，先停止本节点隧道再登录：

```sh
codey devtunnel stop
codey devtunnel login
codey devtunnel start
```

gh 模式不改原始 DevTunnel 登录缓存，因此 `devtunnel user show` 仍可能显示
`Not logged in`；用 `codey doctor` 检查实际身份、权限和 host 连接。

**示例**

```sh
codey devtunnel login
```

### `codey devtunnel start`

启动本节点的 DevTunnel host、connect token 续期和 Linux 隧道健康守护，不启动 CloudCLI 或 Copilot API。

```text
codey devtunnel start [--json] [--timeout SECONDS]
```

| 参数 / 别名 | 取值与默认值 | 含义 |
| --- | --- | --- |
| `--json` | 布尔；`false` | 输出脱敏节点状态 JSON；默认可读服务列表 |
| `--timeout SECONDS` | 整数 `1–600`；`60` 秒 | 等待相关服务达到启动状态的时限 |

重新启用被 stop 禁用的隧道守护；已运行组件不重复拉起。云端是否真正连接，用 `codey doctor` 检查。
停止状态下没有 DevTunnel 自身登录时可自动绑定 gh；无可用认证则报错，不弹设备码。
gh host 只从 stdin 获取 host-only token，过期前 5 分钟由现有原生守护轮换；
connect-only token 继续单独续期。网络/认证失败不是“host 离线”的证据，不据此反复重启。

**示例**

```sh
codey devtunnel start --timeout 120
```

### `codey devtunnel stop`

停止本节点的 DevTunnel host，并禁用续期、健康守护，防止它们自动重拉。

```text
codey devtunnel stop [--json] [--timeout SECONDS]
```

| 参数 / 别名 | 取值与默认值 | 含义 |
| --- | --- | --- |
| `--json` | 布尔；`false` | 输出脱敏节点状态 JSON；默认可读服务列表 |
| `--timeout SECONDS` | 整数 `1–600`；`60` 秒 | 等待相关服务停止的时限 |

在原用户外部终端执行。不停止 CloudCLI 或 Copilot API，不注销账号、不删除云端隧道；再次 start 才恢复守护。

**示例**

```sh
codey devtunnel stop --json
```

## `codey guard`

启用并启动全部已安装的后台守护，同时拉起它们管理的应用。命令完成本机检查后退出，守护继续由操作系统运行。

```text
codey guard [--json] [--timeout SECONDS]
```

| 参数 / 别名 | 取值与默认值 | 含义 |
| --- | --- | --- |
| `--json` | 布尔；`false` | 输出脱敏节点/服务状态 JSON；默认可读服务列表，不输出 key/token |
| `--timeout SECONDS` | 整数 `1–600`；`60` 秒 | 每个服务状态/本地验收等待阶段的时限，不是整个命令的总时限；值用空格分隔 |

守护范围：

- CloudCLI 和 Copilot API 的进程保活、异常退出后重启。
- DevTunnel host 的进程保活，以及 connect token 定期续期。
- Linux 额外启动隧道连接健康监测定时器；续期/健康检查任务由定时器触发，不另起常驻副本。

Linux 使用 systemd 用户服务，Windows 使用计划任务，macOS 使用 LaunchAgents；Windows/macOS 需要原用户登录会话。
与后台 `codey start` 共用同一幂等操作，重复执行不重启已运行组件。`codey stop` 停止整节点并禁用守护；只停隧道用 `codey devtunnel stop`。
必须已完成安装；不安装/重建服务、不登录、不改配置、不调用模型，也不增加常驻 Codey 进程或更新器。未知归属、校验失败或操作锁冲突时停止。

**示例**

```sh
codey guard
codey guard --timeout 120 --json
```

## `codey start`

默认启动整个后台节点：CloudCLI（Workspace）、Copilot API、DevTunnel 及守护。前台模式只运行前两者。

```text
codey start [--json] [--timeout SECONDS]
codey start --foreground [--host HOST] [--workspace-port PORT] [--gateway-port PORT]
```

| 参数 / 别名 | 取值与默认值 | 含义 |
| --- | --- | --- |
| `--json` | 布尔；`false` | 仅后台：输出脱敏节点状态 JSON，默认可读服务列表 |
| `--timeout SECONDS` | 整数 `1–600`；`60` 秒 | 仅后台：每个服务状态/本地验收等待阶段的时限 |
| `--foreground` | 布尔；`false` | 改为前台运行 CloudCLI＋Copilot API，不启动隧道或安装守护 |
| `--host HOST` | 地址；`127.0.0.1` | 仅前台：两项服务的共同监听地址，不继承 `HOST` |
| `--workspace-port PORT` | 十进制整数 `1–65535`；`SERVER_PORT`，否则 `3001` | 仅前台：CloudCLI 端口 |
| `--gateway-port PORT` | 十进制整数 `1–65535`；`4141` | 仅前台：模型网关端口，不受 `SERVER_PORT` 影响 |

- 后台模式先核对服务和端口归属，再启用服务并检查本地 TLS/SSO/网关；已运行组件不重复拉起。未安装时失败，不自动改为前台。
- 后台启动与 `codey guard` 相同；`guard` 是明确的守护入口，不是另一套运行方式。
- 前台 `Ctrl+C` 停止两个子进程，一项退出也会停止另一项。两端口必须不同；不能与后台的 `--json`、`--timeout` 混用。
- 参数值必须空格分隔，不支持等号写法。单独传 `--host`、`--workspace-port` 或 `--gateway-port` 也会选择前台；建议显式写 `--foreground`。
- CloudCLI 使用 `CODEY_CODEX_EXECUTABLE` 指定的官方 Codex；未设置时从 PATH 的绝对目录查找。`CODEX_HOME`、`CODEY_MODEL_API_KEY` 沿用安装配置。
- 改前台端口或终端环境不会重配后台服务、Codex 模型地址、隧道或 HTTPS `8443`；已有后台节点时不要再开前台实例。

**示例**

```sh
codey start --timeout 120
codey start --foreground --host 127.0.0.1 --workspace-port 3001 --gateway-port 4141
```

## `codey restart`

先完整停止，再启动后台节点的 CloudCLI、Copilot API、DevTunnel 及守护。

```text
codey restart [--json] [--timeout SECONDS]
```

| 参数 / 别名 | 取值与默认值 | 含义 |
| --- | --- | --- |
| `--json` | 布尔；`false` | 输出脱敏节点状态 JSON，默认可读服务列表 |
| `--timeout SECONDS` | 整数 `1–600`；`60` 秒 | 每个停止、启动、本地验收等待阶段的时限，不是总时限 |

在原用户外部终端执行，不能从 Codey/Codex 进程树重启自身。也会启动原先单独停止的隧道；不重装应用或改配置。

**示例**

```sh
codey restart --timeout 120
```

## `codey stop`

停止整个后台节点，并禁用服务及定时守护，直到再次执行 `codey guard` 或 `codey start`。

```text
codey stop [--json] [--timeout SECONDS]
```

| 参数 / 别名 | 取值与默认值 | 含义 |
| --- | --- | --- |
| `--json` | 布尔；`false` | 输出脱敏节点状态 JSON，默认可读服务列表 |
| `--timeout SECONDS` | 整数 `1–600`；`60` 秒 | 等待所有相关服务停止的时限 |

在原用户外部终端执行，不能从 Codey/Codex 进程树停止自身。不退出登录、不删除配置、数据或云端隧道。

**示例**

```sh
codey stop --json
```

## `codey status`

只读显示版本、平台、节点、服务启用/运行状态及可取得的 PID，不输出 key/token。

```text
codey status [--json]
```

| 参数 / 别名 | 取值与默认值 | 含义 |
| --- | --- | --- |
| `--json` | 布尔；`false` | 输出紧凑 JSON，含 `installed`、`running`、`operationInProgress` 和约定端口；默认可读服务列表 |

未安装时返回 `installed:false`，不创建状态目录；服务已停止不算查询失败。未知服务归属或损坏的安装状态返回非零。`doctor` 检查组件和云端连接，真实模型验收需 `doctor --model`。

**示例**

```sh
codey status --json
```

## `codey doctor`

检查包/原生模块、工具、服务、端口、凭据文件、证书、本地 TLS/SSO/鉴权，以及 DevTunnel 登录和私有隧道连接；默认不调用模型。

```text
codey doctor [--json] [--offline | --model]
codey doctor --runtime-only [--json]
codey doctor --package-only [--json]
```

| 参数 / 别名 | 取值与默认值 | 含义 |
| --- | --- | --- |
| `--json` | 布尔；`false` | 输出单行 JSON；默认也是 JSON，但有缩进 |
| `--offline` | 布尔；`false` | 跳过 DevTunnel 在线账号/隧道检查，结果标为 skipped |
| `--model` | 布尔；`false` | 允许 CLI/SDK 各执行一次真实模型请求，会产生模型用量和本地会话记录 |
| `--runtime-only` | 布尔；`false` | 只查包及 SQLite/bcrypt/ripgrep/SDK/PTY，不检查托管节点；适合独立运行包 |
| `--package-only` | 布尔；`false` | 只查包身份、锁文件及运行入口，连原生模块/SDK/PTY 也跳过 |

`--offline`、`--model`、`--runtime-only`、`--package-only` 四者只能选一个，可分别与 `--json` 组合。
不修复、不启停服务、不交互登录；DevTunnel CLI 可能刷新已有账号缓存。失败仍报告其他组件并非零退出，未配置节点也会失败。
凭据文件存在不等于认证成功；本机诊断也不替代 Portal 接入后的端到端验收。

**示例**

```sh
codey doctor --offline --json
codey doctor --model
codey doctor --runtime-only
```

## `codey export`

把节点凭据和设置导出为私有 gzip/JSON 备份，不停止服务。

```text
codey export FILE.gz [--json]
```

| 参数 / 别名 | 取值与默认值 | 含义 |
| --- | --- | --- |
| `FILE.gz` | 必填；原用户 Home 内的本地文件路径 | 输出备份；文件必须不存在，父目录必须已存在；建议绝对路径 |
| `--json` | 布尔；`false` | 输出文件路径和操作摘要，不输出备份内容 |

- 包含已有节点身份、证书/私钥、签名密钥、隧道/运行设置、模型 key，网关配置/文件型 token，以及 Codex 的 `config.toml`、`models.json`、`auth.json`。
- 不包含程序/依赖、数据库、项目、会话或系统凭据库；缺失文件记录在 `missing`。读取期间文件变化会失败，可稍后重试。
- **备份未加密**，无密码参数；Unix `0600`，Windows 为原用户/SYSTEM 私有 ACL。最多 64 个文件，单文件 4 MiB、源文件总量 16 MiB；不要上传或粘贴备份内容。
- 这是 `codey-settings-backup`，不是 ZIP/tar 或安装器导出的 Portal 注册 JSON；只能交给 `codey import`。

**示例**

```sh
codey export "$HOME/codey-backup.gz" --json
```

## `codey import`

从 `codey export` 生成的备份恢复凭据和设置；执行恢复前先检查覆盖范围。

```text
codey import FILE.gz [--check] [--replace-existing] [--settings-only] [--json]
```

| 参数 / 别名 | 取值与默认值 | 含义 |
| --- | --- | --- |
| `FILE.gz` | 必填；原用户 Home 内的私有本地文件 | 输入 Codey gzip/JSON 备份；建议绝对路径 |
| `--check` | 布尔；`false` | 只校验归档、目标和覆盖范围；不写入或改服务 |
| `--replace-existing` | 布尔；`false` | 明确允许覆盖已有目标文件；未指定时遇到覆盖就停止 |
| `--settings-only` | 布尔；`false` | 跨节点/平台迁移网关与 Codex 文件设置/凭据，保留目标节点身份、证书及基础设施配置 |
| `--json` | 布尔；`false` | 输出恢复范围、覆盖数量和操作摘要，不输出文件内容 |

- 默认完整恢复限同一节点、用户、Home、平台、机名及 Portal 绑定；保留当前应用版本、工具路径和资源清单，不恢复旧程序。
- 实际恢复在原用户外部终端执行：先保存私有 `before-import-*.gz`，停服务并禁用守护，写入后恢复原启停状态；捕获到失败时回退。中断或回退失败留下的操作锁需人工核对。
- 仅接受可信备份；校验白名单和摘要，拒绝重复项、路径穿越及链接。最多 64 个文件，单文件 4 MiB，归档及解压后的 JSON 均不超过 32 MiB。
- 系统登录缓存不恢复；跨平台模式只重映射安装器的模型目录路径，不自动迁移任意自定义路径。证书或节点密钥变化需人工同步 Portal。

**示例**

```sh
codey import "$HOME/codey-backup.gz" --check --json
codey import "$HOME/codey-backup.gz" --replace-existing
codey devtunnel login
codey doctor
```

## `codey update`

用本地 Codey npm 包一次性更新应用，保留配置、身份、证书、工具和原启停状态。

```text
codey update FILE.tgz [--sha256 HASH] [--check] [--offline] [--background] [--json]
codey update --status [--json]
```

| 参数 / 别名 | 取值与默认值 | 含义 |
| --- | --- | --- |
| `FILE.tgz` | 必填；查询 `--status` 时不接受文件 | 本地可信 Codey npm 包；不是 URL、npm 名称、旧升级包或设置备份，须兼容当前平台/Node |
| `--sha256 HASH` | 64 位十六进制；未指定 | 与独立获得的发行 SHA-256 核对；不匹配时不改动任何内容 |
| `--check` | 布尔；`false` | 只读检查包、兼容性、服务归属和依赖计划；不下载、不写入、不停服务 |
| `--offline` | 布尔；`false` | 禁止依赖下载，要求依赖锁与当前安装一致；复制并验证已有依赖 |
| `--background` | 布尔；`false`；仅 Linux | 交给独立 systemd 用户一次性任务；无需退出客户端。Linux 的 Codex/Workspace 进程树内自动采用此模式 |
| `--status` | 布尔；`false` | 只读查询最近一次后台更新的阶段/结果；只可与 `--json` 组合，不触发下载、重试或服务变更 |
| `--json` | 布尔；`false` | 输出版本、摘要、依赖模式、备份路径等非敏感结果 |

- 相同依赖锁优先复用；锁变化时通过 npm 下载依赖并准备原生模块。相同且完全匹配的包不重复安装。
- 先准备/校验新版本，再保存 `before-update-*.gz`、切换应用并恢复原启停状态；失败时回退，旧版本目录保留。Linux 原生隧道服务定义未变化时不重启隧道；gh host 的包装程序路径变化时仍连同其守护切换。
- Linux 后台任务继承同一独占操作锁，不依附聊天/终端，不开机自启，不因失败而自动重试。准备好后留出 5 秒再切换；这不是等待空闲或不中断迁移。连接短暂断开后客户端可重连，进行中的模型请求及 Workspace 终端命令可能中断，不能自动重放有副作用的任务；会话文件保留，不承诺恢复内存中的所有进程状态。
- 切换前重新核对托管配置、工具、端口和原启停状态；准备期间被其他操作修改时拒绝切换，不覆盖这些改动。此时以及切换前的进度写入失败都不会触发停服回退。开始切换后失败才回退，且旧服务也须通过健康检查。
- 返回 `queued: true` / `changed: false` 只表示接受任务；`codey update --status` 依次显示 `queued/preparing/ready/switching/verifying/completed`。`failed` 或 `needs-review` 不是升级成功；结合 `codey doctor` 和私有报告验收后才能清理旧版本。
- 状态查询会在检查原生任务后重读报告，避免任务完成并被回收时误报失败；原生任务查询失败、且报告仍未结束时返回 `needs-review` 和非零退出码。核对结果中的 `jobId` 与提交结果一致，不把其他任务的结果当作本次成功。
- 外部 Linux 终端不加 `--background` 时仍同步执行。Windows/macOS 暂不支持后台模式，仍使用原用户外部终端。旧 CLI 第一次升级到本实现也需外部原用户上下文；不能原地修改已安装脚本或删除安全检查来引导更新。
- 不升级 Node/Codex/DevTunnel，不自动注册 Portal，不增加 Python 或常驻更新器。中断或回退失败留下的操作锁需人工核对，不用重跑安装恢复。

**示例**

```sh
codey update "$HOME/Downloads/codey.tgz" --check --json
codey update "$HOME/Downloads/codey.tgz" --offline
codey update "$HOME/Downloads/codey.tgz" --background
codey update --status --json
```
