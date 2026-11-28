'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const vm = require('node:vm');

const core = require('./meter-core');
const collector = require('./meter-collector');
const accountsMod = require('./meter-accounts');
const proxyMod = require('./meter-proxy');

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

test('Issue #95: 客户端重启后仅凭宿主确认提交已切换账号', async (t) => {
  const stateDir = makeTempDir();
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const credStore = makeMockCredStore();
  let email = 'a@example.com';
  let restartCalls = 0;
  let lsCalls = 0;
  const options = {
    stateDir,
    credentialStore: credStore,
    getHostUserStatus: async () => ({ email }),
    restartLanguageServers: async () => { lsCalls++; return { ok: true }; }
  };
  const mgr = accountsMod.createAccountsManager(options);
  mgr.addAccountWithCredential({ email: 'b@example.com', accessToken: 'test-access', refreshToken: 'test-refresh' });
  await mgr.detectCurrentActiveAccount();
  const pending = await mgr.switchActiveAccount('b@example.com', {
    skipTokenRefresh: true,
    restartClient: async () => { restartCalls++; return { supported: true }; }
  });
  assert.equal(pending.restartPending, true);
  assert.equal(pending.verifiedEffective, false);
  assert.equal(restartCalls, 1);
  assert.equal(lsCalls, 0);
  assert.equal(credStore.getRestoreCount(), 0);
  assert.equal((await mgr.detectCurrentActiveAccount()).email, 'a@example.com');

  const storeFile = path.join(stateDir, 'accounts_v1.json');
  const store = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
  store.autoSwitchStatus.lastResult.pid = process.pid + 1;
  fs.writeFileSync(storeFile, JSON.stringify(store));
  const relaunched = accountsMod.createAccountsManager(options);
  assert.equal((await relaunched.detectCurrentActiveAccount()).email, 'a@example.com');
  email = 'b@example.com';
  assert.equal((await relaunched.detectCurrentActiveAccount()).email, email);
  assert.equal(relaunched.getOverviewState().autoSwitchStatus.lastResult.verifiedEffective, true);
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
    windowKey: '5h',
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

  const restartBlocked = await mgr.evaluateAutoSwitch({
    activeEmail: 'a@example.com', activeSnapshot: buildMockQuotaSnapshot(0.08), syncState: 'fresh',
    isGenerating: false, nowMs: 15500, requiresClientRestart: true
  });
  assert.equal(restartBlocked.reason, 'client_restart_requires_idle_window');

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

test('ELV-89 OAuth 代理隧道与本地直连隔离 + 身份入列/额度分离 + 脱敏日志与同名邮箱遮罩区分', async () => {
  const tmpDir = makeTempDir('acm-oauth-proxy-');
  const stateDir = path.join(tmpDir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });

  // 1. 掩码需区分同前缀不同末尾邮箱
  assert.notEqual(accountsMod.maskEmail('elfixturefirst@example.test'), accountsMod.maskEmail('elfixturesecond@example.test'));
  assert.equal(accountsMod.maskEmail('elfixturefirst@example.test'), 'el***st@example.test');
  assert.equal(accountsMod.maskEmail('elfixturesecond@example.test'), 'el***nd@example.test');

  // 2. 验证 requestWithProxyTunnel: 本机 127.0.0.1 强制直连，外部主机显式走 HTTP 代理 CONNECT（且绝不静默直连）
  const connectSeen = [];
  const targetSrv = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, path: req.url }));
  });
  await new Promise(resolve => targetSrv.listen(0, '127.0.0.1', resolve));
  const targetPort = targetSrv.address().port;

  const proxySrv = http.createServer((req, res) => {
    connectSeen.push(`HTTP:${req.url}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ proxied: true }));
  });
  proxySrv.on('connect', (req, clientSocket, head) => {
    connectSeen.push(`CONNECT:${req.url}`);
    const [, portStr] = String(req.url || '').split(':');
    const upstream = net.connect(Number(portStr) || targetPort, '127.0.0.1', () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on('error', () => clientSocket.destroy());
  });
  await new Promise(resolve => proxySrv.listen(0, '127.0.0.1', resolve));
  const proxyPort = proxySrv.address().port;

  try {
    // loopback URL 必须强制直连，connectSeen 不得增加
    const cfgDir = path.join(tmpDir, 'proxy-cfg');
    fs.mkdirSync(cfgDir, { recursive: true });
    const fakeCfgPath = path.join(cfgDir, 'modules.json');
    fs.writeFileSync(fakeCfgPath, JSON.stringify({ modules: { proxy: { enabled: true, httpProxy: `http://127.0.0.1:${proxyPort}`, noProxy: 'localhost,127.0.0.1' } } }));

    const directResp = await proxyMod.requestWithProxyTunnel(`http://127.0.0.1:${targetPort}/cb`, {
      method: 'GET',
      proxyConfigOptions: { candidates: [fakeCfgPath] }
    });
    assert.equal(directResp.status, 200);
    assert.equal(connectSeen.length, 0, '本机 loopback 回调绝对不得走远端代理');

    // 外部域通过配置 HTTP CONNECT 隧道转发至本地目标桩
    const tunnelResp = await proxyMod.requestWithProxyTunnel(`http://example.invalid:${targetPort}/tunnel-ok`, {
      method: 'GET',
      timeoutMs: 3000,
      proxyConfigOptions: { candidates: [fakeCfgPath] }
    });
    assert.equal(tunnelResp.status, 200);
    assert.equal(tunnelResp.diagnostics.proxySource, 'plugin_config');
    assert.ok(connectSeen.some(s => s.startsWith('CONNECT:example.invalid:')));

    // 外部域指向不可用端口插件代理，验证严格经代理连接失败且绝不静默直连真实外网
    const deadCfgPath = path.join(cfgDir, 'dead-modules.json');
    fs.writeFileSync(deadCfgPath, JSON.stringify({ modules: { proxy: { enabled: true, httpProxy: 'http://127.0.0.1:1', noProxy: '' } } }));
    await assert.rejects(
      () => proxyMod.requestWithProxyTunnel('https://oauth2.googleapis.com/token', {
        method: 'POST',
        timeoutMs: 1500,
        proxyConfigOptions: { candidates: [deadCfgPath] }
      }),
      (err) => err && err.diagnostics?.proxySource === 'plugin_config' && err.diagnostics?.targetHost === 'oauth2.googleapis.com'
    );

    // 3. 完整 OAuth 阶段隔离测试：Token + UserInfo 成功入列后，CloudCode 503 配额失败不得把整个账号丢弃
    let failQuota = true;
    const customFetch = async (url, init = {}) => {
      const u = String(url);
      if (u.includes('oauth2.googleapis.com/token')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            access_token: 'secret_access_tok_xyz',
            refresh_token: 'secret_refresh_tok_xyz',
            expires_in: 3600,
            id_token: 'eyJhbGciOiJIUzI1NiJ9.eyJlbWFpbCI6IjEyMTM4MTExMTIyMjJlbHZpc0BnbWFpbC5jb20ifQ.sig'
          })
        };
      }
      if (u.includes('googleapis.com/oauth2/v2/userinfo')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ email: 'acfixturefourth@example.test', name: 'NewAcct' })
        };
      }
      if (u.includes('cloudcode-pa.googleapis.com') || u.includes('cloudcode-pa.sandbox.googleapis.com')) {
        if (failQuota) {
          return {
            ok: false,
            status: 503,
            text: async () => JSON.stringify({ error: { message: 'upstream unavailable' } })
          };
        }
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            cloudaicompanionProject: { id: 'proj-new-1' },
            currentTier: { id: 'g1-pro-tier' },
            models: {}
          })
        };
      }
      throw new Error(`Unexpected fetch URL: ${u}`);
    };

    let launchedAuthUrl = '';
    const mgr = accountsMod.createAccountsManager({
      stateDir,
      credentialStore: makeMockCredStore(),
      fetch: customFetch,
      oauthClientId: 'mock-oauth-client-id',
      oauthClientSecret: 'mock-super-client-secret-999',
      openExternal: (authUrl) => {
        launchedAuthUrl = authUrl;
        const parsed = new URL(authUrl);
        const redirectUri = parsed.searchParams.get('redirect_uri');
        const state = parsed.searchParams.get('state');
        // 异步模拟浏览器完成授权回调本地 127.0.0.1 端口
        setTimeout(() => {
          http.get(`${redirectUri}?code=mock_auth_code_777&state=${encodeURIComponent(state)}`, { agent: false }).on('error', () => {});
        }, 40);
      }
    });

    const addRes = await mgr.startOAuthLogin();
    assert.equal(addRes.ok, true, '身份与凭据保存成功后不得误报整体添加失败');
    assert.equal(addRes.quotaOk, false);
    assert.equal(addRes.stage, 'quota_fetch');
    assert.equal(addRes.targetHost, 'daily-cloudcode-pa.sandbox.googleapis.com');
    assert.equal(addRes.httpStatus, 503);
    assert.equal(addRes.account.email, 'acfixturefourth@example.test');
    assert.ok(addRes.account.lastQuotaError);

    // 重新实例检查持久化与列表可见性
    const mgrReload = accountsMod.createAccountsManager({ stateDir, credentialStore: makeMockCredStore(), fetch: customFetch });
    const persistedAcct = mgrReload.getOverviewState().accounts.find(a => a.email === 'acfixturefourth@example.test');
    assert.ok(persistedAcct, '重启后新添加账号必须持久化在列表中');
    assert.equal(persistedAcct.hasRefreshToken, true);

    // 恢复额度接口，执行单账号重试
    failQuota = false;
    const retryRes = await mgr.refreshAccountQuota('acfixturefourth@example.test');
    assert.equal(retryRes.ok, true);
    assert.equal(retryRes.account.lastQuotaError, null);

    // 验证脱敏诊断日志绝不泄露任何敏感值
    const diagFile = path.join(stateDir, 'oauth_diagnostics.jsonl');
    assert.equal(fs.existsSync(diagFile), true);
    const diagContent = fs.readFileSync(diagFile, 'utf8');
    assert.doesNotMatch(diagContent, /mock_auth_code_777|secret_access_tok_xyz|secret_refresh_tok_xyz|mock-super-client-secret-999/);
    assert.match(diagContent, /daily-cloudcode-pa\.sandbox\.googleapis\.com/);
    assert.ok(launchedAuthUrl.includes('accounts.google.com/o/oauth2/auth'));
  } finally {
    proxySrv.closeAllConnections?.();
    targetSrv.closeAllConnections?.();
    proxySrv.close();
    targetSrv.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('ELV-89 时间窗严格归属、IDE 拦截、幂等账本纠偏及 ALL == SUM(attributed) + unattributed 守恒与片段合并', async () => {
  const tmpDir = makeTempDir('acm-repair-attr-');
  const agDir = path.join(tmpDir, 'ag');
  const cliDir = path.join(tmpDir, 'cli');
  const stateDir = path.join(tmpDir, 'state');
  fs.mkdirSync(agDir, { recursive: true });
  fs.mkdirSync(cliDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });

  const scopeA = collector.buildAccountScopeKey('a@example.com');
  const scopeB = collector.buildAccountScopeKey('b@example.com');
  const ledgerPath = path.join(agDir, 'pricing_ledger_v1.json');
  const baseNow = new Date();
  baseNow.setHours(12, 0, 0, 0);
  const nowMs = baseNow.getTime();
  const day = collector.formatLocalDateKey(baseNow);

  const t0 = nowMs - 3600 * 1000; // 早于追踪起点
  const tAStart = nowMs - 1800 * 1000;
  const tAEnd = nowMs - 1200 * 1000;
  const tBStart = nowMs - 900 * 1000;

  const accountSessions = [
    { email: 'a@example.com', accountScopeKey: scopeA, source: 'desktop', startAtMs: tAStart, lastVerifiedAtMs: tAEnd, endAtMs: tAEnd, evidence: 'host_user_status' },
    { email: 'b@example.com', accountScopeKey: scopeB, source: 'desktop', startAtMs: tBStart, lastVerifiedAtMs: nowMs, endAtMs: null, evidence: 'account_switch_verified' }
  ];

  // 1. 种子坏数据：模拟旧 bug 把早期记录、缺时间记录及 IDE 记录错标成当前账号 B
  collector.savePricingLedger({
    version: 1,
    calls: {
      old_before_track: {
        callId: 'old_before_track',
        source: 'desktop',
        model: 'Gemini 4 Hydrogen (High)',
        inputTokens: 4000,
        cacheReadTokens: 1000,
        outputTokens: 500,
        totalTokens: 5500,
        date: day,
        created_at: new Date(t0).toISOString(),
        accountScopeKey: scopeB,
        accountAttributionConfidence: 'live_confirmed_account'
      },
      ide_unverified: {
        callId: 'ide_unverified',
        source: 'ide',
        model: 'Gemini 4 Hydrogen (High)',
        inputTokens: 1000,
        cacheReadTokens: 0,
        outputTokens: 200,
        totalTokens: 1200,
        date: day,
        created_at: new Date(tBStart + 5000).toISOString(),
        accountScopeKey: scopeB,
        accountAttributionConfidence: 'live_confirmed_account'
      },
      in_window_a: {
        callId: 'in_window_a',
        source: 'desktop',
        model: 'Claude Opus 5.5',
        inputTokens: 2000,
        cacheReadTokens: 3000,
        outputTokens: 500,
        totalTokens: 5500,
        date: day,
        created_at: new Date(tAStart + 10000).toISOString()
      },
      cross_boundary: {
        callId: 'cross_boundary',
        source: 'desktop',
        model: 'Gemini 4 Carbon',
        inputTokens: 700,
        cacheReadTokens: 0,
        outputTokens: 100,
        totalTokens: 800,
        date: day,
        requestStartMs: tAEnd - 1000,
        requestEndMs: tBStart + 1000,
        accountScopeKey: scopeB
      },
      in_window_b: {
        callId: 'in_window_b',
        source: 'desktop',
        model: 'Gemini 4 Hydrogen (High)',
        inputTokens: 1000,
        cacheReadTokens: 2000,
        outputTokens: 300,
        totalTokens: 3300,
        date: day,
        created_at: new Date(tBStart + 20000).toISOString(),
        accountScopeKey: scopeB
      }
    }
  }, ledgerPath);

  // 2. 首次执行修复迁移（验证自动备份 + 精准拆清/回填）
  const rep1 = collector.repairAndMigrateAccountLedger({ ledgerPath, accountSessions, backupSuffix: 'unit1' });
  assert.equal(rep1.ok, true);
  assert.ok(fs.existsSync(rep1.backupPath), '必须先备份原账本');
  assert.equal(rep1.after.attributed[scopeA], 1, '窗口 A 调用被回填归入 A');
  assert.equal(rep1.after.attributed[scopeB], 1, '仅窗口 B 内有效调用保留在 B');
  assert.equal(rep1.after.unattributed, 3, '起点前 + IDE + 跨边界记录必须归入未归属');

  // 再次执行必须完全幂等
  const rep2 = collector.repairAndMigrateAccountLedger({ ledgerPath, accountSessions, backupSuffix: 'unit2' });
  assert.equal(rep2.ok, true);
  assert.equal(rep2.updatedCount, 0, '二次迁移必须零修改且幂等');

  // 3. 验证后续扫描带 trustTranscriptDate 时绝不吞噬未归属或跨窗口，并写入与账本匹配的日归档以供完整守恒核对
  collector.recordModelCalls([
    { callId: 'late_no_ts', source: 'desktop', model: 'Gemini 4 Carbon', inputTokens: 200, outputTokens: 50, totalTokens: 250, date: day }
  ], { ledgerPath, trustTranscriptDate: true, accountSessions });

  fs.writeFileSync(path.join(agDir, 'token_usage_archive_v1.json'), JSON.stringify({
    firstUseDate: day,
    dailyMap: {
      [day]: { input: 8900, cache: 6000, output: 1650, total: 16550, steps: 6 }
    }
  }));

  // 4. 全量聚合与严格守恒核对
  const hist = await collector.collectTokenHistoryAsync({
    agDir,
    agCliDir: cliDir,
    stateDir,
    accountSessions,
    skipWslDiscovery: true
  });
  const totA = hist.usageByAccount[scopeA].totalTokens;
  const totB = hist.usageByAccount[scopeB].totalTokens;
  const totUnattr = hist.unattributedUsage.totalTokens;
  assert.equal(totA, 5500);
  assert.equal(totB, 3300);
  assert.equal(totUnattr, 7750);
  assert.equal(totA + totB + totUnattr, hist.summary.grandTotalTokens, '全部 == 已归属各账号总和 + 未归属');
  assert.ok(hist.usageByAccount[scopeA].dailyModelMapBySource?.all?.[day], '分账号统计必须带有逐日逐模型分布');
  assert.ok(hist.unattributedUsage.dailyModelMapBySource?.all?.[day], '未归属历史也必须保留按模型分布');

  // 5. 验证连续采样同池区间自动就地合并（不生成海量 0pp 碎片）
  const mgr = accountsMod.createAccountsManager({
    stateDir,
    credentialStore: makeMockCredStore(),
    collector: { summarizeAccountWindowUsage: (q) => collector.summarizeAccountWindowUsage({ ...q, ledgerPath }) }
  });
  mgr.addAccountWithCredential({ email: 'b@example.com', accessToken: 'tb', refreshToken: 'rb', expiresAt: new Date(Date.now() + 3600000).toISOString() });
  const baseT = tBStart + 10000;
  await mgr.refreshAccountQuota('b@example.com', { mockQuotaSnapshot: buildMockQuotaSnapshot(0.90), nowMs: baseT });
  await mgr.refreshAccountQuota('b@example.com', { mockQuotaSnapshot: buildMockQuotaSnapshot(0.88), nowMs: baseT + 30000 });
  await mgr.refreshAccountQuota('b@example.com', { mockQuotaSnapshot: buildMockQuotaSnapshot(0.85), nowMs: baseT + 60000 });
  const mainIntervals = mgr.getOverviewState().quotaIntervals.filter(i => i.poolKey === 'shared_gemini_main');
  assert.equal(mainIntervals.length, 1, '连续无断点采样应自动合并为一条区间而非碎片');
  assert.equal(mainIntervals[0].startRemainingPct, 90);
  assert.equal(mainIntervals[0].endRemainingPct, 85);
  assert.equal(mainIntervals[0].deltaPp, -5);
  assert.equal(mainIntervals[0].requestCount, 1);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('UI 深度回归: 8 处统一下拉规范、零用量账号归零、NoPerm 移除、(High) 去重与三语零泄露', async () => {
  const elements = new Map();
  const makeNode = (id) => {
    const attrs = new Map();
    const evs = new Map();
    const clsSet = new Set();
    const n = {
      id: id || '',
      style: { setProperty() {}, removeProperty() {}, getPropertyValue() { return ''; }, display: '' },
      children: [],
      options: [],
      selectedOptions: [],
      hidden: false,
      disabled: false,
      textContent: '',
      value: '',
      title: '',
      className: '',
      classList: {
        add(c) { clsSet.add(c); n.className = Array.from(clsSet).join(' '); },
        remove(c) { clsSet.delete(c); n.className = Array.from(clsSet).join(' '); },
        contains(c) { return clsSet.has(c); }
      },
      addEventListener(k, fn) { if (!evs.has(k)) evs.set(k, []); evs.get(k).push(fn); },
      dispatchEvent(ev) { for (const fn of (evs.get(ev?.type) || [])) fn(ev); },
      setAttribute(k, v) { attrs.set(k, String(v)); },
      getAttribute(k) { return attrs.get(k) ?? null; },
      removeAttribute(k) { attrs.delete(k); },
      appendChild(c) { if (c) { n.children.push(c); if (n.options) n.options.push(c); } },
      replaceChildren(...items) { n.children = items.filter(Boolean); if (n.options) n.options = items.filter(Boolean); },
      remove() {},
      contains() { return false; },
      matches() { return false; },
      closest() { return null; },
      querySelector() { return null; },
      querySelectorAll() { return []; },
      getBoundingClientRect() { return { left: 100, top: 100, width: 140, height: 24, right: 240, bottom: 124 }; }
    };
    if (id) elements.set(id, n);
    return n;
  };
  const selectIds = [
    'token-account-select',
    'select-custom-acq',
    'select-custom-region-preset',
    'select-custom-currency',
    'select-custom-cycle',
    'sel-auto-switch-target',
    'sel-auto-switch-mode'
  ];
  for (const sid of selectIds) makeNode(sid);

  const host = makeNode('ag-host');
  host.attachShadow = () => ({
    set innerHTML(_v) {},
    getElementById(id) { return elements.get(id) || makeNode(id); },
    querySelectorAll() { return []; }
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
    // 1. 确认 template.html 与 RENDERER_SOURCE 中已全部升级 8 处自定义下拉组件且绑定 ARIA 属性
    for (const sid of selectIds) {
      const trig = elements.get(`${sid === 'token-account-select' ? 'token-account' : sid}-dropdown-trigger`);
      const menu = elements.get(`${sid === 'token-account-select' ? 'token-account' : sid}-dropdown-menu`);
      assert.equal(elements.get(sid).style.display, 'none', `${sid} 原生 select 必须隐藏`);
      assert.equal(trig.getAttribute('role'), 'combobox', `${sid} 下拉触发器必须声明 role="combobox"`);
      assert.equal(trig.getAttribute('aria-haspopup'), 'listbox');
      assert.equal(menu.getAttribute('role'), 'listbox');
    }

    // 2. 筛选零用量账号时，累计 / 今日 / 本月 / 年度 / 按模型 / 费用必须全部同步归零，绝不保留全局 4.59B / 3.40B
    const keyZero = collector.buildAccountScopeKey('zero@example.com');
    const keyUsed = collector.buildAccountScopeKey('used@example.com');
    const today = collector.formatLocalDateKey(new Date());
    api.setAccountsOverviewForTest({
      activeAccountEmail: 'zero@example.com',
      activeAccountScopeKey: keyZero,
      accounts: [
        {
          email: 'zero@example.com',
          maskedEmail: 'ze***om@example.com',
          accountScopeKey: keyZero,
          isActive: true,
          hasRefreshToken: true,
          lastQuotaError: 'quota fetch timeout',
          lastQuotaErrorMeta: { stage: 'quota_fetch', targetHost: 'cloudcode-pa.googleapis.com', httpStatus: 503 },
          quotaSnapshot: {
            pools: [
              { poolKey: 'shared_3p_pool', title: 'Claude/3P', noPermission: true, remainingFraction: null },
              { poolKey: 'shared_gemini_carbon', title: 'Carbon', noPermission: true, remainingFraction: null }
            ]
          }
        },
        { email: 'used@example.com', maskedEmail: 'us***om@example.com', accountScopeKey: keyUsed, isActive: false, hasRefreshToken: true }
      ],
      autoSwitch: { enabled: false },
      autoSwitchStatus: { state: 'disabled' },
      keepalive: { enabled: false },
      keepaliveState: { running: false },
      quotaIntervals: [],
      protocolEvidence: accountsMod.ELV52_PROTOCOL_EVIDENCE
    });

    api.applyTokenHistoryPayload({
      accountScopeKey: keyZero,
      dailyMap: { [today]: { input: 100000000, cache: 4400000000, output: 90000000, total: 4590000000, steps: 500 } },
      dailyMapBySource: { all: { [today]: { input: 100000000, cache: 4400000000, output: 90000000, total: 4590000000, steps: 500 } } },
      referenceCost: {
        all: { inputTokens: 100000000, cacheTokens: 4400000000, outputTokens: 90000000, totalTokens: 4590000000, totalCostUSD: 999 },
        currentMonth: { inputTokens: 50000000, cacheTokens: 3300000000, outputTokens: 50000000, totalTokens: 3400000000, totalCostUSD: 777 }
      },
      summary: { grandTotalTokens: 4590000000, todayTokens: 1000000, monthTokens: 3400000000, yearTokens: 4590000000 },
      usageByAccount: {
        [keyUsed]: {
          totalTokens: 1500, todayTokens: 1500, monthTokens: 1500, yearTokens: 1500,
          totalInputTokens: 500, totalCacheTokens: 800, totalOutputTokens: 200,
          dailyMap: { [today]: { input: 500, cache: 800, output: 200, total: 1500, steps: 1 } }
        }
      },
      unattributedUsage: {
        totalTokens: 4589998500, todayTokens: 998500, monthTokens: 3399998500, yearTokens: 4589998500,
        dailyMap: { [today]: { input: 99999500, cache: 4399999200, output: 89999800, total: 4589998500, steps: 499 } }
      }
    });

    api.setTokenAccountFilterForTest(keyZero);
    assert.equal(elements.get('t-total-val').textContent, '0');
    assert.equal(elements.get('t-today-val').textContent, '0');
    assert.equal(elements.get('t-month-val').textContent, '0');
    assert.equal(elements.get('t-year-val').textContent, '0');
    assert.equal(elements.get('token-amount').textContent, '0');
    assert.doesNotMatch(elements.get('t-total-cost').textContent, /\$0\.00/);
    assert.match(elements.get('t-total-cost').textContent, /暂无此账号记录/);

    // 3. 验证三语下无 NoPerm、英文模式下界面账号/费用等动态文案无中文泄漏，且已删除的保活诊断节点不再出现在额度看板 DOM
    await api.setPanelLanguage('en', { persist: false });
    assert.match(elements.get('t-total-cost').textContent, /No records for account/);
    const acctListJsonEn = JSON.stringify(elements.get('quota-accounts-list').children);
    assert.doesNotMatch(acctListJsonEn, /NoPerm/, '界面绝不能出现原始 NoPerm');
    assert.match(acctListJsonEn, /No model access/);
    assert.match(acctListJsonEn, /Quota fetch failed/);
    assert.equal(elements.get('keepalive-protocol-summary'), undefined, '额度看板不得再渲染已删除的保活协议诊断节点');
    assert.equal(elements.get('quota-keepalive-section'), undefined, '额度看板不得再包含保活卡片');
    assert.doesNotMatch(elements.get('token-account-scope-note').textContent, /[\u4e00-\u9fa5]/);

    await api.setPanelLanguage('zh-TW', { persist: false });
    const acctListJsonTw = JSON.stringify(elements.get('quota-accounts-list').children);
    assert.match(acctListJsonTw, /無模型權限/);

    // 4. 模型括号档位去重验证（确认 splitModelDisplayAndEffort 集成效果）
    const dedup = core.splitModelDisplayAndEffort('Gemini 4 Hydrogen (High) (High)', 'High');
    assert.equal(dedup.baseLabel, 'Gemini 4 Hydrogen');
    assert.equal(dedup.effort, 'High');
  } finally {
    api.dispose();
  }
});

test('v0.8.8 账本回归: 旧账号历史 + 新账号首次登录自动纠偏、空态/全在今天与切换零残留', async () => {
  const agDir = makeTempDir('acm-v088-ag-');
  const stateDir = makeTempDir('acm-v088-st-');
  try {
    const oldEmail = 'old@example.com';
    const newEmail = 'newultra@example.com';
    const oldScope = accountsMod.buildAccountScopeKey(oldEmail);
    const newScope = accountsMod.buildAccountScopeKey(newEmail);
    const nowMs = new Date().setHours(12, 0, 0, 0);
    const tOldStart = nowMs - 2 * 86400000;
    const tOldEnd = nowMs - 86400000;
    const tNewStart = nowMs - 600000; // 10 分钟前首次登录新号
    const today = collector.formatLocalDateKey(new Date(nowMs));

    const cidOld = 'aaaaaaaa-0000-0000-0000-000000000001';
    const cidNew = 'bbbbbbbb-0000-0000-0000-000000000002';
    const legacyCreatedAt = '2026-10-26T13:44:29.000Z';
    const oldWindowCreatedAt = new Date(tOldStart + 120000).toISOString();
    const newWindowCreatedAt = new Date(tNewStart + 60000).toISOString();

    // 建立对应会话 transcript 文件（模拟真实场景：2026-10-26 历史记录 + 旧账号记录 + 新账号今天记录）
    const logDirOld = path.join(agDir, 'brain', cidOld, '.system_generated', 'logs');
    const logDirNew = path.join(agDir, 'brain', cidNew, '.system_generated', 'logs');
    fs.mkdirSync(logDirOld, { recursive: true });
    fs.mkdirSync(logDirNew, { recursive: true });
    fs.writeFileSync(path.join(logDirOld, 'transcript.jsonl'), [
      JSON.stringify({
        step_index: 1, type: 'PLANNER_RESPONSE', created_at: legacyCreatedAt,
        model: 'claude-opus-4-5-thinking', responseId: 'req_legacy_misattr',
        input_tokens: 100000, cache_read_tokens: 200000, output_tokens: 10000
      }),
      JSON.stringify({
        step_index: 2, type: 'PLANNER_RESPONSE', created_at: oldWindowCreatedAt,
        model: 'gemini-3.8-flash', responseId: 'req_old_valid',
        input_tokens: 5000, cache_read_tokens: 10000, output_tokens: 500
      })
    ].join('\n') + '\n');
    fs.writeFileSync(path.join(logDirNew, 'transcript.jsonl'), JSON.stringify({
      step_index: 1, type: 'PLANNER_RESPONSE', created_at: newWindowCreatedAt,
      model: 'gemini-4-hydrogen', responseId: 'req_new_today',
      input_tokens: 2000, cache_read_tokens: 3000, output_tokens: 500
    }) + '\n');

    // 建立账号存储及活跃时段窗口
    fs.writeFileSync(path.join(stateDir, 'accounts_v1.json'), JSON.stringify({
      version: 1,
      activeAccountEmail: newEmail,
      accounts: {
        [oldEmail]: { email: oldEmail, accessToken: 'tok-old', refreshToken: 'ref-old' },
        [newEmail]: { email: newEmail, accessToken: 'tok-new', refreshToken: 'ref-new' }
      },
      accountSessions: [
        { accountScopeKey: oldScope, email: oldEmail, startAtMs: tOldStart, endAtMs: tOldEnd, source: 'test' },
        { accountScopeKey: newScope, email: newEmail, startAtMs: tNewStart, endAtMs: null, source: 'test' }
      ]
    }));

    // 写入混合账本：1) 无可靠时间/早于窗口却错标为新号的 2026-10-26 旧记录 2) 旧账号真实记录 3) 仅今天属于新号的真实记录
    fs.writeFileSync(path.join(agDir, 'pricing_ledger_v1.json'), JSON.stringify({
      version: 1,
      calls: {
        req_legacy_misattr: {
          callId: 'req_legacy_misattr',
          cascadeId: cidOld,
          stepIndex: 1,
          source: 'desktop',
          model: 'claude-opus-4-5-thinking',
          modelKey: 'claude-opus-4-5-thinking',
          isPriced: true,
          inputTokens: 100000,
          cacheTokens: 200000,
          outputTokens: 10000,
          totalTokens: 310000,
          date: '2026-10-26',
          created_at: legacyCreatedAt,
          timestamp: Date.parse('2026-11-17T19:25:00.000Z'),
          updatedAt: '2026-11-17T19:25:03.000Z',
          accountScopeKey: newScope,
          accountAttributionConfidence: 'live_confirmed_account'
        },
        req_old_valid: {
          callId: 'req_old_valid',
          cascadeId: cidOld,
          stepIndex: 2,
          source: 'desktop',
          model: 'gemini-3.8-flash',
          modelKey: 'gemini-3.8-flash',
          isPriced: true,
          inputTokens: 5000,
          cacheTokens: 10000,
          outputTokens: 500,
          totalTokens: 15500,
          date: collector.formatLocalDateKey(new Date(tOldStart + 120000)),
          created_at: oldWindowCreatedAt,
          accountScopeKey: oldScope,
          accountAttributionConfidence: 'live_confirmed_account'
        },
        req_new_today: {
          callId: 'req_new_today',
          cascadeId: cidNew,
          stepIndex: 1,
          source: 'desktop',
          model: 'gemini-4-hydrogen',
          modelKey: 'gemini-4-hydrogen',
          isPriced: true,
          inputTokens: 2000,
          cacheTokens: 3000,
          outputTokens: 500,
          totalTokens: 5500,
          date: today,
          created_at: newWindowCreatedAt,
          accountScopeKey: newScope,
          accountAttributionConfidence: 'live_confirmed_account'
        }
      }
    }));

    // 1. 首次历史采集自动触发 elv89-v2 纠偏，生成 .bak-pre-elv89 备份，且二次执行结果完全不变
    const res1 = await collector.collectTokenHistoryAsync({ agDir, stateDir, wslRoots: [], force: true });
    const res2 = await collector.collectTokenHistoryAsync({ agDir, stateDir, wslRoots: [], force: true });

    const bakFiles = fs.readdirSync(agDir).filter(f => f.includes('.bak-pre-elv89-'));
    assert.ok(bakFiles.length >= 1, '自动纠偏前必须先写入 pricing_ledger 备份');

    assert.equal(res1.summary.grandTotalTokens, 331000);
    assert.equal(res1.usageByAccount[oldScope].totalTokens, 15500);
    assert.equal(res1.usageByAccount[newScope].totalTokens, 5500);
    assert.equal(res1.usageByAccount[newScope].firstUseDate, today);
    assert.equal(res1.unattributedUsage.totalTokens, 310000);
    assert.equal(
      res1.summary.grandTotalTokens,
      res1.usageByAccount[oldScope].totalTokens + res1.usageByAccount[newScope].totalTokens + res1.unattributedUsage.totalTokens,
      '全量必须严格等于各账号 + 未归属之和'
    );
    // 重复执行幂等不变
    assert.deepEqual(res2.usageByAccount[newScope], res1.usageByAccount[newScope]);
    assert.deepEqual(res2.unattributedUsage, res1.unattributedUsage);

    // 2. UI 验证：新账号记录全在今天 -> 四个卡片与今天相等、首次使用=今天；零记录账号 -> 0 与 首次使用：--；来回切换无残留
    const elements = new Map();
    const makeNode = (id) => {
      const attrs = new Map();
      const evs = new Map();
      const clsSet = new Set();
      const n = {
        id: id || '',
        style: { setProperty() {}, removeProperty() {}, getPropertyValue() { return ''; }, display: '' },
        children: [], options: [], selectedOptions: [], hidden: false, disabled: false,
        textContent: '', value: '', title: '', className: '',
        classList: {
          add(c) { clsSet.add(c); n.className = Array.from(clsSet).join(' '); },
          remove(c) { clsSet.delete(c); n.className = Array.from(clsSet).join(' '); },
          contains(c) { return clsSet.has(c); }
        },
        addEventListener(k, fn) { if (!evs.has(k)) evs.set(k, []); evs.get(k).push(fn); },
        dispatchEvent(ev) { for (const fn of (evs.get(ev?.type) || [])) fn(ev); },
        setAttribute(k, v) { attrs.set(k, String(v)); },
        getAttribute(k) { return attrs.get(k) ?? null; },
        removeAttribute(k) { attrs.delete(k); },
        appendChild(c) { if (c) { n.children.push(c); if (n.options) n.options.push(c); } },
        replaceChildren(...items) { n.children = items.filter(Boolean); if (n.options) n.options = items.filter(Boolean); },
        remove() {}, contains() { return false; }, matches() { return false; }, closest() { return null; },
        querySelector() { return null; }, querySelectorAll() { return []; },
        getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 24, right: 100, bottom: 24 }; }
      };
      if (id) elements.set(id, n);
      return n;
    };
    const host = makeNode('ag-host');
    host.attachShadow = () => ({
      set innerHTML(_v) {},
      getElementById(id) { return elements.get(id) || makeNode(id); },
      querySelectorAll() { return []; }
    });
    let first = true;
    const brandNewScope = accountsMod.buildAccountScopeKey('brandnew@example.com');
    const sandbox = {
      location: { protocol: 'https:', hostname: '127.0.0.1', pathname: `/c/${cidNew}` },
      document: {
        createElement: () => (first ? (first = false, host) : makeNode()),
        getElementById: id => elements.get(id) || null,
        documentElement: { appendChild() {} },
        addEventListener() {}, removeEventListener() {}, hidden: false
      },
      window: { __APP_CONFIG__: { csrfToken: 't' }, contextMeterAPI: {} },
      matchMedia: () => ({ matches: false }),
      __AGContextMeterCore: core, AbortController, Date,
      setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
      fetch: async () => ({ ok: true, json: async () => ({ generatorMetadata: [] }) })
    };
    vm.createContext(sandbox);
    vm.runInContext(RENDERER_SOURCE, sandbox);
    const api = sandbox.__AGContextMeter;
    try {
      api.setAccountsOverviewForTest({
        activeAccountEmail: newEmail,
        activeAccountScopeKey: newScope,
        accounts: [
          { email: oldEmail, accountScopeKey: oldScope, isActive: false },
          { email: newEmail, accountScopeKey: newScope, isActive: true },
          { email: 'brandnew@example.com', accountScopeKey: brandNewScope, isActive: false }
        ]
      });
      api.applyTokenHistoryPayload(res1);

      // 切到全在今天的新号 -> 4 卡片均等于 5500（5.5K）
      const [ty, tm, td] = today.split('-').map(Number);
      api.setTokenAccountFilterForTest(newScope);
      assert.equal(elements.get('t-total-val').textContent, '5.5K');
      assert.equal(elements.get('t-today-val').textContent, '5.5K');
      assert.equal(elements.get('t-month-val').textContent, '5.5K');
      assert.equal(elements.get('t-year-val').textContent, '5.5K');
      assert.equal(elements.get('token-amount').textContent, '5.5K');
      assert.equal(elements.get('first-use-badge').textContent, `首次使用：${ty}年${tm}月${td}日`);

      // 切到没有任何可靠记录的全新号 -> 全 0 且首次使用：--
      api.setTokenAccountFilterForTest(brandNewScope);
      assert.equal(elements.get('t-total-val').textContent, '0');
      assert.equal(elements.get('t-today-val').textContent, '0');
      assert.equal(elements.get('t-month-val').textContent, '0');
      assert.equal(elements.get('t-year-val').textContent, '0');
      assert.equal(elements.get('token-amount').textContent, '0');
      assert.equal(elements.get('first-use-badge').textContent, '首次使用：--');

      // 切到老号 -> 老号独立数据 15.5K，再切回 brandNew -> 仍为 0 与 --，无残留
      api.setTokenAccountFilterForTest(oldScope);
      assert.equal(elements.get('t-total-val').textContent, '15.5K');
      api.setTokenAccountFilterForTest(brandNewScope);
      assert.equal(elements.get('t-total-val').textContent, '0');
      assert.equal(elements.get('first-use-badge').textContent, '首次使用：--');

      // 切回全账号 -> 331.0K
      api.setTokenAccountFilterForTest('all');
      assert.equal(elements.get('t-total-val').textContent, '331.0K');
    } finally {
      api.dispose();
    }
  } finally {
    fs.rmSync(agDir, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('v0.8.8 移除账号回归: 取消/防重/失败重试/筛选复位/活跃与最后账号边界及保留历史用量', async () => {
  const agDir = makeTempDir('acm-rm-ag-');
  const stateDir = makeTempDir('acm-rm-st-');
  try {
    const emailA = 'active@example.com';
    const emailB = 'backup@example.com';
    const scopeA = accountsMod.buildAccountScopeKey(emailA);
    const scopeB = accountsMod.buildAccountScopeKey(emailB);
    const nowMs = Date.now();
    const today = collector.formatLocalDateKey(new Date(nowMs));
    const ledgerPath = path.join(agDir, 'pricing_ledger_v1.json');

    // 先写入归属到 active@example.com 的本机用量
    collector.recordModelCalls([
      {
        callId: 'req_rm_keep_1',
        cascadeId: 'cccccccc-0000-0000-0000-000000000001',
        source: 'desktop',
        model: 'gemini-4-hydrogen',
        isPriced: true,
        inputTokens: 4000,
        cacheTokens: 6000,
        outputTokens: 1000,
        totalTokens: 11000,
        date: today,
        created_at: new Date(nowMs - 5000).toISOString(),
        liveRealtimeConfirmed: true
      }
    ], { agDir, confirmedAccountEmail: emailA });

    const credStore = makeMockCredStore();
    let switchCalled = 0;
    const mgr = accountsMod.createAccountsManager({
      stateDir,
      restartLanguageServers: async () => ({ ok: true }),
      credentialStore: {
        ...credStore,
        applyCredential: (c) => { switchCalled++; return credStore.applyCredential(c); }
      }
    });
    mgr.addAccountWithCredential({ email: emailA, accessToken: 'ta', refreshToken: 'ra', expiresAt: new Date(nowMs + 3600000).toISOString() });
    mgr.addAccountWithCredential({ email: emailB, accessToken: 'tb', refreshToken: 'rb', expiresAt: new Date(nowMs + 3600000).toISOString() });
    // 将 A 置为当前活跃账号，再清零 switchCalled 以严格验证移除期间绝不触发切号
    await mgr.switchActiveAccount(emailA, { forceWhileBusy: true, assumeVerifiedInDryRun: true });
    switchCalled = 0;
    mgr.updateAutoSwitchConfig({ enabled: true, candidates: [emailA, emailB] });

    // 1. 后端移除当前活跃账号 active@example.com：凭据与候选清除、不擅自切到 B、历史账本原归属保留
    const rm1 = await accountsMod.dispatchAccountsAction(mgr, { action: 'remove', email: emailA });
    assert.equal(rm1.ok, true);
    assert.equal(rm1.wasActive, true);
    assert.equal(rm1.removedScopeKey, scopeA);
    assert.equal(switchCalled, 0, '移除当前活跃账号绝不能擅自自动切号');
    assert.equal(rm1.overview.activeAccountEmail, null);
    assert.deepEqual(rm1.overview.autoSwitch.candidates, [emailB]);
    assert.equal(rm1.overview.accounts.length, 1);

    // 移除最后一个账号 B：autoSwitch 自动收拢关闭，历史账本依旧保留原归属
    const rm2 = await accountsMod.dispatchAccountsAction(mgr, { action: 'remove', email: emailB });
    assert.equal(rm2.ok, true);
    assert.equal(rm2.remainingCount, 0);
    assert.equal(rm2.overview.accounts.length, 0);
    assert.equal(rm2.overview.autoSwitch.enabled, false);
    assert.equal(rm2.overview.autoSwitchStatus.state, 'disabled');
    const persistedLedger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    assert.equal(persistedLedger.calls.req_rm_keep_1.accountScopeKey, scopeA, '移除账号后原账本归属与用量必须完整保留');
    assert.equal(persistedLedger.calls.req_rm_keep_1.totalTokens, 11000);

    // 重新建一个 2 账号经理供 UI 弹窗交互与失败重试测试
    const mgrUi = accountsMod.createAccountsManager({
      stateDir: makeTempDir('acm-rm-ui-'),
      credentialStore: makeMockCredStore(),
      restartLanguageServers: async () => ({ ok: true })
    });
    mgrUi.addAccountWithCredential({ email: emailA, accessToken: 'ta', refreshToken: 'ra', expiresAt: new Date(nowMs + 3600000).toISOString() });
    mgrUi.addAccountWithCredential({ email: emailB, accessToken: 'tb', refreshToken: 'rb', expiresAt: new Date(nowMs + 3600000).toISOString() });
    await mgrUi.switchActiveAccount(emailA, { forceWhileBusy: true, assumeVerifiedInDryRun: true });
    mgrUi.updateAutoSwitchConfig({ enabled: false, candidates: [emailA, emailB] });

    const elements = new Map();
    const makeNode = (id) => {
      const attrs = new Map();
      const evs = new Map();
      const clsSet = new Set();
      const n = {
        id: id || '',
        style: { setProperty() {}, removeProperty() {}, getPropertyValue() { return ''; }, display: '' },
        children: [], options: [], selectedOptions: [], hidden: false, disabled: false,
        textContent: '', value: '', title: '', className: '', dataset: {},
        classList: {
          add(c) { clsSet.add(c); n.className = Array.from(clsSet).join(' '); },
          remove(c) { clsSet.delete(c); n.className = Array.from(clsSet).join(' '); },
          contains(c) { return clsSet.has(c); }
        },
        addEventListener(k, fn) { if (!evs.has(k)) evs.set(k, []); evs.get(k).push(fn); },
        dispatchEvent(ev) { for (const fn of (evs.get(ev?.type) || [])) fn(ev || { type: '' }); },
        setAttribute(k, v) { attrs.set(k, String(v)); },
        getAttribute(k) { return attrs.get(k) ?? null; },
        removeAttribute(k) { attrs.delete(k); },
        appendChild(c) { if (c) { n.children.push(c); if (n.options) n.options.push(c); } },
        replaceChildren(...items) { n.children = items.filter(Boolean); if (n.options) n.options = items.filter(Boolean); },
        remove() {}, contains() { return false; }, matches() { return false; }, closest() { return null; },
        querySelector() { return null; }, querySelectorAll() { return []; },
        getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 24, right: 100, bottom: 24 }; }
      };
      if (id) elements.set(id, n);
      return n;
    };
    const host = makeNode('ag-host');
    host.attachShadow = () => ({
      set innerHTML(_v) {},
      getElementById(id) { return elements.get(id) || makeNode(id); },
      querySelectorAll() { return []; }
    });

    let failRemoveOnce = true;
    let ipcCalls = 0;
    let releaseDelay = null;
    let first = true;
    const sandbox = {
      location: { protocol: 'https:', hostname: '127.0.0.1', pathname: '/c/11111111-1111-1111-1111-111111111111' },
      document: {
        createElement: () => (first ? (first = false, host) : makeNode()),
        getElementById: id => elements.get(id) || null,
        documentElement: { appendChild() {} },
        addEventListener() {}, removeEventListener() {}, hidden: false
      },
      window: {
        __APP_CONFIG__: { csrfToken: 't' },
        contextMeterAPI: {
          getAccountsOverview: async () => mgrUi.getOverviewState(),
          accountsAction: async (payload) => {
            if (payload?.action === 'remove') {
              ipcCalls += 1;
              if (releaseDelay) await new Promise(r => { releaseDelay = r; });
              if (failRemoveOnce) {
                failRemoveOnce = false;
                return { ok: false, error: '模拟磁盘忙，移除失败' };
              }
            }
            return await accountsMod.dispatchAccountsAction(mgrUi, payload);
          }
        }
      },
      matchMedia: () => ({ matches: false }),
      __AGContextMeterCore: core, AbortController, Date,
      setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
      fetch: async () => ({ ok: true, json: async () => ({ generatorMetadata: [] }) })
    };
    vm.createContext(sandbox);
    vm.runInContext(RENDERER_SOURCE, sandbox);
    const api = sandbox.__AGContextMeter;
    try {
      api.setAccountsOverviewForTest(mgrUi.getOverviewState());
      api.applyTokenHistoryPayload({
        dailyMap: { [today]: { total: 11000, input: 4000, cache: 6000, output: 1000 } },
        dailyMapBySource: { all: { [today]: { total: 11000, input: 4000, cache: 6000, output: 1000 } } },
        summary: { grandTotalTokens: 11000, todayTokens: 11000, monthTokens: 11000, yearTokens: 11000 },
        usageByAccount: {
          [scopeA]: {
            totalTokens: 11000, todayTokens: 11000, monthTokens: 11000, yearTokens: 11000, firstUseDate: today,
            dailyMap: { [today]: { total: 11000, input: 4000, cache: 6000, output: 1000 } }
          }
        },
        unattributedUsage: { totalTokens: 0, todayTokens: 0, monthTokens: 0, yearTokens: 0, dailyMap: {} }
      });

      // 正在筛选 active@example.com
      api.setTokenAccountFilterForTest(scopeA);
      assert.equal(api.getAccountsPanelStateForTest().activeFilter, scopeA);

      // 2. 打开确认框 -> 取消不修改任何状态且支持三语确认文案
      const findRemoveBtn = (email) => {
        for (const card of elements.get('quota-accounts-list').children) {
          const topRow = card.children?.[0];
          const right = topRow?.children?.[1];
          for (const btn of (right?.children || [])) {
            if (btn.dataset?.removeEmail === email) return btn;
          }
        }
        return null;
      };
      const rmBtnA = findRemoveBtn(emailA);
      assert.ok(rmBtnA, '每张账号卡必须渲染移除账号按钮');
      rmBtnA.dispatchEvent({ type: 'click' });
      assert.equal(elements.get('account-remove-modal').hidden, false);
      assert.match(elements.get('modal-account-remove-text').textContent, /登录凭据.*自动切号候选.*历史用量与原有账号归属会保留/);
      assert.match(elements.get('modal-account-remove-text').textContent, /不会自动切换/);

      await api.setPanelLanguage('zh-TW', { persist: false });
      assert.match(elements.get('modal-account-remove-text').textContent, /登入憑證.*自動切號候選.*歷史用量與原有帳號歸屬會保留/);
      await api.setPanelLanguage('en', { persist: false });
      assert.match(elements.get('modal-account-remove-text').textContent, /credentials.*auto-switch candidacy.*usage history and existing attribution are preserved/i);
      await api.setPanelLanguage('zh-CN', { persist: false });

      elements.get('btn-modal-account-remove-cancel').dispatchEvent({ type: 'click' });
      assert.equal(elements.get('account-remove-modal').hidden, true);
      assert.equal(ipcCalls, 0);
      assert.equal(api.getAccountsPanelStateForTest().activeFilter, scopeA);

      // 3. 重新打开并点击确认 -> 首次模拟失败可重试
      rmBtnA.dispatchEvent({ type: 'click' });
      const failRes = await api.confirmRemoveAccountModalForTest();
      assert.equal(failRes.ok, false);
      assert.equal(elements.get('account-remove-modal').hidden, false, '失败后弹窗应保持开启供重试');
      assert.equal(elements.get('btn-modal-account-remove-confirm').disabled, false, '失败后确认按钮恢复可重试');
      assert.match(elements.get('modal-account-remove-feedback').textContent, /模拟磁盘忙/);

      // 4. 重试触发期间防止并发二次提交
      releaseDelay = () => {};
      const p1 = api.confirmRemoveAccountModalForTest();
      const p2 = api.confirmRemoveAccountModalForTest();
      assert.equal(await p2, null, '确认移除提交期间必须防重复提交');
      const rDone = releaseDelay;
      releaseDelay = null;
      rDone();
      const okRes = await p1;
      assert.equal(okRes.ok, true);
      assert.equal(ipcCalls, 2);
      assert.equal(elements.get('account-remove-modal').hidden, true);
      assert.equal(api.getAccountsPanelStateForTest().accountCount, 1);
      assert.equal(api.getAccountsPanelStateForTest().activeFilter, 'all', '正在筛选被移除账号时必须自动回到全账号');
    } finally {
      api.dispose();
    }
  } finally {
    fs.rmSync(agDir, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('v0.8.8 OAuth配对与切号刷新闭环: 401 client_secret 错配不误标 authInvalid / 真正 invalid_grant 标记重授 / 切号失败回滚保留原活跃号 / 失败不显示操作已完成', async () => {
  const stateDir = makeTempDir('acm-oauth-401-');
  try {
    // 1. 若宿主安装了 Antigravity 二进制，校验官方配对表里 clientId 与 clientSecret 严格配对（不再把 107100... 配给 GOCSPX-9Y...）
    const pairs = accountsMod.resolveAllAntigravityOAuthConfigs();
    if (pairs.length >= 2 && pairs[0].source === 'antigravity_host_binary') {
      const defPair = pairs.find(p => p.key === 'antigravity_default');
      const entPair = pairs.find(p => p.key === 'antigravity_enterprise');
      assert.ok(defPair && entPair);
      assert.notEqual(defPair.clientId, entPair.clientId);
      assert.notEqual(defPair.clientSecret, entPair.clientSecret);
    }

    // 2. 模拟历史因 401 client secret is invalid 误标的账号自动自愈 + 401 invalid_client 不误标 authInvalid 且保留上次快照
    const preHealPath = path.join(stateDir, 'accounts_v1.json');
    fs.writeFileSync(preHealPath, JSON.stringify({
      version: 1,
      activeAccountEmail: 'keep@example.com',
      accounts: {
        'keep@example.com': {
          email: 'keep@example.com',
          source: 'client_import',
          credential: { accessToken: 'tok-keep', refreshToken: 'ref-keep', expiresAt: new Date(Date.now() + 3600000).toISOString() },
          authInvalid: false
        },
        'healed@example.com': {
          email: 'healed@example.com',
          source: 'antigravity_tools_import',
          credential: { accessToken: 'tok-old', refreshToken: 'ref-valid', expiresAt: '2020-01-01T00:00:00.000Z' },
          authInvalid: true,
          authError: '刷新 Token 失败 (HTTP 401): The provided client secret is invalid.',
          quotaSnapshot: buildMockQuotaSnapshot(0.82),
          lastQuotaUpdatedAtMs: 1760000000000
        },
        'revoked@example.com': {
          email: 'revoked@example.com',
          source: 'oauth_login',
          credential: { accessToken: 'tok-rev', refreshToken: 'ref-revoked', expiresAt: '2020-01-01T00:00:00.000Z' },
          authInvalid: false
        }
      }
    }));

    let fetchMode = 'refresh_success';
    let hostActiveEmail = 'keep@example.com';
    const credStore = makeMockCredStore();
    credStore.applyCredential({ email: 'keep@example.com', accessToken: 'tok-keep', refreshToken: 'ref-keep', expiresAt: new Date(Date.now() + 3600000).toISOString() });

    const mockFetch = async (url, init) => {
      if (String(url).includes('oauth2.googleapis.com/token')) {
        const body = String(init?.body || '');
        if (fetchMode === 'http401_client_secret') {
          return {
            ok: false,
            status: 401,
            text: async () => JSON.stringify({ error: 'invalid_client', error_description: 'The provided client secret is invalid.' })
          };
        }
        if (body.includes('ref-revoked')) {
          return {
            ok: false,
            status: 400,
            text: async () => JSON.stringify({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' })
          };
        }
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ access_token: 'tok-refreshed-new', expires_in: 3600 })
        };
      }
      if (String(url).includes('loadCodeAssist')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ cloudaicompanionProject: 'proj-1', currentTier: { id: 'g1-ultra-tier' } }) };
      }
      if (String(url).includes('fetchAvailableModels')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            models: {
              'gemini-4-hydrogen': { displayName: 'Gemini 4 Hydrogen', quotaInfo: { remainingFraction: 0.91, resetTime: '2026-11-19T00:00:00Z' } }
            }
          })
        };
      }
      return { ok: true, status: 200, text: async () => '{}' };
    };

    const mgr = accountsMod.createAccountsManager({
      stateDir,
      oauthClientId: 'mock-cid',
      oauthClientSecret: 'mock-sec',
      credentialStore: credStore,
      fetch: mockFetch,
      getHostUserStatus: async () => ({ email: hostActiveEmail }),
      restartLanguageServers: async () => ({ ok: true })
    });

    // 加载即自愈误标 authInvalid
    const ovInit = mgr.getOverviewState();
    const healedInit = ovInit.accounts.find(a => a.email === 'healed@example.com');
    assert.equal(healedInit.authInvalid, false, '历史 client_secret 401 误标应自动清除');

    // A) 模拟刷新遇到 HTTP 401 invalid_client：不误标 authInvalid，保留上次快照，并返回明确错误
    fetchMode = 'http401_client_secret';
    const fail401 = await accountsMod.dispatchAccountsAction(mgr, { action: 'refresh_quota', email: 'healed@example.com' });
    assert.equal(fail401.ok, false);
    assert.equal(fail401.httpStatus, 401);
    assert.equal(fail401.stage, 'token_refresh');
    assert.equal(fail401.authInvalid, false, 'HTTP 401 client_secret 错误绝不能误标用户需重新授权');
    assert.equal(fail401.isClientMismatch, true);
    const after401 = fail401.overview.accounts.find(a => a.email === 'healed@example.com');
    assert.equal(after401.authInvalid, false);
    assert.equal(after401.quotaSnapshot.pools[0].remainingFraction, 0.82, '刷新失败必须完整保留上次额度快照');
    assert.equal(after401.lastQuotaUpdatedAtMs, 1760000000000);
    assert.match(after401.lastQuotaError, /HTTP 401/);

    // B) 真正 invalid_grant 才标记 authInvalid = true 并允许切号拒绝
    fetchMode = 'refresh_success';
    const failGrant = await accountsMod.dispatchAccountsAction(mgr, { action: 'refresh_quota', email: 'revoked@example.com' });
    assert.equal(failGrant.ok, false);
    assert.equal(failGrant.authInvalid, true);
    assert.equal(failGrant.overview.accounts.find(a => a.email === 'revoked@example.com').authInvalid, true);

    // C) 批量刷新只要有失败项，绝不返回 ok:true（否则前端会显示"操作已完成"）
    fetchMode = 'refresh_success';
    const batchRes = await accountsMod.dispatchAccountsAction(mgr, { action: 'refresh_quota' });
    assert.equal(batchRes.ok, false, '含失败项的批量刷新不能返回 ok:true');
    assert.equal(batchRes.failCount, 1);
    assert.ok(batchRes.successCount >= 2);
    assert.match(batchRes.error, /失败 1/);
    const healedNow = batchRes.overview.accounts.find(a => a.email === 'healed@example.com');
    assert.equal(healedNow.quotaSnapshot.pools[0].remainingFraction, 0.91, '成功刷新必须更新为最新额度快照');
    assert.equal(healedNow.lastQuotaError, null);

    // D) 手动切号验证失败（GetUserStatus 仍返回原账号）时自动回滚凭据，界面保持原活跃账号且提示失败
    const swFail = await accountsMod.dispatchAccountsAction(mgr, { action: 'switch', email: 'healed@example.com', forceWhileBusy: true, verifyTimeoutMs: 60 });
    assert.equal(swFail.ok, false);
    assert.equal(swFail.rolledBack, true);
    assert.equal(credStore.getApplied().email, 'keep@example.com');
    assert.equal(swFail.overview.activeAccountEmail, 'keep@example.com', '切号失败必须继续保持原活跃账号');

    // E) UI 验证：失败操作绝不显示"操作已完成"且 feedbackTone === 'error'
    const elements = new Map();
    const makeNode = (id) => {
      const attrs = new Map(); const evs = new Map(); const clsSet = new Set();
      const n = {
        id: id || '', style: { setProperty() {}, removeProperty() {}, getPropertyValue() { return ''; }, display: '' },
        children: [], options: [], selectedOptions: [], hidden: false, disabled: false, textContent: '', value: '', title: '', className: '', dataset: {},
        classList: {
          add(c) { clsSet.add(c); n.className = Array.from(clsSet).join(' '); },
          remove(c) { clsSet.delete(c); n.className = Array.from(clsSet).join(' '); },
          contains(c) { return clsSet.has(c); }
        },
        addEventListener(k, fn) { if (!evs.has(k)) evs.set(k, []); evs.get(k).push(fn); },
        dispatchEvent(ev) { for (const fn of (evs.get(ev?.type) || [])) fn(ev || { type: '' }); },
        setAttribute(k, v) { attrs.set(k, String(v)); }, getAttribute(k) { return attrs.get(k) ?? null; }, removeAttribute(k) { attrs.delete(k); },
        appendChild(c) { if (c) { n.children.push(c); if (n.options) n.options.push(c); } },
        replaceChildren(...items) { n.children = items.filter(Boolean); if (n.options) n.options = items.filter(Boolean); },
        remove() {}, contains() { return false; }, matches() { return false; }, closest() { return null; }, querySelector() { return null; }, querySelectorAll() { return []; },
        getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 24, right: 100, bottom: 24 }; }
      };
      if (id) elements.set(id, n);
      return n;
    };
    const host = makeNode('ag-host');
    host.attachShadow = () => ({ set innerHTML(_v) {}, getElementById: id => elements.get(id) || makeNode(id), querySelectorAll: () => [] });
    let first = true;
    const sandbox = {
      location: { protocol: 'https:', hostname: '127.0.0.1', pathname: '/c/11111111-1111-1111-1111-111111111111' },
      document: { createElement: () => (first ? (first = false, host) : makeNode()), getElementById: id => elements.get(id) || null, documentElement: { appendChild() {} }, addEventListener() {}, removeEventListener() {}, hidden: false },
      window: {
        __APP_CONFIG__: { csrfToken: 't' },
        contextMeterAPI: {
          getAccountsOverview: async () => mgr.getOverviewState(),
          accountsAction: async (payload) => await accountsMod.dispatchAccountsAction(mgr, {
            ...payload,
            ...(payload?.action === 'switch' ? { verifyTimeoutMs: 60 } : {})
          })
        }
      },
      matchMedia: () => ({ matches: false }),
      __AGContextMeterCore: core, AbortController, Date,
      setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {},
      fetch: async () => ({ ok: true, json: async () => ({ generatorMetadata: [] }) })
    };
    vm.createContext(sandbox);
    vm.runInContext(RENDERER_SOURCE, sandbox);
    const api = sandbox.__AGContextMeter;
    try {
      api.setAccountsOverviewForTest(mgr.getOverviewState());
      const findSwitchBtn = (email) => {
        for (const card of elements.get('quota-accounts-list').children) {
          const titleEmail = card.children?.[0]?.children?.[0]?.title;
          if (titleEmail !== email) continue;
          const right = card.children?.[0]?.children?.[1];
          for (const btn of (right?.children || [])) {
            if (btn.textContent === '切号') return btn;
          }
        }
        return null;
      };
      // 点切号失败
      const swBtn = findSwitchBtn('healed@example.com');
      assert.ok(swBtn);
      swBtn.dispatchEvent({ type: 'click' });
      for (let w = 0; w < 40; w++) {
        if (api.getAccountsPanelStateForTest().feedbackTone === 'error') break;
        await new Promise(r => setTimeout(r, 25));
      }
      assert.equal(api.getAccountsPanelStateForTest().feedbackTone, 'error');
      assert.doesNotMatch(api.getAccountsPanelStateForTest().feedback, /操作已完成/);
      assert.match(api.getAccountsPanelStateForTest().feedback, /凭据验证未生效|回滚/);

      // 真实切号成功后再验证 UI 变为成功且切换活跃账号
      hostActiveEmail = 'healed@example.com';
      const swSuccess = await accountsMod.dispatchAccountsAction(mgr, { action: 'switch', email: 'healed@example.com', forceWhileBusy: true, verifyTimeoutMs: 60 });
      assert.equal(swSuccess.ok, true);
      assert.equal(swSuccess.overview.activeAccountEmail, 'healed@example.com');
    } finally {
      api.dispose();
    }
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('v0.9.0 自动切号精修 7+ 场景闭环: blocked_missing_pool 精确分型 / 高于阈值保持 / 恰好阈值切换 / 恢复清防抖 / 过期候选静默刷新不丢快照 / 关闭与冷却保护', async () => {
  const tmpDir = makeTempDir('acm-autosw-v090-');
  const stateDir = path.join(tmpDir, 'state');
  const credStore = makeMockCredStore();
  let currentHostEmail = 'a@example.com';
  let candidateFetchCount = 0;

  const makePool = (poolKey, pct, opts = {}) => ({
    poolKey,
    status: opts.noPermission ? 'no_permission' : 'available',
    noPermission: Boolean(opts.noPermission),
    remainingFraction: opts.noPermission ? null : pct,
    primaryBucket: { remainingFraction: opts.noPermission ? null : pct, windowKey: opts.win || '5h' },
    buckets: opts.buckets !== undefined ? opts.buckets : [
      { windowKey: '5h', windowShort: '5h', remainingFraction: pct },
      { windowKey: '7d', windowShort: '7d', remainingFraction: opts.pct7d ?? pct }
    ]
  });

  const resetIso = new Date(Date.now() + 2 * 3600000).toISOString();
  const mgr = accountsMod.createAccountsManager({
    stateDir,
    credentialStore: credStore,
    fetch: async (url) => {
      const u = String(url || '');
      if (u.includes('loadCodeAssist')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ cloudaicompanionProject: 'proj-b', currentTier: { id: 'g1-ultra-tier' } }) };
      }
      if (u.includes('fetchAvailableModels')) {
        candidateFetchCount++;
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            models: {
              'gemini-4-hydrogen': { displayName: 'Gemini 4 Hydrogen', quotaInfo: { remainingFraction: 0.82, resetTime: new Date(47000 + 2 * 3600000).toISOString() } },
              'claude-3-5-sonnet': { displayName: 'Claude 3.5 Sonnet', quotaInfo: { remainingFraction: 0.82, resetTime: new Date(47000 + 2 * 3600000).toISOString() } }
            }
          })
        };
      }
      if (u.includes('retrieveUserQuotaSummary')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            groups: [
              {
                groupId: 'gemini-main',
                displayName: 'Gemini 4 Hydrogen / Neon',
                buckets: [
                  {
                    bucketId: '5h',
                    window: '5h',
                    remainingFraction: 0.82,
                    resetTime: new Date(47000 + 2 * 3600000).toISOString()
                  }
                ]
              }
            ]
          })
        };
      }
      return { ok: true, status: 200, text: async () => '{}' };
    },
    getHostUserStatus: async () => ({ email: currentHostEmail }),
    restartLanguageServers: async () => ({ ok: true })
  });

  try {
    const futureExp = new Date(Date.now() + 3600000).toISOString();
    mgr.addAccountWithCredential({ email: 'a@example.com', accessToken: 'tA', refreshToken: 'rA', expiresAt: futureExp });
    mgr.addAccountWithCredential({ email: 'b@example.com', accessToken: 'tB', refreshToken: 'rB', expiresAt: futureExp });
    await mgr.refreshAccountQuota('a@example.com', {
      mockQuotaSnapshot: { pools: [makePool('shared_gemini_main', 0.50)] },
      nowMs: 1000
    });
    // 给 B 预设一个过期的旧快照（lastQuotaUpdatedAtMs = 1000）
    await mgr.refreshAccountQuota('b@example.com', {
      mockQuotaSnapshot: { pools: [makePool('shared_gemini_main', 0.90), makePool('shared_3p_pool', 0.90)] },
      nowMs: 1000
    });

    // 场景 1: blocked_missing_pool 三种根因精确分型 + 修改规则清除旧 blockedReason
    // 1A: 监控池在当前账号快照中完全缺失 -> target_pool_missing_in_snapshot（不得误报无权限）
    mgr.updateAutoSwitchConfig({
      enabled: true,
      poolKey: 'shared_3p_pool',
      metricMode: 'remaining_pct',
      windowKey: '5h',
      thresholdPct: 10,
      debounceSec: 0,
      cooldownSec: 120,
      waitUntilIdle: true,
      candidates: ['b@example.com']
    });
    const missPoolRes = await mgr.evaluateAutoSwitch({
      activeEmail: 'a@example.com',
      activeSnapshot: { pools: [makePool('shared_gemini_main', 0.50)] },
      syncState: 'fresh',
      nowMs: 5000
    });
    assert.equal(missPoolRes.state, 'blocked_missing_pool');
    assert.equal(missPoolRes.reason, 'target_pool_missing_in_snapshot');
    assert.equal(missPoolRes.blockedMeta?.poolKey, 'shared_3p_pool');

    // 1B: 监控池存在但无权限 -> target_pool_no_permission
    const noPermRes = await mgr.evaluateAutoSwitch({
      activeEmail: 'a@example.com',
      activeSnapshot: { pools: [makePool('shared_3p_pool', 0, { noPermission: true })] },
      syncState: 'fresh',
      nowMs: 6000
    });
    assert.equal(noPermRes.state, 'blocked_missing_pool');
    assert.equal(noPermRes.reason, 'target_pool_no_permission');

    // 1C: 开启态修改规则切换回 shared_gemini_main 且指定 7d（若快照仅含 5h，不回退 main 顶层 -> target_window_unavailable）
    const updRes = mgr.updateAutoSwitchConfig({ poolKey: 'shared_gemini_main', windowKey: '7d' });
    assert.equal(updRes.autoSwitchStatus.state, 'watching');
    assert.equal(updRes.autoSwitchStatus.blockedReason, null);
    assert.equal(updRes.autoSwitchStatus.blockedMeta, null);
    const missWinRes = await mgr.evaluateAutoSwitch({
      activeEmail: 'a@example.com',
      activeSnapshot: {
        pools: [makePool('shared_gemini_main', 0.05, { buckets: [{ windowKey: '5h', windowShort: '5h', remainingFraction: 0.05 }] })]
      },
      syncState: 'fresh',
      nowMs: 7000
    });
    assert.equal(missWinRes.state, 'blocked_missing_pool');
    assert.equal(missWinRes.reason, 'target_window_unavailable');

    // 场景 2: 切回 5h 窗口、设 debounce 10s：剩余 11% > 10% 保持不切且清除旧 blockedReason
    mgr.updateAutoSwitchConfig({ poolKey: 'shared_gemini_main', windowKey: '5h', debounceSec: 10, thresholdPct: 10 });
    const aboveRes = await mgr.evaluateAutoSwitch({
      activeEmail: 'a@example.com',
      activeSnapshot: { pools: [makePool('shared_gemini_main', 0.11)] },
      syncState: 'fresh',
      nowMs: 10000
    });
    assert.equal(aboveRes.action, 'ok_above_threshold');
    assert.equal(aboveRes.state, 'watching');

    // 场景 3: 恰好达到阈值 (10% <= 10%) 触发防抖；随后恢复至 40% 重置该规则键的防抖计数；再跌回 10% 仍需重新经过 10s 防抖，不得瞬间误切！
    const debStart = await mgr.evaluateAutoSwitch({
      activeEmail: 'a@example.com',
      activeSnapshot: { pools: [makePool('shared_gemini_main', 0.10)] },
      syncState: 'fresh',
      nowMs: 20000
    });
    assert.equal(debStart.action, 'pending_debounce');
    const recoveredRes = await mgr.evaluateAutoSwitch({
      activeEmail: 'a@example.com',
      activeSnapshot: { pools: [makePool('shared_gemini_main', 0.40)] },
      syncState: 'fresh',
      nowMs: 25000
    });
    assert.equal(recoveredRes.action, 'ok_above_threshold');
    // 此处距离 20000ms 已超过 10s，但因刚才 40% 清除了 `a@example.com|shared_gemini_main|primary` 防抖键，此时 10% 必须重新进入 pending_debounce！
    const debRestart = await mgr.evaluateAutoSwitch({
      activeEmail: 'a@example.com',
      activeSnapshot: { pools: [makePool('shared_gemini_main', 0.10)] },
      syncState: 'fresh',
      nowMs: 36000
    });
    assert.equal(debRestart.action, 'pending_debounce', '恢复高于阈值后再跌回必须重新计时防抖');

    // 场景 4 & 5: 过防抖期 (47000ms)，且候选 B 快照已过期 (nowMs - 1000 = 46000 > maxStaleMs=10000) -> 静默刷新 B 且成功切换 A -> B，并收敛 state = cooldown
    currentHostEmail = 'b@example.com';
    const swRes = await mgr.evaluateAutoSwitch({
      activeEmail: 'a@example.com',
      activeSnapshot: { pools: [makePool('shared_gemini_main', 0.10)] },
      syncState: 'fresh',
      isGenerating: false,
      candidateMaxStaleMs: 10000,
      skipTokenRefresh: true,
      nowMs: 47000
    });
    assert.ok(candidateFetchCount >= 1, '过期候选必须按需触发一次静默配额刷新');
    assert.equal(swRes.ok, true);
    assert.equal(swRes.action, 'switched');
    assert.equal(swRes.toEmail, 'b@example.com');
    assert.equal(swRes.state, 'cooldown');
    assert.equal(mgr.getOverviewState().autoSwitchStatus.state, 'cooldown');
    assert.equal(mgr.getOverviewState().autoSwitchStatus.blockedReason, null);

    // 场景 6: 冷却期内再次达阈值不重复切换
    const cdRes = await mgr.evaluateAutoSwitch({
      activeEmail: 'b@example.com',
      activeSnapshot: { pools: [makePool('shared_gemini_main', 0.05)] },
      syncState: 'fresh',
      nowMs: 60000
    });
    assert.equal(cdRes.action, 'cooldown');

    // 场景 7: 关闭自动切号后彻底不触发
    mgr.updateAutoSwitchConfig({ enabled: false });
    const disRes = await mgr.evaluateAutoSwitch({
      activeEmail: 'b@example.com',
      activeSnapshot: { pools: [makePool('shared_gemini_main', 0.01)] },
      syncState: 'fresh',
      nowMs: 500000
    });
    assert.equal(disRes.action, 'noop');
    assert.equal(disRes.state, 'disabled');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Phase 1.3: 取消重启安全回滚原凭据 / 25s后错账及120s超时自动回滚与停用 / 规则跨冷重启实例持久化保留', async () => {
  const tmpDir = makeTempDir('acm-phase13-restart-');
  try {
    let activeSysEmail = 'a@example.com';
    let hostReportEmail = 'a@example.com';
    const fakeCredStore = {
      getPaths: () => ({ desktopDbPath: '', ideDbPath: '', googleAccountsPath: '' }),
      captureSnapshot: () => ({ winCred: { id_token_email: activeSysEmail } }),
      applyCredential: (c) => { activeSysEmail = c.email; return { ok: true, stage: 'done' }; },
      restoreSnapshot: (s) => { activeSysEmail = s?.winCred?.id_token_email || activeSysEmail; return { ok: true }; }
    };

    const mgr1 = accountsMod.createAccountsManager({
      stateDir: tmpDir,
      credentialStore: fakeCredStore,
      getHostUserStatus: async () => ({ email: hostReportEmail })
    });
    mgr1.addAccountWithCredential({ email: 'a@example.com', accessToken: 'tok-a', refreshToken: 'rt-a', expiresAt: new Date(Date.now() + 3600000).toISOString() });
    mgr1.addAccountWithCredential({ email: 'b@example.com', accessToken: 'tok-b', refreshToken: 'rt-b', expiresAt: new Date(Date.now() + 3600000).toISOString() });
    await mgr1.detectCurrentActiveAccount();

    // 1. 保存自动切号规则后重建管理器实例模拟冷重启，校验字段完整保留且默认首次安装为关闭
    mgr1.updateAutoSwitchConfig({
      enabled: true,
      poolKey: 'shared_gemini_main',
      metricMode: 'remaining_pct',
      windowKey: '5h',
      thresholdPct: 22,
      candidates: ['b@example.com']
    });
    const mgr2 = accountsMod.createAccountsManager({
      stateDir: tmpDir,
      credentialStore: fakeCredStore,
      getHostUserStatus: async () => ({ email: hostReportEmail })
    });
    const ov2 = mgr2.getOverviewState();
    assert.equal(ov2.autoSwitch.enabled, true);
    assert.equal(ov2.autoSwitch.poolKey, 'shared_gemini_main');
    assert.equal(ov2.autoSwitch.metricMode, 'remaining_pct');
    assert.equal(ov2.autoSwitch.windowKey, '5h');
    assert.equal(ov2.autoSwitch.thresholdPct, 22);
    assert.deepEqual(ov2.autoSwitch.candidates, ['b@example.com']);

    // 2. 手动切换取消重启：凭据回滚至 A，state 恢复 watching，lastError 清空
    const cancelRes = await mgr2.switchActiveAccount('b@example.com', {
      skipTokenRefresh: true,
      restartClient: async () => ({ cancelled: true })
    });
    assert.equal(cancelRes.cancelled, true);
    assert.equal(cancelRes.rolledBack, true);
    assert.equal(activeSysEmail, 'a@example.com');
    assert.equal(mgr2.getOverviewState().autoSwitchStatus.state, 'watching');
    assert.equal(mgr2.getOverviewState().autoSwitchStatus.lastError, null);

    // 3. 模拟自动切号发起重启但新进程超过 25s 仍回报原账号 A：安全回滚凭据并自动停用防循环
    const autoPendRes = await mgr2.switchActiveAccount('b@example.com', {
      trigger: 'auto_switch',
      skipTokenRefresh: true,
      restartClient: async () => ({ ok: true, supported: true })
    });
    assert.equal(autoPendRes.restartPending, true);
    const storePath = path.join(tmpDir, 'accounts_v1.json');
    const rawStore = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    rawStore.autoSwitchStatus.lastResult.pid = process.pid + 99999; // 模拟跨重启新进程
    rawStore.autoSwitchStatus.lastResult.atMs = Date.now() - 30000; // 超过 25s 启动宽限
    fs.writeFileSync(storePath, JSON.stringify(rawStore, null, 2));

    await mgr2.detectCurrentActiveAccount();
    const ovErr = mgr2.getOverviewState();
    assert.equal(activeSysEmail, 'a@example.com', '错账超时必须回滚系统凭据至原账号');
    assert.equal(ovErr.autoSwitch.enabled, false, '自动切号校验失败必须关闭防反复重启循环');
    assert.equal(ovErr.autoSwitchStatus.state, 'error');
    assert.equal(ovErr.autoSwitchStatus.lastResult.rolledBack, true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('v0.9.2 自动切号四项额度全矩阵、精确浮点阈值与旧规则迁移拦截', async () => {
  const tmpDir = makeTempDir('acm-4targets-');
  const credStore = makeMockCredStore();
  let activeHostEmail = 'a@example.com';
  const mgr = accountsMod.createAccountsManager({
    stateDir: tmpDir,
    credentialStore: credStore,
    getHostUserStatus: async () => ({ email: activeHostEmail }),
    restartLanguageServers: async () => ({ ok: true })
  });

  const makeSnap = ({ g5h = 0.80, g7d = 0.85, c5h = 0.75, c7d = 0.90 } = {}) => ({
    pools: [
      {
        poolKey: 'shared_gemini_main',
        buckets: [
          { windowKey: '5h', windowShort: '5h', remainingFraction: g5h },
          { windowKey: 'weekly', windowShort: '7d', remainingFraction: g7d }
        ]
      },
      {
        poolKey: 'shared_3p_pool',
        buckets: [
          { windowKey: '5h', windowShort: '5h', remainingFraction: c5h },
          { windowKey: 'weekly', windowShort: '7d', remainingFraction: c7d }
        ]
      }
    ]
  });

  try {
    const exp = new Date(Date.now() + 3600000).toISOString();
    mgr.addAccountWithCredential({ email: 'a@example.com', accessToken: 'tA', refreshToken: 'rA', expiresAt: exp });
    mgr.addAccountWithCredential({ email: 'b@example.com', accessToken: 'tB', refreshToken: 'rB', expiresAt: exp });
    await mgr.refreshAccountQuota('b@example.com', { mockQuotaSnapshot: makeSnap({ g5h: 0.95, g7d: 0.95, c5h: 0.95, c7d: 0.95 }), nowMs: 1000 });

    // 1. 精确浮点边界：显示取整为 10% 剩余 / 90% 已用（0.1004），绝不得提前触发；精确 0.10 必须触发
    const matrix = [
      { poolKey: 'shared_gemini_main', windowKey: '5h', field: 'g5h', otherField: 'g7d' },
      { poolKey: 'shared_gemini_main', windowKey: '7d', field: 'g7d', otherField: 'g5h' },
      { poolKey: 'shared_3p_pool', windowKey: '5h', field: 'c5h', otherField: 'c7d' },
      { poolKey: 'shared_3p_pool', windowKey: '7d', field: 'c7d', otherField: 'c5h' }
    ];
    let clock = 10000;
    for (const item of matrix) {
      for (const mode of ['remaining_pct', 'used_pct']) {
        const thresholdPct = mode === 'remaining_pct' ? 10 : 90;
        activeHostEmail = 'a@example.com';
        const cfgRes = mgr.updateAutoSwitchConfig({
          enabled: true,
          poolKey: item.poolKey,
          windowKey: item.windowKey,
          metricMode: mode,
          thresholdPct,
          debounceSec: 0,
          cooldownSec: 10,
          waitUntilIdle: true,
          candidates: ['b@example.com']
        });
        assert.equal(cfgRes.ok, true, `${item.poolKey}:${item.windowKey} (${mode}) 应允许保存`);
        clock += 20000;

        // 1A. 其他窗口跌破 1% 但所选窗口仍充足 -> 不触发
        const otherLow = await mgr.evaluateAutoSwitch({
          activeEmail: 'a@example.com',
          activeSnapshot: makeSnap({ [item.otherField]: 0.01, [item.field]: 0.50 }),
          syncState: 'fresh',
          skipCandidateRefresh: true,
          nowMs: clock
        });
        assert.equal(otherLow.action, 'ok_above_threshold', `${item.poolKey}:${item.windowKey} 监控下其他窗口先跌破不得触发`);

        // 1B. 0.1004 剩余（已用 89.96%，显示取整为 10% / 90%）-> 不得提前触发
        clock += 20000;
        const roundGuard = await mgr.evaluateAutoSwitch({
          activeEmail: 'a@example.com',
          activeSnapshot: makeSnap({ [item.field]: 0.1004 }),
          syncState: 'fresh',
          skipCandidateRefresh: true,
          nowMs: clock
        });
        assert.equal(roundGuard.action, 'ok_above_threshold', `${item.poolKey}:${item.windowKey} (${mode}) 0.1004 显示取整不得提前触发`);

        // 1C. 恰好 0.10 剩余（已用 90.0%）-> 必须触发切换至 B
        clock += 20000;
        await mgr.refreshAccountQuota('b@example.com', { mockQuotaSnapshot: makeSnap({ g5h: 0.95, g7d: 0.95, c5h: 0.95, c7d: 0.95 }), nowMs: clock });
        activeHostEmail = 'b@example.com';
        const exactHit = await mgr.evaluateAutoSwitch({
          activeEmail: 'a@example.com',
          activeSnapshot: makeSnap({ [item.field]: 0.10 }),
          syncState: 'fresh',
          skipCandidateRefresh: true,
          skipTokenRefresh: true,
          nowMs: clock
        });
        assert.equal(exactHit.ok, true);
        assert.equal(exactHit.action, 'switched', `${item.poolKey}:${item.windowKey} (${mode}) 恰好等于阈值必须触发`);
        assert.equal(exactHit.toEmail, 'b@example.com');
      }
    }

    // 2. 旧规则保留与迁移拦截：磁盘写入旧规则 shared_gemini_carbon + primary + enabled: true + candidates
    const storePath = path.join(tmpDir, 'accounts_v1.json');
    const rawStore = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    rawStore.autoSwitch = {
      ...rawStore.autoSwitch,
      enabled: true,
      poolKey: 'shared_gemini_carbon',
      windowKey: 'primary',
      candidates: ['b@example.com']
    };
    rawStore.autoSwitchStatus = { ...rawStore.autoSwitchStatus, state: 'watching', blockedReason: null };
    fs.writeFileSync(storePath, JSON.stringify(rawStore, null, 2));

    const legacyOv = mgr.getOverviewState();
    assert.equal(legacyOv.autoSwitch.poolKey, 'shared_gemini_carbon', '旧规则配置必须原样保留在磁盘');
    assert.deepEqual(legacyOv.autoSwitch.candidates, ['b@example.com'], '旧规则候选账号不得被清空');
    assert.equal(legacyOv.autoSwitchStatus.needsRuleMigration, true);
    assert.equal(legacyOv.autoSwitchStatus.state, 'blocked_legacy_rule', '旧规则绝不能显示为 watching');
    assert.equal(legacyOv.autoSwitchStatus.blockedReason, 'legacy_rule_needs_migration');

    const legacyEval = await mgr.evaluateAutoSwitch({
      activeEmail: 'a@example.com',
      activeSnapshot: makeSnap({ g5h: 0.01 }),
      syncState: 'fresh',
      nowMs: clock + 50000
    });
    assert.equal(legacyEval.action, 'blocked');
    assert.equal(legacyEval.state, 'blocked_legacy_rule');
    assert.equal(legacyEval.reason, 'legacy_rule_needs_migration');

    // 尝试不改目标直接启用 -> 拒绝且保留候选账号
    const rejectEnable = mgr.updateAutoSwitchConfig({ enabled: true });
    assert.equal(rejectEnable.ok, false);
    assert.equal(rejectEnable.reason, 'legacy_rule_needs_migration');
    assert.deepEqual(rejectEnable.autoSwitch.candidates, ['b@example.com']);

    // 重选合法四项之一后保存 -> 恢复 watching 且保留原候选账号
    const migrated = mgr.updateAutoSwitchConfig({ enabled: true, poolKey: 'shared_3p_pool', windowKey: '7d' });
    assert.equal(migrated.ok, true);
    assert.equal(migrated.autoSwitchStatus.state, 'watching');
    assert.equal(migrated.autoSwitchStatus.needsRuleMigration, false);
    assert.deepEqual(migrated.autoSwitch.candidates, ['b@example.com']);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Accounts & Quota 底层抓数重构: Daily->Sandbox 严禁回退 Prod、Argon 独立池、3P 隔离、套餐规范化、Tools 本地配额导入与三语零括号', async () => {
  const {
    fetchAccountQuotaViaCloudCode,
    normalizeSubscriptionTierInfo,
    createAccountsManager
  } = require('./meter-accounts');

  // 1. 套餐层级规范化（消除 g1-pro-tier / free-tier 裸露）
  assert.deepEqual(normalizeSubscriptionTierInfo('g1-ultra-tier'), { tierCode: 'ULTRA', tierName: 'Google AI Ultra', rawTier: 'g1-ultra-tier' });
  assert.deepEqual(normalizeSubscriptionTierInfo('g1-pro-tier'), { tierCode: 'PRO', tierName: 'Google AI Pro', rawTier: 'g1-pro-tier' });
  assert.deepEqual(normalizeSubscriptionTierInfo('free-tier'), { tierCode: 'FREE', tierName: 'Free', rawTier: 'free-tier' });

  const makeResp = (status, bodyObj) => ({
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(bodyObj),
    json: async () => bodyObj
  });

  // 2. Daily 失败 -> 回退 Sandbox（严禁触碰 Prod）+ agentModelSorts 对象数组解析 + Argon 独立池 + resetTime 同步输出
  const requestedUrls = [];
  const res = await fetchAccountQuotaViaCloudCode('test-access-token', {
    fetch: async (url) => {
      requestedUrls.push(String(url));
      if (String(url).includes('loadCodeAssist')) {
        return makeResp(200, {
          cloudaicompanionProject: 'proj-test-1',
          paidTier: { id: 'g1-pro-tier' }
        });
      }
      if (String(url).includes('daily-cloudcode-pa.googleapis.com')) {
        return makeResp(503, { error: { message: 'daily unavailable' } });
      }
      if (String(url).includes('daily-cloudcode-pa.sandbox.googleapis.com') && String(url).includes('fetchAvailableModels')) {
        return makeResp(200, {
          agentModelSorts: [
            { groups: [{ modelIds: ['MODEL_PLACEHOLDER_M37', 'MODEL_CLAUDE_5_5_SONNET', 'MODEL_GEMINI_4_ARGON'] }] }
          ],
          models: {
            MODEL_PLACEHOLDER_M37: {
              displayName: 'Gemini 4 Pro',
              model: 'MODEL_PLACEHOLDER_M37',
              quotaInfo: { remainingFraction: 0.78, resetTime: '2026-11-28T06:00:00Z' }
            },
            MODEL_CLAUDE_5_5_SONNET: {
              displayName: 'Claude 5.5 Sonnet',
              model: 'MODEL_CLAUDE_5_5_SONNET',
              quotaInfo: { remainingFraction: 0.55, resetTime: '2026-11-28T07:30:00Z' }
            },
            MODEL_GEMINI_4_ARGON: {
              displayName: 'Gemini 4 Argon',
              model: 'MODEL_GEMINI_4_ARGON',
              quotaInfo: { remainingFraction: 0.90, resetTime: '2026-12-03T00:00:00Z' }
            }
          }
        });
      }
      if (String(url).includes('daily-cloudcode-pa.sandbox.googleapis.com') && String(url).includes('retrieveUserQuotaSummary')) {
        return makeResp(200, {
          groups: [
            {
              displayName: 'Gemini',
              buckets: [
                { bucketId: 'gemini_5h', remainingFraction: 0.78, resetTime: '2026-11-28T06:00:00Z', windowDurationSeconds: 18000 },
                { bucketId: 'gemini_7d', remainingFraction: 0.66, resetTime: '2026-12-02T00:00:00Z', windowDurationSeconds: 604800 }
              ]
            },
            {
              displayName: 'Claude / GPT',
              buckets: [
                { bucketId: 'claude_5h', remainingFraction: 0.55, resetTime: '2026-11-28T07:30:00Z', windowDurationSeconds: 18000 },
                { bucketId: 'claude_7d', remainingFraction: 0.42, resetTime: '2026-12-01T00:00:00Z', windowDurationSeconds: 604800 }
              ]
            },
            {
              displayName: 'Gemini 4 Argon',
              buckets: [
                { bucketId: 'gemini_argon_7d', remainingFraction: 0.90, resetTime: '2026-12-03T00:00:00Z', windowDurationSeconds: 604800 }
              ]
            }
          ]
        });
      }
      return makeResp(404, {});
    }
  });

  assert.ok(res && res.snapshot, '必须返回有效 snapshot');
  assert.equal(res.tierCode, 'PRO');
  assert.equal(res.tierName, 'Google AI Pro');
  assert.equal(requestedUrls.some((u) => /^https:\/\/cloudcode-pa\.googleapis\.com\//.test(u) && (u.includes('fetchAvailableModels') || u.includes('retrieveUserQuotaSummary'))), false, '严禁将配额拉取回退至 Prod 端点');
  const poolKeys = (res.snapshot?.pools || []).map((p) => p.poolKey);
  assert.ok(poolKeys.includes('shared_gemini_main'), '必须解析出 Gemini 主池');
  assert.ok(poolKeys.includes('shared_3p_pool'), '必须解析出 Claude / GPT 池');
  assert.ok(poolKeys.includes('shared_gemini_argon'), '必须保留 Gemini 4 Argon 独立高阶池');
  const gPool = res.snapshot.pools.find((p) => p.poolKey === 'shared_gemini_main');
  assert.equal(gPool.buckets[0].resetTime, '2026-11-28T06:00:00Z', 'bucket 必须同时输出 resetTime 与 resetTimeIso');
  assert.equal(gPool.buckets[0].resetTimeIso, '2026-11-28T06:00:00Z');

  // 3. 3P 隔离：当模型池不含 Claude/GPT 时，不得保留虚假 3P 组
  const resNo3p = await fetchAccountQuotaViaCloudCode('test-no-3p', {
    fetch: async (url) => {
      if (String(url).includes('loadCodeAssist')) {
        return makeResp(200, { cloudaicompanionProject: 'proj-free', currentTier: { id: 'free-tier' } });
      }
      if (String(url).includes('fetchAvailableModels')) {
        return makeResp(200, {
          models: {
            MODEL_PLACEHOLDER_M37: { displayName: 'Gemini 4 Pro', quotaInfo: { remainingFraction: 0.4, resetTime: '2026-11-28T05:00:00Z' } }
          }
        });
      }
      if (String(url).includes('retrieveUserQuotaSummary')) {
        return makeResp(200, {
          groups: [
            { displayName: 'Gemini', buckets: [{ bucketId: 'gemini_5h', remainingFraction: 0.4, resetTime: '2026-11-28T05:00:00Z', windowDurationSeconds: 18000 }] },
            { displayName: 'Claude / GPT', buckets: [{ bucketId: 'claude_5h', remainingFraction: 1.0, windowDurationSeconds: 18000 }] }
          ]
        });
      }
      return makeResp(404, {});
    }
  });
  assert.ok(resNo3p && resNo3p.snapshot);
  assert.equal(resNo3p.tierCode, 'FREE');
  assert.equal((resNo3p.snapshot?.pools || []).some((p) => p.poolKey === 'shared_3p_pool'), false, '无 3P 模型权限时必须隔离虚假 3P 组');

  // 4. importFromAntigravityTools 完整导入 Tools 本地 quota_groups、subscription_tier 与 last_used
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-tools-import-'));
  const toolsDir = path.join(tmpDir, '.antigravity_tools');
  const toolsAccountsDir = path.join(toolsDir, 'accounts');
  fs.mkdirSync(toolsAccountsDir, { recursive: true });
  fs.writeFileSync(path.join(toolsDir, 'accounts.json'), JSON.stringify({
    accounts: [{ id: 't1', email: 'tools.user@gmail.com', name: 'Tools User', last_used: 1764200000 }]
  }));
  fs.writeFileSync(path.join(toolsAccountsDir, 't1.json'), JSON.stringify({
    id: 't1',
    email: 'tools.user@gmail.com',
    name: 'Tools User',
    last_used: 1764200000,
    token: { refresh_token: '1//tools-refresh-token', access_token: 'ya29.tools' },
    quota: {
      subscription_tier: 'g1-ultra-tier',
      last_updated: 1764200500,
      quota_groups: [
        {
          display_name: 'Gemini',
          buckets: [
            { bucket_id: 'g5h', window: '5h', remaining_fraction: 0.82, reset_time: '2026-11-28T09:00:00Z' },
            { bucket_id: 'g7d', window: 'weekly', remaining_fraction: 0.74, reset_time: '2026-12-03T09:00:00Z' }
          ]
        },
        {
          display_name: 'Claude / GPT',
          buckets: [
            { bucket_id: 'c5h', window: '5h', remaining_fraction: 0.61, reset_time: '2026-11-28T10:00:00Z' },
            { bucket_id: 'c7d', window: 'weekly', remaining_fraction: 0.50, reset_time: '2026-12-02T10:00:00Z' }
          ]
        },
        {
          display_name: 'Gemini 4 Argon',
          buckets: [
            { bucket_id: 'a7d', window: 'weekly', remaining_fraction: 0.95, reset_time: '2026-12-04T00:00:00Z' }
          ]
        }
      ]
    }
  }));

  try {
    const mgr = createAccountsManager({
      stateDir: path.join(tmpDir, 'store'),
      homeDir: tmpDir
    });
    const imp = mgr.importFromAntigravityTools();
    assert.equal(imp.ok, true);
    assert.equal(imp.credentialsImported, true, 'Tools 导入必须恢复真实 OAuth 凭据导入');
    assert.equal(imp.importedCount, 1);
    const ov = mgr.getOverviewState();
    const acc = ov.accounts.find((a) => a.email === 'tools.user@gmail.com');
    assert.ok(acc);
    assert.equal(acc.hasRefreshToken, true, 'Tools 导入账号必须保留可刷新/可切换的 refreshToken 凭据');
    assert.equal(acc.tierCode, 'ULTRA');
    assert.equal(acc.tierName, 'Google AI Ultra');
    assert.equal(acc.lastUsedAtMs, 1764200000 * 1000);
    assert.ok(acc.quotaSnapshot && acc.quotaSnapshot.pools.length === 3, '导入 Tools 账号必须同步保留 3 个本地配额池');
    assert.equal(acc.quotaSnapshot.pools[0].buckets[0].remainingFraction, 0.82);
    assert.equal(acc.quotaSnapshot.pools[0].buckets[1].remainingFraction, 0.74);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // 5. 新增 21 条三语文案严格零中英文括号
  const i18nSrc = fs.readFileSync(path.join(__dirname, 'src/renderer/i18n.js'), 'utf8');
  const i18nVm = require('node:vm');
  const i18nCtx = {};
  i18nVm.runInNewContext(i18nSrc + '\n;this.__dict = typeof PANEL_I18N !== "undefined" ? PANEL_I18N : null;', i18nCtx);
  const i18nDict = i18nCtx.__dict;
  assert.ok(i18nDict && typeof i18nDict === 'object', '必须加载完整三语词典');
  const newKeys = [
    'accountsPage.btnImportTools',
    'accountsPage.poolGemini5h',
    'accountsPage.poolGeminiWeekly',
    'accountsPage.poolClaude5h',
    'accountsPage.poolClaudeWeekly',
    'accountsPage.poolArgonWeekly',
    'accountsPage.poolCarbonWeekly',
    'accountsPage.weeklyShort',
    'accountsPage.refreshing',
    'accountsPage.refreshDone',
    'accountsPage.confirmSwitchBody',
    'accountsPage.confirmRemoveBody',
    'accountsPage.confirmRemoveActiveBody',
    'accountsPage.confirmRemoveBtn',
    'accountsPage.confirmSwitchBtn',
    'accountsPage.cancelBtn',
    'accountsPage.revealEmailHint',
    'accountsPage.noRefreshCredHint',
    'sidebarAccount.refreshActive',
    'sidebarAccount.refreshing',
    'sidebarAccount.refreshDone'
  ];
  for (const k of newKeys) {
    const entry = i18nDict[k];
    assert.ok(entry && typeof entry === 'object', `新增词条 ${k} 必须存在于 PANEL_I18N`);
    for (const lang of ['zh-CN', 'zh-TW', 'en']) {
      const val = entry[lang];
      assert.equal(typeof val, 'string', `新增词条 ${k} 在 ${lang} 中必须存在`);
      assert.ok(val.length > 0, `新增词条 ${k} 在 ${lang} 中不得为空`);
      assert.doesNotMatch(val, /[（）()]/, `新增词条 ${k} (${lang}) 不得包含任何中英文括号: ${val}`);
    }
  }
});

test('回归 #1 + PR #96 + Issue #128 + ELV-102: 真实切号/OAuth取消/Cockpit Tools全格式导入/非活跃账号CloudCode刷新与IPC去拦截', async (t) => {
  const crypto = require('crypto');
  const tmpDir = makeTempDir();
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  // 1. 验证 meter-main.js 与 live-host.js 彻底移除崩溃与合规阉割拦截
  const mainSrc = fs.readFileSync(path.join(__dirname, 'meter-main.js'), 'utf8');
  const liveHostSrc = fs.readFileSync(path.join(__dirname, 'live-host.js'), 'utf8');
  assert.match(mainSrc, /collector\.fetchQuotaSnapshotFromHost\(/, 'meter-main.js 必须通过 collector.fetchQuotaSnapshotFromHost 调用，消除 ReferenceError');
  assert.doesNotMatch(mainSrc, /fetchActiveHostSnapshot:\s*async\s*\([^)]*\)\s*=>\s*fetchQuotaSnapshotFromHost\(/, 'meter-main.js 不得裸调用未导入的 fetchQuotaSnapshotFromHost');
  for (const forbidden of ['productionOfficialHostOnly: true', 'allowCredentialWrite: false', 'allowPluginOAuth: false', 'allowCrossToolImport: false', 'hostOnlyBoundary: true']) {
    assert.equal(mainSrc.includes(forbidden), false, `meter-main.js 不得残留拦截项: ${forbidden}`);
    assert.equal(liveHostSrc.includes(forbidden), false, `live-host.js 不得残留拦截项: ${forbidden}`);
  }
  assert.equal(mainSrc.includes('const productionAlertOnly = options?.allowDispatchForOfflineTest !== true'), false, 'meter-main.js 不得残留 productionAlertOnly 拦截');
  assert.equal(liveHostSrc.includes('productionAlertOnly: request?.allowDispatchForOfflineTest !== true'), false, 'live-host.js 不得残留 productionAlertOnly 拦截');

  // 2. PR #96: 手动切号在 LS 验证超时后保留凭据并返回 pendingRestart: true（不回滚）
  const credStore = makeMockCredStore();
  const futureExp = new Date(Date.now() + 3600000).toISOString();
  const mgr = accountsMod.createAccountsManager({
    stateDir: path.join(tmpDir, 'state-pr96'),
    homeDir: tmpDir,
    ignoreEnvToolsDir: true,
    credentialStore: credStore,
    getHostUserStatus: async () => ({ email: 'alpha@example.com' }),
    restartLanguageServers: async () => ({ ok: true })
  });
  mgr.addAccountWithCredential({ email: 'alpha@example.com', accessToken: 'tA', refreshToken: 'rA', expiresAt: futureExp });
  mgr.addAccountWithCredential({ email: 'beta@example.com', accessToken: 'tB', refreshToken: 'rB', expiresAt: futureExp });
  const swRes = await accountsMod.dispatchAccountsAction(mgr, {
    action: 'switch',
    email: 'beta@example.com',
    verifyTimeoutMs: 40
  }, { allowManualRestartPending: true });
  assert.equal(swRes.officialManualSwitchRequired, undefined, 'dispatchAccountsAction switch 不得再被 official_host_switch_required 拦截');
  assert.equal(swRes.verifiedEffective, false);
  assert.equal(swRes.rolledBack, false, 'PR #96 手动切号验证超时应保留已写入凭据不回滚');
  assert.equal(swRes.pendingRestart, true, 'PR #96 必须返回 pendingRestart: true');
  assert.equal(credStore.getApplied()?.email, 'beta@example.com', '系统凭据应保持为目标账号 beta@example.com');

  // 3. 非活跃账号手动刷新：彻底撤销 cloudcode_direct_disabled，真实拉取 Gemini/Claude/Argon 多池余量
  const mockCloudFetch = async (url) => {
    const u = String(url || '');
    const makeResp = (status, body) => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body)
    });
    if (u.includes('loadCodeAssist')) {
      return makeResp(200, { cloudaicompanionProject: 'proj-beta', currentTier: { id: 'g1-ultra-tier', name: 'Google AI Ultra' } });
    }
    if (u.includes('fetchAvailableModels')) {
      return makeResp(200, {
        models: {
          'gemini-3-pro-high': {
            displayName: 'Gemini 3 Pro (High)',
            quotaInfo: { remainingFraction: 0.84, resetTime: '2026-11-28T05:00:00Z' }
          },
          'claude-sonnet-4-5': {
            displayName: 'Claude Sonnet 4.5',
            quotaInfo: { remainingFraction: 0.62, resetTime: '2026-11-28T06:00:00Z' }
          },
          'gemini-4-argon': {
            displayName: 'Gemini 4 Argon',
            quotaInfo: { remainingFraction: 0.91, resetTime: '2026-12-03T00:00:00Z' }
          }
        }
      });
    }
    return makeResp(404, {});
  };
  const mgrRefresh = accountsMod.createAccountsManager({
    stateDir: path.join(tmpDir, 'state-refresh'),
    homeDir: tmpDir,
    ignoreEnvToolsDir: true,
    fetch: mockCloudFetch
  });
  mgrRefresh.addAccountWithCredential({ email: 'active@example.com', accessToken: 't1', refreshToken: 'r1', expiresAt: futureExp });
  mgrRefresh.addAccountWithCredential({ email: 'inactive@example.com', accessToken: 't2', refreshToken: 'r2', expiresAt: futureExp });
  const stRef = mgrRefresh.loadStore();
  stRef.activeAccountEmail = 'active@example.com';
  mgrRefresh.saveStore(stRef);

  const inactiveRef = await accountsMod.dispatchAccountsAction(mgrRefresh, {
    action: 'refresh_quota',
    email: 'inactive@example.com'
  });
  assert.equal(inactiveRef.ok, true, '非活跃账号手动刷新必须成功，不得再返回 cloudcode_direct_disabled');
  assert.notEqual(inactiveRef.reason, 'cloudcode_direct_disabled');
  const poolKeys = (inactiveRef.account?.quotaSnapshot?.pools || []).map((p) => p.poolKey);
  assert.ok(poolKeys.includes('shared_gemini_main'), '非活跃账号刷新必须返回 Gemini 池');
  assert.ok(poolKeys.includes('shared_3p_pool'), '非活跃账号刷新必须返回 Claude/GPT 池');
  assert.ok(poolKeys.includes('shared_gemini_argon'), '非活跃账号刷新必须返回 Argon 高阶池');

  // 4. Issue #128: Cockpit Tools 全格式兼容（SQLite + JSON 索引、明文 / token_encrypted / 整文件 AES-256-GCM 信封 + 导出备份 JSON + 缺密钥优雅降级）
  const cockpitHome = path.join(tmpDir, 'cockpit-home');
  const cockpitRoot = path.join(cockpitHome, '.cockpit_tools');
  const cockpitAcctsDir = path.join(cockpitRoot, 'accounts');
  fs.mkdirSync(cockpitAcctsDir, { recursive: true });

  const encGcm = (keyBuf, obj) => {
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', keyBuf, nonce);
    const enc = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return { nonce: nonce.toString('base64'), ciphertext: Buffer.concat([enc, tag]).toString('base64') };
  };

  const storageKey = crypto.randomBytes(32);
  const tokenKey = crypto.randomBytes(32);
  fs.writeFileSync(path.join(cockpitRoot, 'secure-account-storage.key'), storageKey.toString('base64'), 'utf8');
  fs.writeFileSync(path.join(cockpitRoot, 'account-token.key'), tokenKey.toString('base64'), 'utf8');

  // 格式 1: 明文 JSON
  fs.writeFileSync(path.join(cockpitAcctsDir, 'antigravity_0001.json'), JSON.stringify({
    id: 'antigravity_0001',
    email: 'plain@cockpit.test',
    name: 'Plain User',
    token: { refresh_token: '1//rt-plain', access_token: 'ya29.plain', expiry_timestamp: 1790000000 }
  }));
  // 格式 2: 字段级 token_encrypted
  const tokEnc = encGcm(tokenKey, { refresh_token: '1//rt-field', access_token: 'ya29.field', oauth_client_key: 'antigravity_default' });
  fs.writeFileSync(path.join(cockpitAcctsDir, 'antigravity_0002.json'), JSON.stringify({
    id: 'antigravity_0002',
    email: 'field@cockpit.test',
    name: 'Field Enc User',
    token_encrypted: { version: 1, nonce: tokEnc.nonce, ciphertext: tokEnc.ciphertext }
  }));
  // 格式 3: 整文件加密信封
  const envEnc = encGcm(storageKey, {
    id: 'antigravity_0003',
    email: 'env@cockpit.test',
    name: 'Envelope User',
    token: { refresh_token: '1//rt-env', access_token: 'ya29.env', expiry_timestamp: 1790000500 }
  });
  fs.writeFileSync(path.join(cockpitAcctsDir, 'antigravity_0003.json'), JSON.stringify({
    version: 1,
    kind: 'antigravity',
    algorithm: 'AES-256-GCM',
    key_id: 'local-secure-account-storage-v1',
    nonce: envEnc.nonce,
    ciphertext: envEnc.ciphertext,
    encrypted_at: 1764200000
  }));
  // 格式 4: 未知版本加密信封（必须优雅降级不影响其余账号导入）
  fs.writeFileSync(path.join(cockpitAcctsDir, 'antigravity_badv.json'), JSON.stringify({
    version: 99,
    kind: 'antigravity',
    algorithm: 'AES-256-GCM',
    nonce: envEnc.nonce,
    ciphertext: envEnc.ciphertext
  }));

  fs.writeFileSync(path.join(cockpitRoot, 'accounts.json'), JSON.stringify({
    version: 1,
    accounts: [
      { id: 'antigravity_0001', email: 'plain@cockpit.test', name: 'Plain User' },
      { id: 'antigravity_0002', email: 'field@cockpit.test', name: 'Field Enc User' },
      { id: 'antigravity_0003', email: 'env@cockpit.test', name: 'Envelope User' },
      { id: 'antigravity_badv', email: 'badv@cockpit.test', name: 'Bad Version User' }
    ]
  }));

  const mgrCockpit = accountsMod.createAccountsManager({
    stateDir: path.join(tmpDir, 'state-cockpit'),
    homeDir: cockpitHome,
    ignoreEnvToolsDir: true
  });
  const preview = await accountsMod.dispatchAccountsAction(mgrCockpit, { action: 'preview_tools' });
  assert.equal(preview.ok, true);
  assert.equal(preview.available, true);
  assert.equal(preview.count, 4, '应预览到 Cockpit Tools 全部 4 条账号索引');

  const impCockpit = await accountsMod.dispatchAccountsAction(mgrCockpit, { action: 'import_tools' });
  assert.equal(impCockpit.ok, true);
  assert.equal(impCockpit.credentialsImported, true);
  assert.equal(impCockpit.credentialsImportedCount, 3, '明文、字段加密与整文件信封 3 个账号应全部解出真实凭据');
  assert.ok(Array.isArray(impCockpit.warnings) && impCockpit.warnings.length >= 1, '未知加密版本应产出可读降级告警');
  const ovCockpit = mgrCockpit.getOverviewState();
  for (const em of ['plain@cockpit.test', 'field@cockpit.test', 'env@cockpit.test']) {
    const rec = ovCockpit.accounts.find((a) => a.email === em);
    assert.ok(rec && rec.hasRefreshToken === true, `Cockpit Tools 账号 ${em} 必须具备真实 refreshToken`);
  }

  // Cockpit Tools 备份导出 JSON (schema: cockpit-tools.data-transfer)
  const backupRes = await accountsMod.dispatchAccountsAction(mgrCockpit, {
    action: 'import_cockpit_backup',
    data: {
      schema: 'cockpit-tools.data-transfer',
      version: 1,
      accounts: {
        platforms: {
          antigravity: {
            exported_data: [{ email: 'backup@cockpit.test', refresh_token: '1//rt-backup' }]
          }
        }
      }
    }
  });
  assert.equal(backupRes.ok, true);
  assert.equal(backupRes.importedCount, 1);
  assert.equal(mgrCockpit.getOverviewState().accounts.find((a) => a.email === 'backup@cockpit.test')?.hasRefreshToken, true);

  // 5. ELV-102: OAuth 登录启动与取消闭环（无 plugin_oauth_disabled 拦截）
  let openedAuthUrl = '';
  let resolveOpened = null;
  const openedPromise = new Promise((resolve) => { resolveOpened = resolve; });
  const oauthMgr = accountsMod.createAccountsManager({
    stateDir: path.join(tmpDir, 'state-oauth'),
    homeDir: tmpDir,
    ignoreEnvToolsDir: true,
    oauthClientId: 'test-client-123.apps.googleusercontent.com',
    oauthClientSecret: 'GOCSPX-test-secret-123',
    openExternal: (u) => { openedAuthUrl = u; resolveOpened?.(u); }
  });
  const loginPromise = accountsMod.dispatchAccountsAction(oauthMgr, { action: 'oauth_login', timeoutMs: 5000 });
  await Promise.race([openedPromise, new Promise((r) => setTimeout(r, 2000))]);
  assert.ok(openedAuthUrl.startsWith('https://accounts.google.com/o/oauth2/auth?'), 'OAuth 登录必须生成并拉起授权 URL');
  const cancelRes = await accountsMod.dispatchAccountsAction(oauthMgr, { action: 'oauth_cancel' });
  assert.equal(cancelRes.ok, true);
  assert.equal(cancelRes.cancelled, true);
  const loginRes = await loginPromise;
  assert.equal(loginRes.cancelled, true, '取消 OAuth 后必须返回 cancelled: true 而非挂死超时');

  // 6. 校验 meter-main.js accounts-action IPC 已显式引入 collector 且无退化拦截项
  const mainIpcSrc = fs.readFileSync(path.join(__dirname, 'meter-main.js'), 'utf8');
  const actStart = mainIpcSrc.indexOf("ipcMain.handle('context-meter:accounts-action'");
  const actEnd = mainIpcSrc.indexOf("ipcMain.handle('context-meter:sync-pricing'", actStart);
  assert.ok(actStart > 0 && actEnd > actStart, '必须定位到 context-meter:accounts-action IPC 处理段');
  const actBlock = mainIpcSrc.slice(actStart, actEnd);
  assert.match(actBlock, /const\s+collector\s*=\s*require\('\.\/meter-collector'\)/, 'accounts-action 必须引入 collector，防止 collector/fetchQuotaSnapshotFromHost is not defined 崩溃');
  assert.match(actBlock, /collector\.fetchQuotaSnapshotFromHost\(/, 'accounts-action 必须通过 collector.fetchQuotaSnapshotFromHost 拉取宿主快照');
  assert.doesNotMatch(actBlock, /productionOfficialHostOnly|allowCredentialWrite:\s*false|allowPluginOAuth:\s*false|allowCrossToolImport:\s*false|hostOnlyBoundary:\s*true/, 'accounts-action 不得残留退化拦截标记');
  assert.doesNotMatch(actBlock, /showMessageBox/, '切号 IPC 不得弹原生白框 dialog.showMessageBox');
});

test('非活跃账号行内刷新闭环: 精准定向更新、明确数据来源与采集时间、失败保留旧快照并呈现真实原因与更新时间', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-inactive-inline-refresh-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const fetchedTokens = [];
  let failNext = false;
  const mockFetch = async (url, init = {}) => {
    const u = String(url);
    const authHeader = String(init?.headers?.Authorization || init?.headers?.authorization || '');
    fetchedTokens.push({ url: u, authHeader });
    if (failNext) {
      return {
        ok: false,
        status: 503,
        text: async () => 'service unavailable',
        json: async () => ({ error: { message: 'service unavailable' } })
      };
    }
    if (u.includes('loadCodeAssist')) {
      const body = {
        cloudaicompanionProject: 'proj-b-123',
        paidTier: { id: 'g1-pro-tier', name: 'Pro' }
      };
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(body),
        json: async () => body
      };
    }
    if (u.includes('fetchAvailableModels')) {
      const body = {
        agentModelSorts: [{ groups: [{ modelIds: ['gemini-3.1-pro', 'claude-sonnet-4-5'] }] }],
        models: {
          'gemini-3.1-pro': {
            displayName: 'Gemini 3.1 Pro',
            quotaInfo: { remainingFraction: 0.84, resetTime: '2026-11-28T05:00:00Z' }
          },
          'claude-sonnet-4-5': {
            displayName: 'Claude Sonnet 4.5',
            quotaInfo: { remainingFraction: 0.62, resetTime: '2026-11-28T06:00:00Z' }
          }
        }
      };
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(body),
        json: async () => body
      };
    }
    return { ok: false, status: 404, text: async () => 'not found', json: async () => ({}) };
  };

  const nowFutureIso = new Date(Date.now() + 3600 * 1000).toISOString();
  const seedStore = {
    version: 1,
    activeAccountEmail: 'active@example.com',
    accounts: {
      'active@example.com': {
        email: 'active@example.com',
        name: 'Active',
        source: 'oauth',
        credential: { accessToken: 'tok-active', refreshToken: 'rt-active', expiresAt: nowFutureIso },
        quotaSnapshot: { pools: [{ poolKey: 'gemini', remainingFraction: 0.91 }] },
        quotaSource: 'host_local_snapshot',
        lastQuotaUpdatedAtMs: 1700000001000
      },
      'b@example.com': {
        email: 'b@example.com',
        name: 'InactiveB',
        source: 'oauth',
        credential: { accessToken: 'tok-b', refreshToken: 'rt-b', expiresAt: nowFutureIso },
        quotaSnapshot: { pools: [{ poolKey: 'gemini', remainingFraction: 0.50 }] },
        lastQuotaUpdatedAtMs: 1700000002000
      },
      'c@example.com': {
        email: 'c@example.com',
        name: 'InactiveC',
        source: 'oauth',
        credential: { accessToken: 'tok-c', refreshToken: 'rt-c', expiresAt: nowFutureIso },
        quotaSnapshot: { pools: [{ poolKey: 'gemini', remainingFraction: 0.30 }] },
        lastQuotaUpdatedAtMs: 1700000003000
      }
    }
  };
  fs.writeFileSync(path.join(tmpDir, 'accounts_v1.json'), JSON.stringify(seedStore, null, 2), 'utf8');

  let hostFetchCalls = 0;
  const mgr = accountsMod.createAccountsManager({
    stateDir: tmpDir,
    fetch: mockFetch,
    fetchActiveHostSnapshot: async () => {
      hostFetchCalls += 1;
      return { ok: true, snapshot: { pools: [] } };
    }
  });

  // 1. 点非活跃账号 b@example.com 行内刷新：仅查 b，不查 active/c，不走宿主快照，返回明确来源和采集时间
  const okRes = await accountsMod.dispatchAccountsAction(
    mgr,
    { action: 'refresh_quota', email: 'b@example.com', force: true },
    {}
  );
  assert.equal(okRes.ok, true, `非活跃账号行内刷新应成功: ${okRes.error || ''}`);
  assert.equal(hostFetchCalls, 0, '非活跃账号行内刷新不得误调活跃宿主快照');
  assert.equal(fetchedTokens.length > 0, true);
  assert.equal(fetchedTokens.every((item) => item.authHeader === 'Bearer tok-b'), true, '仅应使用目标非活跃账号 b 的凭据发起查询');
  assert.equal(okRes.source, 'cloudcode_direct', '应返回明确数据来源 cloudcode_direct');
  assert.equal(okRes.targetHost, 'daily-cloudcode-pa.googleapis.com', '应返回实际命中的 CloudCode 主机来源');
  assert.equal(typeof okRes.fetchedAtMs, 'number', '应返回数值型采集时间 fetchedAtMs');
  assert.equal(okRes.fetchedAtMs, okRes.lastSuccessAtMs);
  assert.equal(okRes.account.quotaSource, 'cloudcode_direct');
  assert.equal(okRes.account.quotaTargetHost, 'daily-cloudcode-pa.googleapis.com');
  assert.equal(okRes.account.lastQuotaUpdatedAtMs, okRes.fetchedAtMs);

  const ovAfterOk = okRes.overview;
  const accA = ovAfterOk.accounts.find((a) => a.email === 'active@example.com');
  const accB = ovAfterOk.accounts.find((a) => a.email === 'b@example.com');
  const accC = ovAfterOk.accounts.find((a) => a.email === 'c@example.com');
  assert.equal(accA.lastQuotaUpdatedAtMs, 1700000001000, '活跃账号快照时间不应被误改');
  assert.equal(accC.lastQuotaUpdatedAtMs, 1700000003000, '另一非活跃账号 c 不应被误刷');
  assert.ok(Array.isArray(accB.quotaSnapshot?.pools) && accB.quotaSnapshot.pools.length >= 2, '目标账号 b 应更新多池配额');
  const savedSnapBeforeFail = JSON.stringify(accB.quotaSnapshot);
  const savedAtBeforeFail = accB.lastQuotaUpdatedAtMs;

  // 2. 再次点 b@example.com 行内刷新，模拟 HTTP 503 失败：返回真实原因、保留已有快照与原更新时间
  failNext = true;
  const failRes = await accountsMod.dispatchAccountsAction(
    mgr,
    { action: 'refresh_quota', email: 'b@example.com', force: true },
    {}
  );
  assert.equal(failRes.ok, false);
  assert.match(String(failRes.error || ''), /503/, '失败应暴露真实 HTTP 503 原因');
  assert.equal(failRes.lastSuccessAtMs, savedAtBeforeFail, '失败时 lastSuccessAtMs 必须保持原成功时间');
  assert.equal(failRes.account.lastQuotaUpdatedAtMs, savedAtBeforeFail, '失败时账号更新时间必须保持原成功时间');
  assert.equal(JSON.stringify(failRes.account.quotaSnapshot), savedSnapBeforeFail, '失败时必须完整保留已有快照');
  assert.match(String(failRes.account.lastQuotaError || ''), /503/, '账号记录必须持久化真实失败原因');

  // 3. 核对前端账号页在已有旧快照 + 刷新失败时仍保留配额条并显示真实原因与原更新时间
  const settingsUiSrc = fs.readFileSync(path.join(__dirname, 'src', 'renderer', 'context-settings-ui.js'), 'utf8');
  assert.match(settingsUiSrc, /data-ac-stale-error/, '已有旧快照且刷新失败时必须渲染行内失败原因与更新时间提示条');
});

test('双入口单击真实切号闭环: 零二次确认、deferRestart 自动单次接续 restartHost、失败回滚保留当前账号并显示真实原因', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-direct-switch-chain-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const credStore = makeMockCredStore();
  const nowFutureIso = new Date(Date.now() + 3600 * 1000).toISOString();
  const seedStore = {
    version: 1,
    activeAccountEmail: 'a@example.com',
    accounts: {
      'a@example.com': {
        email: 'a@example.com',
        name: 'AcctA',
        source: 'oauth',
        credential: { accessToken: 'tok-a', refreshToken: 'rt-a', expiresAt: nowFutureIso }
      },
      'b@example.com': {
        email: 'b@example.com',
        name: 'AcctB',
        source: 'oauth',
        credential: { accessToken: 'tok-b', refreshToken: 'rt-b', expiresAt: nowFutureIso }
      }
    }
  };
  fs.writeFileSync(path.join(tmpDir, 'accounts_v1.json'), JSON.stringify(seedStore, null, 2), 'utf8');

  const mgr = accountsMod.createAccountsManager({ stateDir: tmpDir, credentialStore: credStore });

  // 1. 失败场景：写入凭据报错 -> 回滚保留当前账号 a@example.com，暴露真实错误，不返回 restartPending
  credStore.setFailWrite(true);
  const failRes = await accountsMod.dispatchAccountsAction(
    mgr,
    { action: 'switch', email: 'b@example.com', deferRestart: true },
    {
      restartClient: undefined,
      requiresClientRestart: true,
      canAutoRestart: true,
      deferRestart: true,
      allowManualRestartPending: true
    }
  );
  assert.equal(failRes.ok, false);
  assert.equal(failRes.rolledBack, true, '写凭据失败必须自动回滚');
  assert.match(String(failRes.error || ''), /写入受阻/, '失败必须返回真实原因');
  assert.equal(credStore.getApplied().email, 'a@example.com', '失败时系统凭据必须保持原当前账号');
  assert.equal(failRes.overview.activeAccountEmail, 'a@example.com', '失败时活跃账号必须保持不变');
  assert.notEqual(failRes.restartPending, true, '失败不得进入待重启态');

  // 2. 成功场景（deferRestart: true）：写入 b@example.com 凭据并返回 restartPending + canAutoRestart，交由前端自动单次接续 restartHost
  credStore.setFailWrite(false);
  const okRes = await accountsMod.dispatchAccountsAction(
    mgr,
    { action: 'switch', email: 'b@example.com', deferRestart: true },
    {
      restartClient: undefined,
      requiresClientRestart: true,
      canAutoRestart: true,
      deferRestart: true,
      allowManualRestartPending: true
    }
  );
  assert.equal(okRes.ok, true, `deferRestart 真实切号应成功: ${okRes.error || ''}`);
  assert.equal(okRes.restartPending, true);
  assert.equal(okRes.pendingRestart, true);
  assert.equal(okRes.canAutoRestart, true);
  assert.equal(okRes.manualRestartRequired, false);
  assert.equal(credStore.getApplied().email, 'b@example.com', '目标账号凭据必须已写入');

  // 3. 核对双入口（左下角菜单 & 设置账号页）零二次确认、前端自动接续单次 restartHost 与主进程防重入锁
  const sidebarSrc = fs.readFileSync(path.join(__dirname, 'src', 'renderer', 'sidebar-account.js'), 'utf8');
  const settingsUiSrc = fs.readFileSync(path.join(__dirname, 'src', 'renderer', 'context-settings-ui.js'), 'utf8');
  const rendererMainSrc = fs.readFileSync(path.join(__dirname, 'src', 'renderer', 'main.js'), 'utf8');
  const hostMainSrc = fs.readFileSync(path.join(__dirname, 'meter-main.js'), 'utf8');

  assert.match(sidebarSrc, /void executeDirectSwitch\(acc\)/, '左下角账号菜单单击必须直接调用 executeDirectSwitch');
  assert.match(settingsUiSrc, /if \(op === 'switch'\)[\s\S]{0,600}cbs\.onAction\('switchAccount'/, '设置账号页单击切换必须直接触发 switchAccount 且无二次确认');
  const switchFnStart = rendererMainSrc.indexOf('async function triggerSmoothAccountSwitch(');
  const switchFnEnd = rendererMainSrc.indexOf('async function triggerNativeHostAddAccount(', switchFnStart);
  assert.ok(switchFnStart > 0 && switchFnEnd > switchFnStart);
  const switchFnBlock = rendererMainSrc.slice(switchFnStart, switchFnEnd);
  assert.match(switchFnBlock, /accountSwitchRestartTriggered\s*=\s*true/, '前端接续重启必须具备单次防重入标记');
  assert.match(switchFnBlock, /phase:\s*'restarting'/, '自动接续重启必须展示插件主题 restarting 进度浮层');
  assert.match(switchFnBlock, /await window\.contextMeterAPI\.restartHost\(\)/, 'deferRestart 后必须由前端自动接续调用 restartHost 而非要求用户二次点击');
  assert.match(hostMainSrc, /let hostRestartInFlight = false;[\s\S]{0,480}if \(useGlobalGuard && hostRestartInFlight\)/, '主进程 handleRestartHost 必须具备防重入单次保护');
});

test('添加账号 OAuth 登录闭环: 真实授权入列保当前活跃号、取消/失败零半成品、重复添加合并更新且前端取消绕过 busy 锁', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-oauth-add-chain-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const nowFutureIso = new Date(Date.now() + 3600 * 1000).toISOString();
  const seedStore = {
    version: 1,
    activeAccountEmail: 'active@example.com',
    accounts: {
      'active@example.com': {
        email: 'active@example.com',
        name: 'CurrentActive',
        source: 'oauth_login',
        credential: { accessToken: 'tok-active', refreshToken: 'rt-active', expiresAt: nowFutureIso }
      }
    }
  };
  fs.writeFileSync(path.join(tmpDir, 'accounts_v1.json'), JSON.stringify(seedStore, null, 2), 'utf8');

  let oauthMockMode = 'success';
  let userEmailToReturn = 'NewUser@Example.com';
  let userNameToReturn = 'New User V1';
  const mockFetch = async (url) => {
    const u = String(url);
    if (u.includes('oauth2.googleapis.com/token')) {
      if (oauthMockMode === 'token_fail') {
        return {
          ok: false,
          status: 400,
          text: async () => JSON.stringify({ error: 'invalid_grant', error_description: 'Bad Verification Code' }),
          json: async () => ({ error: 'invalid_grant', error_description: 'Bad Verification Code' })
        };
      }
      const body = { access_token: 'tok-new-oauth', refresh_token: 'rt-new-oauth', expires_in: 3600 };
      return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body };
    }
    if (u.includes('userinfo')) {
      const body = { email: userEmailToReturn, name: userNameToReturn };
      return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body };
    }
    if (u.includes('loadCodeAssist')) {
      const body = { cloudaicompanionProject: 'proj-new-1', paidTier: { id: 'g1-pro-tier', name: 'Pro' } };
      return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body };
    }
    if (u.includes('fetchAvailableModels')) {
      const body = {
        agentModelSorts: [{ groups: [{ modelIds: ['gemini-3.1-pro'] }] }],
        models: {
          'gemini-3.1-pro': {
            displayName: 'Gemini 3.1 Pro',
            quotaInfo: { remainingFraction: 0.77, resetTime: '2026-11-28T05:00:00Z' }
          }
        }
      };
      return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body };
    }
    return { ok: false, status: 404, text: async () => 'not found', json: async () => ({}) };
  };

  const mgr = accountsMod.createAccountsManager({
    stateDir: tmpDir,
    fetch: mockFetch,
    oauthClientId: 'test-client-id',
    oauthClientSecret: 'test-client-secret'
  });

  // 1. 取消授权：立即释放监听且零半成品记录，活跃账号不变
  let cancelAuthUrl = '';
  const cancelPromise = accountsMod.dispatchAccountsAction(
    mgr,
    { action: 'oauth_login', timeoutMs: 8000 },
    {
      openExternal: (authUrl) => {
        cancelAuthUrl = authUrl;
        setTimeout(() => { void accountsMod.dispatchAccountsAction(mgr, { action: 'oauth_cancel' }, {}); }, 30);
      }
    }
  );
  const cancelRes = await cancelPromise;
  assert.ok(cancelAuthUrl.startsWith('https://accounts.google.com/'), '必须拉起真实 Google OAuth 授权地址');
  assert.equal(cancelRes.ok, false);
  assert.equal(cancelRes.cancelled, true);
  assert.equal(cancelRes.overview.accounts.length, 1, '取消授权绝不能留下半成品账号记录');
  assert.equal(cancelRes.overview.activeAccountEmail, 'active@example.com');

  // 2. 授权失败（回调返回 access_denied）：返回真实原因且零半成品记录
  const denyRes = await accountsMod.dispatchAccountsAction(
    mgr,
    { action: 'oauth_login', timeoutMs: 8000 },
    {
      openExternal: (authUrl) => {
        const parsed = new URL(authUrl);
        const redirectUri = parsed.searchParams.get('redirect_uri');
        const st = parsed.searchParams.get('state');
        http.get(`${redirectUri}?error=access_denied&state=${st}`, { agent: false }, (res) => res.resume()).on('error', () => { });
      }
    }
  );
  assert.equal(denyRes.ok, false);
  assert.match(String(denyRes.error || ''), /access_denied/);
  assert.equal(denyRes.overview.accounts.length, 1, '授权拒绝绝不能留下半成品记录');
  assert.equal(denyRes.overview.activeAccountEmail, 'active@example.com');

  // 3. 授权失败（换取 token 失败）：返回真实错误且零半成品记录
  oauthMockMode = 'token_fail';
  const tokFailRes = await accountsMod.dispatchAccountsAction(
    mgr,
    { action: 'oauth_login', timeoutMs: 8000 },
    {
      openExternal: (authUrl) => {
        const parsed = new URL(authUrl);
        const redirectUri = parsed.searchParams.get('redirect_uri');
        const st = parsed.searchParams.get('state');
        http.get(`${redirectUri}?code=bad-code&state=${st}`, { agent: false }, (res) => res.resume()).on('error', () => { });
      }
    }
  );
  assert.equal(tokFailRes.ok, false);
  assert.equal(tokFailRes.stage, 'token_exchange');
  assert.equal(tokFailRes.overview.accounts.length, 1, 'token 换取失败绝不能留下半成品记录');
  assert.equal(tokFailRes.overview.activeAccountEmail, 'active@example.com');

  // 4. 首次授权成功（含混合大小写邮箱）：保存归一化身份、列表立即出现新增项、当前活跃账号保持原样
  oauthMockMode = 'success';
  userEmailToReturn = 'NewUser@Example.com';
  userNameToReturn = 'New User V1';
  const addRes = await accountsMod.dispatchAccountsAction(
    mgr,
    { action: 'oauth_login', timeoutMs: 8000 },
    {
      openExternal: (authUrl) => {
        const parsed = new URL(authUrl);
        const redirectUri = parsed.searchParams.get('redirect_uri');
        const st = parsed.searchParams.get('state');
        http.get(`${redirectUri}?code=ok-code-1&state=${st}`, { agent: false }, (res) => res.resume()).on('error', () => { });
      }
    }
  );
  assert.equal(addRes.ok, true, `OAuth 添加账号应成功: ${addRes.error || ''}`);
  assert.equal(addRes.updatedExisting, false);
  assert.equal(addRes.account.email, 'newuser@example.com');
  assert.equal(addRes.account.isActive, false, '新增账号不应篡改当前活跃态');
  assert.ok(Array.isArray(addRes.account.quotaSnapshot?.pools) && addRes.account.quotaSnapshot.pools.length >= 1, '大小写邮箱归一化后应携带初始配额快照');
  assert.equal(addRes.overview.accounts.length, 2, '账号列表必须立即包含新增账号');
  assert.equal(addRes.overview.activeAccountEmail, 'active@example.com', '当前活跃账号必须保持原样');

  // 5. 重复添加同一账号：合并更新、不产生重复条目、不篡改当前活跃账号
  userNameToReturn = 'New User V2';
  const dupRes = await accountsMod.dispatchAccountsAction(
    mgr,
    { action: 'oauth_login', timeoutMs: 8000 },
    {
      openExternal: (authUrl) => {
        const parsed = new URL(authUrl);
        const redirectUri = parsed.searchParams.get('redirect_uri');
        const st = parsed.searchParams.get('state');
        http.get(`${redirectUri}?code=ok-code-2&state=${st}`, { agent: false }, (res) => res.resume()).on('error', () => { });
      }
    }
  );
  assert.equal(dupRes.ok, true);
  assert.equal(dupRes.updatedExisting, true, '重复添加应标记为更新已有记录');
  assert.equal(dupRes.account.name, 'New User V2');
  assert.equal(dupRes.overview.accounts.length, 2, '重复添加不得产生重复条目');
  assert.equal(dupRes.overview.activeAccountEmail, 'active@example.com', '重复添加不得篡改当前活跃账号');

  // 6. 前端调用链核验：双入口均走 triggerOAuthAddAccount，且 performAccountAction 对 oauth_cancel 绕过 busy 锁
  const rendererMainSrc = fs.readFileSync(path.join(__dirname, 'src', 'renderer', 'main.js'), 'utf8');
  assert.match(rendererMainSrc, /onAddAccount:\s*\(\)\s*=>\s*triggerOAuthAddAccount\(\{\s*source:\s*'sidebar'\s*\}\)/);
  assert.match(rendererMainSrc, /actionName === 'addAccount'[\s\S]{0,120}triggerOAuthAddAccount\(\{\s*source:\s*'accountsPage'\s*\}\)/);
  assert.match(rendererMainSrc, /async function performAccountAction\(action, extraPayload = \{\}\) \{\s*if \(action === 'oauth_cancel'\)/, 'oauth_cancel 必须绕过 accountsUiState.busy 门禁以立即取消挂起授权');
});

