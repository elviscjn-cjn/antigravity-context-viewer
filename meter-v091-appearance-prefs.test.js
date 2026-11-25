'use strict';

// v0.9.1 模块一：外观与停靠配置页 4 分组重构 + 3 个独立径向开关共存 + 旧配置无损迁移

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const core = require('./meter-core');

const source = fs.readFileSync(path.join(__dirname, 'meter-renderer.js'), 'utf8');
const TPL_SOURCE = fs.readFileSync(path.join(__dirname, 'src', 'renderer', 'template.html'), 'utf8');
const I18N_SOURCE = fs.readFileSync(path.join(__dirname, 'src', 'renderer', 'i18n.js'), 'utf8');
const STYLES_SOURCE = fs.readFileSync(path.join(__dirname, 'src', 'renderer', 'styles.css'), 'utf8');

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
      querySelectorAll() { return []; },
      querySelector() { return null; },
      closest() { return null; },
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
    querySelector() { return null; },
    addEventListener(type, fn) {
      if (!listeners.has(host)) listeners.set(host, new Map());
      listeners.get(host).set(type, fn);
    },
    removeEventListener() { }
  });

  const pending = [], scans = [], timers = [];
  const docListeners = new Map();
  const storageMap = new Map();
  if (seedStorage && typeof seedStorage === 'object') {
    for (const [k, v] of Object.entries(seedStorage)) storageMap.set(k, String(v));
  }
  const lStore = {
    getItem(k) { return storageMap.has(k) ? storageMap.get(k) : null; },
    setItem(k, v) { storageMap.set(k, String(v)); },
    removeItem(k) { storageMap.delete(k); },
    clear() { storageMap.clear(); },
    get(k) { return storageMap.get(k); }
  };

  const sandbox = {
    location: { protocol: 'https:', hostname: '127.0.0.1', pathname: '/c/11111111-1111-1111-1111-111111111111' },
    document: {
      createElement: () => element(),
      getElementById: id => docElements.get(id) || null,
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
      querySelectorAll() { return []; },
      querySelector() { return null; },
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
    fetch(url, options) { return new Promise(resolve => pending.push({ url, options, resolve })); }
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
    storageMap,
    tick: () => timers[0]?.(),
    flush: () => new Promise(resolve => setImmediate(resolve)),
    finishScan(i = 0) {
      scans[i]?.resolve({ ok: true, data: { session: session(), scannedAt: Date.now(), latest: null } });
    }
  };
}

const groupIds = source => Array.from(source.matchAll(/<section class="ctx-prefs-group" id="([^"]+)"/g)).map(m => m[1]);

