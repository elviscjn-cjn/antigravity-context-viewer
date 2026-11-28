'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const core = require('./meter-core');
const collector = require('./meter-collector');
const accounts = require('./meter-accounts');
const taskQuota = require('./meter-task-quota');
const scrollGuard = require('./src/renderer/quota-scroll-guard');

function makeTempDir(prefix = 'ag-data-02-07-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeHostQuotaPayload({
  email = 'elvis@example.com',
  g5h = 0.85,
  g7d = 0.72,
  c5h = 1,
  c7d = 1,
  reset5h = '2026-11-27T11:21:56Z',
  reset7d = '2026-12-03T07:47:09Z',
  fetchedAtMs = 1795679200000,
  sourceType = 'quota_summary_and_configs',
  ok = true,
  dataFreshness = 'host_default'
} = {}) {
  const scopeKey = collector.buildAccountScopeKey(email);
  const snap = core.buildModelQuotaSnapshot({
    quotaSummaryRes: {
      response: {
        groups: [
          {
            displayName: 'Gemini Models',
            description: 'Models within this group: Gemini 4 Neon, Gemini 4 Hydrogen, Gemini 3.8 Flash',
            buckets: [
              { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: g7d, resetTime: reset7d },
              { bucketId: 'gemini-5h', window: '5h', remainingFraction: g5h, resetTime: reset5h }
            ]
          },
          {
            displayName: 'Claude and GPT models',
            description: 'Models within this group: Claude Opus 5.5, Claude Sonnet 5.5, GPT-OSS 120B',
            buckets: [
              { bucketId: '3p-weekly', window: 'weekly', remainingFraction: c7d },
              { bucketId: '3p-5h', window: '5h', remainingFraction: c5h }
            ]
          }
        ]
      }
    },
    nowMs: fetchedAtMs,
    fetchMeta: { fetchedAtMs }
  });
  for (const p of snap.pools) p.sourceType = sourceType;
  return {
    ok,
    email,
    accountScopeKey: scopeKey,
    identityVerified: true,
    fetchedAtMs,
    lastSuccessAtMs: fetchedAtMs,
    dataFreshness,
    snapshot: snap
  };
}

// =========================================================================
// 1. 单次任务 5H/7D 额度追踪全边界回归 (02 + 07 共享契约)
// =========================================================================
test('02/07 单任务额度观测：正常差值(3pp & 0.4pp)、零变化、同池多模型不重复计、多回复仅终结挂一次、三语零括号', () => {
  const t0 = 1795679000000;
  const startRaw = makeHostQuotaPayload({ g5h: 1.0, g7d: 0.85, fetchedAtMs: t0 });
  const endRaw = makeHostQuotaPayload({ g5h: 0.97, g7d: 0.846, fetchedAtMs: t0 + 15000 });

  const tracker = taskQuota.createTaskQuotaTracker({ syncWindowMs: 60000 });
  tracker.recordSnapshot(startRaw, { nowMs: t0 });
  const scopeKey = startRaw.accountScopeKey;

  tracker.beginTask({
    taskId: 'task-001',
    sessionId: 'sess-alpha',
    accountScopeKey: scopeKey,
    poolKey: 'gemini-4-neon-medium',
    modelId: 'gemini-4-neon-medium',
    nowMs: t0 + 100
  });
  // 同一任务多模型落入同一 shared_gemini_main 池，只记一次池观察，保留全部模型追踪
  tracker.recordModelCall('task-001', { modelId: 'gemini-3.8-flash-high', poolKey: 'gemini-3.8-flash' });
  const obs = tracker.finishTask('task-001', { taskStatus: 'completed', endSnapshot: endRaw, nowMs: t0 + 15000 });

  assert.equal(obs.poolKey, 'shared_gemini_main');
  assert.deepEqual(obs.modelIds, ['gemini-4-neon-medium', 'gemini-3.8-flash-high']);
  assert.equal(obs.windows['5h'].status, 'observed');
  assert.equal(obs.windows['5h'].attributionKind, 'observed');
  assert.equal(obs.windows['5h'].deltaPp, 3);
  assert.equal(obs.windows['5h'].windowDisplay, '5H');
  assert.equal(obs.windows['weekly'].status, 'observed');
  assert.equal(obs.windows['weekly'].deltaPp, 0.4);
  assert.equal(obs.windows['weekly'].windowDisplay, '7D');

  for (const lang of ['zh-CN', 'zh-TW', 'en']) {
    const compact = taskQuota.formatTaskQuotaCompact(obs, lang);
    assert.ok(compact.includes('5H') && compact.includes('7D'), `${lang} 必须使用大写 5H/7D: ${compact}`);
    assert.equal(/[()（）]/.test(compact), false, `${lang} 紧凑文案必须零中英文括号: ${compact}`);
  }

  // 多助手回复仅终结回复挂载一次
  const attached = taskQuota.attachTaskQuotaToReplies(obs, ['msg-1', 'msg-2', 'msg-3']);
  assert.equal(attached.filter(x => x.taskQuotaSummary !== null).length, 1);
  assert.equal(attached[2].isTaskTerminalReply, true);
  assert.equal(attached[0].taskQuotaSummary, null);

  // 有效采样无变化 -> 明确 observed_zero，不混同缺失
  const sameSnap = makeHostQuotaPayload({ g5h: 0.97, g7d: 0.846, fetchedAtMs: t0 + 25000 });
  const zeroObs = taskQuota.evaluateTaskQuotaDelta({
    startSnapshot: taskQuota.normalizeHostQuotaSnapshot(endRaw, { nowMs: t0 + 15000 }),
    endSnapshot: taskQuota.normalizeHostQuotaSnapshot(sameSnap, { nowMs: t0 + 25000 }),
    taskMeta: { taskId: 'task-zero', poolKey: 'shared_gemini_main', taskStatus: 'completed' },
    nowMs: t0 + 25000
  });
  assert.equal(zeroObs.windows['5h'].status, 'observed_zero');
  assert.equal(zeroObs.windows['5h'].deltaPp, 0);
});