test('导入 Tools 全链路闭环: 有效导入即刻入列、重复去重、保原活跃号及缺失/损坏/部分无效明确反馈并保留已有账号', async (t) => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-tools-import-home-'));
  const tmpState = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-tools-import-state-'));
  t.after(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(tmpState, { recursive: true, force: true });
  });

  const nowFutureIso = new Date(Date.now() + 3600 * 1000).toISOString();
  fs.writeFileSync(path.join(tmpState, 'accounts_v1.json'), JSON.stringify({
    version: 1,
    activeAccountEmail: 'active@example.com',
    accounts: {
      'active@example.com': {
        email: 'active@example.com',
        name: 'KeepActive',
        source: 'oauth_login',
        credential: { accessToken: 'tok-active', refreshToken: 'rt-active', expiresAt: nowFutureIso }
      }
    }
  }, null, 2), 'utf8');

  const mgr = accountsMod.createAccountsManager({ stateDir: tmpState, homeDir: tmpHome });

  // 1. 来源缺失：明确失败并保留已有账号与活跃态
  const missingRes = await accountsMod.dispatchAccountsAction(mgr, { action: 'import_tools' }, {});
  assert.equal(missingRes.ok, false);
  assert.match(String(missingRes.error || ''), /未发现/);
  assert.equal(missingRes.overview.accounts.length, 1);
  assert.equal(missingRes.overview.activeAccountEmail, 'active@example.com');

  // 2. 数据损坏（accounts.json 非法 JSON）：返回 ok: false + 具体损坏原因，已有账号毫发无损
  const toolsDir = path.join(tmpHome, '.antigravity_tools');
  fs.mkdirSync(path.join(toolsDir, 'accounts'), { recursive: true });
  fs.writeFileSync(path.join(toolsDir, 'accounts.json'), '{broken json', 'utf8');
  const corruptRes = await accountsMod.dispatchAccountsAction(mgr, { action: 'import_tools' }, {});
  assert.equal(corruptRes.ok, false);
  assert.match(String(corruptRes.error || ''), /accounts\.json 已损坏/);
  assert.equal(corruptRes.overview.accounts.length, 1);
  assert.equal(corruptRes.overview.activeAccountEmail, 'active@example.com');

  // 3. 混合有效账号 + 重复邮箱 + 无效记录（缺邮箱）+ 单条损坏详情文件：有效入列、去重、暴露具体异常、保当前活跃号
  fs.writeFileSync(path.join(toolsDir, 'accounts.json'), JSON.stringify({
    accounts: [
      { id: 't-valid-1', email: 'ToolsUser@Example.com', name: 'Tools Valid' },
      { id: 't-valid-dup', email: 'toolsuser@example.com', name: 'Tools Dup' },
      { id: 't-bad-no-email', email: '', name: 'NoEmail' },
      { id: 't-bad-detail', email: 'broken-detail@example.com', name: 'Broken Detail' }
    ]
  }, null, 2), 'utf8');
  fs.writeFileSync(path.join(toolsDir, 'accounts', 't-valid-1.json'), JSON.stringify({
    email: 'ToolsUser@Example.com',
    name: 'Tools Valid Detail',
    token: { refresh_token: 'rt-tools-1', access_token: 'at-tools-1', expiry: nowFutureIso }
  }, null, 2), 'utf8');
  fs.writeFileSync(path.join(toolsDir, 'accounts', 't-bad-detail.json'), '{corrupt-detail', 'utf8');

  const partialRes = await accountsMod.dispatchAccountsAction(mgr, { action: 'import_tools' }, {});
  assert.equal(partialRes.ok, true);
  assert.equal(partialRes.partial, true);
  assert.equal(partialRes.importedCount, 2, '有效账号与有邮箱记录应导入且重复邮箱自动去重');
  assert.equal(partialRes.credentialsImportedCount, 1);
  assert.equal(partialRes.invalidCount, 1, '缺少有效邮箱的记录必须计入 invalidCount');
  assert.ok(partialRes.warnings.length >= 2, '应收集无邮箱与损坏详情文件两条具体告警');
  assert.match(String(partialRes.message || ''), /另有 \d+ 条异常\/无效记录/, '返回文案必须向用户明示异常/无效记录');
  assert.equal(partialRes.overview.accounts.length, 3, '列表应立即包含原活跃号 + 2 个去重后的新增号');
  assert.equal(partialRes.overview.activeAccountEmail, 'active@example.com', '导入 Tools 绝不得改变当前活跃账号');

  // 4. 重复点击导入 Tools：同一邮箱仍只保留一条记录、当前活跃账号保持原样
  const repeatRes = await accountsMod.dispatchAccountsAction(mgr, { action: 'import_tools' }, {});
  assert.equal(repeatRes.ok, true);
  assert.equal(repeatRes.overview.accounts.length, 3, '重复导入同一邮箱绝不得产生重复条目');
  assert.equal(repeatRes.overview.activeAccountEmail, 'active@example.com');

  // 5. 前端按钮与动作接线校验
  const settingsUiSrc = fs.readFileSync(path.join(__dirname, 'src', 'renderer', 'context-settings-ui.js'), 'utf8');
  const rendererMainSrc = fs.readFileSync(path.join(__dirname, 'src', 'renderer', 'main.js'), 'utf8');
  assert.match(settingsUiSrc, /id="ag-ac-btn-import-tools"[\s\S]{0,120}data-ag-ac-action="importTools"/);
  assert.match(settingsUiSrc, /btnTools\.hidden\s*=\s*!data\.toolsAvailable;/, '导入 Tools 按钮必须随 toolsAvailable 真实显示而非硬编码隐藏');
  assert.match(rendererMainSrc, /actionName === 'importTools'[\s\S]{0,160}performAccountAction\('import_tools'\)/);
});
