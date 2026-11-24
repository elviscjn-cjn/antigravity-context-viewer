# Antigravity Context & Token Viewer

[简体中文](README.md) · **English** · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md)

See how much context your conversation uses, how fast the model responds, and how many tokens you have used across the desktop app and CLI, right from the Google Antigravity 2.x toolbar.

## Features

- **Context and speed**. See context usage, the model budget, time to first token (TTFT), output rate, and total generation time. Server-reported usage and local estimates are shown separately.
- **Conversation details**. Expand usage for prompts, replies, thinking, tools, and attachments. Review attachment estimates and coverage, and image dimensions when available. The panel distinguishes context overflow, rate limits, network errors, and other common failures.
- **Token history**. Combine readable local desktop and CLI usage or filter by source. Explore daily, weekly, monthly, yearly, and cumulative views.
- **API cost estimates and subscriptions**. Estimate input, cache, and output costs for supported rates and see which usage could not be priced. Compare API-equivalent cost with regional reference prices or your actual subscription payment, with currency selection and CNY conversion. Estimates are for comparison. Refer to your provider for actual charges.
- **Model settings & context adjustment**. Save per-product context preferences (Native default restoring original client behavior, fixed 512,000 [512K] / 900,000 / 983,040 / 1,000,000 [1M], or dynamic follow), clearly distinguishing per-model saved preferences from the single shared client backend limit, with verified backup, restore, and host restart triggers. Integrates PR #3 multi-mode unlocking and cross-platform `unlock/` tools. Note: the model selector is inspection-only (**live chat model switching is not implemented**).
- **Speed comparison**. Compare observed output rates, TTFT, and total durations per exact model ID and effort level using median bars and historical trend lines (up to 200 samples per identity, low-sample badge when < 3).
- **Enhancement hub (PR #4)**. Configure 0–4 system prompt tiers (including anti-hallucination and tool-grounding constraints with explicit keep/clear/replace breakdown), Chinese auto session titles, client language (`zh-CN` / `en`), brand title display (`Antigravity` / hidden / translated), proxy setup, and opt-in recommended presets with full one-click restore. Normal installation never enables these changes silently.
- **Appearance**. Toolbar controls adapt to the available space, and each panel opens independently. Switch between light and dark themes, choose a heatmap preset, or set each color level.
- **CLI and updates**. Launch the installed Antigravity CLI from the toolbar using the current workspace and proxy when available. Check for updates in the panel. The installer supports backups, integrity checks, and restoration.

## Interface language

- **Viewer panel (3 languages)**: Switch the plugin panel live between **简体中文**, **繁體中文**, and **English** across all tabs, charts, billing views, and enhancement settings.
- **Client UI language & licensing**: The client localization module supports **Simplified Chinese** (`i18n/zh-CN.json`) and stock **English**. The Antigravity UI localization is based on [Antigravity-Chinese-Localization](https://github.com/antigravity-cn-community/Antigravity-Chinese-Localization) (Release `v2.34.0`), thanks to **aabbWei** and **antigravity-cn-community contributors**. Full MIT license terms and copyright notices are bundled in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md). A Traditional Chinese client dictionary from `qqxpee/antigravity2-cn` is omitted because no open-source license is declared upstream; selecting `繁體中文` translates the plugin panel only.

---

## 🤖 Instructions for AI Agents

Instruct your AI: **"Read `AGENTS.md` and install the Antigravity Context & Token Viewer"**.

```bash
# 1. Patch app.asar and modules on disk
node cli.js install

# 2. Fully quit Antigravity (including the tray icon) and reopen it so main-process & preload changes load

# 3. Verify status after restart
node cli.js status
```

> [!NOTE]
> `node cli.js live` only injects renderer UI changes for layout/copy checks. Upgrading main-process (`meter-main.js`), preload bridges, or new backend modules (`meter-enhance.js`) requires `node cli.js install` followed by a full client restart.

---

## 🚀 Quick Start

### Method 1: Scripts
- **Windows**: Run [`install.bat`](install.bat) / [`uninstall.bat`](uninstall.bat)
- **macOS / Linux**: Run `./install.sh` / `./uninstall.sh`

### Method 2: CLI Manager
```bash
node cli.js check
node cli.js install
node cli.js live              # Patch-free CDP injection (auto-launches with CDP port; pass --relaunch outside host if already running without CDP on v2.33.0+)
node cli.js watch             # Patch-free background watcher (recommended on macOS to preserve Apple code signatures)
node cli.js stop-watch
node cli.js update --check-only
node cli.js update            # Stage a verified plugin release for watch or live to load
node cli.js status
node cli.js restore
node cli.js enhance-status
node cli.js enhance --tier 3 --chinese-title on --brand-title english
node cli.js enhance-restore
```

If your plugin copy does not recognize `update`, download a plugin package with the command from [GitHub Releases](https://github.com/elviscjn-cjn/antigravity-context-viewer/releases), extract it to a new folder, and run `node cli.js watch` there. If the macOS application signature is already damaged, reinstall the official client and check scheduled tasks before using `watch`.

> [!IMPORTANT]
> **Antigravity v2.34.0 & macOS `ElectronAsarIntegrity` Support Scope**:
> - **Window-loader anchor (`loadHubWindowUrl`)**: Verified across clean install, upgrade (`v2.33.0 -> v2.34.0`), and lossless restore tests.
> - **macOS `ElectronAsarIntegrity` and code signing**: `node cli.js check` reports signing and ASAR integrity status. `install` and `recover` block patching when `ElectronAsarIntegrity` is enabled or the application bundle has a publisher signature. Use patch-free **`node cli.js watch`** on these bundles. Modifying `app.asar` can invalidate the signature and prevent the app or its scheduled-task `language_server` from launching.
> - **Unverified on real Mac hardware**: No physical macOS host was available during this release cycle; real macOS cold-boot signature behavior and desktop UI interactions await community hardware feedback.

---

## 🧪 Testing

```bash
npm test
```
Tests cover context estimates, token aggregation, storage, proxy configuration, renderer state and subscription settings.

---

## 🛡️ Security & Windows CLI Helper Transparency

- **Purpose**: On Windows, the optional `scripts/cli-window-helper.exe` (source in [scripts/cli-window-helper.cs](scripts/cli-window-helper.cs)) is used solely when launching an `agy` CLI session from the UI popup to locate, center, and foreground the newly spawned console window. It makes no network calls and performs no persistence.
- **Verifiable Build Provenance (No Prebuilt Binary in Git)**: Prebuilt `scripts/cli-window-helper.exe` is no longer tracked in Git. Release binaries are compiled directly from `scripts/cli-window-helper.cs` with SHA-256 verification via:
  1. GitHub Actions (`.github/workflows/release.yml`), compiling on `windows-latest` with `.NET Framework 4.0` and verifying `.sha256` before packaging Windows ZIP bundles;
  2. Local packaging (`node scripts/package-release.js`) or local source installation (`node cli.js install`), compiling `scripts/cli-window-helper.cs` into an OS temp directory via local `csc.exe` without touching the working tree or reusing stale `.exe` files.
- **Toolchain & Manual Build Command**: Compiled from source using built-in Windows `.NET Framework 4.0`:
  ```powershell
  C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /nologo /target:exe /platform:anycpu /optimize+ /out:scripts\cli-window-helper.exe scripts\cli-window-helper.cs
  ```
- **AV Heuristic Phenomenon**: Because it is an unsigned ~15 KB .NET executable invoking `keybd_event`, `AttachThreadInput`, `AllowSetForegroundWindow`, `CreateToolhelp32Snapshot`, and `Process.Start("cmd.exe")`, some antivirus scanners may flag it heuristically. (CI source compilation makes provenance transparent, though it does **not** guarantee zero heuristic detections by all AV engines.)
- **Safe Fallback Without Disabling AV**: You do **not** need to disable antivirus software or buy a code-signing certificate. Simply delete `cli-window-helper.exe` (in `scripts/cli-window-helper.exe` or `%LOCALAPPDATA%\AntigravityContextMeter\cli-window-helper.exe`). `meter-cli-launcher.js` automatically falls back to spawning a standard console (`cmd.exe /d /k`) directly—CLI launching continues working normally, only without automatic centering or forced foreground activation.

---

## 🤝 Community & Acknowledgements

- **[LINUX DO](https://linux.do/)**: Endorsed by and supporting the LINUX DO community.
- **Original Context Unlock Research**: **Linux.do @23375** (<https://linux.do/t/topic/3117832>).
- **PR #3 (Multi-mode Context Unlock & `unlock/` Toolchain)**: Contributed by **[@anyu0804](https://github.com/anyu0804)**.
- **PR #4 (System Enhancement Hub, Prompt Tiers 0–4 & Anti-Hallucination)**: Contributed by **[@Jia131313](https://github.com/Jia131313)**.
- **PR #7 & #12 (Model Quota Rings, Dual Windows & Opt-in/Theme Safeguards)**: Contributed by **[@Azreal2021](https://github.com/Azreal2021)** and **[@Andrew-liu](https://github.com/Andrew-liu)**.
- **PR #9 (2.31+ Pricing, Quota Pool Matching & 3-Source Ledger Sync)**: Contributed by **[@MoiraToki](https://github.com/MoiraToki)**.
- **PR #11 (Sandboxed Preload i18n Gate Enforcement)**: Contributed by **[@yinshengphy](https://github.com/yinshengphy)**.
- **PR #13 (Popup Anchor Alignment & Anti-Jitter Positioning)**: Contributed by **[@nocoo](https://github.com/nocoo)**.
- **PR #14 (macOS Compatibility Review Reference)**: Contributed by **[@nokiy](https://github.com/nokiy)**.
- **Issue #17 (`cli-window-helper` Security Transparency, Hashes & CI Build Workflow)**: Reported & investigated by **[@riandycandra](https://github.com/riandycandra)**.
- **PR #21 (Traditional Chinese UI Refinement)**: Contributed by **[@U1tr0n-Lee](https://github.com/U1tr0n-Lee)**.
- **Issue #22 (Official Web/Atom Fallback Under GitHub API Rate Limits)**: Proposed by **[@zhao33079-zhao](https://github.com/zhao33079-zhao)**.
- **v0.9.0 Merged Code Contributors**: **[@Tswatery](https://github.com/Tswatery)** ([PR #38](https://github.com/elviscjn-cjn/antigravity-context-viewer/pull/38) · [PR #53](https://github.com/elviscjn-cjn/antigravity-context-viewer/pull/53) · [PR #32](https://github.com/elviscjn-cjn/antigravity-context-viewer/pull/32)), **[@Kisaragi-Mio-0127](https://github.com/Kisaragi-Mio-0127)** ([PR #47](https://github.com/elviscjn-cjn/antigravity-context-viewer/pull/47) · [Issue #46](https://github.com/elviscjn-cjn/antigravity-context-viewer/issues/46)), **[@feizaodemon](https://github.com/feizaodemon)** ([PR #52](https://github.com/elviscjn-cjn/antigravity-context-viewer/pull/52) · [PR #72](https://github.com/elviscjn-cjn/antigravity-context-viewer/pull/72)), and **[@yuanyang749](https://github.com/yuanyang749)** ([PR #57](https://github.com/elviscjn-cjn/antigravity-context-viewer/pull/57)).
- **v0.9.0 Adopted Proposals & Compatibility Contributors**: **[@JYPYYy](https://github.com/JYPYYy)** ([PR #35](https://github.com/elviscjn-cjn/antigravity-context-viewer/pull/35) · [PR #36](https://github.com/elviscjn-cjn/antigravity-context-viewer/pull/36) · [PR #37](https://github.com/elviscjn-cjn/antigravity-context-viewer/pull/37)), **[@Nymph-Beta](https://github.com/Nymph-Beta)** ([Issue #42](https://github.com/elviscjn-cjn/antigravity-context-viewer/issues/42) · [PR #43](https://github.com/elviscjn-cjn/antigravity-context-viewer/pull/43) · [PR #48](https://github.com/elviscjn-cjn/antigravity-context-viewer/pull/48) · [PR #71](https://github.com/elviscjn-cjn/antigravity-context-viewer/pull/71)), **[@Staaaying](https://github.com/Staaaying)** ([PR #70](https://github.com/elviscjn-cjn/antigravity-context-viewer/pull/70) · [PR #74](https://github.com/elviscjn-cjn/antigravity-context-viewer/pull/74) · [PR #79](https://github.com/elviscjn-cjn/antigravity-context-viewer/pull/79)), **[@MoiraToki](https://github.com/MoiraToki)** ([PR #34](https://github.com/elviscjn-cjn/antigravity-context-viewer/pull/34)), **[@paojiaoleshenghuo](https://github.com/paojiaoleshenghuo)** ([PR #27](https://github.com/elviscjn-cjn/antigravity-context-viewer/pull/27)), **[@Fengsuid](https://github.com/Fengsuid)** ([PR #55](https://github.com/elviscjn-cjn/antigravity-context-viewer/pull/55)), **[@1-pluto1](https://github.com/1-pluto1)** ([PR #60](https://github.com/elviscjn-cjn/antigravity-context-viewer/pull/60)), **[@lllhhhh](https://github.com/lllhhhh)** ([PR #63](https://github.com/elviscjn-cjn/antigravity-context-viewer/pull/63)), **[@unie774](https://github.com/unie774)** ([PR #64](https://github.com/elviscjn-cjn/antigravity-context-viewer/pull/64)), **[@XiangZheng2283](https://github.com/XiangZheng2283)** ([Issue #75](https://github.com/elviscjn-cjn/antigravity-context-viewer/issues/75) · [PR #76](https://github.com/elviscjn-cjn/antigravity-context-viewer/pull/76)), **[@BetterThanAny](https://github.com/BetterThanAny)** ([Issue #77](https://github.com/elviscjn-cjn/antigravity-context-viewer/issues/77)), **[@jinyue806](https://github.com/jinyue806)** ([Issue #78](https://github.com/elviscjn-cjn/antigravity-context-viewer/issues/78)), **[@Jeffgithub0029](https://github.com/Jeffgithub0029)** ([Issue #80](https://github.com/elviscjn-cjn/antigravity-context-viewer/issues/80)), **[@x1051445024](https://github.com/x1051445024)** ([PR #61](https://github.com/elviscjn-cjn/antigravity-context-viewer/pull/61) · [Issue #50](https://github.com/elviscjn-cjn/antigravity-context-viewer/issues/50)), **[@Hirasawa8](https://github.com/Hirasawa8)** ([PR #66](https://github.com/elviscjn-cjn/antigravity-context-viewer/pull/66)), **[@shixin08052](https://github.com/shixin08052)** ([PR #67](https://github.com/elviscjn-cjn/antigravity-context-viewer/pull/67)), **[@Xuhang0607](https://github.com/Xuhang0607)** ([PR #68](https://github.com/elviscjn-cjn/antigravity-context-viewer/pull/68)), **[@Jemiking](https://github.com/Jemiking)** ([PR #69](https://github.com/elviscjn-cjn/antigravity-context-viewer/pull/69)), and **[@awu5425](https://github.com/awu5425)** ([PR #73](https://github.com/elviscjn-cjn/antigravity-context-viewer/pull/73)).
- **Client UI Localization Upstream**: Antigravity UI localization is based on [Antigravity-Chinese-Localization](https://github.com/antigravity-cn-community/Antigravity-Chinese-Localization) (Release `v2.34.0`), thanks to **aabbWei** and **antigravity-cn-community contributors** (MIT License; see [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)).