test('02/07 单任务额度边界：重置/回升/晚到幂等/超窗缺样本/并发不可摊派/切号分段/跨源禁止/取消失败保留观测', () => {
  const t0 = 1795679000000;
  const startSnap = taskQuota.normalizeHostQuotaSnapshot(
    makeHostQuotaPayload({ g5h: 0.60, g7d: 0.70, reset5h: '2026-11-27T11:21:56Z', fetchedAtMs: t0 }),
    { nowMs: t0 }
  );

  // 1. 周期重置 (resetTime 推进)
  const resetSnap = taskQuota.normalizeHostQuotaSnapshot(
    makeHostQuotaPayload({ g5h: 0.99, g7d: 0.695, reset5h: '2026-11-27T16:21:56Z', fetchedAtMs: t0 + 10000 }),
    { nowMs: t0 + 10000 }
  );
  const resetRes = taskQuota.evaluateTaskQuotaDelta({
    startSnapshot: startSnap,
    endSnapshot: resetSnap,
    taskMeta: { taskId: 't-reset', poolKey: 'shared_gemini_main' },
    nowMs: t0 + 10000
  });
  assert.equal(resetRes.windows['5h'].status, 'reset_crossed');
  assert.equal(resetRes.windows['5h'].deltaPp, null);
  assert.equal(resetRes.windows['weekly'].status, 'observed');
  assert.equal(resetRes.windows['weekly'].deltaPp, 0.5);

  // 2. 剩余回升 (无 resetTime 变动但余量升高)
  const reboundSnap = taskQuota.normalizeHostQuotaSnapshot(
    makeHostQuotaPayload({ g5h: 0.65, g7d: 0.70, reset5h: '2026-11-27T11:21:56Z', fetchedAtMs: t0 + 10000 }),
    { nowMs: t0 + 10000 }
  );
  const rebRes = taskQuota.evaluateTaskQuotaDelta({
    startSnapshot: startSnap,
    endSnapshot: reboundSnap,
    taskMeta: { taskId: 't-rebound', poolKey: 'shared_gemini_main' },
    nowMs: t0 + 10000
  });
  assert.equal(rebRes.windows['5h'].status, 'rebounded');
  assert.equal(rebRes.windows['5h'].deltaPp, null);

  // 3. 跨源相减保护 (GetUserStatus vs RetrieveUserQuotaSummary 严禁相减)
  const userStatusEnd = taskQuota.normalizeHostQuotaSnapshot(
    makeHostQuotaPayload({ g5h: 0.58, g7d: 0.69, fetchedAtMs: t0 + 10000, sourceType: 'model_configs_only' }),
    { nowMs: t0 + 10000 }
  );
  const mixRes = taskQuota.evaluateTaskQuotaDelta({
    startSnapshot: startSnap,
    endSnapshot: userStatusEnd,
    taskMeta: { taskId: 't-mix', poolKey: 'shared_gemini_main' },
    nowMs: t0 + 10000
  });
  assert.equal(mixRes.windows['5h'].status, 'source_mismatch');
  assert.equal(mixRes.windows['5h'].deltaPp, null);

  // 4. 并发重叠 + 晚到幂等补记一次 + 超窗缺样本
  const tracker = taskQuota.createTaskQuotaTracker({ syncWindowMs: 30000 });
  const rawStart = makeHostQuotaPayload({ g5h: 0.80, g7d: 0.90, fetchedAtMs: t0 });
  tracker.recordSnapshot(rawStart, { nowMs: t0 });
  tracker.beginTask({ taskId: 't-conc-1', accountScopeKey: rawStart.accountScopeKey, poolKey: 'shared_gemini_main', nowMs: t0 + 100 });
  tracker.beginTask({ taskId: 't-conc-2', accountScopeKey: rawStart.accountScopeKey, poolKey: 'shared_gemini_main', nowMs: t0 + 200 });
  const pending = tracker.finishTask('t-conc-1', { taskStatus: 'completed', nowMs: t0 + 5000 });
  assert.equal(pending.windows['5h'].status, 'pending_sync');
  assert.equal(pending.windows['5h'].deltaPp, null);

  // 窗口内宿主更新到达 -> 幂等补记，标记 concurrent_ambiguous 不可摊派
  const rawLate1 = makeHostQuotaPayload({ g5h: 0.76, g7d: 0.895, fetchedAtMs: t0 + 12000 });
  tracker.recordSnapshot(rawLate1, { nowMs: t0 + 12000 });
  const afterLate1 = tracker.getTaskObservation('t-conc-1', t0 + 12000);
  assert.equal(afterLate1.windows['5h'].status, 'concurrent_ambiguous');
  assert.equal(afterLate1.windows['5h'].deltaPp, 4);
  assert.equal(afterLate1.windows['5h'].isApportionable, false);
  assert.ok(afterLate1.windows['5h'].concurrentTaskIds.includes('t-conc-2'));
  const settledBefore = tracker.getSettledWriteCount();

  // 再次收到更晚快照 -> 幂等不覆写已结案记录
  const rawLate2 = makeHostQuotaPayload({ g5h: 0.50, g7d: 0.80, fetchedAtMs: t0 + 20000 });
  tracker.recordSnapshot(rawLate2, { nowMs: t0 + 20000 });
  assert.equal(tracker.getTaskObservation('t-conc-1', t0 + 20000).windows['5h'].deltaPp, 4);
  assert.equal(tracker.getSettledWriteCount(), settledBefore);

  // 超窗缺样本
  tracker.beginTask({ taskId: 't-miss', accountScopeKey: rawStart.accountScopeKey, poolKey: 'shared_gemini_main', nowMs: t0 + 40000 });
  tracker.finishTask('t-miss', { taskStatus: 'completed', nowMs: t0 + 45000 });
  const expiredObs = tracker.getTaskObservation('t-miss', t0 + 90000);
  assert.equal(expiredObs.windows['5h'].status, 'missing_end');
  assert.equal(expiredObs.windows['5h'].deltaPp, null);

  // 5. 切号分段：绝不把旧账号前值与新账号后值相减
  const acctAStart = makeHostQuotaPayload({ email: 'a@example.com', g5h: 0.90, g7d: 0.90, fetchedAtMs: t0 });
  const acctAEnd = makeHostQuotaPayload({ email: 'a@example.com', g5h: 0.88, g7d: 0.898, fetchedAtMs: t0 + 3000 });
  const acctBStart = makeHostQuotaPayload({ email: 'b@example.com', g5h: 0.50, g7d: 0.50, fetchedAtMs: t0 + 3500 });
  const acctBEnd = makeHostQuotaPayload({ email: 'b@example.com', g5h: 0.49, g7d: 0.499, fetchedAtMs: t0 + 8000 });
  const swTracker = taskQuota.createTaskQuotaTracker({ syncWindowMs: 30000 });
  swTracker.recordSnapshot(acctAStart, { nowMs: t0 });
  swTracker.beginTask({ taskId: 't-sw', accountScopeKey: acctAStart.accountScopeKey, poolKey: 'shared_gemini_main', nowMs: t0 + 100 });
  swTracker.recordAccountSwitch('t-sw', {
    nextAccountScopeKey: acctBStart.accountScopeKey,
    prevAccountEndSnapshot: acctAEnd,
    nextAccountStartSnapshot: acctBStart,
    nowMs: t0 + 3500
  });
  const swObs = swTracker.finishTask('t-sw', { taskStatus: 'completed', endSnapshot: acctBEnd, nowMs: t0 + 8000 });
  assert.equal(swObs.accountSwitched, true);
  assert.equal(swObs.windows['5h'].status, 'account_switched');
  assert.equal(swObs.windows['5h'].deltaPp, null);
  assert.equal(swObs.accountSegments.length, 2);
  assert.equal(swObs.accountSegments[0].windows['5h'].deltaPp, 2);
  assert.equal(swObs.accountSegments[1].windows['5h'].deltaPp, 1);

  // 6. 取消/失败保留真实终态与观测值，不假定未扣
  const cancelEnd = taskQuota.normalizeHostQuotaSnapshot(
    makeHostQuotaPayload({ g5h: 0.59, g7d: 0.699, fetchedAtMs: t0 + 4000 }),
    { nowMs: t0 + 4000 }
  );
  const cancelRes = taskQuota.evaluateTaskQuotaDelta({
    startSnapshot: startSnap,
    endSnapshot: cancelEnd,
    taskMeta: { taskId: 't-cancel', poolKey: 'shared_gemini_main', taskStatus: 'cancelled' },
    nowMs: t0 + 4000
  });
  assert.equal(cancelRes.taskStatus, 'cancelled');
  assert.equal(cancelRes.windows['5h'].status, 'observed');
  assert.equal(cancelRes.windows['5h'].deltaPp, 1);
});

