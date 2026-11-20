'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');

const {
  connectCdpWebSocket,
  createCdpClient,
  discoverAntigravityCdp,
  getCandidateCdpPorts
} = require('./local-api');
const cli = require('./cli');

/**
 * 构建一个符合 RFC 6455 的轻量本地 CDP Mock Server。
 * 在 Upgrade 握手阶段严格断言不含 `Origin` 头（兼容 Chromium/Electron 默认安全策略）。
 */
function createMockCdpServer(handler) {
  let pageState = handler?.initialState || {
    hasMeter: false,
    version: null,
    origin: '',
    origins: [],
    pages: [],
    csrfToken: 'mock-cdp-csrf',
    evalCount: 0,
    hadOriginHeader: false
  };

  function encodeWsTextFrame(str) {
    const payload = Buffer.from(str, 'utf8');
    if (payload.length < 126) {
      return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
    }
    if (payload.length < 65536) {
      const hdr = Buffer.alloc(4);
      hdr[0] = 0x81;
      hdr[1] = 126;
      hdr.writeUInt16BE(payload.length, 2);
      return Buffer.concat([hdr, payload]);
    }
    const hdr = Buffer.alloc(10);
    hdr[0] = 0x81;
    hdr[1] = 127;
    hdr.writeBigUInt64BE(BigInt(payload.length), 2);
    return Buffer.concat([hdr, payload]);
  }

  const activeSockets = new Set();
  const server = http.createServer((req, res) => {
    if (req.url === '/json/list') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(pageState.pages));
      return;
    }
    if (req.url === '/') {
      res.setHeader('Content-Type', 'text/html');
      res.end(`<script>window.__APP_CONFIG__ = ${JSON.stringify({ csrfToken: pageState.csrfToken })};</script>`);
      return;
    }
    res.statusCode = 404;
    res.end('Not found');
  });

  server.on('connection', (socket) => {
    activeSockets.add(socket);
    socket.on('close', () => activeSockets.delete(socket));
  });

  server.on('upgrade', (req, socket) => {
    activeSockets.add(socket);
    socket.on('close', () => activeSockets.delete(socket));
    if (req.headers.origin !== undefined) {
      pageState.hadOriginHeader = true;
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\nRejected Origin header\r\n');
      socket.destroy();
      return;
    }
    const key = req.headers['sec-websocket-key'];
    const accept = crypto
      .createHash('sha1')
      .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );

    let rxBuf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      rxBuf = Buffer.concat([rxBuf, chunk]);
      while (rxBuf.length >= 2) {
        const b0 = rxBuf[0];
        const b1 = rxBuf[1];
        const opcode = b0 & 0x0f;
        const masked = (b1 & 0x80) !== 0;
        let payloadLen = b1 & 0x7f;
        let offset = 2;
        if (payloadLen === 126) {
          if (rxBuf.length < offset + 2) break;
          payloadLen = rxBuf.readUInt16BE(offset);
          offset += 2;
        } else if (payloadLen === 127) {
          if (rxBuf.length < offset + 8) break;
          payloadLen = Number(rxBuf.readBigUInt64BE(offset));
          offset += 8;
        }
        if (masked && rxBuf.length < offset + 4) break;
        const maskKey = masked ? rxBuf.subarray(offset, offset + 4) : null;
        if (masked) offset += 4;
        if (rxBuf.length < offset + payloadLen) break;
        const payload = Buffer.from(rxBuf.subarray(offset, offset + payloadLen));
        rxBuf = rxBuf.subarray(offset + payloadLen);

        if (opcode === 0x8) {
          socket.end();
          return;
        }
        if (opcode === 0x9) {
          socket.write(Buffer.from([0x8a, 0x00]));
          continue;
        }
        if (opcode === 0x1) {
          if (masked && maskKey) {
            for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4];
          }
          const msg = JSON.parse(payload.toString('utf8'));
          if (msg.method === 'Runtime.evaluate') {
            pageState.evalCount++;
            const expr = String(msg.params?.expression || '');
            let val = null;
            if (expr.includes('window.__APP_CONFIG__')) {
              val = { hasConfig: true, csrfToken: pageState.csrfToken };
            } else if (expr.includes('window.__AGContextMeterLive=')) {
              pageState.liveAssigned = true;
              val = true;
            } else if (expr.includes('window.__AGContextMeterCore=')) {
              val = true;
            } else if (expr.includes('METER_RENDERER_VERSION') || expr.includes('__AGContextMeter?.version')) {
              val = {
                active: Boolean(pageState.hasMeter),
                version: pageState.version,
                hasQuotaIpcBridge: false
              };
            } else if (handler?.onEvaluate) {
              val = handler.onEvaluate(expr, pageState);
            }
            socket.write(encodeWsTextFrame(JSON.stringify({ id: msg.id, result: { result: { value: val } } })));
          }
        }
      }
    });
  });

  const close = () => new Promise((resolve) => {
    for (const s of activeSockets) {
      try { s.destroy(); } catch {}
    }
    activeSockets.clear();
    try { server.closeAllConnections?.(); } catch {}
    server.close(() => resolve());
  });

  return { server, state: pageState, close };
}

