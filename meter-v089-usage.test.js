'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { DatabaseSync } = require('node:sqlite');

const core = require('./meter-core');
const collector = require('./meter-collector');
const liveHost = require('./live-host');
const meterMain = require('./meter-main');

const RENDERER_SOURCE = fs.readFileSync(path.join(__dirname, 'meter-renderer.js'), 'utf8');

function encodeVarint(n) {
  let v = BigInt(n >>> 0);
  const bytes = [];
  while (v >= 0x80n) {
    bytes.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  bytes.push(Number(v));
  return Buffer.from(bytes);
}

function encodeLenField(fieldNum, payload) {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  return Buffer.concat([encodeVarint((fieldNum << 3) | 2), encodeVarint(buf.length), buf]);
}

function encodeVarintField(fieldNum, val) {
  return Buffer.concat([encodeVarint((fieldNum << 3) | 0), encodeVarint(val)]);
}

function buildGenMetadataRowBlob({ stepIndex = 1, responseId = 'bot-1', model = 'gemini-4-hydrogen', modelLabel = 'Gemini 4 Hydrogen (High)', ttftSec = 1, streamSec = 2 } = {}) {
  const f4 = encodeLenField(7, responseId);
  const f11 = encodeVarintField(1, ttftSec);
  const f12 = encodeVarintField(1, streamSec);
  const metaMsg = Buffer.concat([
    encodeLenField(4, f4),
    encodeLenField(11, f11),
    encodeLenField(12, f12),
    encodeLenField(19, model),
    encodeLenField(21, modelLabel)
  ]);
  return Buffer.concat([
    encodeLenField(1, metaMsg),
    encodeVarintField(2, stepIndex)
  ]);
}

function buildTrajectoryMetadataBlob({ subagentType = 'research', subagentRole = 'Code Explorer', parentCascadeId = '', rootCascadeId = '' } = {}) {
  const parts = [];
  if (subagentType || subagentRole) {
    const f4 = Buffer.concat([
      subagentType ? encodeLenField(1, subagentType) : Buffer.alloc(0),
      subagentRole ? encodeLenField(2, subagentRole) : Buffer.alloc(0)
    ]);
    parts.push(encodeLenField(4, f4));
  }
  if (parentCascadeId) parts.push(encodeLenField(5, parentCascadeId));
  if (rootCascadeId) parts.push(encodeLenField(6, rootCascadeId));
  return Buffer.concat(parts);
}

function createV089DomSandbox({ reducedMotion = false, pathname = '/c/11111111-1111-1111-1111-111111111111' } = {}) {
  const elements = new Map();
  const docElements = new Map();
  const listeners = new Map();
  let scrollVal = 180;

  function makeEl() {
    const attrs = new Map();
    const props = new Map();
    const node = {
      style: {
        display: '',
        opacity: '',
        setProperty(k, v) { props.set(k, v); },
        removeProperty(k) { props.delete(k); },
        getPropertyValue(k) { return props.get(k) || ''; }
      },
      children: [],
      hidden: false,
      disabled: false,
      textContent: '',
      scrollTop: 0,
      get id() { return attrs.get('id') || ''; },
      set id(v) { attrs.set('id', String(v)); if (v) docElements.set(String(v), node); },
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
        contains(c) {
          return (attrs.get('class') || '').split(/\s+/).includes(c);
        }
      },
      addEventListener(type, fn) {
        if (!listeners.has(node)) listeners.set(node, new Map());
        listeners.get(node).set(type, fn);
      },
      setAttribute(k, v) {
        attrs.set(k, String(v));
        if (k === 'id' && v) docElements.set(String(v), node);
      },
      getAttribute(k) { return attrs.get(k) ?? null; },
      removeAttribute(k) { attrs.delete(k); },
      remove() { },
      appendChild(x) {
        if (x) {
          x.parentElement = node;
          node.children.push(x);
          const xId = x.id || x.getAttribute?.('id');
          if (xId) docElements.set(xId, x);
        }
      },
      contains(target) {
        if (target === node) return true;
        return node.children.some(c => c.contains?.(target));
      },
      matches() { return false; },
      replaceChildren(...items) {
        node.children = [];
        for (const it of items) node.appendChild(it);
      },
      querySelectorAll(sel) {
        if (sel === '[data-i18n]' || sel === '[data-i18n-title]' || sel === '[data-i18n-placeholder]' || sel === '[data-i18n-aria]') return [];
        const out = [];
        const walk = (n) => {
          if (!n) return;
          if (sel.startsWith('#') && n.id === sel.slice(1)) out.push(n);
          if (Array.isArray(n.children)) n.children.forEach(walk);
        };
        node.children.forEach(walk);
        return out;
      },
      click() { listeners.get(node)?.get('click')?.(); },
      getBoundingClientRect() { return { left: 100, top: 100, width: 120, height: 24, right: 220, bottom: 124 }; },
      trigger(type, ev = {}) { listeners.get(node)?.get(type)?.(ev); }
    };
    return node;
  }

  const host = makeEl();
  host.attachShadow = () => ({
    set innerHTML(_v) { },
    getElementById(id) {
      if (!elements.has(id)) {
        const elNode = makeEl();
        elNode.id = id;
        elements.set(id, elNode);
      }
      return elements.get(id);
    },
    querySelectorAll() { return []; }
  });

  let first = true;
  const timers = [];
  const intervalFns = [];
  const sandbox = {
    location: { protocol: 'https:', hostname: '127.0.0.1', pathname },
    document: {
      createElement: () => { if (first) { first = false; return host; } return makeEl(); },
      getElementById: id => docElements.get(id) || null,
      documentElement: { appendChild() { } },
      addEventListener() { },
      removeEventListener() { },
      hidden: false
    },
    window: {
      __APP_CONFIG__: { csrfToken: 'test-csrf' },
      scrollY: scrollVal,
      history: {
        pushState(_st, _title, url) { if (url) sandbox.location.pathname = String(url); },
        replaceState(_st, _title, url) { if (url) sandbox.location.pathname = String(url); }
      },
      contextMeterAPI: {
        scan: async () => ({ ok: true, data: { session: null, scannedAt: Date.now() } }),
        getSessionTimeline: async () => ({ ok: true, data: { turns: [], unlinkedSubagentCalls: [], totalCalls: 0, mainCallsCount: 0, subagentCallsCount: 0, cacheSummary: core.summarizeCacheReadStats([]) } })
      }
    },
    history: {
      pushState(_st, _title, url) { if (url) sandbox.location.pathname = String(url); },
      replaceState(_st, _title, url) { if (url) sandbox.location.pathname = String(url); }
    },
    matchMedia: (q) => ({ matches: Boolean(reducedMotion && String(q).includes('prefers-reduced-motion')) }),
    __AGContextMeterCore: core,
    AbortController,
    Date,
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout() { },
    setInterval: (fn) => { intervalFns.push(fn); return intervalFns.length; },
    clearInterval() { },
    fetch: async () => ({ ok: true, json: async () => ({ generatorMetadata: [] }) })
  };
  sandbox.window.scrollTo = (_x, y) => { scrollVal = y; sandbox.window.scrollY = y; };
  vm.createContext(sandbox);
  vm.runInContext(RENDERER_SOURCE, sandbox);

  const panel = elements.get('panel');
  if (panel) panel.scrollTop = 180;

  return {
    sandbox,
    host,
    elements,
    api: sandbox.__AGContextMeter,
    tick: () => intervalFns[0]?.(),
    getWindowScrollY: () => scrollVal
  };
}

test('v0.8.9 1: 模型合计与权威总量严格对账（含缓存/不含缓存/未归属保留）', async () => {
  const { formatLocalDateKey } = collector;
  const agDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-v089-reconcile-'));
  try {
    const t1 = '2026-11-15T09:00:00Z';
    const t2 = '2026-11-16T10:00:00Z';
    const d1 = formatLocalDateKey(new Date(t1));
    const d2 = formatLocalDateKey(new Date(t2));

    const b1 = path.join(agDir, 'brain', '11111111-1111-1111-1111-111111111111', '.system_generated', 'logs');
    const b2 = path.join(agDir, 'brain', '22222222-2222-2222-2222-222222222222', '.system_generated', 'logs');
    fs.mkdirSync(b1, { recursive: true });
    fs.mkdirSync(b2, { recursive: true });

    fs.writeFileSync(path.join(b1, 'transcript.jsonl'), [
      JSON.stringify({ created_at: t1, step_index: 1, model: 'gemini-4-hydrogen', modelId: 'gemini-4-hydrogen-high', chatModel: { modelDisplayName: 'Gemini 4 Hydrogen (High)' }, input_tokens: 1000, cache_read_tokens: 3000, output_tokens: 500, responseId: 'r_h1' }),
      JSON.stringify({ created_at: t1, step_index: 2, input_tokens: 400, cache_read_tokens: 600, output_tokens: 200, responseId: 'r_u1' })
    ].join('\n') + '\n');

    fs.writeFileSync(path.join(b2, 'transcript.jsonl'), [
      JSON.stringify({ created_at: t2, step_index: 1, model: 'claude-opus-5-5', input_tokens: 2000, cache_read_tokens: 8000, output_tokens: 1000, responseId: 'r_c1' })
    ].join('\n') + '\n');

    const res = await collector.collectTokenHistoryAsync({ agDir, wslRoots: [], force: true });
    for (const dateKey of [d1, d2]) {
      const auth = res.dailyMapBySource.desktop[dateKey];
      const byModel = res.dailyModelMapBySource.desktop[dateKey];
      let sumTot = 0;
      let sumNoCache = 0;
      for (const rec of Object.values(byModel)) {
        sumTot += rec.total;
        sumNoCache += (rec.input + rec.output);
      }
      assert.equal(sumTot, auth.total, `日期 ${dateKey} 模型合计(含缓存)必须严格等于权威总量`);
      assert.equal(sumNoCache, auth.input + auth.output, `日期 ${dateKey} 模型合计(不含缓存)必须严格等于权威非缓存总量`);
    }
    assert.ok(res.dailyModelMapBySource.desktop[d1][core.UNATTRIBUTED_MODEL_KEY], '缺模型差额必须保留为未归属，不得推测分配');
    assert.equal(res.dailyModelMapBySource.desktop[d1][core.UNATTRIBUTED_MODEL_KEY].total, 1200);
  } finally {
    fs.rmSync(agDir, { recursive: true, force: true });
  }
});