// =========================================================================
// 2. 07 实时请求表端到端速度口径、排序一致性与流式详情短样本归因
// =========================================================================
test('07 实时请求表：端到端速度为默认列与排序共享未舍入值、6768.6 短流式归详情不兜底、缺样本排后', () => {
  // 截图可解释性对照：863 tok, 流式 0.1275s (6768.6 tok/s), 总耗时 25.0s -> E2E 34.5 tok/s
  const burstRec = {
    callId: 'req-burst',
    outputTokens: 863,
    ttftSec: 24.8725,
    streamingSec: 0.1275,
    durationSec: 25.0,
    streamingTps: 6768.6,
    status: 'final',
    timestamp: 1000
  };
  const normalRec = {
    callId: 'req-normal',
    outputTokens: 500,
    ttftSec: 1.0,
    streamingSec: 9.0,
    durationSec: 10.0,
    streamingTps: 55.6,
    status: 'final',
    timestamp: 2000
  };
  const unlinkedRec = {
    callId: 'req-unlinked',
    outputTokens: 300,
    streamingSec: 0.1,
    streamingTps: 3000,
    durationSec: 5.0,
    untrustedTiming: true,
    status: 'final',
    timestamp: 3000
  };
  const noOutRec = {
    callId: 'req-noout',
    outputTokens: 0,
    durationSec: 4.0,
    status: 'final',
    timestamp: 4000
  };
  const batchRec = {
    callId: 'req-batch',
    outputTokens: 200,
    ttftSec: 4.0,
    streamingSec: 0,
    durationSec: 4.0,
    status: 'final',
    timestamp: 5000
  };
  const liveRec = {
    callId: 'req-live',
    outputTokens: 40,
    durationSec: 1.2,
    status: 'streaming',
    timestamp: 6000
  };

  const burstSpd = core.resolveRequestTableSpeed(burstRec);
  assert.equal(burstSpd.calculable, true);
  assert.equal(burstSpd.hasValidE2e, true);
  assert.equal(burstSpd.source, 'e2e');
  assert.equal(burstSpd.speed, 34.5);
  assert.equal(burstSpd.endToEndTps, 34.5);
  assert.ok(Math.abs(burstSpd.rawSpeed - (863 / 25.0)) < 1e-9);
  assert.equal(burstSpd.e2eSortValue, burstSpd.rawSpeed);
  const compatRow = core.resolveRequestRowSpeed(burstRec);
  assert.equal(compatRow.hasValidE2e, true);
  assert.equal(compatRow.endToEndTps, 34.5);
  assert.equal(compatRow.e2eSortValue, burstSpd.rawSpeed);
  assert.equal(burstSpd.streamingDetail.calculable, true);
  assert.equal(burstSpd.streamingDetail.isShortStream, true);
  assert.equal(burstSpd.streamingDetail.reliability, 'short_sample');
  assert.equal(burstSpd.streamingDetail.rawStreamingSec, 0.1275);
  assert.equal(burstSpd.streamingDetail.speed, 6768.6);

  // 批量到达：E2E 可算 (200/4=50.0)，详情流式不可用
  const batchSpd = core.resolveRequestTableSpeed(batchRec);
  assert.equal(batchSpd.calculable, true);
  assert.equal(batchSpd.speed, 50.0);
  assert.equal(batchSpd.streamingDetail.calculable, false);
  assert.equal(batchSpd.streamingDetail.reliability, 'unavailable');
  assert.equal(batchSpd.streamingDetail.reasonCode, 'batch_arrival_non_streaming');

  // 未关联计时：绝不拿流式峰值 3000 兜底
  const unlinkedSpd = core.resolveRequestTableSpeed(unlinkedRec);
  assert.equal(unlinkedSpd.calculable, false);
  assert.equal(unlinkedSpd.sortValue, null);
  assert.equal(unlinkedSpd.reasonCode, 'unlinked_timing');

  // 排序：进行中置顶 -> 有效 E2E 降序 (batch 50.0 == normal 50.0 按时间新优先 -> burst 34.5) -> 无效样本排后
  const sorted = [burstRec, noOutRec, unlinkedRec, normalRec, liveRec, batchRec]
    .sort(core.compareRequestRowsByE2eSpeed);
  assert.deepEqual(sorted.map(r => r.callId), [
    'req-live',
    'req-batch',
    'req-normal',
    'req-burst',
    'req-noout',
    'req-unlinked'
  ]);

  // 未舍入精度排序区分：100 / 2.99 = 33.4448 > 100 / 3.00 = 33.3333 (二者四舍五入前不同)
  const rA = { callId: 'a', outputTokens: 100, rawDurationSec: 2.99, status: 'final', timestamp: 100 };
  const rB = { callId: 'b', outputTokens: 100, rawDurationSec: 3.00, status: 'final', timestamp: 200 };
  assert.deepEqual([rB, rA].sort(core.compareRequestRowsByE2eSpeed).map(x => x.callId), ['a', 'b']);

  // #114/#130 会话统计平均/峰值/最近同口径
  const sessSpd = core.summarizeSessionSpeed([
    { callId: 's1', status: 'final', outputTokens: 100, streamingSec: 1.0, durationSec: 5.0, timestamp: 1000 },
    { callId: 's2', status: 'final', outputTokens: 300, streamingSec: 2.0, durationSec: 10.0, timestamp: 2000 }
  ]);
  const streamMode = core.resolveSessionSpeedByMode(sessSpd, 'streaming');
  const e2eMode = core.resolveSessionSpeedByMode(sessSpd, 'e2e');
  assert.equal(streamMode.avg, 133.3);
  assert.equal(streamMode.peak, 150);
  assert.equal(streamMode.recent, 150);
  assert.equal(e2eMode.avg, 26.7);
  assert.equal(e2eMode.peak, 30);
  assert.equal(e2eMode.recent, 30);
});

