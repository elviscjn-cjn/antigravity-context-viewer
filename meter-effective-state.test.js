const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const core = require('./meter-core');

// 引入构建后的 renderer 脚本进行纯隔离测试
const source = fs.readFileSync(path.join(__dirname, 'meter-renderer.js'), 'utf8');

function createTestHarness(options = {}) {
  const elements = new Map();
  const docElements = new Map();
  const listeners = new Map();

  const makeElement = (tag = 'div') => {
    const attrs = new Map();
    const props = new Map();
    const children = [];
    const el = {
      tagName: tag.toUpperCase(),
      style: {
        display: '',
        opacity: '',
        cssText: '',
        setProperty(k, v) { props.set(k, v); },
        removeProperty(k) { props.delete(k); },
        getPropertyValue(k) { return props.get(k) || ''; }
      },
      children,
      hidden: false,
      textContent: '',
      innerHTML: '',
      disabled: false,
      get id() { return attrs.get('id') || ''; },
      set id(v) { attrs.set('id', String(v)); if (v) docElements.set(String(v), el); },
      get className() { return attrs.get('class') || ''; },
      set className(v) { attrs.set('class', String(v || '')); },
      get childNodes() { return this.children; },
      classList: {
        add(c) {
          const current = (attrs.get('class') || '').split(/\s+/).filter(Boolean);
          if (!current.includes(c)) current.push(c);
          attrs.set('class', current.join(' '));
        },
        remove(c) {
          const current = (attrs.get('class') || '').split(/\s+/).filter(x => x && x !== c);
          attrs.set('class', current.join(' '));
        },
        contains(c) {
          return (attrs.get('class') || '').split(/\s+/).includes(c);
        },
        toggle(c, force) {
          if (force !== undefined) {
            if (force) this.add(c); else this.remove(c);
          } else {
            if (this.contains(c)) this.remove(c); else this.add(c);
          }
        }
      },
      addEventListener(type, fn) {
        if (!listeners.has(el)) listeners.set(el, new Map());
        const elListeners = listeners.get(el);
        if (!elListeners.has(type)) elListeners.set(type, []);
        elListeners.get(type).push(fn);
      },
      removeEventListener(type, fn) {
        const elListeners = listeners.get(el);
        if (!elListeners || !elListeners.has(type)) return;
        const list = elListeners.get(type);
        const idx = list.indexOf(fn);
        if (idx !== -1) list.splice(idx, 1);
      },
      trigger(type, event = {}) {
        const elListeners = listeners.get(el);
        const handlers = elListeners?.get(type) || [];
        for (const handler of handlers) handler(event);
      },
      click() { this.trigger('click'); },
      setAttribute(k, v) {
        attrs.set(k, String(v));
        if (k === 'id' && v) docElements.set(String(v), el);
        if (k === 'class') attrs.set('class', String(v || ''));
      },
      getAttribute(k) { return attrs.get(k) ?? null; },
      hasAttribute(k) { return attrs.has(k); },
      removeAttribute(k) { attrs.delete(k); },
      appendChild(child) {
        children.push(child);
        child.parentElement = el;
        child.parentNode = el;
        return child;
      },
      removeChild(child) {
        const idx = children.indexOf(child);
        if (idx !== -1) children.splice(idx, 1);
        child.parentElement = null;
        child.parentNode = null;
        return child;
      },
      querySelector(sel) {
        return children.find(c => {
          if (sel.startsWith('#')) return c.id === sel.slice(1);
          if (sel.startsWith('.')) return c.classList.contains(sel.slice(1));
          return false;
        }) || null;
      },
      querySelectorAll() { return []; },
      replaceChildren() { this.children = []; },
      getBoundingClientRect() { return { top: 0, left: 0, right: 100, bottom: 40, width: 100, height: 40 }; }
    };
    return el;
  };

  const shadow = {
    getElementById(id) {
      if (elements.has(id)) return elements.get(id);
      const el = makeElement('div');
      el.id = id;
      elements.set(id, el);
      return el;
    },
    querySelector(sel) {
      if (sel.startsWith('#')) return this.getElementById(sel.slice(1));
      return null;
    },
    querySelectorAll() { return []; },
    appendChild() {},
    innerHTML: ''
  };

  const doc = {
    getElementById(id) {
      if (docElements.has(id)) return docElements.get(id);
      return shadow.getElementById(id);
    },
    querySelector(sel) {
      if (sel.startsWith('#')) return this.getElementById(sel.slice(1));
      if (sel.includes('title-menu-bar-item')) {
        for (const el of docElements.values()) {
          if (el.getAttribute && el.getAttribute('data-testid') === 'title-menu-bar-item') return el;
        }
      }
      return null;
    },
    querySelectorAll(sel) {
      if (sel.includes('agy-button')) {
        return Array.from(docElements.values()).filter(el => el.classList && el.classList.contains('agy-button'));
      }
      return [];
    },
    createElement(tag) { return makeElement(tag); },
    body: makeElement('body'),
    documentElement: makeElement('html'),
    title: 'Workspace - Antigravity',
    addEventListener() {},
    removeEventListener() {}
  };

  const localStore = new Map();
  const localStorage = {
    getItem: k => localStore.get(k) || null,
    setItem: (k, v) => localStore.set(k, String(v)),
    removeItem: k => localStore.delete(k),
    clear: () => localStore.clear()
  };

  let restartCalled = false;
  const mockApi = {
    getSettings: async () => ({ ok: true, data: {} }),
    saveSettings: async (p) => ({ ok: true, data: p }),
    restartHost: async () => { restartCalled = true; return { ok: true }; },
    getContextUnlockStatus: async () => ({ ok: true, status: 'unpatched_official' }),
    getModulesStatus: async () => ({ ok: true, data: { modules: { chinese: { enabled: false, brandTitle: 'english' } } } }),
    toggleModule: async (m, e, o) => ({ ok: true, data: { modules: { chinese: { enabled: e, brandTitle: o?.brandTitle || 'english' } } } })
  };

  const intervals = [];
  const timeoutCallbacks = [];
  const sandbox = {
    console,
    Date,
    Math,
    String,
    Number,
    Boolean,
    Array,
    Object,
    RegExp,
    JSON,
    AbortController,
    fetch: async () => ({ ok: false }),
    setTimeout: (fn, ms) => {
      if (ms === 10000) { timeoutCallbacks.push(fn); return setTimeout(fn, 10000); }
      return setTimeout(fn, 0);
    },
    clearTimeout,
    setInterval: (fn) => { intervals.push(fn); return intervals.length; },
    clearInterval: () => {},
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    cancelAnimationFrame: () => {},
    location: { protocol: 'https:', hostname: '127.0.0.1', pathname: '/c/11111111-1111-1111-1111-111111111111' },
    document: doc,
    window: {
      document: doc,
      localStorage,
      location: { protocol: 'https:', hostname: '127.0.0.1', pathname: '/c/11111111-1111-1111-1111-111111111111' },
      contextMeterAPI: mockApi,
      innerWidth: 1024,
      innerHeight: 768,
      addEventListener() {},
      removeEventListener() {}
    },
    localStorage,
    navigator: { platform: 'Win32' },
    __AGContextMeterCore: core,
    ANTIGRAVITY_TOKEN_DATA: {
      summary: { grandTotalTokens: 0, todayTokens: 0, monthTokens: 0, yearTokens: 0, totalConversations: 0 }
    }
  };
  sandbox.globalThis = sandbox;
  sandbox.window.window = sandbox.window;

  // 预创建影子节点挂载宿主
  const hostEl = makeElement('div');
  hostEl.remove = () => {};
  hostEl.attachShadow = () => shadow;
  doc.createElement = (tag) => {
    if (tag === 'div') return hostEl;
    return makeElement(tag);
  };

  if (typeof options?.setupSandbox === 'function') options.setupSandbox(sandbox);
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);

  return {
    sandbox,
    doc,
    elements,
    api: sandbox.__AGContextMeter,
    tick: () => intervals[0] && intervals[0](),
    timeoutCallbacks,
    getRestartCalled: () => restartCalled
  };
}

