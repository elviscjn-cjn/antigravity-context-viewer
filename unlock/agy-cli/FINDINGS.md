# Findings — agy 1.4.12, macOS arm64

Everything below was derived from the shipped binary
(sha256 `34423fc9b0af…`, 197,589,952 bytes, `go1.28-20261025-RC00`, Mach-O arm64,
**not stripped** — Go symbols are in pclntab, the Mach-O symtab does not list them).

---

## 1. Locating Go functions in this binary

`go tool nm` cannot read this pclntab with an older toolchain. The layout that
worked:

```
pcHeader (at some file offset B), 72 bytes:
  0x00 magic      0xFFFFFFF1
  0x04 pad1,pad2  00 00
  0x06 minLC      4          (arm64)
  0x07 ptrSize    8
  0x08 nfunc      uint64
  0x10 nfiles     uint64
  0x18 textStart  uint64     <-- 0 in this build
  0x20 funcnameOffset uint64 <-- 72, so funcnametab starts right after the header
  0x28 cuOffset / 0x30 filetabOffset / 0x38 pctabOffset / 0x40 pclnOffset
```

For 1.4.12: `B = 68,344,992`, `nfunc = 173,378`, `pcln = B + 0x1EB3AB8`.

* **functab** lives at `pcln`, entries are **8 bytes**: `{entryoff u32, funcoff u32}`,
  `nfunc + 1` of them.
* **`_func` record** at `pcln + funcoff`. Its fields:
  `+0 entryoff u32`, `+4 nameOff int32`, `+8 args`, `+12 deferreturn`,
  `+16 pcsp`, `+20 pcfile`, `+24 pcln`, `+28 npcdata`, `+32 cuOffset`, `+36 startLine`.
* **name** = NUL-terminated string at `B + funcnameOffset + nameOff`.
* **address of the function** = `text_section_vmaddr + entryoff`.
  `entryoff` is relative to the `__text` **section**, not the `__TEXT` segment —
  getting this wrong shifts every address by `0x11c0` on this build and is the
  single easiest way to patch the wrong bytes.

Resolved for 1.4.12 (`__text` vmaddr `0x1000011c0`, file offset `0x11c0`):

| symbol | address | file offset |
|---|---|---|
| `model.SelectorModel.offersContextWindow` | `0x102c532f0` | `0x2c532f0` |
| `store.AutoCompactOverride` | `0x102a51b90` | `0x2a51b90` |
| `strings.TrimSpace` | `0x10012a7f0` | |
| `os.Getenv` | `0x100101af0` | |
| `runtime.memequal` | `0x10000c510` | |
| `strconv.FormatUint` | `0x100011560` | |

These addresses are informational only — `agy-patch.py` recomputes them by name.

---

## 2. The whitelist is one model

`offersContextWindow` loads a global `[]string` from `__DATA`
(`0x10ba06b90`, len 1) and compares the selected model against its elements:

```
whitelist ptr = 0x10ba06b90  len = 1
entry[0]      = "Gemini 4 Argon"
```

On a match it does a map lookup and returns `x1 != 0`; on no match it returns
`false` immediately. Function size 800 bytes, args frame 0x3db8 (the model value
is passed by value).

---

## 3. Correction to the popular write-up

The circulating analysis says `os.Getenv("AGY_CLI_AUTO_COMPACT_OVERRIDE")` was
"compiled out", and shows x86 disassembly ending in
`call strings.TrimSpace`. Both halves are consistent with what is here — but the
important detail is that the call target really **is `strings.TrimSpace`**, not
`os.Getenv`:

```
102a51bac: nop
102a51bb0: mov x0, xzr          ; empty string ptr
102a51bb4: mov x1, xzr          ; empty string len
102a51bb8: bl  strings.TrimSpace
```

`os.Getenv` was **inlined and constant-folded** to `""`; the call itself was
never removed. Consequence: rewriting only the two argument registers yields
`strings.TrimSpace("AGY_CLI_AUTO_COMPACT_OVERRIDE")`, which is then parsed as a
number and fails — the override stays dead. You must also retarget the `bl`.

