'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const vm = require('node:vm');

const isolatedAppData = path.join(os.tmpdir(), 'ag-meter-v234-test-appdata');
fs.mkdirSync(isolatedAppData, { recursive: true });
process.env.APPDATA = isolatedAppData;
process.env.AG_METER_TEST_MODE = '1';

const { builtinAsar } = require('./asar-engine');
const { install } = require('./install');
const { restore } = require('./restore');
const {
  TAGS,
  cleanUtilsSource,
  findWindowLoadHookTarget,
  injectWindowLoadHook,
  verifyCleanStructure,
  validateSyntax
} = require('./modular-installer');
const localApi = require('./local-api');
const collector = require('./meter-collector');

test('PR #67: preserve awaited, qualified and multiline host loader calls', () => {
  for (const call of [
    '    await loadHubWindowUrl(win, url, options);',
    '    void hub.loadHubWindowUrl(win, url);',
    '    await (0, hub.loadHubWindowUrl)(win, url, {\r\n        skipBootstrapMint\r\n    });'
  ]) {
    assert.equal(injectWindowLoadHook(call, '    hook();\n'), '    hook();\n' + call);
    assert.equal(findWindowLoadHookTarget(call + '\n' + call), null);
  }
});

const SAMPLE_V234_UTILS = `"use strict";
exports.loadHubWindowUrl = loadHubWindowUrl;
async function loadHubWindowUrl(win, targetUrl, options) {
    await win.loadURL(targetUrl);
}
function setupNodeWrapper(env) {
    return env;
}
function createWindow(url, storageManager, options) {
    const windowOptions = {
        titleBarStyle: 'hidden',
    };
    const skipBootstrapMint = Boolean(options?.partition || options?.navigationPolicy);
    void loadHubWindowUrl(win, url, { skipBootstrapMint });
    return win;
}
`;

async function createMockAsar(dir, version, utilsSource) {
  const rand = Math.random().toString(36).slice(2, 8);
  const src = path.join(dir, `src-${version}-${rand}`);
  fs.mkdirSync(path.join(src, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(src, 'package.json'), JSON.stringify({ name: 'antigravity', version }), 'utf8');
  fs.writeFileSync(path.join(src, 'dist', 'utils.js'), utilsSource, 'utf8');
  fs.writeFileSync(path.join(src, 'dist', 'preload.js'), '"use strict";\nconst electron_1 = require("electron");\n', 'utf8');
  const out = path.join(dir, `app-${version}-${rand}.asar`);
  await builtinAsar.createPackageWithOptions(src, out, {});
  fs.rmSync(src, { recursive: true, force: true });
  return out;
}

// ============================================================================
// 1. Antigravity 2.34.0 窗口加载锚点识别、安装、升级与原位卸载
// ============================================================================

test('modular-installer 兼容 2.34.0 loadHubWindowUrl 锚点并拒绝缺失或歧义结构', () => {
  const target234 = findWindowLoadHookTarget(SAMPLE_V234_UTILS);
  assert.ok(target234);
  assert.equal(target234.kind, 'hub_loader_v234');
  assert.equal(verifyCleanStructure(SAMPLE_V234_UTILS), true);

  // 兼容 CRLF 换行
  const crlfUtils = SAMPLE_V234_UTILS.replace(/\n/g, '\r\n');
  assert.equal(verifyCleanStructure(crlfUtils), true);

  // 注入必须完整保留 loadHubWindowUrl(..., { skipBootstrapMint }) 原文
  const hook = `${TAGS.METER_UTILS_START}\n    require("./meter-main").installContextMeter(win);\n${TAGS.METER_UTILS_END}\n`;
  const injected = injectWindowLoadHook(SAMPLE_V234_UTILS, hook);
  assert.ok(injected.includes('void loadHubWindowUrl(win, url, { skipBootstrapMint });'));
  assert.ok(injected.includes('installContextMeter(win)'));
  assert.equal(validateSyntax(injected, 'dist/utils.js'), true);

  // 清洗后应完全恢复结构且校验通过
  const cleaned = cleanUtilsSource(injected);
  assert.equal(verifyCleanStructure(cleaned), true);
  assert.ok(!cleaned.includes('installContextMeter'));
  assert.ok(cleaned.includes('void loadHubWindowUrl(win, url, { skipBootstrapMint });'));

  // 歧义拒绝：同时包含旧版与新版锚点
  const bothMarkers = SAMPLE_V234_UTILS.replace(
    'return win;',
    '    void win.loadURL(url);\n    return win;'
  );
  assert.equal(findWindowLoadHookTarget(bothMarkers), null);
  assert.equal(verifyCleanStructure(bothMarkers), false);

  // 歧义拒绝：重复出现两次 loadHubWindowUrl(win, url, ...)
  const dupHub = SAMPLE_V234_UTILS.replace(
    'return win;',
    '    void loadHubWindowUrl(win, url, { skipBootstrapMint });\n    return win;'
  );
  assert.equal(findWindowLoadHookTarget(dupHub), null);
  assert.equal(verifyCleanStructure(dupHub), false);
});

test('Antigravity 2.34.0 ASAR 端到端安装、原位重装与无损原位还原全闭环', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-v234-install-'));
  const prevStateDir = process.env.AG_METER_STATE_DIR;
  process.env.AG_METER_STATE_DIR = path.join(tmpDir, 'state');
  t.after(() => {
    if (prevStateDir === undefined) delete process.env.AG_METER_STATE_DIR;
    else process.env.AG_METER_STATE_DIR = prevStateDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const asarPath = await createMockAsar(tmpDir, '2.34.0', SAMPLE_V234_UTILS);

  // 1. 首次安装
  const manifest1 = await install({ path: asarPath, pureMeterOnly: true });
  assert.equal(manifest1.version, '2.34.0');
  const patchedUtils1 = builtinAsar.extractFile(asarPath, 'dist/utils.js').toString('utf8');
  assert.ok(patchedUtils1.includes('installContextMeter(win)'));
  assert.ok(patchedUtils1.includes('void loadHubWindowUrl(win, url, { skipBootstrapMint });'));
  new vm.Script(patchedUtils1, { filename: 'dist/utils.js' });

  // 2. 再次安装（走原位清洗重装路径）
  const manifest2 = await install({ path: asarPath, pureMeterOnly: true });
  assert.equal(manifest2.version, '2.34.0');
  const patchedUtils2 = builtinAsar.extractFile(asarPath, 'dist/utils.js').toString('utf8');
  assert.equal(patchedUtils2.split('installContextMeter(win)').length, 2, '重装不得重复堆叠挂载点');
  assert.ok(patchedUtils2.includes('void loadHubWindowUrl(win, url, { skipBootstrapMint });'));
  new vm.Script(patchedUtils2, { filename: 'dist/utils.js' });

  // 3. 原位卸载还原
  const resRestore = await restore({ path: asarPath, inPlace: true });
  assert.equal(resRestore.inPlaceCleaned, true);
  const restoredUtils = builtinAsar.extractFile(asarPath, 'dist/utils.js').toString('utf8');
  assert.equal(verifyCleanStructure(restoredUtils), true);
  assert.ok(!restoredUtils.includes('installContextMeter'));
  assert.ok(restoredUtils.includes('void loadHubWindowUrl(win, url, { skipBootstrapMint });'));
});

// ============================================================================
// 2. Antigravity 2.34.0 空 HTML csrfToken 下的鉴权解析与安全边界
// ============================================================================

test('local-api 在 2.34.0 空 HTML csrfToken 下通过同源 authBootstrap 鉴权并严格隔离不同端口/非回环地址', async (t) => {
  let activeToken = 'ls-admin-token-v1';
  let rpcCount = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<script>window.__APP_CONFIG__ = {"productName":"antigravity","csrfToken":"","appVersion":"2.34.0"};</script>');
      return;
    }
    if (req.url.includes('/GetUserStatus')) {
      rpcCount++;
      const got = req.headers['x-codeium-csrf-token'];
      if (got !== activeToken) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ userStatus: { email: 'v234@example.com' } }));
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => server.close(r)));
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;

  // 2.1 精确同源 authBootstrap 解析成功
  const mockAuthBootstrap = {
    getActiveLsBaseUrl: () => origin,
    getActiveLsCsrfToken: () => activeToken
  };
  const api = await localApi.connect({ origin, authBootstrap: mockAuthBootstrap, allowDaemonFallback: false });
  const r1 = await api.call('GetUserStatus', {});
  assert.equal(r1.userStatus.email, 'v234@example.com');

  // 2.2 令牌轮换导致 401 时自动刷新重试一次
  activeToken = 'ls-admin-token-v2';
  const r2 = await api.call('GetUserStatus', {});
  assert.equal(r2.userStatus.email, 'v234@example.com');
  assert.equal(rpcCount, 3, '应触发 1 次 401 刷新重试并成功');

  // 2.3 端口不匹配时严禁泄露主进程令牌
  const wrongPortAuth = {
    getActiveLsBaseUrl: () => `http://127.0.0.1:${port + 1}`,
    getActiveLsCsrfToken: () => activeToken
  };
  assert.equal(localApi.resolveAuthBootstrapForOrigin(origin, { authBootstrap: wrongPortAuth }), null);
  await assert.rejects(
    () => localApi.connect({ origin, authBootstrap: wrongPortAuth, allowDaemonFallback: false }),
    /本地鉴权信息尚未就绪/
  );

  // 2.4 非回环地址严禁解析
  assert.equal(localApi.resolveAuthBootstrapForOrigin('https://example.com', { authBootstrap: mockAuthBootstrap }), null);
  await assert.rejects(
    () => localApi.connect({ origin: 'https://example.com', authBootstrap: mockAuthBootstrap }),
    /非法的本机回环页面地址/
  );

  // 2.5 无凭证来源时保留原有鉴权错误语义
  await assert.rejects(
    () => localApi.connect({ origin, authBootstrap: null, allowDaemonFallback: false }),
    /本地鉴权信息尚未就绪/
  );
});