test('RFC6455 CDP WebSocket 不发送 Origin 头并支持 AG_CDP_PORT 与候选端口发现', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-cdp-noorigin-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const mock = createMockCdpServer();
  await new Promise(r => mock.server.listen(0, '127.0.0.1', r));
  t.after(() => mock.close());
  const port = mock.server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  mock.state.pages = [
    { type: 'page', id: 'page-main', url: `${origin}/c/11111111-1111-4111-8111-111111111111`, webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/page-main` },
    { type: 'page', id: 'page-2', url: `http://127.0.0.1:${port + 1}/c/22222222-2222-4222-8222-222222222222`, webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/page-2` }
  ];

  // 1. 直接连接 WebSocket 并断言服务端未收到任何 Origin 头
  const ws = await connectCdpWebSocket(`ws://127.0.0.1:${port}/devtools/page/page-main`, { timeoutMs: 2500 });
  ws.close();
  assert.equal(mock.state.hadOriginHeader, false, 'CDP WebSocket 握手不得携带 Origin 请求头');

  // 2. 通过 createCdpClient evaluateValue 调用
  const client = await createCdpClient(`ws://127.0.0.1:${port}/devtools/page/page-main`, { timeoutMs: 2500 });
  const appCfg = await client.evaluateValue('(() => window.__APP_CONFIG__)()');
  client.close();
  assert.deepEqual(appCfg, { hasConfig: true, csrfToken: 'mock-cdp-csrf' });

  // 3. 验证显式 port 与 AG_CDP_PORT 发现及多窗口过滤
  const prevEnvPort = process.env.AG_CDP_PORT;
  process.env.AG_CDP_PORT = String(port);
  t.after(() => {
    if (prevEnvPort === undefined) delete process.env.AG_CDP_PORT;
    else process.env.AG_CDP_PORT = prevEnvPort;
  });
  const candidates = getCandidateCdpPorts({ appDataDir: path.join(tmpDir, 'AppSupport') });
  assert.equal(candidates[0], port);

  const discovered = await discoverAntigravityCdp({ appDataDir: path.join(tmpDir, 'AppSupport') });
  assert.equal(discovered.port, port);
  assert.equal(discovered.pages.length, 2);
});

