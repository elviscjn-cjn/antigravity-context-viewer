'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const insightsMod = require('./src/renderer/insights-and-views.js');
const { createSidebarAccountController } = require('./src/renderer/sidebar-account.js');

function createMockDom() {
  const docListeners = new Map();
  const winListeners = new Map();

  function mkEl(tag) {
    const attrs = new Map();
    const listeners = new Map();
    const capListeners = new Map();
    const styleMap = new Map();
    let _text = '';
    let _html = '';
    const el = {
      tagName: String(tag || 'div').toUpperCase(),
      nodeType: 1,
      children: [],
      parentElement: null,
      hidden: false,
      disabled: false,
      isConnected: true,
      title: '',
      value: '',
      placeholder: '',
      type: '',
      src: '',
      alt: '',
      referrerPolicy: '',
      dataset: {},
      ownerDocument: null,
      style: new Proxy({}, {
        set(t, k, v) { t[k] = String(v); styleMap.set(k, String(v)); return true; },
        get(t, k) {
          if (k === 'setProperty') return (p, v) => { t[p] = String(v); const c = p.replace(/-([a-z])/g, (_, x) => x.toUpperCase()); t[c] = String(v); styleMap.set(p, String(v)); };
          if (k === 'removeProperty') return (p) => { delete t[p]; styleMap.delete(p); };
          if (k === 'getPropertyValue') return (p) => styleMap.get(p) || t[p] || '';
          return t[k] || '';
        }
      }),
      get id() { return attrs.get('id') || ''; },
      set id(v) { attrs.set('id', String(v || '')); },
      get className() { return attrs.get('class') || ''; },
      set className(v) { attrs.set('class', String(v || '')); },
      get textContent() {
        if (el.children.length > 0) return el.children.map((c) => c.textContent).join('');
        return _text;
      },
      set textContent(v) { el.children = []; _text = String(v ?? ''); },
      get innerHTML() { return _html; },
      set innerHTML(v) { _html = String(v ?? ''); },
      get firstChild() { return el.children[0] || null; },
      get firstElementChild() { return el.children[0] || null; },
      get nextSibling() {
        if (!el.parentElement) return null;
        const idx = el.parentElement.children.indexOf(el);
        return idx >= 0 ? (el.parentElement.children[idx + 1] || null) : null;
      },
      get nextElementSibling() { return el.nextSibling; },
      classList: {
        add(...cs) { const s = new Set(el.className.split(/\s+/).filter(Boolean)); cs.forEach((c) => c && s.add(c)); el.className = [...s].join(' '); },
        remove(...cs) { const s = new Set(el.className.split(/\s+/).filter(Boolean)); cs.forEach((c) => s.delete(c)); el.className = [...s].join(' '); },
        toggle(c, f) { const on = f === undefined ? !this.contains(c) : Boolean(f); if (on) this.add(c); else this.remove(c); return on; },
        contains(c) { return el.className.split(/\s+/).includes(c); }
      },
      setAttribute(k, v) { attrs.set(String(k), String(v)); },
      getAttribute(k) { return attrs.has(String(k)) ? attrs.get(String(k)) : null; },
      hasAttribute(k) { return attrs.has(String(k)); },
      removeAttribute(k) { attrs.delete(String(k)); },
      getBoundingClientRect() { return { left: 10, top: 680, right: 240, bottom: 720, width: 230, height: 40 }; },
      appendChild(ch) {
        if (!ch) return ch;
        if (ch.parentElement) ch.remove();
        ch.parentElement = el;
        el.children.push(ch);
        return ch;
      },
      insertBefore(ch, ref) {
        if (!ch) return ch;
        if (ch.parentElement) ch.remove();
        ch.parentElement = el;
        const idx = ref ? el.children.indexOf(ref) : -1;
        if (idx >= 0) el.children.splice(idx, 0, ch);
        else el.children.push(ch);
        return ch;
      },
      removeChild(ch) {
        const idx = el.children.indexOf(ch);
        if (idx >= 0) { el.children.splice(idx, 1); ch.parentElement = null; }
        return ch;
      },
      remove() { if (el.parentElement) el.parentElement.removeChild(el); },
      contains(node) { return node === el || el.children.some((c) => c.contains(node)); },
      matches(sel) {
        return String(sel).split(',').map((s) => s.trim()).filter(Boolean).some((part) => {
          if (part === '*') return true;
          let r = part;
          const attrRe = /\[([^\]=*^]+)(?:(\^?=|\*=)"([^"]+)")?\]/g;
          let m;
          while ((m = attrRe.exec(part)) !== null) {
            const [, k, op, val] = m;
            const actual = el.getAttribute(k);
            if (actual === null) return false;
            if (op === '=' && actual !== val) return false;
            if (op === '^=' && !actual.startsWith(val)) return false;
            if (op === '*=' && !actual.includes(val)) return false;
            r = r.replace(m[0], '');
          }
          const idM = r.match(/#([\w-]+)/);
          if (idM) { if (el.id !== idM[1]) return false; r = r.replace(idM[0], ''); }
          for (const cm of [...r.matchAll(/\.([\w-]+)/g)]) {
            if (!el.classList.contains(cm[1])) return false;
            r = r.replace(cm[0], '');
          }
          const tagPart = r.trim();
          if (tagPart && el.tagName.toLowerCase() !== tagPart.toLowerCase()) return false;
          return true;
        });
      },
      closest(sel) {
        let cur = el;
        while (cur) { if (cur.matches(sel)) return cur; cur = cur.parentElement; }
        return null;
      },
      querySelectorAll(sel) {
        const parts = String(sel).split(',').map((s) => s.trim()).filter(Boolean);
        const result = [];
        const seen = new Set();
        const collectSingle = (root, simpleSel) => {
          const list = [];
          const walk = (n) => {
            for (const c of n.children) { if (c.matches(simpleSel)) list.push(c); walk(c); }
          };
          walk(root);
          return list;
        };
        for (const p of parts) {
          const chain = p.split(/\s+/).filter(Boolean);
          let curSet = [el];
          for (const step of chain) {
            const next = [];
            for (const node of curSet) next.push(...collectSingle(node, step));
            curSet = next;
          }
          for (const hit of curSet) {
            if (!seen.has(hit)) { seen.add(hit); result.push(hit); }
          }
        }
        return result;
      },
      querySelector(sel) { return el.querySelectorAll(sel)[0] || null; },
      getElementById(id) { return el.querySelector(`#${id}`); },
      addEventListener(type, fn, capture) {
        const map = capture ? capListeners : listeners;
        if (!map.has(type)) map.set(type, new Set());
        map.get(type).add(fn);
      },
      removeEventListener(type, fn, capture) {
        (capture ? capListeners : listeners).get(type)?.delete(fn);
      },
      click() {
        if (el.disabled) return;
        const chain = [];
        let cur = el;
        while (cur) { chain.unshift(cur); cur = cur.parentElement; }
        const ev = { type: 'click', target: el, stopped: false, preventDefault() {}, stopPropagation() { this.stopped = true; } };
        for (const fn of (docListeners.get('click:capture') || [])) fn(ev);
        for (const node of chain) {
          for (const fn of (node._capListeners?.get('click') || [])) fn(ev);
          if (ev.stopped) return;
        }
        for (let i = chain.length - 1; i >= 0; i--) {
          for (const fn of (chain[i]._listeners?.get('click') || [])) fn(ev);
          if (ev.stopped) return;
        }
      },
      _listeners: listeners,
      _capListeners: capListeners
    };
    return el;
  }

  const head = mkEl('head');
  const body = mkEl('body');
  const doc = {
    head,
    body,
    documentElement: body,
    activeElement: null,
    createElement: (tag) => { const n = mkEl(tag); n.ownerDocument = doc; return n; },
    createElementNS: (_ns, tag) => { const n = mkEl(tag); n.ownerDocument = doc; return n; },
    getElementById: (id) => head.getElementById(id) || body.getElementById(id),
    querySelector: (sel) => body.querySelector(sel) || head.querySelector(sel),
    querySelectorAll: (sel) => [...head.querySelectorAll(sel), ...body.querySelectorAll(sel)],
    addEventListener(type, fn, capture) {
      const k = capture ? `${type}:capture` : type;
      if (!docListeners.has(k)) docListeners.set(k, new Set());
      docListeners.get(k).add(fn);
    },
    removeEventListener(type, fn, capture) {
      docListeners.get(capture ? `${type}:capture` : type)?.delete(fn);
    }
  };
  head.ownerDocument = doc;
  body.ownerDocument = doc;

  const win = {
    innerWidth: 1280,
    innerHeight: 800,
    getComputedStyle: () => ({ position: 'relative', backgroundColor: 'rgb(20, 20, 22)', fontSize: '13px', fontWeight: '400' }),
    addEventListener(type, fn) {
      if (!winListeners.has(type)) winListeners.set(type, new Set());
      winListeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      winListeners.get(type)?.delete(fn);
    },
    dispatchEvent(ev) {
      const set = winListeners.get(ev?.type);
      if (!set) return false;
      for (const fn of [...set]) fn(ev);
      return true;
    }
  };

  return { doc, win };
}

