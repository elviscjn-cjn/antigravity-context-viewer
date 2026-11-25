const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const core = require('./meter-core');
const collector = require('./meter-collector');

const RENDERER_SOURCE = fs.readFileSync(path.join(__dirname, 'meter-renderer.js'), 'utf8');

function makeNode(tagName = 'div') {
  const attrs = new Map();
  const listeners = new Map();
  const styleProps = new Map();
  const node = {
    tagName: String(tagName).toUpperCase(),
    children: [],
    _listeners: listeners,
    hidden: false,
    disabled: false,
    checked: false,
    value: '',
    textContent: '',
    innerHTML: '',
    parentElement: null,
    style: {
      display: '',
      opacity: '',
      background: '',
      top: '',
      left: '',
      right: '',
      position: '',
      setProperty(k, v) { styleProps.set(k, String(v)); },
      removeProperty(k) { styleProps.delete(k); },
      getPropertyValue(k) { return styleProps.get(k) || ''; }
    },
    get id() { return attrs.get('id') || ''; },
    set id(v) { attrs.set('id', String(v || '')); },
    get className() { return attrs.get('class') || ''; },
    set className(v) { attrs.set('class', String(v || '')); },
    classList: {
      add(c) {
        const cur = (attrs.get('class') || '').split(/\s+/).filter(Boolean);
        if (!cur.includes(c)) cur.push(c);
        attrs.set('class', cur.join(' '));
      },
      remove(c) {
        const cur = (attrs.get('class') || '').split(/\s+/).filter(x => x && x !== c);
        attrs.set('class', cur.join(' '));
      },
      toggle(c, force) {
        const cur = new Set((attrs.get('class') || '').split(/\s+/).filter(Boolean));
        const shouldAdd = force === undefined ? !cur.has(c) : Boolean(force);
        if (shouldAdd) cur.add(c);
        else cur.delete(c);
        attrs.set('class', Array.from(cur).join(' '));
        return shouldAdd;
      },
      contains(c) {
        return (attrs.get('class') || '').split(/\s+/).includes(c);
      }
    },
    setAttribute(k, v) { attrs.set(k, String(v)); },
    getAttribute(k) { return attrs.has(k) ? attrs.get(k) : null; },
    removeAttribute(k) { attrs.delete(k); },
    appendChild(child) {
      if (!child) return child;
      child.parentElement = this;
      this.children.push(child);
      return child;
    },
    insertBefore(child, ref) {
      if (!child) return child;
      child.parentElement = this;
      const idx = this.children.indexOf(ref);
      if (idx >= 0) this.children.splice(idx, 0, child);
      else this.children.unshift(child);
      return child;
    },
    replaceChildren(...next) {
      this.children = [];
      for (const n of next) {
        if (n) {
          n.parentElement = this;
          this.children.push(n);
        }
      }
    },
    remove() {
      if (this.parentElement && Array.isArray(this.parentElement.children)) {
        const idx = this.parentElement.children.indexOf(this);
        if (idx >= 0) this.parentElement.children.splice(idx, 1);
      }
      this.parentElement = null;
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    dispatchEvent(ev) {
      const t = ev?.type || ev;
      const evObj = {
        target: this,
        preventDefault() {},
        stopPropagation() { this._stopped = true; },
        ...(typeof ev === 'object' ? ev : {}),
        currentTarget: this
      };
      let cur = this;
      while (cur && !evObj._stopped) {
        const list = cur._listeners?.get(t) || [];
        evObj.currentTarget = cur;
        for (const fn of list) fn(evObj);
        if (t !== 'click') break;
        cur = cur.parentElement;
      }
    },
    click() {
      this.dispatchEvent({ type: 'click', target: this });
    },
    trigger(type, extra = {}) {
      this.dispatchEvent({ type, target: this, ...extra });
    },
    closest(selector) {
      const mAttr = selector.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);
      const mClass = selector.startsWith('.') ? selector.slice(1) : null;
      const mId = selector.startsWith('#') ? selector.slice(1) : null;
      let cur = this;
      while (cur) {
        if (mId && cur.id === mId) return cur;
        if (mClass && cur.classList?.contains?.(mClass)) return cur;
        if (mAttr) {
          const val = cur.getAttribute?.(mAttr[1]);
          if (mAttr[2] !== undefined ? val === mAttr[2] : val !== null) return cur;
        }
        cur = cur.parentElement;
      }
      return null;
    },
    querySelectorAll(sel) {
      const parts = sel.split(',').map(s => s.trim()).filter(Boolean);
      const out = [];
      const matchesOne = (n, s) => {
        if (!n || typeof n.getAttribute !== 'function') return false;
        const mAttr = s.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);
        if (mAttr) {
          const v = n.getAttribute(mAttr[1]);
          return mAttr[2] !== undefined ? v === mAttr[2] : v !== null;
        }
        if (s.startsWith('.')) return Boolean(n.classList?.contains?.(s.slice(1)));
        if (s.startsWith('#')) return n.id === s.slice(1);
        return false;
      };
      const walk = (rootNode) => {
        for (const ch of (rootNode.children || [])) {
          if (parts.some(p => matchesOne(ch, p))) out.push(ch);
          walk(ch);
        }
      };
      walk(this);
      return out;
    },
    querySelector(sel) {
      return this.querySelectorAll(sel)[0] || null;
    },
    getBoundingClientRect() { return { top: 20, left: 20, right: 420, bottom: 300, width: 400, height: 280 }; }
  };
  return node;
}

