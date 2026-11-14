#!/usr/bin/env python3
r"""Antigravity 桌面端上下文上限三档切换器：256K / 512K / 983K。

改的是后端子进程 resources/bin/language_server（Windows 为 language_server.exe），
不是 asar，不是 agy CLI。任意档位之间可直接互切，等长替换不动偏移；
切档前自动备份，幂等可重跑。

依据：utils.GetCheckpointConfig 里两处 256000 立即数（Gate 3A）
  1. 硬 clamp（Windows 实测 va 0x1418c0da2）：
     81 fa 00 e8 03 00 / be 00 e8 03 00 / 0f 42 f2  →  min(x, 256000)
     三种目标态（14 字节等长替换）：
       ORIG  原样保留 min(x, 256000)
       CONST be <imm32> + 90×9          → 恒为 imm（512K 档，imm 默认 524288，--limit 可改）
       DYN   89 d6 + 90×12              → mov esi,edx 透传（983K 档 = 上游 Gate 3A 语义，
                                          跟模型物理窗口走，Gemini 4 Argon = 983040）
  2. 默认值：c7 40 0c <imm32> → 模型未指定上限时的兜底
       256K / 983K 档保持 256000 原值；512K 档写 <imm>

Gate 3B：config.applyFeatureProviderCheckpointOverrideConfig
  该函数经 call config.selectCheckpointExperimentKey → test al,al → jne 调度实验覆盖；
  CASCADE_USE_EXPERIMENT_CHECKPOINTER 实验命中时会把压缩阈值改回实验值（256K），
  等于把 Gate 3A 补丁整个架空。移植上游 meter-context-unlock.js 的 x64 处理：
  经 .gopclntab 符号表定位两函数，把 call 之后 test al,al 后面的 jne NOP 掉
  （75 xx → 90×2 / 0f 85 xx xx xx xx → 90×6），使实验覆盖永不执行。
  档位联动：512K / 983K 档打掉 Gate 3B；256K 档还原（原始 jcc 字节存 sidecar）。

用法：
  python patch-language_server.py --check             # 只看当前档位，不改文件
  python patch-language_server.py                     # 切到 512K（默认档）
  python patch-language_server.py --mode 983k         # 切到 983K（动态透传）
  python patch-language_server.py --mode 512k --limit 786432
  python patch-language_server.py --mode 256k         # 完全还原官方 256K

状态文件（仅打默认路径时写；AG_LS_STATE_DIR 环境变量供测试重定向）：
  <状态目录>/AntigravityContextMeter/context-mode.json  档位（meter 注入层可读，同步分母）
  <状态目录>/AntigravityContextMeter/gate3b.json        Gate 3B 原始 jcc 字节（256K 还原用）

⚠️ 每次切档后必须完全退出并重开 Antigravity 才生效（language_server 是随会话拉起的子进程）。
⚠️ 服务端是否接受 >256K 请求未验证：若分母变了但长会话仍中途被截断，瓶颈在服务端。
"""

import argparse
import hashlib
import json
import os
import re
import shutil
import sys
from datetime import datetime, timezone

# 默认目标：按平台给出候选，取第一个存在的（都不存在时用首个候选，交给 --binary 覆盖）
def _default_binary():
    home = os.path.expanduser("~")
    if os.name == "nt":
        local = os.environ.get("LOCALAPPDATA") or os.path.join(home, "AppData", "Local")
        cands = [os.path.join(local, "Programs", "antigravity", "resources", "bin", "language_server.exe")]
    elif sys.platform == "darwin":
        cands = [
            "/Applications/Antigravity.app/Contents/Resources/bin/language_server",
            os.path.join(home, "Applications", "Antigravity.app", "Contents", "Resources", "bin", "language_server"),
        ]
    else:
        cands = [
            "/opt/antigravity/resources/bin/language_server",
            "/usr/lib/antigravity/resources/bin/language_server",
            os.path.join(home, ".local", "share", "antigravity", "resources", "bin", "language_server"),
        ]
    for c in cands:
        if os.path.isfile(c):
            return c
    return cands[0]

