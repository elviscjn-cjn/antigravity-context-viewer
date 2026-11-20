'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { safeWriteJsonSync, safeReadJsonSync } = require('./meter-storage');
const {
  detectProxyConfig,
  applyProxyEnvironment,
  buildCliProxyEnv,
  getProxyCandidatePaths,
  DEFAULT_NO_PROXY
} = require('./meter-proxy');
const {
  loadPricingLedger,
  savePricingLedger,
  recordModelCalls,
  savePluginSettings,
  getPluginSettings
} = require('./meter-collector');

test('safeWriteJsonSync: 正常保存、递归建目录与读回一致性', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-storage-test-'));
  try {
    const targetPath = path.join(tempDir, 'sub', 'nested', 'target.json');
    const data = { hello: 'world', count: 42, list: [1, 2, 3] };

    const writeRes = safeWriteJsonSync(targetPath, data);
    assert.equal(writeRes.ok, true);
    assert.equal(writeRes.path, path.resolve(targetPath));

    const readRes = safeReadJsonSync(targetPath);
    assert.equal(readRes.ok, true);
    assert.deepEqual(readRes.data, data);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('safeWriteJsonSync: 临时文件写入失败时正确返回错误并清理临时文件', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-storage-test-'));
  try {
    const targetPath = path.join(tempDir, 'target.json');
    const mockFs = {
      ...fs,
      writeFileSync(p, content, enc) {
        if (p.includes('.tmp')) {
          throw new Error('Disk full on write');
        }
        return fs.writeFileSync(p, content, enc);
      }
    };

    const writeRes = safeWriteJsonSync(targetPath, { key: 'val' }, { fs: mockFs });
    assert.equal(writeRes.ok, false);
    assert.equal(writeRes.phase, 'write_temp');
    assert.match(writeRes.error, /Disk full on write/);
    assert.equal(fs.existsSync(targetPath), false);
    // 验证同目录下没有遗留 .tmp 文件
    const files = fs.readdirSync(tempDir);
    assert.equal(files.filter(f => f.endsWith('.tmp')).length, 0);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('safeWriteJsonSync: 重命名失败后原文件保持完整无损，且不退回覆盖', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-storage-test-'));
  try {
    const targetPath = path.join(tempDir, 'original.json');
    const originalData = { version: '1.0', important: 'do-not-lose-me' };
    fs.writeFileSync(targetPath, JSON.stringify(originalData), 'utf8');

    const mockFs = {
      ...fs,
      renameSync() {
        throw new Error('EPERM: operation not permitted');
      }
    };

    const newData = { version: '2.0', important: 'corrupted-if-overwritten' };
    const writeRes = safeWriteJsonSync(targetPath, newData, { fs: mockFs });

    assert.equal(writeRes.ok, false);
    assert.equal(writeRes.phase, 'rename');
    assert.match(writeRes.error, /EPERM/);

    // 写入失败时保留原文件内容
    const preserved = JSON.parse(fs.readFileSync(targetPath, 'utf8'));
    assert.deepEqual(preserved, originalData);

    // 验证临时文件已被清理
    const files = fs.readdirSync(tempDir);
    assert.equal(files.filter(f => f.endsWith('.tmp')).length, 0);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('safeWriteJsonSync: 校验失败时错误正确传播并区分前置与后置阶段', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-storage-test-'));
  try {
    const targetPath = path.join(tempDir, 'validate.json');
    fs.writeFileSync(targetPath, JSON.stringify({ initial: true }), 'utf8');

    // 1. 替换前校验失败 (pre_verify)
    const writeRes1 = safeWriteJsonSync(targetPath, { score: 5 }, {
      validate: (data) => data.score > 10
    });
    assert.equal(writeRes1.ok, false);
    assert.equal(writeRes1.phase, 'pre_verify');
    assert.deepEqual(JSON.parse(fs.readFileSync(targetPath, 'utf8')), { initial: true });

    // 2. 替换后校验失败 (post_verify)
    let hasRenamed = false;
    const mockFs = {
      ...fs,
      renameSync(src, dst) {
        hasRenamed = true;
        return fs.renameSync(src, dst);
      },
      readFileSync(p, enc) {
        if (hasRenamed && p === path.resolve(targetPath)) {
          return '{"score": 2}'; // 模拟被篡改或不合法
        }
        return fs.readFileSync(p, enc);
      }
    };

    const writeRes2 = safeWriteJsonSync(targetPath, { score: 20 }, {
      fs: mockFs,
      validate: (data) => data.score >= 10
    });
    assert.equal(writeRes2.ok, false);
    assert.equal(writeRes2.phase, 'post_verify');
    assert.match(writeRes2.error, /未通过业务规则/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('loadPricingLedger & recordModelCalls: 损坏文件隔离保护与拒绝空覆盖', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-ledger-corrupt-'));
  try {
    const ledgerPath = path.join(tempDir, 'pricing_ledger_v1.json');
    fs.writeFileSync(ledgerPath, '{ invalid json truncated content...', 'utf8');

    // 1. 读取损坏账本：标记损坏，不伪装成空账本
    const ledger = loadPricingLedger(tempDir);
    assert.equal(ledger.__corrupted, true);

    // 验证损坏文件已被隔离备份
    const files = fs.readdirSync(tempDir);
    const corruptBaks = files.filter(f => f.includes('.corrupt.'));
    assert.equal(corruptBaks.length, 1);

    // 2. 尝试向损坏账本写入：拒绝空覆盖
    const call = {
      callId: 'call-safety-1',
      modelId: 'gemini-2.5-flash',
      outputTokens: 100,
      totalTokens: 120,
      status: 'final'
    };
    const recRes = recordModelCalls([call], { agDir: tempDir });
    assert.equal(recRes.ok, false);
    assert.equal(recRes.changed, false);
    assert.match(recRes.error, /账本已损坏/);

    // 验证原损坏文件没有被清空覆盖
    assert.equal(fs.readFileSync(ledgerPath, 'utf8').startsWith('{ invalid json'), true);

    // 3. 当备份文件存在且完好时，验证能自动从备份恢复
    const bakPath = path.join(tempDir, 'pricing_ledger_v1.bak.json');
    const goodData = { version: '1.0.0', updatedAt: '', calls: { 'call-from-bak': { outputTokens: 50 } } };
    fs.writeFileSync(bakPath, JSON.stringify(goodData), 'utf8');

    const recoveredLedger = loadPricingLedger(tempDir);
    assert.equal(recoveredLedger.__corrupted, undefined);
    assert.equal(recoveredLedger.calls['call-from-bak']?.outputTokens, 50);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('recordModelCalls: 保存失败时内存缓存不被污染', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-cache-guard-'));
  try {
    // 将目标路径建为同名目录，使写入必定失败
    const ledgerPath = path.join(tempDir, 'pricing_ledger_v1.json');
    fs.mkdirSync(ledgerPath, { recursive: true });

    const call = {
      callId: 'call-cache-taint-1',
      modelId: 'gemini-2.5-flash',
      outputTokens: 50,
      status: 'final'
    };

    const recRes = recordModelCalls([call], { agDir: tempDir });
    assert.equal(recRes.ok, false);
    assert.equal(recRes.changed, false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('savePluginSettings: 主配置成功但派生归档失败时返回明确的部分成功状态', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-settings-partial-'));
  try {
    // 构造损坏的 v2 归档文件
    const archivePathV2 = path.join(tempDir, 'token_usage_archive_v2.json');
    fs.writeFileSync(archivePathV2, '{{bad json archive!!', 'utf8');

    const payload = {
      customPlan: {
        country: 'JP',
        subscriptionRegion: 'Japan',
        currency: 'JPY'
      }
    };

    const res = savePluginSettings(payload, { targetDir: tempDir });
    // 主设置成功，归档回写遇到损坏文件，产生明确的部分成功状态
    assert.equal(res.ok, true);
    assert.equal(res.partial, true);
    assert.match(res.warning, /派生归档同步失败/);
    assert.equal(res.archiveSynced, false);

    // 验证主设置文件确实成功落盘
    const settingsPath = path.join(tempDir, 'custom_plan_v1.json');
    assert.equal(fs.existsSync(settingsPath), true);
    const saved = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.equal(saved.accounts.default.country, 'JP');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('meter-proxy: 统一配置探测、禁用与优先级解析', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-proxy-test-'));
  try {
    // 1. 候选路径应为绝对路径
    const candidates = getProxyCandidatePaths();
    for (const cand of candidates) {
      assert.ok(path.isAbsolute(cand));
    }

    // 2. 模拟配置生效
    const cfgPath = path.join(tempDir, 'proxy.json');
    fs.writeFileSync(cfgPath, JSON.stringify({
      enabled: true,
      httpProxy: 'http://127.0.0.1:7890',
      allProxy: 'socks5://127.0.0.1:7890',
      noProxy: 'localhost,127.0.0.1'
    }), 'utf8');

    const detected = detectProxyConfig({ candidates: [cfgPath] });
    assert.equal(detected.enabled, true);
    assert.equal(detected.httpProxy, 'http://127.0.0.1:7890');
    assert.equal(detected.allProxy, 'socks5://127.0.0.1:7890');

    // 3. 注入目标环境变量（已有变量优先）
    const targetEnv = { HTTP_PROXY: 'http://existing-proxy:8080' };
    applyProxyEnvironment(targetEnv, { candidates: [cfgPath] });
    assert.equal(targetEnv.HTTP_PROXY, 'http://existing-proxy:8080'); // 保持原有
    assert.equal(targetEnv.HTTPS_PROXY, 'http://127.0.0.1:7890'); // 自动补齐缺少的
    assert.equal(targetEnv.ALL_PROXY, 'socks5://127.0.0.1:7890');

    // 4. enabled: false 明确禁用
    const disabledCfg = path.join(tempDir, 'disabled.json');
    fs.writeFileSync(disabledCfg, JSON.stringify({
      enabled: false,
      httpProxy: 'http://127.0.0.1:9999'
    }), 'utf8');
    const detectDisabled = detectProxyConfig({ candidates: [disabledCfg] });
    assert.equal(detectDisabled.enabled, false);

    const emptyEnv = {};
    applyProxyEnvironment(emptyEnv, { candidates: [disabledCfg] });
    assert.equal(emptyEnv.HTTP_PROXY, undefined);

    // 5. buildCliProxyEnv 剥离 Electron 变量与 Windows 色彩支持
    const cliEnv = buildCliProxyEnv({ ELECTRON_RUN_AS_NODE: '1', NO_COLOR: '1' }, { candidates: [cfgPath] });
    assert.equal(cliEnv.ELECTRON_RUN_AS_NODE, undefined);
    assert.equal(cliEnv.HTTPS_PROXY, 'http://127.0.0.1:7890');
    if (process.platform === 'win32') {
      assert.equal(cliEnv.NO_COLOR, undefined);
      assert.equal(cliEnv.TERM, 'xterm-256color');
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('savePluginSettings & getPluginSettings: panelLanguage 白名单校验、持久化且不干扰 contextPreferences', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-panel-lang-'));
  try {
    // 1. 默认老用户（无 panelLanguage）返回 zh-CN
    const init = getPluginSettings({ agDir: tempDir });
    assert.equal(init.panelLanguage, 'zh-CN');

    // 2. 先保存模型上下文偏好，再切换面板语言为 zh-TW 和 en
    const r1 = savePluginSettings({
      contextPreference: { modelId: 'product:google:gemini-3-1-pro', mode: 'fixed', limitTokens: 512000 }
    }, { agDir: tempDir });
    assert.equal(r1.ok, true);

    const r2 = savePluginSettings({ panelLanguage: 'zh-TW' }, { agDir: tempDir });
    assert.equal(r2.ok, true);
    const s2 = getPluginSettings({ agDir: tempDir });
    assert.equal(s2.panelLanguage, 'zh-TW');
    assert.equal(s2.contextPreferences['product:google:gemini-3-1-pro'].limitTokens, 512000);

    // 3. 非法语言代码回退/保留当前合法值，不写入脏值
    const r3 = savePluginSettings({ panelLanguage: 'fr-FR' }, { agDir: tempDir });
    assert.equal(r3.ok, true);
    const s3 = getPluginSettings({ agDir: tempDir });
    assert.equal(s3.panelLanguage, 'zh-TW');

    // 4. 切换为 en 并重新读取验证落盘
    const r4 = savePluginSettings({ uiPreferences: { panelLanguage: 'en' } }, { agDir: tempDir });
    assert.equal(r4.ok, true);
    const reloaded = getPluginSettings({ agDir: tempDir });
    assert.equal(reloaded.panelLanguage, 'en');
    assert.equal(reloaded.uiPreferences.panelLanguage, 'en');
    assert.equal(reloaded.contextPreferences['product:google:gemini-3-1-pro'].limitTokens, 512000);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});


test('recordModelCalls & loadPricingLedger: 显式 agDir 与默认 AG_DIR 交替写入绝不相互覆盖（A -> A+B -> A+B+C）', async () => {
  const { collectTokenHistoryAsync } = require('./meter-collector');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-ledger-interleave-'));
  const tempDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-ledger-isolated-'));
  const prevAgDir = process.env.AG_DIR;
  try {
    process.env.AG_DIR = tempDir;

    // 1. 实时 IPC 路径（不传 agDir，走默认 AG_DIR）写入记录 A
    const resA = recordModelCalls([{
      callId: 'call-live-A',
      source: 'desktop',
      cascadeId: '11111111-1111-1111-1111-111111111111',
      stepIndex: 2,
      model: 'Gemini 4 Carbon (High)',
      modelKey: 'gemini-4-carbon',
      inputTokens: 1000,
      cacheTokens: 0,
      outputTokens: 200,
      totalTokens: 1200,
      status: 'final',
      isPriced: true,
      costUSD: 0.004,
      date: '2026-11-12'
    }]);
    assert.equal(resA.ok, true);
    assert.equal(resA.changed, true);

    // 2. 扫描路径（显式传 { agDir: tempDir }）写入记录 B（同时测试 collectTokenHistoryAsync 落盘）
    const brainSessionDir = path.join(tempDir, 'brain', '22222222-2222-2222-2222-222222222222', '.system_generated', 'logs');
    fs.mkdirSync(brainSessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(brainSessionDir, 'transcript.jsonl'),
      JSON.stringify({
        step_index: 4,
        callId: 'call-scan-B',
        created_at: '2026-11-12T04:00:00Z',
        model: 'Gemini 3.8 Flash (High)',
        input_tokens: 2000,
        cache_read_tokens: 500,
        output_tokens: 300
      }) + '\n',
      'utf8'
    );
    await collectTokenHistoryAsync({
      agDir: tempDir,
      agCliDir: path.join(tempDir, 'cli-empty'),
      force: true,
      userStatus: { userTier: { name: 'Pro' }, planStatus: { availablePromptCredits: 500 } }
    });

    // 3. 再次走实时 IPC 路径（不传 agDir）写入记录 C，并校准记录 A 的 stepIndex 回填
    const resC = recordModelCalls([
      {
        callId: 'call-live-C',
        source: 'desktop',
        cascadeId: '11111111-1111-1111-1111-111111111111',
        stepIndex: 6,
        model: 'Claude Sonnet 5.5 (High)',
        modelKey: 'claude-sonnet-5-5',
        inputTokens: 1500,
        cacheTokens: 0,
        outputTokens: 250,
        totalTokens: 1750,
        status: 'final',
        isPriced: true,
        costUSD: 0.0055,
        date: '2026-11-12'
      }
    ]);
    assert.equal(resC.ok, true);
    assert.equal(resC.changed, true);

    const memLedger = loadPricingLedger();
    const diskLedger = JSON.parse(fs.readFileSync(path.join(tempDir, 'pricing_ledger_v1.json'), 'utf8'));
    for (const target of [memLedger, diskLedger]) {
      assert.ok(target.calls['call-live-A'], 'A 不得丢失');
      assert.ok(target.calls['call-scan-B'], 'B 绝不能被后续无参 recordModelCalls 覆盖丢失');
      assert.ok(target.calls['call-live-C'], 'C 必须成功追加');
    }

    // 4. 切换 AG_DIR 环境变量时，缓存按解析后绝对路径严格隔离
    process.env.AG_DIR = tempDir2;
    const isolatedLedger = loadPricingLedger();
    assert.deepEqual(isolatedLedger.calls, {});
  } finally {
    if (prevAgDir === undefined) delete process.env.AG_DIR;
    else process.env.AG_DIR = prevAgDir;
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(tempDir2, { recursive: true, force: true });
  }
});

test('[P1] loadPricingLedger & recordModelCalls: statSync EBUSY、readFileSync EACCES 及 stat 存在但读取返回 exists:false 时严禁空覆盖，保留 A+B 并在恢复后写入 A+B+C', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-ledger-read-guard-'));
  const ledgerPath = path.resolve(path.join(tempDir, 'pricing_ledger_v1.json'));
  const origStatSync = fs.statSync;
  const origReadFileSync = fs.readFileSync;

  const callA = {
    callId: 'call-guard-A',
    source: 'desktop',
    cascadeId: 'aaaaaaaa-1111-4444-8888-111111111111',
    stepIndex: 1,
    model: 'Gemini 4 Carbon (High)',
    modelKey: 'gemini-4-carbon',
    inputTokens: 1000,
    cacheTokens: 0,
    outputTokens: 200,
    totalTokens: 1200,
    status: 'final',
    isPriced: true,
    costUSD: 0.004,
    date: '2026-11-12'
  };
  const callB = {
    ...callA,
    callId: 'call-guard-B',
    stepIndex: 2,
    totalTokens: 1500,
    outputTokens: 500
  };
  const callC = {
    ...callA,
    callId: 'call-guard-C',
    stepIndex: 3,
    totalTokens: 1800,
    outputTokens: 800
  };

  try {
    // 0. 当账本文件真实不存在 (ENOENT) 时正常初始化并写入 A + B
    const seedRes = recordModelCalls([callA, callB], { agDir: tempDir });
    assert.equal(seedRes.ok, true);
    assert.equal(seedRes.changed, true);
    assert.deepEqual(Object.keys(JSON.parse(origReadFileSync(ledgerPath, 'utf8')).calls).sort(), ['call-guard-A', 'call-guard-B']);

    // 1. 注入一次 statSync 的 EBUSY：必须拒绝写入并返回失败，磁盘完整保留 A + B
    let statFaultActive = true;
    fs.statSync = function (p, ...rest) {
      if (statFaultActive && path.resolve(String(p)) === ledgerPath) {
        const err = new Error('EBUSY: resource busy or locked, stat');
        err.code = 'EBUSY';
        throw err;
      }
      return origStatSync.call(fs, p, ...rest);
    };
    const resStatBusy = recordModelCalls([callC], { agDir: tempDir });
    statFaultActive = false;
    fs.statSync = origStatSync;

    assert.equal(resStatBusy.ok, false);
    assert.equal(resStatBusy.changed, false);
    assert.equal(resStatBusy.phase, 'unreadable_guard');
    assert.equal(resStatBusy.code, 'EBUSY');
    assert.deepEqual(
      Object.keys(JSON.parse(origReadFileSync(ledgerPath, 'utf8')).calls).sort(),
      ['call-guard-A', 'call-guard-B'],
      'statSync EBUSY 后磁盘必须完整保留 A+B，绝不能被 C 覆盖'
    );

    // 2. 注入一次 readFileSync 的 EACCES（上面已失效缓存，本次必走磁盘读取）：必须拒绝写入，磁盘保留 A + B
    let readFaultActive = true;
    fs.readFileSync = function (p, ...rest) {
      if (readFaultActive && path.resolve(String(p)) === ledgerPath) {
        const err = new Error('EACCES: permission denied, open');
        err.code = 'EACCES';
        throw err;
      }
      return origReadFileSync.call(fs, p, ...rest);
    };
    const resReadDenied = recordModelCalls([callC], { agDir: tempDir });
    readFaultActive = false;
    fs.readFileSync = origReadFileSync;

    assert.equal(resReadDenied.ok, false);
    assert.equal(resReadDenied.changed, false);
    assert.equal(resReadDenied.phase, 'unreadable_guard');
    assert.equal(resReadDenied.code, 'EACCES');
    assert.deepEqual(
      Object.keys(JSON.parse(origReadFileSync(ledgerPath, 'utf8')).calls).sort(),
      ['call-guard-A', 'call-guard-B'],
      'readFileSync EACCES 后磁盘必须完整保留 A+B，绝不能被 C 覆盖'
    );

    // 3. statSync 已确认文件存在，但后续读取阶段返回 exists: false（如瞬态竞争或外部拦截）：同样必须阻断写入
    let statCallCount = 0;
    const inconsistentFs = {
      ...fs,
      statSync(p, ...rest) {
        if (path.resolve(String(p)) === ledgerPath) {
          statCallCount++;
          if (statCallCount >= 2) {
            const enoent = new Error('ENOENT: simulated transient disappearance');
            enoent.code = 'ENOENT';
            throw enoent;
          }
        }
        return origStatSync.call(fs, p, ...rest);
      }
    };
    const resExistsMismatch = recordModelCalls([callC], { agDir: tempDir, fs: inconsistentFs });
    assert.equal(resExistsMismatch.ok, false);
    assert.equal(resExistsMismatch.changed, false);
    assert.equal(resExistsMismatch.phase, 'unreadable_guard');
    assert.equal(resExistsMismatch.code, 'ENOENT');
    assert.deepEqual(
      Object.keys(JSON.parse(origReadFileSync(ledgerPath, 'utf8')).calls).sort(),
      ['call-guard-A', 'call-guard-B'],
      'stat 存在但后续读取返回 exists:false 时必须阻断写入保留 A+B'
    );

    // 3b. renameSync 阶段出现 EPERM 锁冲突时，同样向上层完整透传 code: 'EPERM' 且保留原文件
    const renameBusyFs = {
      ...fs,
      renameSync() {
        const err = new Error('EPERM: operation not permitted, rename');
        err.code = 'EPERM';
        throw err;
      }
    };
    const resRenamePerm = recordModelCalls([callC], { agDir: tempDir, fs: renameBusyFs });
    assert.equal(resRenamePerm.ok, false);
    assert.equal(resRenamePerm.changed, false);
    assert.equal(resRenamePerm.phase, 'rename');
    assert.equal(resRenamePerm.code, 'EPERM');

    // 3c. pre_verify 临时文件读回校验出现 EACCES 锁冲突时，同样完整透传 phase: 'pre_verify' 与 code: 'EACCES' 且保留原文件
    const preVerifyDeniedFs = {
      ...fs,
      readFileSync(p, ...rest) {
        if (String(p).endsWith('.tmp')) {
          const err = new Error('EACCES: permission denied, open tmp');
          err.code = 'EACCES';
          throw err;
        }
        return origReadFileSync.call(fs, p, ...rest);
      }
    };
    const resPreVerifyErr = recordModelCalls([callC], { agDir: tempDir, fs: preVerifyDeniedFs });
    assert.equal(resPreVerifyErr.ok, false);
    assert.equal(resPreVerifyErr.changed, false);
    assert.equal(resPreVerifyErr.phase, 'pre_verify');
    assert.equal(resPreVerifyErr.code, 'EACCES');
    assert.deepEqual(
      Object.keys(JSON.parse(origReadFileSync(ledgerPath, 'utf8')).calls).sort(),
      ['call-guard-A', 'call-guard-B'],
      'pre_verify 读回失败时必须保留原账本 A+B'
    );

    // 4. 故障解除后重试写入 C：成功读取既有 A + B 并合并落盘得到 A + B + C
    const resRetryOk = recordModelCalls([callC], { agDir: tempDir });
    assert.equal(resRetryOk.ok, true);
    assert.equal(resRetryOk.changed, true);

    const finalDisk = JSON.parse(origReadFileSync(ledgerPath, 'utf8'));
    const finalMem = loadPricingLedger(tempDir);
    for (const target of [finalDisk, finalMem]) {
      assert.deepEqual(Object.keys(target.calls).sort(), ['call-guard-A', 'call-guard-B', 'call-guard-C']);
    }
  } finally {
    fs.statSync = origStatSync;
    fs.readFileSync = origReadFileSync;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('loadPricingLedger: 读取前后 statSync (mtimeMs / size) 发生变化时拒绝写入陈旧缓存，下次读取自动加载新内容', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-ledger-stat-race-'));
  const ledgerPath = path.resolve(path.join(tempDir, 'pricing_ledger_v1.json'));
  const origReadFileSync = fs.readFileSync;
  try {
    const v1 = {
      version: '1.0.0',
      updatedAt: '2026-11-12T00:00:00Z',
      calls: { 'call-v1': { callId: 'call-v1', totalTokens: 100, status: 'final' } }
    };
    const v2 = {
      version: '1.0.0',
      updatedAt: '2026-11-12T00:00:05Z',
      calls: {
        'call-v1': { callId: 'call-v1', totalTokens: 100, status: 'final' },
        'call-v2-concurrent': { callId: 'call-v2-concurrent', totalTokens: 999, status: 'final' }
      }
    };
    fs.writeFileSync(ledgerPath, JSON.stringify(v1, null, 2) + '\n', 'utf8');

    // 模拟在 readFileSync 刚读出旧内容 v1 后、post-read statSync 执行前，外部进程并发原子更新了账本为 v2
    let injectedConcurrentWrite = false;
    fs.readFileSync = function (p, ...rest) {
      const content = origReadFileSync.call(fs, p, ...rest);
      if (!injectedConcurrentWrite && path.resolve(String(p)) === ledgerPath) {
        injectedConcurrentWrite = true;
        fs.writeFileSync(ledgerPath, JSON.stringify(v2, null, 2) + '\n', 'utf8');
      }
      return content;
    };

    const firstRead = loadPricingLedger(tempDir);
    fs.readFileSync = origReadFileSync;
    assert.equal(Boolean(firstRead.calls['call-v1']), true);
    assert.equal(Boolean(firstRead.calls['call-v2-concurrent']), false);

    // 若旧实现直接用 stAfter 缓存了 firstRead，则此处会命中 v2 的 (mtimeMs, size) 却永久返回缺失 call-v2-concurrent 的陈旧数据
    const secondRead = loadPricingLedger(tempDir);
    assert.equal(Boolean(secondRead.calls['call-v2-concurrent']), true, '读取前后 stat 不一致时不得缓存旧快照');
    assert.equal(secondRead.calls['call-v2-concurrent'].totalTokens, 999);
  } finally {
    fs.readFileSync = origReadFileSync;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('meter-proxy & modules-config: modules.json 优先于遗留 proxy.json，关闭与改端口不被旧配置覆盖', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-proxy-prio-'));
  const prevLocalApp = process.env.LOCALAPPDATA;
  const prevXdgState = process.env.XDG_STATE_HOME;
  const prevMeterState = process.env.AG_METER_STATE_DIR;
  try {
    const stateRoot = path.join(tempDir, 'AntigravityContextMeter');
    fs.mkdirSync(stateRoot, { recursive: true });
    process.env.AG_METER_STATE_DIR = stateRoot;
    if (process.platform === 'win32') process.env.LOCALAPPDATA = tempDir;
    else process.env.XDG_STATE_HOME = tempDir;

    // 同时存在历史遗留 proxy.json（启用 7897）与新统一 modules.json（关闭，端口 17890）
    fs.writeFileSync(path.join(stateRoot, 'proxy.json'), JSON.stringify({
      enabled: true,
      httpProxy: 'http://127.0.0.1:7897',
      allProxy: 'socks5://127.0.0.1:7897'
    }), 'utf8');
    fs.writeFileSync(path.join(stateRoot, 'modules.json'), JSON.stringify({
      schemaVersion: 1,
      modules: {
        proxy: {
          enabled: false,
          proxyUrl: 'http://127.0.0.1:17890',
          bypassList: 'localhost,127.0.0.1'
        }
      }
    }), 'utf8');

    const cands = getProxyCandidatePaths();
    assert.equal(path.basename(cands[0]), 'modules.json', 'modules.json 必须排在历史 proxy.json 之前');
    const detected = detectProxyConfig();
    assert.equal(detected.enabled, false, '禁用状态不得被旧 proxy.json 的 enabled:true 覆盖');
    assert.equal(detected.detected, true);
    assert.equal(path.resolve(detected.configPath), path.resolve(path.join(stateRoot, 'modules.json')));

    // 重新开启 modules.json 代理，env 注入应读取新端口 17890 而非 7897
    const cfg = JSON.parse(fs.readFileSync(path.join(stateRoot, 'modules.json'), 'utf8'));
    cfg.modules.proxy.enabled = true;
    fs.writeFileSync(path.join(stateRoot, 'modules.json'), JSON.stringify(cfg, null, 2), 'utf8');
    const targetEnv = {};
    applyProxyEnvironment(targetEnv);
    assert.equal(targetEnv.HTTPS_PROXY, 'http://127.0.0.1:17890');
    assert.equal(targetEnv.ALL_PROXY, 'http://127.0.0.1:17890');
  } finally {
    if (prevMeterState === undefined) delete process.env.AG_METER_STATE_DIR; else process.env.AG_METER_STATE_DIR = prevMeterState;
    if (prevLocalApp === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = prevLocalApp;
    if (prevXdgState === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = prevXdgState;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('testProxyHealth: 协议/端口边界校验与 HTTP/SOCKS5 分层连通性探测（modelCallVerified 绝不虚报）', async () => {
  const http = require('http');
  const net = require('net');
  const { testProxyHealth } = require('./modules-config');

  // 1. 非法协议与空地址校验
  const badEmpty = await testProxyHealth('');
  assert.equal(badEmpty.configValid, false);
  const badProto = await testProxyHealth('ftp://127.0.0.1:7897');
  assert.equal(badProto.configValid, false);
  const badPort = await testProxyHealth('http://127.0.0.1:99999');
  assert.equal(badPort.configValid, false);

  // 2. HTTP 代理端口可达 + 外网通 vs 端口可达但外网不通
  const httpProxy = http.createServer((req, res) => {
    res.writeHead(req.url.includes('generate_204') ? 204 : 502);
    res.end();
  });
  httpProxy.on('connect', (_req, socket) => {
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    socket.end();
  });
  await new Promise((r) => httpProxy.listen(0, '127.0.0.1', r));

  const deadOnlineProxy = http.createServer((_req, res) => {
    res.writeHead(502);
    res.end();
  });
  deadOnlineProxy.on('connect', (_req, socket) => {
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    socket.end();
  });
  await new Promise((r) => deadOnlineProxy.listen(0, '127.0.0.1', r));

  // 3. 本地 SOCKS5 模拟服务器（greeting + CONNECT + generate_204）
  const socksProxy = net.createServer((sock) => {
    let stage = 0;
    sock.on('data', () => {
      if (stage === 0) {
        stage = 1;
        sock.write(Buffer.from([0x05, 0x00]));
      } else if (stage === 1) {
        stage = 2;
        sock.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 80]));
      } else if (stage === 2) {
        stage = 3;
        sock.write('HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n');
        sock.end();
      }
    });
  });
  await new Promise((r) => socksProxy.listen(0, '127.0.0.1', r));

  try {
    const httpPort = httpProxy.address().port;
    const rHttp = await testProxyHealth(`http://127.0.0.1:${httpPort}`);
    assert.equal(rHttp.configValid, true);
    assert.equal(rHttp.proxyReachable, true);
    assert.equal(rHttp.internetReachable, true);
    assert.equal(rHttp.modelCallVerified, false);

    const deadPort = deadOnlineProxy.address().port;
    const rDeadNet = await testProxyHealth(`http://127.0.0.1:${deadPort}`);
    assert.equal(rDeadNet.configValid, true);
    assert.equal(rDeadNet.proxyReachable, true);
    assert.equal(rDeadNet.internetReachable, false);
    assert.equal(rDeadNet.modelCallVerified, false);

    const socksPort = socksProxy.address().port;
    const rSocks = await testProxyHealth(`socks5://127.0.0.1:${socksPort}`);
    assert.equal(rSocks.configValid, true);
    assert.equal(rSocks.proxyReachable, true);
    assert.equal(rSocks.internetReachable, true);
    assert.equal(rSocks.modelCallVerified, false);
  } finally {
    await Promise.all([
      new Promise((r) => httpProxy.close(r)),
      new Promise((r) => deadOnlineProxy.close(r)),
      new Promise((r) => socksProxy.close(r))
    ]);
  }
});

test('meter-main.js 模块 IPC: 跨平台提示无 install.bat、代理校验与品牌热更 restartRequired 区分', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-ipc-mod-'));
  const prevLocalApp = process.env.LOCALAPPDATA;
  const prevXdgState = process.env.XDG_STATE_HOME;
  const prevMeterState = process.env.AG_METER_STATE_DIR;
  const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  try {
    process.env.AG_METER_STATE_DIR = path.join(tempDir, 'AntigravityContextMeter');
    if (process.platform === 'win32') process.env.LOCALAPPDATA = tempDir;
    else process.env.XDG_STATE_HOME = tempDir;

    const handlers = {};
    const mockIpc = { handle: (ch, fn) => { handlers[ch] = fn; } };
    const { registerMeterIpcHandlers } = require('./meter-main');
    registerMeterIpcHandlers(mockIpc, {});
    const localFrame = { url: 'https://127.0.0.1:5173/' };
    const localEv = { senderFrame: localFrame, sender: { mainFrame: localFrame } };

    // 1. 在 macOS 下请求开启未注入组件时，不得出现 install.bat 字样
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    const fakeUninjectedAsar = path.join(tempDir, 'empty.asar');
    const modResMac = await handlers['context-meter:toggle-module'](localEv, 'proxy', true, { asarPath: fakeUninjectedAsar });
    assert.equal(modResMac.ok, false);
    assert.equal(modResMac.status, 'install_failed');
    assert.doesNotMatch(modResMac.error, /install\.bat/);
    assert.match(modResMac.error, /node cli\.js proxy:enable/);

    // 2. status 返回包含 runtime 元数据
    const statusRes = await handlers['context-meter:modules-status'](localEv, fakeUninjectedAsar);
    assert.equal(statusRes.ok, true);
    assert.equal(typeof statusRes.runtime, 'object');
    assert.equal(typeof statusRes.runtime.proxyActive, 'boolean');
    assert.equal(typeof statusRes.runtime.proxyNeedsRestart, 'boolean');
  } finally {
    if (origPlatform) Object.defineProperty(process, 'platform', origPlatform);
    if (prevMeterState === undefined) delete process.env.AG_METER_STATE_DIR; else process.env.AG_METER_STATE_DIR = prevMeterState;
    if (prevLocalApp === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = prevLocalApp;
    if (prevXdgState === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = prevXdgState;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('Issue #51: 锁文件残留/空锁/跨进程竞争下事件循环阻塞 < 100ms 且支持超时与过期回收', async () => {
  const { spawn } = require('child_process');
  const { withFileLockAsync, parseLockFileMetadata } = require('./meter-storage');
  const { recordModelCallsLockedAsync, repairAndMigrateAccountLedgerAsync } = require('./meter-collector');

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-issue51-lock-'));
  const targetPath = path.join(tempDir, 'pricing_ledger_v1.json');
  const lockPath = `${targetPath}.lock`;
  fs.writeFileSync(targetPath, JSON.stringify({ version: 1, calls: {} }), 'utf8');

  async function measureEventLoopMaxLag(fn) {
    let maxLagMs = 0;
    let lastTick = Date.now();
    const timer = setInterval(() => {
      const now = Date.now();
      const lag = Math.max(0, now - lastTick - 10);
      if (lag > maxLagMs) maxLagMs = lag;
      lastTick = now;
    }, 10);
    const immStart = Date.now();
    let immLagMs = 0;
    setImmediate(() => {
      immLagMs = Date.now() - immStart;
    });
    try {
      const res = await fn();
      return { res, maxLagMs: Math.max(maxLagMs, immLagMs) };
    } finally {
      clearInterval(timer);
    }
  }

  try {
    // 1. 锁文件残留（不存在的 PID 999999）
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, createdAtMs: Date.now() - 5000, nonce: 'dead' }), 'utf8');
    const rDead = await measureEventLoopMaxLag(() =>
      withFileLockAsync(targetPath, async () => 'ok-dead', { timeoutMs: 2000 })
    );
    assert.equal(rDead.res, 'ok-dead');
    assert.ok(rDead.maxLagMs < 100, `死锁残留回收期间事件循环阻塞应 < 100ms，实际 ${rDead.maxLagMs}ms`);
    assert.equal(fs.existsSync(lockPath), false);

    // 2. 锁文件为空（0 字节残留空锁，曾导致 15s 卡死）
    fs.writeFileSync(lockPath, '', 'utf8');
    const rEmpty = await measureEventLoopMaxLag(() =>
      withFileLockAsync(targetPath, async () => 'ok-empty', { timeoutMs: 2000, emptyGraceMs: 40 })
    );
    assert.equal(rEmpty.res, 'ok-empty');
    assert.ok(rEmpty.maxLagMs < 100, `空锁回收期间事件循环阻塞应 < 100ms，实际 ${rEmpty.maxLagMs}ms`);
    assert.equal(fs.existsSync(lockPath), false);

    // 3. 跨进程竞争（真实子进程持有锁 ~220ms 后释放，主进程异步等锁不得阻塞事件循环）
    const holderReadyFile = path.join(tempDir, 'holder.ready');
    const childCode = `
      const fs = require('fs');
      const { withFileLockSync } = require(${JSON.stringify(path.join(__dirname, 'meter-storage.js'))});
      withFileLockSync(${JSON.stringify(targetPath)}, () => {
        fs.writeFileSync(${JSON.stringify(holderReadyFile)}, '1', 'utf8');
        const end = Date.now() + 220;
        while (Date.now() < end) {}
      }, { timeoutMs: 5000 });
    `;
    const child = spawn(process.execPath, ['-e', childCode], { stdio: 'ignore' });
    const waitStart = Date.now();
    while (!fs.existsSync(holderReadyFile)) {
      if (Date.now() - waitStart > 4000) break;
      await new Promise(r => setTimeout(r, 10));
    }
    const rContend = await measureEventLoopMaxLag(() =>
      withFileLockAsync(targetPath, async () => {
        const meta = parseLockFileMetadata(fs.readFileSync(lockPath, 'utf8'));
        assert.equal(meta.validOwner, true);
        assert.equal(meta.pid, process.pid);
        return 'ok-contend';
      }, { timeoutMs: 5000, staleMs: 10000 })
    );
    if (child.exitCode === null) {
      await Promise.race([
        new Promise(resolve => child.once('exit', resolve)),
        new Promise(resolve => setTimeout(resolve, 3000))
      ]);
    }
    assert.equal(rContend.res, 'ok-contend');
    assert.ok(rContend.maxLagMs < 100, `跨进程等锁期间事件循环阻塞应 < 100ms，实际 ${rContend.maxLagMs}ms`);

    // 4. 过期回收（即使持锁 PID 是当前存活进程，超过 staleMs 也应回收）+ 超时报错
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, createdAtMs: Date.now() - 1000, nonce: 'expired' }), 'utf8');
    const rStale = await withFileLockAsync(targetPath, async () => 'ok-stale', { timeoutMs: 1000, staleMs: 200 });
    assert.equal(rStale, 'ok-stale');

    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, createdAtMs: Date.now(), nonce: 'active' }), 'utf8');
    await assert.rejects(
      withFileLockAsync(targetPath, async () => 'never', { timeoutMs: 120, staleMs: 30000 }),
      /获取文件写锁超时/
    );
    fs.unlinkSync(lockPath);

    // 5. 主进程异步账本写入与纠偏 API 在空锁存在时同样 < 100ms 阻塞并正常落盘
    fs.writeFileSync(lockPath, '', 'utf8');
    const recRes = await measureEventLoopMaxLag(() =>
      recordModelCallsLockedAsync([{
        callId: 'call_issue51_async_1',
        source: 'desktop',
        model: 'gemini-4-hydrogen',
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
        date: '2026-11-19',
        allowSynthetic: true
      }], { ledgerPath: targetPath, allowSynthetic: true, lockOptions: { timeoutMs: 2000, emptyGraceMs: 40 } })
    );
    assert.equal(recRes.res.ok, true);
    assert.equal(recRes.res.changed, true);
    assert.ok(recRes.maxLagMs < 100);

    const repRes = await repairAndMigrateAccountLedgerAsync({ ledgerPath: targetPath, lockOptions: { timeoutMs: 2000 } });
    assert.equal(repRes.ok, true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
