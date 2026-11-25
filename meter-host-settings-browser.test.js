'use strict';

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
      if (fs.existsSync(p)) return { path: p, checked: candidates };
    } catch { }
  }
  return { path: null, checked: candidates };
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
      throw new Error(`Page eval error: ${JSON.stringify(res.exceptionDetails)}`);
    }
    return res?.result?.value;
  }

  close() {
    try { this.ws.close(); } catch { }
  }
}

function createHostFixtureHtml() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>Antigravity 2.35.1 Settings Host Fixture</title>
<style>
  :root {
    --background: #141414;
    --foreground: #f4f4f4;
    --card: #1d1d1d;
    --secondary: #222222;
    --secondary-foreground: #e5e5e5;
    --muted: #1b1b1b;
    --muted-foreground: #969696;
    --border: #2f2f2f;
    --input: #141414;
    --accent: #7748cf;
    --primary: #7748cf;
  }
  html.light-theme {
    --background: #ffffff;
    --foreground: #141414;
    --card: #fafafa;
    --secondary: #f2f2f2;
    --secondary-foreground: #222222;
    --muted: #f3f3f3;
    --muted-foreground: #666666;
    --border: #e4e4e4;
    --input: #ffffff;
    --accent: #7748cf;
    --primary: #7748cf;
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    padding: 0;
    width: 100%;
    height: 100%;
    background: #0c0c0c;
    color: var(--foreground);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    overflow: hidden;
  }
  .host-workbench {
    position: relative;
    width: 100vw;
    height: 100vh;
    display: flex;
    flex-direction: column;
  }
  .host-topbar {
    height: 36px;
    background: #181818;
    border-bottom: 1px solid #262626;
    display: flex;
    align-items: center;
    padding: 0 12px;
    gap: 10px;
  }
  .host-backdrop {
    flex: 1;
    min-height: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.52);
    padding: 20px;
  }
  .settings-modal-container {
    position: relative;
    width: 920px;
    max-width: 96vw;
    height: 540px;
    max-height: calc(100vh - 64px);
    background: var(--background);
    border: 1px solid var(--border);
    border-radius: 12px;
    overflow: hidden;
    display: flex;
    box-shadow: 0 24px 60px rgba(0, 0, 0, 0.5);
  }
  .relative.flex.w-full.h-full {
    position: relative;
    display: flex;
    width: 100%;
    height: 100%;
    min-height: 0;
  }
  [data-testid="settings-sidebar"] {
    width: 220px;
    flex: 0 0 220px;
    background: var(--secondary);
    border-right: 1px solid var(--border);
    padding: 16px 10px;
    overflow-y: auto;
  }
  .sidebar-group {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-bottom: 16px;
  }
  .sidebar-group button {
    height: 32px;
    padding: 0 10px;
    border-radius: 7px;
    border: none;
    background: transparent;
    color: var(--foreground);
    font-size: 13px;
    display: flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
    text-align: left;
  }
  .sidebar-group button[aria-selected="true"] {
    background: rgba(119, 72, 207, 0.20);
    font-weight: 600;
  }
  /* 还原真实 Antigravity 2.35.1 右栏 overflow-y: hidden */
  .host-right-pane {
    position: relative;
    flex: 1 1 0%;
    min-width: 0;
    overflow-y: hidden;
    height: 100%;
  }
  .host-close-btn {
    position: absolute;
    top: 14px;
    right: 14px;
    z-index: 30;
    width: 28px;
    height: 28px;
    border-radius: 7px;
    border: 1px solid var(--border);
    background: var(--card);
    color: var(--foreground);
    cursor: pointer;
  }
  .native-pane-body {
    height: 100%;
    overflow-y: auto;
    padding: 28px 32px;
  }
</style>
</head>
<body>
<div class="host-workbench">
  <header class="host-topbar" data-testid="title-menu-bar">
    <span>Antigravity</span>
  </header>
  <main class="host-backdrop">
    <div id="host-settings-dialog" class="settings-modal-container" role="dialog" aria-label="Settings">
      <div class="relative flex w-full h-full">
        <aside data-testid="settings-sidebar">
          <div class="sidebar-group" data-group="main">
            <button id="settings-nav-item-General" type="button" role="tab" aria-selected="true">General</button>
            <button id="settings-nav-item-Models" type="button" role="tab" aria-selected="false">Models</button>
            <button id="settings-nav-item-Browser" type="button" role="tab" aria-selected="false">Browser</button>
          </div>
          <div class="sidebar-group" data-group="account">
            <button id="settings-nav-item-Account" type="button" role="tab" aria-selected="false">Account</button>
          </div>
        </aside>
        <section id="host-right-pane" class="host-right-pane" data-settings-content-pane="true">
          <button id="host-close-settings-btn" class="host-close-btn" type="button" aria-label="Close settings">✕</button>
          <div id="native-general-body" class="native-pane-body">
            <h2>General Settings</h2>
            <p>Native General Panel Content</p>
          </div>
          <div id="native-browser-body" class="native-pane-body" hidden>
            <h2>Browser Settings</h2>
            <p>Native Browser Panel Content</p>
          </div>
          <div id="native-models-body" class="native-pane-body" hidden>
            <h2>Models Settings</h2>
            <p>Native Models Panel Content</p>
          </div>
          <div id="native-account-body" class="native-pane-body" hidden>
            <h2>Account Settings</h2>
            <p>Native Account Panel Content</p>
          </div>
        </section>
      </div>
    </div>
  </main>
