'use strict';
process.env.AG_METER_TEST_MODE = '1';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const https = require('node:https');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const { createLiveRequestHandler } = require('./live-host');
const { tryHotInjectDetailed, probeLiveHostRuntimeInfo, shutdownLiveHostGracefully } = require('./install');
const { tryInAppHotReloadAfterUpdate } = require('./meter-main');
const {
  applyUpdateAsync,
  requestGithubUrl,
  resetQuotaHostCacheForTest
} = require('./meter-collector');
const { loadModulesConfig, saveModulesConfig, PROJECT_VERSION } = require('./modules-config');

const {
  resolveEffectivePlanStatus,
  buildModelQuotaSnapshot
} = require('./meter-core');
const CORE_CODE = fs.readFileSync(path.join(__dirname, 'meter-core.js'), 'utf8');
const RENDERER_CODE = fs.readFileSync(path.join(__dirname, 'meter-renderer.js'), 'utf8');

function createIsolatedEnvDir(prefix = 'ag-hotload-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const stateDir = path.join(dir, 'state');
  const appDataDir = path.join(dir, 'appdata');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(path.join(appDataDir, 'Antigravity'), { recursive: true });
  return { dir, stateDir, appDataDir };
}

async function withStateDir(stateDir, fn) {
  const prev = process.env.AG_METER_STATE_DIR;
  const prevAppData = process.env.APPDATA;
  process.env.AG_METER_STATE_DIR = stateDir;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.AG_METER_STATE_DIR;
    else process.env.AG_METER_STATE_DIR = prev;
    if (prevAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = prevAppData;
  }
}

