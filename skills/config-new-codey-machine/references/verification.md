# 验收与精确回退

## 验收

1. 使用本人对应平台完整包，确认 owner/node ID、独立凭据、源码与 Node 摘要匹配。
   独立 Codex CLI 准备步骤验证固定官方包 SHA-512 和 `--version`，不需要预装 Node；
   保留已有 config/auth，模型登录与本步骤分开。
2. DevTunnel `user show --json` 显示 GitHub；不接受泛化的“已登录”，不切换现有账号。
3. 新服务只监听回环地址；私有隧道仅有 HTTPS 3001/8443，没有匿名访问或额外端口。
   未改防火墙、IP、SSH、现有代理进程或其他节点；Codex/gateway 仅有明确批准的默认配置变更，
   未知配置、登录凭据和会话保留。
4. 本机验证固定 leaf/SAN 的 TLS、节点 ticket、History、Workspace SSO，匿名请求 401。
   配额不可用时，只有绑定本节点的只读数据服务及独立 token-usage 认证均通过才可继续；
   输出 quota warning，不能据此声称模型推理通过。
5. Windows 原 owner 的 InteractiveToken/LeastPrivilege 登录任务、macOS 的 launchd、
   Linux 的 systemd 用户服务使用固定本机运行路径，不以 root/SYSTEM 接管用户会话。
   服务启动前由 stdlib-only launcher 校验完整的 Python 模块清单和逐文件 SHA-256，
   再导入目标平台 supervisor。缺文件、变更摘要、陌生模块或链接路径必须拒绝。
6. **门户实际发起**私有隧道、TLS、认证和 WebSocket 检查，再启用节点。
   本机 health 200、PID 存在、CLI exit 0 或单元测试不能代替这一步。
7. 隧道续期只提交同节点 connect-only 令牌，拒绝改绑、回滚、重放和其他 owner。
   登录过期时由原 owner 完成 GitHub 授权；不静默切换 provider 或创建替代隧道。
8. Linux 升级器需 active/enabled、添加后在门户在线且 owner/ID 一致。
   Windows/macOS 仅以实际 Workspace 检查报告在线，不伪造 Linux 更新心跳。
9. 模型登录与接入分开验收。用户要求聊天能力时，需真实 Codey 和 Codex 回答。
10. 重跑已成功安装只验收，不改服务、身份或运行版本；重启/注销恢复必须另行实测。

## 独立默认配置

在目标当前用户下运行，POSIX 不用 root/sudo。按实际 Home、有效 `CODEX_HOME` 和 OS 读写权限操作；
不做 Unix group/ACL 额外判定，不通过 `chmod`/`chown` 改变现有路径权限。
路径、链接、并发和鉴权保护仍适用；OS 拒绝时报告具体路径，不提权或清空 Home。

Codex Home 优先使用显式 `--codex-home`，否则是目标 owner 的 `CODEX_HOME` 或 Home 下的 `.codex`；
控制端环境不能代替目标环境。先核对计划的 `ownerHome` / `codexHome`。
Linux 首次安装自动选择新服务实际 `COPILOT_API_HOME/config.json`；
Windows/macOS 以及 standalone defaults 必须显式提供正在使用的 gateway config，不能猜旧默认目录。

以下均在解压后的 Skill 根目录执行；占位符替换为目标机器上核对过的绝对路径：

```text
python -I -B scripts/codey.py defaults --owner-home "<目标 Home>" --codex-home "<有效 Codex Home>" --copilot-api-config "<active config.json>" --provider-env-file "<目标 provider.env>"
python -I -B scripts/codey.py defaults --owner-home "<目标 Home>" --codex-home "<有效 Codex Home>" --copilot-api-config "<同计划的 config.json>" --provider-env-file "<同计划的 provider.env>" --apply
```

第一条默认 plan（也可显式 `--plan`），不写文件、不创建备份、不重启服务；第二条需先批准。
没有文件式 provider.env 时省略该参数。多活动 key 用 `--model-key-file "<已生效 key 的文件>"` 选择，
不在命令行传 key 内容；Windows 包装器对应 `-CopilotApiConfig` / `-ModelKeyFile`。

- 公共 catalog 只含 `gpt-6-astra`、`gpt-5.6-sol`、`gpt-5.6-sol-fast`，校验包内固定摘要后写到
  有效 Codex Home 的 `models.json`；`config.toml` 的 `model_catalog_json` 指向该真实路径。
  计划明确列出模型、context、effort、`danger-full-access` / `never` 等默认值，再做保留式合并。
- Linux 在新服务首次启动前完成以上文件、实际 gateway 的 `useResponsesApiWebSocket=false`
  及 `provider.env` 的活动新 key 绑定；旧 key 不加入新 gateway。Windows/macOS 保留已有活动 key。
- `supports_websockets=false` 与 gateway 的上述 flag 只关闭**模型 Responses WS**，
  不关闭 Responses HTTP/SSE，也不关闭 DevTunnel/Workspace 的 WebSocket。
- 仅替换有差异的目标文件，先核对快照并保留私有备份，再原子替换；并发编辑必须拒绝或保留，
  不能被回退覆盖。报告只含路径、状态、摘要，不含 key/token。
- 重跑应 `changedFiles=[]`、不新增备份、不改字节或 mtime；哈希核对包括 config、catalog、
  gateway 与 provider.env。文件落盘不等于旧进程环境或 gateway runtime 已重载，必要重载须另获授权。

## 排障

