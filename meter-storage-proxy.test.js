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
