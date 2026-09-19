# GitHub 单次登录复用：A100 调研与实测

> 本文记录最初的隔离调研。后续本地开发工作区已按此方案接入 gh 自动复用；
> **本次仅提交调研/实测文档，不包含这项实现代码，也不代表新功能已经发布。**
> 基础安装与命令入口见 [安装 Skill](../skills/config-new-codey-machine/SKILL.md) 和
> [CLI 参考](../skills/config-new-codey-machine/references/codey-cli.md)；
> gh 复用的行为以本报告和下述开发包实测范围为准。
> 经用户随后授权的清理和完整安装，另见
> [A100 全新 Skill 安装实测](a100-skill-install-2026-09-19.md)；
> 该后续实验实际修改了 A100，不能套用下文“未改生产状态”的早期调研边界。

日期：2026-09-19。范围：`zhn-a100` 上的隔离实验；**未修改安装器、
网关代码、生产认证配置或账号，未部署新版本、未重启现有服务**。
实测程序：Codey `0.1.17`、GitHub CLI `2.97.0`、
DevTunnel CLI `1.0.2030+fc9273aa0f`。

## 结论

**可以实现“已有 `gh auth login` 则不再登录；新机器只做一次 GitHub 登录”。**
在 A100 上，同一份有效的 GitHub CLI OAuth 凭据已分别完成：

1. Copilot API 网关的真实 Responses 模型请求。
2. DevTunnel 私有隧道的创建、签发 host/connect token，以及无登录缓存的
   DevTunnel CLI host 启动。

但这不是让两个现有 `login` 命令自动共享缓存，也不能仅把 `gh` token 填入
网关默认路径和 DevTunnel 的 `--access-token`。需要接入下面两条认证路径：

```text
GitHub CLI 已保存的、选定账号的 OAuth 凭据
  ├─ Copilot：直接 GitHub OAuth → Copilot API /models、/responses
  └─ DevTunnel：GitHub user authentication → 管理 API
                  ├─ host-only token → devtunnel host ID --access-token -
                  │                    （token 通过 stdin，不通过 argv）
                  └─ connect-only token → 原有 Portal 接入/续期流程
```

**调研时的 Codey 0.1.17 默认流程还没有实现这项复用。** 以下实验只证明当时的
可行性，不代表功能已经发布，也不代表所有账号策略、模型或平台已经验收。

## A100 的账号并不相同

| 凭据来源 | 实测 GitHub 账号 | 状态 |
| --- | --- | --- |
| `gh` 当前 active account | `zhn_microsoft` | `/user` 验证成功 |
| DevTunnel CLI 当前登录缓存 | `zhn_microsoft` | GitHub provider；与 `gh` 列出的隧道集合一致 |
| 生产 Copilot API 保存的凭据 | `niuzheng168` | 现有 token exchange 正常 |
| `gh` 中另一个 inactive account | `niuzheng168` | 该 **gh 凭据**失效，不代表 Copilot 保存的另一份凭据失效 |

因此，自动用 active `gh` 凭据覆盖网关，会把模型请求从 `niuzheng168` 切到
`zhn_microsoft`，可能改变组织策略、模型目录、配额归属。**不能静默覆盖。**

另外，`gh auth status` 会因为 inactive 账号失效而返回失败，即使 active
账号完全可用。实现时不能把这个总退出码直接当成“没有登录”；应读取选定
账号的凭据，再验证该凭据的实际身份和目标服务权限。

## 实测矩阵

所有 GitHub 凭据只在 A100 本机读取，未打印、未传回控制机、未放入命令行参数。
没有调用现有网关的 `/token`，没有触发设备码/浏览器登录。

