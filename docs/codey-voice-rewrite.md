# 手动语音润色

2026-09-06：已按用户授权发布到 Codey ACA 和 `zhn-a100`、`westus2`、
`jpe2`、`jpe3` 四个远程 Workspace。生产发布与验证记录见文末。

## 恢复与重新生成（已发布）

- 撤销不再丢弃最近一次已应用的润色结果；撤销按钮切换为 **恢复上次润色**，
  可在原文与上次结果之间反复切换，全程在浏览器内完成，不调用模型。
- 已有润色结果时，再点纸笔图标会先弹出 **恢复上次润色 / 重新生成润色**，
  打开菜单本身没有请求。只有选择重新生成才再次调用 Foundry，输入仍是原始语音
  和录音时捕获的参考对话，不对上一版润色反复加工。
- 只缓存当前语音片段最近一次已应用的结果。新结果成功应用后替换缓存；
  失败、取消或超时不会丢失旧结果。有歧义的建议必须明确应用后才成为恢复目标。
- 恢复与撤销都检查当前会话和完整草稿，不覆盖继续编辑的文字。重新录音、
  切换会话或关闭语音会清除缓存；不将这份额外缓存写入存储或聊天历史。
- 恢复不依赖模型服务是否仍配置可用；重新生成仍受原有配置、配额和取消逻辑约束。

此更新已于 2026-09-06（UTC）完成四节点静态发布，Portal 与节点后端未变。
刷新页面后请用一段新语音测试；最近一次润色缓存不跨刷新保留。
第一版及本次更新的独立发布记录均保留在文末。

本轮验证：448 项前端测试、前后端 typecheck 和独立目录中的前端生产构建通过。
浏览器 UI-only 验证覆盖中文宽屏/375px、英文 320px、深色完成态及取消状态；
已检查菜单、快捷恢复、键盘导航及编辑保护，没有录音、发送消息或实际模型调用。
全量 lint 仍仅有文末记录的两个已有后端 boundary 错误；本次改动无新增 lint 错误。
本机验证日志和截图位于 `artifacts/voice-rewrite-restore-20260906/`。

## 使用方式

1. 开启 Workspace 的语音输入，录音并停止，原始转写先进入草稿。
2. 麦克风旁的纸笔图标为 **润色语音文字**；首次点击才调用 Foundry。
   已有润色结果时改为弹出菜单，只有选择 **重新生成润色** 才再次调用。
3. 仅替换刚插入且尚未被编辑的语音片段；原有手打草稿不发送给润色模型。
4. 润色完成后显示撤销图标；撤销后显示 **恢复上次润色** 图标，也可从纸笔
   菜单恢复。撤销和恢复均使用本地快照，不重复调用模型。
5. 如果模型报告歧义，原文不变，先展示可选择复制的建议，用户可明确应用。
6. 点击润色期间的旋转图标可取消。编辑、清空、发送草稿、切换会话、离开页面
   或关闭语音都会使待返回结果失效。应用、撤销和恢复均检查当前草稿及会话；
   继续编辑后不会用旧快照覆盖新内容，但仍可展开查看、复制原始语音文字。
   仅保留本次语音原文和最近一次已应用的润色，不推测编辑后的片段边界。

Portal 已配置润色时，录音中的发送按钮改为 **停止录音并预览文字**。
润色绝不发送聊天消息。没有配置润色的旧 Portal 和独立 CloudCLI 保持原有行为；
旧 Portal 不提供 capability 时，新图标禁用，现有 STT 仍可用。

语音选项内的“参考最近对话”默认开启，偏好按 Codey account ID 保存在当前
浏览器，并在节点之间共享；不是各节点的 `voiceEnabled` 开关，也不承诺跨设备同步。
只有用户点击润色，筛选后的历史才会发送到 Foundry。

## 上下文和提示词

