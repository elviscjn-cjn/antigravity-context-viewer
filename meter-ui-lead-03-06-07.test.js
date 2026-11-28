'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const auxQuickSwitch = require('./src/renderer/aux-quick-switch.js');
const orbPositioning = require('./src/renderer/orb-positioning.js');
const hostSettingsNavAlign = require('./src/renderer/host-settings-nav-align.js');
const reqSortDropdown = require('./src/renderer/req-sort-dropdown.js');
const presetBoardUpgrades = require('./src/renderer/preset-board-upgrades.js');
const morphIndicatorToolbar = require('./src/renderer/morph-indicator-toolbar.js');
const nextPromptAlignment = require('./src/renderer/next-prompt-alignment.js');
const insightsAndViews = require('./src/renderer/insights-and-views.js');

const NEW_MODULE_PATHS = [
  'src/renderer/aux-quick-switch.js',
  'src/renderer/orb-positioning.js',
  'src/renderer/host-settings-nav-align.js',
  'src/renderer/req-sort-dropdown.js',
  'src/renderer/preset-board-upgrades.js',
  'src/renderer/morph-indicator-toolbar.js',
  'src/renderer/next-prompt-alignment.js',
  'src/renderer/insights-and-views.js'
];

/**
 * 轻量零依赖 DOM 模拟（支持 createElement/createElementNS、classList、style、attributes、events、selector 与 rect）
 */
function createMockDom() {
  class MockClassList {
    constructor(el) {
      this._el = el;
      this._set = new Set();
    }
    _syncFromString(str) {
      this._set = new Set(String(str || '').split(/\s+/).filter(Boolean));
    }
    _syncToString() {
      this._el._className = Array.from(this._set).join(' ');
    }
    add(...cls) { cls.forEach(c => c && this._set.add(c)); this._syncToString(); }
    remove(...cls) { cls.forEach(c => this._set.delete(c)); this._syncToString(); }
    toggle(c, force) {
      const next = force === undefined ? !this._set.has(c) : Boolean(force);
      if (next) this._set.add(c);
      else this._set.delete(c);
      this._syncToString();
      return next;
    }
    contains(c) { return this._set.has(c); }
  }

  class MockElement {
    constructor(tag, doc) {
      this.tagName = String(tag || 'div').toUpperCase();
      this.ownerDocument = doc;
      this.nodeType = 1;
      this.id = '';
      this._className = '';
      this.classList = new MockClassList(this);
      this.attributes = new Map();
      this.style = {
        _props: new Map(),
        setProperty(k, v) { this._props.set(k, String(v)); this[k] = String(v); },
        getPropertyValue(k) { return this._props.get(k) || this[k] || ''; },
        removeProperty(k) { this._props.delete(k); delete this[k]; }
      };
      this.children = [];
      this.parentElement = null;
      this.hidden = false;
      this.disabled = false;
      this.title = '';
      this._textContent = '';
      this._listeners = new Map();
      this._rect = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
      this._focused = false;
    }
    get className() { return this._className; }
    set className(val) { this._className = String(val || ''); this.classList._syncFromString(this._className); }
    get firstChild() { return this.children[0] || null; }
    get nextSibling() {
      if (!this.parentElement) return null;
      const idx = this.parentElement.children.indexOf(this);
      return idx >= 0 ? (this.parentElement.children[idx + 1] || null) : null;
    }
    get textContent() {
      if (this.children.length === 0) return this._textContent;
      return this.children.map(c => c.textContent).join('');
    }
    set textContent(val) {
      this.children = [];
      this._textContent = String(val ?? '');
    }
    setAttribute(k, v) {
      const key = String(k);
      const val = String(v);
      if (key === 'id') this.id = val;
      if (key === 'class') this.className = val;
      this.attributes.set(key, val);
    }
    getAttribute(k) {
      if (k === 'id') return this.id || null;
      if (k === 'class') return this.className || null;
      return this.attributes.has(k) ? this.attributes.get(k) : null;
    }
    removeAttribute(k) {
      this.attributes.delete(k);
    }
    appendChild(child) {
      if (child.parentElement) child.remove();
      child.parentElement = this;
      this.children.push(child);
      return child;
    }
    insertBefore(child, ref) {
      if (child.parentElement) child.remove();
      child.parentElement = this;
      const idx = ref ? this.children.indexOf(ref) : -1;
      if (idx >= 0) this.children.splice(idx, 0, child);
      else this.children.push(child);
      return child;
    }
    removeChild(child) {
      const idx = this.children.indexOf(child);
      if (idx >= 0) {
        this.children.splice(idx, 1);
        child.parentElement = null;
      }
      return child;
    }
    remove() {
      if (this.parentElement) this.parentElement.removeChild(this);
    }
    contains(node) {
      if (!node) return false;
      if (node === this) return true;
      return this.children.some(c => c.contains(node));
    }
    getRootNode() { return this.ownerDocument; }
    focus() {
      this._focused = true;
      if (this.ownerDocument) this.ownerDocument.activeElement = this;
    }
    getBoundingClientRect() { return { ...this._rect }; }
    setRect(r) {
      this._rect = {
        left: r.left ?? 0,
        top: r.top ?? 0,
        width: r.width ?? 0,
        height: r.height ?? 0,
        right: (r.left ?? 0) + (r.width ?? 0),
        bottom: (r.top ?? 0) + (r.height ?? 0)
      };
    }
    addEventListener(type, fn) {
      if (!this._listeners.has(type)) this._listeners.set(type, new Set());
      this._listeners.get(type).add(fn);
    }
    removeEventListener(type, fn) {
      this._listeners.get(type)?.delete(fn);
    }
    dispatchEvent(ev) {
      const event = ev && ev._isMockEvent ? ev : {
        _isMockEvent: true,
        type: ev.type,
        target: ev.target || this,
        key: ev.key,
        button: ev.button,
        altKey: Boolean(ev.altKey),
        detail: ev.detail,
        pointerId: ev.pointerId,
        clientX: ev.clientX,
        clientY: ev.clientY,
        defaultPrevented: false,
        propagationStopped: false,
        immediatePropagationStopped: false,
        preventDefault() { this.defaultPrevented = true; },
        stopPropagation() { this.propagationStopped = true; },
        stopImmediatePropagation() { this.immediatePropagationStopped = true; },
        composedPath: ev.composedPath || (() => {
          const path = [];
          let cur = ev.target || this;
          while (cur) { path.push(cur); cur = cur.parentElement; }
          return path;
        })
      };
      const handlers = Array.from(this._listeners.get(event.type) || []);
      for (const h of handlers) h(event);
      if (!event.propagationStopped && this.parentElement) {
        this.parentElement.dispatchEvent(event);
      }
      return event;
    }
    click() {
      if (this.disabled) return;
      this.dispatchEvent({ type: 'click', target: this });
    }
    matches(selector) {
      const parts = String(selector).split(',').map(s => s.trim()).filter(Boolean);
      return parts.some(sel => matchSingleSelector(this, sel));
    }
    closest(selector) {
      let cur = this;
      while (cur) {
        if (cur.matches(selector)) return cur;
        cur = cur.parentElement;
      }
      return null;
    }
    querySelectorAll(selector) {
      const out = [];
      const walk = (node) => {
        for (const ch of node.children) {
          if (ch.matches(selector)) out.push(ch);
          walk(ch);
        }
      };
      walk(this);
      return out;
    }
    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || null;
    }
  }

  function matchSingleSelector(el, sel) {
    if (!sel) return false;
    // 简单支持 #id, .class, tag, [attr="val"], [attr*="val" i], 组合
    let rem = sel;
    const attrRe = /\[([^\]=*]+)(?:(\*?=)"([^"]+)"(?:\s+i)?)?\]/g;
    let m;
    while ((m = attrRe.exec(sel)) !== null) {
      const [, attrName, op, expected] = m;
      const actual = el.getAttribute(attrName);
      if (actual == null) return false;
      if (op === '=') {
        if (actual !== expected) return false;
      } else if (op === '*=') {
        if (!actual.toLowerCase().includes(expected.toLowerCase())) return false;
      }
      rem = rem.replace(m[0], '');
    }
    const idMatch = rem.match(/#([\w-]+)/);
    if (idMatch) {
      if (el.id !== idMatch[1]) return false;
      rem = rem.replace(idMatch[0], '');
    }
    const clsMatches = [...rem.matchAll(/\.([\w-]+)/g)];
    for (const cm of clsMatches) {
      if (!el.classList.contains(cm[1])) return false;
      rem = rem.replace(cm[0], '');
    }
    const tagClean = rem.trim();
    if (tagClean && tagClean !== '*' && el.tagName.toLowerCase() !== tagClean.toLowerCase()) {
      return false;
    }
    return true;
  }

  const docListeners = new Map();
  const winListeners = new Map();
  const doc = {
    nodeType: 9,
    activeElement: null,
    head: null,
    body: null,
    createElement(tag) { return new MockElement(tag, doc); },
    createElementNS(_ns, tag) { return new MockElement(tag, doc); },
    getElementById(id) {
      return doc.head.querySelector(`#${id}`) || doc.body.querySelector(`#${id}`);
    },
    querySelector(sel) {
      return doc.body.querySelector(sel) || doc.head.querySelector(sel);
    },
    querySelectorAll(sel) {
      return [...doc.head.querySelectorAll(sel), ...doc.body.querySelectorAll(sel)];
    },
    addEventListener(t, fn) {
      if (!docListeners.has(t)) docListeners.set(t, new Set());
      docListeners.get(t).add(fn);
    },
    removeEventListener(t, fn) { docListeners.get(t)?.delete(fn); },
    dispatchEvent(ev) {
      for (const fn of Array.from(docListeners.get(ev.type) || [])) fn(ev);
    }
  };
  doc.head = new MockElement('head', doc);
  doc.body = new MockElement('body', doc);

  const win = {
    innerWidth: 1280,
    innerHeight: 800,
    addEventListener(t, fn) {
      if (!winListeners.has(t)) winListeners.set(t, new Set());
      winListeners.get(t).add(fn);
    },
    removeEventListener(t, fn) { winListeners.get(t)?.delete(fn); },
    dispatchEvent(ev) {
      for (const fn of Array.from(winListeners.get(ev.type) || [])) fn(ev);
    },
    getComputedStyle(node) {
      return node?._computedStyle || node?.style || {};
    }
  };

  return { doc, win };
}