function createHotloadDomSandbox({ fetchImpl = null, contextMeterAPI = null, liveInfo = null, hotCtx = null, bootBackend = null } = {}) {
  const docElements = new Map();
  const shadowElements = new Map();
  const listeners = new Map();
  const docListeners = new Map();
  const winListeners = new Map();
  const trackedIntervals = new Set();
  const clearedIntervals = new Set();
  const trackedTimeouts = new Set();

  const makeEl = (tag = 'div') => {
    const attrs = new Map();
    const children = [];
    const clsSet = new Set();
    const el = {
      tagName: tag.toUpperCase(),
      value: '',
      checked: false,
      hidden: false,
      disabled: false,
      scrollTop: 0,
      textContent: '',
      innerHTML: '',
      style: {
        display: '', opacity: '', cssText: '',
        setProperty() { }, removeProperty() { }, getPropertyValue() { return ''; }
      },
      children,
      parentNode: null,
      get childNodes() { return this.children; },
      get id() { return attrs.get('id') || ''; },
      set id(v) {
        attrs.set('id', String(v));
        if (v) shadowElements.set(String(v), el);
      },
      classList: {
        add(...xs) { xs.forEach(x => clsSet.add(x)); el._syncCls(); },
        remove(...xs) { xs.forEach(x => clsSet.delete(x)); el._syncCls(); },
        contains(x) { return clsSet.has(x); },
        toggle(x, f) {
          if (f === undefined) { if (clsSet.has(x)) clsSet.delete(x); else clsSet.add(x); }
          else if (f) clsSet.add(x); else clsSet.delete(x);
          el._syncCls();
        }
      },
      _syncCls() {
        attrs.set('class', Array.from(clsSet).join(' '));
      },
      get className() { return attrs.get('class') || ''; },
      set className(v) {
        clsSet.clear();
        String(v || '').split(/\s+/).filter(Boolean).forEach(x => clsSet.add(x));
        attrs.set('class', String(v || ''));
      },
      setAttribute(k, v) {
        attrs.set(k, String(v));
        if (k === 'id') shadowElements.set(String(v), el);
        if (k === 'hidden') this.hidden = true;
      },
      getAttribute(k) { return attrs.has(k) ? attrs.get(k) : null; },
      removeAttribute(k) {
        attrs.delete(k);
        if (k === 'hidden') this.hidden = false;
      },
      hasAttribute(k) { return attrs.has(k); },
      appendChild(child) {
        if (!child) return child;
        child.parentNode = this;
        children.push(child);
        if (child.id) shadowElements.set(child.id, child);
        return child;
      },
      insertBefore(newChild, refChild) {
        if (!newChild) return newChild;
        newChild.parentNode = this;
        const idx = children.indexOf(refChild);
        if (idx >= 0) children.splice(idx, 0, newChild);
        else children.push(newChild);
        return newChild;
      },
      removeChild(child) {
        const i = children.indexOf(child);
        if (i >= 0) children.splice(i, 1);
      },
      replaceChildren(...newChildren) {
        children.length = 0;
        for (const c of newChildren) {
          if (c && typeof c === 'object') this.appendChild(c);
        }
      },
      closest() { return null; },
      matches() { return false; },
      dispatchEvent() { return true; },
      remove() {
        if (this.parentNode && Array.isArray(this.parentNode.children)) {
          const idx = this.parentNode.children.indexOf(this);
          if (idx >= 0) this.parentNode.children.splice(idx, 1);
        }
        if (this.id && docElements.get(this.id) === this) docElements.delete(this.id);
      },
      contains(node) {
        if (node === this) return true;
        return children.some(c => c.contains?.(node));
      },
      addEventListener(type, fn) {
        if (!listeners.has(el)) listeners.set(el, new Map());
        const m = listeners.get(el);
        if (!m.has(type)) m.set(type, new Set());
        m.get(type).add(fn);
      },
      removeEventListener(type, fn) {
        listeners.get(el)?.get(type)?.delete(fn);
      },
      click() {
        const fns = listeners.get(el)?.get('click');
        if (fns) for (const fn of fns) fn({ target: el, preventDefault() { }, stopPropagation() { } });
      },
      querySelector() { return null; },
      querySelectorAll(sel) {
        if (sel === '#ag-context-meter') {
          const h = docElements.get('ag-context-meter');
          return h ? [h] : [];
        }
        return [];
      },
      getBoundingClientRect() { return { left: 100, top: 10, right: 200, bottom: 40, width: 100, height: 30 }; },
      focus() { }
    };
    return el;
  };

  const docBody = makeEl('body');
  const ensureKnownShadowNodes = () => {
    const ids = [
      'badge-quota', 'quota-ring-svg', 'quota-ring-fill', 'quota-badge-val', 'quota-badge-tag',
      'panel-quota', 'quota-plan-tier-pill', 'quota-refresh-feedback', 'btn-quota-refresh', 'quota-refresh-text',
      'quota-banner', 'quota-banner-text', 'btn-quota-banner-retry', 'btn-quota-banner-restart',
      'quota-time-updated', 'quota-time-next', 'quota-time-reset',
      'quota-cur-model', 'quota-cur-pool', 'quota-cur-est', 'quota-cur-status', 'quota-cur-alert',
      'quota-cur-buckets', 'quota-pools-list', 'quota-view-body',
      'badge', 'badge-speed', 'badge-tokens', 'badge-cli', 'badge-overflow', 'amount', 'badge-pct-val',
      'panel', 'panel-tokens', 'overflow-menu', 'v',
      'tab-ctx-session', 'tab-ctx-models', 'tab-ctx-speed', 'tab-ctx-settings',
      'pane-ctx-session', 'pane-ctx-models', 'pane-ctx-speed', 'pane-ctx-settings',
      'ctx-model-list', 'ctx-custom-limit-input',
      'input-proxy-url', 'input-proxy-bypass', 'btn-save-proxy-config', 'btn-toggle-proxy-module',
      'proxy-status-desc', 'proxy-test-result', 'chk-enhance-chinese-title', 'btn-enhance-preset-apply',
      'btn-apply-update', 'btn-update-restart', 'btn-check-update', 'btn-check-update-ctx',
      'btn-close-update-pop', 'btn-update-later', 'btn-view-release-page',
      'up-pop-title', 'up-pop-body', 'up-pop-ver', 'up-pop-status',
      'update-popover', 'update-badge-dot', 'update-badge-dot-ctx', 'check-auto-update',
      'ctx-restart-confirm', 'btn-ctx-restart-confirm-yes'
    ];
    for (const id of ids) {
      if (!shadowElements.has(id)) {
        const n = makeEl('div');
        n.id = id;
        if (id.startsWith('panel')) n.hidden = true;
        shadowElements.set(id, n);
      }
    }
  };
  ensureKnownShadowNodes();

  const documentObj = {
    hidden: false,
    body: docBody,
    documentElement: docBody,
    activeElement: null,
    createElement(tag) {
      const n = makeEl(tag);
      if (tag === 'div') {
        n.attachShadow = () => {
          ensureKnownShadowNodes();
          const sr = {
            host: n,
            children: [],
            appendChild(x) { this.children.push(x); return x; },
            getElementById(id) {
              if (!id) return null;
              if (!shadowElements.has(id)) {
                const n = makeEl('div');
                n.id = id;
                shadowElements.set(id, n);
              }
              return shadowElements.get(id);
            },
            querySelector(sel) {
              const m = String(sel).match(/^#([a-zA-Z0-9_-]+)$/);
              return m ? (shadowElements.get(m[1]) || null) : null;
            },
            querySelectorAll() { return []; },
            set innerHTML(_v) {
              ensureKnownShadowNodes();
            },
            get innerHTML() { return ''; }
          };
          n.shadowRoot = sr;
          return sr;
        };
      }
      return n;
    },
    getElementById(id) { return docElements.get(id) || null; },
    querySelector(sel) {
      if (sel === '#ag-context-meter') return docElements.get('ag-context-meter') || null;
      return null;
    },
    querySelectorAll(sel) {
      if (sel === '#ag-context-meter') {
        const h = docElements.get('ag-context-meter');
        return h ? [h] : [];
      }
      return [];
    },
    addEventListener(type, fn) {
      if (!docListeners.has(type)) docListeners.set(type, new Set());
      docListeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      docListeners.get(type)?.delete(fn);
    }
  };

  docBody.appendChild = (child) => {
    if (child) {
      child.parentNode = docBody;
      docBody.children.push(child);
      if (child.id) docElements.set(child.id, child);
    }
    return child;
  };

  const sandbox = {
    URL,
    TextEncoder,
    TextDecoder,
    AbortController,
    Date,
    Math,
    JSON,
    Map,
    Set,
    WeakMap,
    WeakSet,
    Promise,
    Error,
    Number,
    String,
    Boolean,
    Array,
    Object,
    RegExp,
    console,
    location: { protocol: 'https:', hostname: '127.0.0.1', origin: 'https://127.0.0.1:54321', pathname: '/' },
    document: documentObj,
    localStorage: {
      _m: new Map(),
      getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
      setItem(k, v) { this._m.set(k, String(v)); },
      removeItem(k) { this._m.delete(k); }
    },
    innerWidth: 1400,
    innerHeight: 900,
    navigator: {},
    setInterval(fn, ms) {
      const id = globalThis.setInterval(fn, Math.max(ms, 20));
      trackedIntervals.add(id);
      return id;
    },
    clearInterval(id) {
      if (id != null) {
        clearedIntervals.add(id);
        trackedIntervals.delete(id);
      }
      return globalThis.clearInterval(id);
    },
    setTimeout(fn, ms) {
      const t = globalThis.setTimeout(() => {
        trackedTimeouts.delete(t);
        fn();
      }, ms);
      trackedTimeouts.add(t);
      return t;
    },
    clearTimeout(t) {
      trackedTimeouts.delete(t);
      return globalThis.clearTimeout(t);
    },
    fetch: fetchImpl || (async () => ({ ok: false, status: 503, json: async () => ({ ok: false }) }))
  };
  sandbox.globalThis = sandbox;
  sandbox.window = {
    location: sandbox.location,
    innerWidth: 1400,
    innerHeight: 900,
    matchMedia: () => ({ matches: false }),
    addEventListener(type, fn) {
      if (!winListeners.has(type)) winListeners.set(type, new Set());
      winListeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      winListeners.get(type)?.delete(fn);
    }
  };
  if (contextMeterAPI) sandbox.window.contextMeterAPI = contextMeterAPI;
  if (liveInfo) sandbox.window.__AGContextMeterLive = liveInfo;
  if (hotCtx) sandbox.window.__AGContextMeterHotReloadContext = hotCtx;
  if (bootBackend) sandbox.window.__AGContextMeterBootBackend = bootBackend;
  sandbox.window.__APP_CONFIG__ = {};

  const ctx = vm.createContext(sandbox);
  const runBundle = () => {
    vm.runInContext(CORE_CODE + '\n' + RENDERER_CODE, ctx);
  };
  runBundle();

  return {
    sandbox,
    runBundle,
    shadowElements,
    docListeners,
    winListeners,
    getActiveIntervalCount: () => trackedIntervals.size,
    getClearedIntervalCount: () => clearedIntervals.size,
    async flush(ms = 35) {
      await new Promise(r => setTimeout(r, ms));
    },
    cleanup() {
      try { sandbox.__AGContextMeter?.dispose?.(); } catch { }
      for (const id of Array.from(trackedIntervals)) {
        globalThis.clearInterval(id);
        trackedIntervals.delete(id);
      }
      for (const t of Array.from(trackedTimeouts)) {
        globalThis.clearTimeout(t);
        trackedTimeouts.delete(t);
      }
    }
  };
}

function createSimpleZipBuffer(fileMap) {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c >>> 0;
  }
  const entries = [];
  let offset = 0;
  const localHeaders = [];
  for (const [name, content] of Object.entries(fileMap)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const nameBuf = Buffer.from(name, 'utf8');
    let crc32 = 0 ^ -1;
    for (let i = 0; i < data.length; i++) crc32 = (crc32 >>> 8) ^ table[(crc32 ^ data[i]) & 0xff];
    crc32 = (crc32 ^ -1) >>> 0;

    const lh = Buffer.alloc(30 + nameBuf.length);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt32LE(crc32, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    nameBuf.copy(lh, 30);
    localHeaders.push(lh, data);
    entries.push({ nameBuf, crc32, size: data.length, offset });
    offset += lh.length + data.length;
  }
  const cdParts = [];
  let cdSize = 0;
  for (const e of entries) {
    const cd = Buffer.alloc(46 + e.nameBuf.length);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt32LE(e.crc32, 16);
    cd.writeUInt32LE(e.size, 20);
    cd.writeUInt32LE(e.size, 24);
    cd.writeUInt16LE(e.nameBuf.length, 28);
    cd.writeUInt32LE(e.offset, 42);
    e.nameBuf.copy(cd, 46);
    cdParts.push(cd);
    cdSize += cd.length;
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...localHeaders, ...cdParts, eocd]);
}

