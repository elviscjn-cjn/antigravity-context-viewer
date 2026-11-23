'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const core = require('./meter-core');
const collector = require('./meter-collector');
const cliMonitor = require('./meter-cli-monitor');
const cliUi = require('./meter-cli-ui');

function makeTempDir(prefix = 'acm-elv103-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('ELV-103 1: 中途换模型、Orchestrator 各变体与模型未知按实际执行模型独立分桶且与会话总量恒等', async () => {
  const cascadeId = '11111111-2222-4333-8444-555555555555';
  const turns = [
    { stepIndex: 0, timestamp: Date.parse('2026-11-20T10:00:00Z'), preview: 'Mixed models round 1' },
    { stepIndex: 10, timestamp: Date.parse('2026-11-20T10:05:00Z'), preview: 'Orchestrator & unknown round 2' }
  ];

  const calls = [
    // Turn 1: 中途换模型 (Hydrogen High -> 3.8 Flash -> Carbon Medium)
    {
      callId: 'rpc-h2-1',
      cascadeId,
      stepIndex: 1,
      model: 'Gemini 4 Hydrogen (High)',
      modelExactId: 'MODEL_PLACEHOLDER_M525',
      modelLabel: 'Gemini 4 Hydrogen (High)',
      inputTokens: 1000,
      cacheReadTokens: 4000,
      outputTokens: 200,
      created_at: '2026-11-20T10:00:05Z',
      timestamp: Date.parse('2026-11-20T10:00:05Z'),
      status: 'final'
    },
    {
      callId: 'rpc-flash-2',
      cascadeId,
      stepIndex: 3,
      model: 'gemini-3.8-flash-high',
      modelExactId: 'MODEL_PLACEHOLDER_M318',
      modelLabel: 'Gemini 3.8 Flash (High)',
      inputTokens: 500,
      cacheReadTokens: 2500,
      outputTokens: 150,
      created_at: '2026-11-20T10:01:05Z',
      timestamp: Date.parse('2026-11-20T10:01:05Z'),
      status: 'final'
    },
    {
      callId: 'rpc-c4-3',
      cascadeId,
      stepIndex: 5,
      model: 'Gemini 4 Carbon (Medium)',
      modelExactId: 'MODEL_PLACEHOLDER_M437',
      modelLabel: 'Gemini 4 Carbon (Medium)',
      inputTokens: 800,
      cacheReadTokens: 1200,
      outputTokens: 300,
      created_at: '2026-11-20T10:02:05Z',
      timestamp: Date.parse('2026-11-20T10:02:05Z'),
      status: 'final'
    },
    // Turn 2: Orchestrator (Carbon) + Orchestrator (Argon) + Orchestrator (Neon) + Worker + Unknown (checkpoint & unmapped placeholder)
    {
      callId: 'rpc-orch-carbon',
      cascadeId,
      stepIndex: 11,
      model: 'gemini-pro-orchestrator',
      modelExactId: 'MODEL_PLACEHOLDER_M667',
      modelLabel: 'Orchestrator (Carbon)',
      inputTokens: 2000,
      cacheReadTokens: 3000,
      outputTokens: 400,
      created_at: '2026-11-20T10:05:10Z',
      timestamp: Date.parse('2026-11-20T10:05:10Z'),
      status: 'final'
    },
    {
      callId: 'rpc-orch-argon',
      cascadeId,
      stepIndex: 12,
      model: 'MODEL_PLACEHOLDER_M668',
      inputTokens: 1200,
      cacheReadTokens: 1800,
      outputTokens: 250,
      created_at: '2026-11-20T10:05:25Z',
      timestamp: Date.parse('2026-11-20T10:05:25Z'),
      status: 'final'
    },
    {
      callId: 'rpc-orch-neon',
      cascadeId,
      stepIndex: 13,
      model: 'MODEL_PLACEHOLDER_M537',
      inputTokens: 600,
      cacheReadTokens: 1400,
      outputTokens: 100,
      created_at: '2026-11-20T10:05:40Z',
      timestamp: Date.parse('2026-11-20T10:05:40Z'),
      status: 'final'
    },
    {
      callId: 'rpc-worker-h2',
      cascadeId,
      stepIndex: 14,
      model: 'gemini-flash-worker-agy',
      inputTokens: 400,
      cacheReadTokens: 600,
      outputTokens: 80,
      created_at: '2026-11-20T10:05:55Z',
      timestamp: Date.parse('2026-11-20T10:05:55Z'),
      status: 'final'
    },
    {
      callId: `${cascadeId}#15`,
      cascadeId,
      stepIndex: 15,
      model: '',
      inputTokens: 900,
      cacheReadTokens: 3100,
      outputTokens: 220,
      created_at: '2026-11-20T10:06:10Z',
      timestamp: Date.parse('2026-11-20T10:06:10Z'),
      status: 'final'
    },
    {
      callId: 'rpc-unknown-placeholder',
      cascadeId,
      stepIndex: 16,
      model: 'MODEL_PLACEHOLDER_M998',
      inputTokens: 300,
      cacheReadTokens: 700,
      outputTokens: 90,
      created_at: '2026-11-20T10:06:25Z',
      timestamp: Date.parse('2026-11-20T10:06:25Z'),
      status: 'final'
    }
  ];

  const grouped = core.groupSessionCallsByTurns(turns, calls, { cascadeId });
  assert.equal(grouped.totalCalls, 9);
  assert.equal(grouped.sessionTokenTotals.isConsistent, true);
  assert.equal(grouped.sessionTokenTotals.callCount, 9);

  // Hydrogen 家族包含常规 High (5200) + Orchestrator worker (1080) = 6280, 变体各自可查
  const h2 = grouped.modelBreakdown.find(m => m.modelKey === 'gemini-4-hydrogen');
  assert.ok(h2);
  assert.equal(h2.callCount, 2);
  assert.equal(h2.totalTokens, 5200 + 1080);
  assert.equal(h2.variants.length, 2);
  assert.ok(h2.variants.some(v => v.variantLabel === 'Gemini 4 Hydrogen (Orchestrator)' && v.totalTokens === 1080));

  // Orchestrator Carbon / Argon / Neon 各自独立归属且不混用
  const oc = grouped.modelBreakdown.find(m => m.modelKey === 'orchestrator:carbon');
  const oa = grouped.modelBreakdown.find(m => m.modelKey === 'orchestrator:argon');
  const on = grouped.modelBreakdown.find(m => m.modelKey === 'orchestrator:neon');
  assert.equal(oc?.modelLabel, 'Orchestrator (Carbon)');
  assert.equal(oc?.totalTokens, 5400);
  assert.equal(oa?.modelLabel, 'Orchestrator (Argon)');
  assert.equal(oa?.totalTokens, 3250);
  assert.equal(on?.modelLabel, 'Orchestrator (Neon)');
  assert.equal(on?.totalTokens, 2100);

  // 模型未知（无模型字段 checkpoint 与未映射 placeholder）清晰保留并计入总量
  const unattr = grouped.modelBreakdown.find(m => m.modelKey === core.UNATTRIBUTED_MODEL_KEY);
  const unmappedPh = grouped.modelBreakdown.find(m => m.modelKey === 'unknown:model_placeholder_m998');
  assert.equal(unattr?.isUnknown, true);
  assert.equal(unattr?.modelLabel, '未知模型');
  assert.equal(unattr?.totalTokens, 4220);
  assert.equal(unmappedPh?.isUnknown, true);
  assert.equal(unmappedPh?.rawModelId, 'MODEL_PLACEHOLDER_M998');
  assert.equal(unmappedPh?.totalTokens, 1090);

  // 逐条明细求和 === 按模型汇总之和 === 会话总量
  const flatCalls = grouped.turns.flatMap(t => t.calls);
  const detailSum = flatCalls.reduce((s, c) => s + (c.totalTokens || 0), 0);
  const breakdownSum = grouped.modelBreakdown.reduce((s, m) => s + m.totalTokens, 0);
  assert.equal(detailSum, grouped.sessionTokenTotals.totalTokens);
  assert.equal(breakdownSum, grouped.sessionTokenTotals.totalTokens);

  // Orchestrator Carbon M667 计费识别为 gemini-4-carbon 而非 gemini-4-argon
  const costRes = core.calculateRequestApiCost({
    model: 'gemini-pro-orchestrator',
    modelExactId: 'MODEL_PLACEHOLDER_M667',
    modelLabel: 'Orchestrator (Carbon)',
    inputTokens: 2000,
    cacheReadTokens: 3000,
    outputTokens: 400,
    date: '2026-11-20'
  });
  assert.equal(costRes.modelKey, 'gemini-4-carbon');
});

