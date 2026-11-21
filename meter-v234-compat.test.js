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

  // 3.2 令牌轮换后再次 collect（复用旧缓存触发 401 -> 自动从 authBootstrap 刷新并重试成功）
  currentToken = 'collect-tok-2';
  const scan2 = await collector.collect(origin, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', {
    authBootstrap: mockAuthBootstrap,
    allowDaemonFallback: false
  });
  assert.equal(scan2.conversation, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
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
