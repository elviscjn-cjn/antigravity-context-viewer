'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const core = require('./meter-core');
const collector = require('./meter-collector');
const contextSettingsUi = require('./src/renderer/context-settings-ui');

const source = fs.readFileSync(path.join(__dirname, 'meter-renderer.js'), 'utf8');

function session() {
  return {
    groups: Object.fromEntries(['user', 'assistant', 'thinking', 'tools', 'summaries', 'system', 'definitions'].map(k => [k, core.empty()])),
    total: { chars: 100, low: 10, high: 50 },
    attachmentTotal: core.empty(),
    attachments: [],
    unknownFiles: 0,
    steps: 10,
    userMessages: 2,
    assistantMessages: 3
  };
}

function harness(seedStorage = null) {
  const elements = new Map();
  const docElements = new Map();
  const listeners = new Map();
  const docListeners = new Map();

  const element = () => {
    const attrs = new Map();
    const props = new Map();
    const el = {
      style: {
        display: '',
        opacity: '',
        position: '',
        top: '',
        left: '',
        right: '',
        bottom: '',
        setProperty(k, v) { props.set(k, v); },
        removeProperty(k) { props.delete(k); },
        getPropertyValue(k) { return props.get(k) || ''; }
      },
      children: [],
      hidden: false,
      textContent: '',
      title: '',
      tabIndex: 0,
      get id() { return attrs.get('id') || ''; },
      set id(v) { attrs.set('id', String(v)); if (v) docElements.set(String(v), el); },
      get className() { return attrs.get('class') || ''; },
      set className(v) { attrs.set('class', String(v || '')); },
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
        toggle(c, on) {
          if (on === undefined) on = !this.contains(c);
          if (on) this.add(c); else this.remove(c);
        },
        contains(c) {
          return (attrs.get('class') || '').split(/\s+/).includes(c);
        }
      },
      addEventListener(type, fn) {
        if (!listeners.has(el)) listeners.set(el, new Map());
        listeners.get(el).set(type, fn);
      },
      removeEventListener(type) { listeners.get(el)?.delete(type); },
      setAttribute(k, v) {
        attrs.set(k, String(v));
        if (k === 'id' && v) docElements.set(String(v), el);
      },
      getAttribute(k) { return attrs.get(k) ?? null; },
      removeAttribute(k) {
        if (k === 'id') {
          const id = attrs.get('id');
          if (id && docElements.get(id) === el) docElements.delete(id);
        }
        attrs.delete(k);
      },
      remove() {
        if (this.parentElement && Array.isArray(this.parentElement.children)) {
          const idx = this.parentElement.children.indexOf(this);
          if (idx >= 0) this.parentElement.children.splice(idx, 1);
        }
        const myId = attrs.get('id');
        if (myId && docElements.get(myId) === this) docElements.delete(myId);
      },
      appendChild(x) {
        if (x) {
          x.parentElement = this;
          this.children.push(x);
          const xId = x.id || (typeof x.getAttribute === 'function' ? x.getAttribute('id') : null);
          if (xId) docElements.set(xId, x);
        }
      },
      prepend(x) {
        if (x) {
          x.parentElement = this;
          this.children.unshift(x);
          const xId = x.id || (typeof x.getAttribute === 'function' ? x.getAttribute('id') : null);
          if (xId) docElements.set(xId, x);
        }
      },
      replaceChildren(...nodes) {
        this.children = [];
        if (nodes && nodes.length > 0) {
          for (const n of nodes) this.appendChild(n);
        }
      },
      querySelectorAll() { return []; },
      querySelector(sel) {
        if (sel === '.ag-cm-turn-footer') return this.children.find(c => c.className === 'ag-cm-turn-footer') || null;
        return null;
      },
      closest() { return null; },
      click() { listeners.get(el)?.get('click')?.({ stopPropagation() {} }); },
      dblclick() { listeners.get(el)?.get('dblclick')?.({ stopPropagation() {} }); },
      trigger(type, ev = {}) { listeners.get(el)?.get(type)?.({ stopPropagation() {}, preventDefault() {}, ...ev }); }
    };
    return el;
  };

  const store = new Map(Object.entries(seedStorage || {}));
  const localStorage = {
    getItem: k => store.has(k) ? String(store.get(k)) : null,
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k)
  };

  const root = {
    getElementById(id) {
      if (!elements.has(id)) {
        const el = element();
        el.id = id;
        elements.set(id, el);
      }
      return elements.get(id);
    },
    querySelectorAll() { return []; },
    querySelector() { return null; },
    children: [],
    appendChild(x) { this.children.push(x); }
  };

  const tbMain = {
    row: {
      children: [],
      prepend(n) { n.parentElement = this; this.children.unshift(n); },
      appendChild(n) { n.parentElement = this; this.children.push(n); },
      querySelector(sel) {
        if (sel === '.ag-cm-turn-footer') return this.children.find(c => c.className === 'ag-cm-turn-footer') || null;
        return null;
      },
      clientWidth: 600
    },
    get firstElementChild() { return this.row; },
    getAttribute: () => null,
    clientWidth: 600
  };

  let first = true;
  const host = element();
  host.attachShadow = () => root;

  const dashboardOpened = [];

  const sandbox = {
    location: { protocol: 'https:', hostname: '127.0.0.1', pathname: '/c/test-turn-footer-session', search: '' },
    localStorage,
    window: {
      location: { protocol: 'https:', hostname: '127.0.0.1', pathname: '/c/test-turn-footer-session', search: '' },
      localStorage,
      addEventListener(type, fn) { docListeners.set(type, fn); },
      removeEventListener(type) { docListeners.delete(type); },
      contextMeterAPI: {
        saveSettings: async () => ({ ok: true })
      }
    },
    document: {
      body: element(),
      head: element(),
      documentElement: element(),
      createElement() {
        if (first) { first = false; return host; }
        return element();
      },
      getElementById: id => docElements.get(id) || null,
      querySelectorAll: sel => {
        if (sel && sel.includes('cascade-system-message-toolbar')) return [tbMain];
        if (sel && sel.includes('.ag-cm-turn-footer')) return [tbMain.row.children[0]].filter(Boolean);
        return [];
      },
      querySelector: sel => {
        if (sel && sel.includes('.ag-cm-turn-footer')) return tbMain.row.children[0] || null;
        return null;
      },
      addEventListener: () => {},
      removeEventListener: () => {}
    },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    __AGContextMeterCore: core,
    console
  };

  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);

  return { sandbox, elements, tbMain, dashboardOpened, store };
}

