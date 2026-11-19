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
    getUnlockStatus: async () => ({ ok: true, status: 'unpatched_official' }),
    getModulesStatus: async () => ({ ok: true, data: { modules: { chinese: { enabled: false, brandTitle: 'english' } } } }),
    toggleModule: async (m, e, o) => ({ ok: true, data: { modules: { chinese: { enabled: e, brandTitle: o?.brandTitle || 'english' } } } })
  };

  const intervals = [];
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
    setTimeout: (fn) => setTimeout(fn, 0),
    clearTimeout: () => {},
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
    getRestartCalled: () => restartCalled
  };
}

test('0.8.3 修复验证 1: 四 Tab 导航布局、平级配置页与 setting 英文统一', async () => {
  const h = createTestHarness();
  const api = h.api;

  // 1. 验证存在 4 个平级 Tab
  const btnSession = h.elements.get('tab-ctx-session');
  const btnModels = h.elements.get('tab-ctx-models');
  const btnSpeed = h.elements.get('tab-ctx-speed');
  const btnSettings = h.elements.get('tab-ctx-settings');
  assert.ok(btnSession && btnModels && btnSpeed && btnSettings, '必须同时存在 4 个平级 Tab');

  // 2. 检查默认简体与繁体名称均为「配置」
  api.setPanelLanguage('zh-CN');
  assert.equal(api.translateForTest('tab.settings'), '配置', '简体中文必须严格显示「配置」');
  api.setPanelLanguage('zh-TW');
  assert.equal(api.translateForTest('tab.settings'), '配置', '繁體中文必须严格显示「配置」，不生造异体词');

  // 3. 检查英文模式下标签严格为「setting」
  api.setPanelLanguage('en');
  assert.equal(api.translateForTest('tab.settings'), 'setting', '英文必须严格显示「setting」');

  // 4. 点击配置 Tab -> 正确切换到配置分页，主导航 tabs bar 保持平级可见
  btnSettings.click();
  const st = api.getContextPreferencesState();
  assert.equal(st.activeContextTab, 'settings', '当前活动 Tab 应为 settings');
  assert.equal(h.elements.get('pane-ctx-settings').hidden, false, '配置页应显示');
  assert.equal(h.elements.get('ctx-tabs-bar').hidden, false, '主导航栏在四 Tab 架构下必须保持平级可见');
  h.api.dispose();
});

test('0.8.3 修复验证 2: 顶部三语言「简｜繁｜EN」分段按钮即时切换与持久化', async () => {
  const h = createTestHarness();
  const api = h.api;

  const btnTopZh = h.elements.get('btn-top-lang-zh-CN');
  const btnTopTw = h.elements.get('btn-top-lang-zh-TW');
  const btnTopEn = h.elements.get('btn-top-lang-en');
  assert.ok(btnTopZh && btnTopTw && btnTopEn, '顶部必须存在三语言独立分段按钮');

  // 1. 点击繁体
  btnTopTw.click();
  assert.equal(api.getPanelLanguage(), 'zh-TW');
  assert.equal(btnTopTw.classList.contains('active'), true);
  assert.equal(btnTopZh.classList.contains('active'), false);
  assert.equal(h.sandbox.localStorage.getItem('ag_panel_language'), 'zh-TW');

  // 2. 点击英文
  btnTopEn.click();
  assert.equal(api.getPanelLanguage(), 'en');
  assert.equal(btnTopEn.classList.contains('active'), true);
  assert.equal(btnTopTw.classList.contains('active'), false);
  assert.equal(h.sandbox.localStorage.getItem('ag_panel_language'), 'en');

  // 3. 点击简体
  btnTopZh.click();
  assert.equal(api.getPanelLanguage(), 'zh-CN');
  assert.equal(btnTopZh.classList.contains('active'), true);
  assert.equal(h.sandbox.localStorage.getItem('ag_panel_language'), 'zh-CN');
  h.api.dispose();
});

test('0.8.3 修复验证 3: 居中统一模态重启弹窗、立即可见、绝不顺带保存草稿', async () => {
  const h = createTestHarness();
  const modal = h.elements.get('global-restart-modal');
  const btnModalCancel = h.elements.get('btn-modal-restart-cancel');
  const btnModalConfirm = h.elements.get('btn-modal-restart-confirm');
  assert.ok(modal && btnModalCancel && btnModalConfirm, '必须具备全局统一模态重启弹窗');

  // 模拟用户在模型设置中有未保存的脏草稿
  h.api.switchContextTabForTest('models');
  let draftSaved = false;
  // 注入监听检测是否有草稿被误保存
  const origSaveSettings = h.sandbox.window.contextMeterAPI.saveSettings;
  h.sandbox.window.contextMeterAPI.saveSettings = async (payload) => {
    if (payload.contextPreferences) draftSaved = true;
    return origSaveSettings(payload);
  };

  // 从下方应用结果框点击重启
  const btnUnlockRestart = h.elements.get('btn-unlock-result-restart');
  btnUnlockRestart.click();

  // 弹窗必须立即可见，无论滚动到哪里
  assert.equal(modal.hidden, false, '模态居中弹窗必须展开且可见');

  // 1. 点击取消 -> 弹窗隐藏，绝不触发重启
  btnModalCancel.click();
  assert.equal(modal.hidden, true, '点击取消后弹窗必须关闭');
  assert.equal(h.getRestartCalled(), false, '取消不得触发重启');
  assert.equal(draftSaved, false, '取消绝不得顺带保存草稿');

  // 2. 再次打开并点击确认重启
  btnUnlockRestart.click();
  assert.equal(modal.hidden, false);
  btnModalConfirm.click();

  // 等待异步调用完成
  await new Promise(r => setTimeout(r, 10));
  assert.equal(h.getRestartCalled(), true, '确认必须触发重启 API');
  assert.equal(draftSaved, false, '重启操作绝不得顺带保存未提交的模型草稿');
  h.api.dispose();
});

test('0.8.3 修复验证 4: 品牌三态逻辑仅针对左上角品牌文字，不修改 document.title', async () => {
  // 导入运行时核心脚本进行单元测试
  const runtimeCode = fs.readFileSync(path.join(__dirname, 'src', 'i18n', 'i18n-runtime.js'), 'utf8');
  const root = {
    setTimeout: (fn) => setTimeout(fn, 0),
    clearTimeout: () => {},
    setInterval: () => 1,
    clearInterval: () => {},
    document: {
      title: 'main.py - Antigravity',
      readyState: 'complete',
      documentElement: { tagName: 'HTML', nodeType: 1 },
      addEventListener() {}
    }
  };
  root.window = root;
  const ctx = vm.createContext(root);
  vm.runInContext(runtimeCode, ctx);

  const formatTitle = root.__AGY_FORMAT_BRAND_TITLE__;
  const applyBrand = root.__AGY_APPLY_BRAND_TEXT__;
  assert.equal(typeof formatTitle, 'function');
  assert.equal(typeof applyBrand, 'function');

  // 模拟桌面客户端左上角品牌节点（通过视口几何坐标或拖拽特征识别，不依赖 VS Code class）
  const mockDesktopClientBrand = {
    tagName: 'SPAN',
    className: 'app-logo-text',
    getBoundingClientRect: () => ({ top: 12, left: 24, width: 90, height: 22 }),
    closest: () => null
  };

  // 1. 测试「隐藏」模式：文字隐藏，但 document.title 绝对保持原样不修改
  root.__AGY_I18N_CONFIG__ = { enabled: true, language: 'zh-CN', brandTitle: 'hidden' };
  assert.equal(formatTitle('app.js - Antigravity'), 'app.js - Antigravity', '不顺带修改 document.title');

  // 模拟顶栏元素
  const mockParentTitlebar = {
    tagName: 'DIV',
    className: 'part titlebar',
    closest: (sel) => sel.includes('.part.titlebar') ? mockParentTitlebar : null
  };
  assert.equal(applyBrand('Antigravity', mockParentTitlebar), '');
  assert.equal(applyBrand('Google Antigravity', mockParentTitlebar), '');
  assert.equal(applyBrand('Antigravity', mockDesktopClientBrand), '', '桌面客户端左上角品牌位必须能被正确隐藏');

  // 模拟正文普通元素（非标题栏，如段落、聊天内容，严防误伤正文）
  const mockParentBody = {
    tagName: 'P',
    className: 'chat-content',
    closest: (sel) => sel.includes('p') ? mockParentBody : null
  };
  assert.equal(applyBrand('Antigravity', mockParentBody), null, '非标题栏正文绝不误伤隐藏');
  assert.equal(applyBrand('Google Antigravity', mockParentBody), null, '非标题栏正文绝不误伤隐藏');

  // 2. 测试「反重力」模式：文字替换，document.title 保持原样
  root.__AGY_I18N_CONFIG__ = { enabled: true, language: 'zh-CN', brandTitle: 'translated' };
  assert.equal(formatTitle('app.js - Antigravity'), 'app.js - Antigravity', '不顺带修改 document.title');
  assert.equal(applyBrand('Antigravity', mockParentTitlebar), '反重力');
  assert.equal(applyBrand('Google Antigravity', mockParentTitlebar), 'Google 反重力');
  assert.equal(applyBrand('Antigravity', mockDesktopClientBrand), '反重力', '桌面客户端左上角品牌位必须能被正确翻译为反重力');
  assert.equal(applyBrand('Antigravity', mockParentBody), null, '非标题栏正文绝不误伤翻译');

  // 3. 测试「保留 Antigravity」模式
  root.__AGY_I18N_CONFIG__ = { enabled: true, language: 'zh-CN', brandTitle: 'english' };
  assert.equal(formatTitle('app.js - Antigravity'), 'app.js - Antigravity');
  assert.equal(applyBrand('Antigravity', mockParentTitlebar), null, 'english 模式下应返回 null 保持原文本');
  assert.equal(applyBrand('Antigravity', mockDesktopClientBrand), null, 'english 模式下桌面客户端左上角应返回 null 保持原文本');
});

test('0.8.3 修复验证 5: 订阅二级菜单英文与繁体无中文残留（正常付费、月付、折合）', async () => {
  const h = createTestHarness();
  const api = h.api;

  // 构造真实订阅 payload（包含中文旧数据）
  const testPlan = {
    tierName: 'Google AI Pro',
    status: 'identified',
    acquisitionSource: 'normal_paid',
    acquisitionSourceName: '正常付费订阅',
    actualPricePaid: 19.99,
    currency: 'USD',
    currencySymbol: '$',
    billingCycle: '月付',
    cnyFormatted: '折合 ≈ ¥134.3 CNY'
  };

  // 1. 切换为英文并注入真实带中文订阅数据
  api.setTokenHistoryForTest({
    summary: { grandTotalTokens: 10000, todayTokens: 1000 },
    planStatus: testPlan
  });
  api.setPanelLanguage('en');

  // 验证来源与周期不残留中文
  const detAcq = h.elements.get('p-det-acq');
  const detPrice = h.elements.get('p-det-price');
  assert.match(detAcq.textContent, /Standard (paid subscription|Paid Plan)/i, '英文下订阅来源必须为英文，绝不显示正常付费订阅');
  assert.match(detPrice.textContent, /Monthly/, '英文下计费周期必须为 Monthly，绝不显示月付');
  assert.doesNotMatch(detPrice.textContent, /CNY|¥/, 'en 下默认 USD 订阅不再展示人民币 CNY');
  assert.equal(/正常付费|月付|折合/.test(detPrice.textContent), false, '英文价格字段内绝无中文残留');

  // 非 USD 订阅在 en 下才附带 approx. $... USD
  api.setTokenHistoryForTest({
    summary: { grandTotalTokens: 10000, todayTokens: 1000 },
    planStatus: { ...testPlan, currency: 'JPY', currencySymbol: '¥', actualPricePaid: 2900, region: '日本 (JPY)', cnyFormatted: '折合 ≈ ¥123.3 CNY' }
  });
  assert.match(detPrice.textContent, /approx\.\s*\$\d+\.\d{2}\s*USD/, 'en 下非 USD 订阅必须附带 approx. $... USD');
  api.setTokenHistoryForTest({
    summary: { grandTotalTokens: 10000, todayTokens: 1000 },
    planStatus: testPlan
  });

  // 2. 切换为繁体
  api.setPanelLanguage('zh-TW');
  assert.match(detAcq.textContent, /正常(官方)?付費訂閱/, '繁体下来源应为规范繁体');
  assert.match(detPrice.textContent, /月付/, '繁体下周期应为月付');
  h.api.dispose();
});

