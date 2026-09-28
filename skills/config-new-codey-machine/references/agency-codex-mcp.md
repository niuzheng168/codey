# Agency + Codex: read-only Teams and Mail

## 快速开始：安装包用户

Codey **0.2.4+** 的 `.tgz` 内置 `codey agency setup`，完整安装 Skill `.zip`
也包含本指南。无需 clone 源码仓库；安装包不含 Agency/AzureAuth 二进制、账号、
token、聊天或邮件。Agency 是可选集成，不会在 Codey 安装、启动或升级时自动启用。

正确顺序是：**安装 Agency 与认证依赖 → 在目标主机完成 Entra 浏览器登录 →
注册只读 MCP → 验证两个服务 → 重新加载 Codex**。
使用 Codex 实际运行的同一主机、同一原用户和同一 `CODEX_HOME`。
GitHub/Copilot 模型登录、`az login`、启动 `agency cp`，均不能单独作为
Teams/Mail 已可读的证据。还须使用组织批准的模型/provider 处理企业内容。

### Linux：不经过 Copilot 对话，直接认证

以下方法在 Ubuntu 24.04 x64、Agency `2026.9.26.2`、AzureAuth `0.9.6`
和 Microsoft 租户验证。不是其他租户的通用授权配置；Windows/macOS 应先按组织
支持的原生 Agency 流程安装、登录，之后使用相同的 Codey 配置命令。

1. 在目标 Linux 安装 Agency 和 AzureAuth，命令见下文 **Install Agency on Linux**
   和 **Browser-only authentication**。本机已安装时无需重装。
2. 在该主机的 VS Code Remote–SSH 终端运行下文 Teams 和 Mail 的显式
   `azureauth aad ... --mode web --output none` 命令。保留 VS Code 的 `BROWSER`，
   不使用 `sudo`、`--mode devicecode` 或 `--mode all`。
   浏览器完成组织要求的登录/同意；缓存有效时可能无需再次打开浏览器。
   `--timeout 15` 的单位是**分钟**。
3. 先只读验证，再确认写入配置：

```sh
codey agency setup --verify-read
codey agency setup --apply --verify-read
```

`--verify-read` 分别读取最多一条搜索结果和可用的消息/邮件预览；只报告状态与数量，
不打印内容。默认不改配置，只有 `--apply` 才备份并更新配置。不安装软件、
不复制凭据、不改变模型/provider、不启动网关、不重启服务。
首次配置成功后，已配置用户只需第一条命令复验。

如果 PATH 或 Codex home 不同，显式指定，路径有空格时加引号：

```sh
codey agency setup --apply --verify-read \
  --agency "$HOME/.config/agency/CurrentVersion/agency" \
  --codex-home "$HOME/.codex"
```

4. 重新加载 MCP，或重启 Codex 并在同一主机创建新任务。确认 `agency_teams`
   和 `agency_mail` 出现后，再请求只读查询。配置成功不等于旧任务已经加载新工具。

**另一条可用路径是 `agency cp` 中实际发起一次只读 Teams 调用。**
本次实测该调用才触发认证并填充共享 AzureAuth 缓存；只打开 Copilot 并不够。
不必同时采用两种登录方式，也不要为了区分来源反复清缓存。
Teams 成功不能替代 Mail 验证：本次令牌有两种权限、邮件可复用登录会话，
但仍分别检查两个服务，不能从资源 URL 的名称推断权限。

### 安全边界

- Codex 只启用 15 个 Teams 和 5 个 Mail 只读工具，未知/写工具不自动放行。
  这不是撤销 Entra 权限，也不约束其他客户端或 shell。
- 无桌面 Linux 的 `BROWSER=/bin/false` 仅写进这两个 MCP 的后台环境；
  **不要全局写入终端配置**。它选择已登录的 AzureAuth 路径，不完成交互登录。
