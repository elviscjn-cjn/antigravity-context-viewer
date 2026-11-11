#!/usr/bin/env python3
"""把反重力（Antigravity 桌面端）的上下文上限从 256K 抬到 512K。

改的是后端子进程 resources/bin/language_server.exe（不是 asar，不是 agy CLI）。

依据：utils.GetCheckpointConfig 里两处 256000
  1. 硬 clamp：cmp edx,0x3e800 / mov esi,0x3e800 / cmovb esi,edx  → min(x, 256000)
     改成无条件 mov esi, <limit> + nop*9（等长 14 字节，不动后续偏移）
  2. 默认值：模型没指定上限时 mov dword [rax+0xc], 0x3e800 → <limit>

实测记录（2026-11-11，客户端语言服务器 197,971,968 字节）：
  va 0x1418c0da2  81 fa 00 e8 03 00 be 00 e8 03 00 0f 42 f2
  va 0x1418c111d  00 e8 03 00（属于 c7 40 0c 00 e8 03 00）

用法：
  python patch-language_server.py            # 打补丁（自动备份）
  python patch-language_server.py --check    # 只看状态
  python patch-language_server.py --limit 512000
"""

import argparse
import hashlib
import os
import shutil
import sys
from datetime import datetime

DEFAULT = os.path.expandvars(
    r"%LOCALAPPDATA%\Programs\antigravity\resources\bin\language_server.exe")
BACKUP_ROOT = os.path.dirname(os.path.abspath(__file__))  # 备份落在脚本所在目录

CLAMP_ORIG = bytes.fromhex("81fa00e80300be00e803000f42f2")  # min(x, 256000)
CLAMP_LEN = len(CLAMP_ORIG)                                  # 14


def clamp_new(limit: int) -> bytes:
    return b"\xbe" + limit.to_bytes(4, "little") + b"\x90" * (CLAMP_LEN - 5)


def default_pat(limit: int) -> bytes:
    return b"\xc7\x40\x0c" + limit.to_bytes(4, "little")   # mov dword [rax+0xc], limit


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--binary", default=DEFAULT)
    ap.add_argument("--limit", type=int, default=524288, help="目标 token 上限，默认 512K")
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--no-backup", action="store_true")
    a = ap.parse_args()

    p = a.binary
    if not os.path.isfile(p):
        sys.exit(f"[x] 找不到: {p}")

    data = bytearray(open(p, "rb").read())
    sha_before = hashlib.sha256(data).hexdigest()
    new_clamp = clamp_new(a.limit)
    old_default = default_pat(256000)

    has_old_clamp = CLAMP_ORIG in data
    has_new_clamp = new_clamp in data
    print(f"[i] {p}")
    print(f"[i] size={len(data):,}  sha256={sha_before[:16]}")
    print(f"[i] clamp  : {'OLD (256K)' if has_old_clamp else ('PATCHED' if has_new_clamp else 'UNKNOWN')}")
    has_old_default = old_default in data
    has_new_default = default_pat(a.limit) in data
    print(f"[i] default: {'OLD (256K)' if has_old_default else ('PATCHED' if has_new_default else 'UNKNOWN')}")

    if a.check:
        return 0

    if has_old_clamp:
        i = data.find(CLAMP_ORIG)
        data[i:i + CLAMP_LEN] = new_clamp
        print(f"[*] clamp   off=0x{i:x}  -> mov esi,{a.limit}")
    elif not has_new_clamp:
        sys.exit("[x] clamp 模式没找到：版本可能变了，先重新定位再说")

    if old_default in data:
        i = data.find(old_default)
        data[i:i + 7] = default_pat(a.limit)
        print(f"[*] default off=0x{i:x}  -> {a.limit}")
    elif default_pat(a.limit) not in data:
        print("[!] default 模式没找到（可能已被别的方式覆盖），跳过")

    sha_after = hashlib.sha256(data).hexdigest()
    if sha_after == sha_before:
        print("[=] 无需变更")
        return 0
    if not a.no_backup:
        bk = os.path.join(BACKUP_ROOT,
                          f"_ls_backup_{datetime.now():%Y%m%d_%H%M}_{sha_before[:8]}")
        os.makedirs(bk, exist_ok=True)
        shutil.copy2(p, os.path.join(bk, "language_server.orig.exe"))
        with open(os.path.join(bk, "sha256.txt"), "w", encoding="utf-8") as f:
            f.write(f"{sha_before}  language_server.orig.exe\n")
        print(f"[i] 备份 -> {bk}")

    open(p, "wb").write(data)
    print(f"[*] 写入完成  sha256 {sha_before[:12]} -> {sha_after[:12]}")
    print("[!] 需要完全退出并重开 Antigravity 才生效")
    return 0


if __name__ == "__main__":
    sys.exit(main())
