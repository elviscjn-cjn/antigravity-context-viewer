'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const collector = require('./meter-collector');
const core = require('./meter-core');

const source = fs.readFileSync(path.join(__dirname, 'meter-renderer.js'), 'utf8');
const TPL_SOURCE = fs.readFileSync(path.join(__dirname, 'src', 'renderer', 'template.html'), 'utf8');
const I18N_SOURCE = fs.readFileSync(path.join(__dirname, 'src', 'renderer', 'i18n.js'), 'utf8');
const STYLES_SOURCE = fs.readFileSync(path.join(__dirname, 'src', 'renderer', 'styles.css'), 'utf8');

function session(unknown = 0) {
  return {
    groups: Object.fromEntries(['user', 'assistant', 'thinking', 'tools', 'summaries', 'system', 'definitions'].map(k => [k, core.empty()])),
    total: { chars: 100, low: 10, high: 50 },
    attachmentTotal: core.empty(),
    attachments: unknown ? [{ name: 'img.png', status: 'unknown', unknownParts: ['图像 token 未知'], chars: 0, source: 'user' }] : [],
    unknownFiles: unknown,
    steps: 10,
    userMessages: 2,
    assistantMessages: 3
  };
}

function harness(scanSession = session(), extraSandbox = null) {
  const elements = new Map();
  const docElements = new Map();
  const listeners = new Map();
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
        contains(c) {
          return (attrs.get('class') || '').split(/\s+/).includes(c);
        }
      },
      addEventListener(type, fn) {
        if (!listeners.has(el)) listeners.set(el, new Map());
        listeners.get(el).set(type, fn);
      },
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
      querySelectorAll(sel) {
        const found = [];
        const check = node => {
          if (!node) return;
          if (sel === '#ag-wco-spacer' && (node.id === 'ag-wco-spacer' || node.getAttribute?.('id') === 'ag-wco-spacer')) {
            found.push(node);
          }
          if (Array.isArray(node.children)) {
            for (const child of node.children) check(child);
          }
        };
        for (const child of this.children) check(child);
        return found;
      },
      replaceChildren() { this.children = []; },
      click() { listeners.get(el)?.get('click')?.(); },
      getBoundingClientRect() { return { left: 100, top: 100, width: 80, height: 28, right: 180, bottom: 128 }; },
      trigger(type, ev = {}) { listeners.get(el)?.get(type)?.(ev); }
    };
    return el;
  };

  const host = element();
  host.attachShadow = () => ({
    set innerHTML(value) { },
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, element());
      return elements.get(id);
    },
    querySelectorAll() { return []; },
    addEventListener(type, fn) {
      if (!listeners.has(host)) listeners.set(host, new Map());
      listeners.get(host).set(type, fn);
    },
    removeEventListener() { }
  });

  const pending = [], scans = [], timers = [];
  const docListeners = new Map();
  const storageMap = new Map();
  const lStore = {
    getItem(k) { return storageMap.has(k) ? storageMap.get(k) : null; },
    setItem(k, v) { storageMap.set(k, String(v)); },
    removeItem(k) { storageMap.delete(k); },
    clear() { storageMap.clear(); },
    get(k) { return storageMap.get(k); }
  };

  const auxContainer = element();
  auxContainer.setAttribute('data-side-panel-focus-scope', 'true');
  auxContainer.getBoundingClientRect = () => ({ top: 40, left: 1000, width: 320, height: 760, right: 1320, bottom: 800 });

  const editorContainer = element();
  editorContainer.id = 'workbench.parts.editor';
  editorContainer.getBoundingClientRect = () => ({ top: 40, left: 200, width: 800, height: 760, right: 1000, bottom: 800 });

  const sandbox = {
    location: { protocol: 'https:', hostname: '127.0.0.1', pathname: '/c/11111111-1111-1111-1111-111111111111' },
    document: {
      createElement: () => element(),
      getElementById: id => {
        if (id === 'workbench.parts.editor') return editorContainer;
        return docElements.get(id) || null;
      },
      documentElement: { appendChild() { } },
      addEventListener(type, fn) {
        if (!docListeners.has(type)) docListeners.set(type, new Set());
        docListeners.get(type).add(fn);
      },
      removeEventListener(type, fn) {
        docListeners.get(type)?.delete(fn);
      },
      dispatchEvent(ev) {
        const type = ev?.type || ev;
        for (const fn of (docListeners.get(type) || [])) fn(ev);
      },
      querySelectorAll(sel) {
        if (sel.includes('data-side-panel-open') || sel.includes('data-aux-pane-open')) {
          return [auxContainer];
        }
        return [];
      },
      querySelector(sel) {
        if (sel.includes('data-side-panel-open') || sel.includes('data-aux-pane-open')) {
          return auxContainer;
        }
        if (sel.includes('workbench.parts.editor')) {
          return editorContainer;
        }
        return null;
      },
      hidden: false
    },
    window: {
      innerWidth: 1200,
      innerHeight: 800,
      __APP_CONFIG__: { csrfToken: 'test' },
      contextMeterAPI: { scan: id => new Promise(resolve => scans.push({ id, resolve })) }
    },
    localStorage: lStore,
    __AGContextMeterCore: core,
    AbortController,
    Date,
    setTimeout: () => 1,
    clearTimeout() { },
    setInterval(callback) { timers.push(callback); return 1; },
    clearInterval() { },
    fetch(url, options) { return new Promise(resolve => pending.push({ url, options, resolve })); },
    ...(extraSandbox && typeof extraSandbox === 'object' ? extraSandbox : {})
  };

  let first = true;
  sandbox.document.createElement = () => {
    if (first) {
      first = false;
      return host;
    }
    return element();
  };

  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);

  return {
    sandbox,
    host,
    elements,
    docElements,
    lStore,
    tick: () => timers[0]?.(),
    flush: () => new Promise(resolve => setImmediate(resolve)),
    finishScan(i = 0) {
      scans[i]?.resolve({ ok: true, data: { session: scanSession, scannedAt: Date.now(), latest: null } });
    }
  };
}