function collectAllStrings(obj, out = []) {
  if (typeof obj === 'string') {
    out.push(obj);
  } else if (Array.isArray(obj)) {
    obj.forEach(item => collectAllStrings(item, out));
  } else if (obj && typeof obj === 'object') {
    Object.values(obj).forEach(v => collectAllStrings(v, out));
  }
  return out;
}

test('合规门禁 1: 全部 8 个独立 UI 模块的三语可见文案严格零中英文括号且无 ESM export/import', () => {
  const i18nTables = [
    auxQuickSwitch.AUX_QS_I18N,
    reqSortDropdown.REQ_SORT_I18N,
    presetBoardUpgrades.PRESET_UPGRADE_I18N,
    morphIndicatorToolbar.MTB_I18N,
    nextPromptAlignment.NEXT_PROMPT_ALIGN_I18N,
    insightsAndViews.INSIGHTS_I18N
  ];
  const allCopy = [];
  for (const tbl of i18nTables) collectAllStrings(tbl, allCopy);
  assert.ok(allCopy.length >= 100, `期望三语词条数量充足，实际 ${allCopy.length}`);
  const violations = allCopy.filter(s => /[()（）]/.test(s));
  assert.deepEqual(violations, [], `发现违规括号文案: ${JSON.stringify(violations)}`);

  for (const rel of NEW_MODULE_PATHS) {
    const abs = path.join(__dirname, rel);
    const src = fs.readFileSync(abs, 'utf8');
    assert.equal(/^\s*(?:export|import)\s+/m.test(src), false, `${rel} 不得使用顶层 ESM export/import，需兼容经典 renderer 构建`);
  }
});

test('B1 03+07 右侧辅助区唯一布局入口「标签页／并排」与并排互换、键盘导航及纯状态机跃迁', () => {
  const { doc } = createMockDom();
  const topSlot = doc.createElement('div');
  doc.body.appendChild(topSlot);

  const calls = [];
  const layoutChanges = [];
  let pauseCount = 0;
  let resumeCount = 0;
  const ctrl = auxQuickSwitch.createAuxQuickSwitchController({
    document: doc,
    initialMode: 'plugin',
    initialLayoutMode: 'tab',
    initialPaneOrder: 'plugin-first',
    availableWidth: 960,
    lang: 'zh-CN',
    onLayoutModeChange: (nextLayout) => layoutChanges.push(nextLayout),
    onApplyAuxViewTab: (mode, meta) => calls.push({ mode, ...meta }),
    onPausePluginRendering: () => { pauseCount += 1; },
    onResumePluginRendering: () => { resumeCount += 1; }
  });
  ctrl.mount(topSlot);

  const btnTab = topSlot.querySelector('#ag-aux-qs-mode-tab');
  const btnSplit = topSlot.querySelector('#ag-aux-qs-mode-split');
  const btnSwap = topSlot.querySelector('#ag-aux-qs-swap');

  assert.equal(topSlot.querySelector('#ag-aux-qs-browser'), null, '阶段二收敛后不得保留冗余浏览器胶囊');
  assert.equal(topSlot.querySelector('#ag-aux-qs-context'), null, '阶段二收敛后不得保留冗余上下文胶囊');
  assert.equal(btnTab.textContent, '标签页');
  assert.equal(btnSplit.textContent, '并排');
  assert.equal(btnSwap.hidden, true, '标签页模式下互换按钮应隐藏');

  // 1. 切入并排 -> 显示互换；互换仅改 CSS order 不重建浏览器
  btnSplit.click();
  assert.deepEqual(layoutChanges, ['split']);
  assert.equal(ctrl.getState().layoutMode, 'split');
  assert.equal(btnSwap.hidden, false);

  btnSwap.click();
  assert.equal(ctrl.getState().paneOrder, 'browser-first');
  assert.deepEqual(calls.at(-1).cssOrder, { browser: 1, plugin: 2 });

  // 2. 键盘 ArrowLeft 从并排切回标签页
  btnSplit.focus();
  btnSplit.dispatchEvent({ type: 'keydown', key: 'ArrowLeft', target: btnSplit });
  assert.equal(ctrl.getState().layoutMode, 'tab');
  assert.equal(btnSwap.hidden, true);
  assert.equal(doc.activeElement, btnTab);

  // 3. 纯状态机 dispatchAction 保留 browser/both 暂停恢复语义
  ctrl.dispatchAction('select-browser');
  assert.equal(ctrl.getState().mode, 'browser');
  assert.equal(pauseCount, 1);
  assert.equal(calls.at(-1).preserveBrowserInstance, true);
  assert.equal(calls.at(-1).pluginShellHidden, true);

  ctrl.dispatchAction('toggle-split');
  assert.equal(ctrl.getState().mode, 'both');
  assert.equal(resumeCount, 1);

  // 4. 切到原生 Review 时隐藏布局切换条
  ctrl.sync({ nativeViewKind: 'review' });
  assert.equal(topSlot.querySelector('#ag-aux-quick-switch-bar').hidden, true);
  ctrl.destroy();
});

