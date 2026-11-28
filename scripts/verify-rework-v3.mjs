/**
 * ContextMeter v3 返工隔离真 Chromium 验收框架（可复用，支持阶段一至阶段八）
 *
 * 约定：
 * - 每次运行实时加载仓库最新生产产物 meter-core.js 与 meter-renderer.js，并打印 buildId 与文件哈希；
 * - 截图双写至：
 *   1) 系统临时目录 context-meter-rework/
 *   2) 系统临时目录 context-meter-rework-timeline/
 * - 切换日志也写入系统临时目录 context-meter-rework/
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const REPO_ROOT = path.resolve(__dirname, '..');

export const DEFAULT_OUTPUT_DIR = path.join(os.tmpdir(), 'context-meter-rework');
export const DEFAULT_BRAIN_SCREENSHOT_DIR = path.join(os.tmpdir(), 'context-meter-rework-timeline');

export const TRADITIONAL_CHAR_RE = /[體臺為後書與無開關設顯頁切換網鍵條項覽態號額計統資紀錄訊檢視圖點擊儲刪並終端預覽瀏覽編輯彙階對組協編總極遙]/;
export const PAREN_RE = /[()（）]/;

export function findBrowserExecutable() {
  const candidates = [
    process.env.AG_CM_TEST_BROWSER,
    process.env.AG_TEST_BROWSER_PATH,
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser'
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch { }
  }
  return null;
}

export function getRendererBuildMeta() {
  const rendererPath = path.join(REPO_ROOT, 'meter-renderer.js');
  const raw = fs.readFileSync(rendererPath, 'utf8');
  const sha256 = crypto.createHash('sha256').update(raw).digest('hex');
  const m = raw.match(/buildId:\s*['"]([0-9a-fA-F_a-zA-Z-]+)['"]/);
  return {
    rendererPath,
    bytes: Buffer.byteLength(raw, 'utf8'),
    sha256,
    embeddedBuildId: m ? m[1] : 'unknown'
  };
}

export class CdpClient {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.seq = 0;
    this.pending = new Map();
    this.readyPromise = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve(), { once: true });
      this.ws.addEventListener('error', (err) => reject(err), { once: true });
    });
    this.ws.addEventListener('message', (ev) => {
      try {
        const msg = JSON.parse(String(ev.data || ''));
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
          else resolve(msg.result);
        }
      } catch { }
    });
  }

  async connect() {
    await this.readyPromise;
  }

  async send(method, params = {}) {
    const id = ++this.seq;
    const p = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.ws.send(JSON.stringify({ id, method, params }));
    return p;
  }

  async evaluate(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    });
    if (res?.exceptionDetails) {
      const desc =
        res.exceptionDetails.exception?.description ||
        res.exceptionDetails.text ||
        JSON.stringify(res.exceptionDetails);
      throw new Error(`Page eval error: ${desc}`);
    }
    return res?.result?.value;
  }

  close() {
    try {
      this.ws.close();
    } catch { }
  }
}

export function createAntigravityHostFixtureHtml(opts = {}) {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  const pkgVersion = pkg.version || '0.9.3';
  const width = Number(opts.width) > 320 ? Math.round(Number(opts.width)) : 1440;
  const height = Number(opts.height) > 320 ? Math.round(Number(opts.height)) : 900;
  const initialAuxWidth = Number(opts.auxWidthPx) > 260 ? Math.round(Number(opts.auxWidthPx)) : 680;
  const initialCoexistMode = opts.auxCoexistMode === 'split' ? 'split' : 'tab';
  const initialAuxViewTab = opts.auxViewTab || 'plugin';

  return `<!DOCTYPE html>
<html lang="zh-CN" data-theme="dark">
<head>
<meta charset="utf-8" />
<title>Antigravity 2.35+ Rework v3 Host Fixture</title>
<style>
  :root {
    --background: #141416;
    --foreground: #f2f2f5;
    --card: #1b1b1f;
    --secondary: #222227;
    --secondary-foreground: #b8b8c2;
    --muted: #1e1e23;
    --muted-foreground: #8c8c98;
    --border: rgba(255, 255, 255, 0.11);
    --input: #141416;
    --accent: #3274f6;
    --primary: #3274f6;
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    padding: 0;
    width: ${width}px;
    height: ${height}px;
    overflow: hidden;
    background: var(--background);
    color: var(--foreground);
    font-family: "Segoe UI", "Microsoft YaHei UI", -apple-system, BlinkMacSystemFont, sans-serif;
  }
  .ag-app-root {
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
    overflow: hidden;
  }
  [data-testid="title-menu-bar"] {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 36px;
    flex: 0 0 36px;
    background: #18181c;
    border-bottom: 1px solid var(--border);
    padding: 0 12px;
    font-size: 13px;
  }
  .titlebar-right-cluster {
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }
  .native-open-ide-btn {
    height: 24px;
    padding: 0 10px;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: #24242a;
    color: var(--foreground);
    font-size: 12px;
    cursor: pointer;
  }
  .workbench-body {
    display: flex;
    flex-direction: row;
    flex: 1 1 auto;
    min-height: 0;
    width: 100%;
    overflow: hidden;
  }
  .left-nav-rail {
    flex: 0 0 220px;
    width: 220px;
    height: 100%;
    background: #121215;
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    padding: 10px;
  }
  .left-nav-sessions {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .left-nav-item {
    padding: 8px 10px;
    border-radius: 7px;
    font-size: 12.5px;
    color: var(--secondary-foreground);
    background: transparent;
    border: none;
    text-align: left;
    cursor: pointer;
  }
  .left-nav-item.active {
    background: rgba(50, 116, 246, 0.16);
    color: var(--foreground);
  }
  .left-account-pill {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    border-radius: 8px;
    background: #1b1b20;
    border: 1px solid var(--border);
    color: var(--foreground);
    font-size: 12px;
    cursor: pointer;
  }
  .workspace-row {
    display: flex;
    flex-direction: row;
    flex: 1 1 auto;
    min-width: 0;
    height: 100%;
    overflow: hidden;
    position: relative;
  }
  .left-session-slot {
    flex: 1 1 auto;
    min-width: 280px;
    height: 100%;
    display: flex;
    flex-direction: column;
    background: #151518;
    position: relative;
    overflow: hidden;
  }
  .conv-header {
    height: 44px;
    flex: 0 0 44px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 16px;
    border-bottom: 1px solid var(--border);
    background: #17171b;
  }
  .conv-title {
    font-size: 14px;
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  [data-testid="conversation-view"] {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    padding: 12px 16px;
    overflow: hidden;
  }
  #conv-messages {
    flex: 1 1 auto;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding-bottom: 12px;
  }
  .msg-bubble {
    padding: 10px 12px;
    border-radius: 10px;
    background: #1d1d22;
    border: 1px solid rgba(255, 255, 255, 0.06);
    font-size: 13px;
    line-height: 1.5;
  }
  .surface-composer {
    height: 68px;
    flex: 0 0 68px;
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 8px 10px;
    background: #1a1a1f;
  }
  .host-outer-sash {
    flex: 0 0 1px;
    width: 1px;
    height: 100%;
    background: var(--border);
    cursor: col-resize;
    position: relative;
    z-index: 25;
  }
  [data-side-panel-open="true"] {
    position: relative;
    flex: 0 0 ${initialAuxWidth}px;
    width: ${initialAuxWidth}px;
    height: 100%;
    display: flex;
    flex-direction: row;
    border-left: 1px solid var(--border);
    background: #17171b;
    min-width: 0;
  }
  [data-side-panel-focus-scope="true"] {
    position: relative;
    flex: 1 1 auto;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  [data-side-panel-strip="true"] {
    height: 38px;
    flex: 0 0 38px;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 10px;
    background: #1b1b20;
    border-bottom: 1px solid var(--border);
    font-size: 12.5px;
    overflow: hidden;
  }
  .agy-aux-tabs-scroll {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
  }
  .agy-aux-tab {
    display: inline-flex;
    align-items: center;
    height: 28px;
    border-radius: 7px;
    background: transparent;
    color: var(--secondary-foreground);
  }
  .agy-aux-tab button[data-tab-id] {
    appearance: none;
    border: none;
    background: transparent;
    color: inherit;
    font: inherit;
    padding: 0 10px;
    height: 28px;
    cursor: pointer;
    border-radius: 7px;
  }
  .agy-aux-tab.active-native {
    background: rgba(255, 255, 255, 0.11);
    color: var(--foreground);
  }
  [data-testid="side-panel-new-tab-button"] {
    appearance: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    border-radius: 6px;
    border: 1px solid transparent;
    background: transparent;
    color: var(--secondary-foreground);
    cursor: pointer;
    font-size: 16px;
    flex-shrink: 0;
  }
  [data-testid="side-panel-new-tab-button"]:hover {
    background: rgba(255, 255, 255, 0.08);
    color: var(--foreground);
  }
  [data-testid="side-panel-drag-spacer"] {
    flex: 1 1 auto;
    min-width: 12px;
    height: 100%;
  }
  [data-side-panel-body="true"] {
    position: relative;
    flex: 1 1 auto;
    min-width: 0;
    min-height: 0;
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: #141418;
  }
  [data-testid="host-browser-pane"] {
    flex: 1 1 auto;
    position: relative;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    background: #181a20;
    padding: 16px;
    overflow: auto;
  }
  .browser-mock-card {
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 14px;
    background: #20232b;
  }
  .host-settings-backdrop {
    position: fixed;
    inset: 0;
    z-index: 9000;
    background: rgba(0, 0, 0, 0.56);
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .host-settings-backdrop[hidden] {
    display: none !important;
  }
  .host-settings-modal {
    width: 900px;
    height: 540px;
    background: var(--background);
    border: 1px solid var(--border);
    border-radius: 12px;
    overflow: hidden;
    display: flex;
  }
  .host-settings-inner {
    position: relative;
    display: flex;
    width: 100%;
    height: 100%;
    min-height: 0;
  }
  [data-testid="settings-sidebar"] {
    width: 210px;
    flex: 0 0 210px;
    background: var(--secondary);
    border-right: 1px solid var(--border);
    padding: 14px 10px;
    overflow-y: auto;
  }
  .settings-sidebar-group {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-bottom: 12px;
  }
  .settings-sidebar-group button {
    height: 30px;
    padding: 0 10px;
    border-radius: 7px;
    border: none;
    background: transparent;
    color: var(--foreground);
    font-size: 13px;
    text-align: left;
    cursor: pointer;
  }
  .host-settings-right-pane {
    position: relative;
    flex: 1 1 0%;
    min-width: 0;
    height: 100%;
    overflow-y: hidden;
  }
</style>
</head>
<body>
<div class="ag-app-root h-screen w-screen">
  <div data-testid="title-menu-bar">
    <span>Antigravity</span>
    <div class="titlebar-right-cluster">
      <button type="button" class="native-open-ide-btn">打开 IDE</button>
    </div>
  </div>
  <div class="workbench-body">
    <aside class="left-nav-rail" data-testid="left-sidebar">
      <div class="left-nav-sessions">
        <button type="button" class="left-nav-item" data-testid="plugins-button">自定义扩展</button>
        <button type="button" class="left-nav-item active" data-session-id="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa">Replying With Ok</button>
        <button type="button" class="left-nav-item" data-session-id="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb">ContextMeter Rework</button>
        <button type="button" class="left-nav-item" data-session-id="cccccccc-cccc-4ccc-8ccc-cccccccccccc">Optical CapEx Audit</button>
      </div>
      <button type="button" class="left-account-pill" id="host-account-pill" data-testid="sidebar-account-button">
        <span>EL</span>
        <span>elvis@example.com</span>
      </button>
    </aside>
    <div class="workspace-row" id="workspace-row">
      <div class="left-session-slot" id="left-session-slot">
        <div class="conv-header" data-testid="conversation-header">
          <div class="conv-title" id="conv-title">Replying With Ok</div>
          <div class="titlebar-right-cluster">
            <button type="button" class="native-open-ide-btn">打开 IDE</button>
          </div>
        </div>
        <div data-testid="conversation-view" data-pane-id="p1" data-cascade-id="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" data-focused="true">
          <div id="conv-messages">
            <div class="msg-bubble">用户消息 1：请检查右侧内容区空白自愈与四态切换。</div>
            <div class="msg-bubble">助手回复 1：正在排查挂载根连接状态、容器尺寸与重挂载自愈流程。</div>
            <div class="msg-bubble">用户消息 2：继续确认会话标题正下方四视角标签与滚动保活。</div>
            <div class="msg-bubble">助手回复 2：已保留原生对话区 DOM，不销毁、不改动边框与内边距。</div>
            <div class="msg-bubble">用户消息 3：核查轨迹视图泳道、筛选胶囊与关键词搜索。</div>
            <div class="msg-bubble">助手回复 3：三类泳道按输入、模型、工具分条堆叠，支持点击原地展开。</div>
            <div class="msg-bubble">用户消息 4：核查上下文视图五行业务与单步详情联动。</div>
            <div class="msg-bubble">助手回复 4：时间线柱图与单步详情检查卡已联动，无外部推广位。</div>
            <div class="msg-bubble">用户消息 5：核查编队视图单主节点与真实空态。</div>
            <div class="msg-bubble">助手回复 5：无子 Agent 时仅显示主节点与真实空态说明，不伪造示例节点。</div>
            <div class="msg-bubble">用户消息 6：确认右侧浏览器与 Swarm 分栏不受影响。</div>
            <div class="msg-bubble">助手回复 6：右侧分栏独立保留完整几何尺寸，切回对话后 scrollTop 精准不变。</div>
            <div class="msg-bubble">用户消息 7：长列表占位验证滚动条高度超过可视区域。</div>
            <div class="msg-bubble">助手回复 7：滚动容器已就绪，可用于验证切走再切回后位置恒定。</div>
          </div>
          <form class="surface-composer">
            <div contenteditable="true" data-lexical-editor="true">输入消息...</div>
          </form>
        </div>
      </div>
      <div class="host-outer-sash" id="host-outer-sash" role="separator" data-testid="aux-pane-sash"></div>
      <div data-side-panel-open="true" id="aux-outer">
        <div data-side-panel-focus-scope="true" id="aux-inner">
          <div data-side-panel-strip="true" id="host-strip" data-active-tab-id="browser__main">
            <div class="agy-aux-tabs-scroll" id="host-tabs-scroll">
              <div class="agy-aux-tab active-native" data-native-tab-wrap="browser">
                <button type="button" data-tab-id="browser__main">浏览器</button>
              </div>
              <div class="agy-aux-tab" data-native-tab-wrap="swarm">
                <button type="button" data-tab-id="swarm__main">Swarm</button>
              </div>
            </div>
            <button type="button" id="host-plus-btn" data-testid="side-panel-new-tab-button" aria-label="新建标签">+</button>
            <div data-testid="side-panel-drag-spacer"></div>
          </div>
          <div data-side-panel-body="true" id="host-side-panel-body">
            <div data-testid="host-browser-pane" id="host-browser-pane">
              <div class="browser-mock-card">
                <h3 style="margin:0 0 8px;font-size:14px;">宿主内置浏览器预览</h3>
                <p style="margin:0;font-size:12.5px;color:#a8b0c0;">URL: https://localhost:3000/preview</p>
                <p style="margin:8px 0 0;font-size:12px;color:#8c95a6;">原生浏览区已就绪，用于验证预览内容区正常渲染。</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</div>
<div id="host-settings-backdrop" class="host-settings-backdrop" hidden>
  <div id="host-settings-dialog" class="host-settings-modal" role="dialog" aria-label="Settings">
    <div class="host-settings-inner relative flex w-full h-full">
      <aside data-testid="settings-sidebar">
        <div class="settings-sidebar-group" data-group="main">
          <button id="settings-nav-item-General" type="button" role="tab" aria-selected="true">General</button>
          <button id="settings-nav-item-Models" type="button" role="tab" aria-selected="false">Models</button>
          <button id="settings-nav-item-Browser" type="button" role="tab" aria-selected="false">Browser</button>
        </div>
        <div class="settings-sidebar-group" data-group="account">
          <button id="settings-nav-item-Account" type="button" role="tab" aria-selected="false">Account</button>
        </div>
      </aside>
      <section id="host-right-pane" class="host-settings-right-pane" data-settings-content-pane="true">
        <div id="native-general-body" style="padding:20px;"><h2>General Settings</h2></div>
        <div id="native-models-body" style="padding:20px;" hidden><h2>Models Settings</h2></div>
        <div id="native-browser-body" style="padding:20px;" hidden><h2>Browser Settings</h2></div>
        <div id="native-account-body" style="padding:20px;" hidden><h2>Account Settings</h2></div>
      </section>
    </div>
  </div>
</div>
<script>
  (function () {
    const strip = document.getElementById('host-strip');
    const tabsScroll = document.getElementById('host-tabs-scroll');
    const plusBtn = document.getElementById('host-plus-btn');
    window.__plusClickCount = 0;
    window.__nativeToolsOpened = [];
    window.__ensureNativeTab = (tabId, label, kind) => {
      if (!tabsScroll) return null;
      let existing = tabsScroll.querySelector('button[data-tab-id="' + tabId + '"]');
      if (!existing) {
        const w = document.createElement('div');
        w.className = 'agy-aux-tab';
        w.setAttribute('data-native-tab-wrap', kind || tabId);
        const b = document.createElement('button');
        b.type = 'button';
        b.setAttribute('data-tab-id', tabId);
        b.textContent = label;
        w.appendChild(b);
        tabsScroll.appendChild(w);
        existing = b;
      }
      return existing;
    };
    window.__setNativeTabsForTest = (kinds) => {
      if (!tabsScroll) return;
      tabsScroll.querySelectorAll('.agy-aux-tab[data-native-tab-wrap]').forEach((n) => n.remove());
      for (const k of kinds || []) {
        if (k === 'browser') window.__ensureNativeTab('browser__main', '浏览器', 'browser');
        if (k === 'swarm') window.__ensureNativeTab('swarm__main', 'Swarm', 'swarm');
      }
      const firstBtn = tabsScroll.querySelector('button[data-tab-id]:not([data-ag-aux-native-tab="true"])');
      if (strip) strip.setAttribute('data-active-tab-id', firstBtn ? firstBtn.getAttribute('data-tab-id') : '');
    };
    window.__toggleHostSettingsModal = (open) => {
      const bd = document.getElementById('host-settings-backdrop');
      if (bd) bd.hidden = !open;
      if (open && window.__AGContextMeter?.syncHostSettingsForTest) {
        window.__AGContextMeter.syncHostSettingsForTest();
      }
    };
    window.__setAuxSidebarOpenForTest = (open) => {
      const auxOuter = document.getElementById('aux-outer');
      const sash = document.getElementById('host-outer-sash');
      if (auxOuter) {
        auxOuter.hidden = !open;
        auxOuter.setAttribute('data-side-panel-open', open ? 'true' : 'false');
      }
      if (sash) sash.hidden = !open;
      window.dispatchEvent(new Event('resize'));
    };
    window.__setMainSessionWidthForTest = (px) => {
      const slot = document.getElementById('left-session-slot');
      if (!slot) return;
      if (px == null) {
        slot.style.flex = '';
        slot.style.width = '';
        slot.style.maxWidth = '';
      } else {
        slot.style.flex = '0 0 ' + Math.round(px) + 'px';
        slot.style.width = Math.round(px) + 'px';
        slot.style.maxWidth = Math.round(px) + 'px';
      }
      window.dispatchEvent(new Event('resize'));
    };
    if (plusBtn) {
      plusBtn.addEventListener('click', () => {
        window.__plusClickCount += 1;
        window.__nativeToolsOpened.push('browser');
        const btn = window.__ensureNativeTab('browser__main', '浏览器', 'browser');
        if (strip) strip.setAttribute('data-active-tab-id', 'browser__main');
        if (btn) btn.click();
      });
    }
    if (strip) {
      strip.addEventListener('click', (ev) => {
        const btn = ev.target && ev.target.closest ? ev.target.closest('button[data-tab-id]') : null;
        if (!btn || btn.getAttribute('data-ag-aux-native-tab') === 'true') return;
        const tid = btn.getAttribute('data-tab-id') || '';
        strip.setAttribute('data-active-tab-id', tid);
        strip.querySelectorAll('.agy-aux-tab[data-native-tab-wrap]').forEach((w) => {
          const b = w.querySelector('button[data-tab-id]');
          w.classList.toggle('active-native', b && b.getAttribute('data-tab-id') === tid);
        });
      });
    }

    const nowMs = Date.now();
    const formatLocalDayKey = (ms) => {
      const d = new Date(ms);
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    };
    const dayKeyOffset = (offsetDays) => formatLocalDayKey(nowMs - offsetDays * 86400000);
    const d0 = dayKeyOffset(0);
    const d1 = dayKeyOffset(1);
    const d2 = dayKeyOffset(2);
    const d4 = dayKeyOffset(4);
    const d6 = dayKeyOffset(6);
    const d12 = dayKeyOffset(12);
    const d20 = dayKeyOffset(20);
    const richDailyInsights = {
      [d20]: { tokens: 1200000000, input: 1120000000, cache: 1050000000, output: 80000000, costUSD: 260.0, calls: 320, sessions: 18, cacheReadPct: 93.8, activeDurationMs: 28000000, toolCalls: 9200 },
      [d12]: { tokens: 1650000000, input: 1550000000, cache: 1460000000, output: 100000000, costUSD: 360.0, calls: 410, sessions: 24, cacheReadPct: 94.2, activeDurationMs: 36000000, toolCalls: 12400 },
      [d6]: { tokens: 1180000000, input: 1100000000, cache: 1030000000, output: 80000000, costUSD: 256.4, calls: 290, sessions: 16, cacheReadPct: 93.6, activeDurationMs: 26000000, toolCalls: 8900 },
      [d4]: { tokens: 1420000000, input: 1330000000, cache: 1255000000, output: 90000000, costUSD: 310.0, calls: 360, sessions: 22, cacheReadPct: 94.4, activeDurationMs: 32000000, toolCalls: 11500 },
      [d2]: { tokens: 980000000, input: 915000000, cache: 860000000, output: 65000000, costUSD: 215.0, calls: 240, sessions: 15, cacheReadPct: 94.0, activeDurationMs: 21000000, toolCalls: 8100 },
      [d1]: { tokens: 950000000, input: 890000000, cache: 840000000, output: 60000000, costUSD: 205.0, calls: 230, sessions: 14, cacheReadPct: 94.4, activeDurationMs: 19500000, toolCalls: 7800 },
      [d0]: { tokens: 730000000, input: 695000000, cache: 655000000, output: 35000000, costUSD: 160.0, calls: 185, sessions: 11, cacheReadPct: 94.2, activeDurationMs: 15000000, toolCalls: 7135 }
    };
    const richDailyMap = {};
    for (const [k, v] of Object.entries(richDailyInsights)) {
      richDailyMap[k] = {
        total: v.tokens,
        totalTokens: v.tokens,
        input: v.input,
        inputTokens: v.input,
        cache: v.cache,
        cacheReadTokens: v.cache,
        output: v.output,
        outputTokens: v.output,
        costUSD: v.costUSD,
        steps: v.calls,
        sessions: v.sessions
      };
    }
    const richSessionArchives = [
      { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', cascadeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', title: 'Replying With Ok', firstUserMessage: '只回答 ok', lastMessagePreview: '已确认状态与上下文构成正常', workspaceTag: 'project1', project: 'project1', updatedAt: nowMs - 120000, dateKey: d0, totalTokens: 64200000, contextUsed: 125300, contextLimit: 1000000, costUSD: 18.4, turns: 6, steps: 18, archived: false, source: 'desktop', model: 'claude-sonnet-4-5' },
      { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', cascadeId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', title: 'ContextMeter Rework', firstUserMessage: '开始执行阶段五重构', lastMessagePreview: '四列排行与会话卡片网格已接入', workspaceTag: 'AntigravityContextMeter', project: 'AntigravityContextMeter', updatedAt: nowMs - 3600000, dateKey: d0, totalTokens: 128500000, contextUsed: 248000, contextLimit: 1000000, costUSD: 42.6, turns: 14, steps: 52, archived: false, source: 'desktop', model: 'claude-sonnet-4-5' },
      { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', cascadeId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', title: 'Optical CapEx Audit', firstUserMessage: '核对 1.6T 光模块出货预期', lastMessagePreview: '已汇总管理层电话会口径', workspaceTag: 'research-semi', project: 'research-semi', updatedAt: nowMs - 86400000, dateKey: d1, totalTokens: 89400000, contextUsed: 192000, contextLimit: 1000000, costUSD: 29.8, turns: 9, steps: 31, archived: false, source: 'cli', model: 'gemini-4-pro' },
      { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', cascadeId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', title: 'HBM4 Packaging Notes', firstUserMessage: '比较 CoWoS 与 SoIC 扩产节奏', lastMessagePreview: '补充 16Hi 堆叠验证时间点', workspaceTag: 'research-semi', project: 'research-semi', updatedAt: nowMs - 172800000, dateKey: d2, totalTokens: 73100000, contextUsed: 156000, contextLimit: 1000000, costUSD: 24.1, turns: 7, steps: 24, archived: true, source: 'desktop', model: 'gemini-4-pro' },
      { id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', cascadeId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', title: 'Splitter Geometry Fix', firstUserMessage: '检查中右分隔线 1:1 跟手', lastMessagePreview: '11 项真实 Chromium 几何测试通过', workspaceTag: 'AntigravityContextMeter', project: 'AntigravityContextMeter', updatedAt: nowMs - 345600000, dateKey: d4, totalTokens: 112000000, contextUsed: 310000, contextLimit: 1000000, costUSD: 37.5, turns: 11, steps: 41, archived: false, source: 'cli', model: 'claude-sonnet-4-5' },
      { id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', cascadeId: 'ffffffff-ffff-4fff-8fff-ffffffffffff', title: 'Daily X Intel Pipeline', firstUserMessage: '核验今天抓取的 12 个账号', lastMessagePreview: '完整性门禁通过，零缺页', workspaceTag: 'project1', project: 'project1', updatedAt: nowMs - 518400000, dateKey: d6, totalTokens: 54900000, contextUsed: 98000, contextLimit: 1000000, costUSD: 15.2, turns: 5, steps: 14, archived: false, source: 'desktop', model: 'claude-sonnet-4-5' }
    ];
    window.__persistedSettings = {
      ok: true,
      dockPosition: 'aux',
      panelDockMode: 'aux',
      auxCoexistMode: '${initialCoexistMode}',
      auxViewTab: '${initialAuxViewTab}',
      auxOrder: 'plugin-first',
      auxWidthPx: ${initialAuxWidth},
      auxPluginSharePx: 340,
      uiPreferences: {
        panelLanguage: 'zh-CN',
        themeMode: 'dark',
        dockPosition: 'aux',
        panelDockMode: 'aux',
        auxCoexistMode: '${initialCoexistMode}',
        auxViewTab: '${initialAuxViewTab}',
        auxOrder: 'plugin-first',
        auxWidthPx: ${initialAuxWidth},
        auxPluginSharePx: 340
      }
    };
    window.__savedSettingsCalls = [];
    window.__APP_CONFIG__ = { csrfToken: 'rework-v3-token' };
    window.contextMeterAPI = {
      getRuntimeInfo: async () => ({
        ok: true,
        backendVersion: '${pkgVersion}',
        backendSource: 'electron-ipc',
        hostSupportsRestart: true
      }),
      getSettings: async () => JSON.parse(JSON.stringify(window.__persistedSettings)),
      saveSettings: async (patch) => {
        window.__savedSettingsCalls.push(JSON.parse(JSON.stringify(patch || {})));
        if (patch && typeof patch === 'object') {
          Object.assign(window.__persistedSettings, patch);
          if (patch.uiPreferences) {
            Object.assign(window.__persistedSettings.uiPreferences, patch.uiPreferences);
          }
        }
        return { ok: true, uiPreferences: window.__persistedSettings.uiPreferences };
      },
      scan: async () => ({
        ok: true,
        data: {
          found: true,
          cascadeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          title: 'Replying With Ok',
          model: 'claude-sonnet-4-5',
          contextUsed: 125300,
          contextLimit: 1000000,
          inputTokens: 125300,
          outputTokens: 4820,
          cacheReadTokens: 112000,
          turns: 6,
          steps: 18
        }
      }),
      getTokenHistory: async () => ({
        ok: true,
        loading: false,
        totalTokens: 8110000000,
        summary: {
          totalTokens: 8110000000,
          inputTokens: 7600000000,
          outputTokens: 510000000,
          cacheReadTokens: 7150000000,
          totalCostUSD: 1766.4,
          sessionCount: 120,
          archivedSessionCount: 18,
          toolCallCount: 65035,
          activeDurationMs: 523980000,
          modelCallCount: 2035
        },
        dailyMap: richDailyMap,
        dailyModelMap: {
          [d0]: { 'claude-sonnet-4-5': { input: 695000000, cache: 655000000, output: 35000000, total: 730000000, costUSD: 160.0 } },
          [d1]: { 'claude-sonnet-4-5': { input: 890000000, cache: 840000000, output: 60000000, total: 950000000, costUSD: 205.0 } }
        },
        crossSessionInsights: {
          dailyInsights: richDailyInsights,
          topProjects: [
            { name: 'AntigravityContextMeter', count: 48, byDate: { [d0]: 5, [d1]: 6, [d4]: 12 } },
            { name: 'project1', count: 36, byDate: { [d0]: 4, [d6]: 9 } },
            { name: 'research-semi', count: 24, byDate: { [d1]: 5, [d2]: 7 } }
          ],
          topSkills: [
            { name: 'impeccable', count: 42, byDate: { [d0]: 6, [d1]: 8 } },
            { name: 'diagnosing-bugs', count: 29, byDate: { [d0]: 4, [d2]: 5 } },
            { name: 'code-review', count: 18, byDate: { [d1]: 3, [d4]: 6 } }
          ],
          topTools: [
            { name: 'read_file', count: 28410, byDate: { [d0]: 3100, [d1]: 3500 } },
            { name: 'run_command', count: 19820, byDate: { [d0]: 2150, [d1]: 2400 } },
            { name: 'edit_file', count: 16805, byDate: { [d0]: 1885, [d1]: 1900 } }
          ],
          topCommands: [
            { program: 'node', count: 420, byDate: { [d0]: 45, [d1]: 52 } },
            { program: 'npm', count: 265, byDate: { [d0]: 28, [d1]: 31 } },
            { program: 'git', count: 194, byDate: { [d0]: 18, [d1]: 24 } }
          ],
          sessionArchives: richSessionArchives
        }
      }),
      getQuota: async () => ({
        ok: true,
        data: {
          ok: true,
          collectorVersion: '${pkgVersion}',
          snapshot: {
            syncState: 'fresh',
            fetchedAtMs: nowMs,
            pools: [
              {
                poolKey: 'shared_gemini_main',
                title: 'Gemini',
                remainingFraction: 0.78,
                buckets: [
                  { windowShort: '5h', windowKey: '5h', remainingFraction: 0.78, isResetPassed: false },
                  { windowShort: '7d', windowKey: 'weekly', remainingFraction: 0.84, isResetPassed: false }
                ]
              },
              {
                poolKey: 'shared_3p_pool',
                title: 'Claude / GPT',
                remainingFraction: 0.65,
                buckets: [
                  { windowShort: '5h', windowKey: '5h', remainingFraction: 0.65, isResetPassed: false },
                  { windowShort: '7d', windowKey: 'weekly', remainingFraction: 0.74, isResetPassed: false }
                ]
              }
            ]
          }
        }
      }),
      getAccountsOverview: async () => ({
        ok: true,
        activeAccountEmail: 'elvis@example.com',
        accounts: [
          { email: 'elvis@example.com', maskedEmail: 'el***is@example.com', isActive: true, hasRefreshToken: true }
        ],
        autoSwitch: { enabled: false },
        autoSwitchStatus: { state: 'disabled' }
      }),
      checkUpdate: async () => ({
        ok: true,
        hasUpdate: false,
        currentVersion: '${pkgVersion}',
        installedVersion: '${pkgVersion}'
      })
    };
  })();
</script>
</body>
</html>`;
}

async function waitForJson(url, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw lastErr || new Error(`Timed out waiting for ${url}`);
}

export async function launchReworkBrowserSession(opts = {}) {
  const browserPath = findBrowserExecutable();
  assert.ok(browserPath, '本机必须存在 Chrome 或 Edge 用于隔离真 Chromium 验收');

  const corePath = path.join(REPO_ROOT, 'meter-core.js');
  const rendererPath = path.join(REPO_ROOT, 'meter-renderer.js');
  const coreCode = fs.readFileSync(corePath, 'utf8');
  const rendererCode = fs.readFileSync(rendererPath, 'utf8');
  const buildMeta = getRendererBuildMeta();
  const fixtureHtml = opts.customHtml || createAntigravityHostFixtureHtml(opts);

  const server = http.createServer((req, res) => {
    const reqUrl = String(req.url || '/');
    if (reqUrl.startsWith('/c/') || reqUrl === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fixtureHtml);
      return;
    }
    if (reqUrl === '/meter-core.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
      res.end(coreCode);
      return;
    }
    if (reqUrl === '/meter-renderer.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
      res.end(rendererCode);
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const httpPort = server.address().port;
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agcm-rework-v3-'));
  const debugPort = 30000 + Math.floor(Math.random() * 12000);

  const vpWidth = Number(opts.width) > 320 ? Math.round(Number(opts.width)) : 1440;
  const vpHeight = Number(opts.height) > 320 ? Math.round(Number(opts.height)) : 900;

  const proc = spawn(
    browserPath,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${userDataDir}`,
      `--window-size=${vpWidth},${vpHeight}`,
      `http://127.0.0.1:${httpPort}/c/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`
    ],
    { stdio: 'ignore', windowsHide: true }
  );

  const cleanup = async () => {
    try {
      proc.kill();
    } catch { }
    await new Promise((r) => setTimeout(r, 150));
    try {
      server.close();
    } catch { }
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch { }
  };

  try {
    const targets = await waitForJson(`http://127.0.0.1:${debugPort}/json/list`, 12000);
    const pageTarget = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl) || targets[0];
    assert.ok(pageTarget?.webSocketDebuggerUrl, '必须获取到隔离 Chromium 页面 CDP 地址');

    const cdp = new CdpClient(pageTarget.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send('Page.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: vpWidth,
      height: vpHeight,
      deviceScaleFactor: 1,
      mobile: false
    });

    const navDeadline = Date.now() + 6000;
    while (Date.now() < navDeadline) {
      const ready = await cdp
        .evaluate(`Boolean(location.protocol === 'http:' && document.readyState !== 'loading')`)
        .catch(() => false);
      if (ready) break;
      await new Promise((r) => setTimeout(r, 60));
    }

    const preset = {
      dockPosition: opts.dockPosition ?? 'aux',
      auxCoexistMode: opts.auxCoexistMode ?? 'tab',
      auxViewTab: opts.auxViewTab ?? 'plugin',
      auxOrder: opts.auxOrder ?? 'plugin-first',
      auxWidthPx: opts.auxWidthPx ?? 680,
      auxPluginSharePx: opts.auxPluginSharePx ?? 340
    };

    const boot = await cdp.evaluate(`(async () => {
      window.__agBootErrors = [];
      window.addEventListener('error', (e) => window.__agBootErrors.push(String(e?.error?.stack || e?.message || e)));
      const preset = ${JSON.stringify(preset)};
      localStorage.setItem('ag_panel_lang', 'zh-CN');
      localStorage.setItem('ag_dock_position', String(preset.dockPosition));
      localStorage.setItem('ag_aux_coexist_mode', String(preset.auxCoexistMode));
      localStorage.setItem('ag_aux_view_tab', String(preset.auxViewTab));
      localStorage.setItem('ag_aux_order', String(preset.auxOrder));
      localStorage.setItem('ag_aux_width_px', String(preset.auxWidthPx));
      localStorage.setItem('ag_aux_plugin_share_px', String(preset.auxPluginSharePx));
      const loadScript = (src) => new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src;
        s.onload = () => resolve(true);
        s.onerror = () => reject(new Error('load failed: ' + src));
        document.head.appendChild(s);
      });
      await loadScript('/meter-core.js');
      await loadScript('/meter-renderer.js');
      return {
        hasApi: Boolean(window.__AGContextMeter),
        buildId: window.__AGContextMeter?.buildId || '',
        timeOrigin: window.performance?.timeOrigin || 0,
        errors: window.__agBootErrors
      };
    })()`);

    assert.equal(boot.hasApi, true, `meter-renderer.js 启动失败: ${JSON.stringify(boot.errors)}`);
    await new Promise((r) => setTimeout(r, 260));

    return {
      cdp,
      browserPath,
      buildId: boot.buildId || buildMeta.embeddedBuildId,
      buildMeta,
      initialTimeOrigin: boot.timeOrigin,
      async close() {
        cdp.close();
        await cleanup();
      }
    };
  } catch (err) {
    await cleanup();
    throw err;
  }
}

export async function captureDualScreenshot(cdp, fileName, {
  outputDir = DEFAULT_OUTPUT_DIR,
  brainDir = DEFAULT_BRAIN_SCREENSHOT_DIR,
  clip = null
} = {}) {
  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(brainDir, { recursive: true });
  const params = { format: 'png' };
  if (clip) params.clip = clip;
  const shot = await cdp.send('Page.captureScreenshot', params);
  const buf = Buffer.from(shot.data, 'base64');
  const outPath = path.join(outputDir, fileName);
  const brainPath = path.join(brainDir, fileName);
  fs.writeFileSync(outPath, buf);
  fs.writeFileSync(brainPath, buf);
  return { outPath, brainPath, bytes: buf.length };
}

export function writeSwitchLogs(logData, {
  outputDir = DEFAULT_OUTPUT_DIR,
  baseName = 'stage1-switch-log'
} = {}) {
  fs.mkdirSync(outputDir, { recursive: true });
  const jsonPath = path.join(outputDir, `${baseName}.json`);
  const txtPath = path.join(outputDir, `${baseName}.txt`);
  fs.writeFileSync(jsonPath, JSON.stringify(logData, null, 2), 'utf8');
  const lines = [
    `buildId=${logData.buildId}`,
    `timestamp=${logData.timestamp}`,
    `rounds=${logData.rounds} transitions=${logData.transitions.length}`,
    `timeOriginInvariant=${logData.timeOriginInvariant} initialTimeOrigin=${logData.initialTimeOrigin}`,
    '---',
    ...logData.transitions.map(
      (t) =>
        `R${String(t.round).padStart(2, '0')} [${t.mode.padEnd(7)}] ${String(t.elapsedMs).padStart(3)}ms | right=${t.rightContentWidth}x${t.rightContentHeight} | host=${t.pluginWidth}x${t.pluginHeight} conn=${t.hostConnected} | retries=${t.retryCount} | plus=${t.plusVisible} | ok=${t.ok}`
    )
  ];
  fs.writeFileSync(txtPath, lines.join('\n') + '\n', 'utf8');
  return { jsonPath, txtPath };
}

export async function switchAuxFourState(cdp, mode) {
  return cdp.evaluate(`(() => {
    const api = window.__AGContextMeter;
    if (!api) throw new Error('__AGContextMeter unavailable');
    const t0 = performance.now();
    api.setDockPositionForTest?.('aux', { persist: false });
    if (typeof api.switchAuxMode === 'function') {
      api.switchAuxMode(${JSON.stringify(mode)}, { persist: false });
    } else if (${JSON.stringify(mode)} === 'tab') {
      api.setAuxCoexistMode?.('tab', { persist: false });
      api.setAuxViewTabForTest?.('plugin', { persist: false });
    } else if (${JSON.stringify(mode)} === 'plugin') {
      api.setAuxCoexistMode?.('split', { persist: false });
      api.setAuxViewTabForTest?.('plugin', { persist: false });
    } else if (${JSON.stringify(mode)} === 'both') {
      api.setAuxCoexistMode?.('split', { persist: false });
      api.setAuxViewTabForTest?.('both', { persist: false });
    } else if (${JSON.stringify(mode)} === 'browser') {
      api.setAuxCoexistMode?.('split', { persist: false });
      api.setAuxViewTabForTest?.('browser', { persist: false });
    }
    return { startedAt: t0 };
  })()`);
}

export async function sampleAuxState(cdp) {
  return cdp.evaluate(`(() => {
    const auxOuter = document.getElementById('aux-outer');
    const auxInner = document.getElementById('aux-inner');
    const sideBody = document.getElementById('host-side-panel-body');
    const browserPane = document.getElementById('host-browser-pane');
    const strip = document.getElementById('host-strip');
    const plusBtn = document.getElementById('host-plus-btn');
    const host = document.getElementById('ag-context-meter');
    const sr = host?.shadowRoot || null;

    const getBox = (el) => {
      if (!el || !el.isConnected) return { w: 0, h: 0, cw: 0, ch: 0, visible: false };
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      const visible =
        !el.hidden &&
        cs.display !== 'none' &&
        cs.visibility !== 'hidden' &&
        Number(cs.opacity) > 0 &&
        r.width > 0 &&
        r.height > 0;
      return {
        w: Math.round(r.width),
        h: Math.round(r.height),
        cw: Math.round(el.clientWidth || 0),
        ch: Math.round(el.clientHeight || 0),
        visible
      };
    };

    const hostBox = getBox(host);
    const bodyBox = getBox(sideBody);
    const auxBox = getBox(auxInner || auxOuter);
    const browserBox = getBox(browserPane);
    const plusBox = getBox(plusBtn);
    const stripBox = getBox(strip);

    let shadowHasContent = false;
    let shadowPanelWidth = 0;
    let shadowPanelHeight = 0;
    if (sr) {
      const visiblePanel = Array.from(
        sr.querySelectorAll('.panel, #panel, #panel-tokens, #panel-quota, .ag-om-aux-skeleton, .ag-om-aux-fallback, [data-om-self-heal-fallback], [data-om-content-root]')
      ).find((n) => {
        const cs = getComputedStyle(n);
        const r = n.getBoundingClientRect();
        return !n.hidden && cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0;
      });
      if (visiblePanel) {
        const r = visiblePanel.getBoundingClientRect();
        shadowPanelWidth = Math.round(r.width);
        shadowPanelHeight = Math.round(r.height);
        shadowHasContent = String(visiblePanel.textContent || '').trim().length > 0;
      }
    }

    const api = window.__AGContextMeter || {};
    const diagLog =
      (typeof api.getAuxSwitchDiagnostics === 'function' && api.getAuxSwitchDiagnostics()) ||
      (typeof api.getAuxSwitchLogForTest === 'function' && api.getAuxSwitchLogForTest()) ||
      (typeof api.getSelfHealStateForTest === 'function' && api.getSelfHealStateForTest()) ||
      null;
    const switchLogs = typeof api.getAuxSwitchLogs === 'function' ? api.getAuxSwitchLogs() : null;
    const mountHealth = typeof api.inspectAuxMountHealth === 'function' ? api.inspectAuxMountHealth() : null;

    return {
      timeOrigin: window.performance?.timeOrigin || 0,
      hostConnected: Boolean(host && host.isConnected),
      hostBox,
      bodyBox,
      auxBox,
      browserBox,
      stripBox,
      plusVisible: plusBox.visible,
      plusConnected: Boolean(plusBtn && plusBtn.isConnected),
      shadowHasContent,
      shadowPanelWidth,
      shadowPanelHeight,
      auxCoexistMode: api.getAuxCoexistMode?.() || null,
      auxState: api.getAuxDockStateForTest?.() || null,
      diagLog,
      switchLogsCount: Array.isArray(switchLogs) ? switchLogs.length : 0,
      lastSwitchLog: Array.isArray(switchLogs) && switchLogs.length > 0 ? switchLogs[switchLogs.length - 1] : null,
      mountHealth
    };
  })()`);
}

export async function waitUntilAuxModeHealthy(cdp, mode, timeoutMs = 300) {
  const started = Date.now();
  let lastSnap = null;
  while (Date.now() - started <= timeoutMs) {
    lastSnap = await sampleAuxState(cdp);
    const rightW = Math.max(lastSnap.bodyBox.cw, lastSnap.auxBox.cw);
    const rightH = Math.max(lastSnap.bodyBox.ch, lastSnap.auxBox.ch);
    const rightOk = rightW > 0 && rightH > 0;
    const pluginNeeded = mode !== 'browser';
    const browserNeeded = mode === 'browser' || mode === 'both';
    const pluginOk = !pluginNeeded || (lastSnap.hostConnected && lastSnap.hostBox.cw > 0 && lastSnap.hostBox.ch > 0 && lastSnap.shadowHasContent);
    const browserOk = !browserNeeded || (lastSnap.browserBox.cw > 0 && lastSnap.browserBox.ch > 0 && lastSnap.browserBox.visible);
    if (rightOk && pluginOk && browserOk) {
      return {
        ok: true,
        elapsedMs: Date.now() - started,
        snap: lastSnap
      };
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  return {
    ok: false,
    elapsedMs: Date.now() - started,
    snap: lastSnap
  };
}

export async function runStage1Verification(opts = {}) {
  const rounds = Number(opts.rounds) > 0 ? Number(opts.rounds) : 20;
  const outputDir = opts.outputDir || DEFAULT_OUTPUT_DIR;
  const brainDir = opts.brainDir || DEFAULT_BRAIN_SCREENSHOT_DIR;
  const captureShots = opts.captureScreenshots !== false;

  const session = await launchReworkBrowserSession({
    auxCoexistMode: 'tab',
    auxViewTab: 'plugin',
    width: 1440,
    height: 900
  });
  const { cdp, buildId, buildMeta, initialTimeOrigin } = session;

  const modes = ['plugin', 'both', 'browser', 'tab'];
  const transitions = [];
  const screenshots = [];
  let timeOriginInvariant = true;

  try {
    // 先分别截取四态基线截图（第 1 轮完成每态稳定后出图）
    for (let round = 1; round <= rounds; round++) {
      for (const mode of modes) {
        await switchAuxFourState(cdp, mode);
        const res = await waitUntilAuxModeHealthy(cdp, mode, 300);
        const snap = res.snap;
        if (snap.timeOrigin !== initialTimeOrigin) {
          timeOriginInvariant = false;
        }
        const retryCount =
          Number(
            snap.lastSwitchLog?.retryCount ??
              snap.lastSwitchLog?.retries ??
              snap.diagLog?.retryCount ??
              snap.diagLog?.lastRetryCount ??
              snap.diagLog?.retries ??
              0
          ) || 0;
        const entry = {
          round,
          mode,
          elapsedMs: res.elapsedMs,
          rightContentWidth: Math.max(snap.bodyBox.cw, snap.auxBox.cw),
          rightContentHeight: Math.max(snap.bodyBox.ch, snap.auxBox.ch),
          pluginWidth: snap.hostBox.cw,
          pluginHeight: snap.hostBox.ch,
          browserWidth: snap.browserBox.cw,
          browserHeight: snap.browserBox.ch,
          hostConnected: snap.hostConnected,
          shadowHasContent: snap.shadowHasContent,
          plusVisible: snap.plusVisible,
          retryCount,
          timeOrigin: snap.timeOrigin,
          ok: res.ok
        };
        transitions.push(entry);

        if (captureShots && round === 1) {
          const shotMeta = {
            plugin: ['stage1-01-single-plugin.png', '单插件态右侧渲染'],
            both: ['stage1-02-side-by-side.png', '并排态双栏共存'],
            browser: ['stage1-03-single-browser.png', '单浏览器态非黑屏'],
            tab: ['stage1-04-native-tab.png', '标签页态与加号常驻']
          }[mode];
          await new Promise((r) => setTimeout(r, 80));
          const saved = await captureDualScreenshot(cdp, shotMeta[0], { outputDir, brainDir });
          screenshots.push({ mode, label: shotMeta[1], ...saved });
        }
      }
    }

    const logData = {
      stage: 1,
      buildId,
      rendererSha256: buildMeta.sha256,
      timestamp: new Date().toISOString(),
      rounds,
      initialTimeOrigin,
      timeOriginInvariant,
      allHealthy: transitions.every((t) => t.ok),
      failedCount: transitions.filter((t) => !t.ok).length,
      maxElapsedMs: Math.max(0, ...transitions.map((t) => t.elapsedMs)),
      transitions
    };

    const logFiles = writeSwitchLogs(logData, { outputDir, baseName: 'stage1-switch-log' });

    // 额外采集 3 次自愈失败后的本地化兜底提示截图与诊断数据
    let fallbackEvidence = null;
    if (captureShots) {
      await switchAuxFourState(cdp, 'tab');
      await waitUntilAuxModeHealthy(cdp, 'tab', 400);
      await cdp.evaluate(`(() => {
        const st = document.createElement('style');
        st.id = 'verify-force-zero-host';
        st.textContent = '#ag-context-meter{width:0px!important;height:0px!important;min-width:0!important;min-height:0!important;overflow:hidden!important;}';
        document.head.appendChild(st);
        window.dispatchEvent(new Event('resize'));
      })()`);
      await new Promise((r) => setTimeout(r, 1100));
      fallbackEvidence = await cdp.evaluate(`(() => {
        const fh = document.querySelector('[data-om-aux-fallback-host]');
        const fb = fh?.shadowRoot?.querySelector('.om-fb-card, .ag-om-aux-fallback, [data-om-aux-fallback]');
        const btn = fh?.shadowRoot?.querySelector('[data-om-aux-retry-btn]');
        const shadowFb = document.getElementById('ag-context-meter')?.shadowRoot?.querySelector('#ag-om-aux-fallback');
        const shadowFbVisible = Boolean(shadowFb && !shadowFb.hidden && getComputedStyle(shadowFb).display !== 'none');
        return {
          diag: window.__AGContextMeter?.getAuxSwitchDiagnostics?.() || null,
          fallbackVisible: Boolean(fb && getComputedStyle(fb).display !== 'none'),
          shadowDuplicateVisible: shadowFbVisible,
          fallbackText: fb ? String(fb.textContent || '').replace(/\\s+/g, ' ').trim() : '',
          retryBtnText: btn ? String(btn.textContent || '').trim() : ''
        };
      })()`);
      const fbShot = await captureDualScreenshot(cdp, 'stage1-05-self-heal-fallback.png', { outputDir, brainDir });
      screenshots.push({ mode: 'fallback', label: '3次失败本地化重试兜底', ...fbShot });
      await cdp.evaluate(`document.getElementById('verify-force-zero-host')?.remove()`);
    }

    return {
      buildId,
      buildMeta,
      logData,
      logFiles,
      screenshots,
      fallbackEvidence
    };
  } finally {
    await session.close();
  }
}

export async function runStage2Verification(opts = {}) {
  const outputDir = opts.outputDir || DEFAULT_OUTPUT_DIR;
  const brainDir = opts.brainDir || DEFAULT_BRAIN_SCREENSHOT_DIR;
  const captureShots = opts.captureScreenshots !== false;

  const session = await launchReworkBrowserSession({
    auxCoexistMode: 'tab',
    auxViewTab: 'plugin',
    width: 1440,
    height: 900
  });
  const { cdp, buildId, buildMeta } = session;
  const screenshots = [];

  try {
    await waitUntilAuxModeHealthy(cdp, 'tab', 800);

    // 1. 头栏精简特写（含右侧顶栏与语言切换 / GitHub / 关闭 / 纯文字版本）
    if (captureShots) {
      const headerClip = await cdp.evaluate(`(() => {
        const auxOuter = document.getElementById('aux-outer');
        const r = auxOuter ? auxOuter.getBoundingClientRect() : { left: 740, top: 36, width: 700, height: 220 };
        return {
          x: Math.max(0, Math.round(r.left) - 8),
          y: Math.max(0, Math.round(r.top)),
          width: Math.min(1440 - Math.max(0, Math.round(r.left) - 8), Math.round(r.width) + 8),
          height: 210,
          scale: 2
        };
      })()`);
      const sHeader = await captureDualScreenshot(cdp, 'stage2-01-header-closeup.png', {
        outputDir,
        brainDir,
        clip: headerClip
      });
      screenshots.push({ mode: 'header-closeup', label: '头栏精简特写', ...sHeader });
    }

    // 2. 仅插件标签态（清空原生 Browser/Swarm 标签，只留插件标签 + 末尾加号）
    await cdp.evaluate(`(() => {
      window.__setNativeTabsForTest([]);
      window.__AGContextMeter?.tickForTest?.();
      window.__AGContextMeter?.setAuxCoexistMode?.('tab', { persist: false });
    })()`);
    await new Promise((r) => setTimeout(r, 150));
    const pluginOnlyPlusState = await cdp.evaluate(`(() => {
      const strip = document.getElementById('host-strip');
      const plus = document.getElementById('host-plus-btn');
      const cmTab = document.getElementById('ag-aux-native-tab-wrap');
      const pr = plus ? plus.getBoundingClientRect() : { width: 0, height: 0, left: 0 };
      const cr = cmTab ? cmTab.getBoundingClientRect() : { width: 0, height: 0, right: 0 };
      const pcs = plus ? getComputedStyle(plus) : null;
      return {
        stripConnected: Boolean(strip && strip.isConnected),
        plusConnected: Boolean(plus && plus.isConnected),
        plusVisible: Boolean(plus && pcs && pcs.display !== 'none' && pcs.visibility !== 'hidden' && pr.width > 0 && pr.height > 0),
        plusAfterPluginTab: pr.left >= cr.right - 2,
        plusRect: { left: Math.round(pr.left), top: Math.round(pr.top), w: Math.round(pr.width), h: Math.round(pr.height) }
      };
    })()`);
    if (captureShots) {
      const sPlus = await captureDualScreenshot(cdp, 'stage2-02-plugin-only-plus.png', { outputDir, brainDir });
      screenshots.push({ mode: 'plugin-only-plus', label: '仅插件标签加号常驻', ...sPlus });
    }

    // 点击加号应正常拉出原生浏览器
    await cdp.evaluate(`document.getElementById('host-plus-btn').click()`);
    await new Promise((r) => setTimeout(r, 120));
    const afterPlusClick = await cdp.evaluate(`({
      plusClickCount: window.__plusClickCount,
      nativeToolsOpened: window.__nativeToolsOpened,
      hasBrowserTab: Boolean(document.querySelector('button[data-tab-id="browser__main"]')),
      plusStillVisible: (() => {
        const p = document.getElementById('host-plus-btn');
        if (!p || !p.isConnected) return false;
        const r = p.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      })()
    })`);

    // 3. 并排态（带互换按钮与唯一入口）
    await cdp.evaluate(`(() => {
      window.__setNativeTabsForTest(['browser', 'swarm']);
      window.__AGContextMeter?.setAuxCoexistMode?.('split', { persist: false });
      window.__AGContextMeter?.setAuxViewTabForTest?.('both', { persist: false });
    })()`);
    await new Promise((r) => setTimeout(r, 180));
    if (captureShots) {
      const sSplit = await captureDualScreenshot(cdp, 'stage2-03-split-with-swap.png', { outputDir, brainDir });
      screenshots.push({ mode: 'split-with-swap', label: '并排唯一入口与互换', ...sSplit });
    }

    return {
      buildId,
      buildMeta,
      pluginOnlyPlusState,
      afterPlusClick,
      screenshots
    };
  } finally {
    await session.close();
  }
}

export async function findMainCapsuleShadowInfo(cdp) {
  return cdp.evaluate(`(() => {
    const auxOuter = document.getElementById('aux-outer');
    const convHeader = document.querySelector('[data-testid="conversation-header"]');
    const openIdeBtn = convHeader?.querySelector('.native-open-ide-btn') || document.querySelector('.native-open-ide-btn');
    const capsuleHost =
      document.querySelector('[data-om-main-capsule-host]') ||
      document.querySelector('[data-om-capsule-host]') ||
      document.getElementById('ag-om-main-capsule-host') ||
      null;
    const auxHasCapsule = Boolean(
      auxOuter?.querySelector('[data-om-main-capsule-host], .ag-v2-mtb-root') ||
      document.getElementById('ag-context-meter')?.shadowRoot?.querySelector('.ag-v2-mtb-root:not([hidden])')
    );
    const sr = capsuleHost?.shadowRoot || null;
    const root = sr?.querySelector('.ag-v2-mtb-root') || capsuleHost?.querySelector?.('.ag-v2-mtb-root') || null;
    const handle = sr?.querySelector('[data-om-capsule-handle], .ag-om-capsule-handle, .ag-v2-mtb-handle, button[data-role="capsule-handle"]') || null;
    const rectOf = (el) => {
      if (!el || !el.isConnected) return null;
      const r = el.getBoundingClientRect();
      return {
        left: Math.round(r.left),
        right: Math.round(r.right),
        top: Math.round(r.top),
        bottom: Math.round(r.bottom),
        width: Math.round(r.width),
        height: Math.round(r.height)
      };
    };
    const isVis = (el) => {
      if (!el || !el.isConnected || el.hidden) return false;
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0 && r.width > 0 && r.height > 0;
    };
    return {
      hasCapsuleHost: Boolean(capsuleHost && capsuleHost.isConnected),
      inConvHeader: Boolean(capsuleHost && convHeader && convHeader.contains(capsuleHost)),
      auxHasCapsule,
      capsuleRect: rectOf(capsuleHost),
      rootRect: rectOf(root),
      rootVisible: isVis(root),
      handleVisible: isVis(handle),
      handleRect: rectOf(handle),
      openIdeRect: rectOf(openIdeBtn),
      convHeaderRect: rectOf(convHeader),
      widthTier: capsuleHost?.getAttribute('data-om-width-tier') || root?.getAttribute('data-width-tier') || root?.getAttribute('data-om-width-tier') || '',
      retracted: capsuleHost?.getAttribute('data-om-retracted') === 'true' || root?.getAttribute('data-retracted') === 'true' || root?.getAttribute('data-om-retracted') === 'true',
      visibleSlots: sr
        ? Array.from(sr.querySelectorAll('[data-slot], #ag-v2-mtb-quota-ring, #ag-v2-mtb-context-ring, #ag-v2-mtb-group-ttft, #ag-v2-mtb-group-stats, #ag-v2-mtb-cli'))
            .filter(isVis)
            .map((el) => el.getAttribute('data-slot') || el.id)
        : []
    };
  })()`);
}

export async function runStage3Verification(opts = {}) {
  const outputDir = opts.outputDir || DEFAULT_OUTPUT_DIR;
  const brainDir = opts.brainDir || DEFAULT_BRAIN_SCREENSHOT_DIR;
  const captureShots = opts.captureScreenshots !== false;

  const session = await launchReworkBrowserSession({
    auxCoexistMode: 'tab',
    auxViewTab: 'browser',
    width: 1680,
    height: 900,
    auxWidthPx: 320
  });
  const { cdp, buildId, buildMeta } = session;
  const screenshots = [];

  try {
    // 1. 规则一：辅助栏仅开浏览器且未开插件，主会话 >= 1100px -> 胶囊常驻完整形态
    await cdp.evaluate(`(() => {
      window.__AGContextMeter?.switchAuxMode?.('browser', { persist: false });
      window.__setMainSessionWidthForTest(1160);
    })()`);
    await new Promise((r) => setTimeout(r, 260));
    const fullState = await findMainCapsuleShadowInfo(cdp);
    if (captureShots) {
      const s1 = await captureDualScreenshot(cdp, 'stage3-01-capsule-full.png', { outputDir, brainDir });
      screenshots.push({ mode: 'capsule-full', label: '主窗五槽胶囊完整形态', ...s1 });
    }

    // 2. 槽位 3 原位横向展开形态
    await cdp.evaluate(`(() => {
      const h = document.querySelector('[data-om-main-capsule-host]') || document.querySelector('[data-om-capsule-host]');
      const sr = h?.shadowRoot;
      const g = sr?.getElementById('ag-v2-mtb-group-ttft') || sr?.querySelector('[data-group="ttft-group"]');
      const activeBtn = g?.querySelector('button[data-active="true"], button[data-group-item="ttft-group"]');
      if (activeBtn) activeBtn.click();
    })()`);
    await new Promise((r) => setTimeout(r, 260));
    if (captureShots) {
      const s3 = await captureDualScreenshot(cdp, 'stage3-03-slot3-expanded.png', { outputDir, brainDir });
      screenshots.push({ mode: 'slot3-expanded', label: '槽3原位横向展开态', ...s3 });
    }
    // 按 Esc 收起
    await cdp.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await new Promise((r) => setTimeout(r, 240));

    // 3. 规则二：辅助栏打开 ContextMeter 插件 -> 胶囊平滑缩进右缘仅留极简呼出把手
    await cdp.evaluate(`(() => {
      window.__setMainSessionWidthForTest(null);
      window.__AGContextMeter?.switchAuxMode?.('tab', { persist: false });
    })()`);
    await new Promise((r) => setTimeout(r, 280));
    const tuckedState = await findMainCapsuleShadowInfo(cdp);
    if (captureShots) {
      const s2 = await captureDualScreenshot(cdp, 'stage3-02-capsule-tucked-handle.png', { outputDir, brainDir });
      screenshots.push({ mode: 'capsule-tucked', label: '开插件缩进右缘把手态', ...s2 });
    }

    // 4. 规则三：窄宽度简化形态（< 760px，如 680px，仅留额度圆环与 CLI）
    await cdp.evaluate(`(() => {
      window.__AGContextMeter?.switchAuxMode?.('browser', { persist: false });
      window.__setMainSessionWidthForTest(680);
    })()`);
    await new Promise((r) => setTimeout(r, 260));
    const narrowState = await findMainCapsuleShadowInfo(cdp);
    if (captureShots) {
      const s4 = await captureDualScreenshot(cdp, 'stage3-04-narrow-simplified.png', { outputDir, brainDir });
      screenshots.push({ mode: 'narrow-simplified', label: '窄宽度简化二槽形态', ...s4 });
    }

    return {
      buildId,
      buildMeta,
      fullState,
      tuckedState,
      narrowState,
      screenshots
    };
  } finally {
    await session.close();
  }
}

export async function seedRichSessionForStage4(cdp) {
  return cdp.evaluate(`(() => {
    const api = window.__AGContextMeter;
    if (!api?.seedSessionSnapshotForTest) return false;
    const now = Date.now();
    const calls = [
      {
        callId: 'c-1',
        turnIndex: 1,
        stepIndex: 1,
        startedAtMs: now - 120000,
        endedAtMs: now - 116200,
        durationMs: 3800,
        ttftMs: 420,
        tps: 68.4,
        model: 'claude-sonnet-4-5',
        inputTokens: 42000,
        outputTokens: 640,
        cacheTokens: 36000,
        cacheReadTokens: 36000,
        contextTokens: 42000,
        isPriced: true,
        costUSD: 0.042,
        status: 'completed',
        userSummary: '检查右侧内容区空白自愈与四态切换',
        assistantSummary: '已定位挂载根脱离与 0x0 塌陷原因并准备修复',
        toolCalls: [
          { name: 'read_file', count: 3, durationMs: 180, target: 'src/renderer/main.js', args: '{"path":"src/renderer/main.js"}', output: 'ok' },
          { name: 'run_command', count: 1, durationMs: 620, command: 'npm run build:renderer', program: 'npm', exitCode: 0 }
        ],
        fileActivities: [
          { path: 'src/renderer/main.js', action: 'read', added: 0, deleted: 0 },
          { path: 'src/renderer/aux-quick-switch.js', action: 'write', added: 48, deleted: 12 }
        ]
      },
      {
        callId: 'c-2',
        turnIndex: 2,
        stepIndex: 2,
        startedAtMs: now - 85000,
        endedAtMs: now - 79800,
        durationMs: 5200,
        ttftMs: 390,
        tps: 74.2,
        model: 'claude-sonnet-4-5',
        inputTokens: 86500,
        outputTokens: 1180,
        cacheTokens: 78200,
        cacheReadTokens: 78200,
        contextTokens: 86500,
        isPriced: true,
        costUSD: 0.068,
        status: 'completed',
        userSummary: '运行隔离真 Chromium 验收脚本并核验截图',
        assistantSummary: '四态 20 轮切换 80/80 通过，最大耗时 12ms',
        toolCalls: [
          { name: 'edit_file', count: 2, durationMs: 140, target: 'src/renderer/styles.css', args: '{"path":"src/renderer/styles.css"}', output: 'updated' },
          { name: 'run_command', count: 1, durationMs: 1420, command: 'node --test meter-rework-v3.test.js', program: 'node', exitCode: 0 }
        ],
        fileActivities: [
          { path: 'src/renderer/styles.css', action: 'write', added: 26, deleted: 6 },
          { path: 'meter-rework-v3.test.js', action: 'search', added: 0, deleted: 0 }
        ]
      },
      {
        callId: 'c-3',
        turnIndex: 3,
        stepIndex: 3,
        startedAtMs: now - 35000,
        endedAtMs: now - 30900,
        durationMs: 4100,
        ttftMs: 350,
        tps: 81.5,
        model: 'claude-sonnet-4-5',
        inputTokens: 125300,
        outputTokens: 1520,
        cacheTokens: 112000,
        cacheReadTokens: 112000,
        contextTokens: 125300,
        isPriced: true,
        costUSD: 0.089,
        status: 'completed',
        userSummary: '确认会话内四视角切换与数据绑定',
        assistantSummary: '轨迹、上下文与编队视图已挂载至独立滚动容器',
        toolCalls: [
          { name: 'read_file', count: 2, durationMs: 110, target: 'src/renderer/execution-trace.js', args: '{"path":"src/renderer/execution-trace.js"}', output: 'ok' },
          { name: 'run_command', count: 1, durationMs: 890, command: 'git status --short', program: 'git', exitCode: 0 }
        ],
        fileActivities: [
          { path: 'src/renderer/execution-trace.js', action: 'read', added: 0, deleted: 0 },
          { path: 'src/renderer/context-inspector.js', action: 'write', added: 112, deleted: 18 }
        ]
      }
    ];
    api.seedSessionSnapshotForTest(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      {
        latest: {
          cascadeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          title: 'Replying With Ok',
          model: 'claude-sonnet-4-5',
          contextUsed: 125300,
          contextLimit: 1000000,
          inputTokens: 125300,
          outputTokens: 3340,
          cacheReadTokens: 112000,
          turns: 3,
          steps: 3
        },
        sessionStats: {
          turns: 3,
          steps: 3,
          skillLoads: 2,
          modelReplies: 3,
          totalInputTokens: 253800,
          totalOutputTokens: 3340,
          totalCacheReadTokens: 226200,
          toolCallCount: 10,
          commandCount: 3,
          subAgentCount: 0
        },
        sessionCalls: calls,
        allTurns: calls
      },
      { applyToActiveState: true }
    );
    api.tickForTest?.();
    return true;
  })()`);
}

export async function runStage4Verification(opts = {}) {
  const outputDir = opts.outputDir || DEFAULT_OUTPUT_DIR;
  const brainDir = opts.brainDir || DEFAULT_BRAIN_SCREENSHOT_DIR;
  const captureShots = opts.captureScreenshots !== false;

  const session = await launchReworkBrowserSession({
    auxCoexistMode: 'tab',
    auxViewTab: 'browser',
    width: 1560,
    height: 920,
    auxWidthPx: 360
  });
  const { cdp, buildId, buildMeta } = session;
  const screenshots = [];

  try {
    await cdp.evaluate(`window.__AGContextMeter?.switchAuxMode?.('browser', { persist: false })`);
    await seedRichSessionForStage4(cdp);
    await new Promise((r) => setTimeout(r, 240));

    const tabsSpec = [
      ['chat', 'stage4-01-tab-chat.png', '会话内四视角对话态'],
      ['trace', 'stage4-02-tab-trace.png', '会话内轨迹视图态'],
      ['context', 'stage4-03-tab-context.png', '会话内上下文五行业务'],
      ['collab', 'stage4-04-tab-collab.png', '会话内编队真实空态']
    ];
    const tabStates = {};

    for (const [tabKey, fileName, label] of tabsSpec) {
      await cdp.evaluate(`(() => {
        if (typeof window.__AGContextMeter?.switchSessionViewTab === 'function') {
          window.__AGContextMeter.switchSessionViewTab(${JSON.stringify(tabKey)});
        } else {
          const bar = document.querySelector('[data-om-session-tabs]');
          const root = bar?.shadowRoot || bar;
          const btn = root?.querySelector('[data-om-tab="' + ${JSON.stringify(tabKey)} + '"], [data-tab="' + ${JSON.stringify(tabKey)} + '"], button[data-view="' + ${JSON.stringify(tabKey)} + '"]');
          btn?.click();
        }
      })()`);
      await new Promise((r) => setTimeout(r, 220));
      tabStates[tabKey] = await cdp.evaluate(`(() => {
        const bar = document.querySelector('[data-om-session-tabs]');
        const viewEl = document.querySelector('[data-om-session-view="' + ${JSON.stringify(tabKey)} + '"]');
        const viewRoot = viewEl?.shadowRoot || viewEl;
        const rect = viewEl ? viewEl.getBoundingClientRect() : null;
        return {
          hasBar: Boolean(bar && bar.isConnected),
          activeTab: bar?.getAttribute('data-om-active-tab') || window.__AGContextMeter?.getSessionFourViewsState?.()?.activeTab || '',
          viewPresent: Boolean(viewEl && viewEl.isConnected && !viewEl.hidden),
          viewWidth: rect ? Math.round(rect.width) : 0,
          viewHeight: rect ? Math.round(rect.height) : 0,
          textLen: viewRoot ? String(viewRoot.textContent || '').trim().length : 0
        };
      })()`);
      if (captureShots) {
        const saved = await captureDualScreenshot(cdp, fileName, { outputDir, brainDir });
        screenshots.push({ mode: tabKey, label, ...saved });
      }
    }

    return {
      buildId,
      buildMeta,
      tabStates,
      screenshots
    };
  } finally {
    await session.close();
  }
}

export async function openDetailedContextFullpage(cdp) {
  return cdp.evaluate(`(async () => {
    const api = window.__AGContextMeter;
    if (typeof api?.openDetailedContextView === 'function') {
      api.openDetailedContextView();
    } else {
      const btn = document.querySelector('[data-testid="ag-detailed-context-nav"], #ag-sidebar-detailed-context-btn');
      btn?.click();
    }
    await new Promise((r) => setTimeout(r, 260));
    const page = document.getElementById('ag-context-insights-page') || document.querySelector('[data-om-detailed-context-page]');
    return { opened: Boolean(page && page.isConnected && !page.hidden) };
  })()`);
}

export async function runStage5Verification(opts = {}) {
  const outputDir = opts.outputDir || DEFAULT_OUTPUT_DIR;
  const brainDir = opts.brainDir || DEFAULT_BRAIN_SCREENSHOT_DIR;
  const captureShots = opts.captureScreenshots !== false;

  const session = await launchReworkBrowserSession({
    auxCoexistMode: 'split',
    auxViewTab: 'both',
    width: 1680,
    height: 940,
    auxWidthPx: 520,
    auxPluginSharePx: 260
  });
  const { cdp, buildId, buildMeta } = session;
  const screenshots = [];

  try {
    await waitUntilAuxModeHealthy(cdp, 'both', 1000);
    await openDetailedContextFullpage(cdp);
    await new Promise((r) => setTimeout(r, 300));

    const topAudit = await cdp.evaluate(`(() => {
      const page = document.getElementById('ag-context-insights-page') || document.querySelector('[data-om-detailed-context-page]');
      const slot = document.getElementById('left-session-slot');
      const root = page?.shadowRoot || page;
      const pr = page?.getBoundingClientRect();
      const sr = slot?.getBoundingClientRect();
      const cs = page ? getComputedStyle(page) : null;
      return {
        opened: Boolean(page && page.isConnected && !page.hidden),
        pageRect: pr ? { left: Math.round(pr.left), right: Math.round(pr.right), width: Math.round(pr.width), height: Math.round(pr.height) } : null,
        slotRect: sr ? { left: Math.round(sr.left), right: Math.round(sr.right), width: Math.round(sr.width), height: Math.round(sr.height) } : null,
        bgColor: cs ? cs.backgroundColor : '',
        rankFillsCount: root ? root.querySelectorAll('.ag-ci-rank-fill').length : 0,
        heatCellsCount: root ? root.querySelectorAll('.ag-ci-heat-cell').length : 0
      };
    })()`);

    if (captureShots) {
      const s1 = await captureDualScreenshot(cdp, 'stage5-01-detailed-context-top.png', { outputDir, brainDir });
      screenshots.push({ mode: 'detailed-context-top', label: '详细上下文总览与并排不裁切', ...s1 });
    }

    // 向下滚动展示四列排行与会话网格卡，并打开左下角账号上拉菜单验证浮于最上层
    await cdp.evaluate(`(async () => {
      const page = document.getElementById('ag-context-insights-page') || document.querySelector('[data-om-detailed-context-page]');
      if (page) page.scrollTop = 480;
      const scroller = page?.shadowRoot?.querySelector('.ag-ci-shell, [data-om-scroll-root]') || page?.querySelector?.('.ag-ci-shell');
      if (scroller && scroller.scrollHeight > scroller.clientHeight) scroller.scrollTop = 480;
      await new Promise((r) => setTimeout(r, 120));
      const acctBtn = document.getElementById('host-account-pill') || document.querySelector('[data-testid="sidebar-account-button"]');
      acctBtn?.click();
      await new Promise((r) => setTimeout(r, 180));
    })()`);

    if (captureShots) {
      const s2 = await captureDualScreenshot(cdp, 'stage5-02-detailed-context-cards-account-menu.png', { outputDir, brainDir });
      screenshots.push({ mode: 'detailed-context-cards-menu', label: '会话网格卡与账号菜单置顶', ...s2 });
    }

    return {
      buildId,
      buildMeta,
      topAudit,
      screenshots
    };
  } finally {
    await session.close();
  }
}

export async function openProfileHomeFullpage(cdp) {
  return cdp.evaluate(`(async () => {
    const api = window.__AGContextMeter;
    if (typeof api?.openPersonalProfileHome === 'function') {
      api.openPersonalProfileHome();
    } else {
      const h = document.querySelector('[data-om-main-capsule-host]');
      const sr = h?.shadowRoot;
      const statsBtn = sr?.getElementById('ag-v2-mtb-tool-stats-bars') || sr?.querySelector('[data-group="stats-group"] button[data-group-item="stats-group"]');
      statsBtn?.click();
    }
    await new Promise((r) => setTimeout(r, 260));
    const page = document.getElementById('ag-profile-home-page') || document.querySelector('[data-om-profile-home-page]');
    return { opened: Boolean(page && page.isConnected && !page.hidden) };
  })()`);
}

export async function runStage6Verification(opts = {}) {
  const outputDir = opts.outputDir || DEFAULT_OUTPUT_DIR;
  const brainDir = opts.brainDir || DEFAULT_BRAIN_SCREENSHOT_DIR;
  const captureShots = opts.captureScreenshots !== false;

  const session = await launchReworkBrowserSession({
    auxCoexistMode: 'tab',
    auxViewTab: 'browser',
    width: 1560,
    height: 940,
    auxWidthPx: 320
  });
  const { cdp, buildId, buildMeta } = session;
  const screenshots = [];

  try {
    await cdp.evaluate(`window.__AGContextMeter?.switchAuxMode?.('browser', { persist: false })`);
    const openRes = await openProfileHomeFullpage(cdp);
    await new Promise((r) => setTimeout(r, 260));

    const topAudit = await cdp.evaluate(`(() => {
      const page = document.getElementById('ag-profile-home-page') || document.querySelector('[data-om-profile-home-page]');
      const root = page?.shadowRoot || page;
      const cells = root ? Array.from(root.querySelectorAll('[data-om-hm-cell="true"]')) : [];
      return {
        opened: Boolean(page && page.isConnected && !page.hidden),
        cellCount: cells.length,
        firstDate: cells[0]?.getAttribute('data-date') || '',
        lastDate: cells[cells.length - 1]?.getAttribute('data-date') || ''
      };
    })()`);

    if (captureShots) {
      const s1 = await captureDualScreenshot(cdp, 'stage6-01-profile-home-top.png', { outputDir, brainDir });
      screenshots.push({ mode: 'profile-home-top', label: '个人主页首屏KPI与缓存', ...s1 });
    }

    // 滚动到热力图 + 点击今日格展开当日明细 + 展示底部洞察列表
    const heatmapAudit = await cdp.evaluate(`(async () => {
      const page = document.getElementById('ag-profile-home-page') || document.querySelector('[data-om-profile-home-page]');
      const root = page?.shadowRoot || page;
      const hm = root?.querySelector('[data-om-hm-cell="true"]')?.closest('section, .ag-ph-card, [data-om-profile-section]') || root?.querySelector('[data-om-hm-cell="true"]');
      hm?.scrollIntoView?.({ block: 'start' });
      await new Promise((r) => setTimeout(r, 120));
      const cells = root ? Array.from(root.querySelectorAll('[data-om-hm-cell="true"]')) : [];
      const lastCell = cells[cells.length - 1];
      lastCell?.click();
      await new Promise((r) => setTimeout(r, 160));
      const detail = root?.querySelector('[data-om-hm-day-detail]');
      return {
        selected: lastCell?.getAttribute('data-selected') === 'true',
        detailVisible: Boolean(detail && !detail.hidden && getComputedStyle(detail).display !== 'none'),
        detailText: detail ? String(detail.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 160) : ''
      };
    })()`);

    if (captureShots) {
      const s2 = await captureDualScreenshot(cdp, 'stage6-02-profile-heatmap-selected.png', { outputDir, brainDir });
      screenshots.push({ mode: 'profile-heatmap-selected', label: '左起热力图选中明细与洞察', ...s2 });
    }

    return {
      buildId,
      buildMeta,
      openRes,
      topAudit,
      heatmapAudit,
      screenshots
    };
  } finally {
    await session.close();
  }
}

export async function runStage7Verification(opts = {}) {
  const outputDir = opts.outputDir || DEFAULT_OUTPUT_DIR;
  const brainDir = opts.brainDir || DEFAULT_BRAIN_SCREENSHOT_DIR;
  const captureShots = opts.captureScreenshots !== false;

  const session = await launchReworkBrowserSession({
    auxCoexistMode: 'tab',
    auxViewTab: 'browser',
    width: 1560,
    height: 920,
    auxWidthPx: 320
  });
  const { cdp, buildId, buildMeta } = session;
  const screenshots = [];

  try {
    await cdp.evaluate(`window.__AGContextMeter?.switchAuxMode?.('browser', { persist: false })`);
    await new Promise((r) => setTimeout(r, 200));

    // 1. 账号与额度页（全简体、无英文残留、无硬编码紫）
    await cdp.evaluate(`(async () => {
      window.__toggleHostSettingsModal(true);
      await new Promise((r) => setTimeout(r, 150));
      const accNav = document.getElementById('ag-cm-host-settings-accounts-nav') || document.getElementById('ag-cm-host-settings-nav');
      accNav?.click();
      await new Promise((r) => setTimeout(r, 200));
    })()`);
    if (captureShots) {
      const s1 = await captureDualScreenshot(cdp, 'stage7-01-accounts-zh-accent.png', { outputDir, brainDir });
      screenshots.push({ mode: 'accounts-zh-accent', label: '账号页全简体与宿主强调色', ...s1 });
    }
    await cdp.evaluate(`window.__toggleHostSettingsModal(false)`);
    await new Promise((r) => setTimeout(r, 120));

    // 2. 悬浮球全页避让验证（打开详细上下文时悬浮球隐藏不压 KPI/热力图）
    await openDetailedContextFullpage(cdp);
    await new Promise((r) => setTimeout(r, 220));
    const orbAvoidAudit = await cdp.evaluate(`(() => {
      const orbHost = document.getElementById('ag-radial-top-layer') || document.querySelector('[data-ag-radial-orb], #ag-radial-orb-host');
      const orbBtn = orbHost?.shadowRoot?.querySelector('#radial-orb-btn, .radial-orb-btn, button') || document.getElementById('ag-context-meter')?.shadowRoot?.getElementById('radial-orb-btn');
      const visible = (el) => {
        if (!el || !el.isConnected || el.hidden) return false;
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0.05 && r.width > 0 && r.height > 0;
      };
      return {
        orbVisibleOnDetailedContext: visible(orbBtn)
      };
    })()`);
    if (captureShots) {
      const s2 = await captureDualScreenshot(cdp, 'stage7-02-orb-avoidance-and-restore.png', { outputDir, brainDir });
      screenshots.push({ mode: 'orb-avoidance', label: '详细上下文悬浮球避让态', ...s2 });
    }

    return {
      buildId,
      buildMeta,
      orbAvoidAudit,
      screenshots
    };
  } finally {
    await session.close();
  }
}

async function main() {
  const stageArg = process.argv.find((a) => a.startsWith('--stage=')) || '--stage=1';
  const stage = stageArg.split('=')[1] || '1';
  const buildMeta = getRendererBuildMeta();
  console.log(`[verify-rework-v3] production renderer: ${buildMeta.rendererPath}`);
  console.log(`[verify-rework-v3] embeddedBuildId=${buildMeta.embeddedBuildId} sha256=${buildMeta.sha256.slice(0, 16)} bytes=${buildMeta.bytes}`);

  if (stage === '1') {
    const result = await runStage1Verification({ rounds: 20, captureScreenshots: true });
    console.log(`[stage1] buildId=${result.buildId}`);
    console.log(
      `[stage1] transitions=${result.logData.transitions.length} failed=${result.logData.failedCount} maxElapsedMs=${result.logData.maxElapsedMs} timeOriginInvariant=${result.logData.timeOriginInvariant}`
    );
    if (result.fallbackEvidence) {
      console.log(`[stage1] fallbackEvidence=${JSON.stringify(result.fallbackEvidence)}`);
    }
    console.log(`[stage1] switchLogJson=${result.logFiles.jsonPath}`);
    console.log(`[stage1] switchLogTxt=${result.logFiles.txtPath}`);
    for (const s of result.screenshots) {
      console.log(`Screenshot: ${s.brainPath} | ${s.label}`);
      console.log(`[export] ${s.outPath} (${s.bytes} bytes)`);
    }
    if (!result.logData.allHealthy || !result.logData.timeOriginInvariant) {
      process.exitCode = 1;
    }
  } else if (stage === '2') {
    const result = await runStage2Verification({ captureScreenshots: true });
    console.log(`[stage2] buildId=${result.buildId}`);
    console.log(`[stage2] pluginOnlyPlusState=${JSON.stringify(result.pluginOnlyPlusState)}`);
    console.log(`[stage2] afterPlusClick=${JSON.stringify(result.afterPlusClick)}`);
    for (const s of result.screenshots) {
      console.log(`Screenshot: ${s.brainPath} | ${s.label}`);
      console.log(`[export] ${s.outPath} (${s.bytes} bytes)`);
    }
    if (!result.pluginOnlyPlusState.plusVisible || !result.afterPlusClick.hasBrowserTab || !result.afterPlusClick.plusStillVisible) {
      process.exitCode = 1;
    }
  } else if (stage === '3') {
    const result = await runStage3Verification({ captureScreenshots: true });
    console.log(`[stage3] buildId=${result.buildId}`);
    console.log(`[stage3] fullState=${JSON.stringify(result.fullState)}`);
    console.log(`[stage3] tuckedState=${JSON.stringify(result.tuckedState)}`);
    console.log(`[stage3] narrowState=${JSON.stringify(result.narrowState)}`);
    for (const s of result.screenshots) {
      console.log(`Screenshot: ${s.brainPath} | ${s.label}`);
      console.log(`[export] ${s.outPath} (${s.bytes} bytes)`);
    }
    if (!result.fullState.hasCapsuleHost || result.fullState.auxHasCapsule) {
      process.exitCode = 1;
    }
  } else if (stage === '4') {
    const result = await runStage4Verification({ captureScreenshots: true });
    console.log(`[stage4] buildId=${result.buildId}`);
    console.log(`[stage4] tabStates=${JSON.stringify(result.tabStates)}`);
    for (const s of result.screenshots) {
      console.log(`Screenshot: ${s.brainPath} | ${s.label}`);
      console.log(`[export] ${s.outPath} (${s.bytes} bytes)`);
    }
    if (!result.tabStates.chat?.hasBar || !result.tabStates.trace?.viewPresent || !result.tabStates.context?.viewPresent || !result.tabStates.collab?.viewPresent) {
      process.exitCode = 1;
    }
  } else if (stage === '5') {
    const result = await runStage5Verification({ captureScreenshots: true });
    console.log(`[stage5] buildId=${result.buildId}`);
    console.log(`[stage5] topAudit=${JSON.stringify(result.topAudit)}`);
    for (const s of result.screenshots) {
      console.log(`Screenshot: ${s.brainPath} | ${s.label}`);
      console.log(`[export] ${s.outPath} (${s.bytes} bytes)`);
    }
    if (!result.topAudit.opened) {
      process.exitCode = 1;
    }
  } else if (stage === '6') {
    const result = await runStage6Verification({ captureScreenshots: true });
    console.log(`[stage6] buildId=${result.buildId}`);
    console.log(`[stage6] topAudit=${JSON.stringify(result.topAudit)}`);
    console.log(`[stage6] heatmapAudit=${JSON.stringify(result.heatmapAudit)}`);
    for (const s of result.screenshots) {
      console.log(`Screenshot: ${s.brainPath} | ${s.label}`);
      console.log(`[export] ${s.outPath} (${s.bytes} bytes)`);
    }
    if (!result.topAudit.opened || !result.heatmapAudit.selected || !result.heatmapAudit.detailVisible) {
      process.exitCode = 1;
    }
  } else if (stage === '7') {
    const result = await runStage7Verification({ captureScreenshots: true });
    console.log(`[stage7] buildId=${result.buildId}`);
    console.log(`[stage7] orbAvoidAudit=${JSON.stringify(result.orbAvoidAudit)}`);
    for (const s of result.screenshots) {
      console.log(`Screenshot: ${s.brainPath} | ${s.label}`);
      console.log(`[export] ${s.outPath} (${s.bytes} bytes)`);
    }
    if (result.orbAvoidAudit.orbVisibleOnDetailedContext) {
      process.exitCode = 1;
    }
  } else if (stage === 'all') {
    const allResults = {};
    const allShots = [];
    const runners = [
      ['stage1', () => runStage1Verification({ rounds: 20, captureScreenshots: true })],
      ['stage2', () => runStage2Verification({ captureScreenshots: true })],
      ['stage3', () => runStage3Verification({ captureScreenshots: true })],
      ['stage4', () => runStage4Verification({ captureScreenshots: true })],
      ['stage5', () => runStage5Verification({ captureScreenshots: true })],
      ['stage6', () => runStage6Verification({ captureScreenshots: true })],
      ['stage7', () => runStage7Verification({ captureScreenshots: true })]
    ];
    for (const [name, fn] of runners) {
      const r = await fn();
      allResults[name] = { buildId: r.buildId, screenshots: (r.screenshots || []).map((s) => s.outPath) };
      for (const s of r.screenshots || []) {
        allShots.push(s);
        console.log(`Screenshot: ${s.brainPath} | ${s.label}`);
        console.log(`[export] ${s.outPath} (${s.bytes} bytes)`);
      }
    }
    const manifestPath = path.join(DEFAULT_OUTPUT_DIR, 'final-stage8-manifest.json');
    fs.writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          timestamp: new Date().toISOString(),
          rendererPath: buildMeta.rendererPath,
          embeddedBuildId: buildMeta.embeddedBuildId,
          sha256: buildMeta.sha256,
          bytes: buildMeta.bytes,
          screenshotCount: allShots.length,
          stages: allResults
        },
        null,
        2
      ),
      'utf8'
    );
    console.log(`[stage8-all] buildId=${buildMeta.embeddedBuildId} screenshots=${allShots.length} manifest=${manifestPath}`);
  } else {
    console.error(`Unsupported stage: ${stage}`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
