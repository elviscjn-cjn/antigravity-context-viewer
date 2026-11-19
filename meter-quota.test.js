const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const core = require('./meter-core');
const collector = require('./meter-collector');
const { generateMeterPreloadCode } = require('./modular-installer');
const { connect: connectLocalApi } = require('./local-api');

test('本地额度连接支持无 APPDATA 的 macOS、Windows 和 Linux 配置路径', () => {
  const homeDir = '/temporary-home';
  const { execFileSync } = require('child_process');
  const result = execFileSync(process.execPath, ['-e', `
    const { getAppDataDir } = require('./asar-engine');
    const homeDir = ${JSON.stringify(homeDir)};
    process.stdout.write(JSON.stringify(
      ['darwin', 'win32', 'linux'].map(platform => getAppDataDir({ platform, homeDir }))
    ));
  `], { cwd: __dirname, env: { ...process.env, APPDATA: '', XDG_CONFIG_HOME: '' }, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(result), [
    path.join(homeDir, 'Library', 'Application Support'),
    path.join(homeDir, 'AppData', 'Roaming'),
    path.join(homeDir, '.config')
  ]);
});

test('macOS 本地连接发现 HTTP 窗口并使用宿主 CSRF 信息调用额度接口', async (t) => {
  const os = require('os');
  const http = require('http');
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-quota-mac-'));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  let origin;
  let receivedRpc = false;
  const server = http.createServer((req, res) => {
    if (req.url === '/json/list') {
      res.end(JSON.stringify([
        { type: 'page', url: 'https://example.com/' },
        { type: 'page', url: origin + '/c/test-conversation' }
      ]));
    } else if (req.url === '/') {
      res.end('<script>window.__APP_CONFIG__ = {"csrfToken":"fixture-token"};</script>');
    } else {
      receivedRpc = req.method === 'POST'
        && req.headers['x-codeium-csrf-token'] === 'fixture-token'
        && req.url.endsWith('/GetUserStatus');
      res.end(JSON.stringify({ userStatus: { ready: true } }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  origin = `http://127.0.0.1:${server.address().port}`;
  const options = { appDataDir: path.join(homeDir, 'Library', 'Application Support') };
  const portFile = path.join(options.appDataDir, 'Antigravity', 'DevToolsActivePort');
  fs.mkdirSync(path.dirname(portFile), { recursive: true });
  fs.writeFileSync(portFile, `${server.address().port}\n/devtools/browser/fixture\n`);
  const api = await connectLocalApi(options);
  assert.equal(api.origin, origin);
  assert.deepEqual(await api.call('GetUserStatus', {}), { userStatus: { ready: true } });
  assert.equal(receivedRpc, true);
});

test('缺少本地连接文件时显示可读提示，不泄露文件路径或误报额度耗尽', async (t) => {
  const homeDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'ag-quota-missing-'));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  await assert.rejects(connectLocalApi({ appDataDir: homeDir }),
    error => /尚未就绪/.test(error.message) && !/ENOENT|DevToolsActivePort|undefined/.test(error.message));
  const result = await collector.fetchQuotaSnapshotFromHost({
    error: new Error("ENOENT: no such file or directory, open 'undefined/Antigravity/DevToolsActivePort'")
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /尚未就绪/);
  assert.doesNotMatch(result.error, /ENOENT|DevToolsActivePort|undefined/);
  assert.notEqual(result.snapshot.activeStatus, 'exhausted');
});

const RENDERER_PATH = path.join(__dirname, 'meter-renderer.js');

function buildRealistic2321Fixtures(nowIso = '2026-11-15T00:44:00Z', future5hIso = '2026-11-15T05:00:00Z', futureWeekIso = '2026-11-18T22:00:00Z', argonResetIso = '2026-11-21T11:48:00Z') {
  const userStatusRes = {
    userStatus: {
      email: 'alice.test@example.com',
      userTier: { id: 'g1-pro-tier', name: 'Google AI Pro', description: 'Google AI Pro' },
      planStatus: { planInfo: { teamsTier: 'TEAMS_TIER_PRO', planName: 'Pro' } },
      cascadeModelConfigData: {
        clientModelConfigs: [
          { label: 'Gemini 4 Hydrogen (Low)', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M26' }, quotaInfo: { remainingFraction: 0.4858, resetTime: future5hIso } },
          { label: 'Gemini 4 Hydrogen (Medium)', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M27' }, quotaInfo: { remainingFraction: 0.4858, resetTime: future5hIso } },
          { label: 'Gemini 4 Hydrogen (High)', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M28' }, quotaInfo: { remainingFraction: 0.4858, resetTime: future5hIso } },
          { label: 'Gemini 4 Hydrogen (XHigh)', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M29' }, quotaInfo: { remainingFraction: 0.4858, resetTime: future5hIso } },
          { label: 'Gemini 3.8 Flash (Low)', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M37' }, quotaInfo: { remainingFraction: 0.4858, resetTime: future5hIso } },
          { label: 'Gemini 3.8 Flash (Medium)', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M38' }, quotaInfo: { remainingFraction: 0.4858, resetTime: future5hIso } },
          { label: 'Gemini 3.8 Flash (High)', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M39' }, quotaInfo: { remainingFraction: 0.4858, resetTime: future5hIso } },
          { label: 'Claude Opus 5.5 (Low)', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M40' }, quotaInfo: { remainingFraction: 0.0013412, resetTime: futureWeekIso } },
          { label: 'Claude Opus 5.5 (High)', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M41' }, quotaInfo: { remainingFraction: 0.0013412, resetTime: futureWeekIso } },
          { label: 'Claude Sonnet 5.5 (Medium)', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M42' }, quotaInfo: { remainingFraction: 0.0013412, resetTime: futureWeekIso } },
          {
            label: 'GPT-OSS 120B (Medium)',
            modelOrAlias: { model: 'MODEL_OPENAI_GPT_OSS_120B_MEDIUM' },
            tagTitle: 'Notice',
            tagDescription: 'GPT-OSS will be removed from Antigravity on November 18, 2026.',
            quotaInfo: { remainingFraction: 0.0013412, resetTime: futureWeekIso }
          },
          { label: 'Gemini 4 Argon (Medium)', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M66' }, quotaInfo: { remainingFraction: 0.8679991, resetTime: argonResetIso } },
          { label: 'Orchestrator (Argon)', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M668' }, modelId: 'gemini-pro-orchestrator-g1-pro', quotaInfo: { remainingFraction: 0.8679991, resetTime: argonResetIso } },
          {
            label: 'Gemini 4 Carbon',
            modelId: 'gemini-4-carbon-disabled',
            modelOrAlias: { model: 'MODEL_PLACEHOLDER_M670' },
            disabled: true,
            tagTitle: 'Unavailable',
            tagDescription: 'Gemini 4 Carbon is currently available to Ultra plan subscribers.',
            quotaInfo: {}
          }
        ]
      }
    }
  };

  const quotaSummaryRes = {
    response: {
      groups: [
        {
          groupId: 'gemini',
          displayName: 'Gemini Pro & Flash',
          description: 'Models within this group: Gemini 4 Hydrogen, Gemini 3.8 Flash',
          buckets: [
            { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.45065, resetTime: future5hIso },
            { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.92, resetTime: futureWeekIso }
          ]
        },
        {
          groupId: '3p',
          displayName: 'Claude / GPT-OSS',
          description: 'Models within this group: Claude Opus 5.5, Claude Sonnet 5.5, GPT-OSS 120B',
          buckets: [
            { bucketId: '3p-weekly', window: 'weekly', remainingFraction: 0.0013412, resetTime: futureWeekIso },
            { bucketId: '3p-5h', window: '5h', remainingFraction: 0.0416416, resetTime: future5hIso }
          ]
        },
        {
          groupId: 'gemini_argon',
          displayName: 'Gemini 4 Argon',
          description: 'For paid Pro plans, Argon quota is separate from your Gemini weekly pool.',
          buckets: [
            { bucketId: 'gemini-argon-wtu-weekly', window: 'weekly', remainingFraction: 0.8679991, resetTime: argonResetIso }
          ]
        }
      ]
    }
  };

  return { nowMs: Date.parse(nowIso), userStatusRes, quotaSummaryRes };
}

function createQuotaRendererHarness(opts = {}) {
  const rendererSrc = fs.readFileSync(RENDERER_PATH, 'utf8');
  const elements = new Map();
  const listeners = new Map();
  const scheduledTimeouts = [];
  const clearedTimeouts = [];
  const intervals = [];
  const storageMap = new Map();
  const rafQueue = [];
  const canceledRafs = new Set();
  let nextTimeoutId = 1;
  let nextIntervalId = 1;
  let nextRafId = 1;
  let fakeNowMs = Number.isFinite(Number(opts.startPerfMs)) ? Number(opts.startPerfMs) : 1000;

  const rectsById = opts.rectsById || {};

  const makeEl = () => {
    const attrs = new Map();
    const props = new Map();
    const el = {
      style: {
        display: '',
        width: '',
        setProperty(k, v) { props.set(k, String(v)); },
        removeProperty(k) { props.delete(k); },
        getPropertyValue(k) { return props.get(k) || ''; }
      },
      children: [],
      hidden: false,
      disabled: false,
      textContent: '',
      title: '',
      get id() { return attrs.get('id') || ''; },
      set id(v) { attrs.set('id', String(v)); },
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
      setAttribute(k, v) { attrs.set(k, String(v)); },
      getAttribute(k) { return attrs.get(k) ?? null; },
      removeAttribute(k) { attrs.delete(k); },
      addEventListener(type, fn) {
        if (!listeners.has(el)) listeners.set(el, new Map());
        listeners.get(el).set(type, fn);
      },
      appendChild(child) {
        if (child) {
          child.parentElement = this;
          this.children.push(child);
        }
        return child;
      },
      insertBefore(node, refNode) {
        if (!node) return node;
        const idx = this.children.indexOf(node);
        if (idx >= 0) this.children.splice(idx, 1);
        node.parentElement = this;
        if (!refNode) {
          this.children.push(node);
        } else {
          const refIdx = this.children.indexOf(refNode);
          if (refIdx >= 0) this.children.splice(refIdx, 0, node);
          else this.children.push(node);
        }
        return node;
      },
      removeChild(child) {
        const idx = this.children.indexOf(child);
        if (idx >= 0) this.children.splice(idx, 1);
        return child;
      },
      replaceChildren(...nodes) { this.children = [...nodes]; },
      querySelectorAll() { return []; },
      remove() { },
      focus() { },
      click() { listeners.get(el)?.get('click')?.(); },
      getBoundingClientRect() {
        const myId = attrs.get('id') || '';
        if (myId && rectsById[myId]) return rectsById[myId];
        return { left: 100, top: 20, width: 80, height: 24, right: 180, bottom: 44 };
      }
    };
    return el;
  };

  const host = makeEl();
  host.getBoundingClientRect = () => rectsById.host || { left: 700, top: 6, width: 320, height: 28, right: 1020, bottom: 34 };
  host.attachShadow = () => ({
    set innerHTML(_v) { },
    getElementById(id) {
      if (!elements.has(id)) {
        const created = makeEl();
        created.id = id;
        elements.set(id, created);
      }
      return elements.get(id);
    },
    querySelectorAll() { return []; }
  });

  const quotaRequests = [];
  let first = true;
  const sandbox = {
    location: { protocol: 'https:', hostname: '127.0.0.1', pathname: '/c/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' },
    document: {
      body: opts.hostBgColor ? { style: {}, classList: { contains: () => false }, appendChild() { } } : undefined,
      createElement: () => {
        if (first) { first = false; return host; }
        return makeEl();
      },
      getElementById: () => null,
      documentElement: { appendChild() { } },
      addEventListener() { },
      removeEventListener() { },
      hidden: false
    },
    window: {
      __APP_CONFIG__: { csrfToken: 'test' },
      innerWidth: Number.isFinite(Number(opts.innerWidth)) ? Number(opts.innerWidth) : 1280,
      innerHeight: Number.isFinite(Number(opts.innerHeight)) ? Number(opts.innerHeight) : 800,
      getComputedStyle: opts.hostBgColor ? () => ({
        backgroundColor: opts.hostBgColor,
        getPropertyValue: k => (k === '--background' ? opts.hostBgColor : '')
      }) : undefined,
      matchMedia: q => ({ matches: Boolean(opts.reducedMotion && String(q).includes('prefers-reduced-motion')) }),
      contextMeterAPI: {
        scan: () => new Promise(() => { }),
        getQuota: opts => new Promise(resolve => quotaRequests.push({ opts, resolve }))
      }
    },
    localStorage: {
      getItem: k => storageMap.get(String(k)) ?? null,
      setItem: (k, v) => { storageMap.set(String(k), String(v)); },
      removeItem: k => { storageMap.delete(String(k)); }
    },
    performance: { now: () => fakeNowMs },
    requestAnimationFrame: fn => {
      const id = nextRafId++;
      rafQueue.push({ id, fn });
      return id;
    },
    cancelAnimationFrame: id => {
      canceledRafs.add(id);
    },
    __AGContextMeterCore: core,
    AbortController,
    Date,
    setTimeout(fn, ms) {
      const id = nextTimeoutId++;
      const callerFrame = ((new Error().stack || '').split('\n')[2]) || '';
      scheduledTimeouts.push({ id, fn, ms, cleared: false, isQuota: /scheduleQuota/i.test(callerFrame) });
      return id;
    },
    clearTimeout(id) {
      clearedTimeouts.push(id);
      const item = scheduledTimeouts.find(t => t.id === id);
      if (item) item.cleared = true;
    },
    setInterval(fn) {
      const id = nextIntervalId++;
      intervals.push({ id, fn, cleared: false });
      return id;
    },
    clearInterval(id) {
      const item = intervals.find(t => t.id === id);
      if (item) item.cleared = true;
    },
    fetch: () => new Promise(() => { })
  };

  vm.createContext(sandbox);
  vm.runInContext(rendererSrc, sandbox);
  return {
    sandbox,
    host,
    elements,
    quotaRequests,
    scheduledTimeouts,
    clearedTimeouts,
    intervals,
    storageMap,
    canceledRafs,
    getActiveRafCount: () => rafQueue.filter(r => !canceledRafs.has(r.id)).length,
    stepRaf(advanceMs) {
      fakeNowMs += advanceMs;
      const cur = rafQueue.splice(0, rafQueue.length);
      for (const item of cur) {
        if (!canceledRafs.has(item.id)) item.fn(fakeNowMs);
      }
    },
    flush: () => new Promise(resolve => setImmediate(resolve))
  };
}

test('2.32.1 真实载荷：共享池归组、多档位折叠、极小非零精度保留、Notice 与无权限严格区分', () => {
  const { nowMs, userStatusRes, quotaSummaryRes } = buildRealistic2321Fixtures();
  const snap = core.buildModelQuotaSnapshot({
    userStatusRes,
    quotaSummaryRes,
    currentModel: 'MODEL_PLACEHOLDER_M38', // Gemini 3.8 Flash (Medium)
    fetchMeta: { fetchedAtMs: nowMs },
    nowMs
  });

  // 应折叠出 4 个共享池组，而非把 14 个档位/配置拆成 14 行
  assert.equal(snap.pools.length, 4);

  // 1. Gemini Main 共享池合并 Hydrogen (Low/Med/High/XHigh) 与 Flash (Low/Med/High)
  const mainPool = snap.pools.find(p => p.poolKey === 'shared_gemini_main');
  assert.ok(mainPool);
  assert.equal(mainPool.models.length, 2);
  const hydrogen = mainPool.models.find(m => m.productLabel.includes('Hydrogen'));
  assert.deepEqual(hydrogen.efforts, ['Low', 'Medium', 'High', 'XHigh']);
  assert.equal(mainPool.buckets.length, 2);
  // 取更紧的 5h (45.065%) 作为主限制 -> 45%
  assert.equal(mainPool.percentText, '45%');
  assert.equal(snap.activeStatus, 'available');
  assert.equal(snap.badge.text, '45%');
  assert.equal(snap.badge.tag, '5h');

  // 2. 第三方 3p 共享池包含 Claude Opus 5.5 + Sonnet 5.5 + GPT-OSS 120B
  // 其中 remainingFraction = 0.0013412 (0.134%) 绝不可四舍五入为 0% 误判耗尽
  const pool3p = snap.pools.find(p => p.poolKey === 'shared_3p_pool');
  assert.ok(pool3p);
  assert.equal(pool3p.isExhausted, false);
  assert.equal(pool3p.percentText, '0.1%');
  assert.equal(pool3p.status, 'low');
  const gptOss = pool3p.models.find(m => m.productLabel.includes('GPT-OSS'));
  assert.ok(gptOss);
  assert.equal(gptOss.noPermission, false);
  assert.match(gptOss.noticeText, /removed from Antigravity/i);

  // 3. Orchestrator (Argon) 应准确归入 Argon 池，不误入 Carbon
  const argonPool = snap.pools.find(p => p.poolKey === 'shared_gemini_argon');
  assert.ok(argonPool);
  assert.ok(argonPool.models.some(m => m.productLabel.includes('Orchestrator')));
  assert.equal(argonPool.percentText, '87%');

  // 4. Gemini 4 Carbon (disabled + Unavailable) 应判定权限不足，不误标耗尽
  const carbonPool = snap.pools.find(p => p.poolKey === 'shared_gemini_carbon');
  assert.ok(carbonPool);
  assert.equal(carbonPool.status, 'no_permission');
  assert.equal(carbonPool.isExhausted, false);
  assert.match(carbonPool.unavailabilityReason, /Ultra plan/i);

  // 5. 口径声明存在，且不虚构剩余 Token 总数
  assert.match(snap.basisNote, /不.*换算剩余 Token/);
});

test('Protobuf3 零余额、极小非零精度、未知字段及缺失/过期重置时间边界校验', () => {
  assert.equal(core.formatQuotaPercentText(0), '0%');
  assert.equal(core.formatQuotaPercentText(0.0004), '<0.1%');
  assert.equal(core.formatQuotaPercentText(0.0013412), '0.1%');
  assert.equal(core.formatQuotaPercentText(0.456), '46%');
  assert.equal(core.formatQuotaPercentText(null), '未知');

  // 1. 仅在明确来源为 exa.codeium_common_pb.QuotaInfo (普通 proto3 float + json omitempty) 且含有效 resetTime、未禁用时，才将省略的 remainingFraction 判为 0 耗尽
  const protoZero = core.parseQuotaFraction(
    { resetTime: '2026-11-16T00:00:00Z' },
    { schemaKind: 'codeium_quota_info' }
  );
  assert.equal(protoZero.fraction, 0);
  assert.equal(protoZero.isExhausted, true);
  assert.equal(protoZero.source, 'proto3_zero_with_reset');

  // 2. 未指明消息契约或 QuotaSummaryBucket (oneof remaining { float remaining_fraction; int64 remaining_amount; }) 缺分支时，即便带 resetTime 也绝不可任意推定耗尽，必须显示未知
  const genericMissing = core.parseQuotaFraction({ resetTime: '2026-11-16T00:00:00Z' });
  assert.equal(genericMissing.fraction, null);
  assert.equal(genericMissing.isExhausted, false);
  assert.equal(genericMissing.source, 'missing');

  const bucketMissingOneof = core.parseQuotaFraction(
    { bucketId: '3p-weekly', resetTime: '2026-11-16T00:00:00Z' },
    { schemaKind: 'quota_summary_bucket' }
  );
  assert.equal(bucketMissingOneof.fraction, null);
  assert.equal(bucketMissingOneof.isExhausted, false);
  assert.equal(bucketMissingOneof.source, 'missing');

  // 3. QuotaSummaryBucket 选择 remainingAmount 分支但缺少总额时：正数返回未知而非耗尽；显式 "0"/0 才判耗尽
  const amtPositiveNoTotal = core.parseQuotaFraction(
    { remainingAmount: '15', resetTime: '2026-11-16T00:00:00Z' },
    { schemaKind: 'quota_summary_bucket' }
  );
  assert.equal(amtPositiveNoTotal.fraction, null);
  assert.equal(amtPositiveNoTotal.isExhausted, false);
  assert.equal(amtPositiveNoTotal.source, 'amount_without_total');

  const amtExplicitZero = core.parseQuotaFraction(
    { remainingAmount: '0', resetTime: '2026-11-16T00:00:00Z' },
    { schemaKind: 'quota_summary_bucket' }
  );
  assert.equal(amtExplicitZero.fraction, 0);
  assert.equal(amtExplicitZero.isExhausted, true);
  assert.equal(amtExplicitZero.source, 'amount_zero');

  // 4. 在完整 buildModelQuotaSnapshot 中验证：QuotaSummaryBucket 缺失 remaining 分支 + 存在 resetTime -> 池状态为 unknown（保留 resetTime，不判耗尽）
  const unknownBucketSnap = core.buildModelQuotaSnapshot({
    userStatusRes: { userStatus: { cascadeModelConfigData: { clientModelConfigs: [] } } },
    quotaSummaryRes: {
      response: {
        groups: [
          {
            groupId: '3p',
            displayName: 'Claude and GPT models',
            buckets: [{ bucketId: '3p-weekly', window: 'weekly', resetTime: '2026-11-16T00:00:00Z' }]
          }
        ]
      }
    }
  });
  const unknownPool = unknownBucketSnap.pools.find(p => p.poolKey === 'shared_3p_pool');
  assert.ok(unknownPool);
  assert.equal(unknownPool.status, 'unknown');
  assert.equal(unknownPool.percentText, '未知');
  assert.equal(unknownPool.isExhausted, false);
  assert.equal(unknownPool.hasResetTime, true);

  // 空对象 {} 且非不可用模型 -> 未知（缺失字段）
  const emptyMissing = core.parseQuotaFraction({}, { schemaKind: 'codeium_quota_info' });
  assert.equal(emptyMissing.fraction, null);
  assert.equal(emptyMissing.isExhausted, false);

  // 无可靠重置时间时不伪造倒计时
  const noReset = core.formatQuotaResetMeta(null, 1763136000000);
  assert.equal(noReset.hasResetTime, false);
  assert.equal(noReset.countdownText, null);
  assert.equal(noReset.resetTimeText, null);

  // 已超过重置时间 -> 标为已到重置时间待确认
  const passed = core.formatQuotaResetMeta('2026-11-15T00:00:00Z', Date.parse('2026-11-15T00:05:00Z'));
  assert.equal(passed.isResetPassed, true);
  assert.match(passed.countdownText, /待确认/);
});

test('网络失败与过期状态严格区分，绝不将网络报错标成额度耗尽', async () => {
  collector.resetQuotaHostCacheForTest();

  // 1. 无缓存时网络报错 -> error 状态，非 exhausted
  const errOnly = await collector.fetchQuotaSnapshotFromHost({
    error: new Error('connect ETIMEDOUT 127.0.0.1:58818'),
    nowMs: 1763136000000
  });
  assert.equal(errOnly.ok, false);
  assert.equal(errOnly.errorKind, 'timeout');
  assert.equal(errOnly.snapshot.syncState, 'error');
  assert.equal(errOnly.snapshot.activeStatus, 'error');
  assert.equal(errOnly.snapshot.badge.text, '失败');

  // 2. 先成功一次建立缓存，随后发生网络报错 -> 保留历史数据标 stale，仍不标耗尽
  const { nowMs, userStatusRes, quotaSummaryRes } = buildRealistic2321Fixtures();
  let callCount = 0;
  const okRes = await collector.fetchQuotaSnapshotFromHost({
    connect: async () => ({
      call: async (method) => {
        callCount++;
        return method === 'GetUserStatus' ? userStatusRes : quotaSummaryRes;
      }
    }),
    nowMs
  });
  assert.equal(okRes.ok, true);
  assert.equal(okRes.snapshot.syncState, 'fresh');
  assert.equal(callCount, 2);

  // 同批并发非 force 调用应直接命中短缓存不重复发起 RPC
  const cachedRes = await collector.fetchQuotaSnapshotFromHost({
    connect: async () => { throw new Error('should use cache'); },
    nowMs: nowMs + 2000
  });
  assert.equal(cachedRes.ok, true);
  assert.equal(cachedRes.snapshot.pools.length, 4);

  // force 触发强制刷新遇到连接拒绝 -> 回落 stale 并带出原因
  const failAfterCache = await collector.fetchQuotaSnapshotFromHost({
    force: true,
    connect: async () => ({
      call: async () => { throw new Error('ECONNREFUSED'); }
    }),
    nowMs: nowMs + 20000
  });
  assert.equal(failAfterCache.ok, false);
  assert.equal(failAfterCache.snapshot.syncState, 'stale');
  assert.equal(failAfterCache.snapshot.pools.length, 4);

  // 3. 切换账号 -> 识别 accountSwitched 并清理旧账号缓存
  const accountBStatus = JSON.parse(JSON.stringify(userStatusRes));
  accountBStatus.userStatus.email = 'bob.other@example.com';
  accountBStatus.userStatus.cascadeModelConfigData.clientModelConfigs[4].quotaInfo.remainingFraction = 0.99;
  const switchedRes = await collector.fetchQuotaSnapshotFromHost({
    force: true,
    connect: async () => ({
      call: async (method) => {
        if (method === 'GetUserStatus') return accountBStatus;
        return { response: { groups: [] } };
      }
    }),
    nowMs: nowMs + 30000
  });
  assert.equal(switchedRes.ok, true);
  assert.equal(switchedRes.accountSwitched, true);
  assert.notEqual(switchedRes.accountScopeKey, okRes.accountScopeKey);

  collector.resetQuotaHostCacheForTest();
});

test('渲染器与全链路集成：顶栏入口、三时间分列、切换/浏览模型隔离、切账号清缓存及销毁清理', async () => {
  const h = createQuotaRendererHarness();
  const api = h.sandbox.__AGContextMeter;
  const { nowMs, userStatusRes, quotaSummaryRes } = buildRealistic2321Fixtures();

  // 设置当前会话模型为 Gemini 3.8 Flash (Medium)
  api.setContextLatestForTest(
    { model: 'Gemini 3.8 Flash (Medium)', modelId: 'MODEL_PLACEHOLDER_M38', actual: 12000, budget: 256000 },
    userStatusRes.userStatus.cascadeModelConfigData.clientModelConfigs
  );
  api.setQuotaSnapshotForTest({
    accountScopeKey: 'acct_alice',
    userStatusRes,
    quotaSummaryRes,
    fetchedAtMs: nowMs,
    nextRefreshAtMs: nowMs + 60000
  }, nowMs);

  // 顶栏既有圆环弧度也有文字与窗口标，不单靠颜色
  assert.equal(h.elements.get('badge-quota').getAttribute('data-quota-state'), 'available');
  assert.equal(h.elements.get('quota-badge-val').textContent, '45%');
  assert.equal(h.elements.get('quota-badge-tag').textContent, '5h');
  assert.notEqual(h.elements.get('quota-time-updated').textContent, h.elements.get('quota-time-next').textContent);
  assert.notEqual(h.elements.get('quota-time-updated').textContent, h.elements.get('quota-time-reset').textContent);

  // 切换面板内浏览另一共享池（如 3p 池），不得改变实际会话模型！
  const beforeSess = api.getContextPreferencesState().activeSessionModelKey;
  api.selectQuotaPoolBrowseForTest('shared_3p_pool');
  const afterBrowseSess = api.getContextPreferencesState().activeSessionModelKey;
  assert.equal(afterBrowseSess, beforeSess);
  assert.equal(h.elements.get('quota-badge-val').textContent, '45%');

  // 当前会话切换到 Claude Opus 5.5，顶栏应立即跟随显示 0.1%（非 0% 耗尽），且面板切换到 Carbon 时显示无权限
  api.setContextLatestForTest(
    { model: 'Claude Opus 5.5 (Low)', modelId: 'MODEL_PLACEHOLDER_M40', actual: 15000, budget: 200000 }
  );
  // 用同一 nowMs 重新评估视图确保倒计时对齐
  const claudeView = api.getModelQuotaStateForTest(nowMs).view;
  assert.equal(claudeView.badge.text, '0.1%');
  assert.equal(claudeView.activeStatus, 'low');

  // 切到 Gemini 4 Carbon (disabled) -> 显示无权限
  api.setContextLatestForTest(
    { model: 'Gemini 4 Carbon', modelId: 'MODEL_PLACEHOLDER_M670', actual: 1000, budget: 256000 }
  );
  const carbonView = api.getModelQuotaStateForTest(nowMs).view;
  assert.equal(carbonView.activeStatus, 'no_permission');
  assert.equal(h.elements.get('quota-badge-val').textContent, '无权限');

  // 切到英文语言 -> 状态文字动态切换
  await api.setPanelLanguage('en', { persist: false });
  assert.equal(h.elements.get('quota-badge-val').textContent, 'No Access');
  await api.setPanelLanguage('zh-CN', { persist: false });

  // 打开面板按需触发 1 次同步；先完结在途请求后再测连点刷新严格去重
  api.showQuotaPanelForTest(true);
  assert.equal(h.elements.get('panel-quota').hidden, false);
  if (h.quotaRequests.length > 0) {
    h.quotaRequests[0].resolve({
      ok: true,
      data: {
        ok: true,
        accountScopeKey: 'acct_alice',
        fetchedAtMs: nowMs + 1000,
        lastSuccessAtMs: nowMs + 1000,
        snapshot: core.buildModelQuotaSnapshot({
          userStatusRes,
          quotaSummaryRes,
          currentModel: 'MODEL_PLACEHOLDER_M38',
          fetchMeta: { fetchedAtMs: nowMs + 1000 },
          nowMs: nowMs + 1000
        })
      }
    });
    await h.flush();
  }

  const reqCountBefore = h.quotaRequests.length;
  const p1 = api.refreshQuotaForTest(false);
  const p2 = api.refreshQuotaForTest(false);
  assert.equal(h.quotaRequests.length, reqCountBefore + 1);
  h.quotaRequests[reqCountBefore].resolve({
    ok: true,
    data: {
      ok: true,
      accountScopeKey: 'acct_alice',
      fetchedAtMs: nowMs + 5000,
      lastSuccessAtMs: nowMs + 5000,
      snapshot: core.buildModelQuotaSnapshot({
        userStatusRes,
        quotaSummaryRes,
        currentModel: 'MODEL_PLACEHOLDER_M38',
        fetchMeta: { fetchedAtMs: nowMs + 5000 },
        nowMs: nowMs + 5000
      })
    }
  });
  await Promise.all([p1, p2]);

  // 通过 token-history 模拟账号切换 -> 立即清理旧配额快照并触发新拉取
  const preSwitchReqCount = h.quotaRequests.length;
  api.setTokenHistoryForTest({
    isAccountSwitched: true,
    accountScopeKey: 'acct_bob_new',
    dailyMap: {},
    summary: { grandTotalTokens: 0 }
  });
  assert.equal(api.getModelQuotaStateForTest(nowMs).state.accountScopeKey, 'acct_bob_new');
  assert.ok(h.quotaRequests.length > preSwitchReqCount);

  // 销毁窗口清理全部配额定时器与轮询，且销毁后不再发起任何请求
  const quotaTimersBeforeDispose = h.scheduledTimeouts.filter(t => t.isQuota);
  assert.ok(quotaTimersBeforeDispose.length >= 1);
  api.dispose();
  assert.ok(h.intervals.every(iv => iv.cleared));
  const remainingQuotaTimeouts = h.scheduledTimeouts.filter(t => t.isQuota && !t.cleared);
  assert.equal(remainingQuotaTimeouts.length, 0);
  const countAtDispose = h.quotaRequests.length;
  await api.refreshQuotaForTest(true);
  assert.equal(h.quotaRequests.length, countAtDispose);
});

test('桥接通道与安全边界：preload 暴露 getQuota，main IPC 校验来源，live-host 支持 /quota', () => {
  const preloadCode = generateMeterPreloadCode();
  assert.match(preloadCode, /getQuota:\s*\(opts\)\s*=>\s*electron_1\.ipcRenderer\.invoke\("context-meter:get-quota",\s*opts\)/);

  const mainSrc = fs.readFileSync(path.join(__dirname, 'meter-main.js'), 'utf8');
  assert.match(mainSrc, /ipcMain\.handle\('context-meter:get-quota'/);
  assert.match(mainSrc, /context-meter:get-quota[\s\S]{0,160}isLocalMainFrameSender\(event\)/);

  const liveHostSrc = fs.readFileSync(path.join(__dirname, 'live-host.js'), 'utf8');
  assert.match(liveHostSrc, /'\/quota'/);
  assert.match(liveHostSrc, /req\.url === '\/quota'/);
});

test('顶栏入口顺序、独立弹窗锚点、防底裁切 maxHeight 与 Notice: New 过滤', () => {
  const tpl = fs.readFileSync(path.join(__dirname, 'src/renderer/template.html'), 'utf8');
  const idxQuota = tpl.indexOf('id="badge-quota"');
  const idxBadge = tpl.indexOf('id="badge"');
  const idxSpeed = tpl.indexOf('id="badge-speed"');
  const idxTokens = tpl.indexOf('id="badge-tokens"');
  const idxCli = tpl.indexOf('id="badge-cli"');
  const idxOverflow = tpl.indexOf('id="badge-overflow"');
  assert.ok(idxQuota > 0 && idxQuota < idxBadge, '额度入口必须位于工具组最左侧');
  assert.ok(idxBadge < idxSpeed && idxSpeed < idxTokens && idxTokens < idxCli && idxCli < idxOverflow);
  const betweenBadgeAndSpeed = tpl.slice(idxBadge, idxSpeed);
  assert.equal(betweenBadgeAndSpeed.includes('badge-quota'), false, '上下文与速度必须紧邻，不能被额度入口隔开');
  assert.equal(tpl.includes('id="quota-usage-tip"'), false, 'v0.8.9 精简应移除冗余 quota-usage-tip 占位');
  assert.equal(tpl.includes('id="quota-basis-note"'), false, 'v0.8.9 精简应移除大段 quota-basis-note');
  assert.ok(tpl.includes('id="quota-basis-help"'), '应保留 (?) 悬浮提示按钮替代静态大段说明');

  // 2. 验证纯 New/Beta 装饰角标不触发 Notice: New 占地，而真实警示意图保留
  const availNew = core.classifyModelQuotaAvailability({
    label: 'Gemini 4 Hydrogen',
    tagTitle: 'New',
    quotaInfo: { remainingFraction: 0.78 }
  });
  assert.equal(availNew.noPermission, false);
  assert.equal(availNew.noticeText, null);

  const availNotice = core.classifyModelQuotaAvailability({
    label: 'GPT-OSS 120B',
    tagTitle: 'Notice',
    tagDescription: 'Model deprecated on Nov 18',
    quotaInfo: { remainingFraction: 0.2 }
  });
  assert.equal(availNotice.noticeText, 'Model deprecated on Nov 18');

  // 3. 验证矮窗口 + 锚点分离下动态 maxHeight 防止面板被视口底边截断
  const h = createQuotaRendererHarness({
    innerWidth: 1180,
    innerHeight: 540,
    rectsById: {
      host: { left: 740, top: 6, width: 340, height: 28, right: 1080, bottom: 34 },
      'badge-quota': { left: 740, top: 6, width: 64, height: 28, right: 804, bottom: 38 },
      badge: { left: 806, top: 6, width: 52, height: 28, right: 858, bottom: 38 },
      'badge-speed': { left: 860, top: 6, width: 68, height: 28, right: 928, bottom: 38 },
      'badge-tokens': { left: 930, top: 6, width: 58, height: 28, right: 988, bottom: 38 }
    }
  });
  const api = h.sandbox.__AGContextMeter;
  api.showQuotaPanelForTest(true);
  const pQuota = h.elements.get('panel-quota');
  const pTop = parseInt(pQuota.style.top, 10);
  const pMaxH = parseInt(pQuota.style.maxHeight, 10);
  assert.ok(Number.isFinite(pMaxH) && pTop + pMaxH <= 540 - 14, `面板顶+最大高(${pTop}+${pMaxH})绝不可超出视口`);

  // 点击 speed 与 badge 触发不同的面板锚点，互不串用
  h.elements.get('badge-speed').click();
  const panelLeftFromSpeed = parseInt(h.elements.get('panel').style.left, 10);
  h.elements.get('badge').click(); // close since already open at speed? clicking badge switches anchor and stays open
  const panelLeftFromBadge = parseInt(h.elements.get('panel').style.left, 10);
  assert.notEqual(panelLeftFromSpeed, panelLeftFromBadge, '速度与上下文入口应各自锚定自身按钮右缘');
  assert.notEqual(pQuota.style.left, h.elements.get('panel').style.left, '额度与上下文弹窗锚点必须独立');
  api.dispose();
});

test('刷新交互：原地 DOM 节点复用、不清空归零、220ms 平滑数字与连刷衔接、无变化轻反馈与降动画', async () => {
  const { nowMs, userStatusRes, quotaSummaryRes } = buildRealistic2321Fixtures();
  const h = createQuotaRendererHarness();
  const api = h.sandbox.__AGContextMeter;

  api.setContextLatestForTest(
    { model: 'Gemini 3.8 Flash (Medium)', modelId: 'MODEL_PLACEHOLDER_M38', actual: 10000, budget: 256000 },
    userStatusRes.userStatus.cascadeModelConfigData.clientModelConfigs
  );
  api.setQuotaSnapshotForTest({
    accountScopeKey: 'acct_anim',
    userStatusRes,
    quotaSummaryRes,
    fetchedAtMs: nowMs,
    nextRefreshAtMs: nowMs + 60000
  }, nowMs);
  api.showQuotaPanelForTest(true);
  if (h.quotaRequests.length > 0) {
    h.quotaRequests.shift().resolve({
      ok: true,
      data: {
        ok: true,
        accountScopeKey: 'acct_anim',
        fetchedAtMs: nowMs,
        lastSuccessAtMs: nowMs,
        snapshot: core.buildModelQuotaSnapshot({ userStatusRes, quotaSummaryRes, currentModel: 'MODEL_PLACEHOLDER_M38', fetchMeta: { fetchedAtMs: nowMs }, nowMs })
      }
    });
    await h.flush();
  }

  const listEl = h.elements.get('quota-pools-list');
  assert.ok(listEl.children.length >= 3);
  const firstPoolCardBefore = listEl.children[0];
  const curBucketsBefore = h.elements.get('quota-cur-buckets');
  const firstRowBefore = curBucketsBefore.children[0];
  const fillBefore = firstRowBefore.children[1].children[0];
  assert.equal(fillBefore.style.transform, 'scaleX(0.4506)');
  assert.equal(h.elements.get('quota-badge-val').textContent, '45%');

  // 1. 连点两次手动刷新 -> 严格合并只发 1 次 RPC，且请求中不归零/不删节点
  const reqBefore = h.quotaRequests.length;
  const rp1 = api.refreshQuotaForTest(true, { manual: true });
  const rp2 = api.refreshQuotaForTest(true, { manual: true });
  assert.equal(h.quotaRequests.length, reqBefore + 1);
  assert.equal(h.elements.get('quota-badge-val').textContent, '45%');
  assert.equal(h.elements.get('quota-pools-list').children[0], firstPoolCardBefore);

  // 返回新值 85% (从 45% 变 85%) -> 触发 220ms rAF 平滑数字过渡与 DOM 节点 100% 复用
  const nextSummary = JSON.parse(JSON.stringify(quotaSummaryRes));
  nextSummary.response.groups[0].buckets[0].remainingFraction = 0.85;
  h.quotaRequests[reqBefore].resolve({
    ok: true,
    data: {
      ok: true,
      accountScopeKey: 'acct_anim',
      fetchedAtMs: nowMs + 2000,
      lastSuccessAtMs: nowMs + 2000,
      snapshot: core.buildModelQuotaSnapshot({
        userStatusRes,
        quotaSummaryRes: nextSummary,
        currentModel: 'MODEL_PLACEHOLDER_M38',
        fetchMeta: { fetchedAtMs: nowMs + 2000 },
        nowMs: nowMs + 2000
      })
    }
  });
  await Promise.all([rp1, rp2]);

  assert.equal(listEl.children[0], firstPoolCardBefore, '刷新后必须复用同一个池卡片 DOM 节点，不得 rebuild');
  assert.equal(curBucketsBefore.children[0], firstRowBefore, '刷新后必须复用同一个窗口行 DOM 节点');
  assert.equal(fillBefore.style.transform, 'scaleX(0.8500)');

  // rAF 中途 (110ms) 处于 45% 和 85% 之间的中间数值，绝不从 0 重播
  h.stepRaf(110);
  const midPct = parseInt(h.elements.get('quota-badge-val').textContent, 10);
  assert.ok(midPct > 45 && midPct < 85, `平滑动画中点应落在 (45, 85)，实际为 ${midPct}%`);

  // 连续触发第二次手动刷新并回落到 60% -> 从当前 midPct 无缝过渡到 60%
  const nextSummary2 = JSON.parse(JSON.stringify(quotaSummaryRes));
  nextSummary2.response.groups[0].buckets[0].remainingFraction = 0.6;
  const rp3 = api.refreshQuotaForTest(true, { manual: true });
  h.quotaRequests[h.quotaRequests.length - 1].resolve({
    ok: true,
    data: {
      ok: true,
      accountScopeKey: 'acct_anim',
      fetchedAtMs: nowMs + 3000,
      lastSuccessAtMs: nowMs + 3000,
      snapshot: core.buildModelQuotaSnapshot({
        userStatusRes,
        quotaSummaryRes: nextSummary2,
        currentModel: 'MODEL_PLACEHOLDER_M38',
        fetchMeta: { fetchedAtMs: nowMs + 3000 },
        nowMs: nowMs + 3000
      })
    }
  });
  await rp3;
  // 跑完 220ms 收官精准落到 60%
  h.stepRaf(230);
  assert.equal(h.elements.get('quota-badge-val').textContent, '60%');

  // 2. 手动刷新返回完全一致的数据 -> 不触发数字动画，展示轻量 "已更新" 提示
  const rp4 = api.refreshQuotaForTest(true, { manual: true });
  h.quotaRequests[h.quotaRequests.length - 1].resolve({
    ok: true,
    data: {
      ok: true,
      accountScopeKey: 'acct_anim',
      fetchedAtMs: nowMs + 6000,
      lastSuccessAtMs: nowMs + 6000,
      snapshot: core.buildModelQuotaSnapshot({
        userStatusRes,
        quotaSummaryRes: nextSummary2,
        currentModel: 'MODEL_PLACEHOLDER_M38',
        fetchMeta: { fetchedAtMs: nowMs + 6000 },
        nowMs: nowMs + 6000
      })
    }
  });
  await rp4;
  assert.equal(h.getActiveRafCount(), 0, '数据无变更不应重播 rAF 动画');
  assert.equal(h.elements.get('quota-refresh-feedback').hidden, false);
  assert.equal(h.elements.get('quota-refresh-feedback').textContent, '已更新');

  // 3. 刷新失败保留已有数据与进度条，不归零
  const rpErr = api.refreshQuotaForTest(true, { manual: true });
  h.quotaRequests[h.quotaRequests.length - 1].resolve({
    ok: true,
    data: { ok: false, error: 'timeout', errorKind: 'network' }
  });
  await rpErr;
  assert.equal(fillBefore.style.transform, 'scaleX(0.6000)');
  assert.equal(h.elements.get('quota-banner').hidden, false);

  api.dispose();
  assert.equal(h.getActiveRafCount(), 0, 'dispose 后所有 rAF 必须清理');

  // 4. prefers-reduced-motion 降动画模式直接到位，不产生 rAF
  const hReduced = createQuotaRendererHarness({ reducedMotion: true });
  const apiR = hReduced.sandbox.__AGContextMeter;
  apiR.setContextLatestForTest(
    { model: 'Gemini 3.8 Flash (Medium)', modelId: 'MODEL_PLACEHOLDER_M38', actual: 10000, budget: 256000 },
    userStatusRes.userStatus.cascadeModelConfigData.clientModelConfigs
  );
  apiR.setQuotaSnapshotForTest({
    accountScopeKey: 'acct_rm',
    userStatusRes,
    quotaSummaryRes,
    fetchedAtMs: nowMs,
    nextRefreshAtMs: nowMs + 60000
  }, nowMs);
  const rmReq = apiR.refreshQuotaForTest(true, { manual: true });
  hReduced.quotaRequests[hReduced.quotaRequests.length - 1].resolve({
    ok: true,
    data: {
      ok: true,
      accountScopeKey: 'acct_rm',
      fetchedAtMs: nowMs + 2000,
      lastSuccessAtMs: nowMs + 2000,
      snapshot: core.buildModelQuotaSnapshot({ userStatusRes, quotaSummaryRes: nextSummary, currentModel: 'MODEL_PLACEHOLDER_M38', fetchMeta: { fetchedAtMs: nowMs + 2000 }, nowMs: nowMs + 2000 })
    }
  });
  await rmReq;
  assert.equal(hReduced.getActiveRafCount(), 0);
  assert.equal(hReduced.elements.get('quota-badge-val').textContent, '85%');
  apiR.dispose();
});

test('约剩余 Token 估算：5h/weekly 独立校准、相邻差值收敛、多设备失真拦截、重置回跳与账号隔离', async () => {
  const { nowMs, userStatusRes, quotaSummaryRes } = buildRealistic2321Fixtures();
  const baseSnap = core.buildModelQuotaSnapshot({
    userStatusRes,
    quotaSummaryRes,
    currentModel: 'MODEL_PLACEHOLDER_M40',
    fetchMeta: { fetchedAtMs: nowMs },
    nowMs
  });

  // 1. 无本周期实耗样本时绝不伪造“约剩余 Token”
  const noUsageOut = core.applyQuotaTokenEstimates(baseSnap, {
    accountScopeKey: 'acct_est_1',
    usageEvents: [],
    calibrationMap: {},
    nowMs
  });
  const poolGeminiNoUsage = noUsageOut.snapshot.pools.find(p => p.poolKey === 'shared_gemini_main');
  assert.equal(poolGeminiNoUsage.buckets[0].tokenEstimate.estRemainingTokens, null);
  assert.equal(poolGeminiNoUsage.buckets[1].tokenEstimate.estRemainingTokens, null);

  // 2. 同周期内 5h 与 weekly 分别校准与估算（无前置 cycle 样本 -> delta 差值法精准校准：掉 20% 对应 200K -> 1M）
  const s1Summary = JSON.parse(JSON.stringify(quotaSummaryRes));
  s1Summary.response.groups[0].buckets[0].remainingFraction = 0.80; // 5h: 80%
  s1Summary.response.groups[0].buckets[1].remainingFraction = 0.90; // weekly: 90%
  const snap1 = core.buildModelQuotaSnapshot({ userStatusRes, quotaSummaryRes: s1Summary, fetchMeta: { fetchedAtMs: nowMs + 1000 }, nowMs: nowMs + 1000 });
  const r1 = core.applyQuotaTokenEstimates(snap1, { accountScopeKey: 'acct_est_1', usageEvents: [], calibrationMap: {}, nowMs: nowMs + 1000 });

  // 接着 5h 从 80% 降到 60%（deltaF=0.20，本地增耗 200,000），weekly 从 90% 降到 85%（deltaF=0.05，本地增耗 200,000 -> weekly 总容量推算为 4M）
  const s2Summary = JSON.parse(JSON.stringify(quotaSummaryRes));
  s2Summary.response.groups[0].buckets[0].remainingFraction = 0.60;
  s2Summary.response.groups[0].buckets[1].remainingFraction = 0.85;
  const snap2 = core.buildModelQuotaSnapshot({ userStatusRes, quotaSummaryRes: s2Summary, fetchMeta: { fetchedAtMs: nowMs + 60000 }, nowMs: nowMs + 60000 });
  const events2 = [
    { poolKey: 'gemini-4-hydrogen', sharedGroupKey: 'shared_gemini_main', ts: nowMs + 30000, totalTokens: 200000 }
  ];
  const r2 = core.applyQuotaTokenEstimates(snap2, {
    accountScopeKey: 'acct_est_1',
    usageEvents: events2,
    calibrationMap: r1.nextCalibrationMap,
    nowMs: nowMs + 60000
  });
  const gemPool2 = r2.snapshot.pools.find(p => p.poolKey === 'shared_gemini_main');
  const b5h = gemPool2.buckets.find(b => b.windowKey === '5h');
  const bWeek = gemPool2.buckets.find(b => b.windowKey === 'weekly');
  assert.equal(b5h.tokenEstimate.estSource, 'delta');
  assert.equal(b5h.tokenEstimate.estTotalTokens, 1000000);
  assert.equal(b5h.tokenEstimate.estRemainingTokens, 600000);
  assert.equal(bWeek.tokenEstimate.estSource, 'delta');
  assert.equal(bWeek.tokenEstimate.estTotalTokens, 4000000);
  assert.equal(bWeek.tokenEstimate.estRemainingTokens, 3400000);

  // 3. 多设备未记录外耗防御：另一设备打掉了 60% 额度，本地几乎无消耗（50 tokens）-> 拒绝产出虚假小容量
  const multiDevSnap = core.buildModelQuotaSnapshot({
    userStatusRes,
    quotaSummaryRes: {
      response: {
        groups: [{
          groupId: '3p',
          displayName: 'Claude / GPT-OSS',
          buckets: [{ bucketId: '3p-5h', window: '5h', remainingFraction: 0.40, resetTime: '2026-11-15T05:00:00Z' }]
        }]
      }
    },
    fetchMeta: { fetchedAtMs: nowMs + 65000 },
    nowMs: nowMs + 65000
  });
  const rMulti = core.applyQuotaTokenEstimates(multiDevSnap, {
    accountScopeKey: 'acct_est_2',
    usageEvents: [{ poolKey: 'claude-opus-5-5', sharedGroupKey: 'shared_3p_pool', ts: nowMs + 62000, totalTokens: 50 }],
    calibrationMap: {},
    nowMs: nowMs + 65000
  });
  const pool3pM = rMulti.snapshot.pools.find(p => p.poolKey === 'shared_3p_pool');
  assert.equal(pool3pM.buckets[0].tokenEstimate.estRemainingTokens, null);
  assert.equal(pool3pM.buckets[0].tokenEstimate.externalDivergence, true);
  assert.equal(pool3pM.buckets[0].tokenEstimate.estBasis, 'incomplete_samples');

  // 4. 真实归档目录验证 collectTokenHistoryAsync 输出 recentModelUsage
  const tmpAgDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'ag-quota-usage-'));
  try {
    const convDir = path.join(tmpAgDir, 'brain', 'test-conv', '.system_generated', 'logs');
    fs.mkdirSync(convDir, { recursive: true });
    fs.writeFileSync(path.join(convDir, 'transcript.jsonl'), JSON.stringify({
      callId: 'call-usage-1',
      created_at: new Date().toISOString(),
      model: 'Claude Opus 5.5 (High)',
      input_tokens: 1500,
      cache_read_tokens: 8500,
      output_tokens: 2000
    }) + '\n', 'utf8');
    const hist = await collector.collectTokenHistoryAsync({ agDir: tmpAgDir, force: true });
    assert.ok(Array.isArray(hist.recentModelUsage) && hist.recentModelUsage.length === 1);
    assert.equal(hist.recentModelUsage[0].sharedGroupKey, 'shared_3p_pool');
    assert.equal(hist.recentModelUsage[0].inputTokens, 1500);
    assert.equal(hist.recentModelUsage[0].cacheTokens, 8500);
    assert.equal(hist.recentModelUsage[0].outputTokens, 2000);
    assert.equal(hist.recentModelUsage[0].totalTokens, 12000);
    assert.ok(Number.isFinite(hist.quotaUsageCoverageStartMs));
  } finally {
    fs.rmSync(tmpAgDir, { recursive: true, force: true });
  }
});

test('估算有效性边界：覆盖证明门禁、外部消耗降级防覆写、校准过期与混用模型标记', () => {
  const { nowMs, userStatusRes, quotaSummaryRes } = buildRealistic2321Fixtures();
  const base5h = core.buildModelQuotaSnapshot({
    userStatusRes,
    quotaSummaryRes,
    currentModel: 'MODEL_PLACEHOLDER_M40',
    fetchMeta: { fetchedAtMs: nowMs },
    nowMs
  });
  const gemBucket5h = base5h.pools.find(p => p.poolKey === 'shared_gemini_main').buckets.find(b => b.windowKey === '5h');
  const gemPool = base5h.pools.find(p => p.poolKey === 'shared_gemini_main');

  // 1. 仅凭 resetAt - windowMs 无法证明周期全覆盖 -> 严禁方法 B 强行推算
  const halfStartEvents = [
    { poolKey: 'gemini-4-hydrogen', sharedGroupKey: 'shared_gemini_main', ts: nowMs - 1800000, inputTokens: 10000, cacheTokens: 80000, outputTokens: 10000, totalTokens: 100000 }
  ];
  const noCov = core.computeBucketTokenEstimate(gemPool, gemBucket5h, {
    nowMs,
    usageEvents: halfStartEvents,
    historyCoverageStartMs: null,
    calibrationEntry: null
  });
  assert.equal(noCov.hasFullCycleCoverage, false);
  assert.equal(noCov.estRemainingTokens, null);
  assert.equal(noCov.estBasis, 'coverage_incomplete');
  assert.equal(noCov.isReliable, false);

  // 传入早于 cycleStartMs (resetAtMs - 5h) 的 historyCoverageStartMs 且同池混用两款模型 -> 合法允许 cycle 推算并标记口径与混用
  const fullCovEvents = [
    { poolKey: 'gemini-4-hydrogen', sharedGroupKey: 'shared_gemini_main', ts: nowMs - 30 * 60000, inputTokens: 20000, cacheTokens: 70000, outputTokens: 10000, totalTokens: 100000 },
    { poolKey: 'gemini-3.8-flash', sharedGroupKey: 'shared_gemini_main', ts: nowMs - 10 * 60000, inputTokens: 10000, cacheTokens: 35000, outputTokens: 5000, totalTokens: 50000 }
  ];
  const withCov = core.computeBucketTokenEstimate(gemPool, gemBucket5h, {
    nowMs,
    usageEvents: fullCovEvents,
    historyCoverageStartMs: gemBucket5h.resetAtMs - 6 * 3600000,
    calibrationEntry: null
  });
  assert.equal(withCov.hasFullCycleCoverage, true);
  assert.equal(withCov.estBasis, 'cycle_estimated');
  assert.equal(withCov.isReliable, true);
  assert.equal(withCov.mixedPoolModels, true);
  assert.equal(withCov.tokenAccountingBasis, 'raw_input_cache_output');
  assert.equal(withCov.cycleInputTokens, 30000);
  assert.equal(withCov.cycleCacheTokens, 105000);
  assert.equal(withCov.cycleOutputTokens, 15000);

  // 2. 先通过增量法 delta 建立独立有效校准，再触发外部消耗：
  //    estBasis 必须保持 stale_with_divergence，绝不能被后续覆写为 delta_calibrated！
  const cal1 = core.computeBucketTokenEstimate(gemPool, { ...gemBucket5h, remainingFraction: 0.90 }, {
    nowMs: nowMs + 1000,
    usageEvents: [],
    calibrationEntry: null
  });
  const cal2 = core.computeBucketTokenEstimate(gemPool, { ...gemBucket5h, remainingFraction: 0.70 }, {
    nowMs: nowMs + 60000,
    usageEvents: [{ poolKey: 'gemini-4-hydrogen', sharedGroupKey: 'shared_gemini_main', ts: nowMs + 30000, totalTokens: 200000 }],
    calibrationEntry: cal1.nextCalibrationEntry
  });
  assert.equal(cal2.estBasis, 'delta_calibrated');
  assert.equal(cal2.estTotalTokens, 1000000);

  // 接着另一台设备打掉 10% 额度 (0.70 -> 0.60)，本地增耗为 0
  const extAfterDelta = core.computeBucketTokenEstimate(gemPool, { ...gemBucket5h, remainingFraction: 0.60 }, {
    nowMs: nowMs + 120000,
    usageEvents: [{ poolKey: 'gemini-4-hydrogen', sharedGroupKey: 'shared_gemini_main', ts: nowMs + 30000, totalTokens: 200000 }],
    calibrationEntry: cal2.nextCalibrationEntry
  });
  assert.equal(extAfterDelta.externalDivergence, true);
  assert.equal(extAfterDelta.estBasis, 'stale_with_divergence', '异常状态绝不能被后续赋值给覆盖回正常校准');
  assert.equal(extAfterDelta.isReliable, false);
  assert.equal(extAfterDelta.isStaleCalibration, true);
  assert.equal(extAfterDelta.estRemainingTokens, 600000);

  // 3. 若此前仅有 cycle 推算（非独立先验）然后发生外部消耗，必须强制置空 estRemainingTokens
  const extAfterCycle = core.computeBucketTokenEstimate(gemPool, { ...gemBucket5h, remainingFraction: 0.25 }, {
    nowMs: nowMs + 120000,
    usageEvents: fullCovEvents,
    historyCoverageStartMs: gemBucket5h.resetAtMs - 6 * 3600000,
    calibrationEntry: withCov.nextCalibrationEntry
  });
  assert.equal(extAfterCycle.externalDivergence, true);
  assert.equal(extAfterCycle.estRemainingTokens, null);
  assert.equal(extAfterCycle.estBasis, 'incomplete_samples');
  assert.equal(extAfterCycle.isReliable, false);

  // 4. 跨周期沿用标为非实时可靠，且超过 TTL 必须失效为 calibration_expired
  const nextCycleBucket = {
    ...gemBucket5h,
    remainingFraction: 0.98,
    resetAtMs: gemBucket5h.resetAtMs + 6 * 3600000,
    resetTimeIso: new Date(gemBucket5h.resetAtMs + 6 * 3600000).toISOString()
  };
  const nextCycleRef = core.computeBucketTokenEstimate(gemPool, nextCycleBucket, {
    nowMs: nowMs + 7 * 3600000,
    usageEvents: [],
    calibrationEntry: cal2.nextCalibrationEntry
  });
  assert.equal(nextCycleRef.estBasis, 'cached_calibration');
  assert.equal(nextCycleRef.isReliable, false);
  assert.equal(nextCycleRef.isStaleCalibration, true);

  const expiredTtl = core.computeBucketTokenEstimate(gemPool, nextCycleBucket, {
    nowMs: nowMs + 9 * 86400000, // 超过 5h 校准 7 天有效期
    usageEvents: [],
    calibrationEntry: cal2.nextCalibrationEntry
  });
  assert.equal(expiredTtl.estRemainingTokens, null);
  assert.equal(expiredTtl.estBasis, 'calibration_expired');
  assert.equal(expiredTtl.isReliable, false);
});

test('实机回归保护：暗黑宿主切浅色不继承黑背景且过滤纯装饰性 Notice: New 大框', () => {
  const h = createQuotaRendererHarness({ hostBgColor: 'rgb(24, 24, 24)' });
  const api = h.sandbox.__AGContextMeter;

  // 1. 暗黑宿主 (#181818) 下手动切到浅色主题，--ag-host-bg 不得继承 #181818
  api.setTheme('light');
  assert.equal(h.host.getAttribute('data-theme'), 'light');
  assert.equal(h.host.style.getPropertyValue('--ag-host-bg'), '#ffffff');

  // 2. 切回深色时正常对齐宿主 #181818
  api.setTheme('dark');
  assert.equal(h.host.getAttribute('data-theme'), 'dark');
  assert.equal(h.host.style.getPropertyValue('--ag-host-bg'), '#181818');

  // 3. 装饰性 Notice: New 不占行显示大框，而真实通知正文正常显示
  const { nowMs, userStatusRes, quotaSummaryRes } = buildRealistic2321Fixtures();
  const hydrogenEntry = userStatusRes.userStatus.cascadeModelConfigData.clientModelConfigs.find(m => m.label === 'Gemini 4 Hydrogen (High)');
  hydrogenEntry.tagTitle = 'New';
  hydrogenEntry.tagDescription = '';
  api.setContextLatestForTest(
    { model: 'Gemini 4 Hydrogen (High)', modelId: 'MODEL_PLACEHOLDER_M28', actual: 1000, budget: 256000 },
    userStatusRes.userStatus.cascadeModelConfigData.clientModelConfigs
  );
  api.setQuotaSnapshotForTest({
    accountScopeKey: 'acct_notice_test',
    fetchedAtMs: nowMs,
    userStatusRes,
    quotaSummaryRes
  }, nowMs);
  assert.equal(h.elements.get('quota-cur-alert').hidden, true);

  api.setContextLatestForTest({ model: 'GPT-OSS 120B (Medium)', modelId: 'MODEL_OPENAI_GPT_OSS_120B_MEDIUM', actual: 1000, budget: 128000 });
  assert.equal(h.elements.get('quota-cur-alert').hidden, false);
  assert.equal(h.elements.get('quota-cur-alert').textContent, 'Notice: GPT-OSS will be removed from Antigravity on November 18, 2026.');

  // 4. UI 展示回归：异常或过期校准不得渲染为“实耗差值校准”，缺失完整周期覆盖不误显虚构数字
  api.setContextLatestForTest(
    { model: 'Gemini 4 Hydrogen (High)', modelId: 'MODEL_PLACEHOLDER_M28', actual: 1000, budget: 256000 },
    userStatusRes.userStatus.cascadeModelConfigData.clientModelConfigs
  );
  // 场景 A: 无本地历史且周期已消耗 55% (remainingFraction 0.45065)，本地 recentModelUsage 为空 -> externalDivergence -> incomplete_samples
  api.setQuotaSnapshotForTest({
    accountScopeKey: 'acct_ui_guard',
    fetchedAtMs: nowMs,
    userStatusRes,
    quotaSummaryRes
  }, nowMs);
  assert.match(h.elements.get('quota-cur-est').textContent, /检测到未采集消耗或采样失真/);
  assert.doesNotMatch(h.elements.get('quota-cur-est').textContent, /实耗差值校准/);

  // 场景 B: 预置先验有效 delta 校准，此时同周期大幅扣减 -> 渲染 stale_with_divergence 警告文案，绝不展示“实耗差值校准”
  h.sandbox.localStorage.setItem('ag_quota_token_cal_v2_acct_ui_guard2', JSON.stringify({
    'acct_ui_guard2::shared_gemini_main::5h': {
      schemaVersion: 2,
      calibratedTotalTokens: 1000000,
      calibratedAt: nowMs - 60000,
      calibratedResetAtMs: Date.parse('2026-11-15T05:00:00Z'),
      sampleCount: 1,
      source: 'delta',
      lastFraction: 0.90,
      lastResetAtMs: Date.parse('2026-11-15T05:00:00Z'),
      anchorFraction: 0.90,
      anchorCycleTokens: 0,
      updatedAt: nowMs - 60000
    }
  }));
  api.setQuotaSnapshotForTest({
    accountScopeKey: 'acct_ui_guard2',
    fetchedAtMs: nowMs,
    userStatusRes,
    quotaSummaryRes
  }, nowMs);
  assert.match(h.elements.get('quota-cur-est').textContent, /历史校准不可靠（检测到未采集消耗）/);
  assert.doesNotMatch(h.elements.get('quota-cur-est').textContent, /实耗差值校准/);

  api.dispose();
});

test('核心估算回归：有效 cycle_estimated / delta_calibrated 不残留前置 invalidationReason', () => {
  const { computeBucketTokenEstimate } = core;
  const resetAtMs = Date.parse('2026-11-15T10:00:00Z');
  const nowMs = resetAtMs - 3600000;
  // 构造历史未覆盖全周期、且周期已消耗 >= 15% 但本地零耗的初始异常状态 -> 产生 cycleInvalidationReason='external_divergence'
  const bucket = {
    windowKey: '5h',
    remainingFraction: 0.80,
    resetAtMs,
    resetTimeIso: new Date(resetAtMs).toISOString(),
    isResetPassed: false
  };
    const pool = {
      poolKey: 'shared_gemini_main',
      models: [{ modelIds: ['gemini-4-hydrogen'], aliases: [], productLabel: 'Gemini 4 Hydrogen' }]
    };
    const stepWarn = computeBucketTokenEstimate(pool, bucket, {
      accountScopeKey: 'acct_reason_clear',
      nowMs,
      usageEvents: [],
      historyCoverageStartMs: nowMs - 60000,
      calibrationEntry: null
    });
    assert.equal(stepWarn.invalidationReason, 'external_divergence');

    // 同周期随后补齐完整覆盖且本机有效增量消耗出现 -> 成功 delta_calibrated 后必须清空 invalidationReason 与持久化的 cycleInvalidationReason
      const stepCalibrated = computeBucketTokenEstimate(pool, { ...bucket, remainingFraction: 0.72 }, {
        accountScopeKey: 'acct_reason_clear',
        nowMs: nowMs + 120000,
        usageEvents: [
          { ts: nowMs + 60000, poolKey: 'gemini-4-hydrogen', inputTokens: 60000, cacheTokens: 20000, outputTokens: 20000, totalTokens: 100000 }
        ],
        historyCoverageStartMs: resetAtMs - 5 * 3600000 - 60000,
        calibrationEntry: stepWarn.nextCalibrationEntry
      });
      assert.equal(stepCalibrated.estBasis, 'delta_calibrated');
      assert.equal(stepCalibrated.isReliable, true);
      assert.equal(stepCalibrated.invalidationReason, null);
      assert.equal(stepCalibrated.nextCalibrationEntry.cycleInvalidationReason, null);
    });

    test('UI 首页无路由隔离与宿主无括号模型选择器实时跟踪回归', () => {
    const { nowMs, userStatusRes, quotaSummaryRes } = buildRealistic2321Fixtures();
    // 1. 无 state.route 且宿主页面不存在 model-selector-trigger -> 必须维持未知状态
    const hNoDom = createQuotaRendererHarness();
    const apiNoDom = hNoDom.sandbox.__AGContextMeter;
    apiNoDom.setQuotaSnapshotForTest({ accountScopeKey: 'acct_nodom', fetchedAtMs: nowMs, userStatusRes, quotaSummaryRes }, nowMs);
    assert.equal(apiNoDom.getModelQuotaStateForTest(nowMs).view.activeStatus, 'unknown');
    assert.equal(hNoDom.elements.get('quota-cur-model').textContent, '暂未识别当前模型');
    apiNoDom.dispose();

    // 2. 无 state.route（首页 /）但宿主页面有 [data-testid="model-selector-trigger"] 无括号显示 "Gemini 4 Hydrogen Medium"
    const hWithDom = createQuotaRendererHarness();
    let triggerText = 'Gemini 4 Hydrogen Medium';
    const origQuerySelectorAll = hWithDom.sandbox.document.querySelectorAll;
    const origQuerySelector = hWithDom.sandbox.document.querySelector;
    const mockTrigger = {
      tagName: 'BUTTON',
      getAttribute: (n) => (n === 'data-testid' ? 'model-selector-trigger' : n === 'aria-label' ? `Select model, current: ${triggerText}` : null),
      closest: () => null,
      getBoundingClientRect: () => ({ left: 490, top: 795, width: 180, height: 28 }),
      querySelector: () => null,
      querySelectorAll: () => [],
      cloneNode: () => ({ querySelectorAll: () => [], textContent: triggerText }),
      get textContent() { return triggerText; }
    };
    hWithDom.sandbox.document.querySelectorAll = (sel) => (sel === '[data-testid="model-selector-trigger"]' ? [mockTrigger] : origQuerySelectorAll(sel));
    hWithDom.sandbox.document.querySelector = (sel) => (sel === '[data-testid="model-selector-trigger"]' ? mockTrigger : origQuerySelector(sel));

    const apiWithDom = hWithDom.sandbox.__AGContextMeter;
    apiWithDom.setQuotaSnapshotForTest({ accountScopeKey: 'acct_withdom', fetchedAtMs: nowMs, userStatusRes, quotaSummaryRes }, nowMs);
    // 通过宿主 DOM（无 route）强制触发一次 render()（如同首页初始化 render），验证识别为 Gemini 4 Hydrogen
    apiWithDom.setContextLatestForTest(null, userStatusRes.userStatus.cascadeModelConfigData.clientModelConfigs);
    const v1 = apiWithDom.getModelQuotaStateForTest(nowMs).view;
    assert.equal(v1.currentModel?.productKey, 'product:google:gemini-4-hydrogen');
    assert.equal(hWithDom.elements.get('quota-cur-model').textContent, 'Gemini 4 Hydrogen');
    assert.notEqual(v1.activeStatus, 'unknown');

    // 切换宿主触发器为同池第二个模型 "Gemini 3.8 Flash Medium" 后再走一次 render，必须精准落到 Gemini 3.8 Flash 而非共享池第 0 项
    triggerText = 'Gemini 3.8 Flash Medium';
    apiWithDom.setContextLatestForTest(null, userStatusRes.userStatus.cascadeModelConfigData.clientModelConfigs);
    const v2 = apiWithDom.getModelQuotaStateForTest(nowMs).view;
    assert.equal(v2.currentModel?.productKey, 'product:google:gemini-3.8-flash');
    assert.equal(hWithDom.elements.get('quota-cur-model').textContent, 'Gemini 3.8 Flash');

    apiWithDom.dispose();
  });

test('手动刷新动效与防闪烁回归：按钮/时间文字不抽动、无变化不重设条形、连击防重与失败保旧值', async () => {
  const { nowMs, userStatusRes, quotaSummaryRes } = buildRealistic2321Fixtures();
  const h = createQuotaRendererHarness();
  // 结束 harness 初始化 tick() 触发的首轮静默 getQuota 占位请求，以免 quotaState.busy 保持 true
  for (const req of h.quotaRequests) {
    req.resolve({ ok: false, error: 'init-noop' });
  }
  await h.flush();

  let getQuotaCallCount = 0;
  let resolveNextRpc = null;
  const win = h.sandbox.window;
  win.contextMeterAPI = {
    getQuota: async () => {
      getQuotaCallCount += 1;
      return await new Promise(resolve => {
        resolveNextRpc = resolve;
      });
    }
  };
  const api = h.sandbox.__AGContextMeter;
  api.setContextLatestForTest(
    { model: 'Gemini 4 Hydrogen (High)', modelId: 'MODEL_PLACEHOLDER_M28', actual: 1000, budget: 256000 },
    userStatusRes.userStatus.cascadeModelConfigData.clientModelConfigs
  );

  // 1. 首帧建立初始快照，带有效的 nextRefreshAtMs 倒计时
  const initialSnap = api.setQuotaSnapshotForTest({
    accountScopeKey: 'acct_anim_stable',
    fetchedAtMs: nowMs,
    nextRefreshAtMs: nowMs + 180000,
    userStatusRes,
    quotaSummaryRes
  }, nowMs);
  assert.ok(initialSnap.pools.length >= 1);

  const btnRefreshText = h.elements.get('quota-refresh-text');
  const btnRefresh = h.elements.get('btn-quota-refresh');
  const tNext = h.elements.get('quota-time-next');
  assert.equal(btnRefreshText.textContent, '刷新');
  const initialNextText = tNext.textContent;
  assert.match(initialNextText, /\(3分\)/);

  // 2. 连续快速点击（调用 refreshQuotaForTest 两次），期间校验不叠加请求、不闪烁按钮文字/下次刷新时间、不清空卡片
  const p1 = api.refreshQuotaForTest(true, { manual: true });
  const p2 = api.refreshQuotaForTest(true, { manual: true });
  assert.equal(getQuotaCallCount, 1);
  assert.equal(btnRefresh.disabled, true);
  assert.equal(btnRefresh.getAttribute('data-busy'), 'true');
  assert.equal(btnRefreshText.textContent, '刷新');
  assert.equal(tNext.textContent, initialNextText);
  assert.notEqual(h.elements.get('quota-cur-model').textContent, '暂未识别当前模型');

  // 3. 首次手动刷新返回“数据未变化”同内容新快照 -> 触发已更新反馈、进度条不重建
  const sameViewSnap = api.getModelQuotaStateForTest(nowMs).view;
  const listEl = h.elements.get('quota-pools-list');
  const firstCardRef = listEl.children[0];
  const unchangedBuiltSnap = core.buildModelQuotaSnapshot({
    userStatusRes,
    quotaSummaryRes,
    currentModel: { modelId: 'MODEL_PLACEHOLDER_M28', label: 'Gemini 4 Hydrogen (High)' },
    fetchMeta: { fetchedAtMs: nowMs + 1000 },
    nowMs: nowMs + 1000
  });
  resolveNextRpc({
    ok: true,
    data: {
      ok: true,
      accountScopeKey: 'acct_anim_stable',
      fetchedAtMs: nowMs + 1000,
      lastSuccessAtMs: nowMs + 1000,
      snapshot: unchangedBuiltSnap
    }
  });
  await Promise.all([p1, p2]);
  const fbEl = h.elements.get('quota-refresh-feedback');
  assert.equal(btnRefresh.disabled, false);
  assert.equal(btnRefresh.getAttribute('data-busy'), 'false');
  assert.equal(fbEl.hidden, false);
  assert.equal(fbEl.textContent, '已更新');
  assert.equal(listEl.children[0], firstCardRef);
  assert.equal(sameViewSnap.pools.length, api.getModelQuotaStateForTest(nowMs + 1000).view.pools.length);

  // 3b. 验证静态节点无变化不触发重复 DOM 写入，且滚动位置保持不变
  api.showQuotaPanelForTest(true);
  const viewQuotaEl = h.elements.get('view-quota');
  viewQuotaEl.scrollTop = 148;
  const curModelNode = h.elements.get('quota-cur-model');
  let curModelTextWrites = 0;
  let curModelRawText = curModelNode.textContent;
  Object.defineProperty(curModelNode, 'textContent', {
    configurable: true,
    get: () => curModelRawText,
    set: v => { curModelTextWrites += 1; curModelRawText = String(v); }
  });
  let firstCardAttrWrites = 0;
  const origSetAttr = firstCardRef.setAttribute.bind(firstCardRef);
  firstCardRef.setAttribute = (k, v) => { firstCardAttrWrites += 1; return origSetAttr(k, v); };

  // 4. 模拟刷新失败：保留现有旧值，横幅显示错误，不归零，且先前“已更新”反馈应自动收起
  const beforeErrBadge = h.elements.get('quota-badge-val').textContent;
  const pErr = api.refreshQuotaForTest(true, { manual: true });
  resolveNextRpc({ ok: false, error: '模拟超时' });
  await pErr;
  assert.equal(h.elements.get('quota-badge-val').textContent, beforeErrBadge);
  assert.equal(h.elements.get('quota-banner').hidden, false);
  assert.match(h.elements.get('quota-banner-text').textContent, /模拟超时/);
  assert.equal(fbEl.hidden, true);
  assert.equal(viewQuotaEl.scrollTop, 148);
  assert.equal(curModelTextWrites, 0, '模型名称未变时不应触发多余 DOM textContent 写入');
  assert.equal(firstCardAttrWrites, 0, '卡片状态未变时不应触发多余 DOM 属性写入');

  // 5. 隔离场景验证：setQuotaSnapshotForTest 触发数值变化时，调用 rAF 渐进插值数字而非直接跳终值
  const changedSummary = JSON.parse(JSON.stringify(quotaSummaryRes));
  const changedUserStatus = JSON.parse(JSON.stringify(userStatusRes));
  for (const grp of (changedSummary.response?.groups || [])) {
    for (const b of (grp.buckets || [])) {
      if (typeof b.remainingFraction === 'number') b.remainingFraction = 0.88;
    }
  }
  for (const m of changedUserStatus.userStatus.cascadeModelConfigData.clientModelConfigs) {
    if (m?.quotaInfo && typeof m.quotaInfo.remainingFraction === 'number') {
      m.quotaInfo.remainingFraction = 0.88;
    }
  }
  api.setQuotaSnapshotForTest({
    accountScopeKey: 'acct_anim_stable',
    fetchedAtMs: nowMs + 5000,
    userStatusRes: changedUserStatus,
    quotaSummaryRes: changedSummary
  }, nowMs + 5000);
  // 刚触发变化时，rAF 已排队且数值从原值向 88% 平滑推进
  assert.ok(h.getActiveRafCount() > 0, '数值变化时应启用 rAF 平滑数字插值而非硬切');
  h.stepRaf(250);
  assert.equal(h.elements.get('quota-badge-val').textContent, '88%');

  api.dispose();
});

test('额度进度条充能动画：仅手动刷新成功后按真实比例与状态色播放，防堆积、防零余额/未知/无权限误播', async () => {
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const f5h = new Date(nowMs + 4 * 3600000).toISOString();
  const fWeek = new Date(nowMs + 3 * 86400000).toISOString();
  const fArgon = new Date(nowMs + 5 * 86400000).toISOString();
  const { userStatusRes, quotaSummaryRes } = buildRealistic2321Fixtures(nowIso, f5h, fWeek, fArgon);
  // 注入一个零余额、一个低余额、一个未知桶用于完整边界校验
  quotaSummaryRes.response.groups[1].buckets = [
    { bucketId: '3p-exhausted', window: 'weekly', remainingFraction: 0, resetTime: fWeek },
    { bucketId: '3p-low', window: '5h', remainingFraction: 0.12, resetTime: f5h }
  ];
  quotaSummaryRes.response.groups[2].buckets = [
    { bucketId: 'argon-unknown', window: 'weekly', resetTime: fArgon }
  ];

  const h = createQuotaRendererHarness();
  for (const req of h.quotaRequests) {
    req.resolve({ ok: false, error: 'init-noop' });
  }
  await h.flush();

  let resolveNextRpc = null;
  h.sandbox.window.contextMeterAPI = {
    scan: () => new Promise(() => { }),
    getQuota: () => new Promise(resolve => { resolveNextRpc = resolve; })
  };
  const api = h.sandbox.__AGContextMeter;
  api.setContextLatestForTest(
    { model: 'Gemini 4 Hydrogen (High)', modelId: 'MODEL_PLACEHOLDER_M28', actual: 1000, budget: 256000 },
    userStatusRes.userStatus.cascadeModelConfigData.clientModelConfigs
  );
  api.setQuotaSnapshotForTest({
    accountScopeKey: 'acct_charge_test',
    fetchedAtMs: nowMs,
    userStatusRes,
    quotaSummaryRes
  }, nowMs);
  api.showQuotaPanelForTest(true);
  // 若 showPanel 因上次 fetch 为 null 触发了 maybeRefreshQuotaOnOpen，先结束它确保状态干净
  if (resolveNextRpc) {
    resolveNextRpc({
      ok: true,
      data: {
        ok: true,
        accountScopeKey: 'acct_charge_test',
        fetchedAtMs: nowMs,
        lastSuccessAtMs: nowMs,
        snapshot: core.buildModelQuotaSnapshot({
          userStatusRes,
          quotaSummaryRes,
          currentModel: { modelId: 'MODEL_PLACEHOLDER_M28', label: 'Gemini 4 Hydrogen (High)' },
          fetchMeta: { fetchedAtMs: nowMs },
          nowMs
        })
      }
    });
    resolveNextRpc = null;
    await h.flush();
  }

  const curBuckets = h.elements.get('quota-cur-buckets');
  const curRow = curBuckets.children[0];
  const curTrack = curRow.children[1];
  const curFill = curTrack.children[0];
  const curStage = curTrack.children[1];

  const listEl = h.elements.get('quota-pools-list');
  const pool3pCard = listEl.children.find(c => c.getAttribute('data-pool-key') === 'shared_3p_pool');
  const pool3pBuckets = pool3pCard.children[2];
  const zeroTrack = pool3pBuckets.children[0].children[1];
  const zeroStage = zeroTrack.children[1];
  const lowTrack = pool3pBuckets.children[1].children[1];
  const lowStage = lowTrack.children[1];

  const poolArgonCard = listEl.children.find(c => c.getAttribute('data-pool-key') === 'shared_gemini_argon');
  const unknownTrack = poolArgonCard.children[2].children[0].children[1];
  const unknownStage = unknownTrack.children[1];

  // 1. 请求等待期间保持底层状态，不提前启动充能动画
  const pManual1 = api.refreshQuotaForTest(true, { manual: true });
  assert.equal(curTrack.getAttribute('data-charging'), null);
  assert.equal(curStage.hidden, true);

  // 2. 手动刷新成功（数值未变）-> 可见有效条按自身真实比例与状态色播放，零余额/未知保持静态
  const sameSnap = core.buildModelQuotaSnapshot({
    userStatusRes,
    quotaSummaryRes,
    currentModel: { modelId: 'MODEL_PLACEHOLDER_M28', label: 'Gemini 4 Hydrogen (High)' },
    fetchMeta: { fetchedAtMs: nowMs + 500 },
    nowMs: nowMs + 500
  });
  const qFill = h.elements.get('quota-ring-fill');
  let ringFillAttrWrites = 0;
  const origRingSetAttr = qFill.setAttribute.bind(qFill);
  qFill.setAttribute = (k, v) => { ringFillAttrWrites += 1; return origRingSetAttr(k, v); };

  resolveNextRpc({
    ok: true,
    data: { ok: true, accountScopeKey: 'acct_charge_test', fetchedAtMs: nowMs + 500, lastSuccessAtMs: nowMs + 500, snapshot: sameSnap }
  });
  await pManual1;

  assert.equal(curTrack.getAttribute('data-charging'), 'true');
  assert.equal(curStage.hidden, false);
  assert.equal(curStage.getAttribute('data-status'), 'available');
  assert.equal(curStage.style.width, '45.06%');
  assert.equal(curFill.style.transform, 'scaleX(0.4506)');
  assert.equal(lowTrack.getAttribute('data-charging'), 'true');
  assert.equal(lowStage.hidden, false);
  assert.equal(lowStage.getAttribute('data-status'), 'low');
  assert.equal(lowStage.style.width, '12.00%');
  assert.equal(zeroTrack.getAttribute('data-charge-eligible'), 'false');
  assert.equal(zeroTrack.getAttribute('data-charging'), null);
  assert.equal(zeroStage.hidden, true);
  assert.equal(unknownTrack.getAttribute('data-charge-eligible'), 'false');
  assert.equal(unknownTrack.getAttribute('data-charging'), null);
  assert.equal(unknownStage.hidden, true);
  assert.equal(ringFillAttrWrites, 0, '顶部圆环不应在条形充能反馈时重复重绘');

  // 3. 动画进行中再次触发手动刷新成功 -> 不堆积多轮播放、不新建第二个收尾定时器
  const activeChargeTimers1 = h.scheduledTimeouts.filter(t => t.ms === 750 && !t.cleared);
  assert.equal(activeChargeTimers1.length, 1);
  const pManualOverlap = api.refreshQuotaForTest(true, { manual: true });
  resolveNextRpc({
    ok: true,
    data: { ok: true, accountScopeKey: 'acct_charge_test', fetchedAtMs: nowMs + 700, lastSuccessAtMs: nowMs + 700, snapshot: sameSnap }
  });
  await pManualOverlap;
  const activeChargeTimers2 = h.scheduledTimeouts.filter(t => t.ms === 750 && !t.cleared);
  assert.equal(activeChargeTimers2.length, 1);
  assert.equal(activeChargeTimers2[0].id, activeChargeTimers1[0].id);

  // 4. 定时器到期后无缝收尾，回到纯粹底层显示
  activeChargeTimers2[0].fn();
  assert.equal(curTrack.getAttribute('data-charging'), null);
  assert.equal(curStage.hidden, true);
  assert.equal(curFill.style.transform, 'scaleX(0.4506)');

  // 5. 自动静默刷新 & 失败响应均不触发充能动画
  const pAuto = api.refreshQuotaForTest(false, { silent: true });
  resolveNextRpc({
    ok: true,
    data: { ok: true, accountScopeKey: 'acct_charge_test', fetchedAtMs: nowMs + 2000, lastSuccessAtMs: nowMs + 2000, snapshot: sameSnap }
  });
  await pAuto;
  assert.equal(curTrack.getAttribute('data-charging'), null);
  assert.equal(curStage.hidden, true);

  const pFail = api.refreshQuotaForTest(true, { manual: true });
  resolveNextRpc({ ok: false, error: '请求失败' });
  await pFail;
  assert.equal(curTrack.getAttribute('data-charging'), null);
  assert.equal(curStage.hidden, true);

  api.dispose();
});

test('额度进度条充能动画：prefers-reduced-motion 降级为静态成功反馈', async () => {
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const f5h = new Date(nowMs + 4 * 3600000).toISOString();
  const fWeek = new Date(nowMs + 3 * 86400000).toISOString();
  const fArgon = new Date(nowMs + 5 * 86400000).toISOString();
  const { userStatusRes, quotaSummaryRes } = buildRealistic2321Fixtures(nowIso, f5h, fWeek, fArgon);
  const h = createQuotaRendererHarness({ reducedMotion: true });
  for (const req of h.quotaRequests) {
    req.resolve({ ok: false, error: 'init-noop' });
  }
  await h.flush();

  let resolveNextRpc = null;
  h.sandbox.window.contextMeterAPI = {
    scan: () => new Promise(() => { }),
    getQuota: () => new Promise(resolve => { resolveNextRpc = resolve; })
  };
  const api = h.sandbox.__AGContextMeter;
  api.setContextLatestForTest(
    { model: 'Gemini 4 Hydrogen (High)', modelId: 'MODEL_PLACEHOLDER_M28', actual: 1000, budget: 256000 },
    userStatusRes.userStatus.cascadeModelConfigData.clientModelConfigs
  );
  api.setQuotaSnapshotForTest({
    accountScopeKey: 'acct_reduced_charge',
    fetchedAtMs: nowMs,
    userStatusRes,
    quotaSummaryRes
  }, nowMs);
  api.showQuotaPanelForTest(true);
  if (resolveNextRpc) {
    resolveNextRpc({
      ok: true,
      data: {
        ok: true,
        accountScopeKey: 'acct_reduced_charge',
        fetchedAtMs: nowMs,
        lastSuccessAtMs: nowMs,
        snapshot: core.buildModelQuotaSnapshot({
          userStatusRes,
          quotaSummaryRes,
          currentModel: { modelId: 'MODEL_PLACEHOLDER_M28', label: 'Gemini 4 Hydrogen (High)' },
          fetchMeta: { fetchedAtMs: nowMs },
          nowMs
        })
      }
    });
    resolveNextRpc = null;
    await h.flush();
  }

  const curTrack = h.elements.get('quota-cur-buckets').children[0].children[1];
  const curStage = curTrack.children[1];

  const changedSummary = JSON.parse(JSON.stringify(quotaSummaryRes));
  changedSummary.response.groups[0].buckets[0].remainingFraction = 0.77;
  const nextSnap = core.buildModelQuotaSnapshot({
    userStatusRes,
    quotaSummaryRes: changedSummary,
    currentModel: { modelId: 'MODEL_PLACEHOLDER_M28', label: 'Gemini 4 Hydrogen (High)' },
    fetchMeta: { fetchedAtMs: nowMs + 1000 },
    nowMs: nowMs + 1000
  });

  const pManual = api.refreshQuotaForTest(true, { manual: true });
  resolveNextRpc({
    ok: true,
    data: { ok: true, accountScopeKey: 'acct_reduced_charge', fetchedAtMs: nowMs + 1000, lastSuccessAtMs: nowMs + 1000, snapshot: nextSnap }
  });
  await pManual;

  assert.equal(curTrack.getAttribute('data-charging'), null);
  assert.equal(curStage.hidden, true);
  assert.equal(h.elements.get('quota-refresh-feedback').hidden, false);
  assert.equal(h.elements.get('quota-refresh-feedback').textContent, '已更新');

  api.dispose();
});

test('模型列表与下拉小额度圆环联动：同池共享状态一致、无权限/仅历史准确区分且点击上下文行为不变', async () => {
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const f5h = new Date(nowMs + 4 * 3600000).toISOString();
  const fWeek = new Date(nowMs + 3 * 86400000).toISOString();
  const fArgon = new Date(nowMs + 5 * 86400000).toISOString();
  const { userStatusRes, quotaSummaryRes } = buildRealistic2321Fixtures(nowIso, f5h, fWeek, fArgon);
  const h = createQuotaRendererHarness();
  for (const req of h.quotaRequests) {
    req.resolve({ ok: false, error: 'init-noop' });
  }
  await h.flush();

  const api = h.sandbox.__AGContextMeter;
  api.setContextLatestForTest(
    { model: 'Gemini 4 Hydrogen (High)', modelId: 'MODEL_PLACEHOLDER_M28', actual: 1000, budget: 256000 },
    userStatusRes.userStatus.cascadeModelConfigData.clientModelConfigs
  );
  // 注入一条仅历史记录模型，验证非当前账号目录模型标为 unknown 而不误报耗尽
  api.setSpeedRecordsForTest([{ model: 'Claude Opus 4.6 (Thinking)', modelId: 'claude-opus-4-6-thinking', tps: 50, duration: 2 }]);
  api.setContextScopeModeForTest('per_model');
  api.setQuotaSnapshotForTest({
    accountScopeKey: 'acct_model_list_rings',
    fetchedAtMs: nowMs,
    userStatusRes,
    quotaSummaryRes
  }, nowMs);
  api.switchContextTabForTest('models');
  await h.flush();

  const collectRowChips = () => {
    const out = [];
    const listEl = h.elements.get('ctx-model-list');
    for (const grp of (listEl.children || [])) {
      for (const row of (grp.children || []).slice(1)) {
        const pKey = row.getAttribute('data-product-key');
        const left = (row.children || []).find(c => c.className === 'ctx-product-row-left');
        const nameText = String((left?.children || [])[0]?.textContent || '');
        const right = (row.children || []).find(c => c.className === 'ctx-product-row-right');
        const chip = (right?.children || []).find(c => String(c.className || '').includes('ctx-model-quota-chip'));
        const valSpan = (right?.children || []).find(c => String(c.className || '').includes('ctx-product-row-val'));
        const svg = (chip?.children || [])[0];
        const fill = (svg?.children || [])[1];
        out.push({ pKey, nameText, row, chip, valSpan, fill });
      }
    }
    return out;
  };

  const rows = collectRowChips();
  assert.ok(rows.length >= 5, '模型列表应渲染全部产品行');

  const byLabel = namePart => rows.find(r => r.nameText.toLowerCase().includes(namePart.toLowerCase()));
  const hydrogen = byLabel('hydrogen');
  const flash38 = byLabel('flash');
  const claudeOpus = byLabel('opus 5.5');
  const claudeSonnet = byLabel('sonnet 5.5');
  const gptOss = byLabel('gpt-oss');
  const carbon = byLabel('carbon');
  const histOpus = byLabel('opus 4.6');

  assert.ok(hydrogen && flash38 && claudeOpus && claudeSonnet && gptOss && carbon && histOpus);

  const chipText = chip => String((chip?.children || []).find(c => c.className === 'ctx-model-quota-val')?.textContent || chip?.textContent || '');

  // 同属 Gemini 主池：百分比与状态一致 (45% available)
  assert.equal(hydrogen.chip.getAttribute('data-quota-state'), 'available');
  assert.equal(flash38.chip.getAttribute('data-quota-state'), 'available');
  assert.equal(chipText(hydrogen.chip), '45%');
  assert.equal(chipText(flash38.chip), '45%');
  assert.equal(hydrogen.chip.getAttribute('data-pool-key'), flash38.chip.getAttribute('data-pool-key'));
  assert.ok(hydrogen.row.title.includes('45%') && hydrogen.row.title.includes('重置'));

  // 同属 3P 池：极小非零精度 (0.1% low)，且圆环具有可见弧段（offset < 周长）
  for (const item of [claudeOpus, claudeSonnet, gptOss]) {
    assert.equal(item.chip.getAttribute('data-quota-state'), 'low');
    assert.equal(chipText(item.chip), '0.1%');
    const offset = Number(item.fill.getAttribute('stroke-dashoffset'));
    assert.ok(Number.isFinite(offset) && offset < 34.56, '0.1% 仍应保留最小可见弧段');
  }

  // Gemini 4 Carbon：无权限，绝不标成 0% 耗尽
  assert.equal(carbon.chip.getAttribute('data-quota-state'), 'no_permission');
  assert.equal(chipText(carbon.chip), '无权限');
  assert.equal(carbon.fill.getAttribute('stroke-dasharray'), '0 34.56');

  // 仅历史记录模型：标为未知与虚线弧段
  assert.equal(histOpus.chip.getAttribute('data-quota-state'), 'unknown');
  assert.equal(chipText(histOpus.chip), '未知');
  assert.equal(histOpus.fill.getAttribute('stroke-dasharray'), '8 26.56');

  // 下拉菜单预渲染项同样包含小额度圆环芯片且悬浮包含池与重置信息
  const dropdownMenu = h.elements.get('ctx-model-dropdown-menu');
  const dropdownList = (dropdownMenu.children || [])[1];
  const dropdownItems = (dropdownList?.children || []).filter(c => String(c.className || '').includes('ag-dropdown-item'));
  assert.ok(dropdownItems.length >= 5);
  const ddCarbon = dropdownItems.find(it => it.getAttribute('data-value') === carbon.row.getAttribute('data-product-key'));
  assert.ok(ddCarbon && ddCarbon.title.includes('无权限'));

  // 原有模型行点击交互与上下文卡片正常保留，且详情卡顶部插槽同步展示小圆环
  claudeOpus.row.click();
  await h.flush();
  assert.equal(api.getContextPreferencesState().selectedProductKey, claudeOpus.row.getAttribute('data-product-key'));
  const cardSlot = h.elements.get('ctx-card-quota-slot');
  assert.equal(cardSlot.hidden, false);
  assert.equal(cardSlot.children[0].getAttribute('data-quota-state'), 'low');
  assert.equal(chipText(cardSlot.children[0]), '0.1%');
  assert.ok(['512K', '默认', '自定义', '1M'].some(k => claudeOpus.valSpan.textContent.length > 0));

  api.dispose();
});

test('模型列表小额度圆环同步与异常隔离：刷新变更/耗尽/错误/过期联动更新且不新增独立轮询', async () => {
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const f5h = new Date(nowMs + 4 * 3600000).toISOString();
  const fWeek = new Date(nowMs + 3 * 86400000).toISOString();
  const fArgon = new Date(nowMs + 5 * 86400000).toISOString();
  const { userStatusRes, quotaSummaryRes } = buildRealistic2321Fixtures(nowIso, f5h, fWeek, fArgon);
  const h = createQuotaRendererHarness();
  for (const req of h.quotaRequests) {
    req.resolve({ ok: false, error: 'init-noop' });
  }
  await h.flush();

  let resolveNextRpc = null;
  h.sandbox.window.contextMeterAPI = {
    scan: () => new Promise(() => { }),
    getQuota: () => new Promise(resolve => { resolveNextRpc = resolve; })
  };

  const api = h.sandbox.__AGContextMeter;
  api.setContextLatestForTest(
    { model: 'Gemini 4 Hydrogen (High)', modelId: 'MODEL_PLACEHOLDER_M28', actual: 1000, budget: 256000 },
    userStatusRes.userStatus.cascadeModelConfigData.clientModelConfigs
  );
  api.setContextScopeModeForTest('per_model');
  api.setQuotaSnapshotForTest({
    accountScopeKey: 'acct_model_sync_rings',
    fetchedAtMs: nowMs,
    userStatusRes,
    quotaSummaryRes
  }, nowMs);
  api.switchContextTabForTest('models');
  await h.flush();

  const timersBefore = h.scheduledTimeouts.length;
  const listEl = h.elements.get('ctx-model-list');
  const findChipByPart = part => {
    for (const grp of (listEl.children || [])) {
      for (const row of (grp.children || []).slice(1)) {
        const left = (row.children || []).find(c => c.className === 'ctx-product-row-left');
        const nameText = String((left?.children || [])[0]?.textContent || '').toLowerCase();
        if (nameText.includes(part.toLowerCase())) {
          const right = (row.children || []).find(c => c.className === 'ctx-product-row-right');
          return (right?.children || []).find(c => String(c.className || '').includes('ctx-model-quota-chip'));
        }
      }
    }
    return null;
  };

  const chipText = chip => String((chip?.children || []).find(c => c.className === 'ctx-model-quota-val')?.textContent || chip?.textContent || '');
  const hydrogenChipBefore = findChipByPart('hydrogen');
  const flashChipBefore = findChipByPart('flash');
  const claudeChipBefore = findChipByPart('opus 5.5');
  const gptChipBefore = findChipByPart('gpt-oss');
  assert.equal(chipText(claudeChipBefore), '0.1%');

  // 1. 模拟手动刷新：Gemini 主池升至 82%，3P 池耗尽至 0%
  const updatedSummary = JSON.parse(JSON.stringify(quotaSummaryRes));
  updatedSummary.response.groups[0].buckets[0].remainingFraction = 0.82;
  updatedSummary.response.groups[1].buckets[0].remainingFraction = 0;
  updatedSummary.response.groups[1].buckets[0].isExhausted = true;
  const nextSnap = core.buildModelQuotaSnapshot({
    userStatusRes,
    quotaSummaryRes: updatedSummary,
    currentModel: { modelId: 'MODEL_PLACEHOLDER_M28', label: 'Gemini 4 Hydrogen (High)' },
    fetchMeta: { fetchedAtMs: nowMs + 5000 },
    nowMs: nowMs + 5000
  });

  const pRefresh = api.refreshQuotaForTest(true, { manual: true });
  resolveNextRpc({
    ok: true,
    data: {
      ok: true,
      accountScopeKey: 'acct_model_sync_rings',
      fetchedAtMs: nowMs + 5000,
      lastSuccessAtMs: nowMs + 5000,
      snapshot: nextSnap
    }
  });
  await pRefresh;

  // 原地复用 DOM 节点且同池模型同步变更为最新状态
  assert.equal(findChipByPart('hydrogen'), hydrogenChipBefore);
  assert.equal(findChipByPart('flash'), flashChipBefore);
  assert.equal(chipText(hydrogenChipBefore), '82%');
  assert.equal(chipText(flashChipBefore), '82%');
  assert.equal(hydrogenChipBefore.getAttribute('data-quota-state'), 'available');
  assert.equal(claudeChipBefore.getAttribute('data-quota-state'), 'exhausted');
  assert.equal(chipText(claudeChipBefore), '耗尽');
  assert.equal(gptChipBefore.getAttribute('data-quota-state'), 'exhausted');
  assert.equal(chipText(gptChipBefore), '耗尽');

  // 确认与看板当前池显示一致，且除了原有的 quota 自动/重置调度外无新增独立轮询
  const curPoolText = api.getModelQuotaStateForTest(nowMs + 5000).view.pools[0].percentText;
  assert.equal(chipText(hydrogenChipBefore), curPoolText);
  const extraNonQuotaTimers = h.scheduledTimeouts.slice(timersBefore).filter(t => !t.isQuota);
  assert.equal(extraNonQuotaTimers.length, 0);

  // 2. 无快照下报错 -> error 而不标成耗尽
  api.setQuotaSnapshotForTest(null, nowMs + 6000);
  api.setQuotaSnapshotForTest({
    accountScopeKey: 'acct_model_err',
    error: 'network timeout',
    errorKind: 'network'
  }, nowMs + 6000);
  assert.equal(hydrogenChipBefore.getAttribute('data-quota-state'), 'error');
  assert.equal(chipText(hydrogenChipBefore), '失败');
  assert.equal(findChipByPart('carbon').getAttribute('data-quota-state'), 'no_permission');

  // 3. 有旧快照但已过期 -> 标为 stale
  api.setQuotaSnapshotForTest({
    accountScopeKey: 'acct_model_stale',
    fetchedAtMs: nowMs - 600000,
    lastSuccessAtMs: nowMs - 600000,
    snapshot: nextSnap
  }, nowMs);
  assert.equal(hydrogenChipBefore.getAttribute('data-quota-state'), 'stale');

  api.dispose();
});

test('上下文面板后台刷新与下拉展开不触发 scrollIntoView，scrollTop 与焦点防滚动保持稳定', async () => {
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const f5h = new Date(nowMs + 4 * 3600000).toISOString();
  const fWeek = new Date(nowMs + 3 * 86400000).toISOString();
  const fArgon = new Date(nowMs + 5 * 86400000).toISOString();
  const { userStatusRes, quotaSummaryRes } = buildRealistic2321Fixtures(nowIso, f5h, fWeek, fArgon);
  const h = createQuotaRendererHarness();
  try {
    for (const req of h.quotaRequests) {
      req.resolve({ ok: false, error: 'init-noop' });
    }
    await h.flush();

    const scrollIntoViewCalls = [];
    const focusCalls = [];
    const matchClasses = (elNode, sel) => {
      const classes = String(sel || '').split('.').filter(Boolean);
      return classes.length > 0 && classes.every(cls => elNode.classList?.contains?.(cls));
    };
    const deepQuery = (root, sel) => {
      for (const ch of (root.children || [])) {
        if (matchClasses(ch, sel)) return ch;
        const inner = deepQuery(ch, sel);
        if (inner) return inner;
      }
      return null;
    };

    const sandboxDoc = h.sandbox.document;
    const origCreateElement = sandboxDoc.createElement.bind(sandboxDoc);
    sandboxDoc.createElement = (tag) => {
      const node = origCreateElement(tag);
      node.scrollIntoView = (arg) => scrollIntoViewCalls.push({ tag: node.tagName, cls: node.className, arg });
      node.focus = (opts) => focusCalls.push({ tag: node.tagName, cls: node.className, opts });
      node.querySelector = (sel) => deepQuery(node, sel);
      node.getBoundingClientRect = () => {
        if (String(node.className || '').includes('ag-dropdown-item') && String(node.className || '').includes('is-selected')) {
          return { top: 320, bottom: 348, height: 28, left: 0, right: 300, width: 300 };
        }
        if (String(node.className || '').includes('ag-dropdown-search-wrap')) {
          return { top: 100, bottom: 132, height: 32, left: 0, right: 300, width: 300 };
        }
        return { top: 0, bottom: 24, height: 24, left: 0, right: 100, width: 100 };
      };
      return node;
    };

    const api = h.sandbox.__AGContextMeter;
    const panel = h.elements.get('panel');
    const trigger = h.elements.get('ctx-model-dropdown-trigger');
    const menu = h.elements.get('ctx-model-dropdown-menu');
    const wrap = h.elements.get('ctx-model-dropdown-wrap');
    const modelList = h.elements.get('ctx-model-list');
    const viewQuota = h.elements.get('view-quota');
    trigger.focus = (opts) => focusCalls.push({ id: 'trigger', opts });
    trigger.getBoundingClientRect = () => ({ top: 120, bottom: 148, height: 28, left: 10, right: 200, width: 190 });
    menu.getBoundingClientRect = () => ({ top: 100, bottom: 260, height: 160, left: 0, right: 300, width: 300 });
    menu.querySelector = (sel) => deepQuery(menu, sel);
    menu.scrollTop = 0;

    let listReplaceCount = 0;
    const origListReplace = modelList.replaceChildren.bind(modelList);
    modelList.replaceChildren = (...args) => {
      listReplaceCount += 1;
      return origListReplace(...args);
    };

    api.setContextLatestForTest(
      { model: 'Gemini 4 Hydrogen (High)', modelId: 'MODEL_PLACEHOLDER_M28', actual: 1000, budget: 256000 },
      userStatusRes.userStatus.cascadeModelConfigData.clientModelConfigs
    );
    api.setContextScopeModeForTest('per_model');
    api.setQuotaSnapshotForTest({
      accountScopeKey: 'acct_scroll_guard',
      fetchedAtMs: nowMs,
      userStatusRes,
      quotaSummaryRes
    }, nowMs);
    api.switchContextTabForTest('models');
    panel.hidden = false;
    panel.scrollTop = 640;
    modelList.scrollTop = 95;
    viewQuota.scrollTop = 320;
    await h.flush();

    const listReplacesAfterInit = listReplaceCount;
    const timersBeforeBg = h.scheduledTimeouts.length;
    for (let i = 1; i <= 4; i++) {
      const nextSummary = JSON.parse(JSON.stringify(quotaSummaryRes));
      nextSummary.response.groups[0].buckets[0].remainingFraction = Math.max(0.1, 0.85 - i * 0.1);
      api.setQuotaSnapshotForTest({
        accountScopeKey: 'acct_scroll_guard',
        fetchedAtMs: nowMs + i * 1000,
        userStatusRes,
        quotaSummaryRes: nextSummary
      }, nowMs + i * 1000);
      api.ensureAlive?.();
      await h.flush();
    }

    const bgDropdownTimers = h.scheduledTimeouts.slice(timersBeforeBg).filter(t => !t.cleared && (t.ms === 30 || t.ms === 50));
    assert.equal(bgDropdownTimers.length, 0, '下拉菜单关闭时的后台刷新不得调度 30ms/50ms 滚动与聚焦定时器');
    assert.equal(scrollIntoViewCalls.length, 0, '后台数据与额度刷新绝不得调用 scrollIntoView');
    assert.equal(panel.scrollTop, 640, '后台刷新跨过定时器后外层 panel.scrollTop 必须保持在底部');
    assert.equal(modelList.scrollTop, 95, '后台刷新后模型列表 scrollTop 不应重置');
    assert.equal(listReplaceCount, listReplacesAfterInit, '模型列表结构未变时不得重复 replaceChildren');
    assert.equal(viewQuota.scrollTop, 320, '额度看板 view-quota scrollTop 必须保持不变');

    // 主动展开下拉菜单：仅调整下拉菜单自身 scrollTop，绝不触动外层 panel.scrollTop，focus 携带 preventScroll
    const timersBeforeOpen = h.scheduledTimeouts.length;
    trigger.click();
    for (const t of h.scheduledTimeouts.slice(timersBeforeOpen)) {
      if (!t.cleared && (t.ms === 30 || t.ms === 50)) t.fn();
    }
    await h.flush();
    assert.equal(wrap.classList.contains('is-open'), true);
    assert.equal(scrollIntoViewCalls.length, 0, '展开下拉菜单不得调用原生 scrollIntoView');
    assert.equal(panel.scrollTop, 640, '展开下拉菜单不得回弹或改写外层 panel.scrollTop');
    assert.ok(menu.scrollTop > 0, '选中项超出可视区时应仅滚动下拉菜单自身 scrollTop');
    assert.ok(
      focusCalls.some(c => String(c.cls || '').includes('ag-dropdown-search-input') && c.opts && c.opts.preventScroll === true),
      '展开后搜索框聚焦必须携带 { preventScroll: true }'
    );
  } finally {
    try { h.sandbox.__AGContextMeter.dispose(); } catch { }
  }
});

test('g1-ultra-tier 搭配 TEAMS_TIER_PRO 与 allowedTiers/New 角标不得误判为无权限', () => {
  const nowIso = '2026-11-16T02:32:00Z';
  const future5hIso = '2026-11-16T05:39:51Z';
  const futureWeekIso = '2026-11-21T01:38:49Z';
  const userStatusRes = {
    userStatus: {
      email: 'ultra.test@example.com',
      userTier: { id: 'g1-ultra-tier', name: 'Google AI Ultra', description: 'Google AI Ultra' },
      planStatus: { planInfo: { teamsTier: 'TEAMS_TIER_PRO', planName: 'Pro' } },
      cascadeModelConfigData: {
        clientModelConfigs: [
          {
            modelId: 'gemini-4-hydrogen-xhigh',
            label: 'Gemini 4 Hydrogen (XHigh)',
            modelOrAlias: { model: 'MODEL_PLACEHOLDER_M528' },
            tagTitle: 'New',
            disabled: false,
            allowedTiers: [
              'TEAMS_TIER_PRO',
              'TEAMS_TIER_TEAMS',
              'TEAMS_TIER_ENTERPRISE_SELF_HOSTED',
              'TEAMS_TIER_ENTERPRISE_SAAS',
              'TEAMS_TIER_HYBRID',
              'TEAMS_TIER_PRO_ULTIMATE'
            ],
            quotaInfo: { remainingFraction: 0.942896, resetTime: future5hIso }
          },
          {
            modelId: 'claude-sonnet-5-5-high',
            label: 'Claude Sonnet 5.5 (High)',
            modelOrAlias: { model: 'MODEL_PLACEHOLDER_M405' },
            tagTitle: 'New',
            disabled: false,
            allowedTiers: ['TEAMS_TIER_PRO', 'TEAMS_TIER_PRO_ULTIMATE'],
            quotaInfo: { remainingFraction: 1, resetTime: future5hIso }
          }
        ]
      }
    }
  };
  const quotaSummaryRes = {
    response: {
      groups: [
        {
          groupId: 'gemini',
          displayName: 'Gemini Models',
          description: 'Models within this group: Gemini 4 Hydrogen',
          buckets: [
            { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.942896, resetTime: future5hIso },
            { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.9264349, resetTime: futureWeekIso }
          ]
        },
        {
          groupId: '3p',
          displayName: 'Claude and GPT models',
          description: 'Models within this group: Claude Sonnet 5.5',
          buckets: [
            { bucketId: '3p-5h', window: '5h', remainingFraction: 1, resetTime: future5hIso }
          ]
        }
      ]
    }
  };

  const parsedPlan = core.parseUserPlanStatus(userStatusRes);
  assert.equal(parsedPlan.tierId, 'g1-ultra-tier');
  assert.equal(parsedPlan.teamsTier, 'TEAMS_TIER_PRO');

  const snap = core.buildModelQuotaSnapshot({
    userStatusRes,
    quotaSummaryRes,
    currentModel: 'MODEL_PLACEHOLDER_M528',
    nowMs: Date.parse(nowIso)
  });

  assert.equal(snap.activeStatus, 'available');
  assert.equal(snap.badge.text, '93%');
  const geminiPool = snap.pools.find(p => p.poolKey === 'shared_gemini_main');
  const claudePool = snap.pools.find(p => p.poolKey === 'shared_3p_pool');
  assert.equal(geminiPool?.noPermission, false);
  assert.equal(claudePool?.noPermission, false);
  assert.equal(geminiPool?.models[0]?.noPermission, false);
  assert.equal(claudePool?.models[0]?.noPermission, false);

  // Ultra 在缺少 teamsTier 时面对 TEAMS_TIER_PRO_ULTIMATE 也应放行
  const ultraNoTeams = core.classifyModelQuotaAvailability(
    { label: 'Gemini 4 Carbon', tagTitle: 'New', allowedTiers: ['TEAMS_TIER_PRO_ULTIMATE'] },
    { tierId: 'g1-ultra-tier', tierKey: 'ultra', teamsTier: null }
  );
  assert.equal(ultraNoTeams.noPermission, false);

  // 真正不在 allowedTiers 内的套餐应拦截且优先给出套餐原因而非装饰性 New 标签
  const freeBlocked = core.classifyModelQuotaAvailability(
    { label: 'Gemini 4 Carbon', tagTitle: 'New', allowedTiers: ['TEAMS_TIER_PRO_ULTIMATE'] },
    { tierId: 'free-tier', tierKey: 'free', teamsTier: 'TEAMS_TIER_FREE' }
  );
  assert.equal(freeBlocked.noPermission, true);
  assert.match(freeBlocked.reason || '', /TEAMS_TIER_PRO_ULTIMATE/);
});

test('ELV-83 全矩阵回归：Carbon/Hydrogen/Sonnet 权限校验、同账号缓存与切号隔离、三端一致性、首次桥接缺失与待重启边界', async () => {
  const pkgVersion = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version;
  const nowMs = Date.now();
  const future5hIso = new Date(nowMs + 3 * 3600000).toISOString();
  const futureWeekIso = new Date(nowMs + 4 * 86400000).toISOString();

  // 1. sanitizeCascadeModelConfig 必须剥离被装饰标签 New 污染的 unavailabilityReason
  const sanitizedDisabledNew = collector.sanitizeCascadeModelConfig({
    modelId: 'gemini-4-carbon-xhigh',
    label: 'Gemini 4 Carbon (XHigh)',
    tagTitle: 'New',
    disabled: true,
    unavailabilityReason: 'New',
    quotaInfo: { remainingFraction: 0.9, resetTime: future5hIso }
  });
  assert.equal(sanitizedDisabledNew.unavailable, true);
  assert.equal(sanitizedDisabledNew.unavailabilityReason, null);
  const availFromSanitized = core.classifyModelQuotaAvailability(sanitizedDisabledNew, {
    status: 'identified',
    tierKey: 'ultra',
    tierId: 'g1-ultra-tier',
    teamsTier: 'TEAMS_TIER_PRO'
  });
  assert.equal(availFromSanitized.noPermission, true, '服务端 disabled=true 即使带 90% 额度与匹配套餐也不得放行');
  assert.equal(availFromSanitized.reason, '当前套餐无权访问该模型');

  // 2. fetchQuotaSnapshotFromHost 同账号缓存与账号切换彻底隔离（含 Carbon/Hydrogen/Sonnet 全模型）
  collector.resetQuotaHostCacheForTest();
  let callIndex = 0;
  const ultraUserStatus = {
    userStatus: {
      email: 'ultra.acct@example.com',
      userTier: { id: 'g1-ultra-tier', name: 'Google AI Ultra' },
      planStatus: { planInfo: { teamsTier: 'TEAMS_TIER_PRO', planName: 'Pro' } },
      cascadeModelConfigData: {
        clientModelConfigs: [
          {
            modelId: 'gemini-4-carbon-xhigh',
            label: 'Gemini 4 Carbon (XHigh)',
            modelOrAlias: { model: 'MODEL_PLACEHOLDER_M670' },
            tagTitle: 'New',
            disabled: false,
            allowedTiers: ['TEAMS_TIER_PRO', 'TEAMS_TIER_PRO_ULTIMATE'],
            quotaInfo: { remainingFraction: 0.86, resetTime: future5hIso }
          },
          {
            modelId: 'gemini-4-hydrogen-xhigh',
            label: 'Gemini 4 Hydrogen (XHigh)',
            modelOrAlias: { model: 'MODEL_PLACEHOLDER_M528' },
            tagTitle: 'New',
            disabled: false,
            allowedTiers: ['TEAMS_TIER_PRO', 'TEAMS_TIER_PRO_ULTIMATE'],
            quotaInfo: { remainingFraction: 0.94, resetTime: future5hIso }
          },
          {
            modelId: 'claude-sonnet-5-5-high',
            label: 'Claude Sonnet 5.5 (High)',
            modelOrAlias: { model: 'MODEL_PLACEHOLDER_M405' },
            tagTitle: 'New',
            disabled: false,
            allowedTiers: ['TEAMS_TIER_PRO', 'TEAMS_TIER_PRO_ULTIMATE'],
            quotaInfo: { remainingFraction: 0, resetTime: futureWeekIso }
          }
        ]
      }
    }
  };
  const freeUserStatus = {
    userStatus: {
      email: 'free.acct@example.com',
      userTier: { id: 'free-tier', name: 'Free' },
      planStatus: { planInfo: { teamsTier: 'TEAMS_TIER_FREE', planName: 'Free' } },
      cascadeModelConfigData: {
        clientModelConfigs: [
          {
            modelId: 'gemini-4-carbon-xhigh',
            label: 'Gemini 4 Carbon (XHigh)',
            modelOrAlias: { model: 'MODEL_PLACEHOLDER_M670' },
            tagTitle: 'New',
            disabled: false,
            allowedTiers: ['TEAMS_TIER_PRO_ULTIMATE'],
            quotaInfo: { remainingFraction: 0.5, resetTime: future5hIso }
          },
          {
            modelId: 'gemini-4-hydrogen-xhigh',
            label: 'Gemini 4 Hydrogen (XHigh)',
            modelOrAlias: { model: 'MODEL_PLACEHOLDER_M528' },
            tagTitle: 'New',
            disabled: false,
            allowedTiers: ['TEAMS_TIER_PRO'],
            quotaInfo: { remainingFraction: 0.5, resetTime: future5hIso }
          }
        ]
      }
    }
  };
  const ultraQuotaSummary = {
    response: {
      groups: [
        {
          groupId: 'carbon',
          displayName: 'Gemini 4 Carbon',
          description: 'Models within this group: Gemini 4 Carbon',
          buckets: [{ bucketId: 'carbon-5h', window: '5h', remainingFraction: 0.86, resetTime: future5hIso }]
        },
        {
          groupId: 'gemini',
          displayName: 'Gemini Models',
          description: 'Models within this group: Gemini 4 Hydrogen',
          buckets: [{ bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.94, resetTime: future5hIso }]
        },
        {
          groupId: '3p',
          displayName: 'Claude and GPT models',
          description: 'Models within this group: Claude Sonnet 5.5',
          buckets: [{ bucketId: '3p-5h', window: '5h', remainingFraction: 0, resetTime: futureWeekIso }]
        }
      ]
    }
  };

  const mockConnect = async () => ({
    call: async (method) => {
      if (callIndex === 0) {
        return method === 'GetUserStatus' ? ultraUserStatus : ultraQuotaSummary;
      }
      if (callIndex === 1) {
        throw new Error('connect ETIMEDOUT 127.0.0.1');
      }
      if (callIndex === 2) {
        return method === 'GetUserStatus' ? freeUserStatus : { response: { groups: [] } };
      }
      throw new Error('ECONNREFUSED');
    }
  });

  // 2a. 首次 Ultra 账号获取：Carbon(86%) / Hydrogen(94%) 正常可用，Sonnet(0%) 为耗尽而非无权限
  const resUltra = await collector.fetchQuotaSnapshotFromHost({ connect: mockConnect, nowMs, currentModel: 'MODEL_PLACEHOLDER_M670' });
  assert.equal(resUltra.ok, true);
  assert.equal(resUltra.collectorVersion, pkgVersion);
  assert.equal(resUltra.planTierSummary.teamsTier, 'TEAMS_TIER_PRO');
  assert.equal(resUltra.snapshot.activeStatus, 'available');
  assert.equal(resUltra.snapshot.badge.text, '86%');
  const carbonPool = resUltra.snapshot.pools.find(p => p.poolKey === 'shared_gemini_carbon');
  const hydroPool = resUltra.snapshot.pools.find(p => p.poolKey === 'shared_gemini_main');
  const sonnetPool = resUltra.snapshot.pools.find(p => p.poolKey === 'shared_3p_pool');
  assert.equal(carbonPool?.noPermission, false);
  assert.equal(hydroPool?.noPermission, false);
  assert.equal(sonnetPool?.noPermission, false);
  assert.equal(sonnetPool?.status, 'exhausted');

  // 2b. 15s 内走同账号短缓存命中（不会触发错误路径）
  callIndex = 1;
  const resCached = await collector.fetchQuotaSnapshotFromHost({ connect: mockConnect, nowMs: nowMs + 5000 });
  assert.equal(resCached.ok, true);
  assert.equal(resCached.snapshot.pools.find(p => p.poolKey === 'shared_gemini_carbon')?.noPermission, false);

  // 2c. 强制刷新遇到网络失败：保留同账号最后有效快照并标为 stale
  const resStale = await collector.fetchQuotaSnapshotFromHost({ connect: mockConnect, force: true, nowMs: nowMs + 20000 });
  assert.equal(resStale.ok, false);
  assert.equal(resStale.errorKind, 'timeout');
  assert.equal(resStale.snapshot.syncState, 'stale');

  // 2d. 账号切换至 Free 受限账号：立即清掉 Ultra 旧缓存，所有受限模型切为 no_permission
  callIndex = 2;
  const resFree = await collector.fetchQuotaSnapshotFromHost({ connect: mockConnect, force: true, nowMs: nowMs + 30000, currentModel: 'MODEL_PLACEHOLDER_M670' });
  assert.equal(resFree.ok, true);
  assert.equal(resFree.accountSwitched, true);
  assert.equal(resFree.snapshot.activeStatus, 'no_permission');
  assert.equal(resFree.snapshot.pools.find(p => p.poolKey === 'shared_gemini_carbon')?.noPermission, true);
  assert.equal(resFree.snapshot.pools.find(p => p.poolKey === 'shared_gemini_main')?.noPermission, true);
  collector.resetQuotaHostCacheForTest();

  // 3. 渲染层三端一致性 + 桥接缺失 / 待重启提示 / 已重启不掩盖验证
  const h = createQuotaRendererHarness();
  try {
    for (const req of h.quotaRequests) {
      req.resolve({ ok: true, data: resUltra });
    }
    await h.flush();
    const api = h.sandbox.__AGContextMeter;
    api.setContextLatestForTest(
      { model: 'Gemini 4 Carbon (XHigh)', modelId: 'MODEL_PLACEHOLDER_M670', actual: 1000, budget: 256000 },
      resUltra.cascadeModelConfigs
    );
    api.switchContextTabForTest('models');
    api.showQuotaPanelForTest(true);
    await h.flush();

    const listEl = h.elements.get('ctx-model-list');
    const findChipByPart = part => {
      for (const grp of (listEl.children || [])) {
        for (const row of (grp.children || []).slice(1)) {
          const left = (row.children || []).find(c => c.className === 'ctx-product-row-left');
          const nameText = String((left?.children || [])[0]?.textContent || '').toLowerCase();
          if (nameText.includes(part.toLowerCase())) {
            const right = (row.children || []).find(c => c.className === 'ctx-product-row-right');
            return (right?.children || []).find(c => String(c.className || '').includes('ctx-model-quota-chip'));
          }
        }
      }
      return null;
    };
    const chipVal = chip => String((chip?.children || []).find(c => c.className === 'ctx-model-quota-val')?.textContent || '');

    // 3a. 顶栏、额度看板、上下文模型列表三端全部一致（Carbon 86%, Hydrogen 94%, Sonnet 耗尽）
    assert.equal(h.elements.get('quota-badge-val').textContent, '86%');
    assert.equal(h.elements.get('quota-cur-status').textContent, '正常可用');
    assert.equal(h.elements.get('quota-banner').hidden, true);
    assert.equal(h.elements.get('btn-quota-banner-restart').hidden, true);
    assert.equal(chipVal(findChipByPart('carbon')), '86%');
    assert.equal(chipVal(findChipByPart('hydrogen')), '94%');
    assert.equal(chipVal(findChipByPart('sonnet')), '耗尽');

    // 3b. 切换到受限 Free 账号：三端同时变为无权限，且已重启版本对齐下不得出现重启提示掩盖
    h.sandbox.window.contextMeterAPI.getQuota = async () => ({ ok: true, data: resFree });
    await api.refreshQuotaForTest(true);
    await h.flush();
    assert.equal(h.elements.get('quota-badge-val').textContent, '无权限');
    assert.equal(h.elements.get('quota-cur-status').textContent, '权限不足');
    assert.equal(chipVal(findChipByPart('carbon')), '无权限');
    assert.equal(chipVal(findChipByPart('hydrogen')), '无权限');
    assert.equal(h.elements.get('quota-banner').hidden, true, '版本已对齐且无待重启时，权限不足不得靠重启提示掩盖');
    assert.equal(h.elements.get('btn-quota-banner-restart').hidden, true);

    // 3c. 模拟应用内更新尚未重启（pendingUpdateRestart + 旧主进程版本）：才展示待重启横幅与重启按钮
    api.setPendingUpdateRestartForTest(true);
    h.sandbox.window.contextMeterAPI.getQuota = async () => ({
      ok: true,
      data: { ...resFree, collectorVersion: '0.8.5' }
    });
    await api.refreshQuotaForTest(true);
    await h.flush();
    assert.equal(h.elements.get('quota-banner').hidden, false);
    assert.equal(h.elements.get('btn-quota-banner-restart').hidden, false);
    assert.match(h.elements.get('quota-banner-text').textContent, /重启/);

    // 3d. 缺少任何额度桥接时：明确报 bridge_unavailable 并给出重启按钮，不卡在“未知”
    api.setPendingUpdateRestartForTest(false);
    delete h.sandbox.window.contextMeterAPI.getQuota;
    delete h.sandbox.window.__AGContextMeterLive;
    await api.refreshQuotaForTest(true);
    await h.flush();
    assert.equal(api.getModelQuotaStateForTest().state.errorKind, 'bridge_unavailable');
    assert.equal(h.elements.get('quota-banner').hidden, false);
    assert.equal(h.elements.get('btn-quota-banner-restart').hidden, false);
    assert.equal(h.elements.get('btn-quota-banner-retry').hidden, true);
    assert.match(h.elements.get('quota-banner-text').textContent, /桥接尚未加载|重启/);
  } finally {
    try { h.sandbox.__AGContextMeter.dispose(); } catch { }
  }
});

test('ELV-83 安装与热加载桥接核验：live-host 版本元数据、cli.js 不重复热注入且识别 getQuota 桥接', () => {
  const cliSrc = fs.readFileSync(path.join(__dirname, 'cli.js'), 'utf8');
  const liveHostSrc = fs.readFileSync(path.join(__dirname, 'live-host.js'), 'utf8');

  assert.match(liveHostSrc, /version:\s*PROJECT_VERSION/);
  assert.match(liveHostSrc, /hasQuota:\s*true/);
  assert.match(cliSrc, /hasQuotaIpcBridge:\s*Boolean\(window\.contextMeterAPI\?\.getQuota\)/);
  assert.match(cliSrc, /info\.hasQuota\s*&&\s*\(!currentPkgVersion\s*\|\|\s*info\.version\s*===\s*currentPkgVersion\)/);

  // cli.js install 命令不应在 install() 内部 tryHotInject 之后再重复调用第二次 tryHotInject
  const installSectionMatch = cliSrc.match(/if \(cmd === 'install'\) \{([\s\S]*?)\} else if \(cmd === 'live'\)/);
  assert.ok(installSectionMatch);
  assert.equal((installSectionMatch[1].match(/tryHotInject\(/g) || []).length, 0, 'cli.js install 分支不得重复触发第二次 tryHotInject');
});

test('跨平台 HTTP+HTTPS 多窗口 origin 隔离、系统代理免疫及非法端口/非回环拦截', async (t) => {
  const os = require('os');
  const http = require('http');
  const https = require('https');
  const crypto = require('crypto');

  // 生成纯 Node 自签本地回环证书（含 SAN 127.0.0.1）
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' });
  const derLen = (n) => (n < 128 ? Buffer.from([n]) : Buffer.from([0x81, n]));
  const tlv = (tag, body) => {
    const lb = body.length < 128 ? Buffer.from([body.length]) : (body.length < 256 ? Buffer.from([0x81, body.length]) : Buffer.from([0x82, body.length >> 8, body.length & 0xff]));
    return Buffer.concat([Buffer.from([tag]), lb, body]);
  };
  const seq = (...xs) => tlv(0x30, Buffer.concat(xs));
  const oid = (nums) => {
    const out = [nums[0] * 40 + nums[1]];
    for (let i = 2; i < nums.length; i++) {
      let v = nums[i];
      const enc = [v & 0x7f];
      while ((v >>= 7) > 0) enc.unshift((v & 0x7f) | 0x80);
      out.push(...enc);
    }
    return tlv(0x06, Buffer.from(out));
  };
  const utc = (d) => tlv(0x17, Buffer.from(
    String(d.getUTCFullYear()).slice(-2) +
    String(d.getUTCMonth() + 1).padStart(2, '0') + String(d.getUTCDate()).padStart(2, '0') +
    String(d.getUTCHours()).padStart(2, '0') + String(d.getUTCMinutes()).padStart(2, '0') + String(d.getUTCSeconds()).padStart(2, '0') + 'Z',
    'ascii'
  ));
  const shaAlg = seq(oid([1, 2, 840, 113549, 1, 1, 11]), Buffer.from([0x05, 0x00]));
  const name = seq(tlv(0x31, seq(oid([2, 5, 4, 3]), tlv(0x0c, Buffer.from('localhost', 'utf8')))));
  const sanExt = seq(oid([2, 5, 29, 17]), tlv(0x04, seq(tlv(0x82, Buffer.from('localhost', 'ascii')), tlv(0x87, Buffer.from([127, 0, 0, 1])))));
  const tbs = seq(tlv(0xa0, tlv(0x02, Buffer.from([2]))), tlv(0x02, Buffer.from([1])), shaAlg, name, seq(utc(new Date()), utc(new Date(Date.now() + 86400000))), name, spkiDer, tlv(0xa3, seq(sanExt)));
  const sig = crypto.createSign('RSA-SHA256').update(tbs).sign(privateKey);
  const certDer = seq(tbs, shaAlg, tlv(0x03, Buffer.concat([Buffer.from([0]), sig])));
  const certPem = `-----BEGIN CERTIFICATE-----\n${certDer.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`;
  const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });

  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-quota-multiwin-'));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const appDataDir = path.join(homeDir, 'Library', 'Application Support');
  fs.mkdirSync(path.join(appDataDir, 'Antigravity'), { recursive: true });

  // 窗口 1：HTTP 本地端口（模拟 Mac HTTP 主窗口，账号 A）
  let originA = '';
  let originB = '';
  const srvA = http.createServer((req, res) => {
    if (req.url === '/json/list') {
      res.end(JSON.stringify([
        { type: 'page', url: originA + '/c/conv-a' },
        { type: 'page', url: originB + '/c/conv-b' },
        { type: 'page', url: 'https://evil.example.com/c/ignore' }
      ]));
    } else if (req.url === '/') {
      res.end('<script>window.__APP_CONFIG__ = {"csrfToken":"csrf-win-a"};</script>');
    } else if (req.url.endsWith('/GetUserStatus')) {
      assert.equal(req.headers['x-codeium-csrf-token'], 'csrf-win-a');
      res.end(JSON.stringify({ userStatus: { email: 'alice@example.com' } }));
    } else {
      res.end(JSON.stringify({ response: { groups: [] } }));
    }
  });
  await new Promise(r => srvA.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => srvA.close(r)));
  originA = `http://127.0.0.1:${srvA.address().port}`;

  // 窗口 2：HTTPS 本地端口（模拟 HTTPS 主窗口，账号 B）
  const srvB = https.createServer({ key: keyPem, cert: certPem }, (req, res) => {
    if (req.url === '/') {
      res.end('<script>window.__APP_CONFIG__ = {"csrfToken":"csrf-win-b"};</script>');
    } else if (req.url.endsWith('/GetUserStatus')) {
      assert.equal(req.headers['x-codeium-csrf-token'], 'csrf-win-b');
      res.end(JSON.stringify({ userStatus: { email: 'bob@example.com' } }));
    } else {
      res.end(JSON.stringify({ response: { groups: [] } }));
    }
  });
  await new Promise(r => srvB.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => srvB.close(r)));
  originB = `https://127.0.0.1:${srvB.address().port}`;

  fs.writeFileSync(path.join(appDataDir, 'Antigravity', 'DevToolsActivePort'), `${srvA.address().port}\n/devtools/browser/test\n`);

  const prevHttpProxy = process.env.HTTP_PROXY;
  const prevHttpsProxy = process.env.HTTPS_PROXY;
  const prevRejectTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.HTTP_PROXY = 'http://127.0.0.1:1';
  process.env.HTTPS_PROXY = 'http://127.0.0.1:1';
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  t.after(() => {
    if (prevHttpProxy === undefined) delete process.env.HTTP_PROXY; else process.env.HTTP_PROXY = prevHttpProxy;
    if (prevHttpsProxy === undefined) delete process.env.HTTPS_PROXY; else process.env.HTTPS_PROXY = prevHttpsProxy;
    if (prevRejectTls === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED; else process.env.NODE_TLS_REJECT_UNAUTHORIZED = prevRejectTls;
  });

  // 按 origin 分别拉取额度快照，绝不串用账号与 token
  const resA = await collector.fetchQuotaSnapshotFromHost({
    force: true,
    origin: originA,
    connect: (opts) => connectLocalApi({ ...opts, appDataDir })
  });
  const resB = await collector.fetchQuotaSnapshotFromHost({
    force: true,
    origin: originB,
    connect: (opts) => connectLocalApi({ ...opts, appDataDir })
  });

  assert.equal(resA.ok, true);
  assert.equal(resB.ok, true);
  assert.equal(resA.originScope, originA);
  assert.equal(resB.originScope, originB);
  assert.ok(resA.accountScopeKey && resB.accountScopeKey);
  assert.notEqual(resA.accountScopeKey, resB.accountScopeKey);

  // 通过 /json/list 发现并保留多窗口 origins 列表
  const multiConn = await connectLocalApi({ appDataDir });
  assert.deepEqual(multiConn.origins, [originA, originB]);

  // 非回环或非法端口 origin 必须拒绝
  await assert.rejects(() => connectLocalApi({ appDataDir, origin: 'https://evil.example.com:8443' }), /非法的本机回环页面地址/);
  await assert.rejects(() => connectLocalApi({ appDataDir, origin: 'http://127.0.0.1:70000' }), /非法的本机回环页面地址/);
});

test('隔离额度请求遇到窗口未就绪、CSRF 缺失及 401/403 鉴权失败时准确报错且不误报耗尽/无权限', async (t) => {
  const os = require('os');
  const http = require('http');
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-quota-auth-'));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const appDataDir = path.join(homeDir, 'Library', 'Application Support');
  fs.mkdirSync(path.join(appDataDir, 'Antigravity'), { recursive: true });

  // 场景 1：页面尚无 __APP_CONFIG__（窗口未就绪）
  let originNotReady = '';
  const srvNotReady = http.createServer((req, res) => {
    if (req.url === '/json/list') {
      res.end(JSON.stringify([{ type: 'page', url: originNotReady + '/c/1' }]));
    } else {
      res.end('<html><body>loading...</body></html>');
    }
  });
  await new Promise(r => srvNotReady.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => srvNotReady.close(r)));
  originNotReady = `http://127.0.0.1:${srvNotReady.address().port}`;
  fs.writeFileSync(path.join(appDataDir, 'Antigravity', 'DevToolsActivePort'), `${srvNotReady.address().port}\n/devtools/browser/1\n`);

  const notReadyRes = await collector.fetchQuotaSnapshotFromHost({
    force: true,
    origin: originNotReady,
    connect: (opts) => connectLocalApi({ ...opts, appDataDir })
  });
  assert.equal(notReadyRes.ok, false);
  assert.equal(notReadyRes.errorKind, 'network');
  assert.match(notReadyRes.error, /尚未就绪|连接/);
  assert.notEqual(notReadyRes.snapshot.activeStatus, 'exhausted');
  assert.notEqual(notReadyRes.snapshot.activeStatus, 'no_permission');

  // 场景 2：页面存在 __APP_CONFIG__ 但缺少 csrfToken
  let originNoCsrf = '';
  const srvNoCsrf = http.createServer((req, res) => {
    if (req.url === '/json/list') {
      res.end(JSON.stringify([{ type: 'page', url: originNoCsrf + '/c/1' }]));
    } else {
      res.end('<script>window.__APP_CONFIG__ = {};</script>');
    }
  });
  await new Promise(r => srvNoCsrf.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => srvNoCsrf.close(r)));
  originNoCsrf = `http://127.0.0.1:${srvNoCsrf.address().port}`;

  const noCsrfRes = await collector.fetchQuotaSnapshotFromHost({
    force: true,
    origin: originNoCsrf,
    connect: (opts) => connectLocalApi({ ...opts, appDataDir })
  });
  assert.equal(noCsrfRes.ok, false);
  assert.equal(noCsrfRes.errorKind, 'auth');
  assert.match(noCsrfRes.error, /鉴权/);
  assert.notEqual(noCsrfRes.snapshot.activeStatus, 'exhausted');
  assert.notEqual(noCsrfRes.snapshot.activeStatus, 'no_permission');

  // 场景 3：RPC 返回 HTTP 403 Unauthorized
  let origin403 = '';
  const srv403 = http.createServer((req, res) => {
    if (req.url === '/') {
      res.end('<script>window.__APP_CONFIG__ = {"csrfToken":"tok-403"};</script>');
    } else {
      res.statusCode = 403;
      res.end('HTTP 403 Forbidden');
    }
  });
  await new Promise(r => srv403.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => srv403.close(r)));
  origin403 = `http://127.0.0.1:${srv403.address().port}`;

  const authFailRes = await collector.fetchQuotaSnapshotFromHost({
    force: true,
    origin: origin403,
    connect: (opts) => connectLocalApi({ ...opts, appDataDir })
  });
  assert.equal(authFailRes.ok, false);
  assert.equal(authFailRes.errorKind, 'auth');
  assert.notEqual(authFailRes.snapshot.activeStatus, 'exhausted');
  assert.notEqual(authFailRes.snapshot.activeStatus, 'no_permission');
});

test('Antigravity v2.33 合并 Gemini 池与 Gemini 4 Neon / Orchestrator (Neon) 顶栏额度准确匹配', async () => {
  assert.equal(core.getModelPoolKey('Gemini 4 Neon (High)'), 'gemini-4-neon');
  assert.equal(core.getModelPoolKey('gemini-4-neon-high'), 'gemini-4-neon');
  assert.equal(core.getModelPoolKey('Orchestrator (Neon)'), 'gemini-4-neon');
  assert.equal(core.getModelPoolKey('gemini-pro-orchestrator-neon'), 'gemini-4-neon');
  assert.equal(core.getSharedQuotaGroupKey('Gemini 4 Neon (High)'), 'shared_gemini_main');
  assert.equal(core.getSharedQuotaGroupKey('Orchestrator (Neon)'), 'shared_gemini_main');
  // 保持 Argon 独立映射语义不变
  assert.equal(core.getModelPoolKey('Orchestrator (Argon)'), 'gemini-4-argon');
  assert.equal(core.getSharedQuotaGroupKey('Orchestrator (Argon)'), 'shared_gemini_argon');

  const nowIso = '2026-11-19T14:03:30Z';
  const nowMs = Date.parse(nowIso);
  const future5hIso = '2026-11-19T17:53:00Z';
  const futureWeekIso = '2026-11-26T05:09:00Z';

  const v233Configs = [
    { label: 'Gemini 4 Neon (High)', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M701' }, quotaInfo: { remainingFraction: 0.81, resetTime: futureWeekIso } },
    { label: 'Gemini 4 Neon (Low)', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M702' }, quotaInfo: { remainingFraction: 0.81, resetTime: futureWeekIso } },
    { label: 'Gemini 4 Hydrogen (High)', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M28' }, quotaInfo: { remainingFraction: 0.81, resetTime: futureWeekIso } },
    { label: 'Orchestrator (Neon)', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M705' }, quotaInfo: { remainingFraction: 0.81, resetTime: futureWeekIso } },
    { label: 'Orchestrator (Argon)', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M668' }, modelId: 'gemini-pro-orchestrator-g1-pro', quotaInfo: { remainingFraction: 0.81, resetTime: futureWeekIso } },
    { label: 'Gemini 3.8 Flash (High)', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M39' }, quotaInfo: { remainingFraction: 0.81, resetTime: futureWeekIso } },
    { label: 'Claude Opus 5.5 (High)', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M41' }, quotaInfo: { remainingFraction: 1.0, resetTime: futureWeekIso } }
  ];

  const v233Summary = {
    response: {
      groups: [
        {
          groupId: 'gemini',
          displayName: 'Gemini Models',
          description: 'Models within this group: Gemini 4 Neon, Gemini 4 Hydrogen, Orchestrator (Neon), Orchestrator (Argon), Gemini 3.8 Flash',
          buckets: [
            { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.81, resetTime: futureWeekIso },
            { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.95, resetTime: future5hIso }
          ]
        },
        {
          groupId: '3p',
          displayName: 'Claude & GPT',
          description: 'Models within this group: Claude Opus 5.5',
          buckets: [
            { bucketId: '3p-weekly', window: 'weekly', remainingFraction: 1.0, resetTime: futureWeekIso }
          ]
        }
      ]
    }
  };

  // 1. 合并池包含 Orchestrator (Argon) 与 Neon/Hydrogen/Flash 时，应归为 shared_gemini_main 而非 shared_gemini_argon
  const snap = core.buildModelQuotaSnapshot({
    cascadeModelConfigs: v233Configs,
    quotaSummaryRes: v233Summary,
    currentModel: { modelId: 'gemini-4-neon-high', label: 'Gemini 4 Neon (High)' },
    fetchMeta: { fetchedAtMs: nowMs },
    nowMs
  });
  const geminiPool = snap.pools.find(p => p.poolKey === 'shared_gemini_main');
  assert.ok(geminiPool, '合并后的 Gemini 池应保持 shared_gemini_main 键名');
  assert.equal(snap.activeStatus, 'available');
  assert.equal(snap.badge.text, '81%');
  assert.equal(snap.currentModel?.productLabel, 'Gemini 4 Neon');

  // 2. modelId 为未知占位符但 label 可匹配产品名时（兼容未来新模型），也能准确匹配所在池
  const snapByLabel = core.buildModelQuotaSnapshot({
    cascadeModelConfigs: [
      ...v233Configs,
      { label: 'Gemini 4 Krypton (High)', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M990' }, quotaInfo: { remainingFraction: 0.81, resetTime: futureWeekIso } }
    ],
    quotaSummaryRes: {
      response: {
        groups: [
          {
            ...v233Summary.response.groups[0],
            description: v233Summary.response.groups[0].description + ', Gemini 4 Krypton'
          },
          v233Summary.response.groups[1]
        ]
      }
    },
    currentModel: { modelId: 'MODEL_PLACEHOLDER_UNKNOWN_999', label: 'Gemini 4 Krypton (High)' },
    fetchMeta: { fetchedAtMs: nowMs },
    nowMs
  });
  assert.equal(snapByLabel.activeStatus, 'available');
  assert.equal(snapByLabel.badge.text, '81%');
  assert.equal(snapByLabel.currentModel?.productLabel, 'Gemini 4 Krypton');

  // 3. 渲染层仅拿到标准化 snapshot（无 rawInput）且当前会话为 gemini-4-neon-high 时，顶栏显示 81% 而非未知
  const snapWithoutCurrent = core.buildModelQuotaSnapshot({
    cascadeModelConfigs: v233Configs,
    quotaSummaryRes: v233Summary,
    currentModel: null,
    fetchMeta: { fetchedAtMs: nowMs },
    nowMs
  });
  const h = createQuotaRendererHarness();
  try {
    for (const req of h.quotaRequests) {
      req.resolve({
        ok: true,
        data: {
          snapshot: snapWithoutCurrent,
          cascadeModelConfigs: v233Configs,
          fetchedAtMs: nowMs,
          nextRefreshAtMs: nowMs + 60000
        }
      });
    }
    await h.flush();
    const api = h.sandbox.__AGContextMeter;
    api.setContextLatestForTest(
      { model: 'Gemini 4 Neon (High)', modelId: 'gemini-4-neon-high', actual: 18000, budget: 256000 },
      v233Configs
    );
    await h.flush();
    assert.equal(h.elements.get('quota-badge-val').textContent, '81%');
  } finally {
    try { h.sandbox.__AGContextMeter.dispose(); } catch { }
  }
});
