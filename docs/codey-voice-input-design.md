# Codey / CloudCLI 语音输入

手动 GPT 语音润色已于 2026-09-06 发布，其代码、上下文边界和生产验证说明见
[手动语音润色](./codey-voice-rewrite.md)。下文保留原始语音转写的历史上线记录，
不将这些旧记录当作新润色功能的验收。

> 2026-09-06。复用 CloudCLI 的录音交互，增加服务端托管的 Azure Speech 和 MAI
> 转写选项。录音不是 Codex 模型调用，不能把语音服务 key 放进浏览器或 VM。
>
> 当前：用户提供的 West US 资源，Azure Speech 与 **MAI-Transcribe-1.5** 均已实测上线。
> MAI 1.5 上线时的 ACA revision：`codey--mai15-0906110539`；
> 该次沿用原 portal/MCP 镜像与节点前端。

## 路径和权限

```text
用户点击麦克风 → 浏览器授权 → MediaRecorder
  → 浏览器本地解码为 mono / 16 kHz / 16-bit PCM WAV
  → /cloudcli/<本人节点>/api/voice/codey/transcribe
  → Codey 校验登录、Origin、节点归属、Workspace 配置和用量上限
  → 所选 Azure 语音资源
  → 文字回到原聊天草稿
```

ACA 在 Workspace 代理前截获新的 `/api/voice/codey/*` 路由，**不把音频、
Speech key 或 MAI key 转发到 VM**。源码：

- `src/voice-service.mjs`：固定服务端端点、PCM 校验、Azure / MAI REST 适配。
- `src/voice-gateway.mjs`：登录/owner/Origin、限流、上传与长请求撤销。
- CloudCLI `useVoiceInput`、`useCodeyVoice` 和语音设置：浏览器录音及选择服务/语言。

GET/HEAD `config` 仅返回 provider 名称、是否配置、语言和最大时长，以及当前
owner ID（用于隔离本浏览器的非敏感偏好）。POST `transcribe` 只接受 WAV，
参数只能是 provider/language，不接受浏览器提供的 endpoint、key、模型或 URL。
管理员也没有跨用户节点例外。未登录、猜其他人节点、伪造身份头均不能转写。

每条录音 0.25–120 秒，严格检查 RIFF、PCM format、channel/rate/bit depth/data
长度。服务端同时最多 4 条，每账号最多 1 条并行、每分钟 8 次尝试（当前单副本的
进程内限额）；不接受压缩文件或音频 URL，避免压缩炸弹和 SSRF。
上传限时 20 秒，提供方调用含响应体读取限时 60 秒，响应最多 512 KiB。

只由服务端加入 `Ocp-Apim-Subscription-Key`。不跟随提供方 redirect，不返回
原始提供方错误或 key。注销、停用、移除节点会取消活动转写；节点 lease 最多
5 秒检查一次，返回结果前再核对当前身份与 owner。断开浏览器也会取消请求。
Codey 不落盘录音或转写接口结果；文字进入草稿、发送后的消息仍遵循节点自己的
草稿/会话保存逻辑。测试用合成音频可保存在 artifacts，不是用户录音。

## UI 与会话安全

### 2026-09-06 输入工具栏精简

主行仅保留附件、录音、语音选项入口、更多工具、短模型名称、权限和发送。
服务商与语言移入语音选项弹层；命令、定时发送和清空草稿移入更多工具。
Token 用量与输入快捷键移到低强调的次行。模型完整上下文和推理强度仍在
提示与模型菜单中可见，不更改真实请求的模型或权限。窄屏允许工具与操作换行。

四个远程 Workspace 于 2026-09-06 12:03（UTC+08:00）完成静态增量发布，
保留旧哈希资源和上一版 HTML，已核对进程、VM boot ID 和新 HTML 校验和。
A100 经 ACA 的浏览器会话已显示新版控件；未发送聊天消息或采集真实麦克风。
本次不是后端、模型或语音凭据更新，无需重启任何节点服务。

Codey Workspace 的“设置 → 语音”开启后显示麦克风、服务和语言选择；快速设置也
可切换语音输入。只有点击麦克风才请求设备权限，开启设置本身不会录音。
Codey 的 iframe 明确允许同源 microphone；不需要 Local Network Access、relay
或把 Speech 域加入浏览器 CORS/CSP 白名单。

麦克风再次点击停止并填入草稿；取消、切换项目/会话或卸载组件会停止 tracks 并
撤销上传。迟到的权限结果/转写不能进入新会话。服务/语言在录音开始时固定，
其他标签页修改偏好不会把已录制音频悄悄发送到另一提供方。

