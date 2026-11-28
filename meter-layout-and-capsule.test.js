'use strict';

process.env.AG_METER_TEST_MODE = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const auxQuickSwitch = require('./src/renderer/aux-quick-switch.js');
const morphIndicatorToolbar = require('./src/renderer/morph-indicator-toolbar.js');

const MAIN_SOURCE = fs.readFileSync(path.join(__dirname, 'src', 'renderer', 'main.js'), 'utf8');
const SETTINGS_UI_SOURCE = fs.readFileSync(path.join(__dirname, 'src', 'renderer', 'context-settings-ui.js'), 'utf8');

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
    remove(...cls) { cls.forEach(c => c && this._set.delete(c)); this._syncToString(); }
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
      this.dataset = {};
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
    getBoundingClientRect() { return { ...this._rect }; }
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
        altKey: Boolean(ev.altKey),
        detail: ev.detail,
        defaultPrevented: false,
        propagationStopped: false,
        immediatePropagationStopped: false,
        preventDefault() { this.defaultPrevented = true; },
        stopPropagation() { this.propagationStopped = true; },
        stopImmediatePropagation() { this.immediatePropagationStopped = true; },
        composedPath: ev.composedPath || (() => {
          const p = [];
          let cur = ev.target || this;
          while (cur) { p.push(cur); cur = cur.parentElement; }
          return p;
        })
      };
      for (const h of Array.from(this._listeners.get(event.type) || [])) h(event);
      if (!event.propagationStopped && this.parentElement) {
        this.parentElement.dispatchEvent(event);
      }
      return event;
    }
    click() {
      if (this.disabled) return;
      this.dispatchEvent({ type: 'click', target: this, detail: 1 });
    }
    matches(selector) {
      return String(selector).split(',').map(s => s.trim()).filter(Boolean).some(sel => {
        let rem = sel;
        const attrRe = /\[([^\]=*]+)(?:(\*?=)"([^"]+)"(?:\s+i)?)?\]/g;
        let m;
        while ((m = attrRe.exec(sel)) !== null) {
          const [, attrName, op, expected] = m;
          const actual = this.getAttribute(attrName);
          if (actual == null) return false;
          if (op === '=' && actual !== expected) return false;
          if (op === '*=' && !actual.toLowerCase().includes(expected.toLowerCase())) return false;
          rem = rem.replace(m[0], '');
        }
        const idMatch = rem.match(/#([\w-]+)/);
        if (idMatch) {
          if (this.id !== idMatch[1]) return false;
          rem = rem.replace(idMatch[0], '');
        }
        for (const cm of rem.matchAll(/\.([\w-]+)/g)) {
          if (!this.classList.contains(cm[1])) return false;
          rem = rem.replace(cm[0], '');
        }
        const tagClean = rem.trim();
        if (tagClean && tagClean !== '*' && this.tagName.toLowerCase() !== tagClean.toLowerCase()) return false;
        return true;
      });
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

  const docListeners = new Map();
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
  return { doc };
}

test('任务 A1：恢复右侧标签页与并排分栏双模式同级切换，并完整保留换位与单视图控制', () => {
  const { doc } = createMockDom();
  const barSlot = doc.createElement('div');
  doc.body.appendChild(barSlot);

  const layoutChanges = [];
  const viewChanges = [];
  const ctrl = auxQuickSwitch.createAuxQuickSwitchController({
    document: doc,
    lang: 'zh-CN',
    initialMode: 'plugin',
    initialLayoutMode: 'tab',
    showLayoutModeSwitch: true,
    compactForNativeTab: true,
    availableWidth: 960,
    onLayoutModeChange: (nextLayout) => layoutChanges.push(nextLayout),
    onApplyAuxViewTab: (mode, meta) => viewChanges.push({ mode, ...meta })
  });
  ctrl.mount(barSlot);

  const btnTab = barSlot.querySelector('#ag-aux-qs-mode-tab');
  const btnSplit = barSlot.querySelector('#ag-aux-qs-mode-split');
  const btnSwap = barSlot.querySelector('#ag-aux-qs-swap');

  assert.ok(btnTab && btnSplit, '右侧面板顶栏必须呈现标签页与并排二选一切换');
  assert.equal(btnTab.getAttribute('aria-selected'), 'true');
  assert.equal(btnSplit.getAttribute('aria-selected'), 'false');
  assert.equal(btnTab.textContent, '标签页');
  assert.equal(btnSplit.textContent, '并排');

  // 切换到并排
  btnSplit.click();
  assert.deepEqual(layoutChanges, ['split']);
  assert.equal(btnSplit.getAttribute('aria-selected'), 'true');
  assert.equal(btnTab.getAttribute('aria-selected'), 'false');

  // 同步并排模式与 both 视图：互换按钮可用，切换顺序仅靠 CSS order
  ctrl.sync({ layoutMode: 'split', mode: 'both', compactForNativeTab: false });
  assert.equal(btnSwap.hidden, false);
  assert.equal(btnSwap.textContent, '互换');
  btnSwap.click();
  assert.equal(viewChanges.at(-1).paneOrder, 'browser-first');

  // 切回标签页
  btnTab.click();
  assert.deepEqual(layoutChanges, ['split', 'tab']);
  ctrl.destroy();
});