function buildSampleTokenData() {
  return {
    firstUseDate: '2026-11-18',
    summary: {
      grandTotalTokens: 1250000,
      totalInputTokens: 300000,
      totalCacheTokens: 800000,
      totalOutputTokens: 150000,
      totalConversations: 3
    },
    dailyMap: {
      '2026-11-18': { total: 200000, input: 50000, cache: 120000, output: 30000, steps: 6 },
      '2026-11-19': { total: 350000, input: 80000, cache: 230000, output: 40000, steps: 9 },
      '2026-11-20': { total: 500000, input: 120000, cache: 330000, output: 50000, steps: 14 },
      '2026-11-21': { total: 200000, input: 50000, cache: 120000, output: 30000, steps: 5 }
    },
    dailyMapBySource: {
      all: {
        '2026-11-18': { total: 200000, input: 50000, cache: 120000, output: 30000, steps: 6 },
        '2026-11-19': { total: 350000, input: 80000, cache: 230000, output: 40000, steps: 9 },
        '2026-11-20': { total: 500000, input: 120000, cache: 330000, output: 50000, steps: 14 },
        '2026-11-21': { total: 200000, input: 50000, cache: 120000, output: 30000, steps: 5 }
      },
      desktop: {
        '2026-11-18': { total: 150000, input: 40000, cache: 90000, output: 20000, steps: 4 },
        '2026-11-19': { total: 250000, input: 60000, cache: 160000, output: 30000, steps: 6 },
        '2026-11-20': { total: 400000, input: 95000, cache: 265000, output: 40000, steps: 10 },
        '2026-11-21': { total: 150000, input: 35000, cache: 95000, output: 20000, steps: 3 }
      },
      cli: {
        '2026-11-18': { total: 50000, input: 10000, cache: 30000, output: 10000, steps: 2 },
        '2026-11-19': { total: 100000, input: 20000, cache: 70000, output: 10000, steps: 3 },
        '2026-11-20': { total: 100000, input: 25000, cache: 65000, output: 10000, steps: 4 },
        '2026-11-21': { total: 50000, input: 15000, cache: 25000, output: 10000, steps: 2 }
      }
    },
    dailyModelMap: {
      '2026-11-20': {
        'gemini-3.5-pro': { total: 400000, input: 90000, cache: 270000, output: 40000 },
        'claude-sonnet-4': { total: 100000, input: 30000, cache: 60000, output: 10000 }
      }
    },
    speedRecords: [
      { durationMs: 4200, ttftMs: 650, tps: 88.5 },
      { durationMs: 18500, ttftMs: 920, tps: 72.1 }
    ],
    recentRequestLogs: [
      { cascadeId: 's-1', date: '2026-11-20', reasoningEffort: 'high', durationMs: 18500 },
      { cascadeId: 's-2', date: '2026-11-21', reasoningEffort: 'medium', durationMs: 4200 }
    ],
    referenceCost: {
      all: {
        totalCostUSD: 2.35,
        matchedTier: { inputPerMillion: 1.25, cacheReadPerMillion: 0.125, outputPerMillion: 5.0 }
      }
    },
    crossSessionInsights: {
      dailyInsights: {
        '2026-11-18': { tokens: 200000, input: 50000, cache: 120000, output: 30000, costUSD: 0.35, calls: 6, sessions: 1, cacheReadPct: 70.6 },
        '2026-11-19': { tokens: 350000, input: 80000, cache: 230000, output: 40000, costUSD: 0.62, calls: 9, sessions: 1, cacheReadPct: 74.2 },
        '2026-11-20': { tokens: 500000, input: 120000, cache: 330000, output: 50000, costUSD: 0.98, calls: 14, sessions: 2, cacheReadPct: 73.3 },
        '2026-11-21': { tokens: 200000, input: 50000, cache: 120000, output: 30000, costUSD: 0.40, calls: 5, sessions: 1, cacheReadPct: 70.6 }
      },
      topTools: [
        { name: 'read_file', count: 18, byDate: { '2026-11-20': 12, '2026-11-21': 6 } },
        { name: 'edit_file', count: 9, byDate: { '2026-11-20': 6, '2026-11-21': 3 } }
      ],
      topSkills: [
        { name: 'tdd', count: 4, byDate: { '2026-11-20': 3, '2026-11-21': 1 } },
        { name: 'diagnosing-bugs', count: 2, byDate: { '2026-11-21': 2 } }
      ],
      topCommands: [
        { program: 'node', count: 11, byDate: { '2026-11-21': 5 } }
      ],
      sessionArchives: [
        {
          cascadeId: 's-1',
          title: 'Refactor Context Details View',
          date: '2026-11-20',
          updatedAt: 2000,
          workspaceTag: 'AntigravityContextMeter',
          modelLabel: 'gemini-3.5-pro',
          totalTokens: 700000,
          inputTokens: 170000,
          cacheReadTokens: 450000,
          outputTokens: 80000,
          costUSD: 1.35,
          cacheReadPct: 72.6,
          callCount: 14,
          source: 'desktop'
        },
        {
          cascadeId: 's-2',
          title: 'CLI Token Sync Audit',
          date: '2026-11-21',
          updatedAt: 3000,
          workspaceTag: 'AntigravityCLI',
          modelLabel: 'claude-sonnet-4',
          totalTokens: 350000,
          inputTokens: 80000,
          cacheReadTokens: 220000,
          outputTokens: 50000,
          costUSD: 0.65,
          cacheReadPct: 73.3,
          callCount: 8,
          source: 'cli'
        }
      ]
    }
  };
}