- 录音开始时捕获当前会话的消息视图；不读取 Shared、其他节点或其他会话。
- 最多 3 个用户 turn、6 条用户/助手正文，正文合计最多 **3000 UTF-8 字节**，
  单条最多 1000 字节。这是保守的字节预算，不声称精确计算模型 tokens。
- 不包含未完成流式消息、思考、工具、子 agent 容器、通知、命令输出和压缩摘要；
  去除正文内 fenced code 和能识别的常见凭据格式。该过滤不保证识别所有敏感文字，
  因而提供关闭历史的选项，也不自动收集附件或文件。
- `voice-rewrite-v1` 固定提示词存放在 `src/voice-rewrite-service.mjs`。动态数据只放
  `input` JSON，不作为 system/developer 指令或真正的历史续聊消息。
- 当前口述优先于旧上下文；保留否定、条件、权限范围、数字、路径及版本；
  不回答、执行、扩充任务或自动猜测歧义。
- JSON Schema 返回 `{text, ambiguities}`。这只是格式约束，不代表语义正确；
  用户仍应检查最终草稿。

## 数据路径和配置

```text
CloudCLI browser
  → POST /cloudcli/<owned-node>/api/voice/codey/rewrite
  → Portal login + Origin + node ACL
  → resource /openai/v1/responses
  → candidate → compare-and-set draft → optional local undo / restore
```

请求只接受 `transcript`、`history` 和 `language`。节点从受信任路由取得；
不允许客户端指定 model、URL、prompt、身份或 key。Portal 不转发 Cookie 到 Foundry，
不把模型 key 发给 VM。`copilot-api` 和 Codex 主模型不参与这个调用。

新增配置：

```dotenv
VOICE_REWRITE_DEPLOYMENT=my-gpt-5.6-deployment
# 默认使用已有 Foundry project 所属资源；支持 FOUNDRY_API_KEY / FOUNDRY_KEY。
# 不从模型家族显示名称猜测实际部署名称。
VOICE_REWRITE_REASONING_EFFORT=low
# 不同资源必须同时指定地址和自己的 key：
# VOICE_REWRITE_ENDPOINT=https://other-resource.openai.azure.com/openai/v1/
# VOICE_REWRITE_API_KEY=<server-only-key>
```

必须使用已存在且支持 Responses、JSON Schema 和所选 effort 的部署。
服务不会创建模型、创建资源、发现并切换模型，或借用不同资源的 Speech key。

`GET .../config` 只增加 `rewrite` capability，不暴露 endpoint、部署名或凭据。
纯 STT 流程保持不变。部署 helper 支持显式 `--rewrite-deployment`，
保留 `.env`、已有 secret 和旧 revision 的绑定；其 `--dry-run` 不写 Azure。
源码改动本身不自动触发部署；本次经授权执行的发布记录见文末。

## 边界与失败处理

- 单次转写文字最多 8000 字符，HTTP body 最多 48 KiB；超出直接拒绝，不截断用户口述。
- Portal 10 秒模型超时，浏览器 15 秒等待上限；拒绝重定向、超大/空白/不完整输出和拒绝结果。
- 独立润色配额：每账号最多 1 并发、每分钟 8 次，进程最多 4 并发；跨节点合并计数。
  不消耗原有 STT 请求额度，也不自动重试。
- 同现有语音：取消/注销/撤权/断开会取消上游请求，返回前再次检查身份与节点归属。
- 超时、限流、解析错误和服务未配置都保留原文，不替换模型。
- 请求 `store:false`，不创建后台任务、工具或持久会话。不额外记录正文、音频或历史；
  输入框仍按既有节点草稿/会话机制保存。Azure 的平台侧数据处理政策另行适用。

## 验证和发布

```sh
npm run check
npm test
python3 -I -S test/test_voice_secrets.py
cd cloudcli
NODE_ENV=test npm run test:client
npm run typecheck
npm run build:client
```

仅当明确允许少量合成文本计费调用时：

