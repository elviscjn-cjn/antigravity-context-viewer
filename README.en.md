# Antigravity Context & Token Viewer

<p align="center">
  <img src="https://img.shields.io/badge/Version-2.3.0-blue" alt="Version">
  <img src="https://img.shields.io/badge/Node.js-%3E%3D18.x-brightgreen?logo=node.js" alt="Node Version">
  <img src="https://img.shields.io/badge/Dependencies-Zero-success" alt="Zero Dependencies">
  <img src="https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey" alt="Platform Support">
  <img src="https://img.shields.io/badge/License-MIT-green" alt="License">
</p>

<p align="center">
  <a href="README.md">简体中文</a> | <b>English</b> | <a href="README.ja.md">日本語</a> | <a href="README.ko.md">한국어</a> | <a href="README.es.md">Español</a>
</p>

A native-feel, zero-dependency visualization suite for **Google Antigravity Desktop (2.x)** combining a **real-time session context window progress bar** with an **account-wide Token activity & 7×52 heatmap tracker**. Built on an **in-place ASAR persistent patch + CDP live hot-reload** architecture, it supports one-click script installation as well as one-sentence automated deployment by any AI Agent (Antigravity / Codex / Claude Code / Cursor).

---

## 🎬 Preview & Demos

### 1. Combined Full Interactive Demo

<p align="center">
  <a href="assets/demo.mp4">
    <img src="assets/demo.gif" alt="Antigravity Context & Token Viewer Full Demo" width="760">
  </a>
  <br>
  <sub>🎬 Demo Animation: Context Viewer + Token Heatmap multi-view switching (<a href="assets/demo.mp4">Full Demo Animation</a>)</sub>
</p>

### 2. Dual Topbar Capsules: Standalone Demos & State Breakdown

Two borderless capsules permanently sit in the upper-right title bar. By default, they blend invisibly into the dark title bar with `#1e1e1e`; on mouse hover, they smoothly transition to `#343434` with a `cubic-bezier(0.16, 1, 0.3, 1)` easing curve to expand detailed metrics:

| Module | Standalone Demo Animation | Normal State (`#1e1e1e`) | Hovered State (`#343434`) |
| :--- | :---: | :---: | :---: |
| **💬 Session Context** | <a href="assets/demo-context.mp4"><img src="assets/demo-context.gif" alt="Context Capsule Demo" width="320"></a><br><sub><a href="assets/demo-context.mp4">🎬 Context Demo</a></sub> | <img src="assets/context-badge-default.png" alt="Context normal" height="34"><br><sub>Progress bar + used percentage</sub> | <img src="assets/context-badge-hover.png" alt="Context hover" height="34"><br><sub>Expands budget & full estimate</sub> |
| **🔥 Account Token Tracker** | <a href="assets/demo-token.mp4"><img src="assets/demo-token.gif" alt="Token Capsule Demo" width="320"></a><br><sub><a href="assets/demo-token.mp4">🎬 Token Demo</a></sub> | <img src="assets/token-badge-default.png" alt="Token normal" height="34"><br><sub>Breathing pulse dot + grand total</sub> | <img src="assets/token-badge-hover.png" alt="Token hover" height="34"><br><sub>Expands today's consumption</sub> |

### 3. Dual-Tab Detail Panels Side-by-Side

Clicking either capsule pops up a native `#1e1e1e` dark panel with seamless switching between **💬 Session Context** and **🔥 Account Token Activity**:

| 💬 Tab 1: Session Context Viewer | 🔥 Tab 2: Account Token Activity & Heatmap |
| :---: | :---: |
| <img src="assets/panel-detail.png" alt="Session context detail panel" width="430"> | <img src="assets/panel-activity.png" alt="Account token activity panel" width="460"> |
| Pinned **"⭐ Quick Summary (All You Need)"** card shows **Used / Budget / Remaining** at a glance with health status. Full server-reported tokens, 1M overflow warning, and local file attachment breakdown below. | Top 4 metric cards: **Grand Total, Today, Current Month, Current Year**. Bottom: **7×52 week activity heatmap grid** with **Daily / Weekly / Cumulative** view switching and daily prompt/output/cache tooltips. |

