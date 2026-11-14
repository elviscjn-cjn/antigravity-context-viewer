const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const core = require('./meter-core');
const collector = require('./meter-collector');
const engine = require('./src/renderer/context-budget-engine');
const installer = require('./modular-installer');

const { groupModelProduct, resolveStableModelId } = core;

const SAMPLE_CATALOG = [
  {
    modelId: 'MODEL_PLACEHOLDER_M37',
    value: 1037,
    modelOrAlias: { model: 'MODEL_PLACEHOLDER_M37' },
    label: 'Gemini 3.8 Flash',
    isHistorical: false
  },
  {
    modelId: 'MODEL_CLAUDE_4_OPUS_THINKING',
    value: 291,
    modelOrAlias: { model: 'MODEL_CLAUDE_4_OPUS_THINKING' },
    label: 'Claude Opus 4.6 (Thinking)',
    isHistorical: false
  },
  {
    modelId: 'MODEL_PLACEHOLDER_M104',
    value: 1104,
    modelOrAlias: { model: 'MODEL_PLACEHOLDER_M104' },
    label: 'Carbon',
    tagTitle: 'Unavailable',
    tagDescription: 'Model temporarily unavailable',
    unavailable: true,
    isHistorical: false
  },
  {
    modelId: 'MODEL_PLACEHOLDER_M105',
    value: 1105,
    modelOrAlias: { model: 'MODEL_PLACEHOLDER_M105' },
    label: 'Argon',
    tagTitle: 'Unavailable',
    unavailable: true,
    isHistorical: false
  },
  {
    modelId: 'MODEL_PLACEHOLDER_M106',
    value: 1106,
    modelOrAlias: { model: 'MODEL_PLACEHOLDER_M106' },
    label: 'Hydrogen',
    tagTitle: 'Unavailable',
    unavailable: true,
    isHistorical: false
  },
  {
    modelId: 'claude-opus-5-5',
    modelOrAlias: { model: 'claude-opus-5-5' },
    label: 'Claude Opus 5.5',
    isHistorical: true
  }
];

function makeEnvelope(payloadOrBytes, flags = 0) {
  const bytes = payloadOrBytes instanceof Uint8Array
    ? payloadOrBytes
    : new TextEncoder().encode(JSON.stringify(payloadOrBytes));
  const out = new Uint8Array(5 + bytes.length);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint8(0, flags);
  view.setUint32(1, bytes.length, false);
  out.set(bytes, 5);
  return out;
}

function encodeStringField(fieldNo, str) {
  return engine.encodeLengthDelimitedField(fieldNo, new TextEncoder().encode(str));
}

function concatBytes(...chunks) {
  const total = chunks.reduce((acc, c) => acc + c.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.length;
  }
  return out;
}

test('ELV-41 1: 真实 ConnectRPC 5-byte JSON 与压缩帧防护 + WebSocket Lcc 帧编解码', () => {
  const flashKey = groupModelProduct(SAMPLE_CATALOG[0]).productKey;
  const opus46Key = groupModelProduct(SAMPLE_CATALOG[1]).productKey;
  const prefs = {
    [flashKey]: { mode: 'fixed', limitTokens: 512000 },
    [opus46Key]: { mode: 'fixed', limitTokens: 333333 }
  };

  // A. Connect 5-byte Envelope JSON (SendUserCascadeMessage)
  const reqPayload = {
    cascadeId: 'conv-env-1',
    cascadeConfig: {
      plannerConfig: { planModel: 'MODEL_PLACEHOLDER_M37' }
    }
  };
  const envBytes = makeEnvelope(reqPayload, 0);
  const txEnv = engine.transformOutgoingSendRequest(envBytes, {
    channel: 'fetch',
    urlOrProcedure: '/exa.language_server_pb.LanguageServerService/SendUserCascadeMessage',
    scopeMode: 'per_model',
    contextPreferencesMap: prefs,
    knownConfigs: SAMPLE_CATALOG,
    groupProduct: groupModelProduct,
    resolveStableModelId
  });
  assert.equal(txEnv.handled, true);
  assert.equal(txEnv.modified, true);
  assert.equal(txEnv.sentLimitTokens, 512000);
  const unpackedEnv = engine.unpackTransportPayload(txEnv.output);
  assert.equal(unpackedEnv.format, 'connect_envelope');
  assert.equal(unpackedEnv.payload.cascadeConfig.checkpointConfig.maxTokenLimit, 512000);

  // B. flags=1 压缩帧不可破坏，必须标记 uninjectable 并原样透传
  const compressed = makeEnvelope(reqPayload, 1);
  const txCompressed = engine.transformOutgoingSendRequest(compressed, {
    channel: 'fetch',
    urlOrProcedure: '/exa.language_server_pb.LanguageServerService/SendUserCascadeMessage',
    scopeMode: 'per_model',
    contextPreferencesMap: prefs,
    knownConfigs: SAMPLE_CATALOG,
    groupProduct: groupModelProduct,
    resolveStableModelId
  });
  assert.equal(txCompressed.uninjectable, true);
  assert.equal(txCompressed.modified, false);

  // C. 宿主 Lcc WebSocket JSON 封装（payload 携带任意非整千 custom 值 333333，完整保留外层 streamId/headers/type）
  const lccFrame = JSON.stringify({
    streamId: 'stream-99',
    type: 'start',
    procedure: '/exa.language_server_pb.LanguageServerService/SendUserCascadeMessage',
    stream: false,
    headers: { 'x-codeium-csrf-token': 'tok-1' },
    payload: {
      cascadeId: 'conv-ws-opus',
      cascadeConfig: {
        plannerConfig: { planModel: 'MODEL_CLAUDE_4_OPUS_THINKING' },
        conversationHistoryConfig: {}
      }
    }
  });
  const txWs = engine.transformOutgoingSendRequest(lccFrame, {
    channel: 'ws_frame',
    scopeMode: 'per_model',
    contextPreferencesMap: prefs,
    knownConfigs: SAMPLE_CATALOG,
    groupProduct: groupModelProduct,
    resolveStableModelId
  });
  assert.equal(txWs.handled, true);
  assert.equal(txWs.modified, true);
  assert.equal(txWs.sentLimitTokens, 333333);
  const outFrame = JSON.parse(txWs.output);
  assert.equal(outFrame.streamId, 'stream-99');
  assert.equal(outFrame.headers['x-codeium-csrf-token'], 'tok-1');
  assert.equal(outFrame.payload.cascadeConfig.checkpointConfig.maxTokenLimit, 333333);
  assert.deepEqual(outFrame.payload.cascadeConfig.conversationHistoryConfig, {});

  // D. StartCascade 不含 cascade_config，必须严格透传不注入虚构字段
  const startCascadeFrame = JSON.stringify({
    streamId: 'stream-1',
    type: 'start',
    procedure: '/exa.language_server_pb.LanguageServerService/StartCascade',
    stream: false,
    headers: {},
    payload: { source: 1 }
  });
  const txStart = engine.transformOutgoingSendRequest(startCascadeFrame, {
    channel: 'ws_frame',
    scopeMode: 'unified',
    unifiedPreference: { mode: 'fixed', limitTokens: 512000 },
    groupProduct: groupModelProduct
  });
  assert.equal(txStart.handled, false);
  assert.equal(txStart.passthrough, true);
});

test('ELV-41 2: 二进制 Protobuf 精确使用真实字段号 (5 -> 2 -> 5)，并无损保留其余字段与动态清除', () => {
  // 构造真实 SendUserCascadeMessageRequest 二进制：
  // 1: cascade_id = "conv-bin-1"
  // 5: cascade_config -> 1: planner_config(1: plan_model = 1037), 3: executor_config(opaque 保留字节)
  // 9: sibling top-level bytes (保留)
  const plannerBytes = engine.encodeVarintField(1, 1037); // PLACEHOLDER_M37 -> Flash
  const existingCpBytes = concatBytes(
    engine.encodeVarintField(2, 1), // is_sync = true
    encodeStringField(36, '512K') // context_window = '512K'
  );
  const executorOpaque = encodeStringField(1, 'preserve-executor');
  const cascadeCfgBytes = concatBytes(
    engine.encodeLengthDelimitedField(1, plannerBytes),
    engine.encodeLengthDelimitedField(2, existingCpBytes),
    engine.encodeLengthDelimitedField(3, executorOpaque)
  );
  const topReqBytes = concatBytes(
    encodeStringField(1, 'conv-bin-1'),
    engine.encodeLengthDelimitedField(5, cascadeCfgBytes),
    encodeStringField(9, 'preserve-top')
  );

  // 注入非整千 333333
  const prefs = {
    'product:google:gemini-3.8-flash': { mode: 'fixed', limitTokens: 333333 }
  };
  const txProto = engine.transformOutgoingSendRequest(topReqBytes, {
    channel: 'fetch',
    urlOrProcedure: '/exa.language_server_pb.LanguageServerService/SendUserCascadeMessage',
    contentType: 'application/proto',
    scopeMode: 'per_model',
    contextPreferencesMap: prefs,
    knownConfigs: SAMPLE_CATALOG,
    groupProduct: groupModelProduct,
    resolveStableModelId
  });
  assert.equal(txProto.handled, true);
  assert.equal(txProto.modified, true);
  assert.equal(txProto.cascadeId, 'conv-bin-1');
  assert.equal(txProto.productKey, 'product:google:gemini-3.8-flash');
  assert.equal(txProto.sentLimitTokens, 333333);

  // 解析注入后的 wire 字段号，确认绝对是 SendUser(5).CascadeConfig(2).CheckpointConfig(5)，而非错误字段 3/2
  const meta = engine.extractProtoSendMessageMetadata(txProto.output);
  assert.equal(meta.cascadeId, 'conv-bin-1');
  assert.equal(meta.planModelEnum, 1037);
  assert.equal(meta.existingMaxTokenLimit, 333333);
  assert.equal(meta.existingContextWindow, '512K');

  const topFields = engine.parseProtoFields(txProto.output);
  assert.ok(topFields.some(f => f.fieldNumber === 9), '顶层保留字段不可丢失');
  const cfgField = topFields.find(f => f.fieldNumber === 5);
  const cfgSub = engine.parseProtoFields(cfgField.bytesValue);
  assert.ok(cfgSub.some(f => f.fieldNumber === 3), 'executor_config(3) 必须完整保留且不被 checkpoint_config 覆盖');
  const cpSub = engine.parseProtoFields(cfgSub.find(f => f.fieldNumber === 2).bytesValue);
  assert.equal(Number(cpSub.find(f => f.fieldNumber === 2).varintValue), 1, 'CheckpointConfig.is_sync(2) 必须保持为 true');
  assert.equal(Number(cpSub.find(f => f.fieldNumber === 5).varintValue), 333333, 'CheckpointConfig.max_token_limit(5) 必须精确等于 333333');

  // 切回 dynamic 后，再从同一二进制报文清除 max_token_limit(5)，is_sync(2) 与 context_window(36) 仍完整保留
  const txClean = engine.transformOutgoingSendRequest(txProto.output, {
    channel: 'fetch',
    urlOrProcedure: '/exa.language_server_pb.LanguageServerService/SendUserCascadeMessage',
    contentType: 'application/proto',
    scopeMode: 'per_model',
    contextPreferencesMap: { 'product:google:gemini-3.8-flash': { mode: 'dynamic', limitTokens: null } },
    knownConfigs: SAMPLE_CATALOG,
    groupProduct: groupModelProduct,
    resolveStableModelId
  });
  assert.equal(txClean.modified, true);
  const metaAfter = engine.extractProtoSendMessageMetadata(txClean.output);
  assert.equal(metaAfter.existingMaxTokenLimit, null, 'dynamic 必须清除残留固定 max_token_limit');
  assert.equal(metaAfter.existingContextWindow, '512K');
});

