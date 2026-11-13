const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  summarize,
  classifyRequestError,
  analyzeSteps,
  measure,
  calculateReferenceModelCost,
  resolveEffectivePlanStatus,
  SUBSCRIPTION_REGIONS_PRESET,
  findRegionPreset,
  convertToCNY,
  getLvlForRange,
  getDailyModelCost,
  calculateIntervalCost,
  parseSemver,
  compareVersions,
  filterReleases,
  findReleaseAsset,
  isValidExternalUrl
} = require('./meter-core');
const entry = (usage, context = {}) => ({ chatModel: { usage, chatStartMetadata: { contextWindowMetadata: context } } });
const exceeded = 'INVALID_ARGUMENT (code 400): The input token count exceeds the maximum number of tokens allowed 1048576.';
test('cache counted once, thinking not counted twice, backend budget preserved', () => {
  const d = summarize(entry({ inputTokens: '1000', cacheReadTokens: '8000', outputTokens: '1000', thinkingOutputTokens: '500' }, { maxContextTokens: 256000 }));
  assert.equal(d.actual, 10000); assert.equal(d.budget, 256000); assert.equal(d.serviceLimit, null); assert.equal(d.percent, 10000 / 256000 * 100);
});
test('failed upload with 127117 estimate overrides a previous successful retry and suppresses percent', () => {
  const d = entry({ inputTokens: 9000 }, { estimatedTokensUsed: 127117, maxContextTokens: 256000 });
  d.chatModel.retryInfos = [{ usage: { inputTokens: 9000 } }, { error: exceeded, usage: { model: 'gemini' } }];
  const s = summarize(d);
  assert.equal(s.exceeded, true); assert.equal(s.actual, null); assert.equal(s.estimate, 127117); assert.equal(s.serviceLimit, 1048576); assert.equal(s.percent, null); assert.equal(s.status, 'exceeded');
});
test('Go timeout error "context deadline exceeded" is classified as network, not context overflow', () => {
  const d = entry({ inputTokens: 9000 });
  d.chatModel.retryInfos = [{ usage: { inputTokens: 9000 } }, { error: 'request failed: stream idle timeout (5m0s): context deadline exceeded', usage: { model: 'gemini' } }];
  const s = summarize(d);
  assert.equal(s.exceeded, false); assert.equal(s.network, true); assert.equal(s.status, 'network'); assert.equal(s.serviceLimit, null);
});
test('gateway EOF ("Post ...: EOF") is network, not context overflow', () => {
  const d = entry({ inputTokens: 9000 });
  d.chatModel.retryInfos = [{ usage: { inputTokens: 9000 } }, { error: 'request failed: Post "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse": EOF', usage: { model: 'gemini' } }];
  const s = summarize(d);
  assert.equal(s.exceeded, false); assert.equal(s.network, true); assert.equal(s.status, 'network');
});
test('true overflow error is still exceeded even when phrased with generic words', () => {
  const d = entry({ inputTokens: 9000 });
  d.chatModel.retryInfos = [{ usage: { inputTokens: 9000 } }, { error: exceeded, usage: { model: 'gemini' } }];
  const s = summarize(d);
  assert.equal(s.exceeded, true); assert.equal(s.network, false);
});
test('Gemini 4 preserves the runtime compression budget for display names and model identifiers', () => {
  const g4 = summarize({ chatModel: { modelDisplayName: 'Gemini 4 Argon (Medium)', usage: { inputTokens: 40000 }, chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 256000 } } } });
  assert.equal(g4.budget, 256000);
  assert.equal(g4.percent, 40000 / 256000 * 100);
  const g4byId = summarize({ chatModel: { model: 'gemini-4-argon-high', usage: { inputTokens: 40000 }, chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 256000 } } } });
  assert.equal(g4byId.budget, 256000);
  const other = summarize({ chatModel: { modelDisplayName: 'Gemini 3.8 Flash (High)', usage: { inputTokens: 40000 }, chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 256000 } } } });
  assert.equal(other.budget, 256000);
  const unnamed = summarize({ chatModel: { usage: { inputTokens: 40000 }, chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 256000 } } } });
  assert.equal(unnamed.budget, 256000);
});

test('Argon uses expanded runtime budgets and keeps missing budgets unknown', () => {
  for (const budget of [512000, 983040, undefined]) {
    const metadata = entry({ inputTokens: 513593 }, { maxContextTokens: budget });
    metadata.chatModel.model = 'gemini-4-argon-trial';
    const result = summarize(metadata);
    assert.equal(result.budget, budget ?? null);
    assert.equal(result.percent, budget ? 513593 / budget * 100 : null);
  }
});
test('estimated input never produces a safe remaining percent or invented million limit', () => {
  const s = summarize(entry({}, { estimatedTokensUsed: 127117 }));
  assert.equal(s.percent, null); assert.equal(s.budget, null); assert.equal(s.serviceLimit, null); assert.equal(s.status, 'estimated');
});
test('output only is not evidence for full input context', () => assert.equal(summarize(entry({ outputTokens: 100 })).actual, null));
test('model without chat metadata remains unknown', () => assert.equal(summarize({}), null));
test('canonical upload and inline preview are not counted as separate attachments', () => {
  const s = analyzeSteps([{ userInput: { userResponse: 'hello', items: [{ text: 'hello', media: { mimeType: 'image/png', inlineData: 'preview' } }], media: [{ uri: 'C:/a.xlsx', mimeType: 'application/xlsx', description: 'a.xlsx' }] } }]);
  assert.equal(s.media.length, 1); assert.equal(s.groups.user.chars, 5);
});
test('full history keeps old messages and repeated upload occurrences; duplicate rendered reply counted once', () => {
  const media = [{ uri: 'C:/a.xlsx', mimeType: 'application/xlsx' }];
  const s = analyzeSteps([{ userInput: { userResponse: 'one', media } }, { plannerResponse: { response: 'answer', modifiedResponse: 'answer', thinking: 'thought' } }, { checkpoint: { sessionSummary: 'summary' } }, { userInput: { userResponse: 'two', media } }, { generic: { result: 'tool output' } }]);
  assert.equal(s.groups.user.chars, 6); assert.equal(s.groups.assistant.chars, 6); assert.equal(s.media[0].references, 2); assert.equal(s.groups.summaries.chars, 7); assert.ok(s.groups.tools.chars > 0);
});
test('old error cleared after later user/assistant steps', () => {
  const error = { errorMessage: { error: { shortError: exceeded } } };
  assert.ok(analyzeSteps([{ userInput: { userResponse: 'a' } }, error]).currentError);
  assert.equal(analyzeSteps([error, { userInput: { userResponse: 'b' } }]).currentError, null);
});
test('Chinese and non-BMP Unicode characters measured without treating binary byte sizes as tokens', () => {
  const s = measure('中文😀0'); assert.equal(s.chars, 4); assert.equal(s.bytes, 11); assert.ok(s.high >= s.low);
});
test('model output speed and duration calculated accurately from timeToFirstToken and streamingDuration', () => {
  const d = summarize({
    chatModel: {
      timeToFirstToken: '8.395092700s',
      streamingDuration: '12.902455200s',
      usage: {
        inputTokens: '4335',
        outputTokens: '2388',
        thinkingOutputTokens: '1260',
        responseOutputTokens: '1128'
      }
    }
  });
  assert.ok(d.speed);
  assert.equal(d.speed.duration, 21.30);
  assert.equal(d.speed.ttft, 8.40);
  assert.equal(d.speed.streamingSec, 12.90);
  assert.equal(d.speed.outputTokens, 2388);
  assert.equal(d.speed.thinkingTokens, 1260);
  assert.equal(d.speed.responseTokens, 1128);
  assert.equal(d.speed.tps, 112.1);
  assert.equal(d.speed.streamingTps, 185.1);
});

test('inline attachments and images are fully counted and parsed instead of unknown', async () => {
  const { scanFiles } = require('./meter-collector');
  const zlib = require('zlib');
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(100, 0); ihdr.writeUInt32BE(80, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  const idat = zlib.deflateSync(Buffer.alloc(80 * (100 * 3 + 1)));
  const pngBuf = Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    Buffer.from([0, 0, 0, 13]), Buffer.from('IHDR'), ihdr, Buffer.alloc(4),
    Buffer.from([0, 0, 0, idat.length]), Buffer.from('IDAT'), idat, Buffer.alloc(4),
    Buffer.from([0, 0, 0, 0]), Buffer.from('IEND'), Buffer.alloc(4)
  ]);
  const base64Png = pngBuf.toString('base64');

  const s = analyzeSteps([
    {
      plannerResponse: {
        response: 'generated file',
        attachment: {
          mimeType: 'image/png',
          description: 'result.png',
          inlineData: { data: base64Png, mimeType: 'image/png' }
        }
      }
    }
  ]);

  assert.equal(s.media.length, 1);
  assert.equal(s.media[0].name, 'result.png');
  assert.ok(s.media[0].inlineData);

  const scanned = await scanFiles(s.media);
  assert.equal(scanned.length, 1);
  assert.equal(scanned[0].status, 'parsed');
  assert.equal(scanned[0].width, 100);
  assert.equal(scanned[0].height, 80);
  assert.equal(scanned[0].low, 258);
  assert.deepEqual(scanned[0].unknownParts, []);
});
// ============================================================================
// 第三阶段测试：API 等值计价、长上下文阈值、日期切换与套餐解析
// ============================================================================
const {
  GEMINI_PRICING_TABLE,
  normalizeModelId,
  calculateRequestApiCost,
  summarizeApiCost,
  parseUserPlanStatus
} = require('./meter-core');

test('3.8 Flash API pricing accurately matches reference fixtures: $4.575 today and $9.15 in 2027', () => {
  const req2026 = {
    model: 'Gemini 3.8 Flash (High)',
    input_tokens: 1000000,
    cache_read_tokens: 1000000,
    output_tokens: 1000000,
    date: '2026-11-08'
  };
  const res2026 = calculateRequestApiCost(req2026);
  assert.equal(res2026.isPriced, true);
  assert.equal(res2026.modelKey, 'gemini-3.8-flash');
  // (1 * 0.75 + 1 * 0.075 + 1 * 3.75) = 4.575
  assert.equal(res2026.costUSD, 4.575);

  const req2027 = {
    model: 'gemini-3.8-flash',
    input_tokens: 1000000,
    cache_read_tokens: 1000000,
    output_tokens: 1000000,
    date: '2027-01-02'
  };
  const res2027 = calculateRequestApiCost(req2027);
  assert.equal(res2027.isPriced, true);
  // (1 * 1.50 + 1 * 0.15 + 1 * 7.50) = 9.15
  assert.equal(res2027.costUSD, 9.15);
});

test('3.1 Pro Preview shifts tier at 200K prompt threshold on single-request basis', () => {
  // 单次 prompt <= 200K (低档: input $2.00, output $12.00, cache $0.20)
  const reqLow = {
    model: 'Gemini 3.1 Pro Preview',
    input_tokens: 150000,
    cache_read_tokens: 50000, // totalPrompt = 200000
    output_tokens: 10000,
    date: '2026-11-08'
  };
  const resLow = calculateRequestApiCost(reqLow);
  assert.equal(resLow.isPriced, true);
  // (0.15 * 2.00 + 0.05 * 0.20 + 0.01 * 12.00) = 0.30 + 0.01 + 0.12 = 0.43
  assert.equal(resLow.costUSD, 0.43);

  // 单次 prompt = 200001 (高档: input $4.00, output $18.00, cache $0.40)
  const reqHigh = {
    model: 'Gemini 3.1 Pro Preview',
    input_tokens: 150001,
    cache_read_tokens: 50000, // totalPrompt = 200001
    output_tokens: 10000,
    date: '2026-11-08'
  };
  const resHigh = calculateRequestApiCost(reqHigh);
  assert.equal(resHigh.isPriced, true);
  // (0.150001 * 4.00 + 0.05 * 0.40 + 0.01 * 18.00) = 0.600004 + 0.02 + 0.18 = 0.800004
  assert.equal(resHigh.costUSD, 0.800004);
});

test('output tokens already include thinking tokens and are not double-counted', () => {
  const req = {
    model: 'gemini-3.8-flash',
    input_tokens: 100000,
    cache_read_tokens: 0,
    output_tokens: 20000, // 已含 thinking
    thinking_output_tokens: 10000,
    date: '2026-11-08'
  };
  const res = calculateRequestApiCost(req);
  assert.equal(res.isPriced, true);
  // (0.1 * 0.75 + 0.02 * 3.75) = 0.075 + 0.075 = 0.15
  assert.equal(res.costUSD, 0.15);
});

test('unknown model or legacy archive requests are labeled unpriced without inventing $0 cost', () => {
  const requests = [
    { model: 'gemini-3.8-flash', input_tokens: 1000000, output_tokens: 1000000, cache_read_tokens: 0, date: '2026-11-08' }, // $4.50
    { model: 'unknown-experimental-model', input_tokens: 500000, output_tokens: 200000, cache_read_tokens: 0, date: '2026-11-08' }
  ];
  const summary = summarizeApiCost(requests);
  assert.equal(summary.pricedRequestsCount, 1);
  assert.equal(summary.unpricedRequestsCount, 1);
  assert.equal(summary.pricedCostUSD, 4.5);
  assert.equal(summary.pricedTokens, 2000000);
  assert.equal(summary.unpricedTokens, 700000);
  assert.ok(summary.coveragePercent < 100);
});

test('parseUserPlanStatus extracts Pro plan and credits correctly while keeping region and actual paid price unknown', () => {
  const fixture = {
    userStatus: {
      name: 'Example User',
      email: 'test@example.com',
      planStatus: {
        planInfo: {
          teamsTier: 'TEAMS_TIER_PRO',
          planName: 'Pro',
          monthlyPromptCredits: 50000,
          monthlyFlowCredits: 150000
        },
        availablePromptCredits: 500,
        availableFlowCredits: 100
      },
      userTier: {
        id: 'g1-pro-tier',
        name: 'Google AI Pro'
      }
    }
  };
  const plan = parseUserPlanStatus(fixture);
  assert.equal(plan.status, 'identified');
  assert.equal(plan.tierKey, 'pro');
  assert.equal(plan.tierName, 'Google AI Pro');
  assert.equal(plan.planName, 'Pro');
  assert.equal(plan.email, 'test@example.com');
  assert.equal(plan.officialPriceMonthly, 19.99);
  assert.equal(plan.actualPricePaid, null);
  assert.ok(plan.region.includes('未知'));
  assert.equal(plan.promptCredits.available, 500);
  assert.equal(plan.promptCredits.monthly, 50000);
  assert.equal(plan.flowCredits.available, 100);
  assert.equal(plan.flowCredits.monthly, 150000);
});

test('parseUserPlanStatus handles unknown or empty payload safely without throwing', () => {
  const emptyPlan = parseUserPlanStatus(null);
  assert.equal(emptyPlan.status, 'unidentified');
  assert.equal(emptyPlan.tierName, '未知');
  assert.equal(emptyPlan.actualPricePaid, null);
});
const { isCompanionOrTempFile, collectTokenHistoryAsync, recordModelCalls } = require('./meter-collector');

test('isCompanionOrTempFile detects SQLite companion files and temporary locks', () => {
  assert.equal(isCompanionOrTempFile('session.db-wal'), true);
  assert.equal(isCompanionOrTempFile('session.db-shm'), true);
  assert.equal(isCompanionOrTempFile('session.db-journal'), true);
  assert.equal(isCompanionOrTempFile('session.tmp'), true);
  assert.equal(isCompanionOrTempFile('session.lock'), true);
  assert.equal(isCompanionOrTempFile('session.pb'), false);
  assert.equal(isCompanionOrTempFile('session.db'), false);
});

test('collectTokenHistoryAsync runs dual-source scan and returns valid data structures in isolated directory', async () => {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-meter-test-ag-'));
  const tempCliDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-meter-test-cli-'));
  try {
    fs.mkdirSync(path.join(tempDir, 'brain', 'sample_desktop'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'conversations'), { recursive: true });
    fs.mkdirSync(path.join(tempCliDir, 'brain', 'sample_cli'), { recursive: true });
    fs.mkdirSync(path.join(tempCliDir, 'conversations'), { recursive: true });

    // 写入模拟 desktop 对话 transcript.jsonl
    const desktopEvent = {
      created_at: '2026-11-08T10:00:00Z',
      model: 'gemini-3.8-flash',
      chatModel: {
        usage: { inputTokens: 5000, outputTokens: 500, cacheReadTokens: 1000 }
      }
    };
    fs.writeFileSync(path.join(tempDir, 'brain', 'sample_desktop', 'transcript.jsonl'), JSON.stringify(desktopEvent) + '\n', 'utf8');

    // 写入模拟 cli 对话 transcript.jsonl
    const cliEvent = {
      created_at: '2026-11-08T11:00:00Z',
      model: 'gemini-3.8-flash',
      chatModel: {
        usage: { inputTokens: 2000, outputTokens: 200, cacheReadTokens: 500 }
      }
    };
    fs.writeFileSync(path.join(tempCliDir, 'brain', 'sample_cli', 'transcript.jsonl'), JSON.stringify(cliEvent) + '\n', 'utf8');

    const data = await collectTokenHistoryAsync({
      force: true,
      agDir: tempDir,
      agCliDir: tempCliDir,
      userStatus: { userTier: { name: 'Pro' }, planStatus: { availablePromptCredits: 500 } }
    });
    assert.ok(data);
    assert.ok(data.sources);
    assert.equal(data.sources.desktop.transcriptsCount, 1);
    assert.equal(data.sources.cli.transcriptsCount, 1);
    assert.ok(data.dailyMapBySource);
    assert.ok(data.dailyMapBySource.all);
    assert.ok(data.dailyMapBySource.desktop);
    assert.ok(data.dailyMapBySource.cli);
    assert.equal(data.planStatus.tierName, 'Google AI Pro');
    assert.ok(data.costEstimate);
    assert.ok(data.costEstimate.pricedRequestsCount >= 2);
    assert.equal(data.costEstimate.unpricedRequestsCount, 0);
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(tempCliDir, { recursive: true, force: true }); } catch {}
  }
});

test('summarizeApiCost with unpriced requests returns 0% coverage and unpriced reasons without inventing 100%', () => {
  const res = summarizeApiCost([{ model: '', input_tokens: 1000, output_tokens: 200 }]);
  assert.equal(res.pricedRequestsCount, 0);
  assert.equal(res.unpricedRequestsCount, 1);
  assert.equal(res.coveragePercent, 0);
  assert.equal(res.pricedCostUSD, 0);
  assert.equal(res.unpricedReasons.missingModel, 1);
});

const { parseGeneratorCall } = require('./meter-core');

test('parseGeneratorCall handles modelDisplayName, responseModel and stepIndices cleanly', () => {
  const row = {
    stepIndices: [10, 11],
    chatModel: {
      modelDisplayName: 'Gemini 3.8 Flash (High)',
      responseModel: 'gemini-3.8-flash-n',
      usage: {
        inputTokens: '10000',
        cacheReadTokens: '20000',
        outputTokens: '1000',
        thinkingOutputTokens: '400',
        responseId: 'resp-test-123'
      }
    }
  };
  const call = parseGeneratorCall(row, 'test-convo-id', 'desktop');
  assert.ok(call);
  assert.equal(call.callId, 'resp-test-123');
  assert.equal(call.modelKey, 'gemini-3.8-flash');
  assert.equal(call.inputTokens, 10000);
  assert.equal(call.cacheTokens, 20000);
  assert.equal(call.outputTokens, 1000);
  assert.equal(call.status, 'final');
  assert.equal(call.isEstimated, false);
  // (0.01 * 0.75 + 0.02 * 0.075 + 0.001 * 3.75) = 0.0075 + 0.0015 + 0.00375 = 0.01275
  assert.equal(call.costUSD, 0.01275);
});

test('cache tokens are preserved through parseGeneratorCall and summarizeApiCost matches $0.01275 fixture', () => {
  const row = {
    chatModel: {
      responseModel: 'gemini-3.8-flash',
      usage: {
        inputTokens: 10000,
        cacheReadTokens: 20000,
        outputTokens: 1000,
        responseId: 'call-cache-test'
      }
    }
  };
  const call = parseGeneratorCall(row, 'convo-1', 'desktop');
  assert.equal(call.costUSD, 0.01275);
  // 单条账本记录再经由 summarizeApiCost 重新计算，费用必须仍为 0.01275 美元，绝不降为 0.0112 美元
  const summary = summarizeApiCost([call]);
  assert.equal(summary.pricedCostUSD, 0.0128); // toFixed(4)
  assert.equal(summary.pricedTokens, 31000);
  assert.equal(summary.byModel['gemini-3.8-flash'].costUSD, 0.01275);
});

