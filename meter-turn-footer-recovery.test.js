'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const core = require('./meter-core');

const source = fs.readFileSync(path.join(__dirname, 'meter-renderer.js'), 'utf8');

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
  const docListeners = new Map();

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
      title: '',
      tabIndex: 0,
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
      prepend(x) {
        if (x) {
          x.parentElement = this;
          this.children.unshift(x);
          const xId = x.id || (typeof x.getAttribute === 'function' ? x.getAttribute('id') : null);
          if (xId) docElements.set(xId, x);
        }
      },
      replaceChildren(...nodes) {
        this.children = [];
        if (nodes && nodes.length > 0) {
          for (const n of nodes) this.appendChild(n);
        }
      },
      querySelectorAll() { return []; },
      querySelector(sel) {
        if (sel === '.ag-cm-turn-footer') return this.children.find(c => c.className === 'ag-cm-turn-footer') || null;
        return null;
      },
      closest() { return null; },
      click() { listeners.get(el)?.get('click')?.({ stopPropagation() {} }); },
      dblclick() { listeners.get(el)?.get('dblclick')?.({ stopPropagation() {} }); },
      trigger(type, ev = {}) { listeners.get(el)?.get(type)?.({ stopPropagation() {}, preventDefault() {}, ...ev }); }
    };
    return el;
  };

  const store = new Map(Object.entries(seedStorage || {}));
  const localStorage = {
    getItem: k => store.has(k) ? String(store.get(k)) : null,
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k)
  };

  const root = {
    getElementById(id) {
      if (!elements.has(id)) {
        const el = element();
        el.id = id;
        elements.set(id, el);
      }
      return elements.get(id);
    },
    querySelectorAll() { return []; },
    querySelector() { return null; },
    children: [],
    appendChild(x) { this.children.push(x); }
  };

  const tbMain = {
    row: {
      children: [],
      prepend(n) { n.parentElement = this; this.children.unshift(n); },
      appendChild(n) { n.parentElement = this; this.children.push(n); },
      querySelector(sel) {
        if (sel === '.ag-cm-turn-footer') return this.children.find(c => c.className === 'ag-cm-turn-footer') || null;
        return null;
      },
      clientWidth: 600
    },
    get firstElementChild() { return this.row; },
    getAttribute: () => null,
    clientWidth: 600
  };

  let first = true;
  const host = element();
  host.attachShadow = () => root;

  const dashboardOpened = [];

  const sandbox = {
    location: { protocol: 'https:', hostname: '127.0.0.1', pathname: '/c/test-turn-footer-session', search: '' },
    localStorage,
    window: {
      location: { protocol: 'https:', hostname: '127.0.0.1', pathname: '/c/test-turn-footer-session', search: '' },
      localStorage,
      addEventListener(type, fn) { docListeners.set(type, fn); },
      removeEventListener(type) { docListeners.delete(type); },
      contextMeterAPI: {
        saveSettings: async () => ({ ok: true })
      }
    },
    document: {
      body: element(),
      head: element(),
      documentElement: element(),
      createElement() {
        if (first) { first = false; return host; }
        return element();
      },
      getElementById: id => docElements.get(id) || null,
      querySelectorAll: sel => {
        if (sel && sel.includes('cascade-system-message-toolbar')) return [tbMain];
        if (sel && sel.includes('.ag-cm-turn-footer')) return [tbMain.row.children[0]].filter(Boolean);
        return [];
      },
      querySelector: sel => {
        if (sel && sel.includes('.ag-cm-turn-footer')) return tbMain.row.children[0] || null;
        return null;
      },
      addEventListener: () => {},
      removeEventListener: () => {}
    },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    __AGContextMeterCore: core,
    console
  };

  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);

  return { sandbox, elements, tbMain, dashboardOpened, store };
}