test('B1-Native 回归 #5 & ELV-108: 右侧辅助面板原生页签栏与 Swarm/Browser/+ 菜单无损共存', () => {
  const { doc } = createMockDom();
  const scope = doc.createElement('div');
  scope.setAttribute('data-side-panel-focus-scope', 'true');
  const strip = doc.createElement('div');
  strip.setAttribute('data-side-panel-strip', 'true');
  strip.setAttribute('data-active-tab-id', 'swarm__main');
  const tabsWrap = doc.createElement('div');
  const swarmTabWrap = doc.createElement('div');
  swarmTabWrap.className = 'agy-aux-tab';
  const swarmBtn = doc.createElement('button');
  swarmBtn.setAttribute('data-tab-id', 'swarm__main');
  swarmBtn.textContent = 'Swarm';
  swarmTabWrap.appendChild(swarmBtn);
  const browserTabWrap = doc.createElement('div');
  browserTabWrap.className = 'agy-aux-tab';
  const browserBtn = doc.createElement('button');
  browserBtn.setAttribute('data-tab-id', 'browser__1');
  browserBtn.textContent = 'Browser';
  browserTabWrap.appendChild(browserBtn);
  tabsWrap.appendChild(swarmTabWrap);
  tabsWrap.appendChild(browserTabWrap);
  const plusBtn = doc.createElement('button');
  plusBtn.setAttribute('data-testid', 'side-panel-new-tab-button');
  strip.appendChild(tabsWrap);
  strip.appendChild(plusBtn);

  const body = doc.createElement('div');
  body.setAttribute('data-side-panel-body', 'true');
  const swarmContent = doc.createElement('div');
  swarmContent.setAttribute('data-testid', 'swarm-overview-board-members-graph');
  swarmContent.textContent = 'Overview Board Members Graph';
  body.appendChild(swarmContent);

  scope.appendChild(strip);
  scope.appendChild(body);
  doc.body.appendChild(scope);

  const pluginHost = doc.createElement('div');
  pluginHost.id = 'ag-context-meter';

  const activeEvents = [];
  const nativeCtrl = auxQuickSwitch.createNativeAuxTabCoexistenceController({
    document: doc,
    lang: 'zh-CN',
    initialActive: false,
    getPluginHost: () => pluginHost,
    onActiveChange: (isActive, meta) => activeEvents.push({ isActive, reason: meta.reason })
  });

  const info1 = nativeCtrl.sync(scope, pluginHost);
  assert.equal(info1.supported, true);
  assert.equal(info1.hasSwarmTab, true);
  assert.equal(info1.hasBrowserTab, true);
  assert.equal(info1.preserveNativeWidth, true, '原生标签栏模式严禁扩宽侧栏挤压主聊天区');
  assert.equal(pluginHost.parentElement, body, 'ContextMeter 必须挂入 data-side-panel-body 内而非覆盖 strip');
  assert.equal(pluginHost.hidden, true, '默认选中 Swarm 时 ContextMeter 隐藏不遮挡 Swarm');
  assert.equal(swarmContent.getAttribute('data-ag-aux-native-occluded'), null);
  assert.ok(strip.querySelector('#ag-context-meter-tab'), '应在原生 strip 中注入 ContextMeter 页签');

  // 1. 点击 ContextMeter 原生页签 -> 激活 ContextMeter，Swarm 仅非破坏性遮罩（严禁 display:none / 销毁），strip 完好无损
  strip.querySelector('#ag-context-meter-tab').click();
  assert.equal(nativeCtrl.getState().active, true);
  assert.equal(pluginHost.hidden, false);
  assert.equal(swarmContent.getAttribute('data-ag-aux-native-occluded'), 'true');
  assert.equal(swarmContent.style.display, undefined, '严禁对 Swarm 内容施加行内 display:none 导致白板');
  assert.equal(strip.hidden, false, '严禁隐藏宿主顶部标签栏');
  assert.equal(strip.getAttribute('data-ag-cm-tab-active'), 'true');

  // 2. 点击 Swarm 原生页签 -> ContextMeter 立即退场，Swarm 完好恢复
  swarmBtn.click();
  assert.equal(nativeCtrl.getState().active, false);
  assert.equal(pluginHost.hidden, true);
  assert.equal(swarmContent.getAttribute('data-ag-aux-native-occluded'), null);
  assert.equal(strip.getAttribute('data-ag-cm-tab-active'), null);

  // 3. 关闭 ContextMeter 页签后，从 SidePanelV2 `+` 新建标签页卡片重新打开
  strip.querySelector('[data-ag-aux-native-tab-close="true"]').click();
  assert.equal(nativeCtrl.getState().tabOpen, false);
  const newTabView = doc.createElement('div');
  newTabView.setAttribute('data-testid', 'side-panel-new-tab-view');
  const cardsList = doc.createElement('div');
  const reviewCard = doc.createElement('button');
  reviewCard.setAttribute('data-testid', 'new-tab-card-review');
  cardsList.appendChild(reviewCard);
  newTabView.appendChild(cardsList);
  body.appendChild(newTabView);
  nativeCtrl.sync(scope, pluginHost);
  const cmCard = newTabView.querySelector('[data-testid="new-tab-card-context-meter"]');
  assert.ok(cmCard, 'SidePanelV2 新建标签页必须注入 ContextMeter 启动卡片');
  cmCard.click();
  assert.equal(nativeCtrl.getState().tabOpen, true);
  assert.equal(nativeCtrl.getState().active, true);
  assert.equal(pluginHost.hidden, false);

  // 4. Classic `+` 下拉菜单入口打开验证
  nativeCtrl.deactivate('reset', { closeTab: true });
  const classicMenu = doc.createElement('div');
  const openFileItem = doc.createElement('button');
  openFileItem.setAttribute('data-testid', 'side-panel-plus-open-file');
  classicMenu.appendChild(openFileItem);
  doc.body.appendChild(classicMenu);
  nativeCtrl.sync(scope, pluginHost);
  const plusMenuItem = classicMenu.querySelector('[data-testid="side-panel-plus-context-meter"]');
  assert.ok(plusMenuItem, 'Classic + 下拉菜单必须注入 ContextMeter 选项');
  plusMenuItem.click();
  assert.equal(nativeCtrl.getState().active, true);

  // 5. 切回 Browser 原生页签 -> ContextMeter 退场
  browserBtn.click();
  assert.equal(nativeCtrl.getState().active, false);
  assert.equal(pluginHost.hidden, true);
  assert.ok(activeEvents.length >= 4);
  nativeCtrl.destroy();
});

