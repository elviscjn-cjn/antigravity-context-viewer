# Antigravity Context & Token Viewer

<p align="center">
  <img src="https://img.shields.io/badge/Version-2.7.0-blue" alt="Version">
  <img src="https://img.shields.io/badge/Node.js-%3E%3D18.x-brightgreen?logo=node.js" alt="Node Version">
  <img src="https://img.shields.io/badge/Dependencies-Zero-success" alt="Zero Dependencies">
  <img src="https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey" alt="Platform Support">
  <img src="https://img.shields.io/badge/License-MIT-green" alt="License">
  <a href="https://linux.do/"><img src="https://img.shields.io/badge/LINUX%20DO-Community-2563EB?logo=linux&logoColor=white" alt="LINUX DO"></a>
</p>

<p align="center">
  <a href="README.md">简体中文</a> | <b>English</b> | <a href="README.ja.md">日本語</a> | <a href="README.ko.md">한국어</a> | <a href="README.es.md">Español</a>
</p>

A native-feel, zero-dependency visualization suite for **Google Antigravity Desktop (2.x)** combining **session context window & generation monitoring**, an **account-wide Token activity & 52-week heatmap tracker**, and **real-time model output speed & latency benchmarks**. Built on an **in-place ASAR persistent patch + CDP live hot-reload** architecture, it supports one-click script installation as well as one-sentence automated deployment by any AI Agent (Antigravity / Codex / Claude Code / Cursor).

> [!NOTE]
> **Regarding Dark & Light Theme Adaptation**:  
> Because the author is a lazy dog, there are no screenshots or demo pictures for light mode, but light mode is equally fully adapted and supported (seamlessly blending into the title bar and UI whether in dark or light theme).

---

## 🎬 Video & Animation Previews

This v2.7 release provides 4 video demos covering all interaction layers:

### 1. Session Context Monitoring & Low-Level Parameter Attachment Audit
> Demo File: `01-session-context-and-audit.mp4`

Click the upper-right circular ring capsule to pop up the Session Context panel, checking the core summary card, live generation speed, and scrolling through low-level parameters, server calibration, image pixel formatting (e.g. `561×179 px`), and file attachment audits:

<p align="center">
  <a href="assets/demo-01-context-audit.mp4">
    <img src="assets/demo-01-context-audit.gif" alt="Session Context Monitoring & Low-Level Parameter Attachment Audit" width="760">
  </a>
  <br>
  <sub>🎬 Demo Animation: Session Context Panel, Speed Monitor & Detailed Audit (<a href="assets/demo-01-context-audit.mp4">HD Video: 01-session-context-and-audit.mp4</a>)</sub>
</p>

---

### 2. Token Usage Overview & 52-Week Activity Heatmap Interaction
> Demo File: `02-token-usage-and-heatmap.mp4`

Click the total token capsule to open the Token Usage Overview panel, displaying 4 core metric cards (Total, Today, Month, Year), a 52-week calendar heatmap, and hover tooltips showing daily Prompt/Output/Cache token breakdowns or future scheduled states:

<p align="center">
  <a href="assets/demo-02-token-heatmap.mp4">
    <img src="assets/demo-02-token-heatmap.gif" alt="Token Usage Overview & 52-Week Activity Heatmap Interaction" width="760">
  </a>
  <br>
  <sub>🎬 Demo Animation: Token 4D Metrics Cards & 52-Week Heatmap Hover Tooltips (<a href="assets/demo-02-token-heatmap.mp4">HD Video: 02-token-usage-and-heatmap.mp4</a>)</sub>
</p>

---

### 3. Dual Independent Panels Smooth Switching & Anti-Clipping Adaptive Docking
> Demo File: `03-dual-panel-switch-and-docking.mp4`

When the IDE right auxiliary pane (Review / Files / Terminal) is opened, the panels dynamically calculate the right viewport boundary and dock adaptively without being clipped. Clicking between capsules enables seamless switching between the two independent panels:

<p align="center">
  <a href="assets/demo-03-panel-switching.mp4">
    <img src="assets/demo-03-panel-switching.gif" alt="Dual Independent Panels Smooth Switching & Anti-Clipping Adaptive Docking" width="760">
  </a>
  <br>
  <sub>🎬 Demo Animation: Anti-Clipping Right Docking & Seamless Dual-Panel Switching (<a href="assets/demo-03-panel-switching.mp4">HD Video: 03-dual-panel-switch-and-docking.mp4</a>)</sub>
</p>

---

### 4. Topbar Capsules Progressive Responsive Collapse & Sidebar Adaptability
> Demo File: `04-responsive-collapse-compact.mp4`