test('回复底部单次请求遥测微标：默认开启、多步汇总自动升格、点击切换与零括号', () => {
  const h = harness();
  try {
    const api = h.sandbox.__AGContextMeter;

    // 1. 验证默认开启与控件初始勾选
    const footerState = api.getTurnFooterStatsForTest();
    assert.equal(footerState.enabled, true, 'showTurnFooterStats 默认必须为开启');
    const chk = h.elements.get('chk-show-turn-footer-stats');
    assert.equal(chk.checked, true, '设置面板控件初始状态必须同步为 checked');

    // 2. 模拟一轮多步工具交互：包含 Step 1 和 Step 2 两次调用
    const multiCalls = [
      {
        callId: 'call-step-1',
        attributedModelLabel: 'Gemini 3.8 Flash',
        inputTokens: 50000,
        cacheCreationInputTokens: 0,
        cacheReadTokens: 40000,
        outputTokens: 500,
        streamingTps: 120,
        date: '2026-11-24 05:00:00'
      },
      {
        callId: 'call-step-2',
        attributedModelLabel: 'Gemini 3.8 Flash',
        inputTokens: 79500,
        cacheCreationInputTokens: 0,
        cacheReadTokens: 75500,
        outputTokens: 1100,
        streamingTps: 124,
        date: '2026-11-24 05:00:05'
      }
    ];

    api.setComposerStateForTest({
      sessionCalls: multiCalls,
      sessionStats: { usedTokens: 155000, limitTokens: 200000, turnCount: 1, stepCount: 2 }
    });

    const badge = h.tbMain.row.children[0];
    assert.ok(badge, '必须在工具栏生成 .ag-cm-turn-footer 徽标');
    assert.equal(badge.getAttribute('data-ag-turn-footer'), '1');
    assert.equal(badge.getAttribute('data-multi-call'), 'true');

    // 3. 多步交互下，默认自动升格为「本轮汇总」
    assert.equal(badge.getAttribute('data-scope'), 'turn', '多步调用默认展示本轮汇总');
    assert.match(badge.textContent, /本轮汇总|Turn/, '徽标文本必须包含本轮汇总');
    // 整轮 In = (50000+40000) + (79500+75500) = 90K + 155K = 245K
    assert.match(badge.textContent, /In 245\.0K/, '本轮汇总必须累计所有子调用的输入');

    // 4. 点击徽标：在「本轮汇总」和「本次请求」之间切换
    badge.click();
    assert.equal(badge.getAttribute('data-scope'), 'request', '点击后必须切换为本次请求');
    assert.match(badge.textContent, /本次请求|Req/, '徽标文本必须切换为本次请求');
    // 单步 In = 79500 + 75500 = 155.0K
    assert.match(badge.textContent, /In 155\.0K/, '本次请求展示最后一次调用的输入');
    assert.match(badge.textContent, /Out 1\.1K/, '本次请求展示最后一次调用的输出');
    assert.match(badge.textContent, /124 tok\/s/, '本次请求展示最后一次调用的生成速度');

    // 5. 再次点击徽标：切回「本轮汇总」
    badge.click();
    assert.equal(badge.getAttribute('data-scope'), 'turn', '再次点击切回本轮汇总');
    assert.match(badge.textContent, /本轮汇总|Turn/);

    // 6. 验证悬停提示文本严格零中英文括号
    const title = badge.title;
    assert.ok(title.length > 0, 'title 必须包含详细信息');
    assert.doesNotMatch(title, /[（）()]/, 'title 提示文本严格零中英文括号');
    assert.match(title, /点击在本次请求与本轮汇总之间切换 · 双击查看详细看板/);

    // 7. 验证键盘无障碍回车触发展示切换
    badge.trigger('keydown', { key: 'Enter' });
    assert.equal(badge.getAttribute('data-scope'), 'request', '键盘 Enter 必须触发展示切换');

    // 8. 验证单步调用时不产生多余的多步标记与切换
    api.setComposerStateForTest({
      sessionCalls: [multiCalls[1]],
      sessionStats: { usedTokens: 155000, limitTokens: 200000, turnCount: 1, stepCount: 1 }
    });
    const singleBadge = h.tbMain.row.children[0];
    assert.equal(singleBadge.getAttribute('data-scope'), 'request', '单步调用必须保持本次请求');
    assert.equal(singleBadge.getAttribute('data-multi-call'), 'false');
    assert.doesNotMatch(singleBadge.title, /[（）()]/, '单步 title 严格零括号');
    assert.match(singleBadge.title, /点击查看详细看板/);
  } finally {
    h.sandbox.__AGContextMeter.dispose();
  }
});