test('v0.8.9 2: SQLite WAL 安全回填保留精确 ID/档位 + 缺 -shm 安全跳过与损坏降级（原库零修改）', async () => {
  const agDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-v089-wal-'));
  let writer = null;
  try {
    const convDir = path.join(agDir, 'conversations');
    const cidWal = '33333333-3333-3333-3333-333333333333';
    const cidNoShm = '44444444-4444-4444-4444-444444444444';
    const cidCorrupt = '55555555-5555-5555-5555-555555555555';
    fs.mkdirSync(convDir, { recursive: true });

    // 2a. 构造真实带 WAL 的 SQLite 数据库（真实 Antigravity schema: gen_metadata.data BLOB）
    const walDbPath = path.join(convDir, `${cidWal}.db`);
    writer = new DatabaseSync(walDbPath);
    writer.exec('PRAGMA journal_mode=WAL; CREATE TABLE gen_metadata (data BLOB);');
    writer.prepare('INSERT INTO gen_metadata (data) VALUES (?)').run(
      buildGenMetadataRowBlob({ stepIndex: 1, responseId: 'bot-wal-1', model: 'gemini-4-hydrogen', modelLabel: 'Gemini 4 Hydrogen (High)' })
    );
    writer.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    // 在不 checkpoint 的情况下往 WAL 写入第 2 步，保证 -wal 非空且与 -shm 同在
    writer.prepare('INSERT INTO gen_metadata (data) VALUES (?)').run(
      buildGenMetadataRowBlob({ stepIndex: 2, responseId: 'bot-wal-2', model: 'claude-sonnet-5-5', modelLabel: 'Claude Sonnet 5.5' })
    );

    const dbHashBefore = crypto.createHash('sha256').update(fs.readFileSync(walDbPath)).digest('hex');
    const walPath = `${walDbPath}-wal`;
    assert.ok(fs.existsSync(walPath) && fs.statSync(walPath).size > 0, '预期构造出非空 WAL');

    const metaWal = collector.loadConversationDbMeta(walDbPath, cidWal);
    assert.equal(metaWal.readMode, 'mode_ro_wal');
    assert.equal(metaWal.stepMetaMap.get(2)?.model, 'Claude Sonnet 5.5');
    assert.equal(metaWal.stepMetaMap.get(2)?.modelExactId, 'claude-sonnet-5-5');
    assert.equal(metaWal.stepMetaMap.get(2)?.modelLabel, 'Claude Sonnet 5.5');
    const dbHashAfter = crypto.createHash('sha256').update(fs.readFileSync(walDbPath)).digest('hex');
    assert.equal(dbHashAfter, dbHashBefore, '只读访问绝不得改写原始 .db 文件');
    writer.close();
    writer = null;

    // 2b. 仅拷贝 .db 和非空 -wal（不带 -shm）到另一 ID，验证不会以 immutable 强读不一致数据
    const noShmDbPath = path.join(convDir, `${cidNoShm}.db`);
    fs.copyFileSync(walDbPath, noShmDbPath);
    fs.writeFileSync(`${noShmDbPath}-wal`, Buffer.alloc(1024, 0xaa));
    const metaNoShm = collector.loadConversationDbMeta(noShmDbPath, cidNoShm);
    assert.equal(metaNoShm.readMode, 'skipped');
    assert.equal(metaNoShm.skippedReason, 'wal_without_shm');

    // 2c. 损坏 .db 正常降级
    const badDbPath = path.join(convDir, `${cidCorrupt}.db`);
    fs.writeFileSync(badDbPath, Buffer.from('not-a-sqlite-file-000'));
    const metaBad = collector.loadConversationDbMeta(badDbPath, cidCorrupt);
    assert.equal(metaBad.stepMetaMap.size, 0);
    assert.equal(metaBad.stepToModel.size, 0);
  } finally {
    if (writer) { try { writer.close(); } catch { } }
    fs.rmSync(agDir, { recursive: true, force: true });
  }
});

test('v0.8.9 3: WSL 独立非 UUID 会话不按文件名误合并 & 不同调用同用量不去重合并', async () => {
  const winAg = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-v089-win-'));
  const wslRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-v089-wsl-'));
  try {
    const winConv = path.join(winAg, 'conversations');
    const winBrain = path.join(winAg, 'brain', 'default', '.system_generated', 'logs');
    fs.mkdirSync(winConv, { recursive: true });
    fs.mkdirSync(winBrain, { recursive: true });
    fs.writeFileSync(path.join(winConv, 'default.db'), 'win-db');
    fs.writeFileSync(path.join(winBrain, 'transcript.jsonl'), JSON.stringify({
      created_at: '2026-11-16T08:00:00Z',
      step_index: 1,
      model: 'gemini-3.8-flash',
      input_tokens: 1000,
      cache_read_tokens: 2000,
      output_tokens: 500,
      responseId: 'resp-unique-win-1'
    }) + '\n');

    const wslAg = path.join(wslRoot, 'home', 'dev', '.gemini', 'antigravity');
    const wslConv = path.join(wslAg, 'conversations');
    const wslBrain = path.join(wslAg, 'brain', 'default', '.system_generated', 'logs');
    fs.mkdirSync(wslConv, { recursive: true });
    fs.mkdirSync(wslBrain, { recursive: true });
    fs.writeFileSync(path.join(wslConv, 'default.db'), 'wsl-db');
    // 完全相同时间与完全相同 token 用量，但 responseId 不同、位于独立目录的同名 non-UUID 会话
    fs.writeFileSync(path.join(wslBrain, 'transcript.jsonl'), JSON.stringify({
      created_at: '2026-11-16T08:00:00Z',
      step_index: 1,
      model: 'gemini-3.8-flash',
      input_tokens: 1000,
      cache_read_tokens: 2000,
      output_tokens: 500,
      responseId: 'resp-unique-wsl-2'
    }) + '\n');

    const res = await collector.collectTokenHistoryAsync({
      force: true,
      agDir: winAg,
      wslRoots: [wslRoot, 'Z:\\__NON_EXISTENT_WSL__\\Ubuntu']
    });

    assert.equal(res.sources.desktop.conversationsCount, 2, '独立 non-UUID 同名会话不得仅按文件名合并');
    assert.equal(res.summary.totalSteps, 2, '相同用量的两个独立调用不得被误合并');
    assert.equal(res.summary.grandTotalTokens, 7000);
    assert.equal(fs.existsSync(path.join(wslAg, 'token_usage_archive_v2.json')), false);
  } finally {
    fs.rmSync(winAg, { recursive: true, force: true });
    fs.rmSync(wslRoot, { recursive: true, force: true });
  }
});

test('v0.8.9 4: 缓存读取占比口径（加权求和、缺失与零分母区分）及三端 UI 切换', async () => {
  // 单条 inputIncludesCache 与不含缓存规范
  const s1 = core.computeCacheReadStats({ inputTokens: 1000, cacheReadTokens: 9000, outputTokens: 500 });
  assert.equal(s1.totalInput, 10000);
  assert.equal(s1.cacheReadPct, 90);
  assert.equal(s1.cacheStatus, 'hit');

  const sZeroInput = core.computeCacheReadStats({ inputTokens: 0, cacheReadTokens: 0, outputTokens: 50 });
  assert.equal(sZeroInput.cacheStatus, 'zero_input');
  assert.equal(sZeroInput.cacheReadRatio, null);

  const sMissing = core.computeCacheReadStats({ totalTokens: 5000 });
  assert.equal(sMissing.cacheStatus, 'missing');
  assert.equal(sMissing.cacheReadPct, null);

  const sZeroCache = core.computeCacheReadStats({ inputTokens: 4000, cacheReadTokens: 0, outputTokens: 200 });
  assert.equal(sZeroCache.cacheStatus, 'zero_cache');
  assert.equal(sZeroCache.cacheReadPct, 0);

  // 汇总加权绝不直接平均单条百分比：
  // req1: 100 in, 900 cache -> 90%; req2: 9000 in, 0 cache -> 0%; 加权 = 900 / 10000 = 9.0%
  const agg = core.summarizeCacheReadStats([
    { inputTokens: 100, cacheReadTokens: 900, outputTokens: 10 },
    { inputTokens: 9000, cacheReadTokens: 0, outputTokens: 10 },
    { totalTokens: 5000 } // 缺失细分，不拉低或歪曲分母
  ]);
  assert.equal(agg.cacheReadPct, 9);
  assert.equal(agg.missingCount, 1);

  const h = createV089DomSandbox();
  try {
    h.api.applyTokenHistoryPayload({
      summary: { firstUseDate: '2026-11-16' },
      dailyMapBySource: {
        all: { '2026-11-16': { total: 10500, input: 1000, cache: 9000, output: 500, steps: 2 } },
        desktop: { '2026-11-16': { total: 10500, input: 1000, cache: 9000, output: 500, steps: 2 } },
        cli: { '2026-11-16': { total: 5000, input: 0, cache: 0, output: 0, steps: 1 } }
      }
    });
    assert.equal(h.api.getTokenCacheBreakdownForTest().ratio, '90%');
    h.elements.get('src-tab-cli').click();
    assert.equal(h.api.getTokenCacheBreakdownForTest().ratio, '未知');
    await h.api.setPanelLanguage('en', { persist: false });
    assert.equal(h.api.getTokenCacheBreakdownForTest().ratio, 'Unknown');
  } finally {
    h.api.dispose();
  }
});

test('v0.8.9 5: 最新调用卡片替换动画、同快照去重、阅读保护与 reduced-motion 与切会话重置', () => {
  // 5a. 正常动画、同快照去重、点击展开阅读保护与滚动位置保持
  const h = createV089DomSandbox({ reducedMotion: false });
  try {
    const call1 = {
      callId: 'c1',
      model: 'gemini-4-hydrogen',
      modelExactId: 'gemini-4-hydrogen-high',
      modelLabel: 'Gemini 4 Hydrogen (High)',
      effort: 'High',
      inputTokens: 1200,
      cacheReadTokens: 8800,
      outputTokens: 600,
      durationSec: 2.5,
      ttftSec: 0.4,
      status: 'final',
      timestamp: 1700000001000
    };
    h.api.setSessionCallsForTest([call1], { replace: true });
    let st = h.api.getLatestCallCardStateForTest();
    assert.equal(st.displayedCall.callId, 'c1');
    assert.equal(st.isEntering, false, '首次展示无需替换动画');

    // 新调用到来完成 -> 播一次进入动画
    const call2 = { ...call1, callId: 'c2', outputTokens: 900, timestamp: 1700000005000 };
    h.api.setSessionCallsForTest([call1, call2]);
    st = h.api.getLatestCallCardStateForTest();
    assert.equal(st.displayedCall.callId, 'c2');
    assert.equal(st.isEntering, true, '新调用替换完成应播一次进入动画');

    // 手动模拟动画结束清 class，再推相同快照 -> 不得重播
    h.elements.get('latest-call-body').classList.remove('is-entering');
    h.api.setSessionCallsForTest([call1, { ...call2 }]);
    st = h.api.getLatestCallCardStateForTest();
    assert.equal(st.isEntering, false, '相同快照刷新严禁重播动画');

    // 展开详情并验证阅读保护（到来 call3 时不自动覆盖，不更改 scrollTop，弹出新调用横幅）
    h.elements.get('latest-call-summary-row').click();
    assert.equal(h.api.getLatestCallCardStateForTest().detailOpen, true);
    h.elements.get('panel').scrollTop = 260;

    const call3 = { ...call1, callId: 'c3', outputTokens: 1500, timestamp: 1700000010000 };
    h.api.setSessionCallsForTest([call1, call2, call3]);
    st = h.api.getLatestCallCardStateForTest();
    assert.equal(st.displayedCall.callId, 'c2', '详情阅读期间不得自动替换当前详情');
    assert.equal(st.pendingLatestCall.callId, 'c3');
    assert.equal(st.bannerVisible, true);
    assert.equal(h.elements.get('panel').scrollTop, 260, '不得改写滚动位置');

    // 点击横幅跳到最新
    h.elements.get('latest-call-new-banner').click();
    st = h.api.getLatestCallCardStateForTest();
    assert.equal(st.displayedCall.callId, 'c3');
    assert.equal(st.bannerVisible, false);

    // 切会话路由后状态必须清空隔离
    h.sandbox.location.pathname = '/c/22222222-2222-2222-2222-222222222222';
    h.tick();
    st = h.api.getLatestCallCardStateForTest();
    assert.equal(st.displayedCall, null);
  } finally {
    h.api.dispose();
  }

  // 5b. prefers-reduced-motion 时不施加动画 class
  const hReduced = createV089DomSandbox({ reducedMotion: true });
  try {
    hReduced.api.setSessionCallsForTest([{ callId: 'r1', status: 'final', inputTokens: 100, outputTokens: 20, timestamp: 1700000001000 }], { replace: true });
    hReduced.api.setSessionCallsForTest([{ callId: 'r2', status: 'final', inputTokens: 200, outputTokens: 40, timestamp: 1700000002000 }]);
    assert.equal(hReduced.api.getLatestCallCardStateForTest().isEntering, false);
  } finally {
    hReduced.api.dispose();
  }
});

