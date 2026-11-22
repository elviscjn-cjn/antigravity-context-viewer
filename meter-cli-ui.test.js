'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { startCliUiServer, getCliUiLockFilePath } = require('./meter-cli-ui');
const { scanCliSessions, formatCliStatusLine } = require('./meter-cli-monitor');

function makeTempDir(prefix = 'acm-cli-ui-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('CLI 独立看板: 仅监听 127.0.0.1, 正常返回 /api/status, /api/sessions 与单例复用', { timeout: 10000 }, async () => {
  const stateDir = makeTempDir('acm-ui-st-');
  const agCliDir = makeTempDir('acm-ui-cli-');
  const agDir = makeTempDir('acm-ui-ag-');

  // 构造模拟会话: presence lock + brain transcript + pricing ledger
  const sid = 'test-session-uuid-1234-5678';
  const presenceDir = path.join(agCliDir, 'presence');
  fs.mkdirSync(presenceDir, { recursive: true });
  fs.writeFileSync(path.join(presenceDir, `${sid}.lock`), '1', 'utf8');

  const brainDir = path.join(agCliDir, 'brain', sid, '.system_generated', 'logs');
  fs.mkdirSync(brainDir, { recursive: true });
  const transcriptPath = path.join(brainDir, 'transcript.jsonl');
  fs.writeFileSync(transcriptPath, [
    JSON.stringify({ step_index: 1, type: 'USER_INPUT', created_at: new Date(Date.now() - 5000).toISOString() }),
    JSON.stringify({
      step_index: 2,
      type: 'PLANNER_RESPONSE',
      model: 'gemini-3.8-flash',
      created_at: new Date(Date.now() - 1000).toISOString(),
      usage: { inputTokens: 4000, cacheTokens: 10000, outputTokens: 800 }
    })
  ].join('\n') + '\n', 'utf8');

  // 写入 ledger
  const ledgerPath = path.join(agDir, 'pricing_ledger_v1.json');
  fs.writeFileSync(ledgerPath, JSON.stringify({
    version: 1,
    calls: {
      call_1: {
        callId: 'call_1',
        cascadeId: sid,
        source: 'cli',
        model: 'gemini-3.8-flash',
        modelLabel: 'Gemini 3.8 Flash',
        inputTokens: 4000,
        cacheReadTokens: 10000,
        outputTokens: 800,
        totalTokens: 14800,
        stepIndex: 2,
        durationMs: 1000,
        timestamp: Date.now() - 1000
      }
    }
  }), 'utf8');

  let srv = null;
  let secondSrv = null;
  try {
    srv = await startCliUiServer({
      port: 57890,
      noOpen: true,
      stateDir,
      agCliDir,
      agDir
    });

    assert.equal(srv.ok, true);
    assert.equal(srv.reused, false);
    assert.equal(typeof srv.port, 'number');

    // 1. 验证 GET /api/status (禁用 keep-alive)
    const statusRes = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${srv.port}/api/status`, { agent: false }, (res) => {
        let raw = '';
        res.on('data', c => { raw += c; });
        res.on('end', () => resolve(JSON.parse(raw)));
      }).on('error', reject);
    });
    assert.equal(statusRes.ok, true);
    assert.equal(statusRes.port, srv.port);

    // 2. 验证 GET /api/sessions (会话隔离与完整指标)
    const sessionsRes = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${srv.port}/api/sessions`, { agent: false }, (res) => {
        let raw = '';
        res.on('data', c => { raw += c; });
        res.on('end', () => resolve(JSON.parse(raw)));
      }).on('error', reject);
    });
    assert.equal(sessionsRes.ok, true);
    assert.equal(sessionsRes.sessionCount >= 1, true);
    const targetSession = sessionsRes.sessions.find(s => s.sessionId === sid);
    assert.ok(targetSession, '必须包含创建的 mock 会话');
    assert.equal(targetSession.shortId, 'test-ses');
    assert.equal(targetSession.contextUsedTokens, 14800);
    assert.equal(targetSession.sessionTotalTokens, 14800);
    // 缓存命中率: 10000 / (4000 + 10000) = 71.4%
    assert.equal(targetSession.cacheHitRate, 71.4);
    assert.equal(targetSession.turnCount, 1);
    assert.equal(targetSession.stepCount, 2);
    assert.equal(targetSession.speedTokPerSec, 800); // 800 tok / 1s

    // 3. 验证 formatCliStatusLine 终端紧凑状态行渲染
    const line = formatCliStatusLine(targetSession, { columns: 120 });
    assert.match(line, /◔ 上下文/);
    assert.match(line, /缓存命中 71\.4%/);
    assert.match(line, /1 轮 2 步/);

    // 4. 验证 POST /api/context-set
    const setRes = await new Promise((resolve, reject) => {
      const req = http.request(`http://127.0.0.1:${srv.port}/api/context-set`, {
        method: 'POST',
        agent: false,
        headers: { 'Content-Type': 'application/json' }
      }, (res) => {
        let raw = '';
        res.on('data', c => { raw += c; });
        res.on('end', () => resolve(JSON.parse(raw)));
      });
      req.on('error', reject);
      req.write(JSON.stringify({
        model: 'gemini-3.8-flash',
        mode: 'fixed',
        limitTokens: 256000,
        syncCliSettings: true
      }));
      req.end();
    });
    assert.equal(setRes.ok, true);
    assert.equal(setRes.limitTokens, 256000);

    // 5. 验证单例服务复用: 再次调用 startCliUiServer 返回 reused: true
    secondSrv = await startCliUiServer({
      port: 57890,
      noOpen: true,
      stateDir,
      agCliDir,
      agDir
    });
    assert.equal(secondSrv.ok, true);
    assert.equal(secondSrv.reused, true);
    assert.equal(secondSrv.port, srv.port);

  } finally {
    if (srv && typeof srv.close === 'function') srv.close();
    if (secondSrv && typeof secondSrv.close === 'function') secondSrv.close();
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(agCliDir, { recursive: true, force: true });
    fs.rmSync(agDir, { recursive: true, force: true });
  }
});