test('1. 三语文案严格零括号 & 导航改名为 详细上下文 / 詳細上下文 / Context Details', () => {
  const walkStrings = (obj, pathPrefix = '') => {
    for (const [k, v] of Object.entries(obj)) {
      const p = pathPrefix ? `${pathPrefix}.${k}` : k;
      if (typeof v === 'string') {
        assert.doesNotMatch(v, /[()（）]/, `INSIGHTS_I18N.${p} 不允许包含中英文括号: ${v}`);
      } else if (v && typeof v === 'object') {
        walkStrings(v, p);
      }
    }
  };
  walkStrings(insightsMod.INSIGHTS_I18N);

  assert.equal(insightsMod.getInsightsCopy('zh-CN').sidebarNavLabel, '详细上下文');
  assert.equal(insightsMod.getInsightsCopy('zh-CN').pageTitle, '详细上下文');
  assert.equal(insightsMod.getInsightsCopy('zh-TW').sidebarNavLabel, '詳細上下文');
  assert.equal(insightsMod.getInsightsCopy('zh-TW').pageTitle, '詳細上下文');
  assert.equal(insightsMod.getInsightsCopy('en').sidebarNavLabel, 'Context Details');
  assert.equal(insightsMod.getInsightsCopy('en').pageTitle, 'Context Details');

  // 校验 i18n.js 新增词条严格零括号
  const i18nSrc = fs.readFileSync(path.join(__dirname, 'src/renderer/i18n.js'), 'utf8');
  for (const key of [
    'sidebarAccount.openProfileHome',
    'sidebarAccount.profileHomeMenu',
    'contextDetails.navLabel',
    'contextDetails.title',
    'contextDetails.subtitle',
    'profileHome.title',
    'profileHome.refresh',
    'profileHome.backToChat'
  ]) {
    const line = i18nSrc.split(/\r?\n/).find((l) => l.includes(`'${key}'`));
    assert.ok(line, `i18n.js 必须包含词条 ${key}`);
    assert.doesNotMatch(line, /[()（）]/, `i18n.js 新增词条 ${key} 严禁出现中英文括号`);
  }
});