test('prompt cache tokens trigger tiered pricing threshold accurately', () => {
  // gemini-3.1-pro-preview: 阈值 200,000 prompt tokens
  // input: 150,000, cacheRead: 60,000 => totalPrompt = 210,000 (> 200,000 触发高档费率)
  const req = {
    model: 'gemini-3.1-pro-preview',
    inputTokens: 150000,
    cacheTokens: 60000,
    outputTokens: 1000
  };
  const res = calculateRequestApiCost(req);
  assert.equal(res.isPriced, true);
  assert.equal(res.matchedTier.minPromptTokens, 200001);
  // 高档 input 4.00/M, cacheRead 0.40/M, output 18.00/M
  // (150000 * 4 + 60000 * 0.4 + 1000 * 18) / 1000000 = (600000 + 24000 + 18000) / 1000000 = 0.642
  assert.equal(res.costUSD, 0.642);
});

test('parseGeneratorCall preserves created_at date and does not replace historical date with today', () => {
  const row = {
    created_at: '2026-10-20T08:30:00Z',
    chatModel: {
      model: 'gemini-3.8-flash',
      usage: { inputTokens: 100, outputTokens: 50, responseId: 'call-hist-date' }
    }
  };
  const call = parseGeneratorCall(row, 'convo-hist', 'desktop');
  assert.equal(call.date, '2026-10-20');
  assert.equal(call.created_at, '2026-10-20T08:30:00Z');
});

test('parseUserPlanStatus treats empty status as unidentified and handles Ultra with unknown sub-tier without hardcoded lowest rate', () => {
  const emptyRes = parseUserPlanStatus({});
  assert.equal(emptyRes.status, 'unidentified');
  assert.equal(emptyRes.tierName, '未知');
  assert.equal(emptyRes.officialPriceMonthly, null);

  const ultraRes = parseUserPlanStatus({ userStatus: { userTier: { name: 'Google AI Ultra' } } });
  assert.equal(ultraRes.status, 'identified');
  assert.equal(ultraRes.tierDisplayName || ultraRes.tierName, 'Google AI Ultra（子档未知）');
  assert.equal(ultraRes.officialPriceMonthly, null);
  assert.ok(ultraRes.priceRangeNote);
});

test('recordModelCalls calibrates from partial streaming usage to final usage and preserves original date', () => {
  const { recordModelCalls, loadPricingLedger } = require('./meter-collector');
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-ledger-test-'));
  try {
    const callPartial = {
      callId: 'call-calibrate-1',
      model: 'gemini-3.8-flash',
      modelKey: 'gemini-3.8-flash',
      inputTokens: 1000,
      cacheTokens: 0,
      outputTokens: 200,
      totalTokens: 1200,
      status: 'streaming',
      isPriced: true,
      costUSD: 0.0015,
      date: '2026-10-25'
    };
    recordModelCalls([callPartial], { agDir: tempDir });
    let ledger = loadPricingLedger(tempDir);
    assert.equal(ledger.calls['call-calibrate-1'].outputTokens, 200);

    const callFinal = {
      callId: 'call-calibrate-1',
      model: 'gemini-3.8-flash',
      modelKey: 'gemini-3.8-flash',
      inputTokens: 1000,
      cacheTokens: 0,
      outputTokens: 400,
      totalTokens: 1400,
      status: 'final',
      isPriced: true,
      costUSD: 0.00225,
      date: '2026-10-25'
    };
    recordModelCalls([callFinal], { agDir: tempDir });
    ledger = loadPricingLedger(tempDir);
    assert.equal(ledger.calls['call-calibrate-1'].outputTokens, 400);
    assert.equal(ledger.calls['call-calibrate-1'].status, 'final');
    assert.equal(ledger.calls['call-calibrate-1'].date, '2026-10-25');

    // 迟到旧数据 (如回退为 200 outputTokens) 绝不能覆盖已完成的 400
    const callStale = {
      callId: 'call-calibrate-1',
      model: 'gemini-3.8-flash',
      modelKey: 'gemini-3.8-flash',
      inputTokens: 1000,
      cacheTokens: 0,
      outputTokens: 200,
      totalTokens: 1200,
      status: 'final',
      isPriced: true,
      costUSD: 0.0015,
      date: '2026-10-25'
    };
    recordModelCalls([callStale], { agDir: tempDir });
    ledger = loadPricingLedger(tempDir);
    assert.equal(ledger.calls['call-calibrate-1'].outputTokens, 400);
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
});

test('install script exposes recordCalls in preload and includes local-api in bundled additions', () => {
  const fs = require('fs');
  const path = require('path');
  const installSrc = fs.readFileSync(path.join(__dirname, 'install.js'), 'utf8');
  assert.ok(installSrc.includes('recordCalls: (calls) => electron_1.ipcRenderer.invoke("context-meter:record-calls", calls)'));
  assert.ok(installSrc.includes("'local-api.js'"));
});

test('calculateReferenceModelCost: Gemini 3.8 Flash 2026-11-08 fixture matches $211.64 and enforces cache discount', () => {
  // 提示词中的标准验算 fixture:
  // input=75639212, output=8354728, cache=1647757871
  // input/1M×0.75 + output/1M×3.75 + cache/1M×0.075 = 211.641479
  const res = calculateReferenceModelCost({
    inputTokens: 75639212,
    outputTokens: 8354728,
    cacheTokens: 1647757871
  }, 'gemini-3.8-flash', { pricingDate: '2026-11-08' });

  assert.equal(res.modelKey, 'gemini-3.8-flash');
  assert.equal(res.formattedTotalUSD, 211.64);
  assert.equal(res.inputCostUSD, 56.7294);
  assert.equal(res.cacheCostUSD, 123.5818);
  assert.equal(res.outputCostUSD, 31.3302);
  assert.equal(res.totalCostUSD, 211.6415);
  // 严禁将 16.47 亿 cache 按普通输入价 0.75 算成所谓的“节省”
  assert.notEqual(res.cacheCostUSD, (1647757871 * 0.75) / 1000000);
});

test('calculateReferenceModelCost: unpriced total without breakdown is labeled unpriced without inventing input/output split', () => {
  const res = calculateReferenceModelCost({ totalTokens: 1000000 }, 'gemini-3.8-flash');
  assert.equal(res.hasBreakdown, false);
  assert.equal(res.totalCostUSD, 0);
  assert.equal(res.unpricedTokens, 1000000);
  assert.equal(res.isSimulation, false);
});

test('calculateReferenceModelCost: hybrid mode subtracts known usage without double counting', () => {
  const res = calculateReferenceModelCost({
    inputTokens: 100000,
    outputTokens: 10000,
    cacheTokens: 200000
  }, 'gemini-3.8-flash', {
    mode: 'unpriced_only',
    knownUsage: {
      inputTokens: 50000,
      outputTokens: 5000,
      cacheTokens: 100000,
      costUSD: 0.05
    }
  });

  assert.ok(res.hybrid);
  assert.equal(res.hybrid.knownCostUSD, 0.05);
  // residual: input=50000 ($0.0375), cache=100000 ($0.0075), output=5000 ($0.01875) => 0.06375
  assert.equal(res.hybrid.unpricedResidualCostUSD, 0.0638);
  assert.equal(res.hybrid.combinedTotalUSD, 0.1138);
});

test('resolveEffectivePlanStatus: actual live values strictly take priority over custom settings', () => {
  const live = {
    status: 'identified',
    tierKey: 'pro',
    tierName: 'Google AI Pro',
    email: 'user@example.com',
    region: '日本 (JP)',
    actualPricePaid: 0, // 0 元促销是有效实际值
    officialPriceMonthly: 19.99,
    currency: 'USD',
    billingCycle: '月付'
  };

  const custom = {
    email: 'user@example.com',
    region: '中国香港 (HK)',
    actualPricePaid: 19.99,
    customNote: '促销备注'
  };

  const effective = resolveEffectivePlanStatus(live, custom);
  // 实际值优先：地区为日本，实付为 0
  assert.equal(effective.region, '日本 (JP)');
  assert.equal(effective.regionSource, 'live');
  assert.equal(effective.actualPricePaid, 0);
  assert.equal(effective.priceSource, 'live');
  assert.equal(effective.customNote, '促销备注'); // 备注仅作为展示旁注
});

test('resolveEffectivePlanStatus: fallback to custom when live is unknown and enforces account isolation', () => {
  const live = {
    status: 'identified',
    tierKey: 'pro',
    tierName: 'Google AI Pro',
    email: 'current@example.com',
    region: '未知',
    actualPricePaid: null,
    officialPriceMonthly: 19.99
  };

  // 1) 账号匹配时：采用自定义手填
  const customMatched = {
    email: 'current@example.com',
    region: '新加坡 (SG)',
    actualPricePaid: 21.50,
    currency: 'USD',
    billingCycle: '月付'
  };
  const effMatched = resolveEffectivePlanStatus(live, customMatched);
  assert.equal(effMatched.region, '新加坡 (SG)');
  assert.equal(effMatched.regionSource, 'custom');
  assert.equal(effMatched.actualPricePaid, 21.5);
  assert.equal(effMatched.priceSource, 'custom');

  // 2) 账号不匹配时：绝不继承其他账号设置
  const customOtherAccount = {
    email: 'other@example.com',
    region: '新加坡 (SG)',
    actualPricePaid: 21.50
  };
  const effUnmatched = resolveEffectivePlanStatus(live, customOtherAccount);
  assert.equal(effUnmatched.region, '未知');
  assert.equal(effUnmatched.regionSource, 'unknown');
  assert.equal(effUnmatched.actualPricePaid, null);
  assert.equal(effUnmatched.priceSource, 'official_reference');
});

test('quarantineSyntheticCalls: isolates synthetic test items into quarantine file leaving production ledger clean', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const {
    quarantineSyntheticCalls,
    loadPricingLedger,
    savePricingLedger,
    recordModelCalls
  } = require('./meter-collector');

  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-quarantine-test-'));
  try {
    const mockCalls = {
      test_real_desktop_response_001: {
        callId: 'test_real_desktop_response_001',
        source: 'desktop',
        cascadeId: 'desktop-session-verify',
        costUSD: 0.0128
      },
      call_real_production_user_002: {
        callId: 'call_real_production_user_002',
        source: 'desktop',
        cascadeId: 'real-session-user',
        costUSD: 0.05
      }
    };
    savePricingLedger({ version: '1.0.0', calls: mockCalls }, testDir);

    const res = quarantineSyntheticCalls(testDir);
    assert.equal(res.quarantinedCount, 1);

    const cleanedLedger = loadPricingLedger(testDir);
    assert.equal(Object.keys(cleanedLedger.calls).length, 1);
    assert.ok(cleanedLedger.calls['call_real_production_user_002']);
    assert.equal(cleanedLedger.calls['test_real_desktop_response_001'], undefined);

    const qPath = path.join(testDir, 'pricing_ledger_quarantine.json');
    assert.ok(fs.existsSync(qPath));
    const qData = JSON.parse(fs.readFileSync(qPath, 'utf8'));
    assert.ok(qData.calls['test_real_desktop_response_001']);
  } finally {
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch {}
  }
});

test('calculateReferenceModelCost: hybrid mode with full coverage has zero residual and matches priced cost', () => {
  // 混合模式边界：已知用量完全覆盖总用量时，残差必须为 0，且综合费用严格等于已知费用
  const totalTotals = {
    inputTokens: 10000,
    cacheTokens: 20000,
    outputTokens: 1000,
    totalTokens: 31000
  };
  const known = {
    byCategory: {
      inputTokens: 10000,
      cacheTokens: 20000,
      outputTokens: 1000
    },
    costUSD: 0.01275
  };

  const res = calculateReferenceModelCost(totalTotals, 'gemini-3.8-flash', {
    mode: 'unpriced_only',
    knownUsage: known
  });

  assert.ok(res.hybrid);
  assert.equal(res.hybrid.unpricedResidualTokens, 0);
  assert.equal(res.hybrid.unpricedResidualCostUSD, 0);
  assert.equal(res.hybrid.combinedTotalUSD, 0.01275); // 全覆盖残差为0，严格等于已识别金额
  assert.equal(res.hybrid.residualTokensBreakdown.input, 0);
  assert.equal(res.hybrid.residualTokensBreakdown.cache, 0);
  assert.equal(res.hybrid.residualTokensBreakdown.output, 0);
});

test('resolveEffectivePlanStatus: free/promotional users correctly display 0 paid and acquisition source without infinite ratio', () => {
  const live = {
    status: 'identified',
    tierKey: 'pro',
    tierName: 'Google AI Pro',
    email: 'student@example.com',
    region: '未知',
    actualPricePaid: null,
    officialPriceMonthly: 19.99
  };

  const custom = {
    email: 'student@example.com',
    acquisitionSource: 'student_offer',
    isZeroExtraCost: true,
    actualPricePaid: 0,
    currency: 'CNY',
    validEndDate: '2027-01-01',
    customNote: '2026 学生优惠'
  };

  const effective = resolveEffectivePlanStatus(live, custom);
  assert.equal(effective.actualPricePaid, 0);
  assert.equal(effective.isZeroExtraCost, true);
  assert.equal(effective.currency, 'CNY');
  assert.equal(effective.currencySymbol, '¥');
  assert.equal(effective.acquisitionSource, 'student_offer');
  assert.match(effective.acquisitionSourceName, /学生认证优惠/);
  assert.match(effective.priceRangeNote, /¥0/);
  assert.equal(effective.isExpired, false);

  // 测试已到期状态
  const expiredCustom = {
    ...custom,
    validEndDate: '2025-01-01' // 历史已到期
  };
  const effExpired = resolveEffectivePlanStatus(live, expiredCustom);
  assert.equal(effExpired.isExpired, true);
  assert.match(effExpired.priceRangeNote, /权益已到期/);
});


test('subscription regions preset and CNY currency conversion match market rates', () => {
  assert.ok(SUBSCRIPTION_REGIONS_PRESET.length >= 15);

  // 地区查询与别名识别
  const us = findRegionPreset('美国');
  assert.equal(us.id, 'US');
  assert.equal(us.currency, 'USD');
  assert.equal(us.monthlyPrice, 19.99);

  const tr = findRegionPreset('土耳其');
  assert.equal(tr.id, 'TR');
  assert.equal(tr.currency, 'TRY');

  const hk = findRegionPreset('港区');
  assert.equal(hk.id, 'HK');
  assert.equal(hk.currency, 'HKD');

  const jp = findRegionPreset('日本');
  assert.equal(jp.id, 'JP');
  assert.equal(jp.currency, 'JPY');

  const ng = findRegionPreset('尼日利亚');
  assert.equal(ng.id, 'NG');
  assert.equal(ng.currency, 'NGN');

  // 汇率换算折合人民币核验
  // 19.99 USD * 6.72 = 134.33
  const cnyUS = convertToCNY(19.99, 'USD', '美国');
  assert.equal(cnyUS, 134.33);

  // 2900 JPY * 0.0425 = 123.25
  const cnyJP = convertToCNY(2900, 'JPY', '日本');
  assert.equal(cnyJP, 123.25);

  // 158 HKD * 0.857 = 135.41
  const cnyHK = convertToCNY(158, 'HKD', '中国香港');
  assert.equal(cnyHK, 135.41);

  // 869.99 TRY * 0.133 = 115.71
  const cnyTR = convertToCNY(869.99, 'TRY', '土耳其');
  assert.equal(cnyTR, 115.71);

  // 28500 NGN * 0.0042 = 119.70
  const cnyNG = convertToCNY(28500, 'NGN', '尼日利亚');
  assert.equal(cnyNG, 119.7);
});

test('resolveEffectivePlanStatus: calculates CNY price and displays bracketed conversion', () => {
  const live = {
    status: 'identified',
    tierKey: 'pro',
    tierName: 'Google AI Pro',
    email: 'user@example.com',
    region: '未知',
    actualPricePaid: null
  };

  const custom = {
    email: 'user@example.com',
    region: '日本 (JP)',
    actualPricePaid: 2900,
    currency: 'JPY',
    billingCycle: '月付'
  };

  const effective = resolveEffectivePlanStatus(live, custom);
  assert.equal(effective.region, '日本 (JP)');
  assert.equal(effective.actualPricePaid, 2900);
  assert.equal(effective.currency, 'JPY');
  assert.equal(effective.currencySymbol, '¥');
  assert.equal(effective.actualPricePaidCNY, 123.25);
  assert.equal(effective.cnyFormatted, '折合 ≈ ¥123.3 CNY');
  assert.match(effective.priceRangeNote, /¥2900/);
  assert.match(effective.priceRangeNote, /折合 ≈ ¥123.3/);
});

