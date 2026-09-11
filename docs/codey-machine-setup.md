# Codey Linux 一键节点接入

## Skill ZIP 交付

需要 Skill 时，应交付 `config-new-codey-machine.zip`，而不是只有 README 和脚本的
普通 ZIP。完整包以 `config-new-codey-machine/` 为根，包含 `SKILL.md`、
`agents/openai.yaml`、`scripts/install-npm.sh` 和唯一的 `assets/codey-<version>.tgz`。

在 Skill 根目录执行：

```bash
bash scripts/install-npm.sh --package assets/codey-*.tgz
```

这里解压的是 Skill 载体，应用仍由 npm 安装；无需手工解压 `.tgz`。
下面的独立 npm 包和小型脚本下载是另一种入口，不替代 Skill ZIP。

## 独立 npm 入口

活动入口是 `skills/config-new-codey-machine/SKILL.md`。Linux x64 从 Portal
直接下载 `codey-<version>.tgz` 和 `install-codey-linux.sh`，放在同一目录后执行：

```bash
bash install-codey-linux.sh
```

安装包可并行复制到多台机器，包内没有节点 token。运行时在目标机生成独立身份，
最后只上传 `~/codey-machine-registration.json`。

不再要求用户先解压 ZIP。脚本通过 npm 安装唯一 Codey 应用，再运行包内的
`codey setup`。它支持本地 `.tgz`、明确的 HTTPS `.tgz` URL，以及固定版本加显式
私有 registry：

```bash
bash scripts/linux/install-codey.sh --package ./codey-0.1.0.tgz
bash scripts/linux/install-codey.sh --package https://packages.example/codey-0.1.0.tgz
bash scripts/linux/install-codey.sh --package codey@0.1.0 --registry https://npm.example/
```

上述 `scripts/linux/install-codey.sh` 是仓库内的源脚本。发布后的脚本名为
`install-codey-linux.sh`，已填好同目录 npm 文件名。默认安装到新的、当前用户所有的
`~/.local/share/codey-machine/releases/npm-*` prefix；准备依赖和检查配置完成后才会
停止旧服务。`--prefix` 不允许覆盖已有目录。

已有 Node.js 22.13+ 时也可以直接安装并部署：

```bash
npm install --global --prefix "$HOME/.local" ./codey-0.1.0.tgz
"$HOME/.local/bin/codey" setup --check
"$HOME/.local/bin/codey" setup
```

仅 npm 安装不会自动部署。`codey setup --check` 不改服务或凭据、不做模型调用；
一键脚本的 `--check` 会安装并验证 npm 依赖，但不执行部署。不要把安装包放在
系统级 root 所有的 prefix；升级器只管理当前用户 HOME 下受支持的 npm 路径。

一键部署或 `codey setup` 会创建稳定入口 `~/.local/bin/codey`，并将
`$HOME/.local/bin` 自动加入 Bash 的持久化 PATH：写入 `.profile`、`.bashrc`，
以及已存在的 `.bash_profile` / `.bash_login`，不覆盖其他配置或重复添加目录。
新终端可直接运行 `codey`。已打开的终端不能由安装子进程修改环境；
立即使用时执行 `export PATH="$HOME/.local/bin:$PATH"`。仅 npm 安装及
`--check` 不修改这些 shell 配置。

`machine:build` 在包内加入 `onboarding/setup.json`，只有 Portal origin、平台、
隧道方式和升级器公钥，没有机器身份、账号或 token。普通 `codey:build` 不绑定
Portal，部署时需显式提供 `codey setup --config <公开配置.json>`。

## 网关默认设置

`codey start`、`codey gateway` 和 `codey auth` 在加载网关前启用 Codey 模式。
该模式下 `useResponsesApiWebSocket` 默认 `false`，新配置和缺少该字段的已有配置
都会使用此默认值；已有的显式 `true` / `false` 优先，不会被默认值覆盖。
安装器不再重复写入该字段，也不影响 Workspace 自身的 WebSocket。

## 固定流程

1. 从 Microsoft 官方源下载并校验 DevTunnel，使用 GitHub device code 登录，配置私有 HTTPS `3001/8443`。
2. 先停止旧 Workspace 和 Codex，再停止旧 copilot-api，使用已安装的 npm 包覆盖配置并启动。
3. 停止旧 Codex，从 OpenAI 官方 installer 更新或安装 latest，覆盖模型配置并做真实请求。
4. 停止旧 CloudCLI，使用同一 npm 包启动 Workspace，并通过 Codex SDK 做真实请求。
5. 安装包内签名 updater。
6. 启用 systemd 用户服务、DevTunnel renew timer 和 user linger，验证异常退出自动恢复。

## 包内容

只有一个真正的 npm 应用包 `codey-<version>.tgz`，主包定义在
`packages/codey/package.json`。两份 submodule 是构建输入，不再是两个
独立安装的 npm 应用，也不是 `codey` 的 npm dependencies。

```text
package/
├── package.json          # name: codey；唯一应用 manifest 和 bin
├── npm-shrinkwrap.json   # 统一生产依赖锁
├── bin/codey.mjs         # 唯一 CLI
├── lib/                 # CLI 和内联的 Codex SDK JS
├── dist-server/         # Workspace 后端
├── dist/                # Workspace 静态前端
├── gateway/             # 模型网关后端
├── pages/               # 网关静态页面
├── updater/             # 签名更新器
├── onboarding/          # Linux 部署脚本、模型模板；机器构建还包含公开 setup.json
└── codey-build.json      # 源码版本与构建指纹
```