test('2. 热力图方向铁律：严格从左往右排列推进，第 1 列即用户最早记录起点，绝无左侧大片空灰列', () => {
  const dailyMap = {
    '2026-11-18': { total: 200000 },
    '2026-11-19': { total: 350000 },
    '2026-11-20': { total: 500000 },
    '2026-11-21': { total: 150000 }
  };
  const model = insightsMod.buildLeftToRightHeatmapModel(dailyMap, {
    firstUseDate: '2026-11-18',
    todayStr: '2026-11-21',
    metric: 'tokens',
    minWeeks: 14,
    maxWeeks: 52
  });

  assert.equal(model.direction, 'ltr');
  assert.equal(model.earliestDate, '2026-11-18');
  // 第 1 列必须直接包含最早活跃日期 2026-11-18，绝不能在左侧填充空周
  const col0Dates = model.columns[0].days.map((d) => d.date);
  assert.ok(col0Dates.includes('2026-11-18'), `第 1 列应包含起点 2026-11-18，实际为 ${col0Dates.join(',')}`);
  assert.ok(model.columns[0].total > 0, '第 1 列必须有真实活跃数据，不能是空灰列');

  // 列日期必须严格从左往右递增
  for (let i = 1; i < model.columns.length; i++) {
    assert.ok(
      model.columns[i].startDate > model.columns[i - 1].startDate,
      `第 ${i} 列起始日期必须晚于第 ${i - 1} 列`
    );
  }
  // 累计序列必须严格从左往右单调不减
  assert.ok(model.cumulativePoints.length >= 4);
  for (let i = 1; i < model.cumulativePoints.length; i++) {
    assert.ok(model.cumulativePoints[i].date > model.cumulativePoints[i - 1].date);
    assert.ok(model.cumulativePoints[i].cumulativeTotal >= model.cumulativePoints[i - 1].cumulativeTotal);
  }
});