test('解耦设置项 A & B: topbarMode 与 panelDockMode 独立切换、正交组合与宿主属性同步', async () => {
  const h = harness();
  const api = h.sandbox.__AGContextMeter;
  const activeHost = h.host;
  try {
    h.finishScan();
    await h.flush();

    // 初始状态默认为 full + popover
    assert.equal(api.getTopbarMode(), 'full');
    assert.equal(api.getPanelDockMode(), 'popover');
    assert.equal(activeHost.getAttribute('data-topbar-mode'), 'full');
    assert.equal(activeHost.getAttribute('data-panel-dock-mode'), 'popover');

    // 1. 切换 topbarMode 为 compact，panelDockMode 保持 popover
    api.setTopbarMode('compact', { persist: false });
    assert.equal(api.getTopbarMode(), 'compact');
    assert.equal(api.getPanelDockMode(), 'popover');
    assert.equal(activeHost.getAttribute('data-topbar-mode'), 'compact');
    assert.equal(activeHost.getAttribute('data-dock'), 'compact');

    // 2. 正交组合: compact + aux（顶栏保持 compact 圆环，面板显示在右侧辅助栏）
    api.setPanelDockMode('aux', { persist: false });
    assert.equal(api.getTopbarMode(), 'compact', '切至 aux 时严禁强行将 topbarMode 恢复为 full');
    assert.equal(api.getPanelDockMode(), 'aux');
    assert.equal(activeHost.getAttribute('data-topbar-mode'), 'compact');
    assert.equal(activeHost.getAttribute('data-panel-dock-mode'), 'aux');
    assert.equal(activeHost.getAttribute('data-dock'), 'aux');

    // 3. 正交组合: hidden + aux（顶栏隐藏，面板显示在右侧辅助栏）
    api.setTopbarMode('hidden', { persist: false });
    assert.equal(api.getTopbarMode(), 'hidden');
    assert.equal(api.getPanelDockMode(), 'aux');
    assert.equal(activeHost.getAttribute('data-topbar-hidden'), 'true');
    assert.equal(activeHost.getAttribute('data-panel-dock-mode'), 'aux');

    // 4. 正交组合: full + page（顶栏标准完整，面板独立页面）
    api.setTopbarMode('full', { persist: false });
    api.setPanelDockMode('page', { persist: false });
    assert.equal(api.getTopbarMode(), 'full');
    assert.equal(api.getPanelDockMode(), 'page');
    assert.equal(activeHost.getAttribute('data-topbar-mode'), 'full');
    assert.equal(activeHost.getAttribute('data-panel-dock-mode'), 'page');
    assert.equal(activeHost.getAttribute('data-dock'), 'page');
  } finally {
    api.dispose();
  }
});