function createSelfSignedCert() {
  const res = execFileSync(
    'node',
    ['-e', `
      const { generateKeyPairSync } = require('crypto');
      // Use fixed test PEM via openssl? Check if available; fallback to tls mock if not
    `],
    { encoding: 'utf8' }
  );
  return res;
}

test('热加载 1：旧 electron-ipc(v0.8.5) 存在时优先切换至新版 live-host(v0.8.7)，实际额度请求不落入旧 IPC、保留 restartHost 且看板与模型列表一致', async () => {
  let oldIpcQuotaHits = 0;
  let oldIpcSettingsHits = 0;
  let restartHits = 0;
  let liveQuotaHits = 0;
  let liveRuntimeInfoHits = 0;

  const nowMs = Date.now();
  const sampleCfgs = [
    {
      modelId: 'gemini-4-hydrogen-xhigh',
      label: 'Gemini 4 Hydrogen (XHigh)',
      modelOrAlias: { model: 'MODEL_PLACEHOLDER_M528' },
      disabled: false,
      allowedTiers: ['TEAMS_TIER_PRO'],
      quotaInfo: { remainingFraction: 0.88, resetTime: new Date(nowMs + 3600000).toISOString() }
    },
    {
      modelId: 'gemini-4-carbon-xhigh',
      label: 'Gemini 4 Carbon (XHigh)',
      modelOrAlias: { model: 'MODEL_PLACEHOLDER_M670' },
      disabled: false,
      allowedTiers: ['TEAMS_TIER_PRO_ULTIMATE'],
      quotaInfo: { remainingFraction: 0.5, resetTime: new Date(nowMs + 3600000).toISOString() }
    }
  ];
  const samplePlan = resolveEffectivePlanStatus({
    status: 'identified',
    tierKey: 'pro',
    tierId: 'g1-pro-tier',
    teamsTier: 'TEAMS_TIER_PRO',
    tierName: 'Google AI Pro',
    planName: 'Pro'
  }, null);
  const sampleSnapshot = buildModelQuotaSnapshot({
    cascadeModelConfigs: sampleCfgs,
    planStatus: samplePlan,
    currentModel: 'MODEL_PLACEHOLDER_M528',
    nowMs
  });

  const h = createHotloadDomSandbox({
    contextMeterAPI: {
      getQuota: async () => {
        oldIpcQuotaHits++;
        return {
          ok: true,
          data: {
            collectorVersion: '0.8.5',
            backendVersion: '0.8.5',
            snapshot: { activeStatus: 'no_permission', badgeText: '无权限', pools: [] }
          }
        };
      },
      getSettings: async () => {
        oldIpcSettingsHits++;
        return { ok: true };
      },
      getTokenHistory: async () => ({ ok: true, data: {} }),
      restartHost: async () => {
        restartHits++;
        return { ok: true, supported: true };
      }
    },
    liveInfo: {
      port: 55123,
      token: 'live-secret-087',
      version: PROJECT_VERSION,
      backendSource: 'live-host',
      capabilities: { quota: true, settings: true, tokenHistory: true, scan: true },
      verified: true
    },
    hotCtx: { expectedVersion: PROJECT_VERSION, source: 'cli-install', preferLiveHost: true },
    fetchImpl: async (url) => {
      if (String(url).endsWith('/runtime-info')) {
        liveRuntimeInfoHits++;
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, backendVersion: PROJECT_VERSION, backendSource: 'live-host', pid: 43210 })
        };
      }
      if (String(url).endsWith('/quota')) {
        liveQuotaHits++;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            data: {
              collectorVersion: PROJECT_VERSION,
              backendVersion: PROJECT_VERSION,
              backendSource: 'live-host',
              lastSuccessAtMs: nowMs,
              fetchedAtMs: nowMs,
              cascadeModelConfigs: sampleCfgs,
              snapshot: sampleSnapshot
            }
          })
        };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
  });

  try {
    await h.flush();
    h.sandbox.__AGContextMeter.setContextLatestForTest(
      { model: 'Gemini 4 Hydrogen (XHigh)', modelId: 'MODEL_PLACEHOLDER_M528', actual: 1000, budget: 256000 },
      sampleCfgs
    );
    const verifyOut = await h.sandbox.__AGContextMeter.verifyHotReloadAndRefreshQuota();
    await h.flush();

    assert.equal(oldIpcQuotaHits, 0, '旧版 electron-ipc getQuota 绝不能在 live-host 对齐时继续被调用');
    assert.equal(oldIpcSettingsHits, 0, '旧版 electron-ipc getSettings 也不应被错误调用');
    assert.ok(liveRuntimeInfoHits >= 1, '必须实测请求新版 live-host /runtime-info');
    assert.ok(liveQuotaHits >= 1, '必须实际请求新版 live-host /quota');
    assert.equal(verifyOut.rendererVersion, PROJECT_VERSION);
    assert.equal(verifyOut.backendSource, 'live-host');
    assert.equal(verifyOut.backendVersion, PROJECT_VERSION);
    assert.equal(verifyOut.quotaActiveStatus, 'available');
    assert.equal(verifyOut.pendingUpdateRestart, false, '前后端版本对齐后必须自动取消多余重启提示');
    assert.equal(h.shadowElements.get('quota-banner').hidden, true);
    assert.equal(h.shadowElements.get('quota-badge-val').textContent, '88%');

    // 验证上下文模型列表已同步新版 cascadeModelConfigs 且状态与看板一致
    h.sandbox.__AGContextMeter.switchContextTabForTest('models');
    await h.flush();
    const collectTexts = (node) => {
      if (!node || typeof node !== 'object') return [];
      const out = node.textContent ? [String(node.textContent)] : [];
      for (const ch of (node.children || [])) out.push(...collectTexts(ch));
      return out;
    };
    const listText = collectTexts(h.shadowElements.get('ctx-model-list')).join(' | ');
    assert.match(listText, /88%/);
    assert.match(listText, /无权限/);

    // 验证重启入口仍精确走 Electron 主进程 restartHost，而非被 live-host 吞掉
    const restartRes = await h.sandbox.window.contextMeterAPI.restartHost();
    assert.equal(restartHits, 1);
    assert.equal(restartRes.supported, true);
  } finally {
    h.cleanup();
  }
});