// =========================================================================
// 3. 02 配额看板逻辑：5H/7D 大写映射、浅色四行压深、10% vs 10.1%、重置去未知、#83 滚动保护
// =========================================================================
test('02 配额看板：5H/7D 大写徽标(保 windowKey 协议)、去同池共用与色号胶囊、浅色压深、10.1% 边界与重置去未知', () => {
  assert.equal(core.formatQuotaWindowDisplayTag('5h'), '5H');
  assert.equal(core.formatQuotaWindowDisplayTag('7d'), '7D');
  assert.equal(core.formatQuotaWindowDisplayTag('weekly'), '7D');
  assert.equal(core.formatQuotaWindowDisplayTag('24h'), '24H');

  const qbSrc = fs.readFileSync(path.join(__dirname, 'src/renderer/quota-board.js'), 'utf8');
  const ctx = {
    currentPanelLanguage: 'zh-CN',
    t: (k) => k,
    formatCountdownMsCompact: () => '36分',
    formatQuotaWindowTitle: () => '5H',
    __AGContextMeterCore: core,
    document: { createElement: () => ({}), createElementNS: () => ({}) }
  };
  vm.createContext(ctx);
  vm.runInContext(`${qbSrc}\nthis.__exports = { POOL_PALETTES, buildQuotaBoardItemsFromView, resolveDecileSpec, resolveCellColor, qbFormatBoundaryAwarePercent, qbFormatWindowDisplayTag };`, ctx);
  const qb = ctx.__exports;

  // 5H/7D 展示映射 & windowKey 协议保留
  assert.equal(qb.POOL_PALETTES['gemini-7d'].shortName, 'Gemini 7D');
  assert.equal(qb.POOL_PALETTES['gemini-5h'].shortName, 'Gemini 5H');
  assert.equal(qb.POOL_PALETTES['shared-7d'].shortName, 'Claude / GPT 7D');
  assert.equal(qb.POOL_PALETTES['shared-5h'].shortName, 'Claude / GPT 5H');

  const nowMs = 1795679200000;
  const view = {
    currentModel: { poolKey: 'shared_gemini_main' },
    pools: [
      {
        poolKey: 'shared_gemini_main',
        title: 'Gemini Models',
        models: [{ productLabel: 'Gemini 4 Neon' }, { productLabel: 'Gemini 4 Hydrogen' }],
        buckets: [
          { bucketId: 'gemini-weekly', windowKey: 'weekly', windowShort: '7d', remainingFraction: 0.35, hasResetTime: true, resetAtMs: nowMs + 100 * 3600000, resetTimeText: '未知' },
          { bucketId: 'gemini-5h', windowKey: '5h', windowShort: '5h', remainingFraction: 0.101, percentText: '10%', hasResetTime: true, resetAtMs: nowMs + 36 * 60000, resetTimeText: '' }
        ]
      },
      {
        poolKey: 'shared_3p_pool',
        title: 'Claude / GPT',
        models: [{ productLabel: 'Claude Opus 5.5' }, { productLabel: 'GPT-OSS 120B' }],
        buckets: [
          { bucketId: '3p-weekly', windowKey: 'weekly', windowShort: '7d', remainingFraction: 0.40 },
          { bucketId: '3p-5h', windowKey: '5h', windowShort: '5h', remainingFraction: 0.10, percentText: '10%' }
        ]
      }
    ]
  };
  const { items } = qb.buildQuotaBoardItemsFromView(view, nowMs);
  const g7 = items.find(i => i.id === 'gemini-7d');
  const g5 = items.find(i => i.id === 'gemini-5h');
  const s5 = items.find(i => i.id === 'shared-5h');

  // 徽标大写 5H/7D、内部 windowKey 保持原协议、无同池共用
  assert.equal(g7.badges[0].label, '7D');
  assert.equal(g7.windowKey, 'weekly');
  assert.equal(g5.badges[0].label, '5H');
  assert.equal(g5.windowKey, '5h');
  for (const it of items) {
    assert.equal(it.badges.some(b => /同池共用|Shared/i.test(b.label)), false);
  }
  // 重置摘要省略「未知」与多余分隔符
  assert.equal(g7.timeSummary.includes('未知'), false);
  assert.equal(g5.timeSummary, '36分');
  // 10.1% 不红警且显示 10.1%，10% 触发红警
  assert.equal(g5.percentText, '10.1%');
  assert.equal(qb.resolveDecileSpec('gemini-5h', 10.1, { surface: 'light' }).isRedAlert, false);
  assert.equal(qb.resolveDecileSpec('shared-5h', 10.0, { surface: 'light' }).isRedAlert, true);
  // 浅色统一压深：uniform 与 progressive 均比同档深色更深
  const darkHex = qb.resolveDecileSpec('gemini-7d', 35, { surface: 'dark' }).hex;
  const lightHex = qb.resolveDecileSpec('gemini-7d', 35, { surface: 'light' }).hex;
  assert.notEqual(darkHex, lightHex);
  const darkProg0 = qb.resolveCellColor('shared-7d', 0, 40, 'progressive', { surface: 'dark' });
  const lightProg0 = qb.resolveCellColor('shared-7d', 0, 40, 'progressive', { surface: 'light' });
  assert.notEqual(darkProg0, lightProg0);
  // 确认源码无 decileStatus 开发胶囊残留
  assert.equal(qbSrc.includes('decileStatus'), false);
});

test('02 PR #83 滚动保护：内外多层容器、后台重绘锚定、滚底跨多轮与用户意图立即打断', () => {
  let fakeNow = 1000;
  const scheduled = [];
  const makeNode = (sh, ch, st) => {
    const listeners = {};
    return {
      scrollHeight: sh,
      clientHeight: ch,
      scrollTop: st,
      addEventListener(evt, fn) { (listeners[evt] ||= []).push(fn); },
      emit(evt, payload = {}) { for (const fn of (listeners[evt] || [])) fn(payload); }
    };
  };
  const inner = makeNode(1200, 400, 800); // 滚底
  const outer = makeNode(1000, 500, 260);
  let visible = true;

  const guard = scrollGuard.createQuotaScrollGuard({
    resolveContainers: () => [{ id: 'view-quota', node: inner }, { id: 'host-outer', node: outer }],
    isPanelVisible: () => visible,
    now: () => fakeNow,
    setTimeout: (fn, ms) => { const id = scheduled.length + 1; scheduled.push({ id, fn, ms, cleared: false }); return id; },
    clearTimeout: (id) => { const it = scheduled.find(x => x.id === id); if (it) it.cleared = true; }
  });

  const snap = guard.captureSnapshot();
  // 模拟后台刷新导致 DOM 重绘把 scrollTop 清零且内容变长 (1200 -> 1400)
  inner.scrollHeight = 1400;
  inner.scrollTop = 0;
  outer.scrollTop = 0;
  fakeNow += 500;
  guard.armRestoreAfterRedraw(snap, 'quota_snapshot');
  assert.equal(inner.scrollTop, 1000, '滚底锚定应跟随新内容高度贴底 (1400 - 400)');
  assert.equal(outer.scrollTop, 260, '外层滚动容器应恢复原锚点');

  // 用户手动滚轮打断 -> 取消所有未触发定时器且不抢回滚动
  fakeNow += 50;
  outer.scrollTop = 90;
  outer.emit('wheel');
  assert.equal(guard.getState().activeTimerCount, 0);
  const skipped = guard.applyRestoreOnce(snap, 'late_bg_redraw');
  assert.equal(skipped.applied, false);
  assert.equal(skipped.skippedReason, 'user_intent_active');
  assert.equal(outer.scrollTop, 90);
});