const keys = ['prompt', 'title', 'lang', 'ctx'];
const flush = () => new Promise(resolve => setTimeout(resolve, 35));
function fixture(on = []) {
  return {
    enhance: { supported: true, summary: {
      promptTier: on.includes('prompt') ? 4 : 0,
      chineseTitleMode: on.includes('title') ? 'zh' : 'en',
      syncState: 'runtime_confirmed', languageServerRunning: true
    } },
    modules: { ok: true, data: { modules: { chinese: { enabled: on.includes('lang'), brandTitle: 'hidden' } } },
      disk: { chineseReady: on.includes('lang') }, runtime: { chineseActive: on.includes('lang') } },
    unlock: { status: on.includes('ctx') ? 'patched_loaded' : 'not_patched',
      configuredMode: on.includes('ctx') ? 'dynamic' : 'default', runtimeEvidence: { restartDetected: true } }
  };
}
function setup(data = fixture(), overrides = {}) {
  const calls = [];
  const h = createTestHarness({ setupSandbox(s) {
    Object.assign(s.window.contextMeterAPI, {
      getEnhanceStatus: async () => ({ ok: true, data: data.enhance }),
      getModulesStatus: async () => data.modules,
      getContextUnlockStatus: async () => ({ ok: true, data: data.unlock }),
      applyEnhancePatch: async p => {
        calls.push(['enhance', JSON.parse(JSON.stringify(p))]);
        if ('promptTier' in p) data.enhance.summary.promptTier = p.promptTier;
        if ('chineseTitle' in p) data.enhance.summary.chineseTitleMode = p.chineseTitle ? 'zh' : 'en';
        return { ok: true, changed: true, needsRestart: false };
      },
      toggleModule: async (name, enabled, opts) => {
        calls.push(['lang', name, enabled, JSON.parse(JSON.stringify(opts))]);
        data.modules.data.modules.chinese.enabled = enabled;
        data.modules.disk.chineseReady = enabled;
        data.modules.runtime.chineseActive = enabled;
        return { ok: true, restartRequired: false };
      },
      applyContextUnlock: async p => {
        calls.push(['ctxApply', JSON.parse(JSON.stringify(p))]);
        data.unlock = fixture(['ctx']).unlock;
        return { ok: true, needsRestart: false };
      },
      restoreContextUnlock: async () => {
        calls.push(['ctxRestore']); data.unlock = fixture().unlock; return { ok: true };
      },
      restoreAllEnhance: async () => {
        calls.push(['restoreAllEnhance']); data.enhance = fixture().enhance; return { ok: true };
      },
      ...overrides
    });
  } });
  h.calls = calls;
  h.data = data;
  h.box = key => h.elements.get(`chk-rec-${key}`);
  h.state = key => h.elements.get(`rec-${key}-state`).getAttribute('data-state');
  h.open = async () => { h.elements.get('btn-ctx-settings').click(); await flush(); };
  h.change = (key, enabled) => {
    h.box(key).checked = enabled;
    h.box(key).trigger('change', { target: h.box(key) });
  };
  h.preview = () => h.elements.get('btn-enhance-preset-apply').click();
  h.confirm = async () => { h.elements.get('btn-enhance-confirm-go').click(); await flush(); };
  return h;
}

