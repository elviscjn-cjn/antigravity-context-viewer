# 桌面端上下文上限 → 512K（language_server）

## 作用

改桌面端后端 **`resources/bin/language_server.exe`** 里的两处立即数，把 checkpoint 的
`max_token_limit` 从 256000 抬到 **524288（512K）**。

- 前端 asar（app.asar）不决定这个上限：它只读 `chatStartMetadata.contextWindowMetadata` 来显示用量。
- 限制在后端 `language_server.exe` 的 `utils.GetCheckpointConfig`。

## 桌面端到底谁在限制

以下地址来自 197,971,968 字节的版本（2026-11-11），仅作说明，脚本**不依赖这些地址**：

```asm
; ① 硬 clamp：min(x, 256000)
1418c0da2  cmp    edx, 0x3e800        ; 256000
1418c0da8  mov    esi, 0x3e800
1418c0dad  cmovb  esi, edx
1418c0db0  mov    [rsp+0x50], esi

; ② 模型未指定上限时的默认值
1418c1114  cmp    dword [rdx+0x14], 0
1418c1118  jg     skip
1418c111a  mov    dword [rax+0xc], 0x3e800   ; max_token_limit
```

`0xc` 即 `CheckpointConfig.max_token_limit`。

## 实际改动

| 位置 | before | after |
|---|---|---|
| ① clamp → 无条件 | `81 fa 00 e8 03 00 be 00 e8 03 00 0f 42 f2` | `be 00 00 08 00` + `90`×9 |
| ② 默认值 | `c7 40 0c 00 e8 03 00` | `c7 40 0c 00 00 08 00` |

① 是等长替换（14 → 14 字节），不移动后续偏移。语义从 `min(x, 256000)` 变成「恒为 524288」，
即**不论服务端下发多少，本地一律按 512K 计算**（包括原本上限低于 256K 的模型）。

`0x4000`（16384）那个 clamp 是另一个字段（checkpoint 预算），没动。

## 用法

```bash
# 先完全退出 Antigravity（language_server.exe 运行时文件被占用，无法写入）
python unlock/language-server/patch-language_server.py --check   # 只读自检
python unlock/language-server/patch-language_server.py           # 打补丁（自动备份）
python unlock/language-server/patch-language_server.py --limit 600000   # 自定义上限
```

脚本行为：

- 按**字节模式**定位，不写死偏移；模式找不到、或**命中不止一处**时直接中止，不改任何字节。
- 幂等：已打过会输出「无需变更」。
- 改前备份到 `~/.antigravity-unlock-backups/_ls_backup_<时间>_<sha8>/`（含 `sha256.txt`），不落进仓库。

## 已验证 / 未验证

已验证（Windows，197,971,968 字节版本）：

- 补丁后文件大小不变；`--check` 输出 `clamp: PATCHED / default: PATCHED`；重跑输出「无需变更」。
- 改后反汇编：`mov esi, 0x80000` 与 `mov dword [rax+0xc], 0x80000`。

**未验证：**

- 重开 Antigravity 后，会话用量条的分母是否真的变成 512K、压缩触发点是否从约 236K 后移。
- 服务端是否接受超过 256K 的请求。agy CLI 侧实测 594K 单请求被接受
  （见 [`../agy-cli/FINDINGS.md`](../agy-cli/FINDINGS.md) §5），但桌面端走的是另一条链路。
  如果分母变了但长会话仍中途报错或被截断，说明瓶颈在服务端，本补丁只能延后本地压缩。

## 回滚

```bash
cp ~/.antigravity-unlock-backups/_ls_backup_<时间>_<sha8>/language_server.orig.exe \
   "$LOCALAPPDATA/Programs/antigravity/resources/bin/language_server.exe"
```

## 客户端更新后

`language_server.exe` 会被整体替换，补丁丢失。重跑脚本即可；若字节模式变了，脚本会报错退出，
需要重新定位。
