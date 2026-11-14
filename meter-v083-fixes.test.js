const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const core = require('./meter-core');

// 引入构建后的 renderer 脚本进行纯隔离测试
const source = fs.readFileSync(path.join(__dirname, 'meter-renderer.js'), 'utf8');

function createTestHarness() {
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
    setInterval: () => 1,
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

  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);

  return {
    sandbox,
    doc,
    elements,
    api: sandbox.__AGContextMeter,
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
  assert.match(detPrice.textContent, /approx\./, '英文下折合必须显示为 approx.，绝不显示折合');
  assert.equal(/正常付费|月付|折合/.test(detPrice.textContent), false, '英文价格字段内绝无中文残留');

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