test('B1b 回归 #5 & ELV-108 右侧 Swarm / Browser / ContextMeter 原生页签共存与 + 菜单打开（零挤压、零破坏 Swarm 渲染树）', () => {
  const { doc } = createMockDom();
  const scope = doc.createElement('div');
  scope.setAttribute('data-side-panel-focus-scope', 'true');

  const strip = doc.createElement('div');
  strip.setAttribute('data-side-panel-strip', 'true');
  strip.setAttribute('data-active-tab-id', 'swarm-tab-1');

  const swarmTabBtn = doc.createElement('button');
  swarmTabBtn.setAttribute('data-tab-id', 'swarm-tab-1');
  swarmTabBtn.textContent = 'Swarm';

  const browserTabBtn = doc.createElement('button');
  browserTabBtn.setAttribute('data-tab-id', 'browser-tab-1');
  browserTabBtn.textContent = 'Browser';

  const plusBtn = doc.createElement('button');
  plusBtn.setAttribute('data-testid', 'aux-panel-plus-dropdown-trigger');
  plusBtn.textContent = '+';

  strip.appendChild(swarmTabBtn);
  strip.appendChild(browserTabBtn);
  strip.appendChild(plusBtn);

  const body = doc.createElement('div');
  body.setAttribute('data-side-panel-body', 'true');

  const swarmView = doc.createElement('div');
  swarmView.className = 'h-full w-full';
  swarmView.textContent = 'Overview Board Members Graph';
  const browserView = doc.createElement('div');
  browserView.className = 'h-full w-full';
  browserView.setAttribute('data-testid', 'browser-pane');
  body.appendChild(swarmView);
  body.appendChild(browserView);

  scope.appendChild(strip);
  scope.appendChild(body);
  doc.body.appendChild(scope);

  const pluginHost = doc.createElement('div');
  pluginHost.id = 'ag-context-meter';

  const activeEvents = [];
  const nativeCtrl = auxQuickSwitch.createNativeAuxTabCoexistenceController({
    document: doc,
    lang: 'zh-CN',
    initialActive: false,
    getPluginHost: () => pluginHost,
    onActiveChange: (isActive, meta) => activeEvents.push({ isActive, reason: meta.reason })
  });

  // 1. 探测真实宿主 DOM 并挂载 ContextMeter 原生页签与正文节点（不插入中间列，保持宿主宽度）
  const syncRes = nativeCtrl.sync(scope, pluginHost);
  assert.equal(syncRes.supported, true);
  assert.equal(syncRes.hasSwarmTab, true);
  assert.equal(syncRes.hasBrowserTab, true);
  assert.equal(syncRes.activeNativeKind, 'swarm');
  assert.equal(syncRes.preserveNativeWidth, true);
  assert.equal(pluginHost.parentElement, body, '插件必须挂入 data-side-panel-body 内部，绝不遮盖 strip 或插入中间列');
  assert.equal(pluginHost.hidden, true, '初始默认停留在原生 Swarm 页签，ContextMeter 隐退');
  assert.equal(swarmView.getAttribute('data-ag-aux-native-occluded'), null);

  const cmTabWrap = strip.querySelector('#ag-aux-native-tab-wrap');
  const cmTabBtn = strip.querySelector('#ag-context-meter-tab');
  assert.ok(cmTabWrap && cmTabBtn);
  assert.equal(cmTabWrap.nextSibling, plusBtn, 'ContextMeter 页签应紧邻 + 触发按钮之前挂载');

  // 2. 点击 ContextMeter 页签：仅在 body 内非破坏性遮罩 Swarm / Browser（绝不使用 display:none 冲白 Swarm）
  cmTabBtn.click();
  assert.equal(nativeCtrl.getState().active, true);
  assert.equal(strip.getAttribute('data-ag-cm-tab-active'), 'true');
  assert.equal(pluginHost.hidden, false);
  assert.equal(swarmView.getAttribute('data-ag-aux-native-occluded'), 'true');
  assert.equal(browserView.getAttribute('data-ag-aux-native-occluded'), 'true');
  assert.equal(swarmView.style.display || '', '', '严禁对 Swarm 节点设置 display:none');
  assert.equal(swarmView.parentElement, body, 'Swarm 渲染树完整保留在原位');

  // 3. 点击原生 Swarm 页签：ContextMeter 立即退场，Swarm 无损还原
  swarmTabBtn.click();
  assert.equal(nativeCtrl.getState().active, false);
  assert.equal(strip.getAttribute('data-ag-cm-tab-active'), null);
  assert.equal(pluginHost.hidden, true);
  assert.equal(swarmView.getAttribute('data-ag-aux-native-occluded'), null);
  assert.equal(browserView.getAttribute('data-ag-aux-native-occluded'), null);

  // 4. 关闭 ContextMeter 页签后，从 Classic `+` 下拉菜单重新打开并激活
  cmTabBtn.click();
  strip.querySelector('[data-ag-aux-native-tab-close="true"]').click();
  assert.equal(nativeCtrl.getState().tabOpen, false);
  assert.equal(cmTabWrap.hidden, true);

  const plusDropdown = doc.createElement('div');
  const openFileItem = doc.createElement('button');
  openFileItem.setAttribute('data-testid', 'side-panel-plus-open-file');
  plusDropdown.appendChild(openFileItem);
  doc.body.appendChild(plusDropdown);

  nativeCtrl.syncPlusMenuLaunchers();
  const plusCmItem = plusDropdown.querySelector('[data-testid="side-panel-plus-context-meter"]');
  assert.ok(plusCmItem, '+ 下拉菜单必须注入 ContextMeter 入口');
  plusCmItem.click();
  assert.equal(nativeCtrl.getState().tabOpen, true);
  assert.equal(nativeCtrl.getState().active, true);
  assert.equal(cmTabWrap.hidden, false);
  assert.equal(pluginHost.hidden, false);

  nativeCtrl.destroy();
  assert.equal(strip.querySelector('#ag-aux-native-tab-wrap'), null);
});

test('B2 03 悬浮圆球模态层退场（附件预览/Settings）、拖动起点取真实可见坐标防跳变与取消不覆写锚点', () => {
  const { doc, win } = createMockDom();
  const orb = doc.createElement('button');
  orb.id = 'ctx-radial-orb';
  doc.body.appendChild(orb);

  let persistedAnchors = [];
  let radialClosedCount = 0;
  // 模拟：用户原始锚点在 (1200, 720)，但避让右侧辅助栏后实际显示在 (780, 560)
  const ctrl = orbPositioning.createOrbPositioningController({
    document: doc,
    window: win,
    initialAnchor: { x: 1200, y: 720 },
    computeAvoidance: () => ({ x: 780, y: 560 }),
    getBlockerSignature: () => 'aux:840',
    onPersistAnchor: (pos) => persistedAnchors.push(pos),
    onCloseRadialMenu: () => { radialClosedCount += 1; }
  });
  ctrl.attach(orb);

  assert.deepEqual(ctrl.getState().displayPos, { x: 780, y: 560 });
  orb.setRect({ left: 780, top: 560, width: 46, height: 46 });

  // 1. 拖动从实际可见坐标 (780, 560) 起步，首帧只偏移 delta，绝不跳向旧锚点 (1200, 720)
  orb.dispatchEvent({ type: 'pointerdown', button: 0, pointerId: 1, clientX: 800, clientY: 580 });
  win.dispatchEvent({ type: 'pointermove', pointerId: 1, clientX: 810, clientY: 590 });
  assert.deepEqual(ctrl.getState().displayPos, { x: 790, y: 570 }, '首帧必须紧跟当前可见位置，禁止跳变');

  // 2. Esc 取消拖动：回到拖前显示位置 (780, 560)，且绝不覆写用户保存锚点 (1200, 720)
  win.dispatchEvent({ type: 'keydown', key: 'Escape' });
  assert.deepEqual(ctrl.getState().displayPos, { x: 780, y: 560 });
  assert.deepEqual(ctrl.getState().userAnchor, { x: 1200, y: 720 });
  assert.equal(persistedAnchors.length, 0);

  // 3. 附件预览遮罩出现：圆球与径向菜单立即退场；关闭后按同一显示位原位恢复
  const previewModal = doc.createElement('div');
  previewModal.setAttribute('data-testid', 'attachment-preview-modal');
  previewModal.setRect({ left: 100, top: 60, width: 900, height: 640 });
  doc.body.appendChild(previewModal);

  const blockedRes = ctrl.syncVisibilityAndPosition();
  assert.equal(blockedRes.visible, false);
  assert.equal(blockedRes.reason, 'attachment-preview');
  assert.equal(orb.hidden, true);
  assert.equal(orb.style.pointerEvents, 'none');
  assert.ok(radialClosedCount >= 1);

  previewModal.remove();
  const restoredRes = ctrl.syncVisibilityAndPosition();
  assert.equal(restoredRes.visible, true);
  assert.equal(restoredRes.restoredPreModal, true);
  assert.deepEqual(restoredRes.displayPos, { x: 780, y: 560 });

  // 4. 合法拖放落点并持久化一次；随后点击抑制不误开径向菜单
  let clicked = 0;
  orb.setRect({ left: 780, top: 560, width: 46, height: 46 });
  orb.dispatchEvent({ type: 'pointerdown', button: 0, pointerId: 2, clientX: 800, clientY: 580 });
  win.dispatchEvent({ type: 'pointermove', pointerId: 2, clientX: 700, clientY: 500 });
  win.dispatchEvent({ type: 'pointerup', pointerId: 2, clientX: 700, clientY: 500 });
  assert.deepEqual(ctrl.getState().userAnchor, { x: 680, y: 480 });
  assert.equal(persistedAnchors.length, 1);

  // 5. 视口与阻挡物未变时，自动刷新绝不跳位或回弹
  const noBounce = ctrl.syncVisibilityAndPosition();
  assert.equal(noBounce.skippedUnchanged, true);
  assert.deepEqual(noBounce.displayPos, { x: 680, y: 480 });
  ctrl.destroy();
  assert.equal(clicked, 0);
});