兼容 ZIP 的 `assets/manifest.json` 使用 schema 2、`name: codey` 和
`dependencyMode: npm-codey-package`，记录 npm 包的 SHA-256、Codey 版本和统一
release ID，同时保留两份源码各自的 commit/version 以便追溯。安装器只执行
一次 `npm install --global --prefix <私有 release> <包内 tgz>`，并在停止旧服务前
检查入口、构建指纹、共享依赖和 SQLite/PTY 原生模块。

直接 npm 安装后的 `codey setup` 从 `codey-build.json` 派生临时公开元数据，
使用 `dependencyMode: npm-installed`；不会寻找 `assets/*.tgz`、重新执行 npm 安装、
移动应用目录或清理其他 npm prefix。两条入口最终共用相同的六步配置逻辑。
新机器的 installer release ID 来自 `codey-build.json` 的 SHA-256 前 16 位，
与是否经过兼容 ZIP、目标机的具体 Node 版本无关。

两个服务的 `WorkingDirectory` 都指向同一个 `lib/node_modules/codey`。
它们共用 Node、主 manifest 和依赖树，入口分别为 `codey workspace`、
`codey gateway start`，没有嵌套的应用包或第二棵应用依赖树。
两个源码 submodule、现有服务名、端口和数据路径不变。

Node、Codex、DevTunnel 不进入应用包；目标机从各自官方源下载。CloudCLI 通过
`CODEY_CODEX_EXECUTABLE` 使用同一份官方 Codex，不携带 Codex native runtime。
锁定版 Codex SDK 的 JS 和许可证在构建阶段内联为 `#codey/codex-sdk`；
避免其 npm 依赖再引入第二份 Codex。其他第三方依赖由 npm 按统一 shrinkwrap 安装。

外层 `config-new-codey-machine.zip` 同时是完整 Skill 的交付和发布交接格式。
Skill 通过 `scripts/install-npm.sh --package assets/codey-*.tgz` 走相同的 npm 安装流程。
旧入口 `bash scripts/install.sh` 仍保留兼容，但不手工解压安装应用。
也可构建用于普通服务启动的标准 npm 包：

```bash
npm run codey:build -- --output artifacts/codey-npm
npm install --global ./artifacts/codey-npm/codey-0.1.0.tgz
codey --version
codey start
```

公共 npm registry 的 `codey` 名称已被其他项目使用；没有取得名称权限前，
只分发此 `.tgz` 或使用明确配置的私有 registry，不要执行公共源的
`npm install -g codey`。本地构建不执行任何 npm publish。

## 整包升级

新节点的 updater 报告 `layout: npm` 及 `components.codey`，只接受一个 `codey`
组件的签名发布。升级按 shrinkwrap 准备统一依赖，停止两个服务，原子替换一个
包目录，再启动和验收两个服务；失败时整体回滚代码与构建标记，不回滚用户数据。
旧节点继续使用原来的分组件协议，两种布局互相拒绝不兼容的发行版。
新发行目录的 `codey-package.json` 可以直接交给 `scripts/publish-node-update.mjs`，
但仍须提供独立的 `validation.json` 或 `report.json` 验收证据才可签名。

## 数据边界

脚本可以使用 `sudo` 停止旧服务、释放固定端口和启用 linger，但不删除整个 Home。
`~/.codex/auth.json`、`~/.codex/sessions/` 和其他用户文件保留；
`~/.codex/config.toml`、`~/.codex/models.json` 以及 Codey 服务配置按当前版本覆盖。

Windows PowerShell 和 macOS 版本暂不发布；等 Linux 实机流程稳定后再按同样六步迁移。

## 独立发布

发行版发布到共享存储的 `machine-bundles/packages-v2/`，使用不可变
`releases/<releaseId>/` 和原子 `active.json`。发布器从已验证的兼容 ZIP 中取出
原样的 Codey npm 包和小型一键脚本，三份文件及 manifest 全部上传成功才切换 active。
Portal 从共享存储直接流式返回文件，不从镜像拼装，不把应用内嵌为 Base64 脚本。

- `POST /api/settings/machines/npm`：标准 Codey npm `.tgz`。
- `POST /api/settings/machines/installer`：`install-codey-linux.sh`。
- `POST /api/settings/machines/skill`：旧 ZIP 兼容入口。

三个入口保持相同的登录、CSRF、下载并发和无身份副作用边界。新文件必须通过
路径、大小、文件类型和 SHA-256 校验；旧发行版未提供 `npmSetup: 1` 及独立文件时，
新按钮禁用、npm 请求返回 503，不把 ZIP 伪装成 npm 包。

- 更新 Portal：只部署 ACA 镜像，不修改下载包 `active.json`。
- 更新下载包：运行 `scripts/publish-machine-skill.py`，不重启 ACA 或节点服务。
- 首次迁移到 npm 布局时，先部署支持 `codey` 整包更新的 Portal，再发布新的
  安装 Skill；Portal 仍兼容旧 ZIP 与旧节点。不要只发布新包而保留不认识 npm
  布局的旧 Portal 更新服务。

构建完整 Skill：

```bash
npm run machine:build -- --output <新目录> \
  --portal-origin <HTTPS-origin> --updater-public-key-file <公钥文件>
```

构建器生成 `codey-<version>.tgz`、`install-codey-linux.sh`、`codey-package.json`、`manifest.json` 和兼容
Skill ZIP。发布器会检查 npm 包内唯一的应用 manifest、统一 shrinkwrap 和编译入口，
不再接受旧的三个分包或仅改名的普通 tar。已发布 ZIP 和 Portal 外层 manifest
仍保留，不迁移或覆盖旧下载内容。
