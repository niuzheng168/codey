# 已归档：旧入口及 Windows 恢复工具

这是模块拆分前的公开源码快照，保留 pre-task Resume、已接入节点 Codex 修复及其回归测试。
不属于新的首次安装流程，不随主 Skill / Docker / 个性化下载包分发。

- `skills/config-new-codey-machine/`：上一版已交付 review 的完整源码，未改写历史脚本。
- `test/`：与该快照匹配的离线回归；不得把测试 fixture 当作真实节点配置。
- `archive-manifest.json`：逐文件 SHA-256 和来源 commit。

需要恢复旧节点时，先单独审查该工具适用范围和当前节点状态；不要直接运行历史安装入口。
VNet 历史方案另见相邻的 `config-new-codey-machine-vnet-20260909/`。
