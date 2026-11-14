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
- **Appearance**. Toolbar controls adapt to the available space, and each panel opens independently. Switch between light and dark themes, choose a heatmap preset, or set each color level.
- **CLI and updates**. Launch the installed Antigravity CLI from the toolbar using the current workspace and proxy when available. Check for updates in the panel. The installer supports backups, integrity checks, and restoration.

## Interface language

The five README versions are documentation translations. The interface defaults to Simplified Chinese and has no in-app language selector. To use another language, follow [AGENTS.md](AGENTS.md) to translate the UI text in `src/renderer/`, rebuild, and install.

---

## 🤖 Instructions for AI Agents

Instruct your AI: **"Read `AGENTS.md` and install the Antigravity Context & Token Viewer"**.

```bash
# 1. Install & hot-inject without restarting
node cli.js install

# 2. Verify status
node cli.js status
```

---

## 🚀 Quick Start

### Method 1: Scripts
- **Windows**: Run [`install.bat`](install.bat) / [`uninstall.bat`](uninstall.bat)
- **macOS / Linux**: Run `./install.sh` / `./uninstall.sh`

### Method 2: CLI Manager
```bash
node cli.js check
node cli.js install
node cli.js live
node cli.js watch       # Zero-patch auto-attach watcher (stop with: node cli.js stop-watch)
node cli.js status
node cli.js restore
```

---

## 🧪 Testing

```bash
npm test
```
Tests cover context estimates, token aggregation, storage, proxy configuration, renderer state and subscription settings.

---

## 🤝 Community & Support

- **[LINUX DO](https://linux.do/)**: Endorsed by and supporting the LINUX DO community.
