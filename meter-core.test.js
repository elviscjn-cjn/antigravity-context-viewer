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
  isValidExternalUrl,
  groupModelProduct,
  detectModelVendor,
  formatEffortLabel,
  formatTokensK,
  isValidSpeedSample,
  computeMedian,
  summarizeSpeedByModel,
  MAX_SPEED_SAMPLES_PER_MODEL
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

test('产品分组严守档位白名单、不破坏 Carbon/Argon 与代际，且不改变 normalizeModelId', () => {
  const gLow = groupModelProduct({ modelId: 'gemini-4-hydrogen-low', label: 'Gemini 4 Hydrogen (Low)' });
  const gHigh = groupModelProduct({ modelId: 'gemini-4-hydrogen-high', label: 'Gemini 4 Hydrogen (High)' });
  assert.equal(gLow.productKey, gHigh.productKey);
  assert.equal(gLow.productLabel, 'Gemini 4 Hydrogen');
  assert.equal(gLow.effort, 'Low');
  assert.equal(gHigh.effort, 'High');
  assert.equal(gLow.vendor, 'Google');

  const orchCarbon = groupModelProduct({ modelId: 'orchestrator-carbon', label: 'Orchestrator (Carbon)' });
  const orchArgon = groupModelProduct({ modelId: 'orchestrator-argon', label: 'Orchestrator (Argon)' });
  assert.notEqual(orchCarbon.productKey, orchArgon.productKey);
  assert.equal(orchCarbon.productLabel, 'Orchestrator (Carbon)');
  assert.equal(orchArgon.productLabel, 'Orchestrator (Argon)');
  assert.equal(orchCarbon.effort, null);

  const geminiArgon = groupModelProduct({ modelId: 'gemini-4-argon', label: 'Gemini 4 Argon' });
  assert.notEqual(geminiArgon.productKey, orchArgon.productKey);

  const g38Flash = groupModelProduct({ modelId: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' });
  const g4Flash = groupModelProduct({ modelId: 'gemini-4-flash', label: 'Gemini 4 Flash' });
  assert.notEqual(g38Flash.productKey, g4Flash.productKey);

  assert.equal(formatEffortLabel('extra_high'), 'Extra High');
  assert.equal(detectModelVendor('Claude Sonnet 4.6', 'claude-sonnet-4-6'), 'Anthropic');
  assert.equal(detectModelVendor('GPT-5.4 Mini', 'gpt-5-4-mini'), 'OpenAI');

  // 验证 normalizeModelId 计费归一化未被改动
  assert.equal(normalizeModelId('gemini-3.8-flash-high'), 'gemini-3.8-flash');
  assert.equal(normalizeModelId('gemini-4-argon-low'), 'gemini-4-argon');
  assert.equal(normalizeModelId('gemini-3.1-pro-high'), 'gemini-3.1-pro-preview');
});

test('formatTokensK 与速度统计纯函数：中位数、样本数、无效样本排除与 200 条上限', () => {
  assert.equal(formatTokensK(512000), '512K');
  assert.equal(formatTokensK(256000), '256K');
  assert.equal(formatTokensK(786432), '786.4K');
  assert.equal(formatTokensK(1048576), '1.05M');
  assert.equal(formatTokensK(null), '—');

  assert.equal(computeMedian([10, 50, 20]), 20);
  assert.equal(computeMedian([10, 20, 30, 40]), 25);
  assert.equal(computeMedian([]), null);

  assert.equal(isValidSpeedSample({ status: 'final', outputTokens: 100, durationSec: 2 }), true);
  assert.equal(isValidSpeedSample({ status: 'streaming', outputTokens: 100, durationSec: 2 }), false);
  assert.equal(isValidSpeedSample({ status: 'final', isEstimated: true, outputTokens: 100, durationSec: 2 }), false);
  assert.equal(isValidSpeedSample({ status: 'final', isSynthetic: true, outputTokens: 100, durationSec: 2 }), false);
  assert.equal(isValidSpeedSample({ status: 'final', outputTokens: 0, durationSec: 2 }), false);
  assert.equal(isValidSpeedSample({ status: 'final', outputTokens: 100, durationSec: 0 }), false);

  const now = Date.parse('2026-11-13T12:00:00Z');
  const calls = [
    // 模型 A: 2 条有效样本 + 1 条无效估算（排除）+ 1 条缺失 ttft（保持 null）
    { callId: 'a1', modelExactId: 'gemini-4-hydrogen-low', modelLabel: 'Gemini 4 Hydrogen (Low)', status: 'final', outputTokens: 100, durationSec: 2, tps: 50, timestamp: now - 1000 },
    { callId: 'a2', modelExactId: 'gemini-4-hydrogen-low', modelLabel: 'Gemini 4 Hydrogen (Low)', status: 'final', outputTokens: 200, durationSec: 2, tps: 100, ttftSec: 0.8, timestamp: now - 500 },
    { callId: 'a-est', modelExactId: 'gemini-4-hydrogen-low', modelLabel: 'Gemini 4 Hydrogen (Low)', status: 'final', isEstimated: true, outputTokens: 500, durationSec: 1, tps: 500, timestamp: now - 200 }
  ];
  // 模型 B: 205 条样本（最旧 5 条 tps=10 应被 200 条上限裁掉，最近 200 条 tps=80）
  for (let i = 0; i < 205; i++) {
    const isOld = i < 5;
    calls.push({
      callId: `b-${i}`,
      modelExactId: 'claude-sonnet-4-6',
      modelLabel: 'Claude Sonnet 4.6',
      status: 'final',
      outputTokens: isOld ? 20 : 160,
      durationSec: 2,
      tps: isOld ? 10 : 80,
      ttftSec: 1.2,
      timestamp: now - (205 - i) * 1000
    });
  }

  assert.equal(MAX_SPEED_SAMPLES_PER_MODEL, 200);
  const summary = summarizeSpeedByModel(calls, { nowMs: now });
  const rowA = summary.find(r => r.modelExactId === 'gemini-4-hydrogen-low');
  const rowB = summary.find(r => r.modelExactId === 'claude-sonnet-4-6');
  assert.ok(rowA && rowB);
  assert.equal(rowA.count, 2);
  assert.equal(rowA.lowSample, true);
  assert.equal(rowA.medianTps, 75);
  assert.equal(rowA.medianTtft, 0.8); // 缺失 ttft 的 a1 不补零，仅按有效 ttft 计算
  assert.equal(rowB.count, 200);
  assert.equal(rowB.lowSample, false);
  assert.equal(rowB.medianTps, 80);
});

test('groupModelProduct: Hydrogen 与 Hydrogen (XHigh) 归入同一模型产品，Carbon/Argon/Orchestrator 保持独立', () => {
  const { groupModelProduct } = require('./meter-core');
  const hMed = groupModelProduct('Gemini 4 Hydrogen (Medium)', 'gemini-4-hydrogen-medium');
  const hXHigh = groupModelProduct('Gemini 4 Hydrogen (XHigh)', 'gemini-4-hydrogen-xhigh');
  const argon = groupModelProduct('Gemini 4 Argon (High)', 'gemini-4-argon-high');
  const carbon = groupModelProduct('Gemini 4 Carbon', 'gemini-4-carbon-disabled');
  const orch = groupModelProduct('Orchestrator (Argon)', 'orchestrator-argon');

  assert.equal(hMed.productKey, hXHigh.productKey);
  assert.equal(hMed.productLabel, 'Gemini 4 Hydrogen');
  assert.equal(hXHigh.effort, 'XHigh');
  assert.notEqual(argon.productKey, hMed.productKey);
  assert.notEqual(carbon.productKey, hMed.productKey);
  assert.notEqual(orch.productKey, argon.productKey);
});