test('ELV-103 2: 跨源重复 (bot-*/RPC/#step + Orchestrator M667 双记) 严格消重、同 step 真重试不误合并且三端统一', async () => {
  const tmpDir = makeTempDir('acm-elv103-xsrc-');
  const agDir = path.join(tmpDir, 'antigravity');
  const agCliDir = path.join(tmpDir, 'antigravity-cli');
  const stateDir = path.join(tmpDir, 'state');
  const mainCid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const subCid = 'ffffffff-1111-4222-8333-444444444444';

  try {
    fs.mkdirSync(path.join(agDir, 'brain', mainCid, '.system_generated', 'logs'), { recursive: true });
    fs.mkdirSync(path.join(agDir, 'brain', subCid, '.system_generated', 'logs'), { recursive: true });
    fs.mkdirSync(path.join(agDir, 'conversations'), { recursive: true });
    fs.mkdirSync(agCliDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });

    // 主会话 SQLite 数据库仅存部分 step 的 responseId (例如 step 823 存了最新一条的 responseId)
    const dbMain = new DatabaseSync(path.join(agDir, 'conversations', `${mainCid}.db`));
    dbMain.exec('CREATE TABLE gen_metadata (id INTEGER PRIMARY KEY, data BLOB)');
    dbMain.close();

    // 构造主会话 transcript：
    // step 0: 用户消息
    // step 1: Hydrogen 调用 1 (1000/2000/300 = 3300) -> 将与 ledger 中 RPC ID (rpc-step-1) 合并
    // step 2: NON-model 工具报错噪音行 (无 Token、无 chatModel) -> 必须过滤
    // step 3: CHECKPOINT 无模型系统压缩 (2000/5000/400 = 7400) -> 仅在 transcript，归为未知模型
    // step 5: 同 stepIndex 两次不同时间/Token 的真实调用 (模拟 step 823: 重试)，均应独立保留！
    // step 6: Orchestrator (Carbon) 调用 (5000/1000/200 = 6200) ->  ledger 内存在 #6 和 RPC 双记，须消重为 1 次
    // step 7: invoke_subagent 派生 subCid
    const transcriptMain = [
      JSON.stringify({ step_index: 0, type: 'USER_INPUT', created_at: '2026-11-20T12:00:00Z', content: 'run mixed audit' }),
      JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', created_at: '2026-11-20T12:00:05Z', model: 'gemini-4-hydrogen-high', input_tokens: 1000, cache_read_tokens: 2000, output_tokens: 300 }),
      JSON.stringify({ step_index: 2, type: 'GENERIC', status: 'ERROR', error: 'invalid line range', created_at: '2026-11-20T12:00:10Z' }),
      JSON.stringify({ step_index: 3, source: 'SYSTEM', type: 'CHECKPOINT', created_at: '2026-11-20T12:00:20Z', input_tokens: 2000, cache_read_tokens: 5000, output_tokens: 400 }),
      JSON.stringify({ step_index: 5, type: 'PLANNER_RESPONSE', created_at: '2026-11-20T12:01:00Z', model: 'gemini-3.8-flash-high', input_tokens: 1500, cache_read_tokens: 0, output_tokens: 100 }),
      JSON.stringify({ step_index: 5, type: 'PLANNER_RESPONSE', created_at: '2026-11-20T12:04:00Z', model: 'gemini-3.8-flash-high', input_tokens: 1200, cache_read_tokens: 1500, output_tokens: 120 }),
      JSON.stringify({
        step_index: 6, type: 'PLANNER_RESPONSE', created_at: '2026-11-20T12:05:00Z', model: 'gemini-pro-orchestrator', input_tokens: 5000, cache_read_tokens: 1000, output_tokens: 200,
        tool_calls: [{ name: 'invoke_subagent', args: { Role: '"Research"', TypeName: '"research"' } }]
      }),
      JSON.stringify({ step_index: 7, type: 'GENERIC', created_at: '2026-11-20T12:05:05Z', content: JSON.stringify({ conversationId: subCid }) })
    ].join('\n') + '\n';
    fs.writeFileSync(path.join(agDir, 'brain', mainCid, '.system_generated', 'logs', 'transcript.jsonl'), transcriptMain, 'utf8');

    // 子代理 transcript：1 次 Hydrogen Worker 调用 (400/800/100 = 1300)
    fs.writeFileSync(path.join(agDir, 'brain', subCid, '.system_generated', 'logs', 'transcript.jsonl'), [
      JSON.stringify({ step_index: 0, type: 'USER_INPUT', created_at: '2026-11-20T12:05:02Z', content: 'subagent task' }),
      JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', created_at: '2026-11-20T12:05:04Z', model: 'gemini-flash-worker-agy', input_tokens: 400, cache_read_tokens: 800, output_tokens: 100 })
    ].join('\n') + '\n', 'utf8');

    // pricing_ledger_v1.json 刻意注入：
    // - step 1 的 RPC 记录 (与 transcript 重复, 应合并为 1 条并保留 RPC ID 与测速)
    // - step 5 两条真实调用对应的两个不同 RPC 记录 (其中第二条带 dateIsProvisional: true, 应各自匹配对应 transcript 并继承真实时间)
    // - step 6 的历史双记: mainCid#6 (M667 / gemini-pro-orchestrator) + rpc-orch-6 (Orchestrator (Carbon), prov: true)
    // - subCid step 1 的 RPC 记录 (与子代理 transcript 重复)
    fs.writeFileSync(path.join(agDir, 'pricing_ledger_v1.json'), JSON.stringify({
      version: '1.0.0',
      calls: {
        'rpc-step-1': {
          callId: 'rpc-step-1', cascadeId: mainCid, source: 'desktop', stepIndex: 1,
          model: 'Gemini 4 Hydrogen (High)', modelExactId: 'MODEL_PLACEHOLDER_M525', modelLabel: 'Gemini 4 Hydrogen (High)',
          inputTokens: 1000, cacheReadTokens: 2000, outputTokens: 300, totalTokens: 3300,
          ttftSec: 1.5, streamingSec: 3.0, durationSec: 4.5,
          created_at: '2026-11-20T12:00:05Z', timestamp: Date.parse('2026-11-20T12:00:05Z'), dateIsProvisional: false, status: 'final'
        },
        'rpc-step-5-first': {
          callId: 'rpc-step-5-first', cascadeId: mainCid, source: 'desktop', stepIndex: 5,
          model: 'Gemini 3.8 Flash (High)', modelExactId: 'MODEL_PLACEHOLDER_M318', modelLabel: 'Gemini 3.8 Flash (High)',
          inputTokens: 1500, cacheReadTokens: 0, outputTokens: 100, totalTokens: 1600,
          created_at: '2026-11-20T12:01:00Z', timestamp: Date.parse('2026-11-20T12:01:00Z'), dateIsProvisional: false, status: 'final'
        },
        'rpc-step-5-retry': {
          callId: 'rpc-step-5-retry', cascadeId: mainCid, source: 'desktop', stepIndex: 5,
          model: 'Gemini 3.8 Flash (High)', modelExactId: 'model_placeholder_m318',
          inputTokens: 1200, cacheReadTokens: 1500, outputTokens: 120, totalTokens: 2820,
          timestamp: Date.parse('2026-11-20T18:00:00Z'), dateIsProvisional: true, status: 'final'
        },
        [`${mainCid}#6`]: {
          callId: `${mainCid}#6`, cascadeId: mainCid, source: 'desktop', stepIndex: 6,
          model: 'gemini-pro-orchestrator', modelExactId: 'MODEL_PLACEHOLDER_M667', modelLabel: 'Orchestrator (Carbon)', modelKey: 'gemini-4-argon',
          inputTokens: 5000, cacheReadTokens: 1000, outputTokens: 200, totalTokens: 6200,
          ttftSec: 2.1, streamingSec: 4.0,
          created_at: '2026-11-20T12:05:00Z', timestamp: Date.parse('2026-11-20T12:05:00Z'), dateIsProvisional: false, status: 'final'
        },
        'rpc-orch-6': {
          callId: 'rpc-orch-6', cascadeId: mainCid, source: 'desktop', stepIndex: 6,
          model: 'Orchestrator (Carbon)', modelExactId: 'gemini-pro-orchestrator', modelKey: 'gemini-4-carbon',
          inputTokens: 5000, cacheReadTokens: 1000, outputTokens: 200, totalTokens: 6200,
          timestamp: Date.parse('2026-11-20T18:00:00Z'), dateIsProvisional: true, status: 'final'
        },
        'rpc-sub-1': {
          callId: 'rpc-sub-1', cascadeId: subCid, source: 'desktop', stepIndex: 1,
          model: 'Gemini 4 Hydrogen (Orchestrator)', modelExactId: 'gemini-flash-worker-agy',
          inputTokens: 400, cacheReadTokens: 800, outputTokens: 100, totalTokens: 1300,
          created_at: '2026-11-20T12:05:04Z', timestamp: Date.parse('2026-11-20T12:05:04Z'), dateIsProvisional: false, status: 'final'
        }
      }
    }, null, 2), 'utf8');

    // 1. 账本读取阶段即在内存自动消重 Orchestrator Carbon 双记并修正计费 modelKey
    const roLedger = collector.loadPricingLedger(agDir, { readOnly: true });
    assert.equal(Object.keys(roLedger.calls).length, 5, 'M667 双记应在账本加载态合并为 1 条 rpc-orch-6');
    assert.ok(roLedger.calls['rpc-orch-6']);
    assert.equal(roLedger.calls[`${mainCid}#6`], undefined);
    assert.equal(roLedger.calls['rpc-orch-6'].modelKey, 'gemini-4-carbon');
    assert.equal(roLedger.calls['rpc-orch-6'].dateIsProvisional, false);

    // 2. 三条读取链路 (collector / cli-monitor / cli-ui) 结果完全一致
    const colTl = await collector.collectSessionTimelineAsync(mainCid, { agDir, agCliDir, stateDir, wslRoots: [] });
    const monDetail = cliMonitor.getSessionDetail({ sessionId: mainCid, source: 'desktop', agDir, agCliDir, stateDir });
    const uiTl = cliUi.getCliSessionTimeline({ sessionId: mainCid, source: 'desktop', agDir, agCliDir });

    const expectedTotalTok = 3300 + 7400 + 1600 + 2820 + 6200 + 1300; // = 22620, 共 6 次真实调用
    for (const [name, obj] of [
      ['collector', colTl],
      ['cliMonitor.timeline', monDetail.timeline],
      ['cliUi', uiTl]
    ]) {
      assert.equal(obj.totalCalls, 6, `${name}: 应精确计为 6 次真实调用 (过滤 step 2 噪音、不丢 step 5 两次重试、不重复计主/子)`);
      assert.equal(obj.mainCallsCount, 5, `${name}: 主代理 5 次`);
      assert.equal(obj.subagentCallsCount, 1, `${name}: 子代理 1 次`);
      assert.equal(obj.sessionTokenTotals.totalTokens, expectedTotalTok, `${name}: 会话总 Token 守恒`);
      assert.equal(obj.sessionTokenTotals.isConsistent, true, `${name}: isConsistent`);
      assert.equal(obj.agentFleetSummary.dedupVerified, true, `${name}: dedupVerified`);
    }

    assert.equal(monDetail.sessionTotalTokens, expectedTotalTok);
    assert.equal(monDetail.requestCount, 6);

    // step 5 两次调用都完整保留且第二条拿回权威创建时间 12:04:00Z
    const step5Calls = colTl.turns.flatMap(t => t.calls).filter(c => c.stepIndex === 5);
    assert.equal(step5Calls.length, 2);
    assert.deepEqual(step5Calls.map(c => c.totalTokens).sort((a, b) => a - b), [1600, 2820]);
    const retryCall = step5Calls.find(c => c.totalTokens === 2820);
    assert.equal(retryCall.created_at, '2026-11-20T12:04:00Z');

    // 验证逐模型合计 === 会话总量
    const sumBreakdown = colTl.modelBreakdown.reduce((s, m) => s + m.totalTokens, 0);
    assert.equal(sumBreakdown, expectedTotalTok);
    assert.equal(colTl.modelBreakdown.find(m => m.modelKey === 'gemini-4-hydrogen')?.totalTokens, 3300 + 1300);
    assert.equal(colTl.modelBreakdown.find(m => m.modelKey === 'gemini-3.8-flash')?.totalTokens, 1600 + 2820);
    assert.equal(colTl.modelBreakdown.find(m => m.modelKey === 'orchestrator:carbon')?.totalTokens, 6200);
    assert.equal(colTl.modelBreakdown.find(m => m.modelKey === core.UNATTRIBUTED_MODEL_KEY)?.totalTokens, 7400);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