</div>
<script>
  (function () {
    var store = {
      ok: true,
      uiPreferences: {
        panelLanguage: 'zh-CN',
        themeMode: 'auto',
        allowBetaUpdates: false,
        nextPromptEnabled: false,
        autoCheckUpdate: true
      }
    };
    var chineseCfg = { enabled: false, language: 'en', brandTitle: 'english' };
    window.__testSavedPayloads = [];
    window.__testCloseClicks = 0;

    document.getElementById('host-close-settings-btn').addEventListener('click', function () {
      window.__testCloseClicks += 1;
    });

    function selectNativeTab(tabKey) {
      ['General', 'Models', 'Browser', 'Account'].forEach(function (k) {
        var btn = document.getElementById('settings-nav-item-' + k);
        var body = document.getElementById('native-' + k.toLowerCase() + '-body');
        var active = k === tabKey;
        if (btn) btn.setAttribute('aria-selected', active ? 'true' : 'false');
        if (body) body.hidden = !active;
      });
    }
    document.getElementById('settings-nav-item-General').addEventListener('click', function () { selectNativeTab('General'); });
    document.getElementById('settings-nav-item-Models').addEventListener('click', function () { selectNativeTab('Models'); });
    document.getElementById('settings-nav-item-Browser').addEventListener('click', function () { selectNativeTab('Browser'); });
    document.getElementById('settings-nav-item-Account').addEventListener('click', function () { selectNativeTab('Account'); });

    window.contextMeterAPI = {
      getSettings: async function () {
        return JSON.parse(JSON.stringify(store));
      },
      saveSettings: async function (payload) {
        window.__testSavedPayloads.push(payload);
        if (payload && typeof payload === 'object') {
          if (payload.uiPreferences) Object.assign(store.uiPreferences, payload.uiPreferences);
          Object.keys(payload).forEach(function (k) {
            if (k !== 'uiPreferences') store.uiPreferences[k] = payload[k];
          });
        }
        return { ok: true, uiPreferences: store.uiPreferences };
      },
      getQuota: async function () {
        return {
          ok: true,
          data: {
            ok: true,
            collectorVersion: '${CURRENT_PKG_VERSION}',
            snapshot: {
              syncState: 'fresh',
              fetchedAtMs: Date.now(),
              pools: [
                {
                  poolKey: 'shared_gemini_main',
                  title: 'Gemini 4',
                  remainingFraction: 0.72,
                  buckets: [
                    { windowShort: '5h', windowKey: '5h', remainingFraction: 0.72, isResetPassed: false },
                    { windowShort: '7d', windowKey: 'weekly', remainingFraction: 0.80, isResetPassed: false }
                  ]
                },
                {
                  poolKey: 'shared_3p_pool',
                  title: 'Claude / GPT',
                  remainingFraction: 0.62,
                  buckets: [
                    { windowShort: '5h', windowKey: '5h', remainingFraction: 0.62, isResetPassed: false },
                    { windowShort: '7d', windowKey: 'weekly', remainingFraction: 0.75, isResetPassed: false }
                  ]
                }
              ]
            }
          }
        };
      },
      getTokenHistory: async function () {
        return { ok: true, data: { totalTokens: 0, entries: [], summary: {} } };
      },
      getAccountsOverview: async function () {
        return {
          ok: true,
          activeAccountEmail: 'alice@example.com',
          accounts: [
            {
              email: 'alice@example.com',
              maskedEmail: 'al***ce@example.com',
              isActive: true,
              hasRefreshToken: true,
              quotaSnapshot: {
                pools: [
                  {
                    poolKey: 'shared_gemini_main',
                    buckets: [
                      { windowKey: '5h', windowShort: '5h', remainingFraction: 0.34 },
                      { windowKey: 'weekly', windowShort: '7d', remainingFraction: 0.80 }
                    ]
                  },
                  {
                    poolKey: 'shared_3p_pool',
                    buckets: [
                      { windowKey: '5h', windowShort: '5h', remainingFraction: 0.62 },
                      { windowKey: 'weekly', windowShort: '7d', remainingFraction: 0.75 }
                    ]
                  }
                ]
              }
            },
            { email: 'bob@example.com', maskedEmail: 'bo***ob@example.com', isActive: false, hasRefreshToken: true }
          ],
          autoSwitch: { enabled: false, poolKey: 'shared_gemini_main', metricMode: 'remaining_pct', windowKey: '5h', thresholdPct: 15, candidates: ['bob@example.com'] },
          autoSwitchStatus: { state: 'disabled' }
        };
      },
      modulesAction: async function (action, moduleName, enabled, extra) {
        if (action === 'toggle' && moduleName === 'chinese') {
          chineseCfg.enabled = Boolean(enabled);
          chineseCfg.language = (extra && extra.language) ? extra.language : (enabled ? 'zh-CN' : 'en');
          if (extra && extra.brandTitle) chineseCfg.brandTitle = extra.brandTitle;
        }
        return {
          ok: true,
          restartRequired: action === 'toggle',
          data: { modules: { chinese: Object.assign({}, chineseCfg), proxy: { enabled: false, proxyUrl: 'http://127.0.0.1:7897' } } },
          disk: { chineseReady: true, proxyReady: true },
          runtime: { chineseActive: chineseCfg.enabled }
        };
      },
      enhanceAction: async function () {
        return { ok: true, data: { supported: true, summary: { promptTier: 4, chineseTitleEnabled: true, syncState: 'runtime_confirmed' } } };
      },
      rehydrateAction: async function () {
        return { ok: true, data: { supported: true, status: 'enabled', hookRegistered: true, hookEnabled: true, pythonReady: true, pythonVersion: '3.12.2' } };
      },
      getRuntimeInfo: async function () {
        return { ok: true, backendVersion: '${CURRENT_PKG_VERSION}', backendSource: 'electron-ipc', hostSupportsRestart: true };
      },
      checkUpdate: async function () {
        return { ok: true, hasUpdate: false, currentVersion: '${CURRENT_PKG_VERSION}', installedVersion: '${CURRENT_PKG_VERSION}' };
      }
    };
  })();