test('local-api 在无 CDP 时回退至 authBootstrap 与存活 daemon/hub_*.json（忽略死进程）', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-v234-daemon-'));
  const daemonDir = path.join(tmpDir, 'daemon');
  const appDataDir = path.join(tmpDir, 'appdata');
  fs.mkdirSync(daemonDir, { recursive: true });
  fs.mkdirSync(path.join(appDataDir, 'Antigravity'), { recursive: true });
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const server = http.createServer((req, res) => {
    if (req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<script>window.__APP_CONFIG__ = {"csrfToken":""};</script>');
      return;
    }
    if (req.headers['x-codeium-csrf-token'] === 'live-daemon-csrf') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(401);
    res.end('unauthorized');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => server.close(r)));
  const port = server.address().port;

  // 写入一个死进程 hub（应忽略）与一个存活进程 hub（应命中）
  fs.writeFileSync(
    path.join(daemonDir, 'hub_dead.json'),
    JSON.stringify({ pid: 999991, httpPort: port, csrfToken: 'dead-csrf' })
  );
  fs.writeFileSync(
    path.join(daemonDir, 'hub_live.json'),
    JSON.stringify({ pid: 424242, httpPort: port, csrfToken: 'live-daemon-csrf' })
  );

  const api = await localApi.connect({
    appDataDir,
    daemonDir,
    authBootstrap: null,
    isPidAlive: pid => pid === 424242
  });
  assert.equal(api.origin, `http://127.0.0.1:${port}`);
  const rpcRes = await api.call('GetUserStatus', {});
  assert.equal(rpcRes.ok, true);
});

test('local-api 在 CDP 模式下即使 HTML csrfToken 为空仍调用 CDP 提取已鉴权页面的会话令牌', async (t) => {
  let cdpPort = 0;
  let hubPort = 0;

  const hubServer = http.createServer((req, res) => {
    if (req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<script>window.__APP_CONFIG__ = {"csrfToken":""};</script>');
      return;
    }
    if (req.headers['x-codeium-csrf-token'] === 'cdp-bootstrapped-session-token') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(401);
    res.end('unauthorized');
  });
  await new Promise(r => hubServer.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => hubServer.close(r)));
  hubPort = hubServer.address().port;

  // 构造最小 RFC 6455 CDP 服务器，模拟 2.34.0 页面完成 bootstrap 后的 window.__APP_CONFIG__ / localStorage
  const openSockets = new Set();
  const cdpServer = http.createServer((req, res) => {
    if (req.url === '/json/list') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([{
        type: 'page',
        url: `http://127.0.0.1:${hubPort}/`,
        webSocketDebuggerUrl: `ws://127.0.0.1:${cdpPort}/devtools/page/1`
      }]));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  cdpServer.on('upgrade', (req, socket) => {
    openSockets.add(socket);
    socket.on('close', () => openSockets.delete(socket));
    const key = req.headers['sec-websocket-key'];
    const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    let buf = Buffer.alloc(0);
    socket.on('data', chunk => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length < 6) return;
      const opcode = buf[0] & 0x0f;
      if (opcode === 0x8) {
        try { socket.end(); } catch {}
        return;
      }
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      }
      const maskLen = masked ? 4 : 0;
      if (buf.length < off + maskLen + len) return;
      const payload = Buffer.from(buf.subarray(off + maskLen, off + maskLen + len));
      if (masked) {
        const mask = buf.subarray(off, off + 4);
        for (let i = 0; i < len; i++) payload[i] ^= mask[i & 3];
      }
      buf = buf.subarray(off + maskLen + len);
      const msg = JSON.parse(payload.toString('utf8'));
      const reply = Buffer.from(JSON.stringify({
        id: msg.id,
        result: { result: { value: { hasConfig: true, csrfToken: 'cdp-bootstrapped-session-token' } } }
      }), 'utf8');
      const header = reply.length < 126
        ? Buffer.from([0x81, reply.length])
        : Buffer.from([0x81, 126, (reply.length >> 8) & 0xff, reply.length & 0xff]);
      socket.write(Buffer.concat([header, reply]));
    });
  });
  await new Promise(r => cdpServer.listen(0, '127.0.0.1', r));
  t.after(() => {
    for (const s of openSockets) { try { s.destroy(); } catch {} }
    return new Promise(r => cdpServer.close(r));
  });
  cdpPort = cdpServer.address().port;

  const api = await localApi.connect({ port: cdpPort, strictPort: true, authBootstrap: null, allowDaemonFallback: false });
  assert.equal(api.origin, `http://127.0.0.1:${hubPort}`);
  const out = await api.call('GetUserStatus', {});
  assert.equal(out.ok, true);
});

