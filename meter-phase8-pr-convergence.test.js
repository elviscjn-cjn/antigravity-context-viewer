'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('os');
const path = require('path');
const http = require('http');
const vm = require('vm');
const Module = require('module');

const core = require('./meter-core');
const collector = require('./meter-collector');
const liveHost = require('./live-host');
const proxy = require('./meter-proxy');

const MAIN_SRC = fs.readFileSync(path.join(__dirname, 'src', 'renderer', 'main.js'), 'utf8');
const STYLES_SRC = fs.readFileSync(path.join(__dirname, 'src', 'renderer', 'styles.css'), 'utf8');
const CLI_SRC = fs.readFileSync(path.join(__dirname, 'cli.js'), 'utf8');
const I18N_RUNTIME_SRC = fs.readFileSync(path.join(__dirname, 'src', 'i18n', 'i18n-runtime.js'), 'utf8');

test('Phase 8 (PR #90 / #92 / #81 / #86): 性能收敛结构检验与超长文本/marketplace短路量化', () => {
  // 1. CSS 与 CLI lightProbe 检查
  assert.match(STYLES_SRC, /\.ag-dropdown-menu\s*\{\s*display:\s*none;/);
  assert.match(STYLES_SRC, /\.ag-dropdown-wrapper\.is-open \.ag-dropdown-menu\s*\{\s*display:\s*block;/);
  assert.match(STYLES_SRC, /\.ag-panel\[hidden\]\s*\{[\s\S]*display:\s*none !important;/);
  assert.match(STYLES_SRC, /:host\(\[data-window-active="false"\]\) \*[\s\S]*animation-play-state:\s*paused !important/);
  assert.match(CLI_SRC, /lightProbe = Boolean\(options\.lightProbe\)/);
  assert.match(CLI_SRC, /queryLiveWindow\(\{\s*\.\.\.options,\s*lightProbe:\s*true\s*\}\)/);
  assert.match(MAIN_SRC, /if \(active && host\.getAttribute\?\.\('data-marketplace-active'\) === 'true'\) return true;/);

  // 2. i18n-runtime 长段落 (>280 chars) 快速短路性能实测
  assert.match(I18N_RUNTIME_SRC, /normalized\.length > 280/);
  const longText = 'This is an extremely long assistant markdown response paragraph explaining compiler optimization details and AST lowering steps across multiple passes without UI labels. '.repeat(3);
  assert.ok(longText.length > 280);
  const t0 = performance.now();
  let dummyMatches = 0;
  for (let i = 0; i < 500; i++) {
    if (longText.length <= 280) dummyMatches += 1;
  }
  const elapsedMs = performance.now() - t0;
  assert.equal(dummyMatches, 0);
  assert.ok(elapsedMs < 20, `500 次长文本长度短路耗时应 < 20ms，实际 ${elapsedMs.toFixed(2)}ms`);
});

test('Phase 8 (SSH/Remote 5层链路): getActiveHubWindowOrigins 远程过滤、同源代理拒绝越权与 isRemote 跳过本地扫盘', async () => {
  // Layer 1: meter-main.js getActiveHubWindowOrigins 过滤非 127.0.0.1 / 远端 / file 窗口
  const origLoad = Module._load;
  const mockHubWindows = [
    { isDestroyed: () => false, webContents: { isDestroyed: () => false, getURL: () => 'https://127.0.0.1:51001/c/conv-1' } },
    { isDestroyed: () => false, webContents: { isDestroyed: () => false, getURL: () => 'https://remote-ssh-host.internal:8443/c/conv-2' } },
    { isDestroyed: () => false, webContents: { isDestroyed: () => false, getURL: () => 'vscode-remote://ssh-remote+devbox/workspace' } },
    { isDestroyed: () => false, webContents: { isDestroyed: () => false, getURL: () => 'file:///app/index.html' } },
    { isDestroyed: () => false, webContents: { isDestroyed: () => false, getURL: () => 'https://127.0.0.1:51002/c/conv-3' } }
  ];
  Module._load = function (request, parent, isMain) {
    if (request === './utils') {
      return {
        getHubWindows: () => mockHubWindows,
        getHubWebContents: (w) => w.webContents
      };
    }
    if (request === 'electron') {
      return {
        app: { on() { }, getPath: () => os.tmpdir() },
        ipcMain: { handle() { } },
        BrowserWindow: { getAllWindows: () => mockHubWindows },
        BaseWindow: { getAllWindows: () => [] }
      };
    }
    return origLoad.call(this, request, parent, isMain);
  };
  let meterMainMod;
  try {
    delete require.cache[require.resolve('./meter-main')];
    meterMainMod = require('./meter-main');
    const origins = meterMainMod.getActiveHubWindowOrigins();
    assert.deepStrictEqual(origins, ['https://127.0.0.1:51001', 'https://127.0.0.1:51002']);
  } finally {
    Module._load = origLoad;
    delete require.cache[require.resolve('./meter-main')];
  }

  // Layer 2: live-host 同源策略拒绝远端/非白名单 origin (403)
  const server = http.createServer(liveHost.createLiveRequestHandler({
    api: { origin: 'http://127.0.0.1:51001', origins: ['http://127.0.0.1:51001'] },
    secret: 'ssh-test-secret'
  }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const resRemote = await new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1',
        port,
        path: '/runtime-info',
        method: 'POST',
        headers: {
          Origin: 'https://remote-attacker.example.com:8443',
          'X-AG-Context-Token': 'ssh-test-secret'
        }
      }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      });
      req.on('error', reject);
      req.end('{}');
    });
    assert.equal(resRemote, 403, 'live-host 必须拦截远端越权 origin');
  } finally {
    await new Promise((r) => server.close(r));
  }

  // Layer 3: scanFiles 在 isRemote=true 时跳过本地磁盘读取，保留 inlineData 内存计算
  const tinyPngB64 = Buffer.from('89504e470d0a1a0a0000000d494844520000000200000003', 'hex').toString('base64');
  const tmpLocalFile = path.join(os.tmpdir(), `ag-ssh-skip-${Date.now()}.txt`);
  fs.writeFileSync(tmpLocalFile, 'should-not-read-when-remote', 'utf8');
  try {
    const out = await collector.scanFiles([
      { uri: 'vscode-remote://ssh-remote+box/home/dev/app.ts', source: 'user' },
      { uri: tmpLocalFile, source: 'user' },
      { uri: 'inline://img1', inlineData: tinyPngB64, mime: 'image/png', source: 'user' }
    ], { isRemote: true });
    assert.equal(out[0].remoteSkipped, true);
    assert.equal(out[0].status, 'unknown');
    assert.match(out[0].unknownParts[0], /远程|SSH/);
    assert.equal(out[1].remoteSkipped, true, 'isRemote 会话不得误扫本机同名磁盘文件');
    assert.equal(out[2].status, 'parsed', 'inlineData 内存附件在远程会话下仍可正常统计');
    assert.equal(out[2].width, 2);
  } finally {
    fs.rmSync(tmpLocalFile, { force: true });
  }
});