test('回复底部单次请求遥测微标：默认开启、多步汇总自动升格、点击切换与零括号', () => {
  const h = harness();
  try {
    const api = h.sandbox.__AGContextMeter;

    // 1. 验证默认开启与控件初始勾选
    const footerState = api.getTurnFooterStatsForTest();
    assert.equal(footerState.enabled, true, 'showTurnFooterStats 默认必须为开启');
    const chk = h.elements.get('chk-show-turn-footer-stats');
    assert.equal(chk.checked, true, '设置面板控件初始状态必须同步为 checked');

    // 2. 模拟一轮多步工具交互：包含 Step 1 和 Step 2 两次调用
    const multiCalls = [
      {
        callId: 'call-step-1',
        attributedModelLabel: 'Gemini 3.8 Flash',
        inputTokens: 50000,
        cacheCreationInputTokens: 0,
        cacheReadTokens: 40000,
        outputTokens: 500,
        streamingTps: 120,
        date: '2026-11-24 05:00:00'
      },
      {
        callId: 'call-step-2',
        attributedModelLabel: 'Gemini 3.8 Flash',
        inputTokens: 79500,
        cacheCreationInputTokens: 0,
        cacheReadTokens: 75500,
        outputTokens: 1100,
        streamingTps: 124,
        date: '2026-11-24 05:00:05'
      }
    ];

    api.setComposerStateForTest({
      sessionCalls: multiCalls,
      sessionStats: { usedTokens: 155000, limitTokens: 200000, turnCount: 1, stepCount: 2 }
    });

    const badge = h.tbMain.row.children[0];
    assert.ok(badge, '必须在工具栏生成 .ag-cm-turn-footer 徽标');
    assert.equal(badge.getAttribute('data-ag-turn-footer'), '1');
    assert.equal(badge.getAttribute('data-multi-call'), 'true');

    // 3. 多步交互下，默认自动升格为「本轮汇总」
    assert.equal(badge.getAttribute('data-scope'), 'turn', '多步调用默认展示本轮汇总');
    assert.match(badge.textContent, /本轮汇总|Turn/, '徽标文本必须包含本轮汇总');
    // 整轮 In = (50000+40000) + (79500+75500) = 90K + 155K = 245K
    assert.match(badge.textContent, /In 245\.0K/, '本轮汇总必须累计所有子调用的输入');

    // 4. 点击徽标：在「本轮汇总」和「本次请求」之间切换
    badge.click();
    assert.equal(badge.getAttribute('data-scope'), 'request', '点击后必须切换为本次请求');
    assert.match(badge.textContent, /本次请求|Req/, '徽标文本必须切换为本次请求');
    // 单步 In = 79500 + 75500 = 155.0K
    assert.match(badge.textContent, /In 155\.0K/, '本次请求展示最后一次调用的输入');
    assert.match(badge.textContent, /Out 1\.1K/, '本次请求展示最后一次调用的输出');
    assert.match(badge.textContent, /124 tok\/s/, '本次请求展示最后一次调用的生成速度');

    // 5. 再次点击徽标：切回「本轮汇总」
    badge.click();
    assert.equal(badge.getAttribute('data-scope'), 'turn', '再次点击切回本轮汇总');
    assert.match(badge.textContent, /本轮汇总|Turn/);

    // 6. 验证悬停提示文本严格零中英文括号
    const title = badge.title;
    assert.ok(title.length > 0, 'title 必须包含详细信息');
    assert.doesNotMatch(title, /[（）()]/, 'title 提示文本严格零中英文括号');
    assert.match(title, /点击在本次请求与本轮汇总之间切换 · 双击查看详细看板/);

    // 7. 验证键盘无障碍回车触发展示切换
    badge.trigger('keydown', { key: 'Enter' });
    assert.equal(badge.getAttribute('data-scope'), 'request', '键盘 Enter 必须触发展示切换');

    // 8. 验证单步调用时不产生多余的多步标记与切换
    api.setComposerStateForTest({
      sessionCalls: [multiCalls[1]],
      sessionStats: { usedTokens: 155000, limitTokens: 200000, turnCount: 1, stepCount: 1 }
    });
    const singleBadge = h.tbMain.row.children[0];
    assert.equal(singleBadge.getAttribute('data-scope'), 'request', '单步调用必须保持本次请求');
    assert.equal(singleBadge.getAttribute('data-multi-call'), 'false');
    assert.doesNotMatch(singleBadge.title, /[（）()]/, '单步 title 严格零括号');
    assert.match(singleBadge.title, /点击查看详细看板/);
  } finally {
    h.sandbox.__AGContextMeter.dispose();
  }
});