// ============================================================================
// 3. meter-collector 在 2.34.0 空 HTML csrfToken 下完成会话扫描与额度获取
// ============================================================================

test('meter-collector.collect 与 fetchQuotaSnapshotFromHost 在 2.34.0 下通过 authBootstrap 正常完成扫描与 401 自愈', async (t) => {
  let currentToken = 'collect-tok-1';
  let trajectoryCalls = 0;
  let unauthorized401Count = 0;
  const cascadeId = '11111111-2222-3333-4444-555555555555';

  const server = http.createServer((req, res) => {
    if (req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<script>window.__APP_CONFIG__ = {"productName":"antigravity","csrfToken":"","appVersion":"2.34.0"};</script>');
      return;
    }
    const got = req.headers['x-codeium-csrf-token'];
    if (got !== currentToken) {
      unauthorized401Count++;
      res.writeHead(401);
      res.end('unauthorized');
      return;
    }
    if (req.url.endsWith('/GetCascadeTrajectory')) {
      trajectoryCalls++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        numTotalSteps: 1,
        trajectory: {
          ...(trajectoryCalls === 2 ? { metadata: { workspaceUris: ['vscode-remote://ssh-remote+test-host/workspace'] } } : {}),
          steps: [{
            type: 'CORTEX_STEP_TYPE_USER_INPUT',
            userInput: { items: [{ text: 'hello v2.34.0' }] }
          }]
        }
      }));
      return;
    }
    if (req.url.endsWith('/GetCascadeTrajectoryGeneratorMetadata')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ generatorMetadata: [] }));
      return;
    }
    if (req.url.includes('/GetUserStatus')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        userStatus: {
          email: 'quota234@example.com',
          userTier: { id: 'g1-pro-tier', name: 'Google AI Pro', description: 'Google AI Pro' },
          planStatus: { planInfo: { planName: 'Pro', teamsTier: 'TEAMS_TIER_PRO' } },
          cascadeModelConfigData: {
            clientModelConfigs: [{
              label: 'Gemini 4 Carbon (High)',
              modelOrAlias: { model: 'MODEL_PLACEHOLDER_M427' },
              quotaInfo: { remainingFraction: 0.88, resetTime: '2026-11-22T00:00:00Z' }
            }]
          }
        }
      }));
      return;
    }
    if (req.url.includes('/RetrieveUserQuotaSummary')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({}));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => server.close(r)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const mockAuthBootstrap = {
    getActiveLsBaseUrl: () => origin,
    getActiveLsCsrfToken: () => currentToken
  };

  // 3.1 collect 首次扫描成功
  const scan1 = await collector.collect(origin, cascadeId, {
    force: true,
    authBootstrap: mockAuthBootstrap,
    allowDaemonFallback: false
  });
  assert.equal(scan1.conversation, cascadeId);
  assert.ok(scan1.session);
  assert.equal(scan1.session.isRemote, false);

  // 3.2 令牌轮换后再次 collect（复用旧缓存触发 401 -> 自动从 authBootstrap 刷新并重试成功）
  currentToken = 'collect-tok-2';
  const scan2 = await collector.collect(origin, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', {
    authBootstrap: mockAuthBootstrap,
    allowDaemonFallback: false
  });
  assert.equal(scan2.conversation, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  assert.equal(scan2.session.isRemote, true);
  assert.equal(trajectoryCalls, 2);
  assert.equal(unauthorized401Count, 1, '令牌轮换后应仅触发 1 次 401 并自愈成功');

  // 3.3 fetchQuotaSnapshotFromHost 在 2.34.0 空 HTML 下正常返回额度
  const quotaRes = await collector.fetchQuotaSnapshotFromHost({
    force: true,
    origin,
    authBootstrap: mockAuthBootstrap,
    allowDaemonFallback: false
  });
  assert.equal(quotaRes.ok, true);
  assert.equal(quotaRes.error, null);
  assert.equal(quotaRes._raw?.planStatus?.email, 'quota234@example.com');
  assert.equal(quotaRes.planTierSummary?.planName, 'Pro');
  assert.ok(Array.isArray(quotaRes.cascadeModelConfigs) && quotaRes.cascadeModelConfigs.length === 1);
});

// ============================================================================
// 4. 渲染层在 window.__APP_CONFIG__.csrfToken 为空时回退 localStorage 会话令牌
// ============================================================================

test('渲染层在 2.34.0 空 __APP_CONFIG__.csrfToken 时自动回退 agy_session_csrf_token', () => {
  const rendererSrc = fs.readFileSync(path.join(__dirname, 'src', 'renderer', 'main.js'), 'utf8');
  assert.ok(rendererSrc.includes('function getRendererCsrfToken()'), 'src/renderer/main.js 应包含 getRendererCsrfToken');
  assert.ok(rendererSrc.includes("agy_session_csrf_token"), '应兼容 Antigravity 2.34.0 的 localStorage 会话令牌回退');
  const builtSrc = fs.readFileSync(path.join(__dirname, 'meter-renderer.js'), 'utf8');
  assert.ok(builtSrc.includes('function getRendererCsrfToken()'), '构建产物 meter-renderer.js 必须已同步更新');
});