function createElv9899Harness({ storageMap = new Map(), settingsResponse = null, timelineData = null, latestCall = null } = {}) {
  const byId = new Map();
  const ensureEl = (id, tag = 'div') => {
    if (!id) return makeNode(tag);
    if (!byId.has(id)) {
      const n = makeNode(tag);
      n.id = id;
      byId.set(id, n);
    }
    return byId.get(id);
  };

  // 预建需要测试子DOM和容器结构的组件树
  const reqSortBar = ensureEl('req-sort-bar');
  [
    ['req-sort-time', 'time_desc'],
    ['req-sort-tokens', 'tokens_desc'],
    ['req-sort-cost', 'cost_desc'],
    ['req-sort-duration', 'duration_desc'],
    ['req-sort-speed', 'speed_desc']
  ].forEach(([id, val]) => {
    const b = ensureEl(id, 'button');
    b.setAttribute('data-req-sort', val);
    reqSortBar.appendChild(b);
  });

  const tlSortGroup = ensureEl('timeline-sort-group');
  [
    ['tl-sort-newest', 'newest'],
    ['tl-sort-oldest', 'oldest'],
    ['tl-sort-delta', 'delta_desc']
  ].forEach(([id, val]) => {
    const b = ensureEl(id, 'button');
    b.setAttribute('data-tl-sort', val);
    tlSortGroup.appendChild(b);
  });
  const tlInsightBar = ensureEl('timeline-insight-bar');
  tlInsightBar.appendChild(tlSortGroup);
  const tlDeltaBtn = ensureEl('btn-timeline-delta-mode', 'button');
  tlInsightBar.appendChild(tlDeltaBtn);

  ensureEl('speed-range-7d', 'button');
  ensureEl('speed-range-30d', 'button');
  ensureEl('speed-range-all', 'button');
  ensureEl('model-period-7d', 'button');
  ensureEl('model-period-30d', 'button');
  ensureEl('cost-btn-scope-period', 'button');
  ensureEl('cost-btn-scope-all', 'button');
  ['daily', 'weekly', 'monthly', 'yearly', 'cum'].forEach(v => {
    ensureEl(`h-tab-${v}`, 'button');
    ensureEl(`h-${v}-box`, 'div');
  });

  const docBody = makeNode('body');
  const docEl = makeNode('html');
  const savedPayloads = [];
  const intervals = [];

  const shadowRoot = {
    innerHTML: '',
    getElementById: (id) => ensureEl(id),
    querySelectorAll: (sel) => {
      const out = [];
      for (const node of byId.values()) {
        if (sel.includes('data-i18n') && node.getAttribute('data-i18n')) out.push(node);
      }
      return out;
    }
  };

  const sandbox = {
    console, Math, Date, JSON, Number, String, Boolean, Array, Object, Set, Map, RegExp, Promise, Error, AbortController,
    fetch: async () => ({ ok: false, status: 404, json: async () => ({}) }),
    setTimeout, clearTimeout,
    setInterval(fn) { intervals.push(fn); return intervals.length; },
    clearInterval() {},
    localStorage: {
      getItem: (k) => (storageMap.has(k) ? storageMap.get(k) : null),
      setItem: (k, v) => storageMap.set(k, String(v)),
      removeItem: (k) => storageMap.delete(k)
    },
    location: { protocol: 'https:', hostname: '127.0.0.1', pathname: '/c/98990000-0000-4000-8000-000000000001', search: '' },
    document: {
      hidden: false,
      body: docBody,
      documentElement: docEl,
      createElement: (tag) => {
        if (tag === 'div') {
          const d = makeNode('div');
          d.attachShadow = () => shadowRoot;
          return d;
        }
        return makeNode(tag);
      },
      createElementNS: (_ns, tag) => makeNode(tag),
      createTextNode: (txt) => ({ nodeType: 3, textContent: String(txt || '') }),
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
      removeEventListener() {}
    },
    window: {
      innerWidth: 1280,
      innerHeight: 900,
      addEventListener() {},
      removeEventListener() {},
      contextMeterAPI: {
        scan: async () => ({
          ok: true,
          data: {
            scannedAt: Date.now(),
            session: {
              groups: Object.fromEntries(['user', 'assistant', 'thinking', 'tools', 'summaries', 'system', 'definitions'].map(k => [k, core.empty()])),
              total: { chars: 1000, low: 250, high: 350 },
              attachmentTotal: core.empty(),
              attachments: [],
              unknownFiles: 0,
              steps: 4,
              userMessages: 2,
              assistantMessages: 2
            },
            latest: latestCall || null,
            recentGeneratorCalls: []
          }
        }),
        getSettings: async () => settingsResponse || { ok: true },
        saveSettings: async (payload) => { savedPayloads.push(payload); return { ok: true }; },
        getTokenHistory: async () => ({ ok: true, data: { dailyMap: {}, summary: { grandTotalTokens: 0 }, accountTotals: {} } }),
        getSessionTimeline: async () => ({ ok: true, data: timelineData || { turns: [], totalCalls: 0 } })
      }
    }
  };
  sandbox.globalThis = sandbox;
  sandbox.__AGContextMeterCore = core;
  vm.createContext(sandbox);
  vm.runInContext(RENDERER_SOURCE, sandbox);

  return {
    sandbox,
    byId,
    ensureEl,
    savedPayloads,
    storageMap,
    flush: async () => {
      for (let i = 0; i < 6; i++) await new Promise(r => setImmediate(r));
    },
    tick: () => { for (const fn of intervals) fn(); }
  };
}