---

## 4. Byte-level patches

### Patch 1 — force `true`

Entry point, first bytes:

```
arm64 : 20 00 80 52  c0 03 5f d6     mov w0,#1 ; ret
x86-64: b8 01 00 00 00  c3           mov eax,1 ; ret
```

Safe to overwrite the prologue: returning immediately never touches the stack,
and the callee-allocated argument frame is owned by the caller under the Go ABI.
The stack-growth resume path jumps back to the entry, so it lands on the new
`mov/ret` and simply returns `true`.

### Patch 2 — restore the env var (arm64 only)

Replace 16 bytes starting at the `nop` (`0x102a51bac`):

```
adrp x0, page(0x1036f0cab)   ; "AGY_CLI_AUTO_COMPACT_OVERRIDE" in rodata
add  x0, x0, #0xcab
mov  x1, #29
bl   os.Getenv               ; was: bl strings.TrimSpace
```

Result, verified by disassembly:

```
102a51bac: adrp x0, 0x1036f0000
102a51bb0: add  x0, x0, #0xcab
102a51bb4: mov  x1, #0x1d
102a51bb8: bl   0x100101af0   <os.Getenv>
```

`AGY_CLI_AUTO_COMPACT_OVERRIDE` then accepts either a percentage (`80%`) or an
integer token count. Trailing whitespace is no longer trimmed.

**x86-64 caveat:** the stub there is `nop; xor eax,eax; xor ebx,ebx` (8 bytes)
followed by a `call rel32`. Load-address + length (`movabs` + `mov ebx,imm32`)
needs ~15 bytes plus the call, which does not fit. On x86-64 you need a
trampoline / code cave, or leave patch 2 out — the `/model` selector alone
already covers the interactive use case.

---

## 5. Does long context actually work?

Measured against `gemini-3.8-flash-high` in print/stream mode, using
`usage.input_tokens + usage.cache_read_tokens` as the ground truth.

| test | tokens reaching the model | outcome |
|---|---|---|
| single 600 KB document | **594 K** (518 K cached + 75 K new) | returned normally |
| multi-turn, 301 KB doc, needle mid-document | turn 1 **475 K** → turn 2 **536 K** | needle recalled correctly |
| single 1.2 MB document | turn 1 only 47.8 K | content mostly dropped |

Conclusions:

* A single request carrying ~594 K tokens is accepted — **there is no client-side
  256 K clamp on request size.**
* In the multi-turn run the second turn's input *grew* (475 K → 536 K) instead of
  shrinking, i.e. **no compaction fired** even though `contextWindow` was set to
  `256K`. Setting the selector does not cap the request; it appears to govern
  auto-compaction timing, and in this test nothing compacted.
* There is a separate ceiling somewhere between 600 KB and 1.2 MB for a **single**
  message; beyond it the content is heavily reduced before it reaches the model.
* Behavioural warning, more relevant in practice than the token limit: with very
  large pasted blobs the agent sometimes ignores the instruction entirely (one
  1.2 MB run came back as a Gemini filter block; one 600 KB run answered with an
  unrelated plugin-configuration message).

Not measured: Claude Opus 5.5 / Gemini 4 Argon, the 900 K ceiling, and the exact
location of the single-message ceiling.

---

## 6. Packaging pitfalls (macOS)

* Any byte edit invalidates the code signature → the kernel SIGKILLs the process
  (`exit=137`, no output). `codesign --force --sign - --options runtime PATH`.
* Overwriting a signed binary **in place at the same path** can leave a stale
  per-path signature cache; re-sign at the destination path after copying.
* `agy update` replaces the binary; the `contextWindow` value in
  `~/.gemini/antigravity-cli/settings.json` survives, but an unpatched build
  hides the row again (it does not reset the stored value).
* Ad-hoc signing drops the original Team ID (`EQHXZ8M8AV`) — local use only.