for (const on of [[], ['prompt', 'lang'], keys]) {
  test(`effective-state: opening and reopening reflects only runtime-confirmed ${on.join('+') || 'all off'}`, async () => {
    const h = setup(fixture(on));
    for (const key of keys) {
      assert.equal(h.box(key).checked, false);
      assert.equal(h.box(key).indeterminate, true);
      assert.equal(h.box(key).disabled, true);
    }
    await h.open();
    for (const key of keys) {
      assert.equal(h.box(key).checked, on.includes(key), key);
      assert.equal(h.box(key).indeterminate, false, key);
      assert.equal(h.state(key), on.includes(key) ? 'on' : 'off');
    }
    assert.equal(h.calls.length, 0, 'read-only opening cannot write');
    h.data.enhance.summary.promptTier = on.includes('prompt') ? 0 : 4;
    h.api.switchContextTabForTest('models');
    await h.open();
    assert.equal(h.box('prompt').checked, !on.includes('prompt'));
    h.api.dispose();
  });
}

test('effective-state: disk writes pending restart are not checked as active', async () => {
  const data = fixture(keys);
  data.enhance.summary.syncState = 'pending_ls_restart';
  data.unlock.status = 'patched_pending_restart';
  data.modules.runtime = { chineseActive: false, chineseNeedsRestart: true };
  const h = setup(data); await h.open();
  for (const key of keys) {
    assert.equal(h.state(key), 'pendingRestart');
    assert.equal(h.box(key).checked, false);
    assert.equal(h.box(key).indeterminate, true);
    assert.equal(h.elements.get(`rec-${key}-state`).textContent, '待重启');
  }
  h.preview(); await h.confirm(); assert.deepEqual(h.calls, []);
  data.enhance.summary.syncState = 'disk_only_patched';
  await h.api.refreshEnhanceStatusForTest();
  assert.equal(h.state('prompt'), 'pendingRestart');
  h.api.dispose();
});