- 包/摘要/平台不匹配：停止，重下同一待配置身份的完整包，不拼凑凭据。
- 端口或服务已占用：停止；已有工作节点不能拿首次安装器直接覆盖。
- CLI 是 Microsoft 登录：保留缓存，要求本人审查 GitHub 登录，不能自动 logout。
- Linux 新代理模型请求 401：区分 GitHub 模型登录与本机 API key。核对新 CloudCLI 环境、
  owner 登录环境及 Codex 后台是否都使用新 key；文件更新不会改变已运行进程的环境。
  获准后仅停止归属明确的旧进程；若 SSH/Desktop 自动拉起它，先修正启动环境。
  不向新代理加入旧 key 做兼容，不恢复旧服务或删除会话；验收需证明新 key 成功、旧 key 被拒绝。
- CLI 输出中 ID 已带区域后缀：仅使用经过严格核对的 ID/cluster，不猜区域。
- 权限不足、公司代理或 GitHub/DevTunnel 策略拒绝：报告具体阶段，不开放匿名访问。
- TLS、ticket、SSO、匿名拒绝失败：保持未添加，不关闭证书验证或跳过认证。
- 既有节点恢复与修复工具不随首次安装包分发；先审查归档工具及当前节点，不重新建节点。

## 原生守护检查

Linux（只检查本次安装的已核对单元，不把旧同名单元当作通过）：

```bash
systemctl --user is-enabled codey-copilot-api.service codey-cloudcli.service \
  codey-devtunnel.service codey-devtunnel-renew.timer codey-node-updater.service
systemctl --user is-active codey-copilot-api.service codey-cloudcli.service \
  codey-devtunnel.service codey-devtunnel-renew.timer codey-node-updater.service
loginctl show-user "$(id -un)" -p Linger
```

主服务需 enabled/active、`Restart=always`；renew 是 oneshot，不要求它持续 active。
timer 每 300 秒检查续期，令牌接近过期时才签发；网络/登录失效必须报告，不创建替代隧道。

Windows：只读检查 `Codey Node <nodeId> workspace/data/tunnel/renew` 四个原 owner 登录任务、
私有 runtime 中固定的 Python/服务入口，以及各组件 health 文件。任务 Running 不代替 HTTPS 自检。
macOS：用 `launchctl print gui/<uid>/com.codey.<nodeId>.<mode>` 检查该 owner 的
codex/workspace/data/tunnel/renew jobs；renew 间歇执行，其他组件使用 KeepAlive。
两平台均需原 owner 登录；不要通过 SYSTEM/root 规避会话和权限边界。

故障注入须单独批准准确节点、服务/PID 和时间窗口；确认空闲后一次只测试一个目标。
记录注入前后 PID、自动恢复耗时、监听和认证/SSO/模型结果，不以人工 restart 冒充守护恢复。
不得广泛 kill Codex、SSH 或模型进程；注销/重启测试同样需授权，未测试就明确标注。

## 签名自动升级验收

仅适用于已接入独立 updater 的受支持 Linux 节点。这里的“自动”是执行 owner 已审核确认的
签名任务，不是擅自安装任意最新发行版；发行目录需实际读取，不编造 ID 或 sequence。

1. **升级前**：核对 owner/node ID、空闲状态、当前组件及配置/catalog/key 哈希；
   审核版本、组件、迁移和发布摘要。保留独立 updater、Node/Codex 与身份，不用新节点安装器覆盖。
2. **任务证据**：观察 `queued/claimed → downloading → staging → waiting_idle → applying → verifying`
   到最终状态。`busy` 应等待；签名、平台、运行时、迁移或配置不满足就停止，不跳过门禁。
3. **真实成功**：正常为 `succeeded/ok`；核对非空 `transaction.anchors`、候选包 commit/hash、
   installed receipt 的 releaseId/sequence/digest，以及后续 heartbeat，不能只看服务 active。
   Codey 与 ephemeral/read-only Codex 都应给出真实回答；内置探针分别验证
   `CODEY_NODE_UPDATE_OK` / `CODEX_NODE_UPDATE_OK`，不以健康接口代替模型调用。
4. **no-op**：version、commit、entrySha256 全相同才是验证型 no-op；无下载、无服务重启、
   anchors 为空，通常为 `succeeded/up_to_date`，仍须双模型验证。ACK 重试可能报告 `ok`，
   所以不只看最终 code；相同版本号或入口 hash 也不能证明整个包相同。
5. **降级与失败**：低于已成功 sequence 的签名发布应被拒绝，同 sequence 不同 digest 也拒绝。
   不删除 receipt、改 node ID 或放宽签名来通过测试。失败的 code-only rollback 不恢复旧数据库、
   key 或用户配置；`rolled_back/needs_action/needs_migration` 均不算升级成功，恢复后另做双模型验收。
   重试同一签名包使用新的批准任务和候选路径，不复用或清空失败 staging 绕过检查。

## 精确回退

- 失败只停止本次新建、归属/路径明确的进程或服务；保留诊断和原有数据。
- Linux 范围：本次新建的 codey-copilot-api、codey-cloudcli、codey-node-updater、
  codey-devtunnel、codey-devtunnel-renew 服务/定时器。不能停止同机既有的同名服务。
- Windows/macOS 只撤回本次明确创建的任务/LaunchAgent，不接管原 Desktop/代理。
- 隧道/待配置身份的取消或删除需单独确认，只操作本节点已记录的精确 ID。
- 已添加节点由 owner 在门户移除，仅撤销门户访问；不删除机器文件/项目/会话。
- 不关闭其他用户服务依赖的 linger，不清理登录缓存，不递归删除用户目录。
- 含密钥的 ZIP/临时副本留在 owner 受保护目录；公开交付仅含非敏感机器文件和报告。
