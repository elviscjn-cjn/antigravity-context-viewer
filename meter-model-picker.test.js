'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');

const core = require('./meter-core');
const { fetchQuotaSnapshotFromHost, getPluginSettings, savePluginSettings } = require('./meter-collector');

function buildRealisticConfigs() {
  return [
    { label: 'Gemini 4 Neon High', modelId: 'MODEL_PLACEHOLDER_M525_HIGH', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M525_HIGH' }, isRecommended: false, quotaInfo: { remainingFraction: 0.78 } },
    { label: 'Gemini 4 Neon Medium', modelId: 'MODEL_PLACEHOLDER_M525_MED', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M525_MED' }, isRecommended: true, quotaInfo: { remainingFraction: 0.78 } },
    { label: 'Gemini 4 Neon Low', modelId: 'MODEL_PLACEHOLDER_M525_LOW', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M525_LOW' }, quotaInfo: { remainingFraction: 0.78 } },
    { label: 'Gemini 4 Argon Medium', modelId: 'MODEL_PLACEHOLDER_M526_MED', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M526_MED' }, isRecommended: true, quotaInfo: { remainingFraction: 0.92 } },
    { label: 'Gemini 4 Argon High', modelId: 'MODEL_PLACEHOLDER_M526_HIGH', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M526_HIGH' }, quotaInfo: { remainingFraction: 0.92 } },
    { label: 'Gemini 4 Hydrogen High', modelId: 'MODEL_PLACEHOLDER_M527_HIGH', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M527_HIGH' }, isRecommended: true, quotaInfo: { remainingFraction: 0.78 } },
    { label: 'Claude Opus 5.5 High', modelId: 'claude-opus-5-5-high', modelOrAlias: { model: 'claude-opus-5-5-high' }, isRecommended: true, quotaInfo: { remainingFraction: 0.65 } },
    { label: 'Claude Opus 5.5 Medium', modelId: 'claude-opus-5-5-medium', modelOrAlias: { model: 'claude-opus-5-5-medium' }, quotaInfo: { remainingFraction: 0.65 } },
    { label: 'GPT-OSS 120B (Medium)', modelId: 'gpt-oss-120b-medium', modelOrAlias: { model: 'gpt-oss-120b-medium' }, quotaInfo: { remainingFraction: 0.65 } },
    { label: 'Gemini 4 Carbon', modelId: 'MODEL_PLACEHOLDER_M530', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M530' }, tagTitle: 'Unavailable', unavailabilityReason: '仅限 Ultra 套餐可用' },
    { label: 'Orchestrator (Neon)', modelId: 'MODEL_ORCH_NEON', modelOrAlias: { model: 'MODEL_ORCH_NEON' }, quotaInfo: { remainingFraction: 0.78 } },
    { label: 'Orchestrator (Argon)', modelId: 'MODEL_ORCH_ARGON', modelOrAlias: { model: 'MODEL_ORCH_ARGON' }, quotaInfo: { remainingFraction: 0.92 } }
  ];
}

function createDomNode(tagName, opts = {}) {
  const attrs = new Map();
  const props = new Map();
  const classes = new Set();
  const listeners = new Map();
  const node = {
    tagName: String(tagName || 'div').toUpperCase(),
    nodeType: 1,
    children: [],
    hidden: false,
    disabled: false,
    focused: false,
    parentElement: null,
    style: {
      display: '',
      opacity: '',
      width: '',
      height: '',
      setProperty(k, v) { props.set(k, v); },
      removeProperty(k) { props.delete(k); },
      getPropertyValue(k) { return props.get(k) || ''; }
    },
    get className() { return Array.from(classes).join(' '); },
    set className(v) {
      classes.clear();
      String(v || '').split(/\s+/).filter(Boolean).forEach(c => classes.add(c));
    },
    classList: {
      add(...cs) { cs.forEach(c => classes.add(c)); },
      remove(...cs) { cs.forEach(c => classes.delete(c)); },
      contains(c) { return classes.has(c); },
      toggle(c, on) {
        if (on === undefined) on = !classes.has(c);
        if (on) classes.add(c); else classes.delete(c);
      }
    },
    _text: '',
    get textContent() {
      if (node._text) return node._text;
      return node.children.map(c => c.textContent || '').join('');
    },
    set textContent(v) { node._text = String(v ?? ''); },
    get id() { return attrs.get('id') || ''; },
    set id(v) { attrs.set('id', String(v)); },
    setAttribute(k, v) {
      attrs.set(k, String(v));
      if (k === 'class') node.className = v;
    },
    getAttribute(k) { return attrs.get(k) ?? null; },
    removeAttribute(k) { attrs.delete(k); },
    hasAttribute(k) { return attrs.has(k); },
    appendChild(child) {
      if (!child) return child;
      child.parentElement = node;
      node.children.push(child);
      return child;
    },
    insertBefore(child, ref) {
      if (!child) return child;
      child.parentElement = node;
      const idx = ref ? node.children.indexOf(ref) : -1;
      if (idx >= 0) node.children.splice(idx, 0, child);
      else node.children.push(child);
      return child;
    },
    after(newNode) {
      if (!node.parentElement || !newNode) return;
      const siblings = node.parentElement.children;
      const idx = siblings.indexOf(node);
      newNode.parentElement = node.parentElement;
      if (idx >= 0) siblings.splice(idx + 1, 0, newNode);
      else siblings.push(newNode);
    },
    get nextSibling() {
      if (!node.parentElement) return null;
      const idx = node.parentElement.children.indexOf(node);
      return idx >= 0 && idx + 1 < node.parentElement.children.length ? node.parentElement.children[idx + 1] : null;
    },
    replaceChildren(...items) {
      node.children = [];
      items.forEach(it => node.appendChild(it));
    },
    remove() {
      if (node.parentElement) {
        const idx = node.parentElement.children.indexOf(node);
        if (idx >= 0) node.parentElement.children.splice(idx, 1);
      }
      node.parentElement = null;
    },
    contains(target) {
      if (target === node) return true;
      for (const ch of node.children) {
        if (ch === target || ch.contains?.(target)) return true;
      }
      return false;
    },
    closest(sel) {
      const parts = String(sel || '').split(',').map(s => s.trim()).filter(Boolean);
      let cur = node;
      while (cur) {
        if (parts.some(p => matchesSelector(cur, p))) return cur;
        cur = cur.parentElement;
      }
      return null;
    },
    querySelectorAll(sel) {
      const out = [];
      const parts = String(sel || '').split(',').map(s => s.trim()).filter(Boolean);
      const walk = (n) => {
        for (const ch of (n.children || [])) {
          if (parts.some(p => matchesSelector(ch, p))) out.push(ch);
          walk(ch);
        }
      };
      walk(node);
      return out;
    },
    querySelector(sel) { return node.querySelectorAll(sel)[0] || null; },
    cloneNode() {
      const cl = createDomNode(node.tagName);
      cl._text = node._text;
      cl.children = node.children.map(ch => ch.cloneNode(true));
      return cl;
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const arr = listeners.get(type);
      if (!arr) return;
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    },
    click() {
      for (const fn of (listeners.get('click') || [])) {
        fn({ target: node, stopPropagation() { }, preventDefault() { } });
      }
    },
    focus() { node.focused = true; },
    getBoundingClientRect() {
      return opts.rect || { left: 100, top: 650, bottom: 676, width: 140, height: 26 };
    },
    get isConnected() {
      let cur = node;
      while (cur.parentElement) cur = cur.parentElement;
      return cur.tagName === 'BODY' || cur.tagName === 'HEAD' || cur.tagName === 'HTML';
    }
  };
  return node;
}

function matchesSelector(node, sel) {
  if (!node || !sel) return false;
  if (sel.startsWith('#')) return node.id === sel.slice(1);
  if (sel.startsWith('.')) {
    const bracketIdx = sel.indexOf('[');
    if (bracketIdx > 0) {
      return node.classList.contains(sel.slice(1, bracketIdx)) && matchesSelector(node, sel.slice(bracketIdx));
    }
    return node.classList.contains(sel.slice(1));
  }
  const mAttr = sel.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);
  if (mAttr) {
    const val = node.getAttribute(mAttr[1]);
    return mAttr[2] !== undefined ? val === mAttr[2] : val !== null;
  }
  const mClsAttr = sel.match(/^\.([^.\[]+)\[([^=\]]+)="([^"]*)"\]$/);
  if (mClsAttr) {
    return node.classList.contains(mClsAttr[1]) && node.getAttribute(mClsAttr[2]) === mClsAttr[3];
  }
  return false;
}

test('Phase 5 backend: groupedModels 去重、clientModelSorts 排序、固定档位只读、宿主回退及 Orchestrator 合一规则', async () => {
  const configs = buildRealisticConfigs();
  const sorts = [
    { name: 'default', groups: [{ modelIds: ['claude-opus-5-5-high', 'MODEL_PLACEHOLDER_M525_HIGH'] }] }
  ];

  const quotaRes = await fetchQuotaSnapshotFromHost({
    userStatus: {
      userStatus: {
        email: 'tester@example.com',
        cascadeModelConfigData: {
          clientModelConfigs: configs,
          clientModelSorts: sorts
        }
      }
    },
    quotaSummary: { groups: [] },
    nowMs: Date.now()
  });
  assert.equal(quotaRes.ok, true);
  assert.ok(quotaRes.groupedModels, 'fetchQuotaSnapshotFromHost 必须返回 groupedModels');
  assert.equal(quotaRes.clientModelSorts.length, 1);

  const menu = quotaRes.groupedModels;
  // 1. 每个基础模型仅出现一次，且按 clientModelSorts 顺序 Claude Opus 5.5 排在最前
  assert.equal(menu.baseModels.filter(m => m.productLabel === 'Gemini 4 Neon').length, 1);
  assert.equal(menu.baseModels[0].productLabel, 'Claude Opus 5.5');
  assert.equal(menu.baseModels[1].productLabel, 'Gemini 4 Neon');

  // 2. 支持档位只列真实成员，GPT-OSS 120B 仅 1 档标记为只读
  const neon = menu.baseModels.find(m => m.productLabel === 'Gemini 4 Neon');
  assert.deepEqual(Array.from(neon.supportedEfforts), ['Low', 'Medium', 'High']);
  assert.equal(neon.isFixedEffort, false);
  const gptOss = menu.baseModels.find(m => m.productLabel === 'GPT-OSS 120B');
  assert.equal(gptOss.isFixedEffort, true);
  assert.equal(gptOss.fixedEffortLabel, 'Medium');
  const carbon = menu.baseModels.find(m => m.productLabel === 'Gemini 4 Carbon');
  assert.equal(carbon.unavailable, true);

  // 3. 切换沿用与回退规则：
  // 3a) Gemini 4 Neon (High) -> Claude Opus 5.5：兼容沿用 High，无回退提示
  const opus = menu.baseModels.find(m => m.productLabel === 'Claude Opus 5.5');
  const resReuse = core.resolveTargetModelAndEffort(menu, opus.productKey, 'High');
  assert.equal(resReuse.ok, true);
  assert.equal(resReuse.effort, 'High');
  assert.equal(resReuse.fallbackApplied, false);
  assert.equal(resReuse.highFallbackWarning, false);

  // 3b) Gemini 4 Neon (Low) -> Gemini 4 Hydrogen (仅支持 High)：回退并标出 highFallbackWarning
  const hydrogen = menu.baseModels.find(m => m.productLabel === 'Gemini 4 Hydrogen');
  const resFallbackHigh = core.resolveTargetModelAndEffort(menu, hydrogen.productKey, 'Low');
  assert.equal(resFallbackHigh.ok, true);
  assert.equal(resFallbackHigh.effort, 'High');
  assert.equal(resFallbackHigh.fallbackApplied, true);
  assert.equal(resFallbackHigh.highFallbackWarning, true);

  // 4. Orchestrator 合成一个入口；宿主未提供独立角色时不虚构 Planner/Executor 分栏也不支持调档位
  assert.equal(menu.orchestrator.hasOrchestrator, true);
  assert.equal(menu.orchestrator.supportsEffortSelection, false);
  assert.equal(menu.orchestrator.supportsIndependentRoles, false);
  assert.equal(menu.orchestrator.presets.length, 2);

  // 5. 当宿主确实暴露 planner / executor 角色时支持独立配置
  const roleMenu = core.buildGroupedModelMenu({
    cascadeModelConfigs: [
      { label: 'Orchestrator (Neon)', modelId: 'orch-planner-neon', orchestratorRole: 'planner' },
      { label: 'Orchestrator (Hydrogen)', modelId: 'orch-exec-hydro', orchestratorRole: 'executor' }
    ]
  });
  assert.equal(roleMenu.orchestrator.supportsIndependentRoles, true);
  assert.equal(roleMenu.orchestrator.planners.length, 1);
  assert.equal(roleMenu.orchestrator.executors.length, 1);

  // 6. 精确菜单行匹配绝不把 Gemini 4 Neon 错匹配到 Orchestrator (Neon)
  assert.equal(core.matchHostMenuOptionText('Orchestrator (Neon)', neon.variants[0], 'Gemini 4 Neon'), false);
  assert.equal(core.matchHostMenuOptionText('Gemini 4 Neon High', neon.variants[0], 'Gemini 4 Neon'), true);
});

test('Phase 5 UI: 移除自定义模型选择器、清理旧版遗留隐藏状态并恢复唯一宿主原生入口', async () => {
  const source = fs.readFileSync(path.join(__dirname, 'meter-renderer.js'), 'utf8');
  const tpl = fs.readFileSync(path.join(__dirname, 'src', 'renderer', 'template.html'), 'utf8');
  const i18nSrc = fs.readFileSync(path.join(__dirname, 'src', 'renderer', 'i18n.js'), 'utf8');

  assert.equal(source.includes('syncModelPickers'), false, '渲染器包中不得再包含 syncModelPickers');
  assert.equal(source.includes('ag-mp-model-menu'), false, '渲染器包中不得再注册自定义模型下拉菜单');
  assert.equal(tpl.includes('chk-simplified-model-picker'), false, '设置模板不得再保留简化模型选择器开关');
  assert.equal(i18nSrc.includes('modelPicker.title'), false, 'i18n 不得保留独占模型选择器词条');
  assert.equal(tpl.includes('chk-next-prompt-enabled'), true, '下一句预测入口必须保持完整');

  const doc = createDomNode('HTML');
  const head = createDomNode('HEAD');
  const body = createDomNode('BODY');
  doc.appendChild(head);
  doc.appendChild(body);

  // 模拟旧版遗留样式与探测 class
  const legacyStyle = createDomNode('STYLE');
  legacyStyle.id = 'ag-model-picker-style';
  head.appendChild(legacyStyle);
  body.classList.add('ag-mp-native-probing');

  function makeComposer(routeId, initialTriggerText) {
    const view = createDomNode('DIV');
    view.setAttribute('data-testid', 'conversation-view');
    view.setAttribute('data-cascade-id', routeId);
    const comp = createDomNode('DIV');
    comp.className = 'surface-composer';
    const trig = createDomNode('BUTTON');
    trig.setAttribute('data-testid', 'model-selector-trigger');
    trig.classList.add('ag-mp-native-hidden');
    trig.textContent = initialTriggerText;
    const legacyWrap = createDomNode('DIV');
    legacyWrap.className = 'ag-mp-wrap';
    legacyWrap.setAttribute('data-ag-model-picker', 'true');
    comp.appendChild(trig);
    comp.appendChild(legacyWrap);
    view.appendChild(comp);
    body.appendChild(view);
    return { view, comp, trig, legacyWrap };
  }
  const mainPane = makeComposer('11111111-1111-1111-1111-111111111111', 'Orchestrator (Neon)');
  const sidePane = makeComposer('22222222-2222-2222-2222-222222222222', 'GPT-OSS 120B (Medium)');
  const legacyPopover = createDomNode('DIV');
  legacyPopover.className = 'ag-mp-popover';
  body.appendChild(legacyPopover);

  const elements = new Map();
  const shadow = {
    innerHTML: '',
    getElementById(id) {
      if (!elements.has(id)) {
        const d = createDomNode('DIV');
        d.id = id;
        elements.set(id, d);
      }
      return elements.get(id);
    },
    querySelectorAll() { return []; }
  };
  const host = createDomNode('DIV');
  host.id = 'ag-context-meter';
  host.attachShadow = () => shadow;

  const docListeners = new Map();
  const storageMap = new Map([['ag_simplified_model_picker', 'true']]);
  const timers = [];

  const sandbox = {
    location: { protocol: 'https:', hostname: '127.0.0.1', pathname: '/c/11111111-1111-1111-1111-111111111111' },
    localStorage: {
      getItem: k => storageMap.get(k) ?? null,
      setItem: (k, v) => storageMap.set(k, String(v)),
      removeItem: (k) => storageMap.delete(k)
    },
    document: {
      head,
      body,
      documentElement: doc,
      hidden: false,
      createElement: (t) => createDomNode(t),
      getElementById: (id) => doc.querySelector(`#${id}`),
      querySelector: (sel) => doc.querySelector(sel),
      querySelectorAll: (sel) => doc.querySelectorAll(sel),
      addEventListener: (type, fn) => {
        if (!docListeners.has(type)) docListeners.set(type, new Set());
        docListeners.get(type).add(fn);
      },
      removeEventListener: (type, fn) => docListeners.get(type)?.delete(fn),
      dispatchEvent: (ev) => {
        for (const fn of (docListeners.get(ev.type) || [])) fn(ev);
      }
    },
    window: {
      innerWidth: 420,
      innerHeight: 720,
      __APP_CONFIG__: { csrfToken: 'test' },
      contextMeterAPI: {
        scan: () => new Promise(() => { }),
        getSettings: async () => ({
          ok: true,
          simplifiedModelPickerEnabled: true,
          uiPreferences: { simplifiedModelPickerEnabled: true }
        }),
        saveSettings: async () => ({ ok: true }),
        getQuota: async () => ({ ok: false })
      }
    },
    __AGContextMeterCore: core,
    AbortController,
    Date,
    setTimeout: (fn) => { fn(); return 1; },
    clearTimeout() { },
    setInterval(cb) { timers.push(cb); return 1; },
    clearInterval() { },
    fetch: () => new Promise(() => { })
  };
  sandbox.document.createElement = ((origFirst) => (tag) => {
    if (origFirst) { origFirst = false; return host; }
    return createDomNode(tag);
  })(true);

  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  const api = sandbox.__AGContextMeter;

  try {
    await new Promise(r => setImmediate(r));
    assert.equal(mainPane.trig.classList.contains('ag-mp-native-hidden'), false, '即使旧配置保存为开启，也必须撤销原生触发器隐藏');
    assert.equal(sidePane.trig.classList.contains('ag-mp-native-hidden'), false);
    assert.equal(head.querySelector('#ag-model-picker-style'), null, '旧版模型选择器样式必须清理');
    assert.equal(body.classList.contains('ag-mp-native-probing'), false, '旧版探测 class 必须清理');
    assert.equal(body.querySelectorAll('.ag-mp-wrap, .ag-mp-popover, [data-ag-model-picker="true"]').length, 0, '旧版自定义菜单节点必须全部移除');
    assert.equal(storageMap.has('ag_simplified_model_picker'), false, '旧版 localStorage 键应被清理');
    assert.equal(mainPane.comp.querySelectorAll('[data-testid="model-selector-trigger"]').length, 1, '每个输入框只保留唯一原生触发器');
    assert.equal(api.getModelPickersStateForTest, undefined, '不再暴露自定义模型选择器状态接口');
  } finally {
    api.dispose();
  }
});