托管模式不显示 API key / URL 输入框，不使用浏览器旧 OpenAI voiceConfig，
也不自动降级到别的服务。这里只增加 STT，未宣传或开启 TTS 朗读。
普通独立 CloudCLI 的 OpenAI 兼容语音流程保留。

## 服务配置

凭据来源是用户指定的 `Q:\codex_manager\.env`，该文件不进入镜像/静态包。
部署时把 key 写入 ACA Secret，只有 portal 容器取得 SecretRef；节点只有静态 UI。
`scripts/set-codey-voice-secrets.py` 使用进程内 Azure CLI，屏蔽日志中的 key，
不把 key 放到进程参数或临时绑定文件。它保留其余 ACA secrets。

支持的配置名见根目录 `.env.example`：

- Azure：`FOUNDRY_ENDPOINT` / `FOUNDRY_API_KEY`，或显式
  `AZURE_SPEECH_ENDPOINT` / `AZURE_SPEECH_KEY`。
- MAI：显式 `MAI_TRANSCRIBE_SPEECH_ENDPOINT` / `MAI_TRANSCRIBE_KEY`；
  代码默认 `MAI-Transcribe-2`，**当前生产显式配置为 `MAI-Transcribe-1.5`**。

用户当前 `.env` 使用 `FOUNDRY_ENDPOINT`、`FOUNDRY_KEY`、`SPEECH_ENDPOINT`。
部署 helper 将后两者规范化为现有镜像识别的 `FOUNDRY_API_KEY`、
`AZURE_SPEECH_ENDPOINT`，不重写 `.env`。只有显式指定
`--mai-model MAI-Transcribe-1.5` 才使用该 Speech endpoint 启用 MAI；
仅提供 Speech endpoint 不会隐式开启 MAI。MAI endpoint 与 Azure Speech
同源时可复用 Foundry key，不同资源仍必须提供独立 MAI key。

MAI 使用 Speech `transcriptions:transcribe?api-version=2025-10-15`，
`definition.enhancedMode.enabled=true` 和明确的 `model`。1.5 请求不携带
MAI 2 专属的 `modelOptions.transcribeStyle`；有语言提示时使用 `en` / `zh`。
界面仍显示通用名称 **MAI Transcribe**，当前后端固定为 1.5；用户可在语音服务
下拉菜单选择它，不影响 Codex 自己的模型配置，也不会自动 fallback 到 MAI 2。

更新 key 使用 `--secret-suffix <version>` 新增版本化 secret，旧 revision 保持
自己的 endpoint/key 配对以便回退。`--expect-env-sha256` 拒绝测试后又变更的
`.env`；`--dry-run` 只验证并显示非敏感名称/SecretRef，不接触 Azure。
控制台和 CLI 日志均不输出 key，key 不出现在 OS 进程参数中。

### 首次发布的资源限制（现已解决）

最初资源为 AIServices / S0 / East US 2，其普通 Speech 转写返回 200，但当时
OpenAI `/audio/transcriptions` MAI URL 返回 400“不支持该模型操作”，改用 Speech
enhanced transcription 也返回 `Enhanced mode with model is currently not supported yet.`。
该次没有把 MAI 标为可用，也没有私自新建资源。随后用户自行更新 `.env`，
提供 West US 的 `va-dev-usw-resource`；直接及生产 ACA 的 MAI 1.5 实测已成功。

核实资料（对应原始页面及摘录保存在本次 artifacts）：

```text
https://learn.microsoft.com/en-us/azure/ai-services/speech-service/fast-transcription-create
https://learn.microsoft.com/en-us/azure/ai-services/speech-service/mai-transcribe
https://learn.microsoft.com/en-us/azure/ai-services/speech-service/regions
```

## 发布方式

只更新 ACA portal 镜像及必要的 voice SecretRef。各 VM 采用静态增量更新：
先加入新的 hashed assets、保留旧 assets，再原子替换 `dist/index.html`。
校验实际运行目录、PID 和旧 index hash，避免覆盖用户另一次部署。
正常发布不重启 CloudCLI/copilot-api，不切换后端 release；部署目标不包含项目、
数据库、Codex、SSH、网络或 VM 配置。回退只恢复各节点的旧 index 和兼容的 Portal
镜像，不删除旧 hashed assets。

