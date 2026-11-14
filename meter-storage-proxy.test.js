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