DEFAULT = _default_binary()

# 状态目录：对齐 meter asar-engine.getStateDir() 的平台约定；
# AG_LS_STATE_DIR 供测试隔离重定向（对齐上游 AG_UNLOCK_DIR 模式）
def _state_dir():
    override = os.environ.get("AG_LS_STATE_DIR")
    if override:
        return override
    home = os.path.expanduser("~")
    if os.name == "nt":
        base = os.environ.get("LOCALAPPDATA") or os.path.join(home, "AppData", "Local")
    elif sys.platform == "darwin":
        base = os.path.join(home, "Library", "Application Support")
    else:
        base = os.environ.get("XDG_STATE_HOME") or os.path.join(home, ".local", "state")
    return os.path.join(base, "AntigravityContextMeter")

STATE_DIR = _state_dir()
# 备份默认存放在本地状态目录外，不污染项目源码仓库（可用 AG_LS_BACKUP_DIR 覆盖）
BACKUP_ROOT = os.environ.get("AG_LS_BACKUP_DIR") or os.path.join(STATE_DIR, "backups", "language-server")
MODE_FILE = os.path.join(STATE_DIR, "context-mode.json")
GATE3B_FILE = os.path.join(STATE_DIR, "gate3b.json")

# 983K 档的 meter 显示分母（Gemini 4 Argon 物理窗口，对齐上游 Gate 3A 语义）
FLOOR_983K = 983040
FLOOR_512K_DEFAULT = 524288
IMM_MIN, IMM_MAX = 100000, 16 * 1024 * 1024   # 合理 checkpoint 上限范围（对齐上游引擎）

# ── Gate 3A 字节模式 ─────────────────────────────────────────────────────────
CLAMP_ORIG = bytes.fromhex("81fa00e80300be00e803000f42f2")    # min(x, 256000)
CLAMP_LEN = len(CLAMP_ORIG)                                   # 14
CLAMP_DYN = b"\x89\xd6" + b"\x90" * 12                        # mov esi,edx + nop×12（透传）
DEF_ORIG = b"\xc7\x40\x0c" + (256000).to_bytes(4, "little")   # mov dword [rax+0xc], 256000
DEF_LEN = len(DEF_ORIG)                                       # 7

RE_CLAMP_ORIG = re.compile(re.escape(CLAMP_ORIG))
RE_CLAMP_DYN = re.compile(re.escape(CLAMP_DYN))
# CONST 形状：be <imm32> + 90×9。裸扫可能多命中（be+imm32+nop 填充不是罕见组合），
# 命中不唯一时靠 default 站点锚点窗口收窄。
RE_CLAMP_CONST = re.compile(rb"\xbe(.{4})\x90{9}", re.DOTALL)
RE_DEF_ORIG = re.compile(re.escape(DEF_ORIG))

# ── Gate 3B 符号（对齐上游 meter-context-unlock.js） ─────────────────────────
PCLN_MAGIC = b"\xf1\xff\xff\xff\x00\x00"
FUNC_EXP_CHECKPOINT = "config.applyFeatureProviderCheckpointOverrideConfig"
FUNC_SELECT_EXP_KEY = "config.selectCheckpointExperimentKey"


def clamp_const(imm: int) -> bytes:
    return b"\xbe" + int(imm).to_bytes(4, "little") + b"\x90" * (CLAMP_LEN - 5)


def def_const(imm: int) -> bytes:
    return b"\xc7\x40\x0c" + int(imm).to_bytes(4, "little")   # mov dword [rax+0xc], imm


def find_all(pattern: "re.Pattern", data: bytearray) -> list:
    return [m.start() for m in pattern.finditer(data)]


def detect_clamp(data: bytearray) -> list:
    """clamp 站点候选 [(state, imm, off)]；state ∈ {ORIG, CONST, DYN}"""
    hits = [("ORIG", None, off) for off in find_all(RE_CLAMP_ORIG, data)]
    hits += [("DYN", None, off) for off in find_all(RE_CLAMP_DYN, data)]
    for m in RE_CLAMP_CONST.finditer(data):
        imm = int.from_bytes(m.group(1), "little")
        if IMM_MIN <= imm <= IMM_MAX:
            hits.append(("CONST", imm, m.start()))
    return hits