```sh
# 默认仅验证配置，零模型调用。
npm run voice:rewrite:probe -- --env-file .env --deployment ACTUAL_DEPLOYMENT
# 明确执行 4 条合成样例；不读取或上传真实聊天，也不修改 .env。
npm run voice:rewrite:probe -- --env-file .env --deployment ACTUAL_DEPLOYMENT --run
```

发布需要单独授权：更新 Portal 代码/配置，以及各节点 CloudCLI 的静态资源。
无需修改节点后端、Codex 模型、`copilot-api`、数据库或网络；静态发布沿用校验哈希、
保留旧资源、原子切换 HTML 的既有工具，不重启节点服务。

### 发布前开发验证

- Portal：110 项测试及语法检查通过；secret helper：8 项离线测试通过。
- CloudCLI：430 项前端测试通过，前后端 typecheck 和前端构建通过。
- 真实 `gpt-5.6-terra`：4 条合成样例通过，覆盖否定限制、当前模型要求优先、
  歧义保留、自我纠正；本批次单次约 1.1–1.5 秒，不代表延迟保证。
- 浏览器 UI-only：宽屏、375px 窄屏、深色完成态、进行中状态通过，
  点击/取消/撤销不会触发录音或发送消息；未采集真实麦克风。
- 源码改动及构建 JS 未发现本地配置的真实 Foundry key。
- 全量 lint 仍有两个原有后端 `boundaries(no-unknown)` 错误，位于
  `server/modules/auth/auth.middleware.ts` 和
  `server/modules/websocket/services/websocket-auth.service.ts`；
  本次未修改这两个后端文件。原有构建 chunk-size warning 保留。
- 以上开发验证阶段，运行中的 westus2 CloudCLI PID 和入口 HTML SHA-256
  与检查前一致；当时尚未部署 ACA、替换运行中静态资源或重启服务。

## 生产发布：2026-09-06（UTC）

- 新修订：`codey--rewrite-0906090024`，已 ready，接收 100% 最新修订流量。
- Portal 镜像标签：`codey:20260906-rewrite-090024`；部署固定到 digest
  `sha256:53a26e48795405b9d1307a66abd6ebb4e083b5dc772d0a2713078ac314b8af14`。
- 基于原线上镜像构建，并先验证原有 server/voice 模块的规范化源码 SHA-256；
  只覆盖 `server.mjs`、`voice-gateway.mjs` 和新增 `voice-rewrite-service.mjs`。
  没有用开发机的配置文件替换线上配置。
- 仅新增 `VOICE_REWRITE_DEPLOYMENT=gpt-5.6-terra` 和
  `VOICE_REWRITE_REASONING_EFFORT=low`。复用现有 Foundry SecretRef，不创建或替换模型密钥。
- 对比确认 MCP 镜像/配置、其余环境变量、身份、认证、流量模式、存储挂载、
  资源配额及网络配置不变。Azure API 为原 Foundry SecretRef 回传了空 value
  占位字段；引用本身和实际注入密钥未变。新修订的 portal/mcp 均 ready、
  restart count 为 0；没有手动重启节点服务。
- A100 先做 canary；通过 Codey 的已认证入口验证后，再发布其他三个节点。
  每节点加入 57 个新哈希资源并原子替换 HTML，保留旧资源和原入口备份。

| 节点 | 新 HTML SHA-256 前 16 位 | 入口备份目录 |
| --- | --- | --- |
| zhn-a100 | `653ab775774dc032` | `voice-20260906-092422-24e91529` |
| westus2 | `c2e6a4ed5575ac34` | `voice-20260906-092707-1d7d8289` |
| jpe2 | `3f74cbeaecaaf2c0` | `voice-20260906-092734-a722b39f` |
| jpe3 | `73e39522886509d3` | `voice-20260906-092734-be017c35` |

