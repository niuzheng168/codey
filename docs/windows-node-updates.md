# Windows 从 Portal 更新 Codey

## 能力与发布状态

新增 Windows x64 的独立拉取代理、按平台签名发行版和 Portal 接入入口。它不是把
“平台不支持”文字隐藏掉：版本来自正在运行的原 Codey 进程、安装指纹和本机已鉴权
健康检查。没有代理上报时仍明确显示未知。

这需要**部署包含该实现的新 Portal**，并在现有 Windows 上**首次安装一次专用代理**。
仅安装此前发布的 Codey 0.1.4 应用/离线包不会自动接入代理；不需要重打 0.1.4 `.tgz`。
新机安装、已有机器注册和升级代理接入是三个不同操作，不强制重新注册 Windows 节点。

## 原用户首次接入

1. 新 Portal 的「设置 → 软件更新」中，在 Windows 节点的「管理」菜单选择
   「接入升级器」。下载包含本节点专属凭据，只能交给该机器原用户，不能公开分享。
2. 在该 Windows 的原用户、非管理员 PowerShell 中，进入解压后的 `codey-updater`：

   ```powershell
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Apply
   ```

   执行策略仅作用于该进程。安装器复用原 Node/npm、Windows PowerShell、系统已有
   .NET Framework 编译器；仅创建独立的 `Codey Node Updater <nodeId>` 隐藏登录任务。
   不安装/升级工具，不重启 Codey，不动模型 key、TLS/SSO、隧道或原三个任务。
3. 原用户保持登录（锁屏可以），等待心跳。Portal 应显示「升级器在线」和本机真实
   Codey 版本。注销会结束任务，下次登录恢复；这不是 SYSTEM 权限的无人登录服务。

## 发行版与日常更新

发行版选择器显式区分 Windows x64 / Linux x64。两者可以共享相同 Codey npm 包，
但签名清单的平台、ID 不同，序号在整个 feed 中严格递增。Windows 不接受旧的
CloudCLI/copilot-api 拆分包、Linux 任务或 Codex/DevTunnel 工具 manifest。
某个平台的新发行版不会使其他平台已安装的版本错误地显示为不支持。

发布已构建、已验证的共享包（运维执行，不在 Windows 节点生成签名）：

```sh
node scripts/publish-node-update.mjs publish \
  --manifest /absolute/build/codey-package.json \
  --output /absolute/feed --private-key /absolute/private.pem \
  --platform windows-x64 --sequence NEW_GLOBAL_SEQUENCE --codey-node-majors 24
```

只声明实测过的 Node major。先上传不可变包和清单，最后原子发布 catalog。不得为了
Windows 重打同版本的应用或改锁文件；先部署支持 Windows 清单的新 Portal，再发布
Windows feed，防止旧 Portal 拒绝新的平台清单。首次使用单台 Windows canary，
真实验收后再扩大范围；单个批次对应一个平台的一个明确发行版。

用户在 Portal 预览、确认；代理才领取任务。忙碌/离线等待，签名、有效期、版本、
Node、配置与防降级检查失败则拒绝。**先结束 Codey 工作并退出 Windows 本机 Codex**：
当前无法安全判定的原生 Codex 进程仍保守视为忙碌，没有 force、没有强杀用户任务。

更新复用原安装中的固定 Node，通过原 npm 的 pacote + `npm ci` 严格安装锁定依赖，
而非全局安装重新解析版本范围。候选与原生模块验证完成前不停止应用。切换前在原
installer mutex 内重验所有应用文件，只重启 Codey 任务，不动隧道/续期任务。
随后要求本机已鉴权健康检查、独立 Codey 真调用和只读临时 Codex CLI 真调用通过，
归档合成会话后才能标记成功。失败不恢复旧数据库/密钥，拒绝覆盖并发部署。

## 崩溃、并发与撤销

- GUI task host 使用 Windows Job Object 管理自己的整棵进程树；宿主崩溃不会留下
  重复代理。Codey/隧道任务由任务计划程序独立创建，不属于该进程树。
- 与本地 CLI 共用 `.local/share/codey-local-update` 锁，同时使用原 Windows
  installer mutex。恢复先于 Portal 请求，已完成的事务只补确认，不重跑模型/安装。
- 无法恢复或发现新用户工作时保留日志与回退记录，进入需人工处理状态；不循环强停。
- 凭据轮换保留签名序号上限。安装代理前若仍有本机事务，则拒绝覆盖代理。
- 撤销只取消授权/未开始的任务，不关机、不删除用户数据；正在切换的本机事务仍需
  安全收尾。授权已失效的最终确认不会让旧 pending 凭据永久阻碍重新接入。

代理状态：`%USERPROFILE%\.config\codey-updater`；
代理和日志：`%USERPROFILE%\.local\share\codey-updater`；
应用事务：`%USERPROFILE%\.local\share\codey-machine-windows\local-updates`。
不要分享 config.json、runtime.json、原始日志或凭据。`rollback_failed` 时按接入包
`UPGRADE.md` 用原 Node 执行 `agent.mjs recover --config <原config.json>`，不要删锁重装。

## 验证边界

```sh
npm run updates:check
npm run updates:test
python3 -I -B test/test_node_updater.py
```

设置 `CODEY_TEST_POWERSHELL` 可额外运行完整 PowerShell 解析、C# 宿主编译、
模拟 Task Scheduler 及恢复测试。测试包含真实的本地 Portal HTTP/签名/授权/队列，
以及代理的隔离状态机、坏签名、平台绑定、防降级、忙碌、并发、回滚和重试确认测试。
模拟任务/模型调用不等于目标 Windows 实机验收。上线仍需检查实际节点的心跳、日志、
真实模型结果与重启恢复，不把“代码实现完成”描述为“Windows 已升级成功”。