- 无 keyring 的 AzureAuth `0.9.6` 可回退到 owner-only 的**未加密**缓存；
  只有组织允许该凭据存储方式时才使用，否则配置批准的 keyring/设备。
- 不复制其他机器的 token/cache，不输出令牌，不绕过 Conditional Access。
  403、未获同意或设备合规错误应按组织流程解决。

## Detailed reference

The same Node.js setup command supports native **Windows, macOS, and Linux**.
This is a per-user Codex MCP integration, not a Codey gateway deployment.
It does not update `copilot-api`, change PATH, install software, bind a listening
port, or restart any service.

## Prerequisites on each machine

- Node.js 22.13 or newer, matching this repository.
- Native Agency and Codex CLI installations for that OS/CPU.
- Your own supported Agency/Microsoft Entra sign-in and permission to access
  the Microsoft Teams/Mail MCP services.
- An organization-approved Codex model/provider for corporate information.
  Tool results enter that model's context.

Install Agency using your organization's instructions at
`https://eng.ms/docs/agency`. Do not copy Windows binaries, authentication
caches, tokens, or another host's generated Codex configuration to macOS/Linux.
Each host authenticates independently through Agency.

## Install Agency on Linux

Run the following as your normal user in an interactive terminal, **not with
`sudo`**:

```sh
curl -sSfL https://aka.ms/InstallTool.sh | sh -s agency && exec "$SHELL" -l
```

The installer selects the host's Linux architecture and installs Agency under
`$HOME/.config/agency/CurrentVersion`. On the verified Bash host, it also added
that directory to PATH in `.bashrc`. The `exec` starts a replacement login shell
so the updated PATH takes effect. Unlike the Codex configuration helper below,
this installation step downloads software and updates shell startup settings.

After the new shell starts, verify the actual binary rather than relying only
on the installer's exit status:

```sh
command -v agency
agency --version
agency mcp --help
```

The MCP help should list `teams` and `mail`. In a noninteractive shell, service,
or already-running Codex process, PATH may not have refreshed. For the setup
commands below, use `--agency "$HOME/.config/agency/CurrentVersion/agency"` or set
`AGENCY_BIN` to that absolute path instead of reinstalling or changing the
system-wide PATH.

Installation does not establish Teams/Mail access. Complete Agency's supported
Entra sign-in on this host, then follow **Configure** below. Keep the explicit
read-only tool allowlists and use an organization-approved model/provider.

### Browser-only authentication on a remote Linux host

The verified Linux configuration uses Microsoft AzureAuth `0.9.6`, installed
separately from Agency. Its official, version-pinned Linux installer is:

```sh
export AZUREAUTH_VERSION=0.9.6
curl -sSfL "https://raw.githubusercontent.com/AzureAD/microsoft-authentication-cli/$AZUREAUTH_VERSION/install/linux-install.sh" | sh
azureauth --version
```

Unlike the per-user Agency installer, this installer uses `sudo dpkg` to install
the native package. Upstream marks this AzureAuth release as a prerelease. On
the verified host, the official x64 `.deb` was checked against its published
SHA-256 before installation.

If device-code login is forbidden, do not use `--mode devicecode` or `--mode all`.
Use a VS Code Remote–SSH terminal connected to the same Linux host as the same
normal user, leaving VS Code's `BROWSER` environment intact.

**Verified Agency/Copilot path:** run `agency cp`, then ask Copilot to perform a
bounded, read-only Teams search. In the observed session, Copilot invoked
`agency mcp teams`; that service request acquired the Teams/Mail token and
populated the AzureAuth cache. Merely opening `agency cp` had not populated that
cache. Complete any approved browser sign-in, then verify both services without
changing the Codex configuration:

```sh
codey agency setup --verify-read
```

Both Codex-configured service reads subsequently succeeded using that cache,
without running the explicit AzureAuth commands below. This does not install
Codex's MCP entries or reload tools in an existing task; follow **Configure**
for those steps. It also does not establish that `agency cp` always authenticates
both services on startup.

