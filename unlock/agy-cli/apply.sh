#!/usr/bin/env bash
# agy CLI 上下文选择器解锁 —— Windows x86-64 落地脚本
#
# 作用：把 model.SelectorModel.offersContextWindow 的入口改成 `return true`，
#       让 /model 里对任意模型都出现 Context 行（Default / 256K / 512K / 900K）。
# 背景：官方只对白名单模型（"Gemini 4 Argon"）放出该选择器。
#
# 用法：
#   bash apply.sh              # 打补丁（幂等，已打过会跳过）
#   AGY_BIN=/path/agy.exe bash apply.sh
#
# ⚠️ 每次 `agy update` 覆盖二进制后都要重跑本脚本。

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Windows 上常见只有 python，部分环境只有 python3
PY="$(command -v python || command -v python3 || true)"
[ -n "$PY" ] || { echo "[x] 找不到 python / python3"; exit 1; }
AGY="${AGY_BIN:-$(cygpath -u "$LOCALAPPDATA")/agy/bin/agy.exe}"

[ -f "$AGY" ] || { echo "[x] 找不到 agy.exe: $AGY"; exit 1; }

VER="$("$AGY" --version 2>/dev/null | head -1 | tr -d '\r')"
echo "[i] agy $VER"
echo "[i] $AGY"

"$PY" "$HERE/agy-patch.py" --binary "$AGY" --locate | grep -E "arch=|offersContextWindow" || true

# 先收完整输出再 grep：pipefail 下 `| grep -q` 提前退出会让 python 吃 SIGPIPE，误判为未打补丁
DRY="$("$PY" "$HERE/agy-patch.py" --binary "$AGY" --no-env-fix --dry-run)"
if grep -q "nothing to change" <<<"$DRY"; then
  echo "[=] 已经打过补丁，无需变更。"
else
  # 备份放在用户目录，不落进仓库工作区，避免把原始 exe 误提交
  SAFE_VER="$(printf '%s' "$VER" | tr -c 'A-Za-z0-9._-' '_')"
  BK="$HOME/.antigravity-unlock-backups/_agy_backup_$(date +%Y%m%d_%H%M)_${SAFE_VER}"
  mkdir -p "$BK"
  cp "$AGY" "$BK/agy_${SAFE_VER}.orig.exe"
  sha256sum "$BK/agy_${SAFE_VER}.orig.exe" > "$BK/sha256.txt"
  echo "[i] 备份 -> $BK"
  "$PY" "$HERE/agy-patch.py" --binary "$AGY" --no-env-fix --in-place
fi

echo "[i] 校验：$("$AGY" --version 2>&1 | head -1)"
echo
echo "验收（手动，5 秒）：开 agy -> /model -> Tab 切 Context 行"
echo "  [Default] -> [256K] -> [512K] -> [900K] -> 回到 [Default]"
echo "  Enter 确认后写回 ~/.gemini/antigravity-cli/settings.json"