</script>
<script src="/meter-core.js"></script>
<script src="/meter-renderer.js"></script>
</body>
</html>`;
}

async function waitForPageReady(cdp, expr, timeoutMs = 4000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const val = await cdp.evaluate(expr);
    if (val) return val;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`Timeout waiting for ${expr}`);
}

const CURRENT_PKG_VERSION = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version || '0.9.3';

test('第 4 项浏览器实机布局回归：唯一滚动容器、滚轮顶到底再回顶、真实键盘按键、矮窗适配、切页异步重挂载与主题强调色同步', async (t) => {
  const browserProbe = findBrowserExecutable();
  const browserPath = browserProbe.path;
  if (!browserPath) {
    t.skip(`未检测到本机 Chrome/Edge/Chromium 可执行文件 (platform=${process.platform}，已探测 ${browserProbe.checked.length} 处，可设 AG_CM_TEST_BROWSER 环境变量指定)，跳过真实浏览器 CDP 布局测试`);
    return;
  }

  const corePath = path.join(__dirname, 'meter-core.js');
  const rendererPath = path.join(__dirname, 'meter-renderer.js');
  const htmlContent = createHostFixtureHtml();
  const server = http.createServer((req, res) => {
    if (req.url === '/meter-core.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
      res.end(fs.readFileSync(corePath));
      return;
    }
    if (req.url === '/meter-renderer.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
      res.end(fs.readFileSync(rendererPath));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(htmlContent);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agcm-browser-test-'));
  const chromeProc = spawn(browserPath, [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1200,760',
    `http://127.0.0.1:${port}/`
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  let cdp = null;
  try {
    const wsUrl = await new Promise((resolve, reject) => {
      let buf = '';
      const tm = setTimeout(() => reject(new Error(`Chrome CDP startup timeout: ${buf}`)), 8000);
      const onData = (chunk) => {
        buf += chunk.toString('utf8');
        const m = buf.match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (m) {
          clearTimeout(tm);
          resolve(m[1]);
        }
      };
      chromeProc.stderr.on('data', onData);
      chromeProc.stdout.on('data', onData);
    });

    const pagesRes = await fetch(`${wsUrl.replace(/^ws:/, 'http:').replace(/\/devtools\/browser\/.*$/, '/json/list')}`);
    const pages = await pagesRes.json();
    const targetPage = pages.find((p) => p.type === 'page' && p.webSocketDebuggerUrl) || pages[0];
    assert.ok(targetPage?.webSocketDebuggerUrl, '必须获取到 CDP page WebSocket 地址');

    cdp = new CdpClient(targetPage.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 760, deviceScaleFactor: 1, mobile: false });

    await waitForPageReady(cdp, `Boolean(document.getElementById('ag-cm-host-settings-nav') && document.getElementById('ag-cm-host-settings-page'))`);

    // 1. 点击左侧 Context Meter，检验唯一滚动容器高度约束与初始首屏位置
    await cdp.evaluate(`document.getElementById('ag-cm-host-settings-nav').click()`);
    await waitForPageReady(cdp, `document.getElementById('ag-cm-host-settings-nav').getAttribute('data-active') === 'true'`);

    const initMetrics = await cdp.evaluate(`(() => {
      const rp = document.getElementById('host-right-pane');
      const pg = document.getElementById('ag-cm-host-settings-page');
      const sr = pg.shadowRoot;
      const closeBtn = document.getElementById('host-close-settings-btn');
      const closeRect = closeBtn.getBoundingClientRect();
      const hitEl = document.elementFromPoint(closeRect.left + closeRect.width / 2, closeRect.top + closeRect.height / 2);
      const pgRect = pg.getBoundingClientRect();
      return {
        rpOverflowY: getComputedStyle(rp).overflowY,
        rpScrollTop: rp.scrollTop,
        pgDisplay: getComputedStyle(pg).display,
        pgOverflowY: getComputedStyle(pg).overflowY,
        pgClientH: pg.clientHeight,
        pgScrollH: pg.scrollHeight,
        pgScrollTop: pg.scrollTop,
        pgLeft: pgRect.left,
        pgTop: pgRect.top,
        pgWidth: pgRect.width,
        pgHeight: pgRect.height,
        closeHitId: hitEl ? hitEl.id : null,
        hasNsRoot: Boolean(sr && sr.getElementById('ag-ns-root'))
      };
    })()`);

    assert.equal(initMetrics.hasNsRoot, true);
    assert.equal(initMetrics.rpOverflowY, 'hidden');
    assert.equal(initMetrics.rpScrollTop, 0, '进入设置页后宿主外层右栏不得发生偏移');
    assert.equal(initMetrics.pgScrollTop, 0, '默认进入设置页应从顶部开始');
    assert.ok(initMetrics.pgClientH >= 480, `设置页可见高度应贴合弹窗而非被压扁, 实得 ${initMetrics.pgClientH}`);
    assert.ok(initMetrics.pgScrollH > initMetrics.pgClientH, `设置页内容必须真实溢出以触发滚动: scrollH=${initMetrics.pgScrollH}, clientH=${initMetrics.pgClientH}`);
    assert.equal(initMetrics.closeHitId, 'host-close-settings-btn', '右上角宿主关闭按钮必须可正常命中');

    // 默认将截图保存在隔离临时目录（测试结束自动清理），仅在显式设置 AG_CM_EXPORT_SCREENSHOT_DIR 时才导出到外部目录
    const explicitShotDir = process.env.AG_CM_EXPORT_SCREENSHOT_DIR ? path.resolve(process.env.AG_CM_EXPORT_SCREENSHOT_DIR) : '';
    const shotDir = explicitShotDir || path.join(userDataDir, 'screenshots');
    fs.mkdirSync(shotDir, { recursive: true });
    const shotDarkTop = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(shotDir, '01-native-settings-dark-top.png'), Buffer.from(shotDarkTop.data, 'base64'));

    // 2. 用真实鼠标滚轮从顶连续向下滚动至底部第 9 组，检查末项进入视口且右栏背景不跟随
    const wheelX = Math.round(initMetrics.pgLeft + initMetrics.pgWidth / 2);
    const wheelY = Math.round(initMetrics.pgTop + initMetrics.pgHeight / 2);
    for (let i = 0; i < 16; i++) {
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: wheelX,
        y: wheelY,
        deltaX: 0,
        deltaY: 220
      });
      await new Promise((r) => setTimeout(r, 25));
    }

    const bottomMetrics = await cdp.evaluate(`(() => {
      const rp = document.getElementById('host-right-pane');
      const pg = document.getElementById('ag-cm-host-settings-page');
      const btnClear = pg.shadowRoot.getElementById('ag-ns-btn-clear-cache');
      const clearRect = btnClear.getBoundingClientRect();
      const pgRect = pg.getBoundingClientRect();
      return {
        rpScrollTop: rp.scrollTop,
        pgScrollTop: pg.scrollTop,
        maxScroll: pg.scrollHeight - pg.clientHeight,
        clearInView: clearRect.top >= pgRect.top && clearRect.bottom <= pgRect.bottom + 2
      };
    })()`);

    assert.equal(bottomMetrics.rpScrollTop, 0, '滚轮滚动期间宿主右栏背景 scrollTop 必须始终保持 0');
    assert.ok(bottomMetrics.pgScrollTop > 100 && bottomMetrics.pgScrollTop >= bottomMetrics.maxScroll - 4, `连续滚轮必须滚到底部: scrollTop=${bottomMetrics.pgScrollTop}, max=${bottomMetrics.maxScroll}`);
    assert.equal(bottomMetrics.clearInView, true, '底部第 9 组清理缓存按钮必须真正进入可视区');

    // 在底部点击 Beta 开关切换并验证即时保存、状态文案更新且 scrollTop 不回顶
    const beforeToggleScroll = bottomMetrics.pgScrollTop;
    await cdp.evaluate(`document.getElementById('ag-cm-host-settings-page').shadowRoot.getElementById('ag-ns-sw-betaChannel').click()`);
    await new Promise((r) => setTimeout(r, 120));

    const shotDarkBottom = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(shotDir, '02-native-settings-dark-scrolled-bottom.png'), Buffer.from(shotDarkBottom.data, 'base64'));

    const afterBottomToggle = await cdp.evaluate(`(() => {
      const pg = document.getElementById('ag-cm-host-settings-page');
      const sw = pg.shadowRoot.getElementById('ag-ns-sw-betaChannel');
      const st = pg.shadowRoot.querySelector('[data-ag-ns-sw-status="betaChannel"]');
      return {
        ariaChecked: sw.getAttribute('aria-checked'),
        statusText: st ? st.textContent : '',
        scrollTop: pg.scrollTop,
        savedBeta: Boolean(window.__testSavedPayloads.find((p) => p && p.allowBetaUpdates === true))
      };
    })()`);
    assert.equal(afterBottomToggle.ariaChecked, 'true');
    assert.equal(afterBottomToggle.savedBeta, true);
    assert.ok(afterBottomToggle.statusText.length > 0);
    assert.ok(Math.abs(afterBottomToggle.scrollTop - beforeToggleScroll) <= 2, '底部保存刷新不得跳回顶部');

    // 2.5 验证自动切号四项监控额度下拉、移除旧池/主窗口、自定义暗色下拉菜单与候选账号滑动开关
    const autoSwitchCheck = await cdp.evaluate(`(() => {
      const pg = document.getElementById('ag-cm-host-settings-page');
      const sr = pg.shadowRoot;
      const sel = sr.getElementById('ag-ns-sel-autoSwitchTarget');
      const oldPool = sr.getElementById('ag-ns-sel-autoSwitchPool');
      const oldWin = sr.getElementById('ag-ns-sel-autoSwitchWindow');
      const metricSel = sr.getElementById('ag-ns-sel-autoSwitchMetric');
      const summaryEl = sr.getElementById('ag-ns-autoswitch-live-summary');
      const allSelects = Array.from(sr.querySelectorAll('[data-ag-ns-select]'));
      const enhancedAll = allSelects.length === 5 && allSelects.every(s => getComputedStyle(s).display === 'none' && Boolean(sr.getElementById(s.id + '-trigger')));
      const sec = sr.getElementById('ag-ns-sec-accounts');
      if (sec) sec.scrollIntoView({ block: 'start' });
      const targetTrigger = sr.getElementById('ag-ns-sel-autoSwitchTarget-trigger');
      const targetMenu = sr.getElementById('ag-ns-sel-autoSwitchTarget-menu');
      targetTrigger.click();
      const menuStyle = getComputedStyle(targetMenu);
      const cardStyle = getComputedStyle(sec.querySelector('.ag-ns-card'));
      const menuRect = targetMenu.getBoundingClientRect();
      const groupLabels = Array.from(targetMenu.querySelectorAll('.ag-ns-dd-group')).map(g => g.textContent.trim());
      const menuValues = Array.from(targetMenu.querySelectorAll('.ag-ns-dd-item')).map(i => i.getAttribute('data-value'));
      const initialSummary = summaryEl ? summaryEl.textContent : '';
      // 通过自定义下拉点击选择 Claude / GPT 周额度
      const claude7dItem = targetMenu.querySelector('.ag-ns-dd-item[data-value="shared_3p_pool:7d"]');
      if (claude7dItem) claude7dItem.click();
      // 通过自定义下拉点击选择已用额度口径
      const metricTrigger = sr.getElementById('ag-ns-sel-autoSwitchMetric-trigger');
      const metricMenu = sr.getElementById('ag-ns-sel-autoSwitchMetric-menu');
      metricTrigger.click();
      const usedItem = metricMenu.querySelector('.ag-ns-dd-item[data-value="used_pct"]');
      if (usedItem) usedItem.click();
      // 检查账单区订阅档位自定义下拉暗色背景
      const tierTrigger = sr.getElementById('ag-ns-sel-planTier-trigger');
      const tierMenu = sr.getElementById('ag-ns-sel-planTier-menu');
      tierTrigger.click();
      const tierMenuBg = getComputedStyle(tierMenu).backgroundColor;
      tierTrigger.click();
      const validOpts = Array.from(sel.options).filter(o => !o.disabled).map(o => o.value);
      const allTexts = Array.from(sel.options).map(o => o.textContent || '');
      return {
        enhancedAll,
        cardOverflow: cardStyle.overflow,
        menuBg: menuStyle.backgroundColor,
        tierMenuBg,
        menuHeight: Math.round(menuRect.height),
        groupLabels,
        menuValues,
        triggerLabelAfter: targetTrigger.querySelector('.ag-ns-dd-label')?.textContent?.trim() || '',
        metricValueAfter: metricSel.value,
        hasOldPool: Boolean(oldPool),
        hasOldWin: Boolean(oldWin),
        validOpts,
        hasForbidden: allTexts.some(t => /Argon|Carbon|主窗口/i.test(t)),
        initialSummary,
        updatedSummary: summaryEl ? summaryEl.textContent : ''
      };
    })()`);
    assert.equal(autoSwitchCheck.enhancedAll, true, '原生设置页全部 5 个 select 必须替换为自定义下拉组件');
    assert.equal(autoSwitchCheck.cardOverflow, 'visible', '设置卡片 overflow 必须为 visible 防止下拉菜单裁切');
    assert.equal(autoSwitchCheck.menuBg, 'rgb(30, 30, 36)', '暗色主题自定义下拉浮层必须为深色不透明背景而非系统白底');
    assert.equal(autoSwitchCheck.tierMenuBg, 'rgb(30, 30, 36)', '订阅档位自定义下拉浮层必须为深色背景');
    assert.ok(autoSwitchCheck.menuHeight > 100, `自定义下拉菜单必须完整展开无裁切, 实得 height=${autoSwitchCheck.menuHeight}`);
    assert.equal(autoSwitchCheck.groupLabels.length, 2, '监控额度菜单应呈现 2 个 optgroup 分组标题');
    assert.deepEqual(autoSwitchCheck.menuValues, ['shared_gemini_main:5h', 'shared_gemini_main:7d', 'shared_3p_pool:5h', 'shared_3p_pool:7d'], '自定义下拉不得暴露 hidden/disabled 旧规则占位项');
    assert.match(autoSwitchCheck.triggerLabelAfter, /Claude \/ GPT 周额度/);
    assert.equal(autoSwitchCheck.metricValueAfter, 'used_pct');
    assert.equal(autoSwitchCheck.hasOldPool, false, '旧 ag-ns-sel-autoSwitchPool 必须已移除');
    assert.equal(autoSwitchCheck.hasOldWin, false, '旧 ag-ns-sel-autoSwitchWindow 必须已移除');
    assert.deepEqual(autoSwitchCheck.validOpts, ['shared_gemini_main:5h', 'shared_gemini_main:7d', 'shared_3p_pool:5h', 'shared_3p_pool:7d']);
    assert.equal(autoSwitchCheck.hasForbidden, false, '四项选择器不得残留 Argon / Carbon / 主窗口');
    assert.match(autoSwitchCheck.initialSummary, /Gemini 5 小时额度.*已用 28%.*剩余 72%/);
    assert.match(autoSwitchCheck.updatedSummary, /Claude \/ GPT 周额度.*已用 ≥ 15%.*已用 25%.*剩余 75%/);
    await new Promise((r) => setTimeout(r, 80));
    const shotAutoSwitch = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(shotDir, '04-native-settings-autoswitch-4targets.png'), Buffer.from(shotAutoSwitch.data, 'base64'));

    // 3. 滚轮向上滚回顶部，随后测键盘 End / Home 可达性
    for (let i = 0; i < 16; i++) {
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: wheelX,
        y: wheelY,
        deltaX: 0,
        deltaY: -240
      });
      await new Promise((r) => setTimeout(r, 20));
    }
    const backTopScroll = await cdp.evaluate(`document.getElementById('ag-cm-host-settings-page').scrollTop`);
    assert.equal(backTopScroll, 0, '滚轮向上应能顺利滚回顶部');

    // 3.5 使用真实 CDP 键盘事件（PageDown / End / Home + 底部控件焦点可达）取代脚本直接写 scrollTop
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: wheelX, y: wheelY, button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: wheelX, y: wheelY, button: 'left', clickCount: 1 });
    await cdp.evaluate(`document.getElementById('ag-cm-host-settings-page').focus();`);
    const dispatchKey = async (key, code, windowsVirtualKeyCode) => {
      await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode, nativeVirtualKeyCode: windowsVirtualKeyCode });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode, nativeVirtualKeyCode: windowsVirtualKeyCode });
      await new Promise((r) => setTimeout(r, 320));
    };
    await dispatchKey('PageDown', 'PageDown', 34);
    const afterPageDown = await cdp.evaluate(`document.getElementById('ag-cm-host-settings-page').scrollTop`);
    assert.ok(afterPageDown > 100, `真实 PageDown 按键必须驱动滚动容器向下滚动, 实得 scrollTop=${afterPageDown}`);

    await dispatchKey('End', 'End', 35);
    const afterEndMetrics = await cdp.evaluate(`(() => {
      const pg = document.getElementById('ag-cm-host-settings-page');
      const btnClear = pg.shadowRoot.getElementById('ag-ns-btn-clear-cache');
      btnClear.focus();
      const clearRect = btnClear.getBoundingClientRect();
      const pgRect = pg.getBoundingClientRect();
      return {
        scrollTop: pg.scrollTop,
        maxScroll: pg.scrollHeight - pg.clientHeight,
        clearFocused: pg.shadowRoot.activeElement === btnClear,
        clearInView: clearRect.top >= pgRect.top && clearRect.bottom <= pgRect.bottom + 4
      };
    })()`);
    assert.ok(afterEndMetrics.scrollTop >= afterEndMetrics.maxScroll - 8, `真实 End 按键必须滚到底部: scrollTop=${afterEndMetrics.scrollTop}, max=${afterEndMetrics.maxScroll}`);
    assert.equal(afterEndMetrics.clearFocused, true, '底部清理缓存按钮必须可通过键盘获得焦点');
    assert.equal(afterEndMetrics.clearInView, true, '真实 End 按键后底部清理缓存按钮必须处于可视区');

    await cdp.evaluate(`document.getElementById('ag-cm-host-settings-page').focus();`);
    await dispatchKey('Home', 'Home', 36);
    const afterHomeScroll = await cdp.evaluate(`document.getElementById('ag-cm-host-settings-page').scrollTop`);
    assert.equal(afterHomeScroll, 0, `真实 Home 按键必须滚回顶部, 实得 scrollTop=${afterHomeScroll}`);

    // 4. 往返切页 Browser -> Context Meter -> Models -> Context Meter，含异步右栏 DOM 重建与宿主强调色同步
    await cdp.evaluate(`document.getElementById('settings-nav-item-Browser').click()`);
    await new Promise((r) => setTimeout(r, 60));
    const browserActive = await cdp.evaluate(`document.getElementById('native-browser-body').hidden === false && document.getElementById('ag-cm-host-settings-page').hidden === true`);
    assert.equal(browserActive, true);

    await cdp.evaluate(`document.getElementById('ag-cm-host-settings-nav').click()`);
    await new Promise((r) => setTimeout(r, 60));
    await cdp.evaluate(`document.getElementById('settings-nav-item-Models').click()`);
    await new Promise((r) => setTimeout(r, 60));
    await cdp.evaluate(`document.getElementById('ag-cm-host-settings-nav').click()`);
    await new Promise((r) => setTimeout(r, 80));

    // 动态修改宿主浅色主题 + 自定义强调色，验证开关轨道色实时跟随 --ag-host-accent
    await cdp.evaluate(`(() => {
      document.documentElement.classList.add('light-theme');
      document.documentElement.style.setProperty('--accent', '#2563eb');
      document.documentElement.setAttribute('data-theme', 'light');
    })()`);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 960, height: 500, deviceScaleFactor: 1, mobile: false });
    await new Promise((r) => setTimeout(r, 280));

    const lightShortMetrics = await cdp.evaluate(`(() => {
      const pg = document.getElementById('ag-cm-host-settings-page');
      const sw = pg.shadowRoot.getElementById('ag-ns-sw-betaChannel');
      const closeBtn = document.getElementById('host-close-settings-btn');
      const closeRect = closeBtn.getBoundingClientRect();
      const hitEl = document.elementFromPoint(closeRect.left + closeRect.width / 2, closeRect.top + closeRect.height / 2);
      pg.scrollTop = pg.scrollHeight;
      return {
        theme: pg.getAttribute('data-theme'),
        hostAccent: pg.style.getPropertyValue('--ag-host-accent'),
        swBg: getComputedStyle(sw).backgroundColor,
        pgClientH: pg.clientHeight,
        pgScrollH: pg.scrollHeight,
        pgScrollTopAfterBottom: pg.scrollTop,
        closeHitId: hitEl ? hitEl.id : null
      };
    })()`);

    assert.equal(lightShortMetrics.theme, 'light');
    assert.equal(lightShortMetrics.hostAccent, '#2563eb');
    assert.equal(lightShortMetrics.swBg, 'rgb(37, 99, 235)', '开启态开关颜色必须同步宿主强调色 #2563eb');
    assert.ok(lightShortMetrics.pgScrollH > lightShortMetrics.pgClientH);
    assert.ok(lightShortMetrics.pgScrollTopAfterBottom > 100);
    assert.equal(lightShortMetrics.closeHitId, 'host-close-settings-btn', '矮窗口浅色模式下关闭按钮仍可命中');

    const shotLightShort = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(shotDir, '03-native-settings-light-short-window.png'), Buffer.from(shotLightShort.data, 'base64'));
  } finally {
    if (cdp) cdp.close();
    try { chromeProc.kill(); } catch { }
    server.close();
    await new Promise((r) => setTimeout(r, 150));
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { }
  }
});