def detect_default(data: bytearray, candidate_imms) -> list:
    """default 站点候选。c7 40 0c <imm32> 全库太常见无法裸扫，只按精确已知 imm 匹配
    （ORIG 的 256000 + clamp CONST 回读的 imm + 512K 默认值）"""
    hits = [("ORIG", 256000, off) for off in find_all(RE_DEF_ORIG, data)]
    for imm in sorted({i for i in candidate_imms if i != 256000}):
        for off in find_all(re.compile(re.escape(def_const(imm))), data):
            hits.append(("CONST", imm, off))
    return hits


def narrow(hits: list, anchor_off, window: int = 8192):
    """多候选时优先用 jcc+7 / cmp 前置结构锚点消歧（避免 1,000,000 原生常量碰撞），再用 ±window 收窄到唯一"""
    near = [h for h in hits if abs(h[2] - anchor_off) <= window]
    return near[0] if len(near) == 1 else None


def narrow_default_by_guard(hits: list, data: bytearray, anchor_off, window: int = 8192):
    """default 站点多候选时优先用 cmp [rdx+0x14], 0; jg +7 (83 7a 14 00 7f 07) 唯一锁定"""
    exact = [
        h for h in hits
        if h[2] >= 6 and bytes(data[h[2] - 6:h[2]]) == b"\x83\x7a\x14\x00\x7f\x07"
    ]
    if len(exact) == 1:
        return exact[0]
    guarded = [
        h for h in hits
        if h[2] >= 2 and 0x70 <= data[h[2] - 2] <= 0x7F and data[h[2] - 1] == 0x07
    ]
    if len(guarded) == 1:
        return guarded[0]
    return narrow(hits, anchor_off, window) if anchor_off is not None else None


def fmt_state(state: str, imm) -> str:
    if state == "ORIG":
        return "ORIG(256K)" if imm in (256000, None) else f"ORIG({imm})"
    if state == "CONST":
        return f"CONST({imm:,})"
    return "DYN(透传)"


def infer_mode(clamp_hit, default_hit) -> str:
    if clamp_hit is None:
        return "未知"
    state = clamp_hit[0]
    if state == "CONST":
        return "512k" if clamp_hit[1] == FLOOR_512K_DEFAULT else f"512k(自定义 {clamp_hit[1]:,})"
    if state == "DYN":
        return "983k"
    return "256k" if (default_hit and default_hit[0] == "ORIG") else "256k(default 未定位)"


# ── Gate 3B：PE/.text 定位 + gopclntab 符号解析 + jcc NOP（移植上游实现） ────
def find_text_section_pe(data: bytearray):
    """返回 (textVA, textOff)，非 PE / 缺 .text 返回 None（移植上游 findTextSection PE 分支）"""
    if bytes(data[:2]) != b"MZ":
        return None
    pe_off = int.from_bytes(data[0x3C:0x40], "little")
    if bytes(data[pe_off:pe_off + 4]) != b"PE\x00\x00":
        return None
    machine = int.from_bytes(data[pe_off + 4:pe_off + 6], "little")
    if machine != 0x8664:                       # 本工具当前仅实现 x86-64 PE 的 Gate 3B
        return None
    nsec = int.from_bytes(data[pe_off + 6:pe_off + 8], "little")
    opt_size = int.from_bytes(data[pe_off + 20:pe_off + 22], "little")
    opt = pe_off + 24
    image_base = int.from_bytes(data[opt + 24:opt + 32], "little")
    sect = opt + opt_size
    for _ in range(nsec):
        name = bytes(data[sect:sect + 8]).rstrip(b"\x00")
        if name == b".text":
            vaddr = int.from_bytes(data[sect + 12:sect + 16], "little")
            rawptr = int.from_bytes(data[sect + 20:sect + 24], "little")
            return image_base + vaddr, rawptr
        sect += 40
    return None


