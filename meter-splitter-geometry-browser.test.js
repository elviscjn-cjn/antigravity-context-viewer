'use strict';

/**
 * 真实 Chromium Headless DOM 分隔线几何与零回弹专项验收测试
 * 覆盖：
 * 1. 单线唯一性校验（每处交界 ±24px 仅 1 根视觉竖线 + 1 个 col-resize 热区，并排=2、单插件=1、单浏览器=1）
 * 2. plugin-first（Grid 多子与 Flex 单子双路径）中右竖线双向 1:1 跟手拖拽（dx=-100 / dx=+100）与左会话零牵动（0px）
 * 3. browser-first 换位后中右竖线双向 1:1 跟手拖拽（dx=-100 / dx=+100）与左会话零牵动（0px）
 * 4. 左边界唯一竖线连续向左/向右双向拉伸 1:1 生效
 * 5. 松手防回弹校验（>= 1250ms 真实等待 + MutationObserver + ResizeObserver + 500ms tick + 滑出窗口 blur 提交 + 过期设置回包防倒灌）
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

function findBrowserExecutable() {
  const candidates = [
    process.env.AG_CM_TEST_BROWSER,
    process.env.AG_TEST_BROWSER_PATH,
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

class CdpClient {
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
      const desc = res.exceptionDetails.exception?.description || res.exceptionDetails.text || JSON.stringify(res.exceptionDetails);
      throw new Error(`Page eval error: ${desc}`);
    }
    return res?.result?.value;
  }

  close() {
    try { this.ws.close(); } catch { }
  }
}

function createTriPaneFixtureHtml({ singleHostChild = false } = {}) {
  const stripHtml = singleHostChild
    ? ''
    : '<div data-side-panel-strip="true" id="host-strip">v63_popup_04.png</div>';
  const nestedSashHtml = singleHostChild
    ? ''
    : '<div class="host-pane-nested-sash" id="host-pane-nested-sash"></div>';
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>Antigravity 2.35.2 Tri-Pane Splitter Geometry Fixture</title>
<style>
  :root {
    --background: #141414;
    --foreground: #f4f4f4;
    --border: rgba(255, 255, 255, 0.12);
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    padding: 0;
    width: 1440px;
    height: 900px;
    overflow: hidden;
    background: #141414;
    color: #f4f4f4;
    font-family: system-ui, -apple-system, sans-serif;
  }
  .ag-app-root {
    display: flex;
    flex-direction: column;
    width: 1440px;
    height: 900px;
    overflow: hidden;
  }
  [data-testid="title-menu-bar"] {
    position: relative;
    display: flex;
    align-items: center;
    height: 32px;
    flex: 0 0 32px;
    background: #181818;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    padding: 0 12px;
  }
  .workspace-row {
    display: flex;
    flex-direction: row;
    flex: 1 1 auto;
    width: 1440px;
    height: 868px;
    overflow: hidden;
    position: relative;
  }
  .left-session-slot {
    flex: 1 1 auto;
    min-width: 200px;
    height: 100%;
    display: flex;
    flex-direction: column;
    background: #151515;
    position: relative;
  }
  [data-testid="conversation-view"] {
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    padding: 12px;
  }
  .surface-composer {
    height: 64px;
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 10px;
    padding: 8px;
  }
  /* 模拟宿主原生外左分隔条（位于左侧会话与右侧栏之间） */
  .host-outer-sash {
    flex: 0 0 1px;
    width: 1px;
    height: 100%;
    background: rgba(255, 255, 255, 0.12);
    cursor: col-resize;
    position: relative;
    z-index: 25;
  }
  .host-outer-sash::before {
    content: "";
    position: absolute;
    inset: 0 -3px;
    cursor: col-resize;
  }
  /* 模拟宿主右侧辅助栏外框（自带 border-left 与原生内部拖条） */
  [data-side-panel-open="true"] {
    position: relative;
    flex: 0 0 800px;
    width: 800px;
    height: 100%;
    display: flex;
    flex-direction: row;
    border-left: 1px solid rgba(255, 255, 255, 0.14);
    background: #171717;
  }
  [data-side-panel-focus-scope="true"] {
    position: relative;
    flex: 1 1 auto;
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  /* 模拟宿主 auxEl 内部原生的左缘拖拽条（在 plugin-first 下易被推至中右交界引发双线/反向/错牵左边界） */
  .host-inner-native-sash {
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    width: 6px;
    cursor: col-resize;
    z-index: 28;
    border-left: 1px solid rgba(255, 255, 255, 0.12);
  }
  [data-side-panel-strip="true"] {
    height: 36px;
    display: flex;
    align-items: center;
    padding: 0 10px;
    background: #1b1b1b;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    border-left: 1px solid rgba(255, 255, 255, 0.12);
    font-size: 12px;
  }
  [data-testid="host-browser-pane"] {
    flex: 1 1 auto;
    position: relative;
    background: #161616;
    border-left: 1px solid rgba(255, 255, 255, 0.12);
    padding: 12px;
    overflow: hidden;
  }
  /* 模拟右侧预览窗格内部靠近左缘的原生 cursor-col-resize 拖条 */
  .host-pane-nested-sash {
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    width: 6px;
    cursor: col-resize;
    z-index: 15;
  }
</style>
</head>
<body>
<div class="ag-app-root h-screen w-screen">
  <div data-testid="title-menu-bar">
    <span>Antigravity</span>
  </div>
  <div class="workspace-row" id="workspace-row">
    <div class="left-session-slot" id="left-session-slot">
      <div data-testid="conversation-view" data-pane-id="p1" data-cascade-id="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" data-focused="true">
        <div id="conv-messages">会话正文内容</div>
        <form class="surface-composer">
          <div contenteditable="true" data-lexical-editor="true"></div>
        </form>
      </div>
    </div>
    <div class="host-outer-sash" id="host-outer-sash" role="separator" data-testid="aux-pane-sash"></div>
    <div data-side-panel-open="true" id="aux-outer">
      <div data-side-panel-focus-scope="true" id="aux-inner">
        ${singleHostChild ? '' : '<div class="host-inner-native-sash" id="host-inner-native-sash" data-testid="side-panel-resizer"></div>'}
        ${stripHtml}
        <div data-testid="host-browser-pane" id="host-browser-pane">
          ${nestedSashHtml}
          <div id="host-preview-canvas">Drag to select a region to comment</div>
        </div>
      </div>
    </div>
  </div>
</div>
<script>
  window.__hostNativeDragTrapCount = 0;
  window.__hostPreviewPointerCount = 0;
  for (const id of ['host-outer-sash', 'host-inner-native-sash', 'host-pane-nested-sash']) {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('pointerdown', () => { window.__hostNativeDragTrapCount++; });
    }
  }
  document.getElementById('host-browser-pane')?.addEventListener('pointerdown', () => {
    window.__hostPreviewPointerCount++;
  });
  document.getElementById('host-browser-pane')?.addEventListener('pointerup', () => {
    window.__hostPreviewPointerCount++;
  });

  window.__persistedSettings = {
    ok: true,
    dockPosition: 'aux',
    panelDockMode: 'aux',
    auxViewTab: 'both',
    auxOrder: 'plugin-first',
    auxWidthPx: 800,
    auxPluginSharePx: 400,
    uiPreferences: {
      dockPosition: 'aux',
      panelDockMode: 'aux',
      auxViewTab: 'both',
      auxOrder: 'plugin-first',
      auxWidthPx: 800,
      auxPluginSharePx: 400
    }
  };
  window.__savedSettingsCalls = [];
  window.__APP_CONFIG__ = { csrfToken: 'geom-test-token' };
  window.contextMeterAPI = {
    getRuntimeInfo: async () => ({ ok: true, backendVersion: '0.9.3', backendSource: 'electron-ipc' }),
    getSettings: async () => JSON.parse(JSON.stringify(window.__persistedSettings)),
    saveSettings: async (patch) => {
      window.__savedSettingsCalls.push(JSON.parse(JSON.stringify(patch || {})));
      window.__persistedSettings = {
        ...window.__persistedSettings,
        ...(patch || {}),
        uiPreferences: {
          ...(window.__persistedSettings.uiPreferences || {}),
          ...(patch || {})
        }
      };
      return { ok: true };
    },
    scan: async () => ({ ok: true, data: { found: false } }),
    getTokenHistory: async () => ({ ok: true, loading: false, summary: {}, dailyMap: {}, dailyModelMap: {} }),
    getQuota: async () => ({ ok: true, snapshot: null })
  };
</script>
</body>
</html>`;
}

async function waitForJson(url, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch (e) {
      lastErr = e;
    }
    await new Promise(r => setTimeout(r, 120));
  }
  throw lastErr || new Error(`Timed out waiting for ${url}`);
}

async function launchBrowserSession(opts = {}) {
  const browserPath = findBrowserExecutable();
  assert.ok(browserPath, '本机必须存在 Chrome 或 Edge 用于真实 DOM 几何验收');

  const coreCode = fs.readFileSync(path.join(__dirname, 'meter-core.js'), 'utf8');
  const rendererCode = fs.readFileSync(path.join(__dirname, 'meter-renderer.js'), 'utf8');
  const fixtureHtml = opts.customHtml || createTriPaneFixtureHtml(opts);

  const server = http.createServer((req, res) => {
    const reqUrl = String(req.url || '/');
    if (reqUrl.startsWith('/c/')) {
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

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const httpPort = server.address().port;
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-splitter-geom-'));
  const debugPort = 29000 + Math.floor(Math.random() * 10000);

  const vpWidth = Number(opts.width) > 320 ? Math.round(Number(opts.width)) : 1440;
  const vpHeight = Number(opts.height) > 320 ? Math.round(Number(opts.height)) : 900;
  const proc = spawn(browserPath, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${userDataDir}`,
    `--window-size=${vpWidth},${vpHeight}`,
    `http://127.0.0.1:${httpPort}/c/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`
  ], { stdio: 'ignore', windowsHide: true });

  const cleanup = async () => {
    try { proc.kill(); } catch { }
    await new Promise(r => setTimeout(r, 150));
    try { server.close(); } catch { }
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { }
  };

  try {
    const targets = await waitForJson(`http://127.0.0.1:${debugPort}/json/list`, 10000);
    const pageTarget = targets.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
    assert.ok(pageTarget, '必须发现 Headless 页面 CDP 目标');
    const cdp = new CdpClient(pageTarget.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send('Page.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: vpWidth,
      height: vpHeight,
      deviceScaleFactor: 1,
      mobile: false
    });
    // 等待 Headless Chromium 完成从 about:blank 到 http://127.0.0.1 的导航，避免偶发 localStorage SecurityError
    const navDeadline = Date.now() + 5000;
    while (Date.now() < navDeadline) {
      const ready = await cdp.evaluate(`Boolean(location.protocol === 'http:' && document.readyState !== 'loading')`).catch(() => false);
      if (ready) break;
      await new Promise(r => setTimeout(r, 80));
    }
    await new Promise(r => setTimeout(r, 120));
    const bootRes = await cdp.evaluate(`(async () => {
      window.__agBootErrors = [];
      window.addEventListener('error', (e) => window.__agBootErrors.push(String(e?.error?.stack || e?.message || e)));
      const preset = ${JSON.stringify({
        dockPosition: opts.dockPosition ?? (opts.customHtml ? 'aux' : null),
        auxViewTab: opts.auxViewTab ?? null,
        auxOrder: opts.auxOrder ?? null,
        auxWidthPx: opts.auxWidthPx ?? null,
        auxPluginSharePx: opts.auxPluginSharePx ?? null
      })};
      if (preset.dockPosition) localStorage.setItem('ag_dock_position', String(preset.dockPosition));
      if (preset.auxViewTab) localStorage.setItem('ag_aux_view_tab', String(preset.auxViewTab));
      if (preset.auxOrder) localStorage.setItem('ag_aux_order', String(preset.auxOrder));
      if (preset.auxWidthPx != null) {
        localStorage.setItem('ag_aux_width_px', String(preset.auxWidthPx));
        localStorage.setItem('ag_aux_tri_width_px', String(preset.auxWidthPx));
      }
      if (preset.auxPluginSharePx != null) localStorage.setItem('ag_aux_plugin_share_px', String(preset.auxPluginSharePx));
      const loadScript = (src) => new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src;
        s.onload = () => resolve(true);
        s.onerror = () => reject(new Error('load failed: ' + src));
        document.head.appendChild(s);
      });
      await loadScript('/meter-core.js');
      await loadScript('/meter-renderer.js');
      return { hasApi: Boolean(window.__AGContextMeter), errors: window.__agBootErrors };
    })()`);
    assert.equal(bootRes.hasApi, true, `meter-renderer.js 启动失败: ${JSON.stringify(bootRes.errors)}`);
    await new Promise(r => setTimeout(r, 250));
    return {
      cdp,
      async close() {
        cdp.close();
        await cleanup();
      }
    };
  } catch (e) {
    await cleanup();
    throw e;
  }
}

async function dispatchRealMouseDrag(cdp, { startX, startY, endX, endY, steps = 8, release = true, blurInsteadOfUp = false, skipSnapshot = false }) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: startX, y: startY });
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: startX,
    y: startY,
    button: 'left',
    buttons: 1,
    clickCount: 1
  });
  for (let i = 1; i <= steps; i++) {
    const curX = Math.round(startX + ((endX - startX) * i) / steps);
    const curY = Math.round(startY + ((endY - startY) * i) / steps);
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: curX,
      y: curY,
      button: 'left',
      buttons: 1
    });
    await new Promise(r => setTimeout(r, 12));
  }
  const midSnap = skipSnapshot ? null : await captureTriPaneSnapshot(cdp);
  if (blurInsteadOfUp) {
    await cdp.evaluate(`window.dispatchEvent(new Event('blur'));`);
  } else if (release) {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: endX,
      y: endY,
      button: 'left',
      buttons: 0,
      clickCount: 1
    });
  }
  return midSnap;
}

async function captureTriPaneSnapshot(cdp) {
  return cdp.evaluate(`(() => {
    const roundRect = (el) => {
      if (!el) return null;
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
    const leftSlot = document.getElementById('left-session-slot');
    const auxOuter = document.getElementById('aux-outer');
    const auxInner = document.getElementById('aux-inner');
    const host = document.getElementById('ag-context-meter');
    const browserPane = document.getElementById('host-browser-pane');
    const innerSep = host?.shadowRoot?.getElementById('dock-aux-inner-resizer') || null;
    const leftSep = host?.shadowRoot?.getElementById('dock-aux-resizer') || null;
    const outerLeftSep = document.querySelector('[data-ag-ws-splitter="outer-left"]');
    const api = window.__AGContextMeter;
    const st = api?.getAuxDockStateForTest?.() || null;

    const isVisibleEl = (node) => {
      if (!node || node.nodeType !== 1 || node.hidden) return false;
      const cs = getComputedStyle(node);
      if (!cs || cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
      const r = node.getBoundingClientRect();
      return r.width > 0 && r.height > 20;
    };
    const isTransparentColor = (c) => !c || c === 'transparent' || /rgba\(\s*\d+,\s*\d+,\s*\d+,\s*0(?:\.0+)?\s*\)/.test(c);

    const colResizeHandles = [];
    const visualVerticalLines = [];
    const collectTree = (root, inShadow) => {
      const all = Array.from(root.querySelectorAll('*'));
      for (const el of all) {
        if (!isVisibleEl(el)) continue;
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        const isPaneSplitter = cs.cursor === 'col-resize'
          || el.getAttribute('role') === 'separator'
          || (cs.cursor === 'ew-resize' && !el.classList?.contains?.('ctx-widget-resize-edge') && r.height >= 400);
        if (isPaneSplitter && r.height >= 400) {
          colResizeHandles.push({
            id: el.id || '',
            cls: String(el.className || ''),
            inShadow,
            left: Math.round(r.left),
            right: Math.round(r.right),
            centerX: Math.round((r.left + r.right) / 2),
            width: Math.round(r.width)
          });
          const beforeCs = getComputedStyle(el, '::before');
          const hasBeforeLine = beforeCs && beforeCs.content && beforeCs.content !== 'none'
            && parseFloat(beforeCs.width || '0') > 0 && !isTransparentColor(beforeCs.backgroundColor);
          const hasSelfBg = !isTransparentColor(cs.backgroundColor) && r.width <= 4;
          if (hasBeforeLine || hasSelfBg) {
            visualVerticalLines.push({
              kind: 'splitter',
              id: el.id || String(el.className || ''),
              x: Math.round((r.left + r.right) / 2)
            });
          }
        }
        const isInteriorCard = inShadow && Boolean(el.closest?.('.ctx-widget-card, .ctx-section-card, .card, .ag-card, button, input, select'));
        if (r.height >= 400 && !isPaneSplitter && !isInteriorCard) {
          const blw = parseFloat(cs.borderLeftWidth || '0');
          if (blw > 0 && !isTransparentColor(cs.borderLeftColor) && r.left > 10 && r.left < 1430) {
            visualVerticalLines.push({
              kind: 'border-left',
              id: el.id || String(el.className || ''),
              x: Math.round(r.left)
            });
          }
          const brw = parseFloat(cs.borderRightWidth || '0');
          if (brw > 0 && !isTransparentColor(cs.borderRightColor) && r.right > 10 && r.right < 1430) {
            visualVerticalLines.push({
              kind: 'border-right',
              id: el.id || String(el.className || ''),
              x: Math.round(r.right)
            });
          }
        }
        // 也专门检查宿主顶部 strip（高度 ~36px）的左右边框，避免顶部 strip 留出第二条竖线
        if (!inShadow && el.id === 'host-strip') {
          const blw = parseFloat(cs.borderLeftWidth || '0');
          if (blw > 0 && !isTransparentColor(cs.borderLeftColor)) {
            visualVerticalLines.push({ kind: 'strip-border-left', id: el.id, x: Math.round(r.left) });
          }
          const brw = parseFloat(cs.borderRightWidth || '0');
          if (brw > 0 && !isTransparentColor(cs.borderRightColor)) {
            visualVerticalLines.push({ kind: 'strip-border-right', id: el.id, x: Math.round(r.right) });
          }
        }
      }
    };
    collectTree(document, false);
    if (host?.shadowRoot) collectTree(host.shadowRoot, true);

    return {
      leftSession: roundRect(leftSlot),
      auxOuter: roundRect(auxOuter),
      auxInner: roundRect(auxInner),
      plugin: roundRect(host),
      browser: roundRect(browserPane),
      leftSep: isVisibleEl(leftSep) ? roundRect(leftSep) : null,
      outerLeftSep: isVisibleEl(outerLeftSep) ? roundRect(outerLeftSep) : null,
      innerSep: isVisibleEl(innerSep) ? roundRect(innerSep) : null,
      colResizeHandles,
      visualVerticalLines,
      hostNativeDragTrapCount: window.__hostNativeDragTrapCount,
      hostPreviewPointerCount: window.__hostPreviewPointerCount,
      savedSettingsCallsCount: window.__savedSettingsCalls.length,
      persistedSettings: window.__persistedSettings,
      state: st ? {
        auxViewTab: st.auxViewTab,
        auxOrder: st.auxOrder,
        auxWidthPx: st.auxWidthPx,
        auxPluginSharePx: st.auxPluginSharePx,
        auxGridModeActive: st.auxGridModeActive
      } : null
    };
  })()`);
}

function assertSingleBoundaryLine(snap, boundaryX, label) {
  const handlesNear = snap.colResizeHandles.filter(h => Math.abs(h.centerX - boundaryX) <= 24);
  const linesNear = snap.visualVerticalLines.filter(l => Math.abs(l.x - boundaryX) <= 24);
  assert.equal(
    handlesNear.length,
    1,
    `${label} (x=${boundaryX} ±24px) 必须严格只有 1 个 col-resize 热区，实际 ${handlesNear.length}: ${JSON.stringify(handlesNear)}`
  );
  assert.equal(
    linesNear.length,
    1,
    `${label} (x=${boundaryX} ±24px) 必须严格只有 1 条可见竖线（含分隔线与相邻边框），实际 ${linesNear.length}: ${JSON.stringify(linesNear)}`
  );
}