test('ELV-98: meter-core buildContextTrendSeries 支持总量/增量、逐调用/逐轮、口径标识与截断计数', () => {
  const timeline = core.groupSessionCallsByTurns([
    { stepIndex: 0, text: 'First user prompt' },
    { stepIndex: 2, text: 'Second user prompt' }
  ], [
    { callId: 'c1', stepIndex: 1, inputTokens: 1000, cacheReadTokens: 2000, outputTokens: 200, modelExactId: 'gemini-4-hydrogen', modelLabel: 'Gemini 4 Hydrogen' },
    { callId: 'c2', stepIndex: 1, inputTokens: 500, cacheReadTokens: 4500, outputTokens: 300, modelExactId: 'gemini-4-hydrogen', modelLabel: 'Gemini 4 Hydrogen' },
    { callId: 'c3', stepIndex: 3, inputTokens: 800, cacheReadTokens: 1200, outputTokens: 100, modelExactId: 'gemini-3.8-flash', modelLabel: 'Gemini 3.8 Flash' }
  ], { cascadeId: 'cid-trend-1' });

  // 逐调用 总量 & 增量与 groupSessionCallsByTurns deltaFromPrevStep 严格一致
  const stepSeries = core.buildContextTrendSeries(timeline, { mode: 'delta', granularity: 'step' });
  assert.equal(stepSeries.basis, 'server_usage');
  assert.equal(stepSeries.points.length, 3);
  assert.equal(stepSeries.points[0].totalContextTokens, 3000);
  assert.equal(stepSeries.points[1].totalContextTokens, 5000);
  assert.equal(stepSeries.points[1].deltaTokens, 2000);
  assert.equal(stepSeries.points[1].deltaTokens, timeline.turns[0].calls[1].deltaFromPrevStep);
  assert.equal(stepSeries.points[1].isMaxJump, true);
  assert.equal(stepSeries.points[2].totalContextTokens, 2000);
  assert.equal(stepSeries.points[2].deltaTokens, -3000, '上下文收缩必须生成精确负增量');

  // 逐轮
  const turnSeries = core.buildContextTrendSeries(timeline, { mode: 'total', granularity: 'turn' });
  assert.equal(turnSeries.points.length, 2);
  assert.equal(turnSeries.points[0].label, 'T1');
  assert.equal(turnSeries.points[0].totalContextTokens, 5000);
  assert.equal(turnSeries.points[1].label, 'T2');
  assert.equal(turnSeries.points[1].totalContextTokens, 2000);
  assert.equal(turnSeries.points[1].deltaTokens, -3000);

  // 本地估算 vs 混合口径区分与兜底估算
  const mixedSeries = core.buildContextTrendSeries({
    turns: [
      { turnIndex: 1, calls: [{ callId: 'm1', stepIndex: 0, inputTokens: 100, cacheReadTokens: 900, hasInputCacheFields: true }] },
      { turnIndex: 2, calls: [{ callId: 'm2', stepIndex: 1, inputTokens: 2500, cacheReadTokens: 0, usageEstimated: true, hasInputCacheFields: true }] }
    ]
  });
  assert.equal(mixedSeries.basis, 'mixed');
  const estOnly = core.buildContextTrendSeries({ turns: [] }, { fallbackEstimateTokens: 12345 });
  assert.equal(estOnly.basis, 'local_estimate');
  assert.equal(estOnly.points.length, 1);
  assert.equal(estOnly.points[0].totalContextTokens, 12345);

  // maxPoints 截断保留最新窗口
  const manyCalls = Array.from({ length: 12 }, (_, idx) => ({
    callId: `k-${idx}`,
    stepIndex: idx + 1,
    inputTokens: 1000 * (idx + 1),
    cacheReadTokens: 0,
    hasInputCacheFields: true
  }));
  const trunc = core.buildContextTrendSeries({ turns: [{ turnIndex: 1, calls: manyCalls }] }, { maxPoints: 5 });
  assert.equal(trunc.totalPoints, 12);
  assert.equal(trunc.truncatedCount, 7);
  assert.equal(trunc.points.length, 5);
  assert.equal(trunc.points[0].stepIndex, 8);
});

