#!/usr/bin/env python3
"""Unlock the agy CLI /model Context selector (and restore the auto-compact env var).

Verified: macOS arm64, agy 1.4.12 (both patches); Windows x86-64, agy 1.5.5 /
1.5.6 (patch 1 only, see README-Windows.md).
Best-effort: Linux locating code is implemented but has NOT been run -- see
README.md before trusting it on that target.

Patch 1 -- model.SelectorModel.offersContextWindow
    Release builds hardcode a whitelist of exactly one model ("Gemini 4 Argon").
    Every other model gets `false`, which hides the Context chip in /model and
    makes the Tab key a no-op. Patching the entry point to `return true`
    exposes 256K / 512K / 900K for all models.

        arm64 : mov w0,#1 ; ret        -> 20 00 80 52 c0 03 5f d6
        x86-64: mov eax,1 ; ret        -> b8 01 00 00 00 c3

Patch 2 -- store.AutoCompactOverride   (arm64 only, optional)
    The compiler inlined os.Getenv("AGY_CLI_AUTO_COMPACT_OVERRIDE") and constant
    folded it to "", so the surviving code is literally `strings.TrimSpace("")`.
    The patch writes the real env-var name into the argument registers and
    retargets that call from strings.TrimSpace to os.Getenv. Trailing
    whitespace is no longer trimmed; harmless for "80%" / "120000".

Usage:
    agy-patch.py --binary PATH [--no-env-fix] [--dry-run] [--in-place]
    agy-patch.py --binary PATH --locate      # print symbols, change nothing

Without --in-place the result is written to PATH.patched and re-signed.
"""

import argparse
import hashlib
import os
import re
import struct
import subprocess
import sys

PCLNTAB_MAGIC = 0xFFFFFFF1
ENV_NAME = b"AGY_CLI_AUTO_COMPACT_OVERRIDE"

FUNC_OFFERS = "model.SelectorModel.offersContextWindow"
FUNC_OVERRIDE = "store.AutoCompactOverride"

RET_TRUE_ARM64 = struct.pack("<II", 0x52800020, 0xD65F03C0)      # mov w0,#1 ; ret
RET_TRUE_X64 = bytes.fromhex("b801000000c3")                     # mov eax,1 ; ret
# nop ; mov x0,xzr ; mov x1,xzr   (arm64: the folded Getenv argument setup)
GETENV_STUB_ARM64 = struct.pack("<III", 0xD503201F, 0xAA1F03E0, 0xAA1F03E1)


class PatchError(Exception):
    pass


# --------------------------------------------------------------------------
# binary format: locate the code section that ftab entry offsets are relative to
# --------------------------------------------------------------------------

def find_text_section(data):
    """Return (text_vmaddr, text_fileoff, arch).

    arch is one of "arm64", "x86-64". Go ftab entry offsets are relative to the
    start of the machine-code section, not the containing segment.
    """
    if data[:4] == b"\xcf\xfa\xed\xfe":
        return _macho_text(data)
    if data[:4] == b"\x7fELF":
        return _elf_text(data)
    if data[:2] == b"MZ":
        return _pe_text(data)
    raise PatchError("unrecognised container (want Mach-O, ELF or PE)")


def _macho_text(data):
    ncmds = struct.unpack_from("<I", data, 16)[0]
    cputype = struct.unpack_from("<I", data, 4)[0]
    arch = "arm64" if cputype == 0x0100000C else "x86-64"
    off = 32
    for _ in range(ncmds):
        cmd, size = struct.unpack_from("<II", data, off)
        if cmd == 0x19:  # LC_SEGMENT_64
            nsects = struct.unpack_from("<I", data, off + 64)[0]
            sect = off + 72
            for _ in range(nsects):
                if data[sect:sect + 16].rstrip(b"\0") == b"__text":
                    addr, _sz, offset = struct.unpack_from("<QQI", data, sect + 32)
                    return addr, offset, arch
                sect += 80
        off += size
    raise PatchError("__text section not found")


def _elf_text(data):
    is64 = data[4] == 2
    little = data[5] == 1
    if not is64 or not little:
        raise PatchError("only 64-bit little-endian ELF is handled")
    machine = struct.unpack_from("<H", data, 18)[0]
    arch = {0xB7: "arm64", 0x3E: "x86-64"}.get(machine)
    if arch is None:
        raise PatchError(f"unsupported ELF machine {machine:#x}")
    shoff = struct.unpack_from("<Q", data, 40)[0]
    shentsize, shnum, shstrndx = struct.unpack_from("<HHH", data, 58)
    strtab_off = struct.unpack_from("<Q", data, shoff + shstrndx * shentsize + 24)[0]
    for i in range(shnum):
        sh = shoff + i * shentsize
        nameoff = struct.unpack_from("<I", data, sh)[0]
        end = data.find(b"\0", strtab_off + nameoff)
        name = data[strtab_off + nameoff:end]
        if name == b".text":
            addr, offset = struct.unpack_from("<QQ", data, sh + 16)
            return addr, offset, arch
    raise PatchError(".text section not found")


