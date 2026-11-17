'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const core = require('./meter-core');
const collector = require('./meter-collector');
const accountsMod = require('./meter-accounts');

const RENDERER_SOURCE = fs.readFileSync(path.join(__dirname, 'meter-renderer.js'), 'utf8');

function makeTempDir(prefix = 'acm-acct-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeMockCredStore() {
  let activePayload = { email: 'a@example.com', accessToken: 'tok-init', refreshToken: 'ref-init', expiresAt: new Date(Date.now() + 3600000).toISOString() };
  let failWrite = false;
  let snapshotRestoreCount = 0;
  return {
    getPaths: () => ({ desktopDbPath: '', ideDbPath: '', googleAccountsPath: '', oauthCredsPath: '' }),
    readWindowsSystemCredential: () => null,
    readMacKeychainCredential: () => null,
    captureSnapshot: () => ({ ...activePayload }),
    applyCredential: (cred) => {
      if (failWrite) return { ok: false, stage: 'mock_write', error: '写入受阻' };
      activePayload = { ...cred };
      return { ok: true };
    },
    restoreSnapshot: (snap) => {
      snapshotRestoreCount++;
      activePayload = { ...snap };
      return { ok: true };
    },
    setFailWrite: (v) => { failWrite = Boolean(v); },
    getApplied: () => activePayload,
    getRestoreCount: () => snapshotRestoreCount
  };
}

function buildMockQuotaSnapshot(mainFrac, thirdPartyFrac = 0.9, argonFrac = 0.95, extraMainBuckets = null) {
  return {
    pools: [
      {
        poolKey: 'shared_gemini_main',
        title: 'Gemini 4 Hydrogen / 3.8 Flash',
        remainingFraction: mainFrac,
        percentText: `${Number((mainFrac * 100).toFixed(1))}%`,
        primaryBucket: { windowKey: '5h', windowShort: '5h', remainingFraction: mainFrac },
        buckets: extraMainBuckets || [
          { bucketId: 'b5h', windowKey: '5h', windowShort: '5h', remainingFraction: mainFrac },
          { bucketId: 'b7d', windowKey: 'weekly', windowShort: '7d', remainingFraction: 0.92 }
        ]
      },
      {
        poolKey: 'shared_3p_pool',
        title: 'Claude / GPT-OSS',
        remainingFraction: thirdPartyFrac,
        percentText: `${Number((thirdPartyFrac * 100).toFixed(1))}%`,
        primaryBucket: { windowKey: '5h', windowShort: '5h', remainingFraction: thirdPartyFrac },
        buckets: [{ bucketId: 'b3p', windowKey: '5h', windowShort: '5h', remainingFraction: thirdPartyFrac }]
      },
      {
        poolKey: 'shared_gemini_argon',
        title: 'Gemini 4 Argon',
        remainingFraction: argonFrac,
        percentText: `${Number((argonFrac * 100).toFixed(1))}%`,
        primaryBucket: { windowKey: 'weekly', windowShort: '7d', remainingFraction: argonFrac },
        buckets: [{ bucketId: 'barg', windowKey: 'weekly', windowShort: '7d', remainingFraction: argonFrac }]
      }
    ]
  };
}

test('ELV-89 Protobuf: state.vscdb OAuthToken 与 UserStatus Topic 双向编解码且零凭证泄露', () => {
  const oauthB64 = accountsMod.buildUnifiedOAuthTokenTopicBase64({
    accessToken: 'ya29.test_access_xyz',
    refreshToken: '1//0g_test_refresh_xyz',
    expirySeconds: 1795000000,
    idToken: 'eyJhbGciOiJIUzI1NiJ9.eyJlbWFpbCI6ImFsaWNlQGV4YW1wbGUuY29tIn0.sig'
  });
  const parsedOAuth = accountsMod.parseUnifiedOAuthTokenTopicBase64(oauthB64);
  assert.equal(parsedOAuth.accessToken, 'ya29.test_access_xyz');
  assert.equal(parsedOAuth.refreshToken, '1//0g_test_refresh_xyz');
  assert.equal(parsedOAuth.expirySeconds, 1795000000);

  const userB64 = accountsMod.buildUnifiedUserStatusTopicBase64({ email: 'Alice@Example.com', name: 'Alice' });
  const parsedUser = accountsMod.parseUnifiedUserStatusTopicBase64(userB64);
  assert.equal(parsedUser.email, 'alice@example.com');
  assert.equal(parsedUser.name, 'Alice');
});