test('任务 A2：死保宿主右侧标签栏末尾原生 + 新建标签按钮，无论先开插件还是先开 Swarm/Browser 均常驻可见可点击', () => {
  const { doc } = createMockDom();
  const scope = doc.createElement('div');
  scope.setAttribute('data-side-panel-focus-scope', 'true');
  const strip = doc.createElement('div');
  strip.setAttribute('data-side-panel-strip', 'true');
  strip.setAttribute('data-active-tab-id', 'swarm__1');
  const swarmWrap = doc.createElement('div');
  swarmWrap.className = 'agy-aux-tab';
  const swarmBtn = doc.createElement('button');
  swarmBtn.setAttribute('data-tab-id', 'swarm__1');
  swarmBtn.textContent = 'Swarm';
  swarmWrap.appendChild(swarmBtn);
  const plusBtn = doc.createElement('button');
  plusBtn.setAttribute('data-testid', 'side-panel-new-tab-button');
  plusBtn.textContent = '+';
  strip.appendChild(swarmWrap);
  strip.appendChild(plusBtn);

  const body = doc.createElement('div');
  body.setAttribute('data-side-panel-body', 'true');
  const swarmContent = doc.createElement('div');
  swarmContent.setAttribute('data-testid', 'swarm-view');
  body.appendChild(swarmContent);

  scope.appendChild(strip);
  scope.appendChild(body);
  doc.body.appendChild(scope);

  const pluginHost = doc.createElement('div');
  pluginHost.id = 'ag-context-meter';

  const nativeCtrl = auxQuickSwitch.createNativeAuxTabCoexistenceController({
    document: doc,
    lang: 'zh-CN',
    initialActive: true,
    getPluginHost: () => pluginHost
  });

  // 场景 1：先有 Swarm，再挂载并激活 ContextMeter -> + 按钮仍在末尾、未隐藏、未遮罩
  nativeCtrl.sync(scope, pluginHost, { forceActive: true });
  const cmTabWrap = strip.querySelector('#ag-aux-native-tab-wrap');
  assert.ok(cmTabWrap, 'ContextMeter 原生页签应已挂入 strip');
  assert.equal(strip.contains(plusBtn), true, '原生 + 按钮必须常驻 strip DOM');
  assert.equal(plusBtn.hidden, false);
  assert.equal(plusBtn.getAttribute('data-ag-aux-native-occluded'), null);
  assert.ok(strip.children.indexOf(cmTabWrap) < strip.children.indexOf(plusBtn), 'ContextMeter 页签必须插在 + 按钮之前，+ 按钮保持末尾');

  // 场景 2：模拟宿主重排把 + 按钮意外放到了前面或外部误设为隐藏 -> 下一次 sync 立刻自动修复保活
  plusBtn.hidden = true;
  plusBtn.style.display = 'none';
  strip.insertBefore(plusBtn, cmTabWrap);
  nativeCtrl.sync(scope, pluginHost, { forceActive: true });
  assert.equal(plusBtn.hidden, false, '+ 按钮绝不可被隐藏');
  assert.notEqual(plusBtn.style.display, 'none', '+ 按钮绝不可被设为 display:none');
  assert.ok(strip.children.indexOf(cmTabWrap) < strip.children.indexOf(plusBtn), '+ 按钮始终位于 ContextMeter 之后');

  // 场景 3：点击 + 按钮立即退场 ContextMeter 且 + 按钮可正常触发点击
  let plusClicked = 0;
  plusBtn.addEventListener('click', () => { plusClicked += 1; });
  plusBtn.click();
  assert.equal(plusClicked, 1);
  assert.equal(nativeCtrl.getState().active, false);
  assert.equal(swarmContent.getAttribute('data-ag-aux-native-occluded'), null);

  nativeCtrl.destroy();
  assert.equal(strip.contains(plusBtn), true, '卸载插件控制器后原生 + 按钮仍完好无损');
});