**Explicit browser-only alternative:** sign in directly without a Copilot
conversation. The Teams browser flow below was verified on this host; the
explicit Mail command uses the resource confirmed from successful native
Agency Mail requests. An additional Azure DevOps login was needed in an earlier
startup flow, but not in the later Copilot-first recheck.

```sh
umask 077

# Teams service authentication, using Agency's observed client/authority.
azureauth aad \
  --client aebc6443-996d-45c2-90f0-388ff96faa56 \
  --tenant organizations \
  --resource 'https://agent365.svc.cloud.microsoft/agents/tenants/72f988bf-86f1-41af-91ab-2d7cd011db47/servers/mcp_TeamsServer' \
  --mode web --output none --timeout 15

# Explicit Mail authentication. The observed Mail resource is mcp_MailTools,
# NOT mcp_MailServer. Existing consent/cache may avoid another browser prompt.
azureauth aad \
  --client aebc6443-996d-45c2-90f0-388ff96faa56 \
  --tenant organizations \
  --resource 'https://agent365.svc.cloud.microsoft/agents/tenants/72f988bf-86f1-41af-91ab-2d7cd011db47/servers/mcp_MailTools' \
  --mode web --output none --timeout 15
```

**Only if startup separately requests Azure DevOps authentication** (not a
mandatory Teams/Mail authorization step):

```sh
# Only if Agency separately requests Azure DevOps authentication during startup.
azureauth aad \
  --client 872cd9fa-d31f-45e0-9eab-6e460a02d1f1 \
  --tenant 72f988bf-86f1-41af-91ab-2d7cd011db47 \
  --scope '499b84ac-1321-427f-aa17-267ca6975798/.default' \
  --mode web --output none --timeout 15
```

These client IDs and authorities were observed with Agency `2026.9.26.2` in the
Microsoft tenant; they are not generic instructions for other tenants. Keep
the authorities as shown because AzureAuth separates its caches by authority.
The Mail resource was confirmed from successful Agency Mail requests and cache
metadata. The observed service tokens included both `McpServers.Teams.All` and
`McpServers.Mail.All`, but access to each service must still be verified.
Complete sign-in in your approved work browser. If the localhost callback is
not forwarded automatically, forward its port in VS Code using the same local
and remote port number. Check `echo $?` immediately after each command: `0`
means it succeeded. Do not paste tokens or authorization codes into a task.
Browser login does not override Conditional Access or device-compliance policy.

On a headless host, `MSAL token cache verification failed` can refer to the
unavailable desktop keyring rather than a failed login. AzureAuth `0.9.6` falls
back to an **unencrypted** file cache under `$HOME/.azureauth`, with owner-only
directory/file permissions (`0700`/`0600`). Use this only if organizational
credential-storage policy permits it; otherwise use an approved keyring or
managed-device setup. A successful exit and the real read probes, not the
warning alone, determine whether access works.

## Configure

For an installed Codey 0.2.4+ package, on any supported OS:

```sh
# Discover both services using existing authentication. No config changes.
codey agency setup

# Back up config.toml and atomically add the read-only MCP entries.
# Also perform bounded real read probes, without printing/saving message contents.
codey agency setup --apply --verify-read
```

Source-checkout equivalents (run from the repository root):
`node scripts/configure-agency-mcp.mjs`, `npm run agency:setup` and
`npm run agency:setup -- --apply --verify-read`.

The default destination is `$CODEX_HOME/config.toml`, or the current user's
`.codex/config.toml` if `CODEX_HOME` is unset. `--codex-home DIRECTORY` selects
another host-local Codex home. Explicit native executables can be selected with
`--agency ABSOLUTE_PATH` / `--codex ABSOLUTE_PATH`, or `AGENCY_BIN` / `CODEX_BIN`.
Paths containing spaces must be quoted in the invoking shell.