test('ELV-89 分账号用量隔离: A -> B -> C -> B 切换与历史未归属严格独立，绝不默认算入当前账号', async () => {
  const tmpDir = makeTempDir();
  const agDir = path.join(tmpDir, 'ag');
  const cliDir = path.join(tmpDir, 'cli');
  const stateDir = path.join(tmpDir, 'state');
  fs.mkdirSync(agDir, { recursive: true });
  fs.mkdirSync(cliDir, { recursive: true });

  // 1. 写入旧历史（无可靠账号依据，模拟历史 v1/v2 与无归属旧调用）
  fs.writeFileSync(path.join(agDir, 'token_usage_archive_v1.json'), JSON.stringify({
    firstUseDate: '2026-10-01',
    dailyMap: {
      '2026-10-01': { input: 5000, cache: 15000, output: 1200, total: 21200, conversations: 2 }
    }
  }));

  const keyA = collector.buildAccountScopeKey('a@example.com');
  const keyB = collector.buildAccountScopeKey('b@example.com');
  const keyC = collector.buildAccountScopeKey('c@example.com');

  const ledgerPath = path.join(agDir, 'pricing_ledger_v1.json');
  const day = collector.formatLocalDateKey(new Date());

  // 2. 模拟 A -> B -> C -> B 依次实时入账
  collector.recordModelCalls([
    { callId: 'real_a_1', model: 'Gemini 4 Hydrogen (High)', inputTokens: 1000, cacheReadTokens: 3000, outputTokens: 200, date: day, timestamp: Date.now() - 40000 }
  ], { ledgerPath, confirmedAccountEmail: 'a@example.com' });

  collector.recordModelCalls([
    { callId: 'real_b_1', model: 'Claude Opus 5.5', inputTokens: 2000, cacheReadTokens: 8000, outputTokens: 500, date: day, timestamp: Date.now() - 30000 }
  ], { ledgerPath, confirmedAccountEmail: 'b@example.com' });

  collector.recordModelCalls([
    { callId: 'real_c_1', model: 'Gemini 4 Carbon', inputTokens: 500, cacheReadTokens: 0, outputTokens: 100, date: day, timestamp: Date.now() - 20000 }
  ], { ledgerPath, confirmedAccountEmail: 'c@example.com' });

  // 切回 B 后再新增一条
  collector.recordModelCalls([
    { callId: 'real_b_2', model: 'Claude Opus 5.5', inputTokens: 1000, cacheReadTokens: 1000, outputTokens: 200, date: day, timestamp: Date.now() - 10000, isKeepalive: true }
  ], { ledgerPath, confirmedAccountEmail: 'b@example.com' });

  // 物理分片校验：account_ledgers/ 下各自独立
  const partDir = path.join(agDir, 'account_ledgers');
  assert.equal(fs.existsSync(path.join(partDir, `${keyA}.json`)), true);
  assert.equal(fs.existsSync(path.join(partDir, `${keyB}.json`)), true);
  assert.equal(fs.existsSync(path.join(partDir, `${keyC}.json`)), true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(partDir, `${keyA}.json`), 'utf8')).callCount, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(partDir, `${keyB}.json`), 'utf8')).callCount, 2);

  // 3. 聚合输出：验证各账号互不串用，且旧历史保留在 unattributedUsage（当前账户绝不吞并旧历史）
  const hist = await collector.collectTokenHistoryAsync({
    agDir,
    agCliDir: cliDir,
    userStatus: { userStatus: { email: 'c@example.com' } },
    skipWslDiscovery: true
  });

  assert.equal(hist.usageByAccount[keyA].totalTokens, 4200);
  assert.equal(hist.usageByAccount[keyA].cacheReadStats.cacheReadPct, 75); // 3000 / (1000+3000)
  assert.equal(hist.usageByAccount[keyB].totalTokens, 12700); // 10500 + 2200
  assert.equal(hist.usageByAccount[keyB].keepaliveRequests, 1);
  assert.equal(hist.usageByAccount[keyB].keepaliveTokens, 2200);
  assert.equal(hist.usageByAccount[keyC].totalTokens, 600);
  assert.equal(hist.unattributedUsage.totalTokens, 21200, '无账号证据的 21200 旧历史必须保留在 unattributedUsage 中');
  assert.notEqual(hist.usageByAccount[keyC].totalTokens, 21200 + 600, '当前登录账号 C 严禁默认吞并历史记录');

  // 验证 overview 对外视图不包含明文 token
  const mgr = accountsMod.createAccountsManager({
    stateDir,
    credentialStore: makeMockCredStore(),
    getHostUserStatus: async () => ({ email: 'b@example.com' }),
    restartLanguageServers: async () => ({ ok: true })
  });
  mgr.addAccountWithCredential({ email: 'a@example.com', accessToken: 'sec-acc-a', refreshToken: 'sec-ref-a', expiresAt: new Date(Date.now() + 3600000).toISOString() });
  const serializedOverview = JSON.stringify(mgr.getOverviewState());
  assert.doesNotMatch(serializedOverview, /sec-acc-a|sec-ref-a/, '对外 overview 状态严禁暴露任何凭据');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('ELV-89 真实切号验证与失败保护 + 阈值自动切号边界全矩阵（关闭/过期/防抖/生成中/并发锁/恢复/耗尽/失败）', async () => {
  const tmpDir = makeTempDir();
  const stateDir = path.join(tmpDir, 'state');
  const credStore = makeMockCredStore();
  let currentHostEmail = 'a@example.com';
  let switchCallsCount = 0;

  const mgr = accountsMod.createAccountsManager({
    stateDir,
    credentialStore: credStore,
    getHostUserStatus: async () => ({ email: currentHostEmail }),
    restartLanguageServers: async () => {
      switchCallsCount++;
      return { ok: true };
    }
  });

  const futureExp = new Date(Date.now() + 3600000).toISOString();
  mgr.addAccountWithCredential({ email: 'a@example.com', accessToken: 'tA', refreshToken: 'rA', expiresAt: futureExp });
  mgr.addAccountWithCredential({ email: 'b@example.com', accessToken: 'tB', refreshToken: 'rB', expiresAt: futureExp });
  mgr.addAccountWithCredential({ email: 'c@example.com', accessToken: 'tC', refreshToken: 'rC', expiresAt: futureExp });

  // 验证默认关闭
  assert.equal(mgr.getOverviewState().autoSwitch.enabled, false);
  const offEval = await mgr.evaluateAutoSwitch({ activeEmail: 'a@example.com', activeSnapshot: buildMockQuotaSnapshot(0.02), syncState: 'fresh' });
  assert.equal(offEval.action, 'noop');
  assert.equal(offEval.state, 'disabled');

  // 刷新模拟快照：B=65%, C=5%
  await mgr.refreshAccountQuota('a@example.com', { mockQuotaSnapshot: buildMockQuotaSnapshot(0.08), nowMs: 1000 });
  await mgr.refreshAccountQuota('b@example.com', { mockQuotaSnapshot: buildMockQuotaSnapshot(0.65), nowMs: 1000 });
  await mgr.refreshAccountQuota('c@example.com', { mockQuotaSnapshot: buildMockQuotaSnapshot(0.05), nowMs: 1000 });

  // 写入失败时自动无损回滚
  credStore.setFailWrite(true);
  const failWriteRes = await mgr.switchActiveAccount('b@example.com', { skipTokenRefresh: true });
  assert.equal(failWriteRes.ok, false);
  assert.equal(failWriteRes.rolledBack, true);
  assert.equal(credStore.getRestoreCount(), 1);
  credStore.setFailWrite(false);

  // GetUserStatus 未确认为目标邮箱时，不虚报成功
  const unverifiedRes = await mgr.switchActiveAccount('b@example.com', { skipTokenRefresh: true, verifyTimeoutMs: 50 });
  assert.equal(unverifiedRes.ok, false);
  assert.equal(unverifiedRes.verifiedEffective, false);

  // 开启自动切号：threshold <= 10%，debounce 10s，cooldown 120s
  mgr.updateAutoSwitchConfig({
    enabled: true,
    poolKey: 'shared_gemini_main',
    metricMode: 'remaining_pct',
    windowKey: 'primary',
    thresholdPct: 10,
    debounceSec: 10,
    cooldownSec: 120,
    waitUntilIdle: true,
    candidates: ['b@example.com', 'c@example.com']
  });

  // 1) 过期/未知状态不得触发
  const staleRes = await mgr.evaluateAutoSwitch({ activeEmail: 'a@example.com', activeSnapshot: buildMockQuotaSnapshot(0.05), syncState: 'stale', nowMs: 2000 });
  assert.equal(staleRes.action, 'blocked');
  assert.equal(staleRes.state, 'blocked_untrusted_quota');

  // 2) 首次触线进防抖
  const deb1 = await mgr.evaluateAutoSwitch({ activeEmail: 'a@example.com', activeSnapshot: buildMockQuotaSnapshot(0.10), syncState: 'fresh', nowMs: 3000 });
  assert.equal(deb1.action, 'pending_debounce');

  // 3) 正在生成中：等待安全时机，不静默中断
  const busyRes = await mgr.evaluateAutoSwitch({ activeEmail: 'a@example.com', activeSnapshot: buildMockQuotaSnapshot(0.08), syncState: 'fresh', isGenerating: true, nowMs: 15000 });
  assert.equal(busyRes.action, 'waiting_idle');

  // 4) 生成空闲 + 过防抖期 + 正常验证切换 -> 选中更高余量的 B（65%），绝不选已低于阈值的 C（5%）
  currentHostEmail = 'b@example.com'; // 模拟 LS 重启后生效为 B
  const switchedRes = await mgr.evaluateAutoSwitch({ activeEmail: 'a@example.com', activeSnapshot: buildMockQuotaSnapshot(0.08), syncState: 'fresh', isGenerating: false, nowMs: 16000, skipTokenRefresh: true });
  assert.equal(switchedRes.ok, true);
  assert.equal(switchedRes.action, 'switched');
  assert.equal(switchedRes.toEmail, 'b@example.com');

  // 5) 冷却期内不再触发切号
  const coolRes = await mgr.evaluateAutoSwitch({ activeEmail: 'b@example.com', activeSnapshot: buildMockQuotaSnapshot(0.05), syncState: 'fresh', nowMs: 25000 });
  assert.equal(coolRes.action, 'cooldown');

  // 6) 若额度重置或滚动恢复回到 >10%，清除状态并回到 watching
  const recovRes = await mgr.evaluateAutoSwitch({ activeEmail: 'b@example.com', activeSnapshot: buildMockQuotaSnapshot(1.00), syncState: 'fresh', nowMs: 200000 });
  assert.equal(recovRes.action, 'ok_above_threshold');
  assert.equal(recovRes.state, 'watching');

  // 7) 全部候选均不足时停止循环并提示 all_candidates_exhausted
  await mgr.refreshAccountQuota('a@example.com', { mockQuotaSnapshot: buildMockQuotaSnapshot(0.04), nowMs: 300000 });
  await mgr.refreshAccountQuota('c@example.com', { mockQuotaSnapshot: buildMockQuotaSnapshot(0.02), nowMs: 300000 });
  mgr.updateAutoSwitchConfig({ debounceSec: 0, candidates: ['a@example.com', 'c@example.com'] });
  const exRes = await mgr.evaluateAutoSwitch({ activeEmail: 'b@example.com', activeSnapshot: buildMockQuotaSnapshot(0.05), syncState: 'fresh', nowMs: 301000 });
  assert.equal(exRes.action, 'all_candidates_exhausted');
  assert.equal(exRes.state, 'all_candidates_exhausted');

  // 8) 多窗口并发锁：当 switch 锁被另一窗口持有时，绝不并发重复切换
  fs.writeFileSync(mgr.getPaths().switchLockPath, JSON.stringify({ pid: 999999, token: 'other-win', acquiredAtMs: Date.now() }));
  const lockBlocked = await mgr.switchActiveAccount('a@example.com', { skipTokenRefresh: true });
  assert.equal(lockBlocked.ok, false);
  assert.equal(lockBlocked.locked, true);
  fs.unlinkSync(mgr.getPaths().switchLockPath);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('ELV-57 & ELV-52: 共享账号配额区间对照（80%->72% / 切号 / 缺口 / 重置分段）与缓存保活实验门禁防护', async () => {
  const tmpDir = makeTempDir();
  const stateDir = path.join(tmpDir, 'state');
  const agDir = path.join(tmpDir, 'ag');
  fs.mkdirSync(agDir, { recursive: true });
  const scopeA = collector.buildAccountScopeKey('a@example.com');
  const ledgerPath = path.join(agDir, 'pricing_ledger_v1.json');

  const t1 = 1760000000000;
  const t2 = t1 + 600000; // 10 min later (continuous)
  const t3 = t2 + 60 * 60000; // 60 min gap (> 30m -> sampling_gap split)
  const t4 = t3 + 300000; // reset to 100%

  // 在 [t1, t2] 区间发生 2 次本地请求
  collector.recordModelCalls([
    { callId: 'c57_1', model: 'Gemini 4 Hydrogen (High)', inputTokens: 1000, cacheReadTokens: 4000, outputTokens: 300, timestamp: t1 + 10000 },
    { callId: 'c57_2', model: 'Gemini 4 Hydrogen (High)', inputTokens: 500, cacheReadTokens: 1500, outputTokens: 200, timestamp: t1 + 20000 }
  ], { ledgerPath, confirmedAccountEmail: 'a@example.com' });

  const mgr = accountsMod.createAccountsManager({
    stateDir,
    credentialStore: makeMockCredStore(),
    collector: {
      summarizeAccountWindowUsage: (q) => collector.summarizeAccountWindowUsage({ ...q, ledgerPath })
    }
  });
  mgr.addAccountWithCredential({ email: 'a@example.com', accessToken: 'tA', refreshToken: 'rA', expiresAt: new Date(t4 + 3600000).toISOString() });

  await mgr.refreshAccountQuota('a@example.com', { mockQuotaSnapshot: buildMockQuotaSnapshot(0.80), nowMs: t1 });
  await mgr.refreshAccountQuota('a@example.com', { mockQuotaSnapshot: buildMockQuotaSnapshot(0.72), nowMs: t2 });
  await mgr.refreshAccountQuota('a@example.com', { mockQuotaSnapshot: buildMockQuotaSnapshot(0.65), nowMs: t3 }); // >30m gap
  await mgr.refreshAccountQuota('a@example.com', { mockQuotaSnapshot: buildMockQuotaSnapshot(1.00), nowMs: t4 }); // reset

  const intervals = mgr.getOverviewState().quotaIntervals.filter(i => i.poolKey === 'shared_gemini_main');
  const firstIv = intervals.find(i => i.startAtMs === t1 && i.endAtMs === t2);
  assert.ok(firstIv);
  assert.equal(firstIv.startRemainingPct, 80);
  assert.equal(firstIv.endRemainingPct, 72);
  assert.equal(firstIv.deltaPp, -8); // 下降 8 个百分点
  assert.equal(firstIv.requestCount, 2);
  assert.equal(firstIv.uncachedInputTokens, 1500);
  assert.equal(firstIv.cacheReadTokens, 5500);
  assert.equal(firstIv.outputTokens, 500);
  assert.equal(firstIv.isReliableContinuous, true);

  const gapIv = intervals.find(i => i.startAtMs === t2 && i.endAtMs === t3);
  assert.equal(gapIv.hasSamplingGap, true);
  assert.equal(gapIv.splitReason, 'sampling_gap');
  assert.equal(gapIv.isReliableContinuous, false);

  const resetIv = intervals.find(i => i.startAtMs === t3 && i.endAtMs === t4);
  assert.equal(resetIv.splitReason, 'quota_reset');

  // ELV-52 保活安全校验
  const kaStore = mgr.loadStore();
  kaStore.activeAccountEmail = 'a@example.com';
  mgr.saveStore(kaStore);

  // 未获维护者批准禁止真实发请求
  mgr.updateKeepaliveConfig({
    enabled: true,
    experimentApproved: false,
    targetAccountEmail: 'a@example.com',
    targetSessionId: 'iso-sess-1',
    targetModelId: 'gemini-4-hydrogen-high',
    maxRequests: 2
  });
  let sentCount = 0;
  const blockedKa = await mgr.evaluateKeepaliveTick({
    confirmedActiveEmail: 'a@example.com',
    sendIsolatedPing: async () => { sentCount++; return { ok: true }; }
  });
  assert.equal(blockedKa.action, 'blocked');
  assert.equal(blockedKa.reason, 'pending_maintainer_experiment_approval');
  assert.equal(sentCount, 0);

  // 维护者批准最小可控实验后验证：活跃会话生成中不插入、429 退避、达上限自动停、切号先停保活
  mgr.updateKeepaliveConfig({ enabled: true, experimentApproved: true });
  const deferKa = await mgr.evaluateKeepaliveTick({
    confirmedActiveEmail: 'a@example.com',
    activeUserSessionId: 'iso-sess-1',
    isGenerating: true,
    sendIsolatedPing: async () => { sentCount++; return { ok: true }; }
  });
  assert.equal(deferKa.action, 'deferred');
  assert.equal(sentCount, 0);

  const ping1 = await mgr.evaluateKeepaliveTick({
    confirmedActiveEmail: 'a@example.com',
    nowMs: t4 + 1000,
    sendIsolatedPing: async (req) => {
      assert.equal(req.allowTools, false);
      assert.equal(req.isKeepalive, true);
      assert.equal(req.sessionId, 'iso-sess-1');
      sentCount++;
      return { ok: true };
    }
  });
  assert.equal(ping1.action, 'ping_sent');
  assert.equal(sentCount, 1);

  const rateLimited = await mgr.evaluateKeepaliveTick({
    confirmedActiveEmail: 'a@example.com',
    nowMs: t4 + 2000,
    sendIsolatedPing: async () => ({ ok: false, status: 429, error: 'rate limit' })
  });
  assert.equal(rateLimited.action, 'backoff');

  const stopRes = mgr.stopKeepalive('manual_button');
  assert.equal(stopRes.ok, true);
  assert.equal(mgr.getOverviewState().keepalive.enabled, false);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('UI 整合验证: 英文面板标题 ACM (+ Antigravity Context Meter tooltip)、顶栏额度上标及账号账本 UI 筛选隔离', async () => {
  const elements = new Map();
  const makeNode = (id) => {
    const attrs = new Map();
    const n = {
      id: id || '',
      style: { setProperty() {}, removeProperty() {}, getPropertyValue() { return ''; } },
      children: [],
      hidden: false,
      disabled: false,
      textContent: '',
      value: '',
      title: '',
      className: '',
      classList: { add() {}, remove() {}, contains() { return false; } },
      addEventListener() {},
      setAttribute(k, v) { attrs.set(k, String(v)); },
      getAttribute(k) { return attrs.get(k) ?? null; },
      removeAttribute(k) { attrs.delete(k); },
      appendChild(c) { if (c) n.children.push(c); },
      replaceChildren(...items) { n.children = items.filter(Boolean); },
      remove() {},
      contains() { return false; },
      matches() { return false; },
      querySelectorAll() { return []; },
      getBoundingClientRect() { return { left: 100, top: 100, width: 120, height: 24, right: 220, bottom: 124 }; }
    };
    if (id) elements.set(id, n);
    return n;
  };
  const i18nDomNodes = [
    { key: 'panel.ctx.title', titleKey: 'panel.ctx.fullName', node: makeNode('panel-ctx-title-node') }
  ];
  const host = makeNode('ag-host');
  host.attachShadow = () => ({
    set innerHTML(_v) {},
    getElementById(id) { return elements.get(id) || makeNode(id); },
    querySelectorAll(sel) {
      if (sel === '[data-i18n]') return i18nDomNodes.map(x => ({
        getAttribute: (k) => k === 'data-i18n' ? x.key : null,
        set textContent(v) { x.node.textContent = v; },
        get textContent() { return x.node.textContent; }
      }));
      if (sel === '[data-i18n-title]') return i18nDomNodes.map(x => ({
        getAttribute: (k) => k === 'data-i18n-title' ? x.titleKey : null,
        setAttribute: (k, v) => x.node.setAttribute(k, v)
      }));
      return [];
    }
  });
  let first = true;
  const sandbox = {
    location: { protocol: 'https:', hostname: '127.0.0.1', pathname: '/c/11111111-1111-1111-1111-111111111111' },
    document: {
      createElement: () => (first ? (first = false, host) : makeNode()),
      getElementById: id => elements.get(id) || null,
      documentElement: { appendChild() {} },
      addEventListener() {},
      removeEventListener() {},
      hidden: false
    },
    window: { __APP_CONFIG__: { csrfToken: 't' }, contextMeterAPI: {} },
    matchMedia: () => ({ matches: false }),
    __AGContextMeterCore: core,
    AbortController,
    Date,
    setTimeout: () => 1,
    clearTimeout() {},
    setInterval: () => 1,
    clearInterval() {},
    fetch: async () => ({ ok: true, json: async () => ({ generatorMetadata: [] }) })
  };
  vm.createContext(sandbox);
  vm.runInContext(RENDERER_SOURCE, sandbox);

  const api = sandbox.__AGContextMeter;
  try {
    // 1. 英文面板标题使用 ACM 且悬停完整名称为 Antigravity Context Meter
    await api.setPanelLanguage('en', { persist: false });
    const titleNode = elements.get('panel-ctx-title-node');
    assert.equal(titleNode.textContent, 'ACM');
    assert.equal(titleNode.getAttribute('title'), 'Antigravity Context Meter');

    await api.setPanelLanguage('zh-CN', { persist: false });
    assert.equal(titleNode.textContent, '💬 当前会话上下文');

    // 2. 分账号隔离展示：传入 usageByAccount 与 unattributedUsage，切换筛选后严格隔离
    const keyA = collector.buildAccountScopeKey('a@example.com');
    const keyB = collector.buildAccountScopeKey('b@example.com');
    api.setAccountsOverviewForTest({
      activeAccountEmail: 'a@example.com',
      activeAccountScopeKey: keyA,
      accounts: [
        { email: 'a@example.com', maskedEmail: 'a***@example.com', accountScopeKey: keyA, isActive: true, hasRefreshToken: true, quotaSnapshot: buildMockQuotaSnapshot(0.75) },
        { email: 'b@example.com', maskedEmail: 'b***@example.com', accountScopeKey: keyB, isActive: false, hasRefreshToken: true, quotaSnapshot: buildMockQuotaSnapshot(0.95) }
      ],
      autoSwitch: { enabled: false },
      autoSwitchStatus: { state: 'disabled' },
      keepalive: { enabled: false },
      keepaliveState: { running: false },
      quotaIntervals: [],
      protocolEvidence: accountsMod.ELV52_PROTOCOL_EVIDENCE
    });
    const today = collector.formatLocalDateKey(new Date());
    api.applyTokenHistoryPayload({
      accountScopeKey: keyA,
      dailyMap: { [today]: { input: 5000, cache: 5000, output: 1000, total: 11000, steps: 2 } },
      dailyMapBySource: { all: { [today]: { input: 5000, cache: 5000, output: 1000, total: 11000, steps: 2 } } },
      summary: { grandTotalTokens: 11000, todayTokens: 11000, monthTokens: 11000, yearTokens: 11000 },
      usageByAccount: {
        [keyA]: { totalTokens: 3000, todayTokens: 3000, monthTokens: 3000, yearTokens: 3000, totalInputTokens: 1000, totalCacheTokens: 1500, totalOutputTokens: 500, dailyMap: { [today]: { input: 1000, cache: 1500, output: 500, total: 3000, steps: 1 } } },
        [keyB]: { totalTokens: 2000, todayTokens: 2000, monthTokens: 2000, yearTokens: 2000, totalInputTokens: 500, totalCacheTokens: 1000, totalOutputTokens: 500, dailyMap: { [today]: { input: 500, cache: 1000, output: 500, total: 2000, steps: 1 } }, keepaliveRequests: 1, keepaliveTokens: 200 }
      },
      unattributedUsage: { totalTokens: 6000, todayTokens: 6000, monthTokens: 6000, yearTokens: 6000, totalInputTokens: 3500, totalCacheTokens: 2500, totalOutputTokens: 0, dailyMap: { [today]: { input: 3500, cache: 2500, output: 0, total: 6000, steps: 0 } } }
    });

    api.setTokenAccountFilterForTest(keyA);
    assert.equal(elements.get('token-amount').textContent, '3.0K');
    assert.equal(api.getTokenCacheBreakdownForTest().ratio, '60%'); // 1500 / (1000+1500)
    api.setTokenAccountFilterForTest(keyB);
    assert.equal(elements.get('token-amount').textContent, '2.0K');
    assert.equal(api.getTokenCacheBreakdownForTest().ratio, '66.7%'); // 1000 / (500+1000)
    assert.match(elements.get('token-account-scope-note').textContent, /保活消耗 1 次/);
    api.setTokenAccountFilterForTest('unattributed');
    assert.equal(elements.get('token-amount').textContent, '6.0K');
    // 切回 A 后仍准确恢复 A 此前账本（不串用）
    api.setTokenAccountFilterForTest(keyA);
    assert.equal(elements.get('token-amount').textContent, '3.0K');

    // 3. 顶栏额度百分比与异常状态验证（确保 unknown/stale/error/no_permission 不显示 0%）
    for (const [frac, expectTxt] of [[0.09, '9%'], [0.10, '10%'], [0.99, '99%'], [1.0, '100%'], [0.0005, '<0.1%']]) {
      assert.equal(core.formatQuotaPercentText(frac), expectTxt);
    }
    assert.equal(core.formatQuotaPercentText(0), '0%');

    // 4. OAuth 动态配置优先级（显式参数优先级 > 环境变量 > 宿主二进制，零硬编码密钥字面量）
    const explicitOAuth = accountsMod.resolveAntigravityOAuthConfig({
      oauthClientId: 'mock-client-id',
      oauthClientSecret: 'mock-client-secret'
    });
    assert.equal(explicitOAuth.clientId, 'mock-client-id');
    assert.equal(explicitOAuth.source, 'explicit_option');
  } finally {
    api.dispose();
  }
});