| 实验 | 结果 | 说明 |
| --- | --- | --- |
| `gh` token → GitHub `/user` | HTTP 200 | 身份为 `zhn_microsoft` |
| `gh` token → `/copilot_internal/user` | HTTP 200 | 可读取 Copilot enterprise 账户信息 |
| `gh` token → 默认 `/copilot_internal/v2/token` | HTTP 403 | 默认 exchange 路径不能直接复用此次 gh 凭据 |
| `gh` token → Copilot `/models`，直接 OAuth | HTTP 200 | 可取得模型目录；未把目录成功当成推理成功 |
| `gh` token → **隔离 Codey 网关** → `/responses` | HTTP 200、`completed` | `gpt-5-mini` 返回准确的 `CODEY_GH_AUTH_OK` |
| `gh` token → DevTunnel 管理 API，`Authorization: github …` | HTTP 200 | 可列出该账号的隧道 |
| 现有 Copilot 保存的 `ghu_` token → DevTunnel 管理 API | HTTP 401、`invalid_token` | 这份 Copilot 凭据不能反向直接替代 gh；不推断所有 Copilot token 均如此 |
| 原始 GitHub token → `devtunnel list --access-token -`，空 HOME | 退出码 3、`Login required` | GitHub user token 不等于 tunnel-scoped token |
| `gh` → 创建临时私有隧道 | HTTP 201 | 零转发端口，无 anonymous ACL，空闲过期时间设为 1 小时 |
| `gh` → 临时隧道 host/connect tokens | 成功 | 两个独立 token；分别仅含 `host` / `connect` scope，绑定正确 tunnel/cluster，约 24 小时有效 |
| 空 HOME 的 `devtunnel user show` | `Not logged in` | 排除了复用生产 DevTunnel 缓存的可能 |
| host-only token → 空 HOME 的 `devtunnel show … --access-token -` | 退出码 0 | 无需 DevTunnel 登录 |
| host-only token → 空 HOME 的 `devtunnel host … --access-token -` | `Ready to accept connections` | 管理 API 再查有 1 个 host endpoint、0 个转发端口 |
| 删除临时隧道并复查 | DELETE 204，GET 404 | 清理完成 |

### Copilot 隔离实验的方法与限制

使用 A100 已安装的 Codey 程序，不替换或改写程序文件。另建私有临时 HOME、
`COPILOT_API_HOME`、`CODEX_HOME`，只监听一个临时 `127.0.0.1` 端口，
设置随机本地 API key，并把 gh 凭据仅通过子进程环境传入
`COPILOT_API_GITHUB_TOKEN`。

实验借用了网关现有的 `COPILOT_API_OAUTH_APP=opencode` 分支：
该分支直接使用 GitHub token，不调用 `/copilot_internal/v2/token`。
**这是对现有 direct-OAuth 分支的兼容性实验，不是声称 gh token 由 OpenCode
签发，也不是建议把此参数当作长期正式的 gh 模式。** 产品化应明确区分
凭据来源、OAuth 应用和访问方式。

先验证 `/models`，再进行一次真实 `/responses` 请求，最后停止测试网关并删除
临时目录。仅实测了一个 `gpt-5-mini` Responses 请求；未验收其他模型、
WebSocket、长会话、重启或长时间续期。

### 与认证复用无关的现场异常

A100 现有 `codey-devtunnel.service` 进程参数指向的旧 tunnel ID，不在此次
`gh` 与原 DevTunnel CLI 都返回的账号隧道列表中；使用 gh 对该 ID 做 GET
返回 404。没有足够证据断言是删除、过期还是账号/历史配置不一致。

因此没有在该隧道上测试 host，也没有重建或替换它；改用独立临时隧道验证。
进程处于 `active` 不等于现有生产隧道的端到端连通性已经验收。

## 原调研的落地建议

1. **保留已有有效认证和账号。** 在安装/ensure-auth 流程中，缺少有效凭据时
   才尝试 gh；发现 gh 与已配置账号不同，应明确报告，不自动切换。
   显式重新登录/切换账号与幂等启动应分开处理。
2. **共享凭据选择器。** 从官方 `gh auth token` 读取选定 `github.com` 账号，
   检查实际 `/user` 身份，并固定用户选择的账号，而不是每次跟随 active
   account。注意 `GH_TOKEN`/`GITHUB_TOKEN` 环境覆盖；不解析或改写
   `~/.config/gh/hosts.yml`，不抓取另一个工具的私有 keychain/cache 格式。