def find_pclntab(data: bytearray):
    """返回 (base, nfunc)，未找到返回 None（移植上游 findPclntab，含 minLC/ptrSize 校验）"""
    pos = 0
    limit = len(data) - 64
    while pos < limit:
        idx = data.find(PCLN_MAGIC, pos)
        if idx < 0 or idx >= limit:
            return None
        pos = idx + 1
        min_lc, ptr_size = data[idx + 6], data[idx + 7]
        if min_lc not in (1, 2, 4) or ptr_size != 8:
            continue
        nfunc = int.from_bytes(data[idx + 8:idx + 16], "little")
        if not (1000 < nfunc < 5_000_000):
            continue
        fn_off = int.from_bytes(data[idx + 32:idx + 40], "little")
        if idx + fn_off + 16 > len(data):
            continue
        head = data[idx + fn_off:idx + fn_off + 16]
        if all((0x20 <= b < 0x7F) or b == 0 for b in head):
            return idx, nfunc
    return None


def find_symbols(data: bytearray, targets: set):
    """gopclntab 走查，返回 {短名: (entryoff, size, fullName)}；找不到表返回 None"""
    found = find_pclntab(data)
    if found is None:
        return None
    base, nfunc = found
    fnstart = base + int.from_bytes(data[base + 32:base + 40], "little")
    pcln = base + int.from_bytes(data[base + 64:base + 72], "little")
    funcs = {}
    for i in range(nfunc):
        off = pcln + i * 8
        if off + 16 > len(data):
            break
        entryoff = int.from_bytes(data[off:off + 4], "little")
        funcoff = int.from_bytes(data[off + 4:off + 8], "little")
        next_entry = int.from_bytes(data[off + 8:off + 12], "little")
        rec = pcln + funcoff
        if rec + 8 > len(data):
            continue
        nameoff = int.from_bytes(data[rec + 4:rec + 8], "little", signed=True)
        s = fnstart + nameoff
        e = data.find(b"\x00", s)
        if e < 0 or e - s > 500:
            continue
        full = bytes(data[s:e]).decode("ascii", "replace")
        short = full.rsplit("/", 1)[-1]
        if short in targets and short not in funcs:
            funcs[short] = (entryoff, max(0, next_entry - entryoff), full)
    return funcs


def check_gate3b(data: bytearray, text_va: int, text_off: int, funcs: dict) -> dict:
    """在 applyFeatureProviderCheckpointOverrideConfig 体内找
    call selectCheckpointExperimentKey → test al,al → jcc（移植上游 checkGate3B x64 分支）"""
    exp = funcs.get(FUNC_EXP_CHECKPOINT)
    sel = funcs.get(FUNC_SELECT_EXP_KEY)
    if not exp or not sel:
        return {"status": "unknown", "reason": "缺符号（applyFeatureProvider/selectCheckpointExperimentKey）"}
    fn_off = text_off + exp[0]
    fn_size = exp[1] or 0x200
    fn_va = text_va + exp[0]
    sel_va = text_va + sel[0]
    body = data[fn_off:fn_off + fn_size]
    n = len(body)
    for rel in range(0, max(0, n - 12)):
        if body[rel] != 0xE8:
            continue
        disp = int.from_bytes(body[rel + 1:rel + 5], "little", signed=True)
        if fn_va + rel + 5 + disp != sel_va:
            continue
        win = body[rel + 5:min(n, rel + 5 + 100)]
        t = win.find(b"\x84\xc0")                       # test %al, %al
        if t < 0:
            continue
        j = rel + 5 + t + 2                             # jcc 在 body 内的偏移
        b1, b2 = body[j], body[j + 1]
        if b1 == 0x75:                                  # jne rel8
            return {"status": "unpatched", "off": fn_off + j, "len": 2,
                    "orig": bytes(body[j:j + 2])}
        if b1 == 0x0F and b2 == 0x85:                   # jne rel32
            return {"status": "unpatched", "off": fn_off + j, "len": 6,
                    "orig": bytes(body[j:j + 6])}
        if b1 == 0x90 and b2 == 0x90:                   # 已 NOP（还原时长度取自 sidecar）
            run = 2 if body[j + 2] != 0x90 else 6
            return {"status": "patched", "off": fn_off + j, "len": run}
        return {"status": "unknown", "reason": "jcc 形状不识别"}
    return {"status": "unknown", "reason": "体内未找到 call→selectCheckpointExperimentKey 形状"}