test('plugin settings persistence: distinct country, subscriptionRegion, currency, legacy migration, corruption recovery, and failure feedback', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const {
    loadCustomPlanSettings,
    savePluginSettings,
    getPluginSettings
  } = require('./meter-collector');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-settings-test-'));
  try {
    // 1. 保存三项独立设置：国家 (美国)、订阅地区 (韩国)、币种 (KRW)
    const saveRes = savePluginSettings({
      email: 'user@example.com',
      customPlan: {
        country: '美国 (US)',
        subscriptionRegion: '韩国 (KRW)',
        currency: 'KRW',
        actualPricePaid: 29000,
        billingCycle: '月付'
      }
    }, { agDir: tmpDir });

    assert.equal(saveRes.ok, true);
    assert.equal(saveRes.planStatus.country, '美国 (US)');
    assert.equal(saveRes.planStatus.subscriptionRegion, '韩国 (KRW)');
    assert.equal(saveRes.planStatus.region, '韩国 (KRW)');
    assert.equal(saveRes.planStatus.currency, 'KRW');
    assert.equal(saveRes.planStatus.currencySymbol, '₩');

    // 2. 重启后读取（含未识别邮箱时通过 default / lastAccount 恢复）
    const loadedNoEmail = getPluginSettings({ agDir: tmpDir });
    assert.equal(loadedNoEmail.ok, true);
    assert.equal(loadedNoEmail.customPlan.country, '美国 (US)');
    assert.equal(loadedNoEmail.customPlan.subscriptionRegion, '韩国 (KRW)');
    assert.equal(loadedNoEmail.customPlan.currency, 'KRW');

    // 3. 单独修改币种为 AUD，验证国家与订阅地区不被覆盖
    const saveCurOnly = savePluginSettings({
      email: 'user@example.com',
      customPlan: {
        currency: 'AUD',
        actualPricePaid: 32.99
      }
    }, { agDir: tmpDir });
    assert.equal(saveCurOnly.ok, true);
    assert.equal(saveCurOnly.planStatus.country, '美国 (US)');
    assert.equal(saveCurOnly.planStatus.subscriptionRegion, '韩国 (KRW)');
    assert.equal(saveCurOnly.planStatus.currency, 'AUD');
    assert.equal(saveCurOnly.planStatus.currencySymbol, 'AU$');

    // 4. 兼容旧配置（仅含 region、含无效币种与非法价格）
    const cfgFile = path.join(tmpDir, 'custom_plan_v1.json');
    fs.writeFileSync(cfgFile, JSON.stringify({
      version: '1.0.0',
      accounts: {
        default: {
          region: '澳大利亚 (AUD)',
          currency: 'INVALID_CURRENCY_CODE',
          actualPricePaid: 'not-a-number'
        }
      }
    }), 'utf8');
    const legacyLoaded = getPluginSettings({ agDir: tmpDir });
    assert.equal(legacyLoaded.customPlan.region, '澳大利亚 (AUD)');
    assert.equal(legacyLoaded.customPlan.subscriptionRegion, '澳大利亚 (AUD)');
    assert.equal(legacyLoaded.customPlan.currency, undefined);
    const resolvedLegacy = resolveEffectivePlanStatus(null, legacyLoaded.customPlan);
    assert.equal(resolvedLegacy.currency, 'AUD');
    assert.equal(resolvedLegacy.actualPricePaid, 32.99);

    // 5. 配置文件损坏时自动隔离备份并恢复默认结构
    fs.writeFileSync(cfgFile, '{corrupted json content!!!', 'utf8');
    const corruptLoaded = loadCustomPlanSettings(tmpDir);
    assert.equal(corruptLoaded.recoveredFromCorruption, true);
    assert.ok(fs.existsSync(path.join(tmpDir, 'custom_plan_v1.corrupt.bak.json')));

    // 6. 保存失败时返回真实错误反馈（将目标文件位置建为目录以触发写入失败）
    const badDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-settings-fail-'));
    fs.mkdirSync(path.join(badDir, 'custom_plan_v1.json'), { recursive: true });
    const failRes = savePluginSettings({
      customPlan: { country: '日本 (JP)', subscriptionRegion: '日本 (JP)', currency: 'JPY' }
    }, { agDir: badDir });
    assert.equal(failRes.ok, false);
    assert.match(failRes.error, /目录|失败/);
    fs.rmSync(badDir, { recursive: true, force: true });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('CLI resolution & workspace handling: Chinese/space paths, fallback directory, and missing CLI error feedback', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { pathToFileURL } = require('node:url');
  const {
    resolveCliExecutable,
    resolveCliWorkspace,
    launchCliSession
  } = require('./meter-collector');

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-cli-test-'));
  try {
    // 1. 创建含中文与空格的项目目录及模拟 CLI 文件
    const cnSpaceDir = path.join(tmpRoot, '测试 项目 (中文 Space Dir)');
    fs.mkdirSync(cnSpaceDir, { recursive: true });
    const fakeCli = path.join(tmpRoot, 'agy.exe');
    fs.writeFileSync(fakeCli, 'fake-binary', 'utf8');

    // 2. 验证显式传入及 file:// URI 编码的中文空格路径解析
    const encodedUri = pathToFileURL(cnSpaceDir).href;
    const wsFromUri = await resolveCliWorkspace({ cwd: encodedUri });
    assert.equal(wsFromUri.ok, true);
    assert.equal(wsFromUri.cwd, cnSpaceDir);

    // 3. 验证 dryRun 启动命令组装与参数传递
    const dryRes = await launchCliSession({
      cliPath: fakeCli,
      cwd: cnSpaceDir,
      model: 'gemini-3.8-flash-high',
      args: ['--continue'],
      dryRun: true
    });
    assert.equal(dryRes.ok, true);
    assert.equal(dryRes.exePath, fakeCli);
    assert.equal(dryRes.cwd, cnSpaceDir);
    assert.deepEqual(dryRes.args, ['--model', 'gemini-3.8-flash-high', '--continue']);

    // 4. 验证 CLI 不存在时的明确报错反馈
    const missingCliPath = path.join(tmpRoot, 'nonexistent-dir', 'missing-agy.exe');
    const missingRes = await launchCliSession({
      cliPath: missingCliPath,
      cwd: cnSpaceDir
    });
    assert.equal(missingRes.ok, false);
    assert.equal(missingRes.code, 'CLI_NOT_FOUND');
    assert.match(missingRes.error, /不存在|不可用/);

    // 5. 验证未打开项目时的默认目录回退
    const fallbackWs = await resolveCliWorkspace({
      cascadeId: '00000000-0000-0000-0000-000000000000',
      agDir: tmpRoot,
      appDataDir: tmpRoot,
      configDir: tmpRoot,
      defaultDir: cnSpaceDir
    });
    assert.equal(fallbackWs.ok, true);
    assert.equal(fallbackWs.cwd, cnSpaceDir);
    assert.equal(fallbackWs.source, 'default_fallback');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// 错误分类与状态识别行为测试
// ============================================================================
test('server explicit quota error classifies as quota_exhausted with affected model info', () => {
  const d = entry({ inputTokens: 5000 });
  d.chatModel.modelDisplayName = 'Gemini 4 Argon (High)';
  d.chatModel.retryInfos = [
    { error: 'rpc error: code = ResourceExhausted desc = Quota exceeded for quota metric Gemini4ArgonPerWeek', usage: { model: 'gemini' } }
  ];
  const s = summarize(d, { currentModel: 'Gemini 4 Argon (High)' });
  assert.equal(s.exceeded, false);
  assert.equal(s.network, false);
  assert.equal(s.status, 'quota_exhausted');
  assert.equal(s.errorClassification.kind, 'quota_exhausted');
  assert.equal(s.errorClassification.badgeText, '额度耗尽');
  assert.match(s.errorClassification.detail, /额度已用尽/);
});

test('exhausted model quota does not leak into isolated model pools with remaining quota', () => {
  const cascadeConfigs = [
    { modelId: 'gemini-4-argon-high', label: 'Gemini 4 Argon (High)', quotaInfo: { remainingFraction: 0, resetTime: '2026-11-15T14:29:07Z' } },
    { modelId: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)', quotaInfo: { remainingFraction: 0.99, resetTime: '2026-11-09T15:22:10Z' } }
  ];

  // 1. Argon 请求：配额确凿为 0，发生非取消错误时判定为额度耗尽
  const argonEntry = entry({ inputTokens: 10000 });
  argonEntry.chatModel.modelDisplayName = 'Gemini 4 Argon (High)';
  argonEntry.chatModel.retryInfos = [{ error: 'request failed: ResourceExhausted', usage: { model: 'gemini-4-argon-high' } }];
  const sArgon = summarize(argonEntry, { currentModel: 'Gemini 4 Argon (High)', cascadeModelConfigs: cascadeConfigs });
  assert.equal(sArgon.status, 'quota_exhausted');
  assert.equal(sArgon.errorClassification.kind, 'quota_exhausted');
  assert.match(sArgon.errorClassification.detail, /Gemini 4 Argon.*额度已用尽/);

  // 2. Flash 请求：配额剩余 99%，即使遇到通用报错，绝不能被 Argon 的耗尽影响
  const flashEntry = entry({ inputTokens: 10000 });
  flashEntry.chatModel.modelDisplayName = 'Gemini 3.8 Flash (High)';
  flashEntry.chatModel.retryInfos = [{ error: 'request failed: internal error', usage: { model: 'gemini-3.8-flash-high' } }];
  const sFlash = summarize(flashEntry, { currentModel: 'Gemini 3.8 Flash (High)', cascadeModelConfigs: cascadeConfigs });
  assert.notEqual(sFlash.status, 'quota_exhausted');
  assert.notEqual(sFlash.errorClassification.kind, 'quota_exhausted');
});

test('network errors are not misclassified as quota exhaustion even when remaining quota is low', () => {
  const cascadeConfigs = [
    { modelId: 'gemini-4-argon-high', label: 'Gemini 4 Argon (High)', quotaInfo: { remainingFraction: 0.0104, resetTime: '2026-11-15T14:29:07Z' } }
  ];
  const d = entry({ inputTokens: 538000, maxContextTokens: 983040 });
  d.chatModel.modelDisplayName = 'Gemini 4 Argon (High)';
  d.chatModel.retryInfos = [
    { error: 'request failed: stream idle timeout (5m0s): context deadline exceeded', usage: { model: 'gemini' } }
  ];
  const s = summarize(d, {
    currentModel: 'Gemini 4 Argon (High)',
    cascadeModelConfigs: cascadeConfigs,
    previousValidContext: { used: 538000, actual: 538000, budget: 983040 }
  });

  // 必须严格判定为网络错误，绝不编造成额度耗尽！
  assert.equal(s.exceeded, false);
  assert.equal(s.network, true);
  assert.equal(s.status, 'network');
  assert.equal(s.errorClassification.kind, 'network_error');
  assert.equal(s.errorClassification.badgeText, '网络');
  assert.match(s.errorClassification.detail, /超时|网络/);

  // 上下文容量与错误状态解耦：有效用量与预算得到保留，绝不置为 null 或 0
  assert.equal(s.budget, 983040);
  assert.equal(s.used, 538000);
});

test('rate limits with retry-after are distinguished from long-term quota exhaustion', () => {
  // A: 触发请求频率限制（含 retry-after 25s）
  const rateLimitEntry = entry({ inputTokens: 2000 });
  rateLimitEntry.chatModel.retryInfos = [{ error: 'HTTP 429 Too Many Requests: Rate limit exceeded, retry in 25s', usage: { model: 'gemini' } }];
  const sRate = summarize(rateLimitEntry, { currentModel: 'Gemini 3.8 Flash' });
  assert.equal(sRate.status, 'rate_limited');
  assert.equal(sRate.errorClassification.kind, 'rate_limited');
  assert.equal(sRate.errorClassification.badgeText, '限流');
  assert.equal(sRate.errorClassification.retryAfterSec, 25);
  assert.match(sRate.errorClassification.detail, /25/);

  // B: 长期配额耗尽
  const quotaEntry = entry({ inputTokens: 2000 });
  quotaEntry.chatModel.retryInfos = [{ error: 'HTTP 429 ResourceExhausted: You have exhausted your current quota for the month', usage: { model: 'gemini' } }];
  const sQuota = summarize(quotaEntry, { currentModel: 'Gemini 3.8 Flash' });
  assert.equal(sQuota.status, 'quota_exhausted');
  assert.equal(sQuota.errorClassification.kind, 'quota_exhausted');
  assert.equal(sQuota.errorClassification.badgeText, '额度耗尽');
});

test('context length overflow extracts service limit and flags overflow alert', () => {
  const d = entry({ inputTokens: 10000 });
  d.chatModel.retryInfos = [
    { error: 'input token count exceeds maximum context length of 1048576 tokens', usage: { model: 'gemini' } }
  ];
  const s = summarize(d, { currentModel: 'Gemini 4 Argon' });
  assert.equal(s.exceeded, true);
  assert.equal(s.network, false);
  assert.equal(s.serviceLimit, 1048576);
  assert.equal(s.status, 'exceeded');
  assert.equal(s.errorClassification.kind, 'context_overflow');
  assert.equal(s.errorClassification.badgeText, '超限');
  assert.match(s.errorClassification.detail, /1048576/);
});

test('explicit quota error dominates subsequent connection timeout during retries', () => {
  const d = entry({ inputTokens: 8000 });
  d.chatModel.modelDisplayName = 'Gemini 4 Argon';
  d.chatModel.retryInfos = [
    { error: 'rpc error: code = ResourceExhausted desc = weekly quota exceeded', usage: { model: 'gemini' } },
    { error: 'request failed: context deadline exceeded', usage: { model: 'gemini' } }
  ];
  const s = summarize(d, { currentModel: 'Gemini 4 Argon' });
  assert.equal(s.network, true);
  const combinedClass = classifyRequestError(
    d.chatModel.retryInfos.map(r => r.error).join(' | '),
    { currentModel: 'Gemini 4 Argon' }
  );
  assert.equal(combinedClass.kind, 'quota_exhausted');
  assert.equal(combinedClass.badgeText, '额度耗尽');
});

test('unrecognized server errors are marked unknown with sanitized diagnostic info', () => {
  const d = entry({ inputTokens: 4000 });
  d.chatModel.retryInfos = [
    { error: 'Post "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent": unexpected status 500: unknown internal error id 98124', usage: { model: 'gemini' } }
  ];
  const s = summarize(d, { currentModel: 'Gemini 4 Argon' });
  assert.equal(s.exceeded, false);
  assert.equal(s.network, false);
  assert.equal(s.errorClassification.kind, 'unknown');
  assert.equal(s.errorClassification.badgeText, '待确认');
  assert.equal(s.errorClassification.title, '原因待确认');
  assert.match(s.errorClassification.diagnostic, /<API>/);
  assert.doesNotMatch(s.errorClassification.diagnostic, /https:\/\/daily-cloudcode-pa/);
});

test('getLvlForRange: accurate thresholds for day, week and month ranges', () => {
  // 1. day: 绝对阈值 (0, <3M, <15M, <60M, >=60M)
  assert.equal(getLvlForRange(0, 'day'), 0);
  assert.equal(getLvlForRange(1000, 'day'), 1);
  assert.equal(getLvlForRange(2999999, 'day'), 1);
  assert.equal(getLvlForRange(3000000, 'day'), 2);
  assert.equal(getLvlForRange(14999999, 'day'), 2);
  assert.equal(getLvlForRange(15000000, 'day'), 3);
  assert.equal(getLvlForRange(59999999, 'day'), 3);
  assert.equal(getLvlForRange(60000000, 'day'), 4);
  assert.equal(getLvlForRange(1e9, 'day'), 4);

  // 2. week / month: 相对最大值分位 (0, <=25%, <=50%, <=75%, >75%)
  const maxVal = 100000;
  assert.equal(getLvlForRange(0, 'week', maxVal), 0);
  assert.equal(getLvlForRange(10000, 'week', maxVal), 1);
  assert.equal(getLvlForRange(25000, 'week', maxVal), 1);
  assert.equal(getLvlForRange(25001, 'week', maxVal), 2);
  assert.equal(getLvlForRange(50000, 'week', maxVal), 2);
  assert.equal(getLvlForRange(50001, 'week', maxVal), 3);
  assert.equal(getLvlForRange(75000, 'week', maxVal), 3);
  assert.equal(getLvlForRange(75001, 'week', maxVal), 4);
  assert.equal(getLvlForRange(100000, 'week', maxVal), 4);

  assert.equal(getLvlForRange(0, 'month', 200), 0);
  assert.equal(getLvlForRange(50, 'month', 200), 1);
  assert.equal(getLvlForRange(100, 'month', 200), 2);
  assert.equal(getLvlForRange(150, 'month', 200), 3);
  assert.equal(getLvlForRange(200, 'month', 200), 4);
});

test('calculateIntervalCost: day->week->month->year->cum sum equivalence (< 1e-9) and future exclusion', () => {
  // 固定测试样本数据
  const dailyMap = {
    '2026-11-01': { input: 100000, cache: 20000, output: 10000, total: 130000 },
    '2026-11-02': { input: 200000, cache: 50000, output: 30000, total: 280000 },
    '2026-11-03': { input: 150000, cache: 10000, output: 20000, total: 180000 },
    '2026-11-04': { input: 0, cache: 0, output: 0, total: 0 },
    '2026-11-05': { input: 300000, cache: 80000, output: 50000, total: 430000 },
    '2026-11-06': { input: 50000, cache: 0, output: 5000, total: 55000 },
    '2026-11-07': { input: 120000, cache: 30000, output: 15000, total: 165000 },
    // 假设今日为 2026-11-07，以下为未来日期
    '2026-11-08': { input: 0, cache: 0, output: 0, total: 0 },
    '2026-11-09': { input: 0, cache: 0, output: 0, total: 0 }
  };

  const datesWeek1 = ['2026-11-01', '2026-11-02', '2026-11-03'];
  const datesWeek2 = ['2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07'];
  const allDates = [...datesWeek1, ...datesWeek2, '2026-11-08', '2026-11-09'];

  const options = { pricingDate: '2026-11-08', todayStr: '2026-11-07' };
  const costW1 = calculateIntervalCost(dailyMap, datesWeek1, 'gemini-3.8-flash', options);
  const costW2 = calculateIntervalCost(dailyMap, datesWeek2, 'gemini-3.8-flash', options);
  const costAll = calculateIntervalCost(dailyMap, allDates, 'gemini-3.8-flash', options);

  // 1. 逐级求和一致性（周1费用 + 周2费用 == 全月费用，误差 < 1e-9）
  const sumWeeks = costW1.totalCostUSD + costW2.totalCostUSD;
  assert.ok(Math.abs(sumWeeks - costAll.totalCostUSD) < 1e-9, `sumWeeks (${sumWeeks}) should equal costAll (${costAll.totalCostUSD})`);

  // 2. 独立按单日计算之和校验
  let independentSum = 0;
  for (const d of ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-05', '2026-11-06', '2026-11-07']) {
    const single = getDailyModelCost(dailyMap[d], d, 'gemini-3.8-flash', options);
    independentSum += single.costUSD;
  }
  assert.ok(Math.abs(independentSum - costAll.totalCostUSD) < 1e-9);

  // 3. 未来日期排除：参与天数一共 9 天，但 08 和 09 是未来，pastDays 应为 7
  assert.equal(costAll.pastDays, 7);
  assert.equal(costAll.activeDays, 6); // 11-04 为 0 token，活跃天数是 6
  assert.equal(costAll.dailyAverageUSD, Number((costAll.totalCostUSD / 7).toFixed(4)));
  assert.equal(costAll.activeDailyAverageUSD, Number((costAll.totalCostUSD / 6).toFixed(4)));
});

test('semver & update filtering: strictly accepts v0.x tags, ignores asset filename versioning, and validates platforms', () => {
  assert.deepEqual(parseSemver('v0.8.0'), { major: 0, minor: 8, patch: 0 });
  assert.deepEqual(parseSemver('0.7.2'), { major: 0, minor: 7, patch: 2 });
  // 防御性过滤：主版本非 0 一律忽略
  assert.equal(parseSemver('v2.7.4'), null);
  assert.equal(parseSemver('v1.0.0'), null);
  assert.equal(parseSemver('beta-0.8.0'), null);

  assert.equal(compareVersions('0.8.1', '0.8.0'), 1);
  assert.equal(compareVersions('0.8.0', '0.8.0'), 0);
  assert.equal(compareVersions('0.7.0', '0.8.0'), -1);

  // Release 过滤测试：包含历史 Release（ZIP 中仍可能带有 2.7.x 文件名）
  const mockReleases = [
    { tag_name: 'v2.7.4', draft: false, prerelease: false }, // 应忽略
    { tag_name: 'v0.9.0', draft: false, prerelease: false, html_url: 'https://github.com/.../v0.9.0', assets: [] },
    { tag_name: 'v0.8.1', draft: false, prerelease: false, html_url: 'https://github.com/.../v0.8.1', assets: [] },
    { tag_name: 'v0.8.0', draft: false, prerelease: false }, // 不大于当前版本
    { tag_name: 'v0.10.0-draft', draft: true, prerelease: false } // draft 忽略
  ];

  const valid = filterReleases(mockReleases, '0.8.0');
  assert.equal(valid.length, 2);
  assert.equal(valid[0].version, '0.9.0');
  assert.equal(valid[1].version, '0.8.1');

  // 资产匹配测试（即使历史文件名带 2.7.x 也能基于 platform/arch 正确解析）
  const mockAssets = [
    { name: 'antigravity-context-viewer_2.7.2_windows_amd64.zip', browser_download_url: 'https://.../win.zip' },
    { name: 'antigravity-context-viewer_2.7.2_darwin_arm64.zip', browser_download_url: 'https://.../mac.zip' },
    { name: 'checksums.txt', browser_download_url: 'https://.../checksums.txt' }
  ];

  const winMatch = findReleaseAsset(mockAssets, 'win32', 'x64');
  assert.equal(winMatch.packageAsset.name, 'antigravity-context-viewer_2.7.2_windows_amd64.zip');
  assert.equal(winMatch.checksumAsset.name, 'checksums.txt');

  const macMatch = findReleaseAsset(mockAssets, 'darwin', 'arm64');
  assert.equal(macMatch.packageAsset.name, 'antigravity-context-viewer_2.7.2_darwin_arm64.zip');

  const missingMatch = findReleaseAsset(mockAssets, 'linux', 'arm64');
  assert.equal(missingMatch.packageAsset, null);
  assert.equal(missingMatch.checksumAsset.name, 'checksums.txt');
});

test('isValidExternalUrl: strictly allows only official repository paths and subpaths', () => {
  assert.equal(isValidExternalUrl('https://github.com/elviscjn-cjn/antigravity-context-viewer'), true);
  assert.equal(isValidExternalUrl('https://github.com/elviscjn-cjn/antigravity-context-viewer/'), true);
  assert.equal(isValidExternalUrl('https://github.com/elviscjn-cjn/antigravity-context-viewer/releases'), true);
  assert.equal(isValidExternalUrl('https://github.com/elviscjn-cjn/antigravity-context-viewer/issues'), true);
  assert.equal(isValidExternalUrl('https://github.com/elviscjn-cjn/antigravity-context-viewer/releases/tag/v0.8.0'), true);

  // 拒绝非官方仓库与恶意跳转
  assert.equal(isValidExternalUrl('https://github.com/other-user/antigravity-context-viewer'), false);
  assert.equal(isValidExternalUrl('https://malicious.com/github.com/elviscjn-cjn/antigravity-context-viewer'), false);
  assert.equal(isValidExternalUrl('http://github.com/elviscjn-cjn/antigravity-context-viewer'), false); // 非 https
  assert.equal(isValidExternalUrl('javascript:alert(1)'), false);
  assert.equal(isValidExternalUrl(''), false);
  assert.equal(isValidExternalUrl(null), false);
});

// ============================================================================
// Antigravity 2.31.2 回归测试：新模型计价/配额池、TTL 重扫解锁与账本-日志零双计对齐
// ============================================================================
test('2.31.2 model lineup: Gemini 4 Carbon (2026-11 vs 2026-12), Claude Opus/Sonnet 5.5, quota pool, and GPT-OSS unpriced invariant', () => {
  const { resolveModelQuota, extractCallId } = require('./meter-core');

  // 1. Gemini 4 Carbon: 2026-11 ($2 / $10 / $0.10) vs 2026-12 ($4 / $20 / $0.20)，无 >200K 溢价
  const carbonNov = calculateRequestApiCost({
    model: 'Gemini 4 Carbon (High)',
    inputTokens: 250000,
    cacheReadTokens: 100000,
    outputTokens: 10000,
    date: '2026-11-12'
  });
  assert.equal(carbonNov.isPriced, true);
  assert.equal(carbonNov.modelKey, 'gemini-4-carbon');
  // (0.25 * 2.0 + 0.1 * 0.10 + 0.01 * 10.0) = 0.50 + 0.01 + 0.10 = 0.61
  assert.equal(carbonNov.costUSD, 0.61);

  const carbonDec = calculateRequestApiCost({
    responseModel: 'gemini-4-carbon',
    inputTokens: 250000,
    cacheReadTokens: 100000,
    outputTokens: 10000,
    date: '2026-12-01'
  });
  assert.equal(carbonDec.isPriced, true);
  assert.equal(carbonDec.modelKey, 'gemini-4-carbon');
  assert.equal(carbonDec.costUSD, 1.22);

  // 2. Claude Opus 5.5 ($4 / $20 / $0.20) & Claude Sonnet 5.5 ($2 / $10 / $0.10)
  const opus = calculateRequestApiCost({
    model: 'Claude Opus 5.5 (Medium)',
    inputTokens: 300000,
    cacheReadTokens: 100000,
    outputTokens: 5000,
    date: '2026-11-12'
  });
  assert.equal(opus.isPriced, true);
  assert.equal(opus.modelKey, 'claude-opus-5-5');
  // (0.3 * 4.0 + 0.1 * 0.20 + 0.005 * 20.0) = 1.20 + 0.02 + 0.10 = 1.32
  assert.equal(opus.costUSD, 1.32);

  const sonnet = calculateRequestApiCost({
    model: 'claude-sonnet-5-5-high',
    inputTokens: 300000,
    cacheReadTokens: 100000,
    outputTokens: 5000,
    date: '2026-11-12'
  });
  assert.equal(sonnet.isPriced, true);
  assert.equal(sonnet.modelKey, 'claude-sonnet-5-5');
  assert.equal(sonnet.costUSD, 0.66);

  // 3. GPT-OSS 120B 保持未计价（无单一官方费率，绝不编造 $0）
  const gptOss = calculateRequestApiCost({
    model: 'GPT-OSS 120B (Medium)',
    inputTokens: 10000,
    outputTokens: 1000,
    date: '2026-11-12'
  });
  assert.equal(gptOss.isPriced, false);
  assert.equal(gptOss.modelKey, null);

  // 4. Gemini 4 Carbon 配额池匹配（支持裸 responseModel 与具体档位 label）
  const configs = [
    { modelId: 'gemini-4-carbon-high', label: 'Gemini 4 Carbon (High)', quotaInfo: { remainingFraction: 0.894, resetTime: '2026-11-12T05:03:08Z' } }
  ];
  const quota = resolveModelQuota('gemini-4-carbon', configs);
  assert.ok(quota);
  assert.equal(quota.poolKey, 'gemini-4-carbon');
  assert.equal(quota.poolName, 'Gemini 4 Carbon 配额池');
  assert.equal(quota.remainingFraction, 0.894);

  // 5. parseGeneratorCall 持久化 stepIndex、totalTokens 并统一 extractCallId 优先级
  const parsed = parseGeneratorCall({
    stepIndices: [5, 6],
    callId: 'lower-priority-call-id',
    chatModel: {
      modelDisplayName: 'Gemini 4 Carbon (High)',
      responseModel: 'gemini-4-carbon',
      usage: {
        inputTokens: '2000',
        cacheReadTokens: '3000',
        outputTokens: '500',
        responseId: 'Lzj1atubDv'
      }
    }
  }, '929f8a67-2f81-47e0-bf59-2f7af9aefcaf', 'desktop');
  assert.equal(parsed.callId, 'Lzj1atubDv');
  assert.equal(extractCallId({ callId: 'lower-priority-call-id', chatModel: { usage: { responseId: 'Lzj1atubDv' } } }), 'Lzj1atubDv');
  assert.equal(parsed.stepIndex, 5);
  assert.equal(parsed.totalTokens, 5500);
  assert.equal(parsed.isPriced, true);
});

test('collectTokenHistoryAsync default branch (!options.agDir) clears activeScanPromise and refreshes after 15s TTL', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const tempAgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-default-branch-'));
  const tempCliDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-default-cli-'));
  const prevAgDir = process.env.AG_DIR;
  const prevAgCliDir = process.env.AG_CLI_DIR;
  const realDateNow = Date.now;
  let fakeNow = realDateNow.call(Date) + 120000;

  try {
    process.env.AG_DIR = tempAgDir;
    process.env.AG_CLI_DIR = tempCliDir;
    Date.now = () => fakeNow;

    const convUuid = 'aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb';
    const logDir = path.join(tempAgDir, 'brain', convUuid, '.system_generated', 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    const transcriptPath = path.join(logDir, 'transcript.jsonl');
    const nowIso = new Date().toISOString();

    fs.writeFileSync(
      transcriptPath,
      JSON.stringify({
        step_index: 2,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: nowIso,
        input_tokens: 1000,
        cache_read_tokens: 500,
        output_tokens: 200
      }) + '\n',
      'utf8'
    );

    const mockUserStatus = { userTier: { name: 'Pro' }, planStatus: { availablePromptCredits: 500 } };
    // 先用 force: true 初始化全局默认分支基准缓存，随后走真实 !options.force && !options.agDir 路径
    const r1 = await collectTokenHistoryAsync({ force: true, userStatus: mockUserStatus });
    assert.equal(r1.summary.grandTotalTokens, 1700);

    // 追加新一轮 PLANNER_RESPONSE 步骤
    fs.appendFileSync(
      transcriptPath,
      JSON.stringify({
        step_index: 5,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: nowIso,
        input_tokens: 3000,
        cache_read_tokens: 1000,
        output_tokens: 400
      }) + '\n',
      'utf8'
    );

    // TTL 15s 内：force: false 返回内存缓存
    fakeNow += 5000;
    const rWithinTtl = await collectTokenHistoryAsync({ force: false, userStatus: mockUserStatus });
    assert.equal(rWithinTtl.summary.grandTotalTokens, 1700);

    // 跨过 15s TTL（+16000ms）：force: false 必须释放已完成的 activeScanPromise 并重扫出最新 6100 tokens！
    fakeNow += 12000;
    const rAfterTtl = await collectTokenHistoryAsync({ force: false, userStatus: mockUserStatus });
    assert.equal(rAfterTtl.summary.grandTotalTokens, 6100);
    assert.equal(rAfterTtl.summary.todayTokens, 6100);
  } finally {
    Date.now = realDateNow;
    if (prevAgDir === undefined) delete process.env.AG_DIR;
    else process.env.AG_DIR = prevAgDir;
    if (prevAgCliDir === undefined) delete process.env.AG_CLI_DIR;
    else process.env.AG_CLI_DIR = prevAgCliDir;
    fs.rmSync(tempAgDir, { recursive: true, force: true });
    fs.rmSync(tempCliDir, { recursive: true, force: true });
  }
});

test('ledger & transcript alignment: zero double-counting of unpriced/priced calls across All, Desktop, Cli, and CurrentMonth', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { savePricingLedger, formatLocalDateKey } = require('./meter-collector');

  const tempAgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-align-ag-'));
  const tempCliDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-align-cli-'));
  try {
    const now = new Date();
    const todayIso = now.toISOString();
    const todayLocal = formatLocalDateKey(now);
    const cid = '929f8a67-2f81-47e0-bf59-2f7af9aefcaf';

    // 构造真实 2.31.2 账本：
    // 1) 100-token 未计价请求 (GPT-OSS 120B, legacy 无 stepIndex, callId=responseId) -> 仅计 100 unpriced (绝不翻倍为 200)
    // 2) 100-token 未计价请求 (共享显式 callId) -> 仅计 100 unpriced (绝不翻倍为 200)
    // 3) 1000-token 历史 Gemini 4 Carbon 请求 (磁盘旧状态 isPriced: false, 含 stepIndex: 6) -> 动态重算为已计价，且不额外计入 missingModel
    savePricingLedger({
      version: '1.0.0',
      updatedAt: todayIso,
      calls: {
        resp_legacy_unpriced_1: {
          callId: 'resp_legacy_unpriced_1',
          source: 'desktop',
          cascadeId: cid,
          model: 'GPT-OSS 120B (Medium)',
          modelKey: null,
          inputTokens: 60,
          cacheTokens: 20,
          cacheReadTokens: 20,
          outputTokens: 20,
          status: 'final',
          isPriced: false,
          costUSD: 0,
          date: todayLocal,
          created_at: todayIso
        },
        shared_unpriced_call_2: {
          callId: 'shared_unpriced_call_2',
          source: 'desktop',
          cascadeId: cid,
          stepIndex: 4,
          model: 'GPT-OSS 120B (Medium)',
          modelKey: null,
          inputTokens: 70,
          cacheTokens: 10,
          cacheReadTokens: 10,
          outputTokens: 20,
          totalTokens: 100,
          status: 'final',
          isPriced: false,
          costUSD: 0,
          date: todayLocal,
          created_at: todayIso
        },
        resp_carbon_retro_3: {
          callId: 'resp_carbon_retro_3',
          source: 'desktop',
          cascadeId: cid,
          stepIndex: 6,
          model: 'Gemini 4 Carbon (High)',
          modelKey: null,
          inputTokens: 500,
          cacheTokens: 300,
          cacheReadTokens: 300,
          outputTokens: 200,
          status: 'final',
          isPriced: false, // 模拟旧版本落盘状态
          costUSD: 0,
          date: todayLocal,
          created_at: todayIso
        }
      }
    }, tempAgDir);

    // 写入对应真实无 model、无 responseId 的桌面端 transcript.jsonl + 1 条未入账的 50-token 历史步骤
    const deskLogDir = path.join(tempAgDir, 'brain', cid, '.system_generated', 'logs');
    fs.mkdirSync(deskLogDir, { recursive: true });
    const deskLines = [
      // 匹配 resp_legacy_unpriced_1 (Pass 2: 用量指纹 60/20/20 = 100 tok)
      { step_index: 2, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: todayIso, input_tokens: 60, cache_read_tokens: 20, output_tokens: 20 },
      // 匹配 shared_unpriced_call_2 (Pass 1: callId / stepIndex 4 = 100 tok)
      { step_index: 4, callId: 'shared_unpriced_call_2', source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: todayIso, input_tokens: 70, cache_read_tokens: 10, output_tokens: 20 },
      // 匹配 resp_carbon_retro_3 (Pass 1: stepIndex 6 = 1000 tok)
      { step_index: 6, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: todayIso, input_tokens: 500, cache_read_tokens: 300, output_tokens: 200 },
      // 未被账本覆盖的桌面端步骤 (50 tok -> missingModel)
      { step_index: 8, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: todayIso, input_tokens: 30, cache_read_tokens: 10, output_tokens: 10 }
    ];
    fs.writeFileSync(path.join(deskLogDir, 'transcript.jsonl'), deskLines.map(x => JSON.stringify(x)).join('\n') + '\n', 'utf8');

    // 写入 1 条未被账本覆盖的 CLI 步骤 (80 tok -> missingModel)
    const cliLogDir = path.join(tempCliDir, 'brain', 'bbbbbbbb-2222-3333-4444-cccccccccccc', '.system_generated', 'logs');
    fs.mkdirSync(cliLogDir, { recursive: true });
    fs.writeFileSync(
      path.join(cliLogDir, 'transcript.jsonl'),
      JSON.stringify({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: todayIso, input_tokens: 50, cache_read_tokens: 10, output_tokens: 20 }) + '\n',
      'utf8'
    );

    const data = await collectTokenHistoryAsync({
      force: true,
      agDir: tempAgDir,
      agCliDir: tempCliDir,
      userStatus: { userTier: { name: 'Pro' }, planStatus: { availablePromptCredits: 500 } }
    });

    // 桌面端：1 条已计价 (1000 tok)，3 条未计价 = 2 条账本 GPT-OSS (100+100=200 tok, unsupportedModel: 2) + 1 条未匹配步骤 (50 tok, missingModel: 1) => 250 tok (绝非 450/1450!)
    const desk = data.costEstimateBySource.desktop;
    assert.equal(desk.pricedRequestsCount, 1);
    assert.equal(desk.pricedTokens, 1000);
    assert.equal(desk.unpricedRequestsCount, 3);
    assert.equal(desk.unpricedTokens, 250);
    assert.equal(desk.unpricedReasons.unsupportedModel, 2);
    assert.equal(desk.unpricedReasons.missingModel, 1);

    // CLI 端：0 条已计价，1 条未计价 (80 tok, missingModel: 1)
    const cli = data.costEstimateBySource.cli;
    assert.equal(cli.pricedRequestsCount, 0);
    assert.equal(cli.unpricedRequestsCount, 1);
    assert.equal(cli.unpricedTokens, 80);
    assert.equal(cli.unpricedReasons.missingModel, 1);

    // 全量 (All) 与 本期自然月 (CurrentMonth) 完全一致且零双计：已计价 1000 tok，未计价 250 + 80 = 330 tok
    for (const summary of [data.costEstimate, data.costEstimateCurrentMonth]) {
      assert.equal(summary.pricedRequestsCount, 1);
      assert.equal(summary.pricedTokens, 1000);
      assert.equal(summary.unpricedRequestsCount, 4);
      assert.equal(summary.unpricedTokens, 330);
      assert.equal(summary.unpricedReasons.unsupportedModel, 2);
      assert.equal(summary.unpricedReasons.missingModel, 2);
    }

    // 混合模式残差同样精确等于 330 未计价 tokens
    assert.equal(data.referenceCost.hybrid.hybrid.unpricedResidualTokens, 330);
    assert.equal(data.referenceCost.currentMonthHybrid.hybrid.unpricedResidualTokens, 330);
  } finally {
    fs.rmSync(tempAgDir, { recursive: true, force: true });
    fs.rmSync(tempCliDir, { recursive: true, force: true });
  }
});

test('RPC responseId + model-bearing transcript cascadeId#stepIndex never double-prices in [RPC -> Scan] or [Scan -> RPC] orders', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { recordModelCalls, loadPricingLedger, formatLocalDateKey } = require('./meter-collector');

  const now = new Date();
  const todayIso = now.toISOString();
  const todayLocal = formatLocalDateKey(now);
  const mockUserStatus = { userTier: { name: 'Pro' }, planStatus: { availablePromptCredits: 500 } };

  // 场景 A: [RPC -> Scan] 顺序（账本已有 responseId 100 tok，随后扫描带 model 且无 responseId 的 transcript cascadeId#stepIndex）
  const agDirA = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-rpc-then-scan-'));
  const cliDirA = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-rpc-then-scan-cli-'));
  try {
    const cidA = '11111111-2222-3333-4444-555555555555';
    const rpcCall = parseGeneratorCall({
      created_at: todayIso,
      stepIndices: [3],
      chatModel: {
        modelDisplayName: 'Gemini 4 Carbon (High)',
        responseModel: 'gemini-4-carbon',
        usage: { inputTokens: 60, cacheReadTokens: 20, outputTokens: 20, responseId: 'resp_rpc_first_100' }
      }
    }, cidA, 'desktop');
    recordModelCalls([rpcCall], { agDir: agDirA });

    const logDirA = path.join(agDirA, 'brain', cidA, '.system_generated', 'logs');
    fs.mkdirSync(logDirA, { recursive: true });
    fs.writeFileSync(
      path.join(logDirA, 'transcript.jsonl'),
      JSON.stringify({
        step_index: 3,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: todayIso,
        model: 'Gemini 4 Carbon (High)',
        input_tokens: 60,
        cache_read_tokens: 20,
        output_tokens: 20
      }) + '\n',
      'utf8'
    );

    const resA = await collectTokenHistoryAsync({ force: true, agDir: agDirA, agCliDir: cliDirA, userStatus: mockUserStatus });
    const ledgerKeysA = Object.keys(loadPricingLedger(agDirA).calls || {});
    assert.deepEqual(ledgerKeysA, ['resp_rpc_first_100']);
    assert.equal(resA.costEstimate.pricedRequestsCount, 1);
    assert.equal(resA.costEstimate.pricedTokens, 100);
    assert.equal(resA.costEstimate.unpricedRequestsCount, 0);
    assert.equal(resA.costEstimate.unpricedTokens, 0);
    assert.equal(resA.costEstimateCurrentMonth.pricedRequestsCount, 1);
    assert.equal(resA.costEstimateCurrentMonth.pricedTokens, 100);
  } finally {
    fs.rmSync(agDirA, { recursive: true, force: true });
    fs.rmSync(cliDirA, { recursive: true, force: true });
  }

  // 场景 B: [Scan -> RPC] 顺序（扫描先写入 cascadeId#stepIndex 100 tok，随后 RPC 写入真实 responseId 100 tok）
  const agDirB = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-scan-then-rpc-'));
  const cliDirB = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-scan-then-rpc-cli-'));
  try {
    const cidB = '66666666-7777-8888-9999-aaaaaaaaaaaa';
    const logDirB = path.join(agDirB, 'brain', cidB, '.system_generated', 'logs');
    fs.mkdirSync(logDirB, { recursive: true });
    fs.writeFileSync(
      path.join(logDirB, 'transcript.jsonl'),
      JSON.stringify({
        step_index: 3,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: todayIso,
        model: 'Gemini 4 Carbon (High)',
        input_tokens: 60,
        cache_read_tokens: 20,
        output_tokens: 20
      }) + '\n',
      'utf8'
    );

    const resBeforeRpc = await collectTokenHistoryAsync({ force: true, agDir: agDirB, agCliDir: cliDirB, userStatus: mockUserStatus });
    assert.deepEqual(Object.keys(loadPricingLedger(agDirB).calls || {}), [`${cidB}#3`]);
    assert.equal(resBeforeRpc.costEstimate.pricedRequestsCount, 1);
    assert.equal(resBeforeRpc.costEstimate.pricedTokens, 100);

    const rpcCallLater = parseGeneratorCall({
      created_at: todayIso,
      stepIndices: [3],
      chatModel: {
        modelDisplayName: 'Gemini 4 Carbon (High)',
        responseModel: 'gemini-4-carbon',
        usage: { inputTokens: 60, cacheReadTokens: 20, outputTokens: 20, responseId: 'resp_rpc_after_scan_100' }
      }
    }, cidB, 'desktop');
    recordModelCalls([rpcCallLater], { agDir: agDirB });

    // 合成键已原地迁移为真实 responseId，且再次传入合成键绝不重复新增
    assert.deepEqual(Object.keys(loadPricingLedger(agDirB).calls || {}), ['resp_rpc_after_scan_100']);
    recordModelCalls([{
      callId: `${cidB}#3`,
      source: 'desktop',
      cascadeId: cidB,
      stepIndex: 3,
      model: 'Gemini 4 Carbon (High)',
      modelKey: 'gemini-4-carbon',
      inputTokens: 60,
      cacheTokens: 20,
      outputTokens: 20,
      totalTokens: 100,
      status: 'final',
      isPriced: true,
      costUSD: rpcCallLater.costUSD,
      date: todayLocal
    }], { agDir: agDirB });
    assert.deepEqual(Object.keys(loadPricingLedger(agDirB).calls || {}), ['resp_rpc_after_scan_100']);

    const resAfterRpc = await collectTokenHistoryAsync({ force: true, agDir: agDirB, agCliDir: cliDirB, userStatus: mockUserStatus });
    assert.equal(resAfterRpc.costEstimate.pricedRequestsCount, 1);
    assert.equal(resAfterRpc.costEstimate.pricedTokens, 100);
    assert.equal(resAfterRpc.costEstimate.unpricedRequestsCount, 0);
    assert.equal(resAfterRpc.costEstimate.unpricedTokens, 0);
    assert.equal(resAfterRpc.costEstimateCurrentMonth.pricedRequestsCount, 1);
    assert.equal(resAfterRpc.costEstimateCurrentMonth.pricedTokens, 100);
  } finally {
    fs.rmSync(agDirB, { recursive: true, force: true });
    fs.rmSync(cliDirB, { recursive: true, force: true });
  }
});

test('v2 archive-only usage (200 archived tokens + 100 priced ledger tokens) reports 100 unpriced tokens and 50% coverage in monthly and all-time', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { savePricingLedger, formatLocalDateKey } = require('./meter-collector');

  const tempAgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-v2-archive-cov-'));
  const tempCliDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-v2-archive-cli-'));
  try {
    const now = new Date();
    const todayIso = now.toISOString();
    const todayLocal = formatLocalDateKey(now);

    // 仅存在 v2 归档（200 tokens, 2 steps），无任何实时 transcript.jsonl
    fs.writeFileSync(path.join(tempAgDir, 'token_usage_archive_v2.json'), JSON.stringify({
      version: '2.0.0',
      firstUseDate: todayLocal,
      updatedAt: `${todayLocal} 09:00:00`,
      maxConversations: 2,
      dailyMapBySource: {
        desktop: {
          [todayLocal]: { total: 200, input: 120, cache: 40, output: 40, steps: 2 }
        },
        cli: {}
      }
    }, null, 2), 'utf8');

    // 账本中仅有 1 条 100-token 已计价记录
    savePricingLedger({
      version: '1.0.0',
      updatedAt: todayIso,
      calls: {
        resp_archived_100: {
          callId: 'resp_archived_100',
          source: 'desktop',
          cascadeId: '27c2de70-1111-2222-3333-444444444444',
          stepIndex: 1,
          model: 'Gemini 4 Carbon (High)',
          modelKey: 'gemini-4-carbon',
          inputTokens: 60,
          cacheTokens: 20,
          cacheReadTokens: 20,
          outputTokens: 20,
          totalTokens: 100,
          status: 'final',
          isPriced: true,
          costUSD: 0.000322,
          date: todayLocal,
          created_at: todayIso
        }
      }
    }, tempAgDir);

    const data = await collectTokenHistoryAsync({
      force: true,
      agDir: tempAgDir,
      agCliDir: tempCliDir,
      userStatus: { userTier: { name: 'Pro' }, planStatus: { availablePromptCredits: 500 } }
    });

    assert.equal(data.summary.grandTotalTokens, 200);
    assert.equal(data.summary.monthTokens, 200);

    for (const summary of [data.costEstimate, data.costEstimateBySource.desktop, data.costEstimateCurrentMonth]) {
      assert.equal(summary.pricedRequestsCount, 1);
      assert.equal(summary.pricedTokens, 100);
      assert.equal(summary.unpricedRequestsCount, 1);
      assert.equal(summary.unpricedTokens, 100);
      assert.equal(summary.tokenCoveragePercent, 50);
      assert.equal(summary.requestCoveragePercent, 50);
      assert.equal(summary.coveragePercent, 50);
      assert.equal(summary.isPartialCoverage, true);
    }

    assert.equal(data.referenceCost.hybrid.hybrid.unpricedResidualTokens, 100);
    assert.equal(data.referenceCost.currentMonthHybrid.hybrid.unpricedResidualTokens, 100);

    // 直接校验 summarizeApiCost 防卫：即便 unpricedRequestsCount === 0，只要 unpricedTokens > 0 也绝不能返回 100%
    const directGuard = summarizeApiCost(
      [{ model: 'Gemini 4 Carbon (High)', inputTokens: 60, cacheTokens: 20, outputTokens: 20, date: '2026-11-12' }],
      0,
      {},
      100
    );
    assert.equal(directGuard.tokenCoveragePercent, 50);
    assert.equal(directGuard.coveragePercent, 50);
    assert.equal(directGuard.isPartialCoverage, true);
  } finally {
    fs.rmSync(tempAgDir, { recursive: true, force: true });
    fs.rmSync(tempCliDir, { recursive: true, force: true });
  }
});

test('Claude 5 vs Claude 5.5 strict alias matching: claude-opus-5 and claude-sonnet-5 stay unpriced while 5.5 is priced', () => {
  const { normalizeModelId } = require('./meter-core');

  // 非 5.5 的 Claude 5 系列变体必须保持 null（未计价），绝不误归入 5.5 费率
  for (const unpricedRaw of [
    'claude-opus-5',
    'claude-opus-5-20260514',
    'claude-opus-5-0',
    'Claude Opus 5',
    'claude-opus-5-50',
    'claude-sonnet-5',
    'claude-sonnet-5-20260514',
    'claude-sonnet-5-0',
    'Claude Sonnet 5'
  ]) {
    assert.equal(normalizeModelId(unpricedRaw), null, `expected ${unpricedRaw} to remain unnormalized`);
    const calc = calculateRequestApiCost({ model: unpricedRaw, inputTokens: 10000, outputTokens: 1000, date: '2026-11-12' });
    assert.equal(calc.isPriced, false, `expected ${unpricedRaw} to stay unpriced`);
  }

  // 明确的 5.5 / 5-5 变体正常识别计价
  for (const [raw55, expectedKey] of [
    ['claude-opus-5-5', 'claude-opus-5-5'],
    ['Claude Opus 5.5 (Thinking)', 'claude-opus-5-5'],
    ['claude-opus-5.5-20261101', 'claude-opus-5-5'],
    ['claude-sonnet-5-5', 'claude-sonnet-5-5'],
    ['Claude Sonnet 5.5 (High)', 'claude-sonnet-5-5'],
    ['claude-sonnet-5.5-20261101', 'claude-sonnet-5-5']
  ]) {
    assert.equal(normalizeModelId(raw55), expectedKey, `expected ${raw55} -> ${expectedKey}`);
    const calc = calculateRequestApiCost({ model: raw55, inputTokens: 10000, outputTokens: 1000, date: '2026-11-12' });
    assert.equal(calc.isPriced, true, `expected ${raw55} to be priced`);
  }
});

test('two distinct real responseId calls in the same step (100 + 120 = 220 tokens) are both preserved without merging', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { recordModelCalls, loadPricingLedger } = require('./meter-collector');

  const nowIso = new Date().toISOString();
  const mockUserStatus = { userTier: { name: 'Pro' }, planStatus: { availablePromptCredits: 500 } };
  const agDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-same-step-two-real-'));
  const cliDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-same-step-two-real-cli-'));

  try {
    const cid = '33333333-4444-5555-6666-777777777777';
    // 先模拟扫描产生合成键 cid#3 (100 tok)，再写入同步骤两条独立真实 responseId (100 + 120 = 220 tok)
    const logDir = path.join(agDir, 'brain', cid, '.system_generated', 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(
      path.join(logDir, 'transcript.jsonl'),
      [
        {
          step_index: 3,
          callId: 'resp_step3_call_a',
          source: 'MODEL',
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          created_at: nowIso,
          input_tokens: 60,
          cache_read_tokens: 20,
          output_tokens: 20
        },
        {
          step_index: 3,
          callId: 'resp_step3_call_b',
          source: 'MODEL',
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          created_at: nowIso,
          input_tokens: 70,
          cache_read_tokens: 20,
          output_tokens: 30
        }
      ].map(x => JSON.stringify(x)).join('\n') + '\n',
      'utf8'
    );

    const callA = parseGeneratorCall({
      created_at: nowIso,
      stepIndices: [3],
      chatModel: {
        modelDisplayName: 'Gemini 4 Carbon (High)',
        responseModel: 'gemini-4-carbon',
        usage: { inputTokens: 60, cacheReadTokens: 20, outputTokens: 20, responseId: 'resp_step3_call_a' }
      }
    }, cid, 'desktop');
    const callB = parseGeneratorCall({
      created_at: nowIso,
      stepIndices: [3],
      chatModel: {
        modelDisplayName: 'Gemini 4 Carbon (High)',
        responseModel: 'gemini-4-carbon',
        usage: { inputTokens: 70, cacheReadTokens: 20, outputTokens: 30, responseId: 'resp_step3_call_b' }
      }
    }, cid, 'desktop');

    // 先插入一条合成兜底键，验证第一条真实 ID 升级合成键后，第二条同步骤真实 ID 绝不吞并第一条真实 ID
    recordModelCalls([{
      ...callA,
      callId: `${cid}#3`
    }], { agDir });
    recordModelCalls([callA, callB], { agDir });

    const callsMap = loadPricingLedger(agDir).calls || {};
    assert.deepEqual(Object.keys(callsMap).sort(), ['resp_step3_call_a', 'resp_step3_call_b']);
    assert.equal(callsMap.resp_step3_call_a.totalTokens, 100);
    assert.equal(callsMap.resp_step3_call_b.totalTokens, 120);

    const scanRes = await collectTokenHistoryAsync({ force: true, agDir, agCliDir: cliDir, userStatus: mockUserStatus });
    assert.equal(scanRes.costEstimate.pricedRequestsCount, 2);
    assert.equal(scanRes.costEstimate.pricedTokens, 220);
    assert.equal(scanRes.costEstimate.unpricedRequestsCount, 0);
    assert.equal(scanRes.costEstimate.unpricedTokens, 0);
  } finally {
    fs.rmSync(agDir, { recursive: true, force: true });
    fs.rmSync(cliDir, { recursive: true, force: true });
  }
});

test('pre-seeded duplicate (responseId, cascadeId#stepIndex) reconciles to 100 priced tokens on read and cleans up synthetic key on write', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { recordModelCalls, loadPricingLedger, formatLocalDateKey } = require('./meter-collector');

  const now = new Date();
  const todayIso = now.toISOString();
  const todayLocal = formatLocalDateKey(now);
  const mockUserStatus = { userTier: { name: 'Pro' }, planStatus: { availablePromptCredits: 500 } };

  for (const includeStepOnReal of [true, false]) {
    const agDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-preseed-dup-'));
    const cliDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-preseed-dup-cli-'));
    try {
      const cid = '88888888-9999-aaaa-bbbb-cccccccccccc';
      const ledgerPath = path.join(agDir, 'pricing_ledger_v1.json');

      // 预置旧版遗留双键：真实 responseId (含或不含 stepIndex) + 合成键 cid#4 (均为 100 tokens)
      const realEntry = {
        callId: 'resp_preseeded_100',
        source: 'desktop',
        cascadeId: cid,
        ...(includeStepOnReal ? { stepIndex: 4 } : {}),
        model: 'Gemini 4 Carbon (High)',
        modelKey: 'gemini-4-carbon',
        inputTokens: 60,
        cacheTokens: 20,
        cacheReadTokens: 20,
        outputTokens: 20,
        totalTokens: 100,
        status: 'final',
        isPriced: true,
        costUSD: 0.000322,
        date: todayLocal,
        created_at: todayIso
      };
      const synEntry = {
        ...realEntry,
        callId: `${cid}#4`,
        stepIndex: 4
      };
      fs.writeFileSync(ledgerPath, JSON.stringify({
        version: '1.0.0',
        updatedAt: todayIso,
        calls: {
          resp_preseeded_100: realEntry,
          [`${cid}#4`]: synEntry
        }
      }, null, 2), 'utf8');

      const logDir = path.join(agDir, 'brain', cid, '.system_generated', 'logs');
      fs.mkdirSync(logDir, { recursive: true });
      fs.writeFileSync(
        path.join(logDir, 'transcript.jsonl'),
        JSON.stringify({
          step_index: 4,
          source: 'MODEL',
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          created_at: todayIso,
          model: 'Gemini 4 Carbon (High)',
          input_tokens: 60,
          cache_read_tokens: 20,
          output_tokens: 20
        }) + '\n',
        'utf8'
      );

      // 1) 纯读取路径不改写磁盘，但内存态立即消解为单条 100 tokens（绝不翻倍为 200）
      const memBeforeWrite = loadPricingLedger(agDir);
      assert.deepEqual(Object.keys(memBeforeWrite.calls), ['resp_preseeded_100']);
      assert.equal(memBeforeWrite.calls.resp_preseeded_100.stepIndex, 4);
      const rawDiskBeforeWrite = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
      assert.equal(Object.keys(rawDiskBeforeWrite.calls).length, 2, 'pure loadPricingLedger read must not mutate disk');

      const scanRes = await collectTokenHistoryAsync({ force: true, agDir, agCliDir: cliDir, userStatus: mockUserStatus });
      assert.equal(scanRes.costEstimate.pricedRequestsCount, 1);
      assert.equal(scanRes.costEstimate.pricedTokens, 100);
      assert.equal(scanRes.costEstimate.unpricedRequestsCount, 0);
      assert.equal(scanRes.costEstimate.unpricedTokens, 0);

      // 2) 再次以真实 responseId 调用 recordModelCalls 时，磁盘上的遗留合成键被彻底清除并持久化
      const recRes = recordModelCalls([realEntry], { agDir });
      assert.equal(recRes.ok, true);
      const rawDiskAfterWrite = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
      assert.deepEqual(Object.keys(rawDiskAfterWrite.calls), ['resp_preseeded_100']);
      assert.equal(rawDiskAfterWrite.calls.resp_preseeded_100.stepIndex, 4);
      assert.equal(rawDiskAfterWrite.__hadDuplicateStepKeys, undefined);
    } finally {
      fs.rmSync(agDir, { recursive: true, force: true });
      fs.rmSync(cliDir, { recursive: true, force: true });
    }
  }
});

