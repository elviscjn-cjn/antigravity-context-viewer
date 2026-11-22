#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

if [ "$(uname -s)" = "Darwin" ]; then
  if [ -f "/Applications/Antigravity.app/Contents/Info.plist" ] && grep -q "ElectronAsarIntegrity" "/Applications/Antigravity.app/Contents/Info.plist" 2>/dev/null; then
    echo "⚠️  [macOS 预检] 检测到 Antigravity.app 已启用 ElectronAsarIntegrity (ASAR 完整性与官方签名校验)。"
    echo "    直接修改 app.asar 可能导致客户端无法启动或丢失 Keychain/TCC 授权。"
    echo "    👉 推荐改用免改盘守护模式：node cli.js watch"
    echo "    （若需测试强行写入 ASAR 并在自签环境自行重签，可追加参数 --force-mac-asar）"
  fi
fi

node cli.js install "$@"