test('3. 全页「详细上下文」接通真实本地账本（桌面 + CLI），根治全 0 空壳，z-index 严格为 20', () => {
  const { doc, win } = createMockDom();
  const sidebar = doc.createElement('aside');
  const btnPlugins = doc.createElement('button');
  btnPlugins.setAttribute('data-testid', 'plugins-button');
  btnPlugins.textContent = 'Customizations';
  const btnProjects = doc.createElement('button');
  btnProjects.textContent = 'Projects';
  sidebar.appendChild(btnPlugins);
  sidebar.appendChild(btnProjects);

  const mainArea = doc.createElement('main');
  mainArea.setAttribute('data-testid', 'main-content');
  doc.body.appendChild(sidebar);
  doc.body.appendChild(mainArea);

  const openedSessions = [];
  const ctrl = insightsMod.createSidebarInsightsHostController({
    document: doc,
    window: win,
    lang: 'zh-CN',
    // 模拟原 main.js 传入空 summary/sessions 的场景，验证仍能从 tokenData 完整打通
    getInsightsData: () => ({ summary: {}, sessions: [], heatmapCells: [] }),
    tokenData: buildSampleTokenData(),
    liveState: { latest: { cacheHitPct: 78.5 } },
    accountState: {
      activeAccount: {
        name: 'Elvis',
        email: 'elvis@example.com',
        planLabel: 'Google AI Ultra'
      },
      accounts: []
    },
    onOpenSession: (s) => openedSessions.push(s.sessionId)
  });

  assert.equal(ctrl.syncMount('zh-CN'), true);
  assert.equal(ctrl.getButtonEl().textContent, '详细上下文');
  assert.equal(insightsMod.FULLPAGE_Z_INDEX, 20);
  assert.match(insightsMod.SIDEBAR_INSIGHTS_HOST_CSS, /z-index:\s*20\s*!important/);

  // 通过跨模块事件打开详细上下文
  win.dispatchEvent({ type: 'ag-open-context-details' });
  const pageEl = ctrl.getPageEl();
  assert.ok(pageEl && !pageEl.hidden);

  // 校验 6 大 KPI 全部非 0 真实数据
  const kpiVal = (key) => pageEl.querySelector(`[data-kpi-key="${key}"] .ag-ci-kpi-val`)?.textContent;
  assert.equal(kpiVal('sessions'), '2');
  assert.equal(kpiVal('tokens'), '1.25M');
  assert.equal(kpiVal('cost'), '$2.35');
  assert.equal(kpiVal('cache'), '72.7%');
  assert.equal(kpiVal('tools'), '27');
  assert.notEqual(kpiVal('active'), '--');

  // 校验近 7 天柱状图、从左往右热力图、会话明细可点击跳转
  assert.ok(pageEl.querySelector('[data-ag-ci-7d-chart="true"]'));
  assert.equal(pageEl.querySelector('[data-heatmap-direction="ltr"]')?.getAttribute('data-heatmap-direction'), 'ltr');

  // 回归校验：停留在「详细上下文」时点击左栏底部账号胶囊 (#ag-sidebar-account-host) 或侧栏空白处，严禁误关全页
  sidebar.setAttribute('data-testid', 'sidebar');
  const acctHost = doc.createElement('div');
  acctHost.id = 'ag-sidebar-account-host';
  acctHost.setAttribute('data-ag-sidebar-account', 'true');
  const acctInnerBtn = doc.createElement('button');
  acctHost.appendChild(acctInnerBtn);
  sidebar.appendChild(acctHost);
  acctInnerBtn.click();
  assert.equal(pageEl.hidden, false, '点击左下角账号胶囊展开菜单时，详细上下文全页必须保持打开在底层');
  sidebar.click();
  assert.equal(pageEl.hidden, false, '点击侧栏容器自身空白处时，详细上下文全页不得误关');

  const firstSessionRow = pageEl.querySelector('.ag-ci-session-row');
  assert.ok(firstSessionRow);
  firstSessionRow.click();
  assert.deepEqual(openedSessions, ['s-1']);
  assert.equal(pageEl.hidden, true);
  ctrl.destroy();
});