test('matched transcript with richer model and 120 tokens enriches model-less 100-token ledger entry into 1 priced call of 120 tokens', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { savePricingLedger, loadPricingLedger, recordModelCalls, formatLocalDateKey } = require('./meter-collector');

  const now = new Date();
  const todayIso = now.toISOString();
  const todayLocal = formatLocalDateKey(now);
  const mockUserStatus = { userTier: { name: 'Pro' }, planStatus: { availablePromptCredits: 500 } };

  const agDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-enrich-ledger-'));
  const cliDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-enrich-cli-'));
  try {
    const cid = 'dddddddd-eeee-4444-8888-ffffffffffff';

    // 账本已有 { callId: "x", model: "", 100 tokens }（未计价）
    savePricingLedger({
      version: '1.0.0',
      updatedAt: todayIso,
      calls: {
        x: {
          callId: 'x',
          source: 'desktop',
          cascadeId: cid,
          model: '',
          modelKey: null,
          inputTokens: 60,
          cacheTokens: 20,
          cacheReadTokens: 20,
          outputTokens: 20,
          totalTokens: 100,
          status: 'final',
          isPriced: false,
          costUSD: 0,
          date: todayLocal,
          created_at: todayIso
        }
      }
    }, agDir);

    // transcript 含同一 callId: "x"、完整 model: "Gemini 4 Carbon" 与更新的 120 tokens
    const logDir = path.join(agDir, 'brain', cid, '.system_generated', 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(
      path.join(logDir, 'transcript.jsonl'),
      JSON.stringify({
        step_index: 2,
        callId: 'x',
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: todayIso,
        model: 'Gemini 4 Carbon',
        input_tokens: 70,
        cache_read_tokens: 20,
        output_tokens: 30
      }) + '\n',
      'utf8'
    );

    const res = await collectTokenHistoryAsync({ force: true, agDir, agCliDir: cliDir, userStatus: mockUserStatus });
    const updatedCalls = loadPricingLedger(agDir).calls || {};
    assert.deepEqual(Object.keys(updatedCalls), ['x']);
    assert.equal(updatedCalls.x.model, 'Gemini 4 Carbon');
    assert.equal(updatedCalls.x.totalTokens, 120);
    assert.equal(updatedCalls.x.isPriced, true);

    assert.equal(res.costEstimate.pricedRequestsCount, 1);
    assert.equal(res.costEstimate.pricedTokens, 120);
    assert.equal(res.costEstimate.unpricedRequestsCount, 0);
    assert.equal(res.costEstimate.unpricedTokens, 0);
    assert.equal(res.costEstimateCurrentMonth.pricedRequestsCount, 1);
    assert.equal(res.costEstimateCurrentMonth.pricedTokens, 120);

    // 反向防回退校验：若账本已有 120 tokens (缺 model) 而后到记录含 model 但仅 100 tokens，必须补齐 model 且保留 120 tokens
    recordModelCalls([{
      callId: 'y',
      source: 'desktop',
      cascadeId: cid,
      stepIndex: 5,
      model: '',
      inputTokens: 70,
      cacheTokens: 20,
      outputTokens: 30,
      status: 'final',
      isPriced: false,
      costUSD: 0,
      date: todayLocal
    }], { agDir });
    recordModelCalls([{
      callId: 'y',
      source: 'desktop',
      cascadeId: cid,
      stepIndex: 5,
      model: 'Gemini 4 Carbon',
      inputTokens: 60,
      cacheTokens: 20,
      outputTokens: 20,
      status: 'final',
      isPriced: true,
      costUSD: 0.000322,
      date: todayLocal
    }], { agDir });
    const entryY = loadPricingLedger(agDir).calls.y;
    assert.equal(entryY.model, 'Gemini 4 Carbon');
    assert.equal(entryY.totalTokens, 120);
    assert.equal(entryY.outputTokens, 30);
    assert.equal(entryY.isPriced, true);
  } finally {
    fs.rmSync(agDir, { recursive: true, force: true });
    fs.rmSync(cliDir, { recursive: true, force: true });
  }
});