test('autoHideTopbarOnDockedPanel 联动: 辅助栏/独立页展开时自动隐藏顶栏，关闭或切回时恢复', async () => {
  const h = harness();
  const api = h.sandbox.__AGContextMeter;
  const activeHost = h.host;
  try {
    h.finishScan();
    await h.flush();

    api.setTopbarMode('full', { persist: false });
    api.setPanelDockMode('aux', { persist: false });
    api.setAutoHideTopbarOnDockedPanel(true, { persist: false });

    // 面板未打开时，顶栏入口正常显示
    assert.equal(activeHost.getAttribute('data-dock-collapsed-topbar'), null);

    // 打开面板（停靠在 aux），顶栏入口自动收起零冗余
    api.toggle(true, 'context');
    assert.equal(activeHost.getAttribute('data-dock-collapsed-topbar'), 'true', 'aux 面板展开时必须带有 data-dock-collapsed-topbar');

    // 关闭面板，顶栏入口自动恢复
    api.toggle(false);
    assert.equal(activeHost.getAttribute('data-dock-collapsed-topbar'), null, '关闭面板后必须清除 data-dock-collapsed-topbar 恢复顶栏');

    // 关闭 autoHide 开关，展开 aux 时不隐藏顶栏
    api.setAutoHideTopbarOnDockedPanel(false, { persist: false });
    api.toggle(true, 'context');
    assert.equal(activeHost.getAttribute('data-dock-collapsed-topbar'), null, '关闭自动隐藏时展开 aux 依然保留顶栏入口');
  } finally {
    api.dispose();
  }
});

test('旧 5 态配置向下兼容与无损持久化', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-dock-test-'));
  try {
    // 写入旧版 compact 配置
    collector.savePluginSettings({ dockPosition: 'compact' }, { targetDir: tmpDir });
    const s1 = collector.getPluginSettings({ targetDir: tmpDir });
    assert.equal(s1.topbarMode, 'compact');
    assert.equal(s1.panelDockMode, 'popover');
    assert.equal(s1.autoHideTopbarOnDockedPanel, false);

    // 写入旧版 aux 配置
    collector.savePluginSettings({ dockPosition: 'aux' }, { targetDir: tmpDir });
    const s2 = collector.getPluginSettings({ targetDir: tmpDir });
    assert.equal(s2.panelDockMode, 'aux');

    // 写入旧版 hide 配置
    collector.savePluginSettings({ hideTopbar: true }, { targetDir: tmpDir });
    const s3 = collector.getPluginSettings({ targetDir: tmpDir });
    assert.equal(s3.topbarMode, 'hidden');

    // page 模式持久化契约: 内存中为 page，持久化回退至 flow 防止冷启动锁死
    const h = harness();
    const api = h.sandbox.__AGContextMeter;
    try {
      api.setPanelDockMode('page', { persist: true });
      assert.equal(h.lStore.get('ag_panel_dock_mode'), 'page');
      assert.equal(h.lStore.get('ag_dock_position'), 'flow', 'page 模式下 ag_dock_position 必须持久化为 flow 防止冷启动锁死');
    } finally {
      api.dispose();
    }
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { }
  }
});

