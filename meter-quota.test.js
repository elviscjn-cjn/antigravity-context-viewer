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
      dispatchEvent(ev) { listeners.get(el)?.get(ev?.type)?.(ev); },
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

test('PR #66 加固：额度 IPC 拒绝渲染进程伪造 origin/userStatus 且 401 失败不覆盖有效账号快照', async (t) => {
  const { registerMeterIpcHandlers } = require('./meter-main');
  const handlers = new Map();
  registerMeterIpcHandlers({ handle: (channel, handler) => handlers.set(channel, handler) });
  const getQuota = handlers.get('context-meter:get-quota');
  const syncActiveHostQuotaSnapshot = t.mock.fn();
  const detectCurrentActiveAccount = t.mock.fn(async () => ({ email: 'fallback@example.com' }));
  t.mock.method(require('./meter-accounts'), 'getSharedAccountsManager', () => ({
    syncActiveHostQuotaSnapshot,
    detectCurrentActiveAccount,
    getOverviewState: () => ({})
  }));
  const { userStatusRes, quotaSummaryRes } = buildRealistic2321Fixtures();
  const observedOrigins = [];
  let forceUnauthorized = false;
  t.mock.method(collector, 'fetchQuotaSnapshotFromHost', async (opts) => {
    observedOrigins.push({ origin: opts.origin, hasFakeUserStatus: 'userStatus' in opts });
    if (forceUnauthorized) {
      return { ok: false, error: 'HTTP 401', errorKind: 'auth', snapshot: { syncState: 'stale', pools: [] } };
    }
    const nowTs = Date.now();
    return {
      ok: true,
      error: null,
      fetchedAtMs: nowTs,
      snapshot: core.buildModelQuotaSnapshot({ userStatusRes, quotaSummaryRes, fetchMeta: { fetchedAtMs: nowTs }, nowMs: nowTs }),
      _raw: { planStatus: { email: 'real-quota@example.com' } }
    };
  });
  const origin = 'http://127.0.0.1:58234';
  const frame = { url: `${origin}/chat` };
  const event = { senderFrame: frame, sender: { mainFrame: frame } };

  const okRes = await getQuota(event, { force: true, origin: 'http://127.0.0.1:59999', userStatus: { fake: true } });
  assert.equal(okRes.ok, true);
  assert.equal(okRes.data.ok, true);
  assert.deepEqual(observedOrigins, [{ origin, hasFakeUserStatus: false }]);
  assert.equal(syncActiveHostQuotaSnapshot.mock.callCount(), 1);
  assert.equal(syncActiveHostQuotaSnapshot.mock.calls[0].arguments[1], 'real-quota@example.com');

  forceUnauthorized = true;
  const failRes = await getQuota(event, { force: true });
  assert.equal(failRes.ok, true);
  assert.equal(failRes.data.ok, false);
  assert.equal(syncActiveHostQuotaSnapshot.mock.callCount(), 1, '刷新失败时不得覆盖已有账号快照');
  await assert.rejects(getQuota({ ...event, senderFrame: { url: frame.url } }), /仅允许本机主聊天窗口/);
});