test('真实 Chromium DOM 几何验收 (Grid 多宿主子节点): 单线唯一性、plugin-first/browser-first 双向 1:1 跟手、左会话零牵动与松手零回弹', async () => {
  const session = await launchBrowserSession({ singleHostChild: false });
  const { cdp } = session;
  try {
    // 1. 初始化并排模式（plugin-first: 640 | 400 | 400）
    await cdp.evaluate(`(() => {
      const api = window.__AGContextMeter;
      api.setDockPositionForTest('aux', { persist: false });
      api.setAuxViewTabForTest('both', { persist: false });
      api.setAuxOrderForTest('plugin-first', { persist: false });
      api.resizeAuxPanelForTest(800, { persist: false });
      api.setAuxPluginShareForTest(400, { persist: false });
    })()`);
    await new Promise(r => setTimeout(r, 120));

    const pfBefore = await captureTriPaneSnapshot(cdp);
    assert.equal(pfBefore.state.auxGridModeActive, true, '多宿主子节点必须进入 CSS Grid 归拢模式');
    assert.equal(pfBefore.leftSession.width, 640, 'plugin-first 初始左会话宽应为 640px');
    assert.equal(pfBefore.plugin.width, 400, 'plugin-first 初始中间插件宽应为 400px');
    assert.equal(pfBefore.browser.width, 400, 'plugin-first 初始最右浏览器宽应为 400px');

    // === 断言 A：并排模式（plugin-first）全屏唯一 2 根分隔线 + ±24px 零双线重影 ===
    assert.equal(pfBefore.colResizeHandles.length, 2, `并排模式全屏 col-resize 热区总数必须 === 2，实际: ${JSON.stringify(pfBefore.colResizeHandles)}`);
    assert.equal(pfBefore.visualVerticalLines.length, 2, `并排模式全屏可见竖线总数必须 === 2，实际: ${JSON.stringify(pfBefore.visualVerticalLines)}`);
    assertSingleBoundaryLine(pfBefore, pfBefore.plugin.left, 'plugin-first 左边界');
    assertSingleBoundaryLine(pfBefore, pfBefore.plugin.right, 'plugin-first 中右边界');

    // === 断言 B：plugin-first 中右唯一竖线向左拖 dx = -100px ===
    const pfInnerX = pfBefore.plugin.right;
    const pfMidLeft = await dispatchRealMouseDrag(cdp, {
      startX: pfInnerX,
      startY: 420,
      endX: pfInnerX - 100,
      endY: 420,
      steps: 10,
      release: true
    });
    const pfAfterLeft = await captureTriPaneSnapshot(cdp);
    assert.ok(Math.abs(pfAfterLeft.plugin.width - 300) <= 1, `plugin-first 左拖 100px 插件宽应减至 300px，实际 ${pfAfterLeft.plugin.width}`);
    assert.ok(Math.abs(pfAfterLeft.browser.width - 500) <= 1, `plugin-first 左拖 100px 最右窗格宽应增至 500px，实际 ${pfAfterLeft.browser.width}`);
    assert.ok(Math.abs(pfAfterLeft.innerSep.left - (pfBefore.innerSep.left - 100)) <= 1, `plugin-first 左拖 100px 中右分隔线应左移 100px，拖拽前 ${pfBefore.innerSep.left} -> 后 ${pfAfterLeft.innerSep.left}`);
    assert.equal(pfAfterLeft.leftSession.width, pfBefore.leftSession.width, 'plugin-first 拖中右竖线严禁牵动左侧会话宽度');
    assert.equal(pfAfterLeft.leftSession.right, pfBefore.leftSession.right, 'plugin-first 拖中右竖线严禁牵动左侧会话右边界');
    assert.equal(pfAfterLeft.hostNativeDragTrapCount, 0, '严禁误触任何被静默的宿主原生拖条');

    // 同一根线紧接着向右拖 dx = +100px（回到 400 / 400）
    await dispatchRealMouseDrag(cdp, {
      startX: pfAfterLeft.plugin.right,
      startY: 420,
      endX: pfAfterLeft.plugin.right + 100,
      endY: 420,
      steps: 10,
      release: true
    });
    const pfAfterRight = await captureTriPaneSnapshot(cdp);
    assert.ok(Math.abs(pfAfterRight.plugin.width - 400) <= 1, `plugin-first 同线右拖 +100px 插件宽应回到 400px，实际 ${pfAfterRight.plugin.width}`);
    assert.ok(Math.abs(pfAfterRight.browser.width - 400) <= 1, `plugin-first 同线右拖 +100px 最右窗格宽应回到 400px，实际 ${pfAfterRight.browser.width}`);
    assert.equal(pfAfterRight.leftSession.width, pfBefore.leftSession.width, 'plugin-first 同线右拖左侧会话宽度变化必须 === 0px');

    // 左边界唯一竖线连续向左拖 -60px 再向右拖 +60px 验证双向 1:1
    const pfLeftEdgeX = pfAfterRight.plugin.left;
    await dispatchRealMouseDrag(cdp, {
      startX: pfLeftEdgeX,
      startY: 420,
      endX: pfLeftEdgeX - 60,
      endY: 420,
      steps: 8,
      release: true
    });
    const pfLeftPulled = await captureTriPaneSnapshot(cdp);
    assert.ok(Math.abs(pfLeftPulled.leftSession.width - 580) <= 1, `左边界左拖 60px 左会话应减至 580px，实际 ${pfLeftPulled.leftSession.width}`);
    assert.ok(Math.abs(pfLeftPulled.plugin.width - 460) <= 1, `左边界左拖 60px 插件应增至 460px，实际 ${pfLeftPulled.plugin.width}`);
    assert.ok(Math.abs(pfLeftPulled.browser.width - 400) <= 1, `左边界左拖 60px 最右窗格应保持 400px，实际 ${pfLeftPulled.browser.width}`);

    await dispatchRealMouseDrag(cdp, {
      startX: pfLeftPulled.plugin.left,
      startY: 420,
      endX: pfLeftPulled.plugin.left + 60,
      endY: 420,
      steps: 8,
      release: true
    });
    const pfLeftRestored = await captureTriPaneSnapshot(cdp);
    assert.ok(Math.abs(pfLeftRestored.leftSession.width - 640) <= 1, '左边界右拖 +60px 左会话必须对称恢复 640px');
    assert.ok(Math.abs(pfLeftRestored.plugin.width - 400) <= 1, '左边界右拖 +60px 插件必须对称恢复 400px');

    // 向右拖 +60px 至 460 / 340（即使拖动途中经过预览面板松手或窗口失焦，均必须提交而非回滚），并等待 >= 1250ms 验证零回弹
    const pfHoldMid = await dispatchRealMouseDrag(cdp, {
      startX: pfLeftRestored.plugin.right,
      startY: 420,
      endX: pfLeftRestored.plugin.right + 60,
      endY: 420,
      steps: 8,
      release: true
    });
    const pfRelease = await captureTriPaneSnapshot(cdp);
    assert.ok(Math.abs(pfRelease.plugin.width - 460) <= 1, `松手瞬间插件宽应为 460px，实际 ${pfRelease.plugin.width}`);
    assert.ok(Math.abs(pfRelease.browser.width - 340) <= 1, `松手瞬间最右窗格宽应为 340px，实际 ${pfRelease.browser.width}`);
    assert.equal(pfRelease.leftSession.width, 640, '松手瞬间左侧会话宽应为 640px');
    assert.equal(pfRelease.hostPreviewPointerCount, 0, '拖动经过预览面板并松手时预览面板严禁拦截 pointer 事件');
    assert.equal(pfRelease.persistedSettings.auxPluginSharePx, 460, '松手必须立即将新 auxPluginSharePx=460 写入持久化存储');

    // 强迫多次 DOM 变更、window resize 事件与 1250ms 真实等待（覆盖 >=2 轮 500ms tick + MutationObserver + ResizeObserver）
    await cdp.evaluate(`(() => {
      const msg = document.getElementById('conv-messages');
      if (msg) msg.textContent = '模拟倒计时变动 54秒';
      window.dispatchEvent(new Event('resize'));
      window.__AGContextMeter?.tickForTest?.();
    })()`);
    await new Promise(r => setTimeout(r, 600));
    await cdp.evaluate(`(() => {
      const strip = document.getElementById('host-strip');
      if (strip) strip.setAttribute('data-state', 'updated');
      window.dispatchEvent(new Event('resize'));
      window.__AGContextMeter?.tickForTest?.();
    })()`);
    await new Promise(r => setTimeout(r, 650));

    const pfAfterWait = await captureTriPaneSnapshot(cdp);
    assert.ok(Math.abs(pfAfterWait.leftSession.width - pfRelease.leftSession.width) <= 1, '等待 1.25s 后左会话宽必须零回弹');
    assert.ok(Math.abs(pfAfterWait.plugin.width - pfRelease.plugin.width) <= 1, `等待 1.25s 后插件宽必须零回弹（松手 ${pfRelease.plugin.width} vs 1.25s 后 ${pfAfterWait.plugin.width}）`);
    assert.ok(Math.abs(pfAfterWait.browser.width - pfRelease.browser.width) <= 1, `等待 1.25s 后最右窗格宽必须零回弹（松手 ${pfRelease.browser.width} vs 1.25s 后 ${pfAfterWait.browser.width}）`);
    assert.ok(Math.abs(pfAfterWait.plugin.left - pfRelease.plugin.left) <= 1, '等待 1.25s 后插件 rect.left 必须零回弹');
    assert.ok(Math.abs(pfAfterWait.browser.left - pfRelease.browser.left) <= 1, '等待 1.25s 后最右窗格 rect.left 必须零回弹');

    // 窗口失焦(blur)提交防回滚验证：拖到 -40px 后模拟窗口 blur，应保留 420/380 而非弹回 460/340
    await dispatchRealMouseDrag(cdp, {
      startX: pfAfterWait.plugin.right,
      startY: 420,
      endX: pfAfterWait.plugin.right - 40,
      endY: 420,
      steps: 6,
      release: false,
      blurInsteadOfUp: true
    });
    const pfAfterBlur = await captureTriPaneSnapshot(cdp);
    assert.ok(Math.abs(pfAfterBlur.plugin.width - 420) <= 1, `鼠标滑出窗口触发 blur 应提交 420px 而非回滚，实际 ${pfAfterBlur.plugin.width}`);
    assert.ok(Math.abs(pfAfterBlur.browser.width - 380) <= 1, `鼠标滑出窗口触发 blur 最右窗格应为 380px，实际 ${pfAfterBlur.browser.width}`);

    // === 断言 C：browser-first（换位后：会话 | 浏览器 | 插件）单线唯一性与双向 1:1 拖拽 ===
    await cdp.evaluate(`(() => {
      const api = window.__AGContextMeter;
      api.setAuxOrderForTest('browser-first', { persist: false });
      api.resizeAuxPanelForTest(800, { persist: false });
      api.setAuxPluginShareForTest(360, { persist: false });
    })()`);
    await new Promise(r => setTimeout(r, 120));

    const bfBefore = await captureTriPaneSnapshot(cdp);
    assert.equal(bfBefore.colResizeHandles.length, 2, `browser-first 全屏 col-resize 热区总数必须 === 2，实际: ${JSON.stringify(bfBefore.colResizeHandles)}`);
    assert.equal(bfBefore.visualVerticalLines.length, 2, `browser-first 全屏可见竖线总数必须 === 2，实际: ${JSON.stringify(bfBefore.visualVerticalLines)}`);
    assertSingleBoundaryLine(bfBefore, bfBefore.leftSession.right, 'browser-first 左边界');
    assertSingleBoundaryLine(bfBefore, bfBefore.plugin.left, 'browser-first 中右边界');

    // 中右竖线向左拖 dx = -100px -> 中间浏览器减 100px，最右插件增 100px，左侧会话变化 0px
    const bfMidLeft = await dispatchRealMouseDrag(cdp, {
      startX: bfBefore.plugin.left,
      startY: 420,
      endX: bfBefore.plugin.left - 100,
      endY: 420,
      steps: 10,
      release: true
    });
    const bfAfterLeft = await captureTriPaneSnapshot(cdp);
    assert.ok(Math.abs(bfAfterLeft.browser.width - (bfBefore.browser.width - 100)) <= 1, `browser-first 左拖 100px 中间浏览器应减少 100px（${bfBefore.browser.width} -> ${bfAfterLeft.browser.width}）`);
    assert.ok(Math.abs(bfAfterLeft.plugin.width - (bfBefore.plugin.width + 100)) <= 1, `browser-first 左拖 100px 最右插件应增加 100px（${bfBefore.plugin.width} -> ${bfAfterLeft.plugin.width}）`);
    assert.equal(bfAfterLeft.leftSession.width, bfBefore.leftSession.width, 'browser-first 拖中右竖线严禁牵动左侧会话宽度');

    // 再向右拖 dx = +100px 对称成立
    await dispatchRealMouseDrag(cdp, {
      startX: bfAfterLeft.plugin.left,
      startY: 420,
      endX: bfAfterLeft.plugin.left + 100,
      endY: 420,
      steps: 10,
      release: true
    });
    const bfAfterRight = await captureTriPaneSnapshot(cdp);
    assert.ok(Math.abs(bfAfterRight.browser.width - bfBefore.browser.width) <= 1, 'browser-first 同线右拖 +100px 浏览器宽必须对称复原');
    assert.ok(Math.abs(bfAfterRight.plugin.width - bfBefore.plugin.width) <= 1, 'browser-first 同线右拖 +100px 插件宽必须对称复原');
    assert.equal(bfAfterRight.leftSession.width, bfBefore.leftSession.width, 'browser-first 同线右拖左侧会话宽度变化必须 === 0px');

    // === 断言 D：单插件模式 & 单浏览器模式全屏可见分隔线总数 === 1 ===
    await cdp.evaluate(`(() => { window.__AGContextMeter.setAuxViewTabForTest('plugin', { persist: false }); })()`);
    await new Promise(r => setTimeout(r, 120));
    const singlePluginSnap = await captureTriPaneSnapshot(cdp);
    assert.equal(singlePluginSnap.colResizeHandles.length, 1, `单插件模式全屏 col-resize 热区必须 === 1，实际: ${JSON.stringify(singlePluginSnap.colResizeHandles)}`);
    assert.equal(singlePluginSnap.visualVerticalLines.length, 1, `单插件模式全屏可见竖线必须 === 1，实际: ${JSON.stringify(singlePluginSnap.visualVerticalLines)}`);

    await cdp.evaluate(`(() => { window.__AGContextMeter.setAuxViewTabForTest('browser', { persist: false }); })()`);
    await new Promise(r => setTimeout(r, 120));
    const singleBrowserSnap = await captureTriPaneSnapshot(cdp);
    assert.equal(singleBrowserSnap.colResizeHandles.filter(h => h.inShadow).length, 0, '单浏览器模式 Shadow 内分隔线必须彻底退场');
    assert.ok(singleBrowserSnap.colResizeHandles.length >= 1, '单浏览器模式宿主原生分隔线必须恢复可用');

    if (process.env.AG_DUMP_SPLITTER_GEOM === '1') {
      console.log('SPLITTER_GEOM_REPORT=' + JSON.stringify({
        pluginFirst: {
          before: { leftSession: pfBefore.leftSession, plugin: pfBefore.plugin, browser: pfBefore.browser, handles: pfBefore.colResizeHandles, lines: pfBefore.visualVerticalLines },
          duringDragLeft100: { leftSession: pfMidLeft.leftSession, plugin: pfMidLeft.plugin, browser: pfMidLeft.browser },
          afterDragLeft100: { leftSession: pfAfterLeft.leftSession, plugin: pfAfterLeft.plugin, browser: pfAfterLeft.browser },
          afterDragRight100: { leftSession: pfAfterRight.leftSession, plugin: pfAfterRight.plugin, browser: pfAfterRight.browser },
          duringDragRight60: { leftSession: pfHoldMid.leftSession, plugin: pfHoldMid.plugin, browser: pfHoldMid.browser },
          releaseRight60: { leftSession: pfRelease.leftSession, plugin: pfRelease.plugin, browser: pfRelease.browser },
          after1250ms: { leftSession: pfAfterWait.leftSession, plugin: pfAfterWait.plugin, browser: pfAfterWait.browser }
        },
        browserFirst: {
          before: { leftSession: bfBefore.leftSession, browser: bfBefore.browser, plugin: bfBefore.plugin, handles: bfBefore.colResizeHandles, lines: bfBefore.visualVerticalLines },
          duringDragLeft100: { leftSession: bfMidLeft.leftSession, browser: bfMidLeft.browser, plugin: bfMidLeft.plugin },
          afterDragLeft100: { leftSession: bfAfterLeft.leftSession, browser: bfAfterLeft.browser, plugin: bfAfterLeft.plugin },
          afterDragRight100: { leftSession: bfAfterRight.leftSession, browser: bfAfterRight.browser, plugin: bfAfterRight.plugin }
        },
        singlePlugin: { handles: singlePluginSnap.colResizeHandles, lines: singlePluginSnap.visualVerticalLines }
      }, null, 2));
    }
  } finally {
    await session.close();
  }
});

test('真实 Chromium DOM 几何验收 (Flex 单宿主子节点): 单线唯一性、单浏览器=1、双向 1:1 跟手与零回弹', async () => {
  const session = await launchBrowserSession({ singleHostChild: true });
  const { cdp } = session;
  try {
    await cdp.evaluate(`(() => {
      const api = window.__AGContextMeter;
      api.setDockPositionForTest('aux', { persist: false });
      api.setAuxViewTabForTest('both', { persist: false });
      api.setAuxOrderForTest('plugin-first', { persist: false });
      api.resizeAuxPanelForTest(800, { persist: false });
      api.setAuxPluginShareForTest(400, { persist: false });
    })()`);
    await new Promise(r => setTimeout(r, 120));

    const before = await captureTriPaneSnapshot(cdp);
    assert.equal(before.state.auxGridModeActive, false, '单宿主子节点必须走 Flex 路径');
    assert.equal(before.leftSession.width, 640);
    assert.equal(before.plugin.width, 400);
    assert.equal(before.browser.width, 400);
    assert.equal(before.colResizeHandles.length, 2, `Flex 并排全屏热区必须 === 2，实际: ${JSON.stringify(before.colResizeHandles)}`);
    assert.equal(before.visualVerticalLines.length, 2, `Flex 并排全屏可见竖线必须 === 2，实际: ${JSON.stringify(before.visualVerticalLines)}`);
    assertSingleBoundaryLine(before, before.plugin.left, 'Flex plugin-first 左边界');
    assertSingleBoundaryLine(before, before.plugin.right, 'Flex plugin-first 中右边界');

    // 左拖 -100px -> 插件 300px，最右 500px，左会话 640px 不动
    await dispatchRealMouseDrag(cdp, {
      startX: before.plugin.right,
      startY: 420,
      endX: before.plugin.right - 100,
      endY: 420,
      steps: 10,
      release: true
    });
    const afterLeft = await captureTriPaneSnapshot(cdp);
    assert.ok(Math.abs(afterLeft.plugin.width - 300) <= 1, `Flex 左拖 100px 插件应减至 300px，实际 ${afterLeft.plugin.width}`);
    assert.ok(Math.abs(afterLeft.browser.width - 500) <= 1, `Flex 左拖 100px 浏览器应增至 500px，实际 ${afterLeft.browser.width}`);
    assert.equal(afterLeft.leftSession.width, 640, 'Flex 拖中右竖线严禁牵动左侧会话宽度');

    // 等待 >= 1050ms 验证 Flex 模式同样零回弹
    await new Promise(r => setTimeout(r, 1050));
    const afterWait = await captureTriPaneSnapshot(cdp);
    assert.ok(Math.abs(afterWait.plugin.width - afterLeft.plugin.width) <= 1);
    assert.ok(Math.abs(afterWait.browser.width - afterLeft.browser.width) <= 1);
    assert.equal(afterWait.leftSession.width, 640);

    // 单浏览器模式：恢复原生唯一 1 根分隔线
    await cdp.evaluate(`(() => { window.__AGContextMeter.setAuxViewTabForTest('browser', { persist: false }); })()`);
    await new Promise(r => setTimeout(r, 120));
    const brwOnly = await captureTriPaneSnapshot(cdp);
    assert.equal(brwOnly.colResizeHandles.length, 1, `标准单浏览器模式全屏 col-resize 热区必须 === 1，实际: ${JSON.stringify(brwOnly.colResizeHandles)}`);
  } finally {
    await session.close();
  }
});