test('4. 个人 Token 用量主页：核心 5 项数据条 + 从左往右热力图三模式切换 + 全量缓存归拢 + 底部极简洞察', () => {
  const { doc, win } = createMockDom();
  const sidebar = doc.createElement('aside');
  const btnPlugins = doc.createElement('button');
  btnPlugins.setAttribute('data-testid', 'plugins-button');
  btnPlugins.textContent = 'Customizations';
  sidebar.appendChild(btnPlugins);
  const mainArea = doc.createElement('main');
  mainArea.setAttribute('data-testid', 'main-content');
  doc.body.appendChild(sidebar);
  doc.body.appendChild(mainArea);

  const ctrl = insightsMod.createSidebarInsightsHostController({
    document: doc,
    window: win,
    lang: 'zh-CN',
    tokenData: buildSampleTokenData(),
    liveState: { latest: { cacheHitPct: 78.5 } },
    accountState: {
      activeAccount: {
        name: 'Elvis',
        email: 'elvis@example.com',
        planLabel: 'Google AI Ultra',
        profilePictureUrl: 'https://example.com/avatar.png'
      },
      accounts: []
    }
  });
  ctrl.syncMount('zh-CN');

  // 跨模块全局挂载 API 校验
  assert.equal(typeof win.__agContextMeterViews?.openProfileHome, 'function');
  assert.equal(typeof win.__agContextMeterViews?.closeProfileHome, 'function');
  assert.equal(typeof win.__agContextMeterViews?.openContextDetails, 'function');
  assert.equal(typeof win.__agContextMeterViews?.closeContextDetails, 'function');

  // 通过自定义事件打开个人主页
  win.dispatchEvent({ type: 'ag-open-profile-home', detail: { source: 'sidebar-avatar' } });
  const profileEl = ctrl.getProfilePageEl();
  assert.ok(profileEl && !profileEl.hidden);

  // 顶部右侧仅保留刷新/返回按钮，严禁无关编辑/分享/精选作品
  const topActions = profileEl.querySelectorAll('.ag-ph-topbar button').map((b) => b.getAttribute('data-ag-ph-action'));
  assert.deepEqual(topActions, ['refresh', 'back']);

  // 5 项核心数据胶囊条
  const statVal = (key) => profileEl.querySelector(`[data-stat-key="${key}"] .ag-ph-stat-val`)?.textContent;
  assert.equal(statVal('totalTokens'), '1.25M');
  assert.equal(statVal('peakTokens'), '500.0K');
  assert.equal(statVal('longestTask'), '18.5s');
  assert.equal(statVal('longestStreak'), '4 天');

  // 热力图严格从左往右 + 支持 每天 / 每周 / 累计总量 切换
  const heatCard = profileEl.querySelector('[data-ag-ph-heatmap="true"]');
  assert.equal(heatCard.getAttribute('data-heatmap-direction'), 'ltr');
  assert.equal(heatCard.getAttribute('data-heatmap-mode'), 'daily');
  profileEl.querySelector('[data-heat-mode="weekly"]').click();
  assert.equal(profileEl.querySelector('[data-ag-ph-heatmap="true"]').getAttribute('data-heatmap-mode'), 'weekly');
  assert.ok(profileEl.querySelector('[data-weekly-bars="true"]'));
  profileEl.querySelector('[data-heat-mode="cumulative"]').click();
  assert.equal(profileEl.querySelector('[data-ag-ph-heatmap="true"]').getAttribute('data-heatmap-mode'), 'cumulative');
  assert.ok(profileEl.querySelector('[data-cumulative-bars="true"]'));

  // 全量缓存总览
  const cacheVal = (key) => profileEl.querySelector(`[data-cache-key="${key}"] .ag-ph-cache-val`)?.textContent;
  assert.equal(cacheVal('globalHit'), '72.7%');
  assert.equal(cacheVal('sessionHit'), '78.5%');
  assert.equal(cacheVal('cacheRead'), '800.0K');
  assert.equal(cacheVal('uncachedInput'), '300.0K');
  assert.notEqual(cacheVal('savedUsd'), '$0.00');

  // 底部极简洞察明细（非空真实指标）
  const insightsText = profileEl.querySelector('[data-ag-ph-insights="true"]').textContent;
  assert.match(insightsText, /gemini-3\.5-pro/);
  assert.match(insightsText, /high 50%/);
  assert.match(insightsText, /27/);

  // 互斥：打开详细上下文时自动关闭个人主页
  win.__agContextMeterViews.openContextDetails();
  assert.equal(ctrl.getState().profileVisible, false);
  assert.equal(ctrl.getState().pageVisible, true);
  ctrl.destroy();
});