test('PR #67 回归：2.34.0 标准备份逐字节还原及 2.33.0 升级 2.34.0 重装', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-v234-upgrade-'));
  const prevStateDir = process.env.AG_METER_STATE_DIR;
  process.env.AG_METER_STATE_DIR = path.join(tmpDir, 'state');
  t.after(() => {
    if (prevStateDir === undefined) delete process.env.AG_METER_STATE_DIR;
    else process.env.AG_METER_STATE_DIR = prevStateDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
  const SAMPLE_V233_LEGACY_UTILS = `"use strict";
function setupNodeWrapper(env) {
    return env;
}
function createWindow(url, storageManager, options) {
    void win.loadURL(url);
    return win;
}
`;

  const targetAsar = path.join(tmpDir, 'app.asar');
  const clean234 = await createMockAsar(tmpDir, '2.34.0', SAMPLE_V234_UTILS);
  const clean233 = await createMockAsar(tmpDir, '2.33.0', SAMPLE_V233_LEGACY_UTILS);

  // 1. 2.34.0 安装后执行标准备份还原，验证逐字节 SHA-256 完全一致
  fs.copyFileSync(clean234, targetAsar);
  const orig234Sha = sha256(fs.readFileSync(targetAsar));
  const m234 = await install({ path: targetAsar, pureMeterOnly: true });
  assert.equal(m234.version, '2.34.0');
  const restoreRes = await restore({ path: targetAsar });
  assert.equal(restoreRes.restored, targetAsar);
  assert.equal(sha256(fs.readFileSync(targetAsar)), orig234Sha, '标准备份还原应逐字节恢复原版 2.34.0 ASAR');

  // 2. 模拟宿主从 2.33.0 升级至 2.34.0 后重新安装
  fs.copyFileSync(clean233, targetAsar);
  const mLegacy = await install({ path: targetAsar, pureMeterOnly: true });
  assert.equal(mLegacy.version, '2.33.0');
  const patchedLegacy = builtinAsar.extractFile(targetAsar, 'dist/utils.js').toString('utf8');
  assert.ok(patchedLegacy.includes('installContextMeter(win)'));

  fs.copyFileSync(clean234, targetAsar);
  const mUpgrade = await install({ path: targetAsar, pureMeterOnly: true });
  assert.equal(mUpgrade.version, '2.34.0', '宿主升级至 2.34.0 后重装应识别新版并写入新钩子');
  const patchedUpgrade = builtinAsar.extractFile(targetAsar, 'dist/utils.js').toString('utf8');
  assert.equal(patchedUpgrade.split('installContextMeter(win)').length, 2, '升级重装不得重复注入');
  assert.ok(patchedUpgrade.includes('void loadHubWindowUrl(win, url, { skipBootstrapMint });'));
});

test('Issue #80: macOS ElectronAsarIntegrity 与签名预检及 install 完整性保护门禁', async (t) => {
  const { inspectMacAsarIntegrity } = require('./macos-binary-utils');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-mac-integrity-'));
  const prevStateDir = process.env.AG_METER_STATE_DIR;
  process.env.AG_METER_STATE_DIR = path.join(tmpDir, 'state');
  t.after(() => {
    if (prevStateDir === undefined) delete process.env.AG_METER_STATE_DIR;
    else process.env.AG_METER_STATE_DIR = prevStateDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // 1. 构建模拟 macOS Antigravity.app 目录及含 ElectronAsarIntegrity 的 Info.plist
  const appDir = path.join(tmpDir, 'Antigravity.app');
  const contentsDir = path.join(appDir, 'Contents');
  const resDir = path.join(contentsDir, 'Resources');
  fs.mkdirSync(resDir, { recursive: true });
  const plistPath = path.join(contentsDir, 'Info.plist');
  fs.writeFileSync(plistPath, `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>Antigravity</string>
  <key>ElectronAsarIntegrity</key>
  <dict><key>Resources/app.asar</key><dict><key>algorithm</key><string>SHA256</string><key>hash</key><string>deadbeef</string></dict></dict>
</dict></plist>`, 'utf8');

  const clean234 = await createMockAsar(tmpDir, '2.34.0', SAMPLE_V234_UTILS);
  const macAsarPath = path.join(resDir, 'app.asar');
  fs.copyFileSync(clean234, macAsarPath);

  // 1a. 启用 ElectronAsarIntegrity + codesign 签名：识别 blocked_integrity 与 TeamIdentifier
  const infoBlocked = inspectMacAsarIntegrity(macAsarPath, {
    _platform: 'darwin',
    _execFileSync: () => 'Signature=signed\nTeamIdentifier=EQHXZ8M8AV\nflags=0x10000(runtime)\nSealed Resources version=2'
  });
  assert.equal(infoBlocked.isMacAppBundle, true);
  assert.equal(infoBlocked.hasAsarIntegrity, true);
  assert.equal(infoBlocked.integrityAlgorithm, 'SHA256');
  assert.equal(infoBlocked.signatureStatus, 'signed');
  assert.equal(infoBlocked.teamIdentifier, 'EQHXZ8M8AV');
  assert.equal(infoBlocked.hardenedRuntime, true);
  assert.equal(infoBlocked.patchRisk, 'blocked_integrity');
  assert.equal(infoBlocked.recommendedEntry, 'node cli.js watch');

  // 1b. macOS 上默认 install 必须拒改带 ElectronAsarIntegrity 的 app.asar，推荐使用 watch
  await assert.rejects(
    () => install({ path: macAsarPath, pureMeterOnly: true, _platform: 'darwin' }),
    /ElectronAsarIntegrity.*node cli\.js watch/s
  );

  // 1c. 显式 allowIntegrityOverride (--force-mac-asar) 可在自签场景放行并完成 2.34.0 注入
  const forcedManifest = await install({
    path: macAsarPath,
    pureMeterOnly: true,
    _platform: 'darwin',
    allowIntegrityOverride: true,
    silent: true
  });
  assert.equal(forcedManifest.version, '2.34.0');
  assert.equal(forcedManifest.macAsarIntegrity?.hasAsarIntegrity, true);

  // 2. 移除 ElectronAsarIntegrity 且无签名的 .app 可标记 safe 并允许安装
  fs.writeFileSync(plistPath, `<plist version="1.0"><dict><key>CFBundleExecutable</key><string>Antigravity</string></dict></plist>`, 'utf8');
  const signedOptions = {
    _platform: 'darwin',
    _execFileSync: () => 'Signature=signed\nTeamIdentifier=EQHXZ8M8AV\nSealed Resources version=2'
  };
  const signedArchive = fs.readFileSync(macAsarPath);
  assert.equal(inspectMacAsarIntegrity(macAsarPath, signedOptions).patchRisk, 'blocked_signature');
  await assert.rejects(
    () => install({ path: macAsarPath, pureMeterOnly: true, ...signedOptions }),
    /签名.*node cli\.js watch/s
  );
  assert.deepEqual(fs.readFileSync(macAsarPath), signedArchive);

  const infoSafe = inspectMacAsarIntegrity(macAsarPath, {
    _platform: 'darwin',
    _execFileSync: () => { throw new Error('code object is not signed at all'); }
  });
  assert.equal(infoSafe.hasAsarIntegrity, false);
  assert.equal(infoSafe.signatureStatus, 'unsigned');
  assert.equal(infoSafe.patchRisk, 'safe');
  assert.equal(infoSafe.recommendedEntry, 'node cli.js install');

  // 3. Info.plist 缺失 / 无法读取：标记 unknown_signature 并建议优先 watch
  fs.unlinkSync(plistPath);
  const infoUnknown = inspectMacAsarIntegrity(macAsarPath, {
    _platform: 'darwin',
    _execFileSync: () => ''
  });
  assert.equal(infoUnknown.plistExists, false);
  assert.equal(infoUnknown.hasAsarIntegrity, null);
  assert.equal(infoUnknown.patchRisk, 'unknown_signature');
  assert.equal(infoUnknown.recommendedEntry, 'node cli.js watch');
});


test('Phase 2A & 2B: createWindow 作用域 await win.loadURL 兼容、4阶段诊断、check阻塞、helper平台限制与restore全清', async (t) => {
  const { diagnoseCleanStructure } = require('./modular-installer');
  const { cmdCheck } = require('./cli');

  // 1. 宿主 utils 含辅助函数 invokeWindowLoadUrl 中的 await win.loadURL(url) + createWindow 内的 await win.loadURL(url)
  const awaitCreateWindowUtils = `"use strict";
function setupNodeWrapper(env) { return env; }
async function invokeWindowLoadUrl(win, url) {
  await win.loadURL(url);
}
async function createWindow(url, storageManager, options) {
  const win = {};
  await win.loadURL(url);
  return win;
}
`;
  const target = findWindowLoadHookTarget(awaitCreateWindowUtils);
  assert.ok(target, 'createWindow 内唯一定位 await win.loadURL(url) 时不应与辅助函数冲突');
  assert.equal(target.kind, 'create_window_load_url');
  assert.ok(awaitCreateWindowUtils.slice(target.index).startsWith('  await win.loadURL(url);'));
  assert.equal(diagnoseCleanStructure(awaitCreateWindowUtils).ok, true);

  // 2. 分阶段明确诊断：缺 setupNodeWrapper / 缺加载锚点 / 歧义锚点 / 语法错误
  assert.equal(diagnoseCleanStructure('function createWindow(url){ void win.loadURL(url); }').stage, 'missing_setup_node_wrapper');
  assert.equal(diagnoseCleanStructure('function setupNodeWrapper(env) {}\nfunction createWindow(url) { return null; }').stage, 'missing_window_load_anchor');
  assert.equal(diagnoseCleanStructure('function setupNodeWrapper(env) {}\nfunction createWindow(url) {\n  await win.loadURL(url);\n  await win.loadURL(url);\n}').stage, 'ambiguous_window_load_anchor');
  assert.equal(diagnoseCleanStructure('function setupNodeWrapper(env) {}\nfunction createWindow(url) {\n    void win.loadURL(url);\n  return (;\n}').stage, 'syntax_error');

  // 3. macOS 平台上不得部署 cli-window-helper.exe 至 stateDir 或 Resources/bin
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-phase2ab-'));
  const prevStateDir = process.env.AG_METER_STATE_DIR;
  const macStateDir = path.join(tmpDir, 'state-mac');
  process.env.AG_METER_STATE_DIR = macStateDir;
  t.after(() => {
    if (prevStateDir === undefined) delete process.env.AG_METER_STATE_DIR;
    else process.env.AG_METER_STATE_DIR = prevStateDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const macAppDir = path.join(tmpDir, 'Antigravity.app', 'Contents', 'Resources');
  const macBinDir = path.join(macAppDir, 'bin');
  fs.mkdirSync(macBinDir, { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'Antigravity.app', 'Contents', 'Info.plist'), '<plist><dict><key>CFBundleExecutable</key><string>Antigravity</string></dict></plist>');
  const macAsarPath = path.join(macAppDir, 'app.asar');
  const tmpUnsigned = await createMockAsar(tmpDir, '2.34.0', SAMPLE_V234_UTILS);
  fs.copyFileSync(tmpUnsigned, macAsarPath);
  const resMac = await install({
    path: macAsarPath,
    stateDir: macStateDir,
    pureMeterOnly: true,
    _platform: 'darwin',
    _execFileSync: () => { throw new Error('code object is not signed at all'); },
    noHotInject: true
  });
  assert.equal(resMac.helperSha256, null, '非 Windows 平台不得写入或记录 cli-window-helper.exe');
  assert.equal(fs.existsSync(path.join(macStateDir, 'cli-window-helper.exe')), false);
  assert.equal(fs.existsSync(path.join(macBinDir, 'cli-window-helper.exe')), false);

  // 4. 模拟旧版遗留 Resources/bin/cli-window-helper.exe 并执行原位卸载：确认补全 25 项依赖且残留 .exe 被清理
  fs.writeFileSync(path.join(macBinDir, 'cli-window-helper.exe'), 'stale-exe');
  const restRes = await restore({
    path: macAsarPath,
    inPlace: true,
    _platform: 'darwin',
    _execFileSync: () => { throw new Error('code object is not signed at all'); }
  });
  assert.equal(restRes.inPlaceCleaned, true);
  assert.equal(fs.existsSync(path.join(macBinDir, 'cli-window-helper.exe')), false, 'restore 应清理残留 cli-window-helper.exe');
  for (const mod of ['host-recovery.js', 'meter-cli-monitor.js', 'meter-cli-adapter.js', 'meter-cli-companion.js', 'meter-cli-ui.js']) {
    let exists = true;
    try { builtinAsar.extractFile(macAsarPath, 'dist/' + mod); } catch { exists = false; }
    assert.equal(exists, false, `restore 原位卸载必须清理 dist/${mod}`);
  }

  // 5. macOS 已签名应用禁止 --in-place 重打包写盘，保护原 ASAR SHA-256 不变
  const badAsar = await createMockAsar(tmpDir, '2.34.0', 'function setupNodeWrapper(env) {}');
  const badShaBefore = crypto.createHash('sha256').update(fs.readFileSync(badAsar)).digest('hex');
  await assert.rejects(() => install({ path: badAsar, pureMeterOnly: true, noHotInject: true }), /missing_window_load_anchor/);
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(badAsar)).digest('hex'), badShaBefore, '写前报错不得改动原 ASAR');

  // 6. cmdCheck 在预检被阻断时必须设置非零 exitCode 而非打印通过
  const prevExitCode = process.exitCode;
  await cmdCheck(badAsar, { stateDir: macStateDir, _queryLiveWindow: async () => ({ running: false }) });
  assert.equal(process.exitCode, 1, '结构预检阻塞时 cmdCheck 不得返回 0');
  process.exitCode = prevExitCode;
});

test('macOS --force-mac-asar 安装与还原后按需自动 ad-hoc 重签并复验 .app Bundle', async (t) => {
  const { resignMacAppBundleIfNeeded } = require('./macos-binary-utils');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-mac-resign-'));
  const prevStateDir = process.env.AG_METER_STATE_DIR;
  const stateDir = path.join(tmpDir, 'state');
  process.env.AG_METER_STATE_DIR = stateDir;
  t.after(() => {
    if (prevStateDir === undefined) delete process.env.AG_METER_STATE_DIR;
    else process.env.AG_METER_STATE_DIR = prevStateDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const bundleDir = path.join(tmpDir, 'Antigravity.app');
  const resDir = path.join(bundleDir, 'Contents', 'Resources');
  fs.mkdirSync(resDir, { recursive: true });
  fs.writeFileSync(
    path.join(bundleDir, 'Contents', 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>Antigravity</string>
  <key>ElectronAsarIntegrity</key>
  <dict><key>Resources/app.asar</key><dict><key>algorithm</key><string>SHA256</string><key>hash</key><string>deadbeef</string></dict></dict>
</dict></plist>`,
    'utf8'
  );
  const macAsarPath = path.join(resDir, 'app.asar');
  const cleanAsar = await createMockAsar(tmpDir, '2.35.1', SAMPLE_V234_UTILS);
  fs.copyFileSync(cleanAsar, macAsarPath);

  // 1. 若包体签名当前已通过 verify，则绝不覆盖已有签名
  const alreadyValidCalls = [];
  const resAlreadyValid = resignMacAppBundleIfNeeded(
    macAsarPath,
    { isMacAppBundle: true, appBundlePath: bundleDir, signatureStatus: 'signed', teamIdentifier: 'EQHXZ8M8AV' },
    {
      _platform: 'darwin',
      _execFileSync: (_bin, args) => {
        alreadyValidCalls.push(args);
        return 'valid on disk';
      }
    }
  );
  assert.equal(resAlreadyValid.attempted, false);
  assert.equal(resAlreadyValid.ok, true);
  assert.equal(resAlreadyValid.alreadyValid, true);
  assert.equal(alreadyValidCalls.length, 1);
  assert.equal(alreadyValidCalls[0][0], '--verify');

  // 2. install({ allowIntegrityOverride: true }) 改写 app.asar 后，verify 失败 -> 保留 entitlements 重签 -> verify 通过
  let bundleSignedValid = false;
  const installCalls = [];
  const installMockExec = (_bin, args) => {
    installCalls.push(args);
    if (args[0] === '-dv') {
      return 'Signature=adhoc\nTeamIdentifier=not set\nSealed Resources version=2';
    }
    if (args[0] === '--verify') {
      if (!bundleSignedValid) {
        const err = new Error('a sealed resource is missing or invalid');
        err.stderr = 'a sealed resource is missing or invalid';
        throw err;
      }
      return 'valid on disk';
    }
    if (args[0] === '--force') {
      bundleSignedValid = true;
      return 'replacing existing signature';
    }
    return '';
  };

  const forcedManifest = await install({
    path: macAsarPath,
    stateDir,
    pureMeterOnly: true,
    _platform: 'darwin',
    allowIntegrityOverride: true,
    _execFileSync: installMockExec,
    noHotInject: true,
    silent: true
  });
  assert.equal(forcedManifest.macResign?.attempted, true);
  assert.equal(forcedManifest.macResign?.ok, true);
  assert.equal(forcedManifest.macResign?.verified, true);
  assert.equal(forcedManifest.macResign?.signatureStatus, 'adhoc');
  assert.ok(
    installCalls.some(a => a[0] === '--force' && a.includes('--preserve-metadata=entitlements') && a.includes(bundleDir)),
    '必须在改写 app.asar 后调用 codesign --force --sign - --preserve-metadata=entitlements'
  );

  // 3. restore 还原 app.asar 后同样自动校验并重签
  bundleSignedValid = false;
  const restoreCalls = [];
  const restored = await restore({
    path: macAsarPath,
    _platform: 'darwin',
    allowIntegrityOverride: true,
    _execFileSync: (_bin, args) => {
      restoreCalls.push(args);
      return installMockExec(_bin, args);
    },
    silent: true
  });
  assert.equal(restored.macResign?.attempted, true);
  assert.equal(restored.macResign?.ok, true);
  assert.equal(restored.macResign?.verified, true);
  assert.ok(
    restoreCalls.some(a => a[0] === '--force' && a.includes('--preserve-metadata=entitlements') && a.includes(bundleDir)),
    'restore 还原 app.asar 后同样应自动完成重签并复验'
  );

  // 4. codesign 失败时返回 ok: false 与可执行修复命令，不掩盖异常
  const resFailed = resignMacAppBundleIfNeeded(
    macAsarPath,
    { isMacAppBundle: true, appBundlePath: bundleDir, signatureStatus: 'signed', teamIdentifier: 'EQHXZ8M8AV' },
    {
      _platform: 'darwin',
      _execFileSync: (_bin, args) => {
        if (args[0] === '--verify') throw new Error('sealed resource invalid');
        throw new Error('permission denied');
      }
    }
  );
  assert.equal(resFailed.attempted, true);
  assert.equal(resFailed.ok, false);
  assert.match(resFailed.error, /permission denied/);
  assert.match(resFailed.manualCmd, /codesign --force --sign - --preserve-metadata=entitlements/);
});

// ============================================================================
// 5. 远程服务器（SSH Hub）连接场景下的额度获取、会话扫描与多级回退
// ============================================================================

test('远程 SSH 窗口：空 HTML csrfToken 且与本机 authBootstrap 端口不同时，通过渲染层令牌解析与 401 轮换自愈完成额度与扫描', async (t) => {
  let remoteToken = 'remote-ssh-tok-1';
  let remoteQuotaHits = 0;
  const cascadeId = '22222222-3333-4444-5555-666666666666';

  const remoteServer = http.createServer((req, res) => {
    if (req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<script>window.__APP_CONFIG__ = {"productName":"antigravity","csrfToken":"","appVersion":"2.35.2"};</script>');
      return;
    }
    if (req.headers['x-codeium-csrf-token'] !== remoteToken) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    if (req.url.includes('/GetUserStatus')) {
      remoteQuotaHits++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        userStatus: {
          email: 'remote-user@example.com',
          userTier: { id: 'g1-pro-tier', name: 'Google AI Pro' },
          planStatus: { planInfo: { planName: 'Pro', teamsTier: 'TEAMS_TIER_PRO' } },
          cascadeModelConfigData: {
            clientModelConfigs: [{
              label: 'Gemini 4 Neon (High)',
              modelOrAlias: { model: 'MODEL_PLACEHOLDER_M701' },
              quotaInfo: { remainingFraction: 0.76, resetTime: '2026-12-01T00:00:00Z' }
            }]
          }
        }
      }));
      return;
    }
    if (req.url.includes('/RetrieveUserQuotaSummary')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ response: { groups: [] } }));
      return;
    }
    if (req.url.endsWith('/GetCascadeTrajectory')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        numTotalSteps: 1,
        trajectory: {
          metadata: { workspaceUris: ['vscode-remote://ssh-remote+dev-box/data/repo'] },
          steps: [{ type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { items: [{ text: 'hello remote' }] } }]
        }
      }));
      return;
    }
    if (req.url.endsWith('/GetCascadeTrajectoryGeneratorMetadata')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ generatorMetadata: [] }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise(r => remoteServer.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => remoteServer.close(r)));
  const remotePort = remoteServer.address().port;
  const remoteOrigin = `http://127.0.0.1:${remotePort}`;

  // 模拟本机 authBootstrap 指向另一个完全不同的本地端口
  const localOnlyAuthBootstrap = {
    getActiveLsBaseUrl: () => `http://127.0.0.1:${remotePort + 10}`,
    getActiveLsCsrfToken: () => 'local-machine-token-must-not-leak'
  };

  collector.resetQuotaHostCacheForTest();
  const quotaRes = await collector.fetchQuotaSnapshotFromHost({
    force: true,
    origin: remoteOrigin,
    authBootstrap: localOnlyAuthBootstrap,
    allowDaemonFallback: false,
    resolveCsrfToken: async (origin) => (origin === remoteOrigin ? remoteToken : null)
  });
  assert.equal(quotaRes.ok, true);
  assert.equal(quotaRes.error, null);
  assert.equal(quotaRes.email, 'remote-user@example.com');
  assert.equal(remoteQuotaHits, 1);

  // 令牌轮换后，collect 也应通过 resolveCsrfToken 正常扫描并标注 isRemote=true
  remoteToken = 'remote-ssh-tok-2';
  const scanRes = await collector.collect(remoteOrigin, cascadeId, {
    force: true,
    authBootstrap: localOnlyAuthBootstrap,
    allowDaemonFallback: false,
    resolveCsrfToken: async (origin) => (origin === remoteOrigin ? remoteToken : null)
  });
  assert.equal(scanRes.conversation, cascadeId);
  assert.equal(scanRes.session.isRemote, true);
});

test('远程 SSH 窗口：远端 LS 无法返回额度或需同源 Cookie 时，依次通过 rendererRpcFetcher 与本机宿主/ls_*.json 安全回退且不跨端口泄露令牌', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-remote-fallback-'));
  const daemonDir = path.join(tmpDir, 'daemon');
  fs.mkdirSync(daemonDir, { recursive: true });
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const observedLocalTokens = [];
  const observedRemoteTokens = [];

  // 1) 远程服务器模拟：返回 200 但 GetUserStatus/RetrieveUserQuotaSummary 均返回空配额（或 401）
  let remoteMode = 'empty';
  const remoteServer = http.createServer((req, res) => {
    if (req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<script>window.__APP_CONFIG__ = {"csrfToken":""};</script>');
      return;
    }
    observedRemoteTokens.push(req.headers['x-codeium-csrf-token'] || '');
    if (remoteMode === 'unauthorized') {
      res.writeHead(401);
      res.end('unauthorized');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({}));
  });
  await new Promise(r => remoteServer.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => remoteServer.close(r)));
  const remoteOrigin = `http://127.0.0.1:${remoteServer.address().port}`;

  // 2) 本机宿主 daemon ls_*.json 模拟（携带本机完整额度）
  const localServer = http.createServer((req, res) => {
    if (req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<script>window.__APP_CONFIG__ = {"csrfToken":""};</script>');
      return;
    }
    observedLocalTokens.push(req.headers['x-codeium-csrf-token'] || '');
    if (req.headers['x-codeium-csrf-token'] !== 'local-ls-daemon-csrf') {
      res.writeHead(401);
      res.end('unauthorized');
      return;
    }
    if (req.url.includes('/GetUserStatus')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        userStatus: {
          email: 'local-host-fallback@example.com',
          userTier: { id: 'g1-pro-tier', name: 'Google AI Pro' },
          planStatus: { planInfo: { planName: 'Pro', teamsTier: 'TEAMS_TIER_PRO' } },
          cascadeModelConfigData: {
            clientModelConfigs: [{
              label: 'Gemini 4 Neon (High)',
              modelOrAlias: { model: 'MODEL_PLACEHOLDER_M701' },
              quotaInfo: { remainingFraction: 0.91, resetTime: '2026-12-01T00:00:00Z' }
            }]
          }
        }
      }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ response: { groups: [] } }));
  });
  await new Promise(r => localServer.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => localServer.close(r)));
  const localPort = localServer.address().port;

  fs.writeFileSync(
    path.join(daemonDir, 'ls_14b5b8b4e06bc747.json'),
    JSON.stringify({ pid: 556677, httpPort: localPort, csrfToken: 'local-ls-daemon-csrf' })
  );

  // 验证 discoverLiveDaemonHubs 识别 ls_*.json
  const discovered = localApi.discoverLiveDaemonHubs({ daemonDir, isPidAlive: pid => pid === 556677 });
  assert.equal(discovered.length, 1);
  assert.equal(discovered[0].origin, `http://127.0.0.1:${localPort}`);
  assert.equal(discovered[0].kind, 'ls');

  // 场景 A：远端返回空对象 -> 自动回退本机 ls_*.json 并成功获取真实额度，且远程 Token 绝不发送给本机端口
  collector.resetQuotaHostCacheForTest();
  const fallbackRes = await collector.fetchQuotaSnapshotFromHost({
    force: true,
    origin: remoteOrigin,
    csrfToken: 'remote-only-secret-token',
    authBootstrap: null,
    daemonDir,
    isPidAlive: pid => pid === 556677,
    allowHostOriginFallback: true
  });
  assert.equal(fallbackRes.ok, true);
  assert.equal(fallbackRes.email, 'local-host-fallback@example.com');
  assert.ok(fallbackRes.cascadeModelConfigs.length === 1);
  assert.ok(observedLocalTokens.every(tok => tok === 'local-ls-daemon-csrf'), '本机端口绝不得收到远程窗口令牌');
  assert.ok(observedRemoteTokens.every(tok => tok !== 'local-ls-daemon-csrf'), '远程端口绝不得收到本机宿主令牌');

  // 场景 B：Node 直连远端 401（如仅浏览器携带 HttpOnly Cookie），rendererRpcFetcher 同源拉取成功
  remoteMode = 'unauthorized';
  collector.resetQuotaHostCacheForTest();
  const rendererRes = await collector.fetchQuotaSnapshotFromHost({
    force: true,
    origin: remoteOrigin,
    csrfToken: 'stale-or-cookie-only',
    authBootstrap: null,
    allowDaemonFallback: false,
    allowHostOriginFallback: false,
    rendererRpcFetcher: async (origin) => {
      assert.equal(origin, remoteOrigin);
      return {
        userStatusRes: {
          userStatus: {
            email: 'cookie-session@example.com',
            cascadeModelConfigData: {
              clientModelConfigs: [{
                label: 'Gemini 4 Neon (High)',
                modelOrAlias: { model: 'MODEL_PLACEHOLDER_M701' },
                quotaInfo: { remainingFraction: 0.64, resetTime: '2026-12-01T00:00:00Z' }
              }]
            }
          }
        },
        quotaSummaryRes: { response: { groups: [] } }
      };
    }
  });
  assert.equal(rendererRes.ok, true);
  assert.equal(rendererRes.email, 'cookie-session@example.com');
});

test('meter-main IPC 与 live-host 兼容 localhost 远程回环窗口并安全注入渲染层鉴权与宿主回退选项', async (t) => {
  const { registerMeterIpcHandlers } = require('./meter-main');
  const handlers = new Map();
  registerMeterIpcHandlers({ handle: (channel, handler) => handlers.set(channel, handler) });
  const getQuota = handlers.get('context-meter:get-quota');

  let capturedOpts = null;
  t.mock.method(collector, 'fetchQuotaSnapshotFromHost', async (opts) => {
    capturedOpts = opts;
    return { ok: true, error: null, email: 'ssh@example.com', fetchedAtMs: Date.now(), snapshot: { pools: [] } };
  });
  t.mock.method(require('./meter-accounts'), 'getSharedAccountsManager', () => ({
    syncActiveHostQuotaSnapshot: () => {},
    detectCurrentActiveAccount: async () => ({ email: 'ssh@example.com' }),
    getOverviewState: () => ({})
  }));

  const remoteOrigin = 'http://localhost:59123';
  const frame = { url: `${remoteOrigin}/c/11111111-2222-3333-4444-555555555555` };
  const event = {
    senderFrame: frame,
    sender: {
      mainFrame: frame,
      getURL: () => frame.url,
      isDestroyed: () => false,
      executeJavaScript: async (code) => {
        if (code.includes('RetrieveUserQuotaSummary')) return null;
        return 'sender-live-csrf-token';
      }
    }
  };

  const res = await getQuota(event, { force: true, origin: 'http://127.0.0.1:9999', userStatus: { fake: true } });
  assert.equal(res.ok, true);
  assert.equal(capturedOpts.origin, remoteOrigin);
  assert.equal('userStatus' in capturedOpts, false);
  assert.equal(capturedOpts.allowHostOriginFallback, true);
  assert.equal(typeof capturedOpts.resolveCsrfToken, 'function');
  assert.equal(typeof capturedOpts.rendererRpcFetcher, 'function');
  assert.equal(await capturedOpts.resolveCsrfToken(remoteOrigin), 'sender-live-csrf-token');
  assert.equal(await capturedOpts.resolveCsrfToken('http://127.0.0.1:41234'), null, 'resolveCsrfToken 严禁跨 origin 返回令牌');
});

test('Issues #109 & #116: 非默认安装路径探测、自定义路径持久化校验、.unpacked 透传与原生设置入口', async (t) => {
  const {
    normalizeAsarPathCandidate,
    getSavedCustomAsarPath,
    probeInstalledAsarPaths,
    findAsarPath
  } = require('./asar-engine');
  const collector = require('./meter-collector');
  const contextSettingsUi = require('./src/renderer/context-settings-ui');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-custom-path-'));
  const prevAgAsar = process.env.AG_ASAR_PATH;
  delete process.env.AG_ASAR_PATH;
  t.after(() => {
    if (prevAgAsar === undefined) delete process.env.AG_ASAR_PATH;
    else process.env.AG_ASAR_PATH = prevAgAsar;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // 1. 构造非默认盘/自定义安装目录及 .unpacked 文件
  const customRoot = path.join(tmpDir, 'CustomDriveApps', 'Antigravity');
  const customRes = path.join(customRoot, 'resources');
  const customUnpacked = path.join(customRes, 'app.asar.unpacked', 'node_modules', 'native.txt');
  fs.mkdirSync(path.dirname(customUnpacked), { recursive: true });
  fs.writeFileSync(customUnpacked, 'NATIVE_UNPACKED_OK', 'utf8');
  const fakeExe = path.join(customRoot, 'Antigravity.exe');
  fs.writeFileSync(fakeExe, 'stub', 'utf8');

  const packSrc = path.join(tmpDir, 'pack-src');
  fs.mkdirSync(path.join(packSrc, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(packSrc, 'package.json'), '{"name":"antigravity","version":"2.35.2"}', 'utf8');
  fs.writeFileSync(path.join(packSrc, 'node_modules', 'native.txt'), 'NATIVE_UNPACKED_OK', 'utf8');
  const customAsar = path.join(customRes, 'app.asar');
  await builtinAsar.createPackageWithOptions(packSrc, customAsar, {
    unpackedPaths: new Set(['node_modules/native.txt'])
  });
  // 将备份复制到独立目录，验证 .unpacked 回退可透传 fallbackAsarPath / 已保存自定义路径
  const bakDir = path.join(tmpDir, 'backups');
  fs.mkdirSync(bakDir, { recursive: true });
  const bakAsar = path.join(bakDir, 'app.asar.bak');
  fs.copyFileSync(customAsar, bakAsar);

  assert.equal(normalizeAsarPathCandidate(customRoot), customAsar);
  assert.equal(normalizeAsarPathCandidate(customRes), customAsar);
  assert.equal(normalizeAsarPathCandidate(fakeExe), customAsar);
  assert.equal(normalizeAsarPathCandidate(customAsar), customAsar);
  assert.equal(normalizeAsarPathCandidate(path.join(tmpDir, 'missing-dir')), null);

  // 2. .unpacked 透传 fallbackAsarPath 与 AG_ASAR_PATH
  const extractedViaOpt = builtinAsar.extractFile(bakAsar, 'node_modules/native.txt', { fallbackAsarPath: customAsar });
  assert.equal(extractedViaOpt.toString('utf8'), 'NATIVE_UNPACKED_OK');

  // 3. 系统进程/注册表兜底探测（当默认路径不存在时）
  const emptyHome = path.join(tmpDir, 'empty-home');
  fs.mkdirSync(emptyHome, { recursive: true });
  const probedPath = probeInstalledAsarPaths({ _probeSystemPaths: () => [`"${fakeExe}",0`] });
  assert.equal(probedPath, customAsar);
  const foundViaProbe = findAsarPath(null, {
    homeDir: emptyHome,
    agDir: emptyHome,
    platform: 'linux',
    _probeSystemPaths: () => [customRoot]
  });
  assert.equal(foundViaProbe, customAsar);

  // 4. collector 持久化校验与清除
  const agDir = path.join(tmpDir, 'ag-state');
  fs.mkdirSync(agDir, { recursive: true });
  const badSave = collector.savePluginSettings({ customInstallPath: path.join(tmpDir, 'not-exist') }, { targetDir: agDir });
  assert.equal(badSave.ok, false);

  const okSave = collector.savePluginSettings({ customInstallPath: customRoot }, { targetDir: agDir });
  assert.equal(okSave.ok, true);
  assert.equal(collector.getPluginSettings({ targetDir: agDir }).customInstallPath, customAsar);
  assert.equal(getSavedCustomAsarPath({ agDir }), customAsar);
  assert.equal(findAsarPath(null, { homeDir: emptyHome, agDir, platform: 'linux', disableSystemProbe: true }), customAsar);

  const clearSave = collector.savePluginSettings({ customInstallPath: '' }, { targetDir: agDir });
  assert.equal(clearSave.ok, true);
  assert.equal(collector.getPluginSettings({ targetDir: agDir }).customInstallPath, '');
  assert.equal(getSavedCustomAsarPath({ agDir }), null);

  // 5. 原生宿主设置页渲染与保存/清除动作载荷
  const nsHtml = contextSettingsUi.buildNativeSettingsPageHtml();
  assert.match(nsHtml, /id="ag-ns-input-customInstallPath"/);
  assert.match(nsHtml, /data-ag-ns-action="applyCustomInstallPath"/);
  assert.match(nsHtml, /data-ag-ns-action="clearCustomInstallPath"/);
});
