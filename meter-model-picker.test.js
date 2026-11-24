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
        fn({ target: node, stopPropagation() {}, preventDefault() {} });
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

test('Phase 5 UI: 分屏与 Side Chat 独立挂载、菜单拆分与回退提示、键盘导航与 Esc、窄窗、设置开关与退回原生', async () => {
  const source = fs.readFileSync(path.join(__dirname, 'meter-renderer.js'), 'utf8');
  const doc = createDomNode('HTML');
  const head = createDomNode('HEAD');
  const body = createDomNode('BODY');
  doc.appendChild(head);
  doc.appendChild(body);

  // 构造两个独立会话区（主对话 + Side Chat），各自包含 .surface-composer 和原生 trigger
  function makeComposer(routeId, initialTriggerText) {
    const view = createDomNode('DIV');
    view.setAttribute('data-testid', 'conversation-view');
    view.setAttribute('data-cascade-id', routeId);
    const comp = createDomNode('DIV');
    comp.className = 'surface-composer';
    const trig = createDomNode('BUTTON');
    trig.setAttribute('data-testid', 'model-selector-trigger');
    trig.textContent = initialTriggerText;
    comp.appendChild(trig);
    view.appendChild(comp);
    body.appendChild(view);
    return { view, comp, trig };
  }
  const mainPane = makeComposer('11111111-1111-1111-1111-111111111111', 'Gemini 4 Neon Low');
  const sidePane = makeComposer('22222222-2222-2222-2222-222222222222', 'GPT-OSS 120B (Medium)');

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
  const storageMap = new Map();
  const savedSettings = [];
  const dispatchedSwitches = [];
  const timers = [];

  const sandbox = {
    location: { protocol: 'https:', hostname: '127.0.0.1', pathname: '/c/11111111-1111-1111-1111-111111111111' },
    localStorage: {
      getItem: k => storageMap.get(k) ?? null,
      setItem: (k, v) => storageMap.set(k, String(v))
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
      __agTestModelSelectHook: async ({ route, variant, trigger }) => {
        dispatchedSwitches.push({ route, modelId: variant.modelId, label: variant.label, effort: variant.effort || null });
        trigger.textContent = variant.label;
        return { ok: true };
      },
      contextMeterAPI: {
        scan: () => new Promise(() => {}),
        saveSettings: async (p) => { savedSettings.push(p); return { ok: true }; },
        getQuota: async () => ({ ok: false })
      }
    },
    __AGContextMeterCore: core,
    AbortController,
    Date,
    setTimeout: (fn) => { fn(); return 1; },
    clearTimeout() {},
    setInterval(cb) { timers.push(cb); return 1; },
    clearInterval() {},
    fetch: () => new Promise(() => {})
  };
  sandbox.document.createElement = ((origFirst) => (tag) => {
    if (origFirst) { origFirst = false; return host; }
    return createDomNode(tag);
  })(true);

  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  const api = sandbox.__AGContextMeter;

  try {
    const configs = buildRealisticConfigs();
    api.setQuotaSnapshotForTest({
      accountScopeKey: 'acct_p5',
      fetchedAtMs: Date.now(),
      userStatusRes: {
        userStatus: {
          email: 'tester@example.com',
          cascadeModelConfigData: { clientModelConfigs: configs }
        }
      },
      quotaSummaryRes: { groups: [] }
    });
    api.syncModelPickersForTest();

    const states = api.getModelPickersStateForTest();
    assert.equal(states.length, 2, '主会话与 Side Chat 两个输入框必须各自独立挂载选择器');
    const stMain = states.find(s => s.route.startsWith('11111111'));
    const stSide = states.find(s => s.route.startsWith('22222222'));
    assert.ok(stMain && stSide);
    assert.equal(stMain.modelBtnText, 'Gemini 4 Neon');
    assert.equal(stMain.effortBtnText, 'Low');
    assert.equal(stMain.effortBtnReadOnly, false);
    assert.equal(stSide.modelBtnText, 'GPT-OSS 120B');
    assert.equal(stSide.effortBtnReadOnly, true, '固定档位 GPT-OSS 120B 必须展示为只读');

    // 1. 打开主面板菜单：每个基础模型仅出现 1 次 + Orchestrator 1 入口 + 查看用量
    stMain.modelBtn.click();
    assert.equal(stMain.modelMenuEl.hidden, false);
    const items = stMain.modelMenuEl.querySelectorAll('.ag-mp-item');
    const neonRows = items.filter(i => i.textContent.includes('Gemini 4 Neon'));
    assert.equal(neonRows.length, 1, '基础模型 Gemini 4 Neon 必须在菜单里只出现 1 次');

    // 2. 点击「查看用量」必须复用输入框已有用量入口（当底栏用量入口可见时直接点击；不可见时兜底展开 panel-quota）
    let quotaClicked = 0;
    const csbQuotaEl = shadow.getElementById('csb-group-quota');
    csbQuotaEl.hidden = false;
    csbQuotaEl.addEventListener('click', () => { quotaClicked++; });
    const usageBtn = items.find(i => i.getAttribute('data-item-role') === 'view-usage');
    assert.ok(usageBtn);
    usageBtn.click();
    assert.equal(quotaClicked, 1);

    // 3. 切到仅支持 High 的 Gemini 4 Hydrogen -> 按宿主规则回退 High 并明确显示 highFallbackWarning
    stMain.modelBtn.click();
    const hydroItem = stMain.modelMenuEl.querySelectorAll('.ag-mp-item').find(i => i.textContent.includes('Gemini 4 Hydrogen'));
    hydroItem.click();
    await new Promise(r => setImmediate(r));
    const afterSwitchMain = api.getModelPickersStateForTest().find(s => s.route.startsWith('11111111'));
    assert.equal(afterSwitchMain.modelBtnText, 'Gemini 4 Hydrogen');
    assert.equal(afterSwitchMain.effortBtnText, 'High');
    assert.ok(afterSwitchMain.fallbackNotice?.highWarning, '落到 High 时必须显式提示回退高档结果');
    assert.equal(dispatchedSwitches[0].route, '11111111-1111-1111-1111-111111111111');
    assert.equal(dispatchedSwitches[0].modelId, 'MODEL_PLACEHOLDER_M527_HIGH');

    // 4. 在 Side Chat 输入框验证独立性 & 切入 Orchestrator 预设并隐藏虚假档位控件
    stSide.modelBtn.click();
    const orchEntry = stSide.modelMenuEl.querySelectorAll('.ag-mp-item').find(i => i.getAttribute('data-item-role') === 'orchestrator-entry');
    assert.ok(orchEntry);
    orchEntry.click();
    const orchArgon = stSide.modelMenuEl.querySelectorAll('.ag-mp-item').find(i => i.textContent.includes('Orchestrator (Argon)'));
    assert.ok(orchArgon);
    orchArgon.click();
    await new Promise(r => setImmediate(r));
    const afterOrchSide = api.getModelPickersStateForTest().find(s => s.route.startsWith('22222222'));
    assert.equal(afterOrchSide.isOrchestrator, true);
    assert.equal(afterOrchSide.effortBtnHidden, true, 'Orchestrator 不得展示可调思考档位');
    assert.equal(dispatchedSwitches[1].route, '22222222-2222-2222-2222-222222222222');

    // 5. 键盘导航 + Esc 关闭并归还触发按钮焦点
    afterSwitchMain.modelBtn.click();
    sandbox.document.dispatchEvent({ type: 'keydown', key: 'ArrowDown', preventDefault() {}, stopPropagation() {} });
    sandbox.document.dispatchEvent({ type: 'keydown', key: 'Escape', preventDefault() {}, stopPropagation() {} });
    assert.equal(afterSwitchMain.modelMenuEl.hidden, true);
    assert.equal(afterSwitchMain.modelBtn.focused, true);

    // 6. 关闭开关应安全恢复原生触发器；结构不识别（移出 .surface-composer）也退回原生
    api.setSimplifiedModelPickerEnabledForTest(false);
    assert.equal(mainPane.trig.classList.contains('ag-mp-native-hidden'), false);
    assert.equal(api.getModelPickersStateForTest().length, 0);

    // 7. 后端设置往返持久化
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-mp-settings-'));
    try {
      assert.equal(getPluginSettings({ agDir: tmpDir }).simplifiedModelPickerEnabled, true);
      savePluginSettings({ simplifiedModelPickerEnabled: false }, { agDir: tmpDir });
      assert.equal(getPluginSettings({ agDir: tmpDir }).simplifiedModelPickerEnabled, false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  } finally {
    api.dispose();
  }
});