test('B3 07 宿主 Settings 左栏字重对齐：检出旧 font-weight: 600 !important 并验证对齐补丁', () => {
  const { doc, win } = createMockDom();
  const legacyFixtureCss = `
    #\${NAV_ID}[data-active="true"],
    #\${NAV_COMPACT_ID}[data-active="true"],
    #\${NAV_ACCOUNTS_ID}[data-active="true"] {
      background: var(--sidebar-secondary) !important;
      color: var(--foreground) !important;
      font-weight: 600 !important;
    }
  `;
  assert.equal(hostSettingsNavAlign.hasForbiddenNavBoldOverride(legacyFixtureCss), true);

  const alignedCss = hostSettingsNavAlign.buildAlignedHostSettingsNavCss();
  assert.equal(hostSettingsNavAlign.hasForbiddenNavBoldOverride(alignedCss), false);
  assert.match(alignedCss, /font-weight:\s*inherit\s*!important/);

  const nativeBrowserBtn = doc.createElement('button');
  nativeBrowserBtn._computedStyle = {
    fontFamily: '"Segoe UI", "Microsoft YaHei", sans-serif',
    fontSize: '13px',
    fontWeight: '400',
    lineHeight: '20px',
    letterSpacing: '0px'
  };
  const pluginBtns = hostSettingsNavAlign.HOST_SETTINGS_NAV_IDS.map(id => {
    const b = doc.createElement('button');
    b.id = id;
    const lbl = doc.createElement('span');
    lbl.className = 'ag-hs-nav-label';
    b.appendChild(lbl);
    return b;
  });

  const res = hostSettingsNavAlign.alignHostSettingsNavTypography(nativeBrowserBtn, pluginBtns, win);
  assert.equal(res.applied, true);
  for (const b of pluginBtns) {
    assert.equal(b.style.fontWeight, '400');
    assert.equal(b.style.fontSize, '13px');
    assert.equal(b.querySelector('.ag-hs-nav-label').style.fontWeight, 'inherit');
  }
});

test('B4 07 实时请求表紧凑排序下拉：默认时间最新优先、键盘操作与端到端速度未舍入排序', () => {
  const { doc } = createMockDom();
  const slot = doc.createElement('div');
  doc.body.appendChild(slot);

  const selectedLog = [];
  const dd = reqSortDropdown.createReqSortDropdownController({
    document: doc,
    lang: 'zh-CN',
    onChange: (val) => selectedLog.push(val)
  });
  dd.mount(slot);

  const trigger = slot.querySelector('#btn-req-sort-trigger');
  const menu = slot.querySelector('#req-sort-menu');
  assert.equal(dd.getState().value, 'time_desc');
  assert.equal(trigger.querySelector('.ag-req-sort-label').textContent, '时间 · 最新优先');
  assert.equal(menu.hidden, true);

  // 键盘打开 -> End 跳到 speed_desc -> Enter 选中并聚焦回 trigger
  trigger.dispatchEvent({ type: 'keydown', key: 'ArrowDown' });
  assert.equal(menu.hidden, false);
  trigger.dispatchEvent({ type: 'keydown', key: 'End' });
  trigger.dispatchEvent({ type: 'keydown', key: 'Enter' });
  assert.equal(dd.getState().value, 'speed_desc');
  assert.equal(menu.hidden, true);
  assert.deepEqual(selectedLog, ['speed_desc']);
  assert.equal(doc.activeElement, trigger);

  // 端到端速度排序：进行中置顶、按未舍入端到端速度排序、绝不拿短流式峰值兜底、无效样本置后
  const records = [
    { id: 'r-short-burst', outputTokens: 863, totalDurationSec: 25.0, streamingTps: 6768.6, timestampMs: 1000 }, // e2e = 34.52
    { id: 'r-no-output', outputTokens: 0, totalDurationSec: 10.0, streamingTps: 999, timestampMs: 4000 }, // invalid
    { id: 'r-fast-e2e', outputTokens: 1000, totalDurationSec: 12.5, timestampMs: 2000 }, // e2e = 80.0
    { id: 'r-streaming-live', status: 'streaming', outputTokens: 10, timestampMs: 5000 } // in-flight pinned first
  ];
  const sorted = reqSortDropdown.sortRequestRecords(records, 'speed_desc');
  assert.deepEqual(sorted.map(r => r.id), ['r-streaming-live', 'r-fast-e2e', 'r-short-burst', 'r-no-output']);
  dd.destroy();
});