test('顶栏入口顺序、独立弹窗锚点、防底裁切 maxHeight 与 Notice: New 过滤', () => {
  const tpl = fs.readFileSync(path.join(__dirname, 'src/renderer/template.html'), 'utf8');
  const mtbSrc = fs.readFileSync(path.join(__dirname, 'src/renderer/morph-indicator-toolbar.js'), 'utf8');
  // v3 任务书 4.1：五槽位胶囊迁至主窗会话头 morph-indicator-toolbar.js，额度入口位于最左侧，上下文与速度紧邻
  assert.match(mtbSrc, /quota[\s\S]{0,200}context[\s\S]{0,200}speed|SLOT_ORDER/, 'v3 五槽位胶囊中额度入口必须位于工具组最左侧且上下文紧邻速度');
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

  const mainBoard = h.elements.get('quota-main-board');
  const getBoardRows = () => mainBoard.children.filter(ch => String(ch.className || '').includes('quota-row'));
  const rowsBefore = getBoardRows();
  assert.ok(rowsBefore.length >= 4, '10.html 主看板应渲染至少两池四行');
  const gem5hRowBefore = rowsBefore.find(r => r.getAttribute('data-row-id') === 'gemini-5h');
  assert.ok(gem5hRowBefore);
  assert.equal(h.elements.get('quota-badge-val').textContent, '45%');

  const drainBoardTimersAndRafs = async () => {
    for (let step = 0; step < 30; step++) {
      h.stepRaf(120);
      await h.flush();
      for (const t of h.scheduledTimeouts.filter(t => !t.cleared && t.ms > 0 && t.ms < 900)) {
        t.cleared = true;
        t.fn();
      }
      await h.flush();
    }
  };

  // 1. 连点两次手动刷新 -> 严格合并只发 1 次 RPC，且请求中复用 DOM 行且顶栏不归零
  const reqBefore = h.quotaRequests.length;
  const rp1 = api.refreshQuotaForTest(true, { manual: true });
  const rp2 = api.refreshQuotaForTest(true, { manual: true });
  assert.equal(h.quotaRequests.length, reqBefore + 1);
  assert.equal(h.elements.get('quota-badge-val').textContent, '45%');
  assert.equal(getBoardRows().find(r => r.getAttribute('data-row-id') === 'gemini-5h'), gem5hRowBefore);

  // 返回新值 85% (从 45% 变 85%) -> DOM 行 100% 复用，且顶栏 rAF 220ms 平滑数字过渡
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
  assert.equal(getBoardRows().find(r => r.getAttribute('data-row-id') === 'gemini-5h'), gem5hRowBefore, '刷新后必须复用同一个主看板行 DOM 节点');

  // 顶栏 rAF 中途 (110ms) 处于 45% 和 85% 之间的中间数值，绝不从 0 重播
  h.stepRaf(110);
  const midPct = parseInt(h.elements.get('quota-badge-val').textContent, 10);
  assert.ok(midPct > 45 && midPct < 85, `平滑动画中点应落在 (45, 85)，实际为 ${midPct}%`);

  // 连续触发第二次手动刷新并回落到 60% -> 安全打断旧动画并落到 60%
  const nextSummary2 = JSON.parse(JSON.stringify(quotaSummaryRes));
  nextSummary2.response.groups[0].buckets[0].remainingFraction = 0.6;
  const rp3 = api.refreshQuotaForTest(true, { manual: true, skipScanFloor: true });
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
  await drainBoardTimersAndRafs();
  assert.equal(h.elements.get('quota-badge-val').textContent, '60%');

  // 2. 手动刷新返回完全一致的数据 -> 落稳后展示轻量 "已更新" 提示与 "✓ 已刷新"
  for (const t of h.scheduledTimeouts.filter(t => !t.cleared && t.ms === 900)) {
    t.cleared = true;
    t.fn();
  }
  const rp4 = api.refreshQuotaForTest(true, { manual: true, skipScanFloor: true });
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
  await drainBoardTimersAndRafs();
  assert.equal(h.elements.get('quota-refresh-feedback').hidden, false);
  assert.equal(h.elements.get('quota-refresh-feedback').textContent, '已更新');

  // 3. 刷新失败保留已有数据与进度条，不归零
  const rpErr = api.refreshQuotaForTest(true, { manual: true, skipScanFloor: true });
  h.quotaRequests[h.quotaRequests.length - 1].resolve({
    ok: true,
    data: { ok: false, error: 'timeout', errorKind: 'network' }
  });
  await rpErr;
  await drainBoardTimersAndRafs();
  assert.equal(api.getQuotaBoardStateForTest().rows.find(r => r.id === 'gemini-5h').visualLitCount, 12, '失败回滚后必须恢复原 60% 对应 12 格');
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
  while (hReduced.quotaRequests.length > 0) {
    hReduced.quotaRequests.shift().resolve({
      ok: true,
      data: {
        ok: true,
        accountScopeKey: 'acct_rm',
        fetchedAtMs: nowMs,
        lastSuccessAtMs: nowMs,
        snapshot: core.buildModelQuotaSnapshot({ userStatusRes, quotaSummaryRes, currentModel: 'MODEL_PLACEHOLDER_M38', fetchMeta: { fetchedAtMs: nowMs }, nowMs })
      }
    });
    await hReduced.flush();
  }
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
  const gem5hGuardRow = h.elements.get('quota-main-board').children.find(c => c.getAttribute('data-row-id') === 'gemini-5h');
  const gem5hGuardCaption = gem5hGuardRow.children[0].children[4];
  assert.match(gem5hGuardCaption.textContent, /检测到未采集消耗或采样失真/);
  assert.doesNotMatch(gem5hGuardCaption.textContent, /实耗差值校准/);
  assert.equal(/[()（）]/.test(gem5hGuardCaption.textContent), false, '估算提示应零中英文括号');

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
  const gem5hGuardRow2 = h.elements.get('quota-main-board').children.find(c => c.getAttribute('data-row-id') === 'gemini-5h');
  const gem5hGuardCaption2 = gem5hGuardRow2.children[0].children[4];
  assert.match(gem5hGuardCaption2.textContent, /历史校准不可靠.*检测到未采集消耗/);
  assert.doesNotMatch(gem5hGuardCaption2.textContent, /实耗差值校准/);
  assert.equal(/[()（）]/.test(gem5hGuardCaption2.textContent), false, '异常告警估算提示应零中英文括号');

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
  assert.match(initialNextText, /· 3分/);
  assert.equal(/[()（）]/.test(initialNextText), false, '下次自动刷新文案必须零括号');

  // 2. 连续快速点击（调用 refreshQuotaForTest 两次），期间校验不叠加请求、不闪烁按钮文字/下次刷新时间、不清空卡片
  const p1 = api.refreshQuotaForTest(true, { manual: true });
  const p2 = api.refreshQuotaForTest(true, { manual: true });
  assert.equal(getQuotaCallCount, 1);
  assert.equal(btnRefresh.disabled, true);
  assert.equal(btnRefresh.getAttribute('data-busy'), 'true');
  assert.equal(btnRefreshText.textContent, '刷新');
  assert.equal(tNext.textContent, initialNextText);
  assert.notEqual(h.elements.get('quota-cur-model').textContent, '暂未识别当前模型');

  // 3. 首次手动刷新返回“数据未变化”同内容新快照 -> 触发已更新反馈、进度条行 DOM 原地复用不重建
  const sameViewSnap = api.getModelQuotaStateForTest(nowMs).view;
  const mainBoard = h.elements.get('quota-main-board');
  const firstRowRef = mainBoard.children.find(c => String(c.className || '').includes('quota-row'));
  assert.ok(firstRowRef, '主看板必须渲染 10.html 配额行');
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
  assert.equal(mainBoard.children.find(c => String(c.className || '').includes('quota-row')), firstRowRef);
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

  // 4. 模拟刷新失败：保留现有旧值，横幅显示错误，不归零，且先前“已更新”反馈应自动收起
  const beforeErrBadge = h.elements.get('quota-badge-val').textContent;
  const pErr = api.refreshQuotaForTest(true, { manual: true, skipScanFloor: true });
  resolveNextRpc({ ok: false, error: '模拟超时' });
  await pErr;
  for (let i = 0; i < 30; i++) {
    h.stepRaf(120);
    await h.flush();
  }
  assert.equal(h.elements.get('quota-badge-val').textContent, beforeErrBadge);
  assert.equal(h.elements.get('quota-banner').hidden, false);
  assert.match(h.elements.get('quota-banner-text').textContent, /模拟超时/);
  assert.equal(fbEl.hidden, true);
  assert.equal(viewQuotaEl.scrollTop, 148);
  assert.equal(curModelTextWrites, 0, '模型名称未变时不应触发多余 DOM textContent 写入');

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

  const mainBoard = h.elements.get('quota-main-board');
  const getRow = (rowId) => mainBoard.children.find(c => c.getAttribute('data-row-id') === rowId);
  const getCells = (row) => row.children[0].children[1].children[0].children;
  const getRail = (row) => row.children[0].children[2];
  const getDial = (row) => row.children[1].children[0];

  const gem5hRow = getRow('gemini-5h');
  const p3p7dRow = getRow('shared-7d');
  const p3p5hRow = getRow('shared-5h');
  const argonRow = mainBoard.children.find(c => String(c.getAttribute('data-row-id') || '').includes('argon'));
  assert.ok(gem5hRow && p3p7dRow && p3p5hRow && argonRow, '主看板应包含双池四行及额外独立池行');
  assert.equal(getCells(p3p7dRow).filter(c => c.children[0].getAttribute('data-cell-active') === 'true').length, 0, '0% 耗尽行 20 格全空');
  assert.equal(p3p7dRow.getAttribute('data-red-alert'), 'true', '0% 耗尽保持红警');
  assert.equal(argonRow.getAttribute('data-quota-state'), 'unknown', '未知池保持独立未知状态');
  assert.equal(argonRow.getAttribute('data-red-alert'), 'false', '未知池绝不得误标为红警');

  // 1. 阶段一退潮归零 + 慢回包进入纯中性灰扫描（真实回包未到绝不报成功，且真实快照未清空）
  const btnRefresh = h.elements.get('btn-quota-refresh');
  const txtRefresh = h.elements.get('quota-refresh-text');
  const pManual1 = api.refreshQuotaForTest(true, { manual: true });
  assert.equal(btnRefresh.getAttribute('data-refresh-state'), 'loading');
  assert.equal(txtRefresh.textContent, '刷新');
  assert.equal(api.getQuotaBoardStateForTest().phase, 'drain', '手动刷新启动应立即进入 Stage 1 退潮');

  // 推进 Stage 1 退潮到完全归零 (0.3x 节奏下约 500-700ms) -> 检查全空零残留并自动进入中性灰扫描
  for (let i = 0; i < 10; i++) {
    h.stepRaf(100);
    await h.flush();
  }
  assert.equal(api.getQuotaBoardStateForTest().phase, 'scan', 'RPC 尚未返回时退潮完成后必须自动进入中性灰单格扫描');
  assert.equal(getCells(gem5hRow).filter(c => c.children[0].style.opacity === '1').length, 0, '全空扫描帧 20 格绝无彩色残留');
  assert.equal(getRail(gem5hRow).children[0].children[0].style.width, '0%', '全空扫描帧 4px 基准轨 base 必须 0% 清空');
  assert.equal(getRail(gem5hRow).children[0].children[1].style.width, '0%', '全空扫描帧 4px 基准轨 delta 必须 0% 清空');
  assert.equal(getRail(gem5hRow).children[1].style.opacity, '0', '全空扫描帧白色游标必须隐去');
  const gem5hSummaryNodes = gem5hRow.children[0].children[0].children[1].children;
  const gem5hPctNode = gem5hSummaryNodes.find(n => String(n.className || '').includes('row-pct'));
  assert.equal(gem5hPctNode?.textContent, '--%', '扫描等待期间百分比应显示 --%');
  assert.equal(getDial(gem5hRow).classList.contains('is-fetching'), true, '扫描等待期间 70px 圆盘应进入 is-fetching 轨道旋转');
  assert.equal(h.elements.get('quota-badge-val').textContent, '45%', '展示层退潮扫描绝不能清空顶栏或真实可信快照');
  // 再步进一帧验证中性灰 scan-peak / scan-mid 扫描生效
  h.stepRaf(180);
  await h.flush();
  const scanHighlightCount = getCells(gem5hRow).filter(c => c.classList.contains('scan-peak') || c.classList.contains('scan-mid')).length;
  assert.ok(scanHighlightCount >= 1, '慢回包扫描阶段必须存在纯中性灰 scan-peak / scan-mid 单元格');

  // 2. 真实回包到达 -> 先走 200ms 全空换气停顿 -> Stage 2 逐格机械上电 -> 落稳前按钮绝不报成功
  const sameSnap = core.buildModelQuotaSnapshot({
    userStatusRes,
    quotaSummaryRes,
    currentModel: { modelId: 'MODEL_PLACEHOLDER_M28', label: 'Gemini 4 Hydrogen (High)' },
    fetchMeta: { fetchedAtMs: nowMs + 1500 },
    nowMs: nowMs + 1500
  });
  resolveNextRpc({
    ok: true,
    data: { ok: true, accountScopeKey: 'acct_charge_test', fetchedAtMs: nowMs + 1500, lastSuccessAtMs: nowMs + 1500, snapshot: sameSnap }
  });
  await pManual1;
  await h.flush();

  assert.equal(api.getQuotaBoardStateForTest().phase, 'pause', '真实回包到达后先走全空换气停顿');
  assert.equal(btnRefresh.getAttribute('data-refresh-state'), 'loading', '停顿与回充未落稳前绝不报成功');
  const pauseTimers = h.scheduledTimeouts.filter(t => !t.cleared && t.ms === 200);
  assert.ok(pauseTimers.length >= 1, '0.3x 节奏全空换气停顿应为 200ms');
  for (const t of pauseTimers) { t.cleared = true; t.fn(); }
  await h.flush();

  assert.equal(api.getQuotaBoardStateForTest().phase, 'refill', '停顿结束后进入 Stage 2 逐格上电');
  h.stepRaf(200);
  await h.flush();
  assert.equal(btnRefresh.getAttribute('data-refresh-state'), 'loading', '回充中途按钮仍为 loading 不提前报成功');

  // 推进完成全部回充与圆盘落稳
  for (let i = 0; i < 20; i++) {
    h.stepRaf(120);
    await h.flush();
  }
  assert.equal(api.getQuotaBoardStateForTest().phase, 'idle');
  assert.equal(btnRefresh.getAttribute('data-refresh-state'), 'done', '仅在逐格上电与圆盘落稳后按钮才切为 done');
  assert.equal(txtRefresh.textContent, '✓ 已刷新');
  assert.equal(getCells(gem5hRow).filter(c => c.children[0].getAttribute('data-cell-active') === 'true').length, 10, '45.06% 落稳后点亮 10 格');
  assert.equal(getDial(gem5hRow).classList.contains('dial-settle-pulse'), true, '70px 圆盘落稳应触发 dial-settle-pulse');
  const doneHoldTimers = h.scheduledTimeouts.filter(t => t.ms === 900 && !t.cleared);
  assert.equal(doneHoldTimers.length, 1, '薄荷绿完成态应保持 900ms 后回 idle');
  doneHoldTimers[0].cleared = true;
  doneHoldTimers[0].fn();
  assert.equal(btnRefresh.getAttribute('data-refresh-state'), 'idle');
  assert.equal(txtRefresh.textContent, '刷新');

  // 3. 自动静默轮询绝不触发退潮归零
  const pAuto = api.refreshQuotaForTest(false, { silent: true });
  resolveNextRpc({
    ok: true,
    data: { ok: true, accountScopeKey: 'acct_charge_test', fetchedAtMs: nowMs + 3000, lastSuccessAtMs: nowMs + 3000, snapshot: sameSnap }
  });
  await pAuto;
  assert.equal(api.getQuotaBoardStateForTest().phase, 'idle');

  // 4. 失败响应优雅回充恢复旧数据，不报成功，不卡死在 0%
  const pFail = api.refreshQuotaForTest(true, { manual: true, skipScanFloor: true });
  resolveNextRpc({ ok: false, error: '请求失败' });
  await pFail;
  for (let i = 0; i < 25; i++) {
    h.stepRaf(120);
    await h.flush();
  }
  assert.equal(btnRefresh.getAttribute('data-refresh-state'), 'error');
  assert.equal(getCells(gem5hRow).filter(c => c.children[0].getAttribute('data-cell-active') === 'true').length, 10, '失败回滚后必须恢复原 10 格，绝不留在 0%');

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
  await h.flush();

  const bState = api.getQuotaBoardStateForTest();
  assert.equal(bState.phase, 'idle', '减弱动效模式下不进入退潮/扫描/逐格动画，直接静态落稳');
  assert.equal(bState.activeRafCount, 0);
  const gem5h = bState.rows.find(r => r.id === 'gemini-5h');
  assert.equal(Math.round(gem5h.pct), 77);
  assert.equal(h.elements.get('btn-quota-refresh').getAttribute('data-refresh-state'), 'done');

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


test('共享额度池随 5h/weekly 窗口切换同步更新状态与手动刷新排队强制执行', async () => {
  const nowIso = '2026-11-15T00:44:00Z';
  const nowMs = Date.parse(nowIso);
  const future5hIso = '2026-11-15T05:00:00Z';
  const futureWeekIso = '2026-11-18T22:00:00Z';
  const argonResetIso = '2026-11-21T11:48:00Z';
  const { userStatusRes, quotaSummaryRes } = buildRealistic2321Fixtures(nowIso, future5hIso, futureWeekIso, argonResetIso);

  // 让 Gemini Main 5h=5% (low) 但 weekly=80% (available)，验证切换窗口模式时 pool.status 随 pb 同步变化
  userStatusRes.userStatus.cascadeModelConfigData.clientModelConfigs[0].quotaInfo.remainingFraction = 0.05;
  quotaSummaryRes.response.groups[0].buckets[0].remainingFraction = 0.05;
  quotaSummaryRes.response.groups[0].buckets[1].remainingFraction = 0.80;

  const h = createQuotaRendererHarness();
  try {
    const api = h.sandbox.__AGContextMeter;
    const snap = core.buildModelQuotaSnapshot({
      userStatusRes,
      quotaSummaryRes,
      currentModel: 'MODEL_PLACEHOLDER_M38',
      fetchMeta: { fetchedAtMs: nowMs },
      nowMs
    });

    // 先完结初始化时自动发起的配额请求，避免占用 quotaInFlightPromise
    while (h.quotaRequests.length > 0) {
      h.quotaRequests.shift().resolve({
        ok: true,
        data: { ok: true, accountScopeKey: 'acct_alice', fetchedAtMs: nowMs, lastSuccessAtMs: nowMs, snapshot: snap }
      });
    }
    await h.flush();

    // 验证静默后台刷新进行中时，手动强刷绝不复用旧静默请求而是立即发起独立 force: true 强刷，
    // 且旧静默回包晚于强刷到达时不得倒灌覆盖新状态
    const req0Count = h.quotaRequests.length;
    const silentPromise = api.refreshQuotaForTest(false, { manual: false, silent: true });
    const manualPromise = api.refreshQuotaForTest(true, { manual: true, skipScanFloor: true });
    assert.equal(h.quotaRequests.length, req0Count + 2, '强刷必须跳过旧静默请求复用并立即发起独立请求');
    const queuedManualReq = h.quotaRequests[req0Count + 1];
    assert.equal(Boolean(queuedManualReq.opts?.force), true);
    const freshManualSummary = JSON.parse(JSON.stringify(quotaSummaryRes));
    freshManualSummary.response.groups[0].buckets[0].remainingFraction = 0.05;
    freshManualSummary.response.groups[0].buckets[1].remainingFraction = 0.80;
    const freshSnap = core.buildModelQuotaSnapshot({
      userStatusRes,
      quotaSummaryRes: freshManualSummary,
      currentModel: 'MODEL_PLACEHOLDER_M38',
      fetchMeta: { fetchedAtMs: nowMs + 500 },
      nowMs: nowMs + 500
    });
    // 强刷先返回并提交，随后旧静默带着过时 99% 晚到，不得倒灌覆盖
    queuedManualReq.resolve({
      ok: true,
      data: { ok: true, accountScopeKey: 'acct_alice', fetchedAtMs: nowMs + 500, lastSuccessAtMs: nowMs + 500, snapshot: freshSnap }
    });
    await manualPromise;
    const staleSummary = JSON.parse(JSON.stringify(quotaSummaryRes));
    staleSummary.response.groups[0].buckets[0].remainingFraction = 0.99;
    const staleSnap = core.buildModelQuotaSnapshot({
      userStatusRes,
      quotaSummaryRes: staleSummary,
      currentModel: 'MODEL_PLACEHOLDER_M38',
      fetchMeta: { fetchedAtMs: nowMs - 5000 },
      nowMs
    });
    h.quotaRequests[req0Count].resolve({
      ok: true,
      data: { ok: true, accountScopeKey: 'acct_alice', fetchedAtMs: nowMs - 5000, lastSuccessAtMs: nowMs - 5000, snapshot: staleSnap }
    });
    await silentPromise;

    // 验证 5h -> weekly 切换时 shared_gemini_main 的 pool.status 跟随 pb 更新（low -> available）
    api.setQuotaBadgeWindowMode('5h', { persist: false });
    const view5h = api.getModelQuotaStateForTest(nowMs).view;
    const pool5h = view5h.pools.find(p => p.poolKey === 'shared_gemini_main');
    assert.equal(pool5h.status, 'low');
    assert.equal(pool5h.percentText, '5%');

    api.setQuotaBadgeWindowMode('weekly', { persist: false });
    const viewWeekly = api.getModelQuotaStateForTest(nowMs).view;
    const poolWeekly = viewWeekly.pools.find(p => p.poolKey === 'shared_gemini_main');
    assert.equal(poolWeekly.percentText, '80%');
    assert.equal(poolWeekly.status, 'available');
  } finally {
    try { h.sandbox.__AGContextMeter.dispose(); } catch { }
  }
});

test('PR #64 回归：5h/weekly 用量统计防双倍重复、占位模型归池、账号隔离与冷启动自愈回归', async (t) => {
  const os = require('os');
  const tmpAgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-quota-dedup-'));
  t.after(() => fs.rmSync(tmpAgDir, { recursive: true, force: true }));

  const nowMs = Date.now();
  const cid = '11111111-2222-4333-8444-555555555555';
  const logsDir = path.join(tmpAgDir, 'brain', cid, '.system_generated', 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  // 构造跨 24h 与最近 5h 的真实 transcript 记录（不含 responseId，extractCallId 会生成 cid#stepIndex）
  const recentIso1 = new Date(nowMs - 20 * 60000).toISOString();
  const recentIso2 = new Date(nowMs - 10 * 60000).toISOString();
  const olderIso = new Date(nowMs - 26 * 3600000).toISOString();
  fs.writeFileSync(path.join(logsDir, 'transcript.jsonl'), [
    JSON.stringify({
      step_index: 2,
      created_at: recentIso1,
      input_tokens: 10000,
      cache_read_tokens: 90000,
      output_tokens: 2000
    }),
    JSON.stringify({
      step_index: 4,
      created_at: recentIso2,
      input_tokens: 5000,
      cache_read_tokens: 45000,
      output_tokens: 1000
    }),
    JSON.stringify({
      step_index: 1,
      created_at: olderIso,
      input_tokens: 20000,
      cache_read_tokens: 80000,
      output_tokens: 4000
    })
  ].join('\n') + '\n', 'utf8');

  const acctActiveKey = collector.buildAccountScopeKey('active@example.com');

  // 账本保存服务端真实 responseId，与 transcript 的 cid#stepIndex 键不同，且使用不同占位模型 ID
  collector.recordModelCalls([
    {
      callId: 'resp_live_h530_step2',
      cascadeId: cid,
      stepIndex: 2,
      model: 'Gemini 4 Hydrogen (High)',
      modelExactId: 'MODEL_PLACEHOLDER_M530',
      modelLabel: 'Gemini 4 Hydrogen (High)',
      inputTokens: 10000,
      cacheReadTokens: 90000,
      cacheTokens: 90000,
      outputTokens: 2000,
      totalTokens: 102000,
      status: 'final',
      created_at: recentIso1,
      timestamp: Date.parse(recentIso1)
    },
    {
      callId: 'resp_live_neon_step4',
      cascadeId: cid,
      stepIndex: 4,
      model: 'Gemini 4 Neon (High)',
      modelExactId: 'MODEL_PLACEHOLDER_M532',
      modelLabel: 'Gemini 4 Neon (High)',
      inputTokens: 5000,
      cacheReadTokens: 45000,
      cacheTokens: 45000,
      outputTokens: 1000,
      totalTokens: 51000,
      status: 'final',
      created_at: recentIso2,
      timestamp: Date.parse(recentIso2)
    },
    {
      callId: 'resp_live_orch_older',
      cascadeId: cid,
      stepIndex: 1,
      model: 'Gemini 4 Hydrogen (Orchestrator)',
      modelExactId: 'MODEL_PLACEHOLDER_M669',
      modelLabel: 'Gemini 4 Hydrogen (Orchestrator)',
      inputTokens: 20000,
      cacheReadTokens: 80000,
      cacheTokens: 80000,
      outputTokens: 4000,
      totalTokens: 104000,
      status: 'final',
      created_at: olderIso,
      timestamp: Date.parse(olderIso)
    }
  ], { agDir: tmpAgDir, confirmedAccountEmail: 'active@example.com' });

  collector.recordModelCalls([
    {
      callId: 'resp_other_acct_isolated',
      cascadeId: '22222222-3333-4444-8555-666666666666',
      stepIndex: 1,
      model: 'Orchestrator (Neon)',
      modelExactId: 'MODEL_PLACEHOLDER_M537',
      modelLabel: 'Orchestrator (Neon)',
      inputTokens: 30000,
      cacheReadTokens: 170000,
      cacheTokens: 170000,
      outputTokens: 5000,
      totalTokens: 205000,
      status: 'final',
      created_at: recentIso2,
      timestamp: Date.parse(recentIso2)
    }
  ], { agDir: tmpAgDir, confirmedAccountEmail: 'other@example.com' });

  const hist = await collector.collectTokenHistoryAsync({
    agDir: tmpAgDir,
    agCliDir: path.join(tmpAgDir, 'cli-isolated'),
    userStatus: { userStatus: { email: 'active@example.com' } },
    skipWslDiscovery: true,
    skipAutoRepair: true,
    force: true,
    useWorker: false
  });

  // 1. 绝不双倍计算 matchedTranscriptReqs，也不混入其他账号记录
  assert.equal(hist.recentModelUsage.length, 3, '3条已对齐记录只各计1次，且隔离其他账号');
  const sumRecentTokens = hist.recentModelUsage.reduce((s, e) => s + e.totalTokens, 0);
  assert.equal(sumRecentTokens, 102000 + 51000 + 104000);
  assert.ok(hist.recentModelUsage.every(e => e.sharedGroupKey === 'shared_gemini_main'), 'M530/M532/M669 均应准确归入 shared_gemini_main');

  // 2. summarizeAccountWindowUsage 对齐占位模型后不再返回 0
  const winSummary = collector.summarizeAccountWindowUsage({
    agDir: tmpAgDir,
    accountScopeKey: acctActiveKey,
    poolKey: 'shared_gemini_main',
    startMs: nowMs - 3600000,
    endMs: nowMs + 60000
  });
  assert.equal(winSummary.requestCount, 2);
  assert.equal(winSummary.totalTokens, 153000);

  // 3. computeBucketTokenEstimate 自愈（竞态滞后 + 旧版 2x 污染数据升级）及跨池 Argon 隔离
  const { userStatusRes, quotaSummaryRes } = buildRealistic2321Fixtures(
    new Date(nowMs).toISOString(),
    new Date(nowMs + 4 * 3600000).toISOString(),
    new Date(nowMs + 5 * 86400000).toISOString(),
    new Date(nowMs + 5 * 86400000).toISOString()
  );
  // 模拟新版服务端将 Orchestrator (Argon) (M668) 置于 Gemini Models 共享池，而 Gemini 4 Argon (M417) 保持独立池
  quotaSummaryRes.response.groups[0].modelIds = ['Gemini 4 Hydrogen', 'Gemini 4 Neon', 'Orchestrator (Argon)', 'Gemini 3.8 Flash'];
  const snap = core.buildModelQuotaSnapshot({
    userStatusRes,
    quotaSummaryRes,
    fetchMeta: { fetchedAtMs: nowMs },
    nowMs
  });
  const gemPool = snap.pools.find(p => p.poolKey === 'shared_gemini_main');
  const gem5h = gemPool.buckets.find(b => b.windowKey === '5h');
  const gemWeek = gemPool.buckets.find(b => b.windowKey === 'weekly');

  // 模拟冷启动/竞态：先遇到 frac 下降 >=3% 且本地尚未扫到新样本 -> 暂标 external_divergence；
  // 随后在 frac 未再继续下降的前提下补齐本地 153K 样本 -> 自愈解除锁定并正常 delta 校准
  const t0 = core.computeBucketTokenEstimate(gemPool, { ...gem5h, remainingFraction: 0.95 }, {
    nowMs: nowMs - 60000,
    accountScopeKey: acctActiveKey,
    usageEvents: [],
    historyLoaded: true,
    calibrationEntry: null
  });
  const t1Lag = core.computeBucketTokenEstimate(gemPool, { ...gem5h, remainingFraction: 0.90 }, {
    nowMs,
    accountScopeKey: acctActiveKey,
    usageEvents: [],
    historyLoaded: true,
    calibrationEntry: t0.nextCalibrationEntry
  });
  assert.equal(t1Lag.invalidationReason, 'external_divergence');

  const t2Healed = core.computeBucketTokenEstimate(gemPool, { ...gem5h, remainingFraction: 0.90 }, {
    nowMs: nowMs + 5000,
    accountScopeKey: acctActiveKey,
    usageEvents: hist.recentModelUsage.filter(e => e.ts >= nowMs - 3600000),
    historyLoaded: true,
    calibrationEntry: t1Lag.nextCalibrationEntry
  });
  assert.equal(t2Healed.estBasis, 'delta_calibrated');
  assert.equal(t2Healed.invalidationReason, null);
  assert.equal(t2Healed.cycleTokensUsed, 153000);

  // 旧版（无 usageAccountingRev）因 2x / 竞态遗留的 externalDivergenceInCycle 缓存应在升级后自动解封恢复
  const legacyPoisoned = {
    schemaVersion: 2,
    calibratedTotalTokens: 300000000,
    calibratedAt: nowMs - 3600000,
    calibratedResetAtMs: gemWeek.resetAtMs,
    sampleCount: 1,
    source: 'cycle',
    lastFraction: 0.63,
    lastResetAtMs: gemWeek.resetAtMs,
    observedCycleFromStart: true,
    fullStartCycleResetMs: gemWeek.resetAtMs,
    externalDivergenceInCycle: true,
    cycleInvalidationReason: 'external_divergence',
    anchorFraction: 0.72,
    anchorCycleTokens: 400000, // 旧 2x 虚高锚点 > 修复后真实 257K
    updatedAt: nowMs - 3600000
  };
  const weekHealed = core.computeBucketTokenEstimate(gemPool, { ...gemWeek, remainingFraction: 0.61 }, {
    nowMs,
    accountScopeKey: acctActiveKey,
    usageEvents: [
      ...hist.recentModelUsage,
      // 混入独立池 Gemini 4 Argon (M417) 用量，验证不会被误算入 Gemini Models 共享池
      { poolKey: 'gemini-4-argon', sharedGroupKey: 'shared_gemini_argon', modelExactId: 'MODEL_PLACEHOLDER_M417', ts: nowMs - 60000, totalTokens: 999999 }
    ],
    historyCoverageStartMs: nowMs - 8 * 86400000,
    historyLoaded: true,
    calibrationEntry: legacyPoisoned
  });
  assert.equal(weekHealed.estBasis, 'cycle_estimated');
  assert.equal(weekHealed.invalidationReason, null);
  assert.equal(weekHealed.cycleTokensUsed, 257000);

  // 4. 渲染器冷启动保护：recentModelUsage 尚未加载前调用 setQuotaSnapshotForTest 不得向 localStorage 写入锁定状态
  const h = createQuotaRendererHarness();
  const api = h.sandbox.__AGContextMeter;
  const coldScope = 'acct_cold_guard';
  h.sandbox.localStorage.setItem(`ag_quota_token_cal_v2_${coldScope}`, JSON.stringify({
    [`${coldScope}::shared_gemini_main::weekly`]: {
      schemaVersion: 2,
      usageAccountingRev: 2,
      calibratedTotalTokens: 2000000,
      calibratedAt: nowMs - 3600000,
      calibratedResetAtMs: gemWeek.resetAtMs,
      sampleCount: 1,
      source: 'delta',
      lastFraction: 0.90,
      lastResetAtMs: gemWeek.resetAtMs,
      observedCycleFromStart: true,
      fullStartCycleResetMs: gemWeek.resetAtMs,
      anchorFraction: 0.90,
      anchorCycleTokens: 200000,
      updatedAt: nowMs - 3600000
    }
  }));
  const beforeRaw = h.sandbox.localStorage.getItem(`ag_quota_token_cal_v2_${coldScope}`);
  api.setQuotaSnapshotForTest({
    accountScopeKey: coldScope,
    fetchedAtMs: nowMs,
    userStatusRes,
    quotaSummaryRes
  }, nowMs);
  assert.equal(h.sandbox.localStorage.getItem(`ag_quota_token_cal_v2_${coldScope}`), beforeRaw, '历史未就绪时不得覆写 localStorage');

  api.setTokenHistoryForTest({
    accountScopeKey: coldScope,
    quotaUsageCoverageStartMs: nowMs - 8 * 86400000,
    recentModelUsage: [
      { poolKey: 'gemini-4-hydrogen', sharedGroupKey: 'shared_gemini_main', ts: nowMs - 60000, inputTokens: 100000, cacheTokens: 600000, outputTokens: 20000, totalTokens: 720000 }
    ],
    dailyMap: {}
  });
  const savedAfter = JSON.parse(h.sandbox.localStorage.getItem(`ag_quota_token_cal_v2_${coldScope}`));
  assert.equal(savedAfter[`${coldScope}::shared_gemini_main::weekly`].externalDivergenceInCycle, false);
  api.dispose();
});

test('额度消耗节奏数学模型：20格分段、极小非零保护、三色四档精确边界与静默条件', () => {
  const nowMs = Date.parse('2026-11-22T06:00:00Z');
  const fiveHMs = 5 * 3600 * 1000;
  const weekMs = 7 * 24 * 3600 * 1000;
  const makeBucket = (windowKey, frac, remainMs, extra = {}) => ({
    bucketId: `b-${windowKey}`,
    windowKey,
    windowShort: windowKey === '5h' ? '5h' : (windowKey === 'weekly' ? '7d' : windowKey),
    remainingFraction: frac,
    isExhausted: frac === 0,
    hasResetTime: remainMs !== null,
    resetAtMs: remainMs !== null ? nowMs + remainMs : null,
    resetTimeIso: remainMs !== null ? new Date(nowMs + remainMs).toISOString() : null,
    isResetPassed: false,
    ...extra
  });

  // 1. +10 / -5 / 红色严重偏快(-40pp 与 Rq<25% 且 delta<-20pp)精确边界
  assert.equal(core.evaluateQuotaPace(makeBucket('5h', 0.60, 0.50 * fiveHMs), nowMs).tier, 1, '+10pp 边界应落入 1 档(宽裕)');
  assert.equal(core.evaluateQuotaPace(makeBucket('5h', 0.599, 0.50 * fiveHMs), nowMs).tier, 2, '+9.9pp 应落入 2 档(均衡)');
  assert.equal(core.evaluateQuotaPace(makeBucket('5h', 0.45, 0.50 * fiveHMs), nowMs).tier, 2, '-5pp 边界应落入 2 档(均衡)');
  assert.equal(core.evaluateQuotaPace(makeBucket('5h', 0.449, 0.50 * fiveHMs), nowMs).tier, 3, '-5.1pp 应落入 3 档(偏快)');
  assert.equal(core.evaluateQuotaPace(makeBucket('5h', 0.25, 0.65 * fiveHMs), nowMs).tier, 3, '-40pp 边界且 Rq=0.25 不满足 < -0.40 应落入 3 档(偏快橙)');
  assert.equal(core.evaluateQuotaPace(makeBucket('5h', 0.299, 0.70 * fiveHMs), nowMs).tier, 4, 'delta = -40.1pp (< -0.40) 应落入 4 档(透支红)');
  assert.equal(core.evaluateQuotaPace(makeBucket('5h', 0.24, 0.44 * fiveHMs), nowMs).tier, 3, 'Rq < 0.25 但 delta = -20pp 边界未满足 < -0.20 应保持 3 档(偏快橙)');
  assert.equal(core.evaluateQuotaPace(makeBucket('5h', 0.24, 0.45 * fiveHMs), nowMs).tier, 4, 'Rq < 0.25 且 delta = -21pp (< -0.20) 应落入 4 档(透支红)');

  // 2. 用户截图实测样本与整数剩余时间文案校验
  const liveSample55 = core.evaluateQuotaPace(makeBucket('weekly', 0.55, 0.948 * weekMs), nowMs);
  assert.equal(liveSample55.tier, 3, '55% / 94.8% (delta=-39.8pp) 必须为橙色偏快(3档)');
  assert.equal(liveSample55.colorGroup, 'amber');
  assert.equal(liveSample55.timePct, 95, '剩余时间文案应为整数百分比');
  assert.ok(Math.abs(liveSample55.timeRemaining - 0.948) < 1e-4, '游标仍应保留真实浮点比例');

  const liveSample36 = core.evaluateQuotaPace(makeBucket('weekly', 0.36, 0.711 * weekMs), nowMs);
  assert.equal(liveSample36.tier, 3, '36% / 71.1% (delta=-35.1pp) 必须为橙色偏快(3档)');
  assert.equal(liveSample36.colorGroup, 'amber');
  assert.equal(liveSample36.timePct, 71);

  const sampleFast = core.evaluateQuotaPace(makeBucket('5h', 0.65, 0.75 * fiveHMs), nowMs);
  assert.equal(sampleFast.tier, 3);
  assert.equal(sampleFast.tierKey, 'fast');
  assert.equal(sampleFast.colorGroup, 'amber');
  assert.equal(sampleFast.deltaPct, -10);
  assert.equal(sampleFast.hasGap, true);
  assert.equal(sampleFast.fullBlocks, 13);
  assert.equal(sampleFast.partialBlockFrac, 0);

  const sampleModerateLag = core.evaluateQuotaPace(makeBucket('weekly', 0.59, 0.96 * weekMs), nowMs);
  assert.equal(sampleModerateLag.tier, 3, '59%/96% (-37pp) 在新阈值下为 3 档橙色而非红色');
  assert.equal(sampleModerateLag.tierKey, 'fast');
  assert.equal(sampleModerateLag.colorGroup, 'amber');
  assert.equal(sampleModerateLag.deltaPct, -37);
  assert.equal(sampleModerateLag.hasGap, true);
  assert.equal(sampleModerateLag.fullBlocks, 11);
  assert.ok(Math.abs(sampleModerateLag.partialBlockFrac - 0.8) < 1e-6);

  const sampleOverburnStrict = core.evaluateQuotaPace(makeBucket('weekly', 0.49, 0.96 * weekMs), nowMs);
  assert.equal(sampleOverburnStrict.tier, 4, '49%/96% (delta=-47pp < -40pp) 必须为 4 档透支红');
  assert.equal(sampleOverburnStrict.tierKey, 'overburn');
  assert.equal(sampleOverburnStrict.colorGroup, 'red');

  const pdfSurplus = core.evaluateQuotaPace(makeBucket('5h', 0.80, 0.50 * fiveHMs), nowMs);
  assert.equal(pdfSurplus.tier, 1);
  assert.equal(pdfSurplus.fullBlocks, 16);
  assert.equal(pdfSurplus.partialBlockFrac, 0);
  assert.equal(pdfSurplus.hasGap, false);

  const pdfBalanced = core.evaluateQuotaPace(makeBucket('5h', 0.52, 0.50 * fiveHMs), nowMs);
  assert.equal(pdfBalanced.tier, 2);
  assert.equal(pdfBalanced.fullBlocks, 10);
  assert.ok(Math.abs(pdfBalanced.partialBlockFrac - 0.4) < 1e-6);

  // 3. 极小非零保护 (<1 格) 与 0% 已耗尽强制 4 档 (即使仅剩 10 分钟重置)
  const tinyNonZero = core.evaluateQuotaPace(makeBucket('5h', 0.00134, 0.50 * fiveHMs), nowMs);
  assert.equal(tinyNonZero.available, true);
  assert.equal(tinyNonZero.fullBlocks, 0);
  assert.ok(tinyNonZero.partialBlockFrac > 0 && tinyNonZero.partialBlockFrac < 0.05);
  assert.equal(tinyNonZero.hasMinVisibleBlock, true);
  assert.equal(tinyNonZero.partialVisualOpacity, 0.25);

  const zeroNearReset = core.evaluateQuotaPace(makeBucket('5h', 0, 10 * 60000), nowMs);
  assert.equal(zeroNearReset.available, true);
  assert.equal(zeroNearReset.tier, 4);
  assert.equal(zeroNearReset.isExhausted, true);
  assert.equal(zeroNearReset.fullBlocks, 0);
  assert.equal(zeroNearReset.partialBlockFrac, 0);

  // 4. 异常与静默边界（缺重置时间、周期未知、已过期、无权限、取数失败、数据过期、未知状态）
  assert.equal(core.evaluateQuotaPace(makeBucket('5h', 0.65, null), nowMs).available, false);
  assert.equal(core.evaluateQuotaPace(makeBucket('daily', 0.65, 12 * 3600000), nowMs).available, false);
  assert.equal(core.evaluateQuotaPace(makeBucket('5h', 0.65, -60000, { isResetPassed: true }), nowMs).available, false);
  assert.equal(core.evaluateQuotaPace(makeBucket('5h', 0.65, 0), nowMs).available, false);
  assert.equal(core.evaluateQuotaPace(makeBucket('5h', 0.65, 3600000), nowMs, { status: 'no_permission' }).available, false);
  assert.equal(core.evaluateQuotaPace(makeBucket('5h', 0.65, 3600000), nowMs, { status: 'error' }).available, false);
  assert.equal(core.evaluateQuotaPace(makeBucket('5h', 0.65, 3600000), nowMs, { status: 'stale' }).available, false);
  assert.equal(core.evaluateQuotaPace(makeBucket('5h', 0.65, 3600000), nowMs, { status: 'unknown' }).available, false);
  assert.equal(core.evaluateQuotaPace(makeBucket('5h', null, 3600000), nowMs).available, false);
});

test('额度消耗节奏 UI：双轨20格渲染、分层紧凑与展开、顶栏时间白点零重绘、输入框双显/限额提醒/开关/窄窗及静默隐藏', async () => {
  const nowMs = Date.parse('2026-11-22T06:00:00Z');
  const nowIso = new Date(nowMs).toISOString();
  const f5h = new Date(nowMs + Math.round(0.75 * 5 * 3600000)).toISOString(); // 75% timeRemaining -> delta -10% (fast)
  const fWeek = new Date(nowMs + Math.round(0.96 * 7 * 86400000)).toISOString(); // 96% timeRemaining -> delta -37% (overburn)
  const fArgon = new Date(nowMs + Math.round(0.50 * 7 * 86400000)).toISOString();

  const h = createQuotaRendererHarness({ innerWidth: 1280 });
  const savedSettingsPayloads = [];
  h.sandbox.window.contextMeterAPI.saveSettings = async (p) => {
    savedSettingsPayloads.push(p);
    return { ok: true };
  };
  for (const req of h.quotaRequests) {
    req.resolve({ ok: false, error: 'init-noop' });
  }
  await h.flush();

  const userStatusRes = {
    userStatus: {
      email: 'pace-test@example.com',
      planStatus: { planInfo: { planName: 'Google AI Pro', teamsTier: 'TEAMS_TIER_PRO' } },
      cascadeModelConfigData: {
        clientModelConfigs: [
          { label: 'Gemini 4 Hydrogen (High)', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M28' }, quotaInfo: { remainingFraction: 0.65, resetTime: f5h } },
          { label: 'Claude Opus 5.5 (Low)', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M40' }, quotaInfo: { remainingFraction: 0.52, resetTime: fWeek } },
          { label: 'Gemini 4 Argon (Medium)', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M66' }, quotaInfo: { remainingFraction: 0.80, resetTime: fArgon } }
        ]
      }
    }
  };
  const quotaSummaryRes = {
    response: {
      groups: [
        {
          groupId: 'gemini-main',
          displayName: 'Gemini Models',
          modelIds: ['Gemini 4 Hydrogen'],
          buckets: [
            { bucketId: 'gem-5h', window: '5h', remainingFraction: 0.65, resetTime: f5h },
            { bucketId: 'gem-7d', window: 'weekly', remainingFraction: 0.59, resetTime: fWeek }
          ]
        },
        {
          groupId: 'claude-gpt',
          displayName: 'Claude & GPT',
          modelIds: ['Claude Opus 5.5'],
          buckets: [
            { bucketId: '3p-5h', window: '5h', remainingFraction: 0.52, resetTime: new Date(nowMs + 0.50 * 5 * 3600000).toISOString() },
            { bucketId: '3p-7d', window: 'weekly', remainingFraction: 0.80, resetTime: fArgon }
          ]
        },
        {
          groupId: 'argon-pool',
          displayName: 'Gemini 4 Argon',
          modelIds: ['Gemini 4 Argon'],
          buckets: [
            { bucketId: 'argon-7d', window: 'weekly', remainingFraction: 0.80, resetTime: fArgon }
          ]
        }
      ]
    }
  };

  const api = h.sandbox.__AGContextMeter;
  api.setComposerQuotaSummaryEnabledForTest(true);
  api.setContextLatestForTest(
    { model: 'Gemini 4 Hydrogen (High)', modelId: 'MODEL_PLACEHOLDER_M28', actual: 18000, budget: 256000 },
    userStatusRes.userStatus.cascadeModelConfigData.clientModelConfigs
  );
  api.setQuotaSnapshotForTest({
    accountScopeKey: 'acct_pace_ui',
    userStatusRes,
    quotaSummaryRes,
    fetchedAtMs: nowMs,
    nowMs
  }, nowMs);

  // 1. 校验 10.html 主看板双池四行 20 格、精确左对齐小数格、4px 双色基准轨与白标游标
  const mainBoard = h.elements.get('quota-main-board');
  const getBoardRow = (id) => mainBoard.children.find(c => c.getAttribute('data-row-id') === id);
  const getRowCells = (row) => row.children[0].children[1].children[0].children;
  const getRowRail = (row) => row.children[0].children[2];
  const getRowPacePill = (row) => row.children[0].children[3].children[1];

  const row7d = getBoardRow('gemini-7d');
  const row5h = getBoardRow('gemini-5h');
  assert.ok(row7d && row5h, '主看板必须渲染 Gemini 7d 与 5h 两行');
  const segs5h = getRowCells(row5h);
  assert.equal(segs5h.length, 20);
  assert.equal(segs5h[12].children[0].style.width, '100.00%');
  assert.equal(segs5h[13].children[0].style.width, '0%');
  assert.match(getRowPacePill(row5h).textContent, /偏快\s*-10%/);

  const segs7d = getRowCells(row7d);
  assert.equal(segs7d[10].children[0].style.width, '100.00%');
  assert.equal(segs7d[11].children[0].style.width, '80.00%', '59% 第 12 格应按 80.00% 左对齐宽度填充');
  assert.equal(segs7d[11].children[0].style.opacity, '1', '小数尾格不靠透明度染整格');
  assert.equal(segs7d[12].children[0].style.width, '0%');
  assert.equal(getRowRail(row7d).children[1].style.left, '96.00%', '白色基准游标应按真实剩余时间精度定位');
  assert.match(getRowPacePill(row7d).textContent, /透支\s*-37%/);

  // 2. 校验 3P 池 0% 耗尽行 20 格全空并保留红警与真实时间基准轨
  const zeroCompactSummary = JSON.parse(JSON.stringify(quotaSummaryRes));
  zeroCompactSummary.response.groups[1].buckets[0] = {
    bucketId: '3p-5h',
    window: '5h',
    remainingFraction: 0,
    resetTime: f5h
  };
  api.setQuotaSnapshotForTest({
    accountScopeKey: 'acct_pace_ui',
    userStatusRes,
    quotaSummaryRes: zeroCompactSummary,
    fetchedAtMs: nowMs + 200,
    nowMs
  }, nowMs);
  const shared5hZero = getBoardRow('shared-5h');
  assert.equal(shared5hZero.getAttribute('data-red-alert'), 'true', '0% 耗尽保留红警');
  assert.equal(getRowCells(shared5hZero).filter(c => c.children[0].style.opacity === '1').length, 0, '0% 耗尽 20 格全空');
  assert.notEqual(getRowRail(shared5hZero).children[0].children[1].style.width, '0%', '0% 耗尽静态时继续显示真实时间基线与差额');
  assert.equal(getRowRail(shared5hZero).children[1].style.opacity, '1', '0% 耗尽静态时保留白标');

  // 3. 顶栏圆环时间刻点与零冗余重绘校验（复原无 0% 修改的原主验证快照测试）
  api.setQuotaSnapshotForTest({
    accountScopeKey: 'acct_pace_ui',
    userStatusRes,
    quotaSummaryRes,
    fetchedAtMs: nowMs + 250,
    nowMs
  }, nowMs);
  const paceState = api.getQuotaPaceStateForTest(nowMs);
  assert.equal(paceState.badgeTier, '3', '59%/96% (-37pp) 新规则下顶栏应为 3 档偏快橙');
  assert.equal(paceState.badgeDotHidden, false);
  const qFill = h.elements.get('quota-ring-fill');
  let attrWrites = 0;
  const origSetAttr = qFill.setAttribute.bind(qFill);
  qFill.setAttribute = (k, v) => { attrWrites += 1; return origSetAttr(k, v); };
  h.elements.get('btn-quota-refresh').click();
  if (h.quotaRequests.length > 0) {
    h.quotaRequests[h.quotaRequests.length - 1].resolve({
      ok: true,
      data: {
        ok: true,
        accountScopeKey: 'acct_pace_ui',
        fetchedAtMs: nowMs + 500,
        lastSuccessAtMs: nowMs + 500,
        snapshot: core.buildModelQuotaSnapshot({
          userStatusRes,
          quotaSummaryRes,
          currentModel: 'MODEL_PLACEHOLDER_M28',
          fetchMeta: { fetchedAtMs: nowMs + 500 },
          nowMs: nowMs + 500
        })
      }
    });
    await h.flush();
  }
  assert.equal(attrWrites, 0, '手动刷新相同数据时绝不重复重绘 #quota-ring-fill');

  // 4. 输入框下方额度摘要：5h/周双显、另一条限额提醒、其余池+N、窄窗收敛与开关持久化
  const csbWide = api.getComposerQuotaSummaryStateForTest(nowMs);
  assert.equal(csbWide.groupHidden, false);
  assert.equal(csbWide.win5hHidden, false);
  assert.equal(csbWide.win5hText, '5H 65%');
  assert.equal(csbWide.win7dHidden, false);
  assert.equal(csbWide.win7dText, '7D 59%');
  assert.equal(csbWide.altWarnHidden, false);
  assert.match(csbWide.altWarnText, /5H 偏快/);
  assert.equal(csbWide.moreText, '');

  // 切窄窗 (< 560) -> widthMode = tight，隐藏次要窗口与 +N，仍保留紧缩主窗口(7d)与另一条限额提醒(5h 偏快)
  h.sandbox.window.innerWidth = 480;
  const csbNarrow = api.getComposerQuotaSummaryStateForTest(nowMs);
  assert.equal(csbNarrow.widthMode, 'tight');
  assert.equal(csbNarrow.win5hSecondary, 'true');
  assert.equal(csbNarrow.win7dSecondary, 'false');
  assert.equal(csbNarrow.altWarnHidden, false);
  h.sandbox.window.innerWidth = 1280;

  // 补充任务 A: 底栏额度项首帧直达额度看板，二次点击关闭
  h.elements.get('panel-quota').hidden = true;
  h.elements.get('csb-group-quota').click();
  assert.equal(h.elements.get('panel-quota').hidden, false, '补充任务 A: 点击底栏额度项直达模型额度看板');
  h.elements.get('csb-group-quota').click();
  assert.equal(h.elements.get('panel-quota').hidden, true, '二次点击底栏额度项关闭模型额度看板');
  const quotaBadge = h.elements.get('badge-quota');
  quotaBadge.dispatchEvent({ type: 'click', target: quotaBadge, detail: 0 });
  assert.equal(h.elements.get('panel-quota').hidden, false, '键盘激活顶部额度圆环可打开额度看板');
  const chkComposerQuota = h.elements.get('chk-show-composer-quota');
  chkComposerQuota.checked = false;
  chkComposerQuota.dispatchEvent({ type: 'change', target: chkComposerQuota });
  assert.equal(api.getComposerQuotaSummaryStateForTest(nowMs).groupHidden, true);
  assert.equal(h.storageMap.get('ag_show_composer_quota'), 'false');
  assert.ok(savedSettingsPayloads.some(p => p.showComposerQuotaSummary === false));

  chkComposerQuota.checked = true;
  chkComposerQuota.dispatchEvent({ type: 'change', target: chkComposerQuota });
  assert.equal(api.getComposerQuotaSummaryStateForTest(nowMs).groupHidden, false);
  assert.equal(h.storageMap.get('ag_show_composer_quota'), 'true');
  assert.ok(savedSettingsPayloads.some(p => p.showComposerQuotaSummary === true));

  // 主进程 settings 持久化往返
  const tmpSettingsDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'ag-pace-settings-'));
  try {
    assert.equal(collector.getPluginSettings(tmpSettingsDir).showComposerQuotaSummary, false);
    collector.savePluginSettings({ showComposerQuotaSummary: false }, tmpSettingsDir);
    assert.equal(collector.getPluginSettings(tmpSettingsDir).showComposerQuotaSummary, false);
  } finally {
    fs.rmSync(tmpSettingsDir, { recursive: true, force: true });
  }

  // 5. 极小非零(<1格)、0% 已耗尽、缺重置时间及未知周期、无权限与异常态 UI 静默隐藏
  const edgeSummary = {
    response: {
      groups: [
        {
          groupId: 'gemini-main',
          displayName: 'Gemini Models',
          modelIds: ['Gemini 4 Hydrogen'],
          buckets: [
            { bucketId: 'edge-tiny', window: '5h', remainingFraction: 0.00134, resetTime: f5h },
            { bucketId: 'edge-zero', window: 'weekly', remainingFraction: 0, resetTime: new Date(nowMs + 10 * 60000).toISOString() },
            { bucketId: 'edge-no-reset', window: '5h', remainingFraction: 0.72, resetTime: null },
            { bucketId: 'edge-unknown-win', window: 'daily', remainingFraction: 0.50, resetTime: fWeek }
          ]
        }
      ]
    }
  };
  api.setQuotaSnapshotForTest({
    accountScopeKey: 'acct_pace_edges',
    userStatusRes,
    quotaSummaryRes: edgeSummary,
    fetchedAtMs: nowMs,
    nowMs
  }, nowMs);
  const edgeGem5h = getBoardRow('gemini-5h');
  const edgeGem7d = getBoardRow('gemini-7d');
  // 极小非零 0.134% -> 10.html 红警且第 1 格左对齐保留最小 6% 可见宽
  assert.equal(edgeGem5h.getAttribute('data-red-alert'), 'true');
  assert.equal(getRowCells(edgeGem5h)[0].children[0].style.width, '6.00%');
  assert.equal(getRowCells(edgeGem5h)[0].children[0].style.opacity, '1');
  // 0% 耗尽保持红警且 20 格全 0%
  assert.equal(edgeGem7d.getAttribute('data-red-alert'), 'true');
  assert.equal(getRowCells(edgeGem7d)[0].children[0].style.width, '0%');
  assert.match(getRowPacePill(edgeGem7d).textContent, /已耗尽 0%/);

  // 数据过期时整体隐藏顶栏时间刻点并清空主看板时间基准轨
  api.setQuotaSnapshotForTest({
    accountScopeKey: 'acct_pace_ui',
    error: 'stale timeout',
    userStatusRes,
    quotaSummaryRes,
    fetchedAtMs: nowMs,
    nowMs
  }, nowMs);
  assert.equal(h.elements.get('quota-ring-pace-dot').hidden, true, '数据过期/异常时应隐藏顶栏时间刻点');
  assert.equal(getRowRail(getBoardRow('gemini-7d')).getAttribute('data-rail-empty'), 'true', '数据过期/异常时应隐藏/清空基准轨');

  api.dispose();
});

test('v0.9.0-beta.1 同快照额度百分比在顶栏、双轨卡与输入框摘要严格一致，且极小非零与 core 共用 <0.1% 口径', async () => {
  const nowMs = Date.UTC(2026, 10, 22, 6, 20, 0);
  const f5h = new Date(nowMs + 152 * 60000).toISOString();
  const fWeek = new Date(nowMs + 5930 * 60000).toISOString();
  const userStatusRes = {
    userStatus: {
      userTier: { id: 'g1-pro-tier', name: 'Google AI Pro' },
      cascadeModelConfigData: {
        clientModelConfigs: [{ label: 'Gemini 4 Hydrogen', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M578' }, quotaInfo: { remainingFraction: 0.0614952, resetTime: f5h } }]
      }
    }
  };
  const h = createQuotaRendererHarness({ innerWidth: 1280 });
  const api = h.sandbox.__AGContextMeter;
  api.setComposerQuotaSummaryEnabledForTest(true);
  try {
    api.setContextLatestForTest(
      { model: 'Gemini 4 Hydrogen', modelId: 'MODEL_PLACEHOLDER_M578', actual: 18000, budget: 256000 },
      userStatusRes.userStatus.cascadeModelConfigData.clientModelConfigs
    );
    // 1. 同快照 0.0614952 -> 三处统一显示 6%（不出现 7.26% 等异快照混淆）
    const snapReal = {
      response: {
        groups: [{
          groupId: 'gemini-main',
          displayName: 'Gemini Models',
          modelIds: ['Gemini 4 Hydrogen'],
          buckets: [
            { bucketId: 'g-5h', window: '5h', remainingFraction: 0.0614952, resetTime: f5h },
            { bucketId: 'g-7d', window: 'weekly', remainingFraction: 0.7303, resetTime: fWeek }
          ]
        }]
      }
    };
    api.setQuotaSnapshotForTest({ accountScopeKey: 'acct_same_snap', userStatusRes, quotaSummaryRes: snapReal, fetchedAtMs: nowMs, nowMs }, nowMs);
    assert.equal(h.elements.get('quota-badge-val').textContent, '6%');
    assert.equal(api.getComposerQuotaSummaryStateForTest(nowMs).win5hText, '5H 6%');
    const row5hSame = api.getQuotaBoardStateForTest().rows.find(r => r.id === 'gemini-5h');
    assert.equal(row5hSame.pctText, '6%');

    // 2. 极小非零 0.0005 (0.05%) 与 core.formatQuotaPercentText 均返回 '<0.1%'
    assert.equal(core.formatQuotaPercentText(0.0005), '<0.1%');
    const snapMicro = {
      response: {
        groups: [{
          groupId: 'gemini-main',
          displayName: 'Gemini Models',
          modelIds: ['Gemini 4 Hydrogen'],
          buckets: [
            { bucketId: 'g-5h', window: '5h', remainingFraction: 0.0005, resetTime: f5h }
          ]
        }]
      }
    };
    api.setQuotaSnapshotForTest({ accountScopeKey: 'acct_micro_snap', userStatusRes, quotaSummaryRes: snapMicro, fetchedAtMs: nowMs, nowMs }, nowMs);
    assert.equal(h.elements.get('quota-badge-val').textContent, '<0.1%');
    assert.equal(api.getComposerQuotaSummaryStateForTest(nowMs).win5hText, '5H <0.1%');
    const row5hMicro = api.getQuotaBoardStateForTest().rows.find(r => r.id === 'gemini-5h');
    assert.equal(row5hMicro.pctText, '<0.1%');
  } finally {
    api.dispose();
  }
});

test('PR #74: 带前缀模型选择器、Orchestrator/Worker 身份、分屏聚焦选择、未知档位与未知模型清除旧额度', async () => {
  const nowMs = Date.UTC(2026, 10, 22, 9, 0, 0);
  const f5h = new Date(nowMs + 180 * 60000).toISOString();
  const fWeek = new Date(nowMs + 4320 * 60000).toISOString();
  const clientModelConfigs = [
    { label: 'Gemini 4 Hydrogen (Low)', modelId: 'MODEL_PLACEHOLDER_M527', modelOrAlias: { model: 'gemini-4-hydrogen' }, quotaInfo: { remainingFraction: 0.78, resetTime: f5h } },
    { label: 'Gemini 4 Hydrogen (High)', modelId: 'MODEL_PLACEHOLDER_M525', modelOrAlias: { model: 'gemini-4-hydrogen' }, quotaInfo: { remainingFraction: 0.78, resetTime: f5h } },
    { label: 'Gemini 4 Neon (Low)', modelId: 'MODEL_PLACEHOLDER_M534', modelOrAlias: { model: 'gemini-4-neon' }, quotaInfo: { remainingFraction: 0.78, resetTime: f5h } },
    { label: 'Gemini 4 Neon (Medium)', modelId: 'MODEL_PLACEHOLDER_M533', modelOrAlias: { model: 'gemini-4-neon' }, quotaInfo: { remainingFraction: 0.78, resetTime: f5h } },
    { label: 'Gemini 4 Neon (High)', modelId: 'MODEL_PLACEHOLDER_M532', modelOrAlias: { model: 'gemini-4-neon' }, quotaInfo: { remainingFraction: 0.78, resetTime: f5h } },
    { label: 'Gemini 4 Neon (XHigh)', modelId: 'MODEL_PLACEHOLDER_M535', modelOrAlias: { model: 'gemini-4-neon' }, quotaInfo: { remainingFraction: 0.78, resetTime: f5h } },
    { label: 'Orchestrator (Neon)', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M537' }, quotaInfo: { remainingFraction: 0.78, resetTime: f5h } },
    { label: 'Orchestrator (Carbon)', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M667' }, quotaInfo: { remainingFraction: 0.41, resetTime: fWeek } },
    { label: 'Orchestrator (Argon)', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M681' }, quotaInfo: { remainingFraction: 0.92, resetTime: fWeek } },
    { label: 'Gemini 4 Hydrogen (Orchestrator)', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M669' }, quotaInfo: { remainingFraction: 0.78, resetTime: f5h } }
  ];
  const userStatusRes = {
    userStatus: {
      userTier: { id: 'g1-pro-tier', name: 'Google AI Pro' },
      cascadeModelConfigData: { clientModelConfigs }
    }
  };
  const quotaSummaryRes = {
    response: {
      groups: [
        {
          groupId: 'gemini-main',
          displayName: 'Gemini 4 Neon / Hydrogen Pool',
          modelIds: ['Gemini 4 Neon', 'Gemini 4 Hydrogen'],
          buckets: [
            { bucketId: 'm-5h', window: '5h', remainingFraction: 0.78, resetTime: f5h },
            { bucketId: 'm-7d', window: 'weekly', remainingFraction: 0.91, resetTime: fWeek }
          ]
        },
        {
          groupId: 'gemini-carbon',
          displayName: 'Gemini 4 Carbon Pool',
          modelIds: ['Orchestrator (Carbon)', 'Gemini 4 Carbon'],
          buckets: [{ bucketId: 'c-7d', window: 'weekly', remainingFraction: 0.41, resetTime: fWeek }]
        },
        {
          groupId: 'gemini-argon',
          displayName: 'Gemini 4 Argon Pool',
          modelIds: ['Orchestrator (Argon)', 'Gemini 4 Argon'],
          buckets: [{ bucketId: 'a-7d', window: 'weekly', remainingFraction: 0.92, resetTime: fWeek }]
        }
      ]
    }
  };

  let activeTriggerTextLeft = 'Gemini 4 Hydrogen (Low)';
  let activeTriggerTextRight = 'Orchestrator · Gemini 4 Neon (XHigh)';
  let focusedPane = 'right';

  const makeMockTrigger = (getText, parentPane) => {
    const node = {
      parentElement: parentPane,
      get textContent() { return getText(); },
      closest: () => null,
      getBoundingClientRect: () => ({ width: 120, height: 24 }),
      querySelectorAll: () => [],
      querySelector: () => null
    };
    node.cloneNode = () => ({ textContent: getText(), querySelectorAll: () => [] });
    return node;
  };
  const wsRoot = { parentElement: null };
  const leftPane = { parentElement: wsRoot };
  const rightPane = { parentElement: wsRoot };
  const leftEditor = { parentElement: leftPane };
  const rightEditor = { parentElement: rightPane };
  leftPane.contains = (x) => x === leftEditor || x === leftTrig;
  rightPane.contains = (x) => x === rightEditor || x === rightTrig;
  wsRoot.contains = () => true;
  const leftTrig = makeMockTrigger(() => activeTriggerTextLeft, leftPane);
  const rightTrig = makeMockTrigger(() => activeTriggerTextRight, rightPane);

  const h = createQuotaRendererHarness({ innerWidth: 1280 });
  h.sandbox.document.querySelectorAll = (sel) => (sel === '[data-testid="model-selector-trigger"]' ? [leftTrig, rightTrig] : []);
  Object.defineProperty(h.sandbox.document, 'activeElement', {
    configurable: true,
    get: () => (focusedPane === 'right' ? rightEditor : leftEditor)
  });

  const api = h.sandbox.__AGContextMeter;
  api.setComposerQuotaSummaryEnabledForTest(true);
  try {
    api.setContextLatestForTest(
      { model: 'Gemini 4 Hydrogen (Low)', modelId: 'MODEL_PLACEHOLDER_M527', actual: 12000, budget: 256000 },
      clientModelConfigs
    );
    api.setQuotaSnapshotForTest({ accountScopeKey: 'acct_pr74', userStatusRes, quotaSummaryRes, fetchedAtMs: nowMs, nowMs }, nowMs);

    // 1. 多分屏右窗格聚焦时优先提取右侧带前缀模型 Orchestrator · Gemini 4 Neon (XHigh)
    const syncedRight = api.syncContextModelSelectionForTest(nowMs);
    assert.equal(syncedRight.activeSessionModelRole, 'orchestrator');
    assert.equal(syncedRight.activeSessionEffort, 'XHigh');
    assert.equal(syncedRight.activeSessionProductKey, 'product:google:gemini-4-neon');
    assert.equal(syncedRight.activeSessionEffortUnknown, false);
    assert.equal(h.elements.get('quota-badge-val').textContent, '78%');
    assert.equal(api.getComposerQuotaSummaryStateForTest(nowMs).win5hText, '5H 78%');

    // 2. Orchestrator (Carbon) & Orchestrator (Argon) 各自命中独立池与 41% / 92% 读数
    activeTriggerTextRight = 'Orchestrator (Carbon)';
    const syncedCarbon = api.syncContextModelSelectionForTest(nowMs);
    assert.equal(syncedCarbon.activeSessionModelRole, 'orchestrator');
    assert.equal(h.elements.get('quota-badge-val').textContent, '41%');

    activeTriggerTextRight = 'Orchestrator (Argon)';
    const syncedArgon = api.syncContextModelSelectionForTest(nowMs);
    assert.equal(syncedArgon.activeSessionModelRole, 'orchestrator');
    assert.equal(h.elements.get('quota-badge-val').textContent, '92%');

    // 3. Worker (M669) 保留 worker 身份且命中共享主池
    activeTriggerTextRight = 'Worker · Gemini 4 Hydrogen (Orchestrator)';
    const syncedWorker = api.syncContextModelSelectionForTest(nowMs);
    assert.equal(syncedWorker.activeSessionModelRole, 'worker');
    assert.equal(h.elements.get('quota-badge-val').textContent, '78%');

    // 4. 名字已知但档位未知时显示 '未知档位'，且绝不从配置数组偷取其他成员档位
    activeTriggerTextRight = 'Orchestrator · Gemini 4 Neon';
    const syncedNoEff = api.syncContextModelSelectionForTest(nowMs);
    assert.equal(syncedNoEff.activeSessionProductKey, 'product:google:gemini-4-neon');
    assert.equal(syncedNoEff.activeSessionEffort, null);
    assert.equal(syncedNoEff.activeSessionEffortUnknown, true);
    assert.equal(h.elements.get('ctx-card-session-effort').hidden, false);
    assert.match(h.elements.get('ctx-card-session-effort').textContent, /未知档位/);

    activeTriggerTextRight = 'Gemini 4 Neon (Turbo)';
    const syncedUnkEff = api.syncContextModelSelectionForTest(nowMs);
    assert.equal(syncedUnkEff.activeSessionEffort, null);
    assert.equal(syncedUnkEff.activeSessionEffortUnknown, true);
    assert.match(h.elements.get('ctx-card-session-effort').textContent, /未知档位/);

    // 5. 切到无法识别的未知模型：保留未知名称，彻底清除上一个模型的 78%/92% 额度读数、bucket 与输入框摘要
    activeTriggerTextRight = 'Future Mystery 9';
    const syncedUnknown = api.syncContextModelSelectionForTest(nowMs);
    assert.equal(syncedUnknown.activeSessionModelUnknown, true);
    const vUnknown = api.getModelQuotaStateForTest(nowMs).view;
    assert.equal(vUnknown.activeStatus, 'unknown');
    assert.equal(vUnknown.badge.fraction, null);
    assert.equal(vUnknown.currentModel.productLabel, 'Future Mystery 9');
    assert.equal(vUnknown.currentModel.poolKey, null);
    assert.equal(h.elements.get('quota-badge-val').textContent, '未知');
    assert.equal(h.elements.get('quota-cur-status').textContent, '未知');
    assert.equal(api.getComposerQuotaSummaryStateForTest(nowMs).groupHidden, true);
    api.setQuotaBadgeWindowMode?.('both');
    const vUnknownBoth = api.getModelQuotaStateForTest(nowMs).view;
    assert.equal(vUnknownBoth.badge.dualBuckets, null);
    assert.equal(vUnknownBoth.badge.fraction, null);

    // 6. 切回左侧聚焦分屏应立即恢复左窗格 Gemini 4 Hydrogen (Low) 并支持 dual/auto 切换
    focusedPane = 'left';
    const syncedLeft = api.syncContextModelSelectionForTest(nowMs);
    assert.equal(syncedLeft.activeSessionModelUnknown, false);
    assert.equal(syncedLeft.activeSessionEffort, 'Low');
    const vLeftBoth = api.getModelQuotaStateForTest(nowMs).view;
    assert.equal(vLeftBoth.badge.dualBuckets?.[0]?.text, '5h 78%');
    api.setQuotaBadgeWindowMode?.('auto');
    assert.equal(h.elements.get('quota-badge-val').textContent, '78%');
  } finally {
    api.dispose();
  }
});

test('02 批任务 1：强刷穿透 forceRefresh、单 RPC 失败拒绝成功、同源强刷去重、旧后台防倒灌、账号回退与装饰标签 NEW 统一', async () => {
  collector.resetQuotaHostCacheForTest();
  const { nowMs, userStatusRes, quotaSummaryRes } = buildRealistic2321Fixtures();

  // 1.1 装饰标签「新建」与 New 统一识别并规范为 NEW，且不误判为 Notice/无权限；真实下线、Notice、无权限各自保留
  assert.equal(core.isDecorativeBadgeTagTitle('New'), true);
  assert.equal(core.isDecorativeBadgeTagTitle('新建'), true);
  assert.equal(core.normalizeDecorativeBadgeTagTitle('New'), 'NEW');
  assert.equal(core.normalizeDecorativeBadgeTagTitle('新建'), 'NEW');
  assert.equal(core.normalizeDecorativeBadgeTagTitle('Leaving Soon'), null);

  const decoAvail = core.classifyModelQuotaAvailability({
    label: 'Gemini 4 Neon (High)',
    tagTitle: '新建',
    tagDescription: 'For most deep reasoning and complex problems'
  });
  assert.equal(decoAvail.noPermission, false);
  assert.equal(decoAvail.noticeText, null, '装饰标签新建附带产品简介不应生成 Notice 告警');
  assert.equal(decoAvail.decorativeBadgeTag, 'NEW');

  const leavingAvail = core.classifyModelQuotaAvailability({
    label: 'Gemini 4 Argon (High)',
    tagTitle: 'Leaving Soon',
    tagDescription: 'Leaving on Nov 30.'
  });
  assert.equal(leavingAvail.noPermission, false);
  assert.equal(leavingAvail.noticeTitle, 'Leaving Soon');
  assert.match(leavingAvail.noticeText, /Leaving on Nov 30/);
  assert.equal(leavingAvail.decorativeBadgeTag, null);

  // 1.2 force: true 穿透 15s 短缓存并向 RetrieveUserQuotaSummary 传 { forceRefresh: true }
  const rpcLog = [];
  const res1 = await collector.fetchQuotaSnapshotFromHost({
    origin: 'https://127.0.0.1:59001',
    nowMs,
    connect: async () => ({
      call: async (method, params) => {
        rpcLog.push({ method, params });
        return method === 'GetUserStatus' ? userStatusRes : quotaSummaryRes;
      }
    })
  });
  assert.equal(res1.ok, true);
  assert.equal(rpcLog.find(r => r.method === 'RetrieveUserQuotaSummary').params.forceRefresh, undefined);

  // 15s 内非强刷命中短缓存，不发 RPC
  const resCached = await collector.fetchQuotaSnapshotFromHost({
    origin: 'https://127.0.0.1:59001',
    nowMs: nowMs + 3000,
    connect: async () => { throw new Error('should hit 15s ttl cache'); }
  });
  assert.equal(resCached.ok, true);
  assert.equal(resCached.cacheHit, true);

  // 15s 内 force: true 穿透短缓存且传入 { forceRefresh: true }
  const updatedSummary = JSON.parse(JSON.stringify(quotaSummaryRes));
  updatedSummary.response.groups[0].buckets[0].remainingFraction = 0.72;
  const forceRpcLog = [];
  const resForce = await collector.fetchQuotaSnapshotFromHost({
    origin: 'https://127.0.0.1:59001',
    force: true,
    source: 'panel_manual_refresh',
    nowMs: nowMs + 4000,
    connect: async () => ({
      call: async (method, params) => {
        forceRpcLog.push({ method, params });
        return method === 'GetUserStatus' ? userStatusRes : updatedSummary;
      }
    })
  });
  assert.equal(resForce.ok, true);
  assert.equal(resForce.forceRefreshSent, true);
  assert.equal(resForce.forceRefreshApplied, true);
  assert.equal(resForce.dataFreshness, 'live_force_refresh');
  const qReq = forceRpcLog.find(r => r.method === 'RetrieveUserQuotaSummary');
  assert.deepEqual(qReq.params, { forceRefresh: true });
  assert.equal(resForce.snapshot.pools.find(p => p.poolKey === 'shared_gemini_main').buckets[0].remainingFraction, 0.72);

  // 1.3 单 RPC 失败（如 RetrieveUserQuotaSummary 失败但 GetUserStatus 成功）不得进入成功状态，且保留同账号上次可信快照
  const singleFail = await collector.fetchQuotaSnapshotFromHost({
    origin: 'https://127.0.0.1:59001',
    force: true,
    nowMs: nowMs + 5000,
    connect: async () => ({
      call: async (method) => {
        if (method === 'GetUserStatus') return userStatusRes;
        throw new Error('upstream 503');
      }
    })
  });
  assert.equal(singleFail.ok, false, '单 RPC 失败绝不可返回 ok: true');
  assert.equal(singleFail.snapshot.syncState, 'stale');
  assert.equal(singleFail.snapshot.pools.find(p => p.poolKey === 'shared_gemini_main').buckets[0].remainingFraction, 0.72, '失败必须回退到同账号上次可信快照 72%');

  // 1.4 并发同源强刷共享同一在途 Promise（不堆叠 RPC），而旧非强刷后台晚于新强刷返回时不倒灌
  let resolveBgQuota = null;
  let forceCallCounter = 0;
  const bgPromise = collector.fetchQuotaSnapshotFromHost({
    origin: 'https://127.0.0.1:59002',
    force: false,
    nowMs: nowMs + 1000,
    connect: async () => ({
      call: async (method) => {
        if (method === 'GetUserStatus') return userStatusRes;
        return new Promise(resolve => { resolveBgQuota = resolve; });
      }
    })
  });
  await new Promise(r => setImmediate(r));
  const freshSummaryRace = JSON.parse(JSON.stringify(quotaSummaryRes));
  freshSummaryRace.response.groups[0].buckets[0].remainingFraction = 0.88;
  let resolveForceQuota = null;
  const makeForceOpts = () => ({
    origin: 'https://127.0.0.1:59002',
    force: true,
    nowMs: nowMs + 2000,
    connect: async () => ({
      call: async (method, params) => {
        if (method === 'GetUserStatus') return userStatusRes;
        forceCallCounter++;
        assert.deepEqual(params, { forceRefresh: true });
        return new Promise(resolve => { resolveForceQuota = resolve; });
      }
    })
  });
  const f1 = collector.fetchQuotaSnapshotFromHost(makeForceOpts());
  const f2 = collector.fetchQuotaSnapshotFromHost(makeForceOpts());
  const f3 = collector.fetchQuotaSnapshotFromHost(makeForceOpts());
  await new Promise(r => setImmediate(r));
  assert.equal(forceCallCounter, 1, '同源并发 3 次强刷必须共享同一在途 RPC');
  resolveForceQuota(freshSummaryRace);
  const [rf1, rf2, rf3] = await Promise.all([f1, f2, f3]);
  assert.equal(rf1.ok, true);
  assert.equal(rf2.snapshot.pools[0].buckets[0].remainingFraction, 0.88);
  assert.equal(rf3.snapshot.pools[0].buckets[0].remainingFraction, 0.88);

  // 旧后台晚到带着过时 45% -> 不得倒灌覆盖缓存中的 88%
  resolveBgQuota(quotaSummaryRes);
  const rBg = await bgPromise;
  assert.equal(rBg.staleDiscarded, true);
  const afterBgCache = await collector.fetchQuotaSnapshotFromHost({
    origin: 'https://127.0.0.1:59002',
    force: false,
    nowMs: nowMs + 3000,
    connect: async () => { throw new Error('should return fresh 88% cache'); }
  });
  assert.equal(afterBgCache.snapshot.pools[0].buckets[0].remainingFraction, 0.88);
  collector.resetQuotaHostCacheForTest();
});

test('02 批任务 2 & 3：顶栏 1 秒 3 次即时轮换合并强刷、额度直达零闪烁、滚动缩短夹紧与 Issue #107 右键边界', async () => {
  const nowMs = Date.now();
  const f5h = new Date(nowMs + 4 * 3600000).toISOString();
  const fWeek = new Date(nowMs + 5 * 86400000).toISOString();
  const fArgon = new Date(nowMs + 6 * 86400000).toISOString();
  const { userStatusRes, quotaSummaryRes } = buildRealistic2321Fixtures(new Date(nowMs).toISOString(), f5h, fWeek, fArgon);
  quotaSummaryRes.response.groups[0].buckets[0].remainingFraction = 0.88; // 5h 88%
  quotaSummaryRes.response.groups[0].buckets[1].remainingFraction = 0.96; // 7d 96%

  const h = createQuotaRendererHarness();
  try {
    // 清理初始化请求
    while (h.quotaRequests.length > 0) {
      h.quotaRequests.shift().resolve({ ok: false, error: 'init-noop' });
    }
    await h.flush();

    const api = h.sandbox.__AGContextMeter;

    // 2.1 冷启动未知套餐显示「待识别」，绝不写死 Google AI Pro
    assert.equal(h.elements.get('quota-plan-tier-pill').textContent, '待识别');

    // 2.2 注入当前模型与初始快照（88% 5h / 96% 7d），默认 auto 显示最紧缩 88% 5h
    api.setContextLatestForTest(
      { model: 'Gemini 4 Hydrogen (High)', modelId: 'MODEL_PLACEHOLDER_M28', actual: 1000, budget: 256000 },
      userStatusRes.userStatus.cascadeModelConfigData.clientModelConfigs
    );
    api.setQuotaSnapshotForTest({
      accountScopeKey: 'acct_cycle3',
      fetchedAtMs: nowMs,
      userStatusRes,
      quotaSummaryRes
    }, nowMs);
    assert.equal(h.elements.get('quota-badge-val').textContent, '88%');
    assert.equal(h.elements.get('quota-badge-tag').textContent, '5h');

    // 2.3 1 秒连点顶栏 #badge-quota 3 次：每次即时切周期 (auto->5h->weekly->both)，底层合并只发 1 次 force: true 强刷
    const badgeQuota = h.elements.get('badge-quota');
    const qFill = h.elements.get('quota-ring-fill');
    const reqBefore = h.quotaRequests.length;
    badgeQuota.dispatchEvent({ type: 'click', detail: 1 }); // -> 5h
    assert.equal(api.getQuotaBadgeWindowMode(), '5h');
    assert.equal(h.elements.get('quota-badge-val').textContent, '88%');
    assert.equal(badgeQuota.getAttribute('data-quota-syncing'), 'true', '等待期间给圆环克制同步脉冲属性');

    badgeQuota.dispatchEvent({ type: 'click', detail: 1 }); // -> weekly
    assert.equal(api.getQuotaBadgeWindowMode(), 'weekly');
    assert.equal(h.elements.get('quota-badge-val').textContent, '96%');
    assert.equal(h.elements.get('quota-badge-tag').textContent, '7d');

    badgeQuota.dispatchEvent({ type: 'click', detail: 1 }); // -> both
    assert.equal(api.getQuotaBadgeWindowMode(), 'both');
    assert.equal(h.elements.get('quota-badge-dual').hidden, false);
    assert.equal(h.elements.get('quota-badge-dual').children[0].textContent, '5h 88%');
    assert.equal(h.elements.get('quota-badge-dual').children[1].textContent, '7d 96%');

    // 1 秒连点 3 次合并为 1 条底层强刷请求
    assert.equal(h.quotaRequests.length, reqBefore + 1, '1 秒点 3 次底层只能合并为 1 条在途强刷 RPC');
    assert.equal(h.quotaRequests[reqBefore].opts.force, true);
    assert.equal(h.quotaRequests[reqBefore].opts.source, 'topbar_badge_cycle');

    // 回包带新数值 (5h 85% / 7d 94%) 与真实 Ultra 套餐 -> 原子同步顶栏、悬停菜单、底栏与套餐徽标
    api.setComposerQuotaSummaryEnabledForTest(true);
    const ultraUserStatus = JSON.parse(JSON.stringify(userStatusRes));
    ultraUserStatus.userStatus.userTier = { id: 'g1-ultra-tier', name: 'Google AI Ultra' };
    ultraUserStatus.userStatus.planStatus = { planInfo: { teamsTier: 'TEAMS_TIER_PRO_ULTIMATE', planName: 'Google AI Ultra' } };
    const nextSummary = JSON.parse(JSON.stringify(quotaSummaryRes));
    nextSummary.response.groups[0].buckets[0].remainingFraction = 0.85;
    nextSummary.response.groups[0].buckets[1].remainingFraction = 0.94;
    const ultraSnap = core.buildModelQuotaSnapshot({
      userStatusRes: ultraUserStatus,
      quotaSummaryRes: nextSummary,
      currentModel: { modelId: 'MODEL_PLACEHOLDER_M28', label: 'Gemini 4 Hydrogen (High)' },
      fetchMeta: { fetchedAtMs: nowMs + 600 },
      nowMs: nowMs + 600
    });
    h.quotaRequests[reqBefore].resolve({
      ok: true,
      data: {
        ok: true,
        accountScopeKey: 'acct_cycle3',
        fetchedAtMs: nowMs + 600,
        lastSuccessAtMs: nowMs + 600,
        planTierSummary: { status: 'identified', tierKey: 'ultra', tierName: 'Google AI Ultra', planName: 'Google AI Ultra' },
        snapshot: ultraSnap
      }
    });
    await h.flush();
    assert.equal(badgeQuota.getAttribute('data-quota-syncing'), null);
    assert.equal(h.elements.get('quota-badge-dual').children[0].textContent, '5h 85%');
    assert.equal(h.elements.get('quota-badge-dual').children[1].textContent, '7d 94%');
    assert.equal(h.elements.get('overflow-quota-val').textContent, '5h 85% / 7d 94%');
    assert.equal(h.elements.get('csb-quota-text-5h').textContent, '5H 85%');
    assert.equal(h.elements.get('csb-quota-text-7d').textContent, '7D 94%');
    assert.equal(h.elements.get('quota-plan-tier-pill').textContent, 'Google AI Ultra', '同账号套餐随强刷原子提交，无需等待历史扫描');

    // 2.4 Issue #107：其他徽章 (#badge / #badge-tokens / #badge-speed) 在浅色与深色状态下右键均不切主题、不写 ag_theme_mode、不改面板、不发刷新
    for (const targetTheme of ['light', 'dark']) {
      // 通过明确的 #theme-toggle 按钮切换到目标初始主题，确保内存态与 storage 一致
      let guard = 0;
      while (h.storageMap.get('ag_theme_mode') !== targetTheme && guard < 4) {
        h.elements.get('theme-toggle').click();
        guard++;
      }
      assert.equal(h.storageMap.get('ag_theme_mode'), targetTheme, `应已进入 ${targetTheme} 主题态`);
      const reqCountBefore = h.quotaRequests.length;
      const panelQuotaHiddenBefore = h.elements.get('panel-quota').hidden;
      for (const bid of ['badge', 'badge-tokens', 'badge-speed']) {
        const node = h.elements.get(bid);
        let prevented = false;
        node.dispatchEvent({ type: 'contextmenu', preventDefault() { prevented = true; } });
        assert.equal(prevented, false, `${bid} 无独立右键动作，应交回宿主原生行为`);
        assert.equal(h.storageMap.get('ag_theme_mode'), targetTheme, `${bid} 右键绝不能修改 ag_theme_mode`);
        assert.equal(h.elements.get('panel-quota').hidden, panelQuotaHiddenBefore);
        assert.equal(h.quotaRequests.length, reqCountBefore);
      }
    }

    // 2.5 #badge-quota 右键只开关 #panel-quota，不改周期、不改主题，并完整消费事件
    const modeBeforeCtx = api.getQuotaBadgeWindowMode();
    const themeBeforeCtx = h.storageMap.get('ag_theme_mode');
    let qPrev = false; let qStop = false; let qStopImm = false;
    badgeQuota.dispatchEvent({
      type: 'contextmenu',
      preventDefault() { qPrev = true; },
      stopPropagation() { qStop = true; },
      stopImmediatePropagation() { qStopImm = true; }
    });
    assert.equal(qPrev && qStop && qStopImm, true);
    assert.equal(h.elements.get('panel-quota').hidden, false);
    assert.equal(api.getQuotaBadgeWindowMode(), modeBeforeCtx);
    assert.equal(h.storageMap.get('ag_theme_mode'), themeBeforeCtx);

    // 明确主题按钮 #theme-toggle 仍可正常切换主题
    const themeBeforeBtn = h.storageMap.get('ag_theme_mode');
    h.elements.get('theme-toggle').click();
    assert.notEqual(h.storageMap.get('ag_theme_mode'), themeBeforeBtn, '明确主题按钮必须正常切换主题');

    // 2.6 #overflow-quota-btn 悬停菜单入口直达 #panel-quota 且滚动缩短夹紧有效
    h.elements.get('close-quota').click();
    assert.equal(h.elements.get('panel-quota').hidden, true);
    h.elements.get('overflow-quota-btn').click();
    assert.equal(h.elements.get('panel-quota').hidden, false);

    const viewQuota = h.elements.get('view-quota');
    viewQuota.scrollHeight = 900;
    viewQuota.clientHeight = 400;
    viewQuota.scrollTop = 450;
    // 模拟内容缩短（scrollHeight 从 900 缩至 520，最大有效 scrollTop=120）
    viewQuota.scrollHeight = 520;
    api.setQuotaSnapshotForTest({
      accountScopeKey: 'acct_cycle3',
      fetchedAtMs: nowMs + 1500,
      snapshot: ultraSnap
    }, nowMs + 1500);
    assert.equal(viewQuota.scrollTop, 120, '内容缩短时必须按最大有效滚动锚点安全夹紧');
  } finally {
    h.sandbox.__AGContextMeter.dispose();
  }
});

test('02 批任务 4：两段式 20 格差分微反馈（下降暖红/上涨高亮）、圆形倒计时表盘、紧凑条联动与完整时间线', async () => {
  const nowMs = Date.now();
  const f5h = new Date(nowMs + 3 * 3600000 + 25 * 60000).toISOString();
  const fWeek = new Date(nowMs + 4 * 86400000 + 6 * 3600000).toISOString();
  const fArgon = new Date(nowMs + 5 * 86400000).toISOString();
  const { userStatusRes, quotaSummaryRes } = buildRealistic2321Fixtures(new Date(nowMs).toISOString(), f5h, fWeek, fArgon);
  quotaSummaryRes.response.groups[0].buckets[0].remainingFraction = 0.60; // 12 格

  const h = createQuotaRendererHarness();
  try {
    while (h.quotaRequests.length > 0) {
      h.quotaRequests.shift().resolve({ ok: false, error: 'init-noop' });
    }
    await h.flush();

    const api = h.sandbox.__AGContextMeter;
    api.setContextLatestForTest(
      { model: 'Gemini 4 Hydrogen (High)', modelId: 'MODEL_PLACEHOLDER_M28', actual: 1000, budget: 256000 },
      userStatusRes.userStatus.cascadeModelConfigData.clientModelConfigs
    );
    api.setQuotaSnapshotForTest({
      accountScopeKey: 'acct_diff_anim',
      fetchedAtMs: nowMs,
      userStatusRes,
      quotaSummaryRes
    }, nowMs);
    api.showQuotaPanelForTest(true);
    while (h.quotaRequests.length > 0) {
      h.quotaRequests.shift().resolve({
        ok: true,
        data: {
          ok: true,
          accountScopeKey: 'acct_diff_anim',
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
    }
    await h.flush();

    const mainBoard = h.elements.get('quota-main-board');
    const gem5hRow = mainBoard.children.find(c => c.getAttribute('data-row-id') === 'gemini-5h');
    const getRowCells = (row) => row.children[0].children[1].children[0].children;
    const dialWrap = gem5hRow.children[1].children[0];
    assert.equal(dialWrap.className, 'dial-wrapper', '每行必须渲染 10.html 右侧 70px 圆形倒计时表盘');
    assert.equal(dialWrap.getAttribute('data-dial-pending'), null);

    const runAnimToEnd = async () => {
      for (let i = 0; i < 30; i++) {
        h.stepRaf(120);
        await h.flush();
        for (const t of h.scheduledTimeouts.filter(t => !t.cleared && t.ms === 200)) {
          t.cleared = true; t.fn();
        }
        await h.flush();
      }
    };

    // 4.1 余量下降（60% 12 格 -> 40% 8 格）：退潮清零后逐格机械弹起至 8 格，落稳后按钮才切 done 并 900ms 回 idle
    const dropReqIdx = h.quotaRequests.length;
    const pDrop = api.refreshQuotaForTest(true, { manual: true, skipScanFloor: true });
    assert.equal(api.getQuotaBoardStateForTest().phase, 'drain');

    const dropSummary = JSON.parse(JSON.stringify(quotaSummaryRes));
    dropSummary.response.groups[0].buckets[0].remainingFraction = 0.40; // 8 格
    h.quotaRequests[dropReqIdx].resolve({
      ok: true,
      data: {
        ok: true,
        accountScopeKey: 'acct_diff_anim',
        fetchedAtMs: nowMs + 800,
        lastSuccessAtMs: nowMs + 800,
        snapshot: core.buildModelQuotaSnapshot({
          userStatusRes,
          quotaSummaryRes: dropSummary,
          currentModel: { modelId: 'MODEL_PLACEHOLDER_M28', label: 'Gemini 4 Hydrogen (High)' },
          fetchMeta: { fetchedAtMs: nowMs + 800 },
          nowMs: nowMs + 800
        })
      }
    });
    await pDrop;
    await runAnimToEnd();

    assert.equal(getRowCells(gem5hRow).filter(c => c.children[0].getAttribute('data-cell-active') === 'true').length, 8);
    assert.equal(h.elements.get('btn-quota-refresh').getAttribute('data-refresh-state'), 'done');
    assert.equal(h.elements.get('quota-refresh-text').textContent, '✓ 已刷新');
    for (const t of h.scheduledTimeouts.filter(t => !t.cleared && t.ms === 900)) {
      t.cleared = true; t.fn();
    }
    assert.equal(h.elements.get('btn-quota-refresh').getAttribute('data-refresh-state'), 'idle');

    // 4.2 余量增加（40% 8 格 -> 75% 15 格）：完整时间线记录 drain -> refill -> settled
    const gainReqIdx = h.quotaRequests.length;
    const pGain = api.refreshQuotaForTest(true, { manual: true, skipScanFloor: true });
    const gainSummary = JSON.parse(JSON.stringify(quotaSummaryRes));
    gainSummary.response.groups[0].buckets[0].remainingFraction = 0.75; // 15 格
    h.quotaRequests[gainReqIdx].resolve({
      ok: true,
      data: {
        ok: true,
        accountScopeKey: 'acct_diff_anim',
        fetchedAtMs: nowMs + 1600,
        lastSuccessAtMs: nowMs + 1600,
        snapshot: core.buildModelQuotaSnapshot({
          userStatusRes,
          quotaSummaryRes: gainSummary,
          currentModel: { modelId: 'MODEL_PLACEHOLDER_M28', label: 'Gemini 4 Hydrogen (High)' },
          fetchMeta: { fetchedAtMs: nowMs + 1600 },
          nowMs: nowMs + 1600
        })
      }
    });
    await pGain;
    await runAnimToEnd();

    const gainDetail = api.getQuotaChargeDetailForTest();
    assert.equal(getRowCells(gem5hRow).filter(c => c.children[0].getAttribute('data-cell-active') === 'true').length, 15);
    assert.ok(gainDetail.timeline.some(ev => ev.stage === 'drain_start'));
    assert.ok(gainDetail.timeline.some(ev => ev.stage === 'rpc_resolved'));
    assert.ok(gainDetail.timeline.some(ev => ev.stage === 'refill_start'));
    assert.ok(gainDetail.timeline.some(ev => ev.stage === 'settled'));

    for (const t of h.scheduledTimeouts.filter(t => !t.cleared && t.ms === 900)) {
      t.cleared = true; t.fn();
    }
    assert.equal(h.elements.get('btn-quota-refresh').getAttribute('data-refresh-state'), 'idle');

    // 4.3 快响应保留 200ms 全空换气停顿（不传 skipScanFloor）
    const fastReqIdx = h.quotaRequests.length;
    const pFast = api.refreshQuotaForTest(true, { manual: true });
    h.quotaRequests[fastReqIdx].resolve({
      ok: true,
      data: {
        ok: true,
        accountScopeKey: 'acct_diff_anim',
        fetchedAtMs: nowMs + 2200,
        lastSuccessAtMs: nowMs + 2200,
        snapshot: core.buildModelQuotaSnapshot({
          userStatusRes,
          quotaSummaryRes: gainSummary,
          currentModel: { modelId: 'MODEL_PLACEHOLDER_M28', label: 'Gemini 4 Hydrogen (High)' },
          fetchMeta: { fetchedAtMs: nowMs + 2200 },
          nowMs: nowMs + 2200
        })
      }
    });
    await pFast;
    for (let i = 0; i < 10; i++) { h.stepRaf(100); await h.flush(); }
    assert.equal(api.getQuotaBoardStateForTest().phase, 'pause', '快响应退潮后必须保留 200ms 全空换气停顿');
    await runAnimToEnd();
    for (const t of h.scheduledTimeouts.filter(t => !t.cleared && t.ms === 900)) {
      t.cleared = true; t.fn();
    }

    // 4.4 失败或取消（AbortError）不得进入已刷新，优雅回充恢复上次可信 75%
    const failReqIdx = h.quotaRequests.length;
    const pFail = api.refreshQuotaForTest(true, { manual: true, skipScanFloor: true });
    h.quotaRequests[failReqIdx].resolve({ ok: false, error: 'AbortError: cancelled by host' });
    await pFail;
    await runAnimToEnd();
    assert.notEqual(h.elements.get('btn-quota-refresh').getAttribute('data-refresh-state'), 'done');
    assert.equal(h.elements.get('quota-badge-val').textContent, '75%', '失败/取消必须保留上次可信 75% 读数');
    assert.equal(getRowCells(gem5hRow).filter(c => c.children[0].getAttribute('data-cell-active') === 'true').length, 15, '失败回滚后恢复原 15 格');
  } finally {
    h.sandbox.__AGContextMeter.dispose();
  }
});

test('02 批续跑缺口 1：跨账号旧回包防清缓存倒灌、强刷未完成切号、账号未知/不匹配、无可信快照、合法切号与同账号三次合并', async (t) => {
  collector.resetQuotaHostCacheForTest();
  const { nowMs, userStatusRes, quotaSummaryRes } = buildRealistic2321Fixtures();
  const crypto = require('node:crypto');
  const scopeOf = (email) => 'acct_' + crypto.createHash('sha256').update(email.toLowerCase()).digest('hex').slice(0, 16);

  const emailA = 'probe.alpha@example.com';
  const emailB = 'probe.beta@example.com';
  const scopeA = scopeOf(emailA);
  const scopeB = scopeOf(emailB);

  const makeUserStatus = (email, tierId = 'g1-pro-tier', tierName = 'Google AI Pro') => {
    const clone = JSON.parse(JSON.stringify(userStatusRes));
    clone.userStatus.email = email;
    clone.userStatus.userTier = { id: tierId, name: tierName };
    return clone;
  };
  const makeQuotaSummary = (frac5h, frac7d = 0.9) => {
    const clone = JSON.parse(JSON.stringify(quotaSummaryRes));
    clone.response.groups[0].buckets[0].remainingFraction = frac5h;
    clone.response.groups[0].buckets[1].remainingFraction = frac7d;
    return clone;
  };

  // 1.1 A 后台慢回包 (seq=1) 挂起 -> 切到 B 强刷 (seq=2) 先完成 -> 释放 A -> 随后 B 非强刷命中 B 的 TTL 缓存而非 A
  const origin1 = 'https://127.0.0.1:59101';
  let releaseSlowA = null;
  const pSlowA = collector.fetchQuotaSnapshotFromHost({
    origin: origin1,
    force: false,
    expectedAccountScopeKey: scopeA,
    nowMs,
    connect: async () => ({
      call: async (method) => {
        if (method === 'GetUserStatus') return makeUserStatus(emailA);
        return new Promise(resolve => { releaseSlowA = resolve; });
      }
    })
  });
  await new Promise(r => setImmediate(r));

  const resBForce = await collector.fetchQuotaSnapshotFromHost({
    origin: origin1,
    force: true,
    expectedAccountScopeKey: scopeB,
    nowMs: nowMs + 500,
    connect: async () => ({
      call: async (method) => {
        if (method === 'GetUserStatus') return makeUserStatus(emailB, 'g1-ultra-tier', 'Google AI Ultra');
        return makeQuotaSummary(0.91, 0.95);
      }
    })
  });
  assert.equal(resBForce.ok, true);
  assert.equal(resBForce.fetchSeq, 2);
  assert.equal(resBForce.accountScopeKey, scopeB);
  assert.equal(resBForce.snapshot.pools[0].buckets[0].remainingFraction, 0.91);

  releaseSlowA(makeQuotaSummary(0.22, 0.33));
  const resSlowA = await pSlowA;
  assert.equal(resSlowA.ok, false, '迟到的跨账号旧回包绝不得返回 ok=true');
  assert.equal(resSlowA.staleDiscarded, true, '迟到的跨账号旧回包必须标为 staleDiscarded=true');
  assert.equal(resSlowA.accountScopeKey, scopeB, '迟到回包不得删掉 B 缓存或把作用域回写成 A');

  // 随后客户端明确要求 B 的非强刷请求必须命中 B 的 TTL 缓存（0.91），绝不命中 A（0.22）
  const resBTtl = await collector.fetchQuotaSnapshotFromHost({
    origin: origin1,
    force: false,
    expectedAccountScopeKey: scopeB,
    nowMs: nowMs + 1500,
    connect: async () => { throw new Error('应命中 B 的 15s TTL 缓存，不得发起 RPC'); }
  });
  assert.equal(resBTtl.ok, true);
  assert.equal(resBTtl.cacheHit, true);
  assert.equal(resBTtl.accountScopeKey, scopeB);
  assert.equal(resBTtl.snapshot.pools[0].buckets[0].remainingFraction, 0.91);

  // 1.2 A 强刷 (seq=1) 未完成即切 B (seq=2)，且 A 先于 B 返回 -> A 必须立即被丢弃，绝不污染缓存
  const origin2 = 'https://127.0.0.1:59102';
  let releaseForceA = null;
  let releaseForceB = null;
  const pForceA = collector.fetchQuotaSnapshotFromHost({
    origin: origin2,
    force: true,
    expectedAccountScopeKey: scopeA,
    nowMs,
    connect: async () => ({
      call: async (method) => {
        if (method === 'GetUserStatus') return makeUserStatus(emailA);
        return new Promise(resolve => { releaseForceA = resolve; });
      }
    })
  });
  await new Promise(r => setImmediate(r));
  const pForceB = collector.fetchQuotaSnapshotFromHost({
    origin: origin2,
    force: true,
    expectedAccountScopeKey: scopeB,
    nowMs: nowMs + 200,
    connect: async () => ({
      call: async (method) => {
        if (method === 'GetUserStatus') return makeUserStatus(emailB);
        return new Promise(resolve => { releaseForceB = resolve; });
      }
    })
  });
  await new Promise(r => setImmediate(r));

  releaseForceA(makeQuotaSummary(0.18, 0.25));
  const rForceA = await pForceA;
  assert.equal(rForceA.ok, false);
  assert.equal(rForceA.staleDiscarded, true);
  assert.equal(rForceA.snapshot, null, 'B 尚未落地时，过期 A 不得泄露旧快照');

  releaseForceB(makeQuotaSummary(0.84, 0.92));
  const rForceB = await pForceB;
  assert.equal(rForceB.ok, true);
  assert.equal(rForceB.accountScopeKey, scopeB);
  assert.equal(rForceB.snapshot.pools[0].buckets[0].remainingFraction, 0.84);

  // 1.3 B 无可信快照：A 已有缓存后切 B 发起强刷但 B 失败 -> 返回 error 空池，绝不回退 A 缓存，后续 B 非强刷也不命中 A TTL
  const origin3 = 'https://127.0.0.1:59103';
  const rSeedA = await collector.fetchQuotaSnapshotFromHost({
    origin: origin3,
    force: true,
    expectedAccountScopeKey: scopeA,
    nowMs,
    connect: async () => ({
      call: async (method) => (method === 'GetUserStatus' ? makeUserStatus(emailA) : makeQuotaSummary(0.66, 0.77))
    })
  });
  assert.equal(rSeedA.ok, true);
  const rBFailNoSnap = await collector.fetchQuotaSnapshotFromHost({
    origin: origin3,
    force: true,
    expectedAccountScopeKey: scopeB,
    nowMs: nowMs + 500,
    connect: async () => ({
      call: async () => { throw new Error('ECONNREFUSED 127.0.0.1'); }
    })
  });
  assert.equal(rBFailNoSnap.ok, false);
  assert.equal(rBFailNoSnap.snapshot.syncState, 'error');
  assert.equal(rBFailNoSnap.snapshot.pools.length, 0, 'B 无可信快照时绝不得回退 A 的缓存池');

  let bNonForceRpcCalled = false;
  const rBNonForceMiss = await collector.fetchQuotaSnapshotFromHost({
    origin: origin3,
    force: false,
    expectedAccountScopeKey: scopeB,
    nowMs: nowMs + 1000,
    connect: async () => ({
      call: async (method) => {
        bNonForceRpcCalled = true;
        return method === 'GetUserStatus' ? makeUserStatus(emailB) : makeQuotaSummary(0.79, 0.88);
      }
    })
  });
  assert.equal(bNonForceRpcCalled, true, '明确要求 B 的非强刷不得命中 A 的 TTL 缓存');
  assert.equal(rBNonForceMiss.ok, true);
  assert.equal(rBNonForceMiss.accountScopeKey, scopeB);
  assert.equal(rBNonForceMiss.snapshot.pools[0].buckets[0].remainingFraction, 0.79);

  // 1.4 账号未知（缺 email）与显式目标账号不匹配：均拒绝成功、不删改 B 缓存、不推进 committedSeq
  const noEmailStatus = makeUserStatus('');
  delete noEmailStatus.userStatus.email;
  const rUnknownId = await collector.fetchQuotaSnapshotFromHost({
    origin: origin3,
    force: true,
    expectedAccountScopeKey: scopeB,
    nowMs: nowMs + 2000,
    connect: async () => ({
      call: async (method) => (method === 'GetUserStatus' ? noEmailStatus : makeQuotaSummary(0.11, 0.12))
    })
  });
  assert.equal(rUnknownId.ok, false);
  assert.equal(rUnknownId.identityVerified, false);
  assert.equal(rUnknownId.errorKind, 'unverified_account');
  assert.equal(rUnknownId.accountScopeKey, 'anonymous');

  // 显式指定全新预期账号 C，但 RPC 返回了旧账号 A -> 明确错账号拦截
  const emailC = 'probe.gamma@example.com';
  const scopeC = scopeOf(emailC);
  const rMismatch = await collector.fetchQuotaSnapshotFromHost({
    origin: origin3,
    force: true,
    expectedAccountScopeKey: scopeC,
    nowMs: nowMs + 3000,
    connect: async () => ({
      call: async (method) => (method === 'GetUserStatus' ? makeUserStatus(emailA) : makeQuotaSummary(0.15, 0.25))
    })
  });
  assert.equal(rMismatch.ok, false);
  assert.equal(rMismatch.accountIdentityMismatch, true);
  assert.equal(rMismatch.errorKind, 'account_mismatch');
  assert.equal(rMismatch.snapshot.syncState, 'error');
  assert.equal(rMismatch.snapshot.pools.length, 0);

  // 1.5 合法切号：原稳定在 A，客户端仍带旧 expectedAccountScopeKey=A 刷新，宿主返回可信新身份 B -> 合法更新预期账号为 B，避免卡在旧身份
  const origin4 = 'https://127.0.0.1:59104';
  const rStableA = await collector.fetchQuotaSnapshotFromHost({
    origin: origin4,
    force: true,
    expectedAccountScopeKey: scopeA,
    nowMs,
    connect: async () => ({
      call: async (method) => (method === 'GetUserStatus' ? makeUserStatus(emailA) : makeQuotaSummary(0.55, 0.65))
    })
  });
  assert.equal(rStableA.ok, true);
  assert.equal(rStableA.accountScopeKey, scopeA);

  const rLegitSwitchToB = await collector.fetchQuotaSnapshotFromHost({
    origin: origin4,
    force: true,
    expectedAccountScopeKey: scopeA,
    nowMs: nowMs + 1000,
    connect: async () => ({
      call: async (method) => (method === 'GetUserStatus' ? makeUserStatus(emailB) : makeQuotaSummary(0.93, 0.97))
    })
  });
  assert.equal(rLegitSwitchToB.ok, true, '合法切到 B 时必须接受可信新身份');
  assert.equal(rLegitSwitchToB.accountSwitched, true);
  assert.equal(rLegitSwitchToB.accountIdentityMismatch, false);
  assert.equal(rLegitSwitchToB.accountScopeKey, scopeB);
  const rAfterSwitchCache = await collector.fetchQuotaSnapshotFromHost({
    origin: origin4,
    force: false,
    nowMs: nowMs + 2000,
    connect: async () => { throw new Error('合法切号后非强刷应命中新 B 缓存'); }
  });
  assert.equal(rAfterSwitchCache.cacheHit, true);
  assert.equal(rAfterSwitchCache.accountScopeKey, scopeB);
  assert.equal(rAfterSwitchCache.snapshot.pools[0].buckets[0].remainingFraction, 0.93);

  // 1.6 同账号三次并发强刷合并为 1 次 RPC
  const origin5 = 'https://127.0.0.1:59105';
  let mergeRpcCount = 0;
  let releaseMerged = null;
  const makeSameAcctOpts = () => ({
    origin: origin5,
    force: true,
    expectedAccountScopeKey: scopeA,
    nowMs: nowMs + 100,
    connect: async () => ({
      call: async (method) => {
        if (method === 'GetUserStatus') return makeUserStatus(emailA);
        mergeRpcCount++;
        return new Promise(resolve => { releaseMerged = resolve; });
      }
    })
  });
  const m1 = collector.fetchQuotaSnapshotFromHost(makeSameAcctOpts());
  const m2 = collector.fetchQuotaSnapshotFromHost(makeSameAcctOpts());
  const m3 = collector.fetchQuotaSnapshotFromHost(makeSameAcctOpts());
  await new Promise(r => setImmediate(r));
  assert.equal(mergeRpcCount, 1, '同账号三次并发强刷必须合并为 1 条在途 RPC');
  releaseMerged(makeQuotaSummary(0.73, 0.81));
  const [rm1, rm2, rm3] = await Promise.all([m1, m2, m3]);
  assert.equal(rm1.ok && rm2.ok && rm3.ok, true);
  assert.equal(rm1.snapshot.pools[0].buckets[0].remainingFraction, 0.73);
  assert.equal(rm3.snapshot.pools[0].buckets[0].remainingFraction, 0.73);

  // 1.7 meter-main IPC、live-host 保护与 deriveTrustedAutoSwitchQuotaContext：已判过期/错账号/未验证身份均不写入可信快照、不刷新可信时间、不触发自动切号
  const { registerMeterIpcHandlers } = require('./meter-main');
  const accountsMod = require('./meter-accounts');
  const liveHostSrc = fs.readFileSync(path.join(__dirname, 'live-host.js'), 'utf8');
  assert.match(liveHostSrc, /isDiscardedOrInvalidIdentity[\s\S]*staleDiscarded === true[\s\S]*shouldSkipAutoSwitchEval/);
  const handlers = new Map();
  registerMeterIpcHandlers({ handle: (ch, fn) => handlers.set(ch, fn) });
  const getQuotaIpc = handlers.get('context-meter:get-quota');
  const syncSpy = t.mock.fn();
  const evalSpy = t.mock.fn(async () => ({ ok: true, action: 'noop' }));
  t.mock.method(accountsMod, 'getSharedAccountsManager', () => ({
    isSwitchInFlight: () => false,
    detectCurrentActiveAccount: async () => ({ email: emailB }),
    syncActiveHostQuotaSnapshot: syncSpy,
    evaluateAutoSwitch: evalSpy,
    getOverviewState: () => ({
      activeAccountEmail: emailB,
      autoSwitch: { enabled: true, poolKey: 'shared_gemini_main', windowKey: '5h', metricMode: 'remaining_pct', thresholdPct: 30, candidates: [emailA] }
    })
  }));

  const badResponses = [
    {
      ok: true,
      staleDiscarded: true,
      discardedReason: 'stale_fetch_seq',
      email: emailA,
      fetchedAtMs: nowMs,
      snapshot: core.buildModelQuotaSnapshot({ userStatusRes: makeUserStatus(emailA), quotaSummaryRes: makeQuotaSummary(0.05), fetchMeta: { fetchedAtMs: nowMs }, nowMs })
    },
    {
      ok: false,
      accountIdentityMismatch: true,
      errorKind: 'account_mismatch',
      email: emailA,
      fetchedAtMs: nowMs,
      snapshot: core.buildModelQuotaSnapshot({ userStatusRes: makeUserStatus(emailA), quotaSummaryRes: makeQuotaSummary(0.05), fetchMeta: { fetchedAtMs: nowMs }, nowMs })
    },
    {
      ok: true,
      identityVerified: false,
      errorKind: 'unverified_account',
      email: null,
      fetchedAtMs: nowMs,
      snapshot: core.buildModelQuotaSnapshot({ userStatusRes: noEmailStatus, quotaSummaryRes: makeQuotaSummary(0.05), fetchMeta: { fetchedAtMs: nowMs }, nowMs })
    }
  ];
  const frame = { url: 'http://127.0.0.1:59199/chat' };
  const ipcEvent = { senderFrame: frame, sender: { mainFrame: frame } };
  for (const fakeRes of badResponses) {
    const trustCheck = accountsMod.deriveTrustedAutoSwitchQuotaContext({ res: fakeRes, activeEmail: emailB, nowMs });
    assert.equal(trustCheck.trusted, false);
    const mockFetch = t.mock.method(collector, 'fetchQuotaSnapshotFromHost', async () => fakeRes);
    const ipcOut = await getQuotaIpc(ipcEvent, { force: true });
    mockFetch.mock.restore();
    assert.equal(ipcOut.ok, true);
    assert.equal(ipcOut.accountSyncResult, null, '过期/错账号/未验证回包不得触发自动切号评估');
  }
  assert.equal(syncSpy.mock.callCount(), 0, '过期/错账号/未验证回包绝不得写入可信账号快照或刷新可信时间');
  assert.equal(evalSpy.mock.callCount(), 0, '过期/错账号/未验证回包绝不得触发旧自动切号规则');

  collector.resetQuotaHostCacheForTest();
});

test('02 批续跑缺口 2：区分强刷成功与旧宿主缓存回退、显式不支持与网络错区分、缺有效数据、2.35.1 未变化成功与自动切号信任判定', async () => {
  collector.resetQuotaHostCacheForTest();
  const os = require('node:os');
  const accountsMod = require('./meter-accounts');
  const { nowMs, userStatusRes, quotaSummaryRes } = buildRealistic2321Fixtures();
  const originFb = 'https://127.0.0.1:59201';
  const email = userStatusRes.userStatus.email;

  // 2.1 先建立一次正常缓存采样（lastSuccessAtMs = nowMs）
  const seedRes = await collector.fetchQuotaSnapshotFromHost({
    origin: originFb,
    force: false,
    nowMs,
    connect: async () => ({
      call: async (method) => (method === 'GetUserStatus' ? userStatusRes : quotaSummaryRes)
    })
  });
  assert.equal(seedRes.ok, true);
  assert.equal(seedRes.lastSuccessAtMs, nowMs);

  // 2.2 模拟旧协议返回 unknown field forceRefresh -> 回退 {} 拿到同账号缓存，但不返回 ok:true、不刷新 lastSuccessAtMs、不覆写新鲜 TTL 缓存
  const fbCalls = [];
  const fbSummary = JSON.parse(JSON.stringify(quotaSummaryRes));
  fbSummary.response.groups[0].buckets[0].remainingFraction = 0.45;
  const fbRes = await collector.fetchQuotaSnapshotFromHost({
    origin: originFb,
    force: true,
    nowMs: nowMs + 5000,
    connect: async () => ({
      call: async (method, params) => {
        fbCalls.push({ method, params });
        if (method === 'GetUserStatus') return userStatusRes;
        if (params?.forceRefresh === true) {
          throw new Error('HTTP 400 INVALID_ARGUMENT: unknown field "forceRefresh" in RetrieveUserQuotaSummaryRequest');
        }
        return fbSummary;
      }
    })
  });
  assert.equal(fbCalls.filter(c => c.method === 'RetrieveUserQuotaSummary').length, 2, '显式不支持 forceRefresh 时应先强刷再回退 {}');
  assert.equal(fbRes.ok, false, '旧宿主缓存回退绝不得当作强刷成功返回 ok=true');
  assert.equal(fbRes.dataFreshness, 'host_cache_fallback');
  assert.equal(fbRes.forceRefreshSent, true);
  assert.equal(fbRes.forceRefreshApplied, false);
  assert.equal(fbRes.forceRefreshFallback, true);
  assert.equal(fbRes.errorKind, 'force_refresh_unsupported');
  assert.equal(fbRes.lastSuccessAtMs, nowMs, '缓存回退不得刷新 lastSuccessAtMs 为新采样时间');
  assert.equal(fbRes.snapshot.syncState, 'stale');
  assert.ok(fbRes.snapshot.pools.length > 0, '缓存回退应保留同账号有用的缓存池数据');

  // 2.3 暂时网络错误（timeout / 503）绝不得走 {} 回退，与显式不支持字段严格区分
  const netCalls = [];
  const netErrRes = await collector.fetchQuotaSnapshotFromHost({
    origin: originFb,
    force: true,
    nowMs: nowMs + 6000,
    connect: async () => ({
      call: async (method, params) => {
        netCalls.push({ method, params });
        if (method === 'GetUserStatus') return userStatusRes;
        throw new Error('connect ETIMEDOUT 127.0.0.1:59201');
      }
    })
  });
  assert.equal(netCalls.filter(c => c.method === 'RetrieveUserQuotaSummary').length, 1, '暂时网络超时不得静默重试 {} 冒充缓存回退');
  assert.equal(netErrRes.ok, false);
  assert.equal(netErrRes.forceRefreshFallback, false);
  assert.equal(netErrRes.dataFreshness, 'error_fallback');
  assert.equal(netErrRes.errorKind, 'timeout');

  // 2.4 单 RPC 失败（GetUserStatus 失败）亦不得进入成功状态
  const statusFailRes = await collector.fetchQuotaSnapshotFromHost({
    origin: originFb,
    force: true,
    nowMs: nowMs + 7000,
    connect: async () => ({
      call: async (method) => {
        if (method === 'GetUserStatus') throw new Error('HTTP 503 unavailable');
        return quotaSummaryRes;
      }
    })
  });
  assert.equal(statusFailRes.ok, false);
  assert.equal(statusFailRes.forceRefreshFallback, false);
  assert.equal(statusFailRes.snapshot.syncState, 'stale');

  // 2.5 旧协议回退但缺有效数据（冷启动无历史缓存且 {} 返回空池与空模型配置）
  const originEmptyFb = 'https://127.0.0.1:59202';
  const emptyUserStatus = { userStatus: { email: 'empty.fb@example.com', cascadeModelConfigData: { clientModelConfigs: [] } } };
  const emptyFbRes = await collector.fetchQuotaSnapshotFromHost({
    origin: originEmptyFb,
    force: true,
    nowMs: nowMs + 8000,
    connect: async () => ({
      call: async (method, params) => {
        if (method === 'GetUserStatus') return emptyUserStatus;
        if (params?.forceRefresh === true) throw new Error('unknown field forceRefresh');
        return { response: { groups: [] } };
      }
    })
  });
  assert.equal(emptyFbRes.ok, false);
  assert.equal(emptyFbRes.dataFreshness, 'host_cache_fallback');
  assert.equal(emptyFbRes.lastSuccessAtMs, null);
  assert.equal(emptyFbRes.snapshot.syncState, 'error');
  assert.equal(emptyFbRes.snapshot.pools.length, 0);

  // 2.6 deriveTrustedAutoSwitchQuotaContext 与 evaluateAutoSwitch：即使强行构造 ok:true + fresh 的 host_cache_fallback 也绝不触发自动切号
  const lowQuotaSummary = JSON.parse(JSON.stringify(quotaSummaryRes));
  lowQuotaSummary.response.groups[0].buckets[0].remainingFraction = 0.05; // 5% 低于阈值 20%
  const lowSnap = core.buildModelQuotaSnapshot({
    userStatusRes,
    quotaSummaryRes: lowQuotaSummary,
    fetchMeta: { fetchedAtMs: nowMs + 5000 },
    nowMs: nowMs + 5000
  });
  const trustFallbackForced = accountsMod.deriveTrustedAutoSwitchQuotaContext({
    res: {
      ok: true,
      email,
      dataFreshness: 'host_cache_fallback',
      forceRefreshSent: true,
      forceRefreshApplied: false,
      forceRefreshFallback: true,
      fetchedAtMs: nowMs + 5000,
      snapshot: lowSnap
    },
    activeEmail: email,
    nowMs: nowMs + 5000
  });
  assert.equal(trustFallbackForced.trusted, false);
  assert.equal(trustFallbackForced.syncState, 'host_cache_fallback');

  const trustActualFb = accountsMod.deriveTrustedAutoSwitchQuotaContext({
    res: fbRes,
    activeEmail: email,
    nowMs: nowMs + 5000
  });
  assert.equal(trustActualFb.trusted, false);
  assert.equal(trustActualFb.syncState, 'host_cache_fallback');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-fb-autoswitch-'));
  try {
    const mgr = accountsMod.createAccountsManager({
      stateDir: tmpDir,
      credentialsPaths: {
        desktopDbPath: path.join(tmpDir, 'missing.vscdb'),
        googleAccountsPath: path.join(tmpDir, 'missing.json')
      }
    });
    mgr.syncActiveHostQuotaSnapshot(seedRes, email, { nowMs });
    mgr.updateAutoSwitchConfig({
      enabled: true,
      poolKey: 'shared_gemini_main',
      windowKey: '5h',
      metricMode: 'remaining_pct',
      thresholdPct: 20,
      debounceSec: 0,
      candidates: ['backup@example.com']
    });
    const evalOut = await mgr.evaluateAutoSwitch({
      activeEmail: email,
      activeSnapshot: lowSnap,
      syncState: trustFallbackForced.syncState,
      nowMs: nowMs + 5000
    });
    assert.equal(evalOut.action, 'blocked');
    assert.equal(evalOut.state, 'blocked_untrusted_quota');
    assert.equal(evalOut.reason, 'quota_state_host_cache_fallback');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // 2.7 渲染层端到端回归：
  // (a) 旧宿主 host_cache_fallback（即便 payload 带 ok:true）保留同账号缓存、不刷新 lastSuccessAtMs、不播充能、按钮为 fallback「仅缓存」、展示警告提示与横幅
  // (b) 缺有效数据的 host_cache_fallback 按钮进入 error 且展示无可用缓存横幅
  // (c) 真正的 2.35.1 强刷成功且额度未变化：正常播充能、按钮进 done「✓ 已刷新」、提示「已更新」并回 idle
  const h = createQuotaRendererHarness();
  try {
    while (h.quotaRequests.length > 0) {
      h.quotaRequests.shift().resolve({ ok: false, error: 'init-noop' });
    }
    await h.flush();
    const api = h.sandbox.__AGContextMeter;
    api.setContextLatestForTest(
      { model: 'Gemini 4 Hydrogen (High)', modelId: 'MODEL_PLACEHOLDER_M28', actual: 1000, budget: 256000 },
      userStatusRes.userStatus.cascadeModelConfigData.clientModelConfigs
    );
    api.setQuotaSnapshotForTest({
      accountScopeKey: seedRes.accountScopeKey,
      fetchedAtMs: nowMs,
      lastSuccessAtMs: nowMs,
      userStatusRes,
      quotaSummaryRes
    }, nowMs);
    api.showQuotaPanelForTest(true);
    while (h.quotaRequests.length > 0) {
      h.quotaRequests.shift().resolve({ ok: true, data: seedRes });
    }
    await h.flush();

    const prevSuccessTs = api.getModelQuotaStateForTest(nowMs).state.lastSuccessAtMs;
    assert.equal(h.elements.get('quota-badge-val').textContent, '45%');

    // (a) 真正的 2.35.1 强刷成功且额度未变化（45% -> 45%，forceRefreshApplied: true, dataFreshness: 'live_force_refresh'）
    const reqRealIdx = h.quotaRequests.length;
    const pManualReal = api.refreshQuotaForTest(true, { manual: true, skipScanFloor: true });
    const unchangedLiveSnap = core.buildModelQuotaSnapshot({
      userStatusRes,
      quotaSummaryRes,
      currentModel: { modelId: 'MODEL_PLACEHOLDER_M28', label: 'Gemini 4 Hydrogen (High)' },
      fetchMeta: { fetchedAtMs: nowMs + 4000 },
      nowMs: nowMs + 4000
    });
    h.quotaRequests[reqRealIdx].resolve({
      ok: true,
      data: {
        ok: true,
        accountScopeKey: seedRes.accountScopeKey,
        forceRefreshSent: true,
        forceRefreshApplied: true,
        forceRefreshFallback: false,
        dataFreshness: 'live_force_refresh',
        fetchedAtMs: nowMs + 4000,
        lastSuccessAtMs: nowMs + 4000,
        snapshot: unchangedLiveSnap
      }
    });
    await pManualReal;
    const stepAllBoard = async () => {
      for (let i = 0; i < 30; i++) {
        h.stepRaf(120);
        await h.flush();
      }
    };
    const liveDetail = api.getQuotaChargeDetailForTest();
    assert.equal(liveDetail.playing, true, '2.35.1 真正强刷成功且额度未变化时仍应正常播三段式零残留反馈');
    assert.equal(api.getModelQuotaStateForTest(nowMs + 4000).state.lastSuccessAtMs, nowMs + 4000);
    await stepAllBoard();
    assert.equal(h.elements.get('btn-quota-refresh').getAttribute('data-refresh-state'), 'done');
    assert.equal(h.elements.get('quota-refresh-text').textContent, '✓ 已刷新');
    assert.equal(h.elements.get('quota-refresh-feedback').hidden, false);
    assert.equal(h.elements.get('quota-refresh-feedback').getAttribute('data-tone'), null);
    assert.equal(h.elements.get('quota-refresh-feedback').textContent, '已更新');
    for (const t of h.scheduledTimeouts.filter(t => !t.cleared && t.ms === 900)) {
      t.cleared = true; t.fn();
    }
    assert.equal(h.elements.get('btn-quota-refresh').getAttribute('data-refresh-state'), 'idle');

    // (b) 模拟旧协议缓存回退（含防御性 ok:true + host_cache_fallback）
    const beforeFbSuccessTs = api.getModelQuotaStateForTest(nowMs + 4000).state.lastSuccessAtMs;
    assert.equal(beforeFbSuccessTs, nowMs + 4000);
    const reqFbIdx = h.quotaRequests.length;
    const pManualFb = api.refreshQuotaForTest(true, { manual: true, skipScanFloor: true });
    h.quotaRequests[reqFbIdx].resolve({
      ok: true,
      data: {
        ...fbRes,
        ok: true,
        fetchedAtMs: nowMs + 9000,
        lastSuccessAtMs: beforeFbSuccessTs
      }
    });
    await pManualFb;
    await stepAllBoard();
    assert.equal(h.elements.get('btn-quota-refresh').getAttribute('data-refresh-state'), 'fallback');
    assert.equal(h.elements.get('quota-refresh-text').textContent, '仅缓存');
    assert.notEqual(h.elements.get('quota-refresh-text').textContent, '✓ 已刷新');
    assert.equal(h.elements.get('quota-refresh-feedback').hidden, false);
    assert.equal(h.elements.get('quota-refresh-feedback').getAttribute('data-tone'), 'warn');
    assert.equal(h.elements.get('quota-refresh-feedback').textContent, '实时刷新不可用，已保留缓存');
    assert.equal(h.elements.get('quota-banner').hidden, false);
    assert.equal(h.elements.get('quota-banner').getAttribute('data-tone'), 'warn');
    assert.match(h.elements.get('quota-banner-text').textContent, /不支持实时强制刷新/);
    assert.equal(h.elements.get('quota-badge-val').textContent, '45%', '必须保留同账号 45% 缓存显示');
    assert.equal(api.getModelQuotaStateForTest(nowMs + 9000).state.lastSuccessAtMs, beforeFbSuccessTs, '缓存回退不得刷新 lastSuccessAtMs');
    for (const t of h.scheduledTimeouts.filter(t => !t.cleared && t.ms === 900)) {
      t.cleared = true; t.fn();
    }
    assert.equal(h.elements.get('btn-quota-refresh').getAttribute('data-refresh-state'), 'idle');

    // (c) 冷启动无有效数据的旧协议缓存回退 -> error 态横幅，绝不展示成功
    api.setQuotaSnapshotForTest(null, nowMs + 15000);
    const reqEmptyIdx = h.quotaRequests.length;
    const pEmptyFb = api.refreshQuotaForTest(true, { manual: true, skipScanFloor: true });
    h.quotaRequests[reqEmptyIdx].resolve({ ok: true, data: emptyFbRes });
    await pEmptyFb;
    await stepAllBoard();
    assert.equal(h.elements.get('btn-quota-refresh').getAttribute('data-refresh-state'), 'error');
    assert.equal(h.elements.get('quota-banner').hidden, false);
    assert.equal(h.elements.get('quota-banner').getAttribute('data-tone'), 'error');
    assert.match(h.elements.get('quota-banner-text').textContent, /暂无可用缓存数据/);
  } finally {
    h.sandbox.__AGContextMeter.dispose();
  }

  collector.resetQuotaHostCacheForTest();
});

test('02 批续稿终极验收：10.html 原样双池四行映射、十阶边界(78%/46%/10%/0%/10.1%/未知/无权限)、双色阶切换、尾格左对齐宽、70px 总小时圆盘(124:00/168:00/04:59)与三语400px窄栏', async () => {
  const nowMs = Date.now();
  const f5h = new Date(nowMs + 4 * 3600000 + 59 * 60000 + 30000).toISOString(); // 04:59
  const fWeek124 = new Date(nowMs + (5 * 24 + 4) * 3600000 + 42000).toISOString(); // 124:00
  const fWeek168 = new Date(nowMs + 7 * 86400000 + 10000).toISOString(); // 168:00
  const fArgon = new Date(nowMs + 5 * 86400000).toISOString();
  const { userStatusRes, quotaSummaryRes } = buildRealistic2321Fixtures(new Date(nowMs).toISOString(), f5h, fWeek124, fArgon);

  // 构造 10.html 验收边界：Gemini 7d=78%(124:00), Gemini 5h=10.1%(刚超10%非红警,04:59), Shared 7d=46%(168:00), Shared 5h=10%(红警)
  quotaSummaryRes.response.groups[0].buckets = [
    { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.78, resetTime: fWeek124 },
    { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.101, resetTime: f5h }
  ];
  quotaSummaryRes.response.groups[1].buckets = [
    { bucketId: '3p-weekly', window: 'weekly', remainingFraction: 0.46, resetTime: fWeek168 },
    { bucketId: '3p-5h', window: '5h', remainingFraction: 0.10, resetTime: new Date(nowMs + 42 * 60000 + 25000).toISOString() }
  ];
  // 去掉第 3 组验证标准双池四行（稍后再测额外独立池）
  quotaSummaryRes.response.groups = quotaSummaryRes.response.groups.slice(0, 2);

  const h = createQuotaRendererHarness();
  try {
    while (h.quotaRequests.length > 0) {
      h.quotaRequests.shift().resolve({ ok: false, error: 'init-noop' });
    }
    await h.flush();

    const api = h.sandbox.__AGContextMeter;
    api.setContextLatestForTest(
      { model: 'Gemini 4 Hydrogen (High)', modelId: 'MODEL_PLACEHOLDER_M28', actual: 1000, budget: 256000 },
      userStatusRes.userStatus.cascadeModelConfigData.clientModelConfigs
    );
    api.showQuotaPanelForTest(true);
    while (h.quotaRequests.length > 0) {
      h.quotaRequests.shift().resolve({ ok: false, error: 'noop' });
    }

    api.setQuotaSnapshotForTest({
      accountScopeKey: 'acct_10html_port',
      fetchedAtMs: nowMs,
      lastSuccessAtMs: nowMs,
      userStatusRes,
      quotaSummaryRes
    }, nowMs);

    const mainBoard = h.elements.get('quota-main-board');
    const getRow = (id) => mainBoard.children.find(c => c.getAttribute('data-row-id') === id);
    const getCells = (row) => row.children[0].children[1].children[0].children;
    const getDial = (row) => row.children[1].children[0];

    // 1. 双池四行顺序：第一组 GEMINI (7d -> 5h)，第二组 CLAUDE / GPT 共用 (7d -> 5h)，额外真实独立池继续可查看
    const rowIds = mainBoard.children.filter(c => String(c.className || '').includes('quota-row')).map(c => c.getAttribute('data-row-id'));
    assert.deepEqual(rowIds.slice(0, 4), ['gemini-7d', 'gemini-5h', 'shared-7d', 'shared-5h']);
    const carbonNoPermState = api.getQuotaBoardStateForTest().rows.find(r => String(r.id).includes('carbon'));
    assert.ok(carbonNoPermState, '其他真实独立池继续在主看板下方可查看');
    assert.equal(carbonNoPermState.isNoPermission, true, '无权限池必须独立标示为 noPermission');
    assert.equal(carbonNoPermState.isRedAlert, false, '无权限池绝不得被当成红警');

    const bState = api.getQuotaBoardStateForTest();
    assert.equal(bState.colorMode, 'uniform', '首开默认应为整条随档位变色');

    // 2. 十阶色值与未四舍五入红警边界
    const rGem7d = bState.rows.find(r => r.id === 'gemini-7d');
    const rGem5h = bState.rows.find(r => r.id === 'gemini-5h');
    const rSh7d = bState.rows.find(r => r.id === 'shared-7d');
    const rSh5h = bState.rows.find(r => r.id === 'shared-5h');

    assert.equal(rGem7d.decileStep, 8);
    assert.equal(rGem7d.colorHex, '#3CC999', '78% -> 80% 档 #3CC999');
    assert.equal(rGem7d.isRedAlert, false);
    assert.equal(rGem5h.decileStep, 2, '10.1% 未四舍五入刚超过 10% 必须走 20% 档，绝非红警');
    assert.equal(rGem5h.isRedAlert, false);
    assert.equal(rGem5h.colorHex, '#C2EEDF');
    assert.equal(rSh7d.decileStep, 5);
    assert.equal(rSh7d.colorHex, '#F6C7B0', '46% -> 50% 档 #F6C7B0');
    assert.equal(rSh5h.decileStep, 1);
    assert.equal(rSh5h.isRedAlert, true, '10% 必须触发统一红警 #EF4444');
    assert.equal(rSh5h.colorHex, '#EF4444');

    // 3. 78% 精确 20 格尾格左对齐宽 (15 满格 + 第 16 格 60.00% 宽、opacity=1)
    const gem7dCells = getCells(getRow('gemini-7d'));
    assert.equal(gem7dCells[14].children[0].style.width, '100.00%');
    assert.equal(gem7dCells[15].children[0].style.width, '60.00%', '78% 第 16 格必须为 60.00% 宽度');
    assert.equal(gem7dCells[15].children[0].style.opacity, '1');
    assert.equal(gem7dCells[16].children[0].style.width, '0%');
    assert.equal(gem7dCells[0].children[0].style.backgroundColor, '#3CC999', 'uniform 模式首格取当前档位色');

    // 4. 切换至「条内 10 阶逐段加深」原地重绘：健康行首对用 segment0Hex，红警行仍全红 #EF4444
    h.elements.get('quota-color-mode-progressive').click();
    assert.equal(api.getQuotaBoardStateForTest().colorMode, 'progressive');
    assert.equal(gem7dCells[0].children[0].style.backgroundColor, '#F2FDF9', 'progressive 健康行首对必须用 segment0Hex');
    assert.equal(gem7dCells[1].children[0].style.backgroundColor, '#F2FDF9');
    assert.equal(gem7dCells[2].children[0].style.backgroundColor, '#E6FAF3');
    assert.equal(getCells(getRow('shared-5h'))[0].children[0].style.backgroundColor, '#EF4444', 'progressive 模式下 ≤10% 仍全行统一红警');
    h.elements.get('quota-color-mode-uniform').click();
    assert.equal(api.getQuotaBoardStateForTest().colorMode, 'uniform');

    // 5. 70px 圆盘总小时:分钟 (124:00 / 168:00 / 04:59 / 00:42) 与三位缩字 is-three-digits
    assert.equal(rGem7d.dialText, '124:00', '5 天 4 小时整显示 124:00');
    assert.equal(rGem7d.dialThreeDigits, true);
    assert.equal(rSh7d.dialText, '168:00', '7 天整显示 168:00');
    assert.equal(rSh7d.dialThreeDigits, true);
    assert.equal(rGem5h.dialText, '04:59', '5h 保留 04:59 短时格式');
    assert.equal(rGem5h.dialThreeDigits, false);
    assert.equal(rSh5h.dialText, '00:42');

    // 6. 0%、未知、无权限边界与三语零中英文括号
    const edgeSummary = JSON.parse(JSON.stringify(quotaSummaryRes));
    edgeSummary.response.groups[0].buckets[0].remainingFraction = 0; // 0%
    edgeSummary.response.groups[0].buckets[1].remainingFraction = null; // 未知
    edgeSummary.response.groups[0].buckets[1].resetTime = null;
    api.setQuotaSnapshotForTest({
      accountScopeKey: 'acct_10html_port',
      fetchedAtMs: nowMs + 1000,
      lastSuccessAtMs: nowMs + 1000,
      userStatusRes,
      quotaSummaryRes: edgeSummary
    }, nowMs + 1000);
    const edgeState = api.getQuotaBoardStateForTest();
    const zeroRow = edgeState.rows.find(r => r.id === 'gemini-7d');
    const unkRow = edgeState.rows.find(r => r.id === 'gemini-5h');
    assert.equal(zeroRow.isRedAlert, true, '0% 保留红警');
    assert.equal(zeroRow.visualLitCount, 0, '0% 20 格全空');
    assert.equal(unkRow.isUnknown, true, '未知态独立显示');
    assert.equal(unkRow.isRedAlert, false, '未知态绝不得被当成红警');
    assert.equal(unkRow.dialPending, true);
    assert.equal(unkRow.dialText, '--:--');

    // 三语 (zh-CN / zh-TW / en) 零中英文括号核验 + 零行级「同池共用」与零档位色号胶囊
    for (const lang of ['zh-CN', 'zh-TW', 'en']) {
      await api.setPanelLanguage(lang, { persist: false });
      api.setQuotaSnapshotForTest({
        accountScopeKey: 'acct_10html_port',
        fetchedAtMs: nowMs,
        lastSuccessAtMs: nowMs,
        userStatusRes,
        quotaSummaryRes
      }, nowMs);
      const g7dDial = getDial(getRow('gemini-7d'));
      assert.equal(/[()（）]/.test(g7dDial.title), false, `${lang} 圆盘提示必须零中英文括号`);
      assert.equal(/[()（）]/.test(g7dDial.getAttribute('aria-label')), false, `${lang} 无障碍文本必须零中英文括号`);
      for (const r of api.getQuotaBoardStateForTest().rows) {
        assert.equal(/[()（）]/.test(r.pacePillText), false, `${lang} 节奏胶囊零括号`);
        assert.equal(/[()（）]/.test(r.timeSummary), false, `${lang} 顶行摘要零括号`);
        assert.equal(/[()（）]/.test(r.subtext), false, `${lang} 副文案零括号`);
        assert.equal(r.badges.some(b => /同池共用|Shared Pool/i.test(b)), false, `${lang} 严禁出现行级同池共用徽标`);
      }
      const boardRows = mainBoard.children.filter(c => String(c.className || '').includes('quota-row'));
      for (const br of boardRows) {
        const summaryChildren = br.children[0].children[0].children[1].children;
        assert.equal(summaryChildren.some(n => String(n.className || '').includes('decile-status-badge')), false, `${lang} 严禁渲染档位开发标注胶囊`);
        assert.equal(summaryChildren.some(n => /#[0-9A-Fa-f]{6}/.test(String(n.textContent || ''))), false, `${lang} 严禁暴露色号`);
      }
    }
    await api.setPanelLanguage('zh-CN', { persist: false });

    // 7. CSS 宽栏/窄栏 400px 响应式契约核验
    const cssSrc = fs.readFileSync(path.join(__dirname, 'src', 'renderer', 'styles.css'), 'utf8');
    assert.match(cssSrc, /@container\s+quota-panel\s*\(max-width:\s*560px\)/);
    assert.match(cssSrc, /#panel-quota\s+\.dial-digits\.is-three-digits/);
    assert.match(cssSrc, /#panel-quota\s+\.seg-grid[\s\S]*gap:\s*3px/);
    assert.equal(/\.decile-status-badge/.test(cssSrc), false, 'styles.css 必须移除档位开发胶囊样式');
    assert.equal(/\.quota-color-mode-btn/.test(cssSrc), false, 'styles.css 必须移除橙色旧模式切换器样式');
  } finally {
    h.sandbox.__AGContextMeter.dispose();
  }
});

test('02 批浅色可读性与看板细节收口：四行统一浅色加深、自定义表面色即时重绘、10.1%上游取整容错、缺绝对时间省略未知、估算跨厂商判定与分段选择器键盘持久化', async () => {
  const nowMs = Date.now();
  const f5h = new Date(nowMs + 36 * 60000 + 20000).toISOString();
  const fWeek = new Date(nowMs + (5 * 24 + 2) * 3600000 + 16 * 60000).toISOString();
  const fArgon = new Date(nowMs + 5 * 86400000).toISOString();
  const { userStatusRes, quotaSummaryRes } = buildRealistic2321Fixtures(new Date(nowMs).toISOString(), f5h, fWeek, fArgon);

  quotaSummaryRes.response.groups[0].buckets = [
    { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.36, resetTime: fWeek },
    { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.101, resetTime: f5h }
  ];
  quotaSummaryRes.response.groups[1].buckets = [
    { bucketId: '3p-weekly', window: 'weekly', remainingFraction: 0.28, resetTime: fWeek },
    { bucketId: '3p-5h', window: '5h', remainingFraction: 0.25, resetTime: f5h }
  ];
  quotaSummaryRes.response.groups = quotaSummaryRes.response.groups.slice(0, 2);

  const hexToLum = (hex) => {
    const clean = String(hex || '').replace('#', '');
    const n = parseInt(clean, 16);
    const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const hexToHue = (hex) => {
    const clean = String(hex || '').replace('#', '');
    const n = parseInt(clean, 16);
    const r = ((n >> 16) & 255) / 255;
    const g = ((n >> 8) & 255) / 255;
    const b = (n & 255) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    if (d === 0) return 0;
    let h = max === r ? ((g - b) / d + (g < b ? 6 : 0)) : (max === g ? (b - r) / d + 2 : (r - g) / d + 4);
    return h * 60;
  };

  const h = createQuotaRendererHarness();
  try {
    while (h.quotaRequests.length > 0) h.quotaRequests.shift().resolve({ ok: false, error: 'init-noop' });
    await h.flush();

    const api = h.sandbox.__AGContextMeter;
    api.setContextLatestForTest(
      { model: 'Gemini 4 Hydrogen (High)', modelId: 'MODEL_PLACEHOLDER_M28', actual: 1000, budget: 256000 },
      userStatusRes.userStatus.cascadeModelConfigData.clientModelConfigs
    );
    api.showQuotaPanelForTest(true);
    while (h.quotaRequests.length > 0) h.quotaRequests.shift().resolve({ ok: false, error: 'noop' });

    api.setThemeModeForTest('dark');
    api.setQuotaSnapshotForTest({
      accountScopeKey: 'acct_light_polish',
      fetchedAtMs: nowMs,
      lastSuccessAtMs: nowMs,
      userStatusRes,
      quotaSummaryRes
    }, nowMs);

    // 1. 标题区生产回归：真实 renderQuotaBoard 呈现套餐胶囊与单一更新时间
    assert.equal(h.elements.get('quota-plan-tier-pill').hidden, false);
    assert.equal(h.elements.get('quota-plan-tier-pill').textContent, 'Google AI Pro');
    const updatedMeta = h.elements.get('quota-updated-meta');
    assert.ok(updatedMeta, '应存在单一更新时间容器');
    const updatedTimeVal = h.elements.get('quota-time-updated').textContent;
    assert.match(updatedTimeVal, /\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}/);
    assert.equal(/更新于/.test(updatedTimeVal), false, '不得出现「上次更新 更新于」重复文案');

    // 2. 临界 10.1% 显示精度：即使上游 percentText 已被取整成 "10%" 也必须显示 10.1% 且不触发红警
    const darkState = api.getQuotaBoardStateForTest();
    const g5hRow = darkState.rows.find(r => r.id === 'gemini-5h');
    assert.equal(g5hRow.isRedAlert, false);
    assert.equal(g5hRow.pctText, '10.1%', '10.1% 必须与 10% 红警在文案上清晰区分');

    // 3. 深浅色四行成对采样验证（uniform 与 progressive 模式共享同一浅色明度派生规则）
    const palettes = ['gemini-7d', 'gemini-5h', 'shared-7d', 'shared-5h'];
    for (const pid of palettes) {
      let prevLightLum = 1.01;
      // 逐段模式首对格 (cellIndex=0)
      const seg0Dark = api.resolveQuotaCellColorForTest(pid, 0, 40, 'progressive', { surface: 'dark' });
      const seg0Light = api.resolveQuotaCellColorForTest(pid, 0, 40, 'progressive', { surface: 'light' });
      assert.ok(hexToLum(seg0Light) < hexToLum(seg0Dark) - 0.10, `${pid} 逐段首对格浅色必须明显深于深色`);
      for (const pct of [20, 30, 40, 60, 80, 100]) {
        const dSpec = api.resolveQuotaDecileSpecForTest(pid, pct, { surface: 'dark' });
        const lSpec = api.resolveQuotaDecileSpecForTest(pid, pct, { surface: 'light' });
        assert.ok(hexToLum(lSpec.hex) < hexToLum(dSpec.hex), `${pid} ${pct}% 浅色必须深于深色`);
        assert.ok(hexToLum(lSpec.hex) < prevLightLum, `${pid} ${pct}% 浅色十阶必须严格单调加深`);
        prevLightLum = hexToLum(lSpec.hex);
        const hueDiff = Math.min(Math.abs(hexToHue(lSpec.hex) - hexToHue(dSpec.hex)), 360 - Math.abs(hexToHue(lSpec.hex) - hexToHue(dSpec.hex)));
        assert.ok(hueDiff < 8, `${pid} ${pct}% 浅色派生必须保持色相一致 (diff=${hueDiff.toFixed(1)})`);
      }
    }
    // 同组 7d 浅于 5h 的层级保持
    for (const pct of [20, 30, 40, 80, 100]) {
      const g7 = api.resolveQuotaDecileSpecForTest('gemini-7d', pct, { surface: 'light' });
      const g5 = api.resolveQuotaDecileSpecForTest('gemini-5h', pct, { surface: 'light' });
      const s7 = api.resolveQuotaDecileSpecForTest('shared-7d', pct, { surface: 'light' });
      const s5 = api.resolveQuotaDecileSpecForTest('shared-5h', pct, { surface: 'light' });
      assert.ok(hexToLum(g7.hex) > hexToLum(g5.hex), `浅色 ${pct}% Gemini 7d 必须浅于 5h`);
      assert.ok(hexToLum(s7.hex) > hexToLum(s5.hex), `浅色 ${pct}% Shared 7d 必须浅于 5h`);
    }

    // 4. 切换主题与自定义面板表面色时，看板立即原位重绘所有有效格
    const mainBoard = h.elements.get('quota-main-board');
    const g7RowDom = mainBoard.children.find(c => c.getAttribute('data-row-id') === 'gemini-7d');
    const g7Cell0Fill = g7RowDom.children[0].children[1].children[0].children[0].children[0];
    const darkHexBefore = g7Cell0Fill.style.backgroundColor;
    assert.equal(darkHexBefore, '#B0EDD8');

    api.setThemeModeForTest('light');
    assert.equal(api.getQuotaBoardStateForTest().surfaceTone, 'light');
    assert.equal(mainBoard.getAttribute('data-surface-tone'), 'light');
    const lightHexAfter = g7Cell0Fill.style.backgroundColor;
    assert.notEqual(lightHexAfter, darkHexBefore, '切浅色主题必须立即原位加深有效格');
    assert.ok(hexToLum(lightHexAfter) < hexToLum(darkHexBefore), '浅色有效格亮度必须低于深色');

    // 在浅色主题下设置自定义深色面板背景，必须尊重 data-panel-tone="dark" 切回深色原色
    api.setCustomPanelBgForTest('#181818');
    assert.equal(api.getQuotaBoardStateForTest().surfaceTone, 'dark');
    assert.equal(g7Cell0Fill.style.backgroundColor, '#B0EDD8');
    api.setCustomPanelBgForTest('');
    assert.equal(api.getQuotaBoardStateForTest().surfaceTone, 'light');

    // 5. 顶行压缩重复天小时 + 缺失绝对时间但有倒计时时省略「未知」与分隔符
    const g7Summary = api.getQuotaBoardStateForTest().rows.find(r => r.id === 'gemini-7d').timeSummary;
    assert.equal(/122h|\d+h$/.test(g7Summary), false, '7d 顶行应压缩重复的总小时摘要');
    assert.ok(api.getQuotaBoardStateForTest().rows.find(r => r.id === 'gemini-7d').subtext.includes('122'), '完整小时数保留在副文案');

    // 构造无 resetTimeText 但有有效 resetAtMs + 上游 percentText 被取整为 "10%" 的 10.1% 视图
    const snapMissingRt = core.buildModelQuotaSnapshot({
      userStatusRes,
      quotaSummaryRes,
      currentModel: { modelId: 'MODEL_PLACEHOLDER_M28', label: 'Gemini 4 Hydrogen (High)' },
      fetchMeta: { fetchedAtMs: nowMs },
      nowMs
    });
    snapMissingRt.pools[0].buckets[1].resetTimeText = '';
    snapMissingRt.pools[0].buckets[1].percentText = '10%'; // 模拟上游已四舍五入为 10%
    snapMissingRt.pools[0].buckets[1].remainingFraction = 0.101;
    api.setQuotaSnapshotForTest({
      accountScopeKey: 'acct_light_polish',
      fetchedAtMs: nowMs,
      lastSuccessAtMs: nowMs,
      snapshot: snapMissingRt
    }, nowMs);
    const missingRtRow = api.getQuotaBoardStateForTest().rows.find(r => r.id === 'gemini-5h');
    const missingRtSummary = missingRtRow.timeSummary;
    assert.equal(missingRtRow.isRedAlert, false, '10.1% 即使上游 percentText="10%" 也绝不触发红警');
    assert.equal(missingRtRow.pctText, '10.1%', '10.1% 即使上游 percentText="10%" 也必须显示 10.1%');
    assert.equal(/未知|Unknown/.test(missingRtSummary), false, '有有效倒计时但缺绝对时间文案时不得拼出「未知」');
    assert.equal(/^·|·$/.test(missingRtSummary.trim()), false, '不得残留孤立分隔符');
    assert.ok(missingRtSummary.includes('36'), '仍保留有效倒计时读数');

    // 6. Gemini 估算副文案不误标「同池混用模型」；Claude + GPT 跨厂商真实混用正确标注且零括号
    api.setTokenHistoryForTest({
      accountScopeKey: 'acct_light_polish',
      quotaUsageCoverageStartMs: nowMs - 8 * 86400000,
      recentModelUsage: [
        { accountScopeKey: 'acct_light_polish', poolKey: 'gemini-4-neon', sharedGroupKey: 'shared_gemini_main', ts: nowMs - 3600000, inputTokens: 80000000, cacheTokens: 60000000, outputTokens: 10000000, totalTokens: 150000000 },
        { accountScopeKey: 'acct_light_polish', poolKey: 'gemini-4-hydrogen', sharedGroupKey: 'shared_gemini_main', ts: nowMs - 1800000, inputTokens: 50000000, cacheTokens: 45000000, outputTokens: 8800000, totalTokens: 103800000 },
        { accountScopeKey: 'acct_light_polish', poolKey: 'claude-sonnet-5-5', sharedGroupKey: 'shared_3p_pool', ts: nowMs - 3600000, inputTokens: 15000000, cacheTokens: 10000000, outputTokens: 5000000, totalTokens: 30000000 },
        { accountScopeKey: 'acct_light_polish', poolKey: 'gpt-oss-120b', sharedGroupKey: 'shared_3p_pool', ts: nowMs - 1800000, inputTokens: 5000000, cacheTokens: 3000000, outputTokens: 2000000, totalTokens: 10000000 }
      ],
      dailyMap: {}
    });
    api.setQuotaSnapshotForTest({
      accountScopeKey: 'acct_light_polish',
      fetchedAtMs: nowMs + 500,
      lastSuccessAtMs: nowMs + 500,
      userStatusRes,
      quotaSummaryRes
    }, nowMs + 500);
    const estState = api.getQuotaBoardStateForTest();
    const gemCap = estState.rows.find(r => r.id === 'gemini-7d').tokenCaption;
    const sharedCap = estState.rows.find(r => r.id === 'shared-7d').tokenCaption;
    assert.ok(gemCap.includes('约剩余'), `Gemini 7d 应产出真实估算副文案: ${gemCap}`);
    assert.equal(/同池混用/.test(gemCap), false, `Gemini 同厂商多型号绝不得误标同池混用模型: ${gemCap}`);
    assert.equal(/[()（）]/.test(gemCap), false, '估算副文案零括号');
    assert.ok(sharedCap.includes('约剩余'), `Shared 7d 应产出真实估算副文案: ${sharedCap}`);
    assert.equal(/同池混用/.test(sharedCap), true, `Claude + GPT 跨厂商混用保留提示: ${sharedCap}`);
    assert.equal(/[()（）]/.test(sharedCap), false, '跨厂商混用副文案零括号');

    // 7. 分段选择器复用 ctx-segmented / ctx-seg-pill、键盘导航与持久化重开读回
    const tplSrc = fs.readFileSync(path.join(__dirname, 'src', 'renderer', 'template.html'), 'utf8');
    assert.match(tplSrc, /id="quota-color-mode-segmented"\s+class="ctx-segmented ctx-seg-pill quota-color-mode-segmented"/, '模板必须复用 ctx-segmented ctx-seg-pill');
    assert.match(tplSrc, /id="quota-color-mode-uniform"\s+class="ctx-seg-btn active"/, '按钮必须复用 ctx-seg-btn');
    const segGroup = h.elements.get('quota-color-mode-segmented');
    const btnUni = h.elements.get('quota-color-mode-uniform');
    const btnProg = h.elements.get('quota-color-mode-progressive');
    btnUni.setAttribute('data-color-mode', 'uniform');
    btnProg.setAttribute('data-color-mode', 'progressive');
    assert.equal(btnUni.classList.contains('active'), true);
    assert.equal(btnUni.getAttribute('aria-pressed'), 'true');
    assert.equal(btnProg.getAttribute('aria-pressed'), 'false');

    // 键盘 ArrowRight 切到 progressive
    let prevented = false;
    segGroup.dispatchEvent({ type: 'keydown', key: 'ArrowRight', target: btnUni, preventDefault: () => { prevented = true; } });
    assert.equal(prevented, true);
    assert.equal(api.getQuotaBoardStateForTest().colorMode, 'progressive');
    assert.equal(btnProg.classList.contains('active'), true);
    assert.equal(btnProg.getAttribute('aria-pressed'), 'true');
    assert.equal(btnUni.classList.contains('active'), false);
    assert.equal(h.sandbox.localStorage.getItem('ag_quota_color_mode'), 'progressive');

    // progressive 浅色首对格使用浅色派生值
    const progLightCell0 = g7Cell0Fill.style.backgroundColor;
    assert.equal(progLightCell0, api.resolveQuotaCellColorForTest('gemini-7d', 0, 36, 'progressive', { surface: 'light' }));

    // 键盘 Home 回到 uniform
    segGroup.dispatchEvent({ type: 'keydown', key: 'Home', target: btnProg, preventDefault: () => { } });
    assert.equal(api.getQuotaBoardStateForTest().colorMode, 'uniform');
    assert.equal(h.sandbox.localStorage.getItem('ag_quota_color_mode'), 'uniform');
  } finally {
    h.sandbox.__AGContextMeter.dispose();
  }
});