test('Step 7.2: CORS 收窄仅放行本机环回 Origin，同目录双 CLI 并发会话及 /api/session-timeline 严格隔离', { timeout: 10000 }, async () => {
  const stateDir = makeTempDir('acm-ui72-st-');
  const agCliDir = makeTempDir('acm-ui72-cli-');
  const agDir = makeTempDir('acm-ui72-ag-');
  const sharedCwd = 'D:\\work\\shared-workspace';
  const sidA = 'cli-sess-aaaa-1111-2222';
  const sidB = 'cli-sess-bbbb-3333-4444';

  const reqJson = (port, urlPath, headers = {}) => new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}${urlPath}`, { agent: false, headers }, (res) => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(raw) }));
    }).on('error', reject);
  });

  let srv = null;
  try {
    fs.mkdirSync(path.join(agCliDir, 'presence'), { recursive: true });
    fs.writeFileSync(path.join(agCliDir, 'presence', `${sidA}.lock`), '1');
    fs.writeFileSync(path.join(agCliDir, 'presence', `${sidB}.lock`), '1');

    const now = Date.now();
    for (const [sid, model, txt] of [
      [sidA, 'gemini-4-hydrogen', 'hello session A'],
      [sidB, 'gemini-3.8-flash', 'hello session B']
    ]) {
      const logDir = path.join(agCliDir, 'brain', sid, '.system_generated', 'logs');
      fs.mkdirSync(logDir, { recursive: true });
      fs.writeFileSync(path.join(logDir, 'transcript.jsonl'), [
        JSON.stringify({ step_index: 1, type: 'USER_INPUT', userInput: txt, created_at: new Date(now - 6000).toISOString(), workspace: sharedCwd }),
        JSON.stringify({ step_index: 2, type: 'PLANNER_RESPONSE', model, created_at: new Date(now - 2000).toISOString(), usage: { inputTokens: 1000, cacheTokens: 2000, outputTokens: 300 } })
      ].join('\n') + '\n', 'utf8');
    }

    fs.writeFileSync(path.join(agDir, 'pricing_ledger_v1.json'), JSON.stringify({
      version: 1,
      calls: {
        cA: { callId: 'cA', cascadeId: sidA, source: 'cli', model: 'gemini-4-hydrogen', modelLabel: 'Gemini 4 Hydrogen', inputTokens: 2000, cacheReadTokens: 8000, outputTokens: 500, totalTokens: 10500, stepIndex: 2, streamingSec: 5, timestamp: now - 2000 },
        cB: { callId: 'cB', cascadeId: sidB, source: 'cli', model: 'gemini-3.8-flash', modelLabel: 'Gemini 3.8 Flash', inputTokens: 500, cacheReadTokens: 500, outputTokens: 200, totalTokens: 1200, stepIndex: 2, streamingSec: 2, timestamp: now - 1500 }
      }
    }), 'utf8');

    srv = await startCliUiServer({ port: 57895, noOpen: true, stateDir, agCliDir, agDir });

    const evilRes = await reqJson(srv.port, '/api/status', { Origin: 'https://evil.example' });
    assert.equal(evilRes.headers['access-control-allow-origin'], undefined, '非本机 Origin 不得返回 CORS 放行头');

    const localOrigin = `http://127.0.0.1:${srv.port}`;
    const localRes = await reqJson(srv.port, '/api/status', { Origin: localOrigin });
    assert.equal(localRes.headers['access-control-allow-origin'], localOrigin);
    assert.match(String(localRes.headers.vary || ''), /Origin/i);

    const sessionsRes = await reqJson(srv.port, '/api/sessions');
    const sessA = sessionsRes.body.sessions.find(s => s.sessionId === sidA);
    const sessB = sessionsRes.body.sessions.find(s => s.sessionId === sidB);
    assert.ok(sessA && sessB, '两个并发 CLI 会话均应存在');
    assert.equal(sessA.model, 'gemini-4-hydrogen');
    assert.equal(sessB.model, 'gemini-3.8-flash');
    assert.equal(sessA.cacheHitRate, 80);
    assert.equal(sessB.cacheHitRate, 50);

    const tlA = await reqJson(srv.port, `/api/session-timeline?sessionId=${encodeURIComponent(sidA)}`);
    const tlB = await reqJson(srv.port, `/api/session-timeline?sessionId=${encodeURIComponent(sidB)}`);
    assert.equal(tlA.body.ok, true);
    assert.equal(tlB.body.ok, true);
    assert.equal(tlA.body.calls.length, 1);
    assert.equal(tlA.body.calls[0].callId, 'cA');
    assert.equal(tlB.body.calls[0].callId, 'cB');
    assert.match(tlA.body.turns[0].preview, /hello session A/);
    assert.match(tlB.body.turns[0].preview, /hello session B/);
  } finally {
    if (srv && typeof srv.close === 'function') srv.close();
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(agCliDir, { recursive: true, force: true });
    fs.rmSync(agDir, { recursive: true, force: true });
  }
});

