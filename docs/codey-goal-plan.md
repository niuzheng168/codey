# Codey 网页 `/goal` 与 `/plan`

2026-09-11 的源码实现。需要同时发布包含此功能的节点后端和 Workspace 前端；
只更新共享 UI 不够。未声明支持这些命令的节点会显示提示，不把命令作为普通提示词发送。

## `/goal`：原生持久目标

在 Codex 会话的聊天框中使用：

| 输入 | 行为 |
| --- | --- |
| `/goal 完成迁移并保持测试通过` | 创建目标并启动原生自动续跑 |
| `/goal --tokens 40000 完成迁移` | 使用明确指定的 token 预算 |
| `/goal` 或 `/goal status` | 查看当前目标、状态、已用 token 和耗时 |
| `/goal pause` | 暂停后续自动轮次，当前轮仍可完成 |
| `/goal resume` | 恢复暂停/受限目标，不重置已用量 |
| `/goal clear` | 移除目标，停止后续自动续跑；不会撤销已经完成的文件修改 |
| `/goal edit` | 把当前目标填入输入框，不自动提交 |
| `/goal edit 新目标` | 替换目标；原生规则会重置该目标的用量计数 |
| `/goal budget 80000` | 调整预算，保留用量；受限目标之后可显式 resume |
| `/goal budget off` | 移除预算，不重置用量 |
| `/goal help` | 查看帮助 |

目标限制为 1–4,000 个字符，支持换行。不指定预算时，Codey 不擅自添加预算。
较长说明可放进项目文件，再在目标中引用路径；目标命令不接收聊天附件。

目标进度使用一个持续更新的状态条目。Codey 跟踪原生调度器的连续轮次，
不会把第一轮最终答复误判为目标完成，也不通过循环发送“继续”来模拟目标。
**Stop 按钮会先暂停目标，再中断正在执行的目标轮次**，包括两轮之间的空档。
`pause`、`clear`、状态查询不会进入普通聊天消息队列。

关闭/刷新浏览器不会取消仍由节点后端跟踪的运行。节点后端重启、连接故障、
或者目标已经由另一客户端运行时，不会自动重放创建/恢复请求。
若提示目标已经 active，先 `/goal` 查看，再显式 `/goal pause` 后恢复；
不接管桌面进程、不删除 writer lock。

## `/plan`：原生规划模式

| 输入 | 行为 |
| --- | --- |
| `/plan` | 切换规划/普通模式，作用于下一条消息 |
| `/plan on` | 开启规划模式，不发送模型请求 |
| `/plan 为这次数据库迁移制定计划` | 开启规划模式并发送该任务 |
| `/plan off` | 返回普通审批模式，不自动恢复先前的全权限设置 |

也可以使用输入框旁的模式选择器选择 **Plan**。模式复用已有的会话/Provider
偏好保存机制。后端真正发送 `collaborationMode.mode = "plan"`，使用 Codex
内置模式说明和只读 sandbox，而不是在普通提示词前加“请先规划”。
离开规划模式时，下一轮明确发送 `default` 模式，避免继承残留规划状态。
规划模式不依赖单独的 `goals` 功能开关。

原生 `request_user_input` 会显示网页问答控件；答案按原生 question ID 回传，
不会当作工具审批。原生计划内容可流式显示。进入自动目标前需要 `/plan off`，
避免让一个只能规划的目标无限续跑。

## 运行与兼容边界

- 已有 Unix/macOS daemon 优先使用原来的连接；Windows 继续使用已配置的原生
  stdio 运行方式。桌面 daemon 的审批/交互继续由桌面客户端负责，网页明确提示，
  不抢答其他客户端的审批。
- CLI-only 节点为带有原生模式选择的消息启动受控 app-server 子进程。优先使用
  `CODEY_CODEX_EXECUTABLE`；源码开发环境也可使用已安装的 Codex npm launcher。
  不兼容的 CLI 会报错，不静默回退成普通 exec 提示词。
- CLI-only 新建的原生线程使用 legacy 历史格式，保留后续普通会话兼容性；
  不改写现有桌面分页会话的历史格式。
- 每次请求使用 Codey 会话 ID，后端从自己的数据库解析 provider-native ID。
  控制接口不会信任浏览器传来的任意 native thread ID。
- 命令尚在分配新会话时切换到其他会话，不会继续提交目标或清空新会话草稿。

## 验证

常规单元测试覆盖命令注册、原生 RPC 参数、自动多轮生命周期、暂停/停止、
旧快照与早到事件、错误后的暂停、会话 ID 映射、问答与前端输入行为。

真实 CLI 集成测试使用临时 HOME/CODEX_HOME 和 localhost 假模型，无真实模型调用：

```sh
cd cloudcli
CODEY_TEST_NATIVE_COMMANDS=1 \
  node_modules/.bin/tsx --tsconfig server/tsconfig.json --test \
  server/modules/providers/tests/codex-native-commands.integration.test.ts
```

可设置 `CODEY_TEST_CODEX_EXECUTABLE` 指定另一个已安装的 CLI；
本次验证覆盖 `0.146.0` 和 `0.154.0`。默认测试流程跳过这两项真实进程测试。

全量后端测试应使用临时 HOME，并移除继承的 `CODEX_HOME` 和原生 transport
覆盖，避免历史测试连接到真实桌面 daemon。Linux 上将 `TMPDIR` 设为 `/var/tmp`；
仓库的 workspace 根目录测试不适用于被现有安全策略禁止的 `/tmp` 子目录。