备份均在节点用户的
`~/.local/share/codey-cloudcli/ui-deployments/<目录>/previous-index.html`。
四节点 CloudCLI/copilot-api PID、VM boot ID 和后端 release 路径均与发布前一致。
未修改语音开关或其他用户偏好。

生产验收：

- 四节点的 `config` 均 200，润色可用，原 Azure Speech/MAI 两项配置正常。
- 四个 Workspace 经 Codey 获取的入口 HTML 完整 SHA-256 均与对应构建相符。
- 合成口述经实际 Portal `rewrite` 路径返回 200，正确保留 `westus2` 和“不重启”
  限制，最后一轮模型调用耗时 1576 ms；没有访问或上传真实聊天内容。
- 未登录 401、未分配节点 404、跨 Origin POST 403；短时验证会话用后立即删除，
  并再次验证其请求返回 401。没有修改账号、密码、归属或用户草稿。
- 临时私有 Blob 发布容器及 4 个制品已删除，短期只读下载地址已失效；
  本地授权链接文件也已清理。节点上的旧静态资源与回滚备份继续保留。

本机完整非凭据发布记录在
`artifacts/voice-rewrite-deploy-20260906-090024/deployment-summary.json`。
后续回滚前先确认当前修订及 HTML 哈希仍匹配本次记录，不能覆盖别人后续的部署。
Portal 可恢复原 `codey--mai15-0906110539` 对应镜像与配置；节点仅恢复其旧入口
HTML，不能删除仍可能被旧标签页使用的哈希资源。

## 恢复/重新生成更新发布：2026-09-06（UTC）

10:31 UTC 完成四节点发布与验收：

- 从已验证的前端源码创建独立构建快照，不复制 `.env` 或运行时配置。
  快照再次通过 448 项前端测试；westus2 产物与此前已验证的构建完全一致。
- 按节点分别构建资源路径，先发布 A100，经已认证的 Codey 入口校验后，
  再发布 westus2、jpe2、jpe3。每节点新增 56 个哈希资源并原子替换 HTML，
  保留全部旧资源和入口备份。
- Portal 修订仍为 `codey--rewrite-0906090024`，Portal/MCP 镜像与流量配置不变。
  未修改 Foundry 部署、提示词、节点后端或用户偏好。
- 四节点 CloudCLI/copilot-api PID、VM boot ID 和后端 release 路径均与发布前一致，
  没有重启服务或 VM。

| 节点 | 新 HTML SHA-256 前 16 位 | 入口备份目录 |
| --- | --- | --- |
| zhn-a100 | `31f4ab38740ffafd` | `voice-20260906-102736-d43ba386` |
| westus2 | `9d655667dd92ada3` | `voice-20260906-102905-8d2336bd` |
| jpe2 | `e3798d4f59d2f576` | `voice-20260906-102931-1cc266fc` |
| jpe3 | `c0311407c1a71779` | `voice-20260906-102930-e96d3935` |

备份仍位于各节点的
`~/.local/share/codey-cloudcli/ui-deployments/<目录>/previous-index.html`。

线上验证：

- 四节点语音配置均为 200，AI 润色及原有两个转写服务保持可用。
- 从实际 Codey 入口获取四份 HTML，以及每节点 5 个入口 JS/CSS 资源；
  全部 SHA-256 与对应构建相符。
- 未登录返回 401，未分配节点返回 404。两轮短时验证会话均已删除，
  并确认删除后请求返回 401；没有访问真实聊天、上传录音或调用模型。
- 临时私有 Blob 容器及 3 个远程节点制品已删除，短期只读下载链接已撤销，
  本地授权链接文件也已清理。westus2 使用本地校验后的制品，没有上传副本。

完整发布记录位于
`artifacts/voice-rewrite-restore-deploy-20260906-102007/deployment-summary.json`。
如需回滚本次 UI 更新，先确认当前节点 HTML 仍匹配本表，再恢复对应备份入口；
不需要回滚 Portal，也不能删除旧标签页可能仍在使用的哈希资源。