test('0.8.3 修复验证 6: 「回答与工具使用规则」主标题、两层说明与客观证据承诺', async () => {
  const h = createTestHarness();
  const api = h.api;

  // 1. 检查标题多语言
  assert.equal(api.translateForTest('enhance.prompt.title'), '🧠 回答与工具使用规则');
  api.setPanelLanguage('en');
  assert.equal(api.translateForTest('enhance.prompt.title'), '🧠 Response & Tool Usage Rules');
  api.setPanelLanguage('zh-TW');
  assert.equal(api.translateForTest('enhance.prompt.title'), '🧠 回答與工具使用規則');

  // 2. 检查第一层白话说明与两层架构
  api.setPanelLanguage('zh-CN');
  const intro = api.translateForTest('enhance.prompt.plainIntro');
  assert.match(intro, /更重视证据/);
  assert.match(intro, /没读过的文件不猜/);
  assert.match(intro, /不能保证回答永远正确/);

  // 3. 绝无“绝对防止幻觉”“最聪明模型”等绝对化承诺
  assert.equal(/绝对防止幻觉|最聪明模型|全面防护/.test(intro), false);

  // 4. 各档位客观说明与实际底层补丁动作深度一致性核验（绝无文案与行为脱节）
  // Tier 0: 原版还原，无清空无替换
  h.elements.get('enhance-tier-0').click();
  assert.equal(h.elements.get('enhance-tier-clears').textContent, '无');
  assert.equal(h.elements.get('enhance-tier-replaces').textContent, '无');
  assert.match(h.elements.get('enhance-tier-keeps').textContent, /全部官方系统提示词模板/);

  // Tier 1: 实际清空 2 份推销模板，绝不声称替换编码准则
  h.elements.get('enhance-tier-1').click();
  assert.match(h.elements.get('enhance-tier-clears').textContent, /slash_commands\.tmpl.*plugins\.tmpl/);
  assert.equal(/替换编码准则|编码准则/.test(h.elements.get('enhance-tier-replaces').textContent), false, '1档绝无替换编码准则行为');
  assert.match(h.elements.get('enhance-tier-replaces').textContent, /无/);
  assert.match(h.elements.get('enhance-tier-matrix-title').textContent, /仅清空.*推销/);

  // Tier 2: 实际清空 7 份辅助模板，保留 4 份核心模板原版，绝不声称替换推理纪律
  h.elements.get('enhance-tier-2').click();
  assert.match(h.elements.get('enhance-tier-clears').textContent, /7 份辅助指引模板|artifacts/);
  assert.match(h.elements.get('enhance-tier-keeps').textContent, /4 份核心模板.*官方原版未修改/);
  assert.equal(/轻量化推理纪律|推理纪律/.test(h.elements.get('enhance-tier-replaces').textContent), false, '2档绝无替换推理纪律行为');
  assert.match(h.elements.get('enhance-tier-replaces').textContent, /无/);

  // Tier 3: 实际重写 3 份核心行为规则，不能只描述为删减格式要求
  h.elements.get('enhance-tier-3').click();
  assert.match(h.elements.get('enhance-tier-keeps').textContent, /identity\.tmpl.*官方原版身份未修改/);
  assert.match(h.elements.get('enhance-tier-replaces').textContent, /重写 guidelines、function_call、communication_style/);
  assert.match(h.elements.get('enhance-tier-replaces').textContent, /精简工程规范/);

  // Tier 4: 保留 identity 原版未修改，严禁声称修改或极简身份定义；明确重写 3 份规则注入防幻觉护栏
  h.elements.get('enhance-tier-4').click();
  assert.match(h.elements.get('enhance-tier-keeps').textContent, /identity\.tmpl.*官方原版身份未修改/);
  assert.equal(/极简身份|精简身份/.test(h.elements.get('enhance-tier-keeps').textContent), false, '4档严禁声称极简身份');
  assert.equal(/极简系统角色定义/.test(h.elements.get('enhance-tier-matrix-title').textContent), false, '4档描述严禁声称极简角色定义');
  assert.match(h.elements.get('enhance-tier-replaces').textContent, /未读禁猜/);
  assert.match(h.elements.get('enhance-tier-replaces').textContent, /真实工具实测验证/);
  assert.match(h.elements.get('enhance-tier-meaning').textContent, /不升级底层模型智能/);
  assert.match(h.elements.get('enhance-tier-meaning').textContent, /不能保证绝对不犯错/);

  // 5. 校验三语言（zh-CN, zh-TW, en）同步覆盖
  for (const lang of ['zh-CN', 'zh-TW', 'en']) {
    api.setPanelLanguage(lang);
    for (let t = 0; t <= 4; t++) {
      assert.ok(api.translateForTest(`enhance.tier.${t}.short`).length > 0);
      assert.ok(api.translateForTest(`enhance.tier.${t}.desc`).length > 0);
      assert.ok(api.translateForTest(`enhance.tier.${t}.keeps`).length > 0);
      assert.ok(api.translateForTest(`enhance.tier.${t}.clears`).length > 0);
      assert.ok(api.translateForTest(`enhance.tier.${t}.replaces`).length > 0);
      assert.ok(api.translateForTest(`enhance.tier.${t}.meaning`).length > 0);
    }
  }

  h.api.dispose();
});

test('v0.8.3 i18n-runtime 针对 data-testid="title-menu-bar-item" 识别与三态可逆互斥测试', () => {
  const rtCode = fs.readFileSync(path.join(__dirname, 'src', 'i18n', 'i18n-runtime.js'), 'utf8');
  const context = {
    window: {},
    document: { title: 'Antigravity' },
    NodeFilter: { SHOW_TEXT: 4 }
  };
  context.globalThis = context.window;
  context.window.__AGY_I18N_CONFIG__ = { enabled: true, language: 'zh-CN', brandTitle: 'translated' };
  context.window.__AGY_I18N_DATA__ = { exact: {}, patterns: [] };
  vm.createContext(context);
  vm.runInContext(rtCode, context);

  const applyBrand = context.window.__AGY_APPLY_BRAND_TEXT__;
  assert.equal(typeof applyBrand, 'function');

  // 1. 真实节点：button[data-testid="title-menu-bar-item"]
  const brandBtn = {
    tagName: 'BUTTON',
    className: 'agy-button agy-button-sm',
    getAttribute(name) { return name === 'data-testid' ? 'title-menu-bar-item' : null; },
    closest(selector) { return null; },
    getBoundingClientRect() { return { top: 3.5, left: 8, width: 90, height: 28 }; }
  };

  // translated 态：替换为 反重力
  assert.equal(applyBrand('Antigravity', brandBtn), '反重力');

  // hidden 态：返回空字符串
  context.window.__AGY_I18N_CONFIG__.brandTitle = 'hidden';
  assert.equal(applyBrand('Antigravity', brandBtn), '');
  assert.equal(applyBrand('反重力', brandBtn), '');

  // english 态：恢复为 Antigravity（原文本保持不变返回 null，反重力恢复为 Antigravity）
  context.window.__AGY_I18N_CONFIG__.brandTitle = 'english';
  assert.equal(applyBrand('反重力', brandBtn), 'Antigravity');
  assert.equal(applyBrand('Antigravity', brandBtn), null);

  // 2. 严密排除测试：正文容器（如聊天气泡、Markdown、代码块）即使包含 Antigravity 也绝对不替换
  const chatNode = {
    tagName: 'SPAN',
    className: 'message-content',
    getAttribute(name) { return null; },
    closest(selector) {
      if (selector.includes('message') || selector.includes('chat')) return {};
      return null;
    },
    getBoundingClientRect() { return { top: 200, left: 100, width: 200, height: 30 }; }
  };
  assert.equal(applyBrand('Antigravity', chatNode), null);
});

test('v0.8.3 modular-installer 生成 preload 代码包含同步 IPC 获取与广播监听', () => {
  const { generateChinesePreloadCode } = require('./modular-installer');
  const code = generateChinesePreloadCode('{}', '/* runtime */');
  assert.match(code, /context-meter:get-chinese-config-sync/);
  assert.match(code, /context-meter:brand-title-changed/);
});

test('v0.8.3 真实客户端左上角品牌节点三态切换与 DOM 即时生效测试', async () => {
  const h = createTestHarness();

  // 1. 模拟真实环境顶栏共存多个相同 data-testid="title-menu-bar-item" 的菜单按钮
  const hostBrandBtn = h.doc.createElement('button');
  hostBrandBtn.id = 'host-brand-item';
  hostBrandBtn.setAttribute('data-testid', 'title-menu-bar-item');
  hostBrandBtn.className = 'agy-button agy-button-sm';
  hostBrandBtn.textContent = 'Antigravity';
  hostBrandBtn.getBoundingClientRect = () => ({ top: 3.5, left: 8, width: 90, height: 28 });
  h.doc.body.appendChild(hostBrandBtn);

  const hostWorkspaceBtn = h.doc.createElement('button');
  hostWorkspaceBtn.id = 'host-workspace-item';
  hostWorkspaceBtn.setAttribute('data-testid', 'title-menu-bar-item');
  hostWorkspaceBtn.className = 'agy-button agy-button-sm';
  hostWorkspaceBtn.textContent = '工作区';
  hostWorkspaceBtn.getBoundingClientRect = () => ({ top: 3.5, left: 105, width: 60, height: 28 });
  h.doc.body.appendChild(hostWorkspaceBtn);

  const hostViewBtn = h.doc.createElement('button');
  hostViewBtn.id = 'host-view-item';
  hostViewBtn.setAttribute('data-testid', 'title-menu-bar-item');
  hostViewBtn.className = 'agy-button agy-button-sm';
  hostViewBtn.textContent = '视图';
  hostViewBtn.getBoundingClientRect = () => ({ top: 3.5, left: 170, width: 50, height: 28 });
  h.doc.body.appendChild(hostViewBtn);

  const initialDocTitle = h.doc.title;

  let toggledOpts = null;
  let currentMockBrand = 'english';
  h.sandbox.window.contextMeterAPI.toggleModule = async (name, enable, opts) => {
    toggledOpts = opts;
    currentMockBrand = opts.brandTitle;
    return { ok: true, data: { modules: { chinese: { enabled: true, language: 'zh-CN', brandTitle: opts.brandTitle } } } };
  };
  h.sandbox.window.contextMeterAPI.getModulesStatus = async () => ({
    ok: true,
    data: { modules: { chinese: { enabled: true, language: 'zh-CN', brandTitle: currentMockBrand } } }
  });

  // 2. 点击“隐藏”模式：文字隐藏为空，保留菜单入口可用（不设置 display: none），且打上专属身份标记
  const btnHidden = h.elements.get('btn-brand-hidden');
  assert.ok(btnHidden, '应存在隐藏按钮');
  btnHidden.click();
  await new Promise(r => setTimeout(r, 20));

  assert.equal(toggledOpts.brandTitle, 'hidden');
  assert.equal(hostBrandBtn.textContent, '', '隐藏模式文字应清空不显示');
  assert.equal(hostBrandBtn.style.display, '', '隐藏模式必须保留按钮在 DOM 中，不使用 display: none 避免破坏菜单能力');
  assert.equal(hostBrandBtn.getAttribute('data-agy-brand-item'), 'true', '隐藏后必须固化专属身份标记，确保后续能定位恢复');
  assert.equal(hostWorkspaceBtn.textContent, '工作区', '工作区菜单按钮绝不受影响');
  assert.equal(hostViewBtn.textContent, '视图', '视图菜单按钮绝不受影响');
  assert.equal(h.doc.title, initialDocTitle, '不顺带修改 document.title');

  // 3. 点击“反重力”模式：凭借专属标记无损恢复并显示为 反重力
  const btnTranslated = h.elements.get('btn-brand-translated');
  assert.ok(btnTranslated, '应存在反重力按钮');
  btnTranslated.click();
  await new Promise(r => setTimeout(r, 20));

  assert.equal(toggledOpts.brandTitle, 'translated');
  assert.equal(hostBrandBtn.style.display, '');
  assert.equal(hostBrandBtn.textContent, '反重力', '应从隐藏状态精准恢复为「反重力」');
  assert.equal(hostWorkspaceBtn.textContent, '工作区');
  assert.equal(hostViewBtn.textContent, '视图');
  assert.equal(h.doc.title, initialDocTitle);

  // 4. 点击“保留”模式：恢复为 Antigravity
  const btnEnglish = h.elements.get('btn-brand-english');
  assert.ok(btnEnglish, '应存在保留按钮');
  btnEnglish.click();
  await new Promise(r => setTimeout(r, 20));

  assert.equal(toggledOpts.brandTitle, 'english');
  assert.equal(hostBrandBtn.style.display, '');
  assert.equal(hostBrandBtn.textContent, 'Antigravity', '应恢复为「Antigravity」');
  assert.equal(hostWorkspaceBtn.textContent, '工作区');
  assert.equal(hostViewBtn.textContent, '视图');
  assert.equal(h.doc.title, initialDocTitle);

  h.api.dispose();
});