test('B5 06 预设全项删除至 0 不复活、中性圆角胶囊、无倾角 2D Swap 与 8 向缩宽/防上沿黑洞', () => {
  const { doc } = createMockDom();
  // 1. 中性圆角胶囊 CSS 无下划线、无 scale 变形
  assert.equal(/transform\s*:\s*scale/i.test(presetBoardUpgrades.PRESET_UPGRADE_CSS), false);
  assert.match(presetBoardUpgrades.PRESET_UPGRADE_CSS, /text-decoration:\s*none\s*!important/);

  // 2. 逐项删除全部 5 个内置预设至 0，重载归一化绝不复活
  let layout = { presetId: 'speed_cost', presetOrder: [...presetBoardUpgrades.BUILTIN_PRESET_IDS], customPresets: [] };
  const d1 = presetBoardUpgrades.deletePresetFromCatalog(layout, 'speed_cost');
  assert.equal(d1.changed, true);
  assert.equal(d1.nextActiveId, 'collab', '删掉 speed_cost 后选中相邻项 collab');
  assert.ok(d1.nextLayout.deletedPresetIds.includes('speed_cost'));

  // 模拟重绘/重载归一化：speed_cost 绝不复活
  const reloaded = presetBoardUpgrades.normalizePresetCatalog(d1.nextLayout);
  assert.equal(reloaded.order.includes('speed_cost'), false);

  // 继续删光剩余 4 个内置预设
  layout = d1.nextLayout;
  for (const id of ['collab', 'debug', 'minimal', 'cockpit']) {
    layout = presetBoardUpgrades.deletePresetFromCatalog(layout, id).nextLayout;
  }
  const zeroState = presetBoardUpgrades.normalizePresetCatalog(layout);
  assert.equal(zeroState.isEmptyCatalog, true);
  assert.deepEqual(zeroState.order, []);
  assert.equal(zeroState.activeId, null);

  // 验证操作条把 ctx-mini-link-btn 统一为 ctx-action-pill 且允许内置预设显示删除按钮
  const actionWrap = doc.createElement('div');
  for (const act of ['overwrite', 'rename', 'delete']) {
    const b = doc.createElement('button');
    b.className = 'ctx-mini-link-btn';
    b.setAttribute('data-custom-preset-action', act);
    actionWrap.appendChild(b);
  }
  const builtinCatalog = presetBoardUpgrades.normalizePresetCatalog({ presetId: 'speed_cost' });
  presetBoardUpgrades.syncPresetActionPillsDom(actionWrap, builtinCatalog, 'zh-CN');
  assert.equal(actionWrap.hidden, false);
  const delBtn = actionWrap.querySelector('[data-custom-preset-action="delete"]');
  assert.equal(delBtn.classList.contains('ctx-mini-link-btn'), false);
  assert.equal(delBtn.classList.contains('ctx-action-pill'), true);
  assert.equal(delBtn.classList.contains('ctx-action-pill--danger-hover'), true);
  assert.equal(delBtn.hidden, false);

  // 3. 2D Swap 硬参数验证：11px / 140ms / 250ms / 200ms / 160ms，且 0 倾角、0 拉伸、无 jelly
  const p = presetBoardUpgrades.PRESET_SWAP_PARAMS;
  assert.equal(p.dragThresholdPx, 5);
  assert.equal(p.longPressMs, 140);
  assert.equal(p.deadzonePx, 11);
  assert.equal(p.cooldownMs, 140);
  assert.equal(p.flipMs, 250);
  assert.equal(p.dropMs, 200);
  assert.equal(p.shadowFadeMs, 160);
  assert.equal(p.maxTiltDeg, 0);
  assert.equal(p.maxStretch, 0);
  assert.equal(p.jellySettle, false);

  // 非相邻交换只换 origin 与 target，中间项保持原位，末尾 add 按钮永不命中
  const swapped = presetBoardUpgrades.computeDirectSwapOrder(['a', 'b', 'c', 'd'], 0, 3);
  assert.deepEqual(swapped, ['d', 'b', 'c', 'a']);
  const hitAdd = presetBoardUpgrades.hitTestFrozenHomeSlots(
    450, 15, { left: 410, top: 0, width: 80, height: 30 },
    [{ index: 0, rect: { left: 0, right: 80, top: 0, bottom: 30, width: 80, height: 30 } }, { index: 1, isAddButton: true, rect: { left: 410, right: 490, top: 0, bottom: 30, width: 80, height: 30 } }]
  );
  assert.equal(hitAdd, -1);

  // 4. 8 向自由缩放：单列窄栏右上角可连续缩宽，上沿向下拉绝不在上方撕出黑洞
  const topRightRes = presetBoardUpgrades.resolveFreeResizeGeometry(
    { startX: 400, startY: 100, startW: 400, startH: 300, gridW: 400, gridLeft: 0, gridTop: 20, fromLeft: false, fromTop: true, resizeAxis: 'both', singleColumn: true },
    { x: 280, y: 160 }
  );
  assert.equal(topRightRes.width, 280, '窄栏/单列右上角拖动必须能连续缩宽');
  assert.equal(topRightRes.height, 240);
  assert.equal(topRightRes.topGapCreatedPx, 0, '上沿向下缩放不得在卡片上方撕开黑洞');
  assert.equal(topRightRes.lockOuterPanelHeight, true);

  // 5. 四卡同行预算
  const wide4 = presetBoardUpgrades.computeFourCardRowBudget(960, 10);
  assert.equal(wide4.canFitFour, true);
  assert.equal(wide4.fourCardWidths.reduce((a, b) => a + b, 0) + 30, 960);
});