test('Issue #117: collector 持久化校验底栏与尾标字号和高对比度开关', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-issue117-'));
  try {
    const initial = collector.getPluginSettings({ targetDir: tmpDir });
    assert.equal(initial.composerStatusFontSize, 'compact');
    assert.equal(initial.turnFooterHighContrast, false);

    const saved = collector.savePluginSettings({
      composerStatusFontSize: 'comfortable',
      turnFooterHighContrast: true
    }, { targetDir: tmpDir });
    assert.equal(saved.ok, true);

    const reloaded = collector.getPluginSettings({ targetDir: tmpDir });
    assert.equal(reloaded.composerStatusFontSize, 'comfortable');
    assert.equal(reloaded.turnFooterHighContrast, true);

    const updatedLarge = collector.savePluginSettings({
      composerStatusFontSize: 'large'
    }, { targetDir: tmpDir });
    assert.equal(updatedLarge.ok, true);
    assert.equal(collector.getPluginSettings({ targetDir: tmpDir }).composerStatusFontSize, 'large');

    // 非法值和 nested uiPreferences 清洗
    collector.savePluginSettings({
      composerStatusFontSize: 'huge',
      turnFooterHighContrast: 'yes',
      uiPreferences: {
        composerStatusFontSize: 'invalid-size',
        turnFooterHighContrast: 123
      }
    }, { targetDir: tmpDir });
    const afterInvalid = collector.getPluginSettings({ targetDir: tmpDir });
    assert.equal(afterInvalid.composerStatusFontSize, 'large');
    assert.equal(afterInvalid.turnFooterHighContrast, true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Issue #117: 状态栏与回复尾标字号切换、高对比度开关、冷启动恢复及宿主样式契约', () => {
  const savedPayloads = [];
  const h = harness();
  h.sandbox.window.contextMeterAPI.saveSettings = async (payload) => {
    savedPayloads.push(payload);
    return { ok: true };
  };
  try {
    const api = h.sandbox.__AGContextMeter;
    api.setComposerStateForTest({
      sessionCalls: [{
        callId: 'call-117',
        attributedModelLabel: 'Claude Opus 4.6',
        inputTokens: 12000,
        cacheCreationInputTokens: 0,
        cacheReadTokens: 8000,
        outputTokens: 600,
        streamingTps: 88,
        date: '2026-11-26 10:00:00'
      }],
      sessionStats: { usedTokens: 20000, limitTokens: 200000, turnCount: 1, stepCount: 1 }
    });

    const badge = h.tbMain.row.children[0];
    assert.ok(badge, '必须渲染 .ag-cm-turn-footer');

    // 1. 默认状态
    let topo = api.getStatusTypographyForTest();
    assert.equal(topo.fontSize, 'compact');
    assert.equal(topo.highContrast, false);
    assert.equal(topo.barFontSize, 'compact');
    assert.equal(topo.barHighContrast, 'false');
    assert.equal(topo.docFontSize, 'compact');
    assert.equal(topo.docContrast, 'normal');
    assert.equal(badge.getAttribute('data-font-size'), 'compact');
    assert.equal(badge.getAttribute('data-high-contrast'), 'false');

    // 2. 切换舒适与大号字号
    api.setComposerStatusFontSizeForTest('comfortable', { persist: false });
    topo = api.getStatusTypographyForTest();
    assert.equal(topo.fontSize, 'comfortable');
    assert.equal(topo.barFontSize, 'comfortable');
    assert.equal(topo.docFontSize, 'comfortable');
    assert.equal(badge.getAttribute('data-font-size'), 'comfortable');

    const largeBtn = h.elements.get('btn-status-font-large');
    largeBtn.setAttribute('data-status-font-size', 'large');
    largeBtn.click();
    topo = api.getStatusTypographyForTest();
    assert.equal(topo.fontSize, 'large');
    assert.equal(topo.barFontSize, 'large');
    assert.equal(topo.docFontSize, 'large');
    assert.equal(badge.getAttribute('data-font-size'), 'large');
    assert.ok(savedPayloads.some(p => p && p.composerStatusFontSize === 'large'), '点击字号按钮应持久化保存设置');

    // 3. 高对比度开关
    api.setTurnFooterHighContrastForTest(true);
    topo = api.getStatusTypographyForTest();
    assert.equal(topo.highContrast, true);
    assert.equal(topo.barHighContrast, 'true');
    assert.equal(topo.docContrast, 'high');
    assert.equal(badge.getAttribute('data-high-contrast'), 'true');

    // 4. 验证宿主注入样式表包含字号与 opacity: 1 高对比规则
    const styleEl = h.sandbox.document.head.children.find(n => n.id === 'ag-csb-host-styles');
    assert.ok(styleEl && typeof styleEl.textContent === 'string', '必须注入 #ag-csb-host-styles');
    assert.match(styleEl.textContent, /\[data-font-size="comfortable"\]/);
    assert.match(styleEl.textContent, /12\.5px/);
    assert.match(styleEl.textContent, /\[data-font-size="large"\]/);
    assert.match(styleEl.textContent, /14px/);
    assert.match(styleEl.textContent, /\[data-high-contrast="true"\]/);
    assert.match(styleEl.textContent, /opacity:\s*1\s*!important/);

    const cssText = fs.readFileSync(path.join(__dirname, 'src/renderer/styles.css'), 'utf8');
    assert.match(cssText, /\.composer-status-bar\[data-font-size="comfortable"\]/);
    assert.match(cssText, /\.composer-status-bar\[data-font-size="large"\]/);
    assert.match(cssText, /\.composer-status-bar\[data-high-contrast="true"\]/);

    // 5. 验证新增三语文案严格零括号
    const i18nSrc = fs.readFileSync(path.join(__dirname, 'src/renderer/i18n.js'), 'utf8');
    for (const key of [
      'settings.statusFontSize.label',
      'settings.statusFontSize.desc',
      'settings.statusFontSize.compact',
      'settings.statusFontSize.comfortable',
      'settings.statusFontSize.large',
      'settings.turnFooterContrast.label',
      'settings.turnFooterContrast.desc',
      'ns.statusFontSize.desc',
      'ns.turnFooterContrast.desc'
    ]) {
      const m = i18nSrc.match(new RegExp(`'${key.replace(/\./g, '\\.')}':\\s*\\{[^}]+\\}`));
      assert.ok(m, `${key} 三语词条必须存在`);
      assert.doesNotMatch(m[0], /[（）()]/, `${key} 词条禁止包含中英文括号`);
    }
  } finally {
    h.sandbox.__AGContextMeter.dispose();
  }

  // 6. 冷启动恢复 localStorage 偏好
  const cold = harness({
    ag_composer_status_font_size: 'large',
    ag_turn_footer_high_contrast: 'true'
  });
  try {
    const topoCold = cold.sandbox.__AGContextMeter.getStatusTypographyForTest();
    assert.equal(topoCold.fontSize, 'large');
    assert.equal(topoCold.highContrast, true);
    assert.equal(topoCold.docFontSize, 'large');
    assert.equal(topoCold.docContrast, 'high');
  } finally {
    cold.sandbox.__AGContextMeter.dispose();
  }
});

test('Issue #117: 原生设置页 UI 构建与双向同步底栏字号和高对比度控件', () => {
  const html = contextSettingsUi.buildNativeSettingsPageHtml({});
  assert.match(html, /data-ag-ns-seg="composerStatusFontSize"/);
  assert.match(html, /data-val="compact"/);
  assert.match(html, /data-val="comfortable"/);
  assert.match(html, /data-val="large"/);
  assert.match(html, /data-ag-ns-switch="turnFooterHighContrast"/);

  const makeMockNode = () => {
    const attrs = new Map();
    const listeners = new Map();
    const cls = new Set();
    return {
      children: [],
      dataset: {},
      classList: {
        add(c) { cls.add(c); },
        remove(c) { cls.delete(c); },
        toggle(c, on) { if (on) cls.add(c); else cls.delete(c); },
        contains(c) { return cls.has(c); }
      },
      setAttribute(k, v) { attrs.set(k, String(v)); },
      getAttribute(k) { return attrs.get(k) ?? null; },
      removeAttribute(k) { attrs.delete(k); },
      addEventListener(t, fn) { listeners.set(t, fn); },
      querySelectorAll() { return []; },
      querySelector() { return null; },
      click() { listeners.get('click')?.({ target: this, stopPropagation() {} }); }
    };
  };

  const compactBtn = makeMockNode();
  compactBtn.setAttribute('data-val', 'compact');
  const comfortableBtn = makeMockNode();
  comfortableBtn.setAttribute('data-val', 'comfortable');
  const largeBtn = makeMockNode();
  largeBtn.setAttribute('data-val', 'large');

  const segGroup = makeMockNode();
  segGroup.setAttribute('data-ag-ns-seg', 'composerStatusFontSize');
  segGroup.querySelectorAll = (s) => (s === '.ag-ns-seg-btn' ? [compactBtn, comfortableBtn, largeBtn] : []);
  segGroup.contains = (node) => [compactBtn, comfortableBtn, largeBtn].includes(node);
  segGroup.addEventListener = (t, fn) => {
    if (t === 'click') {
      for (const b of [compactBtn, comfortableBtn, largeBtn]) {
        b.closest = () => b;
        b.addEventListener('click', (ev) => fn({ ...ev, target: b }));
      }
    }
  };

  const swBtn = makeMockNode();
  swBtn.setAttribute('data-ag-ns-switch', 'turnFooterHighContrast');
  const swStatus = makeMockNode();
  swStatus.setAttribute('data-ag-ns-sw-status', 'turnFooterHighContrast');

  const container = makeMockNode();
  container.querySelectorAll = (sel) => {
    if (sel === '[data-ag-ns-seg]') return [segGroup];
    if (sel === '[data-ag-ns-switch]') return [swBtn];
    return [];
  };
  container.querySelector = (sel) => {
    if (sel === '[data-ag-ns-sw-status="turnFooterHighContrast"]') return swStatus;
    return null;
  };
  const root = {
    getElementById: (id) => (id === 'ag-ns-root' ? container : null)
  };

  const changes = [];
  contextSettingsUi.initContextSettingsUI(root, {
    onChange: (key, val) => changes.push([key, val])
  });
  contextSettingsUi.renderContextSettingsUI(root, {
    settings: { composerStatusFontSize: 'large', turnFooterHighContrast: true },
    colors: {},
    status: { switchFeedback: { turnFooterHighContrast: { busy: false, tone: 'idle', text: '已开启' } } }
  });

  assert.equal(largeBtn.classList.contains('is-active'), true);
  assert.equal(largeBtn.getAttribute('aria-checked'), 'true');
  assert.equal(compactBtn.classList.contains('is-active'), false);
  assert.equal(swBtn.classList.contains('is-on'), true);
  assert.equal(swBtn.getAttribute('aria-checked'), 'true');
  assert.equal(swStatus.textContent, '已开启');

  comfortableBtn.click();
  swBtn.click();
  assert.deepStrictEqual(changes, [
    ['composerStatusFontSize', 'comfortable'],
    ['turnFooterHighContrast', false]
  ]);
});

test('Issue #140: 时间线滞后(M=2, T=1)绝不将 turn-1 错绑到第二条回复，补齐时间线后精确恢复 turn-2 与跨模型统计', () => {
  const h = harness();
  try {
    const makeTb = () => {
      const row = h.sandbox.document.createElement('div');
      row.clientWidth = 520;
      const tb = h.sandbox.document.createElement('div');
      tb.clientWidth = 520;
      tb.appendChild(row);
      tb.firstElementChild = row;
      tb.row = row;
      return tb;
    };
    const tb1 = makeTb();
    const tb2 = makeTb();
    const origQsa = h.sandbox.document.querySelectorAll;
    h.sandbox.document.querySelectorAll = (sel) => {
      if (sel && sel.includes('cascade-system-message-toolbar')) return [tb1, tb2];
      if (sel && sel.includes('.ag-cm-turn-footer')) {
        return [
          tb1.row.children.find(c => c.className === 'ag-cm-turn-footer'),
          tb2.row.children.find(c => c.className === 'ag-cm-turn-footer')
        ].filter(Boolean);
      }
      return origQsa ? origQsa(sel) : [];
    };

    const api = h.sandbox.__AGContextMeter;
    api.setTurnFooterStatsEnabledForTest(true);

    const call1 = { callId: 'c-1', stepIndex: 2, modelLabel: 'Model A', inputTokens: 1000, cacheReadTokens: 0, outputTokens: 100, streamingTps: 80 };
    const call2 = { callId: 'c-2', stepIndex: 5, modelLabel: 'Model B', inputTokens: 1500, cacheReadTokens: 500, outputTokens: 150, streamingTps: 120 };

    // 阶段 1：DOM 已有 2 条回复，但时间线仅落盘 turn-1（滞后）
    api.setComposerStateForTest({
      sessionCalls: [call1, call2],
      sessionTimeline: {
        turns: [{ turnIndex: 1, stepIndex: 1, calls: [call1] }]
      }
    });
    const f1Lag = tb1.row.children.find(c => c.className === 'ag-cm-turn-footer');
    const f2Lag = tb2.row.children.find(c => c.className === 'ag-cm-turn-footer');
    assert.ok(f1Lag, '第一条回复应绑定 turn-1');
    assert.equal(f1Lag.getAttribute('data-turn-key'), 'turn-1');
    assert.match(f1Lag.textContent, /Model A/);
    assert.match(f1Lag.textContent, /Out 100/);
    assert.equal(f2Lag, undefined, '时间线滞后时第二条回复必须隐藏尾标，绝不能错绑 turn-1');

    // 阶段 2：时间线补齐 turn-2 后，两条回复各自精确绑定且跨模型独立
    api.setComposerStateForTest({
      sessionCalls: [call1, call2],
      sessionTimeline: {
        turns: [
          { turnIndex: 1, stepIndex: 1, calls: [call1] },
          { turnIndex: 2, stepIndex: 4, calls: [call2] }
        ]
      }
    });
    const f1Full = tb1.row.children.find(c => c.className === 'ag-cm-turn-footer');
    const f2Full = tb2.row.children.find(c => c.className === 'ag-cm-turn-footer');
    assert.ok(f1Full && f2Full);
    assert.equal(f1Full.getAttribute('data-turn-key'), 'turn-1');
    assert.match(f1Full.textContent, /Model A/);
    assert.equal(f2Full.getAttribute('data-turn-key'), 'turn-2');
    assert.match(f2Full.textContent, /Model B/);
    assert.match(f2Full.textContent, /Out 150/);
  } finally {
    h.sandbox.__AGContextMeter.dispose();
  }
});

test('Issue #140: 可核验标识防串轮——双回复可见、滚动只剩新回复、新请求统计未到达、错误轮次跳过与多模型汇总', () => {
  const h = harness();
  try {
    const makeTb = (attrs = {}, fiber = null) => {
      const row = h.sandbox.document.createElement('div');
      row.clientWidth = 560;
      const tb = h.sandbox.document.createElement('div');
      tb.clientWidth = 560;
      for (const [k, v] of Object.entries(attrs)) {
        tb.setAttribute(k, String(v));
      }
      if (fiber) {
        tb.__reactFiber$test = fiber;
      }
      tb.appendChild(row);
      tb.firstElementChild = row;
      tb.row = row;
      return tb;
    };

    let activeToolbars = [];
    const origQsa = h.sandbox.document.querySelectorAll;
    h.sandbox.document.querySelectorAll = (sel) => {
      if (sel && sel.includes('cascade-system-message-toolbar')) return activeToolbars;
      if (sel && sel.includes('.ag-cm-turn-footer')) {
        return activeToolbars
          .map(tb => tb.row.children.find(c => c.className === 'ag-cm-turn-footer'))
          .filter(Boolean);
      }
      return origQsa ? origQsa(sel) : [];
    };

    const api = h.sandbox.__AGContextMeter;
    api.setTurnFooterStatsEnabledForTest(true);
    const routeId = '5746859c-1394-4d83-a9ba-b86f9d0b6c62';

    const call1 = { callId: 'c-1', stepIndex: 1, modelLabel: 'Gemini 3.8 Flash', inputTokens: 1000, cacheReadTokens: 0, outputTokens: 100, streamingTps: 80, status: 'final' };
    const call2Pending = { callId: 'c-2', stepIndex: 4, modelLabel: 'Claude Sonnet 4.6', inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, status: 'streaming' };
    const call2Ready = { callId: 'c-2', stepIndex: 4, modelLabel: 'Claude Sonnet 4.6', inputTokens: 1500, cacheReadTokens: 500, outputTokens: 150, streamingTps: 120, status: 'final' };

    // 场景 1：两条回复都可见，第二条归属未确认时显示「统计同步中」，不显示第一条的模型或 Token
    const tb1 = makeTb({ 'data-cascade-id': routeId, 'data-step-indices': '0,1' });
    const tb2 = makeTb({ 'data-cascade-id': routeId, 'data-step-indices': '2,3,4', 'data-turn-latest': 'true' });
    activeToolbars = [tb1, tb2];

    api.setComposerStateForTest({
      route: routeId,
      sessionCalls: [call1],
      sessionTimeline: {
        cascadeId: routeId,
        turns: [{ turnIndex: 1, stepIndex: 0, calls: [call1] }]
      }
    });
    const f1A = tb1.row.children.find(c => c.className === 'ag-cm-turn-footer');
    const f2A = tb2.row.children.find(c => c.className === 'ag-cm-turn-footer');
    assert.ok(f1A && f2A);
    assert.equal(f1A.getAttribute('data-turn-key'), 'turn-1');
    assert.match(f1A.textContent, /Gemini 3\.8 Flash/);
    assert.equal(f2A.textContent, '统计同步中');
    assert.equal(f2A.getAttribute('data-sync-state'), 'syncing');
    assert.equal(f2A.getAttribute('data-turn-key'), null);
    assert.doesNotMatch(f2A.textContent, /Gemini|1\.0K|100/);

    // 场景 2：新请求统计尚未到达（call2 为 streaming 且 0 token）时，tb1 保持显示，tb2 仍为「统计同步中」
    api.setComposerStateForTest({
      route: routeId,
      sessionCalls: [call1, call2Pending],
      sessionTimeline: {
        cascadeId: routeId,
        turns: [
          { turnIndex: 1, stepIndex: 0, calls: [call1] },
          { turnIndex: 2, stepIndex: 2, calls: [call2Pending] }
        ]
      }
    });
    assert.match(tb1.row.children.find(c => c.className === 'ag-cm-turn-footer').textContent, /Gemini 3\.8 Flash/);
    assert.equal(tb2.row.children.find(c => c.className === 'ag-cm-turn-footer').textContent, '统计同步中');

    // 场景 3：滚动后只剩新回复可见（M=1, T=1 且仅有 turn-1），绝不能把 turn-1 错绑给 tb2
    activeToolbars = [tb2];
    api.setComposerStateForTest({
      route: routeId,
      sessionCalls: [call1],
      sessionTimeline: {
        cascadeId: routeId,
        turns: [{ turnIndex: 1, stepIndex: 0, calls: [call1] }]
      }
    });
    const f2ScrolledLag = tb2.row.children.find(c => c.className === 'ag-cm-turn-footer');
    assert.equal(f2ScrolledLag.textContent, '统计同步中');
    assert.equal(f2ScrolledLag.getAttribute('data-turn-key'), null);

    // 统计到齐后，只更新对应回复 tb2，且回到双回复视图时两条各自对账正确
    api.setComposerStateForTest({
      route: routeId,
      sessionCalls: [call1, call2Ready],
      sessionTimeline: {
        cascadeId: routeId,
        turns: [
          { turnIndex: 1, stepIndex: 0, calls: [call1] },
          { turnIndex: 2, stepIndex: 2, calls: [call2Ready] }
        ]
      }
    });
    assert.match(tb2.row.children.find(c => c.className === 'ag-cm-turn-footer').textContent, /Claude Sonnet 4\.6.*Out 150/);

    activeToolbars = [tb1, tb2];
    api.setComposerStateForTest({
      route: routeId,
      sessionCalls: [call1, call2Ready],
      sessionTimeline: {
        cascadeId: routeId,
        turns: [
          { turnIndex: 1, stepIndex: 0, calls: [call1] },
          { turnIndex: 2, stepIndex: 2, calls: [call2Ready] }
        ]
      }
    });
    assert.match(tb1.row.children.find(c => c.className === 'ag-cm-turn-footer').textContent, /Gemini 3\.8 Flash.*Out 100/);
    assert.match(tb2.row.children.find(c => c.className === 'ag-cm-turn-footer').textContent, /Claude Sonnet 4\.6.*Out 150/);

    // 场景 4：React Fiber trajectorySteps 真实结构 + 中间夹杂错误轮次(type=17) + 同轮多模型汇总标明「多模型」
    const traj = [
      { type: 14, status: 3 },
      { type: 15, status: 3 },
      { type: 14, status: 3 },
      { type: 17, status: 3 },
      { type: 14, status: 3 },
      { type: 101, status: 3 },
      { type: 15, status: 3 }
    ];
    const makeFiber = (key, isLatest, steps) => ({
      memoizedProps: {
        cascadeId: routeId,
        trajectorySteps: traj,
        container: { key: String(key), isLatest, steps }
      }
    });
    const fTb1 = makeTb({}, makeFiber(0, false, [traj[0], traj[1]]));
    const fTbErr = makeTb({}, makeFiber(1, false, [traj[2], traj[3]]));
    const fTb2 = makeTb({}, makeFiber(2, true, [traj[4], traj[5], traj[6]]));
    activeToolbars = [fTb1, fTbErr, fTb2];

    const multiCallA = { callId: 'mc-1', stepIndex: 5, modelLabel: 'Gemini 3.8 Flash', inputTokens: 800, cacheReadTokens: 200, outputTokens: 40, streamingTps: 60, status: 'final' };
    const multiCallB = { callId: 'mc-2', stepIndex: 6, modelLabel: 'Claude Sonnet 4.6', inputTokens: 1200, cacheReadTokens: 800, outputTokens: 60, streamingTps: 90, status: 'final' };
    api.setComposerStateForTest({
      route: routeId,
      sessionCalls: [call1, multiCallA, multiCallB],
      sessionTimeline: {
        cascadeId: routeId,
        turns: [
          { turnIndex: 1, stepIndex: 0, calls: [call1] },
          { turnIndex: 2, stepIndex: 4, calls: [multiCallA, multiCallB] }
        ]
      }
    });

    const fb1 = fTb1.row.children.find(c => c.className === 'ag-cm-turn-footer');
    const fbErr = fTbErr.row.children.find(c => c.className === 'ag-cm-turn-footer');
    const fb2 = fTb2.row.children.find(c => c.className === 'ag-cm-turn-footer');
    assert.ok(fb1, '正常旧轮次应绑定');
    assert.equal(fb1.getAttribute('data-turn-key'), 'turn-1');
    assert.equal(fbErr, undefined, '错误轮次(type=17)不得挂载任何尾标，且不得顶替后续轮次');
    assert.ok(fb2, '跳过错误轮次后，后续多模型轮次应精确绑定');
    assert.equal(fb2.getAttribute('data-turn-key'), 'turn-2');
    assert.equal(fb2.getAttribute('data-multi-model'), 'true');
    assert.match(fb2.textContent, /本轮汇总 · 多模型/);
    assert.match(fb2.title, /Gemini 3\.8 Flash/);
    assert.match(fb2.title, /Claude Sonnet 4\.6/);
  } finally {
    h.sandbox.__AGContextMeter.dispose();
  }
});
