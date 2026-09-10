# 验收与精确回退

## 验收

1. 使用本人对应平台完整包，确认 owner/node ID、独立凭据、源码与 Node 摘要匹配。
2. DevTunnel `user show --json` 显示 GitHub；不接受泛化的“已登录”，不切换现有账号。
3. 新服务只监听回环地址；私有隧道仅有 HTTPS 3001/8443，没有匿名访问或额外端口。
   未改防火墙、IP、SSH、现有代理、Codex 登录/config 或其他节点。
4. 本机验证固定 leaf/SAN 的 TLS、节点 ticket、History、Workspace SSO，匿名请求 401。
   配额不可用时，只有绑定本节点的只读数据服务及独立 token-usage 认证均通过才可继续；
   输出 quota warning，不能据此声称模型推理通过。
5. Windows 原 owner 的 InteractiveToken/LeastPrivilege 登录任务、macOS 的 launchd、
   Linux 的 systemd 用户服务使用固定本机运行路径，不以 root/SYSTEM 接管用户会话。
6. **门户实际发起**私有隧道、TLS、认证和 WebSocket 检查，再启用节点。
   本机 health 200、PID 存在、CLI exit 0 或单元测试不能代替这一步。
7. 隧道续期只提交同节点 connect-only 令牌，拒绝改绑、回滚、重放和其他 owner。
   登录过期时由原 owner 完成 GitHub 授权；不静默切换 provider 或创建替代隧道。
8. Linux 升级器需 active/enabled、添加后在门户在线且 owner/ID 一致。
   Windows/macOS 仅以实际 Workspace 检查报告在线，不伪造 Linux 更新心跳。
9. 模型登录与接入分开验收。用户要求聊天能力时，需真实 Codey 和 Codex 回答。
10. 重跑已成功安装只验收，不改服务、身份或运行版本；重启/注销恢复必须另行实测。

## 排障

- 包/摘要/平台不匹配：停止，重下同一待配置身份的完整包，不拼凑凭据。
- 端口或服务已占用：停止；工作中的 A100 等节点不能拿首次安装器直接覆盖。
- CLI 是 Microsoft 登录：保留缓存，要求本人审查 GitHub 登录，不能自动 logout。
- CLI 输出中 ID 已带区域后缀：仅使用经过严格核对的 ID/cluster，不猜区域。
- 权限不足、公司代理或 GitHub/DevTunnel 策略拒绝：报告具体阶段，不开放匿名访问。
- TLS、ticket、SSO、匿名拒绝失败：保持未添加，不关闭证书验证或跳过认证。
- Windows 恢复和原生 Codex 缓存修复：使用 [独立恢复说明](windows-recovery.md)，不重新建节点。

## 精确回退

- 失败只停止本次新建、归属/路径明确的进程或服务；保留诊断和原有数据。
- Linux 范围：本次新建的 codey-copilot-api、codey-cloudcli、codey-node-updater、
  codey-devtunnel、codey-devtunnel-renew 服务/定时器。不能停止同机既有的同名服务。
- Windows/macOS 只撤回本次明确创建的任务/LaunchAgent，不接管原 Desktop/代理。
- 隧道/待配置身份的取消或删除需单独确认，只操作本节点已记录的精确 ID。
- 已添加节点由 owner 在门户移除，仅撤销门户访问；不删除机器文件/项目/会话。
- 不关闭其他用户服务依赖的 linger，不清理登录缓存，不递归删除用户目录。
- 含密钥的 ZIP/临时副本留在 owner 受保护目录；公开交付仅含非敏感机器文件和报告。