test('任务 B：右上角 5 槽位原位折叠胶囊（去硬编码紫色、5H/7D 微标+防雪崩节流刷新、槽位 3 智能切换与手动锁定、CLI 三态配色）', () => {
  // 1. 彻底去除硬编码紫色
  assert.equal(/#a78bfa|#c084fc/i.test(morphIndicatorToolbar.MTB_PROD_CSS), false, '胶囊样式不得残留硬编码紫色');
  assert.equal(/#a78bfa|#c084fc/i.test(auxQuickSwitch.AUX_NATIVE_TAB_CSS), false, '原生页签样式不得残留硬编码紫色');

  const { doc } = createMockDom();
  const container = doc.createElement('div');
  doc.body.appendChild(container);

  const cycleEvents = [];
  const quotaPanelEvents = [];
  const actions = [];
  const pinChanges = [];

  const mtb = morphIndicatorToolbar.createMorphIndicatorToolbarController({
    document: doc,
    initialScopeKey: 'acct1::s1',
    initialStatusPinMode: 'auto',
    quotaRefreshThrottleMs: 1800,
    lang: 'zh-CN',
    onQuotaCycleWindow: (meta) => cycleEvents.push(meta),
    onQuotaPanelToggle: (meta) => quotaPanelEvents.push(meta),
    onSlotAction: (act) => actions.push(act),
    onStatusPinChange: (mode) => pinChanges.push(mode)
  });
  const rootEl = mtb.mount(container);

  // 槽位 1：5H / 7D 微型标识 + 单击切换并节流刷新 + 右键展开大面板
  const quotaBtn = rootEl.querySelector('#ag-v2-mtb-slot-ring-primary');
  const b5 = rootEl.querySelector('#ag-v2-mtb-quota-badge-5h');
  const b7 = rootEl.querySelector('#ag-v2-mtb-quota-badge-7d');
  assert.equal(b5.textContent, '5H');
  assert.equal(b7.textContent, '7D');
  assert.equal(b5.getAttribute('data-active'), 'true');
  assert.equal(b7.getAttribute('data-active'), 'false');

  // 第 1 次左键：切到 7D 并触发刷新脉冲
  quotaBtn.click();
  assert.equal(cycleEvents.length, 1);
  assert.equal(cycleEvents[0].nextWindow, '7d');
  assert.equal(cycleEvents[0].shouldRefresh, true);
  assert.equal(quotaBtn.getAttribute('data-refreshing'), 'true');
  assert.equal(b7.getAttribute('data-active'), 'true');

  // 紧接着高频第 2 次左键：仍切回 5H，但刷新被防雪崩节流拦截
  quotaBtn.click();
  assert.equal(cycleEvents.length, 2);
  assert.equal(cycleEvents[1].nextWindow, '5h');
  assert.equal(cycleEvents[1].shouldRefresh, false);
  assert.equal(cycleEvents[1].throttled, true);

  // 右键额度环：原地展开大面板并抑制宿主菜单
  const ctxEv = quotaBtn.dispatchEvent({ type: 'contextmenu', target: quotaBtn });
  assert.equal(ctxEv.defaultPrevented, true);
  assert.equal(quotaPanelEvents.length, 1);
  assert.equal(quotaPanelEvents[0].source, 'contextmenu');

  // 槽位 3：智能自动切换（waiting -> ttft 沙漏；streaming -> tok-speed 仪表盘）
  mtb.render({ scopeKey: 'acct1::s1', phase: 'waiting', ttftElapsedSec: 4, tps: null });
  assert.equal(mtb.getState().activeTools.ttftGroup, 'ttft');

  mtb.render({ scopeKey: 'acct1::s1', phase: 'streaming', ttftElapsedSec: 4, tps: 92 });
  assert.equal(mtb.getState().activeTools.ttftGroup, 'tok-speed');

  // 手动锁定沙漏到最前：即使进入 streaming 仍保持锁定在 ttft
  rootEl.querySelector('#ag-v2-mtb-tool-tok-speed').click(); // 展开二级菜单
  rootEl.querySelector('#ag-v2-mtb-tool-ttft').click(); // 选中并锁定 ttft
  assert.equal(mtb.getState().statusPinMode, 'ttft');
  assert.equal(rootEl.querySelector('#ag-v2-mtb-tool-ttft').getAttribute('data-pinned'), 'true');
  assert.equal(pinChanges.at(-1), 'ttft');

  mtb.render({ scopeKey: 'acct1::s1', phase: 'streaming', ttftElapsedSec: 5, tps: 118 });
  assert.equal(mtb.getState().activeTools.ttftGroup, 'ttft', '手动锁定后流式输出不得覆盖已锁定的沙漏');

  // 再次点击已锁定项 -> 解锁恢复智能自动切换
  mtb.openGroup('ttft-group');
  rootEl.querySelector('#ag-v2-mtb-tool-ttft').click();
  assert.equal(mtb.getState().statusPinMode, 'auto');

  // 槽位 5：CLI 三态配色实时生效
  const cliBtn = rootEl.querySelector('#ag-v2-mtb-slot-cli');
  mtb.render({ scopeKey: 'acct1::s1', cliColorMode: 'mono' });
  assert.equal(cliBtn.getAttribute('data-cli-color-mode'), 'mono');
  mtb.render({ scopeKey: 'acct1::s1', cliColorMode: 'custom', cliCustomColor: '#10b981' });
  assert.equal(cliBtn.getAttribute('data-cli-color-mode'), 'custom');
  assert.equal(cliBtn.style.getPropertyValue('--ag-mtb-cli-custom-color'), '#10b981');

  mtb.destroy();
});

test('设置页与 main.js 接线契约：双模式配置、CLI 图标颜色三选一、跨模块主页事件与零括号三语文案', () => {
  // 1. context-settings-ui.js 新增配置项 HTML 存在且三语字典严格零中英文括号
  assert.match(SETTINGS_UI_SOURCE, /data-ag-ns-seg="cliIconColorMode"/);
  assert.match(SETTINGS_UI_SOURCE, /data-ag-ns-color-pick="cliIcon"/);
  assert.match(SETTINGS_UI_SOURCE, /data-ag-ns-seg="auxCoexistMode"/);

  const extraI18nMatch = SETTINGS_UI_SOURCE.match(/const LOCAL_EXTRA_I18N = Object\.freeze\(([\s\S]*?)\n  \}\);/);
  assert.ok(extraI18nMatch, 'context-settings-ui.js 应内建三语 LOCAL_EXTRA_I18N');
  const sandbox = {};
  vm.runInNewContext(`result = ${extraI18nMatch[1]}\n  }`, sandbox);
  const allStrings = [];
  const walk = (v) => {
    if (typeof v === 'string') allStrings.push(v);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(sandbox.result);
  walk(auxQuickSwitch.AUX_QS_I18N);
  walk(morphIndicatorToolbar.MTB_I18N);
  const parenViolations = allStrings.filter(s => /[()（）]/.test(s));
  assert.deepEqual(parenViolations, [], `发现违规括号文案: ${JSON.stringify(parenViolations)}`);

  // 2. main.js 关键跨模块与并排/保活接线契约
  assert.match(MAIN_SOURCE, /function setAuxCoexistMode\(/);
  assert.match(MAIN_SOURCE, /ag_aux_coexist_mode/);
  assert.match(MAIN_SOURCE, /auxCoexistMode !== 'split'/);
  assert.match(MAIN_SOURCE, /function setCliIconColorMode\(/);
  assert.match(MAIN_SOURCE, /ag_cli_icon_color_mode/);
  assert.match(MAIN_SOURCE, /window\??\.__agContextMeterViews\??\.openProfileHome/);
  assert.match(MAIN_SOURCE, /ag-open-profile-home/);
  assert.match(MAIN_SOURCE, /window\??\.__agContextMeterViews\??\.openContextDetails/);
  assert.match(MAIN_SOURCE, /ag-open-context-details/);
  assert.match(MAIN_SOURCE, /ag-open-accounts-settings/);
  assert.match(MAIN_SOURCE, /triggerLaunchCli\?\.\(\)/);
  assert.equal(/\bauxSessionLocked\b/.test(MAIN_SOURCE), false, 'main.js 不得引用未定义变量 auxSessionLocked');
});