test('ELV-41 3: 面板正在查看模型与外发请求隔离、缺模型不猜测透传、Client $typeName 兼容', () => {
  const prefs = {
    'product:google:gemini-3.8-flash': { mode: 'fixed', limitTokens: 512000 },
    'product:anthropic:claude-opus-4-6-thinking': { mode: 'fixed', limitTokens: 600000 }
  };

  // Scenario A: 请求缺少模型且无已验证同会话绑定 -> 严禁按面板正在查看的模型猜测注入，必须透传并标记 uninjectable
  const unknownReq = {
    cascadeId: 'conv-no-model',
    cascadeConfig: { plannerConfig: {} }
  };
  const txUnknown = engine.transformOutgoingSendRequest(unknownReq, {
    channel: 'client_object',
    scopeMode: 'per_model',
    contextPreferencesMap: prefs,
    knownConfigs: SAMPLE_CATALOG,
    verifiedConversationBindings: { 'conv-other': { productKey: 'product:anthropic:claude-opus-4-6-thinking' } },
    groupProduct: groupModelProduct,
    resolveStableModelId
  });
  assert.equal(txUnknown.uninjectable, true);
  assert.equal(txUnknown.modified, false);
  assert.equal(unknownReq.cascadeConfig.checkpointConfig, undefined);

  // Scenario B: 请求携带 @bufbuild/protobuf v2 $typeName（Flash），面板哪怕正查看 Opus，仍按 Flash 写入 512000 并保留 $typeName
  const protoJsReq = {
    $typeName: 'exa.language_server_pb.SendUserCascadeMessageRequest',
    cascadeId: 'conv-flash-buf',
    cascadeConfig: {
      $typeName: 'exa.cortex_pb.CascadeConfig',
      plannerConfig: {
        $typeName: 'exa.cortex_pb.CascadePlannerConfig',
        planModel: 1037
      }
    }
  };
  const txBuf = engine.transformOutgoingSendRequest(protoJsReq, {
    channel: 'client_object',
    scopeMode: 'per_model',
    contextPreferencesMap: prefs,
    knownConfigs: SAMPLE_CATALOG,
    groupProduct: groupModelProduct,
    resolveStableModelId
  });
  assert.equal(txBuf.modified, true);
  assert.equal(txBuf.productKey, 'product:google:gemini-3.8-flash');
  assert.equal(protoJsReq.cascadeConfig.checkpointConfig.$typeName, 'exa.cortex_pb.CheckpointConfig');
  assert.equal(protoJsReq.cascadeConfig.checkpointConfig.maxTokenLimit, 512000);

  // Scenario C: 切回 default 时清理既有 maxTokenLimit 且不串值
  const txDef = engine.transformOutgoingSendRequest(protoJsReq, {
    channel: 'client_object',
    scopeMode: 'per_model',
    contextPreferencesMap: { 'product:google:gemini-3.8-flash': { mode: 'default', limitTokens: null } },
    knownConfigs: SAMPLE_CATALOG,
    groupProduct: groupModelProduct,
    resolveStableModelId
  });
  assert.equal(txDef.modified, true);
  assert.equal(protoJsReq.cascadeConfig.checkpointConfig.maxTokenLimit, undefined);
});

test('ELV-41 4: 因果状态机：并发会话隔离、旧快照不可伪造确认、发送失败/超时/已知上限与未知不一致准确区分', () => {
  let fakeNow = 10000;
  const tracker = engine.createContextBudgetTracker({
    confirmTimeoutMs: 45000,
    now: () => fakeNow
  });
  const flashProd = { productKey: 'product:google:gemini-3.8-flash', productLabel: 'Gemini 3.8 Flash' };
  const opusProd = { productKey: 'product:anthropic:claude-opus-4-6-thinking', productLabel: 'Claude Opus 4.6 (Thinking)' };

  // 1. 历史快照 call-1 (step=2, budget=983040) 在 t=1000 观测
  tracker.recordObservation({
    convoId: 'conv-flash',
    productKey: flashProd.productKey,
    budget: 983040,
    callId: 'call-1',
    stepCount: 2,
    ts: 1000
  });

  // 2. 用户在 conv-flash (t=10000) 发送设定 512000，并发在 conv-opus 发送 600000
  const dispFlash = tracker.beginDispatch({
    cascadeId: 'conv-flash',
    productKey: flashProd.productKey,
    scopeMode: 'per_model',
    targetMode: 'fixed',
    targetLimitTokens: 512000,
    sentMode: 'fixed',
    sentLimitTokens: 512000,
    timestamp: 10000
  });
  const dispOpus = tracker.beginDispatch({
    cascadeId: 'conv-opus',
    productKey: opusProd.productKey,
    scopeMode: 'per_model',
    targetMode: 'fixed',
    targetLimitTokens: 600000,
    sentMode: 'fixed',
    sentLimitTokens: 600000,
    timestamp: 10010
  });

  // 3. 反复轮询到同一个旧快照 call-1 (哪怕调用时间已是 12000)，绝不伪造新时间戳导致假确认或假 mismatch
  fakeNow = 12000;
  tracker.recordObservation({
    convoId: 'conv-flash',
    productKey: flashProd.productKey,
    budget: 983040,
    callId: 'call-1',
    stepCount: 2,
    ts: 12000
  });
  const evalWait = tracker.evaluateStatus({
    product: flashProd,
    scopeMode: 'per_model',
    pref: { mode: 'fixed', limitTokens: 512000 },
    activeConvId: 'conv-flash',
    now: 12000
  });
  assert.equal(evalWait.status, 'dispatched_pending_confirm', '旧快照不能被当作本次发送后的新观测');

  // 4. 在另一全新空白会话 conv-flash-2 上查看 Flash：不应被 conv-flash 的发送/观测污染
  const evalOtherConv = tracker.evaluateStatus({
    product: flashProd,
    scopeMode: 'per_model',
    pref: { mode: 'fixed', limitTokens: 512000 },
    activeConvId: 'conv-flash-2',
    now: 12000
  });
  assert.equal(evalOtherConv.status, 'saved_pending_dispatch', '不同会话绝不可串用发送和确认状态');

  // 5. conv-flash 收到新步骤 call-2 (budget=512000) -> 精确确认 confirmed
  tracker.recordObservation({
    convoId: 'conv-flash',
    productKey: flashProd.productKey,
    budget: 512000,
    callId: 'call-2',
    stepCount: 4,
    ts: 14000
  });
  const evalFlashOk = tracker.evaluateStatus({
    product: flashProd,
    scopeMode: 'per_model',
    pref: { mode: 'fixed', limitTokens: 512000 },
    activeConvId: 'conv-flash',
    now: 14000
  });
  assert.equal(evalFlashOk.status, 'confirmed');

  // 6. 修改目标为 333333 但未再次发送 -> 必须回退为 saved_pending_dispatch，不能复用旧的 512000 确认
  const evalEdited = tracker.evaluateStatus({
    product: flashProd,
    scopeMode: 'per_model',
    pref: { mode: 'fixed', limitTokens: 333333 },
    activeConvId: 'conv-flash',
    now: 14500
  });
  assert.equal(evalEdited.status, 'saved_pending_dispatch');

  // 7. conv-opus 收到 186368 且无明确服务端上限元数据 -> mismatch（不能臆断为模型上限限制）
  tracker.recordObservation({
    convoId: 'conv-opus',
    productKey: opusProd.productKey,
    budget: 186368,
    callId: 'opus-call-1',
    stepCount: 2,
    ts: 15000
  });
  const evalOpusMismatch = tracker.evaluateStatus({
    product: opusProd,
    scopeMode: 'per_model',
    pref: { mode: 'fixed', limitTokens: 600000 },
    activeConvId: 'conv-opus',
    now: 15000
  });
  assert.equal(evalOpusMismatch.status, 'mismatch');

  // 8. 若存在明确 serviceLimit (如 200000) 且设定值 600000 超限，才判定为 clamped_by_model_limit
  tracker.recordObservation({
    convoId: 'conv-opus',
    productKey: opusProd.productKey,
    budget: 186368,
    serviceLimit: 200000,
    callId: 'opus-call-2',
    stepCount: 3,
    ts: 16000
  });
  const evalOpusClamped = tracker.evaluateStatus({
    product: opusProd,
    scopeMode: 'per_model',
    pref: { mode: 'fixed', limitTokens: 600000 },
    activeConvId: 'conv-opus',
    now: 16000
  });
  assert.equal(evalOpusClamped.status, 'clamped_by_model_limit');

  // 9. 发送失败（send_failed）与超时未确认（timeout_unconfirmed）
  tracker.updateDispatchStatus(dispFlash.dispatchId, { status: 'send_failed', errorMessage: 'HTTP 502' });
  const evalFailed = tracker.evaluateStatus({
    product: flashProd,
    scopeMode: 'per_model',
    pref: { mode: 'fixed', limitTokens: 512000 },
    activeConvId: 'conv-flash',
    now: 17000
  });
  assert.equal(evalFailed.status, 'send_failed');

  tracker.beginDispatch({
    cascadeId: 'conv-timeout',
    productKey: flashProd.productKey,
    scopeMode: 'per_model',
    targetMode: 'fixed',
    targetLimitTokens: 333333,
    sentMode: 'fixed',
    sentLimitTokens: 333333,
    timestamp: 20000
  });
  const evalTimeout = tracker.evaluateStatus({
    product: flashProd,
    scopeMode: 'per_model',
    pref: { mode: 'fixed', limitTokens: 333333 },
    activeConvId: 'conv-timeout',
    now: 70000
  });
  assert.equal(evalTimeout.status, 'timeout_unconfirmed');
});