test('会话深度剖析: CLI UI 返回文件/命令/阶段耗时/Agent家族且严格脱敏并支持 BOM settings.json', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-ui-ext-state-'));
  const agCliDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-ui-ext-cli-'));
  const agDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-ui-ext-ag-'));
  const sid = 'session-ext-insights-001';
  let srv = null;

  const fetchJsonLocal = (url) => new Promise((resolve, reject) => {
    http.get(url, { agent: false }, (res) => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        let body = null;
        try { body = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode, raw, body });
      });
    }).on('error', reject);
  });

  try {
    // 写入带 UTF-8 BOM 的 CLI settings.json 验证兼容
    fs.writeFileSync(path.join(agCliDir, 'settings.json'), '\uFEFF' + JSON.stringify({ contextWindow: '500K' }), 'utf8');
    const logsDir = path.join(agCliDir, 'brain', sid, '.system_generated', 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    fs.writeFileSync(path.join(logsDir, 'transcript.jsonl'), [
      JSON.stringify({ step_index: 0, type: 'USER_INPUT', created_at: '2026-11-22T01:00:00Z', content: 'run tests and inspect code' }),
      JSON.stringify({
        step_index: 1, type: 'PLANNER_RESPONSE', created_at: '2026-11-22T01:00:02Z',
        model: 'gemini-4-carbon', input_tokens: 12000, cache_read_tokens: 0, output_tokens: 200,
        tool_calls: [
          { name: 'read_file', args: { Path: '"D:/repo/src/app.js"' } },
          { name: 'edit_file', args: { Path: '"D:/repo/src/app.js"', Target: '"oldLine"', Replacement: '"newLine1\\nnewLine2"' } },
          { name: 'run_command', args: { CommandLine: '"node test.js --token ghp_secret1234567890abc"', IsDaemon: false, WaitMsBeforeAsync: 5000 }, durationSec: 6.4, status: 'ERROR', error: 'exit 1' }
        ]
      }),
      JSON.stringify({ step_index: 2, type: 'USER_INPUT', created_at: '2026-11-22T01:00:15Z', content: 'retry ok' }),
      JSON.stringify({
        step_index: 3, type: 'PLANNER_RESPONSE', created_at: '2026-11-22T01:00:17Z',
        model: 'gemini-4-carbon', input_tokens: 4000, cache_read_tokens: 14000, output_tokens: 150
      })
    ].join('\n'), 'utf8');

    const { resolveCliModelContextBudget } = require('./meter-cli-monitor');
    const bomBudget = resolveCliModelContextBudget('unknown-model', { stateDir, agCliDir });
    assert.equal(bomBudget.limitTokens, 500000, 'UTF-8 BOM settings.json 应正常解析为 500K');

    srv = await startCliUiServer({ port: 0, noOpen: true, stateDir, agCliDir, agDir });
    const htmlRes = await fetchJsonLocal(`http://127.0.0.1:${srv.port}/`);
    assert.equal(htmlRes.status, 200);
    assert.match(htmlRes.raw, /filter-session-query/);
    assert.match(htmlRes.raw, /sort-session-by/);
    assert.match(htmlRes.raw, /timeline-modal-tabs/);

    const tlRes = await fetchJsonLocal(`http://127.0.0.1:${srv.port}/api/session-timeline?sessionId=${sid}`);
    assert.equal(tlRes.status, 200);
    assert.equal(tlRes.body.ok, true);
    assert.equal(tlRes.body.fileActivities.length, 1);
    assert.equal(tlRes.body.fileActivities[0].readCount, 1);
    assert.equal(tlRes.body.fileActivities[0].writeCount, 1);
    assert.equal(tlRes.body.fileActivities[0].addedLines, 2);
    assert.equal(tlRes.body.fileActivities[0].removedLines, 1);
    assert.equal(tlRes.body.commandExecutions.length, 1);
    assert.equal(tlRes.body.commandExecutions[0].status, 'failed');
    assert.equal(tlRes.body.commandExecutions[0].isSlow, true);
    assert.equal(tlRes.body.commandExecutions[0].program, 'node');
    assert.equal(tlRes.body.commandExecutions[0].command.includes('ghp_secret1234567890abc'), false, '命令行密钥必须脱敏');
    assert.equal(tlRes.body.contextDeltaSummary.netDeltaTokens, 6000);
    assert.ok(tlRes.body.timingSummary.totalToolExecSec >= 6.4);
    assert.equal(tlRes.body.agentFleetSummary.dedupVerified, true);
  } finally {
    if (srv && typeof srv.close === 'function') srv.close();
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(agCliDir, { recursive: true, force: true });
    fs.rmSync(agDir, { recursive: true, force: true });
  }
});