def fmt_gate3b(g: dict) -> str:
    if g["status"] == "unpatched":
        return f"UNPATCHED(jne {'rel8' if g['len'] == 2 else 'rel32'}，实验覆盖可踩回 256K)"
    if g["status"] == "patched":
        return f"PATCHED(nop×{g['len']}，实验覆盖已阻断)"
    return f"未定位（{g.get('reason', '?')}）"


def load_gate3b_orig() -> bytes:
    """读 sidecar 里的原始 jcc 字节；无/坏返回空"""
    try:
        with open(GATE3B_FILE, "r", encoding="utf-8") as f:
            cfg = json.load(f)
        return bytes.fromhex(cfg.get("orig", ""))
    except (OSError, ValueError):
        return b""


def save_gate3b_orig(orig: bytes, sha8: str):
    os.makedirs(STATE_DIR, exist_ok=True)
    payload = {"orig": orig.hex(), "len": len(orig), "sha8": sha8,
               "updatedAt": datetime.now(timezone.utc).isoformat()}
    with open(GATE3B_FILE, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    print(f"[i] Gate3B 原始字节 -> {GATE3B_FILE}")


def drop_gate3b_file():
    try:
        os.remove(GATE3B_FILE)
    except OSError:
        pass


def state_writable(p: str) -> bool:
    """只有打默认路径、或显式 AG_LS_STATE_DIR 测试隔离时才写状态文件"""
    if os.environ.get("AG_LS_STATE_DIR"):
        return True
    return os.path.abspath(p) == os.path.abspath(DEFAULT)


def assert_writable(p: str):
    try:
        with open(p, "r+b"):
            pass
    except PermissionError:
        sys.exit("[x] language_server 被占用（客户端在运行）。请完全退出 Antigravity 后重试。")
    except OSError as e:
        sys.exit(f"[x] 文件无法写入: {e}")


def write_mode_file(mode: str, floor: int):
    """切档成功后写 meter 模式文件；区分动态透传与固定数值；失败仅警告"""
    try:
        os.makedirs(STATE_DIR, exist_ok=True)
        effective_mode = "dynamic" if mode == "983k" else ("fixed" if mode == "512k" else "default")
        payload = {
            "mode": mode,
            "effectiveMode": effective_mode,
            "limitTokens": floor if mode == "512k" else None,
            "floor": floor,
            "updatedAt": datetime.now(timezone.utc).isoformat()
        }
        if mode == "512k":
            payload["limit"] = floor
        with open(MODE_FILE, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
        print(f"[i] 模式文件 -> {MODE_FILE}")
    except OSError as e:
        print(f"[!] 模式文件写入失败（meter 分母可能不同步，可手动重跑 --check 后处理）: {e}")


def main() -> int:
    ap = argparse.ArgumentParser(description="language_server 上下文上限三档切换器")
    ap.add_argument("--binary", default=DEFAULT)
    ap.add_argument("--mode", choices=["256k", "512k", "983k"], default="512k")
    ap.add_argument("--limit", type=int, default=None,
                    help=f"512k 档目标上限（{IMM_MIN:,}~{IMM_MAX:,}），默认 {FLOOR_512K_DEFAULT:,}")
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--no-backup", action="store_true")
    a = ap.parse_args()

    if a.limit is not None and not (IMM_MIN <= a.limit <= IMM_MAX):
        sys.exit(f"[x] --limit 超出合理范围（{IMM_MIN:,}~{IMM_MAX:,}）")
    if a.mode != "512k" and a.limit is not None:
        print("[!] --limit 只对 512k 档生效，本次忽略")

    limit = a.limit if (a.mode == "512k" and a.limit is not None) else FLOOR_512K_DEFAULT

    p = a.binary
    if not os.path.isfile(p):
        sys.exit(f"[x] 找不到: {p}（可先跑 --check 看探测到的默认路径，或用 --binary 显式指定）")

    data = bytearray(open(p, "rb").read())
    sha_before = hashlib.sha256(data).hexdigest()
    print(f"[i] {p}")
    print(f"[i] size={len(data):,}  sha256={sha_before[:16]}")

    # ① Gate 3A 站点识别
    clamp_hits = detect_clamp(data)
    clamp_imms = [h[1] for h in clamp_hits if h[0] == "CONST"]
    default_hits = detect_default(data, clamp_imms + [FLOOR_512K_DEFAULT])

    clamp_hit = clamp_hits[0] if len(clamp_hits) == 1 else None
    default_hit = default_hits[0] if len(default_hits) == 1 else None

    # 多候选：default 站点（7 字节精确模式 + cmp/jg+7 前置锚点）做锚点收窄 clamp；反之亦然
    if len(default_hits) > 1:
        default_hit = narrow_default_by_guard(default_hits, data, clamp_hit[2] if clamp_hit else None)
    if len(clamp_hits) > 1 and default_hit:
        clamp_hit = narrow(clamp_hits, default_hit[2])
    if len(default_hits) > 1 and not default_hit and clamp_hit:
        default_hit = narrow_default_by_guard(default_hits, data, clamp_hit[2])

    if clamp_hit:
        print(f"[*] clamp   off=0x{clamp_hit[2]:x}  {fmt_state(clamp_hit[0], clamp_hit[1])}")
    elif len(clamp_hits) > 1:
        print(f"[!] clamp   多处候选（{len(clamp_hits)} 个），锚点无法收窄")
    else:
        print("[!] clamp   未找到任何已知模式")
    if default_hit:
        print(f"[*] default off=0x{default_hit[2]:x}  {fmt_state(default_hit[0], default_hit[1])}")
    elif len(default_hits) > 1:
        print(f"[!] default 多处候选（{len(default_hits)} 个），锚点无法收窄")
    else:
        print("[!] default 未定位（可能已被别的方式覆盖或 imm 不在已知集合）")

    print(f"[i] 当前档位: {infer_mode(clamp_hit, default_hit)}")

    # ② Gate 3B 识别（符号定位；缺符号只降级警告，不阻塞 3A 切档）
    ts = find_text_section_pe(data)
    funcs = find_symbols(data, {FUNC_EXP_CHECKPOINT, FUNC_SELECT_EXP_KEY}) if ts else None
    if ts is None:
        g3b = {"status": "unknown", "reason": "非 PE x86-64 或缺 .text 节区（macOS/Linux 上 3A 仍可用，3B 暂缺）"}
    elif funcs is None:
        g3b = {"status": "unknown", "reason": "未检测到 gopclntab 符号表"}
    elif FUNC_EXP_CHECKPOINT not in funcs or FUNC_SELECT_EXP_KEY not in funcs:
        g3b = {"status": "unknown", "reason": "符号表缺 Gate 3B 目标函数"}
    else:
        g3b = check_gate3b(data, ts[0], ts[1], funcs)
    if g3b["status"] in ("patched", "unpatched"):
        print(f"[*] gate3b  off=0x{g3b['off']:x}  {fmt_gate3b(g3b)}")
    else:
        print(f"[!] gate3b  {fmt_gate3b(g3b)}")

    if a.check:
        return 0

    # ③ Gate 3A 目标态字节
    if a.mode == "256k":
        clamp_target, default_target, floor = CLAMP_ORIG, DEF_ORIG, 0
    elif a.mode == "983k":
        clamp_target, default_target, floor = CLAMP_DYN, DEF_ORIG, FLOOR_983K
    else:
        clamp_target = clamp_const(limit)
        default_target = def_const(limit)
        floor = limit

    # ④ 幂等判断（3A 两站点 + Gate 3B）
    clamp_done = clamp_hit is not None and (
        (a.mode != "512k" and clamp_hit[0] == ("DYN" if a.mode == "983k" else "ORIG"))
        or (a.mode == "512k" and clamp_hit[0] == "CONST" and clamp_hit[1] == limit))
    default_done = default_hit is not None and (
        (a.mode != "512k" and default_hit[0] == "ORIG")
        or (a.mode == "512k" and default_hit[0] == "CONST" and default_hit[1] == limit))
    want_3b = a.mode in ("512k", "983k")            # 256K 档要求 3B 还原官方
    if want_3b:
        gate3b_done = g3b["status"] == "patched" or g3b["status"] == "unknown"
    else:
        gate3b_done = g3b["status"] == "unpatched" or g3b["status"] == "unknown"

    if clamp_done and (default_done or default_hit is None) and gate3b_done:
        print("[=] 已是目标档位，无需变更")
        return 0

    if clamp_hit is None:
        sys.exit("[x] clamp 站点定位失败：版本可能变了，先重新定位再说；"
                 "或从备份还原原版（ORIG 模式唯一可定位）后重试")

    # ⑤ 改内存（3A 站点 + Gate 3B，全部等长替换）
    changed = False
    if not clamp_done:
        data[clamp_hit[2]:clamp_hit[2] + CLAMP_LEN] = clamp_target
        print(f"[*] clamp   off=0x{clamp_hit[2]:x}  -> {a.mode} 档目标字节")
        changed = True
    if default_hit is not None and not default_done:
        data[default_hit[2]:default_hit[2] + DEF_LEN] = default_target
        print(f"[*] default off=0x{default_hit[2]:x}  -> {a.mode} 档目标字节")
        changed = True
    elif default_hit is None:
        print("[!] default 站点未定位，跳过（仅 clamp 生效）")

    gate3b_orig_bytes = b""
    gate3b_write = False   # False=不动 / True=写 NOP 或还原 jcc
    if want_3b and g3b["status"] == "unpatched":
        gate3b_orig_bytes = g3b["orig"]
        data[g3b["off"]:g3b["off"] + g3b["len"]] = b"\x90" * g3b["len"]
        print(f"[*] gate3b  off=0x{g3b['off']:x}  -> jne NOP×{g3b['len']}（实验覆盖阻断）")
        changed = True
        gate3b_write = True
    elif not want_3b and g3b["status"] == "patched":
        gate3b_orig_bytes = load_gate3b_orig()
        if not gate3b_orig_bytes:
            print("[!] gate3b 已 NOP 但缺 sidecar 原始字节，无法自动还原；"
                  "如需完全还原官方请用 _ls_backup_* 备份覆盖")
        elif gate3b_orig_bytes[0] not in (0x75,) and gate3b_orig_bytes[:2] != b"\x0f\x85":
            print(f"[!] gate3b sidecar 原始字节形状不合法（{gate3b_orig_bytes.hex()}），跳过还原")
        else:
            data[g3b["off"]:g3b["off"] + len(gate3b_orig_bytes)] = gate3b_orig_bytes
            print(f"[*] gate3b  off=0x{g3b['off']:x}  -> 还原 jne {gate3b_orig_bytes.hex()}")
            changed = True
            gate3b_write = True

    if not changed:
        print("[=] 无需变更")
        return 0

    # ⑥ 写盘纪律：占用检测 → 备份 → 写入 → 状态文件
    assert_writable(p)
    sha_after = hashlib.sha256(data).hexdigest()
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

    if state_writable(p):
        if gate3b_write:
            if want_3b and gate3b_orig_bytes:
                save_gate3b_orig(gate3b_orig_bytes, sha_before[:8])
            elif not want_3b:
                drop_gate3b_file()
        write_mode_file(a.mode, floor)
    print("[!] 需要完全退出并重开 Antigravity 才生效")
    return 0


if __name__ == "__main__":
    sys.exit(main())