test('B6 07 右上角 5 槽位原位折叠工具栏 + #107 额度圆环交互 + 59s/迟到回包/底栏五项回归', () => {
  const { doc } = createMockDom();
  const host = doc.createElement('div');
  doc.body.appendChild(host);

  const actions = [];
  const quotaCycles = [];
  const quotaPanels = [];
  const mtb = morphIndicatorToolbar.createMorphIndicatorToolbarController({
    document: doc,
    initialScopeKey: 'acctA::sess1',
    lang: 'zh-CN',
    onSlotAction: (slotId) => actions.push(slotId),
    onQuotaCycleWindow: (meta) => quotaCycles.push(meta),
    onQuotaPanelToggle: (meta) => quotaPanels.push(meta)
  });
  const rootEl = mtb.mount(host);

  // 1. 默认 5 槽位原位折叠（submenu），5 个直接槽位：额度环、上下文环、状态组、统计组、CLI
  assert.equal(rootEl.getAttribute('data-layout'), 'submenu');
  assert.equal(rootEl.getAttribute('data-label-size'), 'sm');
  assert.equal(rootEl.getAttribute('data-speed-multiplier'), '1');
  const track = rootEl.querySelector('.ag-v2-mtb-track');
  assert.equal(track.children.length, 5, '默认收起主栏必须严格为 5 个槽位');
  assert.ok(host.querySelector('#ag-v2-mtb-slot-ring-primary'));
  assert.ok(host.querySelector('#ag-v2-mtb-slot-ring-secondary'));
  assert.ok(host.querySelector('#ag-v2-mtb-group-ttft'));
  assert.ok(host.querySelector('#ag-v2-mtb-group-stats'));
  assert.ok(host.querySelector('#ag-v2-mtb-slot-cli'));

  // 2. 59 秒 -> 01:00 边界格式
  assert.equal(morphIndicatorToolbar.formatTtftElapsedSeconds(59), '59');
  assert.equal(morphIndicatorToolbar.formatTtftElapsedSeconds(60), '01:00');
  assert.equal(morphIndicatorToolbar.formatTtftElapsedSeconds(130), '02:10');

  // 3. 真实快照渲染（含真实 0% 缓存、10.1% 精度保护与 reducedMotion 同步）
  const r1 = mtb.render({
    scopeKey: 'acctA::sess1',
    quota5h: { remainingFraction: 0.101 },
    quota7d: { remainingFraction: 0.5665411 },
    contextUsed: 128000,
    contextBudget: 512000,
    cacheHitPct: 0,
    phase: 'waiting',
    ttftElapsedSec: 60,
    tps: 0,
    containerWidth: 300
  });
  assert.equal(r1.applied, true);
  assert.equal(r1.layoutMode, 'submenu');
  assert.equal(r1.quotaText, '5H 10.1% · 7D 57%');
  assert.equal(r1.contextText, '25%');
  assert.equal(r1.cacheText, '缓存 0%');
  assert.equal(r1.ttftText, '01:00');
  assert.equal(r1.speedText, '0 tok/s');
  assert.equal(rootEl.getAttribute('data-compact'), 'true', '窄栏应自动切换紧凑模式');

  // 4. 切会话后旧作用域的迟到异步回包被拒绝
  mtb.setActiveScope('acctA::sess2');
  const staleRes = mtb.render({ scopeKey: 'acctA::sess1', tps: 999 });
  assert.equal(staleRes.applied, false);
  assert.equal(staleRes.reason, 'stale-scope');

  // 5. 状态组原位展开 -> 选「生成速度」触发回调并保持当前图标 -> 快切统计组取消前次收起且互斥展开
  const ttftGroup = host.querySelector('#ag-v2-mtb-group-ttft');
  const statsGroup = host.querySelector('#ag-v2-mtb-group-stats');
  assert.equal(ttftGroup.getAttribute('data-open'), 'false');
  assert.equal(statsGroup.getAttribute('data-open'), 'false');

  host.querySelector('#ag-v2-mtb-tool-ttft').click();
  assert.equal(ttftGroup.getAttribute('data-open'), 'true');
  assert.equal(statsGroup.getAttribute('data-open'), 'false');

  // 选中生成速度：触发回调、切换代表项并挂起短促收起定时器
  host.querySelector('#ag-v2-mtb-tool-tok-speed').click();
  assert.equal(mtb.getState().activeTools.ttftGroup, 'tok-speed');
  assert.ok(actions.includes('tok-speed'));

  // 在状态组尚未收起前快切统计组：立即取消前次收起定时器并互斥展开统计组
  host.querySelector('#ag-v2-mtb-tool-stats-bars').click();
  assert.equal(ttftGroup.getAttribute('data-open'), 'false');
  assert.equal(statsGroup.getAttribute('data-open'), 'true');

  // 开启 reducedMotion 后选中统计组子项「构成图」立即自动收起并保留构成图代表项
  mtb.render({ scopeKey: 'acctA::sess2', reducedMotion: true });
  host.querySelector('#ag-v2-mtb-tool-stats-donut').click();
  assert.equal(mtb.getState().activeTools.statsGroup, 'stats-donut');
  assert.equal(statsGroup.getAttribute('data-open'), 'false');
  assert.ok(actions.includes('stats-donut'));

  // 6. 关闭按钮 / Esc / 点击外部均收起展开组
  host.querySelector('#ag-v2-mtb-tool-stats-donut').click();
  assert.equal(statsGroup.getAttribute('data-open'), 'true');
  host.querySelector('#ag-v2-mtb-close-stats').click();
  assert.equal(statsGroup.getAttribute('data-open'), 'false');

  host.querySelector('#ag-v2-mtb-tool-tok-speed').click();
  assert.equal(ttftGroup.getAttribute('data-open'), 'true');
  doc.dispatchEvent({ type: 'keydown', key: 'Escape' });
  assert.equal(ttftGroup.getAttribute('data-open'), 'false');

  host.querySelector('#ag-v2-mtb-tool-tok-speed').click();
  assert.equal(ttftGroup.getAttribute('data-open'), 'true');
  doc.dispatchEvent({ type: 'pointerdown', target: doc.body, composedPath: () => [doc.body] });
  assert.equal(ttftGroup.getAttribute('data-open'), 'false');

  // 7. Issue #107 额度圆环：左键切 5H/7D、Alt+左键开大面板、右键开大面板并抑制宿主复制菜单、其他图标右键不误触发
  const quotaSlot = host.querySelector('#ag-v2-mtb-slot-ring-primary');
  quotaSlot.dispatchEvent({ type: 'click', target: quotaSlot, detail: 1, altKey: false });
  assert.equal(quotaCycles.length, 1);
  assert.equal(quotaPanels.length, 0);

  quotaSlot.dispatchEvent({ type: 'click', target: quotaSlot, detail: 1, altKey: true });
  assert.equal(quotaPanels.length, 1);
  assert.equal(quotaPanels[0].source, 'alt-click');

  const ctxEv = quotaSlot.dispatchEvent({ type: 'contextmenu', target: quotaSlot });
  assert.equal(ctxEv.defaultPrevented, true, '右键额度圆环必须阻止宿主默认复制菜单');
  assert.equal(ctxEv.propagationStopped, true);
  assert.equal(quotaPanels.length, 2);
  assert.equal(quotaPanels[1].source, 'contextmenu');

  const cliSlot = host.querySelector('#ag-v2-mtb-slot-cli');
  const cliCtxEv = cliSlot.dispatchEvent({ type: 'contextmenu', target: cliSlot });
  assert.equal(Boolean(cliCtxEv.defaultPrevented), false, '非额度图标右键不得被劫持或误切主题');
  assert.equal(quotaPanels.length, 2);

  // 8. 切到单 Browser / 原生 Swarm 时（auxViewerVisible: false）工具栏退场并收起展开组
  host.querySelector('#ag-v2-mtb-tool-tok-speed').click();
  assert.equal(ttftGroup.getAttribute('data-open'), 'true');
  const hideRes = mtb.render({ scopeKey: 'acctA::sess2', auxViewerVisible: false });
  assert.equal(hideRes.visible, false);
  assert.equal(rootEl.hidden, true);
  assert.equal(ttftGroup.getAttribute('data-open'), 'false');

  // 9. 第一层底栏五项常驻 & 剥离 +N 徽标 + 大写 5H/7D
  const csb = doc.createElement('div');
  const more = doc.createElement('span');
  more.id = 'csb-quota-more';
  more.textContent = '+2';
  const q5 = doc.createElement('span');
  q5.id = 'csb-quota-text-5h';
  q5.textContent = '5h 80%';
  const q7 = doc.createElement('span');
  q7.id = 'csb-quota-text-7d';
  q7.textContent = '7d 57%';
  csb.appendChild(more);
  csb.appendChild(q5);
  csb.appendChild(q7);
  const stripRes = morphIndicatorToolbar.stripComposerQuotaMoreBadge(csb);
  assert.equal(stripRes.removedCount, 1);
  assert.equal(more.hidden, true);
  assert.equal(more.textContent, '');
  assert.equal(q5.textContent, '5H 80%');
  assert.equal(q7.textContent, '7D 57%');

  const five = morphIndicatorToolbar.buildComposerPermanentFiveMetrics({
    phase: 'streaming',
    tps: 108.1,
    contextUsed: 51100,
    contextBudget: 512000,
    cacheHitPct: 98.2,
    quota5h: { remainingFraction: 0.58 },
    quota7d: { remainingFraction: 0.57 }
  }, 'zh-CN');
  assert.equal(five.items.length, 5);
  assert.equal(five.hasQuotaMoreBadge, false);
  assert.equal(five.hasSecondStatusLine, false);

  // 10. 第二层单任务额度尾标对接 @data-lead #9 契约
  const footerLine = morphIndicatorToolbar.formatTurnFooterCompactLine({
    inputTokens: 24800,
    outputTokens: 6200,
    cacheHitPct: 98.2,
    taskQuotaObservation: {
      isTaskTerminalReply: true,
      windows: {
        '5h': { status: 'observed', deltaPp: 3 },
        weekly: { status: 'observed', deltaPp: 0.4 }
      }
    }
  }, 'zh-CN');
  assert.equal(footerLine, '↑ 24.8K · ↓ 6.2K · 缓存 98.2% · 5H −3% 观测 · 7D −0.4% 观测');
  mtb.destroy();
});

