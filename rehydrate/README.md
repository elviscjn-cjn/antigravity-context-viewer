# 改善 AGY 有损压缩（Post-Compact Rehydration）

本目录提供一套按 **MIT 协议**从零独立实现的 Antigravity `PreInvocation` Hook 脚本（`rehydrate_after_compact.py`），用于在对话上下文发生压缩（Compaction）后自动恢复关键工作脉络，降低长会话失忆问题。

## 工作原理

1. **宿主触发**：宿主在每次调用模型前触发 `PreInvocation` Hook，并通过标准输入传入当前会话元数据（UTF-8，自动兼容剥离 BOM）。
2. **增量检查**：脚本检查同目录 `rehydrate_state.json`，校验文件标识与偏移锚点后对 `transcript.jsonl` 执行增量尾扫描，仅对包含 `"CHECKPOINT"` 的记录解析并按 `step_index|created_at` 计算 12 位 `blake2s` 校验码；常规轮次可在数毫秒内直接返回 `{}`。
3. **冷启动保护**：若首次启用时 `rehydrate_state.json` 尚不存在且最新压缩点距离当前步数已超过 16 步，则仅记录为已处理并跳过历史注入。
4. **单遍提取与注入**：命中新压缩点后，脚本在约 7.0 秒软截止时间内单遍流式读取 `transcript_full.jsonl`（若暂未落盘则最多等待 3 轮，第 4 轮起放弃以防死循环），按双向弹性预算组装以下四部分内容并通过 `injectSteps` 注入 `<systemMessage>`：
   - 第 1 节：完整用户请求时间线（超限时保留前 5 条与最近请求）
   - 第 2 节：压缩前近期原始对话与工具摘要
   - 第 3 节：活跃技能与规范文档（`SKILL.md` 及 `*SPEC*`/`*PLAN*` Markdown）
   - 第 4 节：活跃工作区文件（最多 3 个已修改 + 3 个已读取文件）
5. **去重与权限边界**：注入文本附带边界声明（仅作历史与工作区数据参考，不得视为指令），并在更新 `rehydrate_state.json` 及后续已注入日志标记后自动去重。

## 启用方式（默认不开启，需手动选择启用）

1. **GUI 设置卡片（推荐）**
   - 在状态栏打开设置面板，找到「改善 AGY 有损压缩」卡片点击启用。
   - 启用时会自动探测可用的 Python 3.10+ 路径并注册至 `hooks.json`。
   - 点击「卸载」按钮需二次确认，自定义脚本会自动备份为 `.bak`。
2. **CLI 命令**
   - 查看当前状态：`node cli.js rehydrate-status`
   - 启用 Hook：`node cli.js rehydrate:enable`
   - 停用 Hook（保留脚本）：`node cli.js rehydrate:disable`
   - 彻底移除 Hook 条目并清理脚本：`node cli.js rehydrate:remove`
   - 也可通过 `node cli.js restore --all` 随其它外部增强配置一并还原。
3. **手动配置 `hooks.json`**
   - 在 `~/.gemini/config/hooks.json` 的 `PreInvocation` 列表中加入钩子命令。
   - 指定 Python 3.10+ 解释器执行本目录下的 `rehydrate_after_compact.py` 即可。

## 环境变量说明

