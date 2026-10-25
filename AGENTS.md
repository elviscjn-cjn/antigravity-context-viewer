# AI Agent Installation & Execution Guide (AGENTS.md)

This repository packages **Antigravity 对话上下文查看器 & Token 用量看板 (`antigravity-context-viewer` v2.3.0)** — a native-styled session context window progress bar, account-wide token usage counter & 7×52 activity heatmap, and attachment analyzer for **Google Antigravity Desktop**.

When a user asks an AI Agent (Antigravity, Claude Code, Codex, Cursor, etc.) to install, update, check, or uninstall this project, follow these exact, zero-dependency steps.

---

## 1. Zero-Dependency Design
- **No `npm install` is required.** This repository includes a built-in pure Node.js ASAR engine ([`asar-engine.js`](asar-engine.js)) and CDP WebSocket client.
- Only **Node.js (>= 18.x)** is required.
- **Self-Protection Rule**: Do **NOT** kill or terminate `Antigravity.exe` when running inside an Antigravity agent session. `node cli.js install` automatically updates `app.asar` on disk AND hot-injects the UI into the currently running Antigravity window via Chrome DevTools Protocol (`DevToolsActivePort`) with zero downtime.

---

## 2. One-Command Installation (For AI Agents)

### Step 1: Locate `node`
If `node` is in `PATH`, use `node`. On Windows, if `node` is not in default `PATH`, check:
- `C:\Program Files\nodejs\node.exe`
- `%LOCALAPPDATA%\OpenAI\Codex\runtimes\cua_node\*\bin\node.exe`

### Step 2: Execute Install
Run from the repository root:
```bash
node cli.js install
```
*(Or on Windows cmd/PowerShell: `.\install.bat --no-pause`)*

What `node cli.js install` does automatically:
1. Auto-detects `app.asar` across Windows (`%LOCALAPPDATA%\Programs\antigravity\resources\app.asar`), macOS (`/Applications/Antigravity.app/Contents/Resources/app.asar`), and Linux. (Pass `--path "<custom-path>"` if installed in a non-standard directory).
2. Creates a clean, SHA-256 verified backup in `backups/` (preserving any existing localization patches such as `antigravity-chinese`).
3. Injects [`meter-main.js`](meter-main.js), [`meter-core.js`](meter-core.js), [`meter-renderer.js`](meter-renderer.js), [`meter-collector.js`](meter-collector.js), and [`attachment_scan.py`](attachment_scan.py) into `dist/`, and adds read-only hooks to `dist/utils.js` and `dist/preload.js`.
4. Verifies SHA-256 integrity of all untouched files in `app.asar`.
5. Connects to the running Antigravity window via `DevToolsActivePort` and hot-reloads the `#343434` native context meter badge immediately without restarting the app.

### Step 3: Verify Installation
Run:
```bash
node cli.js status
node --test meter-core.test.js meter-renderer.test.js
```
Confirm `"asarPatched": true` and `"active": true` in the JSON output.

---

## 3. On-Demand Multi-Language UI Translation
The default UI language in `meter-renderer.js` is Simplified Chinese.
If the user specifies a target language (e.g., "Install and translate UI to English / Japanese / Korean / Spanish"):
1. Open [`meter-renderer.js`](meter-renderer.js).
2. Translate the user-facing text literals into the requested target language (tab labels, badge hover tooltips, key metrics headers, status pills, and tooltip texts).
3. Keep all DOM element IDs (`amount`, `badge`, `panel`, `badge-tokens`), CSS selectors, event handlers, and data structures untouched.
4. Run `node cli.js install` to bundle and hot-inject the translated UI into Antigravity.

---

## 4. Other Commands
- **Hot-inject only (no disk modification)**: `node cli.js live`
- **Environment health check**: `node cli.js check`
- **Restore / Uninstall**: `node cli.js restore`