Linux 静态发布工具必须以 `python3 -I -S` 运行；脚本在导入任何非内建模块前
检查 isolated/no-site 标志，缺失即退出。禁止从节点 HOME 使用未隔离的
`python3 -`：HOME 内用户脚本可能遮蔽标准库。发布以版本化 helper 文件执行，
校验包 SHA、旧 index SHA、PID、运行目录和目标路径后才写入。

首次 A100 发布未隔离 Python，误载 `/home/zhn/copy.py`，意外向已有 `/data/g`
复制了内容。已核对进程完整命令行后只终止本次 installer；没有删除源文件或
自动清理目标。检查时 `/data` 已满，但没有事前容量/目标文件快照，无法保证
目标已有文件未被覆盖或判断新增占用。事故证据与后续恢复边界在
`Q:\codex_manager\artifacts\codey-voice-20260906\a100-installer-incident.md`。
隔离保护通过同名 `copy.py` 回归检查；之后四节点静态发布均成功。

## 首次发布验收（历史）

- ACA revision：`codey--voice-0906011421`；
  portal image：`codey:20260906-voice-011421`。
- 已发布 A100、jpe2、jpe3、westus2；四节点经 ACA 返回的 index SHA 与新构建一致。
  CloudCLI、copilot-api PID、VM boot ID、后端运行目录都与发布前一致。
- `.env` 未写入镜像或前端；新增 ACA secret 仅
  `codey-voice-foundry-api-key`，portal 通过 SecretRef 取得 key。
  MCP、原登录/节点隔离配置、挂载、网络及其他 env 保持一致。
- 100 portal tests、399 frontend tests、类型检查、四节点构建通过。
  定向 lint 无新错误；全量 lint 仍有原 auth middleware 的 boundaries 错误。
- 2026-09-05 17:34 UTC（2026-09-06 01:34 UTC+08:00）生产 ACA 使用合成测试音频，
  Azure Speech 的英文与自动语言两种请求均 200，返回预期测试句。
- 生产匿名/伪造 Cookie、未知节点、跨 Origin、endpoint 注入均按预期拒绝；
  未配置 MAI 返回 503；测试新建的登录 session 已单独注销。
- 浏览器验证开启语音开关不会请求录音，聊天框显示麦克风、Azure Speech、
  中文/英文/自动语言选择，MAI 标为未配置；ACA iframe 已允许同源 microphone。
  未启动用户真实麦克风，录音/取消/切换会话生命周期由自动化测试覆盖。

验证目录：`Q:\codex_manager\artifacts\codey-voice-20260906`。
`verification-summary.json` 和 `live-verification.json` 保存机器可读结果。
这一轮的 MAI mock 只验证适配协议与安全行为，并非可用性证明；下述后续发布
使用新资源完成实际 MAI 转写后才启用。

## MAI 1.5 / West US 上线验收

2026-09-06 03:13 UTC（11:13 UTC+08:00），通过 Codey 的认证路由验收：

- 资源：`va-dev-usw-resource`，Azure ARM 核实 `westus` / `AIServices` / `S0`。
- 原 `.env` 保持不变。新增版本化 secret
  `codey-voice-foundry-api-key-mai15-0906110539`，五个语音配置绑定逐项核对。
- 现有镜像已经支持 1.5；未重建镜像/前端，未部署/修改/重启 VM。
  四节点经 ACA 返回的 HTML SHA 与前一轮构建一致。
- MAI 1.5 自动语言与英文模式均返回 200 和预期合成测试句，5.435 秒音频的两次
  ACA 请求耗时分别 1236 ms、1303 ms；普通 Azure Speech 的两种模式也成功。
- 生产配置核实明确为 `MAI-Transcribe-1.5`；客户端 model override 返回 400，
  无其他模型 fallback。未登录/伪造 Cookie、未知节点、跨 Origin、endpoint
  注入仍按原安全策略拒绝，测试自身 session 已注销。
- 浏览器确认两项服务都“已配置”，MAI 选项已可选，保持原 Azure Speech 选择；
  没有申请或使用用户真实麦克风。
- portal/MCP 镜像、其余配置、网络、挂载均未改变；新 revision 两容器 ready、
  restart count 0。旧 secret 保留，不删除其他服务的数据或凭据。
- 102 portal tests、6 个离线 secret-helper tests、语法检查通过；
  未改前端，因此本轮不重复声称运行前一轮的 399 项前端测试。

记录：`Q:\codex_manager\artifacts\codey-mai15-20260906\verification-summary.json`、
`provider-probe.json`、`live-verification.json`。之前的 A100 复制事故记录仍保留，
本轮没有清理、移动或修改 `/data/g`，也没有将旧事故标记为已恢复。
