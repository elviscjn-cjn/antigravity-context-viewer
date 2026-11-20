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

test('ELV-89 OAuth 代理隧道与本地直连隔离 + 身份入列/额度分离 + 脱敏日志与同名邮箱遮罩区分', async () => {
  const tmpDir = makeTempDir('acm-oauth-proxy-');
  const stateDir = path.join(tmpDir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });

  // 1. 掩码需区分同前缀不同末尾邮箱
  assert.notEqual(accountsMod.maskEmail('elvisnanisbest@gmail.com'), accountsMod.maskEmail('elvisbeiyong123@gmail.com'));
  assert.equal(accountsMod.maskEmail('elvisnanisbest@gmail.com'), 'el***st@gmail.com');
  assert.equal(accountsMod.maskEmail('elvisbeiyong123@gmail.com'), 'el***23@gmail.com');

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
          text: async () => JSON.stringify({ email: '1213811112222elvis@gmail.com', name: 'NewAcct' })
        };
      }
      if (u.includes('cloudcode-pa.googleapis.com')) {
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
    assert.equal(addRes.targetHost, 'cloudcode-pa.googleapis.com');
    assert.equal(addRes.httpStatus, 503);
    assert.equal(addRes.account.email, '1213811112222elvis@gmail.com');
    assert.ok(addRes.account.lastQuotaError);

    // 重新实例检查持久化与列表可见性
    const mgrReload = accountsMod.createAccountsManager({ stateDir, credentialStore: makeMockCredStore(), fetch: customFetch });
    const persistedAcct = mgrReload.getOverviewState().accounts.find(a => a.email === '1213811112222elvis@gmail.com');
    assert.ok(persistedAcct, '重启后新添加账号必须持久化在列表中');
    assert.equal(persistedAcct.hasRefreshToken, true);

    // 恢复额度接口，执行单账号重试
    failQuota = false;
    const retryRes = await mgr.refreshAccountQuota('1213811112222elvis@gmail.com');
    assert.equal(retryRes.ok, true);
    assert.equal(retryRes.account.lastQuotaError, null);

    // 验证脱敏诊断日志绝不泄露任何敏感值
    const diagFile = path.join(stateDir, 'oauth_diagnostics.jsonl');
    assert.equal(fs.existsSync(diagFile), true);
    const diagContent = fs.readFileSync(diagFile, 'utf8');
    assert.doesNotMatch(diagContent, /mock_auth_code_777|secret_access_tok_xyz|secret_refresh_tok_xyz|mock-super-client-secret-999/);
    assert.match(diagContent, /cloudcode-pa\.googleapis\.com/);
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
    'sel-auto-switch-pool',
    'sel-auto-switch-mode',
    'sel-auto-switch-window'
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

    // 3. 验证三语下无 NoPerm、英文模式下界面账号/保活/费用等动态文案无中文泄漏
    await api.setPanelLanguage('en', { persist: false });
    assert.match(elements.get('t-total-cost').textContent, /No records for account/);
    const acctListJsonEn = JSON.stringify(elements.get('quota-accounts-list').children);
    assert.doesNotMatch(acctListJsonEn, /NoPerm/, '界面绝不能出现原始 NoPerm');
    assert.match(acctListJsonEn, /No model access/);
    assert.match(acctListJsonEn, /Quota fetch failed/);
    assert.doesNotMatch(elements.get('keepalive-protocol-summary').textContent, /[\u4e00-\u9fa5]/);
    assert.doesNotMatch(elements.get('keepalive-experiment-summary').textContent, /[\u4e00-\u9fa5]/);
    assert.doesNotMatch(elements.get('keepalive-runtime-note').textContent, /[\u4e00-\u9fa5]/);
    assert.doesNotMatch(elements.get('token-account-scope-note').textContent, /[\u4e00-\u9fa5]/);

    await api.setPanelLanguage('zh-TW', { persist: false });
    const acctListJsonTw = JSON.stringify(elements.get('quota-accounts-list').children);
    assert.match(acctListJsonTw, /無模型權限/);
    assert.doesNotMatch(elements.get('keepalive-protocol-summary').textContent, /协议核查|默认关闭/);

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
    const nowMs = Date.now();
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

test('v0.8.8 账本与切号补充回归: 二次污染 elv89-v2 自动升级纠偏、来源切换首次日期隔离与 LS 换端口发现', async () => {
  const agDir = makeTempDir('acm-elv89-v3-ag-');
  const stateDir = makeTempDir('acm-elv89-v3-st-');
  try {
    const emailNew = 'ultra@example.com';
    const scopeNew = accountsMod.buildAccountScopeKey(emailNew);
    const nowMs = Date.now();
    const tNewStart = nowMs - 600000;
    const today = collector.formatLocalDateKey(new Date(nowMs));
    const cidOld = 'cccccccc-0000-0000-0000-000000000003';
    const cidNew = 'dddddddd-0000-0000-0000-000000000004';
    const oldIso = '2026-10-25T09:31:21.000Z';
    const newIso = new Date(tNewStart + 60000).toISOString();

    fs.mkdirSync(path.join(agDir, 'brain', cidOld, '.system_generated', 'logs'), { recursive: true });
    fs.mkdirSync(path.join(agDir, 'brain', cidNew, '.system_generated', 'logs'), { recursive: true });
    fs.writeFileSync(path.join(agDir, 'brain', cidOld, '.system_generated', 'logs', 'transcript.jsonl'), JSON.stringify({
      step_index: 1, type: 'PLANNER_RESPONSE', created_at: oldIso,
      model: 'gemini-3.8-flash', responseId: 'req_polluted_v2',
      input_tokens: 20000, cache_read_tokens: 0, output_tokens: 2000
    }) + '\n');
    fs.writeFileSync(path.join(agDir, 'brain', cidNew, '.system_generated', 'logs', 'transcript.jsonl'), JSON.stringify({
      step_index: 1, type: 'PLANNER_RESPONSE', created_at: newIso,
      model: 'gemini-4-hydrogen', responseId: 'req_clean_today',
      input_tokens: 3000, cache_read_tokens: 7000, output_tokens: 500
    }) + '\n');

    fs.writeFileSync(path.join(stateDir, 'accounts_v1.json'), JSON.stringify({
      version: 1,
      activeAccountEmail: emailNew,
      accounts: {
        [emailNew]: { email: emailNew, credential: { accessToken: 'tok', refreshToken: 'ref' } }
      },
      accountSessions: [
        { accountScopeKey: scopeNew, email: emailNew, startAtMs: tNewStart, endAtMs: null, source: 'desktop' }
      ]
    }));

    // 模拟被旧版错写且残存 attributionRepairVersion: 'elv89-v2' 的旧记录和 provisional 记录
    fs.writeFileSync(path.join(agDir, 'pricing_ledger_v1.json'), JSON.stringify({
      version: 1,
      calls: {
        req_polluted_v2: {
          callId: 'req_polluted_v2',
          cascadeId: cidOld,
          stepIndex: 1,
          source: 'desktop',
          model: 'gemini-3.8-flash',
          isPriced: true,
          inputTokens: 20000,
          cacheTokens: 0,
          outputTokens: 2000,
          totalTokens: 22000,
          date: '2026-10-25',
          created_at: oldIso,
          timestamp: Date.parse(oldIso),
          accountScopeKey: scopeNew,
          accountAttributionConfidence: 'session_window_verified',
          accountAttributionEvidence: 'desktop_state_db',
          attributionRepairVersion: 'elv89-v2'
        },
        req_clean_today: {
          callId: 'req_clean_today',
          cascadeId: cidNew,
          stepIndex: 1,
          source: 'desktop',
          model: 'gemini-4-hydrogen',
          isPriced: true,
          inputTokens: 3000,
          cacheTokens: 7000,
          outputTokens: 500,
          totalTokens: 10500,
          date: today,
          created_at: newIso,
          timestamp: Date.parse(newIso),
          accountScopeKey: scopeNew,
          accountAttributionConfidence: 'session_window_verified',
          attributionRepairVersion: 'elv89-v2'
        }
      }
    }));

    const r1 = await collector.collectTokenHistoryAsync({ agDir, stateDir, wslRoots: [], force: true });
    assert.equal(r1.usageByAccount[scopeNew].totalTokens, 10500);
    assert.equal(r1.usageByAccount[scopeNew].firstUseDate, today);
    assert.equal(r1.unattributedUsage.totalTokens, 22000);
    assert.equal(r1.summary.grandTotalTokens, r1.usageByAccount[scopeNew].totalTokens + r1.unattributedUsage.totalTokens);

    // 验证 core.normalizeTokenHistoryPayload 在 cli 来源下（0 记录）firstUseDate 为 null，不泄漏 desktop 首日
    const normCli = core.normalizeTokenHistoryPayload({
      ...r1,
      scopedAccountView: true,
      firstUseDate: r1.usageByAccount[scopeNew].firstUseDate,
      dailyMap: r1.usageByAccount[scopeNew].dailyMap,
      dailyMapBySource: r1.usageByAccount[scopeNew].dailyMapBySource
    }, { source: 'cli', todayStr: today, scopedAccountView: true });
    assert.equal(normCli.firstUseDate, null);
    assert.equal(normCli.summary.grandTotalTokens, 0);

    // 验证无 CDP 场景下的活跃端口发现：首选 Electron 活跃窗口 URL，次选 currentOrigin 更新，再后备 daemon/hub_*.json（pid 存活 + mtimeMs 最新），绝不走无参 CDP
    let cdpCalled = false;
    let lsKilledIncludeCli = null;
    const daemonDir = makeTempDir('acm-daemon-hub-');
    try {
      const deadHubFile = path.join(daemonDir, 'hub_59001.json');
      fs.writeFileSync(deadHubFile, JSON.stringify({ pid: 999991, httpsPort: 59001, httpPort: 59002, csrfToken: 'tok-dead' }));
      const deadTime = new Date(Date.now() + 20000);
      fs.utimesSync(deadHubFile, deadTime, deadTime);

      const oldAliveHubFile = path.join(daemonDir, 'hub_59011.json');
      fs.writeFileSync(oldAliveHubFile, JSON.stringify({ pid: 41001, httpsPort: 59011, httpPort: 59012, csrfToken: 'tok-old' }));
      const oldTime = new Date(Date.now() - 10000);
      fs.utimesSync(oldAliveHubFile, oldTime, oldTime);

      const latestAliveHubFile = path.join(daemonDir, 'hub_59099.json');
      fs.writeFileSync(latestAliveHubFile, JSON.stringify({ pid: 42002, httpsPort: 59099, httpPort: 59100, csrfToken: 'tok-latest' }));
      const newTime = new Date(Date.now() - 1000);
      fs.utimesSync(latestAliveHubFile, newTime, newTime);

      const discoveredHubs = accountsMod.discoverDaemonHubOrigins({
        daemonDir,
        isPidAlive: (pid) => pid === 41001 || pid === 42002
      });
      assert.equal(discoveredHubs.length, 2, '已退出进程 pid 的 hub_*.json 必须过滤');
      assert.equal(discoveredHubs[0].origin, 'https://127.0.0.1:59099', '必须优先返回 mtimeMs 最新的存活 hub');

      const credStore = makeMockCredStore();
      let liveWinOrigin = 'https://127.0.0.1:50001';
      const usedOrigins = [];
      const sharedMgr = accountsMod.getSharedAccountsManager({
        forceNew: true,
        stateDir,
        origin: 'https://127.0.0.1:50001',
        daemonDir,
        isPidAlive: (pid) => pid === 41001 || pid === 42002,
        getLiveOrigins: () => [liveWinOrigin],
        oauthClientId: 'mock-cid',
        oauthClientSecret: 'mock-sec',
        credentialStore: credStore,
        restartLanguageServers: async (opts) => {
          lsKilledIncludeCli = opts?.includeCli;
          liveWinOrigin = 'https://127.0.0.1:50099';
          return { ok: true };
        },
        directRequestFn: async (origin, token) => {
          usedOrigins.push(`direct:${origin}:${token}`);
          throw new Error('force window origin first');
        },
        localApi: {
          async connect(connOpts) {
            if (!connOpts || !connOpts.origin) {
              cdpCalled = true;
              throw new Error('绝不能调用无 origin 的 CDP 发现');
            }
            usedOrigins.push(`window:${connOpts.origin}`);
            if (connOpts.origin === 'https://127.0.0.1:50001') {
              throw new Error('connect ECONNREFUSED 127.0.0.1:50001');
            }
            return {
              origin: connOpts.origin,
              async call(method) {
                if (method === 'GetUserStatus') return { userStatus: { email: 'switch-target@example.com' } };
                return {};
              }
            };
          }
        }
      });
      const st = JSON.parse(fs.readFileSync(path.join(stateDir, 'accounts_v1.json'), 'utf8'));
      st.accounts['switch-target@example.com'] = {
        email: 'switch-target@example.com',
        credential: {
          accessToken: 'tok-target',
          refreshToken: 'ref-target',
          expiresAt: new Date(Date.now() + 3600000).toISOString()
        }
      };
      fs.writeFileSync(path.join(stateDir, 'accounts_v1.json'), JSON.stringify(st));
      const swRes = await sharedMgr.switchActiveAccount('switch-target@example.com', {
        forceWhileBusy: true,
        skipTokenRefresh: true,
        verifyTimeoutMs: 500
      });
      assert.equal(swRes.ok, true);
      assert.equal(lsKilledIncludeCli, false);
      assert.equal(cdpCalled, false, '非 CDP 路径绝不能调用无参 CDP');
      assert.ok(usedOrigins.includes('window:https://127.0.0.1:50099'), 'LS 重启端口变化后必须从活跃窗口读取新端口完成校验');
      const det = await sharedMgr.detectCurrentActiveAccount();
      assert.equal(det.email, 'switch-target@example.com');
    } finally {
      fs.rmSync(daemonDir, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(agDir, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('v0.8.8 非 CDP 切号与回滚对称: shared origin 更新、daemon hub 后备、新建 token 文件删除、临时会话清理、重载展示与防错记', async () => {
  const agDir = makeTempDir('acm-noncdp-ag-');
  const stateDir = makeTempDir('acm-noncdp-st-');
  const daemonDir = makeTempDir('acm-noncdp-hub-');
  const homeDir = makeTempDir('acm-noncdp-home-');
  try {
    // 1. 验证 createDefaultSystemCredentialStore 回滚会删除切号前不存在的 jetski/cli token 文件
    const realCredStore = accountsMod.createDefaultSystemCredentialStore({
      homeDir,
      appDataDir: homeDir,
      desktopDbPath: path.join(homeDir, 'missing-desktop.vscdb'),
      ideDbPath: path.join(homeDir, 'missing-ide.vscdb')
    });
    // 测试沙箱绝对不读写宿主真实 Windows 凭据管理器
    realCredStore.readWindowsSystemCredential = () => null;
    realCredStore.writeWindowsSystemCredential = () => ({ ok: true, skipped: true });
    const realPaths = realCredStore.getPaths();
    fs.mkdirSync(path.dirname(realPaths.googleAccountsPath), { recursive: true });
    fs.mkdirSync(path.dirname(realPaths.cliTokenPath), { recursive: true });
    fs.writeFileSync(realPaths.googleAccountsPath, JSON.stringify({ active: 'before@example.com', old: [] }));
    fs.writeFileSync(realPaths.oauthCredsPath, JSON.stringify({ access_token: 'old-a', refresh_token: 'old-r' }));

    const preSnap = realCredStore.captureSnapshot();
    assert.equal(preSnap.jetskiTokenRaw, null);
    assert.equal(preSnap.cliTokenRaw, null);
    // 模拟切号过程中写出了新建的 jetski/cli token 文件
    fs.writeFileSync(realPaths.jetskiTokenPath, '{"access_token":"tmp-j"}');
    fs.writeFileSync(realPaths.cliTokenPath, '{"access_token":"tmp-c"}');
    assert.equal(fs.existsSync(realPaths.jetskiTokenPath), true);
    assert.equal(fs.existsSync(realPaths.cliTokenPath), true);
    const rbRes = realCredStore.restoreSnapshot(preSnap);
    assert.equal(rbRes.ok, true);
    assert.equal(fs.existsSync(realPaths.jetskiTokenPath), false, '回滚时必须删除本次切号新建的 jetski token 文件');
    assert.equal(fs.existsSync(realPaths.cliTokenPath), false, '回滚时必须删除本次切号新建的 cli token 文件');

    // 2. 验证 getSharedAccountsManager 多次传新 origin 会更新 currentOrigin，并在无窗口 URL 时走 daemon hub_*.json 后备
    let observedTokens = [];
    let hubAlive = { pid: 55100, httpsPort: 61111, httpPort: 61112, csrfToken: 'hub-csrf-new' };
    fs.writeFileSync(path.join(daemonDir, 'hub_61112.json'), JSON.stringify(hubAlive));

    const mgrA = accountsMod.getSharedAccountsManager({
      stateDir,
      origin: 'https://127.0.0.1:61001',
      daemonDir,
      homeDir,
      isPidAlive: (pid) => pid === 55100,
      getLiveOrigins: () => [],
      directRequestFn: async (origin, token) => {
        observedTokens.push(`${origin}#${token}`);
        return { email: 'hub-fallback@example.com', userStatus: { email: 'hub-fallback@example.com' } };
      },
      localApi: {
        async connect(connOpts) {
          assert.ok(connOpts && connOpts.origin, '绝不调用无 origin CDP');
          observedTokens.push(`conn:${connOpts.origin}`);
          if (connOpts.origin === 'https://127.0.0.1:61001') {
            throw new Error('old origin refused');
          }
          return {
            origin: connOpts.origin,
            async call() {
              return { userStatus: { email: 'updated-origin@example.com' } };
            }
          };
        }
      }
    });
    // 第二次调用更换 origin，必须更新 sharedRuntime.currentOrigin 而不是停在 61001
    const mgrB = accountsMod.getSharedAccountsManager({ origin: 'https://127.0.0.1:61002' });
    assert.equal(mgrB, mgrA);
    const detUpdated = await mgrB.detectCurrentActiveAccount();
    assert.equal(detUpdated.email, 'updated-origin@example.com', '再次调用 getSharedAccountsManager 传入新 origin 必须刷新 currentOrigin');
    assert.ok(observedTokens.includes('conn:https://127.0.0.1:61002'));

    // 当所有已知 origin 失联时，必须后备走 daemon/hub_*.json 拿到 hub-fallback@example.com（仍不走 CDP）
    observedTokens = [];
    const mgrC = accountsMod.getSharedAccountsManager({ origin: 'https://127.0.0.1:61001' });
    const detHub = await mgrC.detectCurrentActiveAccount();
    assert.equal(detHub.email, 'hub-fallback@example.com');
    assert.ok(observedTokens.includes('https://127.0.0.1:61111#hub-csrf-new'));

    // 3. 验证切号失败回滚对称：activeAccountEmail 恢复、切号窗口临时会话关闭、切号期与回滚窗口流量绝不归属到目标账号、且窗口重载后 UI 显示失败+回滚与成功结果
    const isolatedStateDir = makeTempDir('acm-noncdp-rb-');
    try {
      const credStore2 = makeMockCredStore();
      let liveEmail = 'acct-a@example.com';
      let hostStatusPauseResolve = null;
      const nowBase = Date.now() - 10000;
      const mgrRb = accountsMod.createAccountsManager({
        stateDir: isolatedStateDir,
        credentialStore: credStore2,
        oauthClientId: 'mock-cid',
        oauthClientSecret: 'mock-sec',
        getHostUserStatus: async () => {
          if (hostStatusPauseResolve) {
            await new Promise((resolve) => {
              const prev = hostStatusPauseResolve;
              hostStatusPauseResolve = () => { prev(); resolve(); };
            });
          }
          return { email: liveEmail };
        },
        restartLanguageServers: async () => {
          // 模拟切号进行中窗口意外重载调用 detectCurrentActiveAccount：此时决不能把目标 acct-b 写成活跃或新建会话！
          await mgrRb.detectCurrentActiveAccount();
          return { ok: true };
        }
      });
      mgrRb.addAccountWithCredential({
        email: 'acct-a@example.com',
        accessToken: 'ta',
        refreshToken: 'ra',
        expiresAt: new Date(Date.now() + 3600000).toISOString()
      });
      mgrRb.addAccountWithCredential({
        email: 'acct-b@example.com',
        accessToken: 'tb',
        refreshToken: 'rb',
        expiresAt: new Date(Date.now() + 3600000).toISOString()
      });
      const initSt = mgrRb.loadStore();
      initSt.activeAccountEmail = 'acct-a@example.com';
      initSt.accountSessions = [{
        email: 'acct-a@example.com',
        accountScopeKey: accountsMod.buildAccountScopeKey('acct-a@example.com'),
        source: 'desktop',
        startAtMs: nowBase - 60000,
        lastVerifiedAtMs: nowBase,
        endAtMs: null,
        evidence: 'host_user_status'
      }];
      mgrRb.saveStore(initSt);

      // 制造“校验始终回报原账号 acct-a”的失败并触发回滚
      const failSw = await mgrRb.switchActiveAccount('acct-b@example.com', {
        forceWhileBusy: true,
        skipTokenRefresh: true,
        verifyTimeoutMs: 60
      });
      assert.equal(failSw.ok, false);
      assert.equal(failSw.rolledBack, true);

      const postFailOv = mgrRb.getOverviewState();
      assert.equal(postFailOv.activeAccountEmail, 'acct-a@example.com', '回滚后必须恢复 activeAccountEmail 为切号前的 A');
      assert.equal(postFailOv.accountSessions.some(s => s.email === 'acct-b@example.com'), false, '中途或未核验目标会话必须清理，不能留在 accountSessions');
      assert.equal(postFailOv.autoSwitchStatus?.lastResult?.ok, false);
      assert.equal(postFailOv.autoSwitchStatus?.lastResult?.rolledBack, true);

      // 模拟切号期间与回滚后产生的用量入账：绝不能被归属到目标账号 acct-b
      const scopeB = accountsMod.buildAccountScopeKey('acct-b@example.com');
      const isoLedgerFile = path.join(isolatedStateDir, 'pricing_ledger_v1.json');
      const recRes = collector.recordModelCalls([{
        callId: 'req_during_rollback_1',
        cascadeId: 'dddddddd-0000-0000-0000-000000000004',
        stepIndex: 0,
        source: 'desktop',
        model: 'gemini-4-hydrogen',
        inputTokens: 1000,
        cacheTokens: 0,
        outputTokens: 200,
        timestamp: Date.now(),
        liveRealtimeConfirmed: true
      }], {
        ledgerPath: isoLedgerFile,
        accountSessions: postFailOv.accountSessions,
        // 切号锁激活期间 meter-main 会省略 liveConfirmedAccount
        liveConfirmedAccount: null
      });
      assert.equal(recRes.ok, true);
      const isoLedger = JSON.parse(fs.readFileSync(isoLedgerFile, 'utf8'));
      const entryRb = isoLedger.calls['req_during_rollback_1'];
      assert.ok(entryRb);
      assert.notEqual(entryRb.accountScopeKey, scopeB, '回滚窗口内用量绝不能被兜底记到目标账号 B');

      // 窗口重载模拟：全新 RENDERER_SOURCE VM 加载 overview，必须立即看到失败原因和回滚状态
      const createUiAndInspect = (ovSnapshot) => {
        const els = new Map();
        const mk = (id) => {
          const attrs = new Map(); const cls = new Set();
          const n = {
            id: id || '', style: { setProperty() {}, removeProperty() {}, getPropertyValue() { return ''; }, display: '' },
            children: [], options: [], selectedOptions: [], hidden: false, disabled: false, textContent: '', value: '', title: '', className: '', dataset: {},
            classList: { add(c) { cls.add(c); n.className = Array.from(cls).join(' '); }, remove(c) { cls.delete(c); n.className = Array.from(cls).join(' '); }, contains(c) { return cls.has(c); } },
            addEventListener() {}, dispatchEvent() {}, setAttribute(k, v) { attrs.set(k, String(v)); }, getAttribute(k) { return attrs.get(k) ?? null; }, removeAttribute(k) { attrs.delete(k); },
            appendChild(c) { if (c) { n.children.push(c); if (n.options) n.options.push(c); } },
            replaceChildren(...xs) { n.children = xs.filter(Boolean); if (n.options) n.options = xs.filter(Boolean); },
            remove() {}, contains() { return false; }, matches() { return false; }, closest() { return null; }, querySelector() { return null; }, querySelectorAll() { return []; },
            getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 24, right: 100, bottom: 24 }; }
          };
          if (id) els.set(id, n);
          return n;
        };
        const host = mk('ag-host');
        host.attachShadow = () => ({ set innerHTML(_v) {}, getElementById: id => els.get(id) || mk(id), querySelectorAll: () => [] });
        let firstEl = true;
        const sb = {
          location: { protocol: 'https:', hostname: '127.0.0.1', pathname: '/c/11111111-1111-1111-1111-111111111112' },
          document: { createElement: () => (firstEl ? (firstEl = false, host) : mk()), getElementById: id => els.get(id) || null, documentElement: { appendChild() {} }, addEventListener() {}, removeEventListener() {}, hidden: false },
          window: { __APP_CONFIG__: { csrfToken: 't' } },
          matchMedia: () => ({ matches: false }),
          __AGContextMeterCore: core, AbortController, Date,
          setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {},
          fetch: async () => ({ ok: true, json: async () => ({ generatorMetadata: [] }) })
        };
        vm.createContext(sb);
        vm.runInContext(RENDERER_SOURCE, sb);
        const uiApi = sb.__AGContextMeter;
        try {
          uiApi.setAccountsOverviewForTest(ovSnapshot);
          return {
            feedbackText: els.get('quota-acct-feedback')?.textContent || '',
            feedbackHidden: els.get('quota-acct-feedback')?.hidden,
            lastNoteText: els.get('auto-switch-last-note')?.textContent || ''
          };
        } finally {
          uiApi.dispose();
        }
      };

      const reloadedFailUi = createUiAndInspect(postFailOv);
      assert.equal(reloadedFailUi.feedbackHidden, false, '窗口重载后应展示持久化失败反馈横幅');
      assert.match(reloadedFailUi.feedbackText, /回滚|验证未生效/);
      assert.match(reloadedFailUi.lastNoteText, /回滚|验证未生效/);

      // 切号成功且重载后 UI 也能看到成功结果
      liveEmail = 'acct-b@example.com';
      const okSw = await mgrRb.switchActiveAccount('acct-b@example.com', {
        forceWhileBusy: true,
        skipTokenRefresh: true,
        verifyTimeoutMs: 500
      });
      assert.equal(okSw.ok, true);
      const okOv = mgrRb.getOverviewState();
      assert.equal(okOv.autoSwitchStatus?.lastResult?.ok, true);
      assert.equal(okOv.autoSwitchStatus?.lastResult?.rolledBack, false);
      const reloadedOkUi = createUiAndInspect(okOv);
      assert.equal(reloadedOkUi.feedbackHidden, false);
      assert.match(reloadedOkUi.feedbackText, /acct-b@example\.com/);
      assert.match(reloadedOkUi.lastNoteText, /acct-b@example\.com/);
      assert.ok(accountsMod.DEFAULT_SWITCH_VERIFY_TIMEOUT_MS >= 20000);

      // 4. 验证切号进行中（inFlightSwitch lock 生效期间）概览状态显式标记 switchInProgress=true 且 meter-main 暴露 getActiveHubWindowOrigins
      const meterMain = require('./meter-main');
      assert.equal(typeof meterMain.getActiveHubWindowOrigins, 'function');
      assert.deepEqual(meterMain.getActiveHubWindowOrigins(), []);

      let switchProceedResolve;
      hostStatusPauseResolve = () => {};
      let sawSwitchInFlightDuringVerify = false;
      liveEmail = 'acct-a@example.com';
      const pendingSw = mgrRb.switchActiveAccount('acct-a@example.com', {
        forceWhileBusy: true,
        skipTokenRefresh: true,
        verifyTimeoutMs: 5000
      });
      await new Promise(r => setTimeout(r, 400));
      const midOv = mgrRb.getOverviewState();
      sawSwitchInFlightDuringVerify = Boolean(mgrRb.isSwitchInFlight() && midOv.switchInProgress);
      assert.equal(sawSwitchInFlightDuringVerify, true, '切号进行中 isSwitchInFlight 与 switchInProgress 必须为 true');
      // 切号进行中产生的调用（不带 liveConfirmedAccount）绝不能记到未核验账号
      collector.recordModelCalls([{
        callId: 'req_mid_switch_inflight',
        cascadeId: 'eeeeeeee-0000-0000-0000-000000000005',
        stepIndex: 0,
        source: 'desktop',
        model: 'gemini-4-hydrogen',
        inputTokens: 500,
        cacheTokens: 0,
        outputTokens: 100,
        timestamp: Date.now(),
        liveRealtimeConfirmed: true
      }], {
        ledgerPath: isoLedgerFile,
        accountSessions: midOv.accountSessions,
        liveConfirmedAccount: null
      });
      const midLedger = JSON.parse(fs.readFileSync(isoLedgerFile, 'utf8'));
      const midEntry = midLedger.calls['req_mid_switch_inflight'];
      assert.ok(midEntry);
      assert.equal(midEntry.accountScopeKey ?? null, null, '切号进行中无确认前不能兜底记入任何账号');
      switchProceedResolve = hostStatusPauseResolve;
      hostStatusPauseResolve = null;
      switchProceedResolve();
      const finalSw = await pendingSw;
      assert.equal(finalSw.ok, true);
    } finally {
      fs.rmSync(isolatedStateDir, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(daemonDir, { recursive: true, force: true });
    fs.rmSync(agDir, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('Issue #50: 仅账本内容变化时备份、单账本最多保留 N=3 份、升级清理只留最新 1 份且幂等运行 100 次零新增', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-issue50-bak-'));
  const agDir = path.join(tmpDir, 'ag');
  const stateDir = path.join(tmpDir, 'state');
  fs.mkdirSync(agDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  const ledgerPath = path.join(agDir, 'pricing_ledger_v1.json');

  const countBackups = () => fs.readdirSync(agDir).filter(f => f.startsWith('pricing_ledger_v1.json.bak-pre-elv89-'));

  try {
    const scopeA = 'email:a@example.com';
    const tBase = Date.parse('2026-11-18T10:00:00.000Z');
    const accountSessions = [{
      sessionId: 'sess-50-1',
      accountScopeKey: scopeA,
      email: 'a@example.com',
      startedAtMs: tBase - 600000,
      endedAtMs: tBase + 6000000
    }];

    // 1. 模拟升级前已堆积 12 份旧版本 .bak-pre-elv89-* 备份
    collector.savePricingLedger({
      version: 1,
      calls: {
        call_old_1: {
          callId: 'call_old_1',
          source: 'desktop',
          model: 'gemini-4-hydrogen',
          inputTokens: 1000,
          outputTokens: 200,
          totalTokens: 1200,
          date: '2026-11-18',
          created_at: new Date(tBase).toISOString(),
          accountScopeKey: scopeA
        },
        call_recent_live: {
          callId: 'call_recent_live',
          source: 'desktop',
          model: 'gemini-4-hydrogen',
          inputTokens: 500,
          outputTokens: 100,
          totalTokens: 600,
          date: '2026-11-19',
          created_at: new Date(Date.now() - 10000).toISOString(),
          liveObservedAtMs: Date.now() - 10000,
          accountScopeKey: scopeA,
          accountAttributionConfidence: 'live_confirmed_account'
        }
      }
    }, ledgerPath);

    for (let i = 1; i <= 12; i++) {
      fs.writeFileSync(
        path.join(agDir, `pricing_ledger_v1.json.bak-pre-elv89-${1795000000000 + i * 1000}`),
        `{"legacy":${i}}`
      );
    }
    assert.equal(countBackups().length, 12);

    // 升级清理只保留最新 1 份
    const upgRes = collector.cleanupUpgradeLedgerBackups({ ledgerPath, stateDir, keep: 1 });
    assert.equal(upgRes.ok, true);
    assert.equal(upgRes.removedCount, 11);
    assert.deepEqual(countBackups(), ['pricing_ledger_v1.json.bak-pre-elv89-1795000012000']);

    // 2. 首次有内容变化的纠偏触发 1 份备份，随后连续 100 次幂等运行（含 live_confirmed_account 未满 3 分钟的场景）均不得新增任何备份
    const firstRepair = collector.repairAndMigrateAccountLedger({ ledgerPath, accountSessions, stateDir, backupSuffix: '1795000020000' });
    assert.equal(firstRepair.ok, true);
    assert.equal(firstRepair.changed, true);
    assert.ok(firstRepair.backupPath && fs.existsSync(firstRepair.backupPath));
    const afterFirstCount = countBackups().length;
    assert.equal(afterFirstCount, 2);

    for (let i = 0; i < 100; i++) {
      const rep = collector.repairAndMigrateAccountLedger({
        ledgerPath,
        accountSessions,
        stateDir,
        force: i % 10 === 0,
        backupSuffix: `179500003${String(i).padStart(4, '0')}`
      });
      assert.equal(rep.ok, true);
      assert.equal(rep.changed, false);
      assert.equal(rep.backupPath, null);
    }
    assert.equal(countBackups().length, afterFirstCount, '幂等运行 100 次后备份数量不得增长');

    // 3. 当账本内容确实发生变化并触发多次新备份时，同一账本最多保留最近 N=3 份
    for (let round = 1; round <= 5; round++) {
      const curLedger = collector.loadPricingLedger(ledgerPath);
      curLedger.calls[`call_mut_${round}`] = {
        callId: `call_mut_${round}`,
        source: 'desktop',
        model: 'gemini-4-hydrogen',
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        date: '2026-11-18',
        created_at: new Date(tBase + round * 1000).toISOString(),
        accountScopeKey: scopeA
      };
      collector.savePricingLedger(curLedger, ledgerPath);
      const r = collector.repairAndMigrateAccountLedger({
        ledgerPath,
        accountSessions,
        stateDir,
        backupSuffix: `${1795000100000 + round * 1000}`
      });
      assert.equal(r.ok, true);
      assert.equal(r.changed, true);
      assert.ok(r.backupPath);
      assert.ok(countBackups().length <= collector.MAX_LEDGER_REPAIR_BACKUPS, `备份数必须 <= ${collector.MAX_LEDGER_REPAIR_BACKUPS}`);
    }
    assert.deepEqual(
      countBackups().sort(),
      [
        'pricing_ledger_v1.json.bak-pre-elv89-1795000103000',
        'pricing_ledger_v1.json.bak-pre-elv89-1795000104000',
        'pricing_ledger_v1.json.bak-pre-elv89-1795000105000'
      ]
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('CloudCode 配额拉取回归: 默认优先 daily、失败回退 prod、UA 对齐 2.33.0、过滤内部杂项池 (chat_23310 / chat_20706 / tab / gemini-2.5-pro)', async () => {
  const requestedUrls = [];
  const requestedUas = [];
  let dailyFailed = false;

  const mockFetch = async (url, init = {}) => {
    const u = String(url);
    requestedUrls.push(u);
    const ua = init.headers?.['User-Agent'] || '';
    if (ua) requestedUas.push(ua);

    if (u.includes('daily-cloudcode-pa.googleapis.com')) {
      dailyFailed = true;
      // 模拟 daily 端点故障 (HTTP 503)，触发回退至 prod
      return {
        ok: false,
        status: 503,
        text: async () => JSON.stringify({ error: { message: 'daily temporarily unavailable' } })
      };
    }

    if (u.includes('loadCodeAssist')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          cloudaicompanionProject: 'test-proj-fallback',
          currentTier: { id: 'g1-pro-tier' }
        })
      };
    }

    if (u.includes('fetchAvailableModels')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          agentModelSorts: ['gemini-4-hydrogen', 'gemini-4-argon', 'claude-3-7-sonnet'],
          models: {
            'gemini-4-hydrogen': { displayName: 'Gemini 4 Hydrogen', quotaInfo: { remainingFraction: 0.90 } },
            'gemini-4-argon': { displayName: 'Gemini 4 Argon', quotaInfo: { remainingFraction: 0.80 } },
            'claude-3-7-sonnet': { displayName: 'Claude 3.7 Sonnet', model: 'claude-sonnet-5-5', quotaInfo: { remainingFraction: 0.85 } },
            'chat_23310': { displayName: 'Internal Chat 23310', quotaInfo: { remainingFraction: 1.0 } },
            'chat_20706': { displayName: 'Internal Chat 20706', isInternal: true, quotaInfo: { remainingFraction: 1.0 } },
            'tab_flash_lite_preview': { displayName: 'Tab Flash Lite', quotaInfo: { remainingFraction: 1.0 } },
            'gemini-2.5-pro': { displayName: 'Gemini 2.5 Pro', quotaInfo: { remainingFraction: 1.0 } }
          }
        })
      };
    }

    if (u.includes('retrieveUserQuotaSummary')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          response: {
            groups: [
              {
                groupId: 'hydrogen-group',
                displayName: 'Gemini 4 Hydrogen',
                buckets: [
                  { bucketId: 'b5h', window: '5h', remainingFraction: 0.90 },
                  { bucketId: 'b7d', window: 'weekly', remainingFraction: 0.95 }
                ]
              },
              {
                groupId: 'argon-group',
                displayName: 'Gemini 4 Argon',
                buckets: [
                  { bucketId: 'barg', window: 'weekly', remainingFraction: 0.80 }
                ]
              }
            ]
          }
        })
      };
    }

    return { ok: true, status: 200, text: async () => '{}' };
  };

  const quotaRes = await accountsMod.fetchAccountQuotaViaCloudCode('mock-access-token', {
    fetch: mockFetch,
    email: 'fallback-test@example.com'
  });

  // 1. 验证 daily 优先请求并成功触发回退 prod
  assert.equal(dailyFailed, true, '必须优先尝试 daily 端点');
  assert.ok(requestedUrls.some(u => u.includes('daily-cloudcode-pa.googleapis.com')));
  assert.ok(requestedUrls.some(u => u.includes('cloudcode-pa.googleapis.com')));
  // 2. 验证 User-Agent 对齐 2.33.0
  assert.ok(requestedUas.length > 0);
  assert.ok(requestedUas.every(ua => ua.startsWith('antigravity/2.33.0')));

  // 3. 验证杂项池严格过滤，仅保留四大核心共享池
  const poolKeys = quotaRes.snapshot.pools.map(p => p.poolKey);
  assert.ok(poolKeys.includes('shared_gemini_main'));
  assert.ok(poolKeys.includes('shared_gemini_argon'));
  assert.doesNotMatch(poolKeys.join(' '), /shared_chat_23310|shared_chat_20706|shared_gemini-25-pro|shared_tab/);

  // 4. 验证直接向 buildModelQuotaSnapshot 传入含杂项 models 也不会生成独立杂项池
  const directSnap = core.buildModelQuotaSnapshot({
    cascadeModelConfigs: [
      { modelId: 'gemini-4-hydrogen', label: 'Gemini 4 Hydrogen', quotaInfo: { remainingFraction: 0.9 } },
      { modelId: 'chat_23310', label: 'chat_23310', quotaInfo: { remainingFraction: 1.0 } },
      { modelId: 'chat_20706', isInternal: true, label: 'chat_20706', quotaInfo: { remainingFraction: 1.0 } },
      { modelId: 'tab_flash_lite_preview', label: 'tab_flash_lite_preview', quotaInfo: { remainingFraction: 1.0 } },
      { modelId: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', quotaInfo: { remainingFraction: 1.0 } }
    ],
    userStatusRes: null,
    quotaSummaryRes: null
  });
  const directPoolKeys = directSnap.pools.map(p => p.poolKey);
  assert.deepEqual(directPoolKeys, ['shared_gemini_main']);
});

test('OAuth 权限作用域: ANTIGRAVITY_OAUTH_SCOPES 包含 aicode 权限作用域', () => {
  assert.ok(Array.isArray(accountsMod.ANTIGRAVITY_OAUTH_SCOPES));
  assert.ok(
    accountsMod.ANTIGRAVITY_OAUTH_SCOPES.includes('https://www.googleapis.com/auth/aicode'),
    '必须包含 aicode 权限作用域以防止模型降级与配额返回旧模型'
  );
});
