'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const meterAccounts = require('./meter-accounts');

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeMockQuotaSnapshot(gem5h, gem7d, p35h, p37d) {
  return {
    syncState: 'fresh',
    updatedAtMs: Date.now(),
    pools: [
      {
        poolKey: 'shared_gemini_main',
        title: 'Gemini',
        remainingFraction: gem5h / 100,
        buckets: [
          { windowKey: '5h', windowShort: '5h', remainingFraction: gem5h / 100 },
          { windowKey: 'weekly', windowShort: '7d', remainingFraction: gem7d / 100 }
        ]
      },
      {
        poolKey: 'shared_3p_pool',
        title: 'Claude / GPT',
        remainingFraction: p35h / 100,
        buckets: [
          { windowKey: '5h', windowShort: '5h', remainingFraction: p35h / 100 },
          { windowKey: 'weekly', windowShort: '7d', remainingFraction: p37d / 100 }
        ]
      }
    ]
  };
}

test('幽灵账号隔离：删除账号写入墓碑后，多次刷新、宿主快照同步、停用标记与重载均永不复活', async () => {
  const tmpDir = makeTempDir('ag-ghost-iso-');
  const prevStateEnv = process.env.AG_METER_STATE_DIR;
  process.env.AG_METER_STATE_DIR = tmpDir;
  try {
    const ghostEmail = 'alpha.user@gmail.com';
    const realEmail = 'real.user@gmail.com';

    const mgr = meterAccounts.createAccountsManager({
      stateDir: tmpDir,
      homeDir: tmpDir,
      getHostUserStatus: async () => ({
        email: ghostEmail,
        userStatus: { email: ghostEmail, name: 'Ghost Host' }
      }),
      fetchActiveHostSnapshot: async () => ({
        ok: true,
        email: ghostEmail,
        fetchedAtMs: Date.now(),
        snapshot: makeMockQuotaSnapshot(80, 90, 75, 85)
      })
    });

    mgr.addAccountWithCredential({
      email: ghostEmail,
      name: 'Ghost User',
      accessToken: 'tok-ghost',
      refreshToken: 'ref-ghost'
    });
    mgr.addAccountWithCredential({
      email: realEmail,
      name: 'Real User',
      accessToken: 'tok-real',
      refreshToken: 'ref-real'
    });

    // 确认移除成功并原子落盘墓碑
    const rmRes = mgr.removeAccount(ghostEmail);
    assert.equal(rmRes.ok, true);
    assert.equal(rmRes.removedEmail, ghostEmail);

    const diskAfterRemove = JSON.parse(fs.readFileSync(path.join(tmpDir, 'accounts_v1.json'), 'utf8'));
    assert.equal(Boolean(diskAfterRemove.accounts[ghostEmail]), false, '磁盘 accounts 不应再包含已删账号');
    assert.ok(diskAfterRemove.deletedAccounts && diskAfterRemove.deletedAccounts[ghostEmail], '磁盘必须记录删除墓碑');

    // 1. 触发 detectCurrentActiveAccount 即使宿主仍上报已删邮箱，也不得复活进 accounts
    await mgr.detectCurrentActiveAccount();
    assert.equal(mgr.getOverviewState().accounts.some(a => a.email === ghostEmail), false, 'detectCurrentActiveAccount 不得复活已删账号');

    // 2. 触发 syncActiveHostQuotaSnapshot 也不得复活已删账号
    const syncRes = mgr.syncActiveHostQuotaSnapshot({ snapshot: makeMockQuotaSnapshot(60, 70, 60, 70) }, ghostEmail);
    assert.equal(syncRes, null, 'syncActiveHostQuotaSnapshot 对已删账号必须返回 null');
    assert.equal(mgr.getOverviewState().accounts.some(a => a.email === ghostEmail), false, 'syncActiveHostQuotaSnapshot 不得复活已删账号');

    // 3. 触发 markAccountSuspended 不得复活已删账号
    const susRes = mgr.markAccountSuspended(ghostEmail, 'Your account has been suspended due to Terms of Service violation');
    assert.equal(susRes.ok, false);
    assert.equal(susRes.removed, true);
    assert.equal(mgr.getOverviewState().accounts.some(a => a.email === ghostEmail), false, 'markAccountSuspended 不得复活已删账号');

    // 4. 触发多次 refresh_quota（单账号与全量）均不得复活
    const rfSingle = await meterAccounts.dispatchAccountsAction(mgr, { action: 'refresh_quota', email: ghostEmail });
    assert.equal(rfSingle.ok, false);
    await meterAccounts.dispatchAccountsAction(mgr, { action: 'refresh_quota' });
    assert.equal(mgr.getOverviewState().accounts.some(a => a.email === ghostEmail), false, 'refresh_quota 不得复活已删账号');

    // 5. 模拟多源 ~/.antigravity_tools 存在同名残留，默认全量导入不得把已删账号灌回
    const fakeToolsDir = path.join(tmpDir, '.antigravity_tools');
    fs.mkdirSync(path.join(fakeToolsDir, 'accounts'), { recursive: true });
    fs.writeFileSync(path.join(fakeToolsDir, 'accounts.json'), JSON.stringify({
      accounts: [{ id: 'ghost-1', email: ghostEmail, name: 'Ghost From Tools' }]
    }), 'utf8');
    fs.writeFileSync(path.join(fakeToolsDir, 'accounts', 'ghost-1.json'), JSON.stringify({
      email: ghostEmail,
      token: { refresh_token: 'ref-tools-ghost' }
    }), 'utf8');
    mgr.importFromAntigravityTools(null);
    assert.equal(mgr.getOverviewState().accounts.some(a => a.email === ghostEmail), false, '批量导入 Tools 不得复活已删墓碑账号');

    // 6. 重载新实例后依然不复活，且真实账号完好保留
    const mgrReload = meterAccounts.createAccountsManager({ stateDir: tmpDir, homeDir: tmpDir });
    const reloadedEmails = mgrReload.getOverviewState().accounts.map(a => a.email);
    assert.deepEqual(reloadedEmails, [realEmail]);
  } finally {
    if (prevStateEnv === undefined) delete process.env.AG_METER_STATE_DIR;
    else process.env.AG_METER_STATE_DIR = prevStateEnv;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('防测试目录污染：storageDir 别名与临时目录自动隔离，严禁触碰真实用户 accounts_v1.json', () => {
  const tmpDir = makeTempDir('ag-storage-alias-');
  const prevStateEnv = process.env.AG_METER_STATE_DIR;
  delete process.env.AG_METER_STATE_DIR;
  try {
    const mgr = meterAccounts.createAccountsManager({ storageDir: tmpDir });
    mgr.addAccountWithCredential({
      email: 'alias.test@gmail.com',
      name: 'Alias Test',
      accessToken: 'tok-alias',
      refreshToken: 'ref-alias'
    });
    assert.equal(fs.existsSync(path.join(tmpDir, 'accounts_v1.json')), true, 'storageDir 必须被识别为隔离目录');
    const disk = JSON.parse(fs.readFileSync(path.join(tmpDir, 'accounts_v1.json'), 'utf8'));
    assert.ok(disk.accounts['alias.test@gmail.com']);

    // 核查本机真实目录不含测试假号
    const realPath = path.join(os.homedir(), 'AppData', 'Local', 'AntigravityContextMeter', 'accounts_v1.json');
    if (fs.existsSync(realPath)) {
      const realData = JSON.parse(fs.readFileSync(realPath, 'utf8'));
      const realEmails = Object.keys(realData.accounts || {});
      assert.equal(realEmails.includes('alpha.user@gmail.com'), false, '本机真实 accounts_v1.json 不得残留 alpha.user@gmail.com');
      assert.equal(realEmails.includes('alias.test@gmail.com'), false, '本机真实 accounts_v1.json 不得残留测试假号');
    }
  } finally {
    if (prevStateEnv === undefined) delete process.env.AG_METER_STATE_DIR;
    else process.env.AG_METER_STATE_DIR = prevStateEnv;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('账号页顶部药丸升级：三语零括号、串行刷新全部含取消与失败保底、一键切换余量最高账号', async () => {
  const hostSettingsSrc = fs.readFileSync(path.join(__dirname, 'src', 'renderer', 'host-settings.js'), 'utf8');
  const ctx = {
    console,
    setTimeout,
    clearTimeout,
    Date,
    Math,
    RegExp,
    Object,
    Array,
    Map,
    Set,
    WeakSet,
    Symbol,
    Promise,
    Number,
    String,
    Boolean,
    window: {},
    document: undefined
  };
  vm.createContext(ctx);
  vm.runInContext(hostSettingsSrc, ctx, { filename: 'host-settings.js' });

  const accountsFixture = [
    {
      email: 'low.active@gmail.com',
      maskedEmail: 'lo***ve@gmail.com',
      isActive: true,
      hasRefreshToken: true,
      suspended: false,
      quotaSnapshot: makeMockQuotaSnapshot(20, 30, 25, 35)
    },
    {
      email: 'best.quota@gmail.com',
      maskedEmail: 'be***ta@gmail.com',
      isActive: false,
      hasRefreshToken: true,
      suspended: false,
      quotaSnapshot: makeMockQuotaSnapshot(92, 95, 88, 90)
    },
    {
      email: 'fail.acct@gmail.com',
      maskedEmail: 'fa***ct@gmail.com',
      isActive: false,
      hasRefreshToken: true,
      suspended: false,
      quotaSnapshot: makeMockQuotaSnapshot(50, 50, 50, 50)
    },
    {
      email: 'suspended.acct@gmail.com',
      maskedEmail: 'su***ct@gmail.com',
      isActive: false,
      hasRefreshToken: true,
      suspended: true,
      quotaSnapshot: makeMockQuotaSnapshot(100, 100, 100, 100)
    }
  ];

  const switchedCalls = [];
  const refreshedOrder = [];
  const ctrl = ctx.createHostSettingsController({
    getAccountsPageSnapshot: () => ({
      lang: 'zh-CN',
      hideEmail: false,
      busy: false,
      accounts: accountsFixture
    }),
    onAccountsPageAction: (action, payload) => {
      if (action === 'switchAccount') switchedCalls.push(payload.email);
    },
    refreshAllThrottleMs: 5,
    refreshSingleAccountForAll: async (acc) => {
      refreshedOrder.push(acc.email);
      if (acc.email === 'fail.acct@gmail.com') {
        return { ok: false, error: 'HTTP 429 rate limited' };
      }
      return { ok: true };
    }
  });

  // 1. 三语文案严格零中英文括号
  const i18nMap = ctrl.getAccountsUpgradeI18nForTest();
  for (const [k, langs] of Object.entries(i18nMap)) {
    for (const [lang, text] of Object.entries(langs)) {
      assert.equal(/[()（）]/.test(String(text)), false, `host-settings.js 文案 ${k}.${lang} 严禁包含括号: ${text}`);
    }
  }

  // 2. 串行刷新全部账号：跳过停用账号，失败账号记录原因且不中断后续
  const rfRes = await ctrl.refreshAllAccounts();
  assert.deepEqual(refreshedOrder, ['low.active@gmail.com', 'best.quota@gmail.com', 'fail.acct@gmail.com']);
  assert.equal(rfRes.total, 3);
  assert.equal(rfRes.okCount, 2);
  assert.equal(rfRes.failCount, 1);
  assert.equal(rfRes.partialOk, true);
  assert.equal(rfRes.errors[0].email, 'fail.acct@gmail.com');

  // 3. 中途取消测试
  let slowCount = 0;
  const ctrlCancel = ctx.createHostSettingsController({
    getAccountsPageSnapshot: () => ({ lang: 'zh-CN', accounts: accountsFixture }),
    refreshAllThrottleMs: 20,
    refreshSingleAccountForAll: async () => {
      slowCount += 1;
      if (slowCount === 1) ctrlCancel.cancelRefreshAllAccounts();
      return { ok: true };
    }
  });
  const cancelRes = await ctrlCancel.refreshAllAccounts();
  assert.equal(cancelRes.cancelled, true);
  assert.equal(slowCount, 1);

  // 4. 一键切换到余量充足账号：排除停用账号，选中 5H+7D 综合最高的 best.quota@gmail.com
  const swRes = ctrl.switchToBestQuotaAccount();
  assert.equal(swRes.ok, true);
  assert.equal(swRes.switched, true);
  assert.equal(swRes.targetEmail, 'best.quota@gmail.com');
  assert.deepEqual(switchedCalls, ['best.quota@gmail.com']);

  // 5. 若当前账号已是余量最高，弹出轻提示且不触发切号
  accountsFixture[0].isActive = false;
  accountsFixture[1].isActive = true;
  const swAlready = ctrl.switchToBestQuotaAccount();
  assert.equal(swAlready.ok, true);
  assert.equal(swAlready.alreadyBest, true);
  assert.equal(switchedCalls.length, 1, '当前已是最高余量时不得重复触发切号');
});
