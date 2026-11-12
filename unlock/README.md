# unlock/ — 上下文解锁工具集

把 Antigravity 的本地上下文钳制从 256K 解开的一对配套工具。
**只修改本机自己安装的二进制，不分发任何补丁后的文件。**

| 目录 | 目标 | 效果 |
|---|---|---|
| [`language-server/`](language-server/) | 桌面端后端 `resources/bin/language_server` | checkpoint 上限三档切换：**256K（官方）/ 512K（恒定）/ 983K（动态透传模型物理窗口）**，512K/983K 档同时解除 Gate 3B 实验覆盖 |
| [`agy-cli/`](agy-cli/) | agy CLI | `/model` 的 Context 选择器（256K / 512K / 900K）对全部模型解锁（原白名单只有 Gemini 4 Argon） |

## 与 meter 本体的关系

- meter 的分母兜底（`localContextFloor`，默认 524288）就是为配合 `language-server/` 设计的：
  打上补丁后分母如实显示所选档位；不打补丁时，兜底也能避免分母停在 256K 导致压缩距离失真。
  切换器把档位写进状态文件（`context-mode.json`），meter 注入层可选联动、分母自动跟随。
- agy CLI 侧只影响选择器 UI 与压缩阈值提示，不影响 meter 的用量统计。

## 快速开始

桌面端（需 Python 3；三档任意互切；改前自动备份到脚本所在目录；幂等，可重复执行）：

```bash
python unlock/language-server/patch-language_server.py --check          # 先看当前档位，不改任何字节
python unlock/language-server/patch-language_server.py --mode 983k      # 动态透传（上限跟模型走）
python unlock/language-server/patch-language_server.py --mode 512k      # 固定 512K
python unlock/language-server/patch-language_server.py --mode 256k      # 完全还原官方
# 之后必须完全退出并重开 Antigravity（language_server 是随会话拉起的子进程）
```

agy CLI（需 POSIX shell，如 Git Bash；幂等，可重复执行）：

```bash
bash unlock/agy-cli/apply.sh
```

## 诚实声明（务必读）

- **服务端是否接受 >256K 请求，桌面端链路未验证。** agy CLI 侧实测 594K 单请求被接受
  （见 [`agy-cli/FINDINGS.md`](agy-cli/FINDINGS.md) §5）。若桌面端补丁后分母变了
  但长会话仍中途被截断/报错，说明瓶颈在服务端——本工具集只能延后本地压缩的触发点。
- 修改二进制会使 Authenticode（Windows）签名失效，不影响本地运行；macOS 需 ad-hoc
  重签名，见 [`agy-cli/README.md`](agy-cli/README.md)。
- 客户端每次自动更新会整体覆盖二进制 → 档位状态丢失（回到官方 256K）。两个脚本都按
  **字节模式 / Go 符号名**动态定位，不写死偏移，重跑一次 `--mode <档>` 即可恢复；
  模式对不上会报错退出而不是乱改。

## 免责

仅供本地研究与恢复自己机器上的可用性使用；请勿再分发补丁后的二进制；风险自担。