// =========================================================================
// 4. 02 宿主快照边界降级、429 退避、单账号刷新去重/无变化/hostOnlyBoundary
// =========================================================================
test('02 服务边界：自动来源 force 降级本地读数、429 退避保留旧读数且不发请求、单账号刷新合并在途与无变化反馈', async () => {
  collector.resetQuotaHostCacheForTest();
  let forceCalls = 0;
  let localCalls = 0;
  const mockApi = {
    call: async (method, body) => {
      if (method === 'GetUserStatus') {
        return {
          userStatus: {
            email: 'tester@example.com',
            userTier: { id: 'g1-pro-tier', name: 'Google AI Pro' },
            cascadeModelConfigData: { clientModelConfigs: [] }
          }
        };
      }
      if (method === 'RetrieveUserQuotaSummary') {
        if (body && body.forceRefresh === true) forceCalls += 1;
        else localCalls += 1;
        return {
          response: {
            groups: [
              {
                displayName: 'Gemini Models',
                buckets: [
                  { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.77, resetTime: '2026-11-27T11:21:56Z' },
                  { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.88, resetTime: '2026-12-03T07:47:09Z' }
                ]
              }
            ]
          }
        };
      }
      return {};
    }
  };

  // 自动来源(如 auto_poll / turn_end / window_focus / menu_open) 即使传 force: true 也必须降级为本地快照读取
  const autoRes = await collector.fetchQuotaSnapshotFromHost({
    force: true,
    source: 'turn_end',
    origin: 'https://127.0.0.1:59991',
    connect: async () => mockApi,
    nowMs: 100000
  });
  assert.equal(autoRes.ok, true);
  assert.equal(autoRes.remoteForceDowngraded, true);
  assert.equal(forceCalls, 0);
  assert.equal(localCalls, 1);

  // 429 限流 -> 触发退避、保留旧快照与原 lastSuccessAtMs，退避期内二次请求零 RPC
  let rpc429Count = 0;
  const api429 = {
    call: async () => {
      rpc429Count += 1;
      const err = new Error('HTTP 429 RESOURCE_EXHAUSTED');
      err.httpStatus = 429;
      err.retryAfterMs = 45000;
      throw err;
    }
  };
  const errRes = await collector.fetchQuotaSnapshotFromHost({
    force: true,
    manual: true,
    source: 'panel_manual_refresh',
    origin: 'https://127.0.0.1:59991',
    connect: async () => api429,
    nowMs: 120000
  });
  assert.equal(errRes.ok, false);
  assert.equal(errRes.errorKind, 'rate_limit');
  assert.equal(errRes.backoffActive, true);
  assert.equal(errRes.lastSuccessAtMs, 100000, '失败必须保留原采样时间');
  assert.equal(errRes.snapshot.pools[0].buckets[0].remainingFraction, 0.77, '失败必须保留上次可信快照');

  const countBeforeBackoff = rpc429Count;
  const blockedRes = await collector.fetchQuotaSnapshotFromHost({
    force: true,
    manual: true,
    source: 'panel_manual_refresh',
    origin: 'https://127.0.0.1:59991',
    connect: async () => api429,
    nowMs: 130000
  });
  assert.equal(blockedRes.ok, false);
  assert.equal(blockedRes.backoffActive, true);
  assert.equal(blockedRes.dataFreshness, 'backoff_cached');
  assert.equal(rpc429Count, countBeforeBackoff, '退避窗口内零额外 RPC');

  // 单账号刷新：hostOnlyBoundary 下活跃账号走宿主快照、合并并发点击、无变化返回 unchanged、非活跃账号拒绝私有 CloudCode 探针
  const tmpDir = makeTempDir('ag-acct-');
  try {
    let hostFetchHits = 0;
    const mgr = accounts.createAccountsManager({
      stateDir: tmpDir,
      hostOnlyBoundary: true,
      fetchActiveHostSnapshot: async ({ nowMs }) => {
        hostFetchHits += 1;
        await new Promise(r => setTimeout(r, 20));
        return makeHostQuotaPayload({ email: 'active@example.com', g5h: 0.75, g7d: 0.80, fetchedAtMs: nowMs });
      }
    });
    const st = mgr.loadStore();
    st.accounts['active@example.com'] = { email: 'active@example.com', name: 'Active', credential: {}, lastQuotaUpdatedAtMs: 5000 };
    st.accounts['other@example.com'] = { email: 'other@example.com', name: 'Other', credential: { refreshToken: 'rt' }, lastQuotaUpdatedAtMs: 4000 };
    st.activeAccountEmail = 'active@example.com';
    mgr.saveStore(st);

    // 并发两次点击合并为 1 次宿主快照读取
    const [r1, r2] = await Promise.all([
      mgr.refreshAccountQuota('active@example.com', { nowMs: 20000 }),
      mgr.refreshAccountQuota('active@example.com', { nowMs: 20001 })
    ]);
    assert.equal(hostFetchHits, 1, '同账号并发刷新必须合并在途请求');
    assert.equal(r1.ok, true);
    assert.equal(r1.status, 'updated');
    assert.equal(r2.ok, true);

    // 再次刷新数值未变 -> status='unchanged', unchanged=true
    const r3 = await mgr.refreshAccountQuota('active@example.com', { nowMs: 30000 });
    assert.equal(r3.ok, true);
    assert.equal(r3.status, 'unchanged');
    assert.equal(r3.unchanged, true);
    assert.equal(mgr.getAccountRefreshStatus('active@example.com').state, 'unchanged');

    // 回归 #1：撤销 cloudcode_direct_disabled 拦截，非活跃账号单行刷新不再返回 unsupported，无 OAuth 凭据时返回明确错误并保留旧采样时间
    const rOther = await mgr.refreshAccountQuota('other@example.com', { nowMs: 31000 });
    assert.equal(rOther.ok, false);
    assert.notEqual(rOther.reason, 'cloudcode_direct_disabled');
    assert.equal(rOther.lastSuccessAtMs, 4000);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// =========================================================================
// 5. 07 账本(#60/#77)、压缩终态与去重(#34)、子智能体独立容量、Neon Medium、图三对账、Orchestrator
// =========================================================================
test('07 子智能体独立模型容量分母：不再借用主窗口 sessionBudgetHint，未知容量保留已用且占比为 null', () => {
  const calls = [
    {
      callId: 'main-1',
      cascadeId: 'cid-main',
      agentRole: 'main',
      model: 'gemini-4-neon-high',
      modelLabel: 'Gemini 4 Neon (High)',
      inputTokens: 10000,
      cacheReadTokens: 90000,
      outputTokens: 1000,
      totalTokens: 101000,
      contextWindowTokens: 100000,
      durationSec: 5,
      streamingSec: 4,
      status: 'final',
      timestamp: 1000
    },
    {
      callId: 'sub-known-1',
      cascadeId: 'cid-sub-known',
      parentCascadeId: 'cid-main',
      parentStepIndex: 1,
      agentRole: 'subagent',
      subagentRole: 'explorer',
      attributionConfidence: 'verified_tool_output',
      model: 'claude-sonnet-5-5-medium',
      modelExactId: 'claude-sonnet-5-5-medium',
      modelLabel: 'Claude Sonnet 5.5 (Medium)',
      inputTokens: 10000,
      cacheReadTokens: 40000,
      outputTokens: 500,
      totalTokens: 50500,
      contextWindowTokens: 50000,
      durationSec: 2,
      streamingSec: 1.5,
      status: 'final',
      timestamp: 2000
    },
    {
      callId: 'sub-unknown-1',
      cascadeId: 'cid-sub-unknown',
      parentCascadeId: 'cid-main',
      parentStepIndex: 2,
      agentRole: 'subagent',
      subagentRole: 'helper',
      attributionConfidence: 'verified_tool_output',
      model: 'custom-unmapped-model',
      modelExactId: 'custom-unmapped-model',
      inputTokens: 5000,
      cacheReadTokens: 15000,
      outputTokens: 200,
      totalTokens: 20200,
      contextWindowTokens: 20000,
      durationSec: 2,
      streamingSec: 1,
      status: 'final',
      timestamp: 3000
    }
  ];

  const grouped = core.groupSessionCallsByTurns(
    [{ stepIndex: 0, timestamp: 900, preview: 'turn 1' }],
    calls,
    {
      cascadeId: 'cid-main',
      budgetTokens: 512000, // 主窗口 512K
      cascadeModelConfigs: [
        { modelId: 'gemini-4-neon-high', maxTokens: 512000 },
        { modelId: 'claude-sonnet-5-5-medium', maxTokens: 200000 } // 子智能体自身 200K 容量
      ]
    }
  );

  const mainAg = grouped.agentFleetSummary.mainAgent;
  const subKnown = grouped.agentFleetSummary.subagents.find(s => s.childCid === 'cid-sub-known');
  const subUnknown = grouped.agentFleetSummary.subagents.find(s => s.childCid === 'cid-sub-unknown');

  assert.equal(mainAg.contextBudgetTokens, 512000);
  assert.equal(mainAg.contextPct, 19.5);
  assert.equal(subKnown.contextBudgetTokens, 200000, '子智能体必须使用自身模型 200K 容量，绝不借用主窗口 512K');
  assert.equal(subKnown.contextPct, 25.0);
  assert.equal(subKnown.contextBudgetSource, 'model_capability');
  assert.equal(subKnown.cacheHitPct, 80.0);
  assert.ok(subKnown.avgStreamTps > 0);
  assert.equal(subUnknown.contextUsedTokens, 20000, '容量未知时保留可证已用上下文');
  assert.equal(subUnknown.contextBudgetTokens, null, '容量未知的子智能体严禁借用主窗口 sessionBudgetHint');
  assert.equal(subUnknown.contextPct, null);
  assert.equal(subUnknown.contextBudgetSource, 'unknown');
});

test('07 压缩终态单调保护、已完成去重计数(#34)、Neon Medium M533 归属、图三对账与 Orchestrator 真实性', () => {
  // 1. 压缩终态保护：completed 绝不被迟到 cancelled / failed / working 覆写
  const settled = core.reconcileCompactionTerminalState(
    { taskKey: 'cp-1', phase: 'compacting', beforeTokens: 216800, startedAtMs: 1000 },
    { taskKey: 'cp-1', phase: 'completed', afterTokens: 61500, checkpointIndexBefore: 458, checkpointIndexAfter: 597 },
    5000
  );
  assert.equal(settled.ignored, false);
  assert.equal(settled.record.phase, 'completed');
  assert.equal(settled.record.releasedTokens, 155300);

  const lateCancel = core.reconcileCompactionTerminalState(settled.record, { taskKey: 'cp-1', phase: 'cancelled' }, 6000);
  assert.equal(lateCancel.ignored, true);
  assert.equal(lateCancel.record.phase, 'completed');

  // 2. #34 已完成压缩去重计数
  const cpSum = core.summarizeSessionCompactions({
    records: [
      { taskKey: 't1', phase: 'completed', checkpointIndexAfter: 597 },
      { taskKey: 't1-dup', phase: 'completed', checkpointIndexAfter: 597 },
      { taskKey: 't2', phase: 'cancelled', checkpointIndexAfter: null },
      { taskKey: 't3', phase: 'failed', checkpointIndexAfter: null }
    ],
    checkpoints: [
      { checkpointIndex: 597, completed: true },
      { checkpointIndex: 610, completed: false },
      { checkpointIndex: 620, completed: true }
    ],
    hasFullHistory: false
  });
  assert.equal(cpSum.completedCount, 2);
  assert.equal(cpSum.cancelledCount, 1);
  assert.equal(cpSum.failedCount, 1);
  assert.equal(cpSum.coverage, 'partial');

  // 3. Neon Medium M533 归属 + 末尾无标签子调用不挤掉主模型
  const neonAttr = core.resolveTurnFooterModelAttribution([
    { model: 'MODEL_PLACEHOLDER_M533', inputTokens: 1000000, cacheReadTokens: 1900000, outputTokens: 16600, totalTokens: 2916600 },
    { model: '', outputTokens: 10, totalTokens: 100 }
  ], { isTurnAggregate: true });
  assert.equal(neonAttr.label, 'Gemini 4 Neon (Medium)');
  assert.match(neonAttr.unknownReason, /1 条辅助子调用缺模型字段/);
  assert.equal(/[()（）]/.test(neonAttr.unknownReason), false);

  // 4. 图三本机用量对账：均值费用仅用已定价数作分母、模型成功率仅用确定结局作分母
  const rec = core.buildUsageOverviewReconciliation([
    { callId: 'u1', date: '2026-11-26', source: 'desktop', accountScopeKey: 'acct_a', modelLabel: 'Gemini 4 Neon', inputTokens: 100, cacheReadTokens: 900, outputTokens: 200, isPriced: true, costUSD: 0.2, status: 'final', outcomeStatus: 'success' },
    { callId: 'u2', date: '2026-11-26', source: 'desktop', accountScopeKey: 'acct_a', modelLabel: 'Gemini 4 Neon', inputTokens: 100, cacheReadTokens: 0, outputTokens: 50, isPriced: false, status: 'final', outcomeStatus: 'failed', error: 'err' },
    { callId: 'u3', date: '2026-11-26', source: 'desktop', accountScopeKey: 'acct_a', modelLabel: 'Gemini 4 Neon', inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, isPriced: false, status: 'final', outcomeStatus: 'canceled' },
    { callId: 'u4', date: '2026-11-26', source: 'desktop', accountScopeKey: 'acct_b', modelLabel: 'Claude Opus 5.5', inputTokens: 500, cacheReadTokens: 500, outputTokens: 100, isPriced: true, costUSD: 0.5, status: 'final', outcomeStatus: 'success' }
  ], { startDate: '2026-11-26', endDate: '2026-11-26', accountScopeKey: 'acct_a' });
  assert.equal(rec.requests.total, 3);
  assert.equal(rec.requests.success, 1);
  assert.equal(rec.requests.error, 1);
  assert.equal(rec.requests.canceled, 1);
  assert.equal(rec.cost.pricedCount, 1);
  assert.equal(rec.cost.avgCostUSD, 0.2, '单次均价分母仅计已定价请求(1条)，绝不除以总请求(3条)');
  assert.equal(rec.modelTimeline['Gemini 4 Neon'].decidedCount, 2);
  assert.equal(rec.modelTimeline['Gemini 4 Neon'].successRatePct, 50);

  // 5. Orchestrator 真实性：仅有配置无运行时角色事件 -> configured_only，严禁凭 Hydrogen/顺序编造交接
  const cfgOnly = core.extractOrchestratorTelemetry({
    cascadeModelConfigs: [{ modelId: 'gemini-pro-orchestrator-neon', label: 'Orchestrator (Neon)' }],
    sessionCalls: [{ callId: 'c1', model: 'gemini-4-hydrogen-high', totalTokens: 5000 }]
  });
  assert.equal(cfgOnly.status, 'configured_only');
  assert.equal(cfgOnly.runtimeRecorded, false);
  assert.equal(cfgOnly.handoffs.length, 0);

  // 有可核验运行时角色与交接 -> recorded，含重叠检测与去重
  const realOrch = core.extractOrchestratorTelemetry({
    cascadeModelConfigs: [{ modelId: 'gemini-pro-orchestrator-neon', label: 'Orchestrator (Neon)', plannerModel: 'Neon', executorModel: 'Flash' }],
    sessionCalls: [
      { callId: 'p1', orchestratorRole: 'planner', modelLabel: 'Gemini 4 Neon', totalTokens: 3000, durationSec: 4, startedAtMs: 1000, completedAtMs: 5000 },
      { callId: 'p1', orchestratorRole: 'planner', modelLabel: 'Gemini 4 Neon', totalTokens: 3000, durationSec: 4, startedAtMs: 1000, completedAtMs: 5000 },
      { callId: 'e1', orchestratorRole: 'executor', modelLabel: 'Gemini 3.8 Flash', totalTokens: 2000, durationSec: 3, startedAtMs: 4000, completedAtMs: 7000 }
    ],
    trajectoryEvents: [
      { eventId: 'h1', fromRole: 'planner', toRole: 'executor', actionLabel: '交由执行跑测试', stepIndex: 2, timestamp: 4000 },
      { eventId: 'h1', fromRole: 'planner', toRole: 'executor', actionLabel: '交由执行跑测试', stepIndex: 2, timestamp: 4000 }
    ]
  });
  assert.equal(realOrch.status, 'recorded');
  assert.equal(realOrch.roles.planner.callCount, 1, '同 callId 不重复入账');
  assert.equal(realOrch.roles.executor.callCount, 1);
  assert.equal(realOrch.hasRoleOverlap, true);
  assert.equal(realOrch.handoffs.length, 1);
  assert.equal(realOrch.events.length, 1);
  assert.equal(realOrch.events[0].type, 'handoff');
  assert.equal(realOrch.events[0].from, 'planner');
  assert.equal(realOrch.events[0].to, 'executor');
  assert.equal(realOrch.plannerBusy, false);
  assert.equal(realOrch.executorBusy, false);
});

test('07 账本 #60 备份幂等与 #77 当日删历史后继续累计', async () => {
  const tmpDir = makeTempDir('ag-ledger-60-77-');
  try {
    const ledgerPath = path.join(tmpDir, 'pricing_ledger_v1.json');
    const brainA = path.join(tmpDir, 'brain', 'sess-a');
    const brainB = path.join(tmpDir, 'brain', 'sess-b');
    fs.mkdirSync(brainA, { recursive: true });
    fs.mkdirSync(brainB, { recursive: true });
    const today = collector.formatLocalDateKey(new Date());
    const isoNow = `${today}T02:00:00.000Z`;

    // #77: 先写会话 A 的 transcript，跑一次采集入账并归档
    fs.writeFileSync(path.join(brainA, 'transcript.jsonl'), JSON.stringify({
      created_at: isoNow,
      chatModel: {
        model: 'gemini-4-neon-high',
        usage: { inputTokens: 1000, cacheReadTokens: 2000, outputTokens: 500, responseId: 'resp-a-1' }
      }
    }) + '\n');
    const run1 = await collector.collectTokenHistoryAsync({ agDir: tmpDir, agCliDir: path.join(tmpDir, 'cli'), force: true });
    assert.equal(run1.dailyMap[today].total, 3500);

    // 当日删除会话 A 的 transcript，再新增会话 B -> 总量必须继续累计为 3500 + 2500 = 6000，绝不吞掉新增
    fs.rmSync(brainA, { recursive: true, force: true });
    fs.writeFileSync(path.join(brainB, 'transcript.jsonl'), JSON.stringify({
      created_at: `${today}T03:00:00.000Z`,
      chatModel: {
        model: 'gemini-4-neon-high',
        usage: { inputTokens: 1500, cacheReadTokens: 500, outputTokens: 500, responseId: 'resp-b-1' }
      }
    }) + '\n');
    const run2 = await collector.collectTokenHistoryAsync({ agDir: tmpDir, agCliDir: path.join(tmpDir, 'cli'), force: true });
    assert.equal(run2.dailyMap[today].total, 6000, '当日删除旧会话历史后新增用量必须继续累计');

    // #60: 连续两次执行账本修复迁移 -> 第二次 changed=false 且不新增多余 .bak 备份
    const rep1 = collector.repairAndMigrateAccountLedger({ ledgerPath, agDir: tmpDir, accountSessions: [] });
    assert.equal(rep1.ok, true);
    const baksAfter1 = collector.listLedgerRepairBackups(ledgerPath);
    const rep2 = collector.repairAndMigrateAccountLedger({ ledgerPath, agDir: tmpDir, accountSessions: [] });
    assert.equal(rep2.ok, true);
    assert.equal(rep2.changed, false, '重复修复必须幂等');
    const baksAfter2 = collector.listLedgerRepairBackups(ledgerPath);
    assert.equal(baksAfter2.length, baksAfter1.length, '幂等重复修复绝不生成额外 .bak 备份');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// =========================================================================
// PR #132 / #130 / #134 回归：CLI 报告总量对齐、速度口径设置持久化、SSH 远端回退与跨端口 Token 隔离
// =========================================================================
test('PR #132: CLI 会话详情对齐 agy 报告总量 (18,250 报告 / 13,299 缓存 / 31,549 处理量)', () => {
  const cid = 'cli-pr132-0000-0000-0000-000000000001';
  const calls = [
    {
      callId: 'cli-c1',
      cascadeId: cid,
      source: 'cli',
      stepIndex: 1,
      inputTokens: 10000,
      outputTokens: 2250,
      cacheReadTokens: 8000,
      totalTokens: 20250,
      model: 'Gemini 3.8 Flash',
      timestamp: 1000
    },
    {
      callId: 'cli-c2',
      cascadeId: cid,
      source: 'cli',
      stepIndex: 2,
      inputTokens: 5000,
      outputTokens: 1000,
      cacheReadTokens: 5299,
      totalTokens: 11299,
      model: 'Gemini 3.8 Flash',
      timestamp: 2000
    }
  ];
  const groupedCli = core.groupSessionCallsByTurns([], calls, { cascadeId: cid, sessionSource: 'cli' });
  assert.ok(groupedCli.cliReportedUsage, 'CLI 会话必须输出 cliReportedUsage');
  assert.equal(groupedCli.cliReportedUsage.totalTokens, 18250, 'CLI 报告总量 = input + output = 18,250');
  assert.equal(groupedCli.cliReportedUsage.cacheReadTokens, 13299, '缓存读取总量 = 13,299');
  assert.equal(groupedCli.sessionTokenTotals.totalTokens, 31549, '总处理量 = 18,250 + 13,299 = 31,549');

  const groupedDesktop = core.groupSessionCallsByTurns([], calls.map(c => ({ ...c, source: 'desktop' })), {
    cascadeId: cid,
    sessionSource: 'desktop'
  });
  assert.equal(groupedDesktop.cliReportedUsage, undefined, '非 CLI 会话不得输出 cliReportedUsage');
});

test('PR #130: speedDisplayMode 持久化兼容 stream / streaming / e2e', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-pr130-speed-'));
  try {
    const r1 = collector.savePluginSettings({ speedDisplayMode: 'e2e' }, tmpDir);
    assert.equal(r1.ok, true);
    assert.equal(collector.getPluginSettings(tmpDir).speedDisplayMode, 'e2e');

    const r2 = collector.savePluginSettings({ speedDisplayMode: 'stream' }, tmpDir);
    assert.equal(r2.ok, true);
    assert.equal(collector.getPluginSettings(tmpDir).speedDisplayMode, 'stream');

    const r3 = collector.savePluginSettings({ speedDisplayMode: 'streaming' }, tmpDir);
    assert.equal(r3.ok, true);
    assert.equal(collector.getPluginSettings(tmpDir).speedDisplayMode, 'streaming');

    // 非法值被忽略，不破坏既有有效设置
    collector.savePluginSettings({ uiPreferences: { speedDisplayMode: 'invalid_mode' } }, tmpDir);
    assert.equal(collector.getPluginSettings(tmpDir).speedDisplayMode, 'streaming');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('PR #134: SSH 远端窗口额度回退至本机宿主 LS 且严禁跨端口透传 csrfToken', async () => {
  const seenConnectCalls = [];
  const res = await collector.fetchQuotaSnapshotFromHost({
    origin: 'https://127.0.0.1:49901',
    csrfToken: 'remote-ssh-secret-token',
    allowHostOriginFallback: true,
    fallbackOrigins: ['https://127.0.0.1:49902'],
    force: true,
    agDir: os.tmpdir(),
    connect: async (opts) => {
      seenConnectCalls.push({ origin: opts?.origin, csrfToken: opts?.csrfToken || null });
      if (opts?.origin === 'https://127.0.0.1:49901') {
        throw new Error('remote SSH LS does not host quota service');
      }
      return {
        call: async (method) => {
          if (method === 'GetUserStatus') {
            return {
              userStatus: {
                email: 'ssh-user@example.com',
                cascadeModelConfigData: {
                  clientModelConfigs: [{ label: 'Gemini 3.8 Flash', modelOrAlias: { model: 'gemini-3.8-flash' }, quotaInfo: { remainingFraction: 0.85 } }]
                }
              }
            };
          }
          return {
            response: {
              groups: [{ groupId: 'gemini-5h', remainingFraction: 0.85 }]
            }
          };
        }
      };
    }
  });
  assert.equal(res.ok, true, '回退至本机宿主 LS 后必须成功返回额度快照');
  assert.equal(seenConnectCalls.length, 2);
  assert.equal(seenConnectCalls[0].origin, 'https://127.0.0.1:49901');
  assert.equal(seenConnectCalls[0].csrfToken, 'remote-ssh-secret-token');
  assert.equal(seenConnectCalls[1].origin, 'https://127.0.0.1:49902');
  assert.equal(seenConnectCalls[1].csrfToken, null, '回退本机端口时严禁透传远端 csrfToken');
});

test('PR #134 Tier 2 + PR #132 端到端采集 + ELV-101 多实例备份上限 + Issue #141 代理配置保护 + 回归 #6 freeRect/48px 落盘', async () => {
  const tmpRoot = makeTempDir('ag-pr-data-closeout-');
  try {
    // 1. PR #134 Tier 2: 主连接失败时优先走同源 rendererRpcFetcher，命中即不回退 Tier 3
    let tier3Called = false;
    const tier2Res = await collector.fetchQuotaSnapshotFromHost({
      origin: 'https://127.0.0.1:49911',
      allowHostOriginFallback: true,
      fallbackOrigins: ['https://127.0.0.1:49912'],
      force: true,
      agDir: tmpRoot,
      connect: async (opts) => {
        if (opts?.origin === 'https://127.0.0.1:49912') tier3Called = true;
        throw new Error('direct connect blocked');
      },
      rendererRpcFetcher: async (orig) => {
        assert.equal(orig, 'https://127.0.0.1:49911');
        return {
          userStatusRes: {
            userStatus: {
              email: 'ssh-tier2@example.com',
              cascadeModelConfigData: {
                clientModelConfigs: [{ label: 'Gemini 4 Neon (High)', modelOrAlias: { model: 'gemini-4-neon-high' }, quotaInfo: { remainingFraction: 0.75 } }]
              }
            }
          },
          quotaSummaryRes: { response: { groups: [{ groupId: 'gemini-5h', remainingFraction: 0.75 }] } }
        };
      }
    });
    assert.equal(tier2Res.ok, true);
    assert.equal(tier3Called, false, 'Tier 2 同源渲染层成功时不应回退 Tier 3');

    // 2. PR #132: collectSessionTimelineAsync 真实 CLI transcript 样本 (18,250 报告 / 13,299 缓存 / 31,549 处理量)
    const agDir = path.join(tmpRoot, 'desktop');
    const agCliDir = path.join(tmpRoot, 'cli');
    const stateDir = path.join(tmpRoot, 'state');
    const cliCid = '11111111-1111-4111-8111-111111111112';
    const cliLogs = path.join(agCliDir, 'brain', cliCid, '.system_generated', 'logs');
    fs.mkdirSync(cliLogs, { recursive: true });
    fs.writeFileSync(path.join(cliLogs, 'transcript.jsonl'), [
      JSON.stringify({ type: 'PLANNER_RESPONSE', model: 'gemini-4-neon', created_at: '2026-11-01T08:00:00.000Z', step_index: 1, input_tokens: 15356, output_tokens: 268 }),
      JSON.stringify({ type: 'PLANNER_RESPONSE', model: 'gemini-4-neon', created_at: '2026-11-01T08:00:05.000Z', step_index: 2, input_tokens: 2464, output_tokens: 162, cache_read_tokens: 13299 })
    ].join('\n') + '\n');
    const cliTimeline = await collector.collectSessionTimelineAsync(cliCid, { agDir, agCliDir, stateDir, wslRoots: [] });
    assert.deepEqual(cliTimeline.cliReportedUsage, { inputTokens: 17820, outputTokens: 430, cacheReadTokens: 13299, totalTokens: 18250 });
    assert.equal(cliTimeline.sessionTokenTotals.totalTokens, 31549);

    // 3. ELV-101: 归属纠偏备份上限 (MAX_LEDGER_REPAIR_BACKUPS = 3) 与旧堆积备份升级清理 (keep=1)
    const bakDir = path.join(tmpRoot, 'elv101');
    fs.mkdirSync(bakDir, { recursive: true });
    const lPath = path.join(bakDir, 'pricing_ledger_v1.json');
    fs.writeFileSync(lPath, JSON.stringify({ version: '1.0.0', calls: {} }));
    for (let i = 1; i <= 7; i++) {
      fs.writeFileSync(`${lPath}.bak-pre-elv89-${1700000000000 + i}`, JSON.stringify({ seq: i }));
    }
    const prune3 = collector.pruneLedgerRepairBackups(lPath, { keep: collector.MAX_LEDGER_REPAIR_BACKUPS });
    assert.equal(prune3.keptCount, 3, '归属纠偏备份必须严格受限于 MAX_LEDGER_REPAIR_BACKUPS=3');
    assert.equal(prune3.removedCount, 4);
    const upClean = collector.cleanupUpgradeLedgerBackups({ ledgerPath: lPath, stateDir: bakDir, keep: 1, force: true });
    assert.equal(upClean.keptCount, 1, '升级清理后仅保留最新 1 份历史备份');
    assert.equal(collector.listLedgerRepairBackups(lPath).length, 1);

    // 4. Issue #141: modules.json 代理配置启用/持久化/冷重启读回 + meter-enhance 损坏配置 fail-closed 不覆盖代理配置
    const modStateDir = path.join(tmpRoot, 'proxy-state');
    fs.mkdirSync(modStateDir, { recursive: true });
    const { loadModulesConfig, saveModulesConfig } = require('./modules-config');
    const { detectProxyConfig } = require('./meter-proxy');
    const cfg = loadModulesConfig({ stateDir: modStateDir, allowLegacyMigration: false });
    cfg.modules.proxy.enabled = true;
    cfg.modules.proxy.proxyUrl = 'http://127.0.0.1:7897';
    saveModulesConfig(cfg, { stateDir: modStateDir });
    const readBack = detectProxyConfig({ candidates: [path.join(modStateDir, 'modules.json')] });
    assert.equal(readBack.enabled, true);
    assert.equal(readBack.httpProxy, 'http://127.0.0.1:7897');
    // 损坏 modules.json 时 meter-enhance 不得用默认值覆写原文件
    const modPath = path.join(modStateDir, 'modules.json');
    const corruptRaw = '{ broken json proxy config';
    fs.writeFileSync(modPath, corruptRaw, 'utf8');
    const enhanceMod = require('./meter-enhance');
    if (typeof enhanceMod.saveSavedEnhancePreference === 'function') {
      const savedOk = enhanceMod.saveSavedEnhancePreference({ promptTier: 4 }, { stateDir: modStateDir });
      assert.equal(savedOk, false);
    }
    assert.equal(fs.readFileSync(modPath, 'utf8'), corruptRaw, '配置文件损坏时必须 fail-closed 保留原文件，绝不覆盖');

    // 5. 回归 #6: sanitizeSessionCockpitLayout 放宽最小高度至 48px、透传 freeRect，且仅显式清空才置 emptyGroup
    const settingsDir = path.join(tmpRoot, 'cockpit-settings');
    fs.mkdirSync(settingsDir, { recursive: true });
    const saveCockpit = collector.savePluginSettings({
      sessionCockpitLayout: {
        presetId: 'cockpit',
        layoutMode: 'freestyle',
        modules: [], // 仅空数组无 emptyGroup/userClearedAll 时不应误判为空态
        widgets: [
          { id: 'overview-kpi', span: 4, visible: true, customHeightPx: 48, freeRect: { x: 0, y: 0, w: 96, h: 48, xRatio: 0, wRatio: 0.2, baseW: 480 } }
        ]
      }
    }, settingsDir);
    assert.equal(saveCockpit.ok, true);
    const loadedCockpit = collector.getPluginSettings(settingsDir).sessionCockpitLayout;
    assert.equal(loadedCockpit.layoutMode, 'freestyle');
    assert.equal(loadedCockpit.emptyGroup, undefined, '非显式删空不得误标 emptyGroup');
    const ovCard = loadedCockpit.widgets.find(w => w.id === 'overview-kpi');
    assert.equal(ovCard.customHeightPx, 48, '48px 极紧凑高度必须完整持久化读回');
    assert.deepEqual(ovCard.freeRect, { x: 0, y: 0, w: 96, h: 48, xRatio: 0, wRatio: 0.2, baseW: 480 });

    // 6. PR #138 (#117): barFontScale & footerContrast 持久化与旧键兼容映射
    collector.savePluginSettings({ barFontScale: 'large', footerContrast: 'high' }, settingsDir);
    const s117 = collector.getPluginSettings(settingsDir);
    assert.equal(s117.barFontScale, 'large');
    assert.equal(s117.footerContrast, 'high');
    collector.savePluginSettings({ composerStatusFontSize: 'small', turnFooterHighContrast: false }, settingsDir);
    const s117Legacy = collector.getPluginSettings(settingsDir);
    assert.equal(s117Legacy.barFontScale, 'compact');
    assert.equal(s117Legacy.footerContrast, 'standard');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