test('v0.8.9 6: 会话请求时间线、一轮多次调用、真实子代理归属与 IPC/HTTP 白名单隔离', async () => {
  const agDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-v089-tl-'));
  try {
    const parentCid = 'aaaa1111-1111-1111-1111-111111111111';
    const childCid = 'bbbb2222-2222-2222-2222-222222222222';
    const strayChildCid = 'cccc3333-3333-3333-3333-333333333333';

    const parentLogDir = path.join(agDir, 'brain', parentCid, '.system_generated', 'logs');
    const childLogDir = path.join(agDir, 'brain', childCid, '.system_generated', 'logs');
    const strayLogDir = path.join(agDir, 'brain', strayChildCid, '.system_generated', 'logs');
    const convDir = path.join(agDir, 'conversations');
    fs.mkdirSync(parentLogDir, { recursive: true });
    fs.mkdirSync(childLogDir, { recursive: true });
    fs.mkdirSync(strayLogDir, { recursive: true });
    fs.mkdirSync(convDir, { recursive: true });

    // 父会话 2 轮对话：第 2 轮含 2 次模型调用 + 1 个真实关联的子代理 invoke_subagent
    fs.writeFileSync(path.join(parentLogDir, 'transcript.jsonl'), [
      JSON.stringify({ type: 'USER_INPUT', step_index: 1, content: '第一轮问题', created_at: '2026-11-16T10:00:00Z' }),
      JSON.stringify({ created_at: '2026-11-16T10:00:02Z', step_index: 2, model: 'gemini-3.8-flash', input_tokens: 500, cache_read_tokens: 500, output_tokens: 100, responseId: 'p1' }),
      JSON.stringify({ type: 'USER_INPUT', step_index: 3, content: '第二轮并发子代理测试', created_at: '2026-11-16T10:01:00Z' }),
      JSON.stringify({ created_at: '2026-11-16T10:01:02Z', step_index: 4, model: 'gemini-4-hydrogen', input_tokens: 1000, cache_read_tokens: 3000, output_tokens: 200, responseId: 'p2a', tool_calls: [{ name: 'invoke_subagent', args: { Role: 'Code Explorer', TypeName: 'research' } }] }),
      JSON.stringify({ type: 'GENERIC', step_index: 5, content: JSON.stringify({ conversationId: childCid }) }),
      JSON.stringify({ created_at: '2026-11-16T10:01:08Z', step_index: 6, model: 'gemini-4-hydrogen', input_tokens: 2000, cache_read_tokens: 4000, output_tokens: 300, responseId: 'p2b' })
    ].join('\n') + '\n');

    // 子代理真实调用（经 invoke_subagent 真实 conversationId + db trajectory_metadata_blob 关联）
    fs.writeFileSync(path.join(childLogDir, 'transcript.jsonl'), JSON.stringify({
      created_at: '2026-11-16T10:01:05Z',
      step_index: 1,
      model: 'gemini-3.8-flash',
      input_tokens: 600,
      cache_read_tokens: 1400,
      output_tokens: 150,
      responseId: 'sub_real_1'
    }) + '\n');

    const childDb = new DatabaseSync(path.join(convDir, `${childCid}.db`));
    childDb.exec('CREATE TABLE trajectory_metadata_blob (data BLOB);');
    childDb.prepare('INSERT INTO trajectory_metadata_blob (data) VALUES (?)').run(
      buildTrajectoryMetadataBlob({ subagentType: 'research', subagentRole: 'Code Explorer', parentCascadeId: parentCid, rootCascadeId: parentCid })
    );
    childDb.close();

    // 孤立子代理（只声称 rootCascadeId=parentCid，但无对应轮次标识 -> 只能进 unlinkedSubagentCalls，不得按时间猜轮次）
    fs.writeFileSync(path.join(strayLogDir, 'transcript.jsonl'), JSON.stringify({
      created_at: '2026-11-16T10:01:06Z',
      step_index: 1,
      model: 'gemini-3.8-flash',
      input_tokens: 300,
      cache_read_tokens: 700,
      output_tokens: 80,
      responseId: 'sub_unlinked_1'
    }) + '\n');
    const strayDb = new DatabaseSync(path.join(convDir, `${strayChildCid}.db`));
    strayDb.exec('CREATE TABLE trajectory_metadata_blob (data BLOB);');
    strayDb.prepare('INSERT INTO trajectory_metadata_blob (data) VALUES (?)').run(
      buildTrajectoryMetadataBlob({ subagentType: 'research', parentCascadeId: '99999999-9999-9999-9999-999999999999', rootCascadeId: parentCid })
    );
    strayDb.close();

    const tl = await collector.collectSessionTimelineAsync(parentCid, { agDir, wslRoots: [], force: true });
    assert.equal(tl.turns.length, 2);
    assert.equal(tl.turns[0].calls.length, 1);
    assert.equal(tl.turns[1].calls.length, 3, '第 2 轮必须包含 2 次主调用 + 1 次真实关联的子代理调用');
    assert.equal(tl.turns[1].mainCallCount, 2);
    assert.equal(tl.turns[1].subagentCallCount, 1);
    assert.equal(tl.unlinkedSubagentCalls.length, 1, '无父步骤线索的跨层级子代理必须放入未归属列表，绝不按时间猜测');

    // UI 渲染验证：默认收起，展开后最近第 2 轮默认展开、第 1 轮默认折叠
    const h = createV089DomSandbox({ pathname: `/c/${parentCid}` });
    try {
      h.api.toggleSessionHistoryForTest(true);
      h.api.setSessionTimelineForTest(tl);
      const listEl = h.elements.get('session-timeline-list');
      assert.equal(listEl.children.length, 2);
      // 倒序：children[0] 是第 2 轮 (带 hdr + body)，children[1] 是第 1 轮 (仅 hdr 折叠)
      assert.equal(listEl.children[0].children.length, 2, '最近轮次默认展开');
      assert.equal(listEl.children[1].children.length, 1, '更早轮次默认折叠');
      assert.equal(h.elements.get('session-timeline-unlinked').hidden, false);

      // 三语言切换同步
      await h.api.setPanelLanguage('zh-TW', { persist: false });
      assert.match(h.elements.get('btn-session-history-toggle').textContent, /收合歷史/);
      await h.api.setPanelLanguage('en', { persist: false });
      assert.match(h.elements.get('btn-session-history-toggle').textContent, /Hide History/);
    } finally {
      h.api.dispose();
    }

    assert.ok(liveHost.ALLOWED_ROUTES.includes('/session-timeline'));
    assert.equal(liveHost.LIVE_CAPABILITIES.sessionTimeline, true);
    assert.equal(meterMain.MAIN_CAPABILITIES.sessionTimeline, true);
  } finally {
    fs.rmSync(agDir, { recursive: true, force: true });
  }
});

test('v0.8.9 7: 1500 条大量历史记录时间线及聚合缓存命中性能测试', async () => {
  const agDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-v089-perf-'));
  try {
    for (let s = 0; s < 15; s++) {
      const cid = `00000000-0000-0000-0000-0000000000${String(s).padStart(2, '0')}`;
      const logDir = path.join(agDir, 'brain', cid, '.system_generated', 'logs');
      fs.mkdirSync(logDir, { recursive: true });
      const lines = [];
      for (let i = 0; i < 100; i++) {
        lines.push(JSON.stringify({
          created_at: `2026-11-${String((i % 20) + 1).padStart(2, '0')}T10:00:00Z`,
          step_index: i + 1,
          model: i % 2 === 0 ? 'gemini-3.8-flash' : 'gemini-4-hydrogen',
          input_tokens: 1000,
          cache_read_tokens: 2000,
          output_tokens: 300,
          responseId: `perf_${s}_${i}`
        }));
      }
      fs.writeFileSync(path.join(logDir, 'transcript.jsonl'), lines.join('\n') + '\n');
    }

    const tCold0 = performance.now();
    const res1 = await collector.collectTokenHistoryAsync({ agDir, wslRoots: [], userStatus: null, force: true });
    const coldMs = performance.now() - tCold0;

    const tWarm0 = performance.now();
    const res2 = await collector.collectTokenHistoryAsync({ agDir, wslRoots: [], userStatus: null, force: false });
    const warmMs = performance.now() - tWarm0;

    assert.equal(res1.summary.totalSteps, 1500);
    assert.equal(res2.summary.totalSteps, 1500);
    assert.equal(res2.updatedAt, res1.updatedAt, '热缓存命中必须直接复用缓存时间戳，避免重复全量解析');
    assert.ok(warmMs < 300, `热缓存命中耗时应保持在合理低耗时 (<300ms)，实际 ${warmMs.toFixed(1)}ms`);
    assert.ok(coldMs < 5000, `1500 条冷扫应在合理预算内 (<5000ms)，实际 ${coldMs.toFixed(1)}ms`);
  } finally {
    fs.rmSync(agDir, { recursive: true, force: true });
  }
});

test('v0.8.8 请求时间线回归: 11 轮 105 调用防压扁滚动契约、<USER_REQUEST> 标签清洗与多轮折叠保留滚动', async () => {
  const agDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-v088-tl-'));
  try {
    const cid = '11111111-2222-3333-4444-555555555555';
    const logDir = path.join(agDir, 'brain', cid, '.system_generated', 'logs');
    fs.mkdirSync(logDir, { recursive: true });

    const lines = [];
    let stepIdx = 0;
    const rawUserPrompts = [
      '<USER_REQUEST>\n  <ADDITIONAL_METADATA>\n    {"editor":"main.js"}\n  </ADDITIONAL_METADATA>\n请帮我检查渲染层布局为什么被压扁了？\n</USER_REQUEST>',
      '<USER_REQUEST>\n<USER_SETTINGS_CHANGE>\n{"theme":"dark"}\n</USER_SETTINGS_CHANGE>\n继续构建并核对测试结果，第一行\n第二行详细补充说明与极长上下文描述：' + '详细内容'.repeat(40) + '\n</USER_REQUEST>'
    ];
    for (let tIdx = 0; tIdx < 11; tIdx++) {
      const promptContent = rawUserPrompts[tIdx] || `<USER_REQUEST>\n第 ${tIdx + 1} 轮用户真实指令内容\n</USER_REQUEST>`;
      lines.push(JSON.stringify({
        step_index: stepIdx,
        type: 'USER_INPUT',
        source: 'USER_EXPLICIT',
        created_at: `2026-11-18T01:${String(tIdx).padStart(2, '0')}:00Z`,
        content: promptContent
      }));
      stepIdx++;
      // 前 6 轮每轮 10 次调用 + 后 5 轮每轮 9 次调用 = 105 次调用
      const callPerTurn = tIdx < 6 ? 10 : 9;
      for (let c = 0; c < callPerTurn; c++) {
        lines.push(JSON.stringify({
          step_index: stepIdx,
          type: 'PLANNER_RESPONSE',
          created_at: `2026-11-18T01:${String(tIdx).padStart(2, '0')}:${String(10 + c).padStart(2, '0')}Z`,
          model: 'gemini-4-hydrogen',
          input_tokens: 1200 + c * 10,
          cache_read_tokens: 8000,
          output_tokens: 240,
          responseId: `req_tl_${tIdx}_${c}`
        }));
        stepIdx++;
      }
    }
    const transcriptFile = path.join(logDir, 'transcript.jsonl');
    const rawBefore = lines.join('\n') + '\n';
    fs.writeFileSync(transcriptFile, rawBefore, 'utf8');

    const tl = await collector.collectSessionTimelineAsync(cid, { agDir, wslRoots: [], force: true });
    assert.equal(tl.turns.length, 11);
    assert.equal(tl.totalCalls, 105);
    assert.equal(fs.readFileSync(transcriptFile, 'utf8'), rawBefore, '底层 transcript 原文件绝不能被清洗修改');

    for (const turn of tl.turns) {
      assert.doesNotMatch(turn.preview, /<\/?(USER_REQUEST|ADDITIONAL_METADATA|USER_SETTINGS_CHANGE)/i, '标题必须彻底剥离内部包装标签');
      assert.ok(turn.preview.length > 0 && turn.preview.length <= 120);
    }
    assert.equal(tl.turns[0].preview, '请帮我检查渲染层布局为什么被压扁了？');
    assert.match(tl.turns[1].preview, /^继续构建并核对测试结果，第一行 第二行详细补充说明/);

    // UI 渲染与多轮连续展开、滚动恢复、折叠验证
    const h = createV089DomSandbox({ pathname: `/c/${cid}` });
    try {
      h.api.toggleSessionHistoryForTest(true);
      h.api.setSessionTimelineForTest(tl);
      const listEl = h.elements.get('session-timeline-list');
      // 模拟加载全部 11 轮
      h.elements.get('btn-timeline-load-more').click();
      assert.equal(listEl.children.length, 11, '应展开呈现全部 11 轮');

      // 连续展开多个轮次并验证 scrollTop 保持、各轮标题完整且均可收回
      listEl.scrollTop = 280;
      for (let i = 0; i < 4; i++) {
        const hdr = listEl.children[i].children[0];
        const card = listEl.children[i];
        const wasOpen = card.children.length === 2;
        if (!wasOpen) hdr.click();
      }
      assert.equal(listEl.scrollTop, 280, '同会话连续点击展开/折叠轮次不得把列表滚动条强行重置回顶部');
      for (let i = 0; i < 4; i++) {
        assert.equal(listEl.children[i].children.length, 2, `第 ${i} 张轮次卡应处于展开态且含明细区`);
      }
      for (let i = 0; i < 11; i++) {
        const idxEl = listEl.children[i].children[0].children[0].children[0];
        const promptEl = listEl.children[i].children[0].children[0].children[1];
        assert.ok(idxEl.textContent && promptEl.textContent, '每轮标题都必须保持完整可读');
        assert.doesNotMatch(promptEl.textContent, /<USER_REQUEST>/);
      }
      // 逐轮折叠收回（包括最后一张展开卡）后全部保持收回状态，不得反弹重展开
      for (let i = 0; i < 4; i++) {
        listEl.children[i].children[0].click();
        assert.equal(listEl.children[i].children.length, 1, '每轮应随时可折叠收回');
      }
      for (let i = 0; i < 11; i++) {
        assert.equal(listEl.children[i].children.length, 1, `全部收回后第 ${i} 轮不得自动反弹重展开`);
      }

      // 缺失可靠父步骤或子代理库字段时明确标注，且转义形式 &lt;USER_REQUEST&gt; 同步清洗
      assert.equal(core.sanitizeTurnPreviewText('&lt;USER_REQUEST&gt;\n请验证清洗\n&lt;/USER_REQUEST&gt;&lt;ADDITIONAL_METADATA&gt;noise&lt;/ADDITIONAL_METADATA&gt;', 120), '请验证清洗');
      h.api.setSessionTimelineForTest({
        ...tl,
        subagentNote: 'db_sqlite_unavailable',
        unlinkedSubagentCalls: [
          {
            callId: 'sub_unlinked_1',
            agentRole: 'subagent',
            parentCascadeId: cid,
            parentStepIndex: null,
            subagentType: 'research',
            attributionConfidence: 'verified_db_meta',
            model: 'gemini-4-hydrogen',
            inputTokens: 100,
            cacheReadTokens: 200,
            outputTokens: 50,
            hasInputCacheFields: true,
            status: 'final',
            outcomeStatus: 'success',
            timestamp: Date.now()
          }
        ]
      });
      const collectTexts = (node) => {
        if (!node) return '';
        const kids = Array.isArray(node.children) ? node.children.map(collectTexts).join(' ') : '';
        return [node.textContent || '', kids].filter(Boolean).join(' ');
      };
      const sumText = collectTexts(h.elements.get('session-timeline-summary'));
      assert.match(sumText, /db_sqlite_unavailable/, '缺失可靠子代理库字段时须在摘要区写明');
      const unlinkedBox = h.elements.get('session-timeline-unlinked');
      assert.equal(unlinkedBox.hidden, false);
      unlinkedBox.children[1].click();
      const detailJson = collectTexts(h.elements.get('latest-call-detail-grid'));
      assert.match(detailJson, /缺可靠父步骤字段/, '缺失可靠父步骤字段时应在详情明确写明');
    } finally {
      h.api.dispose();
    }

    // 静态 CSS 契约断言：防止 .timeline-turn-card / .session-timeline-list 丢失 flex:0 0 auto 被压成一条缝
    const cssSrc = fs.readFileSync(path.join(__dirname, 'src', 'renderer', 'styles.css'), 'utf8');
    assert.match(cssSrc, /\.session-timeline-list\s*\{[^}]*flex:\s*0 0 auto;[^}]*max-height:\s*min\(360px,\s*46vh\)[^}]*overflow-y:\s*auto/);
    assert.match(cssSrc, /\.timeline-turn-card\s*\{\s*flex:\s*0 0 auto;/);
    assert.match(RENDERER_SOURCE, /\.timeline-turn-card\s*\{[^}]*flex:\s*0 0 auto;/);
  } finally {
    fs.rmSync(agDir, { recursive: true, force: true });
  }
});

