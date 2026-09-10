# Codey Linux 一键节点接入

活动入口是 `skills/config-new-codey-machine/SKILL.md`，Linux x64 只执行：

```bash
bash scripts/install.sh
```

安装包可并行复制到多台机器，包内没有节点 token。运行时在目标机生成独立身份，
最后只上传 `~/codey-machine-registration.json`。

## 固定流程

1. 从 Microsoft 官方源下载并校验 DevTunnel，使用 GitHub device code 登录，配置私有 HTTPS `3001/8443`。
2. 停止旧 copilot-api，安装包内新版本，覆盖配置并启动。
3. 停止旧 Codex，从 OpenAI 官方 installer 更新或安装 latest，覆盖模型配置并做真实请求。
4. 停止旧 CloudCLI，安装包内新版本，启动并通过 CloudCLI 的 Codex SDK 做真实请求。
5. 安装包内签名 updater。
6. 启用 systemd 用户服务、DevTunnel renew timer 和 user linger，验证异常退出自动恢复。

## 包内容

仅三个自有 payload：

- `cloudcli.tar.gz`
- `copilot-api.tar.gz`
- `updater.tar.gz`

Node、Codex、DevTunnel 不进入 ZIP；目标机从各自官方源下载。CloudCLI 通过
`CODEY_CODEX_EXECUTABLE` 使用同一份官方 Codex，不携带 Codex native runtime。

## 数据边界

脚本可以使用 `sudo` 停止旧服务、释放固定端口和启用 linger，但不删除整个 Home。
`~/.codex/auth.json`、`~/.codex/sessions/` 和其他用户文件保留；
`~/.codex/config.toml`、`~/.codex/models.json` 以及 Codey 服务配置按当前版本覆盖。

Windows PowerShell 和 macOS 版本暂不发布；等 Linux 实机流程稳定后再按同样六步迁移。

## 独立发布

完整 Skill ZIP 发布到共享存储的 `machine-bundles/packages-v2/`，使用不可变
`releases/<releaseId>/` 和原子 `active.json`。Portal 只读取并流式返回完整 ZIP，
不再从镜像内文件拼装安装包。

- 更新 Portal：只部署 ACA 镜像，不修改下载包 `active.json`。
- 更新下载包：运行 `scripts/publish-machine-skill.py`，不重启 ACA 或节点服务。
- 两者需要同时更新时，也必须先分别 commit/push，再先发布下载包、后执行 Portal-only ACA 发布。
