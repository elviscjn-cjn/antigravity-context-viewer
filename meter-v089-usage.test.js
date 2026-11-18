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
      contextMeterAPI: {
        scan: async () => ({ ok: true, data: { session: null, scannedAt: Date.now() } }),
        getSessionTimeline: async () => ({ ok: true, data: { turns: [], unlinkedSubagentCalls: [], totalCalls: 0, mainCallsCount: 0, subagentCallsCount: 0, cacheSummary: core.summarizeCacheReadStats([]) } })
      }
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
    const res1 = await collector.collectTokenHistoryAsync({ agDir, wslRoots: [], force: true });
    const coldMs = performance.now() - tCold0;

    const tWarm0 = performance.now();
    const res2 = await collector.collectTokenHistoryAsync({ agDir, wslRoots: [], force: false });
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
    assert.match(cssSrc, /\.session-timeline-list\{[^}]*flex:0 0 auto;[^}]*max-height:min\(360px,46vh\)[^}]*overflow-y:auto/);
    assert.match(cssSrc, /\.timeline-turn-card\{\s*flex:0 0 auto;/);
    assert.match(RENDERER_SOURCE, /\.timeline-turn-card\{[^}]*flex:0 0 auto;/);
  } finally {
    fs.rmSync(agDir, { recursive: true, force: true });
  }
});