test('设置页动态操作反馈三语支持与面板语言切换即时更新（且不修改宿主语言或品牌）', async () => {
  const h = createTestHarness();
  try {

  const hostBrandBtn = h.doc.createElement('button');
  hostBrandBtn.id = 'host-brand-i18n-test';
  hostBrandBtn.setAttribute('data-testid', 'title-menu-bar-item');
  hostBrandBtn.className = 'agy-button agy-button-sm';
  hostBrandBtn.textContent = 'Antigravity';
  hostBrandBtn.getBoundingClientRect = () => ({ top: 4, left: 8, width: 90, height: 28 });
  h.doc.body.appendChild(hostBrandBtn);

  let toggleCalls = 0;
  let mockBrand = 'english';
  let mockChinese = true;
  let failToggleWith = null;
  let savedPanelLangs = [];

  h.sandbox.window.contextMeterAPI = {
    ...h.sandbox.window.contextMeterAPI,
    saveSettings: async (payload) => {
      if (payload?.panelLanguage) savedPanelLangs.push(payload.panelLanguage);
      return { ok: true };
    },
    getModulesStatus: async () => ({
      ok: true,
      data: { modules: { chinese: { enabled: mockChinese, language: mockChinese ? 'zh-CN' : 'en', brandTitle: mockBrand }, proxy: { enabled: false } } },
      disk: { chinese: true, proxy: true }
    }),
    toggleModule: async (name, enable, opts) => {
      toggleCalls++;
      if (failToggleWith) return { ok: false, error: failToggleWith };
      if (name === 'chinese') {
        mockChinese = Boolean(enable);
        if (opts?.brandTitle) mockBrand = opts.brandTitle;
      }
      return { ok: true, data: { modules: { chinese: { enabled: mockChinese, brandTitle: mockBrand } } } };
    },
    getEnhanceStatus: async () => ({ ok: true, data: { supported: true, summary: { promptTier: 4, chineseTitleEnabled: true } } }),
    applyEnhancePatch: async () => ({ ok: true, needsRestart: true }),
    restoreAllEnhance: async () => ({ ok: true, needsRestart: true }),
    restartLanguageServers: async () => ({ ok: true, killed: 2 }),
    applyContextUnlock: async () => ({ ok: true, needsRestart: true }),
    restoreContextUnlock: async () => ({ ok: false, error: '原版备份不存在' })
  };

  h.elements.get('btn-ctx-settings').click();
  await new Promise(r => setTimeout(r, 25));

  // 1. 简中下切换品牌为「反重力」并验证单句已应用反馈（无重启生效提示）
  h.elements.get('btn-brand-translated').click();
  await new Promise(r => setTimeout(r, 25));
  assert.equal(toggleCalls, 1);
  assert.equal(mockBrand, 'translated');
  assert.equal(mockChinese, true);

  const globalResText = h.elements.get('enhance-global-result-text');
  const brandFeedback = h.elements.get('brand-apply-feedback');
  assert.equal(globalResText.textContent, '已保存并应用：左上角品牌已更新为「反重力」。');
  assert.equal(brandFeedback.style.display, 'block');
  assert.equal(brandFeedback.textContent, '已保存并应用：左上角品牌已更新为「反重力」。');
  assert.equal(h.elements.get('btn-enhance-restart-host').hidden, true);

  // 2. 保持反馈显示，切换面板语言到 EN：只改界面与反馈语言，不调用 toggleModule，不改宿主/品牌
  const callsBeforeEn = toggleCalls;
  h.elements.get('btn-top-lang-en').click();
  await new Promise(r => setTimeout(r, 25));

  assert.equal(toggleCalls, callsBeforeEn, '选择 EN 绝不能修改宿主语言或品牌设置');
  assert.equal(mockBrand, 'translated');
  assert.equal(mockChinese, true);
  assert.equal(globalResText.textContent, 'Header name updated to "反重力" (applied).');
  assert.equal(brandFeedback.textContent, 'Header name updated to "反重力" (applied).');
  assert.doesNotMatch(globalResText.textContent, /Restart|重启|（|）/);

  // 3. 切换到繁中：反馈单语言更新且保留「反重力」设置值
  h.elements.get('btn-top-lang-zh-TW').click();
  await new Promise(r => setTimeout(r, 25));
  assert.equal(toggleCalls, callsBeforeEn);
  assert.equal(globalResText.textContent, '已儲存並套用：左上角品牌已更新為「反重力」。');

  // 4. 在 EN 下测试「Antigravity」与「Hide」热更新结果，及未检测到节点时不假报已应用
  h.elements.get('btn-top-lang-en').click();
  await new Promise(r => setTimeout(r, 25));
  h.elements.get('btn-brand-english').click();
  await new Promise(r => setTimeout(r, 25));
  assert.equal(globalResText.textContent, 'Header name updated to "Antigravity" (applied).');

  h.elements.get('btn-brand-hidden').click();
  await new Promise(r => setTimeout(r, 25));
  assert.equal(globalResText.textContent, 'Header name hidden (applied).');

  // 移除品牌节点模拟运行时未找到目标（不假报已应用）
  hostBrandBtn.setAttribute('data-testid', 'removed');
  hostBrandBtn.removeAttribute('data-agy-brand-item');
  hostBrandBtn.classList.remove('agy-button');
  h.elements.get('btn-brand-translated').click();
  await new Promise(r => setTimeout(r, 25));
  assert.equal(
    globalResText.textContent,
    'Brand setting saved (反重力), but header element was not found in this window (not applied live).'
  );
  assert.match(h.elements.get('enhance-global-result').className, /result-error/);

  // 5. 测试失败提示及切语言重译
  failToggleWith = '写入失败';
  h.elements.get('btn-apply-brand-title').click();
  await new Promise(r => setTimeout(r, 25));
  assert.equal(globalResText.textContent, 'Failed to save brand setting: Write failed');
  h.elements.get('btn-top-lang-zh-CN').click();
  await new Promise(r => setTimeout(r, 25));
  assert.equal(globalResText.textContent, '保存品牌设置失败：写入失败');
  failToggleWith = null;

  // 6. 在 EN 下测试提示词应用、LS 重启、推荐确认栏实时切换与部分失败（含中文错误翻译，不残留中文）
  h.elements.get('btn-top-lang-en').click();
  await new Promise(r => setTimeout(r, 25));
  h.elements.get('btn-enhance-apply-prompt').click();
  await new Promise(r => setTimeout(r, 25));
  assert.match(h.elements.get('enhance-prompt-result-text').textContent, /Prompt & title settings written/);

  h.elements.get('btn-enhance-restart-ls').click();
  await new Promise(r => setTimeout(r, 25));
  assert.match(globalResText.textContent, /Language server signaled to reload \(2 process\(es\) cycled\)/);

  // 确认框弹出后切换语言（mock harness 需显式设置默认勾选态）
  h.elements.get('chk-rec-prompt').checked = true;
  h.elements.get('chk-rec-title').checked = true;
  h.elements.get('btn-enhance-preset-apply').click();
  const confirmText = h.elements.get('enhance-preset-confirm-text');
  assert.match(confirmText.textContent, /About to apply checked items: /);
  h.elements.get('btn-top-lang-zh-CN').click();
  await new Promise(r => setTimeout(r, 25));
  assert.match(confirmText.textContent, /即将执行以下已勾选项：/);

  // 恢复默认触发部分失败，随后切换 EN 验证全部条目与分隔符重译
  h.elements.get('btn-enhance-restore-all').click();
  assert.match(confirmText.textContent, /全部恢复官方默认/);
  h.elements.get('btn-top-lang-en').click();
  await new Promise(r => setTimeout(r, 25));
  assert.match(confirmText.textContent, /"Restore All to Stock" resets these 4 items/);

  h.elements.get('btn-enhance-confirm-go').click();
  await new Promise(r => setTimeout(r, 30));
  assert.match(globalResText.textContent, /Partial completion\. Succeeded: .*; Failed: .*Original backup not found/);
  assert.doesNotMatch(globalResText.textContent, /[\u4e00-\u9fff]/, 'EN 模式下部分失败结果不得残留中文');

  assert.ok(savedPanelLangs.includes('en') && savedPanelLangs.includes('zh-TW'));
  } finally {
    h.api.dispose();
  }
});

test('品牌热更新清理旧 brandObserver，且切换隐藏与还原时不破坏内部 span 子元素与运行时配置同步', async () => {
  const observerEvents = [];
  class MockMutationObserver {
    constructor(cb) {
      this.cb = cb;
      this.connected = false;
    }
    observe(target) {
      this.connected = true;
      this.target = target;
      observerEvents.push({ type: 'observe', target });
    }
    disconnect() {
      this.connected = false;
      observerEvents.push({ type: 'disconnect' });
    }
    trigger() {
      if (this.connected) this.cb([]);
    }
  }

  const h = createTestHarness();
  try {
    h.sandbox.MutationObserver = MockMutationObserver;
    h.sandbox.window.MutationObserver = MockMutationObserver;
    let mockBrand = 'english';
    const scanBrandAtCallTime = [];
    h.sandbox.window.__AGY_I18N_CONFIG__ = { enabled: true, language: 'zh-CN', brandTitle: 'english' };
    h.sandbox.window.__AGY_RUN_FULL_SCAN__ = () => {
      scanBrandAtCallTime.push(h.sandbox.window.__AGY_I18N_CONFIG__.brandTitle);
    };

    const hostBrandBtn = h.doc.createElement('button');
    hostBrandBtn.id = 'host-brand-observer-test';
    hostBrandBtn.className = 'agy-button agy-button-sm';
    hostBrandBtn.setAttribute('data-testid', 'title-menu-bar-item');
    hostBrandBtn.getBoundingClientRect = () => ({ top: 4, left: 8, width: 90, height: 28 });
    const origDocQs = h.doc.querySelector.bind(h.doc);
    h.doc.querySelector = (sel) => {
      if (sel.includes('data-agy-brand-item') && hostBrandBtn.getAttribute('data-agy-brand-item') === 'true') {
        return hostBrandBtn;
      }
      return origDocQs(sel);
    };
    const innerSpan = h.doc.createElement('span');
    innerSpan.nodeType = 1;
    const innerTextNode = { nodeType: 3, nodeValue: 'Antigravity', parentElement: innerSpan, parentNode: innerSpan };
    Object.defineProperty(innerSpan, 'childNodes', { get: () => [innerTextNode] });
    Object.defineProperty(innerSpan, 'textContent', {
      get: () => innerTextNode.nodeValue,
      set: (v) => { innerTextNode.nodeValue = String(v ?? ''); }
    });
    Object.defineProperty(hostBrandBtn, 'textContent', {
      get: () => (hostBrandBtn.children.includes(innerSpan) ? innerSpan.textContent : ''),
      set: (v) => { innerTextNode.nodeValue = String(v ?? ''); }
    });
    hostBrandBtn.appendChild(innerSpan);
    h.doc.body.appendChild(hostBrandBtn);

    h.sandbox.window.contextMeterAPI = {
      ...h.sandbox.window.contextMeterAPI,
      getModulesStatus: async () => ({
        ok: true,
        data: { modules: { chinese: { enabled: true, language: 'zh-CN', brandTitle: mockBrand }, proxy: { enabled: false } } },
        disk: { chinese: true, proxy: true }
      }),
      toggleModule: async (_name, _enable, opts) => {
        if (opts?.brandTitle) mockBrand = opts.brandTitle;
        return { ok: true, data: { modules: { chinese: { enabled: true, brandTitle: mockBrand } } } };
      }
    };

    h.elements.get('btn-ctx-settings').click();
    await new Promise(r => setTimeout(r, 25));

    // 1. 切换为反重力：内层 <span> 保留，全局 __AGContextMeterBrandObserver 绑定，__AGY_I18N_CONFIG__ 同步
    h.elements.get('btn-brand-translated').click();
    await new Promise(r => setTimeout(r, 25));
    assert.equal(innerSpan.parentNode === hostBrandBtn, true, '不得破坏 React 内层 <span> 子节点');
    assert.equal(innerSpan.textContent, '反重力');
    assert.equal(h.sandbox.window.__AGY_I18N_CONFIG__.brandTitle, 'translated');
    assert.equal(scanBrandAtCallTime.at(-1), 'translated');
    const obsTranslated = h.sandbox.globalThis.__AGContextMeterBrandObserver;
    assert.ok(obsTranslated && obsTranslated.connected === true);

    // 2. 切换为隐藏：自动先断开上一个观察者再切换文本节点为 ""
    h.elements.get('btn-brand-hidden').click();
    await new Promise(r => setTimeout(r, 25));
    assert.equal(innerSpan.parentNode === hostBrandBtn, true);
    assert.equal(innerSpan.textContent, '');
    assert.equal(h.sandbox.window.__AGY_I18N_CONFIG__.brandTitle, 'hidden');
    assert.equal(obsTranslated.connected, false, '切换品牌模式时必须断开上一个 brandObserver');
    const obsHidden = h.sandbox.globalThis.__AGContextMeterBrandObserver;
    assert.ok(obsHidden && obsHidden.connected === true && obsHidden !== obsTranslated);

    // 模拟外部误改文字后触发 observer：先断后连且安全还原为 ""，触发多次也不会遗留未保护死循环
    innerSpan.textContent = 'Antigravity';
    obsHidden.trigger();
    assert.equal(innerSpan.textContent, '');
    assert.equal(obsHidden.connected, true);

    // 触发超过 8 次高频互搏后自动熔断断开
    for (let i = 0; i < 10; i++) {
      innerSpan.textContent = 'Antigravity';
      obsHidden.trigger();
    }
    assert.equal(obsHidden.connected, false, '高频冲突互搏时应自动熔断停止监听');

    // 3. 切回 Antigravity：observer 断开且文字恢复
    h.elements.get('btn-brand-english').click();
    await new Promise(r => setTimeout(r, 25));
    assert.equal(innerSpan.parentNode === hostBrandBtn, true);
    assert.equal(innerSpan.textContent, 'Antigravity');
    assert.equal(h.sandbox.globalThis.__AGContextMeterBrandObserver, null);

    // 4. 再设为 translated 后调用 dispose()，必须彻底断开 brandObserver
    h.elements.get('btn-brand-translated').click();
    await new Promise(r => setTimeout(r, 25));
    const activeBeforeDispose = h.sandbox.globalThis.__AGContextMeterBrandObserver;
    assert.ok(activeBeforeDispose && activeBeforeDispose.connected === true);
    h.api.dispose();
    assert.equal(activeBeforeDispose.connected, false, 'dispose() 必须断开残留的 brandObserver');
    assert.equal(h.sandbox.globalThis.__AGContextMeterBrandObserver, null);
  } finally {
    try { h.api.dispose(); } catch { }
  }
});

