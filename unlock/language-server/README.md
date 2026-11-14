# 桌面端上下文上限三档切换器：256K / 512K / 983K

`patch-language_server.py` 修改 **`resources/bin/language_server`**（Windows 为
`language_server.exe`，后端子进程，不是 asar、不是 agy CLI），在
**256K（官方原版）/ 512K（恒定）/ 983K（动态透传）** 三档之间任意切换：

```bash
python unlock/language-server/patch-language_server.py --check   # 看当前档位，不改任何字节
python unlock/language-server/patch-language_server.py --mode 983k
python unlock/language-server/patch-language_server.py --mode 512k
python unlock/language-server/patch-language_server.py --mode 256k   # 完全还原官方
```

切档后**必须完全退出并重开 Antigravity**（language_server 是随会话拉起的子进程）。
任意档位互切都是已知字节模式的等长替换，幂等可重跑，写盘前自动备份到脚本所在目录。

## 三档语义

| 档位 | clamp 站点 | default 站点 | Gate 3B | 用途 |
|---|---|---|---|---|
| 256k | ORIG：`min(x, 256000)` | ORIG：256000 | 还原官方 jne | 完全还原官方行为 |
| 512k | CONST：恒为 524288（`--limit` 可改） | CONST：同上 | NOP（阻断实验覆盖） | 固定 512K，行为可预期 |
| 983k | DYN：`mov esi,edx` 透传模型物理窗口 | ORIG：256000（模型未指定时兜底） | NOP（阻断实验覆盖） | 上限跟模型走，Gemini 4 Argon = 983040 |

983k 档与上游 `meter-context-unlock.js` 的 Gate 3A 语义一致：本工具是它的
**Python 补充形态**——支持从任意状态（含已被本工具或其他方式补过的二进制）切换档位，
而 `cli.js unlock` 只认官方原版字节特征。

## 桌面端到底谁在限制

- **前端 asar（app.asar）不管这事**。它只读 `chatStartMetadata.contextWindowMetadata`
  来显示用量；服务端 metadata 通常仍报 256000，与本地补丁无关。
- **限制在后端** `language_server.exe` 的 `utils.GetCheckpointConfig`（Windows x86-64 实测）：

```asm
; ① 硬 clamp：min(x, 256000)
1418c0da2  cmp    edx, 0x3e800        ; 256000
1418c0da8  mov    esi, 0x3e800
1418c0dad  cmovb  esi, edx
; ② 模型未指定上限时的默认值
1418c111a  mov    dword [rax+0xc], 0x3e800   ; max_token_limit
```

## 实际字节（三态等长替换，不动偏移）

| 站点 | 态 | 字节 |
|---|---|---|
| clamp | ORIG | `81 fa 00 e8 03 00 be 00 e8 03 00 0f 42 f2` |
| | CONST(N) | `be <imm32>` + `90`×9 |
| | DYN | `89 d6` + `90`×12 |
| default | ORIG | `c7 40 0c 00 e8 03 00` |
| | CONST(N) | `c7 40 0c` + imm32 |
| gate3b | ORIG | `75 xx`（jne rel8）或 `0f 85 xx xx xx xx`（jne rel32） |
| | NOP | `90`×2 或 `90`×6 |

版本适应：按**字节模式**匹配不写死偏移（脚本跨 197,971,968 与 197,992,960 字节两个
版本实测命中）；CONST 形状多候选时以 default 站点做 ±8KB 锚点收窄，仍不唯一则中止
并提示先还原备份，绝不乱改。

## Gate 3B：为什么 512K/983K 档要一起打

`config.applyFeatureProviderCheckpointOverrideConfig` 经
`call config.selectCheckpointExperimentKey` → `test al,al` → `jne` 调度实验覆盖；
**CASCADE_USE_EXPERIMENT_CHECKPOINTER 实验命中时会把压缩阈值改回实验值（256K）**，
等于把 Gate 3A 的 clamp 补丁整个架空。本工具移植上游 `meter-context-unlock.js` 的
x64 处理：经 **.gopclntab 符号表**动态定位两函数（不写死偏移），把 jne NOP 掉，使实验
覆盖永不执行。

- 打 3B 时把原始 jcc 字节存进状态目录 sidecar（`gate3b.json`），**256k 档自动还原**；
  sidecar 丢失时警告并指向备份目录。
- 缺符号 / pclntab 定位失败时只降级警告，不阻塞 3A 切档。
- Gate 3B 目前仅在 Windows x86-64（PE）上实现；macOS/Linux 上 3A 档位切换照常可用，
  3B 报「未定位」。

## 状态文件（meter 分母联动，可选）

切档成功后写入（仅打默认路径时；`AG_LS_STATE_DIR` 环境变量供测试重定向）：

- `<状态目录>/AntigravityContextMeter/context-mode.json`：`{"mode":"983k","floor":983040,...}`
- `<状态目录>/AntigravityContextMeter/gate3b.json`：3B 原始 jcc 字节（256k 还原用）

状态目录按平台与 meter 的 `asar-engine.getStateDir()` 约定一致
（Windows `%LOCALAPPDATA%` / macOS `~/Library/Application Support` /
Linux `$XDG_STATE_HOME` 或 `~/.local/state`）。

meter 侧可选联动：注入层读 `context-mode.json`，把 floor 以
`window.__AGContextMeterContextFloor` 前置注入（256k→0 纯透传 / 512k→imm /
983k→983040），`meter-core` 初始化消费，分母随档位显示。不打这个联动补丁也不影响
切换器本身工作。

## 生效与验收

重开后看 meter 分母（512K 档 = 524288；983K 档 = 983040；256K 档 = 256000），
并观察压缩触发点是否后移。

⚠️ **服务端是否接受 >256K 请求未验证**（桌面端链路）。agy CLI 侧实测 594K 请求被接受
（见 [`agy-cli/FINDINGS.md`](../agy-cli/FINDINGS.md) §5）。如果分母变了但长会话仍在
中途报错/被截断，说明卡在服务端，本工具只能延后本地压缩的触发点。

## 回滚

- 切回官方：`--mode 256k`（clamp/default/Gate 3B 全部还原原版字节）
- 或用备份整文件还原（每次实际写盘前自动备份到脚本所在目录 `_ls_backup_<时间>_<sha8>/`，
  含 sha256.txt）
