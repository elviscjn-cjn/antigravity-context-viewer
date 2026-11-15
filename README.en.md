# Antigravity Context & Token Viewer

[简体中文](README.md) · **English** · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md)

See how much context your conversation uses, how fast the model responds, and how many tokens you have used across the desktop app and CLI, right from the Google Antigravity 2.x toolbar.

## Demo

https://github.com/user-attachments/assets/46e3a6f9-5127-4470-a2ef-01525736ec5b

[Download HD MP4](https://raw.githubusercontent.com/elviscjn-cjn/antigravity-context-viewer/main/assets/demo.mp4)

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
- **Client UI language & licensing**: The client localization module supports **Simplified Chinese** (`i18n/zh-CN.json`) and stock **English**. A Traditional Chinese client dictionary from `qqxpee/antigravity2-cn` is omitted because no open-source license is declared upstream; selecting `繁體中文` translates the plugin panel only.

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
node cli.js status
node cli.js restore
node cli.js enhance-status
node cli.js enhance --tier 3 --chinese-title on --brand-title english
node cli.js enhance-restore
```

---

## 🧪 Testing

```bash
npm test
```
Tests cover context estimates, token aggregation, storage, proxy configuration, renderer state and subscription settings.

---

## 🛡️ Security & Windows CLI Helper Transparency

- **Purpose**: On Windows, the optional `scripts/cli-window-helper.exe` (source in [scripts/cli-window-helper.cs](scripts/cli-window-helper.cs)) is used solely when launching an `agy` CLI session from the UI popup to locate, center, and foreground the newly spawned console window. It makes no network calls and performs no persistence.
- **Toolchain & Local Build Command**: Compiled from source using built-in Windows `.NET Framework 4.0`:
  ```powershell
  C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /nologo /target:exe /platform:anycpu /optimize+ /out:scripts\cli-window-helper.exe scripts\cli-window-helper.cs
  ```
- **Current Prebuilt Binary SHA-256**: `e6a62cbb03163107db889e6accf7c05049ecf949c89f29afaf072c66fe09eac9` (Note: `csc.exe` embeds PE timestamps/MVIDs unless deterministic flags are set, so rebuilding locally or in `.github/workflows/release.yml` on `windows-latest` yields a functionally identical binary with a different hash; CI source compilation improves build provenance, though it does **not** guarantee zero heuristic detections by all AV engines.)
- **AV Heuristic Phenomenon**: Because it is an unsigned ~15 KB .NET executable invoking `keybd_event`, `AttachThreadInput`, `AllowSetForegroundWindow`, `CreateToolhelp32Snapshot`, and `Process.Start("cmd.exe")`, some antivirus scanners may flag it heuristically.
- **Safe Fallback Without Disabling AV**: You do **not** need to disable antivirus software or buy a code-signing certificate. Simply delete `scripts/cli-window-helper.exe` (or allow AV quarantine). `meter-cli-launcher.js` automatically falls back to spawning a standard console (`cmd.exe /d /k`) directly—CLI launching continues working normally, only without automatic centering or forced foreground activation.

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