test('设置页后端错误与动态反馈在 EN / zh-TW / zh-CN 下严格单语显示且切换语言即时更新', async () => {
  const h = createTestHarness();
  try {
    const asarErr = '当前客户端磁盘 ASAR 未注入汉化组件（或组件不完整）。由于客户端正在运行受系统文件保护，请完全退出 Antigravity 客户端后，在安装包目录运行 install.bat 完成注入。';
    let mockNextError = asarErr;
    h.sandbox.window.contextMeterAPI = {
      ...h.sandbox.window.contextMeterAPI,
      getModulesStatus: async () => ({
        ok: true,
        data: { modules: { chinese: { enabled: true, language: 'zh-CN', brandTitle: 'translated' }, proxy: { enabled: false } } },
        disk: { chinese: true, chineseReady: true, proxy: true, proxyReady: true }
      }),
      toggleModule: async () => ({
        ok: false,
        status: 'install_failed',
        error: mockNextError
      })
    };

    // 切换面板语言为 EN 并打开设置页
    h.elements.get('btn-top-lang-en').click();
    h.elements.get('btn-ctx-settings').click();
    await new Promise(r => setTimeout(r, 25));

    // 触发品牌切换失败反馈
    h.elements.get('btn-brand-english').click();
    await new Promise(r => setTimeout(r, 25));

    const brandFb = h.elements.get('brand-apply-feedback');
    const globalFbText = h.elements.get('enhance-global-result-text');
    assert.match(brandFb.textContent, /^Failed to save brand setting: Localization module is missing/);
    assert.equal(/[\u4e00-\u9fa5]/.test(brandFb.textContent), false, 'EN 反馈不得残留任何中文字符');
    assert.equal(globalFbText.textContent, brandFb.textContent);

    // 不重新触发请求，直接切换面板语言 zh-TW -> zh-CN -> en，已显示反馈立即重译
    h.elements.get('btn-top-lang-zh-TW').click();
    await new Promise(r => setTimeout(r, 10));
    assert.match(brandFb.textContent, /^儲存品牌設定失敗：目前用戶端磁碟 ASAR 尚未注入漢化元件/);

    h.elements.get('btn-top-lang-zh-CN').click();
    await new Promise(r => setTimeout(r, 10));
    assert.match(brandFb.textContent, /^保存品牌设置失败：当前客户端磁盘 ASAR 未注入汉化组件/);

    // 再切回 EN，验证未收录未知中文报错也不发生英文主句+中文后缀混拼
    mockNextError = '尚未记录的新增后端错误说明';
    h.elements.get('btn-top-lang-en').click();
    h.elements.get('btn-brand-hidden').click();
    await new Promise(r => setTimeout(r, 25));
    assert.equal(/[\u4e00-\u9fa5]/.test(brandFb.textContent), false, 'EN 下未知中文错误不得直接拼接原文');
    assert.match(brandFb.textContent, /^Failed to save brand setting: Backend operation failed/);
  } finally {
    try { h.api.dispose(); } catch { }
  }
});

test('PR #11/#12 沙箱 preload 汉化门禁必须 fail-closed，且同步 IPC 须校验本地主窗口来源', () => {
  const vm = require('vm');
  const { generateChinesePreloadCode } = require('./modular-installer');
  const { registerMeterIpcHandlers } = require('./meter-main');

  const markerRuntime = 'window.__AGY_I18N_BOOTED__ = true;';
  const code = generateChinesePreloadCode('{"exact":{"Save":"保存"}}', markerRuntime);
  assert.ok(code.includes('chinese.enabled === false'), '仍需保留旧门禁关键字以通过静态检测');
  assert.ok(code.includes('modules.json'), '仍需保留 modules.json 关键字以通过静态检测');

  const runSandboxPreload = (electronMock) => {
    const sandbox = {
      window: {},
      globalThis: {},
      console: { warn: () => {} },
      process: { platform: 'win32', env: {} },
      electron_1: electronMock,
      require: () => { throw new Error('sandbox: fs disabled'); }
    };
    sandbox.globalThis = sandbox.window;
    vm.runInNewContext(code, sandbox);
    return sandbox.window;
  };

  // 1. 沙箱无 fs 且无 IPC（或 resolved=false）时：默认 fail-closed，绝不强制启动汉化
  const winNoIpc = runSandboxPreload(undefined);
  assert.equal(winNoIpc.__AGY_I18N_BOOTED__, undefined);

  const winUnresolved = runSandboxPreload({
    ipcRenderer: { sendSync: () => ({ enabled: false, language: 'en', brandTitle: 'english', resolved: false }), on: () => {} }
  });
  assert.equal(winUnresolved.__AGY_I18N_BOOTED__, undefined);

  // 2. 明确关闭（enabled=false 且 brandTitle=english）时：不启动汉化
  const winDisabled = runSandboxPreload({
    ipcRenderer: { sendSync: () => ({ enabled: false, language: 'en', brandTitle: 'english', resolved: true }), on: () => {} }
  });
  assert.equal(winDisabled.__AGY_I18N_BOOTED__, undefined);

  // 3. IPC 返回已开启时：沙箱环境下允许启动，并绑定品牌切换监听
  const winEnabled = runSandboxPreload({
    ipcRenderer: { sendSync: () => ({ enabled: true, language: 'zh-CN', brandTitle: 'english', resolved: true }), on: () => {} }
  });
  assert.equal(winEnabled.__AGY_I18N_BOOTED__, true);
  assert.equal(winEnabled.__AGY_I18N_CONFIG__.language, 'zh-CN');

  // 4. meter-main.js 中的同步配置通道必须拒绝非本地主窗口请求
  const syncHandlers = {};
  const mockIpcMain = {
    handle: () => {},
    on: (ch, fn) => { syncHandlers[ch] = fn; }
  };
  registerMeterIpcHandlers(mockIpcMain, {});
  const syncHandler = syncHandlers['context-meter:get-chinese-config-sync'];
  assert.equal(typeof syncHandler, 'function');

  const remoteEvent = {
    senderFrame: { url: 'https://evil.example.com/chat.html' },
    sender: { mainFrame: { url: 'https://evil.example.com/chat.html' } },
    returnValue: null
  };
  syncHandler(remoteEvent);
  assert.equal(remoteEvent.returnValue.enabled, false);
  assert.equal(remoteEvent.returnValue.resolved, false);
});

test('PR #11/#12 禁用汉化但开启品牌翻译时，translateElement 不翻译属性和复合文本', () => {
  const vm = require('vm');
  const runtimeSrc = require('fs').readFileSync(require('path').join(__dirname, 'i18n', 'i18n-runtime.js'), 'utf8');
  const sandbox = {
    window: {
      __AGY_I18N_CONFIG__: { enabled: false, language: 'en', brandTitle: 'translated' },
      __AGY_I18N_DATA__: { exact: { Save: '保存', Settings: '设置', 'Save draft': '保存草稿' } }
    },
    globalThis: null,
    console: { warn: () => {}, error: () => {} },
    setTimeout,
    clearTimeout
  };
  sandbox.globalThis = sandbox.window;
  vm.runInNewContext(runtimeSrc, sandbox);
  const scanEl = sandbox.window.__AGY_TRANSLATE_ELEMENT__;
  if (typeof scanEl === 'function') {
    const attrs = { placeholder: 'Save', title: 'Settings' };
    const textChild = { nodeType: 3, nodeValue: 'Save', parentNode: null };
    const fakeEl = {
      nodeType: 1,
      tagName: 'DIV',
      getAttribute: (k) => attrs[k] || null,
      hasAttribute: (k) => Object.prototype.hasOwnProperty.call(attrs, k),
      setAttribute: (k, v) => { attrs[k] = v; },
      firstChild: textChild,
      closest: () => null
    };
    textChild.parentNode = fakeEl;
    scanEl(fakeEl, 1);
    assert.equal(attrs.placeholder, 'Save');
    assert.equal(textChild.nodeValue, 'Save');
  }
});

test('Mac / 非支持平台 (#23) 明确显示不支持而非未读取，并自动取消勾选且禁用推荐预设', async () => {
  const h = createTestHarness();
  try {
    h.sandbox.window.contextMeterAPI.getEnhanceStatus = async () => ({
      ok: true,
      data: { supported: false, platform: 'darwin', arch: 'arm64' }
    });
    h.sandbox.window.contextMeterAPI.getContextUnlockStatus = async () => ({
      ok: true,
      data: { status: 'unsupported', isPlatformSupported: false, arch: 'arm64' }
    });

    const pChk = h.elements.get('chk-rec-prompt');
    const tChk = h.elements.get('chk-rec-title');
    const cChk = h.elements.get('chk-rec-ctx');
    pChk.checked = true;
    tChk.checked = true;
    cChk.checked = true;

    h.elements.get('btn-ctx-settings').click();
    await new Promise(r => setTimeout(r, 35));

    assert.equal(h.elements.get('enhance-global-badge').textContent, '当前平台不支持');
    assert.equal(h.elements.get('enhance-prompt-badge').textContent, '当前平台不支持');
    assert.equal(h.elements.get('enhance-stat-prompt').textContent, '当前平台不支持');
    assert.equal(h.elements.get('btn-enhance-apply-prompt').disabled, true);
    assert.equal(h.elements.get('chk-enhance-chinese-title').disabled, true);
    assert.equal(pChk.checked, false);
    assert.equal(pChk.disabled, true);
    assert.equal(tChk.checked, false);
    assert.equal(tChk.disabled, true);
    assert.equal(cChk.checked, false);
    assert.equal(cChk.disabled, true);
  } finally {
    h.api.dispose();
  }
});

