'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);

const { getAppDataDir, getStateDir, loadAsarEngine } = require('./asar-engine');
const {
  HANS_CANDIDATE_PORTS,
  parseExplicitPort,
  getDevToolsActivePort,
  getCandidateCdpPorts,
  discoverAntigravityCdp,
  connectCdpWebSocket,
  createCdpClient
} = require('./local-api');
const {
  DEFAULT_CONFIG,
  VALID_DISPLAY_MODES,
  getEffectiveDisplayMode,
  readWatchConfigSnapshot,
  loadModulesConfig,
  saveModulesConfig,
  detectAndMigrateLegacyConfigs
} = require('./modules-config');
const { getProxyCandidatePaths } = require('./meter-proxy');
const { generateChinesePreloadCode, TAGS } = require('./modular-installer');
const { install } = require('./install');
const { runWatchDaemon, stopWatchDaemon, getWatchPidPath } = require('./cli');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function encodeServerTextFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.allocUnsafe(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

/**
 * 启动一个模拟未开启 --remote-allow-origins=* 的 Chromium CDP HTTP+WS 本地服务器：
 * 只要 WebSocket Upgrade 请求携带 Origin 头即返回 403 Forbidden；不携带 Origin 头则正常完成握手与协议交互。
 */
async function startStrictOriginCdpServer(initialState = {}) {
  const state = {
    windowOpen: initialState.windowOpen !== false,
    meterActive: Boolean(initialState.meterActive),
    hasIpcBridge: Boolean(initialState.hasIpcBridge),
    originRejections: 0,
    acceptedUpgrades: 0,
    lastUpgradeHeaders: null,
    evaluatedExpressions: [],
    disposeCalls: 0,
    injectCalls: 0
  };

  const sockets = new Set();
  const server = http.createServer((req, res) => {
    if (req.url === '/json/list' || req.url === '/json') {
      if (!state.windowOpen) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([]));
        return;
      }
      const addr = server.address();
      const port = addr.port;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([
        {
          id: 'devtools-1',
          type: 'other',
          title: 'DevTools',
          url: 'devtools://devtools/bundled/inspector.html',
          webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/devtools-1`
        },
        {
          id: 'page-ag-1',
          type: 'page',
          title: 'Antigravity',
          url: 'https://127.0.0.1:54123/workbench.html',
          webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/page-ag-1`
        }
      ]));
      return;
    }
    res.writeHead(404);
    res.end('Not Found');
  });

  server.on('connection', sock => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
  });

  server.on('upgrade', (req, socket) => {
    state.lastUpgradeHeaders = { ...req.headers };
    if (Object.prototype.hasOwnProperty.call(req.headers, 'origin')) {
      state.originRejections++;
      socket.write(
        'HTTP/1.1 403 Forbidden\r\n' +
        'Content-Type: text/plain\r\n' +
        'Content-Length: 43\r\n' +
        'Connection: close\r\n\r\n' +
        'Rejected an incoming WebSocket connection.\n'
      );
      socket.destroy();
      return;
    }

    state.acceptedUpgrades++;
    const key = req.headers['sec-websocket-key'];
    const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );

    let rx = Buffer.alloc(0);
    socket.on('data', chunk => {
      rx = rx.length === 0 ? chunk : Buffer.concat([rx, chunk]);
      while (rx.length >= 2) {
        const opcode = rx[0] & 0x0f;
        const masked = (rx[1] & 0x80) !== 0;
        let len = rx[1] & 0x7f;
        let off = 2;
        if (len === 126) {
          if (rx.length < 4) return;
          len = rx.readUInt16BE(2);
          off = 4;
        } else if (len === 127) {
          if (rx.length < 10) return;
          len = Number(rx.readBigUInt64BE(2));
          off = 10;
        }
        let mask = null;
        if (masked) {
          if (rx.length < off + 4) return;
          mask = rx.subarray(off, off + 4);
          off += 4;
        }
        if (rx.length < off + len) return;

        const payload = Buffer.from(rx.subarray(off, off + len));
        rx = rx.subarray(off + len);
        if (mask) {
          for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
        }

        if (opcode === 0x8) {
          try { socket.end(); } catch {}
          return;
        }
        if (opcode !== 0x1) continue;

        const msg = JSON.parse(payload.toString('utf8'));
        if (msg.method === 'Runtime.evaluate') {
          const expr = String(msg.params?.expression || '');
          state.evaluatedExpressions.push(expr);
          let value;
          if (expr === 'Boolean(window.__AGContextMeter)') {
            value = state.meterActive;
          } else if (expr.includes('hasIpcBridge: Boolean(window.contextMeterAPI?.scan)')) {
            value = { active: state.meterActive, hasIpcBridge: state.hasIpcBridge };
          } else if (expr.includes('window.__AGContextMeter?.dispose()')) {
            state.disposeCalls++;
            state.meterActive = false;
            value = true;
          } else if (expr.startsWith('BIG_PAYLOAD_LEN:')) {
            value = expr.length;
          } else if (expr.length > 50000) {
            // 模拟 meter-core.js + meter-renderer.js 热注入包执行成功
            state.injectCalls++;
            state.meterActive = true;
            value = true;
          } else if (expr.includes('window.__AGContextMeter?.snapshot()')) {
            value = { version: '0.8.2', badge: '12%', widgets: state.meterActive ? 1 : 0 };
          } else if (expr.includes('hasCore:')) {
            value = {
              url: 'https://127.0.0.1:54123/workbench.html',
              title: 'Antigravity',
              readyState: 'complete',
              hasCore: true,
              hasMeter: state.meterActive,
              meterVersion: '0.8.2',
              hasIpcBridge: state.hasIpcBridge,
              badgeExists: state.meterActive,
              badgeVisible: state.meterActive,
              badgeText: '12%',
              badgeTitle: 'Context Meter',
              snapshot: { latest: { percent: 12 } }
            };
          } else {
            value = { echoed: expr.slice(0, 64) };
          }

          const reply = JSON.stringify({
            id: msg.id,
            result: { result: { type: typeof value, value } }
          });
          socket.write(encodeServerTextFrame(reply));
        } else {
          socket.write(encodeServerTextFrame(JSON.stringify({ id: msg.id, result: {} })));
        }
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', err => (err ? reject(err) : resolve()));
  });

  const port = server.address().port;
  return {
    port,
    wsUrl: `ws://127.0.0.1:${port}/devtools/page/page-ag-1`,
    state,
    async close() {
      for (const s of sockets) {
        try { s.destroy(); } catch {}
      }
      await new Promise(resolve => server.close(() => resolve()));
    }
  };
}

test('macOS 跨平台路径统一：AppData、状态目录、旧配置迁移与代理探测路径均指向 Application Support', () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-mac-paths-'));
  const prevStateEnv = process.env.AG_METER_STATE_DIR;
  try {
    assert.equal(
      getAppDataDir({ platform: 'darwin', homeDir: tmpHome, env: {} }),
      path.join(tmpHome, 'Library', 'Application Support')
    );

    if (process.platform === 'darwin') {
      delete process.env.AG_METER_STATE_DIR;
      assert.equal(
        getStateDir(),
        path.join(os.homedir(), 'Library', 'Application Support', 'AntigravityContextMeter')
      );
      const proxyPaths = getProxyCandidatePaths();
      assert.ok(
        proxyPaths.includes(path.join(os.homedir(), 'Library', 'Application Support', 'AntigravityContextMeter', 'modules.json')),
        'macOS 代理配置探测必须包含 ~/Library/Application Support/AntigravityContextMeter/modules.json'
      );
    }

    // 验证 detectAndMigrateLegacyConfigs 在 macOS 下从 ~/Library/Application Support 读取历史配置
    const legacyProxyDir = path.join(tmpHome, 'Library', 'Application Support', 'AntigravityProxyNoTun');
    const legacyChineseDir = path.join(tmpHome, 'Library', 'Application Support', 'AntigravityChinese');
    fs.mkdirSync(legacyProxyDir, { recursive: true });
    fs.mkdirSync(legacyChineseDir, { recursive: true });
    fs.writeFileSync(path.join(legacyProxyDir, 'config.json'), JSON.stringify({ enabled: true, proxyUrl: 'http://127.0.0.1:7890' }));
    fs.writeFileSync(path.join(legacyChineseDir, 'config.json'), JSON.stringify({ enabled: true }));

    process.env.AG_METER_STATE_DIR = path.join(tmpHome, 'isolated-state');
    const migrated = detectAndMigrateLegacyConfigs({ homeDir: tmpHome, platform: 'darwin' });
    assert.ok(migrated.proxy, '必须识别 macOS Application Support 下的旧代理配置');
    assert.equal(migrated.proxy.proxyUrl, 'http://127.0.0.1:7890');
    assert.ok(migrated.chinese?.detected, '必须识别 macOS Application Support 下的旧汉化配置');
  } finally {
    if (prevStateEnv !== undefined) process.env.AG_METER_STATE_DIR = prevStateEnv;
    else delete process.env.AG_METER_STATE_DIR;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('CDP 端口发现优先级：显式端口 > Antigravity-Hans 58321..58325 > DevToolsActivePort，且测试模式严格隔离', async () => {
  assert.deepEqual(HANS_CANDIDATE_PORTS, [58321, 58322, 58323, 58324, 58325]);

  // 1. 测试模式默认绝不触碰宿主机真实端口与真实 AppData
  assert.deepEqual(getCandidateCdpPorts({ argv: ['node', 'cli.js'], env: {} }), []);

  // 2. 验证完整优先级顺序：(a) --port / AG_CDP_PORT -> (b) 58321..58325 -> (c) DevToolsActivePort
  const tmpAppSupport = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-devtools-port-'));
  try {
    const agDir = path.join(tmpAppSupport, 'Antigravity');
    fs.mkdirSync(agDir, { recursive: true });
    fs.writeFileSync(path.join(agDir, 'DevToolsActivePort'), '61234\n/devtools/browser/mock-uuid\n', 'utf8');

    assert.equal(getDevToolsActivePort({ appDataDir: tmpAppSupport }), 61234);
    assert.equal(parseExplicitPort({ argv: ['node', 'cli.js', 'watch', '--port', '59001'], env: { AG_CDP_PORT: '59002' } }), 59001);
    assert.equal(parseExplicitPort({ argv: ['node', 'cli.js', 'watch'], env: { AG_CDP_PORT: '59002' } }), 59002);

    const orderedPorts = getCandidateCdpPorts({
      testMode: false,
      appDataDir: tmpAppSupport,
      argv: ['node', 'cli.js', 'watch', '--port', '59001'],
      env: {}
    });
    assert.deepEqual(orderedPorts, [59001, 58321, 58322, 58323, 58324, 58325, 61234]);

    // 3. 模拟 58321 被非 Antigravity 占用、58322 承载真实 Antigravity 页面 (https://127.0.0.1:<port>/)
    const probedUrls = [];
    const discovered = await discoverAntigravityCdp({
      appDataDir: tmpAppSupport,
      argv: ['node', 'cli.js'],
      env: {},
      _httpGetJson: async url => {
        probedUrls.push(url);
        if (url.includes(':58321/')) {
          return [{ type: 'page', url: 'http://localhost:3000/other-app', webSocketDebuggerUrl: 'ws://127.0.0.1:58321/1' }];
        }
        if (url.includes(':58322/')) {
          return [
            { type: 'other', url: 'devtools://devtools/bundled/inspector.html', webSocketDebuggerUrl: 'ws://127.0.0.1:58322/dev' },
            { type: 'page', url: 'https://127.0.0.1:51888/workbench.html', webSocketDebuggerUrl: 'ws://127.0.0.1:58322/ag' }
          ];
        }
        throw new Error('ECONNREFUSED');
      }
    });

    assert.equal(discovered.running, true);
    assert.equal(discovered.pageFound, true);
    assert.equal(discovered.port, 58322);
    assert.equal(discovered.origin, 'https://127.0.0.1:51888');
    assert.equal(discovered.targets.length, 1);
    assert.deepEqual(probedUrls, [
      'http://127.0.0.1:58321/json/list',
      'http://127.0.0.1:58322/json/list'
    ]);
  } finally {
    fs.rmSync(tmpAppSupport, { recursive: true, force: true });
  }
});

test('Origin-less WebSocket CDP 客户端：带 Origin 头被 403 拦截时，零依赖客户端省略 Origin 成功连接并支持 >500KB 帧', async () => {
  const mockCdp = await startStrictOriginCdpServer({ windowOpen: true, meterActive: true, hasIpcBridge: true });
  try {
    // 1. 携带 Origin 请求头时，模拟服务端严格返回 HTTP 403 Forbidden
    await assert.rejects(
      () => connectCdpWebSocket(mockCdp.wsUrl, { _testOriginHeader: 'http://127.0.0.1' }),
      /HTTP 403/
    );
    assert.equal(mockCdp.state.originRejections, 1);

    // 2. 默认不带 Origin 请求头时，握手与超大帧 (>500KB, 64-bit length) 评估完全通过
    const client = await createCdpClient(mockCdp.wsUrl);
    try {
      assert.equal(Object.prototype.hasOwnProperty.call(mockCdp.state.lastUpgradeHeaders, 'origin'), false, '绝不能发送 Origin 请求头');
      const largeExpr = 'BIG_PAYLOAD_LEN:' + 'x'.repeat(520 * 1024);
      const echoedLen = await client.evaluateValue(largeExpr, { timeoutMs: 5000 });
      assert.equal(echoedLen, largeExpr.length);
    } finally {
      client.close();
    }

    // 3. 验证 runtime-check.js 同样通过无 Origin 客户端完成运行态巡检（异步调用避免阻塞当前进程的 mockCdp 事件循环）
    const { stdout: rtOut } = await execFileAsync(
      process.execPath,
      [path.join(__dirname, 'runtime-check.js'), '--port', String(mockCdp.port)],
      { env: { ...process.env, AG_METER_TEST_MODE: '1', NODE_ENV: 'test' }, encoding: 'utf8' }
    );
    const rtParsed = JSON.parse(rtOut);
    assert.ok('version' in rtParsed);
  } finally {
    await mockCdp.close();
  }
});

test('共享 displayMode 配置契约：默认 topbar、无副作用读取、支持 topbar/sidebar/both 且保留扩展字段', () => {
  const tmpState = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-display-mode-'));
  const prevStateEnv = process.env.AG_METER_STATE_DIR;
  process.env.AG_METER_STATE_DIR = tmpState;

  try {
    assert.deepEqual(VALID_DISPLAY_MODES, ['topbar', 'sidebar', 'both']);
    assert.equal(DEFAULT_CONFIG.displayMode, 'topbar');
    assert.equal(DEFAULT_CONFIG.modules.meter.enabled, true);
    assert.equal(DEFAULT_CONFIG.modules.chinese.enabled, false);
    assert.equal(DEFAULT_CONFIG.modules.proxy.enabled, false);

    const cfgPath = path.join(tmpState, 'modules.json');
    // modules.json 不存在时默认返回 topbar 且不产生落盘副作用
    assert.equal(getEffectiveDisplayMode(cfgPath), 'topbar');
    assert.equal(fs.existsSync(cfgPath), false);

    // 写入外部协同字段 (如官方侧栏扩展或启动器写入的扩展属性)
    fs.writeFileSync(cfgPath, JSON.stringify({
      displayMode: 'sidebar',
      launcherNote: 'managed-by-hans',
      modules: { meter: { enabled: true } }
    }, null, 2));
    assert.equal(getEffectiveDisplayMode(cfgPath), 'sidebar');
    assert.deepEqual(readWatchConfigSnapshot(cfgPath), { displayMode: 'sidebar', meterEnabled: true });

    const loaded = loadModulesConfig();
    assert.equal(loaded.displayMode, 'sidebar');
    assert.equal(loaded.launcherNote, 'managed-by-hans', '必须保留其他协同组件写入的顶层字段');
    assert.equal(loaded.modules.chinese.enabled, false);
    assert.equal(loaded.modules.proxy.enabled, false);

    // 非法值回退为默认 topbar
    saveModulesConfig({ ...loaded, displayMode: 'invalid-mode' });
    assert.equal(getEffectiveDisplayMode(cfgPath), 'topbar');
    assert.equal(loadModulesConfig().displayMode, 'topbar');

    saveModulesConfig({ ...loaded, displayMode: 'both' });
    assert.equal(getEffectiveDisplayMode(cfgPath), 'both');
  } finally {
    if (prevStateEnv !== undefined) process.env.AG_METER_STATE_DIR = prevStateEnv;
    else delete process.env.AG_METER_STATE_DIR;
    fs.rmSync(tmpState, { recursive: true, force: true });
  }
});

test('watch / stop-watch 守护生命周期：单实例锁、topbar/both 热注入、sidebar 动态卸载及连续 3 次失联自动退出', async () => {
  const tmpState = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-watch-lifecycle-'));
  const prevStateEnv = process.env.AG_METER_STATE_DIR;
  process.env.AG_METER_STATE_DIR = tmpState;

  // 创建一个轻量隔离的模拟 live-host 脚本（写入 .live-session.json 并保持存活直到收到 SIGTERM）
  const mockLiveHostScript = path.join(tmpState, 'mock-live-host.js');
  fs.writeFileSync(mockLiveHostScript, `'use strict';
const fs = require('fs');
const path = require('path');
const stateDir = process.env.AG_METER_STATE_DIR;
fs.mkdirSync(stateDir, { recursive: true });
fs.writeFileSync(path.join(stateDir, '.live-session.json'), JSON.stringify({
  pid: process.pid,
  origin: 'https://127.0.0.1:54123',
  port: 59999
}));
setInterval(() => {}, 1000);
process.on('SIGTERM', () => process.exit(0));
`, 'utf8');

  const mockCdp = await startStrictOriginCdpServer({
    windowOpen: true,
    meterActive: false,
    hasIpcBridge: false
  });

  try {
    // 1. 验证单实例 PID 锁：已有存活进程持有 watch.pid 时，新 watch 实例立即干净返回 alreadyRunning
    const dummyHolder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    try {
      const pidPath = getWatchPidPath(tmpState);
      fs.writeFileSync(pidPath, `${dummyHolder.pid}\n`, 'utf8');
      const dupRes = await runWatchDaemon({
        stateDir: tmpState,
        port: mockCdp.port,
        silent: true,
        handleSignals: false
      });
      assert.equal(dupRes.ok, true);
      assert.equal(dupRes.alreadyRunning, true);
      assert.equal(dupRes.pid, dummyHolder.pid);
    } finally {
      try { dummyHolder.kill('SIGTERM'); } catch {}
      try { fs.unlinkSync(getWatchPidPath(tmpState)); } catch {}
    }

    // 2. 验证完整状态机：
    //    第 1 轮 (默认 topbar，无 modules.json) -> 自动拉起 live-host 并执行热挂载 (injectedCount = 1)
    //    第 2 轮 (模拟页面刷新 meterActive=false) -> 自动重新热挂载 (injectedCount = 2)
    //    第 3 轮 (切换 displayMode='sidebar') -> 自动调用 dispose() 卸载顶栏并停止 live-host (disposedCount = 1)
    //    第 4 轮 (切换 displayMode='both') -> 重新挂载顶栏 (injectedCount = 3)
    //    第 5..7 轮 (模拟关闭客户端窗口 windowOpen=false) -> 连续 3 次未探测到窗口后自动退出 (reason='window_closed') 并清理 watch.pid
    const cfgPath = path.join(tmpState, 'modules.json');
    let pollStep = 0;
    const origDiscover = mockCdp.port;

    const watchPromise = runWatchDaemon({
      stateDir: tmpState,
      modulesConfigPath: cfgPath,
      port: origDiscover,
      liveHostScript: mockLiveHostScript,
      liveBridgeWaitMs: 1500,
      startupTimeoutMs: 2000,
      startupPollMs: 25,
      pollIntervalMs: 35,
      maxConsecutiveMisses: 3,
      silent: true,
      handleSignals: false
    });

    // 等待第 1 次注入完成
    const waitUntil = async (pred, timeoutMs = 4000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (pred()) return;
        await new Promise(r => setTimeout(r, 15));
      }
      throw new Error('Timeout waiting for watcher condition');
    };

    await waitUntil(() => mockCdp.state.injectCalls >= 1 && mockCdp.state.meterActive === true);
    assert.equal(fs.existsSync(getWatchPidPath(tmpState)), true, '运行期间 watch.pid 必须存在');
    assert.equal(fs.existsSync(path.join(tmpState, '.live-session.json')), true, 'topbar 模式下应自动启动 live-host');

    // 模拟页面刷新导致组件丢失 -> 守护进程自动重挂
    mockCdp.state.meterActive = false;
    await waitUntil(() => mockCdp.state.injectCalls >= 2 && mockCdp.state.meterActive === true);

    // 切换为 sidebar 模式 -> 守护进程调用 dispose() 并停止 live-host
    fs.writeFileSync(cfgPath, JSON.stringify({ displayMode: 'sidebar', modules: { meter: { enabled: true } } }));
    await waitUntil(() => (
      mockCdp.state.disposeCalls >= 1 &&
      mockCdp.state.meterActive === false &&
      !fs.existsSync(path.join(tmpState, '.live-session.json'))
    ));
    assert.equal(fs.existsSync(path.join(tmpState, '.live-session.json')), false, 'sidebar 模式下应停止 live-host');

    // 切换为 both 模式 -> 守护进程重新挂载顶栏
    fs.writeFileSync(cfgPath, JSON.stringify({ displayMode: 'both', modules: { meter: { enabled: true } } }));
    await waitUntil(() => mockCdp.state.injectCalls >= 3 && mockCdp.state.meterActive === true);

    // 模拟用户关闭 Antigravity 客户端窗口 -> 连续 3 次探测不到后自动退出并清理锁文件
    mockCdp.state.windowOpen = false;
    const result = await watchPromise;
    assert.equal(result.ok, true);
    assert.equal(result.reason, 'window_closed');
    assert.equal(result.windowEverSeen, true);
    assert.ok(result.injectedCount >= 3);
    assert.ok(result.disposedCount >= 1);
    assert.equal(fs.existsSync(getWatchPidPath(tmpState)), false, '退出后必须清理 watch.pid');
    assert.equal(fs.existsSync(path.join(tmpState, '.live-session.json')), false, '退出后必须清理 live-host');

    // 3. 验证 CLI 子进程契约：node cli.js watch 与 node cli.js stop-watch
    mockCdp.state.windowOpen = true;
    mockCdp.state.hasIpcBridge = true;
    mockCdp.state.meterActive = true;
    const childEnv = {
      ...process.env,
      AG_METER_TEST_MODE: '1',
      NODE_ENV: 'test',
      AG_METER_STATE_DIR: tmpState,
      AG_WATCH_POLL_MS: '80'
    };
    const watchChild = spawn(process.execPath, [path.join(__dirname, 'cli.js'), 'watch', '--port', String(mockCdp.port)], {
      env: childEnv,
      stdio: 'ignore'
    });

    await waitUntil(() => fs.existsSync(getWatchPidPath(tmpState)));
    const { stdout: stopOut } = await execFileAsync(
      process.execPath,
      [path.join(__dirname, 'cli.js'), 'stop-watch'],
      { env: childEnv, encoding: 'utf8' }
    );
    assert.match(stopOut, /已停止守护进程/);

    await new Promise(resolve => {
      if (watchChild.exitCode !== null) resolve();
      else watchChild.once('exit', () => resolve());
    });
    assert.equal(fs.existsSync(getWatchPidPath(tmpState)), false, 'stop-watch 后 watch.pid 必须已清理');
  } finally {
    await mockCdp.close();
    if (prevStateEnv !== undefined) process.env.AG_METER_STATE_DIR = prevStateEnv;
    else delete process.env.AG_METER_STATE_DIR;
    fs.rmSync(tmpState, { recursive: true, force: true });
  }
});

test('渲染层深浅色背景冲突兜底、沙盒 Preload 汉化防误触与默认 install 模块最小化注入', async () => {
  // 1. 验证 src/renderer/colors.js 在宿主背景亮度与所选深/浅色主题冲突时安全回退至 #181818 / #ffffff
  const fullColorsSrc = fs.readFileSync(path.join(__dirname, 'src', 'renderer', 'colors.js'), 'utf8');
  const colorsSrc = fullColorsSrc.slice(0, fullColorsSrc.indexOf('function applyTheme'));
  let mockBodyBg = 'rgb(255, 255, 255)';
  let mockWorkbenchBg = 'rgba(0, 0, 0, 0)';
  const sandbox = {
    currentThemeMode: 'auto',
    document: {
      querySelector: sel => (sel === '.monaco-workbench' ? { id: 'wb' } : null),
      body: { id: 'body', classList: { contains: () => false }, getAttribute: () => '' },
      documentElement: { id: 'html', style: {}, classList: { contains: () => false }, getAttribute: () => '' }
    },
    getComputedStyle: el => ({
      backgroundColor: el?.id === 'wb' ? mockWorkbenchBg : mockBodyBg,
      color: 'rgb(204, 204, 204)',
      getPropertyValue: () => ''
    })
  };
  sandbox.window = sandbox;
  vm.runInNewContext(colorsSrc, sandbox);
  // 深色主题但宿主节点返回浅色白底 + 透明背景 -> 必须回退到 #181818
  assert.equal(sandbox.getHostZeroLevelBg(false), '#181818');
  // 浅色主题但宿主节点返回深色黑底 -> 必须回退到 #ffffff
  mockBodyBg = 'rgb(24, 24, 24)';
  assert.equal(sandbox.getHostZeroLevelBg(true), '#ffffff');
  // 深色主题且宿主节点返回深色 #202124 -> 正常采纳宿主背景色
  mockBodyBg = 'rgb(32, 33, 36)';
  assert.equal(sandbox.getHostZeroLevelBg(false), '#202124');

  // 确认构建产物 meter-renderer.js 已同步更新且不再将 --ag-bg-panel-default 绑定到未经校验的宿主 --background
  const builtRenderer = fs.readFileSync(path.join(__dirname, 'meter-renderer.js'), 'utf8');
  assert.ok(builtRenderer.includes('--ag-bg-panel-default:var(--ag-host-bg,#181818);'), 'meter-renderer.js 必须使用经明度校验的 --ag-host-bg 与 #181818 兜底');
  assert.equal(builtRenderer.includes('var(--background,#181818)'), false, '严禁继承可能与固定主题冲突的宿主 --background');

  // 2. 验证沙盒 Preload 环境 (require("fs") 不可用) 下，汉化代码绝不意外启用
  const chinesePreloadCode = generateChinesePreloadCode(JSON.stringify({ Settings: '设置' }));
  const preloadSandbox = {
    window: {},
    document: { readyState: 'loading', addEventListener: () => {} },
    require: mod => { throw new Error(`Sandboxed preload forbids require('${mod}')`); },
    process: { platform: 'darwin', env: {} }
  };
  vm.runInNewContext(chinesePreloadCode, preloadSandbox);
  assert.equal(preloadSandbox.window.__antigravityChineseLoaded, undefined, '无 fs 权限的沙盒 Preload 严禁误开启汉化');

  // 3. 验证默认 install() 在 chinese/proxy 处于默认关闭状态时，绝不向 ASAR 注入 chinese 或 proxy 代码块
  const tmpInstallDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-default-install-'));
  const prevStateEnv = process.env.AG_METER_STATE_DIR;
  process.env.AG_METER_STATE_DIR = path.join(tmpInstallDir, 'state');
  try {
    const asar = loadAsarEngine();
    const appSrc = path.join(tmpInstallDir, 'src-app');
    fs.mkdirSync(path.join(appSrc, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(appSrc, 'package.json'), JSON.stringify({ name: 'antigravity', version: '2.31.2' }));
    fs.writeFileSync(
      path.join(appSrc, 'dist', 'utils.js'),
      '"use strict";\nfunction setupNodeWrapper(env) {\n}\nfunction createWindow(url, storageManager, options) {\n    void win.loadURL(url);\n}\n'
    );
    fs.writeFileSync(path.join(appSrc, 'dist', 'preload.js'), '// mock preload\nconst electron_1 = require("electron");\n');
    const targetAsar = path.join(tmpInstallDir, 'app.asar');
    await asar.createPackageWithOptions(appSrc, targetAsar, {});

    await install({ path: targetAsar });
    const utilsAfter = asar.extractFile(targetAsar, 'dist/utils.js').toString('utf8');
    const preloadAfter = asar.extractFile(targetAsar, 'dist/preload.js').toString('utf8');
    assert.ok(utilsAfter.includes(TAGS.METER_UTILS_START), '默认安装必须注入 ContextMeter 模块');
    assert.equal(utilsAfter.includes(TAGS.PROXY_START), false, '默认安装绝不注入未开启的 Proxy 模块');
    assert.equal(preloadAfter.includes(TAGS.CHINESE_START), false, '默认安装绝不注入未开启的 Chinese 模块');
  } finally {
    if (prevStateEnv !== undefined) process.env.AG_METER_STATE_DIR = prevStateEnv;
    else delete process.env.AG_METER_STATE_DIR;
    fs.rmSync(tmpInstallDir, { recursive: true, force: true });
  }
});
