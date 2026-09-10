# 验收与精确回退

## 验收

1. 使用本人对应平台完整包，确认 owner/node ID、独立凭据、源码与 Node 摘要匹配。
   优先验证并复用 owner 已有的官方 Codex CLI（包括 npm wrapper）；仅缺失时安装固定官方包并验证 SHA-512。
   保留已有 config/auth，模型登录与本步骤分开。
2. DevTunnel `user show --json` 显示 GitHub；不接受泛化的“已登录”，不切换现有账号。
3. 新服务只监听回环地址；私有隧道仅有 HTTPS 3001/8443，没有匿名访问或额外端口。
   未改防火墙、IP、SSH、迁移清单外的代理进程或其他节点；Codex/gateway 仅有明确批准的默认配置变更，
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
10. 已 ready 后去掉 `--replace-existing`，重跑普通入口只验收，不改服务、身份或运行版本；
    仅明确的 `--repair-client` plan/apply 可重绑 owner CLI/新 key、停止旧 app-server 并重启 CloudCLI；
    重启/注销恢复必须另行实测。

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

## Linux legacy 显式迁移

- **准备检查**：Agent 先运行普通安装 plan；只有同一当前用户、已识别的旧 Codey user services
  可进入此分支。核对 unit/进程/路径归属及中断窗口；当前 ready 安装、未知服务和任意进程不适用。
  所用完整包必须支持 `--replace-existing`，不能用手动停止服务绕过缺失的迁移入口。
- **目标**：归档旧 Codey 安装，再用当前个人包的新节点身份安装；不是保留旧身份的签名升级，
  也不是恢复旧 key 的兼容模式。Home、`.codex`、session/auth 保留。
- **执行脚本**：在 Skill 根目录先 plan，再经用户批准 apply；附加参数与普通计划保持一致：

  ```bash
  bash scripts/setup-linux.sh --replace-existing
  bash scripts/setup-linux.sh --replace-existing --apply
  ```

  plan 无停服或归档动作；apply 才 stop/disable 计划明确的旧 unit、停止清单中的 owner
  Codex app-server，并归档计划列出的
  `codey-machine`、旧 CloudCLI、copilot-api、updater 和 relay 标准 runtime/config。
  以计划及结果给出的精确归档清单为准，归档可能含凭据，不公开上传。
  不删除或搬走整个 Home/`.codex`，不恢复旧 key/服务；仍被未知进程占用的端口会终止安装，不杀进程。
- **验收标准**：旧实例已退出、unit/runtime/config 已归档，新身份及新 key 生效且旧 key 被拒绝；
  新服务运行路径、模型、SSO、守护和 updater 验收通过，session/auth 未丢失。
  新服务可能复用 unit 名，应核对内容/路径/PID，而不是要求该名字永久 disabled。
  失败保留归档与诊断，不自动恢复旧服务；ready 后去掉迁移选项，回到普通验收或签名升级流程。

## Linux ready 客户端修复

- **准备检查**：仅用于同一 `ready` 节点出现重复托管 Codex、登录 shell 仍持有旧 key，
  或 Codex/Codey 返回 401。先确认 gateway config 与 `provider.env` 的新 key 一致且 `/models` 为 200。
- **目标**：复用 owner 已有官方 Codex CLI，将 CloudCLI、包装器和新登录 shell 统一到当前 key；
  不增加旧 key 兼容，不改节点身份，不删除 `.codex`、session/auth。
- **执行脚本**：

  ```bash
  bash scripts/setup-linux.sh --repair-client
  bash scripts/setup-linux.sh --repair-client --apply
  ```

  plan 列出文件、旧 key app-server PID、CloudCLI 重启及托管 CLI 归档；apply 才执行。
- **验收标准**：新登录 shell 解析到 owner CLI；gateway、CloudCLI 和 shell key 一致；
  旧 app-server 已退出，CloudCLI 重启后本机鉴权通过。随后必须分别取得一次真实 Codex 与 Codey 回复；
  仅 `/models`、health 或 PID 正常不能宣称聊天修复。
  安装前已存在的 shell 不会自动刷新变量；使用新 SSH/login shell，或以 `bash -lc` 发起 Codex 验收。

## 排障

- 包/摘要/平台不匹配：停止，重下同一待配置身份的完整包，不拼凑凭据。
- 端口或服务已占用：默认停止；同用户已识别的旧 Codey 仅走上述显式迁移计划，
  未知服务/端口或当前 ready 安装不得用 `--replace-existing` 强行覆盖。
- CLI 是 Microsoft 登录：保留缓存，要求本人审查 GitHub 登录，不能自动 logout。
- Linux 新代理模型请求 401：区分 GitHub 模型登录与本机 API key。核对新 CloudCLI 环境、
  owner 登录环境及 Codex 后台是否都使用新 key；文件更新不会改变已运行进程的环境。
  对 ready 节点使用上述 `--repair-client`，仅停止归属明确且仍持有旧 key 的 app-server；
  若 SSH/Desktop 自动拉起它，先修正启动环境。
  不向新代理加入旧 key 做兼容，不恢复旧服务或删除会话；验收需证明新 key 成功、旧 key 被拒绝。
- CLI 输出中 ID 已带区域后缀：仅使用经过严格核对的 ID/cluster，不猜区域。
- 权限不足、公司代理或 GitHub/DevTunnel 策略拒绝：报告具体阶段，不开放匿名访问。
- TLS、ticket、SSO、匿名拒绝失败：保持未添加，不关闭证书验证或跳过认证。
- 普通既有节点修复不重新建节点；已明确批准的 legacy 迁移才使用全新身份。
  历史修复工具不随首次安装包分发，不能代替当前迁移计划。

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

- 普通安装失败只停止本次新建、归属/路径明确的进程或服务；保留诊断和原有数据。
- Linux 范围：本次新建的 codey-copilot-api、codey-cloudcli、codey-node-updater、
  codey-devtunnel、codey-devtunnel-renew 服务/定时器。不能因同名就停止未获批准的旧服务。
- legacy 迁移只停用并归档已批准的旧清单；失败不自动恢复旧 key/服务，不扩大删除范围。
- Windows/macOS 只撤回本次明确创建的任务/LaunchAgent，不接管原 Desktop/代理。
- 隧道/待配置身份的取消或删除需单独确认，只操作本节点已记录的精确 ID。
- 已添加节点由 owner 在门户移除，仅撤销门户访问；不删除机器文件/项目/会话。
- 不关闭其他用户服务依赖的 linger，不清理登录缓存，不递归删除用户目录。
- 含密钥的 ZIP/临时副本留在 owner 受保护目录；公开交付仅含非敏感机器文件和报告。
