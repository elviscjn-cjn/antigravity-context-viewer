# agy Context Selector Unlock

Unlocks the built-in `/model` → **Context** selector (256K / 512K / 900K) for
**all** models, instead of only the single hardcoded model.

Verified on **macOS arm64, agy 1.4.12**
(original binary sha256 `34423fc9b0af3841e7646aa72a2d40ffeab8218b22d1cb99eac7355f9eba31e3`).

## Fast path (macOS arm64)

```bash
python3 agy-patch.py --binary ~/.local/bin/agy --in-place
agy --version          # must still print the version
python3 verify_tui.py --binary ~/.local/bin/agy --model gemini-3.8-flash-high
```

`agy-patch.py` locates both functions **by Go symbol name at runtime** — there
are no hardcoded file offsets, so it survives version bumps as long as the
symbol names are unchanged.

## Acceptance test

Use a model **outside** the whitelist (anything except Gemini 4 Argon).
Open `/model`, press `Tab`, watch the Context chip:

| step | expected |
|---|---|
| open `/model` | `[Default]` (or your persisted value) |
| `Tab` ×1 | `[256K]` |
| `Tab` ×2 | `[512K]` |
| `Tab` ×3 | `[900K]` |
| `Tab` ×4 | wraps to `[Default]` |
| `Enter`, reopen `/model` | selection persisted |

`verify_tui.py` automates exactly this. Exit code 0 = pass, 2 = Context row
absent (not patched), 3 = row present but Tab does nothing.

The persisted value lives in `~/.gemini/antigravity-cli/settings.json`
(`"contextWindow": "512K"`) — a user config file, separate from the binary.

## What the two patches do

1. **`model.SelectorModel.offersContextWindow` → `return true`**
   Release builds compare the selected model against a hardcoded whitelist
   slice containing exactly one entry, `"Gemini 4 Argon"`. Every other model
   gets `false`, which hides the Context chip and makes the Tab handler a
   no-op. Making the function return `true` exposes the selector for all models.

2. **`store.AutoCompactOverride` → restore the env var** *(arm64, optional)*
   The release build inlined `os.Getenv("AGY_CLI_AUTO_COMPACT_OVERRIDE")` and
   constant-folded it to `""`, leaving only `strings.TrimSpace("")`. The patch
   writes the real env-var name into the argument registers and retargets that
   `bl` from `strings.TrimSpace` to `os.Getenv`, so
   `AGY_CLI_AUTO_COMPACT_OVERRIDE=512000 agy -p "..."` works again.

Details, addresses, byte encodings and measurements: see `FINDINGS.md`.

## Other platforms

`agy-patch.py` parses Mach-O, ELF and PE to locate the code section, and knows
`arm64` and `x86-64`. **Only the macOS arm64 path has actually been run.**

| platform | status | notes |
|---|---|---|
| macOS arm64 | ✅ verified end-to-end | requires re-signing, see below |
| Linux arm64 | ⚠️ locating code only, untested | no signing needed; `chmod +x` only |
| Linux x86-64 | ⚠️ locating code only, untested | patch 1 encoding `b8 01 00 00 00 c3` |
| Windows x86-64 | ✅ patch 1 verified (agy 1.5.5 / 1.5.6) | see [README-Windows.md](README-Windows.md); patch 2 needs a trampoline on x86-64; Authenticode signature invalidated |

On anything other than macOS arm64, treat `--locate` output as a starting
point: confirm both symbol addresses are sane, then verify with `verify_tui.py`
before trusting the result. The env-var patch (2) is **arm64-only**; on x86-64
the argument setup needs more bytes than the stub provides and requires a
trampoline/code cave — see `FINDINGS.md`.

## Three pitfalls

1. **macOS kills unsigned modifications.** After editing bytes, the binary must
   be re-signed ad-hoc (`codesign --force --sign - --options runtime PATH`),
   otherwise it exits with signal 9 (`exit=137`). The script does this.
   Re-signing *in place at the final path* matters: a binary copied over an
   existing signed file at the same path can still hit a stale per-path
   signature cache and get SIGKILLed.
2. **`agy update` overwrites the binary.** Re-run `agy-patch.py --in-place`
   after every update. The persisted `contextWindow` value survives an update
   (it lives in settings.json) but stops being applied until you re-patch.
3. **Ad-hoc signing drops the original Team ID.** Fine locally; do not
   redistribute a patched binary.

## Restore

Keep a copy of the original binary before patching:

```bash
cp ~/.local/bin/agy ~/.local/bin/agy.orig && \
python3 agy-patch.py --binary ~/.local/bin/agy --in-place
```

To roll back, move `agy.orig` back over `agy`. The original keeps its valid
Developer ID signature, so no re-signing is needed on restore.