test('order-independent synthetic-key migration & insufficient-evidence preservation (120-tok synthetic + [real_100, real_120] / sequential / [real_80, real_100])', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { recordModelCalls, loadPricingLedger } = require('./meter-collector');

  const nowIso = new Date().toISOString();
  const mockUserStatus = { userTier: { name: 'Pro' }, planStatus: { availablePromptCredits: 500 } };
  const cid = 'conv1-4444-5555-6666-777777777777';

  const makeRpcCall = (responseId, inp, cap, out) => parseGeneratorCall({
    created_at: nowIso,
    stepIndices: [5],
    chatModel: {
      modelDisplayName: 'Gemini 4 Carbon (High)',
      responseModel: 'gemini-4-carbon',
      usage: { inputTokens: inp, cacheReadTokens: cap, outputTokens: out, responseId }
    }
  }, cid, 'desktop');

  const real80 = makeRpcCall('resp_80', 50, 10, 20);
  const real100 = makeRpcCall('resp_100', 60, 20, 20);
  const real120 = makeRpcCall('resp_120', 70, 20, 30);
  const syn120 = { ...real120, callId: `${cid}#5` };

  const writeTranscript120 = (agDir) => {
    const logDir = path.join(agDir, 'brain', cid, '.system_generated', 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(
      path.join(logDir, 'transcript.jsonl'),
      JSON.stringify({
        step_index: 5,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: nowIso,
        model: 'Gemini 4 Carbon (High)',
        input_tokens: 70,
        cache_read_tokens: 20,
        output_tokens: 30
      }) + '\n',
      'utf8'
    );
  };

  // 1) & 2) 单批次两种排列顺序：[real_100, real_120] 与 [real_120, real_100] 均精确得到 220 tokens (绝非 240)
  for (const batchOrder of [[real100, real120], [real120, real100]]) {
    const agDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-order-indep-batch-'));
    const cliDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-order-indep-cli-'));
    try {
      writeTranscript120(agDir);
      recordModelCalls([syn120], { agDir });
      recordModelCalls(batchOrder, { agDir });

      const calls = loadPricingLedger(agDir).calls || {};
      assert.deepEqual(Object.keys(calls).sort(), ['resp_100', 'resp_120']);
      assert.equal(calls.resp_100.totalTokens, 100);
      assert.equal(calls.resp_120.totalTokens, 120);

      const scan = await collectTokenHistoryAsync({ force: true, agDir, agCliDir: cliDir, userStatus: mockUserStatus });
      assert.equal(scan.costEstimate.pricedRequestsCount, 2);
      assert.equal(scan.costEstimate.pricedTokens, 220);
      assert.equal(scan.costEstimate.unpricedTokens, 0);
    } finally {
      fs.rmSync(agDir, { recursive: true, force: true });
      fs.rmSync(cliDir, { recursive: true, force: true });
    }
  }

  // 3) 分批先后到达：先有 120-tok 合成记录 -> 先仅到达 real_100 (中间态保留 resp_100 + conv1#5 = 220 tok) -> 重扫仍为 220 tok -> 后到达 real_120 (消解为 resp_100 + resp_120 = 220 tok)
  const agSeq = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-order-indep-seq-'));
  const cliSeq = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-order-indep-seq-cli-'));
  try {
    writeTranscript120(agSeq);
    const scanInitial = await collectTokenHistoryAsync({ force: true, agDir: agSeq, agCliDir: cliSeq, userStatus: mockUserStatus });
    assert.deepEqual(Object.keys(loadPricingLedger(agSeq).calls || {}), [`${cid}#5`]);
    assert.equal(scanInitial.costEstimate.pricedTokens, 120);

    // real_100 先到达：由于两者均为已完结且含模型、用量 100 !== 120，证据不足绝不误合并，保持 100 + 120 = 220
    recordModelCalls([real100], { agDir: agSeq });
    const midCalls = loadPricingLedger(agSeq).calls || {};
    assert.deepEqual(Object.keys(midCalls).sort(), [`${cid}#5`, 'resp_100']);
    assert.equal(midCalls.resp_100.totalTokens, 100);
    assert.equal(midCalls[`${cid}#5`].totalTokens, 120);

    const scanMid = await collectTokenHistoryAsync({ force: true, agDir: agSeq, agCliDir: cliSeq, userStatus: mockUserStatus });
    assert.equal(scanMid.costEstimate.pricedRequestsCount, 2);
    assert.equal(scanMid.costEstimate.pricedTokens, 220);
    assert.equal(scanMid.costEstimate.unpricedTokens, 0);

    // real_120 随后到达：精确匹配 120-tok 合成键并完成迁移，最终仅保留 resp_100 + resp_120 = 220
    recordModelCalls([real120], { agDir: agSeq });
    const finalCalls = loadPricingLedger(agSeq).calls || {};
    assert.deepEqual(Object.keys(finalCalls).sort(), ['resp_100', 'resp_120']);
    assert.equal(finalCalls.resp_100.totalTokens, 100);
    assert.equal(finalCalls.resp_120.totalTokens, 120);

    const scanFinal = await collectTokenHistoryAsync({ force: true, agDir: agSeq, agCliDir: cliSeq, userStatus: mockUserStatus });
    assert.equal(scanFinal.costEstimate.pricedRequestsCount, 2);
    assert.equal(scanFinal.costEstimate.pricedTokens, 220);
  } finally {
    fs.rmSync(agSeq, { recursive: true, force: true });
    fs.rmSync(cliSeq, { recursive: true, force: true });
  }

  // 4) 证据不足保护：合成键 120 tok，RPC 返回 [real_80, real_100]（均不等于 120）-> 三条记录全部保留 (80 + 100 + 120 = 300 tokens)
  const agInsuf = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-order-indep-insuf-'));
  const cliInsuf = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-order-indep-insuf-cli-'));
  try {
    writeTranscript120(agInsuf);
    recordModelCalls([syn120], { agDir: agInsuf });
    recordModelCalls([real80, real100], { agDir: agInsuf });

    const calls = loadPricingLedger(agInsuf).calls || {};
    assert.deepEqual(Object.keys(calls).sort(), [`${cid}#5`, 'resp_100', 'resp_80']);
    const scan = await collectTokenHistoryAsync({ force: true, agDir: agInsuf, agCliDir: cliInsuf, userStatus: mockUserStatus });
    assert.equal(scan.costEstimate.pricedRequestsCount, 3);
    assert.equal(scan.costEstimate.pricedTokens, 300);
    assert.equal(scan.costEstimate.unpricedTokens, 0);
  } finally {
    fs.rmSync(agInsuf, { recursive: true, force: true });
    fs.rmSync(cliInsuf, { recursive: true, force: true });
  }
});