test('Issue #140 回归：时间线滞后（M > T）时绝不将上一轮模型与 Token 错挂到新回复，迟到回填只更新正确回复', () => {
  const turnA = {
    turnKey: 'turn-1',
    turnIndex: 1,
    calls: [{ callId: 'call-a', attributedModelLabel: 'Model A (Gemini)', inputTokens: 1000, outputTokens: 200, streamingTps: 80 }]
  };
  const turnB = {
    turnKey: 'turn-2',
    turnIndex: 2,
    calls: [{ callId: 'call-b', attributedModelLabel: 'Model B (Claude)', inputTokens: 2500, outputTokens: 400, streamingTps: 60 }]
  };

  // 1. 第一轮完成：M=1, T=1，回复 A 稳定归属 turn-1
  const step1 = core.alignTurnFootersWithTurns([{ existingTurnKey: '', existingSessionId: '' }], [turnA], { sessionId: 'sess-140' });
  assert.equal(step1.length, 1);
  assert.equal(step1[0]?.turnKey, 'turn-1');

  // 2. 第二轮回复 B 已渲染出工具栏，但时间线仍滞后在第一轮：M=2, T=1
  const step2 = core.alignTurnFootersWithTurns(
    [
      { existingTurnKey: 'turn-1', existingSessionId: 'sess-140' },
      { existingTurnKey: '', existingSessionId: '' }
    ],
    [turnA],
    { sessionId: 'sess-140' }
  );
  assert.equal(step2.length, 2);
  assert.equal(step2[0]?.turnKey, 'turn-1', '回复 A 必须保持原有 turn-1 归属，绝不被清空');
  assert.equal(step2[1], null, '回复 B 在时间线滞后时必须留空，绝不可显示上一轮 Model A 的模型与 Token');

  // 2b. 即使页面刚刷新无既有 DOM 绑定，M=2, T=1（turnIndex=1）也必须头对齐而非尾移到回复 B
  const step2Cold = core.alignTurnFootersWithTurns(
    [{ existingTurnKey: '', existingSessionId: '' }, { existingTurnKey: '', existingSessionId: '' }],
    [turnA],
    { sessionId: 'sess-140' }
  );
  assert.equal(step2Cold[0]?.turnKey, 'turn-1');
  assert.equal(step2Cold[1], null, '冷启动时间线滞后时回复 B 同样不可误挂 turn-1');

  // 3. 时间线迟到回填完成：M=2, T=2，回复 A 保持 Model A，回复 B 精准回填 Model B
  const step3 = core.alignTurnFootersWithTurns(
    [
      { existingTurnKey: 'turn-1', existingSessionId: 'sess-140' },
      { existingTurnKey: '', existingSessionId: '' }
    ],
    [turnA, turnB],
    { sessionId: 'sess-140' }
  );
  assert.equal(step3[0]?.turnKey, 'turn-1');
  assert.equal(step3[1]?.turnKey, 'turn-2');

  // 4. 多模型整轮明确标注（含「多模型」显式标识、零括号与 lastCallModel 溯源）
  const multiModelAttr = core.resolveTurnFooterModelAttribution([
    { attributedModelLabel: 'Gemini 4 Neon (High)', inputTokens: 2000, outputTokens: 300, totalTokens: 2300 },
    { attributedModelLabel: 'Claude Sonnet 4.6', inputTokens: 1000, outputTokens: 100, totalTokens: 1100 }
  ], { isTurnAggregate: true });
  assert.equal(multiModelAttr.isMixed, true);
  assert.deepEqual(multiModelAttr.models, ['Gemini 4 Neon (High)', 'Claude Sonnet 4.6']);
  assert.equal(multiModelAttr.lastCallModel, 'Claude Sonnet 4.6');
  assert.match(multiModelAttr.label, /^多模型/);
  assert.match(multiModelAttr.label, /2模型/);

  // 5. 切会话隔离：旧会话的 existingTurnKey 不得跨会话误匹配
  const otherSession = core.alignTurnFootersWithTurns(
    [
      { existingTurnKey: 'turn-9', existingSessionId: 'old-sess' },
      { existingTurnKey: '', existingSessionId: '' }
    ],
    [{ turnKey: 'turn-9', turnIndex: 9, calls: turnA.calls }],
    { sessionId: 'new-sess' }
  );
  assert.deepEqual(otherSession, [null, null], '无稳定同会话绑定且起始轮次非 1 时不猜测尾移');

  // 6. Issue #140 作者原复现：请求列表已有第 1 轮 A(Out 100) 与第 2 轮 B(Out 150)，但时间线仅到第 1 轮
  const authorTurn1 = { turnKey: 'turn-1', turnIndex: 1, calls: [{ callId: 'cA', attributedModelLabel: 'Model A', outputTokens: 100 }] };
  const authorTurn2 = { turnKey: 'turn-2', turnIndex: 2, calls: [{ callId: 'cB', attributedModelLabel: 'Model B', outputTokens: 150 }] };
  const lagged = core.alignTurnFootersWithTurns(
    [{ existingTurnKey: '', existingSessionId: '' }, { existingTurnKey: '', existingSessionId: '' }],
    [authorTurn1],
    { sessionId: 'author-repro', turnsSource: 'timeline', hasUnmappedLaterCalls: true }
  );
  assert.equal(lagged[0]?.turnKey, 'turn-1');
  assert.equal(lagged[1], null, '第二条回复在时间线滞后时绝不可借用 turn-1 (Model A / Out 100)');
  const caughtUp = core.alignTurnFootersWithTurns(
    [{ existingTurnKey: 'turn-1', existingSessionId: 'author-repro' }, { existingTurnKey: '', existingSessionId: '' }],
    [authorTurn1, authorTurn2],
    { sessionId: 'author-repro', turnsSource: 'timeline', hasUnmappedLaterCalls: false }
  );
  assert.equal(caughtUp[0]?.turnKey, 'turn-1');
  assert.equal(caughtUp[1]?.turnKey, 'turn-2');

  // 7. 兼容无时间线的单条 fallback 兜底（M=2, T=1, 无既有绑定且无未入时间线后续调用）
  const fallbackCompat = core.alignTurnFootersWithTurns(
    [{ existingTurnKey: '', existingSessionId: '' }, { existingTurnKey: '', existingSessionId: '' }],
    [{ turnKey: 'fallback-1', turnIndex: 1, calls: turnA.calls }],
    { sessionId: 'fb-sess', turnsSource: 'fallback', hasUnmappedLaterCalls: false }
  );
  assert.equal(fallbackCompat[0], null);
  assert.equal(fallbackCompat[1]?.turnKey, 'fallback-1');
});