test('异步刷新竞态不覆盖草稿、立即忙态反馈 (<100ms)、提交/结果严格一致与幂等/失败恢复', async () => {
  const h = createTestHarness();
  try {
    let resolveDelayedStatus = null;
    let statusCalls = 0;
    let resolveApply = null;
    let applyPayloads = [];

    h.sandbox.window.contextMeterAPI.getEnhanceStatus = () => {
      statusCalls++;
      if (statusCalls === 1) {
        return new Promise((resolve) => {
          resolveDelayedStatus = () => resolve({
            ok: true,
            data: { supported: true, summary: { promptTier: 1, chineseTitleEnabled: false, chineseTitleMode: 'en', syncState: 'applied_saved' } }
          });
        });
      }
      return Promise.resolve({
        ok: true,
        data: { supported: true, summary: { promptTier: 4, chineseTitleEnabled: true, chineseTitleMode: 'zh', syncState: 'applied_saved' } }
      });
    };

    h.sandbox.window.contextMeterAPI.applyEnhancePatch = (payload) => {
      applyPayloads.push(payload);
      return new Promise((resolve) => { resolveApply = resolve; });
    };

    // 1. 触发迟到的旧状态刷新，在它回包之前用户点选 Tier 4 并勾选中文标题
    const pendingRefresh = h.api.refreshEnhanceStatusForTest();
    h.elements.get('enhance-tier-4').click();
    const titleChk = h.elements.get('chk-enhance-chinese-title');
    titleChk.checked = true;
    titleChk.trigger('change', { target: titleChk });

    resolveDelayedStatus();
    await pendingRefresh;

    // 异步回包绝不能把用户的 Tier 4 和勾选状态冲成 1 / false
    assert.equal(h.api.getEnhanceStateForTest().selectedEnhanceTier, 4);
    assert.equal(h.elements.get('chk-enhance-chinese-title').checked, true);

    // 切语言也不能冲掉草稿
    h.elements.get('btn-top-lang-en').click();
    await new Promise(r => setTimeout(r, 25));
    assert.equal(h.api.getEnhanceStateForTest().selectedEnhanceTier, 4);
    assert.equal(h.elements.get('chk-enhance-chinese-title').checked, true);
    h.elements.get('btn-top-lang-zh-CN').click();
    await new Promise(r => setTimeout(r, 25));

    // 2. 点击应用按钮：同步立即可见忙态且禁重入，yield 后才发出 IPC，防止卡顿假死
    const applyBtn = h.elements.get('btn-enhance-apply-prompt');
    const t0 = Date.now();
    applyBtn.click();
    assert.equal(applyBtn.disabled, true);
    assert.equal(applyBtn.textContent, '正在写入提示词…');
    assert.equal(h.elements.get('enhance-prompt-result').style.display, 'block');
    assert.equal(h.elements.get('enhance-prompt-result-text').textContent, '正在写入提示词…');
    assert.ok(Date.now() - t0 < 100);

    // 等待 yield 后真实发出请求，并验证防重复点击
    await new Promise(r => setTimeout(r, 25));
    assert.equal(applyPayloads.length, 1);
    applyBtn.click();
    assert.equal(applyPayloads.length, 1, '忙态期间重复点击必须被防重入拦截');

    // 3. 后端返回失败后，控件必须恢复可操作
    resolveApply({ ok: false, error: '目标文件被锁定' });
    await new Promise(r => setTimeout(r, 25));
    assert.equal(applyBtn.disabled, false);
    assert.match(h.elements.get('enhance-prompt-result-text').textContent, /目标文件被锁定/);

    // 4. 再次点击应用成功：结果文案严格反映真实写入（中文标题：已开启），不再矛盾报「原版英文」
    h.sandbox.window.contextMeterAPI.applyEnhancePatch = async (payload) => {
      applyPayloads.push(payload);
      return {
        ok: true,
        changed: true,
        needsRestart: true,
        appliedPromptTier: 4,
        appliedChineseTitleEnabled: true,
        status: {
          supported: true,
          summary: {
            promptTier: 4,
            chineseTitleEnabled: true,
            chineseTitleMode: 'zh',
            pendingLsRestart: true,
            syncState: 'pending_ls_restart'
          }
        }
      };
    };
    applyBtn.click();
    await new Promise(r => setTimeout(r, 30));
    assert.equal(applyPayloads[1].promptTier, 4);
    assert.equal(applyPayloads[1].chineseTitle, true);
    assert.match(h.elements.get('enhance-prompt-result-text').textContent, /中文标题：已写入磁盘/);
    assert.equal(h.elements.get('enhance-stat-title').textContent, '已写入磁盘（待重新加载）');

    // 5. 幂等重应用（changed: false, needsRestart: false）：提示无需重复写入且不提示重启语言服务
    h.sandbox.window.contextMeterAPI.applyEnhancePatch = async () => ({
      ok: true,
      changed: false,
      needsRestart: false,
      appliedPromptTier: 4,
      appliedChineseTitleEnabled: true,
      status: {
        supported: true,
        summary: { promptTier: 4, chineseTitleEnabled: true, chineseTitleMode: 'zh', pendingLsRestart: false, syncState: 'runtime_confirmed' }
      }
    });
    applyBtn.click();
    await new Promise(r => setTimeout(r, 30));
    assert.match(h.elements.get('enhance-prompt-result-text').textContent, /已是目标状态/);
    assert.equal(h.elements.get('btn-enhance-restart-ls').hidden, true);
    assert.equal(h.elements.get('enhance-global-badge').textContent, '已写入 · 进程已重载');
  } finally {
    h.api.dispose();
  }
});

test('免 TUN 前端生命周期：输入保留不冲掉、区分待重启/运行中已生效，及 Live HTTP 测试降级', async () => {
  const h = createTestHarness();
  try {
    let toggleArgs = [];
    let fetchCalls = [];
    h.sandbox.window.contextMeterAPI.getModulesStatus = async () => ({
      ok: true,
      data: {
        modules: {
          chinese: { enabled: false, brandTitle: 'english' },
          proxy: { enabled: true, proxyUrl: 'http://127.0.0.1:7897', bypassList: 'localhost,127.0.0.1' }
        }
      },
      disk: { chinese: true, proxy: true },
      runtime: { proxyActive: false, runtimeProxyUrl: null, proxyNeedsRestart: true }
    });
    h.sandbox.window.contextMeterAPI.toggleModule = async (name, enable, opts) => {
      toggleArgs.push({ name, enable, opts });
      return {
        ok: true,
        status: 'config_toggled',
        data: { modules: { chinese: { enabled: false }, proxy: { enabled: enable, proxyUrl: opts.proxyUrl || 'http://127.0.0.1:7897' } } },
        disk: { chinese: true, proxy: true },
        runtime: { proxyActive: false, proxyNeedsRestart: Boolean(enable) },
        restartRequired: Boolean(enable)
      };
    };

    h.elements.get('btn-toggle-proxy').click();
    await new Promise(r => setTimeout(r, 25));

    // 配置开启但启动时未激活 -> 明确展示待重启生效
    assert.equal(h.elements.get('proxy-badge').textContent, '⏳ 已配置 · 待重启生效');
    const urlInput = h.elements.get('input-proxy-url');
    urlInput.value = 'http://127.0.0.1:17890';
    urlInput.trigger('input');

    // 未保存前后台刷新不得覆盖用户输入，且保存配置按钮自动显示
    h.elements.get('btn-toggle-chinese').click();
    await new Promise(r => setTimeout(r, 25));
    assert.equal(urlInput.value, 'http://127.0.0.1:17890');
    assert.equal(h.elements.get('btn-save-proxy-config').hidden, false);

    // 点击保存代理地址按钮直接保存新端口并维持开启态
    h.elements.get('btn-save-proxy-config').click();
    await new Promise(r => setTimeout(r, 25));
    assert.equal(toggleArgs[0].name, 'proxy');
    assert.equal(toggleArgs[0].enable, true);
    assert.equal(toggleArgs[0].opts.proxyUrl, 'http://127.0.0.1:17890');

    // 验证 Live HTTP 模式无 contextMeterAPI.testProxy 时 fallback 到 /test-proxy
    delete h.sandbox.window.contextMeterAPI.testProxy;
    h.sandbox.window.__AGContextMeterLive = { port: 45678, token: 'live-secret' };
    h.sandbox.fetch = async (url, init) => {
      fetchCalls.push({ url, init });
      return {
        ok: true,
        json: async () => ({
          ok: true,
          data: { configValid: true, proxyReachable: true, internetReachable: true, modelCallVerified: false }
        })
      };
    };
    h.elements.get('btn-test-proxy').click();
    await new Promise(r => setTimeout(r, 30));
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].url, 'http://127.0.0.1:45678/test-proxy');
  } finally {
    h.api.dispose();
  }
});