test('production model-less transcript.jsonl with 120 tokens never overwrites completed 100-token RPC record at same step (220 priced tokens after resp_120 arrives)', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { recordModelCalls, loadPricingLedger } = require('./meter-collector');

  const nowIso = new Date().toISOString();
  const mockUserStatus = { userTier: { name: 'Pro' }, planStatus: { availablePromptCredits: 500 } };
  const agDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-prod-modelless-guard-'));
  const cliDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-prod-modelless-cli-'));

  try {
    const cid = '99999999-aaaa-4444-8888-eeeeeeeeeeee';
    const resp100 = parseGeneratorCall({
      created_at: nowIso,
      stepIndices: [5],
      chatModel: {
        modelDisplayName: 'Gemini 4 Carbon (High)',
        responseModel: 'gemini-4-carbon',
        usage: { inputTokens: 60, cacheReadTokens: 20, outputTokens: 20, responseId: 'resp_100' }
      }
    }, cid, 'desktop');
    const resp120 = parseGeneratorCall({
      created_at: nowIso,
      stepIndices: [5],
      chatModel: {
        modelDisplayName: 'Gemini 4 Carbon (High)',
        responseModel: 'gemini-4-carbon',
        usage: { inputTokens: 70, cacheReadTokens: 20, outputTokens: 30, responseId: 'resp_120' }
      }
    }, cid, 'desktop');

    // 1) RPC 先写入已完成的 resp_100 (100 tokens, step 5)
    recordModelCalls([resp100], { agDir });

    // 2) 生产格式无 model 的 transcript.jsonl 在 step_index: 5 处有一条已完成 120-token 记录
    const logDir = path.join(agDir, 'brain', cid, '.system_generated', 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(
      path.join(logDir, 'transcript.jsonl'),
      JSON.stringify({
        step_index: 5,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: nowIso,
        input_tokens: 70,
        cache_read_tokens: 20,
        output_tokens: 30
      }) + '\n',
      'utf8'
    );

    const scanBefore120 = await collectTokenHistoryAsync({ force: true, agDir, agCliDir: cliDir, userStatus: mockUserStatus });
    const midCalls = loadPricingLedger(agDir).calls || {};
    assert.deepEqual(Object.keys(midCalls), ['resp_100']);
    assert.equal(midCalls.resp_100.totalTokens, 100, 'completed resp_100 must NOT be overwritten to 120 by model-less transcript');
    assert.equal(scanBefore120.costEstimate.pricedRequestsCount, 1);
    assert.equal(scanBefore120.costEstimate.pricedTokens, 100);
    assert.equal(scanBefore120.costEstimate.unpricedRequestsCount, 1);
    assert.equal(scanBefore120.costEstimate.unpricedTokens, 120);

    // 3) 随后同步骤第二条 RPC 调用 resp_120 (120 tokens, step 5) 到达并重扫 -> 精确得到 220 已计价 tokens (绝非 240)
    recordModelCalls([resp120], { agDir });
    const scanAfter120 = await collectTokenHistoryAsync({ force: true, agDir, agCliDir: cliDir, userStatus: mockUserStatus });
    const finalCalls = loadPricingLedger(agDir).calls || {};
    assert.deepEqual(Object.keys(finalCalls).sort(), ['resp_100', 'resp_120']);
    assert.equal(finalCalls.resp_100.totalTokens, 100);
    assert.equal(finalCalls.resp_120.totalTokens, 120);
    assert.equal(scanAfter120.costEstimate.pricedRequestsCount, 2);
    assert.equal(scanAfter120.costEstimate.pricedTokens, 220);
    assert.equal(scanAfter120.costEstimate.unpricedRequestsCount, 0);
    assert.equal(scanAfter120.costEstimate.unpricedTokens, 0);
  } finally {
    fs.rmSync(agDir, { recursive: true, force: true });
    fs.rmSync(cliDir, { recursive: true, force: true });
  }
});

test('completed zero-output (outputTokens=0, isEstimated=true) RPC call is never cross-key overwritten by 120-token transcript, while same-callId revision updates normally', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { recordModelCalls, loadPricingLedger } = require('./meter-collector');

  const nowIso = new Date().toISOString();
  const mockUserStatus = { userTier: { name: 'Pro' }, planStatus: { availablePromptCredits: 500 } };
  const agDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-zero-out-guard-'));
  const cliDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-zero-out-cli-'));

  try {
    const cid = 'abababab-1234-4444-8888-cdcdcdcdcdcd';

    // 1) parseGeneratorCall 对 outputTokens: 0 的已完成调用设置 status: 'final', isEstimated: true
    const callZeroOut = parseGeneratorCall({
      created_at: nowIso,
      status: 'final',
      stepIndices: [5],
      chatModel: {
        modelDisplayName: 'Gemini 4 Carbon (High)',
        responseModel: 'gemini-4-carbon',
        usage: { inputTokens: 100, cacheReadTokens: 0, outputTokens: 0, responseId: 'resp_zero_out' }
      }
    }, cid, 'desktop');
    assert.equal(callZeroOut.status, 'final');
    assert.equal(callZeroOut.isEstimated, true);
    assert.equal(callZeroOut.totalTokens, 100);

    recordModelCalls([callZeroOut], { agDir });

    // 2) 扫描同步骤 120-token 无模型 transcript.jsonl -> resp_zero_out 保持 100 tokens（100 已计价 + 120 未计价 = 220）
    const logDir = path.join(agDir, 'brain', cid, '.system_generated', 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(
      path.join(logDir, 'transcript.jsonl'),
      JSON.stringify({
        step_index: 5,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: nowIso,
        input_tokens: 90,
        cache_read_tokens: 0,
        output_tokens: 30
      }) + '\n',
      'utf8'
    );

    const scanMid = await collectTokenHistoryAsync({ force: true, agDir, agCliDir: cliDir, userStatus: mockUserStatus });
    const midCalls = loadPricingLedger(agDir).calls || {};
    assert.deepEqual(Object.keys(midCalls), ['resp_zero_out']);
    assert.equal(midCalls.resp_zero_out.totalTokens, 100, 'completed zero-output real call must NOT be cross-key overwritten to 120');
    assert.equal(scanMid.costEstimate.pricedRequestsCount, 1);
    assert.equal(scanMid.costEstimate.pricedTokens, 100);
    assert.equal(scanMid.costEstimate.unpricedRequestsCount, 1);
    assert.equal(scanMid.costEstimate.unpricedTokens, 120);

    // 3) 随后同步骤第二条 RPC 调用 resp_120 (90 + 30 = 120 tokens) 到达并重扫 -> 2 条已计价记录共 220 tokens (绝非 240)
    const call120 = parseGeneratorCall({
      created_at: nowIso,
      status: 'final',
      stepIndices: [5],
      chatModel: {
        modelDisplayName: 'Gemini 4 Carbon (High)',
        responseModel: 'gemini-4-carbon',
        usage: { inputTokens: 90, cacheReadTokens: 0, outputTokens: 30, responseId: 'resp_120' }
      }
    }, cid, 'desktop');
    recordModelCalls([call120], { agDir });

    const scanAfter120 = await collectTokenHistoryAsync({ force: true, agDir, agCliDir: cliDir, userStatus: mockUserStatus });
    const callsAfter120 = loadPricingLedger(agDir).calls || {};
    assert.deepEqual(Object.keys(callsAfter120).sort(), ['resp_120', 'resp_zero_out']);
    assert.equal(callsAfter120.resp_zero_out.totalTokens, 100);
    assert.equal(callsAfter120.resp_120.totalTokens, 120);
    assert.equal(scanAfter120.costEstimate.pricedRequestsCount, 2);
    assert.equal(scanAfter120.costEstimate.pricedTokens, 220);
    assert.equal(scanAfter120.costEstimate.unpricedRequestsCount, 0);
    assert.equal(scanAfter120.costEstimate.unpricedTokens, 0);

    // 4) 同一显式 callId ('resp_zero_out') 后续校准用量 (100 + 25 = 125 tokens) 依然正常原地修订为 125 tokens
    const callZeroOutRevised = parseGeneratorCall({
      created_at: nowIso,
      status: 'final',
      stepIndices: [5],
      chatModel: {
        modelDisplayName: 'Gemini 4 Carbon (High)',
        responseModel: 'gemini-4-carbon',
        usage: { inputTokens: 100, cacheReadTokens: 0, outputTokens: 25, responseId: 'resp_zero_out' }
      }
    }, cid, 'desktop');
    recordModelCalls([callZeroOutRevised], { agDir });
    const revised = loadPricingLedger(agDir).calls.resp_zero_out;
    assert.equal(revised.outputTokens, 25);
    assert.equal(revised.totalTokens, 125);
    assert.equal(revised.isEstimated, false);
  } finally {
    fs.rmSync(agDir, { recursive: true, force: true });
    fs.rmSync(cliDir, { recursive: true, force: true });
  }
});

test('[P2] time-source provenance calibrates provisional RPC dates & costs on disk (backward across rate tier, same-rate cross-month, and forward UTC->local day)', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { recordModelCalls, loadPricingLedger, formatLocalDateKey } = require('./meter-collector');

  const mockUserStatus = { userTier: { name: 'Pro' }, planStatus: { availablePromptCredits: 500 } };
  const agDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-date-provenance-'));
  const cliDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-date-provenance-cli-'));
  const prevWindow = globalThis.window;

  try {
    // (1) 跨调价日向前回拨：在 2026-12-02 打开 2026-11-25 的历史会话，RPC 无时间先打上临时 12-02 ($1.22)，扫描对齐 transcript 后必须将 11-25 与 $0.61 一并落盘
    const cidRate = '12121212-2525-4444-8888-aaaaaaaaaaaa';
    const prevDateNow = Date.now;
    globalThis.window = {};
    Date.now = () => new Date(2026, 11, 2, 14, 0, 0).getTime(); // 本地 2026-12-02 14:00:00
    let rpcProvisionalDec;
    try {
      rpcProvisionalDec = parseGeneratorCall({
        stepIndices: [3],
        chatModel: {
          modelDisplayName: 'Gemini 4 Carbon (High)',
          responseModel: 'gemini-4-carbon',
          usage: { inputTokens: 250000, cacheReadTokens: 100000, outputTokens: 10000, responseId: 'resp_nov25_opened_dec2' }
        }
      }, cidRate, 'desktop');
    } finally {
      Date.now = prevDateNow;
      if (prevWindow === undefined) delete globalThis.window;
      else globalThis.window = prevWindow;
    }

    assert.equal(rpcProvisionalDec.date, '2026-12-02');
    assert.equal(rpcProvisionalDec.dateSource, 'provisional');
    assert.equal(rpcProvisionalDec.dateIsProvisional, true);
    assert.equal(rpcProvisionalDec.created_at, null);
    assert.equal(rpcProvisionalDec.costUSD, 1.22);

    recordModelCalls([rpcProvisionalDec], { agDir });
    assert.equal(loadPricingLedger(agDir).calls.resp_nov25_opened_dec2.costUSD, 1.22);

    const logDirRate = path.join(agDir, 'brain', cidRate, '.system_generated', 'logs');
    fs.mkdirSync(logDirRate, { recursive: true });
    fs.writeFileSync(
      path.join(logDirRate, 'transcript.jsonl'),
      JSON.stringify({
        step_index: 3,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-25T10:00:00Z',
        input_tokens: 250000,
        cache_read_tokens: 100000,
        output_tokens: 10000
      }) + '\n',
      'utf8'
    );

    // (2) 同费率跨月修正：2026-10-28 的 Claude Opus 5.5 会话在 2026-11-12 打开，费率相同 ($1.32) 但日期跨月，对齐后磁盘日期必须修正为 2026-10-28
    const cidMonth = '10101010-2828-4444-8888-bbbbbbbbbbbb';
    const rpcProvisionalNov = parseGeneratorCall({
      date: '2026-11-12',
      dateIsProvisional: true,
      stepIndices: [1],
      chatModel: {
        modelDisplayName: 'Claude Opus 5.5 (High)',
        usage: { inputTokens: 300000, cacheReadTokens: 100000, outputTokens: 5000, responseId: 'resp_oct28_opened_nov12' }
      }
    }, cidMonth, 'desktop');
    assert.equal(rpcProvisionalNov.date, '2026-11-12');
    assert.equal(rpcProvisionalNov.costUSD, 1.32);
    recordModelCalls([rpcProvisionalNov], { agDir });

    const logDirMonth = path.join(agDir, 'brain', cidMonth, '.system_generated', 'logs');
    fs.mkdirSync(logDirMonth, { recursive: true });
    fs.writeFileSync(
      path.join(logDirMonth, 'transcript.jsonl'),
      JSON.stringify({
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-10-28T09:00:00Z',
        input_tokens: 300000,
        cache_read_tokens: 100000,
        output_tokens: 5000
      }) + '\n',
      'utf8'
    );

    // (3) 向后跨日修正：临时或 UTC 切片日期为 2026-11-30 ($0.61)，真实本地时间为 2026-12-01 01:30 ($1.22)，必须向后跨日修正日期与费用并落盘
    const cidForward = '11301201-0130-4444-8888-cccccccccccc';
    const localDec1Early = new Date(2026, 11, 1, 1, 30, 0); // 本地时间 2026-12-01 01:30:00（在 UTC+8 下 ISO 为 2026-11-30T17:30:00.000Z）
    const dec1Iso = localDec1Early.toISOString();
    assert.equal(formatLocalDateKey(localDec1Early), '2026-12-01');

    const directParsedForward = parseGeneratorCall({
      created_at: dec1Iso,
      stepIndices: [2],
      chatModel: {
        modelDisplayName: 'Gemini 4 Carbon (High)',
        usage: { inputTokens: 250000, cacheReadTokens: 100000, outputTokens: 10000, responseId: 'resp_forward_direct' }
      }
    }, cidForward, 'desktop');
    assert.equal(directParsedForward.date, '2026-12-01');
    assert.equal(directParsedForward.costUSD, 1.22);

    const rpcProvisionalNov30 = parseGeneratorCall({
      date: '2026-11-30',
      dateIsProvisional: true,
      stepIndices: [4],
      chatModel: {
        modelDisplayName: 'Gemini 4 Carbon (High)',
        usage: { inputTokens: 250000, cacheReadTokens: 100000, outputTokens: 10000, responseId: 'resp_forward_nov30_to_dec1' }
      }
    }, cidForward, 'desktop');
    assert.equal(rpcProvisionalNov30.date, '2026-11-30');
    assert.equal(rpcProvisionalNov30.costUSD, 0.61);
    recordModelCalls([rpcProvisionalNov30], { agDir });

    const logDirForward = path.join(agDir, 'brain', cidForward, '.system_generated', 'logs');
    fs.mkdirSync(logDirForward, { recursive: true });
    fs.writeFileSync(
      path.join(logDirForward, 'transcript.jsonl'),
      JSON.stringify({
        step_index: 4,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: dec1Iso,
        input_tokens: 250000,
        cache_read_tokens: 100000,
        output_tokens: 10000
      }) + '\n',
      'utf8'
    );

    const scanRes = await collectTokenHistoryAsync({ force: true, agDir, agCliDir: cliDir, userStatus: mockUserStatus });
    // 合计已计价：0.61 (11-25) + 1.32 (10-28) + 1.22 (12-01) = 3.15
    assert.equal(scanRes.costEstimate.pricedCostUSD, 3.15);
    assert.equal(scanRes.costEstimate.unpricedTokens, 0);

    // 核验磁盘持久化账本：三类日期与重算费用必须全部落盘，且解除 provisional 标记
    const diskLedger = JSON.parse(fs.readFileSync(path.join(agDir, 'pricing_ledger_v1.json'), 'utf8'));
    assert.equal(diskLedger.calls.resp_nov25_opened_dec2.date, '2026-11-25');
    assert.equal(diskLedger.calls.resp_nov25_opened_dec2.costUSD, 0.61);
    assert.equal(diskLedger.calls.resp_nov25_opened_dec2.dateIsProvisional, false);

    assert.equal(diskLedger.calls.resp_oct28_opened_nov12.date, '2026-10-28');
    assert.equal(diskLedger.calls.resp_oct28_opened_nov12.costUSD, 1.32);
    assert.equal(diskLedger.calls.resp_oct28_opened_nov12.dateIsProvisional, false);

    assert.equal(diskLedger.calls.resp_forward_nov30_to_dec1.date, '2026-12-01');
    assert.equal(diskLedger.calls.resp_forward_nov30_to_dec1.costUSD, 1.22);
    assert.equal(diskLedger.calls.resp_forward_nov30_to_dec1.dateIsProvisional, false);

    // 后续前端再次发送带临时日期 (2026-12-02, $1.22) 的同 callId 记录，绝不能回退覆盖已校准的真实历史日期与费用
    const stalePollRes = recordModelCalls([rpcProvisionalDec], { agDir });
    assert.equal(stalePollRes.ok, true);
    assert.equal(stalePollRes.changed, false);
    const afterStaleDisk = JSON.parse(fs.readFileSync(path.join(agDir, 'pricing_ledger_v1.json'), 'utf8'));
    assert.equal(afterStaleDisk.calls.resp_nov25_opened_dec2.date, '2026-11-25');
    assert.equal(afterStaleDisk.calls.resp_nov25_opened_dec2.costUSD, 0.61);

    // 清理 10-28 的 transcript.jsonl（仅剩 v2 归档 + 账本）后重扫：2026-10-28 的 v2 归档被精确抵扣，零未计价残差泄漏
    fs.rmSync(path.join(agDir, 'brain', cidMonth), { recursive: true, force: true });
    const scanAfterCleanup = await collectTokenHistoryAsync({ force: true, agDir, agCliDir: cliDir, userStatus: mockUserStatus });
    assert.equal(scanAfterCleanup.costEstimate.pricedCostUSD, 3.15);
    assert.equal(scanAfterCleanup.costEstimate.unpricedTokens, 0);
  } finally {
    if (prevWindow === undefined) delete globalThis.window;
    else globalThis.window = prevWindow;
    fs.rmSync(agDir, { recursive: true, force: true });
    fs.rmSync(cliDir, { recursive: true, force: true });
  }
});