test('effective-state: saved preferences, lower tiers, mixed title and fixed budgets never masquerade as recommendation on', async () => {
  const data = fixture();
  data.enhance.savedConfig = { promptTier: 4, chineseTitle: true };
  Object.assign(data.enhance.summary, { savedPromptTier: 4, savedChineseTitle: true });
  data.unlock = { status: 'patched_loaded', configuredMode: 'fixed', configuredLimit: 1000000, runtimeEvidence: { restartDetected: true } };
  const h = setup(data); await h.open();
  assert.equal(h.state('prompt'), 'off');
  assert.equal(h.state('title'), 'off');
  assert.equal(h.state('ctx'), 'off');
  for (const tier of [1, 2, 3]) {
    data.enhance.summary.promptTier = tier;
    await h.api.refreshEnhanceStatusForTest();
    assert.equal(h.state('prompt'), 'off');
  }
  data.enhance.summary.chineseTitleMode = 'mixed';
  await h.api.refreshEnhanceStatusForTest();
  assert.equal(h.state('title'), 'unknown');
  assert.equal(h.box('title').indeterminate, true);
  h.api.dispose();
});

test('effective-state: null, not-running, missing runtime, errors and unsupported remain explicit', async () => {
  const data = fixture(keys);
  data.enhance.summary.languageServerRunning = false;
  data.modules.runtime = null;
  data.unlock = null;
  const h = setup(data); await h.open();
  assert.equal(h.state('prompt'), 'unknown');
  assert.equal(h.state('lang'), 'unknown');
  assert.equal(h.state('ctx'), 'error');
  h.sandbox.window.contextMeterAPI.getEnhanceStatus = async () => { throw new Error('read failed'); };
  await h.api.refreshEnhanceStatusForTest();
  assert.equal(h.state('prompt'), 'error');
  h.sandbox.window.contextMeterAPI.getEnhanceStatus = async () => ({ ok: true, data: { supported: false } });
  data.unlock = { isPlatformSupported: false, status: 'unsupported' };
  await h.api.refreshEnhanceStatusForTest(); await h.api.refreshUnlockStatusForTest();
  for (const key of ['prompt', 'title', 'ctx']) {
    assert.equal(h.state(key), 'unsupported');
    assert.equal(h.box(key).disabled, true);
    assert.equal(h.box(key).checked, false);
    assert.equal(h.box(key).indeterminate, false);
  }
  assert.equal(h.box('lang').disabled, false, 'Mac enhancement support must not disable host language');
  h.api.dispose();
});

test('effective-state: stalled detection becomes unknown; late replies cannot replace newer observations', async () => {
  const h = setup(); await h.open();
  let resolveOld;
  h.sandbox.window.contextMeterAPI.getEnhanceStatus = () => new Promise(resolve => { resolveOld = resolve; });
  const old = h.api.refreshEnhanceStatusForTest();
  assert.equal(h.state('prompt'), 'loading');
  h.timeoutCallbacks.at(-1)(); await old;
  assert.equal(h.state('prompt'), 'unknown');
  assert.equal(h.box('prompt').indeterminate, true);
  h.sandbox.window.contextMeterAPI.getEnhanceStatus = async () => ({ ok: true, data: fixture(keys).enhance });
  await h.api.refreshEnhanceStatusForTest();
  resolveOld({ ok: true, data: fixture().enhance }); await flush();
  assert.equal(h.state('prompt'), 'on');
  h.api.dispose();
});