test('冷启动与连续5次会话切换性能隔离：切路由不强刷全量历史、加载中可开关面板且不泄露旧会话数值', async () => {
  const historyCalls = [];
  const pendingHistory = [];
  const pendingScans = [];
  const pendingFetches = [];
  const listeners = new Map();
  const elements = new Map();
  const docElements = new Map();

  const makeEl = (tag = 'div') => {
    const attrs = new Map();
    const children = [];
    const el = {
      tagName: tag.toUpperCase(),
      style: { display: '', opacity: '', cssText: '', setProperty() {}, removeProperty() {}, getPropertyValue() { return ''; } },
      children,
      hidden: false,
      textContent: '',
      innerHTML: '',
      disabled: false,
      get id() { return attrs.get('id') || ''; },
      set id(v) { attrs.set('id', String(v)); if (v) docElements.set(String(v), el); },
      get childNodes() { return this.children; },
      classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} },
      setAttribute(k, v) { attrs.set(k, String(v)); if (k === 'id') docElements.set(String(v), el); },
      getAttribute(k) { return attrs.get(k) ?? null; },
      removeAttribute(k) { attrs.delete(k); },
      addEventListener(type, fn) { if (!listeners.has(el)) listeners.set(el, new Map()); listeners.get(el).set(type, fn); },
      removeEventListener() {},
      appendChild(c) { children.push(c); return c; },
      replaceChildren() { this.children = []; },
      querySelector() { return null; },
      querySelectorAll() { return []; },
      click() { listeners.get(el)?.get('click')?.({ preventDefault() {}, stopPropagation() {} }); },
      getBoundingClientRect() { return { top: 8, left: 600, right: 680, bottom: 32, width: 80, height: 24 }; }
    };
    return el;
  };

  const shadow = {
    innerHTML: '',
    getElementById(id) {
      if (!elements.has(id)) {
        const el = makeEl('div');
        el.id = id;
        if (id.startsWith('panel-')) el.hidden = true;
        elements.set(id, el);
      }
      return elements.get(id);
    },
    querySelector(sel) { return sel.startsWith('#') ? this.getElementById(sel.slice(1)) : null; },
    querySelectorAll() { return []; }
  };

  const hostEl = makeEl('div');
  hostEl.remove = () => {};
  hostEl.attachShadow = () => shadow;
  const intervals = [];
  const doc = {
    getElementById: id => docElements.get(id) || shadow.getElementById(id),
    querySelector: sel => sel.startsWith('#') ? doc.getElementById(sel.slice(1)) : null,
    querySelectorAll: () => [],
    createElement: (() => { let first = true; return tag => { if (first) { first = false; return hostEl; } return makeEl(tag); }; })(),
    body: makeEl('body'),
    documentElement: makeEl('html'),
    addEventListener() {},
    removeEventListener() {},
    hidden: false
  };
  const sandbox = {
    console, Date, Math, String, Number, Boolean, Array, Object, RegExp, JSON, AbortController,
    location: { protocol: 'https:', hostname: '127.0.0.1', pathname: '/c/11111111-1111-1111-1111-111111111111' },
    document: doc,
    window: {
      __APP_CONFIG__: { csrfToken: 'test-csrf' },
      location: { protocol: 'https:', hostname: '127.0.0.1', pathname: '/c/11111111-1111-1111-1111-111111111111' },
      document: doc,
      innerWidth: 1280,
      innerHeight: 800,
      addEventListener() {},
      removeEventListener() {},
      contextMeterAPI: {
        getSettings: async () => ({ ok: true, data: {} }),
        getTokenHistory: force => new Promise(resolve => {
          historyCalls.push(Boolean(force));
          pendingHistory.push(resolve);
        }),
        getQuota: () => new Promise(() => {}),
        scan: id => new Promise(resolve => pendingScans.push({ id, resolve }))
      }
    },
    __AGContextMeterCore: core,
    setTimeout: (fn) => setTimeout(fn, 0),
    clearTimeout() {},
    setInterval(fn) { intervals.push(fn); return intervals.length; },
    clearInterval() {},
    fetch(url, opts) { return new Promise(resolve => pendingFetches.push({ url, opts, resolve })); }
  };
  sandbox.window.window = sandbox.window;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);

  const api = sandbox.__AGContextMeter;
  try {
    // 1. 数据未就绪时：初始触发一次非强制 getTokenHistory(false)，同时顶栏面板立即可打开关闭
    assert.equal(historyCalls.length, 1);
    assert.equal(historyCalls[0], false, '冷启动历史采集必须使用非强制 force=false');
    const initialPercentText = elements.get('percent').textContent;
    const initialAmountText = elements.get('amount').textContent;
    assert.match(initialAmountText, /真实量未知/);

    elements.get('badge').click();
    assert.equal(elements.get('panel').hidden, false, '历史与扫描未返回时上下文面板仍须立即打开');
    elements.get('badge').click();
    assert.equal(elements.get('panel').hidden, true, '上下文面板须可立即关闭');

    elements.get('badge-quota').click();
    assert.equal(elements.get('panel-quota').hidden, false, '额度未就绪时额度面板仍须立即打开');
    elements.get('badge-quota').click();

    // 解决初始历史数据
    pendingHistory[0]({
      ok: true,
      data: {
        updatedAt: '2026-11-16 04:00:00',
        summary: { grandTotalTokens: 123456, todayTokens: 5000, monthTokens: 50000, yearTokens: 123456 },
        dailyMap: { '2026-11-16': { total: 5000, input: 4000, cache: 500, output: 500, steps: 2 } }
      }
    });
    await new Promise(r => setTimeout(r, 15));

    // 先让会话 1111 拿到有效数据
    pendingFetches[0].resolve({
      ok: true,
      json: async () => ({
        generatorMetadata: [{ chatModel: { usage: { inputTokens: 80000 }, chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 200000 } } } }]
      })
    });
    await new Promise(r => setTimeout(r, 15));
    assert.match(elements.get('percent').textContent, /^40\.0%/);
    assert.match(elements.get('amount').textContent, /80K \(40%\)/);

    // 2. 打开 tokens 面板时有效缓存 (<15s) 存在 -> 秒开且不得触发强制刷新
    elements.get('badge-tokens').click();
    assert.equal(elements.get('panel-tokens').hidden, false);
    assert.equal(historyCalls.length, 1, '打开 Token 面板复用有效缓存，不重新全盘重扫');

    // 3. 连续快速切换 5 个会话，验证：绝不触发 getTokenHistory(true)，每次立即清空旧会话值，且旧扫描结果绝不覆盖新会话
    const routes = ['22222222', '33333333', '44444444', '55555555', '66666666'];
    for (const r of routes) {
      const p = `/c/${r}-1111-1111-1111-111111111111`;
      sandbox.location.pathname = p;
      sandbox.window.location.pathname = p;
      intervals[0]();
      assert.equal(elements.get('percent').textContent, initialPercentText, `切至 ${r} 瞬间绝不能残留上个会话的 40%`);
      assert.match(elements.get('amount').textContent, /真实量未知/, `切至 ${r} 瞬间须立即显示真实量未知`);
      assert.equal(api.snapshot().latest, null);
    }
    assert.equal(historyCalls.includes(true), false, '连续 5 次切路由绝不能触发强制 getTokenHistory(true)');
    assert.equal(historyCalls.length, 1, '切路由期间不得新增任何全量历史重扫');

    // 旧会话 scan 迟到返回，不得污染最终会话 66666666
    const oldScan = pendingScans[0];
    oldScan.resolve({
      ok: true,
      data: {
        conversation: oldScan.id,
        scannedAt: Date.now() + 9999,
        latest: { actual: 199000, max: 200000, percent: 99, limitType: 'default' },
        session: { userMessages: 10, assistantMessages: 10, groups: {}, total: { chars: 100, low: 10, high: 20 }, attachments: [], unknownFiles: 0, complete: true }
      }
    });
    await new Promise(r => setTimeout(r, 15));
    assert.equal(api.snapshot().latest, null, '旧会话迟到 scan 不得覆盖新会话 66666666');
    assert.equal(elements.get('percent').textContent, initialPercentText);
  } finally {
    api.dispose();
  }
});