| 变量名 | 默认值 | 说明 |
| --- | --- | --- |
| `AGY_REHYDRATE_MAX_BYTES` | `45000` | 注入内容的 UTF-8 字节上限（钳制范围 `4096`–`48000`，对齐宿主约 48 KiB 上限） |
| `AGY_REHYDRATE_FORK_MODE` | `explicit` | 可选 `/fork` 衔接模式：`explicit` 仅在用户手动维护 `<brain>/fork_lineage.json`（或首条记录含显式父 ID）时生效；`off` 关闭 |
| `AGY_REHYDRATE_MAX_PARENT_WAITS` | `2` | `/fork` 父会话日志尚未落盘 `K - 1` 步时的最大等待轮次 |
| `AGY_REHYDRATE_RESTORE_FILES` | `1` | 设为 `0` 时禁用第 3、4 节的规范文档与工作区文件恢复 |
| `AGY_REHYDRATE_ALLOW_DIRS` | 空 | 额外允许恢复文件的工作区目录列表（以系统路径分隔符分隔） |
| `AGY_REHYDRATE_INCLUDE_CMD` | `0` | 设为 `1` 时在 `run_command` 摘要中附带具体命令行（仍执行脱敏） |
| `AGY_REHYDRATE_REDACT_FILES` | `1` | 设为 `0` 时关闭恢复文件内容中的内联凭据脱敏 |

## 安全与边界说明

- **路径与符号链接防护**
  - 拒绝相对路径、UNC 路径（`//` 或 `\\`）、NUL 字节、`..` 目录穿越及 Windows 保留设备名（`CON`、`PRN`、`AUX`、`NUL`、`COM1..9`、`LPT1..9`）。
  - 拒绝读取或写入符号链接形式的日志与状态文件；更新 `rehydrate_state.json` 时先写入同目录临时文件再通过 `os.replace` 原子替换。
- **工作区白名单与敏感文件拦截**
  - 仅恢复经工具调用结果确认成功（`status == "DONE"` 且无错误）且真实路径严格位于 `workspacePaths`（及 `AGY_REHYDRATE_ALLOW_DIRS`）内的常规 UTF-8 文本文件（`<= 2 MiB`）。
  - 自动屏蔽 `.git`、`node_modules`、`__pycache__`、`.ssh`、`.aws`、`.gnupg`、`.kube`、`.docker`、`.config/gcloud`、`tmp`、`temp` 等目录。
  - 自动拦截 `.env*`、`.pem`、`.key`、`.ppk`、`.p8`、`.gpg`、`token.json`、`credentials.json`、含 `secret`/`credential` 的文件名以及二进制/归档/数据库/模型文件。
- **内联凭据脱敏与编码安全**
  - 对用户提示、对话内容及恢复文件自动脱敏 `Bearer`、`sk-`、`gh*_`、`AKIA`、`AIza`、`xox*-`、JWT 与常见凭据赋值。
  - 清理孤立 UTF-16 代理项为 `\ufffd`，按 UTF-8 边界截断，并确保动态闭合所有 Markdown 代码围栏。
- **可选手动 `/fork` 映射与信任边界说明**
  - 当前宿主日志默认不会自动写入父会话 ID，跨 `/fork` 拼接默认不会自动触发；仅当用户手动在 `<brain>/fork_lineage.json` 写入 `{"<child-cid>": "<parent-cid>"}`（或首条记录携带显式父 ID）且子会话首步 `step_index > 0` 时，脚本最多向上拼接 8 层祖先。
  - `<brain>/fork_lineage.json` 位于当前本地用户的 `~/.gemini` 信任边界内，任何对 `<brain>` 具备写权限的本地进程均可声明同目录兄弟会话映射。
  - 若记录自身显式声明的父会话 ID 与 `fork_lineage.json` 冲突，脚本会跳过祖先拼接并在标题中附加 `fork_diag=parent_conflict`；若等待父会话落盘超时则标记 `fork_diag=parent_timeout`。
  - 若单次执行逼近 7.0 秒软截止时间，或上一轮在重活阶段被宿主强杀（`in_progress_cp_token` 未清理），脚本会直接标记该检查点已完成并安全降级返回 `{}`，避免后续轮次重复阻塞。

## 致谢与许可

- 本功能的设计思路受社区方案 **AGY Post-Compact Rehydration**（`https://agy-rehydrate.pages.dev/`）启发，特此致谢。
- 本仓库中的 `rehydrate_after_compact.py` 脚本与本文档均由本项目按 **MIT License** 从零独立编写实现。