test('热加载 2：接口存在但后台仍旧版 & live-host 失败回退旧 IPC 时，诚实标定版本不对齐并展示重启入口', async () => {
  let liveShouldFail = false;
  const h = createHotloadDomSandbox({
    contextMeterAPI: {
      getQuota: async () => ({
        ok: true,
        data: {
          collectorVersion: '0.8.5',
          backendVersion: '0.8.5',
          snapshot: { activeStatus: 'no_permission', badgeText: '无权限', pools: [] }
        }
      }),
      getSettings: async () => ({ ok: true }),
      getTokenHistory: async () => ({ ok: true, data: {} }),
      restartHost: async () => ({ ok: true, supported: true })
    },
    liveInfo: {
      port: 55124,
      token: 'live-secret-087',
      version: PROJECT_VERSION,
      backendSource: 'live-host',
      verified: true
    },
    fetchImpl: async () => {
      if (liveShouldFail) throw new Error('ECONNREFUSED');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          data: {
            collectorVersion: PROJECT_VERSION,
            backendVersion: PROJECT_VERSION,
            backendSource: 'live-host',
            snapshot: { activeStatus: 'available', badgeText: '95%', pools: [] }
          }
        })
      };
    }
  });

  try {
    await h.flush();
    assert.equal(h.sandbox.__AGContextMeter.getBackendStatusForTest().backendVersion, PROJECT_VERSION);
    assert.equal(h.shadowElements.get('quota-banner').hidden, true);

    // 模拟 live-host 意外断开，触发受控回退到旧 electron-ipc (0.8.5)
    liveShouldFail = true;
    await h.sandbox.__AGContextMeter.refreshQuotaForTest(true);
    await h.flush();

    const st = h.sandbox.__AGContextMeter.getBackendStatusForTest();
    assert.equal(st.hotReloadFallback, true);
    assert.equal(st.backendSource, 'electron-ipc');
    assert.equal(st.backendVersion, '0.8.5');
    assert.equal(st.backendVersionMismatch, true);
    assert.equal(h.shadowElements.get('quota-banner').hidden, false);
    assert.equal(h.shadowElements.get('btn-quota-banner-restart').hidden, false);
    assert.match(h.shadowElements.get('quota-banner-text').textContent, /0\.8\.5|旧版|重启/);
  } finally {
    h.cleanup();
  }
});

test('热加载 3：重复热注入保持幂等、彻底清理旧定时器、无缝保留未保存设置草稿与滚动位置', async () => {
  const h = createHotloadDomSandbox({
    contextMeterAPI: {
      getQuota: async () => ({
        ok: true,
        data: {
          collectorVersion: PROJECT_VERSION,
          backendVersion: PROJECT_VERSION,
          snapshot: { activeStatus: 'available', badgeText: '91%', pools: [] }
        }
      }),
      getRuntimeInfo: async () => ({ ok: true, backendVersion: PROJECT_VERSION, backendSource: 'electron-ipc' }),
      getSettings: async () => ({ ok: true }),
      saveSettings: async () => { throw new Error('热加载期间绝不能擅自自动提交保存草稿'); },
      getTokenHistory: async () => ({ ok: true, data: {} })
    }
  });

  try {
    await h.flush();
    const firstInstance = h.sandbox.__AGContextMeter;
    assert.equal(firstInstance.isDisposedForTest(), false);

    // 模拟用户在热加载瞬间已打开模型设置列表、滚动到 240px，且修改了代理 URL 草稿尚未点保存
    h.sandbox.__AGContextMeter.showQuotaPanelForTest(false);
    const pCtx = h.shadowElements.get('panel');
    pCtx.hidden = false;
    const tabModels = h.shadowElements.get('tab-ctx-models');
    tabModels.classList.add('active');
    const listEl = h.shadowElements.get('ctx-model-list');
    listEl.scrollTop = 240;

    const proxyInput = h.shadowElements.get('input-proxy-url');
    proxyInput.value = 'http://127.0.0.1:7899';
    const saveProxyBtn = h.shadowElements.get('btn-save-proxy-config');
    saveProxyBtn.hidden = false;

    const intervalsBefore = h.getActiveIntervalCount();
    assert.equal(intervalsBefore, 1, '单实例只应有 1 个主轮询定时器');

    // 连续重复热注入 2 次
    h.runBundle();
    await h.flush(60);
    assert.equal(firstInstance.isDisposedForTest(), true, '旧实例必须被完整 dispose');

    const secondInstance = h.sandbox.__AGContextMeter;
    h.runBundle();
    await h.flush(60);
    assert.equal(secondInstance.isDisposedForTest(), true, '第二次重注入后前一实例也必须被完整 dispose');

    assert.equal(h.getActiveIntervalCount(), 1, '连续热注入 3 次后活跃定时器必须仍仅为 1，零泄漏叠加');
    assert.ok(h.getClearedIntervalCount() >= 2, '旧实例定时器必须全部 clearInterval');
    assert.equal(h.shadowElements.get('input-proxy-url').value, 'http://127.0.0.1:7899', '未保存的代理草稿必须保留');
    assert.equal(h.shadowElements.get('ctx-model-list').scrollTop, 240, '列表 scrollTop 滚动位置必须保留');
    assert.equal(h.shadowElements.get('panel').hidden, false, '正在查看的面板打开状态必须保留');
  } finally {
    h.cleanup();
  }
});

test('热加载 4：live-host 多窗口 origin 隔离、不串账号缓存、/runtime-info 与 /shutdown 优雅退出', async () => {
  resetQuotaHostCacheForTest();
  const origin1 = 'https://127.0.0.1:56001';
  const origin2 = 'https://127.0.0.1:56002';
  const secret = 'multi-win-secret';
  const startedAt = Date.now();
  let shutdownCalled = 0;

  const handler = createLiveRequestHandler({
    api: { origin: origin1, origins: [origin1, origin2] },
    secret,
    getAllowedOrigins: () => [origin1, origin2],
    onShutdown: () => { shutdownCalled++; },
    startedAt
  });
  const srv = http.createServer(handler);
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;

  const postToLive = (routePath, reqOrigin, tokenHeader = secret, bodyObj = {}) => new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(bodyObj);
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: routePath,
      method: 'POST',
      headers: {
        Origin: reqOrigin,
        'X-AG-Context-Token': tokenHeader,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr)
      }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(data); } catch { }
        resolve({ status: res.statusCode, headers: res.headers, json: parsed });
      });
    });
    req.on('error', reject);
    req.end(bodyStr);
  });

  try {
    // 非授权 origin 必须严格 403 拒绝
    const badOriginRes = await postToLive('/runtime-info', 'https://127.0.0.1:59999');
    assert.equal(badOriginRes.status, 403);

    // 两个授权窗口均可正常读取 /runtime-info 并返回精确匹配的 CORS Origin
    const rt1 = await postToLive('/runtime-info', origin1);
    assert.equal(rt1.status, 200);
    assert.equal(rt1.headers['access-control-allow-origin'], origin1);
    assert.equal(rt1.json.backendVersion, PROJECT_VERSION);
    assert.equal(rt1.json.backendSource, 'live-host');
    assert.equal(rt1.json.capabilities.quota, true);

    const rt2 = await postToLive('/runtime-info', origin2);
    assert.equal(rt2.status, 200);
    assert.equal(rt2.headers['access-control-allow-origin'], origin2);
    assert.deepEqual(rt2.json.origins.sort(), [origin1, origin2].sort());

    // 测试 install.js probeLiveHostRuntimeInfo 与 shutdownLiveHostGracefully
    const probe = await probeLiveHostRuntimeInfo({ port, token: secret, origin: origin1 }, origin2);
    assert.equal(probe.ok, true);
    assert.equal(probe.backendVersion, PROJECT_VERSION);

    const sdRes = await shutdownLiveHostGracefully({ port, token: secret, origin: origin1, pid: 99999999 });
    assert.equal(sdRes.ok, true);
    assert.equal(sdRes.method, 'http_shutdown');
    await new Promise(r => setTimeout(r, 30));
    assert.equal(shutdownCalled, 1, '旧 live-host 必须响应 /shutdown 并触发清理回调');
  } finally {
    await new Promise(r => srv.close(r));
    resetQuotaHostCacheForTest();
  }
});