def _pe_text(data):
    pe = struct.unpack_from("<I", data, 0x3C)[0]
    if data[pe:pe + 4] != b"PE\0\0":
        raise PatchError("bad PE signature")
    machine = struct.unpack_from("<H", data, pe + 4)[0]
    arch = {0xAA64: "arm64", 0x8664: "x86-64"}.get(machine)
    if arch is None:
        raise PatchError(f"unsupported PE machine {machine:#x}")
    nsec = struct.unpack_from("<H", data, pe + 6)[0]
    opt_size = struct.unpack_from("<H", data, pe + 20)[0]
    opt = pe + 24
    image_base = struct.unpack_from("<Q", data, opt + 24)[0]
    sect = opt + opt_size
    for _ in range(nsec):
        name = data[sect:sect + 8].rstrip(b"\0")
        if name == b".text":
            vsize, vaddr, rawsize, rawptr = struct.unpack_from("<IIII", data, sect + 8)
            return image_base + vaddr, rawptr, arch
        sect += 40
    raise PatchError(".text section not found")


# --------------------------------------------------------------------------
# Go symbol table
# --------------------------------------------------------------------------

def find_pclntab(data):
    magic = struct.pack("<I", PCLNTAB_MAGIC)
    pos = 0
    while True:
        i = data.find(magic + b"\x00\x00", pos)
        if i < 0:
            raise PatchError("Go pclntab not found")
        pos = i + 1
        if data[i + 6] not in (1, 2, 4) or data[i + 7] != 8:   # minLC (x86-64=1), ptrSize
            continue
        nfunc = struct.unpack_from("<Q", data, i + 8)[0]
        if not 1000 < nfunc < 5_000_000:
            continue
        fn_off = struct.unpack_from("<Q", data, i + 32)[0]
        head = data[i + fn_off:i + fn_off + 16]
        if not head or not all(0x20 <= c < 0x7F for c in head):
            continue
        return i, nfunc
    raise PatchError("no valid pclntab")


def build_functions(data):
    """Map trailing funcname -> (entryoff, funcoff)."""
    base, nfunc = find_pclntab(data)
    fnstart = base + struct.unpack_from("<Q", data, base + 32)[0]
    pcln = base + struct.unpack_from("<Q", data, base + 64)[0]

    funcs = {}
    for i in range(nfunc + 1):
        off = pcln + i * 8
        if off + 8 > len(data):
            break
        entryoff, funcoff = struct.unpack_from("<II", data, off)
        rec = pcln + funcoff
        if rec + 8 > len(data):
            continue
        nameoff = struct.unpack_from("<i", data, rec + 4)[0]
        start = fnstart + nameoff
        end = data.find(b"\x00", start, start + 200)
        if end < 0:
            continue
        try:
            name = data[start:end].decode("ascii")
        except UnicodeDecodeError:
            continue
        funcs.setdefault(name.rsplit("/", 1)[-1], (entryoff, funcoff))
    if not funcs:
        raise PatchError("functab produced no symbols")
    return funcs


# --------------------------------------------------------------------------
# patch 1
# --------------------------------------------------------------------------

def patch_offers(data, funcs, text_va, text_off, arch):
    if FUNC_OFFERS not in funcs:
        raise PatchError(f"symbol not found: {FUNC_OFFERS}")
    entryoff, _ = funcs[FUNC_OFFERS]
    blob = RET_TRUE_ARM64 if arch == "arm64" else RET_TRUE_X64
    off = text_off + entryoff
    if bytes(data[off:off + len(blob)]) == blob:
        return False, f"{FUNC_OFFERS}: already patched"
    data[off:off + len(blob)] = blob
    return True, (f"{FUNC_OFFERS}: entry {text_va + entryoff:#x} -> "
                  f"return true ({blob.hex(' ')})")


# --------------------------------------------------------------------------
# patch 2 (arm64 only)
# --------------------------------------------------------------------------

def encode_adrp(rd, pc, target):
    delta = ((target & ~0xFFF) - (pc & ~0xFFF)) >> 12
    if not -(1 << 20) <= delta < (1 << 20):
        raise PatchError("adrp target out of range")
    imm21 = delta & 0x1FFFFF
    return 0x90000000 | ((imm21 & 3) << 29) | ((imm21 >> 2) << 5) | rd


def encode_add_imm(rd, rn, imm12):
    if not 0 <= imm12 <= 0xFFF:
        raise PatchError("add immediate out of range")
    return 0x91000000 | (imm12 << 10) | (rn << 5) | rd


def encode_movz64(rd, imm16):
    return 0xD2800000 | (imm16 << 5) | rd