test('ELV-99: meter-collector defaultViewPrefs 9 字段清洗、磁盘往返与 savedHeatView 互不覆盖', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-elv99-collector-'));
  try {
    const def = collector.getPluginSettings(dir);
    assert.deepEqual(def.defaultViewPrefs, collector.DEFAULT_VIEW_PREFS);

    // 传入混杂合法和非法取值，只保留合法取值，非法项安全回退
    collector.savePluginSettings({
      defaultViewPrefs: {
        heatView: 'yearly',
        modelUsagePeriodDays: '30',
        speedRangeDays: 'all',
        costScope: 'all',
        contextTrendMode: 'delta',
        contextTrendGranularity: 'turn',
        timelineDeltaOnly: true,
        timelineSortOrder: 'delta_desc',
        reqLogSortBy: 'cost_desc',
        evilField: 'ignore'
      }
    }, dir);
    const loaded1 = collector.getPluginSettings(dir);
    assert.deepEqual(loaded1.defaultViewPrefs, {
      heatView: 'yearly',
      modelUsagePeriodDays: 30,
      speedRangeDays: 'all',
      costScope: 'all',
      contextTrendMode: 'delta',
      contextTrendGranularity: 'turn',
      timelineDeltaOnly: true,
      timelineSortOrder: 'delta_desc',
      reqLogSortBy: 'cost_desc'
    });
    assert.equal(loaded1.savedHeatView, 'yearly');

    // 仅切换临时 heatView (savedHeatView: 'daily')，绝不破坏已保存的 defaultViewPrefs.heatView ('yearly')
    collector.savePluginSettings({ savedHeatView: 'daily' }, dir);
    const loaded2 = collector.getPluginSettings(dir);
    assert.equal(loaded2.savedHeatView, 'daily');
    assert.equal(loaded2.defaultViewPrefs.heatView, 'yearly');

    // 非法默认值全部被清洗
    const sanitized = collector.sanitizeDefaultViewPrefs({
      heatView: 'invalid',
      modelUsagePeriodDays: 999,
      speedRangeDays: '5d',
      costScope: 'x',
      contextTrendMode: 'y',
      contextTrendGranularity: 'z',
      timelineDeltaOnly: 'not-bool',
      timelineSortOrder: 'random',
      reqLogSortBy: 'unknown'
    });
    assert.deepEqual(sanitized, collector.DEFAULT_VIEW_PREFS);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ELV-98 + ELV-99: 趋势图点击联动步明细、时间线与请求日志排序、设为默认保存及模拟冷启动恢复与 en 零 CJK', async () => {
  const tl = core.groupSessionCallsByTurns([
    { stepIndex: 0, text: 'Prompt 1' },
    { stepIndex: 3, text: 'Prompt 2' },
    { stepIndex: 5, text: 'Prompt 3' }
  ], [
    { callId: 'call-s1', stepIndex: 1, inputTokens: 1200, cacheReadTokens: 2800, outputTokens: 150, timestamp: 1700000001000, modelExactId: 'gemini-4-hydrogen', modelLabel: 'Gemini 4 Hydrogen' },
    { callId: 'call-s2', stepIndex: 4, inputTokens: 2200, cacheReadTokens: 8800, outputTokens: 400, timestamp: 1700000002000, modelExactId: 'gemini-4-hydrogen', modelLabel: 'Gemini 4 Hydrogen' },
    { callId: 'call-s3', stepIndex: 6, inputTokens: 900, cacheReadTokens: 4100, outputTokens: 220, timestamp: 1700000003000, modelExactId: 'gemini-3.8-flash', modelLabel: 'Gemini 3.8 Flash' }
  ], { cascadeId: '98990000-0000-4000-8000-000000000001' });

  const sharedStorage = new Map();
  let persistedSettings = { ok: true };
  const h1 = createElv9899Harness({
    storageMap: sharedStorage,
    settingsResponse: persistedSettings,
    timelineData: tl,
    latestCall: { input: 900, cacheRead: 4100, output: 220, total: 5220, actual: 5000, budget: 200000, status: 'reported', model: 'Gemini 3.8 Flash' }
  });
  h1.sandbox.window.contextMeterAPI.saveSettings = async (p) => {
    h1.savedPayloads.push(p);
    if (p.defaultViewPrefs) {
      persistedSettings = {
        ok: true,
        savedHeatView: p.savedHeatView || p.defaultViewPrefs.heatView,
        defaultViewPrefs: p.defaultViewPrefs,
        uiPreferences: { savedHeatView: p.savedHeatView || p.defaultViewPrefs.heatView, defaultViewPrefs: p.defaultViewPrefs }
      };
    }
    return { ok: true };
  };

  try {
    const api1 = h1.sandbox.__AGContextMeter;
    await h1.flush();

    // 1. 打开上下文面板 -> 自动触发或手动拉取时间线后，点击趋势图 S4 柱条联动到请求明细并核对数字一致
    h1.ensureEl('badge').click();
    await h1.flush();
    const svg = h1.ensureEl('ctx-trend-svg');
    const hitS4 = svg.querySelector('[data-step-index="4"]');
    assert.ok(hitS4, 'SVG 中必须渲染步号 S4 交互柱条');
    hitS4.click();
    const trState = api1.getContextTrendStateForTest();
    assert.equal(trState.basis, 'server_usage');
    assert.equal(trState.pinnedCallStepIndex, 4);
    assert.equal(trState.latestDetailOpen, true);
    assert.match(trState.inspectText, /S4.*11K.*\+7K/);
    const totalInputCell = trState.detailGridCells.find(c => c.v.includes('11,000'));
    assert.ok(totalInputCell, '趋势图 S4 (11.0K) 必须与下方 #latest-call-detail-grid 总输入 11,000 严格一致');

    // 切到增量模式 & 逐轮
    h1.ensureEl('ctx-trend-mode-delta').click();
    h1.ensureEl('ctx-trend-gran-turn').click();
    const deltaTurnState = api1.getContextTrendStateForTest();
    assert.equal(deltaTurnState.mode, 'delta');
    assert.equal(deltaTurnState.granularity, 'turn');
    assert.equal(deltaTurnState.series.points.length, 3);
    assert.equal(deltaTurnState.series.points[2].deltaTokens, -6000);

    // 2. 时间线 3 种排序与请求日志排序验证
    h1.ensureEl('btn-session-history-toggle').click();
    await h1.flush();
    const listEl = h1.ensureEl('session-timeline-list');
    // 默认 newest: 第一条为 Turn 3
    assert.match(listEl.children[0].querySelector('.timeline-turn-idx').textContent, /3/);
    h1.ensureEl('tl-sort-oldest').click();
    assert.match(listEl.children[0].querySelector('.timeline-turn-idx').textContent, /1/);
    h1.ensureEl('tl-sort-delta').click();
    assert.match(listEl.children[0].querySelector('.timeline-turn-idx').textContent, /2/);

    // 请求日志排序（注入多条请求，验证按 tokens_desc 与 speed_desc 排序）
    api1.setTokenHistoryForTest({
      updatedAt: new Date().toISOString(),
      summary: { grandTotalTokens: 100000, todayTokens: 100000, monthTokens: 100000, yearTokens: 100000 },
      dailyMap: { '2026-11-22': { total: 100000, input: 80000, cache: 10000, output: 10000, steps: 2 } },
      recentRequestLogs: [
        { callId: 'r-small-fast', source: 'desktop', timestamp: 1700000005000, inputTokens: 100, cacheReadTokens: 0, outputTokens: 50, costUSD: 0.001, durationSec: 1, streamingTps: 180, status: 'final' },
        { callId: 'r-big-slow', source: 'desktop', timestamp: 1700000001000, inputTokens: 50000, cacheReadTokens: 0, outputTokens: 500, costUSD: 0.5, durationSec: 12, streamingTps: 25, status: 'final' }
      ]
    });
    api1.switchTokenView('requests');
    h1.ensureEl('req-sort-tokens').click();
    const tbody = h1.ensureEl('req-live-tbody');
    assert.equal(tbody.children.length, 2);
    assert.match(tbody.children[0].children[5].textContent, /50\.0K/, '按 Token 降序后大请求 r-big-slow 应排第一');
    h1.ensureEl('req-sort-speed').click();
    assert.match(tbody.children[0].children[11].textContent, /180/, '按速度降序后高速请求 r-small-fast 应排第一');

    // 3. 修改全部 9 项默认偏好的特征字段，点击“设为默认”
    api1.switchHeatView('monthly');
    h1.ensureEl('model-period-30d').click();
    h1.ensureEl('speed-range-all').click();
    h1.ensureEl('cost-btn-scope-all').click();
    h1.ensureEl('btn-timeline-delta-mode').click();
    h1.ensureEl('btn-save-default-view-ctx').click();
    await h1.flush();

    const savedPayload = h1.savedPayloads.find(p => p.defaultViewPrefs);
    assert.ok(savedPayload, '点击设为默认必须触发 saveSettings 保存 defaultViewPrefs');
    assert.equal(savedPayload.defaultViewPrefs.heatView, 'monthly');
    assert.equal(savedPayload.defaultViewPrefs.modelUsagePeriodDays, 30);
    assert.equal(savedPayload.defaultViewPrefs.speedRangeDays, 'all');
    assert.equal(savedPayload.defaultViewPrefs.costScope, 'all');
    assert.equal(savedPayload.defaultViewPrefs.contextTrendMode, 'delta');
    assert.equal(savedPayload.defaultViewPrefs.contextTrendGranularity, 'turn');
    assert.equal(savedPayload.defaultViewPrefs.timelineDeltaOnly, true);
    assert.equal(savedPayload.defaultViewPrefs.timelineSortOrder, 'delta_desc');
    assert.equal(savedPayload.defaultViewPrefs.reqLogSortBy, 'speed_desc');

    // 校验英文模式下新增文案零 CJK 字符
    await api1.setPanelLanguage('en', { persist: false });
    api1.applyStaticTranslationsForTest(h1.sandbox.document);
    h1.ensureEl('ctx-trend-svg');
    const enKeys = [
      'session.trend.title', 'session.trend.modeTotal', 'session.trend.modeDelta',
      'session.trend.granStep', 'session.trend.granTurn', 'session.trend.basisServer',
      'session.trend.basisEstimate', 'session.trend.basisMixed', 'session.trend.empty',
      'session.trend.inspectHint', 'session.timeline.sortNewest', 'session.timeline.sortOldest',
      'session.timeline.sortDelta', 'reqLog.sortTime', 'reqLog.sortTokens', 'reqLog.sortCost',
      'reqLog.sortDuration', 'reqLog.sortSpeed', 'prefs.saveDefault', 'prefs.savedFeedback',
      'settings.dock.auxBack', 'settings.dock.fbCopyUrl', 'settings.dock.openRightOk'
    ];
    for (const k of enKeys) {
      const txt = api1.translateForTest(k, { role: 'Main', id: 'abcd', copyNote: 'copied', shown: 10, total: 20 });
      assert.equal(/[\u4e00-\u9fff]/.test(txt), false, `英文键 ${k} 不得包含中文字符: ${txt}`);
    }
  } finally {
    h1.sandbox.__AGContextMeter.dispose();
  }

  // 4. 模拟客户端冷启动（全新沙箱实例，仅携带 localStorage 与 persistedSettings），验证全部 9 项恢复
  const h2 = createElv9899Harness({
    storageMap: sharedStorage,
    settingsResponse: persistedSettings,
    timelineData: tl
  });
  try {
    const api2 = h2.sandbox.__AGContextMeter;
    await h2.flush();
    const restored = api2.getDefaultViewPrefsStateForTest();
    assert.deepEqual(JSON.parse(JSON.stringify(restored.current)), {
      heatView: 'monthly',
      modelUsagePeriodDays: 30,
      speedRangeDays: 'all',
      costScope: 'all',
      contextTrendMode: 'delta',
      contextTrendGranularity: 'turn',
      timelineDeltaOnly: true,
      timelineSortOrder: 'delta_desc',
      reqLogSortBy: 'speed_desc'
    });
    assert.equal(h2.ensureEl('model-period-30d').classList.contains('active'), true);
    assert.equal(h2.ensureEl('speed-range-all').classList.contains('active'), true);
    assert.equal(h2.ensureEl('cost-btn-scope-all').classList.contains('active'), true);
    assert.equal(h2.ensureEl('ctx-trend-mode-delta').classList.contains('active'), true);
    assert.equal(h2.ensureEl('ctx-trend-gran-turn').classList.contains('active'), true);
    assert.equal(h2.ensureEl('tl-sort-delta').classList.contains('active'), true);
    assert.equal(h2.ensureEl('req-sort-speed').classList.contains('active'), true);
  } finally {
    h2.sandbox.__AGContextMeter.dispose();
  }
});