test('watch 免改盘守护完整生命周期：等待窗口 -> 挂载注入 -> 刷新重注 -> 多窗口 -> 宿主关闭自动清理且 app.asar SHA256 零变动', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-watch-life-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const stateDir = path.join(tmpDir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });

  // 创建假的 app.asar，监控全周期前后校验哈希一字节不变（免改盘保证）
  const fakeAsarPath = path.join(tmpDir, 'app.asar');
  fs.writeFileSync(fakeAsarPath, 'mock-electron-app-asar-payload-keep-untouched');
  const asarShaBefore = crypto.createHash('sha256').update(fs.readFileSync(fakeAsarPath)).digest('hex');

  const pkgVer = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version;

  // 启动一个轻量级真实子进程模拟运行中的 live-host，验证宿主退出后被真实终止且无孤儿进程
  const { spawn } = require('child_process');
  const dummyChild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 15000)'], { stdio: 'ignore' });
  t.after(() => { try { dummyChild.kill('SIGKILL'); } catch {} });

  // 阶段机：cycle 1 未启动 -> cycle 2 就绪且含 2 个窗口 -> cycle 3 稳态不重注 -> cycle 4 页面刷新(active=false) -> cycle 5 窗口关闭消失
  let probeCall = 0;
  let injectedLog = [];
  let ensureBridgeCalls = 0;

  // 写入 live-session（含存活进程 pid），验证稳态复用且 window_closed 退出时会自动终止该后台进程
  fs.writeFileSync(path.join(stateDir, '.live-session.json'), JSON.stringify({
    pid: dummyChild.pid,
    port: 54321,
    token: 'tok-watch',
    version: pkgVer,
    origins: ['http://127.0.0.1:51001', 'https://127.0.0.1:51002']
  }));

  const res = await cli.runWatchDaemon({
    stateDir,
    silent: true,
    handleSignals: false,
    pollIntervalMs: 5,
    startupPollMs: 5,
    startupTimeoutMs: 500,
    maxConsecutiveMisses: 1,
    maxCycles: 10,
    _discoverWindow: async () => {
      probeCall++;
      if (probeCall === 1) {
        return { running: false, pageFound: false };
      }
      if (probeCall === 2) {
        return {
          running: true,
          pageFound: true,
          active: false,
          version: null,
          hasIpcBridge: false,
          origin: 'http://127.0.0.1:51001',
          origins: ['http://127.0.0.1:51001', 'https://127.0.0.1:51002'],
          liveBridgeAttached: null
        };
      }
      if (probeCall === 3) {
        // 模拟某次已注入后稳定期
        return {
          running: true,
          pageFound: true,
          active: true,
          version: pkgVer,
          hasIpcBridge: false,
          origin: 'http://127.0.0.1:51001',
          origins: ['http://127.0.0.1:51001', 'https://127.0.0.1:51002'],
          liveBridgeAttached: { backendSource: 'live-host', version: pkgVer }
        };
      }
      if (probeCall === 4) {
        // 模拟页面刷新：页面重新加载导致 window.__AGContextMeter 丢失 (active: false)
        return {
          running: true,
          pageFound: true,
          active: false,
          version: null,
          hasIpcBridge: false,
          origin: 'http://127.0.0.1:51001',
          origins: ['http://127.0.0.1:51001', 'https://127.0.0.1:51002'],
          liveBridgeAttached: null
        };
      }
      // 模拟宿主窗口关闭
      return { running: false, pageFound: false };
    },
    _ensureBridge: async (live) => {
      ensureBridgeCalls++;
      return {
        ready: true,
        reused: true,
        backendSource: 'live-host',
        backendVersion: pkgVer,
        liveInfo: {
          pid: dummyChild.pid,
          port: 54321,
          token: 'tok-watch',
          version: pkgVer,
          origins: live.origins
        }
      };
    },
    _hotInject: async (opts) => {
      injectedLog.push(opts);
      return { ok: true, injectedCount: 2, windowCount: 2, backendVersion: pkgVer, backendSource: 'live-host' };
    },
    _hotDispose: async () => true
  });

  assert.equal(res.ok, true);
  assert.equal(res.exitReason, 'window_closed');
  assert.equal(ensureBridgeCalls, 2, '初次就绪 + 刷新重载 各触发一次桥接确认与热注入');
  assert.equal(injectedLog.length, 2);
  assert.equal(res.injectedCount, 4);

  // 验证退出时已清理 watch.pid、watch-meta.json 与 .live-session.json（无残留）
  assert.equal(fs.existsSync(cli.getWatchPidPath(stateDir)), false);
  assert.equal(fs.existsSync(cli.getWatchMetaPath(stateDir)), false);
  assert.equal(fs.existsSync(path.join(stateDir, '.live-session.json')), false);

  // 验证免改盘模式 app.asar SHA256 零变动
  const asarShaAfter = crypto.createHash('sha256').update(fs.readFileSync(fakeAsarPath)).digest('hex');
  assert.equal(asarShaAfter, asarShaBefore, '免改盘 watch 守护全程绝不能改动 app.asar 字节');
});

