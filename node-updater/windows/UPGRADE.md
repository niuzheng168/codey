# Windows Portal 升级代理

此包含**本节点私密升级凭据**。不要分享、放进 Git、贴出 config.json 或上传到别的站点。
它只安装独立的 Windows 升级任务，不运行 setup，不重新注册机器，不修改模型登录、
Node/Codex/DevTunnel、应用守护脚本或 Codey 任务，不重启 Workspace/网关。

## 首次接入

在本节点原 Windows 用户的非管理员 PowerShell 中，解压后进入 `codey-updater`：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Apply
```

需要已有受管 Windows x64 Codey npm 安装、原 Node/npm、Windows PowerShell 5.1 和原系统
.NET Framework 编译器。不会为满足前置条件安装其他工具。先前的 0.1.4 应用/离线包
不会自动接入；此步骤只做一次，代理凭据和源码的刷新仍需明确下载/安装。

代理以 `Codey Node Updater <nodeId>` 登录任务独立运行，与 Codey/隧道任务分离；
没有桌面窗口或新入站端口。锁屏期间仍可运行，注销后停止，下次原用户登录恢复。
它每约 15 秒主动访问原 Portal HTTPS，上报经本地进程与已鉴权健康检查确认的 Codey
版本、忙碌状态和签名序号。Portal 显示“升级器在线”和实际版本后即可预览、确认更新。

## 日常升级

Portal 发行版选择器区分 Linux x64 / Windows x64。Windows 仅接受整包 Codey 的签名
发行版；同一个应用 `.tgz` 可以共享，但平台清单、发行版 ID/序号分别签名。不执行
浏览器提供的脚本、npm 名称、URL 或 shell 命令，不能借此更新 Codex/DevTunnel。

忙碌时留在队列。**先完成 Codey 任务并退出本机 Codex**：当前原生进程的空闲状态
不能安全判断时会保守等待，不强杀，不提供 `force`。切换时只暂停 Codey 任务，
保留 DevTunnel、TLS/SSO、身份、模型 key、Node 和用户数据。完整更新并非零停机。

代理检查 Ed25519 签名、平台、有效期、哈希、Node 兼容性、配置和防降级序号，通过
原 npm 的 pacote + `npm ci` 按原 shrinkwrap 暂存。依赖与原生预编译文件可能联网下载，
但不会安装缺少的编译工具。切换后进行本机鉴权健康检查、一次独立 Codey 会话和一次
只读临时 Codex CLI 真调用；合成会话归档。失败只回退本次代码/描述符，不恢复旧数据库、
密钥或覆盖并发部署。Portal 只在验证完成后显示成功。

## 中断、撤销与恢复

重启/代理崩溃后先恢复本机未完成事务，再依赖 Portal；不会重新发送已验证的模型调用。
只更新凭据不能清除本机防降级状态。Portal 停用代理会撤销授权、取消未开始的任务，
不停止 Codey。已经切换的事务需要完成本地恢复，不能强杀它来赶时间。

状态在 `%USERPROFILE%\.config\codey-updater`，代理代码/日志在
`%USERPROFILE%\.local\share\codey-updater`，应用事务在
`%USERPROFILE%\.local\share\codey-machine-windows\local-updates`。
不要删锁或旧代码。若显示 `rollback_failed`，先检查原任务/配置，使用已安装代理的
原 Node 运行 `agent.mjs recover --config <原config.json>`；这只恢复已记录的本机事务。
仍有活动任务或并发修改时不会硬闯。接入/刷新时如果已有未结束事务，会拒绝替换代理。

源代码的模拟测试不等于目标 Windows 生产验收。上线先选择一台 Windows 作为 canary，
确认代理重启、真实模型验证与回滚路径后，再进行批量升级。