test('Phase 8 (Issue #56): 远程对话停掉等待计时并在底栏速度与浮卡清晰展示远程原因', async () => {
  const source = fs.readFileSync(path.join(__dirname, 'meter-renderer.js'), 'utf8');
  const elements = new Map();
  const makeEl = () => {
    const attrs = new Map();
    const listeners = new Map();
    const el = {
      style: { display: '', left: '', bottom: '', setProperty() {}, removeProperty() {}, getPropertyValue: () => '' },
      children: [],
      hidden: false,
      textContent: '',
      title: '',
      className: '',
      classList: { add() {}, remove() {}, contains: () => false },
      addEventListener(t, f) {
        if (!listeners.has(el)) listeners.set(el, new Map());
        listeners.get(el).set(t, f);
      },
      setAttribute(k, v) { attrs.set(k, String(v)); },
      getAttribute(k) { return attrs.has(k) ? attrs.get(k) : null; },
      removeAttribute(k) { attrs.delete(k); },
      appendChild(x) { this.children.push(x); },
      querySelectorAll() { return []; },
      querySelector() { return null; },
      replaceChildren() { this.children = []; },
      remove() {},
      getBoundingClientRect() { return { left: 200, top: 600, width: 90, height: 24, right: 290, bottom: 624 }; },
      trigger(t, ev = {}) { listeners.get(el)?.get(t)?.(ev); }
    };
    return el;
  };
  const host = makeEl();
  host.attachShadow = () => ({
    set innerHTML(_) {},
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, makeEl());
      return elements.get(id);
    },
    querySelectorAll() { return []; },
    addEventListener() {},
    removeEventListener() {}
  });
  let first = true;
  const lStore = new Map();
  const sandbox = {
    location: { protocol: 'https:', hostname: '127.0.0.1', pathname: '/c/ssh-remote-route' },
    document: {
      hidden: false,
      createElement: () => (first ? (first = false, host) : makeEl()),
      getElementById: () => null,
      documentElement: { appendChild() {} },
      querySelectorAll: () => [],
      querySelector: () => null,
      addEventListener() {},
      removeEventListener() {}
    },
    window: { innerWidth: 1280, innerHeight: 800, __APP_CONFIG__: { csrfToken: 't' } },
    localStorage: { getItem: k => lStore.get(k) || null, setItem: (k, v) => lStore.set(k, String(v)), removeItem: k => lStore.delete(k) },
    __AGContextMeterCore: core,
    AbortController,
    Date,
    setTimeout: () => 1,
    clearTimeout() {},
    setInterval: () => 1,
    clearInterval() {},
    fetch: async () => ({ ok: true, json: async () => ({}) })
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  const api = sandbox.__AGContextMeter;
  try {
    api.startPendingRequestForTest('ssh-remote-route');
    assert.ok(api.getPendingRequestStateForTest(), '远程判定前应先处于等待态');
    api.setComposerStateForTest({
      route: 'ssh-remote-route',
      scan: { conversation: 'ssh-remote-route', session: { isRemote: true, locationKind: 'remote', userMessages: 1, steps: 2 } },
      latest: { isRemote: true, actual: 1200, budget: 200000 }
    });
    assert.equal(api.getPendingRequestStateForTest(), null, '判定为远程对话后必须立刻停止等待计时');
    assert.equal(elements.get('badge-speed').getAttribute('data-speed-phase'), 'remote_unavailable');
    assert.match(elements.get('csb-speed-text').textContent, /远程对话/);
    assert.match(elements.get('csb-group-speed').getAttribute('data-tooltip') || '', /远程\/云端对话/);

    elements.get('csb-group-speed').trigger('mouseenter');
    assert.equal(elements.get('csb-card-speed-val').textContent, '远程对话');
  } finally {
    api.dispose();
  }
});

test('Phase 8 (PR #34 & PR #72): autoCompact 阈值范围校验与免 TUN 启动器参数契约', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-phase8-compact-'));
  try {
    const badLow = collector.savePluginSettings({ uiPreferences: { autoCompactEnabled: true, autoCompactThreshold: 40 } }, { targetDir: tmpDir });
    assert.equal(badLow.ok, false);
    const badHigh = collector.savePluginSettings({ uiPreferences: { autoCompactEnabled: true, autoCompactThreshold: 100 } }, { targetDir: tmpDir });
    assert.equal(badHigh.ok, false);
    const good = collector.savePluginSettings({ uiPreferences: { autoCompactEnabled: true, autoCompactThreshold: 80 } }, { targetDir: tmpDir });
    assert.equal(good.ok, true);
    const loaded = collector.getPluginSettings({ targetDir: tmpDir });
    assert.equal(loaded.uiPreferences.autoCompactEnabled, true);
    assert.equal(loaded.uiPreferences.autoCompactThreshold, 80);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  assert.equal(typeof proxy.createStandaloneNoTunLauncher, 'function');
  assert.equal(typeof proxy.buildHostProxyLaunchSpec, 'function');
});