3. **网关加入明确的 gh/direct-OAuth 认证模式。** 不能只实现“发现 gh token”
   后继续调用默认 v2 exchange。分别验证账户和模型访问能力；不会因为能读
   `/user` 或 Copilot usage 就宣称模型可用。保留当前凭据模式。
4. **DevTunnel 管理操作复用 SDK 的 GitHub user authentication。**
   创建/查找隧道、设置端口和签发 token 走管理 API；host 使用现有官方 CLI
   的 `--access-token -`。CLI 子进程只拿 host-only token；Portal 只拿
   connect-only token，不向这两者传递高权限 gh 凭据。
5. **纳入原有续期和守护。** 本次签发 token 约 24 小时有效；长期部署需处理
   host token 更新及 host 进程重新读取，不能只做首次启动；connect token
   仍走既有独立续期。不得把 scope 扩大为 manage 来偷省实现。
6. **明确回退和平台边界。** 有效 gh 凭据可以零交互；没有 gh 时，可在用户
   选择共享认证后只做一次真正的 `gh auth login`，或保留原独立登录方式。
   安全存储、后台 PATH、无 GUI 的凭据读取和账号 pinning 需分别验收
   Linux/macOS/Windows；不自动安装新工具或授权额外 scopes。

代码接入点：

- `skills/config-new-codey-machine/scripts/install-machine.mjs`：
  当前先 DevTunnel，后检查 Copilot token 文件。
- `skills/config-new-codey-machine/scripts/windows-runtime.mjs`：
  共用 `loginTunnel()` 与 connect token 签发。
- 各平台现有 host/续期 worker：接入 host token stdin 与生命周期管理。
- `copilot-api/src/lib/api-config.ts`、`src/lib/token.ts`、`src/start.ts`：
  当前 direct-OAuth 分支、默认 token exchange 和凭据来源。
- `copilot-api/src/auth.ts`：显式 `auth login` 当前使用 `force: true`；
  不应把这个动作直接用于“只检查已有登录”。

至少应覆盖的回归项：无 gh、有效 gh、inactive 账号失效、环境覆盖、账号
不一致、无 Copilot 权限、默认 exchange 拒绝、网络失败、host/connect token
过期与续期、日志/argv 不含凭据、既有账号与缓存不被覆盖。

## 验证与清理

- 生产 Copilot API 和 DevTunnel 主进程 PID 在各自实验前后不变。
- 测试网关及临时 tunnel host 均已停止；临时 HOME 目录已清理。
- 临时云端隧道已删除，并用 GET 404 验证。
- 未向 Portal 注册实验隧道；没有转发生产端口或开放匿名访问。
- 本地基线回归：
  `node --test test/codey-machine.test.mjs test/codey-cli-reference.test.mjs`，
  **34/34 通过**。这些是既有 CLI/生命周期的 fixture 测试，不等于新共享
  认证功能已实现或跨平台原生验收。
- 调研文档通过空白检查与凭据形态扫描；未记录真实 token/API key。
- GitHub 官方文档支持的是 **官方 Copilot CLI** 的 gh 认证回退，不等于承诺
  第三方网关的所有内部 API 长期兼容；这里的网关结论以本日实测为准。

## 一手参考

- [GitHub：Copilot CLI 认证](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/authenticate-copilot-cli)：
  区分环境 token、CLI 自有登录和 GitHub CLI fallback。
- [GitHub CLI：gh auth token](https://cli.github.com/manual/gh_auth_token)：
  不指定用户时选择 active account。
- [Microsoft：DevTunnel CLI 命令](https://learn.microsoft.com/en-us/azure/developer/dev-tunnels/cli-commands)：
  独立的登录缓存与访问令牌机制。
- [Microsoft Dev Tunnels SDK：TunnelManagementHttpClient](https://github.com/microsoft/dev-tunnels/blob/main/ts/src/management/tunnelManagementHttpClient.ts)：
  user-token callback 与 tunnel-scoped access token 是不同认证入口。
- [Microsoft Dev Tunnels SDK：TunnelRequestOptions](https://github.com/microsoft/dev-tunnels/blob/main/ts/src/management/tunnelRequestOptions.ts)：
  获取指定 scope 的 token。