function createInlineFlexHostFixtureHtml({ leftInlineStyle = 'flex: 60 1 0px; overflow: hidden;' } = {}) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>Antigravity 2.35.2 Inline-Flex Close Aux & Split Right Fixture</title>
<style>
  :root {
    --background: #141414;
    --foreground: #f4f4f4;
    --border: rgba(255, 255, 255, 0.12);
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    padding: 0;
    width: 1440px;
    height: 900px;
    overflow: hidden;
    background: #141414;
    color: #f4f4f4;
    font-family: system-ui, -apple-system, sans-serif;
  }
  .ag-app-root {
    display: flex;
    flex-direction: column;
    width: 1440px;
    height: 900px;
    overflow: hidden;
  }
  [data-testid="title-menu-bar"] {
    position: relative;
    display: flex;
    align-items: center;
    height: 32px;
    flex: 0 0 32px;
    background: #181818;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    padding: 0 12px;
  }
  .workspace-row {
    display: flex;
    flex-direction: row;
    flex: 1 1 auto;
    width: 1440px;
    height: 868px;
    overflow: hidden;
    position: relative;
  }
  /* 还原真实 Antigravity react-resizable-panels：CSS 类不带 flex-grow / width，完全依赖 React 内联 style.flex 撑宽，内部为绝对定位虚拟滚动容器 */
  .rp-panel {
    position: relative;
    height: 100%;
    overflow: hidden;
  }
  .rp-panel-inner {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
  }
  .rp-split-group {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: row;
    width: 100%;
    height: 100%;
    overflow: hidden;
  }
  [data-testid="conversation-view"] {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    padding: 12px;
    background: #151515;
  }
  .surface-composer {
    height: 64px;
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 10px;
    padding: 8px;
  }
  .host-outer-sash {
    flex: 0 0 1px;
    width: 1px;
    height: 100%;
    background: rgba(255, 255, 255, 0.12);
    cursor: col-resize;
  }
  .host-outer-sash[hidden] {
    display: none !important;
  }
  [data-side-panel-open="true"] {
    position: relative;
    height: 100%;
    display: flex;
    flex-direction: row;
    background: #171717;
  }
  [data-side-panel-open="false"] {
    width: 0px;
    min-width: 0px;
    overflow: hidden;
  }
  [data-side-panel-focus-scope="true"] {
    position: relative;
    flex: 1 1 auto;
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  [data-testid="host-browser-pane"] {
    flex: 1 1 auto;
    position: relative;
    background: #161616;
    padding: 12px;
    overflow: hidden;
  }
</style>
</head>
<body>
<div class="ag-app-root h-screen w-screen">
  <div data-testid="title-menu-bar"><span>Antigravity</span></div>
  <div class="workspace-row" id="workspace-row">
    <div class="rp-panel" id="left-session-slot" data-panel="left" style="${leftInlineStyle}">
      <div class="rp-panel-inner" id="left-slot-content">
        <div data-testid="conversation-view" id="conv-1" data-pane-id="p1" data-cascade-id="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" data-focused="true">
          <div id="conv-messages-1">主会话正文内容</div>
          <form class="surface-composer"><div contenteditable="true" data-lexical-editor="true"></div></form>
        </div>
      </div>
    </div>
    <div class="host-outer-sash" id="host-outer-sash" role="separator" data-panel-resize-handle-id="outer-sash"></div>
    <div class="rp-panel" data-side-panel-open="true" id="aux-outer" style="flex: 0 0 800px; width: 800px;">
      <div data-side-panel-focus-scope="true" id="aux-inner">
        <div data-testid="host-browser-pane" id="host-browser-pane">
          <div id="host-preview-canvas">Host Browser / Preview</div>
        </div>
      </div>
    </div>
  </div>
</div>
<script>
  window.__persistedSettings = {
    ok: true,
    dockPosition: 'aux',
    panelDockMode: 'aux',
    auxViewTab: 'both',
    auxOrder: 'plugin-first',
    auxWidthPx: 800,
    auxPluginSharePx: 400,
    uiPreferences: {}
  };
  window.__APP_CONFIG__ = { csrfToken: 'geom-test-token' };
  window.contextMeterAPI = {
    getSettings: async () => ({ ...window.__persistedSettings }),
    saveSettings: async (patch) => {
      window.__persistedSettings = { ...window.__persistedSettings, ...(patch || {}) };
      return { ok: true, settings: window.__persistedSettings };
    },
    getRuntimeInfo: async () => ({ ok: true, backendVersion: '0.9.3', backendSource: 'electron-ipc' }),
    getQuota: async () => ({ ok: true, snapshot: null }),
    getTokenHistory: async () => ({ ok: true, loading: false, summary: {}, dailyMap: {}, dailyModelMap: {} }),
    scan: async () => ({ ok: true, data: { found: false } })
  };
  try {
    history.replaceState(null, '', '/c/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    localStorage.setItem('ag_dock_position', 'aux');
    localStorage.setItem('ag_panel_dock_mode', 'aux');
    localStorage.setItem('ag_aux_view_tab', 'both');
    localStorage.setItem('ag_aux_order', 'plugin-first');
    localStorage.setItem('ag_aux_width_px', '800');
    localStorage.setItem('ag_aux_tri_width_px', '800');
    localStorage.setItem('ag_aux_plugin_share_px', '400');
  } catch { }
</script>
</body>
</html>`;
}

test('真实 Chromium 回归 3: 关闭辅助面板零空白（兼容 react-resizable-panels 纯内联 flex: 60 1 0px 与 flexGrow: 1）', async () => {
  for (const leftStyle of ['flex: 60 1 0px; overflow: hidden;', 'flex-grow: 1; flex-basis: 0px; overflow: hidden;']) {
    const session = await launchBrowserSession({ customHtml: createInlineFlexHostFixtureHtml({ leftInlineStyle: leftStyle }) });
    const { cdp } = session;
    try {
      // 1. 初始接管三栏并排态
      await cdp.evaluate(`(() => {
        const api = window.__AGContextMeter;
        api.setDockPositionForTest('aux', { persist: false });
        api.setAuxViewTabForTest('both', { persist: false });
        api.resizeAuxPanelForTest(800, { persist: false });
        api.setAuxPluginShareForTest(400, { persist: false });
      })()`);
      await new Promise(r => setTimeout(r, 120));

      const openRects = await cdp.evaluate(`(() => {
        const lr = document.getElementById('left-session-slot').getBoundingClientRect();
        const cv = document.getElementById('conv-1').getBoundingClientRect();
        return { leftW: Math.round(lr.width), convW: Math.round(cv.width) };
      })()`);
      assert.equal(openRects.leftW, 640, `初始三栏左会话应为 640px (${leftStyle})`);
      assert.equal(openRects.convW, 640);

      // 2. 模拟宿主点击 Toggle Side Panel 关闭动画中（data-side-panel-open="false" 且 auxOuter 正在从 400 -> 230px 收拢，React 未重设 leftSlot.style.flex）
      await cdp.evaluate(`(() => {
        const auxOuter = document.getElementById('aux-outer');
        const sash = document.getElementById('host-outer-sash');
        auxOuter.setAttribute('data-side-panel-open', 'false');
        auxOuter.style.width = '230px';
        auxOuter.style.flexBasis = '230px';
        auxOuter.style.maxWidth = '230px';
        sash.hidden = true;
        window.__AGContextMeter.restoreAllHostInlineLayoutStylesForTest(null);
      })()`);
      await new Promise(r => setTimeout(r, 140));

      const midClose = await cdp.evaluate(`(() => {
        const lr = document.getElementById('left-session-slot').getBoundingClientRect();
        const ar = document.getElementById('aux-outer').getBoundingClientRect();
        const cv = document.getElementById('conv-1').getBoundingClientRect();
        return {
          leftW: Math.round(lr.width),
          convW: Math.round(cv.width),
          auxLeft: Math.round(ar.left),
          auxW: Math.round(ar.width)
        };
      })()`);
      assert.equal(midClose.leftW, 1210, `关闭动画中左会话严禁塌缩为 0px，必须稳占 1210px (${leftStyle})，实际 ${JSON.stringify(midClose)}`);
      assert.equal(midClose.convW, 1210);
      assert.equal(midClose.auxLeft, 1210, `关闭动画中辅助栏必须留在右侧 1210px 处，严禁跳到最左边缘 (${leftStyle})`);

      // 3. 关闭动画彻底结束（auxOuter 收拢至 0px / 卸载）+ 切到另一个无侧栏会话，左会话必须 100% 占满 1440px
      await cdp.evaluate(`(() => {
        const auxOuter = document.getElementById('aux-outer');
        auxOuter.style.width = '0px';
        auxOuter.style.flexBasis = '0px';
        auxOuter.style.maxWidth = '0px';
        auxOuter.style.display = 'none';
        history.pushState(null, '', '/c/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
      })()`);
      await new Promise(r => setTimeout(r, 220));

      const closedRects = await cdp.evaluate(`(() => {
        const lr = document.getElementById('left-session-slot').getBoundingClientRect();
        const cv = document.getElementById('conv-1').getBoundingClientRect();
        return { leftW: Math.round(lr.width), convW: Math.round(cv.width) };
      })()`);
      assert.equal(closedRects.leftW, 1440, `关闭辅助面板后左会话必须满屏 1440px 零空白 (${leftStyle})，实际 ${JSON.stringify(closedRects)}`);
      assert.equal(closedRects.convW, 1440);

      // 4. 再验证场景：单插件态下 React 抢先写入 leftSlot.style.flex = '100 1 0px' 后再触发插件还原，严禁覆盖 React 新值
      await cdp.evaluate(`(() => {
        const auxOuter = document.getElementById('aux-outer');
        auxOuter.style.display = 'flex';
        auxOuter.style.width = '480px';
        auxOuter.style.flexBasis = '480px';
        auxOuter.style.maxWidth = '';
        auxOuter.setAttribute('data-side-panel-open', 'true');
        window.__AGContextMeter.setAuxViewTabForTest('plugin', { persist: false });
      })()`);
      await new Promise(r => setTimeout(r, 150));

      await cdp.evaluate(`(() => {
        const leftSlot = document.getElementById('left-session-slot');
        const auxOuter = document.getElementById('aux-outer');
        // 模拟宿主 React 同步 commit：先设 leftSlot flex=100 1 0px，再关侧栏
        leftSlot.style.flex = '100 1 0px';
        auxOuter.setAttribute('data-side-panel-open', 'false');
        auxOuter.style.display = 'none';
        window.__AGContextMeter.restoreAllHostInlineLayoutStylesForTest(null);
      })()`);
      await new Promise(r => setTimeout(r, 150));

      const reactCommitRects = await cdp.evaluate(`(() => {
        const ls = document.getElementById('left-session-slot');
        const lr = ls.getBoundingClientRect();
        return { leftW: Math.round(lr.width), flex: ls.style.flex };
      })()`);
      assert.equal(reactCommitRects.leftW, 1440, `单插件关侧栏后主会话必须 1440px 零空白 (${leftStyle})`);
      assert.match(reactCommitRects.flex, /100/, `严禁抹除宿主 React 刚提交的新 flex 值 (${leftStyle})，实际: ${reactCommitRects.flex}`);
    } finally {
      await session.close();
    }
  }
});

test('真实 Chromium 回归 4: 单窗口 Split Right 开双会话零空白（覆盖关侧栏与保侧栏双路径）', async () => {
  const session = await launchBrowserSession({ customHtml: createInlineFlexHostFixtureHtml({ leftInlineStyle: 'flex: 60 1 0px; overflow: hidden;' }) });
  const { cdp } = session;
  try {
    // 1. 初始三栏并排态
    await cdp.evaluate(`(() => {
      const api = window.__AGContextMeter;
      api.setDockPositionForTest('aux', { persist: false });
      api.setAuxViewTabForTest('both', { persist: false });
      api.resizeAuxPanelForTest(800, { persist: false });
      api.setAuxPluginShareForTest(400, { persist: false });
    })()`);
    await new Promise(r => setTimeout(r, 150));

    // 2. 路径 A：模拟点击 Split Right -> 在 leftSlot 内切换为双会话 PanelGroup（各靠内联 flex: 50 1 0px 撑宽）且宿主关闭侧栏 + pushState 双会话路由
    await cdp.evaluate(`(() => {
      const leftContent = document.getElementById('left-slot-content');
      const auxOuter = document.getElementById('aux-outer');
      const sash = document.getElementById('host-outer-sash');
      leftContent.innerHTML = \`
        <div class="rp-split-group" id="split-group">
          <div class="rp-panel" id="split-pane-1" style="flex: 50 1 0px; overflow: hidden;">
            <div data-testid="conversation-view" id="conv-1" data-pane-id="p1" data-cascade-id="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa">
              <div>左侧会话 1</div>
              <form class="surface-composer"><div contenteditable="true" data-lexical-editor="true"></div></form>
            </div>
          </div>
          <div class="host-outer-sash" id="split-native-sep" role="separator" data-panel-resize-handle-id="split-sep"></div>
          <div class="rp-panel" id="split-pane-2" style="flex: 50 1 0px; overflow: hidden;">
            <div data-testid="conversation-view" id="conv-2" data-pane-id="p2" data-cascade-id="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" data-focused="true">
              <div>右侧会话 2</div>
              <form class="surface-composer"><div contenteditable="true" data-lexical-editor="true"></div></form>
            </div>
          </div>
        </div>\`;
      auxOuter.setAttribute('data-side-panel-open', 'false');
      auxOuter.style.display = 'none';
      sash.hidden = true;
      history.pushState(null, '', '/c/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa+bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb?focused=bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    })()`);
    await new Promise(r => setTimeout(r, 260));

    const splitClosed = await cdp.evaluate(`(() => {
      const lr = document.getElementById('left-session-slot').getBoundingClientRect();
      const s1 = document.getElementById('split-pane-1').getBoundingClientRect();
      const s2 = document.getElementById('split-pane-2').getBoundingClientRect();
      return {
        leftW: Math.round(lr.width),
        s1W: Math.round(s1.width),
        s2W: Math.round(s2.width)
      };
    })()`);
    assert.equal(splitClosed.leftW, 1440, `Split Right 关闭侧栏后双会话外层必须占满 1440px，实际 ${JSON.stringify(splitClosed)}`);
    assert.ok(splitClosed.s1W >= 700 && splitClosed.s2W >= 700, `Split Right 后左右两会话必须各自 ~720px 完整显示，严禁空白: ${JSON.stringify(splitClosed)}`);

    // 3. 路径 B：在双会话状态下重新打开右侧辅助栏（同步触发 syncMultiSessionWorkspacePanes 接管两个分屏槽），随后再次关闭辅助栏，验证双会话仍零空白！
    await cdp.evaluate(`(() => {
      const auxOuter = document.getElementById('aux-outer');
      const sash = document.getElementById('host-outer-sash');
      auxOuter.style.display = 'flex';
      auxOuter.style.width = '760px';
      auxOuter.style.flexBasis = '760px';
      auxOuter.style.maxWidth = '';
      auxOuter.setAttribute('data-side-panel-open', 'true');
      sash.hidden = false;
      window.__AGContextMeter.setAuxViewTabForTest('both', { persist: false });
      window.__AGContextMeter.syncMultiSessionWorkspacePanesForTest({ force: true });
    })()`);
    await new Promise(r => setTimeout(r, 200));

    const splitWithAux = await cdp.evaluate(`(() => {
      const s1 = document.getElementById('split-pane-1').getBoundingClientRect();
      const s2 = document.getElementById('split-pane-2').getBoundingClientRect();
      const aux = document.getElementById('aux-outer').getBoundingClientRect();
      return { s1W: Math.round(s1.width), s2W: Math.round(s2.width), auxW: Math.round(aux.width) };
    })()`);
    assert.ok(splitWithAux.s1W >= 200 && splitWithAux.s2W >= 200 && splitWithAux.auxW >= 660, `双会话+辅助栏并排各窗格必须正常可见: ${JSON.stringify(splitWithAux)}`);

    // 再次关闭侧栏 -> 触发 cleanupMultiSessionPaneArtifacts({ forceClearSizing: true }) 与 restoreWorkspaceConservedSlots({ sidePanelClosed: true })
    await cdp.evaluate(`(() => {
      const auxOuter = document.getElementById('aux-outer');
      const sash = document.getElementById('host-outer-sash');
      auxOuter.setAttribute('data-side-panel-open', 'false');
      auxOuter.style.display = 'none';
      sash.hidden = true;
      window.__AGContextMeter.restoreAllHostInlineLayoutStylesForTest(null);
    })()`);
    await new Promise(r => setTimeout(r, 200));

    const splitReclosed = await cdp.evaluate(`(() => {
      const lr = document.getElementById('left-session-slot').getBoundingClientRect();
      const s1 = document.getElementById('split-pane-1').getBoundingClientRect();
      const s2 = document.getElementById('split-pane-2').getBoundingClientRect();
      return {
        leftW: Math.round(lr.width),
        s1W: Math.round(s1.width),
        s2W: Math.round(s2.width)
      };
    })()`);
    assert.equal(splitReclosed.leftW, 1440, `双会话关闭侧栏后外层必须恢复 1440px，实际 ${JSON.stringify(splitReclosed)}`);
    assert.ok(splitReclosed.s1W >= 700 && splitReclosed.s2W >= 700, `双会话关闭侧栏后 S1/S2 严禁因 forceClearSizing 塌缩为 0px 空白: ${JSON.stringify(splitReclosed)}`);
  } finally {
    await session.close();
  }
});

test('真实 Chromium 回归 5: 顶栏「互换」按键严格仅在并排模式下可用，非并排（单插件/单浏览器/收起）一律禁用不可点击', async (t) => {
  const browserBin = findBrowserExecutable();
  if (!browserBin) {
    t.skip('未检测到 Chrome/Edge 可执行文件');
    return;
  }
  const session = await launchBrowserSession({
    mode: 'grid',
    width: 1440,
    height: 900,
    dockPosition: 'aux',
    auxViewTab: 'plugin',
    auxOrder: 'plugin-first'
  });
  try {
    const { cdp } = session;
    const readSwapState = () => cdp.evaluate(`(() => {
      const sr = document.getElementById('ag-context-meter')?.shadowRoot;
      const btn = sr?.getElementById('ag-aux-qs-swap') || null;
      const topbarOld = document.getElementById('ag-topbar-ws-controls');
      const st = window.__AGContextMeter.getAuxDockStateForTest();
      return {
        topbarOldPresent: Boolean(topbarOld),
        exists: Boolean(btn),
        hidden: Boolean(!btn || btn.hidden),
        disabled: Boolean(!btn || btn.disabled),
        auxCoexistMode: window.__AGContextMeter.getAuxCoexistMode(),
        auxViewTab: st.auxViewTab,
        auxOrder: st.auxOrder
      };
    })()`);

    // 1. 标签页态：标题栏无冗余按钮，辅助栏互换键严格隐藏禁用
    await cdp.evaluate(`window.__AGContextMeter.setAuxCoexistMode('tab', { persist: false });`);
    await new Promise(r => setTimeout(r, 120));
    let s = await readSwapState();
    assert.equal(s.topbarOldPresent, false, '阶段二收敛后标题栏不得再挂载旧四枚按钮');
    assert.equal(s.hidden, true, `标签页态互换键必须隐藏: ${JSON.stringify(s)}`);
    assert.equal(s.disabled, true, `标签页态互换键必须禁用: ${JSON.stringify(s)}`);

    // 2. 切入并排态：辅助栏唯一入口右侧出现互换键，点击可正常切换顺序
    await cdp.evaluate(`window.__AGContextMeter.setAuxCoexistMode('split', { persist: false });`);
    await new Promise(r => setTimeout(r, 140));
    s = await readSwapState();
    assert.equal(s.auxViewTab, 'both');
    assert.equal(s.hidden, false, `并排态互换键必须显示: ${JSON.stringify(s)}`);
    assert.equal(s.disabled, false, `并排态互换键必须可用: ${JSON.stringify(s)}`);
    await cdp.evaluate(`document.getElementById('ag-context-meter').shadowRoot.getElementById('ag-aux-qs-swap').click();`);
    await new Promise(r => setTimeout(r, 120));
    s = await readSwapState();
    assert.equal(s.auxOrder, 'browser-first', '并排态点击互换键必须正常切换至 browser-first');

    // 3. 切回标签页态：互换键必须自动重新隐藏禁用
    await cdp.evaluate(`window.__AGContextMeter.setAuxCoexistMode('tab', { persist: false });`);
    await new Promise(r => setTimeout(r, 100));
    s = await readSwapState();
    assert.equal(s.hidden, true, '离开并排态后互换键必须重新隐藏');
    assert.equal(s.disabled, true, '离开并排态后互换键必须重新禁用');
  } finally {
    await session.close();
  }
});

test('真实 Chromium 回归 6: 双会话 + browser-first 无须先拖双会话线即可左右拖浏览器左线、点会话 2 关侧栏右侧零黑洞、点回会话 1 插件不黑屏', async (t) => {
  const browserBin = findBrowserExecutable();
  if (!browserBin) {
    t.skip('未检测到 Chrome/Edge 可执行文件');
    return;
  }
  // 精准复刻 Antigravity 2.35.2 双会话（原生 SplitView 绝对定位/定宽 + 原生分隔条 + 深层原生侧栏拖条 + 外层无 open 属性的 auxShell）
  const dualRealHtml = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { width: 1440px; height: 900px; overflow: hidden; background: #141416; color: #e4e4e7; font-family: system-ui, sans-serif; }
  [data-testid="title-menu-bar"] { position: relative; width: 100%; height: 32px; background: #18181b; display: flex; align-items: center; padding: 0 12px; }
  #workspace-row { display: flex; flex-direction: row; width: 1440px; height: 868px; overflow: hidden; }
  #session-split-group { position: relative; flex: 1 1 0px; min-width: 0; height: 868px; overflow: hidden; display: flex; flex-direction: row; }
  .split-pane-abs { position: absolute; top: 0; bottom: 0; overflow: hidden; display: flex; flex-direction: column; justify-content: space-between; padding: 12px; background: #141416; }
  .native-pane-sash { position: absolute; top: 0; bottom: 0; width: 4px; cursor: col-resize; z-index: 20; background: rgba(255,255,255,0.08); }
  .conv-view { width: 100%; flex: 1 1 auto; overflow: hidden; }
  .surface-composer { width: 100%; height: 48px; border: 1px solid rgba(255,255,255,0.12); border-radius: 8px; padding: 6px; }
  .host-outer-sash { flex: 0 0 4px; width: 4px; cursor: col-resize; background: rgba(255,255,255,0.08); }
  .host-outer-sash[hidden] { display: none !important; }
  /* 外壳 auxShell 自身没有 data-side-panel-open 属性，属性挂在内层 aux-open-wrap 上，精准复刻实机右侧黑洞触发条件 */
  #aux-shell { flex: 0 0 auto; height: 868px; display: flex; flex-direction: row; overflow: hidden; }
  #aux-open-wrap { width: 100%; height: 100%; display: flex; flex-direction: row; }
  #aux-open-wrap[data-side-panel-open="false"] { display: none; }
  [data-side-panel-focus-scope="true"] { position: relative; width: 100%; height: 100%; display: flex; flex-direction: column; }
  .host-deep-sash-wrap { position: relative; flex: 1 1 auto; display: flex; flex-direction: column; min-width: 0; overflow: hidden; }
  .host-deep-sash-l1 { position: relative; flex: 1 1 auto; display: flex; }
  .host-deep-sash-l2 { position: relative; flex: 1 1 auto; display: flex; }
  .host-deep-sash-l3 { position: relative; flex: 1 1 auto; display: flex; }
  .host-deep-sash-l4 { position: relative; flex: 1 1 auto; display: flex; }
  .deep-native-resize-handle { position: absolute; left: 0; top: 0; bottom: 0; width: 8px; cursor: col-resize; z-index: 120; }
  .host-browser-body { flex: 1 1 auto; padding: 12px; background: #19191c; }
</style>
</head>
<body>
  <div data-testid="title-menu-bar">Antigravity</div>
  <div id="workspace-row">
    <div id="session-split-group">
      <div class="split-pane-abs" id="abs-pane-1" data-pane-id="p1" data-cascade-id="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" data-focused="true">
        <div class="conv-view" data-testid="conversation-view" data-cascade-id="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa">Session 1 History</div>
        <form class="surface-composer"><div contenteditable="true" data-lexical-editor="true"></div></form>
      </div>
      <div class="native-pane-sash" id="native-pane-sash" role="separator"></div>
      <div class="split-pane-abs" id="abs-pane-2" data-pane-id="p2" data-cascade-id="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb">
        <div class="conv-view" data-testid="conversation-view" data-cascade-id="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb">Session 2 Welcome</div>
        <form class="surface-composer"><div contenteditable="true" data-lexical-editor="true"></div></form>
      </div>
    </div>
    <div class="host-outer-sash" id="host-outer-sash" role="separator"></div>
    <div id="aux-shell" style="width: 420px; flex-basis: 420px;">
      <div id="aux-open-wrap" data-side-panel-open="true">
        <div data-side-panel-focus-scope="true" id="aux-inner">
          <div class="host-deep-sash-wrap" data-testid="host-browser-pane" id="browser-pane">
            <div class="host-deep-sash-l1"><div class="host-deep-sash-l2"><div class="host-deep-sash-l3"><div class="host-deep-sash-l4">
              <div class="deep-native-resize-handle" id="deep-native-handle" data-panel-resize-handle-id="deep-aux-handle"></div>
              <div class="host-browser-body">Host Browser Preview <iframe src="about:blank" style="width:100%;height:120px;border:0;"></iframe></div>
            </div></div></div></div>
          </div>
        </div>
      </div>
    </div>
  </div>
  <script>
    // 模拟宿主 SplitView：按 group 当前宽度 + splitRatio 布局绝对定位的双会话，响应 window.resize
    window.__hostSplitRatio = 0.5;
    window.__hostSidePanelByPane = { p1: true, p2: false };
    window.__relayoutHostSplitView = function() {
      const grp = document.getElementById('session-split-group');
      const p1 = document.getElementById('abs-pane-1');
      const p2 = document.getElementById('abs-pane-2');
      const sep = document.getElementById('native-pane-sash');
      const gw = Math.max(0, Math.round(grp.getBoundingClientRect().width));
      const w1 = Math.max(120, Math.round((gw - 4) * window.__hostSplitRatio));
      const w2 = Math.max(120, gw - 4 - w1);
      p1.style.left = '0px';
      p1.style.width = w1 + 'px';
      sep.style.left = w1 + 'px';
      p2.style.left = (w1 + 4) + 'px';
      p2.style.width = w2 + 'px';
    };
    window.addEventListener('resize', () => window.__relayoutHostSplitView());
    window.__setHostFocusedPane = function(pid) {
      const p1 = document.getElementById('abs-pane-1');
      const p2 = document.getElementById('abs-pane-2');
      p1.setAttribute('data-focused', pid === 'p1' ? 'true' : 'false');
      p2.setAttribute('data-focused', pid === 'p2' ? 'true' : 'false');
      const open = Boolean(window.__hostSidePanelByPane[pid]);
      const openWrap = document.getElementById('aux-open-wrap');
      const sash = document.getElementById('host-outer-sash');
      openWrap.setAttribute('data-side-panel-open', open ? 'true' : 'false');
      sash.hidden = !open;
      window.__relayoutHostSplitView();
    };
    document.getElementById('abs-pane-1').addEventListener('pointerdown', () => window.__setHostFocusedPane('p1'));
    document.getElementById('abs-pane-2').addEventListener('pointerdown', () => window.__setHostFocusedPane('p2'));
    window.__relayoutHostSplitView();
  </script>
</body>
</html>`;

  const session = await launchBrowserSession({
    customHtml: dualRealHtml,
    width: 1440,
    height: 900,
    dockPosition: 'aux',
    auxViewTab: 'both',
    auxOrder: 'browser-first',
    auxWidthPx: 760,
    auxPluginSharePx: 440 // 故意让初始浏览器正好 319~320px 紧贴下限，同时插件有 140px 富余！
  });
  try {
    const { cdp } = session;
    await new Promise(r => setTimeout(r, 240));

    // A. 验证刚进入双会话 + browser-first（未拖动任何两会话分割线）：
    //    1) 会话 1 与会话 2 零重叠、各自完整位于 session-split-group 内；
    //    2) 深层原生侧栏拖条 #deep-native-handle 已被隐藏，不会拦截鼠标；
    //    3) 直接抓住浏览器左线 [data-ag-ws-splitter="outer-left"] 向左拖 -100px 与向右拖 +120px 均立即可动！
    const initial = await cdp.evaluate(`(() => {
      const grp = document.getElementById('session-split-group').getBoundingClientRect();
      const p1 = document.getElementById('abs-pane-1').getBoundingClientRect();
      const p2 = document.getElementById('abs-pane-2').getBoundingClientRect();
      const brw = document.getElementById('browser-pane').getBoundingClientRect();
      const plug = document.getElementById('ag-context-meter').getBoundingClientRect();
      const sep = document.querySelector('[data-ag-ws-splitter="outer-left"]');
      const sepR = sep ? sep.getBoundingClientRect() : null;
      const deepHandle = document.getElementById('deep-native-handle');
      const deepDisp = deepHandle ? window.getComputedStyle(deepHandle).display : '';
      return {
        grpW: Math.round(grp.width),
        p1Right: Math.round(p1.right), p1W: Math.round(p1.width),
        p2Left: Math.round(p2.left), p2Right: Math.round(p2.right), p2W: Math.round(p2.width),
        brwLeft: Math.round(brw.left), brwW: Math.round(brw.width),
        plugW: Math.round(plug.width),
        sepX: sepR ? Math.round((sepR.left + sepR.right) / 2) : -1,
        deepDisp
      };
    })()`);
    assert.ok(initial.p1Right <= initial.p2Left + 1, `双会话进入并排后严禁重叠: ${JSON.stringify(initial)}`);
    assert.ok(initial.p2Right <= initial.grpW + 2, `会话 2 右缘严禁溢出被浏览器裁切: ${JSON.stringify(initial)}`);
    assert.equal(initial.deepDisp, 'none', `深层原生侧栏拖条必须被彻底隐藏防止抢热区: ${JSON.stringify(initial)}`);
    assert.ok(initial.sepX > 200, `必须存在可见 outer-left 浏览器左分隔线: ${JSON.stringify(initial)}`);

    // 直接向左拖浏览器左线 -100px（无需先动会话 1|2 分割线！）
    await dispatchRealMouseDrag(cdp, { startX: initial.sepX, startY: 400, endX: initial.sepX - 100, endY: 400, steps: 8, skipSnapshot: true });
    await new Promise(r => setTimeout(r, 150));
    const afterLeftDrag = await cdp.evaluate(`(() => {
      const brw = document.getElementById('browser-pane').getBoundingClientRect();
      const plug = document.getElementById('ag-context-meter').getBoundingClientRect();
      const grp = document.getElementById('session-split-group').getBoundingClientRect();
      const sep = document.querySelector('[data-ag-ws-splitter="outer-left"]').getBoundingClientRect();
      return {
        brwW: Math.round(brw.width),
        plugW: Math.round(plug.width),
        grpW: Math.round(grp.width),
        sepX: Math.round((sep.left + sep.right) / 2)
      };
    })()`);
    assert.ok(afterLeftDrag.brwW >= initial.brwW + 90, `无需先拖双会话线，浏览器左线左拖 -100px 必须立即增宽浏览器: before=${initial.brwW}, after=${afterLeftDrag.brwW}`);
    assert.ok(Math.abs(afterLeftDrag.plugW - initial.plugW) <= 2, `左拖浏览器左线时最右插件宽不变: before=${initial.plugW}, after=${afterLeftDrag.plugW}`);

    // 继续向右拖 +180px（突破浏览器 320px 下限后自动级联压缩最右插件，绝不锁死！）
    await dispatchRealMouseDrag(cdp, { startX: afterLeftDrag.sepX, startY: 400, endX: afterLeftDrag.sepX + 180, endY: 400, steps: 10, skipSnapshot: true });
    await new Promise(r => setTimeout(r, 150));
    const afterRightDrag = await cdp.evaluate(`(() => {
      const brw = document.getElementById('browser-pane').getBoundingClientRect();
      const plug = document.getElementById('ag-context-meter').getBoundingClientRect();
      const grp = document.getElementById('session-split-group').getBoundingClientRect();
      return { brwW: Math.round(brw.width), plugW: Math.round(plug.width), grpW: Math.round(grp.width) };
    })()`);
    assert.ok(afterRightDrag.grpW >= initial.grpW + 60, `向右拖突破浏览器下限时必须级联压缩插件、顺滑扩大双会话区: initGrp=${initial.grpW}, afterRight=${JSON.stringify(afterRightDrag)}`);
    assert.ok(afterRightDrag.brwW >= 318 && afterRightDrag.plugW >= 298, `级联压缩后浏览器与插件均不得跌破安全下限: ${JSON.stringify(afterRightDrag)}`);

    // B. 模拟真实点击第二个会话（空白新会话，宿主切换焦点至 p2 并将原生侧栏设 data-side-panel-open="false"，但浏览器子 DOM 仍在）：
    // 验证插件原地保活原生侧栏（插件 + 浏览器双双保留不消失！）；随后点击常驻关闭按钮，原生 aux-shell 归零且双会话立刻占满 1440px！
    const p2Center = await cdp.evaluate(`(() => {
      const r = document.getElementById('abs-pane-2').getBoundingClientRect();
      return { x: Math.round((r.left + r.right) / 2), y: Math.round((r.top + r.bottom) / 2) };
    })()`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p2Center.x, y: p2Center.y, button: 'left', buttons: 1, clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p2Center.x, y: p2Center.y, button: 'left', buttons: 0, clickCount: 1 });
    await new Promise(r => setTimeout(r, 340));

    const afterClickPane2Pinned = await cdp.evaluate(`(() => {
      const shell = document.getElementById('aux-shell').getBoundingClientRect();
      const brw = document.getElementById('browser-pane').getBoundingClientRect();
      const pinnedDock = document.getElementById('ag-ws-pinned-aux-dock');
      const hostEl = document.getElementById('ag-context-meter');
      const panelEl = hostEl?.shadowRoot?.getElementById('panel');
      return {
        shellW: Math.round(shell.width),
        brwW: Math.round(brw.width),
        plugW: Math.round(hostEl.getBoundingClientRect().width),
        pinnedPresent: Boolean(pinnedDock && pinnedDock.isConnected),
        panelHidden: Boolean(panelEl?.hidden)
      };
    })()`);
    assert.ok(afterClickPane2Pinned.plugW >= 280 && !afterClickPane2Pinned.panelHidden, `点击空白会话 2 时，右侧插件侧边栏必须保持常驻可见: ${JSON.stringify(afterClickPane2Pinned)}`);
    assert.ok(afterClickPane2Pinned.brwW >= 300, `点击空白会话 2 时，原生浏览器也必须与插件一同保留不可见消失: ${JSON.stringify(afterClickPane2Pinned)}`);

    // 主动点击头栏关闭按钮 -> 彻底退出保活与卸载常驻槽，归还 1440px 满屏给双会话且原生 aux-shell 归零零黑洞
    await cdp.evaluate(`(() => {
      const btn = document.getElementById('ag-context-meter')?.shadowRoot?.getElementById('close');
      btn?.click();
    })()`);
    await new Promise(r => setTimeout(r, 220));

    const afterClickPane2 = await cdp.evaluate(`(() => {
      const row = document.getElementById('workspace-row').getBoundingClientRect();
      const grp = document.getElementById('session-split-group').getBoundingClientRect();
      const p1 = document.getElementById('abs-pane-1').getBoundingClientRect();
      const p2 = document.getElementById('abs-pane-2').getBoundingClientRect();
      const shell = document.getElementById('aux-shell').getBoundingClientRect();
      const shellInlineW = document.getElementById('aux-shell').style.width || '';
      return {
        rowW: Math.round(row.width),
        grpW: Math.round(grp.width),
        p1W: Math.round(p1.width),
        p2W: Math.round(p2.width),
        p2Right: Math.round(p2.right),
        shellW: Math.round(shell.width),
        shellInlineW
      };
    })()`);
    assert.equal(afterClickPane2.shellW, 0, `主动关闭常驻侧栏后 aux-shell 必须归零，严禁留纯黑空洞: ${JSON.stringify(afterClickPane2)}`);
    assert.equal(afterClickPane2.grpW, 1440, `主动关闭侧栏后双会话容器必须自动占满 1440px，无需拖动中间分割线: ${JSON.stringify(afterClickPane2)}`);
    assert.ok(afterClickPane2.p1W >= 700 && afterClickPane2.p2W >= 700, `主动关闭侧栏后双会话各自正常铺开 ~720px: ${JSON.stringify(afterClickPane2)}`);

    // C. 点击第一个会话（宿主切回 p1 并重新打开侧栏）-> 验证插件内容自动恢复不黑屏，且双会话零重叠
    const p1Center = await cdp.evaluate(`(() => {
      const r = document.getElementById('abs-pane-1').getBoundingClientRect();
      return { x: Math.round((r.left + r.right) / 2), y: Math.round((r.top + r.bottom) / 2) };
    })()`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p1Center.x, y: p1Center.y, button: 'left', buttons: 1, clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p1Center.x, y: p1Center.y, button: 'left', buttons: 0, clickCount: 1 });
    await new Promise(r => setTimeout(r, 320));

    const afterBackToPane1 = await cdp.evaluate(`(() => {
      const hostEl = document.getElementById('ag-context-meter');
      const panelEl = hostEl?.shadowRoot?.getElementById('panel');
      const panelRect = panelEl ? panelEl.getBoundingClientRect() : null;
      const p1 = document.getElementById('abs-pane-1').getBoundingClientRect();
      const p2 = document.getElementById('abs-pane-2').getBoundingClientRect();
      const grp = document.getElementById('session-split-group').getBoundingClientRect();
      return {
        panelHidden: Boolean(panelEl?.hidden),
        panelH: panelRect ? Math.round(panelRect.height) : 0,
        panelW: panelRect ? Math.round(panelRect.width) : 0,
        p1Right: Math.round(p1.right),
        p2Left: Math.round(p2.left),
        p2Right: Math.round(p2.right),
        grpW: Math.round(grp.width)
      };
    })()`);
    assert.equal(afterBackToPane1.panelHidden, false, `点回会话 1 重开侧栏后主面板严禁保持 hidden 变黑屏空壳: ${JSON.stringify(afterBackToPane1)}`);
    assert.ok(afterBackToPane1.panelH >= 300 && afterBackToPane1.panelW >= 260, `点回会话 1 重开侧栏后插件内容区必须完整渲染: ${JSON.stringify(afterBackToPane1)}`);
    assert.ok(afterBackToPane1.p1Right <= afterBackToPane1.p2Left + 1 && afterBackToPane1.p2Right <= afterBackToPane1.grpW + 2, `点回会话 1 后双会话必须保持零重叠零裁切: ${JSON.stringify(afterBackToPane1)}`);
  } finally {
    await session.close();
  }
});

test('真实 Chromium 回归 7: 跨会话侧边栏常驻不随切会话消失、免先点会话直接拖分隔线与上下文界面流畅度门禁', async () => {
  const persistentDualHtml = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; width: 1440px; height: 900px; overflow: hidden; background: #141414; color: #f4f4f4; font-family: system-ui, sans-serif; }
  [data-testid="title-menu-bar"] { position: relative; display: flex; align-items: center; height: 32px; background: #181818; border-bottom: 1px solid rgba(255,255,255,0.08); padding: 0 12px; }
  .workspace-row { display: flex; flex-direction: row; width: 1440px; height: 868px; overflow: hidden; position: relative; }
  #flat-pane-1, #flat-pane-2 {
    height: 100%;
    display: flex;
    flex-direction: column;
    background: #151515;
    min-width: 180px;
    overflow: hidden;
  }
  #flat-pane-1 { width: 420px; flex: 0 0 auto; }
  #flat-pane-2 { flex: 1 1 auto; }
  .pane-header {
    height: 34px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 10px;
    border-bottom: 1px solid rgba(255,255,255,0.08);
    background: #181818;
    font-size: 12px;
  }
  .pane-header-actions { display: inline-flex; align-items: center; gap: 6px; }
  .pane-header-actions button {
    height: 24px; padding: 0 6px; background: transparent; color: #d4d4d8;
    border: 1px solid rgba(255,255,255,0.12); border-radius: 4px; cursor: pointer; font-size: 11px;
  }
  #native-dual-sash {
    width: 4px; flex: 0 0 4px; height: 100%; cursor: col-resize; background: rgba(255,255,255,0.08); z-index: 20;
  }
  .conv-view { flex: 1 1 auto; padding: 12px; overflow: auto; }
  .surface-composer { height: 56px; margin: 8px; border: 1px solid rgba(255,255,255,0.12); border-radius: 8px; padding: 6px; }
  .host-outer-sash { flex: 0 0 1px; width: 1px; height: 100%; cursor: col-resize; background: rgba(255,255,255,0.12); }
  #aux-shell { position: relative; flex: 0 0 560px; width: 560px; height: 100%; display: flex; flex-direction: row; background: #171717; }
  #aux-open-wrap { position: relative; flex: 1 1 auto; width: 100%; height: 100%; display: flex; flex-direction: row; }
  #aux-open-wrap[data-side-panel-open="false"] { display: none; }
  [data-side-panel-focus-scope="true"] { position: relative; flex: 1 1 auto; width: 100%; height: 100%; display: flex; flex-direction: column; overflow: hidden; }
  [data-testid="host-browser-pane"] { flex: 1 1 auto; background: #161616; padding: 12px; }
</style>
</head>
<body>
  <div data-testid="title-menu-bar"><span>Antigravity</span></div>
  <div class="workspace-row" id="workspace-row">
    <div id="flat-pane-1" data-pane-id="p1" data-focused="true">
      <div class="pane-header">
        <span>会话 1</span>
        <div class="pane-header-actions">
          <button type="button" id="p1-close">×</button>
          <button type="button" id="p1-open-ide">Open IDE</button>
          <button type="button" id="p1-overview-btn" title="Overview"><svg width="14" height="14" viewBox="0 0 16 16"></svg></button>
        </div>
      </div>
      <div class="conv-view" data-testid="conversation-view" data-cascade-id="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa">Session 1 Messages</div>
      <form class="surface-composer"><div contenteditable="true" data-lexical-editor="true"></div></form>
    </div>
    <div id="native-dual-sash" role="separator"></div>
    <div id="flat-pane-2" data-pane-id="p2" data-focused="false">
      <div class="pane-header">
        <span>会话 2</span>
        <div class="pane-header-actions">
          <button type="button" id="p2-close">×</button>
          <button type="button" id="p2-open-ide">Open IDE</button>
          <button type="button" id="p2-toggle-side"><svg width="14" height="14" viewBox="0 0 16 16"></svg></button>
        </div>
      </div>
      <div class="conv-view" data-testid="conversation-view" data-cascade-id="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb">Session 2 Welcome</div>
      <form class="surface-composer"><div contenteditable="true" data-lexical-editor="true"></div></form>
    </div>
    <div class="host-outer-sash" id="host-outer-sash" role="separator"></div>
    <div id="aux-shell">
      <div id="aux-open-wrap" data-side-panel-open="true" style="position:relative;">
        <div style="position:absolute;top:6px;right:8px;display:flex;align-items:center;gap:4px;z-index:200;">
          <button type="button" id="aux-max-btn" aria-label="Toggle Maximize Side Panel" style="width:24px;height:24px;"><svg width="14" height="14" viewBox="0 0 16 16"></svg></button>
          <button type="button" id="aux-close-side-btn" style="width:24px;height:24px;"><svg width="14" height="14" viewBox="0 0 16 16"></svg></button>
        </div>
        <div data-side-panel-focus-scope="true" id="aux-inner">
          <div data-testid="host-browser-pane" id="browser-pane">Host Browser</div>
        </div>
      </div>
    </div>
  </div>
  <script>
    window.__hostSidePanelByPane = { p1: true, p2: false };
    window.__hostFocusedPane = 'p1';
    window.__p1CloseClicks = 0;
    window.__p2CloseClicks = 0;
    window.__p1OverviewClicks = 0;
    window.__renderHostSidePanel = function() {
      const open = Boolean(window.__hostSidePanelByPane[window.__hostFocusedPane]);
      const openWrap = document.getElementById('aux-open-wrap');
      const shell = document.getElementById('aux-shell');
      const sash = document.getElementById('host-outer-sash');
      const topToggle = document.getElementById('p2-toggle-side');
      openWrap.setAttribute('data-side-panel-open', open ? 'true' : 'false');
      sash.hidden = !open;
      if (topToggle) topToggle.hidden = open;
      if (!open) {
        shell.style.width = '0px';
        shell.style.flexBasis = '0px';
      } else if (!shell.style.width || shell.style.width === '0px') {
        shell.style.width = '560px';
        shell.style.flexBasis = '560px';
      }
    };
    window.__focusPane = function(pid) {
      window.__hostFocusedPane = pid;
      document.getElementById('flat-pane-1').setAttribute('data-focused', pid === 'p1' ? 'true' : 'false');
      document.getElementById('flat-pane-2').setAttribute('data-focused', pid === 'p2' ? 'true' : 'false');
      window.__renderHostSidePanel();
    };
    document.getElementById('p1-close').addEventListener('click', () => { window.__p1CloseClicks++; });
    document.getElementById('p2-close').addEventListener('click', () => { window.__p2CloseClicks++; });
    document.getElementById('p1-overview-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      window.__p1OverviewClicks++;
    });
    const toggleFocusedSidePanel = (e) => {
      e.stopPropagation();
      const pid = window.__hostFocusedPane || 'p1';
      window.__hostSidePanelByPane[pid] = !window.__hostSidePanelByPane[pid];
      window.__renderHostSidePanel();
    };
    document.getElementById('p2-toggle-side').addEventListener('click', toggleFocusedSidePanel);
    document.getElementById('aux-close-side-btn').addEventListener('click', toggleFocusedSidePanel);
    window.__renderHostSidePanel();
    document.getElementById('flat-pane-1').addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      window.__focusPane('p1');
    });
    document.getElementById('flat-pane-2').addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      window.__focusPane('p2');
    });
    // 模拟宿主原生双会话分隔线（修改 flat-pane-1.style.width）
    (function() {
      const sash = document.getElementById('native-dual-sash');
      const p1 = document.getElementById('flat-pane-1');
      let startX = 0, startW = 0, active = false;
      sash.addEventListener('pointerdown', (e) => {
        active = true;
        startX = e.clientX;
        startW = Math.round(p1.getBoundingClientRect().width);
        e.preventDefault();
      });
      window.addEventListener('pointermove', (e) => {
        if (!active) return;
        const nextW = Math.max(200, Math.min(620, startW + (e.clientX - startX)));
        p1.style.width = nextW + 'px';
      });
      window.addEventListener('pointerup', () => { active = false; });
    })();
  </script>
</body>
</html>`;

  const session = await launchBrowserSession({
    customHtml: persistentDualHtml,
    width: 1440,
    height: 900,
    dockPosition: 'aux',
    auxViewTab: 'plugin',
    auxWidthPx: 560
  });
  try {
    const { cdp } = session;
    await cdp.send('Performance.enable');
    await new Promise(r => setTimeout(r, 300));

    // 打开上下文面板以覆盖真实上下文渲染场景
    await cdp.evaluate(`(() => {
      const sr = document.getElementById('ag-context-meter')?.shadowRoot;
      const p = sr?.getElementById('panel');
      if (p?.hidden) sr?.getElementById('badge')?.click();
    })()`);
    await new Promise(r => setTimeout(r, 260));

    // === 1. 验证免先点会话直接拖分隔线（当前焦点在会话 1，直接拖会话 1|2 原生分隔线，以及直接从交界偏左 2px 拖会话 2|插件分隔线） ===
    const beforeNativeDrag = await cdp.evaluate(`(() => {
      const p1 = document.getElementById('flat-pane-1').getBoundingClientRect();
      const sash = document.getElementById('native-dual-sash').getBoundingClientRect();
      const hostR = document.getElementById('ag-context-meter').getBoundingClientRect();
      return {
        p1W: Math.round(p1.width),
        sashX: Math.round((sash.left + sash.right) / 2),
        plugLeft: Math.round(hostR.left),
        plugW: Math.round(hostR.width)
      };
    })()`);
    await dispatchRealMouseDrag(cdp, { startX: beforeNativeDrag.sashX, startY: 400, endX: beforeNativeDrag.sashX - 90, endY: 400, steps: 6, skipSnapshot: true });
    await new Promise(r => setTimeout(r, 120));
    const afterNativeDrag = await cdp.evaluate(`(() => ({
      p1W: Math.round(document.getElementById('flat-pane-1').getBoundingClientRect().width),
      focused: window.__hostFocusedPane
    }))()`);
    assert.ok(afterNativeDrag.p1W <= beforeNativeDrag.p1W - 75, `不先点会话直接拖双会话原生分隔线必须立即生效，严禁被 flex-basis:0 锁死: before=${beforeNativeDrag.p1W}, after=${afterNativeDrag.p1W}`);

    // 直接从会话 2|插件交界线偏左 2px 抓取并向左拖 -100px（焦点仍在会话 1，不得误切焦点也不得拖不动）
    await dispatchRealMouseDrag(cdp, { startX: beforeNativeDrag.plugLeft - 2, startY: 420, endX: beforeNativeDrag.plugLeft - 102, endY: 420, steps: 8, skipSnapshot: true });
    await new Promise(r => setTimeout(r, 150));
    const afterOuterDrag = await cdp.evaluate(`(() => ({
      plugW: Math.round(document.getElementById('ag-context-meter').getBoundingClientRect().width),
      focused: window.__hostFocusedPane
    }))()`);
    assert.ok(afterOuterDrag.plugW >= beforeNativeDrag.plugW + 85, `焦点在会话 1 时直接抓会话 2|插件边界偏左 2px 必须立刻可拖: before=${beforeNativeDrag.plugW}, after=${afterOuterDrag.plugW}`);
    assert.equal(afterOuterDrag.focused, 'p1', '从交界偏左 2px 抓取插件分隔线严禁漏点进会话 2 导致误切焦点');

    // === 2. 验证跨会话侧边栏常驻（点击会话 2 时侧边栏不得消失，而是自动同步打开常驻；且严禁误点关闭会话 ×） ===
    const p2Pt = await cdp.evaluate(`(() => {
      const r = document.getElementById('flat-pane-2').querySelector('.conv-view').getBoundingClientRect();
      return { x: Math.round((r.left + r.right) / 2), y: Math.round((r.top + r.bottom) / 2) };
    })()`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p2Pt.x, y: p2Pt.y, button: 'left', buttons: 1, clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p2Pt.x, y: p2Pt.y, button: 'left', buttons: 0, clickCount: 1 });
    await new Promise(r => setTimeout(r, 320));

    const afterSwitchToP2 = await cdp.evaluate(`(() => {
      const openWrap = document.getElementById('aux-open-wrap');
      const hostEl = document.getElementById('ag-context-meter');
      const panelEl = hostEl?.shadowRoot?.getElementById('panel');
      return {
        focused: window.__hostFocusedPane,
        p2SideOpenFlag: Boolean(window.__hostSidePanelByPane.p2),
        domSideOpen: openWrap.getAttribute('data-side-panel-open'),
        panelHidden: Boolean(panelEl?.hidden),
        plugW: Math.round(hostEl.getBoundingClientRect().width),
        p1CloseClicks: window.__p1CloseClicks,
        p2CloseClicks: window.__p2CloseClicks,
        p1OverviewClicks: window.__p1OverviewClicks
      };
    })()`);
    assert.equal(afterSwitchToP2.focused, 'p2');
    assert.equal(afterSwitchToP2.domSideOpen, 'true', `切换到会话 2 后侧边栏必须自动保持常驻打开，严禁收起消失: ${JSON.stringify(afterSwitchToP2)}`);
    assert.equal(afterSwitchToP2.p2SideOpenFlag, true, `必须同步打开会话 2 侧栏状态以实现后续零闪烁切换: ${JSON.stringify(afterSwitchToP2)}`);
    assert.equal(afterSwitchToP2.panelHidden, false, `切到会话 2 后上下文面板必须持续可见: ${JSON.stringify(afterSwitchToP2)}`);
    assert.ok(afterSwitchToP2.plugW >= 300, `切到会话 2 后插件宽度必须保持正常: ${JSON.stringify(afterSwitchToP2)}`);
    assert.equal(afterSwitchToP2.p1CloseClicks + afterSwitchToP2.p2CloseClicks, 0, '同步侧栏严禁误点任何会话的关闭按钮 ×');
    assert.equal(afterSwitchToP2.p1OverviewClicks, 0, '同步侧栏严禁误点左侧会话 1 的 Overview [≡] 概览按钮');

    // === 3. 验证用户主动点击侧栏右上角关闭按钮被 100% 尊重（关闭后零黑洞，且切回会话 1 不会突兀弹回） ===
    const closeSidePt = await cdp.evaluate(`(() => {
      const r = document.getElementById('aux-close-side-btn').getBoundingClientRect();
      return { x: Math.round((r.left + r.right) / 2), y: Math.round((r.top + r.bottom) / 2) };
    })()`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: closeSidePt.x, y: closeSidePt.y, button: 'left', buttons: 1, clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: closeSidePt.x, y: closeSidePt.y, button: 'left', buttons: 0, clickCount: 1 });
    await new Promise(r => setTimeout(r, 320));
    const afterManualClose = await cdp.evaluate(`(() => ({
      domSideOpen: document.getElementById('aux-open-wrap').getAttribute('data-side-panel-open'),
      shellW: Math.round(document.getElementById('aux-shell').getBoundingClientRect().width)
    }))()`);
    assert.equal(afterManualClose.domSideOpen, 'false', `用户主动点击侧栏右上角 Toggle Side Panel 必须正常关闭侧栏: ${JSON.stringify(afterManualClose)}`);
    assert.equal(afterManualClose.shellW, 0, `主动关闭侧栏后右侧必须零黑洞: ${JSON.stringify(afterManualClose)}`);

    // 切回会话 1：尊重用户主动关闭意图，自动对齐保持关闭而非突兀弹出，且绝不误点 Overview
    const p1Pt = await cdp.evaluate(`(() => {
      const r = document.getElementById('flat-pane-1').querySelector('.conv-view').getBoundingClientRect();
      return { x: Math.round((r.left + r.right) / 2), y: Math.round((r.top + r.bottom) / 2) };
    })()`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p1Pt.x, y: p1Pt.y, button: 'left', buttons: 1, clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p1Pt.x, y: p1Pt.y, button: 'left', buttons: 0, clickCount: 1 });
    await new Promise(r => setTimeout(r, 320));
    const afterBackWhileClosed = await cdp.evaluate(`(() => ({
      domSideOpen: document.getElementById('aux-open-wrap').getAttribute('data-side-panel-open'),
      p1SideFlag: Boolean(window.__hostSidePanelByPane.p1),
      p1OverviewClicks: window.__p1OverviewClicks
    }))()`);
    assert.equal(afterBackWhileClosed.domSideOpen, 'false', `主动关闭侧栏后切回会话 1 不得突兀重新弹出: ${JSON.stringify(afterBackWhileClosed)}`);
    assert.equal(afterBackWhileClosed.p1OverviewClicks, 0, '回切会话 1 同步关闭侧栏严禁误点 Overview 按钮');

    // 再由用户主动点击顶栏最右上角 Toggle Side Panel 打开，验证恢复后实测上下文界面拖拽流畅度
    const reopenTogglePt = await cdp.evaluate(`(() => {
      const r = document.getElementById('p2-toggle-side').getBoundingClientRect();
      return { x: Math.round((r.left + r.right) / 2), y: Math.round((r.top + r.bottom) / 2) };
    })()`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: reopenTogglePt.x, y: reopenTogglePt.y, button: 'left', buttons: 1, clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: reopenTogglePt.x, y: reopenTogglePt.y, button: 'left', buttons: 0, clickCount: 1 });
    await new Promise(r => setTimeout(r, 320));

    // === 4. 上下文界面 120 次高频拖拽流畅度硬性门禁（对比优化前 748 Layout / 1864 RecalcStyle） ===
    const perfStartInfo = await cdp.evaluate(`(() => {
      const sr = document.getElementById('ag-context-meter').shadowRoot;
      const p = sr.getElementById('panel');
      if (p?.hidden) sr.getElementById('badge')?.click();
      const r = sr.getElementById('dock-aux-resizer').getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + 260), ctxHidden: Boolean(p?.hidden) };
    })()`);
    assert.equal(perfStartInfo.ctxHidden, false, '性能校验前上下文界面必须处于可见打开状态');

    const toMetricMap = arr => Object.fromEntries((arr || []).map(x => [x.name, x.value]));
    const m0 = toMetricMap((await cdp.send('Performance.getMetrics')).metrics);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: perfStartInfo.x, y: perfStartInfo.y, button: 'left', buttons: 1, clickCount: 1 });
    for (let i = 1; i <= 40; i++) {
      const dx = Math.round(Math.sin(i / 6) * 200);
      for (let sub = 0; sub < 3; sub++) {
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: perfStartInfo.x + dx + sub, y: perfStartInfo.y, button: 'left', buttons: 1 });
      }
    }
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: perfStartInfo.x, y: perfStartInfo.y, button: 'left', buttons: 0, clickCount: 1 });
    await new Promise(r => setTimeout(r, 120));
    const m1 = toMetricMap((await cdp.send('Performance.getMetrics')).metrics);
    const layoutCount = Math.round((m1.LayoutCount || 0) - (m0.LayoutCount || 0));
    const recalcCount = Math.round((m1.RecalcStyleCount || 0) - (m0.RecalcStyleCount || 0));
    const leftoverOffscreen = await cdp.evaluate(`(() => {
      const sr = document.getElementById('ag-context-meter').shadowRoot;
      return sr.querySelectorAll('[data-ag-drag-offscreen="true"]').length;
    })()`);
    assert.equal(leftoverOffscreen, 0, '松手后必须立刻清除全部屏外冻结标记');
    assert.ok(layoutCount <= 220, `上下文界面 120 次高频拖拽 LayoutCount 必须大幅收敛 (<=220)，实际: ${layoutCount}`);
    assert.ok(recalcCount <= 600, `上下文界面 120 次高频拖拽 RecalcStyleCount 必须大幅收敛 (<=600)，实际: ${recalcCount}`);
  } finally {
    await session.close();
  }
});