test('活跃 CLI 计数严格排除 stale 会话且 /api/session-detail 精确打开桌面会话详情、缺省不误选', { timeout: 10000 }, async () => {
  const stateDir = makeTempDir('acm-ui-exact-st-');
  const agCliDir = makeTempDir('acm-ui-exact-cli-');
  const agDir = makeTempDir('acm-ui-exact-ag-');

  const fetchJsonLocal = (url) => new Promise((resolve, reject) => {
    http.get(url, { agent: false }, (res) => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        let body = null;
        try { body = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode, raw, body });
      });
    }).on('error', reject);
  });

  // 1. CLI 侧放置 2 个存在 presence/*.lock 的会话：1 个刚活跃 (active)，1 个 5 天前已结束 (stale)
  const activeCliId = '11111111-1111-4111-8111-111111111111';
  const staleCliId = '22222222-2222-4222-8222-222222222222';
  const presenceDir = path.join(agCliDir, 'presence');
  fs.mkdirSync(presenceDir, { recursive: true });
  fs.writeFileSync(path.join(presenceDir, `${activeCliId}.lock`), '1', 'utf8');
  fs.writeFileSync(path.join(presenceDir, `${staleCliId}.lock`), '1', 'utf8');

  const oldTs = new Date(Date.now() - 5 * 86400 * 1000).toISOString();
  const staleBrainDir = path.join(agCliDir, 'brain', staleCliId, '.system_generated', 'logs');
  fs.mkdirSync(staleBrainDir, { recursive: true });
  fs.writeFileSync(path.join(staleBrainDir, 'transcript.jsonl'), [
    JSON.stringify({ step_index: 0, type: 'USER_INPUT', created_at: oldTs, content: 'stale cli' }),
    JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', created_at: oldTs, model: 'gemini-3.8-flash', usage: { inputTokens: 1000, outputTokens: 100 } })
  ].join('\n') + '\n', 'utf8');
  const stalePast = new Date(Date.now() - 5 * 86400 * 1000);
  fs.utimesSync(path.join(presenceDir, `${staleCliId}.lock`), stalePast, stalePast);
  fs.utimesSync(path.join(staleBrainDir, 'transcript.jsonl'), stalePast, stalePast);

  const activeBrainDir = path.join(agCliDir, 'brain', activeCliId, '.system_generated', 'logs');
  fs.mkdirSync(activeBrainDir, { recursive: true });
  const nowTs = new Date(Date.now() - 5000).toISOString();
  fs.writeFileSync(path.join(activeBrainDir, 'transcript.jsonl'), [
    JSON.stringify({ step_index: 0, type: 'USER_INPUT', created_at: nowTs, content: 'active cli' }),
    JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', created_at: nowTs, model: 'gemini-3.8-flash', usage: { inputTokens: 2000, outputTokens: 200 } })
  ].join('\n') + '\n', 'utf8');

  // 2. Desktop 侧放置一个桌面会话 (不在 CLI scan 列表中，模拟从桌面插件精确打开)
  // 故意将 custom_plan_v1.json 放在 agDir 而非 stateDir，验证不同目录隔离下仍命中模型 512K 限额
  fs.mkdirSync(agDir, { recursive: true });
  fs.writeFileSync(path.join(agDir, 'custom_plan_v1.json'), JSON.stringify({
    version: '1.1.0',
    contextPreferences: {
      'product:google:gemini-3.8-flash': {
        modelId: 'product:google:gemini-3.8-flash',
        label: 'Gemini 3.8 Flash',
        mode: 'fixed',
        limitTokens: 512000,
        scope: 'product',
        productKey: 'product:google:gemini-3.8-flash'
      }
    }
  }, null, 2), 'utf8');

  const desktopId = '78799486-61aa-422e-b0dc-dc61314d4c1d';
  const deskBrainDir = path.join(agDir, 'brain', desktopId, '.system_generated', 'logs');
  fs.mkdirSync(deskBrainDir, { recursive: true });
  fs.writeFileSync(path.join(deskBrainDir, 'transcript.jsonl'), [
    JSON.stringify({ step_index: 0, type: 'USER_INPUT', created_at: nowTs, content: '<USER_REQUEST>\n只回复ok\n</USER_REQUEST>' }),
    JSON.stringify({
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      created_at: nowTs,
      model: 'gemini-3.8-flash-high',
      usage: { inputTokens: 3200, cacheTokens: 9600, outputTokens: 4 },
      tool_calls: [{ name: 'manage_task', args: { Action: 'status' }, stepIndex: 1 }]
    })
  ].join('\n') + '\n', 'utf8');

  let srv = null;
  try {
    srv = await startCliUiServer({
      port: 57910,
      noOpen: true,
      stateDir,
      agCliDir,
      agDir,
      sessionId: desktopId,
      source: 'desktop'
    });
    assert.ok(srv.url.includes(`sessionId=${encodeURIComponent(desktopId)}`));
    assert.ok(srv.url.includes('source=desktop'));

    const sessionsRes = await fetchJsonLocal(`http://127.0.0.1:${srv.port}/api/sessions`);
    assert.equal(sessionsRes.status, 200);
    assert.equal(sessionsRes.body.sessionCount, 2, 'CLI 列表保留 2 条 CLI 会话');
    assert.equal(sessionsRes.body.activeSessionCount, 1, '残留 presence lock 的 stale 会话绝不计入活跃');
    assert.equal(sessionsRes.body.staleSessionCount, 1);

    // 验证 HTML 页面源码内活跃计数表达式排除了 hasPresenceLock
    const htmlRes = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${srv.port}/`, { agent: false }, res => {
        let raw = '';
        res.on('data', c => { raw += c; });
        res.on('end', () => resolve(raw));
      }).on('error', reject);
    });
    assert.doesNotMatch(htmlRes, /s\.hasPresenceLock/, '活跃 CLI 数统计不能把残留 lock 算作活跃');
    assert.match(htmlRes, /\/api\/session-detail/);

    // 精确查桌面会话详情 (首屏不列桌面会话时仍必须能精确返回)
    const detailRes = await fetchJsonLocal(`http://127.0.0.1:${srv.port}/api/session-detail?sessionId=${desktopId}&source=desktop`);
    assert.equal(detailRes.status, 200);
    assert.equal(detailRes.body.ok, true);
    assert.equal(detailRes.body.source, 'desktop');
    assert.equal(detailRes.body.sessionId, desktopId);
    assert.match(detailRes.body.titlePreview, /只回复ok/);
    assert.equal(detailRes.body.contextUsedTokens, 12804);
    assert.equal(detailRes.body.contextLimitTokens, 512000);
    assert.match(String(detailRes.body.contextLimitSource || ''), /^per_model_pref:/);
    assert.equal(detailRes.body.timeline.agentFleetSummary.taskEvents.length, 1);
    assert.equal(detailRes.body.timeline.agentFleetSummary.hasTaskDependencyDag, false);

    // 不存在的会话返回 404 且不猜第一条
    const missingRes = await fetchJsonLocal(`http://127.0.0.1:${srv.port}/api/session-detail?sessionId=99999999-9999-4999-8999-999999999999&source=desktop`);
    assert.equal(missingRes.status, 404);
    assert.equal(missingRes.body.ok, false);
    assert.equal(missingRes.body.code, 'SESSION_NOT_FOUND');

    // 非法 ID 返回 400
    const badRes = await fetchJsonLocal(`http://127.0.0.1:${srv.port}/api/session-detail?sessionId=../etc/passwd`);
    assert.equal(badRes.status, 400);
    assert.equal(badRes.body.ok, false);
  } finally {
    if (srv && typeof srv.close === 'function') srv.close();
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(agCliDir, { recursive: true, force: true });
    fs.rmSync(agDir, { recursive: true, force: true });
  }
});