def encode_bl(pc, target):
    delta = target - pc
    if delta & 3 or not -(1 << 27) <= delta < (1 << 27):
        raise PatchError("bl target out of range")
    return 0x94000000 | ((delta >> 2) & 0x3FFFFFF)


def patch_env(data, funcs, text_va, text_off, arch):
    if arch != "arm64":
        raise PatchError("env-var patch is arm64-only in this tool; see FINDINGS.md")
    for needed in (FUNC_OVERRIDE, "strings.TrimSpace", "os.Getenv"):
        if needed not in funcs:
            raise PatchError(f"symbol not found: {needed}")

    entryoff, _ = funcs[FUNC_OVERRIDE]
    start = text_off + entryoff
    body = bytes(data[start:start + 512])

    name_off = data.find(ENV_NAME)
    if name_off < 0:
        raise PatchError("env var name missing from rodata")
    target = text_va - text_off + name_off
    site_va = text_va + entryoff

    hits = [m.start() for m in re.finditer(re.escape(GETENV_STUB_ARM64), body)]
    if len(hits) != 1:
        if body.find(struct.pack("<I", encode_adrp(0, site_va, target))) >= 0:
            return False, f"{FUNC_OVERRIDE}: already patched"
        raise PatchError(f"{FUNC_OVERRIDE}: expected 1 folded Getenv stub, "
                         f"found {len(hits)}")

    site = start + hits[0]
    bl_site = site + 12
    old_bl = struct.unpack_from("<I", data, bl_site)[0]
    if old_bl & 0xFC000000 != 0x94000000:
        raise PatchError("expected bl after the stub")
    bl_pc = site_va + hits[0] + 12
    trim_va = text_va + funcs["strings.TrimSpace"][0]
    cur = bl_pc + (((old_bl & 0x3FFFFFF) ^ 0x2000000) - 0x2000000) * 4
    if cur != trim_va:
        raise PatchError("that bl does not target strings.TrimSpace")

    words = (encode_adrp(0, site_va + hits[0], target),
             encode_add_imm(0, 0, target & 0xFFF),
             encode_movz64(1, len(ENV_NAME)),
             encode_bl(bl_pc, text_va + funcs["os.Getenv"][0]))
    data[site:site + 16] = b"".join(struct.pack("<I", w) for w in words)
    return True, (f"{FUNC_OVERRIDE}: reads {ENV_NAME.decode()} "
                  f"(strings.TrimSpace -> os.Getenv @ {bl_pc:#x})")


# --------------------------------------------------------------------------

def resign(path):
    if sys.platform != "darwin":
        print("[i] non-macOS target: no ad-hoc signing step applied")
        return
    subprocess.run(["codesign", "--force", "--sign", "-", "--options", "runtime", path],
                   check=True, capture_output=True)
    subprocess.run(["codesign", "--verify", "--verbose=1", path],
                   check=True, capture_output=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--binary", default=os.path.expanduser("~/.local/bin/agy"))
    ap.add_argument("--no-env-fix", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--in-place", action="store_true")
    ap.add_argument("--locate", action="store_true", help="print symbols only")
    args = ap.parse_args()

    src = os.path.abspath(args.binary)
    if not os.path.exists(src):
        sys.exit(f"no such file: {src}")

    with open(src, "rb") as fh:
        data = bytearray(fh.read())
    before = hashlib.sha256(data).hexdigest()

    text_va, text_off, arch = find_text_section(data)
    funcs = build_functions(bytes(data))
    print(f"[i] {src}\n[i] arch={arch} text_va={text_va:#x} text_off={text_off:#x} "
          f"symbols={len(funcs)}")

    for key in (FUNC_OFFERS, FUNC_OVERRIDE, "strings.TrimSpace", "os.Getenv"):
        if key in funcs:
            print(f"[i] {key} -> {text_va + funcs[key][0]:#x}")
        else:
            print(f"[i] {key} -> MISSING")

    if args.locate:
        return

    ok, msg = patch_offers(data, funcs, text_va, text_off, arch)
    print(("[*] " if ok else "[=] ") + msg)

    if not args.no_env_fix:
        try:
            ok, msg = patch_env(data, funcs, text_va, text_off, arch)
            print(("[*] " if ok else "[=] ") + msg)
        except PatchError as exc:
            print(f"[!] skipped env-var patch: {exc}")

    after = hashlib.sha256(bytes(data)).hexdigest()
    if before == after:
        print("[=] nothing to change")
        return
    if args.dry_run:
        print(f"[*] dry run: {before[:12]} -> {after[:12]}")
        return

    dst = src if args.in_place else src + ".patched"
    with open(dst, "wb") as fh:
        fh.write(data)
    os.chmod(dst, 0o755)
    resign(dst)
    print(f"[*] wrote {dst}\n    sha256 {before[:12]} -> {after[:12]}")


if __name__ == "__main__":
    try:
        main()
    except PatchError as exc:
        sys.exit(f"error: {exc}")