test('ELV-41 5: 冷启动 preload 注入的主世界客户端装饰器链式兼容、防重包装与错误回传', async () => {
  const preloadCode = installer.generateMeterPreloadCode();
  assert.ok(preloadCode.includes('webFrame.executeJavaScript'), 'preload 必须在 contextIsolation 下注入主世界脚本');
  assert.ok(installer.validateSyntax(preloadCode, 'dist/preload.js'));

  const stripped = installer.cleanPreloadSource(`// orig\n${preloadCode}`);
  assert.equal(stripped.includes('__JETSKI_LS_CLIENT_DECORATOR__'), false, '卸载清洗必须完整清除冷启动装饰器');

  const hookCalls = [];
  const hookOutcomes = [];
  let prevCalled = 0;

  const sandbox = {
    globalThis: {},
    WeakSet,
    Proxy,
    Reflect
  };
  sandbox.globalThis = sandbox;
  sandbox.globalThis.__JETSKI_LS_CLIENT_DECORATOR__ = (c) => {
    prevCalled++;
    return c;
  };
  sandbox.globalThis.__AG_METER_ON_SEND_MESSAGE__ = (req, ch) => {
    hookCalls.push({ req, ch });
    req.cascadeConfig = req.cascadeConfig || {};
    req.cascadeConfig.checkpointConfig = { $typeName: 'exa.cortex_pb.CheckpointConfig', maxTokenLimit: 512000 };
    return { dispatchId: 'disp-dec-1' };
  };
  sandbox.globalThis.__AG_METER_ON_SEND_RESULT__ = (id, ok, err) => {
    hookOutcomes.push({ id, ok, err: err ? String(err.message || err) : null });
  };

  vm.runInNewContext(installer.generateMainWorldDecoratorScript(), sandbox);

  const rawClient = {
    sendCount: 0,
    async sendUserCascadeMessage(req) {
      this.sendCount++;
      assert.equal(req.cascadeConfig.checkpointConfig.maxTokenLimit, 512000);
      return { ok: true };
    },
    async startCascade() {
      return { cascadeId: 'new-c' };
    }
  };

  const wrappedOnce = sandbox.globalThis.__JETSKI_LS_CLIENT_DECORATOR__(rawClient);
  const wrappedTwice = sandbox.globalThis.__JETSKI_LS_CLIENT_DECORATOR__(wrappedOnce);
  assert.equal(wrappedOnce, wrappedTwice, '不可对已包装客户端重复包装');
  assert.equal(prevCalled, 1, '必须保留并调用原有装饰器');

  await wrappedOnce.startCascade({});
  assert.equal(hookCalls.length, 0, 'StartCascade 不得触发 sendUserCascadeMessage 钩子');

  await wrappedOnce.sendUserCascadeMessage({ cascadeId: 'c1', cascadeConfig: {} });
  assert.equal(hookCalls.length, 1);
  assert.equal(hookOutcomes.length, 1);
  assert.equal(hookOutcomes[0].ok, true);

  // 测试拒绝回传
  const failClient = {
    sendUserCascadeMessage() {
      return Promise.reject(new Error('network boom'));
    }
  };
  const wrappedFail = sandbox.globalThis.__JETSKI_LS_CLIENT_DECORATOR__(failClient);
  await assert.rejects(() => wrappedFail.sendUserCascadeMessage({ cascadeId: 'c2' }), /network boom/);
  assert.equal(hookOutcomes.at(-1).ok, false);
});