---

## ✨ Core Features

### Module 1: 💬 Session Context Viewer
1. **Seamless Borderless Progress Bar**:
   - Blends with `#1e1e1e` when unhovered, displaying only a **visual progress bar + used context count & percentage** (e.g. `92.5K (36%)`).
   - Dynamic 3-level color alert: Healthy (`<75%` Indigo `#69c0ff`), Warning (`75%–90%` Amber `#faad14`), Critical/Overflow (`≥90%` Red `#ff4d4f`).
2. **"⭐ Quick Summary" Hero Card**:
   - Instantly shows Used / Budget / Remaining metrics and health badge (Normal / Warning / Critical / Exceeded) at the top of the panel.
3. **Accurate Server Limits & Local Attachment Scanner**:
   - Differentiates actual model input+output tokens from client budget and session-wide estimates. Triggers hard red warning upon hitting server `1,048,576` (1M) HTTP 400 errors.
   - Built-in read-only attachment analyzer for `.xlsx`, `.xlsm`, `.xls`, `.xlsb`, `.csv`, `.pdf`, `.docx`, `.pptx`, and code files.

### Module 2: 🔥 Account Token Activity & Heatmap
1. **Four-Dimensional Token Dashboard**:
   - Real-time aggregation of **Grand Total, Today, This Month, and This Year** tokens with smart shorthand and exact numbers.
2. **ChatGPT / GitHub Style 7×52 Week Activity Heatmap**:
   - 5-tier dark-to-purple gradient representing 365 days of token consumption. Hover or click any cell to view daily prompt, output, and cache breakdown.
3. **Three-View Switching**:
   - Switch effortlessly between **Daily (Heatmap)**, **Weekly (Bar Trend)**, and **Cumulative (Area Curve)** views.

---

## 🌐 UI Localization & Multi-Language Support

The default UI language is **Simplified Chinese**. If you prefer the plugin interface (capsules, panels, tooltips) in your native language (e.g., **English, Japanese, Korean, Spanish**, etc.):

> [!TIP]
> **No manual configuration or external i18n packages required!**  
> When providing this repo to your AI Agent (Antigravity / Claude Code / Codex / Cursor), simply tell it:  
> **"Read AGENTS.md, install this plugin, and translate the UI text into [Your Target Language, e.g., English / Japanese / Korean / Spanish]"**  
> 
> The AI will automatically translate user-facing strings in `meter-renderer.js` and hot-deploy the plugin with zero downtime.

---

## 🤖 One-Command Installation for AI Agents

Tell your AI assistant: **"Read `AGENTS.md` and install this Context & Token Viewer"**.

The agent runs:

```bash
# 1. In-place ASAR patch + live CDP hot-reload into running Antigravity window
node cli.js install

# 2. Verify status
node cli.js status
```

---

## 🚀 Quick Start for Humans

- **Windows**: Double-click [`install.bat`](install.bat) (Uninstall: [`uninstall.bat`](uninstall.bat))
- **macOS / Linux**: Run `./install.sh` (Uninstall: `./uninstall.sh`)

---

## 📁 Repository Structure

```text
antigravity-context-viewer/
├── assets/                       # Demo animations, videos, and screenshots
├── asar-engine.js                # Zero-dependency native Node.js ASAR engine
├── cli.js                        # Unified CLI (install / live / status / check / restore)
├── install.js                    # ASAR injector & live hot-reload coordinator
├── restore.js                    # Verified clean uninstaller & backup restorer
├── meter-main.js                 # Electron main process hooks & IPC bridge
├── meter-core.js                 # Context estimation, token analytics, and tokenizer
├── meter-renderer.js             # Dual topbar capsules, tabbed panels & heatmap renderer
├── meter-collector.js            # Local conversation archive scanner & collector
├── attachment_scan.py            # Multi-format document token analyzer
├── AGENTS.md                     # AI Agent execution & localization guide
├── install.bat / install.sh      # One-click install scripts
└── uninstall.bat / .sh           # One-click restore scripts
```