test('effective-state: cancel, no diff and repeated apply never write', async () => {
  const h = setup(); await h.open();
  h.preview(); await h.confirm(); assert.deepEqual(h.calls, []);
  h.change('prompt', true); h.preview();
  assert.match(h.elements.get('enhance-preset-confirm-text').textContent, /将开启：.*将关闭/);
  h.elements.get('btn-enhance-confirm-cancel').click();
  await h.confirm(); assert.deepEqual(h.calls, []);
  h.preview(); await h.confirm();
  assert.deepEqual(h.calls, [['enhance', { promptTier: 4 }]]);
  h.preview(); await h.confirm();
  assert.equal(h.calls.length, 1);
  h.api.dispose();
});

for (const key of keys) {
  test(`effective-state: unchecking active ${key} restores only that item`, async () => {
    const h = setup(fixture(keys)); await h.open();
    h.change(key, false); assert.equal(h.elements.get('rec-draft-note').hidden, false);
    h.preview(); assert.match(h.elements.get('enhance-preset-confirm-text').textContent, /将关闭（恢复该项）：/);
    assert.deepEqual(h.calls, []);
    await h.confirm();
    const expected = {
      prompt: ['enhance', { promptTier: 0 }], title: ['enhance', { chineseTitle: false }],
      lang: ['lang', 'chinese', false, { language: 'en', brandTitle: 'hidden' }], ctx: ['ctxRestore']
    };
    assert.deepEqual(h.calls, [expected[key]]);
    assert.equal(h.box(key).checked, false);
    assert.equal(h.state(key), 'off');
    h.preview(); await h.confirm(); assert.equal(h.calls.length, 1);
    h.api.dispose();
  });
}

test('effective-state: enabling each switch uses only its scoped API payload', async () => {
  const h = setup(); await h.open();
  for (const key of keys) h.change(key, true);
  h.preview(); await h.confirm();
  assert.deepEqual(h.calls, [
    ['enhance', { promptTier: 4 }], ['enhance', { chineseTitle: true }],
    ['lang', 'chinese', true, { language: 'zh-CN', brandTitle: 'hidden' }],
    ['ctxApply', { mode: 'dynamic', limitTokens: null }]
  ]);
  assert.equal(h.elements.get('rec-draft-note').hidden, true);
  h.api.dispose();
});

test('effective-state: concurrent old requests and reopening preserve all dirty drafts', async () => {
  const h = setup(); await h.open();
  const api = h.sandbox.window.contextMeterAPI;
  let oldEnhance, oldModules, oldUnlock;
  api.getEnhanceStatus = () => new Promise(resolve => { oldEnhance = resolve; });
  api.getModulesStatus = () => new Promise(resolve => { oldModules = resolve; });
  api.getContextUnlockStatus = () => new Promise(resolve => { oldUnlock = resolve; });
  const old = [h.api.refreshEnhanceStatusForTest(), h.api.refreshModulesStatusForTest(), h.api.refreshUnlockStatusForTest()];
  api.getEnhanceStatus = async () => ({ ok: true, data: h.data.enhance });
  api.getModulesStatus = async () => h.data.modules;
  api.getContextUnlockStatus = async () => ({ ok: true, data: h.data.unlock });
  await Promise.all([h.api.refreshEnhanceStatusForTest(), h.api.refreshModulesStatusForTest(), h.api.refreshUnlockStatusForTest()]);
  for (const key of keys) h.change(key, true);
  oldEnhance({ ok: true, data: fixture().enhance });
  oldModules(fixture().modules); oldUnlock({ ok: true, data: fixture().unlock });
  await Promise.all(old);
  await h.open();
  for (const key of keys) assert.equal(h.box(key).checked, true, key);
  assert.equal(h.elements.get('rec-draft-note').hidden, false);
  assert.deepEqual(h.calls, []);
  h.api.dispose();
});

test('effective-state: partial write failure re-detects observations while preserving failed draft', async () => {
  const h = setup(fixture(), { applyEnhancePatch: async () => ({ ok: false, error: 'write failed' }) });
  await h.open(); h.change('prompt', true); h.preview(); await h.confirm();
  assert.equal(h.state('prompt'), 'off');
  assert.equal(h.box('prompt').checked, true, 'unsaved failed target stays visible');
  assert.equal(h.elements.get('rec-draft-note').hidden, false);
  assert.match(h.elements.get('enhance-global-result-text').textContent, /失败/);
  h.api.dispose();
});

