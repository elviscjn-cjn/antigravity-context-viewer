# 改善 AGY 有损压缩（压缩后上下文回水与跨 `/fork` 溯源 · Slim-LTS）

> **原作者致谢**：本目录集成的方案与脚本源自 **AGY Post-Compact Rehydration 原作者**发布的《Antigravity CLI 压缩后无损回水（Post-Compact Rehydration）与跨 `/fork` 溯源方案》（原文档：<https://agy-rehydrate.pages.dev/> ，原版脚本：<https://agy-rehydrate.pages.dev/rehydrate_after_compact.py>）。

## 方案概述

当 Antigravity 会话触发自动压缩或执行 `/compact` 时，宿主会生成一条有损的 `<CONTEXT_SUMMARY>` 摘要。`rehydrate_after_compact.py`（Slim-LTS，1,080 行零依赖 Python 3.10+ 标准库脚本）在压缩后下一轮模型调用前的 `PreInvocation` 钩子中，从本地完整 `transcript_full.jsonl` 与工作区文件按 `45,000` UTF-8 字节预算选取并回注四层有界片段（未检测到新的压缩检查点时，不注入额外上下文），并严格标记参考数据权限边界：

1. **Complete User Request Timeline**：完整用户指令时间线（保留早期核心约束与最近提问，尽力遮蔽内联凭据）。
2. **Recent Pre-Compaction Verbatim Dialogue**：压缩前最近多轮对话原文与工具调用链折叠轨迹。
3. **Restored Active Skills & Spec Docs**：实时重读确认访问过的工作区 `SKILL.md` 及 `*SPEC*`/`*PLAN*`/`*TEMPLATE*`/`*HANDOFF*.md`。
4. **Restored Active Workspace Files**：实时重读工作区内 Top 3 最近修改 + Top 3 最近读取普通文本文件。
5. **跨 `/fork` 多级祖先溯源**：默认在 `explicit` 模式下通过首条记录父字段或 `<brain>/fork_lineage.json` 按 `[min_step, K - 1]` 拼接祖先片段（最多 8 级）。

完整技术说明与源码附录请查阅 [AGY-rehydrate-slim-lts-release-v2.md](AGY-rehydrate-slim-lts-release-v2.md)。

---

## 三种启用方式（默认不自动启用，Opt-in）

### 方式一：通过插件面板界面开关（推荐）

1. 打开 Antigravity 顶部上下文面板，切换至 **「配置」** 页签。
2. 可在 **「✨ 一键推荐配置」** 中勾选 `改善 AGY 有损压缩` 预览并应用，或在下方 **「🩹 改善 AGY 有损压缩」** 卡片中独立执行开启、停用、刷新或卸载移除。

### 方式二：通过 CLI 命令行管理

```bash
# 查看当前 Hook、Python 3.10+ 环境与脚本状态
node cli.js rehydrate-status

# 部署脚本到 ~/.gemini/config/hooks/rehydrate_after_compact.py 并启用 post-compact-rehydrate Hook
node cli.js rehydrate:enable

# 临时停用（在 ~/.gemini/config/hooks.json 中设为 enabled: false，保留其他已有 Hook）
node cli.js rehydrate:disable

# 彻底移除 post-compact-rehydrate 条目并清理部署脚本（保留其他已有 Hook）
node cli.js rehydrate:remove
```

### 方式三：独立手动部署

1. 复制本目录的 [rehydrate_after_compact.py](rehydrate_after_compact.py) 至 `~/.gemini/config/hooks/rehydrate_after_compact.py`（macOS / Linux 执行 `chmod +x`）。
2. 在 `~/.gemini/config/hooks.json` 的顶层对象中添加 `"post-compact-rehydrate"` 条目（注意 `enabled` 必须位于 Hook 名称对象顶层，不要破坏已有的其他 Hook 配置）：

```json
{
  "post-compact-rehydrate": {
    "enabled": true,
    "PreInvocation": [
      {
        "type": "command",
        "command": "python3 -X utf8 ~/.gemini/config/hooks/rehydrate_after_compact.py",
        "timeout": 10
      }
    ]
  }
}
```

> Windows 若未提供 `python3` 命令，请将上述 `python3` 替换为 `python`；若 Windows 用户名或 Python 安装路径包含空格，建议直接使用 `node cli.js rehydrate:enable` 或面板开关自动生成免引号转义冲突的 Hook 命令。详细环境变量开关（`AGY_REHYDRATE_MAX_BYTES`、`AGY_REHYDRATE_FORK_MODE` 等）与离线干跑校验命令请参阅 [AGY-rehydrate-slim-lts-release-v2.md](AGY-rehydrate-slim-lts-release-v2.md)。
