# unlock/ — 上下文解锁工具集

把 Antigravity 的本地上下文钳制从 256K 解开的一对配套工具。
**只修改本机自己安装的二进制，不分发任何补丁后的文件。**

| 目录 | 目标 | 效果 |
|---|---|---|
| [`language-server/`](language-server/) | 桌面端后端 `resources/bin/language_server.exe` | checkpoint 的 `max_token_limit`：256000 → 524288（512K） |
| [`agy-cli/`](agy-cli/) | agy CLI | `/model` 的 Context 选择器（256K / 512K / 900K）对全部模型解锁（原白名单只有 Gemini 4 Argon） |

## 与 meter 本体的关系

- meter 本体零改动。它的分母读自会话的 `chatStartMetadata.contextWindowMetadata.maxContextTokens`；
  打 `language-server/` 补丁后分母是否随之显示 512K，**尚未实测**（见下方声明）。
- agy CLI 侧只影响选择器 UI 与压缩阈值提示，不影响 meter 的用量统计。

## 快速开始

桌面端（需 Python 3；先完全退出 Antigravity；改前自动备份到 `~/.antigravity-unlock-backups/`；幂等，可重复执行）：

```bash
python unlock/language-server/patch-language_server.py --check   # 先看状态，不改任何字节
python unlock/language-server/patch-language_server.py           # 打补丁
# 之后必须完全退出并重开 Antigravity（language_server 是随会话拉起的子进程）
```

agy CLI（需 POSIX shell，如 Git Bash；改前自动备份到 `~/.antigravity-unlock-backups/`；幂等，可重复执行）：

```bash
bash unlock/agy-cli/apply.sh
```

## 诚实声明（务必读）

- **桌面端补丁只验证了字节层面**（`--check`、幂等、文件大小不变）；重开后分母和压缩点的变化未实测。
- **服务端是否接受 >256K 请求，桌面端链路未验证。** agy CLI 侧实测 594K 单请求被接受
  （见 [`agy-cli/FINDINGS.md`](agy-cli/FINDINGS.md) §5）。若桌面端补丁后分母变 512K
  但长会话仍中途被截断/报错，说明瓶颈在服务端——本工具集只能延后本地压缩的触发点。
- 修改二进制会使 Authenticode（Windows）签名失效，不影响本地运行；macOS 需 ad-hoc
  重签名，见 [`agy-cli/README.md`](agy-cli/README.md)。
- 客户端每次自动更新会整体覆盖二进制 → 补丁丢失。两个脚本都按**字节模式 / Go 符号名**
  动态定位，不写死偏移，重跑一次即可恢复；模式对不上或命中多处会报错退出而不是乱改。

## 免责

仅供本地研究与恢复自己机器上的可用性使用；请勿再分发补丁后的二进制；风险自担。