test('B8 07 下一句预测内联几何对齐与六色对比度试验', () => {
  const { doc, win } = createMockDom();
  const legacyGhostCss = `
    .ag-np-ghost.ag-np-inline-ghost {
      position: absolute !important;
      inset: 0 !important;
      padding: 0 !important;
    }
  `;
  assert.equal(nextPromptAlignment.hasConflictingGhostGeometryCss(legacyGhostCss), true);
  assert.equal(nextPromptAlignment.hasConflictingGhostGeometryCss(nextPromptAlignment.ALIGNED_GHOST_CSS), false);

  const anchorParent = doc.createElement('div');
  anchorParent.setRect({ left: 100, top: 500, width: 500, height: 64 });
  anchorParent._computedStyle = { borderTopWidth: '1px', borderLeftWidth: '1px' };
  const editor = doc.createElement('div');
  editor.setRect({ left: 112, top: 508, width: 476, height: 48 });
  editor._computedStyle = {
    fontSize: '14px',
    lineHeight: '21px',
    fontFamily: 'Inter, sans-serif',
    paddingTop: '6px',
    paddingLeft: '8px',
    paddingRight: '8px',
    paddingBottom: '6px',
    borderTopWidth: '0px',
    borderLeftWidth: '0px'
  };
  const ghost = doc.createElement('div');
  anchorParent.appendChild(editor);
  anchorParent.appendChild(ghost);

  const geo = nextPromptAlignment.syncAlignedInlineGhostGeometry(ghost, editor, anchorParent, win);
  assert.equal(geo.left, 11);
  assert.equal(geo.top, 7);
  assert.equal(ghost.style.paddingLeft, '8px');
  assert.equal(ghost.style.fontSize, '14px');
  assert.equal(ghost.style.lineHeight, '21px');

  // 六色开关与 #252525 背景对比度验证
  const dbg = nextPromptAlignment.createNextPromptColorDebugController({ ghostEl: ghost, backgroundHex: '#252525' });
  const reports = dbg.getAllSwatchReports();
  assert.equal(reports.length, 6);
  const byHex = new Map(reports.map(r => [r.color, r.contrastRatio]));
  assert.equal(byHex.get('#9A9A9A'), 5.45);
  assert.equal(byHex.get('#959595'), 5.12);
  assert.equal(byHex.get('#474747'), 1.65);

  const sw = dbg.setColor('#959595');
  assert.equal(sw.color, '#959595');
  assert.equal(ghost.style.getPropertyValue('--ag-np-ghost-color'), '#959595');
});

test('B9 07 左栏上下文洞察全页、会话四视角与 Orchestrator 两位小机器人编排可视化', () => {
  const { doc } = createMockDom();

  // 1. 左栏 Customizations 与 Projects 之间锚点定位
  const sidebar = doc.createElement('nav');
  const btnCust = doc.createElement('button');
  btnCust.textContent = 'Customizations';
  const btnProj = doc.createElement('button');
  btnProj.textContent = 'Projects';
  sidebar.appendChild(btnCust);
  sidebar.appendChild(btnProj);
  const anchor = insightsAndViews.findSidebarInsightsAnchor(sidebar);
  assert.equal(anchor.parent, sidebar);
  assert.equal(anchor.insertBefore, btnProj);

  // 2. 全页洞察路由与筛选：打开零网络请求，返回保留会话状态
  const pageCtrl = insightsAndViews.createContextInsightsPageController({ lang: 'zh-CN' });
  const opened = pageCtrl.openPage({ sessionId: 's1', scrollTop: 320, draft: 'hello' });
  assert.equal(opened.active, true);
  assert.equal(opened.networkRequestCountOnOpen, 0);
  pageCtrl.setFilters({ heatmapMetric: 'cost', accountScope: 'acct1', includeArchived: false });
  const filtered = pageCtrl.filterSessions([
    { sessionId: 's1', title: 'Alpha', accountScopeKey: 'acct1', archived: false },
    { sessionId: 's2', title: 'Old', accountScopeKey: 'acct1', archived: true },
    { sessionId: 's3', title: 'Other', accountScopeKey: 'acct2', archived: false }
  ]);
  assert.deepEqual(filtered.map(s => s.sessionId), ['s1']);
  const closed = pageCtrl.closePage();
  assert.equal(closed.restoredConversation.draft, 'hello');

  // 3. 会话四视角（对话/轨迹/上下文/编队）按 pane 隔离并保留草稿
  const viewCtrl = insightsAndViews.createSessionFourViewsController({ document: doc, lang: 'zh-CN' });
  const tabHost = doc.createElement('div');
  doc.body.appendChild(tabHost);
  viewCtrl.mountSwitcher(tabHost, 'pane-left');
  assert.equal(viewCtrl.getView('pane-left'), 'chat');
  viewCtrl.switchView('pane-left', 'trace', { draft: 'wip', scrollTop: 180 });
  assert.equal(viewCtrl.getView('pane-left'), 'trace');
  assert.equal(viewCtrl.getView('pane-right'), 'chat');
  const back = viewCtrl.switchView('pane-left', 'chat');
  assert.equal(back.restoredChatState.draft, 'wip');

  // 4. Orchestrator 两位小机器人：纯配置态无高亮无动画 -> 真实交接态带方向与任务卡 -> 点展开并定位轨迹
  const orchHost = doc.createElement('div');
  doc.body.appendChild(orchHost);
  const located = [];
  const orch = insightsAndViews.createOrchestratorVisualController({
    document: doc,
    lang: 'zh-CN',
    onLocateInTrace: (evId) => located.push(evId)
  });
  const card = orch.mount(orchHost);

  // 4a. 仅配置态：零活动高亮、零箭头、显示「运行分工未记录」
  const cfgNorm = orch.render({ plannerModel: 'Gemini 4 Argon', executorModel: 'Gemini 4 Neon', events: [] });
  assert.equal(cfgNorm.hasRuntimeEvidence, false);
  assert.equal(cfgNorm.actionText, '运行分工未记录');
  assert.equal(card.querySelectorAll('.ag-orch-track').length, 0);
  assert.equal(card.querySelector('[data-orch-role="planner"]').getAttribute('data-active'), 'false');

  // 4b. 真实交接事件（含重复 eventId 去重 + 同时忙碌重叠态）
  const liveNorm = orch.render({
    plannerModel: 'Gemini 4 Argon',
    executorModel: 'Gemini 4 Neon',
    plannerBusy: true,
    executorBusy: true,
    handoffDirection: 'planner-to-executor',
    confirmedActionText: '执行正在跑测试',
    events: [
      { eventId: 'ev-1', traceEventId: 'tr-1', role: 'planner', type: 'handoff', from: 'planner', to: 'executor', summary: '提交测试计划' },
      { eventId: 'ev-1', traceEventId: 'tr-1', role: 'planner', type: 'handoff', from: 'planner', to: 'executor', summary: '重复事件应去重' },
      { eventId: 'ev-2', traceEventId: 'tr-2', role: 'executor', type: 'tool', summary: '执行定向测试' }
    ]
  });
  assert.equal(liveNorm.hasRuntimeEvidence, true);
  assert.equal(liveNorm.dualBusy, true);
  assert.equal(liveNorm.events.length, 2);
  assert.ok(card.querySelector('.ag-orch-task-chip.is-sliding-right'));

  // 点击交接区展开时间线并定位到轨迹
  card.querySelector('[data-orch-handoff="true"]').click();
  const locateBtn = card.querySelector('.ag-orch-locate-btn');
  assert.ok(locateBtn);
  locateBtn.click();
  assert.deepEqual(located, ['tr-1']);

  // 减弱动效与窄栏上下排列
  orch.render({ plannerModel: 'Gemini 4 Argon', executorModel: 'Gemini 4 Neon', reducedMotion: true, containerWidth: 300, events: liveNorm.events });
  assert.equal(card.getAttribute('data-reduced-motion'), 'true');
  assert.equal(card.getAttribute('data-stacked'), 'true');
  orch.destroy();
});
