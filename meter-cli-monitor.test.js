'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Writable } = require('node:stream');

const collector = require('./meter-collector');
const launcher = require('./meter-cli-launcher');
const cliMonitor = require('./meter-cli-monitor');
const { registerMeterIpcHandlers } = require('./meter-main');

test('ELV-58: node cli.js usage 口径与面板 collectTokenHistoryAsync 严格对账且严格只读', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-elv58-usage-'));
  const agDir = path.join(tmpDir, 'ag');
  const cliDir = path.join(tmpDir, 'cli');
  const stateDir = path.join(tmpDir, 'state');
  fs.mkdirSync(agDir, { recursive: true });
  fs.mkdirSync(cliDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });

  try {
    const now = new Date();
    const tToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 1, 0);
    const tYesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 12, 0, 0);
    const tOldMonth = new Date(now.getFullYear(), now.getMonth() - 2, 10, 12, 0, 0);
    const todayKey = collector.formatLocalDateKey(tToday);
    const yesterdayKey = collector.formatLocalDateKey(tYesterday);
    const oldMonthKey = collector.formatLocalDateKey(tOldMonth);

    const scopeA = collector.buildAccountScopeKey('alice@example.com');
    const scopeB = collector.buildAccountScopeKey('bob@example.com');
    fs.writeFileSync(path.join(stateDir, 'accounts_v1.json'), JSON.stringify({
      version: 1,
      accounts: {
        [scopeA]: { accountScopeKey: scopeA, email: 'alice@example.com' },
        [scopeB]: { accountScopeKey: scopeB, email: 'bob@example.com' }
      }
    }));

    // 写入与账本 1:1 对齐的桌面与 CLI transcript.jsonl
    const deskBrain1 = path.join(agDir, 'brain', '11111111-1111-4111-8111-111111111111', '.system_generated', 'logs');
    const deskBrain2 = path.join(agDir, 'brain', '33333333-3333-4333-8333-333333333333', '.system_generated', 'logs');
    const cliBrain1 = path.join(cliDir, 'brain', '22222222-2222-4222-8222-222222222222', '.system_generated', 'logs');
    fs.mkdirSync(deskBrain1, { recursive: true });
    fs.mkdirSync(deskBrain2, { recursive: true });
    fs.mkdirSync(cliBrain1, { recursive: true });

    fs.writeFileSync(path.join(deskBrain1, 'transcript.jsonl'), JSON.stringify({
      created_at: tToday.toISOString(),
      step_index: 1,
      responseId: 'c_today_desk',
      model: 'gemini-4-hydrogen',
      chatModel: { modelDisplayName: 'Gemini 4 Hydrogen' },
      input_tokens: 1000,
      cache_read_tokens: 2000,
      output_tokens: 300
    }) + '\n');
    fs.writeFileSync(path.join(cliBrain1, 'transcript.jsonl'), JSON.stringify({
      created_at: tYesterday.toISOString(),
      step_index: 1,
      responseId: 'c_yest_cli',
      model: 'claude-opus-5-5',
      chatModel: { modelDisplayName: 'Claude Opus 5.5' },
      input_tokens: 400,
      cache_read_tokens: 100,
      output_tokens: 150
    }) + '\n');
    fs.writeFileSync(path.join(deskBrain2, 'transcript.jsonl'), JSON.stringify({
      created_at: tOldMonth.toISOString(),
      step_index: 1,
      responseId: 'c_old_unattr',
      model: 'gemini-4-hydrogen',
      chatModel: { modelDisplayName: 'Gemini 4 Hydrogen' },
      input_tokens: 5000,
      cache_read_tokens: 0,
      output_tokens: 1000
    }) + '\n');

    const calls = {
      c_today_desk: {
        callId: 'c_today_desk',
        cascadeId: '11111111-1111-4111-8111-111111111111',
        stepIndex: 1,
        source: 'desktop',
        model: 'gemini-4-hydrogen',
        modelLabel: 'Gemini 4 Hydrogen',
        inputTokens: 1000,
        cacheReadTokens: 2000,
        outputTokens: 300,
        totalTokens: 3300,
        date: todayKey,
        created_at: tToday.toISOString(),
        accountScopeKey: scopeA,
        accountAttributionConfidence: 'explicit_account_email',
        attributionRepairVersion: 'elv89-v3'
      },
      c_yest_cli: {
        callId: 'c_yest_cli',
        cascadeId: '22222222-2222-4222-8222-222222222222',
        stepIndex: 1,
        source: 'cli',
        model: 'claude-opus-5-5',
        modelLabel: 'Claude Opus 5.5',
        inputTokens: 400,
        cacheReadTokens: 100,
        outputTokens: 150,
        totalTokens: 650,
        date: yesterdayKey,
        created_at: tYesterday.toISOString(),
        accountScopeKey: scopeB,
        accountAttributionConfidence: 'explicit_account_email',
        attributionRepairVersion: 'elv89-v3'
      },
      c_old_unattr: {
        callId: 'c_old_unattr',
        cascadeId: '33333333-3333-4333-8333-333333333333',
        stepIndex: 1,
        source: 'desktop',
        model: 'gemini-4-hydrogen',
        modelLabel: 'Gemini 4 Hydrogen',
        inputTokens: 5000,
        cacheReadTokens: 0,
        outputTokens: 1000,
        totalTokens: 6000,
        date: oldMonthKey,
        created_at: tOldMonth.toISOString(),
        accountAttributionConfidence: 'unattributed',
        unattributedReason: 'before_account_tracking',
        attributionRepairVersion: 'elv89-v3'
      }
    };
    const ledgerPath = path.join(agDir, 'pricing_ledger_v1.json');
    fs.writeFileSync(ledgerPath, JSON.stringify({ version: 1, calls }, null, 2));
    const ledgerBefore = fs.readFileSync(ledgerPath, 'utf8');

    // 1. 取面板同源 collectTokenHistoryAsync 数值
    const panelHistory = await collector.collectTokenHistoryAsync({
      agDir,
      agCliDir: cliDir,
      stateDir,
      wslRoots: [],
      force: true,
      readOnly: true
    });

    // 2. CLI queryCliUsage 在 --all / --today / --week / --month / --account / --model 下严格对账
    const allRes = await cliMonitor.queryCliUsage({ period: 'all', agDir, agCliDir: cliDir, stateDir, wslRoots: [], now });
    assert.equal(allRes.ok, true);
    assert.equal(allRes.totals.totalTokens, panelHistory.summary.grandTotalTokens);
    assert.equal(allRes.totals.inputTokens, panelHistory.summary.totalInputTokens);
    assert.equal(allRes.totals.cacheTokens, panelHistory.summary.totalCacheTokens);
    assert.equal(allRes.totals.outputTokens, panelHistory.summary.totalOutputTokens);
    assert.equal(allRes.totals.steps, panelHistory.summary.totalSteps);

    const todayRes = await cliMonitor.queryCliUsage({ period: 'today', agDir, agCliDir: cliDir, stateDir, wslRoots: [], now });
    assert.equal(todayRes.totals.totalTokens, panelHistory.summary.todayTokens);
    assert.equal(todayRes.totals.totalTokens, 3300);

    const weekRes = await cliMonitor.queryCliUsage({ period: 'week', agDir, agCliDir: cliDir, stateDir, wslRoots: [], now });
    assert.equal(weekRes.totals.totalTokens, 3300 + 650);

    const monthRes = await cliMonitor.queryCliUsage({ period: 'month', agDir, agCliDir: cliDir, stateDir, wslRoots: [], now });
    assert.equal(monthRes.totals.totalTokens, panelHistory.summary.monthTokens);

    const aliceRes = await cliMonitor.queryCliUsage({ period: 'all', account: 'alice@example.com', agDir, agCliDir: cliDir, stateDir, wslRoots: [], now });
    assert.equal(aliceRes.totals.totalTokens, panelHistory.usageByAccount[scopeA].totalTokens);
    assert.equal(aliceRes.totals.totalTokens, 3300);

    const unattrRes = await cliMonitor.queryCliUsage({ period: 'all', account: 'unattributed', agDir, agCliDir: cliDir, stateDir, wslRoots: [], now });
    assert.equal(unattrRes.totals.totalTokens, panelHistory.unattributedUsage.totalTokens);
    assert.equal(unattrRes.totals.totalTokens, 6000);

    const modelRes = await cliMonitor.queryCliUsage({ period: 'all', model: 'opus', agDir, agCliDir: cliDir, stateDir, wslRoots: [], now });
    assert.equal(modelRes.totals.totalTokens, 650);

    // 3. 验证只读：账本字节零改动、无 .bak 生成、无 archive v2 生成
    assert.equal(fs.readFileSync(ledgerPath, 'utf8'), ledgerBefore);
    assert.equal(fs.readdirSync(agDir).filter(f => f.includes('.bak') || f.includes('archive')).length, 0);

    // 4. 真实子进程运行 node cli.js usage --json 验证 CLI 入口解析与 JSON 输出
    const proc = spawnSync(process.execPath, [
      path.join(__dirname, 'cli.js'), 'usage', '--all', '--json',
      '--ag-dir', agDir, '--cli-dir', cliDir, '--state-dir', stateDir
    ], { encoding: 'utf8', env: { ...process.env, AG_METER_TEST_MODE: '1' } });
    assert.equal(proc.status, 0, proc.stderr);
    const parsed = JSON.parse(proc.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.totals.totalTokens, 9950);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('ELV-59 & CLI 上下文隔离: 多 CLI 并发会话区分、按模型自定义上下文立即保存/重启生效边界与监视器常驻退出', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-elv59-mon-'));
  const agDir = path.join(tmpDir, 'ag');
  const cliDir = path.join(tmpDir, 'cli');
  const stateDir = path.join(tmpDir, 'state');
  const projA = path.join(tmpDir, 'projA');
  const projB = path.join(tmpDir, 'projB');
  fs.mkdirSync(agDir, { recursive: true });
  fs.mkdirSync(path.join(cliDir, 'brain', 'aaaaaaaa-0000-0000-0000-000000000001', '.system_generated', 'logs'), { recursive: true });
  fs.mkdirSync(path.join(cliDir, 'brain', 'bbbbbbbb-0000-0000-0000-000000000002', '.system_generated', 'logs'), { recursive: true });
  fs.mkdirSync(path.join(cliDir, 'presence'), { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(projA, { recursive: true });
  fs.mkdirSync(projB, { recursive: true });

  try {
    // 1. 立即保存两个不同模型的自定义上下文偏好（模型 A=512000，模型 B=300000）
    const saveA = cliMonitor.saveCliModelContextPreference({
      model: 'gemini-4-hydrogen',
      mode: 'fixed',
      limitTokens: 512000,
      stateDir,
      agCliDir: cliDir
    });
    assert.equal(saveA.ok, true);
    assert.equal(saveA.savedImmediately, true);
    assert.equal(saveA.effectiveTiming.cliProcess, 'after_restart');
    assert.equal(saveA.effectiveTiming.desktopRenderer, 'next_request');

    const saveB = cliMonitor.saveCliModelContextPreference({
      model: 'claude-opus-5-5',
      mode: 'fixed',
      limitTokens: 300000,
      stateDir,
      agCliDir: cliDir
    });
    assert.equal(saveB.ok, true);
    assert.equal(saveB.savedImmediately, true);

    // 验证立即读取各自模型偏好，且同步写入后两个模型互不覆盖
    const budgetA = cliMonitor.resolveCliModelContextBudget('gemini-4-hydrogen', { stateDir, agCliDir: cliDir });
    const budgetB = cliMonitor.resolveCliModelContextBudget('claude-opus-5-5', { stateDir, agCliDir: cliDir });
    assert.equal(budgetA.limitTokens, 512000);
    assert.equal(budgetB.limitTokens, 300000);

    // 2. 构建两个并发 CLI 会话，确认会话 A 与会话 B 在监视器中完全隔离且不串上限/用量
    const tA = path.join(cliDir, 'brain', 'aaaaaaaa-0000-0000-0000-000000000001', '.system_generated', 'logs', 'transcript.jsonl');
    const tB = path.join(cliDir, 'brain', 'bbbbbbbb-0000-0000-0000-000000000002', '.system_generated', 'logs', 'transcript.jsonl');
    fs.writeFileSync(tA, JSON.stringify({ step_index: 0, content: `Command Working Directory: ${projA}` }) + '\n');
    fs.writeFileSync(tB, JSON.stringify({ step_index: 0, content: `Command Working Directory: ${projB}` }) + '\n');
    const nowMs = Date.now();
    const lockA = path.join(cliDir, 'presence', 'aaaaaaaa-0000-0000-0000-000000000001.lock');
    const lockB = path.join(cliDir, 'presence', 'bbbbbbbb-0000-0000-0000-000000000002.lock');
    fs.writeFileSync(lockA, '');
    fs.writeFileSync(lockB, '');
    fs.utimesSync(tA, new Date(nowMs - 5000), new Date(nowMs - 5000));
    fs.utimesSync(lockA, new Date(nowMs - 5000), new Date(nowMs - 5000));
    fs.utimesSync(tB, new Date(nowMs - 2000), new Date(nowMs - 2000));
    fs.utimesSync(lockB, new Date(nowMs - 2000), new Date(nowMs - 2000));
    fs.writeFileSync(path.join(agDir, 'pricing_ledger_v1.json'), JSON.stringify({
      version: 1,
      calls: {
        cli_a_1: {
          callId: 'cli_a_1',
          cascadeId: 'aaaaaaaa-0000-0000-0000-000000000001',
          source: 'cli',
          model: 'gemini-4-hydrogen',
          modelLabel: 'Gemini 4 Hydrogen',
          inputTokens: 120000,
          cacheReadTokens: 80000,
          outputTokens: 5000,
          totalTokens: 205000,
          timestamp: nowMs - 5000,
          date: collector.formatLocalDateKey(new Date(nowMs))
        },
        cli_b_1: {
          callId: 'cli_b_1',
          cascadeId: 'bbbbbbbb-0000-0000-0000-000000000002',
          source: 'cli',
          model: 'claude-opus-5-5',
          modelLabel: 'Claude Opus 5.5',
          inputTokens: 45000,
          cacheReadTokens: 15000,
          outputTokens: 3000,
          totalTokens: 63000,
          timestamp: nowMs - 2000,
          date: collector.formatLocalDateKey(new Date(nowMs))
        }
      }
    }));

    const scanAll = cliMonitor.scanCliSessions({ agDir, agCliDir: cliDir, stateDir, nowMs });
    assert.equal(scanAll.sessionCount, 2);
    const sessB = scanAll.sessions.find(s => s.sessionId.startsWith('bbbbbbbb'));
    const sessA = scanAll.sessions.find(s => s.sessionId.startsWith('aaaaaaaa'));
    assert.equal(sessA.contextUsedTokens, 205000);
    assert.equal(sessA.contextLimitTokens, 512000);
    assert.equal(sessA.cwd, path.resolve(projA));
    assert.equal(sessB.contextUsedTokens, 63000);
    assert.equal(sessB.contextLimitTokens, 300000);
    assert.equal(sessB.cwd, path.resolve(projB));

    // 按 --session 筛选时不串会话
    const scanOnlyA = cliMonitor.scanCliSessions({ agDir, agCliDir: cliDir, stateDir, nowMs, sessionFilter: 'aaaaaaaa' });
    assert.equal(scanOnlyA.sessionCount, 1);
    assert.equal(scanOnlyA.sessions[0].sessionId, 'aaaaaaaa-0000-0000-0000-000000000001');

    // 验证 runCliMonitor 终端输出与 AbortSignal 退出
    const chunks = [];
    const outStream = new Writable({
      write(chunk, _enc, cb) { chunks.push(chunk.toString('utf8')); cb(); }
    });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 80);
    const monRes = await cliMonitor.runCliMonitor({
      agDir, agCliDir: cliDir, stateDir, nowMs,
      compact: true, intervalMs: 250, handleSignals: false, signal: ac.signal, stdout: outStream
    });
    assert.equal(monRes.ok, true);
    assert.ok(chunks.join('').includes('[AG CLI bbbbbbbb]'));
    assert.ok(chunks.join('').includes('共 2 会话'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('ELV-33: 双路径启动验证 (PowerShell 直启 wrapper 与插件 IPC 入口) 及按模型多会话环境隔离', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-elv33-dual-'));
  const binDir = path.join(tmpDir, 'proxy-bin');
  const realBinDir = path.join(tmpDir, 'real-bin');
  const stateDir = path.join(tmpDir, 'state');
  const wsA = path.join(tmpDir, 'wsA');
  const wsB = path.join(tmpDir, 'wsB');
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(realBinDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(wsA, { recursive: true });
  fs.mkdirSync(wsB, { recursive: true });

  try {
    const fakeExe = path.join(realBinDir, 'agy.exe');
    fs.writeFileSync(fakeExe, 'MZstub', 'utf8');
    const wrapperCmd = path.join(binDir, 'agy.cmd');
    fs.writeFileSync(wrapperCmd, `@echo off\r\n"${fakeExe}" %*\r\n`, 'utf8');

    // 保存模型偏好用于验证启动注入
    cliMonitor.saveCliModelContextPreference({ model: 'gemini-4-hydrogen', mode: 'fixed', limitTokens: 512000, stateDir });
    cliMonitor.saveCliModelContextPreference({ model: 'claude-opus-5-5', mode: 'fixed', limitTokens: 256000, stateDir });

    // 路径 1：直接通过 PATH 探测 .cmd 包装脚本，验证 cliPath 保留包装脚本且 exePath 解包出底层 agy.exe
    const detected = launcher.resolveCliExecutable(null, {
      platform: 'win32',
      homeDir: tmpDir,
      env: { USERPROFILE: tmpDir, LOCALAPPDATA: tmpDir, APPDATA: tmpDir, PATH: binDir }
    });
    assert.equal(detected.ok, true);
    assert.equal(path.resolve(detected.cliPath), path.resolve(wrapperCmd));
    assert.equal(path.resolve(detected.exePath), path.resolve(fakeExe));

    // 多会话分别按各自模型隔离启动（dryRun 验证环境变量互不污染）
    const dryA = await launcher.launchCliSession({
      cliPath: detected.cliPath,
      cwd: wsA,
      model: 'gemini-4-hydrogen',
      sessionId: 'sess-alpha',
      stateDir,
      dryRun: true
    });
    const dryB = await launcher.launchCliSession({
      cliPath: detected.cliPath,
      cwd: wsB,
      model: 'claude-opus-5-5',
      sessionId: 'sess-beta',
      stateDir,
      dryRun: true
    });
    assert.equal(dryA.env.AG_CONTEXT_LIMIT, '512000');
    assert.equal(dryA.env.AG_CLI_SESSION_ID, 'sess-alpha');
    assert.equal(dryB.env.AG_CONTEXT_LIMIT, '256000');
    assert.equal(dryB.env.AG_CLI_SESSION_ID, 'sess-beta');

    // 路径 1 实机子进程：从 PowerShell / Node CLI 入口直接运行 node cli.js launch-cli --dry-run --json
    const cliRun = spawnSync(process.execPath, [
      path.join(__dirname, 'cli.js'),
      'launch-cli', '--cli-path', wrapperCmd, '--cwd', wsA, '--model', 'gemini-4-hydrogen',
      '--state-dir', stateDir, '--dry-run', '--json'
    ], { encoding: 'utf8', env: { ...process.env, AG_METER_TEST_MODE: '1' } });
    assert.equal(cliRun.status, 0, cliRun.stderr);
    const cliOut = JSON.parse(cliRun.stdout);
    assert.equal(cliOut.ok, true);
    assert.equal(cliOut.env.AG_CONTEXT_LIMIT, '512000');

    // 路径 2：从插件主进程 IPC 入口 context-meter:launch-cli 启动
    const handlers = {};
    registerMeterIpcHandlers({ handle: (ch, fn) => { handlers[ch] = fn; } }, {});
    const localFrame = { url: 'https://127.0.0.1:5173/' };
    const ev = { senderFrame: localFrame, sender: { mainFrame: localFrame } };
    const ipcRes = await handlers['context-meter:launch-cli'](ev, {
      cliPath: wrapperCmd,
      cwd: wsB,
      model: 'claude-opus-5-5',
      stateDir,
      dryRun: true
    });
    assert.equal(ipcRes.ok, true);
    assert.equal(ipcRes.cwd, wsB);
    assert.equal(ipcRes.model, 'claude-opus-5-5');
    assert.equal(ipcRes.env.AG_CONTEXT_LIMIT, '256000');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