test('真实 Chromium 回归 8: 全分隔线永不回滚(621..659px/单插件>920px/React覆写)、空白与多会话(2/3/4)常驻不收起、零误点Overview与零浮窗鬼影', async () => {
  const round5Html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; width: 1680px; height: 900px; overflow: hidden; background: #141414; color: #f4f4f4; font-family: system-ui, sans-serif; }
  [data-testid="title-menu-bar"] { position: relative; display: flex; align-items: center; height: 32px; background: #181818; border-bottom: 1px solid rgba(255,255,255,0.08); padding: 0 12px; }
  .workspace-row { display: flex; flex-direction: row; width: 1680px; height: 868px; overflow: hidden; position: relative; }
  .session-pane {
    flex: 1 1 0px;
    min-width: 140px;
    height: 100%;
    display: flex;
    flex-direction: column;
    background: #151515;
    overflow: hidden;
    border-right: 1px solid rgba(255,255,255,0.06);
  }
  .pane-header {
    height: 40px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    padding: 0 10px;
    border-bottom: 1px solid rgba(255,255,255,0.08);
    flex: 0 0 40px;
  }
  .pane-header > span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; font-size: 12px; }
  .pane-header-actions { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
  .pane-header-actions button {
    height: 24px; min-width: 24px; padding: 0 6px; background: #222; color: #ddd;
    border: 1px solid rgba(255,255,255,0.12); border-radius: 4px; cursor: pointer; font-size: 12px;
  }
  .conv-view { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 12px; font-size: 13px; color: #aaa; }
  .conv-msg { padding: 12px 10px; margin-bottom: 10px; border-radius: 6px; background: #1c1c1f; line-height: 1.6; }
  form.surface-composer { padding: 10px; border-top: 1px solid rgba(255,255,255,0.08); }
  form.surface-composer [contenteditable="true"] { min-height: 28px; background: #1d1d1d; border-radius: 6px; padding: 4px 8px; }
  #aux-shell {
    flex: 0 0 780px;
    width: 780px;
    height: 100%;
    display: flex;
    flex-direction: row;
    overflow: hidden;
    transition: width 250ms ease, flex-basis 250ms ease;
  }
  #aux-open-wrap { display: flex; flex: 1 1 auto; width: 100%; height: 100%; overflow: hidden; }
  #aux-open-wrap[data-side-panel-open="false"] { display: none; }
  [data-side-panel-focus-scope="true"] { flex: 1 1 auto; display: flex; flex-direction: column; width: 100%; height: 100%; overflow: hidden; background: #1a1a1a; }
  #browser-pane { flex: 1 1 auto; min-width: 0; background: #171b24; display: flex; flex-direction: column; padding: 8px; }
  #browser-url-input { width: 100%; height: 28px; background: #111; color: #eee; border: 1px solid #333; border-radius: 6px; padding: 0 8px; }
</style>
</head>
<body>
  <div data-testid="title-menu-bar"><span>Antigravity</span></div>
  <div class="workspace-row" id="workspace-row">
    <div class="session-pane" id="pane-1" data-pane-id="p1" data-focused="true">
      <div class="pane-header">
        <span>会话 1</span>
        <div class="pane-header-actions">
          <button type="button" id="p1-close">×</button>
          <button type="button" id="p1-open-ide">Open IDE</button>
          <button type="button" id="p1-overview-btn"><svg width="14" height="14" viewBox="0 0 16 16"></svg></button>
        </div>
      </div>
      <div class="conv-view" data-testid="conversation-view" data-cascade-id="11111111-1111-4111-8111-111111111111">Session 1 Active</div>
      <form class="surface-composer"><div contenteditable="true" data-lexical-editor="true"></div></form>
    </div>
    <div class="session-pane" id="pane-2" data-pane-id="p2" data-focused="false">
      <div class="pane-header">
        <span>会话 2 (空白新建)</span>
        <div class="pane-header-actions">
          <button type="button" id="p2-close">×</button>
          <button type="button" id="p2-open-ide">Open IDE</button>
        </div>
      </div>
      <div class="conv-view" data-testid="conversation-view" data-cascade-id="">New Blank Session 2</div>
      <form class="surface-composer"><div contenteditable="true" data-lexical-editor="true"></div></form>
    </div>
    <div class="session-pane" id="pane-3" data-pane-id="p3" data-focused="false">
      <div class="pane-header">
        <span>会话 3 (已有对话)</span>
        <div class="pane-header-actions">
          <button type="button" id="p3-close">×</button>
          <button type="button" id="p3-open-ide">Open IDE</button>
          <button type="button" id="global-toggle-side" hidden><svg width="14" height="14" viewBox="0 0 16 16"></svg></button>
        </div>
      </div>
      <div class="conv-view" data-testid="conversation-view" data-cascade-id="33333333-3333-4333-8333-333333333333">Session 3 History</div>
      <form class="surface-composer"><div contenteditable="true" data-lexical-editor="true"></div></form>
    </div>
    <div id="aux-shell">
      <div id="aux-open-wrap" data-side-panel-open="true" style="position:relative;">
        <div style="position:absolute;top:6px;right:8px;display:flex;align-items:center;gap:4px;z-index:200;">
          <button type="button" id="aux-max-btn" aria-label="Toggle Maximize Side Panel" style="width:24px;height:24px;"><svg width="14" height="14" viewBox="0 0 16 16"></svg></button>
          <button type="button" id="aux-close-btn" style="width:24px;height:24px;"><svg width="14" height="14" viewBox="0 0 16 16"></svg></button>
        </div>
        <div data-side-panel-focus-scope="true" id="aux-inner">
          <div data-testid="host-browser-pane" id="browser-pane">
            <input id="browser-url-input" placeholder="Search or enter a URL" />
            <div>Host Browser Content</div>
          </div>
        </div>
      </div>
    </div>
  </div>
  <script>
    window.__hostState = {
      focused: 'p1',
      hasConv: { p1: true, p2: false, p3: true },
      sideOpen: { p1: true, p2: false, p3: false },
      overviewClicks: 0,
      closeClicks: 0,
      urlFocusCount: 0,
      wcvLog: []
    };
    // 填充会话 1 长对话消息（scrollHeight > 3000px）并模拟宿主在宽度变化时强行吸底的 ResizeObserver
    (function seedLongSession1() {
      const cv1 = document.querySelector('#pane-1 .conv-view');
      const frag = document.createDocumentFragment();
      for (let i = 1; i <= 40; i++) {
        const d = document.createElement('div');
        d.className = 'conv-msg';
        d.setAttribute('data-turn-index', String(i));
        d.textContent = '会话 1 历史消息段落 #' + i + ' — 用于验证拖拽第三根隔离线时会话 1 的阅读滚动进度条不会被拉到最下面，且文字折行重排后仍停在用户当前阅读位置。';
        frag.appendChild(d);
      }
      cv1.appendChild(frag);
      let prevW = Math.round(cv1.clientWidth);
      new ResizeObserver(() => {
        const w = Math.round(cv1.clientWidth);
        if (Math.abs(w - prevW) >= 12) {
          prevW = w;
          // 模拟宿主聊天窗口 ResizeObserver 误将滚动条吸到底部
          cv1.scrollTop = cv1.scrollHeight;
        }
      }).observe(cv1);
    })();
    window.electronNative = {
      wcvBrowser: {
        acquire: async (req) => { window.__hostState.wcvLog.push({ op: 'acquire', req }); return { ok: true }; },
        show: async (tabKey, bounds) => { window.__hostState.wcvLog.push({ op: 'show', tabKey, bounds }); return { ok: true }; },
        hide: async (tabKey) => { window.__hostState.wcvLog.push({ op: 'hide', tabKey }); return { ok: true }; },
        setBounds: async (tabKey, bounds) => { window.__hostState.wcvLog.push({ op: 'setBounds', tabKey, bounds }); },
        navigate: async (tabKey, url) => { window.__hostState.wcvLog.push({ op: 'navigate', tabKey, url }); },
        control: async (tabKey, action) => { window.__hostState.wcvLog.push({ op: 'control', tabKey, action }); },
        dispose: async (tabKey) => { window.__hostState.wcvLog.push({ op: 'dispose', tabKey }); },
        onGuestEvent: () => () => {}
      }
    };
    const __savedBrowserPane = document.getElementById('browser-pane');
    window.__renderHost = function() {
      const st = window.__hostState;
      const focused = st.focused;
      const supportsSide = Boolean(st.hasConv[focused]);
      const open = supportsSide && Boolean(st.sideOpen[focused]);
      const wrap = document.getElementById('aux-open-wrap');
      const shell = document.getElementById('aux-shell');
      const inner = document.getElementById('aux-inner');
      const topToggle = document.getElementById('global-toggle-side');
      wrap.setAttribute('data-side-panel-open', open ? 'true' : 'false');
      topToggle.hidden = !supportsSide || open;
      if (!open) {
        // 精准模拟 Antigravity 2.35.2 React 彻底 unmount 空白会话 2 的原生浏览器子节点
        if (__savedBrowserPane && __savedBrowserPane.parentElement === inner) {
          inner.removeChild(__savedBrowserPane);
        }
        shell.style.width = '0px';
        shell.style.flexBasis = '0px';
      } else {
        if (__savedBrowserPane && __savedBrowserPane.parentElement !== inner) {
          inner.appendChild(__savedBrowserPane);
        }
        if (!shell.style.width || shell.style.width === '0px') {
          shell.style.width = '780px';
          shell.style.flexBasis = '780px';
        }
      }
      for (const pid of ['p1', 'p2', 'p3']) {
        document.getElementById('pane-' + pid.slice(1)).setAttribute('data-focused', pid === focused ? 'true' : 'false');
      }
    };
    document.getElementById('p1-overview-btn').addEventListener('click', (e) => { e.stopPropagation(); window.__hostState.overviewClicks++; });
    for (const id of ['p1-close', 'p2-close', 'p3-close']) {
      document.getElementById(id).addEventListener('click', (e) => { e.stopPropagation(); window.__hostState.closeClicks++; });
    }
    document.getElementById('browser-url-input').addEventListener('focus', () => { window.__hostState.urlFocusCount++; });
    const doToggle = (e) => {
      e.stopPropagation();
      const f = window.__hostState.focused;
      if (!window.__hostState.hasConv[f]) return;
      window.__hostState.sideOpen[f] = !window.__hostState.sideOpen[f];
      window.__renderHost();
    };
    document.getElementById('global-toggle-side').addEventListener('click', doToggle);
    document.getElementById('aux-close-btn').addEventListener('click', doToggle);
    for (const pid of ['p1', 'p2', 'p3']) {
      document.getElementById('pane-' + pid.slice(1)).addEventListener('pointerdown', (e) => {
        if (e.target.closest('button')) return;
        window.__hostState.focused = pid;
        window.__renderHost();
      });
    }
    window.__renderHost();
  </script>
</body>
</html>`;

  const session = await launchBrowserSession({
    customHtml: round5Html,
    width: 1680,
    height: 900,
    dockPosition: 'aux',
    auxViewTab: 'both',
    auxOrder: 'browser-first',
    auxWidthPx: 780,
    auxPluginSharePx: 330
  });
  try {
    const { cdp } = session;
    await cdp.evaluate(`(() => {
      window.contextMeterAPI = {
        getSettings: async () => ({
          ok: true,
          dockPosition: 'aux',
          panelDockMode: 'aux',
          auxViewTab: 'both',
          auxOrder: 'browser-first',
          auxWidthPx: 780,
          auxTriWidthPx: 780,
          auxSingleWidthPx: 420,
          auxPluginSharePx: 330
        }),
        saveSettings: async () => ({ ok: true })
      };
      history.replaceState(null, '', '/c/11111111-1111-4111-8111-111111111111');
      const sr = document.getElementById('ag-context-meter')?.shadowRoot;
      if (sr?.getElementById('panel')?.hidden) sr.getElementById('badge')?.click();
    })()`);
    await new Promise(r => setTimeout(r, 260));

    // === 8A. 复现视频 3「回滚的问题.mp4」：browser-first 拉窄至 635px (< 660px 悬崖区) + 单插件拉宽至 1020px (> 920px) + React 覆写 + 过期 getSettings 回包，全部 100% 零回滚 ===
    const beforeRollbackTest = await cdp.evaluate(`(() => {
      const shell = document.getElementById('aux-shell');
      const sep = document.querySelector('[data-ag-ws-splitter="outer-left"]');
      const r = sep.getBoundingClientRect();
      return {
        auxW: Math.round(shell.getBoundingClientRect().width),
        shellTrans: shell.style.transition,
        sepX: Math.round((r.left + r.right) / 2),
        sepY: Math.round((r.top + r.bottom) / 2)
      };
    })()`);
    assert.equal(beforeRollbackTest.shellTrans, 'none', '接管期必须关闭宿主 CSS width transition 以消除动画卡顿拉扯');

    // 向右拖 +145px：总宽从 780px 缩窄至 ~635px（正落入旧代码 < 660px 死亡回滚悬崖区！）
    await dispatchRealMouseDrag(cdp, { startX: beforeRollbackTest.sepX, startY: beforeRollbackTest.sepY, endX: beforeRollbackTest.sepX + 145, endY: beforeRollbackTest.sepY, steps: 10, skipSnapshot: true });
    await new Promise(r => setTimeout(r, 120));
    const committedTriW = await cdp.evaluate(`Math.round(document.getElementById('aux-shell').getBoundingClientRect().width)`);
    assert.ok(committedTriW >= 621 && committedTriW <= 655, `browser-first 向右拉窄必须停在 621..655px 区间，实际=${committedTriW}`);

    // 模拟 2.5s 后宿主 React 重渲染偷偷把 auxShell.style.width 改回 780px + 过期 getSettings 回包 + syncAuxHostCoexistence
    await cdp.evaluate(`(async () => {
      const shell = document.getElementById('aux-shell');
      shell.style.width = '780px';
      shell.style.flexBasis = '780px';
      await window.__AGContextMeter.restoreSettingsForTest();
      window.__AGContextMeter.setAuxViewTabForTest('both', { persist: false });
    })()`);
    await new Promise(r => setTimeout(r, 200));
    const afterHostTamperTri = await cdp.evaluate(`({
      auxW: Math.round(document.getElementById('aux-shell').getBoundingClientRect().width),
      urlFocusCount: window.__hostState.urlFocusCount
    })`);
    assert.ok(Math.abs(afterHostTamperTri.auxW - committedTriW) <= 1, `browser-first 拉至 ${committedTriW}px 后遭遇宿主篡改/同步回包必须 0 回滚，实际=${afterHostTamperTri.auxW}`);
    assert.equal(afterHostTamperTri.urlFocusCount, 0, '拖浏览器左线 pointerdown 必须 stopPropagation，严禁误聚焦浏览器地址栏');

    // 单插件模式：向左拉宽到 1020px（超过旧 920px 硬顶），验证同样 100% 零回滚！
    await cdp.evaluate(`(() => {
      window.__AGContextMeter.switchAuxMode('plugin', { persist: false });
    })()`);
    await new Promise(r => setTimeout(r, 140));
    const singleStart = await cdp.evaluate(`(() => {
      const sr = document.getElementById('ag-context-meter').shadowRoot;
      const r = sr.getElementById('dock-aux-resizer').getBoundingClientRect();
      return { sepX: Math.round((r.left + r.right) / 2), auxW: Math.round(document.getElementById('aux-shell').getBoundingClientRect().width) };
    })()`);
    const pullLeftDx = Math.max(200, 1020 - singleStart.auxW);
    await dispatchRealMouseDrag(cdp, { startX: singleStart.sepX, startY: 420, endX: singleStart.sepX - pullLeftDx, endY: 420, steps: 10, skipSnapshot: true });
    await new Promise(r => setTimeout(r, 120));
    const committedSingleW = await cdp.evaluate(`Math.round(document.getElementById('aux-shell').getBoundingClientRect().width)`);
    assert.ok(committedSingleW >= 960, `单插件模式大屏拉宽必须可突破 920px，实际=${committedSingleW}`);
    await cdp.evaluate(`(async () => {
      const shell = document.getElementById('aux-shell');
      shell.style.width = '420px';
      await window.__AGContextMeter.restoreSettingsForTest();
      window.__AGContextMeter.setAuxViewTabForTest('plugin', { persist: false });
    })()`);
    await new Promise(r => setTimeout(r, 180));
    const afterHostTamperSingle = await cdp.evaluate(`Math.round(document.getElementById('aux-shell').getBoundingClientRect().width)`);
    assert.ok(Math.abs(afterHostTamperSingle - committedSingleW) <= 1, `单插件拉至 ${committedSingleW}px 后必须 0 回滚，实际=${afterHostTamperSingle}`);

    // 切回并排准备验证跨会话常驻 + 第六轮拖拽第 3 根隔离线会话 1 滚动条零跳底
    await cdp.evaluate(`window.__AGContextMeter.switchAuxMode('both', { persist: false });`);
    await new Promise(r => setTimeout(r, 180));

    // === 8D. 复现第六轮视频 1：拖从左数第 3 根隔离线（dock-aux-resizer）大幅左右拉伸，会话 1 的阅读滚动进度条严禁被强行吸到底部！ ===
    await cdp.evaluate(`(() => {
      // 切到 plugin-first 让第 3 根隔离线对应 dock-aux-resizer，再把会话 1 停在上方中间历史位置
      window.__AGContextMeter.setAuxOrderForTest('plugin-first', { persist: false });
      const cv1 = document.querySelector('#pane-1 .conv-view');
      cv1.scrollTop = 720;
    })()`);
    await new Promise(r => setTimeout(r, 140));
    const scrollBeforeDrag = await cdp.evaluate(`(() => {
      const cv1 = document.querySelector('#pane-1 .conv-view');
      const sr = document.getElementById('ag-context-meter').shadowRoot;
      const r = sr.getElementById('dock-aux-resizer').getBoundingClientRect();
      return {
        scrollTop: Math.round(cv1.scrollTop),
        distFromBottom: Math.round(cv1.scrollHeight - cv1.clientHeight - cv1.scrollTop),
        sepX: Math.round((r.left + r.right) / 2),
        sepY: Math.round((r.top + r.bottom) / 2)
      };
    })()`);
    assert.ok(scrollBeforeDrag.distFromBottom >= 1000, `测试前会话 1 必须停在中间历史阅读位置: ${JSON.stringify(scrollBeforeDrag)}`);
    // 向左大幅拖 -220px 再向右拖回 +140px
    await dispatchRealMouseDrag(cdp, { startX: scrollBeforeDrag.sepX, startY: scrollBeforeDrag.sepY, endX: scrollBeforeDrag.sepX - 220, endY: scrollBeforeDrag.sepY, steps: 12, skipSnapshot: true });
    await new Promise(r => setTimeout(r, 340));
    const scrollAfterDrag = await cdp.evaluate(`(() => {
      const cv1 = document.querySelector('#pane-1 .conv-view');
      return {
        scrollTop: Math.round(cv1.scrollTop),
        scrollHeight: Math.round(cv1.scrollHeight),
        clientHeight: Math.round(cv1.clientHeight),
        distFromBottom: Math.round(cv1.scrollHeight - cv1.clientHeight - cv1.scrollTop)
      };
    })()`);
    assert.ok(scrollAfterDrag.distFromBottom >= 600, `拖动第三根隔离线后会话 1 滚动进度条严禁被强行拽到最下面: before=${JSON.stringify(scrollBeforeDrag)}, after=${JSON.stringify(scrollAfterDrag)}`);

    // === 8B/8E. 复现第六轮视频 2：切到 React 彻底 unmount 原生侧栏的空白会话 2 时，右侧仍同时保留插件 + 浏览器并排（支持互换与 wcvBrowser），且 0 误点 Overview ===
    const clickPane = async (paneId) => {
      const pt = await cdp.evaluate(`(() => {
        const r = document.getElementById('${paneId}').querySelector('.conv-view').getBoundingClientRect();
        return { x: Math.round((r.left + r.right) / 2), y: Math.round((r.top + r.bottom) / 2) };
      })()`);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', buttons: 1, clickCount: 1 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', buttons: 0, clickCount: 1 });
      await new Promise(r => setTimeout(r, 340));
    };

    // 1) 点空白新建会话 2（宿主 React 彻底卸载原生侧栏且不渲染 [◫] 按钮）
    await clickPane('pane-2');
    const onBlankPane2 = await cdp.evaluate(`(() => {
      const hostEl = document.getElementById('ag-context-meter');
      const panelEl = hostEl?.shadowRoot?.getElementById('panel');
      const pinnedDock = document.getElementById('ag-ws-pinned-aux-dock');
      const pinnedBrw = document.getElementById('ag-ws-pinned-browser-pane');
      const swapBtn = document.getElementById('btn-ag-topbar-ws-swap');
      return {
        focused: window.__hostState.focused,
        nativeShellW: Math.round(document.getElementById('aux-shell').getBoundingClientRect().width),
        pinnedPresent: Boolean(pinnedDock && pinnedDock.isConnected),
        pinnedW: pinnedDock ? Math.round(pinnedDock.getBoundingClientRect().width) : 0,
        plugW: Math.round(hostEl.getBoundingClientRect().width),
        pinnedBrwPresent: Boolean(pinnedBrw && pinnedBrw.isConnected),
        pinnedBrwW: pinnedBrw ? Math.round(pinnedBrw.getBoundingClientRect().width) : 0,
        panelHidden: Boolean(panelEl?.hidden),
        swapDisabled: Boolean(swapBtn?.disabled),
        overviewClicks: window.__hostState.overviewClicks,
        closeClicks: window.__hostState.closeClicks
      };
    })()`);
    assert.equal(onBlankPane2.focused, 'p2');
    assert.equal(onBlankPane2.nativeShellW, 0, `切空白会话 2 时原生 aux-shell 必须归零零黑洞: ${JSON.stringify(onBlankPane2)}`);
    assert.equal(onBlankPane2.pinnedPresent, true, `切空白会话 2 时必须激活跨会话常驻侧栏槽不收起: ${JSON.stringify(onBlankPane2)}`);
    assert.ok(onBlankPane2.plugW >= 280 && !onBlankPane2.panelHidden, `空白会话 2 插件必须持续可见: ${JSON.stringify(onBlankPane2)}`);
    assert.equal(onBlankPane2.pinnedBrwPresent, true, `空白会话 2 并排态必须同时保留常驻浏览器面板不消失: ${JSON.stringify(onBlankPane2)}`);
    assert.ok(onBlankPane2.pinnedBrwW >= 300, `空白会话 2 常驻浏览器宽度必须正常可见 (>=300px): ${JSON.stringify(onBlankPane2)}`);
    assert.equal(onBlankPane2.swapDisabled, false, '空白会话 2 插件+浏览器并排态下互换按钮必须可用');
    assert.equal(onBlankPane2.overviewClicks, 0, '切会话 2 严禁误点会话 1 的 Overview 概览按钮');
    assert.equal(onBlankPane2.closeClicks, 0, '切会话 2 严禁误点任何会话关闭按钮');

    // 在空白会话 2 常驻浏览器地址栏输入 URL 回车 -> 精准驱动官方 wcvBrowser.acquire + show
    await cdp.evaluate(`(() => {
      const inp = document.querySelector('#ag-ws-pinned-browser-pane [data-ag-pinned-brw-url="true"]');
      inp.value = 'example.com';
      inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    })()`);
    await new Promise(r => setTimeout(r, 120));
    const wcvAfterNav = await cdp.evaluate(`window.__hostState.wcvLog.slice()`);
    assert.ok(wcvAfterNav.some(e => e.op === 'acquire' && e.req?.initialUrl === 'https://example.com'), `常驻浏览器输入网址必须调用原生 wcvBrowser.acquire: ${JSON.stringify(wcvAfterNav)}`);
    assert.ok(wcvAfterNav.some(e => e.op === 'show' && e.bounds?.width >= 280), `常驻浏览器必须调用原生 wcvBrowser.show 贴合视口矩形: ${JSON.stringify(wcvAfterNav)}`);

    // 2) 在空白会话 2 模拟发第一条消息 -> 宿主长出原生 [◫] 按钮 -> 自动调用 wcvBrowser.hide 并无缝升级回原生侧栏 + 浏览器并排！
    await cdp.evaluate(`(() => {
      window.__hostState.hasConv.p2 = true;
      window.__renderHost();
    })()`);
    await new Promise(r => setTimeout(r, 340));
    const afterPane2Upgraded = await cdp.evaluate(`({
      domSideOpen: document.getElementById('aux-open-wrap').getAttribute('data-side-panel-open'),
      pinnedPresent: Boolean(document.getElementById('ag-ws-pinned-aux-dock')),
      brwW: Math.round(document.getElementById('browser-pane')?.getBoundingClientRect?.()?.width || 0),
      overviewClicks: window.__hostState.overviewClicks,
      hidPinnedWcv: window.__hostState.wcvLog.some(e => e.op === 'hide')
    })`);
    assert.equal(afterPane2Upgraded.domSideOpen, 'true', `会话 2 开始对话后必须自动升级回原生侧栏: ${JSON.stringify(afterPane2Upgraded)}`);
    assert.equal(afterPane2Upgraded.pinnedPresent, false, `升级回原生侧栏后常驻承接槽必须自动清理: ${JSON.stringify(afterPane2Upgraded)}`);
    assert.equal(afterPane2Upgraded.hidPinnedWcv, true, `升级回原生侧栏时必须立刻调用 wcvBrowser.hide 杜绝残影: ${JSON.stringify(afterPane2Upgraded)}`);
    assert.ok(afterPane2Upgraded.brwW >= 300, `升级回原生侧栏后浏览器必须恢复可见: ${JSON.stringify(afterPane2Upgraded)}`);
    assert.equal(afterPane2Upgraded.overviewClicks, 0);

    // 3) 再点击会话 3（已有对话，初始 sideOpen=false）-> 自动点最右上角 [◫] 保持原生侧栏 + 浏览器常驻不收起！
    await clickPane('pane-3');
    const onPane3 = await cdp.evaluate(`({
      focused: window.__hostState.focused,
      domSideOpen: document.getElementById('aux-open-wrap').getAttribute('data-side-panel-open'),
      p3SideOpen: Boolean(window.__hostState.sideOpen.p3),
      brwW: Math.round(document.getElementById('browser-pane').getBoundingClientRect().width),
      overviewClicks: window.__hostState.overviewClicks
    })`);
    assert.equal(onPane3.focused, 'p3');
    assert.equal(onPane3.domSideOpen, 'true', `切到会话 3 后侧边栏必须常驻不收起: ${JSON.stringify(onPane3)}`);
    assert.equal(onPane3.p3SideOpen, true);
    assert.ok(onPane3.brwW >= 300, `切到会话 3 后浏览器必须保持并排可见: ${JSON.stringify(onPane3)}`);
    assert.equal(onPane3.overviewClicks, 0, '切到会话 3 严禁误点会话 1 的 Overview 按钮');

    // === 8C. 复现视频 1：点击关闭侧栏瞬间 0ms 隐藏面板零居中浮窗鬼影、零纯黑死洞 ===
    const closeBtnPt = await cdp.evaluate(`(() => {
      const r = document.getElementById('aux-close-btn').getBoundingClientRect();
      return { x: Math.round((r.left + r.right) / 2), y: Math.round((r.top + r.bottom) / 2) };
    })()`);
    // 在页面挂上高频逐帧采样器，捕捉点击关闭后 0..160ms 内是否曾闪现过任何悬浮可见面板
    await cdp.evaluate(`(() => {
      window.__ghostSamples = [];
      const sample = () => {
        const hostEl = document.getElementById('ag-context-meter');
        const p = hostEl?.shadowRoot?.getElementById('panel');
        const r = p ? p.getBoundingClientRect() : null;
        window.__ghostSamples.push({
          dock: hostEl?.getAttribute('data-dock'),
          hidden: Boolean(p?.hidden),
          w: r ? Math.round(r.width) : 0,
          h: r ? Math.round(r.height) : 0
        });
      };
      window.__startGhostProbe = () => {
        sample();
        for (const ms of [10, 30, 60, 100, 150]) setTimeout(sample, ms);
      };
    })()`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: closeBtnPt.x, y: closeBtnPt.y, button: 'left', buttons: 1, clickCount: 1 });
    await cdp.evaluate(`window.__startGhostProbe()`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: closeBtnPt.x, y: closeBtnPt.y, button: 'left', buttons: 0, clickCount: 1 });
    await new Promise(r => setTimeout(r, 220));

    const closeCheck = await cdp.evaluate(`({
      ghostSamples: window.__ghostSamples,
      shellW: Math.round(document.getElementById('aux-shell').getBoundingClientRect().width),
      p3Right: Math.round(document.getElementById('pane-3').getBoundingClientRect().right),
      pinnedPresent: Boolean(document.getElementById('ag-ws-pinned-aux-dock'))
    })`);
    const hasFloatingGhost = closeCheck.ghostSamples.some(s => s.dock !== 'aux' && !s.hidden && (s.w > 0 || s.h > 0));
    assert.equal(hasFloatingGhost, false, `关闭侧栏退回顶栏过程中严禁闪现任何居中浮窗鬼影: ${JSON.stringify(closeCheck.ghostSamples)}`);
    assert.equal(closeCheck.shellW, 0, `主动关闭侧栏后 aux-shell 必须 0 延迟归零无纯黑死洞: ${JSON.stringify(closeCheck)}`);
    assert.ok(closeCheck.p3Right >= 1678, `关闭侧栏后左侧三会话必须立刻回满 1680px: ${JSON.stringify(closeCheck)}`);
    assert.equal(closeCheck.pinnedPresent, false, '主动关闭侧栏后绝不得弹出常驻承接槽');
  } finally {
    await session.close();
  }
});

test('回归 9（真实 Chromium）：空白会话 2 保留 100% 客户端原生浏览器 + 第 2/3 根隔离条首次按住即 1:1 直拖', async () => {
  const fixtureHtml = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>Antigravity 2.35.2 Round7 Native Browser Pin & First-Drag Regression</title>
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; width: 1680px; height: 900px; overflow: hidden; background: #141414; color: #f4f4f4; font-family: system-ui, sans-serif; }
  .app { display: flex; flex-direction: column; width: 1680px; height: 900px; overflow: hidden; }
  [data-testid="title-menu-bar"] { position: relative; display: flex; align-items: center; justify-content: space-between; height: 34px; flex: 0 0 34px; padding: 0 12px; background: #181818; border-bottom: 1px solid rgba(255,255,255,0.08); }
  .ws-row { display: flex; flex-direction: row; flex: 1 1 auto; min-height: 0; width: 1680px; position: relative; overflow: hidden; }
  .session-group { display: flex; flex-direction: row; flex: 1 1 0px; min-width: 0; height: 100%; position: relative; }
  .pane-slot { min-width: 160px; height: 100%; display: flex; flex-direction: column; position: relative; background: #151515; }
  .pane-header { display: flex; align-items: center; justify-content: space-between; height: 34px; padding: 0 10px; border-bottom: 1px solid rgba(255,255,255,0.08); font-size: 12px; }
  .pane-body { flex: 1 1 auto; padding: 14px; display: flex; flex-direction: column; gap: 10px; min-height: 0; }
  .surface-composer { display: flex; align-items: center; gap: 8px; padding: 8px; border: 1px solid rgba(255,255,255,0.12); border-radius: 8px; background: #1b1b1f; }
  .composer-input { flex: 1 1 auto; min-height: 24px; outline: none; color: #fff; font-size: 13px; }
  /* Tailwind 风格双层第 2 根原生会话分隔条：外层 w-0，无 role="separator"、无 resizer 类名，仅内层带 cursor-col-resize */
  .tw-sep-wrap { position: relative; width: 1px; flex: 0 0 1px; background: rgba(255,255,255,0.1); z-index: 30; }
  .tw-sep-hit { position: absolute; top: 0; bottom: 0; left: -4px; width: 9px; cursor: col-resize; }
  /* 模拟宿主带 overflow: hidden 的 [data-side-panel-open="true"] 外壳 + 嵌套深层宿主原生 col-resize 拖条 */
  .aux-open-shell { position: relative; display: flex; flex-direction: row; flex: 0 0 760px; width: 760px; height: 100%; overflow: hidden; background: #19191d; }
  .aux-open-shell[data-side-panel-open="false"] { width: 0px; flex: 0 0 0px; overflow: hidden; }
  .nested-sash-wrap { position: absolute; top: 0; bottom: 0; left: 0; width: 0; z-index: 60; }
  .nested-sash-hit { position: absolute; top: 0; bottom: 0; left: -5px; width: 10px; cursor: col-resize; background: transparent; }
  [data-side-panel-focus-scope="true"] { flex: 1 1 auto; min-width: 0; height: 100%; display: flex; flex-direction: row; position: relative; }
  #native-client-browser { flex: 1 1 auto; min-width: 0; height: 100%; display: flex; flex-direction: column; padding: 12px; gap: 8px; background: #1c1c21; }
</style>
</head>
<body>
  <div class="app">
    <div data-testid="title-menu-bar"><div>Antigravity</div><div class="window-controls"></div></div>
    <div class="ws-row" id="ws-row">
      <div class="session-group" id="session-group">
        <div class="pane-slot" id="pane-1" data-pane-id="p1" data-focused="true" style="flex: 50 1 0px;">
          <div class="pane-header"><span>会话 1</span><button type="button">Open IDE</button></div>
          <div class="pane-body" data-testid="conversation-view" data-cascade-id="aaaa1111-1111-4111-8111-111111111111">
            <div>会话 1 真实对话内容</div>
            <form class="surface-composer"><div class="composer-input" contenteditable="true"></div></form>
          </div>
        </div>
        <div class="tw-sep-wrap" id="native-sep-2"><div class="tw-sep-hit cursor-col-resize" id="native-sep-2-hit"></div></div>
        <div class="pane-slot" id="pane-2" data-pane-id="p2" data-focused="false" style="flex: 50 1 0px;">
          <div class="pane-header"><span>New Conversation</span><div><button type="button" data-testid="close-pane-button">×</button><button type="button">Open IDE</button></div></div>
          <div class="pane-body" id="pane-2-body">
            <div><button type="button" id="pane-2-env-btn">This Computer</button></div>
            <form class="surface-composer"><div class="composer-input" id="pane-2-input" contenteditable="true"></div></form>
            <div>Conversation History</div>
          </div>
        </div>
      </div>
      <div class="aux-open-shell" id="aux-open-wrap" data-side-panel-open="true">
        <div class="nested-sash-wrap" id="nested-sash-wrap"><div class="nested-sash-hit cursor-col-resize" id="nested-sash-hit"></div></div>
        <div data-side-panel-focus-scope="true" id="aux-focus-scope">
          <div id="native-client-browser" data-testid="native-browser-pane">
            <div style="display:flex;justify-content:space-between;align-items:center;">
              <input type="text" placeholder="Search or enter a URL" style="flex:1;margin-right:8px;" />
              <button type="button" id="native-aux-close-btn" aria-label="Toggle Side Panel" title="Toggle Side Panel"></button>
            </div>
            <div>Review / Open File / Terminal / Browser / Background Tasks</div>
          </div>
        </div>
      </div>
    </div>
  </div>
  <script>
    window.__r7 = {
      activePane: 'p1',
      sideOpen: true,
      unmountCount: 0,
      envBtnClicks: 0,
      sep2DragStarts: 0,
      sep2DragMoves: 0,
      nativeSashSteals: 0
    };
    const p1 = document.getElementById('pane-1');
    const p2 = document.getElementById('pane-2');
    const auxWrap = document.getElementById('aux-open-wrap');
    const auxScope = document.getElementById('aux-focus-scope');
    const nativeBrw = document.getElementById('native-client-browser');

    function setActivePane(pid) {
      window.__r7.activePane = pid;
      p1.setAttribute('data-focused', pid === 'p1' ? 'true' : 'false');
      p2.setAttribute('data-focused', pid === 'p2' ? 'true' : 'false');
      if (pid === 'p2') {
        // 精准模拟 Antigravity 2.35.2：切到空白新建会话 2 时，React 直接 unmount 原生侧栏 + 原生浏览器！
        window.__r7.sideOpen = false;
        window.__r7.unmountCount++;
        auxWrap.setAttribute('data-side-panel-open', 'false');
        if (nativeBrw.parentElement) nativeBrw.remove();
        if (auxScope.parentElement) auxScope.remove();
      } else if (window.__r7.sideOpen) {
        auxWrap.setAttribute('data-side-panel-open', 'true');
        if (!auxScope.isConnected) auxWrap.appendChild(auxScope);
        if (!nativeBrw.isConnected) auxScope.appendChild(nativeBrw);
      }
    }

    // 模拟 React 18 委托：在 pane-2 外壳挂 __reactProps$test 和 __reactFiber$test，并在冒泡阶段由根节点读取执行
    const p2ReactProps = {
      onMouseDown: () => setActivePane('p2'),
      onPointerDown: () => setActivePane('p2'),
      onFocus: () => setActivePane('p2')
    };
    p2['__reactProps$test'] = p2ReactProps;
    p2['__reactFiber$test'] = { type: 'div', stateNode: p2, memoizedProps: p2ReactProps, return: null };
    document.getElementById('ws-row').addEventListener('mousedown', (ev) => {
      if (p2.contains(ev.target)) {
        const fn = p2['__reactProps$test']?.onMouseDown;
        if (typeof fn === 'function') fn(ev);
      }
    });
    document.getElementById('ws-row').addEventListener('pointerdown', (ev) => {
      if (p2.contains(ev.target)) {
        const fn = p2['__reactProps$test']?.onPointerDown;
        if (typeof fn === 'function') fn(ev);
      }
    });
    document.getElementById('ws-row').addEventListener('focusin', (ev) => {
      if (p2.contains(ev.target)) {
        const fn = p2['__reactProps$test']?.onFocus;
        if (typeof fn === 'function') fn(ev);
      }
    });
    document.getElementById('pane-2-env-btn').addEventListener('click', () => {
      window.__r7.envBtnClicks++;
    });

    // 原生关闭按钮（主动关闭侧栏必须随时可用）
    document.getElementById('native-aux-close-btn').addEventListener('click', () => {
      window.__r7.sideOpen = false;
      auxWrap.setAttribute('data-side-panel-open', 'false');
      if (nativeBrw.parentElement) nativeBrw.remove();
      if (auxScope.parentElement) auxScope.remove();
    });

    // 模拟宿主第 2 根原生 Tailwind 分隔条（拖拽按 flexGrow 比例调整会话 1 / 会话 2 宽度）
    const sep2Hit = document.getElementById('native-sep-2-hit');
    let sep2Drag = null;
    sep2Hit.addEventListener('pointerdown', (ev) => {
      window.__r7.sep2DragStarts++;
      const r1 = p1.getBoundingClientRect().width;
      const r2 = p2.getBoundingClientRect().width;
      sep2Drag = { startX: ev.clientX, r1, r2, total: Math.max(1, r1 + r2) };
      ev.preventDefault();
    });
    window.addEventListener('pointermove', (ev) => {
      if (!sep2Drag) return;
      window.__r7.sep2DragMoves++;
      const dx = ev.clientX - sep2Drag.startX;
      const next1 = Math.max(180, Math.min(sep2Drag.total - 180, sep2Drag.r1 + dx));
      const next2 = sep2Drag.total - next1;
      p1.style.flex = ((next1 / sep2Drag.total) * 100).toFixed(2) + ' 1 0px';
      p2.style.flex = ((next2 / sep2Drag.total) * 100).toFixed(2) + ' 1 0px';
    });
    window.addEventListener('pointerup', () => { sep2Drag = null; });

    // 如果漏网宿主原生侧栏拖条被按中，记录偷吃事件（不改宽度，精准复现视频中「光标变←||→但0px不动」）
    const bindSashSteal = (el) => {
      el.addEventListener('pointerdown', (ev) => {
        window.__r7.nativeSashSteals++;
        ev.stopPropagation();
        ev.preventDefault();
      });
    };
    bindSashSteal(document.getElementById('nested-sash-hit'));
    window.__injectDynamicNativeSash = () => {
      const dyn = document.createElement('div');
      dyn.id = 'dynamic-react-sash';
      dyn.className = 'cursor-col-resize';
      const ar = auxWrap.getBoundingClientRect();
      dyn.style.cssText = 'position:fixed;top:34px;bottom:0;left:' + Math.round(ar.left - 3) + 'px;width:6px;z-index:2147483570;cursor:col-resize;';
      bindSashSteal(dyn);
      document.body.appendChild(dyn);
      return dyn.id;
    };
  </script>
</body>
</html>`;

  const session = await launchBrowserSession({
    customHtml: fixtureHtml,
    width: 1680,
    height: 900,
    dockPosition: 'aux',
    auxViewTab: 'both',
    auxOrder: 'plugin-first',
    auxWidthPx: 760,
    auxPluginSharePx: 380
  });
  const { cdp } = session;
  try {
    await cdp.evaluate(`(() => {
      history.replaceState(null, '', '/c/aaaa1111-1111-4111-8111-111111111111');
      const sr = document.getElementById('ag-context-meter')?.shadowRoot;
      if (sr?.getElementById('panel')?.hidden) sr.getElementById('badge')?.click();
    })()`);
    await new Promise(r => setTimeout(r, 320));

    // === 9A. 第 2 根隔离条（Tailwind 双层 cursor-col-resize）：不插重复 .ag-ws-sub-splitter，首次按下向右拖 +110px 即 1:1 移动 ===
    const sep2Init = await cdp.evaluate(`(() => {
      const subSeps = document.querySelectorAll('.ag-ws-sub-splitter').length;
      const r1 = document.getElementById('pane-1').getBoundingClientRect();
      const r2 = document.getElementById('pane-2').getBoundingClientRect();
      const sep = document.getElementById('native-sep-2-hit').getBoundingClientRect();
      return {
        subSeps,
        p1W: Math.round(r1.width),
        p2W: Math.round(r2.width),
        sepX: Math.round((sep.left + sep.right) / 2),
        sepY: Math.round((sep.top + sep.bottom) / 2),
        auxOpenOverflow: getComputedStyle(document.getElementById('aux-open-wrap')).overflow,
        nestedSashWrapDisplay: getComputedStyle(document.getElementById('nested-sash-wrap')).display,
        nestedSashHitW: Math.round(document.getElementById('nested-sash-hit').getBoundingClientRect().width)
      };
    })()`);
    assert.equal(sep2Init.subSeps, 0, `宿主已有 Tailwind 原生第 2 根分隔条时严禁重复插入 .ag-ws-sub-splitter: ${JSON.stringify(sep2Init)}`);
    assert.equal(sep2Init.auxOpenOverflow, 'visible', `aux-open-wrap 必须解除 overflow-hidden 释放第 3 根隔离线左半边热区: ${JSON.stringify(sep2Init)}`);
    assert.ok(sep2Init.nestedSashWrapDisplay === 'none' && sep2Init.nestedSashHitW === 0, `嵌套深层宿主原生 col-resize 拖条必须被彻底隐藏不可命中: ${JSON.stringify(sep2Init)}`);

    await dispatchRealMouseDrag(cdp, { startX: sep2Init.sepX, startY: sep2Init.sepY, endX: sep2Init.sepX + 110, endY: sep2Init.sepY, steps: 10, skipSnapshot: true });
    await new Promise(r => setTimeout(r, 120));
    const sep2After = await cdp.evaluate(`({
      p1W: Math.round(document.getElementById('pane-1').getBoundingClientRect().width),
      p2W: Math.round(document.getElementById('pane-2').getBoundingClientRect().width),
      dragStarts: window.__r7.sep2DragStarts,
      dragMoves: window.__r7.sep2DragMoves,
      unmountCount: window.__r7.unmountCount
    })`);
    assert.equal(sep2After.dragStarts, 1, `第 2 根隔离线首次按下必须立即触发拖拽: ${JSON.stringify(sep2After)}`);
    assert.ok(Math.abs((sep2After.p1W - sep2Init.p1W) - 110) <= 6, `第 2 根隔离线首次右拖 +110px 会话 1 必须立刻增宽 ~110px: before=${sep2Init.p1W}, after=${sep2After.p1W}`);
    assert.equal(sep2After.unmountCount, 0, '拖第 2 根隔离线绝不能误切焦点卸载原生侧栏');

    // === 9B. 第 3 根隔离线左缘 -4px（原被 overflow-hidden 裁掉并被宿主原生拖条抢占区）首次按下即 1:1 拖宽 +100px ===
    const sep3Before = await cdp.evaluate(`(() => {
      const hostR = document.getElementById('ag-context-meter').getBoundingClientRect();
      return { plugW: Math.round(hostR.width), leftEdgeX: Math.round(hostR.left), midY: Math.round((hostR.top + hostR.bottom) / 2) };
    })()`);
    // 故意按在分界线偏左 -3px 处（模拟鼠标从会话 2 刚移到第 3 根线左边缘立刻按下！）
    await dispatchRealMouseDrag(cdp, { startX: sep3Before.leftEdgeX - 3, startY: sep3Before.midY, endX: sep3Before.leftEdgeX - 103, endY: sep3Before.midY, steps: 10, skipSnapshot: true });
    await new Promise(r => setTimeout(r, 120));
    const sep3After = await cdp.evaluate(`({
      plugW: Math.round(document.getElementById('ag-context-meter').getBoundingClientRect().width),
      steals: window.__r7.nativeSashSteals
    })`);
    assert.equal(sep3After.steals, 0, '嵌套宿主原生拖条不得偷吃第 3 根隔离线拖拽');
    assert.ok(Math.abs((sep3After.plugW - sep3Before.plugW) - 100) <= 8, `第 3 根隔离线左缘 -4px 首次左拖 -100px 必须立即拉宽插件 ~100px: before=${sep3Before.plugW}, after=${sep3After.plugW}`);

    // 再注入一根 React 事后重绘新冒出的原生 col-resize 拖条盖在左缘 -> 首次按下仍直接静默隐藏并 1:1 拉宽插件 +80px！
    const dynBefore = await cdp.evaluate(`(() => {
      window.__injectDynamicNativeSash();
      const hostR = document.getElementById('ag-context-meter').getBoundingClientRect();
      return { plugW: Math.round(hostR.width), leftEdgeX: Math.round(hostR.left), midY: Math.round((hostR.top + hostR.bottom) / 2) };
    })()`);
    await dispatchRealMouseDrag(cdp, { startX: dynBefore.leftEdgeX - 1, startY: dynBefore.midY, endX: dynBefore.leftEdgeX - 81, endY: dynBefore.midY, steps: 8, skipSnapshot: true });
    await new Promise(r => setTimeout(r, 120));
    const dynAfter = await cdp.evaluate(`({
      plugW: Math.round(document.getElementById('ag-context-meter').getBoundingClientRect().width),
      dynDisplay: getComputedStyle(document.getElementById('dynamic-react-sash')).display,
      steals: window.__r7.nativeSashSteals
    })`);
    assert.equal(dynAfter.steals, 0, '捕获期拦截必须抢在动态新插原生拖条前接管拖拽');
    assert.equal(dynAfter.dynDisplay, 'none', '漏网动态原生拖条必须在首次按下时当场隐藏');
    assert.ok(Math.abs((dynAfter.plugW - dynBefore.plugW) - 80) <= 8, `盖着动态原生拖条时首次左拖 -80px 仍必须立刻拉宽插件 ~80px: before=${dynBefore.plugW}, after=${dynAfter.plugW}`);

    // === 9C. 点击空白新建会话 2（输入框 + 按钮 + 空白区）：会话 2 交互 100% 正常，右侧 100% 保留客户端原生浏览器（绝不降级成自绘假浏览器！）===
    const clickTarget = async (selector) => {
      const pt = await cdp.evaluate(`(() => {
        const r = document.querySelector('${selector}').getBoundingClientRect();
        return { x: Math.round((r.left + r.right) / 2), y: Math.round((r.top + r.bottom) / 2) };
      })()`);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', buttons: 1, clickCount: 1 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', buttons: 0, clickCount: 1 });
      await new Promise(r => setTimeout(r, 140));
    };
    await clickTarget('#pane-2-input');
    const afterInputClick = await cdp.evaluate(`({
      activeId: document.activeElement?.id || '',
      unmountCount: window.__r7.unmountCount,
      nativeOpen: document.getElementById('aux-open-wrap').getAttribute('data-side-panel-open'),
      nativeBrwConnected: Boolean(document.getElementById('native-client-browser')?.isConnected),
      nativeBrwW: Math.round(document.getElementById('native-client-browser')?.getBoundingClientRect?.()?.width || 0),
      fakePinnedBrwPresent: Boolean(document.getElementById('ag-ws-pinned-browser-pane')),
      swapDisabled: Boolean(document.getElementById('btn-ag-topbar-ws-swap')?.disabled)
    })`);
    assert.equal(afterInputClick.activeId, 'pane-2-input', `点击会话 2 输入框必须正常拿到原生输入焦点: ${JSON.stringify(afterInputClick)}`);
    assert.equal(afterInputClick.unmountCount, 0, `点击空白会话 2 严禁触发 React 卸载客户端原生侧栏: ${JSON.stringify(afterInputClick)}`);
    assert.equal(afterInputClick.nativeOpen, 'true', `点击空白会话 2 后客户端原生侧栏必须保持打开: ${JSON.stringify(afterInputClick)}`);
    assert.equal(afterInputClick.nativeBrwConnected, true, '客户端原生浏览器节点必须 100% 保留在 DOM 中');
    assert.ok(afterInputClick.nativeBrwW >= 320, `客户端原生浏览器必须正常显示且宽度 >= 320px: ${JSON.stringify(afterInputClick)}`);
    assert.equal(afterInputClick.fakePinnedBrwPresent, false, '有客户端原生浏览器时严禁降级成插件自绘假浏览器');
    assert.equal(afterInputClick.swapDisabled, false, '4 窗并排保留客户端原生浏览器时互换按钮必须可用');

    // 点击会话 2 内部按钮（This Computer），确认子组件交互 100% 正常工作且原生浏览器依然稳如泰山
    await clickTarget('#pane-2-env-btn');
    const afterBtnClick = await cdp.evaluate(`({
      envBtnClicks: window.__r7.envBtnClicks,
      unmountCount: window.__r7.unmountCount,
      nativeBrwConnected: Boolean(document.getElementById('native-client-browser')?.isConnected)
    })`);
    assert.equal(afterBtnClick.envBtnClicks, 1, '会话 2 内部按钮（This Computer）点击事件必须 100% 正常触发');
    assert.equal(afterBtnClick.unmountCount, 0, '点击会话 2 内部按钮后客户端原生浏览器不得被卸载');
    assert.equal(afterBtnClick.nativeBrwConnected, true);

    // === 9D. 用户主动点原生关闭按钮 [◫] 后仍可正常关闭原生侧栏零黑洞 ===
    await clickTarget('#native-aux-close-btn');
    await new Promise(r => setTimeout(r, 180));
    const afterManualClose = await cdp.evaluate(`({
      nativeOpen: document.getElementById('aux-open-wrap').getAttribute('data-side-panel-open'),
      auxW: Math.round(document.getElementById('aux-open-wrap').getBoundingClientRect().width),
      p2Right: Math.round(document.getElementById('pane-2').getBoundingClientRect().right)
    })`);
    assert.equal(afterManualClose.nativeOpen, 'false');
    assert.equal(afterManualClose.auxW, 0, `主动关闭后右侧原生侧栏必须归零无黑洞: ${JSON.stringify(afterManualClose)}`);
    assert.ok(afterManualClose.p2Right >= 1676, `主动关闭后左侧双会话必须立刻回满全宽: ${JSON.stringify(afterManualClose)}`);
  } finally {
    await session.close();
  }
});

test('回归 10（真实 Chromium）：侧栏展开 0ms 急通道 + 纯 GPU 合成层滑入动画 + 零冗余 DOM 重建 + 零二次跳闪', async () => {
  const fixtureHtml = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>Antigravity 2.35.2 Round8 Reopen Smoothness Regression</title>
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; width: 1600px; height: 900px; overflow: hidden; background: #141414; color: #f4f4f4; font-family: system-ui, sans-serif; }
  .app { display: flex; flex-direction: column; width: 1600px; height: 900px; overflow: hidden; }
  [data-testid="title-menu-bar"] { position: relative; display: flex; align-items: center; justify-content: space-between; height: 34px; flex: 0 0 34px; padding: 0 12px; background: #181818; border-bottom: 1px solid rgba(255,255,255,0.08); }
  .ws-row { display: flex; flex-direction: row; flex: 1 1 auto; min-height: 0; width: 1600px; position: relative; overflow: hidden; }
  .session-pane { flex: 1 1 0px; min-width: 220px; height: 100%; display: flex; flex-direction: column; background: #151515; }
  .pane-header { display: flex; align-items: center; justify-content: space-between; height: 36px; padding: 0 12px; border-bottom: 1px solid rgba(255,255,255,0.08); }
  .conv-view { flex: 1 1 auto; padding: 14px; overflow-y: auto; }
  .aux-shell { position: relative; display: flex; flex-direction: row; flex: 0 0 760px; width: 760px; height: 100%; background: #19191d; transition: width 220ms ease; }
  .aux-shell[data-side-panel-open="false"] { width: 0px; flex: 0 0 0px; overflow: hidden; }
  [data-side-panel-focus-scope="true"] { flex: 1 1 auto; min-width: 0; height: 100%; display: flex; flex-direction: row; position: relative; }
  #native-brw-r8 { flex: 1 1 auto; min-width: 0; height: 100%; padding: 12px; background: #1c1c21; }
</style>
</head>
<body>
  <div class="app">
    <div data-testid="title-menu-bar"><div>Antigravity</div><div class="window-controls"></div></div>
    <div class="ws-row" id="ws-row">
      <div class="session-pane" id="pane-1" data-pane-id="p1" data-focused="true">
        <div class="pane-header">
          <span>会话 1</span>
          <div>
            <button type="button">Open IDE</button>
            <button type="button" id="top-toggle-aux" data-testid="toggle-aux-sidebar" aria-label="Toggle Side Panel"></button>
          </div>
        </div>
        <div class="conv-view" data-testid="conversation-view" data-cascade-id="bbbb2222-2222-4222-8222-222222222222">
          <div>长会话正文</div>
          <form class="surface-composer"><div contenteditable="true"></div></form>
        </div>
      </div>
      <div class="aux-shell" id="aux-shell" data-side-panel-open="true">
        <div data-side-panel-focus-scope="true" id="aux-scope">
          <div id="native-brw-r8" data-testid="native-browser-pane">Search or enter a URL / Native Browser</div>
        </div>
      </div>
    </div>
  </div>
  <script>
    const auxShell = document.getElementById('aux-shell');
    const auxScope = document.getElementById('aux-scope');
    window.__toggleSidePanel = (open) => {
      auxShell.setAttribute('data-side-panel-open', open ? 'true' : 'false');
      if (open) {
        if (!auxScope.isConnected) auxShell.appendChild(auxScope);
      } else {
        if (auxScope.parentElement) auxScope.remove();
      }
    };
    document.getElementById('top-toggle-aux').addEventListener('click', () => {
      const openNow = auxShell.getAttribute('data-side-panel-open') === 'true';
      window.__toggleSidePanel(!openNow);
    });
  </script>
</body>
</html>`;

  const session = await launchBrowserSession({
    customHtml: fixtureHtml,
    width: 1600,
    height: 900,
    dockPosition: 'aux',
    auxViewTab: 'both',
    auxOrder: 'plugin-first',
    auxWidthPx: 760,
    auxPluginSharePx: 380
  });
  const { cdp } = session;
  try {
    await cdp.evaluate(`(() => {
      history.replaceState(null, '', '/c/bbbb2222-2222-4222-8222-222222222222');
      const sr = document.getElementById('ag-context-meter')?.shadowRoot;
      if (sr?.getElementById('panel')?.hidden) sr.getElementById('badge')?.click();
    })()`);
    await new Promise(r => setTimeout(r, 320));

    // 在卡片 DOM 上打唯一标记，用于校验“关一下再开、数据未变时”绝不重复销毁重建重型卡片 DOM
    const beforeClose = await cdp.evaluate(`(() => {
      const sr = document.getElementById('ag-context-meter')?.shadowRoot;
      const panel = sr?.getElementById('panel');
      const grid = sr?.getElementById('ctx-bento-grid');
      const firstCard = grid?.querySelector?.('[data-widget-id]');
      const trendSvg = sr?.getElementById('ctx-trend-svg');
      if (firstCard) firstCard.__r8Sentinel = 'keep-alive-card';
      if (trendSvg) {
        const mark = document.createElementNS('http://www.w3.org/2000/svg', 'desc');
        mark.id = 'r8-svg-sentinel';
        trendSvg.appendChild(mark);
      }
      return {
        panelHidden: Boolean(panel?.hidden),
        panelContain: panel ? getComputedStyle(panel).contain : '',
        cardCount: grid ? grid.childElementCount : 0,
        hasFirstCard: Boolean(firstCard)
      };
    })()`);
    assert.equal(beforeClose.panelHidden, false);
    assert.ok(
      beforeClose.panelContain === 'content' || (beforeClose.panelContain.includes('layout') && beforeClose.panelContain.includes('paint')),
      `停靠面板必须启用 contain: layout style paint (规范计算值 content) 隔离重绘: ${JSON.stringify(beforeClose)}`
    );
    assert.ok(beforeClose.hasFirstCard && beforeClose.cardCount > 0);

    // 1. 点击关闭侧栏 -> 0ms 干脆收起零黑洞
    await cdp.evaluate(`document.getElementById('top-toggle-aux').click()`);
    await new Promise(r => setTimeout(r, 120));
    const afterClose = await cdp.evaluate(`({
      shellW: Math.round(document.getElementById('aux-shell').getBoundingClientRect().width),
      panelHidden: Boolean(document.getElementById('ag-context-meter')?.shadowRoot?.getElementById('panel')?.hidden)
    })`);
    assert.equal(afterClose.shellW, 0);
    assert.equal(afterClose.panelHidden, true);

    // 2. 点击重新展开侧栏 -> 在同一事件循环后微任务与首帧测量：0ms 响应、无 width transition、有 GPU 合成层滑入动画、卡片零二次跳闪、SVG 哨兵未重建
    const reopenMetrics = await cdp.evaluate(`(async () => {
      const t0 = performance.now();
      document.getElementById('top-toggle-aux').click();
      await Promise.resolve();
      await Promise.resolve();
      const tMicro = performance.now() - t0;
      const host = document.getElementById('ag-context-meter');
      const sr = host?.shadowRoot;
      const panel = sr?.getElementById('panel');
      const auxShell = document.getElementById('aux-shell');
      const brw = document.getElementById('native-brw-r8');
      const firstCard = sr?.querySelector?.('#ctx-bento-grid [data-widget-id]');
      const topAtMicro = firstCard ? Math.round(firstCard.getBoundingClientRect().top) : -1;
      const revealAtMicro = Boolean(panel?.classList?.contains('ag-aux-reveal-enter'));
      const brwRevealAtMicro = Boolean(brw?.classList?.contains('ag-ws-aux-reveal-enter'));
      const animName = panel ? getComputedStyle(panel).animationName : '';
      const shellTrans = auxShell ? auxShell.style.transition : '';
      const panelVisibleAtMicro = Boolean(panel && !panel.hidden);
      const sentinelKept = Boolean(firstCard?.__r8Sentinel === 'keep-alive-card');
      const svgSentinelKept = Boolean(sr?.getElementById('r8-svg-sentinel'));
      await new Promise(r => setTimeout(r, 120));
      const topAt120 = firstCard ? Math.round(firstCard.getBoundingClientRect().top) : -1;
      await new Promise(r => setTimeout(r, 200));
      const topAt320 = firstCard ? Math.round(firstCard.getBoundingClientRect().top) : -1;
      const revealCleaned = !panel?.classList?.contains('ag-aux-reveal-enter');
      const willChangeAfter = panel ? getComputedStyle(panel).willChange : '';
      return {
        tMicro: Number(tMicro.toFixed(2)),
        panelVisibleAtMicro,
        revealAtMicro,
        brwRevealAtMicro,
        animName,
        shellTrans,
        sentinelKept,
        svgSentinelKept,
        topAtMicro,
        topAt120,
        topAt320,
        revealCleaned,
        willChangeAfter
      };
    })()`);
    assert.equal(reopenMetrics.panelVisibleAtMicro, true, `重新展开侧栏必须经 0ms 微任务急通道立即可见，不可卡顿等待 60ms: ${JSON.stringify(reopenMetrics)}`);
    assert.ok(reopenMetrics.tMicro < 60, `展开首帧同步阻塞耗时必须 < 60ms，实测=${reopenMetrics.tMicro}ms: ${JSON.stringify(reopenMetrics)}`);
    assert.equal(reopenMetrics.shellTrans, 'none', '外框严禁对 width 做 CSS 布局过渡避免全页每帧回流');
    assert.equal(reopenMetrics.revealAtMicro, true, `展开瞬间停靠面板必须施加纯 GPU 合成层滑入类 ag-aux-reveal-enter: ${JSON.stringify(reopenMetrics)}`);
    assert.equal(reopenMetrics.brwRevealAtMicro, true, `三栏并排展开时右侧原生浏览器容器必须同步施加滑入过渡类: ${JSON.stringify(reopenMetrics)}`);
    assert.ok(reopenMetrics.animName && reopenMetrics.animName !== 'none', `合成层滑入动画 animationName 必须生效: ${JSON.stringify(reopenMetrics)}`);
    assert.equal(reopenMetrics.sentinelKept, true, '数据未变时重开侧栏必须 0ms 原样复用 Bento 卡片 DOM 绝不重建');
    assert.equal(reopenMetrics.svgSentinelKept, true, '数据未变时重开侧栏必须 0ms 复用趋势图 SVG 绝不重画');
    assert.ok(Math.abs(reopenMetrics.topAt320 - reopenMetrics.topAtMicro) <= 2 && Math.abs(reopenMetrics.topAt120 - reopenMetrics.topAtMicro) <= 2,
      `展开首帧即排准 Skyline 布局，严禁 83ms 后发生二次跳闪: ${JSON.stringify(reopenMetrics)}`);
    assert.equal(reopenMetrics.revealCleaned, true, '滑入动画结束后必须自动清理 ag-aux-reveal-enter 释放 will-change');
    assert.equal(reopenMetrics.willChangeAfter, 'auto', `动画结束后 will-change 必须回收为 auto: ${JSON.stringify(reopenMetrics)}`);
  } finally {
    await session.close();
  }
});

test('回归 11（真实 Chromium）：dockPosition=aux 冷启动无侧栏首页零 Fatal Init Error + 零 TDZ + 随后开侧栏自动停靠', async () => {
  const coldStartHtml = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>Antigravity 2.35.2 Cold Start Aux No-SidePanel Regression</title>
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; width: 1440px; height: 900px; overflow: hidden; background: #141414; color: #f4f4f4; font-family: system-ui, sans-serif; }
  .app { display: flex; flex-direction: column; width: 1440px; height: 900px; overflow: hidden; }
  [data-testid="title-menu-bar"] { position: relative; display: flex; align-items: center; justify-content: space-between; height: 34px; flex: 0 0 34px; padding: 0 12px; background: #181818; border-bottom: 1px solid rgba(255,255,255,0.08); }
  .ws-row { display: flex; flex-direction: row; flex: 1 1 auto; min-height: 0; width: 1440px; position: relative; overflow: hidden; }
  .session-pane { flex: 1 1 0px; min-width: 240px; height: 100%; display: flex; flex-direction: column; background: #151515; }
  .aux-shell { position: relative; display: flex; flex-direction: row; flex: 0 0 0px; width: 0px; height: 100%; overflow: hidden; background: #19191d; }
  .aux-shell[data-side-panel-open="true"] { flex: 0 0 460px; width: 460px; overflow: visible; }
  [data-side-panel-focus-scope="true"] { flex: 1 1 auto; min-width: 0; height: 100%; display: flex; flex-direction: row; position: relative; }
</style>
</head>
<body>
  <script>
    window.__bootPageErrors = [];
    window.addEventListener('error', (ev) => {
      window.__bootPageErrors.push(String(ev?.message || ev?.error || 'unknown'));
    });
    window.addEventListener('unhandledrejection', (ev) => {
      window.__bootPageErrors.push(String(ev?.reason || 'unhandledrejection'));
    });
  </script>
  <div class="app">
    <div data-testid="title-menu-bar"><div>Antigravity</div><div class="window-controls"></div></div>
    <div class="ws-row" id="ws-row">
      <div class="session-pane" id="pane-1" data-pane-id="p1" data-focused="true">
        <div data-testid="conversation-view" data-cascade-id="cccc3333-3333-4333-8333-333333333333">
          <div>冷启动首页（此时辅助栏未打开）</div>
          <form class="surface-composer"><div contenteditable="true"></div></form>
        </div>
      </div>
      <div class="aux-shell" id="aux-shell" data-side-panel-open="false"></div>
    </div>
  </div>
</body>
</html>`;

  const session = await launchBrowserSession({
    customHtml: coldStartHtml,
    width: 1440,
    height: 900,
    dockPosition: 'aux',
    auxViewTab: 'plugin',
    auxWidthPx: 460
  });
  const { cdp } = session;
  try {
    await new Promise(r => setTimeout(r, 180));
    // 触发 blur / focus 校验绝无 QUOTA_REFRESH_BG_MS / quotaState TDZ 报错
    const bootState = await cdp.evaluate(`(() => {
      window.dispatchEvent(new Event('blur'));
      window.dispatchEvent(new Event('focus'));
      const host = document.getElementById('ag-context-meter');
      return {
        hasMeterApi: Boolean(window.__AGContextMeter),
        fatalError: window.__AGContextMeterFatalError || null,
        pageErrors: Array.isArray(window.__bootPageErrors) ? window.__bootPageErrors.slice() : [],
        hostConnected: Boolean(host && host.isConnected),
        hostDock: host ? host.getAttribute('data-dock') : null,
        ensureAliveOk: Boolean(window.__AGContextMeter?.ensureAlive?.())
      };
    })()`);
    assert.equal(bootState.fatalError, null, `冷启动无侧栏首页严禁出现 Fatal Init Error: ${JSON.stringify(bootState)}`);
    assert.deepEqual(bootState.pageErrors, [], `冷启动及焦点切换严禁产生任何未捕获异常或 TDZ 报错: ${JSON.stringify(bootState)}`);
    assert.equal(bootState.hasMeterApi, true, `window.__AGContextMeter 必须完整初始化: ${JSON.stringify(bootState)}`);
    assert.equal(bootState.hostConnected, true, `冷启动无侧栏时插件必须降级挂载到顶栏保持可见: ${JSON.stringify(bootState)}`);
    assert.equal(bootState.ensureAliveOk, true);

    // 随后用户打开右侧辅助栏 -> 插件立即自动切入 data-dock="aux" 并展开上下文面板
    const afterOpenAux = await cdp.evaluate(`(async () => {
      const shell = document.getElementById('aux-shell');
      shell.setAttribute('data-side-panel-open', 'true');
      const scope = document.createElement('div');
      scope.setAttribute('data-side-panel-focus-scope', 'true');
      scope.id = 'aux-scope-cold';
      shell.appendChild(scope);
      await new Promise(r => setTimeout(r, 150));
      const host = document.getElementById('ag-context-meter');
      const panel = host?.shadowRoot?.getElementById('panel');
      return {
        hostDock: host ? host.getAttribute('data-dock') : null,
        insideScope: Boolean(host && scope.contains(host)),
        panelHidden: Boolean(panel?.hidden),
        pageErrors: Array.isArray(window.__bootPageErrors) ? window.__bootPageErrors.slice() : []
      };
    })()`);
    assert.deepEqual(afterOpenAux.pageErrors, [], `打开侧栏后严禁产生任何控制台异常: ${JSON.stringify(afterOpenAux)}`);
    assert.equal(afterOpenAux.hostDock, 'aux', `打开侧栏后必须自动进入 aux 停靠态: ${JSON.stringify(afterOpenAux)}`);
    assert.equal(afterOpenAux.insideScope, true, `host 必须挂载到右侧辅助栏容器内部: ${JSON.stringify(afterOpenAux)}`);
    assert.equal(afterOpenAux.panelHidden, false, `打开侧栏后上下文面板必须自动展开显示: ${JSON.stringify(afterOpenAux)}`);
  } finally {
    await session.close();
  }
});