test('ELV-99: 首次恢复完成后打开 Token 面板触发后台 syncTokenHistoryFromHost 不得覆盖尚未设为默认的临时视图', async () => {
  const diskDefaults = { ...collector.DEFAULT_VIEW_PREFS };
  let settingsCalls = 0;
  const h = createElv9899Harness({
    settingsResponse: {
      ok: true,
      savedHeatView: diskDefaults.heatView,
      defaultViewPrefs: diskDefaults,
      uiPreferences: { savedHeatView: diskDefaults.heatView, defaultViewPrefs: diskDefaults }
    }
  });
  const origGetSettings = h.sandbox.window.contextMeterAPI.getSettings;
  try {
    const api = h.sandbox.__AGContextMeter;
    await h.flush();
    assert.deepEqual(JSON.parse(JSON.stringify(api.getDefaultViewPrefsStateForTest().defaultViewPrefs)), diskDefaults);

    // 用户尚未点击设为默认，先切好临时偏好
    h.ensureEl('ctx-trend-mode-delta').click();
    h.ensureEl('ctx-trend-gran-turn').click();
    h.ensureEl('tl-sort-delta').click();
    h.ensureEl('btn-timeline-delta-mode').click();
    h.ensureEl('speed-range-30d').click();
    h.ensureEl('model-period-30d').click();
    h.ensureEl('cost-btn-scope-all').click();
    h.ensureEl('req-sort-tokens').click();

    // 挂载计数器监控打开 Token 面板触发的二次后台恢复
    h.sandbox.window.contextMeterAPI.getSettings = async () => {
      settingsCalls += 1;
      return origGetSettings();
    };

    // 打开 Token 面板（触发 syncTokenHistoryFromHost -> restoreSettingsFromHost({ preserveSessionView: true })），再切换热力图月视图
    h.ensureEl('badge-tokens').click();
    h.ensureEl('h-tab-monthly').click();
    await h.flush();
    assert.equal(settingsCalls, 0, '打开 Token 面板不应重复加载已经恢复的用户配置');

    const cur = api.getDefaultViewPrefsStateForTest().current;
    assert.deepEqual(JSON.parse(JSON.stringify(cur)), {
      heatView: 'monthly',
      modelUsagePeriodDays: 30,
      speedRangeDays: '30',
      costScope: 'all',
      contextTrendMode: 'delta',
      contextTrendGranularity: 'turn',
      timelineDeltaOnly: true,
      timelineSortOrder: 'delta_desc',
      reqLogSortBy: 'tokens_desc'
    });

    h.ensureEl('btn-save-default-view-tokens').click();
    await h.flush();
    const savedPayload = h.savedPayloads.find(p => p.defaultViewPrefs);
    assert.equal(savedPayload?.defaultViewPrefs?.contextTrendMode, 'delta');
    assert.equal(savedPayload?.defaultViewPrefs?.heatView, 'monthly');
    assert.equal(savedPayload?.defaultViewPrefs?.modelUsagePeriodDays, 30);
  } finally {
    h.sandbox.__AGContextMeter.dispose();
  }
});