test('[P2 & P3] MODEL_PLACEHOLDER_* cross-key dedup, same-callId GPT-OSS 120B enrichment, and resolveModelQuota two-path matching', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { resolveModelQuota } = require('./meter-core');
  const { recordModelCalls, loadPricingLedger } = require('./meter-collector');

  const mockUserStatus = { userTier: { name: 'Pro' }, planStatus: { availablePromptCredits: 500 } };
  const agDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-placeholder-fix-'));
  const cliDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-placeholder-cli-'));

  try {
    const cid = '55555555-6666-4444-8888-999999999999';

    // 1) 跨键占位符消重：合成键 <cid>#2 含 MODEL_PLACEHOLDER_M437 (100 tok) 与真实 ID resp_carbon_2 (100 tok) 自动归并为单键；但不同用量 (100 vs 140) 的已完成真实记录仍保持跨键隔离守卫
    const synPlaceholder = {
      callId: `${cid}#2`,
      source: 'desktop',
      cascadeId: cid,
      stepIndex: 2,
      model: 'MODEL_PLACEHOLDER_M437',
      modelKey: null,
      inputTokens: 70,
      cacheTokens: 10,
      outputTokens: 20,
      totalTokens: 100,
      status: 'final',
      isPriced: false,
      costUSD: 0,
      date: '2026-11-12'
    };
    const realCarbon = parseGeneratorCall({
      date: '2026-11-12',
      stepIndices: [2],
      chatModel: {
        modelDisplayName: 'Gemini 4 Carbon (Medium)',
        responseModel: 'gemini-4-carbon',
        usage: { inputTokens: 70, cacheReadTokens: 10, outputTokens: 20, responseId: 'resp_carbon_2' }
      }
    }, cid, 'desktop');

    recordModelCalls([synPlaceholder], { agDir });
    recordModelCalls([realCarbon], { agDir });
    const afterCrossMerge = loadPricingLedger(agDir).calls;
    assert.deepEqual(Object.keys(afterCrossMerge), ['resp_carbon_2']);
    assert.equal(afterCrossMerge.resp_carbon_2.model, 'Gemini 4 Carbon (Medium)');
    assert.equal(afterCrossMerge.resp_carbon_2.isPriced, true);

    // 验证跨键严格用量守卫未松动：已完成非零真实记录 (100 tok) 遇到 140-tok 占位符合成键时绝不跨键篡改用量，双键独立保留
    const synDiffUsage = {
      ...synPlaceholder,
      callId: `${cid}#2`,
      inputTokens: 100,
      cacheTokens: 10,
      outputTokens: 30,
      totalTokens: 140
    };
    recordModelCalls([synDiffUsage], { agDir });
    const guardedCalls = loadPricingLedger(agDir).calls;
    assert.deepEqual(Object.keys(guardedCalls).sort(), [`${cid}#2`, 'resp_carbon_2']);
    assert.equal(guardedCalls.resp_carbon_2.totalTokens, 100);
    assert.equal(guardedCalls[`${cid}#2`].totalTokens, 140);

    // 2) 同 callId 补上无公开费率真实模型 (MODEL_PLACEHOLDER_M999 -> GPT-OSS 120B (Medium))：recordModelCalls 与 collectTokenHistoryAsync 均须更新落盘且防逆向回退
    const phGpt = parseGeneratorCall({
      date: '2026-11-12',
      stepIndices: [6],
      chatModel: {
        model: 'MODEL_PLACEHOLDER_M999',
        usage: { inputTokens: 800, cacheReadTokens: 0, outputTokens: 200, responseId: 'resp_gptoss_rpc' }
      }
    }, cid, 'desktop');
    const resolvedGpt = parseGeneratorCall({
      date: '2026-11-12',
      stepIndices: [6],
      chatModel: {
        modelDisplayName: 'GPT-OSS 120B (Medium)',
        usage: { inputTokens: 800, cacheReadTokens: 0, outputTokens: 200, responseId: 'resp_gptoss_rpc' }
      }
    }, cid, 'desktop');

    recordModelCalls([phGpt], { agDir });
    assert.equal(loadPricingLedger(agDir).calls.resp_gptoss_rpc.model, 'MODEL_PLACEHOLDER_M999');

    const updGptRes = recordModelCalls([resolvedGpt], { agDir });
    assert.equal(updGptRes.ok, true);
    assert.equal(updGptRes.changed, true);
    const diskAfterRpcGpt = JSON.parse(fs.readFileSync(path.join(agDir, 'pricing_ledger_v1.json'), 'utf8'));
    assert.equal(diskAfterRpcGpt.calls.resp_gptoss_rpc.model, 'GPT-OSS 120B (Medium)');
    assert.equal(diskAfterRpcGpt.calls.resp_gptoss_rpc.isPriced, false);

    // 逆向迟到占位符不得把 GPT-OSS 120B 覆盖回 MODEL_PLACEHOLDER_M999
    const rollbackRes = recordModelCalls([phGpt], { agDir });
    assert.equal(rollbackRes.changed, false);
    assert.equal(loadPricingLedger(agDir).calls.resp_gptoss_rpc.model, 'GPT-OSS 120B (Medium)');

    // 验证扫描路径 applyTranscriptMatch (modelEnriched) 对同一 callId 同样完成 MODEL_PLACEHOLDER -> GPT-OSS 120B 落盘
    const phScanSeed = {
      ...phGpt,
      callId: 'resp_gptoss_scan',
      stepIndex: 7
    };
    recordModelCalls([phScanSeed], { agDir });
    const logDir = path.join(agDir, 'brain', cid, '.system_generated', 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(
      path.join(logDir, 'transcript.jsonl'),
      JSON.stringify({
        step_index: 7,
        callId: 'resp_gptoss_scan',
        created_at: '2026-11-12T06:00:00Z',
        model: 'GPT-OSS 120B (Medium)',
        input_tokens: 800,
        cache_read_tokens: 0,
        output_tokens: 200
      }) + '\n',
      'utf8'
    );
    await collectTokenHistoryAsync({ force: true, agDir, agCliDir: cliDir, userStatus: mockUserStatus });
    const diskAfterScanGpt = JSON.parse(fs.readFileSync(path.join(agDir, 'pricing_ledger_v1.json'), 'utf8'));
    assert.equal(diskAfterScanGpt.calls.resp_gptoss_scan.model, 'GPT-OSS 120B (Medium)');

    // 3) P3 resolveModelQuota 双路径核验：modelOrAlias.model 精确匹配 + label 模型家族匹配 + Argon 5h 池命名
    const liveClientConfigs = [
      {
        label: 'Gemini 4 Carbon (Medium)',
        modelOrAlias: { model: 'MODEL_PLACEHOLDER_M437' },
        quotaInfo: { remainingFraction: 0.82, resetTime: '2026-11-12T12:00:00Z' }
      },
      {
        label: 'Gemini 4 Argon (High)',
        modelOrAlias: { model: 'MODEL_PLACEHOLDER_M18' },
        quotaInfo: { remainingFraction: 0.82, resetTime: '2026-11-12T12:00:00Z' }
      }
    ];
    const exactPlaceholderQuota = resolveModelQuota('MODEL_PLACEHOLDER_M437', liveClientConfigs);
    assert.ok(exactPlaceholderQuota);
    assert.equal(exactPlaceholderQuota.modelId, 'MODEL_PLACEHOLDER_M437');
    assert.equal(exactPlaceholderQuota.label, 'Gemini 4 Carbon (Medium)');
    assert.equal(exactPlaceholderQuota.remainingFraction, 0.82);

    const familyCarbonQuota = resolveModelQuota('gemini-4-carbon', liveClientConfigs);
    assert.ok(familyCarbonQuota);
    assert.equal(familyCarbonQuota.poolKey, 'gemini-4-carbon');
    assert.equal(familyCarbonQuota.poolName, 'Gemini 4 Carbon 配额池');
    assert.equal(familyCarbonQuota.remainingFraction, 0.82);

    const familyArgonQuota = resolveModelQuota('gemini-4-argon', liveClientConfigs);
    assert.ok(familyArgonQuota);
    assert.equal(familyArgonQuota.poolName, 'Gemini 4 Argon 配额池');

    // 4) P3 通用短标签（如 label: "High" / "Medium"）不得遮住可识别的 modelId 或 modelOrAlias.model
    const genericLabelConfigs = [
      {
        label: 'High',
        modelId: 'gemini-4-argon-high',
        quotaInfo: { remainingFraction: 0.75, resetTime: '2026-11-12T13:00:00Z' }
      },
      {
        label: 'Medium',
        modelOrAlias: { model: 'claude-sonnet-5-5-medium' },
        quotaInfo: { remainingFraction: 0.6, resetTime: '2026-11-12T14:00:00Z' }
      }
    ];
    const exactGenericLabel = resolveModelQuota('gemini-4-argon-high', genericLabelConfigs);
    assert.ok(exactGenericLabel);
    assert.equal(exactGenericLabel.remainingFraction, 0.75);

    const familyFromModelId = resolveModelQuota('gemini-4-argon', genericLabelConfigs);
    assert.ok(familyFromModelId, '通用 label:"High" 未命中家族时必须继续回退匹配 modelId');
    assert.equal(familyFromModelId.poolKey, 'gemini-4-argon');
    assert.equal(familyFromModelId.poolName, 'Gemini 4 Argon 配额池');
    assert.equal(familyFromModelId.remainingFraction, 0.75);

    const familyFromAliasModel = resolveModelQuota('claude-sonnet-5-5', genericLabelConfigs);
    assert.ok(familyFromAliasModel, '通用 label:"Medium" 未命中家族时必须继续回退匹配 modelOrAlias.model');
    assert.equal(familyFromAliasModel.poolKey, 'claude-sonnet-5-5');
    assert.equal(familyFromAliasModel.poolName, 'Claude Sonnet 5.5 配额池');
    assert.equal(familyFromAliasModel.remainingFraction, 0.6);
  } finally {
    fs.rmSync(agDir, { recursive: true, force: true });
    fs.rmSync(cliDir, { recursive: true, force: true });
  }
});

test('collectTokenHistoryAsync 连续两次非强制调用不会卡在旧 activeScanPromise 并能在入账后获取最新数据', async () => {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-meter-deadlock-test-'));
  const tempCliDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-meter-deadlock-cli-'));
  const prevAgDir = process.env.AG_DIR;
  const prevAgCliDir = process.env.AG_CLI_DIR;
  process.env.AG_DIR = tempDir;
  process.env.AG_CLI_DIR = tempCliDir;

  try {
    fs.mkdirSync(path.join(tempDir, 'brain', 'session_1'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'conversations'), { recursive: true });
    fs.mkdirSync(path.join(tempCliDir, 'brain'), { recursive: true });
    fs.mkdirSync(path.join(tempCliDir, 'conversations'), { recursive: true });

    // 写入第一个对话数据（5500 tokens）
    const event1 = {
      created_at: '2026-11-08T10:00:00Z',
      model: 'gemini-3.8-flash',
      chatModel: { usage: { inputTokens: 5000, outputTokens: 500, cacheReadTokens: 0 } }
    };
    fs.writeFileSync(path.join(tempDir, 'brain', 'session_1', 'transcript.jsonl'), JSON.stringify(event1) + '\n', 'utf8');

    // 1. 发起第一次调用（非强制，初始化全局缓存与 activeScanPromise）
    const res1 = await collectTokenHistoryAsync({ force: false });
    assert.ok(res1);
    assert.equal(res1.summary.grandTotalTokens, 5500);

    // 2. 写入第二个对话数据（新增 2300 tokens）
    fs.mkdirSync(path.join(tempDir, 'brain', 'session_2'), { recursive: true });
    const event2 = {
      created_at: '2026-11-08T11:00:00Z',
      model: 'gemini-3.8-flash',
      chatModel: { usage: { inputTokens: 2000, outputTokens: 300, cacheReadTokens: 0 } }
    };
    fs.writeFileSync(path.join(tempDir, 'brain', 'session_2', 'transcript.jsonl'), JSON.stringify(event2) + '\n', 'utf8');

    // recordModelCalls 入账成功并重置 cachedTokenHistoryAt = 0 使缓存失效
    const recRes = recordModelCalls([{
      callId: 'call_regress_deadlock_1',
      model: 'gemini-3.8-flash',
      status: 'final',
      inputTokens: 2000,
      outputTokens: 300,
      created_at: new Date().toISOString()
    }]);
    assert.equal(recRes.ok, true);
    assert.equal(recRes.changed, true);

    // 3. 发起第二次非强制调用（force: false）
    // 旧代码由于 runner.finally 比较错误，activeScanPromise 永远不为空，后续所有 force: false 调用恒返回旧的首次结果 (5500)
    // 修复后 activeScanPromise 在首次完成后已成功释放，缓存已失效，此处必须执行新扫描并返回 7800 tokens
    const res2 = await collectTokenHistoryAsync({ force: false });
    assert.ok(res2);
    assert.equal(res2.summary.grandTotalTokens, 7800);

    // 4. 验证顶层 savedHeatView 与 autoCheckUpdate 的持久化与读取一致性
    const { savePluginSettings, getPluginSettings } = require('./meter-collector');
    const saveUiRes = savePluginSettings({ savedHeatView: 'monthly', autoCheckUpdate: false }, { agDir: tempDir });
    assert.equal(saveUiRes.ok, true);
    const loadedUi = getPluginSettings({ agDir: tempDir });
    assert.equal(loadedUi.ok, true);
    assert.equal(loadedUi.savedHeatView, 'monthly');
    assert.equal(loadedUi.autoCheckUpdate, false);
    assert.equal(loadedUi.uiPreferences.savedHeatView, 'monthly');
    assert.equal(loadedUi.uiPreferences.autoCheckUpdate, false);

    // 5. 验证 getDailyModelCost 分项费用 (inputCost / cacheCost / outputCost) 正确返回非零数值
    const { getDailyModelCost, clearDailyCostCache } = require('./meter-core');
    clearDailyCostCache();
    const dayCost = getDailyModelCost(
      { total: 3000000, input: 1000000, cache: 1000000, output: 1000000 },
      '2026-11-10',
      'gemini-3.8-flash'
    );
    assert.ok(dayCost.inputCost > 0);
    assert.ok(dayCost.cacheCost > 0);
    assert.ok(dayCost.outputCost > 0);
    assert.equal(dayCost.costUSD, Number((dayCost.inputCost + dayCost.cacheCost + dayCost.outputCost).toFixed(4)));
  } finally {
    if (prevAgDir !== undefined) process.env.AG_DIR = prevAgDir;
    else delete process.env.AG_DIR;
    if (prevAgCliDir !== undefined) process.env.AG_CLI_DIR = prevAgCliDir;
    else delete process.env.AG_CLI_DIR;
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(tempCliDir, { recursive: true, force: true }); } catch {}
  }
});