test('collectTokenHistoryAsync 后台 Worker 隔离执行、保持主线程低停顿且返回一致汇总', async () => {
  const os = require('node:os');
  const { collectTokenHistoryAsync } = require('./meter-collector');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-worker-hist-'));
  const brainDir = path.join(tempDir, 'brain', '11111111-1111-1111-1111-111111111111');
  fs.mkdirSync(brainDir, { recursive: true });
  fs.writeFileSync(path.join(brainDir, 'transcript.jsonl'), [
    JSON.stringify({
      created_at: '2026-11-16T02:00:00.000Z',
      model: 'gemini-3.8-flash',
      chatModel: {
        usage: { inputTokens: 1500, cacheReadTokens: 500, outputTokens: 300, responseId: 'resp_worker_test_1' }
      }
    })
  ].join('\n'), 'utf8');

  let maxGap = 0;
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    const gap = now - last - 10;
    if (gap > maxGap) maxGap = gap;
    last = now;
  }, 10);

  try {
    const res = await collectTokenHistoryAsync({
      agDir: tempDir,
      agCliDir: path.join(tempDir, 'nonexistent-cli'),
      force: true,
      userStatus: null
    });
    assert.equal(res.summary.grandTotalTokens, 2300);
    assert.equal(res.summary.totalInputTokens, 1500);
    assert.equal(res.summary.totalCacheTokens, 500);
    assert.equal(res.summary.totalOutputTokens, 300);
    assert.ok(fs.existsSync(path.join(tempDir, 'token_usage_archive_v2.json')), 'Worker 路径必须完成 v2 归档持久化');
    assert.ok(maxGap < 500, `Worker 执行期间主线程事件循环停顿过大: ${maxGap.toFixed(1)}ms`);
  } finally {
    clearInterval(timer);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('recordModelCallsAsync 后台 Worker 串行入账与 O(S+R) 索引化消重在大规模账本下不阻塞主线程', async () => {
  const os = require('node:os');
  const { performance } = require('node:perf_hooks');
  const { recordModelCalls, recordModelCallsAsync, loadPricingLedger } = require('./meter-collector');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-record-async-'));

  try {
    // 构造 2000 条已落盘真实调用 + 120 条待消重 step fallback 记录
    const seedCalls = [];
    for (let i = 0; i < 2000; i++) {
      seedCalls.push({
        callId: `resp_bulk_${i}`,
        source: 'desktop',
        cascadeId: `conv-bulk-${i % 40}`,
        stepIndex: i,
        model: 'gemini-3.8-flash',
        inputTokens: 1000 + i,
        cacheTokens: 200,
        outputTokens: 150,
        status: 'final',
        created_at: '2026-11-16T01:00:00.000Z'
      });
    }
    const seedRes = recordModelCalls(seedCalls, { agDir: tempDir });
    assert.equal(seedRes.ok, true);

    let maxGap = 0;
    let last = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      const gap = now - last - 10;
      if (gap > maxGap) maxGap = gap;
      last = now;
    }, 10);

    try {
      const incoming = [
        {
          callId: 'conv-bulk-7#7',
          source: 'desktop',
          cascadeId: 'conv-bulk-7',
          stepIndex: 7,
          model: 'gemini-3.8-flash',
          inputTokens: 1007,
          cacheTokens: 200,
          outputTokens: 150,
          status: 'final',
          created_at: '2026-11-16T01:00:00.000Z'
        },
        {
          callId: 'resp_async_new_9999',
          source: 'desktop',
          cascadeId: 'conv-bulk-7',
          stepIndex: 99,
          model: 'gemini-3.8-flash',
          inputTokens: 5500,
          cacheTokens: 500,
          outputTokens: 420,
          status: 'final',
          created_at: '2026-11-16T02:30:00.000Z'
        }
      ];
      const r1 = await recordModelCallsAsync(incoming, { agDir: tempDir });
      assert.equal(r1.ok, true);
      assert.equal(r1.changed, true);

      const r2 = await recordModelCallsAsync([seedCalls[0]], { agDir: tempDir });
      assert.equal(r2.ok, true);
      assert.equal(r2.changed, false);

      const after = loadPricingLedger(tempDir);
      assert.ok(after.calls['resp_async_new_9999'], '新增记录必须持久化至账本');
      assert.equal(after.calls['conv-bulk-7#7'], undefined, '重复 step fallback 应被准确消重合并');
      assert.ok(maxGap < 500, `recordModelCallsAsync 不应阻塞主线程事件循环: maxGap=${maxGap.toFixed(1)}ms`);
    } finally {
      clearInterval(timer);
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('analyzeSteps 工具步骤流式统计与 getKnownModelProducts 缓存命中及配置变更失效验证', async () => {
  const { analyzeSteps } = require('./meter-core');
  const stepResult = analyzeSteps([
    {
      userInput: { userResponse: '你好 Antigravity' }
    },
    {
      toolCall: {
        name: 'run_cmd',
        args: { command: 'echo hello', nested: ['a', 'b', 123, true] },
        metadata: 'should_be_skipped'
      },
      type: 'TOOL_CALL',
      media: [{ uri: 'file:///tmp/demo.png', mimeType: 'image/png', description: 'demo' }]
    }
  ]);
  assert.ok(stepResult.groups.tools.chars > 0);
  assert.ok(stepResult.groups.tools.bytes >= stepResult.groups.tools.chars);
  assert.equal(stepResult.media.length, 1, '工具步骤顶层 media 仍需计入附件清单');
  assert.equal(stepResult.media[0].name, 'demo');

  const h = createTestHarness();
  try {
    h.api.setSpeedRecordsForTest([
      { callId: 'sp1', modelExactId: 'gemini-3.8-flash', model: 'Gemini 3.8 Flash', durationSec: 1.1, tps: 80 },
      { callId: 'sp2', modelExactId: 'gemini-3.8-flash', model: 'Gemini 3.8 Flash', durationSec: 1.2, tps: 82 }
    ], [
      { callId: 'sc1', modelExactId: 'gemini-4-carbon', model: 'Gemini 4 Carbon' }
    ]);
    const list1 = h.api.getKnownModelProductsForTest();
    const list2 = h.api.getKnownModelProductsForTest();
    assert.ok(list1.some(p => p.productKey.includes('gemini-4-carbon')));
    assert.equal(list1.length, list2.length);
    list1[0].members.push({ modelId: 'mutated-clone' });
    const list3 = h.api.getKnownModelProductsForTest();
    assert.ok(!list3[0].members.some(m => m.modelId === 'mutated-clone'), '缓存返回副本不应被外部数组修改污染');

    h.api.setModelCapabilitiesForTest({
      'gemini-4-carbon': { maxTokens: 1000000, maxOutputTokens: 65536 }
    });
    const list4 = h.api.getKnownModelProductsForTest();
    const carbonProd = list4.find(p => p.productKey.includes('gemini-4-carbon'));
    assert.ok(carbonProd);
    assert.equal(carbonProd.members[0].maxTokens, 1000000, '能力表变更必须立即穿透产品缓存');
  } finally {
    h.api.dispose();
  }
});

test('SPA history.pushState 切换路由在微任务内立即清除旧会话显示且 dispose 还原原生 history', async () => {
  let sbRef = null;
  const rawPush = function (_s, _t, url) {
    if (typeof url === 'string' && sbRef) {
      sbRef.location.pathname = url;
      sbRef.window.location.pathname = url;
    }
  };
  const rawReplace = function (_s, _t, url) {
    if (typeof url === 'string' && sbRef) {
      sbRef.location.pathname = url;
      sbRef.window.location.pathname = url;
    }
  };
  const h = createTestHarness({
    setupSandbox(sb) {
      sbRef = sb;
      sb.history = { pushState: rawPush, replaceState: rawReplace };
    }
  });
  try {
    h.api.setContextLatestForTest({
      model: 'gemini-3.8-flash',
      contextUsed: 50000,
      contextLimit: 200000,
      inputTokens: 40000,
      outputTokens: 10000,
      totalTokens: 50000,
      hasChatModel: true,
      hasValidInput: true,
      isFinal: true
    });
    const beforeSnap = h.api.snapshot();
    assert.ok(beforeSnap.latest, '初始会话应有已加载数据');

    sbRef.history.pushState({}, '', '/c/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
    await Promise.resolve();
    await Promise.resolve();
    const afterSnap = h.api.snapshot();
    assert.equal(afterSnap.route, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
    assert.equal(afterSnap.latest, null, '切会话后未等待 500ms 定时器也必须在微任务内清空旧会话数据');
  } finally {
    h.api.dispose();
    assert.equal(sbRef.history.pushState, rawPush, 'dispose 应精确还原原始 pushState');
    assert.equal(sbRef.history.replaceState, rawReplace, 'dispose 应精确还原原始 replaceState');
  }
});

test('ELV-47 & ELV-60: 禁用汉化但开品牌不误报重启恢复英文；组件不完整识别与切换重启引导；字典含};不误判缺失', async () => {
  const vm = require('vm');
  const os = require('os');
  const fs = require('fs');
  const path = require('path');
  const { generateChinesePreloadCode } = require('./modular-installer');
  const { inspectDiskModules, invalidateDiskModulesCache } = require('./modules-config');
  const { builtinAsar } = require('./asar-engine');

  // 1. 仅开启品牌翻译、汉化关闭时，window.__AGY_I18N_DATA__ 虽因品牌监听器而加载，但面板绝不能误报「需重启恢复英文」
  const h = createTestHarness({
    setupSandbox(sb) {
      sb.window.__AGY_I18N_CONFIG__ = { enabled: false, language: 'en', brandTitle: 'translated' };
      sb.window.__AGY_I18N_DATA__ = { exact: { Settings: '设置' } };
      sb.window.__AGY_TRANSLATE_EL__ = () => {};
    }
  });
  try {
    h.sandbox.window.contextMeterAPI.getModulesStatus = async () => ({
      ok: true,
      data: {
        modules: {
          chinese: { enabled: false, language: 'en', brandTitle: 'translated' },
          proxy: { enabled: false, proxyUrl: 'http://127.0.0.1:7897', bypassList: 'localhost' }
        }
      },
      disk: { chinese: true, chineseReady: true, proxy: true, proxyReady: true },
      runtime: { proxyActive: false, proxyNeedsRestart: false }
    });
    h.sandbox.window.contextMeterAPI.toggleModule = async (name, enable, opts) => ({
      ok: true,
      status: 'config_toggled',
      data: {
        modules: {
          chinese: { enabled: Boolean(enable), language: enable ? 'zh-CN' : 'en', brandTitle: opts?.brandTitle || 'translated' },
          proxy: { enabled: false }
        }
      },
      disk: { chinese: true, chineseReady: true, proxy: true, proxyReady: true },
      runtime: { proxyActive: false, proxyNeedsRestart: false },
      restartRequired: true
    });

    h.elements.get('btn-toggle-chinese-module').click();
    await new Promise(r => setTimeout(r, 35));
    assert.equal(h.elements.get('enhance-global-result').style.display, 'block', '切换汉化后应展示明确成功提示');
    assert.equal(h.elements.get('btn-enhance-restart-host').hidden, false, '支持重启宿主时应立即显示重启客户端按钮');
  } finally {
    h.api.dispose();
  }

  // 验证初始化时关闭汉化+开启品牌翻译展示「已关闭 (官方英文)」而非「需重启恢复英文」
  const h2 = createTestHarness({
    setupSandbox(sb) {
      sb.window.__AGY_I18N_CONFIG__ = { enabled: false, language: 'en', brandTitle: 'hidden' };
      sb.window.__AGY_I18N_DATA__ = { exact: { Settings: '设置' } };
      sb.window.__AGY_TRANSLATE_EL__ = () => {};
      sb.window.contextMeterAPI.getModulesStatus = async () => ({
        ok: true,
        data: {
          modules: {
            chinese: { enabled: false, language: 'en', brandTitle: 'hidden' },
            proxy: { enabled: false, proxyUrl: 'http://127.0.0.1:7897', bypassList: 'localhost' }
          }
        },
        disk: { chinese: true, chineseReady: true, proxy: true, proxyReady: true },
        runtime: { proxyActive: false, proxyNeedsRestart: false }
      });
    }
  });
  try {
    await new Promise(r => setTimeout(r, 560));
    assert.equal(h2.elements.get('chinese-badge').textContent, '⚪ 已关闭 (官方英文)');
  } finally {
    h2.api.dispose();
  }

  // 2. 隔离 AG_METER_STATE_DIR 下，preload 读取对应状态目录；损坏 JSON 时 fail-closed
  const tmpState = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-ch-state-'));
  try {
    fs.writeFileSync(path.join(tmpState, 'modules.json'), '{ broken json', 'utf8');
    const preloadCode = generateChinesePreloadCode('{"exact":{"Save":"保存","x":"foo};bar"}}', 'window.__AGY_BOOTED_TEST__ = true;');
    const sbBroken = {
      window: {},
      globalThis: null,
      console: { warn: () => {} },
      process: { platform: 'win32', env: { AG_METER_STATE_DIR: tmpState, LOCALAPPDATA: tmpState } },
      require: (m) => require(m)
    };
    sbBroken.globalThis = sbBroken.window;
    vm.runInNewContext(preloadCode, sbBroken);
    assert.equal(sbBroken.window.__AGY_BOOTED_TEST__, undefined, 'modules.json 损坏时 preload 必须 fail-closed');

    // 3. 字典内含 "};" 时 inspectDiskModules 不得被截断误判为缺失资源
    const tmpRoot = path.join(tmpState, 'asar-root');
    const distDir = path.join(tmpRoot, 'dist');
    fs.mkdirSync(distDir, { recursive: true });
    const bigDict = JSON.stringify({ exact: { a: 'foo};bar', pad: 'x'.repeat(700) } });
    fs.writeFileSync(path.join(distDir, 'preload.js'), generateChinesePreloadCode(bigDict, 'function createI18nEngine(){}'), 'utf8');
    fs.writeFileSync(path.join(distDir, 'utils.js'), '"use strict";', 'utf8');
    const asarOut = path.join(tmpState, 'test-semi.asar');
    await builtinAsar.createPackageWithOptions(tmpRoot, asarOut, {});
    invalidateDiskModulesCache(asarOut);
    const diskRes = inspectDiskModules(asarOut, { useCache: false });
    assert.equal(diskRes.chineseReady, true, '字典中包含 "};" 时仍应判定 chineseReady=true');
  } finally {
    fs.rmSync(tmpState, { recursive: true, force: true });
  }
});

test('ELV-44 & ELV-61 & ELV-62: 代理配置优先隔离不回落旧 proxy.json、强制覆盖污染 env、Webview Session 同步及真实启动快照隔离', async () => {
  const vm = require('vm');
  const os = require('os');
  const fs = require('fs');
  const path = require('path');
  const { generateProxyUtilsCode } = require('./modular-installer');
  const { applyProxyEnvironment, detectProxyConfig, normalizeProxyUrl } = require('./meter-proxy');
  const { inspectDiskModules, invalidateDiskModulesCache } = require('./modules-config');
  const { builtinAsar } = require('./asar-engine');

  assert.equal(normalizeProxyUrl(' http://127.0.0.1:7897/ '), 'http://127.0.0.1:7897');
  assert.equal(normalizeProxyUrl('socks5h://127.0.0.1:7898/'), 'socks5h://127.0.0.1:7898');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-proxy-elv61-'));
  try {
    const legacyProxyFile = path.join(tmpDir, 'proxy.json');
    const unifiedFile = path.join(tmpDir, 'modules.json');
    fs.writeFileSync(legacyProxyFile, JSON.stringify({
      enabled: true,
      httpProxy: 'http://127.0.0.1:7897'
    }), 'utf8');

    // 1. modules.json 损坏时不得滑落激活旧 proxy.json
    fs.writeFileSync(unifiedFile, '{ invalid json', 'utf8');
    const brokenDetect = detectProxyConfig({ candidates: [unifiedFile, legacyProxyFile] });
    assert.equal(brokenDetect.enabled, false, '损坏的 modules.json 必须拦截回落旧 proxy.json');

    // 2. modules.json 启用 socks5h 并带有尾部斜杠时，utils 注入块必须覆写污染环境变量，且向 Electron 映射为 socks5://
    fs.writeFileSync(unifiedFile, JSON.stringify({
      schemaVersion: '0.8.3',
      modules: {
        proxy: {
          enabled: true,
          proxyUrl: 'socks5h://127.0.0.1:17898/',
          bypassList: 'localhost,127.0.0.1,<local>'
        }
      }
    }), 'utf8');

    const proxyCode = generateProxyUtilsCode({ enabled: false });
    const switches = [];
    const sessionCalls = [];
    const createdSessionHandlers = [];
    const whenReadyPromise = Promise.resolve();
    const fakeDefaultSess = { setProxy: async (opts) => { sessionCalls.push({ target: 'default', ...opts }); } };
    const fakeWebviewSess = { setProxy: async (opts) => { sessionCalls.push({ target: 'webview-anon', ...opts }); } };
    const fakeDynamicSess = { setProxy: async (opts) => { sessionCalls.push({ target: 'dynamic', ...opts }); } };
    const mockElectron = {
      app: {
        commandLine: { appendSwitch: (k, v) => switches.push([k, v]) },
        on: (ev, cb) => { if (ev === 'session-created') createdSessionHandlers.push(cb); },
        whenReady: () => whenReadyPromise
      },
      session: {
        defaultSession: fakeDefaultSess,
        fromPartition: (p) => (p === 'persist:hub-browser-anonymous' ? fakeWebviewSess : null)
      }
    };
    const sb = {
      require: (id) => (id === 'electron' ? mockElectron : require(id)),
      process: {
        platform: process.platform,
        env: {
          AG_METER_STATE_DIR: tmpDir,
          HTTP_PROXY: 'http://stale-dead-proxy:10809',
          HTTPS_PROXY: 'http://stale-dead-proxy:10809',
          http_proxy: 'http://stale-dead-proxy:10809'
        }
      },
      console: { warn: () => {} },
      globalThis: null
    };
    sb.globalThis = sb;
    vm.runInNewContext(proxyCode, sb);
    await whenReadyPromise;
    await new Promise(r => setImmediate(r));
    createdSessionHandlers.forEach(fn => fn(fakeDynamicSess));
    await new Promise(r => setImmediate(r));

    assert.equal(sb.process.env.HTTP_PROXY, 'socks5h://127.0.0.1:17898', '必须强行覆写残留的旧环境变量代理');
    assert.equal(sb.process.env.https_proxy, 'socks5h://127.0.0.1:17898');
    assert.equal(sb.process.env.NODE_USE_ENV_PROXY, '1');
    assert.deepEqual(switches[0], ['proxy-server', 'socks5://127.0.0.1:17898'], 'Chromium 开关应将 socks5h 映射为 socks5');
    assert.ok(sessionCalls.some(c => c.target === 'default' && c.proxyRules === 'socks5://127.0.0.1:17898'));
    assert.ok(sessionCalls.some(c => c.target === 'webview-anon' && c.proxyRules === 'socks5://127.0.0.1:17898'));
    assert.ok(sessionCalls.some(c => c.target === 'dynamic' && c.proxyRules === 'socks5://127.0.0.1:17898'));
    assert.equal(sb.globalThis.__AG_PROXY_BOOT_INFO__.injectedAtStartup, true);
    assert.equal(sb.globalThis.__AG_PROXY_BOOT_INFO__.active, true);
    assert.equal(sb.globalThis.__AG_PROXY_BOOT_INFO__.proxyUrl, 'socks5h://127.0.0.1:17898');

    // 3. 验证 inspectDiskModules 对新生成 Proxy 代码仍判定 proxyReady=true，且 applyProxyEnvironment({ overrideExisting: true }) 覆盖旧 env
    const pkgDir = path.join(tmpDir, 'pkg');
    fs.mkdirSync(path.join(pkgDir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'dist', 'utils.js'), `${proxyCode}\n"use strict";`, 'utf8');
    fs.writeFileSync(path.join(pkgDir, 'dist', 'preload.js'), '"use strict";', 'utf8');
    const asarFile = path.join(tmpDir, 'proxy-ready.asar');
    await builtinAsar.createPackageWithOptions(pkgDir, asarFile, {});
    invalidateDiskModulesCache(asarFile);
    const inspected = inspectDiskModules(asarFile, { useCache: false });
    assert.equal(inspected.proxyReady, true, '新版 ProxyNoTun 注入块必须完整通过 inspectDiskModules 校验');

    const pollutedEnv = { HTTP_PROXY: 'http://stale:9999', https_proxy: 'http://stale:9999' };
    applyProxyEnvironment(pollutedEnv, { candidates: [unifiedFile], overrideExisting: true });
    assert.equal(pollutedEnv.HTTP_PROXY, 'socks5h://127.0.0.1:17898');
    assert.equal(pollutedEnv.https_proxy, 'socks5h://127.0.0.1:17898');
    assert.equal(pollutedEnv.NODE_USE_ENV_PROXY, '1');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('ELV-44 & ELV-62: bootProxySnapshot 严禁未注入即虚报 active，部分注入 ASAR 返回明确原因与外部可执行指引', async () => {
  const os = require('os');
  const fs = require('fs');
  const path = require('path');
  const { builtinAsar } = require('./asar-engine');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-partial-boot-'));
  const prevStateDir = process.env.AG_METER_STATE_DIR;
  const prevHttp = process.env.HTTP_PROXY;
  const prevHttps = process.env.HTTPS_PROXY;
  try {
    process.env.AG_METER_STATE_DIR = tmpDir;
    delete process.env.HTTP_PROXY;
    delete process.env.HTTPS_PROXY;
    delete globalThis.__AG_PROXY_BOOT_INFO__;

    // 写入开启免 TUN 的配置，但当前进程并未启动注入 -> bootProxySnapshot 不应虚报 active
    fs.writeFileSync(path.join(tmpDir, 'modules.json'), JSON.stringify({
      schemaVersion: '0.8.3',
      modules: {
        chinese: { enabled: false, language: 'en', brandTitle: 'english' },
        proxy: { enabled: true, proxyUrl: 'http://127.0.0.1:18888', bypassList: 'localhost' }
      }
    }), 'utf8');

    // 重新加载 meter-main 模拟新启动进程（未走 utils.js 代理注入）
    delete require.cache[require.resolve('./meter-main')];
    const { registerMeterIpcHandlers } = require('./meter-main');
    const handlers = {};
    registerMeterIpcHandlers({ handle: (ch, fn) => { handlers[ch] = fn; } }, {});
    const localFrame = { url: 'https://127.0.0.1:5173/' };
    const ev = { senderFrame: localFrame, sender: { mainFrame: localFrame } };

    // 构造一个带标记但实际缺失资源的残缺 ASAR
    const pkgDir = path.join(tmpDir, 'partial-pkg');
    fs.mkdirSync(path.join(pkgDir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'dist', 'utils.js'), '// --- Antigravity Proxy NoTun Injection Start ---\n"use strict";\n// --- Antigravity Proxy NoTun Injection End ---', 'utf8');
    fs.writeFileSync(path.join(pkgDir, 'dist', 'preload.js'), '// --- Antigravity Chinese Localization Injection Start ---\n// empty\n// --- Antigravity Chinese Localization Injection End ---', 'utf8');
    const partialAsar = path.join(tmpDir, 'partial.asar');
    await builtinAsar.createPackageWithOptions(pkgDir, partialAsar, {});

    const statusRes = await handlers['context-meter:modules-status'](ev, partialAsar);
    assert.equal(statusRes.ok, true);
    assert.equal(statusRes.runtime.proxyActive, false, '未注入启动标记且无环境代理时绝不谎报 proxyActive=true');
    assert.equal(statusRes.runtime.proxyNeedsRestart, true);
    assert.equal(statusRes.disk.proxy, true);
    assert.equal(statusRes.disk.proxyReady, false);
    assert.equal(statusRes.disk.chinese, true);
    assert.equal(statusRes.disk.chineseReady, false);

    const togglePartialRes = await handlers['context-meter:toggle-module'](ev, 'chinese', true, { asarPath: partialAsar });
    assert.equal(togglePartialRes.ok, false);
    assert.equal(togglePartialRes.status, 'install_failed');
    assert.match(togglePartialRes.error, /^当前客户端磁盘 ASAR 未注入汉化组件（或组件不完整）。/);
    assert.match(togglePartialRes.error, /系统托盘/);
  } finally {
    if (prevStateDir === undefined) delete process.env.AG_METER_STATE_DIR; else process.env.AG_METER_STATE_DIR = prevStateDir;
    if (prevHttp === undefined) delete process.env.HTTP_PROXY; else process.env.HTTP_PROXY = prevHttp;
    if (prevHttps === undefined) delete process.env.HTTPS_PROXY; else process.env.HTTPS_PROXY = prevHttps;
    delete require.cache[require.resolve('./meter-main')];
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('ELV-47 & ELV-60: Electron 沙箱隔离且侧边栏含中文项目名时，不误判英文宿主为已汉化，切换汉化准确提示待重启', async () => {
  // 模拟 Electron contextIsolation 隔离场景：Main World 读不到 __AGY_I18N_CONFIG__，但主进程返回 runtime.chineseActive=false
  let mockChineseEnabled = false;
  const h = createTestHarness({
    setupSandbox(sb) {
      // 模拟侧边栏用户自定义中文项目名（包含“项目”“设置”字样）但宿主本身是英文
      const origQsa = sb.document.querySelectorAll.bind(sb.document);
      sb.document.querySelectorAll = (sel) => {
        if (sel.includes('new-conversation-button')) return [{ textContent: 'New Conversation' }];
        if (sel.includes('settings-button')) return [{ textContent: 'Settings' }];
        return origQsa(sel);
      };
      sb.window.contextMeterAPI.getModulesStatus = async () => ({
        ok: true,
        data: {
          modules: {
            chinese: { enabled: mockChineseEnabled, language: mockChineseEnabled ? 'zh-CN' : 'en', brandTitle: 'hidden' },
            proxy: { enabled: false, proxyUrl: 'http://127.0.0.1:7897', bypassList: 'localhost' }
          }
        },
        disk: { chinese: true, chineseReady: true, proxy: true, proxyReady: true },
        runtime: {
          proxyActive: false,
          proxyNeedsRestart: false,
          chineseActive: false,
          chineseNeedsRestart: mockChineseEnabled
        }
      });
      sb.window.contextMeterAPI.toggleModule = async (_name, enable) => {
        mockChineseEnabled = Boolean(enable);
        return {
          ok: true,
          status: 'config_toggled',
          data: {
            modules: {
              chinese: { enabled: mockChineseEnabled, language: mockChineseEnabled ? 'zh-CN' : 'en', brandTitle: 'hidden' },
              proxy: { enabled: false }
            }
          },
          disk: { chinese: true, chineseReady: true, proxy: true, proxyReady: true },
          runtime: {
            proxyActive: false,
            proxyNeedsRestart: false,
            chineseActive: false,
            chineseNeedsRestart: mockChineseEnabled
          },
          restartRequired: true
        };
      };
    }
  });
  try {
    await new Promise(r => setTimeout(r, 560));
    assert.equal(h.elements.get('chinese-badge').textContent, '⚪ 已关闭 (官方英文)', '英文宿主不能受隔离上下文影响误报待重启恢复英文');

    // 在英文宿主中开启简体中文，重启前必须提示待重启，不能提前误报已翻译生效
    h.elements.get('btn-toggle-chinese-module').click();
    await new Promise(r => setTimeout(r, 50));
    assert.equal(h.elements.get('chinese-badge').textContent, '⏳ 待重启客户端生效');
  } finally {
    h.api.dispose();
  }
});

test('PR #47 / Issue #46: 推荐配置复选框按磁盘真实开关同步、仅提交差异、取消已开启项走恢复且不冲掉用户草稿', async () => {
  const applyEnhanceCalls = [];
  const toggleCalls = [];
  const unlockCalls = [];
  const restoreUnlockCalls = [];
  const h = createTestHarness({
    setupSandbox(sb) {
      sb.window.contextMeterAPI.getEnhanceStatus = async () => ({
        ok: true,
        data: {
          supported: true,
          summary: {
            promptTier: 4,
            chineseTitleEnabled: false,
            chineseTitleMode: 'default',
            pendingLsRestart: false
          }
        }
      });
      sb.window.contextMeterAPI.getContextUnlockStatus = async () => ({
        ok: true,
        data: {
          isPlatformSupported: true,
          status: 'applied',
          configuredMode: 'dynamic',
          configuredLimitTokens: null
        }
      });
      sb.window.contextMeterAPI.getModulesStatus = async () => ({
        ok: true,
        data: {
          modules: {
            chinese: { enabled: false, language: 'en', brandTitle: 'english' },
            proxy: { enabled: false, proxyUrl: '' }
          }
        },
        disk: { chinese: true, chineseReady: true, proxy: true, proxyReady: true },
        runtime: { chineseActive: false, chineseNeedsRestart: false, proxyActive: false, proxyNeedsRestart: false }
      });
      sb.window.contextMeterAPI.applyEnhancePatch = async (payload) => {
        applyEnhanceCalls.push(payload);
        return {
          ok: true,
          changed: true,
          needsRestart: true,
          status: {
            supported: true,
            summary: {
              promptTier: payload.promptTier ?? 4,
              chineseTitleEnabled: Boolean(payload.chineseTitle),
              chineseTitleMode: payload.chineseTitle ? 'zh' : 'default'
            }
          }
        };
      };
      sb.window.contextMeterAPI.toggleModule = async (name, enable, opts) => {
        toggleCalls.push({ name, enable, opts });
        return {
          ok: true,
          status: 'config_toggled',
          data: { modules: { chinese: { enabled: Boolean(enable), language: opts?.language || 'en', brandTitle: opts?.brandTitle || 'english' }, proxy: { enabled: false } } },
          disk: { chinese: true, chineseReady: true, proxy: true, proxyReady: true },
          runtime: { chineseActive: false, chineseNeedsRestart: Boolean(enable) }
        };
      };
      sb.window.contextMeterAPI.applyContextUnlock = async (payload) => {
        unlockCalls.push(payload);
        return { ok: true, data: { isPlatformSupported: true, status: 'applied', configuredMode: payload.mode } };
      };
      sb.window.contextMeterAPI.restoreContextUnlock = async () => {
        restoreUnlockCalls.push(true);
        return { ok: true, data: { isPlatformSupported: true, status: 'not_patched', configuredMode: 'default' } };
      };
    }
  });
  try {
    h.elements.get('btn-ctx-settings').click();
    await new Promise(r => setTimeout(r, 80));

    // 1. 磁盘上仅 promptTier=4 与 configuredMode='dynamic' 为开启，复选框必须按磁盘真实同步
    const chkPrompt = h.elements.get('chk-rec-prompt');
    const chkTitle = h.elements.get('chk-rec-title');
    const chkLang = h.elements.get('chk-rec-lang');
    const chkCtx = h.elements.get('chk-rec-ctx');
    assert.equal(chkPrompt.checked, true);
    assert.equal(chkTitle.checked, false);
    assert.equal(chkLang.checked, false);
    assert.equal(chkCtx.checked, true);

    // 2. 用户未做任何改动直接点应用：差异为空，确认前绝不写入
    h.elements.get('btn-enhance-preset-apply').click();
    assert.equal(applyEnhanceCalls.length, 0);
    assert.equal(toggleCalls.length, 0);
    assert.equal(restoreUnlockCalls.length, 0);

    // 3. 用户取消勾选已开启的 ctx，并勾选未开启的 title；触发 change 标记 dirty 后，后台状态刷新不能冲掉用户草稿
    chkCtx.checked = false;
    chkCtx.trigger('change', { target: chkCtx });
    chkTitle.checked = true;
    chkTitle.trigger('change', { target: chkTitle });

    await h.api.refreshEnhanceStatusForTest();
    assert.equal(chkCtx.checked, false, '用户已编辑的复选框不能被后台刷新冲掉');
    assert.equal(chkTitle.checked, true, '用户已编辑的复选框不能被后台刷新冲掉');

    // 4. 点应用再点确认：仅提交差异项（title 开启、ctx 恢复），未变动的 prompt 与 lang 不触发写入
    h.elements.get('btn-enhance-preset-apply').click();
    assert.equal(h.elements.get('enhance-preset-confirm').hidden, false);
    assert.equal(applyEnhanceCalls.length, 0, '确认前绝不写入磁盘');
    h.elements.get('btn-enhance-confirm-go').click();
    await new Promise(r => setTimeout(r, 60));

    assert.equal(applyEnhanceCalls.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(applyEnhanceCalls[0])), { chineseTitle: true });
    assert.equal(toggleCalls.length, 0, '未变更的客户端语言不得被写入');
    assert.equal(unlockCalls.length, 0);
    assert.equal(restoreUnlockCalls.length, 1, '取消已开启的上下文跟随模型必须走 restore');
  } finally {
    h.api.dispose();
  }
});
