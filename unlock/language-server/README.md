# 桌面端上下文上限 → 512K（2026-11-11）

## 结论

改 **`resources/bin/language_server.exe`** 两处立即数，把 checkpoint 的 `max_token_limit`
从 256000 抬到 **524288（512K）**。已落盘，**待重启 Antigravity 生效**。

> `Downloads/agy-context-unlock.zip` 那个包**不适用**：它改的是 `agy` CLI 的 `/model` →
> Context 选择器（macOS arm64 验证）。你把 CLI 和桌面端当成一个东西了，我第一轮也跟着做错了。

## 桌面端到底谁在限制

- **前端 asar（app.asar）不管这事**。它只读 `chatStartMetadata.contextWindowMetadata`
  来显示用量，`MODEL_BUDGET_OVERRIDES` 覆盖表是空的（11-11 已撤销，见文件内注释）。
- **限制在后端** `language_server.exe` 的 `utils.GetCheckpointConfig`：

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

`0xc` 就是 `CheckpointConfig.max_token_limit`（与旧 manifest 里的 `field_offsets` 一致）。

## 实际改动

| 位置 | va | off | before | after |
|---|---|---|---|---|
| ① clamp → 无条件 | `0x1418c0da2` | `0x18c03a2` | `81 fa 00 e8 03 00 be 00 e8 03 00 0f 42 f2` | `be 00 00 08 00` + `90`×9 |
| ② 默认值 | `0x1418c111d` | `0x18c071d` | `c7 40 0c 00 e8 03 00` | `c7 40 0c 00 00 08 00` |

① 是等长替换（14 → 14 字节），不移动后续任何偏移；语义从 `min(x,256000)` 变成「恒为 524288」，
即**不管服务端下发多少，本地一律按 512K 算**。

`0x4000`（16384）那个 clamp 是另一个字段（checkpoint 预算），没动。

## 证据

- 文件大小不变 `197,971,968` 字节
- sha256 `77b76711786b…` → `eba85f0f66d5…`
- 改后反汇编：
  ```
  1418c0da2  mov esi, 0x80000      ; 524288
  1418c110a  ... (原 jg 分支保留)
  1418c111a  mov dword [rax+0xc], 0x80000
  ```
- `patch-language_server.py --check` 自检：`clamp: PATCHED / default: PATCHED`
- 幂等：再跑一次输出「无需变更」

## 生效与验收

**必须完全退出再重开 Antigravity**（`language_server.exe` 是随会话拉起的子进程）。
重开后看会话里上下文用量条的分母是否变成 512K，并观察压缩触发点是否从 ~236k 后移。

⚠️ 未验证的部分：**服务端是否接受超过 256K 的请求**。agy CLI 侧实测 594K 请求被接受
（见 `FINDINGS.md` §5），但桌面端用的是另一条链路。如果重开后分母变了但长会话仍在中途
报错/被截断，说明卡在服务端，这一改只能延后本地压缩。

## 回滚

```bash
cp _ls_backup_20261111_*/language_server.orig.exe \
   "$LOCALAPPDATA/Programs/antigravity/resources/bin/language_server.exe"
```
（`77b76711786b…`，197,971,968 字节，改前原样）

## 客户端更新后

`language_server.exe` 会被整体替换 → 补丁丢失。重跑：

```bash
python unlock/language-server/patch-language_server.py
```

脚本按**字节模式**匹配，不写死偏移；模式对不上会直接报「版本可能变了」而不是乱改。

## 附：旧 manifest 为什么不能用

`~/.gemini/agy-patches/language_server.exe-CL1015941558-*.json` 记录的
是 187,440,128 字节的旧版（`sha256 dd122c19…`），里面那些 va（`0x1418f8f93` 等）
在当前 197,971,968 字节的版本上全部失效。它是**另一套方案**（在
`applyFeatureProviderCheckpointOverrideConfig` 出口插 trampoline，强制 400000），
那套要在代码洞里造 14+ 字节的跳板，比这次的两处立即数改动风险大得多，已弃用。