test('Codex 审阅回归：resolveModelQuota 非空占位 modelId 不遮蔽 modelOrAlias.model、Claude 5.5 子补丁号拒识、同等级权威时间双向修正与 Pass 2 双边唯一性', async () => {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const { resolveModelQuota } = require('./meter-core');
  const { loadPricingLedger } = require('./meter-collector');

  // 1) resolveModelQuota：当 modelId 非空（如占位符）且同池前序项存在时，仍必须优先精确命中 modelOrAlias.model
  const aliasShadowConfigs = [
    {
      modelId: 'MODEL_PLACEHOLDER_M401',
      modelOrAlias: { model: 'claude-opus-5-5-standard' },
      label: 'Claude Opus 5.5',
      quotaInfo: { remainingFraction: 0.9, resetTime: '2026-11-13T10:00:00Z' }
    },
    {
      modelId: 'MODEL_PLACEHOLDER_M437',
      modelOrAlias: { model: 'claude-opus-5-5-thinking' },
      label: 'Claude Opus 5.5 (Thinking)',
      quotaInfo: { remainingFraction: 0.1, resetTime: '2026-11-13T11:00:00Z' }
    }
  ];
  const exactAliasQuota = resolveModelQuota('claude-opus-5-5-thinking', aliasShadowConfigs);
  assert.ok(exactAliasQuota);
  assert.equal(exactAliasQuota.remainingFraction, 0.1, '必须精确命中第二项 modelOrAlias.model 而非退回池级首项');
  assert.equal(exactAliasQuota.label, 'Claude Opus 5.5 (Thinking)');

  // 2) normalizeModelId：拒绝 5.5.1 / 5-5-1 等独立补丁子版本，同时兼容 8 位日期后缀与 Thinking/High 标签
  assert.equal(normalizeModelId('claude-opus-5.5.1'), null);
  assert.equal(normalizeModelId('claude-opus-5-5-1'), null);
  assert.equal(normalizeModelId('claude-sonnet-5.5.2'), null);
  assert.equal(normalizeModelId('Claude 5.5.1 Opus'), null);
  assert.equal(normalizeModelId('claude-opus-5-5-20261101'), 'claude-opus-5-5');
  assert.equal(normalizeModelId('claude-sonnet-5-5-20261101'), 'claude-sonnet-5-5');
  assert.equal(normalizeModelId('Claude Opus 5.5 (Thinking)'), 'claude-opus-5-5');

  // 3) recordModelCalls 同等级权威时间双向修订（基于显式修订依据）、同用量迟到旧快照防回滚、无版本冲突稳定策略与 (tot↑, out↓) 交叉快照一致性
  const revDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-same-rank-date-rev-'));
  try {
    const cid = 'cccccccc-1111-4444-8888-222222222222';
    const baseRow = {
      stepIndices: [3],
      status: 'final',
      created_at: '2026-11-12T10:00:00Z',
      chatModel: {
        modelDisplayName: 'Gemini 4 Carbon (High)',
        responseModel: 'gemini-4-carbon',
        usage: { inputTokens: 250000, cacheReadTokens: 100000, outputTokens: 10000, responseId: 'resp_same_rank_rev' }
      }
    };
    const initialUnversioned = parseGeneratorCall(baseRow, cid, 'desktop');
    assert.equal(initialUnversioned.sourceRevision, undefined);
    const rSeed = recordModelCalls([initialUnversioned], { agDir: revDir });
    assert.equal(rSeed.ok, true);
    assert.equal(rSeed.changed, true);
    assert.equal(loadPricingLedger(revDir).calls.resp_same_rank_rev.date, '2026-11-12');
    assert.equal(loadPricingLedger(revDir).calls.resp_same_rank_rev.costUSD, 0.61);

    // 3a) 正向修正：2026-11-12 -> 2026-12-01（携带显式 sourceRevision: 2，即使未同步重算 date 字段也必须生效）
    const rForward = recordModelCalls([{
      ...parseGeneratorCall({ ...baseRow, sourceRevision: 2 }, cid, 'desktop'),
      date: '2026-11-12',
      created_at: '2026-12-01T10:00:00Z'
    }], { agDir: revDir });
    assert.equal(rForward.ok, true);
    assert.equal(rForward.changed, true, '带显式新修订号的同等级 created_at 正向修正必须落盘');
    assert.equal(loadPricingLedger(revDir).calls.resp_same_rank_rev.date, '2026-12-01');
    assert.equal(loadPricingLedger(revDir).calls.resp_same_rank_rev.costUSD, 1.22);
    assert.equal(loadPricingLedger(revDir).calls.resp_same_rank_rev.sourceRevision, 2);

    // 3b) 同用量迟到的初始无版本快照与 sourceRevision: 1 旧快照（及重复重放）严禁把已修正的 12-01 ($1.22) 回滚回 11-12 ($0.61)
    const lateInitialRes1 = recordModelCalls([initialUnversioned], { agDir: revDir });
    assert.equal(lateInitialRes1.ok, true);
    assert.equal(lateInitialRes1.changed, false, '同用量迟到的无版本初始快照不得回滚已修正日期');
    const lateInitialRes2 = recordModelCalls([initialUnversioned], { agDir: revDir });
    assert.equal(lateInitialRes2.changed, false, '重复到达的同用量旧快照必须保持幂等无变更');
    const lateRev1Res = recordModelCalls([parseGeneratorCall({
      ...baseRow,
      sourceRevision: 1,
      created_at: '2026-11-12T10:00:00Z'
    }, cid, 'desktop')], { agDir: revDir });
    assert.equal(lateRev1Res.changed, false, '同用量较低修订号快照不得回滚已修正日期');
    assert.equal(loadPricingLedger(revDir).calls.resp_same_rank_rev.date, '2026-12-01');
    assert.equal(loadPricingLedger(revDir).calls.resp_same_rank_rev.costUSD, 1.22);

    // 3c) 逆向修正：2026-12-01 -> 2026-11-20（更高 sourceRevision: 3 / updated_at 支持双向日期校准，不以 created_at 本身判先后）
    const rBackward = recordModelCalls([parseGeneratorCall({
      ...baseRow,
      sourceRevision: 3,
      created_at: '2026-11-20T10:00:00Z'
    }, cid, 'desktop')], { agDir: revDir });
    assert.equal(rBackward.ok, true);
    assert.equal(rBackward.changed, true, '带更高修订号的同等级 created_at 逆向修正必须落盘并重算费率');
    assert.equal(loadPricingLedger(revDir).calls.resp_same_rank_rev.date, '2026-11-20');
    assert.equal(loadPricingLedger(revDir).calls.resp_same_rank_rev.costUSD, 0.61);

    // 迟到的 rev=2 (12-01) 与重复包不得将 11-20 ($0.61) 反弹回 12-01 ($1.22)
    const lateRev2A = recordModelCalls([parseGeneratorCall({
      ...baseRow,
      sourceRevision: 2,
      created_at: '2026-12-01T10:00:00Z'
    }, cid, 'desktop')], { agDir: revDir });
    const lateRev2B = recordModelCalls([parseGeneratorCall({
      ...baseRow,
      sourceRevision: 2,
      created_at: '2026-12-01T10:00:00Z'
    }, cid, 'desktop')], { agDir: revDir });
    assert.equal(lateRev2A.changed, false);
    assert.equal(lateRev2B.changed, false);
    assert.equal(loadPricingLedger(revDir).calls.resp_same_rank_rev.date, '2026-11-20');
    assert.equal(loadPricingLedger(revDir).calls.resp_same_rank_rev.costUSD, 0.61);

    // 3d) 乱序迟到的残缺低用量快照即使带新日期亦不得篡改已确认的权威日期
    const rStaleRollback = recordModelCalls([parseGeneratorCall({
      ...baseRow,
      created_at: '2026-12-05T10:00:00Z',
      chatModel: {
        ...baseRow.chatModel,
        usage: { inputTokens: 250000, cacheReadTokens: 100000, outputTokens: 2000, responseId: 'resp_same_rank_rev' }
      }
    }, cid, 'desktop')], { agDir: revDir });
    assert.equal(rStaleRollback.changed, false, '用量倒退的乱序旧包不得改写同等级权威日期');
    assert.equal(loadPricingLedger(revDir).calls.resp_same_rank_rev.date, '2026-11-20');
    assert.equal(loadPricingLedger(revDir).calls.resp_same_rank_rev.costUSD, 0.61);

    // 3e) 无修订依据且同用量的冲突策略：保留首个已入账权威日期，交替输入两版无版本数据零震荡
    const unvNov = parseGeneratorCall({
      ...baseRow,
      created_at: '2026-11-12T10:00:00Z',
      chatModel: {
        ...baseRow.chatModel,
        usage: { inputTokens: 250000, cacheReadTokens: 100000, outputTokens: 10000, responseId: 'resp_unversioned_tie' }
      }
    }, cid, 'desktop');
    const unvDec = parseGeneratorCall({
      ...baseRow,
      created_at: '2026-12-01T10:00:00Z',
      chatModel: {
        ...baseRow.chatModel,
        usage: { inputTokens: 250000, cacheReadTokens: 100000, outputTokens: 10000, responseId: 'resp_unversioned_tie' }
      }
    }, cid, 'desktop');
    assert.equal(recordModelCalls([unvNov], { agDir: revDir }).changed, true);
    assert.equal(recordModelCalls([unvDec], { agDir: revDir }).changed, false);
    assert.equal(recordModelCalls([unvNov], { agDir: revDir }).changed, false);
    assert.equal(recordModelCalls([unvDec], { agDir: revDir }).changed, false);
    assert.equal(loadPricingLedger(revDir).calls.resp_unversioned_tie.date, '2026-11-12');
    assert.equal(loadPricingLedger(revDir).calls.resp_unversioned_tie.costUSD, 0.61);

    // 3f) “总量增加、输出量下降”交叉变化用例：input=100k,output=20k,tot=120k,11-12 ($0.40) -> input=130k,output=10k,tot=140k,12-01 ($0.72)
    const crossInitial = parseGeneratorCall({
      stepIndices: [5],
      status: 'final',
      created_at: '2026-11-12T10:00:00Z',
      chatModel: {
        modelDisplayName: 'Gemini 4 Carbon (High)',
        responseModel: 'gemini-4-carbon',
        usage: { inputTokens: 100000, cacheReadTokens: 0, outputTokens: 20000, responseId: 'resp_tot_up_out_down' }
      }
    }, cid, 'desktop');
    const crossProgressed = parseGeneratorCall({
      stepIndices: [5],
      status: 'final',
      created_at: '2026-12-01T10:00:00Z',
      chatModel: {
        modelDisplayName: 'Gemini 4 Carbon (High)',
        responseModel: 'gemini-4-carbon',
        usage: { inputTokens: 130000, cacheReadTokens: 0, outputTokens: 10000, responseId: 'resp_tot_up_out_down' }
      }
    }, cid, 'desktop');
    assert.equal(recordModelCalls([crossInitial], { agDir: revDir }).changed, true);
    assert.equal(loadPricingLedger(revDir).calls.resp_tot_up_out_down.totalTokens, 120000);
    assert.equal(loadPricingLedger(revDir).calls.resp_tot_up_out_down.costUSD, 0.4);

    const crossUpdRes = recordModelCalls([crossProgressed], { agDir: revDir });
    assert.equal(crossUpdRes.ok, true);
    assert.equal(crossUpdRes.changed, true, '总量增长而输出下降的新快照必须被后端接收入账');
    const crossSaved = loadPricingLedger(revDir).calls.resp_tot_up_out_down;
    assert.equal(crossSaved.inputTokens, 130000);
    assert.equal(crossSaved.outputTokens, 10000);
    assert.equal(crossSaved.totalTokens, 140000);
    assert.equal(crossSaved.date, '2026-12-01');
    assert.equal(crossSaved.costUSD, 0.72);

    // 迟到的原快照 (tot=120k, out=20k) 属于总量倒退，必须被拒绝
    const crossReverseRes = recordModelCalls([crossInitial], { agDir: revDir });
    assert.equal(crossReverseRes.changed, false);
    assert.equal(loadPricingLedger(revDir).calls.resp_tot_up_out_down.totalTokens, 140000);
    assert.equal(loadPricingLedger(revDir).calls.resp_tot_up_out_down.outputTokens, 10000);
    assert.equal(loadPricingLedger(revDir).calls.resp_tot_up_out_down.date, '2026-12-01');
  } finally {
    fs.rmSync(revDir, { recursive: true, force: true });
  }

  // 4) Pass 2 历史无 stepIndex 用量指纹对齐：双边唯一性门禁与遍历顺序无关性验证
  const runPass2OrderCase = async (reverseInsertionOrder) => {
    const agDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-pass2-uniq-'));
    const cliDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-pass2-uniq-cli-'));
    try {
      const cid = 'dddddddd-2222-4444-8888-333333333333';
      const entryNov = {
        callId: 'resp_legacy_nov',
        source: 'desktop',
        cascadeId: cid,
        stepIndex: null,
        model: 'Gemini 4 Carbon (High)',
        modelKey: 'gemini-4-carbon',
        inputTokens: 250000,
        cacheTokens: 100000,
        cacheReadTokens: 100000,
        outputTokens: 10000,
        totalTokens: 360000,
        status: 'final',
        isPriced: true,
        costUSD: 0.61,
        date: '2026-11-28',
        dateSource: 'provisional',
        dateIsProvisional: true
      };
      const entryDec = {
        ...entryNov,
        callId: 'resp_legacy_dec',
        costUSD: 1.22,
        date: '2026-12-02'
      };
      const ordered = reverseInsertionOrder ? [entryDec, entryNov] : [entryNov, entryDec];
      recordModelCalls(ordered, { agDir });

      // 日志中仅有 1 条同会话同用量 (250k/100k/10k) 的未匹配合成记录（日期 2026-12-01）：因账本侧存在 2 条候选，必须保持双边不匹配
      const logDir = path.join(agDir, 'brain', cid, '.system_generated', 'logs');
      fs.mkdirSync(logDir, { recursive: true });
      fs.writeFileSync(
        path.join(logDir, 'transcript.jsonl'),
        JSON.stringify({
          step_index: 9,
          created_at: '2026-12-01T08:00:00Z',
          model: 'MODEL_PLACEHOLDER_M37',
          input_tokens: 250000,
          cache_read_tokens: 100000,
          output_tokens: 10000
        }) + '\n',
        'utf8'
      );

      const hist = await collectTokenHistoryAsync({
        force: true,
        agDir,
        agCliDir: cliDir,
        userStatus: { userTier: { name: 'Pro' }, planStatus: { availablePromptCredits: 500 } }
      });
      const persisted = loadPricingLedger(agDir).calls;
      assert.equal(persisted.resp_legacy_nov.stepIndex, null, '歧义候选不得被贪心绑定 stepIndex');
      assert.equal(persisted.resp_legacy_dec.stepIndex, null, '歧义候选不得被贪心绑定 stepIndex');
      assert.equal(persisted.resp_legacy_nov.date, '2026-11-28');
      assert.equal(persisted.resp_legacy_dec.date, '2026-12-02');
      return hist.costEstimate.pricedCostUSD;
    } finally {
      fs.rmSync(agDir, { recursive: true, force: true });
      fs.rmSync(cliDir, { recursive: true, force: true });
    }
  };

  const costOrderA = await runPass2OrderCase(false);
  const costOrderB = await runPass2OrderCase(true);
  assert.equal(costOrderA, costOrderB, 'Pass 2 歧义场景下的计费总额必须与账本键遍历顺序严格无关');
  assert.equal(costOrderA, 1.83);

  // 4b) 对称歧义（1 条无 stepIndex 账本记录 vs 2 条同用量未匹配日志）不得匹配；不同模型同用量互不干扰可各自唯一匹配
  {
    const agDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-pass2-sym-'));
    const cliDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-pass2-sym-cli-'));
    try {
      const cidSym = 'eeeeeeee-3333-4444-8888-444444444444';
      recordModelCalls([
        {
          callId: 'resp_one_ledger',
          source: 'desktop',
          cascadeId: cidSym,
          stepIndex: null,
          model: 'Gemini 4 Carbon (High)',
          modelKey: 'gemini-4-carbon',
          inputTokens: 100000,
          cacheTokens: 0,
          cacheReadTokens: 0,
          outputTokens: 5000,
          totalTokens: 105000,
          status: 'final',
          isPriced: true,
          costUSD: 0.25,
          date: '2026-11-28',
          dateSource: 'provisional',
          dateIsProvisional: true
        }
      ], { agDir });
      const logDirSym = path.join(agDir, 'brain', cidSym, '.system_generated', 'logs');
      fs.mkdirSync(logDirSym, { recursive: true });
      fs.writeFileSync(
        path.join(logDirSym, 'transcript.jsonl'),
        [
          JSON.stringify({ step_index: 3, created_at: '2026-11-28T08:00:00Z', model: 'MODEL_PLACEHOLDER_M37', input_tokens: 100000, cache_read_tokens: 0, output_tokens: 5000 }),
          JSON.stringify({ step_index: 6, created_at: '2026-12-01T08:00:00Z', model: 'MODEL_PLACEHOLDER_M37', input_tokens: 100000, cache_read_tokens: 0, output_tokens: 5000 })
        ].join('\n') + '\n',
        'utf8'
      );
      await collectTokenHistoryAsync({ force: true, agDir, agCliDir: cliDir, userStatus: { userTier: { name: 'Pro' }, planStatus: { availablePromptCredits: 500 } } });
      assert.equal(loadPricingLedger(agDir).calls.resp_one_ledger.stepIndex, null, '1 对 2 日志歧义时不得任选一条绑定');
      assert.equal(loadPricingLedger(agDir).calls.resp_one_ledger.date, '2026-11-28');

      // 不同家族模型即使同会话同用量，在兼容二分图上各自度数为 1，应各自精确完成 1-to-1 对齐
      const cidDiffModel = 'ffffffff-4444-4444-8888-555555555555';
      recordModelCalls([
        {
          callId: 'resp_diff_carbon',
          source: 'desktop',
          cascadeId: cidDiffModel,
          stepIndex: null,
          model: 'Gemini 4 Carbon (High)',
          modelKey: 'gemini-4-carbon',
          inputTokens: 120000,
          cacheTokens: 0,
          cacheReadTokens: 0,
          outputTokens: 6000,
          totalTokens: 126000,
          status: 'final',
          isPriced: true,
          costUSD: 0.3,
          date: '2026-11-28',
          dateSource: 'provisional',
          dateIsProvisional: true
        },
        {
          callId: 'resp_diff_opus',
          source: 'desktop',
          cascadeId: cidDiffModel,
          stepIndex: null,
          model: 'Claude Opus 5.5 (Thinking)',
          modelKey: 'claude-opus-5-5',
          inputTokens: 120000,
          cacheTokens: 0,
          cacheReadTokens: 0,
          outputTokens: 6000,
          totalTokens: 126000,
          status: 'final',
          isPriced: true,
          costUSD: 0.6,
          date: '2026-11-28',
          dateSource: 'provisional',
          dateIsProvisional: true
        }
      ], { agDir });
      const logDirDiff = path.join(agDir, 'brain', cidDiffModel, '.system_generated', 'logs');
      fs.mkdirSync(logDirDiff, { recursive: true });
      fs.writeFileSync(
        path.join(logDirDiff, 'transcript.jsonl'),
        [
          JSON.stringify({ step_index: 4, created_at: '2026-12-01T08:00:00Z', model: 'gemini-4-carbon', input_tokens: 120000, cache_read_tokens: 0, output_tokens: 6000 }),
          JSON.stringify({ step_index: 8, created_at: '2026-11-29T08:00:00Z', model: 'claude-opus-5-5', input_tokens: 120000, cache_read_tokens: 0, output_tokens: 6000 })
        ].join('\n') + '\n',
        'utf8'
      );
      await collectTokenHistoryAsync({ force: true, agDir, agCliDir: cliDir, userStatus: { userTier: { name: 'Pro' }, planStatus: { availablePromptCredits: 500 } } });
      assert.equal(loadPricingLedger(agDir).calls.resp_diff_carbon.stepIndex, 4);
      assert.equal(loadPricingLedger(agDir).calls.resp_diff_carbon.date, '2026-12-01');
      assert.equal(loadPricingLedger(agDir).calls.resp_diff_opus.stepIndex, 8);
      assert.equal(loadPricingLedger(agDir).calls.resp_diff_opus.date, '2026-11-29');
    } finally {
      fs.rmSync(agDir, { recursive: true, force: true });
      fs.rmSync(cliDir, { recursive: true, force: true });
    }
  }
});

test('Gemini 4 Hydrogen 四档模型识别、1M 统一单档计价、配额池解析与 Orchestrator 边界回归', async () => {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const { resolveModelQuota, calculateRequestApiCost } = require('./meter-core');
  const { loadPricingLedger } = require('./meter-collector');

  const multiPoolConfigs = [
    {
      modelId: 'MODEL_PLACEHOLDER_M501',
      modelOrAlias: { model: 'gemini-4-hydrogen-xhigh' },
      label: 'XHigh',
      quotaInfo: { remainingFraction: 0.86, resetTime: '2026-11-13T06:54:16Z' }
    },
    {
      modelId: 'MODEL_PLACEHOLDER_M37',
      modelOrAlias: { model: 'gemini-4-carbon-high' },
      label: 'Gemini 4 Carbon (High)',
      quotaInfo: { remainingFraction: 0.86, resetTime: '2026-11-13T06:54:16Z' }
    },
    {
      modelId: 'MODEL_PLACEHOLDER_M38',
      modelOrAlias: { model: 'gemini-4-argon-high' },
      label: 'Gemini 4 Argon (High)',
      quotaInfo: { remainingFraction: 0.50, resetTime: '2026-11-13T06:54:16Z' }
    }
  ];

  // 1) 线上 4 档 Hydrogen 模型 ID 与展示名（含新增 XHigh 思考档）识别及配额池家族回退归类
  const hydrogenVariants = [
    'gemini-4-hydrogen',
    'gemini-4-hydrogen-low',
    'gemini-4-hydrogen-medium',
    'gemini-4-hydrogen-high',
    'gemini-4-hydrogen-xhigh',
    'Gemini 4 Hydrogen (Low)',
    'Gemini 4 Hydrogen (Medium)',
    'Gemini 4 Hydrogen (High)',
    'Gemini 4 Hydrogen (XHigh)'
  ];
  for (const variant of hydrogenVariants) {
    assert.equal(normalizeModelId(variant), 'gemini-4-hydrogen', `normalizeModelId 应识别 ${variant}`);
    const q = resolveModelQuota(variant, multiPoolConfigs);
    assert.ok(q, `resolveModelQuota 应匹配 ${variant}`);
    assert.equal(q.poolKey, 'gemini-4-hydrogen', `poolKey 应归类 ${variant}`);
    assert.equal(q.poolName, 'Gemini 4 Hydrogen 配额池');
    assert.equal(q.remainingFraction, 0.86);
  }

  // 2) Orchestrator 原始 ID 与边界：裸 gemini-pro-orchestrator 归入 Carbon，-argon 归入 Argon，未知后缀保持未计价
  assert.equal(normalizeModelId('gemini-pro-orchestrator'), 'gemini-4-carbon');
  assert.equal(resolveModelQuota('gemini-pro-orchestrator', multiPoolConfigs).poolKey, 'gemini-4-carbon');
  assert.equal(normalizeModelId('Orchestrator (Carbon)'), 'gemini-4-carbon');
  assert.equal(normalizeModelId('gemini-pro-orchestrator-argon'), 'gemini-4-argon');
  assert.equal(resolveModelQuota('gemini-pro-orchestrator-argon', multiPoolConfigs).poolKey, 'gemini-4-argon');
  assert.equal(resolveModelQuota('gemini-pro-orchestrator-argon', multiPoolConfigs).remainingFraction, 0.50);
  assert.equal(normalizeModelId('Orchestrator (Argon)'), 'gemini-4-argon');
  assert.equal(normalizeModelId('gemini-pro-orchestrator-xenon'), null, '未知 Orchestrator 变体不得误套 Carbon 费率');
  assert.equal(resolveModelQuota('gemini-pro-orchestrator-xenon', multiPoolConfigs), null);

  // 3) 1M 窗口统一单档费率（$1.50 / $7.50 / $0.075 per 1M）：超 200K 上下文及跨年均无阶梯跳涨
  //    400k input ($0.60) + 200k cache ($0.015) + 20k output ($0.15) = $0.765
  const costNov = calculateRequestApiCost({
    modelDisplayName: 'Gemini 4 Hydrogen (XHigh)',
    inputTokens: 400000,
    cacheReadTokens: 200000,
    outputTokens: 20000,
    thinkingTokens: 12000,
    date: '2026-11-13'
  });
  assert.equal(costNov.isPriced, true);
  assert.equal(costNov.modelKey, 'gemini-4-hydrogen');
  assert.equal(costNov.costUSD, 0.765);

  const costJan = calculateRequestApiCost({
    model: 'gemini-4-hydrogen-high',
    inputTokens: 400000,
    cacheReadTokens: 200000,
    outputTokens: 20000,
    date: '2027-01-15'
  });
  assert.equal(costJan.isPriced, true);
  assert.equal(costJan.costUSD, 0.765);

  const refHydrogen = calculateReferenceModelCost({
    inputTokens: 400000,
    cacheTokens: 200000,
    outputTokens: 20000,
    totalTokens: 620000
  }, 'gemini-4-hydrogen', { pricingDate: '2026-11-13', mode: 'all' });
  assert.equal(refHydrogen.modelDisplayName, 'Gemini 4 Hydrogen');
  assert.equal(refHydrogen.totalCostUSD, 0.765);

  // 4) resolveModelQuota：非空占位 modelId 下优先精确命中对应档位的 modelOrAlias.model
  const hydrogenTierConfigs = [
    {
      modelId: 'MODEL_PLACEHOLDER_M501',
      modelOrAlias: { model: 'gemini-4-hydrogen-xhigh' },
      label: 'Gemini 4 Hydrogen (XHigh)',
      quotaInfo: { remainingFraction: 0.86, resetTime: '2026-11-13T06:54:16Z' }
    },
    {
      modelId: 'MODEL_PLACEHOLDER_M502',
      modelOrAlias: { model: 'gemini-4-hydrogen-low' },
      label: 'Gemini 4 Hydrogen (Low)',
      quotaInfo: { remainingFraction: 0.42, resetTime: '2026-11-13T06:54:16Z' }
    }
  ];
  const exactLowQuota = resolveModelQuota('gemini-4-hydrogen-low', hydrogenTierConfigs);
  assert.ok(exactLowQuota);
  assert.equal(exactLowQuota.poolKey, 'gemini-4-hydrogen');
  assert.equal(exactLowQuota.poolName, 'Gemini 4 Hydrogen 配额池');
  assert.equal(exactLowQuota.label, 'Gemini 4 Hydrogen (Low)');
  assert.equal(exactLowQuota.remainingFraction, 0.42);

  // 5) 历史账本兼容重算：旧版未收录时落盘的 isPriced=false Hydrogen 记录升级后自动识别重算
  const agDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-hydrogen-upgrade-'));
  const cliDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-hydrogen-upgrade-cli-'));
  try {
    fs.writeFileSync(
      path.join(agDir, 'pricing_ledger_v1.json'),
      JSON.stringify({
        schemaVersion: 1,
        calls: {
          resp_h2_old: {
            callId: 'resp_h2_old',
            source: 'desktop',
            cascadeId: '11111111-aaaa-4444-8888-bbbbbbbbbbbb',
            stepIndex: 1,
            model: 'Gemini 4 Hydrogen (XHigh)',
            modelKey: null,
            inputTokens: 400000,
            cacheTokens: 200000,
            cacheReadTokens: 200000,
            outputTokens: 20000,
            totalTokens: 620000,
            status: 'final',
            isPriced: false,
            costUSD: 0,
            date: '2026-11-13',
            dateSource: 'created_at',
            dateIsProvisional: false
          }
        }
      }, null, 2),
      'utf8'
    );
    const hist = await collectTokenHistoryAsync({
      force: true,
      agDir,
      agCliDir: cliDir,
      userStatus: { userTier: { name: 'Pro' }, planStatus: { availablePromptCredits: 500 } }
    });
    assert.equal(hist.costEstimate.pricedCostUSD, 0.765);
    assert.equal(hist.costEstimate.unpricedTokens, 0);

    // 新入账的 Hydrogen 调用直接落盘 modelKey='gemini-4-hydrogen' 与准确费用
    const recRes = recordModelCalls([parseGeneratorCall({
      stepIndices: [2],
      status: 'final',
      created_at: '2026-11-13T12:00:00Z',
      chatModel: {
        modelDisplayName: 'Gemini 4 Hydrogen (XHigh)',
        responseModel: 'gemini-4-hydrogen-xhigh',
        usage: { inputTokens: 400000, cacheReadTokens: 200000, outputTokens: 20000, responseId: 'resp_h2_new' }
      }
    }, '11111111-aaaa-4444-8888-bbbbbbbbbbbb', 'desktop')], { agDir });
    assert.equal(recRes.ok, true);
    assert.equal(recRes.changed, true);
    const savedNew = loadPricingLedger(agDir).calls.resp_h2_new;
    assert.equal(savedNew.modelKey, 'gemini-4-hydrogen');
    assert.equal(savedNew.isPriced, true);
    assert.equal(savedNew.costUSD, 0.765);
  } finally {
    fs.rmSync(agDir, { recursive: true, force: true });
    fs.rmSync(cliDir, { recursive: true, force: true });
  }
});