test('5. 左下角账号胶囊：顶层 Portal z-index 2147483646 防遮挡 + 头像直达个人主页 + 折叠态保切号', () => {
  // 构造支持 ShadowRoot 的轻量 DOM 环境
  const { doc, win } = createMockDom();
  const attachShadowPoly = (node) => {
    node.attachShadow = () => {
      const sr = doc.createElement('shadow-root');
      sr.activeElement = null;
      node.shadowRoot = sr;
      return sr;
    };
    return node;
  };
  const origCreate = doc.createElement;
  doc.createElement = (tag) => {
    const el = attachShadowPoly(origCreate(tag));
    // 简易解析 buildTriggerMarkup / buildPopoverMarkup 中的关键 id 节点
    let _rawHtml = '';
    Object.defineProperty(el, 'innerHTML', {
      get: () => _rawHtml,
      set: (val) => {
        _rawHtml = String(val || '');
        el.children = [];
        if (_rawHtml.includes('ag-sa-anchor')) {
          const anchor = origCreate('div'); anchor.id = 'ag-sa-anchor';
          const trig = origCreate('button'); trig.id = 'ag-sa-trigger';
          const av = origCreate('span'); av.id = 'ag-sa-avatar';
          const avTxt = origCreate('span'); avTxt.id = 'ag-sa-avatar-text';
          const dot = origCreate('span'); dot.id = 'ag-sa-status-dot';
          av.appendChild(avTxt); av.appendChild(dot);
          const nm = origCreate('span'); nm.id = 'ag-sa-name';
          const pl = origCreate('span'); pl.id = 'ag-sa-plan';
          const sb = origCreate('span'); sb.id = 'ag-sa-sub';
          trig.appendChild(av); trig.appendChild(nm); trig.appendChild(pl); trig.appendChild(sb);
          anchor.appendChild(trig);
          el.appendChild(anchor);
        } else if (_rawHtml.includes('ag-sa-popover')) {
          const pop = origCreate('div'); pop.id = 'ag-sa-popover'; pop.hidden = true;
          const ttl = origCreate('span'); ttl.id = 'ag-sa-pop-title';
          const cnt = origCreate('span'); cnt.id = 'ag-sa-pop-count';
          const list = origCreate('div'); list.id = 'ag-sa-list';
          const pill = origCreate('div'); pill.id = 'ag-sa-hover-pill';
          list.appendChild(pill);
          const fb = origCreate('div'); fb.id = 'ag-sa-feedback';
          const bProf = origCreate('button'); bProf.id = 'ag-sa-act-profile';
          const bRef = origCreate('button'); bRef.id = 'ag-sa-act-refresh';
          const bAdd = origCreate('button'); bAdd.id = 'ag-sa-act-add';
          const bAcc = origCreate('button'); bAcc.id = 'ag-sa-act-accounts';
          const bSet = origCreate('button'); bSet.id = 'ag-sa-act-settings';
          pop.appendChild(ttl); pop.appendChild(cnt); pop.appendChild(list); pop.appendChild(fb);
          pop.appendChild(bProf); pop.appendChild(bRef); pop.appendChild(bAdd); pop.appendChild(bAcc); pop.appendChild(bSet);
          el.appendChild(pop);
        }
      }
    });
    return el;
  };

  const prevDoc = global.document;
  const prevWin = global.window;
  global.document = doc;
  global.window = win;

  try {
    const sidebarFooter = doc.createElement('div');
    sidebarFooter.getBoundingClientRect = () => ({ left: 0, top: 680, width: 240, height: 48 });
    const nativeSettingsBtn = doc.createElement('button');
    nativeSettingsBtn.setAttribute('data-testid', 'settings-button');
    sidebarFooter.appendChild(nativeSettingsBtn);
    doc.body.appendChild(sidebarFooter);

    let profileOpenedCount = 0;
    const ctrl = createSidebarAccountController({
      t: (k) => k,
      getState: () => ({
        accounts: [{ accountId: 'a1', email: 'elvis@example.com', name: 'Elvis', isActive: true }],
        activeAccount: { accountId: 'a1', email: 'elvis@example.com', name: 'Elvis', isActive: true }
      }),
      onOpenProfileHome: () => { profileOpenedCount += 1; }
    });

    assert.equal(ctrl.start({ watchDom: false }), true);
    const st = ctrl.getStateForTest();
    assert.equal(st.popoverInBodyPortal, true, '上拉菜单必须挂载到 document.body 顶层 Portal');
    assert.equal(st.popoverZIndex, 2147483646);
    assert.ok(st.popoverZIndex > insightsMod.FULLPAGE_Z_INDEX, '账号菜单 z-index 必须严格高于全页视图');

    // 兼容检查：通过原 shadowRoot 仍能查到 ag-sa-popover
    assert.ok(ctrl.getShadowRoot().getElementById('ag-sa-popover'));

    // 展开态（v3 7.7 铁律）：点击头像仍打开账号切换上拉菜单不砍切号功能，点击菜单顶部个人用量主页项进入个人主页
    const avatarEl = ctrl.getShadowRoot().getElementById('ag-sa-avatar');
    avatarEl.click();
    assert.equal(profileOpenedCount, 0, '单击头像必须保持打开账号切换上拉菜单，不直接跳转个人主页');
    assert.equal(ctrl.getStateForTest().menuOpen, true);
    const profileActBtn = ctrl.getShadowRoot().getElementById('ag-sa-act-profile');
    assert.ok(profileActBtn, '账号上拉菜单顶部必须提供个人用量主页入口 #ag-sa-act-profile');
    profileActBtn.click();
    assert.equal(profileOpenedCount, 1);
    assert.equal(ctrl.getStateForTest().menuOpen, false);

    // 点击胶囊其余区域正常打开快捷切号菜单
    ctrl.getShadowRoot().getElementById('ag-sa-trigger').click();
    assert.equal(ctrl.getStateForTest().menuOpen, true);
    ctrl.closeMenu(false, true);

    // 折叠为仅剩头像的紧凑模式：点击头像保留快捷切号入口不失效
    sidebarFooter.getBoundingClientRect = () => ({ left: 0, top: 680, width: 56, height: 48 });
    ctrl.render();
    assert.equal(ctrl.getStateForTest().compactMode, true);
    avatarEl.click();
    assert.equal(profileOpenedCount, 1, '折叠态点击头像不应劫持切号菜单');
    assert.equal(ctrl.getStateForTest().menuOpen, true, '折叠态点击头像应正常打开快捷切号菜单');

    ctrl.dispose();
  } finally {
    global.document = prevDoc;
    global.window = prevWin;
  }
});