test('ELV-41 6: 存储层 contextScopeMode 与 contextUnifiedPreference 隔离持久化与升级平滑迁移', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-meter-scope-iso-'));
  try {
    const defSettings = collector.getPluginSettings({ agDir: tmpDir });
    assert.equal(defSettings.contextScopeMode, 'unified');
    assert.equal(defSettings.contextUnifiedPreference.mode, 'default');

    const saveUni = collector.savePluginSettings({
      contextScopeMode: 'unified',
      contextUnifiedPreference: { mode: 'fixed', limitTokens: 480000 }
    }, { agDir: tmpDir });
    assert.equal(saveUni.ok, true);

    const loadedUni = collector.getPluginSettings({ agDir: tmpDir });
    assert.equal(loadedUni.contextScopeMode, 'unified');
    assert.equal(loadedUni.contextUnifiedPreference.limitTokens, 480000);

    const savePer = collector.savePluginSettings({
      contextScopeMode: 'per_model',
      contextPreference: { modelId: 'claude-opus-5-5-thinking', mode: 'fixed', limitTokens: 600000 }
    }, { agDir: tmpDir });
    assert.equal(savePer.ok, true);

    const loadedPer = collector.getPluginSettings({ agDir: tmpDir });
    assert.equal(loadedPer.contextScopeMode, 'per_model');
    assert.equal(loadedPer.contextUnifiedPreference.limitTokens, 480000);
    assert.equal(loadedPer.contextPreferences['claude-opus-5-5-thinking'].limitTokens, 600000);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('ELV-43 7: sanitizeCascadeModelConfig 保留 Carbon/Argon/Hydrogen Unavailable 状态与枚举前缀对齐', () => {
  const sanitizedCatalog = SAMPLE_CATALOG.map(collector.sanitizeCascadeModelConfig);
  const carbon = sanitizedCatalog.find(c => c.label === 'Carbon');
  const argon = sanitizedCatalog.find(c => c.label === 'Argon');
  const hydrogen = sanitizedCatalog.find(c => c.label === 'Hydrogen');

  assert.equal(carbon.unavailable, true);
  assert.equal(carbon.tagTitle, 'Unavailable');
  assert.equal(argon.unavailable, true);
  assert.equal(hydrogen.unavailable, true);

  // Even if raw disabled/unavailable booleans were missing and only tagTitle="Unavailable" existed:
  const tagOnlyUnavail = collector.sanitizeCascadeModelConfig({
    modelId: 'MODEL_PLACEHOLDER_M104',
    label: 'Carbon',
    tagTitle: 'Unavailable',
    tagDescription: 'Preview access disabled'
  });
  assert.equal(tagOnlyUnavail.unavailable, true);
  assert.equal(tagOnlyUnavail.unavailabilityReason, 'Preview access disabled');

  // Verify MODEL_ prefix stripping aligns Protobuf enum name with catalog
  const resolvedFlash = resolveStableModelId({ modelId: 'PLACEHOLDER_M37' }, sanitizedCatalog);
  assert.equal(resolvedFlash, 'model_placeholder_m37');
  assert.notEqual(groupModelProduct(sanitizedCatalog[1]).productKey, groupModelProduct(sanitizedCatalog[5]).productKey);
});

test('ELV-43 8: 已构建的 meter-renderer.js 端到端集成（DOM 排除、WebSocket 拦截、历史模型不覆盖当前模型）', async () => {
  const rendererCode = fs.readFileSync(path.join(__dirname, 'meter-renderer.js'), 'utf8');

  const createEl = (tag, extra = {}) => {
    const el = {
      tagName: String(tag || 'div').toUpperCase(),
      id: '',
      className: '',
      children: [],
      attributes: {},
      style: { setProperty() {}, removeProperty() {}, getPropertyValue() { return ''; } },
      classList: {
        _set: new Set(),
        add(...cs) { cs.forEach(c => this._set.add(c)); },
        remove(...cs) { cs.forEach(c => this._set.delete(c)); },
        toggle(c, f) { if (f) this._set.add(c); else this._set.delete(c); },
        contains(c) { return this._set.has(c); }
      },
      textContent: '',
      innerHTML: '',
      hidden: false,
      disabled: false,
      value: '',
      setAttribute(k, v) { this.attributes[k] = String(v); },
      getAttribute(k) { return this.attributes[k] ?? null; },
      removeAttribute(k) { delete this.attributes[k]; },
      appendChild(child) { this.children.push(child); child.parentElement = this; return child; },
      replaceChildren(...nodes) { this.children = nodes; nodes.forEach(n => { if (n) n.parentElement = this; }); },
      remove() {},
      addEventListener() {},
      removeEventListener() {},
      closest() { return null; },
      contains(target) {
        if (target === this) return true;
        return this.children.some(c => c && typeof c.contains === 'function' && c.contains(target));
      },
      cloneNode() { return createEl(this.tagName, { textContent: this.textContent }); },
      attachShadow() {
        const s = createEl('shadow');
        const idMap = new Map();
        s.getElementById = (id) => {
          if (!idMap.has(id)) {
            const node = createEl('div', { id, hidden: id === 'panel' || id === 'panel-tokens' });
            idMap.set(id, node);
          }
          return idMap.get(id);
        };
        s.querySelectorAll = () => [];
        s.querySelector = () => null;
        return s;
      },
      querySelectorAll() { return []; },
      querySelector() { return null; },
      getBoundingClientRect() { return { left: 100, top: 0, width: 120, height: 24 }; },
      ...extra
    };
    return el;
  };

  // Fake host trigger outside #ag-context-meter selecting Flash, plus a decoy inside host shadow/panel
  const realHostTrigger = createEl('button', { textContent: 'Gemini 3.8 Flash' });
  const fakeMeterTrigger = createEl('button', { textContent: 'Claude Opus 5.5' });

  const sentWsFrames = [];
  function FakeWebSocket(url) { this.url = url; }
  FakeWebSocket.prototype.send = function(data) { sentWsFrames.push(data); };

  const bodyEl = createEl('body');
  let meterHostRef = null;
  const origAppend = bodyEl.appendChild.bind(bodyEl);
  bodyEl.appendChild = (node) => {
    if (node.id === 'ag-context-meter') {
      meterHostRef = node;
      node.contains = (target) => target === fakeMeterTrigger;
      node.attachShadow = () => {
        const s = createEl('shadow');
        s.getElementById = () => null;
        s.querySelectorAll = () => [];
        s.querySelector = () => null;
        return s;
      };
    }
    return origAppend(node);
  };

  const sandbox = {
    window: null,
    globalThis: null,
    location: { protocol: 'https:', hostname: '127.0.0.1', pathname: '/c/11111111-1111-4111-8111-111111111111' },
    document: {
      body: bodyEl,
      documentElement: bodyEl,
      hidden: false,
      createElement: (tag) => createEl(tag),
      getElementById: () => null,
      querySelectorAll: (sel) => sel === '[data-testid="model-selector-trigger"]' ? [fakeMeterTrigger, realHostTrigger] : [],
      querySelector: () => null,
      addEventListener() {},
      removeEventListener() {}
    },
    localStorage: {
      _m: new Map(),
      getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
      setItem(k, v) { this._m.set(k, String(v)); },
      removeItem(k) { this._m.delete(k); }
    },
    WebSocket: FakeWebSocket,
    XMLHttpRequest: function FakeXHR() {},
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    __APP_CONFIG__: { csrfToken: 'test-csrf' },
    __AGContextMeterCore: core,
    __AGContextScopeMode: 'per_model',
    __AGContextPreferences: {
      'product:google:gemini-3.8-flash': { mode: 'fixed', limitTokens: 512000 }
    },
    setTimeout,
    clearTimeout,
    setInterval: () => 1,
    clearInterval: () => {},
    AbortController,
    TextEncoder,
    TextDecoder,
    console
  };
  sandbox.XMLHttpRequest.prototype = { open() {}, setRequestHeader() {}, send() {}, addEventListener() {} };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  vm.runInNewContext(rendererCode, sandbox);
  assert.ok(meterHostRef, 'meter-renderer 必须成功挂载');

  // 触发 state.latest 为历史模型 Opus 5.5，宿主真实选择仍应优先识别 Flash
  const selRes = sandbox.__AGContextMeter.setContextLatestForTest(
    { model: 'Claude Opus 5.5', modelId: 'claude-opus-5-5', budget: 186368 },
    SAMPLE_CATALOG.map(collector.sanitizeCascadeModelConfig)
  );
  assert.equal(selRes.activeSessionProductKey, 'product:google:gemini-3.8-flash', '必须排除插件 DOM 并以宿主选择 Flash 为准，不可被历史 Opus 5.5 覆盖');

  // 经由 WebSocket.prototype.send 发送宿主 Lcc JSON 帧，应自动注入 Flash 设定的 512000
  const ws = new sandbox.WebSocket('wss://127.0.0.1/connect-websocket');
  ws.send(JSON.stringify({
    streamId: 's-live-1',
    type: 'start',
    procedure: '/exa.language_server_pb.LanguageServerService/SendUserCascadeMessage',
    stream: false,
    headers: {},
    payload: {
      cascadeId: '11111111-1111-4111-8111-111111111111',
      cascadeConfig: { plannerConfig: { planModel: 'MODEL_PLACEHOLDER_M37' } }
    }
  }));
  assert.equal(sentWsFrames.length, 1);
  const sentObj = JSON.parse(sentWsFrames[0]);
  assert.equal(sentObj.payload.cascadeConfig.checkpointConfig.maxTokenLimit, 512000);

  await new Promise(resolve => setImmediate(resolve));
  sandbox.__AGContextMeter.dispose();
});

test('模型能力采集：GetAvailableModels 与 Step.metadata.modelInfo 提取合并且严守隐私边界', async () => {
  const availRes = {
    response: {
      models: {
        MODEL_PLACEHOLDER_M37: {
          displayName: 'Gemini 3.8 Flash',
          model: 'MODEL_PLACEHOLDER_M37',
          maxTokens: 1048576,
          maxOutputTokens: 65536,
          thinkingLevel: 'THINKING_LEVEL_HIGH',
          supportsModelInfoOverride: true,
          disabled: false
        },
        MODEL_PLACEHOLDER_M104: {
          displayName: 'Carbon',
          model: 'MODEL_PLACEHOLDER_M104',
          maxTokens: 1048576,
          maxOutputTokens: 262144,
          tagTitle: 'Unavailable',
          tagDescription: 'Model temporarily unavailable',
          disabled: true
        }
      }
    }
  };
  const parsedAvail = collector.parseAvailableModelsResponse(availRes);
  assert.equal(parsedAvail.placeholder_m37.maxTokens, 1048576);
  assert.equal(parsedAvail.placeholder_m37.maxOutputTokens, 65536);
  assert.equal(parsedAvail.placeholder_m37.capabilitySource, 'get_available_models');

  const stepsWithSecret = [
    {
      userInput: { userResponse: 'PRIVATE_USER_PROMPT_DO_NOT_LEAK_12345' },
      metadata: {
        requestedModel: { model: 'MODEL_CLAUDE_4_OPUS_THINKING' },
        modelInfo: {
          modelId: 'MODEL_CLAUDE_4_OPUS_THINKING',
          maxTokens: 200000,
          maxOutputTokens: 32000,
          thinkingBudget: 16000
        }
      }
    }
  ];
  const stepCaps = collector.extractObservedModelInfoFromSteps(stepsWithSecret);
  assert.equal(stepCaps.claude_4_opus_thinking.maxTokens, 200000);
  assert.equal(stepCaps.claude_4_opus_thinking.maxOutputTokens, 32000);
  assert.equal(stepCaps.claude_4_opus_thinking.capabilitySource, 'step_model_info');
  assert.equal(JSON.stringify(stepCaps).includes('PRIVATE_USER_PROMPT_DO_NOT_LEAK_12345'), false, '能力元数据绝不能携带任何用户对话文本');

  const statusMerged = await collector.fetchUserStatusFromHost({
    userStatus: { userStatus: { cascadeModelConfigData: { clientModelConfigs: SAMPLE_CATALOG } } },
    availableModels: availRes
  });
  const mergedWithStep = collector.mergeModelCapabilitiesIntoConfigs(
    statusMerged.cascadeModelConfigs,
    statusMerged.availableModelDetails,
    stepCaps
  ).map(collector.sanitizeCascadeModelConfig);

  const flashCfg = mergedWithStep.find(c => c.modelId === 'MODEL_PLACEHOLDER_M37');
  const opusCfg = mergedWithStep.find(c => c.modelId === 'MODEL_CLAUDE_4_OPUS_THINKING');
  const unknownCfg = mergedWithStep.find(c => c.modelId === 'MODEL_PLACEHOLDER_M106');
  assert.equal(flashCfg.maxTokens, 1048576);
  assert.equal(flashCfg.maxOutputTokens, 65536);
  assert.equal(opusCfg.maxTokens, 200000);
  assert.equal(opusCfg.maxOutputTokens, 32000);
  assert.equal(unknownCfg.maxTokens, null, '缺失元数据的模型严禁硬编码填充上下文上限');
});

test('能力参考推导公式、超限评估、统一模式逐模型预测与脱敏追踪边界', () => {
  // 1. Flash (1048576 / 65536) 在 Dynamic 下默认=983040，最大可调=983040；在 Stock ORIG 下默认钳位=256000
  const flashProd = {
    productKey: 'product:google:gemini-3.8-flash',
    productLabel: 'Gemini 3.8 Flash',
    vendor: 'Google',
    members: [{ modelId: 'placeholder_m37', maxTokens: 1048576, maxOutputTokens: 65536, capabilitySource: 'get_available_models' }]
  };
  const flashDynCap = engine.deriveModelCapabilitySummary(flashProd, { configuredMode: 'dynamic', gate3a: { clampState: 'DYN' } });
  assert.equal(flashDynCap.dynamicDefaultBudget, 983040);
  assert.equal(flashDynCap.effectiveDefaultBudget, 983040);
  assert.equal(flashDynCap.maxAdjustableTokens, 983040);
  assert.equal(flashDynCap.hasMetadata, true);

  const flashStockCap = engine.deriveModelCapabilitySummary(flashProd, { configuredMode: 'default', gate3a: { clampState: 'ORIG' } });
  assert.equal(flashStockCap.effectiveDefaultBudget, 256000, '未解锁时默认预算应诚实反映 256K 钳位');

  // 2. Hydrogen (1048576 / 262144) -> default/maxAdjustable = 786432
  const hydroProd = {
    productKey: 'product:google:gemini-4-hydrogen',
    productLabel: 'Gemini 4 Hydrogen',
    vendor: 'Google',
    members: [{ modelId: 'placeholder_m107', maxTokens: 1048576, maxOutputTokens: 262144, capabilitySource: 'get_available_models' }]
  };
  const hydroCap = engine.deriveModelCapabilitySummary(hydroProd, { configuredMode: 'dynamic' });
  assert.equal(hydroCap.maxAdjustableTokens, 786432);

  // 3. 同一产品不同档位能力不同时应检出 hasTierVariance
  const multiTierProd = {
    productKey: 'product:anthropic:claude-opus-4.6',
    productLabel: 'Claude Opus 4.6',
    vendor: 'Anthropic',
    members: [
      { modelId: 'claude_low', effort: 'Low', maxTokens: 200000, maxOutputTokens: 32000 },
      { modelId: 'claude_high', effort: 'High', maxTokens: 1000000, maxOutputTokens: 64000 }
    ]
  };
  const multiCap = engine.deriveModelCapabilitySummary(multiTierProd, { configuredMode: 'dynamic' });
  assert.equal(multiCap.hasTierVariance, true);
  assert.equal(multiCap.tierDetails.length, 2);

  // 4. 缺失元数据的小模型不可靠模型名硬编码
  const noMetaClaude = {
    productKey: 'product:anthropic:claude-next-unknown',
    productLabel: 'Claude Opus 4.6',
    vendor: 'Anthropic',
    members: [{ modelId: 'claude_next_unknown', maxTokens: null, maxOutputTokens: null }]
  };
  const unknownCap = engine.deriveModelCapabilitySummary(noMetaClaude, { configuredMode: 'dynamic' });
  assert.equal(unknownCap.hasMetadata, false);
  assert.equal(unknownCap.maxAdjustableTokens, null);

  // 5. 超限与未解锁检测
  const overEv = engine.evaluateLimitInput(900000, hydroCap, { configuredMode: 'dynamic' });
  assert.equal(overEv.exceedsModelLimit, true);
  assert.equal(overEv.adoptableTokens, 786432);

  const lockEv = engine.evaluateLimitInput(512000, flashStockCap, { configuredMode: 'default', gate3a: { clampState: 'ORIG' } });
  assert.equal(lockEv.requiresDynamicUnlock, true);

  // 6. 统一模式逐模型预测
  const projs = engine.projectUnifiedBudgetForProducts(
    { mode: 'fixed', limitTokens: 900000 },
    [flashProd, hydroProd, noMetaClaude],
    { configuredMode: 'dynamic' }
  );
  assert.equal(projs[0].outcome, 'exact');
  assert.equal(projs[0].projectedTokens, 900000);
  assert.equal(projs[1].outcome, 'clamped_to_model_max');
  assert.equal(projs[1].projectedTokens, 786432);
  assert.equal(projs[2].outcome, 'unknown_cap');

  // 7. 追踪诊断导出：严格脱敏不含提示正文/CSRF
  const tracker = engine.createContextBudgetTracker({ now: () => 5000 });
  tracker.beginDispatch({
    cascadeId: 'c-sec-1',
    productKey: flashProd.productKey,
    modelId: 'MODEL_PLACEHOLDER_M37',
    scopeMode: 'per_model',
    prefSnapshot: { mode: 'fixed', limitTokens: 512000 },
    targetMode: 'fixed',
    targetLimitTokens: 512000,
    sentMode: 'fixed',
    sentLimitTokens: 512000,
    channel: 'client_object',
    userMessage: 'SECRET_USER_MSG_999',
    csrfToken: 'SECRET_CSRF_TOKEN_ABC'
  });
  const traces = tracker.exportDiagnosticTraces();
  assert.equal(traces.length, 1);
  assert.equal(traces[0].transport, 'client_object');
  assert.equal(traces[0].prefSnapshot.limitTokens, 512000);
  const traceStr = JSON.stringify(traces);
  assert.equal(traceStr.includes('SECRET_USER_MSG_999'), false);
  assert.equal(traceStr.includes('SECRET_CSRF_TOKEN_ABC'), false);
});

test('端到端 UI 能力参考、按模型最大可用预设、超限不静默改写及“尚无本次验证”区分', async () => {
  const rendererCode = fs.readFileSync(path.join(__dirname, 'meter-renderer.js'), 'utf8');
  const elemMap = new Map();
  let savePayloads = [];
  const makeEl = (id, tagName = 'DIV') => {
    const listeners = new Map();
    const classSet = new Set();
    const obj = {
      id,
      tagName,
      children: [],
      attributes: new Map(),
      dataset: {},
      style: { setProperty() {} },
      hidden: id === 'panel' || id === 'panel-tokens',
      disabled: false,
      isConnected: true,
      value: '',
      textContent: '',
      innerHTML: '',
      classList: {
        add: (...c) => c.forEach(x => classSet.add(x)),
        remove: (...c) => c.forEach(x => classSet.delete(x)),
        contains: c => classSet.has(c),
        toggle: (c, f) => (f === undefined ? (classSet.has(c) ? classSet.delete(c) : classSet.add(c)) : (f ? classSet.add(c) : classSet.delete(c)))
      },
      setAttribute(k, v) { this.attributes.set(k, String(v)); },
      getAttribute(k) { return this.attributes.has(k) ? this.attributes.get(k) : null; },
      removeAttribute(k) { this.attributes.delete(k); },
      appendChild(c) { this.children.push(c); return c; },
      replaceChildren(...n) { this.children = n; },
      remove() {},
      addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(fn); },
      removeEventListener() {},
      click() { (listeners.get('click') || []).forEach(fn => fn({ target: this, preventDefault() {}, stopPropagation() {} })); },
      trigger(type, ev = {}) { (listeners.get(type) || []).forEach(fn => fn({ preventDefault() {}, stopPropagation() {}, ...ev })); },
      querySelector() { return null; },
      querySelectorAll(sel) {
        if (sel === '.ctx-preset-btn' && id === 'ctx-preset-grid') return this.children;
        return [];
      },
      closest() { return null; },
      contains(target) { return target === this; },
      cloneNode() { return makeEl(null, this.tagName); },
      getBoundingClientRect() { return { left: 100, top: 0, width: 120, height: 24 }; },
      focus() {}
    };
    if (id) elemMap.set(id, obj);
    return obj;
  };
  const registerStaticIds = () => {
    const ids = [
      'ctx-cap-window', 'ctx-cap-output', 'ctx-cap-model-max', 'ctx-cap-client-policy',
      'ctx-cap-default', 'ctx-cap-range', 'ctx-cap-formula',
      'ctx-ref-saved', 'ctx-ref-sent', 'ctx-ref-adopted', 'ctx-unified-projection',
      'ctx-card-tier-caps-row', 'ctx-card-tier-caps', 'ctx-preset-modelmax-sub',
      'ctx-preset-grid', 'ctx-custom-limit-input', 'ctx-limit-validation',
      'btn-save-model-ctx', 'btn-reset-model-ctx', 'unlock-result-box', 'unlock-result-text',
      'btn-ctx-mode-unified', 'btn-ctx-mode-per-model', 'ctx-model-select',
      'ctx-card-saved', 'ctx-card-request', 'ctx-card-observed-budget', 'ctx-card-diagnosis'
    ];
    for (const id of ids) makeEl(id, id.includes('input') ? 'INPUT' : 'DIV');
    const grid = elemMap.get('ctx-preset-grid');
    const presets = [
      { mode: 'default', limit: '' },
      { mode: 'fixed', limit: '128000' },
      { mode: 'fixed', limit: '256000' },
      { mode: 'fixed', limit: '512000' },
      { mode: 'model_max', limit: '' },
      { mode: 'dynamic', limit: '' }
    ];
    for (const p of presets) {
      const b = makeEl(null, 'BUTTON');
      b.className = 'ctx-preset-btn';
      b.dataset = { ctxMode: p.mode, ctxLimit: p.limit };
      b.setAttribute('data-ctx-mode', p.mode);
      b.setAttribute('data-ctx-limit', p.limit);
      grid.appendChild(b);
    }
    return grid;
  };
  registerStaticIds();

  const shadowRoot = {
    innerHTML: '',
    getElementById: (id) => elemMap.get(id) || makeEl(id),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
    appendChild() {}
  };
  const sandbox = {
    URL,
    localStorage: { _m: new Map(), getItem(k) { return this._m.get(k) || null; }, setItem(k, v) { this._m.set(k, String(v)); }, removeItem(k) { this._m.delete(k); } },
    location: { protocol: 'https:', hostname: '127.0.0.1', pathname: '/c/33333333-3333-4333-8333-333333333333' },
    document: {
      documentElement: makeEl('html', 'HTML'),
      body: makeEl('body', 'BODY'),
      getElementById: () => null,
      querySelectorAll: () => [],
      querySelector: () => null,
      addEventListener() {},
      removeEventListener() {},
      createElement: (tag) => makeEl(null, tag),
      hidden: false
    },
    matchMedia: () => ({ matches: true, addEventListener() {} }),
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    WebSocket: function () {},
    XMLHttpRequest: function () {},
    __APP_CONFIG__: { csrfToken: 'test-csrf' },
    __AGContextMeterCore: core,
    contextMeterAPI: {
      saveSettings: async (payload) => { savePayloads.push(payload); return { ok: true }; },
      getContextUnlockStatus: async () => ({
        ok: true,
        data: { status: 'patched_loaded', configuredMode: 'dynamic', gate3a: { clampState: 'DYN' } }
      })
    },
    __AGContextScopeMode: 'per_model',
    setTimeout,
    clearTimeout,
    setInterval: () => 1,
    clearInterval: () => {},
    AbortController,
    TextEncoder,
    TextDecoder,
    console
  };
  sandbox.WebSocket.prototype = { send() {} };
  sandbox.XMLHttpRequest.prototype = { open() {}, setRequestHeader() {}, send() {}, addEventListener() {} };
  sandbox.document.createElement = (tag) => {
    const n = makeEl(null, tag);
    n.attachShadow = () => shadowRoot;
    return n;
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  vm.runInNewContext(rendererCode, sandbox);
  await new Promise(resolve => setImmediate(resolve));

  const api = sandbox.__AGContextMeter;
  api.switchContextTabForTest('models');
  await new Promise(resolve => setImmediate(resolve));

  const hydroCfg = {
    modelId: 'MODEL_PLACEHOLDER_M107',
    modelOrAlias: { model: 'MODEL_PLACEHOLDER_M107' },
    label: 'Gemini 4 Hydrogen',
    maxTokens: 1048576,
    maxOutputTokens: 262144,
    capabilitySource: 'get_available_models',
    isHistorical: false
  };
  const smallModelCfg = {
    modelId: 'MODEL_SMALL_200K',
    modelOrAlias: { model: 'MODEL_SMALL_200K' },
    label: 'Small Model 200K',
    maxTokens: 200000,
    maxOutputTokens: 32000,
    capabilitySource: 'get_available_models',
    isHistorical: false
  };

  api.setContextLatestForTest(
    { model: 'Gemini 4 Hydrogen', modelId: 'MODEL_PLACEHOLDER_M107', status: 'pending' },
    [hydroCfg, smallModelCfg].map(collector.sanitizeCascadeModelConfig)
  );
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(elemMap.get('ctx-cap-window').textContent, '1,048,576 tokens');
  assert.equal(elemMap.get('ctx-cap-output').textContent, '262,144 tokens');
  assert.match(elemMap.get('ctx-cap-range').textContent, /16,384 – 786,432/);
  assert.equal(elemMap.get('ctx-ref-sent').textContent, '尚无本次验证');
  assert.equal(elemMap.get('ctx-ref-adopted').textContent, '尚无本次验证');

  // 点击「按模型最大可用」应填充并保存 786432
  const grid = elemMap.get('ctx-preset-grid');
  const modelMaxBtn = grid.children.find(b => b.getAttribute('data-ctx-mode') === 'model_max');
  assert.equal(modelMaxBtn.disabled, false);
  grid.trigger('click', { target: { closest: () => modelMaxBtn } });
  assert.equal(elemMap.get('ctx-custom-limit-input').value, '786432');
  elemMap.get('btn-save-model-ctx').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(savePayloads.at(-1).contextPreference.limitTokens, 786432);

  // 输入超出 786432 的数字（如 900000）点击保存：必须阻断静默下调，不可冒充保存成功
  const inputEl = elemMap.get('ctx-custom-limit-input');
  inputEl.value = '900000';
  inputEl.trigger('input');
  const prevSaveCount = savePayloads.length;
  elemMap.get('btn-save-model-ctx').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(savePayloads.length, prevSaveCount, '单模型超限时严禁静默修改或虚假保存');
  assert.match(elemMap.get('unlock-result-text').innerHTML, /786,432/);

  // 切换到仅 168,000 可调上限的小模型，256,000 与 512,000 预设按钮必须被禁用
  elemMap.get('ctx-model-select').value = 'product:other:small-model-200k';
  elemMap.get('ctx-model-select').trigger('change', { target: { value: 'product:other:small-model-200k' } });
  await new Promise(resolve => setImmediate(resolve));
  const p256Btn = grid.children.find(b => b.getAttribute('data-ctx-limit') === '256000');
  const p512Btn = grid.children.find(b => b.getAttribute('data-ctx-limit') === '512000');
  const p128Btn = grid.children.find(b => b.getAttribute('data-ctx-limit') === '128000');
  assert.equal(p256Btn.disabled, true);
  assert.equal(p512Btn.disabled, true);
  assert.equal(p128Btn.disabled, false);

  // 切换到统一模式：按模型最大可用按钮禁用，且显示逐模型预估截断提醒
  api.setContextScopeModeForTest('unified');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(modelMaxBtn.disabled, true);

  api.dispose();
});

test('能力参考、预设校验与统一模式预测在 default / fixed 不同值 / dynamic / 未知及运行态不一致下严格一致', () => {
  const flashProduct = {
    productKey: 'product:google:gemini-3-8-flash',
    productLabel: 'Gemini 3.8 Flash',
    vendor: 'google',
    members: [
      {
        modelId: 'MODEL_PLACEHOLDER_M37',
        maxTokens: 1048576,
        maxOutputTokens: 65536,
        capabilitySource: 'get_available_models'
      }
    ]
  };
  const hydroProduct = {
    productKey: 'product:google:gemini-4-hydrogen',
    productLabel: 'Gemini 4 Hydrogen',
    vendor: 'google',
    members: [
      {
        modelId: 'MODEL_PLACEHOLDER_M107',
        maxTokens: 1048576,
        maxOutputTokens: 262144,
        capabilitySource: 'get_available_models'
      }
    ]
  };
  const products = [flashProduct, hydroProduct];

  // 1. default (256,000) 运行已确认：模型理论上限仍为 983,040，但当前可调与策略默认均为 256,000；统一 512,000 不可预测为 exact
  const statusDefault = { status: 'not_patched', configuredMode: 'default', gate3a: { clampState: 'ORIG' } };
  const capDefault = engine.deriveModelCapabilitySummary(flashProduct, statusDefault);
  assert.equal(capDefault.modelTheoreticalMaxTokens, 983040);
  assert.equal(capDefault.currentClientLimitTokens, 256000);
  assert.equal(capDefault.currentStrategyDefaultBudget, 256000);
  assert.equal(capDefault.effectiveDefaultBudget, 256000);
  assert.equal(capDefault.maxAdjustableTokens, 256000);
  assert.equal(capDefault.rangeMax, 256000);
  assert.equal(capDefault.runtimePolicy.policyKnown, true);

  const evalDef512 = engine.evaluateLimitInput(512000, capDefault, statusDefault);
  assert.equal(evalDef512.ok, true);
  assert.equal(evalDef512.exceedsClientPolicy, true);
  assert.equal(evalDef512.requiresDynamicUnlock, true);
  assert.equal(evalDef512.adoptableTokens, 256000);

  const projDef512 = engine.projectUnifiedBudgetForProducts({ mode: 'fixed', limitTokens: 512000 }, products, statusDefault);
  assert.equal(projDef512[0].outcome, 'exceeds_client_policy');
  assert.equal(projDef512[0].projectedTokens, 256000);
  assert.equal(projDef512[1].outcome, 'exceeds_client_policy');
  assert.equal(projDef512[1].projectedTokens, 256000);

  // 2. fixed 不同数值验证（128000 / 600000 / 1200000）：真实纳入计算，绝不统一当作 256000
  const statusFixed128 = { status: 'patched_loaded', configuredMode: 'fixed', configuredLimitTokens: 128000 };
  const capFixed128 = engine.deriveModelCapabilitySummary(flashProduct, statusFixed128);
  assert.equal(capFixed128.modelTheoreticalMaxTokens, 983040);
  assert.equal(capFixed128.currentClientLimitTokens, 128000);
  assert.equal(capFixed128.effectiveDefaultBudget, 128000);
  assert.equal(capFixed128.maxAdjustableTokens, 128000);
  assert.equal(capFixed128.rangeMax, 128000);
  const evalFix128_512 = engine.evaluateLimitInput(512000, capFixed128, statusFixed128);
  assert.equal(evalFix128_512.exceedsClientPolicy, true);
  assert.equal(evalFix128_512.adoptableTokens, 128000);
  assert.ok(evalFix128_512.warnings.some(w => w.code === 'exceeds_fixed_client_limit' && w.fixedCap === 128000));
  const projFix128_512 = engine.projectUnifiedBudgetForProducts({ mode: 'fixed', limitTokens: 512000 }, [flashProduct], statusFixed128);
  assert.equal(projFix128_512[0].outcome, 'exceeds_client_policy');
  assert.equal(projFix128_512[0].projectedTokens, 128000);

  const statusFixed600 = { status: 'patched_loaded', configuredMode: 'fixed', configuredLimitTokens: 600000 };
  const capFixed600 = engine.deriveModelCapabilitySummary(flashProduct, statusFixed600);
  assert.equal(capFixed600.currentClientLimitTokens, 600000);
  assert.equal(capFixed600.effectiveDefaultBudget, 600000);
  assert.equal(capFixed600.maxAdjustableTokens, 600000);
  assert.equal(capFixed600.rangeMax, 600000);
  const projFix600_512 = engine.projectUnifiedBudgetForProducts({ mode: 'fixed', limitTokens: 512000 }, [flashProduct], statusFixed600);
  assert.equal(projFix600_512[0].outcome, 'exact');
  assert.equal(projFix600_512[0].projectedTokens, 512000);
  const projFix600_700 = engine.projectUnifiedBudgetForProducts({ mode: 'fixed', limitTokens: 700000 }, [flashProduct], statusFixed600);
  assert.equal(projFix600_700[0].outcome, 'exceeds_client_policy');
  assert.equal(projFix600_700[0].projectedTokens, 600000);

  const statusFixed1200 = { status: 'patched_loaded', configuredMode: 'fixed', configuredLimitTokens: 1200000 };
  const capFixed1200 = engine.deriveModelCapabilitySummary(flashProduct, statusFixed1200);
  assert.equal(capFixed1200.currentClientLimitTokens, 1200000);
  assert.equal(capFixed1200.effectiveDefaultBudget, 983040);
  assert.equal(capFixed1200.maxAdjustableTokens, 983040);
  assert.equal(capFixed1200.rangeMax, 983040);

  // 3. dynamic (patched_loaded)：策略默认 budget 与理论上限分别精确计算
  const statusDynamic = { status: 'patched_loaded', configuredMode: 'dynamic', gate3a: { clampState: 'DYN' } };
  const capDynamicFlash = engine.deriveModelCapabilitySummary(flashProduct, statusDynamic);
  assert.equal(capDynamicFlash.modelTheoreticalMaxTokens, 983040);
  assert.equal(capDynamicFlash.dynamicDefaultBudget, 983040);
  assert.equal(capDynamicFlash.effectiveDefaultBudget, 983040);
  assert.equal(capDynamicFlash.maxAdjustableTokens, 983040);
  const capDynamicHydro = engine.deriveModelCapabilitySummary(hydroProduct, statusDynamic);
  assert.equal(capDynamicHydro.modelTheoreticalMaxTokens, 786432);
  assert.equal(capDynamicHydro.effectiveDefaultBudget, 786432);
  assert.equal(capDynamicHydro.maxAdjustableTokens, 786432);
  const projDyn900 = engine.projectUnifiedBudgetForProducts({ mode: 'fixed', limitTokens: 900000 }, products, statusDynamic);
  assert.equal(projDyn900[0].outcome, 'exact');
  assert.equal(projDyn900[0].projectedTokens, 900000);
  assert.equal(projDyn900[1].outcome, 'clamped_to_model_max');
  assert.equal(projDyn900[1].projectedTokens, 786432);

  // 4. 未知 / 部分异常 / 磁盘修改待重启 / 进程未确认：严禁把模型理论参考或磁盘态冒充当前运行预算
  const unresolvedCases = [
    { input: null, expectedOutcome: 'unknown_policy', expectedState: 'unknown' },
    { input: { status: 'partial_match', configuredMode: 'partial' }, expectedOutcome: 'partial_policy_unconfirmed', expectedState: 'partial' },
    { input: { status: 'patched_pending_restart', configuredMode: 'dynamic', runtimeEvidence: { restartDetected: false } }, expectedOutcome: 'pending_restart_unconfirmed', expectedState: 'pending_restart' },
    { input: { status: 'patched_loaded', configuredMode: 'dynamic', runtimeEvidence: { restartDetected: false } }, expectedOutcome: 'pending_restart_unconfirmed', expectedState: 'pending_restart' },
    { input: { status: 'patched_runtime_unconfirmed', configuredMode: 'fixed', configuredLimitTokens: 600000 }, expectedOutcome: 'runtime_unconfirmed', expectedState: 'runtime_unconfirmed' }
  ];
  for (const c of unresolvedCases) {
    const capUnres = engine.deriveModelCapabilitySummary(flashProduct, c.input);
    assert.equal(capUnres.modelTheoreticalMaxTokens, 983040, `保留模型理论参考: ${c.expectedState}`);
    assert.equal(capUnres.runtimePolicy.policyKnown, false);
    assert.equal(capUnres.runtimePolicy.runtimeState, c.expectedState);
    assert.equal(capUnres.currentClientLimitTokens, null);
    assert.equal(capUnres.effectiveDefaultBudget, null, `未知/未确认态绝不能误报默认预算: ${c.expectedState}`);
    assert.equal(capUnres.maxAdjustableTokens, null);
    assert.equal(capUnres.rangeMax, null);

    const evalUnres = engine.evaluateLimitInput(512000, capUnres, c.input);
    assert.equal(evalUnres.ok, true);
    assert.equal(evalUnres.policyKnown, false);
    assert.equal(evalUnres.adoptableTokens, null);
    assert.ok(evalUnres.warnings.some(w => w.code === 'unconfirmed_runtime_policy' && w.runtimeState === c.expectedState));

    const projUnres = engine.projectUnifiedBudgetForProducts({ mode: 'fixed', limitTokens: 512000 }, products, c.input);
    assert.equal(projUnres[0].outcome, c.expectedOutcome);
    assert.equal(projUnres[0].projectedTokens, null);
  }
});

test('端到端 UI 一致性回归：fixed(128K) 与磁盘待重启态下参考卡、最大可用按钮、自定义提示及统一预测规则完全同步且无禁用词', async () => {
  const rendererCode = fs.readFileSync(path.join(__dirname, 'meter-renderer.js'), 'utf8');
  const forbiddenTerms = ['共享后端', '动态透传', 'Gate', 'sidecar', 'PE 指纹', '补丁', '二进制', 'language_server', 'manifest'];

  async function mountWithUnlockStatus(unlockStatus) {
    const elemMap = new Map();
    const makeEl = (id, tag = 'DIV') => {
      const listeners = new Map();
      const obj = {
        id,
        tagName: tag,
        hidden: false,
        disabled: false,
        title: '',
        value: '',
        textContent: '',
        innerHTML: '',
        isConnected: true,
        style: { setProperty() {}, removeProperty() {} },
        dataset: {},
        children: [],
        attributes: new Map(),
        classList: {
          _s: new Set(),
          add(...cls) { cls.forEach(c => this._s.add(c)); },
          remove(...cls) { cls.forEach(c => this._s.delete(c)); },
          contains(c) { return this._s.has(c); },
          toggle(c, f) { f === undefined ? (this._s.has(c) ? this._s.delete(c) : this._s.add(c)) : (f ? this._s.add(c) : this._s.delete(c)); }
        },
        setAttribute(k, v) { this.attributes.set(k, String(v)); },
        getAttribute(k) { return this.attributes.has(k) ? this.attributes.get(k) : null; },
        removeAttribute(k) { this.attributes.delete(k); },
        appendChild(c) { this.children.push(c); return c; },
        replaceChildren(...n) { this.children = n; },
        remove() {},
        addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(fn); },
        removeEventListener() {},
        click() { (listeners.get('click') || []).forEach(fn => fn({ target: this, preventDefault() {}, stopPropagation() {} })); },
        trigger(type, ev = {}) { (listeners.get(type) || []).forEach(fn => fn({ preventDefault() {}, stopPropagation() {}, ...ev })); },
        querySelector() { return null; },
        querySelectorAll(sel) {
          if (sel === '.ctx-preset-btn' && id === 'ctx-preset-grid') return this.children;
          return [];
        },
        closest() { return null; },
        contains(t) { return t === this; },
        cloneNode() { return makeEl(null, this.tagName); },
        getBoundingClientRect() { return { left: 100, top: 0, width: 120, height: 24 }; },
        focus() {}
      };
      if (id) elemMap.set(id, obj);
      return obj;
    };
    const ids = [
      'ctx-cap-window', 'ctx-cap-output', 'ctx-cap-model-max', 'ctx-cap-client-policy',
      'ctx-cap-default', 'ctx-cap-range', 'ctx-cap-formula',
      'ctx-ref-saved', 'ctx-ref-sent', 'ctx-ref-adopted', 'ctx-unified-projection',
      'ctx-preset-modelmax-sub', 'ctx-preset-grid', 'ctx-custom-limit-input', 'ctx-limit-validation',
      'btn-save-model-ctx', 'ctx-model-select', 'ctx-card-client', 'ctx-card-client-tag'
    ];
    for (const id of ids) makeEl(id, id.includes('input') ? 'INPUT' : 'DIV');
    const grid = elemMap.get('ctx-preset-grid');
    for (const p of [{ mode: 'default', limit: '' }, { mode: 'fixed', limit: '128000' }, { mode: 'fixed', limit: '512000' }, { mode: 'model_max', limit: '' }]) {
      const b = makeEl(null, 'BUTTON');
      b.className = 'ctx-preset-btn';
      b.dataset = { ctxMode: p.mode, ctxLimit: p.limit };
      b.setAttribute('data-ctx-mode', p.mode);
      b.setAttribute('data-ctx-limit', p.limit);
      grid.appendChild(b);
    }
    const shadowRoot = {
      innerHTML: '',
      getElementById: (id) => elemMap.get(id) || makeEl(id),
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
      removeEventListener() {},
      appendChild() {}
    };
    const sandbox = {
      URL,
      localStorage: { _m: new Map(), getItem(k) { return this._m.get(k) || null; }, setItem(k, v) { this._m.set(k, String(v)); }, removeItem(k) { this._m.delete(k); } },
      location: { protocol: 'https:', hostname: '127.0.0.1', pathname: '/c/44444444-4444-4444-8444-444444444444' },
      document: {
        documentElement: makeEl('html', 'HTML'),
        body: makeEl('body', 'BODY'),
        getElementById: () => null,
        querySelectorAll: () => [],
        querySelector: () => null,
        addEventListener() {},
        removeEventListener() {},
        createElement: (tag) => makeEl(null, tag),
        hidden: false
      },
      matchMedia: () => ({ matches: true, addEventListener() {} }),
      fetch: async () => ({ ok: true, json: async () => ({}) }),
      WebSocket: function () {},
      XMLHttpRequest: function () {},
      __APP_CONFIG__: { csrfToken: 'test-csrf' },
      __AGContextMeterCore: core,
      __AGContextScopeMode: 'per_model',
      contextMeterAPI: {
        saveSettings: async () => ({ ok: true }),
        getContextUnlockStatus: async () => ({ ok: true, data: unlockStatus })
      },
      setTimeout, clearTimeout, setInterval: () => 1, clearInterval: () => {},
      AbortController, TextEncoder, TextDecoder, console
    };
    sandbox.WebSocket.prototype = { send() {} };
    sandbox.XMLHttpRequest.prototype = { open() {}, setRequestHeader() {}, send() {}, addEventListener() {} };
    sandbox.document.createElement = (tag) => { const n = makeEl(null, tag); n.attachShadow = () => shadowRoot; return n; };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    vm.runInNewContext(rendererCode, sandbox);
    const api = sandbox.__AGContextMeter;
    api.switchContextTabForTest('models');
    api.setContextLatestForTest(
      { model: 'Gemini 3.8 Flash', modelId: 'MODEL_PLACEHOLDER_M37', status: 'pending' },
      [{
        modelId: 'MODEL_PLACEHOLDER_M37',
        modelOrAlias: { model: 'MODEL_PLACEHOLDER_M37' },
        label: 'Gemini 3.8 Flash',
        maxTokens: 1048576,
        maxOutputTokens: 65536,
        capabilitySource: 'get_available_models',
        isHistorical: false
      }].map(collector.sanitizeCascadeModelConfig)
    );
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    return { api, elemMap, grid };
  }

  // Case A: fixed(128,000)
  const a = await mountWithUnlockStatus({ status: 'patched_loaded', configuredMode: 'fixed', configuredLimitTokens: 128000 });
  assert.equal(a.elemMap.get('ctx-cap-model-max').textContent, '983,040 tokens');
  assert.match(a.elemMap.get('ctx-cap-client-policy').textContent, /128,000/);
  assert.match(a.elemMap.get('ctx-cap-default').textContent, /128,000 tokens/);
  assert.equal(a.elemMap.get('ctx-cap-range').textContent, '16,384 – 128,000 tokens');
  const maxBtnA = a.grid.children.find(b => b.getAttribute('data-ctx-mode') === 'model_max');
  assert.equal(maxBtnA.disabled, false);
  const p512A = a.grid.children.find(b => b.getAttribute('data-ctx-limit') === '512000');
  assert.equal(p512A.disabled, false, '超出固定客户端策略但未超模型理论上限时仍可选以提示警告');
  a.grid.trigger('click', { target: { closest: () => p512A } });
  assert.match(a.elemMap.get('ctx-limit-validation').textContent, /128,000/);
  a.api.setContextScopeModeForTest('unified');
  await new Promise(resolve => setImmediate(resolve));
  const projTextA = a.elemMap.get('ctx-unified-projection').children.map(c => c.textContent || c.children.map(x => x.textContent).join(' ')).join('\n');
  assert.match(projTextA, /128,000/);
  a.api.dispose();

  // Case B: patched_pending_restart (磁盘改为 dynamic，但尚未重启)
  const b = await mountWithUnlockStatus({ status: 'patched_pending_restart', configuredMode: 'dynamic', runtimeEvidence: { restartDetected: false } });
  assert.equal(b.elemMap.get('ctx-cap-model-max').textContent, '983,040 tokens');
  assert.match(b.elemMap.get('ctx-cap-client-policy').textContent, /待重启/);
  assert.match(b.elemMap.get('ctx-cap-default').textContent, /未知/);
  assert.match(b.elemMap.get('ctx-cap-range').textContent, /运行策略未知/);
  const maxBtnB = b.grid.children.find(bEl => bEl.getAttribute('data-ctx-mode') === 'model_max');
  assert.equal(maxBtnB.disabled, true, '运行态待重启未确认时禁用按模型最大可用按钮');
  const inputB = b.elemMap.get('ctx-custom-limit-input');
  inputB.value = '512000';
  inputB.trigger('input');
  assert.match(b.elemMap.get('ctx-limit-validation').textContent, /尚未重启|待确认/);

  for (const [, el] of [...a.elemMap, ...b.elemMap]) {
    const txt = `${el.textContent || ''} ${el.title || ''}`;
    for (const term of forbiddenTerms) {
      assert.equal(txt.includes(term), false, `普通 UI 文案不得包含禁用词 ${term}: ${txt}`);
    }
  }
  b.api.dispose();
});

test('v0.8.3 回归 14: scan 降级快照防假确认、恢复默认与失败改值状态机严谨性', () => {
  const tracker = engine.createContextBudgetTracker({ confirmTimeoutMs: 45000, nowFn: () => 5000 });
  const prod = { productKey: 'product:google:gemini-3.8-flash', productLabel: 'Gemini 3.8 Flash' };
  const convoId = '55555555-5555-4555-8555-555555555555';

  // 1. 发送前基线观测（包含明确 callId 与 stepCount=10）
  tracker.recordObservation({
    convoId,
    productKey: prod.productKey,
    modelId: 'MODEL_PLACEHOLDER_M37',
    budget: 256000,
    callId: 'call-prev',
    stepCount: 10,
    ts: 1000
  });

  // 2. 设置目标 512000 并发送
  tracker.beginDispatch({
    convoId,
    productKey: prod.productKey,
    modelId: 'MODEL_PLACEHOLDER_M37',
    scopeMode: 'per_model',
    targetMode: 'fixed',
    targetLimitTokens: 512000,
    sentMode: 'fixed',
    sentLimitTokens: 512000,
    timestamp: 2000
  });

  // 3. 竞态：新回复未到前，scan() 以 missing callId / 较低 stepCount=4 且更新 scannedAt=2500 返回旧预算 256000
  tracker.recordObservation({
    convoId,
    productKey: prod.productKey,
    modelId: 'MODEL_PLACEHOLDER_M37',
    budget: 256000,
    callId: null,
    stepCount: 4,
    ts: 2500
  });
  const sWait = tracker.evaluateStatus({
    product: prod,
    scopeMode: 'per_model',
    pref: { mode: 'fixed', limitTokens: 512000 },
    activeConvId: convoId,
    now: 2600
  });
  assert.equal(sWait.status, 'dispatched_pending_confirm', '缺少 callId 且步数未增的旧预算扫描不得误判为 mismatch 或 confirmed');

  // 同理：即便带有相同的旧 callId 且仅 ts=2700 更新，也不得误确认
  tracker.recordObservation({
    convoId,
    productKey: prod.productKey,
    modelId: 'MODEL_PLACEHOLDER_M37',
    budget: 256000,
    callId: 'call-prev',
    stepCount: 10,
    ts: 2700
  });
  const sWaitSameCall = tracker.evaluateStatus({
    product: prod,
    scopeMode: 'per_model',
    pref: { mode: 'fixed', limitTokens: 512000 },
    activeConvId: convoId,
    now: 2800
  });
  assert.equal(sWaitSameCall.status, 'dispatched_pending_confirm');

  // 4. 收到真正的发送后新回复
  tracker.recordObservation({
    convoId,
    productKey: prod.productKey,
    modelId: 'MODEL_PLACEHOLDER_M37',
    budget: 512000,
    callId: 'call-next-512k',
    stepCount: 12,
    ts: 3000
  });
  const sConfirmed = tracker.evaluateStatus({
    product: prod,
    scopeMode: 'per_model',
    pref: { mode: 'fixed', limitTokens: 512000 },
    activeConvId: convoId,
    now: 3100
  });
  assert.equal(sConfirmed.status, 'confirmed');

  // 5. 切回恢复默认（尚未发默认请求）：不残留上一次 512000 的 dispatched
  const sDefPending = tracker.evaluateStatus({
    product: prod,
    scopeMode: 'per_model',
    pref: { mode: 'default', limitTokens: null },
    activeConvId: convoId,
    now: 3200
  });
  assert.equal(sDefPending.status, 'default');
  assert.equal(sDefPending.diagnosisCode, 'default_pending_dispatch');
  assert.equal(sDefPending.dispatched, null);

  // 6. 以默认模式发起新请求但回复未到：进入待确认而不是提前显示已采用
  tracker.beginDispatch({
    convoId,
    productKey: prod.productKey,
    modelId: 'MODEL_PLACEHOLDER_M37',
    scopeMode: 'per_model',
    targetMode: 'default',
    targetLimitTokens: null,
    sentMode: 'default',
    sentLimitTokens: null,
    timestamp: 3300
  });
  const sDefAwaiting = tracker.evaluateStatus({
    product: prod,
    scopeMode: 'per_model',
    pref: { mode: 'default', limitTokens: null },
    activeConvId: convoId,
    now: 3400
  });
  assert.equal(sDefAwaiting.status, 'dispatched_pending_confirm');

  // 7. 默认请求收到新回复（如 983040）：转为 default_confirmed
  tracker.recordObservation({
    convoId,
    productKey: prod.productKey,
    modelId: 'MODEL_PLACEHOLDER_M37',
    budget: 983040,
    callId: 'call-def-reply',
    stepCount: 14,
    ts: 3600
  });
  const sDefConfirmed = tracker.evaluateStatus({
    product: prod,
    scopeMode: 'per_model',
    pref: { mode: 'default', limitTokens: null },
    activeConvId: convoId,
    now: 3700
  });
  assert.equal(sDefConfirmed.status, 'default');
  assert.equal(sDefConfirmed.diagnosisCode, 'default_confirmed');
  assert.equal(sDefConfirmed.observation.budget, 983040);

  // 8. 上次目标 512000 send_failed 后修改目标为 333333：直接回到 saved_pending_dispatch
  const failedRec = tracker.beginDispatch({
    convoId,
    productKey: prod.productKey,
    modelId: 'MODEL_PLACEHOLDER_M37',
    scopeMode: 'per_model',
    targetMode: 'fixed',
    targetLimitTokens: 512000,
    sentMode: 'fixed',
    sentLimitTokens: 512000,
    status: 'send_failed',
    errorMessage: 'HTTP 500',
    timestamp: 3800
  });
  tracker.updateDispatchStatus(failedRec.dispatchId, { status: 'send_failed', errorMessage: 'HTTP 500' });
  const sChangedAfterFail = tracker.evaluateStatus({
    product: prod,
    scopeMode: 'per_model',
    pref: { mode: 'fixed', limitTokens: 333333 },
    activeConvId: convoId,
    now: 3900
  });
  assert.equal(sChangedAfterFail.status, 'saved_pending_dispatch');
  assert.equal(sChangedAfterFail.dispatched, null);
});

test('v0.8.3 回归 15: meter-renderer 部分档位不可用不误杀整产品且摘要卡不借用首模型', async () => {
  const rendererPath = path.join(__dirname, 'meter-renderer.js');
  const rendererCode = fs.readFileSync(rendererPath, 'utf8');
  const elemMap = new Map();
  const makeEl = (id = null, tagName = 'DIV') => {
    const classSet = new Set();
    const attrs = new Map();
    const listeners = new Map();
    const node = {
      id, tagName, children: [], hidden: false, disabled: false, textContent: '', innerHTML: '', value: '', title: '', placeholder: '',
      classList: {
        add: (...c) => c.forEach(x => classSet.add(x)),
        remove: (...c) => c.forEach(x => classSet.delete(x)),
        contains: c => classSet.has(c)
      },
      setAttribute: (k, v) => attrs.set(k, String(v)),
      getAttribute: k => (attrs.has(k) ? attrs.get(k) : null),
      removeAttribute: k => attrs.delete(k),
      addEventListener: (ev, fn) => {
        if (!listeners.has(ev)) listeners.set(ev, []);
        listeners.get(ev).push(fn);
      },
      appendChild: c => { node.children.push(c); return c; },
      replaceChildren: (...nodes) => { node.children = nodes; },
      closest: () => null,
      contains: t => t === node,
      cloneNode: () => makeEl(null, tagName),
      getBoundingClientRect: () => ({ left: 100, top: 0, width: 120, height: 24 }),
      querySelector: () => null,
      querySelectorAll: () => [],
      remove: () => {},
      focus: () => {},
      style: { setProperty: () => {}, removeProperty: () => {} }
    };
    if (id) elemMap.set(id, node);
    return node;
  };
  makeEl('ctx-compact-saved', 'DIV');
  makeEl('ctx-model-list', 'DIV');
  const shadowRoot = {
    getElementById: id => elemMap.get(id) || makeEl(id),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {}
  };
  const sandbox = {
    URL,
    localStorage: { _m: new Map(), getItem(k) { return this._m.get(k) || null; }, setItem(k, v) { this._m.set(k, String(v)); }, removeItem(k) { this._m.delete(k); } },
    location: { protocol: 'https:', hostname: '127.0.0.1', pathname: '/c/66666666-6666-4666-8666-666666666666' },
    document: {
      documentElement: makeEl('html', 'HTML'),
      body: makeEl('body', 'BODY'),
      getElementById: () => null,
      querySelectorAll: () => [],
      querySelector: () => null,
      addEventListener() {},
      removeEventListener() {},
      createElement: (tag) => { const n = makeEl(null, tag); n.attachShadow = () => shadowRoot; return n; },
      hidden: false
    },
    matchMedia: () => ({ matches: true, addEventListener() {} }),
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    WebSocket: function () {},
    XMLHttpRequest: function () {},
    __APP_CONFIG__: { csrfToken: 'test-csrf' },
    __AGContextMeterCore: core,
    __AGContextScopeMode: 'per_model',
    __AGContextPreferences: {
      'product:anthropic:claude-opus-4-6-thinking': { mode: 'fixed', limitTokens: 512000 }
    },
    contextMeterAPI: {
      saveSettings: async () => ({ ok: true }),
      getContextUnlockStatus: async () => ({ ok: true, data: { status: 'patched_loaded', configuredMode: 'dynamic' } })
    },
    setTimeout, clearTimeout, setInterval: () => 1, clearInterval: () => {},
    AbortController, TextEncoder, TextDecoder, console
  };
  sandbox.WebSocket.prototype = { send() {} };
  sandbox.XMLHttpRequest.prototype = { open() {}, setRequestHeader() {}, send() {}, addEventListener() {} };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.runInNewContext(rendererCode, sandbox);
  const api = sandbox.__AGContextMeter;

  // 1. 当前模型未确认时，摘要卡绝不借用首模型保存值 512K
  api.setContextLatestForTest(
    null,
    [
      {
        modelId: 'MODEL_CLAUDE_4_OPUS_THINKING',
        modelOrAlias: { model: 'MODEL_CLAUDE_4_OPUS_THINKING' },
        label: 'Claude Opus 4.6 (Thinking)',
        unavailable: false,
        maxTokens: 200000,
        maxOutputTokens: 32000,
        isHistorical: false
      },
      {
        modelId: 'MODEL_PLACEHOLDER_M37_LOW',
        modelOrAlias: { model: 'MODEL_PLACEHOLDER_M37_LOW' },
        label: 'Gemini 3.8 Flash Low',
        unavailable: false,
        maxTokens: 1048576,
        maxOutputTokens: 65536,
        isHistorical: false
      },
      {
        modelId: 'MODEL_PLACEHOLDER_M37_HIGH',
        modelOrAlias: { model: 'MODEL_PLACEHOLDER_M37_HIGH' },
        label: 'Gemini 3.8 Flash High',
        unavailable: true,
        unavailabilityReason: 'High tier maintenance',
        maxTokens: 1048576,
        maxOutputTokens: 65536,
        isHistorical: false
      }
    ].map(collector.sanitizeCascadeModelConfig)
  );
  await new Promise(resolve => setImmediate(resolve));
  const compactSavedEl = elemMap.get('ctx-compact-saved');
  assert.equal(compactSavedEl.textContent.includes('512'), false, '当前模型未确认时不得借用首模型保存的 512K 展示');

  // 2. 验证同一产品一档可用、一档不可用时不标记整产品不可用
  api.switchContextTabForTest('models');
  const listEl = elemMap.get('ctx-model-list');
  const flatText = JSON.stringify(listEl.children);
  const flashRowMatch = listEl.children
    .flatMap(g => g.children || [])
    .find(r => typeof r.getAttribute === 'function' && r.getAttribute('data-product-key')?.includes('gemini-3.8-flash'));
  assert.ok(flashRowMatch, 'Gemini 3.8 Flash 产品行应存在');
  assert.equal(flashRowMatch.className.includes('is-unavailable'), false, '仅有部分档位不可用时整产品不应标记 is-unavailable');
  assert.equal(flatText.includes('不可用'), false, '不应把整个 Gemini 3.8 Flash 打上不可用标签');
  api.dispose();
});

test('v0.8.3 回归 16: plugin.json 与 package.json 版本统一，且原位卸载不残留 meter-enhance.js', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
  const pluginManifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'plugin.json'), 'utf8'));
  assert.equal(pluginManifest.version, pkg.version, 'plugin.json 版本必须与 package.json 一致');

  const restoreSrc = fs.readFileSync(path.join(__dirname, 'restore.js'), 'utf8');
  assert.ok(restoreSrc.includes("'meter-enhance.js'"), 'restore.js additions 必须包含 meter-enhance.js 避免原位卸载残留');
});