test('实时请求统计：后端 .db 耗时回填 + recentRequestLogs 排序去重 + 13 列渲染/筛选/分页/三语验证', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-req-live-'));
  const agDir = path.join(rootDir, 'desktop');
  const cliDir = path.join(rootDir, 'cli');
  const cidDesk = 'aaaaaaaa-1111-4111-8111-111111111111';
  const cidCli = 'bbbbbbbb-2222-4222-8222-222222222222';
  try {
    fs.mkdirSync(path.join(agDir, 'brain', cidDesk, '.system_generated', 'logs'), { recursive: true });
    fs.mkdirSync(path.join(agDir, 'conversations'), { recursive: true });
    fs.mkdirSync(path.join(cliDir, 'brain', cidCli, '.system_generated', 'logs'), { recursive: true });
    fs.mkdirSync(path.join(cliDir, 'conversations'), { recursive: true });

    // 写入桌面端 transcript + SQLite gen_metadata（回填 TTFT=4s, stream=1s -> dur=5s）
    const deskTs = '2026-11-20T01:41:03.000Z';
    fs.writeFileSync(
      path.join(agDir, 'brain', cidDesk, '.system_generated', 'logs', 'transcript.jsonl'),
      JSON.stringify({
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        created_at: deskTs,
        model: 'gemini-4-hydrogen',
        input_tokens: 19500,
        cache_read_tokens: 0,
        output_tokens: 184
      }) + '\n',
      'utf8'
    );
    const deskDb = new DatabaseSync(path.join(agDir, 'conversations', `${cidDesk}.db`));
    deskDb.exec('CREATE TABLE gen_metadata (id INTEGER PRIMARY KEY, data BLOB)');
    deskDb.prepare('INSERT INTO gen_metadata (data) VALUES (?)').run(
      buildGenMetadataRowBlob({ stepIndex: 1, responseId: 'resp-desk-1', model: 'gemini-4-hydrogen', modelLabel: 'Gemini 4 Hydrogen (High)', ttftSec: 4, streamSec: 1 })
    );
    deskDb.close();

    // 写入 CLI transcript + SQLite gen_metadata（回填 TTFT=5s, stream=29s -> dur=34s）
    const cliTs = '2026-11-20T01:12:37.000Z';
    fs.writeFileSync(
      path.join(cliDir, 'brain', cidCli, '.system_generated', 'logs', 'transcript.jsonl'),
      JSON.stringify({
        step_index: 2,
        type: 'PLANNER_RESPONSE',
        created_at: cliTs,
        model: 'gemini-4-carbon',
        input_tokens: 4000,
        cache_read_tokens: 396000,
        output_tokens: 3828
      }) + '\n',
      'utf8'
    );
    const cliDb = new DatabaseSync(path.join(cliDir, 'conversations', `${cidCli}.db`));
    cliDb.exec('CREATE TABLE gen_metadata (id INTEGER PRIMARY KEY, data BLOB)');
    cliDb.prepare('INSERT INTO gen_metadata (data) VALUES (?)').run(
      buildGenMetadataRowBlob({ stepIndex: 2, responseId: 'resp-cli-1', model: 'gemini-4-carbon', modelLabel: 'Gemini 4 Carbon (High)', ttftSec: 5, streamSec: 29 })
    );
    cliDb.close();

    const history = await collector.collectTokenHistoryAsync({
      agDir,
      agCliDir: cliDir,
      force: true,
      useWorker: false,
      hostFetcher: async () => null
    });

    assert.ok(Array.isArray(history.recentRequestLogs), 'recentRequestLogs 必须存在');
    assert.equal(history.recentRequestLogs.length, 2, '应合并 Desktop 与 CLI 共 2 条请求');
    const [firstLog, secondLog] = history.recentRequestLogs;
    assert.equal(firstLog.source, 'desktop', '按时间倒序桌面端更新的请求应排首位');
    assert.equal(firstLog.ttftSec, 4);
    assert.equal(firstLog.streamingSec, 1);
    assert.equal(firstLog.durationSec, 5);
    assert.equal(firstLog.cacheReadPct, 0);
    assert.equal(secondLog.source, 'cli');
    assert.equal(secondLog.ttftSec, 5);
    assert.equal(secondLog.streamingSec, 29);
    assert.equal(secondLog.durationSec, 34);
    assert.equal(secondLog.streamingTps, 132);
    assert.equal(secondLog.cacheReadPct, 99);
    assert.equal(secondLog.isPriced, true);
    assert.ok(secondLog.costUSD > 0);

    // 渲染层 13 列、筛选、宽屏类、分页与三语验证
    const h = createV089DomSandbox();
    try {
      const nowMs = Date.now();
      const extraRows = [
        {
          callId: 'req-live-stream',
          cascadeId: cidDesk,
          timestamp: nowMs,
          date: '2026-11-20',
          source: 'desktop',
          modelKey: 'gemini-4-hydrogen',
          modelLabel: 'Gemini 4 Hydrogen',
          inputTokens: 19500,
          cacheReadTokens: 0,
          outputTokens: 184,
          totalTokens: 19684,
          cacheReadPct: 0,
          costUSD: 0.031,
          isPriced: true,
          ttftSec: 4.2,
          streamingSec: 0.1,
          durationSec: 4.3,
          streamingTps: null,
          status: 'final',
          outcomeStatus: 'success',
          accountScopeKey: 'acct_1111111111111111'
        },
        {
          callId: 'req-cli-slow',
          cascadeId: cidCli,
          timestamp: nowMs - 60000,
          date: '2026-11-20',
          source: 'cli',
          modelKey: 'gemini-4-neon',
          modelLabel: 'Gemini 4 Neon',
          inputTokens: 4000,
          cacheReadTokens: 396000,
          outputTokens: 3800,
          totalTokens: 403800,
          cacheReadPct: 99,
          costUSD: 0.137,
          isPriced: true,
          ttftSec: 5.2,
          streamingSec: 28.8,
          durationSec: 34,
          streamingTps: 132,
          status: 'final',
          outcomeStatus: 'success',
          accountScopeKey: null
        },
        {
          callId: 'req-cli-err',
          cascadeId: cidCli,
          timestamp: nowMs - 120000,
          date: '2026-11-20',
          source: 'cli',
          modelKey: 'gemini-4-neon',
          inputTokens: 2000,
          cacheReadTokens: 398000,
          outputTokens: 317,
          totalTokens: 400317,
          cacheReadPct: 99.5,
          costUSD: 0.078,
          isPriced: true,
          ttftSec: 6.4,
          streamingSec: 5.6,
          durationSec: 12,
          streamingTps: 200,
          status: 'final',
          outcomeStatus: 'rate_limited',
          error: '429 Too Many Requests',
          accountScopeKey: null
        }
      ];
      const dm = { '2026-11-20': { total: 423484, input: 25500, cache: 794000, output: 4301, steps: 3 } };
      h.api.applyTokenHistoryPayload({
        schemaVersion: '0.8.8',
        firstUseDate: '2026-11-20',
        dailyMap: dm,
        dailyMapBySource: { all: dm, desktop: dm, cli: dm },
        summary: { grandTotalTokens: 423484, todayTokens: 423484 },
        recentRequestLogs: extraRows
      });

      h.api.switchTokenViewForTest('requests');
      let st = h.api.getRequestsViewStateForTest();
      assert.equal(st.activeView, 'requests');
      assert.equal(st.wideClass, true, '切入实时请求视图应启用宽屏 class requests-wide-view');
      assert.equal(st.rowCount, 3);
      assert.equal(st.emptyVisible, false);

      // 核对第一行（Desktop，0.1s 极短流速度应显示 —，4.3s 绿、0% 缓存、$0.031）
      assert.equal(st.rows[0].length, 13, '表格每行必须包含完整 13 列');
      assert.equal(st.rows[0][1], 'Antigravity');
      assert.equal(st.rows[0][2], '—');
      assert.equal(st.rows[0][3], '本地会话');
      assert.equal(st.rows[0][4], 'gemini-4-hydrogen');
      assert.equal(st.rows[0][5], '19.5K');
      assert.equal(st.rows[0][6], '184');
      assert.equal(st.rows[0][7], '0%');
      assert.equal(st.rows[0][8], '$0.031');
      assert.equal(st.rows[0][9], '≈4.2 秒');
      assert.equal(st.rows[0][10], '≈4.3 秒');
      assert.equal(st.rows[0][11], '—');
      assert.equal(st.rows[0][12], '成功');

      // 核对第二行（Antigravity CLI，99% 缓存，$0.137，132 token/秒）
      assert.equal(st.rows[1][1], 'Antigravity CLI');
      assert.equal(st.rows[1][4], 'gemini-4-neon');
      assert.equal(st.rows[1][5], '4.0K');
      assert.equal(st.rows[1][6], '3.8K');
      assert.equal(st.rows[1][7], '99%');
      assert.equal(st.rows[1][8], '$0.137');
      assert.equal(st.rows[1][10], '≈34 秒');
      assert.equal(st.rows[1][11], '132 token/秒');

      // 核对第三行（99.5% 缓存，限流状态）
      assert.equal(st.rows[2][7], '99.5%');
      assert.equal(st.rows[2][10], '≈12 秒');
      assert.equal(st.rows[2][12], '限流');

      // 状态过滤：仅看异常 -> 1 条
      h.elements.get('req-filter-error').click();
      st = h.api.getRequestsViewStateForTest();
      assert.equal(st.rowCount, 1);
      assert.equal(st.rows[0][12], '限流');

      // 来源过滤：切桌面端 + 异常 -> 空态
      h.elements.get('src-tab-desktop').click();
      st = h.api.getRequestsViewStateForTest();
      assert.equal(st.rowCount, 0);
      assert.equal(st.emptyVisible, true);

      // 切回全部来源 + 全部状态 -> 3 条
      h.elements.get('src-tab-all').click();
      h.elements.get('req-filter-all').click();
      assert.equal(h.api.getRequestsViewStateForTest().rowCount, 3);

      // 英文切换零汉字验证
      await h.api.setPanelLanguage('en', { persist: false });
      st = h.api.getRequestsViewStateForTest();
      assert.equal(st.rows[0][3], 'Local Session');
      assert.equal(st.rows[0][9], '≈4.2s');
      assert.equal(st.rows[1][11], '132 tok/s');
      assert.equal(st.rows[0][12], 'Success');
      assert.equal(st.rows[2][12], 'Rate Limited');
      for (const row of st.rows) {
        assert.doesNotMatch(row.join(' '), /[\u4e00-\u9fff]/, '英文模式下实时请求表不得泄露中文');
      }

      // 离开实时请求切回 Token 统计应移除宽屏 class
      h.api.switchTokenViewForTest('tokens');
      assert.equal(h.api.getRequestsViewStateForTest().wideClass, false);

      // 分页加载更多验证（60 条数据 -> 首屏 50 条 -> 点加载更多显示全部 60 条）
      await h.api.setPanelLanguage('zh-CN', { persist: false });
      const manyRows = Array.from({ length: 60 }, (_, idx) => ({
        callId: `bulk-${idx}`,
        cascadeId: cidDesk,
        timestamp: nowMs - idx * 1000,
        date: '2026-11-20',
        source: idx % 2 === 0 ? 'desktop' : 'cli',
        modelKey: 'gemini-4-neon',
        inputTokens: 1000 + idx,
        cacheReadTokens: 9000,
        outputTokens: 500,
        totalTokens: 10500 + idx,
        cacheReadPct: 90,
        costUSD: 0.012,
        isPriced: true,
        ttftSec: 2.1,
        streamingSec: 3.0,
        durationSec: 5.1,
        streamingTps: 166,
        status: 'final',
        outcomeStatus: 'success'
      }));
      h.api.applyTokenHistoryPayload({
        schemaVersion: '0.8.8',
        firstUseDate: '2026-11-20',
        dailyMap: dm,
        dailyMapBySource: { all: dm, desktop: dm, cli: dm },
        summary: { grandTotalTokens: 630000, todayTokens: 630000 },
        recentRequestLogs: manyRows
      });
      h.api.switchTokenViewForTest('requests');
      st = h.api.getRequestsViewStateForTest();
      assert.equal(st.rowCount, 50);
      assert.equal(st.moreVisible, true);
      h.elements.get('btn-req-live-more').click();
      st = h.api.getRequestsViewStateForTest();
      assert.equal(st.rowCount, 60);
      assert.equal(st.moreVisible, false);
    } finally {
      h.api.dispose();
    }
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('动态价格目录：gemini-4-neon 内置价目、models.dev/LiteLLM 双源解析合并、容灾回退、custom_pricing 覆写与历史账本自动补算', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-pricing-sync-'));
  const agDir = path.join(rootDir, 'antigravity');
  const stateDir = path.join(rootDir, 'state');
  fs.mkdirSync(agDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });

  try {
    // 1. gemini-4-neon 离线内置基线校验 ($3.00 / $0.15 / $15.00)
    assert.equal(core.normalizeModelId('Gemini 4 Neon (XHigh)'), 'gemini-4-neon');
    assert.equal(core.normalizeModelId('gemini/gemini-4-neon'), 'gemini-4-neon');
    const neonCost = core.calculateRequestApiCost({
      model: 'Gemini 4 Neon (XHigh)',
      inputTokens: 40000,
      cacheReadTokens: 200000,
      outputTokens: 5000,
      thinkingTokens: 3000,
      date: '2026-11-20'
    });
    assert.equal(neonCost.isPriced, true);
    assert.equal(neonCost.modelKey, 'gemini-4-neon');
    // 40k * 3 / 1e6 + 200k * 0.15 / 1e6 + 5k * 15 / 1e6 = 0.12 + 0.03 + 0.075 = 0.225
    assert.ok(Math.abs(neonCost.costUSD - 0.225) < 1e-9, `unexpected neon cost: ${neonCost.costUSD}`);

    // 2. 双源解析与合并：models.dev 优先，LiteLLM 补齐缺失 cache_read / >200K 阶梯与新模型
    const mockModelsDev = {
      google: {
        models: {
          'gemini-5-quartz': {
            id: 'gemini-5-quartz',
            cost: { input: 2.5, output: 12.0 }
          }
        }
      },
      anthropic: {
        models: {
          'claude-sonnet-6': {
            id: 'claude-sonnet-6',
            cost: {
              input: 3.0,
              output: 15.0,
              cache_read: 0.3,
              context_over_200k: { input: 6.0, output: 22.5, cache_read: 0.6 }
            }
          }
        }
      }
    };
    const mockLiteLlm = {
      'gemini/gemini-5-quartz': {
        litellm_provider: 'gemini',
        mode: 'chat',
        input_cost_per_token: 0.0000025,
        output_cost_per_token: 0.000012,
        cache_read_input_token_cost: 0.00000025,
        input_cost_per_token_above_200k_tokens: 0.000005,
        output_cost_per_token_above_200k_tokens: 0.000024,
        cache_read_input_token_cost_above_200k_tokens: 0.0000005
      },
      'gemini/gemini-5-quartz:batch': {
        litellm_provider: 'gemini',
        mode: 'chat',
        input_cost_per_token: 0.000001,
        output_cost_per_token: 0.000004
      },
      'openai/gpt-6-orbit': {
        litellm_provider: 'openai',
        mode: 'chat',
        input_cost_per_token: 0.000004,
        output_cost_per_token: 0.000016,
        cache_read_input_token_cost: 0.0000004
      }
    };

    const parsedMd = core.parseModelsDevPricingCatalog(mockModelsDev);
    const parsedLl = core.parseLiteLlmPricingCatalog(mockLiteLlm);
    assert.ok(parsedMd['gemini-5-quartz']);
    assert.equal(parsedMd['claude-sonnet-6'].length, 2);
    assert.equal(parsedLl['gemini-5-quartz'].length, 2);
    assert.equal(parsedLl['gemini-5-quartz:batch'], undefined);

    const merged = core.mergePricingCatalogs(parsedMd, parsedLl);
    // models.dev 缺 cache_read，merge 后应由 LiteLLM 补齐 0.25
    assert.equal(merged['gemini-5-quartz'][0].cacheReadPerMillion, 0.25);
    assert.equal(merged['gpt-6-orbit'][0].inputPerMillion, 4);

    // 3. 写入未计价的新模型历史账本记录（gemini-5-quartz）
    const ledgerPath = collector.getPricingLedgerPath(agDir);
    const unpricedCall = {
      callId: 'req-quartz-1',
      cascadeId: 'c1111111-1111-1111-1111-111111111111',
      timestamp: Date.parse('2026-11-20T12:00:00.000Z'),
      created_at: '2026-11-20T12:00:00.000Z',
      date: '2026-11-20',
      source: 'desktop',
      model: 'Gemini 5 Quartz (High)',
      modelExactId: 'gemini-5-quartz',
      modelKey: 'unattributed',
      inputTokens: 100000,
      cacheReadTokens: 100000,
      outputTokens: 10000,
      totalTokens: 210000,
      isPriced: false,
      costUSD: null
    };
    fs.writeFileSync(ledgerPath, JSON.stringify({ version: '1.0.0', calls: { 'req-quartz-1': unpricedCall } }, null, 2));

    // 同步前未知新模型仍保持未计价
    core.setDynamicPricingCatalog(null);
    core.setCustomPricingCatalog({});
    const beforeCalc = core.calculateRequestApiCost(unpricedCall);
    assert.equal(beforeCalc.isPriced, false);

    // 4. 主源失败自动回退到 LiteLLM 备源 + 持久化缓存 + 自动补算历史账本
    let fetchCount = 0;
    const syncRes = await collector.syncPricingCatalogAsync({
      stateDir,
      agDir,
      force: true,
      fetcher: async (url) => {
        fetchCount++;
        if (url.includes('models.dev')) throw new Error('simulated_primary_timeout');
        return mockLiteLlm;
      }
    });
    assert.equal(syncRes.ok, true);
    assert.deepEqual(syncRes.sources, ['litellm']);
    assert.equal(syncRes.repricedCount, 1);
    assert.equal(fetchCount, 2);
    assert.equal(fs.existsSync(collector.getPricingCatalogCachePath(stateDir)), true);

    // 验证账本已自动落盘补算（100k*2.5 + 100k*0.25 + 10k*12）/ 1e6 = 0.25 + 0.025 + 0.12 = 0.395
    const updatedLedger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    assert.equal(updatedLedger.calls['req-quartz-1'].isPriced, true);
    assert.equal(updatedLedger.calls['req-quartz-1'].modelKey, 'gemini-5-quartz');
    assert.ok(Math.abs(updatedLedger.calls['req-quartz-1'].costUSD - 0.395) < 1e-9);

    // TTL 缓存命中：非强制同步不再发起网络请求
    const cachedRes = await collector.syncPricingCatalogAsync({
      stateDir,
      agDir,
      force: false,
      fetcher: async () => { throw new Error('should_not_fetch_within_ttl'); }
    });
    assert.equal(cachedRes.ok, true);
    assert.equal(cachedRes.cached, true);
    assert.equal(cachedRes.skipped, true);

    // 5. 清空内存后通过 collectTokenHistoryAsync 从磁盘恢复缓存目录，且未收录模型依然不乱估价
    core.setDynamicPricingCatalog(null);
    const historyOut = await collector.collectTokenHistoryAsync({ agDir, stateDir, force: true });
    assert.ok(historyOut.dynamicPricingCatalog);
    assert.ok(historyOut.dynamicPricingCatalog.modelCount >= 2);
    assert.ok(historyOut.dynamicPricingCatalog.models['gemini-5-quartz']);
    assert.equal(core.calculateRequestApiCost({
      model: 'gemini-pro-orchestrator-xenon',
      inputTokens: 1000,
      outputTokens: 500
    }).isPriced, false);

    // 6. custom_pricing.json 本地覆写优先级高于内置与远程目录
    fs.writeFileSync(collector.getCustomPricingPath(stateDir), JSON.stringify({
      'gemini-4-neon': { inputPerMillion: 1.0, outputPerMillion: 5.0, cacheReadPerMillion: 0.1 }
    }, null, 2));
    collector.loadPersistedPricingCatalog({ stateDir });
    const overridden = core.calculateRequestApiCost({
      model: 'gemini-4-neon',
      inputTokens: 1000000,
      cacheReadTokens: 0,
      outputTokens: 0
    });
    assert.equal(overridden.isPriced, true);
    assert.ok(Math.abs(overridden.costUSD - 1.0) < 1e-9);
  } finally {
    core.setDynamicPricingCatalog(null);
    core.setCustomPricingCatalog({});
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('动态价格前端交互：dynamicPricingCatalog 水合即时回算未计价行 + 一键同步价格按钮与三语反馈', async () => {
  const dm = { '2026-11-20': { total: 210000, input: 100000, output: 10000, cache: 100000 } };
  let syncCalls = 0;
  let historyCalls = 0;

  const h = createV089DomSandbox();
  try {
    core.setDynamicPricingCatalog(null);
    core.setCustomPricingCatalog({});

    const baseUnpricedRow = {
      callId: 'req-future-1',
      cascadeId: 'a1111111-1111-1111-1111-111111111111',
      timestamp: Date.parse('2026-11-20T12:15:00.000Z'),
      date: '2026-11-20',
      source: 'desktop',
      model: 'Gemini 5 Nova (High)',
      modelExactId: 'gemini-5-nova',
      modelKey: 'gemini-5-nova',
      inputTokens: 100000,
      cacheReadTokens: 100000,
      outputTokens: 10000,
      totalTokens: 210000,
      cacheReadPct: 50,
      costUSD: null,
      isPriced: false,
      ttftSec: 1.2,
      streamingSec: 2.0,
      durationSec: 3.2,
      streamingTps: 120,
      status: 'final',
      outcomeStatus: 'success'
    };

    const syncedCatalog = {
      updatedAt: '2026-11-20T12:20:00.000Z',
      fetchedAtMs: Date.parse('2026-11-20T12:20:00.000Z'),
      sources: ['models.dev', 'litellm'],
      modelCount: 168,
      customCount: 0,
      models: {
        'gemini-5-nova': [{ inputPerMillion: 2.0, outputPerMillion: 10.0, cacheReadPerMillion: 0.2 }]
      },
      customModels: {}
    };

    h.sandbox.window.contextMeterAPI = {
      ...h.sandbox.window.contextMeterAPI,
      syncPricing: async (opts) => {
        syncCalls++;
        assert.equal(opts?.force, true);
        return {
          ok: true,
          modelCount: 168,
          repricedCount: 1,
          sources: ['models.dev', 'litellm'],
          updatedAt: syncedCatalog.updatedAt
        };
      },
      getTokenHistory: async () => {
        historyCalls++;
        return {
          ok: true,
          data: {
            schemaVersion: '0.8.8',
            firstUseDate: '2026-11-20',
            dailyMap: dm,
            dailyMapBySource: { all: dm, desktop: dm, cli: {} },
            summary: { grandTotalTokens: 210000, todayTokens: 210000 },
            dynamicPricingCatalog: syncedCatalog,
            recentRequestLogs: [baseUnpricedRow]
          }
        };
      }
    };

    // 初始加载：未同步前显示未计价 "—"
    h.api.applyTokenHistoryPayload({
      schemaVersion: '0.8.8',
      firstUseDate: '2026-11-20',
      dailyMap: dm,
      dailyMapBySource: { all: dm, desktop: dm, cli: {} },
      summary: { grandTotalTokens: 210000, todayTokens: 210000 },
      recentRequestLogs: [baseUnpricedRow]
    });
    h.api.switchTokenViewForTest('requests');
    let st = h.api.getRequestsViewStateForTest();
    assert.equal(st.rowCount, 1);
    assert.equal(st.rows[0][8], '—');

    // 触发同步价格（经由 IPC -> 拉取最新历史并水合 dynamicPricingCatalog -> 前端即时回算出 $0.320）
    const syncRes = await h.api.syncPricingCatalog({ force: true });
    assert.equal(syncRes.ok, true);
    assert.equal(syncCalls, 1);
    assert.ok(historyCalls >= 1);
    assert.equal(h.elements.get('req-pricing-sync-note').textContent, '已同步 168 个模型 · 补算 1 条');
    st = h.api.getRequestsViewStateForTest();
    // (100k*2 + 100k*0.2 + 10k*10)/1e6 = 0.2 + 0.02 + 0.1 = $0.320
    assert.equal(st.rows[0][8], '$0.320');

    // 切换英文与繁体，确认同步按钮文案正确切换且英文无中文残留
    await h.api.setPanelLanguage('en', { persist: false });
    assert.equal(h.elements.get('btn-req-sync-pricing').textContent, 'Sync Prices');
    assert.doesNotMatch(h.elements.get('btn-req-sync-pricing').title, /[\u4e00-\u9fff]/);
    await h.api.setPanelLanguage('zh-TW', { persist: false });
    assert.equal(h.elements.get('btn-req-sync-pricing').textContent, '同步價格');
  } finally {
    h.api.dispose();
    core.setDynamicPricingCatalog(null);
    core.setCustomPricingCatalog({});
  }
});

test('耗时与速度延迟回填回归：transcript 先落盘入缓存且账本仅含半程 ttftSec，随后 .db 落盘时无需改 transcript 即可补齐完整耗时与速度', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-late-db-timing-'));
  const agDir = path.join(rootDir, 'antigravity');
  const cid = '77777777-7777-7777-7777-777777777777';
  const logsDir = path.join(agDir, 'brain', cid, '.system_generated', 'logs');
  const convDir = path.join(agDir, 'conversations');
  fs.mkdirSync(logsDir, { recursive: true });
  fs.mkdirSync(convDir, { recursive: true });

  try {
    const tPath = path.join(logsDir, 'transcript.jsonl');
    const createdIso = '2026-11-20T12:06:38.000Z';
    fs.writeFileSync(tPath, JSON.stringify({
      step_index: 5,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: createdIso,
      model: 'gemini-4-neon',
      input_tokens: 8100,
      cache_read_tokens: 240000,
      output_tokens: 600
    }) + '\n');

    // 模拟流式初期仅入账了 ttftSec=2.0（尚无 streamingSec / streamingTps）
    collector.recordModelCalls([{
      callId: `${cid}#5`,
      cascadeId: cid,
      stepIndex: 5,
      source: 'desktop',
      model: 'gemini-4-neon',
      inputTokens: 8100,
      cacheReadTokens: 240000,
      outputTokens: 600,
      totalTokens: 248700,
      ttftSec: 2.0,
      durationSec: 2.0,
      status: 'final',
      date: '2026-11-20',
      created_at: createdIso,
      timestamp: Date.parse(createdIso)
    }], { agDir, allowSynthetic: true });

    // 第一次扫描：此时 .db 尚未写入，transcriptFileCache 缓存该文件，仅有半程 ttftSec=2.0
    const res1 = await collector.collectTokenHistoryAsync({ agDir, force: true });
    assert.equal(res1.recentRequestLogs.length, 1);
    assert.equal(res1.recentRequestLogs[0].ttftSec, 2);
    assert.equal(res1.recentRequestLogs[0].streamingSec, null);
    assert.equal(res1.recentRequestLogs[0].streamingTps, null);

    // 随后 .db 落盘完整 gen_metadata（ttftSec=2, streamSec=4），且 transcript.jsonl 的 size/mtimeMs 完全不变
    const dbPath = path.join(convDir, `${cid}.db`);
    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE gen_metadata (id INTEGER PRIMARY KEY, data BLOB);');
    const insertStmt = db.prepare('INSERT INTO gen_metadata (data) VALUES (?)');
    insertStmt.run(buildGenMetadataRowBlob({
      stepIndex: 5,
      responseId: 'resp-late-5',
      model: 'gemini-4-neon',
      modelLabel: 'Gemini 4 Neon (XHigh)',
      ttftSec: 2,
      streamSec: 4
    }));
    db.close();

    // 第二次扫描：即使 transcript.jsonl 未变，也必须重查 .db 并把半程 2s 升级为完整 6s 与 150 tok/s
    const res2 = await collector.collectTokenHistoryAsync({ agDir, force: true });
    assert.equal(res2.recentRequestLogs.length, 1);
    assert.equal(res2.recentRequestLogs[0].ttftSec, 2);
    assert.equal(res2.recentRequestLogs[0].streamingSec, 4);
    assert.equal(res2.recentRequestLogs[0].durationSec, 6);
    assert.equal(res2.recentRequestLogs[0].streamingTps, 150);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('加固回归：0 字节新建 .db 安全跳过不建锁 + 超过 200 条测速裁剪后 recentRequestLogs 仍保留 .db 耗时且不反复写账本', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-prune-guard-'));
  const agDir = path.join(rootDir, 'antigravity');
  const cid = '88888888-8888-8888-8888-888888888888';
  const logsDir = path.join(agDir, 'brain', cid, '.system_generated', 'logs');
  const convDir = path.join(agDir, 'conversations');
  fs.mkdirSync(logsDir, { recursive: true });
  fs.mkdirSync(convDir, { recursive: true });

  try {
    // 1. 0 字节 .db 跳过并可后续恢复
    const emptyDbPath = path.join(convDir, '00000000-0000-0000-0000-000000000001.db');
    fs.writeFileSync(emptyDbPath, Buffer.alloc(0));
    const skippedEmpty = collector.loadConversationDbMeta(emptyDbPath, '00000000-0000-0000-0000-000000000001');
    assert.equal(skippedEmpty.readMode, 'skipped');
    assert.equal(skippedEmpty.skippedReason, 'initializing_empty_db');

    // 2. 写入 205 条同模型记录：最老 1 条（#1）在 transcript + .db 里有完整耗时，但在账本里会被 pruneExcessSpeedSamples(200) 裁掉
    const tPath = path.join(logsDir, 'transcript.jsonl');
    const oldIso = '2026-11-20T01:00:00.000Z';
    fs.writeFileSync(tPath, JSON.stringify({
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: oldIso,
      model: 'gemini-4-neon',
      input_tokens: 5000,
      cache_read_tokens: 50000,
      output_tokens: 800
    }) + '\n');

    const dbPath = path.join(convDir, `${cid}.db`);
    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE gen_metadata (id INTEGER PRIMARY KEY, data BLOB);');
    db.prepare('INSERT INTO gen_metadata (data) VALUES (?)').run(buildGenMetadataRowBlob({
      stepIndex: 1,
      responseId: 'resp-old-pruned-1',
      model: 'gemini-4-neon',
      modelLabel: 'Gemini 4 Neon (XHigh)',
      ttftSec: 2,
      streamSec: 4
    }));
    db.close();

    const batch = [];
    const baseMs = Date.parse('2026-11-20T02:00:00.000Z');
    batch.push({
      callId: 'resp-old-pruned-1',
      cascadeId: cid,
      stepIndex: 1,
      source: 'desktop',
      model: 'Gemini 4 Neon (XHigh)',
      modelLabel: 'Gemini 4 Neon (XHigh)',
      modelExactId: 'MODEL_PLACEHOLDER_M535',
      inputTokens: 5000,
      cacheReadTokens: 50000,
      outputTokens: 800,
      totalTokens: 55800,
      ttftSec: 2,
      streamingSec: 4,
      durationSec: 6,
      tps: 133.3,
      streamingTps: 200,
      status: 'final',
      date: '2026-11-20',
      created_at: oldIso,
      timestamp: Date.parse(oldIso)
    });
    for (let i = 2; i <= 205; i++) {
      const ts = baseMs + i * 1000;
      const iso = new Date(ts).toISOString();
      batch.push({
        callId: `resp-newer-${i}`,
        cascadeId: cid,
        stepIndex: i,
        source: 'desktop',
        model: 'Gemini 4 Neon (XHigh)',
        modelLabel: 'Gemini 4 Neon (XHigh)',
        modelExactId: 'MODEL_PLACEHOLDER_M535',
        inputTokens: 1000,
        cacheReadTokens: 10000,
        outputTokens: 200,
        totalTokens: 11200,
        ttftSec: 1,
        streamingSec: 2,
        durationSec: 3,
        tps: 66.7,
        streamingTps: 100,
        status: 'final',
        date: '2026-11-20',
        created_at: iso,
        timestamp: ts
      });
    }
    collector.recordModelCalls(batch, { agDir, allowSynthetic: true });

    const ledgerPath = collector.getPricingLedgerPath(agDir);
    const ledgerBefore = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    // 确认账本里该老样本速度已被 pruneExcessSpeedSamples 裁掉
    assert.equal(ledgerBefore.calls['resp-old-pruned-1'].ttftSec, undefined);
    assert.equal(ledgerBefore.calls['resp-old-pruned-1'].streamingTps, undefined);

    // 首次扫描完成对账与计价入账，同时验证展示列表从 .db 恢复了完整耗时与速度
    const scanRes1 = await collector.collectTokenHistoryAsync({ agDir, force: true });
    const oldRow1 = scanRes1.recentRequestLogs.find(r => r.callId === 'resp-old-pruned-1');
    assert.ok(oldRow1);
    assert.equal(oldRow1.ttftSec, 2);
    assert.equal(oldRow1.streamingSec, 4);
    assert.equal(oldRow1.durationSec, 6);
    assert.equal(oldRow1.streamingTps, 200);

    // 稳态二次扫描：展示仍保留完整速度，且不会因为老样本被裁剪过而反复重写账本文件
    const mtimeStable = fs.statSync(ledgerPath).mtimeMs;
    const scanRes2 = await collector.collectTokenHistoryAsync({ agDir, force: true });
    const oldRow2 = scanRes2.recentRequestLogs.find(r => r.callId === 'resp-old-pruned-1');
    assert.equal(oldRow2.durationSec, 6);
    assert.equal(oldRow2.streamingTps, 200);
    assert.equal(fs.statSync(ledgerPath).mtimeMs, mtimeStable);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('输入栏状态条与 5 行卡片：三组信息、精确千分位、缓存命中率公式、三语与 ELV-64 商城避让', async () => {
  const h = createV089DomSandbox();
  try {
    // 1. 注入 5 轮 83 步调用数据，未缓存 144,035，缓存读取 12,306,944，输出 85,595，速度 213 tok/s，上下文 22%
    const totalInp = 144035;
    const cacheRead = 12306944;
    const outp = 85595;
    const calls = [];
    for (let i = 0; i < 83; i++) {
      calls.push({
        callId: `call-deepseek-${i}`,
        inputTokens: Math.floor(totalInp / 83),
        cacheReadTokens: Math.floor(cacheRead / 83),
        outputTokens: Math.floor(outp / 83)
      });
    }
    // 补齐余数
    calls[0].inputTokens += (totalInp - Math.floor(totalInp / 83) * 83);
    calls[0].cacheReadTokens += (cacheRead - Math.floor(cacheRead / 83) * 83);
    calls[0].outputTokens += (outp - Math.floor(outp / 83) * 83);

    h.api.setComposerStateForTest({
      allTurns: [1, 2, 3, 4, 5],
      sessionCalls: calls,
      lastSpeedEval: { tps: 213, streamingTps: 213 },
      sessionStats: { usedTokens: 44000, limitTokens: 200000 }
    });

    let sb = h.api.getComposerStatusBarStateForTest();
    assert.equal(sb.speedText, '5 轮 83 步 · 213 tok/s');
    assert.equal(sb.tokensText, '12.5M · 缓存 99%');
    assert.match(h.elements.get('csb-group-tokens').getAttribute('data-tooltip'), /会话缓存命中率 99%/);
    assert.equal(h.elements.get('csb-group-tokens').title, '', '原生 title 必须清空以杜绝双气泡');
    assert.equal(sb.contextText, '22%');
    assert.equal(sb.cardTotal, '12,536,574 tok');
    assert.equal(sb.cardHit, '99%');
    assert.equal(sb.cardUncached, '144,035 tok');
    assert.equal(sb.cardCached, '12,306,944 tok');
    assert.equal(sb.cardOutput, '85,595 tok');

    // 2. 切换英文验证：无汉字泄露
    await h.api.setPanelLanguage('en', { persist: false });
    sb = h.api.getComposerStatusBarStateForTest();
    assert.equal(sb.speedText, '5 turns 83 steps · 213 tok/s');
    assert.equal(sb.tokensText, '12.5M · Cache 99%');
    assert.doesNotMatch(sb.speedText, /[\u4e00-\u9fff]/);
    assert.doesNotMatch(sb.tokensText, /[\u4e00-\u9fff]/);

    // 3. 切换繁体验证
    await h.api.setPanelLanguage('zh-TW', { persist: false });
    sb = h.api.getComposerStatusBarStateForTest();
    assert.equal(sb.speedText, '5 輪 83 步 · 213 tok/s');
    assert.equal(sb.tokensText, '12.5M · 快取 99%');

    // 4. 零分母（纯输出无输入）与 0% 命中率严格区分
    h.api.setComposerStateForTest({
      sessionCalls: [{ inputTokens: 0, cacheReadTokens: 0, outputTokens: 500 }]
    });
    sb = h.api.getComposerStatusBarStateForTest();
    assert.equal(sb.cardHit, '—', '总输入为 0 时缓存命中率应显示 —');

    h.api.setComposerStateForTest({
      sessionCalls: [{ inputTokens: 1000, cacheReadTokens: 0, outputTokens: 200 }]
    });
    sb = h.api.getComposerStatusBarStateForTest();
    assert.equal(sb.cardHit, '0%', '总输入 > 0 且缓存为 0 时应确认显示 0%');

    // 5. Linear ELV-64 商城避让：会话中打开面板 -> 路由切至商城自动收起 -> 商城内切换保持关闭 -> 返回会话可手动唤起
    await h.api.setPanelLanguage('zh-CN', { persist: false });
    h.elements.get('badge-tokens').click();
    assert.equal(h.elements.get('panel-tokens').hidden, false, '点击顶栏应能打开 Token 看板');

    // 切到插件商城，路由变更触发自动收起面板
    h.sandbox.location.pathname = '/extensions';
    h.tick();
    assert.equal(h.elements.get('panel-tokens').hidden, true, '切到插件商城应自动收起面板');

    // 在商城子路由切换保持关闭
    h.sandbox.location.pathname = '/extensions/installed';
    h.tick();
    assert.equal(h.elements.get('panel-tokens').hidden, true, '商城子路由切换应保持关闭');

    // 返回本地会话，手动点击顶栏可重新打开
    h.sandbox.location.pathname = '/c/11111111-1111-1111-1111-111111111111';
    h.tick();
    h.elements.get('badge-tokens').click();
    assert.equal(h.elements.get('panel-tokens').hidden, false, '返回会话后手动点击顶栏应能正常唤起面板');

    // 6. 顶栏快捷配置与返回会话
    h.elements.get('btn-quick-settings').click();
    assert.equal(h.elements.get('pane-ctx-settings').hidden, false, '点击顶栏配置按钮应直接进入配置页');
    h.elements.get('btn-settings-back').click();
    assert.equal(h.elements.get('pane-ctx-settings').hidden, true, '点击返回按钮应切回会话概览');

    // 7. 隐藏顶栏开关
    const chkHide = h.elements.get('chk-hide-topbar');
    chkHide.checked = true;
    chkHide.click();
    assert.equal(h.host.getAttribute('data-topbar-hidden'), 'true', '勾选隐藏顶栏应生效');
    chkHide.checked = false;
    chkHide.click();
    assert.equal(h.host.getAttribute('data-topbar-hidden'), null, '取消勾选隐藏顶栏应恢复');
  } finally {
    h.api.dispose();
  }
});

test('输入栏状态条与 5 行悬停卡：单色线性 SVG 图标、动态圆环与点击入口验证', async () => {
  const h = createV089DomSandbox();
  try {
    // 1. 验证单色线性 SVG 图标与无 emoji 残留
    const csbBar = h.elements.get('composer-status-bar');
    assert.ok(csbBar, '输入框状态条容器应存在');
    const csbHtml = csbBar.innerHTML || '';
    assert.doesNotMatch(csbHtml, /[⏱🛢◔]/, '状态条中严禁出现粗糙 emoji 字符');

    // 2. 动态圆环进度断言
    h.api.setComposerStateForTest({
      allTurns: [1, 2],
      sessionCalls: [{ inputTokens: 500, cacheReadTokens: 500, outputTokens: 100 }],
      lastSpeedEval: { tps: 120 },
      sessionStats: { usedTokens: 50000, limitTokens: 100000 }
    });
    const circleEl = h.elements.get('csb-context-circle');
    if (circleEl) {
      assert.ok(circleEl.style.strokeDashoffset, '50% 进度时上下文圆环应有动态 strokeDashoffset');
      assert.equal(circleEl.style.strokeDashoffset, '26.7', '50% 时 offset 应为周长的一半 26.7');
    }

    // 3. 点击入口与悬停卡
    const csbTokens = h.elements.get('csb-group-tokens');
    const tflCard = h.elements.get('csb-card-tokens');
    if (csbTokens && tflCard) {
      if (typeof csbTokens.trigger === 'function') {
        csbTokens.trigger('mouseenter');
      } else {
        csbTokens.dispatchEvent?.({ type: 'mouseenter' });
      }
      assert.equal(tflCard.hidden, false, '悬停在 Token 胶囊上时五行卡片应显示');
      if (typeof csbTokens.trigger === 'function') {
        csbTokens.trigger('mouseleave');
      } else {
        csbTokens.dispatchEvent?.({ type: 'mouseleave' });
      }
      assert.equal(tflCard.hidden, true, '移开时五行卡片应隐藏');
    }

    if (csbTokens) {
      csbTokens.click();
      assert.equal(h.elements.get('panel-tokens').hidden, false, '点击 Token 胶囊应打开 Token 看板');
    }
  } finally {
    h.api.dispose();
  }
});

test('输入框下方摘要与工具栏按钮独立挂载', async () => {
  const h = createV089DomSandbox();
  try {
    const csbBar = h.elements.get('composer-status-bar');
    assert.ok(csbBar, '状态条应存在');

    // 模拟原生平铺工具栏：[+], [modelBtn], [permissionBtn (极速)], [micBtn], [sendBtn]
    const bar = {
      children: [],
      style: {},
      contains(target) { return this.children.includes(target); },
      insertBefore(node, ref) {
        const idx = this.children.indexOf(ref);
        if (idx !== -1) {
          const oldIdx = this.children.indexOf(node);
          if (oldIdx !== -1) this.children.splice(oldIdx, 1);
          this.children.splice(idx, 0, node);
          node.parentElement = this;
          node.nextElementSibling = ref;
        } else {
          this.appendChild(node);
        }
      },
      appendChild(node) {
        const oldIdx = this.children.indexOf(node);
        if (oldIdx !== -1) this.children.splice(oldIdx, 1);
        this.children.push(node);
        node.parentElement = this;
        node.nextElementSibling = null;
      }
    };

    const addBtn = { parentElement: bar, textContent: '+', getAttribute: () => null, querySelector: () => null };
    const modelBtn = { parentElement: bar, textContent: 'Claude 3.7 Sonnet', getAttribute: (k) => k === 'aria-label' ? 'Claude 3.7 Sonnet' : null, querySelector: () => null };
    const permBtn = { parentElement: bar, textContent: '极速', getAttribute: (k) => k === 'aria-label' ? '极速' : null, querySelector: () => null };
    const micBtn = { parentElement: bar, textContent: '', getAttribute: (k) => k === 'aria-label' ? 'mic' : null, querySelector: () => null };
    const sendBtn = { parentElement: bar, textContent: '', getAttribute: (k) => k === 'aria-label' ? 'Send' : null, querySelector: () => null };

    bar.children = [addBtn, modelBtn, permBtn, micBtn, sendBtn];

    // 在沙箱 document 中挂载查询
    h.sandbox.document.querySelector = (sel) => {
      if (/send/i.test(sel)) return sendBtn;
      if (/mic/i.test(sel)) return micBtn;
      return null;
    };
    h.sandbox.document.querySelectorAll = (sel) => {
      if (sel === 'button') return bar.children;
      return [];
    };

    const composer = { after(node) { this.nextElementSibling = node; } };
    bar.closest = selector => selector === 'form' ? composer : null;
    h.api.setComposerQuotaSummaryEnabledForTest(true);
    h.api.ensureComposerStatusBarMountedForTest();
    assert.equal(composer.nextElementSibling, csbBar);
    assert.ok(!bar.children.includes(csbBar));
    bar.children = [addBtn, modelBtn, micBtn, sendBtn];
    h.api.ensureComposerStatusBarMountedForTest();
    assert.equal(composer.nextElementSibling, csbBar);
  } finally {
    h.api.dispose();
  }
});

test('6. 请求来源图标：使用本项目原创内联矢量 SVG、无第三方 PNG 品牌资产或 exe 提取逻辑、透明等比渲染', () => {
  const legacyAssetPath = path.join(__dirname, 'assets', 'antigravity-icon__full-color.png');
  assert.equal(fs.existsSync(legacyAssetPath), false, '发布包不得包含第三方品牌 PNG 资产 antigravity-icon__full-color.png');

  // 验证构建、打包与安装脚本已清理第三方 PNG 资产及旧版 exe 提取逻辑
  const installJs = fs.readFileSync(path.join(__dirname, 'install.js'), 'utf8');
  const pkgReleaseJs = fs.readFileSync(path.join(__dirname, 'scripts', 'package-release.js'), 'utf8');
  const mainSrc = fs.readFileSync(path.join(__dirname, 'src', 'renderer', 'main.js'), 'utf8');
  assert.equal(/antigravity-icon__full-color\.png/.test(installJs), false);
  assert.equal(/antigravity-icon__full-color\.png/.test(pkgReleaseJs), false);
  assert.equal(/antigravity-icon__full-color\.png/.test(mainSrc), false);
  assert.equal(/AG_OFFICIAL_ICON_B64|AG_BUNDLED_ICON_B64|extractIcon/i.test(mainSrc), false, '不得残留从宿主提取图标或第三方品牌 PNG 注入逻辑');
  assert.match(RENDERER_SOURCE, /data:image\/svg\+xml;utf8,/, '构建后的 meter-renderer.js 必须内联原创矢量 SVG 图标');

  // 渲染验证：透明背景、object-fit:contain、14px 等比容器与来源名称并列居中
  const h = createV089DomSandbox();
  try {
    h.api.applyTokenHistoryPayload({
      schemaVersion: '0.8.8',
      firstUseDate: '2026-11-21',
      dailyMap: { '2026-11-21': { total: 1000, input: 800, cache: 0, output: 200, steps: 1 } },
      dailyMapBySource: {
        all: { '2026-11-21': { total: 1000, input: 800, cache: 0, output: 200, steps: 1 } },
        desktop: { '2026-11-21': { total: 1000, input: 800, cache: 0, output: 200, steps: 1 } }
      },
      summary: { grandTotalTokens: 1000, todayTokens: 1000 },
      recentRequestLogs: [{
        callId: 'req-desktop-color-icon',
        source: 'desktop',
        createdAt: '2026-11-21T00:10:00Z',
        model: 'Gemini 3.8 Flash (High)',
        inputTokens: 800,
        outputTokens: 200,
        ttftSec: 1.2,
        streamingSec: 1.5,
        durationSec: 2.7,
        streamingTps: 133,
        status: 'final'
      }]
    });
    h.api.switchTokenViewForTest('requests');
    const tbody = h.elements.get('req-live-tbody');
    assert.equal(tbody.children.length, 1);
    const agentTd = tbody.children[0].children[1];
    const agentCell = agentTd.children[0];
    const iconWrap = agentCell.children[0];
    const img = iconWrap.children[0];
    assert.equal(agentCell.className, 'req-agent-cell');
    assert.equal(iconWrap.className, 'req-agent-icon');
    assert.match(img.src, /^data:image\/svg\+xml;utf8,/);
    const decodedSvg = decodeURIComponent(img.src.slice('data:image/svg+xml;utf8,'.length));
    assert.match(decodedSvg, /viewBox=.0 0 180 180./);
    assert.equal(/<script|onload|onerror|onclick/i.test(decodedSvg), false, '内嵌 Antigravity SVG 只能包含纯静态绘图');
    assert.equal(img.width, 14);
    assert.equal(img.height, 14);
    assert.match(img.style.cssText, /object-fit:contain/);
    assert.match(img.style.cssText, /background:transparent/);
  } finally {
    h.api.dispose();
  }
});

test('Issue #77 历史用量守恒与防撞回归：删会话保留旧消耗、回退重发独立记账、流式/镜像去重、子代理与备份节流', async () => {
  const os = require('node:os');
  const collector = require('./meter-collector');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-issue77-'));
  const agDir = path.join(tmpDir, 'ag');
  const cliDir = path.join(tmpDir, 'cli');
  const stateDir = path.join(tmpDir, 'state');
  fs.mkdirSync(path.join(agDir, 'conversations'), { recursive: true });
  fs.mkdirSync(path.join(cliDir, 'conversations'), { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });

  const now = new Date();
  const todayStr = collector.formatLocalDateKey(now);
  const t0 = new Date(now.getTime() - 180000).toISOString();
  const t1 = new Date(now.getTime() - 120000).toISOString();
  const t2 = new Date(now.getTime() - 60000).toISOString();

  try {
    // 1. 故障 1：当天会话 A (含已计价 Neon 1000 tok + 未计价具名 GPT-OSS 500 tok + 缺模型 fallback 300 tok = 1800) 入账
    const cidA = 'a1111111-1111-4111-8111-111111111111';
    const logDirA = path.join(agDir, 'brain', cidA, '.system_generated', 'logs');
    fs.mkdirSync(logDirA, { recursive: true });
    fs.writeFileSync(path.join(agDir, 'conversations', `${cidA}.pb`), 'pbA');
    fs.writeFileSync(path.join(logDirA, 'transcript.jsonl'), [
      JSON.stringify({ step_index: 0, callId: 'resp_a_neon', model: 'Gemini 4 Neon (High)', input_tokens: 700, cache_read_tokens: 200, output_tokens: 100, status: 'DONE', created_at: t0 }),
      JSON.stringify({ step_index: 1, model: 'GPT-OSS 120B (Medium)', input_tokens: 400, cache_read_tokens: 0, output_tokens: 100, status: 'DONE', created_at: t0 }),
      JSON.stringify({ step_index: 2, input_tokens: 250, cache_read_tokens: 0, output_tokens: 50, status: 'DONE', created_at: t0 })
    ].join('\n') + '\n');

    const h1 = await collector.collectTokenHistoryAsync({
      force: true,
      agDir,
      agCliDir: cliDir,
      stateDir,
      skipWslDiscovery: true
    });
    assert.equal(h1.dailyMapBySource.desktop[todayStr].total, 1800);
    assert.equal(h1.summary.grandTotalTokens, 1800);

    // 彻底删除会话 A 文件，然后新建当天会话 B (600 tok) 并重扫：旧消耗 1800 必须保留，总计 2400！
    fs.rmSync(path.join(agDir, 'brain', cidA), { recursive: true, force: true });
    fs.rmSync(path.join(agDir, 'conversations', `${cidA}.pb`), { force: true });

    const cidB = 'b2222222-2222-4222-8222-222222222222';
    const logDirB = path.join(agDir, 'brain', cidB, '.system_generated', 'logs');
    fs.mkdirSync(logDirB, { recursive: true });
    fs.writeFileSync(path.join(agDir, 'conversations', `${cidB}.pb`), 'pbB');
    fs.writeFileSync(path.join(logDirB, 'transcript.jsonl'), JSON.stringify({
      step_index: 0,
      callId: 'resp_b_flash',
      model: 'Gemini 3.8 Flash',
      input_tokens: 500,
      cache_read_tokens: 0,
      output_tokens: 100,
      status: 'DONE',
      created_at: t1
    }) + '\n');

    const h2 = await collector.collectTokenHistoryAsync({
      force: true,
      agDir,
      agCliDir: cliDir,
      stateDir,
      skipWslDiscovery: true
    });
    assert.equal(h2.dailyMapBySource.desktop[todayStr].total, 2400, '删掉当天已入账会话并新建会话后必须保留旧消耗并继续累加');
    assert.equal(h2.summary.grandTotalTokens, 2400);

    // 2. 故障 2：同 stepIndex 流式更新 (RUNNING -> DONE) & 重复镜像去重，而回退重发 (同 stepIndex 不同时间/用量) 必须分别保留！
    const cidRew = 'c3333333-3333-4333-8333-333333333333';
    const logDirRew = path.join(agDir, 'brain', cidRew, '.system_generated', 'logs');
    const logPathRew = path.join(logDirRew, 'transcript.jsonl');
    fs.mkdirSync(logDirRew, { recursive: true });
    fs.writeFileSync(path.join(agDir, 'conversations', `${cidRew}.pb`), 'pbRew');
    const rewindLines = [
      // step 3 首次调用：流式 RUNNING (150) -> 完成 DONE (400) -> 复制镜像行 DONE (400) => 仅记 1 次 (400)
      JSON.stringify({ step_index: 3, model: 'Gemini 4 Carbon', input_tokens: 100, cache_read_tokens: 0, output_tokens: 50, status: 'RUNNING', created_at: t1 }),
      JSON.stringify({ step_index: 3, model: 'Gemini 4 Carbon', input_tokens: 100, cache_read_tokens: 0, output_tokens: 300, status: 'DONE', created_at: t1 }),
      JSON.stringify({ step_index: 3, model: 'Gemini 4 Carbon', input_tokens: 100, cache_read_tokens: 0, output_tokens: 300, status: 'DONE', created_at: t1 }),
      // step 3 回退重发：新的输入和输出 (900) => 必须作为第二条独立调用保留 (@2)！
      JSON.stringify({ step_index: 3, model: 'Gemini 4 Carbon', input_tokens: 600, cache_read_tokens: 100, output_tokens: 200, status: 'DONE', created_at: t2 })
    ];
    fs.writeFileSync(logPathRew, rewindLines.join('\n') + '\n');

    // 验证时间线解析：仅产生 2 次调用 (400 与 900 = 1300)，且 callId 互不碰撞
    const tlParsed = collector.parseTranscriptForSessionTimeline(logPathRew, cidRew, path.join(agDir, 'conversations'), 'desktop');
    assert.equal(tlParsed.calls.length, 2);
    assert.deepEqual(tlParsed.calls.map(c => c.totalTokens), [400, 900]);
    assert.notEqual(tlParsed.calls[0].callId, tlParsed.calls[1].callId);

    // 验证全量历史统计同样保留两笔 (2400 + 1300 = 3700) 且跨重启/多次重复扫描零增减
    const h3 = await collector.collectTokenHistoryAsync({
      force: true,
      agDir,
      agCliDir: cliDir,
      stateDir,
      skipWslDiscovery: true
    });
    assert.equal(h3.dailyMapBySource.desktop[todayStr].total, 3700);
    collector.transcriptFileCache.clear();
    const h3Repeat = await collector.collectTokenHistoryAsync({
      force: true,
      agDir,
      agCliDir: cliDir,
      stateDir,
      skipWslDiscovery: true
    });
    assert.equal(h3Repeat.summary.grandTotalTokens, 3700);

    // 3. 验证 40MB+ .bak.json 读取备份节流：刚生成过 .bak.json 后在 10 分钟内即便主账本 mtime/size 变动也不反复 copyFileSync
    const ledgerFile = collector.getPricingLedgerPath(agDir);
    const bakFile = ledgerFile.replace(/\.json$/i, '.bak.json');
    assert.equal(fs.existsSync(bakFile), true);
    let copyCount = 0;
    const origCopy = fs.copyFileSync;
    const bakMtimeBefore = fs.statSync(bakFile).mtimeMs;
    const ledgerData = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
    ledgerData.updatedAt = new Date().toISOString();
    fs.writeFileSync(ledgerFile, JSON.stringify(ledgerData));
    const spyFs = {
      ...fs,
      copyFileSync: (...a) => { copyCount++; return origCopy(...a); }
    };
    for (let k = 0; k < 25; k++) {
      collector.loadPricingLedger(agDir, { fs: spyFs });
    }
    assert.equal(copyCount, 0, '10 分钟窗口内 loadPricingLedger 不得高频 copyFileSync 重写 .bak.json');
    assert.equal(fs.statSync(bakFile).mtimeMs, bakMtimeBefore);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