test('stopWatchDaemon 清理锁文件并支持单实例接管信号中断', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-watch-stop-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const stateDir = path.join(tmpDir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });

  // 写入孤立过期 lockInfo，验证 shouldTakeOverWatchLock 准确接管并执行 stopWatchDaemon 清理
  fs.writeFileSync(cli.getWatchPidPath(stateDir), JSON.stringify({ format: 'json', pid: 999998, version: '0.8.7', buildId: 'old', script: __filename }));
  fs.writeFileSync(cli.getWatchMetaPath(stateDir), JSON.stringify({ pid: 999998, buildId: 'old' }));
  const lockInfo = cli.readWatchLockInfo(stateDir);
  assert.equal(cli.shouldTakeOverWatchLock(lockInfo, { stateDir, expectedVersion: '0.8.8', expectedBuildId: 'new' }), true);

  const ac = new AbortController();
  setTimeout(() => ac.abort(), 30);
  const res = await cli.runWatchDaemon({
    stateDir,
    silent: true,
    handleSignals: false,
    signal: ac.signal,
    pollIntervalMs: 5,
    startupPollMs: 5,
    startupTimeoutMs: 5000,
    _discoverWindow: async () => ({ running: false, pageFound: false })
  });
  assert.equal(res.ok, true);
  assert.equal(res.exitReason, 'stopped');
  assert.equal(fs.existsSync(cli.getWatchPidPath(stateDir)), false);

  const stopRes = await cli.stopWatchDaemon({ stateDir });
  assert.equal(stopRes.ok, true);
  assert.equal(stopRes.watchPid, null);
});