test('v0.9.3 实机返工浏览器回归：VX外层包裹导航首点直达零重建 + z-[5000]设置弹窗内<dialog>重启确认可点击 + 独立菜单栏拖拽规则', async (t) => {
  const browser = findBrowserExecutable();
  if (!browser.path) {
    t.skip('未检测到本机 Chrome/Edge 可执行文件');
    return;
  }

  const coreSource = fs.readFileSync(path.join(__dirname, 'meter-core.js'), 'utf8');
  const rendererSource = fs.readFileSync(path.join(__dirname, 'meter-renderer.js'), 'utf8');
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Antigravity 2.35.1 Real VX + Base UI Portal Fixture</title>
<style>
  :root { --background:#141414; --foreground:#f4f4f4; --card:#1d1d1d; --secondary:#222; --sidebar-secondary:#2a2a2e; --border:#2f2f2f; --accent:#7748cf; }
  * { box-sizing: border-box; }
  html, body { margin:0; padding:0; width:100vw; height:100vh; overflow:hidden; background:#141414; color:#f4f4f4; font-family:system-ui,sans-serif; }
  #root { width:100%; height:100%; display:flex; flex-direction:column; }
  .tmb { height:32px; display:flex; align-items:center; gap:8px; padding:0 12px; background:#19191c; }
  .conv-titlebar { height:40px; display:flex; align-items:center; justify-content:space-between; padding:0 12px; background:#141414; }
  .settings-modal-backdrop { position:fixed; inset:0; z-index:5000; display:flex; align-items:center; justify-content:center; padding:28px; background:rgba(0,0,0,0.45); }
  .settings-modal-container { position:relative; width:100%; max-width:960px; height:80vh; background:#18181b; border:1px solid #2e2e32; border-radius:16px; display:flex; overflow:hidden; }
  .relative.flex.w-full.h-full { position:relative; display:flex; width:100%; height:100%; min-height:0; }
  [data-testid="settings-sidebar"] { width:210px; flex:0 0 210px; background:#161618; border-right:1px solid #2a2a2e; padding:12px 0; overflow-y:auto; }
  .vx-list { display:flex; flex-direction:column; gap:2px; }
  .vx-wrap { margin:0 8px; position:relative; }
  .vx-btn { width:100%; display:flex; align-items:center; gap:8px; padding:7px 10px; border:0; border-radius:8px; background:transparent; color:#d4d4d8; text-align:left; cursor:pointer; font-size:13px; }
  .vx-btn.bg-sidebar-secondary { background:#2a2a2e; color:#fff; }
  .right-pane { flex:1 1 0%; min-width:0; min-height:0; height:100%; overflow:hidden; display:flex; flex-direction:column; }
  .native-pane { padding:24px 28px; }
</style>
</head>
<body>
  <div id="root">
    <div data-testid="title-menu-bar" class="tmb">
      <div data-testid="title-menu-bar-item">Antigravity</div>
      <div data-testid="title-menu-bar-item">Workspace</div>
    </div>
    <div class="conv-titlebar @container/titlebar">
      <div>Chat</div>
      <div data-testid="titlebar-service-announcement-slot" style="flex:1"></div>
      <div data-testid="pane-titlebar-toolbar" class="shrink-0" style="display:flex;align-items:center;gap:6px">
        <button type="button">Open IDE</button>
      </div>
    </div>
  </div>
  <div data-base-ui-portal="">
    <div class="settings-modal-backdrop" id="host-backdrop">
      <div class="settings-modal-container" role="dialog" aria-label="Settings">
        <div class="relative flex w-full h-full">
          <div data-testid="settings-sidebar">
            <div class="sidebar-scroll">
              <div class="vx-list" id="vx-nav-group">
                <div class="vx-wrap"><button type="button" data-testid="settings-nav-item-General" class="vx-btn bg-sidebar-secondary"><span>General</span></button></div>
                <div class="vx-wrap"><button type="button" data-testid="settings-nav-item-Browser" class="vx-btn"><span>Browser</span></button></div>
              </div>
            </div>
          </div>
          <div class="right-pane" id="vx-right-pane">
            <div class="native-pane" id="pane-general"><h2>General</h2></div>
            <div class="native-pane" id="pane-browser" hidden><h2>Browser</h2></div>
          </div>
        </div>
      </div>
    </div>
  </div>
  <script>
    window.__TEST_RESTART_CALLS = 0;
    window.__TEST_LANG_STATE = { enabled: false, language: 'en', brandTitle: 'english' };
    window.__AGContextMeterBootBackend = { backendVersion: '0.9.3', backendSource: 'electron-ipc', pid: 43210, capabilities: { restartHost: true } };
    window.contextMeterAPI = {
      getRuntimeInfo: async () => ({ ok: true, backendVersion: '0.9.3', backendSource: 'electron-ipc', pid: 43210, capabilities: { restartHost: true } }),
      getSettings: async () => ({ ok: true, uiPreferences: { panelLanguage: 'zh-CN', themeMode: 'dark' } }),
      saveSettings: async () => ({ ok: true }),
      scan: async () => ({ ok: true, data: { session: null } }),
      getQuota: async () => ({ ok: true, collectorVersion: '0.9.3', pools: [] }),
      getModulesStatus: async () => ({
        ok: true,
        data: { modules: { chinese: { ...window.__TEST_LANG_STATE }, proxy: { enabled: false } } },
        disk: { chinese: true, chineseReady: true },
        runtime: { chineseActive: false, chineseBootLanguage: 'en', chineseNeedsRestart: window.__TEST_LANG_STATE.enabled !== false }
      }),
      toggleModule: async (mod, enable, extra) => {
        if (mod === 'chinese') {
          window.__TEST_LANG_STATE = { enabled: Boolean(enable), language: extra?.language || (enable ? 'zh-CN' : 'en'), brandTitle: extra?.brandTitle || 'english' };
          return {
            ok: true,
            restartRequired: Boolean(enable) !== false,
            data: { modules: { chinese: { ...window.__TEST_LANG_STATE } } },
            runtime: { chineseActive: false, chineseBootLanguage: 'en', chineseNeedsRestart: Boolean(enable) !== false }
          };
        }
        return { ok: true, restartRequired: false };
      },
      restartHost: async () => { window.__TEST_RESTART_CALLS += 1; return { ok: true, supported: true }; },
      getAccountsOverview: async () => ({ ok: true, accounts: [], autoSwitch: { enabled: false, poolKey: 'shared_gemini_main', windowKey: '5h', metricMode: 'remaining_pct', thresholdPct: 10, candidates: [] }, autoSwitchStatus: { state: 'disabled', consumedNoticeIds: [] } })
    };
    const showNative = (name) => {
      document.getElementById('pane-general').hidden = name !== 'General';
      document.getElementById('pane-browser').hidden = name !== 'Browser';
      document.querySelectorAll('[data-testid^="settings-nav-item-"]').forEach((b) => {
        b.classList.toggle('bg-sidebar-secondary', b.getAttribute('data-testid') === 'settings-nav-item-' + name);
      });
    };
    document.querySelector('[data-testid="settings-nav-item-General"]').addEventListener('click', () => showNative('General'));
    document.querySelector('[data-testid="settings-nav-item-Browser"]').addEventListener('click', () => showNative('Browser'));
    // 模拟 Base UI Dialog 给 #root 加 inert
    document.getElementById('root').inert = true;
  </script>
  <script src="/meter-core.js"></script>
  <script src="/meter-renderer.js"></script>
</body>
</html>`;

  const server = http.createServer((req, res) => {
    if (req.url === '/meter-core.js') { res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' }); res.end(coreSource); return; }
    if (req.url === '/meter-renderer.js') { res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' }); res.end(rendererSource); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agcm-v093-browser-'));
  const chromeProc = spawn(browser.path, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    '--window-size=1280,820',
    `http://127.0.0.1:${port}/`
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  let cdp = null;
  try {
    const wsUrl = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('等待 Chrome DevTools 端口超时')), 15000);
      let stderrBuf = '';
      chromeProc.stderr.on('data', (chunk) => {
        stderrBuf += chunk.toString('utf8');
        const m = stderrBuf.match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (m) { clearTimeout(timer); resolve(m[1]); }
      });
      chromeProc.on('exit', (code) => { clearTimeout(timer); reject(new Error(`Chrome 提前退出: ${code}`)); });
    });
    const listPort = new URL(wsUrl).port;
    let targetWs = null;
    for (let i = 0; i < 40; i++) {
      const resp = await fetch(`http://127.0.0.1:${listPort}/json/list`);
      const targets = await resp.json();
      const pageTarget = targets.find((x) => x.type === 'page' && String(x.url || '').startsWith(`http://127.0.0.1:${port}`));
      if (pageTarget?.webSocketDebuggerUrl) { targetWs = pageTarget.webSocketDebuggerUrl; break; }
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(targetWs, '必须连接目标页面 CDP');
    cdp = new CdpClient(targetWs);
    await cdp.connect();
    await cdp.send('Runtime.enable');
    await waitForPageReady(cdp, `Boolean(document.getElementById('ag-cm-host-settings-nav') && document.getElementById('ag-cm-host-settings-page'))`);

    // 1. 验证 VX 同构 wrapper 挂载且等待 220ms 后节点身份未变动（彻底无 50ms 销毁重建死循环）
    await cdp.evaluate(`window.__NAV_REF_0 = document.getElementById('ag-cm-host-settings-nav'); true;`);
    await new Promise((r) => setTimeout(r, 220));
    const navStability = await cdp.evaluate(`(() => {
      const nav = document.getElementById('ag-cm-host-settings-nav');
      const wrap = nav?.parentElement;
      const group = document.getElementById('vx-nav-group');
      const browserWrap = document.querySelector('[data-testid="settings-nav-item-Browser"]')?.parentElement;
      const r = nav.getBoundingClientRect();
      return {
        sameNode: nav === window.__NAV_REF_0,
        wrapAttr: wrap?.getAttribute('data-ag-hs-nav-wrapper'),
        inGroup: wrap?.parentElement === group,
        afterBrowserWrap: browserWrap?.nextElementSibling === wrap,
        navCount: document.querySelectorAll('#ag-cm-host-settings-nav').length,
        clickX: Math.round(r.left + r.width * 0.78),
        clickY: Math.round(r.top + r.height / 2)
      };
    })()`);
    assert.equal(navStability.sameNode, true, '220ms 内绝不得销毁重建导航按钮');
    assert.equal(navStability.wrapAttr, 'true');
    assert.equal(navStability.inGroup, true);
    assert.equal(navStability.afterBrowserWrap, true);
    assert.equal(navStability.navCount, 1);

    // 2. 用真实鼠标点击行内空白区域（78% 宽度处），一次点击必须直接打开 Context Meter
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: navStability.clickX, y: navStability.clickY, button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: navStability.clickX, y: navStability.clickY, button: 'left', clickCount: 1 });
    await new Promise((r) => setTimeout(r, 120));
    const afterFirstClick = await cdp.evaluate(`(() => ({
      navActive: document.getElementById('ag-cm-host-settings-nav').getAttribute('data-active'),
      pageHidden: document.getElementById('ag-cm-host-settings-page').hidden,
      generalHidden: document.getElementById('pane-general').hidden
    }))()`);
    assert.equal(afterFirstClick.navActive, 'true', '首次点击行内空白必须立刻选中 Context Meter');
    assert.equal(afterFirstClick.pageHidden, false, '首次点击必须立刻显示右侧 Context Meter 设置页');
    assert.equal(afterFirstClick.generalHidden, true, '激活后原生 General 必须隐藏');

    // 3. 在 z-[5000] Settings 弹窗打开且 #root 为 inert 时，选择简体中文并点击「应用并重启」
    await cdp.evaluate(`(() => {
      const sr = document.getElementById('ag-cm-host-settings-page').shadowRoot;
      sr.getElementById('ag-ns-btn-client-zh').click();
      sr.getElementById('ag-ns-btn-apply-client-lang').click();
    })()`);
    await waitForPageReady(cdp, `(() => {
      const mh = document.getElementById('ag-context-meter-modal-host');
      const dlg = mh?.shadowRoot?.getElementById('global-restart-modal');
      return Boolean(dlg && dlg.open && !dlg.hidden);
    })()`, 5000);

    // 验证 <dialog> 处于顶层且按钮真实可点击命中（不被 z-[5000] 设置弹窗挡住，不受 #root inert 影响）
    const modalHit = await cdp.evaluate(`(() => {
      const mh = document.getElementById('ag-context-meter-modal-host');
      const dlg = mh.shadowRoot.getElementById('global-restart-modal');
      const btnCancel = mh.shadowRoot.getElementById('btn-modal-restart-cancel');
      const btnConfirm = mh.shadowRoot.getElementById('btn-modal-restart-confirm');
      const cr = btnCancel.getBoundingClientRect();
      const okr = btnConfirm.getBoundingClientRect();
      const topAtConfirm = document.elementFromPoint(okr.left + okr.width / 2, okr.top + okr.height / 2);
      const shadowAtConfirm = mh.shadowRoot.elementFromPoint(okr.left + okr.width / 2, okr.top + okr.height / 2);
      return {
        tagName: dlg.tagName,
        isOpen: dlg.open,
        confirmWidth: Math.round(okr.width),
        confirmHeight: Math.round(okr.height),
        topAtConfirmId: topAtConfirm ? topAtConfirm.id : null,
        shadowHitId: shadowAtConfirm ? shadowAtConfirm.id : null,
        cancelX: Math.round(cr.left + cr.width / 2),
        cancelY: Math.round(cr.top + cr.height / 2),
        confirmX: Math.round(okr.left + okr.width / 2),
        confirmY: Math.round(okr.top + okr.height / 2)
      };
    })()`);
    assert.equal(modalHit.tagName, 'DIALOG');
    assert.equal(modalHit.isOpen, true);
    assert.ok(modalHit.confirmWidth > 30 && modalHit.confirmHeight > 18);
    assert.equal(modalHit.topAtConfirmId, 'ag-context-meter-modal-host', '确认按钮坐标处顶层命中必须是 modal-host 而非宿主设置弹窗');
    assert.equal(modalHit.shadowHitId, 'btn-modal-restart-confirm', 'Shadow 内部必须精确命中确认重启按钮');

    // 真实鼠标点取消 -> 关闭重启弹窗但不关设置弹窗
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: modalHit.cancelX, y: modalHit.cancelY, button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: modalHit.cancelX, y: modalHit.cancelY, button: 'left', clickCount: 1 });
    await new Promise((r) => setTimeout(r, 80));
    const afterCancel = await cdp.evaluate(`(() => {
      const mh = document.getElementById('ag-context-meter-modal-host');
      const dlg = mh.shadowRoot.getElementById('global-restart-modal');
      return {
        dlgOpen: Boolean(dlg.open),
        dlgHidden: Boolean(dlg.hidden),
        settingsStillOpen: !document.getElementById('ag-cm-host-settings-page').hidden,
        restartCalls: window.__TEST_RESTART_CALLS
      };
    })()`);
    assert.equal(afterCancel.dlgOpen, false);
    assert.equal(afterCancel.dlgHidden, true);
    assert.equal(afterCancel.settingsStillOpen, true);
    assert.equal(afterCancel.restartCalls, 0);

    // 再次点击「应用并重启」并真实鼠标点击「确认重启」-> 触发 restartHost
    await cdp.evaluate(`document.getElementById('ag-cm-host-settings-page').shadowRoot.getElementById('ag-ns-btn-apply-client-lang').click();`);
    await waitForPageReady(cdp, `Boolean(document.getElementById('ag-context-meter-modal-host')?.shadowRoot?.getElementById('global-restart-modal')?.open)`, 5000);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: modalHit.confirmX, y: modalHit.confirmY, button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: modalHit.confirmX, y: modalHit.confirmY, button: 'left', clickCount: 1 });
    await waitForPageReady(cdp, `window.__TEST_RESTART_CALLS === 1`, 5000);
    assert.equal(await cdp.evaluate(`window.__TEST_RESTART_CALLS`), 1, '点击确认重启必须调用宿主 restartHost 链路');
  } finally {
    if (cdp) cdp.close();
    try { chromeProc.kill(); } catch { }
    server.close();
    await new Promise((r) => setTimeout(r, 150));
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { }
  }
});