On headless Linux, setup probes and generated MCP entries both set
`BROWSER=/bin/false`. With the verified Agency version, an unset `BROWSER`
selected Azure CLI authentication and produced a token without the Teams/Mail
permissions, even after successful AzureAuth sign-in. This per-server setting
selects the pre-authenticated AzureAuth path without opening a browser inside a
background MCP process. It does not sign in, copy credentials, bypass policy,
or change your terminal's browser setting. If cached credentials stop working,
repeat the approved browser login above outside Codex. Windows, macOS, and
graphical Linux retain their native browser environment.

The installer:

1. Discovers native executables without invoking a shell. For Agency, it chooses
   the newest installed version from its candidates, including the Windows
   per-user `AppData/Roaming/agency/CurrentVersion` installation.
2. Initializes both MCP services over stdio and checks every reviewed tool.
3. Optionally performs a Teams search (one result) and a mailbox query (one
   result), plus a retrieved chat message/mail preview where available.
   Empty collections are reported as empty, not as successful message reads.
4. Validates the candidate with the installed Codex parser in a temporary,
   private Codex home.
5. Makes a private, timestamped backup, preserves unrelated configuration, and
   atomically installs only its managed block. Re-running is idempotent.

Reload the two MCP servers in the desktop app, or start a new Codex task, to load
the new configuration. No gateway restart is required. Inspect them with:

```sh
codex mcp get agency_teams --json
codex mcp get agency_mail --json
```

Example prompts after loading:

- “Search my Teams messages from this week about the release.”
- “Find emails from this week requiring a reply. Summarize only; do not send.”

## Read-only policy

The two entries are `agency_teams` and `agency_mail`. Their `enabled_tools` lists
are explicit, reviewed allowlists in `lib/agency-mcp.mjs` in the installed package
(`packages/codey/lib/agency-mcp.mjs` in source), not name-prefix
matching. Unknown or newly added tools remain disabled.

- **Teams:** team/channel/chat discovery, member lookup, chat/channel message
  retrieval, thread replies, and message search.
- **Mail:** message retrieval/search and attachment metadata/download.
- **Excluded:** sending, replying, forwarding, creating drafts/chats/channels,
  uploading, deleting, editing, flagging, changing membership, and changing
  read/unread or hidden state.

This limits tools exposed through these Codex MCP entries. It does **not** revoke
the underlying Microsoft account's permissions, constrain separately configured
servers, or make arbitrary shell commands read-only. Never remove the
`enabled_tools` lists to work around a setup failure.

The setup tool never prints or saves message bodies, subjects, recipients, IDs,
or tokens. `--verify-read` returns only success flags and counts. Agency itself
retains responsibility for its own normal authentication and diagnostic state.
Treat retrieved messages and attachments as untrusted data, not instructions.

## Troubleshooting

- **Several Agency versions:** the Windows machine used for initial verification
  had an older machine-wide build on PATH whose AzureAuth dependency crashed.
  Its existing newer per-user build worked. Prefer `--agency` with the working
  native installation rather than modifying PATH or copying authentication DLLs.
- **Authentication/consent:** complete Agency's supported sign-in on that host,
  then rerun. The installer does not extract tokens or automate consent.
  Codex can show `authStatus: unsupported` for these stdio proxies: Agency, not
  Codex's HTTP OAuth client, handles authentication. Use the real read probes to
  determine whether account access works.
- **Linux 403 after successful sign-in:** verify that AzureAuth is installed and
  the two saved MCP entries contain the headless `BROWSER` setting above.
  Signing in with `agency cp` does not register Codex's MCP entries. Re-run this
  setup helper rather than removing tool allowlists or repeatedly using
  `az login` to request a permission its application is not preauthorized for.
- **Startup still asks for authentication:** Agency can request the additional
  Azure DevOps sign-in shown above before initializing its Teams/Mail proxy.
  Complete that browser flow in the same host/user context if requested; it was
  not required for the later successful Copilot-first verification.