test('v0.9.1 模块一 / A: 外观与停靠配置页渲染 4 个分组、每行左文右控且无重复按钮', () => {
  const ids = groupIds(TPL_SOURCE);
  assert.deepStrictEqual(ids, [
    'ctx-prefs-group-open',
    'ctx-prefs-group-radial',
    'ctx-prefs-group-display',
    'ctx-prefs-group-theme'
  ], '配置页必须严格渲染 4 个分组卡片');

  // 每个分组都有克制的小标题
  for (const id of ids) {
    const block = TPL_SOURCE.match(new RegExp(`<section class="ctx-prefs-group" id="${id}"[\\s\\S]*?</section>`))?.[0] || '';
    assert.ok(block, `${id} 分组必须存在`);
    assert.match(block, /class="ctx-prefs-group-title"/, `${id} 必须带分组小标题`);
    assert.match(block, /class="ctx-prefs-row"/, `${id} 必须使用设置行排版`);
  }

  // 左文右控：每个设置行都同时具备主文案区与控件区
  const prefsRegion = TPL_SOURCE.slice(
    TPL_SOURCE.indexOf('<section class="ctx-prefs-group" id="ctx-prefs-group-open"'),
    TPL_SOURCE.indexOf('<div id="dock-fallback-note"')
  );
  const rowStarts = Array.from(prefsRegion.matchAll(/<div class="ctx-prefs-row[^"]*" id="([^"]+)">/g));
  assert.ok(rowStarts.length >= 10, `设置行数量必须覆盖全部选项，实际 ${rowStarts.length}`);
  for (let i = 0; i < rowStarts.length; i++) {
    const startIdx = rowStarts[i].index;
    const endIdx = i + 1 < rowStarts.length ? rowStarts[i + 1].index : prefsRegion.length;
    const chunk = prefsRegion.slice(startIdx, endIdx);
    const rowId = rowStarts[i][1];
    assert.match(chunk, /class="ctx-prefs-row-(main|title)/, `${rowId} 行必须包含左侧文案区`);
    assert.match(chunk, /ctx-prefs-row-ctl|ctx-prefs-action-row|ctx-toggle/, `${rowId} 行必须包含右侧控件区`);
  }

  // 分组 1：4 个互不重复的快捷操作按钮，且彻底删除第二个「在外部浏览器打开」
  const quickRow = TPL_SOURCE.match(/<div class="ctx-prefs-row ctx-prefs-row-stack" id="row-quick-actions">([\s\S]*?)<\/div>\s*<\/section>/)?.[1] || '';
  assert.ok(quickRow, '必须存在当前会话快捷操作条');
  for (const btnId of ['btn-dock-open-right', 'btn-dock-fb-page', 'btn-dock-fb-copy', 'btn-dock-open-browser']) {
    assert.equal((quickRow.match(new RegExp(`id="${btnId}"`, 'g')) || []).length, 1, `${btnId} 必须且仅出现一次`);
  }
  assert.equal(TPL_SOURCE.includes('id="btn-dock-fb-external"'), false, '重复的外部浏览器按钮必须彻底删除');
  assert.equal((TPL_SOURCE.match(/data-i18n="settings\.dock\.openExternalBtn"/g) || []).length, 1, '外部浏览器入口全页只允许一处');

  // 分组 2：旧 4 选 1 单选与反向复选框彻底移除，改为 3 个正向开关
  assert.equal(TPL_SOURCE.includes('id="radial-menu-style-segmented"'), false, '旧的 4 选 1 径向单选必须移除');
  assert.equal(TPL_SOURCE.includes('data-quick-menu='), false, '旧单选按钮彻底移除');
  assert.equal(TPL_SOURCE.includes('id="radial-orb-hidden-row"'), false, '旧的反向隐藏行必须移除');
  const radialGroup = TPL_SOURCE.match(/<section class="ctx-prefs-group" id="ctx-prefs-group-radial"[\s\S]*?<\/section>/)?.[0] || '';
  for (const switchId of ['chk-radial-orb', 'chk-radial-topbar', 'chk-radial-bottombar']) {
    assert.equal((radialGroup.match(new RegExp(`id="${switchId}"`, 'g')) || []).length, 1, `${switchId} 必须且仅出现一次`);
  }
  // 兼容桥保留但不下发可见 UI
  assert.ok(TPL_SOURCE.includes('id="chk-hide-radial-orb"'), '旧隐藏复选框必须保留为兼容桥接节点');
  assert.ok(TPL_SOURCE.includes('id="chk-hide-topbar"'), '旧顶栏隐藏复选框必须保留为兼容桥接节点');

  // 全部布尔项统一为正向滑动开关，禁止出现反向语义
  const switchLabels = ['chk-autohide-topbar-docked', 'chk-radial-orb', 'chk-radial-topbar', 'chk-radial-bottombar', 'chk-show-composer-quota', 'chk-show-turn-footer-stats'];
  for (const id of switchLabels) {
    const block = TPL_SOURCE.match(new RegExp(`<label class="ctx-toggle"[^>]*>\\s*<input id="${id}"`, 'g')) || [];
    assert.equal(block.length, 1, `${id} 必须是正向滑动开关`);
  }
  assert.match(STYLES_SOURCE, /\.ctx-toggle-input:checked\+\.ctx-toggle-track/, '滑动开关必须有明确的开启态样式');
  assert.match(STYLES_SOURCE, /\.ctx-prefs-row\s*\{[\s\S]*?display:\s*flex/, '设置行必须为左文右控弹性布局');
});

test('v0.9.1 模块一 / B: 三开关全开共存、单开与全关降级、运行期互斥只展开一处', async () => {
  const h = harness();
  const api = h.sandbox.__AGContextMeter;
  const host = h.host;
  try {
    h.finishScan();
    await h.flush();

    // 全开
    api.setRadialOrbEnabledForTest(true, { persist: false });
    api.setRadialTopbarEnabledForTest(true, { persist: false });
    api.setRadialBottombarEnabledForTest(true, { persist: false });
    let state = api.getRadialMenuStateForTest();
    assert.equal(state.radialOrbEnabled, true);
    assert.equal(state.radialTopbarEnabled, true);
    assert.equal(state.radialBottombarEnabled, true);
    assert.equal(host.getAttribute('data-radial-modes'), 'orb topbar bottombar', '三开关全开时宿主必须汇总三个入口');
    assert.equal(h.elements.get('ctx-radial-orb').hidden, false, '全开时悬浮球必须可见');

    // 三个入口共存，但同一时刻只展开一处
    api.toggleRadialMenuForTest('topbar', h.elements.get('badge'));
    state = api.getRadialMenuStateForTest();
    assert.equal(state.open, true, '顶栏入口必须能展开径向菜单');
    assert.equal(state.anchorMode, 'topbar');
    assert.equal(h.elements.get('badge').getAttribute('data-radial-open'), 'true');

    api.toggleRadialMenuForTest('bottombar', h.elements.get('csb-group-context'));
    state = api.getRadialMenuStateForTest();
    assert.equal(state.open, true, '切到底栏入口时应保持展开而不是直接全关');
    assert.equal(state.anchorMode, 'bottombar', '底栏入口必须接管当前展开');
    assert.equal(h.elements.get('badge').getAttribute('data-radial-open'), null, '开 B 时必须自动收起 A');

    api.toggleRadialMenuForTest('bottombar', h.elements.get('csb-group-context'));
    state = api.getRadialMenuStateForTest();
    assert.equal(state.open, false, '再次点击当前入口必须收起');

    // 单开降级：仅开顶栏时底栏点击首次直达会话面板
    api.setRadialTopbarEnabledForTest(false, { persist: false });
    api.setRadialBottombarEnabledForTest(false, { persist: false });
    api.setRadialOrbEnabledForTest(false, { persist: false });
    state = api.getRadialMenuStateForTest();
    assert.equal(host.getAttribute('data-radial-modes'), 'none', '全关时必须标记 none');
    assert.equal(h.elements.get('ctx-radial-orb').hidden, true, '全关时悬浮圆球必须隐藏');
    assert.equal(h.elements.get('chk-radial-orb').checked, false);

    const pContext = h.elements.get('panel');
    const csbContext = h.elements.get('csb-group-context');
    csbContext.click();
    assert.equal(pContext.hidden, false, '底栏径向关闭时必须零闪烁直达当前会话面板');
    assert.equal(api.getRadialMenuStateForTest().open, false, '底栏径向关闭时不得展开径向菜单');

    // 全关后顶栏点击回到经典列表弹层行为
    api.setRadialTopbarEnabledForTest(false, { persist: false });
    assert.equal(api.getRadialMenuStateForTest().radialTopbarEnabled, false);
  } finally {
    api.dispose();
  }
});

test('v0.9.1 模块一 / C: 右键隐藏悬浮球同步关闭「悬浮圆环」开关并持久化', async () => {
  const h = harness();
  const api = h.sandbox.__AGContextMeter;
  try {
    h.finishScan();
    await h.flush();

    api.setRadialOrbEnabledForTest(true, { persist: true });
    assert.equal(h.elements.get('chk-radial-orb').checked, true);
    assert.equal(h.lStore.get('ag_radial_orb_enabled'), 'true');

    let prevented = false;
    let stopped = false;
    h.elements.get('ctx-radial-orb').trigger('contextmenu', {
      preventDefault() { prevented = true; },
      stopPropagation() { stopped = true; }
    });

    assert.equal(prevented, true);
    assert.equal(stopped, true);
    assert.equal(h.elements.get('ctx-radial-orb').hidden, true, '右键后悬浮球必须立即隐藏');
    assert.equal(h.elements.get('chk-radial-orb').checked, false, '右键隐藏后「悬浮圆环」开关必须同步为关闭');
    assert.equal(h.lStore.get('ag_radial_orb_enabled'), 'false', '关闭必须持久化到正向开关字段');
    assert.equal(h.lStore.get('ag_radial_orb_hidden'), 'true', '旧反向字段必须保持同步');
    assert.equal(api.getRadialMenuStateForTest().radialOrbEnabled, false);
    assert.equal(h.elements.get('overflow-show-orb-btn').hidden, false, '隐藏后顶栏恢复入口必须显现');

    h.elements.get('overflow-show-orb-btn').click();
    assert.equal(h.elements.get('chk-radial-orb').checked, true, '恢复入口必须同步点亮「悬浮圆环」开关');
    assert.equal(h.elements.get('ctx-radial-orb').hidden, false);
  } finally {
    api.dispose();
  }
});

test('v0.9.1 模块一 / D: 旧 4 选 1 单选与旧反向隐藏字段无损迁移 + 冷重载持久化', async () => {
  // 旧 orb 且未隐藏 → 仅悬浮圆环开启
  const hOrb = harness({ ag_quick_menu_style: 'orb' });
  try {
    hOrb.finishScan();
    await hOrb.flush();
    const st = hOrb.sandbox.__AGContextMeter.getRadialMenuStateForTest();
    assert.equal(st.radialOrbEnabled, true, '旧 orb 值必须迁移为悬浮圆环开启');
    assert.equal(st.radialTopbarEnabled, false);
    assert.equal(st.radialBottombarEnabled, false);
  } finally {
    hOrb.sandbox.__AGContextMeter.dispose();
  }

  // 旧 topbar → 仅顶栏径向开启
  const hTop = harness({ ag_quick_menu_style: 'topbar' });
  try {
    hTop.finishScan();
    await hTop.flush();
    const st = hTop.sandbox.__AGContextMeter.getRadialMenuStateForTest();
    assert.equal(st.radialTopbarEnabled, true, '旧 topbar 值必须迁移为顶栏径向开启');
    assert.equal(st.radialOrbEnabled, false);
    assert.equal(st.radialBottombarEnabled, false);
  } finally {
    hTop.sandbox.__AGContextMeter.dispose();
  }

  // 旧 bottombar → 仅底栏径向开启
  const hBottom = harness({ ag_quick_menu_style: 'bottombar' });
  try {
    hBottom.finishScan();
    await hBottom.flush();
    const st = hBottom.sandbox.__AGContextMeter.getRadialMenuStateForTest();
    assert.equal(st.radialBottombarEnabled, true, '旧 bottombar 值必须迁移为底栏径向开启');
    assert.equal(st.radialOrbEnabled, false);
    assert.equal(st.radialTopbarEnabled, false);
  } finally {
    hBottom.sandbox.__AGContextMeter.dispose();
  }

  // 旧 classic → 三者皆关闭
  const hClassic = harness({ ag_quick_menu_style: 'classic' });
  try {
    hClassic.finishScan();
    await hClassic.flush();
    const st = hClassic.sandbox.__AGContextMeter.getRadialMenuStateForTest();
    assert.equal(st.radialOrbEnabled, false, '旧 classic 值必须迁移为三者皆关闭');
    assert.equal(st.radialTopbarEnabled, false);
    assert.equal(st.radialBottombarEnabled, false);
    assert.equal(st.quickMenuStyle, 'classic');
  } finally {
    hClassic.sandbox.__AGContextMeter.dispose();
  }

  // 旧反向隐藏字段 floatingOrbHidden / ag_radial_orb_hidden 迁移
  const hHidden = harness({ ag_quick_menu_style: 'floating', ag_radial_orb_hidden: 'true' });
  try {
    hHidden.finishScan();
    await hHidden.flush();
    assert.equal(hHidden.sandbox.__AGContextMeter.getRadialMenuStateForTest().radialOrbEnabled, false,
      '旧反向隐藏字段必须迁移为悬浮圆环关闭');
  } finally {
    hHidden.sandbox.__AGContextMeter.dispose();
  }

  // 冷重载持久化：三开关任意组合在重新加载后完整恢复
  const seed = {
    ag_radial_orb_enabled: 'true',
    ag_radial_topbar_enabled: 'true',
    ag_radial_bottombar_enabled: 'true'
  };
  const hReload = harness(seed);
  try {
    hReload.finishScan();
    await hReload.flush();
    const st = hReload.sandbox.__AGContextMeter.getRadialMenuStateForTest();
    assert.equal(st.radialOrbEnabled, true, '冷重载后悬浮圆环开关必须恢复');
    assert.equal(st.radialTopbarEnabled, true, '冷重载后顶栏径向开关必须恢复');
    assert.equal(st.radialBottombarEnabled, true, '冷重载后底栏径向开关必须恢复');
    assert.equal(hReload.host.getAttribute('data-radial-modes'), 'orb topbar bottombar');
  } finally {
    hReload.sandbox.__AGContextMeter.dispose();
  }
});

test('v0.9.1 模块一 / E: 新增三语词条零括号零禁用词，且分组小标题三语齐全', () => {
  const bracketRegex = /[（）\(\)]/;
  const banned = /驾驶舱|全景驾驶舱|墙钟活跃|子档未知|子檔未知/;
  const keys = [
    'settings.groups.openMode', 'settings.groups.radial', 'settings.groups.display', 'settings.groups.theme',
    'settings.quickActions.title', 'settings.quickActions.desc',
    'settings.radial.orb.title', 'settings.radial.orb.desc',
    'settings.radial.topbar.title', 'settings.radial.topbar.desc',
    'settings.radial.bottombar.title', 'settings.radial.bottombar.desc',
    'settings.quotaBadgeMode.desc', 'settings.palette.desc',
    'settings.topbarMode.label', 'settings.quotaBadgeMode.label',
    'settings.composerQuota.label', 'settings.turnFooter.label',
    'settings.autoHideTopbarDocked.label', 'settings.autoHideTopbarDocked.desc',
    'settings.dock.openRightBtn', 'settings.dock.openExternalBtn',
    'settings.dock.fbCopyUrl', 'settings.dock.fbPage'
  ];
  for (const key of keys) {
    const line = I18N_SOURCE.match(new RegExp(`'${key.replace(/\./g, '\\.')}':\\s*\\{[^}]*\\}`))?.[0] || '';
    assert.ok(line, `缺少三语词条: ${key}`);
    for (const langTag of ["'zh-CN'", "'zh-TW'", 'en']) {
      assert.ok(line.includes(langTag), `${key} 缺少 ${langTag} 语种`);
    }
    assert.doesNotMatch(line, bracketRegex, `${key} 三语词条严禁含中英文括号`);
    assert.doesNotMatch(line, banned, `${key} 三语词条含禁用旧用语`);
  }
  // 可见按钮文案不得残留旧的重复入口长句，仅允许 aria 无障碍名保留完整表述
  assert.equal(I18N_SOURCE.includes("'settings.dock.openRightBtn': { 'zh-CN': '在右侧打开当前会话'"), false,
    '可见按钮文案必须收口为短标签');
});