test('Issue #42: v2.33 免 CDP 时通过 daemon hub 发现运行中 origin、不自动杀进程且仅提示手动带端口重启', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-issue42-nocdp-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const daemonDir = path.join(tmpDir, 'daemon');
  const appSupportDir = path.join(tmpDir, 'AppSupport');
  const stateDir = path.join(tmpDir, 'state');
  fs.mkdirSync(daemonDir, { recursive: true });
  fs.mkdirSync(path.join(appSupportDir, 'Antigravity'), { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });

  // 1. 模拟 v2.33.0 macOS 正常启动：无 DevToolsActivePort，但 ~/.gemini/antigravity/daemon/hub_*.json 存在存活语言服务
  fs.writeFileSync(path.join(daemonDir, 'hub_1.json'), JSON.stringify({
    pid: process.pid,
    httpsPort: 54399,
    csrfToken: 'mock-daemon-csrf'
  }), 'utf8');

  const liveSnap = await cli.queryLiveWindow({
    appDataDir: appSupportDir,
    daemonDir,
    stateDir,
    includeCandidatePorts: false
  });
  assert.equal(liveSnap.running, true);
  assert.equal(liveSnap.cdpEnabled, false);
  assert.equal(liveSnap.pageFound, false);
  assert.equal(liveSnap.discoverySource, 'daemon_hub');
  assert.deepEqual(liveSnap.origins, ['https://127.0.0.1:54399']);

  // 2. runLiveCommand 在 running && cdpEnabled===false 时不自动结束进程，只抛出含手动重启命令的提示
  await assert.rejects(
    cli.runLiveCommand({
      platform: 'darwin',
      _hostTarget: { platform: 'darwin', appBundlePath: '/Applications/Antigravity.app', execPath: '/Applications/Antigravity.app/Contents/MacOS/Antigravity' },
      _queryLiveWindow: async () => liveSnap
    }),
    (err) => {
      assert.equal(err.code, 'CDP_NOT_ENABLED');
      assert.match(err.message, /不会自动结束您的客户端进程/);
      assert.match(err.message, /open -a Antigravity --args --remote-debugging-port=58321/);
      return true;
    }
  );

  // 3. watch 在前两轮看到 running && !cdpEnabled 时仅提示手动操作，用户手动带端口重启后第三轮顺利接入注入
  let cycle = 0;
  let injected = 0;
  const watchRes = await cli.runWatchDaemon({
    stateDir,
    silent: true,
    handleSignals: false,
    pollIntervalMs: 5,
    startupPollMs: 5,
    startupTimeoutMs: 500,
    maxConsecutiveMisses: 1,
    maxCycles: 5,
    _discoverWindow: async () => {
      cycle++;
      if (cycle <= 2) return liveSnap;
      if (cycle === 3) {
        return {
          running: true,
          cdpEnabled: true,
          pageFound: true,
          active: false,
          origin: 'https://127.0.0.1:54399',
          origins: ['https://127.0.0.1:54399'],
          hasIpcBridge: false
        };
      }
      return { running: false, pageFound: false };
    },
    _ensureBridge: async () => ({ ready: true, reused: true, backendSource: 'live-host', backendVersion: '0.8.8', liveInfo: { pid: process.pid, port: 54321, token: 't', origins: ['https://127.0.0.1:54399'] } }),
    _hotInject: async () => { injected++; return { ok: true, injectedCount: 1, windowCount: 1 }; },
    _hotDispose: async () => true
  });
  assert.equal(watchRes.ok, true);
  assert.equal(watchRes.cdpPromptCount, 1, '连续无 CDP 轮询期间仅提示一次手动重启');
  assert.equal(injected, 1, '用户手动带端口重启后 watch 自动恢复热挂载');
  assert.equal(watchRes.exitReason, 'window_closed');
});

test('discoverAntigravityCdp 与 connect 自动过滤内置浏览器打开的第三方本地预览页', async (t) => {
  const { connect } = require('./local-api');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-cdp-filter-preview-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const previewSrv = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end('<html><head><title>Preview App</title></head><body><div>Local Dev Page</div></body></html>');
  });
  await new Promise(r => previewSrv.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => previewSrv.close(r)));
  const previewOrigin = `http://127.0.0.1:${previewSrv.address().port}`;

  const mock = createMockCdpServer();
  await new Promise(r => mock.server.listen(0, '127.0.0.1', r));
  t.after(() => mock.close());
  const port = mock.server.address().port;
  const agOrigin = `http://127.0.0.1:${port}`;

  mock.state.pages = [
    { type: 'page', id: 'preview-page', title: 'Preview App', url: `${previewOrigin}/`, webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/preview-page` },
    { type: 'page', id: 'ag-main', title: 'Antigravity', url: `${agOrigin}/c/33333333-3333-4333-8333-333333333333`, webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/ag-main` }
  ];

  const appDataDir = path.join(tmpDir, 'AppSupport');
  const discovered = await discoverAntigravityCdp({ port, strictPort: true, appDataDir });
  assert.equal(discovered.pages.length, 1);
  assert.equal(discovered.page.id, 'ag-main');

  const api = await connect({ port, strictPort: true, appDataDir });
  assert.equal(api.origin, agOrigin);
  assert.deepEqual(api.origins, [agOrigin]);
});