When both left navigation and right tool panes are active and main workspace width is constrained, the top-right capsule cluster executes a 4-stage progressive responsive collapse (from full text to pure numbers down to compact icon rings and overflow menu) without ever breaking titlebar layout:

<p align="center">
  <a href="assets/demo-04-responsive-collapse.mp4">
    <img src="assets/demo-04-responsive-collapse.gif" alt="Topbar Capsules Progressive Responsive Collapse & Sidebar Adaptability" width="760">
  </a>
  <br>
  <sub>🎬 Demo Animation: 4-Stage Progressive Responsive Collapse & Compact Triggering (<a href="assets/demo-04-responsive-collapse.mp4">HD Video: 04-responsive-collapse-compact.mp4</a>)</sub>
</p>

---

## 📸 Screenshots & UI Details

| 01. Session Context & Generation Speed Main View | 02. Expanded Context: Custom Colors & Audit Details |
| :---: | :---: |
| <img src="assets/panel-context-main.png" alt="Session context main view" width="460"> | <img src="assets/panel-context-audit-expanded.png" alt="Session context expanded audit" width="460"> |
| Top **"⭐ Quick Summary"** (Used, Budget, Remaining) and **"⚡ Latest Speed & Latency"** (87.6 tok/s, 10.12s duration, 8.72s TTFT, 886 tok output); collapsible drawers below. | Drawers expanded: **"🎨 Custom Colors"** (panel background & metrics) and **"📋 Low-Level Parameters & Attachment Audit"** (server response, client estimates, image dimensions `561×179 px`, re-scan). |

| 03. Titlebar Ring Capsule, Speed & Native Tooltip | 04. Token Usage Overview & 5-Stop Heatmap Customizer |
| :---: | :---: |
| <img src="assets/capsule-speed-and-tooltip.png" alt="Titlebar capsule and tooltip" width="460"> | <img src="assets/panel-token-heatmap-customizer.png" alt="Token usage and heatmap customizer" width="460"> |
| Permanent ring progress capsule and ⚡ speed capsule (`87.6 tok/s`); 3-layer native tooltip on hover displaying exact percentage and token count. | 4 metric cards: **Total, Today, Month, Year**; 52-week heatmap with **Daily / Weekly / Cumulative** views; 5 color presets, 5-stop per-cell customizer, and 2-endpoint linear interpolation. |

---

## ✨ Comprehensive Features

1. **Titlebar Ring Indicator & Model Speed Capsule**:
   - Seamless dark-mode native integration with elastic hover transitions.
   - Circular progress ring (`#badge-context`) with 3-tier warning colors and 3-layer native tooltip.
   - Speed capsule (`#badge-speed`) capturing TTFT latency, streaming tok/s, and duration.
   - 4-stage progressive responsive collapse preventing titlebar overflow.

2. **Decoupled Dual Independent Panels & Anti-Clipping**:
   - Independent Session Context and Token Activity panels.
   - Direct switching between panels by clicking topbar capsules.
   - Boundary-aware positioning preventing clipping when right sidebars are open.

3. **Session Context & Generation Monitor (Panel A)**:
   - Pinned core summary cards (Used / Budget / Remaining).
   - Generation efficiency metrics with speed ratings (Rapid / Smooth / Good / Slow).
   - Appearance drawer for custom background and metric color slots.
   - Server-side 1M overflow alert, client estimate breakdown, and image pixel format (`561×179 px`).
   - One-click conversation and attachment re-scan.

4. **Account Token Tracker & 52-Week Heatmap (Panel B)**:
   - Total, Today, Month, and Year statistics with international abbreviations (M / B).
   - 52-week activity heatmap with Daily, Weekly, and Cumulative views.
   - Detailed hover tooltips with Prompt, Output, and Cache metrics.
   - 5-stop additive color system: 5 presets, per-cell custom color popovers (clicking legend cells directly), and 2-endpoint interpolation.

---

## 🌐 UI Localization & Multi-Language Support

Default UI text is **Simplified Chinese**. To render the interface in your preferred language (**English / 日本語 / 한국어 / Español**):

> [!TIP]
> Tell your AI Agent: **"Read AGENTS.md, install this plugin, and translate UI text in meter-renderer.js to [Target Language]"**.

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
node cli.js status
node cli.js restore
```

---

## 🧪 Testing

```bash
node --test meter-core.test.js meter-renderer.test.js
```
All 38 test suites passing.

---

## 🤝 Community & Support

- **[LINUX DO](https://linux.do/)**: Endorsed by and supporting the LINUX DO community.