test('effective-state: all restore and panel-language changes re-render without implicit writes', async () => {
  const h = setup(fixture(keys)); await h.open();
  for (const language of ['zh-TW', 'en', 'zh-CN']) {
    h.api.setPanelLanguage(language);
    await flush();
    for (const key of keys) {
      assert.notEqual(h.elements.get(`rec-${key}-state`).textContent, `enhance.effective.on`);
      assert.equal(h.state(key), 'on');
    }
  }
  assert.deepEqual(h.calls, []);
  h.elements.get('btn-enhance-restore-all').click(); await h.confirm();
  for (const key of keys) assert.equal(h.state(key), 'off', key);
  assert.deepEqual(h.calls.map(call => call[0]), ['restoreAllEnhance', 'lang', 'ctxRestore']);
  h.api.dispose();
});

test('effective-state: host DOM still Chinese after disabling is pending; missing runtime stays unknown', async () => {
  const data = fixture();
  data.modules.runtime.chineseActive = true;
  const h = setup(data); await h.open();
  assert.equal(h.state('lang'), 'pendingRestart');
  assert.equal(h.box('lang').indeterminate, true);
  data.modules.runtime = null;
  await h.api.refreshModulesStatusForTest();
  assert.equal(h.state('lang'), 'unknown');
  assert.equal(h.box('lang').checked, false);
  data.unlock = { status: 'patched_loaded', configuredMode: 'dynamic', runtimeEvidence: { restartDetected: false } };
  await h.api.refreshUnlockStatusForTest();
  assert.equal(h.state('ctx'), 'pendingRestart');
  h.api.dispose();
});

test('effective-state: returning draft to observed state invalidates old confirmation', async () => {
  const h = setup(); await h.open();
  h.change('title', true); h.preview();
  h.change('title', false); h.preview(); await h.confirm();
  assert.deepEqual(h.calls, []);
  assert.equal(h.elements.get('enhance-preset-confirm').hidden, true);
  h.api.dispose();
});

test('effective-state: unconfirmed dynamic is unknown; restored disk with live old process is pending', async () => {
  const data = fixture(['ctx']);
  data.unlock = {
    status: 'patched_runtime_unconfirmed',
    configuredMode: 'dynamic',
    runtimeEvidence: { restartDetected: null }
  };
  const h = setup(data); await h.open();
  assert.equal(h.state('ctx'), 'unknown');
  assert.equal(h.box('ctx').checked, false);
  assert.equal(h.box('ctx').indeterminate, true);
  data.unlock = {
    status: 'not_patched',
    configuredMode: 'default',
    runtimeEvidence: { restartDetected: false }
  };
  await h.api.refreshUnlockStatusForTest();
  assert.equal(h.state('ctx'), 'pendingRestart');
  assert.equal(h.box('ctx').checked, false);
  assert.equal(h.box('ctx').indeterminate, true);
  data.unlock = { status: 'failed', configuredMode: 'unknown' };
  await h.api.refreshUnlockStatusForTest();
  assert.equal(h.state('ctx'), 'error');
  data.unlock = { status: 'partial_match', configuredMode: 'partial' };
  await h.api.refreshUnlockStatusForTest();
  assert.equal(h.state('ctx'), 'error');
  h.api.dispose();
});

test('effective-state: changing draft after preview voids confirm; old snapshot cannot write', async () => {
  const h = setup(); await h.open();
  h.change('prompt', true); h.preview();
  assert.equal(h.elements.get('enhance-preset-confirm').hidden, false);
  h.change('prompt', false);
  assert.equal(h.elements.get('enhance-preset-confirm').hidden, true);
  await h.confirm();
  assert.deepEqual(h.calls, []);
  h.change('title', true); h.preview();
  h.change('ctx', true);
  assert.equal(h.elements.get('enhance-preset-confirm').hidden, true);
  await h.confirm();
  assert.deepEqual(h.calls, []);
  h.api.dispose();
});