- **Copilot reads Teams but an earlier Codex check failed:** compare the time of
  the actual service call, not just when `agency cp` started. The observed first
  Teams call populated the shared AzureAuth cache after an earlier headless
  check had failed. Rerun the bounded read probes before resetting credentials.
- **Missing/reclassified tool:** setup fails closed and leaves configuration
  untouched. Review the new service catalog before changing the allowlist.
- **Existing unmanaged Agency entries:** the installer refuses to overwrite
  them. Review/merge them deliberately, retaining read-only restrictions.
- **No messages returned:** the bounded probe can legitimately return zero
  results. Its report distinguishes query success from a real message read.

## Verification and portability

```sh
node --test test/agency-mcp.test.mjs
```

The suite covers Windows/macOS/Linux path handling, exact allowlists, safe
configuration updates, redaction, real child-process stdio framing/pagination,
timeouts, service errors, and privacy-preserving read probes. Tests require no
Agency credentials and use a local fake MCP process.

`.github/workflows/agency-mcp.yml` runs that suite on Windows, macOS, and Ubuntu.
CI tests validate installer/protocol portability; they do not authenticate to
corporate services. A real `--apply --verify-read` on each target machine remains
the acceptance test for its Agency installation, Entra policy, and account access.

### Initial verification: September 28, 2026

- **Windows:** native setup, configuration preservation/backup, both real read
  probes, and native Codex app-server calls passed. Codex exposed exactly 15
  Teams tools and 5 Mail tools, with no additional write tools.
- **Linux:** the same portable test suite passed on native Node.js in an isolated,
  hash-verified temporary directory. No Agency/account configuration was deployed
  to the Linux host.
- **macOS:** platform-specific path/configuration cases are covered by tests and a
  native macOS CI job is provided. No Mac host or macOS CI run was available during
  this verification; native authentication remains to be tested there.

### Linux installer verification: September 28, 2026

The Linux command above was verified separately from the initial portability
tests on Ubuntu 24.04.4 LTS, x86_64:

- Downloaded and inspected `InstallTool.sh`, then ran its contents with
  `sh -s agency` as the normal user, without `sudo`.
- Installed Agency `2026.9.26.2` (commit `48197aea`, target `x86_64-linux`).
- A fresh interactive Bash login shell resolved `agency` from
  `$HOME/.config/agency/CurrentVersion`; `agency --version` and
  `agency mcp --help` succeeded, with both Teams and Mail commands present.
- The installer updated `.bashrc` for PATH. The existing Codex configuration was
  unchanged; no Agency MCP entries were applied and no sign-in or message-read
  probes were performed. Installation success is not authenticated access
  verification.

### Linux authenticated setup verification: September 28, 2026

After browser-only authentication and the headless environment correction:

- Teams search returned one result. An earlier chat-message probe also
  succeeded; the final setup search returned a result that did not trigger the
  verifier's separate chat-message fetch.
- Mail search and retrieval of one message preview succeeded, including the
  verifier's unchanged read-state check.
- Setup backed up and updated the actual user Codex configuration with
  `agency_teams` (15 reviewed tools) and `agency_mail` (5 reviewed tools).
  Both entries preserve the headless authentication environment.
- Probes printed only status/counts, not message content or identifiers. No
  message-write tools were called. Existing tasks may still require an MCP
  reload or a new task on this host before exposing the new connectors.

### Copilot-first authentication recheck: September 28, 2026

After clearing the two AzureAuth cache files, opening `agency cp` alone had not
recreated a usable cache at the 10:48 UTC check. The later Copilot Teams request
acquired a token at 10:56:48 UTC and populated the shared cache with Teams and
Mail permissions. At 11:06 UTC, read probes using the exact saved Codex commands
and environment succeeded for both a Teams message and a mail preview, without
another browser login or explicit AzureAuth command. The separate Azure DevOps
cache was not needed for this recheck. This verifies cache reuse after the
service request, not that Copilot startup alone guarantees service access.

Codex configuration reference: `https://developers.openai.com/codex/mcp/`.