test('底栏交互: 四组按钮分别直达对应看板，二次点击关闭，原生 title 清空转存 data-tooltip', async () => {
  const h = harness();
  const api = h.sandbox.__AGContextMeter;
  try {
    h.finishScan();
    await h.flush();

    api.setComposerStateForTest({
      sessionCalls: [{ callId: 'c1', stepIndex: 1, inputTokens: 100, outputTokens: 20, status: 'final' }],
      sessionStats: { usedTokens: 50000, limitTokens: 512000, turnCount: 1, stepCount: 1 }
    });

    const csbTokens = h.elements.get('csb-group-tokens');
    const csbSpeed = h.elements.get('csb-group-speed');
    const csbQuota = h.elements.get('csb-group-quota');
    const csbStatus = h.elements.get('csb-group-status');
    const pTokens = h.elements.get('panel-tokens');
    // 1. 点击 tokens 胶囊直达实时请求
    csbTokens.click();
    assert.equal(pTokens.hidden, false);
    const reqBtn = h.elements.get('tok-view-requests');
    const reqView = h.elements.get('requests-live-view');
    assert.ok(reqView);
    assert.equal(reqView.style.display, 'flex');
    assert.equal(reqBtn.classList.contains('active'), true);

    // 关闭面板
    api.toggle(false);
    assert.equal(pTokens.hidden, true);

    // 2. 补充任务 A: 点击 speed / quota 分别直达对应面板，二次点击关闭
    csbSpeed.click();
    assert.equal(h.elements.get('panel').hidden, false, '点击速度项直达速度对比');
    assert.equal(h.elements.get('tab-ctx-speed').classList.contains('active'), true);
    csbSpeed.click();
    assert.equal(h.elements.get('panel').hidden, true, '二次点击关闭速度对比');

    csbQuota.click();
    assert.equal(h.elements.get('panel-quota').hidden, false, '点击额度项直达模型额度');
    csbQuota.click();
    assert.equal(h.elements.get('panel-quota').hidden, true, '二次点击关闭模型额度');

    if (csbStatus) {
      csbStatus.click();
      assert.equal(h.elements.get('token-five-line-card').hidden, true);
    }

    // 3. 原生 title 清空以消除黑框双气泡，提示内容存入 data-tooltip
    assert.equal(String(csbTokens.title || ''), '');
    assert.equal(String(csbSpeed.title || ''), '');
    assert.ok(csbTokens.getAttribute('data-tooltip'));
    assert.ok(csbSpeed.getAttribute('data-tooltip'));
  } finally {
    api.dispose();
  }
});

test('底栏缩略卡居中锚定与空会话提示', async () => {
  const h = harness();
  const api = h.sandbox.__AGContextMeter;
  try {
    h.finishScan();
    await h.flush();

    const csbTokens = h.elements.get('csb-group-tokens');
    const card = h.elements.get('csb-card-tokens');
    const legacyCard = h.elements.get('token-five-line-card');

    // 校验 styles.css 包含 fixed 定位
    assert.match(STYLES_SOURCE, /\.ag-mini-float-card\s*\{[^}]*position:\s*fixed/);

    // 预设有效统计数据，悬停弹出
    api.setComposerStateForTest({
      sessionStats: { usedTokens: 50000, inputTokens: 40000, outputTokens: 10000, cachedTokens: 30000 },
      hasActiveTurn: false
    });
    csbTokens.trigger('mouseenter');
    assert.equal(card.hidden, false);
    assert.equal(legacyCard.hidden, true);
    assert.ok(card.style.left);
    assert.ok(card.style.bottom);

    csbTokens.trigger('mouseleave');
    assert.equal(card.hidden, true);

    // 补充任务 A: 空指标会话状态下悬停依然弹出悬停卡展示概览信息，不静默
    api.setComposerStateForTest({
      sessionStats: { usedTokens: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
      hasActiveTurn: false
    });
    csbTokens.trigger('mouseenter');
    assert.equal(card.hidden, false, '补充任务 A: 空会话依然展示悬停卡与概览信息');
  } finally {
    api.dispose();
  }
});

test('界面可见文案零括号红线检测', async () => {
  const bracketRegex = /[（）\(\)]/;

  // 1. template.html 中的分段器与复选框文案
  const topbarModeSeg = TPL_SOURCE.match(/<div id="topbar-mode-segmented"[^>]*>([\s\S]*?)<\/div>/)?.[1] || '';
  const panelDockModeSeg = TPL_SOURCE.match(/<div id="panel-dock-mode-segmented"[^>]*>([\s\S]*?)<\/div>/)?.[1] || '';
  const autoHideChk = TPL_SOURCE.match(/<label id="lbl-autohide-topbar-docked"[^>]*>([\s\S]*?)<\/label>/)?.[1] || '';

  assert.doesNotMatch(topbarModeSeg, bracketRegex, 'topbar-mode-segmented 内文案严禁使用中英文括号');
  assert.doesNotMatch(panelDockModeSeg, bracketRegex, 'panel-dock-mode-segmented 内文案严禁使用中英文括号');
  assert.doesNotMatch(autoHideChk, bracketRegex, 'lbl-autohide-topbar-docked 文案严禁使用中英文括号');

  // 2. i18n.js 中新增的键值
  const i18nMatches = I18N_SOURCE.match(/(settings\.topbarMode|settings\.panelDockMode|settings\.autoHideTopbarDocked|composer\.card\.clickHint)[\s\S]*?['"`]([^'"`]+)['"`]/g) || [];
  for (const m of i18nMatches) {
    assert.doesNotMatch(m, bracketRegex, `i18n 词条严禁含有中英文括号: ${m}`);
  }
});
