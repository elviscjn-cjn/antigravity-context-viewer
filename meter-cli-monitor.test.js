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

test('readOnly: true 严格零写零删 — usage 与 monitor 不触发备份清理、账本写回或归档落盘', async () => {
  const crypto = require('node:crypto');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-cli-ro-guard-'));
  try {
    const agDir = path.join(tmpDir, 'antigravity');
    const agCliDir = path.join(tmpDir, 'antigravity-cli');
    const stateDir = path.join(tmpDir, 'state');
    const cliUuid = '44444444-4444-4444-8444-444444444444';
    fs.mkdirSync(path.join(agDir, 'conversations'), { recursive: true });
    fs.mkdirSync(path.join(agCliDir, 'brain', cliUuid, '.system_generated', 'logs'), { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });

    // 1. 预置账本（含未升级 attributionRepairVersion）、6 份 .bak-pre-elv89-* 历史备份、未建 .bak 的归档与损坏配置
    const ledgerPath = path.join(agDir, 'pricing_ledger_v1.json');
    const ledgerBody = JSON.stringify({
      version: '1.0.0',
      updatedAt: '2026-11-19T12:00:00.000Z',
      calls: {
        'ro-call-1': {
          callId: 'ro-call-1',
          cascadeId: cliUuid,
          stepIndex: 1,
          model: 'gemini-4-hydrogen:high',
          inputTokens: 1200,
          cacheReadTokens: 800,
          outputTokens: 300,
          totalTokens: 2300,
          date: '2026-11-19',
          timestamp: Date.parse('2026-11-19T12:00:00.000Z'),
          source: 'cli',
          accountScopeKey: collector.buildAccountScopeKey('ro-tester@example.com'),
          accountAttributionConfidence: 'live_confirmed_account',
          attributionRepairVersion: 'elv89-v1',
          created_at: '2026-11-19T12:00:00.000Z'
        }
      }
    }, null, 2);
    fs.writeFileSync(ledgerPath, ledgerBody, 'utf8');
    fs.writeFileSync(path.join(agDir, 'custom_plan_settings.json'), '{broken json', 'utf8');

    for (let i = 1; i <= 6; i++) {
      fs.writeFileSync(`${ledgerPath}.bak-pre-elv89-${1795100000000 + i * 1000}`, ledgerBody, 'utf8');
    }

    // 缺少 .bak.json 的 v1/v2 归档 + 可触发配对的新 transcript
    fs.writeFileSync(path.join(agDir, 'token_usage_archive_v1.json'), JSON.stringify({
      firstUseDate: '2026-11-18',
      dailyMap: { '2026-11-18': { total: 500, input: 300, output: 100, cache: 100, steps: 1 } },
      maxConversations: 1
    }), 'utf8');
    fs.writeFileSync(path.join(agCliDir, 'brain', cliUuid, '.system_generated', 'logs', 'transcript.jsonl'),
      [
        JSON.stringify({
          step_index: 1,
          source: 'MODEL',
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          responseId: 'ro-call-1',
          created_at: '2026-11-19T12:00:00.000Z',
          model: 'gemini-4-hydrogen-high',
          chatModel: { modelDisplayName: 'Gemini 4 Hydrogen (High)' },
          input_tokens: 1200,
          cache_read_tokens: 800,
          output_tokens: 300
        }),
        JSON.stringify({
          step_index: 2,
          source: 'MODEL',
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          responseId: 'ro-call-2',
          created_at: '2026-11-19T12:05:00.000Z',
          model: 'gemini-4-hydrogen-high',
          chatModel: { modelDisplayName: 'Gemini 4 Hydrogen (High)' },
          input_tokens: 400,
          cache_read_tokens: 100,
          output_tokens: 50
        })
      ].join('\n') + '\n',
      'utf8'
    );
    const roScope = collector.buildAccountScopeKey('ro-tester@example.com');
    fs.writeFileSync(path.join(stateDir, 'accounts_v1.json'), JSON.stringify({
      version: 1,
      accounts: { [roScope]: { accountScopeKey: roScope, email: 'ro-tester@example.com' } },
      accountSessions: [{ accountScopeKey: roScope, startMs: 0, endMs: Date.now() + 86400000, verified: true }]
    }), 'utf8');

    const snapshotTree = (rootDir) => {
      const entries = {};
      const walk = (dir) => {
        for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, ent.name);
          const rel = path.relative(rootDir, full);
          if (ent.isDirectory()) {
            walk(full);
          } else {
            const buf = fs.readFileSync(full);
            const st = fs.statSync(full);
            entries[rel] = {
              size: st.size,
              mtimeMs: st.mtimeMs,
              sha256: crypto.createHash('sha256').update(buf).digest('hex')
            };
          }
        }
      };
      walk(rootDir);
      return entries;
    };

    const beforeSnap = snapshotTree(tmpDir);

    // 2. 执行 readOnly collectTokenHistoryAsync + queryCliUsage + runCliMonitor + CLI usage 子进程
    const collectorRes = await collector.collectTokenHistoryAsync({
      agDir,
      agCliDir,
      stateDir,
      wslRoots: [],
      force: true,
      readOnly: true
    });
    assert.ok(collectorRes.summary.grandTotalTokens >= 2300);

    const usageRes = await cliMonitor.queryCliUsage({ agDir, agCliDir, stateDir, wslRoots: [], period: 'all' });
    assert.equal(usageRes.ok, true);
    assert.equal(usageRes.readOnly, true);

    const chunks = [];
    const monRes = await cliMonitor.runCliMonitor({
      agDir,
      agCliDir,
      stateDir,
      once: true,
      json: true,
      stdout: { write: s => chunks.push(s), isTTY: false }
    });
    assert.equal(monRes.ok, true);

    const cliRun = spawnSync(process.execPath, [
      path.join(__dirname, 'cli.js'),
      'usage', '--all', '--json', '--ag-dir', agDir, '--cli-dir', agCliDir, '--state-dir', stateDir
    ], { encoding: 'utf8', env: { ...process.env, AG_METER_TEST_MODE: '1' } });
    assert.equal(cliRun.status, 0, cliRun.stderr);
    const cliJson = JSON.parse(cliRun.stdout);
    assert.equal(cliJson.ok, true);
    assert.equal(cliJson.readOnly, true);

    const afterSnap = snapshotTree(tmpDir);
    assert.deepEqual(afterSnap, beforeSnap, 'readOnly: true 下任何路径都不允许新增、删除或修改目录内文件');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('P1 修复验证 1: CLI --state-dir 严格隔离 custom_plan_v1.json，不读写默认 ~/.gemini/antigravity 配置', () => {
  const crypto = require('node:crypto');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-p1-statedir-'));
  try {
    const fakeHome = path.join(tmpDir, 'fake-home');
    const fakeAgDir = path.join(fakeHome, '.gemini', 'antigravity');
    const customStateDir = path.join(tmpDir, 'isolated-state');
    const cliDir = path.join(tmpDir, 'isolated-cli');
    const wsDir = path.join(tmpDir, 'ws');
    fs.mkdirSync(fakeAgDir, { recursive: true });
    fs.mkdirSync(customStateDir, { recursive: true });
    fs.mkdirSync(cliDir, { recursive: true });
    fs.mkdirSync(wsDir, { recursive: true });

    // 在模拟用户默认 HOME 写入哨兵模型偏好，验证传入 --state-dir 时绝不读取或覆盖该文件
    const sentinelPath = path.join(fakeAgDir, 'custom_plan_v1.json');
    const sentinelContent = JSON.stringify({
      version: '1.1.0',
      updatedAt: '2026-01-01T00:00:00.000Z',
      lastAccount: 'default',
      accounts: {},
      uiPreferences: {},
      contextPreferences: {
        'sentinel-only-model': {
          modelId: 'sentinel-only-model',
          label: 'sentinel-only-model',
          mode: 'fixed',
          limitTokens: 321000,
          updatedAt: '2026-01-01T00:00:00.000Z'
        },
        'gemini-4-hydrogen-high': {
          modelId: 'gemini-4-hydrogen-high',
          label: 'gemini-4-hydrogen-high',
          mode: 'fixed',
          limitTokens: 999000,
          updatedAt: '2026-01-01T00:00:00.000Z'
        }
      }
    }, null, 2);
    fs.writeFileSync(sentinelPath, sentinelContent, 'utf8');
    const sentinelStatBefore = fs.statSync(sentinelPath);
    const sentinelHashBefore = crypto.createHash('sha256').update(fs.readFileSync(sentinelPath)).digest('hex');

    // 同时对宿主机真实 ~/.gemini/antigravity/custom_plan_v1.json 做存在性与哈希快照
    const realHome = process.env.USERPROFILE || os.homedir();
    const realPlanPath = path.join(realHome, '.gemini', 'antigravity', 'custom_plan_v1.json');
    const realExistedBefore = fs.existsSync(realPlanPath);
    const realHashBefore = realExistedBefore
      ? crypto.createHash('sha256').update(fs.readFileSync(realPlanPath)).digest('hex')
      : null;

    const wrapperCmd = process.platform === 'win32'
      ? path.join(tmpDir, 'agy-dummy.cmd')
      : path.join(tmpDir, 'agy-dummy');
    fs.writeFileSync(wrapperCmd, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n', { mode: 0o755 });

    const isoEnv = {
      ...process.env,
      AG_METER_TEST_MODE: '1',
      USERPROFILE: fakeHome,
      HOME: fakeHome,
      AG_DIR: ''
    };
    delete isoEnv.AG_DIR;

    const cliJs = path.join(__dirname, 'cli.js');

    // 1. context-set 仅写入 --state-dir，不可篡改默认 HOME 配置
    const setRes = spawnSync(process.execPath, [
      cliJs, 'context-set',
      '--model', 'gemini-4-hydrogen-high',
      '--mode', 'fixed',
      '--limit', '256000',
      '--state-dir', customStateDir,
      '--cli-dir', cliDir,
      '--json'
    ], { encoding: 'utf8', env: isoEnv, windowsHide: true });
    assert.equal(setRes.status, 0, setRes.stderr);
    const setJson = JSON.parse(setRes.stdout);
    assert.equal(setJson.ok, true);

    const isolatedPlanPath = path.join(customStateDir, 'custom_plan_v1.json');
    assert.equal(fs.existsSync(isolatedPlanPath), true, '--state-dir 目录下应生成隔离 custom_plan_v1.json');
    const isolatedData = JSON.parse(fs.readFileSync(isolatedPlanPath, 'utf8'));
    assert.equal(isolatedData.contextPreferences['gemini-4-hydrogen-high'].limitTokens, 256000);
    assert.equal(isolatedData.contextPreferences['sentinel-only-model'], undefined);

    // 2. context-status 读取 --state-dir：不得混入 sentinel-only-model，且 gemini-4-hydrogen-high 必须为 256000 而非哨兵值 999000
    const statusRes = spawnSync(process.execPath, [
      cliJs, 'context-status',
      '--model', 'gemini-4-hydrogen-high',
      '--state-dir', customStateDir,
      '--cli-dir', cliDir,
      '--json'
    ], { encoding: 'utf8', env: isoEnv, windowsHide: true });
    assert.equal(statusRes.status, 0, statusRes.stderr);
    const statusJson = JSON.parse(statusRes.stdout);
    assert.equal(statusJson.contextPreferences['sentinel-only-model'], undefined, 'context-status 不得泄露默认 HOME 偏好');
    assert.equal(statusJson.selectedModelBudget.limitTokens, 256000);

    // 3. launch-cli --dry-run 读取 --state-dir 的 256000 并屏蔽默认 HOME 的 321000/999000
    const launchRes = spawnSync(process.execPath, [
      cliJs, 'launch-cli',
      '--cli-path', wrapperCmd,
      '--cwd', wsDir,
      '--model', 'gemini-4-hydrogen-high',
      '--state-dir', customStateDir,
      '--dry-run', '--json'
    ], { encoding: 'utf8', env: isoEnv, windowsHide: true });
    assert.equal(launchRes.status, 0, launchRes.stderr);
    const launchJson = JSON.parse(launchRes.stdout);
    assert.equal(launchJson.ok, true);
    assert.equal(launchJson.env.AG_CONTEXT_LIMIT, '256000');

    const launchSentinelRes = spawnSync(process.execPath, [
      cliJs, 'launch-cli',
      '--cli-path', wrapperCmd,
      '--cwd', wsDir,
      '--model', 'sentinel-only-model',
      '--state-dir', customStateDir,
      '--dry-run', '--json'
    ], { encoding: 'utf8', env: isoEnv, windowsHide: true });
    assert.equal(launchSentinelRes.status, 0, launchSentinelRes.stderr);
    const launchSentinelJson = JSON.parse(launchSentinelRes.stdout);
    assert.equal(launchSentinelJson.modelContextPreference, null, '传入 --state-dir 时 launch-cli 不得读取默认 HOME 偏好');
    assert.equal(launchSentinelJson.env.AG_CONTEXT_LIMIT, undefined);

    // 4. 断言默认哨兵文件与真实 ~/.gemini/antigravity/custom_plan_v1.json 零写入零篡改
    const sentinelStatAfter = fs.statSync(sentinelPath);
    const sentinelHashAfter = crypto.createHash('sha256').update(fs.readFileSync(sentinelPath)).digest('hex');
    assert.equal(sentinelHashAfter, sentinelHashBefore);
    assert.equal(sentinelStatAfter.mtimeMs, sentinelStatBefore.mtimeMs);

    const realExistedAfter = fs.existsSync(realPlanPath);
    assert.equal(realExistedAfter, realExistedBefore);
    if (realExistedBefore) {
      const realHashAfter = crypto.createHash('sha256').update(fs.readFileSync(realPlanPath)).digest('hex');
      assert.equal(realHashAfter, realHashBefore);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('P1 修复验证 2: 沙箱 ASAR 安装注入 dist/meter-cli-monitor.js 且与工作区逐字节一致', async () => {
  const { builtinAsar } = require('./asar-engine');
  const { install } = require('./install');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-p1-asar-mon-'));
  const keys = ['AG_METER_TEST_MODE', 'AG_METER_STATE_DIR', 'APPDATA', 'LOCALAPPDATA', 'HOME', 'USERPROFILE'];
  const prevEnv = {};
  for (const k of keys) prevEnv[k] = process.env[k];

  try {
    const sbHome = path.join(tmpDir, 'home');
    const sbState = path.join(tmpDir, 'state');
    const sbAppData = path.join(tmpDir, 'appdata');
    const sbLocal = path.join(tmpDir, 'localappdata');
    const hostSrc = path.join(tmpDir, 'host-src');
    const hostDist = path.join(hostSrc, 'dist');
    fs.mkdirSync(sbHome, { recursive: true });
    fs.mkdirSync(sbState, { recursive: true });
    fs.mkdirSync(sbAppData, { recursive: true });
    fs.mkdirSync(sbLocal, { recursive: true });
    fs.mkdirSync(hostDist, { recursive: true });

    fs.writeFileSync(path.join(hostSrc, 'package.json'), JSON.stringify({
      name: 'antigravity-test-host',
      version: '2.33.0',
      main: 'dist/utils.js'
    }, null, 2));
    fs.writeFileSync(path.join(hostDist, 'utils.js'), `'use strict';
function setupNodeWrapper(env) { return env; }
function createWindow(win, url) {
    void win.loadURL(url);
}
exports.setupNodeWrapper = setupNodeWrapper;
exports.createWindow = createWindow;
exports.getHubWindows = () => [];
`);
    fs.writeFileSync(path.join(hostDist, 'preload.js'), `'use strict';
const { contextBridge } = require('electron');
contextBridge.exposeInMainWorld('__HOST__', {});
`);

    const sandboxAsar = path.join(tmpDir, 'app.asar');
    await builtinAsar.createPackage(hostSrc, sandboxAsar);

    process.env.AG_METER_TEST_MODE = '1';
    process.env.AG_METER_STATE_DIR = sbState;
    process.env.APPDATA = sbAppData;
    process.env.LOCALAPPDATA = sbLocal;
    process.env.HOME = sbHome;
    process.env.USERPROFILE = sbHome;

    await install({ path: sandboxAsar, customAsarPath: sandboxAsar });

    const extractedMonitor = builtinAsar.extractFile(sandboxAsar, 'dist/meter-cli-monitor.js');
    const workspaceMonitor = fs.readFileSync(path.join(__dirname, 'meter-cli-monitor.js'));
    assert.equal(extractedMonitor.equals(workspaceMonitor), true, 'app.asar 内 dist/meter-cli-monitor.js 必须与工作区逐字节一致');

    for (const coreFile of ['meter-renderer.js', 'meter-core.js', 'meter-collector.js', 'meter-cli-launcher.js', 'meter-context-unlock.js']) {
      const extBuf = builtinAsar.extractFile(sandboxAsar, `dist/${coreFile}`);
      const wsBuf = fs.readFileSync(path.join(__dirname, coreFile));
      assert.equal(extBuf.equals(wsBuf), true, `app.asar 内 dist/${coreFile} 必须与工作区逐字节一致`);
    }
  } finally {
    for (const k of keys) {
      if (prevEnv[k] === undefined) delete process.env[k];
      else process.env[k] = prevEnv[k];
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
