# agy 上下文选择器解锁（Windows x86-64 落地记录）

来源：`%USERPROFILE%\Downloads\agy-context-unlock.zip`（上游验证平台 = macOS arm64 / agy 1.4.12）
落地：2026-11-11，Windows x86-64，agy **1.5.5**；2026-11-12 复验 agy **1.5.6**（自动更新覆盖后重跑即恢复）

## 结论

| 项 | 状态 |
|---|---|
| 补丁 1（`offersContextWindow` → `return true`） | ✅ 已打，字节落盘 |
| 补丁 2（`AutoCompactOverride` 恢复环境变量） | ⛔ 未打 —— 上游脚本写明 x86-64 塞不进 8 字节桩，需 trampoline |
| 目标（/model 里能选 512K） | 补丁 1 已覆盖，无需补丁 2 |

## 与原包的三处差异（原样打会失败）

1. **版本太老，符号不存在。**
   本机原装 agy 是 **1.2.12**，Go 符号表里没有 `model.SelectorModel.offersContextWindow`，
   也没有 `store.AutoCompactOverride`，UI 字符串里也没有 `512K`。
   → 必须先 `agy update`（实测 1.2.12 → 1.5.5 可用）。
2. **`find_pclntab` 的 minLC 校验写死 arm64。**
   `agy-patch.py` 里 `if data[i+6] != 4` 只认 arm64 的 minLC=4；x86-64 是 **1**，
   导致报 `error: Go pclntab not found`。已改成 `in (1, 2, 4)`
   （本仓库的 `agy-patch.py` 已包含此修复）。
3. **符号名带 google3 前缀**（`google3/third_party/jetski/cli/model/model.SelectorModel.offersContextWindow`）。
   脚本的 `rsplit("/", 1)[-1]` 正好能消掉，无需改。

## 实际操作序列（可复现）

```bash
# 0. 备份：apply.sh 自动做，落在脚本所在目录的上一级
#    ../_agy_backup_<日期>_<时间>_v<版本>/ （含原样 exe 与 sha256.txt）

# 1. 升到支持该功能的版本（1.2.12 等老版无此功能）
agy update

# 2. 定位符号（只读，不改任何字节）
python agy-patch.py --binary "$LOCALAPPDATA/agy/bin/agy.exe" --locate
# arch=x86-64 text_va=0x140001000 text_off=0x600 symbols=~193000
# model.SelectorModel.offersContextWindow -> 0x14397ca60   (1.5.6)

# 3. 打补丁（只打 1，跳过 env 补丁）——推荐直接跑幂等封装
bash apply.sh                                   # 在本目录内执行
# 或在仓库根： bash unlock/agy-cli/apply.sh
# 等价手动命令：
#   python agy-patch.py --binary "$LOCALAPPDATA/agy/bin/agy.exe" --no-env-fix --in-place
```

## 客观证据（agy 1.5.5 / 1.5.6 两版验证）

- 打补丁前入口字节（标准 Go 栈检查 + 0x3d68 栈帧）：
  `49 89 e4 49 81 ec 68 3d 00 00 0f 82 ...`
- 打补丁后：`b8 01 00 00 00 c3`（`mov eax,1; ret`），后续字节原样保留 `68 3d`
- sha256 前 12 位：1.5.5 `fe9eb2f3884c` → `9c7b636ee430`；1.5.6 `1db38dca719b` → `155d4a77a5c9`
- 补丁后 `agy --version` 正常返回版本号，PE 未损坏
- **跨版本实证**：agy 自动更新 1.5.5 → 1.5.6 后补丁被覆盖丢失，重跑一次 `apply.sh`
  即恢复——符号按名字动态定位，脚本零改动
- 1.5.5/1.5.6 里 `512K` / `900K` / `256K` 三个字符串同时存在，功能确实在

## 未做 / 待人工确认

- **UI 层验收没自动跑。** 上游的 `verify_tui.py` 依赖 `pexpect`（POSIX pty），
  Windows 上不可用。手动验收（5 秒）：开 agy → `/model` → Tab 切 Context 行
  `[Default] -> [256K] -> [512K] -> [900K] -> 回到 [Default]`，
  Enter 确认后写回 `~/.gemini/antigravity-cli/settings.json`。
- Windows 无 codesign，PE 的 Authenticode 签名已失效（不影响本地运行）。

## 每次更新后

`agy update` 会整文件覆盖，补丁丢失；`settings.json` 里的 `contextWindow` 值保留但不再被应用。
**重跑 `bash apply.sh` 即可**（已打过会打印"无需变更"）。

## 回滚

```bash
cp ../_agy_backup_<日期>_<时间>_v<版本>/agy_<版本>.orig.exe \
   "$LOCALAPPDATA/agy/bin/agy.exe"
```
或直接用 updater 留下的 `agy.exe.<ts>.old`。