test('热加载 5：应用内更新免 CDP 多窗口热加载闭环与失败安全回滚 (tryInAppHotReloadAfterUpdate)', async () => {
  const { dir, stateDir } = createIsolatedEnvDir('ag-inapp-hotload-');
  const runtimeDir = path.join(stateDir, 'live-runtime');
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(path.join(runtimeDir, 'live-host.js'), '// mock runtime\n');
  fs.writeFileSync(path.join(runtimeDir, 'meter-core.js'), 'window.__MOCK_CORE__ = "0.8.8";');
  fs.writeFileSync(path.join(runtimeDir, 'meter-renderer.js'), 'window.__AGContextMeter = { version: "0.8.8", verifyHotReloadAndRefreshQuota: async () => ({ rendererVersion: "0.8.8", backendVersion: "0.8.8", backendSource: "live-host" }) };');

  const stampPath = path.join(stateDir, '.live-session.json');
  fs.writeFileSync(stampPath, JSON.stringify({ port: 41000, token: 'old-tok', pid: 1111, version: '0.8.6', origin: 'https://127.0.0.1:54001' }));

  const win1Scripts = [];
  const win2Scripts = [];
  const mockWin1 = {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      getURL: () => 'https://127.0.0.1:54001/index.html',
      executeJavaScript: async (code) => {
        win1Scripts.push(code);
        if (code.includes('verifyHotReloadAndRefreshQuota')) {
          return { rendererVersion: '0.8.8', backendVersion: '0.8.8', backendSource: 'live-host' };
        }
        return true;
      }
    }
  };
  const mockWin2 = {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      getURL: () => 'https://127.0.0.1:54002/index.html',
      executeJavaScript: async (code) => {
        win2Scripts.push(code);
        if (code.includes('verifyHotReloadAndRefreshQuota')) {
          return { rendererVersion: '0.8.8', backendVersion: '0.8.8', backendSource: 'live-host' };
        }
        return true;
      }
    }
  };

  let shutdownOldPids = [];
  try {
    // 5a. 成功免 CDP 多窗口热加载：先起新 live-host -> 注入双窗口 -> 校验版本 -> 再关旧 live-host
    const okRes = await tryInAppHotReloadAfterUpdate({
      ok: true,
      diskInstalled: true,
      liveInjected: false,
      version: '0.8.8',
      installedVersion: '0.8.8',
      liveRuntimeDir: runtimeDir
    }, {
      _stateDir: stateDir,
      _getHubWindows: () => [mockWin1, mockWin2],
      _startLiveHost: async ({ origins, targetVer }) => ({
        port: 42000,
        token: 'new-tok-088',
        pid: 2222,
        origin: origins[0],
        origins,
        version: targetVer,
        backendSource: 'live-host',
        capabilities: { quota: true }
      }),
      _shutdownLiveHost: async (info) => {
        shutdownOldPids.push(info.pid);
      }
    });

    assert.equal(okRes.liveInjected, true);
    assert.equal(okRes.backendHotReloaded, true);
    assert.equal(okRes.backendVersion, '0.8.8');
    assert.equal(okRes.injectedWindowCount, 2);
    assert.equal(okRes.totalWindowCount, 2);
    assert.deepEqual(shutdownOldPids, [1111], '新服务与双窗口就绪后才应关闭旧 live-host');
    assert.ok(win1Scripts[0].includes('window.__AGContextMeterLive') && win1Scripts[0].includes('42000'));
    assert.ok(win2Scripts[0].includes('54002') && win2Scripts[0].includes('42000'));
    assert.equal(JSON.parse(fs.readFileSync(stampPath, 'utf8')).pid, 2222);

    // 5b. 失败回滚：当新 live-host 不可用时，保留原有 .live-session.json 并准确返回 restartRequired: true
    fs.writeFileSync(stampPath, JSON.stringify({ port: 41000, token: 'old-tok', pid: 1111, version: '0.8.6', origin: 'https://127.0.0.1:54001' }));
    const failLiveRes = await tryInAppHotReloadAfterUpdate({
      ok: true,
      diskInstalled: true,
      liveInjected: false,
      version: '0.8.8',
      liveRuntimeDir: runtimeDir
    }, {
      _stateDir: stateDir,
      _getHubWindows: () => [mockWin1],
      _startLiveHost: async () => null
    });
    assert.equal(failLiveRes.liveInjected, false);
    assert.equal(failLiveRes.backendHotReloaded, false);
    assert.equal(failLiveRes.restartRequired, true);
    assert.equal(failLiveRes.hotReloadReason, 'live_host_unavailable');
    assert.equal(JSON.parse(fs.readFileSync(stampPath, 'utf8')).pid, 1111, '失败时绝不能毁掉原可用 .live-session.json');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('更新下载稳定性与脱敏诊断：瞬态 ETIMEDOUT 触发有限次干净流重试成功、全失败附脱敏路由、代理凭据绝不泄露', async () => {
  const { dir, stateDir } = createIsolatedEnvDir('ag-upd-retry-');
  try {
    await withStateDir(stateDir, async () => {
      // 确保默认不改变用户代理选择（插件代理默认关闭）
      const cfg = loadModulesConfig();
      cfg.modules.proxy.enabled = false;
      saveModulesConfig(cfg);

      const zipBuf = createSimpleZipBuffer({
        'package.json': JSON.stringify({ name: 'antigravity-context-viewer', version: '0.8.8' }),
        'cli.js': 'console.log("ok-088");\n'
      });
      const zipSha = crypto.createHash('sha256').update(zipBuf).digest('hex');
      const checksumBody = `${zipSha}  antigravity-context-viewer_0.8.8_${process.platform === 'win32' ? 'windows' : process.platform}_${process.arch === 'x64' ? 'amd64' : process.arch}.zip\n`;

      const targetAssetName = `antigravity-context-viewer_0.8.8_${process.platform === 'win32' ? 'windows' : process.platform}_${process.arch === 'x64' ? 'amd64' : process.arch}.zip`;
      let zipAttempts = 0;

      const flakyFetcher = async (url, opts = {}) => {
        const uStr = String(url);
        if (!opts.streamTo && uStr.includes('/releases')) {
          return JSON.stringify([{
            tag_name: 'v0.8.8',
            draft: false,
            prerelease: false,
            published_at: '2026-11-16T10:00:00Z',
            body: 'hotload candidate',
            assets: [
              { name: 'checksums.txt', browser_download_url: 'https://github.com/elviscjn-cjn/antigravity-context-viewer/releases/download/v0.8.8/checksums.txt' },
              { name: targetAssetName, browser_download_url: `https://github.com/elviscjn-cjn/antigravity-context-viewer/releases/download/v0.8.8/${targetAssetName}` }
            ]
          }]);
        }
        if (String(url).endsWith('checksums.txt')) {
          opts.streamTo.end(checksumBody);
          return;
        }
        if (String(url).endsWith('.zip')) {
          zipAttempts++;
          if (zipAttempts <= 2) {
            const err = new Error('connect ETIMEDOUT 20.247.166.64:443');
            err.code = 'ETIMEDOUT';
            err.diagnostics = {
              phase: opts.phase,
              targetHost: 'release-assets.githubusercontent.com',
              targetPort: 443,
              proxySource: 'direct',
              proxyProtocol: 'direct',
              proxyEndpoint: null,
              bypassMatched: false,
              timeoutPhase: 'tcp_connect'
            };
            throw err;
          }
          opts.streamTo.end(zipBuf);
          return;
        }
      };

      const targetAsar = path.join(dir, 'app.asar');
      fs.writeFileSync(targetAsar, 'dummy');
      const retryOk = await applyUpdateAsync({
        version: '0.8.8',
        currentVersion: '0.8.7',
        targetPath: targetAsar,
        _requestGithubUrl: flakyFetcher,
        _maxDownloadRetries: 2,
        _retryDelayMs: 5,
        _extractZip: async (_zipPath, exDir) => {
          fs.writeFileSync(path.join(exDir, 'package.json'), JSON.stringify({ version: '0.8.8' }));
          fs.writeFileSync(path.join(exDir, 'cli.js'), 'console.log("ok");\n');
          fs.writeFileSync(path.join(exDir, 'live-host.js'), '// live\n');
          fs.writeFileSync(path.join(exDir, 'meter-core.js'), '// core\n');
          return { status: 0 };
        },
        _resolveNodeRuntime: () => ({ runtime: 'node', args: [], env: process.env, isElectron: false }),
        _spawn: () => {
          const { EventEmitter } = require('events');
          const child = new EventEmitter();
          child.stdout = new EventEmitter();
          child.stderr = new EventEmitter();
          setImmediate(() => {
            child.stdout.emit('data', '✅ 运行中窗口热挂载状态: 已即时生效（无需重启）');
            child.emit('close', 0, null);
          });
          return child;
        }
      });

      assert.equal(retryOk.ok, true, retryOk.error || 'retryOk failed');
      assert.equal(zipAttempts, 3, '前两次瞬态 ETIMEDOUT 后第三次重试必须成功');
      assert.equal(retryOk.diagnostics.package.attemptsCount, 3);

      // 超过最大重试次数仍失败时，必须保留脱敏阶段/超时位置诊断
      const alwaysFailFetcher = async (url, opts = {}) => {
        if (!opts.streamTo && String(url).includes('/releases')) return flakyFetcher(url, opts);
        const err = new Error('connect ETIMEDOUT 20.247.166.64:443');
        err.code = 'ETIMEDOUT';
        err.diagnostics = {
          phase: opts.phase,
          targetHost: 'release-assets.githubusercontent.com',
          targetPort: 443,
          proxySource: 'direct',
          proxyProtocol: 'direct',
          proxyEndpoint: null,
          bypassMatched: false,
          timeoutPhase: 'tcp_connect'
        };
        throw err;
      };
      const failRes = await applyUpdateAsync({
        version: '0.8.8',
        currentVersion: '0.8.7',
        targetPath: targetAsar,
        _requestGithubUrl: alwaysFailFetcher,
        _maxDownloadRetries: 1,
        _retryDelayMs: 5
      });
      assert.equal(failRes.ok, false);
      assert.equal(failRes.diagnostics.phase, 'download_checksums');
      assert.equal(failRes.diagnostics.timeoutPhase, 'tcp_connect');
      assert.equal(failRes.diagnostics.attemptsCount, 2);

      // 测试真实 requestGithubUrl 在开启带凭据自定义代理并连接失败时，诊断必须剥离用户名密码
      const deadSrv = http.createServer();
      await new Promise(r => deadSrv.listen(0, '127.0.0.1', r));
      const deadPort = deadSrv.address().port;
      await new Promise(r => deadSrv.close(r));

      cfg.modules.proxy.enabled = true;
      cfg.modules.proxy.proxyUrl = `http://secretUser:secretPass99@127.0.0.1:${deadPort}`;
      cfg.modules.proxy.bypassList = '';
      saveModulesConfig(cfg);

      let caught = null;
      try {
        await requestGithubUrl('https://release-assets.githubusercontent.com/test.zip', {
          timeout: 1200,
          phase: 'download_package',
          proxyConfigOptions: { configPath: path.join(stateDir, 'modules.json') }
        });
      } catch (e) {
        caught = e;
      }
      assert.ok(caught);
      assert.equal(caught.diagnostics.phase, 'download_package');
      assert.equal(caught.diagnostics.targetHost, 'release-assets.githubusercontent.com');
      assert.equal(caught.diagnostics.proxySource, 'plugin_config');
      assert.equal(caught.diagnostics.proxyProtocol, 'http:');
      assert.equal(caught.diagnostics.proxyEndpoint, `http://127.0.0.1:${deadPort}`);
      assert.equal(caught.diagnostics.timeoutPhase, 'proxy_tunnel_connect');
      const serialized = JSON.stringify(caught.diagnostics) + ' ' + caught.message;
      assert.ok(!serialized.includes('secretUser') && !serialized.includes('secretPass99'), '任何诊断和报错绝对不得泄漏代理凭据');
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('热加载 7：PROJECT_VERSION 精确跟随本插件 package.json 但不误读宿主 package.json，未热注入时不篡改渲染版本号', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agcm-ver-iso-'));
  let h = null;
  try {
    // 模拟 ASAR 内部 dist/modules-config.js 与上级宿主 package.json (2.32.1) 共存
    const distDir = path.join(dir, 'dist');
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'antigravity-host', version: '2.32.1' }));
    fs.copyFileSync(path.join(__dirname, 'modules-config.js'), path.join(distDir, 'modules-config.js'));
    fs.copyFileSync(path.join(__dirname, 'asar-engine.js'), path.join(distDir, 'asar-engine.js'));
    fs.copyFileSync(path.join(__dirname, 'meter-storage.js'), path.join(distDir, 'meter-storage.js'));
    fs.copyFileSync(path.join(__dirname, 'meter-proxy.js'), path.join(distDir, 'meter-proxy.js'));

    const hostModCfg = require(path.join(distDir, 'modules-config.js'));
    assert.equal(hostModCfg.PROJECT_VERSION, '0.8.8', '未存在插件自身 package.json 时必须回退插件版本，绝不能误读宿主 2.32.1');

    // 同目录存在本插件 package.json 时，应动态对齐新版本（例如 0.8.9）
    const extDir = path.join(dir, 'ext');
    fs.mkdirSync(extDir, { recursive: true });
    fs.writeFileSync(path.join(extDir, 'package.json'), JSON.stringify({ name: 'antigravity-context-viewer', version: '0.8.9' }));
    fs.copyFileSync(path.join(__dirname, 'modules-config.js'), path.join(extDir, 'modules-config.js'));
    fs.copyFileSync(path.join(__dirname, 'asar-engine.js'), path.join(extDir, 'asar-engine.js'));
    fs.copyFileSync(path.join(__dirname, 'meter-storage.js'), path.join(extDir, 'meter-storage.js'));
    fs.copyFileSync(path.join(__dirname, 'meter-proxy.js'), path.join(extDir, 'meter-proxy.js'));
    const extModCfg = require(path.join(extDir, 'modules-config.js'));
    assert.equal(extModCfg.PROJECT_VERSION, '0.8.9', '存在本插件 package.json 时 PROJECT_VERSION 必须随包版本动态更新');

    // 渲染层：applyUpdate 返回 liveInjected: false 时不得将 #v 伪造为新版号
    h = createHotloadDomSandbox({
      liveBridge: null,
      contextMeterAPI: {
        getRuntimeInfo: async () => ({ ok: true, backendVersion: '0.8.8', backendSource: 'electron-ipc' }),
        checkUpdate: async () => ({
          ok: true,
          hasUpdate: true,
          currentVersion: '0.8.8',
          latestVersion: '0.8.9',
          releaseNotes: 'note',
          htmlUrl: 'https://github.com/elviscjn-cjn/antigravity-context-viewer/releases/tag/v0.8.9'
        }),
        applyUpdate: async () => ({
          ok: true,
          diskInstalled: true,
          liveInjected: false,
          backendHotReloaded: false,
          restartRequired: true,
          version: '0.8.9',
          installedVersion: '0.8.9'
        }),
        getQuota: async () => ({ ok: true, activeStatus: 'available', planInfo: {}, groups: [], models: {}, backendVersion: '0.8.8' }),
        scan: async () => ({ status: 'empty' }),
        getSettings: async () => ({ ok: true, country: 'US', subscriptionRegion: 'US', currency: 'USD', pricingPeriod: 'month' }),
        saveSettings: async () => ({ ok: true })
      }
    });
    const vEl = h.shadowElements.get('v');
    vEl.textContent = 'v0.8.8';
    h.shadowElements.get('btn-check-update').click();
    await h.flush(40);
    h.shadowElements.get('btn-apply-update').click();
    await h.flush(60);
    assert.equal(vEl.textContent, 'v0.8.8', '未完成热注入时顶部运行版本号不得提前伪造为 v0.8.9');
  } finally {
    try { h?.cleanup?.(); } catch { }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('热加载 8：存在 HTTP_PROXY/HTTPS_PROXY 且缺少 NO_PROXY 时，回环热加载探活与本地主机连接严格直连不误走代理', async () => {
  const prevHttp = process.env.HTTP_PROXY;
  const prevHttps = process.env.HTTPS_PROXY;
  const prevNoProxy = process.env.NO_PROXY;
  const loopSrv = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, backendVersion: PROJECT_VERSION, backendSource: 'live-host' }));
  });
  let proxyHits = 0;
  const blackholeProxy = http.createServer((req, res) => {
    proxyHits++;
    res.writeHead(405);
    res.end('Use CONNECT');
  });
  blackholeProxy.on('connect', (_req, sock) => {
    proxyHits++;
    sock.write('HTTP/1.1 405 Method Not Allowed\r\n\r\n');
    sock.destroy();
  });

  await new Promise(r => loopSrv.listen(0, '127.0.0.1', r));
  await new Promise(r => blackholeProxy.listen(0, '127.0.0.1', r));
  const loopPort = loopSrv.address().port;
  const proxyPort = blackholeProxy.address().port;

  try {
    process.env.HTTP_PROXY = `http://127.0.0.1:${proxyPort}`;
    process.env.HTTPS_PROXY = `http://127.0.0.1:${proxyPort}`;
    delete process.env.NO_PROXY;

    const { probeLiveHostRuntimeInfo } = require('./install');
    const probe = await probeLiveHostRuntimeInfo(
      { port: loopPort, token: 'test-tok', origin: 'https://127.0.0.1:61597' },
      'https://127.0.0.1:61597'
    );
    assert.equal(probe.ok, true, '即使全局设置了 HTTP_PROXY，回环探活必须直连成功而非返回 405');
    assert.equal(probe.backendVersion, PROJECT_VERSION);
    assert.equal(proxyHits, 0, '任何 127.0.0.1 回环控制面请求均不得误入外置代理');
  } finally {
    if (prevHttp === undefined) delete process.env.HTTP_PROXY;
    else process.env.HTTP_PROXY = prevHttp;
    if (prevHttps === undefined) delete process.env.HTTPS_PROXY;
    else process.env.HTTPS_PROXY = prevHttps;
    if (prevNoProxy === undefined) delete process.env.NO_PROXY;
    else process.env.NO_PROXY = prevNoProxy;
    await new Promise(r => loopSrv.close(r));
    await new Promise(r => blackholeProxy.close(r));
  }
});

