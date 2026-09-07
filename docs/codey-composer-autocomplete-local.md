# 输入智能补全：本地试用

日期：2026-09-06  
状态：本文记录 2026-09-06 的独立本地试用。2026-09-07 用户另行授权后已上线，
见 `docs/codey-composer-autocomplete-release.md`；本地试用实例仍保留。

## 已实现

- Portal 独立接口调用 Foundry `gpt-5.6-luna`，使用固定短后缀 prompt、
  Responses API、严格 JSON 输出、`reasoning.effort=none`，不配置任何工具。
- 桌面完整可见的浅色候选，普通 `Tab` 采纳、`Esc` 忽略。
- 模式切换改为 `Ctrl+Alt+M`；保留模式按钮，不占用浏览器的
  `Ctrl+Tab`、`Ctrl+Shift+Tab` 或反向焦点导航的 `Shift+Tab`。
- 手机使用全文建议条与明确的「补全」按钮；采纳不发送，支持专用「撤销补全」。
- 默认关闭。明确开启后才在有效输入停顿时请求，历史上下文可单独关闭。
  即使补全服务不可用，仍能关闭已开启的选项。
- 草稿末尾补全、500ms 防抖、2s 最小请求间隔、有界上下文和短期内存缓存。
  输入法组合、录音/转写/润色、选区、菜单、切会话、退出登录和程序性恢复等
  会暂停或取消补全；迟到响应不能覆盖当前草稿。
- 未采纳的建议不进入草稿保存或消息发送；已采纳的文字使用现有条件写入流程，
  只有写入被实际确认后才提供撤销。

## 访问当前实例

本机回环地址：

```text
http://127.0.0.1:4311
```

如果浏览器在自己的电脑上，而本仓库在远程开发机上：

1. 使用 VS Code / SSH 的端口转发，把远程 `4311` 转到本机 `4311`。
2. 在自己的浏览器打开上面的地址。
3. 使用独立试用密码，不是生产 Portal 的登录密码。

当前实例及密码位置可在仓库根目录查询：

```bash
node --input-type=module <<'JS'
import { readFile } from 'node:fs/promises';
import path from 'node:path';
const artifact = (await readFile('artifacts/composer-completion-local-current.txt', 'utf8')).trim();
const service = JSON.parse(await readFile(path.join(artifact, 'preview-service.json'), 'utf8'));
console.log(await readFile(path.join(service.directory, 'access.txt'), 'utf8'));
JS
```

不创建公网入口、不修改防火墙，也不复用生产 cookie。
预览使用独立 systemd 用户单元，当前单元名记录在 `preview-service.json`，
不会因为终端结束而退出。

## 建议试法

1. 展开输入框下方「自动补全」，勾选「开启自动补全建议」。
2. 输入 `Please explain` 或 `请把上一段回答总结成`，停顿等待候选。
3. 桌面按 `Tab` 或点击「补全」；手机点击「补全」。确认只有文字追加，没有发送。
4. 点击「撤销补全」，确认恢复原输入，且不重新请求模型。
5. 试试 `Esc`、移动光标、继续输入、中文输入法、切换会话 A/B。
6. 点击「编辑测试上下文」可以修改参考消息；也可关闭历史上下文做对比。
7. 当前输入语义完整或指代不明确时，Luna 可以返回空候选，这是正常结果。

页面使用真实的 `ChatComposer` 和草稿 hook，但会话是独立合成数据。
「发送」只追加本地测试上下文，**不运行 Codex/Claude、不调用聊天代理、
不读取生产历史或文件、不执行节点任务**。真实 Luna 只用于补全请求。
试用设置和草稿仅保存在预览进程内，进程重启即清空；浏览器原有镜像机制仍按
独立 `local-preview` 路径隔离。

## 手动启动一个新的本地实例

现有实例占用 `4311` 时，请使用另外一个空闲的本地端口，例如 `4312`。

```bash
# 默认模拟模式：完全不调用模型
npm run completion:preview -- --port 4312

# 真实 Luna：只读取服务端 Foundry 绑定，不修改该文件
npm run completion:preview -- --real-model --port 4312 --env-file /home/zhn/g/codey/.env
```

脚本仅监听 `127.0.0.1`。它从当前未提交的前端源码创建独立快照，
执行 `build:client`，然后启动独立服务。构建不接触服务端凭据，不构建或替换
工作区的 `dist-server`，不覆盖生产发布目录。
日志中的 `accessFile` 给出该实例独立密码的位置。`--skip-build` 只用于重新启动
已有且 mock/real 模式一致的试用产物，不能加载源码的新改动。

退出手动启动的实例可按 `Ctrl+C`。停止后台实例时，先确认 `preview-service.json`
中记录的单元和 PID 属于本次试用，再仅停止该单元；不要停止
`codey-cloudcli.service` 或 `copilot-api.service`。

## 本次验证结果

- Portal 全部 129 项测试通过；前端 65 个文件、481 项测试通过。
- 前后端 TypeScript 类型检查通过；Portal 新模块语法检查通过。
- 完整共享前端在隔离快照中构建并校验成功，产物未发布。
- Lint：0 errors、128 warnings。现有警告未做无关迁移；
  新试用入口有一项开发期 Fast Refresh 导出警告，不影响构建或运行。
  现有 CSS 压缩和大 chunk 构建警告仍存在。
- Chromium 桌面 1200px / 触屏模拟 375px 验证了真实 Luna 请求、
  桌面浅色候选、手机建议条、显式采纳、不自动发送、保留焦点和无额外请求的撤销。
  桌面还验证了模式快捷键、反向 Tab 和切会话后的候选清理。
- 浏览器回归没有产生生产请求、页面异常或失败的 HTTP 响应。

日志、屏幕截图、构建包和访问元数据保存在
`artifacts/composer-completion-local-current.txt` 指向的忽略目录中，
不包含在 Git 提交范围内。

## 上线边界与本地试用限制

- 本地试用脚本不修改生产环境变量；后续独立生产发布已开启服务端能力，
  但不会替用户开启补全偏好。没有显式服务端配置的其他安装仍默认禁用。
- 首版每账号 30 请求/分钟、突发 3、单账号并发 1、实例并发 16；
  默认每账号 UTC 日累计上限 1000 次尝试。限流、并发和日额度均在内存中，
  重启会重置，不能用于多副本全局限额保证。
  `COMPOSER_COMPLETION_SINGLE_INSTANCE=true` 是显式部署约束确认。
- 如需不同 Foundry 资源，必须配置对应的
  `COMPOSER_COMPLETION_ENDPOINT` / `COMPOSER_COMPLETION_API_KEY`，
  不允许把已有资源的密钥发送给任意新 endpoint。
- 常见凭据过滤不是完整的秘密检测；处理机密内容时应关闭自动补全。
- 专用撤销按钮已实现；不声称受控 textarea 的程序性写入在所有浏览器中
  都能被原生 `Ctrl/Cmd+Z` 单独撤销。
- 移动端浏览器自动化使用触屏模拟，不代替 iOS / Android 实机软键盘、
  不同输入法、辅助技术和操作系统快捷键的人工验收。
- 当前上下文沿用既有正文过滤与 UTF-8 边界裁剪，不额外改变手动润色规则。
  裁剪后的历史正文暂未附加显式截断标记；需在后续语义质量回归中评估。
- 少量合成模型请求用于确认集成，不代表生产延迟、吞吐或语义质量承诺。