test('热加载 9：cli 注入失败时 rollbackPreparedLiveBridge 恢复旧 .live-session.json 且 live-host 拒绝错误 token / 脱敏检查错误', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-hotload-rollback-'));
  const sessionPath = path.join(tmpDir, '.live-session.json');
  const prevInfo = { pid: 1001, port: 41001, token: 'old-tok', origin: 'https://127.0.0.1:41001', version: '0.8.6' };
  const nextInfo = { pid: 999999, port: 41002, token: 'new-tok', origin: 'https://127.0.0.1:41002', version: '0.8.7' };
  try {
    fs.writeFileSync(sessionPath, JSON.stringify(nextInfo, null, 2));
    const { rollbackPreparedLiveBridge } = require('./cli');
    const rb1 = await rollbackPreparedLiveBridge({
      reused: false,
      liveInfo: nextInfo,
      previousLiveInfo: prevInfo,
      statePath: sessionPath
    });
    assert.equal(rb1.rolledBack, true);
    const restored = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
    assert.equal(restored.pid, 1001);
    assert.equal(restored.version, '0.8.6');

    fs.writeFileSync(sessionPath, JSON.stringify(nextInfo, null, 2));
    const rb2 = await rollbackPreparedLiveBridge({
      reused: false,
      liveInfo: nextInfo,
      previousLiveInfo: null,
      statePath: sessionPath
    });
    assert.equal(rb2.rolledBack, true);
    assert.equal(fs.existsSync(sessionPath), false, '无旧连接时回滚应清理新建的 .live-session.json');

    // timingSafeTokenEqual 拒绝错长度与空/错误 token
    const { createLiveRequestHandler } = require('./live-host');
    const handler = createLiveRequestHandler({
      api: { origin: 'https://127.0.0.1:51111', origins: ['https://127.0.0.1:51111'] },
      secret: 'secret-token-value-123456'
    });
    const fakeRes = () => ({ status: 0, headers: {}, writeHead(s) { this.status = s; }, setHeader(k, v) { this.headers[k] = v; }, end() { } });
    const rBadLen = fakeRes();
    await handler({ method: 'POST', url: '/runtime-info', headers: { origin: 'https://127.0.0.1:51111', 'x-ag-context-token': 'short' } }, rBadLen);
    assert.equal(rBadLen.status, 403);
    const rBadSameLen = fakeRes();
    await handler({ method: 'POST', url: '/runtime-info', headers: { origin: 'https://127.0.0.1:51111', 'x-ag-context-token': 'secret-token-value-999999' } }, rBadSameLen);
    assert.equal(rBadSameLen.status, 403);

    // checkUpdateAsync 报错脱敏代理凭据
    const collector = require('./meter-collector');
    const errRes = await collector.checkUpdateAsync({
      force: true,
      currentVersion: '0.8.7',
      _requestGithubUrl: async () => {
        throw new Error('connect via http://alice:supersecret@127.0.0.1:7897 failed');
      }
    });
    assert.equal(errRes.ok, false);
    assert.doesNotMatch(errRes.error, /alice|supersecret/, '检查更新报错必须剥离代理账密凭据');
    assert.match(errRes.error, /http:\/\/127\.0\.0\.1:7897/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('热加载 10：dropdown 自定义套餐设置与热力图视图切换保存优先路由至新版 live-host /save-settings', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-dropdown-live-'));
  let h;
  try {
    let ipcSaveHits = 0;
    const liveReqs = [];
    h = createHotloadDomSandbox({
      liveInfo: {
        port: 49999,
        token: 'tok-live',
        version: PROJECT_VERSION,
        backendSource: 'live-host'
      },
      hotCtx: {
        expectedVersion: PROJECT_VERSION,
        source: 'in-app-update',
        preferLiveHost: true
      },
      fetchImpl: async (url, opts) => {
        if (String(url).startsWith('http://127.0.0.1:49999')) {
          liveReqs.push({ url, body: JSON.parse(opts.body || '{}') });
          return { ok: true, status: 200, json: async () => ({ ok: true }) };
        }
        return new Promise(() => { });
      },
      contextMeterAPI: {
        getRuntimeInfo: async () => ({ ok: true, backendVersion: '0.8.6', backendSource: 'electron-ipc' }),
        saveSettings: async () => { ipcSaveHits++; return { ok: true }; },
        getQuota: async () => ({ ok: true, activeStatus: 'available', planInfo: {}, groups: [], models: {}, backendVersion: '0.8.6' }),
        scan: async () => ({ status: 'empty' }),
        getSettings: async () => ({ ok: true, country: 'US', subscriptionRegion: 'US', currency: 'USD', pricingPeriod: 'month' })
      }
    });
    await h.flush(30);
    h.shadowElements.get('h-tab-weekly').click();
    h.shadowElements.get('btn-custom-plan-clear').click();
    await h.flush(30);
    assert.equal(ipcSaveHits, 0, '旧版 IPC 不得在热加载新版 live-host 就绪时劫持保存设置');
    assert.ok(liveReqs.some(r => r.url.endsWith('/save-settings') && r.body.savedHeatView === 'weekly'));
    assert.ok(liveReqs.some(r => r.url.endsWith('/save-settings') && r.body.clearPlan === true));
  } finally {
    try { h?.cleanup?.(); } catch { }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('热加载 11：非测试上下文执行 collectTokenHistoryAsync 后 Worker.unref 生效，进程快速退出不卡死 45s 空闲等待', () => {
  const { execFileSync } = require('node:child_process');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-worker-exit-'));
  try {
    const cleanEnv = { ...process.env };
    delete cleanEnv.NODE_TEST_CONTEXT;
    const t0 = Date.now();
    execFileSync(process.execPath, [
      '-e',
      `const { collectTokenHistoryAsync } = require(${JSON.stringify(path.join(__dirname, 'meter-collector.js'))});
       collectTokenHistoryAsync({ force: true, agDir: ${JSON.stringify(tmpDir)} }).then(r => {
         if (!r) process.exit(2);
       });`
    ], { env: cleanEnv, timeout: 5000, stdio: 'pipe' });
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 4500, `Worker.unref 未生效或阻塞退出，耗时 ${elapsed}ms`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('热加载 12：build-renderer 检测到 truncated for diff preview 时立即停止构建并报告文件及位置，保留现场字节不变，恢复正常源码后可正常构建', () => {
  const { buildRenderer } = require('./scripts/build-renderer');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-build-trunc-guard-'));
  const tmpSrc = path.join(tmpRoot, 'src', 'renderer');
  const tmpOut = path.join(tmpRoot, 'meter-renderer.js');
  try {
    fs.mkdirSync(tmpSrc, { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'package.json'), JSON.stringify({ name: 'antigravity-context-viewer', version: '0.8.7' }), 'utf8');
    for (const f of ['styles.css', 'template.html', 'colors.js', 'i18n.js', 'context-budget-engine.js', 'dropdown.js', 'heatmap.js']) {
      fs.copyFileSync(path.join(__dirname, 'src', 'renderer', f), path.join(tmpSrc, f));
    }

    const truncatedMainPath = path.join(tmpSrc, 'main.js');
    const truncatedContent = [
      '(function () {',
      '  "use strict";',
      '  const UnsavedUserDraft = 42;',
      '  ...[truncated for diff preview]',
      '})();'
    ].join('\n');
    fs.writeFileSync(truncatedMainPath, truncatedContent, 'utf8');
    const beforeBytes = fs.readFileSync(truncatedMainPath);
    fs.writeFileSync(tmpOut, '// PREVIOUS_VALID_BUNDLE', 'utf8');

    let caughtErr = null;
    try {
      buildRenderer({ rootDir: tmpRoot, srcDir: tmpSrc, targetFile: tmpOut });
    } catch (err) {
      caughtErr = err;
    }

    assert.ok(caughtErr, '检测到截断标记时必须抛出异常阻止构建');
    assert.equal(caughtErr.code, 'ERR_SOURCE_TRUNCATED');
    assert.equal(caughtErr.filePath, truncatedMainPath);
    assert.equal(caughtErr.line, 4);
    assert.equal(caughtErr.column, 7);
    assert.match(caughtErr.message, /main\.js:4:7/, '错误信息必须包含准确文件名、行号与列号');

    const afterBytes = fs.readFileSync(truncatedMainPath);
    assert.equal(Buffer.compare(beforeBytes, afterBytes), 0, '严禁覆盖或修改截断源文件现场字节');
    assert.equal(fs.readFileSync(tmpOut, 'utf8'), '// PREVIOUS_VALID_BUNDLE', '中止构建时不得覆写已有构建产物');

    // 恢复为正常完整源码后应能正常构建
    fs.copyFileSync(path.join(__dirname, 'src', 'renderer', 'main.js'), truncatedMainPath);
    buildRenderer({ rootDir: tmpRoot, srcDir: tmpSrc, targetFile: tmpOut });
    const builtContent = fs.readFileSync(tmpOut, 'utf8');
    assert.ok(!builtContent.includes('truncated for diff preview'));
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('热加载 10：live-host /runtime-info 返回 hostBuildId 且 cli 同版本不同构建指纹不盲目复用旧进程', async () => {
  const { LIVE_HOST_BUILD_ID } = require('./live-host');
  const { getHostCoreBuildId, PROJECT_VERSION } = require('./modules-config');
  assert.equal(LIVE_HOST_BUILD_ID, getHostCoreBuildId(__dirname), 'live-host 启动固化指纹必须与 modules-config 实时计算一致');

  const tmpState = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-buildid-mismatch-'));
  try {
    // 写入与当前 version 相同但 hostBuildId 明显陈旧的 .live-session.json
    const staleStamp = {
      port: 65431,
      token: 'stale-tok',
      pid: process.pid,
      origin: 'https://127.0.0.1:59991',
      origins: ['https://127.0.0.1:59991'],
      version: PROJECT_VERSION,
      hostBuildId: '000000000000',
      hasQuota: true
    };
    fs.writeFileSync(path.join(tmpState, '.live-session.json'), JSON.stringify(staleStamp));

    const fakeSnapshot = { running: true, pageFound: true, origin: 'https://127.0.0.1:59991', origins: ['https://127.0.0.1:59991'], ipcBackendVersion: '0.8.7', hasIpcBridge: true, hasQuotaIpcBridge: true };
    const { ensureLiveBridgeIfNeeded } = require('./cli');
    // 在无真实 Antigravity 环境下验证不复用旧构建后进入拉新流程且不返回 reused: true
    const res = await ensureLiveBridgeIfNeeded(fakeSnapshot, { stateDir: tmpState });
    assert.notEqual(res?.reused, true, '同版本不同 hostBuildId 时绝不能直接复用旧 live-host 内存进程');
  } finally {
    fs.rmSync(tmpState, { recursive: true, force: true });
  }
});
